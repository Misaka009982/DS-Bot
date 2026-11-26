import { createHash, randomUUID } from 'node:crypto'
import { symbols } from '@deepseek-ai/cordis'
import { serviceOf } from '../services.js'

export const RESOURCE_PERMISSIONS = ['terminalRead', 'terminalWrite', 'filesRead', 'filesWrite']
export const RESOURCE_READS = new Map([
  ['extra-terminal-list', 'terminalRead'], ['extra-terminal-read', 'terminalRead'],
  ['extra-workspace-open', 'filesRead'], ['extra-workspace-list', 'filesRead'], ['extra-workspace-read', 'filesRead'],
  ['extra-workspace-save-status', 'filesRead'], ['extra-workspace-change', 'filesRead'],
])
export const RESOURCE_WRITES = new Map([
  ['extra-terminal-create', 'terminalWrite'], ['extra-terminal-input', 'terminalWrite'],
  ['extra-terminal-resize', 'terminalWrite'], ['extra-terminal-close', 'terminalWrite'],
  ['extra-workspace-save', 'filesWrite'],
])
export const resourceFailure = (code, message) => Object.assign(new Error(message), { code })
export const invalidResource = () => resourceFailure('bot/invalid', '资源请求参数无效。')
export const unavailableResource = () => resourceFailure('bot/unavailable', '当前宿主未提供所需的公开资源服务。')
export const staleResource = () => resourceFailure('bot/stale', '资源句柄已失效，请重新打开当前会话的资源。')
export const validResourceId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\p{Cc}]/u.test(value)
export const resourceDigest = value => createHash('sha256').update(value).digest('hex')
// Cordis 每次读取都可返回新代理；只比较原服务身份，实际调用仍保留代理上下文。
export const sameService = (left, right) => left != null && right != null && (left[symbols.original] ?? left) === (right[symbols.original] ?? right)
export function resourceFields(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalidResource()
}

export function resourceGrant(settings, device) {
  if (!device || !['phone', 'browser'].includes(device.kind) || !validResourceId(device.deviceId)) return undefined
  const grant = Object.hasOwn(settings?.deviceAccess ?? {}, device.deviceId) ? settings.deviceAccess[device.deviceId] : undefined
  if (!grant || grant.identityKey !== device.identityKey || grant.pairedAt !== device.pairedAt || !validResourceId(grant.resourceRevision)) return undefined
  return { owner: resourceDigest(JSON.stringify([device.deviceId, device.identityKey, device.pairedAt])), revision: grant.resourceRevision,
    deviceKind: device.kind, permissions: Object.fromEntries(RESOURCE_PERMISSIONS.map(key => [key, grant.resources?.[key] === true])) }
}

export function cleanResourceGrant(value) {
  resourceFields(value, RESOURCE_PERMISSIONS)
  if (Object.keys(value).length === 0 || Object.values(value).some(flag => typeof flag !== 'boolean')) throw invalidResource()
  return { ...value }
}

export function resourceAllowed(grant, permission) {
  if (grant?.permissions?.[permission] !== true) return false
  if (permission === 'terminalWrite') return grant.permissions.terminalRead === true
  if (permission === 'filesWrite') return grant.permissions.filesRead === true
  return true
}

export function resourceScope(rt, body, deviceKind) {
  const { scope, sessionId } = body
  if (!validResourceId(sessionId)) throw invalidResource()
  let owner, folder
  if (scope?.kind === 'bot') {
    resourceFields(scope, ['kind', 'botId'])
    owner = validResourceId(scope.botId) ? rt.botOf(scope.botId) : undefined
    if (!owner || rt.chatOf(owner.id) !== sessionId || rt.groupOwners.has(sessionId) || rt.taskOwners.has(sessionId)) throw staleResource()
    folder = [owner.workDir]
  } else if (scope?.kind === 'room') {
    resourceFields(scope, ['kind', 'roomId'])
    owner = validResourceId(scope.roomId) ? rt.roomOf(scope.roomId) : undefined
    if (!owner) throw staleResource()
    const member = Object.entries(owner.sessions ?? {}).find(([, id]) => id === sessionId)?.[0]
    if (rt.sessionOfRoom(owner) !== sessionId && (!member || !owner.members?.includes(member) || !rt.botOf(member))) throw staleResource()
    folder = [owner.workDir, member, owner.memberDirs?.[member], member ? rt.botOf(member)?.workDir : undefined]
  } else if (scope?.kind === 'task') {
    resourceFields(scope, ['kind', 'botId', 'taskId'])
    const bot = validResourceId(scope.botId) ? rt.botOf(scope.botId) : undefined
    owner = validResourceId(scope.taskId) ? bot?.tasks?.find(task => task.id === scope.taskId && task.sessionId === sessionId) : undefined
    if (!owner || owner.roomId && !rt.roomOf(owner.roomId)?.members?.includes(bot.id)) throw staleResource()
    folder = [owner.workDir, owner.roomId, bot.workDir, rt.roomOf(owner.roomId)?.workDir]
  } else if (scope?.kind === 'agent') {
    resourceFields(scope, ['kind', 'agentId'])
    if (!['local', 'phone'].includes(deviceKind)) throw resourceFailure('bot/refused', '浏览器设备不能访问团队 DSH Agent 的资源。')
    owner = validResourceId(scope.agentId) ? rt.agentById?.(scope.agentId) : undefined
    if (!owner?.sessions?.includes(sessionId)) throw staleResource()
    folder = []
  } else throw invalidResource()
  return resourceDigest(JSON.stringify([scope, sessionId, folder, rt.state.workspaceId]))
}

