import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extraChatRead } from '../src/client/extras/chat-read.js'

const cursor = { part: 0, beforeSeq: 3 }
const targets = [
  { label: '私聊', target: { botId: 'b1', cursor }, payload: { botId: 'b1', cursor, steps: true }, fallback: 'chat' },
  { label: '群聊', target: { roomId: 'r1', botId: 'b1', cursor }, payload: { roomId: 'r1', cursor, steps: true }, fallback: 'room-chat' },
]

for (const { label, target, payload, fallback } of targets) {
  test(`增强${label}读取保持单一目标、游标和步骤参数`, async () => {
    const calls = []
    const page = { items: [], cursor: null }
    const result = await extraChatRead(async (endpoint, body) => {
      calls.push([endpoint, body])
      return page
    }, target)
    assert.equal(result, page)
    assert.deepEqual(calls, [['extra-messages', payload]])
  })

  test(`旧服务器只在缺失增补接口时回退${label}读取`, async () => {
    const calls = []
    const page = { items: [], cursor: null }
    const result = await extraChatRead(async (endpoint, body) => {
      calls.push([endpoint, body])
      if (endpoint === 'extra-messages') throw Object.assign(new Error('Unknown endpoint extra-messages'), { code: 'bot/not-found' })
      return page
    }, target)
    assert.equal(result, page)
    assert.deepEqual(calls, [['extra-messages', payload], [fallback, payload]])
  })
}

const failures = [
  ['授权拒绝', Object.assign(new Error('测试拒绝 extra-messages 授权'), { code: 'bot/refused' })],
  ['服务未就绪', Object.assign(new Error('测试增补服务未就绪'), { code: 'bot/unavailable' })],
  ['网络错误', Object.assign(new Error('测试连接失败'), { code: 'ECONNRESET' })],
  ['其他不存在错误', Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })],
  ['没有错误码', new Error('Unknown endpoint extra-messages')],
]

for (const [label, failure] of failures) test(`${label}保持原错误，不降级到旧聊天接口`, async () => {
  const calls = []
  await assert.rejects(extraChatRead(async endpoint => {
    calls.push(endpoint)
    throw failure
  }, { roomId: 'r1' }), error => error === failure)
  assert.deepEqual(calls, ['extra-messages'])
})
