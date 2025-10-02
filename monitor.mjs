// monitor.mjs
// Node20 + puppeteer-core v23 / 旧API未使用
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE_URL = process.env.BASE_URL ?? "https://jhomes.to-kousya.or.jp";
const KANA = process.env.KANA ?? "コーシャハイム";
const VIEWPORT_W = Number(process.env.VIEWPORT_W ?? 1440);
const VIEWPORT_H = Number(process.env.VIEWPORT_H ?? 2200);
const OUT_DIR = "out";

// “普通のChrome”っぽい UA（Headless を含めない）
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ACCEPT_LANG = "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7";
const ENTRY_REFERER = "https://www.to-kousya.or.jp/chintai/index.html";

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

async function safeScreenshot(page, filePath, { fullPage = true } = {}) {
  try {
    await page.screenshot({ path: filePath, fullPage });
    return;
  } catch (e1) { console.warn(`[warn] screenshot failed 1st: ${e1.message}`); }
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
    try { await page.screenshot({ path: filePath, fullPage: false }); } catch (e3) {
      console.warn(`[warn] screenshot final failed: ${e3.message}`);
    }
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

// ---- 入力・クリックユーティリティ（フレーム横断） ----
async function typeByNearbyLabelAcrossFrames(page, labelText, value) {
  for (const frame of page.frames()) {
    const handle = await frame.evaluateHandle((text) => {
      const snapshot = document.evaluate(
        `//*[contains(normalize-space(.), "${text}")]`,
        document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
      );
      function findInputNear(el) {
        const q = 'input[type="text"], input:not([type]), input[type="search"]';
        let inp = el.querySelector(q); if (inp) return inp;
        const cell = el.closest("td,th,div,li,label,dt,dd");
        if (cell?.nextElementSibling) { inp = cell.nextElementSibling.querySelector(q); if (inp) return inp; }
        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i++) { inp = p.querySelector(q); if (inp) return inp; p = p.parentElement; }
        if (cell?.parentElement) for (const s of Array.from(cell.parentElement.children)) {
          inp = s.querySelector(q); if (inp) return inp;
        }
        return null;
      }
      for (let i = 0; i < snapshot.snapshotLength; i++) {
        const el = snapshot.snapshotItem(i);
        const target = findInputNear(el);
        if (target) return target;
      }
      return null;
    }, labelText);

    const el = handle.asElement();
    if (el) {
      await el.focus();
      await frame.evaluate((e) => (e.value = ""), el);
      await el.type(value, { delay: 20 });
      return;
    } else {
      await handle.dispose();
    }
  }
  throw new Error(`${labelText} の入力欄が見つかりませんでした。`);
}

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

// ---- 変更点：popup 待機を once で実装（removeListener 不要） ----
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

  // “HeadlessChrome”を隠す・日本語優先・参照元付与
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ "Accept-Language": ACCEPT_LANG });
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });

  try {
    // 1) まず to-kousya 本体を踏んで Referer を作る
    await page.goto(ENTRY_REFERER, { waitUntil: "domcontentloaded" });
    await savePage(page, "entry_referer");

    // 2) jhomes top（Referer 付き）
    await page.goto(`${BASE_URL}/`, {
      waitUntil: "domcontentloaded",
      referer: ENTRY_REFERER,
    });
    await savePage(page, "home_1");

    // 3) jkknet top
    await page.goto(`${BASE_URL}/search/jkknet/`, {
      waitUntil: "domcontentloaded",
      referer: ENTRY_REFERER,
    });
    await savePage(page, "home_1_after");

    // 4) service へ遷移（ここでpopup待ちを仕掛ける）
    const popupPromise = waitForPopup(page, 15000);
    await page.goto(`${BASE_URL}/search/jkknet/service/`, {
      waitUntil: "domcontentloaded",
      referer: `${BASE_URL}/search/jkknet/`,
    });
    await savePage(page, "home_2");

    // 5) popup 取得 or フォールバック
    let popup;
    try {
      popup = await popupPromise;
    } catch {
      // openMainWindow() があればそれを使い、無ければ wait.jsp を開く
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
    await savePage(popup, "frameset_startinit");
    logFrames(popup);

    // 6) 「おわび」検出（念のため）
    const isOwabi = await popup.evaluate(
      () => /おわび/.test(document.title || "") || (document.body && document.body.innerText.includes("おわび"))
    );
    if (isOwabi) {
      await savePage(popup, "final_error");
      throw new Error("「おわび」ページに遷移しました。Referer/UA 制約の可能性があります。");
    }

    // 7) 入力 → 検索
    let typed = false;
    try {
      await savePage(popup, "before_fill");
      await typeByNearbyLabelAcrossFrames(popup, "住宅名(カナ)", KANA);
      typed = true;
    } catch {
      const moved =
        (await clickByTextAcrossFrames(popup, "条件検索")) ||
        (await clickByTextAcrossFrames(popup, "先着順")) ||
        (await clickByTextAcrossFrames(popup, "空家")) ||
        (await clickByTextAcrossFrames(popup, "検索"));
      if (moved) {
        await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await savePage(popup, "before_fill");
        await typeByNearbyLabelAcrossFrames(popup, "住宅名(カナ)", KANA);
        typed = true;
      }
    }

    if (!typed) {
      await savePage(popup, "final_error");
      throw new Error("住宅名(カナ) の入力欄が見つかりませんでした。");
    }

    const clicked = await clickByTextAcrossFrames(popup, "検索する");
    if (!clicked) {
      await savePage(popup, "final_error");
      throw new Error("「検索する」ボタンが見つかりませんでした。");
    }

    await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await savePage(popup, "result");

    console.log("[done] ✅ finished");
  } catch (e) {
    console.error(e);
    try { await savePage(page, "final_error"); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
