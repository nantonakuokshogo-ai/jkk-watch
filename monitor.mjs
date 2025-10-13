// monitor.mjs
import { chromium } from 'playwright';

const HEADLESS = process.env.CI ? true : false;
const TIMEOUT = 15_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  // 1) 賃貸トップへ
  await page.goto('https://www.to-kousya.or.jp/chintai/index.html', { waitUntil: 'domcontentloaded' });

  // Cookie バナー等が出ていれば閉じる（任意）
  const closeBanner = page.locator('text=閉じる').first();
  if (await closeBanner.isVisible({ timeout: 2000 }).catch(() => false)) {
    await closeBanner.click().catch(() => {});
  }

  // 2) 「お部屋を検索」→ ここでポップアップ(JKKnet)が開く
  // PC と SP でリンクが異なるため両方対応
  const searchLink = page.locator('a:has-text("お部屋を検索")').first();

  const [jkknet] = await Promise.all([
    page.waitForEvent('popup', { timeout: TIMEOUT }),  // ★これが重要
    searchLink.click()
  ]);

  // 3) JKKnet 側の自動遷移（wait.jsp → StartInit → 条件画面）を待つ
  await jkknet.waitForLoadState('domcontentloaded', { timeout: TIMEOUT });

  // wait.jsp からの自動遷移に備える
  try {
    await jkknet.waitForURL(
      /akiyaJyouken(StartInit|InitMobile|JyoukenInit)/,
      { timeout: TIMEOUT }
    );
  } catch {
    // まだ wait.jsp なら “こちら” をクリックして前進（保険）
    const here = jkknet.locator('a', { hasText: 'こちら' });
    if (await here.isVisible().catch(() => false)) {
      await Promise.all([
        jkknet.waitForURL(/akiyaJyouken(StartInit|InitMobile|JyoukenInit)/, { timeout: TIMEOUT }),
        here.click()
      ]);
    }
  }

  // 条件フォームが描画されるまで待機（ページ名は「先着順あき家検索」）
  await jkknet.waitForSelector('text=先着順あき家検索', { timeout: TIMEOUT });

  // 4) 「住宅名（カナ）」に 'コーシャハイム' を入力
  // ラベルの直後の input を取る（テーブル/属性が変わっても強い）
  const kanaInput = jkknet.locator('xpath=//td[contains(normalize-space(.),"住宅名（カナ）")]/following::input[1]');
  await kanaInput.waitFor({ state: 'visible', timeout: TIMEOUT });
  await kanaInput.fill('コーシャハイム');

  // 5) 上の「検索する」ボタンをクリック
  const searchBtn = jkknet.getByRole('button', { name: '検索する' }).first();
  await Promise.all([
    jkknet.waitForLoadState('domcontentloaded'),
    searchBtn.click()
  ]);

  // 6) 一覧到着の判定（見出し/「詳細」ボタン/結果テーブルのどれか）
  await Promise.race([
    jkknet.waitForSelector('text=先着順あき家検索', { timeout: TIMEOUT }), // 画面タイトルが共通の場合でも保険
    jkknet.waitForSelector('a:has-text("詳細"), button:has-text("詳細")', { timeout: TIMEOUT }),
    jkknet.waitForSelector('table >> nth=0', { timeout: TIMEOUT })
  ]);

  // 7) スクショ保存
  await jkknet.screenshot({ path: 'artifacts/result_list.png', fullPage: true });
  await page.screenshot({ path: 'artifacts/landing.png', fullPage: true });

  await browser.close();
  console.log('DONE');
})();
