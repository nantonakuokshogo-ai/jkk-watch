// monitor.js  — Playwright 単体で JKK StartInit → 中継突破 → 一覧へ到達する最小ルート
import { chromium } from "playwright";
// ❶ 先頭の import の下あたりに追加
import fs from "fs/promises";
import path from "path";
const DUMP_DIR = "dump";
async function saveHtml(page, name) {
  try {
    await fs.mkdir(DUMP_DIR, { recursive: true });
    const html = await page.content();
    await fs.writeFile(path.join(DUMP_DIR, `${name}.html`), html, "utf8");
  } catch (e) {
    console.error("[dump] save error:", e);
  }
}

/* ========================  設定  ======================== */
const HOME        = "https://jhomes.to-kousya.or.jp/";
const PORTAL      = "https://jhomes.to-kousya.or.jp/search/jkknet/";
const INDEX       = "https://jhomes.to-kousya.or.jp/search/jkknet/index.html";
const FRAMESET    = "https://jhomes.to-kousya.or.jp/search/jkknet/service/";
const STARTINIT   = "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit";
const LISTURL     = "https://jhomes.to-kousya.or.jp/search/jkknet/service/AKIYAchangeCount";

/* ======================  小物ユーティリティ  ====================== */
async function saveShot(page, name) {
  try { await page.screenshot({ path: name, fullPage: true }); } catch {}
}
async function saveHtml(page, name) {
  try { const html = await page.content(); await Bun.write(name, html); } catch {}
}
async function dumpFrames(page, name = "debug_frames.txt") {
  try {
    const lines = page.frames().map((fr, i) => `[${i}] name=${fr.name() || "(no name)"} url=${fr.url()}`);
    await Bun.write(name, lines.join("\n"));
  } catch {}
}
async function gotoRetry(page, url, opts = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000, ...opts });
      return true;
    } catch {} // retry
  }
  return false;
}
function isApology(titleOrHtml) {
  return /おわび|ページが見つかりません|タイムアウト|その操作は行わないで下さい/.test(titleOrHtml || "");
}
async function recoverApology(page, tag = "recover") {
  const title = await page.title().catch(()=> "");
  const html  = await page.content().catch(()=> "");
  if (!isApology(title) && !isApology(html)) return false;

  console.log(`[${tag}] notfound/apology -> click 「トップページへ戻る」`);
  // 「トップページへ戻る」を押す（どこにあっても拾う）
  for (const ctx of [page, ...page.frames()]) {
    const btn = ctx.getByRole("link", { name: /トップページへ戻る/ });
    if (await btn.count()) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(()=>{}),
        btn.first().click().catch(()=>{})
      ]);
      await page.waitForTimeout(500);
      break;
    }
  }
  return true;
}

/* ==============  中継「こちら」を URL 遷移で確実に踏み抜く  ============== */
async function clickRelaySmart(page) {
  // 中継は何段か連続することがあるので 5 回まで回す
  for (let round = 0; round < 5; round++) {
    let moved = false;

    for (const ctx of [page, ...page.frames()]) {
      // 「こちら」の a 要素を総当り
      const anchors = await ctx.locator("a").all().catch(()=>[]);
      for (const a of anchors) {
        const text = ((await a.textContent()) || "").trim();
        if (!/こちら/.test(text)) continue;

        const href = await a.getAttribute("href");
        if (!href) continue;

        const nextUrl = new URL(href, ctx.url()).toString();
        console.log(`[relay] goto by href -> ${nextUrl}`);

        await page.goto(nextUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
          referer: FRAMESET, // JKK 的に Referer がないと弾かれがち
        }).catch(()=>{});

        await page.waitForTimeout(700);
        moved = true;
        break;
      }
      if (moved) break;
    }
    if (!moved) break; // もう「こちら」が無ければ終わり
  }
}

/* ==============  最終フォールバック：一覧へ直行  ============== */
async function fallbackGotoList(page) {
  const before = page.url();
  await page.goto(LISTURL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
    referer: STARTINIT,
  }).catch(()=>{});
  if (page.url() !== before) {
    console.log("[fallback] moved to list:", page.url());
  } else {
    console.log("[fallback] still same url:", page.url());
  }
}

/* =======================  主要シーケンス  ======================= */
async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
      "Upgrade-Insecure-Requests": "1",
    },
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(120_000);

  try {
    // 0) 入口で何度おわびでも良いので /service/ まで触って Cookie 取得
    for (const url of [HOME, PORTAL, INDEX, FRAMESET]) {
      console.log(`goto try1: ${url}`);
      await gotoRetry(page, url);
      await recoverApology(page, "recover");
      console.log(`[home] URL: ${page.url()}`);
      console.log(`[home] TITLE: ${await page.title()}`);
    }

    // 1) StartInit を Referer 付きで直叩き
    console.log("[frameset] direct goto StartInit with referer=/service/");
    await gotoRetry(page, STARTINIT, { referer: FRAMESET });
    console.log("[frameset] URL:", page.url());
    console.log("[frameset] TITLE:", await page.title());
    await saveShot(page, "step2-frameset.png");
    await dumpFrames(page);

    // 2) 中継「こちら」を確実に踏み抜く
    await clickRelaySmart(page);

    // 3) 念のため Apology を 1 回だけ救済
    await recoverApology(page, "recover2");

    // 4) まだ StartInit っぽいなら最終フォールバックで一覧へ直行
    if (/akiyaJyoukenStartInit/i.test(page.url()) || /JKKねっと$/.test(await page.title())) {
      await fallbackGotoList(page);
    }

    // 5) 現状保存
    console.log("[after-search] URL:", page.url());
    console.log("[after-search] TITLE:", await page.title());
    await saveHtml(page, "after-search.html");
    await saveShot(page, "step3-after-search.png");

    // 6) 最終スクショ（見やすい名前）
    await saveShot(page, "out.png");

  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
