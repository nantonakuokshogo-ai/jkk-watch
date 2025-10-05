// JKK: 「コーシャハイム」で検索して結果を拾う最小スクリプト
// 使い方: npm i && npx playwright install chromium && npm start
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const BASE = "https://jhomes.to-kousya.or.jp/"; // 入口（No.1/No.2で実績あり）
const KEYWORD = process.env.JKK_KEYWORD || "コーシャハイム";
const OUTDIR = "out";

async function ensureOut() {
  await fs.mkdir(OUTDIR, { recursive: true });
}

function stamp() {
  const z = (n)=>String(n).padStart(2,"0");
  const d = new Date();
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

async function saveShot(page, name) {
  await page.screenshot({ path: path.join(OUTDIR, `${name}.png`), fullPage: true });
}
async function saveHTML(page, name) {
  const html = await page.content();
  await fs.writeFile(path.join(OUTDIR, `${name}.html`), html, "utf-8");
}

async function gotoEntry(page) {
  // 入口は何度か転送することがあるので、堅めに待つ
  const res = await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45000 });
  if (!res) throw new Error("初期アクセスに失敗しました");
  await page.waitForLoadState("domcontentloaded");
}

async function findFreewordAndSearch(page, keyword) {
  // 1) まずページ内にフリーワード欄があればそれを使う
  const selectors = [
    'input[name*="free"]',
    'input[id*="free"]',
    'input[placeholder*="ワード"]',
    'input[placeholder*="フリー"]',
    'input[type="text"]'
  ];
  let found = null;
  for (const sel of selectors) {
    const cand = page.locator(sel).first();
    if (await cand.count()) {
      // 可視かつ有効なものを選びたい
      const vis = await cand.isVisible().catch(()=>false);
      if (vis) { found = cand; break; }
    }
  }

  // 2) 入口にない場合、検索ページへのリンクを探してクリック
  if (!found) {
    const linkTexts = ["空き家", "検索", "さがす", "住まい"];
    let clicked = false;
    for (const t of linkTexts) {
      const link = page.getByRole("link", { name: new RegExp(t) }).first();
      if (await link.count()) {
        await Promise.all([
          page.waitForLoadState("domcontentloaded"),
          link.click()
        ]);
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      // 最後の手段：hrefに search / result を含むリンク
      const alt = page.locator('a[href*="search"], a[href*="result"], a[href*="Ref"]');
      if (await alt.count()) {
        await Promise.all([
          page.waitForLoadState("domcontentloaded"),
          alt.first().click()
        ]);
      }
    }
    // 遷移先で再探索
    for (const sel of selectors) {
      const cand = page.locator(sel).first();
      if (await cand.count()) {
        const vis = await cand.isVisible().catch(()=>false);
        if (vis) { found = cand; break; }
      }
    }
  }

  if (!found) throw new Error("フリーワード入力欄が見つかりませんでした。");

  // 入力して「検索」実行
  await found.fill("");
  await found.type(keyword, { delay: 10 });

  // 「検索」系ボタンを探す
  const searchButtons = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("検索")',
    'a:has-text("検索")',
    'button:has-text("さがす")',
    'input[value*="検索"]'
  ];
  let clicked = false;
  for (const sel of searchButtons) {
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      const vis = await btn.isVisible().catch(()=>false);
      if (vis) {
        await Promise.all([
          page.waitForLoadState("domcontentloaded"),
          btn.click()
        ]);
        clicked = true;
        break;
      }
    }
  }
  if (!clicked) {
    // Enterキー送信のフォールバック
    await found.press("Enter");
    await page.waitForLoadState("domcontentloaded");
  }
}

function onlyDigits(s) {
  return (s || "").replace(/[^\d.]/g, "");
}

