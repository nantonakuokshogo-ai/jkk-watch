// monitor.mjs — Puppeteer v23+ 安定版（ナビ待ちを非致命化）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== 設定 =====
const OUT_DIR = path.join(__dirname, 'out');
const BASE = 'https://jhomes.to-kousya.or.jp';
const TRY_URLS = [
  `${BASE}/`,
  `${BASE}/search/jkknet/`,
  `${BASE}/search/jkknet/index.html`,
  `${BASE}/search/jkknet/service/`,
];
const START_INIT = `${BASE}/search/jkknet/service/akiyaJyoukenStartInit`;

// 待ち系
const NAV_TIMEOUT = 20_000;        // クリック後の短いナビ待ち
const PAGE_TIMEOUT = 90_000;       // ページ操作タイムアウト
const PROTOCOL_TIMEOUT = 180_000;  // CDP プロトコル

// ===== 共通ユーティリティ =====
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

// ▼ クリック → “起きたら”だけ軽く待つ（起きなくてもOK・タイムアウトは握りつぶす）
async function clickByTextWithNav(page, text) {
  try {
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

    // URL変化 or ナビ発生 or timeout(=何も起きなかった) のいずれか早い方
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => null),
      page.waitForURL(u => u !== before, { timeout: NAV_TIMEOUT }).catch(() => null),
      sleep(NAV_TIMEOUT),
    ]);

    await sleep(600);
    return true;
  } catch {
    // ここで例外を投げない（次の手へ進ませる）
    return false;
  }
}

async function recoverApology(page) {
  const body = await page.evaluate(() => document.body.innerText || '');
  if (/おわび|エラー|ページが見つかりません|タイムアウト/i.test(body)) {
    const ok = await clickByTextWithNav(page, 'トップページへ戻る');
    if (ok) { await sleep(800); return true; }
  }
  return false;
}

// ===== メイン =====
async function main() {
  ensureDir(OUT_DIR);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: PROTOCOL_TIMEOUT,
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT);
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT);

  try {
    // 1) HOME 周りを順にトライ
    for (let i = 0; i < TRY_URLS.length; i++) {
      await goto(page, TRY_URLS[i], `home_${i + 1}`);
      await recoverApology(page);
      await snap(page, `home_${i + 1}_after`);
    }

    // 2) frameset を飛ばして StartInit
    console.log('[frameset] direct goto StartInit with referer=/service/');
    await page.setExtraHTTPHeaders({ referer: `${BASE}/search/jkknet/service/` });
    await goto(page, START_INIT, 'frameset_startinit');

    // 3) 「こちら」を最大 4 回試す（遷移しなくてもOK）
    for (let t = 1; t <= 4; t++) {
      const clicked = await clickByTextWithNav(page, 'こちら');
      await snap(page, `after_relay_${t}`);
      if (!clicked) break;
    }

    // 4) form submit（本体と子フレーム）— submit 後は軽く待つだけ
    const trySubmitIn = async (ctx, mark) => {
      let submitted = false;
      try {
        submitted = await ctx.evaluate(() => {
          const f = document.querySelector('form');
          if (f) { f.submit(); return true; }
          return false;
        });
      } catch {}
      if (submitted) await sleep(1000);
      await snap(page, `after_submit_${mark}`); // Frameはページ側で撮る
    };

    await trySubmitIn(page, 'main');
    for (const frame of page.mainFrame().childFrames()) {
      const tag = (frame.url().split('/').pop() || 'frame').slice(0, 40);
      await trySubmitIn(frame, tag);
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
