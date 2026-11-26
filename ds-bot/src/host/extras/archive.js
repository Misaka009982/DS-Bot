import { HISTORY_TIMEOUT_MS } from '../constants.js'
import { autoArchive } from './settings.js'
import { historyThroughSeq } from './log-page.js'

export const DAY_MS = 24 * 60 * 60_000
const SETTLED = new Set(['completed', 'failed', 'interrupted', 'stopped'])
const BATCH_SIZE = 32
const INTERVAL_MS = 5 * 60_000
const enabled = (rt, bot) => autoArchive(bot?.extras, rt.state.extras?.defaults)
const stamp = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
const current = (rt, id) => [rt.chatOwners, rt.taskOwners, rt.groupOwners, rt.roomOwners].some(owners => owners?.has(id))
const queued = agent => (agent?.inbox?.nextTurn?.length ?? 0) + (agent?.inbox?.nextStep?.length ?? 0) > 0
const loadedAgent = (rt, id) => rt.ctx.get?.('agents')?.get?.(id)
const refs = new Set(['sessionId', 'fromPart', 'toPart', 'targetSessionId', 'sourceSessionId', 'toId'])
const hasReference = (value, id, depth = 0) => {
  if (value === null || typeof value !== 'object' || depth > 4) return false
  return Object.entries(value).some(([key, entry]) => refs.has(key) && entry === id || hasReference(entry, id, depth + 1))
}

export function archiveCandidates(rt, now = Date.now()) {
  const items = []
  const seen = new Set(rt.ctx.workspaceRegistry?.archivedSessionIds ?? [])
  const add = (bot, record, task) => {
    const sessionId = record?.sessionId
    const endedAt = stamp(record?.endedAt)
    const lastAt = Math.max(endedAt, stamp(record?.updatedAt))
    if (typeof sessionId !== 'string' || sessionId === '' || endedAt === 0 || lastAt >= now - DAY_MS || seen.has(sessionId) || current(rt, sessionId)) return
    seen.add(sessionId)
    items.push({ bot, record, task, sessionId, lastAt })
  }
  for (const bot of Object.values(rt.state.bots ?? {})) {
    if (!enabled(rt, bot)) continue
    for (const segment of bot.segments ?? []) add(bot, segment)
    for (const task of bot.tasks ?? []) {
      if (!SETTLED.has(task?.status)) continue
      add(bot, task, task)
      for (const segment of task.segments ?? []) add(bot, segment, task)
    }
    for (const room of Object.values(rt.state.rooms ?? {})) {
      for (const segment of room.segments?.[bot.id] ?? []) add(bot, segment)
    }
  }
  return items
}

export function archiveBlocked(rt, sessionId, scheduled = new Set()) {
  if (current(rt, sessionId) || scheduled.has(sessionId) || rt.readOnly() !== undefined) return true
  const live = rt.live?.get(sessionId)
  if (live?.turn !== undefined || live?.pending !== undefined || live?.info !== undefined || live?.switching === true) return true
  const agent = loadedAgent(rt, sessionId)
  if (queued(agent) || typeof agent?.status === 'string' && !['idle', 'stopped'].includes(agent.status)) return true
  if (rt.waitsForApproval?.(sessionId) === true || (rt.runningJobs?.(sessionId)?.length ?? 0) > 0 || rt.hasSubagents?.(sessionId) === true || rt.extraHasTerminals?.(sessionId) === true) return true
  for (const key of ['questions', 'views', 'switching', 'approvals', 'inflight']) {
    const entries = rt.state[key]
    if (entries !== null && typeof entries === 'object' && (Object.hasOwn(entries, sessionId) || hasReference(entries, sessionId))) return true
  }
  return hasReference(rt.state.works, sessionId) || hasReference(rt.state.retiredParts, sessionId)
}

async function scheduledSessions(rt) {
  const service = rt.ctx.get?.('schedule')
  if (service === undefined) return new Set()
  if (typeof service.catalog !== 'function') return undefined
  const entries = await service.catalog()
  if (!Array.isArray(entries)) return undefined
  return new Set(entries.filter(entry => !['finished', 'completed', 'canceled', 'cancelled', 'deleted'].includes(entry?.status))
    .map(entry => entry?.target === undefined ? entry?.sessionId : entry.target.kind === 'session' ? entry.target.sessionId : undefined).filter(Boolean))
}

