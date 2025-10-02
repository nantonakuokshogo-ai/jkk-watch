// monitor.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========= 可変設定 =========
const START_URL = "https://www.to-kousya.or.jp/chintai/index.html";
const OUT = (name) => path.join(__dirname, `${name}`);

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const VIEWPORT = { width: 1200, height: 2200, deviceScaleFactor: 1 };
// ===========================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function save(page, base) {
  try {
    await fs.writeFile(OUT(`${base}.html`), await page.content(), "utf8");
  } catch {}
  try {
    await page.screenshot({ path: OUT(`${base}.png`), fullPage: true });
  } catch (e) {
    console.warn(`[warn] screenshot failed: ${e?.message}`);
  }
  console.log(`[saved] ${base}`);
}

function chromePathFromEnv() {
  return (
    process.env.CHROME_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome"
  );
}

async function main() {
  const executablePath = chromePathFromEnv();
  console.log(`[monitor] Using Chrome at: ${executablePath}`);

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath,
    args: [
      "--lang=ja-JP",
      "--window-size=1200,2200",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-popup-blocking",
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ]
  });

  const context = await browser.createIncognitoBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.setUserAgent(UA);
  await page.setViewport(VIEWPORT);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "ja-JP,ja;q=0.9",
    // 念のため Referer を固定（クリック時は自動で付与されますが保険）
    Referer: START_URL
  });

  try {
    // 1) 公式の賃貸トップへ
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    await save(page, "entry_referer");

    // 2) 「お部屋を検索」をクリック → JKKnet の新規タブを取得
    const SELECTOR_PC =
      'a.el_headerBtnGreen[href*="akiyaJyoukenStartInit"]';
    const SELECTOR_SP =
      'a.el_headerBtnGreen[href*="akiyaJyoukenInitMobile"]';
    const SELECTOR_TOPBTN =
      'a.bl_topSelect_btn.bl_topSelect_btn__cond';

    await page.waitForSelector(
      `${SELECTOR_PC},${SELECTOR_SP},${SELECTOR_TOPBTN}`
    );

    // 新しいターゲットを待つ（URL で jhomes を判定）
    const popupPromise = new Promise(async (resolve) => {
      const handler = async (target) => {
        try {
          const url = target.url();
          if (/jhomes\.to-kousya\.or\.jp/i.test(url)) {
            const p = await target.page();
            if (p) {
              browser.off("targetcreated", handler);
              resolve(p);
            }
          }
        } catch {}
      };
      browser.on("targetcreated", handler);
    });

    // クリック（PC/SP/トップのどれでも）
    await page.evaluate(
      (pc, sp, tb) => {
        const a = document.querySelector(pc) ||
                  document.querySelector(sp) ||
                  document.querySelector(tb);
        if (!a) throw new Error("search button not found");
        a.click(); // target="JKKnet" で別タブオープン
      },
      SELECTOR_PC,
      SELECTOR_SP,
      SELECTOR_TOPBTN
    );

    // 3) 新規タブを取得
    const netPage = await Promise.race([
      popupPromise,
      // 念のため URL 監視でも拾う
      browser
        .waitForTarget((t) => /jhomes\.to-kousya\.or\.jp/i.test(t.url()), {
          timeout: 15000
        })
        .then((t) => t.page())
    ]);

    if (!netPage) throw new Error("JKKnet タブを取得できませんでした");

    await netPage.bringToFront();
    await netPage.setViewport(VIEWPORT);
    await netPage.setUserAgent(UA);
    await netPage.setExtraHTTPHeaders({
      "Accept-Language": "ja-JP,ja;q=0.9",
      Referer: START_URL
    });

    // 4) 初回読み込みが終わるまで待機（wait.jsp → frameset → 本体 の揺れを吸収）
    //    ・ナビゲーションが続く間は都度待ち直し
    //    ・最長 25 秒ほど粘る
    const start = Date.now();
    let lastURL = "";
    for (;;) {
      // ナビゲーション/リダイレクトが落ち着くのを待つ
      await Promise.race([
        netPage.waitForNavigation({ waitUntil: "networkidle2", timeout: 12000 }).catch(() => {}),
        sleep(1500)
      ]);

      const url = netPage.url();
      if (url !== lastURL) {
        lastURL = url;
        // スナップショット（遷移の痕跡を残す）
        await save(netPage, "after_wait");
      }

      // 典型的な到達候補：
      //  - /wait.jsp            : 待機/タイムアウト画面（クジラ）
      //  - /frameset_...        : フレームセット
      //  - /akiyaJyouken...     : 検索フォーム or 結果
      if (/jkknet\/service\/.+(Init|StartInit)/i.test(url) ||
          /jkknet\/result/i.test(url) ||
          /frameset/i.test(url)) {
        break; // 充分に遷移できたので抜ける
      }

      if (Date.now() - start > 25000) break; // 粘りすぎ防止
    }

    // 5) 何が表示されていても、とにかく保存
    await save(netPage, "result_or_form");

    // 6) ここから先：フォーム内の「検索する」を押したい場合の雛形（今は無効化）
    // try {
    //   const frame = netPage
    //     .frames()
    //     .find(f => /akiya|jyouken|result/i.test(f.url()));
    //   if (frame) {
    //     const btnSel = "input[type=submit], button[type=submit]";
    //     if (await frame.$(btnSel)) {
    //       await frame.click(btnSel);
    //       await netPage.waitForNavigation({ waitUntil: "networkidle2" });
    //       await save(netPage, "after_click_search");
    //     }
    //   }
    // } catch (e) {
    //   console.warn("[warn] search click skipped:", e.message);
    // }

    await browser.close();
  } catch (err) {
    console.error(err);
    try {
      await save(page, "final_error");
    } catch {}
    process.exitCode = 1;
  }
}

main();
