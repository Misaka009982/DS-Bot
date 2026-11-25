import { useEffect, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { useTeam } from '../team/context.tsx'
import { getLang } from '../ui/i18n.ts'
import { radius, type as typeScale, useTheme } from '../ui/tokens.ts'
import { extraText } from '../../../ds-bot/src/shared/extras/copy.js'
import { Item, keysOf, type ChatItem } from '../screens/chat/items.tsx'
import type { Bot, BotTask, Room } from '../connection.ts'
import type { TodoItem } from './types.ts'

const text = (key: string) => extraText(key, getLang())
const STATUS_LABELS: Record<string, string> = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed', canceled: 'Canceled' }
const status = (value: string) => STATUS_LABELS[value] ?? value
interface TaskPage { sessionId?: string; items: ChatItem[]; cursor?: unknown }

function TaskHistory({ botId, task, close }: { botId: string; task: BotTask; close: () => void }) {
  const { p } = useTheme()
  const { call, onFeed, computer, team } = useTeam()
  const [page, setPage] = useState<TaskPage | null>(null)
  const [older, setOlder] = useState<ChatItem[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [todos, setTodos] = useState<TodoItem[] | null>(null)
  const generation = useRef(0)
  const inflight = useRef(false)
  const scope = `${computer?.hostKey}:${team?.extras?.fullMessages === true}:${botId}:${task.id}`
  const load = async (more = false) => {
    if (inflight.current) return
    const gen = generation.current
    inflight.current = true; setBusy(true); setError('')
    try {
      const next = await call('extra-task-read', { botId, taskId: task.id, fullMessages: team?.extras?.fullMessages === true, steps: true, ...(more ? { cursor: page?.cursor } : {}) }) as TaskPage
      if (generation.current !== gen) return
      if (more) { setOlder(prev => [...next.items, ...prev]); setPage(prev => prev ? { ...prev, cursor: next.cursor } : next) }
      else setPage(prev => ({ ...next, cursor: older.length > 0 ? prev?.cursor : next.cursor }))
    } catch (failure) { if (generation.current === gen) setError((failure as Error).message) }
    finally { if (generation.current === gen) { inflight.current = false; setBusy(false) } }
  }
  const readTodos = async () => {
    const gen = generation.current
    try {
      const result = await call('extra-todos', { botId, taskId: task.id, fullMessages: team?.extras?.fullMessages === true }) as { items: TodoItem[] }
      if (generation.current === gen) setTodos(result.items)
    } catch (failure) { if (generation.current === gen) setError((failure as Error).message) }
  }
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    generation.current += 1
    inflight.current = false
    setPage(null); setOlder([]); setOpen({}); setTodos(null)
    void loadRef.current()
    return () => { generation.current += 1 }
  }, [scope])
  useEffect(() => onFeed?.((event, data) => { if (event === 'extra-update' && data?.botId === botId) void loadRef.current() }), [onFeed, botId])
  const items = [...older, ...(page?.items ?? [])]
  const keys = keysOf(items)
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <View style={{ flex: 1, backgroundColor: p.main, paddingTop: 24 }}>
      <View style={{ padding: 16, flexDirection: 'row', gap: 12 }}>
        <Text style={[typeScale.settingsRow, { flex: 1, color: p.ink }]}>{task.title}</Text>
        <Pressable accessibilityRole="button" onPress={close}><Text style={{ color: p.accent }}>{text('Close')}</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void load() }} style={{ padding: 10 }}><Text style={{ color: p.accent }}>{text('Refresh')}</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => { void readTodos() }} style={{ padding: 10 }}><Text style={{ color: p.accent }}>{text('To-do')}</Text></Pressable>
        {todos?.map((item, i) => <Text key={item.id ?? i} style={{ color: p.ink }}>{text(status(item.status))} · {item.text}</Text>)}
        {todos?.length === 0 ? <Text style={{ color: p.ink3 }}>{text('No to-dos in the recent history')}</Text> : null}
        {page?.cursor != null ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void load(true) }} style={{ padding: 10 }}><Text style={{ color: p.accent }}>{text('Load more')}</Text></Pressable> : null}
        {error ? <Text accessibilityRole="alert" style={{ color: p.danger }}>{error}</Text> : null}
        {busy ? <Text style={{ color: p.ink3 }}>{text('Loading…')}</Text> : null}
        {items.map((item, i) => <Item key={keys[i]} item={item} sessionId={item.sessionId ?? page?.sessionId} p={p} flat maxWidth="100%" inRoom={false} open={open[keys[i]]} onToggle={() => setOpen(prev => ({ ...prev, [keys[i]]: !prev[keys[i]] }))} />)}
      </ScrollView>
    </View>
  </Modal>
}

