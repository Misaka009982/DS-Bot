import { call } from '../api.js'

const waiting = []
let reading = 0
const aborted = () => Object.assign(new Error('已取消工具读取。'), { name: 'AbortError' })
function drain() {
  while (reading < 3 && waiting.length) {
    const item = waiting.shift()
    item.signal?.removeEventListener('abort', item.cancel)
    if (item.signal?.aborted) { item.reject(aborted()); continue }
    reading += 1
    Promise.resolve().then(() => {
      if (item.signal?.aborted) throw aborted()
      return call(item.endpoint, item.body, item.signal)
    }).then(item.resolve, item.reject).finally(() => { reading -= 1; drain() })
  }
}
// 展开多条记录时限制并发；折叠后仍在排队的请求不会发出。
export function readTool(endpoint, body, signal) {
  if (signal?.aborted) return Promise.reject(aborted())
  if (waiting.length >= 128) return Promise.reject(Object.assign(new Error('工具读取繁忙，请稍后重试。'), { code: 'bot/unavailable' }))
  return new Promise((resolve, reject) => {
    const item = { endpoint, body, signal, resolve, reject, cancel: () => {
      const at = waiting.indexOf(item)
      if (at !== -1) { waiting.splice(at, 1); reject(aborted()) }
    } }
    signal?.addEventListener('abort', item.cancel, { once: true })
    waiting.push(item); drain()
  })
}
