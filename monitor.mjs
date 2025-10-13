// monitor.mjs
// JKK: 「こだわり条件」→ 住宅名（カナ）に「コーシャハイム」→ 検索 → 一覧を保存 & 簡易検証
// 実行: `node monitor.mjs`

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ART_DIR = 'artifacts';
const ensureArtifacts = async () => {
  await fs.mkdir(ART_DIR, { recursive: true });
};
const saveHtml = async (page, file) => {
  await fs.writeFile(path.join(ART_DIR, file), await page.content(), 'utf8');
};
const snap = async (page, file, opts = {}) => {
  await page.screenshot({ path: path.join(ART_DIR, file), fullPage: true, ...opts });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** まずは都公社の公開サイト経由で到達する（DNS/リダイレクトが安定） */
const LANDING_CANDIDATES = [
  'https://www.to-kousya.or.jp/jkk/',
];

async function openLanding(page) {
  console.log('[step] goto landing (prefer to-kousya)');
  for (let i = 0; i < LANDING_CANDIDATES.length; i++) {
    try {
      await page.goto(LANDING_CANDIDATES[i], { waitUntil: 'domcontentloaded', timeout: 30000 });
      // 追加で安定化
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await snap(page, 'landing.png');
      await saveHtml(page, 'landing.html');
      return;
    } catch (e) {
      console.warn(`[landing] failed (${i + 1}/${LANDING_CANDIDATES.length}):`, e.message);
      if (i === LANDING_CANDIDATES.length - 1) throw e;
      await sleep(800);
    }
  }
}

/** “こだわり条件” を開く。ポップアップ想定だが、同一タブ遷移もフォールバック */
async function openConditions(page) {
  console.log('[step] open conditions (こだわり条件)');

  // クッキー通知の「閉じる」等がある場合のケア
  await page.locator('text=閉じる').first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('role=button[name="閉じる"]').first().click({ timeout: 2000 }).catch(() => {});

  // 画面内にある “こだわり条件” をできるだけ広く拾う
  const candidates = [
    // 黄色の大きいボタン
    'xpath=//a[contains(normalize-space(.),"こだわり条件")]',
    'xpath=//button[contains(normalize-space(.),"こだわり条件")]',
    // タイル（「JKK東京ならではの物件」配下）
    'xpath=//div[contains(@class,"card") or contains(@class,"panel") or contains(@class,"box")]//a[contains(.,"こだわり条件")]',
    // 役割で拾う
    'role=link[name=/こだわり条件/]',
    'role=button[name=/こだわり条件/]',
    // 万一のテキスト直指定
    'text=こだわり条件',
  ];

  /** ポップアップ（window.open）を待ちながらクリック。開かない場合は同一タブ遷移で扱う */
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      const [maybePopup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 3000 }).catch(() => null),
        el.click({ timeout: 3000 }).catch(() => null),
      ]);
      if (maybePopup) {
        await maybePopup.waitForLoadState('domcontentloaded').catch(()=>{});
        await snap(maybePopup, 'popup_top.png');
        await saveHtml(maybePopup, 'popup_top.html');
        return maybePopup;
      } else {
        // 同一タブ遷移の場合
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
        await snap(page, 'popup_top.png');
        await saveHtml(page, 'popup_top.html');
        return page;
      }
    }
  }

  throw new Error('こだわり条件のリンクが見つかりませんでした');
}

/** 住宅名（カナ）へ入力。入力直後のスクショを残す */
async function fillKanaAndCapture(popup) {
  console.log('[step] fill 住宅名（カナ）');

  // ラベル「住宅名（カナ」の直後の input を拾う（フォームが2段あるサイトにも対応）
  const kanaInput = popup.locator(
    // ラベルセルの直後にある input を最優先
    'xpath=(//td[contains(normalize-space(.),"住宅名（カナ")]/following::input[@type="text"][1])[1]'
  );
  const exists = await kanaInput.count().catch(() => 0);
  if (!exists) {
    // 代替：placeholder や name 属性で拾える場合
    const fallback = popup.locator('xpath=(//input[@type="text"][contains(@name,"Kana") or contains(@placeholder,"カナ")])[1]');
    if (!(await fallback.count().catch(() => 0))) {
      await snap(popup, 'jyouken_filled_html_error.png');
      await saveHtml(popup, 'jyouken_filled_html_error.html');
      throw new Error('住宅名（カナ）の入力欄が見つかりませんでした');
    }
    await fallback.fill('コーシャハイム', { timeout: 5000 });
  } else {
    await kanaInput.fill('コーシャハイム', { timeout: 5000 });
  }

  // 入力直後の証跡
  await snap(popup, 'jyouken_filled.png');
  await saveHtml(popup, 'jyouken_filled.html');
}

/** 上段の「検索する」を押して一覧へ。押した後の状態を保存し、簡易検証も行う */
async function searchAndCaptureResult(popup) {
  console.log('[step] click 検索する & wait result');

  // ボタンが複数あるため、「上段の検索する」を優先して拾う
  const searchBtn = popup.locator(
    'xpath=(//input[( @type="submit" or @type="button" ) and ( contains(@value,"検索") or contains(@alt,"検索") )])[1]'
  );

  if (!(await searchBtn.count().catch(() => 0))) {
    // 画像ボタン等の代替（onclick 内の関数名に search/kensaku が含まれるなど）
    const altBtn = popup.locator(
      'xpath=(//input[contains(@onclick,"search") or contains(@onclick,"kensaku")])[1]'
    );
    if (!(await altBtn.count().catch(() => 0))) {
      await snap(popup, 'last_page_fallback.png');
      await saveHtml(popup, 'last_page_fallback.html');
      throw new Error('検索ボタンが見つかりませんでした');
    }
    await altBtn.click({ timeout: 5000 });
  } else {
    await searchBtn.click({ timeout: 5000 });
  }

  // 遷移 or 再描画待ち
  await popup.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
  // 結果が表形式の場合、「詳細」ボタン（テキスト or alt）出現を待ってみる
  await popup
    .locator('text=詳細, xpath=//input[contains(@value,"詳細") or contains(@alt,"詳細")]')
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => {});

  await snap(popup, 'result_list.png');
  await saveHtml(popup, 'result_list.html');

  // 簡易検証：結果画面内に「コーシャハイム」の文字が見えるか
  const hitCount = await popup.locator('text=コーシャハイム').count().catch(() => 0);
  console.log('[verify] contains "コーシャハイム" in result:', hitCount > 0);
}

async function main() {
  await ensureArtifacts();

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-web-security', '--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    // 文字化け対策で日本語ロケール気味に
    locale: 'ja-JP',
  });
  const page = await context.newPage();

  // 何か起こった時にすぐ残す
  page.on('pageerror', async (err) => {
    console.error('[pageerror]', err);
    try { await snap(page, 'pageerror.png'); } catch {}
  });

  try {
    await openLanding(page);

    const popup = await openConditions(page);          // 新窓 or 同一タブ
    await fillKanaAndCapture(popup);                   // 「コーシャハイム」入力 & 証跡
    await searchAndCaptureResult(popup);               // 検索 → 一覧保存 & 簡易検証

    console.log('[done] all steps finished');
  } catch (e) {
    console.error('[fatal]', e);
    try {
      await snap(page, 'last_page_fallback.png');
      await saveHtml(page, 'last_page_fallback.html');
    } catch {}
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
