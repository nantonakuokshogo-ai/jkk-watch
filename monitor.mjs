// 追加：厳密な結果ページ判定
async function isResultPageStrict(p){
  return await p.evaluate(()=>{
    const t = document.body?.innerText || "";
    const hasCount   = /件が該当しました/.test(t);                     // 例: "78件が該当しました。"
    const hasHeading = /先着順あき家の検索結果/.test(t);
    const hasPager   = !!document.querySelector('[onclick*="movePagingInputGridPage"]');
    const hasDetail  = !!document.querySelector('a[onclick*="senPage"], img[alt="詳細"]');
    return hasCount || hasHeading || hasPager || hasDetail;
  });
}

// 置換：結果待機（先頭で厳密判定）
async function waitResultLike(p, timeoutMs = 25000){
  const deadline = Date.now() + timeoutMs;
  const urlLike = (u)=> /akiyaJyoukenRef|result|list|searchresult|_result|index\.php/i.test(u);
  while(Date.now() < deadline){
    await ensureViewport(p);
    if (await isResultPageStrict(p)) return "strict";
    const u = p.url();
    if (urlLike(u)) return `url(${u})`;
    const textHit = await p.evaluate(()=>/検索結果|該当件数|物件一覧|該当物件|空家情報/i.test(document.body?.innerText||""));
    if (textHit) return "text-hit";
    const selHit = await p.$('[class*="result"],[id*="result"],.search-result,.result-list,table.result');
    if (selHit) return "selector";
    await S(500);
  }
  throw new Error("結果待機がタイムアウトしました。");
}

// （任意・おすすめ）結果メタ保存：件数/URL/タイトルを out/result_meta.json に保存
// waitResultLike の直後に追記
const meta = await p.evaluate(()=>{
  const t = document.body?.innerText || "";
  const m = t.match(/(\d+)\s*件が該当しました/);
  return { count: m ? Number(m[1]) : null, url: location.href, title: document.title };
});
fs.writeFileSync(path.join(OUT, "result_meta.json"), JSON.stringify(meta, null, 2));
