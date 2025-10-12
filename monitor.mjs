// monitor.mjs (v10)
// 目的: 「住宅名（カナ）」に 'コーシャハイム' を入れて検索 → 一覧を撮影
// 特徴:
//  - name="akiyaInitRM.akiyaRefM.jyutakuKanaName" を優先して直指定（見つからなければヒューリスティック）
//  - 入力直後の欄に赤枠 → jyouken_filled.png を保存
//  - trace.json に入力・結果要約を記録（入った？出た？が数値で判る）
//  - タイムアウト画面の自動復帰、ポップアップ0幅の吸収、フレームHTMLもダンプ

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
  timeout: {
    nav: +(process.env.JKK_NAV_TIMEOUT_MS || 30000),
    popup: +(process.env.JKK_POPUP_TIMEOUT_MS || 15000),
  },
  // ここを書き換える/環境変数で上書きすれば別ワードも可
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

// ===== 簡易トレース（都度書き出し）=====
const TRACE = {};
const trace = (k, v) => {
  TRACE[k] = v;
  fs.writeFileSync(path.join(OUT, "trace.json"), JSON.stringify(TRACE, null, 2));
};

// ===== ユーティリティ =====
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
    await page.waitForFunction(
      'document.readyState !== "loading" && window.innerWidth > 0 && window.innerHeight > 0',
      { timeout: 5000 }
    ).catch(() => {});
    const dims = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })).catch(() => ({ w: 0, h: 0 }));
    if (!dims || dims.w === 0 || dims.h === 0) {
      await page.setViewport(CONFIG.viewport).catch(() => {});
      await page.waitForTimeout(200);
    }
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
async function hardenNetwork(page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    try {
      const host = new URL(req.url()).hostname;
      const allowed = CONFIG.allowHosts.some(rx => rx.test(host));
      if (!allowed && req.resourceType() === "script") return req.abort();
      return req.continue();
    } catch {
      return req.continue();
    }
  });
}
async function tryClickAny(page, selectors) {
  return await page.evaluate((sels) => {
    function visible(el) { const r = el?.getBoundingClientRect?.(); return r && r.width > 0 && r.height > 0; }
    for (const sel of sels) {
      if (sel.startsWith("BUTTON_TEXT=")) {
        const text = sel.replace("BUTTON_TEXT=", "");
        const btn = Array.from(document.querySelectorAll("button,input[type=button],input[type=submit],input[type=image]"))
          .find(b => (b.innerText || b.value || b.alt || "").includes(text));
        if (btn && visible(btn)) { btn.click(); return sel; }
        continue;
      }
      const el = document.querySelector(sel);
      if (el && visible(el)) { el.click(); return sel; }
    }
    return null;
  }, selectors);
}
async function waitNavOrNewPage(p, timeout = CONFIG.timeout.nav) {
  const browser = p.browser();
  const navSame = p.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).then(() => p).catch(() => null);
  const newPg = browser.waitForTarget(t => t.opener() === p.target(), { timeout })
    .then(t => t?.page().catch(() => null)).catch(() => null);
  return (await Promise.race([navSame, newPg])) || p;
}
async function waitPopup(opener, timeout = CONFIG.timeout.popup) {
  const t = await opener.browser().waitForTarget(tgt => tgt.opener() === opener.target(), { timeout }).catch(() => null);
  const p = t ? await t.page().catch(() => null) : null;
  if (p) {
    await p.setViewport(CONFIG.viewport).catch(() => {});
    await p.waitForFunction('document.body && document.body.clientWidth > 0', { timeout: 5000 }).catch(() => {});
  }
  return p;
}

// ===== 画面判定 =====
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
  return await p.evaluate(() => /先着順あき家検索|条件|こだわり|エリア|検索/.test(document.body?.innerText || ""));
}
async function isResultLike(p) {
  const u = (p.url() || "").toLowerCase();
  if (/result|list|kensaku|search/.test(u)) return true;
  return await p.evaluate(() => /検索結果|物件|件/.test(document.body?.innerText || ""));
}

