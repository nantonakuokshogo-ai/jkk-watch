// monitor.mjs — JKKねっと 条件入力→「住宅名（カナ）」= コーシャハイム → 検索 → 一覧を保存
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

const OUT = process.env.OUT_DIR || "artifacts";
const WORD = (process.env.JKK_WORD || "コーシャハイム").trim();

// 公式トップ（リンク導線を優先）
const TOP_CANDIDATES = [
  "https://www.to-kousya.or.jp/chintai/index.html",
  "https://www.to-kousya.or.jp/chintai/",
  "https://www.to-kousya.or.jp/jkk/",
  "https://www.to-kousya.or.jp/",
];

// 直行フォールバック（Referer 必須）
const START_CANDIDATES = [
  "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
  "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaStartInit",
  "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyachizuStartInit",
  "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenInitMobile",
];

const SELECTORS_SEARCH_LINK = [
  'a[href*="akiyaJyoukenStartInit"]',
  'a[href*="akiyaJyoukenInit"]',
  'a[href*="akiyachizuStartInit"]',
  'a:has-text("お部屋を検索")',
  'a:has-text("JKKねっと")',
  'a:has-text("空")',
  'a:has-text("あき家")',
  'a:has-text("先着順")',
  'a:has-text("条件から")',
];

const KANA_INPUT_EXPRS = [
  // 正式name（旧サイト）
  'input[name="akiyaInitRM.akiyaRefM.jyutakuKanaName"]',
  // ラベルの直後のinput
  'xpath=//td[contains(normalize-space(.),"住宅名") and contains(normalize-space(.),"カナ")]/following::input[@type="text"][1]',
  'xpath=//label[contains(normalize-space(.),"住宅名") and contains(normalize-space(.),"カナ")]/following::input[1]',
  // ARIA/placeholder 保険
  'input[aria-label*="住宅名"][aria-label*="カナ"]',
  'input[placeholder*="カナ"]',
  // 最後の保険
  'input[type="text"]',
];

const SEARCH_BUTTON_EXPRS = [
  'input[type="image"][alt*="検索"]',
  'input[type="submit"][value*="検索"]',
  'button:has-text("検索")',
  'button:has-text("検索する")',
  'a:has-text("検索")',
];

