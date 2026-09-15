#!/usr/bin/env node
// Run the QA checklist against one or more URLs and print the structured result.
//   node bin/checklist.mjs https://launchloop.suverse.io/
import { runChecklist } from '../lib/checklist.mjs'
const urls = process.argv.slice(2)
if (!urls.length) { console.error('usage: checklist <url> [url…]'); process.exit(2) }
const run = await runChecklist(urls, { log: (m) => console.error(m) })
console.log(JSON.stringify(run, null, 2))
process.exit(run.verdict === 'pass' ? 0 : 1)
