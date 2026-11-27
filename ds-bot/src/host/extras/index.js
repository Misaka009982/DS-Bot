import { messageMode, remotePermissionError } from './settings.js'
import { fullMessagesAllowed, remoteExtras } from './access.js'
import { install as installPrompt } from './prompt.js'
import { install as installArchive } from './archive.js'
import { install as installSettings } from './write-settings.js'
import { install as installTools } from './tools.js'
import { install as installMessages } from './messages.js'
import { install as installTodos } from './todos.js'
import { install as installNewSession } from './new-session.js'
import { install as installSessionTools } from './session-tools.js'
import { install as installDelegations } from './delegations.js'
import { install as installWorkspace } from './workspace.js'
import { install as installTerminals } from './terminals.js'
import { install as installToolChanges } from './tool-changes.js'
import { install as installPrivateGoal } from './private-goal.js'
import { ATTACHMENT_READS, ATTACHMENT_WRITES, install as installAttachments } from './attachments.js'
import { RESOURCE_READS, RESOURCE_WRITES, RESOURCE_PERMISSIONS, resourceAllowed, resourceGrant } from './resources.js'

const DELEGATION_READS = new Set(['extra-delegation-list', 'extra-delegation-read'])
const MESSAGE_READS = new Set(['extra-tool-change'])
const READS = new Set(['extra-status', 'extra-tool-detail', 'extra-tool-list', 'extra-todos', 'extra-messages', 'extra-task-read', ...DELEGATION_READS, ...MESSAGE_READS, ...ATTACHMENT_READS, ...RESOURCE_READS.keys()])
export const EXTRA_ENDPOINTS = new Set([...READS, ...ATTACHMENT_WRITES, ...RESOURCE_WRITES.keys(), 'extra-bot-set', 'extra-defaults-set', 'phone-extra-set', 'extra-new-session', 'extra-goal-control'])
const failure = (code, message) => Object.assign(new Error(message), { code })

