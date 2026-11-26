// 与现有配对解析和握手名称上限一致，不让手机静默截断自定义名称。
export const PHONE_NAME_LIMIT = 64
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u
const LONE_SURROGATE = /[\uD800-\uDFFF]/u
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

export function cleanPhoneServerName(value) {
  if (typeof value !== 'string') throw invalid('Server name must be text')
  const name = value.trim()
  if (LONE_SURROGATE.test(name)) throw invalid('Server name must contain valid Unicode text')
  if (name.length > PHONE_NAME_LIMIT || CONTROL.test(value)) throw invalid('Server name must be at most 64 characters and contain no control characters')
  return name
}

export function readPhoneServerName(value) {
  try { return typeof value === 'string' ? cleanPhoneServerName(value) : '' } catch { return '' }
}

export function renamePhonePairing(pairing, name) {
  if (pairing === null) return null
  const rename = uri => {
    const url = new URL(uri)
    url.searchParams.set('name', name)
    return url.href
  }
  // 只更新显示元数据，不另开配对窗口或延长已发出的配对码有效期。
  return { ...pairing, uri: rename(pairing.uri), browserUri: rename(pairing.browserUri) }
}
