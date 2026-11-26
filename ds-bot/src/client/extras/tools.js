import { createElement as h, useEffect, useRef, useState } from 'react'
import { language } from '../i18n.js'
import { writeClipboard } from '../dsh-primitives.js'
import { extraText } from '../../shared/extras/copy.js'
import { displayToolPath, toolArguments, toolIdentity, toolPresentation, uniqueTools } from '../../shared/extras/tool-display.js'
import { readTool } from './tool-reads.js'

const text = (key, params) => extraText(key, language(), params)
const CSS = `.bt-extra-tools{font-size:13px;color:var(--bt-ink-2);margin:6px 0;min-width:0}.bt-extra-tools summary{cursor:pointer;overflow-wrap:anywhere}.bt-extra-tools>summary{font-size:12px}.bt-extra-tool-list{padding:8px 0 2px 12px}.bt-extra-tool{margin:6px 0;min-width:0}.bt-extra-tool>summary{list-style:none;display:flex;align-items:baseline;gap:8px;line-height:22px}.bt-extra-tool>summary::-webkit-details-marker{display:none}.bt-extra-tool-chevron{display:inline-block;width:12px;flex:none;transition:transform .12s}.bt-extra-tool[open]>summary .bt-extra-tool-chevron{transform:rotate(90deg)}.bt-extra-tool-target{overflow-wrap:anywhere;text-decoration:underline dotted;text-underline-offset:3px}.bt-extra-tool-state{font-size:11px;color:var(--bt-ink-3);margin-left:auto;white-space:nowrap}.bt-extra-tool[data-failed]>summary .bt-extra-tool-state{color:var(--bt-danger)}.bt-extra-tool-body{border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-hover);margin:7px 0 14px;overflow:hidden}.bt-extra-tool-field{padding:12px 14px;min-width:0}.bt-extra-tool-field+.bt-extra-tool-field{border-top:1px solid var(--bt-line)}.bt-extra-tool-field-head{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--bt-ink-3);margin-bottom:6px}.bt-extra-tool-copy{margin-left:auto;border:0;background:transparent;color:var(--bt-ink-2);font:inherit;cursor:pointer}.bt-extra-tool pre,.bt-extra-note pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;font-family:var(--ds-font-family-code,monospace);font-size:12px;line-height:20px;margin:0}.bt-extra-tool-params{font-size:11px;color:var(--bt-ink-3);white-space:pre-wrap;overflow-wrap:anywhere}.bt-extra-tool-limit{font-size:11px;color:var(--bt-ink-3);margin:6px 0}.bt-extra-note{padding:10px 12px;border:1px solid var(--bt-line);border-radius:10px;margin:6px 0;min-width:0}.bt-extra-note[data-error]{border-color:var(--bt-danger)}.bt-extra-note summary{cursor:pointer}.bt-extra-note p{white-space:pre-wrap;overflow-wrap:anywhere}`
const status = tool => tool.ok === true ? 'Success' : tool.ok === false ? 'Failed' : 'Unconfirmed'
const CATEGORIES = { read: 'Read', write: 'Write', edit: 'Edit', command: 'Run command', search: 'Search', tool: 'Tool' }
const DETAIL_LIMIT = 131072
const DENIALS = new Set(['bot/refused', 'bot/detail-invalid', 'HTTP_401', 'HTTP_403'])
const invalidDetail = () => Object.assign(new Error(text('The tool detail reply is invalid or incompatible.')), { code: 'bot/detail-invalid' })

function checkDetail(value, tool, field, previous) {
  if (value?.available === false && typeof value.reason === 'string') return { available: false, reason: value.reason }
  if (value?.available !== true || value.sessionId !== tool.sessionId || value.callId !== tool.callId || value.field !== field
    || typeof value.text !== 'string' || value.text.length > 32768 || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/i.test(value.digest)
    || !Number.isSafeInteger(value.offset) || value.offset !== (previous?.nextOffset ?? 0)
    || !Number.isSafeInteger(value.totalChars) || value.totalChars < 0 || value.totalChars > 2 * 1024 * 1024 || value.redacted !== true) throw invalidDetail()
  const end = value.offset + value.text.length
  if (end > value.totalChars || (value.nextOffset === null ? end !== value.totalChars
    : !Number.isSafeInteger(value.nextOffset) || value.nextOffset !== end || end <= value.offset || end >= value.totalChars)) throw invalidDetail()
  if (previous && (value.digest !== previous.digest || value.totalChars !== previous.totalChars)) {
    throw Object.assign(new Error(text('The tool detail changed. Read the first page again.')), { code: 'bot/stale' })
  }
  return value
}

