// monitor.mjs (v9)
// 目的: 「住宅名（カナ）」に 'コーシャハイム' を入れて検索 → 一覧撮影
// 追加: 入力欄を赤枠で撮影 / trace.json に入力値・結果件数などを記録

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const OUT = path.resolve("out");
const S = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = () => new Date().toISOString().replace(/[:.]/g, "-");

// ---- 設定 ----
const CONFIG = {
  headless: (process.env.JKK_HEADLESS || "true") === "true",
  viewport: { width: 1366, height: 960, deviceScaleFactor: 1 },
  timeout: { nav: +(process.env.JKK_NAV_TIMEOUT_MS || 30000), popup: +(process.env.JKK_POPUP_TIMEOUT_MS || 15000) },
  kanaQuery: (process.env.JKK_KANA_QUERY || "コーシャハイム").trim(),
  urls: {
    tops: [
      process.env.JKK_TOP_URL?.trim(),
      "https://www.to-kousya.or.jp/chintai/index.html",
      "https://www.jkk-tokyo.or.jp/",
    ].filter(Boolean),
    starts: [
      process.env.JKK_START_URL?.trim(),
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaStartInit",
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyachizuStartInit",
    ].filter(Boolean),
    servicePost: "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
    referer: "https://www.to-kousya.or.jp/chintai/index.html",
  },
  allowHosts: [
    /(^|\.)to-kousya\.or\.jp$/i,
    /(^|\.)jkk-tokyo\.or\.jp$/i,
    /(^|\.)jhomes\.to-kousya\.or\.jp$/i,
  ],
};

// ---- 簡易トレース出力 ----
const TRACE = {};
const trace = (k, v) => {
  TRACE[k] = v;
  fs.writeFileSync(path.join(OUT, "trace.json"), JSON.stringify(TRACE, null, 2));
};

// ---- ユーティリティ ----
function ensureOut(){ if(!fs.existsSync(OUT)) fs.mkdirSync(OUT,{recursive:true}); }
async function ensureViewport(page){
  const vp = page.viewport(); if(!vp || vp.width<400) await page.setViewport(CONFIG.viewport);
  await page.evaluate(()=>{ try{ window.resizeTo(1366,960);}catch{} });
}
async function saveShot(page, name){
  try{
    await ensureViewport(page);
    await page.waitForFunction('document.readyState!=="loading"&&window.innerWidth>0&&window.innerHeight>0',{timeout:5000}).catch(()=>{});
    const dims = await page.evaluate(()=>({w:window.innerWidth,h:window.innerHeight})).catch(()=>({w:0,h:0}));
    if(!dims || dims.w===0 || dims.h===0){ await page.setViewport(CONFIG.viewport).catch(()=>{}); await S(200); }
    await page.bringToFront().catch(()=>{});
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage:true });
  }catch(e){ fs.writeFileSync(path.join(OUT,`${name}_shot_error.txt`), String(e?.stack||e)); }
}
async function saveHTML(page, name){
  try{ await ensureViewport(page); const html=await page.content(); fs.writeFileSync(path.join(OUT,`${name}.html`),html); }
  catch(e){ fs.writeFileSync(path.join(OUT,`${name}_html_error.txt`), String(e?.stack||e)); }
}
async function dumpFramesHTML(page){
  const frames = page.frames().filter(f=>f!==page.mainFrame());
  for(let i=0;i<frames.length;i++){ try{ const html=await frames[i].content(); fs.writeFileSync(path.join(OUT,`frame_${i}.html`),html);}catch{} }
}
async function hardenNetwork(page){
  await page.setRequestInterception(true);
  page.on("request",(req)=>{
    try{
      const host=new URL(req.url()).hostname;
      const allowed=CONFIG.allowHosts.some(rx=>rx.test(host));
      if(!allowed && req.resourceType()==="script") return req.abort();
      return req.continue();
    }catch{return req.continue();}
  });
}
async function tryClickAny(page, sels){
  return await page.evaluate((selectors)=>{
    function vis(el){ const r=el?.getBoundingClientRect?.(); return r&&r.width>0&&r.height>0;}
    for(const sel of selectors){
      if(sel.startsWith("BUTTON_TEXT=")){
        const text=sel.replace("BUTTON_TEXT=","");
        const btn=[...document.querySelectorAll("button,input[type=button],input[type=submit],input[type=image]")]
          .find(b=>(b.innerText||b.value||b.alt||"").includes(text));
        if(btn&&vis(btn)){ btn.click(); return sel; } continue;
      }
      const el=document.querySelector(sel); if(el&&vis(el)){ el.click(); return sel; }
    }
    return null;
  }, sels);
}
async function waitNavOrNewPage(p, timeout=CONFIG.timeout.nav){
  const browser=p.browser();
  const navSame=p.waitForNavigation({waitUntil:"domcontentloaded",timeout}).then(()=>p).catch(()=>null);
  const newPg = browser.waitForTarget(t=>t.opener()===p.target(),{timeout})
    .then(t=>t?.page().catch(()=>null)).catch(()=>null);
  return (await Promise.race([navSame,newPg])) || p;
}
async function waitPopup(opener, timeout=CONFIG.timeout.popup){
  const t=await opener.browser().waitForTarget(tgt=>tgt.opener()===opener.target(),{timeout}).catch(()=>null);
  const p=t?await t.page().catch(()=>null):null;
  if(p){ await p.setViewport(CONFIG.viewport).catch(()=>{}); await p.waitForFunction('document.body && document.body.clientWidth>0',{timeout:5000}).catch(()=>{}); }
  return p;
}

