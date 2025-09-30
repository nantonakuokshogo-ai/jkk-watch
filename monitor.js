import { chromium } from "playwright";

const TEST_URLS = [
  "https://example.com/",
  "https://httpbin.org/html",
  "https://www.wikipedia.org/"
];

async function gotoWithRetry(page, url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`try ${i}: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return true;
    } catch (e) {
      console.log(`failed ${i}:`, e.message);
      if (i === tries) return false;
      await page.waitForTimeout(1500);
    }
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
  });

  let ok = false;
  for (const url of TEST_URLS) {
    ok = await gotoWithRetry(page, url);
    if (ok) {
      const title = await page.title().catch(() => "");
      console.log("OK:", url, "| title:", title);
      break;
    }
  }

  await page.screenshot({ path: "out.png", fullPage: true }).catch(()=>{});
  await browser.close();

  if (!ok) process.exit(1); // 失敗扱い
})();
