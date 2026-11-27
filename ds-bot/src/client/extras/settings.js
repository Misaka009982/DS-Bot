import { createElement as h, useRef, useState } from 'react'
import { language } from '../i18n.js'
import { extraText } from '../../shared/extras/copy.js'

const text = (key, params) => extraText(key, language(), params)

export function DefaultExtras({ roster, actions, run, Row, Switch }) {
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const defaults = roster.extras?.defaults
  if (defaults?.schema !== 1 || typeof actions.extraSetDefaults !== 'function') return null
  const save = patch => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    void run(Promise.resolve().then(() => actions.extraSetDefaults(patch))).finally(() => { saving.current = false; setBusy(false) })
  }
  const disabled = busy || Boolean(roster.readOnly)
  return [
    h(Row, { key: 'message-default', label: text('Default message delivery'), hint: text('Applies to Bots that follow basic settings. Individual Bot choices take priority.'), stack: true },
      h('select', { className: 'bt-input', value: defaults.messageMode, disabled, 'aria-label': text('Default message delivery'), onChange: event => save({ messageMode: event.target.value }) },
        [['inherit', 'Use DSH default'], ['queue', 'Queue — wait for the turn'], ['steer', 'Steer — join the current turn']].map(([id, label]) => h('option', { key: id, value: id }, text(label))))),
    h(Row, { key: 'archive-default', label: text('Archive inactive sessions by default'), hint: text('Applies to Bots that follow basic settings. Keeps the 24-hour limit and all active-work protections.') },
      h(Switch, { label: text('Archive inactive sessions by default'), on: defaults.autoArchive === true, disabled, onChange: autoArchive => save({ autoArchive }) })),
  ]
}

export function BotExtras({ bot, roster, actions, run, Card, Row, Switch }) {
  const [busy, setBusy] = useState(false)
  if (roster.extras?.schema !== 1) return null
  const save = patch => {
    if (busy) return
    setBusy(true)
    void run(actions.extraSetBot(bot.id, patch)).finally(() => setBusy(false))
  }
  const mode = bot.extras?.messageMode ?? 'inherit'
  const defaults = roster.extras.defaults?.schema === 1 ? roster.extras.defaults : undefined
  const archive = bot.extras?.autoArchive ?? (defaults ? defaults.autoArchive === true : mode === 'queue')
  const archiveMode = typeof bot.extras?.autoArchive === 'boolean' ? bot.extras.autoArchive ? 'on' : 'off' : 'inherit'
  const modeLabel = defaults?.messageMode === 'queue' ? 'Queue — wait for the turn' : defaults?.messageMode === 'steer' ? 'Steer — join the current turn' : 'Use DSH default'
  const followMode = defaults ? text('Follow basic settings ({value})', { value: text(modeLabel) }) : text('Follow basic settings')
  const disabled = busy || Boolean(roster.readOnly)
  return h(Card, { title: text('Extra settings') },
    h(Row, { label: text('Message delivery'), hint: text('Applies to new messages. Steer is read at the next safe model/tool boundary; no ↑ click is needed.'), stack: true },
      h('select', { className: 'bt-input', value: mode, disabled, 'aria-label': text('Message delivery'), onChange: event => save({ messageMode: event.target.value }) },
        h('option', { value: 'inherit' }, followMode),
        [['queue', 'Queue — wait for the turn'], ['steer', 'Steer — join the current turn']].map(([id, label]) => h('option', { key: id, value: id }, text(label))))),
    h(Row, { label: text('Archive inactive sessions'), hint: text('Only ended background sessions and earlier parts inactive for over 24 hours. Keeps history; skips queues, approvals and running work.'), stack: Boolean(defaults) },
      defaults ? h('select', { className: 'bt-input', value: archiveMode, disabled, 'aria-label': text('Archive inactive sessions'),
        onChange: event => save({ autoArchive: event.target.value === 'inherit' ? null : event.target.value === 'on' }) },
      h('option', { value: 'inherit' }, text('Follow basic settings ({value})', { value: text(defaults.autoArchive ? 'On' : 'Off') })),
      h('option', { value: 'on' }, text('On')), h('option', { value: 'off' }, text('Off')))
        : h(Switch, { label: text('Archive inactive sessions'), on: archive, disabled, onChange: autoArchive => save({ autoArchive }) })))
}

export function RemoteAuthorization({ roster, actions, run, Row, Switch }) {
  const [busy, setBusy] = useState(false)
  if (roster.extras?.schema !== 1) return null
  return h(Row, { label: text('Allow remote permission changes'), hint: text('Computer authorization only. The phone also needs its safety switch and a device unlock. Browser devices remain blocked.') },
    h(Switch, { label: text('Allow remote permission changes'), on: roster.extras.remotePermissions === true, disabled: busy,
      onChange: remotePermissions => { if (busy) return; setBusy(true); void run(actions.extraPhoneSet({ remotePermissions })).finally(() => setBusy(false)) } }))
}

export function DeviceLearning({ entry, actions, run, Switch, readOnly = false }) {
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const label = text('Allow learning proposal approval')
  return h('div', { className: 'bt-set-row', style: { gap: 12 } },
    h('div', { className: 'bt-set-copy' }, h('span', null, label), h('span', { className: 'bt-set-hint' }, text('Allow this device to approve or decline skill and AGENTS.md proposals. Separate from full-message access.'))),
    h(Switch, { label: `${entry.name || entry.kind} · ${label}`, on: entry.learningApproval === true, disabled: busy || readOnly,
      onChange: learningApproval => {
        if (saving.current || readOnly) return
        saving.current = true; setBusy(true)
        void run(Promise.resolve().then(() => actions.extraPhoneSet({ deviceId: entry.id, pairedAt: entry.pairedAt, learningApproval })))
          .finally(() => { saving.current = false; setBusy(false) })
      } }))
}

export function DeviceMessages({ entry, actions, run, Switch }) {
  const [busy, setBusy] = useState(false)
  return h('div', { className: 'bt-set-row', style: { gap: 12 } },
    h('div', { className: 'bt-set-copy' }, h('span', null, text('Allow full messages')), h('span', { className: 'bt-set-hint' }, text('Includes internal Bot collaboration and redacted model failures. Does not allow more remote actions.'))),
    h(Switch, { label: `${entry.name || entry.kind} · ${text('Allow full messages')}`, on: entry.fullMessages === true, disabled: busy,
      onChange: fullMessages => { if (busy) return; setBusy(true); void run(actions.extraPhoneSet({ deviceId: entry.id, pairedAt: entry.pairedAt, fullMessages })).finally(() => setBusy(false)) } }))
}
