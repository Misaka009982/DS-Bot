import { SOURCE_KIND } from '../constants.js'
import { redactText, redactValue } from '../../shared/extras/redact.js'

const INTERNAL = new Set(['request', 'reply', 'report', 'stopped', 'retry', 'resume', 'continue', 'task-report'])
const bodyText = event => (Array.isArray(event.data?.content) ? event.data.content : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
const errorOf = event => event.data?.reason?.kind === 'error' ? event.data.reason.error : event.data?.error

export function diagnosticItem(event, fullMessages, mask = text => text) {
  let title
  let error
  if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') { title = '模型请求失败'; error = errorOf(event) }
  else if (event.type === 'turn/end' && event.data?.reason?.kind === 'aborted') title = '本轮工作已取消或中断'
  else if (event.type === 'llm/retry-started') { title = '模型请求正在重试'; error = errorOf(event) }
  else if (event.type === 'assistant/attempt' && errorOf(event) !== undefined) { title = '模型尝试失败'; error = errorOf(event) }
  else return undefined
  const code = typeof error?.code === 'string' ? mask(error.code).slice(0, 100) : undefined
  const status = typeof error?.status === 'number' && Number.isFinite(error.status) ? error.status : undefined
  const sensitive = ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'ACCOUNT_TOKEN_INVALID'].includes(error?.code)
  const details = fullMessages && sensitive ? '认证错误正文已隐藏，避免回显凭据'
    : fullMessages && typeof error?.message === 'string' ? mask(error.message) : undefined
  const stack = fullMessages && !sensitive && typeof error?.stack === 'string' ? mask(error.stack).slice(0, 12_000) : undefined
  return { kind: 'diagnostic', title, text: [title, code ? `错误码：${code}` : '', status === undefined ? '' : `状态：${status}`, details ?? ''].filter(Boolean).join('\n'),
    ...(code === undefined ? {} : { code }), ...(stack ? { detail: stack } : {}),
    ...(Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}), ...(Number.isInteger(event.data?.turn) ? { turn: event.data.turn } : {}), time: event.time }
}

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\p{Cc}]/u.test(value)
export function exchangeSource(rt, source, sessionId) {
  if (!validId(source?.senderSessionId) || !validId(source?.exchangeId)) return undefined
  const from = rt.botOf(source.senderSessionId); const to = rt.botOf(rt.selfOf(sessionId))
  if (!from || !to || from.id !== source.senderSessionId || from.id === to.id || from.private === true || to.private === true) return undefined
  const entry = rt.exchangeOf?.(source.exchangeId, from.id, to.id)
  if (!entry || entry.id !== source.exchangeId || entry.from !== from.id || entry.to !== to.id || entry.audience === 'user') return undefined
  return { schema: 1, id: entry.id, from: from.id, to: to.id }
}
export function projectMessages(items, events, sessionId, options = {}) {
  const mask = text => redactText(text, options.mask)
  if (options.fullMessages === true) {
    for (const item of items) {
      if (item.kind === 'bot' && (options.hiddenTurns ?? []).includes(item.turn)) {
        item.kind = 'internal'
        item.name = options.name ?? 'Bot'
        item.title = '内部协作回复'
      }
    }
    for (const event of events) {
      const source = event.data?.source
      if (event.type !== 'user/message' || source?.kind !== SOURCE_KIND || !INTERNAL.has(source.role)) continue
      const text = mask(bodyText(event))
      if (text.trim() === '') continue
      const exchange = options.exchange?.(source, sessionId)
      const row = { kind: 'internal', sessionId, text, name: mask(source.senderName ?? 'Bot'), role: source.role, title: '内部协作消息', time: event.time,
        ...(exchange ? { exchange } : {}), ...(Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}) }
      const at = items.findIndex(item => item.seq === event.seq && item.kind === 'event')
      if (at >= 0) items.splice(at, 1, row)
      else if (!items.some(item => item.seq === event.seq && item.kind === 'internal')) items.push(row)
    }
  }
  for (const event of events) {
    const row = diagnosticItem(event, options.fullMessages === true, mask)
    if (row !== undefined) items.push({ ...row, sessionId })
  }
  // 排序稳定，工具步骤等没有 seq 的原行维持原来位置，新增行按日志时间插入。
  items.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  for (const item of items) {
    if (typeof item.text === 'string') item.text = mask(item.text)
    if (typeof item.title === 'string') item.title = mask(item.title)
    if (Array.isArray(item.texts)) item.texts = item.texts.map(mask)
  }
  return items
}

