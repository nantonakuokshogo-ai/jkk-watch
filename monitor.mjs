// monitor.mjs (v12)
// 目的: 「住宅名（カナ）」に 'コーシャハイム' を入れて検索 → 一覧を撮影
// 強化点:
//  - フレームを動的に再取得（Execution context was destroyed を回避）
//  - 公式 submitAction('akiyaJyoukenRef') を優先的に実行＋Promise.allでナビ待ち
//  - 入力欄を赤枠で撮影、trace.json に入力・結果を記録
//  - タイムアウト画面の自動復帰、フレームHTMLダンプ

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const OUT = path.resolve("out");
const S = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = () => new Date().toISOString().replace(/[:.]/g, "-");

// ===== 設定 =====
const CONFIG = {
  headless: (process.env.JKK_HEADLESS || "true") === "true",
  viewport: { width: 1366, height: 960, deviceScaleFactor: 1 },
  timeout: { nav: +(process.env.JKK_NAV_TIMEOUT_MS || 30000), popup: +(process.env.JKK_POPUP_TIMEOUT_MS || 15000) },
  kanaQuery: (process.env.JKK_KANA_QUERY || "コーシャハイム").trim(),
  urls: {
    tops: [
      process.env.JKK_TOP_URL?.trim(),
      "https://www.to-kousya.or.jp/chintai/index.html",
      "https://www.jkk-tokyo.or.jp/"
    ].filter(Boolean),
    starts: [
      process.env.JKK_START_URL?.trim(),
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaStartInit",
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyachizuStartInit"
    ].filter(Boolean),
    servicePost: "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
    referer: "https://www.to-kousya.or.jp/chintai/index.html"
  },
  allowHosts: [
    /(^|\.)to-kousya\.or\.jp$/i,
    /(^|\.)jkk-tokyo\.or\.jp$/i,
    /(^|\.)jhomes\.to-kousya\.or\.jp$/i,
  ],
};

// ===== トレース =====
const TRACE = {};
const trace = (k, v) => {
  TRACE[k] = v;
  try { fs.writeFileSync(path.join(OUT, "trace.json"), JSON.stringify(TRACE, null, 2)); } catch {}
};

// ===== ユーティリティ =====
function ensureOut(){ if(!fs.existsSync(OUT)) fs.mkdirSync(OUT,{recursive:true}); }
async function ensureViewport(page){
  const vp = page.viewport(); if(!vp || vp.width < 400) await page.setViewport(CONFIG.viewport);
  await page.evaluate(()=>{ try{ window.resizeTo(1366,960);}catch{} });
}
async function saveShot(page, name){
  try{
    await ensureViewport(page);
    await page.waitForFunction('document.readyState!=="loading" && innerWidth>0 && innerHeight>0',{timeout:5000}).catch(()=>{});
    await page.bringToFront().catch(()=>{});
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  }catch(e){ try{ fs.writeFileSync(path.join(OUT,`${name}_shot_error.txt`), String(e?.stack||e)); }catch{} }
}
async function saveHTML(page, name){
  try{ await ensureViewport(page); const html = await page.content(); fs.writeFileSync(path.join(OUT,`${name}.html`), html); }
  catch(e){ try{ fs.writeFileSync(path.join(OUT,`${name}_html_error.txt`), String(e?.stack||e)); }catch{} }
}
async function dumpFramesHTML(page){
  const fsList = page.frames().filter(f => f !== page.mainFrame());
  for (let i=0;i<fsList.length;i++){
    try{ const html = await fsList[i].content(); fs.writeFileSync(path.join(OUT,`frame_${i}.html`), html); }catch{}
  }
}
async function hardenNetwork(page){
  await page.setRequestInterception(true);
  page.on("request",(req)=>{
    try{
      const host = new URL(req.url()).hostname;
      const allowed = CONFIG.allowHosts.some(rx => rx.test(host));
      if(!allowed && req.resourceType()==="script") return req.abort();
      return req.continue();
    }catch{return req.continue();}
  });
}
async function tryClickAny(page, sels){
  return await page.evaluate((selectors)=>{
    const vis = el => { const r = el?.getBoundingClientRect?.(); return r && r.width>0 && r.height>0; };
    for (const sel of selectors){
      if (sel.startsWith("BUTTON_TEXT=")){
        const t = sel.replace("BUTTON_TEXT=","");
        const btn = [...document.querySelectorAll("button,input[type=submit],input[type=button],input[type=image]")]
          .find(b => (b.innerText||b.value||b.alt||"").includes(t));
        if (btn && vis(btn)){ btn.click(); return sel; }
        continue;
      }
      const el = document.querySelector(sel);
      if (el && vis(el)){ el.click(); return sel; }
    }
    return null;
  }, sels);
}
async function waitNavOrNewPage(p, timeout=CONFIG.timeout.nav){
  const browser = p.browser();
  const same = p.waitForNavigation({waitUntil:"domcontentloaded",timeout}).then(()=>p).catch(()=>null);
  const newer = browser.waitForTarget(t=>t.opener()===p.target(),{timeout}).then(t=>t?.page().catch(()=>null)).catch(()=>null);
  return (await Promise.race([same,newer])) || p;
}
async function waitPopup(opener, timeout=CONFIG.timeout.popup){
  const t = await opener.browser().waitForTarget(tg=>tg.opener()===opener.target(),{timeout}).catch(()=>null);
  const p = t ? await t.page().catch(()=>null) : null;
  if (p){ await p.setViewport(CONFIG.viewport).catch(()=>{}); }
  return p;
}

