import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resourceAllowed, resourceGrant, cleanResourceGrant } from '../src/host/extras/resources.js'

const device = { deviceId: 'device', kind: 'browser', identityKey: 'key', pairedAt: 10 }
const settings = { deviceAccess: { device: { identityKey: 'key', pairedAt: 10, resourceRevision: 'generation', resources: { filesRead: true, filesWrite: true, terminalRead: true } } } }

test('资源授权来自保存的配对身份与独立布尔字段，客户端名称和自报无效', () => {
  const grant = resourceGrant(settings, device)
  assert.equal(resourceAllowed(grant, 'filesWrite'), true)
  assert.equal(resourceAllowed(grant, 'terminalRead'), true)
  assert.equal(resourceAllowed(grant, 'terminalWrite'), false)
  assert.deepEqual(resourceGrant(settings, { ...device, name: 'Administrator', resources: { terminalWrite: true } }), grant)
  for (const changed of [{ ...device, identityKey: 'new-key' }, { ...device, pairedAt: 11 }, { ...device, kind: 'gateway' }, undefined]) {
    assert.equal(resourceGrant(settings, changed), undefined)
  }
  assert.equal(resourceAllowed({ permissions: { filesWrite: true } }, 'filesWrite'), false)
  assert.equal(resourceGrant({ deviceAccess: { device: { identityKey: 'key', pairedAt: 10, fullMessages: true } } }, device), undefined)
  for (const invalid of [{ owner: true }, { filesRead: 'true' }, {}, null]) assert.throws(() => cleanResourceGrant(invalid), { code: 'bot/invalid' })
})
