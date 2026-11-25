// 由用户或 CI 调用；只在独立暂存目录改包版本，不改源码、锁文件或上传 npm。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(path.join(root, 'addons/manifest.json'), 'utf8'))
const plugin = path.join(root, 'ds-bot')
const pkg = JSON.parse(await readFile(path.join(plugin, 'package.json'), 'utf8'))
if (pkg.name !== manifest.packageName || pkg.version !== manifest.upstream.version) throw new Error('源码包名／版本与固定正式版不一致；拒绝打包')
for (const script of ['scripts/build-client.mjs', 'scripts/build-link.mjs']) {
  execFileSync(process.execPath, [script, '--check'], { cwd: plugin, stdio: 'inherit' })
}
const stage = await mkdtemp(path.join(tmpdir(), 'dsbot-addons-pack-'))
const destination = path.join(root, 'dist-addons')
await mkdir(destination, { recursive: true })
console.log(`暂存目录：${stage}`)
for (const entry of [...pkg.files, 'package.json']) {
  const source = path.resolve(plugin, entry)
  if (!source.startsWith(plugin + path.sep)) throw new Error('打包清单不能越出插件目录')
  await cp(source, path.join(stage, entry), {
    recursive: true, dereference: false,
    filter: async file => { if ((await lstat(file)).isSymbolicLink()) throw new Error('打包清单含链接，拒绝继续'); return true },
  })
}
pkg.version = manifest.packageVersion
pkg.files = [...pkg.files, 'addons.json', 'EXTRAS.md', 'NOTICE']
// 本地 .tgz 仍可安装；private 防止误把增补包发布为上游同名 npm 包。
pkg.private = true
await writeFile(path.join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
await writeFile(path.join(stage, 'addons.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await cp(path.join(root, 'addons/README.md'), path.join(stage, 'EXTRAS.md'))
await cp(path.join(root, 'NOTICE'), path.join(stage, 'NOTICE'))
const args = ['pack', '--ignore-scripts', '--pack-destination', destination]
console.log(`在暂存目录执行：npm ${args.join(' ')}`)
if (process.platform === 'win32') execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm pack --ignore-scripts --pack-destination "' + destination + '"'], { cwd: stage, stdio: 'inherit' })
else execFileSync('npm', args, { cwd: stage, stdio: 'inherit' })
const filename = `${manifest.packageName}-${manifest.packageVersion}.tgz`
const bytes = await readFile(path.join(destination, filename))
const digest = createHash('sha256').update(bytes).digest('hex')
await writeFile(path.join(destination, 'SHA256SUMS-addons.txt'), `${digest}  ${filename}\n`, 'utf8')
await writeFile(path.join(destination, 'BUILD-INFO-addons.json'), `${JSON.stringify({ upstream: manifest.upstream, addonVersion: manifest.addonVersion,
  packageVersion: manifest.packageVersion, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  package: filename, sha256: digest, node: process.version, generatedBy: 'addons/pack.mjs' }, null, 2)}\n`, 'utf8')
console.log(`已生成 ${path.join(destination, filename)}；未执行 npm publish。`)
console.log('暂存目录保留供检查；确认无须保留后可由用户手动清理。')
