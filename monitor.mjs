// monitor.mjs  -- ESM（Node v20 / puppeteer-core 用）
// 使い方: node monitor.mjs
// 期待する環境変数: PUPPETEER_EXECUTABLE_PATH を workflows でセット（なくても自動検出）

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';
import puppeteer from 'puppeteer-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========= ユーザー設定 =========
const BASE = 'https://jhomes.to-kousya.or.jp/';
const OUT_DIR = path.join(__dirname, 'out');
const SEARCH_KANA = 'コーシャハイム';       // 「住宅名(カナ)」に入れる文字
const GOTO_TIMEOUT = 45000;                 // ページ遷移のタイムアウト
const PROTOCOL_TIMEOUT = 60000;             // CDP プロトコルタイムアウト
// =================================

// ---- ユーティリティ ----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function sanitize(name) {
  return name.replace(/[^\w\-一-龥ぁ-んァ-ヴー（）()・\u30FB]/g, '_').slice(0, 120);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, {recursive: true});
}

async function savePage(page, baseName) {
  const name = `${sanitize(baseName)}`;
  await ensureDir(OUT_DIR);
  const html = await page.content().catch(() => '');
  const htmlPath = path.join(OUT_DIR, `${name}.html`);
  await fsp.writeFile(htmlPath, html, 'utf8').catch(() => {});
  const pngPath = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({path: pngPath, fullPage: true}).catch(() => {});
  log(`[saved] ${name}`);
}

function log(...args) {
  console.log(...args);
}

// ---- Chrome 実行ファイルの決定 ----
function detectChromePathFromEnvAndCommonLocations() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  // 最後のフォールバック（PATH 解決に委ねる）
  return 'google-chrome-stable';
}

// ---- 汎用 goto ----
async function safeGoto(page, url, label) {
  log(`[goto] ${url}`);
  try {
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT});
  } catch (e) {
    // meta refresh などは DOMContentLoaded 前に終わることもあるので、軽く待って続行
    log(`[warn] goto timeout (continuing): ${e?.message ?? e}`);
  }
  await savePage(page, label ?? `page_${stamp()}`);
  await maybeRecoverApology(page);
}

// ---- タイムアウト/404/お詫びページからの復帰 ----
async function maybeRecoverApology(page) {
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const isApology =
    /タイムアウト|ページが見つかりません|しばらくたっても表示されない場合|トップページへ戻る/.test(text);
  if (!isApology) return;

  log('[recover] apology -> back to top');
  // トップへ戻るボタンを押す or 明示的に TOP へ
  const clicked = await page.evaluate(() => {
    const labels = ['トップページへ戻る', 'トップページへ', 'トップに戻る'];
    const els = Array.from(document.querySelectorAll('a, button, input[type=button], input[type=submit]'));
    for (const label of labels) {
      const el = els.find(e => (e.textContent || e.value || '').includes(label));
      if (el) { el.click(); return true; }
    }
    return false;
  }).catch(() => false);

  if (clicked) {
    try {
      await page.waitForNavigation({timeout: 8000, waitUntil: 'domcontentloaded'});
    } catch {}
  } else {
    await page.goto(BASE, {waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT}).catch(() => {});
  }
  await savePage(page, `home_${stamp()}`);
}

// ---- 新規ウィンドウ（popup）を拾う ----
async function waitPopupOrNewPage(browser, basePage, window = 12000) {
  const newPagePromise = new Promise(resolve => {
    const handler = async (page) => {
      try {
        // 直近で開いた page を返す
        resolve(page);
      } catch {
        resolve(null);
      }
    };
    browser.once('targetcreated', async (target) => {
      try {
        const p = await target.page().catch(() => null);
        if (p) handler(p);
      } catch { resolve(null); }
    });
    // 念のため page 'popup' イベントも
    basePage.once('popup', p => resolve(p));
  });

  const timeoutPromise = sleep(window).then(() => null);
  const result = await Promise.race([newPagePromise, timeoutPromise]);
  return result;
}

