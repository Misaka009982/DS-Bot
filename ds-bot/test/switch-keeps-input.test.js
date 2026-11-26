import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

let rt

// #280: a switch that fails while the plugin is being unloaded must not lose the input
// it carried — a turn's claimed messages and whatever the old part held. The old
// part's durable inbox keeps them (the fake persists it across starts), a switch is
// marked in state.switching until its input is handed on, a retry does not double,
// and the restart pass hands marked input on or wakes the part that kept it.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

// The error every ctx service lookup gives once the plugin's fiber is disposed.
const INACTIVE = 'cannot get required service "sessions" in inactive context'

// `fail.create`/`fail.resolve`/`fail.flush`: true fails with the inactive-context
// error; an Error value fails with it, so an ordinary error is testable too.
async function start({ fail = {}, services = {}, home: reuse, state: seed = TEAM } = {}) {
  const root = reuse === undefined
    ? realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-switch-')))
    : join(reuse, '..', '..')
  const home = reuse ?? join(root, 'dsh', 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  for (const dir of [team, project]) mkdirSync(dir, { recursive: true })
  if (reuse === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(seed))

  // The real inbox is durable; the fake keeps it in a file so a "restart" sees it.
  const inboxPath = join(home, 'fake-inbox.json')
  const inboxSeed = () => {
    try { return JSON.parse(readFileSync(inboxPath, 'utf8')) } catch { return {} }
  }
  const saved = inboxSeed()
  const persist = (agents) => {
    const all = { ...saved }
    for (const [id, agent] of agents) all[id] = { nextStep: agent.inbox.nextStep, nextTurn: agent.inbox.nextTurn }
    writeFileSync(inboxPath, JSON.stringify(all))
  }

  const ctx = fakeContext({ services })
  const warnings = []
  const infos = []
  ctx.logger = {
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    info: (...args) => infos.push(args.map(String).join(' ')),
  }
  const errorOf = value => (value instanceof Error ? value : new Error(INACTIVE))
  let flushes = 0
  const created = []
  const resolved = []
  const archived = []
  const cwds = new Map()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const nextStep = [...saved[sessionId]?.nextStep ?? []]
      const nextTurn = [...saved[sessionId]?.nextTurn ?? []]
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, seq: 0, header: { cwd: cwds.get(sessionId) ?? team }, requestHeader: () => undefined, deriveMessages: () => [] },
        ctx: { tools: { register: () => () => {} } },
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        send(message, target, wakeup) {
          ;(target === 'next-turn' ? nextTurn : nextStep).push(message)
          calls.push(['send', message, target, wakeup])
          persist(agents)
        },
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep,
          nextTurn,
          prepend(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).unshift(message); persist(agents) },
          append(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).push(message); persist(agents) },
          remove(id) {
            for (const list of [nextStep, nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) { list.splice(at, 1); persist(agents); return true }
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      list: () => [{ id: 'w1', path: team }],
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w-new', path }),
      archiveSession: async (sessionId, options) => { archived.push([sessionId, options]) },
    },
    sessionController: {
      create: async (options) => {
        if (fail.create) throw errorOf(fail.create)
        const sessionId = `s${created.length + 1}`
        created.push(options)
        cwds.set(sessionId, options.cwd ?? team)
        return { sessionId }
      },
      resolveAgent: async (sessionId) => {
        if (fail.resolve?.has(sessionId)) throw errorOf(fail.resolve)
        resolved.push(sessionId)
        return { agent: agentOf(sessionId) }
      },
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: {
      // A number fails that call; true fails them all, so a test can break the flush
      // of the handed-on input without breaking the fresh part's own write before it.
      flush: async () => {
        flushes += 1
        if (fail.flush === true || fail.flush instanceof Error || fail.flush === flushes) throw errorOf(fail.flush)
      },
    },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  const preStep = (sessionId, messages = [], step = 1) => ctx.listeners.get('agent/pre-step').at(-1)(
    { agent: agentOf(sessionId), messages, step, signal: AbortSignal.timeout(60_000) }, async () => 'next')
  // A Session event as DSH emits it, on the Session the test's Agent holds.
  let seq = 0
  const emit = (sessionId, type, data) => {
    const session = agentOf(sessionId).session
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, { type, seq: ++seq, data })
    }
  }
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  await tool('list_bots', {}, 'a')
  return { ctx, rt, root, home, team, project, created, resolved, archived, agentOf, call, tool, preStep, emit, state, warnings, infos, fail, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold')
    await settle()
  }
}

const text = message => message.content.map(block => block.text ?? '').join('\n')
const inboxTexts = agent => [...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(text)
const PAUSE = 'DS Bot paused your turn for a context check. Go on with it now from where you stopped.'
const said = (id, body, exchangeId) => ({ id, role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'user', ...(exchangeId ? { exchangeId } : {}) } })
// A folder outside the team workspace asks for approval once; then the move is allowed.
const services = {
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  approval: { request: async () => 'allowed-once' },
}

