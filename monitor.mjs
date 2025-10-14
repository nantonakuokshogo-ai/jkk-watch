// monitor.mjs
// Playwright で JKK東京の物件一覧に到達する決め打ちルート版
// 生成物: artifacts/landing.*, chintai_top.*, conditions_or_list.*(あれば), result_list.*(一覧)

import { chromium } from 'playwright';
import fs from 'fs/promises';

const ARTIFACTS_DIR = 'artifacts';
const SITE_ROOT = 'https://www.to-kousya.or.jp/';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}
async function save(page, base) {
  await ensureDir(ARTIFACTS_DIR);
  await fs.writeFile(`${ARTIFACTS_DIR}/${base}.html`, await page.content());
  await page.screenshot({ path: `${ARTIFACTS_DIR}/${base}.png`, fullPage: true });
  console.log(`[artifacts] saved: ${base}.html / ${base}.png`);
}
async function gotoWithRetries(page, url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`[goto] (${i}/${tries}) ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      return;
    } catch (e) {
      console.log(`[goto-retry] ${url} -> ${e.message}`);
      await page.waitForTimeout(i * 800);
    }
  }
  throw new Error(`page.goto failed: ${url}`);
}

async function closeOverlays(page) {
  // cookie同意バーやチャットの閉じるを可能な限り潰す
  const candidates = [
    'button:has-text("閉じる")',
    'button:has-text("同意")',
    'button:has-text("OK")',
    'text=閉じる',             // チャットの閉じる
    'role=button[name="閉じる"]'
  ];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.click({ timeout: 1500 });
        await page.waitForTimeout(300);
      }
    } catch {}
  }
  // 画面下部のクッキーバナー（テキストが長い場合の保険）
  try {
    const cookieBar = page.locator('text=/クッキー.*使用しています/').first();
    if (await cookieBar.count()) {
      const closeBtn = cookieBar.locator('text=閉じる').first();
      if (await closeBtn.count()) await closeBtn.click({ timeout: 1500 });
    }
  } catch {}
}

async function clickHeroConditions(page) {
  // ヒーローの「お部屋をえらぶ」枠の中だけで「こだわり条件」を探す（サイト内検索の誤クリックを回避）
  const hero = page.locator('section:has-text("お部屋をえらぶ")').first();
  if (!(await hero.count())) return false;

  const link = hero.locator('a:has-text("こだわり条件")').first();
  if (await link.count()) {
    console.log('[step] click hero "こだわり条件"');
    await link.click({ timeout: 4000 });
    await page.waitForLoadState('domcontentloaded');
    await closeOverlays(page);
    await save(page, 'conditions_or_list');
    return true;
  }
  return false;
}

async function gotoChintaiTop(page) {
  console.log('[step] goto 賃貸トップ (chintai/index.html)');
  await gotoWithRetries(page, new URL('/chintai/index.html', SITE_ROOT).toString());
  await closeOverlays(page);
  await save(page, 'chintai_top');
}

async function clickJkkListFromChintai(page) {
  // 「JKK東京ならではの物件」ブロックの「住宅一覧」を狙う
  const section = page.locator('section:has-text("JKK東京ならではの物件")').first();
  let link = section.locator('a:has-text("住宅一覧")').first();
  if (!(await link.count())) {
    // セクション構造が変わっていた場合の保険
    link = page.locator('a:has-text("住宅一覧")').first();
  }
  if (await link.count()) {
    console.log('[step] click "住宅一覧"');
    await link.click({ timeout: 4000 });
    await page.waitForLoadState('domcontentloaded');
    await closeOverlays(page);
    return true;
  }
  return false;
}

async function verifyAsList(page) {
  // 一覧っぽさの判定: 「住宅一覧絞り込む」や「物件詳細」等があればOK
  const markers = [
    'text=住宅一覧絞り込む',
    'text=物件詳細',
    'text=件中',
    'role=button[name=/物件詳細|問合せへ/]',
  ];
  for (const m of markers) {
    if (await page.locator(m).first().count()) return true;
  }
  // 404 ページ（「ページが見つかりません」）なら NG
  if (await page.locator('text=ページが見つかりません').first().count()) return false;
  // サイト内検索(result.html)に飛んでしまった場合も NG
  if (page.url().includes('/result.html')) return false;
  return false;
}

async function main() {
  await ensureDir(ARTIFACTS_DIR);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1600 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
  });
  const page = await context.newPage();

  try {
    console.log('[step] goto landing');
    await gotoWithRetries(page, SITE_ROOT);
    await closeOverlays(page);
    await save(page, 'landing');

    // 1) まずヒーローの「こだわり条件」を試す
    const clickedHero = await clickHeroConditions(page);

    // 2) それで一覧に行けない/行けなさそうなら、賃貸トップへ → 「住宅一覧」
    if (!clickedHero) {
      await gotoChintaiTop(page);
    } else {
      // もし「条件から検索」画面などに出たら、そのままでは一覧にならないので賃貸トップに切り替える
      const looksLikeList = await verifyAsList(page);
      if (!looksLikeList) {
        await gotoChintaiTop(page);
      }
    }

    // 賃貸トップから「住宅一覧」を踏む
    const ok = await clickJkkListFromChintai(page);
    if (!ok) throw new Error('「住宅一覧」リンクが見つかりませんでした');

    // 一覧確認 & 保存
    const isList = await verifyAsList(page);
    if (!isList) throw new Error('物件一覧に到達できませんでした');

    await save(page, 'result_list');
    console.log('[done] reached result_list');
  } catch (e) {
    console.error('[fatal]', e);
    // 最後のページだけでも退避
    await save(page, 'last_page_fallback');
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
