import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

// 使用真实组件、分层挂载和分页逻辑，仅模拟 React 生命周期与传输边界。
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/extras/tools.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  plugins: [{ name: 'test-tool-call', setup(builder) {
    builder.onResolve({ filter: /^\.\.\/api\.js$/ }, () => ({ path: 'tool-call', namespace: 'test' }))
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const call = (...args) => globalThis.testToolCall(...args)', loader: 'js' }))
  } }],
})
const digest = 'a'.repeat(64)
const page = (body, text, offset = 0, totalChars = text.length, nextOffset = null, hash = digest) => ({
  available: true, sessionId: body.sessionId, callId: body.callId, field: body.field,
  text, offset, totalChars, nextOffset, digest: hash, status: 'success', redacted: true,
})
function component(reply, options = {}) {
  const stores = new Map(); let cells; let slot = 0; let visited
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => { const index = slot++; cells[index] ??= { value: typeof initial === 'function' ? initial() : initial }; const cell = cells[index]; return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }] },
    useRef: current => { const index = slot++; cells[index] ??= { current }; return cells[index] },
    useEffect: (effect, deps) => { const index = slot++; const previous = cells[index]; if (!previous || deps.some((value, index) => value !== previous.deps[index])) { previous?.cleanup?.(); cells[index] = { deps, cleanup: effect() } } },
  }
  const requests = []; const copied = []
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, AbortController,
    require: name => name === 'react' ? react : { writeClipboard: async value => { copied.push(value); return true } },
    testToolCall: (endpoint, body, signal) => {
      requests.push({ endpoint, body: { ...body }, signal })
      return Promise.resolve().then(() => endpoint === 'extra-tool-list' ? options.list(body)
        : body.field === 'arguments' ? page(body, options.arguments ?? '{}') : reply(body))
    },
  })
  const entry = { tools: options.tools ?? [{ name: 'bash', callId: 'call', callSeq: 2, sessionId: 'part', ok: true }] }
  let fullMessages = false
  const unmount = key => { for (const cell of stores.get(key) ?? []) cell?.cleanup?.(); stores.delete(key) }
  const render = (key, fn) => { visited.add(key); cells = stores.get(key) ?? []; stores.set(key, cells); slot = 0; return fn() }
  const expand = (value, key) => {
    if (Array.isArray(value)) return value.map((child, index) => expand(child, `${key}/${child?.props?.key ?? index}`))
    if (!value || typeof value !== 'object') return value
    if (typeof value.type === 'function') return expand(render(`${key}:${value.type.name}`, () => value.type(value.props)), `${key}:body`)
    return { ...value, children: expand(value.children, key) }
  }
  const root = () => {
    visited = new Set()
    const result = expand(render('root', () => module.exports.ToolSteps({ entry, fullMessages, native: options.native, workDir: options.workDir })), 'tree')
    for (const key of [...stores.keys()]) if (!visited.has(key)) unmount(key)
    return result
  }
  const tool = (index = 0) => nodes(root()).filter(node => node.type === 'details' && node.props.className === 'bt-extra-tool')[index]
  const field = name => nodes(root()).find(node => node.props?.['data-field'] === name)
  return { root, tool, field, entry, requests, copied, dispose: () => { for (const key of [...stores.keys()]) unmount(key) },
    setFull: value => { fullMessages = value }, outputRequests: () => requests.filter(request => request.body.field === 'output') }
}
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes)
  return value && typeof value === 'object' ? [value, ...nodes(value.children ?? [])] : []
}
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.children ?? []) : typeof value === 'string' ? value : ''
const toggle = (node, open) => { const target = { open }; node.props.onToggle({ target, currentTarget: target }) }
const settle = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve() }
const more = node => nodes(node).find(node => node.type === 'button' && text(node) === 'Load more')
const pre = node => nodes(node).find(node => node.type === 'pre')
const heading = node => text(node.children.find(child => child?.type === 'summary'))
function openTool(ui) { toggle(ui.root(), true); toggle(ui.tool(), true); ui.root() }

