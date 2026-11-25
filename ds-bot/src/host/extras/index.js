import { messageMode, remotePermissionError } from './settings.js'
import { fullMessagesAllowed, remoteExtras } from './access.js'
import { install as installPrompt } from './prompt.js'
import { install as installArchive } from './archive.js'
import { install as installSettings } from './write-settings.js'
import { install as installTools } from './tools.js'
import { install as installMessages } from './messages.js'
import { install as installTodos } from './todos.js'
import { install as installNewSession } from './new-session.js'

const READS = new Set(['extra-status', 'extra-tool-detail', 'extra-tool-list', 'extra-todos', 'extra-messages', 'extra-task-read'])
export const EXTRA_ENDPOINTS = new Set([...READS, 'extra-bot-set', 'phone-extra-set', 'extra-new-session'])
const failure = (code, message) => Object.assign(new Error(message), { code })

export function install(rt) {
  installPrompt(rt)
  installArchive(rt)
  installSettings(rt)
  installTools(rt)
  installMessages(rt)
  installTodos(rt)
  installNewSession(rt)
  const botFor = sessionId => rt.chatOwners.has(sessionId) && !rt.groupOwners.has(sessionId) && !rt.taskOwners.has(sessionId)
    ? rt.botOf(sessionId) ?? rt.botOf(rt.selfOf(sessionId)) : undefined
  rt.extraMessageMode = (sessionId, requested) => messageMode(botFor(sessionId)?.extras, requested)
  rt.extraFullMessagesAllowed = device => rt.extraAuthorizationPending?.() !== true && fullMessagesAllowed(rt.state.extras, device)
  rt.extraRemoteState = (view, device) => {
    const value = remoteExtras(view, rt.state.extras, device)
    return value?.extras && rt.extraAuthorizationPending?.() === true
      ? { ...value, extras: { ...value.extras, remotePermissions: false, fullMessages: false } } : value
  }
  rt.extraRemoteAccessError = (device, endpoint, payload) => {
    const denial = remotePermissionError(rt.extraAuthorizationPending?.() !== true && rt.state.extras?.remotePermissions === true, device, endpoint, payload)
    if (denial !== undefined) return denial
    if (!endpoint.startsWith('extra-') && (payload?.extraMessages === true || payload?.extraSteps === true || payload?.fullMessages === true)) {
      return { code: 'bot/refused', message: 'Extra message options are only accepted by the authorized extra endpoints', details: {} }
    }
    if ((['exchange', 'exchange-text'].includes(endpoint) || payload?.fullMessages === true) && !rt.extraFullMessagesAllowed(device)) {
      return { code: 'bot/refused', message: 'Allow full messages for this paired device on the computer first', details: {} }
    }
    return undefined
  }
  rt.extraView = () => ({ schema: 1, baseline: '0.3.10', newSession: true, remotePermissions: rt.state.extras?.remotePermissions === true, fullMessages: true, archive: rt.extraArchiveStatus?.() ?? null })
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
    if (endpoint === 'extra-new-session') return rt.extraNewSession(body, check)
    if (!READS.has(endpoint)) return rt.extraSettings(endpoint, body, check)
    const fullMessages = body.fullMessages === true && (caller === undefined || caller.fullMessages?.() === true)
    if (body.fullMessages === true && !fullMessages) throw failure('bot/refused', 'Allow full messages for this paired device on the computer first')
    if (endpoint === 'extra-status') return caller === undefined ? rt.extraView() : { ...rt.extraView(), fullMessages: caller.fullMessages?.() === true }
    const handler = endpoint === 'extra-tool-detail' ? rt.extraToolDetail : endpoint === 'extra-tool-list' ? rt.extraToolList
      : endpoint === 'extra-messages' ? rt.extraMessages : endpoint === 'extra-task-read' ? rt.extraTaskPage : rt.extraTodos
    if (typeof handler !== 'function') throw failure('bot/unavailable', 'This extra feature is not available on the computer')
    const value = await handler(body, signal, { fullMessages, deviceKind: caller === undefined ? 'local' : caller.deviceKind?.() })
    check()
    if (fullMessages && caller !== undefined && caller.fullMessages?.() !== true) throw failure('bot/refused', 'The full-message authorization was revoked')
    return value
  }
}
