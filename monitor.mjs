// monitor.mjs  — JKK一覧に手堅く到達して撮る版
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const OUT = "out";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ensureOut() {
  await fs.mkdir(OUT, { recursive: true });
}
async function save(page, name) {
  const png = path.join(OUT, `${name}.png`);
  const html = path.join(OUT, `${name}.html`);
  await page.screenshot({ path: png, fullPage: true });
  await fs.writeFile(html, await page.content(), "utf8");
  console.log("[saved]", name);
}
function looksBlocked(htmlText, title) {
  const t = (title||"") + "\n" + (htmlText||"");
  return /is blocked|ERR_BLOCKED_BY_CLIENT/i.test(t);
}

async function gotoWithRef(page, url, ref) {
  if (ref) {
    await page.setExtraHTTPHeaders({ Referer: ref });
  }
  return page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

async function main() {
  await ensureOut();

  const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
  console.log("[monitor] Using Chrome at:", chrome);

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,                   // ここは headless のままでOK
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-site-isolation-trials",
      // これがキモ：ポップアップブロックを無効化
      "--disable-popup-blocking",
      "--window-size=1280,2600",
    ],
    defaultViewport: { width: 1280, height: 1200 },
  });

  const page = await browser.newPage();

  // 1) 賃貸トップへ
  const TOP = "https://www.to-kousya.or.jp/chintai/index.html";
  await gotoWithRef(page, TOP);
  await save(page, "entry_referer");

  // ブロックされない形（同一タブ）で JKKnet へ移動
  const JKK_PC = "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit";
  const REFERER = TOP;

  // 2) まずは **直接同一タブ遷移**（最も安定）
  await gotoWithRef(page, JKK_PC, REFERER).catch(()=>{});
  await sleep(1500);

  let html = await page.content();
  let blocked = looksBlocked(html, await page.title());

  // 3) もしブロック面なら、トップへ戻って「お部屋を検索」の target を外してクリック
  if (blocked || !/jhomes\.to-kousya\.or\.jp/i.test(page.url())) {
    await gotoWithRef(page, TOP);
    // PC用の「お部屋を検索」リンク（target=JKKnet）を同一タブに書き換えてクリック
    const clicked = await page.evaluate(() => {
      const a = document.querySelector('a[href*="akiyaJyoukenStartInit"]');
      if (!a) return false;
      a.removeAttribute("target"); // ← ポップアップ化を防ぐ
      a.click();
      return true;
    });
    if (clicked) {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(()=>{});
      await sleep(1000);
    }
  }

  // 4) それでもダメならポップアップを **許可** して捕まえる
  html = await page.content();
  blocked = looksBlocked(html, await page.title());
  if (blocked || !/jhomes\.to-kousya\.or\.jp/i.test(page.url())) {
    await gotoWithRef(page, TOP);
    const [popup] = await Promise.all([
      page.waitForEvent("popup").catch(()=>null),
      page.evaluate(() => {
        const a = document.querySelector('a[href*="akiyaJyoukenStartInit"]');
        if (a) a.click(); // target=JKKnet のままクリック（popup を待つ）
      }),
    ]);
    if (popup) {
      await popup.bringToFront();
      await popup.waitForLoadState?.("domcontentloaded").catch(()=>{});
      // 以降は popup 側を操作する
      // puppeteer-core v22 でも互換的に扱えるよう簡素に
      // @ts-ignore
      page.close?.().catch(()=>{});
      // @ts-ignore
      page = popup;
    }
  }

  // 5) ここで jhomes ドメイン上にいれば勝ち。読み込みを少し待って撮る
  await sleep(1500);
  await save(page, "after_wait");

  // 6) ブロック判定したら、証跡だけ残して終了
  html = await page.content();
  if (looksBlocked(html, await page.title())) {
    console.log("[warn] Chrome にブロックされました（ERR_BLOCKED_BY_CLIENT）。証跡を保存して終了します。");
    await save(page, "result_or_form");
    await browser.close();
    return;
  }

  // 7) 可能なら “フォーム or 一覧 or タイムアウト画面” をもう1枚
  await save(page, "result_or_form");

  await browser.close();
}

main().catch(async (e) => {
  console.error(e);
  await ensureOut();
  await fs.writeFile(path.join(OUT, "final_error.txt"), String(e.stack || e), "utf8");
  process.exit(1);
});
