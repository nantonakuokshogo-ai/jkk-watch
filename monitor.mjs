// monitor.mjs — JKK 先着順あき家検索: 「住宅名(カナ) = コーシャハイム」で検索まで実行
// Node 20 / Puppeteer-core 22 以降を想定

import puppeteer from 'puppeteer-core';
import fs from 'fs/promises';
import path from 'path';

const OUT_DIR = process.env.OUT_DIR || '.';
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const BASE = 'https://jhomes.to-kousya.or.jp';

async function save(page, name) {
  try {
    const png = path.join(OUT_DIR, `${name}.png`);
    const html = path.join(OUT_DIR, `${name}.html`);
    await fs.writeFile(html, await page.content());
    // 失敗回避: ビューポートが 0 のときがあるので幅を確保
    const vp = page.viewport();
    if (!vp || !vp.width) {
      await page.setViewport({ width: 1280, height: 2000, deviceScaleFactor: 1 });
    }
    await page.screenshot({ path: png, fullPage: true });
    console.log(`[saved] ${name}`);
  } catch (e) {
    console.log(`[save skipped] ${name}: ${e.message}`);
  }
}

async function gotoWithReferer(page, url, referer = undefined, name = undefined) {
  const abs = url.startsWith('http') ? url : `${BASE}${url}`;
  console.log('[goto]', url.replace(BASE, ''));
  await page.goto(abs, {
    waitUntil: 'domcontentloaded',
    referer,
  });
  if (name) await save(page, name);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// すべてのページ・フレームから「先着順あき家検索」フォームを探す
async function findSearchFrame(browser) {
  // 何度かリトライ（ポップアップの置き換えに時間がかかるため）
  for (let round = 0; round < 10; round++) {
    const pages = await browser.pages();
    for (const p of pages) {
      for (const f of p.frames()) {
        try {
          const ok = await f.evaluate(() => {
            const hasText = document.body && document.body.innerText && document.body.innerText.includes('先着順あき家検索');
            const hasSearchBtn = !!document.querySelector('input[type="submit"], button');
            return !!(hasText && hasSearchBtn);
          });
          if (ok) return { page: p, frame: f };
        } catch (_) {
          // 無視（クロスオリジンやタイミングで投げることがある）
        }
      }
    }
    await sleep(500);
  }
  return null;
}

// フレーム内から「住宅名(カナ)」のインプットを見つける（ラベル探索ベース）
async function pickKanaInput(frame) {
  const info = await frame.evaluate(() => {
    const LABELS = [
      '住宅名(カナ)', '住宅名（カナ）', '住宅名(ｶﾅ)', '住宅名（ｶﾅ）',
      '住宅名（ｶﾅ', '住宅名(カナ', '住宅名ｶﾅ', '住宅名 ｶﾅ', '住宅名 カナ',
    ].map(t => t.replace(/\s/g, ''));
    // 候補: テーブルセル・ラベル・見出し
    const nodes = Array.from(document.querySelectorAll('td,th,label,div,span'));
    function toKey(s) { return (s || '').replace(/\s/g, ''); }

    for (const n of nodes) {
      const text = toKey(n.textContent || '');
      if (!text) continue;
      if (LABELS.some(l => text.includes(l))) {
        // 同じ行のテキストボックス
        const tr = n.closest('tr');
        if (tr) {
          const inTr = tr.querySelector('input[type="text"]');
          if (inTr) {
            return { id: inTr.id || null, name: inTr.name || null };
          }
        }
        // 近傍の兄弟要素から探索
        let sib = n;
        for (let i = 0; i < 5; i++) {
          sib = sib && sib.nextElementSibling;
          if (!sib) break;
          const cand = sib.querySelector && sib.querySelector('input[type="text"]');
          if (cand) return { id: cand.id || null, name: cand.name || null };
          if (sib.tagName === 'INPUT' && sib.getAttribute('type') === 'text') {
            return { id: sib.id || null, name: sib.name || null };
          }
        }
      }
    }
    // フォールバック: 「カナ」を含む name/id の input
    const textInputs = Array.from(document.querySelectorAll('input[type="text"]'));
    const byName = textInputs.find(i => /kana|ｶﾅ/i.test(i.name || '') || /kana|ｶﾅ/i.test(i.id || ''));
    if (byName) return { id: byName.id || null, name: byName.name || null };

    return null;
  });

  if (!info) return null;

  if (info.id) {
    const sel = `#${CSS.escape(info.id)}`;
    try { return await frame.waitForSelector(sel, { timeout: 2000 }); } catch { /* fall through */ }
  }
  if (info.name) {
    const sel = `input[name="${CSS.escape(info.name)}"]`;
    try { return await frame.waitForSelector(sel, { timeout: 2000 }); } catch { /* fall through */ }
  }
  return null;
}

async function clickSearchButton(frame) {
  // よくある実装: input[type=submit] か 「検索する」表記のボタン
  const handle = await frame.evaluateHandle(() => {
    const btns = [
      ...document.querySelectorAll('input[type="submit"]'),
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('input[type="button"]')
    ];
    // ラベル優先
    const byLabel = btns.find(b => (b.value || b.textContent || '').includes('検索する'));
    return byLabel || btns[0] || null;
  });
  if (!handle) throw new Error('検索ボタンが見つかりませんでした。');
  const el = handle.asElement();
  if (!el) throw new Error('検索ボタンが見つかりませんでした。');
  await el.click();
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,2000'],
    defaultViewport: { width: 1280, height: 2000, deviceScaleFactor: 1 },
  });

  let finalPage = null;
  try {
    const page = await browser.newPage();
    console.log('[monitor] Using Chrome at:', CHROME_PATH);

    // 入口を順にたどる（リファラ必須の場面があるため段階遷移）
    await gotoWithReferer(page, '/', undefined, 'home_1');
    await gotoWithReferer(page, '/search/jkknet/', `${BASE}/`, 'home_1_after');
    await gotoWithReferer(page, '/search/jkknet/index.html', `${BASE}/search/jkknet/`, 'home_2');
    await gotoWithReferer(page, '/search/jkknet/service/', `${BASE}/search/jkknet/`, 'home_2_after');

    // frameset: StartInit（onload で popup → wait.jsp → 本体に POST）
    console.log('[frameset] direct goto StartInit with referer=/service/');
    await gotoWithReferer(page, '/search/jkknet/service/akiyaJyoukenStartInit', `${BASE}/search/jkknet/service/`, 'home_3');

    // リレー/待機ページを保存（デバッグ用）
    await save(page, 'frameset_startinit');

    // ポップアップが開いて内容が置き換わるまで少し待つ
    await sleep(1500);

    // すべてのページから「先着順あき家検索」フォームを探す
    const found = await findSearchFrame(browser);
    if (!found) {
      await save(page, 'after_relay_1'); // 参考ログ
      throw new Error('フォームフレームが見つかりませんでした。');
    }
    finalPage = found.page;
    const formFrame = found.frame;

    await save(finalPage, 'form_window_before');

    // 「住宅名(カナ)」の入力
    const kanaHandle = await pickKanaInput(formFrame);
    if (!kanaHandle) {
      await save(finalPage, 'before_fill');
      throw new Error('住宅名(カナ) の入力欄が見つかりませんでした。');
    }
    await kanaHandle.click({ clickCount: 3 });
    await kanaHandle.type('コーシャハイム', { delay: 20 });

    // 検索する
    await clickSearchButton(formFrame);

    // 結果待ち & 保存
    try {
      await finalPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch { /* 画面内検索だけ更新される場合もある */ }
    await save(finalPage, 'after_submit_main');

    // 最後の状態も念のため保存
    await save(page, 'final');

  } catch (err) {
    console.log('[saved] final_error');
    try {
      if (finalPage) await save(finalPage, 'final_error');
    } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}

// 実行
main().catch((e) => {
  console.error('Error:', e.message || e);
  process.exit(1);
});
