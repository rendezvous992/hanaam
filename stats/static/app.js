/* 노트 통계: 기간·본부별 사람별/분류별/기업별/월별 등록 현황, CSV 내려받기 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, esc } = K;

  const CAT_LABEL = { single: "단독미팅", group: "그룹미팅", seminar: "세미나", report: "기업레포트", etc: "기타" };
  let notes = [];
  let people = []; // [{displayName, department}]
  let sortKey = "total";
  let sectorOf = () => "미지정"; // 종목 → 섹터 (노트 화면에서 지정)

  function inRange(n) {
    const r = $("#st-range").value;
    if (r === "all") return true;
    return (n.date || "") >= K.addDays(K.today(), -Number(r));
  }
  function deptOf(name) {
    const p = people.find((x) => x.displayName === name);
    return p ? p.department || "" : "";
  }
  function current() {
    const dept = $("#st-dept").value;
    return notes.filter((n) => inRange(n) && (!dept || deptOf(n.author) === dept));
  }
  const count = (list, key) => {
    const m = new Map();
    list.forEach((n) => {
      const k = typeof key === "function" ? key(n) : n[key];
      m.set(k, (m.get(k) || 0) + 1);
    });
    return m;
  };

  function renderKpis(list) {
    const authors = new Set(list.map((n) => n.author).filter(Boolean));
    const companies = new Set(list.map((n) => n.company).filter(Boolean));
    const withAudio = list.filter((n) => n.audio).length;
    const weekStart = K.startOfWeek(K.today(), true);
    const thisWeek = notes.filter((n) => (n.date || "") >= weekStart).length;
    $("#st-kpis").innerHTML = [
      ["노트", list.length, "선택한 기간"],
      ["작성자", authors.size, "명"],
      ["기업", companies.size, "곳"],
      ["이번 주", thisWeek, "월요일부터"],
      ["녹음 포함", withAudio, list.length ? Math.round((withAudio / list.length) * 100) + "%" : ""],
    ].map((k) => '<div class="st-kpi"><span>' + k[0] + "</span><b>" + k[1] + "</b><small>" + esc(String(k[2])) + "</small></div>").join("");
  }

  function renderMonths(list) {
    const months = [];
    const r = $("#st-range").value;
    const span = r === "all" ? 12 : Math.max(1, Math.ceil(Number(r) / 30));
    let m = K.monthStart(K.today());
    for (let i = 0; i < Math.max(span, 6); i++) {
      months.unshift(m.slice(0, 7));
      m = K.addMonths(m, -1);
    }
    const c = count(list.concat(r === "all" ? [] : []), (n) => (n.date || "").slice(0, 7));
    const all = count(notes, (n) => (n.date || "").slice(0, 7));
    const src = r === "all" ? all : c;
    const max = Math.max(1, ...months.map((x) => src.get(x) || 0));
    $("#st-month").innerHTML = months.map((x) => {
      const v = src.get(x) || 0;
      return '<div class="st-bar" title="' + x + " · " + v + '건"><b>' + v + '</b><i style="height:' + Math.round((v / max) * 120) + 'px"></i>' + Number(x.slice(5)) + "월</div>";
    }).join("");
  }

  function renderPeople(list) {
    const byAuthor = new Map();
    list.forEach((n) => {
      const a = n.author || "(작성자 없음)";
      const r = byAuthor.get(a) || { name: a, total: 0, single: 0, group: 0, other: 0, audio: 0, last: "" };
      r.total++;
      if (n.category === "single") r.single++;
      else if (n.category === "group") r.group++;
      else r.other++;
      if (n.audio) r.audio++;
      if ((n.date || "") > r.last) r.last = n.date;
      byAuthor.set(a, r);
    });
    const rows = Array.from(byAuthor.values()).sort((a, b) => (sortKey === "name" ? a.name.localeCompare(b.name, "ko") : sortKey === "last" ? b.last.localeCompare(a.last) : b[sortKey] - a[sortKey]));
    const max = Math.max(1, ...rows.map((r) => r.total));
    $("#st-people").innerHTML = rows.length
      ? "<thead><tr>" + [["name", "이름"], ["total", "전체"], ["single", "단독"], ["group", "그룹"], ["other", "기타"], ["audio", "녹음"], ["last", "마지막"]]
          .map((h) => '<th data-sort="' + h[0] + '">' + h[1] + (sortKey === h[0] ? " ▾" : "") + "</th>").join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr><td>" + esc(r.name) + (deptOf(r.name) ? ' <span style="color:var(--text-muted);font-size:11px">' + esc(deptOf(r.name)) + "</span>" : "") +
          "</td><td><b>" + r.total + '</b><span class="st-mini" style="width:' + Math.round((r.total / max) * 60) + 'px"></span></td><td>' + r.single + "</td><td>" + r.group + "</td><td>" + r.other + "</td><td>" + r.audio + "</td><td>" + esc(r.last ? K.dot(r.last) : "") + "</td></tr>").join("") +
        "</tbody>"
      : '<tbody><tr><td class="st-empty">이 기간에 노트가 없습니다.</td></tr></tbody>';
  }

  function bars(map, label) {
    const rows = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return rows.map(([k, v]) => '<div class="st-row"><span>' + esc(label(k)) + '</span><span class="st-row__track"><i style="width:' + Math.round((v / max) * 100) + '%"></i></span><b>' + v + "</b></div>").join("");
  }

  function renderCats(list) {
    $("#st-cats").innerHTML = list.length
      ? "<h3 style=\"font-size:12px;color:var(--text-muted);margin:0 0 8px\">분류</h3>" + bars(count(list, "category"), (k) => CAT_LABEL[k] || "기타") +
        "<h3 style=\"font-size:12px;color:var(--text-muted);margin:14px 0 8px\">유형</h3>" + bars(count(list, (n) => n.type || "미지정"), (k) => k)
      : '<p class="st-empty">이 기간에 노트가 없습니다.</p>';
  }

  function renderSectors(list) {
    $("#st-sectors").innerHTML = list.length
      ? bars(count(list, (n) => sectorOf(n.company)), (k) => k) +
        '<p class="st-empty" style="padding:8px 0 0">섹터는 노트 화면의 ‘종목별 섹터 지정’에서 정합니다. <a href="/notes/">노트로 가기</a></p>'
      : '<p class="st-empty">이 기간에 노트가 없습니다.</p>';
  }

  function renderCompanies(list) {
    const rows = Array.from(count(list, "company").entries()).filter((r) => r[0]).sort((a, b) => b[1] - a[1]).slice(0, 15);
    $("#st-companies").innerHTML = rows.length
      ? rows.map(([c, v]) => '<li><a href="/notes/?company=' + encodeURIComponent(c) + '">' + esc(c) + "</a><span>" + v + "건</span></li>").join("")
      : '<li class="st-empty" style="list-style:none">이 기간에 노트가 없습니다.</li>';
  }

  function renderQuality(list) {
    const review = list.filter((n) => n.review || n.review_reason);
    const noBody = list.filter((n) => !String(n.body || "").trim() && !(n.files || []).length && !n.audio);
    $("#st-quality").innerHTML =
      '<div class="st-row"><span>확인 필요</span><span></span><b>' + review.length + "</b></div>" +
      '<div class="st-row"><span>본문·첨부 없음</span><span></span><b>' + noBody.length + "</b></div>" +
      (noBody.length
        ? '<ol class="st-rank">' + noBody.slice(0, 8).map((n) => '<li><a href="/notes/#note-' + encodeURIComponent(n.id) + '">' + esc(n.company + " · " + n.title) + "</a><span>" + esc(n.author || "") + "</span></li>").join("") + "</ol>"
        : "");
  }

  function render() {
    const list = current();
    renderKpis(list);
    renderMonths(list);
    renderPeople(list);
    renderCats(list);
    renderSectors(list);
    renderCompanies(list);
    renderQuality(list);
  }

  $("#st-range").addEventListener("change", () => {
    K.prefs.set("stats.range", $("#st-range").value);
    render();
  });
  $("#st-dept").addEventListener("change", render);
  $("#st-people").addEventListener("click", (e) => {
    const th = e.target.closest("[data-sort]");
    if (!th) return;
    sortKey = th.getAttribute("data-sort");
    render();
  });
  $("#st-csv").addEventListener("click", () => {
    const rows = [["날짜", "기업", "종목코드", "섹터", "분류", "유형", "작성자", "본부", "제목", "녹음", "첨부 수"]].concat(
      current().map((n) => [n.date, n.company, n.ticker || "", sectorOf(n.company), CAT_LABEL[n.category] || "기타", n.type || "", n.author || "", deptOf(n.author), n.title, n.audio ? "있음" : "", (n.files || []).length])
    );
    K.saveText("노트통계-" + K.today() + ".csv", K.toCsv(rows), "text/csv;charset=utf-8");
  });

  K.session().then(async (s) => {
    $("#st-range").value = K.prefs.get("stats.range", "90");
    if (s.server) {
      people = await s.api("GET", "/api/users/names").catch(() => []);
      const depts = Array.from(new Set(people.map((p) => p.department).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko"));
      $("#st-dept").innerHTML = '<option value="">본부 전체</option>' + depts.map((d) => '<option value="' + esc(d) + '">' + esc(d) + "</option>").join("");
    } else {
      $("#st-dept").hidden = true;
    }
    const sectors = await K.collection("company-sectors").list().catch(() => []);
    const map = new Map(sectors.map((r) => [r.company, K.sectorNorm(r.sector)]));
    sectorOf = (c) => map.get(c) || K.sectorGuess(c) || "미지정";
    notes = await K.readNotes();
    render();
  });
})();
