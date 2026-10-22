/**
 * dsh-web-search-searxng 自测 —— 只测纯函数，不碰网络、不依赖 DSH 宿主。
 *
 *   node test/smoke.mjs
 *
 * 测的是 lib/normalize.mjs：配置投影与结果归一化。这一层最容易悄悄坏
 * （去重漏了、answers 没解析、引擎全挂起却报成功），而且坏了不抛异常，
 * 只会静默给出错误结果给模型。所以它必须有独立门禁。
 *
 * 纯逻辑单独成文件正是为此：index.mjs 顶部 import 宿主提供的
 * @deepseek-ai/dsh-web，在没有宿主的独立仓里裸 import 会失败，
 * 而门禁必须能在任何机器上独立跑。
 */

import assert from 'node:assert/strict'
import { resolveOptions, normalizeResults, detectEngineFailure } from '../lib/normalize.mjs'

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

console.log('resolveOptions')

check('baseURL 末尾斜杠被去掉（避免拼出 //search）', () => {
  assert.equal(resolveOptions({ baseURL: 'http://127.0.0.1:8082/' }, {}).baseURL, 'http://127.0.0.1:8082')
  assert.equal(resolveOptions({ baseURL: 'http://x///' }, {}).baseURL, 'http://x')
})

check('没配 baseURL 时读环境变量，再退回默认', () => {
  assert.equal(resolveOptions({}, { DSH_WEB_SEARXNG_BASE_URL: 'http://env:1' }).baseURL, 'http://env:1')
  assert.equal(resolveOptions({}, {}).baseURL, 'http://127.0.0.1:8082')
})

check('配置优先于环境变量', () => {
  const o = resolveOptions({ baseURL: 'http://cfg:2' }, { DSH_WEB_SEARXNG_BASE_URL: 'http://env:1' })
  assert.equal(o.baseURL, 'http://cfg:2')
})

check('timeoutMs 只认正整数，非法值回落默认 30000', () => {
  assert.equal(resolveOptions({ timeoutMs: 5000 }, {}).timeoutMs, 5000)
  assert.equal(resolveOptions({ timeoutMs: 0 }, {}).timeoutMs, 30000)
  assert.equal(resolveOptions({ timeoutMs: -1 }, {}).timeoutMs, 30000)
  assert.equal(resolveOptions({ timeoutMs: 1.5 }, {}).timeoutMs, 30000)
})

check('categories 缺省补 "web"（原来传 undefined，靠后端决定）', () => {
  assert.equal(resolveOptions({}, {}).categories, 'web')
  assert.equal(resolveOptions({ categories: 'general,news' }, {}).categories, 'general,news')
})

check('extraParams 非对象时丢弃', () => {
  assert.equal(resolveOptions({ extraParams: 'nope' }, {}).extraParams, undefined)
  assert.deepEqual(resolveOptions({ extraParams: { a: 1 } }, {}).extraParams, { a: 1 })
})

console.log('normalizeResults')

check('结果按 url 去重（后来的重复项被丢弃）', () => {
  const r = normalizeResults({
    results: [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://a.com', title: 'A again' },
      { url: 'https://b.com' },
    ],
  })
  assert.equal(r.sources.length, 2)
  assert.deepEqual(r.sources.map((s) => s.url), ['https://a.com', 'https://b.com'])
})

check('缺 url 的行被跳过', () => {
  const r = normalizeResults({ results: [{ title: 'no url' }, { url: '' }, { url: 'https://ok.com' }] })
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].url, 'https://ok.com')
})

check('snippet 取 content，回落 snippet', () => {
  const r = normalizeResults({ results: [{ url: 'https://a.com', content: 'C' }, { url: 'https://b.com', snippet: 'S' }] })
  assert.equal(r.sources[0].snippet, 'C')
  assert.equal(r.sources[1].snippet, 'S')
})

check('publishedDate / pubdate 都认', () => {
  const r = normalizeResults({
    results: [
      { url: 'https://a.com', publishedDate: '2026-01-01' },
      { url: 'https://b.com', pubdate: '2026-02-02' },
    ],
  })
  assert.equal(r.sources[0].publishedAt, '2026-01-01')
  assert.equal(r.sources[1].publishedAt, '2026-02-02')
})

check('answers 拼成 content', () => {
  const r = normalizeResults({ results: [], answers: ['第一', '第二'] })
  assert.equal(r.content, '第一\n\n第二')
  assert.deepEqual(r.sources, [])
})

check('infoboxes 的正文进 content，链接并入 sources', () => {
  const r = normalizeResults({
    results: [],
    infoboxes: [
      { content: '框内正文', urls: [{ url: 'https://i.com', title: 'I' }] },
    ],
  })
  assert.equal(r.content, '框内正文')
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].url, 'https://i.com')
  assert.equal(r.sources[0].snippet, '框内正文')
})

check('infobox 里的链接与 results 里的 url 撞了只留一份', () => {
  const r = normalizeResults({
    results: [{ url: 'https://dup.com' }],
    infoboxes: [{ content: 'x', urls: [{ url: 'https://dup.com' }] }],
  })
  assert.equal(r.sources.length, 1)
})

check('answers 优先于 infobox 正文（content 只取第一处）', () => {
  const r = normalizeResults({ results: [], answers: ['答案'], infoboxes: [{ content: '框内' }] })
  assert.equal(r.content, '答案')
})

check('空 payload 不炸', () => {
  const r = normalizeResults({})
  assert.deepEqual(r.sources, [])
  assert.equal(r.content, undefined)
  assert.equal(r.truncated, false)
})

console.log('detectEngineFailure')

check('有结果时不报引擎故障', () => {
  assert.equal(detectEngineFailure({ results: [{ url: 'https://a.com' }], unresponsive_engines: [['bing', 'timeout']] }), undefined)
})

check('零结果 + 引擎挂起 → 报出引擎名与原因', () => {
  const reason = detectEngineFailure({ results: [], unresponsive_engines: [['bing', 'timeout'], ['google cse', '']] })
  assert.match(reason, /bing \(timeout\)/)
  assert.match(reason, /google cse \(unresponsive\)/)
})

check('零结果但有 answers / infoboxes 时不算引擎故障', () => {
  assert.equal(detectEngineFailure({ results: [], answers: ['a'], unresponsive_engines: [['bing', 'x']] }), undefined)
  assert.equal(detectEngineFailure({ results: [], infoboxes: [{ content: 'x' }], unresponsive_engines: [['bing', 'x']] }), undefined)
})

check('真·零结果且无引擎报错 → 不报故障（就是没搜到）', () => {
  assert.equal(detectEngineFailure({ results: [] }), undefined)
})

console.log(`\n✅ ${passed} 个用例通过`)
