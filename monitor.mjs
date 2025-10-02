// monitor.mjs
// Node 20 / puppeteer-core v23+
// 目的: JKKの "wait.jsp" を直接踏んで、自動POSTで StartInit に遷移させ、
//      一覧 or フォームのスクショとHTMLを out/** に保存する。

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const OUT_DIR = "out";

// ---- ユーザ設定（環境変数で上書き可） ----
const REFERER = process.env.REFERER || "https://www.to-kousya.or.jp/chintai/index.html";
const WAIT_URL = process.env.WAIT_URL || "https://jhomes.to-kousya.or.jp/search/jkknet/wait.jsp";
const VIEWPORT_W = Number(process.env.VIEWPORT_W || 1280);
const VIEWPORT_H = Number(process.env.VIEWPORT_H || 2200);

// Chrome 実行パス（setup-chrome の出力を使う）
const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH ||
  "";

function log(...args) {
  console.log("[monitor]", ...args);
}

async function ensureOut() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function savePage(page, name) {
  try {
    await ensureOut();
    const html = await page.content();
    const htmlPath = path.join(OUT_DIR, `${name}.html`);
    const pngPath = path.join(OUT_DIR, `${name}.png`);
    await fs.writeFile(htmlPath, html, "utf8");
    // ビューポートは常に設定済みの想定だが、0 width 対策で改めて取る
    const vp = page.viewport() || { width: VIEWPORT_W, height: VIEWPORT_H };
    if (!vp || !vp.width) {
      await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });
    }
    await page.screenshot({ path: pngPath, fullPage: true });
    log(`[saved] ${name}`);
  } catch (err) {
    console.warn(`[warn] screenshot failed for ${name}: ${err?.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME_PATH) {
    throw new Error(
      "Chromium/Chrome の実行パスが見つかりません（PUPPETEER_EXECUTABLE_PATH or CHROME_PATH）。setup-chrome の出力を参照してください。"
    );
  }
  log("Using Chrome at:", CHROME_PATH);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new", // Puppeteer v23 推奨
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-popup-blocking",
      "--no-default-browser-check",
      "--no-first-run",
      "--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests,NetworkServiceSandbox,SafeBrowsingEnhancedProtection,SafeBrowsingInterstitial",
      "--disable-client-side-phishing-detection",
    ],
    defaultViewport: { width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();

  // UA/ヘッダをそれっぽく
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "ja-JP,ja;q=0.9",
    Referer: REFERER,
  });

  // ===== 1) 参照元として賃貸トップを踏む =====
  try {
    await page.goto(REFERER, { waitUntil: "domcontentloaded", timeout: 30000 });
    await savePage(page, "entry_referer");
  } catch (e) {
    // 参照元は失敗しても続行（後続でRefererヘッダは付与済み）
    console.warn("[warn] open referer failed:", e?.message);
  }

  // ===== 2) ランチャー wait.jsp を直接開く =====
  // ここで onload → 自動POST → StartInit へ遷移（正規フロー）
  // ポップアップを開く実装の場合もあるため、popup発生も拾ってどちらでも進める。
  let popupPage = null;
  page.once("popup", (p) => {
    popupPage = p;
  });

  await page.goto(WAIT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await savePage(page, "candidate_0"); // デバッグ用（ランチャー段階）

  // ===== 3) 同一タブ遷移 or ポップアップのどちらかを待つ =====
  const deadline = Date.now() + 25000;
  let workPage = page;

  while (Date.now() < deadline) {
    // (a) 同一タブで StartInit 配下に遷移したか？
    const url = workPage.url();
    if (/\/search\/jkknet\/service\/akiyaJyouken(Start)?Init/.test(url)) break;

    // (b) ポップアップが開いていれば、そちらを採用して様子を見る
    if (popupPage) {
      try {
        await popupPage.bringToFront();
        workPage = popupPage;
      } catch {}
    }

    // (c) そのまま少し待つ
    await sleep(500);
  }

  // ここまでで /service/akiyaJyoukenStartInit に到達しているはず
  // もし 404 などになっても、とにかくスクショを残す
  await savePage(workPage, "after_wait");

  // ===== 4) フレームがあればログに出しておく（デバッグ） =====
  const frames = workPage.frames();
  log("[frames] count=", frames.length);
  frames.forEach((f, i) => log(`[frame#${i}] url=${f.url()} name=${f.name() || "-"}`));

  // ===== 5) 一覧 or フォーム（達成優先）を撮る =====
  // まずは到達を最優先に、ページ全体スクショを確実に保存。
  await workPage.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });
  await savePage(workPage, "result_or_form");

  await browser.close();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await ensureOut();
    await fs.writeFile(
      path.join(OUT_DIR, "final_error.html"),
      `<pre>${String(err.stack || err.message || err)}</pre>`,
      "utf8"
    );
  } catch {}
  process.exitCode = 1;
});
