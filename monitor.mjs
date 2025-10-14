// monitor.mjs — JKK こだわり条件(住宅名カナ)に「コーシャハイム」を入れて検索 → 一覧を保存

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ART = 'artifacts';
const ensure = () => fs.mkdir(ART, { recursive: true });
const html = (p, f) => fs.writeFile(path.join(ART, f), p.content(), 'utf8');
const png = (p, f, opt = {}) => p.screenshot({ path: path.join(ART, f), fullPage: true, ...opt });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function closeBanners(page) {
  // クッキー/お知らせ系を可能な限り閉じる（失敗しても無視）
  const labels = [/閉じる/, /同意/, /OK/, /わかりました/];
  for (const re of labels) {
    await page.getByRole('button', { name: re }).first().click({ timeout: 1500 }).catch(()=>{});
    await page.locator(`text=${re.source}`).first().click({ timeout: 1500 }).catch(()=>{});
  }
}

async function scrollHunt(page, locator, max = 8) {
  // 要素を探しながら段階スクロール
  for (let i = 0; i < max; i++) {
    if (await locator.count().catch(()=>0)) return true;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await sleep(400);
  }
  return (await locator.count().catch(()=>0)) > 0;
}

async function gotoLanding(page) {
  console.log('[step] goto landing (prefer to-kousya)');
  const url = 'https://www.to-kousya.or.jp/jkk/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(()=>{});
  await closeBanners(page);
  await png(page, 'landing.png');
  await html(page, 'landing.html');
}

async function clickConditions(page) {
  console.log('[step] open conditions (こだわり条件)');

  // 候補セレクタ（幅広）
  const queries = [
    // 一番普通のリンク/ボタン
    () => page.getByRole('link',   { name: /こだわり.?条件/ }),
    () => page.getByRole('button', { name: /こだわり.?条件/ }),
    // テキストを含む要素→先祖のa/button
    () => page.locator('xpath=//*[contains(normalize-space(.),"こだわり") and contains(normalize-space(.),"条件")]//ancestor::a[1]'),
    () => page.locator('xpath=//*[contains(normalize-space(.),"こだわり") and contains(normalize-space(.),"条件")]//ancestor::button[1]'),
    // 直接テキスト
    () => page.locator('text=/こだわり.+条件/'),
  ];

  let found = null;
  for (const q of queries) {
    const loc = q().first();
    // 画面内に入れてから判定（遅延表示対策）
    await scrollHunt(page, loc).catch(()=>{});
    if (await loc.count().catch(()=>0)) { found = loc; break; }
  }

  if (!found) {
    await png(page, 'last_page_fallback.png');
    await html(page, 'last_page_fallback.html');
    throw new Error('こだわり条件のリンクが見つかりませんでした');
  }

  // 新タブ/同一タブどちらでもOKにする
  const popWait = page.waitForEvent('popup', { timeout: 2500 }).catch(()=>null);
  await found.click({ timeout: 4000 }).catch(()=>{});
  let target = await popWait;
  target = target ?? page;

  // 自動遷移のリファラページに来たら「こちら」を押す
  await handleAutoRedirect(target);

  await target.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
  await png(target, 'popup_top.png');
  await html(target, 'popup_top.html');

  return target;
}

async function handleAutoRedirect(p) {
  // 「数秒後に自動で…表示されます」「こちら」を検知
  const hint = p.locator('text=/数秒後に自動で.*表示されます/');
  if (await hint.count().catch(()=>0)) {
    const here = p.locator('text=こちら').first();
    await here.click({ timeout: 5000 }).catch(()=>{});
    await p.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(()=>{});
    await p.waitForLoadState('networkidle', { timeout: 12000 }).catch(()=>{});
  }
}

async function fillKanaAndSearch(p) {
  console.log('[step] fill 住宅名（カナ） and search');

  // 入力欄探し（表見出し→次のinput、name/placeholder にカナ）
  let kana = p.locator('xpath=(//td[contains(normalize-space(.),"住宅名（カナ")]/following::input[@type="text"][1])[1]');
  if (!(await kana.count().catch(()=>0))) {
    kana = p.locator('xpath=(//input[@type="text"][contains(@name,"Kana") or contains(@placeholder,"カナ")])[1]');
  }
  if (!(await kana.count().catch(()=>0))) {
    await png(p, 'jyouken_filled_html_error.png');
    await html(p, 'jyouken_filled_html_error.html');
    throw new Error('住宅名（カナ）の入力欄が見つかりませんでした');
  }

  await kana.fill('コーシャハイム', { timeout: 5000 });
  await png(p, 'jyouken_filled.png');
  await html(p, 'jyouken_filled.html');

  // 検索ボタン候補
  let btn = p.locator('xpath=(//input[( @type="submit" or @type="button" ) and ( contains(@value,"検索") or contains(@alt,"検索") )])[1]');
  if (!(await btn.count().catch(()=>0))) {
    btn = p.locator('xpath=(//input[contains(@onclick,"search") or contains(@onclick,"kensaku")])[1]');
  }
  if (!(await btn.count().catch(()=>0))) {
    await png(p, 'last_page_fallback.png');
    await html(p, 'last_page_fallback.html');
    throw new Error('検索ボタンが見つかりませんでした');
  }

  await btn.click({ timeout: 5000 }).catch(()=>{});
  await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
  // 結果の「詳細」などが見えたらOK（なくても続行）
  await p.locator('text=詳細').first().waitFor({ timeout: 7000 }).catch(()=>{});

  await png(p, 'result_list.png');
  await html(p, 'result_list.html');

  const hits = await p.locator('text=コーシャハイム').count().catch(()=>0);
  console.log('[verify] result contains "コーシャハイム":', hits > 0);
}

async function main() {
  await ensure();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-web-security'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ja-JP' });
  const page = await ctx.newPage();

  try {
    await gotoLanding(page);
    const cond = await clickConditions(page);
    await fillKanaAndSearch(cond);
    console.log('[done] all steps finished');
  } catch (e) {
    console.error('[fatal]', e);
    try { await png(page, 'last_page_fallback.png'); await html(page, 'last_page_fallback.html'); } catch {}
    process.exitCode = 1;
  } finally {
    await ctx.close(); await browser.close();
  }
}

main();
