// monitor.mjs
// Playwright + Node.js ESM
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const ART_DIR = 'artifacts';
const BASE = 'https://www.to-kousya.or.jp';

async function save(page, name) {
  await fs.mkdir(ART_DIR, { recursive: true });
  const html = await page.content();
  await fs.writeFile(`${ART_DIR}/${name}.html`, html, 'utf8');
  await page.screenshot({ path: `${ART_DIR}/${name}.png`, fullPage: true });
  console.log(`[saved] ${name}`);
}

function log(step) {
  console.log(`[step] ${step}`);
}

async function maybeClick(page, locatorOrSelector, opt = {}) {
  const loc = typeof locatorOrSelector === 'string'
    ? page.locator(locatorOrSelector)
    : locatorOrSelector;
  const count = await loc.count().catch(() => 0);
  if (count > 0) {
    await loc.first().scrollIntoViewIfNeeded().catch(()=>{});
    await loc.first().click({ timeout: 5000, ...opt }).catch(()=>{});
    return true;
  }
  return false;
}

async function clickOneOf(page, selectors, opt = {}) {
  for (const s of selectors) {
    if (await maybeClick(page, s, opt)) return true;
  }
  return false;
}

async function closeOverlays(page) {
  // Cookie バナー
  await clickOneOf(page, [
    'button:has-text("同意")',
    'button:has-text("閉じる")',
    'button[aria-label="閉じる"]',
    'text=/クッキー.*使用しています/ >> xpath=..//button',
  ]);
  // チャット等
  await clickOneOf(page, [
    'button:has-text("×")',
    'button[aria-label="Close"]',
  ]);
}

async function gotoChintaiTop(page) {
  log('goto landing');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await closeOverlays(page);
  await save(page, 'landing');

  // ヘッダの「賃貸住宅情報」へ（複数パターンを許容）
  log('open chintai top');
  const ok = await clickOneOf(page, [
    'a[href*="/chintai/index.html"]',
    'a:has-text("賃貸住宅情報")',
  ]);
  if (!ok) throw new Error('賃貸住宅情報リンクが見つかりませんでした');

  await page.waitForLoadState('domcontentloaded');
  await closeOverlays(page);
  await save(page, 'chintai_top');
}

async function openKodawariOrConditions(page) {
  log('click こだわり条件（新UIボタン）');
  // 新サイトの「こだわり条件」ボタンをできるだけ広く拾う
  await clickOneOf(page, [
    'a:has-text("こだわり条件")',
    'button:has-text("こだわり条件")',
    // ARIA ロール
    page.getByRole('link', { name: 'こだわり条件' }),
    page.getByRole('button', { name: 'こだわり条件' }),
  ]);

  // ここから 3 分岐を吸収：
  // (A) 旧サイトの「しばらくしても…こちら」待機ページ
  // (B) 旧サイトの「エリアで検索（地図）」ページ
  // (C) 旧サイトの「条件から検索（チェックボックスのフォーム）」ページ
  await page.waitForLoadState('domcontentloaded');

  // A: 待機ページの「こちら」
  if (await page.locator('a:has-text("こちら")').first().isVisible().catch(()=>false)) {
    log('legacy relay page detected → click こちら');
    await page.locator('a:has-text("こちら")').first().click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded');
  }

  // B: 地図ページ（「条件から検索」リンクが右上にある）
  if (await page.locator('a:has-text("条件から検索")').first().isVisible().catch(()=>false)) {
    log('map page detected → click 条件から検索');
    await page.locator('a:has-text("条件から検索")').first().click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded');
  }

  // C: 条件フォーム or 直接一覧
  await closeOverlays(page);
  await save(page, 'conditions_or_list');
}

async function runSearchOrDetectList(page) {
  // すでに一覧ならそのまま保存
  const looksLikeList = async () => {
    const markers = [
      'a:has-text("詳細ページへ")',
      'text=物件一覧',
      'text=該当件数',
    ];
    for (const m of markers) {
      if ((await page.locator(m).count().catch(()=>0)) > 0) return true;
    }
    return false;
  };

  if (await looksLikeList()) {
    log('already on list page');
    await save(page, 'result_list');
    return;
  }

  // 条件ページの「検索」ボタン（複数パターン）
  log('try click 検索 on conditions');
  const clicked = await clickOneOf(page, [
    'input[type="submit"][value="検索"]',
    'input[type="button"][value="検索"]',
    'button:has-text("検索")',
  ]);
  if (!clicked) {
    throw new Error('検索ボタンが見つかりませんでした（条件ページ検出失敗の可能性）');
  }

  await page.waitForLoadState('domcontentloaded');
  await closeOverlays(page);

  // 旧サイトは検索後にまた中継ページへ飛ぶことがある
  if (await page.locator('a:has-text("こちら")').first().isVisible().catch(()=>false)) {
    log('post-search relay page → click こちら');
    await page.locator('a:has-text("こちら")').first().click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded');
  }

  await closeOverlays(page);
  await save(page, 'result_list');
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1600 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await gotoChintaiTop(page);
    await openKodawariOrConditions(page);
    await runSearchOrDetectList(page);
    console.log('[done] reached list');
  } catch (e) {
    console.error('[fatal]', e);
    // 何が起きたか分かるように最後のページをダンプ
    try { await save(page, 'error_fallback'); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
