#!/usr/bin/env node
/**
 * LaunchLoop reference QA agent.
 *
 *   node bin/qa-agent.mjs            # poll forever (POLL_MS, default 60 s)
 *   node bin/qa-agent.mjs --once     # one pass, then exit (used by the A6 driver)
 *
 * Env: LAUNCHLOOP_API_KEY (required), LAUNCHLOOP_MCP_URL, LAUNCHLOOP_MCP_BIN,
 *      AGENT_TAGS (default "web testing,qa"), POLL_MS, RUNS_DIR (default ./runs).
 *
 * One pass:
 *   1. my_profile → sanity (active, tags, bond)
 *   2. my_notifications → trial_won / slot_changes_requested drive follow-ups
 *   3. list_tasks(eligible_only) filtered to AGENT_TAGS:
 *        entry=trial → take_trial → run the checklist on the trial slice → submit_trial
 *        entry=take  → take_task  → run the checklist → submit_deliverable
 *   4. tasks where I already hold a 'taken' assignment (my_slot) → deliver
 * Every action is logged as JSON lines under RUNS_DIR for the owner.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, LaunchLoopError } from '../lib/mcp.mjs'
import { runChecklist } from '../lib/checklist.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// .env (never committed) — simple KEY=VALUE lines
if (existsSync(join(root, '.env'))) for (const l of readFileSync(join(root, '.env'), 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0 && !l.startsWith('#')) process.env[l.slice(0, i).trim()] ??= l.slice(i + 1).trim() }

const ONCE = process.argv.includes('--once')
const TAGS = (process.env.AGENT_TAGS ?? 'web testing,qa').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
const POLL_MS = Number(process.env.POLL_MS ?? 60_000)
const RUNS = process.env.RUNS_DIR ?? join(root, 'runs')
mkdirSync(RUNS, { recursive: true })
const log = (msg, extra) => { const line = `${new Date().toISOString()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`; console.log(line); appendFileSync(join(RUNS, `${new Date().toISOString().slice(0, 10)}.log`), line + '\n') }

/** URLs to test, from the task input (or the trial slice when carved). */
function targetUrls(task, slice) {
  if (slice && slice.kind === 'urls' && Array.isArray(slice.urls) && slice.urls.length) return slice.urls
  const inp = task.input_spec ?? {}
  if (inp.kind === 'urls' && Array.isArray(inp.urls)) return inp.urls
  if (inp.kind === 'text' && typeof inp.text === 'string') return Array.from(inp.text.matchAll(/https?:\/\/[^\s)"']+/g)).map((m) => m[0])
  if (inp.kind === 'dataset' && typeof inp.url === 'string') return [inp.url]
  return []
}

/** Shape the checklist output to the task's output_spec. */
function shapeResult(task, run) {
  const kind = task.output_spec?.kind ?? 'structured'
  // E6: the images are already uploaded; what travels in the payload is the note that they exist
  const images = (run.sent ?? []).map((s) => ({ artefact_id: s.artefact_id, url: s.url, caption: s.caption }))
  if (kind === 'structured') return { kind, payload: { steps: run.steps.map((s) => ({ url: s.url, action: s.action, result: s.result, ok: s.ok, ...(s.detail?.length ? { detail: s.detail } : {}) })), verdict: run.verdict, checked_at: run.checked_at, summary: run.summary, ...(images.length ? { images } : {}) } }
  if (kind === 'text') return { kind, payload: { text: `${run.summary}. Verdict: ${run.verdict}.\n` + run.steps.map((s) => `${s.ok ? 'PASS' : 'FAIL'} ${s.action} ${s.url}: ${s.result}`).join('\n') } }
  if (kind === 'table') return { kind, payload: { rows: run.steps.map((s) => ({ url: s.url, action: s.action, result: s.result, ok: s.ok })) } }
  if (kind === 'urls') return { kind, payload: { urls: Array.from(new Set(run.steps.map((s) => s.url))) } }
  return { kind, payload: { files: [] } }
}

function matches(task) {
  const tags = (task.required_tags ?? []).map((t) => String(t).toLowerCase())
  return tags.some((t) => TAGS.includes(t))
}

/**
 * E6 — the pictures go up before the deliverable does.
 *
 * Each one is its own call, so a refused image (over the cap, too many for one assignment) costs
 * that image and not the job. What stays in the deliverable is the note that the picture exists.
 */
async function sendShots(mcp, slotId, shots) {
  const sent = []
  for (const shot of shots) {
    try {
      const r = await mcp.submitArtefact(slotId, shot)
      sent.push({ artefact_id: r.artefact_id, url: shot.url, caption: shot.caption, size_bytes: shot.size_bytes })
      log(`slot ${slotId}: screenshot of ${shot.url} sent (${(shot.size_bytes / 1024).toFixed(0)} KB)`)
    } catch (e) {
      log(`slot ${slotId}: screenshot of ${shot.url} refused — ${e.message}`)
    }
  }
  return sent
}

async function deliverSlot(mcp, task, slotId) {
  const urls = targetUrls(task)
  if (!urls.length) { log(`slot ${slotId}: no URL in the task input — cannot run the checklist, leaving it`, { task: task.id }); return }
  log(`slot ${slotId}: running checklist`, { urls })
  const run = await runChecklist(urls, { log: (m) => log(m), screenshot: task.input_spec?.screenshot ?? 'full' })
  const sent = await sendShots(mcp, slotId, run.shots ?? [])
  const { kind, payload } = shapeResult(task, { ...run, sent })
  try {
    const r = await mcp.submitDeliverable(slotId, kind, payload)
    log(`slot ${slotId}: submitted → ${r.acceptance}`, { verdict: run.verdict, failed: run.failed, images: sent.length })
  } catch (e) {
    if (e instanceof LaunchLoopError) log(`slot ${slotId}: refused ${e.code} — ${e.message}`, e.details ? { failures: e.details?.verdict?.failures } : undefined)
    else throw e
  }
}

async function pass(mcp) {
  const me = await mcp.profile()
  log(`agent ${me.executor.display_name} (${me.executor.status}) tags=${me.tags.join(',')} bond=$${me.bond.active} trial_access=${me.trial_ratio.access}`)
  const notes = await mcp.notifications().catch(() => ({ notifications: [] }))
  for (const n of notes.notifications ?? []) log(`notification ${n.type}: ${n.title}`, n.data)

  const { tasks } = await mcp.listTasks({ eligible_only: false })
  const mine = tasks.filter(matches)
  log(`${tasks.length} matching task(s), ${mine.length} in my tags`)
  for (const t of mine) {
    // assignments I already hold (obligation from a won trial, or taken earlier)
    if (t.my_slot && t.my_slot.status === 'taken') { await deliverSlot(mcp, t, t.my_slot.id); continue }
    if (!t.eligible) { if (t.blockers?.length) log(`task ${t.id} "${t.title}": blocked ${t.blockers.join(',')}`); continue }
    if (t.entry === 'trial') {
      const trial = await mcp.takeTrial(t.id)
      log(`task ${t.id}: trial seat taken (${trial.id}) $${trial.price}`, { slice: trial.slice?.kind ?? trial.slice })
      const urls = targetUrls(t, trial.slice)
      if (!urls.length) { log(`trial ${trial.id}: no URL to test`); continue }
      const run = await runChecklist(urls, { log: (m) => log(m) })
      const { payload } = shapeResult(t, run)
      try { const r = await mcp.submitTrial(trial.id, payload); log(`trial ${trial.id}: submitted (${r.trial.status})`, { verdict: run.verdict, auto: r.verdict?.pass }) }
      catch (e) { if (e instanceof LaunchLoopError) log(`trial ${trial.id}: refused ${e.code} — ${e.message}`, { failures: e.details?.verdict?.failures }); else throw e }
    } else if (t.entry === 'take') {
      const r = await mcp.takeTask(t.id)
      log(`task ${t.id}: assignment ${r.slot.id} ${r.already_assigned ? '(already mine)' : 'taken'} $${r.slot.budget}`)
      if (r.slot.status === 'taken') await deliverSlot(mcp, t, r.slot.id)
    }
  }
}

const mcp = await connect({ log })
try {
  do {
    try { await pass(mcp) } catch (e) { log(`pass failed: ${e.message}`) }
    if (!ONCE) await new Promise((r) => setTimeout(r, POLL_MS))
  } while (!ONCE)
} finally {
  await mcp.close()
}
