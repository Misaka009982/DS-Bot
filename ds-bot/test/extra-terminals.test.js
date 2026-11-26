import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { resourceBench, resourceTarget, resourceDevice } from './extra-resource-fixture.js'
import { terminalBuffer } from '../src/host/extras/terminals.js'

const create = (f, requestId = 'create-1') => f.call('extra-terminal-create', { ...resourceTarget, requestId, cols: 80, rows: 24 })

test('资源权限默认拒绝且不被完整消息授权替代；读取不创建 PTY', async t => {
  const f = resourceBench(t)
  await assert.rejects(create(f), { code: 'bot/refused' })
  await f.rt.extraEndpoint('phone-extra-set', { deviceId: resourceDevice.deviceId, pairedAt: 10, fullMessages: true })
  await assert.rejects(create(f), { code: 'bot/refused' })
  await f.grant({ terminalRead: true })
  assert.deepEqual((await f.call('extra-terminal-list', resourceTarget)).items, [])
  await assert.rejects(create(f), { code: 'bot/refused' })
  assert.equal(f.processes.length, 0)
  assert.equal(f.observed(), 0)
})

test('服务卸载时远程状态不复用本机旧能力的读写授权', async t => {
  const f = resourceBench(t)
  const before = { extras: f.rt.extraView() }
  assert.equal(before.extras.terminals.write, true)
  f.rt.ctx.get = () => undefined
  const view = f.rt.extraRemoteState(before, resourceDevice)
  assert.equal(view.extras.terminals, undefined)
  assert.equal(view.extras.workspace, undefined)
  assert.equal(view.extras.toolChanges.read, false)
  assert.equal(before.extras.terminals.write, true)
})

test('真实Cordis代理的PTY提供方不误报更换，实际更换仍阻止创建', async t => {
  const f = resourceBench(t, { traceServices: true })
  await f.grant({ terminalRead: true, terminalWrite: true })
  assert.notEqual(f.rt.ctx.get('subprocess'), f.rt.ctx.get('subprocess'))
  const opened = await create(f)
  assert.equal(opened.status, 'running'); assert.equal(f.processes.length, 1)
  await f.call('extra-terminal-close', { handleId: opened.handleId })
  const resolve = f.subprocess.resolveExecutable
  f.subprocess.resolveExecutable = async (...args) => {
    const path = await resolve(...args)
    f.replaceService('subprocess', { ...f.subprocess })
    return path
  }
  await assert.rejects(create(f, 'replacement'), { code: 'bot/unavailable' })
  assert.equal(f.processes.length, 1)
})
test('真实 PTY 创建幂等，输出保留字节和偏移，重复输入只投递一次', async t => {
  const f = resourceBench(t)
  await f.grant({ terminalRead: true, terminalWrite: true })
  const opened = await create(f)
  assert.equal((await create(f)).terminalId, opened.terminalId)
  assert.equal(f.processes.length, 1)
  const process = f.processes[0]
  process.output.write(Buffer.from('你好\x1b[31m终端\x1b[0m'))
  await setImmediate()
  const page = await f.call('extra-terminal-read', { handleId: opened.handleId, offset: 0 })
  assert.equal(Buffer.from(page.data, 'base64').toString('utf8'), '你好\x1b[31m终端\x1b[0m')
  assert.equal(page.truncated, false)
  assert.equal((await f.call('extra-terminal-read', { handleId: opened.handleId, offset: page.nextOffset })).data, '')
  const input = { handleId: opened.handleId, sequence: 1, data: 'echo test\r' }
  assert.equal((await f.call('extra-terminal-input', input)).status, 'accepted')
  assert.equal((await f.call('extra-terminal-input', input)).status, 'accepted')
  assert.deepEqual(process.inputs, ['echo test\r'])
  await assert.rejects(f.call('extra-terminal-input', { ...input, data: 'other\r' }), { code: 'bot/stale' })
  await f.call('extra-terminal-resize', { handleId: opened.handleId, sequence: 2, cols: 100, rows: 40 })
  assert.deepEqual(process.sizes, [[100, 40]])
  process.exit(7)
  await setImmediate()
  const exited = await f.call('extra-terminal-read', { handleId: opened.handleId, offset: page.nextOffset })
  assert.equal(exited.status, 'exited')
  assert.equal(exited.exitCode, 7)
})

