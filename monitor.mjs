import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outDir = path.join(__dirname, "out");

async function ensureOut() { await fs.mkdir(outDir, { recursive: true }); }

async function savePage(page, name) {
  // ビューポートが 0 幅のときの保険
  const vp = page.viewport();
  if (!vp || vp.width === 0) {
    await page.setViewport({ width: 1440, height: 2200, deviceScaleFactor: 1 });
  }
  try {
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  } catch (e) {
    console.warn(`[warn] screenshot failed: ${e.message}`);
  }
  try {
    const html = await page.content();
    await fs.writeFile(path.join(outDir, `${name}.html`), html, "utf8");
  } catch {}
  console.log(`[saved] ${name}`);
}

function chromePathFromEnv() {
  return process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || "";
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BASE = process.env.BASE_URL || "https://jhomes.to-kousya.or.jp";
const JKK_TOP = `${BASE}/search/jkknet/index.html`;
const START_INIT = `${BASE}/search/jkknet/service/akiyaJyoukenStartInit`;

async function gotoWithRef(page, url, referer) {
  if (referer) await page.setExtraHTTPHeaders({ Referer: referer });
  return page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
}

async function looksLikeOwabi(page) {
  const t = (await page.title()) || "";
  const u = page.url();
  if (t.includes("おわび")) return true;
  if (u.includes("wait.jsp")) return true;
  // 画像パスが owabi 系のときも弾く
  const hasOwabiImg = await page.evaluate(() =>
    Array.from(document.images).some(img => /owabi|backtop_out|backtop_over/.test(img.src))
  );
  return hasOwabiImg;
}

async function logFrames(page, label) {
  const frames = page.frames();
  console.log(`[frames] count=${frames.length}`);
  for (const f of frames) {
    console.log(`[frame] name=${f.name() || "-"} url=${f.url()}`);
  }
  await savePage(page, label);
  return frames.length;
}

async function main() {
  await ensureOut();

  const chromePath = chromePathFromEnv();
  if (!chromePath) {
    console.error("Chromium/Chrome の実行パスが見つかりません（PUPPETEER_EXECUTABLE_PATH or CHROME_PATH）。setup-chrome の出力を参照してください。");
    process.exit(1);
  }
  console.log(`[monitor] Using Chrome at: ${chromePath}`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1440,2200"
    ],
    defaultViewport: { width: 1440, height: 2200, deviceScaleFactor: 1 }
  });

  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "ja,en;q=0.8"
  });

  try {
    // 1) jhomes トップ
    await gotoWithRef(page, `${BASE}/`, "https://www.to-kousya.or.jp/chintai/index.html");
    await savePage(page, "home_1");

    // 2) JKKねっと トップ（正規導線のリファラを付与）
    await gotoWithRef(page, JKK_TOP, "https://www.to-kousya.or.jp/chintai/index.html");
    await savePage(page, "home_1_after");

    // 3) StartInit へ（まずは素直に移動）
    await gotoWithRef(page, START_INIT, JKK_TOP);
    await logFrames(page, "startinit_1");

    // 4) 「おわび」落ちならサイト内遷移で再試行
    if (await looksLikeOwabi(page)) {
      console.log("[info] Detected owabi gate. Retrying via in-site navigation…");
      await savePage(page, "owabi_detected");

      await gotoWithRef(page, JKK_TOP, "https://www.to-kousya.or.jp/chintai/index.html");
      await savePage(page, "retry_base");

      // 同一タブ・同一オリジンの遷移（DOM 経由）
      await page.evaluate((url) => { window.location.href = url; }, "/search/jkknet/service/akiyaJyoukenStartInit");
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
      const fcount = await logFrames(page, "startinit_2");

      // 5) まだダメなら service ルートを踏んでから再度
      if (await looksLikeOwabi(page)) {
        console.log("[info] Still owabi. Hitting service/ then StartInit…");
        await gotoWithRef(page, `${BASE}/search/jkknet/service/`, JKK_TOP);
        await savePage(page, "service_root");

        await gotoWithRef(page, START_INIT, `${BASE}/search/jkknet/service/`);
        await logFrames(page, "startinit_3");
      }
    }

    // 6) 成功判定 & 仕上げ
    if (await looksLikeOwabi(page)) {
      await savePage(page, "final_error");
      throw new Error("検索フォーム／結果ページへ到達できませんでした（おわびゲート）。");
    } else {
      // 先着順あき家のフォーム/結果（フレーム構成のはず）を保存
      await savePage(page, "result_or_form");
      console.log("[done] ここまでの out/** を Artifact でご確認ください。");
    }
  } finally {
    await browser.close();
  }
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
