// monitor.mjs ーーー まるごと貼り替え

import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL ?? 'https://jhomes.to-kousya.or.jp';
const EXECUTABLE_PATH = process.env.CHROME_PATH || process.env.PUPPETEER_EXEC_PATH || '/usr/bin/google-chrome';
const OUT_DIR = process.env.OUT_DIR || '.';
const KANA_VALUE = process.env.KANA || 'コーシャハイム';

function log(...args){ console.log(...args); }

async function ensureViewport(page){
  const vp = page.viewport();
  if (!vp || !vp.width || !vp.height){
    await page.setViewport({ width: 1280, height: 2200, deviceScaleFactor: 1 });
  }
}

async function saveHTMLandPNG(page, name, htmlOverride){
  await ensureViewport(page);
  const html = htmlOverride ?? await page.content();
  const htmlPath = path.join(OUT_DIR, `${name}.html`);
  const pngPath  = path.join(OUT_DIR, `${name}.png`);
  await fs.writeFile(htmlPath, html, 'utf-8');
  await page.screenshot({ path: pngPath, fullPage: true });
  log(`[saved] ${name}`);
}

async function saveFrameSnapshot(page, frame, name){
  // スクショはページ、HTMLはフレーム（中身）で保存
  const html = await frame.evaluate(() => document.documentElement.outerHTML);
  await saveHTMLandPNG(page, name, html);
}

async function gotoWithReferer(page, url, referer){
  const abs = url.startsWith('http') ? url : new URL(url, BASE).toString();
  const opts = { waitUntil: 'networkidle2' };
  if (referer) opts.referer = referer;
  log('[goto]', new URL(abs).pathname);
  await page.goto(abs, opts);
}

function normalizeTextForMatch(s){
  return s
    .replace(/[ \u3000\r\n\t]+/g, ' ')
    .replace(/[()（）\[\]【】]/g, '') // 括弧の差異を吸収
    .trim();
}

/**
 * ラベル文字列を含む要素があるフレームを探す。
 */
async function findFrameByLabel(page, mustContainA, mustContainB){
  for (const f of page.frames()){
    try{
      const has = await f.evaluate((a,b) => {
        const text = document.body ? document.body.innerText : '';
        const norm = (t)=> t.replace(/[ \u3000\r\n\t]+/g,' ').trim();
        const body = norm(text);
        return body.includes(a) && body.includes(b);
      }, mustContainA, mustContainB);
      if (has) return f;
    }catch(_){}
  }
  return null;
}

/**
 * 与えられたフレーム内で「住宅名(カナ)」の入力欄（text）を探す。
 * ラベル → 同列の input、の順に幅広く探索。
 */
async function findKanaInputInFrame(frame){
  const xpaths = [
    // ラベルに「住宅名」と「カナ」を含む行の text input を拾う（type省略も拾う）
    '//*[contains(normalize-space(string(.)),"住宅名") and contains(normalize-space(string(.)),"カナ")]/ancestor::tr[1]//input[not(@type) or translate(@type,"TEXT","text")="text"][1]',
    // 念のため「住宅」と「カナ」
    '//*[contains(normalize-space(string(.)),"住宅") and contains(normalize-space(string(.)),"カナ")]/ancestor::tr[1]//input[not(@type) or translate(@type,"TEXT","text")="text"][1]',
    // ラベル構造が崩れている場合、id/for などの隣接も拾いたい（先行・後続の input）
    '//*[contains(normalize-space(string(.)),"住宅名") and contains(normalize-space(string(.)),"カナ")]/following::input[not(@type) or translate(@type,"TEXT","text")="text"][1]'
  ];

  for (const xp of xpaths){
    const hs = await frame.$x(xp);
    if (hs && hs.length) return hs[0];
  }

  // name 属性のゆるい当たり（kana を含む）
  const attrGuess = await frame.$('input[name*="kana" i], input[name*="Kana" i], input[name*="KANA" i]');
  if (attrGuess) return attrGuess;

  // 最後のフォールバック：フォーム内の最初の text input
  const firstText = await frame.$('form input[type="text"], form input:not([type])');
  return firstText ?? null;
}

/**
 * フレーム内で「検索する」ボタンを押す
 */
async function clickSearchInFrame(frame){
  const xpaths = [
    '//input[(translate(@type,"SUBMITMAGEBUTON","submitmagebuton")="submit" or translate(@type,"SUBMITMAGEBUTON","submitmagebuton")="image" or translate(@type,"SUBMITMAGEBUTON","submitmagebuton")="button") and (@value="検索する" or @alt="検索する")]',
    '//button[contains(normalize-space(string(.)),"検索する")]'
  ];
  for (const xp of xpaths){
    const hs = await frame.$x(xp);
    if (hs && hs.length){
      await hs[0].click();
      return true;
    }
  }
  // 画像ボタンなど別表現の保険：alt に「検索」
  const imgBtn = await frame.$('input[alt*="検索"]');
  if (imgBtn){ await imgBtn.click(); return true; }
  return false;
}

/**
 * 中継ページ(wait.jsp) → 新ウィンドウ(JKKnet) → frameset へ渡る
 */
