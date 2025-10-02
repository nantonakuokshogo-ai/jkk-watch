// monitor.mjs
import fs from "fs/promises";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH || "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome";
const ENTRY = "https://www.to-kousya.or.jp/chintai/index.html";

async function savePage(page, name) {
  try {
    const html = await page.content();
    await fs.writeFile(`${name}.html`, html);
    await page.screenshot({ path: `${name}.png`, fullPage: true });
    console.log(`[saved] ${name}`);
  } catch (e) {
    console.warn(`[warn] savePage failed: ${e.message}`);
  }
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=site-per-process,IsolateOrigins,BlockInsecurePrivateNetworkRequests",
    ],
  });

  const page = await browser.newPage();
  // PCレイアウトを確実に出す。SPでも動くように後で分岐するのでOK
  await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
  page.setDefaultTimeout(25000);

  try {
    // 1) 参照元となるJKK賃貸トップへ
    await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a[href*='akiyaJyouken'], a[href*='jkknet/service/']", { timeout: 15000 });
    await savePage(page, "entry_referer");

    // 2) 画面に出ている方の検索リンクの href を取得（PC/SPどちらでもOK）
    const targetHref = await page.evaluate(() => {
      // 見えている a を優先（getBoundingClientRect で幅/高さをチェック）
      const candidates = Array.from(document.querySelectorAll(
        "a[href*='akiyaJyoukenStartInit'], a[href*='akiyaJyoukenInitMobile'], a[href*='jkknet/service/akiyaJyouken']"
      ));

      function isVisible(el) {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }

      const visible = candidates.find(isVisible) || candidates[0];
      return visible ? visible.href : null;
    });

    if (!targetHref) {
      throw new Error("検索リンクの href を取得できませんでした。");
    }

    // 3) クリックせずに直接遷移（Referer を明示）
    try {
      await page.goto(targetHref, {
        waitUntil: "domcontentloaded",
        referer: ENTRY,
        timeout: 25000,
      });
    } catch (e) {
      // まれにリダイレクト等で失敗する場合の再試行
      console.warn(`[warn] first goto failed: ${e.message}`);
      await page.waitForTimeout(1500);
      await page.goto(targetHref, {
        waitUntil: "domcontentloaded",
        referer: ENTRY,
        timeout: 25000,
      });
    }
    await savePage(page, "after_click_raw");

    // 4) 結果 or フォーム初期画面を保存（どちらでもOKという要件）
    //    何かしらフォーム/表が出るまで軽く待つ
    await page.waitForTimeout(1000);
    await savePage(page, "result_or_form");

  } catch (err) {
    console.error(err);
    await savePage(page, "final_error");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