// ===== 復帰 =====
async function recoverFromTimeout(currentPage) {
  await saveShot(currentPage, "timeout_detected");
  await saveHTML(currentPage, "timeout_detected");

  await tryClickAny(currentPage, [
    'a[href*="to-kousya.or.jp/chintai"]',
    'a[href*="index.html"]',
    'a[href*="backtop"]',
  ]);
  await currentPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await S(300);
  await saveShot(currentPage, "after_backtop");

  await currentPage.setExtraHTTPHeaders({ Referer: CONFIG.urls.referer });
  try { await currentPage.goto(CONFIG.urls.starts[0] || CONFIG.urls.starts[1], { waitUntil: "domcontentloaded", timeout: 20000 }); } catch {}
  const p = await waitPopup(currentPage, 15000);
  if (p) { await saveShot(p, "popup_after_recover"); await saveHTML(p, "popup_after_recover"); }
  return p;
}

// ===== 条件ページへ寄せる =====
async function forceOpenJyouken(p) {
  await p.evaluate((action) => {
    const f = document.createElement("form");
    f.method = "post"; f.action = action; document.body.appendChild(f); f.submit();
  }, CONFIG.urls.servicePost);
  return await waitNavOrNewPage(p, CONFIG.timeout.nav);
}
async function ensureJyouken(p) {
  if (await isJyoukenPage(p)) return p;
  if (await isMapPage(p)) {
    try { p = await forceOpenJyouken(p); } catch {}
    if (await isJyoukenPage(p)) return p;
  }
  try { p = await forceOpenJyouken(p); } catch {}
  return p;
}

// ===== カナ入力＋検索（直指定→フォールバック） =====
async function fillKanaAndSearch(p, keyword) {
  const info = await p.evaluate((kw) => {
    const result = { ok: false, value: "", used: "" };

    // 1) 公式フィールド名でピンポイント
    const preferred = document.querySelector('input[name="akiyaInitRM.akiyaRefM.jyutakuKanaName"]');

    // 可視判定
    const visible = (x) => x && x.offsetWidth > 0 && x.offsetHeight > 0 && !x.disabled && !x.readOnly;

    let el = preferred && visible(preferred) ? preferred : null;

    // 2) 見つからない/不可視ならヒューリスティック
    if (!el) {
      const KANA_RX = /(住宅名|建物名).*(カナ|ｶﾅ)|カナ.*(住宅名|建物名)/i;
      const cands = Array.from(document.querySelectorAll('input[type="text"],input[type="search"],input:not([type])'))
        .filter(visible);
      const score = (x) => {
        let s = 0;
        const txt = [x.id, x.name, x.placeholder, x.title].join(" ");
        if (/kana|ｶﾅ|カナ/i.test(txt)) s += 3;
        if (/jyutaku|jutaku|住宅|建物/i.test(txt)) s += 2;
        const lab = x.id ? document.querySelector(`label[for="${x.id}"]`) : null;
        if (KANA_RX.test((lab?.innerText || "").trim())) s += 4;
        const cell = x.closest("td,th,div,li") || x.parentElement;
        if (KANA_RX.test((cell?.previousElementSibling?.innerText || cell?.innerText || ""))) s += 2;
        if ((x.type || "").toLowerCase() === "text" || (x.type || "").toLowerCase() === "search") s += 1;
        return s;
      };
      el = cands.sort((a, b) => score(b) - score(a))[0] || null;
    }

    if (!visible(el)) return result;

    try {
      el.focus();
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.value = kw; // 全角カナ
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));

      // スクショで見える赤枠
      el.style.outline = "3px solid #ff0033";
      el.style.outlineOffset = "2px";

      result.ok = true;
      result.value = el.value;
      result.used = el.name || el.id || "";
      return result;
    } catch {
      return result;
    }
  }, keyword);

  trace("kana_input", { requested: keyword, ...info });
  await saveShot(p, "jyouken_filled");
  await saveHTML(p, "jyouken_filled");

  // 検索実行（ボタン/リンク/画像クリック＋保険で form.submit）
  await tryClickAny(p, [
    'a[onclick*="akiyaJyoukenRef"]','a[href*="akiyaJyoukenRef"]',
    'img[alt*="検索"]','input[type="image"][alt*="検索"]',
    'input[type="submit"][value*="検索"]','input[type="button"][value*="検索"]',
    'BUTTON_TEXT=検索する','BUTTON_TEXT=検索',
  ]);
  await p.evaluate(() => { const f = document.forms["akiSearch"] || document.querySelector("form"); f?.submit?.(); });

  return info;
}

