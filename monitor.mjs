import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function save(page, name) {
  const png = path.join(OUT, `${name}.png`);
  const html = path.join(OUT, `${name}.html`);
  try { await page.screenshot({ path: png, fullPage: true }); } catch {}
  try { fs.writeFileSync(html, await page.content()); } catch {}
  log("[saved]", name);
}

/* ====== ★ ここが重要：ワークフローで解決した絶対パスを使う ====== */
const EXEC_PATH = process.env.CHROME_PATH || "";
if (!EXEC_PATH || !fs.existsSync(EXEC_PATH)) {
  console.error(`CHROME_PATH が無効です: "${EXEC_PATH}"`);
  process.exit(1);
}
log("[chrome]", EXEC_PATH);
/* ============================================================ */

async function goto(page, url, tag, wait = "domcontentloaded") {
  log("[goto]", url);
  await page.goto(url, { waitUntil: wait, timeout: 120000 });
  await save(page, tag);
}

async function clickByText(page, text, tagAfter, { timeout = 12000 } = {}) {
  const handle = await page.evaluateHandle((t) => {
    const xp = `.//*[normalize-space(text())='${t}']`;
    return document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  }, text);
  if (!handle) return false;
  try {
    await page.evaluate((el) => el.click(), handle);
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout });
    if (tagAfter) await save(page, tagAfter);
    return true;
  } catch { return false; }
}

async function typeKanaIfExists(page, kana = "コーシャハイム") {
  return await page.evaluate((val) => {
    function findInput() {
      const labels = ["住宅名(カナ)", "住宅名（カナ）", "住宅名ｶﾅ", "カナ", "ｶﾅ"];
      for (const l of labels) {
        const el = [...document.querySelectorAll("*")].find(n => n.textContent?.replace(/\s+/g,"").includes(l));
        if (el) {
          const inp = el.querySelector?.("input[type='text']") ||
            el.parentElement?.querySelector?.("input[type='text']") || null;
          if (inp) return inp;
        }
      }
      return ([...document.querySelectorAll("input[type='text']")].find(i =>
        /(kana|ｶﾅ)/i.test(i.name||"") || /(kana|ｶﾅ)/i.test(i.id||"") || /(ｶﾅ|カナ)/.test(i.placeholder||"")
      ) || null);
    }
    const input = findInput();
    if (!input) return false;
    input.focus(); input.value = ""; input.dispatchEvent(new Event("input",{bubbles:true}));
    input.value = val; input.dispatchEvent(new Event("input",{bubbles:true}));
    return true;
  }, kana);
}

async function clickSearchIfExists(page) {
  const clicked = await page.evaluate(() => {
    const labels = ["検索する","検索","検索開始"];
    const btns = [...document.querySelectorAll("input[type='submit'],button")];
    const hit = btns.find(b => labels.includes(b.value) || labels.includes(b.textContent?.trim()));
    if (!hit) return false; hit.click(); return true;
  });
  if (!clicked) return false;
  try { await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }); } catch {}
  return true;
}

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
    await goto(page, "https://jhomes.to-kousya.or.jp/", "home_1");
    await save(page, "home_1_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/", "home_2");
    await save(page, "home_2_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/index.html", "home_3");
    await save(page, "home_3_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/service/", "home_4");
    await save(page, "home_4_after");

    await goto(page, "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit", "frameset_startinit");

    // 自動遷移しない時の「こちら」救済
    for (let i = 1; i <= 5; i++) {
      const ok = await clickByText(page, "こちら", `after_relay_${i}`, { timeout: 15000 });
      if (!ok) break;
      await sleep(600);
    }

    // 「コーシャハイム」をカナ欄へ
    const kanaOK = await typeKanaIfExists(page, "コーシャハイム");
    if (kanaOK) await save(page, "kana_filled");

    // 「検索する」
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
