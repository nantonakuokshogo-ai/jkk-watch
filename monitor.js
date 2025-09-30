// monitor.js  — FULL REPLACE (CommonJS + Puppeteer)
// --------------------------------------------------
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const START = 'https://jhomes.to-kousya.or.jp/';
const HOME1 = 'https://jhomes.to-kousya.or.jp/search/jkknet/';
const HOME2 = 'https://jhomes.to-kousya.or.jp/search/jkknet/index.html';
const SERVICE = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/';
const START_INIT = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const OUT = path.join(process.cwd(), 'out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function dump(page, tag) {
  const fn = (name) => path.join(OUT, `${tag}_${name}.`); // add ext later
  try {
    await page.screenshot({ path: fn('screen') + 'png', fullPage: true });
  } catch (_) {}
  try {
    const html = await page.content();
    fs.writeFileSync(fn('page') + 'html', html, 'utf8');
  } catch (_) {}
}

function includesAny(s, arr) {
  return arr.some((x) => s.includes(x));
}

async function isApology(page) {
  const title = (await page.title()).trim();
  // 例: 「JKKねっと：おわび」「その操作は行わないで下さい」「長い間アクセスがなかったため、タイムアウト」
  const text = await page.evaluate(() => document.body.innerText || '');
  return (
    /おわび|タイムアウト|その操作は行わないで下さい/i.test(title + ' ' + text) ||
    /トップページへ戻る/.test(text)
  );
}

async function clickBackToTopIfPresent(page) {
  // 「トップページへ戻る」ボタン/リンクを探してクリック
  const selectors = [
    'input[type=button][value*="トップページ"]',
    'input[value*="トップページへ戻る"]',
    'a:has-text("トップページへ戻る")',
    'input[type=submit][value*="トップページ"]',
    'button:has-text("トップページへ戻る")',
    'a[href]:not([href="#"])',
  ];
  for (const sel of selectors) {
    try {
      const handle = await page.$(sel);
      if (handle) {
        await handle.click({ delay: 50 });
        await page.waitForTimeout(800);
        return true;
      }
    } catch (_) {}
  }

  // 文字検索でクリック（最後の手段）
  try {
    const clicked = await page.evaluate(() => {
      const xp = document.evaluate(
        '//*[self::a or self::input or self::button][contains(normalize-space(.),"トップページへ戻る")]',
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      if (xp.snapshotLength > 0) {
        const el = xp.snapshotItem(0);
        el.click();
        return true;
      }
      return false;
    });
    if (clicked) {
      await page.waitForTimeout(800);
      return true;
    }
  } catch (_) {}
  return false;
}

async function gotoWithHeaders(page, url, referer) {
  await page.setUserAgent(UA);
  const headers = { Referer: referer || START };
  await page.setExtraHTTPHeaders(headers);
  return page.goto(url, { waitUntil: ['domcontentloaded', 'networkidle0'], timeout: 120000 });
}

async function goHomeSequence(page, maxLoops = 6) {
  const tag = `homeSeq_${nowTag()}`;
  let step = 0;

  const tryList = [
    [START, START],
    [HOME1, START],
    [HOME2, HOME1],
    [SERVICE, HOME1], // SERVICE frameset を参照元付きで開く
  ];

  for (let loop = 0; loop < maxLoops; loop++) {
    for (const [url, ref] of tryList) {
      step++;
      await gotoWithHeaders(page, url, ref);
      await page.waitForTimeout(1000);

      if (await isApology(page)) {
        await dump(page, `${tag}_apology_step${step}`);
        // トップへ戻る押下（あれば）
        await clickBackToTopIfPresent(page);
        await page.waitForTimeout(1200);
        continue;
      }

      // ホーム or サービスに到達したら OK
      const cur = page.url();
      if (includesAny(cur, [HOME1, HOME2, SERVICE])) {
        await dump(page, `${tag}_ok_step${step}`);
        return true;
      }
    }
  }
  await dump(page, `${tag}_fail`);
  return false;
}

function findFrameByUrl(page, part) {
  return page.frames().find((f) => (f.url() || '').includes(part));
}

async function relayAndSubmit(page) {
  // 中継ページ: onloadで openMainWindow() → forwardForm.submit() 型
  // “こちら” クリック → だめなら form.submit() 強制（フレームも走査）
  const tag = `relay_${nowTag()}`;

  const tryClickHere = async (ctx) => {
    try {
      const clicked = await ctx.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a')).find((x) => /こちら/.test(x.innerText));
        if (a) {
          a.click();
          return true;
        }
        return false;
      });
      return clicked;
    } catch {
      return false;
    }
  };

  const tryForceSubmit = async (ctx) => {
    try {
      const forced = await ctx.evaluate(() => {
        // 1) onload 実行済みでも保険で forwardForm.submit()
        const f = document.forms && document.forms['forwardForm'];
        if (f) {
          try {
            f.target = '_self'; // 同タブで開かせる
          } catch (_) {}
          f.submit();
          return true;
        }
        // 2) 一般的な form を POST
        const any = document.querySelector('form');
        if (any) {
          any.submit();
          return true;
        }
        return false;
      });
      return forced;
    } catch {
      return false;
    }
  };

  // ページ本体 → “こちら” or submit
  await dump(page, `${tag}_page_before`);
  if (await tryClickHere(page)) {
    await page.waitForTimeout(1200);
  } else if (await tryForceSubmit(page)) {
    await page.waitForTimeout(1200);
  }

  // フレームがあれば同様に処理
  for (let i = 0; i < 3; i++) {
    for (const fr of page.frames()) {
      try {
        const url = fr.url();
        if (!url) continue;
        // 画面を持つフレームだけ相手にする
        const hasBody = await fr.evaluate(() => !!document.body);
        if (!hasBody) continue;

        if (await tryClickHere(fr)) {
          await page.waitForTimeout(1200);
        } else if (await tryForceSubmit(fr)) {
          await page.waitForTimeout(1200);
        }
      } catch (_) {}
    }
  }

  await dump(page, `${tag}_page_after`);
}