// ===== 判定 =====
async function isTimeoutPage(p){
  try{ const t = typeof p.title==="function" ? await p.title() : ""; if(/おわび|timeout|タイムアウト/i.test(t)) return true; }catch{}
  return await p.evaluate(()=>/タイムアウト|おわび/.test(document.body?.innerText||""));
}
async function isMapPage(p){
  const u=(p.url()||"").toLowerCase(); if(/akiyachizu/.test(u)) return true;
  return await p.evaluate(()=>!!document.querySelector('map[name="Map"]'));
}
async function isJyoukenPage(p){
  const u=(p.url()||"").toLowerCase();
  if(/akiyajyouken/.test(u)) return true;
  return await p.evaluate(()=>/先着順あき家検索|条件|こだわり|エリア|検索/.test(document.body?.innerText||""));
}
async function isResultLike(p){
  const u=(p.url()||"").toLowerCase();
  if(/result|list|kensaku|search/.test(u)) return true;
  return await p.evaluate(()=>{
    const items=[...document.querySelectorAll("a,img,input")]
      .filter(el=>/詳細/.test((el.alt||el.value||el.innerText||"")));
    const titleish=/検索結果|物件一覧|件/.test(document.body?.innerText||"");
    return items.length>0 && titleish;
  });
}

// ===== 復帰 =====
async function recoverFromTimeout(cur){
  await saveShot(cur,"timeout_detected"); await saveHTML(cur,"timeout_detected");
  await tryClickAny(cur,['a[href*="to-kousya.or.jp/chintai"]','a[href*="index.html"]','a[href*="backtop"]']);
  await cur.waitForNavigation({waitUntil:"domcontentloaded",timeout:15000}).catch(()=>{});
  await S(300);
  await saveShot(cur,"after_backtop");
  await cur.setExtraHTTPHeaders({ Referer: CONFIG.urls.referer });
  try{ await cur.goto(CONFIG.urls.starts[0] || CONFIG.urls.starts[1], {waitUntil:"domcontentloaded",timeout:20000}); }catch{}
  const p = await waitPopup(cur,15000);
  if (p){ await saveShot(p,"popup_after_recover"); await saveHTML(p,"popup_after_recover"); }
  return p;
}

// ===== 条件ページへ寄せる =====
async function forceOpenJyouken(p){
  await p.evaluate((action)=>{ const f=document.createElement("form"); f.method="post"; f.action=action; document.body.appendChild(f); f.submit(); }, CONFIG.urls.servicePost);
  return await waitNavOrNewPage(p, CONFIG.timeout.nav);
}
async function ensureJyouken(p){
  if (await isJyoukenPage(p)) return p;
  if (await isMapPage(p)){ try{ p=await forceOpenJyouken(p); }catch{} if (await isJyoukenPage(p)) return p; }
  try{ p=await forceOpenJyouken(p); }catch{}
  return p;
}

