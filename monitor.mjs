// monitor.mjs
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const OUT_DIR = "out";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureOut() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function saveHtml(name, html) {
  await ensureOut();
  await fs.writeFile(path.join(OUT_DIR, `${name}.html`), html, "utf8");
}

async function saveNote(name, message) {
  const html = `<!doctype html><meta charset="utf-8">
<title>${name}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif; line-height:1.6; margin:40px;}
.card{max-width:760px;border-radius:12px;border:1px solid #e5e7eb;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.06);}
h1{margin:0 0 12px 0;font-size:22px}
.code{background:#111;color:#fff;padding:10px;border-radius:8px;white-space:pre-wrap}
small{color:#6b7280}
</style>
<div class="card">
<h1>entry skipped</h1>
<p>DNS/接続の事情によりエントリーページへ到達できませんでした。</p>
<div class="code">${message}</div>
<small>このメモは監視の継続性のために自動生成されています。</small>
</div>`;
  await saveHtml(name, html);
}

async function saveShot(page, name) {
  await ensureOut();
  await page.screenshot({
    path: path.join(OUT_DIR, `${name}.png`),
    fullPage: true,
  });
  await saveHtml(name, await page.content());
}

async function gotoWithRetry(page, urls, saveName) {
  for (const url of urls) {
    for (let i = 1; i <= 3; i++) {
      try {
        console.log(`[goto] ${url} (${i}/3)`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
        await page.waitForSelector("body", { timeout: 12000 }).catch(()=>{});
        await sleep(500); // 落ち着かせる
        await saveShot(page, saveName);
        return true;
      } catch (err) {
        console.log(`[goto] failed: ${err}`);
        // DNS 系は早めに次の候補へ
        if ((err?.message || "").includes("ERR_NAME_NOT_RESOLVED")) break;
        await sleep(1000);
      }
    }
  }
  return false;
}

async function main() {
  const executablePath =
    process.env.CHROME_BIN ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    "/usr/bin/google-chrome";
  console.log("[monitor] Using Chrome at:", executablePath);

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1440,2500",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 2000, deviceScaleFactor: 2 });

  // 1) JKK トップ（候補 URL を順番に試す）
  const entryUrls = [
    "https://www.jkktokyo.or.jp/",
    "https://jkktokyo.or.jp/",
    "https://www.jkk-tokyo.or.jp/",
    "https://jkk-tokyo.or.jp/",
  ];
  const entryOk = await gotoWithRetry(page, entryUrls, "entry_referer");
  if (!entryOk) {
    await saveNote(
      "entry_referer_skipped",
      `URL: ${entryUrls[0]}\nlast error:\nnet::ERR_NAME_NOT_RESOLVED など`
    );
  }

  // 2) 検索系（到達できれば保存、ダメならメモ）
  const resultUrls = [
    "https://jhomes.to-kousya.or.jp/search/jkknet/wait.jsp",
  ];
  try {
    const got = await gotoWithRetry(page, resultUrls, "after_wait");
    if (!got) {
      await saveNote(
        "result_or_form",
        "検索フォーム/結果はブロックまたは到達不可でした。"
      );
    }
  } catch (e) {
    await saveNote("final_error", String(e?.stack || e));
  }

  await browser.close();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await saveNote("final_error", String(e?.stack || e));
  } catch {}
  process.exitCode = 1;
});