export function ChatTasks({ bot, room }: { bot?: Bot; room?: Room }) {
  const { p } = useTheme()
  const { call, team, onFeed, computer } = useTeam()
  const [open, setOpen] = useState(false)
  const [todos, setTodos] = useState<TodoItem[] | null>(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [shown, setShown] = useState<{ botId: string; task: BotTask } | null>(null)
  const gen = useRef(0)
  const scope = `${computer?.hostKey}:${team?.extras?.fullMessages === true}:${bot?.id ?? room?.id}`
  const tasks: { botId: string; task: BotTask }[] = bot !== undefined
    ? (bot.tasks ?? []).filter(task => task.roomId === undefined).map(task => ({ botId: bot.id, task }))
    : (team?.bots ?? []).flatMap(member => (member.tasks ?? []).filter(task => task.roomId === room?.id).map(task => ({ botId: member.id, task })))
  const read = async () => {
    if (!bot || reading) return
    const current = gen.current
    setReading(true); setError('')
    try {
      const value = await call('extra-todos', { botId: bot.id, fullMessages: team?.extras?.fullMessages === true }) as { items: TodoItem[]; partial?: boolean }
      if (current === gen.current) { setTodos(value.items); if (value.partial) setError('扫描达到上限，可在电脑查看更早清单') }
    } catch (failure) { if (current === gen.current) setError((failure as Error).message) }
    finally { if (current === gen.current) setReading(false) }
  }
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => { gen.current += 1; setOpen(false); setTodos(null); setError(''); setReading(false); setShown(null) }, [scope])
  useEffect(() => {
    if (!open) return
    void readRef.current()
    return onFeed?.((event, data) => { if (event === 'extra-update' && data?.botId === bot?.id) void readRef.current() })
  }, [open, onFeed, bot?.id])
  if (team?.extras?.schema !== 1 || !bot && !room) return null
  const shared = room?.todos ?? []
  return <View style={{ marginHorizontal: 12, marginBottom: 6, borderRadius: radius.card, borderWidth: 1, borderColor: p.line, backgroundColor: p.card, padding: 10 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={{ padding: 4 }}>
      <Text style={[typeScale.small, { color: p.ink2 }]}>{text('To-do')} · {text('Background tasks')} ({tasks.length})</Text>
    </Pressable>
    {open ? <ScrollView style={{ maxHeight: 260 }} nestedScrollEnabled contentContainerStyle={{ gap: 8, paddingTop: 8 }}>
      {reading ? <Text style={{ color: p.ink3 }}>{text('Loading…')}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={{ color: p.danger }}>{error}</Text> : null}
      {(todos ?? []).map((item, i) => <Text key={item.id ?? i} style={[typeScale.small, { color: p.ink, textDecorationLine: item.status === 'completed' ? 'line-through' : 'none' }]}>{text(status(item.status))} · {item.text}</Text>)}
      {bot && todos?.length === 0 ? <Text style={{ color: p.ink3 }}>{text('No to-dos in the recent history')}</Text> : null}
      {room ? <Text style={{ color: p.ink2 }}>{text('Shared to-do')}</Text> : null}
      {shared.map(item => <Text key={item.id} style={[typeScale.small, { color: p.ink, textDecorationLine: item.done ? 'line-through' : 'none' }]}>{item.done ? '✓' : '○'} {item.text}</Text>)}
      {tasks.map(entry => <Pressable key={`${entry.botId}:${entry.task.id}`} accessibilityRole="button" onPress={() => setShown(entry)} style={{ paddingVertical: 6 }}>
        <Text style={[typeScale.small, { color: p.accent }]}>{entry.task.title} · {entry.task.status}</Text>
        {entry.task.summary ? <Text style={[typeScale.caption, { color: p.ink2 }]}>{entry.task.summary}</Text> : null}
      </Pressable>)}
      {tasks.length === 0 ? <Text style={{ color: p.ink3 }}>{text('No background tasks')}</Text> : null}
    </ScrollView> : null}
    {shown ? <TaskHistory key={scope} botId={shown.botId} task={shown.task} close={() => setShown(null)} /> : null}
  </View>
}
