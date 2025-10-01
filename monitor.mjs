// monitor.mjs — Puppeteer v22+ 対応・フル貼り替え用
// 住宅名(カナ) に「コーシャハイム」を入れて検索を実行し、out/ に保存

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const OUTDIR = "out";

async function ensureOut() {
  await fs.mkdir(OUTDIR, { recursive: true });
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function save(page, name) {
  await ensureOut();
  const png = path.join(OUTDIR, `${name}.png`);
  const htmlPath = path.join(OUTDIR, `${name}.html`);
  const content = await page.content();
  await fs.writeFile(htmlPath, content, "utf8");
  try {
    await page.screenshot({ path: png, fullPage: true });
  } catch (e) {
    await fs.writeFile(path.join(OUTDIR, `${name}.txt`), String(e));
  }
  console.log(`[saved] ${name}`);
}

function abs(u) { return u.startsWith("http") ? u : new URL(u, "https://jhomes.to-kousya.or.jp").href; }

async function waitForPopupLike(browser, substrings, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pages = browser.targets().filter(t => t.type() === "page");
    for (const t of pages) {
      const u = t.url();
      if (substrings.some(s => u.includes(s))) {
        const p = await t.page();
        if (p) return p;
      }
    }
    await sleep(250);
  }
  return null;
}

async function findKanaInputInFrame(frame) {
  return await frame.evaluateHandle(() => {
    const HINTS = ["住宅名", "カナ", "かな", "ｶﾅ"];
    function labelTextFor(el) {
      if (!el) return "";
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.textContent || "";
      }
      let cur = el;
      for (let i = 0; i < 5; i++) {
        const td = cur.closest("td,th");
        if (td) {
          let prev = td.previousElementSibling;
          while (prev) {
            const txt = prev.textContent?.trim() || "";
            if (txt) return txt;
            prev = prev.previousElementSibling;
          }
        }
        if (!td) break;
        cur = td;
      }
      return el.getAttribute("title") || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
    }
    const inputs = Array.from(document.querySelectorAll('input[type="text"],input:not([type]),textarea'));
    for (const el of inputs) {
      const label = labelTextFor(el);
      const hay = (label + " " + (el.getAttribute("name") || "") + " " + (el.getAttribute("title") || "")).toLowerCase();
      if (HINTS.some(h => hay.includes(h.toLowerCase()))) return el;
    }
    return null;
  });
}

async function clickSearchInFrame(frame) {
  const handle = await frame.evaluateHandle(() => {
    const byValue = Array.from(document.querySelectorAll('input[type="submit"],input[type="button"],button'))
      .find(el => /検索/.test(el.value || el.textContent || ""));
    if (byValue) return byValue;
    const frm = document.querySelector("form");
    if (frm) {
      const sub = frm.querySelector('input[type="submit"],button[type="submit"]');
      if (sub) return sub;
    }
    return null;
  });
  if (handle) {
    const el = handle.asElement();
    if (el) await el.click();
  }
}

async function main() {
  const executablePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
  console.log("[monitor] Using Chrome at:", executablePath);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1800, deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000);

    async function gotoAndSave(url, name) {
      await page.goto(abs(url), { waitUntil: "domcontentloaded" });
      await save(page, name);
    }

    await gotoAndSave("/", "home_1");
    await gotoAndSave("/search/jkknet/", "home_1_after");
    await gotoAndSave("/search/jkknet/index.html", "home_2");
    await gotoAndSave("/search/jkknet/service/", "home_2_after");

    // StartInit → 別ウィンドウ/フレームへ遷移
    await page.goto(abs("/search/jkknet/service/akiyaJyoukenStartInit"), {
      waitUntil: "domcontentloaded",
      referer: abs("/search/jkknet/service/"),
    });
    await save(page, "frameset_startinit");

    // 「こちら」をクリック（無ければ無視）
    await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a")).find(x => x.textContent?.includes("こちら"));
      if (a) a.click();
    }).catch(() => {});

    // 実フォームのページ（ポップアップ）を待つ
    let formPage = await waitForPopupLike(browser, [
      "/akiyaJyoukenStartMain",
      "/akiyaJyoukenStartMainInit",
      "/akiyaJyoukenStartMain.do",
      "/akiyaJyoukenStartMainAction",
      "/akiyaJyoukenStartMain.jsp",
      "/akiyaJyoukenStart",
    ], 12000);

    if (!formPage) formPage = page; // 同一ページ内遷移の保険

    await formPage.bringToFront().catch(() => {});
    await formPage.setViewport({ width: 1280, height: 2000, deviceScaleFactor: 1 }).catch(() => {});
    await save(formPage, "after_relay_1");

    // フレーム群の中から「住宅名(カナ)」入力を持つフレームを探す
    const frames = formPage.frames();
    console.log("[frames] count=", frames.length);
    let targetFrame = null;
    for (const f of frames) {
      try {
        const h = await findKanaInputInFrame(f);
        if (h && h.asElement()) { targetFrame = f; await h.dispose(); break; }
        if (h) await h.dispose();
      } catch {}
    }
    if (!targetFrame) targetFrame = formPage.mainFrame();

    // 入力＆検索
    const kanaHandle = await findKanaInputInFrame(targetFrame);
    if (!kanaHandle || !kanaHandle.asElement()) {
      await save(formPage, "before_fill");
      throw new Error("住宅名(カナ) の入力欄が見つかりませんでした。");
    }
    const kanaEl = kanaHandle.asElement();
    await kanaEl.click({ clickCount: 3 }).catch(() => {});
    await kanaEl.type("コーシャハイム");
    await save(formPage, "after_fill");

    await clickSearchInFrame(targetFrame);
    await sleep(1200);
    await save(formPage, "after_submit_main");

    await save(formPage, "final");
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
