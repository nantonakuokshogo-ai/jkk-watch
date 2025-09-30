import { chromium } from 'playwright';

// ─── 設定 ───────────────────────────────────────────────────────────────
const HOME   = 'https://jhomes.to-kousya.or.jp/search/jkknet/';
const START  = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';
const KEYWORD = 'DK'; // 動作確認後に本命へ変更
// ──────────────────────────────────────────────────────────────────────

async function gotoWithRetry(page, url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`try ${i}: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return true;
    } catch (e) {
      console.log(`failed ${i}:`, e.message);
      if (i === tries) return false;
      await page.waitForTimeout(1500);
    }
  }
  return false;
}

// ── HOME → StartInit を“リンク踏み”で入る（直リンクだと謝罪ページに落ちがち）
async function enterFromHome(page) {
  const ok = await gotoWithRetry(page, HOME);
  if (!ok) return false;

  // StartInit へ行くリンクを href 部分一致で探す
  const startLink = page.locator('a[href*="akiyaJyoukenStartInit"]');
  if (await startLink.count()) {
    console.log('[enter] click link to StartInit (href*="akiyaJyoukenStartInit")');
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(()=>{}),
      startLink.first().click()
    ]);
    return true;
  }
  // 保険：テキストでそれっぽいリンクも試す
  const alt = page.getByRole('link', { name: /空き|空家|検索|JKKねっと|条件/i });
  if (await alt.count()) {
    console.log('[enter] click alternative link from HOME');
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(()=>{}),
      alt.first().click()
    ]);
    return true;
  }
  return false;
}

// ── 中継ページ「こちら」突破（href抽出 → meta refresh → 強制クリック/座標）
async function passRelay(page) {
  console.log('[relay] start');

  const absolutize = (baseUrl, href) => {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    const base = new URL(baseUrl);
    return href.startsWith('/')
      ? `${base.origin}${href}`
      : `${base.origin}${base.pathname.replace(/\/[^/]*$/, '/')}${href}`;
  };

  const tryParseHtmlForHref = async (ctx, label) => {
    try {
      const html = await ctx.content();
      const m = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?こちら[\s\S]*?<\/a>/i);
      if (m && m[1]) {
        const abs = absolutize(ctx.url ? await ctx.url() : page.url(), m[1]);
        console.log(`[relay] parse href from ${label}: ${abs}`);
        await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
        return true;
      }
    } catch {}
    return false;
  };

  const tryMetaRefresh = async (ctx, label) => {
    try {
      const html = await ctx.content();
      const m = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>]+)/i);
      if (m && m[1]) {
        const abs = absolutize(ctx.url ? await ctx.url() : page.url(), m[1]);
        console.log(`[relay] meta refresh from ${label}: ${abs}`);
        await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
        return true;
      }
    } catch {}
    return false;
  };

  const tryForceClick = async (ctx, label) => {
    const loc = ctx.locator('text=こちら');
    if (await loc.count()) {
      console.log(`[relay] force click text on ${label}`);
      try {
        await Promise.all([
          ctx.waitForLoadState('domcontentloaded').catch(()=>{}),
          loc.first().click({ timeout: 3000, force: true })
        ]);
        return true;
      } catch {}
      try { // 座標クリック
        const box = await loc.first().boundingBox();
        if (box) {
          console.log(`[relay] mouse click (${Math.round(box.x)},${Math.round(box.y)}) on ${label}`);
          await ctx.mouse.click(box.x + box.width/2, box.y + box.height/2);
          await ctx.waitForLoadState('domcontentloaded').catch(()=>{});
          return true;
        }
      } catch {}
    }
    return false;
  };

  // メイン/全フレームで順に試す
  if (await tryParseHtmlForHref(page, 'main')) gotoDone(); else {
    for (const f of page.frames()) { if (await tryParseHtmlForHref(f, `frame:${await f.url()}`)) { gotoDone(); break; } }
  }
  if (page.url() && (await tryMetaRefresh(page, 'main'))) gotoDone(); else {
    for (const f of page.frames()) { if (await tryMetaRefresh(f, `frame:${await f.url()}`)) { gotoDone(); break; } }
  }
  if (!(await tryForceClick(page, 'main'))) {
    for (const f of page.frames()) { if (await tryForceClick(f, `frame:${await f.url()}`)) break; }
  }

  await page.waitForTimeout(1200);
  console.log('[relay] after, URL:', page.url());
  for (const f of page.frames()) console.log('[relay] frame:', await f.url());
  function gotoDone(){ /* no-op */ }
}

// ── 「おわび」ページに落ちたら HOME から入り直す
async function recoverIfApology(page) {
  const title = (await page.title().catch(()=>'')) || '';
  if (title.includes('おわび') || page.url().endsWith('/service/#')) {
    console.log('[recover] apology page detected -> go HOME and re-enter');
    await enterFromHome(page);
    await passRelay(page);
  }
}

// ── 検索ボタン押下（メイン/フレームを探索）
async function pressSearch(page) {
  const tryOn = async (ctx, desc) => {
    let btn = ctx.getByRole('button', { name: /^検索$/ });
    if (await btn.count()) {
      console.log(`[search] click (${desc}) "検索"`);
      await Promise.all([
        ctx.waitForLoadState('domcontentloaded').catch(() => {}),
        btn.first().click({ timeout: 3000 })
      ]);
      return true;
    }
    const candidates = [
      ctx.getByRole('link',   { name: /空き|検索/ }),
      ctx.getByRole('button', { name: /空き|検索|次へ|同意|OK/ }),
      ctx.getByText('検索', { exact: true }),
    ];
    for (const loc of candidates) {
      if (await loc.count()) {
        console.log(`[search] click (${desc}) fallback`);
        try {
          await Promise.all([
            ctx.waitForLoadState('domcontentloaded').catch(() => {}),
            loc.first().click({ timeout: 3000 })
          ]);
          return true;
        } catch {}
      }
    }
    return false;
  };

  if (await tryOn(page, 'main')) return true;
  for (const f of page.frames()) { if (await tryOn(f, `frame:${await f.url()}`)) return true; }
  return false;
}

// ── 一覧で 50件 に（存在すれば）
async function setPageSize50(page) {
  const tryOn = async (ctx, desc) => {
    const selects = ctx.locator('select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      try {
        await selects.nth(i).selectOption({ label: '50' });
        console.log(`[pagesize] set 50 on ${desc}`);
        const apply = ctx.getByRole('button', { name: /表示|再表示|検索|反映/ });
        if (await apply.count()) await apply.first().click().catch(() => {});
        return true;
      } catch {}
    }
    return false;
  };
