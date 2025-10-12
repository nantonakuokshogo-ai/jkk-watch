// monitor.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const SEARCH_KANA = process.env.JKK_SEARCH_KANA || "コーシャハイム";
const OUT = process.env.OUT_DIR || "artifacts";

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}
async function dump(page, basename) {
  await ensureDir(OUT);
  const html = await page.content();
  await fs.writeFile(path.join(OUT, `${basename}.html`), html, "utf8");
  await page.screenshot({ path: path.join(OUT, `${basename}.png`), fullPage: true });
}

function nowIso() {
  return new Date().toISOString().replace(/[:]/g, "-");
}

async function findJyoukenPage(context) {
  // 既存のページに対象がいないか先に確認
  for (const p of context.pages()) {
    const u = p.url();
    if (/akiyaJyoukenStartInit/.test(u)) return p;
  }
  // 新規遷移またはポップアップ待機
  const p = await Promise.race([
    context.waitForEvent("page", { timeout: 20000 }).then(async pg => {
      try { await pg.waitForURL(/akiyaJyoukenStartInit/, { timeout: 20000 }); } catch {}
      return pg;
    }),
    context.waitForEvent("requestfinished", { timeout: 20000 }).then(() => {
      return context.pages().find(pg => /akiyaJyoukenStartInit/.test(pg.url()));
    })
  ]);
  return p;
}

async function run() {
  await ensureDir(OUT);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36"
  });

  const trace = {
    top_open: "https://www.to-kousya.or.jp/chintai/index.html",
    start: { top: "", at: nowIso() },
    kana_input: { requested: SEARCH_KANA, ok: false, value: "", used: "akiyaInitRM.akiyaRefM.jyutakuKanaName" },
    result: { url: "", title: "", detailsCount: 0, rows: 0, querySeen: false }
  };

  const top = await context.newPage();
  await top.goto("https://www.to-kousya.or.jp/chintai/index.html", { waitUntil: "domcontentloaded" });
  trace.start.top = top.url();
  await dump(top, "landing");

  // 「お部屋を検索」 => 新しいウィンドウ（JKKnet）
  const popupPromise = top.waitForEvent("popup", { timeout: 15000 }).catch(() => null);

  // PC 版の検索ボタン（ヘッダー＆ハンバーガーの両方にある）
  const searchLink = top.locator('a[href*="akiyaJyoukenInit"], a[href*="akiyaJyoukenStartInit"]').first();
  await searchLink.click().catch(() => {}); // クリックできないときもあるので無害に

  const interstitial = (await popupPromise) || top; // うまく取れないときは同タブ遷移
  // 自動遷移ページ（entry_referer）を保存（来ていれば）
  if (interstitial && interstitial !== top) {
    await interstitial.waitForLoadState("domcontentloaded").catch(() => {});
    await dump(interstitial, "entry_referer");
  }

  // 条件入力ページを取得
  const jyouken = await findJyoukenPage(context);
  if (!jyouken) throw new Error("条件入力ページを取得できませんでした。");
  await jyouken.waitForLoadState("domcontentloaded");
  await dump(jyouken, "popup_top"); // タブ見出しの保存
  await dump(jyouken, "popup_jyouken");

  // 住宅名（カナ）に「コーシャハイム」
  const kanaSel = 'input[name="akiyaInitRM.akiyaRefM.jyutakuKanaName"]';
  const kana = jyouken.locator(kanaSel);
  await kana.waitFor({ state: "visible", timeout: 10000 });
  await kana.fill(""); // 一度クリア
  await kana.type(SEARCH_KANA, { delay: 20 });
  trace.kana_input.ok = true;
  trace.kana_input.value = SEARCH_KANA;

  await dump(jyouken, "jyouken_filled");

  // 検索実行（画像ボタン or JS 関数両対応）
  const imgBtn = jyouken.locator('input[type="image"][src*="bt_kensaku"]');
  if (await imgBtn.count()) {
    await Promise.all([
      jyouken.waitForLoadState("domcontentloaded"),
      imgBtn.first().click()
    ]);
  } else {
    await Promise.all([
      jyouken.waitForLoadState("domcontentloaded"),
      jyouken.evaluate(() => (window.submitPage ? submitPage("akiyaJyoukenResult") : document.forms[0]?.submit()))
    ]);
  }

  // 結果ページ
  await jyouken.waitForLoadState("domcontentloaded");
  trace.result.url = jyouken.url();
  trace.result.title = await jyouken.title();

  // 行数と「詳細」相当のボタン数を推定
  const rows = await jyouken.locator("table tr").count().catch(() => 0);
  const details = await jyouken.locator('input[type="image"][src*="bt_shousai"], a:has-text("詳細")').count().catch(() => 0);
  trace.result.rows = rows;
  trace.result.detailsCount = details;

  await dump(jyouken, "result_list");

  await fs.writeFile(path.join(OUT, "trace.json"), JSON.stringify(trace, null, 2), "utf8");

  await browser.close();
}

run().catch(async (e) => {
  await ensureDir(OUT);
  await fs.writeFile(path.join(OUT, "final_error.txt"), String(e?.stack || e), "utf8");
  process.exitCode = 1;
});
