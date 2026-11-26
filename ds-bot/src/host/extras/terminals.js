import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { serviceOf } from '../services.js'
import { resourceAccess, resourceDigest, resourceFailure, resourceFields, resourceHandles, resourceScope, observeRoot, rootServices, sameService, staleResource, unavailableResource, invalidResource, validResourceId } from './resources.js'

const OUTPUT_BYTES = 512 * 1024
const PAGE_BYTES = 32 * 1024
const INPUT_BYTES = 16 * 1024
const MAX_TERMINALS = 32
const MAX_CREATIONS = 256
const CLOSED_TTL_MS = 10 * 60_000
const dimensions = (cols, rows) => Number.isSafeInteger(cols) && cols >= 2 && cols <= 500 && Number.isSafeInteger(rows) && rows >= 1 && rows <= 200

// 保存真实 PTY 字节；游标是累计字节偏移，丢失的前缀明确标为 truncated。
export function terminalBuffer(size = OUTPUT_BYTES) {
  const bytes = Buffer.alloc(size)
  let total = 0
  return {
    append(chunk) {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const start = total + Math.max(0, input.length - size)
      const kept = input.subarray(Math.max(0, input.length - size))
      const at = start % size
      const first = Math.min(kept.length, size - at)
      kept.copy(bytes, at, 0, first)
      kept.copy(bytes, 0, first)
      total += input.length
    },
    read(offset) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw invalidResource()
      const from = Math.max(offset, total - size)
      const count = Math.min(PAGE_BYTES, total - from)
      const at = from % size
      const first = Math.min(count, size - at)
      const output = Buffer.concat([bytes.subarray(at, at + first), bytes.subarray(0, count - first)])
      return { from, nextOffset: from + count, throughOffset: total, truncated: from !== offset, data: output.toString('base64') }
    },
  }
}

