// monitor.mjs  — JKK ねっと: 先着順あき家検索を自動遷移して
// 「住宅名(カナ)」に「コーシャハイム」を入力→検索→結果保存。
// ランナーは apt-get で google-chrome を入れている前提（executablePath: 'google-chrome'）

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTDIR = path.join(__dirname, 'out');
const START = 'https://jhomes.to-kousya.or.jp/';

const NAV_TIMEOUT = 45000;
const PROTOCOL_TIMEOUT = 45000;

async function ensureOutdir() {
  await fs.mkdir(OUTDIR, { recursive: true });
}

async function savePage(pageOrFrame, name, opts = {}) {
  const page = pageOrFrame.page ? pageOrFrame.page() : pageOrFrame;
  const html = await (pageOrFrame.content ? pageOrFrame.content() : page.content());
  await fs.writeFile(path.join(OUTDIR, `${name}.html`), html, 'utf8');
  await page.screenshot({
    path: path.join(OUTDIR, `${name}.png`),
    fullPage: true,
    ...opts.screenshot,
  });
  console.log(`[saved] ${name}`);
}

async function goto(page, url, referer) {
  console.log(`[goto] ${url}`);
  await page.setExtraHTTPHeaders({
    'Upgrade-Insecure-Requests': '1',
    ...(referer ? { Referer: referer } : {}),
  });
  await page.goto(url, { waitUntil: ['domcontentloaded', 'networkidle0'], timeout: NAV_TIMEOUT });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function recoverIfApology(page) {
  // 「おわび」ページ検知 → トップへ戻る
  // 画面は title が「JKKねっと：おわび」で、フッターや「トップページへ戻る」ボタンを持つ（正式HTMLより）。:contentReference[oaicite:2]{index=2}
  const title = (await page.title()).trim();
  if (title.includes('おわび')) {
    console.log('[recover] apology -> back to top');
    const link = await page.$('a[href*="to-kousya.or.jp/chintai"]'); // 「トップページへ戻る」リンク。:contentReference[oaicite:3]{index=3}
    if (link) await Promise.all([
      page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle0'], timeout: NAV_TIMEOUT }),
      link.click()
    ]);
    return true;
  }
  return false;
}

async function hideChatLikeThings(pageOrFrame) {
  try {
    await pageOrFrame.evaluate(() => {
      // MediaTalk らしきウィジェットを非表示（クラスや構造が変わっても “MediaTalk” 文字に反応）
      const nodes = Array.from(document.querySelectorAll('div,iframe,[role="dialog"],[class*="chat"],[id*="chat"]'));
      for (const el of nodes) {
        const t = (el.innerText || '').toLowerCase();
        if (t.includes('mediatalk') || t.includes('powered by')) {
          el.style.setProperty('display', 'none', 'important');
        }
      }
      // 画面内の「×」「閉じる」ボタンがあれば押して消す
      const closes = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(b => /×|閉じる|close/i.test(b.textContent || b.getAttribute('aria-label') || ''));
      closes.slice(0, 2).forEach(b => b.click());
    });
  } catch {}
}

function waitForFrame(page, predicate, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      const frames = page.frames();
      for (const f of frames) {
        try {
          if (predicate(f)) return resolve(f);
        } catch {}
      }
      if (Date.now() - start > timeout) return reject(new Error('waitForFrame: timeout'));
      setTimeout(check, 300);
    }
    check();
  });
}

async function clickByTextWithNav(frame, label, selector = 'a,button,input[type="submit"],input[type="button"]') {
  const handle = await frame.evaluateHandle((label, selector) => {
    const els = Array.from(document.querySelectorAll(selector));
    const norm = s => (s || '').replace(/\s+/g, '');
    const want = norm(label);
    return els.find(el => {
      const text = norm(el.textContent || el.value || '');
      return text.includes(want);
    }) || null;
  }, label, selector);

  if (!handle) throw new Error(`clickByTextWithNav: not found "${label}"`);
  const el = handle.asElement();
  await Promise.all([
    frame.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle0'], timeout: NAV_TIMEOUT }),
    el.click()
  ]);
}

