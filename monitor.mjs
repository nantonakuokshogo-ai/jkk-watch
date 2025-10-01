// monitor.mjs  —— GitHub Actions などにそのまま貼り付け

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_DIR = "out";
const BASE = "https://jhomes.to-kousya.or.jp";
const START = `${BASE}/`;
const SERVICE_HOME = `${BASE}/search/jkknet/`;
const START_INIT = `${BASE}/search/jkknet/service/akiyaJyoukenStartInit`;

const KANA_TEXT = process.env.JKK_KANA || "コーシャハイム";
const CHROME_PATH =
  process.env.CHROME_PATH ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/usr/bin/google-chrome";

async function ensureOut() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function save(page, name) {
  const html = await page.content();
  const png = `${name}.png`;
  const htmlPath = path.join(OUT_DIR, `${name}.html`);
  const pngPath = path.join(OUT_DIR, png);
  await fs.writeFile(htmlPath, html);
  await page.screenshot({ path: pngPath, fullPage: true });
  console.log(`[saved] ${name}`);
}

async function goto(page, url, { timeout = 45000, waitUntil = "domcontentloaded" } = {}) {
  console.log(`[goto] ${url}`);
  await page.goto(url, { waitUntil, timeout });
}

async function maybeRecoverApology(page) {
  // 「おわび」系に飛ばされたらトップへ戻る
  const txt = await page.evaluate(() => document.body?.innerText || "");
  if (txt.includes("おわび") || txt.includes("トップページへ戻る")) {
    console.log("[recover] apology -> back to top");
    await goto(page, START);
    return true;
  }
  return false;
}

/** 画面内のチャット/ヘルプのフローティングを隠す（邪魔なときがある） */
async function hideFloatingWidgets(page) {
  await page.evaluate(() => {
    const killers = [
      '[class*="chat"]',
      '[id*="chat"]',
      '[class*="MediaTalk"]',
      '[id*="MediaTalk"]',
    ];
    for (const sel of killers) {
      document.querySelectorAll(sel).forEach(n => (n.style.display = "none"));
    }
  });
}

/** 「住宅名(カナ)」の入力 → 「検索する」クリック */
async function fillKanaAndSearch(page, text) {
  await hideFloatingWidgets(page);

  // 入力欄を robust に探す：1) 「住宅名(カナ)」の直後の input、2) name/id に kana など、3) 最大幅の text input
  const ok = await page.evaluate((kana) => {
    function byXpath(xp, ctx = document) {
      const r = document.evaluate(
        xp,
        ctx,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return r.singleNodeValue;
    }

    function findKanaInput() {
      // 1) ラベル文字列から辿る
      const xp =
        "//*[contains(normalize-space(.),'住宅名') and contains(normalize-space(.),'カナ')]/following::input[1]";
      let el = byXpath(xp);
      if (el) return el;

      // 2) name/id で推測
      const guess = Array.from(
        document.querySelectorAll('input[type="text"], textarea')
      ).find((e) => {
        const n = (e.name || "").toLowerCase();
        const i = (e.id || "").toLowerCase();
        return /kana|yomi|name|jutaku|jyutaku/.test(n) || /kana|yomi|name/.test(i);
      });
      if (guess) return guess;

      // 3) 最も大きいテキスト入力
      const all = Array.from(document.querySelectorAll('input[type="text"], textarea'));
      all.sort(
        (a, b) =>
          b.getBoundingClientRect().width * b.getBoundingClientRect().height -
          a.getBoundingClientRect().width * a.getBoundingClientRect().height
      );
      return all[0] || null;
    }

    const input = findKanaInput();
    if (!input) return { filled: false, reason: "input-not-found" };

    // 値セット（input イベントも発火）
    input.focus();
    const proto = input.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, kana);
    input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));

    // ボタンを探してクリック
    function clickSearch() {
      const cands = [
        ...document.querySelectorAll("button, a, input[type='submit'], input[type='button'], input[type='image']"),
      ];
      let btn =
        cands.find((el) => /検索/.test(el.textContent || "")) ||
        cands.find((el) => /検索/.test(el.value || "")) ||
        cands.find((el) => /(kensaku|search)/i.test(el.name || ""));

      if (!btn) {
        const img = Array.from(document.images).find((i) => /検索/.test(i.alt || ""));
        if (img) {
          img.click();
          return true;
        }
      } else {
        btn.click();
        return true;
      }

      const form = input.form || document.querySelector("form");
      if (form) {
        form.submit();
        return true;
      }
      return false;
    }

    const clicked = clickSearch();
    return { filled: true, clicked };
  }, text);

  if (!ok.filled) throw new Error("Kana input field not found");
}

async function main() {
  await ensureOut();

  console.log(`[monitor] Using Chrome at: ${CHROME_PATH}`);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,2000",
    ],
    protocolTimeout: 120000,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 2000 });

  try {
    // 入口 → jkknet → service → StartInit を直叩き
    await goto(page, START);
    await save(page, "home_1");
    await maybeRecoverApology(page);

    await goto(page, SERVICE_HOME);
    await save(page, "home_2");
    await goto(page, `${SERVICE_HOME}index.html`);
    await save(page, "home_3");
    await goto(page, `${SERVICE_HOME}service/`);
    await save(page, "home_4");

    // リレー（ポップアップ挙動を回避して直接 StartInit）
    console.log("[frameset] direct goto StartInit with referer=/service/");
    await goto(page, START_INIT);
    await save(page, "frameset_startinit");

    // ここで検索条件ページに居る想定
    await save(page, "after_relay_1");

    // 「住宅名(カナ) = コーシャハイム」→ 検索実行
    await fillKanaAndSearch(page, KANA_TEXT);

    // 遷移待ち（検索結果）
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {}); // ページ内 submit でハード遷移しないケースにも対応

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
