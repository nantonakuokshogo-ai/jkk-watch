// monitor.mjs (v4)
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const OUT = path.resolve("out");
const S = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => {
  const line = a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  fs.appendFileSync(path.join(OUT, "debug.log"), `[${new Date().toISOString()}] ${line}\n`);
};

const TOPS = [
  process.env.JKK_TOP_URL?.trim(),
  "https://www.jkk-tokyo.or.jp/",
  "http://www.jkk-tokyo.or.jp/",
  "https://jkk-tokyo.or.jp/",
  "http://jkk-tokyo.or.jp/",
].filter(Boolean);

const STARTS = [
  "https://www.jkk-tokyo.or.jp/search/jkknet/startinit.html",
  "http://www.jkk-tokyo.or.jp/search/jkknet/startinit.html",
  "https://jkk-tokyo.or.jp/search/jkknet/startinit.html",
  "http://jkk-tokyo.or.jp/search/jkknet/startinit.html",
];

// 保存HTMLに出てくる forwardForm の action 先
const SERVICE_ACTION = "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit";

// ------------------------ utils ------------------------
async function ensureOut() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
}

async function ensureViewport(page) {
  try {
    const vp = page.viewport();
    const need = !vp || !vp.width || !vp.height || vp.width < 320 || vp.height < 320;
    if (need) await page.setViewport({ width: 1366, height: 960, deviceScaleFactor: 1 });
    await page.evaluate(() => { try { window.resizeTo(1366, 960); } catch {} });
  } catch {}
}

async function saveShot(page, name) {
  try {
    await ensureViewport(page);
    await page.bringToFront().catch(() => {});
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true, captureBeyondViewport: false });
  } catch (e) {
    fs.writeFileSync(path.join(OUT, `${name}_shot_error.txt`), String(e?.stack || e));
  }
}

async function saveHTML(page, name) {
  try {
    await ensureViewport(page);
    const html = await page.content();
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  } catch (e) {
    fs.writeFileSync(path.join(OUT, `${name}_html_error.txt`), String(e?.stack || e));
  }
}

function writeCard(filename, title, blocks) {
  const html = `<!doctype html><meta charset="utf-8"><style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans JP',sans-serif;background:#f6f7f9;margin:0;padding:60px}
  .card{max-width:780px;margin:60px auto;background:#fff;border-radius:14px;padding:28px 32px;box-shadow:0 8px 28px rgba(0,0,0,.08)}
  pre{white-space:pre-wrap;background:#fafafa;padding:10px 12px;border-radius:8px}
  h1{font-size:20px;margin:0 0 12px;}
  </style><div class=card><h1>${title}</h1>
  ${blocks.map(b=>`<pre>${b}</pre>`).join("")}
  <small>${new Date().toISOString()}</small></div>`;
  fs.writeFileSync(path.join(OUT, filename), html);
}

// ------------------------ navigation helpers ------------------------
async function openAndCapture(page, url, namePrefix) {
  try {
    await ensureViewport(page);
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    if (res && res.ok()) {
      await saveShot(page, namePrefix);
      await saveHTML(page, namePrefix);
      log("OPEN OK:", url);
      return true;
    }
  } catch (e) {
    log("OPEN NG:", url, e?.message || e);
  }
  return false;
}

async function gotoByCandidates(page, urls, namePrefix) {
  const tried = [];
  for (const u of urls) {
    tried.push(u);
    if (await openAndCapture(page, u, namePrefix)) return { ok: true, tried, url: u };
  }
  return { ok: false, tried };
}

async function waitPopup(page, timeout = 15000) {
  const t = await page.browser().waitForTarget(
    t => {
      const u = (t.url() || "").toLowerCase();
      return u.includes("wait.jsp") || u.includes("jkknet") || u.includes("to-kousya.or.jp");
    },
    { timeout }
  ).catch(() => null);
  if (!t) return null;
  const p = await t.page().catch(() => null);
  if (p) await ensureViewport(p);
  return p;
}

// ------------------------ page kind checks ------------------------
async function isMapPage(p) {
  const u = (p.url() || "").toLowerCase();
  if (/akiyachizu/.test(u)) return true;
  return await p.evaluate(() => !!document.querySelector('map[name="Map"]'));
}
async function isJyoukenPage(p) {
  const u = (p.url() || "").toLowerCase();
  if (/akiyajyouken/.test(u)) return true;
  return await p.evaluate(() => !!document.querySelector('form[name="akiSearch"]'));
}
async function isResultPageStrict(p) {
  return await p.evaluate(() => {
    const t = document.body?.innerText || "";
    const hasCount   = /件が該当しました/.test(t);                                // 例: "78件が該当しました。"
    const hasHeading = /先着順あき家の検索結果/.test(t);
    const hasPager   = !!document.querySelector('[onclick*="movePagingInputGridPage"]');
    const hasDetail  = !!document.querySelector('a[onclick*="senPage"], img[alt="詳細"]');
    return hasCount || hasHeading || hasPager || hasDetail;
  });
}

