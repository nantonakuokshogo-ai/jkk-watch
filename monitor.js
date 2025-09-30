import { chromium } from "playwright";
import fs from "fs";

/* ============ 設定 ============ */
const HOME  = "https://jhomes.to-kousya.or.jp/search/jkknet/";
const START = "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit";
const KEYWORD = "2LDK"; // 動作確認用。OKになったら本命に変更
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
  const title = await page.title().catch(()=>"");
  console.log(`[${label}] URL: ${page.url()}`);
  console.log(`[${label}] TITLE: ${title}`);
}
async function screenshot(page, name) {
  try { await page.screenshot({ path: name, fullPage: true }); } catch {}
}

/* ---------- 404/おわび → トップへ戻る ---------- */
async function recoverNotFound(page) {
  const title = (await page.title().catch(()=> "")) || "";
  if (title.includes("見つかりません") || title.includes("おわび")) {
    console.log("[recover] notfound/apology -> click 「トップページへ戻る」");

    const clickBack = async (ctx) => {
      const link = ctx.getByRole("link", { name: /トップページへ戻る/ });
      if (await link.count()) {
        await Promise.all([
          ctx.waitForLoadState("domcontentloaded").catch(()=>{}),
          link.first().click()
        ]);
        return true;
      }
      const btn = ctx.getByRole("button", { name: /トップページへ戻る/ });
      if (await btn.count()) {
        await Promise.all([
          ctx.waitForLoadState("domcontentloaded").catch(()=>{}),
          btn.first().click()
        ]);
        return true;
      }
      return false;
    };

    if (!(await clickBack(page))) {
      for (const f of page.frames()) {
        if (await clickBack(f)) break;
      }
    }
    await page.waitForTimeout(800);
  }
}

/* ---------- HOME → 検索入口を“踏む” ---------- */
async function enterFromHome(page) {
  const CANDIDATES = [
    "https://jhomes.to-kousya.or.jp/",
    HOME,
    HOME + "index.html",
    "https://jhomes.to-kousya.or.jp/search/jkknet/service/"
  ];

  const tryClickStart = async (ctx, label) => {
    // href 直指定
    let loc = ctx.locator('a[href*="akiyaJyoukenStartInit"]');
    if (await loc.count()) {
      console.log(`[enter] click link on ${label} (href*="akiyaJyoukenStartInit")`);
      await Promise.all([
        ctx.waitForLoadState("domcontentloaded").catch(()=>{}),
        loc.first().click()
      ]);
      return true;
    }
    // 文言でそれっぽいリンク/ボタン
    const cands = [
      ctx.getByRole("link",   { name: /空き|空家|あきや|空室|検索|条件/i }),
      ctx.getByRole("button", { name: /空き|空家|空室|検索|条件/i })
    ];
    for (const l of cands) {
      if (await l.count()) {
        console.log(`[enter] click alt on ${label}`);
        await Promise.all([
          ctx.waitForLoadState("domcontentloaded").catch(()=>{}),
          l.first().click()
        ]);
        return true;
      }
    }
    return false;
  };

  for (const url of CANDIDATES) {
    if (!(await gotoRetry(page, url))) continue;
    await recoverNotFound(page);
    await dumpWhere(page, "home");
    await screenshot(page, "step0-home.png");

    if (await tryClickStart(page, "main")) return true;
    for (const f of page.frames()) {
      if (await tryClickStart(f, `frame:${await f.url()}`)) return true;
    }
  }

  // 最終手段：Start直行（多くはここからでも中継で抜ける）
  console.log("[enter] fallback goto START directly");
  return await gotoRetry(page, START);
}

/* ---------- 中継ページ「こちら」を“抜けるまで粘る” ---------- */
async function passRelay(page) {
  console.log("[relay] robust start");

  const absolutize = (baseUrl, href) => {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    const base = new URL(baseUrl);
    return href.startsWith("/")
      ? `${base.origin}${href}`
      : `${base.origin}${base.pathname.replace(/\/[^/]*$/, "/")}${href}`;
  };

  const tryAllOn = async (ctx, label) => {
    // a) “こちら” 通常クリック
    const here = ctx.getByRole("link", { name: /こちら/ });
    if (await here.count()) {
      console.log(`[relay] click "${label}" -> こちら`);
      await here.first().click({ timeout: 3000 }).catch(()=>{});
      await page.waitForTimeout(800);
    }

    // b) JS click()
    await ctx.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a"))
        .find(x => /こちら/.test(x.textContent || ""));
      if (a) { try { a.click(); } catch(_) {} }
    }).catch(()=>{});
    await page.waitForTimeout(400);

    // c) href 直飛び
    try {
      const html = await ctx.content();
      const mA = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?こちら[\s\S]*?<\/a>/i);
      if (mA && mA[1]) {
        const abs = absolutize(ctx.url ? await ctx.url() : page.url(), mA[1]);
        if (abs) {
          console.log(`[relay] goto by href on ${label}: ${abs}`);
          await page.goto(abs, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
        }
      }
    } catch {}

    // d) meta refresh
    try {
      const html = await ctx.content();
      const mM = html.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>]+)/i);
      if (mM && mM[1]) {
        const abs = absolutize(ctx.url ? await ctx.url() : page.url(), mM[1]);
        if (abs) {
          console.log(`[relay] goto by meta on ${label}: ${abs}`);
          await page.goto(abs, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
        }
      }
    } catch {}

    // e) form.submit()（保険）
    await ctx.evaluate(() => { const f = document.querySelector("form"); if (f) { try { f.submit(); } catch(_) {} } }).catch(()=>{});
  };

  for (let i = 1; i <= 6; i++) {
    const before = page.url();
    console.log(`[relay] attempt ${i} at ${before}`);

    await tryAllOn(page, "main");
    for (const f of page.frames()) { await tryAllOn(f, `frame:${await f.url()}`); }

    await page.waitForLoadState("domcontentloaded").catch(()=>{});
    await page.waitForTimeout(1000);
    const after = page.url();
    console.log(`[relay] after ${i}: ${after}`);

    if (after !== before || !/akiyaJyoukenStartInit/.test(after)) {
      try { await page.screenshot({ path: `step2-relay-ok-${i}.png`, fullPage: true }); } catch {}
      console.log("[relay] done");
      return;
    }
    try { await page.screenshot({ path: `step2-relay-try-${i}.png`, fullPage: true }); } catch {}
  }

  console.log("[relay] still on StartInit after retries");
  try { await page.screenshot({ path: "step2-relay-stuck.png", fullPage: true }); } catch {}
}

