// monitor.mjs
// Puppeteer v22+ 対応（waitForTimeout/$x 等は使わない）

import puppeteer from "puppeteer-core";
import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "https://jhomes.to-kousya.or.jp";
const KANA = process.env.KANA ?? "コーシャハイム"; // ← 指定が無ければコーシャハイム
const OUTDIR = "out";

const VIEWPORT = {
  width: Number(process.env.WIDTH || 1440),
  height: Number(process.env.HEIGHT || 2200),
  deviceScaleFactor: 1
};

const exe = process.env.PUPPETEER_EXECUTABLE_PATH || "google-chrome";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureOut() {
  await fs.mkdir(OUTDIR, { recursive: true });
}

async function save(page, name) {
  try {
    await fs.mkdir(OUTDIR, { recursive: true });
    const html = await page.content();
    await fs.writeFile(path.join(OUTDIR, `${name}.html`), html, "utf8");
    await page.screenshot({
      path: path.join(OUTDIR, `${name}.png`),
      fullPage: true
    });
    console.log(`[saved] ${name}`);
  } catch (e) {
    console.warn(`[warn] screenshot failed for ${name}: ${e.message}`);
    try {
      const html = await page.content();
      await fs.writeFile(path.join(OUTDIR, `${name}.html`), html, "utf8");
      console.log(`[saved] ${name} (html only)`);
    } catch {}
  }
}

/** referer を付けて移動（古いサイト対策） */
async function goto(page, url, referer = undefined) {
  console.log(`[goto] ${url}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    referer
  });
}

/** 画面のどこかにテキストを含む要素が現れるのを待つ */
async function waitText(pageOrFrame, text, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const has = await pageOrFrame.evaluate((t) => {
      return !!Array.from(document.querySelectorAll("body,body *"))
        .slice(0, 2000)
        .find((n) => (n.textContent || "").replace(/\s+/g, "").includes(t));
    }, text.replace(/\s+/g, ""));
    if (has) return;
    await delay(200);
  }
  throw new Error(`テキストが見つかりませんでした: ${text}`);
}

/** フレーム一覧をダンプ（デバッグ用） */
async function dumpFrames(page, tag) {
  const frames = page.frames();
  console.log(`[frames] ${tag} count=${frames.length}`);
  frames.forEach((f, i) => {
    const url = f.url();
    console.log(
      `[frame#${i}] url=${url} name=${f.name() || ""}`
    );
  });
}

/** 指定テキストの近くの input[type=text] を探して値を入れる */
async function typeByNearbyLabel(frame, labelText, value) {
  const ok = await frame.evaluate(
    (t, v) => {
      const norm = (s) => (s || "").replace(/\s+/g, "");
      // 候補：th/td/label/span などに「住宅名(カナ)」が書かれている前提
      const labels = Array.from(
        document.querySelectorAll("th,td,label,span,div")
      );
      for (const lab of labels) {
        if (!norm(lab.textContent).includes(norm(t))) continue;
        // ラベル周囲から input を探す
        let container =
          lab.closest("tr") ||
          lab.closest("td") ||
          lab.closest("div") ||
          lab.parentElement ||
          document;
        const input =
          container.querySelector('input[type="text"]') ||
          container.querySelector("input:not([type])") ||
          container.querySelector("textarea");
        if (input) {
          input.focus();
          input.value = v;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      // 最後の手段：フォーム全体から最初のテキストボックス
      const any =
        document.querySelector('input[type="text"]') ||
        document.querySelector("input:not([type])");
      if (any) {
        any.focus();
        any.value = v;
        any.dispatchEvent(new Event("input", { bubbles: true }));
        any.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    },
    labelText,
    value
  );
  if (!ok) {
    throw new Error(`${labelText} の入力欄が見つかりませんでした。`);
  }
}

/** 「検索する」ボタンをクリック */
async function clickSearch(frame) {
  const clicked = await frame.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, "");
    const isSearchBtn = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === "button") {
        return norm(el.textContent).includes("検索する");
      }
      if (tag === "input") {
        const v = (el.value || "").trim();
        return (
          ["button", "submit", "image"].includes(
            (el.getAttribute("type") || "").toLowerCase()
          ) && (v === "検索する" || v.includes("検索"))
        );
      }
      return false;
    };
    const all = Array.from(document.querySelectorAll("button,input"));
    const target = all.find(isSearchBtn);
    if (target) {
      target.click();
      return true;
    }
    return false;
  });
  if (!clicked) {
    throw new Error("「検索する」ボタンが見つかりませんでした。");
  }
}

async function main() {
  await ensureOut();

  const launchArgs = {
    executablePath: exe,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`
    ],
    defaultViewport: VIEWPORT
  };

  const browser = await puppeteer.launch(launchArgs);
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  try {
    console.log(`[monitor] Using Chrome at: ${launchArgs.executablePath}`);

    // 1) トップ
    await goto(page, `${BASE_URL}/`);
    await save(page, "home_1");

    // 2) 検索導線（段階的に遷移させると Referer が付く）
    await goto(page, `${BASE_URL}/search/jkknet/`, `${BASE_URL}/`);
    await save(page, "home_1_after");

    await goto(
      page,
      `${BASE_URL}/search/jkknet/index.html`,
      `${BASE_URL}/search/jkknet/`
    );
    await save(page, "home_2");

    await goto(
      page,
      `${BASE_URL}/search/jkknet/service/`,
      `${BASE_URL}/search/jkknet/index.html`
    );
    await save(page, "home_2_after");

    // 3) StartInit → 自動遷移 (wait.jsp を経由)
    await goto(
      page,
      `${BASE_URL}/search/jkknet/service/akiyaJyoukenStartInit`,
      `${BASE_URL}/search/jkknet/service/`
    );
    await save(page, "frameset_startinit");

    // 自動遷移を少し待つ
    await delay(1500);

    // 4) フレームを特定
    await dumpFrames(page, "before");
    const frames = page.frames();

    // 入力フォームを含むフレームを探す：ページ内に「先着順あき家検索」 or 「検索する」など
    let formFrame = null;
    for (const f of frames) {
      try {
        const hasSearchButton = await f.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button,input")).find(
            (el) =>
              (el.tagName === "BUTTON" &&
                (el.textContent || "").includes("検索する")) ||
              (el.tagName === "INPUT" &&
                (el.value || "").includes("検索する"))
          );
          return !!btn;
        }).catch(() => false);

        const hasTitle = await f
          .evaluate(() => {
            const t = document.title || "";
            return (
              t.includes("先着順") ||
              t.includes("検索") ||
              !!document.querySelector("form")
            );
          })
          .catch(() => false);

        if (hasSearchButton || hasTitle) {
          formFrame = f;
          break;
        }
      } catch {}
    }

    if (!formFrame) {
      // 予備：メインページでフォームがあるならそれを使う
      formFrame = page.mainFrame();
      console.log("[fallback] use main frame");
    }

    await save(page, "before_fill");

    // 5) 住宅名(カナ) 入力
    if ((KANA || "").trim()) {
      await typeByNearbyLabel(formFrame, "住宅名(カナ)", KANA);
      await save(page, "after_type_kana");
    }

    // 6) 検索ボタン押下
    await clickSearch(formFrame);

    // 7) 結果待ち → スクショ
    await delay(1800);
    await save(page, "after_submit_main");

    // 最後
    await save(page, "final");
  } catch (err) {
    console.error(err);
    await save(page, "final_error");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
