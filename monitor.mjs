import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome";

const OUT = path.resolve("./out");
const ENTRY = "https://www.to-kousya.or.jp/chintai/index.html";

await fs.mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function savePage(page, name) {
  try {
    const html = await page.content();
    await fs.writeFile(path.join(OUT, `${name}.html`), html, "utf8");
    try {
      await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    } catch (e) {
      // 0 width 対策
      await page.setViewport({ width: 1280, height: 2200, deviceScaleFactor: 1 });
      await sleep(300);
      await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    }
    console.log(`[saved] ${name}`);
  } catch (e) {
    console.warn(`[warn] savePage ${name}: ${e.message}`);
  }
}

async function main() {
  console.log("[monitor] Using Chrome at:", CHROME);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true, // 互換性重視（"new" は使わない）
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-features=BlockInsecurePrivateNetworkRequests",
      "--window-size=1280,2200",
    ],
    defaultViewport: { width: 1280, height: 2200, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  try {
    // 1) 賃貸トップ（Referer になる）
    await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a[href*='akiyaJyouken'], a[href*='jkknet/service/']", { timeout: 20000 });
    await savePage(page, "entry_referer");

    // 2) 画面に表示されている方のリンクの href を拾う（PC/SP両対応）
    const targetHref = await page.evaluate(() => {
      const qs =
        "a[href*='akiyaJyoukenStartInit'], a[href*='akiyaJyoukenInitMobile'], a[href*='jkknet/service/akiyaJyouken']";
      const links = Array.from(document.querySelectorAll(qs));
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const vis = links.find(isVisible) || links[0];
      return vis ? vis.href : null;
    });

    if (!targetHref) throw new Error("検索リンクの href を取得できませんでした。");

    // 3) クリックせずに直接遷移（Referer 明示）
    try {
      await page.goto(targetHref, { waitUntil: "domcontentloaded", referer: ENTRY, timeout: 30000 });
    } catch (e) {
      console.warn("[warn] first goto failed, retrying:", e.message);
      await sleep(1200);
      await page.goto(targetHref, { waitUntil: "domcontentloaded", referer: ENTRY, timeout: 30000 });
    }
    await savePage(page, "after_click_raw");

    // 4) 可能なら “検索” を押す（入力はしない）。失敗しても無視。
    let clicked = false;
    for (const fr of page.frames()) {
      try {
        const ok = await fr.evaluate(() => {
          const isVisible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
          };
          const pool = [
            ...document.querySelectorAll('input[type="submit"], input[type="image"], button, a'),
          ];
          for (const el of pool) {
            const text = (el.value || el.textContent || el.alt || "").trim();
            if (/検索/.test(text) && isVisible(el)) {
              el.click();
              return true;
            }
          }
          return false;
        });
        if (ok) { clicked = true; break; }
      } catch {}
    }
    if (clicked) await sleep(2000);

    // 5) 結果 or そのままフォームのスクショ
    await savePage(page, "result_or_form");

  } catch (e) {
    console.error(e);
    await savePage(page, "final_error");
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
