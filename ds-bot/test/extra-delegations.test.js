import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { install as installExtras } from '../src/host/extras/index.js'
import { BROWSER_ALLOWED } from '../src/shared/browser-endpoints.js'

const evt = (type, data, time = 10) => ({ type, data, time })
const catalog = (childId, label = '同名任务', mode = 'continuable') => evt('subagent/catalog', { version: mode === 'external' ? 2 : 0, childId, childCreatedAt: 10, mode, label })
const turn = (number, kind) => evt(kind === undefined ? 'turn/start' : 'turn/end', { turn: number, ...(kind === undefined ? {} : { reason: { kind, error: { message: 'never send internal errors' } } }) })
const text = value => ({ type: 'text', text: value })
const reply = (number, value) => evt('assistant/message', { turn: number, message: { content: [text(value), { type: 'reasoning', text: 'hidden reasoning' }] } })
const settled = (child, rest, value) => {
  const summary = `Background subagent ${child} ${rest}`
  return evt('user/message', { source: { kind: 'subagent-settled', form: 'notice', senderSessionId: child, summary }, content: [text(summary), text(value)] })
}
const botRange = { scope: { kind: 'bot', botId: 'bot' }, rootSessionId: 'root' }
const taskRange = { scope: { kind: 'task', botId: 'bot', taskId: 'task' }, rootSessionId: 'task-root' }
const list = 'extra-delegation-list'
const read = 'extra-delegation-read'
const device = { kind: 'browser', deviceId: 'deck', identityKey: 'paired-key', pairedAt: 12 }

