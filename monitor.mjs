// monitor.mjs — JKK 先着順あき家検索：ポップアップ封じ（window.open を同一タブ遷移へ）＆全フレーム探索
import puppeteer from 'puppeteer-core';
import fs from 'fs/promises';
import path from 'path';

const BASE = 'https://jhomes.to-kousya.or.jp';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const VIEW = { width: 1280, height: 1800, deviceScaleFactor: 1 };
const OUT  = '.';
const KANA_WORD = process.env.KANA || 'コーシャハイム';

function norm(s=''){return String(s).replace(/[\s\u3000\r\n\t]+/g,'').replace(/[()（）［］\[\]【】<＞<>:：・*＊]/g,'');}
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

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
async function saveFrame(page, frame, name){
  try{
    await ensureViewport(page);
    const html = await frame.evaluate(()=>document.documentElement.outerHTML);
    await fs.writeFile(path.join(OUT, `${name}.html`), html, 'utf8');
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    console.log(`[saved] ${name}`);
  }catch(e){
    console.log(`[save frame skipped] ${name}: ${e.message}`);
  }
}

async function goto(page, url, referer){
  const abs = url.startsWith('http') ? url : BASE+url;
  console.log('[goto]', url);
  const opts = { waitUntil:'domcontentloaded', timeout: 45000 };
  if (referer) opts['referer'] = BASE+referer;
  await page.goto(abs, opts);
}

async function clickTextIn(frameOrPage, text){
  const ok = await frameOrPage.evaluate((t)=>{
    const N=s=>String(s||'').replace(/\s+/g,'');
    const els=[...document.querySelectorAll('a,button,input[type="submit"],input[type="button"],input[type="image"]')];
    const el = els.find(e=> N(e.value||e.textContent||e.alt||'').includes(N(t)));
    if (el){ (el instanceof HTMLElement) && el.click(); return true; }
    return false;
  }, text);
  return ok;
}

async function dumpAllFrames(p, tag){
  const fsList = p.frames();
  console.log(`[frames] ${tag} count=${fsList.length}`);
  let i=0;
  for (const f of fsList){
    let head=''; try{head = await f.evaluate(()=> (document.body?.innerText||'').slice(0,120));}catch{}
    console.log(`[frame#${i}] url=${f.url()} head=${head.replace(/\n/g,' ')}`);
    await saveFrame(p, f, `frames_dump_${tag}_${i}`);
    i++;
  }
}

async function pickSearchFrame(page){
  // 「検索」ボタンやテキスト入力があるフレームを優先
  const frames = page.frames();
  for (const f of frames){
    const score = await f.evaluate(()=>{
      const hasBtn  = !!document.querySelector('input[type="submit"],input[type="button"],input[type="image"],button,a');
      const hasText = !!document.querySelector('input[type="text"],input:not([type]),input[type="search"]');
      const body    = (document.body && document.body.innerText) || '';
      const hint    = /先着順|検索|住宅名|カナ/.test(body);
      return (hasBtn?1:0) + (hasText?1:0) + (hint?1:0);
    }).catch(()=>0);
    if (score>=2) return f;
  }
  return null;
}

async function pickKanaSelectorInFrame(frame){
  const sel = await frame.evaluate(()=>{
    const N=(s)=>String(s||'').replace(/[\s\u3000\r\n\t]+/g,'').replace(/[()（）［］\[\]【】<＞<>:：・*＊]/g,'');
    const isKanaLabel = (t)=>{ const n=N(t); return n.includes('住宅名カナ') || (n.includes('住宅名')&&n.includes('カナ')); };

    // label[for]
    for (const lab of Array.from(document.querySelectorAll('label'))){
      if (isKanaLabel(lab.textContent||'')){
        const id = lab.getAttribute('for');
        if (id) return `#${CSS.escape(id)}`;
      }
    }
    // 表の同一行
    for (const cell of Array.from(document.querySelectorAll('td,th'))){
      if (isKanaLabel(cell.textContent||'')){
        const tr = cell.closest('tr');
        if (tr){
          const cand = tr.querySelector('input[type="text"],input:not([type]),input[type="search"]');
          if (cand){
            if (cand.id) return `#${CSS.escape(cand.id)}`;
            if (cand.name) return `[name="${cand.name}"]`;
            return 'input[type="text"],input:not([type]),input[type="search"]';
          }
        }
      }
    }
    // フォールバック
    const fb = Array.from(document.querySelectorAll('input[type="text"],input:not([type]),input[type="search"]'))
      .find(el=> /カナ|kana|ｶﾅ/i.test([el.name, el.id, el.title, el.getAttribute('aria-label')].join('')));
    if (fb){
      if (fb.id) return `#${CSS.escape(fb.id)}`;
      if (fb.name) return `[name="${fb.name}"]`;
      return 'input[type="text"],input:not([type]),input[type="search"]';
    }
    return null;
  });
  return sel;
}

