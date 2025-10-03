import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";

/* ========== 設定 ========== */

// 入口候補（上から順に試す）
const ENTRY_URLS = [
  "https://www.jkk-tokyo.or.jp/", // 正式（推奨）
  "https://jkk-tokyo.or.jp/",     // www なし
  "https://www.jkktokyo.or.jp/"   // ハイフン無し（予備）
];

// 直接フォーム側（成功したら after_wait → result_or_form を撮りにいく）
const WAIT_URLS = [
  "https://jhomes.to-kousya.or.jp/search/jkknet/wait.jsp"
];

const OUT_DIR = "out";
const VIEWPORT = { width: 1440, height: 2400 };
const NAV_TIMEOUT = 30_000;   // 1 回の遷移タイムアウト
const RETRY_WAIT   = 1_000;   // リトライ間隔
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* ========== ユーティリティ ========== */

async function ensureOut() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function saveFile(basename, html, pngBuffer) {
  const htmlPath = path.join(OUT_DIR, `${basename}.html`);
  const pngPath  = path.join(OUT_DIR, `${basename}.png`);
  if (html != null) await fs.writeFile(htmlPath, html);
  if (pngBuffer != null) await fs.writeFile(pngPath, pngBuffer);
  console.log(`[saved] ${basename}`);
}

async function savePage(page, basename) {
  const html = await page.content();
  const png  = await page.screenshot({ type: "png", fullPage: true });
  await saveFile(basename, html, png);
}

async function saveNote(page, basename, message, detail = "") {
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"/>
<title>${basename}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,'Noto Sans JP',sans-serif;background:#f6f7f9;margin:0;padding:64px;}
  .card{max-width:820px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.07);padding:28px 32px}
  h1{font-size:28px;margin:0 0 12px}
  p{white-space:pre-wrap;line-height:1.6;color:#222}
  code{background:#f0f3f7;border-radius:6px;padding:2px 6px}
</style></head>
<body>
  <div class="card">
    <h1>${basename.replace(/_/g, " ")}</h1>
    <p>${message}</p>
    ${detail ? `<p><code>${detail}</code></p>` : ""}
  </div>
</body></html>`;
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await savePage(page, basename);
}

function chromePathFromEnv() {
  // setup-chrome や他の runner が書き込む env を優先
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  // GitHub Actions の setup-chrome が入れる既定パスをいくつか当てにいく
  const candidates = [
    "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome",
    "/opt/hostedtoolcache/setup-chrome/chromium/1524592/x64/chrome",
    "/opt/hostedtoolcache/setup-chrome/chromium/1524587/x64/chrome"
  ];
  return candidates.find(Boolean);
}

async function gotoWithRetry(page, url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`[goto] ${url} (${i}/${tries})`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      return { ok: true };
    } catch (e) {
      const msg = String(e);
      console.log(`[goto] failed: ${msg}`);
      // DNS 失敗は次の候補へすぐ切り替える（リトライしても勝てない）
      if (msg.includes("ERR_NAME_NOT_RESOLVED")) return { ok: false, fatal: true, err: msg };
      // それ以外は軽くリトライ
      if (i < tries) await page.waitForTimeout(RETRY_WAIT);
      else return { ok: false, fatal: false, err: msg };
    }
  }
  return { ok: false, fatal: false, err: "unknown" };
}

function isBlockedByClient(e) {
  return String(e).includes("ERR_BLOCKED_BY_CLIENT");
}

/* ========== メイン ========== */

async function main() {
  await ensureOut();

  const executablePath = chromePathFromEnv();
  console.log(`[monitor] Using Chrome at: ${executablePath}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=IsolateOrigins,site-per-process",
      "--lang=ja,en-US;q=0.9,en;q=0.8",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`
    ],
    ignoreHTTPSErrors: true
  });

  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ "Accept-Language": "ja,en-US;q=0.9,en;q=0.8" });

  // ========== 1) 入口（複数候補でフォールバック） ==========
  let entryOk = false;
  let lastDnsErr = "";

  for (const url of ENTRY_URLS) {
    const r = await gotoWithRetry(page, url, 3);
    if (r.ok) { entryOk = true; break; }
    if (r.fatal && r.err?.includes("ERR_NAME_NOT_RESOLVED")) {
      lastDnsErr = `net::ERR_NAME_NOT_RESOLVED at ${url}`;
      // 次候補へ
      continue;
    }
  }

  if (!entryOk) {
    await saveNote(page, "entry_referer_skipped",
      "DNS/ネットワーク到達失敗のためエントリをスキップしました。",
      lastDnsErr || "DNS 以外のエラーで到達不可");
    await browser.close();
    return;
  }

  await page.waitForTimeout(1500);
  await savePage(page, "entry_referer");

  // ========== 2) 直接 wait.jsp を試す（成功すればついでに撮る） ==========
  for (const waitUrl of WAIT_URLS) {
    try {
      const r = await gotoWithRetry(page, waitUrl, 1);
      if (!r.ok) {
        // ブロック系などの理由で遷移できなければメモだけ残して終了
        await saveNote(page, "final_error", "wait.jsp への遷移に失敗しました。", r.err || "");
        break;
      }
      await page.waitForTimeout(1500);
      await savePage(page, "after_wait");

      // ここでフォーム/結果のどちらかに転送される環境なら、そのまま撮影
      // 転送されない環境でも out/ に after_wait は残る
      await page.waitForTimeout(2500);
      await savePage(page, "result_or_form");
      break;
    } catch (e) {
      if (isBlockedByClient(e)) {
        await saveNote(page, "final_error",
          "ブラウザ側ポリシーによりブロックされました（ERR_BLOCKED_BY_CLIENT）。", String(e));
      } else {
        await saveNote(page, "final_error", "想定外のエラーで中断しました。", String(e));
      }
      break;
    }
  }

  await browser.close();
}

main().catch(async (e) => {
  // どこで落ちても out/final_error を残して終了コード 1
  try {
    const html = `<!doctype html><meta charset="utf-8"/>
<title>final_error</title><pre style="white-space:pre-wrap">${String(e)}</pre>`;
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, "final_error.html"), html);
  } catch {}
  console.error(e);
  process.exit(1);
});