export function rootServices(rt) {
  const fs = serviceOf(rt.ctx, 'fs')
  const query = serviceOf(rt.ctx, 'sessionQuery')
  if (!fs || ['resolve', 'stat', 'lstat', 'contains', 'processPath'].some(key => typeof fs[key] !== 'function') || typeof query?.observeSession !== 'function') return undefined
  return { fs, query }
}

export async function observeRoot(rt, body, access, signal) {
  const services = rootServices(rt)
  if (!services) throw unavailableResource()
  const { fs, query } = services
  access.check()
  const scopeKey = resourceScope(rt, body, access.principal().deviceKind)
  const check = () => {
    access.check()
    const current = rootServices(rt)
    if (!sameService(current?.fs, fs) || !sameService(current?.query, query) || resourceScope(rt, body, access.principal().deviceKind) !== scopeKey) throw staleResource()
  }
  let view, cwd
  try {
    view = await query.observeSession(body.sessionId, { signal, projectionMode: 'all' })
    check()
    if (view?.header?.id !== body.sessionId || typeof view?.[Symbol.dispose] !== 'function'
      || view.projections?.asOfSeq !== view.cursor || !Object.hasOwn(view.projections?.values ?? {}, 'workingDirectory')) throw unavailableResource()
    cwd = view.projections.values.workingDirectory ?? view.header.cwd ?? serviceOf(rt.ctx, 'workingDirectory')?.defaultDirectory
    if (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || /[\p{Cc}]/u.test(cwd)) throw unavailableResource()
  } finally { view?.[Symbol.dispose]?.() }
  const root = await fs.resolve(cwd, { signal })
  check()
  const info = await fs.stat(root, signal)
  check()
  if (info?.type !== 'directory') throw resourceFailure('bot/not-found', '会话工作目录不存在或不是目录。')
  return { ...services, root, cwd, scopeKey, scope: { ...body.scope }, sessionId: body.sessionId, check }
}

// 句柄不携带路径或权限；授权代次变更后即使重新开启也不能复用旧句柄。
export function resourceHandles(max = 128, ttl = 10 * 60_000) {
  const entries = new Map()
  const prune = () => { for (const [id, item] of entries) if (item.expiresAt <= Date.now()) entries.delete(id) }
  return {
    add(value, principal) {
      prune()
      if (entries.size >= max) throw resourceFailure('bot/busy', '已打开的资源过多，请关闭旧面板或等待句柄到期。')
      const id = randomUUID()
      const entry = { ...value, owner: principal.owner, revision: principal.revision, expiresAt: Date.now() + ttl }
      entries.set(id, entry)
      return { id, entry }
    },
    get(id, principal) {
      if (!validResourceId(id)) throw invalidResource()
      prune()
      const entry = entries.get(id)
      if (!entry || entry.owner !== principal.owner || entry.revision !== principal.revision) throw staleResource()
      return entry
    },
    clear: () => entries.clear(),
  }
}

export function resourceAccess(rt, caller, permission, signal, check) {
  const local = { owner: 'local', revision: 'local', deviceKind: 'local', permissions: Object.fromEntries(RESOURCE_PERMISSIONS.map(key => [key, true])) }
  const principal = () => caller === undefined ? local : caller.resources?.()
  const initial = principal()
  const current = () => {
    check()
    if (signal?.aborted) throw resourceFailure('bot/refused', '资源请求已取消。')
    const now = principal()
    if (!resourceAllowed(now, permission) || now.owner !== initial?.owner || now.revision !== initial?.revision) throw resourceFailure('bot/refused', '资源授权已失效，请在电脑重新授权该设备。')
    if (permission.endsWith('Write') && rt.readOnly() !== undefined) throw resourceFailure('bot/read-only', '当前宿主只读。')
  }
  current()
  return { check: current, principal, signal }
}
