import { chromium } from "playwright";

/* ===================== 設定 ===================== */
const HOME = "https://jhomes.to-kousya.or.jp/search/jkknet/";
const START = "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit";
const KEYWORD = "DK"; // ←動作確認用。OKになったら本命に変更
/* ================================================= */

async function goto(page, url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`goto try${i}: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return true;
    } catch (e) {
      console.log("goto fail:", e.message);
      await page.waitForTimeout(1200);
    }
  }
  return false;
}

/* ---------- 404（ページが見つかりません）からの復帰 ---------- */
async function recoverIfNotFound(page) {
  const title = (await page.title().catch(() => "")) || "";
  if (title.includes("見つかりません")) {
    console.log('[recover] not found -> click 「トップページへ戻る」');
    const link = page.getByRole("link", { name: /トップページへ戻る/ });
    if (await link.count()) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        link.first().click()
      ]);
      await page.waitForTimeout(800);
      return true;
    }
    const btn = page.getByRole("button", { name: /トップページへ戻る/ });
    if (await btn.count()) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        btn.first().click()
      ]);
      await page.waitForTimeout(800);
      return true;
    }
  }
  return false;
}

/* ---------- HOME → StartInit を“リンク踏み”で入る ---------- */
async function enterFromHome(page) {
  const CANDIDATES = [
    HOME,
    HOME + "index.html",
    "https://jhomes.to-kousya.or.jp/search/jkknet/service/"
  ];

  for (const url of CANDIDATES) {
    if (!(await goto(page, url))) continue;
    await recoverIfNotFound(page);

    const byHref = page.locator('a[href*="akiyaJyoukenStartInit"]');
    if (await byHref.count()) {
      console.log('[enter] click link to StartInit (href*="akiyaJyoukenStartInit")');
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        byHref.first().click()
      ]);
      return true;
    }
    const alt = page.getByRole("link", { name: /空き|空家|検索|条件|JKKねっと/i });
    if (await alt.count()) {
      console.log("[enter] click alternative link from HOME");
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        alt.first().click()
      ]);
      return true;
    }
  }

  // 最終手段：Startへ直行
  console.log("[enter] fallback goto START directly");
  return await goto(page, START);
}

/* ---------- 中継ページ「こちら」を突破（href→meta→クリック） ---------- */
async function passRelay(page) {
  console.log("[relay] start");

  const absolutize = (baseUrl, href) => {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    const base = new URL(baseUrl);
    return href.startsWith("/")
      ? `${base.origin}${href}`
      : `${base.origin}${base.pathname.replace(/\/[^/]*$/, "/")}${href}`;
  };

  const tryCtx = async (ctx, label) => {
    try {
      const html = await ctx.content();

      // a ...>こちら</a>
      let m = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?こちら[\s\S]*?<\/a>/i);
      if (m && m[1]) {
        const abs = absolutize(ctx.url ? await ctx.url() : page.url(), m[1]);
        console.log(`[relay] parse href from ${label}: ${abs}`);
        await page.goto(abs, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        return true;
      }

      // <meta http-equiv="refresh" content="...;url=...">
      m = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>]+)/i);
      if (m && m[1]) {
        const abs = absolutize(ctx.url ? await ctx.url() : page.url(), m[1]);
        console.log(`[relay] meta refresh from ${label}: ${abs}`);
        await page.goto(abs, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        return true;
      }
    } catch {}
    return false;
  };

  if (await tryCtx(page, "main")) { /* ok */ }
  else {
    for (const f of page.frames()) {
      if (await tryCtx(f, `frame:${await f.url()}`)) break;
    }
    // 最後に強制クリック（保険）
    const here = page.locator("text=こちら");
    if (await here.count()) {
      console.log("[relay] force click");
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        here.first().click({ force: true })
      ]);
    }
  }

  await page.waitForTimeout(1200);
  console.log("[relay] after, URL:", page.url());
  for (const f of page.frames()) console.log("[relay] frame:", await f.url());
}

/* ---------- おわびページに落ちたら復帰 ---------- */
async function recoverIfApology(page) {
  const title = (await page.title().catch(() => "")) || "";
  if (title.includes("おわび") || page.url().endsWith("/service/#")) {
    console.log("[recover] apology page -> re-enter from HOME");
    await enterFromHome(page);
    await passRelay(page);
  }
}

/* ---------- 検索ボタンクリック ---------- */
async function pressSearch(page) {
  const tryOn = async (ctx, desc) => {
    const main = ctx.getByRole("button", { name: /^検索$/ });
    if (await main.count()) {
      console.log(`[search] click (${desc}) "検索"`);
      await Promise.all([
        ctx.waitForLoadState("domcontentloaded").catch(() => {}),
        main.first().click({ timeout: 3000 })
      ]);
      return true;
    }
    const cand = [
      ctx.getByRole("button", { name: /空き|検索|次へ|同意|OK/ }),
      ctx.getByRole("link",   { name: /空き|検索/ }),
      ctx.getByText("検索", { exact: true })
    ];
    for (const loc of cand) {
      if (await loc.count()) {
        console.log(`[search] click (${desc}) fallback`);
        try {
          await Promise.all([
            ctx.waitForLoadState("domcontentloaded").catch(() => {}),
            loc.first().click({ timeout: 3000 })
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

/* ---------- 一覧で「50件」選択（あれば） ---------- */
async function setPageSize50(page) {
  const tryOn = async (ctx, desc) => {
    const selects = ctx.locator("select");
    const n = await selects.count();
    for (let i = 0; i < n; i++) {
      try {
        await selects.nth(i).selectOption({ label: "50" });
        console.log(`[pagesize] set 50 on ${desc}`);
        const apply = ctx.getByRole("button", { name: /表示|再表示|検索|反映/ });
        if (await apply.count()) await apply.first().click().catch(() => {});
        return true;
      } catch {}
    }
    return false;
  };
  if (await tryOn(page, "main")) return true;
  for (const f of page.frames()) if (await tryOn(f, `frame:${await f.url()}`)) return true;
  return false;
}

/* ===================== メイン ===================== */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36"
  });

  try {
    // ① HOME から入る（404を踏んだら戻る）→ ② 中継「こちら」
    const entered = await enterFromHome(page);
    if (!entered) throw new Error("cannot find StartInit link from HOME");
    await passRelay(page);

    // ③ おわびに落ちたら復帰
    await recoverIfApology(page);

    // ④ 検索ボタン（最大2回試す／途中でおわびなら復帰）
    for (let i = 0; i < 2; i++) {
      const ok = await pressSearch(page);
      await page.waitForTimeout(1000);
      await recoverIfApology(page);
      if (ok) break;
    }

    // ⑤（あれば）50件
    await setPageSize50(page);
    await page.waitForTimeout(800);

    // ⑥ 判定 & スクショ
    let hit = false;
    for (const ctx of [page, ...page.frames()]) {
      const html = await ctx.content().catch(() => "");
      if (html.includes(KEYWORD)) { hit = true; break; }
    }
    console.log(hit ? "HIT" : "not found");

    console.log("URL:", page.url());
    try { console.log("TITLE:", await page.title()); } catch {}
    await page.screenshot({ path: "out.png", fullPage: true }).catch(() => {});
  } catch (e) {
    console.error("ERROR", e);
    try { await page.screenshot({ path: "out.png", fullPage: true }); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
