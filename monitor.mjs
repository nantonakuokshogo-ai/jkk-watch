import { chromium } from 'playwright';
import fs from 'fs/promises';

const WORD = process.env.JKK_WORD || 'コーシャハイム'; // 住宅名（カナ）に入力
const ART_DIR = 'artifacts';

// --- 開始URL（env優先） + 候補一覧を to-kousya 先頭に ---
const ENV_START = process.env.JKK_START_URL && process.env.JKK_START_URL.trim();
const LANDING_CANDIDATES = [
  ...(ENV_START ? [ENV_START] : []),
  'https://www.to-kousya.or.jp/jkk/',
  'https://to-kousya.or.jp/jkk/',
  'https://www.to-kousya.or.jp/',
  'https://to-kousya.or.jp/',
  // 予備：ポータル直叩き（DNS揺れ時は失敗することあり）
  'https://www.jkk-portal.jp/',
  'https://jkk-portal.jp/',
  'http://www.jkk-portal.jp/',
  'http://jkk-portal.jp/',
];

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
        if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|net::ERR/.test(msg)) {
          const backoff = 800 * i;
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

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}
async function savePage(page, base) {
  await ensureDir(ART_DIR);
  await fs.writeFile(`${ART_DIR}/${base}.html`, await page.content());
  await page.screenshot({ path: `${ART_DIR}/${base}.png`, fullPage: true });
  console.log(`[artifacts] saved: ${base}.html / ${base}.png`);
}

async function clickIfVisible(root, selectors, opts = {}) {
  for (const sel of selectors) {
    const loc = root.locator(sel).first();
    try {
      const count = await loc.count();
      if (count > 0 && (await loc.isVisible())) {
        await loc.click(opts);
        return true;
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
        await loc.fill(value);
        return true;
      }
    } catch {}
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
    console.log('[step] goto landing (prefer to-kousya)');
    await gotoWithRetries(page, LANDING_CANDIDATES, { tries: 3 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await savePage(page, 'landing');

    // クッキー／案内バナーなど閉じる
    await clickIfVisible(page, [
      'button:has-text("閉じる")',
      'text=閉じる',
      'role=button[name="閉じる"]',
      '#cookie_close, .cookie-close',
    ]);

    // こだわり条件を開く（新窓 or 同タブ or iframe どれでも対応）
    console.log('[step] open conditions (こだわり条件)');
    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    const opened =
      (await clickIfVisible(page, [
        'text=こだわり条件',
        'button:has-text("こだわり条件")',
        'role=button[name="こだわり条件"]',
        'a:has-text("こだわり条件")',
      ])) || false;
    if (!opened) throw new Error('こだわり条件のクリックに失敗（セレクタ未一致）');

    let condPage = await popupPromise;
    if (condPage) {
      console.log('[popup] captured');
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

    // 「住宅名（カナ）」に入力 → 検索
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
    }
    if (!filled) console.warn('[warn] 住宅名（カナ）入力に失敗（セレクタ未一致の可能性）');

    // 結果ページを拾って保存
    console.log('[step] wait for result list');
    await condPage.waitForTimeout(2000);
    const pickResultPage = () => {
      const all = context.pages();
      return (
        all.find(p => /result|list|kensaku|ichiran|akiyake/i.test(p.url())) ||
        all.find(p => /popup|search|kodawari/i.test(p.url())) ||
        condPage
      );
    };
    const resultPage = pickResultPage();
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
