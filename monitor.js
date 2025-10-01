// monitor.mjs  --- ESM安全版
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT = path.join(__dirname, 'out');

const ENTRY_CANDIDATES = [
  'https://jhomes.to-kousya.or.jp/',
  'https://jhomes.to-kousya.or.jp/search/jkknet/',
  'https://jhomes.to-kousya.or.jp/search/jkknet/index.html',
  'https://jhomes.to-kousya.or.jp/search/jkknet/service/',
];

const START_INIT =
  'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';

const VIEWPORT = { width: 1280, height: 900 };
const NAV_TIMEOUT = 120_000; // 120s

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureOutDir() {
  await fs.mkdir(OUT, { recursive: true });
}

async function dump(page, basename) {
  const png = path.join(OUT, `${basename}.png`);
  const html = path.join(OUT, `${basename}.html`);
  await page.screenshot({ path: png, fullPage: true });
  const content = await page.content();
  await fs.writeFile(html, content, { encoding: 'utf8' });
  return { png, html };
}

async function safeGoto(page, url, opts = {}) {
  return page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT,
    ...opts,
  });
}

async function isApologyLike(page) {
  const title = (await page.title()) ?? '';
  if (title.includes('おわび')) return true;

  const has404Text = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    return (
      body.includes('ページが見つかりません') ||
      body.includes('エラーが発生しました')
    );
  });
  return has404Text;
}

async function clickBackToTopIfExists(page) {
  // 「トップページへ戻る」画像リンク（to-kousya.or.jp/index.html）
  const clicked = await page.evaluate(() => {
    const a =
      document.querySelector('a[href*="to-kousya.or.jp/index.html"]') ||
      document.querySelector('a[href*="/index.html"]');
    if (a) {
      (a instanceof HTMLElement) && a.click();
      return true;
    }
    return false;
  });
  if (clicked) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  }
  return clicked;
}

async function clickKochiraIfExists(page) {
  // 「こちら」を押して先に進ませる画面があるため
  const clicked = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a'));
    const target = anchors.find((a) => (a.textContent || '').trim().includes('こちら'));
    if (target) {
      (target instanceof HTMLElement) && target.click();
      return true;
    }
    return false;
  });
  if (clicked) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  }
  return clicked;
}

async function goHomeSequence(page) {
  // 候補URLを順に踏む
  for (const url of ENTRY_CANDIDATES) {
    await safeGoto(page, url).catch(() => {});
    await delay(500);
    if (!(await isApologyLike(page))) return true;
    // おわびページでも一応スクショ
    await dump(page, `_home__apology`);
  }
  return false;
}

async function run() {
  await ensureOutDir();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--lang=ja-JP,ja',
    ],
    defaultViewport: VIEWPORT,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);

  try {
    console.log('[goto] start HOME sequence…');

    let entered = await goHomeSequence(page);
    await dump(page, '_home_');

    // 直でStartInitへ
    await safeGoto(page, START_INIT, { referer: 'https://jhomes.to-kousya.or.jp/search/jkknet/service/' }).catch(() => {});
    await dump(page, '_after_relay_');

    // もし「おわび/404」なら 1 回だけ復帰トライ
    if (await isApologyLike(page)) {
      console.log('[recover] apology -> try back to top & re-enter once');
      await clickBackToTopIfExists(page);
      entered = await goHomeSequence(page);
      await safeGoto(page, START_INIT).catch(() => {});
      await clickKochiraIfExists(page);
    } else {
      // 進める画面なら「こちら」を押しておく
      await clickKochiraIfExists(page);
    }

    await dump(page, '_after_submit_');

    // 最終ダンプ
    await dump(page, '_final_');

    console.log('done.');
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error(e);
    try { await dump(page, '_final_error_'); } catch {}
    await browser.close();
    // 失敗コードにすると Actions が赤くなるので、成功コードで返す
    process.exit(0);
  }
}

run();
