import { chromium } from "playwright";
import fs from "fs";

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

// 404 や 「おわび」からトップへ戻る
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

    // メイン or フレームにある場合もある
    if (!(await clickBack(page))) {
      for (const f of page.frames()) {
        if (await clickBack(f)) break;
      }
    }
    await page.waitForTimeout(800);
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

// トップページから “空き家情報検索” へリンクを踏む
async function enterFromHome(page) {
  const CANDIDATES = [
    "https://jhomes.to-kousya.or.jp/",
    HOME,
    HOME + "index.html",
    "https://jhomes.to-kousya.or.jp/search/jkknet/service/"
  ];

  const tryClickStart = async (ctx, label) => {
    // hrefで直接
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

    // ← ここで “おわび/見つかりません” を踏んだら戻る
    await recoverNotFound(page);

    // メイン
    if (await tryClickStart(page, "main")) return true;
    // フレーム内に置かれている場合もある
    for (const f of page.frames()) {
      if (await tryClickStart(f, `frame:${await f.url()}`)) return true;
    }
  }

  // だめなら最終手段：Start 直行
  console.log("[enter] fallback goto START directly");
  return await gotoRetry(page, "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit");
}

// URLが変わった/タイトルが変わった/ネットワークが静かになったら「進んだ」とみなす
async function _progressHappened(page, prevUrl, prevTitle) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(()=>{});
    const nowUrl = page.url();
    const nowTitle = await page.title().catch(()=> "");
    return (nowUrl !== prevUrl) || (nowTitle !== prevTitle);
  } catch { return false; }
}

// 検索ボタンを「なんでも」押す：role→テキスト→属性→onclick→画像→Enter→全form.submit()
async function pressSearch(page) {
  const clickCandidates = async (ctx, label) => {
    const prevUrl = page.url();
    const prevTitle = await page.title().catch(()=> "");

    // 1) role=button 系（名前いろいろ）
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

    // 2) CSSセレクタで submit っぽい要素を総当たり
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
          // clickで動かない場合、Enter送出
          try { await h.focus(); await page.keyboard.press("Enter"); } catch {}
          if (await _progressHappened(page, prevUrl, prevTitle)) return true;
        }
      }
    }

    // 3) JS から form.submit() を全部叩く（onclickでセットする値が必要な場合は効かないが最後の保険）
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

 // 検索前に HTML を落とす（調査用）
try { fs.writeFileSync('before-search.html', await page.content()); } catch {}

// ④ 検索ボタン（最大2回試す）
for (let i = 0; i < 2; i++) {
  const ok = await pressSearch(page);
  await page.waitForTimeout(1000);
  await recoverApologyOnce(page, once);
  if (ok) break;
}

// 検索後に HTML を落とす（調査用）
try { fs.writeFileSync('after-search.html', await page.content()); } catch {}

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
