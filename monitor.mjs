// monitor.mjs (v3.1)
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const OUT = path.resolve("out");
const S = (ms) => new Promise((r) => setTimeout(r, ms));

const TOPS = [
  "https://www.jkk-tokyo.or.jp/",
  "http://www.jkk-tokyo.or.jp/",
  "https://jkk-tokyo.or.jp/",
  "http://jkk-tokyo.or.jp/",
];

const STARTS = [
  "https://www.jkk-tokyo.or.jp/search/jkknet/startinit.html",
  "http://www.jkk-tokyo.or.jp/search/jkknet/startinit.html",
  "https://jkk-tokyo.or.jp/search/jkknet/startinit.html",
  "http://jkk-tokyo.or.jp/search/jkknet/startinit.html",
];

// wait.jsp → forwardForm が最終的に叩く先（保存HTMLより）
const SERVICE_ACTION = "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit";

async function ensureOut(){ if(!fs.existsSync(OUT)) fs.mkdirSync(OUT, {recursive:true}); }
async function ensureViewport(page){
  try{
    const vp = page.viewport();
    if(!vp || !vp.width || !vp.height || vp.width<320 || vp.height<320){
      await page.setViewport({width:1366, height:960, deviceScaleFactor:1});
    }
    await page.evaluate(()=>{ try{ window.resizeTo(1366,960); }catch{} });
  }catch{}
}
async function saveShot(page, name){
  try{
    await ensureViewport(page);
    await page.bringToFront().catch(()=>{});
    await page.screenshot({path: path.join(OUT, `${name}.png`), fullPage:true, captureBeyondViewport:false});
  }catch(e){
    fs.writeFileSync(path.join(OUT, `${name}_shot_error.txt`), String(e?.stack||e));
  }
}
async function saveHTML(page, name){
  try{
    await ensureViewport(page);
    const html = await page.content();
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  }catch(e){
    fs.writeFileSync(path.join(OUT, `${name}_html_error.txt`), String(e?.stack||e));
  }
}
function cardSkipped(reason, tried){
  const html = `<!doctype html><meta charset="utf-8"><style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans JP',sans-serif;background:#f6f7f9;margin:0;padding:60px}
  .card{max-width:720px;margin:80px auto;background:#fff;border-radius:14px;padding:28px 32px;box-shadow:0 8px 28px rgba(0,0,0,.08)}
  pre{white-space:pre-wrap;background:#fafafa;padding:10px 12px;border-radius:8px}
  </style><div class=card><h1>entry skipped</h1>
  <pre>${reason}</pre><pre>tried: ${tried.join(", ")}</pre>
  <small>${new Date().toISOString()}</small></div>`;
  fs.writeFileSync(path.join(OUT, "entry_referer_skipped.html"), html);
}
async function gotoOne(page, url, name){
  try{
    await ensureViewport(page);
    const res = await page.goto(url, {waitUntil:"domcontentloaded", timeout:25000});
    if(res && res.ok()){ await saveShot(page, name); await saveHTML(page, name); return true; }
  }catch{}
  return false;
}
async function gotoByCandidates(page, candidates, prefix){
  const tried=[];
  for(const u of candidates){ tried.push(u); if(await gotoOne(page,u,prefix)) return {ok:true, tried}; }
  return {ok:false, tried};
}

// ===== Popup 捕捉 =====
async function waitJkkPopup(page, timeout=15000){
  const target = await page.browser().waitForTarget(t=>{
    const u=(t.url()||"").toLowerCase();
    return u.includes("wait.jsp") || u.includes("jkknet") || u.includes("to-kousya.or.jp");
  }, {timeout}).catch(()=>null);
  if(!target) return null;
  const p = await target.page().catch(()=>null);
  if(p) await ensureViewport(p);
  return p;
}

// ===== startinit からの立ち上げ =====
async function launchFromStartPage(page){
  await S(500);
  await saveShot(page, "start_page");
  await saveHTML(page, "start_page");

  let popup = await waitJkkPopup(page, 3000);
  if(popup) return popup;

  const triggered = await page.evaluate(()=>{
    try{
      if(typeof openMainWindow==="function"){ openMainWindow(); return true; }
      if(typeof submitNext==="function"){ submitNext(); return true; }
      const a=[...document.querySelectorAll("a")].find(x=>/こちら/.test(x.innerText));
      if(a){ a.click(); return true; }
    }catch{}
    return false;
  });
  if(triggered){
    popup = await waitJkkPopup(page, 12000);
    if(popup) return popup;
  }
  return page;
}

// ===== 直POST（最終手段） =====
async function openServiceDirect(page){
  await ensureViewport(page);
  await page.setContent(`
    <!doctype html><meta charset="utf-8">
    <form id="f" method="post" action="${SERVICE_ACTION}">
      <input type="hidden" name="redirect" value="true">
      <input type="hidden" name="url" value="${SERVICE_ACTION}">
    </form>
    <script>document.getElementById('f').submit()</script>
  `);
  await S(600);
  const popup = await waitJkkPopup(page, 8000);
  return popup || page;
}

