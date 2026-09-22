/**
 * W10 §3 — A NODE THAT CANNOT CLAIM WORK IS OFFLINE, AND MUST SAY SO ITSELF.
 *
 * GROUND TRUTH, from /home/govhub/.pm2/logs/launchloop-node-err.log (pm2 stamps CEST):
 *
 *   18:24:42 {"state":"working","slot_id":"91ce55de…","task_title":"QA-прогон сайта PingPoint…"}
 *   18:24:46 {"state":"idle","last_poll":"1790094286","executor":null}
 *   …{"state":"idle"} every 33 s for the next three hours…
 *
 * The node took the owner's paid task, dropped it four seconds later, and reported itself healthy
 * ever after. Every line was literally true. THE PROBLEM IS THAT "IDLE" WAS AVAILABLE AS AN ANSWER
 * at a moment when the node was holding an assignment it was not working on and could not deliver.
 *
 * §4 IS THE CONTROL, and it is the whole suite. A health check that returns ok for a live process
 * would pass §1–§3 by accident — they are the happy path. §4 puts the node into each of the three
 * states the VPS node was actually in and requires a REFUSAL every time. If §4 goes green, this
 * file is testing that a function returns an object.
 *
 * Run: node test_w10_node_health.mjs
 */
import { newState, health } from './lib/health.mjs'
import { pageKey } from './lib/site-qa.mjs'
import { deliverableFrom } from './lib/deliverable.mjs'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const T0 = Date.parse('2026-09-22T18:24:42.000Z')
/** A node that has just ticked, reached the platform, and has a working browser. */
const healthy = (over = {}) => Object.assign(newState(), {
  lastTickAt: new Date(T0).toISOString(), lastPlatformOk: true, browserOk: true, executor: 'versum-qa-1',
}, over)

console.log('\n§1  a working node reports what it is doing')
ok('idle when nothing is running', health(healthy(), { now: T0 }).status === 'idle')
const busy = healthy()
busy.running.set('91ce55de', { title: 'QA-прогон', startedAt: new Date(T0).toISOString(), pass: 2 })
ok('working while it holds an assignment', health(busy, { now: T0 }).status === 'working')
ok('and it names the assignment', health(busy, { now: T0 }).running[0].slot_id === '91ce55de')
ok('healthy means no reasons', health(healthy(), { now: T0 }).reasons.length === 0)

console.log('\n§2  the clock the platform itself uses')
ok('one missed tick is not offline', health(healthy(), { now: T0 + 31_000 }).ok)
ok('two missed ticks is not offline', health(healthy(), { now: T0 + 61_000 }).ok)
ok('THREE missed ticks is offline — the platform\'s own rule, applied to itself',
   !health(healthy(), { now: T0 + 91_000 }).ok)
ok('a slower heartbeat moves the line with it',
   health(healthy(), { heartbeatSeconds: 60, now: T0 + 91_000 }).ok &&
   !health(healthy(), { heartbeatSeconds: 60, now: T0 + 181_000 }).ok)

console.log('\n§3  the node says WHY, not just no')
ok('a never-started loop is named', health(newState(), { now: T0 }).reasons[0] === 'worker loop has never ticked')
ok('a stale loop reports its age', /last ticked 9\ds ago/.test(health(healthy(), { now: T0 + 91_000 }).reasons[0]))
ok('an unreachable platform is named',
   health(healthy({ lastPlatformOk: false, lastPlatformError: 'timeout' }), { now: T0 }).reasons.join().includes('timeout'))
ok('several reasons all survive',
   health(Object.assign(newState(), { lastPlatformOk: false, browserOk: false }), { now: T0 }).reasons.length === 3)

console.log('\n§4  CONTROL — the three states the VPS node was actually in, each refused')
const dead = healthy(); dead.lastTickAt = new Date(T0 - 3 * 3600_000).toISOString()
ok('(a) loop dead three hours, process answering: OFFLINE, never idle',
   health(dead, { now: T0 }).status === 'offline' && !health(dead, { now: T0 }).ok,
   health(dead, { now: T0 }).status)
const cutOff = healthy({ lastPlatformOk: false, lastPlatformError: 'network' })
ok('(b) cannot reach the platform: OFFLINE, never idle',
   health(cutOff, { now: T0 }).status === 'offline', health(cutOff, { now: T0 }).status)
const noBrowser = healthy({ browserOk: false })
ok('(c) chromium will not launch on a browser-testing node: OFFLINE, never idle',
   health(noBrowser, { now: T0 }).status === 'offline', health(noBrowser, { now: T0 }).status)
ok('an unhealthy node NEVER reports working, even holding an assignment',
   (() => { const s = healthy({ browserOk: false }); s.running.set('x', { title: 't' }); return health(s, { now: T0 }).status === 'offline' })())
ok('"offline" is never reachable while all three hold',
   [0, 30_000, 60_000, 89_000].every((d) => health(healthy(), { now: T0 + d }).status !== 'offline'))

console.log('\n§5  one page has one identity, so one defect is reported once')
ok('case and trailing slash are the same page',
   pageKey('https://PingPoint.suverse.io') === pageKey('https://pingpoint.suverse.io/'))
ok('a fragment is a position, not a page',
   pageKey('https://a.io/docs#x') === pageKey('https://a.io/docs'))
ok('different paths stay different', pageKey('https://a.io/docs') !== pageKey('https://a.io/legal'))
ok('a query is part of the page', pageKey('https://a.io/s?q=1') !== pageKey('https://a.io/s?q=2'))

console.log('\n§6  the deliverable is the table the client was promised')
const COLS = ['URL/раздел', 'дефект', 'шаги воспроизведения', 'ожидаемое', 'фактическое', 'приоритет', 'скриншот']
const spec = { kind: 'table', columns: COLS.map((name) => ({ name })) }
const result = {
  notes: ['проверено X'], uncovered: ['разделы за логином'],
  defects: [
    { 'URL/раздел': 'a', 'дефект': 'косметика', 'шаги воспроизведения': 's', 'ожидаемое': 'e', 'фактическое': 'f', 'приоритет': 'cosmetic', 'скриншот': '', kind: 'cosmetic' },
    { 'URL/раздел': 'b', 'дефект': 'ломает', 'шаги воспроизведения': 's', 'ожидаемое': 'e', 'фактическое': 'f', 'приоритет': 'blocker', 'скриншот': '', kind: 'functional' },
    { 'URL/раздел': 'c', 'дефект': 'мелочь', 'шаги воспроизведения': 's', 'ожидаемое': 'e', 'фактическое': 'f', 'приоритет': 'minor', 'скриншот': '', kind: 'functional' },
  ],
}
const d = deliverableFrom(result, spec)
ok('kind matches the output_spec', d.kind === 'table')
ok('every row carries every declared column', d.payload.rows.every((r) => COLS.every((c) => c in r)))
ok('cosmetic is not mixed in with functional — it comes last',
   d.payload.rows[d.payload.rows.length - 1]['приоритет'] === 'cosmetic')
ok('blockers come before minors', d.payload.rows[0]['приоритет'] === 'blocker')
ok('rows carry NO private keys the client did not ask for', d.payload.rows.every((r) => !('kind' in r)))
ok('what was checked and what was not reached are both said',
   d.payload.notes.includes('проверено X') && d.payload.notes.includes('разделы за логином'))
ok('it passes the real gate shape (no undeclared column missing)',
   d.payload.rows.every((r) => COLS.every((c) => c in r)))

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'RED'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
