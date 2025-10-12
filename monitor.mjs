// monitor.mjs (v7)
// JKK 賃貸トップ → JKKねっと → 条件 → 検索 → 一覧を撮影
// - 3rdパーティ計測スクリプトを遮断（許可ドメインのみ通す）
// - タイムアウト検出→自動復帰
// - 常に Page を返す nav ユーティリティ
// - フレームHTMLもダンプ、結果は result_list.* になければ result_fallback.* を必ず保存

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const OUT = path.resolve("out");
const S = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = () => new Date().toISOString().replace(/[:.]/g, "-");

// ---- 設定集中 ----
const CONFIG = {
  headless: (process.env.JKK_HEADLESS || "true") === "true",
  viewport: { width: 1366, height: 960, deviceScaleFactor: 1 },
  timeout: {
    nav: +(process.env.JKK_NAV_TIMEOUT_MS || 30000),
    popup: +(process.env.JKK_POPUP_TIMEOUT_MS || 15000),
  },
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

// ---------- ユーティリティ ----------
function log(...a) {
  const line = a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  fs.appendFileSync(path.join(OUT, "debug.log"), `[${new Date().toISOString()}] ${line}\n`);
}
function ensureOut() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
}
async function ensureViewport(page) {
  const vp = page.viewport();
  if (!vp || vp.width < 400) await page.setViewport(CONFIG.viewport);
  await page.evaluate(() => { try { window.resizeTo(1366, 960); } catch {} });
}
async function saveShot(page, name) {
  try {
    await ensureViewport(page);
    await page.bringToFront().catch(() => {});
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
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
async function dumpFramesHTML(page) {
  const frames = page.frames().filter(f => f !== page.mainFrame());
  for (let i = 0; i < frames.length; i++) {
    try {
      const html = await frames[i].content();
      fs.writeFileSync(path.join(OUT, `frame_${i}.html`), html);
    } catch {}
  }
}

// 許可ドメイン以外の「script」を遮断
async function hardenNetwork(page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    try {
      const url = new URL(req.url());
      const host = url.hostname;
      const allowed = CONFIG.allowHosts.some(rx => rx.test(host));
      if (!allowed && req.resourceType() === "script") {
        return req.abort();
      }
      return req.continue();
    } catch {
      return req.continue();
    }
  });
}

// CSSセレクタ候補を順にクリック
async function tryClickAny(page, selectors) {
  return await page.evaluate((sels) => {
    function visible(el){ const r = el?.getBoundingClientRect?.(); return r && r.width>0 && r.height>0; }
    for (const sel of sels) {
      if (sel.startsWith("BUTTON_TEXT=")) {
        const text = sel.replace("BUTTON_TEXT=","");
        const btn = Array.from(document.querySelectorAll("button,input[type=button],input[type=submit],input[type=image]"))
          .find(b => /検索/.test(text) ? /検索/.test((b.innerText||b.value||b.alt||"")) : (b.innerText||b.value||b.alt||"").includes(text));
        if (btn && visible(btn)) { btn.click(); return sel; }
        continue;
      }
      const el = document.querySelector(sel);
      if (el && visible(el)) { el.click(); return sel; }
    }
    return null;
  }, selectors);
}

// nav or 新規ウィンドウのどちらでも Page を返す
async function waitNavOrNewPage(p, timeout = CONFIG.timeout.nav) {
  const browser = p.browser();
  const navSame = p.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).then(() => p).catch(() => null);
  const newPg  = browser.waitForTarget(t => t.opener() === p.target(), { timeout })
    .then(t => t?.page().catch(() => null)).catch(() => null);
  const res = await Promise.race([navSame, newPg]);
  return res || p;
}

async function waitPopup(opener, timeout = CONFIG.timeout.popup) {
  const t = await opener.browser().waitForTarget(
    t => t.opener() === opener.target(),
    { timeout }
  ).catch(() => null);
  const p = t ? await t.page().catch(() => null) : null;
  if (p) await ensureViewport(p);
  return p;
}

// ---------- 画面タイプ判定 ----------
async function isTimeoutPage(p) {
  try {
    const title = typeof p.title === "function" ? await p.title() : "";
    if (/おわび|timeout|タイムアウト/i.test(title)) return true;
  } catch {}
  return await p.evaluate(() => /タイムアウト|おわび/.test(document.body?.innerText || ""));
}
async function isMapPage(p) {
  const u = (p.url() || "").toLowerCase();
  if (/akiyachizu/.test(u)) return true;
  return await p.evaluate(() => !!document.querySelector('map[name="Map"]'));
}
async function isJyoukenPage(p) {
  const u = (p.url() || "").toLowerCase();
  if (/akiyajyouken/.test(u)) return true;
  return await p.evaluate(() => /先着順あき家検索|条件|検索|エリア/.test(document.body?.innerText || ""));
}
async function isResultLike(p) {
  const u = (p.url() || "").toLowerCase();
  if (/result|list|kensaku|search/.test(u)) return true;
  return await p.evaluate(() => /検索結果|物件|件/.test(document.body?.innerText || ""));
}

// ---------- 復帰フロー ----------
async function recoverFromTimeout(currentPage) {
  log("TIMEOUT detected → recover");
  await saveShot(currentPage, "timeout_detected");
  await saveHTML(currentPage, "timeout_detected");

  // トップへ戻る系
  const clicked = await tryClickAny(currentPage, [
    'a[href*="to-kousya.or.jp/chintai"]',
    'a[href*="index.html"]',
    'a[href*="backtop"]',
  ]);
  if (clicked) {
    await currentPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
    await S(400);
    await saveShot(currentPage, "after_backtop");
  }

  // StartInit を referer 付きで叩いてポップアップ待ち
  await currentPage.setExtraHTTPHeaders({ Referer: CONFIG.urls.referer });
  try { await currentPage.goto(CONFIG.urls.starts[0] || CONFIG.urls.starts[1], { waitUntil: "domcontentloaded", timeout: 20000 }); } catch {}
  const p = await waitPopup(currentPage, 15000);
  if (p) {
    await saveShot(p, "popup_after_recover");
    await saveHTML(p, "popup_after_recover");
    return p;
  }
  return null;
}