/* ---------- 検索押下（総当たり版） ---------- */
async function _progressHappened(page, prevUrl, prevTitle) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(()=>{});
    const nowUrl = page.url();
    const nowTitle = await page.title().catch(()=> "");
    return (nowUrl !== prevUrl) || (nowTitle !== prevTitle);
  } catch { return false; }
}
async function pressSearch(page) {
  const clickCandidates = async (ctx, label) => {
    const prevUrl = page.url();
    const prevTitle = await page.title().catch(()=> "");

    const namePats = [
      /^検索$/, /検索する/, /空き|空家|空室.*検索/, /条件.*検索/,
      /同意して(検索|進む)/, /次へ/, /^OK$/
    ];
    for (const pat of namePats) {
      const b = ctx.getByRole("button", { name: pat });
      if (await b.count()) {
        console.log(`[search] role button ${pat} on ${label}`);
        await Promise.all([
          ctx.waitForLoadState("domcontentloaded").catch(()=>{}),
          b.first().click({ timeout: 4000 })
        ]).catch(()=>{});
        if (await _progressHappened(page, prevUrl, prevTitle)) return true;
      }
    }

    const sels = ['input[type="submit"]','input[type="image"]','button','a','img'];
    for (const sel of sels) {
      const els = ctx.locator(sel);
      const n = await els.count();
      for (let i = 0; i < Math.min(n, 40); i++) {
        const h = els.nth(i);
        const txt = (await h.innerText().catch(()=>'')) || '';
        const val = (await h.getAttribute('value').catch(()=>'')) || '';
        const alt = (await h.getAttribute('alt').catch(()=>'')) || '';
        const title = (await h.getAttribute('title').catch(()=>'')) || '';
        const onclick = (await h.getAttribute('onclick').catch(()=>'')) || '';
        const aria = (await h.getAttribute('aria-label').catch(()=>'')) || '';
        const href = (await h.getAttribute('href').catch(()=>'')) || '';
        const s = `${txt} ${val} ${alt} ${title} ${aria} ${onclick} ${href}`;

        if (/検索|空き|空家|空室|次へ|同意/i.test(s) || /submit\(/i.test(onclick) || /^javascript:.*submit/i.test(href)) {
          console.log(`[search] click ${sel}[${i}] on ${label} -> "${s.trim().slice(0,40)}"`);
          await h.click({ timeout: 4000, force: true }).catch(()=>{});
          if (await _progressHappened(page, prevUrl, prevTitle)) return true;
          try { await h.focus(); await page.keyboard.press("Enter"); } catch {}
          if (await _progressHappened(page, prevUrl, prevTitle)) return true;
        }
      }
    }

    const submitted = await ctx.evaluate(() => {
      const forms = Array.from(document.forms || []);
      forms.forEach(f => { try { f.submit(); } catch(_){} });
      return forms.length;
    }).catch(()=>0);
    if (submitted) {
      console.log(`[search] force submit() ${submitted} forms on ${label}`);
      await page.waitForTimeout(1500);
      if (await _progressHappened(page, prevUrl, prevTitle)) return true;
    }
    return false;
  };

  if (await clickCandidates(page, 'main')) return true;
  for (const f of page.frames()) { if (await clickCandidates(f, `frame:${await f.url()}`)) return true; }
  return false;
}

/* ---------- 一覧で「50件」にする（あれば） ---------- */
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

/* ---------- おわび/操作エラー → 1回だけ再入場 ---------- */
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
    // 1) トップ → 入口
    const entered = await enterFromHome(page);
    if (!entered) throw new Error("cannot find link from HOME");

    // 2) 中継を突破
    await passRelay(page);
    await dumpWhere(page, "after-relay");
    await screenshot(page, "step2-after-relay.png");

    // 3) 調査用ダンプ
    try { fs.writeFileSync('before-search.html', await page.content()); } catch {}

    // 4) おわびなら1回だけ再入場
    const once = { used: false };
    await recoverApologyOnce(page, once);

    // 5) 検索ボタン（最大2回）
    for (let i = 0; i < 2; i++) {
      const ok = await pressSearch(page);
      await page.waitForTimeout(1000);
      await recoverApologyOnce(page, once);
      if (ok) break;
    }
    await dumpWhere(page, "after-search");
    try { fs.writeFileSync('after-search.html', await page.content()); } catch {}
    await screenshot(page, "step3-after-search.png");

    // 6) 可能なら 50件
    await setPageSize50(page);
    await page.waitForTimeout(800);

    // 7) ヒット判定
    let hit = false;
    for (const ctx of [page, ...page.frames()]) {
      const html = await ctx.content().catch(()=> "");
      if (html.includes(KEYWORD)) { hit = true; break; }
    }
    console.log(hit ? "HIT" : "not found");

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
