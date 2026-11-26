import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/extras/private-goal.js'
import { install as installSettings } from '../src/host/extras/write-settings.js'
import { fakeContext } from './fake-ctx.js'

function setup(t, saved) {
  const ctx = fakeContext()
  const bot = { id: 'b', name: 'Writer', sessionId: 's', extras: { messageMode: 'steer', ...(saved ? { goal: saved } : {}) }, tasks: [] }
  const other = { id: 'other', name: 'Other', sessionId: 'other' }
  const sent = []
  const agents = new Map()
  const tools = []
  const owners = new Map([['s', 'b'], ['other', 'other'], ['group', 'b'], ['task', 'b']])
  let readonly
  let failSave = false
  let beforeResolve = async () => {}
  let approval = false
  let jobs = []
  for (const id of ['s', 'other', 'group', 'task']) {
    const agent = { id, session: { id }, status: 'idle', inbox: { nextStep: [], nextTurn: [] } }
    agent.inbox.remove = messageId => {
      for (const key of ['nextStep', 'nextTurn']) {
        const at = agent.inbox[key].findIndex(message => message.id === messageId)
        if (at >= 0) { agent.inbox[key].splice(at, 1); return true }
      }
      return false
    }
    agent.followup = message => { sent.push({ id, message }); agent.inbox.nextTurn.push(message) }
    agents.set(id, agent)
  }
  ctx.sessions = { flush: async () => {} }
  const rt = {
    ctx, state: { bots: { b: bot, other }, questions: {}, views: {}, works: {}, switching: {} },
    live: new Map(), groupOwners: new Map([['group', { botId: 'b' }]]), taskOwners: new Map([['task', { botId: 'b' }]]),
    load: async () => {}, save: async () => { if (failSave) throw new Error('磁盘写入失败') }, readOnly: () => readonly,
    botOf: id => rt.state.bots[id], selfOf: id => owners.get(id), chatOf: id => rt.state.bots[id]?.sessionId,
    resolveAgent: async id => { await beforeResolve(id); return agents.get(id) }, ensureCapabilities: async () => {},
    waitsForApproval: () => approval, runningJobs: () => jobs, hasSubagents: () => false,
    isSwitchingPart: () => false, isHandingOff: () => false, warn: () => {}, addTeamTool: tool => tools.push(tool),
  }
  rt.extraView = () => rt.state.extras
  installSettings(rt)
  install(rt)
  t.after(() => ctx.dispose())
  const goal = () => rt.extraGoalView(bot)
  const control = (action, patch = {}, authorize) => rt.extraGoalControl({ botId: bot.id, sessionId: bot.sessionId, action,
    ...(goal() ? { goalId: goal().id, revision: goal().revision } : {}), ...patch }, authorize)
  const start = () => control('start', { objective: '完成报告并核对引用', acceptance: '报告已保存，所有引用可追溯' })
  const update = (action, patch = {}, id = bot.sessionId) => tools[0].execute({ action,
    ...(action === 'show' ? {} : { goal_id: goal()?.id, revision: goal()?.revision }), ...patch }, { agent: agents.get(id) ?? { id } })
  const event = (id, type, data = {}) => { for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id }, { type, data }) }
  let turn = 0
  const begin = () => {
    const agent = agents.get(bot.sessionId)
    agent.inbox.nextTurn.length = 0; agent.status = 'running'
    rt.live.set(bot.sessionId, { turn: ++turn }); event(bot.sessionId, 'turn/start', { turn })
  }
  const end = async (kind = 'completed', toolCount = 0) => {
    agents.get(bot.sessionId).status = 'idle'; rt.live.delete(bot.sessionId)
    rt.extraGoalTurnEnded(bot.sessionId, { watched: true, turn, reason: { kind }, toolCount, retry: false })
    event(bot.sessionId, 'turn/end', { reason: { kind } })
    await Promise.resolve()
    await rt.extraGoalTick()
  }
  return { rt, ctx, bot, sent, agents, owners, goal, control, start, update, event, begin, end,
    readonly: value => { readonly = value }, failSave: value => { failSave = value }, resolve: action => { beforeResolve = action },
    approval: value => { approval = value }, jobs: value => { jobs = value } }
}