function setup() {
  const bot = { id: 'bot', sessionId: 'root', segments: [{ sessionId: 'old-root' }], tasks: [{ id: 'task', sessionId: 'task-root', startSeq: 2 }] }
  const other = { id: 'other', sessionId: 'other-root' }
  const room = { id: 'room', sessionId: 'room-root', members: ['bot'], sessions: { bot: 'room-member' }, parts: [{ sessionId: 'room-old' }] }
  const teamAgent = { id: 'plain', sessions: ['agent-root'] }
  const bots = new Map([[bot.id, bot], [other.id, other]])
  const live = new Map(), listeners = new Map(), logs = new Map(), reads = []
  const rt = {
    state: { extras: { deviceAccess: { deck: { identityKey: device.identityKey, pairedAt: device.pairedAt, fullMessages: true } } } },
    ctx: {
      on: (name, fn) => (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn),
      effect: () => {},
      get: name => name === 'sessionQuery' ? query : name === 'agents' ? live : name === 'subagents' ? subagents : undefined,
    },
    load: async () => {}, loadSecrets: async () => {}, addTeamTool: () => {}, secretStoreStatus: () => ({ locked: false }),
    redactSecrets: value => value.replaceAll('known-test-value', '[secret:TEST]'),
    botOf: id => bots.get(id), chatOf: id => bots.get(id)?.sessionId,
    roomOf: id => id === room.id || id === room.sessionId ? room : undefined,
    sessionOfRoom: group => group?.sessionId, agentById: id => id === teamAgent.id ? teamAgent : undefined,
    agentOf: id => teamAgent.sessions.includes(id) ? teamAgent : undefined,
    chatOwners: new Map([['root', 'bot'], ['other-root', 'other'], ['task-root', 'bot']]),
    taskOwners: new Map([['task-root', { botId: 'bot', taskId: 'task' }]]),
    roomOwners: new Map([['room-root', 'room']]), groupOwners: new Map([['room-member', { botId: 'bot', roomId: 'room' }]]),
    pastOwners: new Map([['old-root', { botId: 'bot' }], ['room-old', { roomId: 'room' }]]),
    selfOf: id => rt.chatOwners.get(id) ?? rt.groupOwners.get(id)?.botId ?? rt.pastOwners.get(id)?.botId,
  }
  const subagents = { listChildren: () => assert.fail('复用同一次观察切面的正式目录投影') }
  const query = { observeSession: async (id, { signal, projectionMode }) => {
    assert.equal(signal.aborted, false)
    reads.push(id)
    const record = logs.get(id)
    if (record === undefined) throw Object.assign(new Error('private storage content'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    return {
      header: record.header, cursor: record.events.length - 1, inheritedEventCount: record.inherited,
      events: record.events, projections: projectionMode === 'all' ? { asOfSeq: record.events.length - 1, values: { subagentCatalog: record.catalog } } : undefined,
      [Symbol.dispose]() { record.disposed += 1 },
    }
  } }
  const log = (id, events, { parent, inherited = 0 } = {}) => {
    const rows = events.slice(inherited).filter(event => event.type === 'subagent/catalog')
      .map(({ data }) => [data.childId, { id: data.childId, label: data.label, mode: data.mode, createdAt: data.childCreatedAt }])
    const record = { header: { id, createdAt: 10, ...(parent === undefined ? {} : { parentSession: parent, origin: 'subagent' }) }, inherited,
      events: events.map((event, seq) => ({ ...event, seq })), catalog: [...new Map(rows).values()], disposed: 0 }
    logs.set(id, record)
    return record
  }
  const emit = (name, parent, info) => {
    const carrier = scopeTarget({}, { session: { id: parent } })
    for (const fn of listeners.get(name) ?? []) fn.call(carrier, info)
  }
  const callerFor = entry => ({ authorize: () => rt.extraRemoteAccessError(entry, list, {}),
    fullMessages: () => rt.extraFullMessagesAllowed(entry), deviceKind: () => entry.kind })
  const call = (endpoint, body, options = {}) => rt.extraEndpoint(endpoint, body, options.signal, options.caller)
  installExtras(rt)
  return { rt, bot, room, live, logs, query, subagents, reads, log, call, callerFor, emit }
}

test('目录以持久父子记录分页；父轮次结束不覆盖子 Agent 的真实运行状态', async () => {
  const f = setup()
  const parent = f.log('root', [turn(1), catalog('a', '同名任务 token=test-value'), catalog('b', '同名任务 token=other-value'), turn(1, 'completed')])
  f.log('a', [turn(1)], { parent: 'root' })
  f.live.set('a', { status: 'running', session: { header: f.logs.get('a').header } })
  const first = await f.call(list, { ...botRange, limit: 1 })
  assert.deepEqual(f.reads, ['root'])
  assert.equal(first.items[0].childId, 'a')
  assert.equal(first.items[0].status, 'running')
  assert.equal(first.items[0].label.includes('test-value'), false)
  assert.equal(first.nextAfterChildId, 'a')
  const second = await f.call(list, { ...botRange, afterChildId: first.nextAfterChildId, limit: 1 })
  assert.equal(second.items[0].childId, 'b')
  assert.equal(second.items[0].status, 'unknown')
  assert.equal(second.nextAfterChildId, null)
  assert.equal(parent.disposed, 2)
  await assert.rejects(f.call(list, { ...botRange, afterChildId: 'unrelated' }), { code: 'bot/stale' })
  parent.catalog = null
  await assert.rejects(f.call(list, botRange), { code: 'bot/unavailable' })
})

test('逐级验证真实父子边、当前或历史归属，以及后台任务的首段边界', async () => {
  const f = setup()
  f.log('root', [catalog('a'), catalog('foreign')])
  f.log('a', [catalog('nested')], { parent: 'root' })
  f.log('nested', [], { parent: 'a' })
  f.log('foreign', [], { parent: 'other-root' })
  f.log('old-root', [catalog('old-child')])
  f.log('task-root', [catalog('inherited'), catalog('before-task'), catalog('in-task'), catalog('before-task')], { inherited: 1 })
  f.log('room-member', [catalog('room-child')])
  f.log('agent-root', [catalog('agent-child')])
  assert.equal((await f.call(list, { ...botRange, childPath: ['a'] })).items[0].childId, 'nested')
  assert.equal((await f.call(read, { ...botRange, childPath: ['a', 'nested'] })).parentSessionId, 'a')
  assert.equal((await f.call(list, { ...botRange, rootSessionId: 'old-root' })).items[0].childId, 'old-child')
  assert.deepEqual((await f.call(list, taskRange)).items.map(row => row.childId), ['in-task'])
  const inRoom = { scope: { kind: 'room', roomId: 'room' }, rootSessionId: 'room-member' }
  assert.equal((await f.call(list, inRoom)).items[0].childId, 'room-child')
  const plain = { scope: { kind: 'agent', agentId: 'plain' }, rootSessionId: 'agent-root' }
  assert.equal((await f.call(list, plain)).items[0].childId, 'agent-child')
  await assert.rejects(f.call(list, plain, { caller: f.callerFor(device) }), { code: 'bot/refused' })
  for (const rootSessionId of ['other-root', 'task-root', 'room-member', 'agent-root']) {
    await assert.rejects(f.call(list, { ...botRange, rootSessionId }), { code: 'bot/refused' })
  }
  await assert.rejects(f.call(read, { ...botRange, childPath: ['nested'] }), { code: 'bot/not-found' })
  await assert.rejects(f.call(read, { ...botRange, childPath: ['foreign'] }), { code: 'bot/refused' })
  await assert.rejects(f.call(read, { ...taskRange, childPath: ['before-task'] }), { code: 'bot/not-found' })
  f.room.members = []
  await assert.rejects(f.call(list, inRoom), { code: 'bot/refused' })
  delete f.bot.tasks[0].startSeq
  await assert.rejects(f.call(list, taskRange), { code: 'bot/unavailable' })
})

test('过程游标固定子会话与切面；排除继承、思维链、内部字段和非文本块', async () => {
  const f = setup()
  f.log('root', [catalog('a'), catalog('b')])
  f.log('a', [reply(1, 'ancestor context'), turn(2), evt('system/message', { message: 'private config' }),
    evt('tool/call', { callId: 'call', name: 'read', arguments: 'raw arguments' }),
    reply(2, '公开结果 known-test-value'), turn(2, 'completed')], { parent: 'root', inherited: 1 })
  f.log('b', [], { parent: 'root' })
  const target = { ...botRange, childPath: ['a'], limit: 2 }
  const first = await f.call(read, target)
  assert.equal(first.child.status, 'unknown', '轮次完成不证明委派结算')
  assert.equal(first.lastTurn.status, 'completed')
  assert.equal(first.lastTurn.result.text, '公开结果 [secret:TEST]')
  assert.deepEqual(first.events.map(event => event.seq), [4, 5])
  assert.deepEqual(first.cursor, { childId: 'a', throughSeq: 5, beforeSeq: 4 })
  f.log('a', [...f.logs.get('a').events, turn(3), reply(3, '后续运行')], { parent: 'root', inherited: 1 })
  const next = await f.call(read, { ...target, limit: 1, cursor: first.cursor })
  assert.equal(next.throughSeq, 5)
  assert.equal(next.lastTurn.turn, 2)
  assert.deepEqual(next.events.map(event => event.seq), [3])
  const last = await f.call(read, { ...target, cursor: next.cursor })
  assert.deepEqual(last.events.map(event => event.seq), [1])
  assert.equal(last.cursor, null)
  const fresh = await f.call(read, target)
  assert.equal(fresh.lastTurn.status, 'open')
  assert.equal(fresh.lastTurn.turn, 3)
  assert.doesNotMatch(JSON.stringify([first, next, last]), /ancestor context|hidden reasoning|private config|raw arguments|known-test-value|后续运行/)
  await assert.rejects(f.call(read, { ...target, childPath: ['b'], cursor: first.cursor }), { code: 'bot/invalid' })
  await assert.rejects(f.call(read, { ...target, cursor: { ...first.cursor, throughSeq: 600 } }), { code: 'bot/stale' })
})

test('区分真实结算、取消、失败和未知；外部委派不探测不存在的子会话', async () => {
  const f = setup()
  f.log('root', [catalog('ext', 'outside', 'external'), catalog('a'), catalog('b', 'no result', 'external'),
    settled('ext', 'failed before it finished.', 'Authorization: Test-only'),
    settled('not-in-catalog', 'finished.', 'not visible'), settled('a', 'finished and will do no further work unless you send it more.', 'older result')])
  const initial = await f.call(list, botRange)
  assert.deepEqual(initial.items.map(row => row.status), ['failed', 'unknown', 'unknown'])
  assert.equal(initial.items[1].lastSettlement.status, 'completed')
  const ext = await f.call(read, { ...botRange, childPath: ['ext'] })
  assert.equal(ext.history, 'external')
  assert.equal(ext.child.status, 'failed')
  assert.equal(ext.result.text.includes('Test-only'), false)
  assert.equal(f.reads.includes('ext'), false)
  const lifecycle = { id: 'a', runId: 'old-run', local: true }
  f.emit('subagent/start', 'root', lifecycle)
  f.emit('subagent/start', 'root', { ...lifecycle, runId: 'new-run' })
  f.emit('subagent/end', 'root', { ...lifecycle, stopReason: 'completed' })
  f.emit('subagent/end', 'other-root', { ...lifecycle, runId: 'new-run', stopReason: 'error' })
  assert.equal((await f.call(list, botRange)).items[1].status, 'running')
  f.emit('subagent/end', 'root', { ...lifecycle, runId: 'new-run', stopReason: 'aborted' })
  assert.equal((await f.call(list, botRange)).items[1].status, 'canceled')
})

test('结算正文在返回时重新脱敏；未知通知措辞不能判定成功', async () => {
  const f = setup()
  f.log('root', [catalog('ext', 'outside', 'external'), catalog('other', 'unknown notice', 'external'),
    settled('other', 'finished. Unexpected future state.', '未知通知')])
  const run = { id: 'ext', runId: 'run', local: false }
  f.emit('subagent/start', 'root', run)
  f.emit('subagent/end', 'root', { ...run, stopReason: 'completed', lastAssistantMessage: [text('公开结果 known-test-value rotated-value')] })
  const before = await f.call(read, { ...botRange, childPath: ['ext'] })
  assert.equal(before.result.source, 'lifecycle')
  assert.equal(before.result.runId, 'run')
  assert.equal(before.result.text, '公开结果 [secret:TEST] rotated-value')
  assert.equal((await f.call(read, { ...botRange, childPath: ['ext'] })).result.text, before.result.text)
  const previous = f.rt.redactSecrets
  f.rt.redactSecrets = value => previous(value).replaceAll('rotated-value', '[secret:NEW]')
  assert.equal((await f.call(read, { ...botRange, childPath: ['ext'] })).result.text, '公开结果 [secret:TEST] [secret:NEW]')
  assert.equal((await f.call(list, botRange)).items[1].status, 'unknown')
  f.emit('subagent/start', 'root', { ...run, runId: 'next-run' })
  assert.equal((await f.call(read, { ...botRange, childPath: ['ext'] })).result, null)
})

test('生命周期缓存先遮盖原始敏感字段和伪造标记，复读不会恢复敏感内容', async () => {
  const f = setup()
  f.log('root', [catalog('ext', 'outside', 'external')])
  const run = { id: 'ext', runId: 'run', local: false }
  f.emit('subagent/start', 'root', run)
  f.emit('subagent/end', 'root', { ...run, stopReason: 'completed', lastAssistantMessage: [text('known-test-value [secret:fake-mark] token=fake-value')] })
  for (let at = 0; at < 2; at += 1) {
    const answer = await f.call(read, { ...botRange, childPath: ['ext'] })
    assert.match(answer.result.text, /\[secret:TEST\]/)
    assert.doesNotMatch(answer.result.text, /known-test-value|fake-mark|fake-value/)
  }
})

test('PTC 的子调用与结果成对呈现，未知结果不会报成功', async () => {
  const f = setup()
  f.log('root', [catalog('a')])
  f.log('a', [turn(1), evt('tool/ptc-dispatch-start', { callId: 'parent-call', subCallId: 'sub-call', name: 'read', arguments: 'hidden args' }),
    evt('tool/ptc-dispatch', { callId: 'parent-call', subCallId: 'sub-call', result: { ok: false, content: [text('hidden output')] } })], { parent: 'root' })
  const answer = await f.call(read, { ...botRange, childPath: ['a'] })
  assert.deepEqual(answer.events.map(event => event.type), ['turn/start', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'])
  assert.equal(answer.events[2].callId, 'sub-call')
  assert.equal(answer.events[2].status, 'failed')
  assert.doesNotMatch(JSON.stringify(answer), /hidden args|hidden output/)
})

test('异步读取中取消或改变归属，观察租约释放且不返回正文', async () => {
  for (const change of ['abort', 'scope']) {
    const f = setup()
    const controller = new AbortController()
    f.log('root', [catalog('a')])
    const child = f.log('a', [reply(1, '不得返回')], { parent: 'root' })
    const observe = f.query.observeSession
    f.query.observeSession = async (...args) => {
      const view = await observe(...args)
      if (args[0] === 'a') {
        if (change === 'abort') controller.abort()
        else f.bot.sessionId = 'replacement-root'
      }
      return view
    }
    await assert.rejects(f.call(read, { ...botRange, childPath: ['a'] }, { signal: controller.signal }), { code: 'bot/refused' })
    assert.equal(child.disposed, 1)
    assert.equal(f.logs.get('root').disposed, 1)
  }
})

test('请求校验和并发上限在读取日志之前生效，失败后释放名额', async () => {
  const f = setup()
  for (const payload of [{ ...botRange, childPath: ['root'] }, { ...botRange, limit: 33 }, { ...botRange, fullMessages: true },
    { ...botRange, scope: { kind: 'bot', botId: 'bot', roomId: 'room' } }]) {
    await assert.rejects(f.call(list, payload), { code: 'bot/invalid' })
  }
  assert.deepEqual(f.reads, [])
  f.log('root', [])
  const observe = f.query.observeSession
  let release, entered
  const held = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  let count = 0
  f.query.observeSession = async (...args) => {
    const view = await observe(...args)
    if (++count === 4) entered()
    await held
    return view
  }
  const pending = Array.from({ length: 4 }, () => f.call(list, botRange))
  await ready
  try { await assert.rejects(f.call(list, botRange), { code: 'bot/busy' }) }
  finally { release() }
  await Promise.all(pending)
  assert.equal(f.logs.get('root').disposed, 4)
  f.query.observeSession = observe
  assert.deepEqual((await f.call(list, botRange)).items, [])
})

test('没有能力、授权撤销、重配、密钥库锁定和取消不会返回旧正文', async () => {
  const f = setup()
  assert.equal(BROWSER_ALLOWED.has(list) && BROWSER_ALLOWED.has(read), true)
  assert.equal((await f.call('extra-status', {}, { caller: f.callerFor(device) })).delegations.read, true)
  const denied = f.callerFor({ ...device, pairedAt: 13 })
  assert.equal((await f.call('extra-status', {}, { caller: { ...denied, authorize: () => undefined } })).delegations.read, false)
  const gateway = { authorize: () => f.rt.extraRemoteAccessError({ kind: 'gateway' }, list, {}), fullMessages: () => false, deviceKind: () => 'gateway' }
  for (const caller of [denied, gateway]) await assert.rejects(f.call(list, botRange, { caller }), { code: 'bot/refused' })
  assert.deepEqual(f.reads, [])
  f.log('root', [catalog('a')])
  const get = f.query.observeSession
  f.query.observeSession = async (...args) => {
    const view = await get(...args)
    delete f.rt.state.extras.deviceAccess.deck
    return view
  }
  await assert.rejects(f.call(list, botRange, { caller: f.callerFor(device) }), { code: 'bot/refused' })
  assert.equal(f.logs.get('root').disposed, 1)
  f.query.observeSession = get
  f.rt.secretStoreStatus = () => ({ locked: true })
  await assert.rejects(f.call(list, botRange), { code: 'bot/unavailable' })
  const signal = AbortSignal.abort()
  await assert.rejects(f.call(list, botRange, { signal }), { code: 'bot/refused' })
  delete f.subagents.listChildren
  assert.equal((await f.call('extra-status', {})).delegations, undefined)
  await assert.rejects(f.call(list, botRange), { code: 'bot/unavailable' })
})