function useToolField(tool, field, fullMessages, enabled, onDenied) {
  const [state, setState] = useState({ busy: false, value: null, error: null })
  const request = useRef(null)
  const mounted = useRef(false)
  const load = async more => {
    if (!mounted.current || !enabled || request.current !== null) return
    const previous = more ? state.value : null
    if (more && (!previous?.available || previous.nextOffset == null || previous.previewLimited)) return
    const controller = new AbortController()
    request.current = controller
    setState(prev => ({ ...prev, busy: true, error: null }))
    try {
      const response = await readTool('extra-tool-detail', { sessionId: tool.sessionId, callId: tool.callId, callSeq: tool.callSeq, field,
        fullMessages, ...(more ? { offset: previous.nextOffset, digest: previous.digest } : {}) }, controller.signal)
      if (controller.signal.aborted || request.current !== controller) return
      const value = checkDetail(response, tool, field, previous)
      if (!value.available) { setState({ busy: false, error: null, value }); return }
      const joined = previous ? previous.text + value.text : value.text
      let end = Math.min(joined.length, DETAIL_LIMIT)
      if (end < joined.length && /[\uD800-\uDBFF]/.test(joined[end - 1])) end -= 1
      const previewLimited = joined.length > DETAIL_LIMIT || joined.length >= DETAIL_LIMIT && value.nextOffset !== null
      setState({ busy: false, error: null, value: { ...value, offset: 0, text: joined.slice(0, end), previewLimited } })
    } catch (failure) {
      if (controller.signal.aborted || request.current !== controller) return
      setState(prev => ({ ...prev, busy: false, error: failure.message, value: DENIALS.has(failure.code) ? null : prev.value }))
      if (DENIALS.has(failure.code)) onDenied(failure.message)
    } finally { if (request.current === controller) request.current = null }
  }
  useEffect(() => {
    mounted.current = true
    setState({ busy: false, value: null, error: null })
    if (enabled) void load(false)
    return () => { mounted.current = false; request.current?.abort(); request.current = null }
  }, [enabled, tool.sessionId, tool.callId, tool.callSeq, fullMessages, field, field === 'output' ? tool.ok : null])
  return { ...state, load }
}

function ToolField({ reader, field, command, compact = false }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const value = reader.value
  const shown = value?.available ? command ?? value.text : null
  const parsed = value?.available && value.nextOffset === null && !value.previewLimited ? toolArguments(value.text) : null
  const compactArgs = compact && parsed && Object.keys(parsed).every(key => ['file_path', 'path', 'filePath', 'filename', 'offset', 'limit'].includes(key))
    ? Object.entries(parsed).map(([key, entry]) => `${key}: ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`).join(' · ') : null
  const remaining = command && parsed ? Object.fromEntries(Object.entries(parsed).filter(([key]) => !['command', 'cmd', 'script', 'description', 'justification'].includes(key))) : null
  useEffect(() => { setCopied(false); setCopyError(false) }, [shown])
  const copy = async () => {
    try {
      if (!await writeClipboard(shown)) throw new Error('copy')
      setCopied(true); setCopyError(false)
    } catch { setCopyError(true) }
  }
  return h('section', { className: 'bt-extra-tool-field', 'data-field': field },
    h('div', { className: 'bt-extra-tool-field-head' }, text(command ? 'Command' : field === 'arguments' ? 'Arguments' : 'Output'),
      shown !== null ? h('button', { type: 'button', className: 'bt-extra-tool-copy', onClick: copy }, text(copied ? 'Copied' : 'Copy')) : null),
    reader.busy ? h('span', { role: 'status' }, text('Loading…')) : null,
    reader.error ? h('p', { role: 'alert' }, reader.error, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void reader.load(false) }, text('Retry'))) : null,
    copyError ? h('p', { role: 'alert' }, text('Could not copy. Select the text to copy it.')) : null,
    value ? h('div', null, compactArgs ? h('div', { className: 'bt-extra-tool-params' }, compactArgs) : h('pre', null, value.available ? shown : value.reason),
      remaining && Object.keys(remaining).length ? h('pre', { className: 'bt-extra-tool-params' }, JSON.stringify(remaining, null, 2)) : null,
      value.previewLimited ? h('p', { className: 'bt-extra-tool-limit' }, text('Tool detail display limit reached. Open the original session to see more.')) : null,
      value.nextOffset != null && !value.previewLimited ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: reader.busy, onClick: () => void reader.load(true) }, text('Load more')) : null) : null)
}

