// monitor.mjs
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = process.env.ARTIFACT_DIR || 'artifacts';
const NOW = new Date().toISOString().replace(/[:.]/g, '-');

const step = (label) => {
  const t = new Date().toISOString();
  console.log(`[${t}] ${label}`);
};

const savePage = async (page, name) => {
  const base = path.join(OUT, `${name}`);
  await fs.mkdir(OUT, { recursive: true }).catch(() => {});
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  await fs.writeFile(`${base}.html`, await page.content()).catch(() => {});
};

const ABORT_PATTERNS = [
  'googletagmanager.com', 'google-analytics.com', 'doubleclick.net',
  'analytics.tiktok.com', 'connect.facebook.net', 'cdn.smartnews-ads.com',
  'js.fout.jp', 's.yimg.jp', 'static.ads-twitter.com', 'cdn.microad.jp'
];

// 個別操作タイムアウト（ミリ秒）
const T = {
  nav: 25_000,
  tiny: 5_000,
  short: 8_000,
  mid: 12_000
};

// 全体強制タイムアウト（念のため）
const hardKill = setTimeout(() => {
  console.error('Hard timeout reached. Exiting with code 2.');
  process.exit(2);
}, 5 * 60 * 1000);

(async () => {
  // 失敗時のトレースを必ず残す
  await fs.mkdir(OUT, { recursive: true }).catch(() => {});
  const tracePath = 'trace.zip';

  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36'
  });

  // 軽量化：解析タグ・広告は全部キャンセル
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (ABORT_PATTERNS.some((d) => url.includes(d))) return route.abort();
    route.continue();
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();

  try {
    // 1) トップへ
    step('Goto: /chintai/');
    await page.goto('https://www.to-kousya.or.jp/chintai/', { waitUntil: 'domcontentloaded', timeout: T.nav });
    await savePage(page, `landing_${NOW}`);

    // クッキーバナー「閉じる」が出ることがあるので閉じる（無ければ無視）
    const cookieClose = page.locator('text=閉じる');
    if (await cookieClose.first().isVisible({ timeout: 1000 }).catch(() => false)) {
      step('Close cookie banner');
      await cookieClose.first().click({ timeout: T.tiny }).catch(() => {});
    }

    // 2) 「こだわり条件」→ 旧サイトのポップアップを待つ
    step('Open 条件検索 popup');
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: T.mid }),
      page.getByRole('link', { name: /こだわり条件/ }).click({ timeout: T.short })
    ]);

    await popup.waitForLoadState('domcontentloaded', { timeout: T.nav });
    await savePage(popup, `popup_top_${NOW}`);

    // 3) 条件入力フレームへ（ページがフレーム構成なので総当たりで探す）
    step('Find 条件入力 frame');
    const findConditionFrame = async () => {
      for (const f of popup.frames()) {
        const body = await f.evaluate(() => document.body?.innerText || '');
        if (/先着順あき家検索/.test(body)) return f;
        if (/住宅名/.test(body) && /カナ/.test(body)) return f;
      }
      return null;
    };

    let cond = await findConditionFrame();
    // もしトップで「検索方法」だけ等が表示されている場合、検索本体へのリンクをクリックしてから再検出
    if (!cond) {
      const anySearchLink = popup.getByRole('link', { name: /検索|先着|条件|あき家/ });
      if (await anySearchLink.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        await anySearchLink.first().click({ timeout: T.short }).catch(() => {});
        await popup.waitForLoadState('domcontentloaded', { timeout: T.mid }).catch(() => {});
      }
      cond = await findConditionFrame();
    }

    if (!cond) throw new Error('条件入力フレームが見つかりませんでした');

    await savePage(popup, `jyouken_page_${NOW}`);

    // 4) 「住宅名（カナ）」に 'コーシャハイム' を入力して検索
    step('Fill 住宅名(カナ) and search');

    // ラベルの直後の input を Xpath で頑強に取得（name 属性が安定していないため）
    const kanaInput = cond.locator(
      'xpath=//*[contains(normalize-space(.),"住宅名") and contains(normalize-space(.),"カナ")]/following::input[1]'
    );

    await kanaInput.fill('コーシャハイム', { timeout: T.mid });
    await savePage(popup, `jyouken_filled_${NOW}`);

    // 「検索する」ボタン押下（テキスト or 画像ボタン両対応）
    const searchBtn =
      cond.getByRole('button', { name: /検索/ }).first() ||
      cond.getByRole('link', { name: /検索/ }).first() ||
      cond.locator('input[type="submit"], input[type="image"]').first();

    await Promise.all([
      popup.waitForLoadState('domcontentloaded', { timeout: T.nav }),
      searchBtn.click({ timeout: T.short })
    ]);

    // 5) 結果一覧ページ（先着順あき家検索の表）を撮る
    step('Capture result list');
    // ページorフレームどちらにも出る可能性があるので広めに探索
    let resultFrame = null;
    for (const f of popup.frames()) {
      const body = await f.evaluate(() => document.body?.innerText || '');
      if (/先着順あき家検索/.test(body) && /詳細/.test(body)) {
        resultFrame = f;
        break;
      }
    }
    if (resultFrame) {
      await savePage(resultFrame, `result_list_${NOW}`);
    } else {
      await savePage(popup, `result_list_${NOW}`); // 直下に出た場合
    }

    step('Done');

  } catch (e) {
    console.error('ERROR:', e);
    await savePage(page, `last_page_fallback_${NOW}`).catch(() => {});
    await savePage(page, `last_page_fallback2_${Date.now()}`).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.tracing.stop({ path: 'trace.zip' }).catch(() => {});
    await browser.close().catch(() => {});
    clearTimeout(hardKill);
  }
})();
