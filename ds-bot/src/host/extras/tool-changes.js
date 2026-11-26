import { redactText } from '../../shared/extras/redact.js'
import { ownedSession } from './log-page.js'
import { findCall } from './tools.js'
import { invalidResource, resourceDigest, resourceFailure, resourceFields, validResourceId } from './resources.js'

const FILE_TOOLS = new Set(['write', 'edit', 'apply_patch'])
const MAX_TEXT_BYTES = 64 * 1024
const MAX_HUNKS = 256
const success = result => result?.isError === false || result?.isError === undefined && result?.ok === true

export function install(rt) {
  let reading = 0
  rt.extraToolChange = async (body, signal, options, check) => {
    resourceFields(body, ['sessionId', 'callId', 'callSeq', 'index', 'digest'])
    const index = body.index ?? 0
    if (!validResourceId(body.sessionId) || !validResourceId(body.callId) || !Number.isSafeInteger(body.callSeq) || body.callSeq < 0
      || !Number.isSafeInteger(index) || index < 0 || body.digest !== undefined && !validResourceId(body.digest)) throw invalidResource()
    if (reading >= 4) throw resourceFailure('bot/busy', '修改详情正在读取，请稍后再试。')
    reading += 1
    try {
      check()
      const scope = ownedSession(rt, body, options)
      const scopeKey = JSON.stringify(scope)
      const current = () => {
        check()
        if (signal?.aborted || JSON.stringify(ownedSession(rt, body, options)) !== scopeKey) throw resourceFailure('bot/stale', '修改记录的会话归属已变化。')
      }
      const found = await findCall(rt, scope, body, signal)
      current()
      const base = { schema: 1, source: 'tool-result', sessionId: scope.id, callId: body.callId, callSeq: found.event.seq,
        resultSeq: Number.isSafeInteger(found.resultSeq) ? found.resultSeq : null, index }
      const unavailable = reason => ({ ...base, available: false, reason })
      // 只读持久结果元数据；调用参数、当前文件和成功文案都不是旧版本证据。
      if (!FILE_TOOLS.has(found.call.name) || !success(found.result) || !Number.isSafeInteger(found.resultSeq) || found.resultSeq <= found.event.seq) {
        return unavailable('该工具尚无可核对的成功文件修改结果。')
      }
      const diffs = found.resultMeta?.diffs
      if (!Array.isArray(diffs) || diffs.length === 0) return unavailable('日志没有保留已应用的修改文本。')
      if (diffs.length > MAX_HUNKS) return unavailable('修改记录超过展示预算，请在服务器查看。')
      if (index >= diffs.length) throw invalidResource()
      const diff = diffs[index]
      if (!diff || typeof diff.path !== 'string' || !diff.path || diff.path.length > 4096 || /[\p{Cc}]/u.test(diff.path)
        || diff.oldText !== null && typeof diff.oldText !== 'string' || typeof diff.newText !== 'string') return unavailable('日志中的修改元数据不完整。')
      const page = { ...base, total: diffs.length, nextIndex: index + 1 < diffs.length ? index + 1 : null }
      if ((diff.oldText !== null && Buffer.byteLength(diff.oldText, 'utf8') > MAX_TEXT_BYTES) || Buffer.byteLength(diff.newText, 'utf8') > MAX_TEXT_BYTES) {
        return { ...page, available: false, reason: '此修改片段超过完整展示预算，未截断或伪造对比。' }
      }
      await rt.loadSecrets()
      current()
      if (typeof rt.redactSecrets !== 'function' || rt.secretStoreStatus?.()?.locked !== false) throw resourceFailure('bot/unavailable', '密钥保护服务未就绪，修改详情暂不传输。')
      const mask = value => redactText(value, rt.redactSecrets)
      const path = mask(diff.path), oldText = diff.oldText === null ? null : mask(diff.oldText), newText = mask(diff.newText)
      const digest = resourceDigest(JSON.stringify([scope.id, found.event.seq, found.resultSeq, index, path, oldText, newText]))
      if (body.digest !== undefined && body.digest !== digest) throw resourceFailure('bot/stale', '修改详情已变化，请重新读取。')
      return { ...page, available: true, digest, path, oldText, newText, kind: 'hunk', oldAvailable: oldText !== null,
        stopped: found.resultMeta.stopped === true, redacted: path !== diff.path || oldText !== diff.oldText || newText !== diff.newText,
        pathRedacted: path !== diff.path }
    } finally { reading -= 1 }
  }
}
