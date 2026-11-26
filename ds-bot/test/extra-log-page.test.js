import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyThroughSeq, logPage, turnAt } from '../src/host/extras/log-page.js'

const event = seq => ({ type: 'tool/call', seq, time: seq, data: { callId: `call-${seq}`, name: 'read', arguments: '{}' } })
function fixture(events = [event(0), event(1), event(2)]) {
  const agents = new Map(), reads = [], projections = []
  const rt = { ctx: { get: name => name === 'agents' ? agents : undefined,
    sessionController: {
      projections: async ({ sessionId }, signal) => {
        projections.push({ sessionId, signal })
        return { kind: 'sequenced', asOfSeq: events.at(-1)?.seq ?? -1, values: {} }
      },
      // 对应 0.2.1-rc.5 必填契约；旧实现漏参时直接失败，不能让宽松 mock 掩盖。
      page: async (request, signal) => {
        const { throughSeq, beforeSeq } = request
        assert.ok(Number.isSafeInteger(throughSeq) && throughSeq >= -1 && !Object.is(throughSeq, -0), 'throughSeq must be an integer greater than or equal to -1')
        reads.push({ ...request, signal })
        const all = events.filter(row => row.seq <= throughSeq && (beforeSeq === undefined || row.seq < beforeSeq))
        return { records: all.slice(-2).map(event => ({ type: 'event', event })), hasMore: all.length > 2 }
      },
      resolveAgent: () => { assert.fail('历史读取不能激活 Agent') },
    },
  }, resolveAgent: () => { assert.fail('历史读取不能激活 Agent') } }
  return { rt, agents, reads, projections, events, scope: { id: 's', minSeq: 0 } }
}

test('工具日志首段显式携带真实截止序号；旧会话只读被动投影，不恢复 Agent', async () => {
  const f = fixture()
  const page = await logPage(f.rt, f.scope)
  assert.deepEqual(page.events.map(row => row.seq), [1, 2])
  assert.equal(page.beforeSeq, 1)
  assert.equal(f.projections.length, 1)
  assert.equal(f.reads[0].throughSeq, 2)
  assert.deepEqual(f.reads[0].address, { kind: 'session', sessionId: 's' })
})
test('热会话使用现有 session.seq 的前一项，非法 seq 回到真实投影而不传 NaN', async () => {
  const f = fixture(); f.agents.set('s', { session: { seq: 3 } })
  assert.equal(await historyThroughSeq(f.rt, 's'), 2); assert.equal(f.projections.length, 0)
  for (const seq of [undefined, NaN, Infinity, '3', -1, 0.5]) {
    f.agents.set('s', { session: { seq } })
    assert.equal(await historyThroughSeq(f.rt, 's'), 2)
  }
})
test('同次翻页与轮次回溯冻结切面，读取期间新工具不会混入旧调用', async () => {
  const f = fixture([{ type: 'turn/start', seq: 0, data: { turn: 7 } }, event(1), event(2), event(3)])
  const first = await logPage(f.rt, f.scope)
  f.events.push(event(4), event(5))
  const second = await logPage(f.rt, f.scope, first.beforeSeq)
  assert.deepEqual(second.events.map(row => row.seq), [0, 1])
  assert.equal(await turnAt(f.rt, f.scope, 1), 7)
  assert.ok(f.reads.every(read => read.throughSeq === 3)); assert.equal(f.projections.length, 1)
  const refreshed = await logPage(f.rt, { id: 's', minSeq: 0 })
  assert.deepEqual(refreshed.events.map(row => row.seq), [4, 5])
})
test('空日志确认为 -1 后返回空；序号 0 的真实事件正常保留', async () => {
  const empty = fixture([])
  assert.deepEqual(await logPage(empty.rt, empty.scope), { events: [], beforeSeq: null })
  assert.equal(empty.scope.throughSeq, -1); assert.equal(empty.reads.length, 0)
  const one = fixture([event(0)])
  assert.deepEqual((await logPage(one.rt, one.scope)).events.map(row => row.seq), [0])
  assert.equal(one.reads[0].throughSeq, 0)
})
test('迁移、缓存或非法投影不能伪装成空历史，也不发出无截止序号的页请求', async () => {
  for (const baseline of [undefined, { kind: 'migration-required', values: {} }, { kind: 'cached', asOfSeq: 3 },
    ...[undefined, null, '3', NaN, Infinity, -2, -0, 1.5].map(asOfSeq => ({ kind: 'sequenced', asOfSeq }))]) {
    const f = fixture(); f.rt.ctx.sessionController.projections = async () => baseline
    await assert.rejects(logPage(f.rt, f.scope), { code: 'bot/unavailable' })
    assert.equal(f.reads.length, 0)
  }
  const missing = fixture(); missing.rt.ctx.sessionController.projections = async () => null
  await assert.rejects(logPage(missing.rt, missing.scope), { code: 'bot/not-found' })
})
test('读取投影期间取消不继续分页，页回包到达后已取消也不返回正文', async () => {
  const f = fixture(); const controller = new AbortController()
  f.rt.ctx.sessionController.projections = async () => { controller.abort(); return { kind: 'sequenced', asOfSeq: 2 } }
  await assert.rejects(logPage(f.rt, f.scope, undefined, controller.signal), { code: 'bot/refused' })
  assert.equal(f.reads.length, 0)
  const second = fixture(); const canceled = new AbortController()
  const read = second.rt.ctx.sessionController.page
  second.rt.ctx.sessionController.page = async (...args) => { const result = await read(...args); canceled.abort(); return result }
  await assert.rejects(logPage(second.rt, second.scope, undefined, canceled.signal), { code: 'bot/refused' })
})
test('任务起始边界仍过滤继承历史，授权拒绝不回退其他数据源', async () => {
  const f = fixture(); f.scope.minSeq = 2
  const page = await logPage(f.rt, f.scope)
  assert.deepEqual(page.events.map(row => row.seq), [2]); assert.equal(page.beforeSeq, null)
  const denied = fixture()
  denied.rt.ctx.sessionController.projections = async () => { throw Object.assign(new Error('refused'), { code: 'session/refused' }) }
  await assert.rejects(logPage(denied.rt, denied.scope), { code: 'session/refused' })
  assert.equal(denied.reads.length, 0)
})
