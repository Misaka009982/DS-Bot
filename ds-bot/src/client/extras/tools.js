import { createElement as h, useEffect, useRef, useState } from 'react'
import { language } from '../i18n.js'
import { call } from '../api.js'
import { extraText } from '../../shared/extras/copy.js'

const text = (key, params) => extraText(key, language(), params)
const CSS = `.bt-extra-tools{font-size:12px;color:var(--bt-ink-2);margin:6px 0;min-width:0}.bt-extra-tools summary{cursor:pointer;overflow-wrap:anywhere}.bt-extra-tool{padding:6px 0;border-top:1px solid var(--bt-line);overflow-wrap:anywhere}.bt-extra-tool-name{font-family:var(--ds-font-family-code,monospace)}.bt-extra-tool pre,.bt-extra-note pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;font-size:12px;background:var(--bt-hover);padding:10px;border-radius:8px}.bt-extra-note{padding:10px 12px;border:1px solid var(--bt-line);border-radius:10px;margin:6px 0;min-width:0}.bt-extra-note[data-error]{border-color:var(--bt-danger)}.bt-extra-note summary{cursor:pointer}.bt-extra-note p{white-space:pre-wrap;overflow-wrap:anywhere}`
const status = tool => tool.ok === true ? 'Success' : tool.ok === false ? 'Failed' : 'Unconfirmed'
const DETAIL_LIMIT = 131072
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

function Detail({ tool, field, fullMessages }) {
  const [state, setState] = useState({ busy: false, value: null, error: null })
  const request = useRef(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current?.abort(); request.current = null }
  }, [])
  const load = async more => {
    if (!mounted.current || state.busy || request.current !== null) return
    const previous = more ? state.value : null
    if (more && (!previous?.available || previous.nextOffset == null || previous.previewLimited)) return
    const controller = new AbortController()
    request.current = controller
    setState(prev => ({ ...prev, busy: true, error: null }))
    try {
      const response = await call('extra-tool-detail', { sessionId: tool.sessionId, callId: tool.callId, callSeq: tool.callSeq, field,
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
      setState(prev => ({ ...prev, busy: false, error: failure.message,
        value: ['bot/refused', 'bot/detail-invalid', 'HTTP_401', 'HTTP_403'].includes(failure.code) ? null : prev.value }))
    } finally { if (request.current === controller) request.current = null }
  }
  return h('details', { className: 'bt-extra-tool', onToggle: event => {
    if (event.target !== event.currentTarget) return
    if (event.currentTarget.open && state.value === null && !state.busy) void load(false)
    if (!event.currentTarget.open) { request.current?.abort(); request.current = null; setState({ busy: false, value: null, error: null }) }
  } }, h('summary', null, text(field === 'arguments' ? 'Arguments' : 'Output')),
  state.busy ? h('span', { role: 'status' }, text('Loading…')) : null,
  state.error ? h('p', { role: 'alert' }, state.error, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void load(false) }, text('Retry'))) : null,
  state.value ? h('div', null, h('pre', null, state.value.available ? state.value.text : state.value.reason),
    state.value.previewLimited ? h('p', null, text('Tool detail display limit reached. Open the original session to see more.')) : null,
    state.value.nextOffset != null && !state.value.previewLimited ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: state.busy, onClick: () => void load(true) }, text('Load more')) : null) : null)
}

export function ToolSteps({ entry, fullMessages = false }) {
  const [open, setOpen] = useState(false)
  const tools = Array.isArray(entry.tools) ? entry.tools : []
  if (tools.length === 0) return null
  return h('details', { className: 'bt-extra-tools', onToggle: event => { if (event.currentTarget === event.target) setOpen(event.currentTarget.open) } },
    h('style', null, CSS), h('summary', null, text('Used {count} tools', { count: tools.length }),
      typeof entry.ms === 'number' && entry.ms > 0 ? ` · ${Math.round(entry.ms / 1000)} s` : null),
    open ? h('div', null,
      h('p', null, text('Secret protection is on; details load only when opened.')),
      tools.map((tool, index) => h('div', { key: JSON.stringify([tool.sessionId ?? entry.sessionId, tool.callId ?? index, tool.callSeq ?? null, fullMessages]), className: 'bt-extra-tool' },
        h('span', { className: 'bt-extra-tool-name' }, tool.name), ' · ', text(status(tool)),
        tool.label ? h('div', null, tool.label) : null,
        tool.callId && tool.sessionId ? h('div', null, h(Detail, { tool, field: 'arguments', fullMessages }), h(Detail, { tool, field: 'output', fullMessages }))
          : h('div', null, text('This server provides names and states only. Parameters and output require the extra module.'))))) : null)
}

export function NativeTools({ calls, sessionId, turn }) {
  const tools = calls.filter(call => !['ask_user', 'request_secret', 'group_relay'].includes(call.name ?? call.toolName)).map(call => ({
    name: call.name ?? call.toolName ?? 'tool', callId: call.callId, sessionId, turn,
    ok: call.kind === 'tool-result' && typeof call.isError === 'boolean' ? !call.isError : undefined,
  }))
  return h(ToolSteps, { entry: { tools, sessionId, turn } })
}

export function MessageNote({ item }) {
  const internal = item.kind === 'internal'
  return h('details', { className: 'bt-extra-note', 'data-error': internal ? undefined : '' }, h('style', null, CSS),
    h('summary', null, `${text(internal ? 'Internal collaboration' : 'Model status')} · ${item.name ?? item.title ?? ''}`),
    h('pre', null, item.text ?? ''), item.detail ? h('pre', null, item.detail) : null)
}
