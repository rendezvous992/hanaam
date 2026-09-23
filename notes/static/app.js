/* 기업 노트 아카이브 — 브라우저 전용 구현
 *
 * 원본 서비스는 서버(API·DB·AI)가 동작을 맡지만, 이 복제본은 정적 파일만으로 돌아간다.
 *  - 노트 목록: localStorage("hana.notes.v1")
 *  - 녹음·첨부 파일: IndexedDB("hana-notes" / "files")
 *  - "노트에게 물어보기": AI 대신 키워드 검색으로 관련 노트를 모아 보여준다
 */
(function () {
  "use strict";

  /* ================================================================
   * 상수
   * ================================================================ */
  const NOTES_KEY = "hana.notes.v1";
  const SAVED_KEY = "hana.notes.savedAnswers";
  const GUIDE_KEY = "hana.notes.guideDismissed";
  const PAGE_SIZE = 20;

  const CATS = [
    { key: "single", label: "단독미팅" },
    { key: "group", label: "그룹미팅" },
    { key: "seminar", label: "세미나" },
    { key: "report", label: "기업레포트" },
    { key: "etc", label: "기타" },
  ];
  const CAT_LABEL = Object.fromEntries(CATS.map((c) => [c.key, c.label]));
  const TYPES = ["콥데이", "NDR", "탐방", "컨퍼런스콜", "세미나", "IR", "기업레포트", "기타"];
  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

  // 링크·파일명에서 종목을 찾을 때 쓰는 기본 목록 (저장된 노트의 종목도 함께 쓴다)
  const KNOWN_COMPANIES = [
    ["알지노믹스", "476830"], ["오스코텍", "039200"], ["올릭스", "226950"],
    ["삼성전자", "005930"], ["SK하이닉스", "000660"], ["LG에너지솔루션", "373220"],
    ["삼성바이오로직스", "207940"], ["현대차", "005380"], ["기아", "000270"],
    ["셀트리온", "068270"], ["NAVER", "035420"], ["카카오", "035720"],
    ["한미약품", "128940"], ["유한양행", "000100"], ["알테오젠", "196170"],
    ["리가켐바이오", "141080"], ["에이비엘바이오", "298380"], ["HLB", "028300"],
    ["POSCO홀딩스", "005490"], ["LG화학", "051910"], ["삼성SDI", "006400"],
    ["한화에어로스페이스", "012450"], ["HD현대중공업", "329180"], ["두산에너빌리티", "034020"],
    ["한화솔루션", "009830"], ["OCI홀딩스", "010060"], ["HD현대일렉트릭", "267260"],
  ];

  const SEED_NOTES = [
    { id: 4, company: "알지노믹스", ticker: "476830", title: "알지노믹스 콥데이" },
    { id: 3, company: "올릭스", ticker: "226950", title: "올릭스 콥데이" },
    { id: 1, company: "오스코텍", ticker: "039200", title: "오스코텍 콥데이" },
  ].map((n) => Object.assign({
    category: "group", type: "콥데이", author: "사용자", date: "2026-09-18",
    body: "", link: "", files: [], audio: null, review: null,
    createdAt: "2026-09-18T09:00:00+09:00",
  }, n));

  /* ================================================================
   * 유틸
   * ================================================================ */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const toast = (msg, err) => (window.hanaToast ? window.hanaToast(msg, err) : window.alert(msg));

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function kstToday() {
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }
  function parseYmd(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  }
  function dateHeaderLabel(ymd) {
    const d = parseYmd(ymd);
    if (!d) return "날짜 미상";
    return d.getUTCFullYear() + ". " + pad(d.getUTCMonth() + 1) + ". " + pad(d.getUTCDate()) + " (" + WEEKDAYS[d.getUTCDay()] + ")";
  }
  function dotDate(ymd) {
    return (ymd || "").replace(/-/g, ".");
  }
  function fileSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }
  function clock(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h ? h + ":" + pad(m) : m + "") + ":" + pad(s);
  }
  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function companyLabel(n) {
    return n.ticker ? n.company + " (" + n.ticker + ")" : n.company;
  }
  function readJSON(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      toast("브라우저 저장 공간에 저장하지 못했습니다.", true);
      return false;
    }
  }

  let CURRENT_USER = ($(".hana-account-copy strong") || {}).textContent || "사용자";

  /* ================================================================
   * 저장소
   *  - 서버 모드: /api/* 로 서버(SQLite)에 저장 → 부서원이 같은 노트를 본다
   *  - 브라우저 모드: localStorage + IndexedDB (서버 없이 파일만 열었을 때)
   * ================================================================ */
  let notes = [];

  function getNote(id) {
    return notes.find((n) => n.id === Number(id)) || null;
  }

  // 녹음·첨부 파일(Blob)은 localStorage 에 담기 어려워 IndexedDB 에 둔다
  const fileStore = (function () {
    let dbPromise = null;
    function db() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          if (!("indexedDB" in window)) {
            reject(new Error("이 브라우저는 IndexedDB 를 지원하지 않습니다."));
            return;
          }
          const req = window.indexedDB.open("hana-notes", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("files");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return dbPromise;
    }
    function run(mode, fn) {
      return db().then((d) => new Promise((resolve, reject) => {
        const tx = d.transaction("files", mode);
        const req = fn(tx.objectStore("files"));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }));
    }
    return {
      put: (id, blob) => run("readwrite", (s) => s.put(blob, id)),
      get: (id) => run("readonly", (s) => s.get(id)),
      del: (id) => run("readwrite", (s) => s.delete(id)),
    };
  })();

  function replaceNote(updated) {
    const i = notes.findIndex((n) => n.id === updated.id);
    if (i >= 0) notes[i] = updated;
    else notes.push(updated);
    return updated;
  }

  const localStore = {
    server: false,
    async load() {
      let list = readJSON(NOTES_KEY, null);
      if (!Array.isArray(list)) {
        list = SEED_NOTES.map((n) => Object.assign({}, n));
        writeJSON(NOTES_KEY, list);
      }
      return list;
    },
    persist() {
      if (!writeJSON(NOTES_KEY, notes)) throw new Error("브라우저 저장 공간에 저장하지 못했습니다.");
    },
    async create(data) {
      const note = Object.assign(
        { id: notes.reduce((max, n) => Math.max(max, n.id), 0) + 1, files: [], audio: null, review: null, createdAt: new Date().toISOString() },
        data
      );
      notes.push(note);
      try {
        this.persist();
      } catch (e) {
        notes.pop();
        throw e;
      }
      return note;
    },
    async update(note, data) {
      Object.assign(note, data, { updatedAt: new Date().toISOString() });
      this.persist();
      return note;
    },
    async remove(note) {
      notes = notes.filter((o) => o.id !== note.id);
      this.persist();
      const ids = (note.files || []).map((f) => f.id);
      if (note.audio) ids.push(note.audio.id);
      ids.forEach((id) => fileStore.del(id).catch(() => {}));
    },
    async addFile(note, blob, name, kind, duration) {
      const meta = { id: uid("f"), name: name || blob.name || "file", size: blob.size, type: blob.type || "", duration: Math.round(duration || 0) };
      await fileStore.put(meta.id, blob);
      if (kind === "audio") {
        if (note.audio) fileStore.del(note.audio.id).catch(() => {});
        note.audio = meta;
      } else {
        note.files = (note.files || []).concat(meta);
      }
      this.persist();
      return meta;
    },
    async removeFile(note, fileId) {
      note.files = (note.files || []).filter((f) => f.id !== fileId);
      if (note.audio && note.audio.id === fileId) note.audio = null;
      this.persist();
      fileStore.del(fileId).catch(() => {});
    },
    // { url, revoke } 또는 null
    async fileUrl(meta) {
      const blob = await fileStore.get(meta.id).catch(() => null);
      return blob ? { url: URL.createObjectURL(blob), revoke: true } : null;
    },
    async downloadUrl(meta) {
      return this.fileUrl(meta);
    },
    savedList: async () => readJSON(SAVED_KEY, []),
    async savedAdd(item) {
      const saved = readJSON(SAVED_KEY, []);
      const full = Object.assign({ id: uid("a"), savedAt: new Date().toISOString() }, item);
      saved.unshift(full);
      if (!writeJSON(SAVED_KEY, saved)) throw new Error("브라우저 저장 공간에 저장하지 못했습니다.");
      return full;
    },
  };

  function serverStore(api) {
    const noteBody = (data) => {
      const out = {};
      ["company", "ticker", "category", "type", "author", "date", "title", "body", "link", "review"].forEach((k) => {
        if (k in data) out[k] = data[k];
      });
      return out;
    };
    return {
      server: true,
      load: () => api("GET", "/api/notes"),
      async create(data) {
        return replaceNote(await api("POST", "/api/notes", noteBody(data)));
      },
      async update(note, data) {
        const merged = Object.assign({}, note, data);
        const saved = await api("PUT", "/api/notes/" + note.id, noteBody(merged));
        return replaceNote(saved);
      },
      async remove(note) {
        await api("DELETE", "/api/notes/" + note.id);
        notes = notes.filter((o) => o.id !== note.id);
      },
      async addFile(note, blob, name, kind, duration) {
        // 파일은 조각으로 먼저 올리고(Kit.files) 노트에 붙인다
        const up = await window.Kit.files.put(blob, name || blob.name || "file");
        const data = await api("POST", "/api/notes/" + note.id + "/files", { blobId: up.id, kind, duration: Math.round(duration || 0) });
        if (kind === "audio") note.audio = data;
        else note.files = (note.files || []).concat(data);
        return data;
      },
      async removeFile(note, fileId) {
        await api("DELETE", "/api/files/" + encodeURIComponent(fileId));
        note.files = (note.files || []).filter((f) => f.id !== fileId);
        if (note.audio && note.audio.id === fileId) note.audio = null;
      },
      fileUrl: (meta) => window.Kit.files.url(meta, false),
      downloadUrl: (meta) => window.Kit.files.url(meta, true),
      savedList: () => api("GET", "/api/saved"),
      savedAdd: (item) => api("POST", "/api/saved", item),
    };
  }

  let store = localStore;

  function knownCompanies() {
    const map = new Map();
    KNOWN_COMPANIES.forEach(([name, ticker]) => map.set(name, ticker));
    notes.forEach((n) => {
      if (n.company && n.company !== "미지정" && (n.ticker || !map.has(n.company))) map.set(n.company, n.ticker || "");
    });
    return map;
  }
  // 텍스트에서 종목명(가장 긴 이름 우선) 또는 6자리 종목코드를 찾는다
  function detectCompany(text) {
    if (!text) return null;
    const map = knownCompanies();
    const names = Array.from(map.keys()).sort((a, b) => b.length - a.length);
    const lower = text.toLowerCase();
    for (const name of names) {
      if (lower.includes(name.toLowerCase())) return { company: name, ticker: map.get(name) || "" };
    }
    const codes = text.match(/(?:^|[^0-9])([0-9]{6})(?![0-9])/g) || [];
    for (const raw of codes) {
      const code = raw.replace(/[^0-9]/g, "");
      for (const [name, ticker] of map) if (ticker === code) return { company: name, ticker };
    }
    return null;
  }
  function detectCategory(text) {
    if (/세미나|seminar|웨비나/i.test(text)) return "seminar";
    if (/레포트|리포트|report|보고서/i.test(text)) return "report";
    if (/콥데이|NDR|그룹|컨퍼런스|conference/i.test(text)) return "group";
    if (/단독|탐방|1:1|방문/i.test(text)) return "single";
    return "etc";
  }
  function detectType(text) {
    for (const t of ["콥데이", "NDR", "탐방", "컨퍼런스콜", "세미나", "IR"]) {
      if (text.toLowerCase().includes(t.toLowerCase())) return t;
    }
    if (/레포트|리포트|report/i.test(text)) return "기업레포트";
    return "기타";
  }
  function detectDate(text) {
    const m = /(20\d{2})[-._]?(0[1-9]|1[0-2])[-._]?(0[1-9]|[12]\d|3[01])/.exec(text || "");
    return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
  }

  /* ================================================================
   * 상태 · URL
   * ================================================================ */
  const EMPTY_STATE = { company: "", category: "", q: "", from: "", to: "", type: "", author: "", review: false, sectors: [], page: 1 };

  /* ---------- 섹터: 종목 → 섹터 (모든 노트가 같은 표를 쓴다, 모음 "company-sectors") ---------- */
  const SECTORS = ["반도체", "2차전지", "자동차", "IT·인터넷", "게임·엔터", "바이오·헬스케어", "조선·기계", "방산·우주", "화학·에너지", "철강·소재",
    "건설·부동산", "금융", "소비재·유통", "통신·미디어", "운송·물류", "기타"];
  const NO_SECTOR = "미지정";
  const sectorStore = window.Kit ? window.Kit.collection("company-sectors") : null;
  let sectorMap = new Map(); // 종목명 → { id, sector }
  function sectorOf(n) {
    const v = sectorMap.get(n.company);
    return (v && v.sector) || NO_SECTOR;
  }
  async function loadSectors() {
    if (!sectorStore) return;
    try {
      const rows = await sectorStore.list();
      sectorMap = new Map(rows.map((r) => [r.company, { id: r.id, sector: r.sector }]));
    } catch (e) {
      /* 섹터를 못 불러와도 노트는 보여 준다 */
    }
  }
  async function setSector(company, sector) {
    if (!sectorStore || !company || company === "미지정") return;
    const cur = sectorMap.get(company);
    if ((cur ? cur.sector : "") === sector) return;
    if (cur && !sector) {
      await sectorStore.remove(cur.id);
      sectorMap.delete(company);
    } else if (cur) {
      await sectorStore.update(cur.id, { company, sector });
      sectorMap.set(company, { id: cur.id, sector });
    } else if (sector) {
      const rec = await sectorStore.create({ company, sector });
      sectorMap.set(company, { id: rec.id, sector });
    }
  }
  function sectorOptions(cur) {
    const list = SECTORS.concat(cur && !SECTORS.includes(cur) ? [cur] : []);
    return '<option value="">미지정</option>' + list.map((x) => '<option value="' + esc(x) + '"' + (x === cur ? " selected" : "") + ">" + esc(x) + "</option>").join("");
  }
  let state = Object.assign({}, EMPTY_STATE);

  function readUrl() {
    const p = new URLSearchParams(window.location.search);
    state = Object.assign({}, EMPTY_STATE, {
      company: p.get("company") || "",
      category: CAT_LABEL[p.get("category")] ? p.get("category") : "",
      q: p.get("q") || "",
      from: p.get("from") || "",
      to: p.get("to") || "",
      type: p.get("type") || "",
      author: p.get("author") || "",
      review: p.get("review") === "1",
      sectors: (p.get("sector") || "").split(",").map((x) => x.trim()).filter(Boolean),
      page: Math.max(1, parseInt(p.get("page"), 10) || 1),
    });
  }
  function writeUrl() {
    const p = new URLSearchParams();
    ["company", "category", "q", "from", "to", "type", "author"].forEach((k) => {
      if (state[k]) p.set(k, state[k]);
    });
    if (state.review) p.set("review", "1");
    if (state.sectors.length) p.set("sector", state.sectors.join(","));
    if (state.page > 1) p.set("page", String(state.page));
    const qs = p.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : "") + window.location.hash);
  }
  function setState(patch, keepPage) {
    Object.assign(state, patch);
    if (!keepPage) state.page = 1;
    writeUrl();
    render();
  }

  function searchTokens(q) {
    return (q || "").toLowerCase().split(/\s+/).filter(Boolean);
  }
  function haystack(n) {
    return [n.company, n.ticker, n.title, n.body, n.type, n.author, CAT_LABEL[n.category]].join("\n").toLowerCase();
  }
  // skip: 개수 계산 때 무시할 조건 (예: 종목 레일은 종목 조건을 빼고 센다)
  function matches(n, skip) {
    skip = skip || {};
    if (!skip.company && state.company && n.company !== state.company) return false;
    if (!skip.category && state.category && n.category !== state.category) return false;
    if (state.from && n.date < state.from) return false;
    if (state.to && n.date > state.to) return false;
    if (state.type && n.type !== state.type) return false;
    if (state.author && n.author !== state.author) return false;
    if (!skip.review && state.review && !n.review) return false;
    if (!skip.sector && state.sectors.length && !state.sectors.includes(sectorOf(n))) return false;
    const tokens = searchTokens(state.q);
    if (tokens.length) {
      const hay = haystack(n);
      if (!tokens.every((t) => hay.includes(t))) return false;
    }
    return true;
  }
  function byNewest(a, b) {
    return (b.date || "").localeCompare(a.date || "") || b.id - a.id;
  }
  function detailFilterCount() {
    return ["from", "to", "type", "author"].filter((k) => state[k]).length;
  }
  function anyFilter() {
    return !!(state.company || state.category || state.q || state.review || state.sectors.length || detailFilterCount());
  }

  /* ================================================================
   * 렌더링
   * ================================================================ */
  const el = {
    companyList: $("#company-list"),
    companyCount: $("#company-count"),
    companyFilter: $("#company-filter"),
    docTabs: $("#doc-tabs"),
    noteList: $("#note-list"),
    resultsTitle: $("#results-title"),
    resultsCount: $("#results-count"),
    resultsClear: $("#results-clear"),
    pager: $("#pager"),
    searchInput: $("#search-input"),
    searchClear: $("#search-clear"),
    filtersToggle: $("#filters-toggle"),
    filters: $("#search-filters"),
    filtersCount: $("#filters-count"),
    filterFrom: $("#filter-from"),
    filterTo: $("#filter-to"),
    filterType: $("#filter-type"),
    filterAuthor: $("#filter-author"),
    reviewRail: $("#review-rail"),
    reviewRailList: $("#review-rail-list"),
    reviewRailCount: $("#review-rail-count"),
    reviewToggle: $("#review-toggle"),
    reviewToggleCount: $("#review-toggle-count"),
    seminarRail: $("#seminar-rail"),
    reportRail: $("#report-rail"),
  };

  function renderCompanies() {
    const pool = notes.filter((n) => matches(n, { company: true }));
    const counts = new Map();
    pool.forEach((n) => {
      const cur = counts.get(n.company) || { count: 0, label: companyLabel(n) };
      cur.count += 1;
      if (n.ticker) cur.label = companyLabel(n);
      counts.set(n.company, cur);
    });
    // 선택된 종목은 개수가 0 이어도 목록에 남긴다
    if (state.company && !counts.has(state.company)) {
      const any = notes.find((n) => n.company === state.company);
      counts.set(state.company, { count: 0, label: any ? companyLabel(any) : state.company });
    }
    const needle = el.companyFilter.value.trim().toLowerCase();
    const entries = Array.from(counts.entries())
      .filter(([name, v]) => !needle || v.label.toLowerCase().includes(needle))
      .sort((a, b) => a[0].localeCompare(b[0], "ko"));

    let html =
      '<li>\n    <button type="button" class="company-item' + (state.company ? "" : " company-item--active") + '" data-company="">' +
      '\n      <span class="company-item__name">전체</span>\n      <span class="company-item__count">' + pool.length + "</span>\n    </button></li>";
    entries.forEach(([name, v]) => {
      html +=
        '<li>\n      <button type="button" class="company-item ' + (state.company === name ? "company-item--active" : "") +
        '" data-company="' + esc(name) + '" title="' + esc(v.label) + '">' +
        '\n        <span class="company-item__name">' + esc(v.label) + '</span>\n        <span class="company-item__count">' + v.count + "</span>\n      </button></li>";
    });
    if (needle && !entries.length) html += '<li class="company-list__empty">일치하는 종목이 없습니다.</li>';
    el.companyList.innerHTML = html;
    el.companyCount.textContent = String(counts.size);
  }

  function renderSectors() {
    const bar = $("#sector-bar");
    if (!bar) return;
    const pool = notes.filter((n) => matches(n, { sector: true }));
    const counts = new Map();
    pool.forEach((n) => counts.set(sectorOf(n), (counts.get(sectorOf(n)) || 0) + 1));
    // 노트가 있는 섹터 + 체크해 둔 섹터를 보여 준다
    const names = SECTORS.concat([NO_SECTOR]).filter((x) => counts.get(x) || state.sectors.includes(x));
    Array.from(counts.keys()).forEach((x) => {
      if (!names.includes(x)) names.splice(names.length - 1, 0, x);
    });
    bar.innerHTML =
      '<span class="sector-bar__label">섹터</span>' +
      '<div class="sector-bar__chips" role="group" aria-label="섹터로 거르기">' +
      (names.length
        ? names.map((x) => '<label class="sector-chip' + (state.sectors.includes(x) ? " is-on" : "") + (x === NO_SECTOR ? " sector-chip--none" : "") + '"><input type="checkbox" value="' + esc(x) + '"' +
            (state.sectors.includes(x) ? " checked" : "") + "> " + esc(x) + ' <span class="sector-chip__count">' + (counts.get(x) || 0) + "</span></label>").join("")
        : '<span class="sector-bar__empty">노트가 없습니다</span>') +
      "</div>" +
      (state.sectors.length ? '<button type="button" class="sector-bar__btn" data-sector-clear>체크 해제</button>' : "") +
      '<button type="button" class="sector-bar__btn" data-sector-edit>종목별 섹터 지정</button>';
  }

  function renderTabs() {
    const pool = notes.filter((n) => matches(n, { category: true }));
    $$(".doc-tab", el.docTabs).forEach((tab) => {
      const key = tab.getAttribute("data-category");
      const active = key === state.category;
      tab.classList.toggle("doc-tab--active", active);
      tab.setAttribute("aria-selected", String(active));
      const count = key ? pool.filter((n) => n.category === key).length : pool.length;
      const badge = $(".doc-tab__count", tab);
      if (badge) badge.textContent = String(count);
    });
  }

  function highlight(text, tokens) {
    let out = esc(text);
    tokens.forEach((t) => {
      const safe = esc(t);
      if (!safe) return;
      out = out.replace(new RegExp("(" + escRe(safe) + ")(?![^<]*>)", "gi"), "<mark>$1</mark>");
    });
    return out;
  }
  function excerpt(body, tokens) {
    const flat = (body || "").replace(/\s+/g, " ").trim();
    if (!flat || !tokens.length) return "";
    const lower = flat.toLowerCase();
    let at = -1;
    for (const t of tokens) {
      at = lower.indexOf(t);
      if (at >= 0) break;
    }
    if (at < 0) return "";
    const start = Math.max(0, at - 40);
    const end = Math.min(flat.length, at + 120);
    return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
  }

  function cardHtml(n, tokens) {
    const clip = [];
    if (n.audio) clip.push("🎙 녹음");
    if (n.files && n.files.length) clip.push("📎 " + n.files.length);
    else if (n.link) clip.push("🔗 링크");
    const ex = excerpt(n.body, tokens);
    return (
      '<article class="note-card ' + (n.review ? "note-card--review" : "") + '" data-id="' + n.id + '" role="button" tabindex="0">' +
      '\n    <div class="note-card__head">' +
      '\n      <span class="note-card__company">' + esc(companyLabel(n)) + "</span>" +
      '\n      <span class="cat-chip cat-chip--' + esc(n.category) + '">' + esc(CAT_LABEL[n.category] || "기타") + "</span>" +
      (n.type ? '\n      <span class="type-chip">' + esc(n.type) + "</span>" : "") +
      (sectorOf(n) !== NO_SECTOR ? '\n      <span class="sector-tag">' + esc(sectorOf(n)) + "</span>" : "") +
      (clip.length ? '\n      <span class="note-card__clip">' + esc(clip.join(" · ")) + "</span>" : "") +
      '\n      <span class="note-card__author">' + esc(n.author) + "</span>" +
      '\n      <span class="note-card__date">' + esc(dotDate(n.date)) + "</span>" +
      "\n    </div>" +
      '\n    <div class="note-card__title">' + highlight(n.title, tokens) + "</div>" +
      (ex ? '\n    <div class="note-card__excerpt">' + highlight(ex, tokens) + "</div>" : "") +
      (n.review
        ? '\n    <div class="note-card__flags"><span class="review-badge">확인 필요 · ' + esc(n.review.reason || "") + "</span></div>"
        : "") +
      "</article>"
    );
  }

  function renderList() {
    const list = notes.filter((n) => matches(n)).sort(byNewest);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    const slice = list.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    const tokens = searchTokens(state.q);

    // 제목
    let title = "전체 노트";
    if (state.company) {
      const any = notes.find((n) => n.company === state.company);
      title = (any ? companyLabel(any) : state.company) + " 노트";
    } else if (state.category) {
      title = CAT_LABEL[state.category] + " 노트";
    }
    if (state.q) title = "‘" + state.q + "’ 검색 결과";
    if (state.review) title = "확인 필요한 노트";
    el.resultsTitle.textContent = title;
    el.resultsCount.textContent = list.length + "건";
    el.resultsClear.hidden = !anyFilter();

    if (!list.length) {
      const filtered = anyFilter();
      el.noteList.innerHTML =
        '<div class="results__empty"><p class="results__empty-title">' +
        (filtered ? "조건에 맞는 노트가 없습니다" : "아직 등록된 노트가 없습니다") +
        '</p><p class="results__empty-text">' +
        (filtered
          ? "검색어나 필터를 바꾸거나 <strong>필터 초기화</strong>를 눌러 보세요."
          : "오른쪽 위 <strong>+ 노트 등록</strong>이나 <strong>녹음</strong>으로 첫 노트를 남겨 보세요.") +
        "</p></div>";
    } else {
      const groups = [];
      slice.forEach((n) => {
        const last = groups[groups.length - 1];
        if (last && last.date === n.date) last.items.push(n);
        else groups.push({ date: n.date, items: [n] });
      });
      el.noteList.innerHTML = groups
        .map((g) => {
          const total = list.filter((n) => n.date === g.date).length;
          return (
            '<div class="note-date-header"><span class="note-date-header__label">' + esc(dateHeaderLabel(g.date)) +
            '</span><span class="note-date-header__count">' + total + "건</span></div>" +
            g.items.map((n) => cardHtml(n, tokens)).join("")
          );
        })
        .join("");
    }
    renderPager(pages);
  }

  function renderPager(pages) {
    if (pages <= 1) {
      el.pager.hidden = true;
      el.pager.innerHTML = "";
      return;
    }
    const cur = state.page;
    const nums = [];
    for (let i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - cur) <= 2) nums.push(i);
      else if (nums[nums.length - 1] !== "gap") nums.push("gap");
    }
    let html = '<button type="button" class="pager__btn" data-page="' + (cur - 1) + '"' + (cur === 1 ? " disabled" : "") + ' aria-label="이전 페이지">‹</button>';
    nums.forEach((n) => {
      if (n === "gap") html += '<span class="pager__gap">…</span>';
      else
        html += '<button type="button" class="pager__btn' + (n === cur ? " pager__btn--current" : "") + '" data-page="' + n + '"' +
          (n === cur ? ' disabled aria-current="page"' : "") + ">" + n + "</button>";
    });
    html += '<button type="button" class="pager__btn" data-page="' + (cur + 1) + '"' + (cur === pages ? " disabled" : "") + ' aria-label="다음 페이지">›</button>';
    el.pager.innerHTML = html;
    el.pager.hidden = false;
  }

  function renderReview() {
    const pending = notes.filter((n) => n.review).sort(byNewest);
    el.reviewRail.hidden = !pending.length;
    el.reviewToggle.hidden = !pending.length && !state.review;
    el.reviewRailCount.textContent = String(pending.length);
    el.reviewToggleCount.textContent = String(pending.length);
    el.reviewToggle.classList.toggle("review-toggle--active", state.review);
    el.reviewToggle.setAttribute("aria-pressed", String(state.review));
    el.reviewRailList.innerHTML = pending
      .map(
        (n) =>
          '<li><button type="button" class="review-item" data-open="' + n.id + '">' +
          '<span class="review-item__title">' + esc(n.title) + "</span>" +
          '<span class="review-item__reason">' + esc(n.review.reason || "확인 필요") + "</span></button></li>"
      )
      .join("");
  }

  function renderSideRail(rail, category) {
    const items = notes.filter((n) => n.category === category).sort(byNewest);
    rail.hidden = !items.length;
    $("[data-rail-count]", rail).textContent = String(items.length);
    $("[data-rail-list]", rail).innerHTML = items
      .slice(0, 12)
      .map(
        (n) =>
          '<li><button type="button" class="side-item" data-open="' + n.id + '" title="' + esc(n.title) + '">' +
          '<span class="side-item__title">' + esc(n.title) + "</span>" +
          '<span class="side-item__date">' + esc(dotDate(n.date).slice(5)) + "</span></button></li>"
      )
      .join("");
  }

  function fillSelect(select, values, current) {
    const opts = ['<option value="">전체</option>'].concat(
      values.map((v) => '<option value="' + esc(v) + '"' + (v === current ? " selected" : "") + ">" + esc(v) + "</option>")
    );
    select.innerHTML = opts.join("");
    select.value = current || "";
  }

  function renderFilters() {
    el.searchInput.value = state.q;
    el.searchClear.hidden = !el.searchInput.value;
    el.filterFrom.value = state.from;
    el.filterTo.value = state.to;
    const types = Array.from(new Set(TYPES.concat(notes.map((n) => n.type).filter(Boolean))));
    fillSelect(el.filterType, types, state.type);
    const authors = Array.from(new Set(notes.map((n) => n.author).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko"));
    fillSelect(el.filterAuthor, authors, state.author);
    const count = detailFilterCount();
    el.filtersCount.hidden = !count;
    el.filtersCount.textContent = String(count);
  }

  function render() {
    renderFilters();
    renderSectors();
    renderCompanies();
    renderTabs();
    renderList();
    renderReview();
    renderSideRail(el.seminarRail, "seminar");
    renderSideRail(el.reportRail, "report");
  }

  /* ================================================================
   * 모달 공통
   * ================================================================ */
  const modalStack = [];

  function openModal(opts) {
    const titleId = uid("m");
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML =
      '<div class="modal ' + (opts.size || "") + '" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '">' +
      '<div class="modal__header"><h2 id="' + titleId + '">' + esc(opts.title) + "</h2>" +
      '<button type="button" class="modal__close" aria-label="닫기">×</button></div></div>';
    const modal = overlay.firstElementChild;
    modal.insertAdjacentHTML("beforeend", opts.html || "");
    document.body.appendChild(overlay);

    const ctx = {
      overlay,
      modal,
      returnFocus: document.activeElement,
      beforeClose: opts.beforeClose || null,
      onClose: opts.onClose || null,
      setTitle(text) {
        $("#" + titleId, modal).textContent = text;
      },
      close(force) {
        if (!force && ctx.beforeClose && ctx.beforeClose() === false) return;
        const i = modalStack.indexOf(ctx);
        if (i >= 0) modalStack.splice(i, 1);
        overlay.remove();
        if (!modalStack.length) document.body.style.overflow = "";
        if (ctx.onClose) ctx.onClose();
        if (ctx.returnFocus && document.contains(ctx.returnFocus)) ctx.returnFocus.focus();
      },
    };
    $(".modal__close", modal).addEventListener("click", () => ctx.close());
    // 바깥(어두운 영역)을 눌렀다 뗐을 때만 닫는다 — 입력칸에서 드래그하다 밖에서 놓는 경우 보호
    let downOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => {
      downOnOverlay = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (downOnOverlay && e.target === overlay) ctx.close();
      downOnOverlay = false;
    });

    modalStack.push(ctx);
    document.body.style.overflow = "hidden";
    window.setTimeout(() => {
      const first = opts.focus ? $(opts.focus, modal) : null;
      (first || $(".modal__close", modal)).focus();
    }, 0);
    return ctx;
  }

  document.addEventListener("keydown", (e) => {
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    if (e.key === "Escape") {
      e.preventDefault();
      top.close();
    } else if (e.key === "Tab") {
      // 모달 안에서만 포커스가 돌도록
      const focusables = $$(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        top.modal
      ).filter((n) => n.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  function confirmDialog(message, okLabel, danger) {
    return new Promise((resolve) => {
      let answered = false;
      const ctx = openModal({
        title: "확인",
        size: "modal--narrow",
        html:
          '<div class="modal__body"><p class="hint" style="font-size:14px;color:var(--text)">' + esc(message) + "</p>" +
          '<div class="modal__footer"><div class="modal__footer-right">' +
          '<button type="button" class="btn btn--ghost" data-act="cancel">취소</button>' +
          '<button type="button" class="btn ' + (danger ? "btn--danger" : "btn--primary") + '" data-act="ok">' + esc(okLabel || "확인") + "</button>" +
          "</div></div></div>",
        focus: '[data-act="ok"]',
        onClose: () => {
          if (!answered) resolve(false);
        },
      });
      ctx.modal.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        answered = true;
        resolve(btn.getAttribute("data-act") === "ok");
        ctx.close(true);
      });
    });
  }

  /* ================================================================
   * 본문 렌더링 (# 제목, ## 소제목, - 목록, Q./A., 키: 값, ![](이미지))
   * ================================================================ */
  function inline(text) {
    let out = esc(text);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(https?:\/\/[^\s<]+)/g, '<a class="detail-attach__link" href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return out;
  }
  function renderBody(body) {
    const lines = (body || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let list = null;
    const closeList = () => {
      if (list) {
        out.push('<ul class="nb__list">' + list.join("") + "</ul>");
        list = null;
      }
    };
    lines.forEach((raw) => {
      const line = raw.replace(/\s+$/, "");
      let m;
      if (!line.trim()) {
        closeList();
        return;
      }
      if ((m = /^\s{2,}[-*•·]\s+(.*)$/.exec(line))) {
        (list = list || []).push('<li class="nb__sub">' + inline(m[1]) + "</li>");
        return;
      }
      if ((m = /^[-*•·]\s+(.*)$/.exec(line))) {
        (list = list || []).push('<li class="nb__item">' + inline(m[1]) + "</li>");
        return;
      }
      closeList();
      if ((m = /^#\s+(.*)$/.exec(line))) out.push('<div class="nb__h1">' + inline(m[1]) + "</div>");
      else if ((m = /^#{2,4}\s+(.*)$/.exec(line))) out.push('<div class="nb__h2">' + inline(m[1]) + "</div>");
      else if ((m = /^!\[([^\]]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)$/.exec(line.trim())))
        out.push('<figure class="nb__figure"><img class="nb__img" src="' + esc(m[2]) + '" alt="' + esc(m[1]) + '" loading="lazy"></figure>');
      else if ((m = /^Q\s*[.:)]\s*(.*)$/.exec(line))) out.push('<p class="nb__q">Q. ' + inline(m[1]) + "</p>");
      else if ((m = /^A\s*[.:)]\s*(.*)$/.exec(line))) out.push('<p class="nb__a">' + inline(m[1]) + "</p>");
      else if ((m = /^([가-힣A-Za-z]{1,8})\s*[:：]\s+(.+)$/.exec(line)))
        out.push('<div class="nb__meta"><span class="nb__key">' + esc(m[1]) + '</span><span class="nb__val">' + inline(m[2]) + "</span></div>");
      else out.push('<p class="nb__p">' + inline(line) + "</p>");
    });
    closeList();
    return out.join("");
  }

  /* ================================================================
   * 오디오 플레이어 (.aplayer)
   * ================================================================ */
  function mountPlayer(container, src) {
    container.insertAdjacentHTML(
      "beforeend",
      '<button type="button" class="aplayer__btn" aria-label="재생">▶</button>' +
        '<div class="aplayer__bar aplayer__bar--disabled" role="slider" tabindex="0" aria-label="재생 위치" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">' +
        '<div class="aplayer__fill"></div><div class="aplayer__knob"></div></div>' +
        '<span class="aplayer__time">0:00 / 0:00</span>'
    );
    const audio = new Audio();
    audio.preload = "metadata";
    audio.src = src;
    const btn = $(".aplayer__btn", container);
    const bar = $(".aplayer__bar", container);
    const fill = $(".aplayer__fill", container);
    const knob = $(".aplayer__knob", container);
    const time = $(".aplayer__time", container);
    let duration = 0;

    // MediaRecorder 로 만든 webm 은 길이가 Infinity 로 나올 때가 있어 끝까지 한 번 찾아가 길이를 얻는다
    function resolveDuration() {
      if (isFinite(audio.duration) && audio.duration > 0) {
        duration = audio.duration;
        bar.classList.remove("aplayer__bar--disabled");
        bar.setAttribute("aria-valuemax", String(Math.round(duration)));
        paint();
        return;
      }
      const fix = () => {
        audio.removeEventListener("timeupdate", fix);
        audio.currentTime = 0;
        resolveDuration();
      };
      audio.addEventListener("timeupdate", fix);
      audio.currentTime = 1e7;
    }
    function paint() {
      const pct = duration ? Math.min(100, (audio.currentTime / duration) * 100) : 0;
      fill.style.width = pct + "%";
      knob.style.left = pct + "%";
      time.textContent = clock(audio.currentTime) + " / " + clock(duration);
      bar.setAttribute("aria-valuenow", String(Math.round(audio.currentTime)));
    }
    function seekTo(clientX) {
      if (!duration) return;
      const r = bar.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      audio.currentTime = ratio * duration;
      paint();
    }
    audio.addEventListener("loadedmetadata", resolveDuration, { once: true });
    audio.addEventListener("timeupdate", paint);
    audio.addEventListener("play", () => {
      btn.textContent = "❚❚";
      btn.setAttribute("aria-label", "일시정지");
    });
    audio.addEventListener("pause", () => {
      btn.textContent = "▶";
      btn.setAttribute("aria-label", "재생");
    });
    audio.addEventListener("ended", paint);
    btn.addEventListener("click", () => {
      if (audio.paused) audio.play().catch(() => toast("재생할 수 없는 파일입니다.", true));
      else audio.pause();
    });
    bar.addEventListener("pointerdown", (e) => {
      if (!duration) return;
      bar.setPointerCapture(e.pointerId);
      seekTo(e.clientX);
      const move = (ev) => seekTo(ev.clientX);
      const up = () => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });
    bar.addEventListener("keydown", (e) => {
      if (!duration) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        audio.currentTime = Math.min(duration, Math.max(0, audio.currentTime + (e.key === "ArrowRight" ? 5 : -5)));
        paint();
      }
    });
    return {
      audio,
      destroy() {
        audio.pause();
        audio.removeAttribute("src");
      },
    };
  }

  /* ================================================================
   * 노트 상세
   * ================================================================ */
  function openDetail(id) {
    const n = getNote(id);
    if (!n) {
      toast("노트를 찾을 수 없습니다.", true);
      return;
    }
    const urls = [];
    let player = null;
    const siblings = notes.filter((o) => o.company === n.company && o.id !== n.id).sort(byNewest);

    const attach = [];
    if (n.link)
      attach.push(
        '<div class="detail-attach__row"><a class="detail-attach__link" href="' + esc(n.link) + '" target="_blank" rel="noopener noreferrer">🔗 원문 링크</a>' +
          '<span class="detail-attach__meta">' + esc(n.link) + "</span></div>"
      );
    (n.files || []).forEach((f) =>
      attach.push(
        '<div class="detail-attach__row"><a class="detail-attach__link" href="#" data-file="' + esc(f.id) + '">📎 ' + esc(f.name) + "</a>" +
          '<span class="detail-attach__meta">' + esc(fileSize(f.size)) + "</span></div>"
      )
    );

    const html =
      '<div class="detail-split">' +
      '<div class="modal__body">' +
      (n.review
        ? '<div class="approve-bar"><div class="approve-bar__text"><span class="approve-bar__head">확인이 필요한 노트입니다</span>' +
          '<span class="approve-bar__why">' + esc(n.review.reason || "") + "</span></div>" +
          '<button type="button" class="btn btn--sm btn--ghost" data-act="edit">정보 고치기</button>' +
          '<button type="button" class="btn btn--sm btn--primary" data-act="approve">확인 완료</button></div>'
        : "") +
      '<div class="detail-meta">' +
      '<span class="detail-meta__company">' + esc(companyLabel(n)) + "</span>" +
      '<span class="cat-chip cat-chip--' + esc(n.category) + '">' + esc(CAT_LABEL[n.category] || "기타") + "</span>" +
      (n.type ? '<span class="type-chip">' + esc(n.type) + "</span>" : "") +
      '<div class="detail-meta__row">' + esc(dotDate(n.date)) + " · " + esc(n.author) + "</div>" +
      "</div>" +
      (n.audio
        ? '<div class="detail-audio-wrap" data-audio><span class="detail-audio-label">🎙 녹음</span></div>' +
          '<p class="detail-audio-note">녹음 파일은 이 브라우저에만 저장되어 있습니다. 자동 받아쓰기는 지원하지 않으니 본문은 직접 정리해 주세요.</p>'
        : "") +
      (attach.length ? '<div class="detail-attach">' + attach.join("") + "</div>" : "") +
      (n.body && n.body.trim()
        ? '<div class="detail-body">' + renderBody(n.body) + "</div>"
        : '<div class="detail-body detail-body--empty">본문이 없습니다.</div>') +
      '<div class="modal__footer">' +
      '<button type="button" class="btn btn--danger btn--sm" data-act="delete">삭제</button>' +
      '<div class="modal__footer-right">' +
      '<button type="button" class="btn btn--ghost btn--sm" data-act="print">인쇄</button>' +
      '<button type="button" class="btn btn--ghost btn--sm" data-act="edit">수정</button>' +
      '<button type="button" class="btn btn--primary btn--sm" data-act="close">닫기</button>' +
      "</div></div>" +
      "</div>" +
      '<aside class="detail-split__side"' + (siblings.length ? "" : " hidden") + ">" +
      '<div class="company-rail__header"><h3 class="company-rail__title">같은 종목 노트</h3><span class="company-rail__count">' + siblings.length + "</span></div>" +
      '<ul class="side-rail__list" style="margin-top:12px">' +
      siblings
        .map(
          (o) =>
            '<li><button type="button" class="side-item" data-open="' + o.id + '" title="' + esc(o.title) + '">' +
            '<span class="side-item__title">' + esc(o.title) + '</span><span class="side-item__date">' + esc(dotDate(o.date)) + "</span></button></li>"
        )
        .join("") +
      "</ul></aside>" +
      "</div>";

    const ctx = openModal({
      title: n.title,
      size: "modal--split" + (siblings.length ? "" : " modal--wide"),
      html,
      focus: '[data-act="close"]',
      onClose() {
        if (player) player.destroy();
        urls.forEach((u) => URL.revokeObjectURL(u));
        if (window.location.hash === "#note-" + n.id) {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
      },
    });
    window.history.replaceState(null, "", window.location.pathname + window.location.search + "#note-" + n.id);

    if (n.audio) {
      store
        .fileUrl(n.audio)
        .then((got) => {
          const wrap = $("[data-audio]", ctx.modal);
          if (!wrap || !document.contains(wrap)) {
            if (got && got.revoke) URL.revokeObjectURL(got.url);
            return;
          }
          if (!got) {
            wrap.insertAdjacentHTML("beforeend", '<span class="detail-audio-note">녹음 파일을 찾을 수 없습니다.</span>');
            return;
          }
          if (got.revoke) urls.push(got.url);
          player = mountPlayer(wrap, got.url);
        })
        .catch(() => toast("녹음 파일을 불러오지 못했습니다.", true));
    }

    ctx.modal.addEventListener("click", async (e) => {
      const fileLink = e.target.closest("[data-file]");
      if (fileLink) {
        e.preventDefault();
        const meta = (n.files || []).find((f) => f.id === fileLink.getAttribute("data-file"));
        const got = meta ? await store.downloadUrl(meta).catch(() => null) : null;
        if (!got) {
          toast("첨부 파일을 찾을 수 없습니다.", true);
          return;
        }
        if (got.revoke) urls.push(got.url);
        const a = document.createElement("a");
        a.href = got.url;
        a.download = meta.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }
      const open = e.target.closest("[data-open]");
      if (open) {
        ctx.close(true);
        openDetail(open.getAttribute("data-open"));
        return;
      }
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const what = act.getAttribute("data-act");
      if (what === "close") ctx.close();
      else if (what === "print") printNote(n);
      else if (what === "edit") {
        ctx.close(true);
        openEditor(n);
      } else if (what === "approve") {
        act.disabled = true;
        try {
          await store.update(n, { review: null });
          render();
          ctx.close(true);
          toast("확인 완료로 표시했습니다.");
        } catch (err) {
          act.disabled = false;
          toast(err.message, true);
        }
      } else if (what === "delete") {
        if (!(await confirmDialog("‘" + n.title + "’ 노트를 삭제할까요? 되돌릴 수 없습니다.", "삭제", true))) return;
        try {
          await store.remove(n);
        } catch (err) {
          toast(err.message, true);
          return;
        }
        ctx.close(true);
        render();
        toast("노트를 삭제했습니다.");
      }
    });
  }

  function printNote(n) {
    const area = $("#print-area");
    $("#print-title").textContent = n.title;
    $("#print-meta").textContent = [companyLabel(n), CAT_LABEL[n.category], n.type, dotDate(n.date), n.author].filter(Boolean).join(" · ");
    $("#print-body").innerHTML = n.body && n.body.trim() ? renderBody(n.body) : "<p>본문이 없습니다.</p>";
    area.setAttribute("aria-hidden", "false");
    document.body.classList.add("printing");
    const done = () => {
      document.body.classList.remove("printing");
      area.setAttribute("aria-hidden", "true");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
    // afterprint 를 주지 않는 브라우저 대비
    window.setTimeout(done, 1000);
  }

  /* ================================================================
   * 노트 등록 · 수정
   * ================================================================ */
  function categoryChips(name, current) {
    return CATS.map(
      (c) =>
        '<label class="chip"><input type="radio" name="' + name + '" value="' + c.key + '"' + (c.key === current ? " checked" : "") +
        "><span>" + c.label + "</span></label>"
    ).join("");
  }
  function companyDatalist(id) {
    return (
      '<datalist id="' + id + '">' +
      Array.from(knownCompanies().keys())
        .sort((a, b) => a.localeCompare(b, "ko"))
        .map((name) => '<option value="' + esc(name) + '"></option>')
        .join("") +
      "</datalist>"
    );
  }

  function openEditor(existing) {
    const editing = !!existing;
    const n = existing || {
      company: state.company || "", ticker: "", category: state.category || "group", type: "콥데이",
      date: kstToday(), author: CURRENT_USER, title: "", body: "", link: "", files: [],
    };
    if (!n.ticker && n.company) n.ticker = knownCompanies().get(n.company) || "";
    const listId = uid("dl");
    let keptFiles = (n.files || []).slice();
    let bulkFiles = [];
    let dirty = false;
    let bulkBusy = false;

    const single =
      '<form class="modal__body" id="note-form" novalidate>' +
      '<div class="link-import">' +
      '<span class="field__label">링크로 가져오기 <span class="field__label-note">— 기사·레포트 링크만 붙여넣어도 종목이 채워집니다</span></span>' +
      '<div class="link-import__row"><input type="url" class="input" name="link" placeholder="https://" value="' + esc(n.link || "") + '">' +
      '<button type="button" class="btn btn--primary btn--sm" data-act="import">가져오기</button></div></div>' +
      '<div class="field-row">' +
      '<label class="field"><span class="field__label">종목명 <em class="required">*</em></span>' +
      '<input class="input" name="company" list="' + listId + '" required autocomplete="off" value="' + esc(n.company === "미지정" ? "" : n.company) + '">' +
      companyDatalist(listId) + "</label>" +
      '<label class="field"><span class="field__label">종목코드</span>' +
      '<input class="input" name="ticker" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="6자리" value="' + esc(n.ticker || "") + '"></label>' +
      "</div>" +
      '<div class="field"><span class="field__label">분류 <em class="required">*</em></span><div class="chip-group">' + categoryChips("category", n.category) + "</div></div>" +
      '<label class="field"><span class="field__label">섹터 <span class="field__label-note">— 종목마다 한 번만 정하면 그 종목의 모든 노트에 적용됩니다</span></span>' +
      '<select class="input" name="sector">' + sectorOptions(n.company ? (sectorMap.get(n.company) || {}).sector || "" : "") + "</select></label>" +
      '<div class="field-row field-row--three">' +
      '<label class="field"><span class="field__label">유형</span><select class="input" name="type">' +
      Array.from(new Set(TYPES.concat(n.type ? [n.type] : [])))
        .map((t) => '<option value="' + esc(t) + '"' + (t === n.type ? " selected" : "") + ">" + esc(t) + "</option>")
        .join("") +
      "</select></label>" +
      '<label class="field"><span class="field__label">날짜 <em class="required">*</em></span><input class="input" type="date" name="date" required value="' + esc(n.date) + '"></label>' +
      '<label class="field"><span class="field__label">작성자</span><input class="input" name="author" value="' + esc(n.author) + '"></label>' +
      "</div>" +
      '<label class="field"><span class="field__label">제목 <span class="field__label-note">— 비워 두면 ‘종목명 유형’으로 저장됩니다</span></span>' +
      '<input class="input" name="title" maxlength="200" value="' + esc(n.title) + '"></label>' +
      '<label class="field"><span class="field__label">본문 <span class="field__label-note">— <code># 제목</code> <code>## 소제목</code> <code>- 목록</code> <code>Q. / A.</code> 형식이 보기 좋게 정리됩니다</span></span>' +
      '<textarea class="input input--textarea input--body" name="body" rows="10">' + esc(n.body) + "</textarea></label>" +
      '<div class="field"><span class="field__label">첨부 파일 <span class="field__label-note">— 이 브라우저에만 저장됩니다</span></span>' +
      '<ul class="file-list" data-kept></ul>' +
      '<input class="input input--file" type="file" name="files" multiple></div>' +
      '<div class="modal__footer">' +
      (editing ? '<button type="button" class="btn btn--danger btn--sm" data-act="delete">삭제</button>' : "") +
      '<div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-act="cancel">취소</button>' +
      '<button type="submit" class="btn btn--primary">' + (editing ? "수정 저장" : "등록") + "</button></div></div>" +
      "</form>";

    const bulk =
      '<div class="modal__body">' +
      '<p class="hint">텍스트 파일(.txt, .md)을 여러 개 올리면 파일마다 노트 한 건씩 만듭니다. 파일 이름과 내용에서 <strong>종목·분류·날짜</strong>를 찾아 채우고, 종목을 못 찾은 노트는 <strong>확인 필요</strong>로 표시합니다.</p>' +
      '<label class="dropzone" data-drop><input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" multiple hidden data-bulk-input>' +
      '<p class="dropzone__title">파일을 끌어다 놓거나 눌러서 고르세요</p><p class="dropzone__text">예: <code>20260918_올릭스_콥데이.txt</code></p></label>' +
      '<ul class="file-list" data-bulk-list></ul>' +
      '<div data-bulk-status></div>' +
      '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-act="cancel">닫기</button>' +
      '<button type="button" class="btn btn--primary" data-act="bulk" disabled>일괄 등록</button></div></div>' +
      "</div>";

    const html = editing
      ? single
      : '<div class="pane-switch" role="tablist">' +
        '<button type="button" class="pane-switch__btn pane-switch__btn--on" role="tab" aria-selected="true" data-pane="single">한 건 등록</button>' +
        '<button type="button" class="pane-switch__btn" role="tab" aria-selected="false" data-pane="bulk">여러 건 한번에</button></div>' +
        '<div class="pane-viewport"><div class="pane-track" data-pane="single">' +
        '<div class="pane" data-pane-id="single">' + single + "</div>" +
        '<div class="pane" data-pane-id="bulk">' + bulk + "</div>" +
        "</div></div>";

    const ctx = openModal({
      title: editing ? "노트 수정" : "노트 등록",
      size: "modal--wide",
      html,
      focus: editing ? '[name="title"]' : '[name="link"]',
      beforeClose() {
        if (bulkBusy) return false;
        if (dirty) return window.confirm("작성 중인 내용이 사라집니다. 닫을까요?");
        return true;
      },
    });
    const form = $("#note-form", ctx.modal);
    const f = (name) => form.elements[name];
    form.addEventListener("input", () => {
      dirty = true;
    });

    // --- 한 건 / 여러 건 전환
    const track = $(".pane-track", ctx.modal);
    const viewport = $(".pane-viewport", ctx.modal);
    function fitViewport() {
      if (!track) return;
      const pane = $('[data-pane-id="' + track.getAttribute("data-pane") + '"]', ctx.modal);
      viewport.style.height = pane.offsetHeight + "px";
    }
    if (track) {
      fitViewport();
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(fitViewport);
        $$(".pane", ctx.modal).forEach((p) => ro.observe(p));
      }
      $$(".pane-switch__btn", ctx.modal).forEach((btn) =>
        btn.addEventListener("click", () => {
          const pane = btn.getAttribute("data-pane");
          track.setAttribute("data-pane", pane);
          $$(".pane-switch__btn", ctx.modal).forEach((b) => {
            const on = b === btn;
            b.classList.toggle("pane-switch__btn--on", on);
            b.setAttribute("aria-selected", String(on));
          });
          // 보이지 않는 칸의 입력칸에 Tab 이 들어가지 않게
          $$(".pane", ctx.modal).forEach((p) => {
            p.inert = p.getAttribute("data-pane-id") !== pane;
          });
          fitViewport();
        })
      );
      $('[data-pane-id="bulk"]', ctx.modal).inert = true;
    }

    // --- 기존 첨부
    function renderKept() {
      const ul = $("[data-kept]", form);
      ul.hidden = !keptFiles.length;
      ul.innerHTML = keptFiles
        .map(
          (file) =>
            '<li class="file-list__item"><span class="file-list__name">📎 ' + esc(file.name) + '</span><span class="file-list__size">' +
            esc(fileSize(file.size)) + '</span><button type="button" class="banner__close" data-remove="' + esc(file.id) + '" aria-label="첨부 삭제">×</button></li>'
        )
        .join("");
    }
    renderKept();

    // --- 종목명 → 종목코드 자동
    f("company").addEventListener("change", () => {
      const ticker = knownCompanies().get(f("company").value.trim());
      if (ticker && !f("ticker").value) f("ticker").value = ticker;
    });

    // --- 링크 가져오기
    function importLink() {
      const raw = f("link").value.trim();
      if (!raw) {
        toast("링크를 붙여넣어 주세요.", true);
        f("link").focus();
        return;
      }
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch (e) {
        /* 잘못된 인코딩은 그대로 둔다 */
      }
      const found = detectCompany(decoded);
      if (found) {
        f("company").value = found.company;
        f("ticker").value = found.ticker;
      }
      const date = detectDate(decoded);
      if (date) f("date").value = date;
      const cat = detectCategory(decoded);
      if (cat !== "etc") {
        const radio = form.querySelector('input[name="category"][value="' + cat + '"]');
        if (radio) radio.checked = true;
        f("type").value = detectType(decoded);
      }
      dirty = true;
      if (found) toast("종목을 ‘" + found.company + "’(으)로 채웠습니다.");
      else toast("링크에서 종목을 찾지 못했습니다. 종목명을 직접 입력해 주세요.", true);
    }

    form.addEventListener("click", async (e) => {
      const rm = e.target.closest("[data-remove]");
      if (rm) {
        keptFiles = keptFiles.filter((x) => x.id !== rm.getAttribute("data-remove"));
        dirty = true;
        renderKept();
        return;
      }
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const what = act.getAttribute("data-act");
      if (what === "import") importLink();
      else if (what === "cancel") ctx.close();
      else if (what === "delete") {
        if (!(await confirmDialog("‘" + n.title + "’ 노트를 삭제할까요? 되돌릴 수 없습니다.", "삭제", true))) return;
        try {
          await store.remove(n);
        } catch (err) {
          toast(err.message, true);
          return;
        }
        dirty = false;
        ctx.close(true);
        render();
        toast("노트를 삭제했습니다.");
      }
    });
    f("link").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        importLink();
      }
    });
    f("link").addEventListener("paste", () => window.setTimeout(importLink, 0));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const company = f("company").value.trim();
      const ticker = f("ticker").value.trim();
      const cat = (form.querySelector('input[name="category"]:checked') || {}).value;
      const date = f("date").value;
      if (!company) {
        toast("종목명을 입력해 주세요.", true);
        f("company").focus();
        return;
      }
      if (ticker && !/^[0-9]{6}$/.test(ticker)) {
        toast("종목코드는 숫자 6자리입니다.", true);
        f("ticker").focus();
        return;
      }
      if (!cat) {
        toast("분류를 골라 주세요.", true);
        return;
      }
      if (!date) {
        toast("날짜를 입력해 주세요.", true);
        f("date").focus();
        return;
      }
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      let target = null;
      try {
        const type = f("type").value;
        const data = {
          company, ticker, category: cat, type, date,
          author: f("author").value.trim() || CURRENT_USER,
          title: f("title").value.trim() || company + " " + type,
          body: f("body").value,
          link: f("link").value.trim(),
          // 종목을 고쳤으면 ‘종목 확인 필요’ 표시는 풀어 준다
          review: editing && existing.review && company === "미지정" ? existing.review : null,
        };
        target = editing ? await store.update(existing, data) : await store.create(data);
        await setSector(company, f("sector").value).catch((e) => toast("섹터를 저장하지 못했습니다: " + e.message, true));
      } catch (err) {
        toast("저장하지 못했습니다: " + err.message, true);
        submit.disabled = false;
        return;
      }
      dirty = false;
      // 노트 본문은 저장됐다. 첨부 변경은 하나씩 반영하고, 실패한 것만 알린다
      const failures = [];
      for (const old of (n.files || []).filter((x) => !keptFiles.some((k) => k.id === x.id))) {
        await store.removeFile(target, old.id).catch(() => failures.push(old.name + " 삭제"));
      }
      for (const file of Array.from(f("files").files || [])) {
        await store.addFile(target, file, file.name, "attach").catch((err) => failures.push(file.name + ": " + err.message));
      }
      submit.disabled = false;
      ctx.close(true);
      render();
      if (failures.length) toast("노트는 저장했지만 첨부 파일 일부를 처리하지 못했습니다 — " + failures.join(", "), true);
      else toast(editing ? "노트를 수정했습니다." : "노트를 등록했습니다.");
      openDetail(target.id);
    });

    if (editing) return;

    // --- 여러 건 한번에
    const bulkPane = $('[data-pane-id="bulk"]', ctx.modal);
    const drop = $("[data-drop]", bulkPane);
    const bulkInput = $("[data-bulk-input]", bulkPane);
    const bulkList = $("[data-bulk-list]", bulkPane);
    const bulkStatus = $("[data-bulk-status]", bulkPane);
    const bulkBtn = $('[data-act="bulk"]', bulkPane);

    function setBulkFiles(files) {
      bulkFiles = Array.from(files).filter((file) => /\.(txt|md|markdown)$/i.test(file.name) || /^text\//.test(file.type));
      const skipped = files.length - bulkFiles.length;
      bulkList.innerHTML = bulkFiles
        .map((file) => '<li class="file-list__item"><span class="file-list__name">' + esc(file.name) + '</span><span class="file-list__size">' + esc(fileSize(file.size)) + "</span></li>")
        .join("");
      bulkStatus.innerHTML = skipped ? '<div class="bulk-result bulk-result--partial">텍스트 파일이 아닌 ' + skipped + "개는 뺐습니다.</div>" : "";
      bulkBtn.disabled = !bulkFiles.length;
      bulkBtn.textContent = bulkFiles.length ? bulkFiles.length + "건 일괄 등록" : "일괄 등록";
    }
    bulkInput.addEventListener("change", () => setBulkFiles(bulkInput.files));
    ["dragenter", "dragover"].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add("dropzone--active");
      })
    );
    ["dragleave", "drop"].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.remove("dropzone--active");
      })
    );
    drop.addEventListener("drop", (e) => setBulkFiles(e.dataTransfer.files));

    bulkPane.addEventListener("click", async (e) => {
      const open = e.target.closest("[data-open]");
      if (open) {
        ctx.close(true);
        openDetail(open.getAttribute("data-open"));
        return;
      }
      const act = e.target.closest("[data-act]");
      if (!act) return;
      if (act.getAttribute("data-act") === "cancel") {
        ctx.close();
        return;
      }
      if (act.getAttribute("data-act") !== "bulk" || !bulkFiles.length) return;

      bulkBusy = true;
      bulkBtn.disabled = true;
      const created = [];
      const failed = [];
      for (let i = 0; i < bulkFiles.length; i++) {
        const file = bulkFiles[i];
        bulkStatus.innerHTML =
          '<div class="bulk-progress"><span style="width:' + Math.round((i / bulkFiles.length) * 100) + '%"></span></div>' +
          '<div class="bulk-progress__now">' + (i + 1) + " / " + bulkFiles.length + " · " + esc(file.name) + "</div>";
        try {
          const text = await file.text();
          const base = file.name.replace(/\.[^.]+$/, "");
          const probe = base + "\n" + text.slice(0, 2000);
          const found = detectCompany(probe);
          const type = detectType(base) !== "기타" ? detectType(base) : detectType(probe);
          const note = await store.create({
            company: found ? found.company : "미지정",
            ticker: found ? found.ticker : "",
            category: detectCategory(base) !== "etc" ? detectCategory(base) : detectCategory(probe),
            type,
            date: detectDate(base) || detectDate(text.slice(0, 500)) || kstToday(),
            author: CURRENT_USER,
            title: base.replace(/^(20\d{2}[-._]?\d{2}[-._]?\d{2})[\s_-]*/, "").replace(/[_]+/g, " ").trim() || base,
            body: text,
            link: "",
            review: found ? null : { reason: "종목을 찾지 못했습니다" },
          });
          created.push(note);
        } catch (err) {
          failed.push(file.name + (err && err.message ? " (" + err.message + ")" : ""));
        }
      }
      render();
      bulkBusy = false;
      const needReview = created.filter((x) => x.review).length;
      bulkStatus.innerHTML =
        '<div class="bulk-result ' + (failed.length || needReview ? "bulk-result--partial" : "bulk-result--ok") + '">' +
        created.length + "건을 등록했습니다." +
        (needReview ? " 종목을 못 찾은 " + needReview + "건은 ‘확인 필요’로 표시했습니다." : "") +
        (failed.length ? "<ul>" + failed.map((name) => "<li>등록 못 함: " + esc(name) + "</li>").join("") + "</ul>" : "") +
        '<ul class="bulk-created">' +
        created
          .map(
            (x) =>
              '<li><button type="button" class="bulk-created__item" data-open="' + x.id + '"><span class="bulk-created__title">' + esc(x.title) +
              (x.review ? '<span class="bulk-created__badge">확인 필요</span>' : "") + "</span>" +
              '<span class="bulk-created__meta">' + esc(companyLabel(x)) + " · " + esc(CAT_LABEL[x.category]) + " · " + esc(dotDate(x.date)) + "</span></button></li>"
          )
          .join("") +
        "</ul></div>";
      bulkFiles = [];
      bulkList.innerHTML = "";
      bulkInput.value = "";
      bulkBtn.textContent = "일괄 등록";
    });
  }

  /* ================================================================
   * 녹음
   * ================================================================ */
  function openRecorder() {
    const RECORD_TYPES = ["콥데이", "NDR", "탐방", "컨퍼런스콜", "세미나"];
    const listId = uid("dl");
    const html =
      '<div class="modal__body">' +
      '<div class="recorder">' +
      '<button type="button" class="recorder__mic" data-act="mic" aria-label="녹음 시작"><span class="recorder__mic-icon" aria-hidden="true">🎙</span><span class="recorder__mic-dot" aria-hidden="true"></span></button>' +
      '<div class="recorder__meta"><div class="recorder__timer" data-timer>00:00</div><div class="recorder__status" data-status>버튼을 누르면 녹음을 시작합니다.</div></div>' +
      "</div>" +
      '<div class="recorder__input"><div class="recorder__input-row"><span>입력 레벨</span><meter min="0" max="1" low="0.05" high="0.8" optimum="0.4" value="0" data-meter></meter>' +
      '<select class="input input--compact" data-device aria-label="마이크 선택" hidden></select></div>' +
      '<p class="recorder__input-warning" data-warning hidden></p></div>' +
      '<div class="detail-audio-wrap" data-preview hidden><span class="detail-audio-label">미리 듣기</span></div>' +
      '<div class="rec-actions" data-rec-actions hidden><button type="button" class="btn btn--ghost btn--sm" data-act="reset">다시 녹음</button></div>' +
      '<p class="recorder__or">또는</p>' +
      '<label class="dropzone dropzone--audio" data-drop><input type="file" accept="audio/*,video/webm,video/mp4" hidden data-audio-input>' +
      '<p class="dropzone__title">녹음 파일 올리기</p><p class="dropzone__text">끌어다 놓거나 눌러서 고르세요 (m4a, mp3, wav, webm)</p><p class="dropzone__picked" data-picked hidden></p></label>' +
      '<div class="record-meta">' +
      '<div class="chip-group chip-group--kind">' + categoryChips("rec-category", state.category || "group") + "</div>" +
      '<div class="field-row">' +
      '<label class="field"><span class="field__label">종목명 <em class="required">*</em></span><input class="input" data-rec-company list="' + listId + '" autocomplete="off" value="' + esc(state.company) + '">' + companyDatalist(listId) + "</label>" +
      '<label class="field"><span class="field__label">종목코드 <span class="field__label-note">(선택)</span></span><input class="input" data-rec-ticker inputmode="numeric" maxlength="6" placeholder="6자리" value="' + esc(state.company ? knownCompanies().get(state.company) || "" : "") + '"></label>' +
      "</div>" +
      '<div class="field"><span class="field__label">유형</span><div class="chip-group">' +
      RECORD_TYPES.map((t, i) => '<label class="chip"><input type="radio" name="rec-type" value="' + t + '"' + (i === 0 ? " checked" : "") + "><span>" + t + "</span></label>").join("") +
      '<label class="chip"><input type="radio" name="rec-type" value="__custom"><span>직접 입력</span></label></div>' +
      '<input class="input" id="record-type-custom" placeholder="유형 직접 입력" hidden></div>' +
      '<p class="record-title-line">저장될 제목 <strong data-title-preview>—</strong></p>' +
      "</div>" +
      '<div class="rec-safe">녹음 파일은 서버로 올라가지 않고 이 브라우저(IndexedDB)에만 저장됩니다. 원본 서비스의 자동 받아쓰기·요약은 이 복제본에서 지원하지 않습니다.</div>' +
      '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-act="cancel">취소</button>' +
      '<button type="button" class="btn btn--primary" data-act="save" disabled>노트로 저장</button></div></div>' +
      "</div>";

    let recorder = null;
    let stream = null;
    let audioCtx = null;
    let rafId = 0;
    let timerId = 0;
    let startedAt = 0;
    let elapsedBefore = 0;
    let chunks = [];
    let result = null; // { blob, name, duration }
    let previewUrl = "";
    let player = null;
    let quietSince = 0;

    const ctx = openModal({
      title: "녹음",
      size: "modal--wide",
      html,
      focus: '[data-act="mic"]',
      beforeClose() {
        if (recorder && recorder.state !== "inactive") return window.confirm("녹음 중입니다. 녹음을 버리고 닫을까요?");
        if (result) return window.confirm("저장하지 않은 녹음이 있습니다. 버리고 닫을까요?");
        return true;
      },
      onClose() {
        stopStream();
        if (player) player.destroy();
        if (previewUrl) URL.revokeObjectURL(previewUrl);
      },
    });
    const m = ctx.modal;
    const mic = $('[data-act="mic"]', m);
    const timer = $("[data-timer]", m);
    const status = $("[data-status]", m);
    const meter = $("[data-meter]", m);
    const deviceSel = $("[data-device]", m);
    const warning = $("[data-warning]", m);
    const preview = $("[data-preview]", m);
    const recActions = $("[data-rec-actions]", m);
    const saveBtn = $('[data-act="save"]', m);
    const companyInput = $("[data-rec-company]", m);
    const tickerInput = $("[data-rec-ticker]", m);
    const customType = $("#record-type-custom", m);
    const titlePreview = $("[data-title-preview]", m);
    const picked = $("[data-picked]", m);
    const audioInput = $("[data-audio-input]", m);
    const drop = $("[data-drop]", m);

    function warn(text) {
      warning.hidden = !text;
      warning.textContent = text || "";
    }
    function currentType() {
      const v = (m.querySelector('input[name="rec-type"]:checked') || {}).value;
      return v === "__custom" ? customType.value.trim() || "기타" : v || "기타";
    }
    function updateTitle() {
      const company = companyInput.value.trim();
      titlePreview.textContent = company ? company + " " + currentType() : "—";
      saveBtn.disabled = !result || !company;
    }
    function elapsed() {
      return elapsedBefore + (startedAt ? (Date.now() - startedAt) / 1000 : 0);
    }
    function showTime() {
      const s = Math.floor(elapsed());
      const h = Math.floor(s / 3600);
      timer.textContent = (h ? h + ":" : "") + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
    }
    function stopStream() {
      window.cancelAnimationFrame(rafId);
      window.clearInterval(timerId);
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (audioCtx) audioCtx.close().catch(() => {});
      stream = null;
      audioCtx = null;
      meter.value = 0;
    }
    function setResult(blob, name, duration) {
      result = { blob, name, duration };
      if (player) player.destroy();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      $$(".aplayer__btn, .aplayer__bar, .aplayer__time", preview).forEach((x) => x.remove());
      previewUrl = URL.createObjectURL(blob);
      player = mountPlayer(preview, previewUrl);
      preview.hidden = false;
      recActions.hidden = false;
      updateTitle();
    }
    function resetResult() {
      result = null;
      if (player) player.destroy();
      player = null;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = "";
      $$(".aplayer__btn, .aplayer__bar, .aplayer__time", preview).forEach((x) => x.remove());
      preview.hidden = true;
      recActions.hidden = true;
      picked.hidden = true;
      elapsedBefore = 0;
      timer.textContent = "00:00";
      status.textContent = "버튼을 누르면 녹음을 시작합니다.";
      updateTitle();
    }

    async function listDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      if (devices.length < 2) return;
      const current = stream ? stream.getAudioTracks()[0].getSettings().deviceId : "";
      deviceSel.innerHTML = devices
        .map((d, i) => '<option value="' + esc(d.deviceId) + '"' + (d.deviceId === current ? " selected" : "") + ">" + esc(d.label || "마이크 " + (i + 1)) + "</option>")
        .join("");
      deviceSel.hidden = false;
    }

    async function start() {
      warn("");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        warn("이 브라우저에서는 녹음할 수 없습니다. HTTPS 주소나 localhost 에서 열었는지 확인하거나, 아래에서 녹음 파일을 올려 주세요.");
        return;
      }
      if (result && !window.confirm("이전 녹음을 버리고 새로 녹음할까요?")) return;
      resetResult();
      try {
        const constraints = { audio: deviceSel.value ? { deviceId: { exact: deviceSel.value } } : true };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        warn(err && err.name === "NotAllowedError"
          ? "마이크 권한이 거부되었습니다. 주소창 왼쪽의 사이트 설정에서 마이크를 허용해 주세요."
          : "마이크를 열지 못했습니다: " + (err && err.message ? err.message : err));
        return;
      }
      listDevices().catch(() => {});

      // 입력 레벨 표시
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        audioCtx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        quietSince = Date.now();
        const loop = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
          meter.value = level;
          if (level > 0.02) quietSince = Date.now();
          if (recorder && recorder.state === "recording") {
            warn(Date.now() - quietSince > 8000 ? "8초 넘게 소리가 거의 들어오지 않습니다. 마이크가 음소거되었거나 다른 장치가 선택되어 있지 않은지 확인해 주세요." : "");
          }
          rafId = window.requestAnimationFrame(loop);
        };
        loop();
      } catch (e) {
        /* 레벨 표시는 부가 기능 */
      }

      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(t)) || "";
      recorder = new window.MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mime || "audio/webm";
        const ext = /mp4/.test(type) ? "m4a" : /ogg/.test(type) ? "ogg" : "webm";
        const duration = elapsed();
        startedAt = 0;
        elapsedBefore = duration;
        stopStream();
        const blob = new Blob(chunks, { type });
        if (!blob.size) {
          warn("녹음된 내용이 없습니다. 다시 시도해 주세요.");
          return;
        }
        setResult(blob, "녹음_" + kstToday().replace(/-/g, "") + "." + ext, duration);
        status.textContent = "녹음 완료 · " + clock(duration) + " — 종목을 확인하고 저장하세요.";
      };
      recorder.start(1000);
      startedAt = Date.now();
      elapsedBefore = 0;
      timerId = window.setInterval(showTime, 250);
      showTime();
      mic.classList.add("recorder__mic--recording");
      mic.setAttribute("aria-label", "녹음 중지");
      status.textContent = "녹음 중… 다시 누르면 멈춥니다.";
    }
    function stop() {
      if (recorder && recorder.state !== "inactive") recorder.stop();
      window.clearInterval(timerId);
      mic.classList.remove("recorder__mic--recording");
      mic.setAttribute("aria-label", "녹음 시작");
    }

    mic.addEventListener("click", () => {
      if (recorder && recorder.state === "recording") stop();
      else start();
    });
    deviceSel.addEventListener("change", () => {
      if (recorder && recorder.state === "recording") toast("다음 녹음부터 선택한 마이크를 씁니다.");
    });

    function pickAudio(file) {
      if (!file) return;
      if (!/^(audio|video)\//.test(file.type) && !/\.(m4a|mp3|wav|webm|ogg|aac|mp4)$/i.test(file.name)) {
        toast("오디오 파일만 올릴 수 있습니다.", true);
        return;
      }
      if (recorder && recorder.state === "recording") stop();
      setResult(file, file.name, 0);
      picked.textContent = "선택됨: " + file.name + " (" + fileSize(file.size) + ")";
      picked.hidden = false;
      status.textContent = "파일을 골랐습니다 — 종목을 확인하고 저장하세요.";
      const guess = detectCompany(file.name);
      if (guess && !companyInput.value.trim()) {
        companyInput.value = guess.company;
        tickerInput.value = guess.ticker;
      }
      const date = detectDate(file.name);
      if (date) result.date = date;
      updateTitle();
    }
    audioInput.addEventListener("change", () => pickAudio(audioInput.files[0]));
    ["dragenter", "dragover"].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add("dropzone--active");
      })
    );
    ["dragleave", "drop"].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.remove("dropzone--active");
      })
    );
    drop.addEventListener("drop", (e) => pickAudio(e.dataTransfer.files[0]));

    m.addEventListener("change", (e) => {
      if (e.target.name === "rec-type") {
        customType.hidden = e.target.value !== "__custom";
        if (!customType.hidden) customType.focus();
      }
      updateTitle();
    });
    companyInput.addEventListener("input", updateTitle);
    companyInput.addEventListener("change", () => {
      const ticker = knownCompanies().get(companyInput.value.trim());
      if (ticker && !tickerInput.value) tickerInput.value = ticker;
    });
    customType.addEventListener("input", updateTitle);

    m.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const what = act.getAttribute("data-act");
      if (what === "cancel") ctx.close();
      else if (what === "reset") {
        if (window.confirm("지금 녹음을 버리고 다시 녹음할까요?")) resetResult();
      } else if (what === "save") {
        const company = companyInput.value.trim();
        const ticker = tickerInput.value.trim();
        if (!result || !company) return;
        if (ticker && !/^[0-9]{6}$/.test(ticker)) {
          toast("종목코드는 숫자 6자리입니다.", true);
          tickerInput.focus();
          return;
        }
        saveBtn.disabled = true;
        try {
          const type = currentType();
          const note = await store.create({
            company,
            ticker: ticker || knownCompanies().get(company) || "",
            category: (m.querySelector('input[name="rec-category"]:checked') || {}).value || "etc",
            type,
            date: result.date || kstToday(),
            author: CURRENT_USER,
            title: company + " " + type,
            body: "",
            link: "",
            review: null,
          });
          saveBtn.textContent = "녹음 올리는 중…";
          try {
            await store.addFile(note, result.blob, result.name, "audio", result.duration);
          } catch (err) {
            // 녹음 없이 빈 노트만 남지 않도록 되돌린다
            await store.remove(note).catch(() => {});
            render();
            throw err;
          } finally {
            saveBtn.textContent = "노트로 저장";
          }
          result = null;
          ctx.close(true);
          render();
          toast("녹음을 노트로 저장했습니다.");
          openDetail(note.id);
        } catch (err) {
          toast("녹음을 저장하지 못했습니다: " + err.message, true);
          saveBtn.disabled = false;
        }
      }
    });

    updateTitle();
  }

  /* ================================================================
   * 사용법
   * ================================================================ */
  function openGuide() {
    const html =
      '<div class="modal__body guide">' +
      '<p class="guide__lead">콥데이 · NDR · 탐방에서 적은 노트를 한곳에 모으고, <strong>종목명으로 바로 찾는</strong> 아카이브입니다. 처음이라면 아래 순서대로 한 번만 써 보세요.</p>' +
      '<h3 class="guide__h">1. 노트 남기기</h3>' +
      '<ul class="guide__list">' +
      "<li><strong>+ 노트 등록</strong> → 맨 위 칸에 <strong>링크만 붙여넣으면</strong> 종목·분류·날짜를 찾아 채웁니다. 못 찾으면 종목명만 직접 입력하세요.</li>" +
      "<li>제목을 비워 두면 <code>종목명 유형</code>(예: 올릭스 콥데이)으로 저장됩니다.</li>" +
      "<li><strong>여러 건 한번에</strong> 탭에서 텍스트 파일 여러 개를 올리면 파일마다 노트가 한 건씩 생깁니다. 종목을 못 찾은 노트는 <strong>확인 필요</strong>로 모입니다.</li>" +
      "<li>미팅 현장에서는 빨간 <strong>녹음</strong> 버튼으로 바로 녹음해 노트에 붙일 수 있습니다. <span class=\"guide__tip\">녹음 파일은 이 브라우저에만 저장</span></li>" +
      "</ul>" +
      '<h3 class="guide__h">2. 분류</h3>' +
      '<table class="guide__table"><thead><tr><th>분류</th><th>이럴 때 고르세요</th></tr></thead><tbody>' +
      "<tr><td>단독미팅</td><td>회사와 1:1로 만난 탐방·미팅</td></tr>" +
      "<tr><td>그룹미팅</td><td>콥데이, NDR, 컨퍼런스처럼 여러 기관이 함께 들은 자리</td></tr>" +
      "<tr><td>세미나</td><td>업종·주제 세미나, 전문가 콜</td></tr>" +
      "<tr><td>기업레포트</td><td>증권사·자체 기업 분석 자료</td></tr>" +
      "<tr><td>기타</td><td>위에 해당하지 않는 메모</td></tr>" +
      "</tbody></table>" +
      '<h3 class="guide__h">3. 찾기</h3>' +
      '<ul class="guide__list">' +
      "<li>검색창은 <strong>종목명·종목코드·제목·본문</strong>을 함께 찾습니다. 띄어쓰기로 여러 단어를 넣으면 모두 들어간 노트만 보입니다.</li>" +
      "<li>왼쪽 <strong>종목</strong> 목록과 위쪽 <strong>분류 탭</strong>, <strong>상세 조건</strong>(기간·유형·작성자)을 함께 쓸 수 있습니다.</li>" +
      "<li><strong>노트에게 물어보기</strong>는 질문 속 단어로 관련 노트를 모아 보여 줍니다. 쓸 만한 답은 <strong>답변 저장</strong> 후 🔖에서 다시 봅니다.</li>" +
      "</ul>" +
      '<h3 class="guide__h">4. 본문 쓰는 법 <span class="guide__tip">선택</span></h3>' +
      "<p>아래처럼 쓰면 상세 화면과 인쇄물이 보기 좋게 정리됩니다.</p>" +
      '<table class="guide__table"><tbody>' +
      "<tr><td><code># 제목</code></td><td>큰 제목</td></tr>" +
      "<tr><td><code>## 소제목</code></td><td>구역 제목 (예: 실적, 파이프라인, Q&amp;A)</td></tr>" +
      "<tr><td><code>- 내용</code></td><td>목록 · 앞에 공백 두 칸이면 하위 목록</td></tr>" +
      "<tr><td><code>Q. / A.</code></td><td>질문과 답변</td></tr>" +
      "<tr><td><code>일시: 9/18</code></td><td>항목: 값 형식의 요약 줄</td></tr>" +
      "</tbody></table>" +
      '<p class="hint">이 화면은 정적 복제본입니다. 노트는 서버가 아니라 <strong>지금 쓰는 브라우저</strong>에 저장되므로, 다른 PC나 브라우저에서는 보이지 않습니다.</p>' +
      '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--primary" data-act="close">확인</button></div></div>' +
      "</div>";
    const ctx = openModal({ title: "노트 사용법", size: "modal--wide", html, focus: '[data-act="close"]' });
    $('[data-act="close"]', ctx.modal).addEventListener("click", () => ctx.close());
  }

  /* ================================================================
   * 노트에게 물어보기 (키워드 검색 기반)
   * ================================================================ */
  const STOPWORDS = new Set([
    "최근", "관련", "관련해서", "관해서", "대해", "대해서", "대한", "얘기", "이야기", "내용", "있어", "있나", "있어요", "있나요", "있었어",
    "나온", "나왔어", "뭐", "뭐야", "무엇", "어떤", "어때", "어땠어", "알려줘", "알려", "정리", "정리해줘", "해줘", "좀", "그", "이", "저",
    "노트", "노트에서", "했어", "했나", "했던", "한", "하는", "무슨", "말", "말한", "언급", "언급한", "나왔나", "것", "거", "게", "때",
  ]);
  const PARTICLES = /(에서는|에서|으로는|으로|에게|한테|부터|까지|이랑|랑|하고|이나|나|은|는|이|가|을|를|의|에|도|와|과|로|만)$/;

  function questionTokens(q) {
    const out = [];
    q.toLowerCase()
      .replace(/[?!.,"'“”‘’()[\]{}~]/g, " ")
      .split(/\s+/)
      .forEach((w) => {
        if (!w || STOPWORDS.has(w)) return;
        let t = w;
        if (t.length > 2) t = t.replace(PARTICLES, "");
        if (!t || STOPWORDS.has(t) || (t.length < 2 && !/^[0-9a-z]$/.test(t))) return;
        if (!out.includes(t)) out.push(t);
      });
    return out;
  }
  function snippet(n, tokens) {
    const flat = (n.body || "").replace(/\s+/g, " ").trim();
    if (!flat) return "";
    const lower = flat.toLowerCase();
    let at = -1;
    for (const t of tokens) {
      at = lower.indexOf(t);
      if (at >= 0) break;
    }
    if (at < 0) return flat.slice(0, 140) + (flat.length > 140 ? "…" : "");
    const s = Math.max(0, at - 50);
    const e = Math.min(flat.length, at + 150);
    return (s ? "…" : "") + flat.slice(s, e) + (e < flat.length ? "…" : "");
  }

  const ask = {
    form: $("#ask-form"),
    input: $("#ask-input"),
    submit: $("#ask-submit"),
    result: $("#ask-result"),
    last: null,
    timer: 0,
  };

  function runAsk(question) {
    const t0 = performance.now();
    window.clearInterval(ask.timer);
    ask.result.hidden = false;
    ask.result.innerHTML =
      '<div class="ask__meta"><span><span class="ask__spinner" aria-hidden="true"></span>노트에서 찾는 중… <span class="ask__elapsed" data-elapsed>0.0초</span></span>' +
      '<button type="button" class="ask__close" data-act="close" aria-label="닫기">×</button></div>' +
      '<div class="ask-sk" aria-hidden="true"><span class="ask-sk__h"></span><div class="ask-sk__block"><span class="ask-sk__bar" style="width:92%"></span><span class="ask-sk__bar" style="width:76%"></span></div>' +
      '<span class="ask-sk__h"></span><div class="ask-sk__block"><span class="ask-sk__bar" style="width:84%"></span><span class="ask-sk__bar" style="width:61%"></span></div></div>';
    ask.submit.disabled = true;
    ask.timer = window.setInterval(() => {
      const elapsedEl = $("[data-elapsed]", ask.result);
      if (elapsedEl) elapsedEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + "초";
    }, 100);

    window.setTimeout(() => {
      window.clearInterval(ask.timer);
      ask.submit.disabled = false;
      const tokens = questionTokens(question);
      const scored = notes
        .map((n) => {
          let score = 0;
          const company = (n.company + " " + (n.ticker || "")).toLowerCase();
          const title = (n.title || "").toLowerCase();
          const type = ((n.type || "") + " " + (CAT_LABEL[n.category] || "")).toLowerCase();
          const body = (n.body || "").toLowerCase();
          tokens.forEach((t) => {
            if (company.includes(t)) score += 6;
            if (title.includes(t)) score += 3;
            if (type.includes(t)) score += 2;
            const hits = body.split(t).length - 1;
            score += Math.min(hits, 5);
          });
          return { n, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || byNewest(a.n, b.n));
      const top = scored.slice(0, 6).map((x) => x.n);
      const seconds = ((performance.now() - t0) / 1000).toFixed(1);

      let answer;
      if (!tokens.length) {
        answer = '<p class="ask__p">질문에서 찾을 단어를 알아내지 못했습니다. 종목명이나 주제(예: 태양광, 수주, 임상)를 넣어 다시 물어봐 주세요.</p>';
      } else if (!top.length) {
        answer =
          '<div class="ask__h2">요약</div><p class="ask__p">‘' + esc(tokens.join(", ")) + "’에 해당하는 노트를 찾지 못했습니다. 다른 표현이나 종목명으로 다시 물어봐 주세요.</p>";
      } else {
        const companies = Array.from(new Set(top.map((n) => n.company)));
        answer =
          '<div class="ask__h2">요약</div>' +
          '<p class="ask__p">전체 노트 ' + notes.length + "건 가운데 <strong>" + scored.length + "건</strong>이 ‘" + esc(tokens.join(", ")) + "’와 관련 있습니다. " +
          "관련도가 높은 순서로 " + top.length + "건을 모았습니다" + (companies.length ? " (" + esc(companies.slice(0, 5).join(", ")) + (companies.length > 5 ? " 외" : "") + ")" : "") + ".</p>" +
          '<div class="ask__h2">관련 노트</div>' +
          top
            .map((n, i) => {
              const sn = snippet(n, tokens);
              return (
                '<div class="ask__h3">' + esc(companyLabel(n)) + " · " + esc(n.title) + ' <button type="button" class="ask__cite" data-open="' + n.id + '">' + (i + 1) + "</button></div>" +
                '<ul class="ask__ul"><li>' + esc(dotDate(n.date)) + " · " + esc(CAT_LABEL[n.category] || "기타") + (n.type ? " · " + esc(n.type) : "") + " · " + esc(n.author) + "</li>" +
                (sn ? "<li>" + highlight(sn, tokens) + "</li>" : '<li>본문이 없는 노트입니다.</li>') + "</ul>"
              );
            })
            .join("");
      }
      const cited = top.length
        ? '<div class="ask__cited"><span class="ask__cited-label">근거 노트</span>' +
          top.map((n, i) => '<button type="button" class="ask__cite ask__cite--full ask__cite--kept" data-open="' + n.id + '">[' + (i + 1) + "] " + esc(companyLabel(n)) + " · " + esc(n.title) + "</button>").join("") +
          "</div>"
        : "";
      ask.last = { question, answerHtml: answer, noteIds: top.map((n) => n.id), tokens };
      ask.result.innerHTML =
        '<div class="ask__meta"><span>노트 ' + top.length + "건 참고 · " + seconds + '초<span class="ask__hint">AI 대신 키워드 검색으로 찾은 결과입니다</span></span>' +
        '<button type="button" class="ask__close" data-act="close" aria-label="닫기">×</button></div>' +
        '<div class="ask__answer">' + answer + "</div>" + cited +
        (top.length
          ? '<div class="ask__save-row"><button type="button" class="ask__save" data-act="save">답변 저장</button>' +
            (canResearch ? '<a class="ask__save" href="/research/?q=' + encodeURIComponent(question) + '">AI 리서치로 자세히 묻기</a>' : "") +
            '<span class="ask__save-hint">저장한 답변은 🔖에서 다시 볼 수 있습니다.</span></div>'
          : canResearch
            ? '<div class="ask__save-row"><a class="ask__save" href="/research/?q=' + encodeURIComponent(question) + '">AI 리서치로 묻기</a></div>'
            : "");
    }, 350);
  }

  // 서버 모드에서 AI 리서치 권한이 있으면 답변 아래에 'AI 리서치로 묻기' 를 보여 준다
  let canResearch = false;
  (window.hanaSession || Promise.resolve({})).then((s) => {
    canResearch = !!(s && s.server && s.me && (s.me.permissions || []).includes("ai_research"));
  }).catch(() => {});

  ask.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = ask.input.value.trim();
    if (!q) {
      ask.input.focus();
      return;
    }
    runAsk(q);
  });
  ask.result.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) {
      openDetail(open.getAttribute("data-open"));
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.getAttribute("data-act") === "close") {
      ask.result.hidden = true;
      ask.result.innerHTML = "";
    } else if (act.getAttribute("data-act") === "save" && ask.last) {
      act.disabled = true;
      store
        .savedAdd({
          question: ask.last.question,
          answerHtml: ask.last.answerHtml,
          notes: ask.last.noteIds.map((id) => {
            const n = getNote(id);
            return n ? { id: n.id, label: companyLabel(n) + " · " + n.title } : { id, label: "노트 #" + id };
          }),
        })
        .then(() => {
          act.textContent = "저장됨 ✓";
          toast("답변을 저장했습니다. 🔖에서 다시 볼 수 있습니다.");
        })
        .catch((err) => {
          act.disabled = false;
          toast("답변을 저장하지 못했습니다: " + err.message, true);
        });
    }
  });

  /* ================================================================
   * 이벤트 연결
   * ================================================================ */
  // 검색
  function doSearch() {
    setState({ q: el.searchInput.value.trim() });
  }
  $("#search-btn").addEventListener("click", doSearch);
  el.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearch();
    } else if (e.key === "Escape" && el.searchInput.value) {
      e.preventDefault();
      el.searchInput.value = "";
      el.searchClear.hidden = true;
      if (state.q) setState({ q: "" });
    }
  });
  el.searchInput.addEventListener("input", () => {
    el.searchClear.hidden = !el.searchInput.value;
    // 입력을 모두 지우면 바로 전체로 돌아간다
    if (!el.searchInput.value && state.q) setState({ q: "" });
  });
  el.searchClear.addEventListener("click", () => {
    el.searchInput.value = "";
    el.searchClear.hidden = true;
    setState({ q: "" });
    el.searchInput.focus();
  });

  // 상세 조건
  el.filtersToggle.addEventListener("click", () => {
    const open = el.filtersToggle.getAttribute("aria-expanded") !== "true";
    el.filtersToggle.setAttribute("aria-expanded", String(open));
    el.filters.hidden = !open;
  });
  el.filterFrom.addEventListener("change", () => setState({ from: el.filterFrom.value }));
  el.filterTo.addEventListener("change", () => setState({ to: el.filterTo.value }));
  el.filterType.addEventListener("change", () => setState({ type: el.filterType.value }));
  el.filterAuthor.addEventListener("change", () => setState({ author: el.filterAuthor.value }));

  function resetAll() {
    el.companyFilter.value = "";
    setState(Object.assign({}, EMPTY_STATE));
  }
  $("#reset-btn").addEventListener("click", resetAll);

  // 섹터 체크
  $("#sector-bar").addEventListener("change", (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    const set = new Set(state.sectors);
    if (box.checked) set.add(box.value);
    else set.delete(box.value);
    setState({ sectors: Array.from(set) });
  });
  $("#sector-bar").addEventListener("click", (e) => {
    if (e.target.closest("[data-sector-clear]")) setState({ sectors: [] });
    else if (e.target.closest("[data-sector-edit]")) openSectorEditor();
  });
  // 종목별 섹터 한꺼번에 지정
  function openSectorEditor() {
    const companies = Array.from(new Set(notes.map((n) => n.company).filter((c) => c && c !== "미지정"))).sort((a, b) => a.localeCompare(b, "ko"));
    const m = openModal({
      title: "종목별 섹터 지정",
      size: "modal--wide",
      html:
        '<form class="modal__body" novalidate>' +
        '<p class="hint">한 번 정하면 그 종목의 모든 노트가 해당 섹터로 묶입니다. 섹터가 없는 종목만 보려면 위 체크에서 ‘미지정’을 고르세요.</p>' +
        '<input class="input input--compact" data-sector-find placeholder="종목 찾기" style="margin:10px 0">' +
        '<div class="sector-edit-list">' +
        (companies.length
          ? companies.map((c) => '<label class="sector-edit-row" data-name="' + esc(c.toLowerCase()) + '"><span>' + esc(c) + '</span><select class="input input--compact" data-company="' + esc(c) + '">' + sectorOptions((sectorMap.get(c) || {}).sector || "") + "</select></label>").join("")
          : '<p class="hint">아직 노트가 없습니다.</p>') +
        "</div>" +
        '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-close>닫기</button><button type="submit" class="btn btn--primary">저장</button></div></div></form>',
    });
    const box = m.modal;
    const form = box.querySelector("form");
    box.querySelector("[data-close]").addEventListener("click", () => m.close());
    box.querySelector("[data-sector-find]").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      box.querySelectorAll(".sector-edit-row").forEach((r) => (r.hidden = q && !r.getAttribute("data-name").includes(q)));
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      let changed = 0;
      try {
        for (const sel of form.querySelectorAll("select[data-company]")) {
          const c = sel.getAttribute("data-company");
          if (((sectorMap.get(c) || {}).sector || "") !== sel.value) {
            await setSector(c, sel.value);
            changed++;
          }
        }
        toast(changed ? "섹터 " + changed + "곳을 저장했습니다." : "바뀐 것이 없습니다.");
        m.close(true);
        render();
      } catch (err) {
        btn.disabled = false;
        toast("섹터를 저장하지 못했습니다: " + err.message, true);
      }
    });
  }
  el.resultsClear.addEventListener("click", resetAll);

  // 종목 레일
  el.companyList.addEventListener("click", (e) => {
    const item = e.target.closest(".company-item");
    if (!item) return;
    const company = item.getAttribute("data-company");
    setState({ company: company === state.company ? "" : company });
  });
  el.companyFilter.addEventListener("input", renderCompanies);
  el.companyFilter.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // 좁힌 결과가 하나뿐이면 바로 고른다
      const items = $$(".company-item[data-company]:not([data-company=''])", el.companyList);
      if (items.length === 1) setState({ company: items[0].getAttribute("data-company") });
    }
  });

  // 분류 탭
  el.docTabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".doc-tab");
    if (tab) setState({ category: tab.getAttribute("data-category") });
  });
  $$(".doc-tab", el.docTabs).forEach((tab) => tab.setAttribute("role", "tab"));

  // 확인 필요
  el.reviewToggle.addEventListener("click", () => setState({ review: !state.review }));

  // 노트 카드
  el.noteList.addEventListener("click", (e) => {
    const card = e.target.closest(".note-card");
    if (card) openDetail(card.getAttribute("data-id"));
  });
  el.noteList.addEventListener("keydown", (e) => {
    const card = e.target.closest(".note-card");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openDetail(card.getAttribute("data-id"));
    }
  });

  // 페이지
  el.pager.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-page]");
    if (!btn || btn.disabled) return;
    setState({ page: Number(btn.getAttribute("data-page")) }, true);
    $(".results").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // 왼쪽 레일(확인 필요 / 세미나 / 기업레포트): 항목 열기, 머리글로 접기
  $(".notes-side").addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) {
      openDetail(open.getAttribute("data-open"));
      return;
    }
    const head = e.target.closest(".review-rail__header, .side-rail__header");
    if (head) {
      const list = head.nextElementSibling;
      list.hidden = !list.hidden;
      head.setAttribute("aria-expanded", String(!list.hidden));
    }
  });
  $(".notes-side").addEventListener("keydown", (e) => {
    const head = e.target.closest(".review-rail__header, .side-rail__header");
    if (head && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      head.click();
    }
  });

  // 상단 버튼
  $("#add-btn").addEventListener("click", () => openEditor(null));
  $("#record-btn").addEventListener("click", openRecorder);
  $("#guide-btn").addEventListener("click", openGuide);

  // 사용법 안내 띠
  const callout = $("#guide-callout");
  if (readJSON(GUIDE_KEY, false)) callout.hidden = true;
  $("#guide-callout-open").addEventListener("click", openGuide);
  $("#guide-callout-close").addEventListener("click", () => {
    callout.hidden = true;
    writeJSON(GUIDE_KEY, true);
  });

  // 인쇄 영역은 body 바로 아래에 있어야 인쇄용 CSS(body.printing > :not(#print-area))가 맞게 동작한다
  const printArea = $("#print-area");
  if (printArea && printArea.parentElement !== document.body) document.body.appendChild(printArea);

  // #note-3 처럼 주소로 바로 노트를 여는 경우
  function openFromHash() {
    const m = /^#note-(\d+)$/.exec(window.location.hash);
    if (m && !modalStack.length) openDetail(m[1]);
  }
  window.addEventListener("hashchange", openFromHash);

  // 다른 탭에서 노트를 바꾸면 따라간다
  window.addEventListener("storage", (e) => {
    if (!store.server && e.key === NOTES_KEY) {
      notes = readJSON(NOTES_KEY, []);
      render();
    }
  });

  // 서버 모드: 다른 부서원이 올린 노트가 보이도록, 창으로 돌아올 때 목록을 다시 받는다
  let lastRefresh = Date.now();
  async function refreshFromServer() {
    if (!store.server || modalStack.length || Date.now() - lastRefresh < 15000) return;
    lastRefresh = Date.now();
    try {
      notes = await store.load();
      render();
    } catch (e) {
      /* 잠깐의 네트워크 오류는 무시 */
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshFromServer();
  });
  window.addEventListener("focus", refreshFromServer);

  readUrl();
  if (detailFilterCount()) {
    el.filtersToggle.setAttribute("aria-expanded", "true");
    el.filters.hidden = false;
  }

  (async function init() {
    const session = await (window.hanaSession || Promise.resolve({ server: false })).catch((err) => {
      toast("서버에 연결하지 못했습니다: " + err.message, true);
      return null;
    });
    if (!session) return;
    if (session.server) {
      store = serverStore(session.api);
      CURRENT_USER = session.me.displayName || session.me.username;
      // 서버 목록을 받기 전까지 원본 화면에 박혀 있던 예시 노트가 보이지 않게 한다
      el.noteList.innerHTML = "";
    }
    try {
      notes = await store.load();
    } catch (err) {
      toast("노트를 불러오지 못했습니다: " + err.message, true);
      notes = [];
    }
    await loadSectors();
    render();
    openFromHash();
  })();
})();
