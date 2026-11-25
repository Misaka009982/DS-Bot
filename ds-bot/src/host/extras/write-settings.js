import { cleanBotExtras } from './settings.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
const failure = (code, message) => Object.assign(new Error(message), { code })

export function install(rt) {
  let writing = Promise.resolve()
  let authorizationPending = false
  rt.extraAuthorizationPending = () => authorizationPending
  rt.extraSettings = (endpoint, body, check = () => {}) => {
    const run = writing.then(async () => {
      await rt.load()
      check()
      if (rt.readOnly() !== undefined) throw failure('bot/read-only', rt.readOnly())
      if (endpoint === 'extra-bot-set') {
        const { id, ...patch } = body
        const bot = typeof id === 'string' ? rt.botOf(id) : undefined
        if (bot === undefined) throw failure('bot/not-found', 'Unknown Bot')
        const previous = bot.extras
        const next = { ...record(previous), ...cleanBotExtras(patch) }
        bot.extras = next
        try { await rt.save({ required: true }) } catch (error) {
          if (bot.extras === next) {
            if (previous === undefined) delete bot.extras
            else bot.extras = previous
          }
          throw error
        }
        return next
      }
      if (endpoint !== 'phone-extra-set') throw failure('bot/not-found', 'Unknown extra endpoint')
      const keys = Object.keys(body)
      let patch
      if (keys.every(key => key === 'remotePermissions') && typeof body.remotePermissions === 'boolean') {
        patch = { remotePermissions: body.remotePermissions }
      } else if (keys.every(key => ['deviceId', 'pairedAt', 'fullMessages'].includes(key)) && typeof body.deviceId === 'string' && typeof body.fullMessages === 'boolean') {
        const devices = rt.extraPairedDevices?.() ?? []
        const device = devices.find(entry => entry.deviceId === body.deviceId)
        if (device === undefined || typeof body.pairedAt !== 'number' || device.pairedAt !== body.pairedAt) throw failure('bot/stale', 'The paired device changed. Refresh and authorize it again.')
        const activeIds = new Set(devices.map(entry => entry.deviceId))
        const kept = Object.fromEntries(Object.entries(record(rt.state.extras?.deviceAccess)).filter(([id]) => activeIds.has(id)))
        patch = { deviceAccess: { ...kept, [device.deviceId]: { identityKey: device.identityKey, pairedAt: device.pairedAt, fullMessages: body.fullMessages } } }
      } else {
        throw failure('bot/invalid', 'Choose an extra authorization switch')
      }
      const previous = rt.state.extras
      const next = { ...record(previous), ...patch }
      rt.state.extras = next
      authorizationPending = true
      try { await rt.save({ required: true }) } catch (error) {
        if (rt.state.extras === next) {
          if (previous === undefined) delete rt.state.extras
          else rt.state.extras = previous
        }
        throw error
      } finally { authorizationPending = false }
      return rt.extraView()
    })
    writing = run.catch(() => {})
    return run
  }
}
