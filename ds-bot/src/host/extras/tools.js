import { createHash } from 'node:crypto'
import { displayText, redactText } from '../../shared/extras/redact.js'
import { toolPresentation } from '../../shared/extras/tool-display.js'
import { hiddenTurn, logPage, ownedSession, SCAN_PAGES, turnAt } from './log-page.js'

const SKIP = new Set(['ask_user', 'request_secret', 'group_relay'])
const CHUNK_SIZE = 32 * 1024
const failure = (code, message) => Object.assign(new Error(message), { code })
const callOf = event => {
  if (event.type === 'tool/call') return { callId: event.data?.callId, name: event.data?.name, args: event.data?.arguments }
  if (event.type === 'tool/ptc-dispatch-start') return { callId: event.data?.subCallId, name: event.data?.name, args: event.data?.arguments, parentCallId: event.data?.parentCallId ?? event.data?.callId }
  return undefined
}
const resultOf = event => {
  if (event.type === 'tool/result') return { callId: event.data?.message?.toolCallId ?? event.data?.callId, message: event.data?.message, meta: event.data?.meta, seq: event.seq }
  if (event.type === 'tool/ptc-dispatch') return { callId: event.data?.subCallId,
    message: typeof event.data?.isError === 'boolean' ? event.data : event.data?.result ?? event.data?.message,
    meta: event.data?.meta, seq: event.seq }
  return undefined
}
const statusOf = message => typeof message?.isError === 'boolean' ? message.isError ? 'failed' : 'success'
  : typeof message?.ok === 'boolean' ? message.ok ? 'success' : 'failed' : 'unconfirmed'

export function toolsFromEvents(events, sessionId, { seedTurn, hidden = [], labelFor = () => null } = {}) {
  let turn = seedTurn
  const calls = []
  const results = new Map()
  const active = new Map()
  const seen = new Set()
  for (const event of events) {
    if (Number.isSafeInteger(event.seq)) {
      if (seen.has(event.seq)) continue
      seen.add(event.seq)
    }
    if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) turn = event.data.turn
    const result = resultOf(event)
    const matched = result?.callId === undefined ? undefined : active.get(result.callId)
    if (matched !== undefined) results.set(matched, result.message)
    const call = callOf(event)
    if (call === undefined) continue
    // 任何新调用都是结果关联边界，包括被隐藏或不展示的调用。
    if (typeof call.callId === 'string') active.delete(call.callId)
    if (typeof call.name !== 'string' || SKIP.has(call.name)) continue
    const callTurn = Number.isInteger(event.data?.turn) ? event.data.turn : turn
    if (hidden.includes(callTurn) || hidden.length > 0 && callTurn === undefined) continue
    if (typeof call.callId === 'string') active.set(call.callId, calls.length)
    const { description, filePath } = toolPresentation(call.name, call.args)
    calls.push({ sessionId, callId: typeof call.callId === 'string' ? call.callId : null,
      callSeq: Number.isSafeInteger(event.seq) ? event.seq : null, name: call.name, label: labelFor(call.name) ?? null,
      ...(description ? { description } : {}), ...(filePath ? { filePath } : {}),
      ...(Number.isInteger(callTurn) ? { turn: callTurn } : {}), ...(typeof call.parentCallId === 'string' ? { parentCallId: call.parentCallId } : {}) })
  }
  return calls.map((call, index) => {
    const message = results.get(index)
    const status = statusOf(message)
    return { ...call, ...(status === 'unconfirmed' ? {} : { ok: status === 'success' }), status }
  })
}

export async function findCall(rt, scope, body, signal) {
  if (typeof body.callId !== 'string' || body.callId === '' || body.callId.length > 200) throw failure('bot/invalid', 'Choose a tool call')
  if (body.callSeq !== undefined && body.callSeq !== null && (!Number.isSafeInteger(body.callSeq) || body.callSeq < scope.minSeq)) throw failure('bot/refused', 'This call is outside the session history boundary')
  let before
  let found
  let result
  let resultMeta, resultSeq
  for (let pages = 0; pages < SCAN_PAGES; pages += 1) {
    const page = await logPage(rt, scope, before, signal)
    for (let at = page.events.length - 1; at >= 0; at -= 1) {
      const event = page.events[at]
      const ended = resultOf(event)
      if (ended?.callId === body.callId) { result = ended.message; resultMeta = ended.meta; resultSeq = ended.seq }
      const call = callOf(event)
      if (call?.callId !== body.callId) continue
      if (body.callSeq == null || event.seq === body.callSeq) { found = { event, call }; break }
      // 较新的同编号调用是关联边界，不能把它的结果接到指定的旧调用。
      result = resultMeta = resultSeq = undefined
    }
    if (found !== undefined || page.beforeSeq === null) break
    before = page.beforeSeq
  }
  // 老调用可用明确的 seq 定位，输出若不在本次扫描范围内则如实显示未提供。
  if (found === undefined && Number.isSafeInteger(body.callSeq)) {
    result = resultMeta = resultSeq = undefined
    const page = await logPage(rt, scope, body.callSeq + 1, signal)
    const event = page.events.find(event => event.seq === body.callSeq && callOf(event)?.callId === body.callId)
    if (event !== undefined) found = { event, call: callOf(event) }
  }
  if (found === undefined || SKIP.has(found.call.name)) throw failure('bot/not-found', 'The tool call was not found on this page')
  const turn = Number.isInteger(found.event.data?.turn) ? found.event.data.turn : await turnAt(rt, scope, found.event.seq, signal)
  if (scope.includeHidden !== true && ((rt.state.exchangeTurns?.[scope.id]?.length ?? 0) > 0 && turn === undefined || hiddenTurn(rt, scope, turn))) {
    throw failure('bot/refused', 'Allow full messages for this paired device on the computer first')
  }
  return { ...found, result, resultMeta, resultSeq, turn }
}