export function install(rt) {
  const lifetime = new AbortController()
  const terminals = new Map()
  const creations = new Map()
  const handles = resourceHandles(128)
  const handleKeys = new Map()
  const subprocess = () => serviceOf(rt.ctx, 'subprocess')
  const canCreate = () => rootServices(rt) !== undefined
    && ['spawnTerminal', 'terminalEnvironment', 'resolveExecutable'].every(key => typeof subprocess()?.[key] === 'function')
  rt.extraTerminalsAvailable = () => !lifetime.signal.aborted && (canCreate() || terminals.size > 0)
  rt.extraHasTerminals = sessionId => [...terminals.values()].some(entry => entry.sessionId === sessionId && entry.status !== 'closed')
  const pruneClosed = () => {
    const closed = [...terminals.values()].filter(entry => entry.status === 'closed').sort((a, b) => a.closedAt - b.closedAt)
    for (const [index, entry] of closed.entries()) if (entry.closedAt + CLOSED_TTL_MS <= Date.now() || index < closed.length - MAX_TERMINALS) terminals.delete(entry.id)
  }
  const view = entry => ({ terminalId: entry.id, sessionId: entry.sessionId, owner: 'user', status: entry.status,
    control: entry.controlUnknown ? 'unknown' : 'ready',
    cols: entry.cols, rows: entry.rows, exitCode: entry.exitCode ?? null, outputEnded: entry.outputEnded === true,
    ...(entry.error ? { error: entry.error } : {}) })
  const bind = (entry, principal, cleanupOnly = false) => {
    const key = JSON.stringify([entry.id, principal.owner, principal.revision, cleanupOnly])
    let handle = handleKeys.get(key)
    if (handle) {
      try { handles.get(handle.id, principal) } catch { handle = undefined }
    }
    if (!handle) {
      handle = handles.add({ terminalId: entry.id, sequence: 0, cleanupOnly }, principal)
      handleKeys.set(key, handle)
      if (handleKeys.size > 128) handleKeys.delete(handleKeys.keys().next().value)
    }
    return { ...view(entry), handleId: handle.id, cleanupOnly, nextSequence: handle.entry.sequence + 1, expiresAt: handle.entry.expiresAt,
      lastControl: handle.entry.sequence === 0 ? null : { sequence: handle.entry.sequence, status: handle.entry.result },
      writable: !cleanupOnly && entry.owner === principal.owner && principal.permissions.terminalWrite === true && entry.status === 'running' && entry.controlUnknown !== true }
  }
  const validate = (entry, access) => {
    access.check()
    if (resourceScope(rt, entry, access.principal().deviceKind) !== entry.scopeKey) throw staleResource()
  }
  const close = async entry => {
    if (entry.status === 'closed') return
    if (entry.closing) return entry.closing
    entry.status = 'closing'
    const pending = Promise.resolve().then(() => entry.process.terminate()).then(async () => {
      await entry.pump
      // 输出排空与进程结果独立结算，关闭回执必须包含最终退出事实。
      await entry.done
      entry.status = 'closed'
      entry.closedAt = Date.now()
      entry.process = undefined
      entry.error = undefined
      pruneClosed()
    }, () => {
      entry.status = 'close-unknown'
      entry.error = { code: 'bot/outcome-unknown', message: '无法确认终端已关闭，请查询状态或重试关闭。' }
      throw resourceFailure(entry.error.code, entry.error.message)
    })
    entry.closing = pending
    try { await pending } finally { if (entry.closing === pending) entry.closing = undefined }
  }
  const pump = async entry => {
    try {
      for await (const chunk of entry.process.output) entry.output.append(chunk)
    } catch {
      entry.error = { code: 'bot/unavailable', message: 'PTY 输出连接已失败，保留已接收的输出。' }
    } finally { entry.outputEnded = true }
  }

  rt.extraTerminal = async (endpoint, body, signal, caller, check) => {
    const write = !['extra-terminal-list', 'extra-terminal-read'].includes(endpoint)
    const fused = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])])
    const access = resourceAccess(rt, caller, write ? 'terminalWrite' : 'terminalRead', fused, check)
    if (!rt.extraTerminalsAvailable()) throw unavailableResource()
    pruneClosed()
    if (endpoint === 'extra-terminal-list') {
      if (body.owned === true) {
        resourceFields(body, ['owned'])
        const principal = access.principal()
        return { schema: 1, items: [...terminals.values()].filter(entry => (entry.owner === principal.owner || caller === undefined) && entry.status !== 'closed')
          .map(entry => bind(entry, principal, true)), cleanupOnly: true }
      }
      resourceFields(body, ['scope', 'sessionId'])
      const scopeKey = resourceScope(rt, body, access.principal().deviceKind)
      return { schema: 1, sessionId: body.sessionId,
        items: [...terminals.values()].filter(entry => entry.scopeKey === scopeKey && entry.status !== 'closed').map(entry => bind(entry, access.principal())),
        maxInputBytes: INPUT_BYTES, maxOutputBytes: OUTPUT_BYTES }
    }
    if (endpoint === 'extra-terminal-create') {
      if (!canCreate()) throw unavailableResource()
      resourceFields(body, ['scope', 'sessionId', 'requestId', 'cols', 'rows'])
      if (!validResourceId(body.requestId) || !dimensions(body.cols, body.rows)) throw invalidResource()
      const principal = access.principal()
      const scopeKey = resourceScope(rt, body, principal.deviceKind)
      const requestKey = JSON.stringify([principal.owner, body.requestId])
      const digest = resourceDigest(JSON.stringify([scopeKey, body.cols, body.rows]))
      let creation = creations.get(requestKey)
      if (creation) {
        if (creation.digest !== digest) throw staleResource()
        if (creation.pending) await creation.pending
        access.check()
        const entry = terminals.get(creation.terminalId)
        if (!entry || entry.status === 'closed') throw staleResource()
        validate(entry, access)
        return { schema: 1, ...bind(entry, principal) }
      }
      if (creations.size >= MAX_CREATIONS) throw resourceFailure('bot/busy', '本次宿主的创建回执已达到上限；确认并关闭终端后重启宿主才能重新创建。')
      if ([...terminals.values()].filter(entry => entry.status !== 'closed').length >= MAX_TERMINALS
        || [...terminals.values()].filter(entry => entry.sessionId === body.sessionId && entry.status !== 'closed').length >= 8) throw resourceFailure('bot/busy', '终端数量达到上限，请关闭不再使用的终端。')
      creation = { digest }
      creations.set(requestKey, creation)
      const id = randomUUID()
      const entry = { id, owner: principal.owner, scope: { ...body.scope }, sessionId: body.sessionId, scopeKey,
        cols: body.cols, rows: body.rows, status: 'creating', output: terminalBuffer(), outputEnded: false }
      terminals.set(id, entry)
      creation.terminalId = id
      creation.pending = (async () => {
        let context
        try {
          context = await observeRoot(rt, body, access, fused)
          const provider = subprocess()
          const environment = await provider.terminalEnvironment(fused)
          context.check()
          if (!['posix', 'windows'].includes(environment?.platform)) throw unavailableResource()
          const path = await provider.resolveExecutable(environment.defaultShell ?? (environment.platform === 'windows' ? 'cmd.exe' : '/bin/sh'), undefined, fused)
          context.check()
          if (!sameService(subprocess(), provider)) throw unavailableResource()
          const shell = (environment.platform === 'windows' ? win32 : posix).basename(path).toLowerCase().replace(/\.exe$/, '')
          const args = ['pwsh', 'powershell'].includes(shell) ? ['-NoLogo'] : environment.platform === 'posix' ? ['-i'] : []
          entry.process = await provider.spawnTerminal({ argv: [path, ...args], cwd: context.fs.processPath(context.root),
            env: {}, cols: body.cols, rows: body.rows, terminalType: 'xterm-256color', graceMs: 1000, signal: fused })
          entry.status = 'running'
          entry.pump = pump(entry)
          entry.done = Promise.resolve(entry.process.done).then(outcome => {
            entry.exitCode = Number.isInteger(outcome?.exitCode) ? outcome.exitCode : null
            if (!['closing', 'closed', 'close-unknown'].includes(entry.status)) entry.status = 'exited'
          }, () => {
            if (!['closing', 'closed', 'close-unknown'].includes(entry.status)) entry.status = 'failed'
            entry.error = { code: 'bot/outcome-unknown', message: '无法确认终端进程结果；可以查看已收输出或明确关闭。' }
          })
          context.check()
          validate(entry, access)
        } catch (error) {
          if (entry.process) {
            try { await close(entry) } catch { /* 保留清理失败的所有权，等待显式关闭或卸载。 */ }
          } else { entry.status = 'failed'; entry.outputEnded = true; terminals.delete(id) }
          entry.error ??= { code: 'bot/unavailable', message: '真实 PTY 分配失败；没有启动替代进程。' }
          throw error?.code?.startsWith('bot/') ? error : unavailableResource()
        }
      })()
      try { await creation.pending } finally { creation.pending = undefined }
      access.check()
      return { schema: 1, ...bind(entry, principal) }
    }
    const allowed = endpoint === 'extra-terminal-read' ? ['handleId', 'offset']
      : endpoint === 'extra-terminal-input' ? ['handleId', 'sequence', 'data']
        : endpoint === 'extra-terminal-resize' ? ['handleId', 'sequence', 'cols', 'rows'] : ['handleId']
    resourceFields(body, allowed)
    const handle = handles.get(body.handleId, access.principal())
    const entry = terminals.get(handle.terminalId)
    if (!entry && endpoint === 'extra-terminal-close' && handle.closed) return { schema: 1, terminalId: handle.terminalId, status: 'closed' }
    if (!entry) throw staleResource()
    if (handle.cleanupOnly) {
      if (endpoint !== 'extra-terminal-close' || entry.owner !== access.principal().owner && caller !== undefined) throw resourceFailure('bot/refused', '清理句柄只能用于明确关闭所属的用户终端。')
    } else validate(entry, access)
    if (endpoint === 'extra-terminal-read') return { schema: 1, ...view(entry), handleId: body.handleId, encoding: 'base64',
      nextSequence: handle.sequence + 1, lastControl: handle.sequence === 0 ? null : { sequence: handle.sequence, status: handle.result },
      writable: entry.owner === access.principal().owner && access.principal().permissions.terminalWrite === true && entry.status === 'running' && !entry.controlUnknown,
      ...entry.output.read(body.offset) }
    if (entry.owner !== access.principal().owner && !(handle.cleanupOnly && caller === undefined)) throw resourceFailure('bot/refused', '只能控制本设备创建的用户终端。')
    if (endpoint === 'extra-terminal-close') {
      if (!entry.process && entry.status !== 'closed') throw resourceFailure('bot/busy', '终端仍在分配或分配未成功，请查询状态。')
      await close(entry)
      handle.closed = true
      access.check()
      return { schema: 1, ...view(entry) }
    }
    if (!['extra-terminal-input', 'extra-terminal-resize'].includes(endpoint) || !Number.isSafeInteger(body.sequence) || body.sequence < 1) throw invalidResource()
    if (endpoint === 'extra-terminal-input' && (typeof body.data !== 'string' || !body.data.isWellFormed() || Buffer.byteLength(body.data, 'utf8') > INPUT_BYTES)
      || endpoint === 'extra-terminal-resize' && !dimensions(body.cols, body.rows)) throw invalidResource()
    const digest = resourceDigest(JSON.stringify([endpoint, body.data, body.cols, body.rows]))
    if (body.sequence === handle.sequence && digest === handle.digest) return { schema: 1, sequence: body.sequence, status: handle.result ?? 'pending' }
    if (body.sequence !== handle.sequence + 1) throw staleResource()
    if (entry.status !== 'running' || entry.controlUnknown) throw resourceFailure('bot/outcome-unknown', '终端已退出或上次控制结果不确定，不能重放输入。')
    if (entry.busy) throw resourceFailure('bot/busy', '上一条终端输入或尺寸操作尚未完成。')
    entry.busy = true
    handle.sequence = body.sequence
    handle.digest = digest
    handle.result = 'pending'
    try {
      validate(entry, access)
      if (endpoint === 'extra-terminal-input') await entry.process.write(body.data)
      else {
        await entry.process.resize(body.cols, body.rows)
        entry.cols = body.cols
        entry.rows = body.rows
      }
      handle.result = 'accepted'
    } catch {
      handle.result = 'unknown'
      entry.controlUnknown = true
    } finally { entry.busy = false }
    access.check()
    return { schema: 1, sequence: body.sequence, status: handle.result }
  }
  rt.ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...creations.values()].map(item => item.pending).filter(Boolean))
    const results = await Promise.allSettled([...terminals.values()].filter(entry => entry.process).map(close))
    handles.clear()
    handleKeys.clear()
    if (results.some(result => result.status === 'rejected')) throw resourceFailure('bot/outcome-unknown', '部分用户终端未能确认关闭。')
    terminals.clear()
    creations.clear()
  }, 'ds-bot: 增补服务器终端')
}