async function clickSearchInFrame(frame){
  const clicked = await frame.evaluate(()=>{
    const N=s=>String(s||'').replace(/\s+/g,'');
    const btns=[...document.querySelectorAll('input[type="submit"],input[type="button"],input[type="image"],button,a')];
    const byText = btns.find(b=>{
      const t=N(b.value||b.textContent||b.getAttribute('alt')||'');
      return t.includes('検索する') || t.includes('検索');
    });
    if (byText){ (byText instanceof HTMLElement) && byText.click(); return true; }
    const f = document.querySelector('form[action*="Jyouken"]') || document.querySelector('form');
    if (f){ f.submit(); return true; }
    return false;
  });
  return clicked;
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

    // ★ 重要：window.open を“同一タブ遷移”に書き換え（ポップアップを封じる）
    await page.addInitScript(() => {
      const origOpen = window.open;
      window.open = function(url){ try{ location.href = url; }catch(e){} return window; };
      // submitNext() が window.open を使っても同一タブで遷移させる
    });

    // 入口を正しい順序で辿る（Referer が重要）
    await goto(page, '/');                             await save(page, 'home_1');
    await goto(page, '/search/jkknet/');              await save(page, 'home_1_after');
    await goto(page, '/search/jkknet/index.html');    await save(page, 'home_2');
    await goto(page, '/search/jkknet/service/');      await save(page, 'home_2_after');

    // StartInit（ここで wait.jsp → 本体フォームへ）
    console.log('[frameset] direct goto StartInit with referer=/service/');
    await goto(page, '/search/jkknet/service/akiyaJyoukenStartInit', '/search/jkknet/service/');
    await save(page, 'frameset_startinit');

    // まず「こちら」をクリックしてみる
    await clickTextIn(page, 'こちら');
    await page.waitForNavigation({waitUntil:'domcontentloaded', timeout: 10000}).catch(()=>{});
    await save(page, 'after_relay_1');

    // まだ StartInit 表示なら submitNext() → それも無理なら wait.jsp に直で入る
    if ((await page.content()).includes('自動で次の画面') || page.url().includes('akiyaJyoukenStartInit')){
      await page.evaluate(()=>{ try{ if (typeof submitNext==='function') submitNext(); }catch(e){} });
      await page.waitForNavigation({waitUntil:'domcontentloaded', timeout: 8000}).catch(()=>{});
    }
    if ((await page.content()).includes('自動で次の画面') || page.url().includes('akiyaJyoukenStartInit')){
      await goto(page, '/search/jkknet/wait.jsp', '/search/jkknet/service/akiyaJyoukenStartInit');
    }

    // wait.jsp 側で forwardForm があれば送信
    await page.evaluate(()=>{
      try{
        const f = (document.forms && (document.forms.forwardForm || document.forms[0])) || document.querySelector('form');
        f && f.submit();
      }catch(e){}
    });
    await page.waitForNavigation({waitUntil:'domcontentloaded', timeout: 15000}).catch(()=>{});
    await save(page, 'before_fill');

    // ここからは「同一タブ」で本体フォームを探索
    await dumpAllFrames(page, 'before');
    let sFrame = await pickSearchFrame(page);
    if (!sFrame){
      // もし mainFrame にフォームが直載りならそれも考慮
      sFrame = page.mainFrame();
    }

    // 「住宅名(カナ)」の入力欄を特定
    const sel = await pickKanaSelectorInFrame(sFrame);
    console.log('[pick] kana selector =', sel);
    if (!sel){
      await saveFrame(page, sFrame, 'final_error');
      throw new Error('住宅名(カナ) の入力欄が見つかりませんでした。');
    }

    // 入力
    await sFrame.focus(sel).catch(()=>{});
    await sFrame.evaluate((sel)=>{
      const el = document.querySelector(sel);
      if (el){ el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); }
    }, sel);
    await sFrame.type(sel, KANA_WORD, { delay: 10 });

    // 検索実行
    const clicked = await clickSearchInFrame(sFrame);
    if (!clicked){
      await sFrame.evaluate(()=>{
        const f = document.querySelector('form[action*="Jyouken"]') || document.querySelector('form');
        f && f.submit();
      });
    }

    await page.waitForNavigation({waitUntil:'domcontentloaded', timeout: 20000}).catch(()=>{});
    await dumpAllFrames(page, 'after');
    await save(page, 'final');

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