test('只读设备可观察插件用户终端，不抢输入权、不接管其他设备句柄', async t => {
  const f = resourceBench(t)
  const reader = { ...resourceDevice, deviceId: 'reader' }
  await f.grant({ terminalRead: true, terminalWrite: true })
  const opened = await create(f)
  await f.grant({ terminalRead: true }, reader)
  const listed = await f.call('extra-terminal-list', resourceTarget, { device: reader })
  assert.equal(listed.items[0].writable, false)
  assert.notEqual(listed.items[0].handleId, opened.handleId)
  await f.call('extra-terminal-read', { handleId: listed.items[0].handleId, offset: 0 }, { device: reader })
  await assert.rejects(f.call('extra-terminal-read', { handleId: opened.handleId, offset: 0 }, { device: reader }), { code: 'bot/stale' })
  await f.grant({ terminalWrite: true }, reader)
  const readerHandle = (await f.call('extra-terminal-list', resourceTarget, { device: reader })).items[0]
  await assert.rejects(f.call('extra-terminal-close', { handleId: readerHandle.handleId }, { device: reader }), { code: 'bot/refused' })
  assert.deepEqual(f.processes[0].inputs, [])
  assert.equal(f.processes[0].closed, 0)
})

test('撤销后重新授权也不能复用旧句柄，换会话或未确认输入不重放', async t => {
  const f = resourceBench(t)
  await f.grant({ terminalRead: true, terminalWrite: true })
  const old = await create(f)
  await f.grant({ terminalWrite: false })
  await assert.rejects(f.call('extra-terminal-input', { handleId: old.handleId, sequence: 1, data: 'no' }), { code: 'bot/refused' })
  await f.grant({ terminalWrite: true })
  await assert.rejects(f.call('extra-terminal-read', { handleId: old.handleId, offset: 0 }), { code: 'bot/stale' })
  const current = (await f.call('extra-terminal-list', resourceTarget)).items[0]
  f.onInput = () => { throw new Error('provider lost connection') }
  const request = { handleId: current.handleId, sequence: 1, data: 'once' }
  assert.equal((await f.call('extra-terminal-input', request)).status, 'unknown')
  assert.equal((await f.call('extra-terminal-input', request)).status, 'unknown')
  await assert.rejects(f.call('extra-terminal-input', { ...request, sequence: 2 }), { code: 'bot/outcome-unknown' })
  assert.deepEqual(f.processes[0].inputs, ['once'])
  f.bot.sessionId = 'next'
  await assert.rejects(f.call('extra-terminal-read', { handleId: current.handleId, offset: 0 }), { code: 'bot/stale' })
  const cleanup = (await f.call('extra-terminal-list', { owned: true })).items[0]
  assert.equal(cleanup.cleanupOnly, true)
  assert.equal(cleanup.writable, false)
  await assert.rejects(f.call('extra-terminal-read', { handleId: cleanup.handleId, offset: 0 }), { code: 'bot/refused' })
  assert.equal((await f.call('extra-terminal-close', { handleId: cleanup.handleId })).status, 'closed')
  assert.equal(f.processes[0].closed, 1)
})

test('关闭等待真实 terminate 确认，重复关闭不创建也不再次输入', async t => {
  const f = resourceBench(t)
  await f.grant({ terminalRead: true, terminalWrite: true })
  const opened = await create(f)
  f.processes[0].output.write(Buffer.from('关闭前的尾部输出'))
  assert.equal((await f.call('extra-terminal-close', { handleId: opened.handleId })).status, 'closed')
  const tail = await f.call('extra-terminal-read', { handleId: opened.handleId, offset: 0 })
  assert.equal(Buffer.from(tail.data, 'base64').toString('utf8'), '关闭前的尾部输出')
  assert.equal(tail.outputEnded, true)
  assert.equal(tail.status, 'closed'); assert.equal(tail.exitCode, 0)
  assert.equal((await f.call('extra-terminal-close', { handleId: opened.handleId })).status, 'closed')
  assert.equal(f.processes[0].closed, 1)
  await assert.rejects(create(f), { code: 'bot/stale' })
  assert.equal(f.processes.length, 1)
})

test('关闭须等待输出与done各自结算，迟到退出码不丢失', async t => {
  const f = resourceBench(t)
  await f.grant({ terminalRead: true, terminalWrite: true })
  const opened = await create(f)
  const process = f.processes[0]
  process.terminate = async () => { process.closed += 1; process.output.end() }
  let settled = false
  const closing = f.call('extra-terminal-close', { handleId: opened.handleId }).then(result => { settled = true; return result })
  await setImmediate()
  assert.equal(settled, false)
  const interim = await f.call('extra-terminal-read', { handleId: opened.handleId, offset: 0 })
  assert.equal(interim.status, 'closing'); assert.equal(interim.outputEnded, true)
  process.exit(7)
  const result = await closing
  assert.equal(result.status, 'closed'); assert.equal(result.exitCode, 7)
})
test('输出环形预算报告截断且不伪造屏幕快照', () => {
  const output = terminalBuffer(8)
  output.append(Buffer.from('12345'))
  output.append(Buffer.from('67890abc'))
  const page = output.read(0)
  assert.equal(Buffer.from(page.data, 'base64').toString(), '67890abc')
  assert.equal(page.from, 5)
  assert.equal(page.nextOffset, 13)
  assert.equal(page.truncated, true)
  assert.throws(() => output.read(14), { code: 'bot/invalid' })
})
