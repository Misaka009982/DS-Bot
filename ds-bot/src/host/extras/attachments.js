import { serviceOf } from '../services.js'
import { resourceDigest, resourceFields, resourceFailure, sameService, validResourceId } from './resources.js'

export const ATTACHMENT_LIMITS = Object.freeze({ schema: 1, maxFiles: 8, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, chunkBytes: 192 * 1024 })
export const ATTACHMENT_READS = new Set(['extra-attachment-status'])
export const ATTACHMENT_WRITES = new Set(['extra-attachment-open', 'extra-attachment-chunk', 'extra-attachment-send', 'extra-attachment-discard'])
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const TTL = 30 * 60_000
const MAX_RESERVED = 64 * 1024 * 1024
const fail = (code, message) => { throw resourceFailure(code, message) }
const invalid = () => fail('bot/invalid', '附件请求无效，请重新选择文件。')
const stale = () => fail('bot/stale', '附件或原会话已失效；没有发送到其他会话。')
const principal = caller => {
  if (caller === undefined) return 'local'
  const device = caller.attachmentOwner?.()
  if (!device || !['phone', 'browser'].includes(device.kind) || !validResourceId(device.deviceId) || !validResourceId(device.identityKey) || !Number.isFinite(device.pairedAt)) return fail('bot/refused', '不能确认附件所属的已配对设备。')
  return resourceDigest(JSON.stringify([device.deviceId, device.identityKey, device.pairedAt, device.kind]))
}
function targetOf(rt, scope) {
  if (scope?.kind === 'bot') {
    resourceFields(scope, ['kind', 'botId'])
    const bot = validResourceId(scope.botId) ? rt.botOf(scope.botId) : undefined
    if (!bot || bot.id !== scope.botId) return stale()
    return rt.chatOf(bot.id)
  }
  if (scope?.kind === 'room') {
    resourceFields(scope, ['kind', 'roomId'])
    const room = validResourceId(scope.roomId) ? rt.roomOf(scope.roomId) : undefined
    if (!room || room.id !== scope.roomId) return stale()
    return rt.sessionOfRoom(room)
  }
  return invalid()
}
function fileMetadata(value) {
  resourceFields(value, ['name', 'size', 'mime', 'kind'])
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || /[\\/\p{Cc}]/u.test(value.name)
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > ATTACHMENT_LIMITS.maxFileBytes
    || typeof value.mime !== 'string' || value.mime.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(value.mime)
    || !['file', 'image'].includes(value.kind) || value.kind === 'image' && (!IMAGE_TYPES.has(value.mime) || value.size === 0)) return invalid()
  return { name: value.name, size: value.size, mime: value.mime, kind: value.kind }
}
const reply = entry => ({ schema: 1, requestId: entry.requestId, sessionId: entry.sessionId, deliveredSessionId: entry.deliveredSessionId ?? null,
  status: entry.status, expiresAt: entry.expiresAt, received: entry.files.map(file => file.received), message: entry.message ?? null })

