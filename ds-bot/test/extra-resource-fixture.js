import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { install } from '../src/host/extras/index.js'

export const resourceTarget = { scope: { kind: 'bot', botId: 'bot' }, sessionId: 'current' }
export const resourceDevice = { deviceId: 'device', kind: 'browser', identityKey: 'test-public', pairedAt: 10 }

export function resourceBench(t, { traceServices = false } = {}) {
  const files = new Map(), processes = [], disposers = [], listeners = new Map(), writes = []
  let version = 0, reads = 0, observed = 0
  const put = (path, content = '', type = 'file') => files.set(path, { content: Buffer.isBuffer(content) ? content : Buffer.from(content), type, version: String(++version) })
  put('/work', '', 'directory')
  put('/work/readme.txt', '原内容\n')
  put('/work/other.txt', '第二个文件\n')
  put('/work/.env', 'TEST_KEY=fake-only')
  const at = (path, cwd = '/work') => posix.resolve(cwd, path)
  const target = path => ({ targetKey: path, displayPath: path })
  const stat = path => {
    const item = files.get(path)
    return item ? { type: item.type, version: item.version, size: item.content.length } : undefined
  }
  const fs = {
    resolve: async (path, options) => target(at(path, options?.cwd)),
    processPath: item => item.displayPath, processPathFromHostPath: () => undefined,
    contains: (parent, child) => child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`),
    stat: async item => stat(item.targetKey),
    lstat: async (path, options) => stat(at(path, options?.cwd)),
    readBytes: async (item, _signal, maxBytes) => {
      reads += 1
      const stored = files.get(item.targetKey)
      if (!stored) throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' })
      if (stored.content.length > maxBytes) throw Object.assign(new Error('large'), { code: 'FS_TOO_LARGE' })
      return Buffer.from(stored.content)
    },
    listDir: async parent => [...files].filter(([path]) => path !== parent.targetKey && posix.dirname(path) === parent.targetKey)
      .map(([path, value]) => ({ name: posix.basename(path), type: value.type, version: value.version, size: value.content.length, target: target(path) }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    writeText: async (item, content, expected) => {
      writes.push({ path: item.targetKey, expected })
      await f.beforeWrite?.()
      const stored = files.get(item.targetKey)
      if (expected?.kind !== 'replaceIfVersion' || stored?.version !== expected.version) throw Object.assign(new Error('conflict'), { code: 'FS_STALE_VERSION' })
      const before = stored.content.toString('utf8')
      put(item.targetKey, content)
      return { operation: 'update', version: files.get(item.targetKey).version, before, after: content }
    },
  }
  const query = { observeSession: async (sessionId, options) => {
    assert.equal(options.projectionMode, 'all')
    observed += 1
    return { header: { id: sessionId, cwd: '/work' }, cursor: -1,
      projections: { asOfSeq: -1, values: { workingDirectory: f.cwd } }, [Symbol.dispose]() {} }
  } }
  const subprocess = {
    terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/bash' }),
    resolveExecutable: async command => command,
    spawnTerminal: async spec => {
      assert.deepEqual(spec.argv, ['/bin/bash', '-i'])
      assert.equal(spec.cwd, '/work')
      assert.equal(spec.terminalType, 'xterm-256color')
      const output = new PassThrough()
      let settle
      const process = { output, done: new Promise(resolve => { settle = resolve }), inputs: [], sizes: [], closed: 0,
        write: async data => { process.inputs.push(data); await f.onInput?.() },
        resize: async (cols, rows) => { process.sizes.push([cols, rows]) },
        terminate: async () => { process.closed += 1; output.end(); settle({ exitCode: 0, signal: null }) },
        exit: code => { output.end(); settle({ exitCode: code, signal: null }) },
      }
      processes.push(process)
      return process
    },
  }
  const providers = { fs, sessionQuery: query, subprocess }
  const serviceContext = traceServices ? new Context() : null
  if (serviceContext) for (const [name, provider] of Object.entries(providers)) {
    Object.defineProperty(provider, Service.tracker, { value: { property: 'ctx' } })
    provider.ctx = serviceContext
    serviceContext.provide(name, provider)
  }
  const bot = { id: 'bot', sessionId: 'current' }, other = { id: 'other', sessionId: 'other-current' }
  const rt = {
    state: { extras: {}, workspaceId: 'workspace', bots: { bot, other }, rooms: {}, switching: {} },
    ctx: {
      get: name => serviceContext ? serviceContext.get(name) : providers[name],
      workspaceRegistry: { get: () => ({ path: '/work' }) },
      on: (name, callback) => (listeners.get(name) ?? listeners.set(name, []).get(name)).push(callback),
      effect: (effect, name) => { if (['ds-bot: 增补工作区资源', 'ds-bot: 增补服务器终端'].includes(name)) disposers.push(effect()) },
    },
    load: async () => {}, save: async () => {}, readOnly: () => undefined, addTeamTool: () => {},
    botOf: id => rt.state.bots[id], chatOf: id => rt.state.bots[id]?.sessionId, roomOf: id => rt.state.rooms[id], sessionOfRoom: room => room?.sessionId,
    selfOf: id => rt.chatOwners.get(id),
    chatOwners: new Map([['current', 'bot'], ['other-current', 'other']]), taskOwners: new Map(), groupOwners: new Map(), roomOwners: new Map(), pastOwners: new Map(),
    loadSecrets: async () => {}, secretStoreStatus: () => ({ locked: false }), redactSecrets: value => value.replaceAll('fake-private-value', '[secret:TEST]'),
    extraPairedDevices: () => [resourceDevice, { ...resourceDevice, deviceId: 'reader' }],
  }
  install(rt)
  const grant = async (resources, device = resourceDevice) => rt.extraEndpoint('phone-extra-set', { deviceId: device.deviceId, pairedAt: device.pairedAt, resources })
  const call = (endpoint, body, { device = resourceDevice, signal, local = false } = {}) => rt.extraEndpoint(endpoint, body, signal, local ? undefined : {
    authorize: () => rt.extraRemoteAccessError(device, endpoint, body),
    resources: () => rt.extraResourceAccess(device), deviceKind: () => device.kind, fullMessages: () => rt.extraFullMessagesAllowed(device),
  })
  const f = { rt, bot, files, fs, query, subprocess, processes, writes, put, grant, call, cwd: '/work', reads: () => reads, observed: () => observed,
    replaceService: (name, value) => serviceContext ? serviceContext.set(name, value) : (providers[name] = value) }
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); await serviceContext?.fiber.dispose() })
  return f
}
