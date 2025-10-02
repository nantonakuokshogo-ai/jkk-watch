// monitor.mjs — トップ経由で正規ルートを辿る + Referer/UA/CH headers 強化 + stealth
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE_URL = process.env.BASE_URL ?? "https://jhomes.to-kousya.or.jp";
const ENTRY_REFERER = "https://www.to-kousya.or.jp/chintai/index.html";
const VIEWPORT_W = Number(process.env.VIEWPORT_W ?? 1440);
const VIEWPORT_H = Number(process.env.VIEWPORT_H ?? 2200);
const OUT_DIR = "out";

// UA/ヘッダは現行のブラウザっぽく
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const EXTRA_HEADERS = {
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
  "upgrade-insecure-requests": "1",
  "sec-ch-ua": '"Chromium";v="122", "Not A(Brand";v="24", "Google Chrome";v="122"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-site": "same-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
  // (Referer will be set for navigations separately where appropriate)
};

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

async function savePage(page, name) {
  await ensureDir(OUT_DIR);
  try {
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    await fs.writeFile(path.join(OUT_DIR, `${name}.html`), html, "utf8");
  } catch (e) {
    console.warn(`[warn] save html failed for ${name}: ${e.message}`);
  }
  try {
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
  } catch (e) {
    console.warn(`[warn] screenshot failed for ${name}: ${e.message}`);
  }
  console.log(`[saved] ${name}`);
}

// フレーム横断でテキスト一致クリック（ボタン・input・a）
async function clickByTextAcrossFrames(page, text) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const ok = await frame.evaluate((t) => {
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
      if (ok) return true;
    } catch (e) {
      // フレームにアクセスできない場合がある — 無視
    }
  }
  return false;
}

// main
async function main() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (!executablePath) {
    console.error("Chromium/Chrome の実行パスが見つかりません（PUPPETEER_EXECUTABLE_PATH or CHROME_PATH）。");
    process.exit(1);
  }
  console.log(`[monitor] Using Chrome at: ${executablePath}`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
    ],
  });

  const page = await browser.newPage();

  // stealth-like tweaks before any page loads
  await page.evaluateOnNewDocument(() => {
    // navigator.webdriver
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // languages
    Object.defineProperty(navigator, "languages", { get: () => ["ja-JP", "ja"] });
    // plugins
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    // chrome object
    window.chrome = { runtime: {} };
    // permissions.query tweak (common stealth trick)
    const origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = (params) =>
        params && params.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(params);
    }
    // popup を同一タブに置き換え（open を上書き）
    window.open = (url) => { window.location.href = url; };
  });

  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders(EXTRA_HEADERS);
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });

  try {
    // --- 1) entry referer (都公社賃貸トップ) ---
    await page.goto(ENTRY_REFERER, { waitUntil: "domcontentloaded", referer: ENTRY_REFERER });
    await savePage(page, "entry_referer");

    // --- 2) jhomes top (with referer) ---
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", referer: ENTRY_REFERER });
    await savePage(page, "home_1");

    // --- 3) jkknet top (click the proper link on jhomes top rather than direct goto) ---
    // Try to find a link to /search/jkknet/ on jhomes top and click it; fallback to goto if not found.
    let clickedJkk = false;
    try {
      // Try clicking anchor elements containing "jkknet" or "JKKねっと" text
      clickedJkk =
        await clickByTextAcrossFrames(page, "JKKねっと") ||
        await clickByTextAcrossFrames(page, "JKKねっと登録") ||
        await clickByTextAcrossFrames(page, "JKK") ||
        await clickByTextAcrossFrames(page, "お部屋をえらぶ");
      if (clickedJkk) {
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(()=>{});
      }
    } catch (e) {
      // ignore
    }
    if (!clickedJkk) {
      // fallback: direct goto but include referer
      await page.goto(`${BASE_URL}/search/jkknet/`, { waitUntil: "domcontentloaded", referer: `${BASE_URL}/` });
    }
    await savePage(page, "home_1_after");

    // --- 4) From jkknet top, click the service / こだわり条件 / 地図 or the link that opens the popup ---
    // We will try several button texts in order to follow a natural user flow.
    const tryTexts = [
      "こだわり条件", "条件から探す", "地図", "JKKねっと", "先着順", "検索する", "インターネット申込みサービス",
      "お部屋をえらぶ", "賃貸トップ", "サービス"
    ];
    let clickedService = false;
    for (const t of tryTexts) {
      clickedService = await clickByTextAcrossFrames(page, t);
      if (clickedService) {
        // navigation might be popup (converted to same-tab) or a navigation in current doc
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(()=>{});
        break;
      }
    }

    // If not clicked, as last resort navigate to service url (but include referer)
    if (!clickedService) {
      await page.goto(`${BASE_URL}/search/jkknet/service/`, { waitUntil: "domcontentloaded", referer: `${BASE_URL}/search/jkknet/` });
    }
    await savePage(page, "home_2");

    // --- 5) At this point the popup (if any) is converted to same-tab. Save frameset start ---
    await savePage(page, "frameset_startinit");

    // --- 6) Try to find and click "検索する" (no input) across frames/pages ---
    // Give the page a moment to load potential dynamic frames
    await new Promise(r => setTimeout(r, 1200));
    const clickedSearch = await clickByTextAcrossFrames(page, "検索する") || await clickByTextAcrossFrames(page, "検索");
    await savePage(page, "after_click_raw");

    if (clickedSearch) {
      // wait for navigation that is likely to happen after the search click
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
      await savePage(page, "after_click_final");
    } else {
      console.warn("[warn] 検索ボタンが見つかりませんでした（クリックせず）");
    }

    console.log("[done] finished (top-route + referer/UA spoofing)");
  } catch (e) {
    console.error("[error]", e);
    try { await savePage(page, "final_error"); } catch (err) { console.warn("failed to save final_error:", err.message); }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
