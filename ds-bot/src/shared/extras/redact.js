const MASK = '[已脱敏]'
const SENSITIVE = new Set(['apikey', 'password', 'passphrase', 'token', 'accesstoken', 'refreshtoken', 'authtoken', 'secret', 'secretkey', 'clientsecret', 'privatekey', 'authorization', 'cookie', 'setcookie', 'credentials', 'env', 'environment', 'headers'])
const OMIT = new Set(['data', 'bytes', 'base64', 'privateKey'])
const TEXT_LIMIT = 2 * 1024 * 1024

export function redactText(value, known = text => text) {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  if (raw.length > TEXT_LIMIT) return '[内容超过安全展示上限，未展示]'
  return known(raw)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g, MASK)
    .replace(/(\bauthorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi, `$1${MASK}`)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_+\/.=-]{12,}/g, MASK)
    .replace(/(\b(?:[A-Za-z][\w.-]*[_-])?(?:api[_-]?key|password|passphrase|(?:access|refresh)?[_-]?token|client[_-]?secret|secret)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}&]+)/gi, `$1${MASK}`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${MASK}@`)
}

export function redactValue(value, known = text => text) {
  const seen = new Set()
  let nodes = 0
  const visit = (item, depth) => {
    nodes += 1
    if (nodes > 1000 || depth > 10) return '[结构超过展示上限]'
    if (typeof item === 'string') return redactText(item, known)
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item
    if (typeof item !== 'object') return undefined
    if (seen.has(item)) return '[循环引用]'
    seen.add(item)
    try {
      if (Array.isArray(item)) return item.slice(0, 200).map(entry => visit(entry, depth + 1))
      const out = {}
      for (const [key, entry] of Object.entries(item).slice(0, 200)) {
        const normalized = key.replace(/[-_]/g, '').toLowerCase()
        const replaced = SENSITIVE.has(normalized) || OMIT.has(key) ? MASK : visit(entry, depth + 1)
        if (key === '__proto__') Object.defineProperty(out, key, { value: replaced, enumerable: true })
        else out[key] = replaced
      }
      return out
    } finally { seen.delete(item) }
  }
  return visit(value, 0)
}

export function displayText(value, known) {
  let parsed = value
  if (typeof value === 'string') {
    if (value.length > TEXT_LIMIT) return '[内容超过安全展示上限，未展示]'
    try { parsed = JSON.parse(value) } catch { return redactText(value, known) }
  }
  const safe = redactValue(parsed, known)
  const text = typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2) ?? ''
  return text.length > TEXT_LIMIT ? '[内容超过安全展示上限，未展示]' : text
}
