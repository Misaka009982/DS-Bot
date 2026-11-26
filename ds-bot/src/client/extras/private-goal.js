import { createElement as h, useRef, useState } from 'react'

const labels = { active: '持续推进中', paused: '已暂停', blocked: '等待处理', complete: '已完成', stopped: '已终止' }

export function PrivateGoal({ bot, roster, actions, run, Card }) {
  const [objective, setObjective] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [editing, setEditing] = useState(false)
  const saving = useRef(false)
  if (roster.extras?.privateGoal?.schema !== 1 || typeof actions.extraGoalControl !== 'function') return null
  const goal = bot.extras?.goal
  const live = goal && !['complete', 'stopped'].includes(goal.status)
  const disabled = busy || Boolean(roster.readOnly)
  const submit = (action, patch = {}) => {
    if (saving.current || roster.readOnly) return
    saving.current = true
    setBusy(true)
    void run(Promise.resolve().then(() => actions.extraGoalControl({
      botId: bot.id, sessionId: bot.sessionId, action,
      ...(goal ? { goalId: goal.id, revision: goal.revision } : {}), ...patch,
    })).then(result => {
      if (result !== false) { setObjective(''); setAcceptance(''); setEditing(false); setConfirmStop(false) }
      return result
    })).finally(() => { saving.current = false; setBusy(false) })
  }
  const field = (label, value, onChange) => h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
    h('span', { className: 'bt-bs-label' }, label),
    h('textarea', { className: 'bt-input bt-bs-area', value, maxLength: 4000, disabled, 'aria-label': label, onChange: event => onChange(event.target.value) }))
  return h(Card, { title: '私聊目标模式' },
    h('div', { className: 'bt-set-row bt-bs-row' }, h('span', { className: 'bt-set-hint' },
      '为当前长任务设定目标和验收标准。阶段汇报后自动继续；遇到审批、问题卡片、后台工作或错误时等待。暂停／终止只停止后续自动推进，当前轮次可用聊天停止按钮结束。')),
    goal ? h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack', role: 'status' },
      h('strong', null, labels[goal.status] ?? goal.status),
      h('span', { style: { whiteSpace: 'pre-wrap' } }, goal.objective),
      h('span', { className: 'bt-set-hint', style: { whiteSpace: 'pre-wrap' } }, `验收：${goal.acceptance}`),
      goal.progress ? h('span', null, `进展：${goal.progress}`) : null,
      goal.evidence ? h('span', { className: 'bt-set-hint' }, `证据：${goal.evidence}`) : null,
      goal.reason ? h('span', { className: 'bt-set-hint' }, goal.reason) : null) : null,
    !live || editing ? h('div', null,
      field('目标', objective, setObjective), field('验收标准', acceptance, setAcceptance),
      h('div', { className: 'bt-set-row bt-bs-row' },
        h('button', { type: 'button', className: 'bt-soft', disabled: disabled || !objective.trim() || !acceptance.trim(), onClick: () => submit(editing ? 'revise' : 'start', { ...(editing ? { goalId: editing.id, revision: editing.revision } : {}), objective, acceptance }) }, editing ? '保存目标调整' : '启动目标'),
        editing ? h('button', { type: 'button', className: 'bt-soft', disabled, onClick: () => setEditing(false) }, '取消') : null)) : null,
    live ? h('div', { className: 'bt-set-row bt-bs-row' },
      goal.status === 'active'
        ? h('button', { type: 'button', className: 'bt-soft', disabled, onClick: () => submit('pause') }, '暂停自动推进')
        : h('button', { type: 'button', className: 'bt-soft', disabled, onClick: () => submit('resume') }, '恢复目标'),
      h('button', { type: 'button', className: 'bt-soft', disabled, onClick: () => { setObjective(goal.objective); setAcceptance(goal.acceptance); setEditing({ id: goal.id, revision: goal.revision }) } }, '调整目标'),
      h('button', { type: 'button', className: 'bt-soft', disabled, onClick: () => confirmStop === goal.id ? submit('stop') : setConfirmStop(goal.id) }, confirmStop === goal.id ? '确认终止目标' : '终止目标')) : null)
}
