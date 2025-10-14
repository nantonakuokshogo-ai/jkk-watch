// monitor.mjs
import fs from "fs/promises";
import { chromium } from "playwright";

const OUT = (name) => ({
  html: `artifacts/${name}.html`,
  png:  `artifacts/${name}.png`,
});

/** HTML+スクショを保存（失敗しても落ちない） */
async function save(page, name) {
  try {
    const html = await page.content(); // ← Promiseをawait（以前のERR_INVALID_ARG_TYPE対策）
    await fs.writeFile(OUT(name).html, html);
  } catch (e) {
    console.warn(`[warn] save html(${name})`, e?.message);
  }
  try {
    await page.screenshot({ path: OUT(name).png, fullPage: true });
  } catch (e) {
    console.warn(`[warn] save png(${name})`, e?.message);
  }
}

/** 軽い待ち */
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/** ランディングへ（to-kousya 優先） */
async function gotoLanding(ctx) {
  console.log("[step] goto landing (prefer to-kousya)");
  const page = await ctx.newPage();

  // 1st: to-kousya
  await page.goto("https://www.to-kousya.or.jp/chintai/index.html", {
    waitUntil: "domcontentloaded",
  }).catch(() => {});

  // 万一失敗時のリトライ（DNSや一時エラー対策）
  if (!/to-kousya\.or\.jp/.test(page.url())) {
    const candidates = [
      "https://www.to-kousya.or.jp/jkk/",
      "https://www.to-kousya.or.jp/",
    ];
    for (const url of candidates) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        if (page.url().startsWith("https://www.to-kousya.or.jp")) break;
      } catch {}
    }
  }

  // Cookie等のバナーを適当に閉じる（あれば）
  try {
    const close = page.getByRole("button", { name: /閉じる|OK|同意/i });
    await close.first().click({ timeout: 1500 });
  } catch {}
  await save(page, "landing");
  return page;
}

/** 「こだわり条件」を開く → ポップアップ（or 同タブ遷移）をハンドリング */
async function clickConditions(page, ctx) {
  console.log("[step] open conditions (こだわり条件)");

  // 候補セレクタ（順に試す）
  const candidates = [
    page.getByRole("link", { name: /こだわり条件/ }),
    page.locator('a:has-text("こだわり条件")'),
    page.locator('button:has-text("こだわり条件")'),
    page.locator('a[href*="jkknet"]'),
  ];

  let clicked = false;
  for (const loc of candidates) {
    try {
      if ((await loc.count()) > 0) {
        await loc.first().scrollIntoViewIfNeeded();
        const popupWait = ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null);
        await loc.first().click({ timeout: 3000 });
        // 新規ページ（ポップアップ）を優先取得
        const pop = await popupWait;
        if (pop) return pop;
        clicked = true;
        break; // 同タブ遷移っぽい
      }
    } catch {}
  }
  if (!clicked) throw new Error("こだわり条件のリンクが見つかりませんでした");

  // 同タブで「待機ページ」に行くケース
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  return page;
}

/** 「待機ページ」→ 自動遷移 or 「こちら」クリック → JKKnet条件ページ */
async function followWaitingAndGetJkkPage(ctx) {
  // 直近で開いているページ達を確認
  let target = ctx.pages().slice(-1)[0];

  // 「こちら」リンクがある場合はクリック（自動window.openが効かない環境対策）
  try {
    if (/\/search\/jkknet\/wait\.jsp/.test(target.url())) {
      await save(target, "entry_referer"); // 参考用
      const here = target.getByRole("link", { name: "こちら" });
      if ((await here.count()) > 0) {
        const popupWait = ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null);
        await here.first().click();
        const pop = await popupWait;
        if (pop) target = pop;
      }
    }
  } catch {}

  // 条件トップ（先着順あき家検索）が開くまで待機（別ウィンドウ or 同タブ）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pages = ctx.pages();
    const hit = pages.find((p) =>
      /akiyaJyoukenStartInit|akiyaJyouken/.test(p.url())
    );
    if (hit) {
      await hit.bringToFront().catch(() => {});
      await hit.waitForLoadState("domcontentloaded").catch(() => {});
      await save(hit, "popup_top");
      return hit;
    }
    await nap(300);
  }
  // どれにも当たらなければ最後のページを返す（フォールバック）
  const fallback = ctx.pages().slice(-1)[0];
  await save(fallback, "last_page_fallback");
  return fallback;
}

/** 「住宅名（カナ）」に入力 → 検索 */
async function fillAndSearch(jkkPage) {
  console.log("[step] fill conditions");

  // 入力欄の探索（表組みでも拾えるように多段フォールバック）
  async function findKanaInput(p) {
    const tryLocs = [
      p.getByLabel(/住宅名.*カナ/),
      p.locator('input[placeholder*="カナ"]'),
      p.locator('input[name*="Kana" i]'),
      // 「住宅名（カナ）」のセルの次の input を拾う
      p.locator('xpath=//td[contains(normalize-space(),"住宅名") and contains(.,"カナ")]/following::input[1]'),
    ];
    for (const loc of tryLocs) {
      try {
        if ((await loc.count()) > 0) return loc.first();
      } catch {}
    }
    // frame 内も探索
    for (const f of p.frames()) {
      for (const loc of [
        f.getByLabel(/住宅名.*カナ/),
        f.locator('input[placeholder*="カナ"]'),
        f.locator('input[name*="Kana" i]'),
        f.locator('xpath=//td[contains(normalize-space(),"住宅名") and contains(.,"カナ")]/following::input[1]'),
      ]) {
        try {
          if ((await loc.count()) > 0) return loc.first();
        } catch {}
      }
    }
    return null;
  }

  const kana = await findKanaInput(jkkPage);
  if (kana) {
    await kana.fill("コーシャハイム", { timeout: 4000 }).catch(() => {});
  } else {
    console.warn("[warn] 住宅名（カナ）欄が見つかりませんでした（入力スキップ）");
  }

  // 検索ボタン
  async function findSearchButton(p) {
    const locs = [
      p.getByRole("button", { name: /検索する|検索/ }),
      p.locator('input[type="submit"][value*="検索"]'),
      p.locator('button:has-text("検索")'),
    ];
    for (const loc of locs) {
      if ((await loc.count()) > 0) return loc.first();
    }
    for (const f of p.frames()) {
      for (const loc of [
        f.getByRole("button", { name: /検索する|検索/ }),
        f.locator('input[type="submit"][value*="検索"]'),
        f.locator('button:has-text("検索")'),
      ]) {
        if ((await loc.count()) > 0) return loc.first();
      }
    }
    return null;
  }

  const searchBtn = await findSearchButton(jkkPage);
  if (searchBtn) {
    await searchBtn.scrollIntoViewIfNeeded().catch(() => {});
    await searchBtn.click({ timeout: 4000 }).catch(() => {});
  } else {
    console.warn("[warn] 検索ボタンが見つかりません（このまま保存へ）");
  }

  // 検索結果（物件一覧）を保存（同タブ遷移/フレーム遷移どちらでも）
  try {
    await jkkPage.waitForLoadState("domcontentloaded", { timeout: 8000 });
  } catch {}
  await save(jkkPage, "result_list");
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });

  try {
    const landing = await gotoLanding(ctx);
    const maybePopup = await clickConditions(landing, ctx);
    const jkk = await followWaitingAndGetJkkPage(ctx);
    await fillAndSearch(jkk);
  } catch (e) {
    console.error("[fatal]", e);
  } finally {
    await browser.close();
  }
}

main();
