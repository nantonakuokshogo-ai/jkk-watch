// monitor.js  —— JKK (空き家) リレー専用・popup対応 完全版
// Node 20 + Playwright (^1.47) 前提

import { chromium } from "playwright";

const HOME_BASE = "https://jhomes.to-kousya.or.jp";
const HOME_URLS = [
  `${HOME_BASE}/`,
  `${HOME_BASE}/search/jkknet/`,
  `${HOME_BASE}/search/jkknet/index.html`,
  `${HOME_BASE}/search/jkknet/service/`,
];
const START_INIT = `${HOME_BASE}/search/jkknet/service/akiyaJyoukenStartInit`;

// ===== helpers =====
async function saveShot(p, name) {
  try { await p.screenshot({ path: `${name}.png`, fullPage: true }); } catch {}
}
async function saveHtml(p, name) {
  try { await Bun.write(`${name}.html`, await p.content()); } catch {}
}
async function waitIdle(p, ms = 600) {
  try { await p.waitForTimeout(ms); } catch {}
}
const hasText = async (p, pattern) => (await p.content()).includes(pattern);

// 「トップページへ戻る」押下 (おわび/タイムアウト からの復帰)
async function clickBackToTop(p) {
  const sel = 'text=トップページへ戻る';
  try {
    const btn = await p.locator(sel).first();
    if (await btn.count()) {
      await btn.click({ timeout: 3000 });
      await p.waitForLoadState('domcontentloaded', { timeout: 8000 });
      return true;
    }
  } catch {}
  return false;
}

// apology 系を検知
async function isApology(p) {
  const html = await p.content();
  return (
    html.includes("JKKねっと：おわび") ||
    html.includes("長い間アクセスがなかったため") ||
    html.includes("ただいま、サーバーが大変混みあっております")
  );
}

// URL 群を順に試す
async function gotoWithFallback(page, urls, referrer) {
  for (const u of urls) {
    try {
      if (referrer) {
        await page.goto(u, { referer: referrer, timeout: 15000, waitUntil: 'domcontentloaded' });
      } else {
        await page.goto(u, { timeout: 15000, waitUntil: 'domcontentloaded' });
      }
      console.log("[goto]", u);
      await waitIdle(page);
      if (await isApology(page)) {
        console.log("[recover] apology -> back to top");
        if (!(await clickBackToTop(page))) continue;
      }
      return true;
    } catch (e) {
      console.log("[goto-fail]", u, e.message);
    }
  }
  return false;
}

// 「こちら」クリック (frame or main 両対応)
async function tryClickKochira(ctx) {
  // main
  let target = ctx.locator('text=こちら').first();
  if (await target.count()) {
    await target.click({ timeout: 2000 });
    return true;
  }
  // a[href*="#"] の「こちら」ケース
  target = ctx.locator('a:has-text("こちら")').first();
  if (await target.count()) {
    await target.click({ timeout: 2000 });
    return true;
  }
  return false;
}

// forwardForm を popup で submit する (仕様の再現)
async function submitForwardFormWithPopup(ctxPage) {
  // ctxPage か、その子 frame のどこかに forwardForm がある想定
  const getFrameWithForm = async () => {
    // main
    if (await ctxPage.evaluate(() => !!document.forwardForm)) return ctxPage.mainFrame();
    // frames
    for (const f of ctxPage.frames()) {
      try {
        const ok = await f.evaluate(() => !!document.forwardForm).catch(() => false);
        if (ok) return f;
      } catch {}
    }
    return null;
  };

  const frame = await getFrameWithForm();
  if (!frame) return false;

  console.log("[relay] submit forwardForm via popup");

  // popup を待ち受け & window.open + submit を実行
  const [popup] = await Promise.all([
    ctxPage.waitForEvent("popup", { timeout: 8000 }),
    frame.evaluate(() => {
      // サイトの実装を忠実に再現
      window.open("/search/jkknet/wait.jsp", "JKKnet");
      document.forwardForm.target = "JKKnet";
      document.forwardForm.submit();
    }),
  ]).catch(() => [null]);

  if (!popup) {
    console.log("[relay] popup not opened");
    return false;
  }

  // popup 内の遷移を待つ
  await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  console.log("[relay] popup URL:", popup.url());
  await saveShot(popup, "_popup_");
  await saveHtml(popup, "_popup_");

  // popup がさらに遷移して frameset になる場合あり
  try {
    // しばらく待ってメイン側にも変化が出るかを見る
    await waitIdle(ctxPage, 1000);
  } catch {}

  return true;
}

// frameset 直叩きパス (referer=/service/)
async function directFramesetStart(page) {
  console.log("[frameset] direct goto StartInit with referer=/service/");
  await page.goto(START_INIT, {
    referer: `${HOME_BASE}/search/jkknet/service/`,
    timeout: 15000,
    waitUntil: "domcontentloaded",
  });
  await waitIdle(page);
  await saveShot(page, "_frameset_");
  await saveHtml(page, "_frameset_");
}

// ===== main =====
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--no-sandbox'],
  });
  const page = await browser.newPage({ bypassCSP: true });

  try {
    // A) まず HOME を試すが、失敗しても “ソフト失敗” 扱いで先へ進む
    let homeReached = false;
    try {
      homeReached = await gotoWithFallback(page, HOME_URLS);
    } catch {}
    if (homeReached) {
      await saveShot(page, "_home_");
      await saveHtml(page, "_home_");
      console.log("[home] URL:", page.url());
    } else {
      console.log("[soft] HOME には入れなかったので、frameset 直行に切り替えます");
    }

    // B) HOME がダメでも frameset 直叩きで突破を試す（本命）
    await directFramesetStart(page);

    // C) “こちら”→forwardForm submit（popup）へ
    let relayed = false;
    if (await tryClickKochira(page)) relayed = true;
    if (!relayed) {
      for (const f of page.frames()) {
        try { if (await tryClickKochira(f)) { relayed = true; break; } } catch {}
      }
    }
    await waitIdle(page, 700);
    await saveShot(page, "_after_relay_");
    await saveHtml(page, "_after_relay_");

    // D) popup 経由 submit（うまく行かなければ 1 回だけ作り直して再試行）
    let submitted = await submitForwardFormWithPopup(page);
    if (!submitted) {
      console.log("[relay] 失敗 → frameset 作り直して再試行");
      await directFramesetStart(page);
      await waitIdle(page, 500);
      submitted = await submitForwardFormWithPopup(page);
    }
    if (!submitted) {
      console.log("[relay] popup submit できず（サーバ混雑かも）。状態を保存して終了します。");
      await saveShot(page, "_after_submit_");
      await saveHtml(page, "_after_submit_");
      return; // ← ここで正常終了扱い
    }

    // E) submit 後の状態を保存
    await waitIdle(page, 800);
    await saveShot(page, "_after_submit_");
    await saveHtml(page, "_after_submit_");

    console.log("[final] URL:", page.url());
    console.log("[final] TITLE:", await page.title());
  } catch (e) {
    console.error("ERROR", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
