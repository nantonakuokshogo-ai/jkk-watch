// monitor.mjs
// JKKトップ → 「こだわり条件」新タブ →（あれば）簡単に入力 → 検索 → 一覧を保存
// 失敗時はフォールバックで /chintai から一覧直行も試みる
import { chromium } from 'playwright';
import fs from 'fs/promises';

const ART_DIR = 'artifacts';
const SAVE = async (page, base) => {
  try {
    const html = await page.content();
    await fs.writeFile(`${ART_DIR}/${base}.html`, html);
  } catch {}
  try {
    await page.screenshot({ path: `${ART_DIR}/${base}.png`, fullPage: true });
  } catch {}
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 複数URLに順番アクセス（DNS不安定対策） */
async function gotoLanding(page) {
  console.log('[step] goto landing (prefer to-kousya)');
  const candidates = [
    'https://www.to-kousya.or.jp/jkk/',
    // 旧ドメイン（環境によってはDNS失敗するので後回し）
    'https://www.jkk-portal.jp/',
    'https://jkk-portal.jp/',
  ];

  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    for (let t = 1; t <= 3; t++) {
      try {
        console.log(`[goto] (${t}/3) ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        // cookieの下部バーが邪魔なら閉じる
        const closeCookie = page.locator('button:has-text("閉じる")').first();
        if (await closeCookie.isVisible().catch(() => false)) {
          await closeCookie.click({ timeout: 2000 }).catch(() => {});
        }
        await SAVE(page, 'landing');
        return;
      } catch (e) {
        console.log(`[goto-retry] ${url} -> ${e.message} (sleep ${t * 800}ms)`);
        await sleep(t * 800);
      }
    }
  }
  throw new Error('landingに到達できませんでした');
}

/** 「こだわり条件」を新タブで必ず開く（フォールバック付き） */
async function openConditions(page) {
  console.log('[step] open conditions (こだわり条件)');
  // 該当ブロックが画面に来るようにしておく
  const topSelect = page.locator('.bl_topSelect');
  await topSelect.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  try { await topSelect.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch {}

  // 正規の「こだわり条件」ボタン（target=_blank）
  const condLink = page.locator(
    'a.bl_topSelect_btn__cond:has(span:has-text("こだわり条件"))'
  );

  let condPage = null;
  try {
    [condPage] = await Promise.all([
      page.waitForEvent('popup', { timeout: 10000 }),
      condLink.first().click({ timeout: 5000 })
    ]);
  } catch {
    console.log('[retry] ヘッダーの「お部屋を検索」を試します');
  }

  // ヘッダー緑ボタンのフォールバック（同じく target=_blank）
  if (!condPage) {
    const headerSearch = page.locator('a.el_headerBtnGreen:has-text("お部屋を検索")');
    try {
      [condPage] = await Promise.all([
        page.waitForEvent('popup', { timeout: 8000 }),
        headerSearch.first().click({ timeout: 3000 })
      ]);
    } catch {}
  }

  if (!condPage) {
    throw new Error('こだわり条件のリンクが見つからない/新タブが開かない');
  }

  // 旧「数秒後に自動で遷移します」ページ対策：”こちら”リンクがあれば押す
  await condPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
  const here = condPage.locator('a:has-text("こちら")');
  if (await here.first().isVisible().catch(()=>false)) {
    await here.first().click({ timeout: 3000 }).catch(()=>{});
    await condPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
  }

  await SAVE(condPage, 'popup_top');
  return condPage;
}

/** /chintai に落ちた時は一覧直行リンクでポップアップを取る */
async function fallbackToDirectListIfOnChintai(page) {
  const onChintai = await page.locator('h1:has-text("JKK住宅")').first().isVisible().catch(()=>false);
  if (!onChintai) return null;

  console.log('[fallback] /chintai 上にいるので 直行リンクで一覧へ');
  const direct = page.locator('a[href*="akiyaJyokenDirect"], a[href*="akiyaJyokenDirectMobile"]');
  const canSee = await direct.first().isVisible().catch(()=>false);
  if (!canSee) return null;

  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10000 }),
    direct.first().click({ timeout: 5000 })
  ]);

  await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
  return popup;
}

/** 条件ページで軽く入力（存在すれば）→ 検索 */
async function fillAndSearch(condPage) {
  // 1) ざっくり「フリーワード」があれば何か入れる（存在チェック）
  const freeword = condPage.locator(
    'input[placeholder*="フリーワード" i], input[name*="free" i], input[id*="free" i]'
  ).first();
  if (await freeword.isVisible().catch(()=>false)) {
    await freeword.fill('公社'); // 軽いワード（任意）
  }

  // 2) よくある絞り込み（チェックがあれば入れる）…無ければスキップ
  const tryCheck = async (selector) => {
    const el = condPage.locator(selector).first();
    if (await el.isVisible().catch(()=>false)) {
      await el.check({ timeout: 1000 }).catch(()=>{});
    }
  };
  await tryCheck('input[type="checkbox"][value*="礼金" i]');
  await tryCheck('input[type="checkbox"][value*="更新料" i]');

  await SAVE(condPage, 'jyouken_filled');

  // 3) 検索ボタン押下（テキストで幅広く）
  //   - 「検索する」「この条件で検索」「物件を検索」などを拾う
  const searchBtn = condPage.locator(
    'button:has-text("検索"), a:has-text("検索")'
  ).first();

  let resultsPage = null;
  // 新タブで開く場合もあるので race
  try {
    [resultsPage] = await Promise.all([
      condPage.waitForEvent('popup', { timeout: 8000 }).catch(()=>null),
      searchBtn.click({ timeout: 5000 })
    ]);
  } catch {}

  if (!resultsPage) {
    // 同一タブ遷移のケース
    await condPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
    resultsPage = condPage;
  }

  return resultsPage;
}

async function main() {
  await fs.mkdir(ART_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 2000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
  });
  const page = await context.newPage();

  try {
    // 1) ランディングへ
    await gotoLanding(page);

    // 万一 /chintai に流れたらここで直行（ポップアップ）
    const direct = await fallbackToDirectListIfOnChintai(page);
    if (direct) {
      await SAVE(direct, 'result_list');
      await browser.close();
      return;
    }

    // 2) 「こだわり条件」を新タブで開く
    let condPage = null;
    try {
      condPage = await openConditions(page);
    } catch (e) {
      // ここで /chintai へ落ちてる可能性があるので最後の保険を再度試す
      const again = await fallbackToDirectListIfOnChintai(page);
      if (again) {
        await SAVE(again, 'result_list');
        await browser.close();
        return;
      }
      throw e;
    }

    // 3) 条件入力→検索
    const results = await fillAndSearch(condPage);

    // 4) 一覧保存（タイトルなど軽く検査）
    await SAVE(results, 'result_list');

  } catch (err) {
    console.error('[fatal]', err);
    // 最後のページを保存しておく
    try {
      const pages = context.pages();
      const last = pages[pages.length - 1];
      if (last) {
        await SAVE(last, 'last_page_fallback');
      }
    } catch {}
    process.exitCode = 1; // 失敗として終了（Artifactsはアップロードされます）
  } finally {
    await browser.close();
  }
}

main();
