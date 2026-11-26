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

test('工具详情按需分页、仅遮盖敏感值并拒绝跨会话及篡改游标', async () => {
  const rt = toolsRuntime([start, call(2, 'c', 'bash', '{"env":{"TOKEN":"bad","NODE_ENV":"production"},"command":"known-secret-value"}'), result(3, 'c', true, 'x'.repeat(40000))])
  const args = await rt.extraToolDetail({ sessionId: 'owned', callId: 'c', callSeq: 2, field: 'arguments' }, undefined, { deviceKind: 'phone' })
  assert.equal(args.available, true)
  assert.deepEqual(JSON.parse(args.text).env, { TOKEN: '[已脱敏]', NODE_ENV: 'production' })
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

test('普通 headers、env、environment 和 JSON data 保留正文，嵌套密钥只遮盖值', () => {
  const input = {
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'request-1', Authorization: 'opaque-auth', Cookie: 'opaque-cookie', 'X-Api-Key': 'fake-opaque-header-key' },
    env: { NODE_ENV: 'production', OPENAI_API_KEY: 'opaque-env-key', GITHUB_TOKEN: 'opaque-env-token', DATABASE_PASSWORD: 'opaque-password', DSH_SECRET_OTHER: 'opaque-dsh-secret' },
    environment: { PATH: 'C:/Project/bin' },
    data: { text: '正常工具输出', rows: [1, 2], tokenCount: 42, secret: 'fake-opaque-data-secret' },
    message: 'known-secret-value',
  }
  const value = redactValue(input, text => text.replaceAll('known-secret-value', '[secret:TEST]'))
  assert.deepEqual(value.headers, { 'Content-Type': 'application/json', 'X-Request-Id': 'request-1', Authorization: '[已脱敏]', Cookie: '[已脱敏]', 'X-Api-Key': '[已脱敏]' })
  assert.deepEqual(value.env, { NODE_ENV: 'production', OPENAI_API_KEY: '[已脱敏]', GITHUB_TOKEN: '[已脱敏]', DATABASE_PASSWORD: '[已脱敏]', DSH_SECRET_OTHER: '[已脱敏]' })
  assert.deepEqual(value.environment, input.environment)
  assert.deepEqual(value.data, { text: '正常工具输出', rows: [1, 2], tokenCount: 42, secret: '[已脱敏]' })
  assert.equal(value.message, '[secret:TEST]')
  assert.equal(JSON.stringify(value).includes('opaque-'), false)
  assert.equal(input.env.OPENAI_API_KEY, 'opaque-env-key', '展示脱敏不能修改原始数据')
  assert.deepEqual(JSON.parse(displayText(JSON.stringify(input))).data, value.data)
})

test('敏感 Header 名值数组和普通业务数组分别处理', () => {
  const value = redactValue({ headers: [['Accept', 'application/json'], ['Authorization', 'opaque-auth'], ['X-Api-Key', 'opaque-key']], data: [['name', 'Alpha'], ['count', 3]] })
  assert.deepEqual(value.headers, [['Accept', 'application/json'], ['Authorization', '[已脱敏]'], ['X-Api-Key', '[已脱敏]']])
  assert.deepEqual(value.data, [['name', 'Alpha'], ['count', 3]])
})

test('纯文本 HTTP 认证和 Cookie 值仍遮盖，正常命令及路径不遮盖', () => {
  const text = redactText('Content-Type: application/json\nAuthorization: Custom opaque-auth\nCookie: session=opaque-cookie; other=opaque-other\nX-Api-Key: opaque-key\nPATH=C:/Project/bin\n工具执行完成')
  assert.match(text, /Content-Type: application\/json/)
  assert.match(text, /PATH=C:\/Project\/bin/)
  assert.match(text, /工具执行完成/)
  assert.equal(text.includes('opaque-'), false)
  assert.equal(displayText('正常输出：C:/Project/file.txt'), '正常输出：C:/Project/file.txt')
})

test('常见服务凭据与字段别名受保护，普通业务键和字段名称列表保留', () => {
  const input = {
    env: { AWS_SECRET_ACCESS_KEY: 'opaque-aws-secret', AWS_ACCESS_KEY_ID: 'opaque-aws-id', AWS_SESSION_TOKEN: 'opaque-aws-token', GEMINI_KEY: 'opaque-gemini-key', OPENAI_KEY: 'opaque-openai-key', DSH_SECRET_DATABASE: 'opaque-dsh-secret', NODE_ENV: 'production', SORT_KEY: 'createdAt' },
    data: { awsSecretAccessKey: 'opaque-camel-secret', apiKeyName: 'provider', tokenCount: 4, publicKey: 'public-material', columns: ['token', 'description'] },
    envNames: ['OPENAI_API_KEY', 'GITHUB_TOKEN'], words: ['password', 'metadata'],
  }
  const before = structuredClone(input)
  const value = redactValue(input)
  for (const key of ['AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN', 'GEMINI_KEY', 'OPENAI_KEY', 'DSH_SECRET_DATABASE']) assert.equal(value.env[key], '[已脱敏]', key)
  assert.equal(value.env.NODE_ENV, 'production'); assert.equal(value.env.SORT_KEY, 'createdAt')
  assert.equal(value.data.awsSecretAccessKey, '[已脱敏]')
  assert.equal(value.data.apiKeyName, 'provider'); assert.equal(value.data.tokenCount, 4); assert.equal(value.data.publicKey, 'public-material')
  assert.deepEqual(value.data.columns, input.data.columns); assert.deepEqual(value.envNames, input.envNames); assert.deepEqual(value.words, input.words)
  assert.equal(JSON.stringify(value).includes('opaque-'), false)
  assert.deepEqual(input, before)
  const command = redactText("AWS_SECRET_ACCESS_KEY='opaque-aws-secret' GEMINI_KEY=opaque-gemini-key DSH_SECRET_DATABASE=opaque-dsh-secret secret=opaque-secret WORKER_SECRET=opaque-worker-secret NODE_ENV=production")
  assert.equal(command.includes('opaque-'), false)
  assert.match(command, /NODE_ENV=production/)
})

test('真实密钥替换产生的名称标记保留，输入伪造的 secret 标记不绕过保护', () => {
  const known = value => value.replaceAll('known-secret-value', '[secret:TEST]')
  assert.equal(redactText('before known-secret-value after', known), 'before [secret:TEST] after')
  assert.equal(redactText('known-secret-value.', known), '[secret:TEST].')
  assert.equal(redactText('[secret:opaque-value]').includes('opaque-value'), false)
  assert.equal(redactText('secret=opaque-value').includes('opaque-value'), false)
})

test('名值数组和命名值对象保护凭据，不将普通字符串数组当作密码值', () => {
  const input = {
    headers: [['Accept', 'application/json'], ['Authorization', 'opaque-auth']],
    env: [{ name: 'AWS_SECRET_ACCESS_KEY', value: 'opaque-env-secret' }, { key: 'NODE_ENV', value: 'production' }],
    params: [{ name: 'api_key', value: 'opaque-query-key' }, { name: 'query', value: 'hello' }],
    data: [['password', 'opaque-nested-secret'], ['count', 3]],
    fields: ['api_key', 'token'], columns: ['token', 'description'],
  }
  const value = redactValue(input)
  assert.deepEqual(value.headers, [['Accept', 'application/json'], ['Authorization', '[已脱敏]']])
  assert.deepEqual(value.env, [{ name: 'AWS_SECRET_ACCESS_KEY', value: '[已脱敏]' }, { key: 'NODE_ENV', value: 'production' }])
  assert.deepEqual(value.params, [{ name: 'api_key', value: '[已脱敏]' }, { name: 'query', value: 'hello' }])
  assert.deepEqual(value.data, [['password', '[已脱敏]'], ['count', 3]])
  assert.deepEqual(value.fields, input.fields); assert.deepEqual(value.columns, input.columns)
  assert.equal(JSON.stringify(value).includes('opaque-'), false)
})

test('复杂 HTTP 认证全部遮盖，命令中的引号、后续选项和正常输出保留', () => {
  const value = redactText('Authorization: Digest username="opaque-user", nonce="opaque-nonce", response="opaque-response"\nSet-Cookie: session=opaque-cookie; HttpOnly; Path=/\nContent-Type: application/json\n工具执行完成')
  assert.equal(value.includes('opaque-'), false)
  assert.match(value, /Content-Type: application\/json/); assert.match(value, /工具执行完成/)
  const command = redactText('curl -H "Authorization: Bearer opaque-auth" -H \'Cookie: session=opaque-cookie; other=opaque-other\' --verbose https://example.test')
  assert.equal(command, 'curl -H "Authorization: [已脱敏]" -H \'Cookie: [已脱敏]\' --verbose https://example.test')
  const quoted = redactText('{"Authorization":"Digest username=\\"opaque-user\\", response=\\"opaque-response\\"","safe":"业务输出"}')
  assert.equal(quoted.includes('opaque-'), false)
  assert.match(quoted, /业务输出/)
  assert.equal(redactText('bearer sk-test-not-a-known-format-123456').includes('sk-test-not-a-known-format-123456'), false)
  const multiline = redactText("PASSWORD='opaque-first\nopaque-second' NODE_ENV=production")
  assert.equal(multiline.includes('opaque-'), false)
  assert.match(multiline, /NODE_ENV=production/)
  assert.equal(redactText("PASSWORD='opaque-first\nopaque-second").includes('opaque-'), false)
})

test('PowerShell 双写引号、反引号和多层转义只遮盖敏感值，保留后续参数', () => {
  const commands = [
    'PASSWORD="opaque-first""opaque-second" NODE_ENV=production',
    "PASSWORD='opaque-first''opaque-second' NODE_ENV=production",
    'PASSWORD="opaque-first`"opaque-second" NODE_ENV=production',
    'PASSWORD=`"opaque-value`" NODE_ENV=production',
    String.raw`PASSWORD=\"opaque-value\" NODE_ENV=production`,
    String.raw`PASSWORD=\"opaque-first\\\"opaque-second\" NODE_ENV=production`,
  ]
  for (const command of commands) {
    const value = redactText(command)
    assert.equal(value.includes('opaque-'), false, command)
    assert.match(value, /NODE_ENV=production/)
  }
  const headers = [
    'curl -H "Authorization: Digest username=`"opaque-user`", response=`"opaque-response`"" --verbose https://example.test',
    String.raw`curl -H "Authorization: Digest username=\"opaque-user\", response=\"opaque-response\"" --verbose https://example.test`,
    String.raw`curl -H \"Authorization: Bearer opaque-auth\" --verbose https://example.test`,
  ]
  for (const command of headers) {
    const value = redactText(command)
    assert.equal(value.includes('opaque-'), false, command)
    assert.match(value, /--verbose https:\/\/example.test/)
  }
  const unfinished = redactText('PASSWORD=`"opaque-first\nopaque-second')
  assert.equal(unfinished.includes('opaque-'), false)
  assert.equal(redactText('PASSWORD=opaque-first"opaque-second" NODE_ENV=production'), 'PASSWORD=[已脱敏] NODE_ENV=production')
})

test('文本敏感字段的对象、数组和短认证值完整保护，不留下第二个值', () => {
  for (const raw of [
    'credentials={"first":"opaque-first","second":"opaque-second"} NODE_ENV=production',
    'credentials=["opaque-first","opaque-second"] NODE_ENV=production',
    'AUTH_TOKEN=Basic tiny-value NODE_ENV=production',
  ]) {
    const value = redactText(raw)
    assert.equal(value.includes('opaque-'), false)
    assert.equal(value.includes('tiny-value'), false)
    assert.match(value, /NODE_ENV=production/)
  }
})

test('普通 JSON data 可查看，但真实二进制、循环及过大结构不传输', () => {
  const cycle = {}; cycle.self = cycle
  const value = redactValue({ data: { result: 'normal' }, raw: new Uint8Array([65, 66]), serialized: { type: 'Buffer', data: [65, 66] }, bytes: [65, 66], base64: 'QUJD', cycle })
  assert.deepEqual(value.data, { result: 'normal' })
  assert.equal(value.raw, '[二进制内容未展示]')
  assert.equal(value.serialized, '[二进制内容未展示]')
  assert.equal(value.bytes, '[已脱敏]')
  assert.equal(value.base64, '[已脱敏]')
  assert.equal(value.cycle.self, '[循环引用]')
  assert.equal(redactText('x'.repeat(2 * 1024 * 1024 + 1)), '[内容超过安全展示上限，未展示]')
})

test('Web 与获授权远程工具详情保留普通参数和 JSON 输出，不放开锁定密钥库', async () => {
  const events = [start, call(2, 'c', 'request', { headers: { Accept: 'application/json', Authorization: 'opaque-auth' }, data: { query: 'hello' } }), result(3, 'c', true, '{"data":{"result":"工具结果","api_key":"opaque-key"}}')]
  const rt = toolsRuntime(events)
  for (const options of [{ deviceKind: 'local', fullMessages: true }, { deviceKind: 'phone', fullMessages: true }]) {
    const args = await rt.extraToolDetail({ sessionId: 'owned', callId: 'c', field: 'arguments' }, undefined, options)
    assert.deepEqual(JSON.parse(args.text), { headers: { Accept: 'application/json', Authorization: '[已脱敏]' }, data: { query: 'hello' } })
    const output = await rt.extraToolDetail({ sessionId: 'owned', callId: 'c', field: 'output' }, undefined, options)
    assert.deepEqual(JSON.parse(output.text), { data: { result: '工具结果', api_key: '[已脱敏]' } })
  }
  rt.secretStoreStatus = () => ({ locked: true })
  const locked = await rt.extraToolDetail({ sessionId: 'owned', callId: 'c', field: 'output' }, undefined, { deviceKind: 'local', fullMessages: true })
  assert.equal(locked.available, false)
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
