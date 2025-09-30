// monitor.js (全貼り用 / Node.js v20 + Playwright)
// -------------------------------------------------
// 使い方: `node monitor.js`
// - out/ フォルダに各段階の HTML と PNG を保存します
// - 0 で終了: 監視フロー成功（ページに到達 or 正常に遷移）
// - 非 0 で終了: サイト側のお詫び/タイムアウト/混雑などで目標に到達できず
//
// 依存: package.json に playwright が入っていること
//      postinstall で "npx playwright install --with-deps chromium" を実行済
//
// -------------------------------------------------

import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

// ========= 基本設定 ==========
const OUT_DIR = process.env.OUT_DIR || "out";
const BASE = "https://jhomes.to-kousya.or.jp";

const HOME_TRY_URLS = [
  `${BASE}/`,
  `${BASE}/search/jkknet/`,
  `${BASE}/search/jkknet/index.html`,
  `${BASE}/search/jkknet/service/`,
];

// 直接 StartInit へ（frameset 経由の場合もあるため Referer を付与）
const START_INIT = `${BASE}/search/jkknet/service/akiyaJyoukenStartInit`;

// Playwright ナビゲーションの待ち
const NAV_WAIT = "domcontentloaded";
const NAV_TIMEOUT = 25_000; // 25s
const STEP_RETRY = 4;

// ========= ユーティリティ ==========

async function ensureOutDir() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function dump(page, name) {
  await ensureOutDir();
  const html = await page.content();
  await fs.writeFile(path.join(OUT_DIR, `${name}.html`), html, "utf8");
  await page.screenshot({
    path: path.join(OUT_DIR, `${name}.png`),
    fullPage: true,
  });
  console.log(`[dump] saved: ${name}.html / ${name}.png`);
}

// 「お詫び」「エラー」「タイムアウト」「混雑」系の判定（強めに）
async function isApologyLike(page) {
  try {
    const title = (await page.title()) || "";
    const bodyText = (await page.textContent("body")) || "";

    const hit =
      /おわび|その操作は行わない|ページが見つかりません|タイムアウト|混みあっております|大変混雑|エラーが発生しました/i.test(
        title + "\n" + bodyText
      );
    return !!hit;
  } catch {
    return false;
  }
}

// 「トップページへ戻る」など、ホームへ戻すリンクを押す
async function clickBackToTopIfAny(page) {
  const candidates = [
    'a:has-text("トップページへ戻る")',
    'input[type="button"][value*="トップページ"]',
    'a:has-text("トップへ戻る")',
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      try {
        await Promise.all([
          page.waitForLoadState(NAV_WAIT, { timeout: NAV_TIMEOUT }),
          loc.click({ timeout: 3_000 }),
        ]);
        return true;
      } catch {
        // だめなら次
      }
    }
  }
  return false;
}

// 指定テキストのリンクを「全フレーム」から探して押す
async function clickLinkAcrossFrames(page, text = "こちら") {
  const frames = page.frames();
  for (const f of frames) {
    const loc = f.locator(`a:has-text("${text}")`).first();
    if ((await loc.count()) > 0) {
      try {
        await Promise.all([
          page.waitForLoadState(NAV_WAIT, { timeout: NAV_TIMEOUT }),
          loc.click({ timeout: 3_000 }),
        ]);
        return true;
      } catch {
        // 次のフレームで試す
      }
    }
  }
  return false;
}

// form を「全フレーム」で強制 submit（auto 次画面誘発用）
async function submitFirstFormAcrossFrames(page) {
  const frames = page.frames();
  let submitted = false;
  for (const f of frames) {
    try {
      const did = await f.evaluate(() => {
        const forms = Array.from(document.forms || []);
        if (forms.length > 0) {
          try {
            forms[0].submit();
            return true;
          } catch {
            return false;
          }
        }
        return false;
      });
      submitted ||= did;
    } catch {
      // ignore
    }
  }
  if (submitted) {
    try {
      await page.waitForLoadState(NAV_WAIT, { timeout: NAV_TIMEOUT });
    } catch {
      // ignore
    }
  }
  return submitted;
}

// 指定 URL にリトライ付きで移動（apology だったら戻るを押して再チャレンジ）
async function gotoWithRecover(page, url, nameForDump) {
  let lastErr;
  for (let i = 1; i <= STEP_RETRY; i++) {
    try {
      console.log(`[goto] try ${i}/${STEP_RETRY}: ${url}`);
      await page.goto(url, { waitUntil: NAV_WAIT, timeout: NAV_TIMEOUT });
      await dump(page, nameForDump ?? `step_goto_${i}`);

      if (await isApologyLike(page)) {
        console.log(`[goto] apology-like detected -> try back to top`);
        const clicked = await clickBackToTopIfAny(page);
        await dump(page, `${nameForDump ?? "step"}_apology_${i}`);
        if (!clicked) throw new Error("apology without back-to-top link");
        // 次のループで再トライ
        continue;
      }
      return; // success
    } catch (e) {
      lastErr = e;
      console.log(`[goto] failed (${i}): ${e?.message ?? e}`);
      // 次ループで再トライ
    }
  }
  throw lastErr ?? new Error(`cannot goto: ${url}`);
}

// ========= メインフロー ==========

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-web-security",
    ],
  });

  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);

  let exitCode = 0;

  try {
    // 1) HOME 相当へ（いずれかに入れれば OK）
    for (let i = 0; i < HOME_TRY_URLS.length; i++) {
      try {
        await gotoWithRecover(page, HOME_TRY_URLS[i], `_home_try_${i + 1}`);
        break; // どれか成功したら抜ける
      } catch (e) {
        if (i === HOME_TRY_URLS.length - 1) {
          throw new Error("cannot reach HOME sequence");
        }
      }
    }
    await dump(page, "_home_");

    // 2) StartInit へ（frameset 直のことがある）
    //    Referer を付けておくと安定する場合がある
    await page.route("**/*", (route) => {
      const headers = {
        ...route.request().headers(),
        Referer: `${BASE}/search/jkknet/service/`,
      };
      route.continue({ headers }).catch(() => {});
    });

    await gotoWithRecover(page, START_INIT, "_frameset_");

    // 3) StartInit で「こちら」を積極的にクリック（main/frames の両方）
    //    何回かやって次に進める
    for (let i = 1; i <= 4; i++) {
      const clicked = await clickLinkAcrossFrames(page, "こちら");
      await dump(page, `_after_relay_${i}`);
      if (!clicked) break; // クリックできなければ終える（auto 遷移に任せる）
    }

    // 4) 念のため、フォーム submit を強制（auto 遷移の促進）
    for (let i = 1; i <= 2; i++) {
      const submitted = await submitFirstFormAcrossFrames(page);
      await dump(page, `_after_submit_${i}`);
      if (!submitted) break;
    }

    // 5) 最終状態を保存
    await dump(page, "_final_");

    // 6) 成否の最終判定
    //    今回は「お詫び/タイムアウト/混雑」状態で終わっていれば非 0 を返す
    if (await isApologyLike(page)) {
      console.log("[final] apology-like page remained -> treat as failure.");
      exitCode = 2;
    } else {
      console.log("[final] reached non-apology page -> success-ish.");
      exitCode = 0;
    }
  } catch (e) {
    console.error("[error]", e?.stack || e?.message || String(e));
    exitCode = 1;
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(exitCode);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