test('18 次调用默认只有一个折叠总数，新增调用只更新计数，不挂载列表或请求正文', () => {
  const tools = Array.from({ length: 18 }, (_, index) => ({ name: 'read', sessionId: 'part', callId: `read-${index}`, callSeq: index, filePath: `inkos/${index}.ts` }))
  const ui = component(body => page(body, 'safe'), { tools })
  assert.equal(heading(ui.root()), 'Used 18 tools')
  assert.equal(ui.tool(), undefined); assert.equal(ui.requests.length, 0)
  ui.entry.tools.push({ name: 'bash', callId: 'next', sessionId: 'part', callSeq: 100 })
  assert.equal(heading(ui.root()), 'Used 19 tools'); assert.equal(ui.tool(), undefined)
  toggle(ui.root(), true)
  assert.equal(nodes(ui.root()).filter(node => node.props?.className === 'bt-extra-tool').length, 19)
  assert.equal(ui.field('output'), undefined); assert.equal(ui.requests.length, 0)
})
test('展开总数只看操作标题，展开单项直接显示命令与输出，不再套参数和输出折叠', async () => {
  const ui = component(body => page(body, '检查通过'), { arguments: '{"command":"git diff --stat","description":"检查文件变化"}' })
  toggle(ui.root(), true); assert.equal(ui.requests.length, 0)
  toggle(ui.tool(), true); ui.root(); await settle()
  assert.equal(ui.requests.length, 2)
  assert.deepEqual(ui.requests.map(request => request.body.field), ['arguments', 'output'])
  assert.match(heading(ui.tool()), /Run command.*检查文件变化/)
  assert.equal(text(pre(ui.field('arguments'))), 'git diff --stat')
  assert.equal(text(pre(ui.field('output'))), '检查通过')
  assert.equal(nodes(ui.tool()).filter(node => node.type === 'details').length, 1)
  const copy = nodes(ui.field('arguments')).find(node => node.type === 'button' && text(node) === 'Copy')
  await copy.props.onClick(); assert.deepEqual(ui.copied, ['git diff --stat'])
})
test('文件行在未展开单项时就能区分真实路径，只按明确工作目录缩短', () => {
  const ui = component(body => page(body, 'file'), { workDir: '/tmp/project/inkos', tools: [
    { name: 'read', sessionId: 'part', callId: 'a', callSeq: 1, filePath: '/tmp/project/inkos/packages/cli/src/core/pipeline/runner.ts' },
    { name: 'read', sessionId: 'part', callId: 'b', callSeq: 2, filePath: '/tmp/project/inkos/docs/incremental-chapter-processing.md' },
  ] })
  toggle(ui.root(), true)
  assert.match(heading(ui.tool(0)), /Read.*inkos\/packages\/cli\/src\/core\/pipeline\/runner.ts/)
  assert.match(heading(ui.tool(1)), /Read.*inkos\/docs\/incremental-chapter-processing.md/)
  assert.equal(ui.requests.length, 0)
})
test('原生总数展开只取已脱敏列表，不为 18 个标题逐个拉取参数或输出', async () => {
  const tools = Array.from({ length: 18 }, (_, index) => ({ name: 'read', callId: `c${index}`, sessionId: 'part', turn: 1, resultSeq: index + 100 }))
  const ui = component(body => page(body, 'file'), { tools, native: true,
    list: () => ({ items: tools.map((tool, index) => ({ ...tool, callSeq: index + 1, filePath: `inkos/${index}.ts` })), cursor: null }) })
  ui.root(); assert.equal(ui.requests.length, 0)
  toggle(ui.root(), true); ui.root(); await settle()
  assert.deepEqual(ui.requests.map(request => request.endpoint), ['extra-tool-list'])
  assert.match(heading(ui.tool(17)), /Read.*inkos\/17.ts/)
  assert.equal(ui.field('arguments'), undefined)
})
test('展开状态保留：新增工具只增加总数和内部行，不重开已有正文或自动展开新调用', async () => {
  const ui = component(body => page(body, '已读正文')); openTool(ui); await settle()
  assert.equal(text(pre(ui.field('output'))), '已读正文')
  const requests = ui.requests.length
  ui.entry.tools.push({ name: 'read', callId: 'next', callSeq: 20, sessionId: 'part', filePath: 'inkos/next.ts' })
  assert.equal(heading(ui.root()), 'Used 2 tools')
  assert.equal(text(pre(ui.field('output'))), '已读正文')
  assert.equal(nodes(ui.tool(1)).some(node => node.props?.['data-field']), false)
  await settle(); assert.equal(ui.requests.length, requests)
})
test('同编号的歧义调用不借用别次参数，已知记录边界可排除旧调用', async () => {
  const options = { native: true, tools: [{ name: 'read', callId: 'c', sessionId: 'part', turn: 1, resultSeq: 40, anchorSeq: 10 }],
    list: () => ({ items: [5, 20].map(seq => ({ name: 'read', callId: 'c', callSeq: seq, sessionId: 'part', turn: 1, filePath: `file-${seq}.ts` })), cursor: null }) }
  const ui = component(body => page(body, 'safe'), options)
  toggle(ui.root(), true); ui.root(); await settle()
  assert.match(heading(ui.tool()), /file-20.ts/); assert.doesNotMatch(heading(ui.tool()), /file-5.ts/)
  const ambiguous = component(body => page(body, 'wrong'), { ...options, tools: [{ ...options.tools[0], anchorSeq: 1 }] })
  toggle(ambiguous.root(), true); ambiguous.root(); await settle()
  assert.doesNotMatch(heading(ambiguous.tool()), /file-/)
  toggle(ambiguous.tool(), true); ambiguous.root(); await settle()
  assert.equal(ambiguous.requests.length, 1); assert.equal(ambiguous.field('output'), undefined)
})
test('同时展开多项最多三个请求进行，收起总数后排队请求不会继续发出', async () => {
  const finish = []
  const ui = component(body => new Promise(resolve => { finish.push(() => resolve(page(body, 'late'))) }), {
    tools: Array.from({ length: 8 }, (_, index) => ({ name: 'bash', callId: `c${index}`, callSeq: index, sessionId: 'part' })),
  })
  toggle(ui.root(), true)
  for (let index = 0; index < 8; index += 1) { toggle(ui.tool(index), true); ui.root() }
  await settle(); assert.equal(ui.outputRequests().length, 3)
  toggle(ui.root(), false); ui.root()
  assert.equal(ui.outputRequests().every(request => request.signal.aborted), true)
  const before = ui.requests.length
  for (const done of finish) done()
  await settle(); assert.equal(ui.requests.length, before)
})

