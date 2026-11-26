import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { HISTORY_TIMEOUT_MS } from '../constants.js'
import { serviceOf } from '../services.js'
import { headOf } from '../text.js'
import { threadOfPart } from '../threads.js'
import { redactText } from '../../shared/extras/redact.js'

const MODES = new Set(['continuable', 'one-shot', 'external', 'unknown'])
const MAX_DEPTH = 8
const MAX_PAGE = 32
const MAX_SCANNED = 4096
const MAX_TASK_EVENTS = 100_000
const MAX_SOURCE_TEXT = 64 * 1024
const MAX_RUNS = 512
const MAX_IN_FLIGHT = 4
const SOURCE = 'subagent-settled'
const failure = (code, message) => Object.assign(new Error(message), { code })
const refused = () => failure('bot/refused', 'The session is outside the selected delegation scope')
const unavailable = () => failure('bot/unavailable', 'The server cannot read this delegation record')
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\p{Cc}]/u.test(value)
const ordinal = value => Number.isSafeInteger(value) && value >= 0
const fields = (value, allowed) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key))
const hasPart = (parts, id) => parts?.some(part => part.sessionId === id) === true
const runKey = (parent, child) => JSON.stringify([parent, child])

function requestOf(body, detail) {
  const { scope, rootSessionId, childPath = [], limit = 20 } = body
  if (!fields(body, ['scope', 'rootSessionId', 'childPath', 'limit', detail ? 'cursor' : 'afterChildId'])
    || !validId(rootSessionId) || !Array.isArray(childPath) || childPath.length > MAX_DEPTH || (detail ? childPath.length === 0 : childPath.length === MAX_DEPTH)
    || ![...childPath].every(validId) || new Set([rootSessionId, ...childPath]).size !== childPath.length + 1
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw failure('bot/invalid', 'Choose a valid delegation scope and page')
  const { cursor, afterChildId } = body
  if (cursor !== undefined && (!fields(cursor, ['childId', 'throughSeq', 'beforeSeq']) || cursor.childId !== childPath.at(-1)
    || !ordinal(cursor.throughSeq) || !ordinal(cursor.beforeSeq) || cursor.beforeSeq > cursor.throughSeq)) {
    throw failure('bot/invalid', 'Invalid delegation history cursor')
  }
  if (afterChildId !== undefined && !validId(afterChildId)) throw failure('bot/invalid', 'Invalid delegation list cursor')
  const allowed = scope?.kind === 'bot' ? ['botId'] : scope?.kind === 'task' ? ['botId', 'taskId']
    : scope?.kind === 'room' ? ['roomId'] : scope?.kind === 'agent' ? ['agentId'] : []
  if (allowed.length === 0 || !fields(scope, ['kind', ...allowed]) || !allowed.every(key => validId(scope[key]))) {
    throw failure('bot/invalid', 'Choose a Bot, group, background task or team Agent')
  }
  return { scope, rootSessionId, childPath, limit, cursor, afterChildId }
}

function rootScope(rt, { scope, rootSessionId: id }, deviceKind) {
  if (scope.kind === 'agent') {
    if (!['local', 'phone'].includes(deviceKind)) throw failure('bot/refused', 'Team Agent history is only available from the phone app or the computer')
    const agent = rt.agentById?.(scope.agentId)
    if (agent?.id !== scope.agentId || agent.sessions?.includes(id) !== true) throw refused()
    return { minSeq: 0 }
  }
  if (scope.kind === 'room') {
    const room = rt.roomOf(scope.roomId)
    if (room?.id !== scope.roomId) throw refused()
    if (rt.sessionOfRoom(room) === id || hasPart(room.parts, id)) return { minSeq: 0 }
    const owner = rt.groupOwners.get(id) ?? rt.pastOwners.get(id)
    if (owner?.roomId !== room.id || !room.members?.includes(owner.botId) || rt.botOf(owner.botId) === undefined
      || !(room.sessions?.[owner.botId] === id || hasPart(room.segments?.[owner.botId], id))) throw refused()
    return { minSeq: 0, member: owner.botId }
  }
  const bot = rt.botOf(scope.botId)
  if (bot?.id !== scope.botId || rt.selfOf(id) !== bot.id) throw refused()
  const thread = threadOfPart(bot, id)
  if (scope.kind === 'bot') {
    if (thread?.thread !== 'current' || rt.groupOwners.has(id) || rt.taskOwners.has(id) || rt.pastOwners.get(id)?.roomId !== undefined) throw refused()
    return { minSeq: 0 }
  }
  if (thread?.thread !== 'task' || thread.taskId !== scope.taskId) throw refused()
  const task = bot.tasks[thread.index]
  if (task.roomId !== undefined && !rt.roomOf(task.roomId)?.members?.includes(bot.id)) throw refused()
  const first = task.segments?.[0]?.sessionId ?? task.sessionId
  if (id !== first) return { minSeq: 0, roomId: task.roomId }
  if (!ordinal(task.startSeq)) throw failure('bot/unavailable', 'This background task has no stored history boundary')
  return { minSeq: task.startSeq, roomId: task.roomId }
}

function isTeamRoot(rt, id) {
  return rt.selfOf(id) !== undefined || rt.roomOwners.has(id) || rt.pastOwners.has(id) || rt.agentOf?.(id) !== undefined
}

function isChild(header, parent, row) {
  return header?.id === row.id && header.origin === 'subagent' && header.parentSession === parent && header.createdAt === row.createdAt
}

function statusOf(reason) {
  switch (reason) {
    case 'completed': return 'completed'
    case 'error': return 'failed'
    case 'aborted': return 'canceled'
    case 'interrupted': return 'interrupted'
    case 'max-tokens': return 'limited'
    case 'refusal': case 'blocked': return 'refused'
    default: return 'unknown'
  }
}

function noticeStatus(source) {
  // DSH 的持久通知只有带来源的摘要，没有结构化 stopReason。未识别的措辞不能判为失败或成功。
  const prefix = `Background subagent ${source.senderSessionId} `
  if (typeof source.summary !== 'string' || !source.summary.startsWith(prefix)) return 'unknown'
  const summary = source.summary.slice(prefix.length)
  if (summary === 'finished. It cannot receive follow-up messages.' || summary === 'finished and will do no further work unless you send it more.') return 'completed'
  if (summary === 'was stopped before it finished.') return 'canceled'
  if (summary === 'ran out of room before it finished.') return 'limited'
  if (summary === 'declined the task.') return 'refused'
  if (summary === 'failed before it finished.') return 'failed'
  return 'unknown'
}

function projectCatalog(view, minSeq) {
  const catalog = view.projections?.values?.subagentCatalog
  if (view.projections?.asOfSeq !== view.cursor || !Array.isArray(catalog)) throw unavailable()
  const from = Math.max(view.inheritedEventCount, minSeq)
  const events = view.events
  if (events.length !== view.cursor + 1 || minSeq > events.length) throw unavailable()
  let scopeIds
  if (from > view.inheritedEventCount) {
    if (events.length - view.inheritedEventCount > MAX_TASK_EVENTS) throw unavailable()
    // 同一子编号后续可能升级目录模式；不能用升级事件把任务开始前的子级移进任务。
    const seen = new Set()
    scopeIds = new Set()
    for (let at = view.inheritedEventCount; at < events.length; at += 1) {
      const event = events[at]
      if (event?.type !== 'subagent/catalog' || !validId(event.data?.childId) || seen.has(event.data.childId)) continue
      seen.add(event.data.childId)
      if (at >= from) scopeIds.add(event.data.childId)
    }
  }
  const rows = new Map()
  for (const row of catalog) {
    if (!validId(row?.id) || row.id === view.header.id || rows.has(row.id) || !MODES.has(row.mode) || !ordinal(row.createdAt)
      || row.label !== undefined && typeof row.label !== 'string') throw unavailable()
    rows.set(row.id, row)
  }
  if (scopeIds !== undefined) for (const id of rows.keys()) if (!scopeIds.has(id)) rows.delete(id)
  return { rows, events, from }
}

function settlements({ rows, events, from }) {
  const found = new Map()
  for (let at = events.length - 1, floor = Math.max(from, events.length - MAX_SCANNED); at >= floor; at -= 1) {
    const event = events[at]
    const source = event?.type === 'user/message' ? event.data?.source : undefined
    if (source?.kind !== SOURCE || source.form !== 'notice' || !rows.has(source.senderSessionId) || found.has(source.senderSessionId)) continue
    found.set(source.senderSessionId, { seq: event.seq, status: noticeStatus(source), content: event.data.content })
  }
  return found
}

function limitedText(text, limit, mask) {
  if (text.length > MAX_SOURCE_TEXT) return { text: null, truncated: true }
  const value = mask(text)
  return { text: headOf(value, limit), truncated: value.length > limit }
}

function textBlocks(blocks, limit, mask) {
  if (!Array.isArray(blocks)) return null
  if (blocks.length > 256) return { text: null, truncated: true }
  const parts = []
  let size = 0
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text === '') continue
    size += parts.length === 0 ? block.text.length : block.text.length + 1
    if (size > MAX_SOURCE_TEXT) return { text: null, truncated: true }
    parts.push(block.text)
  }
  return parts.length === 0 ? null : limitedText(parts.join('\n'), limit, mask)
}

