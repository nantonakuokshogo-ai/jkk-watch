// monitor.mjs
import { chromium } from 'playwright';
import fs from 'fs/promises';

const ART_DIR = 'artifacts';
const URLS = {
  HOME: 'https://www.to-kousya.or.jp/',
  CHINTAI_TOP: 'https://www.to-kousya.or.jp/chintai/',
  RECO_LIST: 'https://www.to-kousya.or.jp/chintai/reco/index.html', // JKK住宅（一覧が安定）
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function saveHTML(page, name) {
  const html = await page.content(); // ← await を忘れると Promise が渡って落ちる
  await fs.writeFile(`${ART_DIR}/${name}.html`, html, 'utf8');
}

async function savePNG(page, name, fullPage = true) {
  await page.screenshot({ path: `${ART_DIR}/${name}.png`, fullPage });
}

async function saveArtifacts(page, base) {
  await Promise.all([ saveHTML(page, base), savePNG(page, base) ]);
}

/**
 * 404 判定：タイトルに「ページが見つかりません」が入っていたら 404（JKK 公式の 404）
 */
async function isJkk404(page) {
  const title = await page.title();
  return title.includes('ページが見つかりません');
}

/**
 * Cookie バナー「閉じる」などを片付ける（出てなければスルー）
 */
async function dismissBanners(page) {
  // 公式サイト下部の Cookie バナー（"閉じる" ボタン）
  const cookieBtn = page.getByRole('button', { name: '閉じる' });
  if (await cookieBtn.isVisible().catch(() => false)) {
    await cookieBtn.click().catch(() => {});
  }

  // “ポップアップが一瞬重なる”系に少し猶予
  await wait(300);
}

/**
 * 安定着地：JKK住宅の一覧（reco）を開く
 */
async function gotoRecoList(page) {
  console.log('[step] goto JKK住宅（reco list）');
  await page.goto(URLS.RECO_LIST, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await dismissBanners(page);

  // 物件カードに出てくるボタン類（例：「物件ページへ」「間取り一覧」など）を待つ
  // 文言変更に備えて "ページへ" を含むリンクでも待つ
  const anyCardLink = page.locator('a:has-text("物件ページ")').first()
    .or(page.locator('a:has-text("間取り")').first())
    .or(page.locator('a:has-text("ページへ")').first());

  await anyCardLink.waitFor({ timeout: 15_000 }).catch(() => {});
  await saveArtifacts(page, 'result_list');
}

/**
 * まずは TOP -> もし 404 っぽければ 賃貸TOP -> それでもダメなら reco 直行
 */
async function gotoLandingWithFallbacks(page) {
  console.log('[step] goto landing');
  const candidates = [
    URLS.HOME,
    URLS.CHINTAI_TOP,
  ];

  for (const url of candidates) {
    console.log(`[goto] ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await dismissBanners(page);
    if (!(await isJkk404(page))) {
      await saveArtifacts(page, url === URLS.HOME ? 'landing' : 'chintai_top');
      return true; // 正常着地
    }
    console.log(`[warn] 404 detected at ${url}`);
    await saveArtifacts(page, 'last_page_fallback'); // 404 の証跡を残す
  }

  // ここまで来たら、直接 reco へ（最後の砦）
  return false;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--lang=ja-JP'],
  });
  const ctx = await browser.newContext({
    locale: 'ja-JP',
    viewport: { width: 1280, height: 2000 },
  });
  const page = await ctx.newPage();

  try {
    // 1) ランディング（404 を踏んだら証跡だけ残して次へ）
    const landed = await gotoLandingWithFallbacks(page);

    // 2) 一覧（必ずここで成果物を作る）
    await gotoRecoList(page);

    // 3) ここから先：条件入力（こだわり等）は次ステップで拡張する想定
    //    - 安定稼働の土台（毎回 artifacts を残す）を先に固める

  } catch (e) {
    console.error('[fatal]', e);
    // 何かあっても最後に現状を残す
    try { await saveArtifacts(page, 'last_page_fallback'); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
