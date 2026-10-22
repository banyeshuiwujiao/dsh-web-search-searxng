/**
 * dsh-web-search-searxng —— 纯逻辑层（零宿主依赖）
 *
 * 这里只放「不需要网络、不需要 DSH 宿主」的纯函数：配置投影与结果归一化。
 * 单独成文件是为了让单元测试能在**没有宿主环境**的机器上直接跑
 * （index.mjs 顶部依赖宿主提供的 @deepseek-ai/dsh-web，裸 import 会在独立仓里失败）。
 *
 * 归一化是最容易悄悄坏的一层：去重、answers/infoboxes 解析、引擎挂起识别，
 * 错了不会抛异常，只会静默给出错误结果。所以它有独立的测试。
 *
 * @module dsh-web-search-searxng/lib/normalize
 */

/** Stable id this provider registers under on ctx.web. */
export const PROVIDER_ID = 'searxng'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8082'
const DEFAULT_TIMEOUT_MS = 30000

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0
}

/**
 * Project the row config + env into the options one search will use.
 *
 * @param {object} config - the row's config (all fields optional)
 * @param {object} [env] - environment to read DSH_WEB_SEARXNG_BASE_URL from (defaults to process.env)
 * @returns {{baseURL: string, timeoutMs: number, language?: string, categories: string, engines?: string, safeSearch?: number, extraParams?: object}}
 */
export function resolveOptions(config, env = process.env) {
  const rawBase = config.baseURL ?? env.DSH_WEB_SEARXNG_BASE_URL ?? DEFAULT_BASE_URL
  return {
    baseURL: String(rawBase).replace(/\/+$/u, ''),
    timeoutMs: isPositiveInt(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    language: config.language,
    categories: config.categories ?? 'web',
    engines: config.engines,
    safeSearch: config.safeSearch,
    extraParams: config.extraParams && typeof config.extraParams === 'object' ? config.extraParams : undefined,
  }
}

/**
 * Normalize a SearXNG JSON payload into the seam's `WebSearchResult` vocabulary.
 *
 * @param {object} payload - parsed JSON body from `/search?format=json`
 * @returns {{content?: string, sources: Array<object>, truncated: boolean}}
 */
export function normalizeResults(payload) {
  const rows = Array.isArray(payload?.results) ? payload.results : []
  const seen = new Set()
  const sources = []
  for (const row of rows) {
    const url = typeof row?.url === 'string' ? row.url : ''
    if (url.length === 0 || seen.has(url)) continue
    seen.add(url)
    const source = { url }
    if (typeof row.title === 'string' && row.title.length > 0) source.title = row.title
    const snippet =
      typeof row.content === 'string' && row.content.length > 0
        ? row.content
        : typeof row.snippet === 'string' && row.snippet.length > 0
          ? row.snippet
          : undefined
    if (snippet !== undefined) source.snippet = snippet
    const published = row.publishedDate ?? row.pubdate
    if (typeof published === 'string' && published.length > 0) source.publishedAt = published
    sources.push(source)
  }

  let content = undefined
  if (Array.isArray(payload?.answers) && payload.answers.length > 0) {
    const answers = payload.answers.filter((a) => typeof a === 'string' && a.trim().length > 0)
    if (answers.length > 0) content = answers.join('\n\n')
  }

  if (Array.isArray(payload?.infoboxes) && payload.infoboxes.length > 0) {
    for (const info of payload.infoboxes) {
      const infoContent = typeof info?.content === 'string' ? info.content.trim() : ''
      if (infoContent && !content) {
        content = infoContent
      }
      if (Array.isArray(info?.urls)) {
        for (const u of info.urls) {
          const targetUrl = typeof u?.url === 'string' ? u.url : ''
          if (!targetUrl || seen.has(targetUrl)) continue
          seen.add(targetUrl)
          sources.push({
            url: targetUrl,
            ...(u.title ? { title: u.title } : {}),
            ...(infoContent ? { snippet: infoContent } : {}),
          })
        }
      }
    }
  }

  return { ...(content !== undefined ? { content } : {}), sources, truncated: false }
}

/**
 * Engine-failure detection: SearXNG can answer 200 with zero results while every
 * engine is hanging. That must be an explicit error, not an empty success — an
 * empty success silently misleads the model into claiming "nothing found".
 *
 * @param {object} payload - parsed JSON body from `/search?format=json`
 * @returns {string|undefined} human-readable reason, or undefined when the empty result is genuine
 */
export function detectEngineFailure(payload) {
  const rows = Array.isArray(payload?.results) ? payload.results : []
  if (rows.length > 0) return undefined
  if (Array.isArray(payload?.answers) && payload.answers.length > 0) return undefined
  if (Array.isArray(payload?.infoboxes) && payload.infoboxes.length > 0) return undefined
  const unresp = Array.isArray(payload?.unresponsive_engines) ? payload.unresponsive_engines : []
  if (unresp.length === 0) return undefined
  return unresp.map(([engine, reason]) => `${engine} (${reason || 'unresponsive'})`).join(', ')
}
