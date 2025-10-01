// monitor.mjs

import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL ?? 'https://jhomes.to-kousya.or.jp';
const EXECUTABLE_PATH =
  process.env.CHROME_PATH || process.env.PUPPETEER_EXEC_PATH || '/usr/bin/google-chrome';
const OUT_DIR = process.env.OUT_DIR || '.';
const KANA_VALUE = process.env.KANA || 'コーシャハイム';

function log(...args) { console.log(...args); }

async function ensureViewport(page) {
  const vp = page.viewport();
  if (!vp || !vp.width || !vp.height) {
    await page.setViewport({ width: 1280, height: 2200, deviceScaleFactor: 1 });
  }
}

async function saveHTMLandPNG(page, name, htmlOverride) {
  await ensureViewport(page);
  const html = htmlOverride ?? await page.content();
  const htmlPath = path.join(OUT_DIR, `${name}.html`);
  const pngPath  = path.join(OUT_DIR, `${name}.png`);
  await fs.writeFile(htmlPath, html, 'utf-8');
  await page.screenshot({ path: pngPath, fullPage: true });
  log(`[saved] ${name}`);
}

async function saveFrameSnapshot(page, frame, name) {
  const html = await frame.evaluate(() => document.documentElement.outerHTML);
  await saveHTMLandPNG(page, name, html);
}

async function gotoWithReferer(page, url, referer) {
  const abs = url.startsWith('http') ? url : new URL(url, BASE).toString();
  const opts = { waitUntil: 'networkidle2' };
  if (referer) opts.referer = referer;
  log('[goto]', new URL(abs).pathname);
  await page.goto(abs, opts);
}

function normalizeTextForMatch(s) {
  return s.replace(/[ \u3000\r\n\t]+/g, ' ').replace(/[()（）\[\]【】]/g, '').trim();
}

/* ============ ここが今回のポイント：Frame 用 XPath ヘルパ ============ */
async function $xOne(frame, xpath) {
  const handle = await frame.evaluateHandle((xp) => {
    const res = document.evaluate(
      xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    );
    return res.singleNodeValue;
  }, xpath);
  const el = handle.asElement?.();
  if (el) return el;
  await handle.dispose();
  return null;
}
/* =================================================================== */

async function findFrameByLabel(page, a, b) {
  for (const f of page.frames()) {
    try {
      const has = await f.evaluate((aa, bb) => {
        const text = document.body ? document.body.innerText : '';
        const norm = (t)=> t.replace(/[ \u3000\r\n\t]+/g,' ').trim();
        const body = norm(text);
        return body.includes(aa) && body.includes(bb);
      }, a, b);
      if (has) return f;
    } catch {}
  }
  return null;
}

async function findKanaInputInFrame(frame) {
  const xps = [
    '//*[contains(normalize-space(string(.)),"住宅名") and contains(normalize-space(string(.)),"カナ")]/ancestor::tr[1]//input[not(@type) or translate(@type,"TEXT","text")="text"][1]',
    '//*[contains(normalize-space(string(.)),"住宅") and contains(normalize-space(string(.)),"カナ")]/ancestor::tr[1]//input[not(@type) or translate(@type,"TEXT","text")="text"][1]',
    '//*[contains(normalize-space(string(.)),"住宅名") and contains(normalize-space(string(.)),"カナ")]/following::input[not(@type) or translate(@type,"TEXT","text")="text"][1]',
  ];
  for (const xp of xps) {
    const el = await $xOne(frame, xp);
    if (el) return el;
  }
  const attrGuess = await frame.$('input[name*="kana" i], input[name*="Kana" i], input[name*="KANA" i]');
  if (attrGuess) return attrGuess;
  const firstText = await frame.$('form input[type="text"], form input:not([type])');
  return firstText ?? null;
}

async function clickSearchInFrame(frame) {
  // まず CSS で拾えるものを広く
  const css = [
    'input[type="submit"][value="検索する"]',
    'input[type="image"][alt="検索する"]',
    'input[type="submit"][value*="検索"]',
    'input[alt*="検索"]',
  ];
  for (const sel of css) {
    const el = await frame.$(sel);
    if (el) { await el.click(); return true; }
  }
  // テキスト入りボタンは XPath で
  const xp = [
    '//button[contains(normalize-space(.),"検索する")]',
    '//*[self::a or self::span or self::div][contains(normalize-space(.),"検索する")]',
  ];
  for (const x of xp) {
    const el = await $xOne(frame, x);
    if (el) { await el.click(); return true; }
  }
  return false;
}

