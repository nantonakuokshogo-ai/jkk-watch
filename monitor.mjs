// monitor.mjs — Puppeteer v23+ / popup捕捉強化・安定版
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== 設定 ======
const OUT_DIR = path.join(__dirname, 'out');
const BASE = 'https://jhomes.to-kousya.or.jp';
const TRY_URLS = [
  `${BASE}/`,
  `${BASE}/search/jkknet/`,
  `${BASE}/search/jkknet/index.html`,
  `${BASE}/search/jkknet/service/`,
];
const START_INIT = `${BASE}/search/jkknet/service/akiyaJyoukenStartInit`;

// タイムアウト（少し長めに）
const NAV_TIMEOUT = 20_000;         // クリック後の短いナビ待ち
const PAGE_TIMEOUT = 90_000;        // ページ操作タイムアウト
const PROTOCOL_TIMEOUT = 180_000;   // CDP タイムアウト
const POPUP_TIMEOUT = 20_000;       // popup 待ち

// ====== ユーティリティ ======
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

// クリック → 起きたらだけ軽く待つ（起きなくてもOK）
async function clickByTextWithNav(page, text) {
  try {
    const before = page.url();
    const clicked = await page.evaluate((txt) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const nodes = [...document.querySelectorAll('a,button,input[type="submit"],input[type="button"]')];
      for (const el of nodes) {
        const label = norm(el.innerText || el.value || el.getAttribute('aria-label') || '');
        if (label.includes(txt)) { el.click(); return true; }
      }
      return false;
    }, text);
    if (!clicked) return false;

    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => null),
      page.waitForURL(u => u !== before, { timeout: NAV_TIMEOUT }).catch(() => null),
      sleep(NAV_TIMEOUT),
    ]);
    await sleep(600);
    return true;
  } catch { return false; }
}

async function recoverApology(page) {
  const body = await page.evaluate(() => document.body.innerText || '');
  if (/おわび|エラー|ページが見つかりません|タイムアウト/i.test(body)) {
    const ok = await clickByTextWithNav(page, 'トップページへ戻る');
    if (ok) { await sleep(800); return true; }
  }
  return false;
}

// ==== popup 捕捉（最重要）====
// 1) 「こちら」クリック前に popup 待ちを開始
// 2) クリック／submit をトリガー
// 3) popup が来たらそれを返す。来ない時は全ページ走査で拾う。
async function clickAndCatchPopup(browser, page, triggerFn, tagPrefix) {
  // 既存タブの記録
  const beforePages = await browser.pages();

  // 先に待受
  const popupP = page.waitForEvent('popup', { timeout: POPUP_TIMEOUT }).catch(() => null);

  // トリガー（「こちら」クリック or form.submit など）
  let triggered = false;
  try { triggered = await triggerFn(); } catch { triggered = false; }

  // まずは待受の結果を待つ
  let popup = await popupP;

  // 来なかったら新規タブ走査（待ってから差分を見る）
  if (!popup) {
    await sleep(1200);
    const afterPages = await browser.pages();
    const extra = afterPages.filter(p => !beforePages.includes(p));
    // URL が wait.jsp / service/… っぽいものを優先
    for (const p of extra) {
      const u = p.url();
      if (/wait\.jsp/.test(u) || /\/search\/jkknet\/service\//.test(u)) {
        popup = p; break;
      }
    }
    // それでも無ければ、新しいものから1つ選ぶ
    if (!popup && extra.length) popup = extra[extra.length - 1];
  }

  if (popup) {
    await snap(popup, `${tagPrefix}_popup_after_open`);
    // popup 内で自動遷移が起きることがあるので少し待つ
    await Promise.race([
      popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => null),
      sleep(1500),
    ]);
    await snap(popup, `${tagPrefix}_popup_after_wait`);
    return popup;
  } else {
    await snap(page, `${tagPrefix}_popup_missing`);
    return null;
  }
}

// popup 側で “進まない時” の最終手段：form.submit()
async function forceSubmitIn(ctx, pageForSnap, label) {
  let submitted = false;
  try {
    submitted = await ctx.evaluate(() => {
      const f = document.forms?.[0] || document.querySelector('form');
      if (f) { f.submit(); return true; }
      return false;
    });
  } catch {}
  await sleep(submitted ? 1200 : 300);
  await snap(pageForSnap, `${label}_after_submit`);
  return submitted;
}

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
    // 1) HOME を順に
    for (let i = 0; i < TRY_URLS.length; i++) {
      await goto(page, TRY_URLS[i], `home_${i + 1}`);
      await recoverApology(page);
      await snap(page, `home_${i + 1}_after`);
    }

    // 2) StartInit（referer必須）
    await page.setExtraHTTPHeaders({ referer: `${BASE}/search/jkknet/service/` });
    await goto(page, START_INIT, 'frameset_startinit');

    // 3) 「こちら」→ popup 捕捉
    const popup = await clickAndCatchPopup(
      browser,
      page,
      async () => await clickByTextWithNav(page, 'こちら'),
      'relay1'
    );

    // 4) popup が来たら、そこで待つ／submit を保険で実行
    if (popup) {
      // 自動で進まない時は submit を保険で
      await forceSubmitIn(popup, page, 'popup');

      // さらに少し様子見
      await Promise.race([
        popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => null),
        sleep(1500),
      ]);
      await snap(popup, 'popup_final');

    } else {
      // popup 不発なら、ページ本体で submit を試す（古い実装の保険）
      await forceSubmitIn(page, page, 'main');
    }

    // 5) 仕上げ（最終の状態）
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
