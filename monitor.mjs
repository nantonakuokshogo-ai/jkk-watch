// monitor.mjs
// 手順:
// 1) 都公社のJKKページへ
// 2) 「こだわり条件」を開く（新規ポップアップ or 同一タブ）
// 3) 「住宅名（カナ）」に「コーシャハイム」を入力して検索
// 4) 画面ごとに HTML/PNG を artifacts に保存。結果に "コーシャハイム" があるか簡易検証

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ART_DIR = 'artifacts';
const ensureArtifacts = async () => {
  await fs.mkdir(ART_DIR, { recursive: true });
};
const saveHtml = async (page, file) => {
  await fs.writeFile(path.join(ART_DIR, file), await page.content(), 'utf8');
};
const snap = async (page, file, opts = {}) => {
  await page.screenshot({ path: path.join(ART_DIR, file), fullPage: true, ...opts });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// DNS が安定する入口（本体ドメイン直はCIで引けないことがある）
const LANDINGS = ['https://www.to-kousya.or.jp/jkk/'];

async function openLanding(page) {
  console.log('[step] goto landing (prefer to-kousya)');
  for (let i = 0; i < LANDINGS.length; i++) {
    try {
      await page.goto(LANDINGS[i], { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await snap(page, 'landing.png');
      await saveHtml(page, 'landing.html');
      return;
    } catch (e) {
      console.warn(`[landing fail ${i + 1}/${LANDINGS.length}]`, e.message);
      if (i === LANDINGS.length - 1) throw e;
      await sleep(800);
    }
  }
}

async function openConditions(page) {
  console.log('[step] open conditions (こだわり条件)');

  // もしクッキー同意の「閉じる」っぽいものがあれば閉じる（あっても無視 OK）
  await page.getByRole('button', { name: /閉じる/ }).first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('text=閉じる').first().click({ timeout: 2000 }).catch(() => {});

  // クリック候補（XPath 中心で広めに）
  const selectors = [
    'xpath=//a[contains(normalize-space(.),"こだわり条件")]',
    'xpath=//button[contains(normalize-space(.),"こだわり条件")]',
    'xpath=//div[contains(@class,"card") or contains(@class,"box") or contains(@class,"panel")]//a[contains(.,"こだわり条件")]',
    'text=こだわり条件'
  ];

  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if ((await el.count().catch(() => 0)) > 0) {
      const popupPromise = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
      await el.click({ timeout: 4000 }).catch(() => null);
      const popup = await popupPromise;

      const target = popup ?? page;
      await target.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await snap(target, 'popup_top.png');
      await saveHtml(target, 'popup_top.html');
      return target;
    }
  }

  throw new Error('こだわり条件のリンクが見つかりませんでした');
}

async function fillKanaAndCapture(target) {
  console.log('[step] fill 住宅名（カナ）');

  // 最優先: 「住宅名（カナ」のセルの次の input
  let input = target.locator(
    'xpath=(//td[contains(normalize-space(.),"住宅名（カナ")]/following::input[@type="text"][1])[1]'
  );

  if ((await input.count().catch(() => 0)) === 0) {
    // 代替: name/placeholder に Kana/カナ を含むテキストボックス
    input = target.locator(
      'xpath=(//input[@type="text"][contains(@name,"Kana") or contains(@placeholder,"カナ")])[1]'
    );
  }

  if ((await input.count().catch(() => 0)) === 0) {
    await snap(target, 'jyouken_filled_html_error.png');
    await saveHtml(target, 'jyouken_filled_html_error.html');
    throw new Error('住宅名（カナ）の入力欄が見つかりませんでした');
  }

  await input.fill('コーシャハイム', { timeout: 5000 });
  await snap(target, 'jyouken_filled.png');
  await saveHtml(target, 'jyouken_filled.html');
}

async function searchAndCaptureResult(target) {
  console.log('[step] click 検索する & wait result');

  // ページ上部側の「検索」ボタンを優先
  let btn = target.locator(
    'xpath=(//input[( @type="submit" or @type="button" ) and ( contains(@value,"検索") or contains(@alt,"検索") )])[1]'
  );

  if ((await btn.count().catch(() => 0)) === 0) {
    // onclick に search/kensaku を含む type=image 等
    btn = target.locator('xpath=(//input[contains(@onclick,"search") or contains(@onclick,"kensaku")])[1]');
  }

  if ((await btn.count().catch(() => 0)) === 0) {
    await snap(target, 'last_page_fallback.png');
    await saveHtml(target, 'last_page_fallback.html');
    throw new Error('検索ボタンが見つかりませんでした');
  }

  await btn.click({ timeout: 5000 }).catch(() => {});
  await target.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // 結果テーブルの「詳細」らしきを薄く待つ（なくても続行）
  await target.locator('text=詳細, xpath=//input[contains(@value,"詳細") or contains(@alt,"詳細")]')
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => {});

  await snap(target, 'result_list.png');
  await saveHtml(target, 'result_list.html');

  // ざっくり検証
  const hits = await target.locator('text=コーシャハイム').count().catch(() => 0);
  console.log('[verify] contains "コーシャハイム" in result:', hits > 0);
}

async function main() {
  await ensureArtifacts();

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-web-security', '--no-sandbox']
  });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ja-JP' });
  const page = await context.newPage();

  page.on('pageerror', async (err) => {
    console.error('[pageerror]', err);
    try { await snap(page, 'pageerror.png'); } catch {}
  });

  try {
    await openLanding(page);
    const condPage = await openConditions(page);   // popup or same-tab
    await fillKanaAndCapture(condPage);
    await searchAndCaptureResult(condPage);
    console.log('[done] all steps finished');
  } catch (e) {
    console.error('[fatal]', e);
    try {
      await snap(page, 'last_page_fallback.png');
      await saveHtml(page, 'last_page_fallback.html');
    } catch {}
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
