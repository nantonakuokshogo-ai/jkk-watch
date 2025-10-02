// monitor.mjs  — フル置換版
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(__dirname, "pages");

async function ensureOutdir() {
  await fs.mkdir(OUTDIR, { recursive: true });
}

async function save(page, name) {
  const html = await page.content().catch(() => "");
  const png = path.join(OUTDIR, `${name}.png`);
  const htmlPath = path.join(OUTDIR, `${name}.html`);
  try {
    // ビューポートが 0x0 だと撮れないので保険
    const vp = page.viewport();
    if (!vp || !vp.width || !vp.height) {
      await page.setViewport({ width: 1200, height: 1800 });
      await page.waitForTimeout(150);
    }
    await page.screenshot({ path: png, fullPage: true });
  } catch (e) {
    // 「width 0」などで落ちたら一度リサイズして再試行
    try {
      await page.setViewport({ width: 1200, height: 1800 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: png, fullPage: true });
    } catch {
      // どうしてもだめならだめでOK（HTMLだけでも残す）
    }
  }
  await fs.writeFile(htmlPath, html).catch(() => {});
  console.log(`[saved] ${name}`);
}

function chromeArgs(extra = []) {
  return [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--window-size=1200,1800",
    // 「このページは Chrome によってブロックされました」対策の無害化フラグ
    "--disable-extensions",
    "--safebrowsing-disable-auto-update",
    "--disable-client-side-phishing-detection",
    "--disable-features=SafeBrowsingUrlLookup,SafeBrowsingEnhancedProtection,SafeBrowsingInterstitialPinging,IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests",
    ...extra,
  ];
}

async function launch(extraArgs = []) {
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!execPath) {
    throw new Error(
      "Chromium/Chrome の実行パスが見つかりません（PUPPETEER_EXECUTABLE_PATH）。"
    );
  }
  console.log(`[monitor] Using Chrome at: ${execPath}`);
  return puppeteer.launch({
    executablePath: execPath,
    headless: "new",
    args: chromeArgs(extraArgs),
    // 使い回しのプロファイルで“保護者モード扱い”等になるのを避ける
    userDataDir: path.join(__dirname, ".tmp-chrome-profile"),
    defaultViewport: { width: 1200, height: 1800 },
  });
}

async function clickOpensPopup(page, selector, timeout = 8000) {
  // Puppeteer v23 なら waitForEvent が使える
  try {
    const popupPromise = page.waitForEvent("popup", { timeout });
    await page.click(selector, { delay: 50 });
    const popup = await popupPromise;
    return popup;
  } catch {
    // フォールバック：targetcreated から拾う
    const targetsBefore = new Set(page.browser().targets());
    await page.click(selector, { delay: 50 });
    const t = await page
      .browser()
      .waitForTarget((t) => !targetsBefore.has(t) && t.type() === "page", {
        timeout,
      });
    const popup = await t.page();
    return popup;
  }
}

async function main() {
  await ensureOutdir();

  // 1) まず jkk の賃貸トップを開く（ここに “お部屋を検索” がある）
  //   PC 版ヘッダのリンクは target="JKKnet" で
  //   https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit
  //   へ飛びます。:contentReference[oaicite:0]{index=0}
  let browser = await launch();
  const page = await browser.newPage();

  // UA とリファラを少し人間寄りに
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    Referer: "https://www.to-kousya.or.jp/chintai/index.html",
  });

  try {
    await page.goto("https://www.to-kousya.or.jp/chintai/index.html", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  } catch (e) {
    // 入口だけは保存しておく
  }
  await save(page, "entry_referer");

  // 2) “お部屋を検索” をクリックして JKKnet を新規ウィンドウで開く
  // PC と SP の両方に対応
  const SELECTORS = [
    'a[href*="akiyaJyoukenStartInit"]', // PC
    'a[href*="akiyaJyoukenInitMobile"]', // SP
  ];
  let linkSel = null;
  for (const s of SELECTORS) {
    const e = await page.$(s);
    if (e) {
      linkSel = s;
      break;
    }
  }
  if (!linkSel) {
    throw new Error("“お部屋を検索” リンクが見つかりませんでした。");
  }

  let popup;
  try {
    popup = await clickOpensPopup(page, linkSel, 8000);
  } catch {
    // だめなら click ではなく window.open で強制
    popup = await page.evaluateHandle((sel) => {
      const a = document.querySelector(sel);
      if (a) window.open(a.href, "JKKnet");
      return 1;
    });
    // 直後に新規 target を拾う
    const t = await page
      .browser()
      .waitForTarget((t) => t.type() === "page" && /jhomes\.to-kousya\.or\.jp/.test(t.url()), {
        timeout: 8000,
      });
    popup = await t.page();
  }

  // 3) 立ち上がった JKKnet 側を保存
  try {
    await popup.bringToFront();
    await popup.waitForTimeout(800);
    await save(popup, "after_click_raw");
  } catch (_) {}

  // 4) frameset 初期表示 or ブロック判定
  try {
    // 読み込み完了までまつ
    await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    const url = popup.url();
    if (/chrome-error/gi.test(url)) {
      throw new Error("chrome interstitial");
    }
    await save(popup, "frameset_startinit");
  } catch (e) {
    // “This page has been blocked by Chrome”（ERR_BLOCKED_BY_CLIENT）の場合はこちらに来る
    // このエラー画面自体の HTML は Chrome の neterror テンプレートです。:contentReference[oaicite:1]{index=1}
    await save(popup, "final_error");

    // 5) リトライ：SafeBrowsing をさらに強く無効化して新しいブラウザで再試行
    console.log("[retry] launch chrome with stronger flags…");
    await browser.close();
    browser = await launch([
      "--disable-features=SafetyTipUI,SupervisedUserEnhancedExtensions",
      "--disable-component-update"
    ]);
    const p2 = await browser.newPage();
    await p2.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36"
    );
    await p2.setExtraHTTPHeaders({
      Referer: "https://www.to-kousya.or.jp/chintai/index.html"
    });

    // 入口 → 直接 JKKnet に遷移（クリックを介さず直URL）
    await p2.goto("https://www.to-kousya.or.jp/chintai/index.html", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    }).catch(() => {});
    await save(p2, "entry_referer_retry");

    // 直接遷移
    await p2.goto("https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    }).catch(() => {});
    await save(p2, "frameset_startinit_retry");
  }

  await browser.close();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await ensureOutdir();
    // なんらかの時点でページがあれば取得
  } finally {
    process.exit(1);
  }
});
