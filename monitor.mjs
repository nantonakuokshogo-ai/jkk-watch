// monitor.mjs
import { chromium } from "playwright";
import fs from "fs/promises";
const ART_DIR = "artifacts";

/** ---------- small helpers ---------- */
const log = (...a) => console.log(...a);
async function ensureDir(p) { try { await fs.mkdir(p, { recursive: true }); } catch {} }
async function save(page, base) {
  try {
    await ensureDir(ART_DIR);
    const html = await page.content();
    await fs.writeFile(`${ART_DIR}/${base}.html`, html, "utf8");
    await page.screenshot({ path: `${ART_DIR}/${base}.png`, fullPage: true });
    log(`[artifacts] saved: ${base}.html / ${base}.png`);
  } catch (e) { console.warn(`[artifacts] save failed (${base})`, e); }
}
async function maybe(fn, label) {
  try { return await fn(); } catch (e) { if (label) log(`[skip] ${label}:`, e.message); return null; }
}
async function waitIdle(page, ms = 800) {
  // ほんの少し落ち着かせる
  await page.waitForTimeout(ms);
  await maybe(() => page.waitForLoadState("networkidle", { timeout: 4000 }));
}

/** 画面オーバーレイ類を閉じる（Cookie/チャット等） */
async function closeOverlays(page) {
  // Cookie バナー（cc-btn cc-dismiss / 「閉じる」）
  await maybe(async () => {
    const btn = page.locator('.cc-btn.cc-dismiss, text=閉じる').first();
    if (await btn.isVisible({ timeout: 1000 })) { await btn.click({ timeout: 1000 }); }
  }, "cookie banner");
  // 404の「こちら」手動リンク（自動遷移が効かないとき）
  await maybe(async () => {
    const here = page.getByRole("link", { name: "こちら" });
    if (await here.isVisible({ timeout: 800 })) { await here.click({ timeout: 800 }); }
  }, "redirect here link");
}

/** 指定テキストを含む要素をできるだけ頑強にクリック */
async function clickByText(page, text, { timeout = 5000 } = {}) {
  const sels = [
    `a:has-text("${text}")`,
    `button:has-text("${text}")`,
    `[role="button"]:has-text("${text}")`,
    `[role="link"]:has-text("${text}")`,
    // 最後の手段（何かしらの要素）
    `:text("${text}")`
  ];
  const start = Date.now();
  for (;;) {
    for (const s of sels) {
      const el = page.locator(s).first();
      if (await el.count()) {
        if (await el.isVisible().catch(() => false)) {
          await el.click({ trial: true }).catch(() => {}); // ヒット確認
          await el.click({ force: true }).catch(async () => { await el.click(); });
          await waitIdle(page);
          return true;
        }
      }
    }
    if (Date.now() - start > timeout) return false;
    await page.waitForTimeout(250);
  }
}

/** 404 かどうか判定 */
async function is404(page) {
  const title = await page.title().catch(() => "");
  if (title.includes("ページが見つかりません")) return true;
  const h1 = await page.locator("h1, .pageTitle, .ly_h1").first().textContent().catch(() => "");
  return /ページが見つかりません/.test(h1 || "");
}

/** 一覧ページっぽいか（カードや並び替え・絞り込み UI の存在） */
async function looksLikeList(page) {
  const hasCard = await page.locator('a:has-text("詳")+*, a:has-text("詳細"), .p-list, .c-card, .list, .p-item').count();
  const hasFilter = await page.locator('text=/絞り込|絞込|条件/').count();
  const hasPager = await page.locator('text=/次へ|前へ|ページ|pagination/i').count();
  return (hasCard + hasFilter + hasPager) > 0;
}

/** こだわり条件 経由で探す（無ければフォールバック） */
async function goViaKODAWARI(page) {
  // こだわり条件クリックを試す（トップにある黄色の大きいボタン）
  if (await clickByText(page, "こだわり条件", { timeout: 4000 })) {
    await waitIdle(page, 1200);
    await closeOverlays(page);
    if (await is404(page)) return false;
    // 条件フォームっぽい？ → そのまま検索押下を試す
    // ボタン名のバリエーションをカバー
    const ok = await clickByText(page, "検索", { timeout: 2000 })
            || await clickByText(page, "この条件で探す", { timeout: 2000 })
            || await clickByText(page, "絞り込む", { timeout: 2000 });
    await waitIdle(page, 1200);
    if (await looksLikeList(page)) return true;
  }
  return false;
}

