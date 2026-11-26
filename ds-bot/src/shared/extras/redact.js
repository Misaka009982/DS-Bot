const MASK = '[已脱敏]'
const SENSITIVE = new Set(['apikey', 'password', 'passphrase', 'token', 'accesstoken', 'refreshtoken', 'authtoken', 'secret', 'secretkey', 'secretaccesskey', 'accesskeyid', 'clientsecret', 'privatekey', 'authorization', 'cookie', 'setcookie', 'credentials', 'openaikey', 'anthropickey', 'geminikey', 'googlekey', 'azureopenaikey'])
const OMIT = new Set(['bytes', 'base64', 'privateKey'])
const TEXT_LIMIT = 2 * 1024 * 1024

const sensitiveKey = key => {
  const separated = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return SENSITIVE.has(key.replace(/[-_]/g, '').toLowerCase())
    || /(?:^|[-_])(?:api[-_]?key|password|passphrase|(?:(?:access|refresh|auth)[-_]?)?token|(?:client[-_]?)?secret|secret[-_]?(?:access[-_]?)?key|access[-_]?key[-_]?id|private[-_]?key|(?:proxy[-_]?)?authorization|(?:set[-_]?)?cookie|credentials|(?:openai|anthropic|gemini|google|azure[-_]?openai)[-_]?key)$/i.test(separated)
    || /^DSH_SECRET_/i.test(separated)
}

const ESCAPE = value => value === '\\' || value === '`'
const HEADER_FIELDS = /(["'])(?:(?:proxy[-_]?)?authorization|(?:set[-_]?)?cookie)\s*[:=]\s*|\b(?:(?:proxy[-_]?)?authorization|(?:set[-_]?)?cookie)["']?\s*[:=]\s*/gi
const SECRET_FIELDS = /\b(?:DSH_SECRET_[\w-]+|(?:[A-Za-z][\w.-]*[_-])?(?:api[_-]?key|password|passphrase|(?:access|refresh|auth)?[_-]?token|client[_-]?secret|secret|secret[_-]?(?:access[_-]?)?key|access[_-]?key[_-]?id|private[_-]?key|credentials|(?:openai|anthropic|gemini|google|azure[_-]?openai)[_-]?key))\b["']?\s*[:=]\s*/gi

function quotedValue(text, start) {
  let at = start
  while (ESCAPE(text[at])) at += 1
  const quote = text[at]
  if (quote !== '"' && quote !== "'") return undefined
  const escape = text.slice(start, at)
  const delimiter = escape + quote
  at += 1
  while (at < text.length) {
    if (escape === '') {
      if (ESCAPE(text[at])) { at += 2; continue }
      if (text[at] === quote) {
        if (text[at + 1] === quote) { at += 2; continue }
        return { end: at + 1, delimiter, closed: true }
      }
      at += 1
      continue
    }
    if (ESCAPE(text[at])) {
      let end = at
      while (ESCAPE(text[end])) end += 1
      // 多层转义只在与开头相同的层闭合，不能把内层凭据引号当成字段结束。
      if (text[end] === quote && text.slice(at, end) === escape) {
        if (text.startsWith(delimiter, end + 1)) { at = end + 1 + delimiter.length; continue }
        return { end: end + 1, delimiter, closed: true }
      }
      at = end + (text[end] === quote ? 1 : 0)
      continue
    }
    at += 1
  }
  return { end: text.length, delimiter, closed: false }
}

function structuredEnd(text, start) {
  const close = []
  let at = start
  while (at < text.length) {
    if (text[at] === '"' || text[at] === "'" || ESCAPE(text[at])) {
      const quoted = quotedValue(text, at)
      if (quoted !== undefined) { at = quoted.end; continue }
      while (ESCAPE(text[at])) at += 1
      continue
    }
    if (text[at] === '[' || text[at] === '{') {
      close.push(text[at] === '[' ? ']' : '}')
      if (close.length > 10) return text.length
    } else if (text[at] === ']' || text[at] === '}') {
      if (text[at] !== close.pop()) return text.length
      if (close.length === 0) return at + 1
    }
    at += 1
  }
  return text.length
}

function argumentEnd(text, start) {
  let at = start
  while (at < text.length && !/[\s,;}&]/.test(text[at])) {
    if (text[at] === '[' || text[at] === '{') { at = structuredEnd(text, at); continue }
    if (text[at] === '"' || text[at] === "'" || ESCAPE(text[at])) {
      const quoted = quotedValue(text, at)
      if (quoted !== undefined) { at = quoted.end; continue }
      // 没有引号的长转义串跳过一次，避免从每个字符重复扫描。
      while (ESCAPE(text[at])) at += 1
      continue
    }
    at += 1
  }
  return at
}

function maskFields(text, pattern, header = false) {
  const parts = []
  let from = 0
  pattern.lastIndex = 0
  for (let match; (match = pattern.exec(text)) !== null;) {
    const start = match.index + match[0].length
    const wrapped = header && match[1] !== undefined
    let quoteStart = wrapped ? match.index : start
    if (wrapped) while (quoteStart > from && ESCAPE(text[quoteStart - 1])) quoteStart -= 1
    const quoted = quotedValue(text, quoteStart)
    let end
    if (quoted !== undefined) end = quoted.closed ? argumentEnd(text, quoted.end) : quoted.end
    else if (header) {
      end = start
      while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end += 1
    } else {
      const scheme = /^(?:Bearer|Basic)[ \t]/i.exec(text.slice(start, start + 7))
      let valueStart = start + (scheme?.[0].length ?? 0)
      if (scheme !== null) while (text[valueStart] === ' ' || text[valueStart] === '\t') valueStart += 1
      end = argumentEnd(text, valueStart)
    }
    const open = wrapped ? '' : quoted?.delimiter ?? ''
    const close = quoted?.closed ? quoted.delimiter : ''
    parts.push(text.slice(from, start), `${open}${MASK}${close}`)
    from = end
    pattern.lastIndex = end
  }
  parts.push(text.slice(from))
  return parts.join('')
}

export function redactText(value, known = text => text) {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  if (raw.length > TEXT_LIMIT) return '[内容超过安全展示上限，未展示]'
  const originalMarks = new Set(raw.match(/\[secret:[^\r\n[\]]{1,200}\]/g) ?? [])
  const redacted = known(raw)
  let prefix = '\u0000dsbot_mark_'
  while (redacted.includes(prefix)) prefix += '_'
  const marks = []
  // 只保护密钥库本次新生成的名称标记；输入里的同形文字不能绕过规则。
  const protectedText = redacted.replace(/\[secret:[^\r\n[\]]{1,200}\]/g, mark => originalMarks.has(mark) ? mark : `${prefix}${marks.push(mark) - 1}\u0000`)
  const recognized = protectedText
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g, MASK)
  const headers = maskFields(recognized, HEADER_FIELDS, true).replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_+\/.=-]{12,}/gi, MASK)
  return maskFields(headers, SECRET_FIELDS)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(new RegExp(`${prefix}(\\d+)\\u0000`, 'g'), (all, index) => marks[Number(index)])
}

