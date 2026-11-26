import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

// 只模拟传输边界；使用真实组件与详情分页逻辑，本机不执行这些用例。
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/extras/tools.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
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
function component(reply) {
  const stores = new Map(); let cells; let slot = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => { const index = slot++; cells[index] ??= { value: initial }; const cell = cells[index]; return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }] },
    useRef: current => { const index = slot++; cells[index] ??= { current }; return cells[index] },
    useEffect: (effect, deps) => { const index = slot++; const previous = cells[index]; if (!previous || deps.some((value, index) => value !== previous.deps[index])) { previous?.cleanup?.(); cells[index] = { deps, cleanup: effect() } } },
  }
  const requests = []
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react, AbortController,
    testToolCall: (endpoint, body, signal) => { requests.push({ endpoint, body: { ...body }, signal }); return Promise.resolve().then(() => reply(body)) },
  })
  const entry = { tools: [{ name: 'bash', callId: 'call', callSeq: 2, sessionId: 'part', ok: true }] }
  let fullMessages = false
  const render = (key, fn) => { cells = stores.get(key) ?? []; stores.set(key, cells); slot = 0; return fn() }
  const root = () => render('root', () => module.exports.ToolSteps({ entry, fullMessages }))
  const field = name => {
    const descriptor = nodes(root()).find(node => typeof node.type === 'function' && node.props.field === name)
    assert.ok(descriptor)
    return render(name, () => descriptor.type(descriptor.props))
  }
  const unmount = name => { for (const cell of stores.get(name) ?? []) cell?.cleanup?.() }
  return { root, field, entry, requests, unmount, setFull: value => { fullMessages = value } }
}
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes)
  return value && typeof value === 'object' ? [value, ...nodes(value.children ?? [])] : []
}
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.children ?? []) : typeof value === 'string' ? value : ''
const toggle = (node, open) => { const target = { open }; node.props.onToggle({ target, currentTarget: target }) }
const settle = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve() }
const more = node => nodes(node).find(node => node.type === 'button' && text(node) === 'Load more')
const pre = node => nodes(node).find(node => node.type === 'pre')

function openField(ui, name = 'output') { toggle(ui.root(), true); toggle(ui.field(name), true) }

test('折叠不请求，展开总数不批量读正文；按字段展开才请求并显示密钥保护策略', async () => {
  const ui = component(body => page(body, 'safe'))
  ui.root(); assert.equal(ui.requests.length, 0)
  toggle(ui.root(), true); assert.equal(ui.requests.length, 0)
  assert.match(text(ui.root()), /Secret protection is on/)
  toggle(ui.field('arguments'), true); await settle()
  assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].body.field, 'arguments')
  assert.equal(ui.requests[0].body.sessionId, 'part'); assert.equal(ui.requests[0].body.callId, 'call')
})
test('分页按 offset 原样拼接，不插入换行或删除已经读取的开头', async () => {
  const ui = component(body => body.offset === undefined ? page(body, 'abc', 0, 6, 3) : page(body, 'def', 3, 6))
  openField(ui); await settle()
  more(ui.field('output')).props.onClick(); await settle()
  assert.equal(text(pre(ui.field('output'))), 'abcdef')
  assert.equal(ui.requests[1].body.offset, 3); assert.equal(ui.requests[1].body.digest, digest)
})
test('同一帧重复展开不重复请求，关闭或卸载后的迟到回包不恢复正文', async () => {
  let done
  const ui = component(body => new Promise(resolve => { done = () => resolve(page(body, 'late-body')) }))
  toggle(ui.root(), true)
  const field = ui.field('output'); toggle(field, true); toggle(field, true)
  await settle(); assert.equal(ui.requests.length, 1)
  toggle(ui.field('output'), false); assert.equal(ui.requests[0].signal.aborted, true)
  done(); await settle(); assert.equal(pre(ui.field('output')), undefined)
  let finish
  const disposed = component(body => new Promise(resolve => { finish = () => resolve(page(body, 'disposed-body')) }))
  openField(disposed); await settle(); disposed.unmount('output')
  assert.equal(disposed.requests[0].signal.aborted, true)
  finish(); await settle(); assert.equal(pre(disposed.field('output')), undefined)
})
test('详情发生变化不拼接不同 digest，错误可重读首段；拒绝后释放已经显示的正文', async () => {
  let denied = false
  const ui = component(body => body.offset === undefined ? page(body, 'old', 0, 6, 3)
    : denied ? Promise.reject(Object.assign(new Error('access revoked'), { code: 'bot/refused' })) : page(body, 'new', 3, 6, null, 'b'.repeat(64)))
  openField(ui); await settle()
  more(ui.field('output')).props.onClick(); await settle()
  assert.equal(text(pre(ui.field('output'))), 'old')
  assert.match(text(ui.field('output')), /changed|first page/)
  denied = true
  more(ui.field('output')).props.onClick(); await settle()
  assert.equal(pre(ui.field('output')), undefined)
  assert.match(text(ui.field('output')), /access revoked/)
})
test('HTTP 401 或 403 不继续保留先前读取的工具正文', async () => {
  for (const code of ['HTTP_401', 'HTTP_403']) {
    const ui = component(body => body.offset === undefined ? page(body, 'private-body', 0, 24, 12)
      : Promise.reject(Object.assign(new Error('Authorization unavailable'), { code })))
    openField(ui); await settle()
    assert.equal(text(pre(ui.field('output'))), 'private-body')
    more(ui.field('output')).props.onClick(); await settle()
    assert.equal(pre(ui.field('output')), undefined)
    assert.match(text(ui.field('output')), /Authorization unavailable/)
  }
})
test('保持原 128 Ki 展示预算，达到上限提示不完整，不偷偷替换成输出尾部', async () => {
  const ui = component(body => {
    const offset = body.offset ?? 0
    const value = offset === 0 ? 'FIRST'.padEnd(32768, 'x') : 'x'.repeat(32768)
    return page(body, value, offset, 200000, offset + value.length)
  })
  openField(ui); await settle()
  for (let index = 0; index < 3; index += 1) { more(ui.field('output')).props.onClick(); await settle() }
  const value = text(pre(ui.field('output')))
  assert.equal(value.length, 131072); assert.equal(value.startsWith('FIRST'), true)
  assert.equal(more(ui.field('output')), undefined)
  assert.match(text(ui.field('output')), /display limit/)
  assert.equal(ui.requests.length, 4)
})
test('调用、会话和完整消息模式都是组件键的一部分，不能复用旧敏感正文', () => {
  const ui = component(body => page(body, 'safe')); toggle(ui.root(), true)
  const key = () => nodes(ui.root()).find(node => node.type === 'div' && node.props.className === 'bt-extra-tool').props.key
  const first = key(); ui.entry.tools[0].sessionId = 'another-part'; assert.notEqual(key(), first)
  const second = key(); ui.setFull(true); assert.notEqual(key(), second)
  const third = key(); ui.entry.tools[0].callSeq = 10; assert.notEqual(key(), third)
})
test('目标、offset 或分页元数据不一致时不展示其他调用的正文', async () => {
  for (const patch of [{ callId: 'other' }, { sessionId: 'other' }, { offset: 5 }, { nextOffset: 10 }, { totalChars: 3 * 1024 * 1024 }]) {
    const ui = component(body => ({ ...page(body, 'wrong-data'), ...patch }))
    openField(ui); await settle()
    assert.equal(pre(ui.field('output')), undefined)
    assert.match(text(ui.field('output')), /invalid|incompatible/)
  }
})
