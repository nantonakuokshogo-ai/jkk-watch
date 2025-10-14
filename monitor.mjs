// monitor.mjs
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const OUTDIR = 'artifacts';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function save(page, base) {
  await fs.mkdir(OUTDIR, { recursive: true });
  const html = await page.content();
  await fs.writeFile(`${OUTDIR}/${base}.html`, html);
  await page.screenshot({ path: `${OUTDIR}/${base}.png`, fullPage: true });
}

function log(msg) {
  console.log(`[step] ${msg}`);
}

async function gotoWithRetries(page, urls, attempts = 3) {
  for (const url of urls) {
    for (let i = 1; i <= attempts; i++) {
      try {
        console.log(`[goto] (${i}/${attempts}) ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        return;
      } catch (e) {
        console.log(`[goto-retry] ${url} -> ${e.message} (sleep ${800 * i}ms)`);
        await sleep(800 * i);
      }
    }
  }
  throw new Error('All goto retries failed');
}

async function waitPopup(page, action, timeout = 8000) {
  let popup;
  await Promise.allSettled([
    page.waitForEvent('popup', { timeout }).then(p => popup = p),
    action()
  ]);
  return popup ?? null;
}

/** こだわり条件へ（ポップアップ or 同タブ遷移） */
async function openConditions(page) {
  log('open conditions (こだわり条件)');

  // クリック候補（見た目の変更に強い順）
  const candidates = [
    'a:has-text("こだわり条件")',
    '[role="button"]:has-text("こだわり条件")',
    'text=こだわり条件'
  ];

  // まずはページ先頭へ
  await page.mouse.wheel(0, -20000);
  await sleep(200);

  // 1) 通常のクリック → popup or 同タブ
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (await el.count() && await el.isVisible().catch(() => false)) {
      const popup = await waitPopup(page, () => el.click({ delay: 10 })).catch(() => null);
      if (popup) return popup;

      // 同タブで JKKねっとに遷移した可能性
      await sleep(800);
      if (/jhomes\.to-kousya\.or\.jp|jkknet|akiya/i.test(page.url())) {
        return page;
      }
    }
  }

  // 2) 待機ページ（「数秒後に自動…」「こちら」）が同タブ表示された時
  const here = page.locator('a', { hasText: 'こちら' });
  if (await here.count()) {
    const popup = await waitPopup(page, () => here.click());
    if (popup) return popup;
    await sleep(800);
    if (/jhomes\.to-kousya\.or\.jp|jkknet|akiya/i.test(page.url())) {
      return page;
    }
  }

  // 3) 最終手段：window.open で直接開く
  const direct = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';
  const popup = await waitPopup(
    page,
    () => page.evaluate((url) => window.open(url, 'JKKnet'), direct)
  ).catch(() => null);

  return popup ?? page;
}

/** JKKねっとで条件入力（最小限）→ 検索 */
async function fillConditions(jkk) {
  log('fill conditions on JKKねっと');

  // Cookie同意/バナー閉じを軽く処理（あれば）
  for (const txt of ['同意', '閉じる', '許可']) {
    const btn = jkk.locator(`button:has-text("${txt}")`).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await sleep(200);
    }
  }

  // ハブページに「こだわり条件へ」があるタイプ
  const jump = jkk.locator('a:has-text("こだわり条件")').first();
  if (await jump.count()) {
    await Promise.all([
      jkk.waitForLoadState('domcontentloaded'),
      jump.click().catch(() => {})
    ]);
    await sleep(500);
  }

  // 「空室あり」っぽいチェックを優先してON（あれば）
  const vacancy = jkk.locator('label:has-text("空室")');
  if (await vacancy.count()) {
    await vacancy.first().click().catch(() => {});
    await sleep(200);
  }

  // 「検索」ボタン（button or submit）を押す
  const searchBtn = jkk.locator('button:has-text("検索"), input[type="submit"][value*="検索"], a:has-text("検索")').first();
  if (await searchBtn.count()) {
    await Promise.all([
      jkk.waitForLoadState('domcontentloaded'),
      searchBtn.click().catch(() => {})
    ]);
  } else {
    // 見つからない時はリスト直URLへフォールバック
    await jkk.goto('https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenList', {
      waitUntil: 'domcontentloaded'
    }).catch(() => {});
  }
}

/** main */
async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();

  try {
    log('goto landing (prefer to-kousya)');
    await gotoWithRetries(page, [
      'https://www.to-kousya.or.jp/jkk/',
      'https://to-kousya.or.jp/jkk/'
    ]);
    await save(page, 'landing');

    const target = await openConditions(page);
    await target.waitForLoadState('domcontentloaded');
    await save(target, 'conditions_or_list');

    // 404/エラーページならここで止める
    const html = await target.content();
    if (/ページが見つかりません|404|notfound/i.test(html)) {
      throw new Error('こだわり条件のリンク（or 遷移）が失敗しました');
    }

    await fillConditions(target);

    // 一覧っぽい表示を少し待つ
    await target.waitForLoadState('domcontentloaded');
    await sleep(1500);
    await save(target, 'result_list');

    console.log('[done] captured result_list');
  } catch (e) {
    console.error('[fatal]', e);
    try { await save(page, 'last_page_fallback'); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
