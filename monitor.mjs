// monitor.mjs — JKK 先着順あき家検索：ポップアップ & フレーム横断 安定版
import puppeteer from 'puppeteer-core';
import fs from 'fs/promises';
import path from 'path';

// ================= 設定 =================
const BASE = 'https://jhomes.to-kousya.or.jp';
const VIEW = { width: 1280, height: 1800, deviceScaleFactor: 1 };
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

// 入力条件
const KANA_WORD = 'コーシャハイム';

// 出力先（リポジトリ直下）
const OUTDIR = '.';
// ======================================

function normJa(s = '') {
  // 空白/全角空白/各種かっこ/記号を除去して比較を緩くする
  return String(s)
    .replace(/[\s\u3000()（）［］\[\]【】<＞<>:：・*＊]/g, '')
    .trim();
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

async function goto(page, url, referer) {
  const abs = url.startsWith('http') ? url : BASE + url;
  console.log(`[goto] ${url}`);
  const opts = { waitUntil: 'domcontentloaded', timeout: 40_000 };
  if (referer) opts['referer'] = BASE + referer;
  await page.goto(abs, opts);
}

async function hideChatOverlay(target) {
  const css =
    '#mediaTalkSidemenu,#mediaTalkBalloon,.mediatalk,iframe[src*="MediaTalk"],iframe[src*="mediatalk"]{display:none!important;visibility:hidden!important;opacity:0!important}';
  if ('addStyleTag' in target) {
    await target.addStyleTag({ content: css }).catch(() => {});
  } else {
    // Frame
    await target.evaluate((c) => {
      const s = document.createElement('style');
      s.textContent = c;
      document.documentElement.appendChild(s);
    }, css).catch(() => {});
  }
}

async function clickByTextInFrame(frame, text) {
  const ok = await frame.evaluate((t) => {
    const norm = (s) => (s || '').replace(/\s+/g, '');
    const els = Array.from(
      document.querySelectorAll('a,button,input[type="submit"],input[type="button"]')
    );
    const el = els.find((e) => norm(e.value || e.textContent || '').includes(norm(t)));
    if (el) {
      (el instanceof HTMLElement) && el.click();
      return true;
    }
    return false;
  }, text);
  if (ok) {
    try {
      await frame.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25_000 });
    } catch {}
  }
  return ok;
}

async function waitPopupPage(browser) {
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

  const target = await browser
    .waitForTarget((t) => t.type() === 'page' && /\/search\/jkknet\//.test(t.url()), {
      timeout: 12_000,
    })
    .catch(() => null);
  if (!target) return null;
  return await target.page();
}

async function forceOpenFromRelay(page) {
  await page.evaluate(() => {
    try {
      const w = window.open('/search/jkknet/wait.jsp', 'JKKnet');
      if (w && w.document) {
        const f = w.document.forms.forwardForm || w.document.querySelector('form');
        f && f.submit();
      }
      const f2 = document.forms.forwardForm || document.querySelector('form');
      f2 && f2.submit();
    } catch (e) {}
  });
}