export function install(rt) {
  installPrompt(rt)
  installArchive(rt)
  installSettings(rt)
  installTools(rt)
  installMessages(rt)
  installTodos(rt)
  installNewSession(rt)
  installSessionTools(rt)
  installDelegations(rt)
  installWorkspace(rt)
  installTerminals(rt)
  installToolChanges(rt)
  installPrivateGoal(rt)
  installAttachments(rt)
  rt.extraResourceAccess = device => rt.extraAuthorizationPending?.() === true ? undefined : resourceGrant(rt.state.extras, device)
  rt.extraResourcePermissions = device => Object.fromEntries(RESOURCE_PERMISSIONS.map(key => [key, resourceAllowed(rt.extraResourceAccess(device), key)]))
  const resourceView = grant => {
    const files = rt.extraWorkspaceAvailable()
    return {
      ...(files ? { workspace: { schema: 1, readOnlyPreview: true, read: grant === true || resourceAllowed(grant, 'filesRead'), write: files.write && (grant === true || resourceAllowed(grant, 'filesWrite')) } } : {}),
      ...(rt.extraTerminalsAvailable() ? { terminals: { schema: 1, read: grant === true || resourceAllowed(grant, 'terminalRead'), write: grant === true || resourceAllowed(grant, 'terminalWrite') } } : {}),
    }
  }
  const delegationView = read => rt.extraDelegationsAvailable()
    ? { delegations: { schema: 1, read } } : {}
  const delegationDenial = 'Allow full messages for this paired device on the computer before reading delegations'
  const botFor = sessionId => rt.chatOwners.has(sessionId) && !rt.groupOwners.has(sessionId) && !rt.taskOwners.has(sessionId)
    ? rt.botOf(sessionId) ?? rt.botOf(rt.selfOf(sessionId)) : undefined
  rt.extraMessageMode = (sessionId, requested) => {
    const bot = botFor(sessionId)
    return messageMode(bot?.extras, requested, bot === undefined ? undefined : rt.state.extras?.defaults)
  }
  rt.extraFullMessagesAllowed = device => rt.extraAuthorizationPending?.() !== true && fullMessagesAllowed(rt.state.extras, device)
  rt.extraRemoteState = (view, device) => {
    const value = remoteExtras(view, rt.state.extras, device)
    if (value?.extras === undefined) return value
    const pending = rt.extraAuthorizationPending?.() === true
    const extras = { ...value.extras }
    delete extras.workspace
    delete extras.terminals
    return { ...value, extras: { ...extras, ...resourceView(rt.extraResourceAccess(device)), ...(pending ? { remotePermissions: false, fullMessages: false } : {}),
      toolChanges: { schema: 1, read: !pending && value.extras.fullMessages === true },
      ...(value.extras.delegations === undefined ? {} : { delegations: { ...value.extras.delegations, read: !pending && value.extras.fullMessages === true } }) } }
  }
  rt.extraRemoteAccessError = (device, endpoint, payload) => {
    const denial = remotePermissionError(rt.extraAuthorizationPending?.() !== true && rt.state.extras?.remotePermissions === true, device, endpoint, payload)
    if (denial !== undefined) return denial
    const permission = RESOURCE_READS.get(endpoint) ?? RESOURCE_WRITES.get(endpoint)
    if (permission && !resourceAllowed(rt.extraResourceAccess(device), permission)) return { code: 'bot/refused', message: '请先在电脑为该配对设备授权对应的资源读取或写入。', details: {} }
    if (MESSAGE_READS.has(endpoint) && !rt.extraFullMessagesAllowed(device)) return { code: 'bot/refused', message: '请先在电脑为该配对设备开启完整消息读取授权。', details: {} }
    if (DELEGATION_READS.has(endpoint) && !rt.extraFullMessagesAllowed(device)) {
      return { code: 'bot/refused', message: delegationDenial, details: {} }
    }
    if (!endpoint.startsWith('extra-') && (payload?.extraMessages === true || payload?.extraSteps === true || payload?.fullMessages === true)) {
      return { code: 'bot/refused', message: 'Extra message options are only accepted by the authorized extra endpoints', details: {} }
    }
    if ((['exchange', 'exchange-text'].includes(endpoint) || payload?.fullMessages === true) && !rt.extraFullMessagesAllowed(device)) {
      return { code: 'bot/refused', message: 'Allow full messages for this paired device on the computer first', details: {} }
    }
    return undefined
  }
  rt.extraView = () => ({ schema: 1, baseline: '0.3.10', newSession: true, privateGoal: { schema: 1 }, remotePermissions: rt.state.extras?.remotePermissions === true,
    defaults: { schema: 1, messageMode: ['queue', 'steer'].includes(rt.state.extras?.defaults?.messageMode) ? rt.state.extras.defaults.messageMode : 'inherit',
      autoArchive: rt.state.extras?.defaults?.autoArchive === true },
    fullMessages: true, ...(rt.extraAttachmentsView() ? { attachments: rt.extraAttachmentsView() } : {}), toolChanges: { schema: 1, read: true }, archive: rt.extraArchiveStatus?.() ?? null, ...delegationView(true), ...resourceView(true) })
  rt.isExtraRead = endpoint => READS.has(endpoint)
  rt.isExtraEndpoint = endpoint => EXTRA_ENDPOINTS.has(endpoint)

  rt.extraEndpoint = async (endpoint, body, signal, caller) => {
    if (!EXTRA_ENDPOINTS.has(endpoint)) return undefined
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw failure('bot/invalid', 'Extra settings must be an object')
    await rt.load()
    const check = () => {
      if (signal?.aborted) throw failure('bot/refused', 'The request was canceled')
      const denial = caller?.authorize?.()
      if (denial !== undefined) throw failure(denial.code, denial.message)
    }
    check()
    if (ATTACHMENT_READS.has(endpoint) || ATTACHMENT_WRITES.has(endpoint)) return rt.extraAttachment(endpoint, body, signal, caller, check)
    if (endpoint === 'extra-new-session') return rt.extraNewSession(body, check)
    if (endpoint === 'extra-goal-control') return rt.extraGoalControl(body, check)
    if (RESOURCE_READS.has(endpoint) || RESOURCE_WRITES.has(endpoint)) {
      const handler = endpoint.startsWith('extra-terminal-') ? rt.extraTerminal : rt.extraWorkspace
      const value = await handler(endpoint, body, signal, caller, check)
      check()
      return value
    }
    if (!READS.has(endpoint)) return rt.extraSettings(endpoint, body, check)
    const deviceKind = () => caller === undefined ? 'local' : caller.deviceKind?.()
    const delegationAllowed = () => caller === undefined || ['phone', 'browser'].includes(deviceKind()) && caller.fullMessages?.() === true
    if (MESSAGE_READS.has(endpoint)) {
      const checkRead = () => {
        check()
        if (!delegationAllowed()) throw failure('bot/refused', '请先在电脑为该配对设备开启完整消息读取授权。')
      }
      checkRead()
      const value = await rt.extraToolChange(body, signal, { fullMessages: true, deviceKind: deviceKind() }, checkRead)
      checkRead()
      return value
    }
    if (DELEGATION_READS.has(endpoint)) {
      const checkRead = () => {
        check()
        if (!delegationAllowed()) throw failure('bot/refused', delegationDenial)
      }
      checkRead()
      const value = await rt.extraDelegationRead(endpoint === 'extra-delegation-read', body, signal, { check: checkRead, deviceKind })
      checkRead()
      return value
    }
    const fullMessages = body.fullMessages === true && (caller === undefined || caller.fullMessages?.() === true)
    if (body.fullMessages === true && !fullMessages) throw failure('bot/refused', 'Allow full messages for this paired device on the computer first')
    if (endpoint === 'extra-status') return caller === undefined ? rt.extraView() : { ...rt.extraView(), fullMessages: caller.fullMessages?.() === true,
      toolChanges: { schema: 1, read: delegationAllowed() }, ...delegationView(delegationAllowed()), ...resourceView(caller.resources?.()) }
    const handler = endpoint === 'extra-tool-detail' ? rt.extraToolDetail : endpoint === 'extra-tool-list' ? rt.extraToolList
      : endpoint === 'extra-messages' ? rt.extraMessages : endpoint === 'extra-task-read' ? rt.extraTaskPage : rt.extraTodos
    if (typeof handler !== 'function') throw failure('bot/unavailable', 'This extra feature is not available on the computer')
    const value = await handler(body, signal, { fullMessages, deviceKind: deviceKind() })
    check()
    if (fullMessages && caller !== undefined && caller.fullMessages?.() !== true) throw failure('bot/refused', 'The full-message authorization was revoked')
    return value
  }
}
