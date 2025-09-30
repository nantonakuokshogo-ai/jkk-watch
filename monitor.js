import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto("https://example.com");
  const title = await page.title();

  console.log("Page title is:", title);

  await browser.close();
})();
