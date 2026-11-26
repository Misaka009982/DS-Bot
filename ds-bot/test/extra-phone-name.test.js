import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deviceIdFor, generateKeyPair, pairingUri, parsePairingUri } from '../link.js'
import { install as installPhone, remoteAccessError } from '../src/host/phone.js'
import { PHONE_NAME_LIMIT, cleanPhoneServerName, readPhoneServerName, renamePhonePairing } from '../src/shared/extras/phone-name.js'
import { extraText } from '../src/shared/extras/copy.js'

function storedPhone(t, fields = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-phone-name-'))
  const path = join(home, 'phone.json')
  const keys = generateKeyPair()
  const peer = generateKeyPair()
  const saved = {
    on: false, server: 'wss://relay.test/v1/link',
    identity: { ...keys, deviceId: deviceIdFor(keys.publicKey) }, accessToken: 'test-server-token',
    devices: [{ deviceId: deviceIdFor(peer.publicKey), identityKey: peer.publicKey, name: 'Pixel', pairedAt: 10, kind: 'phone' }],
    ...fields,
  }
  writeFileSync(path, JSON.stringify(saved))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const open = () => {
    const rt = { home, readOnly: () => undefined }
    installPhone(rt)
    return rt
  }
  return { path, saved, open, rt: open(), read: () => JSON.parse(readFileSync(path, 'utf8')) }
}

test('服务器名称按配对协议限制为 64，中文和特殊字符保留，空白表示默认机器名', () => {
  assert.equal(PHONE_NAME_LIMIT, 64)
  assert.equal(cleanPhoneServerName('  杭州 + 100% & team  '), '杭州 + 100% & team')
  assert.equal(cleanPhoneServerName('   '), '')
  assert.equal(cleanPhoneServerName('服'.repeat(64)), '服'.repeat(64))
  assert.equal(cleanPhoneServerName('🙂'.repeat(32)), '🙂'.repeat(32))
  for (const value of [null, undefined, false, 1, {}, [], '服'.repeat(65), 'a'.repeat(63) + '🙂', 'a\nb', 'a\tb', 'a\u0000b', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'a\uD800b', 'a\uDFFFb']) {
    assert.throws(() => cleanPhoneServerName(value), { code: 'bot/invalid' })
  }
  for (const value of [undefined, null, {}, '服'.repeat(65), 'a\nb']) assert.equal(readPhoneServerName(value), '')
  assert.equal(readPhoneServerName('  工作服务器  '), '工作服务器')
  assert.equal(extraText('Server name', 'zh'), '服务器名称')
})

test('更新现有二维码只换显示名，配对码、类型、身份、地址和过期时间保持不变', () => {
  const keys = generateKeyPair()
  const offer = { server: 'wss://relay.test/v1/link', hostDeviceId: deviceIdFor(keys.publicKey), hostKey: keys.publicKey, code: 'phone-code', name: 'PC' }
  const previous = { uri: pairingUri(offer), browserUri: pairingUri({ ...offer, code: 'browser-code', device: 'browser' }), expiresAt: 100 }
  const copy = { ...previous }
  const name = '杭州 + 100% & team'
  const next = renamePhonePairing(previous, name)
  assert.notEqual(next, previous)
  assert.deepEqual(parsePairingUri(next.uri), { ...offer, name })
  assert.deepEqual(parsePairingUri(next.browserUri), { ...offer, name, code: 'browser-code', device: 'browser' })
  assert.equal(next.expiresAt, previous.expiresAt)
  assert.deepEqual(previous, copy)
  assert.equal(renamePhonePairing(null, name), null)
  const maximum = renamePhonePairing(previous, '服'.repeat(64))
  assert.equal(parsePairingUri(maximum.uri).name, '服'.repeat(64))
})

test('保存名称后重启仍保留；仅改元数据，不改身份、令牌、地址、开关或已配对设备', async t => {
  const fixture = storedPhone(t)
  assert.equal(fixture.rt.phoneView().serverName, '')
  const name = '杭州 + 100% & team'
  const view = await fixture.rt.phoneEndpoint('phone-set', { serverName: `  ${name}  ` })
  assert.equal(view.serverName, name)
  assert.equal(view.on, false)
  const { serverName, ...kept } = fixture.read()
  assert.equal(serverName, name)
  assert.deepEqual(kept, fixture.saved)
  assert.equal(fixture.open().phoneView().serverName, name)
  assert.deepEqual(fixture.rt.extraPairedDevices(), fixture.saved.devices)
  const cleared = await fixture.rt.phoneEndpoint('phone-set', { serverName: '   ' })
  assert.equal(cleared.serverName, '')
  assert.deepEqual(fixture.read(), fixture.saved)
  assert.equal(fixture.open().phoneView().serverName, '')
})

test('名称或服务器地址无效时不部分保存，已有名称和配对身份保持原值', async t => {
  const fixture = storedPhone(t, { serverName: '原服务器' })
  for (const serverName of [null, {}, '服'.repeat(65), 'a\nb']) {
    await assert.rejects(fixture.rt.phoneEndpoint('phone-set', { serverName, server: 'wss://changed.test/v1/link', on: true }), { code: 'bot/invalid' })
    assert.deepEqual(fixture.read(), fixture.saved)
    assert.equal(fixture.rt.phoneView().serverName, '原服务器')
  }
  await assert.rejects(fixture.rt.phoneEndpoint('phone-set', { serverName: '新服务器', server: 'http://invalid.test', on: true }), { code: 'bot/invalid' })
  assert.deepEqual(fixture.read(), fixture.saved)
  assert.equal(fixture.rt.phoneView().serverName, '原服务器')
})

test('名称写盘失败回退内存，不误报改名成功或轮换已有配对身份', async t => {
  const fixture = storedPhone(t, { serverName: '原服务器' })
  mkdirSync(`${fixture.path}.${process.pid}.tmp`)
  await assert.rejects(fixture.rt.phoneEndpoint('phone-set', { serverName: '新服务器' }))
  assert.equal(fixture.rt.phoneView().serverName, '原服务器')
  assert.deepEqual(fixture.read(), fixture.saved)
  assert.deepEqual(fixture.rt.extraPairedDevices(), fixture.saved.devices)
})

test('手机和浏览器仍不能远程改服务器配对设置，名称不是授权依据', () => {
  for (const kind of ['phone', 'browser']) {
    assert.equal(remoteAccessError({ deviceId: 'paired', kind, name: '管理服务器' }, 'phone-set').code, 'bot/refused')
  }
  assert.equal(remoteAccessError(undefined, 'phone-set').code, 'bot/refused')
})
