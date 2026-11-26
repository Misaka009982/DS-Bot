import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resourceBench, resourceTarget, resourceDevice } from './extra-resource-fixture.js'
import { workspacePath } from '../src/host/extras/workspace.js'

const open = f => f.call('extra-workspace-open', resourceTarget)
const read = (f, rootId, path = 'readme.txt') => f.call('extra-workspace-read', { rootId, path })
const save = (f, rootId, receiptId, content = '新内容\n', requestId = 'save-1') => f.call('extra-workspace-save', { rootId, receiptId, requestId, content })

test('目录和文件默认不可读，授权后只读设备无保存回执', async t => {
  const f = resourceBench(t)
  await assert.rejects(open(f), { code: 'bot/refused' })
  await f.grant({ filesRead: true })
  const root = await open(f)
  const listing = await f.call('extra-workspace-list', { rootId: root.rootId, path: '' })
  assert.deepEqual(listing.entries.map(entry => entry.name), ['other.txt', 'readme.txt'])
  assert.equal(listing.filtered, true)
  const page = await read(f, root.rootId)
  assert.equal(page.text, '原内容\n')
  assert.equal(page.complete, true)
  assert.equal(page.editable, false)
  assert.equal(page.receiptId, null)
  await assert.rejects(save(f, root.rootId, 'fake'), { code: 'bot/refused' })
})

test('只读预览不消耗编辑回执，旧客户端缺标记仍保留原编辑协议', async t => {
  const f = resourceBench(t)
  await f.grant({ filesRead: true, filesWrite: true })
  assert.equal(f.rt.extraView().workspace.readOnlyPreview, true)
  const root = await open(f)
  for (let index = 0; index < 40; index += 1) {
    const preview = await f.call('extra-workspace-read', { rootId: root.rootId, path: 'readme.txt', readOnly: true })
    assert.equal(preview.receiptId, null); assert.equal(preview.editable, false); assert.equal(preview.text, '原内容\n')
  }
  assert.ok((await read(f, root.rootId)).receiptId)
  await assert.rejects(f.call('extra-workspace-read', { rootId: root.rootId, path: 'readme.txt', readOnly: 'yes' }), { code: 'bot/invalid' })
})
test('根句柄隔离设备与授权代次，工作目录和会话变化使旧根失效', async t => {
  const f = resourceBench(t)
  await f.grant({ filesRead: true })
  const root = await open(f)
  const reader = { ...resourceDevice, deviceId: 'reader' }
  await f.grant({ filesRead: true }, reader)
  await assert.rejects(f.call('extra-workspace-read', { rootId: root.rootId, path: 'readme.txt' }, { device: reader }), { code: 'bot/stale' })
  await f.grant({ filesRead: false })
  await f.grant({ filesRead: true })
  await assert.rejects(read(f, root.rootId), { code: 'bot/stale' })
  const next = await open(f)
  f.put('/changed', '', 'directory')
  f.cwd = '/changed'
  await assert.rejects(read(f, next.rootId), { code: 'bot/stale' })
  f.cwd = '/work'
  f.bot.sessionId = 'replacement'
  await assert.rejects(read(f, next.rootId), { code: 'bot/stale' })
})

test('拒绝遍历、绝对路径、URL、ADS、敏感文件以及符号链接', async t => {
  for (const path of ['../file', '/etc/passwd', 'C:/file', '//server/share', 'a\\b', 'a:b', 'https://host/file', '~/.ssh/id_rsa',
    '.env', 'folder/.env.local', '.git/config', '.ssh/config', 'private.pem', 'auth.json', 'file.', 'CON', 'a//b']) {
    assert.throws(() => workspacePath(path), { code: 'bot/refused' }, path)
  }
  const f = resourceBench(t)
  await f.grant({ filesRead: true })
  const root = await open(f)
  f.put('/work/link', '', 'symlink')
  await assert.rejects(read(f, root.rootId, 'link/file.txt'), { code: 'bot/refused' })
  await assert.rejects(read(f, root.rootId, '.env'), { code: 'bot/refused' })
  assert.equal(f.reads(), 0)
})

test('完整 UTF-8、大小和脱敏决定是否可编辑，目录翻页检测变化', async t => {
  const f = resourceBench(t)
  await f.grant({ filesRead: true, filesWrite: true })
  const root = await open(f)
  f.put('/work/invalid.txt', Buffer.from([0xff, 0xfe]))
  f.put('/work/binary.txt', Buffer.from([0x61, 0, 0x62]))
  f.put('/work/large.txt', Buffer.alloc(256 * 1024 + 1, 65))
  f.put('/work/protected.txt', '正文 fake-private-value')
  await assert.rejects(read(f, root.rootId, 'invalid.txt'), { code: 'bot/encoding' })
  await assert.rejects(read(f, root.rootId, 'binary.txt'), { code: 'bot/encoding' })
  await assert.rejects(read(f, root.rootId, 'large.txt'), { code: 'bot/too-large' })
  const protectedPage = await read(f, root.rootId, 'protected.txt')
  assert.equal(protectedPage.redacted, true)
  assert.equal(protectedPage.editable, false)
  assert.equal(protectedPage.receiptId, null)
  assert.equal(protectedPage.text, '正文 [secret:TEST]')
  for (let at = 0; at < 70; at += 1) f.put(`/work/page-${String(at).padStart(2, '0')}.txt`, '')
  const first = await f.call('extra-workspace-list', { rootId: root.rootId, path: '' })
  assert.equal(first.entries.length, 64)
  assert.ok(first.cursor)
  const second = await f.call('extra-workspace-list', { rootId: root.rootId, path: '', cursor: first.cursor })
  assert.equal(second.cursor, null)
  f.put('/work/page-new.txt', '')
  await assert.rejects(f.call('extra-workspace-list', { rootId: root.rootId, path: '', cursor: first.cursor }), { code: 'bot/conflict' })
})

