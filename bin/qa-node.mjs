#!/usr/bin/env node
/**
 * W10 — the Playwright site-QA agent, run as a LIVE NODE.
 *
 *   node bin/qa-node.mjs --register        # publish capability + rate, then exit
 *   node bin/qa-node.mjs --once            # one poll: heartbeat, claim, run, deliver
 *   node bin/qa-node.mjs                   # stay up: heartbeat + poll on a clock
 *   node bin/qa-node.mjs --slot <id>       # run an assignment this node already holds
 *
 * THE HEALTH RULE THIS EXISTS TO ENFORCE.
 *
 * `launchloop-node-vps` took the owner's paid task twenty-three seconds after the money landed,
 * dropped it four seconds later, and then reported `{"state":"idle"}` every thirty-three seconds
 * for three hours. Every one of those was true and every one of them was a lie: the loop was alive,
 * the process answered, and the work was not happening. Two specific mistakes made that possible
 * and neither is repeated here:
 *
 *   1. its error went into a `tokio::sync::watch` channel and was immediately overwritten by the
 *      next `Idle`, so the failure never reached a log at all. Here every outcome is written before
 *      anything else can run, and a failed run is reported to the CLIENT as well as the operator.
 *   2. nothing reconciled what the PLATFORM thought this node was holding. `reconcile()` runs on
 *      every tick: an assignment the platform says is ours and that we are not working on is picked
 *      up, not left to rot until its deadline.
 *
 * So: HEALTH IS NOT "the process answers". `health()` is the node's own claim that it can do work,
 * and it is false unless the worker loop has ticked recently, the platform answered the last call,
 * and a browser will actually launch. When it is false the node heartbeats `status: 'offline'`
 * instead of `idle` and the platform stops offering it work — a node that can be pinged but cannot
 * claim is offline, and must be the one to say so.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { api, ApiError } from '../lib/api.mjs'
import { runSiteQa } from '../lib/site-qa.mjs'
import { deliverableFrom } from '../lib/deliverable.mjs'
import { capture } from '../lib/screenshot.mjs'
import { newState, health as healthOf } from '../lib/health.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (existsSync(join(root, '.env'))) for (const l of readFileSync(join(root, '.env'), 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0 && !l.startsWith('#')) process.env[l.slice(0, i).trim()] ??= l.slice(i + 1).trim() }

const ARGV = process.argv.slice(2)
const arg = (name) => { const i = ARGV.indexOf(name); return i >= 0 ? ARGV[i + 1] : null }
const has = (name) => ARGV.includes(name)

const CAPABILITY = process.env.NODE_CAPABILITY ?? 'browser-testing'
const UNIT_PRICE = Number(process.env.NODE_UNIT_PRICE ?? 0.5)
const HEARTBEAT_S = Math.min(60, Math.max(30, Number(process.env.NODE_HEARTBEAT_SECONDS ?? 30)))
const HEALTH_PORT = Number(process.env.NODE_HEALTH_PORT ?? 3210)
const MAX_PRICE = Number(process.env.NODE_MAX_PRICE_USD ?? 50)
const RUNS = process.env.RUNS_DIR ?? join(root, 'runs')
mkdirSync(RUNS, { recursive: true })

const log = (msg, extra) => {
  const line = `${new Date().toISOString()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`
  console.log(line)
  try { appendFileSync(join(RUNS, `${new Date().toISOString().slice(0, 10)}.log`), line + '\n') } catch { /* a full disk must not stop the work */ }
}

/** What this node knows about itself. `lastTickAt` is written by the worker loop and nothing else. */
const state = newState()

/** A browser that will not launch is a browser-testing node that cannot work. Checked, not assumed. */
async function checkBrowser() {
  try {
    const b = await chromium.launch({ headless: true })
    await b.close()
    state.browserOk = true
  } catch (e) {
    state.browserOk = false
    log(`browser will not launch: ${e.message}`)
  }
  state.browserCheckedAt = new Date().toISOString()
  return state.browserOk
}

const health = () => ({ ...healthOf(state, { heartbeatSeconds: HEARTBEAT_S }), capability: CAPABILITY, unit_price: UNIT_PRICE })

