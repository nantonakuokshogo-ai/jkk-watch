import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const OUT_DIR = "out";
const startUrl = "https://jhomes.to-kousya.or.jp/";
const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const kanaWord = process.env.JKK_KANA || "コーシャハイム";

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureOutDir() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function ensureViewport(page) {
  // viewport が 0x0 になることがあるので常に正常値を担保
  const vp = page.viewport();
  if (!vp || !vp.width || !vp.height) {
    await page.setViewport({ width: 1280, height: 2000, deviceScaleFactor: 1 });
  }
  // 念のため上端へ
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function save(page, base) {
  await ensureViewport(page);
  const png = path.join(OUT_DIR, `${base}.png`);
  const html = path.join(OUT_DIR, `${base}.html`);
  try {
    await page.screenshot({ path: png, fullPage: true, captureBeyondViewport: false });
  } catch (e) {
    // 万一失敗したらさらに広いビューポートでリトライ
    await page.setViewport({ width: 1366, height: 2400, deviceScaleFactor: 1 });
    await page.screenshot({ path: png, fullPage: true, captureBeyondViewport: false });
  }
  await fs.writeFile(html, await page.content(), "utf8");
  console.log(`[saved] ${base}`);
}

async function goto(page, url, label) {
  console.log(`[goto] ${url}`);
  await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle0"], timeout: 60000 });
  await page.waitForSelector("body", { timeout: 30000 });
  await ensureViewport(page);
  if (label) await save(page, label);
}

async function tryClickByText(page, text) {
  // 「こちら」「トップページへ戻る」などの救済クリック
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
  await ensureViewport(page);

  // 「住宅名(カナ)」と思しきテキストボックスを総当たりで探索
  const candidates = await page.$x(
    [
      "//input[not(@type='hidden') and (contains(translate(@name,'KANA','kana'),'kana') or contains(translate(@id,'KANA','kana'),'kana'))]",
      "//input[not(@type='hidden') and contains(@placeholder,'カナ')]",
      "//input[not(@type='hidden') and contains(@title,'カナ')]",
      "//input[not(@type='hidden') and contains(@aria-label,'カナ')]",
      // フォールバック（最初のテキストボックス）
      "(//input[not(@type='hidden') and (@type='text' or not(@type))])[1]",
    ].join(" | ")
  );

  const box = candidates[0];
  if (box) {
    await box.click({ clickCount: 3 });
    await box.type(kana, { delay: 20 });
  }

  // 「検索する」ボタンを押下
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
    headless: true, // GitHub Actions では true 固定が安定
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,2400",
      "--lang=ja-JP",
    ],
    defaultViewport: { width: 1280, height: 2000, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();
  await ensureViewport(page);

  try {
    // 1) トップ → JKKネット → インデックス → service
    await goto(page, startUrl, "home_1");
    await save(page, "home_1_after"); // 直後の状態も記録（トラブルシュート用）

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/", "home_2");
    await save(page, "home_2_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/index.html", "home_3");
    await save(page, "home_3_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/service/", "home_4");
    await save(page, "home_4_after");

    // 2) 直接 StartInit （frameset スタート）
    console.log("[frameset] direct goto StartInit with referer=/service/");
    await goto(
      page,
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
      "frameset_startinit"
    );

    // 3) サイト側の「お詫び」「トップへ戻る」ページだったら復旧
    const apology = await page.$x("//*[contains(normalize-space(.),'お詫び') or contains(normalize-space(.),'タイムアウト')]");
    if (apology.length) {
      console.log("[recover] apology -> back to top");
      await tryClickByText(page, "トップページへ戻る");
      await save(page, `home_${ts()}`);
    }

    // 4) 条件入力：住宅名(カナ) に「コーシャハイム」を入れて検索
    await save(page, "after_relay_1"); // 入力前の状態
    await fillKanaAndSearch(page, kanaWord);

    // 5) 結果を保存
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
