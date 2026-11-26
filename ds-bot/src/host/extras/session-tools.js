import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from '../tools.js'
import { threadOfPart } from '../threads.js'
import { checkIdle, settingsKey } from './new-session.js'

const failure = (code, message) => Object.assign(new Error(message), { code })
const queued = agent => [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
const RECEIPT_TTL_MS = 10 * 60_000
const BOT = { type: 'string', required: true, description: 'list_bots 中目标普通、非私有 Bot 的确切名称；只操作它的当前私聊' }
const REASON = { type: 'string', required: true, description: '已观察到的会话故障或暂停原因，1–500 字符；不要包含密钥、Token 或密码' }

function validate(args, fields) {
  if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !fields.includes(key))
    || typeof args.bot !== 'string' || !args.bot.trim() || args.bot.length > 200
    || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 500) {
    throw failure('bot/invalid', '请填写目标 Bot 和简短原因，不要附带其他管理参数。')
  }
}

function waitForIdle(promise, signal) {
  let onAbort
  const canceled = new Promise((_resolve, reject) => {
    onAbort = () => reject(failure('bot/refused', '暂停请求已取消；不能据此确认目标已停止或继续换会话。'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  return Promise.race([promise, canceled]).finally(() => signal.removeEventListener('abort', onAbort))
}

export function install(rt) {
  const paused = new Map()
  const operations = new Map()
  const shutdown = new AbortController()
  const unfinishedPrivateSwitch = (target, except) => Object.entries(rt.state.switching).some(([id, owner]) => id !== except
    && owner?.botId === target.id && owner.roomId === undefined && threadOfPart(target, id)?.thread === 'current')
  const invalidate = sessionId => {
    for (const [id, receipt] of paused) if (receipt.sessionId === sessionId) paused.delete(id)
    for (const operation of operations.values()) if (operation.sessionId === sessionId) operation.invalidated = true
  }
  rt.ctx.on('session/event', function invalidateMainPause(session, event) {
    if (event.type === 'turn/start') invalidate(session.id)
  })
  rt.ctx.on('agent/inbox/inserted', ({ agent }) => invalidate(agent?.id ?? agent?.session?.id))
  rt.ctx.effect(() => () => {
    shutdown.abort()
    paused.clear()
    operations.clear()
  }, 'ds-bot: 主 Bot 会话工具')

  async function contextFor(args, exec) {
    await rt.load()
    const sourceId = exec.agent?.id
    const caller = rt.botOf(rt.selfOf(sourceId))
    if (caller === undefined || !rt.isBotSession(sourceId) || !rt.isMain(caller.id)) {
      throw failure('bot/refused', '只有主 Bot 可以暂停或新建其他 Bot 的会话。')
    }
    const target = rt.findBot(args.bot)
    if (target === undefined) throw failure('bot/not-found', '找不到目标 Bot，请先调用 list_bots。')
    const sessionId = rt.chatOf(target.id)
    const signal = AbortSignal.any([shutdown.signal, ...(exec.signal ? [exec.signal] : [])])
    const check = () => {
      if (signal.aborted) throw failure('bot/refused', '管理请求已取消或插件已卸载。')
      const readonly = rt.readOnly()
      if (readonly !== undefined) throw failure('bot/read-only', readonly)
      // 身份只从宿主的会话所有权索引读取，不接受参数自报主角色；异步步骤反复验权。
      if (rt.botOf(caller.id) !== caller || rt.selfOf(sourceId) !== caller.id || !rt.isBotSession(sourceId) || !rt.isMain(caller.id)) {
        throw failure('bot/refused', '调用方已不是主 Bot，操作已停止。')
      }
      if (rt.botOf(target.id) !== target || rt.chatOf(target.id) !== sessionId) throw failure('bot/stale', '目标会话已变化，请重新暂停并取得回执。')
      if (target.id === caller.id || rt.isMain(target.id) || target.private === true) {
        throw failure('bot/refused', '此工具不能操作自己、其他主 Bot 或私有 Bot。')
      }
      if (typeof sessionId !== 'string' || !sessionId || rt.selfOf(sessionId) !== target.id
        || rt.groupOwners?.has(sessionId) || rt.taskOwners?.has(sessionId)) {
        throw failure('bot/refused', '此工具只操作目标 Bot 的当前私聊，不操作群会话或后台任务。')
      }
    }
    check()
    return { caller, sourceId, target, sessionId, signal, check }
  }

  async function operate(context, action) {
    const { target, sessionId, check } = context
    check()
    if (operations.has(target.id) || rt.isSwitchingPart(sessionId) || rt.isHandingOff?.(sessionId)
      || rt.state.switching[sessionId] !== undefined || unfinishedPrivateSwitch(target)) {
      throw failure('bot/busy', '目标正在暂停、交接或换会话，请勿重复操作。')
    }
    const operation = { sessionId, invalidated: false }
    operations.set(target.id, operation)
    const current = () => {
      check()
      if (operation.invalidated) throw failure('bot/stale', '目标已收到新输入或开始新轮次，请重新核对后暂停。')
      // 当前切换自己的标记合法；同一前台线程的旧交接仍未完成时不能再套一层切换。
      if (unfinishedPrivateSwitch(target, sessionId)) throw failure('bot/busy', '目标旧私聊的交接尚未完成，请先恢复交接。')
    }
    try { return await action(current) } finally { if (operations.get(target.id) === operation) operations.delete(target.id) }
  }

  rt.addTeamTool(defineTool({
    name: 'pause_bot',
    description: '仅主 Bot 可用。结束目标普通、非私有 Bot 当前私聊的模型轮次，并等待宿主确认停下。不是可续接原思维链的挂起，不停止群会话或后台任务，不额外发送解释消息。默认遇到排队输入就拒绝；只有明确传 discard_queued=true 才允许取消队列。回执报告实际丢弃数量；new_session_ready=true 时返回 10 分钟有效的 pause_id，供 new_bot_session 使用。',
    parameters: { bot: BOT, reason: REASON, discard_queued: { type: 'boolean', description: '默认 false。只有明确允许丢弃尚未执行的排队请求时才传 true；这些请求不会自动重发' } },
    output,
    async execute(args, exec) {
      validate(args, ['bot', 'reason', 'discard_queued'])
      if (args.discard_queued !== undefined && typeof args.discard_queued !== 'boolean') throw failure('bot/invalid', 'discard_queued 必须是布尔值。')
      const context = await contextFor(args, exec)
      return operate(context, async current => {
        const { target, sessionId, caller, sourceId, signal } = context
        const agent = await rt.resolveAgent(sessionId)
        current()
        if (agent?.id !== sessionId || typeof agent.cancel !== 'function' || typeof agent.whenIdle !== 'function'
          || !Array.isArray(agent.inbox?.nextStep) || !Array.isArray(agent.inbox?.nextTurn)) {
          throw failure('bot/unavailable', '当前宿主不支持安全暂停模型。')
        }
        const before = queued(agent)
        if (before.length > 0 && args.discard_queued !== true) throw failure('bot/busy', '目标有排队输入，未暂停也未丢弃；只有明确允许时才传 discard_queued=true。')
        paused.delete(target.id)
        void rt.extraPauseGoal?.(target.id, '主 Bot 已暂停当前私聊，请核对后手动恢复目标。')
        const live = rt.live.get(sessionId)
        if (agent.status !== 'idle' || live?.turn !== undefined || live?.pending !== undefined || before.length > 0) {
          // 检查队列后在同一同步链调用 cancel，不在其间让另一条输入先进入队列。
          const ending = agent.cancel({ kind: 'hook', reason: 'ds-bot/paused-by-main' })
          await waitForIdle(Promise.resolve(ending).then(() => agent.whenIdle()), signal)
          current()
        }
        if (agent.status !== 'idle' || rt.live.get(sessionId)?.turn !== undefined) throw failure('bot/busy', '宿主尚未确认当前轮次停止，不能返回暂停成功。')
        const after = queued(agent)
        const retained = new Set(after.map(message => message.id))
        const discarded = new Set(before.filter(message => !retained.has(message.id)).map(message => message.id)).size
        let reason
        try { checkIdle(rt, agent) } catch (error) { if (error.code !== 'bot/busy') throw error; reason = error.message }
        if (reason === undefined && (typeof agent.runMaintenance !== 'function' || typeof rt.extraStartFreshPart !== 'function')) reason = '当前宿主不支持安全新建会话。'
        current()
        const ready = reason === undefined
        const receipt = ready ? { id: randomUUID(), callerId: caller.id, sourceId, sessionId, settings: settingsKey(target), createdAt: Date.now() } : null
        if (receipt !== null) paused.set(target.id, receipt)
        return JSON.stringify({ bot: target.name, bot_id: target.id, session_id: sessionId, paused: true,
          discarded_count: discarded, queued_remaining: after.length, new_session_ready: ready,
          ...(receipt === null ? { reason } : { pause_id: receipt.id }),
          note: '当前轮次已结束，不代表原任务完成；已丢弃的请求不会自动重发。' })
      })
    },
  }))

  rt.addTeamTool(defineTool({
    name: 'new_bot_session',
    description: '仅主 Bot 可用。用同一调用会话中 pause_bot 成功返回的 pause_id，为目标普通、非私有 Bot 新建干净私聊。保留 Bot 身份、长期记忆、设置、模型、权限、工作目录和旧历史，不复制旧上下文。收到新输入、会话或设置变化、回执过期均拒绝；不清除故障标记，不自动重发任务，也不代表故障已解决。',
    parameters: { bot: BOT, pause_id: { type: 'string', required: true, description: 'pause_bot 在 new_session_ready=true 时返回的 pause_id，按原值传入；不能猜测或复用其他主 Bot 的回执' }, reason: REASON },
    output,
    async execute(args, exec) {
      validate(args, ['bot', 'pause_id', 'reason'])
      if (typeof args.pause_id !== 'string' || !args.pause_id || args.pause_id.length > 200) throw failure('bot/invalid', '请先调用 pause_bot 并传入返回的 pause_id。')
      const context = await contextFor(args, exec)
      const { target, sessionId, caller, sourceId } = context
      const receipt = paused.get(target.id)
      const checkReceipt = () => {
        if (receipt === undefined || paused.get(target.id) !== receipt || receipt.id !== args.pause_id || receipt.sessionId !== sessionId
          || Date.now() - receipt.createdAt > RECEIPT_TTL_MS || receipt.settings !== settingsKey(target)) {
          throw failure('bot/stale', '暂停回执已失效，请重新核对目标并调用 pause_bot。')
        }
        if (receipt.callerId !== caller.id || receipt.sourceId !== sourceId) throw failure('bot/refused', '暂停回执只能由取得它的主 Bot 调用会话使用。')
      }
      checkReceipt()
      return operate(context, async current => {
        const check = () => { current(); checkReceipt() }
        check()
        if (typeof rt.extraNewSession !== 'function') throw failure('bot/unavailable', '当前服务器尚未提供安全新建会话。')
        // 不绕过现有空闲检查与 parts 的交接锁；提交前继续校验主角色和暂停回执。
        const result = await rt.extraNewSession({ botId: target.id, sessionId }, check)
        if (result?.botId !== target.id || typeof result.sessionId !== 'string' || !result.sessionId || result.sessionId === sessionId) {
          throw failure('bot/unavailable', '未确认会话已经切换，请查看目标当前状态，不要盲目重试。')
        }
        if (paused.get(target.id) === receipt) paused.delete(target.id)
        const pending = rt.state.switching[sessionId] !== undefined
        return JSON.stringify({ bot: target.name, bot_id: target.id, previous_session_id: sessionId, session_id: result.sessionId,
          session_changed: true, handoff_pending: pending, recovery_verified: false,
          note: pending ? '会话已替换但交接尚未完成；先查看恢复状态，不要重复派发旧任务。'
            : '仅上下文已替换。按需用 message_bot 提供完整任务，收到真实结果后再确认故障恢复；不要自动重放非幂等操作。' })
      })
    },
  }))
}
