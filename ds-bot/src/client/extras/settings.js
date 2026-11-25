import { createElement as h, useState } from 'react'
import { language } from '../i18n.js'
import { extraText } from '../../shared/extras/copy.js'

const text = (key, params) => extraText(key, language(), params)

export function BotExtras({ bot, roster, actions, run, Card, Row, Switch }) {
  const [busy, setBusy] = useState(false)
  if (roster.extras?.schema !== 1) return null
  const save = patch => {
    if (busy) return
    setBusy(true)
    void run(actions.extraSetBot(bot.id, patch)).finally(() => setBusy(false))
  }
  const mode = bot.extras?.messageMode ?? 'inherit'
  const archive = bot.extras?.autoArchive ?? mode === 'queue'
  return h(Card, { title: text('Extra settings') },
    h(Row, { label: text('Message delivery'), hint: text('Applies to new messages. Steer is read at the next safe model/tool boundary; no ↑ click is needed.'), stack: true },
      h('select', { className: 'bt-input', value: mode, disabled: busy, 'aria-label': text('Message delivery'), onChange: event => save({ messageMode: event.target.value }) },
        [['inherit', 'Follow basic settings'], ['queue', 'Queue — wait for the turn'], ['steer', 'Steer — join the current turn']].map(([id, label]) => h('option', { key: id, value: id }, text(label))))),
    h(Row, { label: text('Archive inactive sessions'), hint: text('Only ended background sessions and earlier parts inactive for over 24 hours. Keeps history; skips queues, approvals and running work.') },
      h(Switch, { label: text('Archive inactive sessions'), on: archive, disabled: busy, onChange: autoArchive => save({ autoArchive }) })))
}

export function RemoteAuthorization({ roster, actions, run, Row, Switch }) {
  const [busy, setBusy] = useState(false)
  if (roster.extras?.schema !== 1) return null
  return h(Row, { label: text('Allow remote permission changes'), hint: text('Computer authorization only. The phone also needs its safety switch and a device unlock. Browser devices remain blocked.') },
    h(Switch, { label: text('Allow remote permission changes'), on: roster.extras.remotePermissions === true, disabled: busy,
      onChange: remotePermissions => { if (busy) return; setBusy(true); void run(actions.extraPhoneSet({ remotePermissions })).finally(() => setBusy(false)) } }))
}

export function DeviceMessages({ entry, actions, run, Switch }) {
  const [busy, setBusy] = useState(false)
  return h('div', { className: 'bt-set-row', style: { gap: 12 } },
    h('div', { className: 'bt-set-copy' }, h('span', null, text('Allow full messages')), h('span', { className: 'bt-set-hint' }, text('Includes internal Bot collaboration and redacted model failures. Does not allow more remote actions.'))),
    h(Switch, { label: `${entry.name || entry.kind} · ${text('Allow full messages')}`, on: entry.fullMessages === true, disabled: busy,
      onChange: fullMessages => { if (busy) return; setBusy(true); void run(actions.extraPhoneSet({ deviceId: entry.id, pairedAt: entry.pairedAt, fullMessages })).finally(() => setBusy(false)) } }))
}
