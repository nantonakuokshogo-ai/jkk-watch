// monitor.js  — Playwright で JKK ねっとの StartInit → 検索までを機械操作し、
// スクショと HTML を artifacts に出力します（dump/ 配下）。
// ESM 前提（package.json の "type":"module"）。

import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

// ========== 設定 ==========
const BASE = "https://jhomes.to-kousya.or.jp";
const URLS = [
  `${BASE}/`,
  `${BASE}/search/jkknet/`,
  `${BASE}/search/jkknet/index.html`,
  `${BASE}/search/jkknet/service/`,
];
const START_INIT = `${BASE}/search/jkknet/service/akiyaJyoukenStartInit`;
const SHOT_W = 1280;
const SHOT_H = 900;
const DUMP_DIR = "dump";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const NAV_TIMEOUT = 60_000; // 60s
const TRY_MAX = 3;
// =========================

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function saveShot(page, name) {
  await page.screenshot({ path: `${name}.png`, fullPage: true }).catch(() => {});
}

async function saveHtml(page, name) {
  try {
    await ensureDir(DUMP_DIR);
    const html = await page.content();
    await fs.writeFile(path.join(DUMP_DIR, `${name}.html`), html, "utf8");
  } catch (e) {
    console.error("[dump] save error:", e);
  }
}

function logStep(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

function isApologyLike(titleOrText) {
  if (!titleOrText) return false;
  const s = String(titleOrText);
  return (
    s.includes("おわび") ||
    s.includes("大変混雑") ||
    s.includes("操作は行わないで下さい") ||
    s.includes("見つかりません")
  );
}

async function clickIfExists(scope, selector) {
  const el = await scope.$(selector);
  if (el) {
    await el.click({ timeout: 2000 }).catch(() => {});
    return true;
  }
  return false;
}

async function clickKochiraAnywhere(page) {
  // main
  const ok1 = await clickIfExists(page, 'a:has-text("こちら")');
  if (ok1) return true;
  // frames
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const ok = await clickIfExists(f, 'a:has-text("こちら")');
    if (ok) return true;
  }
  return false;
}

async function submitAnyForm(page) {
  // main
  const ok1 = await page
    .evaluate(() => {
      const f = document.forms?.[0];
      if (f && typeof f.submit === "function") {
        f.submit();
        return true;
      }
      return false;
    })
    .catch(() => false);
  if (ok1) return true;

  // frames
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const ok = await f
      .evaluate(() => {
        const fm = document.forms?.[0];
        if (fm && typeof fm.submit === "function") {
          fm.submit();
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (ok) return true;
  }
  return false;
}

async function gotoWithRetry(page, url, tag, extra = {}) {
  for (let i = 1; i <= TRY_MAX; i++) {
    try {
      logStep(tag, `goto try${i}: ${url}`);
      await page.goto(url, {
        timeout: NAV_TIMEOUT,
        waitUntil: "domcontentloaded",
        ...extra,
      });
      return true;
    } catch (e) {
      logStep(tag, `goto error on try${i}: ${e}`);
      if (i < TRY_MAX) await page.waitForTimeout(1500);
    }
  }
  return false;
}

async function dumpWhere(page, tag) {
  const title = await page.title().catch(() => "");
  const url = page.url();
  console.log(`${tag} URL: ${url}`);
  console.log(`${tag} TITLE: ${title}`);
  await saveShot(page, `${tag.replace(/[\[\]\s]/g, "").toLowerCase()}`);
  await saveHtml(page, `${tag.replace(/[\[\]\s]/g, "").toLowerCase()}`);
  return { url, title };
}

async function recoverIfApology(page) {
  // 「トップページへ戻る」押下で抜けられるケースを拾う
  const clicked =
    (await clickIfExists(page, 'a:has-text("トップページへ戻る")')) ||
    (await clickIfExists(page, 'input[value="トップページへ戻る"]'));
  if (clicked) {
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    return true;
  }
  return false;
}

async function main() {
  await ensureDir(DUMP_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: SHOT_W, height: SHOT_H },
    userAgent: UA,
    extraHTTPHeaders: {
      "Accept-Language": "ja,en;q=0.8",
    },
  });

  const page = await context.newPage();

  try {
    // 1) ホーム/検索トップ/サービスに順番に入る（混雑時は戻るで回避）
    for (const u of URLS) {
      await gotoWithRetry(page, u, "[home]");
      const { title } = await dumpWhere(page, "[home]");
      if (isApologyLike(title)) {
        await recoverIfApology(page);
        await page.waitForTimeout(1000);
        continue; // 次 URL を試す
      }
    }

    // 2) StartInit に「Referer: /service/」付きで直行
    logStep("frameset", "direct goto StartInit with referer=/service/");
    await gotoWithRetry(page, START_INIT, "[frameset]", {
      referer: `${BASE}/search/jkknet/service/`,
    });
    const step2 = await dumpWhere(page, "[frameset]");
    if (isApologyLike(step2.title)) {
      // 一度だけ戻りリカバリを試す
      const rec = await recoverIfApology(page);
      if (rec) await gotoWithRetry(page, START_INIT, "[frameset-retry]", { referer: `${BASE}/search/jkknet/service/` });
    }

    // 3) 「こちら」を main/frames どちらでも押す → それでもダメなら meta refresh 直行を試す
    logStep("relay", 'click "こちら" if appears');
    for (let i = 0; i < 4; i++) {
      const ok = await clickKochiraAnywhere(page);
      if (!ok) break;
      await page.waitForTimeout(1500);
    }
    await dumpWhere(page, "[after-relay]");

    // 最終手段：meta refresh があれば飛ぶ
    try {
      const refresh = await page.$('meta[http-equiv="refresh" i]');
      if (refresh) {
        const content = await refresh.getAttribute("content");
        const m = content && content.match(/URL=([^;]+)/i);
        if (m && m[1]) {
          const next = new URL(m[1], page.url()).toString();
          logStep("relay", `meta refresh → ${next}`);
          await gotoWithRetry(page, next, "[relay-meta]");
        }
      }
    } catch {}

    // 4) 何かしらフォームがあれば submit（検索発火）
    logStep("search", "try submit any first form on main/frames");
    await submitAnyForm(page);
    await page.waitForTimeout(1500);
    await dumpWhere(page, "[after-search]");

    // ここで “物件一覧/検索結果” に到達できれば HTML から DOM 解析へ進めます
    // まだ「おわび」や StartInit のままなら、現状はここまで（dump を根拠に次のクリックを合わせる）
    const final = await dumpWhere(page, "[final]");
    if (isApologyLike(final.title)) {
      logStep("result", "apology page detected — 次回のクリック/遷移調整が必要");
    } else {
      logStep("result", "OK（この HTML をもとに結果抽出の実装に進めます）");
    }
  } catch (e) {
    console.error("FATAL:", e);
    await saveShot(page, "fatal");
    await saveHtml(page, "fatal");
    throw e;
  } finally {
    await browser.close();
  }
}

main();
