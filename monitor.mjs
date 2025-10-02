// monitor.mjs
// Node20 + puppeteer-core v23 / 旧API未使用（waitForTimeout等）
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE_URL = process.env.BASE_URL ?? "https://jhomes.to-kousya.or.jp";
const KANA = process.env.KANA ?? "コーシャハイム";
const VIEWPORT_W = Number(process.env.VIEWPORT_W ?? 1440);
const VIEWPORT_H = Number(process.env.VIEWPORT_H ?? 2200);
const OUT_DIR = "out";

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function safeScreenshot(page, filePath, { fullPage = true } = {}) {
  // 1st try
  try {
    await page.screenshot({ path: filePath, fullPage });
    return;
  } catch (e1) {
    console.warn(`[warn] screenshot failed 1st: ${e1.message}`);
  }
  // Re-ensure viewport then retry
  try {
    await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });
    // 最低限の高さを確保（空DOMで0高さになっている場合の保険）
    await page.evaluate(() => {
      if (document.body) {
        document.body.style.minHeight = "10px";
      }
    });
    // 少しでもレイアウトが立ったら撮り直し
    await page.waitForFunction(
      () => document.documentElement.clientWidth > 0 && document.documentElement.clientHeight > 0,
      { timeout: 3000 }
    ).catch(() => {});
    await page.screenshot({ path: filePath, fullPage });
  } catch (e2) {
    console.warn(`[warn] screenshot failed 2nd: ${e2.message}`);
    // 最後は viewport クリップで妥協撮影
    try {
      await page.screenshot({ path: filePath, fullPage: false });
    } catch (e3) {
      console.warn(`[warn] screenshot final failed: ${e3.message}`);
    }
  }
}

async function savePage(page, name) {
  await ensureDir(OUT_DIR);
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  await fs.writeFile(path.join(OUT_DIR, `${name}.html`), html, "utf8");
  await safeScreenshot(page, path.join(OUT_DIR, `${name}.png`), { fullPage: true });
  console.log(`[saved] ${name}`);
}

function logFrames(page) {
  const frames = page.frames();
  console.log(`[frames] count=${frames.length}`);
  frames.forEach((f, i) => console.log(`[frame#${i}] name=${f.name() || "-"} url=${f.url()}`));
  return frames;
}

// ラベル近傍 input を探索して type（フレーム横断）
async function typeByNearbyLabelAcrossFrames(page, labelText, value) {
  const frames = page.frames();
  for (const frame of frames) {
    const handle = await frame.evaluateHandle((text) => {
      const snapshot = document.evaluate(
        `//*[contains(normalize-space(.), "${text}")]`,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      function findInputNear(el) {
        const q = 'input[type="text"], input:not([type]), input[type="search"]';
        let inp = el.querySelector(q);
        if (inp) return inp;
        const cell = el.closest("td,th,div,li,label,dt,dd");
        if (cell?.nextElementSibling) {
          inp = cell.nextElementSibling.querySelector(q);
          if (inp) return inp;
        }
        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i++) {
          inp = p.querySelector(q);
          if (inp) return inp;
          p = p.parentElement;
        }
        if (cell?.parentElement) {
          const sibs = Array.from(cell.parentElement.children);
          for (const s of sibs) {
            inp = s.querySelector(q);
            if (inp) return inp;
          }
        }
        return null;
      }
      for (let i = 0; i < snapshot.snapshotLength; i++) {
        const el = snapshot.snapshotItem(i);
        const target = findInputNear(el);
        if (target) return target;
      }
      return null;
    }, labelText);

    const el = handle.asElement();
    if (el) {
      await el.focus();
      await frame.evaluate((e) => (e.value = ""), el);
      await el.type(value, { delay: 20 });
      return { frame, element: el };
    } else {
      await handle.dispose();
    }
  }
  throw new Error(`${labelText} の入力欄が見つかりませんでした。`);
}

async function clickByTextAcrossFrames(page, text) {
  const frames = page.frames();
  for (const frame of frames) {
    const clicked = await frame.evaluate((t) => {
      t = t.trim();
      const clickEl = (el) => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      };
      const inputs = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"]'));
      for (const i of inputs) if ((i.value || "").trim().includes(t)) return clickEl(i);
      const btns = Array.from(document.querySelectorAll("button"));
      for (const b of btns) if ((b.textContent || "").trim().includes(t)) return clickEl(b);
      const anchors = Array.from(document.querySelectorAll("a"));
      for (const a of anchors) if ((a.textContent || "").trim().includes(t)) return clickEl(a);
      return false;
    }, text);
    if (clicked) return true;
  }
  return false;
}

async function waitForPopupFrom(page) {
  const popup = await page.waitForEvent("popup", { timeout: 15000 });
  await popup.bringToFront();
  // popup にも viewport を適用（0x0対策）
  await popup.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });
  console.log(`[popup] targetName=${popup.target()._targetInfo?.targetName ?? ""}`);
  return popup;
}

async function main() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (!executablePath) {
    console.error("Chromium/Chrome の実行パスが見つかりません（PUPPETEER_EXECUTABLE_PATH or CHROME_PATH）。");
    process.exit(1);
  } else {
    console.log(`[monitor] Using Chrome at: ${executablePath}`);
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    // ここでウィンドウサイズを固定し、defaultViewport は null にする（0x0回避）
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      `--window-size=${VIEWPORT_W},${VIEWPORT_H}`
    ],
  });

  const page = await browser.newPage();
  // 念のため明示設定
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });

  try {
    // 入口を段階的に踏む
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await savePage(page, "home_1");

    await page.goto(`${BASE_URL}/search/jkknet/`, { waitUntil: "domcontentloaded" });
    await savePage(page, "home_1_after");

    await page.goto(`${BASE_URL}/search/jkknet/service/`, { waitUntil: "domcontentloaded" });
    await savePage(page, "home_2");

    // popup 捕捉
    const popup = await waitForPopupFrom(page);
    await savePage(popup, "home_2_after");

    // 初期表示保存
    await savePage(popup, "frameset_startinit");
    logFrames(popup);

    const isOwabi = await popup.evaluate(
      () => /おわび/.test(document.title || "") || (document.body && document.body.innerText.includes("おわび"))
    );
    if (isOwabi) {
      await savePage(popup, "final_error");
      throw new Error("「おわび」ページに遷移しました。入口フロー/Refererを再確認してください。");
    }

    let typed = false;
    try {
      await savePage(popup, "before_fill");
      await typeByNearbyLabelAcrossFrames(popup, "住宅名(カナ)", KANA);
      typed = true;
    } catch {
      const moved =
        (await clickByTextAcrossFrames(popup, "条件検索")) ||
        (await clickByTextAcrossFrames(popup, "先着順")) ||
        (await clickByTextAcrossFrames(popup, "空家")) ||
        (await clickByTextAcrossFrames(popup, "検索"));
      if (moved) {
        await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await savePage(popup, "before_fill");
        await typeByNearbyLabelAcrossFrames(popup, "住宅名(カナ)", KANA);
        typed = true;
      }
    }

    if (!typed) {
      await savePage(popup, "final_error");
      throw new Error("住宅名(カナ) の入力欄が見つかりませんでした。");
    }

    const clicked = await clickByTextAcrossFrames(popup, "検索する");
    if (!clicked) {
      await savePage(popup, "final_error");
      throw new Error("「検索する」ボタンが見つかりませんでした。");
    }

    await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await savePage(popup, "result");

    console.log("[done] ✅ finished");
  } catch (e) {
    console.error(e);
    try { await savePage(page, "final_error"); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
