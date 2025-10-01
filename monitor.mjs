// monitor.mjs  — ESM/puppeteer 安定版
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

// ========= ユーティリティ =========
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

async function snap(page, name) {
  ensureDir(OUT_DIR);
  const png = path.join(OUT_DIR, `${name}.png`);
  const html = path.join(OUT_DIR, `${name}.html`);
  try {
    await page.screenshot({ path: png, fullPage: true });
  } catch {}
  try {
    const c = await page.content();
    fs.writeFileSync(html, c);
  } catch {}
  console.log(`[saved] ${name}`);
}

async function goto(page, url, name) {
  console.log(`[goto] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(800);
  await snap(page, name);
}

async function clickIfExists(page, text) {
  // aボタン/リンクを日本語テキストで探してクリック
  const handles = await page.$x(`//a[contains(normalize-space(.),'${text}')] | //button[contains(normalize-space(.),'${text}')]`);
  if (handles.length) {
    await handles[0].click();
    await sleep(600);
    return true;
  }
  return false;
}

async function recoverApology(page) {
  // 「おわび」「エラー」「トップページへ戻る」系を踏んだらトップへ戻す
  const body = await page.evaluate(() => document.body.innerText || '');
  if (/おわび|エラー|ページが見つかりません|タイムアウト/i.test(body)) {
    const ok = await clickIfExists(page, 'トップページへ戻る');
    if (ok) {
      await sleep(800);
      return true;
    }
  }
  return false;
}

// ========= メインフロー =========
async function main() {
  ensureDir(OUT_DIR);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();

  try {
    // 1) HOME 系を順に試す（途中でエラー画面なら「トップページへ戻る」を押す）
    for (let i = 0; i < TRY_URLS.length; i++) {
      await goto(page, TRY_URLS[i], `home_${i + 1}`);
      await recoverApology(page);
      await snap(page, `home_${i + 1}_after`);
    }

    // 2) framesetを飛ばして StartInit に直アクセス（referer付きで素直に）
    console.log('[frameset] direct goto StartInit with referer=/service/');
    await page.setExtraHTTPHeaders({ referer: `${BASE}/search/jkknet/service/` });
    await goto(page, START_INIT, 'frameset_startinit');

    // 3) よく出る「こちら」を押下（リレー用リンク）
    for (let t = 1; t <= 4; t++) {
      const clicked = await clickIfExists(page, 'こちら');
      await snap(page, `after_relay_${t}`);
      if (!clicked) break;
    }

    // 4) formがあれば submit を試す（フレームと本体の両方）
    const trySubmitIn = async (ctx, label) => {
      const forms = await ctx.$$('form');
      if (forms.length) {
        try {
          await ctx.evaluate(() => {
            const f = document.querySelector('form');
            f && f.submit();
          });
          await sleep(800);
        } catch {}
        await snap(ctx, `after_submit_${label}`);
      }
    };

    await trySubmitIn(page, 'main');

    // frame 内も
    for (const frame of page.mainFrame().childFrames()) {
      await trySubmitIn(frame, frame.url().split('/').pop() || 'frame');
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
