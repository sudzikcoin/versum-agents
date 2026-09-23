/**
 * W10 — the six passes the owner's plan describes, run against a real site.
 *
 * The reference checklist (lib/checklist.mjs) does ONE generic pass per URL and returns a step list.
 * That is not what was bought here. The plan says six passes — home and navigation, public forms,
 * sign-up and sign-in, the product's key journey, the phone viewport, and a crawl for 404/5xx,
 * console errors and failed requests — at 1440 on desktop and 390×844 on the phone, and the
 * deliverable is a DEFECT TABLE: one row per defect, with steps to reproduce, expected, actual,
 * priority and a screenshot.
 *
 * Two rules from the task text are structural here, not stylistic:
 *   - cosmetic and functional defects are not mixed (`priority` carries `cosmetic` on its own, and
 *     `kind` says which family a row belongs to);
 *   - a pass that found nothing must say WHAT IT CHECKED and considered working — an empty pass
 *     with no account of itself is indistinguishable from a pass that never ran.
 *
 * Every defect is discovered by observation, never asserted from a rule the node made up: a 404 is
 * a response code, an overflow is a measured pixel count, a form that accepts an invalid e-mail is
 * a form that was actually submitted and did not complain.
 */
import { chromium, devices } from 'playwright'
import { capture, shotName } from './screenshot.mjs'

export const DESKTOP = { width: 1440, height: 900 }
export const PHONE = { width: 390, height: 844 }
/** The columns the client was promised, in order. The deliverable is built from these names. */
export const COLUMNS = ['URL/раздел', 'дефект', 'шаги воспроизведения', 'ожидаемое', 'фактическое', 'приоритет', 'скриншот']
export const PRIORITIES = ['blocker', 'major', 'minor', 'cosmetic']

const trunc = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''))

/**
 * One identity per page. `https://PingPoint.suverse.io` and `https://pingpoint.suverse.io/` are the
 * same page; without this the client is handed the same defect twice under two spellings and has to
 * work out that it is one bug. Host is lowercased (it is case-insensitive), a bare trailing slash
 * is dropped, and the fragment goes — a #anchor is a position on a page, not another page.
 */
export function pageKey(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '')
    return u.pathname === '/' ? `${u.origin}/${u.search}` : u.toString()
  } catch { return String(url) }
}

/** Distinct pages, in the order they were first seen. */
const uniquePages = (urls) => {
  const seen = new Map()
  for (const u of urls) { const k = pageKey(u); if (!seen.has(k)) seen.set(k, u) }
  return [...seen.values()]
}

/** One row of the defect table, in the client's own column names. */
function defect({ where, what, steps, expected, actual, priority, kind, shot }) {
  return {
    'URL/раздел': trunc(where, 200),
    'дефект': trunc(what, 300),
    'шаги воспроизведения': trunc(steps, 500),
    'ожидаемое': trunc(expected, 300),
    'фактическое': trunc(actual, 400),
    'приоритет': PRIORITIES.includes(priority) ? priority : 'minor',
    'скриншот': shot ?? '',
    kind: kind ?? (priority === 'cosmetic' ? 'cosmetic' : 'functional'),
  }
}

/** A page with its console + network watchers already attached. */
async function openPage(ctx, { onError, onFailed }) {
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') onError(trunc(m.text(), 200)) })
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? 'failed'
    if (!/ERR_ABORTED/.test(why)) onFailed({ url: r.url(), why, status: null })
  })
  page.on('response', (r) => {
    if (r.status() >= 400 && r.request().resourceType() !== 'image') onFailed({ url: r.url(), why: null, status: r.status() })
  })
  return page
}

/**
 * Run the six passes.
 *
 * `report` is called before and after every pass, so the client's thread moves while this runs
 * rather than at the end. `shoot` uploads one screenshot and returns its artefact id; a refused
 * upload costs that picture and nothing else, because evidence is not worth losing the run over.
 */
