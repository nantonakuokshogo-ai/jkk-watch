// monitor.mjs (v3)
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

// あなたの保存HTMLにある forwardForm の action 先（セッション開始のPOST）
// <form ... action="https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit" ...>
const SERVICE_ACTION = "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit";

async function ensureOut() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
}
async function ensureViewport(page) {
  try {
    const vp = page.viewport();
    if (!vp || !vp.width || !vp.height || vp.width < 320 || vp.height < 320) {
      await page.setViewport({ width: 1366, height: 960, deviceScaleFactor: 1 });
    }
    await page.evaluate(() => { try { window.resizeTo(1366, 960); } catch {} });
  } catch {}
}
async function saveShot(page, name) {
  try {
    await ensureViewport(page);
    await page.bringToFront().catch(()=>{});
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
function cardSkipped(reason, tried) {
  const html = `<!doctype html><meta charset="utf-8"><style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans JP',sans-serif;background:#f6f7f9;margin:0;padding:60px}
  .card{max-width:720px;margin:80px auto;background:#fff;border-radius:14px;padding:28px 32px;box-shadow:0 8px 28px rgba(0,0,0,.08)}
  pre{white-space:pre-wrap;background:#fafafa;padding:10px 12px;border-radius:8px}
  </style><div class=card><h1>entry skipped</h1>
  <pre>${reason}</pre><pre>tried: ${tried.join(", ")}</pre>
  <small>${new Date().toISOString()}</small></div>`;
  fs.writeFileSync(path.join(OUT, "entry_referer_skipped.html"), html);
}
async function gotoOne(page, url, namePrefix) {
  try {
    await ensureViewport(page);
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    if (res && res.ok()) {
      await saveShot(page, `${namePrefix}`);
      await saveHTML(page, `${namePrefix}`);
      return true;
    }
  } catch {}
  return false;
}
async function gotoByCandidates(page, candidates, prefix) {
  const tried = [];
  for (const u of candidates) {
    tried.push(u);
    if (await gotoOne(page, u, prefix)) return { ok: true, tried };
  }
  return { ok: false, tried };
}

// ===== ポップアップ / 子ターゲット捕捉 =====
async function waitJkkPopup(page, timeout = 15000) {
  const target = await page.browser().waitForTarget(t => {
    const u = (t.url() || "").toLowerCase();
    return u.includes("wait.jsp") || u.includes("jkknet") || u.includes("to-kousya.or.jp");
  }, { timeout }).catch(()=>null);
  if (!target) return null;
  const p = await target.page().catch(()=>null);
  if (p) await ensureViewport(p);
  return p;
}

// ===== JKKねっと開始：openMainWindow() 実行 or 代替 =====
async function launchFromStartPage(page) {
  // onloadで openMainWindow() が走るケースが多い。万一走らなければ明示的に叩く。
  await S(500);
  await saveShot(page, "start_page");
  await saveHTML(page, "start_page");

  // 1) すでにポップアップが開いたか？
  let popup = await waitJkkPopup(page, 3000);
  if (popup) return popup;

  // 2) JS関数を直接叩く or 「こちら」リンク（submitNext）を叩く
  const triggered = await page.evaluate(() => {
    try {
      if (typeof openMainWindow === "function") { openMainWindow(); return true; }   // openMainWindow() は wait.jsp を開き forwardForm を POST 提交
      if (typeof submitNext === "function") { submitNext(); return true; }
      const a = [...document.querySelectorAll("a")].find(x => /こちら/.test(x.innerText));
      if (a) { a.click(); return true; }
    } catch {}
    return false;
  });
  if (triggered) {
    popup = await waitJkkPopup(page, 12000);
    if (popup) return popup;
  }
  return page; // 最悪そのまま続行
}

// ===== 直接 POST でセッション開始（最終手段） =====
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
  const popup = await waitJkkPopup(page, 8000);
  return popup || page;
}

// ===== 検索実行（ボタン総当たり） =====
async function clickSearchAndAwaitResults(jkkPage) {
  await ensureViewport(jkkPage);
  await S(500);
  await saveShot(jkkPage, "search_landing");
  await saveHTML(jkkPage, "search_landing");

  const clicked = await jkkPage.evaluate(() => {
    function visible(el){ const r=el.getBoundingClientRect(); return r.width>0 && r.height>0; }
    const isSearch = (t)=> /検索/.test((t||"").trim());
    const list = [
      ...document.querySelectorAll('input[type="submit"],input[type="button"],button,a')
    ];
    for (const el of list) {
      const txt = el.value || el.innerText || el.getAttribute("value") || "";
      if (isSearch(txt) && visible(el)) { el.click(); return true; }
    }
    // フォーム直送（submit）も最後に試す
    const f = document.querySelector("form");
    if (f) { f.submit(); return true; }
    return false;
  });
  if (!clicked) throw new Error("検索ボタン相当が見つかりませんでした。");

  await S(600);
  const how = await waitResultLike(jkkPage, 30000);
  await saveShot(jkkPage, "result_page");
  await saveHTML(jkkPage, "result_page");
  console.log(`[result] detected by: ${how}`);
}

// ===== 結果らしさの判定 =====
async function waitResultLike(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const urlLike = (u) => /result|list|kensaku|searchresult|_result|index\.php|akiya/i.test(u);
  while (Date.now() < deadline) {
    await ensureViewport(page);
    const url = page.url();
    if (urlLike(url)) return `url(${url})`;
    const textHit = await page.evaluate(() => {
      const t = document.body?.innerText || "";
      return /件見つかりました|検索結果|物件一覧|該当物件|空き家情報/i.test(t);
    });
    if (textHit) return "text-hit";
    const selHit = await page.$([
      ".result-list",".search-result",".list","table.result",
      '[class*="result"]','[id*="result"]'
    ].join(","));
    if (selHit) return "selector";
    await S(500);
  }
  throw new Error("結果待機がタイムアウトしました。");
}

// ================= main =================
async function main() {
  await ensureOut();
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--window-size=1366,960","--disable-dev-shm-usage"],
    defaultViewport: { width:1366, height:960, deviceScaleFactor:1 },
  });
  browser.on("targetcreated", async (t) => { const p = await t.page().catch(()=>null); if (p) await ensureViewport(p); });

  const page = await browser.newPage();
  await ensureViewport(page);

  // 1) トップを試す
  const top = await gotoByCandidates(page, TOPS, "entry_referer");
  if (!top.ok) {
    // 2) startinit へ直接
    const start = await gotoByCandidates(page, STARTS, "startinit_direct");
    if (!start.ok) {
      // 3) 最終手段：サービスに直POST
      cardSkipped("Top/Startinit とも到達不可。サービスに直POSTで継続。", [...top.tried, ...start.tried]);
      const jkkPage = await openServiceDirect(page);
      try { await clickSearchAndAwaitResults(jkkPage); }
      catch (e) { fs.writeFileSync(path.join(OUT,"final_error.txt"), String(e?.stack||e)); }
      await browser.close();
      return;
    }
  }

  try {
    // トップ or startinit から、JKKねっと遷移を確実化
    const jkkPage = await launchFromStartPage(page);
    await clickSearchAndAwaitResults(jkkPage);
  } catch (e) {
    fs.writeFileSync(path.join(OUT, "final_error.txt"), String(e?.stack || e));
  } finally {
    await browser.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