// ---- 「住宅名(カナ)」に入力して「検索する」をクリック ----
async function fillKanaAndSearch(page, kanaText) {
  // 候補: id/name に 'kana' を含む input
  let input = await page.$('input[id*="kana" i], input[name*="kana" i]');
  if (!input) {
    // ラベル文言から推測（直後の input）
    const xpath =
      `//label[contains(normalize-space(.),"住宅名") and (contains(normalize-space(.),"カナ") or contains(normalize-space(.),"（カナ"))]` +
      `/following::input[1]`;
    const handles = await page.$x(xpath);
    input = handles?.[0];
  }
  if (!input) {
    // テーブルの見出しなど
    const xpath2 =
      `//*[contains(normalize-space(.),"住宅名") and contains(normalize-space(.),"カナ")]` +
      `/following::input[@type="text"][1]`;
    const handles2 = await page.$x(xpath2);
    input = handles2?.[0];
  }

  if (!input) {
    log('[warn] kana input not found, skip typing');
  } else {
    await input.focus().catch(() => {});
    await page.keyboard.down('Control').catch(() => {});
    await page.keyboard.press('KeyA').catch(() => {});
    await page.keyboard.up('Control').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await input.type(kanaText, {delay: 20}).catch(() => {});
    await sleep(200);
  }

  // 「検索する」ボタン
  const btnCandidates = [
    'input[type="submit"][value*="検索"]',
    'button:has-text("検索する")',               // CSS4 セレクタはブラウザによるので後続の XPath で補完
  ];
  let clicked = false;

  for (const sel of btnCandidates) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await Promise.allSettled([
        page.waitForNavigation({timeout: 15000, waitUntil: 'domcontentloaded'}),
        el.click()
      ]);
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    const xp = `//input[@type="submit" and contains(@value,"検索")] | //button[contains(normalize-space(.),"検索")]`;
    const list = await page.$x(xp);
    if (list[0]) {
      await Promise.allSettled([
        page.waitForNavigation({timeout: 15000, waitUntil: 'domcontentloaded'}),
        list[0].click()
      ]);
      clicked = true;
    }
  }

  if (!clicked) {
    // 最終手段: Enter
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForNavigation({timeout: 12000, waitUntil: 'domcontentloaded'}).catch(() => {});
  }
}

// ---- メイン ----
async function main() {
  await ensureDir(OUT_DIR);

  const executablePath = detectChromePathFromEnvAndCommonLocations();
  log(`[monitor] Using Chrome at: ${executablePath}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    protocolTimeout: PROTOCOL_TIMEOUT,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({width: 1280, height: 1600});

    // 1) HOME
    await safeGoto(page, BASE, 'home_1');
    await savePage(page, 'home_1_after');

    // 2) /search/jkknet/
    await safeGoto(page, BASE + 'search/jkknet/', 'home_2');
    await savePage(page, 'home_2_after');

    // 3) /search/jkknet/index.html
    await safeGoto(page, BASE + 'search/jkknet/index.html', 'home_3');
    await savePage(page, 'home_3_after');

    // 4) /search/jkknet/service/
    await safeGoto(page, BASE + 'search/jkknet/service/', 'home_4');
    await savePage(page, 'home_4_after');

    // 5) StartInit（別ウィンドウを開くケースがある）
    await safeGoto(page, BASE + 'search/jkknet/service/akiyaJyoukenStartInit', 'frameset_startinit');

    // 新規ウィンドウ or 現ウィンドウ遷移を待つ
    const popup = await waitPopupOrNewPage(browser, page, 12000);
    let workPage = popup || page;

    // もしまだ frameset/リレー途中なら、しばし待ってから最新の page を採用
    await sleep(1500);
    const pages = await browser.pages();
    if (pages.length > 1) {
      workPage = pages[pages.length - 1];
    }

    // 中継後の画面保存（“after_relay”）
    await savePage(workPage, 'after_relay_1');

    // ======= ここから検索画面での操作 =======
    // 入力 → 検索
    await fillKanaAndSearch(workPage, SEARCH_KANA);

    // 検索結果（または検索後の同一画面）を保存
    await savePage(workPage, 'after_submit_main');

    // 最終スナップ
    await savePage(workPage, 'final');

  } catch (err) {
    log(err);
    // 失敗スナップ（可能なら）
    try {
      const pages = await browser.pages();
      const p = pages[pages.length - 1];
      if (p) await savePage(p, 'final_error');
    } catch {}
    // エラー終了（Artifacts は workflow 側で if: always() ならアップロードされます）
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