// ===== フレーム補助 =====
async function findFrameBySelector(page, selector, ms=5000){
  const deadline = Date.now()+ms;
  while(Date.now()<deadline){
    for(const f of page.frames()){
      try{
        const h = await f.$(selector);
        if (h){ const vis = await f.evaluate(el=>{ const r=el.getBoundingClientRect(); return r.width>0&&r.height>0 && !el.disabled; }, h).catch(()=>false);
          if (vis) return f;
        }
      }catch{}
    }
    await S(200);
  }
  return null;
}

// ===== カナ入力＋検索 =====
async function fillKanaAndSearch(popup, keyword){
  // 条件ブロックを開く
  try{
    await popup.evaluate(()=>{
      const openers=[...document.querySelectorAll('img, a, span')]
        .filter(el=>/こだわり|さらにこだわり条件|指定して検索/.test(el.alt||el.innerText||""));
      if(openers[0]) openers[0].click();
    });
  }catch{}
  await S(200);

  const kanaSel = 'input[name="akiyaInitRM.akiyaRefM.jyutakuKanaName"]';
  // 欄を持つフレームを探す（見つからない場合は mainFrame を使いつつ再試行）
  let frame = await findFrameBySelector(popup, kanaSel, 6000) || popup.mainFrame();

  const info = await (async ()=>{
    try{
      await frame.waitForSelector(kanaSel, {visible:true, timeout:4000});
    }catch{
      // 再取得してもう一度
      frame = await findFrameBySelector(popup, kanaSel, 4000) || popup.mainFrame();
      await frame.waitForSelector(kanaSel, {visible:true, timeout:4000}).catch(()=>{});
    }
    const res = await frame.evaluate((sel, kw)=>{
      const toKatakana = s=>s.replace(/[\u3041-\u3096]/g,c=>String.fromCharCode(c.charCodeAt(0)+0x60));
      const el = document.querySelector(sel);
      const result = { ok:false, value:"", used: sel };
      if(!el) return result;
      el.focus(); el.value=""; el.dispatchEvent(new Event("input",{bubbles:true}));
      el.value = toKatakana(kw);
      el.dispatchEvent(new Event("input",{bubbles:true}));
      el.dispatchEvent(new Event("change",{bubbles:true}));
      el.style.outline="3px solid #ff0033"; el.style.outlineOffset="2px";
      return { ok:true, value: el.value, used: el.name||el.id||sel };
    }, kanaSel, keyword).catch(()=>({ok:false,value:"",used:""}));
    return res;
  })();

  trace("kana_input", { requested: keyword, ...info });
  await saveShot(popup, "jyouken_filled"); // ここで撮る（遷移前）
  await saveHTML(popup, "jyouken_filled");

  // 公式 submit を先に試し、なければクリック、最後に form.submit
  const submitPromise = (async ()=>{
    const tried = await frame.evaluate(()=>{
      if (typeof submitAction === "function"){ submitAction('akiyaJyoukenRef'); return "submitAction"; }
      return null;
    }).catch(()=>null);
    if (tried) return tried;

    // 画像ボタン等
    const clicked = await frame.evaluate(()=>{
      const cand=[...document.querySelectorAll('input[type="image"],input[type="submit"],input[type="button"],button')]
        .find(el=>/検索/.test(el.alt||el.value||el.innerText||""));
      if(cand){ cand.click(); return "click"; }
      return null;
    }).catch(()=>null);
    if (clicked) return clicked;

    // フォールバック
    await frame.evaluate(()=>{ const f=document.forms["akiSearch"]||document.querySelector("form"); f?.submit?.(); }).catch(()=>{});
    return "form.submit";
  })();

  await Promise.race([
    Promise.all([ popup.waitForNavigation({waitUntil:"domcontentloaded", timeout: CONFIG.timeout.nav}).catch(()=>null), submitPromise ]),
    (async()=>{ await S(2000); return null; })(), // 最悪ナビしなくても先に進む
  ]);
}

// ===== 結果撮影＋要約 =====
async function setItemsPerPage100(p){ try{
  await p.evaluate(()=>{ const s=[...document.querySelectorAll("select")]
    .find(el=>[...el.options||[]].some(o=>o.textContent?.trim()==="100"||o.value==="100"));
    if(s){ s.value="100"; s.dispatchEvent(new Event("change",{bubbles:true})); }
  });
}catch{}}

