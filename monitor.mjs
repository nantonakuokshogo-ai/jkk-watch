// monitor.mjs — JKK: 「こだわり条件」→ 住宅名（カナ）= コーシャハイム → 検索 → 一覧を保存 & 簡易検証
// 変更点: html() を async にして page.content() を await（ERR_INVALID_ARG_TYPE の修正）

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ART = 'artifacts';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ensure = async () => { await fs.mkdir(ART, { recursive: true }); };
const html = async (p, f) => { await fs.writeFile(path.join(ART, f), await p.content(), 'utf8'); };
const png  = async (p, f, opt = {}) => { await p.screenshot({ path: path.join(ART, f), fullPage: true, ...opt }); };

// ランディング（DNSが安定する入口）
const LANDINGS = [
  'https://www.to-kousya.or.jp/jkk/',
];

async function closeBanners(page) {
  const labels = [/閉じる/, /同意/, /OK/, /わかりました/, /承諾/];
  for (const re of labels) {
    await page.getByRole('button', { name: re }).first().click({ timeout: 1200 }).catch(()=>{});
    await page.locator(`text=${re.source}`).first().click({ timeout: 1200 }).catch(()=>{});
  }
}

async function scrollHunt(page, locator, max = 10) {
  for (let i = 0; i < max; i++) {
    if (await locator.count().catch(()=>0)) return true;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await sleep(350);
  }
  return (await locator.count().catch(()=>0)) > 0;
}

async function gotoLanding(page) {
  console.log('[step] goto landing (prefer to-kousya)');
  for (let i = 0; i < LANDINGS.length; i++) {
    try {
      await page.goto(LANDINGS[i], { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(()=>{});
      await closeBanners(page);
      await png(page, 'landing.png');
      await html(page, 'landing.html');
      return;
    } catch (e) {
      console.warn(`[landing fail ${i+1}/${LANDINGS.length}]`, e.message);
      if (i === LANDINGS.length - 1) throw e;
      await sleep(800);
    }
  }
}

async function handleAutoRedirect(p) {
  // 「数秒後に自動で…表示されます」→「こちら」をクリック
  const autoMsg = p.locator('text=/数秒後に自動で.*表示されます/');
  if (await autoMsg.count().catch(()=>0)) {
    const here = p.locator('text=こちら').first();
    await here.click({ timeout: 5000 }).catch(()=>{});
    await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
    await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
  }
}

async function clickConditions(page) {
  console.log('[step] open conditions (こだわり条件)');

  const queries = [
    // リンク/ボタン（名称ゆらぎ広め）
    () => page.getByRole('link',   { name: /こだわり.?条件|条件からさがす|条件から探す/ }),
    () => page.getByRole('button', { name: /こだわり.?条件|条件からさがす|条件から探す/ }),
    // テキスト → 先祖の a/button
    () => page.locator('xpath=//*[contains(normalize-space(.),"こだわり") and contains(normalize-space(.),"条件")]//ancestor::a[1]'),
    () => page.locator('xpath=//*[contains(normalize-space(.),"こだわり") and contains(normalize-space(.),"条件")]//ancestor::button[1]'),
    // その他の導線（“お部屋を検索”、“JKKねっと”、“先着順あき家”など）
    () => page.getByRole('link',   { name: /お部屋.*検索|JKK.?ねっと|先着順|あき家|空家/ }),
    () => page.locator('a[href*="jkknet"], a[href*="akiya"], a[href*="StartInit"]'),
    // 最後の保険：可視テキスト
    () => page.locator('text=/こだわり.+条件/'),
  ];

  let found = null;
  for (const q of queries) {
    const loc = q().first();
    await scrollHunt(page, loc).catch(()=>{});
    if (await loc.count().catch(()=>0)) { found = loc; break; }
  }

  if (!found) {
    await png(page, 'last_page_fallback.png');
    await html(page, 'last_page_fallback.html');
    throw new Error('こだわり条件のリンクが見つかりませんでした');
  }

  const popWait = page.waitForEvent('popup', { timeout: 2500 }).catch(()=>null);
  await found.click({ timeout: 4000 }).catch(()=>{});
  let target = await popWait;
  target = target ?? page;

  await handleAutoRedirect(target);
  await target.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
  await png(target, 'popup_top.png');
  await html(target, 'popup_top.html');

  return target;
}

async function fillKanaAndSearch(p) {
  console.log('[step] fill 住宅名（カナ） and search');

  // 入力欄（表見出し→次の input、name/placeholder にカナ）
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

  // 検索ボタン（上段優先）
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
    await ctx.close();
    await browser.close();
  }
}

main();