// Writer's own chat gets a working folder while it is mid-turn; its next step starts
// the switch and carries that step's input along.
const moveWriter = async (host, input, step = 2) => {
  host.agentOf('b').status = 'running'
  assert.equal((await host.tool('update_bot', { work_dir: host.project }, 'b')).includes('From your next step on'), true)
  assert.deepEqual(await host.preStep('b', input, step), { kind: 'reject' })
}

test('a move that fails while the plugin unloads hands its input back to the part it left', async (t) => {
  // The first flush writes the fresh part's handoff; the second moves the input.
  const fail = { flush: 2 }
  const host = await start({ fail, services })
  t.after(host.stop)
  host.agentOf('b').inbox.nextTurn.push(said('h1', 'waiting input', 'e-held'))
  await moveWriter(host, [said('m1', 'Now build it', 'e-carry'), said('m2', 'and this too', 'e-carry2')])

  // The fresh part took over, then moving the input failed while unloaded.
  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.state().bots.b.sessionId, 's1')
  // The part stays marked until the restart pass hands the input on.
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  // carry went back in order at the front of next-turn; the held message stayed put.
  assert.deepEqual(inboxTexts(host.agentOf('b')), ['Now build it', 'and this too', 'waiting input'])
  assert.equal(host.warnings.length, 0)
  assert.ok(host.infos.some(line => line.includes('input kept in part')))
})

test('a move that never started keeps carry and one pause note in the inbox; a retry adds none', async (t) => {
  const fail = { create: true, flush: true }
  const host = await start({ fail, services })
  t.after(host.stop)
  await moveWriter(host, [said('m1', 'keep me', 'e1')])
  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.warnings.length, 0)
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
  // The part stayed put and kept its input, so it stays marked.
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  // A retry that also fails neither loses nor doubles the note; a folder move waits
  // out its retry cooldown, so the retry comes in as an overflow switch.
  const retry = () => Promise.all((host.ctx.listeners.get('agent/request-error') ?? [])
    .map(listener => listener({ agent: host.agentOf('b'), failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: AbortSignal.timeout(60_000) }, async () => undefined)))
  await retry()
  await until(() => host.infos.filter(line => line.includes('plugin unloaded')).length >= 2)
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  // With the plugin live again the same input moves on — the note still only once.
  fail.create = false
  fail.flush = false
  await retry()
  await until(() => host.state().bots.b.sessionId === 's1' && host.state().switching?.b === undefined)
  const forwarded = host.agentOf('s1').calls.filter(([kind]) => kind === 'followup' || kind === 'inject').map(([, message]) => text(message))
  assert.equal(forwarded.filter(line => line === PAUSE).length, 1)
  assert.equal(forwarded.filter(line => line === 'keep me').length, 1)
  assert.deepEqual(inboxTexts(host.agentOf('b')), [])
  // The move finished and nothing stayed behind, so the mark is gone.
  assert.deepEqual(host.state().switching, {})
})

test('an ordinary failure during the move is still a warning, not the unload note', async (t) => {
  const fail = { create: new Error('disk full'), flush: new Error('disk full') }
  const host = await start({ fail, services })
  t.after(host.stop)
  await moveWriter(host, [said('m1', 'keep me', 'e1')])
  await until(() => host.warnings.some(line => line.includes('did not move on to a fresh part')))
  await until(() => host.warnings.some(line => line.includes('was not handed on')))
  assert.equal(host.infos.filter(line => line.includes('plugin unloaded')).length, 0)
  // The input is back in the part's inbox even for an ordinary failure.
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
})

test('an ordinary failure in the move that never started wakes the part at once', async (t) => {
  const fail = { create: new Error('disk full'), flush: new Error('disk full') }
  const host = await start({ fail, services })
  t.after(host.stop)
  await moveWriter(host, [said('m1', 'keep me', 'e1')])
  await until(() => host.warnings.some(line => line.includes('was not handed on')))
  const sends = host.agentOf('b').calls.filter(([kind]) => kind === 'send')
  // One wake on the first message, in the order the inbox kept them.
  assert.deepEqual(sends.map(([, message, target, wakeup]) => [text(message), target, wakeup]), [
    [PAUSE, 'next-turn', true],
    ['keep me', 'next-turn', false],
  ])
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
  // An unload instead would not wake it: no send calls at all.
  const failOff = { create: true, flush: true }
  const silent = await start({ fail: failOff, services })
  t.after(silent.stop)
  await moveWriter(silent, [said('m1', 'keep me', 'e1')])
  await until(() => silent.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(silent.agentOf('b').calls.filter(([kind]) => kind === 'send').length, 0)
})

test('a marked earlier part hands its kept input on after a restart, once, and is archived', async (t) => {
  const fail = { flush: 2 }
  const host = await start({ fail, services })
  host.agentOf('b').inbox.nextTurn.push(said('h1', 'waiting input', 'e-held'))
  await moveWriter(host, [said('m1', 'Now build it', 'e-carry')])
  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.state().bots.b.sessionId, 's1')
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })
  await host.stop({ keep: true })

  // The restart: the kept input sits in the earlier part's (durable fake) inbox; a
  // copy of one message already reached the fresh part before the unload.
  const second = await start({ home: host.home, services })
  t.after(second.stop)
  second.agentOf('s1').inbox.nextTurn.push(said('m1-copy', 'Now build it', 'e-carry'))
  await second.rt.heldBack()

  const delivered = second.agentOf('s1').calls
    .filter(([kind, message]) => (kind === 'followup' || kind === 'inject') && message.source?.role !== 'handoff')
    .map(([, message]) => message.source?.exchangeId)
  assert.equal(delivered.filter(id => id === 'e-carry').length, 0) // already pending — not sent twice
  assert.equal(delivered.filter(id => id === 'e-held').length, 1)
  assert.deepEqual(inboxTexts(second.agentOf('b')), [])
  assert.deepEqual(second.archived, [['b', { stopActivity: true }]])
  assert.deepEqual(second.state().switching, {})
})

