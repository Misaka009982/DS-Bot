import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/extras/settings.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
})

function component(name, { supported = true, readOnly = false, save = () => Promise.resolve() } = {}) {
  const cells = []
  let slot = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: initial => {
      const index = slot++
      cells[index] ??= { value: initial }
      return [cells[index].value, value => { cells[index].value = value }]
    },
    useRef: initial => {
      const index = slot++
      cells[index] ??= { current: initial }
      return cells[index]
    },
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
  const requests = [], runs = [], errors = []
  const bot = { id: 'bot', extras: {} }
  const roster = { readOnly: readOnly ? '只读宿主' : null, extras: { schema: 1, ...(supported ? { defaults: { schema: 1, messageMode: 'steer', autoArchive: true } } : {}) } }
  const entry = { id: 'device', pairedAt: 10, kind: 'browser', learningApproval: false }
  const actions = {
    extraPhoneSet: patch => { requests.push(['device', patch]); return save(patch) },
    extraSetDefaults: patch => { requests.push(['defaults', patch]); return save(patch) },
    extraSetBot: (id, patch) => { requests.push([id, patch]); return save(patch) },
  }
  const render = () => {
    slot = 0
    return module.exports[name]({ bot, roster, entry, readOnly, actions, Row: 'row', Card: 'card', Switch: 'switch',
      run: pending => {
        const current = pending.catch(error => { errors.push(error.message); return false })
        runs.push(current)
        return current
      } })
  }
  return { render, requests, runs, errors, bot, roster, entry }
}

function nodes(tree, type) {
  if (Array.isArray(tree)) return Array.from(tree).flatMap(node => nodes(node, type))
  if (!tree || typeof tree !== 'object') return []
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.children, type)]
}

const plain = value => JSON.parse(JSON.stringify(value))

test('学习审批开关紧邻完整消息，独立保存且连续点击只提交一次', async () => {
  const page = readFileSync(new URL('../src/client/phone-page.js', import.meta.url), 'utf8')
  assert.ok(page.indexOf('h(DeviceLearning,') > page.indexOf('h(DeviceMessages,'))
  assert.ok(page.indexOf('h(DeviceLearning,') < page.indexOf('h(DeviceResources,'))
  const ui = component('DeviceLearning')
  const toggle = nodes(ui.render(), 'switch')[0]
  assert.equal(toggle.props.on, false)
  toggle.props.onChange(true); toggle.props.onChange(false)
  assert.equal(nodes(ui.render(), 'switch')[0].props.disabled, true)
  await Promise.all(ui.runs)
  assert.deepEqual(plain(ui.requests), [['device', { deviceId: 'device', pairedAt: 10, learningApproval: true }]])
  assert.equal(nodes(ui.render(), 'switch')[0].props.on, false, '等服务器状态确认，不乐观伪造授权')
  const readOnly = component('DeviceLearning', { readOnly: true })
  nodes(readOnly.render(), 'switch')[0].props.onChange(true)
  assert.deepEqual(readOnly.requests, [])
  assert.equal(nodes(readOnly.render(), 'switch')[0].props.disabled, true)
})

test('通用基础总能显示团队默认入口，旧服务器隐藏且保存期间拒绝重复操作', async () => {
  const source = readFileSync(new URL('../src/client/settings.js', import.meta.url), 'utf8')
  const start = source.indexOf("key: 'basics'")
  const end = source.indexOf('h(LocationsSection', start)
  assert.ok(start >= 0 && end > start)
  assert.ok(source.slice(start, end).includes('h(DefaultExtras, { roster, actions, run, Row: SetRow, Switch })'))
  assert.equal(component('DefaultExtras', { supported: false }).render(), null)
  const ui = component('DefaultExtras')
  const select = nodes(ui.render(), 'select')[0]
  assert.equal(select.props.value, 'steer')
  assert.deepEqual(nodes(select, 'option').map(option => option.props.value), ['inherit', 'queue', 'steer'])
  select.props.onChange({ target: { value: 'queue' } })
  select.props.onChange({ target: { value: 'steer' } })
  assert.equal(nodes(ui.render(), 'select')[0].props.disabled, true)
  await Promise.all(ui.runs)
  assert.deepEqual(plain(ui.requests), [['defaults', { messageMode: 'queue' }]])
  const toggle = nodes(ui.render(), 'switch')[0]
  assert.equal(toggle.props.on, true)
  toggle.props.onChange(false)
  await Promise.all(ui.runs)
  assert.deepEqual(plain(ui.requests.at(-1)), ['defaults', { autoArchive: false }])
})

test('Bot 发送方式和归档可分别跟随默认或显式覆盖，不把显示的有效值写成覆盖', async () => {
  const ui = component('BotExtras')
  let selects = nodes(ui.render(), 'select')
  assert.equal(selects.length, 2)
  assert.deepEqual(selects.map(select => select.props.value), ['inherit', 'inherit'])
  assert.equal(ui.requests.length, 0)
  ui.bot.extras = { messageMode: 'queue', autoArchive: false }
  selects = nodes(ui.render(), 'select')
  assert.deepEqual(selects.map(select => select.props.value), ['queue', 'off'])
  selects[1].props.onChange({ target: { value: 'inherit' } })
  await Promise.all(ui.runs)
  assert.deepEqual(plain(ui.requests), [['bot', { autoArchive: null }]])
  const old = component('BotExtras', { supported: false })
  assert.equal(nodes(old.render(), 'switch').length, 1)
})

test('只读禁止修改，保存失败保留服务器原默认并可再次操作', async () => {
  const locked = component('DefaultExtras', { readOnly: true }).render()
  assert.equal(nodes(locked, 'select')[0].props.disabled, true)
  assert.equal(nodes(locked, 'switch')[0].props.disabled, true)
  const ui = component('DefaultExtras', { save: async () => { throw new Error('保存失败') } })
  nodes(ui.render(), 'select')[0].props.onChange({ target: { value: 'queue' } })
  await Promise.all(ui.runs)
  assert.deepEqual(ui.errors, ['保存失败'])
  assert.equal(nodes(ui.render(), 'select')[0].props.value, 'steer')
  assert.equal(nodes(ui.render(), 'select')[0].props.disabled, false)
})