// ---- 画面判定 ----
async function isTimeoutPage(p){
  try{ const title=typeof p.title==="function"?await p.title():""; if(/おわび|timeout|タイムアウト/i.test(title)) return true; }catch{}
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
  return await p.evaluate(()=>/検索結果|物件|件/.test(document.body?.innerText||""));
}

// ---- 復帰 ----
async function recoverFromTimeout(cur){
  await saveShot(cur,"timeout_detected"); await saveHTML(cur,"timeout_detected");
  await tryClickAny(cur, ['a[href*="to-kousya.or.jp/chintai"]','a[href*="index.html"]','a[href*="backtop"]']);
  await cur.waitForNavigation({waitUntil:"domcontentloaded",timeout:15000}).catch(()=>{});
  await S(300); await saveShot(cur,"after_backtop");

  await cur.setExtraHTTPHeaders({ Referer: CONFIG.urls.referer });
  try{ await cur.goto(CONFIG.urls.starts[0]||CONFIG.urls.starts[1],{waitUntil:"domcontentloaded",timeout:20000}); }catch{}
  const p=await waitPopup(cur,15000); if(p){ await saveShot(p,"popup_after_recover"); await saveHTML(p,"popup_after_recover"); }
  return p;
}

// ---- 条件ページへ寄せる ----
async function forceOpenJyouken(p){
  await p.evaluate((action)=>{ const f=document.createElement("form"); f.method="post"; f.action=action; document.body.appendChild(f); f.submit(); }, CONFIG.urls.servicePost);
  return await waitNavOrNewPage(p, CONFIG.timeout.nav);
}
async function ensureJyouken(p){
  if(await isJyoukenPage(p)) return p;
  if(await isMapPage(p)){ try{ p=await forceOpenJyouken(p);}catch{} if(await isJyoukenPage(p)) return p; }
  try{ p=await forceOpenJyouken(p);}catch{}; return p;
}

// ---- カナ入力＋検索 ----
async function fillKanaAndSearch(p, keyword){
  const info = await p.evaluate((kw)=>{
    const KANA_RX=/(住宅名|建物名).*(カナ|ｶﾅ)|カナ.*(住宅名|建物名)/i;
    const score=(el)=>{
      let s=0; const id=el.id||"", name=el.name||"", ph=el.placeholder||"", title=el.title||"";
      const txt=`${id} ${name} ${ph} ${title}`;
      if(/kana|ｶﾅ|カナ/i.test(txt)) s+=3;
      if(/jyutaku|jutaku|住宅|建物/i.test(txt)) s+=2;
      const lab = id?document.querySelector(`label[for="${id}"]`):null;
      const labTxt=(lab?.innerText||"").trim(); if(KANA_RX.test(labTxt)) s+=4;
      const cell=el.closest("td,th,div,li")||el.parentElement;
      const hint=(cell?.previousElementSibling?.innerText||cell?.innerText||"");
      if(KANA_RX.test(hint)) s+=2;
      if((el.type||"").toLowerCase()==="text"||(el.type||"").toLowerCase()==="search") s+=1;
      return s;
    };
    const cands=[...document.querySelectorAll('input[type="text"],input[type="search"],input:not([type])')]
      .filter(el=>!el.disabled&&!el.readOnly&&el.offsetWidth>0&&el.offsetHeight>0);
    const ranked=cands.map(el=>({el,s:score(el)})).sort((a,b)=>b.s-a.s);
    const target=(ranked[0]?.s>0?ranked[0].el:cands[0]);
    if(!target) return { ok:false };
    try{
      target.focus(); target.value=""; target.dispatchEvent(new Event("input",{bubbles:true}));
      target.value=kw; target.dispatchEvent(new Event("input",{bubbles:true})); target.dispatchEvent(new Event("change",{bubbles:true}));
      // 目印（スクショで見えるよう赤枠）
      target.style.outline="3px solid #ff0033"; target.style.outlineOffset="2px";
      const meta={ ok:true, value:target.value, id:target.id||"", name:target.name||"", placeholder:target.placeholder||"" };
      return meta;
    }catch{ return { ok:false }; }
  }, keyword);

  trace("kana_input", { requested: keyword, ...info });
  await saveShot(p, "jyouken_filled");
  await saveHTML(p, "jyouken_filled");

  // 検索実行（保険で form.submit も）
  await tryClickAny(p, [
    'a[onclick*="akiyaJyoukenRef"]','a[href*="akiyaJyoukenRef"]',
    'img[alt*="検索"]','input[type="image"][alt*="検索"]',
    'input[type="submit"][value*="検索"]','input[type="button"][value*="検索"]',
    'BUTTON_TEXT=検索する','BUTTON_TEXT=検索',
  ]);
  await p.evaluate(()=>{ const f=document.querySelector("form"); f?.submit?.(); });

  return info;
}

