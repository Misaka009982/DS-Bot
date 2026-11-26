import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { language, t } from '../i18n.js'
import { extraText } from '../../shared/extras/copy.js'
import { PHONE_NAME_LIMIT, cleanPhoneServerName } from '../../shared/extras/phone-name.js'

const text = key => extraText(key, language())

export function PhoneServerName({ phone, actions, run, Row, disabled = false }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(phone.serverName ?? '')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  if (typeof phone.serverName !== 'string' || typeof actions.phoneSet !== 'function') return null
  const blocked = disabled || busy
  const edit = () => {
    if (blocked) return
    setDraft(phone.serverName)
    setEditing(open => !open)
  }
  const save = () => {
    if (blocked || pending.current || draft.trim() === phone.serverName) return
    const entered = draft
    pending.current = true
    setBusy(true)
    void run(Promise.resolve().then(() => {
      if (!mounted.current) return undefined
      return actions.phoneSet({ serverName: cleanPhoneServerName(entered) })
    }).catch(error => {
      throw Object.assign(new Error(text(error?.message ?? String(error))), { code: error?.code })
    })).then(ok => { if (ok && mounted.current) setEditing(false) })
      .finally(() => { pending.current = false; if (mounted.current) setBusy(false) })
  }
  return h(Fragment, null,
    h(Row, { label: text('Server name'), hint: text('The name shown after scanning a phone QR code. Leave blank to use the computer name.') },
      h('span', { className: 'bt-set-hint', style: { overflowWrap: 'anywhere' } }, phone.serverName || text('Computer name')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: blocked, onClick: edit }, t(editing ? 'Cancel' : 'Edit'))),
    editing ? h('div', { className: 'bt-set-row bt-phone-server' },
      h('input', { className: 'bt-input', value: draft, maxLength: PHONE_NAME_LIMIT, disabled: blocked, autoComplete: 'off', spellCheck: false,
        placeholder: text('Computer name'), 'aria-label': text('Server name'), onChange: event => setDraft(event.target.value),
        onKeyDown: event => {
          if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter') { event.preventDefault(); save() }
          if (event.key === 'Escape' && !blocked) { event.stopPropagation(); edit() }
        } }),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: blocked || draft.trim() === phone.serverName, onClick: save }, t('Save'))) : null,
    editing ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, text('The computer and pairing identity stay the same. Saved phone names update after scanning again.'))) : null)
}
