import { createElement as h, useEffect, useRef, useState } from 'react'
import { language } from '../i18n.js'
import { ChevronRightIcon } from '../icons.js'
import { extraText } from '../../shared/extras/copy.js'

const text = key => extraText(key, language())

export function NewSessionRow({ bot, roster, actions, run }) {
  const [confirmed, setConfirmed] = useState(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const sessionId = bot.sessionId ?? bot.id
  const confirming = confirmed === sessionId
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirmed(null), 8000)
    return () => clearTimeout(timer)
  }, [confirming, sessionId])
  if (roster.extras?.newSession !== true || typeof actions.extraNewSession !== 'function') return null
  const start = () => {
    if (pending.current) return
    if (!confirming) { setConfirmed(sessionId); return }
    pending.current = true
    setBusy(true)
    setConfirmed(null)
    void run(Promise.resolve().then(() => actions.extraNewSession(bot.id, sessionId)).then(result => {
      if (!mounted.current) return
      actions.closeSettings?.()
      actions.openSession(result.sessionId)
    })).finally(() => { pending.current = false; if (mounted.current) setBusy(false) })
  }
  return h('button', {
    type: 'button', className: 'bt-set-row bt-bs-row', disabled: busy || Boolean(roster.readOnly),
    onClick: start, onBlur: () => setConfirmed(null),
    onKeyDown: event => { if (event.key === 'Escape' && confirming) { event.stopPropagation(); setConfirmed(null) } },
  },
  h('span', { className: 'bt-set-copy' },
    h('span', { className: 'bt-bs-label' }, text(busy ? 'Starting new session…' : confirming ? 'Confirm new session' : 'New session')),
    h('span', { className: 'bt-set-hint' }, text(confirming
      ? 'Click again to start without the previous context. Earlier chats remain readable.'
      : 'Start with a clean context. Keep memory and Bot settings.'))),
  h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))
}
