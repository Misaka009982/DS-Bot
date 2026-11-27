import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../../addons/manifest.json', import.meta.url), 'utf8'))

test('正式版固定基线和所有接入点可定位，不依赖滚动 dev', () => {
  assert.equal(manifest.upstream.commit, '7963e66a74f40d23daa288a76cdca72b34e39561')
  assert.equal(manifest.upstream.version, '0.4.0')
  for (const hook of manifest.hooks) {
    const text = readFileSync(new URL(`../../${hook.path}`, import.meta.url), 'utf8')
    for (const anchor of [hook.anchor, ...(hook.anchors ?? [])]) {
      assert.equal(text.split(anchor).length, 2, `${hook.path} 接入点应唯一：${anchor}`)
    }
  }
})

test('普通主线 CI 仅为增补生成客户端，并在 Node 24／22 测试前完成', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(workflow.split("hashFiles('addons/manifest.json') != ''").length, 3)
  for (const [start, end] of [['  test:\n', '\n  test-node22:'], ['  test-node22:\n', '\n  scan:']]) {
    const section = workflow.split(start)[1]?.split(end)[0]
    assert.ok(section)
    const buildAt = section.indexOf('run: npm run build')
    assert.ok(buildAt >= 0)
    assert.ok(buildAt < section.search(/\bnpm (?:run test:windows|test)\b/))
  }
})

test('增补 Releases 不依赖 npm 账号，不申请 OIDC 发布权限', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release-addons.yml', import.meta.url), 'utf8')
  assert.equal(workflow.includes('npm publish'), false)
  assert.equal(workflow.includes('id-token:'), false)
  assert.equal(workflow.includes('node addons/pack.mjs'), true)
  assert.equal(workflow.includes('gh release upload'), true)
  const upstream = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.ok(upstream.includes("if: github.repository == 'Fei-Craft/DS-Bot' && !startsWith(github.event.release.tag_name, 'addons-v')"))
})