test('文件被 Agent 修改后旧回执保存冲突，实际修改只来自 writeText 成功回执', async t => {
  const f = resourceBench(t)
  await f.grant({ filesRead: true, filesWrite: true })
  const root = await open(f)
  const first = await read(f, root.rootId)
  f.put('/work/readme.txt', 'Agent 新内容\n')
  await assert.rejects(save(f, root.rootId, first.receiptId), { code: 'bot/conflict' })
  assert.equal(f.writes.length, 0)
  const current = await read(f, root.rootId)
  const result = await save(f, root.rootId, current.receiptId)
  assert.equal(result.status, 'saved')
  assert.deepEqual(f.writes[0].expected, { kind: 'replaceIfVersion', version: current.version })
  assert.equal(f.files.get('/work/readme.txt').content.toString(), '新内容\n')
  assert.equal((await save(f, root.rootId, current.receiptId)).status, 'saved')
  assert.equal(f.writes.length, 1)
  const change = await f.call('extra-workspace-change', { rootId: root.rootId, receiptId: current.receiptId })
  assert.equal(change.source, 'workspace-save')
  assert.equal(change.before, 'Agent 新内容\n')
  assert.equal(change.after, '新内容\n')
  await assert.rejects(save(f, root.rootId, current.receiptId, '不可重放', 'another'), { code: 'bot/stale' })
})

test('保存修改的缓存复读保留可信遮盖标记，并按最新密钥库重新遮盖', async t => {
  const f = resourceBench(t)
  await f.grant({ filesRead: true, filesWrite: true })
  const root = await open(f)
  const page = await read(f, root.rootId)
  await save(f, root.rootId, page.receiptId, '内容 fake-private-value rotated-value')
  const change = () => f.call('extra-workspace-change', { rootId: root.rootId, receiptId: page.receiptId })
  assert.equal((await change()).after, '内容 [secret:TEST] rotated-value')
  const previous = f.rt.redactSecrets
  f.rt.redactSecrets = value => previous(value).replaceAll('rotated-value', '[secret:NEW]')
  assert.equal((await change()).after, '内容 [secret:TEST] [secret:NEW]')
  assert.equal((await change()).redacted, true)
})

test('并发保存只领取一次回执，底层前置条件冲突和未知结果都不重放', async t => {
  const f = resourceBench(t)
  await f.grant({ filesRead: true, filesWrite: true })
  const root = await open(f)
  const page = await read(f, root.rootId)
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  f.beforeWrite = async () => { entered(); await held }
  const pending = save(f, root.rootId, page.receiptId)
  await ready
  assert.equal((await save(f, root.rootId, page.receiptId)).status, 'pending')
  assert.equal((await f.call('extra-workspace-save-status', { rootId: root.rootId, receiptId: page.receiptId })).status, 'pending')
  f.put('/work/readme.txt', '竞争者写入')
  release()
  assert.equal((await pending).status, 'conflict')
  assert.equal(f.files.get('/work/readme.txt').content.toString(), '竞争者写入')
  f.beforeWrite = () => { throw new Error('transport uncertain') }
  const next = await read(f, root.rootId)
  assert.equal((await save(f, root.rootId, next.receiptId)).status, 'unknown')
  assert.equal((await save(f, root.rootId, next.receiptId)).status, 'unknown')
  assert.equal(f.writes.length, 2)
})

test('真实目标指向敏感文件时拒绝读取，保存后脱敏服务变化不抹掉成功结果', async t => {
  const f = resourceBench(t)
  await f.grant({ filesRead: true, filesWrite: true })
  const root = await open(f)
  const resolve = f.fs.resolve
  f.fs.resolve = async (path, options) => resolve(path === 'readme.txt' ? '.env' : path, options)
  await assert.rejects(read(f, root.rootId), { code: 'bot/refused' })
  assert.equal(f.reads(), 0)
  f.fs.resolve = resolve
  const page = await read(f, root.rootId)
  f.beforeWrite = () => { f.rt.secretStoreStatus = () => ({ locked: true }) }
  const saved = await save(f, root.rootId, page.receiptId)
  assert.equal(saved.status, 'saved')
  assert.equal((await f.call('extra-workspace-save-status', { rootId: root.rootId, receiptId: page.receiptId })).status, 'saved')
  await assert.rejects(f.call('extra-workspace-change', { rootId: root.rootId, receiptId: page.receiptId }), { code: 'bot/unavailable' })
  assert.equal(f.writes.length, 1)
})

test('读取期间撤销或取消不泄露正文，锁住密钥库拒绝编辑', async t => {
  const f = resourceBench(t)
  await f.grant({ filesRead: true, filesWrite: true })
  const root = await open(f)
  const original = f.fs.readBytes
  f.fs.readBytes = async (...args) => {
    const bytes = await original(...args)
    await f.grant({ filesRead: false })
    return bytes
  }
  await assert.rejects(read(f, root.rootId), { code: 'bot/refused' })
  f.fs.readBytes = original
  await f.grant({ filesRead: true, filesWrite: true })
  const current = await open(f)
  f.rt.secretStoreStatus = () => ({ locked: true })
  await assert.rejects(read(f, current.rootId), { code: 'bot/unavailable' })
  await assert.rejects(f.call('extra-workspace-read', { rootId: current.rootId, path: 'readme.txt' }, { signal: AbortSignal.abort() }), { code: 'bot/refused' })
})
