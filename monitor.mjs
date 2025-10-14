// monitor.mjs
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const OUTDIR = 'artifacts';
const SLOWMO = process.env.SLOWMO ? Number(process.env.SLOWMO) : 0;

async function save(page, base) {
  const html = await page.content(); // ← Promiseをawaitして中身を渡す
  await fs.mkdir(OUTDIR, { recursive: true });
  await fs.writeFile(`${OUTDIR}/${base}.html`, html);
  await page.screenshot({ path: `${OUTDIR}/${base}.png`, fullPage: true });
}

async function closeOverlays(page) {
  // クッキーバナー
  const cookieClose = page.getByRole('button', { name: /閉じる|同意|OK/i }).first();
  if (await cookieClose.isVisible().catch(() => false)) await cookieClose.click().catch(() => {});
  // 下部のチャット／バナー類を片付け（クリックの邪魔をしがち）
  await page.evaluate(() => {
    for (const sel of [
      '#chatplusview',                           // よくあるチャット
      '[id*="MediaTalk"]', '[class*="MediaTalk"]',
      'div[role="dialog"]',
      '.cookie', '.cookies', '[class*="cookie"]',
      '[class*="banner"]', '[id*="banner"]',
      'iframe'
    ]) {
      document.querySelectorAll(sel).forEach(el => {
        try { el.style.pointerEvents = 'none'; el.style.display = 'none'; } catch {}
      });
    }
  }).catch(() => {});
}

async function gotoLanding(page) {
  // 総合トップに入る（失敗時は賃貸トップにフォールバック）
  const tried = [
    'https://www.to-kousya.or.jp/',
    'https://www.to-kousya.or.jp/chintai/index.html',
  ];
  for (const url of tried) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await closeOverlays(page);
      await save(page, 'landing');
      return;
    } catch (e) {
      // 次のURLへ
    }
  }
  throw new Error('トップページへの遷移に失敗しました');
}

/** 文字を頼りにクリック。role/label/text/contains など複数パターンで当てに行く */
async function clickByTextRobust(page, text) {
  const trials = [
    () => page.getByRole('button', { name: new RegExp(text) }),
    () => page.getByRole('link',   { name: new RegExp(text) }),
    () => page.getByLabel(new RegExp(text)),
    () => page.locator(`text=${text}`),
    () => page.locator(`:is(button,a,div,span,label) :text("${text}")`).first(),
  ];
  for (const make of trials) {
    const loc = make();
    try {
      await loc.first().scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      if (await loc.first().isVisible({ timeout: 1500 }).catch(() => false)) {
        await loc.first().click({ timeout: 2000 }).catch(async () => {
          // 被り物があれば強行
          await loc.first().click({ timeout: 2000, force: true });
        });
        return true;
      }
    } catch { /* 次へ */ }
  }
  return false;
}

/** こだわり条件 → 条件検索画面へ。複数ルートで到達を試みる */
async function openConditions(page) {
  // まずはそのまま「こだわり条件」を叩く
  if (await clickByTextRobust(page, 'こだわり条件')) {
    // 遷移待ち
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await closeOverlays(page);
    // 条件画面らしき文字（先着順あき家検索 / 条件から検索 等）を確認
    const ok = await Promise.race([
      page.waitForSelector('text=先着順あき家検索', { timeout: 6000 }).then(() => true).catch(() => false),
      page.waitForSelector('text=条件から検索',     { timeout: 6000 }).then(() => true).catch(() => false),
    ]);
    await save(page, 'conditions_or_list');
    if (ok) return true;
  }

  // メニュー経由（「住宅をお探しの方」→ 賃貸住宅情報TOP）
  const menuOpened =
    (await clickByTextRobust(page, '住宅をお探しの方')) ||
    (await clickByTextRobust(page, '賃貸住宅情報'));
  if (menuOpened) {
    await clickByTextRobust(page, '賃貸住宅情報トップ').catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await closeOverlays(page);
    await save(page, 'chintai_top');
    // ここから「こだわり」「条件から探す」などを再トライ
    if (await clickByTextRobust(page, 'こだわり条件') || await clickByTextRobust(page, '条件から探す') || await clickByTextRobust(page, '条件から検索')) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await closeOverlays(page);
      await save(page, 'conditions_or_list');
      return true;
    }
  }

  // 最後の手：ページ内のリンク文字から条件検索っぽいものを拾う
  const anchors = await page.locator('a').allTextContents().catch(() => []);
  const hit = anchors.find(t => /条件.*(検索|探す)|先着順あき家|詳細検索/.test(t));
  if (hit) {
    await clickByTextRobust(page, hit);
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await closeOverlays(page);
    await save(page, 'conditions_or_list');
    return true;
  }

  throw new Error('こだわり条件のリンクが見つかりませんでした');
}

/** 条件画面で “そのまま検索”（こだわらない）→ 物件一覧へ */
async function submitSimpleSearch(page) {
  // 画面全文から「検索」ボタンっぽい要素を探す
  const tried =
    (await clickByTextRobust(page, '検索')) ||
    (await clickByTextRobust(page, 'この条件で探す')) ||
    (await clickByTextRobust(page, '表示')) ||
    (await clickByTextRobust(page, '検索する'));

  if (!tried) {
    // ボタンが見つからなければフォーム submit を強行
    await page.evaluate(() => {
      const f = document.querySelector('form');
      if (f) f.submit();
    }).catch(() => {});
  }

  // 一覧の到着確認（「件」「一覧」「結果」など）
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await closeOverlays(page);

  const arrived = await Promise.race([
    page.waitForSelector('text=件',     { timeout: 8000 }).then(() => true).catch(() => false),
    page.waitForSelector('text=一覧',   { timeout: 8000 }).then(() => true).catch(() => false),
    page.waitForSelector('text=結果',   { timeout: 8000 }).then(() => true).catch(() => false),
    page.waitForSelector('img',         { timeout: 8000 }).then(() => true).catch(() => false),
  ]);

  await save(page, arrived ? 'result_list' : 'last_page_fallback');
  if (!arrived) throw new Error('物件一覧に到達できませんでした');
}

async function main() {
  console.log('[step] goto landing (prefer to-kousya)');
  const browser = await chromium.launch({ headless: true, slowMo: SLOWMO });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();

  try {
    await gotoLanding(page);

    console.log('[step] open conditions (こだわり条件)');
    await openConditions(page);

    console.log('[step] submit simple search (こだわらないで検索)');
    await submitSimpleSearch(page);

    console.log('[done] reached result list');
  } catch (e) {
    console.error('[fatal]', e);
    // 最後の状態も保存
    try { await save(page, 'last_page_fallback'); } catch {}
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
