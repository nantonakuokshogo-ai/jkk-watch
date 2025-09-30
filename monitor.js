import { chromium } from 'playwright';

const START = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';
const KEYWORD = 'DK';

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

// ★ 中継ページ突破：「こちら」を確実に押す（メイン＋全フレーム・ログ付き）
async function passRelay(page) {
  console.log('[relay] start');
  const clickHereOn = async (ctx, label) => {
    const link = ctx.getByRole('link', { name: /こちら/ });
    if (await link.count()) {
      console.log(`[relay] click "${label}" -> こちら`);
      await Promise.all([
        ctx.waitForLoadState('domcontentloaded').catch(()=>{}),
        link.first().click({ timeout: 3000 })
      ]);
      return true;
    }
    return false;
  };

  // メイン
  if (await clickHereOn(page, 'main')) { await page.waitForTimeout(1200); return; }
  // フレーム
  for (const f of page.frames()) {
    if (await clickHereOn(f, `frame:${f.url()}`)) { await page.waitForTimeout(1200); return; }
  }

  // メタリフレッシュ（自動遷移）の待機も入れる
  console.log('[relay] no anchor found, wait a bit');
  await page.waitForTimeout(2000);
}

// 検索ボタン押下（メイン＋フレーム）
async function pressSearch(page) {
  const tryOn = async (ctx, desc) => {
    // 最優先で「検索」ボタン
    let btn = ctx.getByRole('button', { name: /^検索$/ });
    if (await btn.count()) {
      console.log(`[search] click (${desc}) "検索"`);
      await Promise.all([
        ctx.waitForLoadState('domcontentloaded').catch(()=>{}),
        btn.first().click({ timeout: 3000 })
      ]);
      return true;
    }
    // 予備：リンクや似たラベル
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
            ctx.waitForLoadState('domcontentloaded').catch(()=>{}),
            loc.first().click({ timeout: 3000 })
          ]);
          return true;
        } catch {}
      }
    }
    return false;
  };

  if (await tryOn(page, 'main')) return true;
  for (const f of page.frames()) { if (await tryOn(f, `frame:${f.url()}`)) return true; }
  return false;
}

// 一覧で「50件」を選択（あれば）
async function setPageSize50(page) {
  const tryOn = async (ctx, desc) => {
    const selects = ctx.locator('select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      try {
        await selects.nth(i).selectOption({ label: '50' });
        console.log(`[pagesize] set 50 on ${desc}`);
        const apply = ctx.getByRole('button', { name: /表示|再表示|検索|反映/ });
        if (await apply.count()) await apply.first().click().catch(()=>{});
        return true;
      } catch {}
    }
    return false;
  };
  if (await tryOn(page, 'main')) return true;
  for (const f of page.frames()) { if (await tryOn(f, `frame:${f.url()}`)) return true; }
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

    // ★ 中継ページを越える
    await passRelay(page);

    // ★ 検索を押す（2回まで試す）
    for (let i = 0; i < 2; i++) {
      const done = await pressSearch(page);
      await page.waitForTimeout(1200);
      if (done) break;
    }

    // ★ 一覧ページ想定：50件に（任意）
    await setPageSize50(page);
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