function ToolCall({ tool, fullMessages, workDir, native, pending, onDenied }) {
  const [open, setOpen] = useState(false)
  const available = Boolean(tool.callId && tool.sessionId && (!native || Number.isSafeInteger(tool.callSeq)))
  const args = useToolField(tool, 'arguments', fullMessages, open && available, onDenied)
  const output = useToolField(tool, 'output', fullMessages, open && available, onDenied)
  const completeArgs = open && args.value?.available && args.value.nextOffset === null && !args.value.previewLimited ? args.value.text : null
  const view = toolPresentation(tool.name, completeArgs)
  const target = tool.filePath ?? view.filePath
  const description = target ? displayToolPath(target, workDir) : tool.description ?? view.description ?? tool.label ?? (view.kind === 'tool' || view.kind === 'command' ? tool.name : '')
  return h('details', { className: 'bt-extra-tool', 'data-failed': tool.ok === false ? '' : undefined, onToggle: event => {
    if (event.currentTarget === event.target) setOpen(event.currentTarget.open)
  } }, h('summary', { title: `${tool.name} · ${text(status(tool))}` },
    h('span', { className: 'bt-extra-tool-chevron', 'aria-hidden': true }, '›'), text(CATEGORIES[view.kind]),
    description ? h('span', null, '· ', h('span', { className: 'bt-extra-tool-target' }, description)) : null,
    tool.ok === false ? h('span', { className: 'bt-extra-tool-state' }, text('Failed')) : null),
  open ? available ? h('div', { className: 'bt-extra-tool-body' },
    h(ToolField, { reader: args, field: 'arguments', command: view.command, compact: view.kind === 'read' }),
    h(ToolField, { reader: output, field: 'output' }))
    : h('p', { className: 'bt-extra-tool-limit', role: pending ? 'status' : undefined }, text(pending ? 'Loading…' : native
      ? 'This tool call is not uniquely identified in the loaded history.'
      : 'This server provides names and states only. Parameters and output require the extra module.')) : null)
}

function useNativeSummaries(tools, enabled, fullMessages, onDenied) {
  const key = JSON.stringify([fullMessages, tools.map(tool => [tool.sessionId, tool.callId, tool.turn, tool.ok, tool.resultSeq, tool.stage, tool.anchorSeq])])
  const [state, setState] = useState({ key: '', items: [], error: null, loading: false })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled || tools.length === 0) return undefined
    const controller = new AbortController()
    const load = async () => {
      const items = []; const sessionId = tools[0].sessionId
      const finished = tools.every(tool => Number.isSafeInteger(tool.resultSeq))
      let beforeSeq = finished ? Math.max(...tools.map(tool => tool.resultSeq)) + 1 : undefined
      for (let page = 0; page < 8; page += 1) {
        const value = await readTool('extra-tool-list', { sessionId, fullMessages, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, controller.signal)
        if (controller.signal.aborted) return
        if (!Array.isArray(value?.items) || value.items.length > 200 || value.items.some(item => !item || item.sessionId !== sessionId
          || item.callSeq !== null && (!Number.isSafeInteger(item.callSeq) || item.callSeq < 0)
          || item.callId !== null && typeof item.callId !== 'string' || typeof item.name !== 'string'
          || item.turn !== undefined && !Number.isInteger(item.turn)
          || item.filePath !== undefined && (typeof item.filePath !== 'string' || item.filePath.length > 1024)
          || item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 320)
          || item.label != null && typeof item.label !== 'string')) throw invalidDetail()
        items.push(...value.items)
        const cursor = value.cursor?.beforeSeq
        if (value.cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1 || beforeSeq !== undefined && cursor >= beforeSeq)) throw invalidDetail()
        // 扫完目标轮次再匹配，避免同编号的下一次调用冒充旧调用。
        const firstTurn = Math.min(...tools.map(tool => tool.turn).filter(Number.isInteger))
        if (value.cursor === null || value.items.some(item => Number.isInteger(item.turn) && item.turn < firstTurn)) break
        beforeSeq = cursor
      }
      if (!controller.signal.aborted) setState({ key, items, error: null, loading: false })
    }
    setState({ key, items: [], error: null, loading: true })
    void load().catch(error => {
      if (controller.signal.aborted) return
      setState({ key, items: [], error: error.message, loading: false })
      if (DENIALS.has(error.code)) onDenied(error.message)
    })
    return () => controller.abort()
  }, [key, enabled, attempt])
  return { items: enabled && state.key === key ? state.items : [], error: state.key === key ? state.error : null,
    loading: enabled && (state.key !== key || state.loading), retry: () => setAttempt(value => value + 1) }
}

