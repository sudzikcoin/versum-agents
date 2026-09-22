/**
 * E6 — what the node SAW.
 *
 * Every browser step ends with a picture of the page it just checked, because "the CTA is not
 * clickable" is an opinion until the client can look at it. The platform shows it under that step
 * to the client of that step and to nobody else.
 *
 * Shape: JPEG, quality 70, full page unless the step names an element. A full-page JPEG of an
 * ordinary page is 150-400 KB; the platform's cap is 2 MB per image, so anything larger is
 * re-shot as the viewport alone rather than dropped — a smaller true picture beats no picture.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const QUALITY = 70

/**
 * @param page      Playwright page, already on the URL
 * @param opts.selector  CSS selector when the step names one element; otherwise the whole page
 * @param opts.caption   one line, in the client's words, saying what this shows
 * @returns {Promise<{file_name, content_type, width, height, caption, size_bytes, data_base64}|null>}
 */
export async function capture(page, { selector = null, caption = '', fileName = 'page.jpg' } = {}) {
  const shoot = async (o) => {
    try {
      if (selector) {
        const el = page.locator(selector).first()
        if (!(await el.count())) return null
        return await el.screenshot({ type: 'jpeg', quality: QUALITY, timeout: 15000 })
      }
      return await page.screenshot({ type: 'jpeg', quality: o.quality ?? QUALITY, fullPage: o.fullPage !== false, timeout: 20000 })
    } catch { return null }
  }
  let buf = await shoot({ fullPage: true })
  // Two ways a full-page shot comes back useless, and BOTH fall back to the viewport:
  //   - over the platform's cap. A smaller true picture beats no picture.
  //   - EMPTY. Past a few thousand pixels of height Chromium returns a zero-length buffer instead
  //     of throwing — a 23381px docs page did exactly that, and because only the oversized case
  //     was handled, the one visual defect on it was handed to the client with no evidence at all.
  if (buf && (buf.length === 0 || buf.length > MAX_IMAGE_BYTES)) buf = await shoot({ fullPage: false, quality: 50 })
  if (!buf || !buf.length || buf.length > MAX_IMAGE_BYTES) return null
  const size = page.viewportSize() ?? { width: 0, height: 0 }
  return {
    file_name: fileName.replace(/[^\w.\-]+/g, '_').slice(0, 60) || 'page.jpg',
    content_type: 'image/jpeg',
    width: size.width, height: size.height,
    caption: caption.slice(0, 200),
    size_bytes: buf.length,
    data_base64: buf.toString('base64'),
  }
}

/** A file name from a URL: launchloop-suverse-io-dashboard.jpg */
export function shotName(url) {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) + '.jpg'
  } catch { return 'page.jpg' }
}
