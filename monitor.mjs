// monitor.mjs  --- full paste OK ---
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========= 共通ユーティリティ =========
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function save(page, name) {
  const png = path.join(OUT, `${name}.png`);
  const html = path.join(OUT, `${name}.html`);
  try {
    await page.screenshot({ path: png, fullPage: true });
  } catch {}
  try {
    const c = await page.content();
    fs.writeFileSync(html, c);
  } catch {}
  log("[saved]", name);
}

// ========= Chrome 実行ファイルの解決（A案のキモ） =========
function which(cmd) {
  try {
    const r = spawnSync("which", [cmd], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function resolveChromePath() {
  const envs = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,            // ← setup-chrome がここに入る
    process.env.GOOGLE_CHROME_BIN,
    process.env.CHROMIUM_PATH,
  ].filter(Boolean);

  for (const p of envs) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
    const w = which(p);
    if (w) return w;
  }

  const candidates = [
    "google-chrome",
    "google-chrome-stable",
    "chromium-browser",
    "chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  for (const c of candidates) {
    const w = which(c);
    if (w) return w;
  }
  return null;
}

const EXEC_PATH = resolveChromePath();
if (!EXEC_PATH) {
  console.error(
    "Chrome/Chromium が見つかりません。workflow に setup-chrome を入れるか、CHROME_PATH を設定してください。"
  );
  process.exit(1);
}
log("[chrome]", EXEC_PATH);

// ========= ページ操作ヘルパ =========
async function goto(page, url, tag, wait = "domcontentloaded") {
  log("[goto]", url);
  await page.goto(url, { waitUntil: wait, timeout: 120000 });
  await save(page, tag);
}

async function clickByText(page, text, tagAfter, { timeout = 12000 } = {}) {
  const found = await page.evaluateHandle((t) => {
    const xp = `.//*[normalize-space(text())='${t}']`;
    const it = document.evaluate(
      xp,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return it.singleNodeValue;
  }, text);
  if (!found) return false;

  try {
    const box = await found.boundingBox?.();
    if (!box) {
      await page.evaluate((el) => el.click(), found);
    } else {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout });
    if (tagAfter) await save(page, tagAfter);
    return true;
  } catch {
    return false;
  }
}

async function typeKanaIfExists(page, kana = "コーシャハイム") {
  // 「住宅名(カナ)」に相当する入力をゆるく探索して入力
  const ok = await page.evaluate((val) => {
    function nearInputByText(sub) {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT
      );
      const hits = [];
      while (walker.nextNode()) {
        const el = walker.currentNode;
        const tx = el.textContent?.replace(/\s+/g, "");
        if (!tx) continue;
        if (tx.includes(sub)) hits.push(el);
      }
      for (const labelLike of hits) {
        // 直後 or 祖先内の input を探す
        const nextInput =
          labelLike.querySelector?.("input[type='text']") ||
          labelLike.parentElement?.querySelector?.("input[type='text']");
        if (nextInput) return nextInput;
        // 次兄弟
        let sib = labelLike.nextElementSibling;
        for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
          const inp = sib.querySelector?.("input[type='text']") || (sib.tagName === "INPUT" ? sib : null);
          if (inp) return inp;
        }
      }
      return null;
    }

    // 候補語
    const cand = ["住宅名(カナ)", "住宅名（カナ）", "住宅名ｶﾅ", "カナ", "ｶﾅ"];
    let input = null;
    for (const c of cand) {
      input = nearInputByText(c);
      if (input) break;
    }
    if (!input) {
      // name/id/placeholder に kana っぽい物があれば使う
      const all = [...document.querySelectorAll("input[type='text']")];
      input = all.find((i) =>
        /(kana|ｶﾅ)/i.test(i.name || "") ||
        /(kana|ｶﾅ)/i.test(i.id || "") ||
        /(ｶﾅ|カナ)/.test(i.placeholder || "")
      ) || null;
    }
    if (!input) return false;
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = val;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, kana);

  return ok;
}

async function clickSearchIfExists(page) {
  const clicked = await page.evaluate(() => {
    // 「検索する」ボタン（input[type=submit], button）の文字で探す
    const labels = ["検索する", "検索", "検索開始"];
    const btns = [
      ...document.querySelectorAll("input[type='submit'],button")
    ];
    const hit = btns.find((b) => labels.includes(b.value) || labels.includes(b.textContent?.trim()));
    if (!hit) return false;
    hit.click();
    return true;
  });
  if (!clicked) return false;
  try {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 });
  } catch {}
  return true;
}

// ========= メイン =========
async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: EXEC_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    protocolTimeout: 120000
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(45000);

  try {
    // 1) HOME から順に救済しながら進む
    await goto(page, "https://jhomes.to-kousya.or.jp/", "home_1");
    await save(page, "home_1_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/", "home_2");
    await save(page, "home_2_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/index.html", "home_3");
    await save(page, "home_3_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/service/", "home_4");
    await save(page, "home_4_after");

    // frameset 直リンク
    log("[frameset] direct goto StartInit with referer=/service/");
    await goto(
      page,
      "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit",
      "frameset_startinit"
    );

    // 「こちら」救済（自動遷移しない時のリンク）
    for (let i = 1; i <= 5; i++) {
      const ok = await clickByText(page, "こちら", `after_relay_${i}`, { timeout: 15000 });
      if (!ok) break;
      await sleep(600);
    }

    // 検索フォーム到達想定：カナ入力トライ
    const kanaTyped = await typeKanaIfExists(page, "コーシャハイム");
    if (kanaTyped) await save(page, "kana_filled");

    const searched = await clickSearchIfExists(page);
    if (searched) await save(page, "after_submit_main");

    await save(page, "final");
  } catch (e) {
    console.error(e);
    await save(page, "final_error");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
