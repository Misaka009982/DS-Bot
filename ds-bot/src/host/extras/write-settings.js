import { cleanBotExtras, cleanDefaults, messageMode } from './settings.js'
import { randomUUID } from 'node:crypto'
import { cleanResourceGrant } from './resources.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
const failure = (code, message) => Object.assign(new Error(message), { code })

export function install(rt) {
  let writing = Promise.resolve()
  let authorizationPending = false
  const modeChanges = new Set()
  rt.extraAuthorizationPending = () => authorizationPending
  rt.extraGoalModePending = botId => modeChanges.has(botId)
  const pauseForMode = (bot, settings, defaults) => {
    if (messageMode(settings, undefined, defaults) === 'steer') return undefined
    modeChanges.add(bot.id)
    return rt.extraPauseGoal?.(bot.id, '私聊目标仅支持 steer；请设为 steer 后手动恢复目标。')
  }
  rt.extraSettings = (endpoint, body, check = () => {}) => {
    const run = writing.then(async () => {
      await rt.load()
      const checkWrite = () => {
        check()
        if (rt.readOnly() !== undefined) throw failure('bot/read-only', rt.readOnly())
      }
      checkWrite()
      if (endpoint === 'extra-bot-set') {
        const { id, ...input } = body
        const bot = typeof id === 'string' ? rt.botOf(id) : undefined
        if (bot === undefined) throw failure('bot/not-found', 'Unknown Bot')
        const patch = cleanBotExtras(input)
        if (Object.hasOwn(patch, 'messageMode')) {
          // 先冻结旧续跑再改模式；快速切回 steer 也不会复活旧目标消息。
          await pauseForMode(bot, { ...record(bot.extras), ...patch }, rt.state.extras?.defaults)
          checkWrite()
          if (rt.botOf(id) !== bot) throw failure('bot/not-found', 'Unknown Bot')
        }
        const previous = bot.extras
        const next = { ...record(previous), ...patch }
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
      if (endpoint === 'extra-defaults-set') {
        const patch = cleanDefaults(body)
        if (Object.hasOwn(patch, 'messageMode')) {
          const defaults = { ...record(rt.state.extras?.defaults), ...patch }
          await Promise.all(Object.values(rt.state.bots ?? {}).map(bot => pauseForMode(bot, bot.extras, defaults)))
          checkWrite()
        }
        const previous = rt.state.extras
        const next = { ...record(previous), defaults: { ...record(previous?.defaults), ...patch } }
        rt.state.extras = next
        try { await rt.save({ required: true }) } catch (error) {
          if (rt.state.extras === next) {
            if (previous === undefined) delete rt.state.extras
            else rt.state.extras = previous
          }
          throw error
        }
        return rt.extraView()
      }
      if (endpoint !== 'phone-extra-set') throw failure('bot/not-found', 'Unknown extra endpoint')
      const keys = Object.keys(body)
      let patch
      if (keys.every(key => key === 'remotePermissions') && typeof body.remotePermissions === 'boolean') {
        patch = { remotePermissions: body.remotePermissions }
      } else if (keys.every(key => ['deviceId', 'pairedAt', 'fullMessages', 'resources'].includes(key)) && typeof body.deviceId === 'string'
        && (typeof body.fullMessages === 'boolean' || body.resources !== undefined)
        && (body.fullMessages === undefined || typeof body.fullMessages === 'boolean')) {
        const devices = rt.extraPairedDevices?.() ?? []
        const device = devices.find(entry => entry.deviceId === body.deviceId)
        if (device === undefined || typeof body.pairedAt !== 'number' || device.pairedAt !== body.pairedAt) throw failure('bot/stale', 'The paired device changed. Refresh and authorize it again.')
        const activeIds = new Set(devices.map(entry => entry.deviceId))
        const kept = Object.fromEntries(Object.entries(record(rt.state.extras?.deviceAccess)).filter(([id]) => activeIds.has(id)))
        const saved = Object.hasOwn(kept, device.deviceId) ? kept[device.deviceId] : undefined
        const previousGrant = saved?.identityKey === device.identityKey && saved?.pairedAt === device.pairedAt ? saved : {}
        const nextGrant = { ...previousGrant, identityKey: device.identityKey, pairedAt: device.pairedAt,
          ...(body.fullMessages === undefined ? {} : { fullMessages: body.fullMessages }) }
        if (body.resources !== undefined) {
          const resources = { ...record(previousGrant.resources), ...cleanResourceGrant(body.resources) }
          if (body.resources.terminalRead === false) resources.terminalWrite = false
          if (body.resources.filesRead === false) resources.filesWrite = false
          if (resources.terminalWrite === true && resources.terminalRead !== true || resources.filesWrite === true && resources.filesRead !== true) throw failure('bot/invalid', '请先允许资源读取，再允许对应写入。')
          nextGrant.resources = resources
          nextGrant.resourceRevision = randomUUID()
        }
        patch = { deviceAccess: { ...kept, [device.deviceId]: nextGrant } }
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
    }).finally(() => modeChanges.clear())
    writing = run.catch(() => {})
    return run
  }
}
