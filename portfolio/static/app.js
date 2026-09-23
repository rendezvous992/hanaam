/* 포트폴리오 분석 — 보유 종목 파일(XLSX·CSV)을 올려 비중·평가금액·손익·수익률·섹터·기여도를 계산한다.
 * 서버 모드: 모음 "portfolio"(portfolio 권한자 공용)에 저장, /api/quotes 로 네이버 현재가를 받는다.
 * 브라우저 모드: 이 브라우저에 저장, 파일의 현재가·전일종가(또는 직접 입력한 값)로 계산한다. */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const store = K.collection("portfolio");
  const root = $(".fr-dashboard2");
  if (!root) return;

  const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  const INDEXES = ["KOSPI", "KOSDAQ", "KPI200"];
  const COLORS = { fund: "#00857b", bm: "#c98a34", kospi: "#64748b", kosdaq: "#5b7bd5" };

  let session = { server: false, me: null, api: null };
  let list = [];
  let current = null; // 선택한 포트폴리오 기록
  let quotes = {}; // code → 시세
  let quoteAt = "";
  let quoteError = "";
  let calc = null; // 계산 결과
  let lastNavWrite = 0;
  let timer = null;

  /* ---------- 표 컬럼 정의 ---------- */
  // t: text | pct(%) | pp(%p) | won | num  · s: 부호 표시 · h: 배경 막대
  const C = {
    order: { l: "순서", m: "#", t: "int" },
    rank: { l: "순위", m: "#", t: "int" },
    ticker: { l: "종목코드", m: "코드", t: "text" },
    sector: { l: "섹터", m: "업종", t: "text" },
    name: { l: "종목명", m: "종목", t: "text" },
    count: { l: "종목수", m: "수", t: "int" },
    contribution_pct: { l: "기여도", m: "기여", t: "pp", s: 1, h: 1, tip: "종목 평가손익 ÷ 총 매입금액 (%p). 모두 더하면 포트폴리오 수익률" },
    ret_pct: { l: "수익률", m: "수익", t: "pct", s: 1, h: 1, tip: "평가손익 ÷ 매입금액" },
    change_pct: { l: "당일", m: "당일", t: "pct", s: 1, h: 1, arrow: 1, tip: "전일 대비 등락률" },
    day_contribution_pct: { l: "당일 기여", m: "당기", t: "pp", s: 1, h: 1, d: 3, tip: "비중 × 당일 등락률 (%p)" },
    fund_pct: { l: "비중", m: "F", t: "pct", h: 1, tip: "평가금액 ÷ 총평가금액" },
    bm_pct: { l: "BM", m: "BM", t: "pct", h: 1, bm: 1, tip: "파일의 BM 비중을 100%로 맞춘 값" },
    active_pct: { l: "A.Bet", m: "A", t: "pp", s: 1, h: 1, bm: 1, tip: "비중 − BM 비중" },
    qty: { l: "수량", m: "수량", t: "num" },
    avg: { l: "평균단가", m: "평단", t: "won" },
    price: { l: "현재가", m: "현재", t: "won" },
    cost: { l: "매입금액", m: "매입", t: "won", h: 1 },
    value: { l: "평가금액", m: "평가", t: "won", h: 1 },
    pnl: { l: "평가손익", m: "손익", t: "won", s: 1, h: 1 },
    difference_pct: { l: "차이 %", m: "차이", t: "pp", s: 1, h: 1, bm: 1, tip: "섹터 비중 − BM 섹터 비중" },
    sector_ret_pct: { l: "섹터 수익률", m: "수익", t: "pct", s: 1, h: 1 },
    fund_sector_return_pct: { l: "펀드 섹터", m: "F섹", t: "pct", s: 1, h: 1, tip: "섹터 안 보유 종목의 당일 수익률" },
    bm_sector_return_pct: { l: "BM 섹터", m: "BM섹", t: "pct", s: 1, h: 1, bm: 1, tip: "섹터 안 BM 종목의 당일 수익률" },
    allocation_contribution_pct: { l: "배분 기여도", m: "배분", t: "pp", s: 1, h: 1, bm: 1, d: 3, tip: "(섹터 비중 − BM 섹터 비중) × (BM 섹터 수익률 − BM 수익률)" },
    fund_contribution_pct: { l: "펀드 기여도", m: "F기", t: "pp", s: 1, h: 1, d: 3, tip: "섹터 비중 × 펀드 섹터 당일 수익률" },
    bm_contribution_pct: { l: "BM 기여도", m: "BM기", t: "pp", s: 1, h: 1, bm: 1, d: 3, tip: "BM 섹터 비중 × BM 섹터 당일 수익률" },
    active_contribution_pct: { l: "순수 기여도", m: "순수", t: "pp", s: 1, h: 1, bm: 1, d: 3, tip: "펀드 기여도 − BM 기여도" },
  };
  const TABLES = {
    "fr-pure-tbl": {
      cols: ["order", "ticker", "sector", "name", "contribution_pct", "ret_pct", "fund_pct", "bm_pct", "active_pct", "change_pct", "day_contribution_pct", "qty", "avg", "price", "value", "pnl"],
      sort: ["fund_pct", false], fav: true, row: true,
    },
    "fr-top-contrib-tbl": { cols: ["rank", "ticker", "sector", "name", "contribution_pct", "ret_pct", "fund_pct", "bm_pct", "active_pct", "change_pct", "pnl"], sort: ["contribution_pct", false], row: true },
    "fr-bottom-contrib-tbl": { cols: ["rank", "ticker", "sector", "name", "contribution_pct", "ret_pct", "fund_pct", "bm_pct", "active_pct", "change_pct", "pnl"], sort: ["contribution_pct", true], row: true },
    "fr-sector-live-tbl": {
      cols: ["rank", "sector", "count", "fund_pct", "bm_pct", "difference_pct", "value", "pnl", "sector_ret_pct", "contribution_pct", "fund_sector_return_pct", "bm_sector_return_pct",
        "allocation_contribution_pct", "fund_contribution_pct", "bm_contribution_pct", "active_contribution_pct"],
      sort: ["fund_pct", false],
    },
    "fr-watch-tbl": { cols: ["ticker", "sector", "name", "price", "change_pct", "ret_pct", "fund_pct", "contribution_pct", "value", "pnl"], sort: ["fund_pct", false], fav: true, row: true },
  };
  const colPref = (id) => "portfolio.cols." + id;
  const sortState = {};
  Object.keys(TABLES).forEach((id) => {
    const saved = K.prefs.get(colPref(id), null);
    const base = TABLES[id].cols;
    // 저장된 순서에 없는(새로 생긴) 컬럼은 뒤에 붙인다
    TABLES[id].order = Array.isArray(saved) ? saved.filter((c) => base.includes(c)).concat(base.filter((c) => !saved.includes(c))) : base.slice();
    sortState[id] = K.prefs.get("portfolio.sort." + id, TABLES[id].sort);
  });

  /* ---------- 숫자·글자 ---------- */
  function toNum(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    let s = String(v).trim().replace(/[,\s원주₩%]/g, "");
    let neg = false;
    if (/^\(.*\)$/.test(s)) {
      neg = true;
      s = s.slice(1, -1);
    }
    if (!s || s === "-" || !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return null;
    const n = Number(s);
    return isFinite(n) ? (neg ? -n : n) : null;
  }
  function normCode(v) {
    let s = String(v == null ? "" : v).trim().toUpperCase().replace(/\.0+$/, "");
    s = s.replace(/^A(?=[0-9A-Z]{6}$)/, "");
    if (/^\d{1,6}$/.test(s)) s = s.padStart(6, "0");
    return /^[0-9A-Z]{6}$/.test(s) ? s : "";
  }
  function fmt(v, key) {
    const c = C[key] || {};
    if (v == null || v === "" || (typeof v === "number" && !isFinite(v))) return "—";
    if (c.t === "text") return esc(v);
    if (c.t === "int") return esc(v);
    const n = Number(v);
    let d = c.d != null ? c.d : c.t === "won" || c.t === "num" ? 0 : 2;
    if (c.t === "num" && Math.abs(n % 1) > 1e-9) d = 2;
    let s = Math.abs(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
    const zero = Number(s.replace(/,/g, "")) === 0;
    const sign = n < 0 && !zero ? "-" : c.s && n > 0 && !zero ? "+" : "";
    if (c.t === "pct") s += "%";
    return sign + s;
  }
  function pctText(v, digits) {
    if (v == null || !isFinite(v)) return "—";
    const s = Math.abs(v).toFixed(digits == null ? 2 : digits);
    return (v > 0 && Number(s) ? "+" : v < 0 && Number(s) ? "-" : "") + s + "%";
  }
  function sideClass(v) {
    return v == null || !isFinite(v) || Math.abs(v) < 1e-9 ? "" : v > 0 ? "fr-pos" : "fr-neg";
  }
  function won(v) {
    return v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString("ko-KR") + "원";
  }
  function bigWon(v) {
    if (v == null || !isFinite(v)) return "—";
    const a = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    if (a >= 1e8) return sign + (a / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 2 }) + "억원";
    if (a >= 1e4) return sign + Math.round(a / 1e4).toLocaleString("ko-KR") + "만원";
    return sign + Math.round(a).toLocaleString("ko-KR") + "원";
  }
  function hue(s) {
    let h = 0;
    for (const ch of String(s || "")) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }
  function kstTime(iso) {
    const t = Date.parse(iso || "");
    if (isNaN(t)) return K.nowTime();
    const d = new Date(t + 9 * 3600 * 1000);
    return K.pad(d.getUTCHours()) + ":" + K.pad(d.getUTCMinutes());
  }
  function kstDate(iso) {
    const t = Date.parse(iso || "");
    return isNaN(t) ? K.today() : K.ymd(new Date(t + 9 * 3600 * 1000));
  }

  /* ---------- 파일 읽기 ---------- */
  let xlsxPromise = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxPromise) {
      xlsxPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = XLSX_URL;
        s.async = true;
        s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error("엑셀 읽기 도구를 불러오지 못했습니다.")));
        s.onerror = () => {
          xlsxPromise = null;
          s.remove();
          reject(new Error("엑셀 읽기 도구(SheetJS)를 내려받지 못했습니다. 인터넷 연결을 확인하거나 CSV로 저장해 올려 주세요."));
        };
        document.head.appendChild(s);
      });
    }
    return xlsxPromise;
  }
  function decodeText(buf) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch (e) {
      // 한글 엑셀이 저장한 CSV(EUC-KR)
      try {
        return new TextDecoder("euc-kr").decode(buf);
      } catch (err) {
        return new TextDecoder("utf-8").decode(buf);
      }
    }
  }
  async function readRows(file) {
    const buf = await file.arrayBuffer();
    const isCsv = /\.(csv|txt|tsv)$/i.test(file.name) || /^text\//.test(file.type);
    if (isCsv) return [K.parseCsv(decodeText(buf))];
    const XLSX = await loadXlsx();
    const wb = XLSX.read(buf, { type: "array" });
    return wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }));
  }

  // 머리글 이름 → 필드 (앞의 것이 우선)
  const HEAD = [
    ["bm", ["bm비중", "bm", "벤치마크비중", "벤치마크", "bm weight", "bmweight", "지수비중"]],
    ["code", ["종목코드", "코드", "단축코드", "티커", "ticker", "code", "종목번호", "symbol"]],
    ["name", ["종목명", "종목", "이름", "name", "종목이름", "한글종목명"]],
    ["qty", ["수량", "보유수량", "주식수", "잔고수량", "보유주식수", "quantity", "qty", "shares"]],
    ["avg", ["평균단가", "매입단가", "평단", "평단가", "매입가", "평균매입가", "매수단가", "취득단가", "avgprice", "avg", "costprice"]],
    ["cost", ["매입금액", "매수금액", "취득금액", "장부금액", "투자금액", "cost", "costamount"]],
    ["sector", ["섹터", "업종", "업종구분", "업종명", "wics", "wics소분류", "sector", "산업"]],
    ["prevClose", ["전일종가", "전일가", "전일", "기준가", "prevclose", "previousclose"]],
    ["price", ["현재가", "종가", "시가", "현재주가", "price", "currentprice", "last"]],
    ["value", ["평가금액", "평가액", "marketvalue", "value"]],
  ];
  function normHead(h) {
    return String(h == null ? "" : h).toLowerCase().replace(/\(.*?\)|\[.*?\]/g, "").replace(/[\s_%·.\-]/g, "");
  }
  function mapHeader(row) {
    const map = {};
    const cells = row.map(normHead);
    // 정확히 같은 이름 먼저, 그다음 포함
    [true, false].forEach((exact) => {
      HEAD.forEach(([field, names]) => {
        if (map[field] != null) return;
        const i = cells.findIndex((c, idx) => c && !Object.values(map).includes(idx) && names.some((n) => (exact ? c === n : c.includes(n))));
        if (i >= 0) map[field] = i;
      });
    });
    return map;
  }

  function parseHoldings(sheets) {
    let best = null;
    sheets.forEach((rows) => {
      for (let r = 0; r < Math.min(rows.length, 15); r++) {
        const map = mapHeader(rows[r] || []);
        if ((map.code != null || map.name != null) && map.qty != null) {
          if (!best) best = { rows, r, map };
          return;
        }
      }
    });
    if (!best) {
      throw new Error("머리글에서 필요한 열을 찾지 못했습니다. 첫 줄에 ‘종목코드, 종목명, 수량, 평균단가(또는 매입금액), 섹터’ 열이 있어야 합니다. 샘플 파일을 참고해 주세요.");
    }
    const { rows, r, map } = best;
    const byCode = new Map();
    const warnings = [];
    let skipped = 0;
    for (let i = r + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const get = (f) => (map[f] == null ? "" : row[map[f]]);
      const name = String(get("name") || "").trim();
      const code = normCode(get("code"));
      if (!code && !name) continue;
      if (/^(합계|총계|소계|total)$/i.test(name)) continue;
      const qty = toNum(get("qty")) || 0;
      let avg = toNum(get("avg"));
      const costAmt = toNum(get("cost"));
      if ((avg == null || avg === 0) && costAmt != null && qty) avg = costAmt / qty;
      let price = toNum(get("price"));
      const value = toNum(get("value"));
      if (price == null && value != null && qty) price = value / qty;
      const bm = toNum(get("bm"));
      if (!code) {
        skipped++;
        warnings.push((i + 1) + "행 ‘" + name + "’: 종목코드가 없어 건너뜀");
        continue;
      }
      if (qty <= 0 && !(bm > 0)) {
        skipped++;
        continue;
      }
      if (qty > 0 && (avg == null || avg <= 0)) warnings.push((i + 1) + "행 " + (name || code) + ": 평균단가·매입금액이 없어 손익을 0으로 봅니다");
      const h = {
        code,
        name: name || code,
        qty,
        avg: avg != null && avg > 0 ? avg : null,
        sector: String(get("sector") || "").trim(),
        bm: bm != null && bm > 0 ? bm : null,
        price: price != null && price > 0 ? price : null,
        prevClose: toNum(get("prevClose")) || null,
      };
      const prev = byCode.get(code);
      if (prev) {
        // 같은 종목이 여러 줄이면 합친다
        const q = prev.qty + h.qty;
        if (q > 0 && (prev.avg || h.avg)) prev.avg = ((prev.avg || h.avg) * prev.qty + (h.avg || prev.avg) * h.qty) / q;
        prev.qty = q;
        prev.bm = (prev.bm || 0) + (h.bm || 0) || null;
        prev.sector = prev.sector || h.sector;
        prev.price = prev.price || h.price;
        prev.prevClose = prev.prevClose || h.prevClose;
      } else byCode.set(code, h);
    }
    const holdings = Array.from(byCode.values());
    if (!holdings.length) throw new Error("읽을 수 있는 종목이 없습니다. 종목코드와 수량을 확인해 주세요.");
    // BM 비중이 0~1 소수로 적혀 있으면 %로 바꾼다
    const bmSum = holdings.reduce((a, h) => a + (h.bm || 0), 0);
    if (bmSum > 0 && bmSum <= 1.5) holdings.forEach((h) => h.bm && (h.bm = h.bm * 100));
    return { holdings, warnings, skipped, columns: Object.keys(map) };
  }

  /* ---------- 계산 ---------- */
  function compute(p) {
    const hs = (p && p.holdings) || [];
    const rows = hs.map((h, i) => {
      const q = quotes[h.code];
      let price = null;
      let src = "";
      if (q && q.price != null) {
        price = q.price;
        src = "네이버 " + kstTime(q.time || quoteAt);
      } else if (h.price) {
        price = h.price;
        src = "직접 입력";
      } else if (h.avg) {
        price = h.avg;
        src = "시세 없음(평균단가)";
      }
      let change = null;
      if (q && q.changeRate != null) change = q.changeRate;
      else if (!q && h.price && h.prevClose) change = (h.price / h.prevClose - 1) * 100;
      const qty = h.qty || 0;
      const cost = h.avg && qty ? h.avg * qty : price && qty ? price * qty : 0;
      const value = price && qty ? price * qty : 0;
      return {
        idx: i, order: i + 1, ticker: h.code, code: h.code, name: (q && !h.name ? q.name : h.name) || h.code, sector: h.sector || "미분류",
        qty, avg: h.avg, price, src, live: !!(q && q.price != null), change_pct: change, cost, value, pnl: value - cost,
        ret_pct: cost ? ((value - cost) / cost) * 100 : null, bmRaw: h.bm || 0, held: qty > 0,
      };
    });
    const held = rows.filter((r) => r.held);
    const totalValue = held.reduce((a, r) => a + r.value, 0);
    const totalCost = held.reduce((a, r) => a + r.cost, 0);
    const bmSum = rows.reduce((a, r) => a + r.bmRaw, 0);
    const hasBm = bmSum > 0;
    rows.forEach((r) => {
      r.fund_pct = totalValue ? (r.value / totalValue) * 100 : 0;
      r.bm_pct = hasBm ? (r.bmRaw / bmSum) * 100 : null;
      r.active_pct = hasBm ? r.fund_pct - r.bm_pct : null;
      r.contribution_pct = totalCost && r.held ? ((r.value - r.cost) / totalCost) * 100 : r.held ? 0 : null;
      r.day_contribution_pct = r.change_pct != null && r.held ? (r.fund_pct * r.change_pct) / 100 : null;
      if (!r.held) {
        r.ret_pct = null;
        r.pnl = null;
      }
    });
    // 당일 수익률: 등락률이 있는 종목 비중으로 나눠 맞춘다
    function dayReturn(weightKey) {
      let w = 0;
      let s = 0;
      rows.forEach((r) => {
        const wt = r[weightKey] || 0;
        if (wt > 0 && r.change_pct != null) {
          w += wt;
          s += wt * r.change_pct;
        }
      });
      return w > 0 ? s / w : null;
    }
    const fundDay = dayReturn("fund_pct");
    const bmDay = hasBm ? dayReturn("bm_pct") : null;

    // 섹터
    const sectors = new Map();
    rows.forEach((r) => {
      let s = sectors.get(r.sector);
      if (!s) {
        s = { sector: r.sector, count: 0, fund_pct: 0, bm_pct: 0, value: 0, cost: 0, fw: 0, fs: 0, bw: 0, bs: 0 };
        sectors.set(r.sector, s);
      }
      if (r.held) {
        s.count++;
        s.value += r.value;
        s.cost += r.cost;
        s.fund_pct += r.fund_pct;
        if (r.change_pct != null) {
          s.fw += r.fund_pct;
          s.fs += r.fund_pct * r.change_pct;
        }
      }
      if (hasBm) {
        s.bm_pct += r.bm_pct || 0;
        if (r.change_pct != null && r.bm_pct) {
          s.bw += r.bm_pct;
          s.bs += r.bm_pct * r.change_pct;
        }
      }
    });
    const sectorRows = Array.from(sectors.values()).map((s) => {
      const fr = s.fw > 0 ? s.fs / s.fw : null;
      const br = s.bw > 0 ? s.bs / s.bw : null;
      const out = {
        sector: s.sector, count: s.count, fund_pct: s.fund_pct, value: s.value, pnl: s.value - s.cost,
        sector_ret_pct: s.cost ? ((s.value - s.cost) / s.cost) * 100 : null,
        contribution_pct: totalCost ? ((s.value - s.cost) / totalCost) * 100 : null,
        fund_sector_return_pct: fr,
        fund_contribution_pct: fr != null ? (s.fund_pct * fr) / 100 : null,
        bm_pct: hasBm ? s.bm_pct : null,
        difference_pct: hasBm ? s.fund_pct - s.bm_pct : null,
        bm_sector_return_pct: hasBm ? br : null,
        bm_contribution_pct: hasBm && br != null ? (s.bm_pct * br) / 100 : null,
      };
      out.allocation_contribution_pct = hasBm && br != null && bmDay != null ? ((s.fund_pct - s.bm_pct) * (br - bmDay)) / 100 : null;
      out.active_contribution_pct = hasBm ? (out.fund_contribution_pct || 0) - (out.bm_contribution_pct || 0) : null;
      if (hasBm && out.fund_contribution_pct == null && out.bm_contribution_pct == null) out.active_contribution_pct = null;
      return out;
    });
    return {
      rows, held, sectorRows, totalValue, totalCost, pnl: totalValue - totalCost, ret: totalCost ? ((totalValue - totalCost) / totalCost) * 100 : null,
      hasBm, fundDay, bmDay, liveCount: held.filter((r) => r.live).length, manualCount: held.filter((r) => !r.live && r.src === "직접 입력").length,
    };
  }

  /* ---------- 화면 뼈대 ---------- */
  const els = {
    load: $("#fr-load-txt"), cover: $(".fr-cover"), datenote: $("#fr-datenote"), drop: $("#fr-drop"), results: $("#fr-pure-results"),
    kpis: $("#fr-pure-kpis"), status: $("#fr-pure-status"), search: $("#fr-pure-search"), count: $("#fr-pure-count"),
    upload: $("#fr-pure-upload"), refresh: $("#fr-pure-refresh"), modeTag: $("#fr-mode-tag"), tools: $(".fr-head-tools"),
  };
  els.cover.textContent = "엑셀(XLSX) 또는 CSV 첫 줄에 종목코드 · 종목명 · 수량 · 평균단가(또는 매입금액) · 섹터(선택) 열을 넣어 올리세요. BM비중 · 현재가 · 전일종가 열도 넣을 수 있습니다. 평가금액 합계로 종목별 비중을 계산하고, 현재가는 서버 모드에서 네이버 시세를, 그 밖에는 파일이나 직접 입력한 값을 씁니다. 기여도는 ‘종목 평가손익 ÷ 총 매입금액’(%p)으로 모두 더하면 포트폴리오 수익률이 됩니다.";

  // 포트폴리오 선택·관리 (머리 오른쪽)
  els.tools.insertAdjacentHTML(
    "afterbegin",
    '<div class="fr-portfolio-switch" role="group" aria-label="포트폴리오 선택">' +
      '<select id="fr-portfolio-select" aria-label="저장된 포트폴리오"></select>' +
      '<button type="button" class="fr-btn" id="fr-portfolio-rename">이름 변경</button>' +
      '<button type="button" class="fr-btn" id="fr-portfolio-export">CSV 내보내기</button>' +
      '<button type="button" class="fr-btn fr-danger-btn" id="fr-portfolio-delete">삭제</button>' +
      "</div>"
  );
  const select = $("#fr-portfolio-select");

  // 전체 종목 표 도구: 종목 추가
  const pureTools = $(".fr-pure-tools");
  const colChoices = $(".fr-col-choices", pureTools);
  colChoices.insertAdjacentHTML("beforebegin", '<button type="button" class="fr-btn fr-add-stock" id="fr-add-stock">+ 종목 추가</button>');
  const sectorTh = $('#fr-pure-tbl th[data-c="sector"]');
  if (sectorTh) sectorTh.textContent = "섹터";

  // 관심 종목 패널 (★ 누른 종목)
  const purePanel = $("#fr-pure-tbl").closest(".fr-panel");
  purePanel.insertAdjacentHTML(
    "afterend",
    '<section class="fr-panel" id="fr-watchlist-panel" hidden>' +
      '<header><div class="t"><span class="num">★</span><strong>관심 종목</strong></div><small id="fr-watch-count"></small></header>' +
      '<div class="fr-subtable-tools"><div class="fr-col-choices" role="group" aria-label="관심 종목 표시 컬럼"><span>표시 컬럼</span>' +
      '<label><input type="checkbox" data-fr-watch-column="ticker" checked>종목코드</label><label><input type="checkbox" data-fr-watch-column="sector" checked>업종</label></div>' +
      '<label class="fr-table-detail-choice"><input type="checkbox" data-fr-table-detail="fr-watch-tbl">자세히 표시</label></div>' +
      '<div class="fr-body" style="padding:0;overflow:auto;"><table class="fr-tbl fr-watch-tbl fr-reorder-tbl fr-compact-capable" id="fr-watch-tbl"><thead><tr></tr></thead><tbody></tbody></table></div>' +
      "</section>"
  );

  // 섹터별 비중 막대 (섹터 표 위)
  const sectorPanelBody = $("#fr-sector-live-tbl").closest(".fr-body");
  sectorPanelBody.insertAdjacentHTML("beforebegin", '<div class="fr-sector-bars" id="fr-sector-bars" aria-label="섹터별 비중"></div>');

  /* ---------- 표 그리기 ---------- */
  function heatMax(rows, key) {
    let m = 0;
    rows.forEach((r) => {
      const v = r[key];
      if (v != null && isFinite(v)) m = Math.max(m, Math.abs(v));
    });
    return m;
  }
  function visibleCols(id) {
    return TABLES[id].order.filter((k) => !(C[k].bm && !(calc && calc.hasBm)));
  }
  function sortRows(id, rows) {
    const [key, asc] = sortState[id];
    const dir = asc ? 1 : -1;
    return rows.slice().sort((a, b) => {
      const x = a[key];
      const y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y), "ko") * dir;
      return (x - y) * dir;
    });
  }
  function renderHead(id) {
    const t = TABLES[id];
    const tr = $("#" + id + " thead tr");
    const [skey, sasc] = sortState[id];
    let html = t.fav ? '<th class="fr-col-favorite" aria-label="관심 종목">★</th>' : "";
    visibleCols(id).forEach((k) => {
      const c = C[k];
      const cls = "fr-col-" + k + (c.t !== "text" && c.t !== "int" ? " fr-col-metric" : "") + (k === skey ? " sorted" + (sasc ? " asc" : "") : "");
      const aria = k === skey ? (sasc ? "ascending" : "descending") : "none";
      html +=
        '<th data-c="' + k + '" class="' + cls + '" draggable="true" aria-sort="' + aria + '" aria-grabbed="false" title="' + esc((c.tip ? c.tip + " · " : "") + "클릭: 정렬 · 드래그: 컬럼 순서 변경") + '">' +
        esc(k === "sector" && id === "fr-pure-tbl" ? "섹터" : c.l) + "</th>";
    });
    tr.innerHTML = html;
  }
  function cell(k, r, maxes) {
    const c = C[k];
    const v = r[k];
    const cls = ["fr-col-" + k];
    let style = "";
    let inner = fmt(v, k);
    if (k === "sector") {
      cls.unshift("fr-sector-cell");
      style = ' style="--sector-h:' + hue(v) + '"';
    } else if (c.t !== "text" && c.t !== "int") {
      cls.push("fr-col-metric");
      if (c.h && v != null && isFinite(v)) {
        const m = maxes[k];
        const heat = m ? Math.min(100, (Math.abs(v) / m) * 100) : 0;
        cls.unshift(Math.abs(v) < 1e-9 ? "fr-heat-zero" : v > 0 ? "fr-heat-pos" : "fr-heat-neg");
        style = ' style="--heat:' + heat.toFixed(1) + '%"';
      }
      if (c.s && v != null) {
        const sc = sideClass(v);
        if (c.arrow && sc) inner = '<span class="' + sc + '" aria-label="' + fmt(v, k) + '"><b class="fr-move-arrow" aria-hidden="true">' + (v > 0 ? "▲" : "▼") + "</b>" + fmt(Math.abs(v), k).replace(/^\+/, "") + "</span>";
        else if (sc) inner = '<span class="' + sc + '">' + inner + "</span>";
      }
      if (k === "price" && r.src && !r.live && r.held) inner = '<span title="' + esc(r.src) + '">' + inner + (r.src === "직접 입력" ? "*" : "") + "</span>";
    }
    return '<td class="' + cls.join(" ") + '"' + style + ' data-label="' + esc(c.l) + '" data-mobile-label="' + esc(c.m || c.l) + '">' + inner + "</td>";
  }
  function renderTable(id, rows, emptyMsg) {
    const t = TABLES[id];
    const table = $("#" + id);
    if (!table) return;
    renderHead(id);
    const cols = visibleCols(id);
    const maxes = {};
    cols.forEach((k) => C[k].h && (maxes[k] = heatMax(rows, k)));
    const favs = favorites();
    const body = rows.length
      ? rows
        .map((r) => {
          let html = "";
          if (t.fav) {
            const on = favs.includes(r.code);
            html += '<td class="fr-col-favorite"><button type="button" class="fr-favorite-btn" data-favorite-ticker="' + esc(r.code) + '" aria-pressed="' + on + '" aria-label="' + esc(r.name) + (on ? " 관심 종목 해제" : " 관심 종목 추가") + '">' + (on ? "★" : "☆") + "</button></td>";
          }
          cols.forEach((k) => (html += cell(k, r, maxes)));
          return t.row ? '<tr class="fr-stock-row" tabindex="0" role="button" data-ticker="' + esc(r.code) + '" aria-label="' + esc(r.name) + ' 세부사항 보기">' + html + "</tr>" : "<tr>" + html + "</tr>";
        })
        .join("")
      : '<tr><td class="fr-pure-empty" colspan="' + (cols.length + (t.fav ? 1 : 0)) + '">' + esc(emptyMsg || "표시할 종목이 없습니다.") + "</td></tr>";
    $("tbody", table).innerHTML = body;
  }

  function favorites() {
    return (current && K.prefs.get("portfolio.fav." + current.id, [])) || [];
  }

  function renderTables() {
    if (!calc) return;
    // 전체 종목
    const q = (els.search.value || "").trim().toLowerCase();
    const all = calc.rows;
    const shown = all.filter((r) => !q || (r.name + " " + r.code + " " + r.sector).toLowerCase().includes(q));
    renderTable("fr-pure-tbl", sortRows("fr-pure-tbl", shown), q ? "검색 결과가 없습니다." : "종목이 없습니다.");
    els.count.textContent = shown.length + " / " + all.length + " 종목" + (all.length !== calc.held.length ? " (보유 " + calc.held.length + ")" : "");

    // 기여도 상·하위 10
    const ranked = calc.held.slice().sort((a, b) => (b.contribution_pct || 0) - (a.contribution_pct || 0));
    const top = ranked.slice(0, 10).map((r, i) => Object.assign({}, r, { rank: i + 1 }));
    const bottom = ranked.slice().reverse().slice(0, 10).map((r, i) => Object.assign({}, r, { rank: i + 1 }));
    renderTable("fr-top-contrib-tbl", sortRows("fr-top-contrib-tbl", top), "보유 종목이 없습니다.");
    renderTable("fr-bottom-contrib-tbl", sortRows("fr-bottom-contrib-tbl", bottom), "보유 종목이 없습니다.");

    // 섹터
    const sec = calc.sectorRows.slice().sort((a, b) => b.fund_pct - a.fund_pct).map((r, i) => Object.assign({ rank: i + 1 }, r));
    renderTable("fr-sector-live-tbl", sortRows("fr-sector-live-tbl", sec), "섹터 정보가 없습니다.");
    renderSectorBars(sec);

    // 관심 종목
    const favs = favorites();
    const watch = calc.rows.filter((r) => favs.includes(r.code));
    $("#fr-watchlist-panel").hidden = !watch.length;
    $("#fr-watch-count").textContent = watch.length ? watch.length + "종목" : "";
    renderTable("fr-watch-tbl", sortRows("fr-watch-tbl", watch));
    applyColumnChoices();
  }

  function renderSectorBars(sec) {
    const box = $("#fr-sector-bars");
    const rows = sec.filter((s) => s.fund_pct > 0 || (s.bm_pct || 0) > 0).sort((a, b) => b.fund_pct - a.fund_pct);
    if (!rows.length) {
      box.innerHTML = "";
      return;
    }
    const max = Math.max(...rows.map((s) => Math.max(s.fund_pct, s.bm_pct || 0)), 1);
    box.innerHTML =
      '<div class="fr-sector-bars-head"><span>섹터별 비중</span>' +
      '<span class="fr-sector-legend"><i style="background:' + COLORS.fund + '"></i>펀드' + (calc.hasBm ? '<i style="background:' + COLORS.bm + '"></i>BM' : "") + "</span></div>" +
      rows
        .map(
          (s) =>
            '<div class="fr-bar-row"><span class="nm" title="' + esc(s.sector) + '">' + esc(s.sector) + '</span><span class="fr-bar-track">' +
            '<span class="fr-bar-fill" style="display:block;width:' + ((s.fund_pct / max) * 100).toFixed(2) + "%;background:" + COLORS.fund + '"></span>' +
            (calc.hasBm ? '<span class="fr-bar-fill fr-bar-bm" style="display:block;width:' + (((s.bm_pct || 0) / max) * 100).toFixed(2) + "%;background:" + COLORS.bm + '"></span>' : "") +
            '</span><span class="pc">' + s.fund_pct.toFixed(2) + "%" + (calc.hasBm ? '<small> / ' + (s.bm_pct || 0).toFixed(2) + "%</small>" : "") + "</span></div>"
        )
        .join("");
  }

  /* ---------- KPI ---------- */
  function renderKpis() {
    const rets = [["펀드", calc.fundDay, "fr-return-fund", "보유 비중으로 계산한 당일 수익률"]];
    if (calc.hasBm) rets.push(["BM", calc.bmDay, "", "파일의 BM 비중으로 계산한 당일 수익률"]);
    [["KOSPI", "코스피"], ["KOSDAQ", "코스닥"], ["KPI200", "코스피200"]].forEach(([code, label]) => {
      if (quotes[code]) rets.push([label, quotes[code].changeRate, "", label + " 지수 등락률"]);
    });
    const m = Math.max(...rets.map((x) => Math.abs(x[1] || 0)), 0.0001);
    const rowsHtml = rets
      .map(([label, v, cls, title]) => {
        const c = v == null ? "fr-return-zero" : v > 0 ? "fr-return-pos" : v < 0 ? "fr-return-neg" : "fr-return-zero";
        const heat = v == null ? 0 : (Math.abs(v) / m) * 100;
        return '<tr class="' + cls + '"><th scope="row" title="' + esc(title) + '">' + esc(label) + '</th><td class="' + c + '" style="--metric-heat:' + heat.toFixed(1) + '%"><strong><span class="' + sideClass(v) + '">' + (v == null ? "—" : pctText(v)) + "</span></strong></td></tr>";
      })
      .join("");
    const total = calc.held.length;
    const bmOnly = calc.rows.length - total;
    const pnlCls = sideClass(calc.pnl);
    els.kpis.innerHTML =
      '<section class="fr-return-summary"><table aria-label="펀드와 시장의 당일 수익률"><caption>당일 수익률' + (calc.fundDay == null ? " · 시세 없음" : "") + "</caption><tbody>" + rowsHtml + "</tbody></table></section>" +
      '<article class="fr-metric fr-status-card"><span>총평가금액</span><strong>' + bigWon(calc.totalValue) + "</strong><em>매입 " + bigWon(calc.totalCost) + "</em></article>" +
      '<article class="fr-metric fr-status-card"><span>평가손익</span><strong><span class="' + pnlCls + '">' + (calc.pnl > 0 ? "+" : "") + bigWon(calc.pnl) + '</span></strong><em>수익률 <span class="' + sideClass(calc.ret) + '">' + pctText(calc.ret) + "</span></em></article>" +
      '<article class="fr-metric fr-status-card"><span>전체 종목</span><strong>' + total + "</strong><em>" + (bmOnly ? "보유 종목 · BM만 " + bmOnly : "분석 대상 종목") + "</em></article>" +
      '<article class="fr-metric fr-status-card"><span>시세 수신</span><strong>' + calc.liveCount + " / " + total + "</strong><em>" + (session.server ? "네이버 현재가" : "브라우저 모드") + (calc.manualCount ? " · 직접 입력 " + calc.manualCount : "") + "</em></article>";
  }

  /* ---------- 차트 (SVG) ---------- */
  const chartState = { locked: true, zoom: {} };
  function niceStep(range) {
    const raw = range / 4 || 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  function chartEmpty(el, msg) {
    el.innerHTML = '<div class="fr-chart-empty">' + esc(msg) + "</div>";
    el._chart = null;
  }
  // cfg: { id, labels:[x 라벨], series:[{name,color,values:[]}], unit, zero, digits, base }
  function drawChart(el, cfg) {
    el._chart = cfg;
    const n = cfg.labels.length;
    const W = Math.max(200, el.clientWidth || 600);
    const H = Math.max(120, el.clientHeight || 300);
    const L = 46, R = 12, T = 24, B = 22;
    let [i0, i1] = chartState.zoom[cfg.id] || [0, n - 1];
    i0 = Math.max(0, Math.min(i0, n - 1));
    i1 = Math.max(i0, Math.min(i1, n - 1));
    let lo = Infinity;
    let hi = -Infinity;
    cfg.series.forEach((s) => {
      for (let i = i0; i <= i1; i++) {
        const v = s.values[i];
        if (v != null && isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    });
    if (!isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (cfg.zero) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (cfg.base != null) {
      lo = Math.min(lo, cfg.base);
      hi = Math.max(hi, cfg.base);
    }
    if (hi - lo < 1e-6) {
      hi += 0.5;
      lo -= 0.5;
    }
    const step = niceStep(hi - lo);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const span = Math.max(1, i1 - i0);
    const x = (i) => L + ((i - i0) / span) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const d = cfg.digits == null ? 2 : cfg.digits;
    let svg = '<svg class="fr-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(el.getAttribute("aria-label") || "") + '">';
    for (let v = lo; v <= hi + step / 2; v += step) {
      const yy = y(v).toFixed(1);
      const strong = (cfg.zero && Math.abs(v) < step / 1000) || (cfg.base != null && Math.abs(v - cfg.base) < step / 1000);
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" class="' + (strong ? "fr-svg-base" : "fr-svg-grid") + '"/>';
      svg += '<text x="' + (L - 6) + '" y="' + yy + '" dy="3" text-anchor="end" class="fr-svg-label">' + (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(Math.max(0, -Math.floor(Math.log10(step)) + 0))) + "</text>";
    }
    const ticks = Math.min(6, i1 - i0 + 1);
    for (let k = 0; k < ticks; k++) {
      const i = Math.round(i0 + (ticks === 1 ? 0 : (k * (i1 - i0)) / (ticks - 1)));
      svg += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (k === 0 ? "start" : k === ticks - 1 ? "end" : "middle") + '" class="fr-svg-label">' + esc(cfg.labels[i]) + "</text>";
    }
    cfg.series.forEach((s) => {
      let path = "";
      let pen = false;
      for (let i = i0; i <= i1; i++) {
        const v = s.values[i];
        if (v == null || !isFinite(v)) {
          pen = false;
          continue;
        }
        path += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1);
        pen = true;
      }
      if (path) svg += '<path d="' + path + '" fill="none" stroke="' + s.color + '" stroke-width="' + (s.width || 1.6) + '" stroke-linejoin="round" stroke-linecap="round"/>';
      if (i1 === i0 && s.values[i0] != null) svg += '<circle cx="' + x(i0) + '" cy="' + y(s.values[i0]) + '" r="3" fill="' + s.color + '"/>';
    });
    // 범례
    let lx = L;
    cfg.series.forEach((s) => {
      const last = (() => {
        for (let i = i1; i >= i0; i--) if (s.values[i] != null) return s.values[i];
        return null;
      })();
      const label = s.name + (last != null ? " " + (cfg.base != null ? last.toFixed(d) : pctText(last, d).replace("%", cfg.unit || "%")) : "");
      svg += '<rect x="' + lx + '" y="8" width="10" height="3" fill="' + s.color + '"/><text x="' + (lx + 14) + '" y="13" class="fr-svg-legend">' + esc(label) + "</text>";
      lx += 24 + Array.from(label).reduce((a, ch) => a + (/[가-힣]/.test(ch) ? 11 : 6.5), 0);
    });
    svg += '<line class="fr-svg-guide" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" visibility="hidden"/>';
    svg += '<rect class="fr-svg-select" x="0" y="' + T + '" width="0" height="' + (H - T - B) + '" visibility="hidden"/>';
    svg += '<rect class="fr-svg-hit" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/>';
    svg += "</svg>";
    const zoomed = !!chartState.zoom[cfg.id];
    el.innerHTML = svg + '<div class="fr-chart-tip" hidden></div>' + (zoomed ? '<button type="button" class="fr-chart-reset">전체 보기</button>' : "");
    el._geo = { x, y, i0, i1, L, R, W, span };
  }
  function chartIndex(el, clientX) {
    const g = el._geo;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    const i = Math.round(g.i0 + ((px - g.L) / (g.W - g.L - g.R)) * g.span);
    return Math.max(g.i0, Math.min(g.i1, i));
  }
  function bindChart(el) {
    let dragFrom = null;
    el.addEventListener("mousemove", (e) => {
      const cfg = el._chart;
      if (!cfg || !el._geo) return;
      const i = chartIndex(el, e.clientX);
      const g = el._geo;
      const guide = $(".fr-svg-guide", el);
      const tip = $(".fr-chart-tip", el);
      guide.setAttribute("x1", g.x(i));
      guide.setAttribute("x2", g.x(i));
      guide.setAttribute("visibility", "visible");
      const d = cfg.digits == null ? 2 : cfg.digits;
      tip.innerHTML =
        "<b>" + esc(cfg.labels[i]) + "</b>" +
        cfg.series
          .map((s) => {
            const v = s.values[i];
            return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + " " + (v == null ? "—" : cfg.base != null ? v.toFixed(d) : pctText(v, d).replace("%", cfg.unit || "%")) + "</span>";
          })
          .join("");
      tip.hidden = false;
      const rect = el.getBoundingClientRect();
      const left = e.clientX - rect.left;
      tip.style.left = Math.min(Math.max(0, left + 12), rect.width - tip.offsetWidth - 4) + "px";
      tip.style.top = "26px";
      if (dragFrom != null) {
        const sel = $(".fr-svg-select", el);
        const a = g.x(Math.min(dragFrom, i));
        const b = g.x(Math.max(dragFrom, i));
        sel.setAttribute("x", a);
        sel.setAttribute("width", Math.max(1, b - a));
        sel.setAttribute("visibility", "visible");
      }
    });
    el.addEventListener("mouseleave", () => {
      const guide = $(".fr-svg-guide", el);
      const tip = $(".fr-chart-tip", el);
      if (guide) guide.setAttribute("visibility", "hidden");
      if (tip) tip.hidden = true;
      dragFrom = null;
    });
    // Plot Fix 가 꺼져 있으면 끌어서 확대, 두 번 눌러 원래대로
    el.addEventListener("mousedown", (e) => {
      if (chartState.locked || !el._chart || e.button !== 0 || e.target.closest(".fr-chart-reset")) return;
      dragFrom = chartIndex(el, e.clientX);
      e.preventDefault();
    });
    el.addEventListener("mouseup", (e) => {
      if (dragFrom == null || !el._chart) return;
      const i = chartIndex(el, e.clientX);
      const a = Math.min(dragFrom, i);
      const b = Math.max(dragFrom, i);
      dragFrom = null;
      if (b - a >= 1) {
        chartState.zoom[el._chart.id] = [a, b];
        renderCharts();
      }
    });
    el.addEventListener("dblclick", () => {
      if (!el._chart) return;
      delete chartState.zoom[el._chart.id];
      renderCharts();
    });
    el.addEventListener("click", (e) => {
      if (e.target.closest(".fr-chart-reset") && el._chart) {
        delete chartState.zoom[el._chart.id];
        renderCharts();
      }
    });
  }
  const chartEls = { intraday: $("#fr-intraday-chart"), residual: $("#fr-intraday-residual-chart"), nav: $("#fr-daily-nav-chart") };
  Object.values(chartEls).forEach(bindChart);

  // 장중 기록 (이 브라우저, 포트폴리오별)
  function intradayKey() {
    return "portfolio.intraday." + (current ? current.id : "");
  }
  function intraday() {
    const v = K.prefs.get(intradayKey(), null);
    return v && Array.isArray(v.points) ? v : { date: "", points: [] };
  }

  let navRange = K.prefs.get("portfolio.navRange", "1y");
  function renderCharts() {
    const serverNote = session.server ? "시세를 새로고침하면 시점별 수익률이 쌓입니다." : "브라우저 모드에서는 실시간 시세가 없어 장중 차트를 그릴 수 없습니다. 서버 모드에서 연결됩니다.";
    // 장중
    const day = intraday();
    const pts = day.points || [];
    $("#fr-intraday-asof").textContent = day.date ? day.date + " · " + pts.length + "개 시점" : "";
    if (!pts.length) {
      chartEmpty(chartEls.intraday, "오늘 기록된 장중 수익률이 없습니다. " + serverNote);
      chartEmpty(chartEls.residual, calc && calc.hasBm ? "BM 대비 차이는 장중 기록이 쌓이면 표시됩니다." : "파일에 BM비중 열이 있으면 펀드 − BM 차이를 그립니다.");
    } else {
      const labels = pts.map((p) => p.t);
      const series = [{ name: "펀드", color: COLORS.fund, values: pts.map((p) => p.fund), width: 2.2 }];
      if (pts.some((p) => p.bm != null)) series.push({ name: "BM", color: COLORS.bm, values: pts.map((p) => p.bm) });
      series.push({ name: "코스피", color: COLORS.kospi, values: pts.map((p) => p.kospi) }, { name: "코스닥", color: COLORS.kosdaq, values: pts.map((p) => p.kosdaq) });
      drawChart(chartEls.intraday, { id: "intraday", labels, series, zero: true });
      if (pts.some((p) => p.bm != null && p.fund != null)) {
        drawChart(chartEls.residual, { id: "residual", labels, series: [{ name: "펀드 − BM", color: COLORS.fund, values: pts.map((p) => (p.bm != null && p.fund != null ? p.fund - p.bm : null)), width: 2 }], zero: true, unit: "%p" });
      } else chartEmpty(chartEls.residual, calc && calc.hasBm ? "BM 수익률이 아직 없습니다." : "파일에 BM비중 열이 있으면 펀드 − BM 차이를 그립니다.");
    }
    // 누적 수익지수
    const nav = ((current && current.nav) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const startInput = $("#fr-daily-start");
    $$("#fr-daily-ranges button").forEach((b) => b.classList.toggle("active", b.getAttribute("data-range") === navRange));
    if (nav.length) {
      startInput.min = nav[0].date;
      startInput.max = nav[nav.length - 1].date;
    }
    let start = "";
    const t = K.today();
    if (navRange === "30d") start = K.addDays(t, -30);
    else if (navRange === "3m") start = K.addMonths(t, -3);
    else if (navRange === "6m") start = K.addMonths(t, -6);
    else if (navRange === "1y") start = K.addMonths(t, -12);
    else if (navRange === "custom") start = startInput.value || "";
    if (navRange !== "custom") startInput.value = start && nav.length && start > nav[0].date ? start : nav.length ? nav[0].date : "";
    const view = nav.filter((e) => !start || e.date >= start);
    const basis = $("#fr-daily-basis");
    if (view.length < 1) {
      chartEmpty(chartEls.nav, nav.length ? "선택한 기간에 기록이 없습니다." : "아직 쌓인 일별 기록이 없습니다. 시세를 받을 때마다(브라우저 모드는 현재가·전일종가 입력 시) 그날의 수익률을 기록해 지수로 이어 붙입니다.");
      basis.textContent = "하루 수익률을 이어 붙인 지수 · 기록 " + nav.length + "일";
      return;
    }
    const chain = (key) => {
      let lvl = 100;
      let started = false;
      return view.map((e, i) => {
        const r = e[key];
        if (r == null) return started ? lvl : null;
        if (i === 0 || !started) {
          started = true;
          return lvl; // 시작일 = 100
        }
        lvl = lvl * (1 + r / 100);
        return lvl;
      });
    };
    const series = [{ name: "펀드", color: COLORS.fund, values: chain("fund"), width: 2.2 }];
    if (view.some((e) => e.bm != null)) series.push({ name: "BM", color: COLORS.bm, values: chain("bm") });
    if (view.some((e) => e.kospi != null)) series.push({ name: "코스피", color: COLORS.kospi, values: chain("kospi") });
    if (view.some((e) => e.kosdaq != null)) series.push({ name: "코스닥", color: COLORS.kosdaq, values: chain("kosdaq") });
    drawChart(chartEls.nav, { id: "nav", labels: view.map((e) => K.dot(e.date).slice(2)), series, base: 100 });
    basis.textContent = "하루 수익률을 이어 붙인 지수 · " + view[0].date + " = 100 기준 · 기록 " + nav.length + "일";
  }
  $("#fr-daily-ranges").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-range]");
    if (!b) return;
    navRange = b.getAttribute("data-range");
    K.prefs.set("portfolio.navRange", navRange);
    delete chartState.zoom.nav;
    renderCharts();
  });
  $("#fr-daily-start").addEventListener("change", () => {
    navRange = "custom";
    delete chartState.zoom.nav;
    renderCharts();
  });
  const plotFix = $("#fr-plot-fix");
  plotFix.addEventListener("click", () => {
    chartState.locked = !chartState.locked;
    plotFix.setAttribute("aria-pressed", String(chartState.locked));
    $("#fr-plot-fix-state").textContent = chartState.locked ? "ON" : "OFF";
    plotFix.setAttribute("aria-label", chartState.locked ? "차트 고정 해제" : "차트 고정");
    plotFix.title = chartState.locked ? "현재 AutoScale로 고정됨 · 눌러서 끌어 확대 허용" : "차트를 끌어 구간 확대 · 두 번 눌러 원래대로 · 다시 눌러 고정";
    plotFix.closest(".fr-live-chart-grid").classList.toggle("fr-plots-locked", chartState.locked);
    if (chartState.locked) {
      chartState.zoom = {};
      renderCharts();
    }
  });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => current && renderCharts(), 150);
  });

  /* ---------- 전체 그리기 ---------- */
  function renderSwitcher() {
    select.innerHTML = list.length
      ? list.map((p) => '<option value="' + esc(p.id) + '"' + (current && p.id === current.id ? " selected" : "") + ">" + esc(p.name || "이름 없음") + " (" + ((p.holdings || []).filter((h) => h.qty > 0).length) + ")</option>").join("")
      : '<option value="">저장된 포트폴리오 없음</option>';
    select.disabled = !list.length;
    ["#fr-portfolio-rename", "#fr-portfolio-delete", "#fr-portfolio-export"].forEach((s) => ($(s).disabled = !current));
  }
  function renderEmpty(title, msg, isError) {
    els.results.style.display = "none";
    els.drop.style.display = "block";
    els.drop.innerHTML =
      "<h3>" + esc(title) + "</h3><p>" + esc(msg) + "</p>" +
      (isError ? "" : '<div class="fr-drop-actions"><button type="button" class="fr-btn fr-upload-btn" data-fr-pick>파일 고르기</button><button type="button" class="fr-btn" data-fr-sample>샘플 내려받기</button></div>');
    els.datenote.style.display = "none";
    els.load.innerHTML = 'PORTFOLIO <b>없음</b><span class="sep">|</span>FILE <span class="amber">XLSX · CSV</span><span class="sep">|</span>WEIGHT <span class="amber">VALUATION / TOTAL</span>';
  }
  function render() {
    renderSwitcher();
    if (!current) {
      calc = null;
      renderEmpty("아직 올린 포트폴리오가 없습니다.", "보유 종목 파일(XLSX·CSV)을 올리면 비중·평가금액·손익·섹터·기여도를 계산합니다. 형식은 ‘샘플 엑셀’을 참고하세요.");
      return;
    }
    calc = compute(current);
    els.drop.style.display = "none";
    els.results.style.display = "block";
    const priceMode = session.server ? "NAVER 현재가" : "파일 · 직접 입력";
    els.load.innerHTML =
      "FILE <b>" + esc(current.fileName || current.name) + '</b><span class="sep">|</span>HOLDINGS <span class="amber">' + calc.held.length + " STOCKS</span>" +
      (calc.hasBm ? '<span class="sep">|</span>BM <span class="amber">' + calc.rows.filter((r) => r.bmRaw > 0).length + " STOCKS</span>" : "") +
      '<span class="sep">|</span>WEIGHT <span class="amber">VALUATION / TOTAL</span><span class="sep">|</span>PRICE <span class="amber">' + priceMode + "</span>";
    els.datenote.style.display = "block";
    els.datenote.innerHTML =
      "<b>" + esc(current.name) + "</b> · 올린 날 " + esc(K.isoKst(current.uploadedAt || current.createdAt) || "—") + (current.createdBy ? " · " + esc(current.createdBy) : "") +
      (current.updatedAt ? " · 마지막 수정 " + esc(K.isoKst(current.updatedAt)) : "");
    renderKpis();
    renderStatus();
    renderTables();
    renderCharts();
  }
  function renderStatus() {
    const st = els.status;
    st.classList.toggle("error", !!quoteError);
    if (quoteError) st.textContent = quoteError;
    else if (quoteAt) st.textContent = "시세 " + K.isoKst(quoteAt).slice(2) + " 기준";
    else st.textContent = session.server ? "시세 받는 중…" : "브라우저 모드 · 파일의 현재가 사용";
  }

  /* ---------- 시세 ---------- */
  async function refreshQuotes(manual) {
    if (!current) return;
    if (!session.server) {
      quoteError = "";
      calc = compute(current);
      await recordDay();
      render();
      if (manual) K.toast("브라우저 모드에서는 실시간 시세를 받을 수 없어 파일·직접 입력한 현재가로 다시 계산했습니다.");
      return;
    }
    const btn = $(".fr-refresh-btn");
    btn.disabled = true;
    const codes = Array.from(new Set((current.holdings || []).map((h) => h.code)));
    const chunks = [];
    for (let i = 0; i < codes.length; i += 100) chunks.push(codes.slice(i, i + 100));
    if (!chunks.length) chunks.push([]);
    chunks[0] = chunks[0].concat(INDEXES);
    try {
      const got = {};
      let at = "";
      for (const part of chunks) {
        const res = await session.api("GET", "/api/quotes?codes=" + encodeURIComponent(part.join(",")));
        (res.items || []).forEach((q) => q && q.code && (got[String(q.code).toUpperCase()] = q));
        at = res.at || at;
      }
      quotes = got;
      quoteAt = at || new Date().toISOString();
      quoteError = "";
      calc = compute(current);
      recordIntraday();
      await recordDay();
      render();
      if (manual) K.toast("현재가를 새로 받았습니다.");
    } catch (e) {
      const msg = String(e.message || "");
      quoteError = /연결|설정|not_connected|키/.test(msg) ? "시세 연결 안 됨 · " + msg : "시세를 받지 못했습니다 · " + msg;
      render();
      if (manual) K.toast(quoteError + " 파일·직접 입력한 현재가로 계산합니다.", true);
    } finally {
      btn.disabled = false;
    }
  }
  function marketOpen() {
    const d = K.weekday(K.today());
    const t = K.nowTime();
    return d >= 1 && d <= 5 && t >= "08:55" && t <= "15:40";
  }
  function recordIntraday() {
    if (!calc || calc.fundDay == null) return;
    const first = Object.values(quotes).find((q) => q.time);
    const date = first ? kstDate(first.time) : K.today();
    if (date !== K.today() && !marketOpen()) return; // 휴장일에는 지난 값을 쌓지 않는다
    const day = intraday();
    const pts = day.date === K.today() ? day.points : [];
    const p = {
      t: K.nowTime(), fund: round(calc.fundDay), bm: calc.bmDay != null ? round(calc.bmDay) : null,
      kospi: quotes.KOSPI ? quotes.KOSPI.changeRate : null, kosdaq: quotes.KOSDAQ ? quotes.KOSDAQ.changeRate : null,
    };
    if (pts.length && pts[pts.length - 1].t === p.t) pts[pts.length - 1] = p;
    else pts.push(p);
    K.prefs.set(intradayKey(), { date: K.today(), points: pts.slice(-600) });
  }
  function round(v) {
    return v == null ? null : Math.round(v * 10000) / 10000;
  }
  // 그날의 수익률을 기록 (누적 수익지수용). 같은 날은 덮어쓰고, 서버에는 5분에 한 번만 쓴다
  async function recordDay() {
    if (!current || !calc || calc.fundDay == null) return;
    const first = Object.values(quotes).find((q) => q.time);
    const date = first ? kstDate(first.time) : K.today();
    if (K.weekday(date) === 0 || K.weekday(date) === 6) return;
    const entry = {
      date, fund: round(calc.fundDay), bm: calc.bmDay != null ? round(calc.bmDay) : null,
      kospi: quotes.KOSPI ? quotes.KOSPI.changeRate : null, kosdaq: quotes.KOSDAQ ? quotes.KOSDAQ.changeRate : null, value: Math.round(calc.totalValue),
    };
    const nav = (current.nav || []).filter((e) => e.date !== date);
    const prev = (current.nav || []).find((e) => e.date === date);
    if (prev && prev.fund === entry.fund && prev.bm === entry.bm && prev.kospi === entry.kospi) return;
    const now = Date.now();
    if (prev && session.server && now - lastNavWrite < 5 * 60 * 1000) {
      current.nav = nav.concat([entry]); // 화면에만 반영
      return;
    }
    nav.push(entry);
    nav.sort((a, b) => a.date.localeCompare(b.date));
    try {
      current = await store.update(current.id, { nav: nav.slice(-1500) });
      lastNavWrite = now;
      syncList();
    } catch (e) {
      current.nav = nav;
    }
  }
  function syncList() {
    const i = list.findIndex((p) => p.id === current.id);
    if (i >= 0) list[i] = current;
  }
  function schedule() {
    clearInterval(timer);
    if (!session.server) return;
    // 장중에는 1분마다 현재가를 다시 받는다
    timer = setInterval(() => {
      if (document.visibilityState === "visible" && current && marketOpen() && !K.isModalOpen()) refreshQuotes(false);
    }, 60 * 1000);
  }

  /* ---------- 불러오기·선택 ---------- */
  function choose(id) {
    current = list.find((p) => p.id === id) || list[0] || null;
    if (current) K.prefs.set("portfolio.current", current.id);
    chartState.zoom = {};
    els.search.value = "";
    quotes = {};
    quoteAt = "";
    quoteError = "";
    render();
    if (current) refreshQuotes(false);
  }
  async function load() {
    try {
      list = await store.list();
    } catch (e) {
      renderSwitcher();
      renderEmpty("포트폴리오를 불러올 수 없습니다.", e.message || "권한을 확인해 주세요.", true);
      return;
    }
    list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));
    choose(K.prefs.get("portfolio.current", ""));
  }
  select.addEventListener("change", () => choose(select.value));

  /* ---------- 올리기 ---------- */
  const fileInput = $(".fr-file", els.upload);
  els.upload.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = fileInput.files && fileInput.files[0];
    if (!f) {
      fileInput.click();
      return;
    }
    handleFile(f);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  els.drop.addEventListener("click", (e) => {
    if (e.target.closest("[data-fr-pick]")) fileInput.click();
    if (e.target.closest("[data-fr-sample]")) downloadSample();
  });
  // 파일을 화면에 끌어다 놓기
  root.addEventListener("dragover", (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      e.preventDefault();
      root.classList.add("fr-dragging-file");
    }
  });
  root.addEventListener("dragleave", (e) => {
    if (e.target === root || !root.contains(e.relatedTarget)) root.classList.remove("fr-dragging-file");
  });
  root.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    root.classList.remove("fr-dragging-file");
    if (!f) return;
    e.preventDefault();
    handleFile(f);
  });

  async function handleFile(file) {
    if (!/\.(xlsx|xlsm|xls|csv|txt|tsv)$/i.test(file.name)) {
      K.toast("XLSX 또는 CSV 파일만 올릴 수 있습니다.", true);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      K.toast("10MB 이하 파일만 올릴 수 있습니다.", true);
      return;
    }
    let parsed;
    try {
      parsed = parseHoldings(await readRows(file));
    } catch (e) {
      K.toast(e.message || "파일을 읽지 못했습니다.", true);
      fileInput.value = "";
      return;
    }
    confirmUpload(file.name, parsed);
  }

  function confirmUpload(fileName, parsed) {
    const hs = parsed.holdings;
    const held = hs.filter((h) => h.qty > 0);
    const cost = held.reduce((a, h) => a + (h.avg || 0) * h.qty, 0);
    const baseName = fileName.replace(/\.[^.]+$/, "");
    const preview = held
      .slice(0, 8)
      .map((h) => "<tr><td>" + esc(h.code) + "</td><td>" + esc(h.name) + "</td><td>" + esc(h.sector || "—") + '</td><td class="num">' + K.num(h.qty, h.qty % 1 ? 2 : 0) + '</td><td class="num">' + (h.avg ? K.num(h.avg, 0) : "—") + "</td></tr>")
      .join("");
    const ctx = K.modal({
      title: "포트폴리오 올리기",
      size: "modal--wide",
      focus: "#fr-up-name",
      html:
        '<form class="modal__body fr-upload-form">' +
        '<p class="hint">' + esc(fileName) + " · 보유 " + held.length + "종목" + (hs.length > held.length ? " · BM만 " + (hs.length - held.length) + "종목" : "") + " · 매입금액 " + esc(bigWon(cost)) +
        (parsed.skipped ? " · 건너뛴 줄 " + parsed.skipped : "") + "</p>" +
        '<div class="fr-up-preview"><table><thead><tr><th>코드</th><th>종목명</th><th>섹터</th><th class="num">수량</th><th class="num">평균단가</th></tr></thead><tbody>' + preview + "</tbody></table>" +
        (held.length > 8 ? '<p class="hint">외 ' + (held.length - 8) + "종목</p>" : "") + "</div>" +
        (parsed.warnings.length ? '<details class="fr-up-warn"><summary>확인할 점 ' + parsed.warnings.length + "건</summary><ul>" + parsed.warnings.slice(0, 30).map((w) => "<li>" + esc(w) + "</li>").join("") + "</ul></details>" : "") +
        '<label class="field"><span>포트폴리오 이름</span><input id="fr-up-name" class="input" required maxlength="60" value="' + esc(baseName) + '"></label>' +
        (current
          ? '<div class="fr-up-mode"><label><input type="radio" name="mode" value="new" checked> 새 포트폴리오로 저장</label>' +
          '<label><input type="radio" name="mode" value="replace"> ‘' + esc(current.name) + "’의 종목을 이 파일로 바꾸기 (일별 기록은 유지)</label></div>"
          : "") +
        '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-close>취소</button><button type="submit" class="btn btn--primary">저장</button></div></div>' +
        "</form>",
      onClose: () => (fileInput.value = ""),
    });
    const form = $("form", ctx.modal);
    const nameInput = $("#fr-up-name", form);
    $$('input[name="mode"]', form).forEach((r) =>
      r.addEventListener("change", () => {
        if (r.checked && r.value === "replace") nameInput.value = current.name;
        else if (r.checked) nameInput.value = baseName;
      })
    );
    $("[data-close]", form).addEventListener("click", () => ctx.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      const modeEl = $('input[name="mode"]:checked', form);
      const mode = modeEl ? modeEl.value : "new";
      const btn = $('button[type="submit"]', form);
      btn.disabled = true;
      try {
        const data = { name, fileName, holdings: hs, uploadedAt: new Date().toISOString() };
        let saved;
        if (mode === "replace" && current) {
          saved = await store.update(current.id, data);
          list = list.map((p) => (p.id === saved.id ? saved : p));
        } else {
          saved = await store.create(Object.assign({ nav: [] }, data));
          list = list.filter((p) => p.id !== saved.id).concat([saved]);
        }
        ctx.close(true);
        fileInput.value = "";
        K.toast("‘" + name + "’ 포트폴리오를 저장했습니다. (" + held.length + "종목)");
        choose(saved.id);
      } catch (err) {
        btn.disabled = false;
        K.toast("저장하지 못했습니다. " + err.message, true);
      }
    });
  }

  /* ---------- 샘플 파일 ---------- */
  function downloadSample() {
    // 예시 값 (형식 안내용)
    const rows = [
      ["종목코드", "종목명", "수량", "평균단가", "섹터", "BM비중", "현재가", "전일종가"],
      ["005930", "삼성전자", "100", "70000", "반도체", "30", "", ""],
      ["000660", "SK하이닉스", "20", "180000", "반도체", "10", "", ""],
      ["035420", "NAVER", "15", "200000", "인터넷", "3", "", ""],
      ["005380", "현대차", "10", "210000", "자동차", "4", "", ""],
      ["051910", "LG화학", "5", "400000", "화학", "2", "", ""],
      ["105560", "KB금융", "30", "60000", "은행", "3", "", ""],
      ["068270", "셀트리온", "", "", "바이오", "3", "", ""],
    ];
    K.saveText("포트폴리오_샘플.csv", K.toCsv(rows), "text/csv;charset=utf-8");
    K.toast("샘플 CSV를 내려받았습니다. 엑셀에서 열어 수정한 뒤 올리세요. (수량이 비어 있는 줄은 BM에만 있는 종목, 현재가·전일종가는 비워 두면 시세를 씁니다)");
  }
  $("#fr-sample-link").addEventListener("click", (e) => {
    e.preventDefault();
    downloadSample();
  });

  /* ---------- 새로고침 ---------- */
  els.refresh.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!current) {
      K.toast("먼저 포트폴리오 파일을 올려 주세요.", true);
      return;
    }
    refreshQuotes(true);
  });

  /* ---------- 포트폴리오 관리 ---------- */
  $("#fr-portfolio-rename").addEventListener("click", () => {
    if (!current) return;
    const ctx = K.modal({
      title: "포트폴리오 이름 변경",
      size: "modal--narrow",
      focus: "#fr-rename-input",
      html:
        '<form class="modal__body"><label class="field"><span>이름</span><input id="fr-rename-input" class="input" required maxlength="60" value="' + esc(current.name) + '"></label>' +
        '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-close>취소</button><button type="submit" class="btn btn--primary">저장</button></div></div></form>',
    });
    $("[data-close]", ctx.modal).addEventListener("click", () => ctx.close());
    $("form", ctx.modal).addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = $("#fr-rename-input", ctx.modal).value.trim();
      if (!name) return;
      try {
        current = await store.update(current.id, { name });
        syncList();
        ctx.close(true);
        render();
        K.toast("이름을 바꿨습니다.");
      } catch (err) {
        K.toast("이름을 바꾸지 못했습니다. " + err.message, true);
      }
    });
  });
  $("#fr-portfolio-delete").addEventListener("click", async () => {
    if (!current) return;
    const ok = await K.confirm("‘" + current.name + "’ 포트폴리오를 삭제할까요?\n종목과 일별 기록이 모두 지워집니다.", "삭제", true);
    if (!ok) return;
    try {
      const id = current.id;
      await store.remove(id);
      list = list.filter((p) => p.id !== id);
      K.prefs.set("portfolio.fav." + id, null);
      K.prefs.set("portfolio.intraday." + id, null);
      K.toast("삭제했습니다.");
      choose(list[0] ? list[0].id : "");
    } catch (err) {
      K.toast("삭제하지 못했습니다. " + err.message, true);
    }
  });
  $("#fr-portfolio-export").addEventListener("click", () => {
    if (!calc) return;
    const head = ["종목코드", "종목명", "섹터", "수량", "평균단가", "현재가", "시세 출처", "매입금액", "평가금액", "평가손익", "수익률(%)", "비중(%)", "BM비중(%)", "A.Bet(%p)", "당일(%)", "기여도(%p)"];
    const r2 = (v) => (v == null || !isFinite(v) ? "" : Math.round(v * 100) / 100);
    const rows = [head].concat(
      calc.rows.map((r) => [r.code, r.name, r.sector, r.qty, r.avg == null ? "" : Math.round(r.avg * 100) / 100, r.price == null ? "" : r.price, r.src, Math.round(r.cost), Math.round(r.value),
        r.pnl == null ? "" : Math.round(r.pnl), r2(r.ret_pct), r2(r.fund_pct), r2(r.bm_pct), r2(r.active_pct), r2(r.change_pct), r2(r.contribution_pct)])
    );
    rows.push(["합계", "", "", "", "", "", "", Math.round(calc.totalCost), Math.round(calc.totalValue), Math.round(calc.pnl), r2(calc.ret), 100, calc.hasBm ? 100 : "", "", r2(calc.fundDay), r2(calc.ret)]);
    K.saveText((current.name || "포트폴리오") + "_분석_" + K.today().replace(/-/g, "") + ".csv", K.toCsv(rows), "text/csv;charset=utf-8");
  });

  /* ---------- 표 조작: 검색·정렬·컬럼 ---------- */
  els.search.addEventListener("input", renderTables);

  function applyColumnChoices() {
    const map = [["data-fr-column", "fr-pure-tbl"], ["data-fr-top-column", "fr-top-contrib-tbl"], ["data-fr-bottom-column", "fr-bottom-contrib-tbl"], ["data-fr-watch-column", "fr-watch-tbl"]];
    map.forEach(([attr, id]) => {
      $$("input[" + attr + "]").forEach((inp) => {
        $("#" + id).classList.toggle("fr-hide-" + inp.getAttribute(attr), !inp.checked);
      });
    });
    $$("input[data-fr-table-detail]").forEach((inp) => {
      const id = inp.getAttribute("data-fr-table-detail");
      $("#" + id).classList.toggle("fr-detailed-view", inp.checked);
      $$('[data-fr-compact-only="' + id + '"]').forEach((el) => (el.hidden = inp.checked));
    });
  }
  // 저장된 선택 복원
  $$("input[data-fr-column], input[data-fr-top-column], input[data-fr-bottom-column], input[data-fr-watch-column], input[data-fr-table-detail]").forEach((inp) => {
    const attr = inp.getAttributeNames().find((a) => a.startsWith("data-fr-"));
    const key = "portfolio.chk." + attr + "." + inp.getAttribute(attr);
    inp.checked = !!K.prefs.get(key, inp.checked);
    inp.addEventListener("change", () => {
      K.prefs.set(key, inp.checked);
      applyColumnChoices();
    });
  });
  applyColumnChoices();

  // 머리글: 클릭 정렬, 끌어서 순서 변경
  let dragCol = null;
  Object.keys(TABLES).forEach((id) => {
    const table = $("#" + id);
    if (!table) return;
    const thead = $("thead", table);
    thead.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-c]");
      if (!th) return;
      const key = th.getAttribute("data-c");
      const [cur, asc] = sortState[id];
      sortState[id] = cur === key ? [key, !asc] : [key, C[key].t === "text"];
      K.prefs.set("portfolio.sort." + id, sortState[id]);
      renderTables();
    });
    thead.addEventListener("dragstart", (e) => {
      const th = e.target.closest("th[data-c]");
      if (!th) return;
      dragCol = { id, key: th.getAttribute("data-c") };
      th.classList.add("fr-col-dragging");
      th.setAttribute("aria-grabbed", "true");
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", dragCol.key);
      } catch (err) {
        /* 무시 */
      }
    });
    thead.addEventListener("dragover", (e) => {
      const th = e.target.closest("th[data-c]");
      if (!th || !dragCol || dragCol.id !== id) return;
      e.preventDefault();
      $$("th.fr-col-drop-target", thead).forEach((x) => x !== th && x.classList.remove("fr-col-drop-target"));
      th.classList.add("fr-col-drop-target");
    });
    thead.addEventListener("dragleave", (e) => {
      const th = e.target.closest("th[data-c]");
      if (th && !th.contains(e.relatedTarget)) th.classList.remove("fr-col-drop-target");
    });
    thead.addEventListener("drop", (e) => {
      const th = e.target.closest("th[data-c]");
      if (!th || !dragCol || dragCol.id !== id) return;
      e.preventDefault();
      moveColumn(id, dragCol.key, th.getAttribute("data-c"));
      dragCol = null;
    });
    thead.addEventListener("dragend", () => {
      dragCol = null;
      $$("th", thead).forEach((x) => {
        x.classList.remove("fr-col-dragging", "fr-col-drop-target");
        x.setAttribute("aria-grabbed", "false");
      });
    });
  });
  function moveColumn(id, from, to) {
    if (from === to) return;
    const order = TABLES[id].order.filter((k) => k !== from);
    const at = order.indexOf(to);
    const before = TABLES[id].order.indexOf(from) > TABLES[id].order.indexOf(to);
    order.splice(before ? at : at + 1, 0, from);
    TABLES[id].order = order;
    K.prefs.set(colPref(id), order);
    renderTables();
  }

  // 관심 종목·행 클릭
  root.addEventListener("click", (e) => {
    const fav = e.target.closest(".fr-favorite-btn");
    if (fav) {
      e.stopPropagation();
      const code = fav.getAttribute("data-favorite-ticker");
      const favs = favorites();
      const next = favs.includes(code) ? favs.filter((c) => c !== code) : favs.concat([code]);
      K.prefs.set("portfolio.fav." + current.id, next);
      renderTables();
      return;
    }
    const row = e.target.closest("tr.fr-stock-row");
    if (row) openDetail(row.getAttribute("data-ticker"));
  });
  root.addEventListener("keydown", (e) => {
    const row = e.target.closest && e.target.closest("tr.fr-stock-row");
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openDetail(row.getAttribute("data-ticker"));
    }
  });

  /* ---------- 종목 세부사항·수정 ---------- */
  const detail = document.createElement("div");
  detail.className = "fr-detail-modal";
  detail.hidden = true;
  root.appendChild(detail);
  let detailReturn = null;
  function closeDetail() {
    if (detail.hidden) return;
    detail.hidden = true;
    detail.innerHTML = "";
    document.body.style.overflow = "";
    if (detailReturn && document.contains(detailReturn)) detailReturn.focus();
  }
  detail.addEventListener("click", (e) => {
    if (e.target === detail || e.target.closest(".fr-detail-close")) closeDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !detail.hidden && !K.isModalOpen()) closeDetail();
  });

  function item(label, value, opts) {
    opts = opts || {};
    let cls = "fr-detail-item";
    let style = "";
    if (opts.heat != null && isFinite(opts.heat)) {
      cls += opts.heat > 0 ? " fr-detail-heat-pos" : opts.heat < 0 ? " fr-detail-heat-neg" : " fr-detail-heat-zero";
      style = ' style="--detail-heat:' + Math.min(100, Math.abs(opts.heatPct || 0)).toFixed(1) + '%"';
    }
    if (opts.contrib) cls += " fr-detail-contribution";
    return '<div class="' + cls + '"' + style + "><span>" + esc(label) + "</span><strong>" + value + "</strong></div>";
  }
  function signed(v, text) {
    const c = sideClass(v);
    return c ? '<span class="' + c + '">' + text + "</span>" : text;
  }

  function holdingForm(h) {
    const v = (x) => (x == null ? "" : esc(x));
    return (
      '<form class="fr-edit-form" autocomplete="off">' +
      '<label><span>종목코드</span><input name="code" required maxlength="6" value="' + v(h.code) + '"' + (h.code ? " readonly" : "") + ' list="fr-stock-suggest"></label>' +
      '<label><span>종목명</span><input name="name" required maxlength="40" value="' + v(h.name) + '"></label>' +
      '<label><span>섹터</span><input name="sector" maxlength="40" value="' + v(h.sector) + '" list="fr-sector-list"></label>' +
      '<label><span>수량</span><input name="qty" inputmode="decimal" value="' + v(h.qty) + '"></label>' +
      '<label><span>평균단가</span><input name="avg" inputmode="decimal" value="' + v(h.avg != null ? Math.round(h.avg * 100) / 100 : "") + '"></label>' +
      '<label><span>BM 비중(%)</span><input name="bm" inputmode="decimal" value="' + v(h.bm) + '"></label>' +
      '<label><span>현재가 직접 입력</span><input name="price" inputmode="decimal" value="' + v(h.price) + '" placeholder="' + (session.server ? "비우면 시세 사용" : "비우면 평균단가") + '"></label>' +
      '<label><span>전일종가</span><input name="prevClose" inputmode="decimal" value="' + v(h.prevClose) + '" placeholder="당일 등락 계산용"></label>' +
      '<div class="fr-edit-actions">' +
      (h.code ? '<button type="button" class="fr-btn fr-danger-btn" data-remove>종목 빼기</button>' : "") +
      '<button type="submit" class="fr-btn fr-upload-btn">' + (h.code ? "저장" : "추가") + "</button></div>" +
      '<datalist id="fr-sector-list">' + Array.from(new Set((current.holdings || []).map((x) => x.sector).filter(Boolean))).map((s) => '<option value="' + esc(s) + '">').join("") + "</datalist>" +
      '<datalist id="fr-stock-suggest"></datalist><datalist id="fr-stock-suggest-name"></datalist>' +
      "</form>"
    );
  }

  function showDetail(html) {
    detailReturn = document.activeElement;
    detail.innerHTML = '<div class="fr-detail-card" role="dialog" aria-modal="true" aria-labelledby="fr-detail-title">' + html + "</div>";
    detail.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(() => {
      const f = $(".fr-detail-close", detail);
      if (f) f.focus();
    }, 0);
  }

  function openDetail(code) {
    if (!calc) return;
    const r = calc.rows.find((x) => x.code === code);
    const h = (current.holdings || []).find((x) => x.code === code);
    if (!r || !h) return;
    const maxAbs = (key) => heatMax(calc.held, key) || 1;
    const primary =
      item("평가금액", esc(won(r.value))) +
      item("평가손익", r.pnl == null ? "—" : signed(r.pnl, (r.pnl > 0 ? "+" : "") + esc(won(r.pnl))), { heat: r.pnl, heatPct: r.pnl == null ? 0 : (Math.abs(r.pnl) / maxAbs("pnl")) * 100 }) +
      item("수익률", signed(r.ret_pct, pctText(r.ret_pct)), { heat: r.ret_pct, heatPct: r.ret_pct == null ? 0 : (Math.abs(r.ret_pct) / maxAbs("ret_pct")) * 100 }) +
      item("비중", pctText(r.fund_pct).replace("+", ""), { heat: r.fund_pct, heatPct: (r.fund_pct / maxAbs("fund_pct")) * 100 }) +
      item("수익 기여도", signed(r.contribution_pct, fmt(r.contribution_pct, "contribution_pct") + "%p"), { contrib: true, heat: r.contribution_pct, heatPct: r.contribution_pct == null ? 0 : (Math.abs(r.contribution_pct) / maxAbs("contribution_pct")) * 100 }) +
      item("당일 등락률", signed(r.change_pct, pctText(r.change_pct)), { heat: r.change_pct, heatPct: r.change_pct == null ? 0 : Math.min(100, Math.abs(r.change_pct) * 10) });
    const second =
      item("수량", esc(K.num(r.qty, r.qty % 1 ? 2 : 0)) + "주") +
      item("평균단가", esc(won(r.avg))) +
      item("매입금액", esc(won(r.cost))) +
      item("현재가", esc(won(r.price))) +
      item("시세 출처", esc(r.src || "—")) +
      item("당일 기여", signed(r.day_contribution_pct, fmt(r.day_contribution_pct, "day_contribution_pct") + (r.day_contribution_pct != null ? "%p" : ""))) +
      (calc.hasBm ? item("BM 비중", r.bm_pct == null ? "—" : r.bm_pct.toFixed(2) + "%") + item("A.Bet", signed(r.active_pct, fmt(r.active_pct, "active_pct") + "%p")) + item("섹터", esc(r.sector)) : "");
    showDetail(
      '<div class="fr-detail-head"><div><h3 id="fr-detail-title">' + esc(r.name) + "</h3><p>" + esc(r.code) + " · " + esc(r.sector) + (r.held ? "" : " · BM에만 있는 종목") + "</p></div>" +
      '<button type="button" class="fr-detail-close" aria-label="닫기">×</button></div>' +
      '<div class="fr-detail-body">' +
      '<section class="fr-detail-group fr-detail-primary"><h4>보유 현황</h4><div class="fr-detail-grid">' + primary + "</div></section>" +
      '<section class="fr-detail-group"><h4>매입·시세</h4><div class="fr-detail-grid">' + second + "</div></section>" +
      '<section class="fr-detail-group"><h4>종목 정보 수정</h4>' + holdingForm(h) + "</section>" +
      "</div>"
    );
    bindForm(h);
  }

  function openAdd() {
    if (!current) {
      K.toast("먼저 포트폴리오 파일을 올려 주세요.", true);
      return;
    }
    showDetail(
      '<div class="fr-detail-head"><div><h3 id="fr-detail-title">종목 추가</h3><p>' + esc(current.name) + "에 종목을 더합니다." + (session.server ? " 종목명·코드를 입력하면 후보를 보여 줍니다." : "") + "</p></div>" +
      '<button type="button" class="fr-detail-close" aria-label="닫기">×</button></div>' +
      '<div class="fr-detail-body"><section class="fr-detail-group"><h4>새 종목</h4>' + holdingForm({}) + "</section></div>"
    );
    bindForm(null);
  }
  $("#fr-add-stock").addEventListener("click", openAdd);

  function bindForm(orig) {
    const form = $(".fr-edit-form", detail);
    if (!form) return;
    const f = (n) => form.elements[n];
    // 서버 모드: 종목 검색 후보
    if (session.server && !orig) {
      let t = null;
      const suggest = $("#fr-stock-suggest", form);
      const lookup = (q) => {
        clearTimeout(t);
        if (!q || q.length < 1) return;
        t = setTimeout(async () => {
          try {
            const res = await session.api("GET", "/api/stock-search?q=" + encodeURIComponent(q));
            const items = res.items || [];
            suggest.innerHTML = items.map((it) => '<option value="' + esc(it.code) + '">' + esc(it.name + " · " + (it.market || "")) + "</option>").join("");
            $("#fr-stock-suggest-name", form).innerHTML = items.map((it) => '<option value="' + esc(it.name) + '">' + esc(it.code + " · " + (it.market || "")) + "</option>").join("");
            form._found = items;
          } catch (e) {
            /* 검색 실패는 조용히 */
          }
        }, 250);
      };
      f("code").addEventListener("input", () => {
        const v = f("code").value.trim();
        const hit = (form._found || []).find((it) => it.code === v.toUpperCase());
        if (hit && !f("name").value) f("name").value = hit.name;
        else if (!/^[0-9A-Z]{6}$/i.test(v)) lookup(v);
      });
      f("name").setAttribute("list", "fr-stock-suggest-name");
      f("name").addEventListener("input", () => {
        const v = f("name").value.trim();
        const hit = (form._found || []).find((it) => it.name === v);
        if (hit) f("code").value = hit.code;
        else lookup(v);
      });
    }
    const rm = $("[data-remove]", form);
    if (rm) {
      rm.addEventListener("click", async () => {
        const ok = await K.confirm("‘" + orig.name + "’을(를) 이 포트폴리오에서 뺄까요?", "빼기", true);
        if (!ok) return;
        await saveHoldings((current.holdings || []).filter((x) => x.code !== orig.code), "종목을 뺐습니다.");
      });
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = normCode(f("code").value);
      if (!code) {
        K.toast("종목코드는 숫자·영문 6자리로 입력해 주세요.", true);
        return;
      }
      const qty = toNum(f("qty").value) || 0;
      const bm = toNum(f("bm").value);
      if (qty < 0) {
        K.toast("수량은 0 이상이어야 합니다.", true);
        return;
      }
      if (!qty && !(bm > 0)) {
        K.toast("수량 또는 BM 비중을 입력해 주세요.", true);
        return;
      }
      const h = {
        code, name: f("name").value.trim() || code, sector: f("sector").value.trim(), qty,
        avg: toNum(f("avg").value) || null, bm: bm > 0 ? bm : null, price: toNum(f("price").value) || null, prevClose: toNum(f("prevClose").value) || null,
      };
      const hs = (current.holdings || []).slice();
      const i = hs.findIndex((x) => x.code === code);
      if (!orig && i >= 0) {
        K.toast("이미 있는 종목입니다. 표에서 그 종목을 눌러 수정해 주세요.", true);
        return;
      }
      if (i >= 0) hs[i] = h;
      else hs.push(h);
      await saveHoldings(hs, orig ? "저장했습니다." : "종목을 추가했습니다.", !orig || h.code !== orig.code);
    });
  }
  async function saveHoldings(hs, msg, needQuotes) {
    try {
      current = await store.update(current.id, { holdings: hs });
      syncList();
      closeDetail();
      K.toast(msg);
      render();
      if (needQuotes && session.server) refreshQuotes(false);
    } catch (err) {
      K.toast("저장하지 못했습니다. " + err.message, true);
    }
  }

  /* ---------- 시작 ---------- */
  K.session().then((s) => {
    session = s || session;
    els.modeTag.textContent = session.server ? "서버 저장 · 팀 공유" : "이 브라우저 저장";
    els.modeTag.title = session.server ? "portfolio 권한이 있는 사람과 함께 봅니다." : "이 브라우저에만 저장됩니다. 실시간 시세는 서버 모드에서 연결됩니다.";
    const refreshBtn = $(".fr-refresh-btn");
    if (!session.server) {
      refreshBtn.title = "다시 계산 (브라우저 모드: 실시간 시세 없음)";
      refreshBtn.setAttribute("aria-label", "다시 계산");
    }
    schedule();
    load();
  });
})();
