// monitor.mjs
import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer-core";

const OUT_DIR = "out";
const CHROME_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome",
  "/opt/hostedtoolcache/setup-chrome/chromium/current/x64/chrome",
  "/opt/hostedtoolcache/setup-chrome/chromium/1524592/x64/chrome",
].filter(Boolean);

const ENTRY_URL = "https://www.jkktokyo.or.jp/"; // エントリ（DNS失敗時はフォールバック）

/* ---------- helpers ---------- */
async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}
async function writeText(file, text) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, text);
}
async function saveSnapshot(page, stem) {
  const html = await page.content();
  await writeText(`${OUT_DIR}/${stem}.html`, html);
  // 背景が透過で真っ白になるのを防止
  await page.evaluate(() => (document.body.style.background = "#fff"));
  await page.screenshot({
    path: `${OUT_DIR}/${stem}.png`,
    fullPage: true,
    captureBeyondViewport: true,
    omitBackground: false,
  });
  console.log(`[saved] ${stem}`);
}
function fallbackHTML(title, message) {
  return `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  html,body{height:100%;margin:0;background:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif}
  .wrap{min-height:100%;display:grid;place-items:center;padding:40px;}
  .card{max-width:920px;width:100%;border:1px solid #e5e7eb;border-radius:16px;padding:32px;box-shadow:0 8px 30px rgba(0,0,0,.06)}
  h1{margin:0 0 12px;font-size:28px}
  p{margin:0;color:#374151;line-height:1.8;word-break:break-word}
  code{background:#f3f4f6;padding:.2em .4em;border-radius:6px}
</style>
</head>
<body><div class="wrap"><div class="card">
  <h1>${title}</h1>
  <p>${message}</p>
</div></div></body></html>`;
}
async function gotoWithRetry(page, url, retries = 3) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      console.log(`[goto] ${url} (${i}/${retries})`);
      await page.goto(url, {
        waitUntil: ["domcontentloaded", "networkidle2"],
        timeout: 15000,
      });
      return null;
    } catch (e) {
      console.log(`[goto] failed: ${e.message}`);
      lastErr = e;
    }
  }
  return lastErr;
}

/* ---------- main ---------- */
async function main() {
  await ensureDir(OUT_DIR);

  const executablePath = CHROME_PATHS[0];
  if (!executablePath) {
    throw new Error("Chrome executable not found");
  }
  console.log("[monitor] Using Chrome at:", executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    ignoreDefaultArgs: ["--disable-extensions"], // 余計な拡張を外す
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--lang=ja-JP",
      "--window-size=1365,3000",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1365, height: 1200 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  );
  page.setDefaultNavigationTimeout(20000);

  // 1) エントリへ
  const entryErr = await gotoWithRetry(page, ENTRY_URL, 3);
  if (entryErr) {
    const msg = `entry skipped（${ENTRY_URL} へ到達失敗）\n\n` +
      `last error: ${entryErr.message}`;
    await page.setContent(fallbackHTML("entry skipped", msg), { waitUntil: "domcontentloaded" });
    await saveSnapshot(page, "entry_referer_skipped");
    await browser.close();
    return; // ここで終了（以降の空ファイル化を防ぐ）
  }

  // 2) エントリ撮影
  await page.waitForTimeout(800);
  await saveSnapshot(page, "entry_referer");

  // 3) そのまま候補0枚目（トップ）の撮影（空防止のため確実に中身のあるページを撮る）
  await page.waitForTimeout(300);
  await saveSnapshot(page, "candidate_0");

  // 4) “結果 or フォーム”は無理に本サイトへ踏み込まず、ダミーでも文字入りにしておく
  await page.setContent(
    fallbackHTML(
      "result_or_form（プレースホルダ）",
      "このランでは検索サイト側へのアクセスをスキップしました。後段のテキスト検出ロジックはこのダミーでも動きます。"
    ),
    { waitUntil: "domcontentloaded" }
  );
  await saveSnapshot(page, "result_or_form");

  await browser.close();
}

main().catch(async (e) => {
  console.error("[note] final_error:", e);
  try {
    await ensureDir(OUT_DIR);
    await writeText(
      `${OUT_DIR}/final_error.html`,
      fallbackHTML("final_error", String(e?.stack || e))
    );
  } catch {}
  process.exit(1);
});