function processEvent(event, mask) {
  const { type, data, seq, time } = event
  const row = { seq, time, type, ...(ordinal(data?.turn) ? { turn: data.turn } : {}) }
  if (type === 'turn/start') return row
  if (type === 'turn/end') return { ...row, status: statusOf(data?.reason?.kind) }
  if (type === 'assistant/message') {
    const body = textBlocks(data?.message?.content, 1024, mask)
    if (body !== null) return { ...row, ...body }
  }
  if (type === 'tool/call' || type === 'tool/ptc-dispatch-start') {
    const callId = type === 'tool/call' ? data?.callId : data?.subCallId
    if (validId(callId) && typeof data?.name === 'string') return { ...row, callId, name: limitedText(data.name, 120, mask).text }
  }
  if (type === 'tool/result' || type === 'tool/ptc-dispatch') {
    const message = type === 'tool/result' ? data?.message : typeof data?.isError === 'boolean' ? data : data?.result ?? data?.message
    const callId = type === 'tool/result' ? message?.toolCallId ?? data?.callId : data?.subCallId
    if (validId(callId)) return { ...row, callId,
      status: message?.isError === true || message?.ok === false ? 'failed'
        : message?.isError === false || message?.ok === true ? 'completed' : 'unknown' }
  }
  return undefined
}