export function install(rt) {
  const entries = new Map()
  let reserved = 0, disposed = false
  const release = entry => { reserved -= entry.reserved; entry.reserved = 0; for (const file of entry.files) { file.chunks.length = 0; file.last = null } }
  const prune = () => {
    for (const [key, entry] of entries) if (entry.status !== 'sending' && entry.expiresAt <= Date.now()) { release(entry); entries.delete(key) }
  }
  const uploadsOf = () => {
    const service = serviceOf(rt.ctx, 'fileUploads')
    return typeof service?.uploadStream === 'function' && typeof service.uploadImageStream === 'function' ? service : undefined
  }
  rt.extraAttachmentsView = () => uploadsOf() ? { ...ATTACHMENT_LIMITS } : undefined
  rt.extraAttachment = async (endpoint, body, signal, caller, authorize) => {
    const keys = endpoint === 'extra-attachment-open' ? ['requestId', 'scope', 'sessionId', 'files']
      : endpoint === 'extra-attachment-chunk' ? ['requestId', 'index', 'offset', 'data']
        : endpoint === 'extra-attachment-send' ? ['requestId', 'text'] : ['requestId']
    resourceFields(body, keys)
    if (!validResourceId(body.requestId)) return invalid()
    const owner = principal(caller)
    const check = () => {
      authorize()
      if (disposed || signal?.aborted || principal(caller) !== owner) fail('bot/refused', '附件操作已取消或设备授权已变化。')
      if (!ATTACHMENT_READS.has(endpoint) && rt.readOnly() !== undefined) fail('bot/read-only', '当前服务器只读。')
    }
    check(); prune()
    const key = `${owner}:${body.requestId}`
    let entry = entries.get(key)
    if (endpoint === 'extra-attachment-open') {
      if (!validResourceId(body.sessionId) || !Array.isArray(body.files) || body.files.length < 1 || body.files.length > ATTACHMENT_LIMITS.maxFiles) return invalid()
      const files = body.files.map(fileMetadata)
      const total = files.reduce((sum, file) => sum + file.size, 0)
      if (total > ATTACHMENT_LIMITS.maxTotalBytes) return invalid()
      const fingerprint = JSON.stringify([body.scope, body.sessionId, files])
      if (entry) { if (entry.fingerprint !== fingerprint) return invalid(); return reply(entry) }
      if (targetOf(rt, body.scope) !== body.sessionId) return stale()
      if (!uploadsOf()) fail('bot/unavailable', '当前 DSH 没有可用的文件上传服务，请更新服务器。')
      if (entries.size >= 128 || [...entries.values()].filter(item => item.owner === owner && item.reserved > 0).length >= 4 || reserved + total > MAX_RESERVED) fail('bot/busy', '待发送附件过多，请先完成或移除已有附件。')
      entry = { requestId: body.requestId, owner, scope: { ...body.scope }, sessionId: body.sessionId, workspaceId: rt.state.workspaceId,
        fingerprint, files: files.map(file => ({ ...file, received: 0, chunks: [], last: null })), reserved: total,
        status: 'uploading', expiresAt: Date.now() + TTL }
      entries.set(key, entry); reserved += total
      return reply(entry)
    }
    if (!entry) return stale()
    if (endpoint === 'extra-attachment-status') return reply(entry)
    if (endpoint === 'extra-attachment-discard') {
      if (entry.status === 'sending' || entry.status === 'unknown') fail('bot/refused', '消息可能已经提交，请先核对发送结果。')
      if (entry.status === 'uploading') { entry.status = 'discarded'; release(entry) }
      return reply(entry)
    }
    if (endpoint === 'extra-attachment-send' && entry.status !== 'uploading') {
      if (body.text !== entry.text) return invalid()
      return reply(entry)
    }
    if (entry.status !== 'uploading' || rt.state.workspaceId !== entry.workspaceId || targetOf(rt, entry.scope) !== entry.sessionId) return stale()
    if (endpoint === 'extra-attachment-chunk') {
      if (!Number.isInteger(body.index) || body.index < 0 || body.index >= entry.files.length || !Number.isSafeInteger(body.offset) || body.offset < 0
        || typeof body.data !== 'string' || !body.data || body.data.length > Math.ceil(ATTACHMENT_LIMITS.chunkBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) return invalid()
      const bytes = Buffer.from(body.data, 'base64')
      if (!bytes.length || bytes.length > ATTACHMENT_LIMITS.chunkBytes || bytes.toString('base64') !== body.data) return invalid()
      const file = entry.files[body.index]; const digest = resourceDigest(bytes)
      if (file.last?.offset === body.offset && file.last.digest === digest) return reply(entry)
      if (body.offset !== file.received || file.received + bytes.length > file.size) return invalid()
      file.chunks.push(bytes); file.received += bytes.length; file.last = { offset: body.offset, digest }
      return reply(entry)
    }
    if (endpoint !== 'extra-attachment-send' || typeof body.text !== 'string' || body.text.length > 128 * 1024 || entry.files.some(file => file.received !== file.size)) return invalid()
    const uploads = uploadsOf()
    if (!uploads) fail('bot/unavailable', '文件上传服务不可用，消息尚未发送。')
    entry.text = body.text; entry.status = 'sending'
    let dispatched = false
    try {
      await rt.sendUser({ sessionId: entry.sessionId, content: [], requestId: `deck-attachment:${owner}:${entry.requestId}`,
        prepareContent: async sessionId => {
          const current = () => {
            check()
            if (rt.state.workspaceId !== entry.workspaceId || targetOf(rt, entry.scope) !== sessionId || !sameService(uploadsOf(), uploads)) return stale()
          }
          current()
          const content = entry.text.trim() ? [{ type: 'text', text: entry.text.trim() }] : []
          for (const file of entry.files) {
            async function* chunks() { for (const chunk of file.chunks) { current(); yield chunk } }
            const request = { sessionId, data: chunks(), name: file.name, signal }
            const result = file.kind === 'image' ? await uploads.uploadImageStream({ ...request, mediaType: file.mime }) : await uploads.uploadStream(request)
            current()
            if (!validResourceId(result?.receiptId)) fail('bot/unavailable', '上传服务没有返回有效的附件回执。')
            content.push({ type: file.kind, receiptId: result.receiptId })
          }
          current(); entry.deliveredSessionId = sessionId
          return { content, beforePrompt: () => { current(); dispatched = true } }
        },
      })
      entry.status = 'sent'; entry.message = null
    } catch {
      entry.status = dispatched ? 'unknown' : 'failed'
      entry.message = dispatched ? '消息提交结果待确认，请核对聊天记录；不会自动重发。' : '附件未能提交，消息尚未发送；请检查连接、会话与服务器文件服务后重试。'
    } finally { release(entry); entry.expiresAt = Date.now() + TTL }
    return reply(entry)
  }
  rt.ctx.effect(() => {
    const timer = setInterval(prune, 60_000); timer.unref?.()
    return () => { disposed = true; clearInterval(timer); for (const entry of entries.values()) release(entry); entries.clear() }
  }, 'ds-bot: 聊天附件上传')
}
