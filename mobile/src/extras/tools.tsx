import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useTeam } from '../team/context.tsx'
import { getLang } from '../ui/i18n.ts'
import { type as typeScale, useTheme } from '../ui/tokens.ts'
import { extraText } from '../../../ds-bot/src/shared/extras/copy.js'
import type { ChatItem } from '../screens/chat/items.tsx'
import type { DetailPage, ToolSummary } from './types.ts'

const text = (key: string, params: Record<string, unknown> = {}) => extraText(key, getLang(), params)

function ToolDetail({ tool, fullMessages }: { tool: ToolSummary; fullMessages: boolean }) {
  const { p } = useTheme()
  const { call } = useTeam()
  const [field, setField] = useState<'arguments' | 'output' | null>(null)
  const [page, setPage] = useState<DetailPage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => () => { generation.current += 1 }, [])
  const load = async (next: 'arguments' | 'output', more = false) => {
    const gen = ++generation.current
    setField(next); setBusy(true); setError('')
    if (!more) setPage(null)
    try {
      const value = await call('extra-tool-detail', { sessionId: tool.sessionId, callId: tool.callId, callSeq: tool.callSeq, field: next, fullMessages,
        ...(more ? { offset: page?.nextOffset, digest: page?.digest } : {}) }) as DetailPage
      if (generation.current !== gen) return
      setPage(prev => more && value.available && prev?.available ? { ...value, text: `${prev.text ?? ''}\n${value.text ?? ''}`.slice(-131072) } : value)
    } catch (failure) { if (generation.current === gen) setError((failure as Error).message) }
    finally { if (generation.current === gen) setBusy(false) }
  }
  return <View style={{ gap: 6, paddingTop: 4 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {(['arguments', 'output'] as const).map(value => <Pressable key={value} accessibilityRole="button" disabled={busy} onPress={() => { void load(value) }} style={{ paddingVertical: 8, paddingHorizontal: 6 }}>
        <Text style={[typeScale.small, { color: field === value ? p.accent : p.ink2 }]}>{text(value === 'arguments' ? 'Arguments' : 'Output')}</Text>
      </Pressable>)}
    </View>
    {busy ? <Text style={[typeScale.small, { color: p.ink3 }]}>{text('Loading…')}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={[typeScale.small, { color: p.danger }]}>{error}</Text> : null}
    {page ? <ScrollView style={{ maxHeight: 320, padding: 8, backgroundColor: p.hover }} nestedScrollEnabled><Text selectable style={[typeScale.small, { color: p.ink, fontFamily: 'monospace' }]}>{page.available ? page.text : page.reason}</Text></ScrollView> : null}
    {field && page?.nextOffset != null ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void load(field, true) }} style={{ padding: 8 }}><Text style={{ color: p.accent }}>{text('Load more')}</Text></Pressable> : null}
  </View>
}

export function ToolSteps({ item, sessionId, open, onToggle }: { item: ChatItem; sessionId?: string; open: boolean; onToggle: () => void }) {
  const { p } = useTheme()
  const { team, computer } = useTeam()
  const tools = item.tools ?? []
  const full = team?.extras?.fullMessages === true
  if (tools.length === 0) return null
  return <View style={{ alignSelf: 'stretch', marginVertical: 4, paddingHorizontal: 12 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onToggle} style={{ padding: 8 }}>
      <Text style={[typeScale.caption, { color: p.ink3, textAlign: 'center' }]}>{text('Used {count} tools', { count: tools.length })}{typeof item.ms === 'number' && item.ms > 0 ? ` · ${Math.round(item.ms / 1000)} s` : ''}</Text>
    </Pressable>
    {open ? <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: 10, padding: 10, gap: 10 }}>
      <Text style={[typeScale.caption, { color: p.ink3 }]}>{text('Secret protection is on; details load only when opened.')}</Text>
      {tools.map((entry, i) => {
        const tool = { ...entry, sessionId: entry.sessionId ?? item.sessionId ?? sessionId }
        return <View key={`${computer?.hostKey}:${full}:${tool.callId ?? tool.name}:${i}`} style={{ gap: 4 }}>
          <Text selectable style={[typeScale.small, { color: p.ink, fontFamily: 'monospace' }]}>{tool.name}</Text>
          <Text style={[typeScale.caption, { color: tool.ok === false ? p.danger : p.ink2 }]}>{text(tool.ok === true ? 'Success' : tool.ok === false ? 'Failed' : 'Unconfirmed')}{tool.label ? ` · ${tool.label}` : ''}</Text>
          {tool.callId && tool.sessionId ? <ToolDetail tool={tool} fullMessages={full} /> : <Text style={[typeScale.caption, { color: p.ink3 }]}>{text('This server provides names and states only. Parameters and output require the extra module.')}</Text>}
        </View>
      })}
    </View> : null}
  </View>
}

export function MessageNote({ item }: { item: ChatItem }) {
  const { p } = useTheme()
  const [open, setOpen] = useState(false)
  return <View style={{ alignSelf: 'stretch', borderWidth: 1, borderColor: item.kind === 'diagnostic' ? p.danger : p.line, borderRadius: 10, padding: 10, marginVertical: 4 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={{ paddingVertical: 6 }}>
      <Text style={[typeScale.small, { color: p.ink2 }]}>{text(item.kind === 'internal' ? 'Internal collaboration' : 'Model status')} · {item.name ?? item.title ?? ''}</Text>
    </Pressable>
    {open ? <Text selectable style={[typeScale.small, { color: p.ink }]}>{item.text}{item.detail ? `\n${item.detail}` : ''}</Text> : null}
  </View>
}
