import { resourceAccess, resourceDigest, resourceFailure, resourceFields, resourceHandles, observeRoot, rootServices, staleResource, unavailableResource, invalidResource, validResourceId } from './resources.js'
import { redactText } from '../../shared/extras/redact.js'

const MAX_FILE_BYTES = 256 * 1024
const MAX_ENTRIES = 4096
const PAGE_SIZE = 64
const PROTECTED = /^(?:\.git|\.hg|\.svn|\.ssh|\.dsh|\.aws|\.azure|\.gnupg|\.kube|\.npmrc|\.netrc|\.pypirc|phone\.json|id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i
const SECRET = /^(?:\.env(?:\.|$)|(?:secrets?|credentials?|tokens?|auth)(?:[._-]|$))|\.(?:pem|key|pfx|p12|keystore)$/i
const validVersion = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
const forbidden = () => resourceFailure('bot/refused', '此路径不在允许的工作区范围内，或属于受保护的文件。')

export function workspacePath(value, allowRoot = false) {
  if (allowRoot && value === '') return []
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || /[\\:\p{Cc}]/u.test(value) || value.startsWith('~')) throw forbidden()
  const parts = value.split('/')
  if (parts.some(part => !part || part.length > 255 || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || PROTECTED.test(part) || SECRET.test(part))) throw forbidden()
  return parts
}

function fileError(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('bot/')) return error
  if (error?.code === 'FS_STALE_VERSION' || error?.code === 'FS_NOT_OBSERVED') return resourceFailure('bot/conflict', '文件已经变化，请重新读取并保留本地编辑内容。')
  if (['FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_REGULAR_FILE'].includes(error?.code)) return resourceFailure('bot/not-found', '目标文件或目录已经不存在或类型改变。')
  if (error?.code === 'FS_TOO_LARGE') return resourceFailure('bot/too-large', '文件超过完整预览和编辑预算。')
  if (error?.code === 'FS_NOT_TEXT') return resourceFailure('bot/encoding', '只支持完整有效的 UTF-8 文本文件。')
  if (['FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_ABORTED'].includes(error?.code)) return resourceFailure('bot/refused', '文件操作被拒绝或取消。')
  return unavailableResource()
}

