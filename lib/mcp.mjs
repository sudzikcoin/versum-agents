/**
 * LaunchLoop MCP client for agents.
 *
 * Talks to the marketplace ONLY through the MCP tool surface, via the official
 * stdio proxy (@suverselabs/launchloop-mcp). Until the package is on npm we
 * spawn it from the LaunchLoop checkout (LAUNCHLOOP_MCP_BIN); afterwards the
 * default becomes `npx -y @suverselabs/launchloop-mcp`.
 */
import { existsSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export class LaunchLoopError extends Error {
  constructor(code, message, details) { super(message ?? code); this.code = code; this.details = details }
}

/** Parse a tool result: prefer structuredContent, else the first text block as JSON. Throws LaunchLoopError on isError. */
function unwrap(res) {
  let body = res.structuredContent
  if (body === undefined) {
    const text = (res.content ?? []).find((c) => c.type === 'text')?.text
    try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  }
  if (res.isError) {
    const err = body?.error ?? body ?? {}
    throw new LaunchLoopError(err.code ?? 'tool_error', err.message ?? JSON.stringify(body).slice(0, 300), err.details)
  }
  return body
}

export async function connect({ key = process.env.LAUNCHLOOP_API_KEY, url = process.env.LAUNCHLOOP_MCP_URL ?? 'https://launchloop.suverse.io/mcp', bin = process.env.LAUNCHLOOP_MCP_BIN, log = () => {} } = {}) {
  if (!key) throw new Error('LAUNCHLOOP_API_KEY is required (issued by the owner at /dashboard/agents)')
  let command, args
  if (bin && existsSync(bin)) { command = process.execPath; args = [bin] }
  else { command = 'npx'; args = ['-y', '@suverselabs/launchloop-mcp'] }
  const transport = new StdioClientTransport({ command, args, env: { ...process.env, LAUNCHLOOP_API_KEY: key, LAUNCHLOOP_MCP_URL: url }, stderr: 'pipe' })
  const client = new Client({ name: 'launchloop-qa-agent', version: '0.1.0' })
  await client.connect(transport)
  transport.stderr?.on('data', (d) => log(`[mcp] ${String(d).trim()}`))
  const call = async (name, args = {}) => unwrap(await client.callTool({ name, arguments: args }))
  return {
    client,
    call,
    profile: () => call('my_profile'),
    listTasks: (o = {}) => call('list_tasks', { eligible_only: true, limit: 50, ...o }),
    getTask: (task_id) => call('get_task', { task_id }),
    takeTrial: (task_id) => call('take_trial', { task_id }),
    submitTrial: (trial_id, result) => call('submit_trial', { trial_id, result }),
    takeTask: (task_id) => call('take_task', { task_id }),
    getSlot: (slot_id) => call('get_slot', { slot_id }),
    submitDeliverable: (slot_id, kind, payload) => call('submit_deliverable', { slot_id, kind, payload }),
    notifications: (o = {}) => call('my_notifications', { unread_only: true, limit: 50, mark_read: true, ...o }),
    close: () => client.close(),
  }
}
