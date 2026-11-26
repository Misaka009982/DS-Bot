import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fullMessagesAllowed, remoteExtras } from '../src/host/extras/access.js'
import { install as installPrompt } from '../src/host/extras/prompt.js'

const device = { deviceId: 'device', identityKey: 'public-key', pairedAt: 10, kind: 'browser', name: 'DSBotDeck（Windows）' }
const settings = { deviceAccess: { device: { identityKey: 'public-key', pairedAt: 10, fullMessages: true } } }

test('完整消息授权绑定公钥及配对时间，名称不参与授权', () => {
  assert.equal(fullMessagesAllowed({}, device), false)
  assert.equal(fullMessagesAllowed(settings, device), true)
  assert.equal(fullMessagesAllowed(settings, { ...device, name: 'Changed' }), true)
  assert.equal(fullMessagesAllowed(settings, { ...device, identityKey: 'other-key' }), false)
  assert.equal(fullMessagesAllowed(settings, { ...device, pairedAt: 11 }), false)
  assert.equal(fullMessagesAllowed(settings, undefined), false)
  assert.equal(fullMessagesAllowed(settings, { ...device, kind: 'gateway' }), false)
  assert.equal(remoteExtras({ extras: { fullMessages: true, schema: 1 } }, settings, undefined).extras.fullMessages, false)
})

test('基础插话模式在异步 inbox 插入期间保留，并发请求不会相互污染', async () => {
  const bot = { id: 'bot' }
  const rt = { chatOwners: new Map([['current', 'bot']]), taskOwners: new Map(), groupOwners: new Map(), botOf: id => id === 'bot' ? bot : undefined, selfOf: () => 'bot' }
  installPrompt(rt)
  assert.equal(rt.extraKeepForeground('current'), false)
  await rt.extraSendPrompt({ sessionId: 'current', mode: 'steer' }, async request => {
    await Promise.resolve()
    assert.equal(request.mode, 'steer')
    assert.equal(rt.extraKeepForeground('current'), true)
    assert.equal(rt.extraKeepForeground('another'), false)
  })
  assert.equal(rt.extraKeepForeground('current'), false)
  bot.extras = { messageMode: 'queue' }
  await rt.extraSendPrompt({ sessionId: 'current', mode: 'steer' }, async request => assert.equal(request.mode, 'queue'))
})

test('目标不改写原消息交接方式，steer 设置自身保留当前前台', async () => {
  const bot = { id: 'bot', extras: { goal: { status: 'active' } } }
  const rt = { chatOwners: new Map([['current', 'bot']]), taskOwners: new Map(), groupOwners: new Map(),
    botOf: id => id === 'bot' ? bot : undefined, selfOf: () => 'bot' }
  installPrompt(rt)
  assert.equal(rt.extraKeepForeground('current'), false)
  assert.equal(rt.extraKeepForeground('another'), false)
  const request = { sessionId: 'current', mode: 'queue' }
  await rt.extraSendPrompt(request, async received => assert.equal(received, request))
  bot.extras.messageMode = 'steer'
  assert.equal(rt.extraKeepForeground('current'), true)
  await rt.extraSendPrompt(request, async received => assert.equal(received.mode, 'steer'))
  bot.extras.messageMode = null
  assert.equal(rt.extraKeepForeground('current'), false)
})

test('团队默认穿过原生 prompt 和前台交接，群聊、后台与内部消息保持原模式', async () => {
  const bot = { id: 'bot' }
  const owners = new Map([['current', 'bot'], ['task', 'bot']])
  const rt = { state: { extras: { defaults: { messageMode: 'steer' } } }, chatOwners: owners,
    taskOwners: new Map([['task', { botId: 'bot' }]]), groupOwners: new Map([['group', { botId: 'bot' }]]),
    botOf: id => id === bot.id ? bot : undefined, selfOf: id => owners.get(id) }
  installPrompt(rt)
  assert.equal(rt.extraKeepForeground('current'), true)
  assert.equal(rt.extraKeepForeground('task'), false)
  assert.equal(rt.extraKeepForeground('another'), false)
  await rt.extraSendPrompt({ sessionId: 'current', mode: 'queue' }, async request => assert.equal(request.mode, 'steer'))
  for (const request of [{ sessionId: 'task', mode: 'queue' }, { sessionId: 'group', mode: 'queue' },
    { sessionId: 'current', mode: 'queue', source: { kind: 'bot' } }]) {
    await rt.extraSendPrompt(request, async delivered => assert.equal(delivered, request))
  }
  bot.extras = { messageMode: 'queue' }
  await rt.extraSendPrompt({ sessionId: 'current', mode: 'steer' }, async request => assert.equal(request.mode, 'queue'))
  bot.extras.messageMode = null
  rt.state.extras.defaults.messageMode = null
  assert.equal(rt.extraKeepForeground('current'), false)
  await rt.extraSendPrompt({ sessionId: 'current', mode: 'steer' }, async request => assert.equal(request.mode, 'steer'))
})
