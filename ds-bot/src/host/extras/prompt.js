import { AsyncLocalStorage } from 'node:async_hooks'

const MODES = new Set(['queue', 'steer'])
const hasMode = bot => MODES.has(bot?.extras?.messageMode)

export function install(rt) {
  const scope = new AsyncLocalStorage()
  rt.ctx?.effect?.(() => () => scope.disable(), 'ds-bot: 增补输入模式上下文')
  const botFor = id => rt.botOf(id) ?? rt.botOf(rt.selfOf(id))
  const isUserPrompt = request => request?.sessionId !== undefined
    && rt.chatOwners.has(request.sessionId) && !rt.groupOwners.has(request.sessionId) && !rt.taskOwners.has(request.sessionId)
    && (request.source?.kind === undefined || request.source.kind === 'user')
  rt.extraKeepForeground = (id, requested) => hasMode(botFor(id)) || MODES.has(requested)
    || scope.getStore()?.sessionId === id && MODES.has(scope.getStore()?.mode)
  rt.extraSendPrompt = (request, send) => {
    if (!isUserPrompt(request)) return send(request)
    const bot = botFor(request.sessionId)
    const prompt = hasMode(bot) ? { ...request, mode: bot.extras.messageMode } : request
    // 模式沿当前异步输入链传播，供上游 inbox 插入监听使用；并发请求不共享模式。
    return scope.run({ sessionId: prompt.sessionId, mode: prompt.mode }, () => send(prompt))
  }
}