async function pickSearchFrame(page) {
  // 「検索する」ボタンを含むフレームを探す（全フレームを横断）
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const frames = page.frames();
    for (const f of frames) {
      const has = await f
        .evaluate(() => {
          const norm = (s) => (s || '').replace(/\s+/g, '');
          const els = Array.from(
            document.querySelectorAll('a,button,input[type="submit"],input[type="button"]')
          );
          return els.some((e) => norm(e.value || e.textContent || '').includes('検索する'));
        })
        .catch(() => false);
      if (has) return f;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function findKanaSelectorInFrame(frame) {
  // フレーム内で「住宅名(カナ)」の input セレクタを見つける
  const selector = await frame.evaluate(() => {
    const N = (s) =>
      String(s || '')
        .replace(/[\s\u3000()（）［］\[\]【】<＞<>:：・*＊]/g, '')
        .trim();

    const isKanaLabel = (txt) => {
      const t = N(txt);
      return t.includes('住宅名カナ') || (t.includes('住宅名') && t.includes('カナ'));
    };

    // 1) label[for]
    for (const lab of Array.from(document.querySelectorAll('label'))) {
      if (isKanaLabel(lab.textContent || '')) {
        const id = lab.getAttribute('for');
        if (id) return `#${CSS.escape(id)}`;
      }
    }
    // 2) テーブル：ラベルセルの横
    for (const cell of Array.from(document.querySelectorAll('td,th'))) {
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
    // 3) name / aria-label / title にカナ系
    const cand2 = Array.from(
      document.querySelectorAll('input[type="text"],input:not([type]),input[type="search"]')
    ).find((el) => /カナ|kana/i.test([el.name, el.id, el.title, el.getAttribute('aria-label')].join('')));
    if (cand2) {
      if (cand2.id) return `#${CSS.escape(cand2.id)}`;
      if (cand2.name) return `[name="${cand2.name}"]`;
      return 'input[type="text"],input:not([type]),input[type="search"]';
    }
    return null;
  });
  return selector;
}

async function fillKanaAndSearchInFrame(frame) {
  await hideChatOverlay(frame);
  // セレクタ探索
  const selector = await findKanaSelectorInFrame(frame);
  if (!selector) throw new Error('住宅名(カナ) の入力欄が見つかりませんでした。');

  // 入力
  await frame.focus(selector).catch(() => {});
  await frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, selector);
  await frame.type(selector, KANA_WORD, { delay: 10 });

  // クリック（見つからなければ submit）
  const clicked = await clickByTextInFrame(frame, '検索する');
  if (!clicked) {
    await frame.evaluate(() => {
      const f =
        document.querySelector('form[action*="Jyouken"]') ||
        document.querySelector('form') ||
        null;
      f && f.submit();
    });
    try {
      await frame.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25_000 });
    } catch {}
  }
}

// ---------------- main ----------------
async function main() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
  console.log('[monitor] Using Chrome at:', executablePath);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,1800',
      '--lang=ja-JP',
    ],
    defaultViewport: VIEW,
    protocolTimeout: 90_000,
  });

  try {
    const page = await browser.newPage();
    await ensureViewport(page);

    // 入口 → jkknet トップ → service → StartInit
    await goto(page, '/');
    await save(page, 'home_1');

    await goto(page, '/search/jkknet/');
    await save(page, 'home_1_after');

    await goto(page, '/search/jkknet/index.html');
    await save(page, 'home_2');

    await goto(page, '/search/jkknet/service/');
    await save(page, 'home_2_after');

    console.log('[frameset] direct goto StartInit with referer=/service/');
    await goto(page, '/search/jkknet/service/akiyaJyoukenStartInit', '/search/jkknet/service/');
    await save(page, 'frameset_startinit');

    // 待機→ポップアップ
    await save(page, 'after_relay_1');

    let popup = await waitPopupPage(browser);
    if (!popup) {
      await forceOpenFromRelay(page);
      popup = await waitPopupPage(browser);
    }
    if (!popup) {
      await save(page, 'final_error');
      throw new Error('フォームウィンドウ（JKKnet）が見つかりませんでした。');
    }

    await popup.bringToFront();
    await ensureViewport(popup);
    await popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});

    // もし wait.jsp なら手動で submit
    if (popup.url().includes('/wait.jsp')) {
      await popup.evaluate(() => {
        const f = document.forms.forwardForm || document.querySelector('form');
        f && f.submit();
      });
      await popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    }

    await ensureViewport(popup);
    await hideChatOverlay(popup);
    await save(popup, 'before_fill');

    // 「検索する」ボタンを持つフレームを特定
    const sFrame = await pickSearchFrame(popup);
    if (!sFrame) {
      await save(popup, 'final_error');
      throw new Error('検索フォームのフレームが見つかりませんでした。');
    }

    // 入力→検索
    await fillKanaAndSearchInFrame(sFrame);

    // 結果スナップ（ページ全体で保存）
    await ensureViewport(popup);
    await save(popup, 'final');
  } catch (err) {
    console.log('Error:', err.message || err);
    try {
      const pages = await browser.pages();
      const p = pages[pages.length - 1];
      if (p) await save(p, 'final_error');
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
