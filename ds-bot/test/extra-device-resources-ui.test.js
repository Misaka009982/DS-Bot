import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/extras/device-resources.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
})

function setup(component = 'DeviceResources') {
  let index = 0
  const cells = [], requests = [], runs = [], effects = [], terminalRequests = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const at = index++
      cells[at] ??= { value: initial }
      return [cells[at].value, value => { cells[at].value = value }]
    },
    useRef(initial) { const at = index++; return cells[at] ??= { current: initial } },
    useEffect(effect, deps) {
      const at = index++
      if (!cells[at] || deps.some((value, i) => cells[at][i] !== value)) { cells[at] = deps; effects.push(effect) }
    },
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
  const entry = { id: 'device', pairedAt: 10, kind: 'browser', resources: { terminalRead: false, terminalWrite: false, filesRead: false, filesWrite: false } }
  const extras = { terminals: { schema: 1, read: true, write: true }, workspace: { schema: 1, read: true, write: true } }
  const render = () => {
    index = 0
    const out = module.exports[component]({ entry, extras, Switch: 'switch', Section: 'section',
      actions: { extraPhoneSet: async body => { requests.push(JSON.parse(JSON.stringify(body))) },
        extraUserTerminals: async () => { terminalRequests.push('list'); return { schema: 1, cleanupOnly: true, items: [{ terminalId: 'term-1', handleId: 'handle-1', sessionId: 'old-session', status: 'running' }] } },
        extraCloseTerminal: async handleId => { terminalRequests.push(['close', handleId]) },
      },
      run: promise => { runs.push(promise); return promise } })
    for (const effect of effects.splice(0)) effect()
    return out
  }
  return { entry, extras, render, requests, runs, terminalRequests }
}
const nodes = (tree, type) => Array.isArray(tree) ? Array.from(tree).flatMap(node => nodes(node, type))
  : tree && typeof tree === 'object' ? [...(tree.type === type ? [tree] : []), ...nodes(tree.children, type)] : []

test('用户终端目录只按需读取，关闭需二次确认且双击只提交一次', async () => {
  const ui = setup('UserTerminals')
  let buttons = nodes(ui.render(), 'button')
  assert.equal(ui.terminalRequests.length, 0)
  buttons[0].props.onClick()
  await setImmediate()
  buttons = nodes(ui.render(), 'button')
  buttons[1].props.onClick()
  assert.deepEqual(ui.terminalRequests, ['list'])
  buttons = nodes(ui.render(), 'button')
  buttons[1].props.onClick()
  buttons[1].props.onClick()
  await setImmediate()
  assert.deepEqual(ui.terminalRequests, ['list', ['close', 'handle-1'], 'list'])
})

test('资源开启先显示确认，读权限关闭时写权限不可开启，保存绑定配对时间', async () => {
  const ui = setup()
  let switches = nodes(ui.render(), 'switch')
  assert.equal(switches.length, 4)
  assert.equal(switches[1].props.disabled, true)
  switches[0].props.onChange(true)
  assert.equal(ui.requests.length, 0)
  const confirm = nodes(ui.render(), 'button')[0]
  confirm.props.onClick()
  confirm.props.onClick()
  await Promise.all(ui.runs)
  assert.deepEqual(ui.requests, [{ deviceId: 'device', pairedAt: 10, resources: { terminalRead: true } }])
  ui.entry.resources.terminalRead = true
  switches = nodes(ui.render(), 'switch')
  assert.equal(switches[1].props.disabled, false)
  switches[0].props.onChange(false)
  await Promise.all(ui.runs)
  assert.equal(ui.requests.at(-1).resources.terminalRead, false)
})

test('资源服务暂时卸载后仍可撤销已有授权', async () => {
  const ui = setup()
  ui.entry.resources.filesRead = true
  delete ui.extras.workspace
  delete ui.extras.terminals
  const available = nodes(ui.render(), 'switch')
  assert.equal(available.length, 1)
  assert.equal(available[0].props.disabled, false)
  available[0].props.onChange(false)
  await Promise.all(ui.runs)
  assert.equal(ui.requests[0].resources.filesRead, false)
})

test('重配使未提交的确认失效，宿主缺失写能力时不展示写入口', () => {
  const ui = setup()
  nodes(ui.render(), 'switch')[0].props.onChange(true)
  assert.equal(nodes(ui.render(), 'button').length, 2)
  ui.entry.pairedAt = 11
  ui.render()
  assert.equal(nodes(ui.render(), 'button').length, 0)
  ui.extras.workspace.write = false
  assert.equal(nodes(ui.render(), 'switch').length, 3)
  assert.equal(ui.requests.length, 0)
})
