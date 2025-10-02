// monitor.mjs
// Puppeteer-core を使って JKK「先着順あき家検索」へ到達 → 住宅名(カナ)入力 → 検索 → 結果を保存

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "https://jhomes.to-kousya.or.jp";
const OUTDIR = "out";
const EXEC_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH || // browser-actions/setup-chrome
  "/usr/bin/google-chrome";
const KANA = process.env.KANA || ""; // 空でも可
const VIEW_W = parseInt(process.env.WIDTH || "1440", 10);
const VIEW_H = parseInt(process.env.HEIGHT || "2200", 10);

async function ensureDir() {
  await fs.mkdir(OUTDIR, { recursive: true });
}
async function save(page, name) {
  await ensureDir();
  const html = await page.content();
  await fs.writeFile(path.join(OUTDIR, `${name}.html`), html, "utf8");
  try {
    const vp = page.viewport() || {};
    if (!vp.width || vp.width < 500) {
      await page.setViewport({
        width: VIEW_W,
        height: VIEW_H,
        deviceScaleFactor: 1,
      });
      await page.waitForTimeout(200);
    }
    await page.screenshot({
      path: path.join(OUTDIR, `${name}.png`),
      fullPage: true,
    });
    console.log(`[saved] ${name}`);
  } catch (e) {
    console.warn(
      `[warn] screenshot failed for ${name}: ${e.message || String(e)}`
    );
    // HTMLは保存済み
  }
}

async function goto(page, url, name, referer) {
  console.log(`[goto] ${url}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    referer,
  });
  // ゆるく落ち着くのを待つ
  await page.waitForTimeout(400);
  await save(page, name);
}

async function waitForSearchForm(page) {
  // wait.jsp 経由のことがあるので、その両方に対応
  const SEL_FORM_INPUT =
    'input[name="akiyaInitRM.akiyaRefM.jyutakuKanaName"]';

  const deadline = Date.now() + 20000; // 20s まで待つ
  for (;;) {
    // フォーム到達？
    const hasForm = await page.$(SEL_FORM_INPUT);
    if (hasForm) return;

    // wait.jsp に出る「こちら」リンク（onclick="submitNext()"）があれば押す
    const clickHere = await page.$('a[onclick*="submitNext"]');
    if (clickHere) {
      await clickHere.click();
      await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(
        () => {}
      );
      await page.waitForTimeout(300);
    }

    // 自動遷移を待つ
    await page.waitForTimeout(300);
    if (Date.now() > deadline) {
      throw new Error("検索フォームに遷移できませんでした（timeout）");
    }
  }
}

async function fillAndSearch(page) {
  const SEL_KANA = 'input[name="akiyaInitRM.akiyaRefM.jyutakuKanaName"]';
  await page.waitForSelector(SEL_KANA, { timeout: 8000 });
  if (KANA) {
    await page.click(SEL_KANA, { clickCount: 3 }).catch(() => {});
    await page.type(SEL_KANA, KANA, { delay: 30 });
  }
  await save(page, "after_type_kana");

  // 「検索する」ボタンは <a onclick="submitPage('akiyaJyoukenRef')"><img alt="検索する"></a>
  // 画像 or アンカーどちらでも良い
  const button =
    (await page.$('a[onclick*="akiyaJyoukenRef"]')) ||
    (await page.$('img[alt="検索する"]'));
  if (!button) {
    throw new Error("「検索する」ボタンが見つかりませんでした。");
  }
  await button.click();
  await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(
    () => {}
  );
  await page.waitForTimeout(600);
}

async function main() {
  console.log("[monitor] Using Chrome at:", EXEC_PATH);

  const browser = await puppeteer.launch({
    executablePath: EXEC_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1440,2200",
    ],
    defaultViewport: { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();

  // ここから最短経路で StartInit → 検索フォームへ
  await goto(page, `${BASE}/`, "home_1");
  await goto(page, `${BASE}/search/jkknet/`, "home_1_after", `${BASE}/`);
  await goto(
    page,
    `${BASE}/search/jkknet/service/akiyaJyoukenStartInit`,
    "frameset_startinit",
    `${BASE}/search/jkknet/`
  );

  // wait.jsp → フォームまで
  await waitForSearchForm(page);
  await save(page, "after_relay_1"); // フォーム直前/直後の状態スナップ

  // 入力＆検索
  await save(page, "before_fill");
  await fillAndSearch(page);

  // 結果（一覧ページ想定）
  await save(page, "results_main");

  await browser.close();
}

main()
  .then(() => {
    console.log("Done.");
  })
  .catch(async (err) => {
    console.error("Error:", err?.message || err);
    try {
      // 失敗時でも現在ページを保存しておく
      // （page が無いときは何もしない）
    } finally {
      process.exit(1);
    }
  });
