import { useEffect, useRef, useState } from 'react'
import { Platform, Switch, Text, View, Pressable } from 'react-native'
import { useTeam } from '../team/context.tsx'
import { getLang } from '../ui/i18n.ts'
import { radius, type as typeScale, useTheme } from '../ui/tokens.ts'
import { extraText } from '../../../ds-bot/src/shared/extras/copy.js'
import { onPrefsChange, permissionSwitch, setPermissionSwitch } from './permission.ts'
import type { Bot, Room } from '../connection.ts'

const text = (key: string) => extraText(key, getLang())
const PERMISSION_LABELS: Record<string, string> = { 'read-only': 'Read only', 'workspace-write': 'Workspace', 'danger-full-access': 'Full access' }

export function PermissionChoices({ bot, room }: { bot?: Bot; room?: Room }) {
  const { p } = useTheme()
  const { team, call, online, computer } = useTeam()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const scope = `${computer?.hostKey}:${bot?.id ?? room?.id}`
  useEffect(() => { generation.current += 1; setBusy(false); setError(''); return () => { generation.current += 1 } }, [scope])
  const catalog = team?.permissions
  if (team?.extras?.schema !== 1 || !catalog?.options?.length || !bot && !room) return null
  const saved = room ? room.permission ?? 'inherit' : bot?.permission ?? catalog.defaultPreset
  const options = room ? [{ value: 'inherit', name: text("Each Bot's own permission") }, ...catalog.options] : catalog.options
  const change = async (value: string) => {
    if (busy) return
    const gen = generation.current
    setBusy(true); setError('')
    try {
      await call(room ? 'update-room' : 'update-bot', { id: room?.id ?? bot?.id, permission: value === 'inherit' ? null : value })
    } catch (failure) { if (generation.current === gen) setError((failure as Error).message) }
    finally { if (generation.current === gen) setBusy(false) }
  }
  const disabled = busy || !online || team.extras.remotePermissions !== true || Platform.OS === 'web'
  return <View style={{ padding: 12, gap: 8 }}>
    <Text style={[typeScale.small, { color: p.ink2 }]}>{text(Platform.OS === 'web' ? 'Permission changes need the phone app.' : 'Off by default for each paired computer. Every permission change still asks for a device unlock.')}</Text>
    {options.map(option => <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ checked: option.value === saved, disabled }} disabled={disabled}
      onPress={() => { if (option.value !== saved) void change(option.value) }} style={{ padding: 10, borderRadius: 8, backgroundColor: option.value === saved ? p.hover : 'transparent', opacity: disabled ? 0.55 : 1 }}>
      <Text style={[typeScale.small, { color: option.value === 'danger-full-access' ? p.danger : option.value === saved ? p.accent : p.ink }]}>{PERMISSION_LABELS[option.value] ? text(PERMISSION_LABELS[option.value]) : option.name}</Text>
    </Pressable>)}
    {team.extras.remotePermissions !== true ? <Text style={[typeScale.small, { color: p.ink3 }]}>{text('Computer authorization required')}</Text> : null}
    {busy ? <Text style={{ color: p.ink3 }}>{text('Loading…')}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={[typeScale.small, { color: p.danger }]}>{error}</Text> : null}
  </View>
}