// ===== 画面の種類を判定 =====
async function isMapPage(p){
  const u=(p.url()||"").toLowerCase();
  if(/akiyachizu/i.test(u)) return true;
  return await p.evaluate(()=> !!document.querySelector('map[name="Map"]') );
}
async function isJyoukenPage(p){
  const u=(p.url()||"").toLowerCase();
  if(/akiyajyouken/i.test(u)) return true;
  return await p.evaluate(()=> !!document.querySelector('form[name="akiSearch"]') );
}

// ===== マップにいたら「条件から検索」に戻す =====
async function ensureJyouken(p){
  if(await isMapPage(p)){
    await p.evaluate(()=>{ try{ if(typeof areaOpen==="function") areaOpen(); }catch{} }); // 条件画面初期化
    await S(800);
  }
  return p;
}

// ===== 結果待機 =====
async function waitResultLike(p, timeoutMs=25000){
  const deadline=Date.now()+timeoutMs;
  const urlLike=(u)=>/result|list|kensaku|akiya.*ref|searchresult|_result|index\.php/i.test(u);
  while(Date.now()<deadline){
    await ensureViewport(p);
    const u=p.url();
    if(urlLike(u)) return `url(${u})`;
    const textHit=await p.evaluate(()=>/検索結果|該当件数|物件一覧|該当物件|空家情報/i.test(document.body?.innerText||""));
    if(textHit) return "text-hit";
    const selHit=await p.$([
      ".result-list",".search-result",".list","table.result",
      '[class*="result"]','[id*="result"]'
    ].join(","));
    if(selHit) return "selector";
    await S(500);
  }
  throw new Error("結果待機がタイムアウトしました。");
}

// ===== “検索する” を厳密に押す =====
async function clickSearchStrict(p){
  await ensureViewport(p);
  await S(300);
  // 第一優先：条件画面の本命ボタン（画像ボタン/onclick = submitPage('akiyaJyoukenRef')）
  const candidates = [
    'a[onclick*="akiyaJyoukenRef"]',
    'img[alt*="検索"]',
    'img[src*="bt_kensaku"]',
    'input[type="image"][alt*="検索"]',
    'input[type="submit"][value*="検索"]',
    'button:has-text("検索")'
  ];
  for(const sel of candidates){
    const el = await p.$(sel);
    if(!el) continue;
    await saveShot(p, "pre_click");
    await p.evaluate(el => el.click(), el);
    await S(500);
    await saveShot(p, "post_click");
    return true;
  }
  // 最後の手：関数を直接叩く
  const invoked = await p.evaluate(()=>{
    try{
      if(typeof submitPage==="function"){ submitPage('akiyaJyoukenRef'); return true; }
      if(typeof submitAction==="function"){ submitAction('akiyaJyoukenRef'); return true; }
    }catch{}
    return false;
  });
  if(invoked){
    await S(600);
    await saveShot(p, "post_click");
    return true;
  }
  return false;
}

// ===== 検索実行フロー =====
async function runSearch(p){
  p = await ensureJyouken(p);           // マップに迷い込んでいたら条件に戻す（areaOpen）
  await ensureViewport(p);
  await saveShot(p, "search_landing");
  await saveHTML(p, "search_landing");

  const ok = await clickSearchStrict(p);
  if(!ok) throw new Error("“検索する” ボタンに到達できませんでした。");

  const how = await waitResultLike(p, 30000);
  await saveShot(p, "result_page");
  await saveHTML(p, "result_page");
  console.log(`[result] detected by: ${how}`);
}

// ================= main =================
async function main(){
  await ensureOut();
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--window-size=1366,960","--disable-dev-shm-usage"],
    defaultViewport: { width:1366, height:960, deviceScaleFactor:1 },
  });
  browser.on("targetcreated", async (t)=>{ const p=await t.page().catch(()=>null); if(p) await ensureViewport(p); });

  const page = await browser.newPage();
  await ensureViewport(page);

  // 1) トップを試す
  const top = await gotoByCandidates(page, TOPS, "entry_referer");
  if(!top.ok){
    // 2) startinit へ直接
    const start = await gotoByCandidates(page, STARTS, "startinit_direct");
    if(!start.ok){
      // 3) 最終手段：サービスに直POST
      cardSkipped("Top/Startinit とも到達不可。サービスに直POSTで継続。", [...top.tried, ...start.tried]);
      const jkk = await openServiceDirect(page);
      try{ await runSearch(jkk); } catch(e){ fs.writeFileSync(path.join(OUT,"final_error.txt"), String(e?.stack||e)); }
      await browser.close(); return;
    }
  }

  try{
    const jkk = await launchFromStartPage(page);
    await runSearch(jkk);
  }catch(e){
    fs.writeFileSync(path.join(OUT,"final_error.txt"), String(e?.stack||e));
  }finally{
    await browser.close();
  }
}
main().catch(e=>{ console.error(e); process.exit(1); });
