// monitor.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== 設定 =====
const START_URL = "https://www.to-kousya.or.jp/chintai/index.html";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const VIEWPORT = { width: 1200, height: 2200, deviceScaleFactor: 1 };
const OUT = (name) => path.join(__dirname, `${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ===============

async function save(page, base) {
  try {
    await fs.writeFile(OUT(`${base}.html`), await page.content(), "utf8");
  } catch {}
  try {
    await page.screenshot({ path: OUT(`${base}.png`), fullPage: true });
  } catch (e) {
    console.warn(`[warn] screenshot failed: ${e?.message}`);
  }
  console.log(`[saved] ${base}`);
}

function chromePathFromEnv() {
  return (
    process.env.CHROME_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome"
  );
}

async function main() {
  const executablePath = chromePathFromEnv();
  console.log(`[monitor] Using Chrome at: ${executablePath}`);

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath,
    args: [
      "--lang=ja-JP",
      "--window-size=1200,2200",
      "--disable-popup-blocking",
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ]
  });

  // ★ インコグニートは使わない（環境差で落ちないように）
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(20000);
  await page.setUserAgent(UA);
  await page.setViewport(VIEWPORT);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "ja-JP,ja;q=0.9",
    Referer: START_URL
  });

  try {
    // 1) JKK公式の賃貸トップへ
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    await save(page, "entry_referer");

    // 2) 「お部屋を検索」をクリック → 新規タブで JKKnet が開く
    const SEL_PC = 'a.el_headerBtnGreen[href*="akiyaJyoukenStartInit"]';
    const SEL_SP = 'a.el_headerBtnGreen[href*="akiyaJyoukenInitMobile"]';
    const SEL_TOPBTN = "a.bl_topSelect_btn.bl_topSelect_btn__cond";

    await page.waitForSelector(`${SEL_PC},${SEL_SP},${SEL_TOPBTN}`, {
      timeout: 15000
    });

    const pagesBefore = await browser.pages();

    await page.evaluate((pc, sp, tb) => {
      const a =
        document.querySelector(pc) ||
        document.querySelector(sp) ||
        document.querySelector(tb);
      if (!a) throw new Error("search button not found");
      a.click(); // target="JKKnet" で別タブ
    }, SEL_PC, SEL_SP, SEL_TOPBTN);

    // 3) 新規タブを取得（両取りで堅く）
    let netPage = null;
    try {
      const target = await browser.waitForTarget(
        (t) => /jhomes\.to-kousya\.or\.jp/i.test(t.url()),
        { timeout: 15000 }
      );
      netPage = await target.page();
    } catch {}
    if (!netPage) {
      await sleep(800); // 開く猶予
      const pagesAfter = await browser.pages();
      netPage = pagesAfter.find((p) => !pagesBefore.includes(p));
    }
    if (!netPage) throw new Error("JKKnet タブを取得できませんでした");

    await netPage.bringToFront();
    await netPage.setViewport(VIEWPORT);
    await netPage.setUserAgent(UA);
    await netPage.setExtraHTTPHeaders({
      "Accept-Language": "ja-JP,ja;q=0.9",
      Referer: START_URL
    });

    // 4) 遷移が落ち着くまで観測しつつ保存
    const start = Date.now();
    let lastURL = "";
    for (;;) {
      await Promise.race([
        netPage.waitForNavigation({
          waitUntil: "networkidle2",
          timeout: 12000
        }).catch(() => {}),
        sleep(1500)
      ]);

      const url = netPage.url();
      if (url !== lastURL) {
        lastURL = url;
        await save(netPage, "after_wait");
      }

      if (
        /jkknet\/service\/.+(Init|StartInit)/i.test(url) ||
        /jkknet\/result/i.test(url) ||
        /frameset/i.test(url)
      ) {
        break;
      }
      if (Date.now() - start > 25000) break;
    }

    // 5) 何が出ていても保存（結果 or フォーム or 待機）
    await save(netPage, "result_or_form");

    await browser.close();
  } catch (err) {
    console.error(err);
    try {
      await save(page, "final_error");
    } catch {}
    process.exitCode = 1;
  }
}

main();
