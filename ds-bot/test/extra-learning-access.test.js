import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fullMessagesAllowed, learningApprovalAllowed, remoteExtras } from '../src/host/extras/access.js'
import { install } from '../src/host/extras/write-settings.js'
import { remoteAccessError } from '../src/host/phone.js'

const device = { deviceId: 'device', identityKey: 'public-key', pairedAt: 10, kind: 'browser' }
const grant = { identityKey: device.identityKey, pairedAt: device.pairedAt, learningApproval: true }

test('学习审批授权默认关闭且独立于完整消息，绑定真实设备及配对时间', () => {
  const settings = { deviceAccess: { device: grant } }
  for (const kind of ['phone', 'browser']) {
    const paired = { ...device, kind }
    assert.equal(learningApprovalAllowed({}, paired), false)
    assert.equal(learningApprovalAllowed({ deviceAccess: { device: { ...grant, learningApproval: false, fullMessages: true } } }, paired), false)
    assert.equal(learningApprovalAllowed(settings, paired), true)
    assert.equal(fullMessagesAllowed(settings, paired), false)
    assert.equal(learningApprovalAllowed(settings, { ...paired, identityKey: 'another' }), false)
    assert.equal(learningApprovalAllowed(settings, { ...paired, pairedAt: 11 }), false)
  }
  assert.equal(learningApprovalAllowed(settings, undefined), false)
  assert.equal(learningApprovalAllowed(settings, { ...device, kind: 'gateway' }), false)
  assert.deepEqual(remoteExtras({ extras: { schema: 1, learningApproval: { schema: 1, allowed: true } } }, settings, undefined).extras.learningApproval, { schema: 1, allowed: false })
})

test('浏览器显式学习授权只开放原审批端点，未知设备和其他敏感操作仍拒绝', () => {
  assert.equal(remoteAccessError(device, 'learning-answer').code, 'bot/refused')
  assert.equal(remoteAccessError(device, 'learning-answer', true), undefined)
  assert.equal(remoteAccessError(undefined, 'learning-answer', true).code, 'bot/refused')
  assert.equal(remoteAccessError({ ...device, kind: 'unknown' }, 'learning-answer', true).code, 'bot/refused')
  for (const endpoint of ['provider-key', 'capability-save', 'phone-extra-set', 'session-page', 'extra-not-real']) {
    assert.equal(remoteAccessError(device, endpoint, true).code, 'bot/refused')
  }
})

test('学习授权保存独立字段，拒绝旧配对、坏字段；写入期间及失败后不留下临时权限', async () => {
  let release
  const paired = { ...device }
  const rt = { state: {}, load: async () => {}, readOnly: () => undefined,
    save: async () => {}, extraPairedDevices: () => [paired], extraView: () => rt.state.extras }
  install(rt)
  const set = patch => rt.extraSettings('phone-extra-set', { deviceId: paired.deviceId, pairedAt: paired.pairedAt, ...patch })
  await set({ fullMessages: true })
  await set({ learningApproval: true })
  assert.deepEqual(rt.state.extras.deviceAccess.device, { ...grant, fullMessages: true })
  await set({ fullMessages: false })
  assert.equal(rt.state.extras.deviceAccess.device.learningApproval, true)
  await assert.rejects(set({ pairedAt: 11, learningApproval: true }), { code: 'bot/stale' })
  for (const learningApproval of ['true', 1, null]) await assert.rejects(set({ learningApproval }), { code: 'bot/invalid' })
  const previous = rt.state.extras
  rt.save = () => new Promise((_, reject) => { release = reject })
  const pending = set({ learningApproval: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(rt.extraAuthorizationPending(), true)
  release(new Error('保存失败'))
  await assert.rejects(pending, /保存失败/)
  assert.equal(rt.extraAuthorizationPending(), false)
  assert.equal(rt.state.extras, previous)
  paired.pairedAt = 12
  rt.save = async () => {}
  await set({ learningApproval: true })
  assert.equal(rt.state.extras.deviceAccess.device.fullMessages, undefined)
})