// ---- 結果撮影＋サマリ ----
async function setItemsPerPage100(p){
  try{
    await p.evaluate(()=>{
      const selects=[...document.querySelectorAll("select")];
      const s=selects.find(el=>[...el.options||[]].some(o=>o.textContent?.trim()==="100"||o.value==="100"));
      if(s){ s.value="100"; s.dispatchEvent(new Event("change",{bubbles:true})); }
    });
  }catch{}
}
async function captureResult(p){
  await setItemsPerPage100(p); await S(400);
  const summary = await p.evaluate((kw)=>{
    const detailsCount=[...document.querySelectorAll("a,img,input")]
      .filter(el=>/詳細/.test((el.alt||el.value||el.innerText||""))).length;
    const querySeen = (document.body?.innerText||"").includes(kw);
    return { url: location.href, title: document.title, detailsCount, querySeen };
  }, CONFIG.kanaQuery).catch(()=>({}));
  trace("result", summary);

  const ok = await isResultLike(p);
  await saveShot(p, ok?"result_list":"result_fallback");
  await saveHTML(p, ok?"result_list":"result_fallback");
  await dumpFramesHTML(p);
}

// ---- 起動フロー ----
async function launchFromTop(page){
  const topUrl=CONFIG.urls.tops[0];
  await page.goto(topUrl,{waitUntil:"domcontentloaded",timeout:CONFIG.timeout.nav});
  await ensureViewport(page);
  trace("start",{ top: topUrl, at: NOW() });
  await saveShot(page,`entry_referer_${NOW()}`); await saveHTML(page,"entry_referer");

  const clicked = await tryClickAny(page, [
    'a[href*="akiyaJyoukenStartInit"]','a[href*="akiyachizuStartInit"]','a[href*="JKKnet"]',
  ]);
  let popup=null;
  if(clicked) popup=await waitPopup(page, CONFIG.timeout.popup);
  if(!popup){
    await page.setExtraHTTPHeaders({ Referer: CONFIG.urls.referer });
    try{ await page.goto(CONFIG.urls.starts[0]||CONFIG.urls.starts[1],{waitUntil:"domcontentloaded",timeout:CONFIG.timeout.nav}); }catch{}
    popup=await waitPopup(page, CONFIG.timeout.popup);
  }
  if(!popup) throw new Error("JKKnet のポップアップが開きませんでした。");
  await saveShot(popup,"popup_top"); await saveHTML(popup,"popup_top");
  return popup;
}

async function runFlow(popup){
  let p=popup;

  if(await isTimeoutPage(p)){ const r=await recoverFromTimeout(p); if(!r) throw new Error("タイムアウト復帰失敗"); p=r; }

  p = await ensureJyouken(p);
  await saveHTML(p,"popup_jyouken");

  await fillKanaAndSearch(p, CONFIG.kanaQuery);

  p = await waitNavOrNewPage(p, CONFIG.timeout.nav);
  await S(300);

  if(await isTimeoutPage(p)){ const r=await recoverFromTimeout(p); if(!r) throw new Error("検索後タイムアウト復帰失敗"); p=r; }

  await captureResult(p);
}

async function main(){
  ensureOut();
  const browser=await puppeteer.launch({
    headless: CONFIG.headless,
    args:["--no-sandbox","--disable-setuid-sandbox","--window-size=1366,960","--disable-dev-shm-usage"],
    defaultViewport: CONFIG.viewport,
  });

  try{
    const page=await browser.newPage();
    await hardenNetwork(page); await ensureViewport(page);

    let opened=false;
    for(const u of CONFIG.urls.tops){
      try{ await page.goto(u,{waitUntil:"domcontentloaded",timeout:CONFIG.timeout.nav}); opened=true; trace("top_open",u); break; }
      catch(e){ fs.appendFileSync(path.join(OUT,"debug.log"),`TOP open failed ${u}: ${e?.message||e}\n`); }
    }
    if(!opened) throw new Error("賃貸トップに到達できませんでした。");

    await saveShot(page,`landing_${NOW()}`); await saveHTML(page,"landing");

    const popup=await launchFromTop(page);
    await runFlow(popup);
  }catch(e){
    fs.writeFileSync(path.join(OUT,"final_error.txt"), String(e?.stack||e));
  }finally{ await browser.close(); }
}

main().catch(err=>{ console.error(err); process.exit(1); });
