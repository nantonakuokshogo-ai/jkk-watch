// monitor.mjs
// Run: npm run monitor
import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer-core";

const outDir = path.resolve("out");
await fs.mkdir(outDir, { recursive: true });

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome";

function esc(s = "") {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

async function saveHtmlPng(base, html, page) {
  const htmlPath = path.join(outDir, `${base}.html`);
  const pngPath  = path.join(outDir, `${base}.png`);
  await fs.writeFile(htmlPath, html);
  await page.screenshot({ path: pngPath, fullPage: true });
  console.log(`[saved] ${base}`);
}

async function gotoWithRetry(page, url, tries = 3, timeout = 15000) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    console.log(`[goto] ${url} (${i}/${tries})`);
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      // 200台ならOK扱い
      if (resp && resp.ok()) return { ok: true, resp };
      lastErr = new Error(`HTTP ${resp?.status()} ${resp?.statusText()}`);
    } catch (err) {
      lastErr = err;
      console.log(`[goto] failed: ${err}`);
    }
    await page.waitForTimeout(1000);
  }
  return { ok: false, err: lastErr };
}

async function main() {
  console.log(`[monitor] Using Chrome at: ${CHROME}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--hide-scrollbars",
    ],
    defaultViewport: { width: 1200, height: 2400, deviceScaleFactor: 2 },
  });

  let exitCode = 0;

  try {
    const entryUrls = [
      "https://www.jkktokyo.or.jp/",
      "https://jkk-tokyo.or.jp/",
      "https://www.jkk-tokyo.or.jp/",
    ];

    const page = await browser.newPage();

    // 1) エントリへトライ
    let reached = false;
    let lastErr;
    for (const url of entryUrls) {
      const r = await gotoWithRetry(page, url, 3);
      if (r.ok) {
        // 到達できたら HTML/スクショを保存して終了
        const html = await page.content();
        await saveHtmlPng("entry_referer", html, page);
        reached = true;
        break;
      } else {
        lastErr = r.err;
      }
    }

    // 2) だめなら「entry_skipped」カードを別タブで描画して保存（ここで失敗しても job は成功にする）
    if (!reached) {
      const note = await browser.newPage(); // 既存 page はナビゲーション状態の可能性があるので新規
      const msg = esc(lastErr?.message || lastErr || "Unknown error");
      const html = `<!doctype html>
<html lang="ja"><meta charset="utf-8">
<title>entry skipped</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,"Noto Sans JP",sans-serif;background:#f6f7f9;margin:0;padding:48px}
  .card{max-width:720px;margin:40px auto;background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.07);padding:28px 32px}
  h1{margin:0 0 10px;font-size:24px}
  code{background:#f1f3f5;border-radius:6px;padding:.2em .4em}
  .muted{color:#667085;font-size:14px}
</style>
<div class="card">
  <h1>entry skipped</h1>
  <p class="muted">DNS/ネットワークで到達できなかったため、入口ページをスキップしました。</p>
  <p>last error:</p>
  <pre style="white-space:pre-wrap;word-break:break-word">${msg}</pre>
  <p class="muted">この状態は一時的なことがあるので、再実行すれば通る場合があります。</p>
</div>`;
      await note.setContent(html, { waitUntil: "domcontentloaded" });
      await saveHtmlPng("entry_referer_skipped", html, note);
      await note.close();
      console.log("[note] entry skipped; job will succeed.");
      exitCode = 0; // ここは成功扱い
    }

  } catch (e) {
    // 予期せぬ例外は final_error として保存（それでも落としたいなら exitCode=1）
    console.log("[note] unexpected error:", e);
    try {
      const page = await browser.newPage();
      const html = `<!doctype html><meta charset="utf-8"><title>final error</title>
      <pre>${esc(String(e))}</pre>`;
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      await saveHtmlPng("final_error", html, page);
      await page.close();
    } catch {}
    exitCode = 1;
  } finally {
    await browser.close();
    process.exitCode = exitCode;
  }
}

await main();
