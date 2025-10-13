// monitor.mjs
import { chromium } from 'playwright';
import fs from 'fs/promises';

const WORD = process.env.JKK_WORD || 'コーシャハイム'; // 住宅名（カナ）に入れる検索ワード
const ART_DIR = 'artifacts';

// ===== 新規: DNSゆらぎ対策つき goto =====
const LANDING_CANDIDATES = [
  'https://www.jkk-portal.jp/',
  'https://jkk-portal.jp/',
  'http://www.jkk-portal.jp/',
  'http://jkk-portal.jp/',
];

async function gotoWithRetries(page, urls, { tries = 4, waitUntil = 'domcontentloaded' } = {}) {
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
        // DNSエラーや一時的なネットワーク系のみリトライ
        if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|net::ERR/.test(msg)) {
          const backoff = 800 * i;
          console.log(`[goto-retry] ${url} -> ${msg.trim()} (sleep ${backoff}ms)`);
          await page.waitForTimeout(backoff);
          continue;
        }
        // それ以外は次のURLへ
        console.log(`[goto-skip] ${url} -> ${msg.trim()}`);
        break;
      }
    }
  }
  throw lastErr || new Error('goto failed (no detail)');
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function savePage(page, base) {
  await ensureDir(ART_DIR);
  await fs.writeFile(`${ART_DIR}/${base}.html`, await page.content());
  await page.screenshot({ path: `${ART_DIR}/${base}.png`, fullPage: true });
  console.log(`[artifacts] saved: ${base}.html / ${base}.png`);
}

async function clickIfVisible(root, candidates, opts = {}) {
  for (const sel of candidates) {
    const loc = root.locator(sel).first();
    try {
      const count = await loc.count();
      if (count > 0 && await loc.isVisible()) {
        await loc.click(opts);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function fillIfVisible(root, candidates, value) {
  for (const sel of candidates) {
    const loc = root.locator(sel).first();
    try {
      const count = await loc.count();
      if (count > 0 && await loc.isVisible()) {
        await loc.fill(value);
        return true;
      }
    } catch (_) {}
  }
  return false;
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
    console.log('[step] goto landing (with DNS retries)');
    await gotoWithRetries(page, LANDING_CANDIDATES, { tries: 3 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await savePage(page, 'landing');

    // クッキーバナー等を閉じる
    await clickIfVisible(page, [
      'text=閉じる',
      'button:has-text("閉じる")',
      'role=button[name="閉じる"]',
    ]);

    console.log('[step] open conditions (こだわり条件)');
    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);

    const opened =
      (await clickIfVisible(page, [
        'text=こだわり条件',
        'button:has-text("こだわり条件")',
        'role=button[name="こだわり条件"]',
        'a:has-text("こだわり条件")',
      ])) || false;

    if (!opened) throw new Error('こだわり条件のクリックに失敗しました（セレクタ未一致）');

    let condPage = await popupPromise;
    if (condPage) {
      console.log('[popup] captured new window');
      await condPage.waitForLoadState('domcontentloaded').catch(() => {});
    } else {
      console.log('[popup] not fired, fallback to same-tab/iframe');
      await page.waitForTimeout(1200);
      const others = context.pages().filter(p => p !== page);
      condPage =
        others.find(p => /entry|popup|search|kodawari|jyouken|akiyake/i.test(p.url())) || page;
      await condPage.waitForLoadState('domcontentloaded').catch(() => {});
    }

    const roots = [condPage.frameLocator('iframe'), condPage];

    console.log('[step] fill "住宅名（カナ）" and search');
    let filled = false;
    for (const root of roots) {
      const textFieldSelectors = [
        'input[aria-label*="住宅名"][aria-label*="カナ"]',
        'input[aria-label*="カナ"][aria-label*="住宅名"]',
        'role=textbox[name*="住宅名"][name*="カナ"]',
        'xpath=//label[contains(., "住宅名") and contains(., "カナ")]/following::input[1]',
        'input[type="text"]',
      ];
      try {
        filled = await fillIfVisible(root, textFieldSelectors, WORD);
        if (filled) {
          console.log(`[filled] 住宅名（カナ）に "${WORD}" を入力`);
          await savePage(condPage, 'jyouken_filled');
          const clicked =
            (await clickIfVisible(root, [
              'text=検索する',
              'button:has-text("検索する")',
              'role=button[name="検索する"]',
              'input[type="submit"][value*="検索"]',
            ])) || false;
          if (!clicked) console.warn('[warn] 検索ボタンが見つからず、代替クリック失敗');
          break;
        }
      } catch {}
    }

    if (!filled) console.warn('[warn] 住宅名（カナ）入力に失敗（セレクタ未一致の可能性）');

    console.log('[step] wait for result list (any page/list view)');
    await condPage.waitForTimeout(2000);

    const pickResultPage = () => {
      const all = context.pages();
      return (
        all.find(p => /result|list|kensaku|ichiran|akiyake/i.test(p.url())) ||
        all.find(p => /popup|search|kodawari/i.test(p.url())) ||
        condPage
      );
    };

    let resultPage = pickResultPage();
    await resultPage.waitForLoadState('domcontentloaded').catch(() => {});
    await resultPage.waitForLoadState('networkidle').catch(() => {});
    await savePage(resultPage, 'result_list');

    console.log('[done] finished without fatal errors');
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
