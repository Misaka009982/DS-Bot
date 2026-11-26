import { splitRef } from '../text.js'

const failure = (code, message) => Object.assign(new Error(message), { code })
const queued = agent => [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
const referenceKeys = new Set(['sessionId', 'fromPart', 'toPart', 'targetSessionId', 'sourceSessionId', 'toId'])
const references = (value, id) => value !== null && typeof value === 'object'
  && Object.entries(value).some(([key, entry]) => referenceKeys.has(key) && entry === id || references(entry, id))
export const settingsKey = bot => JSON.stringify([bot.model, bot.appliedModel, bot.effort, bot.permission, bot.workDir])
const hasPendingWork = (rt, id) => rt.waitsForApproval?.(id) || rt.hasSubagents?.(id)
  || (rt.runningJobs?.(id)?.length ?? 0) > 0 || rt.state.questions[id] !== undefined
  || rt.state.views?.[id] !== undefined || references(rt.state.works, id) || references(rt.state.inflight, id)
const busy = () => failure('bot/busy', '当前会话仍有运行、排队或待处理的操作，请先完成或停止后再新建会话。')

export function checkIdle(rt, agent) {
  const id = agent.id
  const live = rt.live.get(id)
  if (agent.status !== 'idle' || live?.turn !== undefined || live?.pending !== undefined || queued(agent).length > 0
    || rt.isSwitchingPart(id) || rt.isHandingOff?.(id) || hasPendingWork(rt, id) || rt.state.switching[id] !== undefined) {
    throw busy()
  }
}

export function install(rt) {
  rt.extraNewSession = async (body, authorize = () => {}) => {
    const { botId, sessionId } = body
    if (typeof botId !== 'string' || typeof sessionId !== 'string' || !sessionId
      || Object.keys(body).some(key => key !== 'botId' && key !== 'sessionId')) {
      throw failure('bot/invalid', '请选择当前 Bot 的会话。')
    }
    const bot = rt.botOf(botId)
    if (bot === undefined) throw failure('bot/not-found', '找不到这个 Bot。')
    const check = () => {
      authorize()
      if (rt.readOnly() !== undefined) throw failure('bot/read-only', rt.readOnly())
      if (rt.botOf(botId) !== bot || rt.chatOf(botId) !== sessionId) {
        throw failure('bot/stale', '当前会话已变化，请刷新后重试。')
      }
    }
    check()
    const agent = await rt.resolveAgent(sessionId)
    check()
    checkIdle(rt, agent)
    if (typeof agent.runMaintenance !== 'function' || typeof rt.extraStartFreshPart !== 'function') {
      throw failure('bot/unavailable', '当前宿主不支持安全新建会话。')
    }
    await rt.extraPauseGoal?.(botId, '用户要求新建干净会话，目标保留并暂停，请核对后恢复。')
    check()
    checkIdle(rt, agent)
    if (!await rt.extraStartFreshPart(agent, check)) throw failure('bot/busy', '会话正在切换，请刷新后重试。')
    return { botId, sessionId: rt.chatOf(botId) }
  }

  // 只替换上下文准备步骤，交接锁、迟到消息、定时任务与重启恢复仍由 parts 管理。
  rt.extraMoveToFreshPart = async (agent, job, signal, forward, restore) => {
    const bot = rt.botOf(job.botId)
    const check = () => {
      if (signal.aborted) throw signal.reason
      job.check()
      if (hasPendingWork(rt, agent.id)) throw busy()
    }
    check()
    const key = settingsKey(bot)
    const previousId = bot.sessionId
    const previousSegments = bot.segments
    let freshId
    try {
      freshId = await rt.createSession(bot.name, { dir: rt.workDirOf({ botId: bot.id }) })
      check()
      const ref = await rt.desiredModel(bot)
      const oldRoute = agent.session.requestHeader()?.config
      let route
      if (ref !== undefined) {
        route = { ...splitRef(ref), reasoningEffort: await rt.desiredEffort(bot, ref) }
      } else if (oldRoute?.provider && oldRoute?.model) {
        route = { provider: oldRoute.provider, model: oldRoute.model,
          ...(oldRoute.reasoningEffort === undefined ? {} : { reasoningEffort: oldRoute.reasoningEffort }) }
      }
      if (route !== undefined) await rt.selectSessionModel(freshId, route)
      await rt.applyPermission(bot, freshId)
      const fresh = await rt.resolveAgent(freshId)
      await rt.ctx.sessions.flush(fresh.session)
      check()
      if (key !== settingsKey(bot)) throw failure('bot/stale', 'Bot 设置刚刚发生变化，请重试新建会话。')
      // 不 fork、不调用模型写摘要，也不写入旧消息或 handoff 占位消息。
      const segments = [...(previousSegments ?? []), { sessionId: agent.id, endedAt: Date.now() }]
      bot.segments = segments
      bot.sessionId = freshId
      try {
        await rt.save({ required: true })
      } catch (error) {
        if (rt.botOf(bot.id) === bot && bot.sessionId === freshId && bot.segments === segments) {
          if (previousId === undefined) delete bot.sessionId
          else bot.sessionId = previousId
          if (previousSegments === undefined) delete bot.segments
          else bot.segments = previousSegments
          // save 同步重建所有权索引；再次写入失败时仍保持内存中的原会话。
          await rt.save({ required: true }).catch(() => {})
        }
        throw error
      }
      job.moved = true
      job.next = freshId
      const held = queued(agent)
      const carry = job.carry.splice(0)
      try {
        await rt.ensureCapabilities(freshId)
        await forward(job, [...carry, ...held], freshId)
      } catch (error) {
        job.kept = true
        try { restore(agent, [...carry, ...job.carry.splice(0)]) } catch {}
        throw error
      }
      for (const message of held) agent.inbox.remove(message.id)
      for (let late = job.carry.splice(0); late.length > 0; late = job.carry.splice(0)) {
        await forward(job, late, freshId).catch(error => {
          job.kept = true
          try { restore(agent, [...late, ...job.carry.splice(0)]) } catch {}
          throw error
        })
      }
    } finally {
      if (freshId !== undefined && !job.moved && !rt.isBotSession(freshId)) {
        await rt.ctx.workspaceRegistry.archiveSession(freshId).catch(() => {})
      }
    }
  }
}
