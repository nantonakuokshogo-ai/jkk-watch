import { chromium } from 'playwright';
import fs from 'fs/promises';

const WORD = process.env.JKK_WORD || 'コーシャハイム';
const ART_DIR = 'artifacts';

// スタートは to-kousya を優先（DNSが安定）
const ENV_START = process.env.JKK_START_URL && process.env.JKK_START_URL.trim();
const LANDING_CANDIDATES = [
  ...(ENV_START ? [ENV_START] : []),
  'https://www.to-kousya.or.jp/jkk/',
  'https://to-kousya.or.jp/jkk/',
  'https://www.to-kousya.or.jp/',
  'https://to-kousya.or.jp/',
  // 予備（直でポータル）。DNSが不安定なら失敗することあり
  'https://www.jkk-portal.jp/',
  'https://jkk-portal.jp/',
  'http://www.jkk-portal.jp/',
  'http://jkk-portal.jp/',
];

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}
async function savePage(page, base) {
  await ensureDir(ART_DIR);
  await fs.writeFile(`${ART_DIR}/${base}.html`, await page.content());
  await page.screenshot({ path: `${ART_DIR}/${base}.png`, fullPage: true });
  console.log(`[artifacts] saved: ${base}.html / ${base}.png`);
}

async function gotoWithRetries(page, urls, { tries = 3, waitUntil = 'domcontentloaded' } = {}) {
  let lastErr;
  for (const url of urls) {
    for (let i = 1; i <= tries; i++) {
      try {
        console.log(`[goto] (${i}/${tries}) ${url}`);
        await page.goto(url, { waitUntil, timeout: 25000 });
        return url;
      } catch (err) {
        lastErr = err;
        const msg = (err && err.message) || '';
        const backoff = 800 * i;
        if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|net::ERR/.test(msg)) {
          console.log(`[goto-retry] ${url} -> ${msg.trim()} (sleep ${backoff}ms)`);
          await page.waitForTimeout(backoff);
          continue;
        }
        console.log(`[goto-skip] ${url} -> ${msg.trim()}`);
        break;
      }
    }
  }
  throw lastErr || new Error('goto failed');
}

async function clickIfVisible(root, selectors, opts = {}) {
  for (const sel of selectors) {
    const loc = root.locator(sel).first();
    try {
      const count = await loc.count();
      if (count > 0) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        if (await loc.isVisible()) {
          await loc.click({ timeout: 5000, ...opts });
          return true;
        }
      }
    } catch {}
  }
  return false;
}

async function fillIfVisible(root, selectors, value) {
  for (const sel of selectors) {
    const loc = root.locator(sel).first();
    try {
      const count = await loc.count();
      if (count > 0 && (await loc.isVisible())) {
        await loc.fill(value, { timeout: 7000 });
        return true;
      }
    } catch {}
  }
  return false;
}

// 画面内テキストから href を引っこ抜く（クリック不能でも遷移できる）
async function findHrefByText(page, pattern) {
  return await page.evaluate((reStr) => {
    const re = new RegExp(reStr);
    const aTags = Array.from(document.querySelectorAll('a'));
    for (const a of aTags) {
      const text = (a.innerText || a.textContent || '').replace(/\s+/g, '');
      const label = (a.getAttribute('aria-label') || '').replace(/\s+/g, '');
      if (re.test(text) || re.test(label)) {
        try {
          const u = new URL(a.getAttribute('href'), location.href);
          return u.href;
        } catch {}
      }
    }
    return null;
  }, pattern.source);
}

