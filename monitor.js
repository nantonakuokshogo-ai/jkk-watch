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

// ---- 中継ページ突破（こちら / meta refresh） ----
async function passRelay(page) {
  console.log('[relay] start');

  const absolutize = async (ctx, href) => {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    const baseUrl = ctx.url ? await ctx.url() : page.url();
    const base = new URL(baseUrl);
    return href.startsWith('/')
      ? `${base.origin}${href}`
      : `${base.origin}${base.pathname.replace(/\/[^/]*$/, '/')}${href}`;
  };

  const readHref = async (ctx, label) => {
    try {
      let href = await ctx.getByRole('link', { name: /こちら/ }).first().getAttribute('href').catch(() => null);
      if (!href) href = await ctx.locator('a', { hasText: 'こちら' }).first().getAttribute('href').catch(() => null);
      if (href && href !== '#') {
        let url = await absolutize(ctx, href);
        console.log(`[relay] goto from ${label}: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        return true;
      }
    } catch {}
    return false;
  };

  const readMetaRefresh = async (ctx, label) => {
    try {
      const html = await ctx.content();
      const m = html && html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>]+)/i);
      if (m && m[1]) {
        let url = await absolutize(ctx, m[1]);
        console.log(`[relay] meta refresh from ${label}: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        return true;
      }
    } catch {}
    return false;
  };

  // 1) メイン/フレームで href を探す
  if (await readHref(page, 'main')) { console.log('[relay] href (main) OK'); }
  else {
    let done = false;
    for (const f of page.frames()) {
      if (await readHref(f, `frame:${await f.url()}`)) { console.log('[relay] href (frame) OK'); done = true; break; }
    }
    // 2) 見つからなければ meta refresh
    if (!done) {
      if (await readMetaRefresh(page, 'main')) console.log('[relay] meta (main) OK');
      else {
        for (const f of page.frames()) {
          if (await readMetaRefresh(f, `frame:${await f.url()}`)) { console.log('[relay] meta (frame) OK'); break; }
        }
      }
    }
  }

  // 3) 最後に少し待って状況ログ
  await page.waitForTimeout(1500);
  console.log('[relay] after, URL:', page.url());
  for (const f of page.frames()) console.log('[relay] frame:', await f.url());
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
