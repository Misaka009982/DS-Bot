// 老服务器保持原响应；只有不存在增补接口时才回退，授权或网络错误不悄悄吞掉。
export async function extraChatRead(call, { botId, roomId, cursor }) {
  const payload = { ...(roomId === undefined ? { botId } : { roomId }), ...(cursor ? { cursor } : {}), steps: true }
  try { return await call('extra-messages', payload) }
  catch (error) {
    if (error?.code !== 'bot/not-found' || !String(error.message).includes('extra-messages')) throw error
    return call(roomId === undefined ? 'chat' : 'room-chat', payload)
  }
}

export function watchExtraMessages(feed, target, refresh) {
  let timer
  const off = feed.on((event, data) => {
    if (event !== 'extra-update' || !(data?.sessionId === target.sessionId || target.botId !== undefined && data?.botId === target.botId || target.roomId !== undefined && data?.roomId === target.roomId)) return
    if (timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; if (globalThis.document?.visibilityState !== 'hidden') refresh() }, 200)
  })
  return () => { clearTimeout(timer); off() }
}