test('分页按 offset 原样拼接，不插入换行或删除已经读取的开头', async () => {
  const ui = component(body => body.offset === undefined ? page(body, 'abc', 0, 6, 3) : page(body, 'def', 3, 6))
  openTool(ui); await settle()
  more(ui.field('output')).props.onClick(); await settle()
  assert.equal(text(pre(ui.field('output'))), 'abcdef')
  assert.equal(ui.outputRequests()[1].body.offset, 3); assert.equal(ui.outputRequests()[1].body.digest, digest)
})
test('重复展开不重复请求；关闭单项、总数或卸载都取消请求并丢弃迟到正文', async () => {
  for (const action of ['tool', 'root', 'dispose']) {
    let done
    const ui = component(body => new Promise(resolve => { done = () => resolve(page(body, 'late-body')) }))
    openTool(ui); toggle(ui.tool(), true); ui.root(); await settle()
    assert.equal(ui.outputRequests().length, 1)
    if (action === 'dispose') ui.dispose()
    else { toggle(action === 'tool' ? ui.tool() : ui.root(), false); ui.root() }
    assert.equal(ui.outputRequests()[0].signal.aborted, true)
    done(); await settle()
    if (action !== 'dispose') assert.equal(ui.field('output'), undefined)
  }
})
test('详情变化不能拼接不同 digest；授权拒绝清空该组参数、输出和标题缓存', async () => {
  let denied = false
  const ui = component(body => body.offset === undefined ? page(body, 'old', 0, 6, 3)
    : denied ? Promise.reject(Object.assign(new Error('access revoked'), { code: 'bot/refused' })) : page(body, 'new', 3, 6, null, 'b'.repeat(64)))
  openTool(ui); await settle()
  more(ui.field('output')).props.onClick(); await settle()
  assert.equal(text(pre(ui.field('output'))), 'old')
  assert.match(text(ui.field('output')), /changed|first page/)
  denied = true; more(ui.field('output')).props.onClick(); await settle()
  assert.equal(pre(ui.root()), undefined); assert.equal(ui.tool(), undefined)
  assert.match(text(ui.root()), /access revoked/)
})
test('HTTP 401 或 403 不继续保留先前读取的工具正文', async () => {
  for (const code of ['HTTP_401', 'HTTP_403']) {
    const ui = component(body => body.offset === undefined ? page(body, 'private-body', 0, 24, 12)
      : Promise.reject(Object.assign(new Error('Authorization unavailable'), { code })))
    openTool(ui); await settle(); assert.equal(text(pre(ui.field('output'))), 'private-body')
    more(ui.field('output')).props.onClick(); await settle()
    assert.equal(pre(ui.root()), undefined); assert.match(text(ui.root()), /Authorization unavailable/)
  }
})
test('保持 128 Ki 展示预算，达到上限提示不完整，并保留输出开头', async () => {
  const ui = component(body => {
    const offset = body.offset ?? 0
    const value = offset === 0 ? 'FIRST'.padEnd(32768, 'x') : 'x'.repeat(32768)
    return page(body, value, offset, 200000, offset + value.length)
  })
  openTool(ui); await settle()
  for (let index = 0; index < 3; index += 1) { more(ui.field('output')).props.onClick(); await settle() }
  const value = text(pre(ui.field('output')))
  assert.equal(value.length, 131072); assert.equal(value.startsWith('FIRST'), true)
  assert.equal(more(ui.field('output')), undefined); assert.match(text(ui.field('output')), /display limit/)
  assert.equal(ui.outputRequests().length, 4)
})
test('会话、调用序号和完整消息模式变化时不能保留之前展开的敏感正文', async () => {
  for (const change of [ui => { ui.entry.tools[0].sessionId = 'other' }, ui => { ui.entry.tools[0].callSeq = 10 }, ui => ui.setFull(true)]) {
    const ui = component(body => page(body, 'private-body')); openTool(ui); await settle()
    assert.equal(text(pre(ui.field('output'))), 'private-body')
    change(ui); assert.equal(ui.field('output'), undefined)
  }
})
test('目标、offset 或分页元数据不一致时不展示其他调用的正文', async () => {
  for (const patch of [{ callId: 'other' }, { sessionId: 'other' }, { offset: 5 }, { nextOffset: 10 }, { totalChars: 3 * 1024 * 1024 }]) {
    const ui = component(body => ({ ...page(body, 'wrong-data'), ...patch }))
    openTool(ui); await settle()
    assert.equal(pre(ui.root()), undefined); assert.match(text(ui.root()), /invalid|incompatible/)
  }
})
