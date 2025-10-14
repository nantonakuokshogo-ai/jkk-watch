// monitor.mjs
// Playwright ESM
import { chromium } from "playwright";
import fs from "fs/promises";

const OUT = "artifacts";

// ---------- helpers ----------
async function saveHtml(page, name) {
  try {
    const html = await page.content();
    await fs.writeFile(`${OUT}/${name}.html`, html, "utf8");
  } catch (e) {
    console.error(`[warn] saveHtml ${name}:`, e);
  }
}

async function shot(page, name) {
  try {
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  } catch (e) {
    console.error(`[warn] screenshot ${name}:`, e);
  }
}

async function safeClick(page, locator, opt = {}) {
  const l = page.locator(locator).first();
  if (await l.count() === 0) return false;
  try {
    await l.scrollIntoViewIfNeeded();
    await l.waitFor({ state: "visible", timeout: opt.timeout ?? 3000 });
  } catch {}
  try {
    await l.click({ timeout: opt.timeout ?? 3000 });
    return true;
  } catch (e) {
    // 最後の手段: DOM click
    try {
      const clicked = await l.evaluate((el) => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      });
      return clicked;
    } catch {}
  }
  return false;
}

async function closeObstacles(page) {
  // Cookieバー（「閉じる」「同意する」など）
  for (const text of ["閉じる", "同意する", "同意して続行", "OK"]) {
    const ok = await safeClick(page, `:is(button, a, div, span):has-text("${text}")`, { timeout: 1000 });
    if (ok) break;
  }
  // チャット/モーダル(右下)をできるだけ閉じる
  await page.evaluate(() => {
    const sel = ['[aria-label="閉じる"]', '.close', '.mf_close', '.js-close'];
    for (const s of sel) document.querySelectorAll(s).forEach((n) => n.click?.());
  }).catch(() => {});
}

// ---------- steps ----------
async function gotoChintaiTop(page) {
  console.log("[step] goto top -> chintai");
  await page.goto("https://www.to-kousya.or.jp/", { waitUntil: "domcontentloaded" });
  await closeObstacles(page);
  await shot(page, "landing");
  await saveHtml(page, "landing");

  // ヘッダーの「賃貸住宅情報」へ
  // 1) 直接リンク（最も確実）
  await page.goto("https://www.to-kousya.or.jp/chintai/index.html", { waitUntil: "domcontentloaded" });
  await closeObstacles(page);
  await shot(page, "chintai_top");
  await saveHtml(page, "chintai_top");
}

async function openConditions(page) {
  console.log("[step] open conditions (こだわり条件)");
  // ヒーローの「こだわり条件」ボタン（いくつかの表記/ロールに対応）
  const selectors = [
    'a:has-text("こだわり条件")',
    'button:has-text("こだわり条件")',
    'role=link[name=/こだわり条件/]',
    'role=button[name=/こだわり条件/]',
  ];
  let clicked = false;
  for (const s of selectors) {
    clicked = await safeClick(page, s, { timeout: 2500 });
    if (clicked) break;
  }
  if (!clicked) throw new Error("こだわり条件のリンクが見つかりませんでした");

  // 遷移待ち & 邪魔除去
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await closeObstacles(page);
  await shot(page, "after_click_kodawari");
  await saveHtml(page, "after_click_kodawari");

  // 3パターンの着地をハンドリング:
  // A) 自動遷移待ちページ（「数秒後に自動で次の画面が表示されます。」）
  if ((await page.content()).includes("数秒後に自動で") || (await page.getByText("こちら").count()) > 0) {
    await safeClick(page, 'a:has-text("こちら")', { timeout: 3000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  }

  // B) エリア（青い地図）ページ → 右上「条件から検索」
  if ((await page.content()).includes("先着順あき家検索") && (await page.getByText("条件から検索").count()) > 0) {
    await safeClick(page, 'a:has-text("条件から検索")', { timeout: 3000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  }

  // C) そのまま条件フォームに着地（チェックボックス一杯のページ）
  await closeObstacles(page);
  await shot(page, "conditions_or_list");
  await saveHtml(page, "conditions_or_list");

  // もし誤って物件一覧（カード並び）に落ちたら、そのまま完了扱い
  const looksLikeList =
    (await page.getByText(/検索結果|件中/).count()) > 0 ||
    (await page.locator("a:has-text('詳細ページへ')").count()) > 0;

  if (looksLikeList) {
    console.log("[info] 既に物件一覧に到達");
    return "list";
  }

  // 条件フォームの「検索」ボタンを押して一覧へ
  // ボタン表記のゆれを吸収
  const searchButtons = [
    'input[type="submit"][value="検 索"]',
    'input[type="submit"][value="検索"]',
    'button:has-text("検索")',
    'input[type="image"]',
  ];
  for (const s of searchButtons) {
    const ok = await safeClick(page, s, { timeout: 2500 });
    if (ok) break;
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await closeObstacles(page);
  await shot(page, "result_list");
  await saveHtml(page, "result_list");
  return "list";
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1600 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await gotoChintaiTop(page);
    const status = await openConditions(page);
    console.log(`[done] status: ${status}`);
  } catch (e) {
    console.error("[fatal]", e);
  } finally {
    await browser.close();
  }
}

main();
