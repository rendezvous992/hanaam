/* 운용 현황 및 계획 — 펀드 목록, 월별·분기·수시 보고 작성, 첨부, 임시 저장, 검색 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const funds = K.collection("ops-funds");
  const reports = K.collection("ops-reports");

  const KINDS = {
    monthly: { label: "월별 보고", sub: "매월 1일부터 말일까지. 펀드마다 한 장씩 달마다 새로 씁니다.", write: "+ 작성하기" },
    quarterly: { label: "분기 보고", sub: "펀드 기준일에 끝나는 3개월. 기준일이 펀드마다 달라 기간도 펀드마다 다릅니다.", write: "+ 작성하기" },
    adhoc: { label: "수시 보고", sub: "마케팅팀이 펀드와 요청사항을 올리면 매니저가 그 자리에 보고를 씁니다.", write: "+ 요청 올리기" },
  };
  const VOICE = { self: "매니저 본인", proxy: "대리 작성" };
  const SKELETON = {
    status: "■ 성과\n- 수익률: \n- BM 대비: \n\n■ 주요 매매\n- \n\n■ 시장·포트폴리오 코멘트\n- ",
    plan: "■ 시장 전망\n- \n\n■ 운용 계획\n- 비중 확대: \n- 비중 축소: \n\n■ 점검할 위험 요인\n- ",
    report: "■ 요청 내용 요약\n- \n\n■ 답변\n- \n\n■ 참고 자료\n- ",
  };
  const SAMPLE =
    '<p class="ops-sample__title">운용 현황 예시</p><pre class="ops-sample__text">■ 성과\n- 수익률: +1.8% (BM +1.2%, 초과 +0.6%p)\n- 반도체·조선 비중 확대가 성과에 기여, 2차전지 약세로 일부 상쇄\n\n■ 주요 매매\n- A사 신규 편입(업황 회복 확인), B사 일부 차익 실현\n\n■ 시장·포트폴리오 코멘트\n- 금리 인하 기대 속 대형주 중심 반등, 현금 비중 3% 유지</pre>' +
    '<p class="ops-sample__title">운용 계획 예시</p><pre class="ops-sample__text">■ 시장 전망\n- 실적 발표 시즌 앞두고 업종별 차별화 예상\n\n■ 운용 계획\n- 비중 확대: 실적 개선이 확인되는 업종\n- 비중 축소: 밸류에이션 부담이 큰 종목\n\n■ 점검할 위험 요인\n- 환율 변동, 해외 금리 경로</pre>';

  let fundList = [];
  let reportList = [];
  let me = null;
  let server = false;
  let people = [];
  const params = new URLSearchParams(location.search);
  const thisMonth = K.today().slice(0, 7);
  const state = {
    kind: KINDS[params.get("kind")] ? params.get("kind") : "monthly",
    month: /^\d{4}-\d{2}$/.test(params.get("month") || "") ? params.get("month") : "",
    q: params.get("q") || "",
    sort: K.prefs.get("ops.sort", "list"),
    current: "",
  };
  if (!state.month) state.month = defaultMonth(state.kind);

  /* ---------- 날짜 ---------- */
  function defaultMonth(kind) {
    // 월별 보고는 지난달을 쓰는 때가 많다
    return kind === "monthly" ? K.addMonths(thisMonth + "-01", -1).slice(0, 7) : thisMonth;
  }
  function monthEnd(m) {
    return m + "-" + K.pad(K.daysInMonth(m + "-01"));
  }
  function monthLabel(m) {
    return m.slice(0, 4) + "년 " + Number(m.slice(5, 7)) + "월";
  }
  function nextMonth(m, n) {
    return K.addMonths(m + "-01", n).slice(0, 7);
  }
  function kstDay(iso) {
    return K.isoKst(iso || "").slice(0, 10);
  }
  // 펀드 기준일(월·일)로 그 달 안에 끝나는 가장 최근 분기
  function quarterOf(fund, m) {
    const bm = Number(fund.baseMonth) || 3;
    const bd = Number(fund.baseDay) || 31;
    let endMonth = m;
    for (let i = 0; i < 3; i++) {
      const cur = nextMonth(m, -i);
      if ((((Number(cur.slice(5, 7)) - bm) % 3) + 3) % 3 === 0) {
        endMonth = cur;
        break;
      }
    }
    const endOf = (mm) => mm + "-" + K.pad(Math.min(bd, K.daysInMonth(mm + "-01")));
    const end = endOf(endMonth);
    const start = K.addDays(endOf(nextMonth(endMonth, -3)), 1);
    return { start, end };
  }
  function cycleText(f) {
    const bm = Number(f.baseMonth) || 3;
    const months = [0, 3, 6, 9].map((d) => ((bm - 1 + d) % 12) + 1).sort((a, b) => a - b);
    const bd = Number(f.baseDay) || 31;
    return months.join("·") + "월 " + (bd >= 31 ? "말일" : bd + "일");
  }
  function cycleNo(f) {
    return (((Number(f.baseMonth) || 3) - 1) % 3) + 1;
  }
  function range(a, b) {
    return K.dot(a) + "~" + K.dot(b);
  }

  /* ---------- 사람 ---------- */
  function myName() {
    return me ? me.displayName || me.username : K.currentUser();
  }
  function splitNames(s) {
    return (s || "").split(/[,/·\n]+/).map((x) => x.trim()).filter(Boolean);
  }
  function isMine(f) {
    return !!f && splitNames(f.managers).includes(myName());
  }
  function canDelete(rec) {
    if (!server) return true;
    return me && (me.role === "admin" || me.role === "super" || rec.createdById === me.id);
  }

  /* ---------- 거르기·정렬 ---------- */
  function fundMatches(f, q) {
    if (!q) return true;
    const hay = [f.name, f.team, f.managers].join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  function reportFor(f) {
    if (state.kind === "monthly") return reportList.find((r) => r.kind === "monthly" && r.fundId === f.id && r.month === state.month);
    if (state.kind === "quarterly") {
      const q = quarterOf(f, state.month);
      return reportList.find((r) => r.kind === "quarterly" && r.fundId === f.id && r.end === q.end);
    }
    return null;
  }
  function adhocIn(month) {
    return reportList.filter((r) => r.kind === "adhoc" && kstDay(r.requestAt || r.createdAt).slice(0, 7) === month);
  }
  function sortedFunds() {
    const list = fundList.slice().sort((a, b) => (a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order) || (a.createdAt || "").localeCompare(b.createdAt || ""));
    if (state.sort === "name") list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));
    else if (state.sort === "todo") {
      const done = (f) => (state.kind === "adhoc" ? (adhocIn(state.month).some((r) => r.fundId === f.id && !r.report) ? 0 : 1) : reportFor(f) ? 1 : 0);
      list.sort((a, b) => done(a) - done(b));
    }
    return list;
  }

  /* ---------- 머리 부분 ---------- */
  function renderHead() {
    const page = $(".page.ops");
    page.setAttribute("data-kind", state.kind);
    $(".topbar__subtitle").textContent = KINDS[state.kind].sub;
    $("#ops-write").textContent = KINDS[state.kind].write;
    $$(".ops-tabs .segmented__btn").forEach((a) => {
      const on = a.getAttribute("data-kind") === state.kind;
      a.classList.toggle("is-active", on);
      a.setAttribute("aria-selected", String(on));
      a.href = linkFor({ kind: a.getAttribute("data-kind"), month: "" });
    });
    const label = $("#ops-period-label");
    label.textContent = monthLabel(state.month);
    label.setAttribute("data-month", state.month);
    const prev = nextMonth(state.month, -1);
    const next = nextMonth(state.month, 1);
    $("#ops-prev").href = linkFor({ month: prev });
    $("#ops-next").href = linkFor({ month: next });
    const atMax = next > thisMonth;
    $("#ops-next").classList.toggle("is-disabled", atMax);
    $("#ops-next").setAttribute("aria-disabled", String(atMax));
    $(".ops-side__title").textContent = monthLabel(state.month);
  }
  function linkFor(over) {
    const kind = over.kind || state.kind;
    const month = over.month === "" ? "" : over.month || state.month;
    const p = new URLSearchParams();
    if (kind !== "monthly") p.set("kind", kind);
    if (month && month !== defaultMonth(kind)) p.set("month", month);
    if (state.q) p.set("q", state.q);
    const s = p.toString();
    return "/ops/" + (s ? "?" + s : "");
  }

  /* ---------- 왼쪽 펀드 목록 ---------- */
  function renderSide() {
    const q = state.q.trim();
    const list = sortedFunds().filter((f) => fundMatches(f, q));
    const month = adhocIn(state.month);
    let done = 0;
    let total = list.length;
    $("#ops-side-list").innerHTML = list.map((f) => {
      let cls;
      let mark;
      let meta;
      if (state.kind === "adhoc") {
        const mine = month.filter((r) => r.fundId === f.id);
        const wait = mine.filter((r) => !r.report).length;
        cls = !mine.length ? "is-todo" : wait ? "" : "is-written";
        mark = !mine.length ? "·" : wait ? "!" : "✓";
        meta = mine.length ? "요청 " + mine.length + "건" + (wait ? " · 대기 " + wait : " · 모두 보고") : "요청 없음";
        if (mine.length && !wait) done++;
      } else {
        const r = reportFor(f);
        cls = r ? "is-written" : "is-todo";
        mark = r ? "✓" : "○";
        if (r) done++;
        if (state.kind === "quarterly") {
          const qq = quarterOf(f, state.month);
          meta = '<span class="ops-side__cycle" title="분기 기준일 ' + esc(cycleText(f)) + '">' + cycleNo(f) + "</span>" + esc(range(qq.start, qq.end));
        } else meta = esc(splitNames(f.managers).join(", ") || "매니저 미지정");
      }
      if (state.kind === "adhoc") meta = esc(meta);
      return (
        '<li><a class="ops-side__item ' + cls + (isMine(f) ? " is-mine" : "") + (state.current === f.id ? " is-current" : "") + '" href="#ops-e-' + esc(f.id) + '" data-jump="' + esc(f.id) + '">' +
        '<span class="ops-side__mark" aria-hidden="true">' + mark + '</span><span class="ops-side__name">' + esc(f.name) + "</span>" +
        '<span class="ops-side__meta">' + meta + "</span>" + (f.team ? '<span class="ops-side__team">' + esc(f.team) + "</span>" : "") + "</a>" +
        '<button type="button" class="ops-side__edit" data-fund-edit="' + esc(f.id) + '" aria-label="' + esc(f.name) + ' 펀드 정보 고치기" title="펀드 정보 고치기">✎</button></li>'
      );
    }).join("");
    if (state.kind === "adhoc") total = list.filter((f) => month.some((r) => r.fundId === f.id)).length;
    $("#ops-side-count").textContent = done + "/" + total;
    $("#ops-side-count").title = state.kind === "adhoc" ? "요청이 모두 보고된 펀드 / 요청이 있는 펀드" : "작성한 펀드 / 전체 펀드";
    const empty = $(".ops-side__empty");
    empty.hidden = list.length > 0;
    empty.textContent = fundList.length ? "‘" + q + "’에 맞는 펀드가 없습니다." : "펀드 목록이 비어 있습니다.";
    $("#ops-sort").value = state.sort;
  }

  /* ---------- 오른쪽 보고 목록 ---------- */
  function filesHtml(files) {
    if (!files || !files.length) return "";
    return '<div class="ops-files">' + files.map((m, i) =>
      '<button type="button" class="ops-file" data-file="' + i + '" title="내려받기"><span aria-hidden="true">📎</span><span class="ops-file__name">' + esc(m.name) + '</span><span class="ops-file__size">' + esc(K.fileSize(m.size)) + "</span></button>").join("") + "</div>";
  }
  function textBlock(cls, title, text, none) {
    return '<div class="ops-entry__block ops-entry__block--' + cls + '"><h4 class="ops-entry__block-title">' + title + "</h4>" +
      (text && text.trim() ? '<pre class="ops-entry__text">' + esc(text) + "</pre>" : '<p class="ops-entry__none">' + esc(none) + "</p>") + "</div>";
  }
  function byHtml(name, role, dept) {
    return '<span class="ops-entry__by"><span class="ops-entry__author">' + esc(name || "") + "</span>" + (role ? '<span class="ops-entry__role">' + esc(role) + "</span>" : "") + "</span>" +
      (dept ? '<span class="ops-chip ops-chip--dept">' + esc(dept) + "</span>" : "");
  }
  function whenHtml(r, created, updated) {
    const t = updated && updated !== created ? K.isoKst(updated) + " 고침" : K.isoKst(created || "");
    return '<span class="ops-entry__when">' + esc(t) + "</span>";
  }
  function roleOf(r, f) {
    if (r.voice === "proxy") return VOICE.proxy;
    return f && splitNames(f.managers).includes(r.authorName || r.createdBy) ? "매니저" : "";
  }

  function periodEntry(f) {
    const r = reportFor(f);
    const mine = isMine(f);
    const monthly = state.kind === "monthly";
    const qq = monthly ? { start: state.month + "-01", end: monthEnd(state.month) } : quarterOf(f, state.month);
    const period = r && !monthly ? { start: r.start, end: r.end } : qq;
    const chips =
      (f.team ? '<span class="ops-chip ops-chip--team">' + esc(f.team) + "</span>" : "") +
      (!monthly ? '<span class="ops-chip ops-chip--cycle" title="분기 기준일">' + esc(cycleText(f)) + "</span>" : "") +
      (mine ? '<span class="ops-chip ops-chip--mine">내 펀드</span>' : "");
    if (!r) {
      return (
        '<li class="ops-entry ops-entry--todo' + (mine ? " ops-entry--mine" : "") + '" id="ops-e-' + esc(f.id) + '" data-fund="' + esc(f.id) + '"><div class="ops-entry__head">' +
        '<h3 class="ops-entry__fund">' + esc(f.name) + "</h3>" + chips + '<span class="ops-entry__period">' + esc(range(period.start, period.end)) + "</span>" +
        '<span class="ops-chip ops-chip--wait">미작성</span><span class="ops-entry__when"></span>' +
        '<span class="ops-entry__actions"><button type="button" class="btn btn--primary btn--sm" data-write="' + esc(f.id) + '">작성하기</button></span></div>' +
        '<p class="ops-entry__none">아직 작성하지 않았습니다.' + (f.managers ? " 담당: " + esc(splitNames(f.managers).join(", ")) : "") + "</p></li>"
      );
    }
    const nextLabel = monthly ? Number(nextMonth(state.month, 1).slice(5, 7)) + "월 운용 계획" : "다음 분기 운용 계획";
    const curLabel = monthly ? Number(state.month.slice(5, 7)) + "월 운용 현황" : "분기 운용 현황";
    return (
      '<li class="ops-entry' + (mine ? " ops-entry--mine" : "") + '" id="ops-e-' + esc(f.id) + '" data-fund="' + esc(f.id) + '" data-report="' + esc(r.id) + '"><div class="ops-entry__head">' +
      '<h3 class="ops-entry__fund">' + esc(f.name) + "</h3>" + chips + '<span class="ops-entry__period">' + esc(range(period.start, period.end)) + "</span>" +
      byHtml(r.authorName || r.createdBy, roleOf(r, f), r.authorDept) + whenHtml(r, r.createdAt, r.updatedAt) +
      '<span class="ops-entry__actions"><button type="button" class="btn btn--ghost btn--sm" data-edit-report="' + esc(r.id) + '">수정</button>' +
      (canDelete(r) ? '<button type="button" class="btn btn--ghost btn--sm ops-entry__delete" data-del-report="' + esc(r.id) + '">삭제</button>' : "") + "</span></div>" +
      textBlock("status", esc(curLabel), r.status, "현황을 적지 않았습니다.") +
      textBlock("plan", esc(nextLabel), r.plan, "계획을 적지 않았습니다.") +
      filesHtml(r.files) + "</li>"
    );
  }

  function adhocEntry(r) {
    const f = fundList.find((x) => x.id === r.fundId);
    const name = f ? f.name : r.fundName || "삭제된 펀드";
    const done = !!(r.report && r.report.trim());
    return (
      '<li class="ops-entry' + (isMine(f) ? " ops-entry--mine" : "") + '" id="ops-r-' + esc(r.id) + '" data-fund="' + esc(r.fundId) + '" data-report="' + esc(r.id) + '"><div class="ops-entry__head">' +
      '<h3 class="ops-entry__fund">' + esc(name) + "</h3>" +
      (f && f.team ? '<span class="ops-chip ops-chip--team">' + esc(f.team) + "</span>" : "") +
      (done ? '<span class="ops-chip ops-chip--done">보고 완료</span>' : '<span class="ops-chip ops-chip--wait">보고 대기</span>') +
      (isMine(f) ? '<span class="ops-chip ops-chip--mine">내 펀드</span>' : "") +
      byHtml(r.requestBy || r.createdBy, "요청", r.requestDept) + whenHtml(r, r.requestAt || r.createdAt) +
      '<span class="ops-entry__actions"><button type="button" class="btn ' + (done ? "btn--ghost" : "btn--primary") + ' btn--sm" data-answer="' + esc(r.id) + '">' + (done ? "보고 고치기" : "보고 쓰기") + "</button>" +
      '<button type="button" class="btn btn--ghost btn--sm" data-edit-request="' + esc(r.id) + '">요청 고치기</button>' +
      (canDelete(r) ? '<button type="button" class="btn btn--ghost btn--sm ops-entry__delete" data-del-report="' + esc(r.id) + '">삭제</button>' : "") + "</span></div>" +
      '<div class="ops-entry__block ops-entry__block--request"><h4 class="ops-entry__block-title">요청사항</h4><pre class="ops-entry__text">' + esc(r.request || "") + "</pre>" + filesHtml(r.requestFiles).replace(/data-file=/g, "data-rfile=") + "</div>" +
      (done
        ? '<div class="ops-entry__block ops-entry__block--status"><h4 class="ops-entry__block-title">보고 · ' + esc(r.reportBy || "") + (r.voice === "proxy" ? " (대리 작성)" : "") + " · " + esc(K.isoKst(r.reportAt || "")) + "</h4>" +
          '<pre class="ops-entry__text">' + esc(r.report) + "</pre></div>" + filesHtml(r.files)
        : '<p class="ops-entry__await"><strong>보고 대기</strong> — ' + (f && f.managers ? "담당 매니저(" + esc(splitNames(f.managers).join(", ")) + ")가 " : "담당 매니저가 ") + "이 자리에 보고를 씁니다.</p>") +
      "</li>"
    );
  }

  function renderMain() {
    const q = state.q.trim();
    const empty = $(".ops-empty");
    const list = $("#ops-list");
    const note = $(".ops-heading__note");
    if (state.kind === "adhoc") {
      const shown = adhocIn(state.month).filter((r) => {
        const f = fundList.find((x) => x.id === r.fundId);
        return !q || fundMatches(f || { name: r.fundName }, q) || (r.request || "").toLowerCase().includes(q.toLowerCase());
      }).sort((a, b) => (b.requestAt || b.createdAt || "").localeCompare(a.requestAt || a.createdAt || ""));
      const doneN = shown.filter((r) => r.report && r.report.trim()).length;
      $("#ops-status-title").textContent = Number(state.month.slice(5, 7)) + "월 수시 요청";
      $("#ops-status-count").textContent = shown.length + "건";
      $("#ops-plan-title").textContent = "보고 완료";
      $("#ops-plan-count").textContent = doneN + "건";
      note.textContent = range(state.month + "-01", monthEnd(state.month)) + " 요청분";
      list.innerHTML = shown.map(adhocEntry).join("");
      empty.hidden = shown.length > 0;
      empty.innerHTML = !fundList.length
        ? "펀드 목록이 비어 있습니다. 왼쪽의 <strong>+ 펀드 추가</strong>로 시작하세요."
        : q ? "‘" + esc(q) + "’에 맞는 수시 요청이 없습니다." : "이 달에 올라온 수시 요청이 없습니다. <strong>+ 요청 올리기</strong>로 펀드와 요청사항을 올려 주세요.";
      return;
    }
    const shown = sortedFunds().filter((f) => fundMatches(f, q));
    const rs = shown.map(reportFor).filter(Boolean);
    const monthly = state.kind === "monthly";
    $("#ops-status-title").textContent = monthly ? Number(state.month.slice(5, 7)) + "월 운용 현황 보고" : "분기 운용 현황 보고";
    $("#ops-status-count").textContent = rs.filter((r) => (r.status || "").trim()).length + "건";
    $("#ops-plan-title").textContent = monthly ? Number(nextMonth(state.month, 1).slice(5, 7)) + "월 운용 계획" : "다음 분기 운용 계획";
    $("#ops-plan-count").textContent = rs.filter((r) => (r.plan || "").trim()).length + "건";
    note.textContent = monthly ? range(state.month + "-01", monthEnd(state.month)) : monthLabel(state.month) + " 기준 · 펀드마다 기준일에 끝나는 3개월";
    list.innerHTML = shown.map(periodEntry).join("");
    empty.hidden = shown.length > 0;
    empty.innerHTML = !fundList.length ? "펀드 목록이 비어 있습니다. 왼쪽의 <strong>+ 펀드 추가</strong>로 시작하세요." : "‘" + esc(q) + "’에 맞는 펀드가 없습니다.";
  }

  function renderSearchNote() {
    let p = $(".ops-search__result");
    const q = state.q.trim();
    if (!q) {
      if (p) p.remove();
      return;
    }
    if (!p) {
      p = document.createElement("p");
      p.className = "ops-search__result";
      $(".ops-toolbar").appendChild(p);
    }
    const n = fundList.filter((f) => fundMatches(f, q)).length;
    p.innerHTML = "‘<strong>" + esc(q) + "</strong>’ 검색: 펀드 <strong>" + n + "</strong>개" + '<button type="button" class="ops-search__clear" data-clear-search>검색 지우기</button>';
  }

  function renderSuggest() {
    const words = new Set();
    fundList.forEach((f) => {
      if (f.name) words.add(f.name);
      if (f.team) words.add(f.team);
      splitNames(f.managers).forEach((m) => words.add(m));
    });
    $("#ops-suggest").innerHTML = Array.from(words).sort((a, b) => a.localeCompare(b, "ko")).map((w) => '<option value="' + esc(w) + '"></option>').join("");
    let dl = $("#ops-people");
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = "ops-people";
      document.body.appendChild(dl);
    }
    const names = new Set(people);
    fundList.forEach((f) => splitNames(f.managers).forEach((m) => names.add(m)));
    dl.innerHTML = Array.from(names).map((n) => '<option value="' + esc(n) + '"></option>').join("");
    let tl = $("#ops-teams");
    if (!tl) {
      tl = document.createElement("datalist");
      tl.id = "ops-teams";
      document.body.appendChild(tl);
    }
    tl.innerHTML = Array.from(new Set(fundList.map((f) => f.team).filter(Boolean))).map((n) => '<option value="' + esc(n) + '"></option>').join("");
  }

  function render() {
    renderHead();
    renderSide();
    renderMain();
    renderSearchNote();
    renderSuggest();
  }

  function navigate(over) {
    if (over.kind && over.kind !== state.kind) {
      state.kind = over.kind;
      if (!over.month) state.month = defaultMonth(state.kind);
    }
    if (over.month) state.month = over.month > thisMonth ? thisMonth : over.month;
    state.current = "";
    history.replaceState(null, "", linkFor({}));
    render();
  }

  /* ---------- 첨부 ---------- */
  function attachHtml() {
    return '<div class="field"><span class="field__label">첨부 파일 <span class="hint">(선택 · 엑셀·PDF·이미지 등)</span></span><div class="ops-attach">' +
      '<div class="ops-attach__bar" data-drop><button type="button" class="btn btn--ghost btn--sm" data-pick>파일 고르기</button><input type="file" name="files" multiple hidden>' +
      '<span class="ops-attach__hint">여기로 끌어 놓아도 됩니다.</span></div><ul class="ops-attach__list" data-attach></ul></div></div>';
  }
  // 폼 안의 첨부 목록 다루기
  function bindAttach(form, existing) {
    const keep = (existing || []).slice();
    const fresh = [];
    const input = $('input[name="files"]', form);
    const draw = () => {
      $("[data-attach]", form).innerHTML =
        keep.map((m, i) => '<li class="ops-attach__item"><span class="ops-attach__name">' + esc(m.name) + '</span><span class="ops-attach__size">' + esc(K.fileSize(m.size)) + '</span><button type="button" class="btn btn--ghost btn--sm" data-rm-keep="' + i + '">빼기</button></li>').join("") +
        fresh.map((x, i) => '<li class="ops-attach__item ops-attach__item--new"><span class="ops-attach__name">' + esc(x.file.name) + '</span><span class="ops-attach__size" data-pct="' + i + '">' + esc(K.fileSize(x.file.size)) + '</span><button type="button" class="btn btn--ghost btn--sm" data-rm-new="' + i + '">빼기</button></li>').join("");
    };
    const add = (files) => {
      Array.from(files || []).forEach((file) => fresh.push({ file }));
      draw();
    };
    $("[data-pick]", form).addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      add(input.files);
      input.value = "";
    });
    const bar = $("[data-drop]", form);
    bar.addEventListener("dragover", (e) => {
      e.preventDefault();
      bar.classList.add("is-over");
    });
    bar.addEventListener("dragleave", () => bar.classList.remove("is-over"));
    bar.addEventListener("drop", (e) => {
      e.preventDefault();
      bar.classList.remove("is-over");
      add(e.dataTransfer && e.dataTransfer.files);
    });
    form.addEventListener("click", (e) => {
      const a = e.target.closest("[data-rm-keep]");
      if (a) {
        keep.splice(Number(a.getAttribute("data-rm-keep")), 1);
        draw();
      }
      const b = e.target.closest("[data-rm-new]");
      if (b) {
        fresh.splice(Number(b.getAttribute("data-rm-new")), 1);
        draw();
      }
    });
    draw();
    return {
      dirty: () => fresh.length > 0,
      // 새 파일을 올리고 최종 목록을 돌려준다
      async upload() {
        const out = [];
        try {
          for (let i = 0; i < fresh.length; i++) {
            out.push(await K.files.put(fresh[i].file, fresh[i].file.name, (p) => {
              const el = $('[data-pct="' + i + '"]', form);
              if (el) el.textContent = "올리는 중 " + Math.round(p * 100) + "%";
            }));
          }
        } catch (err) {
          out.forEach((m) => K.files.remove(m));
          throw err;
        }
        return { files: keep.concat(out), uploaded: out };
      },
      removed: () => (existing || []).filter((m) => !keep.some((k) => k.id === m.id)),
    };
  }

  /* ---------- 보고 작성 (월별·분기·수시 답변) ---------- */
  function draftKey(kind, fundId, period, rid) {
    return "ops.draft." + kind + ":" + (rid || fundId + ":" + period);
  }
  function fundOptions(selected, list) {
    return (list || sortedFunds()).map((f) => '<option value="' + esc(f.id) + '"' + (f.id === selected ? " selected" : "") + ">" + esc(f.name) + (f.team ? " · " + esc(f.team) : "") + "</option>").join("");
  }

  function openReport(opts) {
    // opts: { fundId, report } — 수시 보고 답변이면 report 가 요청 기록
    const kind = opts.report ? opts.report.kind : state.kind;
    if (!fundList.length) {
      K.toast("먼저 왼쪽의 ‘+ 펀드 추가’로 펀드를 등록해 주세요.", true);
      return;
    }
    let editing = opts.report || null;
    const adhoc = kind === "adhoc";
    let fundId = editing ? editing.fundId : opts.fundId || (sortedFunds().find((f) => !reportFor(f) && isMine(f)) || sortedFunds().find((f) => !reportFor(f)) || sortedFunds()[0]).id;
    const fundOf = () => fundList.find((f) => f.id === fundId) || { id: fundId, name: (editing && editing.fundName) || "" };
    const initialPeriod = () => {
      if (editing && kind === "monthly") return { month: editing.month };
      if (editing && kind === "quarterly") return { start: editing.start, end: editing.end };
      if (kind === "monthly") return { month: state.month };
      return quarterOf(fundOf(), state.month);
    };
    const per = initialPeriod();
    const periodHtml =
      kind === "monthly"
        ? '<label class="field field--inline ops-form__period"><span class="field__label">보고 월</span><input class="input input--compact" type="month" name="month" value="' + esc(per.month) + '" max="' + thisMonth + '"></label>'
        : kind === "quarterly"
          ? '<div class="field field--inline ops-form__period"><span class="field__label">기간</span><span class="ops-form__range"><input class="input input--compact" type="date" name="start" value="' + esc(per.start) + '" aria-label="시작일"><span class="ops-form__tilde">~</span><input class="input input--compact" type="date" name="end" value="' + esc(per.end) + '" aria-label="끝일"></span></div>'
          : "";
    const requestHtml = adhoc
      ? '<div class="ops-form__request"><p class="ops-form__request-title">요청사항 <span class="ops-form__request-by">· ' + esc(editing.requestBy || editing.createdBy || "") + " · " + esc(K.isoKst(editing.requestAt || editing.createdAt || "")) + "</span></p>" +
        '<pre class="ops-form__request-text">' + esc(editing.request || "") + "</pre></div>"
      : "";
    const areas = adhoc
      ? [["report", "보고 내용"]]
      : [["status", ""], ["plan", ""]];
    const html =
      '<form class="modal__body" id="ops-form" novalidate>' +
      '<div class="ops-form__row"><label class="field field--inline ops-form__fund"><span class="field__label">펀드</span><select class="input input--compact" id="ops-fund" name="fund">' + fundOptions(fundId, adhoc || editing ? fundList : null) + "</select>" +
      '<span class="hint ops-form__lock-hint">고칠 때는 펀드를 바꿀 수 없습니다</span></label>' + periodHtml +
      '<label class="field field--inline ops-form__voice"><span class="field__label">작성</span><select class="input input--compact" name="voice"><option value="self">매니저 본인</option><option value="proxy">대리 작성</option></select></label></div>' +
      '<p class="ops-form__note" data-note></p>' + requestHtml +
      '<div class="ops-draft" data-draft hidden><span class="ops-draft__text">임시 저장한 글이 있습니다 <span id="ops-draft-when"></span></span>' +
      '<button type="button" class="btn btn--primary btn--sm" data-act="draft-load">불러오기</button><button type="button" class="btn btn--ghost btn--sm" data-act="draft-drop">버리기</button></div>' +
      areas.map(([name]) =>
        '<div class="field"><span class="field__label"><span data-label="' + name + '"></span><button type="button" class="ops-skeleton" data-skel="' + name + '">틀 넣기</button></span>' +
        '<textarea class="input input--textarea ops-textarea" name="' + name + '" rows="7"></textarea></div>').join("") +
      attachHtml() +
      '<details class="ops-sample"><summary class="ops-sample__head">작성 예시 보기</summary><div class="ops-sample__body">' + SAMPLE + "</div></details>" +
      '<div class="modal__footer"><span class="ops-draft__saved" data-saved></span><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-act="cancel">취소</button>' +
      '<button type="submit" class="btn btn--primary">저장</button></div></div></form>';
    let saving = false;
    const ctx = K.modal({
      title: adhoc ? "수시 보고 쓰기" : kind === "monthly" ? "월별 운용 보고" : "분기 운용 보고",
      size: "modal--wide",
      html,
      focus: adhoc ? '[name="report"]' : '[name="status"]',
      beforeClose: () => !saving,
    });
    const form = $("#ops-form", ctx.modal);
    const f = (n) => form.elements[n];
    const attach = bindAttach(form, editing ? editing.files : []);
    let lastLoaded = "";

    function periodNow() {
      if (kind === "monthly") return { month: f("month").value || state.month };
      if (kind === "quarterly") return { start: f("start").value, end: f("end").value };
      return {};
    }
    function periodKey() {
      const p = periodNow();
      return kind === "monthly" ? p.month : kind === "quarterly" ? p.end : "";
    }
    function key() {
      return draftKey(kind, fundId, periodKey(), adhoc ? editing.id : editing && editing.id);
    }
    function snapshot() {
      return JSON.stringify(areas.map(([n]) => f(n).value));
    }
    function labels() {
      const p = periodNow();
      if (kind === "monthly") {
        const m = p.month;
        $('[data-label="status"]', form).textContent = Number(m.slice(5, 7)) + "월 운용 현황";
        $('[data-label="plan"]', form).textContent = Number(nextMonth(m, 1).slice(5, 7)) + "월 운용 계획";
        $("[data-note]", form).textContent = "기간 " + range(m + "-01", monthEnd(m)) + " · 이 달 현황과 다음 달 계획을 함께 씁니다.";
      } else if (kind === "quarterly") {
        $('[data-label="status"]', form).textContent = "분기 운용 현황";
        $('[data-label="plan"]', form).textContent = "다음 분기 운용 계획";
        $("[data-note]", form).textContent = "분기 기준일 " + cycleText(fundOf()) + " · 기간은 기준일에 끝나는 3개월로 자동으로 잡힙니다. 필요하면 고쳐 쓰세요.";
      } else {
        $('[data-label="report"]', form).textContent = "보고 내용";
        $("[data-note]", form).textContent = "요청한 사람이 이 페이지에서 바로 확인합니다.";
      }
    }
    function fillFrom(rec) {
      areas.forEach(([n]) => (f(n).value = (rec && rec[n]) || ""));
      f("voice").value = (rec && rec.voice) || (isMine(fundOf()) ? "self" : server && !isMine(fundOf()) && fundOf().managers ? "proxy" : "self");
      form.classList.toggle("is-editing", !!editing);
      f("fund").disabled = !!editing;
      lastLoaded = snapshot();
      checkDraft();
      labels();
    }
    function checkDraft() {
      const d = K.prefs.get(key(), null);
      const box = $("[data-draft]", form);
      box.hidden = !(d && JSON.stringify(areas.map(([n]) => d.values[n] || "")) !== snapshot());
      if (!box.hidden) $("#ops-draft-when", form).textContent = "(" + K.isoKst(d.at) + ")";
    }
    // 같은 펀드·기간에 이미 쓴 보고가 있으면 그것을 고친다
    function syncExisting() {
      if (adhoc || (opts.report && editing === opts.report)) return;
      const pk = periodKey();
      const found = reportList.find((r) => r.kind === kind && r.fundId === fundId && (kind === "monthly" ? r.month === pk : r.end === pk));
      if (found && found !== editing) {
        editing = found;
        K.toast("이미 작성한 보고가 있어 불러왔습니다.");
      } else if (!found && editing) editing = null;
      fillFrom(editing);
    }
    fillFrom(editing);
    if (!editing && !adhoc) syncExisting();

    let timer = 0;
    form.addEventListener("input", (e) => {
      if (!areas.some(([n]) => e.target === f(n))) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const values = {};
        areas.forEach(([n]) => (values[n] = f(n).value));
        if (snapshot() === lastLoaded) return;
        K.prefs.set(key(), { values, at: new Date().toISOString() });
        $("[data-saved]", form).textContent = "임시 저장 " + K.nowTime();
      }, 600);
    });
    f("fund").addEventListener("change", () => {
      fundId = f("fund").value;
      if (kind === "quarterly") {
        const q = quarterOf(fundOf(), state.month);
        f("start").value = q.start;
        f("end").value = q.end;
      }
      syncExisting();
    });
    if (kind === "monthly") f("month").addEventListener("change", syncExisting);
    if (kind === "quarterly") f("end").addEventListener("change", syncExisting);
    form.addEventListener("click", (e) => {
      const sk = e.target.closest("[data-skel]");
      if (sk) {
        const name = sk.getAttribute("data-skel");
        const ta = f(name);
        const tpl = SKELETON[name === "report" ? "report" : name];
        ta.value = ta.value.trim() ? ta.value.replace(/\s*$/, "") + "\n\n" + tpl : tpl;
        ta.focus();
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const a = act.getAttribute("data-act");
      if (a === "cancel") ctx.close();
      else if (a === "draft-load") {
        const d = K.prefs.get(key(), null);
        if (d) areas.forEach(([n]) => (f(n).value = d.values[n] || ""));
        $("[data-draft]", form).hidden = true;
      } else if (a === "draft-drop") {
        K.prefs.set(key(), null);
        $("[data-draft]", form).hidden = true;
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (saving) return;
      const values = {};
      areas.forEach(([n]) => (values[n] = f(n).value.replace(/\s+$/, "")));
      if (!areas.some(([n]) => values[n].trim()) && !attach.dirty()) return K.toast(adhoc ? "보고 내용을 적어 주세요." : "현황이나 계획 중 하나는 적어 주세요.", true);
      const p = periodNow();
      if (kind === "quarterly" && (!p.start || !p.end || p.start > p.end)) return K.toast("기간을 바르게 넣어 주세요.", true);
      if (kind === "monthly" && !/^\d{4}-\d{2}$/.test(p.month)) return K.toast("보고 월을 골라 주세요.", true);
      const pk = periodKey();
      const clash = !adhoc && reportList.find((r) => r.kind === kind && r.fundId === fundId && (kind === "monthly" ? r.month === pk : r.end === pk) && (!editing || r.id !== editing.id));
      if (clash) return K.toast("이 펀드는 그 기간 보고가 이미 있습니다. 목록에서 그 보고를 고쳐 주세요.", true);
      const submit = $('button[type="submit"]', form);
      saving = true;
      submit.disabled = true;
      submit.textContent = "저장하는 중…";
      const oldKey = key();
      try {
        const up = await attach.upload();
        const fund = fundOf();
        const data = Object.assign({}, values, { voice: f("voice").value, files: up.files });
        if (adhoc) {
          Object.assign(data, { reportBy: myName(), reportAt: new Date().toISOString() });
          await reports.update(editing.id, data);
        } else {
          Object.assign(data, { kind, fundId, fundName: fund.name, authorName: editing ? editing.authorName || editing.createdBy : myName(), authorDept: editing ? editing.authorDept || "" : (me && me.department) || "" }, p);
          if (editing) await reports.update(editing.id, data);
          else await reports.create(data);
        }
        attach.removed().forEach((m) => K.files.remove(m));
        K.prefs.set(oldKey, null);
        reportList = reports.cached();
        saving = false;
        ctx.close(true);
        // 저장한 기간으로 이동
        if (kind === "monthly" && p.month !== state.month) state.month = p.month;
        state.current = fundId;
        render();
        jumpTo(adhoc ? "ops-r-" + editing.id : "ops-e-" + fundId);
        K.toast("저장했습니다.");
      } catch (err) {
        K.toast("저장하지 못했습니다: " + err.message, true);
      } finally {
        saving = false;
        submit.disabled = false;
        submit.textContent = "저장";
      }
    });
  }

  /* ---------- 수시 요청 ---------- */
  function openRequest(existing) {
    if (!fundList.length) {
      K.toast("먼저 왼쪽의 ‘+ 펀드 추가’로 펀드를 등록해 주세요.", true);
      return;
    }
    const html =
      '<form class="modal__body" id="ops-request-form" novalidate>' +
      '<div class="ops-form__row"><label class="field field--inline ops-form__fund"><span class="field__label">펀드</span><select class="input input--compact" id="ops-request-fund" name="fund">' +
      fundOptions(existing ? existing.fundId : "", fundList) + '</select><span class="hint ops-form__lock-hint">고칠 때는 펀드를 바꿀 수 없습니다</span></label></div>' +
      '<label class="field"><span class="field__label">요청사항 <em class="required">*</em></span><textarea class="input input--textarea ops-request-textarea" name="request" rows="6" placeholder="예) 고객 설명회용으로 이번 달 수익률 부진 사유와 향후 대응을 정리해 주세요. 목요일까지 필요합니다."></textarea></label>' +
      attachHtml() +
      '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-act="cancel">취소</button><button type="submit" class="btn btn--primary">' + (existing ? "저장" : "요청 올리기") + "</button></div></div></form>";
    let saving = false;
    const ctx = K.modal({ title: existing ? "수시 요청 고치기" : "수시 보고 요청", size: "modal--wide", html, focus: '[name="request"]', beforeClose: () => !saving });
    const form = $("#ops-request-form", ctx.modal);
    const f = (n) => form.elements[n];
    form.classList.toggle("is-editing", !!existing);
    f("fund").disabled = !!existing;
    f("request").value = existing ? existing.request || "" : "";
    const attach = bindAttach(form, existing ? existing.requestFiles : []);
    $('[data-act="cancel"]', form).addEventListener("click", () => ctx.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = f("request").value.trim();
      if (!text) return K.toast("요청사항을 적어 주세요.", true), f("request").focus();
      saving = true;
      const submit = $('button[type="submit"]', form);
      submit.disabled = true;
      try {
        const up = await attach.upload();
        const fund = fundList.find((x) => x.id === (existing ? existing.fundId : f("fund").value));
        let saved;
        if (existing) saved = await reports.update(existing.id, { request: text, requestFiles: up.files });
        else {
          saved = await reports.create({
            kind: "adhoc", fundId: fund.id, fundName: fund.name, request: text, requestFiles: up.files, requestBy: myName(), requestDept: (me && me.department) || "",
            requestAt: new Date().toISOString(), report: "", files: [],
          });
        }
        attach.removed().forEach((m) => K.files.remove(m));
        reportList = reports.cached();
        saving = false;
        ctx.close(true);
        if (!existing) state.month = thisMonth;
        state.current = fund.id;
        render();
        jumpTo("ops-r-" + saved.id);
        K.toast(existing ? "고쳤습니다." : "요청을 올렸습니다.");
      } catch (err) {
        K.toast("저장하지 못했습니다: " + err.message, true);
      } finally {
        saving = false;
        submit.disabled = false;
      }
    });
  }

  async function deleteReport(r) {
    const what = r.kind === "adhoc" ? "이 수시 요청" + (r.report ? "과 보고" : "") : "이 보고";
    if (!(await K.confirm(what + "를 삭제할까요? 첨부 파일도 함께 지워집니다.", "삭제", true))) return;
    try {
      await reports.remove(r.id);
      (r.files || []).concat(r.requestFiles || []).forEach((m) => K.files.remove(m));
      reportList = reports.cached();
      render();
      K.toast("삭제했습니다.");
    } catch (err) {
      K.toast("삭제하지 못했습니다: " + err.message, true);
    }
  }

  /* ---------- 펀드 추가·고치기 ---------- */
  function fundFieldsHtml(f) {
    f = f || {};
    const bm = Number(f.baseMonth) || 3;
    const bd = Number(f.baseDay) || 31;
    return (
      '<label class="ops-side__add-field">펀드 이름 <input class="input input--compact" name="name" maxlength="80" value="' + esc(f.name || "") + '" required></label>' +
      '<label class="ops-side__add-field">담당팀 <input class="input input--compact" name="team" maxlength="40" list="ops-teams" value="' + esc(f.team || "") + '"></label>' +
      '<label class="ops-side__add-field">매니저 (여러 명은 쉼표로) <input class="input input--compact" name="managers" maxlength="120" list="ops-people" value="' + esc(f.managers || "") + '"></label>' +
      '<div class="ops-side__add-field">분기 기준일<span class="ops-side__add-day"><select class="input input--compact" name="baseMonth" aria-label="기준 월">' +
      Array.from({ length: 12 }, (_, i) => '<option value="' + (i + 1) + '"' + (i + 1 === bm ? " selected" : "") + ">" + (i + 1) + "월</option>").join("") +
      '</select><select class="input input--compact" name="baseDay" aria-label="기준 일">' +
      Array.from({ length: 30 }, (_, i) => '<option value="' + (i + 1) + '"' + (i + 1 === bd ? " selected" : "") + ">" + (i + 1) + "일</option>").join("") +
      '<option value="31"' + (bd >= 31 ? " selected" : "") + ">말일</option></select></span></div>"
    );
  }
  function readFund(form) {
    const f = (n) => form.elements[n];
    return {
      name: f("name").value.trim(),
      team: f("team").value.trim(),
      managers: splitNames(f("managers").value).join(", "),
      baseMonth: Number(f("baseMonth").value),
      baseDay: Number(f("baseDay").value),
    };
  }
  function setupFundAdd() {
    const box = $(".ops-side__add");
    const form = document.createElement("form");
    form.className = "ops-side__add-form";
    form.id = "ops-fund-form";
    form.hidden = true;
    form.noValidate = true;
    form.innerHTML = fundFieldsHtml(null) +
      '<p class="ops-side__add-error" hidden></p>' +
      '<p class="ops-side__add-hint">분기 보고는 <strong>기준일</strong>에 끝나는 3개월입니다. 예: 3월 말일 → 3·6·9·12월 말일. 매니저 이름이 내 이름과 같으면 <strong>내 펀드</strong>로 표시됩니다.</p>' +
      '<div class="ops-side__add-actions"><button type="button" class="btn btn--ghost btn--sm" data-act="cancel">취소</button><button type="submit" class="btn btn--primary btn--sm">추가</button></div>';
    box.appendChild(form);
    const toggle = $("#ops-fund-toggle");
    const err = $(".ops-side__add-error", form);
    const show = (on) => {
      form.hidden = !on;
      toggle.hidden = on;
      err.hidden = true;
      if (on) form.elements.name.focus();
    };
    toggle.addEventListener("click", () => show(true));
    $('[data-act="cancel"]', form).addEventListener("click", () => show(false));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = readFund(form);
      err.hidden = true;
      if (!data.name) {
        err.textContent = "펀드 이름을 입력해 주세요.";
        err.hidden = false;
        return form.elements.name.focus();
      }
      if (fundList.some((x) => x.name === data.name)) {
        err.textContent = "같은 이름의 펀드가 이미 있습니다.";
        err.hidden = false;
        return;
      }
      data.order = fundList.reduce((m, x) => Math.max(m, x.order == null ? -1 : x.order), -1) + 1;
      try {
        const saved = await funds.create(data);
        fundList = funds.cached();
        form.reset();
        form.elements.baseMonth.value = "3";
        form.elements.baseDay.value = "31";
        show(false);
        state.current = saved.id;
        render();
        K.toast("‘" + saved.name + "’ 펀드를 추가했습니다.");
      } catch (e2) {
        err.textContent = e2.message;
        err.hidden = false;
      }
    });
  }
  function openFundEditor(fund) {
    const sorted = fundList.slice().sort((a, b) => (a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order));
    const idx = sorted.indexOf(fund);
    const count = reportList.filter((r) => r.fundId === fund.id).length;
    const ctx = K.modal({
      title: "펀드 정보 고치기",
      size: "modal--narrow",
      html: '<form class="modal__body ops-side__add-form" id="ops-fund-edit" novalidate>' + fundFieldsHtml(fund) +
        '<p class="ops-side__add-error" hidden></p>' +
        '<div class="ops-side__add-actions"><button type="button" class="btn btn--ghost btn--sm" data-act="up"' + (idx <= 0 ? " disabled" : "") + '>목록에서 위로</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="down"' + (idx >= sorted.length - 1 ? " disabled" : "") + ">아래로</button></div>" +
        '<p class="ops-side__add-hint">이 펀드의 보고 ' + count + "건은 펀드를 지워도 남습니다.</p>" +
        '<div class="modal__footer"><button type="button" class="btn btn--danger btn--sm" data-act="delete">펀드 삭제</button><div class="modal__footer-right">' +
        '<button type="button" class="btn btn--ghost" data-act="cancel">취소</button><button type="submit" class="btn btn--primary">저장</button></div></div></form>',
      focus: '[name="name"]',
    });
    const form = $("#ops-fund-edit", ctx.modal);
    const err = $(".ops-side__add-error", form);
    form.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const a = act.getAttribute("data-act");
      if (a === "cancel") return ctx.close();
      if (a === "up" || a === "down") {
        const j = idx + (a === "up" ? -1 : 1);
        const ids = sorted.map((x) => x.id);
        ids.splice(j, 0, ids.splice(idx, 1)[0]);
        try {
          for (let i = 0; i < ids.length; i++) {
            const x = fundList.find((y) => y.id === ids[i]);
            if (x.order !== i) await funds.update(x.id, { order: i });
          }
          fundList = funds.cached();
          state.sort = "list";
          K.prefs.set("ops.sort", "list");
          ctx.close(true);
          render();
        } catch (e2) {
          K.toast(e2.message, true);
        }
        return;
      }
      if (a === "delete") {
        if (!(await K.confirm("‘" + fund.name + "’ 펀드를 목록에서 지울까요?\n이미 쓴 보고는 남습니다.", "삭제", true))) return;
        try {
          await funds.remove(fund.id);
          fundList = funds.cached();
          ctx.close(true);
          render();
          K.toast("펀드를 지웠습니다.");
        } catch (e2) {
          K.toast("지우지 못했습니다: " + e2.message, true);
        }
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = readFund(form);
      if (!data.name) {
        err.textContent = "펀드 이름을 입력해 주세요.";
        err.hidden = false;
        return;
      }
      if (fundList.some((x) => x.name === data.name && x.id !== fund.id)) {
        err.textContent = "같은 이름의 펀드가 이미 있습니다.";
        err.hidden = false;
        return;
      }
      try {
        await funds.update(fund.id, data);
        fundList = funds.cached();
        ctx.close(true);
        render();
        K.toast("저장했습니다.");
      } catch (e2) {
        err.textContent = e2.message;
        err.hidden = false;
      }
    });
  }

  function jumpTo(id) {
    const el = document.getElementById(id);
    if (!el) return;
    $$(".ops-entry.is-jumped").forEach((x) => x.classList.remove("is-jumped"));
    el.classList.add("is-jumped");
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    setTimeout(() => el.classList.remove("is-jumped"), 2400);
  }

  /* ---------- 이벤트 ---------- */
  $(".ops-tabs").addEventListener("click", (e) => {
    const a = e.target.closest("[data-kind]");
    if (!a) return;
    e.preventDefault();
    navigate({ kind: a.getAttribute("data-kind") });
  });
  $("#ops-prev").addEventListener("click", (e) => {
    e.preventDefault();
    navigate({ month: nextMonth(state.month, -1) });
  });
  $("#ops-next").addEventListener("click", (e) => {
    e.preventDefault();
    if (nextMonth(state.month, 1) <= thisMonth) navigate({ month: nextMonth(state.month, 1) });
  });
  $("#ops-period-label").title = "눌러서 이번 기본 기간으로";
  $("#ops-period-label").style.cursor = "pointer";
  $("#ops-period-label").addEventListener("click", () => navigate({ month: defaultMonth(state.kind) }));
  $("#ops-search").addEventListener("submit", (e) => {
    e.preventDefault();
    state.q = $("#ops-q").value.trim();
    navigate({});
  });
  $("#ops-q").value = state.q;
  $("#ops-q").addEventListener("input", () => {
    state.q = $("#ops-q").value.trim();
    renderSide();
    renderMain();
    renderSearchNote();
  });
  $(".ops-toolbar").addEventListener("click", (e) => {
    if (!e.target.closest("[data-clear-search]")) return;
    state.q = "";
    $("#ops-q").value = "";
    navigate({});
  });
  $("#ops-sort").addEventListener("change", () => {
    state.sort = $("#ops-sort").value;
    K.prefs.set("ops.sort", state.sort);
    render();
  });
  $("#ops-write").addEventListener("click", () => (state.kind === "adhoc" ? openRequest(null) : openReport({})));
  $("#ops-side-list").addEventListener("click", (e) => {
    const ed = e.target.closest("[data-fund-edit]");
    if (ed) {
      const fund = fundList.find((x) => x.id === ed.getAttribute("data-fund-edit"));
      if (fund) openFundEditor(fund);
      return;
    }
    const j = e.target.closest("[data-jump]");
    if (!j) return;
    e.preventDefault();
    const id = j.getAttribute("data-jump");
    state.current = id;
    $$(".ops-side__item").forEach((x) => x.classList.toggle("is-current", x === j));
    if (state.kind === "adhoc") {
      const first = $('#ops-list [data-fund="' + CSS.escape(id) + '"]');
      if (first) jumpTo(first.id);
      else {
        const fund = fundList.find((x) => x.id === id);
        K.toast("‘" + (fund ? fund.name : "") + "’ 펀드는 이 달 수시 요청이 없습니다.");
      }
    } else jumpTo("ops-e-" + id);
  });
  $("#ops-list").addEventListener("click", (e) => {
    const w = e.target.closest("[data-write]");
    if (w) return openReport({ fundId: w.getAttribute("data-write") });
    const entry = e.target.closest("[data-report]");
    const r = entry && reportList.find((x) => x.id === entry.getAttribute("data-report"));
    if (!r) return;
    if (e.target.closest("[data-edit-report]")) return openReport({ report: r });
    if (e.target.closest("[data-answer]")) return openReport({ report: r });
    if (e.target.closest("[data-edit-request]")) return openRequest(r);
    if (e.target.closest("[data-del-report]")) return deleteReport(r);
    const fb = e.target.closest("[data-file]");
    if (fb) return K.files.download((r.files || [])[Number(fb.getAttribute("data-file"))]);
    const rf = e.target.closest("[data-rfile]");
    if (rf) return K.files.download((r.requestFiles || [])[Number(rf.getAttribute("data-rfile"))]);
  });

  /* ---------- 시작 ---------- */
  async function load() {
    try {
      const [a, b] = await Promise.all([funds.list(), reports.list()]);
      fundList = a;
      reportList = b;
    } catch (err) {
      K.toast("불러오지 못했습니다: " + err.message, true);
    }
    render();
  }
  setupFundAdd();
  // 첫 그림은 빈 목록으로 (복제된 예시 기간·숫자를 바로 지운다)
  render();
  K.session().then((s) => {
    server = !!s.server;
    me = s.me || null;
    if (s.server) {
      s.api("GET", "/api/users/names").then((list) => {
        people = (list || []).map((u) => u.displayName || u.username);
        renderSuggest();
      }).catch(() => {});
    }
    load();
  });
})();