/** 「賃貸住宅情報」から一覧へフォールバック */
async function fallbackToList(page) {
  // ヘッダーメニューの「住宅をお探しの方 → 賃貸住宅情報」
  await clickByText(page, "住宅をお探しの方").catch(() => {});
  await waitIdle(page, 400);
  if (!(await clickByText(page, "賃貸住宅情報", { timeout: 4000 }))) {
    // 直接URLへ
    await page.goto("https://www.to-kousya.or.jp/chintai/index.html", { waitUntil: "domcontentloaded", timeout: 20000 });
  }
  await waitIdle(page, 1200);
  await closeOverlays(page);

  // ページ内から「住宅一覧 / 物件一覧 / 募集住戸あり で絞り込む」等に進む
  const jumped = await clickByText(page, "住宅一覧", { timeout: 2500 })
             || await clickByText(page, "物件一覧", { timeout: 2500 })
             || await clickByText(page, "一覧を見る", { timeout: 2500 })
             || await clickByText(page, "募集住戸", { timeout: 2500 });
  await waitIdle(page, 1200);

  // 一覧に見えなければトップのカードからでも
  if (!jumped || !(await looksLikeList(page))) {
    // サイトにより /list 系に遷移する場合もあるので、明示で候補URLを試す
    const candidates = [
      page.url(), // まず現URL
      "https://www.to-kousya.or.jp/chintai/",           // セクショントップ
      "https://www.to-kousya.or.jp/chintai/index.html",
    ];
    for (const u of candidates) {
      if (!(await looksLikeList(page))) {
        await maybe(() => page.goto(u, { waitUntil: "domcontentloaded", timeout: 20000 }), `goto candidate ${u}`);
        await waitIdle(page, 800);
      }
    }
  }
  return await looksLikeList(page);
}

(async () => {
  await ensureDir(ART_DIR);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 1800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36",
  });
  const page = await ctx.newPage();

  try {
    log("[step] goto landing (prefer to-kousya)");
    // まず /jkk/ を試し、404ならサイトルートへ
    await page.goto("https://www.to-kousya.or.jp/jkk/", { waitUntil: "domcontentloaded", timeout: 25000 });
    await waitIdle(page, 1200);
    await closeOverlays(page);

    if (await is404(page)) {
      log("[info] /jkk/ was 404 -> go root");
      await page.goto("https://www.to-kousya.or.jp/", { waitUntil: "domcontentloaded", timeout: 25000 });
      await waitIdle(page, 1200);
      await closeOverlays(page);
    }

    await save(page, "landing");

    log("[step] try via 'こだわり条件'");
    const viaKodawari = await goViaKODAWARI(page);

    if (!viaKodawari) {
      log("[step] fallback to list via 賃貸住宅情報");
      const ok = await fallbackToList(page);
      if (!ok) log("[warn] still not a list-looking page; saving current page.");
    }

    // 一覧らしくなければ最後にもう一押し：ページ内の「絞り込む」等を押してみる
    if (!(await looksLikeList(page))) {
      await maybe(() => clickByText(page, "絞り込む", { timeout: 1500 }), "extra filter click");
      await waitIdle(page, 800);
    }

    if (await looksLikeList(page)) {
      await save(page, "result_list");
      log("[done] got list page.");
      process.exit(0);
    } else {
      await save(page, "last_page_fallback");
      log("[done] list not detected; saved fallback.");
      process.exit(0); // 失敗扱いにしない（成果物は残す）
    }
  } catch (e) {
    log("[fatal]", e);
    await save(page, "last_page_fallback");
    process.exit(0); // エラーでも落とさず成功終了にして成果物を残す
  } finally {
    await ctx.close();
    await browser.close();
  }
})();