test('a marked part that stayed current is woken for its kept input, once, in order', async (t) => {
  const fail = { create: true, flush: true }
  const host = await start({ fail, services })
  await moveWriter(host, [said('m1', 'keep me', 'e1'), said('m2', 'and me', 'e2')])
  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.state().bots.b.sessionId, 'b')
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })
  await host.stop({ keep: true })

  const second = await start({ home: host.home, services })
  t.after(second.stop)
  await second.rt.heldBack()

  // The inbox kept the input; the wake re-sends it through send() so the driver runs.
  const sends = second.agentOf('b').calls.filter(([kind]) => kind === 'send')
  assert.deepEqual(sends.map(([, message, target, wakeup]) => [text(message), target, wakeup]), [
    [PAUSE, 'next-turn', true],
    ['keep me', 'next-turn', false],
    ['and me', 'next-turn', false],
  ])
  assert.deepEqual(inboxTexts(second.agentOf('b')), [PAUSE, 'keep me', 'and me'])
  assert.deepEqual(second.state().switching, {})
})

// #571: archiving with stopActivity drops the tasks the earlier part still owns, so
// the archive waits for the task move the switch started.
test('an earlier part is stopped only after its tasks moved to the fresh part', async (t) => {
  const host = await start({ services })
  t.after(host.stop)
  const order = []
  let release
  const moved = new Promise(resolve => { release = resolve })
  host.rt.moveSchedules = async (from, to) => { order.push(['move', from, to]); await moved }
  const archive = host.ctx.workspaceRegistry.archiveSession
  host.ctx.workspaceRegistry.archiveSession = async (id, options) => { order.push(['archive', id]); return archive(id, options) }
  await moveWriter(host, [])
  await until(() => order.length >= 1)
  await settle()
  assert.deepEqual(order, [['move', 'b', 's1']])
  release()
  await until(() => order.some(([kind]) => kind === 'archive'))
  assert.deepEqual(order, [['move', 'b', 's1'], ['archive', 'b']])
})

test('a failed task move leaves the earlier part unarchived and marked for retry', async (t) => {
  const host = await start({ services })
  t.after(host.stop)
  host.rt.moveSchedules = async () => { throw new Error('task storage unavailable') }
  await moveWriter(host, [])
  await until(() => host.warnings.some(line => line.includes('task storage unavailable')))
  await settle()
  assert.deepEqual(host.archived, [])
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  host.rt.moveSchedules = async () => {}
  await host.rt.heldBack()
  assert.deepEqual(host.archived, [['b', { stopActivity: true }]])
  assert.deepEqual(host.state().switching, {})
})

test('unmarked earlier parts are never resolved by the restart pass', async (t) => {
  const host = await start({ services })
  await moveWriter(host, [])
  // The fresh part is the Bot's before the switch ends and drops its mark.
  await until(() => host.state().bots.b.sessionId === 's1' && Object.keys(host.state().switching).length === 0)
  await host.stop({ keep: true })

  const second = await start({ home: host.home, services })
  t.after(second.stop)
  await second.rt.heldBack()
  assert.equal(second.resolved.includes('b'), false)
})

test('a state write that fails as a switch ends is warned about, not left unhandled', async (t) => {
  const unhandled = []
  const note = (error) => { unhandled.push(error) }
  process.on('unhandledRejection', note)
  t.after(() => { process.off('unhandledRejection', note) })
  const host = await start({ services })
  t.after(host.stop)
  // The write that drops the switch's mark fails, as on a full disk.
  const save = host.rt.save
  host.rt.save = () => (host.rt.state.bots.b.sessionId === 's1' && Object.keys(host.rt.state.switching).length === 0
    ? Promise.reject(new Error('disk full'))
    : save())
  await moveWriter(host, [])
  await until(() => host.warnings.some(line => line.includes('did not finish') && line.includes('disk full')))
  await settle()
  assert.deepEqual(unhandled, [])
})