// ---------- 検索操作 ----------
async function clickSearch(p) {
  // 条件画面 or 地図画面から「検索」へ進む
  const clicked = await tryClickAny(p, [
    'a[onclick*="akiyaJyoukenRef"]',
    'a[href*="akiyaJyoukenRef"]',
    'a[href*="akiyaJyoukenStartInit"]',
    'img[alt*="検索"]',
    'input[type="image"][alt*="検索"]',
    'input[type="submit"][value*="検索"]',
    'input[type="button"][value*="検索"]',
    'BUTTON_TEXT=検索',
  ]);
  if (!clicked) {
    // フォーム submit のみでも進める保険
    await p.evaluate(() => { const f = document.querySelector("form"); f?.submit?.(); });
  }
}

// 100件表示にできるなら切り替え
async function setItemsPerPage100(p) {
  try {
    await p.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      const s = selects.find(el =>
        Array.from(el.options || []).some(o => o.textContent?.trim() === "100" || o.value === "100"));
      if (s) { s.value = "100"; s.dispatchEvent(new Event("change", { bubbles: true })); }
    });
  } catch {}
}

// 結果撮影（最低限の証跡を必ず残す）
async function captureResult(p) {
  await setItemsPerPage100(p);
  await S(500);
  const ok = await isResultLike(p);
  await saveShot(p, ok ? "result_list" : "result_fallback");
  await saveHTML(p, ok ? "result_list" : "result_fallback");
  await dumpFramesHTML(p);
}

// ---------- 起動導線 ----------
async function launchFromTop(page) {
  // 1) 賃貸トップを referer 確保のために踏む
  const topUrl = CONFIG.urls.tops[0];
  log("OPEN TOP:", topUrl);
  await page.goto(topUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.timeout.nav });
  await ensureViewport(page);
  await saveShot(page, `entry_referer_${NOW()}`);
  await saveHTML(page, "entry_referer");

  // 2) トップから StartInit への導線を試し、ポップアップ待ち
  const clicked = await tryClickAny(page, [
    'a[href*="akiyaJyoukenStartInit"]',
    'a[href*="akiyachizuStartInit"]',
    'a[href*="JKKnet"]',
  ]);
  let popup = null;
  if (clicked) popup = await waitPopup(page, CONFIG.timeout.popup);

  // 3) 導線が見つからない/開かない場合は直接 StartInit + Referer
  if (!popup) {
    await page.setExtraHTTPHeaders({ Referer: CONFIG.urls.referer });
    try { await page.goto(CONFIG.urls.starts[0] || CONFIG.urls.starts[1], { waitUntil: "domcontentloaded", timeout: CONFIG.timeout.nav }); } catch {}
    popup = await waitPopup(page, CONFIG.timeout.popup);
  }
  if (!popup) throw new Error("JKKnet のポップアップが開きませんでした。");
  await saveShot(popup, "popup_top");
  await saveHTML(popup, "popup_top");
  return popup;
}

async function runFlow(popup) {
  let p = popup;

  // タイムアウト画面なら復帰
  if (await isTimeoutPage(p)) {
    const recovered = await recoverFromTimeout(p);
    if (!recovered) throw new Error("タイムアウト復帰に失敗しました。");
    p = recovered;
  }

  // どの画面かで分岐して検索を開始
  if (await isMapPage(p)) {
    await saveHTML(p, "popup_map");
    await clickSearch(p);
  } else if (await isJyoukenPage(p)) {
    await saveHTML(p, "popup_jyouken");
    await clickSearch(p);
  } else {
    await saveHTML(p, "popup_unknown");
    await clickSearch(p);
  }

  // 遷移（同一タブ or 新タブ）
  p = await waitNavOrNewPage(p, CONFIG.timeout.nav);
  await S(400);

  // 再度タイムアウトに落ちたら救出
  if (await isTimeoutPage(p)) {
    const recovered = await recoverFromTimeout(p);
    if (!recovered) throw new Error("検索後にタイムアウト→復帰失敗。");
    p = recovered;
  }

  // 最終：結果撮影
  await captureResult(p);
}

async function main() {
  ensureOut();

  const browser = await puppeteer.launch({
    headless: CONFIG.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1366,960", "--disable-dev-shm-usage"],
    defaultViewport: CONFIG.viewport,
  });

  try {
    const page = await browser.newPage();
    await hardenNetwork(page);
    await ensureViewport(page);

    // Top 候補を順に試す
    let opened = false;
    for (const u of CONFIG.urls.tops) {
      try { await page.goto(u, { waitUntil: "domcontentloaded", timeout: CONFIG.timeout.nav }); opened = true; break; }
      catch (e) { log("TOP open failed:", u, e?.message || e); }
    }
    if (!opened) throw new Error("賃貸トップに到達できませんでした。");

    await saveShot(page, `landing_${NOW()}`);
    await saveHTML(page, "landing");

    const popup = await launchFromTop(page);
    await runFlow(popup);
  } catch (e) {
    fs.writeFileSync(path.join(OUT, "final_error.txt"), String(e?.stack || e));
    log("FATAL", e?.stack || e);
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
