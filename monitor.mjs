// monitor.mjs
// Puppeteer Core + system Chrome を使用して JKK 先着順あき家検索へ到達し、
// 「住宅名(カナ)」に『コーシャハイム』を入れて検索まで実行。
// 生成物: out/ 以下に PNG と HTML を保存。

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';

const OUT_DIR = 'out';
const KANA = process.env.KANA || 'コーシャハイム';

// GitHub Actions 上で入れている Chrome の既定パス
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';

// 失敗しても最後まで進めたいのでヘッドレス true 推奨（false でも動きます）
const HEADLESS = process.env.HEADLESS === 'false' ? false : true;

function log(...args) { console.log(...args); }

async function ensureOutDir() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

async function save(page, name) {
  try {
    const png = path.join(OUT_DIR, `${name}.png`);
    const html = path.join(OUT_DIR, `${name}.html`);
    // 念のため viewport を毎回保証（0 width 回避）
    await page.setViewport({ width: 1280, height: 2000, deviceScaleFactor: 1 });
    await page.screenshot({ path: png, fullPage: true });
    await fs.promises.writeFile(html, await page.content(), 'utf8');
    log(`[saved] ${name}`);
  } catch (e) {
    log(`[warn] save failed at ${name}:`, e?.message || e);
  }
}

async function goto(page, url, { referer } = {}) {
  log(`[goto] ${url}`);
  await page.goto(url, {
    waitUntil: ['load', 'domcontentloaded'],
    referer,
    timeout: 60000,
  });
}

async function clickByText(page, selector, text) {
  // page.$x は v22 で無くなったので、evaluate でテキスト一致要素を探す
  return page.evaluate(
    ({ selector, text }) => {
      const nodes = Array.from(document.querySelectorAll(selector));
      const target = nodes.find((n) => (n.textContent || '').includes(text));
      if (target) {
        target.scrollIntoView({ block: 'center', inline: 'center' });
        (target instanceof HTMLAnchorElement || target instanceof HTMLButtonElement)
          ? target.click()
          : target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      }
      return false;
    },
    { selector, text }
  );
}

async function waitForNewPage(browser, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeoutMs);
    browser.once('targetcreated', async (t) => {
      try {
        const p = await t.page();
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(p);
        }
      } catch {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(null);
        }
      }
    });
  });
}

async function fillKanaAndSubmit(page, kanaText) {
  // 検索フォーム出現を待機
  await page.waitForSelector('form[name="akiSearch"]', { timeout: 20000 });
  // 入力名は公式スクリプト上これ（全角カナ/40文字のバリデーションあり）
  // akiSearch の中にある input[name="akiyaInitRM.akiyaRefM.jyutakuKanaName"]
  await page.evaluate((kana) => {
    const form = document.forms['akiSearch'];
    if (!form) return;
    const inp = form.querySelector('input[name="akiyaInitRM.akiyaRefM.jyutakuKanaName"]');
    if (inp) {
      inp.focus();
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.value = kana;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, kanaText);

  // 送信：ページ内の submitPage('akiyaInitFromJyouken') を使う
  // これが無ければ form.submit() にフォールバック
  await page.evaluate(() => {
    // 二重クリックフラグを使っている実装のため軽く対策
    try { window.dblclickFlg = false; } catch {}
    if (typeof window.submitPage === 'function') {
      // 条件検索からの送信アクション
      window.submitPage('akiyaInitFromJyouken');
    } else {
      const f = document.forms['akiSearch'];
      if (f) f.submit();
    }
  });
}

async function main() {
  await ensureOutDir();

  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(`Chrome not found at ${CHROME_PATH}`);
  }

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: CHROME_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=ja-JP',
    ],
    defaultViewport: { width: 1280, height: 2000, deviceScaleFactor: 1 },
  });

  let page = await browser.newPage();
  log('[monitor] Using Chrome at:', CHROME_PATH);

  try {
    // 入口を順に辿る（保存は “*_after” で DOM 安定後）
    await goto(page, 'https://jhomes.to-kousya.or.jp/');
    await save(page, 'home_1');
    await page.waitForTimeout(500);
    await save(page, 'home_1_after');

    await goto(page, 'https://jhomes.to-kousya.or.jp/search/jkknet/');
    await save(page, 'home_2');
    await page.waitForTimeout(300);
    await save(page, 'home_2_after');

    await goto(page, 'https://jhomes.to-kousya.or.jp/search/jkknet/index.html');
    await save(page, 'home_3');
    await page.waitForTimeout(300);
    await save(page, 'home_3_after');

    await goto(page, 'https://jhomes.to-kousya.or.jp/search/jkknet/service/');
    await save(page, 'home_4');
    await page.waitForTimeout(300);
    await save(page, 'home_4_after');

    // StartInit へ（ここで別ウィンドウ/タブが開くことがある）
    const newPagePromise = waitForNewPage(browser, 15000);
    await goto(
      page,
      'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit',
      { referer: 'https://jhomes.to-kousya.or.jp/search/jkknet/service/' }
    );
    await save(page, 'frameset_startinit');

    const popped = await newPagePromise;
    if (popped) {
      page = popped;
      await page.bringToFront();
    } else {
      // ページ内に「こちら」リンクが出るパターンへの保険
      await clickByText(page, 'a', 'こちら');
      const popped2 = await waitForNewPage(browser, 8000);
      if (popped2) {
        page = popped2;
        await page.bringToFront();
      }
    }

    // メイン検索画面（先着順あき家検索）に来たら保存
    await page.waitForSelector('form[name="akiSearch"]', { timeout: 20000 });
    await save(page, `after_relay_1`);

    // ★ ここで「住宅名(カナ)」= コーシャハイム を投入して検索
    await fillKanaAndSubmit(page, KANA);

    // 遷移待ち（同一タブ遷移/別タブ遷移どちらにも対応）
    const maybeNew = await waitForNewPage(browser, 15000);
    if (maybeNew) {
      page = maybeNew;
      await page.bringToFront();
    } else {
      try {
        await page.waitForNavigation({ timeout: 15000, waitUntil: 'load' });
      } catch { /* そのまま続行 */ }
    }

    // 検索後の画面を保存
    await save(page, 'after_submit_main');

    // 最終スクショ（エラーページでも見えるように）
    await save(page, 'final');
  } catch (e) {
    log('[error]', e?.stack || e?.message || e);
    await save(page, 'final_error');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
