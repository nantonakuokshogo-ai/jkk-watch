// monitor.js (ESM / Puppeteer) — FULL REPLACE
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const START = 'https://jhomes.to-kousya.or.jp/';
const HOME1 = 'https://jhomes.to-kousya.or.jp/search/jkknet/';
const HOME2 = 'https://jhomes.to-kousya.or.jp/search/jkknet/index.html';
const SERVICE = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/';
const START_INIT = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const OUT = path.join(process.cwd(), 'out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const nowTag = () => new Date().toISOString().replace(/[:.]/g, '-');
const includesAny = (s, arr) => arr.some((x) => s.includes(x));

async function dump(page, tag) {
  const p = (stub, ext) => path.join(OUT, `${tag}_${stub}.${ext}`);
  try {
    await page.screenshot({ path: p('screen', 'png'), fullPage: true });
  } catch {}
  try {
    const html = await page.content();
    fs.writeFileSync(p('page', 'html'), html, 'utf8');
  } catch {}
}

async function isApology(page) {
  const title = (await page.title()).trim();
  const text = await page.evaluate(() => (document.body && document.body.innerText) || '');
  return (
    /おわび|タイムアウト|その操作は行わないで下さい/i.test(title + ' ' + text) ||
    /トップページへ戻る/.test(text)
  );
}

async function clickBackToTopIfPresent(page) {
  // 汎用：「トップページへ戻る」を文字検索でクリック
  const clicked1 = await page.evaluate(() => {
    const xp =
      '//*[self::a or self::input or self::button][contains(normalize-space(.),"トップページへ戻る") or contains(@value,"トップページ")]';
    const it = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    if (it.snapshotLength > 0) {
      const el = it.snapshotItem(0);
      el.click();
      return true;
    }
    return false;
  });
  if (clicked1) {
    await page.waitForTimeout(800);
    return true;
  }

  // 最後の保険：最初のリンクを踏む（おわび→トップリンク想定）
  const clicked2 = await page.evaluate(() => {
    const a = document.querySelector('a[href]');
    if (a && /戻る|トップ|index/i.test(a.textContent || '')) {
      a.click();
      return true;
    }
    return false;
  });
  if (clicked2) {
    await page.waitForTimeout(800);
    return true;
  }
  return false;
}

async function gotoWithHeaders(page, url, referer) {
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ Referer: referer || START });
  return page.goto(url, {
    waitUntil: ['domcontentloaded', 'networkidle0'],
    timeout: 120000,
  });
}

async function goHomeSequence(page, maxLoops = 6) {
  const tag = `homeSeq_${nowTag()}`;
  let step = 0;
  const tryList = [
    [START, START],
    [HOME1, START],
    [HOME2, HOME1],
    [SERVICE, HOME1],
  ];

  for (let loop = 0; loop < maxLoops; loop++) {
    for (const [url, ref] of tryList) {
      step++;
      await gotoWithHeaders(page, url, ref);
      await page.waitForTimeout(1000);

      if (await isApology(page)) {
        await dump(page, `${tag}_apology_step${step}`);
        await clickBackToTopIfPresent(page);
        await page.waitForTimeout(1200);
        continue;
      }

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
  const tag = `relay_${nowTag()}`;

  const tryClickHere = async (ctx) => {
    try {
      return await ctx.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a')).find((x) => /こちら/.test(x.innerText || ''));
        if (a) {
          a.click();
          return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  };

  const tryForceSubmit = async (ctx) => {
    try {
      return await ctx.evaluate(() => {
        const f = document.forms && (document.forms['forwardForm'] || document.querySelector('form'));
        if (f) {
          try {
            f.target = '_self';
          } catch {}
          f.submit();
          return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  };

  await dump(page, `${tag}_page_before`);
  if (await tryClickHere(page)) {
    await page.waitForTimeout(1200);
  } else if (await tryForceSubmit(page)) {
    await page.waitForTimeout(1200);
  }

  // frame も総当たり
  for (let i = 0; i < 3; i++) {
    for (const fr of page.frames()) {
      try {
        const hasBody = await fr.evaluate(() => !!document.body);
        if (!hasBody) continue;
        if (await tryClickHere(fr)) {
          await page.waitForTimeout(1200);
        } else if (await tryForceSubmit(fr)) {
          await page.waitForTimeout(1200);
        }
      } catch {}
    }
  }
  await dump(page, `${tag}_page_after`);
}

async function waitForStartInit(page, totalMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < totalMs) {
    const url = page.url();
    if (url.includes('/service/akiyaJyoukenStartInit')) return true;
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
  const homeOK = await goHomeSequence(page);
  if (!homeOK) {
    console.error('Error:  cannot reach HOME sequence');
    await browser.close();
    process.exit(1);
  }

  console.log('[goto] service frameset');
  await gotoWithHeaders(page, SERVICE, HOME1);
  await page.waitForTimeout(800);

  console.log('[goto] StartInit');
  await gotoWithHeaders(page, START_INIT, SERVICE);
  await page.waitForTimeout(1200);
  await dump(page, `after_goto_StartInit_${nowTag()}`);

  console.log('[relay] click "こちら" / force submit if needed');
  await relayAndSubmit(page);

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
