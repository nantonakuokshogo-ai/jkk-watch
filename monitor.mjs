// monitor.mjs — 入力は一切せず、「検索する」を押して結果(またはフォーム)のスクショを残す
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE_URL = process.env.BASE_URL ?? "https://jhomes.to-kousya.or.jp";
const ENTRY_REFERER = "https://www.to-kousya.or.jp/chintai/index.html";
const VIEWPORT_W = Number(process.env.VIEWPORT_W ?? 1440);
const VIEWPORT_H = Number(process.env.VIEWPORT_H ?? 2200);
const OUT_DIR = "out";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ACCEPT_LANG = "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7";

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }
async function safeScreenshot(page, filePath, { fullPage = true } = {}) {
  try { await page.screenshot({ path: filePath, fullPage }); return; }
  catch (e1) { console.warn(`[warn] screenshot failed 1st: ${e1.message}`); }
  try {
    await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });
    await page.evaluate(() => { if (document.body) document.body.style.minHeight = "10px"; });
    await page.waitForFunction(
      () => document.documentElement.clientWidth > 0 && document.documentElement.clientHeight > 0,
      { timeout: 3000 }
    ).catch(() => {});
    await page.screenshot({ path: filePath, fullPage });
  } catch (e2) {
    console.warn(`[warn] screenshot failed 2nd: ${e2.message}`);
    try { await page.screenshot({ path: filePath, fullPage: false }); }
    catch (e3) { console.warn(`[warn] screenshot final failed: ${e3.message}`); }
  }
}
async function savePage(page, name) {
  await ensureDir(OUT_DIR);
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  await fs.writeFile(path.join(OUT_DIR, `${name}.html`), html, "utf8");
  await safeScreenshot(page, path.join(OUT_DIR, `${name}.png`), { fullPage: true });
  console.log(`[saved] ${name}`);
}
function logFrames(page) {
  const frames = page.frames();
  console.log(`[frames] count=${frames.length}`);
  frames.forEach((f, i) => console.log(`[frame#${i}] name=${f.name() || "-"} url=${f.url()}`));
  return frames;
}

// テキスト一致でクリック（button / input[value] / a）
async function clickByTextAcrossFrames(page, text) {
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate((t) => {
      t = t.trim();
      const clickEl = (el) => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; };
      for (const i of Array.from(document.querySelectorAll('input[type="submit"], input[type="button"]')))
        if ((i.value || "").trim().includes(t)) return clickEl(i);
      for (const b of Array.from(document.querySelectorAll("button")))
        if ((b.textContent || "").trim().includes(t)) return clickEl(b);
      for (const a of Array.from(document.querySelectorAll("a")))
        if ((a.textContent || "").trim().includes(t)) return clickEl(a);
      return false;
    }, text);
    if (clicked) return true;
  }
  return false;
}

// 特定URLパターンのフレームを待つ
async function waitForFrameUrl(page, pattern, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const f = page.frames().find(fr => pattern.test(fr.url()));
    if (f) return f;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

// popup を once で待つ
function waitForPopup(page, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("popup timeout")), timeout);
    page.once("popup", async (popup) => {
      clearTimeout(timer);
      try {
        await popup.bringToFront();
        await popup.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });
      } catch {}
      resolve(popup);
    });
  });
}

async function main() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (!executablePath) {
    console.error("Chromium/Chrome の実行パスが見つかりません（PUPPETEER_EXECUTABLE_PATH or CHROME_PATH）。");
    process.exit(1);
  } else {
    console.log(`[monitor] Using Chrome at: ${executablePath}`);
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox", `--window-size=${VIEWPORT_W},${VIEWPORT_H}`],
  });

  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ "Accept-Language": ACCEPT_LANG });
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });

  try {
    // 1) 都公社トップ（賃貸）を踏む（Referer 作成）
    await page.goto(ENTRY_REFERER, { waitUntil: "domcontentloaded" });
    await savePage(page, "entry_referer");

    // 2) jhomes top
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", referer: ENTRY_REFERER });
    await savePage(page, "home_1");

    // 3) jkknet top
    await page.goto(`${BASE_URL}/search/jkknet/`, { waitUntil: "domcontentloaded", referer: ENTRY_REFERER });
    await savePage(page, "home_1_after");

    // 4) service 遷移＆popup を待つ
    const popupPromise = waitForPopup(page, 15000);
    await page.goto(`${BASE_URL}/search/jkknet/service/`, {
      waitUntil: "domcontentloaded",
      referer: `${BASE_URL}/search/jkknet/`,
    });
    await savePage(page, "home_2");

    let popup;
    try {
      popup = await popupPromise;
    } catch {
      // フォールバック：window.open を強制
      await page.evaluate(() => {
        try { if (typeof openMainWindow === "function") { openMainWindow(); return; } } catch {}
        window.open("/search/jkknet/wait.jsp", "JKKnet");
      });
      const target = await browser.waitForTarget(
        (t) => t.opener() && t.opener()._targetId === page.target()._targetId,
        { timeout: 10000 }
      );
      popup = await target.page();
      await popup.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });
      await popup.setUserAgent(UA);
      await popup.setExtraHTTPHeaders({ "Accept-Language": ACCEPT_LANG });
    }

    await savePage(popup, "home_2_after");
    logFrames(popup);

    // 5) frameset -> 「待機ページ(wait.jsp)」→ 本体へ遷移を期待して少し待機
    //    直接 wait.jsp のままなら軽くアクション（「トップへ戻る」以外のリンクや「条件検索」など）を試す
    await savePage(popup, "frameset_startinit");

    // 待機：本体フレームに検索UIが現れるかを見る
    let searchFrame = await waitForFrameUrl(popup, /akiyaJyouken/i, 8000);
    if (!searchFrame) {
      // 画面にそれっぽいリンクがあればクリックしてみる
      await clickByTextAcrossFrames(popup, "条件検索")
        || await clickByTextAcrossFrames(popup, "先着順")
        || await clickByTextAcrossFrames(popup, "空家")
        || await clickByTextAcrossFrames(popup, "検索");
      await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
      searchFrame = await waitForFrameUrl(popup, /akiyaJyouken|Jyouken|search/i, 8000);
    }

    await savePage(popup, "before_click");

    // 6) 入力はしない。見つかった画面上で「検索する」を押す
    //    まずフレーム横断で探し、なければページ上のあらゆる「検索」系を押してみる
    let clicked = await clickByTextAcrossFrames(popup, "検索する");
    if (!clicked) {
      clicked = await clickByTextAcrossFrames(popup, "検索");
    }

    if (clicked) {
      await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await savePage(popup, "after_click");
    } else {
      console.warn("[warn] 検索実行ボタンが見つからず。フォーム到達のスクショのみ保存します。");
    }

    // 7) 仕上げ：見えるものをすべて保存して終了（結果orフォーム）
    await savePage(popup, "result_or_form");

    console.log("[done] ✅ finished (inputless)");
  } catch (e) {
    console.error(e);
    try { await savePage(page, "final_error"); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