async function captureResult(p){
  await setItemsPerPage100(p); await S(500);
  const summary = await p.evaluate((kw)=>{
    const detailsCount=[...document.querySelectorAll("a,img,input")].filter(el=>/詳細/.test((el.alt||el.value||el.innerText||""))).length;
    const rows=[...document.querySelectorAll("table tr")].length;
    const querySeen=(document.body?.innerText||"").includes(kw);
    return { url: location.href, title: document.title, detailsCount, rows, querySeen };
  }, CONFIG.kanaQuery).catch(()=>({}));
  trace("result", summary);

  const ok = await isResultLike(p);
  await saveShot(p, ok ? "result_list" : "result_fallback");
  await saveHTML(p, ok ? "result_list" : "result_fallback");
  await dumpFramesHTML(p);
}

// ===== 起動フロー =====
async function launchFromTop(page){
  const topUrl = CONFIG.urls.tops[0];
  await page.goto(topUrl,{waitUntil:"domcontentloaded",timeout:CONFIG.timeout.nav});
  await ensureViewport(page);
  trace("start",{ top: topUrl, at: NOW() });
  await saveShot(page,`entry_referer_${NOW()}`); await saveHTML(page,"entry_referer");

  const clicked = await tryClickAny(page, [
    'a[href*="akiyaJyoukenStartInit"]',
    'a[href*="akiyachizuStartInit"]',
    'a[href*="JKKnet"]'
  ]);
  let popup=null;
  if (clicked) popup = await waitPopup(page, CONFIG.timeout.popup);

  if (!popup){
    await page.setExtraHTTPHeaders({ Referer: CONFIG.urls.referer });
    try{ await page.goto(CONFIG.urls.starts[0]||CONFIG.urls.starts[1],{waitUntil:"domcontentloaded",timeout:CONFIG.timeout.nav}); }catch{}
    popup = await waitPopup(page, CONFIG.timeout.popup);
  }
  if (!popup) throw new Error("JKKnet のポップアップが開きませんでした。");
  await saveShot(popup,"popup_top"); await saveHTML(popup,"popup_top");
  return popup;
}

async function runFlow(popup){
  let p=popup;
  if (await isTimeoutPage(p)){ const r=await recoverFromTimeout(p); if(!r) throw new Error("タイムアウト復帰失敗"); p=r; }
  p = await ensureJyouken(p); await saveHTML(p,"popup_jyouken");
  await fillKanaAndSearch(p, CONFIG.kanaQuery);
  p = await waitNavOrNewPage(p, CONFIG.timeout.nav); await S(400);
  if (await isTimeoutPage(p)){ const r=await recoverFromTimeout(p); if(!r) throw new Error("検索後タイムアウト復帰失敗"); p=r; }
  await captureResult(p);
}

async function main(){
  ensureOut();
  const browser = await puppeteer.launch({
    headless: CONFIG.headless,
    args: ["--no-sandbox","--disable-setuid-sandbox","--window-size=1366,960","--disable-dev-shm-usage"],
    defaultViewport: CONFIG.viewport,
  });

  try{
    const page = await browser.newPage();
    await hardenNetwork(page); await ensureViewport(page);

    let opened=false;
    for(const u of CONFIG.urls.tops){
      try{ await page.goto(u,{waitUntil:"domcontentloaded",timeout:CONFIG.timeout.nav}); opened=true; trace("top_open",u); break; }
      catch(e){ try{ fs.appendFileSync(path.join(OUT,"debug.log"),`TOP open failed ${u}: ${e?.message||e}\n`);}catch{} }
    }
    if(!opened) throw new Error("賃貸トップに到達できませんでした。");

    await saveShot(page,`landing_${NOW()}`); await saveHTML(page,"landing");

    const popup = await launchFromTop(page);
    await runFlow(popup);
  }catch(e){
    try{ fs.writeFileSync(path.join(OUT,"final_error.txt"), String(e?.stack||e)); }catch{}
  }finally{ await browser.close(); }
}

main().catch(err=>{ console.error(err); process.exit(1); });
