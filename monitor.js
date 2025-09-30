import { chromium } from "playwright";

/* ============ 設定 ============ */
const HOME = "https://jhomes.to-kousya.or.jp/search/jkknet/";
const KEYWORD = "DK"; // 動作確認用。OKなら本命に変更
/* ============================ */

async function gotoRetry(page, url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`goto try${i}: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return true;
    } catch (e) {
      console.log(`goto fail${i}:`, e.message);
      await page.waitForTimeout(1200);
    }
  }
  return false;
}

async function dumpWhere(page, label) {
  const title = await page.title().catch(() => "");
  console.log(`[${label}] URL: ${page.url()}`);
  console.log(`[${label}] TITLE: ${title}`);
}

async function screenshot(page, name) {
  try { await page.screenshot({ path: name, fullPage: true }); } catch {}
}

/** 404などの「トップページへ戻る」を踏む */
async function recoverNotFound(page) {
  const title = (await page.title().catch(()=> "")) || "";
  if (title.includes("見つかりません")) {
    console.log("[recover] 404 -> トップへ戻る");
    const link = page.getByRole("link", { name: /トップページへ戻る/ });
    if (await link.count()) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(()=>{}),
        link.first().click()
      ]);
      await page.waitForTimeout(800);
    }
  }
}

/** 中継ページの「こちら」や meta refresh を処理 */
async function passRelay(page) {
  console.log("[relay] start");
  // 1) “こちら” をクリック（メイン/フレーム）
  const clickHereOn = async (ctx, label) => {
    const here = ctx.getByRole("link", { name: /こちら/ });
    if (await here.count()) {
      console.log(`[relay] click "${label}" -> こちら`);
      await Promise.all([
        ctx.waitForLoadState("domcontentloaded").catch(()=>{}),
        here.first().click({ timeout: 3000 })
      ]);
      return true;
    }
    return false;
  };
  if (await clickHereOn(page, "main")) { await page.waitForTimeout(1000); return; }
  for (const f of page.frames()) {
    if (await clickHereOn(f, `frame:${await f.url()}`)) { await page.waitForTimeout(1000); return; }
  }

  // 2) meta refresh を拾う（メイン/フレーム）
  const tryMeta = async (ctx, label) => {
    try {
      const html = await ctx.content();
      const m = html.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>]+)/i);
      if (m && m[1]) {
        let target = m[1];
        const base = new URL(ctx.url ? await ctx.url() : page.url());
        if (!/^https?:\/\//i.test(target)) {
          target = target.startsWith("/")
            ? `${base.origin}${target}`
            : `${base.origin}${base.pathname.replace(/\/[^/]*$/, "/")}${target}`;
        }
        console.log(`[relay] meta refresh from ${label}: ${target}`);
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
        await page.waitForTimeout(800);
        return true;
      }
    } catch {}
    return false;
  };
  if (await tryMeta(page, "main")) return;
  for (const f of page.frames()) { if (await tryMeta(f, `frame:${await f.url()}`)) return; }

  // 3) 少し待機（自動遷移待ち）
  await page.waitForTimeout(1200);
}

/** トップページから “空き家情報検索” へリンクを踏む */
async function enterFromHome(page) {
  const ok = await gotoRetry(page, HOME);
  if (!ok) return false;
  await recoverNotFound(page);
  await dumpWhere(page, "home");
  await screenshot(page, "step0-home.png");

  // 1) hrefで直接
  const hrefLink = page.locator('a[href*="akiyaJyoukenStartInit"]');
  if (await hrefLink.count()) {
    console.log('[enter] click link (href*="akiyaJyoukenStartInit")');
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(()=>{}),
      hrefLink.first().click()
    ]);
    await dumpWhere(page, "after-enter");
    await screenshot(page, "step1-after-enter.png");
    return true;
  }

  // 2) 文言でそれっぽいリンクを探す
  const candidates = [
    page.getByRole("link", { name: /空き|空家|あきや|検索|条件/i }),
    page.getByRole("button", { name: /空き|空家|検索|条件/i })
  ];
  for (const loc of candidates) {
    if (await loc.count()) {
      console.log("[enter] click alternative link");
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(()=>{}),
        loc.first().click()
      ]);
      await dumpWhere(page, "after-enter-alt");
      await screenshot(page, "step1-after-enter.png");
      return true;
    }
  }
  return false;
}

/** 検索ボタンを押す */
async function pressSearch(page) {
  const tryOn = async (ctx, label) => {
    const main = ctx.getByRole("button", { name: /^検索$/ });
    if (await main.count()) {
      console.log(`[search] click (${label}) "検索"`);
      await Promise.all([
        ctx.waitForLoadState("domcontentloaded").catch(()=>{}),
        main.first().click({ timeout: 4000 })
      ]);
      return true;
    }
    const fallbacks = [
      ctx.getByRole("button", { name: /検索|空き|空家|次へ|同意|OK/ }),
      ctx.getByRole("link",   { name: /検索|空き|空家/ }),
      ctx.getByText("検索", { exact: true })
    ];
    for (const loc of fallbacks) {
      if (await loc.count()) {
        console.log(`[search] click fallback (${label})`);
        try {
          await Promise.all([
            ctx.waitForLoadState("domcontentloaded").catch(()=>{}),
            loc.first().click({ timeout: 4000 })
          ]);
          return true;
        } catch {}
      }
    }
    return false;
  };

  if (await tryOn(page, "main")) return true;
  for (const f of page.frames()) if (await tryOn(f, `frame:${await f.url()}`)) return true;
  return false;
}

/** 一覧で「50件」を選ぶ（あれば） */
async function setPageSize50(page) {
  const tryOn = async (ctx, label) => {
    const selects = ctx.locator("select");
    const n = await selects.count();
    for (let i = 0; i < n; i++) {
      try {
        await selects.nth(i).selectOption({ label: "50" });
        console.log(`[pagesize] set 50 on ${label}`);
        const apply = ctx.getByRole("button", { name: /表示|再表示|検索|反映/ });
        if (await apply.count()) await apply.first().click().catch(()=>{});
        return true;
      } catch {}
    }
    return false;
  };
  if (await tryOn(page, "main")) return true;
  for (const f of page.frames()) if (await tryOn(f, `frame:${await f.url()}`)) return true;
  return false;
}

/** “おわび”や“その操作は…”に落ちたらホームからやり直し（1回だけ） */
async function recoverApologyOnce(page, flag) {
  const title = (await page.title().catch(()=> "")) || "";
  if (!flag.used && (title.includes("おわび") || title.includes("その操作は行わないで下さい") || page.url().endsWith("/service/#"))) {
    console.log("[recover] apology/operation error -> re-enter once");
    flag.used = true;
    const ok = await enterFromHome(page);
    if (ok) await passRelay(page);
  }
}

/* ============ メイン ============ */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36"
  });

  try {
    // 1) トップ → 空き家情報検索（リンク踏み）
    const entered = await enterFromHome(page);
    if (!entered) throw new Error("cannot find link from HOME");

    // 2) 中継ページ「こちら」 or meta refresh
    await passRelay(page);
    await dumpWhere(page, "after-relay");
    await screenshot(page, "step2-after-relay.png");

    // 3) おわび/操作エラーなら1回だけ再入場
    const once = { used: false };
    await recoverApologyOnce(page, once);

    // 4) 検索ボタン（最大2回試す）
    for (let i = 0; i < 2; i++) {
      const ok = await pressSearch(page);
      await page.waitForTimeout(1000);
      await recoverApologyOnce(page, once);
      if (ok) break;
    }
    await dumpWhere(page, "after-search");
    await screenshot(page, "step3-after-search.png");

    // 5) 可能なら 50件表示へ
    await setPageSize50(page);
    await page.waitForTimeout(800);

    // 6) キーワード検出
    let hit = false;
    for (const ctx of [page, ...page.frames()]) {
      const html = await ctx.content().catch(()=> "");
      if (html.includes(KEYWORD)) { hit = true; break; }
    }
    console.log(hit ? "HIT" : "not found");

    // 7) 最終ログ＆スクショ
    await dumpWhere(page, "final");
    await screenshot(page, "out.png");

  } catch (e) {
    console.error("ERROR", e);
    try { await screenshot(page, "out.png"); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