// ------------------------ flows ------------------------
async function launchFromStart(page) {
  await S(500);
  await saveShot(page, "start_page");
  await saveHTML(page, "start_page");

  // すでに子が開いた？
  let child = await waitPopup(page, 3000);
  if (child) return child;

  // openMainWindow()/submitNext()/「こちら」リンク
  const triggered = await page.evaluate(() => {
    try {
      if (typeof openMainWindow === "function") { openMainWindow(); return true; }
      if (typeof submitNext === "function") { submitNext(); return true; }
      const a = [...document.querySelectorAll("a")].find(x => /こちら/.test(x.innerText));
      if (a) { a.click(); return true; }
    } catch {}
    return false;
  });
  if (triggered) {
    child = await waitPopup(page, 12000);
    if (child) return child;
  }
  return page;
}

async function openServiceDirect(page) {
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
  const p = await waitPopup(page, 8000);
  return p || page;
}

async function ensureJyouken(p) {
  if (await isMapPage(p)) {
    log("on map page → back to 条件");
    await p.evaluate(() => { try { if (typeof areaOpen === "function") areaOpen(); } catch {} });
    await S(800);
  }
  return p;
}

async function clickSearchStrict(p) {
  await ensureViewport(p);
  await S(200);

  // a[onclick*="akiyaJyoukenRef"] / 画像ボタン / input / button
  const ok = await p.evaluate(() => {
    function visible(el){ const r = el.getBoundingClientRect?.(); return r && r.width>0 && r.height>0; }
    function tryClick(sel){
      const el = document.querySelector(sel);
      if (el && visible(el)) { el.click(); return true; }
      return false;
    }
    if (tryClick('a[onclick*="akiyaJyoukenRef"]')) return true;
    const imgs = Array.from(document.querySelectorAll('img[alt]')).filter(x=>/検索/.test(x.alt||""));
    if (imgs[0] && visible(imgs[0])) { imgs[0].click(); return true; }
    const inputs = Array.from(document.querySelectorAll('input[type="image"],input[type="submit"],input[type="button"]'))
      .filter(x => /検索/.test(x.alt||"") || /検索/.test(x.value||""));
    if (inputs[0] && visible(inputs[0])) { inputs[0].click(); return true; }
    const btn = Array.from(document.querySelectorAll("button")).find(b=>/検索/.test(b.innerText||""));
    if (btn && visible(btn)) { btn.click(); return true; }
    // 最後の手：関数直叩き
    try {
      if (typeof submitPage === "function") { submitPage('akiyaJyoukenRef'); return true; }
      if (typeof submitAction === "function") { submitAction('akiyaJyoukenRef'); return true; }
    } catch {}
    // さらに最後：最初の form を submit
    const f = document.querySelector("form"); if (f) { f.submit(); return true; }
    return false;
  });

  if (!ok) throw new Error("“検索する” ボタンに到達できませんでした。");
}

async function waitResultLike(p, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  const urlLike = (u) => /akiyaJyoukenRef|result|list|searchresult|_result|index\.php/i.test(u);
  while (Date.now() < deadline) {
    await ensureViewport(p);
    if (await isResultPageStrict(p)) return "strict";
    const u = p.url();
    if (urlLike(u)) return `url(${u})`;
    const textHit = await p.evaluate(() =>
      /検索結果|該当件数|物件一覧|該当物件|空家情報/.test(document.body?.innerText || "")
    );
    if (textHit) return "text-hit";
    const selHit = await p.$('[class*="result"],[id*="result"],.search-result,.result-list,table.result');
    if (selHit) return "selector";
    await S(400);
  }
  throw new Error("結果待機がタイムアウトしました。");
}

async function runSearch(p) {
  p = await ensureJyouken(p);

  await saveShot(p, "search_landing");
  await saveHTML(p, "search_landing");

  await clickSearchStrict(p);
  await S(600);

  const how = await waitResultLike(p, 30000);
  await saveShot(p, "result_page");
  await saveHTML(p, "result_page");
  log("RESULT DETECT:", how);

  // メタ保存（件数/URL/タイトル）
  const meta = await p.evaluate(() => {
    const t = document.body?.innerText || "";
    const m = t.match(/(\d+)\s*件が該当しました/);
    return { count: m ? Number(m[1]) : null, url: location.href, title: document.title };
  });
  fs.writeFileSync(path.join(OUT, "result_meta.json"), JSON.stringify(meta, null, 2));
}

// ------------------------ main ------------------------
async function main() {
  await ensureOut();
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1366,960", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1366, height: 960, deviceScaleFactor: 1 },
  });
  browser.on("targetcreated", async (t) => { const p = await t.page().catch(() => null); if (p) await ensureViewport(p); });

  const page = await browser.newPage();
  await ensureViewport(page);

  // 入口 → startinit → 直POST の順でフォールバック
  const top = await gotoByCandidates(page, TOPS, "entry_referer");
  if (!top.ok) {
    const start = await gotoByCandidates(page, STARTS, "startinit_direct");
    if (!start.ok) {
      writeCard("entry_referer_skipped.html",
        "entry skipped",
        ["Top/Startinit とも到達不可。サービス直POSTで継続。",
         `tried: ${[...top.tried, ...start.tried].join(", ")}`]);
      const jkk = await openServiceDirect(page);
      try { await runSearch(jkk); } catch (e) { fs.writeFileSync(path.join(OUT, "final_error.txt"), String(e?.stack || e)); }
      await browser.close();
      return;
    }
  }

  try {
    const jkk = await launchFromStart(page);
    await runSearch(jkk);
  } catch (e) {
    fs.writeFileSync(path.join(OUT, "final_error.txt"), String(e?.stack || e));
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
