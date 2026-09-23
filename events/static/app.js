/* 기업·테마 이벤트 — 월별 달력/표, 갈래·섹터 필터, 검색, 추가·수정·삭제, 붙여넣기(여러 줄 → 여러 일정), CSV, 사용법 안내.
 * 경제지표(경제 캘린더에 직접 입력한 일정 + 서버 모드 EODHD 자동 수집)도 같은 달력에 함께 보여 준다. */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const store = K.collection("theme-events");
  const ecoStore = K.collection("economic-events");

  const MAX_CHIPS = 4;
  const CAT_LABEL = { event: "이벤트", earnings: "실적발표", economic: "경제지표" };
  const PREC_LABEL = { day: "정확한 날짜", month: "월 단위 (○월 중)", quarter: "분기 단위", tbd: "날짜 미정" };
  const SECTORS = [
    ["반도체", "#2563eb"], ["2차전지", "#16a34a"], ["자동차", "#0891b2"], ["IT·인터넷", "#7c3aed"], ["게임·엔터", "#db2777"],
    ["바이오·헬스케어", "#dc2626"], ["조선·기계", "#0f766e"], ["방산·우주", "#475569"], ["화학·에너지", "#ea580c"], ["철강·소재", "#78716c"],
    ["건설·부동산", "#a16207"], ["금융", "#1d4ed8"], ["소비재·유통", "#c026d3"], ["통신·미디어", "#0284c7"], ["운송·물류", "#65a30d"], ["정책·거시", "#b45309"],
  ];
  const SECTOR_COLOR = Object.fromEntries(SECTORS);
  const PALETTE = ["#0e7490", "#9333ea", "#be123c", "#15803d", "#b45309", "#4338ca", "#0f766e", "#a21caf", "#4d7c0f", "#c2410c"];
  const ECO_COLOR = "#00857b";
  const MAJOR = ["KR", "US", "CN", "JP", "EU", "GB"];
  const COUNTRY = { KR: "한국", US: "미국", CN: "중국", JP: "일본", EU: "유로존", GB: "영국", DE: "독일", FR: "프랑스", IT: "이탈리아", CA: "캐나다", AU: "호주", IN: "인도", CH: "스위스", TW: "대만", HK: "홍콩" };
  const COUNTRY_ALIAS = { UK: "GB", EZ: "EU", EA: "EU", EMU: "EU", 한국: "KR", 미국: "US", 중국: "CN", 일본: "JP", 유로존: "EU", 영국: "GB" };
  const SEP = "›";

  let session = { server: false, me: null, api: null };
  let connected = null;
  let items = []; // theme-events
  let ecoManual = []; // economic-events
  let ecoApi = [];
  const eco = { loading: false, loadedAt: "", error: "", range: null };
  const ecoCache = new Map();
  let ecoToken = 0;
  let unitMap = new Map();

  const savedS1 = K.prefs.get("evx.s1", []);
  const state = {
    view: K.prefs.get("evx.view", "month") === "table" ? "table" : "month",
    anchor: K.monthStart(K.today()),
    cat: K.prefs.get("evx.cat", "all"),
    q: "",
    s1: new Set(Array.isArray(savedS1) ? savedS1 : []),
    s2: new Set(),
  };
  if (!["all", "event", "earnings", "economic"].includes(state.cat)) state.cat = "all";

  const grid = $("#evx-grid");
  const bands = $("#evx-bands");
  const monthView = $("#evx-month-view");
  const tableView = $("#evx-table-view");
  const legend1 = $("#evx-legend1");
  const statusEl = $("#evx-economic-status");

  /* ---------- 공통 도우미 ---------- */
  function sectorColor(name) {
    if (!name) return "";
    if (SECTOR_COLOR[name]) return SECTOR_COLOR[name];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function normCountry(v) {
    const s = String(v || "").trim();
    const up = s.toUpperCase();
    return COUNTRY_ALIAS[s] || COUNTRY_ALIAS[up] || up;
  }
  function countryName(c) {
    return COUNTRY[c] || c || "";
  }
  function canDelete(raw) {
    if (!session.server) return true;
    const me = session.me || {};
    return me.role === "admin" || me.role === "super" || !raw.createdById || raw.createdById === me.id;
  }
  function validDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !!K.parse(s) && K.ymd(K.parse(s)) === s;
  }
  function monthEnd(s) {
    return s.slice(0, 8) + K.pad(K.daysInMonth(s));
  }
  function quarterOf(s) {
    return Math.floor((+s.slice(5, 7) - 1) / 3) + 1;
  }
  function quarterStart(y, q) {
    return y + "-" + K.pad((q - 1) * 3 + 1) + "-01";
  }
  function quarterEnd(s) {
    const q = quarterOf(s);
    return monthEnd(s.slice(0, 5) + K.pad(q * 3) + "-01");
  }
  function yearOf(s) {
    return +s.slice(0, 4);
  }
  function tickerText(t) {
    return (t || []).map((x) => (x.name || x.code) + (x.code && x.name ? "(" + x.code + ")" : "")).join("; ");
  }
  function companyHref(t) {
    return "/company/?q=" + encodeURIComponent(t.name || t.code || "");
  }

  /* ---------- 보기 단위로 바꾸기 ---------- */
  function themeUnit(x) {
    const precision = ["day", "month", "quarter", "tbd"].includes(x.precision) ? x.precision : x.date ? "day" : "tbd";
    return {
      key: "t:" + x.id, kind: "theme", raw: x, cat: x.category === "earnings" ? "earnings" : "event",
      title: x.title || "(제목 없음)", precision, date: precision === "tbd" ? "" : x.date || "",
      endDate: precision === "day" && x.endDate && x.endDate > x.date ? x.endDate : "",
      time: precision === "day" ? x.time || "" : "", sector1: x.sector1 || "", sector2: x.sector2 || "",
      desc: x.description || "", tickers: Array.isArray(x.tickers) ? x.tickers : [], source: x.source || "",
    };
  }
  function ecoUnit(x, auto) {
    const c = normCountry(x.country);
    return {
      key: (auto ? "a:" : "m:") + x.id, kind: auto ? "eco-auto" : "eco", raw: x, cat: "economic",
      title: x.title || "(지표 이름 없음)", precision: "day", date: x.date || "", endDate: "", time: x.time || "",
      sector1: "", sector2: "", desc: x.memo || "", tickers: [], source: auto ? x.source || "EODHD" : "직접 입력",
      country: c, countryName: countryName(c), period: x.period || "", actual: x.actual, forecast: x.forecast, previous: x.previous,
    };
  }
  function allUnits() {
    return items.map(themeUnit).concat(ecoManual.filter((x) => validDate(x.date)).map((x) => ecoUnit(x, false)), ecoApi.map((x) => ecoUnit(x, true)));
  }
  function startOf(u) {
    return u.date;
  }
  function endOf(u) {
    if (u.precision === "month") return monthEnd(u.date);
    if (u.precision === "quarter") return quarterEnd(u.date);
    return u.endDate || u.date;
  }
  function covers(u, from, to) {
    if (u.precision === "tbd" || !u.date) return false;
    return startOf(u) <= to && endOf(u) >= from;
  }
  function whenText(u, withYear) {
    const y = u.date ? yearOf(u.date) + "년 " : "";
    if (u.precision === "tbd" || !u.date) return "날짜 미정";
    if (u.precision === "month") return y + (+u.date.slice(5, 7)) + "월 중";
    if (u.precision === "quarter") return y + quarterOf(u.date) + "분기";
    let s = (withYear ? y : "") + K.kLabel(u.date);
    if (u.endDate) s += " ~ " + K.kLabel(u.endDate);
    if (u.time) s += " · " + u.time + (u.kind !== "theme" ? " KST" : "");
    return s;
  }
  function shortWhen(u) {
    if (u.precision === "tbd" || !u.date) return "미정";
    if (u.precision === "month") return (+u.date.slice(5, 7)) + "월 중";
    if (u.precision === "quarter") return (yearOf(u.date) !== yearOf(state.anchor) ? yearOf(u.date) + " " : "") + quarterOf(u.date) + "분기";
    return K.md(u.date) + "(" + K.weekdayName(u.date) + ")" + (u.endDate ? "~" + K.md(u.endDate) : "");
  }
  function colorOf(u) {
    if (u.cat === "economic") return ECO_COLOR;
    return sectorColor(u.sector1) || "var(--evx-none)";
  }
  function metaText(u) {
    if (u.cat === "economic") return [u.time ? u.time + " KST" : "", u.countryName].filter(Boolean).join(" · ");
    return [u.time, u.sector2 || u.sector1, u.tickers.slice(0, 2).map((t) => t.name || t.code).join(", ")].filter(Boolean).join(" · ");
  }
  function isPast(u) {
    const t = K.today();
    if (u.precision === "tbd" || !u.date) return false;
    return endOf(u) < t;
  }

  /* ---------- 거르기 ---------- */
  function passes(u, ignoreCat) {
    if (!ignoreCat && state.cat !== "all" && u.cat !== state.cat) return false;
    if (state.s1.size) {
      const s1 = u.sector1 || "__none__";
      if (!state.s1.has(s1)) return false;
      if (u.sector1) {
        const subs = Array.from(state.s2).filter((k) => k.startsWith(u.sector1 + SEP));
        if (subs.length && !state.s2.has(u.sector1 + SEP + (u.sector2 || ""))) return false;
      }
    }
    if (state.q) {
      const hay = [u.title, u.desc, u.sector1, u.sector2, u.country, u.countryName, u.period, CAT_LABEL[u.cat], u.tickers.map((t) => (t.name || "") + " " + (t.code || "")).join(" ")]
        .join(" ").toLowerCase();
      if (!state.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
    }
    return true;
  }
  function periodRange() {
    if (state.view === "table") {
      const y = state.anchor.slice(0, 4);
      return [y + "-01-01", y + "-12-31"];
    }
    return [state.anchor, monthEnd(state.anchor)];
  }
  function byWhen(a, b) {
    const ka = a.precision === "tbd" || !a.date ? "9999" : a.date;
    const kb = b.precision === "tbd" || !b.date ? "9999" : b.date;
    const pr = { day: 2, month: 1, quarter: 0, tbd: 3 };
    return ka.localeCompare(kb) || pr[a.precision] - pr[b.precision] || (a.time || "99").localeCompare(b.time || "99") ||
      (a.cat === "economic" ? 1 : 0) - (b.cat === "economic" ? 1 : 0) || a.title.localeCompare(b.title, "ko");
  }

  /* ---------- 그리기 ---------- */
  function render() {
    const units = allUnits();
    unitMap = new Map(units.map((u) => [u.key, u]));
    renderLegend(units);
    const [from, to] = periodRange();
    const inPeriod = units.filter((u) => covers(u, from, to));
    const tbd = units.filter((u) => u.precision === "tbd" || !u.date);
    // 갈래 개수 (갈래 필터만 빼고 나머지 필터 적용)
    const base = inPeriod.concat(tbd).filter((u) => passes(u, true));
    const counts = { all: base.length, event: 0, earnings: 0, economic: 0 };
    base.forEach((u) => counts[u.cat]++);
    $$("#evx-cats .evx-cat").forEach((b) => {
      const c = b.getAttribute("data-cat");
      const on = c === state.cat;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.classList.toggle("is-empty", !counts[c]);
      const n = $(".evx-cat__n", b);
      if (n) n.textContent = String(counts[c] || 0);
    });
    const shown = inPeriod.filter((u) => passes(u)).sort(byWhen);
    const shownTbd = tbd.filter((u) => passes(u)).sort(byWhen);
    const y = yearOf(state.anchor);
    const m = +state.anchor.slice(5, 7);
    $("#evx-label").textContent = state.view === "table" ? y + "년" : y + "년 " + m + "월";
    $("#evx-count").textContent = (state.view === "table" ? y + "년 " : y + "년 " + m + "월 ") + shown.length + "건 · 날짜 미정 " + shownTbd.length + "건";
    $("#evx-view-month").classList.toggle("is-active", state.view === "month");
    $("#evx-view-table").classList.toggle("is-active", state.view === "table");
    $("#evx-view-month").setAttribute("aria-selected", state.view === "month" ? "true" : "false");
    $("#evx-view-table").setAttribute("aria-selected", state.view === "table" ? "true" : "false");
    monthView.hidden = state.view !== "month";
    tableView.hidden = state.view !== "table";
    if (state.view === "month") renderMonth(shown, shownTbd);
    else renderTable(shown, shownTbd);
    renderStatus();
  }

  function renderLegend(units) {
    const present = new Map();
    items.forEach((x) => {
      if (!x.sector1) return;
      if (!present.has(x.sector1)) present.set(x.sector1, new Set());
      if (x.sector2) present.get(x.sector1).add(x.sector2);
    });
    const order = SECTORS.map((s) => s[0]);
    const names = Array.from(present.keys()).sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, "ko");
    });
    // 없어진 섹터 선택은 지운다
    Array.from(state.s1).forEach((s) => {
      if (s !== "__none__" && !present.has(s)) state.s1.delete(s);
    });
    Array.from(state.s2).forEach((k) => {
      const [a, b] = k.split(SEP);
      if (!state.s1.has(a) || !present.has(a) || !present.get(a).has(b)) state.s2.delete(k);
    });
    const item = (value, label, color, checked) =>
      '<label class="evx-legend__item"><input type="checkbox" class="evx-legend__check" value="' + esc(value) + '"' + (checked ? " checked" : "") + ">" +
      '<span class="evx-legend__dot' + (color ? "" : " evx-legend__dot--none") + '"' + (color ? ' style="background:' + color + '"' : "") + "></span>" + esc(label) + "</label>";
    legend1.innerHTML = '<legend class="evx-legend__title">대분류</legend>' +
      names.map((n) => item(n, n, sectorColor(n), state.s1.has(n))).join("") + item("__none__", "섹터 없음", "", state.s1.has("__none__"));
    let sub = $("#evx-legend2");
    const subs = names.filter((n) => state.s1.has(n) && present.get(n).size);
    if (!subs.length) {
      if (sub) sub.remove();
      return;
    }
    if (!sub) {
      sub = document.createElement("fieldset");
      sub.className = "evx-legend evx-legend--sub";
      sub.id = "evx-legend2";
      legend1.after(sub);
    }
    sub.innerHTML = '<legend class="evx-legend__title">소분류</legend>' +
      subs.map((n) => Array.from(present.get(n)).sort((a, b) => a.localeCompare(b, "ko")).map((s) => item(n + SEP + s, s, sectorColor(n), state.s2.has(n + SEP + s))).join("")).join("");
  }

  function chipHtml(u, day) {
    const meta = metaText(u) + (u.endDate && day ? " · ~" + K.md(u.endDate) : "");
    return '<button type="button" class="evx-chip evx-chip--' + u.cat + '" data-key="' + esc(u.key) + '" style="border-left-color:' + colorOf(u) + '" title="' +
      esc(u.title + (meta ? " · " + meta : "")) + '"><span class="evx-chip__title">' + esc(u.title) + "</span>" + (meta ? '<span class="evx-chip__meta">' + esc(meta) + "</span>" : "") + "</button>";
  }
  function bandItem(u) {
    const meta = u.cat === "economic" ? metaText(u) : [CAT_LABEL[u.cat], u.sector1, u.tickers.slice(0, 2).map((t) => t.name || t.code).join(", ")].filter(Boolean).join(" · ");
    return '<button type="button" class="evx-band__item" data-key="' + esc(u.key) + '" style="border-left-color:' + colorOf(u) + '"><span class="evx-band__when">' + esc(shortWhen(u)) +
      '</span><span class="evx-band__text">' + esc(u.title) + "</span>" + (meta ? '<span class="evx-band__meta">' + esc(meta) + "</span>" : "") + "</button>";
  }
  function renderMonth(shown, shownTbd) {
    const start = state.anchor;
    const n = K.daysInMonth(start);
    const today = K.today();
    const loose = shown.filter((u) => u.precision === "month" || u.precision === "quarter");
    const exact = shown.filter((u) => u.precision === "day");
    let bandHtml = "";
    if (!items.length && !ecoManual.length && !ecoApi.length) {
      bandHtml += '<div class="evx-band"><p class="evx-band__title">아직 등록된 일정이 없습니다 <span class="evx-band__sub">· <b>+ 이벤트 추가</b>, <b>이미지/텍스트 붙여넣기</b>, <b>CSV 가져오기</b>로 일정을 넣어 보세요. 경제지표는 경제 캘린더에서 넣습니다.</span></p></div>';
    }
    if (loose.length) {
      bandHtml += '<div class="evx-band"><p class="evx-band__title">' + (+start.slice(5, 7)) + '월 중 일정 <span class="evx-band__sub">· 날짜가 월·분기 단위로만 정해진 일정 ' + loose.length + "건</span></p>" +
        '<div class="evx-band__list">' + loose.map(bandItem).join("") + "</div></div>";
    }
    if (shownTbd.length) {
      bandHtml += '<div class="evx-band"><p class="evx-band__title">날짜 미정 <span class="evx-band__sub">· 날짜가 정해지면 눌러서 수정하세요 ' + shownTbd.length + "건</span></p>" +
        '<div class="evx-band__list">' + shownTbd.map(bandItem).join("") + "</div></div>";
    }
    bands.innerHTML = bandHtml;
    const lead = K.weekday(start);
    let html = "";
    for (let i = 0; i < lead; i++) html += '<div class="evx-cell evx-cell--blank"></div>';
    for (let d = 1; d <= n; d++) {
      const day = start.slice(0, 8) + K.pad(d);
      const w = K.weekday(day);
      const list = exact.filter((u) => covers(u, day, day));
      const cls = "evx-cell" + (w === 0 ? " evx-cell--sun" : w === 6 ? " evx-cell--sat" : "") + (day === today ? " evx-cell--today" : "");
      html += '<div class="' + cls + '" data-date="' + day + '"><span class="evx-cell__date">' + d + '</span><div class="evx-cell__events">' +
        list.slice(0, MAX_CHIPS).map((u) => chipHtml(u, day)).join("") +
        (list.length > MAX_CHIPS ? '<button type="button" class="evx-more" data-more-day="' + day + '" aria-label="' + esc(K.kLabel(day)) + " 이벤트 전체 " + list.length + '건 보기">+ ' + (list.length - MAX_CHIPS) + "건 더보기</button>" : "") +
        "</div></div>";
    }
    const tail = (7 - ((lead + n) % 7)) % 7;
    for (let i = 0; i < tail; i++) html += '<div class="evx-cell evx-cell--blank"></div>';
    grid.innerHTML = html;
  }

  function valuesHtml(u, compact) {
    const v = (x) => (x == null || x === "" ? "—" : esc(String(x)));
    return '<dl class="evx-economic-values' + (compact ? " is-compact" : "") + '"><div><dt>발표치</dt><dd>' + v(u.actual) + "</dd></div><div><dt>예상치</dt><dd>" + v(u.forecast) +
      "</dd></div><div><dt>이전치</dt><dd>" + v(u.previous) + "</dd></div></dl>";
  }
  function tagsHtml(u) {
    return u.tickers.map((t) => '<a class="evx-tag" href="' + esc(companyHref(t)) + '" title="종목 분석에서 보기">' + esc(t.name || t.code) +
      (t.code && t.name ? '<span class="evx-tag__code">' + esc(t.code) + "</span>" : "") + "</a>").join("");
  }
  function renderTable(shown, shownTbd) {
    const rows = shown.concat(shownTbd);
    const today = K.today();
    let prevMonth = null;
    const body = rows.map((u) => {
      const monthKey = u.precision === "tbd" || !u.date ? "tbd" : u.precision === "quarter" ? "q" + quarterOf(u.date) : u.date.slice(0, 7);
      const newMonth = prevMonth !== null && monthKey !== prevMonth;
      prevMonth = monthKey;
      let mCol;
      let dCol;
      if (u.precision === "tbd" || !u.date) {
        mCol = "미정";
        dCol = '<span class="evx-dim">—</span>';
      } else if (u.precision === "quarter") {
        mCol = (yearOf(u.date) !== yearOf(state.anchor) ? yearOf(u.date) + "년 " : "") + quarterOf(u.date) + "분기";
        dCol = '<span class="evx-dim">—</span>';
      } else if (u.precision === "month") {
        mCol = (+u.date.slice(5, 7)) + "월";
        dCol = "중";
      } else {
        mCol = (+u.date.slice(5, 7)) + "월";
        dCol = (+u.date.slice(8, 10)) + " (" + K.weekdayName(u.date) + ")" + (u.endDate ? " ~ " + K.md(u.endDate) : "");
      }
      const sector = u.cat === "economic"
        ? esc(u.countryName || u.country || "")
        : u.sector1 ? '<span class="evx-sectordot" style="background:' + sectorColor(u.sector1) + '"></span>' + esc(u.sector1 + (u.sector2 ? " " + SEP + " " + u.sector2 : "")) : '<span class="evx-dim">—</span>';
      const small = u.cat === "economic"
        ? [u.time ? u.time + " KST" : "", u.period ? "기간 " + u.period : "", u.kind === "eco" ? "직접 입력" : "EODHD"].filter(Boolean).join(" · ")
        : [u.time, u.desc.length > 90 ? u.desc.slice(0, 90) + "…" : u.desc].filter(Boolean).join(" · ");
      const acts = u.kind === "theme"
        ? '<button type="button" class="evx-rowbtn" data-edit="' + esc(u.key) + '">수정</button>' + (canDelete(u.raw) ? '<button type="button" class="evx-rowbtn" data-del="' + esc(u.key) + '">삭제</button>' : "")
        : '<button type="button" class="evx-rowbtn" data-key="' + esc(u.key) + '">보기</button>';
      return '<tr class="evx-row' + (isPast(u) && u.date < today ? " evx-row--past" : "") + (newMonth ? " evx-row--newmonth" : "") + '" data-row="' + esc(u.key) + '">' +
        '<td class="evx-td--month">' + esc(mCol) + '</td><td class="evx-td--day">' + dCol + "</td>" +
        '<td><span class="evx-badge evx-badge--' + u.cat + '">' + CAT_LABEL[u.cat] + "</span></td>" +
        '<td class="evx-td--sector">' + sector + "</td>" +
        '<td class="evx-td--title">' + esc(u.title) + (small ? "<small>" + esc(small) + "</small>" : "") + "</td>" +
        '<td class="evx-td--tickers">' + (u.cat === "economic" ? valuesHtml(u, true) : tagsHtml(u) || '<span class="evx-dim">—</span>') + "</td>" +
        '<td class="evx-td--actions">' + acts + "</td></tr>";
    }).join("");
    tableView.innerHTML = '<table class="evx-table"><thead><tr><th scope="col">월</th><th scope="col">일</th><th scope="col">구분</th><th scope="col">섹터·국가</th><th scope="col">제목</th><th scope="col">종목·수치</th><th scope="col"><span class="sr-only">관리</span></th></tr></thead><tbody>' +
      (body || '<tr class="evx-empty-row"><td colspan="7">' + yearOf(state.anchor) + "년에 조건에 맞는 일정이 없습니다.<br><small>필터·검색어를 확인하거나 <b>+ 이벤트 추가</b>로 일정을 넣어 보세요.</small></td></tr>") +
      "</tbody></table>";
  }

  function renderStatus() {
    const nManual = ecoManual.length;
    statusEl.classList.remove("is-stale");
    if (!session.server) {
      statusEl.classList.add("is-stale");
      statusEl.textContent = "경제지표: 경제 캘린더에 직접 입력한 일정 " + nManual + "건을 함께 보여 줍니다 · 자동 수집(EODHD)은 서버 모드에서 연결됩니다.";
    } else if (connected === false) {
      statusEl.classList.add("is-stale");
      statusEl.textContent = "경제지표 자동 수집(EODHD) 연결 안 됨 · 관리자가 EODHD_API_KEY 를 설정하면 채워집니다. 지금은 경제 캘린더에 직접 입력한 일정 " + nManual + "건만 보여 줍니다.";
    } else if (eco.loading) {
      statusEl.textContent = "경제지표 자동 수집 자료를 불러오는 중…";
    } else if (eco.error) {
      statusEl.classList.add("is-stale");
      statusEl.textContent = "경제지표 자동 수집 자료를 불러오지 못했습니다: " + eco.error;
    } else if (eco.range) {
      statusEl.textContent = "경제지표 EODHD 자동 수집 · 불러온 시각 " + K.dot(eco.loadedAt) + " KST · 수집 범위 " + K.dot(eco.range[0]) + " ~ " + K.dot(eco.range[1]) +
        " (주요 6개국·지역) · 직접 입력 " + nManual + "건";
    } else {
      statusEl.classList.add("is-stale");
      statusEl.textContent = "이 기간은 경제지표 자동 수집 범위(오늘 기준 앞뒤 몇 달) 밖입니다 · 직접 입력 " + nManual + "건";
    }
  }

  /* ---------- 자동 수집 경제지표 ---------- */
  function ecoWindow() {
    const [from, to] = periodRange();
    if (state.view === "month") return [from, to];
    // 표(연간) 보기는 오늘 앞뒤 몇 달만 불러온다
    const t = K.today();
    const s = K.addMonths(K.monthStart(t), -1);
    const e = monthEnd(K.addMonths(K.monthStart(t), 2));
    const a = from > s ? from : s;
    const b = to < e ? to : e;
    return a <= b ? [a, b] : null;
  }
  async function loadEco() {
    if (!session.server || !connected) return;
    const win = ecoWindow();
    const token = ++ecoToken;
    if (!win) {
      ecoApi = [];
      eco.range = null;
      eco.error = "";
      render();
      return;
    }
    const chunks = [];
    for (let s = win[0]; s <= win[1]; s = K.addDays(s, 7)) chunks.push([s, K.addDays(s, 6) < win[1] ? K.addDays(s, 6) : win[1]]);
    eco.loading = true;
    renderStatus();
    try {
      const lists = await Promise.all(chunks.map(([s, e]) => {
        const key = s + "|" + e;
        if (!ecoCache.has(key)) {
          const p = session.api("GET", "/api/economic?start=" + s + "&end=" + e).then((r) => (r && r.items) || []);
          p.catch(() => ecoCache.delete(key));
          ecoCache.set(key, p);
        }
        return ecoCache.get(key);
      }));
      if (token !== ecoToken) return;
      const seen = new Set();
      ecoApi = lists.flat().filter((x) => {
        if (seen.has(x.id) || !MAJOR.includes(normCountry(x.country))) return false;
        seen.add(x.id);
        return true;
      });
      eco.range = win;
      eco.error = "";
      eco.loadedAt = K.today() + " " + K.nowTime();
    } catch (err) {
      if (token !== ecoToken) return;
      if (/연결되지 않았/.test(err.message)) connected = false;
      else eco.error = err.message;
      ecoApi = [];
    }
    eco.loading = false;
    render();
  }

  /* ---------- 상세 보기 ---------- */
  function detailHtml(u) {
    let h = '<p class="evx-view__when">' + esc(whenText(u, true)) + ' <span class="evx-badge evx-badge--' + u.cat + '">' + CAT_LABEL[u.cat] + "</span></p>";
    if (u.cat === "economic") {
      h += '<p class="evx-view__sector">' + esc([u.countryName ? u.countryName + " (" + u.country + ")" : "", u.period ? "기간 " + u.period : ""].filter(Boolean).join(" · ")) + "</p>";
      h += valuesHtml(u, false);
      if (u.desc) h += '<p class="evx-view__desc">' + esc(u.desc) + "</p>";
      h += '<p class="evx-view__meta">출처: ' + esc(u.kind === "eco" ? "경제 캘린더 직접 입력" + (u.raw.createdBy ? " · " + u.raw.createdBy : "") : "EODHD 자동 수집") + "</p>";
      return h;
    }
    if (u.sector1) h += '<p class="evx-view__sector"><span class="evx-sectordot" style="background:' + sectorColor(u.sector1) + '"></span>' + esc(u.sector1 + (u.sector2 ? " " + SEP + " " + u.sector2 : "")) + "</p>";
    if (u.desc) h += '<p class="evx-view__desc">' + esc(u.desc) + "</p>";
    if (u.tickers.length) h += '<p class="evx-view__label">관련 종목</p><div class="evx-view__tickers">' + tagsHtml(u) + "</div>";
    if (u.source) {
      const isUrl = /^https?:\/\//i.test(u.source);
      h += '<p class="evx-view__label">출처</p><p class="evx-view__source">' + (isUrl ? '<a href="' + esc(u.source) + '" target="_blank" rel="noopener noreferrer">' + esc(u.source) + "</a>" : esc(u.source)) + "</p>";
    }
    const r = u.raw;
    h += '<p class="evx-view__meta">' + esc([r.createdBy ? "등록 " + r.createdBy : "", r.createdAt ? K.isoKst(r.createdAt) : "", r.updatedAt ? "수정 " + K.isoKst(r.updatedAt) : ""].filter(Boolean).join(" · ")) + "</p>";
    return h;
  }
  function actionsHtml(u, small) {
    const sz = small ? " btn--sm" : "";
    if (u.kind === "theme") {
      return (canDelete(u.raw) ? '<button type="button" class="btn btn--danger btn--sm" data-act="delete" data-k="' + esc(u.key) + '">삭제</button>' : "") +
        '<div class="modal__footer-right"><button type="button" class="btn btn--primary' + sz + '" data-act="edit" data-k="' + esc(u.key) + '">수정</button></div>';
    }
    const link = "/events/economic/?start=" + u.date + "&end=" + u.date;
    return '<div class="modal__footer-right"><a class="btn btn--ghost' + sz + '" href="' + esc(link) + '">' + (u.kind === "eco" ? "경제 캘린더에서 수정" : "경제 캘린더에서 보기") + "</a></div>";
  }
  function openView(key) {
    const u = unitMap.get(key);
    if (!u) return;
    const ctx = K.modal({
      title: u.title,
      html: '<div class="modal__body"><div>' + detailHtml(u) + '</div><div class="modal__footer">' + actionsHtml(u) + "</div></div>",
    });
    ctx.modal.addEventListener("click", (e) => onAction(e, ctx));
  }
  async function onAction(e, ctx) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const u = unitMap.get(b.getAttribute("data-k"));
    if (!u) return;
    if (b.getAttribute("data-act") === "edit") {
      ctx.close(true);
      openEditor(u.raw);
    } else if (b.getAttribute("data-act") === "delete") {
      if (await removeItem(u)) ctx.close(true);
    }
  }
  async function removeItem(u) {
    if (!(await K.confirm("'" + u.title + "' 일정을 삭제할까요?", "삭제", true))) return false;
    try {
      await store.remove(u.raw.id);
      items = store.cached();
      render();
      K.toast("삭제했습니다.");
      return true;
    } catch (err) {
      K.toast(err.message, true);
      return false;
    }
  }
  function openDay(day) {
    const list = Array.from(unitMap.values()).filter((u) => u.precision === "day" && covers(u, day, day) && passes(u)).sort(byWhen);
    let open = -1;
    const ctx = K.modal({ title: K.kLabel(day) + " 일정 " + list.length + "건", size: "modal--wide", html: '<div class="modal__body"><div class="evx-day"></div></div>' });
    const box = $(".evx-day", ctx.modal);
    function draw() {
      box.innerHTML = list.map((u, i) =>
        '<div class="evx-day__row' + (i === open ? " is-open" : "") + '"><button type="button" class="evx-day__head" data-i="' + i + '" aria-expanded="' + (i === open) + '">' +
        '<span class="evx-day__bar" style="background:' + colorOf(u) + '"></span><span class="evx-day__title">' + esc(u.title) + '</span><span class="evx-day__meta">' + esc([CAT_LABEL[u.cat], metaText(u)].filter(Boolean).join(" · ")) + "</span></button>" +
        (i === open ? '<div class="evx-day__detail">' + detailHtml(u) + '<div class="modal__footer">' + actionsHtml(u, true) + "</div></div>" : "") + "</div>"
      ).join("");
    }
    draw();
    box.addEventListener("click", async (e) => {
      const h = e.target.closest("[data-i]");
      if (h) {
        const i = Number(h.getAttribute("data-i"));
        open = open === i ? -1 : i;
        draw();
        return;
      }
      onAction(e, ctx);
    });
  }

  /* ---------- 추가·수정 ---------- */
  function sectorOptions() {
    const names = new Set(SECTORS.map((s) => s[0]));
    items.forEach((x) => x.sector1 && names.add(x.sector1));
    return Array.from(names).map((n) => '<option value="' + esc(n) + '">').join("");
  }
  function openEditor(existing, preset) {
    const it = Object.assign({ category: "event", title: "", precision: "day", date: K.today(), endDate: "", time: "", sector1: "", sector2: "", description: "", tickers: [], source: "" }, preset || {}, existing || {});
    if (!it.precision) it.precision = it.date ? "day" : "tbd";
    let tickers = (Array.isArray(it.tickers) ? it.tickers : []).map((t) => Object.assign({}, t));
    let cat = it.category === "earnings" ? "earnings" : "event";
    const baseDate = it.date || K.today();
    const html =
      '<form class="modal__body" id="evx-form" novalidate>' +
      '<div class="field"><span class="field__label">구분</span><div class="segmented" role="radiogroup" aria-label="구분">' +
      '<button type="button" class="segmented__btn" data-cat="event" role="radio">이벤트</button><button type="button" class="segmented__btn" data-cat="earnings" role="radio">실적발표</button></div></div>' +
      '<label class="field"><span class="field__label">제목 <em class="required">*</em></span><input class="input" name="title" maxlength="200" placeholder="예: ○○ 신제품 발표회, △△ 3분기 잠정실적" value="' + esc(it.title) + '"></label>' +
      '<div class="field field--inline evx-precision">' +
      '<label class="field"><span class="field__label">날짜 정밀도</span><select class="input" name="precision">' +
      Object.keys(PREC_LABEL).map((k) => '<option value="' + k + '"' + (it.precision === k ? " selected" : "") + ">" + PREC_LABEL[k] + "</option>").join("") + "</select></label>" +
      '<label class="field" data-p="day"><span class="field__label">날짜 <em class="required">*</em></span><input class="input" type="date" name="date" value="' + esc(it.precision === "day" ? it.date : baseDate) + '"></label>' +
      '<label class="field" data-p="day"><span class="field__label">종료일 <span class="field__label-note">여러 날이면</span></span><input class="input" type="date" name="endDate" value="' + esc(it.endDate || "") + '"></label>' +
      '<label class="field" data-p="day"><span class="field__label">시간 <span class="field__label-note">선택</span></span><input class="input" type="time" name="time" value="' + esc(it.time || "") + '"></label>' +
      '<label class="field" data-p="month"><span class="field__label">월 <em class="required">*</em></span><input class="input" type="month" name="month" value="' + esc(baseDate.slice(0, 7)) + '"></label>' +
      '<label class="field" data-p="quarter"><span class="field__label">연도</span><input class="input" type="number" name="qyear" min="2000" max="2100" value="' + yearOf(baseDate) + '"></label>' +
      '<label class="field" data-p="quarter"><span class="field__label">분기</span><select class="input" name="quarter">' +
      [1, 2, 3, 4].map((q) => '<option value="' + q + '"' + (quarterOf(baseDate) === q ? " selected" : "") + ">" + q + "분기</option>").join("") + "</select></label>" +
      '<p class="hint" data-hint></p></div>' +
      '<div class="field-row"><label class="field"><span class="field__label">대분류 (섹터)</span><input class="input" name="sector1" list="evx-dl-s1" maxlength="40" placeholder="예: 반도체" value="' + esc(it.sector1) + '"></label>' +
      '<label class="field"><span class="field__label">소분류 <span class="field__label-note">선택</span></span><input class="input" name="sector2" list="evx-dl-s2" maxlength="40" placeholder="예: HBM" value="' + esc(it.sector2) + '"></label></div>' +
      '<datalist id="evx-dl-s1">' + sectorOptions() + '</datalist><datalist id="evx-dl-s2"></datalist>' +
      '<div class="field"><span class="field__label">관련 종목 <span class="field__label-note">— ' + (session.server ? "이름·코드를 입력하면 목록에서 고를 수 있습니다" : "이름(또는 '이름 코드')을 입력하고 Enter") + "</span></span>" +
      '<div class="evx-tickers" data-tickers></div><div class="evx-tsearch"><input class="input" data-tinput autocomplete="off" placeholder="예: 삼성전자 또는 005930" aria-label="종목 추가">' +
      '<ul class="evx-tsearch__list" role="listbox" hidden></ul></div></div>' +
      '<label class="field"><span class="field__label">설명</span><textarea class="input input--textarea" name="description" rows="3" maxlength="4000">' + esc(it.description) + "</textarea></label>" +
      '<label class="field"><span class="field__label">출처 <span class="field__label-note">링크 또는 메모</span></span><input class="input" name="source" maxlength="500" placeholder="https://" value="' + esc(it.source) + '"></label>' +
      '<div class="modal__footer">' + (existing && canDelete(existing) ? '<button type="button" class="btn btn--danger btn--sm" data-fact="delete">삭제</button>' : "") +
      '<div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-fact="cancel">취소</button><button type="submit" class="btn btn--primary">저장</button></div></div></form>';
    const ctx = K.modal({ title: existing ? "이벤트 수정" : "이벤트 추가", size: "modal--wide", html, focus: '[name="title"]' });
    const form = $("#evx-form", ctx.modal);
    const el = form.elements;
    function drawCat() {
      $$("[data-cat]", form).forEach((b) => {
        const on = b.getAttribute("data-cat") === cat;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
      });
    }
    function drawPrecision() {
      const p = el.precision.value;
      $$("[data-p]", form).forEach((n) => (n.hidden = n.getAttribute("data-p") !== p));
      $("[data-hint]", form).textContent = {
        day: "날짜가 확정된 일정입니다. 여러 날 이어지면 종료일을 넣으세요.",
        month: "‘○월 중’처럼 달만 정해진 일정은 달력 위 ‘○월 중 일정’ 칸에 모입니다.",
        quarter: "분기만 정해진 일정은 그 분기의 매달 위쪽 칸에 보입니다.",
        tbd: "날짜 미정 일정은 달력 위 ‘날짜 미정’ 칸과 표 맨 아래에 보입니다.",
      }[p];
    }
    function drawSubList() {
      const s1 = el.sector1.value.trim();
      const subs = new Set(items.filter((x) => x.sector1 === s1 && x.sector2).map((x) => x.sector2));
      $("#evx-dl-s2", ctx.modal).innerHTML = Array.from(subs).map((s) => '<option value="' + esc(s) + '">').join("");
    }
    function drawTickers() {
      $("[data-tickers]", form).innerHTML = tickers.map((t, i) =>
        '<span class="evx-ticker">' + esc(t.name || t.code) + (t.code && t.name ? '<span class="evx-ticker__code">' + esc(t.code) + "</span>" : "") +
        '<button type="button" class="evx-ticker__x" data-tdel="' + i + '" aria-label="' + esc((t.name || t.code) + " 빼기") + '">×</button></span>').join("");
    }
    drawCat();
    drawPrecision();
    drawSubList();
    drawTickers();
    el.precision.addEventListener("change", drawPrecision);
    el.sector1.addEventListener("input", drawSubList);
    const ts = tickerSearch($("[data-tinput]", form), $(".evx-tsearch__list", form), (t) => {
      if (tickers.some((x) => (x.code && x.code === t.code) || (!x.code && x.name === t.name))) return;
      tickers.push(t);
      drawTickers();
    });
    form.addEventListener("click", async (e) => {
      const c = e.target.closest("[data-cat]");
      if (c) {
        cat = c.getAttribute("data-cat");
        drawCat();
        return;
      }
      const td = e.target.closest("[data-tdel]");
      if (td) {
        tickers.splice(Number(td.getAttribute("data-tdel")), 1);
        drawTickers();
        return;
      }
      const a = e.target.closest("[data-fact]");
      if (!a) return;
      if (a.getAttribute("data-fact") === "cancel") ctx.close();
      else if (a.getAttribute("data-fact") === "delete") {
        if (await removeItem(themeUnit(existing))) ctx.close(true);
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      ts.flush();
      const p = el.precision.value;
      const data = {
        category: cat, title: el.title.value.trim(), precision: p, date: "", endDate: "", time: "",
        sector1: el.sector1.value.trim(), sector2: el.sector2.value.trim(), description: el.description.value.trim(), tickers, source: el.source.value.trim(),
      };
      if (!data.title) return K.toast("제목을 입력해 주세요.", true), el.title.focus();
      if (p === "day") {
        if (!validDate(el.date.value)) return K.toast("날짜를 골라 주세요.", true), el.date.focus();
        data.date = el.date.value;
        data.endDate = validDate(el.endDate.value) && el.endDate.value > data.date ? el.endDate.value : "";
        data.time = el.time.value || "";
      } else if (p === "month") {
        if (!/^\d{4}-\d{2}$/.test(el.month.value)) return K.toast("월을 골라 주세요.", true), el.month.focus();
        data.date = el.month.value + "-01";
      } else if (p === "quarter") {
        const y = Number(el.qyear.value);
        if (!(y >= 2000 && y <= 2100)) return K.toast("연도를 확인해 주세요.", true), el.qyear.focus();
        data.date = quarterStart(y, Number(el.quarter.value));
      }
      if (!data.sector1) data.sector2 = "";
      try {
        if (existing) await store.update(existing.id, data);
        else await store.create(data);
        items = store.cached();
        ctx.close(true);
        if (data.date && (data.date < periodRange()[0] || data.date > periodRange()[1])) {
          state.anchor = K.monthStart(data.date);
          loadEco();
        }
        render();
        K.toast("저장했습니다.");
      } catch (err) {
        K.toast(err.message, true);
      }
    });
  }

  // 종목 입력: 서버 모드는 /api/stock-search 목록, 브라우저 모드는 직접 입력
  function parseTickerText(s) {
    s = s.trim();
    if (!s) return null;
    let m = /^(.*?)[\s(（]*A?(\d{6}|[0-9A-Z]{6})[)）]?$/.exec(s);
    if (m && /\d/.test(m[2]) && (m[1].trim() || /^\d{6}$/.test(m[2]))) return { name: m[1].trim(), code: m[2] };
    return { name: s, code: "" };
  }
  function tickerSearch(input, list, onPick) {
    let found = [];
    let active = -1;
    let timer = null;
    let seq = 0;
    function draw() {
      list.hidden = !found.length;
      list.innerHTML = found.map((t, i) =>
        '<li class="evx-tsearch__item' + (i === active ? " is-active" : "") + '" role="option" data-ti="' + i + '"><span>' + esc(t.name) + '</span><span class="evx-tsearch__code">' + esc(t.code + (t.market ? " · " + t.market : "")) + "</span></li>").join("");
    }
    function pick(t) {
      onPick({ name: t.name || "", code: t.code || "" });
      input.value = "";
      found = [];
      active = -1;
      draw();
      input.focus();
    }
    input.addEventListener("input", () => {
      if (!session.server) return;
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) {
        found = [];
        draw();
        return;
      }
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const r = await session.api("GET", "/api/stock-search?q=" + encodeURIComponent(q));
          if (my !== seq) return;
          found = (r.items || []).slice(0, 12);
          active = found.length ? 0 : -1;
          draw();
        } catch (e) {
          found = [];
          draw();
        }
      }, 220);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && found.length) {
        e.preventDefault();
        active = (active + 1) % found.length;
        draw();
      } else if (e.key === "ArrowUp" && found.length) {
        e.preventDefault();
        active = (active - 1 + found.length) % found.length;
        draw();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (active >= 0 && found[active]) pick(found[active]);
        else {
          const t = parseTickerText(input.value);
          if (t) pick(t);
        }
      } else if (e.key === "Escape" && found.length) {
        e.preventDefault();
        e.stopPropagation();
        found = [];
        draw();
      }
    });
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("[data-ti]");
      if (!li) return;
      e.preventDefault();
      pick(found[Number(li.getAttribute("data-ti"))]);
    });
    input.addEventListener("blur", () => setTimeout(() => {
      found = [];
      draw();
    }, 150));
    // 저장 직전에 입력칸에 남은 글자도 종목으로 넣는다
    return {
      flush() {
        const t = parseTickerText(input.value);
        if (t) pick(t);
      },
    };
  }

  /* ---------- 붙여넣기 (여러 줄 → 여러 일정) ---------- */
  function inferYear(mo) {
    const by = yearOf(state.anchor);
    const bm = +state.anchor.slice(5, 7);
    if (mo < bm - 6) return by + 1;
    if (mo > bm + 6) return by - 1;
    return by;
  }
  function to24(ap, h) {
    h = Number(h);
    if (ap === "오후" && h < 12) h += 12;
    if (ap === "오전" && h === 12) h = 0;
    return h;
  }
  function parsePaste(text) {
    const out = [];
    let ctx = null; // 날짜만 적힌 줄(머리글)의 날짜를 다음 줄들에 쓴다
    const knownSectors = SECTORS.map((s) => s[0]).concat(items.map((x) => x.sector1).filter(Boolean));
    text.split(/\r?\n/).forEach((raw) => {
      let rest = raw.replace(/\t+/g, " ").trim().replace(/^(?:[-–•·*▶▷■□◆◇○●※>]+|\d{1,2}[.)](?=\s))\s*/, "").trim();
      if (!rest) return;
      const r = { line: raw.trim(), cat: "event", precision: "tbd", date: "", endDate: "", time: "", sector1: "", tickers: [], title: "", include: true };
      const cut = (m) => {
        rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
      };
      let m = /[[【]([^\]】]{1,20})[\]】]/.exec(rest);
      if (m) {
        r.sector1 = m[1].trim();
        cut(m);
      }
      // 시간
      m = /(오전|오후)?\s*(\d{1,2})\s*:\s*(\d{2})(?:\s*[~\-–]\s*(?:오전|오후)?\s*\d{1,2}\s*:\s*\d{2})?(?:\s*KST)?/.exec(rest);
      if (m && to24(m[1], m[2]) < 24 && +m[3] < 60) {
        r.time = K.pad(to24(m[1], m[2])) + ":" + m[3];
        cut(m);
      } else if ((m = /(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?|(?<![\d])(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?(?![가-힣])/.exec(rest))) {
        const h = m[2] ? to24(m[1], m[2]) : Number(m[4]);
        const mi = m[3] || m[5] || "0";
        if (h < 24 && +mi < 60) {
          r.time = K.pad(h) + ":" + K.pad(+mi);
          cut(m);
        }
      }
      // 요일 표기 지우기
      rest = rest.replace(/[(（]\s*[월화수목금토일]\s*[)）]/g, " ");
      // 날짜
      let y = 0;
      let mo = 0;
      let d = 0;
      if ((m = /(20\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/.exec(rest))) {
        y = +m[1];
        mo = +m[2];
        d = +m[3];
        cut(m);
      } else if ((m = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(rest)) || (m = /(?<![\d.:])(\d{1,2})\s*[/.]\s*(\d{1,2})(?![\d.%:조억만원배개명년x])/.exec(rest))) {
        mo = +m[1];
        d = +m[2];
        cut(m);
      }
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        y = y || inferYear(mo);
        const date = y + "-" + K.pad(mo) + "-" + K.pad(d);
        if (validDate(date)) {
          r.precision = "day";
          r.date = date;
          const e = /^\s*[~\-–]\s*(?:(\d{1,2})\s*[/.월]\s*)?(\d{1,2})\s*일?(?![\d:])/.exec(rest.slice(m.index));
          if (e) {
            const em = e[1] ? +e[1] : mo;
            const end = (em < mo ? y + 1 : y) + "-" + K.pad(em) + "-" + K.pad(+e[2]);
            if (validDate(end) && end > date) r.endDate = end;
            rest = rest.slice(0, m.index) + " " + rest.slice(m.index + e[0].length);
          }
        }
      }
      if (!r.date) {
        if ((m = /(?:(20\d{2})\s*년\s*)?(\d{1,2})\s*월\s*(?:초|중순|중|말|하순|상순|예정)?/.exec(rest)) && +m[2] >= 1 && +m[2] <= 12) {
          r.precision = "month";
          r.date = (m[1] ? +m[1] : inferYear(+m[2])) + "-" + K.pad(+m[2]) + "-01";
          cut(m);
        } else if ((m = /(?:(20\d{2})\s*년\s*)?([1-4])\s*분기(?:\s*중)?|(?<![A-Za-z])([1-4])Q\s*'?(\d{2})?(?![A-Za-z])|(?<![A-Za-z])Q([1-4])(?:\s*'?(\d{2,4}))?(?![A-Za-z])/i.exec(rest))) {
          const q = +(m[2] || m[3] || m[5]);
          const yy = m[1] ? +m[1] : m[4] ? 2000 + +m[4] : m[6] ? (m[6].length === 2 ? 2000 + +m[6] : +m[6]) : yearOf(state.anchor);
          // 분기 표기(3Q 등)는 제목에 남겨 둔다 (실적 대상 분기일 때가 많다)
          r.precision = "quarter";
          r.date = quarterStart(yy, q);
        } else if ((m = /(?:날짜\s*)?미정|TBD|TBA/i.exec(rest))) {
          cut(m);
        }
      }
      // 종목 "이름(005930)"
      rest = rest.replace(/([가-힣A-Za-z0-9&]+)\s*[(（]\s*A?(\d{6}|\d{5}[A-Z0-9])\s*[)）]/g, (all, name, code) => {
        r.tickers.push({ name, code });
        return name;
      });
      if (/실적|어닝|earnings|잠정치|컨퍼런스\s*콜|컨콜|conference\s*call/i.test(raw)) r.cat = "earnings";
      if (!r.sector1) {
        const hit = knownSectors.find((s) => raw.includes(s));
        if (hit) r.sector1 = hit;
      }
      r.title = rest.replace(/[(（]\s*[)）]/g, " ").replace(/\s+/g, " ").replace(/^[\s:·|,\-–~/]+|[\s:·|,\-–~/]+$/g, "").trim();
      if (!r.title) {
        // 날짜만 있는 줄은 다음 줄들의 날짜로 쓴다
        if (r.date) ctx = { precision: r.precision, date: r.date, endDate: r.endDate };
        return;
      }
      if (!r.date && ctx) Object.assign(r, ctx);
      out.push(r);
    });
    return out;
  }
  function openPaste() {
    let rows = [];
    const sectorNames = Array.from(new Set(SECTORS.map((s) => s[0]).concat(items.map((x) => x.sector1).filter(Boolean))));
    const html =
      '<div class="modal__body">' +
      '<div class="evx-drop" tabindex="0" role="button" data-drop><span class="evx-drop__icon" aria-hidden="true">⇪</span><span class="evx-drop__text"><b>텍스트 파일(.txt·.csv)을 끌어다 놓거나 눌러서 고르세요.</b> ' +
      "<em>또는 아래 칸에 증권사 일정표·메신저 안내문을 붙여넣으세요. 한 줄이 일정 한 건입니다.</em></span></div>" +
      '<p class="evx-drop__status" data-status hidden></p>' +
      '<label class="field"><span class="field__label">붙여넣을 내용 <span class="field__label-note">— 날짜(9/24, 9월 24일, 10월 중, 3Q, 미정)·시간·종목(이름(코드))·[섹터]를 찾아 나눕니다</span></span>' +
      '<textarea class="input input--textarea" rows="7" data-text placeholder="예)&#10;9/24(목) 14:00 [반도체] ○○전자(000000) 신제품 공개 행사&#10;10월 중 △△ 투자자의 날&#10;3Q ◇◇ 잠정실적 발표"></textarea></label>' +
      '<div class="evx-paste__preview" data-preview></div>' +
      '<div class="modal__footer"><span class="hint" data-summary></span><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-pact="cancel">취소</button>' +
      '<button type="button" class="btn btn--primary" data-pact="save" disabled>일정 추가</button></div></div></div>';
    const ctx = K.modal({ title: "이미지/텍스트 붙여넣기", size: "modal--wide", html, focus: "[data-text]" });
    ctx.overlay.id = "evx-paste-overlay";
    const ta = $("[data-text]", ctx.modal);
    const drop = $("[data-drop]", ctx.modal);
    const status = $("[data-status]", ctx.modal);
    const preview = $("[data-preview]", ctx.modal);
    const saveBtn = $('[data-pact="save"]', ctx.modal);
    function say(msg, isErr) {
      status.hidden = !msg;
      status.textContent = msg || "";
      status.classList.toggle("is-error", !!isErr);
    }
    function whenCell(r) {
      return shortWhen({ precision: r.precision, date: r.date, endDate: r.endDate });
    }
    function draw() {
      const n = rows.filter((r) => r.include).length;
      saveBtn.disabled = !n;
      saveBtn.textContent = n ? "일정 " + n + "건 추가" : "일정 추가";
      $("[data-summary]", ctx.modal).textContent = rows.length ? "찾은 일정 " + rows.length + "건 · 추가할 일정 " + n + "건" : "";
      if (!rows.length) {
        preview.innerHTML = ta.value.trim() ? '<p class="hint">일정으로 읽을 수 있는 줄이 없습니다.</p>' : "";
        return;
      }
      preview.innerHTML = '<table class="evx-table evx-table--preview"><thead><tr><th>구분</th><th>날짜</th><th>시간</th><th>섹터</th><th>종목</th><th>제목</th><th>원문</th><th></th></tr></thead><tbody>' +
        rows.map((r, i) =>
          '<tr class="' + (r.include ? "" : "evx-preview__drop") + '" data-r="' + i + '">' +
          '<td><select class="input" data-f="cat"><option value="event"' + (r.cat === "event" ? " selected" : "") + '>이벤트</option><option value="earnings"' + (r.cat === "earnings" ? " selected" : "") + ">실적</option></select></td>" +
          "<td>" + esc(whenCell(r)) + "</td><td>" + esc(r.time || "—") + "</td>" +
          '<td><select class="input" data-f="sector1"><option value="">없음</option>' + sectorNames.concat(r.sector1 && !sectorNames.includes(r.sector1) ? [r.sector1] : [])
            .map((s) => '<option value="' + esc(s) + '"' + (s === r.sector1 ? " selected" : "") + ">" + esc(s) + "</option>").join("") + "</select></td>" +
          "<td>" + esc(r.tickers.map((t) => t.name + " " + t.code).join(", ") || "—") + "</td>" +
          '<td><input class="input" data-f="title" value="' + esc(r.title) + '"></td>' +
          '<td title="' + esc(r.line) + '">' + esc(r.line) + "</td>" +
          '<td><button type="button" class="evx-rowbtn" data-toggle-row="' + i + '">' + (r.include ? "빼기" : "넣기") + "</button></td></tr>"
        ).join("") + "</tbody></table>";
    }
    let timer = null;
    function analyze() {
      rows = parsePaste(ta.value);
      draw();
    }
    ta.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(analyze, 200);
    });
    preview.addEventListener("change", (e) => {
      const tr = e.target.closest("[data-r]");
      const f = e.target.getAttribute("data-f");
      if (!tr || !f) return;
      rows[Number(tr.getAttribute("data-r"))][f] = e.target.value;
    });
    preview.addEventListener("input", (e) => {
      const tr = e.target.closest("[data-r]");
      if (tr && e.target.getAttribute("data-f") === "title") rows[Number(tr.getAttribute("data-r"))].title = e.target.value;
    });
    preview.addEventListener("click", (e) => {
      const b = e.target.closest("[data-toggle-row]");
      if (!b) return;
      const r = rows[Number(b.getAttribute("data-toggle-row"))];
      r.include = !r.include;
      draw();
    });
    function takeFile(file) {
      if (!file) return;
      if (/^image\//.test(file.type)) {
        say("이미지 속 글자를 읽는 기능(OCR)은 아직 연결되어 있지 않습니다. 이미지의 글자를 복사해 텍스트로 붙여넣어 주세요.", true);
        return;
      }
      drop.classList.add("is-busy");
      file.text().then((t) => {
        ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + t;
        analyze();
        say(file.name + " 을(를) 읽었습니다.");
      }).catch((err) => say("파일을 읽지 못했습니다: " + err.message, true)).finally(() => drop.classList.remove("is-busy"));
    }
    drop.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".txt,.csv,.tsv,text/plain,text/csv,image/*";
      input.addEventListener("change", () => takeFile(input.files && input.files[0]));
      input.click();
    });
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        drop.click();
      }
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("is-over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("is-over");
      takeFile(e.dataTransfer.files && e.dataTransfer.files[0]);
    });
    ctx.modal.addEventListener("paste", (e) => {
      const cd = e.clipboardData;
      if (!cd) return;
      const img = Array.from(cd.items || []).find((x) => x.kind === "file" && /^image\//.test(x.type));
      const txt = cd.getData("text/plain");
      if (img && !txt) {
        e.preventDefault();
        takeFile(img.getAsFile());
      } else if (e.target !== ta && txt) {
        e.preventDefault();
        ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + txt;
        analyze();
      }
    });
    ctx.modal.addEventListener("click", async (e) => {
      const a = e.target.closest("[data-pact]");
      if (!a) return;
      if (a.getAttribute("data-pact") === "cancel") return ctx.close();
      const pick = rows.filter((r) => r.include && r.title.trim());
      if (!pick.length) return;
      saveBtn.disabled = true;
      try {
        await store.createMany(pick.map((r) => ({
          category: r.cat, title: r.title.trim(), precision: r.precision, date: r.date, endDate: r.endDate, time: r.time,
          sector1: r.sector1, sector2: "", description: "", tickers: r.tickers, source: "붙여넣기",
        })));
        items = store.cached();
        ctx.close(true);
        const first = pick.find((r) => r.date);
        if (first && state.view === "month" && !pick.some((r) => r.date && r.date.slice(0, 7) === state.anchor.slice(0, 7))) {
          state.anchor = K.monthStart(first.date);
          loadEco();
        }
        render();
        K.toast(pick.length + "건을 추가했습니다.");
      } catch (err) {
        saveBtn.disabled = false;
        K.toast("추가하지 못했습니다: " + err.message, true);
      }
    });
  }

  /* ---------- CSV ---------- */
  const CSV_HEAD = ["구분", "날짜", "종료일", "시간", "대분류", "소분류", "제목", "설명", "종목", "출처"];
  const CSV_ALIAS = {
    category: /^(구분|분류|종류|category|type)$/i,
    date: /^(날짜|일자|date|시작일)$/i,
    endDate: /^(종료일|끝|enddate|end)$/i,
    time: /^(시간|시각|time)$/i,
    sector1: /^(대분류|섹터|sector|업종)$/i,
    sector2: /^(소분류|세부섹터|subsector)$/i,
    title: /^(제목|이벤트|일정|title|event|내용)$/i,
    description: /^(설명|메모|description|memo|note)$/i,
    tickers: /^(종목|관련종목|기업|tickers|company|companies)$/i,
    source: /^(출처|링크|source|url)$/i,
  };
  function csvDate(s) {
    s = String(s || "").trim();
    let m;
    if (!s || /^(미정|tbd|tba)$/i.test(s)) return { precision: "tbd", date: "" };
    if ((m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/.exec(s))) {
      const d = m[1] + "-" + K.pad(+m[2]) + "-" + K.pad(+m[3]);
      return validDate(d) ? { precision: "day", date: d } : null;
    }
    if ((m = /^(\d{4})\s*[-./년]?\s*(?:Q\s*([1-4])|([1-4])\s*(?:Q|분기))$/i.exec(s))) return { precision: "quarter", date: quarterStart(+m[1], +(m[2] || m[3])) };
    if ((m = /^([1-4])Q\s*'?(\d{2})$/i.exec(s))) return { precision: "quarter", date: quarterStart(2000 + +m[2], +m[1]) };
    if ((m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*월?\s*(중)?$/.exec(s)) && +m[2] >= 1 && +m[2] <= 12) return { precision: "month", date: m[1] + "-" + K.pad(+m[2]) + "-01" };
    return null;
  }
  function csvDateText(x) {
    const u = themeUnit(x);
    if (u.precision === "tbd" || !u.date) return "미정";
    if (u.precision === "month") return u.date.slice(0, 7);
    if (u.precision === "quarter") return u.date.slice(0, 4) + "-Q" + quarterOf(u.date);
    return u.date;
  }
  function parseTickers(s) {
    return String(s || "").split(/[;,/·\n]+/).map((x) => parseTickerText(x.replace(/[()（）]/g, " ").replace(/\s+/g, " "))).filter(Boolean);
  }
  function importCsv() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.txt,text/csv,text/plain";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        let text = new TextDecoder("utf-8").decode(buf);
        if (text.includes("�")) {
          try {
            text = new TextDecoder("euc-kr").decode(buf);
          } catch (e) {
            /* 그대로 */
          }
        }
        let rows = K.parseCsv(text);
        const map = {};
        (rows[0] || []).forEach((h, i) => {
          const k = Object.keys(CSV_ALIAS).find((key) => CSV_ALIAS[key].test(String(h).trim().replace(/\s+/g, "")));
          if (k && map[k] == null) map[k] = i;
        });
        if (map.title != null) rows = rows.slice(1);
        else CSV_HEAD.forEach((h, i) => (map[Object.keys(CSV_ALIAS)[i]] = i));
        let bad = 0;
        const list = [];
        rows.forEach((r) => {
          const g = (k) => (map[k] == null ? "" : String(r[map[k]] == null ? "" : r[map[k]]).trim());
          const when = csvDate(g("date"));
          const title = g("title");
          if (!when || !title) {
            bad++;
            return;
          }
          const end = when.precision === "day" && validDate(g("endDate")) && g("endDate") > when.date ? g("endDate") : "";
          const tm = /^(\d{1,2}):(\d{2})/.exec(g("time"));
          list.push({
            category: /실적|earn/i.test(g("category")) ? "earnings" : "event", title, precision: when.precision, date: when.date, endDate: end,
            time: when.precision === "day" && tm && +tm[1] < 24 ? K.pad(+tm[1]) + ":" + tm[2] : "",
            sector1: g("sector1"), sector2: g("sector1") ? g("sector2") : "", description: g("description"), tickers: parseTickers(g("tickers")), source: g("source") || "CSV",
          });
        });
        const key = (x) => (x.date || "") + "|" + (x.title || "").toLowerCase();
        const have = new Set(items.map(key));
        const fresh = list.filter((x) => !have.has(key(x)));
        const dup = list.length - fresh.length;
        if (!fresh.length) return K.toast("가져올 새 일정이 없습니다." + (dup ? " (이미 있는 일정 " + dup + "건)" : "") + (bad ? " (날짜·제목 형식 오류 " + bad + "줄)" : ""), true);
        const msg = file.name + "\n새 일정 " + fresh.length + "건을 가져올까요?" + (dup ? "\n이미 있는 일정 " + dup + "건은 건너뜁니다." : "") + (bad ? "\n날짜·제목을 읽지 못한 " + bad + "줄은 건너뜁니다." : "");
        if (!(await K.confirm(msg, "가져오기"))) return;
        await store.createMany(fresh);
        items = store.cached();
        render();
        K.toast(fresh.length + "건을 가져왔습니다.");
      } catch (err) {
        K.toast("가져오지 못했습니다: " + err.message, true);
      }
    });
    input.click();
  }
  function exportCsv() {
    const list = items.map(themeUnit).filter((u) => state.cat !== "economic" && passes(u)).sort(byWhen).map((u) => u.raw);
    if (!list.length) {
      const d = K.addDays(K.today(), 7);
      if (!items.length) {
        K.saveText("기업테마이벤트_양식.csv", K.toCsv([CSV_HEAD, ["이벤트", d, "", "14:00", "반도체", "", "(예시) 신제품 공개 행사", "", "종목명(000000)", ""], ["실적발표", d.slice(0, 7), "", "", "", "", "(예시) 3분기 잠정실적", "", "", ""]]), "text/csv;charset=utf-8");
        return K.toast("등록된 일정이 없어 CSV 양식을 내려받았습니다.");
      }
      return K.toast("내보낼 일정이 없습니다. 필터를 확인해 주세요.", true);
    }
    const rows = [CSV_HEAD].concat(list.map((x) => [
      CAT_LABEL[x.category === "earnings" ? "earnings" : "event"], csvDateText(x), x.precision === "day" ? x.endDate || "" : "", x.precision === "day" ? x.time || "" : "",
      x.sector1 || "", x.sector2 || "", x.title || "", x.description || "", tickerText(x.tickers), x.source || "",
    ]));
    K.saveText("기업테마이벤트_" + K.today().replace(/-/g, "") + ".csv", K.toCsv(rows), "text/csv;charset=utf-8");
    K.toast(list.length + "건을 CSV로 내보냈습니다.");
  }

  /* ---------- 사용법 안내 (코치마크) ---------- */
  const COACH = [
    {
      target: "#evx-paste-btn",
      title: "일정표를 <b>붙여넣기</b>로 한 번에",
      lead: "증권사 일정표나 메신저 안내문을 그대로 붙여넣으면 <b>한 줄을 일정 한 건</b>으로 나눠 미리보기를 보여 줍니다.",
      extra: '<pre class="evx-coach__sample">9/24(목) 14:00 [반도체] ○○전자(000000) 신제품 공개\n10월 중 △△ 투자자의 날\n3Q ◇◇ 잠정실적 발표</pre>' +
        '<table class="evx-coach__table"><thead><tr><th>구분</th><th>날짜</th><th>제목</th></tr></thead><tbody>' +
        '<tr><td><span class="evx-coach__tag">이벤트</span></td><td>9/24 14:00</td><td>○○전자 신제품 공개</td></tr>' +
        '<tr><td><span class="evx-coach__tag">이벤트</span></td><td>10월 중</td><td>△△ 투자자의 날</td></tr>' +
        '<tr><td><span class="evx-coach__tag evx-coach__tag--er">실적</span></td><td>3분기</td><td>3Q ◇◇ 잠정실적 발표</td></tr></tbody></table>',
      note: "<b>실적·컨콜</b>이 들어간 줄은 실적발표로, <b>[섹터]</b>는 대분류로 읽습니다. 미리보기에서 고치거나 뺄 수 있습니다.",
    },
    {
      target: "#evx-add-btn",
      title: "한 건씩 <b>직접 추가</b>",
      lead: "날짜가 정확하지 않아도 됩니다. <b>정확한 날짜 · 월 단위 · 분기 단위 · 날짜 미정</b> 중에서 고르고, 섹터와 관련 종목을 붙이세요.",
      note: "종목 태그를 누르면 <b>종목 분석</b> 화면으로 이동합니다.",
    },
    {
      target: ".evx-toolbar",
      title: "보기 방식·갈래·검색",
      lead: "<b>월별 캘린더</b>와 <b>표</b>(한 해 전체)를 바꿔 보고, 이벤트·실적발표·경제지표 갈래로 거르세요. ‹ › 로 달(표는 해)을 옮깁니다.",
      note: "경제지표는 <b>경제 캘린더</b>에 입력한 일정과 서버에서 자동 수집한 일정이 함께 나옵니다.",
    },
    {
      target: ".evx-filters",
      title: "섹터로 거르기",
      lead: "대분류에 체크하면 그 섹터 일정만 보입니다. 소분류가 있으면 아래 줄에 함께 나타납니다.",
      note: "<b>필터 초기화</b>로 갈래·섹터·검색어를 한 번에 되돌립니다.",
    },
    {
      target: "#evx-csv-import",
      title: "CSV 가져오기·내보내기",
      lead: "엑셀에서 정리한 일정을 CSV로 한꺼번에 넣고, 지금 필터에 맞는 일정을 CSV로 내려받을 수 있습니다.",
      note: "머리글: <b>구분, 날짜, 종료일, 시간, 대분류, 소분류, 제목, 설명, 종목, 출처</b> · 날짜는 2026-09-24, 2026-10(월), 2026-Q4(분기), 미정.",
    },
  ];
  function startCoach() {
    let step = 0;
    const root = document.createElement("div");
    root.className = "evx-coach";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "이벤트 캘린더 사용법");
    root.innerHTML = '<div class="evx-coach__hole"></div><div class="evx-coach__card" tabindex="-1"></div>';
    document.body.appendChild(root);
    document.body.classList.add("evx-coach-open");
    const hole = $(".evx-coach__hole", root);
    const card = $(".evx-coach__card", root);
    function place() {
      const s = COACH[step];
      const t = $(s.target);
      if (!t) return;
      const r = t.getBoundingClientRect();
      const pad = 6;
      hole.style.top = r.top - pad + "px";
      hole.style.left = r.left - pad + "px";
      hole.style.width = r.width + pad * 2 + "px";
      hole.style.height = r.height + pad * 2 + "px";
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      let top = r.bottom + 14;
      if (top + ch > vh - 8 && r.top - 14 - ch > 8) top = r.top - 14 - ch;
      top = Math.max(8, Math.min(top, vh - ch - 8));
      const left = Math.max(16, Math.min(r.left, vw - cw - 16));
      card.style.top = top + "px";
      card.style.left = left + "px";
    }
    function draw() {
      const s = COACH[step];
      card.innerHTML =
        '<div class="evx-coach__head"><span class="evx-coach__step">' + (step + 1) + " / " + COACH.length + '</span><button type="button" class="evx-coach__skip" data-c="skip">건너뛰기</button></div>' +
        '<h3 class="evx-coach__title">' + s.title + '</h3><p class="evx-coach__lead">' + s.lead + "</p>" + (s.extra || "") + (s.note ? '<p class="evx-coach__note">' + s.note + "</p>" : "") +
        '<div class="evx-coach__foot">' + (step ? '<button type="button" class="btn btn--ghost btn--sm" data-c="prev">이전</button>' : "") +
        '<button type="button" class="btn btn--primary btn--sm" data-c="next">' + (step === COACH.length - 1 ? "시작하기" : "다음") + "</button></div>";
      const t = $(s.target);
      if (t) t.scrollIntoView({ block: "center" });
      place();
      const nx = $('[data-c="next"]', card);
      if (nx) nx.focus();
    }
    function close() {
      K.prefs.set("evx.coach.done", true);
      root.remove();
      document.body.classList.remove("evx-coach-open");
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", onKey, true);
      $("#evx-help-btn").focus();
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (step < COACH.length - 1) {
          step++;
          draw();
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (step > 0) {
          step--;
          draw();
        }
      } else if (e.key === "Tab") {
        const f = $$("button", card);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    }
    card.addEventListener("click", (e) => {
      const b = e.target.closest("[data-c]");
      if (!b) return;
      const c = b.getAttribute("data-c");
      if (c === "skip") close();
      else if (c === "prev") {
        step = Math.max(0, step - 1);
        draw();
      } else if (step === COACH.length - 1) close();
      else {
        step++;
        draw();
      }
    });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("keydown", onKey, true);
    draw();
  }

  /* ---------- 이벤트 연결 ---------- */
  function setView(v) {
    state.view = v;
    K.prefs.set("evx.view", v);
    render();
    loadEco();
  }
  function shift(n) {
    state.anchor = state.view === "table" ? K.addMonths(state.anchor, 12 * n) : K.addMonths(state.anchor, n);
    render();
    loadEco();
  }
  $("#evx-view-month").addEventListener("click", () => setView("month"));
  $("#evx-view-table").addEventListener("click", () => setView("table"));
  $("#evx-prev").addEventListener("click", () => shift(-1));
  $("#evx-next").addEventListener("click", () => shift(1));
  $("#evx-today").addEventListener("click", () => {
    state.anchor = K.monthStart(K.today());
    render();
    loadEco();
  });
  $("#evx-cats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    state.cat = b.getAttribute("data-cat");
    K.prefs.set("evx.cat", state.cat);
    render();
  });
  let qTimer = null;
  $("#evx-q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      render();
    }, 150);
  });
  $(".evx-filters").addEventListener("change", (e) => {
    const c = e.target.closest(".evx-legend__check");
    if (!c) return;
    const set = c.closest("#evx-legend2") ? state.s2 : state.s1;
    if (c.checked) set.add(c.value);
    else set.delete(c.value);
    K.prefs.set("evx.s1", Array.from(state.s1));
    render();
  });
  $("#evx-filter-reset").addEventListener("click", () => {
    state.s1.clear();
    state.s2.clear();
    state.q = "";
    state.cat = "all";
    $("#evx-q").value = "";
    K.prefs.set("evx.s1", []);
    K.prefs.set("evx.cat", "all");
    render();
  });
  $("#evx-add-btn").addEventListener("click", () => openEditor(null, state.anchor.slice(0, 7) === K.today().slice(0, 7) ? null : { date: state.anchor }));
  $("#evx-paste-btn").addEventListener("click", openPaste);
  $("#evx-help-btn").addEventListener("click", startCoach);
  $("#evx-csv-import").addEventListener("click", importCsv);
  $("#evx-csv-export").addEventListener("click", exportCsv);
  document.querySelector(".page.evx").addEventListener("click", async (e) => {
    const more = e.target.closest("[data-more-day]");
    if (more) return openDay(more.getAttribute("data-more-day"));
    const ed = e.target.closest("[data-edit]");
    if (ed) {
      const u = unitMap.get(ed.getAttribute("data-edit"));
      if (u) openEditor(u.raw);
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      const u = unitMap.get(del.getAttribute("data-del"));
      if (u) removeItem(u);
      return;
    }
    if (e.target.closest("a")) return;
    const k = e.target.closest("[data-key]");
    if (k) return openView(k.getAttribute("data-key"));
    const row = e.target.closest("[data-row]");
    if (row) openView(row.getAttribute("data-row"));
  });
  // 달력 칸을 두 번 누르면 그 날짜로 새 일정
  grid.addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    const cell = e.target.closest("[data-date]");
    if (cell) openEditor(null, { date: cell.getAttribute("data-date") });
  });

  async function load() {
    try {
      const [a, b] = await Promise.all([store.list(), ecoStore.list().catch(() => [])]);
      items = a;
      ecoManual = b;
    } catch (err) {
      K.toast("일정을 불러오지 못했습니다: " + err.message, true);
    }
    render();
  }

  K.session().then(async (s) => {
    session = s;
    if (s.server) {
      try {
        const st = await s.api("GET", "/api/integrations");
        connected = !!(st && st.economic);
      } catch (e) {
        connected = false;
      }
    }
    await load();
    loadEco();
    if (!K.prefs.get("evx.coach.done", false)) startCoach();
  });
})();
