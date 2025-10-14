// monitor.mjs
import { chromium } from "playwright";
import fs from "node:fs/promises";

const ARTIFACTS = "artifacts";

async function saveHTML(page, name) {
  try {
    await fs.mkdir(ARTIFACTS, { recursive: true });
    const html = await page.content();
    await fs.writeFile(`${ARTIFACTS}/${name}.html`, html);
  } catch (e) {
    console.error(`[saveHTML] ${name}:`, e);
  }
}

async function snap(page, name) {
  try {
    await fs.mkdir(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: `${ARTIFACTS}/${name}.png`, fullPage: true });
  } catch (e) {
    console.error(`[snap] ${name}:`, e);
  }
}

async function maybeClick(page, selector, opts = {}) {
  const { timeout = 1500, force = false } = opts;
  const loc = page.locator(selector);
  if (await loc.first().isVisible({ timeout }).catch(() => false)) {
    await loc.first().click({ timeout, force }).catch(() => {});
    return true;
  }
  return false;
}

async function closeOverlays(page) {
  // Cookieバー
  await maybeClick(page, 'button:has-text("閉じる")');
  await maybeClick(page, 'button:has-text("同意")');
  // チャットやバナーを避ける
  await page.evaluate(() => {
    const hide = (el) => el && (el.style.display = "none");
    hide(document.querySelector('[aria-label="お問い合わせはこちら"]'));
    hide(document.querySelector('#cookie-consent, .cookie, .consent'));
  }).catch(() => {});
}

async function isError404(page) {
  // 新サイトの 404
  const titleHas = await page.locator('title, h1, h2').allTextContents().catch(() => []);
  return titleHas.join(" ").includes("ページが見つかりません");
}

async function gotoLanding(page) {
  console.log("[step] goto landing");
  await page.goto("https://www.to-kousya.or.jp/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  await closeOverlays(page);
  await saveHTML(page, "landing");
  await snap(page, "landing");
}

async function clickKodawari(page) {
  console.log("[step] click こだわり条件");
  // お部屋をえらぶ　の黄色いボックス内の「こだわり条件」
  const selectors = [
    // ボックス内ボタン
    'a:has-text("こだわり条件")',
    'button:has-text("こだわり条件")',
    // ヘッダーメガメニュー経由の回避動線（賃貸住宅情報→検索ボタン付近）
    'nav .gMenuArea a:has-text("賃貸住宅情報")'
  ];
  for (const sel of selectors) {
    const ok = await maybeClick(page, sel, { timeout: 2500 });
    if (ok) break;
  }

  // クリックで別ウィンドウ/タブの可能性があるので待機
  // 先にポップアップ待受けを仕込んでから再度クリックする方が堅い
  const popupPromise = page.waitForEvent("popup").catch(() => null);

  // 念のためもう一度直に狙う
  await maybeClick(page, 'a:has-text("こだわり条件")', { timeout: 2500 });
  const popup = await popupPromise;

  const tgt = popup ?? page;
  if (popup) {
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
  }

  return tgt;
}

async function onJHomesHub(page) {
  // 「検索方法」画面（条件から検索 / エリアで検索 を選ぶゲート）
  const hasHub = await page.locator('a:has-text("条件から検索"), a:has-text("エリアで検索")').first()
    .isVisible()
    .catch(() => false);
  if (hasHub) {
    await saveHTML(page, "conditions_or_list");
    await snap(page, "conditions_or_list");
  }
  return hasHub;
}

async function goAreaFromHub(page) {
  console.log("[step] on jhomes hub → エリアで検索");
  // 「エリアで検索」を優先（地図に飛ぶ）
  const clicked = await maybeClick(page, 'a:has-text("エリアで検索")', { timeout: 4000 });
  if (!clicked) {
    // 表示切り替えが JS の場合があるので、関数 areaOpen() を直接叩く
    await page.evaluate(() => { try { if (typeof areaOpen === "function") areaOpen(); } catch(e){} });
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  await saveHTML(page, "area_map");
  await snap(page, "area_map");
}

async function onAreaMap(page) {
  // 画像マップ（AREA要素 or submitPage 関数）
  const hasArea = await page.locator('area[onclick*="submitPage"]').first().isVisible().catch(() => false);
  return hasArea;
}

async function pickFirstWard(page) {
  console.log("[step] area map → 区を一つクリックして一覧へ");
  // 画像マップの最初の area を解析して submitPage(code) を直接呼ぶ
  const area = page.locator('area[onclick*="submitPage"]');
  const count = await area.count();
  if (count === 0) throw new Error("クリック可能なエリアが見つかりませんでした");

  const onclick = await area.nth(0).getAttribute("onclick");
  const m = onclick && onclick.match(/submitPage\('(\d+)'\)/);
  const czNo = m ? m[1] : null;

  if (czNo) {
    await page.evaluate((code) => { try { if (typeof submitPage === "function") submitPage(code); } catch(e){} }, czNo);
  } else {
    // エリア要素を直接クリック（効かないケースもある）
    await area.nth(0).click().catch(() => {});
  }
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function assertList(page) {
  // 旧サイトの一覧 or 新サイトの一覧どちらでもキャプチャ
  await saveHTML(page, "result_list");
  await snap(page, "result_list");
  console.log("[ok] 一覧らしきページを保存しました");
}

async function recoverFrom404(page) {
  if (!(await isError404(page))) return false;
  console.log("[warn] 404 detected → トップへ戻るを試行");
  await saveHTML(page, "error_fallback");
  await snap(page, "error_fallback");
  // 404 ページの「トップページへ戻る」またはヘッダーロゴ
  const tried =
    (await maybeClick(page, 'a:has-text("トップページへ戻る")', { timeout: 1500 })) ||
    (await maybeClick(page, 'header a[href="/index.html"]', { timeout: 1500 }));
  if (tried) {
    await page.waitForLoadState("networkidle").catch(() => {});
    return true;
  }
  return false;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu", "--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  // 1) ランディングへ
  await gotoLanding(page);

  // 最大2回までリカバリ
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // 2) こだわり条件 → jhomes 入口
      const tgt = await clickKodawari(page);
      await tgt.waitForLoadState("domcontentloaded");
      await closeOverlays(tgt);

      // 404 なら戻ってやり直し
      if (await recoverFrom404(tgt)) {
        await gotoLanding(page);
        continue;
      }

      // 3) jhomes 側のハブ（「条件から検索 / エリアで検索」）なら「エリアで検索」を選択
      if (await onJHomesHub(tgt)) {
        await goAreaFromHub(tgt);
      }

      // 4) 地図ページなら最初の区を選んで一覧へ
      if (await onAreaMap(tgt)) {
        await pickFirstWard(tgt);
      }

      // 5) 一覧を保存して完了
      await assertList(tgt);
      await browser.close();
      return 0;
    } catch (e) {
      console.error(`[attempt ${attempt}]`, e);
      // 404 リカバリまたはリトライ
      await gotoLanding(page);
    }
  }

  await browser.close();
  throw new Error("一覧まで到達できませんでした");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
