// monitor.mjs  — JKKトライの堅め版
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

// ---------- 設定 ----------
const OUT_DIR = "out";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH ||
  "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome";

// ユーザーエージェントを Headless っぽくない文字列に固定
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HOME = "https://www.jkktokyo.or.jp/"; // 入口（リファラ用）
const CANDIDATES = [
  // jhomes 側の候補 URL（順に試行）
  "https://jhomes.to-kousya.or.jp/search/jkknet/wait.jsp",
  "https://jhomes.to-kousya.or.jp/search/jkknet/startInit.do",
  "https://jhomes.to-kousya.or.jp/search/jkknet/",
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function ensureOut() {
  await fs.mkdir(path.join(__dirname, OUT_DIR), { recursive: true });
}
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function save(page, base) {
  const png = path.join(__dirname, OUT_DIR, `${base}.png`);
  const html = path.join(__dirname, OUT_DIR, `${base}.html`);
  await page.screenshot({ path: png, fullPage: true });
  await fs.writeFile(html, await page.content());
  console.log(`[saved] ${base}`);
}
async function note(text, base = "final_error") {
  const html = `<!doctype html><meta charset="utf-8"><pre>${text}</pre>`;
  await fs.writeFile(path.join(__dirname, OUT_DIR, `${base}.html`), html);
  console.warn(`[note] ${base}: ${text}`);
}

// 古い puppeteer でも動くよう waitForTimeout は使わない
async function gotoWithRetry(page, url, label, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
      // ネットワーク静穏待ちの代替（軽め）
      await sleep(1500);
      console.log(`[goto] ${label}: OK (${i}/${tries})`);
      return;
    } catch (e) {
      console.warn(`[goto] ${label}: ${e.message} (${i}/${tries})`);
      if (i === tries) throw e;
      await sleep(1200);
    }
  }
}

// Chrome がブロックした場合の退避（Node fetch → <base> 付きで描画）
async function fetchToPage(page, url) {
  const res = await fetch(url, { redirect: "follow" });
  const body = await res.text();
  // 相対URLが生きるように <base> を付与し、危険な <script> は潰す
  const safe = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(
      /<head>/i,
      `<head><base href="${new URL(url).origin}/">`
    );
  await page.setContent(safe, { waitUntil: "domcontentloaded" });
  await sleep(1000);
}

async function main() {
  await ensureOut();

  console.log(`[monitor] Using Chrome at: ${CHROME}`);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,                 // ランナーでは headless 固定が安定
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-client-side-phishing-detection",
      "--disable-popup-blocking",
      "--safebrowsing-disable-auto-update",
    ],
  });

  try {
    const page = await browser.newPage();

    // UA・言語・webdriver を偽装（evaluateOnNewDocument は広い版で使える）
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "ja,en-US;q=0.7" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "languages", {
        get: () => ["ja", "en-US", "en"],
      });
      Object.defineProperty(navigator, "platform", {
        get: () => "Win32",
      });
      // たまに UA Client Hints を強く見るページがあるので最低限潰す
      if ("userAgentData" in navigator) {
        Object.defineProperty(navigator, "userAgentData", {
          get: () => undefined,
        });
      }
    });
    await page.setViewport({ width: 1280, height: 2200, deviceScaleFactor: 1 });

    // 1) 入口ページ（リファラ確保 & 証跡）
    await gotoWithRetry(page, HOME, "entry");
    await save(page, "entry_referer");

    // 2) 候補URLを順に試す。Chrome でダメなら Node fetch で描画させる
    let gotSomething = false;
    for (let i = 0; i < CANDIDATES.length; i++) {
      const url = CANDIDATES[i];
      const label = `candidate_${i}`;

      try {
        await gotoWithRetry(page, url, label);
        await save(page, label); // 成功時そのまま保存
        // 404/エラーページらしきものは弾いて次へ
        const title = (await page.title()) || "";
        if (/404|ページが見つかりません|エラー/i.test(title)) {
          console.warn(`[skip] ${label}: title="${title}"`);
          continue;
        }
        // ここまで来たら “フォーム or 一覧” どちらでも採用
        await save(page, "result_or_form");
        gotSomething = true;
        break;
      } catch (e) {
        // Chrome 側でブロック or 名前解決NG → Node fetch で代替描画
        const msg = String(e && e.message || "");
        if (/ERR_BLOCKED_BY_CLIENT|NAME_NOT_RESOLVED|net::/i.test(msg)) {
          console.warn(`[fallback] ${label}: ${msg}`);
          try {
            await fetchToPage(page, url);
            await save(page, label + "_fetched");
            await save(page, "result_or_form");
            gotSomething = true;
            break;
          } catch (fe) {
            console.warn(`[fallback-failed] ${label}: ${fe.message}`);
          }
        } else {
          console.warn(`[error] ${label}: ${msg}`);
        }
      }
    }

    // 3) 何も掴めなかったら、最後の画面を after_wait として残す
    if (!gotSomething) {
      await save(page, "after_wait");
      await note(
        "候補URLにアクセスできませんでした（Chromeブロック or ネットワーク不安定）。" +
          " out/entry_referer.png を確認してください。"
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
