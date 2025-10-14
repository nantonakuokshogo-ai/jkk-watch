import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ART = (name) => path.join('artifacts', name);

async function save(page, base) {
  await fs.writeFile(ART(`${base}.html`), await page.content());
  await page.screenshot({ path: ART(`${base}.png`), fullPage: true });
}

async function clickIfVisible(page, locator, timeout = 3000) {
  const l = page.locator(locator).first();
  try {
    await l.waitFor({ state: 'visible', timeout });
    await l.click({ timeout });
    return true;
  } catch { return false; }
}

async function tryLinks(page, texts, timeoutEach = 4000) {
  for (const t of texts) {
    const ok =
      await clickIfVisible(page, `a:has-text("${t}")`, timeoutEach) ||
      await clickIfVisible(page, `text=${t}`, timeoutEach);
    if (ok) return t;
  }
  return null;
}

async function gotoWithFallbacks(page, urls, label) {
  for (let i = 0; i < urls.length; i++) {
    try {
      console.log(`[goto] (${i + 1}/${urls.length}) ${urls[i]}`);
      await page.goto(urls[i], { waitUntil: 'domcontentloaded', timeout: 15000 });
      return true;
    } catch (e) {
      console.log(`[goto-retry] ${urls[i]} -> ${e.message}`);
      await page.waitForTimeout(600 * (i + 1));
    }
  }
  console.error(`[fatal] cannot goto ${label}`);
  return false;
}

async function closeAnnoyances(page) {
  // Cookie バナー「閉じる」
  await clickIfVisible(page, 'button:has-text("閉じる"), .cookie a:has-text("閉じる")').catch(()=>{});
  // チャット・バナー類
  await page.evaluate(() => {
    document.querySelectorAll('iframe, .mf_finder_suggest, .el_chat, .chatbot').forEach(el => {
      el.style.pointerEvents = 'none';
    });
  }).catch(()=>{});
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
  const page = await ctx.newPage();

  // 1) トップへ（to-kousya 優先）
  console.log('[step] goto landing (to-kousya)');
  const okLanding = await gotoWithFallbacks(page, [
    'https://www.to-kousya.or.jp/jkk/',
    'https://www.to-kousya.or.jp/',
  ], 'landing');
  if (!okLanding) throw new Error('landing unreachable');
  await closeAnnoyances(page);
  await save(page, 'landing');

  // 2) メガメニュー「住宅をお探しの方」→「賃貸住宅情報」
  console.log('[step] open mega menu → 賃貸住宅情報');
  // 見た目は <p class="gMenuLabel"> なので button/role が無い。テキストで開く。
  await clickIfVisible(page, '.gMenuLabel:has-text("住宅をお探しの方")', 4000);
  const jumped = await tryLinks(page, ['賃貸住宅情報', '賃貸住宅情報TOP', '公社住宅'], 5000);
  if (!jumped) {
    // 直接 URL へフォールバック
    await gotoWithFallbacks(page, [
      'https://www.to-kousya.or.jp/chintai/index.html',
      'https://www.to-kousya.or.jp/chintai/'
    ], 'chintai top');
  }
  await closeAnnoyances(page);
  await save(page, 'chintai_top');

  // 3) 「物件検索 / 住宅一覧 / 先着順 / 空室 / さがす」を総当たり
  console.log('[step] go to search/list page');
  const clicked = await tryLinks(page, [
    '物件検索', '住宅一覧', '先着順', '空室', 'さがす', '公社住宅をさがす'
  ], 4500);

  if (!clicked) {
    // 一部サイトでは専用ディレクトリがあるため候補 URL を順に叩く
    await gotoWithFallbacks(page, [
      'https://www.to-kousya.or.jp/chintai/search/',
      'https://www.to-kousya.or.jp/chintai/search/index.html',
      'https://www.to-kousya.or.jp/chintai/bukken/',
      'https://www.to-kousya.or.jp/chintai/bukken/index.html'
    ], 'search/list');
  }

  await closeAnnoyances(page);
  await save(page, 'maybe_list');

  // 4) ここまでで “一覧っぽい” 画面に出られたら終了。
  //    条件入力まで自動化する場合は、ここに各セレクタを追加してください。
  //    例: await page.selectOption('select[name="area"]', '港区') など

  await browser.close();
}

main().catch(async (e) => {
  console.error('[fatal]', e);
  try {
    // 直前ページのスナップショットを落としておく
    // （page が閉じている場合は握りつぶす）
    const last = ART('last_page_fallback.html');
    if (globalThis.page) {
      await fs.writeFile(last, await globalThis.page.content());
      await globalThis.page.screenshot({ path: ART('last_page_fallback.png'), fullPage: true });
    }
  } catch {}
  process.exit(1);
});