function lastTurn(events, through, from, mask) {
  const floor = Math.max(from, through - MAX_SCANNED + 1)
  let found
  for (let at = through; at >= floor; at -= 1) {
    const event = events[at]
    const data = event?.data
    if (event?.type === 'turn/start') {
      if (found === undefined) return { turn: data.turn, seq: event.seq, status: 'open', result: null }
      break
    }
    if (event?.type === 'turn/end' && found === undefined) {
      found = { turn: data.turn, seq: event.seq, status: statusOf(data.reason?.kind), result: null }
    }
    if (found !== undefined && event?.type === 'assistant/message' && data.turn === found.turn) {
      const text = textBlocks(data.message?.content, 8192, mask)
      if (text !== null) return { ...found, result: { seq: event.seq, ...text } }
    }
  }
  return found ?? null
}

function processPage(view, { cursor, limit }, mask) {
  const from = view.inheritedEventCount
  const throughSeq = cursor?.throughSeq ?? view.cursor
  const before = cursor?.beforeSeq ?? throughSeq + 1
  if (throughSeq > view.cursor || cursor !== undefined && (throughSeq < from || before <= from)) {
    throw failure('bot/stale', 'The delegation history cursor is no longer available')
  }
  const events = view.events
  if (events.length !== view.cursor + 1) throw unavailable()
  const page = []
  let at = before - 1
  const floor = Math.max(from, before - MAX_SCANNED)
  for (; at >= floor && page.length < limit; at -= 1) {
    const row = processEvent(events[at], mask)
    if (row !== undefined) page.push(row)
  }
  return { throughSeq, events: page.reverse(), lastTurn: lastTurn(events, throughSeq, from, mask),
    cursor: at >= from ? { childId: view.header.id, throughSeq, beforeSeq: at + 1 } : null }
}

