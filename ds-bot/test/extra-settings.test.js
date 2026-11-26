import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoArchive, cleanBotExtras, cleanDefaults, messageMode, remotePermissionError } from '../src/host/extras/settings.js'

test('每 Bot 的模式覆盖默认值，未设置时保留基础插话模式', () => {
  assert.equal(messageMode({ messageMode: 'steer' }, 'queue'), 'steer')
  assert.equal(messageMode({ messageMode: 'queue' }, 'steer'), 'queue')
  assert.equal(messageMode({}, 'steer'), 'steer')
  assert.equal(messageMode({}, undefined), 'queue')
  assert.deepEqual(cleanBotExtras({ messageMode: 'inherit', autoArchive: false }), { messageMode: null, autoArchive: false })
  assert.throws(() => cleanBotExtras({ messageMode: 'execute' }))
  assert.throws(() => cleanBotExtras({ autoArchive: 'yes' }))
})

test('团队默认独立控制发送与归档，Bot 覆盖优先且能恢复跟随', () => {
  const defaults = { messageMode: 'steer', autoArchive: true }
  assert.equal(messageMode({}, 'queue', defaults), 'steer')
  assert.equal(messageMode({ messageMode: null }, undefined, defaults), 'steer')
  assert.equal(messageMode({ messageMode: 'queue' }, 'steer', defaults), 'queue')
  assert.equal(messageMode({}, 'steer', { messageMode: null }), 'steer')
  assert.equal(autoArchive({}, defaults), true)
  assert.equal(autoArchive({ autoArchive: false }, defaults), false)
  assert.equal(autoArchive({ autoArchive: null }, defaults), true)
  assert.equal(autoArchive({ messageMode: 'queue' }, {}), false)
  assert.equal(autoArchive({ autoArchive: true }, { autoArchive: false }), true)
  assert.deepEqual(cleanBotExtras({ autoArchive: 'inherit' }), { autoArchive: null })
  assert.deepEqual(cleanBotExtras({ autoArchive: null }), { autoArchive: null })
  assert.deepEqual(cleanDefaults({ messageMode: 'inherit', autoArchive: true }), { messageMode: null, autoArchive: true })
  for (const patch of [{ autoArchive: null }, { autoArchive: 'inherit' }, { messageMode: 'execute' }, { fullMessages: true }, {}]) {
    assert.throws(() => cleanDefaults(patch), { code: 'bot/invalid' })
  }
})

test('远程权限默认拒绝，电脑授权只对已配对手机类别生效', () => {
  const payload = { id: 'bot', permission: 'danger-full-access' }
  assert.equal(remotePermissionError(false, { kind: 'phone' }, 'update-bot', payload)?.code, 'bot/refused')
  assert.equal(remotePermissionError(true, { kind: 'phone' }, 'update-bot', payload), undefined)
  assert.equal(remotePermissionError(true, { kind: 'browser', name: 'DSBotDeck（Windows）' }, 'update-bot', payload)?.code, 'bot/refused')
  assert.equal(remotePermissionError(true, undefined, 'update-bot', payload)?.code, 'bot/refused')
  assert.equal(remotePermissionError(false, { kind: 'phone' }, 'update-bot', { id: 'bot', name: 'Renamed' }), undefined)
  assert.equal(remotePermissionError(false, { kind: 'phone' }, 'update-room', { id: 'group', permission: null })?.code, 'bot/refused')
})

test('远程不能修改本机授权，普通设置不附带授权能力', () => {
  assert.equal(remotePermissionError(true, { kind: 'phone' }, 'phone-extra-set', { remotePermissions: true })?.code, 'bot/refused')
  assert.throws(() => cleanBotExtras({ messageMode: 'steer', remotePermissions: true }))
})
