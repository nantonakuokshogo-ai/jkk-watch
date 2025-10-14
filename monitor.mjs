// monitor.mjs  —— JKK こだわり条件→一覧まで安定遷移する版
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const ART_DIR = 'artifacts';

async function save(page, name) {
  const html = await page.content();
  await fs.writeFile(`${ART_DIR}/${name}.html`, html);
  await page.screenshot({ path: `${ART_DIR}/${name}.png`, fullPage: true });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gotoWithRetries(page, url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`[goto] (${i}/${tries}) ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return;
    } catch (e) {
      lastErr = e;
      console.log(`[goto-retry] ${url} -> ${e.message} (sleep ${800 * i}ms)`);
      await sleep(800 * i);
    }
  }
  throw lastErr;
}

// 画面下バナー/フロートのクリック妨害を抑止
async function disableOverlays(page) {
  await page.addStyleTag({
    content: `
      /* 固定フロート系を無効化 */
      [aria-label*="Cookie" i],
      .Cookie, .cookie, .cookie-consent, .bl_cookie,
      .c-box--float, .js-float, .js-fixed,
      [id*="MediaTalk" i], [class*="MediaTalk" i],
      div[style*="position:fixed" i] {
        pointer-events: none !important;
        opacity: 0.001 !important;
        z-index: -1 !important;
      }
    `,
  });
}

// 「こだわり条件」ページを開く（同タブ遷移・popup・直叩きの三段構え）
async function openConditions(page) {
  console.log('[step] open conditions (こだわり条件)');

  // まず候補リンクを掴む
  const cond = page.locator(
    'a.bl_topSelect_btn__cond, a:has(span:has-text("こだわり条件")),' +
    'a[href*="akiyaJyouken"]'
  ).first();

  // 見つかれば target を外して同タブ遷移
  try {
    await cond.waitFor({ state: 'visible', timeout: 5000 });
    await cond.evaluate((a) => a.removeAttribute('target'));
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      cond.click()
    ]);
    return page;
  } catch (_) {
    // 見つからない/クリックで新タブが出る場合は popup を待つ
    try {
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        cond.click().catch(() => {}) // クリックできないケースもある
      ]);
      await popup.waitForLoadState('domcontentloaded', { timeout: 20000 });
      return popup;
    } catch (e2) {
      console.log('[openConditions] fallback: direct goto (PC用URL)');
      // 直URL（PC用）。※SP用は必要になったら追加
      const direct = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';
      await gotoWithRetries(page, direct, 2);
      return page;
    }
  }
}

// 条件ページで「検索/表示」っぽいボタンを押して一覧へ
async function goToResultList(page) {
  console.log('[step] submit conditions → result list');

  // 画面内のボタン候補を広めに
  const candidates = [
    'button:has-text("検索")',
    'button:has-text("表示")',
    'button:has-text("次")',
    'input[type="submit"]',
    'a:has-text("検索")',
    'a:has-text("表示")',
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count().then(n => n > 0) && await loc.isVisible().catch(() => false)) {
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
          loc.click({ timeout: 5000 })
        ]);
        return true;
      } catch (_) { /* 次の候補へ */ }
    }
  }
  // ボタンが見つからない場合でもエビデンスだけ残して終了
  return false;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let page = await context.newPage();

  try {
    await fs.mkdir(ART_DIR, { recursive: true });

    // 1) ランディング到達（to-kousya → chintai両対応）
    console.log('[step] goto landing (prefer to-kousya)');
    const candidates = [
      'https://www.to-kousya.or.jp/',
      'https://www.to-kousya.or.jp/chintai/',
      'https://www.to-kousya.or.jp/chintai/index.html',
    ];
    for (const url of candidates) {
      try { await gotoWithRetries(page, url, 3); break; } catch (_) {}
    }
    await disableOverlays(page);
    await save(page, 'landing');

    // 2) こだわり条件ページへ
    const condPage = await openConditions(page);
    await disableOverlays(condPage);
    await save(condPage, 'conditions_or_list'); // 条件画面（or 直で一覧に出るケースもある）

    // 3) 一覧へ（ボタン検出できたら押す）
    const moved = await goToResultList(condPage);
    await save(condPage, moved ? 'result_list' : 'result_list_maybe');

  } catch (e) {
    console.error('[fatal]', e);
    try { await save(page, 'last_page_fallback'); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