export function install(rt) {
  const stop = new AbortController()
  const runs = new Map()
  let reading = 0
  const query = () => serviceOf(rt.ctx, 'sessionQuery')
  rt.extraDelegationsAvailable = () => !stop.signal.aborted && typeof query()?.observeSession === 'function'
    && typeof serviceOf(rt.ctx, 'subagents')?.listChildren === 'function'
  const observeLifecycle = (start) => function (info) {
    const parent = carrierKeyOf(this)?.session?.id
    if (stop.signal.aborted || !validId(parent) || !validId(info?.id) || !validId(info?.runId) || typeof info.local !== 'boolean') return
    const key = runKey(parent, info.id)
    const previous = runs.get(key)
    if (start && previous?.runId === info.runId || !start && previous !== undefined && previous.runId !== info.runId) return
    const startEpoch = start ? 'running' : statusOf(info.stopReason)
    let output = null
    if (!start && typeof rt.redactSecrets === 'function' && rt.secretStoreStatus?.()?.locked === false) {
      try { output = textBlocks(info.lastAssistantMessage, 8192, mask) } catch { /* 观察失败不影响委派，也不保留未遮盖的正文。 */ }
    }
    runs.delete(key)
    runs.set(key, { runId: info.runId, local: info.local, status: startEpoch, output })
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value)
  }
  rt.ctx.on('subagent/start', observeLifecycle(true))
  rt.ctx.on('subagent/end', observeLifecycle(false))
  rt.ctx.effect(() => () => { stop.abort(); runs.clear() }, 'ds-bot: 增补委派读取')

  const mask = text => redactText(text, rt.redactSecrets)
  const assertRedaction = () => {
    if (typeof rt.redactSecrets !== 'function' || rt.secretStoreStatus?.()?.locked !== false) {
      throw failure('bot/unavailable', 'Unlock the secrets store before reading delegation records')
    }
  }
  const childView = (row, parent, notice) => {
    const run = runs.get(runKey(parent, row.id))
    const agent = serviceOf(rt.ctx, 'agents')?.get?.(row.id)
    const local = row.mode !== 'external'
    const active = local && isChild(agent?.session?.header, parent, row) && agent.status === 'running'
    const lifecycle = run?.local === local ? run : undefined
    const durable = !active && lifecycle === undefined && !['continuable', 'unknown'].includes(row.mode) ? notice?.status : undefined
    const status = active ? 'running' : lifecycle?.status ?? durable ?? 'unknown'
    return { childId: row.id, mode: row.mode, createdAt: row.createdAt,
      label: row.label === undefined ? null : limitedText(row.label, 256, mask).text,
      status, statusSource: active ? 'live-agent' : lifecycle !== undefined ? 'lifecycle' : durable !== undefined ? 'settlement' : null,
      runId: lifecycle?.runId ?? null, lastSettlement: notice === undefined ? null : { seq: notice.seq, status: notice.status } }
  }

  rt.extraDelegationRead = async (detail, body, signal, access) => {
    if (!rt.extraDelegationsAvailable()) throw unavailable()
    const target = requestOf(body, detail)
    const initial = rootScope(rt, target, access.deviceKind())
    const timeout = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
    const fused = AbortSignal.any([stop.signal, timeout, ...(signal === undefined ? [] : [signal])])
    const check = () => {
      access.check()
      if (fused.aborted || !rt.extraDelegationsAvailable()) throw unavailable()
      const now = rootScope(rt, target, access.deviceKind())
      if (now.minSeq !== initial.minSeq || now.member !== initial.member || now.roomId !== initial.roomId) throw refused()
      if (target.childPath.some(id => isTeamRoot(rt, id))) throw refused()
    }
    const observe = async (id, projections, member, project) => {
      check()
      let view
      try {
        view = await query().observeSession(id, { signal: fused, projectionMode: projections ? 'all' : 'none' })
      } catch (error) {
        check()
        if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') throw failure('bot/not-found', 'The delegation session no longer exists')
        throw unavailable()
      }
      if (typeof view?.[Symbol.dispose] !== 'function') throw unavailable()
      try {
        check()
        if (view.header?.id !== id || !Number.isSafeInteger(view.cursor) || view.cursor < -1
          || !ordinal(view.inheritedEventCount) || view.inheritedEventCount > view.cursor + 1 || !Array.isArray(view.events)) throw unavailable()
        if (member !== undefined && !isChild(view.header, member.parent, member.row)) throw refused()
        assertRedaction()
        return project(view)
      } finally { view[Symbol.dispose]() }
    }
    check()
    if (reading >= MAX_IN_FLIGHT) throw failure('bot/busy', 'The server is already reading delegation history; try again')
    reading += 1
    try {
      try { await rt.loadSecrets() } catch { check(); throw unavailable() }
      check()
      assertRedaction()
      let parent = target.rootSessionId
      let member
      const count = detail ? target.childPath.length - 1 : target.childPath.length
      for (let depth = 0; depth <= count; depth += 1) {
        const minSeq = depth === 0 ? initial.minSeq : 0
        const childId = target.childPath[depth]
        const descend = depth < count
        const value = await observe(parent, true, member, view => {
          const catalog = projectCatalog(view, minSeq)
          if (!descend && !detail) {
            const rows = [...catalog.rows.values()].filter(row => !isTeamRoot(rt, row.id))
            const offset = target.afterChildId === undefined ? 0 : rows.findIndex(row => row.id === target.afterChildId) + 1
            if (target.afterChildId !== undefined && offset === 0) throw failure('bot/stale', 'The delegation list cursor is no longer available')
            const notices = settlements(catalog)
            const page = rows.slice(offset, offset + target.limit)
            return { schema: 1, rootSessionId: target.rootSessionId, parentSessionId: parent,
              items: page.map(row => childView(row, parent, notices.get(row.id))),
              nextAfterChildId: offset + page.length < rows.length ? page.at(-1).id : null, depthLimit: MAX_DEPTH }
          }
          const row = catalog.rows.get(childId)
          if (row === undefined) throw failure('bot/not-found', 'The child is not in this parent delegation catalog')
          if (descend) return { parent, row }
          const notice = settlements(catalog).get(childId)
          return { parent, row, notice }
        })
        check()
        assertRedaction()
        if (!descend && !detail) return value
        if (detail && !descend) {
          let history
          if (value.row.mode === 'external') {
            if (target.cursor !== undefined) throw failure('bot/invalid', 'External delegations have no child history cursor')
            history = { history: 'external', throughSeq: null, events: [], cursor: null, lastTurn: null }
          } else {
            history = await observe(childId, false, value, view => ({ history: 'session', ...processPage(view, target, mask) }))
          }
          check()
          assertRedaction()
          const child = childView(value.row, parent, value.notice)
          const run = runs.get(runKey(parent, childId))
          const noticeText = textBlocks(value.notice?.content, 8192, mask)
          // 缓存已做字段脱敏，只补查新密钥；通用扫描不能把可信遮盖标记再当成原始输入。
          const output = run?.output?.text == null ? run?.output : limitedText(run.output.text, 8192, rt.redactSecrets)
          const result = child.statusSource === 'lifecycle' && output != null
            ? { source: 'lifecycle', runId: run.runId, ...output, truncated: run.output.truncated || output.truncated }
            : noticeText === null ? null : { source: 'settlement', seq: value.notice.seq, ...noticeText }
          return { schema: 1, rootSessionId: target.rootSessionId, parentSessionId: parent, child, result, ...history }
        }
        if (value.row.mode === 'external') throw failure('bot/unavailable', 'External delegations have no child session catalog')
        member = value
        parent = childId
      }
    } finally { reading -= 1 }
  }
}
