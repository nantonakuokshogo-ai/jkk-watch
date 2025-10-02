// 追加ヘッダで本物Chromeに寄せる版
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
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true }).catch(e => {
    console.warn(`[warn] screenshot failed: ${e.message}`);
  });
  console.log(`[saved] ${name}`);
}

function waitForPopup(page, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("popup timeout")), timeout);
    page.once("popup", async (popup) => {
      clearTimeout(timer);
      await popup.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });
      resolve(popup);
    });
  });
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
    args: ["--no-sandbox", `--window-size=${VIEWPORT_W},${VIEWPORT_H}`],
  });
  const page = await browser.newPage();

  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders(EXTRA_HEADERS);

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

    // 4) service + popup
    const popupPromise = waitForPopup(page, 15000);
    await page.goto(`${BASE_URL}/search/jkknet/service/`, { waitUntil: "domcontentloaded" });
    const popup = await popupPromise.catch(() => null);
    await savePage(page, "home_2");
    if (!popup) throw new Error("popup 開けず");

    await popup.setUserAgent(UA);
    await popup.setExtraHTTPHeaders(EXTRA_HEADERS);
    await savePage(popup, "home_2_after");

    // 5) 「検索する」を押す
    const clicked = await clickByTextAcrossFrames(popup, "検索する") ||
                    await clickByTextAcrossFrames(popup, "検索");
    if (clicked) {
      await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
      await savePage(popup, "after_click");
    }

    console.log("[done] ✅ finished with UA+headers spoofing");
  } catch (e) {
    console.error(e);
    try { await savePage(page, "final_error"); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
