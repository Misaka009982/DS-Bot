import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/extras/write-settings.js'

function runtime() {
  const bot = { id: 'bot' }
  const rt = { state: {}, load: async () => {}, save: async () => {}, readOnly: () => undefined, botOf: id => id === 'bot' ? bot : undefined,
    extraPairedDevices: () => [{ deviceId: 'device', identityKey: 'key', pairedAt: 10 }], extraView: () => rt.state.extras }
  install(rt)
  return { rt, bot }
}

test('电脑按配对记录保存完整消息授权，拒绝过期设备快照', async () => {
  const { rt } = runtime()
  await assert.rejects(rt.extraSettings('phone-extra-set', { deviceId: 'device', pairedAt: 11, fullMessages: true }), { code: 'bot/stale' })
  await rt.extraSettings('phone-extra-set', { deviceId: 'device', pairedAt: 10, fullMessages: true })
  assert.deepEqual(rt.state.extras.deviceAccess.device, { identityKey: 'key', pairedAt: 10, fullMessages: true })
})

test('设置持久化失败时回退，不留下临时授权或模式', async () => {
  const { rt, bot } = runtime()
  rt.save = async () => { throw new Error('disk unavailable') }
  await assert.rejects(rt.extraSettings('phone-extra-set', { remotePermissions: true }))
  assert.equal(rt.state.extras, undefined)
  await assert.rejects(rt.extraSettings('extra-bot-set', { id: 'bot', messageMode: 'steer' }))
  assert.equal(bot.extras, undefined)
})

test('排队执行时重新验权，撤销后不会应用请求', async () => {
  const { rt } = runtime()
  await assert.rejects(rt.extraSettings('phone-extra-set', { remotePermissions: true }, () => { throw Object.assign(new Error('revoked'), { code: 'bot/refused' }) }), { code: 'bot/refused' })
  assert.equal(rt.state.extras, undefined)
})
