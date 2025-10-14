// monitor.mjs — JKK: こだわり条件 → 住宅名（カナ）= コーシャハイム → 検索 → 一覧を保存 & 簡易検証
// クリックで見つからない場合でも、JKKねっと条件画面へ「直行フォールバック（Referer付き）」で入ります。

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ART = 'artifacts';
const ensure = async () => { await fs.mkdir(ART, { recursive: true }); };
const writeHtml = async (page, file) => { await fs.writeFile(path.join(ART, file), await page.content(), 'utf8'); };
const snap = async (page, file, opt = {}) => { await page.screenshot({ path: path.join(ART, file), fullPage: true, ...opt }); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 入口（DNSが安定な to-kousya 側を優先）
const LANDINGS = [
  'https://www.to-kousya.or.jp/chintai/index.html',
  'https://www.to-kousya.or.jp/chintai/',
  'https://www.to-kousya.or.jp/jkk/',
];

// 直行フォールバック（JKKねっと）— Referer が必要なことがある
const DIRECT_STARTS = [
  // 条件検索の典型エンドポイント
  'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit',
  'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaStartInit',
  'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenInitMobile',
  // 自動遷移ページ経由（forwardId パラメータ）
  'https://jhomes.to-kousya.or.jp/search/jkknet/wait.jsp?forwardId=akiyaJyoukenStartInit',
  'https://jhomes.to-kousya.or.jp/search/jkknet/wait.jsp?forwardId=akiyaStartInit',
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
    await sleep(300);
  }
  return (await locator.count().catch(()=>0)) > 0;
}

async function gotoLanding(page) {
  console.log('[step] goto landing (prefer to-kousya)');
  let lastErr;
  for (const u of LANDINGS) {
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(()=>{});
      await closeBanners(page);
      await snap(page, 'landing.png');
      await writeHtml(page, 'landing.html');
      return;
    } catch (e) {
      lastErr = e;
      console.warn('[landing fail]', u, e.message);
    }
  }
  throw lastErr || new Error('landing failed');
}

async function handleAutoRedirect(p) {
  // 「数秒後に自動で…表示されます」→「こちら」で進める
  const autoMsg = p.locator('text=/数秒後に自動で.*表示されます/');
  if (await autoMsg.count().catch(()=>0)) {
    const here = p.locator('text=こちら').first();
    await here.click({ timeout: 5000 }).catch(()=>{});
    await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
    await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
  }
}

async function openConditionsViaClick(page) {
  console.log('[step] open conditions by clicking (こだわり条件)');
  const queries = [
    () => page.getByRole('link',   { name: /こだわり.?条件|条件からさがす|条件から探す|JKK.?ねっと|お部屋.*検索/ }),
    () => page.getByRole('button', { name: /こだわり.?条件|条件からさがす|条件から探す/ }),
    () => page.locator('xpath=//*[contains(normalize-space(.),"こだわり") and contains(normalize-space(.),"条件")]//ancestor::a[1]'),
    () => page.locator('xpath=//*[contains(normalize-space(.),"こだわり") and contains(normalize-space(.),"条件")]//ancestor::button[1]'),
    () => page.locator('a[href*="jkknet"], a[href*="akiya"]'),
    () => page.locator('text=/こだわり.+条件/'),
  ];

  for (const q of queries) {
    const loc = q().first();
    await scrollHunt(page, loc).catch(()=>{});
    if (!(await loc.count().catch(()=>0))) continue;

    const popupWait = page.waitForEvent('popup', { timeout: 2500 }).catch(()=>null);
    await loc.click({ timeout: 4000 }).catch(()=>{});
    const popup = await popupWait;
    const target = popup ?? page;

    await handleAutoRedirect(target);
    await target.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
    await snap(target, 'popup_top.png');
    await writeHtml(target, 'popup_top.html');
    return target;
  }

  return null; // 見つからなかった
}

async function openConditionsDirect(context) {
  console.log('[step] open conditions by direct fallback (JKKnet)');
  const p = await context.newPage();
  let lastErr;
  for (const u of DIRECT_STARTS) {
    try {
      await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await handleAutoRedirect(p);
      await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
      await snap(p, 'popup_top.png');
      await writeHtml(p, 'popup_top.html');
      return p;
    } catch (e) {
      lastErr = e;
      console.warn('[direct fail]', u, e.message);
    }
  }
  throw lastErr || new Error('direct open failed');
}

async function fillKanaAndSearch(p) {
  console.log('[step] fill 住宅名（カナ） and search');

  // 入力欄（ラベル行→次のinput、name/placeholder にカナ等）
  let kana = p.locator('xpath=(//td[contains(normalize-space(.),"住宅名（カナ")]/following::input[@type="text"][1])[1]');
  if (!(await kana.count().catch(()=>0))) {
    kana = p.locator('xpath=(//input[@type="text"][contains(@name,"Kana") or contains(@placeholder,"カナ")])[1]');
  }
  if (!(await kana.count().catch(()=>0))) {
    await snap(p, 'jyouken_filled_html_error.png');
    await writeHtml(p, 'jyouken_filled_html_error.html');
    throw new Error('住宅名（カナ）の入力欄が見つかりませんでした');
  }

  await kana.fill('コーシャハイム', { timeout: 5000 });
  await snap(p, 'jyouken_filled.png');
  await writeHtml(p, 'jyouken_filled.html');

  // 検索ボタン（上段優先）
  let btn = p.locator('xpath=(//input[( @type="submit" or @type="button" or @type="image" ) and ( contains(@value,"検索") or contains(@alt,"検索") )])[1]');
  if (!(await btn.count().catch(()=>0))) {
    btn = p.locator('xpath=(//input[contains(@onclick,"search") or contains(@onclick,"kensaku") or contains(@onclick,"submit")])[1]');
  }
  if (!(await btn.count().catch(()=>0))) {
    await snap(p, 'last_page_fallback.png');
    await writeHtml(p, 'last_page_fallback.html');
    throw new Error('検索ボタンが見つかりませんでした');
  }

  await btn.click({ timeout: 5000 }).catch(()=>{});
  await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
  await p.locator('text=詳細').first().waitFor({ timeout: 7000 }).catch(()=>{});

  await snap(p, 'result_list.png');
  await writeHtml(p, 'result_list.html');

  const hits = await p.locator('text=コーシャハイム').count().catch(()=>0);
  console.log('[verify] result contains "コーシャハイム":', hits > 0);
}

async function main() {
  await ensure();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-web-security'],
  });

  // Referer を付けておく（直行フォールバック時に必要になることがある）
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    extraHTTPHeaders: { Referer: 'https://www.to-kousya.or.jp/chintai/index.html' },
  });

  const page = await ctx.newPage();

  try {
    await gotoLanding(page);

    // まずクリックで試みる → ダメなら直行
    const cond = (await openConditionsViaClick(page)) || (await openConditionsDirect(ctx));

    // 住宅名（カナ）入力 → 検索 → 一覧保存
    await fillKanaAndSearch(cond);

    console.log('[done] all steps finished');
  } catch (e) {
    console.error('[fatal]', e);
    try { await snap(page, 'last_page_fallback.png'); await writeHtml(page, 'last_page_fallback.html'); } catch {}
    process.exitCode = 1;
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main();
