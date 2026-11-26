import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNativeToolSource, nativeToolGroups } from '../src/client/extras/tool-groups.js'
import { displayToolPath, groupToolRows, toolPresentation, uniqueTools } from '../src/shared/extras/tool-display.js'
import { createSource } from '../src/client/sources.js'

const tool = (seq, name = 'read', turn = 1, callId = `call-${seq}`) => ({ key: `node-${seq}`, kind: 'tool-call', anchorSeq: seq, visibility: 'visible',
  location: { kind: 'step', turn: { turn } }, data: { root: { phase: 'start', name, callId, turn, step: seq, subCalls: [] } } })
const assistant = (seq, value, kind = 'text', turn = 1) => ({ key: `message-${seq}`, kind: 'assistant-step', anchorSeq: seq, visibility: 'visible',
  location: { kind: 'step', turn: { turn } }, data: { turn, step: seq, blocks: [{ kind, text: value }], status: 'settled' } })
const lengths = groups => [...groups.values()].filter(group => group.length).map(group => group.length)

test('原生 18 个连续工具节点仅由一个节点显示总数，所有真实调用按顺序保留', () => {
  const nodes = Array.from({ length: 18 }, (_, index) => tool(index + 1))
  const groups = nativeToolGroups(nodes)
  assert.deepEqual(lengths(groups), [18])
  assert.deepEqual(groups.get('node-1').map(node => node.data.root.callId), nodes.map(node => node.data.root.callId))
  assert.ok(nodes.slice(1).every(node => groups.get(node.key).length === 0))
  assert.equal(nodes.length, 18)
})
test('正文、用户输入、可见协作事件、工具卡片和轮次边界都分开工具段', () => {
  for (const boundary of [assistant(2, '现在检查文档'), { key: 'user', kind: 'steering', anchorSeq: 2, location: { turn: { turn: 1 } } },
    { key: 'note', kind: 'context', anchorSeq: 2, location: { turn: { turn: 1 } }, data: { source: { kind: 'bot', role: 'reply', senderSessionId: 'another' } } }]) {
    assert.deepEqual(lengths(nativeToolGroups([tool(1), boundary, tool(3)])), [1, 1])
  }
  assert.deepEqual(lengths(nativeToolGroups([tool(1), tool(2, 'ask_user'), tool(3)])), [1, 1, 1])
  assert.deepEqual(lengths(nativeToolGroups([tool(1), tool(2, 'read', 2)])), [1, 1])
})
test('隐藏思考不把每次调用重新拆成用了 1 个工具，可见思考只在实际显示处截断', () => {
  const nodes = [tool(1), assistant(2, '第一段思考', 'reasoning'), tool(3), assistant(4, '第二段思考', 'reasoning'), tool(5)]
  assert.deepEqual(lengths(nativeToolGroups(nodes, { thinking: false })), [3])
  assert.deepEqual(lengths(nativeToolGroups(nodes, { thinking: true })), [2, 1])
})
test('原生源跟随逐节点结果变化，新工具只增加现有分组；补历史仍保留原摘要节点', () => {
  const entries = new Map([tool(10), tool(20)].map(node => [node.key, node]))
  const changes = new Map()
  const snapshot = { nodes: { values: () => [...entries.values()], source: key => {
    if (!changes.has(key)) changes.set(key, createSource(entries.get(key)))
    return changes.get(key)
  } } }
  const chat = createSource(snapshot); const roster = createSource({ prefs: {} })
  const source = createNativeToolSource(chat, roster)
  let updates = 0; const off = source.subscribe(() => { updates += 1 })
  assert.equal(source.getSnapshot().get('node-10').length, 2)
  const finished = { ...entries.get('node-20'), data: { root: { ...entries.get('node-20').data.root, kind: 'tool-result', isError: false } } }
  entries.set(finished.key, finished); changes.get(finished.key).set(finished)
  assert.equal(source.getSnapshot().get('node-10')[1].data.root.kind, 'tool-result')
  entries.set('node-30', tool(30)); chat.set({ ...snapshot })
  assert.equal(source.getSnapshot().get('node-10').length, 3)
  entries.set('node-1', tool(1)); chat.set({ ...snapshot })
  assert.equal(source.getSnapshot().get('node-10').length, 4)
  assert.equal(source.getSnapshot().get('node-1').length, 0)
  const before = updates; off(); changes.get('node-20').set(tool(20))
  assert.equal(updates, before)
})
test('历史页只合并连续同会话的工具，不跨正文、事件或会话，也不按工具名称去重', () => {
  const row = (id, sessionId = 'part', callSeq = id) => ({ kind: 'steps', sessionId, tools: [{ name: 'read', sessionId, callId: `c${id}`, callSeq }] })
  const input = [row(1), row(2), { kind: 'bot', text: '汇报' }, row(3), row(4, 'other'), { kind: 'event' }, row(5)]
  const grouped = groupToolRows(input)
  assert.deepEqual(grouped.map(row => row.tools?.length ?? row.kind), [2, 'bot', 1, 1, 'event', 1])
  assert.equal(input[0].tools.length, 1)
  assert.equal(uniqueTools([row(1).tools[0], { ...row(1).tools[0], ok: true }, row(1, 'part', 10).tools[0]]).length, 2)
  assert.equal(uniqueTools([{ name: 'read' }, { name: 'read' }]).length, 2)
})
test('标题只取真实路径和说明，未提供目的时仅显示工具类别，不从命令猜任务', () => {
  assert.equal(toolPresentation('read', '{"file_path":"inkos/runner.ts"}').filePath, 'inkos/runner.ts')
  assert.equal(toolPresentation('bash', '{"command":"git status"}').description, undefined)
  assert.equal(toolPresentation('bash', { command: '  printf ok\n' }).command, '  printf ok\n')
  assert.equal(toolPresentation('bash', '{"justification":"核对修改","command":"git status"}').description, '核对修改')
  assert.equal(toolPresentation('read', '{"file_path":').filePath, undefined)
  assert.equal(displayToolPath('/tmp/project/inkos/docs/plan.md', '/tmp/project/inkos'), 'inkos/docs/plan.md')
  assert.equal(displayToolPath('/other/repo/docs/plan.md', '/tmp/project/inkos'), '/other/repo/docs/plan.md')
  assert.equal(displayToolPath('D:\\Repo\\src\\main.js', 'D:\\Repo'), 'Repo/src/main.js')
})
