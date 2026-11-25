import assert from 'node:assert/strict'
import { test } from 'node:test'
import { archiveCandidates, archiveBlocked, archiveExpired, DAY_MS } from '../src/host/extras/archive.js'

function runtime() {
  const bot = {
    id: 'bot', sessionId: 'current', extras: { messageMode: 'queue' },
    segments: [{ sessionId: 'old', endedAt: 1 }],
    tasks: [
      { id: 'ended', sessionId: 'done', status: 'completed', endedAt: 1, updatedAt: 1 },
      { id: 'running', sessionId: 'busy', status: 'running', updatedAt: 1 },
      { id: 'unknown', sessionId: 'unknown', status: 'new-status', updatedAt: 1 },
    ],
  }
  const agents = new Map()
  const archived = new Set()
  const calls = []
  const rt = {
    state: { bots: { bot }, rooms: {}, switching: {}, inflight: {} },
    chatOwners: new Map([['current', 'bot'], ['busy', 'bot']]), taskOwners: new Map([['busy', { botId: 'bot' }]]),
    groupOwners: new Map(), roomOwners: new Map(), live: new Map(),
    ctx: {
      get: name => name === 'agents' ? agents : undefined,
      workspaceRegistry: { get archivedSessionIds() { return [...archived] }, archiveSession: async id => { calls.push(id); archived.add(id) } },
      sessionController: { page: async () => ({ records: [], hasMore: false }) },
    },
    readOnly: () => undefined, botOf: id => id === 'bot' ? bot : undefined,
    runningJobs: () => [], waitsForApproval: () => false,
  }
  return { rt, bot, agents, archived, calls }
}

test('只选超过24小时的已结束后台会话和旧段，不选择当前、运行或未知状态', () => {
  const { rt, bot } = runtime()
  assert.deepEqual(archiveCandidates(rt, DAY_MS + 2).map(item => item.sessionId), ['old', 'done'])
  assert.equal(archiveCandidates(rt, DAY_MS).length, 0)
  bot.extras.autoArchive = false
  assert.equal(archiveCandidates(rt, DAY_MS * 3).length, 0)
})

test('排队、审批、切段和作业都阻止归档', () => {
  const { rt, agents } = runtime()
  agents.set('done', { inbox: { nextTurn: [{}], nextStep: [] } })
  assert.equal(archiveBlocked(rt, 'done'), true)
  agents.clear()
  rt.state.questions = { done: { id: 'question' } }
  assert.equal(archiveBlocked(rt, 'done'), true)
  delete rt.state.questions
  rt.state.switching.done = {}
  assert.equal(archiveBlocked(rt, 'done'), true)
  delete rt.state.switching.done
  rt.runningJobs = id => id === 'done' ? [{}] : []
  assert.equal(archiveBlocked(rt, 'done'), true)
})

test('公开归档接口保留历史、不会强制停止；近期事件延后归档', async () => {
  const { rt, calls, bot } = runtime()
  rt.ctx.sessionController.page = async ({ address }) => ({ records: address.sessionId === 'done' ? [{ event: { time: DAY_MS + 1 } }] : [], hasMore: false })
  const result = await archiveExpired(rt, DAY_MS + 2)
  assert.equal(result.archived, 1)
  assert.deepEqual(calls, ['old'])
  assert.equal(bot.tasks.length, 3)
  assert.equal(bot.segments.length, 1)
})

test('归档读取期间出现新队列会跳过，只读宿主不归档', async () => {
  const { rt, agents, calls } = runtime()
  rt.ctx.sessionController.page = async ({ address }) => {
    agents.set(address.sessionId, { inbox: { nextTurn: [{}], nextStep: [] } })
    return { records: [], hasMore: false }
  }
  await archiveExpired(rt, DAY_MS + 2)
  assert.equal(calls.length, 0)
  rt.readOnly = () => '另一个宿主持有锁'
  assert.equal((await archiveExpired(rt, DAY_MS + 2)).archived, 0)
})
