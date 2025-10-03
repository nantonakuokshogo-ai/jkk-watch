// monitor.mjs — 旧Puppeteer互換の「同タブ矯正」版
// 実行: node monitor.mjs
// 生成: out/entry_referer.*, out/after_wait.*, out/result_or_form_*.*
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, "out");

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function ensureOut(){ await fs.mkdir(OUT_DIR,{recursive:true}); }
async function save(page, base){
  try{
    const html = await page.content();
    await fs.writeFile(path.join(OUT_DIR, `${base}.html`), html);
  }catch(_){}
  try{
    await page.screenshot({ path: path.join(OUT_DIR, `${base}.png`), fullPage:true });
  }catch(_){}
  console.log(`[saved] ${base}`);
}
function chromePath(){
  return process.env.CHROME_PATH
    || process.env.PUPPETEER_EXECUTABLE_PATH
    || "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome";
}

// addInitScript が無い旧版でも動くようにフォールバック
async function addInit(page, fn){
  if (typeof page.addInitScript === "function") {
    await page.addInitScript(fn);
  } else {
    // 旧名称：evaluateOnNewDocument
    await page.evaluateOnNewDocument(fn);
  }
}

async function main(){
  await ensureOut();

  const executablePath = chromePath();
  console.log("[monitor] Using Chrome at:", executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    defaultViewport: { width: 1366, height: 2000 },
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1366,2000",
      "--disable-features=IsolateOrigins,site-per-process,SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure",
      "--disable-client-side-phishing-detection",
    ],
  });

  const page = await browser.newPage();

  // 同タブ矯正（旧版でも効くように evaluateOnNewDocument フォールバック）
  await addInit(page, () => {
    try { window.name = "JKKnet"; } catch(e){}
    const originalOpen = window.open;
    window.open = function(url){
      if (url) location.href = url; // 同タブ遷移へ強制
      return window;
    };
    window.close = function(){};   // 元タブ close 無効化
  });

  // 参考ログ
  page.on("requestfailed", (req)=>{
    const f = req.failure && req.failure();
    if (f && /blocked_by_client/i.test(f.errorText||"")) {
      console.warn("[warn] blocked_by_client:", req.url());
    }
  });
  page.on("pageerror", (e)=>console.warn("[pageerror]", e?.message||e));
  page.on("dialog", async d=>{ try{ await d.dismiss(); }catch{} });
  page.on("popup", async p=>{ try{ await p.close({ runBeforeUnload:false }); }catch{} });

  try{
    // 1) トップ → リファラ作成
    await page.goto("https://www.jkktokyo.or.jp/", {
      waitUntil: "domcontentloaded", timeout: 60_000
    });
    await sleep(1000);
    await save(page, "entry_referer");

    // 2) Referer を明示して中継 wait.jsp へ
    await page.setExtraHTTPHeaders({ Referer: "https://www.jkktokyo.or.jp/" });
    await page.goto("https://jhomes.to-kousya.or.jp/search/jkknet/wait.jsp", {
      waitUntil: "domcontentloaded", timeout: 60_000
    });

    // onload→window.open→POST→遷移 を待つ（ネットワーク事情に強めに待機）
    await sleep(4000);
    await page.waitForNavigation({ waitUntil: "load", timeout: 15_000 }).catch(()=>{});
    await sleep(1000);
    await save(page, "after_wait");

    // 3) 到達先の軽判定
    const kind = await page.evaluate(()=>{
      if (document.querySelector("frame, frameset")) return "frames";
      const hasSearch = [...document.querySelectorAll("input,button")]
        .some(b => /検索/.test((b.value||"") + (b.textContent||"")));
      if (hasSearch) return "form";
      if (/見つかりません|not\s*found|404/i.test(document.title||"")) return "404";
      return "other";
    });
    await save(page, `result_or_form_${kind}`);
  }catch(err){
    console.error(err);
    await save(page, "final_error").catch(()=>{});
    process.exitCode = 1;
  }finally{
    await browser.close().catch(()=>{});
  }
}

main().catch(e=>{ console.error(e); process.exitCode = 1; });
