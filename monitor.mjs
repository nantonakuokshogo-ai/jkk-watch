// monitor.mjs — Puppeteer v23+ 安定・ナビゲーション待ち強化版
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========= 設定 =========
const OUT_DIR = path.join(__dirname, 'out');
const BASE = 'https://jhomes.to-kousya.or.jp';
const TRY_URLS = [
  `${BASE}/`,
  `${BASE}/search/jkknet/`,
  `${BASE}/search/jkknet/index.html`,
  `${BASE}/search/jkknet/service/`,
];
const START_INIT = `${BASE}/search/jkknet/service/akiyaJyoukenStartInit`;

// 待ちの設定（必要ならここを上げる）
const NAV_TIMEOUT = 12_000;     // クリック後の短いナビ待ち
const PAGE_TIMEOUT = 60_000;    // page のタイムアウト
const PROTOCOL_TIMEOUT = 120_000; // CDP プロトコルのタイムアウト

// ========= ユーティリティ =========
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (d) => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };

async function snap(page, name) {
  ensureDir(OUT_DIR);
  try { await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true }); } catch {}
  try { fs.writeFileSync(path.join(OUT_DIR, `${name}.html`), await page.content()); } catch {}
  console.log(`[saved] ${name}`);
}

async function goto(page, url, name) {
  console.log(`[goto] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  await sleep(700);
  await snap(page, name);
}

// クリック → 短いナビ待ち（遷移しない場合は待ちを無視）
async function clickByTextWithNav(page, text) {
  const before = page.url();
  const clicked = await page.evaluate((txt) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const nodes = [
      ...document.querySelectorAll('a,button,input[type="submit"],input[type="button"]'),
    ];
    for (const el of nodes) {
      const label = norm(el.innerText || el.value || el.getAttribute('aria-label') || '');
      if (label.includes(txt)) { el.click(); return true; }
    }
    return false;
  }, text);

  if (!clicked) return false;

  // 短いナビ待ち（遷移しない場合は握り潰す）
  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }),
      page.waitForURL((u) => u !== before, { timeout: NAV_TIMEOUT }),
    ]);
  } catch {} // 遷移しなければOK
  await sleep(600);
  return true;
}

async function recoverApology(page) {
  const body = await page.evaluate(() => document.body.innerText || '');
  if (/おわび|エラー|ページが見つかりません|タイムアウト/i.test(body)) {
    const ok = await clickByTextWithNav(page, 'トップページへ戻る');
    if (ok) { await sleep(800); return true; }
  }
  return false;
}

// submit 後に軽く待つ（フレームでもOK）。ナビ有無は問わない。
async function submitFormIn(ctx) {
  const did = await ctx.evaluate(() => {
    const f = document.querySelector('form');
    if (f) { f.submit(); return true; }
    return false;
  });
  if (did) await sleep(1000);
  return did;
}

async function main() {
  ensureDir(OUT_DIR);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: PROTOCOL_TIMEOUT,                    // ★ 追加
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT);                   // ★ 追加
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT);         // ★ 追加

  try {
    // 1) HOME 4 通りトライ
    for (let i = 0; i < TRY_URLS.length; i++) {
      await goto(page, TRY_URLS[i], `home_${i + 1}`);
      await recoverApology(page);
      await snap(page, `home_${i + 1}_after`);
    }

    // 2) frameset を飛ばして StartInit
    console.log('[frameset] direct goto StartInit with referer=/service/');
    await page.setExtraHTTPHeaders({ referer: `${BASE}/search/jkknet/service/` });
    await goto(page, START_INIT, 'frameset_startinit');

    // 3) 「こちら」を最大 4 回試す（クリック → 短いナビ待ち）
    for (let t = 1; t <= 4; t++) {
      const clicked = await clickByTextWithNav(page, 'こちら');
      await snap(page, `after_relay_${t}`);
      if (!clicked) break;
    }

    // 4) submit（main と子フレーム）。直後に小休止しつつ Page 側で撮影
    if (await submitFormIn(page)) await sleep(600);
    await snap(page, 'after_submit_main');

    for (const frame of page.mainFrame().childFrames()) {
      if (await submitFormIn(frame)) await sleep(600);
      // Frame は screenshot 不可 → Page 側で保存
      const tag = (frame.url().split('/').pop() || 'frame').slice(0, 40);
      await snap(page, `after_submit_${tag}`);
    }

    // 5) 最終保存
    await snap(page, 'final');
  } catch (e) {
    console.error(e);
    await snap(page, 'final_error');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
