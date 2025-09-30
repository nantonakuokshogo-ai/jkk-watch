import { chromium } from "playwright";
import fs from "fs";

/* ===== 設定 ===== */
const HOME  = "https://jhomes.to-kousya.or.jp/search/jkknet/";
const FRAMESET = "https://jhomes.to-kousya.or.jp/search/jkknet/service/";
const START = "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit";
const KEYWORD = "DK";   // 動作確認用。OKになったら本命ワードに変更
/* ================ */

async function gotoRetry(page, url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`goto try${i}: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return true;
    } catch (e) {
      console.log(`goto fail${i}:`, e.message);
      await page.waitForTimeout(1000);
    }
  }
  return false;
}
async function dumpWhere(page, label) {
  console.log(`[${label}] URL: ${page.url()}`);
  console.log(`[${label}] TITLE: ${(await page.title().catch(()=> "")) || ""}`);
}
async function screenshot(page, name) {
  try { await page.screenshot({ path: name, fullPage: true }); } catch {}
}

/* --- 404/おわび → トップへ戻す（HOME遷移のとき使用） --- */
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
      for (const f of page.frames()) if (await clickBack(f)) break;
    }
    await page.waitForTimeout(800);
  }
}

/* --- HOME(どこでも可)へ入る。見つからなくてもOK --- */
async function enterFromHome(page) {
  const CANDIDATES = [
    "https://jhomes.to-kousya.or.jp/",
    HOME,
    HOME + "index.html",
    FRAMESET
  ];
  for (const url of CANDIDATES) {
    await gotoRetry(page, url);
    await recoverNotFound(page);
    await dumpWhere(page, "home");
    await screenshot(page, "step0-home.png");
  }
  return true;
}

/* --- フレームセット /service/ をトップに開いて main フレームを取得 --- */
async function gotoFrameset(page) {
  await gotoRetry(page, FRAMESET);
  await page.waitForLoadState("domcontentloaded").catch(()=>{});

  // “こちら” 中継が main に出ることがあるので踏む
  for (let t = 0; t < 3; t++) {
    for (const f of page.frames()) {
      const here = f.getByRole("link", { name: /こちら/ });
      if (await here.count()) {
        console.log("[frameset] click こちら in frame");
        await Promise.all([
          f.waitForLoadState("domcontentloaded").catch(()=>{}),
          here.first().click().catch(()=>{})
        ]);
      }
    }
    await page.waitForTimeout(500);
  }

  // StartInit を読み込んだ main フレームを探す
  for (let i = 0; i < 10; i++) {
    const mf = page.frames().find(f => /akiyaJyoukenStartInit/i.test(f.url()));
    if (mf) return mf;
    await page.waitForTimeout(500);
  }
  return null;
}

/* --- ページの進捗判定 --- */
async function _progressHappened(page, prevUrl, prevTitle) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(()=>{});
    const nowUrl = page.url();
    const nowTitle = await page.title().catch(()=> "");
    return (nowUrl !== prevUrl) || (nowTitle !== prevTitle);
  } catch { return false; }
}

/* --- 検索押下（page と全frameを総当たり） --- */
async function pressSearch(page) {
  const clickOn = async (ctx, label) => {
    const prevUrl = page.url();
    const prevTitle = await page.title().catch(()=> "");

    const namePats = [/^検索$/, /検索する/, /空き|空家|空室.*検索/, /条件.*検索/, /次へ/, /同意/];
    for (const p of namePats) {
      const b = ctx.getByRole("button", { name: p });
      if (await b.count()) {
        console.log(`[search] role button ${p} on ${label}`);
        await b.first().click({ timeout: 4000 }).catch(()=>{});
        if (await _progressHappened(page, prevUrl, prevTitle)) return true;
      }
    }

    const sels = ['input[type="submit"]','input[type="image"]','button','a','img'];
    const els = ctx.locator(sels.join(","));
    const n = await els.count();
    for (let i = 0; i < Math.min(n, 40); i++) {
      const h = els.nth(i);
      const txt = (await h.innerText().catch(()=>'')) || '';
      const val = (await h.getAttribute('value').catch(()=>'')) || '';
      const alt = (await h.getAttribute('alt').catch(()=>'')) || '';
      const title = (await h.getAttribute('title').catch(()=>'')) || '';
      const onclick = (await h.getAttribute('onclick').catch(()=>'')) || '';
      const href = (await h.getAttribute('href').catch(()=>'')) || '';
      const s = `${txt} ${val} ${alt} ${title} ${onclick} ${href}`;
      if (/検索|空き|空家|空室|次へ|同意/i.test(s) || /submit\(/i.test(onclick) || /^javascript:.*submit/i.test(href || "")) {
        console.log(`[search] click candidate on ${label}: "${s.trim().slice(0,50)}"`);
        await h.click({ timeout: 4000, force: true }).catch(()=>{});
        if (await _progressHappened(page, prevUrl, prevTitle)) return true;
        try { await h.focus(); await page.keyboard.press("Enter"); } catch {}
        if (await _progressHappened(page, prevUrl, prevTitle)) return true;
      }
    }

    // 保険: form.submit() を全部叩く
    const submitted = await ctx.evaluate(() => {
      const forms = Array.from(document.forms || []);
      forms.forEach(f => { try { f.submit(); } catch(_){} });
      return forms.length;
    }).catch(()=>0);
    if (submitted) {
      console.log(`[search] force submit() ${submitted} forms on ${label}`);
      await page.waitForTimeout(1000);
      if (await _progressHappened(page, prevUrl, prevTitle)) return true;
    }
    return false;
  };

  if (await clickOn(page, "main")) return true;
  for (const f of page.frames()) if (await clickOn(f, `frame:${await f.url()}`)) return true;
  return false;
}

/* --- 一覧で「50件」を狙う（あれば） --- */
async function setPageSize50(page) {
  const tryOn = async (ctx, label) => {
    const selects = ctx.locator("select");
    const n = await selects.count();
    for (let i = 0; i < n; i++) {
      try {
        await selects.nth(i).selectOption({ label: "50" });
        console.log(`[pagesize] set 50 on ${label}`);
        const apply = ctx.getByRole("button", { name: /表示|再表示|検索|反映|変更/ });
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

/* --- おわび/操作エラー → 1回だけ “フレームセット直行” で復帰 --- */
async function recoverApologyOnce(page, flag) {
  const title = (await page.title().catch(()=> "")) || "";
  if (!flag.used && (title.includes("おわび") || title.includes("その操作は行わないで下さい") || page.url().endsWith("/service/#"))) {
    console.log("[recover] apology/operation error -> re-enter frameset once");
    flag.used = true;
    await enterFromHome(page);
    await gotoFrameset(page);
  }
}

/* ===== メイン ===== */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36"
  });

  try {
    // 1) 入口 → 2) フレームセット（mainフレームを掴む）
    await enterFromHome(page);
    let mainFrame = await gotoFrameset(page);
    if (!mainFrame) throw new Error("cannot get main frame (StartInit)");
    await dumpWhere(page, "frameset");
    await screenshot(page, "step2-frameset.png");

    // 3) 調査ダンプ
    try { fs.writeFileSync("before-search.html", await page.content()); } catch {}

    // 4) おわび1回リカバリ
    const once = { used: false };
    await recoverApologyOnce(page, once);

    // 5) 検索押下（最大2回）
    for (let i = 0; i < 2; i++) {
      const ok = await pressSearch(page);
      await page.waitForTimeout(1000);
      await recoverApologyOnce(page, once);
      if (ok) break;
    }
    await dumpWhere(page, "after-search");
    try { fs.writeFileSync("after-search.html", await page.content()); } catch {}
    await screenshot(page, "step3-after-search.png");

    // 6) 50件化
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
    await screenshot(page, "out.png");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
