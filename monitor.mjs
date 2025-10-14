// monitor.mjs
// Playwright で JKK東京 → こだわり条件 → 物件一覧 まで到達してスクショ/HTMLを保存
// ランナー: node >=18, playwright >=1.45
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ART = 'artifacts';
async function save(page, base, name) {
  const html = await page.content();
  await fs.writeFile(path.join(ART, `${name}.html`), html);
  await page.screenshot({ path: path.join(ART, `${name}.png`), fullPage: true });
  console.log(`[artifacts] saved: ${name}.html / ${name}.png`);
}

// 404判定（タイトル or 見出し）
async function isError404(page) {
  const title = await page.title();
  if (title.includes('ページが見つかりません')) return true;
  const h = await page.$('h1, h2');
  if (h) {
    const t = (await h.textContent())?.trim() || '';
    if (t.includes('ページが見つかりません')) return true;
  }
  return false;
}

// 画面下に被るUIを閉じる/隠す
async function clearOverlays(page) {
  // クッキー同意バー（「閉じる」ボタン）
  const cookieClose = await page.locator('text=閉じる').last();
  if (await cookieClose.count()) {
    try { await cookieClose.click({ timeout: 1000 }); } catch {}
  }
  // チャット（右下の問い合わせウィジェット）などをCSSで隠す
  await page.addStyleTag({ content: `
    [id*="mediatalk"], .cc-window, .cc-banner { z-index: 0 !important; }
    .fixed, [style*="position: fixed"] { pointer-events: none !important; }
  `});
}

// 安定クリック（見つかれば即クリック）
async function clickByTexts(page, texts, options = {}) {
  for (const txt of texts) {
    const loc = page.locator(`:is(a,button,div,span) :text("${txt}")`).first();
    if (await loc.count()) {
      await loc.scrollIntoViewIfNeeded().catch(()=>{});
      try { await loc.click({ timeout: 3000, ...options }); return true; } catch {}
    }
    const loc2 = page.locator(`:is(a,button):has-text("${txt}")`).first();
    if (await loc2.count()) {
      await loc2.scrollIntoViewIfNeeded().catch(()=>{});
      try { await loc2.click({ timeout: 3000, ...options }); return true; } catch {}
    }
  }
  return false;
}

// 汎用 goto（404やDNSを耐える）
async function gotoAny(page, urls, label, waitSel = 'body') {
  console.log(`[goto] ${label}`);
  for (const u of urls) {
    for (const t of [800, 1600, 2400]) {
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForSelector(waitSel, { timeout: 8000 }).catch(()=>{});
        await clearOverlays(page);
        if (!(await isError404(page))) {
          return true;
        }
        console.log(`[goto-retry] ${u} -> looks like 404, retrying...`);
      } catch (e) {
        console.log(`[goto-retry] ${u} -> ${e?.message?.slice(0,80) || e}`);
      }
      await page.waitForTimeout(t);
    }
  }
  return false;
}

// ランディング到達（/jkk/ を優先、複数候補）
async function gotoLanding(page) {
  const CANDIDATES = [
    'https://www.to-kousya.or.jp/jkk/',
    'https://www.to-kousya.or.jp/',
    'https://to-kousya.or.jp/jkk/',
    'https://to-kousya.or.jp/'
  ];
  const ok = await gotoAny(page, CANDIDATES, 'landing (prefer /jkk/)', 'body');
  await save(page, '', 'landing');
  if (!ok) throw new Error('ランディング到達に失敗（DNS/404）');
}

// 「こだわり条件」を開く（トップ→直接 / メニュー→賃貸住宅情報→こだわり）
async function openConditions(page) {
  console.log('[step] open conditions');

  // まずトップで直接「こだわり条件」を探す
  if (await clickByTexts(page, ['こだわり条件'])) {
    await page.waitForLoadState('domcontentloaded');
    await clearOverlays(page);
    // すぐ結果ページに行くサイト構成もあるので保存
    await save(page, '', 'conditions_or_list');
    if (!(await isError404(page))) return true;
  }

  // メニュー経由：住宅をお探しの方 → 賃貸住宅情報
  await clickByTexts(page, ['住宅をお探しの方']).catch(()=>{});
  const hitMenu = await clickByTexts(page, ['賃貸住宅情報']);
  if (!hitMenu) console.log('[info] メニュー直リンク失敗、/chintai/index.html に直行');
  if (!hitMenu) {
    await page.goto('https://www.to-kousya.or.jp/chintai/index.html', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
  }
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await clearOverlays(page);
  await save(page, '', 'chintai_top');

  // 賃貸トップ上で「こだわり条件」「条件から探す」「住宅一覧」などを順に試す
  const clicked =
    await clickByTexts(page, ['こだわり条件から探す','こだわり条件','条件から探す']) ||
    await clickByTexts(page, ['住宅一覧','住宅一覧をみる']);

  if (!clicked) throw new Error('こだわり条件のリンクが見つかりませんでした');
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await clearOverlays(page);
  await save(page, '', 'conditions_or_list');

  // 404 なら別ルート
  if (await isError404(page)) {
    console.log('[warn] 条件ページが404、別ルートを試します（検索や一覧へ）');
    // 検索 / 一覧に相当しそうなボタン文言を総当たり
    const ok2 =
      await clickByTexts(page, ['検索','検索する','この条件で検索する','物件を探す']) ||
      await clickByTexts(page, ['一覧','住宅一覧をみる','物件一覧']);
    if (!ok2) throw new Error('条件/一覧の遷移に失敗しました（404フォールバック）');
  }

  return true;
}

// 今いるページが一覧らしいか
async function looksLikeList(page) {
  const t = (await page.title()) || '';
  if (t.includes('JKK住宅') || t.includes('住宅一覧') || t.includes('検索結果')) return true;
  const hasCard = await page.locator('a:has-text("詳細")').count().catch(()=>0);
  if (hasCard > 0) return true;
  return false;
}

// 検索実行（フォームがあれば最低限で検索、なければそのまま一覧保存）
async function runSearchOrSaveList(page) {
  console.log('[step] run search or save list');
  await clearOverlays(page);

  // 既に一覧っぽければ保存
  if (await looksLikeList(page)) {
    await save(page, '', 'result_list');
    return true;
  }

  // よくあるボタン名を総当たり
  const pushed =
    await clickByTexts(page, ['検索','検索する','この条件で検索する','条件で探す']) ||
    await clickByTexts(page, ['絞り込みを実行','結果を見る']);
  if (pushed) {
    await page.waitForLoadState('domcontentloaded').catch(()=>{});
    await clearOverlays(page);
  }

  // もう一度判定
  if (await looksLikeList(page)) {
    await save(page, '', 'result_list');
    return true;
  }

  // ダメなら最終手段：JKK住宅の総合一覧へ
  await page.goto('https://www.to-kousya.or.jp/chintai/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
  await clearOverlays(page);
  await clickByTexts(page, ['住宅一覧','住宅一覧をみる','JKK住宅']).catch(()=>{});
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await clearOverlays(page);
  await save(page, '', 'maybe_list');

  if (!(await looksLikeList(page))) throw new Error('物件一覧に到達できませんでした');
  return true;
}

async function main() {
  await fs.mkdir(ART, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    console.log('[step] goto landing');
    await gotoLanding(page);

    await openConditions(page);

    await runSearchOrSaveList(page);

    console.log('[done] reached list');
  } catch (err) {
    console.error('[fatal]', err?.message || err);
    try { await save(page, '', 'last_page_fallback'); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
