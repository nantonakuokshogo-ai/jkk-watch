// monitor.mjs
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const OUT = 'artifacts';
const JKK_TOP = 'https://www.to-kousya.or.jp/chintai/';

async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }
function ts() {
  const d = new Date();
  const z = n => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
}
async function save(page, name) {
  await ensureDir(OUT);
  const t = `${name}_${ts()}`;
  await fs.writeFile(path.join(OUT, `${t}.html`), await page.content(), { encoding: 'utf8' });
  await page.screenshot({ path: path.join(OUT, `${t}.png`), fullPage: true });
}

async function withTimeout(promise, ms, label) {
  let to;
  const timer = new Promise((_, rej) => (to = setTimeout(() => rej(new Error(`Timeout: ${label} (${ms}ms)`)), ms)));
  try { return await Promise.race([promise, timer]); }
  finally { clearTimeout(to); }
}

function isOwabiHtml(html) {
  return html.includes('JKKねっと：おわび') || html.includes('/search/jkknet/images/owabi');
}

async function runOnce() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
  });
  // 軽量化（速度＝タイムアウト対策）
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) return route.abort();
    route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(25_000);

  try {
    // 1) トップへ
    await withTimeout(page.goto(JKK_TOP, { waitUntil: 'domcontentloaded' }), 25_000, 'goto top');
    await save(page, 'landing');

    // 2) 「JKKねっと」クリック → ポップアップ捕捉（entry_referer → popup_top）
    const [popup] = await withTimeout(Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('link', { name: /JKKねっと/ }).click()
    ]), 20_000, 'open popup');

    await withTimeout(popup.waitForLoadState('domcontentloaded'), 20_000, 'popup load');
    await save(popup, 'entry_referer');

    // entry_referer が自動遷移して popup_top に到達するまで待機
    await withTimeout(popup.waitForURL(/\/search\/jkknet\/.*(top|search).*\.html/i), 20_000, 'redirect to popup_top');
    await save(popup, 'popup_top');

    // 「先着順あき家検索」へ（同一ウィンドウ遷移）
    // a要素のテキストが環境差分で揺れるため href 部分で取得
    const senchaku = popup.locator('a[href*="senchakujun"] , a:has-text("先着順あき家検索")').first();
    await withTimeout(Promise.all([
      popup.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      senchaku.click()
    ]), 20_000, 'go to search');

    // 3) フレーム(main)の検索フォームに「住宅名（カナ）」入力
    const main = await withTimeout(
      popup.waitForSelector('frame[name="main"]'), 20_000, 'wait main frame'
    );
    const frame = await popup.frame({ name: 'main' });
    if (!frame) throw new Error('main frame not found');

    // 大きいテキスト枠（住宅名（カナ））を特定：label 近辺 or 最初の text input 行
    // 画面が古いHTMLなので name 属性にフォールバック
    const kanaInput =
      frame.locator('input[type="text"]').first();

    await withTimeout(kanaInput.waitFor(), 10_000, 'kana input appear');
    await kanaInput.fill('コーシャハイム');
    await save(popup, 'jyouken_filled');

    // 4) 「検索する」クリック → 結果一覧へ
    const searchBtn = frame.getByRole('button', { name: /検索する/ }).first()
      .or(frame.locator('input[type="image"][alt="検索する"] , input[type="submit"][value*="検索"]'));

    await withTimeout(Promise.all([
      popup.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      searchBtn.click()
    ]), 25_000, 'submit search');

    // 5) 結果確認 & 保存
    const html = await popup.content();
    if (isOwabiHtml(html)) {
      await save(popup, 'owabi');
      throw new Error('Server returned "おわび" (session/route invalid).');
    }

    // “詳細” や 一覧テーブルを軽く確認
    await withTimeout(popup.locator('text=詳細').first().waitFor({ state: 'visible' }).catch(() => Promise.resolve()), 5_000, 'result probe');
    await save(popup, 'result_list');

    await browser.close();
    return { ok: true };
  } catch (e) {
    console.error('[ERROR]', e.message);
    await save(page, 'last_page_fallback');
    await browser.close();
    return { ok: false, error: e };
  }
}

(async () => {
  await ensureDir(OUT);
  // 最大2回まで自動リトライ（「おわび」対策）
  for (let i = 1; i <= 2; i++) {
    console.log(`--- attempt ${i} ---`);
    const res = await runOnce();
    if (res.ok) return;
    if (i === 2) process.exit(1);
    // 短いクールダウン
    await new Promise(r => setTimeout(r, 1500));
  }
})();