async function extractResults(page) {
  // 名前と詳細リンクだけ「まずは」取得（高望みしない版）
  const data = await page.evaluate(() => {
    const rows = [];
    const seen = new Set();

    // 候補リンク：onclick=senPage(...), hrefにdetail/result等
    const links = Array.from(document.querySelectorAll(
      'a[onclick*="senPage"], a[href*="detail"], a[href*="result"], a[href*="Ref"]'
    ));

    for (const a of links) {
      const name = (a.textContent || "").trim();
      const href = a.getAttribute("href") || "";
      const onclick = a.getAttribute("onclick") || "";
      const parent = a.closest("tr, .resultItem, .listItem, .housingList, li, div");
      const parentText = (parent ? parent.textContent : a.textContent || "").replace(/\s+/g, " ").trim();

      const key = name + "||" + href + "||" + onclick;
      if (seen.has(key)) continue;
      seen.add(key);

      // 絶対URL化はNode側でやる
      rows.push({
        name: name || null,
        href,
        onclick,
        snippet: parentText.slice(0, 300) // ざっくり周辺テキスト
      });
    }

    // 名前が何も無いものは除外
    return rows.filter(r => r.name || r.href || r.onclick);
  });

  // onclickからIDなどを拾ったり、URLを絶対化
  const abs = (href) => {
    try { return new URL(href, "https://jhomes.to-kousya.or.jp/").toString(); }
    catch { return null; }
  };

  const normalized = data.map(r => {
    const idFromOnclick = (r.onclick && /senPage\(([^)]+)\)/.exec(r.onclick))?.[1] || null;
    return {
      title: r.name || null,
      detail_url: r.href ? abs(r.href) : null,
      onclick: r.onclick || null,
      listing_id: idFromOnclick,
      snippet: r.snippet
    };
  });

  return normalized;
}

function toCSV(rows) {
  if (!rows.length) return "title,detail_url,listing_id\n";
  const header = Object.keys(rows[0]);
  const escape = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(header.map(k => escape(r[k])).join(","));
  }
  return lines.join("\n") + "\n";
}

async function main() {
  await ensureOut();
  const browser = await chromium.launch({
    headless: true,
    args: process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []
  });
  const ctx = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  const tag = `kosha_${stamp()}`;

  try {
    console.log(`[JKK] 入口へ… ${BASE}`);
    await gotoEntry(page);
    await saveShot(page, `${tag}_01_entry`);
    await saveHTML(page, `${tag}_01_entry`);

    console.log(`[JKK] フリーワード検索 → 「${KEYWORD}」`);
    await findFreewordAndSearch(page, KEYWORD);

    // 結果ページの証跡
    await page.waitForLoadState("domcontentloaded");
    await saveShot(page, `${tag}_02_result`);
    await saveHTML(page, `${tag}_02_result`);

    // ざっくり件数テキストも拾っておく（あれば）
    const countText = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("body *"))
        .find(e => /件.*該当|検索結果|物件一覧/.test(e.textContent || ""));
      return el ? el.textContent.trim().replace(/\s+/g, " ").slice(0, 80) : null;
    });
    if (countText) console.log(`[JKK] 件数らしき表示: ${countText}`);

    // 結果抽出（タイトル + 詳細URL）
    const items = await extractResults(page);
    console.log(`[JKK] 抽出: ${items.length} 件`);

    // 保存
    const jsonPath = path.join(OUTDIR, `${tag}_items.json`);
    const csvPath  = path.join(OUTDIR, `${tag}_items.csv`);
    await fs.writeFile(jsonPath, JSON.stringify({ keyword: KEYWORD, countText, items }, null, 2), "utf-8");
    await fs.writeFile(csvPath, toCSV(items), "utf-8");
    console.log(`[JKK] 保存: ${jsonPath}`);
    console.log(`[JKK] 保存: ${csvPath}`);
  } catch (err) {
    console.error("[JKK] 失敗:", err?.message || err);
    await saveShot(page, `${tag}_err`);
    await saveHTML(page, `${tag}_err`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
