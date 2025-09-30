// monitor.js
// Playwright で JKK ねっとの StartInit → 検索ページに POST するまでを実行
// ESM 前提（package.json の "type":"module" が必要）

import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

const BASE = "https://jhomes.to-kousya.or.jp";
const URLS = [
  `${BASE}/`,
  `${BASE}/search/jkknet/`,
  `${BASE}/search/jkknet/index.html`,
  `${BASE}/search/jkknet/service/`,
];
const START_INIT = `${BASE}/search/jkknet/service/akiyaJyoukenStartInit`;

const DUMP_DIR = "dump";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const NAV_TIMEOUT = 60_000;

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
    s.includes("混雑") ||
    s.includes("操作は行わないで") ||
    s.includes("見つかりません")
  );
}

async function gotoWithRetry(page, url, tag) {
  for (let i = 1; i <= 3; i++) {
    try {
      logStep(tag, `goto try${i}: ${url}`);
      await page.goto(url, {
        timeout: NAV_TIMEOUT,
        waitUntil: "domcontentloaded",
      });
      return true;
    } catch (e) {
      logStep(tag, `goto error on try${i}: ${e}`);
      if (i < 3) await page.waitForTimeout(1500);
    }
  }
  return false;
}

async function dumpWhere(page, tag) {
  const title = await page.title().catch(() => "");
  const url = page.url();
  console.log(`${tag} URL: ${url}`);
  console.log(`${tag} TITLE: ${title}`);
  await saveShot(page, tag.replace(/\W/g, "_"));
  await saveHtml(page, tag.replace(/\W/g, "_"));
  return { url, title };
}

async function main() {
  await ensureDir(DUMP_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
    extraHTTPHeaders: { "Accept-Language": "ja,en;q=0.8" },
  });
  const page = await context.newPage();

  try {
    // 1) ホーム/サービスに順番にアクセス
    for (const u of URLS) {
      await gotoWithRetry(page, u, "[home]");
      await dumpWhere(page, "[home]");
    }

    // 2) StartInit 直行
    await gotoWithRetry(page, START_INIT, "[frameset]");
    await dumpWhere(page, "[frameset]");

    // 3) frameset 内の form を直接 submit
    logStep("relay", "try submit forwardForm");
    const ok = await page.evaluate(() => {
      const f = document.forms["forwardForm"];
      if (f) {
        f.submit();
        return true;
      }
      return false;
    });
    if (ok) {
      logStep("relay", "forwardForm.submit() called");
      await page.waitForTimeout(3000);
    } else {
      logStep("relay", "forwardForm not found");
    }

    // 4) submit 後の画面を保存
    const step3 = await dumpWhere(page, "[after-submit]");
    if (isApologyLike(step3.title)) {
      logStep("result", "apology page detected");
    } else {
      logStep("result", "maybe success, check HTML in dump/");
    }

    // 5) 最終スクショ
    await dumpWhere(page, "[final]");
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
