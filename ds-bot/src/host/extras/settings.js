const MODES = new Set(['queue', 'steer'])
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const refused = message => ({ code: 'bot/refused', message, details: {} })

export function cleanBotExtras(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('Extra settings must be an object')
  const out = {}
  for (const key of Object.keys(value)) {
    if (key !== 'messageMode' && key !== 'autoArchive') throw invalid('Unknown extra setting')
  }
  if (Object.hasOwn(value, 'messageMode')) {
    const mode = value.messageMode
    if (mode !== null && mode !== 'inherit' && !MODES.has(mode)) throw invalid('Choose queue or steer')
    out.messageMode = MODES.has(mode) ? mode : null
  }
  if (Object.hasOwn(value, 'autoArchive')) {
    if (typeof value.autoArchive !== 'boolean') throw invalid('Auto archive must be on or off')
    out.autoArchive = value.autoArchive
  }
  return out
}

export function messageMode(settings, requested) {
  if (requested !== undefined && requested !== null && !MODES.has(requested)) throw invalid('Choose queue or steer')
  return MODES.has(settings?.messageMode) ? settings.messageMode : MODES.has(requested) ? requested : 'queue'
}

// 名称和客户端自报的类别都不是授权依据；device 只能取宿主的已配对记录。
export function remotePermissionError(enabled, device, endpoint, payload) {
  if (endpoint === 'phone-extra-set') return refused('Remote access cannot change the computer authorization switch')
  if (!['update-bot', 'update-room', 'create-bot', 'create-room'].includes(endpoint)
    || payload === null || typeof payload !== 'object' || !Object.hasOwn(payload, 'permission')) return undefined
  if (device?.kind !== 'phone') return refused('Permission changes require a paired phone device')
  if (enabled !== true) return refused('Allow remote permission changes on the computer first')
  return undefined
}