export function ToolSteps({ entry, fullMessages = false, workDir, native = false }) {
  const [open, setOpen] = useState(false)
  const [denied, setDenied] = useState(null)
  const tools = uniqueTools(Array.isArray(entry.tools) ? entry.tools : [], entry.sessionId)
  const summaries = useNativeSummaries(tools, native && open && !denied, fullMessages, setDenied)
  if (tools.length === 0) return null
  return h('details', { className: 'bt-extra-tools', onToggle: event => {
    if (event.currentTarget !== event.target) return
    setOpen(event.currentTarget.open)
    if (!event.currentTarget.open) setDenied(null)
  } }, h('style', null, CSS), h('summary', null, text('Used {count} tools', { count: tools.length })),
  open ? denied ? h('p', { role: 'alert' }, denied) : h('div', { className: 'bt-extra-tool-list' },
    summaries.error ? h('p', { role: 'alert' }, summaries.error, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: summaries.retry }, text('Retry'))) : null,
    tools.map((tool, index) => {
      const matches = summaries.items.filter(item => item.sessionId === tool.sessionId && item.callId === tool.callId && item.turn === tool.turn && item.name === tool.name
        && (!Number.isFinite(tool.anchorSeq) || item.callSeq >= tool.anchorSeq) && (!Number.isSafeInteger(tool.resultSeq) || item.callSeq < tool.resultSeq))
      const metadata = matches.length === 1 ? matches[0] : null
      const current = metadata ? { ...tool, ...metadata, ok: tool.ok ?? metadata.ok } : tool
      return h(ToolCall, { key: JSON.stringify([toolIdentity(tool, index), fullMessages]), tool: current, fullMessages, workDir, native, pending: summaries.loading, onDenied: setDenied })
    })) : null)
}

export function NativeTools({ calls, sessionId, turn, workDir }) {
  const tools = calls.filter(call => !['ask_user', 'request_secret', 'group_relay'].includes(call.name ?? call.toolName)).map(call => ({
    name: call.name ?? call.toolName ?? 'tool', callId: call.callId, sessionId, turn: call.turn ?? turn, instance: call.instance, anchorSeq: call.anchorSeq,
    resultSeq: call.kind === 'tool-result' && Number.isSafeInteger(call.seq) ? call.seq : undefined, stage: call.phase ?? call.kind,
    ok: call.kind === 'tool-result' && typeof call.isError === 'boolean' ? !call.isError : undefined,
  }))
  return h(ToolSteps, { entry: { tools, sessionId, turn }, native: true, workDir })
}

export function MessageNote({ item }) {
  const internal = item.kind === 'internal'
  return h('details', { className: 'bt-extra-note', 'data-error': internal ? undefined : '' }, h('style', null, CSS),
    h('summary', null, `${text(internal ? 'Internal collaboration' : 'Model status')} · ${item.name ?? item.title ?? ''}`),
    h('pre', null, item.text ?? ''), item.detail ? h('pre', null, item.detail) : null)
}
