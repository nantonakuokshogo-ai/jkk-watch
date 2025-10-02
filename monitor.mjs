// monitor.mjs
// Node20 + puppeteer-core v23 仕様 / 旧API(waitForTimeout等)非使用
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE_URL = process.env.BASE_URL ?? "https://jhomes.to-kousya.or.jp";
const KANA = process.env.KANA ?? "コーシャハイム";
const VIEWPORT_W = Number(process.env.VIEWPORT_W ?? 1440);
const VIEWPORT_H = Number(process.env.VIEWPORT_H ?? 2200);
const OUT_DIR = "out";

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function savePage(page, name) {
  await ensureDir(OUT_DIR);
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  await fs.writeFile(path.join(OUT_DIR, `${name}.html`), html, "utf8");
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
  console.log(`[saved] ${name}`);
}

function logFrames(page) {
  const frames = page.frames();
  console.log(`[frames] count=${frames.length}`);
  frames.forEach((f, i) => console.log(`[frame#${i}] name=${f.name() || "-"} url=${f.url()}`));
  return frames;
}

// 画面上のテキストに近い input を探して type する（label要素が無くてもOK）
async function typeByNearbyLabelAcrossFrames(page, labelText, value) {
  const frames = page.frames();
  for (const frame of frames) {
    const handle = await frame.evaluateHandle((text) => {
      // テキスト一致ノードを拾い、近傍/同セル/次セルから input を探索
      const snapshot = document.evaluate(
        `//*[contains(normalize-space(.), "${text}")]`,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      function findInputNear(el) {
        const q = 'input[type="text"], input:not([type]), input[type="search"]';
        // 直下
        let inp = el.querySelector(q);
        if (inp) return inp;
        // 同じ行/セルの次要素
        const cell = el.closest("td,th,div,li,label,dt,dd");
        if (cell?.nextElementSibling) {
          inp = cell.nextElementSibling.querySelector(q);
          if (inp) return inp;
        }
        // 親方向に数階層見てその配下
        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i++) {
          inp = p.querySelector(q);
          if (inp) return inp;
          p = p.parentElement;
        }
        // 兄弟要素を広く
        if (cell?.parentElement) {
          const sibs = Array.from(cell.parentElement.children);
          for (const s of sibs) {
            inp = s.querySelector(q);
            if (inp) return inp;
          }
        }
        return null;
      }
      for (let i = 0; i < snapshot.snapshotLength; i++) {
        const el = snapshot.snapshotItem(i);
        const target = findInputNear(el);
        if (target) return target;
      }
      return null;
    }, labelText);

    const el = handle.asElement();
    if (el) {
      await el.focus();
      // 既存値をクリアして入力
      await frame.evaluate((e) => (e.value = ""), el);
      await el.type(value, { delay: 20 });
      return { frame, element: el };
    } else {
      await handle.dispose();
    }
  }
  throw new Error(`${labelText} の入力欄が見つかりませんでした。`);
}

async function clickByTextAcrossFrames(page, text) {
  const frames = page.frames();
  for (const frame of frames) {
    // button / input[value] / a テキストを順に探索
    const clicked = await frame.evaluate((t) => {
      t = t.trim();
      const clickEl = (el) => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      };
      // input submit
      const inputs = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"]'));
      for (const i of inputs) {
        const v = (i.value || "").trim();
        if (v.includes(t)) return clickEl(i);
      }
      // button
      const btns = Array.from(document.querySelectorAll("button"));
      for (const b of btns) {
        const v = (b.textContent || "").trim();
        if (v.includes(t)) return clickEl(b);
      }
      // anchor
      const anchors = Array.from(document.querySelectorAll("a"));
      for (const a of anchors) {
        const v = (a.textContent || "").trim();
        if (v.includes(t)) return clickEl(a);
      }
      return false;
    }, text);
    if (clicked) return true;
  }
  return false;
}

async function waitForPopupFrom(page, nameHint = "JKKnet") {
  const popup = await page.waitForEvent("popup", { timeout: 15000 });
  await popup.bringToFront();
  // 名前が JKKnet の場合がある（HTML側 form.target 指定） :contentReference[oaicite:2]{index=2}
  console.log(`[popup] target=${popup.target()._targetInfo?.targetName ?? ""}`);
  return popup;
}

async function main() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (!executablePath) {
    console.error("Chromium/Chrome の実行パスが見つかりません（PUPPETEER_EXECUTABLE_PATH or CHROME_PATH）。setup-chrome の出力を参照してください。");
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: VIEWPORT_W, height: VIEWPORT_H },
  });

  const page = await browser.newPage();

  try {
    // 入口を段階的に踏む（直接 /service/… に行くと「おわび」に流れることがある） 
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await savePage(page, "home_1");

    await page.goto(`${BASE_URL}/search/jkknet/`, { waitUntil: "domcontentloaded" });
    await savePage(page, "home_1_after");

    // /service/ は onload で window.open して POST 送信する設計（JKK 側HTML）。:contentReference[oaicite:4]{index=4}
    await page.goto(`${BASE_URL}/search/jkknet/service/`, { waitUntil: "domcontentloaded" });
    await savePage(page, "home_2");

    // ポップアップを取得
    const popup = await waitForPopupFrom(page, "JKKnet");
    await savePage(page, "home_2_after");

    // frameset 初期画面を保存
    await savePage(popup, "frameset_startinit");
    logFrames(popup);

    // もし「おわび」画面に飛んでいたらそのまま保存して終了（次回調整用）
    const isOwabi = await popup.evaluate(() =>
      /おわび/.test(document.title || "") || document.body.innerText.includes("おわび")
    );
    if (isOwabi) {
      await savePage(popup, "final_error");
      throw new Error("「おわび」ページに遷移しました。入口フロー/Refererを再確認してください。");
    }

    // 目的フォームが別画面の場合があるので、「条件検索」/「検索」系リンクを事前に探して遷移
    // 既にフォームが見つかればスキップ
    let typed = false;
    try {
      await savePage(popup, "before_fill");
      await typeByNearbyLabelAcrossFrames(popup, "住宅名(カナ)", KANA);
      typed = true;
    } catch {
      // 移動を試す
      const moved =
        (await clickByTextAcrossFrames(popup, "条件検索")) ||
        (await clickByTextAcrossFrames(popup, "先着順")) ||
        (await clickByTextAcrossFrames(popup, "空家")) ||
        (await clickByTextAcrossFrames(popup, "検索"));
      if (moved) {
        // 画面更新待ち
        await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await savePage(popup, "before_fill");
        await typeByNearbyLabelAcrossFrames(popup, "住宅名(カナ)", KANA);
        typed = true;
      }
    }

    if (!typed) {
      await savePage(popup, "final_error");
      throw new Error("住宅名(カナ) の入力欄が見つかりませんでした。");
    }

    // 「検索する」をクリック
    const clicked = await clickByTextAcrossFrames(popup, "検索する");
    if (!clicked) {
      await savePage(popup, "final_error");
      throw new Error("「検索する」ボタンが見つかりませんでした。");
    }

    // 結果画面（テーブル等）を保存
    await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await savePage(popup, "result");

    console.log("[done] ✅ finished");
  } catch (e) {
    console.error(e);
    // 失敗時もとにかく何か残す
    try { await savePage(page, "final_error"); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
