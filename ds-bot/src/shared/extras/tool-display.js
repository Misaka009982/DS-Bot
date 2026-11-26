// 展示信息只取真实字段；工具类别是固定文案，不推测执行目的。
export function toolArguments(value) {
  if (typeof value === 'string') {
    if (value.length > 65536) return null
    try { value = JSON.parse(value) } catch { return null }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}
const firstValue = (...values) => values.find(value => typeof value === 'string' && value.trim())
const firstText = (...values) => firstValue(...values)?.trim()
export function toolPresentation(name, value) {
  const args = toolArguments(value)
  const kind = ['read', 'read_file'].includes(name) ? 'read'
    : ['write', 'write_file'].includes(name) ? 'write'
      : ['edit', 'apply_patch', 'str_replace_editor'].includes(name) ? 'edit'
        : ['bash', 'powershell', 'pwsh', 'shell', 'exec_command'].includes(name) ? 'command'
          : ['grep', 'rg', 'ffgrep', 'glob', 'find', 'fffind', 'search'].includes(name) ? 'search' : 'tool'
  return { kind, filePath: args && ['read', 'write', 'edit', 'search'].includes(kind) ? firstValue(args.file_path, args.path, args.filePath, args.filename) : undefined,
    description: args ? firstText(args.description, args.justification) : undefined,
    command: args && kind === 'command' ? firstValue(args.command, args.cmd, args.script) : undefined }
}
export function toolIdentity(tool, fallback) {
  return JSON.stringify([tool.sessionId ?? null, tool.callId ?? fallback, tool.callSeq ?? tool.instance ?? tool.turn ?? null])
}
export function displayToolPath(filePath, workDir) {
  if (typeof filePath !== 'string') return ''
  const path = filePath.replaceAll('\\', '/')
  if (typeof workDir !== 'string' || !workDir.trim()) return path
  const root = workDir.replaceAll('\\', '/').replace(/\/+$/, '')
  const insensitive = /^[A-Za-z]:\//.test(root)
  const starts = insensitive ? path.toLowerCase().startsWith(`${root.toLowerCase()}/`) : path.startsWith(`${root}/`)
  return starts && root ? `${root.slice(root.lastIndexOf('/') + 1)}/${path.slice(root.length + 1)}` : path
}

// 只合并消息之间连续的工具行；原调用与消息均不改写。
export function groupToolRows(items, sessionId) {
  const rows = []
  for (const item of items) {
    const previous = rows.at(-1)
    const scope = row => JSON.stringify([row.sessionId ?? sessionId, ...new Set((row.tools ?? []).map(tool => tool.sessionId ?? row.sessionId ?? sessionId))])
    if (item.kind === 'steps' && item.tools?.length && previous?.kind === 'steps' && scope(previous) === scope(item)) {
      previous.tools.push(...item.tools)
      if (typeof item.time === 'number') previous.end = item.time
    } else rows.push(item.kind === 'steps' ? { ...item, tools: [...(item.tools ?? [])] } : item)
  }
  return rows
}
export function uniqueTools(tools, sessionId) {
  const result = []; const seen = new Map()
  for (const [index, original] of tools.entries()) {
    const tool = { ...original, sessionId: original.sessionId ?? sessionId }
    const key = tool.callId ? toolIdentity(tool) : `missing:${index}`
    if (seen.has(key)) result[seen.get(key)] = { ...result[seen.get(key)], ...tool }
    else { seen.set(key, result.length); result.push(tool) }
  }
  return result
}