export function redactValue(value, known = text => text) {
  const seen = new Set()
  let nodes = 0
  const visit = (item, depth, pair = false) => {
    nodes += 1
    if (nodes > 1000 || depth > 10) return '[结构超过展示上限]'
    if (typeof item === 'string') return redactText(item, known)
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item
    if (typeof item !== 'object') return undefined
    // 普通 JSON data 可展示，真实二进制仍走原附件入口。
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer || item.type === 'Buffer' && Array.isArray(item.data)) return '[二进制内容未展示]'
    if (seen.has(item)) return '[循环引用]'
    seen.add(item)
    try {
      if (Array.isArray(item)) {
        // 名值元组保护凭据；普通字段名或术语列表不能因只有两项而遮盖。
        if (pair && item.length === 2 && typeof item[0] === 'string' && sensitiveKey(item[0])) return [redactText(item[0], known), MASK]
        return item.slice(0, 200).map(entry => visit(entry, depth + 1, Array.isArray(entry)))
      }
      const out = {}
      const entries = Object.entries(item).slice(0, 200)
      const namedSecret = entries.some(([key, entry]) => /^(?:name|key|header)$/i.test(key) && typeof entry === 'string' && sensitiveKey(entry))
      for (const [key, entry] of entries) {
        const pairedValue = namedSecret && /^(?:value|val|values)$/i.test(key)
        const nameValues = /^(?:headers|requestheaders|responseheaders|httpheaders|env|environment)$/i.test(key.replace(/[-_]/g, ''))
        const replaced = sensitiveKey(key) || OMIT.has(key) || pairedValue ? MASK : visit(entry, depth + 1, nameValues)
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
