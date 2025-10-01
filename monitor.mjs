// monitor.mjs — ESM / Puppeteer v23+ 安定版
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

// ===== 共通ユーティリティ =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

async function snap(page, name) {
  ensureDir(OUT_DIR);
  try { await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true }); } catch {}
  try { fs.writeFileSync(path.join(OUT_DIR, `${name}.html`), await page.content()); } catch {}
  console.log(`[saved] ${name}`);
}

async function goto(page, url, name) {
  console.log(`[goto] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(800);
  await snap(page, name);
}

// --- Puppeteer v23+ 互換：テキスト一致でクリック（$x 非依存）
async function clickByText(pageOrFrame, text) {
  const clicked = await pageOrFrame.evaluate((txt) => {
    const candidates = [
      ...document.querySelectorAll('a,button,input[type="submit"],input[type="button"]'),
    ];
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    for (const el of candidates) {
      const label = norm(el.innerText || el.value || el.getAttribute('aria-label') || '');
      if (label.includes(txt)) {
        el.click();
        return true;
      }
    }
    return false;
  }, text);
  if (clicked) await sleep(600);
  return clicked;
}

async function recoverApology(page) {
  const body = await page.evaluate(() => document.body.innerText || '');
  if (/おわび|エラー|ページが見つかりません|タイムアウト/i.test(body)) {
    const ok = await clickByText(page, 'トップページへ戻る');
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
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();

  try {
    // 1) HOME 周りを順にトライ
    for (let i = 0; i < TRY_URLS.length; i++) {
      await goto(page, TRY_URLS[i], `home_${i + 1}`);
      await recoverApology(page);
      await snap(page, `home_${i + 1}_after`);
    }

    // 2) frameset を飛ばして StartInit へ
    console.log('[frameset] direct goto StartInit with referer=/service/');
    await page.setExtraHTTPHeaders({ referer: `${BASE}/search/jkknet/service/` });
    await goto(page, START_INIT, 'frameset_startinit');

    // 3) 「こちら」を最大4回まで踏む（あれば）
    for (let t = 1; t <= 4; t++) {
      const clicked = await clickByText(page, 'こちら');
      await snap(page, `after_relay_${t}`);
      if (!clicked) break;
    }

    // 4) form submit（本体と子フレーム）
    const trySubmitIn = async (ctx, mark) => {
      const submitted = await ctx.evaluate(() => {
        const f = document.querySelector('form');
        if (f) { f.submit(); return true; }
        return false;
      });
      if (submitted) await sleep(800);
      // スクショは常に page で撮る（Frameは screenshot を持たないため）
      await snap(page, `after_submit_${mark}`);
    };

    await trySubmitIn(page, 'main');

    // 子フレームにも submit を試行
    for (const frame of page.mainFrame().childFrames()) {
      await trySubmitIn(frame, (frame.url().split('/').pop() || 'frame'));
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