test('目标只允许显式或继承的 steer，queue 覆盖全局 steer，DSH 默认不推定为 steer', async t => {
  for (const mode of [undefined, null, 'inherit', 'queue']) {
    const s = setup(t); s.bot.extras.messageMode = mode
    await assert.rejects(s.start(), { code: 'bot/refused' })
    assert.equal(s.goal(), null)
    await s.rt.extraGoalTick(); assert.equal(s.sent.length, 0)
  }
  const s = setup(t); s.bot.extras.messageMode = null
  s.rt.state.extras = { defaults: { messageMode: 'steer' } }
  await s.start(); await s.rt.extraGoalTick(); assert.equal(s.sent.length, 1)
  await s.control('pause'); s.bot.extras.messageMode = 'queue'
  await assert.rejects(s.control('resume'), { code: 'bot/refused' })
  assert.equal(s.goal().status, 'paused')
})

test('切到 queue 立即暂停并清除目标消息，切回 steer 不自行恢复', async t => {
  const s = setup(t); await s.start(); await s.rt.extraGoalTick()
  const old = s.sent[0].message
  const user = { id: 'user', source: { kind: 'user' } }
  s.agents.get('s').inbox.nextTurn.push(user)
  await s.rt.extraSettings('extra-bot-set', { id: 'b', messageMode: 'queue' })
  assert.equal(s.goal().status, 'paused'); assert.deepEqual(s.agents.get('s').inbox.nextTurn, [user])
  assert.equal(s.rt.extraGoalRejectStep({ agent: s.agents.get('s'), messages: [old] }), true)
  await s.rt.extraSettings('extra-bot-set', { id: 'b', messageMode: 'steer' })
  await s.rt.extraGoalTick(); assert.equal(s.goal().status, 'paused'); assert.equal(s.sent.length, 1)
})

test('基础设置离开 steer 只暂停跟随者，Bot 显式 steer 继续可用', async t => {
  const inherited = setup(t); inherited.bot.extras.messageMode = null
  await inherited.rt.extraSettings('extra-defaults-set', { messageMode: 'steer' })
  await inherited.start()
  await inherited.rt.extraSettings('extra-defaults-set', { messageMode: 'queue' })
  assert.equal(inherited.goal().status, 'paused')
  const explicit = setup(t); await explicit.start()
  await explicit.rt.extraSettings('extra-defaults-set', { messageMode: 'queue' })
  assert.equal(explicit.goal().status, 'active')
  await explicit.rt.extraGoalTick(); assert.equal(explicit.sent.length, 1)
})

test('解析 Agent 期间切换模式阻止迟到续跑，落盘失败仍保持冻结', async t => {
  const s = setup(t); await s.start()
  let release, entered
  const inside = new Promise(resolve => { entered = resolve })
  const wait = new Promise(resolve => { release = resolve })
  s.resolve(async () => { entered(); await wait })
  const tick = s.rt.extraGoalTick(); await inside
  const change = s.rt.extraSettings('extra-bot-set', { id: 'b', messageMode: 'queue' })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  release(); await tick; await change
  assert.equal(s.sent.length, 0); assert.equal(s.goal().status, 'paused')
  const failed = setup(t); await failed.start(); failed.failSave(true)
  await assert.rejects(failed.rt.extraSettings('extra-bot-set', { id: 'b', messageMode: 'queue' }), /磁盘写入失败/)
  await failed.rt.extraGoalTick(); assert.equal(failed.sent.length, 0)
})

test('基础方式切换等待保存期间，其他跟随 Bot 不能并发启动新目标', async t => {
  const s = setup(t); s.bot.extras.messageMode = null
  s.rt.state.extras = { defaults: { messageMode: 'steer' } }
  await s.start()
  let release, entered
  const inside = new Promise(resolve => { entered = resolve })
  const wait = new Promise(resolve => { release = resolve })
  s.rt.save = async () => { entered(); await wait }
  const change = s.rt.extraSettings('extra-defaults-set', { messageMode: 'queue' })
  await inside
  const rejected = assert.rejects(s.rt.extraGoalControl({ botId: 'other', sessionId: 'other', action: 'start', objective: '整理文档', acceptance: '文档可核查' }), { code: 'bot/refused' })
  release(); await change; await rejected
  await s.rt.extraSettings('extra-defaults-set', { messageMode: 'steer' })
  assert.equal(s.rt.extraGoalView(s.rt.botOf('other')), null)
  assert.equal(s.goal().status, 'paused')
})

test('运行时发现非 steer 的遗留 active 目标会暂停，不写进展或投递续跑', async t => {
  const s = setup(t); await s.start(); s.bot.extras.messageMode = 'queue'
  assert.equal(s.goal().status, 'paused')
  await assert.rejects(s.update('progress', { progress: '进展', evidence: '证据' }), { code: 'bot/refused' })
  await s.rt.extraGoalTick()
  assert.equal(s.bot.extras.goal.status, 'paused'); assert.equal(s.sent.length, 0)
})

