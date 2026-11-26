import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/extras/phone-name.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
})

function component({ supported = true, disabled = false, reply = () => Promise.resolve({ serverName: '新服务器' }) } = {}) {
  const cells = []
  const cleanups = []
  let slot = 0
  const react = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => {
      const index = slot++
      cells[index] ??= { value: initial }
      return [cells[index].value, next => { cells[index].value = typeof next === 'function' ? next(cells[index].value) : next }]
    },
    useRef: initial => {
      const index = slot++
      cells[index] ??= { current: initial }
      return cells[index]
    },
    useEffect: (effect, deps) => { if (deps.length === 0 && cleanups.length === 0) cleanups.push(effect()) },
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
  const phone = supported ? { serverName: '' } : {}
  const requests = []
  const errors = []
  const runs = []
  const actions = { phoneSet: body => { requests.push({ ...body }); return reply() } }
  const render = () => {
    slot = 0
    return module.exports.PhoneServerName({ phone, actions, disabled, Row: 'row', run: promise => {
      const task = promise.then(() => true, error => { errors.push(error.message); return false })
      runs.push(task)
      return task
    } })
  }
  const settle = async () => { await Promise.all(runs); await Promise.resolve(); await Promise.resolve() }
  return { render, phone, requests, errors, settle, unmount: () => cleanups.forEach(cleanup => cleanup()) }
}

function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes)
  return value !== null && typeof value === 'object' ? [value, ...nodes(value.children ?? [])] : []
}
const buttons = ui => nodes(ui.render()).filter(node => node.type === 'button')
const input = ui => nodes(ui.render()).find(node => node.type === 'input')

const keyEvent = fields => ({ preventDefault() {}, stopPropagation() {}, ...fields })

test('旧服务器不显示名称编辑；支持的服务器只在明确保存时请求', async () => {
  assert.equal(component({ supported: false }).render(), null)
  const ui = component()
  assert.equal(ui.requests.length, 0)
  buttons(ui)[0].props.onClick()
  assert.equal(input(ui).props.maxLength, 64)
  input(ui).props.onChange({ target: { value: '  杭州 + 100% & team  ' } })
  assert.equal(ui.requests.length, 0)
  const save = buttons(ui).at(-1)
  save.props.onClick()
  save.props.onClick()
  assert.equal(input(ui).props.disabled, true)
  await ui.settle()
  assert.deepEqual(ui.requests, [{ serverName: '杭州 + 100% & team' }])
  assert.equal(input(ui), undefined)
})

test('中文输入期间 Enter 不保存；正常 Enter 保存，Escape 取消且不发送', async () => {
  const ui = component()
  buttons(ui)[0].props.onClick()
  input(ui).props.onChange({ target: { value: '测试服务器' } })
  input(ui).props.onKeyDown(keyEvent({ key: 'Enter', isComposing: true }))
  input(ui).props.onKeyDown(keyEvent({ key: 'Enter', nativeEvent: { isComposing: true } }))
  input(ui).props.onKeyDown(keyEvent({ key: 'Enter', keyCode: 229 }))
  assert.equal(ui.requests.length, 0)
  input(ui).props.onKeyDown(keyEvent({ key: 'Escape' }))
  assert.equal(input(ui), undefined)
  assert.equal(ui.requests.length, 0)
  buttons(ui)[0].props.onClick()
  input(ui).props.onChange({ target: { value: '测试服务器' } })
  input(ui).props.onKeyDown(keyEvent({ key: 'Enter' }))
  await ui.settle()
  assert.deepEqual(ui.requests, [{ serverName: '测试服务器' }])
})

test('轮询不覆盖正在编辑的内容，取消后再次编辑使用服务器最新名称', () => {
  const ui = component()
  buttons(ui)[0].props.onClick()
  input(ui).props.onChange({ target: { value: '未保存名称' } })
  ui.phone.serverName = '其他窗口保存的名称'
  assert.equal(input(ui).props.value, '未保存名称')
  buttons(ui)[0].props.onClick()
  buttons(ui)[0].props.onClick()
  assert.equal(input(ui).props.value, '其他窗口保存的名称')
  assert.equal(ui.requests.length, 0)
})

test('保存失败保留未保存内容和错误，清空名称可恢复默认，禁用时不编辑或保存', async () => {
  const failed = component({ reply: () => Promise.reject(new Error('写盘失败')) })
  buttons(failed)[0].props.onClick()
  input(failed).props.onChange({ target: { value: '新服务器' } })
  buttons(failed).at(-1).props.onClick()
  await failed.settle()
  assert.equal(input(failed).props.value, '新服务器')
  assert.equal(input(failed).props.disabled, false)
  assert.deepEqual(failed.errors, ['写盘失败'])
  const cleared = component()
  cleared.phone.serverName = '原服务器'
  buttons(cleared)[0].props.onClick()
  input(cleared).props.onChange({ target: { value: '   ' } })
  buttons(cleared).at(-1).props.onClick()
  await cleared.settle()
  assert.deepEqual(cleared.requests, [{ serverName: '' }])
  const blocked = component({ disabled: true })
  buttons(blocked)[0].props.onClick()
  assert.equal(input(blocked), undefined)
  assert.equal(blocked.requests.length, 0)
})

test('超限、控制字符和不完整字符在发送前拒绝，错误保留编辑内容', async () => {
  for (const value of ['服'.repeat(65), 'a\nb', 'a\uD800b']) {
    const ui = component()
    buttons(ui)[0].props.onClick()
    input(ui).props.onChange({ target: { value } })
    buttons(ui).at(-1).props.onClick()
    await ui.settle()
    assert.equal(ui.requests.length, 0)
    assert.equal(ui.errors.length, 1)
    assert.equal(input(ui).props.value, value)
    assert.equal(input(ui).props.disabled, false)
  }
})

test('离开页面后不发送尚未开始的保存，迟到成功不操作新页面', async () => {
  const canceled = component()
  buttons(canceled)[0].props.onClick()
  input(canceled).props.onChange({ target: { value: '新服务器' } })
  buttons(canceled).at(-1).props.onClick()
  canceled.unmount()
  await canceled.settle()
  assert.equal(canceled.requests.length, 0)
  let done
  const late = component({ reply: () => new Promise(resolve => { done = resolve }) })
  buttons(late)[0].props.onClick()
  input(late).props.onChange({ target: { value: '迟到名称' } })
  buttons(late).at(-1).props.onClick()
  await Promise.resolve()
  late.unmount()
  done({ serverName: '迟到名称' })
  await late.settle()
  assert.deepEqual(late.requests, [{ serverName: '迟到名称' }])
})
