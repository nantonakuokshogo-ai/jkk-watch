import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const OUT_DIR = "out";
const START_URL = "https://jhomes.to-kousya.or.jp/";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const KANA_WORD = process.env.JKK_KANA || "コーシャハイム";

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureOutDir() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function waitForNonZeroViewport(page, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const ok = await page.evaluate(() => {
      const w = window.innerWidth || 0;
      const h = window.innerHeight || 0;
      const dw = document.documentElement?.clientWidth || 0;
      const dh = document.documentElement?.clientHeight || 0;
      return Math.max(w, dw) > 0 && Math.max(h, dh) > 0;
    });
    if (ok) return;
    try {
      await page.setViewport({ width: 1279, height: 1999, deviceScaleFactor: 1 });
      await page.setViewport({ width: 1280, height: 2000, deviceScaleFactor: 1 });
    } catch {}
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
  }
}

async function save(page, base) {
  const png = path.join(OUT_DIR, `${base}.png`);
  const html = path.join(OUT_DIR, `${base}.html`);
  try {
    await fs.writeFile(html, await page.content(), "utf8");
  } catch (e) {
    console.warn(`[warn] write html failed for ${base}: ${e.message}`);
  }

  try {
    await waitForNonZeroViewport(page);
    await page.bringToFront().catch(() => {});
    await page.screenshot({ path: png, fullPage: true, captureBeyondViewport: false });
  } catch (e1) {
    console.warn(`[warn] screenshot 1st failed (${e1.message}); retry with fixed viewport`);
    try {
      await page.setViewport({ width: 1280, height: 2000, deviceScaleFactor: 1 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: png, fullPage: true, captureBeyondViewport: false });
    } catch (e2) {
      console.warn(`[warn] screenshot 2nd failed (${e2.message}); retry with clip`);
      try {
        await page.screenshot({
          path: png,
          clip: { x: 0, y: 0, width: 1280, height: 2000 },
          captureBeyondViewport: true,
        });
      } catch (e3) {
        console.warn(`[warn] screenshot 3rd failed (${e3.message}); giving up for ${base}`);
      }
    }
  }
  console.log(`[saved] ${base}`);
}

async function goto(page, url, label) {
  console.log(`[goto] ${url}`);
  await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle0"], timeout: 60000 });
  await page.waitForSelector("body", { timeout: 30000 });
  await waitForNonZeroViewport(page);
  if (label) await save(page, label);
}

/** 画面内に特定テキストが含まれるか（XPath非依存） */
async function hasText(page, needles) {
  return await page.evaluate((subs) => {
    const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.nodeValue || "").trim();
      if (!t) continue;
      if (subs.some((s) => t.includes(s))) return true;
    }
    // 代替：aria-labelやtitleにも一応目を通す
    const all = Array.from(document.querySelectorAll("[aria-label],[title]"));
    return all.some((el) => {
      const a = el.getAttribute("aria-label") || "";
      const b = el.getAttribute("title") || "";
      return subs.some((s) => a.includes(s) || b.includes(s));
    });
  }, needles);
}

/** 指定文字列を含む「押せる」要素を探してクリック（XPath非依存） */
async function clickByText(page, text) {
  return await page.evaluate((needle) => {
    const cands = Array.from(
      document.querySelectorAll('a,button,input[type="submit"],[role="button"]')
    );
    const getText = (el) =>
      (el.innerText || el.textContent || "") + ("value" in el ? el.value || "" : "");
    const el = cands.find((e) => getText(e).replace(/\s+/g, " ").includes(needle));
    if (!el) return false;
    // クリック
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    el.dispatchEvent(evt);
    if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) {
      try { el.click(); } catch {}
    }
    return true;
  }, text);
}

/** 住宅名(カナ)入力＋検索（XPath非依存） */
async function fillKanaAndSearch(page, kana) {
  await waitForNonZeroViewport(page);

  // 入力欄を探して値を入れる
  const filled = await page.evaluate((v) => {
    function match(el) {
      if (!(el instanceof HTMLInputElement)) return false;
      if (el.type === "hidden") return false;
      const id = (el.id || "").toLowerCase();
      const name = (el.name || "").toLowerCase();
      const ph = el.placeholder || "";
      const title = el.title || "";
      const aria = el.getAttribute("aria-label") || "";
      if (id.includes("kana") || name.includes("kana")) return true;
      if (ph.includes("カナ") || title.includes("カナ") || aria.includes("カナ")) return true;
      return false;
    }
    const inputs = Array.from(document.querySelectorAll("input"));
    const target = inputs.find(match) || inputs.find((el) => el.type !== "hidden");
    if (!target) return false;
    target.focus();
    target.value = v;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, kana);

  // 検索ボタン押下
  const clicked = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll('button, input[type="submit"], a, [role="button"]')
    );
    const getText = (el) =>
      (el.innerText || el.textContent || "") + ("value" in el ? el.value || "" : "");
    const target =
      els.find((e) => /検索する/.test(getText(e))) ||
      els.find((e) => /検索/.test(getText(e)));
    if (!target) return false;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(evt);
    if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) {
      try { target.click(); } catch {}
    }
    return true;
  });

  if (clicked) {
    // 遷移待ち（遷移しないUIでもタイムアウトで進む）
    await page
      .waitForNavigation({ waitUntil: ["domcontentloaded", "networkidle0"], timeout: 60000 })
      .catch(() => {});
  }
  return filled || clicked;
}

async function main() {
  await ensureOutDir();

  console.log(`[monitor] Using Chrome at: ${CHROME_PATH}`);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    defaultViewport: null, // 実ウィンドウを使う
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,2400",
      "--lang=ja-JP",
      "--force-device-scale-factor=1",
    ],
  });

  const page = await browser.newPage();

  try {
    // 入口～service
    await goto(page, START_URL, "home_1");
    await save(page, "home_1_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/", "home_2");
    await save(page, "home_2_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/index.html", "home_3");
    await save(page, "home_3_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/service/", "home_4");
    await save(page, "home_4_after");

    // StartInit（frameset）
    console.log("[frameset] direct goto StartInit with referer=/service/");
    await goto(
      page,
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
      "frameset_startinit"
    );

    // タイムアウト/お詫びから戻る
    if (await hasText(page, ["お詫び", "タイムアウト"])) {
      console.log("[recover] apology -> back to top");
      await clickByText(page, "トップページへ戻る");
      await save(page, `home_${ts()}`);
    }

    // 「住宅名(カナ)」にコーシャハイムを入れて検索
    await save(page, "after_relay_1");
    await fillKanaAndSearch(page, KANA_WORD);

    await save(page, "after_submit_main");
    await save(page, "final");
  } catch (e) {
    console.error(e);
    await save(page, "final_error");
    throw e;
  } finally {
    await browser.close();
  }
}

main().catch(() => process.exit(1));
