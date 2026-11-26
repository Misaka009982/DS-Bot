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

test('团队默认只合并合法字段，保存失败回退且不改 Bot 独立设置和设备授权', async () => {
  const { rt, bot } = runtime()
  bot.extras = { messageMode: 'queue', autoArchive: false }
  const access = { device: { fullMessages: true, identityKey: 'key', pairedAt: 10 } }
  rt.state.extras = { deviceAccess: access }
  await rt.extraSettings('extra-defaults-set', { messageMode: 'steer' })
  await rt.extraSettings('extra-defaults-set', { autoArchive: true })
  assert.deepEqual(rt.state.extras.defaults, { messageMode: 'steer', autoArchive: true })
  assert.equal(rt.state.extras.deviceAccess, access)
  assert.deepEqual(bot.extras, { messageMode: 'queue', autoArchive: false })
  const previous = rt.state.extras
  await assert.rejects(rt.extraSettings('extra-defaults-set', { remotePermissions: true }), { code: 'bot/invalid' })
  assert.equal(rt.state.extras, previous)
  rt.save = async () => { throw new Error('disk unavailable') }
  await assert.rejects(rt.extraSettings('extra-defaults-set', { autoArchive: false }))
  assert.equal(rt.state.extras, previous)
  rt.save = async () => {}
  await rt.extraSettings('extra-bot-set', { id: 'bot', messageMode: 'inherit', autoArchive: 'inherit' })
  assert.deepEqual(bot.extras, { messageMode: null, autoArchive: null })
  rt.readOnly = () => '只读宿主'
  await assert.rejects(rt.extraSettings('extra-defaults-set', { autoArchive: false }), { code: 'bot/read-only' })
})

test('排队执行时重新验权，撤销后不会应用请求', async () => {
  const { rt } = runtime()
  await assert.rejects(rt.extraSettings('phone-extra-set', { remotePermissions: true }, () => { throw Object.assign(new Error('revoked'), { code: 'bot/refused' }) }), { code: 'bot/refused' })
  assert.equal(rt.state.extras, undefined)
})

test('资源授权独立保存、默认关闭，撤销读权限同时撤销写权限且轮换句柄代次', async () => {
  const { rt } = runtime()
  const set = patch => rt.extraSettings('phone-extra-set', { deviceId: 'device', pairedAt: 10, ...patch })
  await assert.rejects(set({ resources: { filesWrite: true } }), { code: 'bot/invalid' })
  await set({ resources: { filesRead: true, filesWrite: true } })
  const grant = rt.state.extras.deviceAccess.device
  assert.equal(grant.fullMessages, undefined)
  assert.equal(grant.resources.terminalRead, undefined)
  assert.ok(grant.resourceRevision)
  await set({ fullMessages: true })
  assert.equal(rt.state.extras.deviceAccess.device.resourceRevision, grant.resourceRevision)
  assert.equal(rt.state.extras.deviceAccess.device.resources.filesWrite, true)
  await set({ resources: { filesRead: false } })
  const revoked = rt.state.extras.deviceAccess.device
  assert.equal(revoked.resources.filesRead, false)
  assert.equal(revoked.resources.filesWrite, false)
  assert.notEqual(revoked.resourceRevision, grant.resourceRevision)
  assert.equal(revoked.fullMessages, true)
  rt.save = async () => { throw new Error('disk unavailable') }
  await assert.rejects(set({ resources: { terminalRead: true } }))
  assert.equal(rt.state.extras.deviceAccess.device, revoked)
  await assert.rejects(set({ resources: { owner: true } }), { code: 'bot/invalid' })
})
