// monitor.mjs
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const OUT = "out";
const BASE = "https://jhomes.to-kousya.or.jp";

async function ensureOut() {
  await fs.mkdir(OUT, { recursive: true });
}
async function save(page, name) {
  await ensureOut();
  const png = path.join(OUT, `${name}.png`);
  const html = path.join(OUT, `${name}.html`);
  try {
    await page.screenshot({ path: png, fullPage: true });
  } catch (e) {
    console.log(`[warn] screenshot failed for ${name}: ${e.message}`);
  }
  try {
    const content = await page.content();
    await fs.writeFile(html, content, "utf8");
  } catch (e) {
    console.log(`[warn] html save failed for ${name}: ${e.message}`);
  }
  console.log(`[saved] ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findSearchFrame(page) {
  // フレームを総当たりで調べて、「住宅名(カナ)」や「先着順あき家検索」の文字があるフレームを返す
  for (const f of page.frames()) {
    try {
      const html = await f.content();
      if (
        html.includes("先着順あき家検索") ||
        html.includes("住宅名(カナ)") ||
        html.includes("検索する")
      ) {
        return f;
      }
    } catch {}
  }
  return null;
}

async function typeKanaNearLabel(frame, text) {
  // 「住宅名(カナ)」に近い input[type=text] を見つけて入力
  const ok = await frame.evaluate((value) => {
    // 1) 「住宅名(カナ)」という文字を含むセル/ラベルを探す
    const buckets = Array.from(
      document.querySelectorAll("label,th,td,span,div")
    );
    const label =
      buckets.find((el) => el.textContent?.includes("住宅名(カナ)")) || null;
    if (!label) return false;

    // 2) 近傍のテキスト入力を探索（同じ行 → 親要素内 → 近隣）
    const searchOrder = [];
    const tr = label.closest("tr");
    if (tr) searchOrder.push(...tr.querySelectorAll("input[type='text']"));
    searchOrder.push(
      ...label.parentElement?.querySelectorAll("input[type='text']") || []
    );
    // fallback: ページ内最初の text を使う（最後の保険）
    if (!searchOrder.length) {
      searchOrder.push(...document.querySelectorAll("input[type='text']"));
    }
    const input = searchOrder.find((el) => el && !el.disabled && el.offsetParent !== null);
    if (!input) return false;

    input.focus();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (const ch of value) {
      input.value += ch;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  }, text);
  if (!ok) throw new Error("住宅名(カナ) の入力欄が見つかりませんでした。");
}

async function clickSearch(frame) {
  const clicked = await frame.evaluate(() => {
    // 「検索する」と表示されるボタン/リンク/画像ボタンを探す
    const candidates = [
      ...document.querySelectorAll("button,input[type='submit'],input[type='button'],input[type='image'],a"),
    ];
    const target = candidates.find((el) => {
      const t = (el.textContent || "").trim();
      const v = (el.value || "").trim();
      const aria = el.getAttribute?.("aria-label") || "";
      return /検索する/.test(t) || /検索する/.test(v) || /検索/.test(aria);
    });
    if (target) {
      target.click();
      return true;
    }
    return false;
  });
  if (!clicked) throw new Error("「検索する」ボタンが見つかりませんでした。");
}

async function main() {
  const executablePath = process.env.GOOGLE_CHROME || "/usr/bin/google-chrome";

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1280, height: 1800 },
  });

  const page = await browser.newPage();
  try {
    await ensureOut();
    await fs.writeFile(path.join(OUT, "run.txt"), new Date().toISOString());

    // 1) トップ → jkknet → service でセッション/リファラを作る
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await save(page, "home_1");

    await page.goto(`${BASE}/search/jkknet/`, { waitUntil: "domcontentloaded" });
    await save(page, "home_1_after");

    await page.goto(`${BASE}/search/jkknet/index.html`, { waitUntil: "domcontentloaded" });
    await save(page, "home_2");

    await page.goto(`${BASE}/search/jkknet/service/`, { waitUntil: "domcontentloaded" });
    await save(page, "home_2_after");

    // 2) StartInit へ（※リファラ付）
    await page.goto(`${BASE}/search/jkknet/service/akiyaJyoukenStartInit`, {
      waitUntil: "domcontentloaded",
      referer: `${BASE}/search/jkknet/service/`,
    });
    await save(page, "frameset_startinit");

    // 3) ポップアップ回避：forwardForm の target を _self に置き換えて submit
    const relay = await page.evaluate(() => {
      const f = document.forms?.forwardForm;
      if (!f) return "noform";
      f.target = "_self";
      f.submit();
      return "submitted";
    });
    console.log(`[relay] ${relay}`);
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await sleep(500);
    await save(page, "after_relay_1");

    // 4) 検索フォームがあるフレームを探す
    let formFrame = await findSearchFrame(page);
    if (!formFrame) {
      // もう一度待機して再スキャン
      await sleep(1500);
      formFrame = await findSearchFrame(page);
    }
    if (!formFrame) {
      await save(page, "final_error");
      throw new Error("検索フォームのフレームが見つかりませんでした。");
    }

    await save(await formFrame.page(), "before_fill");

    // 5) 住宅名(カナ) に「コーシャハイム」を入力 → 検索する
    await typeKanaNearLabel(formFrame, "コーシャハイム");
    await save(await formFrame.page(), "after_type_kana");

    await clickSearch(formFrame);

    // 6) 結果が描画されるまで軽く待つ → 保存
    await sleep(2000);
    await save(await formFrame.page(), "results");

    console.log("[done] success");
  } catch (e) {
    console.error("Error:", e.message || e);
    try { await save(page, "final_error"); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
