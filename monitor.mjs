// monitor.mjs
// 目的:
// 1) JKK TOP を開く（to-kousya 優先、ダメなら jkk-portal/jkk）
// 2) 「こだわり条件」を開く（同タブ/ポップアップ両対応）
// 3) 住宅名（カナ）に「コーシャハイム」を入力 → 検索 → 一覧保存
// 4) 各段階で HTML/PNG を artifacts/ に保存（失敗時は last_page_fallback も保存）

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// =============== 共通ユーティリティ ===============
const ART_DIR = path.resolve('artifacts');

async function ensureArtDir() {
  await fs.mkdir(ART_DIR, { recursive: true });
}

function logStep(msg) {
  console.log(`[step] ${msg}`);
}
function logInfo(msg) {
  console.log(`[info] ${msg}`);
}
function logFatal(err) {
  console.error('[fatal]', err);
}

async function savePage(page, base) {
  const htmlPath = path.join(ART_DIR, `${base}.html`);
  const pngPath  = path.join(ART_DIR, `${base}.png`);

  const html = await page.content();
  await fs.writeFile(htmlPath, html);
  await page.screenshot({ path: pngPath, fullPage: true });
  logInfo(`[artifacts] saved: ${base}.html / ${base}.png`);
}

async function saveLastFallback(page) {
  try {
    await savePage(page, 'last_page_fallback');
  } catch {
    // 失敗時でもとりあえず HTML だけ試す
    try {
      const htmlPath = path.join(ART_DIR, `last_page_fallback.html`);
      await fs.writeFile(htmlPath, await page.content());
      logInfo(`[artifacts] saved: last_page_fallback.html`);
    } catch { /* no-op */ }
  }
}

// 「数秒後に自動で… こちら」タイプの自動遷移を踏む
async function followAutoForward(page) {
  const a = page.locator('a:has-text("こちら")');
  if (await a.count()) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      a.first().click().catch(() => {})
    ]);
  }
}

// =============== 1. TOP へ移動（複数URL/リトライ） ===============
const LANDING_CANDIDATES = [
  // 公式の「JKK東京（住宅者向け）」TOP配下
  'https://www.to-kousya.or.jp/jkk/',
  // 過去の URL（保険）
  'https://www.jkk-portal.jp/',
  'https://jkk-portal.jp/',
];

async function gotoWithRetries(page, urls, eachTries = 3) {
  for (const u of urls) {
    for (let i = 1; i <= eachTries; i++) {
      try {
        logInfo(`[goto] (${i}/${eachTries}) ${u}`);
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await followAutoForward(page);
        return true;
      } catch (e) {
        logInfo(`[goto-retry] ${u} -> ${e.message || e}`);
        const sleep = 600 * i;
        await new Promise(r => setTimeout(r, sleep));
      }
    }
  }
  return false;
}

async function gotoLanding(page) {
  logStep('goto landing (prefer to-kousya)');
  const ok = await gotoWithRetries(page, LANDING_CANDIDATES, 3);
  if (!ok) throw new Error('TOPへ到達できませんでした');
  await savePage(page, 'landing');
}

// =============== 2. こだわり条件 を開く（同タブ/ポップアップ両対応） ===============
async function clickConditions(page) {
  logStep('open conditions (こだわり条件)');

  // Cookie等の閉じる（あれば）
  await page
    .locator('button:has-text("閉じる"), button:has-text("同意"), button:has-text("同意する")')
    .first()
    .click({ timeout: 2000 })
    .catch(() => {});

  // 候補セレクタ
  const candidates = [
    // TOP 中央の大きいボタンが button>span のこともある
    'button:has-text("こだわり")',
    'button:has-text("条件")',
    // a リンクのこともある
    'a:has-text("こだわり")',
    'a:has-text("条件")',
    // フォールバック: href に search/akiya/などが入ることがある
    'a[href*="search"]',
    'a[href*="akiya"]',
  ];

  let target = null;
  for (const sel of candidates) {
    const l = page.locator(sel).first();
    if (await l.count().catch(() => 0)) {
      target = l;
      break;
    }
  }

  // 最終フォールバック: DOM走査で「こだわり」を含む a/button をクリック
  if (!target) {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a,button')].find(
        x => /こだわり|条件/.test((x.textContent || '').trim())
      );
      el?.click();
    });
  } else {
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }).catch(() => null),
      target.click().catch(() => null)
    ]);
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      await followAutoForward(popup);
      return popup;
    }
  }

  // 同タブ遷移だった場合
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await followAutoForward(page);
  return page;
}

// =============== 3. 入力 → 検索 → 一覧保存 ===============
async function fillAndSearch(condPage) {
  logStep('fill keyword & search');

  // 住宅名（カナ）入力欄の候補
  const inputCandidates = [
    // アクセシビリティラベル
    condPage.getByLabel(/住宅名（?カナ）?/),
    // ありそうな name/placeholder/title
    condPage.locator('input[name*="kana"]').first(),
    condPage.locator('input[placeholder*="カナ"]').first(),
    condPage.locator('input[title*="カナ"]').first(),
  ];

  let filled = false;
  for (const c of inputCandidates) {
    try {
      if (await c.count()) {
        await c.fill('コーシャハイム', { timeout: 4000 });
        filled = true;
        break;
      }
    } catch { /* next */ }
  }
  if (!filled) {
    // ラストリゾート: DOM 走査で「カナ」っぽい input を拾う
    await condPage.evaluate(() => {
      const el = [...document.querySelectorAll('input')]
        .find(i => /カナ|kana/i.test(
          (i.getAttribute('name') || '') +
          (i.getAttribute('placeholder') || '') +
          (i.getAttribute('title') || '')
        ));
      if (el) {
        el.focus();
        el.value = 'コーシャハイム';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }

  // 「検索」ボタンを押す
  const searchCandidates = [
    'button:has-text("検索")',
    'button:has-text("さがす")',
    'input[type="submit"][value*="検索"]',
    'input[type="image"][alt*="検索"]',
  ];
  let clicked = false;
  for (const sel of searchCandidates) {
    const btn = condPage.locator(sel).first();
    if (await btn.count()) {
      await Promise.all([
        condPage.waitForLoadState('domcontentloaded').catch(() => {}),
        btn.click().catch(() => {}),
      ]);
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    // 最後の手段: 「検索」を含むボタン風要素をクリック
    await condPage.evaluate(() => {
      const ok = [...document.querySelectorAll('button,input[type="submit"],input[type="image"]')]
        .find(el => /検索|さがす/.test(el.value || el.alt || el.textContent || ''));
      ok?.click();
    });
    await condPage.waitForLoadState('domcontentloaded').catch(() => {});
  }

  await followAutoForward(condPage);

  // 一覧を保存（名前は result_list）
  await savePage(condPage, 'result_list');
}

// =============== main ===============
async function main() {
  await ensureArtDir();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 2000 },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  try {
    await gotoLanding(page);                 // TOP 保存: landing.html/png
    const condPage = await clickConditions(page); // 同タブ or ポップアップ Page
    await savePage(condPage, 'popup_top');   // 条件ページも一応保存
    await fillAndSearch(condPage);           // 入力→検索→一覧保存
  } catch (e) {
    logFatal(e);
    try { await saveLastFallback(page); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
