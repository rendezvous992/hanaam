/* 종목 분석 — 기업 검색·가나다 색인, 선택한 기업의 시세·노트·IR 일정·DART 공시, 최근 본 종목 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const watchStore = K.collection("watchlist");
  const uniStore = K.collection("discover-universe");

  let session = { server: false };
  let notes = [];
  let events = [];
  let watchlist = [];
  let uniMeta = null; // 종목 발굴에 올린 표 { fileName, importedAt, rows }
  let cos = []; // 알려진 기업 목록
  let byName = new Map();
  let byCode = new Map();
  let current = null; // 지금 보고 있는 기업
  let idxState = { market: "all", letter: "", extras: false };
  let sectorOpen = "";
  let notesShown = 10;
  let dartDays = K.prefs.get("company.dartDays", 90);
  let searchSeq = 0;
  let searchItems = [];
  let searchActive = -1;

  /* ---------- 공통 도구 ---------- */
  const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
  const isCode = (s) => /^[0-9A-Z]{6}$/.test(String(s || ""));
  function splitNames(s) {
    return String(s || "").split(/[,/·\n]+/).map((x) => x.trim()).filter(Boolean);
  }
  function normMarket(m) {
    const s = String(m || "").toUpperCase();
    if (/KOSDAQ|코스닥|KQ/.test(s)) return "KOSDAQ";
    if (/KOSPI|코스피|유가|KS/.test(s)) return "KOSPI";
    if (/KONEX|코넥스/.test(s)) return "KONEX";
    return "";
  }
  const MARKET_LABEL = { KOSPI: "코스피", KOSDAQ: "코스닥", KONEX: "코넥스" };
  // 우선주·스팩
  const isExtra = (name) => /(우|우B|우C|\d우)$|스팩|SPAC/i.test(name || "");
  function stripHtml(s) {
    return String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
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
  function fmtNum(v, d) {
    return v == null || v === "" || isNaN(v) ? "—" : K.num(v, d);
  }
  function statusLabel(status) {
    const s = String(status || "").toUpperCase();
    if (/PRE/.test(s)) return "장 시작 전";
    if (/OPEN/.test(s)) return "장중";
    if (/CLOSE/.test(s)) return "장 마감";
    // 시세 상태가 없으면 시계로 짐작
    const wd = K.weekday(K.today());
    const t = K.nowTime();
    if (wd === 0 || wd === 6) return "휴장";
    if (t < "09:00") return "장 시작 전";
    if (t <= "15:30") return "장중";
    return "장 마감";
  }

  /* ---------- 알려진 기업 목록 만들기 ---------- */
  function addCo(name, code, market, extra) {
    name = String(name || "").trim();
    code = String(code || "").trim().toUpperCase();
    if (!isCode(code)) code = "";
    if ((!name || name === "미지정") && !code) return null;
    let c = (code && byCode.get(code)) || (name && byName.get(norm(name)));
    if (!c) {
      c = { name: name || code, code: "", market: "", sector: "", row: null, notes: [], events: [] };
      cos.push(c);
    }
    if (name && c.name === c.code) c.name = name;
    if (name) byName.set(norm(name), c);
    if (code && !c.code) c.code = code;
    if (c.code) byCode.set(c.code, c);
    if (!c.market && market) c.market = normMarket(market);
    if (extra) {
      if (!c.sector && extra.sector) c.sector = extra.sector;
      if (extra.row) c.row = extra.row;
    }
    return c;
  }
  function buildIndex() {
    cos = [];
    byName = new Map();
    byCode = new Map();
    ((uniMeta && uniMeta.rows) || []).forEach((r) => addCo(r.name, r.code, r.market, { sector: r.sector, row: r }));
    watchlist.forEach((w) => addCo(w.name, w.code, w.market, { sector: w.sector }));
    notes.forEach((n) => {
      const c = addCo(n.company, n.ticker);
      if (c) c.notes.push(n);
    });
    events.forEach((ev) => splitNames(ev.companies).forEach((name) => {
      const c = addCo(name);
      if (c && !c.events.includes(ev)) c.events.push(ev);
    }));
    K.prefs.get("company.recent", []).forEach((r) => addCo(r.name, r.code, r.market));
  }
  function findCo(name, code) {
    return (code && byCode.get(String(code).toUpperCase())) || (name && byName.get(norm(name))) || null;
  }

  /* ---------- 최근 본 종목 ---------- */
  function remember(c) {
    const list = K.prefs.get("company.recent", []).filter((r) => !(r.name === c.name || (c.code && r.code === c.code)));
    list.unshift({ name: c.name, code: c.code || "", market: c.market || "" });
    K.prefs.set("company.recent", list.slice(0, 12));
  }

  /* ---------- 검색 ---------- */
  const input = $("#csearch-input");
  const searchBox = $(".csearch");
  const listEl = document.createElement("div");
  listEl.className = "csearch__list";
  listEl.id = "csearch-list";
  listEl.setAttribute("role", "listbox");
  listEl.hidden = true;
  searchBox.appendChild(listEl);
  input.setAttribute("aria-controls", "csearch-list");

  function localMatches(q) {
    const nq = norm(q);
    if (!nq) return [];
    const out = [];
    cos.forEach((c) => {
      const n = norm(c.name);
      let score = -1;
      if (c.code && c.code === q.toUpperCase()) score = 0;
      else if (n === nq) score = 1;
      else if (n.startsWith(nq) || (c.code && c.code.startsWith(nq.toUpperCase()))) score = 2;
      else if (n.includes(nq)) score = 3;
      if (score >= 0) out.push([score, c]);
    });
    out.sort((a, b) => a[0] - b[0] || b[1].notes.length - a[1].notes.length || a[1].name.localeCompare(b[1].name, "ko"));
    return out.slice(0, 12).map((x) => x[1]);
  }
  function renderSearch(items, q, note) {
    searchItems = items;
    searchActive = items.length ? 0 : -1;
    let html = items.map((c, i) => {
      const n = c.notes ? c.notes.length : 0;
      return '<button type="button" class="csearch__item' + (i === 0 ? " is-active" : "") + '" role="option" data-i="' + i + '">' +
        '<span class="csearch__name">' + esc(c.name) + "</span>" +
        '<span class="csearch__code">' + esc([c.code, MARKET_LABEL[normMarket(c.market)] || ""].filter(Boolean).join(" · ")) + "</span>" +
        '<span class="csearch__n' + (n ? "" : " csearch__n--none") + '">' + (n ? "노트 " + n : "노트 없음") + "</span></button>";
    }).join("");
    if (!items.length && q) {
      html = '<button type="button" class="csearch__item" data-free="1"><span class="csearch__name">‘' + esc(q) + "’ 이름으로 보기</span>" +
        '<span class="csearch__code">찾은 종목이 없습니다</span></button>';
    }
    if (note) html += '<p class="csearch__note">' + esc(note) + "</p>";
    listEl.innerHTML = html;
    listEl.hidden = !html;
    input.setAttribute("aria-expanded", String(!listEl.hidden));
  }
  function closeSearch() {
    listEl.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }
  let searchTimer = null;
  function runSearch(q) {
    q = q.trim();
    const seq = ++searchSeq;
    if (!q) return closeSearch();
    const local = localMatches(q);
    renderSearch(local, q, session.server ? "종목 검색 중…" : "");
    if (!session.server) return;
    getJson("/api/stock-search?q=" + encodeURIComponent(q))
      .then((data) => {
        if (seq !== searchSeq) return;
        const merged = local.slice();
        (data.items || []).forEach((it) => {
          const known = findCo(it.name, it.code);
          if (known) {
            if (!known.code) known.code = it.code;
            if (!known.market) known.market = normMarket(it.market);
            if (!merged.includes(known)) merged.push(known);
          } else merged.push({ name: it.name, code: it.code, market: normMarket(it.market), notes: [], events: [] });
        });
        renderSearch(merged.slice(0, 15), q, data.offline ? "외부 종목 검색에 연결하지 못해 노트·IR 일정의 기업명에서 찾았습니다." : "");
      })
      .catch(() => {
        if (seq === searchSeq) renderSearch(local, q, "외부 종목 검색에 연결하지 못해 노트·IR 일정의 기업명에서 찾았습니다.");
      });
  }
  function moveActive(d) {
    const btns = $$(".csearch__item[data-i]", listEl);
    if (!btns.length) return;
    searchActive = (searchActive + d + btns.length) % btns.length;
    btns.forEach((b, i) => b.classList.toggle("is-active", i === searchActive));
    btns[searchActive].scrollIntoView({ block: "nearest" });
  }
  function submitSearch() {
    const q = input.value.trim();
    if (!q) return;
    if (!listEl.hidden && searchActive >= 0 && searchItems[searchActive]) return pick(searchItems[searchActive]);
    const local = localMatches(q);
    if (local.length) return pick(local[0]);
    if (isCode(q.toUpperCase())) return openCompany({ code: q.toUpperCase() });
    openCompany({ name: q });
  }
  function pick(c) {
    closeSearch();
    openCompany({ name: c.name, code: c.code, market: c.market });
  }
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(input.value), 180);
  });
  input.addEventListener("focus", () => {
    if (input.value.trim() && current === null) runSearch(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (listEl.hidden) runSearch(input.value);
      else moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchTimer);
      submitSearch();
    } else if (e.key === "Escape") closeSearch();
  });
  $("#csearch-btn").addEventListener("click", () => {
    clearTimeout(searchTimer);
    submitSearch();
  });
  listEl.addEventListener("click", (e) => {
    const b = e.target.closest(".csearch__item");
    if (!b) return;
    if (b.hasAttribute("data-free")) {
      closeSearch();
      openCompany({ name: input.value.trim() });
    } else pick(searchItems[Number(b.getAttribute("data-i"))]);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".csearch")) closeSearch();
  });

  /* ---------- 가나다·ABC 색인 ---------- */
  const CHO = ["ㄱ", "ㄱ", "ㄴ", "ㄷ", "ㄷ", "ㄹ", "ㅁ", "ㅂ", "ㅂ", "ㅅ", "ㅅ", "ㅇ", "ㅈ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
  const LETTERS = ["ㄱ", "ㄴ", "ㄷ", "ㄹ", "ㅁ", "ㅂ", "ㅅ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"].concat("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), ["0-9"]);
  function letterOf(name) {
    const ch = String(name || "").trim().charAt(0);
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) return CHO[Math.floor((code - 0xac00) / 588)];
    if (/[a-z]/i.test(ch)) return ch.toUpperCase();
    if (/[0-9]/.test(ch)) return "0-9";
    if (/[ㄱ-ㅎ]/.test(ch)) return ch;
    return "0-9";
  }
  function idxPool(market) {
    return cos.filter((c) => (idxState.extras || !isExtra(c.name)) && (market === "all" || normMarket(c.market) === market));
  }
  function renderIndex() {
    // 시장별 개수
    $$("#cidx-market .cseg__btn").forEach((b) => {
      const m = b.getAttribute("data-market");
      b.classList.toggle("cseg__btn--active", m === idxState.market);
      const n = $(".cidx__n", b);
      if (n) n.textContent = K.num(idxPool(m).length);
    });
    $("#cidx-extras").checked = idxState.extras;
    const pool = idxPool(idxState.market);
    const counts = {};
    pool.forEach((c) => {
      const l = letterOf(c.name);
      counts[l] = (counts[l] || 0) + 1;
    });
    $("#cidx-letters").innerHTML = LETTERS.map((l) =>
      '<button type="button" class="cidx__letter' + (l === idxState.letter ? " cidx__letter--active" : "") + (counts[l] ? "" : " cidx__letter--empty") + '" data-letter="' + l + '"' +
      (counts[l] ? ' title="' + counts[l] + '개"' : " disabled") + ">" + l + "</button>"
    ).join("");
    let box = $("#cidx-result");
    if (!box) {
      box = document.createElement("div");
      box.className = "cidx__result";
      box.id = "cidx-result";
      $("#cindex").appendChild(box);
    }
    if (!pool.length) {
      box.hidden = false;
      box.innerHTML = '<p class="cidx__hint">아직 색인에 넣을 기업이 없습니다. 노트·IR 일정에 기업을 적거나, 종목 발굴에 종목 표(CSV)를 올리거나, 시장 페이지에서 관심 종목을 추가하면 여기에 모입니다.</p>';
      return;
    }
    if (!idxState.letter) {
      box.hidden = false;
      box.innerHTML = '<p class="cidx__hint">첫 글자를 누르면 그 글자로 시작하는 기업을 보여 줍니다. 기업 ' + K.num(pool.length) + "곳</p>";
      return;
    }
    const list = pool.filter((c) => letterOf(c.name) === idxState.letter).sort((a, b) => a.name.localeCompare(b.name, "ko"));
    box.hidden = false;
    box.innerHTML = (list.length
      ? '<div class="cidx__grid">' + list.map((c) => {
        const mk = normMarket(c.market);
        return '<button type="button" class="cidx__item" data-name="' + esc(c.name) + '" data-code="' + esc(c.code) + '">' +
          '<span class="cidx__item-name">' + esc(c.name) + "</span>" +
          '<span class="cidx__item-meta">' + (mk ? '<span class="cidx__mk ' + (mk === "KOSPI" ? "cidx__mk--kp" : "cidx__mk--kd") + '">' + esc(MARKET_LABEL[mk]) + "</span>" : "") +
          (c.code ? "<span>" + esc(c.code) + "</span>" : "") + (c.notes.length ? '<span class="cidx__note">노트 ' + c.notes.length + "</span>" : "") + "</span></button>";
      }).join("") + "</div>"
      : '<p class="cidx__hint">이 글자로 시작하는 기업이 없습니다.</p>') +
      '<div class="cidx__foot"><span class="cidx__count">' + esc(idxState.letter) + " · " + K.num(list.length) + '곳</span><button type="button" class="btn btn--ghost btn--sm" data-idx-close>접기</button></div>';
  }
  $("#cindex").addEventListener("click", (e) => {
    const seg = e.target.closest("#cidx-market .cseg__btn");
    if (seg) {
      idxState.market = seg.getAttribute("data-market");
      renderIndex();
      return;
    }
    const l = e.target.closest(".cidx__letter");
    if (l && !l.disabled) {
      const v = l.getAttribute("data-letter");
      idxState.letter = idxState.letter === v ? "" : v;
      renderIndex();
      return;
    }
    if (e.target.closest("[data-idx-close]")) {
      idxState.letter = "";
      renderIndex();
      return;
    }
    const it = e.target.closest(".cidx__item");
    if (it) openCompany({ name: it.getAttribute("data-name"), code: it.getAttribute("data-code") });
  });
  $("#cidx-extras").addEventListener("change", (e) => {
    idxState.extras = e.target.checked;
    K.prefs.set("company.extras", idxState.extras);
    renderIndex();
  });

  /* ---------- 첫 화면: 최근 본 종목·최근 노트·다가오는 IR·섹터 ---------- */
  function chip(c, sub) {
    return '<button type="button" class="chome__chip" data-name="' + esc(c.name) + '" data-code="' + esc(c.code || "") + '">' +
      '<span class="chome__chip-name">' + esc(c.name) + '</span><span class="chome__chip-sub">' + esc(sub) + "</span></button>";
  }
  function renderHome() {
    const home = $("#chome");
    // 최근 본 종목 (이 브라우저)
    let recentSec = $("#chome-seen-sec");
    if (!recentSec) {
      recentSec = document.createElement("section");
      recentSec.className = "chome__sec";
      recentSec.id = "chome-seen-sec";
      recentSec.innerHTML = '<h2 class="chome__title">최근 본 종목 <button type="button" class="btn btn--ghost btn--sm" data-seen-clear style="margin-left:8px">지우기</button></h2><div class="chome__grid" id="chome-seen"></div>';
      home.insertBefore(recentSec, home.firstElementChild);
    }
    const seen = K.prefs.get("company.recent", []);
    recentSec.hidden = !seen.length;
    $("#chome-seen").innerHTML = seen.map((r) => chip(r, [r.code, MARKET_LABEL[normMarket(r.market)] || ""].filter(Boolean).join(" · ") || "코드 없음")).join("");

    // 최근 노트가 올라온 종목
    const seenCo = new Set();
    const recent = [];
    notes.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || String(b.id).localeCompare(String(a.id))).forEach((n) => {
      const c = findCo(n.company, n.ticker);
      if (!c || seenCo.has(c)) return;
      seenCo.add(c);
      recent.push([c, n.date]);
    });
    $("#chome-recent").innerHTML = recent.length
      ? recent.slice(0, 16).map(([c, d]) => chip(c, "노트 " + c.notes.length + "건 · " + (K.md(d) || "날짜 없음"))).join("")
      : '<p class="chome__empty">아직 기업 노트가 없습니다. <a href="/notes/">노트 쓰기</a></p>';

    // 다가오는 IR 일정 (30일)
    const today = K.today();
    const until = K.addDays(today, 30);
    const up = events.filter((ev) => (ev.endDate || ev.date) >= today && ev.date <= until).sort(K.byEventTime).slice(0, 8);
    $("#chome-upcoming").innerHTML = up.length
      ? up.map((ev) => {
        const first = splitNames(ev.companies)[0] || "";
        return '<button type="button" class="cev" data-name="' + esc(first) + '"><span class="cev__date">' + esc(K.md(ev.date < today ? today : ev.date)) + "</span>" +
          '<span class="cev__company">' + esc(ev.companies || "기업 미정") + '</span><span class="cev__type">' + esc(K.IR_LABEL[ev.type] || "기타") + "</span>" +
          ((ev.brokers || ev.title) ? '<span class="cev__broker">' + esc([ev.brokers, ev.title].filter(Boolean).join(" · ")) + " · " + esc(K.eventTime(ev)) + "</span>" : "") + "</button>";
      }).join("")
      : '<p class="chome__empty">앞으로 30일 안에 잡힌 IR 일정이 없습니다. <a href="/calendar/">IR 캘린더</a></p>';

    // 섹터로 훑어보기
    const sectors = new Map();
    cos.forEach((c) => {
      if (!c.sector) return;
      if (!sectors.has(c.sector)) sectors.set(c.sector, []);
      sectors.get(c.sector).push(c);
    });
    const box = $("#chome-sectors");
    if (!sectors.size) {
      box.innerHTML = '<p class="chome__empty">섹터 정보가 없습니다. <a href="/company/discover/">종목 발굴</a>에 섹터 열이 있는 종목 표(CSV)를 올리거나, 관심 종목에 섹터를 적으면 여기서 섹터별로 볼 수 있습니다.</p>';
      return;
    }
    const sorted = Array.from(sectors.entries()).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "ko"));
    if (sectorOpen && !sectors.has(sectorOpen)) sectorOpen = "";
    let html = sorted.map(([s, list]) =>
      '<button type="button" class="chome__sector' + (s === sectorOpen ? " chome__sector--active" : "") + '" data-sector="' + esc(s) + '">' + esc(s) + '<span class="chome__sector-n">' + list.length + "</span></button>"
    ).join("");
    const openList = sectorOpen ? sectors.get(sectorOpen).slice().sort((a, b) => ((b.row && b.row.cap) || 0) - ((a.row && a.row.cap) || 0) || a.name.localeCompare(b.name, "ko")) : [];
    html += '<div class="chome__sectorco"' + (sectorOpen ? "" : " hidden") + ">" +
      openList.slice(0, 60).map((c) => chip(c, c.row && c.row.cap ? "시총 " + K.num(c.row.cap) + "억" : c.code || "")).join("") +
      (openList.length > 60 ? '<p class="chome__empty">외 ' + (openList.length - 60) + "곳 — 종목 발굴의 전체 목록에서 볼 수 있습니다.</p>" : "") + "</div>";
    box.innerHTML = html;
  }
  $("#chome").addEventListener("click", (e) => {
    if (e.target.closest("[data-seen-clear]")) {
      K.prefs.set("company.recent", []);
      renderHome();
      return;
    }
    const sec = e.target.closest(".chome__sector");
    if (sec) {
      const s = sec.getAttribute("data-sector");
      sectorOpen = sectorOpen === s ? "" : s;
      renderHome();
      return;
    }
    const c = e.target.closest(".chome__chip, .cev[data-name]");
    if (c && c.getAttribute("data-name")) openCompany({ name: c.getAttribute("data-name"), code: c.getAttribute("data-code") || "" });
  });

  /* ---------- 기업 화면 ---------- */
  const pageEl = document.createElement("div");
  pageEl.className = "cpage";
  pageEl.id = "cpage";
  pageEl.hidden = true;
  $("#chome").after(pageEl);

  function setView(detail) {
    pageEl.hidden = !detail;
    $("#cindex").hidden = detail;
    $("#chome").hidden = detail;
  }
  function goHome(push) {
    current = null;
    document.title = "종목 분석";
    setView(false);
    if (push) history.pushState(null, "", "/company/");
    buildIndex();
    renderIndex();
    renderHome();
  }

  // { name, code, market } 에서 기업을 찾아 연다. 이름·코드 중 모르는 쪽은 서버 검색으로 채운다
  async function openCompany(want, fromUrl) {
    let name = String(want.name || "").trim();
    let code = String(want.code || "").trim().toUpperCase();
    if (!isCode(code)) code = "";
    let c = findCo(name, code);
    if (c) {
      name = c.name;
      code = c.code || code;
    }
    if (session.server && (!code || !name || name === code)) {
      try {
        const data = await getJson("/api/stock-search?q=" + encodeURIComponent(code || name));
        const items = data.items || [];
        const hit = items.find((it) => (code && it.code === code) || norm(it.name) === norm(name)) || (items.length === 1 ? items[0] : null);
        if (hit) {
          code = code || hit.code;
          if (!name || name === code) name = hit.name;
          want.market = want.market || hit.market;
        }
      } catch (e) {
        /* 검색이 안 되면 아는 정보로만 연다 */
      }
    }
    c = findCo(name, code) || addCo(name || code, code, want.market);
    if (!c) return;
    if (code && !c.code) {
      c.code = code;
      byCode.set(code, c);
    }
    if (want.market && !c.market) c.market = normMarket(want.market);
    current = c;
    notesShown = 10;
    remember(c);
    input.value = c.name;
    closeSearch();
    const url = "/company/?" + (c.code ? "code=" + encodeURIComponent(c.code) : "q=" + encodeURIComponent(c.name));
    if (!fromUrl) history.pushState({ name: c.name, code: c.code }, "", url);
    else history.replaceState({ name: c.name, code: c.code }, "", url);
    document.title = c.name + " · 종목 분석";
    renderCompany();
    window.scrollTo(0, 0);
  }

  function coNotes(c) {
    return notes.filter((n) => (c.code && n.ticker === c.code) || (n.company && norm(n.company) === norm(c.name)))
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || String(b.id).localeCompare(String(a.id)));
  }
  function coEvents(c) {
    const key = norm(c.name);
    return events.filter((ev) => splitNames(ev.companies).some((n) => norm(n) === key));
  }
  function inWatch(c) {
    return watchlist.find((w) => (c.code && w.code === c.code) || norm(w.name) === norm(c.name));
  }

  function renderCompany() {
    const c = current;
    setView(true);
    const cn = coNotes(c);
    const ce = coEvents(c);
    const today = K.today();
    const upcoming = ce.filter((ev) => (ev.endDate || ev.date) >= today).sort(K.byEventTime);
    const past = ce.filter((ev) => (ev.endDate || ev.date) < today).sort((a, b) => K.byEventTime(b, a));
    const w = inWatch(c);
    const r = c.row;
    const mk = MARKET_LABEL[normMarket(c.market)] || "";
    const metrics = r
      ? [["시가총액", r.cap != null ? K.num(r.cap) + "억" : "—"], ["PER", fmtNum(r.per, 1)], ["PBR", fmtNum(r.pbr, 2)], ["ROE", r.roe != null ? K.num(r.roe, 1) + "%" : "—"]]
      : [["노트", cn.length + "건"], ["다가오는 IR", upcoming.length + "건"], ["지난 IR", past.length + "건"], ["관심 종목", w ? "등록" : "—"]];
    const foot = r
      ? "시가총액·PER·PBR·ROE 는 종목 발굴에 올린 표" + (uniMeta.fileName ? "(" + uniMeta.fileName + ")" : "") + " 기준" + (uniMeta.importedAt ? " · " + K.isoKst(uniMeta.importedAt).slice(0, 10) : "") + (r.div != null ? " · 배당수익률 " + K.num(r.div, 2) + "%" : "")
      : "재무 지표(시가총액·PER·PBR·ROE)는 종목 발굴에 종목 표(CSV)를 올리면 함께 보입니다.";

    pageEl.innerHTML =
      '<p class="cpage__hint"><a href="/company/" data-go-home>← 색인으로</a> · 최근 본 종목에 저장했습니다.</p>' +
      '<section class="cpage__main"><div class="cpanel">' +
      '<div class="cpanel__sec" id="cq">' +
      '<div class="cq__top"><div><span class="cq__name">' + esc(c.name) + '</span><span class="cq__code">' + esc([c.code || "종목코드 없음", mk].filter(Boolean).join(" · ")) + "</span></div>" +
      '<div id="cq-price"><span class="cq__price">—</span></div></div>' +
      '<div class="cq__facts" id="cq-facts"><span><i>시세</i>불러오는 중…</span></div>' +
      '<div class="cq__metrics">' + metrics.map(([k, v]) => "<div class=\"cq__metric\"><i>" + esc(k) + "</i><b>" + esc(v) + "</b></div>").join("") + "</div>" +
      '<p class="cq__foot">' + esc(foot) + (c.sector ? " · 섹터 " + esc(c.sector) : "") + "</p>" +
      '<div class="cq__actions">' +
      '<button type="button" class="btn btn--sm ' + (w ? "btn--ghost" : "btn--primary") + '" data-watch>' + (w ? "관심 종목에서 빼기" : "+ 관심 종목") + "</button>" +
      '<a class="btn btn--ghost btn--sm" href="/notes/?company=' + encodeURIComponent(c.name) + '">노트 페이지에서 보기</a>' +
      '<a class="btn btn--ghost btn--sm" href="/calendar/?company=' + encodeURIComponent(c.name) + '">IR 캘린더</a>' +
      '<a class="btn btn--ghost btn--sm" href="/market/">시장</a>' +
      "</div></div>" +
      '<div class="cpanel__sec"><div class="cpanel__bar"><h4>IR 일정 <span class="cnotes__count">' + ce.length + "건</span></h4>" +
      '<a class="cq__more" href="/calendar/?company=' + encodeURIComponent(c.name) + '">IR 캘린더에서 보기 →</a></div>' +
      '<div id="c-ir">' + renderEvents(upcoming, past, c) + "</div></div>" +
      '<div class="cpanel__sec"><div class="cpanel__bar"><h4>DART 공시</h4>' +
      '<div class="cseg" id="c-dart-days">' + [30, 90, 365].map((d) => '<button type="button" class="cseg__btn' + (d === dartDays ? " cseg__btn--active" : "") + '" data-days="' + d + '">' + (d === 365 ? "1년" : d + "일") + "</button>").join("") + "</div></div>" +
      '<div id="c-dart"><p class="cpanel__loading">공시를 불러오는 중…</p></div></div>' +
      "</div></section>" +
      '<section class="cpage__notes"><div class="cpanel__bar"><h4>이 기업 노트<span class="cnotes__count">' + cn.length + "건</span></h4>" +
      '<a class="cq__more" href="/notes/?company=' + encodeURIComponent(c.name) + '">노트 쓰기·전체 보기 →</a></div>' +
      '<div id="c-notes"></div></section>';
    renderNotes(cn);
    loadQuote(c);
    loadDart(c);
  }

  function evRow(ev, c) {
    const today = K.today();
    return '<a class="cev" href="/calendar/?company=' + encodeURIComponent(c.name) + '"><span class="cev__date">' + esc(K.md(ev.date)) + "</span>" +
      '<span class="cev__company">' + esc(ev.title || ev.companies || "") + '</span><span class="cev__type">' + esc(K.IR_LABEL[ev.type] || "기타") + "</span>" +
      '<span class="cev__broker">' + esc([K.dot(ev.date) + (ev.endDate && ev.endDate !== ev.date ? "~" + K.dot(ev.endDate) : ""), K.eventTime(ev), ev.brokers, ev.location].filter(Boolean).join(" · ")) +
      ((ev.endDate || ev.date) < today ? " · 지난 일정" : "") + "</span></a>";
  }
  function renderEvents(upcoming, past, c) {
    if (!upcoming.length && !past.length) return '<p class="cnotes__empty">이 기업의 IR 일정이 없습니다. <a href="/calendar/?new=1">일정 추가</a></p>';
    return upcoming.slice(0, 8).map((ev) => evRow(ev, c)).join("") + past.slice(0, Math.max(2, 8 - upcoming.length)).map((ev) => evRow(ev, c)).join("");
  }

  function renderNotes(cn) {
    const box = $("#c-notes");
    if (!cn.length) {
      box.innerHTML = '<p class="cnotes__empty">이 기업으로 쓴 노트가 없습니다. <a href="/notes/?company=' + encodeURIComponent(current.name) + '">노트 쓰기</a></p>';
      return;
    }
    box.innerHTML = '<div class="cncards">' + cn.slice(0, notesShown).map((n) =>
      '<a class="cncard" href="/notes/#note-' + esc(n.id) + '" title="' + esc(n.title) + '">' +
      '<span class="cncard__head"><span class="cncard__tag">' + esc(n.type || "기타") + '</span><span class="cncard__date">' + esc(K.dot(n.date)) + "</span></span>" +
      '<span class="cncard__title">' + esc(n.title || "(제목 없음)") + "</span>" +
      '<span class="cncard__excerpt">' + esc(stripHtml(n.body).slice(0, 160) || (n.author ? "작성 " + n.author : "")) + "</span></a>"
    ).join("") + "</div>" +
      '<div class="cnotes__more"' + (cn.length > notesShown ? "" : " hidden") + '><button type="button" class="btn btn--ghost btn--sm" data-more-notes>더 보기 (' + (cn.length - notesShown) + "건 남음)</button></div>";
  }

  async function loadQuote(c) {
    const facts = (items) => {
      if (current !== c) return;
      $("#cq-facts").innerHTML = items.map(([k, v]) => "<span><i>" + esc(k) + "</i>" + esc(v) + "</span>").join("");
    };
    if (!session.server) return facts([["시세", "브라우저 저장 모드에서는 볼 수 없습니다 · 서버 모드에서 연결됩니다"]]);
    if (!c.code) return facts([["시세", "종목코드를 몰라 시세를 볼 수 없습니다"]]);
    try {
      const data = await getJson("/api/quotes?codes=" + encodeURIComponent(c.code));
      if (current !== c) return;
      const q = (data.items || []).find((x) => x.code === c.code);
      if (!q || q.price == null) return facts([["시세", "이 종목의 시세를 찾지 못했습니다"]]);
      if (q.name && c.name === c.code) c.name = q.name;
      const dir = q.change > 0 ? "up" : q.change < 0 ? "down" : "";
      const arrow = dir === "up" ? "▲ " : dir === "down" ? "▼ " : "";
      $("#cq-price").className = dir ? "cq--" + dir : "";
      $("#cq-price").innerHTML = '<span class="cq__price">' + K.num(q.price) + '원</span><span class="cq__chg">' + arrow + K.num(Math.abs(q.change || 0)) +
        " (" + (q.changeRate > 0 ? "+" : "") + K.num(q.changeRate, 2) + "%)</span>";
      facts([["장 상태", statusLabel(q.status)], ["기준", (q.time && K.isoKst(q.time)) || K.isoKst(data.at) || "—"], ["출처", "네이버 금융"]]);
    } catch (err) {
      facts([["시세", err.code === "not_connected" ? "연결 안 됨 · " + err.message : "불러오지 못했습니다 · " + err.message]]);
    }
  }

  async function loadDart(c) {
    const box = () => (current === c ? $("#c-dart") : null);
    const say = (html) => {
      const b = box();
      if (b) b.innerHTML = html;
    };
    if (!session.server) return say('<p class="cnotes__empty">DART 공시는 서버 모드에서 연결됩니다. 이 브라우저 저장 모드에서는 볼 수 없습니다.</p>');
    if (!c.code) return say('<p class="cnotes__empty">종목코드를 알아야 공시를 볼 수 있습니다. 위 검색창에서 종목코드로 찾아 주세요.</p>');
    say('<p class="cpanel__loading">공시를 불러오는 중…</p>');
    try {
      const data = await getJson("/api/dart/disclosures?code=" + encodeURIComponent(c.code) + "&days=" + dartDays);
      const items = (data.items || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      if (!items.length) return say('<p class="cnotes__empty">' + esc(data.detail || "최근 " + (dartDays === 365 ? "1년" : dartDays + "일") + " 동안 공시가 없습니다.") + "</p>");
      say(items.slice(0, 30).map((d) => {
        const date = /^\d{8}$/.test(d.date || "") ? d.date.slice(0, 4) + "-" + d.date.slice(4, 6) + "-" + d.date.slice(6) : d.date || "";
        return '<a class="cev" href="' + esc(d.url || "#") + '" target="_blank" rel="noopener noreferrer"><span class="cev__date">' + esc(K.md(date) || date) + "</span>" +
          '<span class="cev__company">' + esc(d.title || "") + '</span><span class="cev__type">' + esc(d.filer || "공시") + "</span></a>";
      }).join("") + (items.length > 30 ? '<p class="cfin__note">최근 30건만 보여 줍니다 (전체 ' + items.length + "건).</p>" : ""));
    } catch (err) {
      say('<p class="' + (err.code === "not_connected" ? "cnotes__empty" : "cpanel__err") + '">' + (err.code === "not_connected" ? "DART 연결 안 됨 · " : "") + esc(err.message) + "</p>");
    }
  }

  pageEl.addEventListener("click", async (e) => {
    if (e.target.closest("[data-go-home]")) {
      e.preventDefault();
      input.value = "";
      goHome(true);
      return;
    }
    const days = e.target.closest("#c-dart-days .cseg__btn");
    if (days) {
      dartDays = Number(days.getAttribute("data-days"));
      K.prefs.set("company.dartDays", dartDays);
      $$("#c-dart-days .cseg__btn").forEach((b) => b.classList.toggle("cseg__btn--active", b === days));
      loadDart(current);
      return;
    }
    if (e.target.closest("[data-more-notes]")) {
      notesShown += 10;
      renderNotes(coNotes(current));
      return;
    }
    const wb = e.target.closest("[data-watch]");
    if (wb) {
      wb.disabled = true;
      const c = current;
      const w = inWatch(c);
      try {
        if (w) {
          if (!(await K.confirm(c.name + " 을(를) 관심 종목에서 뺄까요?", "빼기", true))) return;
          await watchStore.remove(w.id);
          K.toast("관심 종목에서 뺐습니다.");
        } else {
          await watchStore.create({ name: c.name, code: c.code || "", market: normMarket(c.market), sector: c.sector || "", memo: "" });
          K.toast("관심 종목에 넣었습니다. 시장 페이지에서 시세를 볼 수 있습니다.");
        }
        watchlist = watchStore.cached();
        if (current === c) renderCompany();
      } catch (err) {
        K.toast(err.message, true);
      } finally {
        wb.disabled = false;
      }
    }
  });

  /* ---------- 주소(?q= / ?code=) ---------- */
  function route() {
    const p = new URLSearchParams(location.search);
    const code = (p.get("code") || "").trim().toUpperCase();
    const q = (p.get("q") || p.get("company") || "").trim();
    if (code || q) {
      if (isCode(code)) return openCompany({ code, name: q }, true);
      if (isCode(q.toUpperCase()) && !findCo(q)) return openCompany({ code: q.toUpperCase() }, true);
      return openCompany({ name: q || code }, true);
    }
    goHome(false);
  }
  window.addEventListener("popstate", route);

  (async function init() {
    session = await K.session();
    idxState.extras = K.prefs.get("company.extras", false);
    const [n, ev, wl, uni] = await Promise.all([
      K.readNotes().catch(() => []),
      K.irEvents().list().catch(() => []),
      watchStore.list().catch(() => []),
      uniStore.list().catch(() => []),
    ]);
    notes = Array.isArray(n) ? n : [];
    events = Array.isArray(ev) ? ev : [];
    watchlist = Array.isArray(wl) ? wl : [];
    uniMeta = (uni || []).find((x) => Array.isArray(x.rows)) || null;
    buildIndex();
    route();
  })();
})();