// A turn cut off at the output limit with nothing written, twice in a row, is the
// shape a route whose real window is smaller than configured leaves behind. The part
// moves on the way an overflow moves it, without a note at the same size (#1104).
const cutOffServices = { ...services, tokenMeter: { measure: () => ({ totalTokens: 129_000 }) } }
const GROUP_TEAM = {
  ...TEAM,
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
}
const cutOff = (host, sessionId, turn) => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'turn/end', { turn, reason: { kind: 'max-tokens' } })
}
const finished = (host, sessionId, turn) => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } })
}

test('a Bot cut off at the output limit with nothing written moves on to a fresh part', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'gateway', model: 'step-5', maxTokens: 16384 } })
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  for (const turn of [1, 2]) {
    cutOff(host, 'b', turn)
    idle()
    await settle()
  }
  await until(() => host.state().bots.b.sessionId === 's1')

  // The diagnostics name the route and the input size, so a wrong window is findable.
  const entries = (await host.rt.diagnostics.entries()).filter(entry => entry.code === 'MAX_TOKENS')
  assert.equal(entries.length, 2)
  assert.match(entries[0].text, /^the turn was cut off at the output limit before it wrote anything \(gateway\/step-5, 129000 tokens in\)$/)
  assert.deepEqual([entries[0].level, entries[0].bot, entries[0].where], ['warn', 'Writer', 'own chat'])

  // The old part is archived and the fresh one opens with the deterministic handoff:
  // no model call, and the cut-off turn is not replayed.
  await until(() => host.archived.length > 0)
  assert.deepEqual(host.archived, [['b', { stopActivity: true }]])
  const handoff = text(host.agentOf('s1').calls.find(([kind]) => kind === 'followup')[1])
  assert.match(handoff, /^\[Handoff · part 2\]/)
  assert.match(handoff, /kept being cut off at the output limit/)
  assert.match(handoff, /Nothing needs an answer now/)
  assert.equal(host.state().bots.b.segments[0].fallback, 'cutoff')
})

test('a turn that finished in between resets the count, so one cut-off does not move the part', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  cutOff(host, 'b', 1)
  idle()
  await settle()
  finished(host, 'b', 2)
  idle()
  await settle()
  cutOff(host, 'b', 3)
  idle()
  await settle()
  assert.equal(host.state().bots.b.sessionId, 'b')
  assert.deepEqual(host.created, [])
})

test('a cut-off turn that wrote text does not move the part without usage to tell it apart', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  for (const turn of [1, 2]) {
    host.emit('b', 'turn/start', { turn })
    // No usage: the model's output limit cannot be ruled out, so this stays a cut-off
    // answer and the part stays.
    host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: `Half ${turn}` }] } })
    host.emit('b', 'turn/end', { turn, reason: { kind: 'max-tokens' } })
    idle()
    await settle()
  }
  assert.equal(host.state().bots.b.sessionId, 'b')
  assert.deepEqual(host.created, [])
})

// #1461: an OpenAI-compatible route whose real window is smaller than the declared one
// stops an oversized request with finish `length` and a short answer, not an error. The
// turn wrote a line, so #1109's nothing-written count never moved the part, and every
// later turn stopped at the same wall.
const shortCutOff = (host, turn, usage) => {
  host.emit('b', 'turn/start', { turn })
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: `Half ${turn}` }] }, usage })
  host.emit('b', 'turn/end', { turn, reason: { kind: 'max-tokens' } })
}

test('a short answer cut off twice in a row makes room like an overflow', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'gateway', model: 'step-5', maxTokens: 16384 } })
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  // The second turn reads most of its prompt from the provider's cache: the request is
  // still the whole prompt, so it counts the same.
  const sizes = [{ inputTokens: 129_000, outputTokens: 40 }, { inputTokens: 4_000, cacheReadTokens: 125_000, outputTokens: 40 }]
  for (const [index, usage] of sizes.entries()) {
    shortCutOff(host, index + 1, usage)
    idle()
    await settle()
  }
  await until(() => host.state().bots.b.sessionId === 's1')
  // The diagnostics name the route, the input and what came out, so the too-large
  // window can be found from them.
  const entries = (await host.rt.diagnostics.entries()).filter(entry => entry.code === 'MAX_TOKENS')
  assert.equal(entries.length, 2)
  assert.match(entries[0].text, /the turn was cut off at the output limit, so its answer is not complete \(gateway\/step-5, 129000 tokens in, 40 tokens out\)$/)
  assert.equal(host.state().bots.b.segments[0].fallback, 'cutoff')
})

test('a cut-off at the model output limit is not a window cut, so the part stays', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'gateway', model: 'step-5', maxTokens: 16384 } })
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  for (const turn of [1, 2]) {
    shortCutOff(host, turn, { inputTokens: 129_000, outputTokens: 120_000 })
    idle()
    await settle()
  }
  assert.equal(host.state().bots.b.sessionId, 'b')
  assert.deepEqual(host.created, [])
})