function nowTag() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }
async function dump(page, base) {
  await ensureDir(OUT);
  const html = await page.content();
  await fs.writeFile(path.join(OUT, `${base}.html`), html, "utf8");
  await page.screenshot({ path: path.join(OUT, `${base}.png`), fullPage: true }).catch(() => {});
  console.log(`[artifacts] ${base}.html / ${base}.png`);
}
async function gotoWithRetries(page, urls, tries = 3) {
  let lastErr;
  for (const url of urls) {
    for (let i = 1; i <= tries; i++) {
      try {
        console.log(`[goto] (${i}/${tries}) ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
        return url;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || "");
        if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|net::ERR/.test(msg)) {
          const backoff = 800 * i;
          console.log(`[goto-retry] ${url} -> ${msg.trim()} (sleep ${backoff}ms)`);
          await page.waitForTimeout(backoff);
          continue;
        }
        console.log(`[goto-skip] ${url} -> ${msg.trim()}`);
        break;
      }
    }
  }
  throw lastErr || new Error("goto failed");
}
async function clickFirstIfVisible(root, selectors) {
  for (const sel of selectors) {
    const loc = root.locator(sel).first();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 5000 });
        return true;
      }
    } catch {}
  }
  return false;
}
async function fillFirstIfVisible(root, selectors, value) {
  for (const sel of selectors) {
    const loc = root.locator(sel).first();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        await loc.fill(value, { timeout: 7000 });
        return true;
      }
    } catch {}
  }
  return false;
}
async function findHrefByText(page, regex) {
  return page.evaluate((reStr) => {
    const re = new RegExp(reStr);
    for (const a of Array.from(document.querySelectorAll("a"))) {
      const t = (a.innerText || a.textContent || "").replace(/\s+/g, "");
      const label = (a.getAttribute("aria-label") || "").replace(/\s+/g, "");
      if (re.test(t) || re.test(label)) {
        try { return new URL(a.getAttribute("href"), location.href).href; } catch {}
      }
    }
    return null;
  }, regex.source);
}

async function openConditions(context) {
  // 1) 公式トップから（最優先）
  const page = await context.newPage();
  await gotoWithRetries(page, TOP_CANDIDATES);
  await page.waitForLoadState("networkidle").catch(() => {});
  await dump(page, `landing_${nowTag()}`);

  // クリックで開く（新窓 or 同タブ）
  const popupPromise = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
  const clicked = await clickFirstIfVisible(page, SELECTORS_SEARCH_LINK);
  let cond = null;
  if (clicked) {
    cond = (await popupPromise) || page;
  } else {
    // テキストから href を拾って直遷移
    const href =
      (await findHrefByText(page, /こだわり条件|お部屋を検索|JKKねっと|先着順|条件から/)) || null;
    if (href) {
      console.log(`[nav] fallback goto href: ${href}`);
      await gotoWithRetries(page, [href]);
      cond = page;
    }
  }
  if (cond) {
    await cond.waitForLoadState("domcontentloaded").catch(() => {});
    return cond;
  }

  // 2) 直行フォールバック（Referer 必須）
  console.log("[nav] direct fallback to JKKnet with Referer");
  const direct = await context.newPage();
  for (const u of START_CANDIDATES) {
    try {
      await direct.goto(u, { waitUntil: "domcontentloaded", timeout: 25000 });
      return direct;
    } catch {}
  }
  throw new Error("条件ページへ到達できませんでした");
}

(async () => {
  // Referer を明示（直行フォールバック時に必須）
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    extraHTTPHeaders: { Referer: "https://www.to-kousya.or.jp/chintai/index.html" },
  });
  context.setDefaultTimeout(20000);

  try {
    const cond = await openConditions(context);
    await dump(cond, "popup_top");

    // 条件入力はフレーム/現ページの両方を探索
    const roots = [cond, ...cond.frames()];

    // 住宅名（カナ）入力
    let filled = false;
    for (const r of roots) {
      if (await fillFirstIfVisible(r, KANA_INPUT_EXPRS, WORD)) {
        filled = true; break;
      }
    }
    if (!filled) {
      console.warn("[warn] 住宅名（カナ）入力欄が見つかりませんでした");
      await dump(cond, "jyouken_filled_html_error");
    } else {
      console.log(`[info] 入力: 住宅名（カナ） = ${WORD}`);
      await dump(cond, "jyouken_filled");
    }

    // 検索実行（画像ボタン/submit/JS関数 各対応）
    let clicked = false;
    for (const r of roots) {
      if (await clickFirstIfVisible(r, SEARCH_BUTTON_EXPRS)) { clicked = true; break; }
    }
    if (!clicked) {
      // JSサブミットの保険
      try {
        await cond.evaluate(() => {
          if (typeof window.submitAction === "function") { window.submitAction("akiyaJyoukenRef"); return; }
          if (typeof window.submitPage === "function") { window.submitPage("akiyaJyoukenResult"); return; }
          const f = document.forms?.[0]; if (f) f.submit();
        });
      } catch {}
    }

    // 結果待ち＆保存
    await cond.waitForLoadState("domcontentloaded").catch(() => {});
    // 一覧は別ページになることもあるので最も“それっぽい”ページを選ぶ
    await cond.waitForTimeout(1500);
    const all = context.pages();
    const result =
      all.find(p => /Result|List|kensaku|ichiran|akiyake/i.test(p.url())) ||
      all.find(p => /jkknet\/service/i.test(p.url())) ||
      cond;

    await result.waitForLoadState("domcontentloaded").catch(() => {});
    await dump(result, "result_list");

    await browser.close();
  } catch (e) {
    console.error("[fatal]", e);
    try {
      const last = context.pages().at(-1);
      if (last) await dump(last, "last_page_fallback");
    } catch {}
    await browser.close();
    process.exit(1);
  }
})();
