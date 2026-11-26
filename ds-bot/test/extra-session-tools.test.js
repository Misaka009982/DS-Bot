import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installBuiltinPacks, BUILTIN_PACKS } from '../src/host/builtin-packs.js'
import { install } from '../src/host/extras/session-tools.js'
import { fakeContext } from './fake-ctx.js'

const gate = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const settle = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve() }

function start(t) {
  const ctx = fakeContext()
  const bots = {
    a: { id: 'a', name: 'Chief', sessionId: 'a' },
    b: { id: 'b', name: 'Writer', sessionId: 'b', instructions: '保留角色' },
    c: { id: 'c', name: 'Other Main', sessionId: 'c' },
    d: { id: 'd', name: 'Private', sessionId: 'd', private: true },
  }
  const owners = new Map(Object.keys(bots).map(id => [id, id]))
  const agents = new Map()
  const canceled = []
  const freshCalls = []
  let readonly
  let beforeResolve = () => {}
  let beforeFresh = () => {}
  const rt = {
    ctx, state: { bots, mainBotIds: ['a', 'c'], questions: {}, views: {}, works: {}, inflight: {}, switching: {} },
    live: new Map(), teamTools: [],
    load: async () => {}, readOnly: () => readonly,
    botOf: id => bots[id], findBot: ref => Object.values(bots).find(bot => bot.name === ref),
    selfOf: id => owners.get(id), isBotSession: id => owners.has(id), isMain: id => rt.state.mainBotIds.includes(id),
    chatOf: id => bots[id]?.sessionId,
    isSwitchingPart: () => false, isHandingOff: () => false, waitsForApproval: () => false, hasSubagents: () => false, runningJobs: () => [],
    addTeamTool: def => { rt.teamTools.push(def) },
    removeTeamTool: name => { rt.teamTools = rt.teamTools.filter(def => def.name !== name) },
    extraStartFreshPart: () => {},
    resolveAgent: async id => { await beforeResolve(id); return agents.get(id) },
    extraNewSession: async (body, authorize) => {
      authorize()
      freshCalls.push({ ...body })
      await beforeFresh(body)
      authorize()
      bots.b.segments = [...(bots.b.segments ?? []), { sessionId: body.sessionId }]
      bots.b.sessionId = 'fresh-b'
      owners.set('fresh-b', 'b')
      return { botId: 'b', sessionId: 'fresh-b' }
    },
  }
  for (const id of Object.keys(bots)) agents.set(id, {
    id, session: { id }, status: 'idle', inbox: { nextStep: [], nextTurn: [] },
    cancel(reason) { canceled.push([id, reason]); this.status = 'idle'; this.inbox.nextStep.length = 0; this.inbox.nextTurn.length = 0; rt.live.delete(id) },
    whenIdle: async () => {}, runMaintenance: async operation => operation(new AbortController().signal),
  })
  installBuiltinPacks(rt)
  install(rt)
  t.after(() => ctx.dispose())
  const call = (name, args, id = 'a', signal) => rt.teamTools.find(def => def.name === name).execute(args, { agent: agents.get(id) ?? { id }, name, signal })
  const pause = (args = {}, id = 'a', signal) => call('pause_bot', { bot: 'Writer', reason: '已确认会话思维链不兼容', ...args }, id, signal).then(JSON.parse)
  const fresh = (receipt, args = {}, id = 'a', signal) => call('new_bot_session', { bot: 'Writer', reason: '修复会话兼容性故障', pause_id: receipt.pause_id, ...args }, id, signal).then(JSON.parse)
  const event = (id, type) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) if (listener.length >= 2) listener({ id }, { type, data: { turn: 2 } })
  }
  return { rt, ctx, bots, agents, canceled, freshCalls, call, pause, fresh, event,
    readonly: value => { readonly = value }, resolve: callback => { beforeResolve = callback }, create: callback => { beforeFresh = callback } }
}

