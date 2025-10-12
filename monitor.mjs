// monitor.mjs (v13)
// ねらい：必ず終了する・どこで止まったか trace.zip で辿れる
// - グローバル watchdog（9分）
// - クリック→遷移は Promise.all で同時待機
// - ポップアップ失敗時は Referer 付きで条件ページに直行
// - 住宅名（カナ）へ「コーシャハイム」→検索→一覧撮影
// - Playwright Tracing を artifacts/trace.zip に保存

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const OUT = process.env.OUT_DIR || "artifacts";
const KANA = (process.env.JKK_SEARCH_KANA || "コーシャハイム").trim();

const TOPS = [
  "https://www.to-kousya.or.jp/chintai/index.html",
  "https://www.jkk-tokyo.or.jp/",
];
const STARTS = [
  "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaStartInit",
  "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyachizuStartInit",
  "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
];

const KANA_SEL = 'input[name="akiyaInitRM.akiyaRefM.jyutakuKanaName"]';

const TRACE = {
  startedAt: new Date().toISOString(),
  kana_input: { requested: KANA, ok: false, value: "", used: KANA_SEL },
  result: { url: "", title: "", rows: 0, detailsCount: 0, querySeen: false },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }
async function dump(page, name, full = true) {
  await ensureDir(OUT);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
  await fs.writeFile(path.join(OUT, `${name}.html`), await page.content(), "utf8");
}
function now() { return new Date().toISOString().replace(/[:]/g, "-"); }

async function run() {
  await ensureDir(OUT);

  // --- Watchdog: 9分で強制終了（ジョブ全体は 30 分でも、スクリプトは必ず切る）
  const watchdog = setTimeout(async () => {
    await fs.writeFile(path.join(OUT, "final_error.txt"), "Watchdog timeout", "utf8");
    process.exit(0);
  }, 9 * 60 * 1000);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
    extraHTTPHeaders: { Referer: TOPS[0] }, // 直行時のガード
  });
  context.setDefaultTimeout(15000);

  // Playwright trace
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();
  page.on("console", (m) => console.log("[page]", m.type(), m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  // 1) トップへ
  for (const u of TOPS) {
    try {
      await page.goto(u, { waitUntil: "domcontentloaded" });
      break;
    } catch {}
  }
  await dump(page, `landing_${now()}`);

  // 2) JKKねっと（条件ページ）へ：ポップアップ経由 → 失敗時は直行
  let jyouken = null;
  try {
    const popupPromise = page.waitForEvent("popup", { timeout: 8000 });
    // ページ上の「お部屋を検索」など、JKKねっとへの導線を雑にクリック
    await Promise.any([
      page.locator('a[href*="akiyaJyoukenStartInit"]').first().click({ timeout: 3000 }),
      page.locator('a[href*="akiyaJyoukenInit"]').first().click({ timeout: 3000 }),
      page.locator('a:has-text("JKKねっと")').first().click({ timeout: 3000 }),
    ]).catch(() => {});
    const pop = await popupPromise.catch(() => null);
    if (pop) {
      jyouken = pop;
      await jyouken.waitForLoadState("domcontentloaded").catch(() => {});
      await dump(jyouken, "entry_referer");
    }
  } catch {}

  // 直行（Referer 付き）フォールバック
  if (!jyouken) {
    for (const s of STARTS) {
      try {
        await page.goto(s, { waitUntil: "domcontentloaded" });
        jyouken = page;
        break;
      } catch {}
    }
  }
  if (!jyouken) throw new Error("条件入力ページに到達できませんでした。");

  await dump(jyouken, "popup_top");
  await dump(jyouken, "popup_jyouken");

  // 3) 住宅名（カナ）入力
  const kana = jyouken.locator(KANA_SEL);
  await kana.waitFor({ state: "visible" });
  await kana.fill("");
  await kana.type(KANA, { delay: 15 });
  await jyouken.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) { el.style.outline = "3px solid #ff0033"; el.style.outlineOffset = "2px"; }
  }, KANA_SEL);
  TRACE.kana_input.ok = true;
  TRACE.kana_input.value = KANA;
  await dump(jyouken, "jyouken_filled");

  // 4) 検索実行：画像ボタン or submitAction → 最後は form.submit
  const clickSearch = async () => {
    const imgBtn = jyouken.locator('input[type="image"][src*="bt_kensaku"]');
    if (await imgBtn.count()) { await imgBtn.first().click(); return true; }
    const tried = await jyouken.evaluate(() => {
      if (typeof window.submitAction === "function") { window.submitAction("akiyaJyoukenRef"); return true; }
      if (typeof window.submitPage === "function") { window.submitPage("akiyaJyoukenResult"); return true; }
      const f = document.forms[0]; if (f) { f.submit(); return true; }
      return false;
    });
    return tried;
  };

  await Promise.race([
    (async () => {
      await Promise.allSettled([
        jyouken.waitForNavigation({ waitUntil: "domcontentloaded" }),
        clickSearch()
      ]);
    })(),
    (async () => { await sleep(8000); })() // 8秒で切り上げ（次に直で結果判定）
  ]);

  // 5) 結果ページの要約＋保存
  await jyouken.waitForLoadState("domcontentloaded").catch(() => {});
  TRACE.result.url = jyouken.url();
  try { TRACE.result.title = await jyouken.title(); } catch {}

  const rows = await jyouken.locator("table tr").count().catch(() => 0);
  const details = await jyouken.locator('input[type="image"][src*="bt_shousai"], a:has-text("詳細")').count().catch(() => 0);
  const bodyText = await jyouken.evaluate(() => document.body?.innerText || "").catch(() => "");
  TRACE.result.rows = rows;
  TRACE.result.detailsCount = details;
  TRACE.result.querySeen = bodyText.includes(KANA);

  await dump(jyouken, "result_list");
  await fs.writeFile(path.join(OUT, "trace.json"), JSON.stringify(TRACE, null, 2), "utf8");

  // trace.zip
  await context.tracing.stop({ path: path.join(OUT, "trace.zip") });

  clearTimeout(watchdog);
  await browser.close();
}

run().catch(async (e) => {
  try {
    await ensureDir(OUT);
    await fs.writeFile(path.join(OUT, "final_error.txt"), String(e?.stack || e), "utf8");
  } finally {
    process.exit(1);
  }
});
