import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/extras/new-session.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
})

function component({ supported = true, result = Promise.resolve({ sessionId: 'new' }) } = {}) {
  const cells = []
  const cleanups = []
  let slot = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => {
      const index = slot++
      cells[index] ??= { value: initial }
      return [cells[index].value, next => { cells[index].value = next }]
    },
    useRef: initial => {
      const index = slot++
      cells[index] ??= { current: initial }
      return cells[index]
    },
    useEffect: (effect, deps) => { if (deps.length === 0 && cleanups.length === 0) cleanups.push(effect()) },
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: () => react,
    setTimeout, clearTimeout,
  })
  const requests = []
  const opened = []
  const errors = []
  const runs = []
  const bot = { id: 'bot', sessionId: 'old' }
  const roster = { extras: { newSession: supported } }
  const actions = {
    extraNewSession: (botId, sessionId) => { requests.push([botId, sessionId]); return result },
    closeSettings: () => opened.push('closed'), openSession: id => opened.push(id),
  }
  const render = () => {
    slot = 0
    return module.exports.NewSessionRow({ bot, roster, actions, run: promise => {
      const run = promise.catch(error => { errors.push(error.message); return false })
      runs.push(run)
      return run
    } })
  }
  return { render, requests, opened, errors, runs, bot, roster, unmount: () => cleanups.forEach(cleanup => cleanup()) }
}

test('仅支持此增补的服务器显示新建会话，确认后只请求一次并打开返回的 Session', async () => {
  assert.equal(component({ supported: false }).render(), null)
  const ui = component()
  ui.render().props.onClick()
  assert.equal(ui.requests.length, 0)
  ui.render().props.onClick()
  ui.render().props.onClick()
  assert.equal(ui.render().props.disabled, true)
  await Promise.all(ui.runs)
  assert.deepEqual(ui.requests, [['bot', 'old']])
  assert.deepEqual(ui.opened, ['closed', 'new'])
})

test('会话发生变化后需要重新确认，Escape 和移开焦点取消确认', () => {
  const ui = component()
  ui.render().props.onClick()
  ui.bot.sessionId = 'changed'
  ui.render().props.onClick()
  assert.equal(ui.requests.length, 0)
  ui.render().props.onKeyDown({ key: 'Escape', stopPropagation() {} })
  ui.render().props.onClick()
  assert.equal(ui.requests.length, 0)
  ui.render().props.onBlur()
  ui.render().props.onClick()
  assert.equal(ui.requests.length, 0)
})

test('失败保持设置页且显示错误，不导航到不存在的新会话', async () => {
  const ui = component({ result: Promise.reject(new Error('当前会话忙')) })
  ui.render().props.onClick()
  ui.render().props.onClick()
  await Promise.all(ui.runs)
  assert.deepEqual(ui.opened, [])
  assert.deepEqual(ui.errors, ['当前会话忙'])
})

test('离开设置页后旧请求的成功回包不再改变导航', async () => {
  let resolve
  const ui = component({ result: new Promise(done => { resolve = done }) })
  ui.render().props.onClick()
  ui.render().props.onClick()
  ui.unmount()
  resolve({ sessionId: 'new' })
  await Promise.all(ui.runs)
  assert.deepEqual(ui.opened, [])
})