test('a group conversation cut off with nothing written moves on too', async (t) => {
  const host = await start({ services: cutOffServices, state: GROUP_TEAM })
  t.after(host.stop)
  const agent = host.agentOf('gb')
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  for (const turn of [1, 2]) {
    cutOff(host, 'gb', turn)
    idle()
    await settle()
  }
  await until(() => host.state().rooms.r1.sessions.b === 's1')
  assert.equal(host.state().rooms.r1.segments.b[0].fallback, 'cutoff')
  // The old part is archived just after the switch is saved.
  await until(() => host.archived.length > 0)
  assert.deepEqual(host.archived, [['gb', { stopActivity: true }]])
})

test('stream-only usage on assistant/message also detects premature window cut-offs', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'gateway', model: 'step-5', maxTokens: 16384 } })
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  for (const turn of [1, 2]) {
    host.emit('b', 'turn/start', { turn })
    host.emit('b', 'assistant/message', {
      message: { content: [{ type: 'text', text: `Half ${turn}` }] },
      stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 129_000, outputTokens: 40 } } }],
    })
    host.emit('b', 'turn/end', { turn, reason: { kind: 'max-tokens' } })
    idle()
    await settle()
  }
  await until(() => host.state().bots.b.sessionId === 's1')
  assert.equal(host.state().bots.b.segments[0].fallback, 'cutoff')
})


test('增补新建会话保留身份和设置，旧历史可读，新 Session 不携带旧消息或摘要', async t => {
  const host = await start()
  t.after(host.stop)
  const bot = host.rt.botOf('b')
  Object.assign(bot, { instructions: '保留我的角色', permission: 'read-only', extras: { messageMode: 'steer' }, memoryReview: { on: true } })
  const before = structuredClone(bot)
  host.agentOf('b').session.requestHeader = () => ({ config: { provider: 'gateway', model: 'model', reasoningEffort: 'high' } })
  host.agentOf('b').session.deriveMessages = () => [{ role: 'assistant', content: [{ type: 'text', text: '旧消息' }] }]
  const selected = []
  host.ctx.sessionController.selectModel = async request => { selected.push(request) }
  host.ctx.sessionController.fork = () => { throw new Error('新会话不能 fork 历史') }
  host.ctx.llm.stream = () => { throw new Error('新会话不能请求摘要') }
  const permissions = []
  host.rt.applyPermission = async (owner, id) => { permissions.push([owner.id, id, owner.permission]) }
  const result = await host.call('extra-new-session', { botId: 'b', sessionId: 'b' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { botId: 'b', sessionId: 's1' })
  const after = host.state().bots.b
  const { sessionId, segments, ...kept } = after
  const { sessionId: previousId, segments: previousSegments, ...expected } = before
  assert.equal(previousId, 'b')
  assert.equal(previousSegments, undefined)
  assert.equal(sessionId, 's1')
  assert.deepEqual(kept, expected)
  assert.deepEqual(segments.map(segment => segment.sessionId), ['b'])
  assert.equal(segments[0].note, undefined)
  assert.equal(segments[0].fallback, undefined)
  assert.deepEqual(host.agentOf('s1').calls, [])
  assert.deepEqual(permissions, [['b', 's1', 'read-only']])
  assert.equal(selected[0].sessionId, 's1')
  assert.equal(selected[0].provider, 'gateway')
  assert.equal(selected[0].reasoningEffort, 'high')
  assert.equal(host.rt.selfOf('b'), 'b')
  assert.equal(host.rt.selfOf('s1'), 'b')
  assert.deepEqual(host.archived, [['b', { stopActivity: true }]])
  assert.deepEqual(host.state().switching, {})
})

test('增补新建会话拒绝过期目标、未知 Bot 和额外设置字段', async t => {
  const host = await start()
  t.after(host.stop)
  for (const [payload, code] of [
    [{ botId: 'b', sessionId: 'older' }, 'bot/stale'],
    [{ botId: 'missing', sessionId: 'b' }, 'bot/not-found'],
    [{ botId: 'b', sessionId: 'b', permission: 'full' }, 'bot/invalid'],
  ]) {
    const result = await host.call('extra-new-session', payload)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, code)
  }
  assert.deepEqual(host.created, [])
})