// 普通归档由 DSH 的活动检查拒绝繁忙会话；不使用 stopActivity，不取消作业。
export async function archiveExpired(rt, now = Date.now(), halted = () => false, startAt = 0) {
  const result = { supported: true, checked: 0, archived: 0, skipped: 0, failed: 0 }
  const registry = rt.ctx.workspaceRegistry
  if (typeof registry?.archiveSession !== 'function' || !Array.isArray(registry.archivedSessionIds)) return { ...result, supported: false }
  if (rt.readOnly() !== undefined || halted()) return result
  const scheduled = await scheduledSessions(rt)
  if (scheduled === undefined) return { ...result, supported: false }
  const all = archiveCandidates(rt, now)
  const offset = all.length === 0 ? 0 : startAt % all.length
  const candidates = [...all.slice(offset), ...all.slice(0, offset)].slice(0, BATCH_SIZE)
  result.nextIndex = all.length === 0 ? 0 : (offset + candidates.length) % all.length
  for (const candidate of candidates) {
    if (rt.readOnly() !== undefined || halted()) break
    const { sessionId, bot, task } = candidate
    result.checked += 1
    if (!enabled(rt, bot) || rt.botOf(bot.id) !== bot || task !== undefined && !SETTLED.has(task.status) || archiveBlocked(rt, sessionId, scheduled)) { result.skipped += 1; continue }
    try {
      const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
      const throughSeq = await historyThroughSeq(rt, sessionId, signal)
      const page = await rt.ctx.sessionController.page({ address: { kind: 'session', sessionId }, throughSeq, maxMessages: 1 }, signal)
      const lastAt = Math.max(candidate.lastAt, ...(page?.records ?? []).map(record => stamp(record?.event?.time)))
      if (lastAt >= now - DAY_MS || halted() || !enabled(rt, bot) || rt.botOf(bot.id) !== bot || rt.readOnly() !== undefined || archiveBlocked(rt, sessionId, scheduled)) { result.skipped += 1; continue }
      await registry.archiveSession(sessionId)
      if (!registry.archivedSessionIds.includes(sessionId)) { result.skipped += 1; continue }
      result.archived += 1
      if (!archiveBlocked(rt, sessionId, scheduled)) await rt.closeLocalAgentSession?.(sessionId, '已结束的旧会话已归档')
    } catch (error) {
      result.failed += 1
      // 不记录异常正文，避免把日志中的工具参数或认证信息带入清理日志。
      rt.warn?.('ds-bot: 旧会话 %s 未归档（%s），保留并等待下次检查', sessionId, error?.code ?? error?.name ?? 'error')
    }
  }
  return result
}

export function install(rt) {
  let stopped = false
  let running
  let timer
  let last = null
  let nextIndex = 0
  rt.extraArchive = () => {
    if (stopped) return Promise.resolve(last)
    if (running !== undefined) return running
    running = Promise.resolve(rt.load()).then(() => archiveExpired(rt, Date.now(), () => stopped, nextIndex))
      .then(result => { nextIndex = result.nextIndex ?? 0; last = result; return result }).finally(() => { running = undefined })
    return running
  }
  rt.extraArchiveStatus = () => last
  // 历史只读取已加载的 Agent；没有加载的旧段直接走持久化分页。
  rt.extraHistoryAgent = async sessionId => rt.pastOwners?.has(sessionId) || rt.ctx.workspaceRegistry?.archivedSessionIds?.includes(sessionId)
    ? loadedAgent(rt, sessionId) : rt.resolveAgent(sessionId)
  rt.ctx.effect(() => {
    const schedule = delay => { timer = setTimeout(tick, delay); timer.unref?.() }
    const tick = async () => {
      try { await rt.extraArchive() } catch (error) { rt.warn?.('ds-bot: 自动归档检查未完成（%s）', error?.code ?? error?.name ?? 'error') }
      if (!stopped) schedule(INTERVAL_MS)
    }
    schedule(30_000)
    return () => { stopped = true; clearTimeout(timer) }
  }, 'ds-bot: 增补旧会话归档')
}
