// monitor.mjs
// 「住宅名(カナ) = コーシャハイム」で検索→ out/ に HTML と PNG を保存

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT = path.join(__dirname, "out");

const BASE = "https://jhomes.to-kousya.or.jp";
const START_INIT = BASE + "/search/jkknet/service/akiyaJyoukenStartInit";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureOut() {
  await fs.mkdir(OUT, { recursive: true });
}
async function save(page, name) {
  await ensureOut();
  try {
    // viewport が 0 幅問題の保険
    await page.setViewport({ width: 1280, height: 1800, deviceScaleFactor: 1 }).catch(() => {});
  } catch {}
  const html = await page.content().catch(() => "<!---->");
  await fs.writeFile(path.join(OUT, `${name}.html`), html);
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  } catch {}
  console.log(`[saved] ${name}`);
}
async function gotoAndSave(page, url, name, referer) {
  if (referer) {
    await page.setExtraHTTPHeaders({ Referer: referer }).catch(() => {});
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
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--window-size=1280,2000"],
    defaultViewport: { width: 1280, height: 1800, deviceScaleFactor: 1 },
  });
  return browser;
}

// 住宅名(カナ) の入力欄を色々な書き方で探す
async function findKanaInput(page) {
  let h = await page.$('input[name="jyutakuKanaName"]');
  if (h) return h;
  h = await page.$('input#jyutakuKanaName');
  if (h) return h;
  h = await page.$('input[name*="Kana"]');
  if (h) return h;
  const xs = await page.$x(
    "//*[contains(normalize-space(.),'住宅名') and contains(normalize-space(.),'カナ')]/following::input[1]"
  );
  if (xs && xs.length) return xs[0];
  return null;
}

async function clickSearch(page) {
  const tryX = async (xp) => {
    const hit = await page.$x(xp);
    if (hit && hit.length) {
      await hit[0].click();
      return true;
    }
    return false;
  };
  if (
    (await tryX(
      "//input[( @type='submit' or @type='button' or @type='image') and (contains(@value,'検索') or contains(@alt,'検索') or contains(@title,'検索'))]"
    )) ||
    (await tryX("//button[contains(.,'検索')]")) ||
    (await tryX("//a[contains(.,'検索する') or contains(.,'検索')]"))
  ) {
    return true;
  }
  return false;
}

// 新しいウィンドウ/タブ（popup）を「ページ数の増加」で待つ
async function waitForNewPage(browser, prevCount, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const pages = await browser.pages();
    if (pages.length > prevCount) {
      return pages[pages.length - 1];
    }
    await sleep(200);
  }
  return null;
}

async function main() {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1800, deviceScaleFactor: 1 }).catch(() => {});

  try {
    // 参照元を保ちながら順路で到達
    await gotoAndSave(page, BASE + "/", "home_1");
    await gotoAndSave(page, BASE + "/search/jkknet/", "home_1_after", BASE + "/");
    await gotoAndSave(page, BASE + "/search/jkknet/index.html", "home_2", BASE + "/search/jkknet/");
    await gotoAndSave(
      page,
      BASE + "/search/jkknet/service/",
      "home_2_after",
      BASE + "/search/jkknet/index.html"
    );

    // StartInit（中継）
    await gotoAndSave(page, START_INIT, "frameset_startinit", BASE + "/search/jkknet/service/");

    // popup を待つ（レガシー互換）
    const beforePages = await browser.pages();

    // 中継ページで submit を強制
    await page.evaluate(() => {
      if (typeof window.submitNext === "function") {
        window.submitNext();
        return;
      }
      const f =
        (document.forms && (document.forms.forwardForm || document.forms[0])) ||
        document.querySelector('form[name="forwardForm"]') ||
        document.querySelector("form");
      if (f) {
        if (!f.target) f.target = "JKKnet";
        f.submit();
      }
    });

    // 新しいページが開くか待つ（なければ同タブ継続）
    let searchPage = await waitForNewPage(browser, beforePages.length, 15000);
    if (!searchPage) {
      // 同タブ遷移
      await save(page, "after_relay_1");
      // wait.jsp → 本体へ移るまで少し待つ
      for (let i = 0; i < 30; i++) {
        const url = page.url();
        if (!/wait\.jsp/.test(url)) break;
        await sleep(500);
      }
      searchPage = page;
    } else {
      await searchPage.setViewport({ width: 1280, height: 1800, deviceScaleFactor: 1 }).catch(
        () => {}
      );
      await save(searchPage, "after_relay_1");
      // wait.jsp の間は少し待つ
      for (let i = 0; i < 30; i++) {
        const url = searchPage.url();
        if (!/wait\.jsp/.test(url)) break;
        await sleep(500);
      }
    }

    await save(searchPage, "before_fill");

    // 住宅名(カナ) を入力
    const kana = await findKanaInput(searchPage);
    if (!kana) {
      await save(searchPage, "final_error");
      throw new Error("住宅名(カナ) の入力欄が見つかりませんでした。");
    }
    try {
      await kana.click({ clickCount: 3 });
    } catch {}
    await kana.type("コーシャハイム", { delay: 20 });

    // 検索クリック
    const ok = await clickSearch(searchPage);
    if (!ok) {
      await save(searchPage, "final_error");
      throw new Error("検索ボタンが見つかりませんでした。");
    }

    // 軽く待って保存（レガシー互換でポーリング）
    for (let i = 0; i < 20; i++) {
      await sleep(500);
    }
    await save(searchPage, "after_submit_main");
    await save(searchPage, "final");
  } catch (e) {
    console.error("Error:", e && e.message ? e.message : e);
    try {
      await save(page, "final_error");
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
