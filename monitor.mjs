// monitor.mjs — JKKトライ（入口は任意扱い, DNS失敗でも継続）
// 2025-10 修正版
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const OUT_DIR = "out";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH ||
  "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 入口（任意：リファラ証跡用。失敗しても続行する）
const HOME = "https://www.jkktokyo.or.jp/";

// 直接試す先の候補URL（順に試行）
const CANDIDATES = [
  "https://jhomes.to-kousya.or.jp/search/jkknet/wait.jsp",
  "https://jhomes.to-kousya.or.jp/search/jkknet/startInit.do",
  "https://jhomes.to-kousya.or.jp/search/jkknet/",
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function ensureOut() {
  await fs.mkdir(path.join(__dirname, OUT_DIR), { recursive: true });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function save(page, base) {
  const png = path.join(__dirname, OUT_DIR, `${base}.png`);
  const html = path.join(__dirname, OUT_DIR, `${base}.html`);
  await page.screenshot({ path: png, fullPage: true });
  await fs.writeFile(html, await page.content());
  console.log(`[saved] ${base}`);
}

async function note(text, base = "final_error") {
  const html = `<!doctype html><meta charset="utf-8"><pre>${text.replace(/</g,"&lt;")}</pre>`;
  await fs.writeFile(path.join(__dirname, OUT_DIR, `${base}.html`), html);
  console.warn(`[note] ${base}: ${text}`);
}

async function gotoWithRetry(page, url, label, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
      await sleep(1500);
      console.log(`[goto] ${label}: OK (${i}/${tries})`);
      return;
    } catch (e) {
      console.warn(
        `[goto] ${label}: ${e?.message || e} (${i}/${tries})`
      );
      if (i === tries) throw e;
      await sleep(1200);
    }
  }
}

// Chromeでブロックされた場合の退避：Node fetch→<base>付与で描画
async function fetchToPage(page, url) {
  const res = await fetch(url, { redirect: "follow" });
  const body = await res.text();
  const safe = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<head>/i, `<head><base href="${new URL(url).origin}/">`);
  await page.setContent(safe, { waitUntil: "domcontentloaded" });
  await sleep(1000);
}

async function main() {
  await ensureOut();
  console.log(`[monitor] Using Chrome at: ${CHROME}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",                       // ← 新Headlessで安定
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-popup-blocking",
      "--safebrowsing-disable-auto-update",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "ja,en-US;q=0.7" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "languages", { get: () => ["ja","en-US","en"] });
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      if ("userAgentData" in navigator) {
        Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
      }
    });
    await page.setViewport({ width: 1280, height: 2200, deviceScaleFactor: 1 });

    // 1) 入口（任意）。DNS障害などで失敗しても先へ進む
    try {
      await gotoWithRetry(page, HOME, "entry");
      await save(page, "entry_referer");
    } catch (e) {
      console.warn(`[entry-skipped] ${e?.message || e}`);
      await page.setContent(
        `<!doctype html><meta charset="utf-8"><h2>entry skipped</h2><p>${(e?.message||"")}</p>`
      );
      await save(page, "entry_referer_skipped"); // 証跡だけ残す
    }

    // 2) 候補URLを順に試す。Chromeブロックなら fetch 描画に切替
    let gotSomething = false;

    for (let i = 0; i < CANDIDATES.length; i++) {
      const url = CANDIDATES[i];
      const label = `candidate_${i}`;

      try {
        await gotoWithRetry(page, url, label);
        await save(page, label);

        const title = (await page.title()) || "";
        if (/404|ページが見つかりません|エラー/i.test(title)) {
          console.warn(`[skip] ${label}: title="${title}"`);
          continue;
        }
        await save(page, "result_or_form");
        gotSomething = true;
        break;
      } catch (e) {
        const msg = String(e?.message || "");
        if (/ERR_BLOCKED_BY_CLIENT|NAME_NOT_RESOLVED|net::/i.test(msg)) {
          console.warn(`[fallback] ${label}: ${msg}`);
          try {
            await fetchToPage(page, url);
            await save(page, `${label}_fetched`);
            await save(page, "result_or_form");
            gotSomething = true;
            break;
          } catch (fe) {
            console.warn(`[fallback-failed] ${label}: ${fe?.message || fe}`);
          }
        } else {
          console.warn(`[error] ${label}: ${msg}`);
        }
      }
    }

    if (!gotSomething) {
      await save(page, "after_wait");
      await note(
        "候補URLで画面を確保できませんでした。ネットワークや相手側対策の影響の可能性があります。"
      );
    }
  } catch (e) {
    await note(String(e?.stack || e), "final_error");
    throw e;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