async function passRelayAndGetMainPage(browser, currentPage) {
  if (currentPage.frames().length > 1) return currentPage;
  const targetPromise = new Promise((resolve) => {
    const handler = async (target) => {
      if (target.type() === 'page') {
        const p = await target.page();
        setTimeout(() => resolve(p), 500);
        browser.off('targetcreated', handler);
      }
    };
    browser.on('targetcreated', handler);
    setTimeout(() => resolve(currentPage), 5000);
  });

  try {
    await currentPage.evaluate(() => {
      if (typeof submitNext === 'function') submitNext();
      else {
        const f = document.forms && document.forms.namedItem('forwardForm');
        if (f) f.submit();
      }
    });
  } catch {}
  const popup = await targetPromise;
  if (popup !== currentPage) { try { await ensureViewport(popup); } catch {} return popup; }
  return currentPage;
}

async function isApologyLike(page){
  try{
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    const t = normalizeTextForMatch(text);
    return t.includes('ページが見つかりません') || t.includes('おわび');
  }catch{ return false; }
}

async function main(){
  log('[monitor] Using Chrome at:', EXECUTABLE_PATH);
  const browser = await puppeteer.launch({
    executablePath: EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await ensureViewport(page);

  // 1) TOP
  await gotoWithReferer(page, '/', null);
  await saveHTMLandPNG(page, 'home_1');

  // 2) 検索トップ
  await gotoWithReferer(page, '/search/jkknet/', `${BASE}/`);
  await saveHTMLandPNG(page, 'home_1_after');
  await saveHTMLandPNG(page, 'home_2');

  // 3) index
  await gotoWithReferer(page, '/search/jkknet/index.html', `${BASE}/search/jkknet/`);
  await saveHTMLandPNG(page, 'home_2_after');
  await saveHTMLandPNG(page, 'home_3');

  // 4) service
  await gotoWithReferer(page, '/search/jkknet/service/', `${BASE}/search/jkknet/index.html`);
  await saveHTMLandPNG(page, 'home_3_after');
  await saveHTMLandPNG(page, 'home_4');

  // 5) StartInit
  log('[frameset] direct goto StartInit with referer=/service/');
  await gotoWithReferer(page, '/search/jkknet/service/akiyaJyoukenStartInit', `${BASE}/search/jkknet/service/`);
  await saveHTMLandPNG(page, 'home_4_after');
  await saveHTMLandPNG(page, 'frameset_startinit');

  // 6) 中継→新ウィンドウ
  const workingPage = await passRelayAndGetMainPage(browser, page);
  await saveHTMLandPNG(workingPage, 'after_relay_1');

  // 7) 入力フレーム
  const searchFrame =
    await findFrameByLabel(workingPage, '住宅名', 'カナ') ||
    workingPage.frames().find(f => /検索/.test((f.url() || ''))) ||
    workingPage.mainFrame();

  if (!searchFrame) {
    await saveHTMLandPNG(workingPage, 'before_fill');
    throw new Error('検索フォームのフレームが見つかりませんでした。');
  }

  await saveFrameSnapshot(workingPage, searchFrame, 'before_fill');

  // 8) 入力欄
  const kanaInput = await findKanaInputInFrame(searchFrame);
  if (!kanaInput) {
    await saveFrameSnapshot(workingPage, searchFrame, 'final_error');
    throw new Error('住宅名(カナ) の入力欄が見つかりませんでした。');
  }
  await kanaInput.click({ clickCount: 3 });
  await kanaInput.type(KANA_VALUE);

  // 9) 検索
  const clicked = await clickSearchInFrame(searchFrame);
  if (!clicked) {
    await saveFrameSnapshot(workingPage, searchFrame, 'final_error');
    throw new Error('「検索する」ボタンが見つかりませんでした。');
  }

  try { await workingPage.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }); } catch {}

  const afterFrame =
    await findFrameByLabel(workingPage, '検索', '結果') || searchFrame;

  await saveFrameSnapshot(workingPage, afterFrame, 'after_submit_main');
  await saveHTMLandPNG(workingPage, 'final');

  await browser.close();
}

main().catch((err) => {
  console.error('Error:', err?.message || err);
  process.exit(1);
});
