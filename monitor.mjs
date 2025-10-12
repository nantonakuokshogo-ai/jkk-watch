// 2) monitor.mjs（v4 / Puppeteer）
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
].filter(Boolean);

const STARTS = [
  process.env.JKK_START_URL?.trim(),
  "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaStartInit",
  "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyachizuStartInit",
].filter(Boolean);

const SERVICE_ACTION = "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit";

async function ensureOut() { if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true }); }
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
  const b = []
    .concat(`<html><head><meta charset="utf-8"><title>${title}</title><style>body{font:14px/1.7 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial;max-width:880px;margin:40px auto;padding:0 16px;} code{background:#f5f5f5;padding:2px 6px;border-radius:4px} pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow:auto}</style></head><body>`)
    .concat(`<h1>${title}</h1>`)
    .concat(blocks.map(x => `<p>${x}</p>`))
    .concat(`</body></html>`)
    .join("\n");
  fs.writeFileSync(path.join(OUT, filename), b);
}
async function openAndCapture(page, url, namePrefix) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await ensureViewport(page);
    await S(400);
    await saveShot(page, `${namePrefix}_open`);
    const needClick = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a[href]"));
      return a.some(x => /akiyachizu|akiyajyouken|startinit/i.test(x.getAttribute("href") || ""));
    });
    if (needClick) await saveHTML(page, `${namePrefix}_open`);
    return true;
  } catch (e) {
    log("OPEN FAIL:", url, e?.message || e);
    return false;
  }
}
async function tryClickAny(page, selectors) {
  return await page.evaluate((sels) => {
    function visible(el){ const r = el.getBoundingClientRect?.(); return r && r.width>0 && r.height>0; }
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && visible(el)) { el.click(); return sel; }
    }
    return null;
  }, selectors);
}
async function waitPopup(page, timeout = 15000) {
  const t = await page.browser().waitForTarget(
    t => { const u = (t.url() || "").toLowerCase(); return u.includes("wait.jsp") || u.includes("jkknet") || u.includes("to-kousya.or.jp"); },
    { timeout }
  ).catch(() => null);
  if (!t) return null;
  const p = await t.page().catch(() => null);
  if (p) await ensureViewport(p);
  return p;
}
async function isMapPage(p) {
  const u = (p.url() || "").toLowerCase();
  if (/akiyachizu/.test(u)) return true;
  return await p.evaluate(() => !!document.querySelector('map[name="Map"]'));
}
async function isJyoukenPage(p) {
  const u = (p.url() || "").toLowerCase();
  if (/akiyajyouken/.test(u)) return true;
  const has = await p.evaluate(() => {
    const t = document.body?.innerText || "";
    return /空家|条件|検索|エリア/.test(t);
  });
  return has;
}
async function clickSearchLoose(p) {
  await ensureViewport(p);
  await S(300);
  const clicked = await tryClickAny(p, [
    'a[href*="akiyaJyoukenRef"]',
    'a[href*="akiyaJyoukenStartInit"]',
    'a[href*="akiyajyouken"]',
    'a[href*="akiyachizu"]',
    'img[alt*="検索"]',
    'input[type="image"][alt*="検索"]',
    'input[type="submit"][value*="検索"]',
    'button:contains("検索")',
  ]);
  if (!clicked) {
    await p.evaluate(() => { const f = document.querySelector("form"); f && f.submit && f.submit(); });
  }
}
async function clickSearchStrict(p) {
  await ensureViewport(p);
  await S(200);
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
    try {
      if (typeof submitPage === "function") { submitPage('akiyaJyoukenRef'); return true; }
      if (typeof submitAction === "function") { submitAction('akiyaJyoukenRef'); return true; }
    } catch {}
    const f = document.querySelector("form"); if (f) { f.submit(); return true; }
    return false;
  });
  if (!ok) throw new Error("“検索する” ボタンに到達できませんでした。");
}
async function runSearch(p) {
  if (!p) throw new Error("popup page not found");
  await ensureViewport(p);
  await S(300);
  await saveShot(p, "popup_open");
  const onMap = await isMapPage(p);
  const onJyouken = onMap ? false : await isJyoukenPage(p);
  if (onMap) {
    await saveHTML(p, "popup_map");
    await clickSearchLoose(p);
  } else if (onJyouken) {
    await saveHTML(p, "popup_jyouken");
    await clickSearchStrict(p);
  } else {
    await saveHTML(p, "popup_unknown");
    await clickSearchLoose(p);
  }
  const res = await p.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
  await S(400);
  await saveShot(p, "after_click");
  await saveHTML(p, "after_click");
  if (!res) throw new Error("検索後のページ遷移が確認できません。");
  const url = (p.url() || "").toLowerCase();
  if (!/akiya/.test(url) && !/search/.test(url)) {
    writeCard("result_maybe.html", "検索結果に見えるページを取得", [
      `URL: <code>${p.url()}</code>`,
      "“空家検索の結果” でない可能性がありますが、画面は取れているので継続可能です。"
    ]);
  }
}
async function submitServicePOST(page) {
  await page.goto("about:blank");
  await ensureViewport(page);
  await page.setContent(`
    <form id="f" method="post" action="${SERVICE_ACTION}" target="_blank">
      <input type="hidden" name="_csrf" value="">
    </form>
    <script>document.getElementById("f").submit();</script>
  `, { waitUntil: "domcontentloaded" });
  return await waitPopup(page, 15000);
}
async function openServiceDirect(page) {
  const p = await submitServicePOST(page);
  if (!p) throw new Error("Service 直POSTでの起動に失敗しました。");
  return p;
}
async function launchFromStart(page) {
  await saveShot(page, "landing");
  await saveHTML(page, "landing");
  const clicked = await tryClickAny(page, [
    'a[href*="akiyachizuStartInit"]',
    'a[href*="akiyaStartInit"]',
    'a[href*="akiya"]',
    'a[onclick*="akiyachizuStartInit"]',
    'a[onclick*="akiyaStartInit"]',
  ]);
  if (!clicked) throw new Error("“空家情報” への導線が見つかりませんでした。");
  const p = await waitPopup(page, 15000);
  if (!p) throw new Error("ポップアップ（JKKNET）が開きませんでした。");
  await saveShot(p, "popup_top");
  await saveHTML(p, "popup_top");
  return p;
}
async function openAndCaptureWithLog(page, url, namePrefix) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await ensureViewport(page);
    await S(400);
    const name = `${namePrefix}_${Date.now()}`;
    await saveShot(page, name);
    await saveHTML(page, namePrefix);
    log("OPEN OK:", url);
    return true;
  } catch (e) { log("OPEN NG:", url, e?.message || e); }
  return false;
}
async function gotoByCandidates(page, urls, namePrefix) {
  const tried = [];
  for (const u of urls) { tried.push(u); if (await openAndCaptureWithLog(page, u, namePrefix)) return { ok: true, tried, url: u }; }
  return { ok: false, tried };
}
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
  const top = await gotoByCandidates(page, TOPS, "entry_referer");
  if (!top.ok) {
    const start = await gotoByCandidates(page, STARTS, "startinit_direct");
    if (!start.ok) {
      writeCard("entry_referer_skipped.html","entry skipped",[
        "Top/Startinit とも到達不可。サービス直POSTで継続。",
        `tried: ${[...top.tried, ...start.tried].join(", ")}`]);
      const jkk = await openServiceDirect(page);
      try { await runSearch(jkk); } catch (e) { fs.writeFileSync(path.join(OUT, "final_error.txt"), String(e?.stack || e)); }
      await browser.close();
      return;
    }
  }
  try { const jkk = await launchFromStart(page); await runSearch(jkk); }
  catch (e) { fs.writeFileSync(path.join(OUT, "final_error.txt"), String(e?.stack || e)); }
  finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exit(1); });