test('普通私聊不自动启动目标；显式启动后部分汇报结束会继续而不标记完成', async t => {
  const s = setup(t)
  await s.rt.extraGoalTick(); assert.equal(s.sent.length, 0)
  await s.start(); await s.rt.extraGoalTick()
  assert.equal(s.sent.length, 1); assert.equal(s.goal().status, 'active')
  assert.match(s.rt.extraGoalPrompt('s'), /完成报告并核对引用/)
  s.begin(); await s.end('completed', 1)
  assert.equal(s.sent.length, 2); assert.equal(s.goal().status, 'active')
  await s.rt.extraGoalTick(); assert.equal(s.sent.length, 2)
})

test('完成必须提供证据；完成后的轮次结束不续跑', async t => {
  const s = setup(t); await s.start(); await s.rt.extraGoalTick(); s.begin()
  await assert.rejects(s.update('complete', { progress: '已完成', evidence: '' }), { code: 'bot/invalid' })
  await s.update('complete', { progress: '报告和引用核对完成', evidence: '报告.md 与引用清单均已核对' })
  await s.end('completed', 2)
  assert.equal(s.goal().status, 'complete'); assert.equal(s.sent.length, 1)
})

test('只有当前私聊可以操作自己的目标，群、后台、旧段和其他 Bot 不可越权', async t => {
  const s = setup(t); await s.start()
  for (const id of ['group', 'task', 'past', 'unknown']) await assert.rejects(s.update('show', {}, id), { code: 'bot/refused' })
  assert.equal(await s.update('show', {}, 'other'), 'null')
  await assert.rejects(s.update('complete', { progress: '完成', evidence: '证据' }, 'other'), { code: 'bot/refused' })
  await assert.rejects(s.update('progress', { goal_id: 'other-goal', progress: '进展', evidence: '证据' }), { code: 'bot/stale' })
  assert.equal(s.rt.extraGoalPrompt('group'), ''); assert.equal(s.rt.extraGoalPrompt('task'), '')
})

test('只读、失效授权、旧会话、非法字段或过期 revision 不修改目标', async t => {
  const s = setup(t); await s.start()
  const before = s.goal()
  s.readonly('只读')
  await assert.rejects(s.control('revise', { objective: '新目标', acceptance: '新验收' }), { code: 'bot/read-only' })
  s.readonly(undefined)
  await assert.rejects(s.control('pause', {}, () => { throw Object.assign(new Error('拒绝'), { code: 'bot/refused' }) }), { code: 'bot/refused' })
  await assert.rejects(s.control('pause', { sessionId: 'old' }), { code: 'bot/stale' })
  await assert.rejects(s.control('revise', { revision: 0, objective: '新目标', acceptance: '新验收' }), { code: 'bot/stale' })
  await assert.rejects(s.control('start', { permission: 'full' }), { code: 'bot/invalid' })
  assert.deepEqual(s.goal(), before)
})

test('暂停只移除自己的待执行续跑消息，用户输入保留且必须显式恢复', async t => {
  const s = setup(t); await s.start(); await s.rt.extraGoalTick()
  const agent = s.agents.get('s')
  const user = { id: 'user', source: { kind: 'user' }, content: [] }
  agent.inbox.nextTurn.push(user)
  await s.control('pause')
  assert.deepEqual(agent.inbox.nextTurn, [user]); assert.equal(s.goal().status, 'paused')
  await s.rt.extraGoalTick(); assert.equal(s.sent.length, 1)
  agent.inbox.nextTurn.length = 0
  await s.control('resume'); await s.rt.extraGoalTick()
  assert.equal(s.sent.length, 2); assert.equal(s.goal().status, 'active')
})

test('解析 Agent 期间到达暂停，迟到发送不能重新启动目标', async t => {
  const s = setup(t); await s.start()
  let release, entered
  const inside = new Promise(resolve => { entered = resolve })
  const wait = new Promise(resolve => { release = resolve })
  s.resolve(async () => { entered(); await wait })
  const tick = s.rt.extraGoalTick(); await inside
  const pause = s.control('pause')
  await Promise.resolve(); await Promise.resolve()
  release(); await tick; await pause
  assert.equal(s.sent.length, 0); assert.equal(s.goal().status, 'paused')
})

