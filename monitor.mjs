// monitor.mjs  — ESM / Puppeteer-core v22+ 対応版
// - $x / waitForTimeout を使わない
// - 中継(wait.jsp → StartInit)の挙動にフォールバック
// - 「住宅名(カナ)」を高耐性で特定して「コーシャハイム」を入力
// - 「検索する」をクリックして結果を保存

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";

const OUTDIR = "out";
const BASE = "https://jhomes.to-kousya.or.jp";
const KANA_KEYWORD = "コーシャハイム";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(...args);
}

function ensureOut() {
  fs.mkdirSync(OUTDIR, { recursive: true });
}

async function save(page, name) {
  ensureOut();
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const png = path.join(OUTDIR, `${safe}.png`);
  const html = path.join(OUTDIR, `${safe}.html`);
  try {
    const content = await page.content();
    fs.writeFileSync(html, content, "utf8");
  } catch {}
  try {
    await page.screenshot({ path: png, fullPage: true });
    log(`[saved] ${safe}`);
  } catch (e) {
    log(`[warn] screenshot failed for ${safe}: ${e.message}`);
  }
}

async function goto(page, url, name) {
  log("[goto]", url.replace(BASE, ""));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // ビューポート未設定だと 0x0 になりスクショ失敗することがある
  await page.setViewport({ width: 1200, height: 2200, deviceScaleFactor: 1 });
  // ネットワークの静穏を軽く待つ
  await sleep(800);
  await save(page, name);
}

async function hideObstacles(page) {
  // チャット/フローティング類が被ることがあるので隠す
  await page.addStyleTag({
    content: `
      #bot-container, #bot, .mediatalk-widget, [id*="MediaTalk"], iframe[src*="mediatalk"] { display:none !important; }
      .fixed, .sticky, [style*="position: fixed"] { z-index: 1 !important; }
    `,
  });
}

async function forceForwardOnStartInit(page) {
  // frameset_startinit のフォールバック: submitNext() or form.submit()
  await page.evaluate(() => {
    try {
      if (typeof submitNext === "function") submitNext();
    } catch {}
    try {
      const f = document.forms?.forwardForm;
      if (f && typeof f.submit === "function") f.submit();
    } catch {}
  });
}

function pickChromePath() {
  // Actions の Ubuntu ランナーでは /usr/bin/google-chrome が入っているはず
  const cands = [
    process.env.GOOGLE_CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const p of cands) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return undefined;
}

// 目視テキストで「住宅名(カナ)」欄を推定して返す（なければ null）
async function findKanaInput(handleRoot) {
  return await handleRoot.evaluateHandle(() => {
    const isVisible = (el) => {
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        st.visibility !== "hidden" &&
        st.display !== "none"
      );
    };

    // 候補: テキスト入力すべて
    const inputs = Array.from(
      document.querySelectorAll('input[type="text"], input:not([type]), textarea')
    ).filter(isVisible);

    // スコアリング: 近傍の文言や属性に「住宅名」「カナ」が含まれるほど高得点
    const scoreOf = (el) => {
      let score = 0;
      const attrs =
        (el.name || "") +
        " " +
        (el.id || "") +
        " " +
        (el.getAttribute("title") || "") +
        " " +
        (el.getAttribute("placeholder") || "");
      if (/kana|ｶﾅ/i.test(attrs)) score += 3;
      if (/jutaku|jyutaku|jtk|ju?tak(u)?|住宅名/i.test(attrs)) score += 3;

      const near = (node) => (node ? node.textContent || "" : "");
      const box = el.closest("td,th,div,li,section,fieldset,form") || document.body;
      const text = (near(box) + " " + near(box.previousElementSibling))
        .replace(/\s+/g, "");
      if (text.includes("住宅名")) score += 4;
      if (text.includes("カナ") || text.includes("（カナ）") || text.includes("ｶﾅ")) score += 4;

      // テーブルの行見出しセルにヒントがあるケース
      const row = el.closest("tr");
      if (row) {
        const head = row.querySelector("th,td");
        if (head) {
          const t = head.textContent.replace(/\s+/g, "");
          if (t.includes("住宅名")) score += 2;
          if (t.includes("カナ") || t.includes("ｶﾅ")) score += 2;
        }
      }
      return score;
    };

    let best = null;
    let bestScore = -1;
    for (const el of inputs) {
      const s = scoreOf(el);
      if (s > bestScore) {
        best = el;
        bestScore = s;
      }
    }
    return best;
  });
}