// ポータル系の URL に対して、www/https 切替などのバリアントを用意
function variantsFor(urlStr) {
  try {
    const u = new URL(urlStr);
    const list = [u.href];

    // www 有無
    if (u.hostname.startsWith('www.')) {
      list.push(u.href.replace('//www.', '//'));
    } else {
      list.push(u.href.replace('//', '//www.'));
    }
    // https / http
    if (u.protocol === 'https:') {
      list.push(u.href.replace('https:', 'http:'));
    } else {
      list.push(u.href.replace('http:', 'https:'));
    }

    // ルートも入れておく
    list.push(`${u.origin}/`);
    // 重複削除
    return Array.from(new Set(list));
  } catch {
    return [urlStr];
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    // 1) トップへ（to-kousya 優先）
    console.log('[step] goto landing (prefer to-kousya)');
    await gotoWithRetries(page, LANDING_CANDIDATES, { tries: 3 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await savePage(page, 'landing');

    // 2) バナーやクッキーを閉じる
    await clickIfVisible(page, [
      'button:has-text("閉じる")',
      'text=閉じる',
      'role=button[name="閉じる"]',
      '#cookie_close, .cookie-close',
    ]);

    // 3) 「こだわり条件」を開く —— クリック → ダメなら href 直遷移
    console.log('[step] open conditions (こだわり条件)');
    let condPage = null;

    // a) まずは普通にクリック（新窓対応）
    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    const clicked =
      (await clickIfVisible(page, [
        'a:has-text("こだわり条件")',
        'text=こだわり条件',
        'button:has-text("こだわり条件")',
        'role=button[name="こだわり条件"]',
      ])) || false;

    if (clicked) {
      condPage = await popupPromise;
      if (!condPage) condPage = page;
    } else {
      // b) クリックできない場合は href を拾って直接遷移
      const href =
        (await findHrefByText(page, /こだわり条件/)) ||
        (await findHrefByText(page, /条件.*(から|で)さがす/));
      if (!href) throw new Error('こだわり条件のリンクが見つかりませんでした');

      condPage = page;
      const cand = variantsFor(href);
      await gotoWithRetries(condPage, cand, { tries: 3 });
    }

    await condPage.waitForLoadState('domcontentloaded').catch(() => {});
    await condPage.waitForTimeout(800); // レイアウト安定待ち
    await savePage(condPage, 'popup_top');

    // 4) 住宅名（カナ）へ入力 → 検索
    console.log('[step] fill "住宅名（カナ）" and search');
    // すべてのフレームを対象に探す
    const roots = [condPage, ...condPage.frames()];

    let filled = false;
    for (const root of roots) {
      const ok = await fillIfVisible(root, [
        'input[aria-label*="住宅名"][aria-label*="カナ"]',
        'input[placeholder*="カナ"]',
        'role=textbox[name*="住宅名"][name*="カナ"]',
        'xpath=//label[contains(normalize-space(.),"住宅名") and contains(.,"カナ")]/following::input[1]',
        'input[type="text"]',
      ], WORD);
      if (ok) {
        filled = true;
        break;
      }
    }
    if (filled) {
      console.log(`[filled] 住宅名（カナ）に "${WORD}" を入力`);
      await savePage(condPage, 'jyouken_filled');
    } else {
      console.warn('[warn] 住宅名（カナ）の入力欄が見つかりません（ページ仕様差分の可能性）');
      await savePage(condPage, 'jyouken_filled_html_error');
    }

    // 検索ボタン
    let searched = false;
    for (const root of roots) {
      const ok = await clickIfVisible(root, [
        'text=検索する',
        'button:has-text("検索")',
        'role=button[name*="検索"]',
        'input[type="submit"][value*="検索"]',
      ]);
      if (ok) {
        searched = true;
        break;
      }
    }
    if (!searched) console.warn('[warn] 検索ボタンが見つからずクリックできませんでした');

    // 5) 結果ページを拾って保存
    console.log('[step] wait for result list');
    await condPage.waitForTimeout(2000);
    const allPages = context.pages();
    const resultPage =
      allPages.find(p => /result|list|kensaku|ichiran|akiyake/i.test(p.url())) ||
      allPages.find(p => /popup|search|kodawari|jyouken/i.test(p.url())) ||
      condPage;

    await resultPage.waitForLoadState('domcontentloaded').catch(() => {});
    await resultPage.waitForLoadState('networkidle').catch(() => {});
    await savePage(resultPage, 'result_list');

    console.log('[done]');
    await browser.close();
  } catch (err) {
    console.error('[fatal]', err);
    try {
      const last = context.pages().at(-1);
      if (last) await savePage(last, 'last_page_fallback');
    } catch {}
    await browser.close();
    process.exit(1);
  }
})();
