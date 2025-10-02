// monitor.mjs — popupを同一タブにリダイレクト＋headless検出回避
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE_URL = process.env.BASE_URL ?? "https://jhomes.to-kousya.or.jp";
const ENTRY_REFERER = "https://www.to-kousya.or.jp/chintai/index.html";
const VIEWPORT_W = Number(process.env.VIEWPORT_W ?? 1440);
const VIEWPORT_H = Number(process.env.VIEWPORT_H ?? 2200);
const OUT_DIR = "out";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ACCEPT_LANG = "ja,en-US;q=0.9,en;q=0.8";

const EXTRA_HEADERS = {
  "Accept-Language": ACCEPT_LANG,
  "upgrade-insecure-requests": "1",
  "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
};

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }
async function savePage(page, name) {
  await ensureDir(OUT_DIR);
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  await fs.writeFile(path.join(OUT_DIR, `${name}.html`), html, "utf8");
  try {
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
  } catch (e) {
    console.warn(`[warn] screenshot failed: ${e.message}`);
  }
  console.log(`[saved] ${name}`);
}

async function clickByTextAcrossFrames(page, text) {
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate((t) => {
      const clickEl = (el) => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; };
      for (const i of Array.from(document.querySelectorAll('input[type="submit"], input[type="button"]')))
        if ((i.value || "").includes(t)) return clickEl(i);
      for (const b of Array.from(document.querySelectorAll("button")))
        if ((b.textContent || "").includes(t)) return clickEl(b);
      for (const a of Array.from(document.querySelectorAll("a")))
        if ((a.textContent || "").includes(t)) return clickEl(a);
      return false;
    }, text);
    if (clicked) return true;
  }
  return false;
}

async function main() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (!executablePath) {
    console.error("Chrome 実行パスが見つかりません");
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled", // headless検出回避
      `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
    ],
  });

  const page = await browser.newPage();

  // headless検出回避：navigator.webdriver削除など
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["ja-JP", "ja"] });
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: "granted" })
        : originalQuery(parameters);
    // popupを同一タブにリダイレクト
    window.open = (url) => { window.location.href = url; };
  });

  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders(EXTRA_HEADERS);
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });

  try {
    // 1) 賃貸トップ経由
    await page.goto(ENTRY_REFERER, { waitUntil: "domcontentloaded" });
    await savePage(page, "entry_referer");

    // 2) jhomes top
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", referer: ENTRY_REFERER });
    await savePage(page, "home_1");

    // 3) jkknet top
    await page.goto(`${BASE_URL}/search/jkknet/`, { waitUntil: "domcontentloaded", referer: ENTRY_REFERER });
    await savePage(page, "home_1_after");

    // 4) service (popupを同一タブで開くようにフック済み)
    await page.goto(`${BASE_URL}/search/jkknet/service/`, { waitUntil: "domcontentloaded" });
    await savePage(page, "home_2");

    // 5) 「検索する」を押す（入力なし）
    const clicked = await clickByTextAcrossFrames(page, "検索する") ||
                    await clickByTextAcrossFrames(page, "検索");
    await savePage(page, "after_click_raw");

    if (clicked) {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
      await savePage(page, "after_click_final");
    } else {
      console.warn("[warn] 検索ボタン見つからず");
    }

    console.log("[done] ✅ finished (popup→同一タブ + stealth)");
  } catch (e) {
    console.error(e);
    try { await savePage(page, "final_error"); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