async function typeKanaInto(pageOrFrame, text) {
  // トップ→各 frame の順に探索して最初に見つかった入力にタイプする
  const roots = [pageOrFrame, ...pageOrFrame.frames?.() ?? []];

  for (const root of roots) {
    try {
      const handleRoot = "evaluate" in root ? root : root.page(); // Page or Frame
      const targetHandle = await findKanaInput(handleRoot);
      const isNull = await targetHandle.evaluate((n) => n == null);
      if (isNull) continue;

      await hideObstacles("page" in root ? root : await root.page?.());
      await (("bringToFront" in root && root.bringToFront) ? root.bringToFront() : null);

      // 入力
      const ok = await targetHandle.evaluate((el, value) => {
        el.focus();
        // 既存値クリア
        if ("value" in el) el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        // 入力
        if ("value" in el) el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }, text);

      if (ok) return true;
    } catch (e) {
      // 次の root へ
    }
  }
  return false;
}

async function clickSearch(page) {
  // 「検索する」ボタンを可視要素から探してクリック
  const clickedTop = await page.evaluate(() => {
    const isVisible = (el) => {
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        st.visibility !== "hidden" &&
        st.display !== "none"
      );
    };
    const els = Array.from(
      document.querySelectorAll('button, input[type="submit"], input[type="button"], a')
    ).filter(isVisible);

    const match = els.find(
      (el) =>
        /検索する/.test(el.textContent || "") ||
        /検索する/.test(el.getAttribute("value") || "")
    );
    if (match) {
      match.click();
      return true;
    }
    return false;
  });
  if (clickedTop) return true;

  // frame 内も探索
  for (const f of page.frames()) {
    try {
      const clicked = await f.evaluate(() => {
        const isVisible = (el) => {
          const st = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            st.visibility !== "hidden" &&
            st.display !== "none"
          );
        };
        const els = Array.from(
          document.querySelectorAll('button, input[type="submit"], input[type="button"], a')
        ).filter(isVisible);
        const match = els.find(
          (el) =>
            /検索する/.test(el.textContent || "") ||
            /検索する/.test(el.getAttribute("value") || "")
        );
        if (match) {
          match.click();
          return true;
        }
        return false;
      });
      if (clicked) return true;
    } catch {}
  }
  return false;
}

async function main() {
  const executablePath = pickChromePath();
  console.log("[monitor] Using Chrome at:", executablePath || "(auto)");

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1200,2200",
    ],
    defaultViewport: { width: 1200, height: 2200 },
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36"
  );
  page.setDefaultTimeout(60_000);

  try {
    // 1) トップ → jkknet 入口 → index → service
    await goto(page, `${BASE}/`, "home_1");
    await save(page, "home_1_after");

    await goto(page, `${BASE}/search/jkknet/`, "home_2");
    await save(page, "home_2_after");

    await goto(page, `${BASE}/search/jkknet/index.html`, "home_3");
    await save(page, "home_3_after");

    await goto(page, `${BASE}/search/jkknet/service/`, "home_4");
    await save(page, "home_4_after");

    // 2) 中継ページ（frameset_startinit 相当）へ直接
    log("[frameset] direct goto StartInit with referer=/service/");
    await goto(
      page,
      `${BASE}/search/jkknet/service/akiyaJyoukenStartInit`,
      "frameset_startinit"
    );

    // 自動遷移が止まることがあるのでフォース
    await forceForwardOnStartInit(page);
    await sleep(1200);

    // ここで本体画面が出てくる想定
    await hideObstacles(page);
    await save(page, "after_relay_1");

    // 3) 「住宅名(カナ)」に "コーシャハイム" を入力
    await save(page, "before_fill");
    const filled = await typeKanaInto(page, KANA_KEYWORD);
    if (!filled) {
      throw new Error("住宅名(カナ) の入力欄が見つかりませんでした。");
    }

    // 4) 「検索する」をクリック
    const clicked = await clickSearch(page);
    if (!clicked) {
      throw new Error("「検索する」ボタンを見つけられませんでした。");
    }

    // 遷移待ち & 保存
    await sleep(1500);
    await hideObstacles(page);
    await save(page, "after_submit_main");

    // 念のため最終も保存
    await save(page, "final");
  } catch (err) {
    console.error("Error:", err.message || err);
    await save(page, "final_error");
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch(() => process.exit(1));
