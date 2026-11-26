import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/extras/tool-changes.js'
import { toolsFromEvents } from '../src/host/extras/tools.js'

const body = { sessionId: 'owned', callId: 'edit-1', callSeq: 1 }
const start = { type: 'turn/start', seq: 0, data: { turn: 1 } }
const call = { type: 'tool/call', seq: 1, data: { callId: 'edit-1', name: 'edit', arguments: '{"old_string":"参数旧字","new_string":"参数新字"}' } }
const result = { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'edit-1', isError: false, content: [] },
  meta: { diffs: [{ path: '/work/file.txt', oldText: '实际旧字', newText: '实际新字' }] } } }

function setup(events = [start, call, structuredClone(result)]) {
  let reads = 0
  const rt = { state: { exchangeTurns: {} }, ctx: { get: () => undefined, sessionController: {
    projections: async () => ({ kind: 'sequenced', asOfSeq: events.at(-1)?.seq ?? -1, values: {} }),
    page: async ({ throughSeq, beforeSeq }) => {
      assert.ok(Number.isSafeInteger(throughSeq) && throughSeq >= -1, 'throughSeq must be an integer greater than or equal to -1')
      reads += 1
      return { records: events.filter(event => event.seq <= throughSeq && (beforeSeq === undefined || event.seq < beforeSeq)).map(event => ({ event })), hasMore: false }
    },
  } }, selfOf: id => id === 'owned' ? 'bot' : undefined, botOf: () => ({ id: 'bot' }),
  loadSecrets: async () => {}, secretStoreStatus: () => ({ locked: false }), redactSecrets: value => value.replaceAll('fake-private', '[secret:TEST]') }
  install(rt)
  return { rt, events, reads: () => reads, read: (patch = {}, check = () => {}) => rt.extraToolChange({ ...body, ...patch }, undefined, { deviceKind: 'phone', fullMessages: true }, check) }
}

test('只使用成功结果的真实修改，缺失元数据或失败时不从参数补造', async () => {
  const f = setup()
  const page = await f.read()
  assert.equal(page.oldText, '实际旧字')
  assert.equal(page.newText, '实际新字')
  assert.equal(page.kind, 'hunk')
  assert.equal(page.source, 'tool-result')
  assert.equal(page.resultSeq, 2)
  assert.equal(page.oldAvailable, true)
  f.events[2].data.message.isError = true
  assert.equal((await f.read()).available, false)
  f.events[2].data.message.isError = false
  delete f.events[2].data.meta
  assert.equal((await f.read()).available, false)
  await assert.rejects(f.read({ sessionId: 'outside' }), { code: 'bot/not-found' })
})

test('部分补丁、缺失旧文本和有界分页保留原义，返回前脱敏', async () => {
  const f = setup()
  f.events[2].data.meta = { stopped: true, diffs: [
    { path: '/work/file.txt', oldText: null, newText: 'fake-private' },
    { path: '/work/other.txt', oldText: 'a', newText: 'b' },
  ] }
  const first = await f.read()
  assert.equal(first.stopped, true)
  assert.equal(first.oldText, null)
  assert.equal(first.oldAvailable, false)
  assert.equal(first.newText, '[secret:TEST]')
  assert.equal(first.redacted, true)
  assert.equal(first.nextIndex, 1)
  const second = await f.read({ index: first.nextIndex })
  assert.equal(second.path, '/work/other.txt')
  assert.equal(second.nextIndex, null)
  await assert.rejects(f.read({ digest: second.digest }), { code: 'bot/stale' })
  f.events[2].data.meta.diffs[0].newText = 'x'.repeat(64 * 1024 + 1)
  assert.equal((await f.read()).available, false)
  assert.equal((await f.read()).nextIndex, 1)
})

test('PTC 按公开持久事件字段读取结果和父调用，原生结果不依赖旧 ok 字段', async () => {
  const ptcStart = { type: 'tool/ptc-dispatch-start', seq: 1, data: { rootCallId: 'outer', parentCallId: 'nested', subCallId: 'edit-1', name: 'edit', arguments: {} } }
  const ptcResult = { type: 'tool/ptc-dispatch', seq: 2, data: { ...ptcStart.data, isError: false, content: [], meta: structuredClone(result.data.meta) } }
  const f = setup([start, ptcStart, ptcResult])
  assert.equal((await f.read()).newText, '实际新字')
  const step = toolsFromEvents(f.events, 'owned')[0]
  assert.equal(step.parentCallId, 'nested')
  assert.equal(step.status, 'success')
  assert.equal(step.ok, true)
  assert.equal(toolsFromEvents([start, call, result], 'owned')[0].status, 'success')
})

test('同编号的新调用不能替换旧调用的实际修改结果', async () => {
  const secondCall = { ...call, seq: 4 }
  const secondResult = structuredClone(result)
  secondResult.seq = 5
  secondResult.data.meta.diffs[0].newText = '下一次修改'
  const f = setup([start, call, structuredClone(result), secondCall, secondResult])
  assert.deepEqual(toolsFromEvents(f.events, 'owned').map(item => item.callSeq), [1, 4])
  assert.equal((await f.read()).newText, '实际新字')
  assert.equal((await f.read({ callSeq: 4 })).newText, '下一次修改')
})

test('读取等待期间撤销或归属变化拒绝旧回包，锁定密钥库不传输', async () => {
  const f = setup()
  let allowed = true
  const check = () => { if (!allowed) throw Object.assign(new Error('已撤销'), { code: 'bot/refused' }) }
  f.rt.loadSecrets = async () => { allowed = false }
  await assert.rejects(f.read({}, check), { code: 'bot/refused' })
  f.rt.loadSecrets = async () => { f.rt.selfOf = () => undefined }
  await assert.rejects(f.read(), { code: 'bot/not-found' })
  const locked = setup()
  locked.rt.secretStoreStatus = () => ({ locked: true })
  await assert.rejects(locked.read(), { code: 'bot/unavailable' })
})
