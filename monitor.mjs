// monitor.mjs ーーーコピペ置換OK

import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer-core";

// ==== 設定 ====
const OUT_DIR = "out";
const CHROME_BIN =
  process.env.GOOGLE_CHROME_BINARY ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/usr/bin/google-chrome";

// 住宅名(カナ) に入れる語
const KANA_QUERY = "コーシャハイム";

// ==== ユーティリティ ====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureOut() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

function ts() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function save(page, base) {
  await ensureOut();
  const vp = page.viewport();
  if (!vp || !vp.width || !vp.height) {
    await page.setViewport({ width: 1366, height: 2400, deviceScaleFactor: 1 });
    await sleep(100);
  }
  const png = path.join(OUT_DIR, `${base}.png`);
  const html = path.join(OUT_DIR, `${base}.html`);
  await fs.writeFile(html, await page.content());
  await page.screenshot({ path: png, fullPage: true });
  console.log(`[saved] ${base}`);
}

function visibleScript() {
  return (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
}

async function clickByText(page, text) {
  const handle = await page.evaluateHandle((t, isVisible) => {
    const visible = eval(isVisible);
    const cands = [
      ...document.querySelectorAll(
        'a,button,input[type="button"],input[type="submit"]'
      ),
    ].filter(
      (el) =>
        visible(el) &&
        ((el.innerText && el.innerText.includes(t)) ||
          (el.value && el.value.includes(t)))
    );
    return cands[0] || null;
  }, text, visibleScript.toString());

  if (!handle) return false;
  try {
    await handle.click();
    return true;
  } finally {
    await handle.dispose();
  }
}

async function gotoAndSave(page, url, name) {
  console.log(`[goto] ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(500);
  await save(page, name);
}

async function recoverIfApology(page) {
  const flag = await page.evaluate(() => {
    const t = document.body?.innerText || "";
    return /おわび|ページが見つかりません|タイムアウト|トップページへ戻る/.test(t);
  });
  if (!flag) return false;

  console.log("[recover] apology -> back to top");
  const clicked =
    (await clickByText(page, "トップページへ戻る")) ||
    (await clickByText(page, "トップページへ")) ||
    (await clickByText(page, "トップページ"));
  if (clicked) {
    await sleep(1200);
    await save(page, `home_${ts()}`);
    return true;
  }
  return false;
}

async function hideOverlays(page) {
  await page.evaluate(() => {
    const killers = [
      'iframe[src*="mediatalk"]',
      'iframe[id*="media"]',
      ".mtm-app",
      '[id*="MediaTalk"]',
      '[class*="MediaTalk"]',
      '[style*="z-index: 2147483647"]',
    ];
    killers.forEach((sel) =>
      document.querySelectorAll(sel).forEach((el) => el.remove())
    );
  });
}

// === 強化版: 「住宅名(カナ)」入力 ＆ 検索実行 ===
async function fillKanaAndSearch(page, text) {
  // 作業前の状態を保存（診断用）
  await save(page, "before_fill");

  const ok = await page.evaluate((val) => {
    const visible = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return (
        cs.display !== "none" &&
        cs.visibility !== "hidden" &&
        r.width > 0 &&
        r.height > 0
      );
    };
    const hasKW = (node) => {
      if (!node) return false;
      const s = (node.textContent || "").replace(/\s+/g, "");
      return /住宅|住宅名/.test(s) && /カナ|ｶﾅ|ヨミ|ﾖﾐ|ﾌﾘｶﾞﾅ|フリガナ/.test(s);
    };

    let input = null;
    const allInputs = Array.from(
      document.querySelectorAll('input[type="text"], input:not([type])')
    ).filter(visible);

    // A) ラベル/近傍探索
    if (!input) {
      for (const inp of allInputs) {
        let node = inp;
        let hit = false;
        for (let i = 0; i < 4 && node; i++) {
          const prev = node.previousElementSibling;
          if (prev && hasKW(prev)) {
            hit = true;
            break;
          }
          node = node.parentElement;
          if (node && hasKW(node)) {
            hit = true;
            break;
          }
        }
        if (hit) {
          input = inp;
          break;
        }
      }
    }

    // B) 属性名から推測
    if (!input) {
      input = allInputs.find((el) =>
        /(kana|yomi|kanaName|yomigana|kana\w*|yomi\w*|ｶﾅ|カナ)/i.test(
          (el.name || "") + (el.id || "") + (el.placeholder || "")
        )
      );
    }

    // C) 上部&幅広のテキスト入力（最後の保険）
    if (!input && allInputs.length) {
      allInputs.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        // 上にある & 幅が広い順
        return ra.top - rb.top || rb.width - ra.width;
      });
      input = allInputs[0];
    }

    if (!input) return false;

    input.focus();
    input.value = "";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.value = val;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return true;
  }, text);

  if (!ok) throw new Error("住宅名(カナ) の入力欄が見つかりませんでした。");

  await hideOverlays(page);

  // 検索ボタンへスクロールしてクリック
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('a,button,input[type="button"],input[type="submit"]')].filter(
      (el) => /検索する|検索/.test((el.innerText || el.value || "").trim())
    );
    if (btns[0]) btns[0].scrollIntoView({ block: "center" });
  });

  const clicked =
    (await clickByText(page, "検索する")) || (await clickByText(page, "検索"));
  if (!clicked) throw new Error("検索ボタンが見つかりませんでした。");

  await sleep(2000);
}

// ==== メイン ====
async function main() {
  console.log(`[monitor] Using Chrome at: ${CHROME_BIN}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: "new",
    defaultViewport: { width: 1366, height: 2400, deviceScaleFactor: 1 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--lang=ja-JP",
      "--window-size=1366,2400",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 2400, deviceScaleFactor: 1 });

  try {
    await gotoAndSave(page, "https://jhomes.to-kousya.or.jp/", "home_1");
    await save(page, "home_1_after");

    await gotoAndSave(page, "https://jhomes.to-kousya.or.jp/search/jkknet/", "home_2");
    await save(page, "home_2_after");

    await gotoAndSave(
      page,
      "https://jhomes.to-kousya.or.jp/search/jkknet/index.html",
      "home_3"
    );
    await save(page, "home_3_after");

    await gotoAndSave(
      page,
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/",
      "home_4"
    );
    await save(page, "home_4_after");

    console.log("[frameset] direct goto StartInit with referer=/service/");
    await gotoAndSave(
      page,
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
      "frameset_startinit"
    );

    if (await recoverIfApology(page)) {
      await gotoAndSave(
        page,
        "https://jhomes.to-kousya.or.jp/search/jkknet/",
        `home_${ts()}`
      );
      await gotoAndSave(
        page,
        "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
        "after_relay_1"
      );
    } else {
      await save(page, "after_relay_1");
    }

    await hideOverlays(page);
    await fillKanaAndSearch(page, KANA_QUERY);
    await save(page, "after_submit_main");

    await save(page, "final");
  } catch (err) {
    console.error("Error:", err.message || err);
    try {
      await save(page, "final_error");
    } catch {}
    await browser.close();
    process.exit(1);
  }

  await browser.close();
}

main();