test('增补新建会话保护运行、排队、待答卡片和未结束的协作', async t => {
  const host = await start()
  t.after(host.stop)
  const refused = async () => {
    const result = await host.call('extra-new-session', { botId: 'b', sessionId: 'b' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bot/busy')
  }
  const agent = host.agentOf('b')
  agent.status = 'running'
  await refused()
  agent.status = 'idle'
  agent.inbox.nextTurn.push(said('queued', '还没发送'))
  await refused()
  agent.inbox.nextTurn.length = 0
  host.rt.state.questions.b = { id: 'question' }
  await refused()
  delete host.rt.state.questions.b
  host.rt.state.works.pending = { fromPart: 'b' }
  await refused()
  delete host.rt.state.works.pending
  const waits = host.rt.waitsForApproval
  host.rt.waitsForApproval = id => id === 'b'
  await refused()
  host.rt.waitsForApproval = waits
  assert.deepEqual(host.created, [])
})

test('增补新建会话在创建、模型、权限或保存失败时保留原会话和历史', async t => {
  for (const stage of ['create', 'model', 'permission', 'save']) await t.test(stage, async sub => {
    const host = await start({ fail: stage === 'create' ? { create: new Error('创建失败') } : {} })
    sub.after(host.stop)
    if (stage === 'model') {
      host.rt.desiredModel = async () => 'gateway/model'
      host.rt.selectSessionModel = async () => { throw new Error('模型选择失败') }
    }
    if (stage === 'permission') host.rt.applyPermission = async () => { throw new Error('权限设置失败') }
    if (stage === 'save') {
      const save = host.rt.save
      let failed = false
      host.rt.save = options => {
        if (!failed && host.rt.chatOf('b') === 's1') { failed = true; return Promise.reject(new Error('保存失败')) }
        return save(options)
      }
    }
    const result = await host.call('extra-new-session', { botId: 'b', sessionId: 'b' })
    assert.equal(result.ok, false)
    assert.equal(host.rt.chatOf('b'), 'b')
    assert.equal(host.state().bots.b.sessionId, 'b')
    assert.equal(host.state().bots.b.segments, undefined)
    assert.equal(host.archived.some(([id]) => id === 'b'), false)
    if (stage !== 'create') assert.equal(host.archived.some(([id]) => id === 's1'), true)
  })
})

test('增补新建会话拒绝重复请求并保留创建期间到达的用户消息', async t => {
  const host = await start()
  t.after(host.stop)
  let release
  let entered
  const creating = new Promise(resolve => { entered = resolve })
  const create = host.ctx.sessionController.create
  host.ctx.sessionController.create = async options => {
    entered()
    await new Promise(resolve => { release = resolve })
    return create(options)
  }
  const first = host.call('extra-new-session', { botId: 'b', sessionId: 'b' })
  await creating
  const second = await host.call('extra-new-session', { botId: 'b', sessionId: 'b' })
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'bot/busy')
  host.agentOf('b').inbox.nextTurn.push(said('late', '切换期间的新消息', 'late-exchange'))
  release()
  assert.equal((await first).ok, true)
  assert.equal(host.created.length, 1)
  assert.deepEqual(host.agentOf('s1').calls.map(([, message]) => text(message)), ['切换期间的新消息'])
  assert.deepEqual(inboxTexts(host.agentOf('b')), [])
})

test('增补新建会话转交失败时把尚未转交的输入留在旧会话，并由恢复流程转交一次', async t => {
  const host = await start()
  t.after(host.stop)
  const ensure = host.rt.ensureCapabilities
  host.rt.ensureCapabilities = async id => {
    if (id !== 's1') return ensure(id)
    const job = [...host.rt.switchJobs()][0]
    job.carry.push(said('late', '尚未转交的新输入', 'late-exchange'))
    throw new Error('能力检查暂时失败')
  }
  const result = await host.call('extra-new-session', { botId: 'b', sessionId: 'b' })
  assert.equal(result.ok, true)
  assert.equal(result.value.sessionId, 's1')
  assert.deepEqual(inboxTexts(host.agentOf('b')), ['尚未转交的新输入'])
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })
  assert.equal(host.archived.some(([id]) => id === 'b'), false)
  host.rt.ensureCapabilities = ensure
  await host.rt.heldBack()
  assert.deepEqual(host.agentOf('s1').calls.map(([, message]) => text(message)), ['尚未转交的新输入'])
  assert.deepEqual(inboxTexts(host.agentOf('b')), [])
  assert.deepEqual(host.state().switching, {})
})

test('增补新建会话在提交前重验取消、授权与设置变动，失败不归档原会话', async t => {
  for (const stage of ['cancel', 'authorization', 'settings']) await t.test(stage, async sub => {
    const host = await start()
    sub.after(host.stop)
    const abort = new AbortController()
    let authorized = true
    const caller = { authorize: () => authorized ? undefined : { code: 'bot/refused', message: '配对授权已撤销' } }
    const create = host.ctx.sessionController.create
    host.ctx.sessionController.create = async options => {
      const result = await create(options)
      if (stage === 'cancel') abort.abort()
      else if (stage === 'authorization') authorized = false
      else host.rt.botOf('b').effort = 'high'
      return result
    }
    await assert.rejects(host.rt.extraEndpoint('extra-new-session', { botId: 'b', sessionId: 'b' }, abort.signal, caller),
      error => error.code === (stage === 'settings' ? 'bot/stale' : 'bot/refused'))
    assert.equal(host.rt.chatOf('b'), 'b')
    assert.equal(host.archived.some(([id]) => id === 'b'), false)
    assert.equal(host.archived.some(([id]) => id === 's1'), true)
  })
})

