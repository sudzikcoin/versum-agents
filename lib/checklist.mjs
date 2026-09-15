/**
 * Playwright QA checklist — the "work" the reference agent does.
 *
 * Given one or more URLs it opens each in headless Chromium and records a step
 * per check: load (HTTP status, load time), title present, no console errors,
 * no failed sub-requests, links resolve (same-origin sample), primary CTA
 * clickable, viewport renders on phone width. Every step is
 * { url, action, result, ok, ms?, detail? }; the verdict is 'pass' when every
 * step passed. Output shape follows the demo tasks' structured schema.
 */
import { chromium, devices } from 'playwright'

const now = () => Date.now()

export async function runChecklist(urls, { timeoutMs = 20000, maxLinks = 8, log = () => {} } = {}) {
  const browser = await chromium.launch({ headless: true })
  const steps = []
  const startedAt = new Date().toISOString()
  try {
    for (const url of urls) {
      const ctx = await browser.newContext({ ...devices['Desktop Chrome'], ignoreHTTPSErrors: false })
      const page = await ctx.newPage()
      const consoleErrors = [], failedRequests = []
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
      // ERR_ABORTED = the page cancelled its own request (Next.js RSC prefetch, navigation) — not a failure
      page.on('requestfailed', (r) => { const why = r.failure()?.errorText ?? 'failed'; if (!/ERR_ABORTED/.test(why)) failedRequests.push(`${r.method()} ${r.url().slice(0, 120)} — ${why}`) })
      page.on('response', (r) => { if (r.status() >= 400 && r.request().resourceType() !== 'image') failedRequests.push(`${r.status()} ${r.url().slice(0, 120)}`) })

      // 1. load
      let t0 = now(), resp = null
      try {
        resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        const ms = now() - t0, status = resp?.status() ?? 0
        steps.push({ url, action: 'load', ok: status >= 200 && status < 400, result: `HTTP ${status} in ${ms} ms`, ms })
      } catch (e) {
        steps.push({ url, action: 'load', ok: false, result: `navigation failed: ${String(e.message).split('\n')[0].slice(0, 160)}` })
        await ctx.close(); continue
      }
      log(`  ${url} loaded`)

      // 2. title
      const title = (await page.title()).trim()
      steps.push({ url, action: 'title', ok: title.length > 0, result: title ? `"${title.slice(0, 80)}"` : 'no <title>' })

      // 3. console errors / failed requests (after settle)
      await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {})
      await page.waitForTimeout(500)
      steps.push({ url, action: 'console_errors', ok: consoleErrors.length === 0, result: consoleErrors.length ? `${consoleErrors.length} console error(s)` : 'none', detail: consoleErrors.slice(0, 5) })
      steps.push({ url, action: 'failed_requests', ok: failedRequests.length === 0, result: failedRequests.length ? `${failedRequests.length} failed/4xx+ request(s)` : 'none', detail: failedRequests.slice(0, 5) })

      // 4. links (same-origin sample, HEAD/GET status)
      const origin = new URL(url).origin
      const hrefs = Array.from(new Set((await page.$$eval('a[href]', (as) => as.map((a) => a.href))).filter((h) => h.startsWith(origin) && !/#|mailto:|tel:/.test(h)))).slice(0, maxLinks)
      const broken = []
      for (const h of hrefs) {
        try { const r = await page.request.get(h, { timeout: 10000, maxRedirects: 5 }); if (r.status() >= 400) broken.push(`${r.status()} ${h}`) } catch (e) { broken.push(`ERR ${h}`) }
      }
      steps.push({ url, action: 'links', ok: broken.length === 0, result: `${hrefs.length} same-origin link(s) checked, ${broken.length} broken`, detail: broken })

      // 5. primary CTA present + clickable
      const cta = page.locator('a[href], button').filter({ hasText: /sign up|log in|get started|start|try|browse|open|post|take|deliver/i }).first()
      const ctaCount = await cta.count()
      let ctaText = ''
      if (ctaCount) { ctaText = (await cta.innerText().catch(() => '')).trim().slice(0, 40); const enabled = await cta.isEnabled().catch(() => false); steps.push({ url, action: 'primary_cta', ok: enabled, result: enabled ? `"${ctaText}" clickable` : `"${ctaText}" not enabled` }) }
      else steps.push({ url, action: 'primary_cta', ok: false, result: 'no obvious call-to-action found' })

      // 6. phone viewport renders without horizontal scroll
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(300)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      steps.push({ url, action: 'mobile_layout', ok: overflow <= 2, result: overflow <= 2 ? 'no horizontal overflow at 390px' : `${overflow}px horizontal overflow at 390px` })

      await ctx.close()
    }
  } finally {
    await browser.close()
  }
  const failed = steps.filter((s) => !s.ok)
  return { steps, verdict: failed.length === 0 ? 'pass' : 'fail', checked_at: startedAt, summary: `${steps.length} checks over ${urls.length} URL(s), ${failed.length} failed`, failed: failed.map((s) => `${s.action}@${s.url}: ${s.result}`) }
}
