// monitor.mjs
import { chromium } from "playwright";
import fs from "fs-extra";
const SEARCH_KANA = process.env.SEARCH_KANA?.trim() || "コーシャハイム"; // 例: ｺｰｼｬﾊｲﾑ でもOK
const OUTDIR = "artifacts";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function ensureDir(dir) { await fs.mkdirp(dir); }
async function save(page, base) {
  try {
    await page.screenshot({ path: `${OUTDIR}/${base}.png`, fullPage: true });
  } catch {}
  try {
    const html = await page.content();
    await fs.writeFile(`${OUTDIR}/${base}.html`, html);
  } catch {}
}
function nowTag() {
  const d = new Date();
  const pad = (n) => `${n}`.padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function clickIfVisible(page, locator) {
  const loc = page.locator(locator);
  if (await loc.first().isVisible().catch(() => false)) {
    await loc.first().click({ timeout: 3000 }).catch(() => {});
    return true;
  }
  return false;
}

async function main() {
  await ensureDir(OUTDIR);
  const ts = nowTag();

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 2000 }
  });
  context.setDefaultTimeout(30000);

  // 予期せぬアラート対策
  context.on("page", (p) => p.on("dialog", d => d.dismiss().catch(()=>{})));

  const page = await context.newPage();

  try {
    // 1) JKKトップへ
    const TOP = "https://www.to-kousya.or.jp/chintai/index.html";
    await page.goto(TOP, { waitUntil: "domcontentloaded" });
    await save(page, `landing_${ts}`);

    // Cookieバナー等は閉じられるときだけ閉じる
    await clickIfVisible(page, 'button:has-text("閉じる")');

    // 「お部屋を検索」リンク（PC/Mobile両方対応）をクリック→新しいPage(popup)を捕捉
    // - a[href*='akiyaJyoukenStartInit'] はPC
    // - a[href*='akiyaJyoukenInitMobile'] はSP
    const trigger = page.locator("a[href*='akiyaJyoukenStartInit'], a[href*='akiyaJyoukenInitMobile']").first();

    const popupPromise = context.waitForEvent("page");
    await trigger.waitFor({ state: "visible" });
    await Promise.all([
      popupPromise,
      trigger.click({ timeout: 5000 })
    ]);
    const jkk = await popupPromise;

    // 2) エントリ(待機)ページ → 自動で本体へ遷移
    await jkk.waitForLoadState("domcontentloaded");
    await save(jkk, `entry_referer_${ts}`);

    // 自動遷移を待つ（最大20秒）。たまに止まるので、フォールバックでクリック実行。
    const maxWait = Date.now() + 20000;
    let advanced = false;
    while (Date.now() < maxWait && !advanced) {
      const url = jkk.url();
      if (/akiyaJyouken(Start)?Init/i.test(url) || /akiyaJyouken/.test(url)) {
        advanced = true;
        break;
      }
      // クリック用リンク（「こちら」）があれば押して促進
      await clickIfVisible(jkk, 'a:has-text("こちら")');
      await sleep(800);
    }

    // タイムアウト鯨ページ対策：見つけたらやり直し
    if (await jkk.getByText("タイムアウト", { exact: false }).first().isVisible().catch(()=>false)) {
      await save(jkk, `timeout_${ts}`);
      throw new Error("Session timed out on entry page");
    }

    // 3) 条件入力（先着順あき家検索）
    // たまに数度のリダイレクトがあるため、軽く待つ
    await jkk.waitForLoadState("domcontentloaded");
    await save(jkk, `jyouken_${ts}`);

    // 住宅名(カナ)っぽい入力欄を順に探して最初に見つかったものに投入
    const kanaSelectors = [
      "//td[contains(., '住宅名') and contains(., 'カナ')]/following::input[@type='text'][1]",
      "input[name*='Kana']",
      "input[name*='kana']",
      "input[title*='カナ']",
      "input[type='text']" // 最後の保険（ページ構造が変わった場合）
    ];
    let kanaInput = null;
    for (const sel of kanaSelectors) {
      const loc = jkk.locator(sel).first();
      if (await loc.isVisible().catch(()=>false)) {
        kanaInput = loc;
        break;
      }
    }

    if (!kanaInput) {
      await save(jkk, `jyouken_noinput_${ts}`);
      throw new Error("住宅名（カナ）入力欄が見つかりませんでした。");
    }

    // 半角カナ要求の可能性もあるため、全角→そのまま投入（多くはどちらも通ります）
    await kanaInput.fill(SEARCH_KANA);

    // スクロールして検索ボタンを押す（input[type=image][alt=検索する] が2個ある想定）
    const searchSelectors = [
      "input[type='image'][alt='検索する']",
      "input[type='submit'][value='検索する']",
      "input[value='検索']",
      "img[alt='検索する']"
    ];
    let clicked = false;
    for (const sel of searchSelectors) {
      if (await clickIfVisible(jkk, sel)) { clicked = true; break; }
    }
    if (!clicked) {
      // キーボードEnterも試す
      await kanaInput.press("Enter").catch(()=>{});
    }

    // 入力後の状態も保存
    await save(jkk, `jyouken_filled_${ts}`);

    // 4) 一覧ページ待ち（URL・要素どちらか一致）
    const until = Date.now() + 30000;
    let onList = false;
    while (Date.now() < until) {
      const u = jkk.url();
      if (/Result/i.test(u) || /List/i.test(u)) { onList = true; break; }
      if (await jkk.getByText("詳細", { exact: false }).first().isVisible().catch(()=>false)) { onList = true; break; }
      await sleep(500);
    }

    if (!onList) {
      await save(jkk, `last_page_fallback_${ts}`);
      throw new Error("検索結果一覧に到達できませんでした。");
    }

    await save(jkk, `result_list_${ts}`);
  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
}

main();
