// monitor.mjs
// JKK: 「住宅名(カナ) = コーシャハイム」で検索実行して、画面HTML/スクショを out/ に保存します。

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT = path.join(__dirname, "out");

const BASE = "https://jhomes.to-kousya.or.jp";
const START_INIT = BASE + "/search/jkknet/service/akiyaJyoukenStartInit";

// ===== helpers =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureOut() {
  await fs.mkdir(OUT, { recursive: true });
}
async function save(page, name) {
  await ensureOut();
  const html = await page.content();
  await fs.writeFile(path.join(OUT, `${name}.html`), html);
  // 0 width 対策: viewport を必ず設定した上で撮る
  const vp = page.viewport();
  if (!vp || !vp.width || !vp.height) {
    await page.setViewport({ width: 1280, height: 1800, deviceScaleFactor: 1 });
  }
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log(`[saved] ${name}`);
}

async function gotoAndSave(page, url, name, referer) {
  if (referer) {
    await page.setExtraHTTPHeaders({ Referer: referer });
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await save(page, name);
}

async function launch() {
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.GOOGLE_CHROME_BIN ||
    "/usr/bin/google-chrome";

  console.log("[monitor] Using Chrome at:", executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1280,2000",
    ],
    defaultViewport: { width: 1280, height: 1800, deviceScaleFactor: 1 },
  });
  return browser;
}

// 住宅名(カナ) の入力ボックスを探す（複数パターンに対応）
async function findKanaInput(page) {
  // 1) name 直指定
  let h = await page.$('input[name="jyutakuKanaName"]');
  if (h) return h;

  // 2) id/partial name
  h = await page.$('input#jyutakuKanaName, input[name*="Kana"]');
  if (h) return h;

  // 3) ラベル文言の直後の input
  const xpath =
    "//*[contains(normalize-space(.),'住宅名') and contains(normalize-space(.),'カナ')]/following::input[1]";
  const xs = await page.$x(xpath);
  if (xs && xs.length) return xs[0];

  return null;
}

async function clickSearch(page) {
  // いろいろな「検索」ボタンに対応
  const xpaths = [
    // input / button / image
    "//input[( @type='submit' or @type='button' or @type='image') and (contains(@value,'検索') or contains(@alt,'検索') or contains(@title,'検索'))]",
    "//button[contains(.,'検索')]",
    "//a[contains(.,'検索する') or contains(.,'検索')]",
  ];
  for (const xp of xpaths) {
    const hit = await page.$x(xp);
    if (hit && hit.length) {
      await hit[0].click();
      return true;
    }
  }
  return false;
}

async function main() {
  const browser = await launch();
  const page = await browser.newPage();
  try {
    // --- TOP → service へ（Referer 必須なため順路で辿る） ---
    await gotoAndSave(page, BASE + "/", "home_1");
    await gotoAndSave(page, BASE + "/search/jkknet/", "home_1_after", BASE + "/");
    await gotoAndSave(
      page,
      BASE + "/search/jkknet/index.html",
      "home_2",
      BASE + "/search/jkknet/"
    );
    await gotoAndSave(
      page,
      BASE + "/search/jkknet/service/",
      "home_2_after",
      BASE + "/search/jkknet/index.html"
    );

    // --- StartInit（中継ページ） ---
    await gotoAndSave(page, START_INIT, "frameset_startinit", BASE + "/search/jkknet/service/");

    // このページは「数秒後に自動で次へ」「window.openでJKKnetウィンドウを開く」タイプ。
    // → forwardForm を submit させ、popup(Page) を待つ。
    // まず、popup イベントを待ち受け
    const popupPromise = page.waitForEvent("popup", { timeout: 15000 }).catch(() => null);

    // 中継ページで submit を強制実行
    await page.evaluate(() => {
      // after_relay_1 パターン：submitNext() が用意されている
      if (typeof window.submitNext === "function") {
        window.submitNext();
        return;
      }
      // フォーム直叩きパターン
      const f =
        document.forms.forwardForm ||
        document.querySelector('form[name="forwardForm"]') ||
        document.querySelector("form");
      if (f) {
        if (!f.target) f.target = "JKKnet";
        f.submit();
      }
    });

    // popup を取得（なければ、同タブ遷移の可能性を見る）
    let searchPage = await popupPromise;
    if (!searchPage) {
      // 同タブに wait.jsp → 検索フォームが出てくるかを待つ
      await save(page, "after_relay_1");
      // 検索入力が同タブで現れるか 10 秒待機
      for (let i = 0; i < 20; i++) {
        const found = await findKanaInput(page);
        if (found) {
          searchPage = page;
          break;
        }
        await sleep(500);
      }
    } else {
      await searchPage.setViewport({ width: 1280, height: 1800, deviceScaleFactor: 1 });
      // wait.jsp → 本体へ切り替わるのを待つ（最大 15 秒）
      for (let i = 0; i < 30; i++) {
        const url = searchPage.url();
        if (!/wait\.jsp/.test(url)) {
          // 本体に来たっぽいので break
          break;
        }
        await sleep(500);
      }
    }

    if (!searchPage) {
      await save(page, "final_error");
      throw new Error("検索フォームのウィンドウ(またはタブ)を取得できませんでした。");
    }

    // ここからは検索ページ上で操作
    await save(searchPage, "before_fill");

    // 住宅名(カナ) を探す
    const kanaInput = await findKanaInput(searchPage);
    if (!kanaInput) {
      await save(searchPage, "final_error");
      throw new Error("住宅名(カナ) の入力欄が見つかりませんでした。");
    }

    await kanaInput.click({ clickCount: 3 }).catch(() => {});
    await kanaInput.type("コーシャハイム", { delay: 20 });

    // 「検索」を押下
    const clicked = await clickSearch(searchPage);
    if (!clicked) {
      await save(searchPage, "final_error");
      throw new Error("検索ボタンが見つかりませんでした。");
    }

    // 結果描画待ち（緩め）
    await searchPage.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
    await save(searchPage, "after_submit_main");

    // 最後に現状ページも保存
    await save(searchPage, "final");
  } catch (e) {
    console.error("Error:", e.message || e);
    try {
      await save(page, "final_error");
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