async function waitForStartInit(page, totalMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < totalMs) {
    const url = page.url();
    if (url.includes('/service/akiyaJyoukenStartInit')) return true;

    // フレーム側 URL 判定
    const fr = findFrameByUrl(page, '/service/akiyaJyoukenStartInit');
    if (fr) return true;

    await page.waitForTimeout(800);
  }
  return false;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);

  console.log('[goto] start HOME sequence…');

  // 1) 強化した HOME 遷移
  const homeOK = await goHomeSequence(page);
  if (!homeOK) {
    console.error('Error:  cannot reach HOME sequence');
    await browser.close();
    process.exit(1);
  }

  // 2) SERVICE frameset（参照元付き）へ
  console.log('[goto] service frameset');
  await gotoWithHeaders(page, SERVICE, HOME1);
  await page.waitForTimeout(800);

  // 3) StartInit 直叩き（参照元必須）
  console.log('[goto] StartInit');
  await gotoWithHeaders(page, START_INIT, SERVICE);
  await page.waitForTimeout(1200);
  await dump(page, `after_goto_StartInit_${nowTag()}`);

  // 4) 中継ページなら “こちら/submit” を強制
  console.log('[relay] click "こちら" / force submit if needed');
  await relayAndSubmit(page);

  // 5) StartInit がフレームor本体で開くのを待機
  console.log('[wait] StartInit finishing…');
  const ok = await waitForStartInit(page, 120000);
  await dump(page, `final_${nowTag()}`);

  if (!ok) {
    console.error('not found');
    await browser.close();
    process.exit(1);
  }

  console.log('[final] URL:', page.url());
  console.log('[final] TITLE:', await page.title());

  await browser.close();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
