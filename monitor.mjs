// monitor.mjs
import { chromium } from 'playwright';
import fs from 'fs/promises';

const WORD = process.env.JKK_WORD || 'コーシャハイム'; // 住宅名（カナ）に入れる検索ワード
const ART_DIR = 'artifacts';

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function savePage(page, base) {
  await ensureDir(ART_DIR);
  await fs.writeFile(`${ART_DIR}/${base}.html`, await page.content());
  await page.screenshot({ path: `${ART_DIR}/${base}.png`, fullPage: true });
  console.log(`[artifacts] saved: ${base}.html / ${base}.png`);
}

async function clickIfVisible(root, candidates, opts = {}) {
  for (const sel of candidates) {
    const loc = root.locator(sel).first();
    try {
      const count = await loc.count();
      if (count > 0 && await loc.isVisible()) {
        await loc.click(opts);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function fillIfVisible(root, candidates, value) {
  for (const sel of candidates) {
    const loc = root.locator(sel).first();
    try {
      const count = await loc.count();
      if (count > 0 && await loc.isVisible()) {
        await loc.fill(value);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    console.log('[step] goto landing');
    await page.goto('https://www.jkk-portal.jp/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await savePage(page, 'landing');

    // クッキーバナー等を閉じる（出ない時もある）
    await clickIfVisible(page, [
      'text=閉じる',
      'button:has-text("閉じる")',
      'role=button[name="閉じる"]',
    ]);

    console.log('[step] open conditions (こだわり条件)');
    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);

    // 「こだわり条件」クリック
    const opened =
      (await clickIfVisible(page, [
        'text=こだわり条件',
        'button:has-text("こだわり条件")',
        'role=button[name="こだわり条件"]',
        'a:has-text("こだわり条件")',
      ])) || false;

    if (!opened) {
      throw new Error('こだわり条件のクリックに失敗しました（セレクタ未一致）');
    }

    // ① popup か、② 同タブ遷移か、③ iframe 表示か —— いずれにも対応
    let condPage = await popupPromise;
    if (condPage) {
      console.log('[popup] captured new window');
      await condPage.waitForLoadState('domcontentloaded').catch(() => {});
    } else {
      // 同タブや遷移の場合
      console.log('[popup] not fired, fallback to current context pages / navigation');
      // 少し待って new page が増えていないか確認
      await page.waitForTimeout(1200);

      // 新しいページが開いているか確認
      const others = context.pages().filter(p => p !== page);
      condPage =
        others.find(p => /entry|popup|search|kodawari|jyouken|akiyake/i.test(p.url())) || page;

      // 何かしらの遷移が起きるまで軽く待機
      await condPage.waitForLoadState('domcontentloaded').catch(() => {});
    }

    // 条件画面の候補: そのまま or iframe 内
    // iframe を含むページ想定で、frameLocator を先に試す
    const roots = [condPage.frameLocator('iframe'), condPage];

    console.log('[step] try to locate "住宅名（カナ）" field and fill keyword');
    let filled = false;
    for (const root of roots) {
      // ラベル名ベース & 幅広い入力候補
      const textFieldSelectors = [
        // ARIA/ラベル系
        'input[aria-label*="住宅名"][aria-label*="カナ"]',
        'input[aria-label*="カナ"][aria-label*="住宅名"]',
        'role=textbox[name*="住宅名"][name*="カナ"]',
        // ラベルテキストでの関連（Playwright の getByRole の後方互換）
        'xpath=//label[contains(., "住宅名") and contains(., "カナ")]/following::input[1]',
        // 最後の手段：テキストボックスのうち先頭のもの（他フィールドが少ない前提）
        'input[type="text"]',
      ];

      try {
        filled = await fillIfVisible(root, textFieldSelectors, WORD);
        if (filled) {
          console.log(`[filled] 住宅名（カナ）に "${WORD}" を入力`);
          // 一応スクショ
          try {
            await savePage(condPage, 'jyouken_filled');
          } catch {}
          // 検索ボタンをクリック
          const clicked =
            (await clickIfVisible(root, [
              'text=検索する',
              'button:has-text("検索する")',
              'role=button[name="検索する"]',
              'input[type="submit"][value*="検索"]',
            ])) || false;

          if (!clicked) {
            console.warn('[warn] 検索ボタンが見つからず、代替クリック失敗');
          }
          break;
        }
      } catch (e) {
        // 別 root を試す
      }
    }

    if (!filled) {
      console.warn('[warn] 住宅名（カナ）入力に失敗（セレクタ未一致の可能性）');
      // それでも次へ進む（一覧に辿れるケースがある）
    }

    console.log('[step] wait for result list (any page/list view)');
    // 結果は同ウィンドウ or 別ウィンドウの可能性
    // 少し待ってページ候補を再取得
    await condPage.waitForTimeout(2000);

    // 一番それらしいページを選ぶ
    const pickResultPage = () => {
      const all = context.pages();
      // URL ヒューリスティック
      const byUrl =
        all.find(p => /result|list|kensaku|ichiran|akiyake/i.test(p.url())) ||
        all.find(p => /popup|search|kodawari/i.test(p.url()));
      return byUrl || condPage;
    };

    let resultPage = pickResultPage();
    await resultPage.waitForLoadState('domcontentloaded').catch(() => {});
    await resultPage.waitForLoadState('networkidle').catch(() => {});
    await savePage(resultPage, 'result_list');

    console.log('[done] finished without fatal errors');
    await browser.close();
  } catch (err) {
    console.error('[fatal]', err);
    try {
      // 何か残っていれば最後のページを保存
      const last = context.pages().at(-1);
      if (last) {
        await savePage(last, 'last_page_fallback');
      }
    } catch (_) {}
    await browser.close();
    process.exit(1);
  }
})();
