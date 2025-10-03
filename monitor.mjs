// monitor.mjs
import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer-core";

const OUT_DIR = "out";
const ENTRY_URL = "https://www.jkktokyo.or.jp/"; // DNS失敗時はフォールバックへ

const CHROME_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome",
  "/opt/hostedtoolcache/setup-chrome/chromium/current/x64/chrome",
  "/opt/hostedtoolcache/setup-chrome/chromium/1524592/x64/chrome",
].filter(Boolean);

/* --------------- utils --------------- */
async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }
async function writeText(file, text) { await ensureDir(path.dirname(file)); await fs.writeFile(file, text); }

function fallbackHTML(title, message) {
  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
html,body{height:100%;margin:0;background:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif}
.wrap{min-height:100%;display:grid;place-items:center;padding:40px}
.card{max-width:920px;width:100%;border:1px solid #e5e7eb;border-radius:16px;padding:32px;box-shadow:0 8px 30px rgba(0,0,0,.06)}
h1{margin:0 0 12px;font-size:28px}
p{margin:0;line-height:1.8;white-space:pre-wrap;word-break:break-word;color:#374151}
code{background:#f3f4f6;padding:.2em .4em;border-radius:6px}
</style></head>
<body><div class="wrap"><div class="card"><h1>${title}</h1><p>${message}</p></div></div></body></html>`;
}

async function saveSnapshot(page, stem) {
  // 背景透過で真っ白になるのを回避
  await page.evaluate(() => (document.body.style.background = "#fff"));
  const html = await page.content();
  await writeText(`${OUT_DIR}/${stem}.html`, html);
  await page.screenshot({
    path: `${OUT_DIR}/${stem}.png`,
    fullPage: true,
    captureBeyondViewport: true,
    omitBackground: false,
  });
  console.log(`[saved] ${stem}`);
}

async function renderFallback(browser, stem, title, message) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1365, height: 1200 });
  await p.setContent(fallbackHTML(title, message), { waitUntil: "domcontentloaded" });
  await saveSnapshot(p, stem);
  await p.close();
}

async function gotoWithRetry(page, url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`[goto] ${url} (${i}/${tries})`);
      await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: 15000 });
      return null;
    } catch (e) {
      console.log(`[goto] failed: ${e.message}`);
      lastErr = e;
    }
  }
  return lastErr;
}

/* --------------- main --------------- */
async function main() {
  await ensureDir(OUT_DIR);

  const executablePath = CHROME_PATHS[0];
  console.log("[monitor] Using Chrome at:", executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--no-sandbox", "--disable-gpu", "--lang=ja-JP", "--window-size=1365,3000"],
  });

  try {
    // 1) entry
    const page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 1200 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    );

    const entryErr = await gotoWithRetry(page, ENTRY_URL, 3);
    if (entryErr) {
      // ナビゲーション中断の可能性があるので、別タブで安全に描画
      await renderFallback(
        browser,
        "entry_referer_skipped",
        "entry skipped",
        `DNS/ネットワーク到達失敗のためエントリをスキップしました。\nURL: ${ENTRY_URL}\nlast error:\n${entryErr.message}`
      );
      await page.close();
      // 以降の空撮りを防ぐため早期終了
      return;
    }

    // 2) entry撮影
    await page.waitForTimeout(800);
    await saveSnapshot(page, "entry_referer");

    // 3) 候補0（トップ）を確実に保存
    await page.waitForTimeout(300);
    await saveSnapshot(page, "candidate_0");

    // 4) 参考用の result_or_form（プレースホルダ）
    await renderFallback(
      browser,
      "result_or_form",
      "result_or_form（プレースホルダ）",
      "このランでは検索フローを実行せずにプレースホルダを保存しています。後続のテキスト検出の疎通用に利用してください。"
    );

    await page.close();
  } finally {
    await browser.close();
  }
}

/* --------------- runner --------------- */
main().catch(async (e) => {
  console.error("[note] final_error:", e);
  try {
    await ensureDir(OUT_DIR);
    await writeText(`${OUT_DIR}/final_error.html`, fallbackHTML("final_error", String(e?.stack || e)));
  } catch {}
  // 失敗でも成果物をアップできるように 0 で終了
  process.exit(0);
});