test('审批、问题卡片、后台工作、队列和协作未结束时不增加自动轮次', async t => {
  for (const kind of ['approval', 'question', 'view', 'task', 'job', 'queued', 'work', 'switch']) await t.test(kind, async sub => {
    const s = setup(sub); await s.start()
    if (kind === 'approval') s.approval(true)
    if (kind === 'question') s.rt.state.questions.s = { id: 'q' }
    if (kind === 'view') s.rt.state.views.s = { id: 'v' }
    if (kind === 'task') s.bot.tasks.push({ status: 'running' })
    if (kind === 'job') s.jobs([{}])
    if (kind === 'queued') s.agents.get('s').inbox.nextTurn.push({ id: 'queued' })
    if (kind === 'work') s.rt.state.works.w = { from: 'b', to: 'other' }
    if (kind === 'switch') s.rt.state.switching.old = { botId: 'b' }
    await s.rt.extraGoalTick(); assert.equal(s.sent.length, 0)
    s.approval(false); s.jobs([]); s.rt.state.questions = {}; s.rt.state.views = {}; s.bot.tasks = []; s.rt.state.works = {}; s.rt.state.switching = {}
    s.agents.get('s').inbox.nextTurn.length = 0
    await s.rt.extraGoalTick(); assert.equal(s.sent.length, 1)
  })
})

test('模型错误、宿主阻塞和用户取消均停止自动推进，不伪造完成', async t => {
  for (const kind of ['error', 'blocked', 'aborted']) await t.test(kind, async sub => {
    const s = setup(sub); await s.start(); await s.rt.extraGoalTick(); s.begin(); await s.end(kind)
    assert.equal(s.sent.length, 1)
    assert.equal(s.goal().status, kind === 'aborted' ? 'paused' : 'blocked')
  })
})

test('模型明确说明阻塞后保留原因，不能自己恢复或继续推进', async t => {
  const s = setup(t); await s.start(); await s.rt.extraGoalTick(); s.begin()
  await s.update('block', { reason: '缺少用户提供的引用文件' }); await s.end()
  assert.equal(s.goal().status, 'blocked'); assert.match(s.goal().reason, /引用文件/)
  await assert.rejects(s.update('progress', { progress: '擅自继续', evidence: '无' }), { code: 'bot/refused' })
  assert.equal(s.sent.length, 1)
})

test('连续三轮只有汇报会阻塞，反复读取目标不算进展', async t => {
  const s = setup(t); await s.start(); await s.rt.extraGoalTick()
  for (let index = 0; index < 3; index += 1) {
    s.begin(); s.event('s', 'tool/call', { name: 'bot_goal' }); await s.update('show'); await s.end('completed', 1)
  }
  assert.equal(s.sent.length, 3); assert.equal(s.goal().status, 'blocked'); assert.match(s.goal().reason, /连续三轮/)
})

test('正常自动换段保留目标和进展，仅在新段空闲且交接结束后继续', async t => {
  const s = setup(t); await s.start(); await s.rt.extraGoalTick(); s.begin()
  await s.update('progress', { progress: '第一部分已完成', evidence: '第一部分.md' })
  const next = { ...s.agents.get('s'), id: 'next', session: { id: 'next' }, status: 'idle', inbox: { nextStep: [], nextTurn: [] } }
  next.followup = message => { s.sent.push({ id: 'next', message }); next.inbox.nextTurn.push(message) }
  s.agents.set('next', next); s.owners.set('next', 'b'); s.bot.sessionId = 'next'
  s.rt.state.switching.s = { botId: 'b' }
  await s.rt.extraGoalTick(); assert.equal(s.sent.length, 1)
  delete s.rt.state.switching.s
  await s.rt.extraGoalTick()
  assert.equal(s.sent.length, 2); assert.equal(s.sent[1].id, 'next'); assert.match(s.rt.extraGoalPrompt('next'), /第一部分已完成/)
  assert.equal(s.rt.extraGoalPrompt('s'), '')
})

test('重启后保留目标但暂停，不从不确定的执行点自动重放', async t => {
  const s = setup(t); await s.start()
  const saved = JSON.parse(JSON.stringify(s.bot.extras.goal))
  const restored = setup(t, saved)
  assert.equal(restored.goal().status, 'paused')
  await restored.rt.extraGoalTick()
  assert.equal(restored.goal().status, 'paused'); assert.equal(restored.sent.length, 0)
  await restored.control('resume'); await restored.rt.extraGoalTick(); assert.equal(restored.sent.length, 1)
})

