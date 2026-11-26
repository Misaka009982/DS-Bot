import { createElement as h, useEffect, useRef, useState } from 'react'
import { language } from '../i18n.js'
import { extraText } from '../../shared/extras/copy.js'

const text = key => extraText(key, language())
const OPTIONS = [
  ['terminalRead', 'Allow terminal output', 'Terminal output can contain commands, file contents and credentials.'],
  ['terminalWrite', 'Allow terminal control', 'Creates and controls user terminals with the server account permissions. Agent sandbox rules do not apply.'],
  ['filesRead', 'Allow workspace reading', 'Read eligible files inside the current session workspace.'],
  ['filesWrite', 'Allow workspace editing', 'Save complete eligible text files with a version check. External writers and link replacement need server-side isolation.'],
]

export function DeviceResources({ entry, extras, actions, run, Switch }) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const saving = useRef(false)
  useEffect(() => { setConfirm(null) }, [entry.id, entry.pairedAt])
  if (!entry.resources) return null
  const available = key => key.startsWith('terminal') ? extras?.terminals?.schema === 1 && (key !== 'terminalWrite' || extras.terminals.write)
    : extras?.workspace?.schema === 1 && (key !== 'filesWrite' || extras.workspace.write)
  const visible = OPTIONS.filter(([key]) => entry.resources[key] === true || available(key))
  if (visible.length === 0) return null
  const save = (key, value) => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setConfirm(null)
    void run(Promise.resolve().then(() => actions.extraPhoneSet({ deviceId: entry.id, pairedAt: entry.pairedAt, resources: { [key]: value } })))
      .finally(() => { saving.current = false; setBusy(false) })
  }
  return h('div', { className: 'bt-extra-resource-authorization' },
    visible.map(([key, label, hint]) => {
      const read = key === 'terminalWrite' ? 'terminalRead' : key === 'filesWrite' ? 'filesRead' : null
      const disabled = busy || entry.resources[key] !== true && (!available(key) || read !== null && entry.resources[read] !== true)
      return h('div', { key, className: 'bt-set-row', style: { gap: 12 } },
        h('div', { className: 'bt-set-copy' }, h('span', null, text(label)), h('span', { className: 'bt-set-hint' }, text(hint)),
          confirm === key ? h('div', { className: 'bt-set-control' },
            h('button', { type: 'button', className: 'bt-soft bt-danger', disabled, onClick: () => save(key, true) }, text('Confirm resource access')),
            h('button', { type: 'button', className: 'bt-soft', onClick: () => setConfirm(null) }, text('Cancel'))) : null),
        h(Switch, { label: `${entry.name || entry.kind} · ${text(label)}`, on: entry.resources[key] === true, disabled,
          onChange: value => { if (disabled) return; if (value) setConfirm(key); else save(key, false) } }))
    }))
}

export function UserTerminals({ extras, actions, Section }) {
  const [items, setItems] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)
  const generation = useRef(0)
  useEffect(() => () => { generation.current += 1 }, [])
  if (extras?.terminals?.schema !== 1 || typeof actions.extraUserTerminals !== 'function') return null
  const refresh = async () => {
    const result = await actions.extraUserTerminals()
    if (result?.schema !== 1 || result.cleanupOnly !== true || !Array.isArray(result.items)) throw new Error('invalid terminal list')
    return result.items
  }
  const request = handleId => {
    if (pending.current) return
    pending.current = true
    const current = generation.current
    setBusy(true)
    setFailed(false)
    setConfirm(null)
    void Promise.resolve().then(async () => {
      if (current !== generation.current) return
      if (handleId !== undefined) await actions.extraCloseTerminal(handleId)
      if (current !== generation.current) return
      const next = await refresh()
      if (current === generation.current) setItems(next)
    }).catch(() => { if (current === generation.current) setFailed(true) }).finally(() => {
      pending.current = false
      if (current === generation.current) setBusy(false)
    })
  }
  return h(Section, { title: text('Server user terminals') },
    h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, text('Lists user terminals created through paired devices. Closing stops their running commands.')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => request() }, text('Refresh'))),
    failed ? h('div', { className: 'bt-set-hint bt-danger', role: 'alert' }, text('Could not confirm the terminal operation. Refresh before trying again.')) : null,
    items?.map(item => h('div', { key: item.terminalId, className: 'bt-set-row' },
      h('span', { className: 'bt-set-copy' }, h('span', null, item.terminalId), h('span', { className: 'bt-set-hint' }, item.sessionId, ' · ', item.status)),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || extras.terminals.write !== true || item.status === 'creating',
        onClick: () => { if (confirm === item.handleId) request(item.handleId); else setConfirm(item.handleId) } }, text(confirm === item.handleId ? 'Confirm close terminal' : 'Close')))))
}
