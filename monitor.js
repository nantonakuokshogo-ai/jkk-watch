import { chromium } from 'playwright';

const START = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';
const KEYWORD = 'DK'; // ←まずは確実に出る語でテスト。OKなら本命に置き換え。

async function notify(msg) {
  const token = process.env.LINE_NOTIFY_TOKEN;
  if (!token) { console.log('[NOTIFY]', msg); return; }
  const res = await fetch('https://notify-api.line.me/api/notify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message: msg }).toString()
  });
  console.log('LINE status', res.status);
}

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

async function clickCandidates(ctx) {
  const roles = [
    ['link',   /空き|検索|次へ|同意|OK/i],
    ['button', /空き|検索|次へ|同意|OK/i],
  ];
  for (const [role, name] of roles) {
    const loc = ctx.getByRole(role, { name });
    if (await loc.count()) { try { await loc.first().click({ timeout: 2000 }); } catch {} }
  }
  // service配下のa[href]も少し試す
  const anchors = ctx.locator('a[href]');
  const n = await anchors.count();
  for (let i = 0; i < Math.min(n, 20); i++) {
    const href = await anchors.nth(i).getAttribute('href');
    if (href && href !== '#' && /\/search\/jkknet\/service\//i.test(href)) {
      try { await anchors.nth(i).click({ timeout: 2000 }); break; } catch {}
    }
  }
}

async function setPageSize50(ctx) {
  const selects = ctx.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    try {
      await selects.nth(i).selectOption({ label: '50' });
      const apply = ctx.getByRole('button', { name: /表示|再表示|検索|反映/i });
      if (await apply.count()) await apply.first().click().catch(()=>{});
      return;
    } catch {}
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36'
  });

  try {
    const ok = await gotoWithRetry(page, START);
    if (!ok) throw new Error('cannot open START');

    // 入口→（同意/検索など）→次ページを数回試す（フレームも対象）
    for (let step = 0; step < 3; step++) {
      const ctxs = [page, ...page.frames()];
      for (const ctx of ctxs) await clickCandidates(ctx);
      await page.waitForTimeout(1200);
    }

    // 一覧想定で「50件」を試す
    {
      const ctxs = [page, ...page.frames()];
      for (const ctx of ctxs) await setPageSize50(ctx);
      await page.waitForTimeout(1000);
    }

    // キーワード検出（全フレーム対象）
    let hit = false;
    for (const ctx of [page, ...page.frames()]) {
      const html = await ctx.content();
      if (html.includes(KEYWORD)) { hit = true; break; }
    }

    if (hit) await notify(`【JKK】"${KEYWORD}" を検出しました。`);
    else console.log('not found');

    console.log('URL:', page.url());
    try { console.log('TITLE:', await page.title()); } catch {}
    await page.screenshot({ path: 'out.png', fullPage: true });
  } catch (e) {
    console.error('ERROR', e);
    await notify(`【JKK】監視エラー: ${e}`);
    try { await page.screenshot({ path: 'out.png', fullPage: true }); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