test('保存失败不发消息，停止操作仍能冻结内存里的续跑', async t => {
  const s = setup(t); s.failSave(true)
  await assert.rejects(s.start(), /磁盘写入失败/)
  assert.equal(s.goal(), null); assert.equal(s.sent.length, 0)
  s.failSave(false); await s.start(); s.failSave(true)
  assert.equal(await s.rt.extraPauseGoal('b'), true)
  await s.rt.extraGoalTick(); assert.equal(s.sent.length, 0); assert.equal(s.goal().status, 'blocked')
})

test('暂停再恢复后旧续跑消息仍失效，不会暂停新的执行代次', async t => {
  const s = setup(t); await s.start(); await s.rt.extraGoalTick()
  const old = s.sent[0].message
  await s.control('pause'); await s.control('resume'); await s.rt.extraGoalTick()
  const fresh = s.sent[1].message
  assert.notEqual(old.source.runId, fresh.source.runId)
  s.begin()
  assert.equal(s.rt.extraGoalRejectStep({ agent: s.agents.get('s'), messages: [old] }), true)
  await s.end('aborted')
  assert.equal(s.goal().status, 'active')
  assert.equal(s.rt.extraGoalRejectStep({ agent: s.agents.get('s'), messages: [fresh] }), false)
})

test('宿主在两轮之间停止会话，同样暂停目标，不再启动下一轮', async t => {
  const s = setup(t); await s.start()
  s.ctx.emit('workspace/session-stop', { sessionId: 's' })
  await s.rt.extraGoalTick()
  assert.equal(s.goal().status, 'paused'); assert.equal(s.sent.length, 0)
})

test('等待群内协作不阻止独立私聊目标，私聊协作仍会等待', async t => {
  const s = setup(t); await s.start()
  s.rt.state.works.groupWork = { from: 'b', to: 'other', fromRoom: 'r1' }
  await s.rt.extraGoalTick()
  assert.equal(s.sent.length, 1)
})

test('不接受重复的旧启动请求，也不能在未完成的审批或队列前标记完成', async t => {
  const s = setup(t)
  const originalStart = { botId: 'b', sessionId: 's', action: 'start', objective: '完成报告', acceptance: '报告已核验' }
  await s.rt.extraGoalControl(originalStart); await s.rt.extraGoalTick(); s.begin()
  s.approval(true)
  await assert.rejects(s.update('complete', { progress: '完成', evidence: '报告.md' }), { code: 'bot/busy' })
  s.approval(false); s.agents.get('s').inbox.nextTurn.push({ id: 'user', source: { kind: 'user' } })
  await assert.rejects(s.update('complete', { progress: '完成', evidence: '报告.md' }), { code: 'bot/busy' })
  s.agents.get('s').inbox.nextTurn.length = 0
  await s.update('complete', { progress: '完成', evidence: '报告.md' })
  await assert.rejects(s.rt.extraGoalControl(originalStart), { code: 'bot/stale' })
  assert.equal(s.goal().status, 'complete')
})

test('已记录进展让纯文字写作继续，读取目标和重复相同进展不清空防空转计数', async t => {
  const s = setup(t); await s.start(); await s.rt.extraGoalTick()
  for (let index = 0; index < 2; index += 1) { s.begin(); await s.end('completed', 0) }
  s.begin(); s.event('s', 'tool/ptc-dispatch-start', { name: 'bot_goal' })
  await s.update('progress', { progress: '完成第一部分', evidence: '已交付第一部分正文' })
  await s.end('completed', 1)
  assert.equal(s.goal().emptyTurns, 0); assert.equal(s.goal().status, 'active')
  for (let index = 0; index < 3; index += 1) {
    s.begin(); s.event('s', 'tool/call', { name: 'bot_goal' })
    await s.update('progress', { progress: '完成第一部分', evidence: '已交付第一部分正文' })
    await s.end('completed', 1)
  }
  assert.equal(s.goal().status, 'blocked')
})

test('旧自动输入被拒绝，但同批的新用户输入不会被丢弃', async t => {
  const s = setup(t); await s.start(); await s.rt.extraGoalTick()
  const message = s.sent[0].message
  await s.control('stop')
  assert.equal(s.rt.extraGoalRejectStep({ agent: s.agents.get('s'), messages: [message] }), true)
  assert.equal(s.rt.extraGoalRejectStep({ agent: s.agents.get('s'), messages: [message, { source: { kind: 'user' } }] }), false)
})
