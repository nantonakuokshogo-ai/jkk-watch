// monitor.mjs  — Puppeteer専用（Playwrightメソッド不使用）

import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const OUTDIR = 'out';
const HEADLESS = true;               // 必要なら false に
const NAV_TIMEOUT = 30000;           // 既定のナビ待ち
const POPUP_TIMEOUT = 20000;         // ポップアップ検出待ち

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function save(page, key) {
  const htmlPath = path.join(OUTDIR, `${key}.html`);
  const pngPath  = path.join(OUTDIR, `${key}.png`);
  try {
    const html = await page.content();
    await fs.writeFile(htmlPath, html, { encoding: 'utf8' });
  } catch {}
  try {
    await page.screenshot({ path: pngPath, fullPage: true });
  } catch {}
  console.log(`[saved] ${key}`);
}

async function goto(page, url, key) {
  console.log(`[goto] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await save(page, key);
}

function textIncludes(el, needle) {
  return (el.textContent || '').trim().includes(needle);
}

/**
 * 「こちら」をクリックしてポップアップ（JKKnet）を捕捉。
 * - まず onload の自動処理に任せて少し待つ
 * - 出なければ明示的に「こちら」をクリック
 * - browser.waitForTarget(opener === current) で新しいタブ/ウィンドウを捕捉
 * - それでも出なければ、元ページのナビゲーション継続を採用
 */
async function triggerRelayAndCatchPopup(browser, page) {
  // 1) onload 自動実行の猶予
  await page.waitForTimeout?.(600).catch(() => {}); // Puppeteerには waitForTimeout あり

  // 2) まだポップアップが無ければ「こちら」をクリック
  const beforeTargets = new Set(browser.targets());
  const clicked = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a'));
    const a = as.find(el => /こちら/.test((el.textContent || '').trim()));
    if (a) { a.click(); return true; }
    return false;
  });
  if (clicked) {
    // クリック反映待ち
    await page.waitForTimeout?.(200).catch(() => {});
  }

  // 3) 新規ターゲット（opener が現在の page）を待つ
  let popupTarget = null;
  try {
    popupTarget = await browser.waitForTarget(
      t => t.opener?.() === page.target() && !beforeTargets.has(t),
      { timeout: POPUP_TIMEOUT }
    );
  } catch { /* timeout */ }

  // 4) ポップアップが捕まったらその page を返す。無ければ現在の page を継続
  if (popupTarget) {
    const popupPage = await popupTarget.page();
    try { await popupPage.bringToFront(); } catch {}
    return popupPage;
  }
  return page;
}

async function main() {
  await ensureDir(OUTDIR);


  const browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    // GitHub Actions で安定させるおまじない
    args: ['--no-sandbox', '--disable-setuid-sandbox']
});

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    // ---- HOME 到達まで（エラーページでも保存） ----
    await goto(page, 'https://jhomes.to-kousya.or.jp/',                  'home_1');
    await save(page, 'home_1_after');
    await goto(page, 'https://jhomes.to-kousya.or.jp/search/jkknet/',    'home_2');
    await save(page, 'home_2_after');
    await goto(page, 'https://jhomes.to-kousya.or.jp/search/jkknet/index.html', 'home_3');
    await save(page, 'home_3_after');
    await goto(page, 'https://jhomes.to-kousya.or.jp/search/jkknet/service/',   'home_4');
    await save(page, 'home_4_after');

    // ---- StartInit に直接入る（frameset入口）----
    await goto(page, 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit', 'frameset_startinit');

    // ここで onload の open + submit によりポップアップが出る可能性あり。
    // 念のため「こちら」を明示クリックし、ポップアップ（または自身の遷移）を捕捉
    await save(page, 'after_relay_1');
    const active = await triggerRelayAndCatchPopup(browser, page);

    // ポップアップ側（または自身）での遷移完了待ち
    try {
      await active.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: POPUP_TIMEOUT }).catch(() => {});
      await active.waitForNetworkIdle?.({ idleTime: 800, timeout: 8000 }).catch(() => {});
    } catch {}

    await save(active, 'after_submit_main');

    // 最終状態も保存（どちらが生きていても）
    await save(active, 'final');

  } catch (err) {
    console.error(err);
    // 失敗スナップショット（可能なら）
    try {
      const pages = await (await puppeteer.connect).browser?.pages?.() ?? [];
      if (pages.length) await save(pages[0], 'final_error');
    } catch {}
    process.exitCode = 1;
  } finally {
    // 少し余裕を持ってから閉じる（ログ収集などのため）
    try { await new Promise(r => setTimeout(r, 300)); } catch {}
    await browser.close();
  }
}

main();
