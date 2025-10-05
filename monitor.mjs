// monitor.mjs
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const OUT = path.resolve("out");
const S = (ms) => new Promise((r) => setTimeout(r, ms));
const TOP_CANDIDATES = [
  process.env.JKK_TOP_URL?.trim(),
  "https://www.jkk-tokyo.or.jp/", // こちらを最優先（www 付き）
  "https://jkk-tokyo.or.jp/",     // 補助（失敗しがち）
].filter(Boolean);

async function ensureOut() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
}
async function saveShot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}
async function saveHTML(page, name) {
  const html = await page.content();
  fs.writeFileSync(path.join(OUT, `${name}.html`), html);
}

function writeEntrySkippedCard({ lastUrl, urlsTried, reason }) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>entry skipped</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans JP',sans-serif;background:#f6f7f9;margin:0;padding:60px;}
.card{max-width:720px;margin:80px auto;background:#fff;border-radius:14px;padding:28px 32px;box-shadow:0 8px 28px rgba(0,0,0,.08);}
h1{font-size:22px;margin:0 0 12px;}
pre{white-space:pre-wrap;word-break:break-word;font-size:13px;color:#333;background:#fafafa;padding:10px 12px;border-radius:8px;}
small{color:#666}
</style></head><body>
<div class="card">
<h1>entry skipped</h1>
<pre>${reason}</pre>
<pre>URL candidates: ${urlsTried.join(", ")}</pre>
<pre>last error: failed to open: ${lastUrl}</pre>
<small>Generated at ${new Date().toISOString()}</small>
</div></body></html>`;
  fs.writeFileSync(path.join(OUT, "entry_referer_skipped.html"), html);
}

async function gotoTop(page) {
  let lastErr = null;
  const tried = [];
  for (const url of TOP_CANDIDATES) {
    tried.push(url);
    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      if (res && res.ok()) {
        await saveShot(page, "entry_referer");
        await saveHTML(page, "entry_referer");
        return true;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  writeEntrySkippedCard({
    lastUrl: tried[tried.length - 1],
    urlsTried: tried,
    reason: "DNS/ネットワークの理由でエントリーに到達できませんでした。",
  });
  return false;
}

async function findAndClickJkknet(page) {
  // 1) 露出している「JKKねっと」リンクを探す
  const selectorCandidates = [
    'a[href*="jkknet"]',
    'a[href*="/search/"]',
    'a[href*="akiya"]',
  ];

  for (const sel of selectorCandidates) {
    const el = await page.$(sel);
    if (el) {
      // 新規タブ抑止
      await page.evaluate((s) => {
        const a = document.querySelector(s);
        if (a) a.removeAttribute("target");
      }, sel);

      // ポップアップ監視（中継ページが window.open(..., "JKKnet") を叩くため）
      const popupTargetPromise = page.browser().waitForTarget(
        (t) => {
          const u = (t.url() || "").toLowerCase();
          return u.includes("wait.jsp") || u.includes("jkknet");
        },
        { timeout: 15000 }
      ).catch(() => null);

      await saveShot(page, "pre_click");
      await el.click({ delay: 50 });
      await S(200);
      await saveShot(page, "post_click");

      // a クリック後、中継ページに遷移して onload で window.open → submit が走る想定
      // （/search/jkknet/wait.jsp → akiyaJyoukenStartInit に POST）
      let popupTarget = await popupTargetPromise;
      if (!popupTarget) {
        // クリック先が即「中継ページ」だった場合に備えて再監視
        popupTarget = await page.browser().waitForTarget(
          (t) => {
            const u = (t.url() || "").toLowerCase();
            return u.includes("wait.jsp") || u.includes("jkknet");
          },
          { timeout: 10000 }
        ).catch(() => null);
      }
      if (!popupTarget) throw new Error("JKKnet ポップアップを検出できませんでした。");

      const jkkPage = await popupTarget.page();
      // ネットワークが動く時間を与える
      await jkkPage.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
      return jkkPage;
    }
  }
  throw new Error("JKKねっとへのリンクが見つかりませんでした。");
}

async function clickSearchAndAwaitResults(jkkPage) {
  // 条件入力を飛ばして「検索」相当を探す（テキスト or value に「検索」が入るもの）
  async function clickSearchLike() {
    const clicked = await jkkPage.evaluate(() => {
      function clickEl(el) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        el.click();
        return true;
      }
      const isSearchText = (t) => /検索/.test(t || "");
      // input[type=submit]
      const inputs = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"]'));
      for (const el of inputs) {
        if (isSearchText(el.value) || isSearchText(el.getAttribute("value"))) {
          if (clickEl(el)) return true;
        }
      }
      // button
      const btns = Array.from(document.querySelectorAll("button"));
      for (const el of btns) {
        if (isSearchText(el.innerText)) {
          if (clickEl(el)) return true;
        }
      }
      // aタグ
      const anchors = Array.from(document.querySelectorAll("a"));
      for (const el of anchors) {
        if (isSearchText(el.innerText)) {
          if (clickEl(el)) return true;
        }
      }
      return false;
    });
    if (!clicked) throw new Error("検索ボタン相当が見つかりませんでした。");
  }

  // まずページタイトル or URL が動くまで少し待つ（中継・初期化に時間がかかる想定）
  await S(500);
  await saveShot(jkkPage, "search_landing");
  await saveHTML(jkkPage, "search_landing");

  // 検索クリック
  await clickSearchLike();
  await S(400);

  // 結果らしさの検出
  const how = await waitResultLike(jkkPage, 30000);
  await saveShot(jkkPage, "result_page");
  await saveHTML(jkkPage, "result_page");
  console.log(`[result] detected by: ${how}`);
}

async function waitResultLike(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const urlChanged = (u) =>
    /result|list|kensaku|searchresult|_result|index\.php|akiya/i.test(u);

  while (Date.now() < deadline) {
    const url = page.url();
    if (urlChanged(url)) return `url(${url})`;

    // 件数や見出しテキスト
    const textHit = await page.evaluate(() => {
      const body = document.body?.innerText || "";
      return /件見つかりました|検索結果|物件一覧|該当物件|空き家情報/i.test(body);
    });
    if (textHit) return "text-hit";

    // リストっぽいDOM
    const selHit = await page.$(
      [
        ".result-list",
        ".search-result",
        ".list",            // 緩め
        "table.result",     // テーブル型
        '[class*="result"]',
        '[id*="result"]',
      ].join(",")
    );
    if (selHit) return "selector";

    await S(500);
  }
  throw new Error("結果待機がタイムアウトしました。");
}

async function main() {
  await ensureOut();
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1366, height: 960 },
  });
  const page = await browser.newPage();

  // 入口（www 優先）
  const ok = await gotoTop(page);
  if (!ok) {
    await saveShot(page, "entry_referer_skipped");
    await browser.close();
    process.exit(2);
  }

  try {
    // 「JKKねっと」→ ポップアップ「JKKnet」を捕まえる
    const jkkPage = await findAndClickJkknet(page);

    // 検索 → 結果判定
    await clickSearchAndAwaitResults(jkkPage);
  } catch (e) {
    fs.writeFileSync(path.join(OUT, "final_error.txt"), String(e?.stack || e));
    await saveHTML(page, "note_error");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
