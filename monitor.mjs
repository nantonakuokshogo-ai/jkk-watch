// monitor.mjs — 直接 wait.jsp へ行く堅牢版（DNS/ブロックに強いリトライ付き）
// 実行: node monitor.mjs
// 生成: out/after_wait.*, out/result_or_form_*.*
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

// addInitScript の旧版互換（evaluateOnNewDocument にフォールバック）
async function addInit(page, fn){
  if (typeof page.addInitScript === "function") {
    await page.addInitScript(fn);
  } else {
    await page.evaluateOnNewDocument(fn);
  }
}

// ネットワーク周りを強めにした遷移
async function gotoWithRetries(page, url, opts = {}){
  const tries = [];
  const u = new URL(url);

  // 1) そのまま https
  tries.push(()=>page.goto(u.toString(), opts));

  // 2) 一時バッファ等で弾かれた時用にキャッシュバスター
  tries.push(()=>{
    const u2 = new URL(u.toString());
    u2.searchParams.set("_t", Date.now().toString());
    return page.goto(u2.toString(), opts);
  });

  // 3) どうしても名前解決やTLSでこける時は http にフォールバック
  if (u.protocol === "https:") {
    const httpURL = new URL(u.toString());
    httpURL.protocol = "http:";
    tries.push(()=>page.goto(httpURL.toString(), opts));
  }

  let lastErr;
  for (let i=0;i<tries.length;i++){
    try {
      return await tries[i]();
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) || "";
      console.warn(`[goto retry ${i+1}/${tries.length}] ${u} -> ${msg}`);
      await sleep(1500);
    }
  }
  throw lastErr;
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

  // すべての新規ドキュメントで「同タブ強制」を仕込む
  await addInit(page, () => {
    try { window.name = "JKKnet"; } catch(e){}
    const originalOpen = window.open;
    window.open = function(url){
      if (url) location.href = url; // 同タブに矯正
      return window;
    };
    window.close = function(){}; // 元タブ close を無力化
  });

  // 雑多なログ
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
    // ここでトップへは行かない（DNS で落ちやすい）。Referer は手で付ける。
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      Referer: "https://www.jkktokyo.or.jp/",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Site": "same-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });

    // 1) 直接 wait.jsp へ（リトライ付き）
    await gotoWithRetries(page, "https://jhomes.to-kousya.or.jp/search/jkknet/wait.jsp", {
      waitUntil: "domcontentloaded", timeout: 60_000
    });

    // onload→window.open→POST→遷移 を厚めに待つ
    await sleep(4000);
    await page.waitForNavigation({ waitUntil: "load", timeout: 25_000 }).catch(()=>{});
    await sleep(1000);
    await save(page, "after_wait");

    // 2) 軽判定と記録
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
    try { await save(page, "final_error"); } catch(_){}
    process.exitCode = 1;
  }finally{
    await browser.close().catch(()=>{});
  }
}

main().catch(e=>{ console.error(e); process.exitCode = 1; });
