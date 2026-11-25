import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceLabel } from '../src/client/extras/device-name.js'

const translate = text => ({ 'Web browser': '网页浏览器', Phone: '手机' })[text] ?? text

test('浏览器权限的 Deck 显示已有名称，不改变设备类别', () => {
  const entry = { id: 'paired-device', name: 'DSBotDeck（Windows）', kind: 'browser', pairedAt: 123 }
  assert.equal(deviceLabel(entry, translate), 'DSBotDeck（Windows）')
  assert.deepEqual(entry, { id: 'paired-device', name: 'DSBotDeck（Windows）', kind: 'browser', pairedAt: 123 })
})

test('名称为空时回退类别，普通手机和网页保留名称', () => {
  assert.equal(deviceLabel({ kind: 'browser', name: '' }, translate), '网页浏览器')
  assert.equal(deviceLabel({ kind: 'browser', name: '   ' }, translate), '网页浏览器')
  assert.equal(deviceLabel({ kind: 'phone', name: '' }, translate), '手机')
  assert.equal(deviceLabel({ kind: 'phone', name: 'Pixel' }, translate), 'Pixel')
  assert.equal(deviceLabel({ kind: 'browser', name: 'Safari' }, translate), 'Safari')
})

test('设备名称保持普通文本，不按名字识别权限', () => {
  assert.equal(deviceLabel({ kind: 'browser', name: '<b>DSBotDeck</b>' }, translate), '<b>DSBotDeck</b>')
  assert.equal(deviceLabel({ kind: 'browser', name: 42 }, translate), '网页浏览器')
})
