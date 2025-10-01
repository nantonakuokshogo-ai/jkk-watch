// monitor.mjs — フォーム入力は一旦スキップして、一覧(50件表示)に直行して文字ヒットを検出する版
import puppeteer from 'puppeteer-core';
import fs from 'fs/promises';
import path from 'path';

const BASE = 'https://jhomes.to-kousya.or.jp';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const VIEW = { width: 1280, height: 1800, deviceScaleFactor: 1 };
const OUT  = '.';

// ここを狙いのキーワードに変える（全角/半角どっちも見る）
const KEYWORD = process.env.KANA || 'コーシャハイム';

async function ensureViewport(page){
  await page.setViewport(VIEW);
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({'Accept-Language':'ja,en-US;q=0.9,en;q=0.8'});
}

async function save(page, name){
  try{
    await ensureViewport(page);
    const html = await page.content();
    await fs.writeFile(path.join(OUT, `${name}.html`), html, 'utf8');
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    console.log(`[saved] ${name}`);
  }catch(e){
    console.log(`[save skipped] ${name}: ${e.message}`);
  }
}

async function goto(page, url, referer){
  const abs = url.startsWith('http') ? url : BASE+url;
  console.log('[goto]', url);
  const opts = { waitUntil:'domcontentloaded', timeout: 45000 };
  if (referer) opts['referer'] = BASE+referer;
  await page.goto(abs, opts);
}

function hasApology(html){
  return /JKKねっと：おわび/.test(html) || /おわび/.test(html);
}

function includesKeyword(text, kw){
  const half = kw.replace(/コ/g,'ｺ').replace(/ー/g,'ｰ').replace(/シャ/g,'ｼｬ').replace(/ハ/g,'ﾊ').replace(/イ/g,'ｲ').replace(/ム/g,'ﾑ'); // 超雑な半角化
  return text.includes(kw) || text.includes(half);
}

async function main(){
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
  console.log('[monitor] Using Chrome at:', executablePath);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1280,1800','--lang=ja-JP'],
    defaultViewport: VIEW,
    protocolTimeout: 120_000,
  });

  try{
    const page = await browser.newPage();
    await ensureViewport(page);

    // 入口を正しく踏んで Cookie/Referer を整える
    await goto(page, '/');                             await save(page, 'home_1');
    await goto(page, '/search/jkknet/');              await save(page, 'home_1_after');
    await goto(page, '/search/jkknet/index.html');    await save(page, 'home_2');
    await goto(page, '/search/jkknet/service/');      await save(page, 'home_2_after');

    // StartInit まで踏む（セッションを厳格にするため）
    await goto(page, '/search/jkknet/service/akiyaJyoukenStartInit', '/search/jkknet/service/');
    await save(page, 'frameset_startinit');

    // ★ 一覧ページを直接開く（50件表示）
    const listPath = '/search/jkknet/service/AKIYAchangeCount?condRecNum=50';
    await goto(page, listPath, '/search/jkknet/service/akiyaJyoukenStartInit');
    await save(page, 'list_50');

    const html = await page.content();
    if (hasApology(html)) {
      console.log('[list] got apology page — refererやセッションの通し方がまだ足りない可能性');
      // 追加の足場：service/に戻ってからもう一回
      await goto(page, '/search/jkknet/service/', '/search/jkknet/index.html');
      await goto(page, '/search/jkknet/service/AKIYAchangeCount?condRecNum=50', '/search/jkknet/service/');
      await save(page, 'list_50_retry');
    }

    // 画面テキストでキーワード検出（まずはページ1だけ）
    const text = await page.evaluate(()=>document.body ? document.body.innerText : '');
    const hit = includesKeyword(text, KEYWORD);
    console.log(`[detect] keyword="${KEYWORD}" hit=${hit}`);

    if (!hit) {
      console.log('[note] 1ページ目(50件)にヒットなし。複数ページがある場合は次へを辿る実装に拡張可能。');
    }

  }catch(err){
    console.error('Error:', err.message || err);
    try{
      const pages = await browser.pages();
      const p = pages[pages.length-1];
      if (p) await save(p, 'final_error');
    }catch{}
    process.exitCode = 1;
  }finally{
    await browser.close().catch(()=>{});
  }
}

main();
