import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const OUT_DIR = "out";
const startUrl = "https://jhomes.to-kousya.or.jp/";
const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const kanaWord  = process.env.JKK_KANA || "コーシャハイム";

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureOutDir() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function waitForNonZeroViewport(page, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const size = await page.evaluate(() => ({
      w: window.innerWidth || 0,
      h: window.innerHeight || 0,
      dw: document.documentElement.clientWidth || 0,
      dh: document.documentElement.clientHeight || 0,
    }));
    if (Math.max(size.w, size.dw) > 0 && Math.max(size.h, size.dh) > 0) return;
    // ビューポートを揺らしてレイアウトを安定化
    try {
      await page.setViewport({ width: 1279, height: 1999, deviceScaleFactor: 1 });
      await page.setViewport({ width: 1280, height: 2000, deviceScaleFactor: 1 });
    } catch {}
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
  }
  // ここまで来ても 0 の場合は以降の save() 内でフォールバック撮影に任せる
}

async function save(page, base) {
  const png = path.join(OUT_DIR, `${base}.png`);
  const html = path.join(OUT_DIR, `${base}.html`);

  // HTML は必ず保存（デバッグ用に重要）
  try {
    await fs.writeFile(html, await page.content(), "utf8");
  } catch (e) {
    console.warn(`[warn] write html failed for ${base}: ${e.message}`);
  }

  // スクショは落とさない。順に 3 段階で試す
  try {
    await waitForNonZeroViewport(page);
    await page.bringToFront().catch(() => {});
    await page.screenshot({
      path: png,
      fullPage: true,
      captureBeyondViewport: false,
    });
  } catch (e1) {
    console.warn(`[warn] screenshot 1st failed (${e1.message}); retry with fixed viewport`);
    try {
      await page.setViewport({ width: 1280, height: 2000, deviceScaleFactor: 1 });
      await page.waitForTimeout(200);
      await page.screenshot({
        path: png,
        fullPage: true,
        captureBeyondViewport: false,
      });
    } catch (e2) {
      console.warn(`[warn] screenshot 2nd failed (${e2.message}); retry with clip`);
      try {
        // 最後の手段：固定クリップで撮る（0幅でも撮影できるケースがある）
        await page.screenshot({
          path: png,
          clip: { x: 0, y: 0, width: 1280, height: 2000 },
          captureBeyondViewport: true,
        });
      } catch (e3) {
        console.warn(`[warn] screenshot 3rd failed (${e3.message}); giving up for ${base}`);
      }
    }
  }
  console.log(`[saved] ${base}`);
}

async function goto(page, url, label) {
  console.log(`[goto] ${url}`);
  await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle0"], timeout: 60000 });
  await page.waitForSelector("body", { timeout: 30000 });
  await waitForNonZeroViewport(page);
  if (label) await save(page, label);
}

async function tryClickByText(page, text) {
  const xpath = `//*[self::a or self::button][contains(normalize-space(.), "${text}")]`;
  const [el] = await page.$x(xpath);
  if (el) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: ["domcontentloaded", "networkidle0"], timeout: 60000 }).catch(() => {}),
      el.click(),
    ]);
    return true;
  }
  return false;
}

async function fillKanaAndSearch(page, kana) {
  await waitForNonZeroViewport(page);
  const [box] = await page.$x(
    [
      "//input[not(@type='hidden') and (contains(translate(@name,'KANA','kana'),'kana') or contains(translate(@id,'KANA','kana'),'kana'))]",
      "//input[not(@type='hidden') and contains(@placeholder,'カナ')]",
      "//input[not(@type='hidden') and contains(@title,'カナ')]",
      "//input[not(@type='hidden') and contains(@aria-label,'カナ')]",
      "(//input[not(@type='hidden') and (@type='text' or not(@type))])[1]",
    ].join(" | ")
  );

  if (box) {
    await box.click({ clickCount: 3 });
    await box.type(kana, { delay: 15 });
  }

  const [btn] = await page.$x(
    "//button[contains(normalize-space(.),'検索する')] | //input[@type='submit' and contains(@value,'検索')]"
  );
  if (btn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: ["domcontentloaded", "networkidle0"], timeout: 60000 }),
      btn.click(),
    ]);
  }
}

async function main() {
  await ensureOutDir();

  console.log(`[monitor] Using Chrome at: ${chromePath}`);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    // window-size で実ウィンドウを作り、defaultViewport は null（競合回避）
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,2400",
      "--lang=ja-JP",
      "--force-device-scale-factor=1",
    ],
  });

  const page = await browser.newPage();

  try {
    // 1) トップ → JKKネット → インデックス → service
    await goto(page, startUrl, "home_1");
    await save(page, "home_1_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/", "home_2");
    await save(page, "home_2_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/index.html", "home_3");
    await save(page, "home_3_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/service/", "home_4");
    await save(page, "home_4_after");

    // 2) StartInit（frameset スタート）
    console.log("[frameset] direct goto StartInit with referer=/service/");
    await goto(
      page,
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
      "frameset_startinit"
    );

    // 3) タイムアウト/お詫びページから復帰
    const apology = await page.$x(
      "//*[contains(normalize-space(.),'お詫び') or contains(normalize-space(.),'タイムアウト')]"
    );
    if (apology.length) {
      console.log("[recover] apology -> back to top");
      await tryClickByText(page, "トップページへ戻る");
      await save(page, `home_${ts()}`);
    }

    // 4) 住宅名(カナ) に「コーシャハイム」を入力して検索
    await save(page, "after_relay_1"); // 入力前の状態
    await fillKanaAndSearch(page, kanaWord);

    // 5) 結果保存
    await save(page, "after_submit_main");
    await save(page, "final");
  } catch (e) {
    console.error(e);
    await save(page, "final_error");
    throw e;
  } finally {
    await browser.close();
  }
}

main().catch(() => process.exit(1));
