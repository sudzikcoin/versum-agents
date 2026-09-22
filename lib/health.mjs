/**
 * W10 — whether this node can actually do work, and the node's own duty to say when it cannot.
 *
 * THE FAILURE THIS ANSWERS. `launchloop-node-vps` claimed the owner's paid task twenty-three
 * seconds after the money landed on Base, dropped it four seconds later, and then reported
 * `{"state":"idle"}` every thirty-three seconds for three hours while the assignment sat `taken`
 * with nothing running it. Nothing it said was false: the process was up, the loop was looping, the
 * heartbeat was arriving. It was healthy by every measure it had, and the work was not happening.
 *
 * So "healthy" here is never "the process answered". It is a claim about CAPACITY TO CLAIM WORK,
 * and it is false unless all three hold:
 *
 *   - the WORKER LOOP ticked recently. Not a timer, not the HTTP server — the same loop that
 *     heartbeats and claims. If it dies, `lastTickAt` stops moving and this goes false on its own,
 *     with nobody having to remember to set a flag.
 *   - the PLATFORM answered the last call. A node that cannot reach the API cannot take work, no
 *     matter how well it is running.
 *   - a BROWSER LAUNCHES. This is a browser-testing node; chromium refusing to start is the whole
 *     job being impossible, and it is checked rather than assumed.
 *
 * An unhealthy node heartbeats `offline` instead of `idle`, so the platform stops offering it work.
 * Saying so is the node's own job: nobody outside it can tell the difference.
 */

/** Fresh state for one node process. Exported so a suite can drive it without a running node. */
export function newState({ startedAt = new Date().toISOString() } = {}) {
  return {
    startedAt,
    lastTickAt: null,
    lastPlatformOk: null,
    lastPlatformError: null,
    browserOk: null,
    browserCheckedAt: null,
    running: new Map(),
    delivered: [],
    executor: null,
  }
}

/**
 * The node's verdict on itself. Pure: same state and clock, same answer.
 *
 * `heartbeatSeconds * 3` is not a tuned number — it is the platform's OWN definition of offline
 * (three missed heartbeats), applied by the node to itself so that both sides reach the same
 * conclusion at the same moment instead of the node insisting it is fine for another two minutes.
 */
export function health(state, { heartbeatSeconds = 30, now = Date.now() } = {}) {
  const reasons = []
  const tickAge = state.lastTickAt ? (now - Date.parse(state.lastTickAt)) / 1000 : Infinity
  if (tickAge > heartbeatSeconds * 3) {
    reasons.push(state.lastTickAt ? `worker loop last ticked ${Math.round(tickAge)}s ago` : 'worker loop has never ticked')
  }
  if (state.lastPlatformOk === false) reasons.push(`platform unreachable: ${state.lastPlatformError ?? 'unknown'}`)
  if (state.browserOk === false) reasons.push('browser will not launch')
  const ok = reasons.length === 0
  return {
    ok,
    // 'offline' is a REPORT, not a state the node enters: it keeps trying, and says meanwhile that
    // it must not be given work. An idle claim from a node that cannot claim is the lie being fixed.
    status: ok ? (state.running.size ? 'working' : 'idle') : 'offline',
    reasons,
    executor: state.executor,
    started_at: state.startedAt,
    last_tick_at: state.lastTickAt,
    running: [...state.running.entries()].map(([slot_id, r]) => ({ slot_id, ...r })),
    delivered: state.delivered.slice(-10),
  }
}