test('增补新建会话在归档前迁移定时任务，群聊与后台任务保持原会话', async t => {
  const host = await start()
  t.after(host.stop)
  host.rt.state.rooms.r = { id: 'r', name: '群聊', members: ['b'], sessions: { b: 'group-b' } }
  host.rt.botOf('b').tasks = [{ id: 'task', sessionId: 'background', status: 'running' }]
  await host.rt.save()
  const moved = []
  host.rt.moveSchedules = async (from, to) => { moved.push([from, to]); assert.equal(host.archived.length, 0) }
  assert.equal((await host.call('extra-new-session', { botId: 'b', sessionId: 'b' })).ok, true)
  assert.deepEqual(moved, [['b', 's1']])
  assert.equal(host.state().rooms.r.sessions.b, 'group-b')
  assert.equal(host.state().bots.b.tasks[0].sessionId, 'background')
})

test('增补新建会话的定时迁移失败时保留恢复标记且不归档旧会话', async t => {
  const host = await start()
  t.after(host.stop)
  host.rt.moveSchedules = async () => { throw new Error('定时任务暂不可用') }
  const result = await host.call('extra-new-session', { botId: 'b', sessionId: 'b' })
  assert.equal(result.ok, true)
  assert.equal(result.value.sessionId, 's1')
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })
  assert.equal(host.archived.some(([id]) => id === 'b'), false)
})

test('主 Bot 的暂停回执接入真实新会话流程，保留身份、记忆配置、模型和旧历史', async t => {
  const host = await start()
  t.after(host.stop)
  const bot = host.rt.botOf('b')
  Object.assign(bot, { instructions: '保留角色与长期记忆', permission: 'read-only', extras: { messageMode: 'queue' }, memoryReview: { on: true } })
  const before = structuredClone(bot)
  const agent = host.agentOf('b'); agent.status = 'running'; host.rt.live.set('b', { turn: 1 })
  const canceled = []
  agent.cancel = reason => { canceled.push(reason); agent.status = 'idle'; host.rt.live.delete('b') }
  agent.session.requestHeader = () => ({ config: { provider: 'gateway', model: 'model', reasoningEffort: 'high' } })
  agent.session.deriveMessages = () => [{ role: 'assistant', content: [{ type: 'text', text: '不能复制旧对话' }] }]
  host.ctx.sessionController.fork = () => { throw new Error('不能 fork 历史') }
  host.ctx.llm.stream = () => { throw new Error('不能调用模型写摘要') }
  const pause = JSON.parse(await host.tool('pause_bot', { bot: 'Writer', reason: '会话思维链不兼容' }, 'a'))
  assert.equal(pause.paused, true); assert.equal(pause.new_session_ready, true); assert.equal(canceled.length, 1)
  const result = JSON.parse(await host.tool('new_bot_session', { bot: 'Writer', pause_id: pause.pause_id, reason: '替换故障会话' }, 'a'))
  assert.equal(result.session_changed, true); assert.equal(result.session_id, 's1'); assert.equal(result.recovery_verified, false)
  const { sessionId, segments, ...after } = host.state().bots.b
  const { sessionId: old, ...expected } = before
  assert.equal(old, 'b'); assert.equal(sessionId, 's1'); assert.deepEqual(after, expected)
  assert.deepEqual(segments.map(segment => segment.sessionId), ['b'])
  assert.deepEqual(host.agentOf('s1').calls, [])
  assert.deepEqual(host.archived, [['b', { stopActivity: true }]])
  await assert.rejects(host.tool('new_bot_session', { bot: 'Writer', pause_id: pause.pause_id, reason: '重复切换' }, 'a'), error => error.code === 'bot/stale')
  assert.equal(host.created.length, 1)
})

test('主 Bot 新会话创建中撤权或收到新输入时保留原会话，孤立新会话被归档', async t => {
  for (const stage of ['role', 'private', 'input', 'cancel']) await t.test(stage, async sub => {
    const host = await start(); sub.after(host.stop)
    host.rt.botOf('b').extras = { messageMode: 'queue' }
    const pause = JSON.parse(await host.tool('pause_bot', { bot: 'Writer', reason: '会话故障' }, 'a'))
    const abort = new AbortController()
    const create = host.ctx.sessionController.create
    host.ctx.sessionController.create = async options => {
      const result = await create(options)
      if (stage === 'role') host.rt.state.mainBotIds = ['b']
      else if (stage === 'private') host.rt.botOf('b').private = true
      else if (stage === 'cancel') abort.abort()
      else {
        const message = said('late-recovery', '不能丢掉的新输入')
        const agent = host.agentOf('b'); agent.inbox.nextTurn.push(message)
        host.ctx.emit('agent/inbox/inserted', { agent, message })
      }
      return result
    }
    const tool = host.rt.teamTools.find(def => def.name === 'new_bot_session')
    await assert.rejects(tool.execute({ bot: 'Writer', pause_id: pause.pause_id, reason: '替换故障会话' }, { agent: host.agentOf('a'), name: 'new_bot_session', signal: abort.signal }),
      error => error.code === (stage === 'input' ? 'bot/stale' : 'bot/refused'))
    assert.equal(host.rt.chatOf('b'), 'b')
    assert.equal(host.archived.some(([id]) => id === 'b'), false)
    assert.equal(host.archived.some(([id]) => id === 's1'), true)
    if (stage === 'input') assert.deepEqual(inboxTexts(host.agentOf('b')), ['不能丢掉的新输入'])
  })
})

