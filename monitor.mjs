// monitor.mjs  — JKK 先着順あき家検索 自動入力＆検索（ポップアップ対応・安定版）
import puppeteer from 'puppeteer-core';
import fs from 'fs/promises';
import path from 'path';

// =================== 設定 ===================
const BASE = 'https://jhomes.to-kousya.or.jp';
const OUTDIR = '.'; // GitHub Actions ではリポジトリ直下に保存
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const VIEW = { width: 1280, height: 1800, deviceScaleFactor: 1 };

// 入力したい条件：住宅名(カナ) = 「コーシャハイム」
const KANA_WORD = 'コーシャハイム';

// ============================================

function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function ensureViewport(page) {
  // たまに 0x0 になることがあるので毎回明示セット
  await page.setViewport(VIEW);
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
  });
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
  const opts = {
    waitUntil: 'domcontentloaded',
    timeout: 40_000,
  };
  if (referer) opts['referer'] = BASE + referer;
  console.log(`[goto] ${url}`);
  await page.goto(abs, opts);
}

async function clickByText(page, text) {
  // ボタンやリンクを「テキストで」クリック（XPath 互換）
  const handle = await page.evaluateHandle((t) => {
    const norm = (s) => (s || '').replace(/\s+/g, '');
    const els = Array.from(document.querySelectorAll('a,button,input[type="submit"],input[type="button"]'));
    return els.find((el) => {
      const v = el.value || el.textContent || '';
      return norm(v).includes(norm(t));
    }) || null;
  }, text);
  const el = handle.asElement();
  if (el) {
    await el.click();
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 30_000 }).catch(() => {});
    return true;
  }
  return false;
}

async function waitPopupPage(browser) {
  // すでに開いている「JKKnet」ウィンドウがあれば取得
  const pick = async () => {
    const pages = await browser.pages();
    for (const p of pages) {
      const url = p.url();
      if (url.includes('/search/jkknet/')) return p;
      const title = await p.title().catch(() => '');
      if (title.includes('JKKねっと')) return p;
    }
    return null;
  };

  let p = await pick();
  if (p) return p;

  // 新規ターゲットを待つ
  const target = await browser
    .waitForTarget(
      (t) => t.type() === 'page' && /\/search\/jkknet\//.test(t.url()),
      { timeout: 10_000 }
    )
    .catch(() => null);

  if (target) {
    p = await target.page();
    return p;
  }
  return null;
}

async function forceOpenFromRelay(parent) {
  // relay/wait ページから手動で window.open & フォーム submit を模倣
  await parent.evaluate(() => {
    try {
      const w = window.open('/search/jkknet/wait.jsp', 'JKKnet');
      // forwardForm があれば submit
      const f =
        document.forms.forwardForm ||
        (w && w.document && w.document.forms && w.document.forms.forwardForm);
      if (f) f.submit();
    } catch (e) {}
  });
}

async function hideChatOverlay(page) {
  // 右側に出る MediaTalk を隠してクリック邪魔を防止
  const css = `
#mediaTalkSidemenu,#mediaTalkBalloon,.mediatalk,iframe[src*="mediaTalk"]{display:none!important;visibility:hidden!important;opacity:0!important}
`;
  await page.addStyleTag({ content: css }).catch(() => {});
}

async function fillKanaAndSearch(page) {
  // ラベル「住宅名(カナ)」の左セル/for= から対応する input を推定して入力
  await ensureViewport(page);
  await hideChatOverlay(page);

  // 一旦 DOM 保存
  await save(page, 'before_fill');

  const selector = await page.evaluate(() => {
    const LABEL_TEXT = '住宅名(カナ)';
    const norm = (s) => (s || '').replace(/\s+/g, '');
    // label for= 経由
    for (const inp of document.querySelectorAll('input[type="text"]')) {
      const id = inp.id;
      if (id) {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab && norm(lab.textContent).includes('住宅名(カナ)')) {
          return `#${CSS.escape(id)}`;
        }
      }
    }
    // テーブル構造：ラベルセルの隣に input
    const cells = Array.from(document.querySelectorAll('td,th'));
    for (const cell of cells) {
      if (norm(cell.textContent).includes(LABEL_TEXT)) {
        // 同じ行の次のセル
        const tr = cell.closest('tr');
        if (tr) {
          const cand = tr.querySelector('input[type="text"]');
          if (cand) {
            if (cand.name) return `[name="${cand.name}"]`;
            if (cand.id) return `#${CSS.escape(cand.id)}`;
            return 'input[type="text"]';
          }
        }
      }
    }
    // 後方互換：name/aria-label/タイトルにカナ
    const fallback = document.querySelector(
      'input[aria-label*="カナ"],input[title*="カナ"],input[name*="kana" i],input[name*="Kana" i]'
    );
    if (fallback) {
      if (fallback.id) return `#${CSS.escape(fallback.id)}`;
      if (fallback.name) return `[name="${fallback.name}"]`;
      return 'input[type="text"]';
    }
    return null;
  });

  if (!selector) throw new Error('住宅名(カナ) の入力欄が見つかりませんでした。');

  // 入力（全角カナ）
  await page.focus(selector);
  await page.click(selector, { clickCount: 3 }).catch(() => {});
  await page.type(selector, KANA_WORD, { delay: 10 });

  // 「検索する」押下
  const clicked = await clickByText(page, '検索する');
  if (!clicked) {
    // ボタンが input[value] の場合に備えて直接 submit
    await page.evaluate(() => {
      const f =
        document.querySelector('form[action*="Jyouken"]') ||
        document.querySelector('form') ||
        null;
      f && f.submit();
    });
  }

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => {});
  await save(page, 'after_submit_main');
}

async function main() {
  // Chrome の場所（Actions では /usr/bin/google-chrome）
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

    // 入口から正しいリファラで辿る
    await goto(page, '/');
    await save(page, 'home_1');

    await goto(page, '/search/jkknet/');
    await save(page, 'home_1_after');

    await goto(page, '/search/jkknet/index.html');
    await save(page, 'home_2');
    await goto(page, '/search/jkknet/service/');
    await save(page, 'home_2_after');

    // frameset ラッパ（実際には待機ページ → window.open("JKKnet")）
    console.log('[frameset] direct goto StartInit with referer=/service/');
    await goto(page, '/search/jkknet/service/akiyaJyoukenStartInit', '/search/jkknet/service/');
    await save(page, 'frameset_startinit');

    // 待機ページ（/wait.jsp など）を踏む → ポップアップへ
    await save(page, 'after_relay_1');

    // 既に開いていれば取得、無ければ強制 open
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

    // 自動サブミット待ち → 本体へ遷移
    await popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    // まだ wait なら手動 submit
    if (popup.url().includes('/wait.jsp')) {
      await popup.evaluate(() => {
        const f = document.forms.forwardForm || document.querySelector('form');
        f && f.submit();
      });
      await popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    }

    // 念のため
    await ensureViewport(popup);
    await hideChatOverlay(popup);
    await save(popup, 'before_fill');

    // 入力→検索
    await fillKanaAndSearch(popup);

    // ここで結果ページにいるはず
    await save(popup, 'final');

  } catch (err) {
    console.log('Error:', err.message || err);
    // 可能なら最後のページをスナップ
    try {
      const pages = await (await browser.pages());
      const p = pages[pages.length - 1];
      if (p) await save(p, 'final_error');
    } catch {}
    process.exitCode = 1;
    return;
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
