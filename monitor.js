import { chromium } from "playwright";
import fs from "fs";

/* ===== 設定 ===== */
const HOME     = "https://jhomes.to-kousya.or.jp/search/jkknet/";
const FRAMESET = "https://jhomes.to-kousya.or.jp/search/jkknet/service/";
const START    = "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit";
const KEYWORD  = "DK";   // 動作確認用。OKになったら本命ワードに変更
/* ================ */
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"]
});
const context = await browser.newContext({
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
  extraHTTPHeaders: {
    "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
    "Upgrade-Insecure-Requests": "1"
  }
});
const page = await context.newPage();

async function gotoRetry(page, url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`goto try${i}: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return true;
    } catch (e) {
      console.log(`goto fail${i}:`, e.message);
      await page.waitForTimeout(800);
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
async function dumpAllFrames(page, prefix="dump") {
  try {
    const lines = [];
    const all = [page, ...page.frames()];
    let idx = 0;
    for (const f of all) {
      const u = f === page ? page.url() : f.url();
      const t = await (f === page ? page.title() : f.title()).catch(()=> "");
      lines.push(`[${idx}] ${u}  |  ${t}`);
      const html = await f.content().catch(()=> "");
      fs.writeFileSync(`${prefix}-frame-${idx}.html`, html ?? "");
      idx++;
    }
    fs.writeFileSync(`${prefix}-frames.txt`, lines.join("\n"));
  } catch {}
}

/* --- 404/おわび → トップへ戻す（HOME遷移のとき使用） --- */
async function recoverNotFound(page) {
  const title = (await page.title().catch(()=> "")) || "";
  if (title.includes("見つかりません") || title.includes("おわび")) {
    console.log("[recover] notfound/apology -> click 「トップページへ戻る」");
    const tryOn = async (ctx) => {
      const link = ctx.getByRole("link", { name: /トップページへ戻る/ });
      if (await link.count()) { await link.first().click().catch(()=>{}); return true; }
      const btn  = ctx.getByRole("button", { name: /トップページへ戻る/ });
      if (await btn.count())  { await btn.first().click().catch(()=>{});  return true; }
      return false;
    };
    if (!(await tryOn(page))) {
      for (const f of page.frames()) if (await tryOn(f)) break;
    }
    await page.waitForTimeout(600);
  }
}

/* --- HOMEへ（クッキー確保目的／見つからなくてもOK） --- */
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

// /service/ に一度触れてクッキー確保 → Referer 付きで StartInit 直行 → mainフレーム検出
async function gotoFrameset(page) {
  const FRAMESET = "https://jhomes.to-kousya.or.jp/search/jkknet/service/";
  const START    = "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit";

  // 1) /service/ に触って JSESSIONID を得る（おわびでもOK）
  await gotoRetry(page, FRAMESET);
  await page.waitForLoadState("domcontentloaded").catch(()=>{});

  // 2) Referer=/service/ を付けて StartInit に直行
  console.log("[frameset] direct goto StartInit with referer=/service/");
  await page.goto(START, { waitUntil: "domcontentloaded", timeout: 60000, referer: FRAMESET })
            .catch(()=>{});

  // 3) “こちら” があれば踏む（出ることがある）
  for (const ctx of [page, ...page.frames()]) {
    const here = ctx.getByRole("link", { name: /こちら/ });
    if (await here.count()) {
      await Promise.all([
        ctx.waitForLoadState("domcontentloaded").catch(()=>{}),
        here.first().click().catch(()=>{})
      ]);
      await page.waitForTimeout(600);
    }
  }

  // 4) mainフレーム（StartInit）を探す
  const findMain = () => {
    let f = page.frames().find(fr => /akiyaJyoukenStartInit/i.test(fr.url()));
    if (f) return f;
    f = page.frames().find(fr => /(^|\/)main(\.html)?$/i.test(fr.url()) || /main/i.test(fr.name()));
    return f || null;
  };

  for (let i = 0; i < 10; i++) {
    const mf = findMain();
    if (mf) return mf;
    await page.waitForTimeout(500);
  }
  return null; // 呼出し側でエラー化
}


/* --- ページ進捗判定 --- */
async function _progressHappened(page, prevUrl, prevTitle) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(()=>{});
    const nowUrl = page.url();
    const nowTitle = await page.title().catch(()=> "");
    return (nowUrl !== prevUrl) || (nowTitle !== prevTitle);
  } catch { return false; }
}

// 中継ページの「こちら」を全部のフレームで探して踏み抜く
async function clickRelayLoop(page) {
  for (let step = 0; step < 5; step++) {
    let clicked = false;

    // page 本体 + すべての frame を総当り
    for (const ctx of [page, ...page.frames()]) {
      const link = ctx.getByRole("link", { name: /こちら/ });
      if (await link.count()) {
        console.log(`[relay] click "こちら" on ${ctx === page ? "main" : ("frame:" + ctx.url())}`);
        await Promise.all([
          page.waitForLoadState("domcontentloaded").catch(()=>{}),
          link.first().click().catch(()=>{})
        ]);
        clicked = true;
      }
    }

    // 1回でもクリックしたらちょい待ち→さらに「こちら」が出ていれば繰り返す
    if (clicked) {
      await page.waitForTimeout(800);
    } else {
      break; // もう「こちら」が無ければ終了
    }
  }
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
      if (/検索|空き|空家|空室|次へ|同意/i.test(s) || /submit\(/i.test(onclick) || /^javascript:.*submit/i.test((href||""))) {
        console.log(`[search] click candidate on ${label}: "${s.trim().slice(0,50)}"`);
        await h.click({ timeout: 4000, force: true }).catch(()=>{});
        if (await _progressHappened(page, prevUrl, prevTitle)) return true;
        try { await h.focus(); await page.keyboard.press("Enter"); } catch {}
        if (await _progressHappened(page, prevUrl, prevTitle)) return true;
      }
    }

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

/* --- 一覧で「50件」を狙う --- */
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

/* --- おわび/操作エラー → 1回だけフレームセット直行で復帰 --- */
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
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
      "Upgrade-Insecure-Requests": "1"
    }
  });
  const page = await context.newPage();

  try {
    // 1) 入口 → 2) フレームセット（main フレームを掴む）
    await enterFromHome(page);
    let mainFrame = await gotoFrameset(page);
    if (!mainFrame) {
      await dumpAllFrames(page, "debug_frameset_final");
      await screenshot(page, "debug_frameset_final.png");
      throw new Error("cannot get main frame (StartInit)");
    }
    await dumpWhere(page, "frameset");
    await screenshot(page, "step2-frameset.png");

    // 3) 調査ダンプ
    try { fs.writeFileSync("before-search.html", await page.content()); } catch {}
　　
    await clickRelayLoop(page);   // ← 追加（中継ページを突破）

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
    await dumpAllFrames(page, "debug_error");
    await screenshot(page, "out.png");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
