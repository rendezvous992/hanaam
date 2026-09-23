/* 종목 발굴 — 올린 종목 표(CSV)나 관심 종목에 기준(52주 신고·신저가, 주가·거래량 동시 상승, 급등)을 적용해 걸러 본다 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const uniStore = K.collection("discover-universe");
  const watchStore = K.collection("watchlist");
  const UNI_ID = "universe";

  let session = { server: false };
  let uniRec = null; // { id, fileName, importedAt, importedBy, rows }
  let watchlist = [];
  let live = new Map(); // 종목코드 → 서버 시세
  let liveAt = "";
  let liveErr = "";
  const st = {
    source: K.prefs.get("discover.source", ""),
    market: K.prefs.get("discover.market", "all"),
    cap: K.prefs.get("discover.cap", "all"),
    screen: K.prefs.get("discover.screen", "high-low"),
    kind: K.prefs.get("discover.kind", "high"),
    view: K.prefs.get("discover.view", "screen"),
    sort: null,
    expanded: false,
  };

  /* ---------- 공통 도구 ---------- */
  function normMarket(m) {
    const s = String(m || "").toUpperCase();
    if (/KOSDAQ|코스닥|KQ/.test(s)) return "KOSDAQ";
    if (/KOSPI|코스피|유가|KS/.test(s)) return "KOSPI";
    if (/KONEX|코넥스/.test(s)) return "KONEX";
    return "";
  }
  const MARKET_LABEL = { KOSPI: "코스피", KOSDAQ: "코스닥", KONEX: "코넥스" };
  // 보통주만: ETF·ETN·리츠·우선주·스팩 제외
  const NOT_COMMON = /(우|우B|우C|\d우)$|스팩|SPAC|리츠|REIT|ETF|ETN|^(KODEX|TIGER|KBSTAR|RISE|ACE|SOL|HANARO|KOSEF|ARIRANG|PLUS|TIMEFOLIO|KIWOOM|히어로즈|마이다스|파워|TREX|BNK|WON|UNICORN|1Q|DAISHIN343|에셋플러스|FOCUS|VITA|KCGI|마이티)\b/i;
  function isCommon(r) {
    if (r.kind && /ETF|ETN|리츠|REIT|우선|스팩|SPAC/i.test(r.kind)) return false;
    return !NOT_COMMON.test(r.name || "");
  }
  function numOf(v) {
    if (v == null) return null;
    const s = String(v).replace(/[,%\s원배]/g, "").replace(/^\+/, "");
    if (s === "" || s === "-" || s === "N/A" || s === "—") return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }
  function normCode(v) {
    let s = String(v || "").trim().toUpperCase().replace(/^A(?=\d{6}$)/, "");
    if (/^\d{1,6}$/.test(s)) s = s.padStart(6, "0");
    return /^[0-9A-Z]{6}$/.test(s) ? s : "";
  }
  async function getJson(url) {
    const res = await fetch(url, { credentials: "same-origin", headers: { "X-Hana": "1" } });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && typeof data.detail === "string" && data.detail) || "서버 오류 (" + res.status + ")");
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  }
  const fmt = (v, d) => (v == null || isNaN(v) ? "—" : K.num(v, d));
  const pct = (v) => (v == null || isNaN(v) ? "—" : (v > 0 ? "+" : "") + K.num(v, 2) + "%");
  const dirCls = (v) => (v > 0 ? "hl__up" : v < 0 ? "hl__down" : "hl__flat");

  /* ---------- CSV 가져오기 ---------- */
  // 열 이름 → 필드 (앞에서부터 먼저 맞는 것)
  const COLS = [
    ["code", /^(종목코드|단축코드|코드|티커|code|ticker|symbol)$/],
    ["name", /^(종목명|종목|기업명|회사명|이름|name)$/],
    ["market", /^(시장|시장구분|market)$/],
    ["sector", /^(섹터|업종|업종명|테마|sector|industry)$/],
    ["kind", /^(구분|종류|증권구분|type)$/],
    ["cap", /^(시가총액|시총|marketcap|cap)/],
    ["per", /^per/],
    ["pbr", /^pbr/],
    ["roe", /^roe/],
    ["div", /^(배당수익률|배당|dividend|div)/],
    ["prevVolume", /^(전일거래량|prevvolume)/],
    ["value", /^(거래대금|value)/],
    ["volume", /^(거래량|volume)/],
    ["high52", /^(52주최고|52주고가|52주신고가|52주최고가|52whigh|high52)/],
    ["low52", /^(52주최저|52주저가|52주신저가|52주최저가|52wlow|low52)/],
    ["changeRate", /^(등락률|등락율|changerate|change%|chg%)/],
    ["price", /^(현재가|종가|주가|price|close)/],
    ["rs", /^(rs|상대강도)/],
  ];
  const FIELD_LABEL = { code: "종목코드", name: "종목명", market: "시장", sector: "섹터", cap: "시가총액", per: "PER", pbr: "PBR", roe: "ROE", div: "배당수익률", price: "현재가", changeRate: "등락률", volume: "거래량", prevVolume: "전일거래량", high52: "52주최고", low52: "52주최저", rs: "RS", value: "거래대금", kind: "구분" };
  const TEMPLATE = ["종목코드", "종목명", "시장", "섹터", "시가총액(억원)", "PER", "PBR", "ROE", "배당수익률", "현재가", "등락률", "거래량", "전일거래량", "52주최고", "52주최저", "RS"];

  function parseTable(text) {
    const rows = K.parseCsv(text);
    if (rows.length < 2) throw new Error("머리글과 자료가 있는 CSV 가 필요합니다.");
    const head = rows[0].map((h) => String(h).replace(/\s+/g, "").toLowerCase());
    const map = {};
    const capUnit = { mul: 1 };
    head.forEach((h, i) => {
      const bare = h.replace(/\(.*?\)|\[.*?\]/g, "");
      const hit = COLS.find(([k, re]) => map[k] == null && re.test(bare));
      if (!hit) return;
      map[hit[0]] = i;
      if (hit[0] === "cap") {
        if (/조/.test(h)) capUnit.mul = 10000;
        else if (/백만/.test(h)) capUnit.mul = 0.01;
        else if (/\(원\)|원\)$/.test(h) && !/억/.test(h)) capUnit.mul = 1e-8;
      }
    });
    if (map.name == null && map.code == null) throw new Error("종목명 또는 종목코드 열을 찾지 못했습니다. ‘양식 받기’의 머리글을 써 주세요.");
    const out = [];
    const seen = new Set();
    rows.slice(1).forEach((r) => {
      const get = (k) => (map[k] == null ? "" : String(r[map[k]] == null ? "" : r[map[k]]).trim());
      const rec = { code: normCode(get("code")), name: get("name") };
      if (!rec.name && !rec.code) return;
      if (!rec.name) rec.name = rec.code;
      const key = rec.code || rec.name;
      if (seen.has(key)) return;
      seen.add(key);
      if (get("market")) rec.market = normMarket(get("market")) || get("market");
      if (get("sector")) rec.sector = get("sector");
      if (get("kind")) rec.kind = get("kind");
      ["cap", "per", "pbr", "roe", "div", "price", "changeRate", "volume", "prevVolume", "high52", "low52", "rs", "value"].forEach((k) => {
        const v = numOf(get(k));
        if (v != null) rec[k] = v;
      });
      out.push(rec);
    });
    if (!out.length) throw new Error("가져올 종목이 없습니다.");
    // 시가총액이 원 단위로 보이면 억 원으로 바꾼다
    const caps = out.map((x) => x.cap).filter((v) => v != null).sort((a, b) => a - b);
    if (capUnit.mul === 1 && caps.length && caps[Math.floor(caps.length / 2)] > 1e9) capUnit.mul = 1e-8;
    if (capUnit.mul !== 1) out.forEach((x) => {
      if (x.cap != null) x.cap = Math.round(x.cap * capUnit.mul);
    });
    return { rows: out, fields: Object.keys(map) };
  }

  async function importFile(file) {
    let text;
    const buf = await file.arrayBuffer();
    text = new TextDecoder("utf-8").decode(buf);
    // 엑셀이 저장한 CP949(EUC-KR) CSV 면 다시 읽는다
    if (text.includes("�")) {
      try {
        text = new TextDecoder("euc-kr").decode(buf);
      } catch (e) {
        /* 그대로 */
      }
    }
    const { rows, fields } = parseTable(text);
    const rec = { fileName: file.name, importedAt: new Date().toISOString(), importedBy: K.currentUser(), fields, rows };
    if (uniRec) uniRec = await uniStore.update(uniRec.id, rec);
    else uniRec = await uniStore.create(Object.assign({ id: UNI_ID }, rec));
    st.source = "table";
    K.prefs.set("discover.source", "table");
    K.toast(rows.length.toLocaleString("ko-KR") + "종목을 가져왔습니다. (인식한 열: " + fields.map((f) => FIELD_LABEL[f]).join(", ") + ")");
  }

  /* ---------- 화면 뼈대: 데이터 도구 ---------- */
  const topbar = $(".topbar");
  const actions = document.createElement("div");
  actions.className = "topbar__actions";
  actions.innerHTML =
    '<div class="segmented" id="dsc-source" role="tablist" aria-label="데이터">' +
    '<button type="button" class="segmented__btn" data-source="table" role="tab">올린 표</button>' +
    '<button type="button" class="segmented__btn" data-source="watch" role="tab">관심 종목</button></div>' +
    '<button type="button" class="btn btn--primary btn--sm" id="dsc-import">CSV 가져오기</button>' +
    '<button type="button" class="btn btn--ghost btn--sm" id="dsc-template">양식 받기</button>' +
    '<button type="button" class="btn btn--ghost btn--sm" id="dsc-export">결과 내보내기</button>' +
    '<button type="button" class="btn btn--ghost btn--sm" id="dsc-clear">표 지우기</button>' +
    '<input type="file" id="dsc-file" accept=".csv,.tsv,.txt,text/csv" hidden>';
  topbar.appendChild(actions);
  const infoEl = document.createElement("p");
  infoEl.className = "hint";
  infoEl.id = "dsc-info";
  infoEl.style.margin = "-12px 0 16px";
  topbar.after(infoEl);
  // 요약(섹터 분포)은 결과 표 위에 둔다
  const summaryEl = document.createElement("div");
  summaryEl.className = "hl__summary";
  summaryEl.id = "dsc-summary";
  summaryEl.hidden = true;
  $("#dsc-result .card").before(summaryEl);

  /* ---------- 데이터 ---------- */
  function baseRows() {
    if (st.source === "watch") {
      const byCode = new Map(((uniRec && uniRec.rows) || []).map((r) => [r.code, r]));
      return watchlist.map((w) => Object.assign({}, byCode.get(w.code) || {}, { code: w.code || "", name: w.name, market: w.market || (byCode.get(w.code) || {}).market || "", sector: w.sector || (byCode.get(w.code) || {}).sector || "", watch: true }));
    }
    return (uniRec && uniRec.rows) || [];
  }
  function rowsWithLive() {
    const wset = new Set(watchlist.map((w) => w.code).filter(Boolean));
    return baseRows().map((r) => {
      const q = r.code && live.get(r.code);
      const o = Object.assign({}, r, { watch: r.watch || wset.has(r.code) });
      if (q && q.price != null) {
        o.price = q.price;
        if (q.changeRate != null) o.changeRate = q.changeRate;
        o.live = true;
      }
      return o;
    });
  }
  function has(rows, k) {
    return rows.some((r) => r[k] != null && r[k] !== "");
  }
  async function loadLive() {
    live = new Map();
    liveErr = "";
    liveAt = "";
    if (!session.server) return;
    const codes = Array.from(new Set(baseRows().map((r) => r.code).filter(Boolean)));
    if (!codes.length) return;
    const LIMIT = 1000;
    try {
      for (let i = 0; i < Math.min(codes.length, LIMIT); i += 100) {
        const data = await getJson("/api/quotes?codes=" + encodeURIComponent(codes.slice(i, i + 100).join(",")));
        (data.items || []).forEach((q) => live.set(q.code, q));
        liveAt = data.at || liveAt;
      }
      if (codes.length > LIMIT) liveErr = "실시간 시세는 앞 " + K.num(LIMIT) + "종목만 붙였습니다.";
    } catch (err) {
      liveErr = err.code === "not_connected" ? "시세 연결 안 됨 · " + err.message : "시세를 불러오지 못했습니다 · " + err.message;
    }
  }

  /* ---------- 기준 ---------- */
  const SCREENS = {
    "high-low": { title: "52주 신고·신저가", need: ["price", "high52", "low52", "changeRate"] },
    volume: { title: "주가와 거래량 동시 상승", need: ["changeRate", "volume", "prevVolume"] },
    movers: { title: "오늘의 급등 종목", need: ["changeRate"] },
  };
  // 시장·시가총액 상한 (상단 필터)
  function baseFilter(rows) {
    const capCol = has(rows, "cap");
    return rows.filter((r) => {
      if (st.market !== "all" && normMarket(r.market) !== st.market.toUpperCase()) return false;
      if (st.cap !== "all" && capCol && !(r.cap != null && r.cap <= Number(st.cap))) return false;
      return true;
    });
  }
  // 기준 적용: { ok, rows, missing, chips, high, low }
  function evaluate(screen, all, kindOverride) {
    const sc = SCREENS[screen];
    const rows = baseFilter(all);
    const missing = sc.need.filter((k) => !has(all, k));
    const capCol = has(all, "cap");
    const rsCol = has(all, "rs");
    const chips = ["보통주만 (ETF·리츠·우선주·스팩 제외)"];
    if (st.market !== "all") chips.push(MARKET_LABEL[st.market.toUpperCase()]);
    if (st.cap !== "all") chips.push(capCol ? "시가총액 " + K.num(Number(st.cap)) + "억 이하" : "시가총액 열 없음 — 상한 생략");
    chips.push(capCol ? "시가총액 1,000억 원 이상" : "시가총액 열 없음 — 1,000억 조건 생략");
    if (missing.length) return { ok: false, rows: [], missing, chips };
    const common = rows.filter(isCommon).filter((r) => !capCol || (r.cap != null && r.cap >= 1000));
    if (screen === "high-low") {
      const high = common.filter((r) => r.price != null && r.high52 != null && r.price >= r.high52 && r.changeRate >= 3 && (!rsCol || (r.rs != null && r.rs >= 70)));
      const low = common.filter((r) => r.price != null && r.low52 != null && r.price <= r.low52 && r.changeRate <= -3 && (!rsCol || (r.rs != null && r.rs <= 30)));
      const kind = kindOverride || st.kind;
      chips.push(kind === "high" ? "현재가 ≥ 52주 최고가" : "현재가 ≤ 52주 최저가", kind === "high" ? "등락률 +3% 이상" : "등락률 −3% 이하");
      chips.push(rsCol ? (kind === "high" ? "RS 70 이상" : "RS 30 이하") : "RS 열 없음 — RS 조건 생략");
      return { ok: true, rows: kind === "high" ? high : low, high, low, chips };
    }
    if (screen === "volume") {
      chips.push("등락률 +3% 이상", "거래량 전일의 2배 이상");
      return { ok: true, rows: common.filter((r) => r.changeRate >= 3 && r.volume != null && r.prevVolume > 0 && r.volume >= r.prevVolume * 2), chips };
    }
    chips.push("등락률 +3% 이상, 높은 순");
    return { ok: true, rows: common.filter((r) => r.changeRate >= 3).sort((a, b) => b.changeRate - a.changeRate), chips };
  }

  /* ---------- 그리기 ---------- */
  function renderInfo(all) {
    const parts = [];
    if (st.source === "table") {
      if (uniRec) parts.push("올린 표: " + esc(uniRec.fileName || "CSV") + " · " + K.num(uniRec.rows.length) + "종목 · " + esc(K.isoKst(uniRec.importedAt)) + (uniRec.importedBy ? " · " + esc(uniRec.importedBy) : ""));
      else parts.push("아직 올린 종목 표가 없습니다. <strong>CSV 가져오기</strong>로 종목코드·종목명·시장·섹터·시가총액·PER·PBR·ROE·등락률·거래량·52주 최고/최저 등이 담긴 표를 올리세요.");
    } else {
      parts.push("관심 종목 " + K.num(watchlist.length) + "개 기준" + (watchlist.length ? "" : " — <a href=\"/market/\">시장</a> 페이지에서 관심 종목을 추가하세요") + (uniRec ? " · 올린 표의 재무 지표를 함께 씁니다" : ""));
    }
    if (!session.server) parts.push("브라우저 저장 모드: 실시간 시세는 서버 모드에서 붙습니다. 표에 적힌 값으로 계산합니다.");
    else if (liveErr) parts.push(esc(liveErr) + " · 표에 적힌 값으로 계산합니다.");
    else if (live.size) parts.push("실시간 시세 " + K.num(live.size) + "종목 반영 (" + esc(K.isoKst(liveAt).slice(11)) + " KST)");
    infoEl.innerHTML = parts.join(" · ");
    $$("#dsc-source .segmented__btn").forEach((b) => {
      const on = b.getAttribute("data-source") === st.source;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
      const n = b.getAttribute("data-source") === "table" ? (uniRec ? uniRec.rows.length : 0) : watchlist.length;
      b.textContent = (b.getAttribute("data-source") === "table" ? "올린 표" : "관심 종목") + " " + K.num(n);
    });
    $("#dsc-clear").style.display = uniRec ? "" : "none";
  }

  function renderCards(all) {
    $$("#dsc-grid .dsc__card").forEach((card) => {
      const key = card.getAttribute("data-screen");
      const sel = key === st.screen;
      card.classList.toggle("is-selected", sel);
      card.setAttribute("aria-selected", String(sel));
      const foot = $(".dsc__foot", card);
      if (!all.length) {
        card.classList.add("dsc__card--failed");
        foot.innerHTML = "<span>" + (st.source === "table" ? "종목 표를 올리면 계산합니다" : "관심 종목이 없습니다") + "</span>";
        return;
      }
      const res = evaluate(key, all, "high");
      card.classList.toggle("dsc__card--failed", !res.ok);
      if (!res.ok) {
        foot.innerHTML = "<span>필요한 열 없음: " + esc(res.missing.map((k) => FIELD_LABEL[k]).join(", ")) + "</span>";
        return;
      }
      if (key === "high-low") {
        const n = res.high.length + res.low.length;
        const names = res.high.concat(res.low).slice(0, 4).map((r) => r.name).join(", ");
        foot.innerHTML = '<span class="dsc__count">' + n + '</span><span>종목</span><span class="dsc__names">' + esc(names) + "</span>" +
          '<span class="dsc__split"><b class="dsc__high">' + res.high.length + '</b> 신고 · <b class="dsc__low">' + res.low.length + "</b> 신저</span>";
      } else {
        foot.innerHTML = '<span class="dsc__count">' + res.rows.length + '</span><span>종목</span><span class="dsc__names">' + esc(res.rows.slice(0, 5).map((r) => r.name).join(", ")) + "</span>";
      }
    });
  }

  function columns(rows) {
    const cols = [["name", "종목"]];
    if (has(rows, "sector")) cols.push(["sector", "섹터"]);
    cols.push(["price", "현재가"], ["changeRate", "등락률"]);
    if (st.view === "screen" && st.screen === "high-low") cols.push([st.kind === "high" ? "high52" : "low52", st.kind === "high" ? "52주 최고" : "52주 최저"]);
    if (has(rows, "volume")) cols.push(["volume", "거래량"]);
    if (has(rows, "volume") && has(rows, "prevVolume")) cols.push(["volRatio", "전일 대비"]);
    [["cap", "시가총액(억)"], ["per", "PER"], ["pbr", "PBR"], ["roe", "ROE"], ["div", "배당"], ["rs", "RS"]].forEach((c) => {
      if (has(rows, c[0])) cols.push(c);
    });
    return cols;
  }
  function cell(r, k) {
    switch (k) {
      case "name":
        return '<td class="hl__name"><b>' + esc(r.name) + '</b><span class="hl__code">' + esc([r.code, MARKET_LABEL[normMarket(r.market)] || ""].filter(Boolean).join(" · ")) + "</span>" + (r.watch ? ' <span class="hl__flag">관심</span>' : "") + "</td>";
      case "sector":
        return '<td class="hl__theme hl__dim">' + esc(r.sector || "—") + "</td>";
      case "price":
        return '<td class="hl__n">' + fmt(r.price) + (r.live ? "" : r.price != null ? ' <span class="hl__dim" title="올린 표 값">*</span>' : "") + "</td>";
      case "changeRate":
        return '<td class="hl__n ' + dirCls(r.changeRate) + '">' + pct(r.changeRate) + "</td>";
      case "volRatio":
        return '<td class="hl__n">' + (r.volRatio == null ? "—" : K.num(r.volRatio, 1) + "배") + "</td>";
      case "roe":
      case "div":
        return '<td class="hl__n">' + (r[k] == null ? "—" : K.num(r[k], 1) + "%") + "</td>";
      case "per":
      case "pbr":
        return '<td class="hl__n">' + fmt(r[k], k === "pbr" ? 2 : 1) + "</td>";
      default:
        return '<td class="hl__n">' + fmt(r[k]) + "</td>";
    }
  }
  function defaultSort() {
    if (st.view === "raw") return { key: has(rowsWithLive(), "cap") ? "cap" : "name", dir: has(rowsWithLive(), "cap") ? -1 : 1 };
    if (st.screen === "volume") return { key: "volRatio", dir: -1 };
    if (st.screen === "high-low" && st.kind === "low") return { key: "changeRate", dir: 1 };
    return { key: "changeRate", dir: -1 };
  }

  function renderResult(all) {
    const sc = SCREENS[st.screen];
    const res = st.view === "raw" ? { ok: true, rows: baseFilter(all), chips: [] } : evaluate(st.screen, all);
    $("#dsc-result-title").textContent = st.view === "raw" ? "전체 목록" : sc.title + (st.screen === "high-low" ? (st.kind === "high" ? " · 신고가" : " · 신저가") : "");
    $("#dsc-stamp").textContent = live.size && liveAt ? K.isoKst(liveAt).slice(11) + " 기준" : uniRec && st.source === "table" ? K.md(K.isoKst(uniRec.importedAt).slice(0, 10)) + " 올린 표 기준" : "";
    $("#dsc-meta").textContent = res.ok ? K.num(res.rows.length) + "종목 / 전체 " + K.num(all.length) : "";
    $$("#dsc-extra [data-kind]").forEach((b) => {
      b.classList.toggle("is-active", b.getAttribute("data-kind") === st.kind);
      b.setAttribute("aria-selected", String(b.getAttribute("data-kind") === st.kind));
    });
    $("#dsc-extra [data-kind]").parentElement.style.display = st.screen !== "high-low" || st.view === "raw" ? "none" : "";
    $$("#dsc-extra [data-view]").forEach((b) => {
      b.classList.toggle("is-active", b.getAttribute("data-view") === st.view);
      b.setAttribute("aria-selected", String(b.getAttribute("data-view") === st.view));
    });
    const body = $("#dsc-body");
    summaryEl.hidden = true;
    if (!all.length) {
      body.innerHTML = '<p class="card__empty">' + (st.source === "table"
        ? "아직 올린 종목 표가 없습니다. 오른쪽 위 <b>CSV 가져오기</b>로 표를 올리거나 ‘관심 종목’으로 바꿔 보세요."
        : "관심 종목이 없습니다. <a href=\"/market/\">시장</a> 페이지나 <a href=\"/company/\">종목 분석</a>에서 관심 종목을 추가하세요.") + "</p>";
      return;
    }
    if (!res.ok) {
      body.innerHTML = '<div class="dsc__conditions">' + res.chips.map((c) => '<span class="dsc__chip">' + esc(c) + "</span>").join("") + "</div>" +
        '<p class="card__empty">이 기준에 필요한 열(' + esc(res.missing.map((k) => FIELD_LABEL[k]).join(", ")) + ")이 없습니다." +
        (session.server ? "" : " 현재가·등락률은 서버 모드에서 시세로 채워집니다.") + " ‘전체 목록’으로 올린 표를 볼 수 있습니다.</p>";
      return;
    }
    const rows = res.rows.map((r) => Object.assign({}, r, { volRatio: r.volume != null && r.prevVolume > 0 ? r.volume / r.prevVolume : null }));
    const s = st.sort || defaultSort();
    rows.sort((a, b) => {
      const x = a[s.key];
      const y = b[s.key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y, "ko") : x - y) * s.dir;
    });
    renderSummary(rows);
    const cols = columns(all);
    const LIMIT = 50;
    const shown = st.expanded ? rows : rows.slice(0, LIMIT);
    body.innerHTML =
      (res.chips.length ? '<div class="dsc__conditions">' + res.chips.map((c) => '<span class="dsc__chip">' + esc(c) + "</span>").join("") + "</div>" : "") +
      (rows.length
        ? '<div style="overflow-x:auto"><table class="hl__table"><thead><tr>' + cols.map(([k, label], i) =>
          "<th" + (k === "sector" ? ' class="hl__theme"' : "") + ' scope="col"><button type="button" class="dsc__sort' + (s.key === k ? " is-sorted" : "") + '" data-sort="' + k + '">' + esc(label) +
          '<span class="dsc__caret' + (s.key === k && s.dir > 0 ? " dsc__caret--up" : "") + '"></span></button></th>'
        ).join("") + "</tr></thead><tbody>" +
          shown.map((r) => '<tr class="hl__row" tabindex="0" data-code="' + esc(r.code) + '" data-name="' + esc(r.name) + '">' + cols.map(([k]) => cell(r, k)).join("") + "</tr>").join("") +
          "</tbody></table></div>" +
          (rows.length > LIMIT ? '<p style="text-align:center;margin:12px 0 0"><button type="button" class="dsc__toggle" aria-expanded="' + st.expanded + '" data-expand>' +
            (st.expanded ? "접기" : "전체 " + K.num(rows.length) + "종목 보기") + '<span class="dsc__caret"></span></button></p>' : "") +
          (rows.some((r) => !r.live && r.price != null) ? '<p class="hint" style="margin-top:8px;font-size:12px">* 표시는 올린 표에 적힌 값입니다 (실시간 시세 아님).</p>' : "")
        : '<p class="card__empty">조건을 통과한 종목이 없습니다.</p>');
  }

  // 섹터 분포: 통과 종목이 어느 섹터에 몰렸는지
  function renderSummary(rows) {
    if (!rows.length || !has(rows, "sector")) return;
    const g = new Map();
    rows.forEach((r) => {
      const k = r.sector || "기타";
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(r);
    });
    const list = Array.from(g.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 8);
    const max = list[0][1].length;
    const down = st.view === "screen" && st.screen === "high-low" && st.kind === "low";
    summaryEl.className = "hl__summary " + (st.view === "raw" ? "" : down ? "hl__summary--down" : "hl__summary--up");
    summaryEl.innerHTML = '<p class="hint" style="margin-bottom:8px"><strong>섹터 분포</strong> · 비중 · 종목 수 · 평균 등락률</p><div class="hl__chart">' + list.map(([name, rs]) => {
      const rates = rs.map((r) => r.changeRate).filter((v) => v != null);
      const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
      return '<div class="hl__bar"><span class="hl__bar-name" title="' + esc(name) + '">' + esc(name) + '</span><span class="hl__bar-track"><span class="hl__bar-fill" style="width:' + Math.round((rs.length / max) * 100) + '%"></span></span>' +
        '<span class="hl__bar-share">' + Math.round((rs.length / rows.length) * 100) + '%</span><span class="hl__bar-n">' + rs.length + '종목</span><span class="hl__bar-avg ' + dirCls(avg) + '">' + pct(avg) + "</span></div>";
    }).join("") + "</div>";
    summaryEl.hidden = false;
  }

  function render() {
    const all = rowsWithLive();
    $$(".dsc__controls [data-market]").forEach((b) => b.classList.toggle("is-active", b.getAttribute("data-market") === st.market));
    $$(".dsc__controls [data-cap]").forEach((b) => b.classList.toggle("is-active", b.getAttribute("data-cap") === st.cap));
    renderInfo(all);
    renderCards(all);
    renderResult(all);
  }

  /* ---------- 이벤트 ---------- */
  function setPref(k, v) {
    st[k] = v;
    K.prefs.set("discover." + k, v);
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button, tr.hl__row");
    if (!b) return;
    if (b.matches("[data-market]")) {
      setPref("market", b.getAttribute("data-market"));
    } else if (b.matches("[data-cap]")) {
      setPref("cap", b.getAttribute("data-cap"));
    } else if (b.matches(".dsc__card")) {
      setPref("screen", b.getAttribute("data-screen"));
      setPref("view", "screen");
      st.sort = null;
      st.expanded = false;
    } else if (b.matches("[data-kind]")) {
      setPref("kind", b.getAttribute("data-kind"));
      st.sort = null;
    } else if (b.matches("[data-view]")) {
      setPref("view", b.getAttribute("data-view"));
      st.sort = null;
      st.expanded = false;
    } else if (b.matches("[data-sort]")) {
      const k = b.getAttribute("data-sort");
      const cur = st.sort || defaultSort();
      st.sort = { key: k, dir: cur.key === k ? -cur.dir : k === "name" || k === "sector" ? 1 : -1 };
    } else if (b.matches("[data-expand]")) {
      st.expanded = !st.expanded;
    } else if (b.matches("[data-source]")) {
      setPref("source", b.getAttribute("data-source"));
      st.sort = null;
      render();
      await loadLive();
    } else if (b.matches("tr.hl__row")) {
      const code = b.getAttribute("data-code");
      location.href = "/company/?" + (code ? "code=" + encodeURIComponent(code) : "q=" + encodeURIComponent(b.getAttribute("data-name")));
      return;
    } else if (b.id === "dsc-import") {
      $("#dsc-file").click();
      return;
    } else if (b.id === "dsc-template") {
      K.saveText("종목표_양식.csv", K.toCsv([TEMPLATE]), "text/csv;charset=utf-8");
      return;
    } else if (b.id === "dsc-export") {
      exportResult();
      return;
    } else if (b.id === "dsc-clear") {
      if (!uniRec || !(await K.confirm("올린 종목 표(" + (uniRec.fileName || "CSV") + ")를 지울까요?\n다른 사람도 이 표를 함께 씁니다.", "지우기", true))) return;
      try {
        await uniStore.remove(uniRec.id);
        uniRec = null;
        live = new Map();
        K.toast("올린 표를 지웠습니다.");
      } catch (err) {
        K.toast(err.message, true);
      }
    } else return;
    render();
  });
  document.addEventListener("keydown", (e) => {
    const tr = e.target.closest && e.target.closest("tr.hl__row");
    if (tr && e.key === "Enter") tr.click();
  });
  $("#dsc-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      await importFile(file);
      st.sort = null;
      render();
      await loadLive();
      render();
    } catch (err) {
      K.toast("가져오지 못했습니다: " + err.message, true);
    }
  });

  function exportResult() {
    const all = rowsWithLive();
    const res = st.view === "raw" ? { ok: true, rows: baseFilter(all) } : evaluate(st.screen, all);
    if (!res.ok || !res.rows.length) return K.toast("내보낼 종목이 없습니다.", true);
    const keys = ["code", "name", "market", "sector", "price", "changeRate", "volume", "prevVolume", "high52", "low52", "cap", "per", "pbr", "roe", "div", "rs"].filter((k) => has(res.rows, k));
    const rows = [keys.map((k) => FIELD_LABEL[k])].concat(res.rows.map((r) => keys.map((k) => (k === "market" ? MARKET_LABEL[normMarket(r[k])] || r[k] || "" : r[k] == null ? "" : r[k]))));
    K.saveText("종목발굴_" + K.today() + ".csv", K.toCsv(rows), "text/csv;charset=utf-8");
  }

  (async function init() {
    session = await K.session();
    $("#dsc-body").innerHTML = '<p class="card__empty">불러오는 중…</p>';
    const [uni, wl] = await Promise.all([uniStore.list().catch(() => []), watchStore.list().catch(() => [])]);
    uniRec = (uni || []).find((x) => Array.isArray(x.rows)) || null;
    watchlist = Array.isArray(wl) ? wl : [];
    if (st.source !== "table" && st.source !== "watch") st.source = uniRec ? "table" : "watch";
    if (!SCREENS[st.screen]) st.screen = "high-low";
    render();
    await loadLive();
    render();
  })();
})();
