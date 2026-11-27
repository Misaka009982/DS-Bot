// 增补模块和原模块都使用独立桌面的 primitives，不加载 DSH Web UI。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import config from '../vite.config.js'
const resolveId = config.plugins.find(plugin => plugin.name === 'ds-bot-primitives').resolveId
const local = fileURLToPath(new URL('../ui/src/primitives.js', import.meta.url))
const client = fileURLToPath(new URL('../../ds-bot/src/client/cells.js', import.meta.url))
const extra = fileURLToPath(new URL('../../ds-bot/src/client/extras/tools.js', import.meta.url))
const plugin = fileURLToPath(new URL('../../ds-bot/src/client/dsh-primitives.js', import.meta.url))
test('原客户端与增补子目录的 primitives 都定位到同一本机实现', () => {
  assert.equal(resolveId('./dsh-primitives.js', client), local)
  assert.equal(resolveId('../dsh-primitives.js', extra), local)
  assert.equal(resolveId('../dsh-primitives.js', extra.replaceAll('\\', '/')), local)
  assert.equal(resolveId(plugin, undefined), local)
})
test('其他目录的同名文件和无来源相对路径不误映射', () => {
  const unrelated = fileURLToPath(new URL('../ui/src/another.js', import.meta.url))
  assert.equal(resolveId('./dsh-primitives.js', unrelated), null)
  assert.equal(resolveId('./dsh-primitives.js', undefined), null)
})