function outputOf(message) {
  if (Array.isArray(message?.content)) return message.content.map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text
    : block?.type === 'image' ? '[图片内容不在工具详情中传输]' : block?.type === 'file' ? '[文件内容请通过原附件入口读取]' : '').filter(Boolean).join('\n')
  return message?.text
}

export function install(rt) {
  const mask = text => redactText(text, rt.redactSecrets)
  const summarize = tool => {
    const { description, filePath, ...value } = tool
    const describe = typeof rt.redactSecrets === 'function' && rt.secretStoreStatus?.()?.locked === false
    return { ...value, name: mask(tool.name), label: tool.label == null ? null : mask(tool.label),
      ...(describe && description ? { description: mask(description).replace(/\s+/g, ' ').slice(0, 320) } : {}),
      ...(describe && filePath ? { filePath: mask(filePath).slice(0, 1024) } : {}) }
  }
  rt.extraStepsItems = (events, sessionId, options = {}) => {
    const hidden = options.includeHidden === true ? [] : rt.state.exchangeTurns?.[sessionId] ?? []
    const tools = toolsFromEvents(events, sessionId, { ...options, hidden })
    const byTurn = new Map()
    for (const tool of tools) {
      if (!Number.isInteger(tool.turn)) continue
      const list = byTurn.get(tool.turn) ?? byTurn.set(tool.turn, []).get(tool.turn)
      list.push(summarize(tool))
    }
    return byTurn
  }
  rt.extraToolList = async (body, signal, options) => {
    await rt.loadSecrets()
    const scope = ownedSession(rt, body, options)
    const page = await logPage(rt, scope, body.beforeSeq, signal)
    const seedTurn = Number.isSafeInteger(page.events[0]?.seq) ? await turnAt(rt, scope, page.events[0].seq, signal) : undefined
    const tools = toolsFromEvents(page.events, scope.id, { seedTurn, hidden: scope.includeHidden ? [] : rt.state.exchangeTurns?.[scope.id] ?? [] })
    return { items: tools.map(summarize), cursor: page.beforeSeq === null ? null : { beforeSeq: page.beforeSeq } }
  }
  let reading = 0
  rt.extraToolDetail = async (body, signal, options) => {
    if (reading >= 4) throw failure('bot/unavailable', 'Tool details are busy. Try again shortly.')
    if (!['arguments', 'output'].includes(body.field)) throw failure('bot/invalid', 'Choose arguments or output')
    if (body.offset !== undefined && (!Number.isSafeInteger(body.offset) || body.offset < 0)) throw failure('bot/invalid', 'The detail cursor is invalid')
    reading += 1
    try {
      await rt.loadSecrets()
      if (typeof rt.redactSecrets !== 'function' || rt.secretStoreStatus?.().locked === true) return { available: false, reason: '密钥脱敏服务未就绪，工具详情暂不传输' }
      const scope = ownedSession(rt, body, options)
      const found = await findCall(rt, scope, body, signal)
      const value = body.field === 'arguments' ? found.call.args : outputOf(found.result)
      if (value === undefined) return { available: false, status: statusOf(found.result), reason: body.field === 'output' ? '日志尚未提供此工具的输出；这不代表工具成功' : '日志未提供此工具的参数' }
      const text = displayText(value, rt.redactSecrets)
      const digest = createHash('sha256').update(text).digest('hex')
      if (body.digest !== undefined && body.digest !== digest) throw failure('bot/stale', 'The tool detail changed. Read the first page again.')
      const offset = body.offset ?? 0
      if (offset > text.length) throw failure('bot/invalid', 'The detail cursor is outside this output')
      if (offset > 0 && body.digest === undefined) throw failure('bot/invalid', 'The detail cursor needs its digest')
      let end = Math.min(text.length, offset + CHUNK_SIZE)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1
      return { available: true, sessionId: scope.id, callId: body.callId, name: mask(found.call.name), status: statusOf(found.result), field: body.field,
        text: text.slice(offset, end), offset, totalChars: text.length, digest, nextOffset: end < text.length ? end : null, redacted: true }
    } finally { reading -= 1 }
  }
}