export function install(rt) {
  const roots = resourceHandles(64)
  const receipts = resourceHandles(32)
  let reading = 0
  const stop = new AbortController()
  rt.extraWorkspaceAvailable = () => {
    const fs = rootServices(rt)?.fs
    return !stop.signal.aborted && fs && ['readBytes', 'listDir', 'processPathFromHostPath'].every(key => typeof fs[key] === 'function')
      ? { read: true, write: typeof fs.writeText === 'function' } : undefined
  }
  const mask = value => redactText(value, rt.redactSecrets)
  const secrets = async access => {
    await rt.loadSecrets()
    access.check()
    if (typeof rt.redactSecrets !== 'function' || rt.secretStoreStatus?.()?.locked !== false) throw resourceFailure('bot/unavailable', '请先解锁密钥库，再读取工作区文件。')
  }
  const protectedRoot = async (context, signal) => {
    const { fs, root, check } = context
    // 映射由执行后端提供；SSH 等不共享宿主路径时不会把宿主绝对路径当远端路径。
    if (typeof fs.processPathFromHostPath !== 'function') throw unavailableResource()
    const teamPath = rt.ctx.workspaceRegistry?.get?.(rt.state.workspaceId)?.path
    const mappedTeam = teamPath ? fs.processPathFromHostPath(teamPath) : undefined
    const team = mappedTeam ? await fs.resolve(mappedTeam, { signal }) : undefined
    check()
    const segments = fs.processPath(root).split(/[\\/]/).filter(Boolean)
    if (segments.some(part => part.toLowerCase() !== '.dsh' && (PROTECTED.test(part) || SECRET.test(part)))) throw forbidden()
    if (segments.some(part => part.toLowerCase() === '.dsh') && !(team && fs.contains(team, root))) throw forbidden()
    for (const path of [rt.dshHome, rt.home, process.env.DS_BOT_USER_DSH_HOME?.trim()].filter(Boolean)) {
      const mapped = fs.processPathFromHostPath(path)
      if (mapped === undefined) continue
      const data = await fs.resolve(mapped, { signal })
      check()
      if (fs.contains(root, data) || fs.contains(data, root) && !(team && team.targetKey !== data.targetKey && fs.contains(data, team) && fs.contains(team, root))) throw forbidden()
    }
  }
  const currentRoot = async (entry, access, signal) => {
    const current = await observeRoot(rt, entry, access, signal)
    if (current.fs !== entry.fs || current.root.targetKey !== entry.root.targetKey || current.cwd !== entry.cwd || current.scopeKey !== entry.scopeKey) throw staleResource()
    await protectedRoot(current, signal)
    return current
  }
  const locate = async (context, path, allowRoot, signal) => {
    const parts = workspacePath(path, allowRoot)
    const { fs, root, cwd, check } = context
    let target = root
    for (let index = 0; index < parts.length; index += 1) {
      const relative = parts.slice(0, index + 1).join('/')
      const info = await fs.lstat(relative, { cwd }, signal)
      check()
      if (!info) throw resourceFailure('bot/not-found', '文件或目录不存在。')
      if (!['directory', 'file'].includes(info.type) || index < parts.length - 1 && info.type !== 'directory') throw forbidden()
      target = await fs.resolve(relative, { cwd, signal })
      check()
      if (!fs.contains(root, target)) throw forbidden()
      const canonicalParts = fs.processPath(target).split(/[\\/]/).slice(fs.processPath(root).split(/[\\/]/).length)
      if (canonicalParts.some(part => PROTECTED.test(part) || SECRET.test(part))) throw forbidden()
    }
    const info = await fs.stat(target, signal)
    check()
    if (!info || !validVersion(info.version)) throw resourceFailure('bot/not-found', '资源不存在或没有可验证的版本。')
    return { target, info }
  }
  const stable = async (context, path, original, access, signal) => {
    const current = await currentRoot(context, access, signal)
    const next = await locate(current, path, path === '', signal)
    if (next.target.targetKey !== original.target.targetKey || next.info.version !== original.info.version || next.info.type !== original.info.type) throw resourceFailure('bot/conflict', '读取期间资源已变化，请重新读取。')
    return current
  }
  const resultOf = receipt => ({ status: receipt.status, requestId: receipt.requestId ?? null, version: receipt.newVersion ?? null,
    ...(receipt.error ? { error: { code: receipt.error.code, message: receipt.error.message } } : {}) })

  rt.extraWorkspace = async (endpoint, body, signal, caller, check) => {
    const permission = endpoint === 'extra-workspace-save' ? 'filesWrite' : 'filesRead'
    const fused = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])])
    const access = resourceAccess(rt, caller, permission, fused, check)
    if (!rt.extraWorkspaceAvailable()?.[permission === 'filesWrite' ? 'write' : 'read']) throw unavailableResource()
    if (reading >= 4) throw resourceFailure('bot/busy', '工作区正在处理其他请求，请稍后再试。')
    reading += 1
    try {
      if (endpoint === 'extra-workspace-open') {
        resourceFields(body, ['scope', 'sessionId'])
        const context = await observeRoot(rt, body, access, fused)
        await protectedRoot(context, fused)
        access.check()
        const { check: _check, ...entry } = context
        const handle = roots.add(entry, access.principal())
        return { schema: 1, rootId: handle.id, sessionId: body.sessionId, expiresAt: handle.entry.expiresAt,
          maxFileBytes: MAX_FILE_BYTES, pageSize: PAGE_SIZE, writable: rt.extraWorkspaceAvailable().write && (caller === undefined || caller.resources?.()?.permissions?.filesWrite === true) }
      }
      const allowed = endpoint === 'extra-workspace-list' ? ['rootId', 'path', 'cursor']
        : endpoint === 'extra-workspace-read' ? ['rootId', 'path']
          : endpoint === 'extra-workspace-save' ? ['rootId', 'receiptId', 'requestId', 'content'] : ['rootId', 'receiptId']
      resourceFields(body, allowed)
      const root = roots.get(body.rootId, access.principal())
      const context = await currentRoot(root, access, fused)
      if (endpoint === 'extra-workspace-list') {
        const located = await locate(context, body.path, true, fused)
        if (located.info.type !== 'directory') throw resourceFailure('bot/not-found', '所选路径不是目录。')
        const all = await context.fs.listDir(located.target, fused)
        context.check()
        if (!Array.isArray(all) || all.length > MAX_ENTRIES) throw resourceFailure('bot/too-large', '目录条目超过读取预算，请选择更小的目录。')
        const entries = all.filter(item => {
          try { workspacePath(item.name); return !item.name.includes('/') && ['file', 'directory'].includes(item.type) && context.fs.contains(context.root, item.target) } catch { return false }
        })
        const digest = resourceDigest(JSON.stringify([body.rootId, body.path, located.info.version, entries.map(item => [item.name, item.type, item.version, item.size])]))
        let offset = 0
        if (body.cursor !== undefined) {
          resourceFields(body.cursor, ['digest', 'offset'])
          if (body.cursor.digest !== digest) throw resourceFailure('bot/conflict', '目录已变化，请重新读取第一页。')
          offset = body.cursor.offset
          if (!Number.isSafeInteger(offset) || offset < 0 || offset >= entries.length) throw invalidResource()
        }
        await stable(context, body.path, located, access, fused)
        const page = entries.slice(offset, offset + PAGE_SIZE).map(item => ({ name: item.name, type: item.type,
          ...(Number.isSafeInteger(item.size) && item.size >= 0 ? { size: item.size } : {}) }))
        return { schema: 1, rootId: body.rootId, path: body.path, entries: page, filtered: entries.length !== all.length,
          cursor: offset + page.length < entries.length ? { digest, offset: offset + page.length } : null }
      }
      if (endpoint === 'extra-workspace-read') {
        await secrets(access)
        const located = await locate(context, body.path, false, fused)
        if (located.info.type !== 'file') throw resourceFailure('bot/not-found', '所选路径不是普通文件。')
        const bytes = await context.fs.readBytes(located.target, fused, MAX_FILE_BYTES)
        context.check()
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FILE_BYTES) throw resourceFailure('bot/too-large', '文件超过完整读取预算。')
        let content
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw resourceFailure('bot/encoding', '文件不是有效的 UTF-8 文本。') }
        if (content.includes('\0')) throw resourceFailure('bot/encoding', '不支持编辑二进制文件。')
        await stable(context, body.path, located, access, fused)
        await secrets(access)
        context.check()
        const shown = mask(content)
        const redacted = shown !== content
        const editable = !redacted && rt.extraWorkspaceAvailable().write && (caller === undefined || caller.resources?.()?.permissions?.filesWrite === true)
        const handle = editable ? receipts.add({ rootId: body.rootId, path: body.path, targetKey: located.target.targetKey,
          version: located.info.version, digest: resourceDigest(content), status: 'ready' }, access.principal()) : null
        return { schema: 1, rootId: body.rootId, path: body.path, version: located.info.version, text: shown,
          complete: true, encoding: 'utf-8', redacted, editable, receiptId: handle?.id ?? null }
      }
      const receipt = receipts.get(body.receiptId, access.principal())
      if (receipt.rootId !== body.rootId) throw staleResource()
      if (endpoint === 'extra-workspace-save-status') return { schema: 1, rootId: body.rootId, receiptId: body.receiptId, ...resultOf(receipt) }
      if (endpoint === 'extra-workspace-change') {
        await secrets(access)
        context.check()
        if (receipt.status !== 'saved' || !receipt.change) throw resourceFailure('bot/not-found', '这次保存没有可读取的已应用修改。')
        const { before, after } = receipt.change
        // 缓存正文已完成字段脱敏，返回前只重新匹配密钥库，保留原遮盖标记。
        const shownBefore = before === null ? null : rt.redactSecrets(before)
        const shownAfter = after === null ? null : rt.redactSecrets(after)
        return { schema: 1, source: 'workspace-save', rootId: body.rootId, receiptId: body.receiptId, path: receipt.path,
          requestId: receipt.requestId, version: receipt.newVersion, before: shownBefore, after: shownAfter,
          complete: before !== null && after !== null, redacted: receipt.change.redacted || before !== shownBefore || after !== shownAfter }
      }
      if (endpoint !== 'extra-workspace-save' || !validResourceId(body.requestId) || typeof body.content !== 'string'
        || !body.content.isWellFormed() || body.content.includes('\0') || Buffer.byteLength(body.content, 'utf8') > MAX_FILE_BYTES) throw invalidResource()
      if (receipt.status !== 'ready') {
        if (receipt.requestId !== body.requestId || receipt.submittedDigest !== resourceDigest(body.content)) throw staleResource()
        return { schema: 1, rootId: body.rootId, receiptId: body.receiptId, ...resultOf(receipt) }
      }
      await secrets(access)
      const located = await locate(context, receipt.path, false, fused)
      if (located.info.type !== 'file' || located.target.targetKey !== receipt.targetKey || located.info.version !== receipt.version) throw resourceFailure('bot/conflict', '文件版本已变化，本地编辑内容未保存。')
      const bytes = await context.fs.readBytes(located.target, fused, MAX_FILE_BYTES)
      context.check()
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FILE_BYTES) throw resourceFailure('bot/too-large', '文件超过完整读取预算。')
      let before
      try { before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw resourceFailure('bot/encoding', '文件不再是有效文本。') }
      if (resourceDigest(before) !== receipt.digest) throw resourceFailure('bot/conflict', '文件内容已变化，本地编辑内容未保存。')
      if (mask(before) !== before) throw resourceFailure('bot/refused', '文件现在包含受保护内容，请重新读取；不能保存脱敏预览。')
      await stable(context, receipt.path, located, access, fused)
      access.check()
      if (rt.secretStoreStatus?.()?.locked !== false || mask(before) !== before) throw resourceFailure('bot/refused', '文件保护规则已变化，请重新读取后再编辑。')
      // 最后一个 await 后才原子领取回执；并发保存和重发不会执行第二次写入。
      if (receipt.status !== 'ready') throw resourceFailure('bot/busy', '此编辑回执已经提交，请查询保存结果。')
      receipt.status = 'pending'
      receipt.requestId = body.requestId
      receipt.submittedDigest = resourceDigest(body.content)
      let outcome
      try {
        outcome = await context.fs.writeText(located.target, body.content, { kind: 'replaceIfVersion', version: receipt.version }, fused)
        if (!validVersion(outcome?.version) || outcome.operation !== 'update') throw unavailableResource()
        receipt.newVersion = outcome.version
        receipt.status = 'saved'
      } catch (error) {
        receipt.error = fileError(error)
        receipt.status = ['FS_STALE_VERSION', 'FS_NOT_OBSERVED'].includes(error?.code) ? 'conflict'
          : ['FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_NOT_REGULAR_FILE', 'FS_NOT_FOUND'].includes(error?.code) ? 'failed' : 'unknown'
      }
      if (receipt.status === 'saved' && rt.secretStoreStatus?.()?.locked === false) {
        // 修改详情不可用不能抹掉后端已确认的保存结果；缓存只保留已脱敏的有界正文。
        try {
          const bounded = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_FILE_BYTES ? mask(value) : null
          const before = bounded(outcome.before), after = bounded(outcome.after)
          receipt.change = { before, after, redacted: before !== outcome.before || after !== outcome.after }
        } catch { receipt.change = undefined }
      }
      context.check()
      return { schema: 1, rootId: body.rootId, receiptId: body.receiptId, ...resultOf(receipt) }
    } catch (error) { throw fileError(error) }
    finally { reading -= 1 }
  }
  rt.ctx.effect(() => () => { stop.abort(); roots.clear(); receipts.clear() }, 'ds-bot: 增补工作区资源')
}
