// monitor.js  —— full replace version (Playwright / Node20 ESM)
// 実行ログに分かりやすいタグを出します。PNG/HTMLを同じフォルダに保存します。

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const BASE = "https://jhomes.to-kousya.or.jp";
const START = `${BASE}/search/jkknet/service/akiyaJyoukenStartInit`;
const HOME_CANDIDATES = [
  `${BASE}/`,
  `${BASE}/search/jkknet/`,
  `${BASE}/search/jkknet/index.html`,
  `${BASE}/search/jkknet/service/`,
];

const OUT = (name, ext) => `${name}.${ext}`;

// ---------- 小物ユーティリティ ----------
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function saveScreenshot(page, name) {
  try { await page.screenshot({ path: OUT(name, "png"), fullPage: true }); }
  catch { /* ignore */ }
}

async function saveHTML(target, name) {
  try {
    const html = await target.content();
    await fs.writeFile(OUT(name, "html"), html, "utf8");
  } catch { /* ignore */ }
}

function now() {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, "-");
}

async function titleOf(page) {
  try { return await page.title(); } catch { return ""; }
}

async function urlOf(page) {
  try { return page.url(); } catch { return ""; }
}

function log(tag, msg = "") {
  console.log(`[${tag}] ${msg}`);
}

// apology / timeout / notfound 判定
async function isApologyOrTimeout(page) {
  const t = (await titleOf(page)) || "";
  if (t.includes("おわび")) return true;

  // 画面内テキストを軽くチェック（重くならない範囲）
  try {
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    if (/タイムアウト|おわび|その操作は|大変混雑/.test(bodyText)) return true;
  } catch {}
  return false;
}

// 「トップページへ戻る」リンク押下
async function clickBackToTop(page) {
  const selectors = [
    'text="トップページへ戻る"',
    'a:has-text("トップページへ戻る")',
    'input[value="トップページへ戻る"]',
    'button:has-text("トップページへ戻る")',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await Promise.allSettled([page.waitForLoadState("load", { timeout: 8000 })]);
      await el.click({ timeout: 3000 }).catch(()=>{});
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(()=>{});
      return true;
    }
  }
  return false;
}

// こちらクリック（main と全 frame を対象）
async function clickKochiraEverywhere(page) {
  const frames = [page.mainFrame(), ...page.frames()];
  let clicked = 0;

  for (const fr of frames) {
    try {
      const handle = await fr.$('a:has-text("こちら")');
      if (handle) {
        await handle.click({ timeout: 3000 }).catch(()=>{});
        clicked++;
      }
    } catch {}
  }
  return clicked;
}

// 全 frame / main で form.submit() を試す
async function forceSubmitForms(page) {
  const frames = [page.mainFrame(), ...page.frames()];
  let submitted = 0;

  for (const fr of frames) {
    try {
      const count = await fr.evaluate(() => {
        const forms = Array.from(document.querySelectorAll("form"));
        forms.forEach(f => { try { f.submit(); } catch {} });
        return forms.length;
      }).catch(()=>0);
      submitted += count || 0;
    } catch {}
  }
  return submitted;
}

// ---------- HOME 導出（どこに居ても START へ向かうための復帰動線） ----------
async function reachHomeSequence(page) {
  for (let round = 0; round < 3; round++) {
    for (const u of HOME_CANDIDATES) {
      log("goto", u);
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
      await page.waitForLoadState("load", { timeout: 10000 }).catch(()=>{});

      if (await isApologyOrTimeout(page)) {
        log("recover", "apology -> back to top");
        await clickBackToTop(page);
        await page.waitForTimeout(1500);
      }

      // ある程度正常画面なら OK とみなす
      const t = (await titleOf(page)) || "";
      if (!t.includes("おわび")) return true;
    }
    await sleep(800);
  }
  return false;
}

// ---------- MAIN ----------
(async () => {
  const browser = await chromium.launch({ headless: true }); // Actions なら true でOK
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  const stamp = now();

  try {
    // 1) HOME 相当までたどり着けるか
    const ok = await reachHomeSequence(page);
    if (!ok) {
      log("ERROR", "cannot reach HOME sequence");
      await saveScreenshot(page, `_home_${stamp}`);
      await saveHTML(page, `_home_${stamp}`);
      process.exit(1);
    }

    // 2) frameset 経由 or 直接 StartInit へ
    //    直接行って、もしおわび表示なら「トップへ戻る」→再度トライ
    log("goto", START);
    await page.goto(START, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
    await page.waitForLoadState("load", { timeout: 10000 }).catch(()=>{});

    if (await isApologyOrTimeout(page)) {
      log("recover", "apology/timeout at StartInit -> back to top then try StartInit again");
      await clickBackToTop(page);
      await page.waitForTimeout(1000);
      await page.goto(START, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
      await page.waitForLoadState("load", { timeout: 10000 }).catch(()=>{});
    }

    await saveScreenshot(page, `_frameset_${stamp}`);
    await saveHTML(page, `_frameset_${stamp}`);

    // 3) 「こちら」をできる限り押す（main / frame）
    log("relay", 'click "こちら" everywhere');
    for (let i = 0; i < 3; i++) {
      const n = await clickKochiraEverywhere(page);
      if (n === 0) break;
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(()=>{});
      await sleep(600);
    }

    await saveScreenshot(page, `_after_relay_${stamp}`);
    await saveHTML(page, `_after_relay_${stamp}`);

    // 4) (念のため) 全フォーム submit を試す
    log("submit", "force form.submit() on all frames");
    const submitted = await forceSubmitForms(page);
    if (submitted > 0) {
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(()=>{});
      await sleep(800);
    }

    await saveScreenshot(page, `_after_submit_${stamp}`);
    await saveHTML(page, `_after_submit_${stamp}`);

    // 5) 仕上げログ
    log("final", `URL: ${await urlOf(page)}`);
    log("final", `TITLE: ${await titleOf(page)}`);

    await saveScreenshot(page, `_final_${stamp}`);
    await saveHTML(page, `_final_${stamp}`);

    // ここまで到達すれば Actions 上は成功扱いにしておく
    process.exit(0);
  } catch (e) {
    log("FATAL", String(e?.stack || e));
    try { await saveScreenshot(page, `_fatal_${stamp}`); } catch {}
    try { await saveHTML(page, `_fatal_${stamp}`); } catch {}
    process.exit(1);
  } finally {
    await context.close();
    await browser.close();
  }
})();
