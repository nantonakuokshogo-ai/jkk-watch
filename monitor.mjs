// monitor.mjs — JKK 先着順あき家検索 自動入力
// v22+ 向け。フォームページへ切り替わるまで粘り強く待機し、
// 住宅名(カナ) に「コーシャハイム」を入れて検索。
// 生成物は out/ 以下へ保存。

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const OUTDIR = "out";
const BASE = "https://jhomes.to-kousya.or.jp";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";

// 本体フォーム URL の候補（サイトの挙動差異を吸収）
const FORM_URL_PATTERNS = [
  "/akiyaJyoukenStartMain",
  "/akiyaJyoukenStartMainInit",
  "/akiyaJyoukenStartMain.do",
  "/akiyaJyoukenStart",
  "/jyouken", // 念のため
];

async function ensureOut() {
  await fs.mkdir(OUTDIR, { recursive: true });
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function savePage(page, name, note = "") {
  await ensureOut();
  const html = await page.content().catch(() => "");
  try {
    await page.screenshot({ path: path.join(OUTDIR, `${name}.png`), fullPage: true });
  } catch (e) {
    await fs.writeFile(path.join(OUTDIR, `${name}.screenshot.txt`), String(e));
  }
  await fs.writeFile(path.join(OUTDIR, `${name}.html`), html ?? "", "utf8");
  if (note) await fs.writeFile(path.join(OUTDIR, `${name}.note.txt`), note, "utf8");
  console.log(`[saved] ${name}`);
}
function abs(u) { return u.startsWith("http") ? u : new URL(u, BASE).href; }

// デバッグ：フレーム一覧をテキストで保存
async function dumpFrames(page, name) {
  const lines = await Promise.all(page.frames().map(async f => {
    const title = await f.title().catch(() => "");
    return `url=${f.url()}  title=${title}`;
  }));
  await fs.writeFile(path.join(OUTDIR, `${name}.frames.txt`), lines.join("\n"), "utf8");
  console.log(`[frames] ${lines.length}`);
}

// 「こちら」リンク等を見つけたらクリック（あれば）
async function clickHereIfExists(pageOrFrame) {
  try {
    await pageOrFrame.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a"))
        .find(x => /こちら|here/i.test(x.textContent || ""));
      if (a) a.click();
    });
  } catch {}
}

// 本体フォームの page を取得（ポップアップでも同タブ遷移でも対応）
async function waitForFormPage(browser, seedPage, timeoutMs = 25000) {
  const start = Date.now();
  let current = seedPage;
  while (Date.now() - start < timeoutMs) {
    // 1) 既存タブが目的 URL か？
    const u = current.url();
    if (FORM_URL_PATTERNS.some(p => u.includes(p))) return current;

    // 2) ポップアップが開いたか？
    for (const t of browser.targets()) {
      if (t.type() === "page") {
        const tu = t.url();
        if (FORM_URL_PATTERNS.some(p => tu.includes(p))) {
          const p = await t.page().catch(() => null);
          if (p) return p;
        }
      }
    }

    // 3) 「こちら」を押して促進
    await clickHereIfExists(current);

    // 4) ナビゲーション or 自動リフレッシュ待ち
    await Promise.race([
      current.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 1200 }).catch(() => {}),
      sleep(800),
    ]);

    // 5) 時々 viewport を確保（0 width 対策）
    try { await current.setViewport({ width: 1280, height: 2000, deviceScaleFactor: 1 }); } catch {}

    // 6) デバッグ保存（多すぎると重いので最初だけ）
    if (Date.now() - start < 1500) {
      await savePage(current, "after_relay_1");
    }
  }
  return seedPage; // 見つからず：保険で seedPage を返す
}