export function install(rt) {
  rt.extraSanitizeMessages = async value => {
    await rt.loadSecrets()
    if (typeof rt.redactSecrets !== 'function' || rt.secretStoreStatus?.().locked === true) {
      throw Object.assign(new Error('密钥脱敏服务未就绪，协作正文暂不传输'), { code: 'bot/unavailable' })
    }
    return redactValue(value, rt.redactSecrets)
  }
  rt.extraProjectMessages = (items, events, sessionId, options) => projectMessages(items, events, sessionId, {
    ...options, hiddenTurns: rt.state.exchangeTurns?.[sessionId] ?? [], name: rt.botOf(rt.selfOf(sessionId))?.name,
    mask: rt.redactSecrets, exchange: (source, id) => exchangeSource(rt, source, id),
  })
  rt.extraMessages = async (body, signal, options) => {
    await rt.loadSecrets()
    const ready = typeof rt.redactSecrets === 'function' && rt.secretStoreStatus?.().locked !== true
    if (!ready && options.fullMessages === true) throw Object.assign(new Error('密钥脱敏服务未就绪，完整消息暂不传输'), { code: 'bot/unavailable' })
    const pageOptions = { extraSteps: true, extraMessages: true, fullMessages: options.fullMessages === true }
    if (typeof body.roomId === 'string') return rt.mobileEndpoint('room-chat', { ...body, steps: true, extraSteps: true, extraMessages: true, fullMessages: pageOptions.fullMessages })
    if (typeof body.agentId === 'string') {
      if (!['phone', 'local'].includes(options.deviceKind)) throw Object.assign(new Error('Not available from a browser. Use the phone app or the computer.'), { code: 'bot/refused' })
      return rt.agentPage(body.agentId, body.cursor, true, pageOptions)
    }
    if (typeof body.botId !== 'string' || rt.botOf(body.botId) === undefined) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
    return rt.chatPage(body.botId, body.cursor, true, pageOptions)
  }
  rt.extraTaskPage = async (body, signal, options) => {
    await rt.loadSecrets()
    if (options.fullMessages === true && (typeof rt.redactSecrets !== 'function' || rt.secretStoreStatus?.().locked === true)) {
      throw Object.assign(new Error('密钥脱敏服务未就绪，完整任务消息暂不传输'), { code: 'bot/unavailable' })
    }
    if (typeof body.botId !== 'string' || typeof body.taskId !== 'string') throw Object.assign(new Error('Choose a background task'), { code: 'bot/invalid' })
    return rt.taskPage(body.botId, body.taskId, body.cursor, true, { extraSteps: true, extraMessages: true, fullMessages: options.fullMessages === true })
  }
  let timer
  const changed = new Set()
  const flush = () => {
    timer = undefined
    for (const sessionId of changed) {
      const owner = rt.pastOwners?.get(sessionId)
      rt.publishFeed?.('extra-update', { sessionId, botId: rt.selfOf(sessionId) ?? owner?.botId,
        roomId: rt.groupOwners?.get(sessionId)?.roomId ?? rt.roomOwners?.get(sessionId) ?? owner?.roomId })
    }
    changed.clear()
  }
  rt.ctx.on('session/event', (session, event) => {
    if (session?.id === undefined || !['tool/call', 'tool/result', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'turn/end', 'llm/retry-started'].includes(event.type)) return
    if (rt.selfOf(session.id) === undefined && !rt.roomOwners?.has(session.id) && rt.agentOf?.(session.id) === undefined) return
    changed.add(session.id)
    if (timer === undefined) { timer = setTimeout(flush, 180); timer.unref?.() }
  })
  rt.ctx.effect(() => () => { clearTimeout(timer); changed.clear() }, 'ds-bot: 增补消息刷新')
}
