// monitor.mjs
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const OUT = path.resolve("out");
const S = (ms) => new Promise((r) => setTimeout(r, ms));

// 入口の候補（www 付きを優先）
const TOP_CANDIDATES = [
  process.env.JKK_TOP_URL?.trim(),
  "https://www.jkk-tokyo.or.jp/",
  "https://jkk-tokyo.or.jp/",
].filter(Boolean);

// ------------------------ utils ------------------------
async function ensureOut() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
}

async function ensureViewport(page) {
  if (!page || page.isClosed()) return;
  try {
    const vp = page.viewport();
    const need =
      !vp || !vp.width || !vp.height || vp.width < 320 || vp.height < 320;
    if (need) {
      await page.setViewport({ width: 1366, height: 960, deviceScaleFactor: 1 });
    }
    // 念のためウィンドウサイズも合わせる
    await page.evaluate(() => {
      try { window.resizeTo(1366, 960); } catch {}
      document.body && (document.body.style.background = document.body.style.background || "#fff");
    });
  } catch {}
}

async function saveShot(page, name) {
  try {
    await ensureViewport(page);
    await page.bringToFront().catch(() => {});
    await page.screenshot({
      path: path.join(OUT, `${name}.png`),
      fullPage: true,
      captureBeyondViewport: false,
    });
  } catch (e) {
    // 失敗しても処理続行できるようにする（幅0対策の最終防衛）
    fs.writeFileSync(path.join(OUT, `${name}_shot_error.txt`), String(e?.stack || e));
  }
}

async function saveHTML(page, name) {
  try {
    await ensureViewport(page);
    const html = await page.content();
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  } catch (e) {
    fs.writeFileSync(path.join(OUT, `${name}_html_error.txt`), String(e?.stack || e));
  }
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

// ------------------------ navigation ------------------------
async function gotoTop(page) {
  let lastErr = null;
  const tried = [];
  for (const url of TOP_CANDIDATES) {
    tried.push(url);
    try {
      await ensureViewport(page);
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
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
  // 1) 「JKKねっと」っぽいリンクを広めに探索
  const selectorCandidates = [
    'a[href*="jkknet"]',
    'a[href*="/search"]',
    'a[href*="akiya"]',
    'a:has-text("JKKねっと")',
    'a:has-text("検索")',
  ];

  for (const sel of selectorCandidates) {
    const el = await page.$(sel).catch(() => null);
    if (!el) continue;

    // 新規タブ抑止
    await page.evaluate((s) => {
      const a = document.querySelector(s);
      if (a) a.removeAttribute("target");
    }, sel).catch(() => {});

    // ポップアップ（wait.jsp / "JKKnet"）を監視
    const popupTargetPromise = page.browser().waitForTarget(
      (t) => {
        const u = (t.url() || "").toLowerCase();
        return u.includes("wait.jsp") || u.includes("jkknet");
      },
      { timeout: 15000 }
    ).catch(() => null);

    await saveShot(page, "pre_click");
    await el.click({ delay: 60 }).catch(() => {});
    await S(250);
    await saveShot(page, "post_click");

    // 子ターゲットを取得
    let popupTarget = await popupTargetPromise;
    if (!popupTarget) {
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
    await ensureViewport(jkkPage);
    await jkkPage.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    return jkkPage;
  }
  throw new Error("JKKねっとへのリンクが見つかりませんでした。");
}

async function clickSearchAndAwaitResults(jkkPage) {
  await ensureViewport(jkkPage);
  await S(500);
  await saveShot(jkkPage, "search_landing");
  await saveHTML(jkkPage, "search_landing");

  // 「検索」テキスト/ボタンを総当たりでクリック
  const clicked = await jkkPage.evaluate(() => {
    function clickable(el) {
      const r = el.getBoundingClientRect?.();
      return r && r.width > 0 && r.height > 0;
    }
    function clickEl(el) { el.click(); return true; }

    const isSearch = (t) => /検索/.test((t || "").trim());

    const btns = [
      ...document.querySelectorAll('input[type="submit"], input[type="button"], button')
    ];
    for (const el of btns) {
      const txt = el.value || el.innerText || el.getAttribute("value") || "";
      if (isSearch(txt) && clickable(el)) return clickEl(el);
    }
    const as = [...document.querySelectorAll("a")];
    for (const el of as) {
      const txt = el.innerText || "";
      if (isSearch(txt) && clickable(el)) return clickEl(el);
    }
    return false;
  });
  if (!clicked) throw new Error("検索ボタン相当が見つかりませんでした。");

  await S(500);
  const how = await waitResultLike(jkkPage, 30000);
  await saveShot(jkkPage, "result_page");
  await saveHTML(jkkPage, "result_page");
  console.log(`[result] detected by: ${how}`);
}

async function waitResultLike(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const urlLike = (u) => /result|list|kensaku|searchresult|_result|index\.php|akiya/i.test(u);

  while (Date.now() < deadline) {
    await ensureViewport(page);
    const url = page.url();
    if (urlLike(url)) return `url(${url})`;

    const textHit = await page.evaluate(() => {
      const t = document.body?.innerText || "";
      return /件見つかりました|検索結果|物件一覧|該当物件|空き家情報/i.test(t);
    });
    if (textHit) return "text-hit";

    const selHit = await page.$(
      [
        ".result-list",
        ".search-result",
        ".list",
        "table.result",
        '[class*="result"]',
        '[id*="result"]',
      ].join(",")
    );
    if (selHit) return "selector";
    await S(500);
  }
  throw new Error("結果待機がタイムアウトしました。");
}

// ------------------------ main ------------------------
async function main() {
  await ensureOut();
  const browser = await puppeteer.launch({
    headless: true,                          // 'new' での相性問題を避ける
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=1366,960",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: { width: 1366, height: 960, deviceScaleFactor: 1 },
  });

  // すべての新規ページに viewport を強制
  browser.on("targetcreated", async (t) => {
    try {
      const p = await t.page();
      if (p) await ensureViewport(p);
    } catch {}
  });

  const page = await browser.newPage();
  await ensureViewport(page);

  // 入口
  const ok = await gotoTop(page);
  if (!ok) {
    await saveShot(page, "entry_referer_skipped");
    await browser.close();
    process.exit(2);
  }

  try {
    // 「JKKねっと」→ ポップアップ捕捉
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
