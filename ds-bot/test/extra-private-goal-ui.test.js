import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/extras/private-goal.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
})

function setup({ supported = true, readonly = false, save = async () => ({}) } = {}) {
  let slot = 0
  const cells = []
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
  const bot = { id: 'b', sessionId: 's', extras: { messageMode: 'steer' } }
  const roster = { readOnly: readonly ? '只读' : null, extras: supported ? { privateGoal: { schema: 1 } } : {} }
  const actions = { extraGoalControl: body => { requests.push(JSON.parse(JSON.stringify(body))); return save(body) } }
  const render = () => {
    slot = 0
    return module.exports.PrivateGoal({ bot, roster, actions, Card: 'card', run: promise => {
      const pending = promise.catch(error => { errors.push(error.message); return false })
      runs.push(pending)
      return pending
    } })
  }
  return { render, requests, runs, errors, bot, roster }
}

function nodes(tree, type) {
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, type))
  if (!tree || typeof tree !== 'object') return []
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.children, type)]
}
const button = (ui, label) => nodes(ui.render(), 'button').find(node => node.children.includes(label))
const enter = (ui, label, value) => nodes(ui.render(), 'textarea').find(node => node.props['aria-label'] === label).props.onChange({ target: { value } })
const currentGoal = () => ({ schema: 1, id: 'goal', revision: 4, status: 'active', objective: '整理资料', acceptance: '资料有来源', progress: '', evidence: '', reason: '' })

test('旧服务器不显示目标，空值及只读状态不能启动', () => {
  assert.equal(setup({ supported: false }).render(), null)
  const ui = setup()
  assert.equal(button(ui, '启动目标').props.disabled, true)
  const locked = setup({ readonly: true })
  assert.ok(nodes(locked.render(), 'textarea').every(node => node.props.disabled))
  button(locked, '启动目标').props.onClick()
  assert.equal(locked.requests.length, 0)
})

test('非 steer 时启动和恢复被禁用，继承基础 steer 可用且独立 queue 优先', () => {
  const ui = setup(); enter(ui, '目标', '整理资料'); enter(ui, '验收标准', '资料有来源')
  ui.bot.extras.messageMode = 'queue'
  assert.equal(button(ui, '启动目标').props.disabled, true)
  button(ui, '启动目标').props.onClick(); assert.equal(ui.requests.length, 0)
  ui.bot.extras.messageMode = null
  assert.equal(button(ui, '启动目标').props.disabled, true)
  ui.roster.extras.defaults = { schema: 1, messageMode: 'steer' }
  assert.equal(button(ui, '启动目标').props.disabled, false)
  ui.bot.extras.messageMode = 'queue'
  ui.bot.extras.goal = { ...currentGoal(), status: 'paused' }
  assert.equal(button(ui, '恢复目标').props.disabled, true)
  button(ui, '恢复目标').props.onClick(); assert.equal(ui.requests.length, 0)
  assert.equal(button(ui, '终止目标').props.disabled, false)
})

test('启动绑定当前 Bot 和会话，保存中拒绝重复点击且失败保留输入', async () => {
  const ui = setup({ save: async () => { throw new Error('服务器拒绝保存') } })
  enter(ui, '目标', '整理资料'); enter(ui, '验收标准', '资料有来源')
  const start = button(ui, '启动目标')
  start.props.onClick(); start.props.onClick()
  assert.equal(button(ui, '启动目标').props.disabled, true)
  await Promise.all(ui.runs)
  assert.deepEqual(ui.requests, [{ botId: 'b', sessionId: 's', action: 'start', objective: '整理资料', acceptance: '资料有来源' }])
  assert.deepEqual(ui.errors, ['服务器拒绝保存'])
  assert.equal(nodes(ui.render(), 'textarea')[0].props.value, '整理资料')
  assert.equal(button(ui, '启动目标').props.disabled, false)
})

test('暂停携带目标编号与版本，结束状态只信任服务端回包', async () => {
  const ui = setup(); ui.bot.extras.goal = currentGoal()
  button(ui, '暂停自动推进').props.onClick(); await Promise.all(ui.runs)
  assert.deepEqual(ui.requests, [{ botId: 'b', sessionId: 's', action: 'pause', goalId: 'goal', revision: 4 }])
  assert.equal(ui.bot.extras.goal.status, 'active')
  ui.bot.extras.goal.status = 'paused'
  assert.ok(button(ui, '恢复目标'))
})

test('目标调整保留服务器 revision，终止必须二次点击', async () => {
  const ui = setup(); ui.bot.extras.goal = currentGoal()
  button(ui, '调整目标').props.onClick()
  enter(ui, '目标', '整理新增资料')
  ui.bot.extras.goal.revision = 5
  button(ui, '保存目标调整').props.onClick(); await Promise.all(ui.runs)
  assert.deepEqual(ui.requests[0], { botId: 'b', sessionId: 's', action: 'revise', goalId: 'goal', revision: 4, objective: '整理新增资料', acceptance: '资料有来源' })
  button(ui, '终止目标').props.onClick()
  ui.bot.extras.goal = { ...currentGoal(), id: 'another-goal' }
  assert.ok(button(ui, '终止目标'), '旧目标的确认不能终止新目标')
  button(ui, '终止目标').props.onClick()
  assert.equal(ui.requests.length, 1)
  button(ui, '确认终止目标').props.onClick(); await Promise.all(ui.runs)
  assert.equal(ui.requests[1].action, 'stop')
})
