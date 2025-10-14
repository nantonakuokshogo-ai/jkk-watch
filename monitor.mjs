// monitor.mjs ーーー 丸ごと置き換えOK
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const ART_DIR = 'artifacts';
const SEARCH_KANA = process.env.SEARCH_KANA || 'コーシャハイム';

// ------------- ユーティリティ -------------
async function save(page, base) {
  try {
    await fs.mkdir(ART_DIR, { recursive: true });
    const html = await page.content();                 // ← await を忘れると以前のエラーになります
    await fs.writeFile(path.join(ART_DIR, `${base}.html`), html);
    await page.screenshot({ path: path.join(ART_DIR, `${base}.png`), fullPage: true });
    console.log(`[artifacts] saved: ${base}.html / ${base}.png`);
  } catch (e) {
    console.warn('[artifacts] save failed:', e.message);
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ------------- ステップ: ランディングへ -------------
async function gotoLanding(page) {
  console.log('[step] goto landing (prefer to-kousya)');
  const candidates = [
    'https://www.to-kousya.or.jp/jkk/',
    // フォールバック（将来ドメインが戻った場合）
    'https://www.jkk-portal.jp/',
    'http://www.jkk-portal.jp/'
  ];

  for (const url of candidates) {
    for (let i = 0; i < 3; i++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await save(page, 'landing');
        return;
      } catch (e) {
        console.log(`[goto-retry] ${url} -> ${e.message} (sleep ${800 * (i + 1)}ms)`);
        await sleep(800 * (i + 1));
      }
    }
  }
  throw new Error('landing に到達できませんでした');
}

// ------------- ステップ: こだわり条件を開く（ポップアップ/待機ページ両対応） -------------
async function openConditions(page) {
  console.log('[step] open conditions');

  // バナー類があれば閉じる（失敗しても無視）
  await page.locator('text=閉じる').first().click({ timeout: 1500 }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});

  // 「こだわり条件」ボタン候補
  const condBtn = page.locator([
    'a:has-text("こだわり条件")',
    'button:has-text("こだわり条件")',
    '[aria-label*="こだわり条件"]',
  ].join(',')).first();

  await condBtn.scrollIntoViewIfNeeded().catch(() => {});
  await condBtn.waitFor({ state: 'visible', timeout: 8000 });

  // クリックと popup を同時に待つ（出ないサイト配置もあるので両対応）
  const p = page.waitForEvent('popup').catch(() => null);
  await condBtn.click({ delay: 30 });
  let work = await p;
  if (!work) work = page;          // 同一タブ遷移パターン

  await work.waitForLoadState('domcontentloaded');

  // 「待機ページ」（wait.jsp / 「数秒後に自動で次の画面」/「こちら」）に対処
  const isWait =
    /wait\.jsp/i.test(work.url()) ||
    (await work.locator('text=数秒後に自動で次の画面').count()) > 0 ||
    (await work.locator('a:has-text("こちら")').count()) > 0;

  if (isWait) {
    // onload 相当の openMainWindow() を明示実行（あれば）
    await work.evaluate(() => { try { window.openMainWindow?.(); } catch (_) {} }).catch(() => {});
    // forwardForm がなければ「こちら」をクリック
    await work.locator('a:has-text("こちら")').first().click({ timeout: 2000 }).catch(() => {});
    // どちらでも次画面のロードを待つ
    await work.waitForLoadState('load').catch(() => {});
  }

  // ポップアップ側が JKKnet ウィンドウ名で開く場合に備えて前面へ
  try { if (work && (await work.evaluate(() => window.name)) === 'JKKnet') await work.bringToFront(); } catch {}
  return work;
}

// ------------- ステップ: 条件入力 & 検索 -------------
async function fillAndSearch(jkkPage) {
  console.log('[step] fill conditions & search');

  // できれば「住宅名（カナ）」に入力（取れない場合はスキップして検索）
  let filled = false;
  const kanaLocators = [
    // 「住宅名（カナ）」という表示に隣接する input
    'xpath=//*[contains(normalize-space(.),"住宅名") and contains(normalize-space(.),"カナ")]/ancestor::*[self::tr or self::td or self::th][1]//input[1]',
    'xpath=//label[contains(normalize-space(.),"住宅名") and contains(normalize-space(.),"カナ")]/following::*[self::input or self::textarea][1]',
    // aria/タイトル系
    'input[title*="カナ"]',
    'input[aria-label*="カナ"]',
    // 最後の保険：フォーム内のテキストボックスを総当りして placeholder にカナを含むもの
    'xpath=//input[@type="text" and contains(@placeholder,"カナ")]'
  ];

  for (const sel of kanaLocators) {
    const loc = jkkPage.locator(sel).first();
    try {
      if (await loc.count()) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.fill(''); await loc.type(SEARCH_KANA, { delay: 30 });
        filled = true;
        break;
      }
    } catch { /* 次の候補へ */ }
  }
  console.log(filled ? `[info] 住宅名（カナ）に入力: ${SEARCH_KANA}` : '[warn] 住宅名（カナ）が見つからず、入力をスキップ');

  // 「検索する」押下（input/button/画像ボタン いずれでも）
  const searchBtn = jkkPage.locator([
    'button:has-text("検索する")',
    'input[type="submit"][value="検索する"]',
    'input[alt="検索する"]',
    'input[type="image"][alt*="検索"]',
    'input[type="submit"]'
  ].join(',')).first();

  await searchBtn.waitFor({ state: 'visible', timeout: 15000 });
  await Promise.all([
    jkkPage.waitForLoadState('domcontentloaded'),
    searchBtn.click({ delay: 30 })
  ]);

  // 結果らしきテーブル/「詳細」ボタン等が出るのを待機（緩め）
  await jkkPage.waitForTimeout(1200);
}

// ------------- メイン -------------
async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1240, height: 2200 } });
  const page = await context.newPage();

  try {
    await gotoLanding(page);

    const jkkPage = await openConditions(page);
    await save(jkkPage, 'popup_top');       // 条件トップ（JKKnet側）を保存

    await fillAndSearch(jkkPage);
    await save(jkkPage, 'result_list');     // 一覧を保存
  } catch (e) {
    console.error('[fatal]', e);
    try { await save(page, 'last_page_fallback'); } catch {}
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main();
