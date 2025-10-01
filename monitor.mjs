// monitor.mjs — JKK 先着順あき家検索：ポップアップ＋全フレーム探索＋詳細ダンプ強化版
import puppeteer from 'puppeteer-core';
import fs from 'fs/promises';
import path from 'path';

const BASE = 'https://jhomes.to-kousya.or.jp';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const VIEW = { width: 1280, height: 1800, deviceScaleFactor: 1 };
const OUTDIR = '.';
const KANA_WORD = process.env.KANA || 'コーシャハイム';

function norm(s = '') {
  return String(s).replace(/[\s\u3000\r\n\t]+/g, '').replace(/[()（）［］\[\]【】<＞<>:：・*＊]/g, '');
}

async function ensureViewport(page) {
  await page.setViewport(VIEW);
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8' });
}

async function save(page, name) {
  try {
    await ensureViewport(page);
    const html = await page.content();
    await fs.writeFile(path.join(OUTDIR, `${name}.html`), html, 'utf8');
    await page.screenshot({ path: path.join(OUTDIR, `${name}.png`), fullPage: true });
    console.log(`[saved] ${name}`);
  } catch (e) {
    console.log(`[save skipped] ${name}: ${e.message}`);
  }
}

async function saveFrame(page, frame, name) {
  try {
    await ensureViewport(page);
    const html = await frame.evaluate(() => document.documentElement.outerHTML);
    await fs.writeFile(path.join(OUTDIR, `${name}.html`), html, 'utf8');
    await page.screenshot({ path: path.join(OUTDIR, `${name}.png`), fullPage: true });
    console.log(`[saved] ${name}`);
  } catch (e) {
    console.log(`[save frame skipped] ${name}: ${e.message}`);
  }
}

