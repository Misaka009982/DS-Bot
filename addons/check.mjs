// 只读取文本、Git 元数据与接入点；不安装、不构建、不运行插件。
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(path.join(root, 'addons/manifest.json'), 'utf8'))
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const issues = []
if (git(['rev-parse', `${manifest.upstream.commit}^{commit}`]) !== manifest.upstream.commit) issues.push('上游固定提交不存在')
try { git(['merge-base', '--is-ancestor', manifest.upstream.commit, 'HEAD']) } catch { issues.push('当前提交不是固定正式版的后代') }
const basePkg = JSON.parse(git(['show', `${manifest.upstream.commit}:ds-bot/package.json`]))
const pkg = JSON.parse(readFileSync(path.join(root, 'ds-bot/package.json'), 'utf8'))
if (basePkg.version !== manifest.upstream.version || pkg.version !== manifest.upstream.version) issues.push('源码版本与正式版基线不一致')
for (const hook of manifest.hooks) {
  const file = path.join(root, hook.path)
  if (!existsSync(file)) { issues.push(`接入文件不存在：${hook.path}`); continue }
  const text = readFileSync(file, 'utf8')
  for (const anchor of [hook.anchor, ...(hook.anchors ?? [])]) {
    if (text.split(anchor).length !== 2) issues.push(`接入点不唯一或已变化：${hook.path} → ${anchor}`)
  }
}
const forbidden = new Set(['ds-bot/package-lock.json', 'link/package-lock.json', 'mobile/package-lock.json', 'app/package-lock.json'])
const changed = git(['diff', '--name-only', manifest.upstream.commit, '--']).split('\n').filter(Boolean)
for (const file of changed) {
  if (forbidden.has(file)) issues.push(`固定依赖被修改：${file}`)
  if (file.includes('/node_modules/') || file.startsWith('deepseek-harness/')) issues.push(`不能修改 DSH 或安装目录：${file}`)
}
console.log(`上游正式基线：${manifest.upstream.tag} @ ${manifest.upstream.commit}`)
console.log(`增补版本：${manifest.addonVersion}；npm 安装包：${manifest.packageName}@${manifest.packageVersion}`)
console.log(`接入清单：${manifest.hooks.length} 个文件；生成文件仅由用户或 CI 构建`)
if (issues.length > 0) {
  for (const issue of issues) console.error(`兼容性检查失败：${issue}`)
  process.exitCode = 1
} else console.log('静态兼容性检查通过；不代表运行、测试或内存验收通过。')