export function PermissionSafetySwitch() {
  const { p } = useTheme()
  const { team, computer, online } = useTeam()
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const key = computer?.hostKey ?? ''
  useEffect(() => {
    let live = true
    setOn(false)
    const sync = () => { void permissionSwitch(key).then(next => { if (live) setOn(next) }, () => {}) }
    sync()
    const off = onPrefsChange(sync)
    return () => { live = false; off() }
  }, [key])
  if (Platform.OS === 'web') return null
  const authorized = team?.extras?.remotePermissions === true
  return <View style={{ padding: 16, gap: 8, borderTopWidth: 1, borderTopColor: p.line }}>
    <Text style={[typeScale.settingsRow, { color: p.ink }]}>{text('Permission safety switch')}</Text>
    <Text style={[typeScale.small, { color: p.ink2 }]}>{text(authorized ? 'Off by default for each paired computer. Every permission change still asks for a device unlock.' : 'Computer authorization required')}</Text>
    <Switch accessibilityLabel={text('This phone may change permissions')} value={on && authorized} disabled={busy || !authorized || !online || key === ''}
      onValueChange={next => { if (busy) return; setBusy(true); setError(''); void setPermissionSwitch(key, next).catch(failure => setError(failure.message)).finally(() => setBusy(false)) }}
      trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />
    {error ? <Text accessibilityRole="alert" style={[typeScale.small, { color: p.danger }]}>{error}</Text> : null}
  </View>
}

export function BotExtras({ bot }: { bot: Bot }) {
  const { p } = useTheme()
  const { team, call, online } = useTeam()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (team?.extras?.schema !== 1) return null
  const mode = bot.extras?.messageMode ?? 'inherit'
  const defaults = team.extras.defaults?.schema === 1 ? team.extras.defaults : undefined
  const archiveMode = typeof bot.extras?.autoArchive === 'boolean' ? bot.extras.autoArchive ? 'on' : 'off' : 'inherit'
  const save = (patch: Record<string, unknown>) => {
    if (busy) return
    setBusy(true); setError('')
    void call('extra-bot-set', { id: bot.id, ...patch }).catch(failure => setError(failure.message)).finally(() => setBusy(false))
  }
  return <View style={{ margin: 14, padding: 16, borderWidth: 1, borderColor: p.line, borderRadius: radius.card, gap: 10, backgroundColor: p.card }}>
    <Text style={[typeScale.settingsRow, { color: p.ink }]}>{text('Extra settings')}</Text>
    <Text style={[typeScale.small, { color: p.ink2 }]}>{text('Message delivery')}</Text>
    {(['inherit', 'queue', 'steer'] as const).map(id => <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: mode === id }} disabled={busy || !online}
      onPress={() => save({ messageMode: id })} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, backgroundColor: mode === id ? p.hover : 'transparent' }}>
      <Text style={[typeScale.small, { color: mode === id ? p.accent : p.ink }]}>{text(id === 'inherit' ? 'Follow basic settings' : id === 'queue' ? 'Queue — wait for the turn' : 'Steer — join the current turn')}</Text>
    </Pressable>)}
    <Text style={[typeScale.small, { color: p.ink2 }]}>{text('Applies to new messages. Steer is read at the next safe model/tool boundary; no ↑ click is needed.')}</Text>
    <Text style={[typeScale.settingsRow, { color: p.ink }]}>{text('Archive inactive sessions')}</Text>
    {defaults ? <View style={{ gap: 4 }}>
      {(['inherit', 'on', 'off'] as const).map(id => <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: archiveMode === id, disabled: busy || !online }} disabled={busy || !online}
        onPress={() => save({ autoArchive: id === 'inherit' ? null : id === 'on' })} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, backgroundColor: archiveMode === id ? p.hover : 'transparent' }}>
        <Text style={[typeScale.small, { color: archiveMode === id ? p.accent : p.ink }]}>{id === 'inherit' ? extraText('Follow basic settings ({value})', getLang(), { value: text(defaults.autoArchive ? 'On' : 'Off') }) : text(id === 'on' ? 'On' : 'Off')}</Text>
      </Pressable>)}
    </View> : <Switch value={bot.extras?.autoArchive ?? mode === 'queue'} disabled={busy || !online} onValueChange={autoArchive => save({ autoArchive })}
      trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />}
    <Text style={[typeScale.small, { color: p.ink2 }]}>{text('Only ended background sessions and earlier parts inactive for over 24 hours. Keeps history; skips queues, approvals and running work.')}</Text>
    {error ? <Text accessibilityRole="alert" style={[typeScale.small, { color: p.danger }]}>{error}</Text> : null}
  </View>
}
