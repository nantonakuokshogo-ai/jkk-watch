import { chromium } from 'playwright';

const START = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';
const KEYWORD = 'DK'; // 動作確認後に本命へ変更

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

// ---- 中継ページ突破（href抽出→meta→強制クリック→座標クリック）----
async function passRelay(page) {
  console.log('[relay] start');

  // 相対→絶対
  const absolutize = (baseUrl, href) => {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    const base = new URL(baseUrl);
    return href.startsWith('/')
      ? `${base.origin}${href}`
      : `${base.origin}${base.pathname.replace(/\/[^/]*$/, '/')}${href}`;
  };

  // 1) HTMLを直に見て <a ...>こちら</a> の href を抜く（メインと全フレーム）
  const tryParseHtmlForHref = async (ctx, label) => {
    try {
      const html = await ctx.content();
      // こちらテキストを含むアンカーのhrefを抜く
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

  // 2) <meta http-equiv="refresh" ... url=...> を拾う
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

  // 3) 強制クリック（text=こちら）
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
      // 座標クリック（最終手段）
      try {
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

  // ===== 順番に試す =====
  // メイン→全フレーム：HTMLパース
  if (await tryParseHtmlForHref(page, 'main')) gotoDone(); else {
    for (const f of page.frames()) { if (await tryParseHtmlForHref(f, `frame:${await f.url()}`)) { gotoDone(); break; } }
  }
  // メタリフレッシュ
  if (page.url() && (await tryMetaRefresh(page, 'main'))) gotoDone(); else {
    for (const f of page.frames()) { if (await tryMetaRefresh(f, `frame:${await f.url()}`)) { gotoDone(); break; } }
  }
  // 強制クリック
  if (!(await tryForceClick(page, 'main'))) {
    for (const f of page.frames()) { if (await tryForceClick(f, `frame:${await f.url()}`)) break; }
  }

  // 少し待って状況をログ
  await page.waitForTimeout(1200);
  console.log('[relay] after, URL:', page.url());
  for (const f of page.frames()) console.log('[relay] frame:', await f.url());

  function gotoDone(){ /* no-op: 直後の wait とログで確認 */ }
}


// ---- 検索ボタン押下 ----
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

// ---- 一覧で 50件 にする（存在すれば）----
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
  if (await tryOn(page, 'main')) return true;
  for (const f of page.frames()) { if (await tryOn(f, `frame:${await f.url()}`)) return true; }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36'
  });

  try {
    const ok = await gotoWithRetry(page, START);
    if (!ok) throw new Error('cannot open START');

    await passRelay(page);                 // 中継突破
    for (let i = 0; i < 2; i++) {          // 検索押下（最大2回）
      const done = await pressSearch(page);
      await page.waitForTimeout(1200);
      if (done) break;
    }

    await setPageSize50(page);             // 50件に（あれば）
    await page.waitForTimeout(1000);

    // 判定
    let hit = false;
    for (const ctx of [page, ...page.frames()]) {
      const html = await ctx.content();
      if (html.includes(KEYWORD)) { hit = true; break; }
    }
    console.log(hit ? 'HIT' : 'not found');

    console.log('URL:', page.url());
    try { console.log('TITLE:', await page.title()); } catch {}
    await page.screenshot({ path: 'out.png', fullPage: true });
  } catch (e) {
    console.error('ERROR', e);
    try { await page.screenshot({ path: 'out.png', fullPage: true }); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
