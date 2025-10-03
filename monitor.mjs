import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const OUT = "out";
const ENTRY_URLS = [
  "https://www.jkk-tokyo.or.jp/", // 正規（ハイフンあり）
  "https://jkk-tokyo.or.jp/"      // サブドメイン無しの正規
];
// ここに「ハイフン無しの jkktokyo.or.jp 」は入れない（存在しないため DNS エラー確定）

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ensureOut() {
  try { await fs.mkdir(OUT, { recursive: true }); } catch {}
}

async function saveHTML(page, name) {
  const html = await page.content();
  await fs.writeFile(path.join(OUT, `${name}.html`), html);
}

async function saveShot(page, name, opt = {}) {
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    fullPage: true,
    ...opt,
  });
}

async function launch() {
  const chromePath = process.env.CHROME_PATH || "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome";
  console.log(`[monitor] Using Chrome at: ${chromePath}`);
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1280, height: 1800 },
  });
  const page = await browser.newPage();
  // デフォルトのナビゲーションタイムアウト少し長め
  page.setDefaultNavigationTimeout(15000);
  return { browser, page };
}

async function gotoWithRetry(page, url, max = 5) {
  for (let i = 1; i <= max; i++) {
    try {
      console.log(`[goto] ${url} (${i}/${max})`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
      return true;
    } catch (e) {
      console.log(`[goto] failed: ${String(e)}`);
      // DNS/NAME_NOT_RESOLVED などは数秒後に再試行
      await sleep(1500);
    }
  }
  return false;
}

function errorCardHTML(title, lines = []) {
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family: system-ui, -apple-system, Segoe UI, Roboto, 'Noto Sans JP', sans-serif; background:#f6f7f9; margin:0; padding:60px;}
.card{max-width:720px; margin:80px auto; background:#fff; border-radius:14px; padding:28px 32px; box-shadow:0 8px 28px rgba(0,0,0,.08);}
h1{font-size:22px; margin:0 0 12px;}
pre{white-space:pre-wrap; word-break:break-word; font-size:13px; color:#333; background:#fafafa; padding:10px 12px; border-radius:8px;}
small{color:#666}
</style></head>
<body>
<div class="card">
  <h1>${esc(title)}</h1>
  ${lines.map(l => `<pre>${esc(l)}</pre>`).join("")}
  <small>Generated at ${new Date().toISOString()}</small>
</div>
</body></html>`;
}

async function saveNote(page, name, title, lines) {
  const html = errorCardHTML(title, lines);
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await saveHTML(page, name);
  await saveShot(page, name);
}

async function main() {
  await ensureOut();
  const { browser, page } = await launch();

  // 入口を順に試行（DNS や瞬断を吸収）
  let entered = false;
  let lastErr = "";
  for (const url of ENTRY_URLS) {
    const ok = await gotoWithRetry(page, url, 5);
    if (ok) {
      // 入れたら保存して終了（この段階ではトップを撮るだけ）
      await saveHTML(page, "entry_referer");
      await saveShot(page, "entry_referer");
      entered = true;
      break;
    } else {
      lastErr = `failed to open: ${url}`;
    }
  }

  if (!entered) {
    console.log("[note] entry skipped");
    await saveNote(page, "entry_referer_skipped",
      "entry skipped",
      [
        "DNS/ネットワークの理由でエントリーに到達できませんでした。",
        `URL candidates: ${ENTRY_URLS.join(", ")}`,
        `last error: ${lastErr}`
      ]
    );
  }

  // “とりあえず入口の成否を確実に残す” ところまで。
  // ここが安定してから、次の段（検索フォーム → 結果の撮影）を足します。
  await browser.close();
}

main().catch(async (e) => {
  console.error("[fatal]", e);
  try {
    await ensureOut();
    const { browser, page } = await launch();
    await saveNote(page, "final_error", "unexpected error", [String(e?.stack || e)]);
    await browser.close();
  } catch {}
  process.exit(1);
});
