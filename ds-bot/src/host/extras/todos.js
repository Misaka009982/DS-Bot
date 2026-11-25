import { logPage, ownedSession, SCAN_PAGES, turnAt } from './log-page.js'
import { redactText } from '../../shared/extras/redact.js'

const TOOLS = new Set(['todo_write', 'TodoWrite', 'update_plan'])
const STATES = { pending: 'pending', todo: 'pending', in_progress: 'in_progress', running: 'in_progress', completed: 'completed', done: 'completed', canceled: 'canceled', cancelled: 'canceled' }
const parse = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value) } catch { return undefined } }

export function todoItems(value, mask = text => text) {
  const parsed = parse(value)
  const list = Array.isArray(parsed) ? parsed : parsed?.todos ?? parsed?.items ?? parsed?.plan
  if (!Array.isArray(list)) return undefined
  const items = []
  for (const entry of list.slice(0, 100)) {
    const title = entry?.content ?? entry?.text ?? entry?.title ?? entry?.step
    const status = Object.hasOwn(STATES, entry?.status) ? STATES[entry.status] : undefined
    if (typeof title !== 'string' || title.trim() === '' || status === undefined) continue
    items.push({ ...(typeof entry.id === 'string' ? { id: redactText(entry.id, mask).slice(0, 100) } : {}), text: redactText(title, mask).slice(0, 2000), status })
  }
  return list.length === 0 || items.length > 0 ? items : undefined
}

export function latestTodo(events, { hidden = [], seedTurn, mask } = {}) {
  const results = new Map()
  const candidates = []
  let turn = seedTurn
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data?.turn
    if (event.type === 'tool/result') results.set(event.data?.message?.toolCallId ?? event.data?.callId, event.data?.message)
    if (event.type === 'tool/ptc-dispatch') results.set(event.data?.subCallId, event.data?.result ?? event.data?.message)
    const call = event.type === 'tool/call' ? event.data : event.type === 'tool/ptc-dispatch-start' ? { ...event.data, callId: event.data?.subCallId } : undefined
    if (!TOOLS.has(call?.name)) continue
    const callTurn = Number.isInteger(call.turn) ? call.turn : turn
    if (hidden.includes(callTurn) || hidden.length > 0 && callTurn === undefined) continue
    candidates.push({ call, event })
  }
  for (const candidate of candidates.reverse()) {
    const result = results.get(candidate.call.callId)
    if (result?.ok !== true) continue
    const resultText = (result.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
    const items = todoItems(result.value, mask) ?? todoItems(resultText, mask) ?? todoItems(candidate.call.arguments, mask)
    if (items !== undefined) return { items, time: candidate.event.time, seq: candidate.event.seq }
  }
  return undefined
}

export function install(rt) {
  rt.extraTodos = async (body, signal, options) => {
    await rt.loadSecrets()
    if (rt.secretStoreStatus?.().locked === true) throw Object.assign(new Error('密钥库未解锁，待办正文暂不传输'), { code: 'bot/unavailable' })
    const scope = ownedSession(rt, body, options)
    const collected = []
    let before
    for (let count = 0; count < SCAN_PAGES; count += 1) {
      const page = await logPage(rt, scope, before, signal)
      collected.unshift(...page.events)
      const seedTurn = Number.isSafeInteger(collected[0]?.seq) ? await turnAt(rt, scope, collected[0].seq, signal) : undefined
      const found = latestTodo(collected, { mask: rt.redactSecrets, seedTurn, hidden: scope.includeHidden ? [] : rt.state.exchangeTurns?.[scope.id] ?? [] })
      if (found !== undefined) return { sessionId: scope.id, ...found }
      if (page.beforeSeq === null) return { sessionId: scope.id, items: [], empty: true }
      before = page.beforeSeq
    }
    return { sessionId: scope.id, items: [], partial: true }
  }
}
