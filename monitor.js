import { chromium } from "playwright";

// ===== 設定 =====
const HOME = "https://jhomes.to-kousya.or.jp/search/jkknet/";
const KEYWORD = "DK"; // 動作確認後に本命へ変更

async function goto(page, url) {
  for (let i = 1; i <= 3; i++) {
    try {
      console.log(`goto try${i}:`, url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return true;
    } catch (e) {
      console.log("goto fail:", e.message);
      await page.waitForTimeout(1200);
    }
  }
  return false;
}

async function enterFromHome(page) {
  if (!(await goto(page, HOME))) return false;
  const byHref = page.locator('a[href*="akiyaJyoukenStartInit"]');
  if (await byHref.count()) {
    await Promise.all([page.waitForLoadState("domcontentloaded").catch(()=>{}), byHref.first().click()]);
    return true;
  }
  const alt = page.getByRole("link", { name: /空き|空家|検索|条件/i });
  if (await alt.count()) {
    await Promise.all([page.waitForLoadState("domcontentloaded").catch(()=>{}), alt.first().click()]);
    return true;
  }
  return false;
}

async function passRelay(page) {
  // “こちら”のhrefをHTMLから直接抜いて遷移
  const absolutize = (base, href) => {
    const b = new URL(base);
    if (/^https?:\/\//i.test(href)) return href;
    return href.startsWith("/") ? `${b.origin}${href}` : `${b.origin}${b.pathname.replace(/\/[^/]*$/, "/")}${href}`;
  };
  const tryCtx = async (ctx, label) => {
    try {
      const html = await ctx.content();
      let m = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?こちら[\s\S]*?<\/a>/i);
      if (m && m[1]) {
        const abs = absolutize(ctx.url ? await ctx.url() : page.url(), m[1]);
        console.log("[relay] href:", abs);
        await page.goto(abs, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
        return true;
      }
      m = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>]+)/i);
      if (m && m[1]) {
        const abs = absolutize(ctx.url ? await ctx.url() : page.url(), m[1]);
        console.log("[relay] meta:", abs);
        await page.goto(abs, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
        return true;
      }
    } catch {}
    return false;
  };
  if (await tryCtx(page, "main")) return;
  for (const f of page.frames()) { if (await tryCtx(f, `frame:${await f.url()}`)) return; }
  // 最後に強制クリック
  const here = page.locator("text=こちら");
  if (await here.count()) {
    await Promise.all([page.waitForLoadState("domcontentloaded").catch(()=>{}), here.first().click({ force: true })]);
  }
  await page.waitForTimeout(800);
}

async function recoverIfApology(page) {
  const title = (await page.title().catch(()=> "")) || "";
  if (title.includes("おわび") || page.url().endsWith("/service/#")) {
    console.log("[recover] apology -> re-enter from HOME");
    await enterFromHome(page);
    await passRelay(page);
  }
}

async function pressSearch(page) {
  const tryOn = async (ctx) => {
    const main = ctx.getByRole("button", { name: /^検索$/ });
    if (await main.count()) {
      await Promise.all([ctx.waitForLoadState("domcontentloaded").catch(()=>{}), main.first().click()]);
      return true;
    }
    const cand = [
      ctx.getByRole("button", { name: /空き|検索|次へ|同意|OK/ }),
      ctx.getByRole("link",   { name: /空き|検索/ }),
      ctx.getByText("検索", { exact: true })
    ];
    for (const loc of cand) {
      if (await loc.count()) {
        try {
          await Promise.all([ctx.waitForLoadState("domcontentloaded").catch(()=>{}), loc.first().click()]);
          return true;
        } catch {}
      }
    }
    return false;
  };
  if (await tryOn(page)) return true;
  for (const f of page.frames()) { if (await tryOn(f)) return true; }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36"
  });
  try {
    const entered = await enterFromHome(page);
    if (!entered) throw new Error("cannot find StartInit link from HOME");
    await passRelay(page);
    await recoverIfApology(page);

    for (let i = 0; i < 2; i++) {
      const ok = await pressSearch(page);
      await page.waitForTimeout(1000);
      await recoverIfApology(page);
      if (ok) break;
    }

    // ページの状況ログとスクショ
    console.log("URL:", page.url());
    try { console.log("TITLE:", await page.title()); } catch {}
    let hit = false;
    for (const ctx of [page, ...page.frames()]) {
      const html = await ctx.content().catch(()=> "");
      if (html.includes(KEYWORD)) { hit = true; break; }
    }
    console.log(hit ? "HIT" : "not found");
    await page.screenshot({ path: "out.png", fullPage: true }).catch(()=>{});
  } catch (e) {
    console.error("ERROR", e);
    try { await page.screenshot({ path: "out.png", fullPage: true }); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
