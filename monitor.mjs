// monitor.mjs  — JKK 検索一覧まで安定して到達するための「同タブ強制」版
// 実行:  node monitor.mjs
// 生成物: out/ 配下に HTML と PNG を保存

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, "out");

// --- small utils -------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ensureOut() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}
async function save(page, base) {
  const html = await page.content();
  await fs.writeFile(path.join(OUT_DIR, `${base}.html`), html);
  await page.screenshot({ path: path.join(OUT_DIR, `${base}.png`), fullPage: true });
  console.log(`[saved] ${base}`);
}
function chromePathFromEnv() {
  // setup-chrome が設定する環境変数を優先
  return (
    process.env.CHROME_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    // GH Actions setup-chrome の既定パス（Linux）
    "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome"
  );
}

// --- core --------------------------------------------------------------------
async function main() {
  await ensureOut();

  const executablePath = chromePathFromEnv();
  console.log("[monitor] Using Chrome at:", executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    defaultViewport: { width: 1366, height: 2000 },
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1366,2000",
      // ナビ・Cookie 周りでこけないよう緩めに
      "--disable-features=IsolateOrigins,site-per-process,SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure",
    ],
  });

  const page = await browser.newPage();

  // ---- ここが本筋：ポップアップを同タブに矯正、target=JKKnet を自タブに解決、元タブ閉鎖を無効化
  await page.addInitScript(() => {
    try { window.name = "JKKnet"; } catch {}
    const origOpen = window.open;
    // window.open(url, ...) を「同タブ遷移」に強制
    window.open = function(url) {
      if (url) location.href = url;
      return window;
    };
    // 元タブ閉鎖も無効化
    window.close = function() {};
  });

  // 念のためポップアップイベントは即座に閉じる（来ない想定だが保険）
  page.on("popup", async (p) => { try { await p.close({ runBeforeUnload: false }); } catch {} });

  // 404 やブロックでも証跡が取れるようにダイアログ/エラーを握りつぶして続行
  page.on("dialog", async (d) => { try { await d.dismiss(); } catch {} });
  page.on("pageerror", (e) => console.warn("[pageerror]", e?.message || e));
  page.on("requestfailed", (req) => {
    // 参考ログ（AdBlock 風のエラーは ERR_BLOCKED_BY_CLIENT になりがち）
    const f = req.failure(); 
    if (f && /blocked_by_client/i.test(f.errorText || "")) {
      console.warn("[warn] request blocked:", req.url());
    }
  });

  try {
    // 1) トップでリファラを作る（対策が厳しいサイトほどリファラ有りの方が通る）
    await page.goto("https://www.jkktokyo.or.jp/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(1000);
    await save(page, "entry_referer");

    // 2) 中継 wait.jsp へ。onload で window.open + POST だが、同タブへ矯正済み。
    //    その後 /service/* へ POST され、フレーム or 404 へ遷移する。
    await page.goto("https://jhomes.to-kousya.or.jp/search/jkknet/wait.jsp", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // onload スクリプト→POST→遷移まで待つ（ネットワークの揺らぎを考慮してゆっくり）
    await sleep(4000);
    // 遷移先を待つ。フレームページでも load は来るので合わせて待機
    try {
      await page.waitForLoadState?.("load"); // Playwright 互換 API があれば
    } catch {}
    await page.waitForNavigation({ waitUntil: "load", timeout: 10_000 }).catch(() => {});

    // 3) ここで到達先は 404 か検索フォームのどちらか。
    //    ひとまずスナップショットを残す。
    await save(page, "after_wait");

    // 4) 到達先が検索フォーム/フレームかどうかを軽く判定して、もう一枚撮る
    const kind = await page.evaluate(() => {
      // フレームセット or 検索フォームの「検索する」ボタン存在チェックなど軽めに
      if (document.querySelector("frame, frameset")) return "frames";
      if ([...document.querySelectorAll("input,button")].some(b => /検索/.test(b.value || b.textContent || ""))) return "form";
      if (document.title && /見つかりません|not found|404/i.test(document.title)) return "404";
      return "other";
    });
    await save(page, `result_or_form_${kind}`);

    // 5) （将来の拡張）ここから検索ボタン押下や結果一覧スクショ取得ロジックを追加していく想定。
    //    まずは “確実に辿り着く” ことを最優先にここで終了。
  } catch (err) {
    console.error(err);
    try { await save(page, "final_error"); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
});
