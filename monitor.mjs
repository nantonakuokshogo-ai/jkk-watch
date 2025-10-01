// monitor.mjs  -- ESM（Node v20 / puppeteer-core）
// 実行: node monitor.mjs

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== 設定 =====
const BASE = 'https://jhomes.to-kousya.or.jp/';
const OUT_DIR = path.join(__dirname, 'out');
const SEARCH_KANA = 'コーシャハイム';
const GOTO_TIMEOUT = 45000;
const PROTOCOL_TIMEOUT = 60000;
// ================

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function sanitize(name) {
  return name.replace(/[^\w\-一-龥ぁ-んァ-ヴー（）()・\u30FB]/g, '_').slice(0, 120);
}
async function ensureDir(d) { await fsp.mkdir(d, { recursive: true }); }
function log(...a){ console.log(...a); }

async function savePage(page, baseName) {
  const name = sanitize(baseName);
  await ensureDir(OUT_DIR);
  try {
    const html = await page.content();
    await fsp.writeFile(path.join(OUT_DIR, `${name}.html`), html, 'utf8');
  } catch {}
  try {
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
  } catch {}
  log(`[saved] ${name}`);
}

function detectChromePathFromEnvAndCommonLocations() {
  const cands = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of cands) try { if (fs.existsSync(p)) return p; } catch {}
  return 'google-chrome-stable';
}

async function safeGoto(page, url, label) {
  log(`[goto] ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT });
  } catch (e) {
    log(`[warn] goto timeout (continue): ${e?.message ?? e}`);
  }
  await savePage(page, label ?? `page_${stamp()}`);
  await maybeRecoverApology(page);
}

async function maybeRecoverApology(page) {
  let bodyText = '';
  try { bodyText = await page.evaluate(() => document.body?.innerText ?? ''); } catch {}
  const bad = /タイムアウト|ページが見つかりません|しばらくたっても表示されない場合|トップページへ戻る/.test(bodyText);
  if (!bad) return;

  log('[recover] apology -> back to top');
  try {
    const clicked = await page.evaluate(() => {
      const labels = ['トップページへ戻る', 'トップページへ', 'トップに戻る'];
      const els = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]'));
      for (const label of labels) {
        const el = els.find(e => (e.textContent || e.value || '').includes(label));
        if (el) { el.click(); return true; }
      }
      return false;
    });
    if (clicked) {
      try { await page.waitForNavigation({ timeout: 8000, waitUntil: 'domcontentloaded' }); } catch {}
    } else {
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT }).catch(()=>{});
    }
  } catch {}
  await savePage(page, `home_${stamp()}`);
}

// ---- DOM ヘルパ: XPath 使わずに「カナ」入力欄を推測して返す ----
async function findKanaInputHandle(page) {
  // まずは素直に id/name に kana を含むもの
  try {
    const h = await page.$('input[id*="kana" i], input[name*="kana" i]');
    if (h) return h;
  } catch {}

  // ラベルや周辺テキストからスコアリングして最尤の input を返す
  const handle = await page.evaluateHandle(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), input[type="search"]'));
    const score = (el) => {
      const id = el.id || '';
      const name = el.name || '';
      const ph = el.placeholder || '';
      const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      const labText = (lab?.innerText || '');
      const near = el.closest('tr,td,th,div,li,fieldset,section,form');
      const nearText = (near?.innerText || '');
      const blob = [id, name, ph, labText, nearText].join(' ');
      let s = 0;
      if (/[カｶ]ナ/.test(blob)) s += 8;
      if (/住宅名/.test(blob)) s += 6;
      if (/カナ/.test(ph)) s += 3;
      if (/フリガナ|ふりがな/.test(blob)) s += 2;
      return s;
    };
    let best = null, bestScore = -1;
    for (const el of inputs) {
      const sc = score(el);
      if (sc > bestScore) { bestScore = sc; best = el; }
    }
    return best;
  });
  const el = handle.asElement?.() ?? null;
  return el || null;
}

// ---- DOM ヘルパ: 「検索する」ボタンを見つけてクリック ----
async function clickSearchAndWait(page) {
  // 候補をページ内で探す（XPath 非依存）
  const btn = await page.evaluateHandle(() => {
    const isSearchBtn = (el) => {
      const t = (el.textContent || el.value || '').replace(/\s+/g, '');
      return /検索する|検索|さがす/.test(t);
    };
    const q1 = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button'));
    let cand = q1.find(isSearchBtn);
    if (cand) return cand;
    // 画像等に隠れている場合、aria-label/タイトルも見る
    cand = q1.find(el => /検索/.test(el.getAttribute('aria-label') || '') || /検索/.test(el.title || ''));
    return cand || null;
  });
  const el = btn.asElement?.() ?? null;

  if (el) {
    await Promise.allSettled([
      page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }),
      el.click().catch(()=>{})
    ]);
    return true;
  }

  // 見つからなければ Enter 送信
  await page.keyboard.press('Enter').catch(()=>{});
  await page.waitForNavigation({ timeout: 12000, waitUntil: 'domcontentloaded' }).catch(()=>{});
  return true;
}

// ---- 「住宅名(カナ)」を入れて検索 ----
async function fillKanaAndSearch(page, text) {
  let input = await findKanaInputHandle(page);
  if (!input) {
    log('[warn] kana input not found, skip typing');
  } else {
    try {
      await input.focus();
      // 全消去 → 入力
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.type(await page.evaluate(el=>el.name||el.id||'', input), ''); // no-op guard
      await input.type(text, { delay: 20 });
      await sleep(200);
    } catch {
      log('[warn] failed to type kana');
    }
  }

  await clickSearchAndWait(page);
}

// ---- popup / new page の拾い上げ ----
async function waitPopupOrNewPage(browser, basePage, window = 12000) {
  const newPagePromise = new Promise(resolve => {
    const resolvePage = async (target) => {
      try {
        const p = await target.page();
        if (p) resolve(p);
      } catch { resolve(null); }
    };
    browser.once('targetcreated', resolvePage);
    basePage.once('popup', p => resolve(p));
  });
  const result = await Promise.race([newPagePromise, sleep(window).then(()=>null)]);
  return result;
}

// ---- main ----
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
    await page.setViewport({ width: 1280, height: 1600 });

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

    // 5) StartInit（frameset/リレー）
    await safeGoto(page, BASE + 'search/jkknet/service/akiyaJyoukenStartInit', 'frameset_startinit');

    let workPage = await waitPopupOrNewPage(browser, page, 12000) || page;
    await sleep(1500);
    const pages = await browser.pages();
    if (pages.length > 1) workPage = pages[pages.length - 1];

    await savePage(workPage, 'after_relay_1');

    // ======= 検索入力 & 実行 =======
    await fillKanaAndSearch(workPage, SEARCH_KANA);

    await savePage(workPage, 'after_submit_main');
    await savePage(workPage, 'final');

  } catch (err) {
    log(err);
    try {
      const pages = await browser.pages();
      const p = pages[pages.length - 1];
      if (p) await savePage(p, 'final_error');
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close().catch(()=>{});
  }
}

main().catch(e => { console.error(e); process.exit(1); });
