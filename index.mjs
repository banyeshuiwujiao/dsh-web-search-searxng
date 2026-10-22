/**
 * dsh-web-search-searxng
 * ----------------------
 * A DeepSeek Harness (DSH) web-search provider that calls a SELF-HOSTED
 * SearXNG instance through its JSON API (`/search?format=json`) and registers
 * itself on the `ctx.web` capability seam under the id `searxng`.
 *
 * Why a plugin instead of config: DSH ships only `deepseek` / `exa` /
 * `perplexity` search providers. `ctx.web` is a provider registry, so a new
 * backend is a new plugin row — this file.
 *
 * Reachability is the operator's concern. This provider only needs a base URL
 * that speaks SearXNG's JSON API. The packaged setup points it at a local SSH
 * tunnel (`127.0.0.1:8082` -> Seoul host `127.0.0.1:8080`), so no public
 * exposure and no Basic-Auth credential is required.
 *
 * Row config (all optional):
 *   baseURL      string  SearXNG base (default env DSH_WEB_SEARXNG_BASE_URL, else http://127.0.0.1:8082)
 *   timeoutMs    number  per-search timeout (default 30000)
 *   language     string  e.g. "zh-CN" | "all"
 *   categories   string  e.g. "general,news"
 *   engines      string  e.g. "bing,google cse,wikipedia"
 *   safeSearch   number  0 | 1 | 2
 *   extraParams  object  any additional /search query params
 *
 * @module dsh-web-search-searxng
 */
import { WebError } from '@deepseek-ai/dsh-web'
import { PROVIDER_ID, resolveOptions, normalizeResults, detectEngineFailure } from './lib/normalize.mjs'

export { PROVIDER_ID, resolveOptions, normalizeResults, detectEngineFailure }
const USER_AGENT = 'dsh-web-search-searxng/1.0'
const PROVIDER_ERROR = 'WEB_PROVIDER_ERROR'
const ABORTED = 'WEB_ABORTED'

/** Merge several AbortSignals into one (no reliance on AbortSignal.any). */
function anySignal(signals) {
  const list = signals.filter((s) => s !== undefined)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  const controller = new AbortController()
  const onAbort = () => controller.abort(list.find((s) => s.aborted)?.reason)
  for (const signal of list) {
    if (signal.aborted) {
      onAbort()
      break
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw searchAborted(signal)
}

function searchAborted(signal, fallback) {
  return new WebError('SearXNG search aborted', ABORTED, {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** The SearXNG-backed search provider. */
export class SearxngSearchProvider {
  /**
   * @param resolve - thunk returning the options for the NEXT search, so a
   * config hot-reload never mixes two searches.
   */
  constructor(resolve) {
    this.resolve = resolve
  }

  /** @returns the provider id. */
  get id() {
    return PROVIDER_ID
  }

  /** Cheap local usability check — never makes a network call. */
  available() {
    const options = this.resolve()
    try {
      return URL.canParse(options.baseURL)
    } catch {
      return false
    }
  }

  /**
   * Run one search against SearXNG and normalize the JSON payload into the
   * seam's `WebSearchResult` vocabulary.
   * @param request - `{ query, maxResults? }` (the seam enforces maxResults).
   * @param signal - optional caller cancellation.
   */
  async search(request, signal) {
    const options = this.resolve()
    if (!this.available()) {
      throw new WebError(`SearXNG base URL is not a valid URL: ${String(options.baseURL)}`, PROVIDER_ERROR)
    }

    const endpoint = new URL(`${options.baseURL}/search`)
    endpoint.searchParams.set('q', request.query)
    endpoint.searchParams.set('format', 'json')
    if (options.language) endpoint.searchParams.set('language', String(options.language))
    if (options.categories) endpoint.searchParams.set('categories', String(options.categories))
    if (options.engines) endpoint.searchParams.set('engines', String(options.engines))
    if (options.safeSearch !== undefined && options.safeSearch !== null) {
      endpoint.searchParams.set('safesearch', String(options.safeSearch))
    }
    if (options.extraParams) {
      for (const [key, value] of Object.entries(options.extraParams)) {
        if (value !== undefined && value !== null) endpoint.searchParams.set(key, String(value))
      }
    }

    throwIfAborted(signal)
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(new Error('searxng-timeout')), options.timeoutMs)
    const combined = anySignal([signal, timeoutController.signal])

    let response
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        redirect: 'follow',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        ...(combined !== undefined ? { signal: combined } : {}),
      })
    } catch (error) {
      if (signal?.aborted === true) throw searchAborted(signal, error)
      if (timeoutController.signal.aborted) {
        throw new WebError(`SearXNG search timed out after ${options.timeoutMs}ms`, PROVIDER_ERROR, { cause: error })
      }
      throw new WebError(`SearXNG search request failed: ${String(error)}`, PROVIDER_ERROR, { cause: error })
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      throw new WebError(`SearXNG returned HTTP ${response.status}`, PROVIDER_ERROR)
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      if (signal?.aborted === true) throw searchAborted(signal, error)
      throw new WebError(`SearXNG returned an unprocessable body: ${String(error)}`, PROVIDER_ERROR, { cause: error })
    }

    const { content, sources } = normalizeResults(payload)

    // 引擎异常检测：若完全无搜索结果且 SearXNG 上游引擎报错/挂起，必须显式报错，避免静默失败误导模型
    if (sources.length === 0 && !content) {
      const reason = detectEngineFailure(payload)
      if (reason) {
        throw new WebError(`SearXNG 搜索引擎异常或挂起: ${reason}`, PROVIDER_ERROR)
      }
    }

    return {
      ...(content !== undefined ? { content } : {}),
      sources,
      truncated: false,
    }
  }
}

/** Cordis plugin name (loader diagnostics). */
export const name = 'web-search-searxng'
/** Hard dependency: the web capability seam this provider registers into. */
export const inject = ['web']

/**
 * Register the SearXNG search provider on `ctx.web`.
 * @param ctx - the plugin context.
 * @param config - the row's config (see module doc).
 */
export function apply(ctx, config = {}) {
  const resolved = { ...config }
  ctx.web.registerSearchProvider(new SearxngSearchProvider(() => resolveOptions(resolved)))
}
