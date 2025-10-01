// monitor.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';

const BASE = 'https://jhomes.to-kousya.or.jp';
const OUTDIR = '.';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 画像＆HTML保存（ビューポート必ずセット）
async function save(page, key) {
  try {
    await page.setViewport({ width: 1280, height: 1800, deviceScaleFactor: 1 });
  } catch {}
  const html = await page.content();
  await fs.writeFile(`${OUTDIR}/${key}.html`, html);
  await page.screenshot({ path: `${OUTDIR}/${key}.png`, fullPage: true });
  console.log(`[saved] ${key}`);
}

// ラベル文字列に近いテキストボックスを頑張って探す
async function findInputByJapaneseLabel(page, label) {
  const handle = await page.evaluateHandle((labelText) => {
    const norm = (s) => (s || '').replace(/\s+/g, '').trim();
    const wanted = norm(labelText);

    // 1) label要素にfor= があるパターン
    const labels = Array.from(document.querySelectorAll('label'));
    for (const lb of labels) {
      if (norm(lb.innerText).includes(wanted) || norm(lb.textContent).includes(wanted)) {
        const forId = lb.getAttribute('for');
        if (forId) {
          const el = document.getElementById(forId);
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return el;
        }
        // 近傍探索
        const near = lb.parentElement?.querySelector('input[type="text"],input:not([type]),textarea');
        if (near) return near;
      }
    }

    // 2) テーブル行などで左セルがラベルのパターン
    const cells = Array.from(document.querySelectorAll('td,th,div,span'));
    for (const c of cells) {
      const t = norm(c.innerText || c.textContent);
      if (!t) continue;
      if (t.includes(wanted)) {
        // 自分の中 or 兄弟に input がある？
        const inside = c.querySelector('input[type="text"],input:not([type]),textarea');
        if (inside) return inside;
        let sib = c.nextElementSibling;
        for (let i = 0; i < 3 && sib; i++) {
          const candidate = sib.querySelector?.('input[type="text"],input:not([type]),textarea') || sib;
          if (candidate && (candidate.tagName === 'INPUT' || candidate.tagName === 'TEXTAREA')) return candidate;
          sib = sib.nextElementSibling;
        }
      }
    }

    // 3) 最後の保険：画面内の最初のテキスト系入力
    return document.querySelector('input[type="text"],input:not([type]),textarea') || null;
  }, label);

  const el = await handle.asElement();
  if (!el) return null;
  return el;
}

async function main() {
  const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
  console.log('[monitor] Using Chrome at:', chromePath);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1280,1800',
    ],
    defaultViewport: { width: 1280, height: 1800 },
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(60_000);

  try {
    // 1) トップ → JKKねっと導線
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await save(page, 'home_1');

    // 念のため後続のスクショで見返せるように
    await save(page, 'home_1_after');

    // 2) /search/jkknet/ → /search/jkknet/index.html → /service/
    for (const path of ['/search/jkknet/', '/search/jkknet/index.html', '/search/jkknet/service/']) {
      console.log('[goto]', path);
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', referer: `${BASE}/` });
      await save(page, `home_${['','2','3','4'][['/','/search/jkknet/','/search/jkknet/index.html','/search/jkknet/service/'].indexOf(path)] || 'x'}`);
      await save(page, `home_${['','2','3','4'][['/','/search/jkknet/','/search/jkknet/index.html','/search/jkknet/service/'].indexOf(path)] || 'x'}_after`);
    }

    // 3) 中継ページ（StartInit）へ
    console.log('[frameset] direct goto StartInit with referer=/service/');
    await page.goto(`${BASE}/search/jkknet/service/akiyaJyoukenStartInit`, {
      waitUntil: 'domcontentloaded',
      referer: `${BASE}/search/jkknet/service/`,
    });
    await save(page, 'frameset_startinit');

    // 4) ★★ ポップアップを避けて、その場で forwardForm を submit する ★★
    //    (target='JKKnet' を '_self' に差し替え)
    await page.evaluate(() => {
      const f = document.forms['forwardForm'];
      if (f) {
        try { f.target = '_self'; } catch {}
        f.submit();
      }
    });
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(1200);
    await save(page, 'after_relay_1');

    // 5) エラー（おわび）に飛ばされたらトップへ戻る対応
    const bodyText = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, '');
    if (bodyText.includes('おわび') || bodyText.includes('ページが見つかりません')) {
      // 「トップページへ戻る」ボタンがある場合が多いので、無ければ JKKトップへ
      const clicked = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a')).find(x => /トップページへ戻る/.test(x.textContent || ''));
        if (a) { a.click(); return true; }
        return false;
      });
      if (!clicked) {
        await page.goto('https://www.to-kousya.or.jp/index.html', { waitUntil: 'domcontentloaded' });
      }
      await save(page, 'home_recovered');
      // 再び JKKねっとへ
      await page.goto(`${BASE}/search/jkknet/`, { waitUntil: 'domcontentloaded' });
      await save(page, 'home_after_recover');
    }

    // 6) 「住宅名(カナ)」に 'コーシャハイム' を入力して検索
    await save(page, 'before_fill');

    const inputEl = await findInputByJapaneseLabel(page, '住宅名(カナ)');
    if (!inputEl) {
      throw new Error('住宅名(カナ) の入力欄が見つかりませんでした。');
    }
    await inputEl.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.type('コーシャハイム', { delay: 30 });

    // 「検索する」ボタンを押す（複数パターン吸収）
    const clickedSearch = await page.evaluate(() => {
      // 文字ボタン
      const btn = Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"]'))
        .find(b => /検索/.test((b.value || b.textContent || '').replace(/\s+/g, '')));
      if (btn) { btn.click(); return true; }
      // 画像ボタン
      const imgBtn = Array.from(document.querySelectorAll('img, input[type="image"]'))
        .find(i => /検索/.test((i.alt || '').replace(/\s+/g, '')));
      if (imgBtn) { imgBtn.click(); return true; }
      return false;
    });
    if (!clickedSearch) {
      throw new Error('「検索する」ボタンが見つかりませんでした。');
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(1200);
    await save(page, 'after_submit_main');

    // 最終スクショ
    await save(page, 'final');
    console.log('DONE');
  } catch (err) {
    console.error('Error:', err?.message || err);
    try { await save(page, 'final_error'); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

await main();