// 入力欄をフレーム横断で探索
async function findKanaInputHandle(frame) {
  return await frame.evaluateHandle(() => {
    // 直接属性で当てにいく
    const attrHit = document.querySelector(
      'input[name*="kana" i],input[id*="kana" i],input[title*="カナ"],input[aria-label*="カナ"],input[placeholder*="カナ"]'
    );
    if (attrHit) return attrHit;

    // ラベルの推定（表組の左セルなど）
    function labelTextFor(el) {
      if (!el) return "";
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.textContent || "";
      }
      let cur = el;
      for (let i = 0; i < 5; i++) {
        const td = cur.closest("td,th,div,span");
        if (!td) break;
        let prev = td.previousElementSibling;
        while (prev) {
          const txt = prev.textContent?.trim() || "";
          if (txt) return txt;
          prev = prev.previousElementSibling;
        }
        cur = td.parentElement || cur.parentElement;
        if (!cur) break;
      }
      return el.getAttribute("title") || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
    }

    const hints = ["住宅名", "カナ", "かな", "ｶﾅ"];
    for (const el of Array.from(document.querySelectorAll('input[type="text"],input:not([type]),textarea'))) {
      const txt = (labelTextFor(el) + " " + (el.name || "") + " " + (el.id || "")).toLowerCase();
      if (hints.some(h => txt.includes(h.toLowerCase()))) return el;
    }
    return null;
  });
}

// 「検索」ボタン押下（見つからなければ form submit）
async function clickSearchInFrame(frame) {
  const h = await frame.evaluateHandle(() => {
    const btn = Array.from(document.querySelectorAll('input[type="submit"],input[type="button"],button'))
      .find(el => /検索/.test(el.value || el.textContent || ""));
    if (btn) return btn;
    const frm = document.querySelector("form");
    if (frm) return frm;
    return null;
  });
  if (!h) return;
  const el = h.asElement();
  if (!el) return;
  const tag = await frame.evaluate(e => e.tagName.toLowerCase(), el).catch(() => "");
  if (tag === "form") {
    await frame.evaluate(f => f.submit(), el).catch(() => {});
  } else {
    await el.click().catch(() => {});
  }
  try { await h.dispose(); } catch {}
}

async function main() {
  console.log("[monitor] Using Chrome at:", CHROME);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 2000, deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000);

    // ===== ここまでが導線 =====
    await page.goto(abs("/"), { waitUntil: "domcontentloaded" });
    await savePage(page, "home_1");

    await page.goto(abs("/search/jkknet/"), { waitUntil: "domcontentloaded" });
    await savePage(page, "home_1_after");

    await page.goto(abs("/search/jkknet/index.html"), { waitUntil: "domcontentloaded" });
    await savePage(page, "home_2");

    await page.goto(abs("/search/jkknet/service/"), { waitUntil: "domcontentloaded" });
    await savePage(page, "home_2_after");

    await page.goto(abs("/search/jkknet/service/akiyaJyoukenStartInit"), {
      waitUntil: "domcontentloaded",
      referer: abs("/search/jkknet/service/"),
    });
    await savePage(page, "frameset_startinit");

    // ===== 待機ページ → 本体フォームの出現を待つ =====
    const formPage = await waitForFormPage(browser, page, 30000);
    await formPage.bringToFront().catch(() => {});
    await formPage.setViewport({ width: 1280, height: 2200, deviceScaleFactor: 1 }).catch(() => {});

    // フォームが現れるまで繰り返しスキャン
    let targetFrame = null;
    let kanaHandle = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      await dumpFrames(formPage, "scan_frames");
      const frames = formPage.frames();
      for (const f of frames) {
        try {
          const h = await findKanaInputHandle(f);
          if (h && h.asElement()) {
            targetFrame = f;
            kanaHandle = h;
            break;
          }
          if (h) await h.dispose();
        } catch {}
      }
      if (targetFrame && kanaHandle) break;

      // 促進クリック & 軽く待機
      await clickHereIfExists(formPage);
      await Promise.race([
        formPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 1200 }).catch(() => {}),
        sleep(800),
      ]);
    }

    if (!(targetFrame && kanaHandle && kanaHandle.asElement())) {
      await savePage(formPage, "before_fill");
      throw new Error("住宅名(カナ) の入力欄が見つかりませんでした。");
    }

    // ===== 入力 & 検索 =====
    const kanaEl = kanaHandle.asElement();
    await kanaEl.click({ clickCount: 3 }).catch(() => {});
    await kanaEl.type("コーシャハイム");
    await savePage(formPage, "after_fill");

    await clickSearchInFrame(targetFrame);
    await Promise.race([
      formPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 3000 }).catch(() => {}),
      sleep(1500),
    ]);
    await savePage(formPage, "after_submit_main");

    await savePage(formPage, "final");
  } catch (err) {
    console.error("Error:", err?.message || err);
    await ensureOut();
    await fs.writeFile(path.join(OUTDIR, "final_error.txt"), String(err?.stack || err));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(e => { console.error(e); process.exit(1); });
