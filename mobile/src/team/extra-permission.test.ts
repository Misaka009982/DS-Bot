import assert from 'node:assert/strict'
import { test } from 'node:test'
import { permissionWrite } from '../extras/permission-policy.ts'

test('仅携带 permission 字段的管理写入触发权限门禁，不能按消息授权或名称跳过', () => {
  for (const endpoint of ['update-bot', 'update-room', 'create-bot', 'create-room']) {
    assert.equal(permissionWrite(endpoint, { id: 'x', permission: 'danger-full-access' }), true)
    assert.equal(permissionWrite(endpoint, { id: 'x', permission: null }), true)
    assert.equal(permissionWrite(endpoint, { id: 'x', name: 'DSBotDeck（Windows）', fullMessages: true }), false)
  }
  assert.equal(permissionWrite('send', { permission: 'full' }), false)
})