async function goto(page, url, referer) {
  const abs = url.startsWith('http') ? url : BASE + url;
  const opts = { waitUntil: 'domcontentloaded', timeout: 40_000 };
  if (referer) opts['referer'] = BASE + referer;
  console.log(`[goto] ${url}`);
  await page.goto(abs, opts);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitPopup(browser) {
  // 既存 or 新規 page を拾う
  const pick = async () => {
    const pages = await browser.pages();
    for (const p of pages) {
      const u = p.url();
      if (u.includes('/search/jkknet/')) return p;
      const t = await p.title().catch(() => '');
      if (t.includes('JKKねっと')) return p;
    }
    return null;
  };
  let p = await pick();
  if (p) return p;

  const target = await browser.waitForTarget(
    t => t.type() === 'page' && /\/search\/jkknet\//.test(t.url()),
    { timeout: 12_000 }
  ).catch(() => null);
  if (!target) return null;
  return await target.page();
}

async function forceOpen(page) {
  await page.evaluate(() => {
    try {
      const w = window.open('/search/jkknet/wait.jsp', 'JKKnet');
      if (w && w.document) {
        const f = w.document.forms.forwardForm || w.document.querySelector('form');
        f && f.submit();
      }
      const f2 = document.forms.forwardForm || document.querySelector('form');
      f2 && f2.submit();
    } catch(e) {}
  });
}

// ------- 探索ユーティリティ -------
async function dumpAllFrames(p, tag) {
  const frames = p.frames();
  console.log(`[frames] count=${frames.length}`);
  let i = 0;
  for (const f of frames) {
    const url = f.url();
    let title = '';
    try { title = await f.title(); } catch {}
    let head = '';
    try {
      head = await f.evaluate(() => (document.body?.innerText || '').slice(0, 120));
    } catch {}
    console.log(`[frame#${i}] url=${url} title=${title} head=${head.replace(/\n/g, ' ')}`);
    await saveFrame(p, f, `frames_dump_${tag}_${i}`);
    i++;
  }
}

async function pickKanaSelectorInFrame(frame) {
  // 「住宅名(カナ)」に相当する input を見つけて CSS セレクタを返す
  const sel = await frame.evaluate(() => {
    const N = (s) => String(s || '').replace(/[\s\u3000\r\n\t]+/g, '').replace(/[()（）［］\[\]【】<＞<>:：・*＊]/g, '');
    const isKanaLabel = (t) => {
      const n = N(t);
      return n.includes('住宅名カナ') || (n.includes('住宅名') && n.includes('カナ'));
    };

    // label[for] 経由
    const labels = Array.from(document.querySelectorAll('label'));
    for (const lab of labels) {
      if (isKanaLabel(lab.textContent || '')) {
        const id = lab.getAttribute('for');
        if (id) return `#${CSS.escape(id)}`;
      }
    }

    // 表レイアウト: ラベルセルの右隣あたり
    const cells = Array.from(document.querySelectorAll('td,th'));
    for (const cell of cells) {
      if (isKanaLabel(cell.textContent || '')) {
        const tr = cell.closest('tr');
        if (tr) {
          const cand =
            tr.querySelector('input[type="text"]') ||
            tr.querySelector('input:not([type])') ||
            tr.querySelector('input[type="search"]');
          if (cand) {
            if (cand.id) return `#${CSS.escape(cand.id)}`;
            if (cand.name) return `[name="${cand.name}"]`;
            return 'input[type="text"],input:not([type]),input[type="search"]';
          }
        }
      }
    }

    // name / aria-label / title に "カナ"
    const any = Array.from(document.querySelectorAll('input[type="text"],input:not([type]),input[type="search"]'))
      .find(el => /カナ|kana|ｶﾅ/i.test([el.name||'', el.id||'', el.title||'', el.getAttribute('aria-label')||''].join('')));
    if (any) {
      if (any.id) return `#${CSS.escape(any.id)}`;
      if (any.name) return `[name="${any.name}"]`;
      return 'input[type="text"],input:not([type]),input[type="search"]';
    }
    return null;
  });
  return sel;
}

async function clickSearchInFrame(frame) {
  // 「検索」「検索する」など広く対応
  const clicked = await frame.evaluate(() => {
    const norm = (s) => String(s||'').replace(/\s+/g,'');
    const btns = [
      ...document.querySelectorAll('input[type="submit"],input[type="button"],input[type="image"],button,a')
    ];
    // label優先
    const byText = btns.find(b => {
      const t = norm(b.value || b.textContent || b.getAttribute('alt') || '');
      return t.includes('検索する') || t.includes('検索');
    });
    if (byText) {
      (byText instanceof HTMLElement) && byText.click();
      return true;
    }
    // 画像ボタンなど
    const img = document.querySelector('input[alt*="検索"]');
    if (img) { (img instanceof HTMLElement) && img.click(); return true; }

    // 最後のフォールバック: form.submit()
    const f = document.querySelector('form[action*="Jyouken"], form[action*="Jyouken"], form');
    if (f) { f.submit(); return true; }
    return false;
  });
  return clicked;
}

async function pickSearchFrame(page) {
  // 「検索」ボタンの存在＋テキスト入力があるフレームを優先
  const frames = page.frames();
  for (const f of frames) {
    const score = await f.evaluate(() => {
      const hasBtn = !!document.querySelector('input[type="submit"],input[type="button"],input[type="image"],button,a');
      const hasText = !!document.querySelector('input[type="text"],input:not([type]),input[type="search"]');
      const body = (document.body && document.body.innerText) || '';
      const hint = /先着順|検索|住宅名|カナ/.test(body);
      return (hasBtn?1:0) + (hasText?1:0) + (hint?1:0);
    }).catch(()=>0);
    if (score >= 2) return f;
  }
  return null;
}

// ---------------- main ----------------
async function main() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
  console.log('[monitor] Using Chrome at:', executablePath);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1280,1800','--lang=ja-JP'],
    defaultViewport: VIEW,
    protocolTimeout: 120_000,
  });

  try {
    const page = await browser.newPage();
    await ensureViewport(page);

    // 入口を正しい順で辿る
    await goto(page, '/');                   await save(page, 'home_1');
    await goto(page, '/search/jkknet/');    await save(page, 'home_1_after');
    await goto(page, '/search/jkknet/index.html'); await save(page, 'home_2');
    await goto(page, '/search/jkknet/service/');   await save(page, 'home_2_after');

    console.log('[frameset] direct goto StartInit with referer=/service/');
    await goto(page, '/search/jkknet/service/akiyaJyoukenStartInit', '/search/jkknet/service/');
    await save(page, 'frameset_startinit');

    // リレー → ポップアップ
    await save(page, 'after_relay_1');
    let popup = await waitPopup(browser);
    if (!popup) {
      await forceOpen(page);
      popup = await waitPopup(browser);
    }
    if (!popup) {
      await save(page, 'final_error');
      throw new Error('フォームウィンドウ（JKKnet）が見つかりませんでした。');
    }
    await popup.bringToFront();
    await ensureViewport(popup);
    await popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(()=>{});

    // まだ wait なら submit
    if (popup.url().includes('/wait.jsp')) {
      await popup.evaluate(() => {
        const f = document.forms.forwardForm || document.querySelector('form');
        f && f.submit();
      });
      await popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(()=>{});
    }

    // ここで全フレームをダンプ（決定打）
    await dumpAllFrames(popup, 'before'); // <- これが今回の鍵
    await save(popup, 'before_fill');

    // 「検索フォーム」フレーム推定
    const sFrame = await pickSearchFrame(popup);
    if (!sFrame) {
      await save(popup, 'final_error');
      throw new Error('検索フォームのフレームが見つかりませんでした。');
    }
    console.log('[pick] search frame url=', sFrame.url());

    // 「住宅名(カナ)」入力欄のセレクタ推定
    const sel = await pickKanaSelectorInFrame(sFrame);
    console.log('[pick] kana selector =', sel);
    if (!sel) {
      // ダンプを見ればDOMが分かるので一旦終了
      await saveFrame(popup, sFrame, 'final_error');
      throw new Error('住宅名(カナ) の入力欄が見つかりませんでした。');
    }

    // 入力＆検索
    await sFrame.focus(sel).catch(()=>{});
    await sFrame.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.value = ''; el.dispatchEvent(new Event('input', {bubbles:true})); }
    }, sel);
    await sFrame.type(sel, KANA_WORD, { delay: 10 });

    const ok = await clickSearchInFrame(sFrame);
    if (!ok) {
      // 最終フォールバック
      await sFrame.evaluate(() => {
        const f = document.querySelector('form[action*="Jyouken"]') || document.querySelector('form');
        f && f.submit();
      });
    }

    // 反映待ち
    await popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(()=>{});
    await dumpAllFrames(popup, 'after'); // 結果側もダンプ
    await save(popup, 'final');
  } catch (err) {
    console.error('Error:', err.message || err);
    try {
      const pages = await browser.pages();
      const p = pages[pages.length - 1];
      if (p) await save(p, 'final_error');
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close().catch(()=>{});
  }
}

main();
