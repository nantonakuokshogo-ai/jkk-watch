// jkk_scrape.js
// Playwright で JKK「こだわり条件」→ 条件検索 → 物件一覧（またはフォールバックで住宅一覧）を取得
// 出力: out/landing.html/png, out/after_click_kodawari.html/png, out/conditions_or_list.html/png, out/result_list.html/png, out/last_page_fallback.html/png

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = 'https://www.to-kousya.or.jp/';

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
async function save(page, name) {
  ensureDir('out');
  const htmlPath = path.join('out', `${name}.html`);
  const imgPath  = path.join('out', `${name}.png`);
  await page.waitForLoadState('domcontentloaded');
  const html = await page.content();
  fs.writeFileSync(htmlPath, html, 'utf-8');
  await page.screenshot({ path: imgPath, fullPage: true });
  console.log(`[saved] ${name}`);
}

async function closeCookieIfAny(page) {
  // 画面下部の Cookie バナー「閉じる」
  const btn = page.locator('text=閉じる').first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click({ timeout: 1000 }).catch(() => {});
  }
}

async function clickKodawari(page, context) {
  // 「こだわり条件」は a と button の両方に備える
  const candidates = page.locator('a:has-text("こだわり条件"), button:has-text("こだわり条件")');
  if (!(await candidates.count())) throw new Error('こだわり条件ボタンが見つかりません');
  const target = candidates.first();
  await target.scrollIntoViewIfNeeded();
  // 別タブに備えて待機
  const [maybeNewPage] = await Promise.allSettled([
    context.waitForEvent('page', { timeout: 5000 }),
    target.click({ delay: 50 })
  ]);
  // 新しいタブが開いたらそちらに切替え
  if (maybeNewPage.status === 'fulfilled') {
    const p = maybeNewPage.value;
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    return p;
  } else {
    // 同タブ遷移
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return page;
  }
}

async function handleLegacyRedirect(p) {
  // 「数秒後に自動で次の画面が表示されます。表示されない場合はこちら…」ページ対応
  const bodyText = await p.textContent('body').catch(() => '');
  if (bodyText && /数秒後に自動で次の画面が表示されます|こちらをクリック/i.test(bodyText)) {
    const here = p.locator('a:has-text("こちら")');
    if (await here.isVisible().catch(() => false)) {
      await here.click().catch(() => {});
      await p.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }
}

async function goToConditionFormOrList(p) {
  // 旧サイトの地図トップなら「条件から検索」を押す
  const mapTitle = await p.locator('text=先着順あき家検索').first().isVisible().catch(() => false);
  if (mapTitle) {
    const condLink = p.locator('a:has-text("条件から検索"), a:has-text("条件から検索する"), a:has-text("条件検索")').first();
    if (await condLink.isVisible().catch(() => false)) {
      await condLink.click().catch(() => {});
      await p.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }
  // 404 の「ページが見つかりません」チェック
  const notFound = await p.locator('text=ページが見つかりません').first().isVisible().catch(() => false);
  if (notFound) throw new Error('404 page reached');
}

async function trySubmitSearch(p) {
  // 条件フォームに来た場合、なんらかの「検索」ボタンを押す
  // ボタン候補（value属性/テキストに「検索」を含む）
  const submitBtn = p.locator('input[type="submit"][value*="検索"], button:has-text("検索")').first();
  if (await submitBtn.isVisible().catch(() => false)) {
    await submitBtn.scrollIntoViewIfNeeded();
    await submitBtn.click().catch(() => {});
    await p.waitForLoadState('domcontentloaded').catch(() => {});
  }
}

async function looksLikeListPage(p) {
  // 物件カードや「件」「一覧」などを簡易に検出
  const text = (await p.textContent('body').catch(() => '')) || '';
  if (/一覧|件|物件|JKK住宅/i.test(text)) return true;
  // 画像連なるカード検出（だいたいのリストに画像がある）
  const imgs = await p.locator('img').count().catch(() => 0);
  return imgs >= 10; // ざっくり
}

async function fallbackToJkkList(rootPage, context) {
  // トップの「住宅一覧」から一覧ページへ（確実に取れるフォールバック）
  await rootPage.bringToFront();
  const tile = rootPage.locator('a:has-text("住宅一覧")').first();
  await tile.scrollIntoViewIfNeeded();
  const [maybeNew] = await Promise.allSettled([
    context.waitForEvent('page', { timeout: 4000 }),
    tile.click().catch(() => {})
  ]);
  const page = (maybeNew.status === 'fulfilled') ? maybeNew.value : rootPage;
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  return page;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();

  try {
    // 1) トップ
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await closeCookieIfAny(page);
    await save(page, 'landing');

    // 2) こだわり条件 → 新タブ/同タブ対応
    const afterClick = await clickKodawari(page, context);
    await closeCookieIfAny(afterClick);
    await save(afterClick, 'after_click_kodawari');

    // 3) 旧サイトリダイレクト＆地図トップ対応
    await handleLegacyRedirect(afterClick);
    await goToConditionFormOrList(afterClick);
    await closeCookieIfAny(afterClick);
    await save(afterClick, 'conditions_or_list');

    // 4) できる限り検索実行 → 一覧判定
    await trySubmitSearch(afterClick);
    await closeCookieIfAny(afterClick);
    let listHolder = afterClick;
    if (!(await looksLikeListPage(listHolder))) {
      // 5) フォールバック：住宅一覧（確実）
      listHolder = await fallbackToJkkList(page, context);
    }

    // 6) 最終出力（一覧 or 代替一覧）
    await closeCookieIfAny(listHolder);
    await save(listHolder, 'result_list');

  } catch (e) {
    console.error('[error]', e.message);
    try { await save(page, 'last_page_fallback'); } catch {}
  } finally {
    await browser.close();
  }
})();
