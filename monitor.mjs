// monitor.mjs
import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH ||
  "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome";

const OUT   = path.resolve("./out");
const ENTRY = "https://www.to-kousya.or.jp/chintai/index.html";
const WAIT  = "https://www.to-kousya.or.jp/search/jkknet/wait.jsp";

await fs.mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const save  = async (page, name) => {
  try { await fs.writeFile(path.join(OUT, `${name}.html`), await page.content(), "utf8"); } catch {}
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  } catch {
    // 0 width 対策
    await page.setViewport({ width: 1365, height: 2200, deviceScaleFactor: 1 });
    await sleep(250);
    try { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }); } catch {}
  }
  console.log(`[saved] ${name}`);
};

// 'popup'を確実に取る（v23 でも安全）
function waitForPopup(page, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off("popup", onPopup);
      reject(new Error("popup timeout"));
    }, timeout);
    const onPopup = (p) => { clearTimeout(timer); page.off("popup", onPopup); resolve(p); };
    page.on("popup", onPopup);
  });
}

// 目的ドメインへフォールバック遷移（Referer付き）
async function gotoOne(ctx, url, referer) {
  try {
    await ctx.goto(url, { waitUntil: "domcontentloaded", referer, timeout: 30000 });
    return true;
  } catch (e) {
    console.warn(`[warn] goto fail: ${url} -> ${e.message}`);
    return false;
  }
}

// “検索する” を見つけたら押す（失敗は無視）
async function tryPressSearch(ctx) {
  for (const fr of ctx.frames()) {
    try {
      const clicked = await fr.evaluate(() => {
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect(), s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        const pool = Array.from(document.querySelectorAll('input[type="submit"],input[type="image"],button,a'));
        const btn  = pool.find(el => /検索/.test((el.value||el.alt||el.textContent||"").trim()) && vis(el));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (clicked) return true;
    } catch {}
  }
  return false;
}

// 一覧 or 初期フォームらしさを軽く判定（撮る対象が出たかどうか）
async function looksReady(ctx) {
  const url = ctx.url();
  if (/jhomes\.to-kousya\.or\.jp\/search\/jkknet\/service/.test(url)) return true;
  for (const fr of ctx.frames()) {
    try {
      const hasKeywords = await fr.evaluate(() => {
        const t = document.body ? document.body.innerText : "";
        return /検索条件|物件一覧|該当件数|条件をクリア|検索する/.test(t);
      });
      if (hasKeywords) return true;
    } catch {}
  }
  return false;
}

async function main() {
  console.log("[monitor] Using Chrome at:", CHROME);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true, // 互換性重視
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-features=BlockInsecurePrivateNetworkRequests",
      "--window-size=1365,2200",
      "--lang=ja-JP",
    ],
    defaultViewport: { width: 1365, height: 2200, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.setExtraHTTPHeaders({ "Accept-Language": "ja,en;q=0.9" });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  let ctx = page; // 以降の操作対象（popup発生なら置き換える）

  try {
    // 1) 参照元（念のためキャプチャ）
    await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
    await save(page, "entry_referer");

    // 2) wait.jsp 経由で popup 捕捉（または同タブ遷移）
    let popup = null;
    const popPromise = waitForPopup(page, 12000);
    await page.goto(WAIT, { waitUntil: "domcontentloaded", referer: ENTRY });
    try { popup = await popPromise; } catch {}
    if (popup && !popup.isClosed()) {
      ctx = popup;
      await ctx.bringToFront();
    }
    await save(ctx, "after_wait");

    // 3) ここで結果に辿り着けない場合のフォールバック（順にトライ）
    const candidates = [
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/",
      "https://jhomes.to-kousya.or.jp/search/jkknet/",
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenInitMobile"
    ];
    let reached = await looksReady(ctx);
    for (let i = 0; i < 2 && !reached; i++) { // 最大2周（軽いリトライ）
      for (const url of candidates) {
        if (reached) break;
        const ok = await gotoOne(ctx, url, WAIT);
        if (ok) {
          await save(ctx, `candidate_${i}`);
          reached = await looksReady(ctx);
          if (!reached) await sleep(800);
        }
      }
    }

    // 4) 可能なら “検索する” を押して一覧へ（失敗は無視）
    if (await tryPressSearch(ctx)) {
      await sleep(1800);
      reached = await looksReady(ctx);
    }

    // 5) 最終キャプチャ（到達できていなくても証跡を残す）
    await save(ctx, reached ? "result_or_form" : "final_error");

  } catch (e) {
    console.error(e);
    try { await save(ctx, "final_error"); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
