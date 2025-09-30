/**
 * monitor.js (ESM / Puppeteer v22+ 対応・安全版)
 * - waitForTimeout 廃止 → sleep() に置換
 * - 画面遷移の各段階で HTML / PNG を out/ 配下に保存
 * - 「おわび」「タイムアウト」などのページを検知してリカバリ
 * - frameset / main フレーム内の「こちら」をクリック
 * - 必要に応じて form.submit() を強制実行
 *
 * 成果物例:
 *   out/_home_.html/.png
 *   out/_frameset_.html/.png
 *   out/_after_relay_.html/.png
 *   out/_after_submit_.html/.png
 *   out/_final_.html/.png
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

// -----------------------------
// 基本設定
// -----------------------------
const OUT_DIR = path.resolve(process.cwd(), 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const HOME_STEPS = [
  'https://jhomes.to-kousya.or.jp/',
  'https://jhomes.to-kousya.or.jp/search/jkknet/',
  'https://jhomes.to-kousya.or.jp/search/jkknet/index.html',
  'https://jhomes.to-kousya.or.jp/search/jkknet/service/',
];

const START_INIT =
  'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';

// -----------------------------
// 共通ユーティリティ
// -----------------------------
async function save(page, name) {
  const html = await page.content();
  const htmlPath = path.join(OUT_DIR, `${name}.html`);
  const pngPath = path.join(OUT_DIR, `${name}.png`);
  await fs.promises.writeFile(htmlPath, html, 'utf8');
  await page.screenshot({ path: pngPath, fullPage: true });
  console.log(`[save] ${name} -> ${htmlPath}, ${pngPath}`);
}

function includesAny(text, words) {
  return words.some((w) => text.includes(w));
}

async function clickByText(target, text) {
  // <a>, <button>, <input value> を対象に XPath で探す
  const escaped = text.replace(/["\\]/g, '\\$&');

  // a/button：innerText
  let nodes = await target.$x(
    `//*[self::a or self::button][contains(normalize-space(.), "${escaped}")]`
  );
  if (nodes.length > 0) {
    await nodes[0].click({ delay: 50 });
    return true;
  }

  // input[value]
  nodes = await target.$x(
    `//input[contains(@value, "${escaped}") or contains(@aria-label, "${escaped}")]`
  );
  if (nodes.length > 0) {
    await nodes[0].click({ delay: 50 });
    return true;
  }

  return false;
}

async function forceSubmitFirstForm(target) {
  try {
    const submitted = await target.evaluate(() => {
      for (const f of Array.from(document.forms)) {
        try {
          f.submit();
          return true;
        } catch (_) {}
      }
      return false;
    });
    return submitted;
  } catch {
    return false;
  }
}

async function waitBody(page, timeout = 15000) {
  try {
    await page.waitForSelector('body', { timeout });
  } catch (_) {
    // 何もしない（撮影はできる）
  }
}

// 「おわび」「タイムアウト」「ページが見つかりません」等の簡易検知
async function isApologyLike(page) {
  const html = (await page.content()) || '';
  return includesAny(html, [
    'おわび',
    'タイムアウト',
    '長い間アクセスがなかったため',
    'サーバーが大変混み合っております',
    'ページが見つかりません',
    'その操作は行わないで下さい',
  ]);
}

async function tryRecoverApology(page, labelForSave = '_apology_') {
  if (!(await isApologyLike(page))) return false;

  console.log('[recover] Apology-like page detected.');
  await save(page, labelForSave);

  // 最優先：「トップページへ戻る」
  if (await clickByText(page, 'トップページへ戻る')) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(800);
    return true;
  }

  // 次点：「こちら」
  if (await clickByText(page, 'こちら')) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(800);
    return true;
  }

  // 何もできない場合も true（検知したことだけ報告）
  return true;
}

async function gotoAndCapture(page, url, label) {
  console.log(`[goto] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitBody(page);
  await save(page, label);
  await tryRecoverApology(page, `${label}__apology`);
}

// -----------------------------
// HOME シーケンス
// -----------------------------
async function runHomeSequence(page) {
  console.log('[home] start sequence');
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      for (let i = 0; i < HOME_STEPS.length; i += 1) {
        await gotoAndCapture(page, HOME_STEPS[i], i === 0 ? '_home_' : `_home_${i}`);
        // apology ページなら、その都度「トップへ戻る/こちら」を押して継続
        if (await isApologyLike(page)) {
          console.log('[home] apology encountered -> continue sequence');
        }
        await sleep(500);
      }
      console.log('[home] reached service/');
      return true;
    } catch (e) {
      console.log(`[home] attempt ${attempt} failed: ${e?.message || e}`);
      await sleep(1200);
    }
  }
  return false;
}

// -----------------------------
// StartInit への侵入 & リレー突破
// -----------------------------
async function enterStartInit(page) {
  // frameset 直リンク
  await gotoAndCapture(page, START_INIT, '_frameset_');

  // まずはページ全体で「こちら」を探す
  if (await clickByText(page, 'こちら')) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(800);
    await save(page, '_after_relay_');
  } else {
    // フレーム内の「こちら」
    for (const f of page.frames()) {
      const name = f.name() || '(no-name)';
      try {
        if (await clickByText(f, 'こちら')) {
          console.log(`[relay] clicked in frame: ${name}`);
          await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(800);
          await save(page, '_after_relay_');
          break;
        }
      } catch (_) {
        /* noop */
      }
    }
  }

  // それでも動かない場合は form.submit() を試す（ページと全フレーム）
  for (const target of [page, ...page.frames()]) {
    const submitted = await forceSubmitFirstForm(target);
    if (submitted) {
      console.log('[search] force form.submit() executed');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(800);
      await save(page, '_after_submit_');
      break;
    }
  }

  await save(page, '_final_');
}

// -----------------------------
// メイン
// -----------------------------
(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(45000);

  try {
    const ok = await runHomeSequence(page);
    if (!ok) {
      console.log('Error: cannot reach HOME sequence');
      await save(page, '_final_');
      await browser.close();
      // ここで終了コード 0 にしておくと成果物アップロードが安定
      process.exit(0);
    }

    await enterStartInit(page);

    console.log('[done] sequence finished');
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error(err);
    try {
      await save(page, '_final_');
    } catch (_) {}
    await browser.close();
    // 成果物はアップロードさせたいので 0 で返す（必要に応じて 1 に）
    process.exit(0);
  }
})();
