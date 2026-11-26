import { isRelayContext, stripToolCallTags, toolName } from '../text.js'
import { stepActivity, turnReasoning } from '../turn-reasoning.js'
import { thinkingShown } from '../themes.js'

export const NATIVE_TOOL_EVENTS = new Set(['message_bot', 'stop_bot', 'create_bot', 'update_bot', 'group_relay', 'create_group', 'update_group', 'delete_group', 'post_to_group', 'ask_user', 'request_secret', 'request_connector', 'mail_send', 'ask_user_question', 'show_view', 'browser_handoff', 'read_group_chat', 'bot_remember', 'bot_forget', 'remember', 'forget'])
const special = root => NATIVE_TOOL_EVENTS.has(toolName(root)) || toolName(root) === 'cua' || toolName(root)?.startsWith('cua_driver_native__')
  || (root.subCalls ?? []).some(special)
const empty = Object.freeze([])
const owner = node => node.location?.turn?.turn

export function nativeToolGroups(nodes, prefs) {
  const groups = new Map(); const steps = new Map()
  for (const node of nodes) if (node.kind === 'assistant-step') {
    const turn = owner(node)
    const members = steps.get(turn) ?? []
    members.push(node.data); steps.set(turn, members)
  }
  let pending = []; let turn
  const flush = () => {
    if (pending.length) {
      groups.set(pending[0].key, pending)
      for (const node of pending.slice(1)) groups.set(node.key, empty)
    }
    pending = []
  }
  for (const node of nodes) {
    if (owner(node) !== turn) { flush(); turn = owner(node) }
    if (node.visibility === 'hidden') continue
    if (node.kind === 'tool-call' && node.data?.root) {
      // 有独立消息或审批卡片的调用留在原位置，不跨卡片搬动摘要。
      if (special(node.data.root) || !Number.isInteger(turn)) { flush(); groups.set(node.key, [node]); continue }
      pending.push(node); continue
    }
    if (node.kind === 'assistant-step') {
      const data = node.data
      const shown = data.blocks?.some(block => block.kind === 'text' && stripToolCallTags(block.text).trim() || block.kind === 'image')
        || stepActivity(data).length > 0 || thinkingShown(prefs) && turnReasoning(steps.get(turn) ?? [], data) !== ''
      if (shown) flush()
      continue
    }
    if (node.kind === 'compaction' || node.kind === 'context' && !isRelayContext(node.data)) continue
    flush()
  }
  flush()
  return groups
}

// 使用公开 ChatSnapshot 与逐节点 source；仅监听父快照会漏掉工具结果更新。
export function createNativeToolSource(chat, roster) {
  let snapshot = new Map(); let connected = false; let offChat; let offRoster
  const listeners = new Set(); const watched = new Map()
  const refresh = () => {
    const state = chat.getSnapshot()
    const nodes = state?.nodes?.values?.() ?? []
    const ordered = [...nodes].sort((a, b) => a.anchorSeq - b.anchorSeq)
    const next = nativeToolGroups(ordered, roster.getSnapshot().prefs)
    // 向前补页时沿用仍在窗口里的摘要位置，保持用户已经展开的组件。
    for (const [head, group] of [...next]) {
      if (!group.length) continue
      const previousHead = group.find(node => snapshot.get(node.key)?.some(member => group.some(current => current.key === member.key)))?.key
      if (previousHead && previousHead !== head) { next.set(head, empty); next.set(previousHead, group) }
    }
    let changed = next.size !== snapshot.size
    for (const [key, group] of next) {
      const previous = snapshot.get(key)
      if (previous && group.length === previous.length && group.every((node, index) => node === previous[index])) next.set(key, previous)
      else changed = true
    }
    if (connected) {
      const present = new Set(nodes.map(node => node.key))
      for (const [key, off] of watched) if (!present.has(key)) { off(); watched.delete(key) }
      for (const node of nodes) if (!watched.has(node.key)) watched.set(node.key, state.nodes.source(node.key).subscribe(refresh))
    }
    if (changed) { snapshot = next; for (const listener of listeners) listener() }
  }
  return {
    getSnapshot: () => { if (!connected) refresh(); return snapshot },
    subscribe(listener) {
      listeners.add(listener)
      if (!connected) { connected = true; offChat = chat.subscribe(refresh); offRoster = roster.subscribe(refresh); refresh() }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          connected = false; offChat?.(); offRoster?.()
          for (const off of watched.values()) off()
          watched.clear(); snapshot = new Map()
        }
      }
    },
  }
}
