// monitor.mjs ーーーコピペでそのまま置換OK

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

// ==== 小物ユーティリティ ====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureOut() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

function ts() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

// スクショ & HTML 保存（幅0エラー対策のため viewport を毎回確認）
async function save(page, base) {
  await ensureOut();
  // 念のため viewport を確実にセット
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

// 目視相当の「見えて押せる」判定
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

// 文字でクリック（a, button, input[type=button|submit]）
async function clickByText(page, text) {
  const handle = await page.evaluateHandle((t, isVisible) => {
    const visible = eval(isVisible); // 関数ソースを受け取って復元
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

// 単純遷移＋安定化＋保存
async function gotoAndSave(page, url, name) {
  console.log(`[goto] ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  // 若干待って描画安定
  await sleep(500);
  await save(page, name);
}

// 「おわび」「ページが見つかりません」「タイムアウト」等から復帰
async function recoverIfApology(page) {
  const flag = await page.evaluate(() => {
    const t = document.body?.innerText || "";
    return /おわび|ページが見つかりません|タイムアウト|トップページへ戻る/.test(t);
  });
  if (!flag) return false;

  console.log("[recover] apology -> back to top");
  // 「トップページへ戻る」を押す
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

// チャット/オーバーレイ等を隠す（検索ボタンが隠れるのを防ぐ）
async function hideOverlays(page) {
  await page.evaluate(() => {
    // 目立つチャット系を削除
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

// 「住宅名(カナ)」入力欄を探して入力
async function fillKanaAndSearch(page, text) {
  // 入力欄を探す（ラベル近傍のinput）
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

    // 候補となるラベル要素群
    const labelish = Array.from(
      document.querySelectorAll("label,th,td,span,div")
    ).filter((el) => /住宅名/.test(el.textContent || "") && /カナ/.test(el.textContent || ""));

    // 近傍のinput[type=text]を探す
    let input = null;
    for (const lab of labelish) {
      const tr = lab.closest("tr");
      if (tr) {
        input = tr.querySelector('input[type="text"], input:not([type])');
        if (input && visible(input)) break;
      }
      input = lab.querySelector('input[type="text"], input:not([type])');
      if (input && visible(input)) break;
      // 兄弟方向
      input =
        lab.nextElementSibling?.querySelector?.(
          'input[type="text"], input:not([type])'
        ) || null;
      if (input && visible(input)) break;
    }

    // 最後の手、placeholder などから推定
    if (!input) {
      input = Array.from(
        document.querySelectorAll('input[type="text"], input:not([type])')
      ).find((el) =>
        /カナ|住宅|棟|住戸/.test(
          (el.getAttribute("name") || "") +
            (el.getAttribute("id") || "") +
            (el.placeholder || "")
        )
      );
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

  // 検索ボタンを押す（画面に2個あることが多いので最初の見えてる方）
  await hideOverlays(page);
  const clicked =
    (await clickByText(page, "検索する")) ||
    (await clickByText(page, "検索")) ||
    (await clickByText(page, "けんさく"));
  if (!clicked) throw new Error("検索ボタンが見つかりませんでした。");
  // 遷移・描画安定待ち
  await sleep(1500);
}

// ==== メインフロー ====
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
    // 1) TOP → JKKねっとTOP へ
    await gotoAndSave(page, "https://jhomes.to-kousya.or.jp/", "home_1");
    await save(page, "home_1_after");

    // 2) JKKねっとトップ
    await gotoAndSave(page, "https://jhomes.to-kousya.or.jp/search/jkknet/", "home_2");
    await save(page, "home_2_after");

    // 3) index
    await gotoAndSave(
      page,
      "https://jhomes.to-kousya.or.jp/search/jkknet/index.html",
      "home_3"
    );
    await save(page, "home_3_after");

    // 4) service
    await gotoAndSave(
      page,
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/",
      "home_4"
    );
    await save(page, "home_4_after");

    // 5) frameset 起点へ
    console.log("[frameset] direct goto StartInit with referer=/service/");
    await gotoAndSave(
      page,
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
      "frameset_startinit"
    );

    // おわび等で弾かれたら戻して再突入
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

    // 6) 「住宅名(カナ)」へ入力 → 検索
    await hideOverlays(page);
    await fillKanaAndSearch(page, KANA_QUERY);
    await save(page, "after_submit_main");

    // 7) 最終保存
    await save(page, "final");
  } catch (err) {
    console.error(err);
    try {
      await save(page, "final_error");
    } catch {}
    await browser.close();
    process.exit(1);
  }

  await browser.close();
}

main();
