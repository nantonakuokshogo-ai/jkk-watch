import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const ART = (name) => `artifacts/${name}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function save(page, base) {
  try {
    const html = await page.content();
    await fs.writeFile(ART(`${base}.html`), html);
  } catch {}
  try {
    await page.screenshot({ path: ART(`${base}.png`), fullPage: true });
  } catch {}
}

async function clickIfVisible(page, locator) {
  const el = page.locator(locator).first();
  if (await el.count()) {
    try {
      await el.scrollIntoViewIfNeeded();
      await el.waitFor({ state: 'visible', timeout: 1500 });
      await el.click({ timeout: 1500 });
      return true;
    } catch {}
  }
  return false;
}

async function closeCookieBanner(page) {
  // 公式サイトの“閉じる”バナー対策（404含む）
  // 例: <a class="cc-btn cc-dismiss">閉じる</a>
  const candidates = [
    'button:has-text("閉じる")',
    'a:has-text("閉じる")',
    '.cc-btn.cc-dismiss',
  ];
  for (const sel of candidates) {
    if (await clickIfVisible(page, sel)) return true;
  }
  return false;
}

async function gotoWithRetries(page, urls) {
  for (const { url, tag } of urls) {
    for (const attempt of [1,2,3]) {
      try {
        console.log(`[goto] (${attempt}/3) ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await save(page, tag === 'landing' ? 'landing' : `landing_${tag}`);
        // 404 判定（見出し“ページが見つかりません”）
        if (await page.getByText('ページが見つかりません').first().count()) {
          await closeCookieBanner(page);
          await save(page, 'last_page_fallback');
          // 404 なら次URLへ
          break;
        }
        return true;
      } catch (e) {
        if (attempt === 3) break;
        await sleep(800 * attempt);
      }
    }
  }
  return false;
}

async function clickConditions(page) {
  console.log('[step] open conditions (こだわり条件)');
  // まずはクッキー閉じる
  await closeCookieBanner(page);

  const candidates = [
    // aタグ / ボタンのどちらにも対応
    'a:has-text("こだわり条件")',
    'button:has-text("こだわり条件")',
    // 画面内のカード風ボタン対策
    '[href*="koda"]',
    'text=こだわり条件'
  ];

  for (const sel of candidates) {
    const has = await page.locator(sel).first().count();
    if (!has) continue;

    // 新しいウィンドウが開く想定で待つ。ただし開かない場合もあるので両方許容。
    const popupPromise = page.waitForEvent('popup', { timeout: 4000 }).catch(() => null);
    try {
      await page.locator(sel).first().scrollIntoViewIfNeeded();
      await page.locator(sel).first().click({ timeout: 3000 });
    } catch {}
    const popup = await popupPromise;

    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await save(popup, 'popup_top');
      return popup;
    } else {
      // 同一タブ遷移だった場合
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      await save(page, 'popup_top'); // ファイル名は統一
      return page;
    }
  }
  throw new Error('こだわり条件のリンクが見つかりませんでした');
}

async function fillAndSearch(p) {
  console.log('[step] fill conditions (best-effort)');

  // 画面の差異が多いので、入力は最小限にし“検索する”を押下。
  // よくあるパターン: input[type=submit][value*="検索する"] / button に“検索する”
  const searchCandidates = [
    'input[type="submit"][value*="検索"]',
    'button:has-text("検索する")',
    'input[type="image"][alt*="検索"]',
  ];

  // 何かチェック必須があるときのための軽い入力（エリアの最初のチェックを入れる等）
  // 「東京23区」等の語は画面により異なるので“最初のチェックボックス”をひとつだけ入れる。
  try {
    const firstCheckbox = p.locator('input[type="checkbox"]').nth(0);
    if (await firstCheckbox.count()) {
      await firstCheckbox.check({ timeout: 1000 }).catch(() => {});
    }
  } catch {}

  // 検索ボタンを押す
  for (const sel of searchCandidates) {
    if (await p.locator(sel).first().count()) {
      try {
        await p.locator(sel).first().scrollIntoViewIfNeeded();
        await p.locator(sel).first().click({ timeout: 3000 });
        break;
      } catch {}
    }
  }

  // 結果待ち & 保存（404/タイムアウトも拾って保存）
  await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await save(p, 'result_list');

  // 404 に落ちてないかの軽い判定
  if (await p.getByText('ページが見つかりません').first().count()) {
    throw new Error('検索後に404へ遷移しました');
  }
}

async function fallbackBySiteSearch(page) {
  console.log('[fallback] use site search (result.html)');
  // 公式のサイト内検索ページに直接アクセスして“先着順あき家検索”で検索
  const url = 'https://www.to-kousya.or.jp/result.html?q=' + encodeURIComponent('先着順あき家検索');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await save(page, 'result_list'); // とりあえず保存
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36',
    viewport: { width: 1280, height: 2000 }
  });
  const page = await ctx.newPage();

  console.log('[step] goto landing (prefer to-kousya)');
  const ok = await gotoWithRetries(page, [
    { url: 'https://www.to-kousya.or.jp/jkk/', tag: 'landing' },
    { url: 'https://www.to-kousya.or.jp/', tag: 'landing_root' }
  ]);

  if (!ok) {
    await save(page, 'last_page_fallback');
    await browser.close();
    process.exit(1);
  }

  let popupOrSameTab;
  try {
    popupOrSameTab = await clickConditions(page);
  } catch (e) {
    // ここで落ちるときは、サイト内検索に退避（証跡は残す）
    await save(page, 'last_page_fallback');
    await fallbackBySiteSearch(page);
    await browser.close();
    return;
  }

  try {
    await fillAndSearch(popupOrSameTab);
  } catch (e) {
    // 失敗しても成果物は保存して終了、最後のページも保存
    await save(popupOrSameTab, 'last_page_fallback');
  } finally {
    await browser.close();
  }
}

main().catch(async (e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
