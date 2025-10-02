import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome";

const OUT = path.resolve("./out");
await fs.mkdir(OUT, { recursive: true });

function log(...a) { console.log(...a); }

async function savePage(page, name) {
  const html = await page.content();
  await fs.writeFile(path.join(OUT, `${name}.html`), html, "utf8");
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  } catch (e) {
    // 稀に 0 width エラーになる場合のリトライ
    log(`[warn] screenshot retry for ${name}:`, String(e.message || e));
    await page.setViewport({ width: 1280, height: 2400, deviceScaleFactor: 1 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  }
  log(`[saved] ${name}`);
}

async function waitPageByTarget(browser, predicate, timeout = 25000) {
  const target = await browser.waitForTarget(t => {
    try { return predicate(t); } catch { return false; }
  }, { timeout });
  return await target.page();
}

async function main() {
  log("[monitor] Using Chrome at:", CHROME);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1280,2400",
      // 余計なブロックを避ける
      "--disable-features=BlockInsecurePrivateNetworkRequests"
    ],
    defaultViewport: { width: 1280, height: 2400, deviceScaleFactor: 1 }
  });

  try {
    const page = await browser.newPage();

    // HeadlessChrome バレ低減（UAだけで十分）
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "accept-language": "ja,en;q=0.8"
    });

    // 1) 公式賃貸トップへ
    const ENTRY = "https://www.to-kousya.or.jp/chintai/index.html";
    await page.goto(ENTRY, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("body", { timeout: 30000 });
    await savePage(page, "entry_referer");

    // 2) 「こだわり条件からさがす」をクリックして JKKnet を別タブで開く
    // PC/スマホの両方を許容（どちらかがあればOK）
    const selectorPc = 'a[href*="akiyaJyoukenStartInit"]';
    const selectorSp = 'a[href*="akiyaJyoukenInitMobile"]';

    const hasPc = await page.$(selectorPc);
    const hasSp = await page.$(selectorSp);

    const popupPromise = new Promise(resolve => {
      page.once("popup", resolve); // Puppeteer 純正
    });

    if (hasPc) {
      await page.click(selectorPc, { delay: 50 });
    } else if (hasSp) {
      await page.click(selectorSp, { delay: 50 });
    } else {
      throw new Error("賃貸トップに検索リンクが見つかりませんでした");
    }

    // 3) 新規タブ（JKKnet）を取得
    /** @type {import('puppeteer-core').Page} */
    let jkkPage;
    try {
      jkkPage = await Promise.race([
        popupPromise,
        waitPageByTarget(
          browser,
          t => t.type() === "page" && /jhomes\.to-kousya\.or\.jp/.test(t.url())
        )
      ]);
    } catch {
      // まれに popup イベントが来ないことがあるので保険
      jkkPage = await waitPageByTarget(
        browser,
        t => t.type() === "page" && /jhomes\.to-kousya\.or\.jp/.test(t.url())
      );
    }
    if (!jkkPage) throw new Error("JKKnet のタブを取得できませんでした");

    await jkkPage.bringToFront();
    await jkkPage.waitForTimeout(800); // フレーム構築待ち
    await savePage(jkkPage, "frameset_startinit");

    // 4) まずはフォーム初期画面 or ウェイト画面を撮る
    // （frameset の場合もあるのでトップを保存済み）
    // その後、可能なら「検索する」相当を押す（入力は無視）
    let clicked = false;
    for (const fr of jkkPage.frames()) {
      try {
        // ボタンの候補を片っ端から探す
        const btn =
          (await fr.$('input[type="submit"][value*="検索"]')) ||
          (await fr.$('input[type="image"][alt*="検索"]')) ||
          (await fr.$('button:has-text("検索")')) ||
          (await fr.$('input[name="search"]'));
        if (btn) {
          await btn.click({ delay: 50 });
          clicked = true;
          break;
        }
      } catch {}
    }

    // 5) 結果 or そのままフォームを保存
    if (clicked) {
      // 同一タブ遷移 or 別タブポップアップの両方に対応
      let resultPage = jkkPage;
      try {
        const maybeNew = await waitPageByTarget(
          browser,
          t =>
            t.type() === "page" &&
            /jhomes\.to-kousya\.or\.jp/.test(t.url()) &&
            t.url() !== jkkPage.url(),
          8000
        );
        if (maybeNew) resultPage = await maybeNew;
      } catch {}
      await resultPage.bringToFront();
      await resultPage.waitForTimeout(1000);
      await savePage(resultPage, "result_or_form");
    } else {
      // クリックできなければ現状のフォームを再保存
      await savePage(jkkPage, "result_or_form");
    }

  } finally {
    // ブラウザは必ず閉じる
    await new Promise(r => setTimeout(r, 250));
    await (await puppeteer.connect) // ダミー対策
    ; // no-op
  }
}

main().catch(async (e) => {
  console.error(e);
  // 失敗時の最終画面を残す
  try {
    const errHtml = `<pre>${String(e.stack || e.message || e)}</pre>`;
    await fs.writeFile(path.join(OUT, "final_error.html"), errHtml, "utf8");
  } catch {}
  process.exit(1);
});
