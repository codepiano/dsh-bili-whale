import { apiGet } from './bili-api.mjs'

const text = value => String(value ?? '').trim()
const usefulLength = value => [...value.replace(/[^\p{L}\p{N}]/gu, '')].length

// This is a metadata lookup, before any selection, watch, or subtitle operation.
export async function enrichShortVideos(candidates, { headers = {}, signal, get = apiGet } = {}) {
  const pending = candidates.filter(c => /^BV[0-9A-Za-z]{10}$/.test(c.bv) &&
    !c.video_info && usefulLength(text(c.description)) < 40)
  await Promise.all(pending.map(async c => {
    const original = text(c.description)
    const url = 'https://api.bilibili.com/x/web-interface/view?bvid=' + c.bv
    const receipt = { url, search_description: original, status: 'unavailable' }
    c.video_info = receipt
    try {
      const timeout = AbortSignal.timeout(12000)
      const result = await get(url, headers, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      receipt.code = result.code
      if (result.code !== 0 || result.data?.bvid !== c.bv) {
        receipt.reason = result.code !== 0 ? 'api_error' : 'video_identity_mismatch'
        return
      }
      const view = result.data
      receipt.cached = Boolean(result._cached)
      receipt.stale = Boolean(result._stale)
      const parts = [...new Set((view.pages ?? []).map(p => text(p.part)))]
        .filter(p => p && p !== c.t && p !== view.title && !/^(?:p(?:art)?\s*)?\d+$/i.test(p))
      const added = [text(view.desc), ...parts].filter(p => usefulLength(p) && !original.includes(p))
      receipt.status = added.length ? 'enriched' : 'no_additional_detail'
      if (added.length) c.description = [...new Set([original, ...added].filter(usefulLength))].join('\n').slice(0, 1000)
    } catch {
      signal?.throwIfAborted()
      receipt.reason = 'lookup_failed'
    }
  }))
}