/** HTTP is a WINDOW onto health, never the definition of it: answering proves only that this served. */
function serveHealth() {
  const server = createServer((req, res) => {
    const h = health()
    const body = JSON.stringify(h, null, 2)
    res.writeHead(h.ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(body)
  })
  server.on('error', (e) => log(`health server could not listen on ${HEALTH_PORT}: ${e.message}`))
  server.listen(HEALTH_PORT, '127.0.0.1', () => log(`health on http://127.0.0.1:${HEALTH_PORT} (503 whenever this node cannot claim work)`))
  return server
}

async function platform(fn) {
  try { const r = await fn(); state.lastPlatformOk = true; state.lastPlatformError = null; return r }
  catch (e) { state.lastPlatformOk = false; state.lastPlatformError = e.code ?? e.message; throw e }
}

async function register() {
  const me = await platform(() => api.me())
  state.executor = me.executor.display_name
  log(`registering ${me.executor.display_name} (${me.executor.id}) for ${CAPABILITY} at $${UNIT_PRICE}/unit`)
  const r = await platform(() => api.setCapabilities([{ capability: CAPABILITY, unit_price: UNIT_PRICE, max_parallel: 1 }]))
  log('capabilities published', { capabilities: (r.capabilities ?? []).map((c) => `${c.capability ?? c.name}@${c.unit_price}`) })
  await platform(() => api.setFilters({ max_price_usd: MAX_PRICE, tags: [CAPABILITY], max_concurrent: 1 })).catch((e) => log(`filters not published: ${e.message}`))
  return r
}

/** One screenshot, uploaded against the assignment. Returns its artefact id, or null — never throws. */
function shooter(slotId) {
  return async (page, caption, fileName) => {
    try {
      const shot = await capture(page, { caption, fileName })
      if (!shot) return null
      const r = await api.artefact(slotId, {
        data_base64: shot.data_base64, file_name: shot.file_name, content_type: shot.content_type,
        caption: shot.caption, width: shot.width, height: shot.height,
      })
      log(`  screenshot up: ${caption.slice(0, 60)} (${(shot.size_bytes / 1024).toFixed(0)} KB)`)
      return r.artefact_id
    } catch (e) { log(`  screenshot refused: ${e.message}`); return null }
  }
}

async function runAssignment(slot, task) {
  const slotId = slot.id
  const urls = task.input_spec?.urls ?? (typeof task.input_spec?.text === 'string' ? Array.from(task.input_spec.text.matchAll(/https?:\/\/[^\s)"']+/g)).map((m) => m[0]) : [])
  const target = urls[0]
  state.running.set(slotId, { title: task.title, startedAt: new Date().toISOString(), pass: 0 })
  try {
    if (!target) throw new Error('в задании нет адреса сайта')
    log(`slot ${slotId}: six passes over ${target}`)
    const report = async (ev) => {
      const r = state.running.get(slotId); if (r) r.pass = ev.pass
      try { await api.progress(slotId, ev) } catch (e) { log(`  progress refused: ${e.code ?? e.message}`) }
      log(`  pass ${ev.pass}/${ev.of ?? '?'} ${ev.state ?? 'running'}: ${ev.title}`)
    }
    const result = await runSiteQa(target, { report, shoot: shooter(slotId), log })
    const { kind, payload } = deliverableFrom(result, task.output_spec)
    log(`slot ${slotId}: ${payload.rows.length} defect(s), submitting`)
    const r = await platform(() => api.submit(slotId, kind, payload))
    // THE RUN IS ONLY OVER ONCE THE PLATFORM HAS THE WORK. Saying "done" before the submit lands is
    // exactly the four-second lie: the node felt finished and the client had nothing.
    await api.progress(slotId, { pass: 6, of: 6, title: 'Обход ссылок, ошибки консоли и сети', state: 'done', run_state: 'done', defects: 0 }).catch(() => {})
    state.delivered.push({ slot_id: slotId, at: new Date().toISOString(), defects: payload.rows.length, acceptance: r.acceptance })
    log(`slot ${slotId}: delivered → ${r.acceptance}`, { defects: payload.rows.length })
    return r
  } catch (e) {
    const why = e instanceof ApiError ? `${e.code}: ${e.message}` : e.message
    log(`slot ${slotId}: RUN FAILED — ${why}`)
    // The client's money is in escrow on this assignment. They are told, in their own thread, what
    // stopped — not left with a card that stays at pass 3 for ever.
    await api.progress(slotId, { pass: state.running.get(slotId)?.pass || 1, title: 'Прогон остановлен', state: 'failed', run_state: 'failed', failure: `Прогон остановлен: ${why}` }).catch(() => {})
    throw e
  } finally {
    state.running.delete(slotId)
  }
}

/**
 * Assignments the PLATFORM says this node holds. The VPS node never asked, so an assignment it had
 * dropped stayed `taken` with nobody working on it until its deadline — invisible from both sides.
 */
async function reconcile() {
  const { tasks } = await platform(() => api.listTasks('?limit=50'))
  const held = tasks.filter((t) => t.my_slot && t.my_slot.status === 'taken')
  for (const t of held) {
    if (state.running.has(t.my_slot.id)) continue
    log(`reconcile: the platform says assignment ${t.my_slot.id} ("${t.title}") is mine and nothing is running it`)
    await runAssignment(t.my_slot, await platform(() => api.getTask(t.id)).then((x) => x.task ?? x))
  }
  return held.length
}

async function claim() {
  const { tasks } = await platform(() => api.listTasks('?limit=50'))
  const open = tasks.filter((t) => t.eligible && t.entry === 'take'
    && (t.required_tags ?? []).includes(CAPABILITY)
    && (t.unit_price == null || Number(t.unit_price) <= MAX_PRICE))
  if (!open.length) return 0
  const t = open[0]
  log(`claiming "${t.title}" ($${t.unit_price})`)
  const r = await platform(() => api.takeTask(t.id))
  const full = await platform(() => api.getTask(t.id)).then((x) => x.task ?? x)
  await runAssignment(r.slot, full)
  return 1
}

async function tick() {
  state.lastTickAt = new Date().toISOString()
  if (state.browserOk === null || Date.now() - Date.parse(state.browserCheckedAt ?? 0) > 300_000) await checkBrowser()
  const h = health()
  // The heartbeat carries the node's OWN verdict. An unhealthy node says 'offline' and is not
  // offered work — it does not quietly keep saying 'idle' while unable to do any.
  await platform(() => api.heartbeat({
    status: h.status,
    current_slot_id: [...state.running.keys()][0] ?? null,
    interval_seconds: HEARTBEAT_S,
    app: 'versum-qa-node/1.0.0',
    hardware_profile: { browser: state.browserOk === true, platform: process.platform },
  })).catch((e) => log(`heartbeat refused: ${e.code ?? e.message}`))
  if (!h.ok) { log(`OFFLINE — ${h.reasons.join('; ')}`); return }
  if (state.running.size) return
  if (await reconcile()) return
  await claim()
}

// ── entry ───────────────────────────────────────────────────────────────────────────────────────
const me = await platform(() => api.me()).catch((e) => { log(`cannot reach the platform: ${e.code} ${e.message}`); process.exit(1) })
state.executor = me.executor.display_name
log(`${me.executor.display_name} (${me.executor.id}) tags=${me.tags.join(',')} bond=$${me.bond.active} wallet=${me.executor.wallet_address}`)

if (has('--register')) { await register(); process.exit(0) }

await register().catch((e) => log(`register failed (continuing): ${e.message}`))
await checkBrowser()

const slotArg = arg('--slot')
if (slotArg) {
  state.lastTickAt = new Date().toISOString()
  const { tasks } = await platform(() => api.listTasks('?limit=50'))
  const t = tasks.find((x) => x.my_slot?.id === slotArg)
  if (!t) { log(`assignment ${slotArg} is not one of mine`); process.exit(1) }
  await runAssignment(t.my_slot, await platform(() => api.getTask(t.id)).then((x) => x.task ?? x))
  process.exit(0)
}

if (has('--once')) { await tick(); process.exit(0) }

const server = serveHealth()
const stop = async () => { log('stopping'); server.close(); process.exit(0) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
for (;;) {
  try { await tick() } catch (e) { log(`tick failed: ${e.code ?? ''} ${e.message}`) }
  await new Promise((r) => setTimeout(r, HEARTBEAT_S * 1000))
}