async function fillByLabelText(frame, labelText, value) {
  // テーブルレイアウト想定：「住宅名(カナ)」を含むセルの同行/近傍にある <input> を探して入力
  const ok = await frame.evaluate((labelText, value) => {
    function norm(s){return (s||'').replace(/\s+/g,'');}
    const want = norm(labelText);
    // 1) ラベルとfor属性
    const label = Array.from(document.querySelectorAll('label')).find(l => norm(l.textContent).includes(want));
    if (label) {
      const forId = label.getAttribute('for');
      if (forId) {
        const inp = document.getElementById(forId);
        if (inp) { inp.focus(); inp.value = value; inp.dispatchEvent(new Event('input',{bubbles:true})); return true; }
      }
    }
    // 2) テーブルの見出しセル → 同じ行の input
    const cells = Array.from(document.querySelectorAll('th,td,span,div'));
    for (const c of cells) {
      if (norm(c.textContent).includes(want)) {
        // 同じ行
        let row = c.closest('tr') || c.parentElement;
        if (row) {
          const inp = row.querySelector('input[type="text"], input:not([type]), textarea');
          if (inp) { inp.focus(); inp.value = value; inp.dispatchEvent(new Event('input',{bubbles:true})); return true; }
        }
        // 隣接要素
        let sib = c.nextElementSibling;
        for (let i=0; i<3 && sib; i++, sib=sib.nextElementSibling) {
          const inp = sib.querySelector && sib.querySelector('input[type="text"], input:not([type]), textarea');
          if (inp) { inp.focus(); inp.value = value; inp.dispatchEvent(new Event('input',{bubbles:true})); return true; }
        }
      }
    }
    // 3) name や placeholder を使った総当たり
    const guess = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), textarea'))
      .find(i => /住宅名|ｶﾅ|カナ|kana|housename/i.test(i.name || i.id || i.placeholder || ''));
    if (guess) { guess.focus(); guess.value = value; guess.dispatchEvent(new Event('input',{bubbles:true})); return true; }
    return false;
  }, labelText, value);
  if (!ok) throw new Error(`fillByLabelText: "${labelText}" の入力欄が見つかりませんでした`);
}

async function main() {
  await ensureOutdir();

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'google-chrome',
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--no-first-run','--no-default-browser-check',
    ],
    protocolTimeout: PROTOCOL_TIMEOUT,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1800 });
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.setDefaultTimeout(NAV_TIMEOUT);

  try {
    // 1) トップ → JKKねっと（検索）入口 → サービス
    await goto(page, START);
    await recoverIfApology(page);
    await savePage(page, 'home_1');

    await goto(page, 'https://jhomes.to-kousya.or.jp/search/jkknet/', START);
    await recoverIfApology(page);
    await savePage(page, 'home_2');

    await goto(page, 'https://jhomes.to-kousya.or.jp/search/jkknet/index.html', 'https://jhomes.to-kousya.or.jp/search/jkknet/');
    await recoverIfApology(page);
    await savePage(page, 'home_3');

    await goto(page, 'https://jhomes.to-kousya.or.jp/search/jkknet/service/', 'https://jhomes.to-kousya.or.jp/search/jkknet/index.html');
    await recoverIfApology(page);
    await savePage(page, 'home_4');

    // 2) 直接 StartInit へ（frameset → 内部フレームを掴む）
    await goto(page, 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit', 'https://jhomes.to-kousya.or.jp/search/jkknet/service/');
    await savePage(page, 'frameset_startinit');

    // フレーム待機（URL に /service/ を含む実体フレーム）
    const mainFrame = await waitForFrame(page, f => /\/search\/jkknet\/service\//.test(f.url()));

    // 3) 画面ノイズを隠す
    await hideChatLikeThings(mainFrame);
    await savePage(mainFrame, 'after_relay_1');

    // 4) 入力：「住宅名(カナ)」= コーシャハイム
    await fillByLabelText(mainFrame, '住宅名(カナ)', 'コーシャハイム');

    // 5) 「検索する」クリック（上段のボタンを優先）
    await mainFrame.evaluate(() => {
      // 先頭に近い「検索する」ボタンをクリック
      const norm = s => (s || '').replace(/\s+/g,'');
      const cands = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],a'));
      const hit = cands.find(el => {
        const t = norm(el.textContent || el.value || '');
        return t.includes('検索する');
      });
      if (hit) hit.scrollIntoView({behavior:'instant', block:'center'});
    });

    await clickByTextWithNav(mainFrame, '検索する');

    // 6) 結果保存
    await hideChatLikeThings(mainFrame);
    await savePage(mainFrame, 'after_submit_main');   // 検索結果（一覧 or 条件反映画面）

    // 7) 最終スナップ
    await savePage(page, 'final');

  } catch (err) {
    console.error(err);
    try { await savePage(page, 'final_error'); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