// ===== 結果撮影＋要約 =====
async function setItemsPerPage100(p) {
  try {
    await p.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      const s = selects.find(el => Array.from(el.options || []).some(o => o.textContent?.trim() === "100" || o.value === "100"));
      if (s) { s.value = "100"; s.dispatchEvent(new Event("change", { bubbles: true })); }
    });
  } catch {}
}
async function captureResult(p) {
  await setItemsPerPage100(p);
  await S(400);
  const summary = await p.evaluate((kw) => {
    const detailsCount = Array.from(document.querySelectorAll("a,img,input"))
      .filter(el => /詳細/.test((el.alt || el.value || el.innerText || ""))).length;
    const rows = Array.from(document.querySelectorAll("table tr")).length;
    const querySeen = (document.body?.innerText || "").includes(kw);
    return { url: location.href, title: document.title, detailsCount, rows, querySeen };
  }, CONFIG.kanaQuery).catch(() => ({}));
  trace("result", summary);

  const ok = await isResultLike(p);
  await saveShot(p, ok ? "result_list" : "result_fallback");
  await saveHTML(p, ok ? "result_list" : "result_fallback");
  await dumpFramesHTML(p);
}

// ===== 起動フロー =====
async function launchFromTop(page) {
  const topUrl = CONFIG.urls.tops[0];
  await page.goto(topUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.timeout.nav });
  await ensureViewport(page);
  trace("start", { top: topUrl, at: NOW() });
  await saveShot(page, `entry_referer_${NOW()}`);
  await saveHTML(page, "entry_referer");

  const clicked = await tryClickAny(page, [
    'a[href*="akiyaJyoukenStartInit"]',
    'a[href*="akiyachizuStartInit"]',
    'a[href*="JKKnet"]',
  ]);
  let popup = null;
  if (clicked) popup = await waitPopup(page, CONFIG.timeout.popup);

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

  if (await isTimeoutPage(p)) {
    const r = await recoverFromTimeout(p);
    if (!r) throw new Error("タイムアウト復帰失敗");
    p = r;
  }

  p = await ensureJyouken(p);
  await saveHTML(p, "popup_jyouken");

  await fillKanaAndSearch(p, CONFIG.kanaQuery);

  p = await waitNavOrNewPage(p, CONFIG.timeout.nav);
  await S(300);

  if (await isTimeoutPage(p)) {
    const r = await recoverFromTimeout(p);
    if (!r) throw new Error("検索後タイムアウト復帰失敗");
    p = r;
  }

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

    // トップ候補を順に試す
    let opened = false;
    for (const u of CONFIG.urls.tops) {
      try { await page.goto(u, { waitUntil: "domcontentloaded", timeout: CONFIG.timeout.nav }); opened = true; trace("top_open", u); break; }
      catch (e) { fs.appendFileSync(path.join(OUT, "debug.log"), `TOP open failed ${u}: ${e?.message || e}\n`); }
    }
    if (!opened) throw new Error("賃貸トップに到達できませんでした。");

    await saveShot(page, `landing_${NOW()}`);
    await saveHTML(page, "landing");

    const popup = await launchFromTop(page);
    await runFlow(popup);
  } catch (e) {
    fs.writeFileSync(path.join(OUT, "final_error.txt"), String(e?.stack || e));
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
