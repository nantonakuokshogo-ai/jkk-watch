import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("TITLE:", await page.title().catch(()=>"(no title)"));
  await page.screenshot({ path: "out.png", fullPage: true }).catch(()=>{});
  await browser.close();
})();
