// monitor.mjs  — JKK 検索フォームで「住宅名(カナ) = コーシャハイム」を入れて検索する安全版

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, "out");
const HEADLESS = true;

// ★ ここを変えるだけで検索語を差し替えできます
const KANA_KEYWORD = "コーシャハイム";

// GitHub Actions の setup-chrome で入る実体
const EXEC_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH ||
  "google-chrome"; // ubuntu-latest では /usr/bin/google-chrome が解決されます

// 便利関数
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () =>
  new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

function ensureOut() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

async function savePage(page, label) {
  ensureOut();
  const base = `${label}_${ts()}`;
  await page.screenshot({ path: path.join(OUT_DIR, `${base}.png`), fullPage: true });
  const html = await page.content();
  fs.writeFileSync(path.join(OUT_DIR, `${base}.html`), html, "utf8");
  console.log(`[saved] ${label}`);
}

async function gotoSafe(page, url, waitUntil = "domcontentloaded", timeout = 30000) {
  console.log(`[goto] ${url}`);
  try {
    await page.goto(url, { waitUntil, timeout });
  } catch (e) {
    console.warn(`[warn] goto failed (${url}): ${e.message}`);
  }
  await sleep(800); // 軽く安定化
}

// 「おわび」ページを検出したらトップへ戻る（穏やか復旧）
async function recoverIfApology(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  const isApology =
    /おわび|ページが見つかりません|サーバーが大変混み合っております/i.test(bodyText);
  if (!isApology) return false;

  // 「トップページへ戻る」らしき要素を片っ端から押す
  const clicked = await page.evaluate(() => {
    const cands = Array.from(
      document.querySelectorAll('a, button, input[type="button"], input[type="submit"], area, [role="button"]')
    );
    for (const el of cands) {
      const t = ((el.innerText || "") + " " + (el.value || "") + " " + (el.alt || "")).trim();
      if (/トップページへ戻る|トップページ|戻る/i.test(t)) {
        el.click();
        return true;
      }
    }
    return false;
  });
  if (clicked) {
    await sleep(1500);
  }
  return true;
}

// 指定した語を本文に含むフレームを見つける
async function findFrameByText(page, regex) {
  // 自身も含めてチェック
  const check = async (frame) => {
    try {
      const ok = await frame.evaluate((reSource) => {
        const re = new RegExp(reSource, "i");
        return re.test(document.body.innerText || "");
      }, regex.source);
      return ok ? frame : null;
    } catch {
      return null;
    }
  };

  const selfHit = await check(page.mainFrame());
  if (selfHit) return selfHit;

  for (const f of page.mainFrame().childFrames()) {
    const hit = await check(f);
    if (hit) return hit;
  }
  // さらに深い階層も探索
  const q = [...page.frames()];
  for (const f of q) {
    const hit = await check(f);
    if (hit) return hit;
  }
  return null;
}

// 住宅名(カナ) を入力して「検索する」を押す（フレーム渡し）
async function fillKanaAndSearch(frame, keyword) {
  // 1) 入力欄を見つける（ラベルに「住宅名」や「カナ」を含む行にあるテキストボックス）
  const filled = await frame.evaluate((kw) => {
    // ラベルの文字に依存しすぎないように、近傍のテキストを総当たりで判定
    const textboxes = Array.from(
      document.querySelectorAll('input[type="text"], input[type="search"]')
    );

    const normalize = (s) => (s || "").replace(/\s+/g, "");
    const hasKanaLabelNear = (el) => {
      let node = el;
      // 祖先方向に最大 5 階層まで見て、近傍テキストを集約
      let collected = "";
      for (let i = 0; i < 5 && node; i++) {
        const prev = node.previousElementSibling;
        if (prev) collected += prev.textContent || "";
        node = node.parentElement;
      }
      const txt = normalize(collected + " " + (el.getAttribute("title") || ""));
      return /住宅名|カナ|（カナ）|\(カナ\)/.test(txt);
    };

    // ありがちな name 候補もついでに見る
    const nameHints = /kana|jutakumei|jyutakumei|jname|house.*kana|mansion.*kana/i;

    let target = null;
    for (const el of textboxes) {
      if (hasKanaLabelNear(el) || nameHints.test(el.name || "")) {
        target = el;
        break;
      }
    }
    if (!target && textboxes.length === 1) target = textboxes[0]; // 最後の保険

    if (!target) return { ok: false, reason: "input-not-found" };

    target.focus();
    target.value = kw;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }, keyword);

  if (!filled.ok) throw new Error("Kana textbox not found");

  // 2) 「検索する」らしきボタンを押す
  const clicked = await frame.evaluate(() => {
    const cands = Array.from(
      document.querySelectorAll('button, input, a, area, [role="button"]')
    );
    // 優先: 「検索する」, 予備: 「検索」
    const match = (el, re) => {
      const t = ((el.innerText || "") + " " + (el.value || "") + " " + (el.alt || "")).trim();
      return re.test(t);
    };

    let btn = cands.find((el) => match(el, /検索する/));
    if (!btn) btn = cands.find((el) => match(el, /検索(?!方)/)); // 「検索方法」を除外したい

    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw new Error("Search button not found");

  // 送信後の待機（ナビゲーションでも Ajax でもどちらでも少し待つ）
  await sleep(2500);
}

(async () => {
  ensureOut();

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: EXEC_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    protocolTimeout: 120000,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    // 入口まわり（おわびからの復帰も考慮）
    const homes = [
      "https://jhomes.to-kousya.or.jp/",
      "https://jhomes.to-kousya.or.jp/search/jkknet/",
      "https://jhomes.to-kousya.or.jp/search/jkknet/index.html",
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/",
    ];

    for (let i = 0; i < homes.length; i++) {
      await gotoSafe(page, homes[i]);
      await savePage(page, `home_${i + 1}`);
      await recoverIfApology(page);
      await savePage(page, `home_${i + 1}_after`);
    }

    // 直接 StartInit へ
    console.log("[frameset] direct goto StartInit with referer=/service/");
    await gotoSafe(
      page,
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
      "domcontentloaded",
      45000
    );
    await savePage(page, "frameset_startinit");

    // 検索フォームが出るフレームを特定（ページ内文言で探索）
    // 候補: 「先着順あき家検索」「検索する」「住宅名」など
    const targetFrame =
      (await findFrameByText(page, /先着順.*あき家検索/)) ||
      (await findFrameByText(page, /住宅名|検索する/));

    if (!targetFrame) {
      // メインフレームにチャットが重なってるケースもあるので、ひと呼吸
      await savePage(page, "after_relay_1");
      throw new Error("Search form frame not found");
    }

    // 入力 → 検索
    await fillKanaAndSearch(targetFrame, KANA_KEYWORD);
    await savePage(page, "after_submit_main");

    // 最終スナップ
    await savePage(page, "final");
  } catch (err) {
    console.error(err);
    await savePage(page, "final_error");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
