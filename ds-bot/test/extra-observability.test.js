import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diagnosticItem, projectMessages } from '../src/host/extras/messages.js'
import { latestTodo, todoItems } from '../src/host/extras/todos.js'
import { displayText, redactText, redactValue } from '../src/shared/extras/redact.js'
import { install as installTools, toolsFromEvents } from '../src/host/extras/tools.js'

const start = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }
const call = (seq, callId, name, args) => ({ type: 'tool/call', seq, time: seq, data: { callId, name, arguments: args } })
const result = (seq, id, ok, text) => ({ type: 'tool/result', seq, time: seq, data: { message: { toolCallId: id, ok, content: [{ type: 'text', text }] } } })

function toolsRuntime(events, hidden = []) {
  const rt = {
    state: { exchangeTurns: { owned: hidden } },
    ctx: { get: () => undefined, sessionController: { page: async ({ address, beforeSeq, maxMessages }) => {
      assert.equal(address.sessionId, 'owned')
      const all = events.filter(event => beforeSeq === undefined || event.seq < beforeSeq)
      return { records: all.slice(-maxMessages).map(event => ({ event })), hasMore: all.length > maxMessages }
    } } },
    selfOf: id => id === 'owned' ? 'bot' : undefined,
    botOf: id => id === 'bot' ? { id: 'bot' } : undefined,
    groupOwners: new Map(), roomOwners: new Map(), pastOwners: new Map(),
    loadSecrets: async () => {}, redactSecrets: text => text.replaceAll('known-secret-value', '[secret:TEST]'), secretStoreStatus: () => ({ locked: false }),
  }
  installTools(rt)
  return rt
}

test('工具名与结果分开记录，未知结果不是成功，PTC 子调用不遗漏', () => {
  const tools = toolsFromEvents([start, call(2, 'c', 'read_file', '{}'), call(3, 'x', 'unknown', '{}'), result(4, 'c', false, 'failed'),
    { type: 'tool/ptc-dispatch-start', seq: 5, data: { callId: 'program', subCallId: 'child', name: 'bash', arguments: { command: 'pwd' } } }], 'owned')
  assert.equal(tools[0].name, 'read_file')
  assert.equal(tools[0].status, 'failed')
  assert.equal(tools[1].status, 'unconfirmed')
  assert.equal(tools[2].callId, 'child')
  assert.equal(toolsFromEvents([start, call(2, 'hidden', 'bash', '{}')], 'owned', { hidden: [1] }).length, 0)
})

test('工具详情按需分页、脱敏并拒绝跨会话及篡改游标', async () => {
  const rt = toolsRuntime([start, call(2, 'c', 'bash', '{"env":{"TOKEN":"bad"},"command":"known-secret-value"}'), result(3, 'c', true, 'x'.repeat(40000))])
  const args = await rt.extraToolDetail({ sessionId: 'owned', callId: 'c', callSeq: 2, field: 'arguments' }, undefined, { deviceKind: 'phone' })
  assert.equal(args.available, true)
  assert.equal(args.text.includes('"TOKEN"'), false)
  assert.equal(args.text.includes('known-secret-value'), false)
  const page = await rt.extraToolDetail({ sessionId: 'owned', callId: 'c', field: 'output' }, undefined, { deviceKind: 'phone' })
  assert.equal(page.text.length, 32768)
  assert.equal(page.nextOffset, 32768)
  const more = await rt.extraToolDetail({ sessionId: 'owned', callId: 'c', field: 'output', offset: page.nextOffset, digest: page.digest }, undefined, { deviceKind: 'phone' })
  assert.equal(more.nextOffset, null)
  assert.equal(page.text + more.text, 'x'.repeat(40000))
  await assert.rejects(rt.extraToolDetail({ sessionId: 'outside', callId: 'c', field: 'output' }, undefined, {}), { code: 'bot/not-found' })
  await assert.rejects(rt.extraToolDetail({ sessionId: 'owned', callId: 'c', field: 'output', offset: 40001 }, undefined, {}), { code: 'bot/invalid' })
  await assert.rejects(rt.extraToolDetail({ sessionId: 'owned', callId: 'c', field: 'output', digest: 'changed' }, undefined, {}), { code: 'bot/stale' })
})

test('未授权不能读取隐藏回合的工具，失败状态不会伪装成 job_output 输出', async () => {
  const rt = toolsRuntime([start, call(2, 'c', 'bash', '{}'), result(3, 'c', false, 'tool failed')], [1])
  await assert.rejects(rt.extraToolDetail({ sessionId: 'owned', callId: 'c', field: 'output' }, undefined, {}), { code: 'bot/refused' })
  const detail = await rt.extraToolDetail({ sessionId: 'owned', callId: 'c', field: 'output' }, undefined, { fullMessages: true })
  assert.equal(detail.status, 'failed')
  assert.equal(detail.text, 'tool failed')
})

test('密钥字段、URL 认证和常见 Token 脱敏；正文作为纯文本', () => {
  const value = redactValue({ headers: { Authorization: 'secret' }, password: 'hidden', token: 'hidden', safe: '<script>not executable</script>' })
  assert.equal(JSON.stringify(value).includes('hidden'), false)
  assert.equal(value.safe, '<script>not executable</script>')
  assert.equal(redactText('https://user:pass@example.com').includes('user:pass'), false)
  assert.equal(displayText('{"api_key":"test-value"}').includes('test-value'), false)
})

test('模型基本失败状态公开，内部协作和具体错误仅完整消息选项可见', () => {
  const error = { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', status: 401, message: 'token=secret-value', stack: 'trace' } } } }
  const basic = diagnosticItem(error, false)
  assert.equal(basic.text.includes('AUTH'), true)
  assert.equal(basic.text.includes('secret-value'), false)
  const full = diagnosticItem(error, true, redactText)
  assert.equal(full.text.includes('secret-value'), false)
  assert.equal(full.text.includes('认证错误正文已隐藏'), true)
  assert.equal(full.detail, undefined)
  assert.equal(diagnosticItem({ type: 'llm/retry-started', data: { turn: 1, step: 0 } }, false).title, '模型请求正在重试')
  const event = { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'bot', role: 'request', senderName: 'Worker' }, content: [{ type: 'text', text: '内部请求' }] } }
  assert.equal(projectMessages([], [event], 'owned').length, 0)
  assert.equal(projectMessages([], [event], 'owned', { fullMessages: true })[0].kind, 'internal')
})

test('待办来自成功工具调用，失败调用和普通聊天不能伪造任务完成', () => {
  const args = JSON.stringify({ todos: [{ content: '第一步', status: 'in_progress' }, { content: '第二步', status: 'pending' }] })
  assert.equal(todoItems(args).length, 2)
  assert.equal(todoItems({ todos: [{ content: '未知', status: 'maybe' }] }), undefined)
  assert.equal(latestTodo([start, call(2, 'c', 'todo_write', args), result(3, 'c', false, 'bad')]), undefined)
  assert.equal(latestTodo([start, call(2, 'c', 'todo_write', args), result(3, 'c', true, 'ok')]).items[0].status, 'in_progress')
  assert.equal(latestTodo([start, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '所有任务已完成' }] } } }]), undefined)
})
