import { HISTORY_TIMEOUT_MS } from '../constants.js'

export const PAGE_EVENTS = 500
export const SCAN_PAGES = 16
const failure = (code, message) => Object.assign(new Error(message), { code })

export function ownedSession(rt, body, options = {}) {
  let id = typeof body.sessionId === 'string' ? body.sessionId : undefined
  if (typeof body.botId === 'string') {
    const bot = rt.botOf(body.botId)
    if (bot === undefined) throw failure('bot/not-found', 'Unknown Bot')
    if (body.taskId !== undefined) {
      const task = bot.tasks?.find(task => task?.id === body.taskId)
      if (task === undefined) throw failure('bot/not-found', 'Unknown background task')
      const parts = [...(task.segments ?? []).map(part => part.sessionId), task.sessionId]
      if (id !== undefined && !parts.includes(id)) throw failure('bot/refused', 'This session does not belong to the task')
      id ??= task.sessionId
    } else id = rt.chatOf(bot.id)
  }
  if (typeof body.agentId === 'string') id = rt.agentById?.(body.agentId)?.sessions?.at(-1)
  if (typeof id !== 'string' || id === '' || id.length > 200) throw failure('bot/invalid', 'Choose an owned session')
  const botId = rt.selfOf(id)
  const roomId = rt.groupOwners?.get(id)?.roomId ?? rt.roomOwners?.get(id) ?? rt.pastOwners?.get(id)?.roomId
  const agent = rt.agentOf?.(id)
  if (botId === undefined && roomId === undefined && agent === undefined) throw failure('bot/not-found', 'This session is not on the team')
  if (agent !== undefined && !['phone', 'local'].includes(options.deviceKind)) throw failure('bot/refused', 'Not available from a browser. Use the phone app or the computer.')
  if (body.roomId !== undefined && body.roomId !== roomId) throw failure('bot/refused', 'This session does not belong to this group')
  let minSeq = 0
  const bot = botId === undefined ? undefined : rt.botOf(botId)
  for (const task of bot?.tasks ?? []) {
    const parts = [...(task.segments ?? []).map(part => part.sessionId), task.sessionId]
    const at = parts.indexOf(id)
    if (at < 0) continue
    if (at === 0) {
      if (!Number.isInteger(task.startSeq) || task.startSeq < 0) throw failure('bot/unavailable', 'This older task has no stored history boundary. Read it on the computer.')
      minSeq = task.startSeq
    }
  }
  return { id, botId, roomId, minSeq, includeHidden: options.fullMessages === true || roomId !== undefined }
}

// 旧版 DSH 的 page 要求显式截止序号；只读取现有 Agent 或被动投影，不激活旧会话。
export async function historyThroughSeq(rt, sessionId, signal) {
  const check = () => { if (signal?.aborted) throw failure('bot/refused', 'The request was canceled') }
  check()
  const next = rt.ctx.get?.('agents')?.get?.(sessionId)?.session?.seq
  if (Number.isSafeInteger(next) && next >= 0) return next - 1
  if (typeof rt.ctx.sessionController?.projections !== 'function') {
    throw failure('bot/unavailable', '当前宿主无法提供可靠的历史截止序号，请更新宿主后重试。')
  }
  const baseline = await rt.ctx.sessionController.projections({ sessionId }, signal)
  check()
  if (baseline === null) throw failure('bot/not-found', '找不到这条会话的历史记录。')
  if (baseline?.kind !== 'sequenced' || !Number.isSafeInteger(baseline.asOfSeq) || baseline.asOfSeq < -1 || Object.is(baseline.asOfSeq, -0)) {
    throw failure('bot/unavailable', '会话历史尚未提供可靠的日志序号，请先在宿主完成迁移或刷新后重试。')
  }
  return baseline.asOfSeq
}

export async function logPage(rt, scope, beforeSeq, signal) {
  if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) throw failure('bot/invalid', 'The history cursor is invalid')
  if (signal?.aborted) throw failure('bot/refused', 'The request was canceled')
  const timeout = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
  const reading = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  // 同一次详情查找和轮次回溯共用固定切面，不混入读取期间新增的同编号调用。
  scope.throughSeq ??= await historyThroughSeq(rt, scope.id, reading)
  if (!Number.isSafeInteger(scope.throughSeq) || scope.throughSeq < -1 || Object.is(scope.throughSeq, -0)) throw failure('bot/invalid', 'The history boundary is invalid')
  if (reading.aborted) throw failure('bot/refused', 'The request was canceled')
  if (scope.throughSeq < scope.minSeq) return { events: [], beforeSeq: null }
  const page = await rt.ctx.sessionController.page({ address: { kind: 'session', sessionId: scope.id }, throughSeq: scope.throughSeq, maxMessages: 60,
    ...(beforeSeq === undefined ? {} : { beforeSeq }) }, reading)
  if (reading.aborted) throw failure('bot/refused', 'The request was canceled')
  const records = Array.isArray(page?.records) ? page.records : []
  const raw = records.slice(-PAGE_EVENTS).map(record => record.event).filter(Boolean)
  const events = raw.filter(event => !Number.isInteger(event.seq) || event.seq >= scope.minSeq)
  const first = raw[0]?.seq
  const hasMore = Number.isSafeInteger(first) && first > scope.minSeq && (page.hasMore === true || records.length > PAGE_EVENTS)
  return { events, beforeSeq: hasMore ? first : null }
}

export async function turnAt(rt, scope, seq, signal) {
  const session = rt.ctx.get?.('agents')?.get?.(scope.id)?.session
  const events = session?.snapshotEvents?.()
  if (Array.isArray(events)) {
    const start = events.findLast(event => event.type === 'turn/start' && event.seq <= seq)
    if (Number.isInteger(start?.data?.turn)) return start.data.turn
  }
  let before = seq + 1
  for (let pages = 0; pages < SCAN_PAGES; pages += 1) {
    const page = await logPage(rt, scope, before, signal)
    const start = page.events.findLast(event => event.type === 'turn/start' && Number.isInteger(event.data?.turn))
    if (start !== undefined) return start.data.turn
    if (page.beforeSeq === null) break
    before = page.beforeSeq
  }
  return undefined
}

export function hiddenTurn(rt, scope, turn) {
  return scope.includeHidden !== true && (rt.state.exchangeTurns?.[scope.id] ?? []).includes(turn)
}