test('新工具登记进现有主 Bot 管理包，普通 Bot 不可见', t => {
  const host = start(t)
  for (const name of ['pause_bot', 'new_bot_session']) {
    assert.ok(BUILTIN_PACKS['team-admin'].tools.includes(name))
    assert.equal(host.rt.teamTools.filter(def => def.name === name).length, 1)
    assert.equal(host.rt.hiddenBuiltinTools('b').has(name), true)
    assert.equal(host.rt.hiddenBuiltinTools('a').has(name), false)
  }
})
test('主 Bot 暂停空闲普通 Bot 后用回执新建，旧回执不能再次新建', async t => {
  const host = start(t)
  const receipt = await host.pause()
  assert.equal(receipt.paused, true); assert.equal(receipt.new_session_ready, true)
  assert.equal(receipt.session_id, 'b'); assert.equal(receipt.discarded_count, 0)
  assert.equal(typeof receipt.pause_id, 'string')
  assert.deepEqual(host.canceled, [])
  const result = await host.fresh(receipt)
  assert.equal(result.session_changed, true); assert.equal(result.previous_session_id, 'b'); assert.equal(result.session_id, 'fresh-b')
  assert.equal(result.handoff_pending, false); assert.equal(result.recovery_verified, false)
  assert.deepEqual(host.freshCalls, [{ botId: 'b', sessionId: 'b' }])
  await assert.rejects(host.fresh(receipt), error => error.code === 'bot/stale')
  assert.equal(host.freshCalls.length, 1)
})
test('暂停等待宿主确认结束，不因 cancel 已被调用就提前返回成功', async t => {
  const host = start(t)
  const agent = host.agents.get('b'); agent.status = 'running'; host.rt.live.set('b', { turn: 1 })
  const idle = gate()
  agent.cancel = reason => { host.canceled.push(['b', reason]) }
  agent.whenIdle = () => idle.promise
  let done = false
  const request = host.pause().then(value => { done = true; return value })
  await settle(); assert.equal(host.canceled.length, 1); assert.equal(done, false)
  agent.status = 'idle'; host.rt.live.delete('b'); idle.resolve()
  assert.equal((await request).paused, true)
})
test('普通 Bot、无归属调用、自己、其他主 Bot 与私有 Bot 均不能操控', async t => {
  const host = start(t)
  for (const id of ['b', 'outside']) await assert.rejects(host.pause({}, id), error => error.code === 'bot/refused')
  for (const bot of ['Chief', 'Other Main', 'Private']) await assert.rejects(host.pause({ bot }), error => error.code === 'bot/refused')
  await assert.rejects(host.pause({ bot: 'missing' }), error => error.code === 'bot/not-found')
  assert.deepEqual(host.canceled, []); assert.deepEqual(host.freshCalls, [])
})
test('默认拒绝有排队输入的暂停，显式 true 才取消并回执实际丢弃数量', async t => {
  const host = start(t)
  const agent = host.agents.get('b'); agent.status = 'running'; host.rt.live.set('b', { turn: 1 })
  const next = { id: 'next-step', content: [{ type: 'text', text: '保留插话' }] }
  const queued = { id: 'next-turn', content: [{ type: 'text', text: '保留排队请求' }] }
  agent.inbox.nextStep.push(next); agent.inbox.nextTurn.push(queued)
  await assert.rejects(host.pause(), error => error.code === 'bot/busy')
  assert.equal(host.canceled.length, 0); assert.equal(agent.inbox.nextStep[0], next); assert.equal(agent.inbox.nextTurn[0], queued)
  const receipt = await host.pause({ discard_queued: true })
  assert.equal(receipt.discarded_count, 2); assert.equal(receipt.new_session_ready, true)
  assert.equal(host.canceled.length, 1); assert.deepEqual(agent.inbox, { nextStep: [], nextTurn: [] })
})
test('宿主未丢弃队列时如实返回未就绪，不自行 remove 输入或伪造丢弃数量', async t => {
  const host = start(t)
  const agent = host.agents.get('b'); agent.inbox.nextTurn.push({ id: 'queued' })
  agent.cancel = () => {}
  const receipt = await host.pause({ discard_queued: true })
  assert.equal(receipt.paused, true); assert.equal(receipt.discarded_count, 0); assert.equal(receipt.new_session_ready, false)
  assert.equal(receipt.pause_id, undefined); assert.equal(agent.inbox.nextTurn.length, 1)
})
test('调用参数严格校验，不接受伪造调用方或通过字符串开启丢弃', async t => {
  const host = start(t)
  for (const args of [{ discard_queued: 'true' }, { discard_queued: null }, { bot: 1 }]) {
    await assert.rejects(host.pause(args), { name: 'ToolArgsError', code: 'INVALID_ARGS' })
  }
  for (const args of [{ callerId: 'a' }, { permission: 'danger-full-access' }, { reason: '' }, { reason: 'x'.repeat(501) }]) {
    await assert.rejects(host.pause(args), { code: 'bot/invalid' })
  }
  await assert.rejects(host.call('new_bot_session', { bot: 'Writer', reason: '故障' }), { name: 'ToolArgsError', code: 'INVALID_ARGS' })
  assert.deepEqual(host.canceled, []); assert.deepEqual(host.freshCalls, [])
})
test('只读及宿主能力缺失时拒绝，不调用 cancel 或切换', async t => {
  const host = start(t)
  host.readonly('配置只读')
  await assert.rejects(host.pause(), error => error.code === 'bot/read-only')
  host.readonly(undefined)
  host.agents.get('b').whenIdle = undefined
  await assert.rejects(host.pause(), error => error.code === 'bot/unavailable')
  assert.deepEqual(host.canceled, []); assert.deepEqual(host.freshCalls, [])
})
test('宿主待处理队列接口缺失时明确拒绝，不能调用 cancel 后才抛类型错误', async t => {
  for (const field of ['inbox', 'nextStep', 'nextTurn']) await t.test(field, async sub => {
    const host = start(sub); const agent = host.agents.get('b')
    agent.status = 'running'; host.rt.live.set('b', { turn: 1 })
    if (field === 'inbox') delete agent.inbox
    else delete agent.inbox[field]
    await assert.rejects(host.pause(), error => error.code === 'bot/unavailable')
    assert.deepEqual(host.canceled, []); assert.deepEqual(host.freshCalls, [])
  })
})
test('模型暂停不代表审批、后台命令或协作结束，不修改这些记录', async t => {
  const host = start(t)
  const work = { fromPart: 'b', text: '继续等协作' }; host.rt.state.works.pending = work
  const group = { id: 'group-b', status: 'running' }; host.agents.set('group-b', group)
  const background = { id: 'background-b', status: 'running' }; host.agents.set('background-b', background)
  const receipt = await host.pause()
  assert.equal(receipt.paused, true); assert.equal(receipt.new_session_ready, false); assert.equal(receipt.pause_id, undefined)
  assert.equal(host.rt.state.works.pending, work); assert.equal(group.status, 'running'); assert.equal(background.status, 'running')
  assert.deepEqual(host.canceled, [])
})
test('收到新输入或开始新轮次后，先前暂停回执不可再用', async t => {
  const host = start(t)
  const first = await host.pause()
  host.event('b', 'turn/start')
  await assert.rejects(host.fresh(first), error => error.code === 'bot/stale')
  const second = await host.pause()
  host.ctx.emit('agent/inbox/inserted', { agent: host.agents.get('b'), message: { id: 'new-input' } })
  await assert.rejects(host.fresh(second), error => error.code === 'bot/stale')
  assert.deepEqual(host.freshCalls, [])
})
test('回执绑定实际主 Bot 和调用会话，其他主 Bot 不得复用', async t => {
  const host = start(t)
  const receipt = await host.pause()
  await assert.rejects(host.fresh(receipt, {}, 'c'), error => error.code === 'bot/refused')
  assert.deepEqual(host.freshCalls, [])
  assert.equal((await host.fresh(receipt)).session_changed, true)
})
test('暂停等待期间取消请求会停止等待，不创建回执或新会话', async t => {
  const host = start(t)
  const abort = new AbortController(); const idle = gate(); const agent = host.agents.get('b')
  agent.status = 'running'; host.rt.live.set('b', { turn: 1 })
  agent.cancel = () => {}; agent.whenIdle = () => idle.promise
  const request = host.pause({}, 'a', abort.signal)
  await settle(); abort.abort()
  await assert.rejects(request, error => error.code === 'bot/refused')
  assert.deepEqual(host.freshCalls, [])
  agent.status = 'idle'; host.rt.live.delete('b'); idle.resolve()
})
test('暂停时出现另一个新轮次不能再取消该新轮次或签发旧回执', async t => {
  const host = start(t)
  const idle = gate(); const agent = host.agents.get('b'); agent.status = 'running'; host.rt.live.set('b', { turn: 1 })
  agent.cancel = () => { host.canceled.push(['b', {}]) }; agent.whenIdle = () => idle.promise
  const request = host.pause(); await settle()
  host.event('b', 'turn/start'); agent.status = 'idle'; host.rt.live.delete('b'); idle.resolve()
  await assert.rejects(request, error => error.code === 'bot/stale')
  assert.equal(host.canceled.length, 1)
})
test('准备或提交前撤销主角色、调用会话转入历史、开启私有保护或修改设置均阻止切换', async t => {
  for (const stage of ['role', 'caller', 'private', 'settings', 'session']) await t.test(stage, async sub => {
    const host = start(sub); const receipt = await host.pause()
    host.create(() => {
      if (stage === 'role') host.rt.state.mainBotIds = ['c']
      else if (stage === 'caller') host.rt.isBotSession = id => id !== 'a'
      else if (stage === 'private') host.bots.b.private = true
      else if (stage === 'settings') host.bots.b.effort = 'high'
      else host.bots.b.sessionId = 'changed-by-user'
    })
    await assert.rejects(host.fresh(receipt), error => error.code === (['role', 'caller', 'private'].includes(stage) ? 'bot/refused' : 'bot/stale'))
    assert.notEqual(host.bots.b.sessionId, 'fresh-b')
  })
})
test('并发请求只切一次；首次请求完成后旧回执仍被消费', async t => {
  const host = start(t); const receipt = await host.pause(); const entered = gate(); const release = gate()
  host.create(async () => { entered.resolve(); await release.promise })
  const request = host.fresh(receipt); await entered.promise
  await assert.rejects(host.fresh(receipt), error => error.code === 'bot/busy')
  release.resolve(); assert.equal((await request).session_changed, true)
  await assert.rejects(host.fresh(receipt), error => error.code === 'bot/stale')
  assert.equal(host.freshCalls.length, 1)
})
test('恢复标记未完成时如实返回交接待恢复，不能报告故障已解决', async t => {
  const host = start(t); const receipt = await host.pause()
  host.create(() => { host.rt.state.switching.b = { botId: 'b' } })
  const result = await host.fresh(receipt)
  assert.equal(result.session_changed, true); assert.equal(result.handoff_pending, true); assert.equal(result.recovery_verified, false)
  await assert.rejects(host.pause(), error => error.code === 'bot/busy')
  await assert.rejects(host.fresh(receipt), error => error.code === 'bot/stale')
  assert.equal(host.freshCalls.length, 1)
})
test('旧私聊交接在创建期间才出现时仍阻止提交，不能跨过待恢复记录', async t => {
  const host = start(t)
  host.bots.b.segments = [{ sessionId: 'older-private' }]
  const receipt = await host.pause()
  host.create(() => { host.rt.state.switching['older-private'] = { botId: 'b' } })
  await assert.rejects(host.fresh(receipt), error => error.code === 'bot/busy')
  assert.equal(host.bots.b.sessionId, 'b')
})
test('群或后台任务的切换标记不阻止独立前台私聊暂停和新建', async t => {
  const host = start(t)
  host.bots.b.tasks = [{ id: 'task', sessionId: 'background', segments: [{ sessionId: 'older-task' }], status: 'running' }]
  host.rt.state.switching = { 'group-b': { botId: 'b', roomId: 'room' }, background: { botId: 'b' }, 'older-task': { botId: 'b' } }
  const before = structuredClone(host.rt.state.switching)
  const receipt = await host.pause()
  assert.equal(receipt.new_session_ready, true)
  assert.equal((await host.fresh(receipt)).session_changed, true)
  assert.deepEqual(host.rt.state.switching, before)
})
test('卸载插件中止正在等待的管理操作，不能继续使用旧回执', async t => {
  const host = start(t); const idle = gate(); const agent = host.agents.get('b'); agent.status = 'running'
  agent.cancel = () => {}; agent.whenIdle = () => idle.promise
  const request = host.pause(); await settle(); await host.ctx.dispose()
  await assert.rejects(request, error => error.code === 'bot/refused')
  agent.status = 'idle'; idle.resolve()
})
