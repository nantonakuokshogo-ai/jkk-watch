// monitor.mjs — 安定版：正規ルート遷移 + Referer/UA 付与 + おわび検知＆段階的リトライ（インターセプト未使用）
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const OUT_DIR = "out";
const VIEW_W = Number(process.env.VIEWPORT_W ?? 1440);
const VIEW_H = Number(process.env.VIEWPORT_H ?? 2200);

const BASE = process.env.BASE_URL || "https://jhomes.to-kousya.or.jp";
const ENTRY_REFERER = "https://www.to-kousya.or.jp/chintai/index.html";
const JKK_TOP = `${BASE}/search/jkknet/index.html`;
const SERVICE_ROOT = `${BASE}/search/jkknet/service/`;
const START_INIT = `${SERVICE_ROOT}akiyaJyoukenStartInit`;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
  "upgrade-insecure-requests": "1",
  "sec-ch-ua": '"Chromium";v="122", "Not A(Brand";v="24", "Google Chrome";v="122"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-site": "same-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document"
};

async function ensureOut() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function savePage(page, name) {
  // 念のため 0 幅対策
  await page.setViewport({ width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 });
  try {
    const html = await page.content();
    await fs.writeFile(path.join(OUT_DIR, `${name}.html`), html, "utf8");
  } catch {}
  try {
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
  } catch (e) {
    console.warn(`[warn] screenshot failed for ${name}: ${e.message}`);
  }
  console.log(`[saved] ${name}`);
}

async function gotoWithRef(page, url, referer) {
  const headers = { ...BASE_HEADERS };
  if (referer) headers.Referer = referer;
  await page.setExtraHTTPHeaders(headers);
  return page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
}

async function looksLikeOwabi(page) {
  const t = (await page.title()) || "";
  if (t.includes("おわび")) return true;
  const u = page.url();
  if (u.includes("wait.jsp")) return true;
  const hasOwabiHints = await page.evaluate(() => {
    const txt = document.body?.innerText || "";
    return /おわび|タイムアウト|もう一度|トップページへ戻る/.test(txt);
  });
  return hasOwabiHints;
}

async function logFrames(page, label) {
  const frames = page.frames();
  console.log(`[frames] count=${frames.length}`);
  for (const f of frames) console.log(`[frame] name=${f.name() || "-"} url=${f.url()}`);
  await savePage(page, label);
}

async function main() {
  await ensureOut();

  const chromePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    "";

  if (!chromePath) {
    console.error("Chromium/Chrome の実行パスが見つかりません（PUPPETEER_EXECUTABLE_PATH or CHROME_PATH）。");
    process.exit(1);
  }
  console.log(`[monitor] Using Chrome at: ${chromePath}`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    defaultViewport: { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-gpu",
      `--window-size=${VIEW_W},${VIEW_H}`,
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const page = await browser.newPage();

  // 軽めの stealth ＆ popup を同一タブ化
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["ja-JP", "ja"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    const orig = navigator.permissions && navigator.permissions.query;
    if (orig) {
      navigator.permissions.query = (p) =>
        p && p.name === "notifications" ? Promise.resolve({ state: Notification.permission }) : orig(p);
    }
    window.open = (url) => { window.location.href = url; }; // popup → 同一タブ
  });

  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders(BASE_HEADERS);

  try {
    // 1) 賃貸トップを踏む（リファラ起点）
    await gotoWithRef(page, ENTRY_REFERER, ENTRY_REFERER);
    await savePage(page, "entry_referer");

    // 2) jhomes トップ
    await gotoWithRef(page, `${BASE}/`, ENTRY_REFERER);
    await savePage(page, "home_1");

    // 3) JKKねっと トップ
    await gotoWithRef(page, JKK_TOP, `${BASE}/`);
    await savePage(page, "home_1_after");

    // 4) service へ
    await gotoWithRef(page, SERVICE_ROOT, JKK_TOP);
    await savePage(page, "service_root");

    // 5) StartInit へ
    await gotoWithRef(page, START_INIT, SERVICE_ROOT);
    await logFrames(page, "startinit_1");

    // 6) おわび検知 → 段階的にリトライ
    if (await looksLikeOwabi(page)) {
      console.log("[info] owabi detected → retry via JKK_TOP then relative navigation");
      await savePage(page, "owabi_detected");

      // JKKトップに戻る
      await gotoWithRef(page, JKK_TOP, ENTRY_REFERER);
      await savePage(page, "retry_base");

      // 同一タブ相対遷移
      await page.evaluate((url) => { window.location.href = url; }, "/search/jkknet/service/akiyaJyoukenStartInit");
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
      await logFrames(page, "startinit_2");

      // まだおわびなら、service→StartInit をもう一度
      if (await looksLikeOwabi(page)) {
        console.log("[info] still owabi → service → StartInit 再試行");
        await gotoWithRef(page, SERVICE_ROOT, JKK_TOP);
        await savePage(page, "service_root_retry");

        await gotoWithRef(page, START_INIT, SERVICE_ROOT);
        await logFrames(page, "startinit_3");
      }
    }

    // 7) 最終判定
    if (await looksLikeOwabi(page)) {
      await savePage(page, "final_error");
      throw new Error("検索フォーム／結果ページへ到達できませんでした（おわびゲート）。");
    } else {
      await savePage(page, "result_or_form"); // 到達時のフォーム/結果を保存
      console.log("[done] ✅ Artifacts の out/** を確認してください。");
    }
  } catch (e) {
    console.error(e);
    try { await savePage(page, "final_error"); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
