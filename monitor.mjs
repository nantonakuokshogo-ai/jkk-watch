// monitor.mjs ーーー 全貼り用
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const OUT = 'artifacts';
const p = (...args) => console.log(...args);

async function save(page, name) {
  await fs.mkdir(OUT, { recursive: true });
  const html = await page.content();
  await fs.writeFile(path.join(OUT, `${name}.html`), html, 'utf8');
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  p(`[artifacts] saved: ${name}.html / ${name}.png`);
}

async function clickIf(page, selectorOrLocator, opts = {}) {
  const loc = typeof selectorOrLocator === 'string' ? page.locator(selectorOrLocator) : selectorOrLocator;
  if (await loc.count().catch(() => 0)) {
    try { await loc.first().click({ timeout: 2000, ...opts }); } catch {}
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // 1) トップへ
    p('[step] goto landing (prefer to-kousya)');
    await page.goto('https://www.to-kousya.or.jp/jkk/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // バナー系を軽く閉じる
    await clickIf(page, 'text=閉じる');                        // Cookie バナー
    await clickIf(page, '.cc-window .cc-dismiss');            // Cookieconsent 互換
    await clickIf(page, 'button:has-text("OK")');             // 予備
    await clickIf(page, 'iframe[title*="chat"], .mediataTalk'); // チャット系は無視（存在すればクリックでフォーカス外し）

    await save(page, 'landing');

    // 2) 「こだわり条件」は target=_blank → popup を待つ
    p('[step] open conditions (こだわり条件)');
    const condBtn = page.locator('a.bl_topSelect_btn__cond').first();
    await condBtn.waitFor({ timeout: 15000 });

    const [condPage] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      condBtn.click(),
    ]);

    // 3) 中継ページ（「数秒後に自動で…」）→ 本体フォームへ
    await condPage.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await save(condPage, 'last_page_fallback'); // 何が出ても記録しておく

    // 自動遷移を待つ。動かない時は「こちら」を押す
    try {
      await condPage.waitForURL(/akiyaJyouken|akiyaRef|akiya.*Init/i, { timeout: 15000 });
    } catch {
      await clickIf(condPage, 'a:has-text("こちら")');
      await condPage.waitForURL(/akiyaJyouken|akiyaRef|akiya.*Init/i, { timeout: 20000 });
    }

    // 4) 条件入力ページ（レガシー画面）
    // ある程度ロードが落ち着くのを待つ
    await condPage.waitForLoadState('domcontentloaded');
    await save(condPage, 'popup_top');

    // 例として、いくつか分かりやすい条件だけ入れて実行します
    // （ラベル名で取れるものは getByLabel を利用）
    try { await condPage.getByLabel('20年以内').check({ force: true }); } catch {}
    try { await condPage.getByLabel('単身入居可').check({ force: true }); } catch {}
    try { await condPage.getByLabel('エレベータ有').check({ force: true }); } catch {}
    try { await condPage.getByLabel('定期借家契約なし').check({ force: true }); } catch {}

    // 「優先募集種別」は一般申込を選択（存在しない場合は無視）
    try {
      await condPage.selectOption('select[name="akiyaInitRM.akiyaRefM.yusenBoshu"]', '5115-0000');
    } catch {}

    await save(condPage, 'jyouken_filled');

    // 5) 検索実行
    const searchBtn = condPage.locator('input[type="submit"][value*="検索"], button:has-text("検索")').first();
    if (await searchBtn.count()) {
      await Promise.all([
        condPage.waitForLoadState('domcontentloaded', { timeout: 30000 }),
        searchBtn.click({ timeout: 5000 }),
      ]);
    } else {
      // ボタンが取れなければ Enter で送信を試す
      await condPage.keyboard.press('Enter').catch(() => {});
      await condPage.waitForLoadState('domcontentloaded', { timeout: 30000 });
    }

    await save(condPage, 'result_list');
  } catch (err) {
    p('[fatal]', err?.message || err);
    try { await save(page, 'error_fallback'); } catch {}
    throw err;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
