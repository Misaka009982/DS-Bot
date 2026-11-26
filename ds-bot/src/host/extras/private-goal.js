import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SOURCE_KIND } from '../constants.js'
import { output } from '../tools.js'
import { messageMode } from './settings.js'

const failure = (code, message) => Object.assign(new Error(message), { code })
const FINAL = new Set(['complete', 'stopped'])
const ROLE = 'private-goal'
const MODE_REASON = '私聊目标仅支持 steer；请设为 steer 后手动恢复目标。'
const queued = agent => [...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])]
const isWake = message => message?.source?.kind === SOURCE_KIND && message.source.role === ROLE
const text = (value, limit, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw failure('bot/invalid', `${label}不能为空，且不能超过 ${limit} 字符。`)
  return value.trim()
}
const fields = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw failure('bot/invalid', '目标参数包含未知字段。')
}
const goalOf = bot => bot?.extras?.goal?.schema === 1 ? bot.extras.goal : undefined

export function install(rt) {
  const activation = randomUUID()
  const pending = new Set()
  const held = new Set()
  const sessions = new Map()
  const ended = new Map()
  const turns = new Map()
  const agents = new Map()
  const discarded = new Set()
  let writing = Promise.resolve()
  let stopped = false
  let timer
  const serial = action => {
    const next = writing.then(action)
    writing = next.catch(() => {})
    return next
  }
  const ownBot = id => {
    const bot = rt.botOf(rt.selfOf(id))
    return bot && rt.chatOf(bot.id) === id && !rt.groupOwners.has(id) && !rt.taskOwners.has(id) ? bot : undefined
  }
  const steer = bot => messageMode(bot?.extras, undefined, rt.state.extras?.defaults) === 'steer' && rt.extraGoalModePending?.(bot?.id) !== true
  const active = bot => !stopped && goalOf(bot)?.status === 'active' && goalOf(bot).activation === activation && !held.has(bot.id) && steer(bot)
  const checkWrite = () => {
    if (stopped) throw failure('bot/refused', '插件已卸载。')
    const reason = rt.readOnly()
    if (reason !== undefined) throw failure('bot/read-only', reason)
  }
  const warn = error => rt.warn?.('ds-bot: 私聊目标操作未完成（%s）', error?.code ?? error?.name ?? 'error')
  const schedule = () => {
    if (stopped || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void rt.extraGoalTick().catch(warn).finally(() => {
        if (Object.values(rt.state.bots).some(bot => goalOf(bot)?.status === 'active' && (!held.has(bot.id) || goalOf(bot).activation !== activation))) schedule()
      })
    }, 1000)
    timer.unref?.()
  }
  const save = async (bot, patch) => {
    checkWrite()
    const previous = goalOf(bot)
    const next = { ...previous, ...patch, revision: (previous?.revision ?? 0) + 1, updatedAt: Date.now() }
    bot.extras ??= {}
    bot.extras.goal = next
    try { await rt.save({ required: true }) } catch (error) {
      held.add(bot.id)
      pending.delete(bot.id)
      if (bot.extras?.goal === next) {
        if (previous === undefined) delete bot.extras.goal
        else bot.extras.goal = previous
      }
      throw error
    }
    return next
  }
  const stopAuto = async (bot, status, reason) => {
    held.add(bot.id)
    pending.delete(bot.id)
    const goal = await save(bot, { status, reason })
    const agent = agents.get(rt.chatOf(bot.id)) ?? rt.ctx.get?.('agents')?.get?.(rt.chatOf(bot.id))
    // 仅移除本增补尚未被领取的续跑消息，不丢弃用户输入或其他工作。
    for (const message of queued(agent)) if (isWake(message) && message.source.goalId === goal.id) agent.inbox.remove?.(message.id)
    return goal
  }
  const busy = (bot, agent) => {
    const id = rt.chatOf(bot.id)
    const live = rt.live.get(id)
    if (agent?.status !== 'idle' || live?.turn !== undefined || live?.pending !== undefined || live?.retrying === true || queued(agent).length > 0) return true
    if (rt.isSwitchingPart?.(id) || rt.isHandingOff?.(id) || Object.values(rt.state.switching ?? {}).some(value => value?.botId === bot.id && value.roomId === undefined)) return true
    if (rt.waitsForApproval?.(id) || rt.hasSubagents?.(id) || (rt.runningJobs?.(id)?.length ?? 0) > 0) return true
    if (rt.state.questions[id] || rt.state.views[id]) return true
    if ((bot.tasks ?? []).some(task => task.roomId === undefined && ['running', 'waiting_work', 'waiting_approval'].includes(task.status))) return true
    return Object.values(rt.state.works ?? {}).some(work => work?.from === bot.id && work.fromRoom === undefined)
  }
  const goalText = goal => [
    `私聊目标：${goal.objective}`, `验收标准：${goal.acceptance}`,
    `目标编号：${goal.id}；revision：${goal.revision}；状态：${goal.status}`,
    goal.progress ? `最近进展：${goal.progress}` : '', goal.evidence ? `已记录证据：${goal.evidence}` : '', goal.reason ? `停止原因：${goal.reason}` : '',
  ].filter(Boolean).join('\n')
  rt.extraGoalPrompt = id => {
    const bot = ownBot(id)
    const goal = goalOf(bot)
    if (!goal) return ''
    if (!active(bot)) return `私聊目标当前不自动推进。${goalText(goal)}\n不要因旧的目标续跑消息继续工作；用户的新消息照常处理，暂停／阻塞目标由用户在面板恢复。`
    return `${goalText(goal)}\n这是用户显式启动的私聊目标。按验收标准持续推进，阶段汇报后继续执行，不能把计划、承诺或部分结果当作完成。使用 bot_goal show 读取最新 revision；progress 记录实际进展和证据，全部验收完成后才调用 complete。需要用户决策或外部条件时调用 block 并说明原因，不要反复请求“是否继续”。用户中途纠偏优先；目标不授予额外权限。后台任务仍按原规则运行，交回结果后由你核验并继续目标。`
  }
  rt.extraGoalBlocksResume = record => record.roomId === undefined && record.trigger?.role === ROLE
  rt.extraGoalView = bot => {
    const goal = goalOf(bot)
    if (!goal) return null
    const { activation: _activation, runId: _runId, ...view } = goal
    if (goal.status === 'active' && !steer(bot)) return { ...view, status: 'paused', reason: MODE_REASON }
    if (goal.status === 'active' && goal.activation !== activation) return { ...view, status: 'paused', reason: '宿主已重启，请确认现场后恢复目标。' }
    if (goal.status === 'active' && held.has(bot.id)) return { ...view, status: 'blocked', reason: '目标已停止自动推进，请核对状态后恢复。' }
    return view
  }
  rt.extraPauseGoal = (botId, reason = '用户已停止当前工作，请手动恢复目标。') => {
    const bot = rt.botOf(botId)
    if (goalOf(bot)?.status !== 'active') return Promise.resolve(false)
    held.add(botId)
    pending.delete(botId)
    return serial(async () => {
      if (rt.botOf(botId) !== bot || goalOf(bot)?.status !== 'active') return false
      await stopAuto(bot, 'paused', reason)
      return true
    }).catch(error => { warn(error); return true })
  }
  rt.extraGoalControl = async (body, authorize = () => {}) => {
    fields(body, ['botId', 'sessionId', 'action', 'goalId', 'revision', 'objective', 'acceptance'])
    await rt.load()
    const bot = typeof body.botId === 'string' ? rt.botOf(body.botId) : undefined
    const check = () => {
      authorize(); checkWrite()
      if (!bot || rt.botOf(bot.id) !== bot) throw failure('bot/not-found', '找不到这个 Bot。')
      if (body.sessionId !== rt.chatOf(bot.id)) throw failure('bot/stale', '当前私聊已换段，请刷新后重试。')
    }
    check()
    const action = body.action
    if (!['start', 'pause', 'resume', 'stop', 'revise'].includes(action)) throw failure('bot/invalid', '请选择有效的目标操作。')
    const goal = goalOf(bot)
    if (action !== 'start' && (!goal || body.goalId !== goal.id)) throw failure('bot/stale', '目标已变化，请刷新后重试。')
    // 暂停意图先阻止正在等待异步解析的发送；不受轮次结算 revision 变化影响。
    if (action === 'pause' || action === 'stop') { held.add(bot.id); pending.delete(bot.id) }
    return serial(async () => {
      check()
      if (['start', 'resume'].includes(action) && !steer(bot)) throw failure('bot/refused', MODE_REASON)
      const current = goalOf(bot)
      if (action === 'start') {
        if (current && !FINAL.has(current.status)) throw failure('bot/busy', '已有目标，请先终止或完成它。')
        if (current ? body.goalId !== current.id || body.revision !== current.revision : body.goalId !== undefined || body.revision !== undefined) {
          throw failure('bot/stale', '目标已变化，请刷新后再启动新目标。')
        }
        const objective = text(body.objective, 4000, '目标')
        const acceptance = text(body.acceptance, 4000, '验收标准')
        await save(bot, { schema: 1, id: randomUUID(), activation, runId: randomUUID(), objective, acceptance, status: 'active', progress: '', evidence: '', reason: '', rounds: 0, emptyTurns: 0 })
        held.delete(bot.id); pending.add(bot.id); sessions.set(bot.id, body.sessionId); schedule()
      } else {
        if (!current || current.id !== body.goalId) throw failure('bot/stale', '目标已变化，请刷新后重试。')
        if (FINAL.has(current.status)) throw failure('bot/refused', '这个目标已结束，请创建新目标。')
        if (action === 'pause' || action === 'stop') {
          await stopAuto(bot, action === 'pause' ? 'paused' : 'stopped', action === 'pause' ? '用户暂停了目标。' : '用户终止了目标。')
        } else {
          if (!Number.isSafeInteger(body.revision) || current.revision !== body.revision) throw failure('bot/stale', '目标状态已变化，请刷新后重试。')
          if (action === 'resume') {
            if (!['paused', 'blocked'].includes(rt.extraGoalView(bot).status)) throw failure('bot/refused', '目标已经在推进。')
            await save(bot, { activation, runId: randomUUID(), status: 'active', reason: '', emptyTurns: 0 })
            held.delete(bot.id); pending.add(bot.id); schedule()
          } else {
            await save(bot, { objective: text(body.objective, 4000, '目标'), acceptance: text(body.acceptance, 4000, '验收标准'), emptyTurns: 0 })
            if (active(bot)) { pending.add(bot.id); schedule() }
          }
        }
      }
      return rt.extraGoalView(bot)
    })
  }
  rt.extraGoalTick = () => serial(async () => {
    await rt.load()
    if (stopped || rt.readOnly() !== undefined) return
    for (const bot of Object.values(rt.state.bots)) {
      let goal = goalOf(bot)
      if (goal?.status !== 'active') continue
      if (goal.activation !== activation) { await stopAuto(bot, 'paused', '宿主已重启，请确认现场后恢复目标。'); continue }
      if (!steer(bot)) { await stopAuto(bot, 'paused', MODE_REASON); continue }
      if (!active(bot)) continue
      const id = rt.chatOf(bot.id)
      if (sessions.get(bot.id) !== id) {
        const previous = sessions.get(bot.id)
        agents.delete(previous); ended.delete(previous); turns.delete(previous); discarded.delete(previous)
        sessions.set(bot.id, id); pending.add(bot.id)
      }
      if (!pending.has(bot.id)) continue
      if (bot.blocked) { await stopAuto(bot, 'blocked', '模型或运行环境仍有故障，请修复后恢复目标。'); continue }
      try {
        await rt.ensureCapabilities(id)
        const agent = await rt.resolveAgent(id)
        agents.set(id, agent)
        const current = () => active(bot) && rt.botOf(bot.id) === bot && rt.chatOf(bot.id) === id && goalOf(bot)?.id === goal.id && rt.readOnly() === undefined
        if (!current() || busy(bot, agent)) continue
        if (typeof agent.followup !== 'function' || !Array.isArray(agent.inbox?.nextTurn) || !Array.isArray(agent.inbox?.nextStep)) throw failure('bot/unavailable', '宿主缺少目标续跑接口。')
        goal = await save(bot, { rounds: goal.rounds + 1 })
        if (!current() || busy(bot, agent)) continue
        // 最后一次检查到入队之间无 await；暂停会移除尚未领取的同目标消息。
        agent.followup(createUserMessage({
          source: { kind: SOURCE_KIND, form: 'relay', role: ROLE, goalId: goal.id, activation, runId: goal.runId, senderName: 'DS Bot' },
          content: [{ type: 'text', text: `[私聊目标继续]\n目标编号：${goal.id}。先用 bot_goal show 核对当前目标；只有该编号仍是 active 时才按当前验收标准推进剩余事项。不要按历史目标或重放已执行操作；完成时用 complete 记录证据，有真实阻塞用 block 说明。` }],
        }))
        pending.delete(bot.id)
        await rt.ctx.sessions.flush(agent.session)
      } catch (error) {
        held.add(bot.id); pending.delete(bot.id)
        if (rt.botOf(bot.id) === bot && goalOf(bot)?.status === 'active') await stopAuto(bot, 'blocked', '目标续跑未确认成功，请检查当前聊天后恢复，避免重复执行。').catch(warn)
        warn(error)
      }
    }
  })
  rt.ctx.on('session/event', function privateGoalTurn(session, event) {
    const id = session?.id
    if (event.type === 'turn/end') { turns.delete(id); return }
    const bot = ownBot(id)
    if (!active(bot)) return
    const goal = goalOf(bot)
    if (event.type === 'turn/start') {
      discarded.delete(id)
      turns.set(id, { goalId: goal.id, runId: goal.runId, progress: goal.progress, evidence: goal.evidence, goalCalls: 0 })
    } else if (['tool/call', 'tool/ptc-dispatch-start'].includes(event.type) && event.data?.name === 'bot_goal') {
      const current = turns.get(id)
      if (current) current.goalCalls += 1
    }
  })
  rt.extraGoalTurnEnded = (id, { watched, turn, reason, toolCount, retry }) => {
    const bot = ownBot(id)
    const goal = goalOf(bot)
    const sample = turns.get(id)
    turns.delete(id)
    if (discarded.delete(id) || !bot || !active(bot) || !watched || retry || ended.get(id) === turn) return
    if (sample && (sample.goalId !== goal.id || sample.runId !== goal.runId)) return
    ended.set(id, turn)
    if (['aborted', 'error', 'blocked'].includes(reason?.kind)) { held.add(bot.id); pending.delete(bot.id) }
    queueMicrotask(() => void serial(async () => {
      if (stopped || rt.botOf(bot.id) !== bot || goalOf(bot)?.id !== goal.id || goalOf(bot).runId !== goal.runId || goalOf(bot).status !== 'active') return
      if (reason?.kind === 'aborted') { await stopAuto(bot, 'paused', '当前工作已被停止，请手动恢复目标。'); return }
      if (reason?.kind === 'error' || reason?.kind === 'blocked') { await stopAuto(bot, 'blocked', '当前轮次发生错误或被宿主阻塞，请处理后恢复目标。'); return }
      if (!active(bot)) return
      if (reason?.kind !== 'completed' && reason?.kind !== 'max-tokens') return
      const current = goalOf(bot)
      const changed = sample?.goalId === current.id && (sample.progress !== current.progress || sample.evidence !== current.evidence)
      const emptyTurns = changed || toolCount > (sample?.goalCalls ?? 0) ? 0 : current.emptyTurns + 1
      if (emptyTurns >= 3) { await stopAuto(bot, 'blocked', '连续三轮只有回复、没有工具行动，请检查模型或补充下一步信息。'); return }
      await save(bot, { emptyTurns })
      pending.add(bot.id); schedule()
    }).catch(warn))
  }
  rt.ctx.on('workspace/session-stop', ({ sessionId }) => {
    const bot = ownBot(sessionId)
    if (bot) void rt.extraPauseGoal(bot.id)
  })
  rt.extraGoalRejectStep = ({ agent, messages = [] }) => {
    const wakes = messages.filter(isWake)
    if (wakes.length === 0) return false
    const bot = ownBot(agent?.id)
    const valid = active(bot) && wakes.some(message => message.source.goalId === goalOf(bot).id && message.source.activation === activation && message.source.runId === goalOf(bot).runId)
    // 新用户输入不因同批次里的旧续跑消息而被丢弃。
    if (!valid && wakes.length === messages.length) { discarded.add(agent.id); return true }
    return false
  }
  rt.ctx.effect(() => rt.ctx.systemPrompt.section({ name: 'bot-private-goal', order: 650, interpolate: false, text: context => rt.extraGoalPrompt(context?.agent?.id) }), 'ds-bot: 私聊目标提示')
  rt.ctx.effect(() => {
    schedule()
    return () => { stopped = true; clearTimeout(timer); pending.clear(); held.clear(); sessions.clear(); ended.clear(); turns.clear(); agents.clear(); discarded.clear() }
  }, 'ds-bot: 私聊目标续跑')
  rt.addTeamTool(defineTool({
    name: 'bot_goal',
    description: '读取或更新当前 Bot 私聊中由用户显式启动的持久目标。show 查看最新状态；progress 记录真实进展和证据；complete 仅在全部验收完成后使用，必须提供证据；block 遇到用户决策或外部条件时暂停自动推进并说明原因。不能创建、恢复或替换目标，不能操作群聊、其他 Bot 或后台任务。',
    parameters: {
      action: { type: 'string', required: true, enum: ['show', 'progress', 'complete', 'block'] },
      goal_id: { type: 'string', description: '修改时传入 show 返回的当前目标编号' },
      revision: { type: 'integer', description: '修改时传入 show 返回的 revision' },
      progress: { type: 'string', description: 'progress／complete：已完成的实际工作，最多 2000 字符' },
      evidence: { type: 'string', description: 'progress／complete：可核对的结果、文件或验证证据，最多 4000 字符' },
      reason: { type: 'string', description: 'block：缺少的输入或外部条件，最多 1000 字符' },
    },
    output,
    async execute(args, exec) {
      fields(args, ['action', 'goal_id', 'revision', 'progress', 'evidence', 'reason'])
      await rt.load()
      const id = exec.agent?.id
      const bot = ownBot(id)
      if (!bot) throw failure('bot/refused', '只有当前私聊可以读取或更新自己的目标。')
      if (args.action === 'show') return JSON.stringify(rt.extraGoalView(bot))
      return serial(async () => {
        checkWrite()
        if (exec.signal?.aborted || ownBot(id) !== bot) throw failure('bot/refused', '调用已取消或会话已变化。')
        const goal = goalOf(bot)
        if (!active(bot)) throw failure('bot/refused', '当前目标没有启用自动推进，由用户在面板启动或恢复。')
        if (args.goal_id !== goal.id || args.revision !== goal.revision) throw failure('bot/stale', '目标已变化，请用 show 读取最新状态。')
        if (args.action === 'block') await stopAuto(bot, 'blocked', text(args.reason, 1000, '阻塞原因'))
        else if (args.action === 'progress' || args.action === 'complete') {
          const progress = text(args.progress, 2000, '实际进展')
          const evidence = text(args.evidence, 4000, '验证证据')
          if (args.action === 'complete') {
            if (queued(exec.agent).some(message => !isWake(message)) || rt.state.questions[id] || rt.state.views[id] || rt.waitsForApproval?.(id) || rt.hasSubagents?.(id) || (rt.runningJobs?.(id)?.length ?? 0) > 0
              || (bot.tasks ?? []).some(task => task.roomId === undefined && ['running', 'waiting_work', 'waiting_approval'].includes(task.status))
              || Object.values(rt.state.works ?? {}).some(work => work?.from === bot.id && work.fromRoom === undefined)) throw failure('bot/busy', '仍有待处理问题、审批或工作，不能标记整个目标完成。')
            await save(bot, { status: 'complete', progress, evidence, reason: '' })
            held.add(bot.id); pending.delete(bot.id)
          } else if (goal.progress !== progress || goal.evidence !== evidence) await save(bot, { progress, evidence, emptyTurns: 0 })
        } else throw failure('bot/invalid', '未知的目标操作。')
        return JSON.stringify(rt.extraGoalView(bot))
      })
    },
  }))
}
