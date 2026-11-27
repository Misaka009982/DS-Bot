import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { ATTACHMENT_LIMITS, install } from '../src/host/extras/attachments.js'
import { userFileMetadata } from '../src/shared/extras/attachments.js'
import { resourceBench, resourceDevice } from './extra-resource-fixture.js'

function bench(t, options) {
  const f = resourceBench(t); const uploaded = [], sent = []
  const upload = kind => async request => {
    const chunks = []
    for await (const chunk of request.data) chunks.push(chunk)
    uploaded.push({ kind, sessionId: request.sessionId, name: request.name, data: Buffer.concat(chunks) })
    await f.onUpload?.()
    return { receiptId: `receipt-${uploaded.length}` }
  }
  const uploads = { uploadStream: upload('file'), uploadImageStream: upload('image') }
  if (options?.traceServices) {
    const ctx = new Context()
    Object.defineProperty(uploads, Service.tracker, { value: { property: 'ctx' } }); uploads.ctx = ctx
    ctx.provide('fileUploads', uploads)
    const get = f.rt.ctx.get; f.rt.ctx.get = name => name === 'fileUploads' ? ctx.get(name) : get(name)
    t.after(() => ctx.fiber.dispose())
  } else f.replaceService('fileUploads', uploads)
  // 夹具的额外模块析构列表不包含附件；这个安装单独拥有其计时器。
  const effect = f.rt.ctx.effect
  f.rt.ctx.effect = (body, name) => { if (name === 'ds-bot: 聊天附件上传') t.after(body()); else effect(body, name) }
  install(f.rt)
  f.rt.sendUser = async request => {
    await f.beforePrepare?.()
    const prepared = await request.prepareContent(f.bot.sessionId)
    await f.beforePrompt?.(); prepared.beforePrompt()
    sent.push({ sessionId: f.bot.sessionId, content: prepared.content, requestId: request.requestId })
    await f.afterPrompt?.()
  }
  const call = (endpoint, body, { device = resourceDevice, signal } = {}) => f.rt.extraAttachment(endpoint, body, signal, {
    attachmentOwner: () => device,
  }, () => { if (f.revoked) throw Object.assign(new Error('已撤销'), { code: 'bot/refused' }) })
  const files = [{ name: '文档.pdf', size: 3, mime: 'application/pdf', kind: 'file' }]
  const open = (requestId = 'batch', manifest = files, options) => call('extra-attachment-open', { requestId, scope: { kind: 'bot', botId: 'bot' }, sessionId: f.bot.sessionId, files: manifest }, options)
  const chunk = (requestId = 'batch', options) => call('extra-attachment-chunk', { requestId, index: 0, offset: 0, data: Buffer.from('abc').toString('base64') }, options)
  return Object.assign(f, { call, open, chunk, uploaded, sent })
}
test('聊天附件按原字节上传，重复分片和重复发送不重复入队', async t => {
  const f = bench(t)
  assert.deepEqual(f.rt.extraAttachmentsView(), ATTACHMENT_LIMITS)
  await f.open(); await f.chunk(); assert.deepEqual((await f.chunk()).received, [3])
  assert.equal(f.uploaded.length, 0)
  const result = await f.call('extra-attachment-send', { requestId: 'batch', text: '请读取' })
  assert.equal(result.status, 'sent'); assert.equal(result.deliveredSessionId, 'current')
  assert.deepEqual(f.uploaded[0], { kind: 'file', sessionId: 'current', name: '文档.pdf', data: Buffer.from('abc') })
  assert.deepEqual(f.sent[0].content, [{ type: 'text', text: '请读取' }, { type: 'file', receiptId: 'receipt-1' }])
  assert.equal((await f.call('extra-attachment-send', { requestId: 'batch', text: '请读取' })).status, 'sent')
  assert.equal(f.sent.length, 1); assert.equal(f.uploaded.length, 1)
  await assert.rejects(f.call('extra-attachment-send', { requestId: 'batch', text: '改成其他内容' }), { code: 'bot/invalid' })
})
test('正常前台换段后才领取最终会话回执，图片使用公开图片上传服务', async t => {
  const f = bench(t, { traceServices: true })
  await f.open('batch', [{ name: 'image.png', size: 3, mime: 'image/png', kind: 'image' }]); await f.chunk()
  f.beforePrepare = async () => { f.bot.sessionId = 'fresh' }
  assert.equal((await f.call('extra-attachment-send', { requestId: 'batch', text: '' })).status, 'sent')
  assert.equal(f.uploaded[0].sessionId, 'fresh'); assert.equal(f.uploaded[0].kind, 'image')
  assert.deepEqual(f.sent[0].content, [{ type: 'image', receiptId: 'receipt-1' }])
})
test('群附件绑定当前公共会话，稳定群编号不能冒充最终会话', async t => {
  const f = bench(t)
  f.rt.state.rooms.room = { id: 'room', sessionId: 'room-current' }
  const body = { requestId: 'room-files', scope: { kind: 'room', roomId: 'room' }, sessionId: 'room', files: [{ name: 'a.txt', size: 0, mime: 'text/plain', kind: 'file' }] }
  await assert.rejects(f.call('extra-attachment-open', body), { code: 'bot/stale' })
  await f.call('extra-attachment-open', { ...body, sessionId: 'room-current' })
  f.rt.sendUser = async request => {
    assert.equal(request.sessionId, 'room-current')
    const prepared = await request.prepareContent(request.sessionId); prepared.beforePrompt()
    f.sent.push({ content: prepared.content })
  }
  assert.equal((await f.call('extra-attachment-send', { requestId: 'room-files', text: '' })).status, 'sent')
  assert.equal(f.uploaded[0].sessionId, 'room-current'); assert.equal(f.sent.length, 1)
})
test('设备重配、另一设备、外部换段和只读均不能发送旧附件', async t => {
  const f = bench(t); await f.open(); await f.chunk()
  for (const device of [{ ...resourceDevice, deviceId: 'other' }, { ...resourceDevice, pairedAt: 99 }]) {
    await assert.rejects(f.call('extra-attachment-status', { requestId: 'batch' }, { device }), { code: 'bot/stale' })
  }
  f.bot.sessionId = 'fresh'
  await assert.rejects(f.call('extra-attachment-send', { requestId: 'batch', text: '' }), { code: 'bot/stale' })
  assert.equal((await f.call('extra-attachment-status', { requestId: 'batch' })).status, 'uploading')
  f.bot.sessionId = 'current'; f.rt.readOnly = () => '只读'
  await assert.rejects(f.call('extra-attachment-send', { requestId: 'batch', text: '' }), { code: 'bot/read-only' })
  assert.equal(f.sent.length, 0)
})
test('上传或提交前撤销授权、替换服务或会话变化，不能发送半条消息', async t => {
  for (const reason of ['revoke', 'service', 'session']) {
    const f = bench(t); await f.open(); await f.chunk()
    f.onUpload = async () => {
      if (reason === 'revoke') f.revoked = true
      else if (reason === 'session') f.bot.sessionId = 'other-current'
      else f.replaceService('fileUploads', { uploadStream() {}, uploadImageStream() {} })
    }
    const result = await f.call('extra-attachment-send', { requestId: 'batch', text: '' })
    assert.equal(result.status, 'failed'); assert.equal(f.sent.length, 0)
  }
  const f = bench(t); await f.open(); await f.chunk()
  f.beforePrompt = async () => { f.revoked = true }
  assert.equal((await f.call('extra-attachment-send', { requestId: 'batch', text: '' })).status, 'failed')
  assert.equal(f.sent.length, 0)
})
test('提交后回执未知仍可查询，重复发送不再次入队', async t => {
  const f = bench(t); await f.open(); await f.chunk()
  f.afterPrompt = async () => { throw new Error('虚构回执丢失') }
  assert.equal((await f.call('extra-attachment-send', { requestId: 'batch', text: '' })).status, 'unknown')
  assert.equal((await f.call('extra-attachment-status', { requestId: 'batch' })).status, 'unknown')
  assert.equal((await f.call('extra-attachment-send', { requestId: 'batch', text: '' })).status, 'unknown')
  await assert.rejects(f.call('extra-attachment-discard', { requestId: 'batch' }), { code: 'bot/refused' })
  assert.equal(f.sent.length, 1)
})
test('非法文件和分片、未完成上传及超预算在提交前拒绝，空文件可发送', async t => {
  const f = bench(t)
  const file = { name: 'a.txt', size: 3, kind: 'file', mime: 'text/plain' }
  for (const patch of [{ name: '../a' }, { size: ATTACHMENT_LIMITS.maxFileBytes + 1 }, { size: -1 }, { kind: 'image', mime: 'image/svg+xml' }]) await assert.rejects(f.open('bad', [{ ...file, ...patch }]), { code: 'bot/invalid' })
  await assert.rejects(f.open('too-many', Array(9).fill(file)), { code: 'bot/invalid' })
  await f.open()
  await assert.rejects(f.call('extra-attachment-send', { requestId: 'batch', text: '' }), { code: 'bot/invalid' })
  for (const patch of [{ offset: 1 }, { index: -1 }, { data: 'YQ==' }, { data: 'YQ' }, { data: 'a'.repeat(ATTACHMENT_LIMITS.chunkBytes * 2) }]) {
    const request = { requestId: 'batch', index: 0, offset: 0, data: 'YWJj', ...patch }
    if (patch.data === 'YQ==') request.offset = 3
    await assert.rejects(f.call('extra-attachment-chunk', request), { code: 'bot/invalid' })
  }
  await f.call('extra-attachment-discard', { requestId: 'batch' })
  await f.open('empty', [{ ...file, size: 0 }])
  assert.equal((await f.call('extra-attachment-send', { requestId: 'empty', text: '' })).status, 'sent')
  assert.equal(f.uploaded[0].data.length, 0)
})
test('用户文件历史只含名称和字节数，不泄露宿主路径或回执', () => {
  assert.deepEqual(userFileMetadata([{ type: 'file', attachment: { name: '/tmp/project/a.pdf', bytes: 5, receiptId: 'hidden', hostPath: '/private/store' } }]), { fileRefs: [{ name: 'a.pdf', bytes: 5 }] })
  assert.deepEqual(userFileMetadata([{ type: 'image', attachment: { name: 'image.png' } }]), {})
})