test('主 Bot 的新会话回执明确报告定时交接未完成，不再重复创建', async t => {
  const host = await start(); t.after(host.stop)
  const pause = JSON.parse(await host.tool('pause_bot', { bot: 'Writer', reason: '会话故障' }, 'a'))
  host.rt.moveSchedules = async () => { throw new Error('定时任务暂不可用') }
  const result = JSON.parse(await host.tool('new_bot_session', { bot: 'Writer', pause_id: pause.pause_id, reason: '替换故障会话' }, 'a'))
  assert.equal(result.session_changed, true); assert.equal(result.session_id, 's1')
  assert.equal(result.handoff_pending, true); assert.equal(result.recovery_verified, false)
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })
  assert.equal(host.archived.some(([id]) => id === 'b'), false)
  await assert.rejects(host.tool('pause_bot', { bot: 'Writer', reason: '交接未完成时再暂停' }, 'a'), error => error.code === 'bot/busy')
  await assert.rejects(host.tool('new_bot_session', { bot: 'Writer', pause_id: pause.pause_id, reason: '再换一次' }, 'a'), error => error.code === 'bot/stale')
  assert.equal(host.created.length, 1)
})

test('私聊目标贯通真实端点、轮次结算、状态投影和停止链路', async t => {
  const host = await start(); t.after(host.stop)
  const response = await host.call('extra-goal-control', { botId: 'b', sessionId: 'b', action: 'start', objective: '完成报告', acceptance: '报告已核验' })
  assert.equal(response.ok, true)
  const goalId = response.value.id
  await host.rt.extraGoalTick()
  const agent = host.agentOf('b')
  const wakes = () => agent.calls.filter(([kind, message]) => kind === 'followup' && message.source?.role === 'private-goal')
  assert.equal(wakes().length, 1)
  host.emit('b', 'turn/start', { turn: 1 })
  host.emit('b', 'user/message', wakes()[0][1])
  host.emit('b', 'tool/call', { name: 'read', callId: 'goal-read', arguments: '{}' })
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: '完成了第一部分，现在继续。' }] } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await Promise.resolve()
  await host.rt.extraGoalTick()
  assert.equal(wakes().length, 2)
  const snapshot = (await host.call('state', {})).value
  assert.equal(snapshot.extras.privateGoal.schema, 1)
  const goal = snapshot.bots.find(bot => bot.id === 'b').extras.goal
  assert.equal(goal.id, goalId); assert.equal(goal.status, 'active')
  assert.equal(goal.activation, undefined); assert.equal(goal.runId, undefined)
  assert.equal((await host.call('stop-chat', { botId: 'b' })).value, true)
  await host.rt.extraGoalTick()
  assert.equal(wakes().length, 2)
  assert.equal(host.state().bots.b.extras.goal.status, 'paused')
  assert.deepEqual(await host.preStep('b', [wakes()[1][1]]), { kind: 'reject' })
})

test('手动新建私聊时保留目标和证据并暂停，不在新会话自动重放', async t => {
  const host = await start(); t.after(host.stop)
  const response = await host.call('extra-goal-control', { botId: 'b', sessionId: 'b', action: 'start', objective: '完成报告', acceptance: '报告已核验' })
  assert.equal(response.ok, true)
  const initial = response.value
  await host.tool('bot_goal', { action: 'progress', goal_id: initial.id, revision: initial.revision, progress: '第一部分完成', evidence: '第一部分.md' }, 'b')
  const fresh = await host.call('extra-new-session', { botId: 'b', sessionId: 'b' })
  assert.equal(fresh.ok, true)
  await host.rt.extraGoalTick()
  const goal = host.state().bots.b.extras.goal
  assert.equal(goal.id, initial.id); assert.equal(goal.status, 'paused'); assert.equal(goal.evidence, '第一部分.md')
  assert.equal(host.agentOf(fresh.value.sessionId).calls.some(([, message]) => message?.source?.role === 'private-goal'), false)
})

test('a configured small output limit is an ordinary cutoff, including reasoning-only output', async t => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'gateway', model: 'small-budget', maxTokens: 1024 } })
  for (const turn of [1, 2]) {
    host.emit('b', 'turn/start', { turn })
    host.emit('b', 'assistant/message', { message: { content: [] }, usage: { inputTokens: 129000, outputTokens: 1024 } })
    host.emit('b', 'turn/end', { turn, reason: { kind: 'max-tokens' } })
    host.ctx.emit('agent/status', { agent, status: 'idle' })
    await settle()
  }
  assert.equal(host.state().bots.b.sessionId, 'b')
  assert.deepEqual(host.created, [])
})