export async function runSiteQa(baseUrl, { report = async () => {}, shoot = async () => null, log = () => {}, maxLinks = 25 } = {}) {
  // Every picture this run produced, grouped by the pass that produced it. The client's table names
  // the screenshot in words and the run card carries the image under the right pass — a bare id in
  // a cell called "ссылка на скриншот" is not a link and is no use to anybody.
  const shotsByPass = new Map()
  let currentPass = 0
  const take = async (page, caption, fileName) => {
    const id = await shoot(page, caption, fileName)
    if (!id) { log(`  no picture for: ${caption.slice(0, 70)}`); return { id: null, ref: 'снять не удалось — страница не отрисовалась целиком' } }
    const list = shotsByPass.get(currentPass) ?? []
    list.push(id); shotsByPass.set(currentPass, list)
    return { id, ref: `шаг ${currentPass}: ${caption}` }
  }
  const shotsOf = (n) => shotsByPass.get(n) ?? []
  const browser = await chromium.launch({ headless: true })
  const defects = []
  const notes = []            // what was checked and found working, per pass
  const uncovered = []        // what this run could NOT reach, said out loud
  const origin = new URL(baseUrl).origin
  const consoleErrors = [], failedRequests = []
  const onError = (t) => consoleErrors.push(t)
  const onFailed = (f) => failedRequests.push(f)
  const add = (d) => { defects.push(d); return d }
  const OF = 6

  const ctx = await browser.newContext({ ...devices['Desktop Chrome'], viewport: DESKTOP, ignoreHTTPSErrors: false })
  try {
    // ── pass 1 ─ home page, all navigation, footer links ─────────────────────────────────────────
    currentPass = 1
    await report({ pass: 1, of: OF, title: 'Главная, навигация и футер', state: 'running', url: baseUrl })
    let page = await openPage(ctx, { onError, onFailed })
    let before = defects.length
    let navLinks = []
    try {
      const resp = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      const status = resp?.status() ?? 0
      if (status >= 400) add(defect({ where: baseUrl, what: `Главная отвечает HTTP ${status}`, steps: `Открыть ${baseUrl}`, expected: 'HTTP 200', actual: `HTTP ${status}`, priority: 'blocker' }))
      await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {})
      const title = (await page.title()).trim()
      if (!title) add(defect({ where: baseUrl, what: 'У главной страницы нет <title>', steps: `Открыть ${baseUrl}, посмотреть заголовок вкладки`, expected: 'Непустой <title>', actual: 'Пустой заголовок вкладки', priority: 'major' }))

      const links = await page.$$eval('a[href]', (as) => as.map((a) => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 60), inFooter: !!a.closest('footer') })))
      navLinks = links.filter((l) => l.href.startsWith(origin) && !/^mailto:|^tel:|#$/.test(l.href))
      const footer = navLinks.filter((l) => l.inFooter)
      const checkable = uniquePages(navLinks.filter((l) => !l.href.includes('#')).map((l) => l.href)).slice(0, maxLinks)
      for (const l of checkable.map((href) => navLinks.find((x) => x.href === href))) {
        const r = await page.request.get(l.href, { timeout: 15000, maxRedirects: 5 }).catch(() => null)
        const st = r?.status() ?? 0
        if (!r) add(defect({ where: l.href, what: `Ссылка «${l.text || l.href}» не открывается`, steps: `Открыть ${baseUrl}, нажать «${l.text || l.href}»`, expected: 'Страница открывается', actual: 'Запрос не завершился', priority: l.inFooter ? 'minor' : 'major' }))
        else if (st >= 400) add(defect({ where: l.href, what: `Ссылка «${l.text || l.href}» ведёт на HTTP ${st}`, steps: `Открыть ${baseUrl}, нажать «${l.text || l.href}»`, expected: 'HTTP 200', actual: `HTTP ${st}`, priority: st >= 500 ? 'major' : l.inFooter ? 'minor' : 'major' }))
      }
      await take(page, `${baseUrl} — главная, как она загрузилась${title ? `, «${trunc(title, 60)}»` : ''}`, shotName(baseUrl))
      notes.push(`Главная (${baseUrl}) открывается, заголовок «${trunc(title, 60)}». Проверено ссылок: ${checkable.length}, из них в футере ${footer.length}.`)
      await report({ pass: 1, of: OF, title: 'Главная, навигация и футер', state: 'done', url: baseUrl, defects: defects.length - before, checked: notes[notes.length - 1], artefact_ids: shotsOf(1) })
    } catch (e) {
      add(defect({ where: baseUrl, what: 'Главная не загрузилась', steps: `Открыть ${baseUrl}`, expected: 'Страница открывается', actual: trunc(e.message, 200), priority: 'blocker' }))
      await report({ pass: 1, of: OF, title: 'Главная, навигация и футер', state: 'failed', url: baseUrl, defects: defects.length - before, note: trunc(e.message, 200) })
    }

    // ── pass 2 ─ every public form: empty, bad e-mail, overlong, double submit ───────────────────
    currentPass = 2
    await report({ pass: 2, of: OF, title: 'Публичные формы и их валидация', state: 'running' })
    before = defects.length
    const formPages = uniquePages([baseUrl, ...navLinks.map((l) => l.href)]).slice(0, 8)
    let formsSeen = 0
    for (const url of formPages) {
      const p = await openPage(ctx, { onError, onFailed })
      try {
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        const forms = await p.$$('form')
        for (const [i, form] of forms.entries()) {
          const inputs = await form.$$('input:not([type=hidden]):not([type=submit]), textarea')
          const submit = await form.$('button[type=submit], input[type=submit], button:not([type])')
          if (!inputs.length || !submit) continue
          formsSeen++
          const label = `форма №${i + 1} на ${url}`

          // (a) empty submit must be refused
          await submit.click({ timeout: 5000 }).catch(() => {})
          await p.waitForTimeout(700)
          let complained = await formComplained(p, form)
          if (!complained) add(defect({ where: url, what: `Пустая ${label} отправляется без ошибки`, steps: `Открыть ${url}, ничего не заполнять, нажать кнопку отправки`, expected: 'Форма показывает ошибку и не отправляется', actual: 'Ни одного сообщения об ошибке', priority: 'major' }))

          // (b) an invalid e-mail must be refused
          const email = await form.$('input[type=email], input[name*=mail i]')
          if (email) {
            await email.fill('not-an-email').catch(() => {})
            await submit.click({ timeout: 5000 }).catch(() => {})
            await p.waitForTimeout(700)
            if (!(await formComplained(p, form))) add(defect({ where: url, what: `${label}: принимает некорректный e-mail`, steps: `Открыть ${url}, ввести в поле e-mail «not-an-email», нажать отправку`, expected: 'Ошибка «некорректный e-mail», форма не отправляется', actual: 'Форма приняла значение без ошибки', priority: 'major' }))
          }

          // (c) an overlong value must not break the page
          const text = await form.$('input[type=text], input:not([type]), textarea')
          if (text) {
            await text.fill('A'.repeat(5000)).catch(() => {})
            await submit.click({ timeout: 5000 }).catch(() => {})
            await p.waitForTimeout(700)
            const broke = failedRequests.some((f) => f.status >= 500)
            if (broke) add(defect({ where: url, what: `${label}: значение в 5000 символов роняет сервер`, steps: `Открыть ${url}, вставить 5000 символов «A» в первое текстовое поле, отправить`, expected: 'Ошибка валидации длины', actual: 'Ответ 5xx от сервера', priority: 'blocker' }))
          }

          // (d) double submit must not fire twice
          const sent = []
          const spy = (r) => { if (['POST', 'PUT'].includes(r.request().method())) sent.push(r.url()) }
          p.on('response', spy)
          await submit.click({ timeout: 5000 }).catch(() => {})
          await submit.click({ timeout: 5000 }).catch(() => {})
          await p.waitForTimeout(1000)
          p.off('response', spy)
          if (sent.length > 1) add(defect({ where: url, what: `${label}: двойное нажатие отправляет форму дважды`, steps: `Открыть ${url}, заполнить форму, быстро нажать кнопку отправки два раза`, expected: 'Кнопка блокируется после первого нажатия, запрос уходит один раз', actual: `Ушло запросов: ${sent.length}`, priority: 'major' }))
        }
      } catch { /* a page that will not open is pass 6's finding, not this pass's */ }
      await p.close()
    }
    notes.push(formsSeen ? `Публичных форм проверено: ${formsSeen} (пустая отправка, некорректный e-mail, значение в 5000 символов, двойное нажатие).` : 'Публичных форм с полями и кнопкой отправки на доступных страницах не найдено.')
    if (!formsSeen) uncovered.push('Валидация форм — на публичных страницах форм не найдено.')
    await report({ pass: 2, of: OF, title: 'Публичные формы и их валидация', state: formsSeen ? 'done' : 'skipped', defects: defects.length - before, checked: notes[notes.length - 1] })

    // ── pass 3 ─ sign-up and sign-in ────────────────────────────────────────────────────────────
    currentPass = 3
    await report({ pass: 3, of: OF, title: 'Регистрация и вход', state: 'running' })
    before = defects.length
    // By ADDRESS first. Matching on link TEXT as well picked the site logo, whose href is "/", and
    // pass 3 then reported the home page as the sign-in screen — a confident, wrong answer.
    const AUTH_PATH = /\/(sign[-_ ]?up|sign[-_ ]?in|signup|signin|log[-_ ]?in|login|register|auth|регистрация|вход)(\/|$|\?)/i
    const authUrl = navLinks.find((l) => AUTH_PATH.test(new URL(l.href).pathname))?.href
      ?? navLinks.find((l) => /^(sign up|sign in|log ?in|register|войти|вход|регистрация)$/i.test(l.text.trim()))?.href
    let authState = 'done'
    if (!authUrl) {
      authState = 'skipped'
      notes.push('Ссылок на регистрацию или вход на публичных страницах не найдено — раздел не проверялся.')
      uncovered.push('Регистрация и вход — на сайте не найдено публичной ссылки на них.')
    } else {
      const p = await openPage(ctx, { onError, onFailed })
      try {
        const r = await p.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
        if ((r?.status() ?? 0) >= 400) add(defect({ where: authUrl, what: `Страница входа отвечает HTTP ${r.status()}`, steps: `Открыть ${authUrl}`, expected: 'HTTP 200', actual: `HTTP ${r.status()}`, priority: 'blocker' }))
        const emailOnly = await p.$('input[type=email], input[name*=mail i]')
        const password = await p.$('input[type=password]')
        await take(p, `${authUrl} — экран входа/регистрации`, shotName(authUrl))
        if (emailOnly && !password) {
          authState = 'skipped'
          notes.push(`Вход на ${authUrl} — по ссылке из письма (magic link): пароля нет, дальше без доступа к почте не пройти.`)
          uncovered.push('Регистрация и вход дальше первого экрана — требуется подтверждение по e-mail, тестовой почты не предоставлено.')
        } else {
          notes.push(`Экран ${authUrl} открывается, поля на месте${password ? ' (e-mail + пароль)' : ''}. Создание живого аккаунта не выполнялось — это запись в чужую базу.`)
          uncovered.push('Сценарии внутри аккаунта — тестовый логин не предоставлен.')
        }
        await report({ pass: 3, of: OF, title: 'Регистрация и вход', state: authState, url: authUrl, defects: defects.length - before, checked: notes[notes.length - 1], artefact_ids: shotsOf(3) })
      } catch (e) {
        add(defect({ where: authUrl, what: 'Страница входа не загрузилась', steps: `Открыть ${authUrl}`, expected: 'Страница открывается', actual: trunc(e.message, 200), priority: 'major' }))
      }
      await p.close()
    }
    if (!authUrl) await report({ pass: 3, of: OF, title: 'Регистрация и вход', state: 'skipped', defects: 0, note: notes[notes.length - 1] })

    // ── pass 4 ─ the product's key journey, first screen to result ───────────────────────────────
    currentPass = 4
    await report({ pass: 4, of: OF, title: 'Ключевой сценарий продукта', state: 'running', url: baseUrl })
    before = defects.length
    const p4 = await openPage(ctx, { onError, onFailed })
    let journey = 'skipped'
    try {
      await p4.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
      const cta = p4.locator('a[href], button').filter({ hasText: /sign up|get started|try|start|demo|track|начать|попробовать|отследить|найти/i }).first()
      if (await cta.count()) {
        const label = trunc((await cta.innerText().catch(() => '')).trim(), 40)
        const urlBefore = p4.url()
        await cta.click({ timeout: 10000 }).catch(() => {})
        await p4.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
        await p4.waitForTimeout(1200)
        const moved = p4.url() !== urlBefore
        const changed = moved || await p4.evaluate(() => document.body.innerText.length).catch(() => 0)
        const cta4 = await take(p4, `Главный сценарий: что показала кнопка «${label}»`, shotName(p4.url() + '-cta'))
        if (!moved && !changed) add(defect({ where: urlBefore, what: `Главная кнопка «${label}» ничего не делает`, steps: `Открыть ${baseUrl}, нажать «${label}»`, expected: 'Переход к следующему шагу сценария', actual: 'Страница не изменилась и не перешла', priority: 'blocker', shot: cta4.ref }))
        else { journey = 'done'; notes.push(`Ключевой сценарий: с главной по кнопке «${label}» пользователь попадает на ${trunc(p4.url(), 120)}.`) }
        await report({ pass: 4, of: OF, title: 'Ключевой сценарий продукта', state: journey === 'done' ? 'done' : 'failed', url: p4.url(), defects: defects.length - before, checked: notes[notes.length - 1] ?? null, artefact_ids: shotsOf(4) })
      } else {
        notes.push('Главного действия на первом экране не нашлось — ни одной заметной кнопки начала сценария.')
        uncovered.push('Сквозной сценарий — на первом экране нет очевидной точки входа.')
        add(defect({ where: baseUrl, what: 'На первом экране нет очевидного главного действия', steps: `Открыть ${baseUrl}, искать кнопку начала работы`, expected: 'Заметная кнопка, с которой начинается сценарий', actual: 'Ни одной кнопки начала сценария не найдено', priority: 'major' }))
        await report({ pass: 4, of: OF, title: 'Ключевой сценарий продукта', state: 'failed', url: baseUrl, defects: defects.length - before, note: notes[notes.length - 1] })
      }
    } catch (e) {
      await report({ pass: 4, of: OF, title: 'Ключевой сценарий продукта', state: 'failed', defects: defects.length - before, note: trunc(e.message, 200) })
    }
    await p4.close()

    // ── pass 5 ─ the phone viewport ─────────────────────────────────────────────────────────────
    currentPass = 5
    await report({ pass: 5, of: OF, title: 'Мобильный вьюпорт 390×844', state: 'running' })
    before = defects.length
    const mob = await browser.newContext({ ...devices['iPhone 13'], viewport: PHONE })
    const pm = await openPage(mob, { onError, onFailed })
    const phonePages = uniquePages([baseUrl, ...navLinks.map((l) => l.href)]).slice(0, 5)
    let tapTotal = 0, tapSmall = 0
    for (const url of phonePages) {
      try {
        await pm.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await pm.waitForTimeout(600)
        const overflow = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        if (overflow > 2) {
          const widest = await pm.evaluate(() => {
            let worst = { tag: '', w: 0 }
            for (const el of Array.from(document.querySelectorAll('body *'))) {
              const r = el.getBoundingClientRect()
              if (r.right > worst.w) worst = { tag: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/)[0] : ''), w: Math.round(r.right) }
            }
            return worst
          })
          const over = await take(pm, `${url} — горизонтальное переполнение ${overflow}px на 390px`, shotName(url + '-390'))
          add(defect({ where: url, what: `Горизонтальное переполнение ${overflow}px на ширине 390px`, steps: `Открыть ${url} при ширине окна 390px и прокрутить вбок`, expected: 'Страница помещается по ширине, горизонтальной прокрутки нет', actual: `Прокрутка на ${overflow}px, дальше всех уходит <${widest.tag}> до ${widest.w}px`, priority: 'major', shot: over.ref }))
        }
        const taps = await pm.evaluate(() => Array.from(document.querySelectorAll('a[href], button, [role=button], input[type=submit]'))
          .map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), t: (el.textContent || '').trim().slice(0, 40), visible: r.width > 0 && r.height > 0 } })
          .filter((x) => x.visible))
        tapTotal += taps.length
        const small = taps.filter((t) => t.h < 44 || t.w < 44)
        tapSmall += small.length
        if (small.length) {
          const worst = small.sort((a, b) => a.h * a.w - b.h * b.w)[0]
          // A tap target that is too small is a VISUAL defect, and the task is explicit that a
          // visual defect handed over without a picture is to be rejected. If this page already got
          // a shot for its overflow, that same picture shows the tap targets too — one page, one
          // picture, rather than two near-identical screenshots of the same screen.
          const tapShot = shotsOf(5).length && overflow > 2
            ? { ref: `шаг 5: ${url} — тот же экран при 390px` }
            : await take(pm, `${url} — тап-зоны при 390px, самая мелкая «${worst.t || 'без текста'}» ${worst.w}×${worst.h}px`, shotName(url + '-taps'))
          add(defect({ where: url, what: `Тап-зоны меньше 44×44px: ${small.length} из ${taps.length}`, steps: `Открыть ${url} при ширине 390px, попробовать нажать «${worst.t || 'элемент'}» пальцем`, expected: 'Нажимаемые элементы не меньше 44×44px (рекомендация Apple HIG)', actual: `Самый мелкий — «${worst.t || 'без текста'}», ${worst.w}×${worst.h}px`, priority: 'minor', shot: tapShot.ref }))
        }
        const menu = await pm.$('[aria-label*=menu i], button[class*=burger i], button[class*=menu i], [data-testid*=menu i]')
        if (menu) {
          const openedBefore = await pm.evaluate(() => document.body.innerText.length)
          await menu.click({ timeout: 5000 }).catch(() => {})
          await pm.waitForTimeout(600)
          const after = await pm.evaluate(() => document.body.innerText.length)
          if (after === openedBefore) add(defect({ where: url, what: 'Кнопка мобильного меню не открывает меню', steps: `Открыть ${url} при ширине 390px, нажать кнопку меню`, expected: 'Меню раскрывается', actual: 'Содержимое страницы не изменилось', priority: 'major' }))
        }
      } catch { /* unreachable pages belong to pass 6 */ }
    }
    notes.push(`Мобильный вид (390×844) проверен на ${phonePages.length} страниц(ах): переполнение по ширине, размеры тап-зон (${tapTotal} элементов, мельче 44px — ${tapSmall}), кнопка меню.`)
    await report({ pass: 5, of: OF, title: 'Мобильный вьюпорт 390×844', state: 'done', defects: defects.length - before, checked: notes[notes.length - 1], artefact_ids: shotsOf(5) })
    await pm.close(); await mob.close()

    // ── pass 6 ─ crawl for 404/5xx, console errors, failed requests ──────────────────────────────
    currentPass = 6
    await report({ pass: 6, of: OF, title: 'Обход ссылок, ошибки консоли и сети', state: 'running' })
    before = defects.length
    const seen = new Set(), queue = [baseUrl]   // seen holds pageKey()s, not raw hrefs
    const bad = []
    const pc = await openPage(ctx, { onError, onFailed })
    while (queue.length && seen.size < maxLinks) {
      const url = queue.shift()
      if (seen.has(pageKey(url))) continue
      seen.add(pageKey(url))
      const r = await pc.request.get(url, { timeout: 15000, maxRedirects: 5 }).catch(() => null)
      const st = r?.status() ?? 0
      if (!r || st >= 400) { bad.push({ url, st }); continue }
      if (seen.size < maxLinks && /text\/html/.test(r.headers()['content-type'] ?? '')) {
        try {
          await pc.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
          await pc.waitForTimeout(400)
          const hrefs = await pc.$$eval('a[href]', (as) => as.map((a) => a.href))
          for (const h of hrefs) if (h.startsWith(origin) && !/#|mailto:|tel:/.test(h) && !seen.has(pageKey(h))) queue.push(h)
        } catch { /* the status is what this pass is about */ }
      }
    }
    for (const b of bad) add(defect({ where: b.url, what: b.st ? `Страница отвечает HTTP ${b.st}` : 'Страница не отвечает', steps: `Перейти по внутренней ссылке ${b.url}`, expected: 'HTTP 200', actual: b.st ? `HTTP ${b.st}` : 'Запрос не завершился', priority: b.st >= 500 || !b.st ? 'major' : 'minor' }))
    const uniqErrors = Array.from(new Set(consoleErrors))
    if (uniqErrors.length) add(defect({ where: origin, what: `Ошибки в консоли браузера: ${uniqErrors.length} различных`, steps: `Открыть ${baseUrl}, открыть консоль разработчика, пройти по разделам`, expected: 'Консоль чистая', actual: uniqErrors.slice(0, 3).join(' | '), priority: 'minor' }))
    const uniqFailed = Array.from(new Map(failedRequests.map((f) => [f.url, f])).values()).filter((f) => f.status >= 400 || f.why)
    if (uniqFailed.length) add(defect({ where: origin, what: `Неуспешные сетевые запросы: ${uniqFailed.length}`, steps: `Открыть ${baseUrl}, вкладка Network, пройти по разделам`, expected: 'Все запросы страницы успешны', actual: uniqFailed.slice(0, 3).map((f) => `${f.status ?? f.why} ${trunc(f.url, 90)}`).join(' | '), priority: 'minor' }))
    await pc.close()
    notes.push(`Обход: проверено внутренних адресов ${seen.size}, недоступных ${bad.length}. Ошибок консоли (различных) ${uniqErrors.length}, неуспешных запросов ${uniqFailed.length}.`)
    await report({ pass: 6, of: OF, title: 'Обход ссылок, ошибки консоли и сети', state: 'done', defects: defects.length - before, checked: notes[notes.length - 1] })
    log(`crawled ${seen.size} url(s)`)
  } finally {
    await ctx.close().catch(() => {})
    await browser.close().catch(() => {})
  }

  // The same defect on the same page, found by two passes, is ONE defect. Keyed on the page
  // identity plus the defect text, so two different problems on one page both survive.
  const byKey = new Map()
  for (const d of defects) {
    const k = `${pageKey(d['URL/раздел'])}|${d['дефект']}`
    if (!byKey.has(k)) byKey.set(k, d)
  }
  return { defects: [...byKey.values()], notes, uncovered, columns: COLUMNS, passes: OF }
}

/** Did the form actually object? A native :invalid, an aria-invalid, or a visible error node. */
async function formComplained(page, form) {
  try {
    const native = await form.evaluate((f) => !f.checkValidity?.() || !!f.querySelector(':invalid'))
    if (native) return true
    return await form.evaluate((f) => {
      if (f.querySelector('[aria-invalid="true"]')) return true
      const t = (f.innerText || '').toLowerCase()
      return /required|invalid|обязат|некоррект|ошибк|заполните|неверн/.test(t)
    })
  } catch { return false }
}