async function passRelayAndGetMainPage(browser, currentPage){
  // すでに JKKnet 側のフレーム構造に入っていたらそのまま返す
  if (currentPage.frames().length > 1) return currentPage;

  // 新規 target を待つ（window.open → フォームPOST）
  const targetPromise = new Promise(resolve => {
    const handler = async (target) => {
      if (target.type() === 'page'){
        const p = await target.page();
        // フレームが形成されるまで少し待つ
        setTimeout(() => resolve(p), 500);
        browser.off('targetcreated', handler);
      }
    };
    browser.on('targetcreated', handler);
    // 5秒で諦めて現ページを返す
    setTimeout(() => resolve(currentPage), 5000);
  });

  // 中継ページで自動 submit される。保険として submitNext() を叩く
  try{
    await currentPage.evaluate(() => {
      if (typeof submitNext === 'function') submitNext();
      else {
        const f = document.forms && document.forms.namedItem('forwardForm');
        if (f) f.submit();
      }
    });
  }catch(_){}

  const popup = await targetPromise;
  if (popup !== currentPage){
    try{ await ensureViewport(popup); }catch(_){}
    return popup;
  }
  return currentPage;
}

/**
 * 「おわび」テンプレの検出（トップへ戻るしかないページ）
 */
async function isApologyLike(page){
  try{
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    const t = normalizeTextForMatch(text);
    return t.includes('ページが見つかりません') || t.includes('おわび');
  }catch(_){ return false; }
}

async function main(){
  log('[monitor] Using Chrome at:', EXECUTABLE_PATH);
  const browser = await puppeteer.launch({
    executablePath: EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await ensureViewport(page);

  // 1) TOP
  await gotoWithReferer(page, '/', null);
  await saveHTMLandPNG(page, 'home_1');

  // 2) 検索トップ
  await gotoWithReferer(page, '/search/jkknet/', `${BASE}/`);
  await saveHTMLandPNG(page, 'home_1_after');
  await saveHTMLandPNG(page, 'home_2');

  // 3) インデックス
  await gotoWithReferer(page, '/search/jkknet/index.html', `${BASE}/search/jkknet/`);
  await saveHTMLandPNG(page, 'home_2_after');
  await saveHTMLandPNG(page, 'home_3');

  // 4) サービス入口
  await gotoWithReferer(page, '/search/jkknet/service/', `${BASE}/search/jkknet/index.html`);
  await saveHTMLandPNG(page, 'home_3_after');
  await saveHTMLandPNG(page, 'home_4');

  // 5) StartInit（frameset 直前）
  log('[frameset] direct goto StartInit with referer=/service/');
  await gotoWithReferer(page, '/search/jkknet/service/akiyaJyoukenStartInit', `${BASE}/search/jkknet/service/`);
  await saveHTMLandPNG(page, 'home_4_after');
  await saveHTMLandPNG(page, 'frameset_startinit');

  // 6) 中継ページ → 新ウィンドウ（JKKnet）
  const workingPage = await passRelayAndGetMainPage(browser, page);
  await saveHTMLandPNG(workingPage, 'after_relay_1');

  // 7) 「住宅名（カナ）」が存在するフレームを特定
  const searchFrame =
    await findFrameByLabel(workingPage, '住宅名', 'カナ') ||
    // 予備：検索ボタンの存在で当てる
    workingPage.frames().find(f => /検索/.test((f.url()||''))) ||
    workingPage.mainFrame();

  if (!searchFrame){
    await saveHTMLandPNG(workingPage, 'before_fill');
    throw new Error('検索フォームのフレームが見つかりませんでした。');
  }

  // デバッグ用にフォーム直前を保存
  await saveFrameSnapshot(workingPage, searchFrame, 'before_fill');

  // 8) 入力欄特定 → 入力
  const kanaInput = await findKanaInputInFrame(searchFrame);
  if (!kanaInput){
    await saveFrameSnapshot(workingPage, searchFrame, 'final_error');
    throw new Error('住宅名(カナ) の入力欄が見つかりませんでした。');
  }
  await kanaInput.click({ clickCount: 3 });
  await kanaInput.type(KANA_VALUE);

  // 9) 検索ボタン押下
  const clicked = await clickSearchInFrame(searchFrame);
  if (!clicked){
    await saveFrameSnapshot(workingPage, searchFrame, 'final_error');
    throw new Error('「検索する」ボタンが見つかりませんでした。');
  }

  // 10) 遷移待ち＆保存
  try{
    await workingPage.waitForNetworkIdle({ idleTime: 500, timeout: 8000 });
  }catch(_){}
  // 結果は同じフレーム階層に出る想定
  const afterFrame = await findFrameByLabel(workingPage, '検索', '結果') || searchFrame;
  await saveFrameSnapshot(workingPage, afterFrame, 'after_submit_main');

  // 11) もし「おわび」テンプレならスナップショットだけ保存
  if (await isApologyLike(workingPage)){
    await saveHTMLandPNG(workingPage, 'final');
  } else {
    await saveHTMLandPNG(workingPage, 'final');
  }

  await browser.close();
}

main().catch(async (err) => {
  console.error('Error:', err.message || err);
  try{
    // 失敗時の汎用スナップショット
    // ここでは page を直接掴めないので noop
  }catch(_){}
  process.exit(1);
});
