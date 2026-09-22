/**
 * Plain REST client for the Versum agent API.
 *
 * The reference QA agent talks MCP, which is the right surface for a model driving the marketplace
 * by hand. A NODE is not that: it heartbeats on a clock, publishes a price, claims work and reports
 * progress, and every one of those is a single HTTP call that must be able to fail loudly. Going
 * through a spawned stdio proxy to make them buries the failure two processes away — which is how a
 * node ends up insisting it is healthy while it cannot reach the platform at all.
 */
const BASE = (process.env.LAUNCHLOOP_API_URL ?? 'https://launchloop.suverse.io').replace(/\/$/, '') + '/api/agent/v1'

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message ?? code ?? `HTTP ${status}`)
    this.status = status; this.code = code; this.details = details
  }
}

async function call(method, path, body, { key = process.env.LAUNCHLOOP_API_KEY, timeoutMs = 30000 } = {}) {
  if (!key) throw new ApiError(0, 'no_key', 'LAUNCHLOOP_API_KEY is not set')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ac.signal,
    })
    const text = await r.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 300) } }
    if (!r.ok) throw new ApiError(r.status, json?.error?.code ?? 'http_error', json?.error?.message ?? text.slice(0, 300), json?.error?.details)
    return json
  } catch (e) {
    if (e instanceof ApiError) throw e
    // An aborted fetch is a dead platform from this node's point of view, and must read as one.
    throw new ApiError(0, e.name === 'AbortError' ? 'timeout' : 'network', e.message)
  } finally { clearTimeout(timer) }
}

export const api = {
  me: () => call('GET', '/me'),
  ping: () => call('GET', '/ping'),
  heartbeat: (body) => call('POST', '/me/heartbeat', body),
  setCapabilities: (capabilities) => call('PUT', '/me/capabilities', { capabilities }),
  setFilters: (body) => call('PUT', '/me/filters', body),
  listTasks: (q = '') => call('GET', `/tasks${q}`),
  getTask: (id) => call('GET', `/tasks/${id}`),
  takeTask: (id) => call('POST', `/tasks/${id}/take`, {}),
  getSlot: (id) => call('GET', `/slots/${id}`),
  progress: (slotId, ev) => call('POST', `/slots/${slotId}/progress`, ev),
  artefact: (slotId, body) => call('POST', `/slots/${slotId}/artefacts`, body, { timeoutMs: 60000 }),
  submit: (slotId, kind, payload) => call('POST', `/slots/${slotId}/submit`, { kind, payload }),
}
