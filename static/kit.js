/* 페이지 공용 도구 — 저장소(브라우저/서버), 파일, 모달, 날짜, 글자 처리
 *
 * 서버 모드(서버가 내준 화면, <meta name="hana-mode" content="server">)에서는 /api/c/<이름> 에,
 * 그 밖에는 이 브라우저의 localStorage·IndexedDB 에 저장한다. 페이지 스크립트는 둘을 구분하지 않고
 * Kit.collection("calendar-events") 처럼 쓰면 된다.
 */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function uid(prefix) {
    return (prefix || "") + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function toast(msg, err) {
    if (window.hanaToast) window.hanaToast(msg, err);
    else window.alert(msg);
  }

  /* ---------- 날짜 (모두 한국 시간 기준 YYYY-MM-DD 문자열) ---------- */
  function kstNow() {
    return new Date(Date.now() + 9 * 3600 * 1000);
  }
  function today() {
    const d = kstNow();
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }
  function nowTime() {
    const d = kstNow();
    return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  }
  function parse(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || "");
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  }
  function ymd(d) {
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }
  function addDays(s, n) {
    const d = parse(s);
    d.setUTCDate(d.getUTCDate() + n);
    return ymd(d);
  }
  function addMonths(s, n) {
    const d = parse(s);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return ymd(d);
  }
  function weekday(s) {
    const d = parse(s);
    return d ? d.getUTCDay() : 0;
  }
  function weekdayName(s) {
    return WEEKDAYS[weekday(s)];
  }
  function startOfWeek(s, mondayFirst) {
    const w = weekday(s);
    return addDays(s, mondayFirst ? -((w + 6) % 7) : -w);
  }
  function monthStart(s) {
    return s.slice(0, 8) + "01";
  }
  function daysInMonth(s) {
    const d = parse(s);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  }
  function diffDays(a, b) {
    return Math.round((parse(b) - parse(a)) / 86400000);
  }
  function md(s) {
    const d = parse(s);
    return d ? d.getUTCMonth() + 1 + "/" + d.getUTCDate() : "";
  }
  function dot(s) {
    return (s || "").replace(/-/g, ".");
  }
  function kLabel(s) {
    const d = parse(s);
    return d ? d.getUTCMonth() + 1 + "월 " + d.getUTCDate() + "일 (" + WEEKDAYS[d.getUTCDay()] + ")" : "";
  }
  function isoKst(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return "";
    const d = new Date(t + 9 * 3600 * 1000);
    return ymd(d) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  }

  /* ---------- 세션 ---------- */
  const sessionPromise = (window.hanaSession || Promise.resolve({ server: false, me: null, api: null })).catch(() => ({
    server: false,
    me: null,
    api: null,
    failed: true,
  }));
  function currentUser() {
    const el = $(".hana-account-copy strong");
    return (el && el.textContent.trim()) || "사용자";
  }

  /* ---------- 파일 (녹음·첨부·발표 자료) ---------- */
  const idb = (function () {
    let p = null;
    function db() {
      if (!p) {
        p = new Promise((resolve, reject) => {
          if (!("indexedDB" in window)) return reject(new Error("이 브라우저는 파일 저장(IndexedDB)을 지원하지 않습니다."));
          const req = indexedDB.open("hana-notes", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("files");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return p;
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

  const CHUNK = 3 * 1024 * 1024;
  async function apiRaw(method, url, body, type) {
    const headers = { "X-Hana": "1" };
    if (type) headers["Content-Type"] = type;
    const res = await fetch(url, { method, credentials: "same-origin", headers, body });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && typeof data.detail === "string" && data.detail) || "파일을 올리지 못했습니다. (" + res.status + ")");
    return data;
  }
  // 서버 파일을 조각(Range)으로 모두 받아 Blob 으로 만든다
  async function fetchWhole(meta) {
    const url = "/api/blobs/" + encodeURIComponent(meta.id);
    const parts = [];
    let start = 0;
    let total = null;
    let type = "";
    for (let guard = 0; guard < 2000; guard++) {
      const res = await fetch(url + "?download=1", { credentials: "same-origin", headers: { Range: "bytes=" + start + "-" } });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      parts.push(buf);
      const cr = res.headers.get("Content-Range");
      if (res.status !== 206 || !cr) break;
      const m = /\/(\d+)$/.exec(cr);
      total = m ? Number(m[1]) : total;
      start += buf.byteLength;
      if (!buf.byteLength || total === null || start >= total) break;
    }
    type = meta.type || "";
    return new Blob(parts, { type });
  }
  const STREAMABLE = /^(audio|video)\//;

  const files = {
    CHUNK,
    // Blob → { id, name, size, type }. onProgress(0~1) 선택
    async put(blob, name, onProgress) {
      const s = await sessionPromise;
      const fname = name || blob.name || "file";
      if (s.server) {
        const start = await apiRaw("POST", "/api/blobs/start", JSON.stringify({ name: fname, size: blob.size, type: blob.type || "" }), "application/json");
        const size = start.chunkSize || CHUNK;
        const count = Math.max(1, Math.ceil(blob.size / size));
        for (let i = 0; i < count && blob.size; i++) {
          const part = blob.slice(i * size, Math.min(blob.size, (i + 1) * size));
          let tries = 0;
          for (;;) {
            try {
              await apiRaw("PUT", "/api/blobs/" + start.id + "/chunks/" + i, part, "application/octet-stream");
              break;
            } catch (e) {
              if (++tries >= 3) throw e;
              await new Promise((r) => setTimeout(r, 800 * tries));
            }
          }
          if (onProgress) onProgress((i + 1) / count);
        }
        const done = await apiRaw("POST", "/api/blobs/" + start.id + "/finish");
        return { id: done.id, name: done.name, size: done.size, type: done.type || blob.type || "" };
      }
      const meta = { id: uid("f"), name: fname, size: blob.size, type: blob.type || "" };
      await idb.put(meta.id, blob);
      if (onProgress) onProgress(1);
      return meta;
    },
    // { url, revoke } 또는 null
    async url(meta, download) {
      const s = await sessionPromise;
      if (s.server) {
        const direct = "/api/blobs/" + encodeURIComponent(meta.id) + (download ? "?download=1" : "");
        // 작은 파일, 소리·영상(브라우저가 알아서 나눠 받음)은 주소를 그대로 쓴다
        if ((meta.size || 0) <= CHUNK || (!download && STREAMABLE.test(meta.type || ""))) return { url: direct, revoke: false };
        const blob = await fetchWhole(meta);
        return blob ? { url: URL.createObjectURL(blob), revoke: true } : null;
      }
      const blob = await idb.get(meta.id).catch(() => null);
      return blob ? { url: URL.createObjectURL(blob), revoke: true } : null;
    },
    async blob(meta) {
      const s = await sessionPromise;
      if (s.server) return fetchWhole(meta);
      return idb.get(meta.id).catch(() => null);
    },
    async remove(meta) {
      const s = await sessionPromise;
      if (s.server) return s.api("DELETE", "/api/blobs/" + encodeURIComponent(meta.id)).catch(() => {});
      return idb.del(meta.id).catch(() => {});
    },
    async download(meta) {
      const got = await files.url(meta, true);
      if (!got) {
        toast("파일을 찾을 수 없습니다.", true);
        return;
      }
      const a = document.createElement("a");
      a.href = got.url;
      a.download = meta.name || "file";
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (got.revoke) setTimeout(() => URL.revokeObjectURL(got.url), 30000);
    },
  };

  /* ---------- 모음(collection) 저장소 ---------- */
  // opts.seed: 브라우저 모드에서 처음 한 번 넣을 예시 데이터
  // opts.personal: 서버 모드에서 사용자마다 따로 두는 모음 (예: AI 리서치 대화)
  function collection(name, opts) {
    opts = opts || {};
    const key = "hana.c." + name;
    const apiName = (opts.personal ? "my-" : "") + name;
    let cache = null;

    function readLocal() {
      try {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
      } catch (e) {
        /* 손상된 값은 새로 시작 */
      }
      const seed = (opts.seed || []).map((x) => Object.assign({}, x));
      writeLocal(seed);
      return seed;
    }
    function writeLocal(list) {
      try {
        localStorage.setItem(key, JSON.stringify(list));
      } catch (e) {
        throw new Error("브라우저 저장 공간이 부족합니다. 오래된 자료를 지워 주세요.");
      }
    }
    const stamp = () => new Date().toISOString();

    return {
      name,
      async list() {
        const s = await sessionPromise;
        cache = s.server ? await s.api("GET", "/api/c/" + apiName) : readLocal();
        return cache;
      },
      cached() {
        return cache || [];
      },
      async create(item) {
        const s = await sessionPromise;
        const rec = Object.assign({ id: uid(""), createdAt: stamp(), createdBy: currentUser() }, item);
        if (s.server) {
          const saved = await s.api("POST", "/api/c/" + apiName, rec);
          if (cache) cache.push(saved);
          return saved;
        }
        const list = readLocal();
        list.push(rec);
        writeLocal(list);
        cache = list;
        return rec;
      },
      async update(id, patch) {
        const s = await sessionPromise;
        if (s.server) {
          const cur = (cache || []).find((x) => x.id === id) || {};
          const saved = await s.api("PUT", "/api/c/" + apiName + "/" + encodeURIComponent(id), Object.assign({}, cur, patch, { updatedAt: stamp() }));
          if (cache) {
            const i = cache.findIndex((x) => x.id === id);
            if (i >= 0) cache[i] = saved;
          }
          return saved;
        }
        const list = readLocal();
        const i = list.findIndex((x) => x.id === id);
        if (i < 0) throw new Error("항목을 찾을 수 없습니다.");
        list[i] = Object.assign({}, list[i], patch, { updatedAt: stamp() });
        writeLocal(list);
        cache = list;
        return list[i];
      },
      async remove(id) {
        const s = await sessionPromise;
        if (s.server) await s.api("DELETE", "/api/c/" + apiName + "/" + encodeURIComponent(id));
        else writeLocal(readLocal().filter((x) => x.id !== id));
        if (cache) cache = cache.filter((x) => x.id !== id);
      },
      // 여러 개를 한 번에 넣기 (CSV 가져오기 등)
      async createMany(items) {
        const out = [];
        for (const it of items) out.push(await this.create(it));
        return out;
      },
    };
  }

  // 노트 모음(노트 페이지와 같은 저장소)을 다른 페이지에서 읽기
  async function readNotes() {
    const s = await sessionPromise;
    if (s.server) return s.api("GET", "/api/notes").catch(() => []);
    try {
      const v = JSON.parse(localStorage.getItem("hana.notes.v1") || "null");
      if (Array.isArray(v)) return v;
    } catch (e) {
      /* 없음 */
    }
    return [];
  }

  // 작은 개인 설정값 (이 브라우저에만)
  const prefs = {
    get(k, d) {
      try {
        const v = localStorage.getItem("hana.p." + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("hana.p." + k, JSON.stringify(v));
      } catch (e) {
        /* 무시 */
      }
    },
  };

  /* ---------- 모달 ---------- */
  const stack = [];
  function modal(opts) {
    const titleId = uid("m");
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML =
      '<div class="modal ' + (opts.size || "") + '" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '">' +
      '<div class="modal__header"><h2 id="' + titleId + '">' + esc(opts.title) + "</h2>" +
      '<button type="button" class="modal__close" aria-label="닫기">×</button></div></div>';
    const box = overlay.firstElementChild;
    box.insertAdjacentHTML("beforeend", opts.html || "");
    // 열린 <dialog> 가 있으면 그 안에 띄워야 위에 보이고 눌린다 (dialog 는 최상위 층)
    const dialogs = $$("dialog[open]");
    (dialogs.length ? dialogs[dialogs.length - 1] : document.body).appendChild(overlay);
    const ctx = {
      overlay,
      modal: box,
      returnFocus: document.activeElement,
      close(force) {
        if (!force && opts.beforeClose && opts.beforeClose() === false) return;
        const i = stack.indexOf(ctx);
        if (i >= 0) stack.splice(i, 1);
        overlay.remove();
        if (!stack.length) document.body.style.overflow = "";
        if (opts.onClose) opts.onClose();
        if (ctx.returnFocus && document.contains(ctx.returnFocus)) ctx.returnFocus.focus();
      },
      setTitle(t) {
        $("#" + titleId, box).textContent = t;
      },
    };
    $(".modal__close", box).addEventListener("click", () => ctx.close());
    let down = false;
    overlay.addEventListener("mousedown", (e) => (down = e.target === overlay));
    overlay.addEventListener("click", (e) => {
      if (down && e.target === overlay) ctx.close();
      down = false;
    });
    stack.push(ctx);
    document.body.style.overflow = "hidden";
    setTimeout(() => {
      const f = opts.focus ? $(opts.focus, box) : null;
      (f || $(".modal__close", box)).focus();
    }, 0);
    return ctx;
  }
  document.addEventListener("keydown", (e) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === "Escape") {
      e.preventDefault();
      top.close();
    } else if (e.key === "Tab") {
      const f = $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', top.modal).filter(
        (n) => n.offsetParent !== null
      );
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
        e.preventDefault();
        f[0].focus();
      }
    }
  });
  function isModalOpen() {
    return stack.length > 0;
  }
  function confirmBox(message, okLabel, danger) {
    return new Promise((resolve) => {
      let answered = false;
      const ctx = modal({
        title: "확인",
        size: "modal--narrow",
        html:
          '<div class="modal__body"><p class="hint" style="font-size:14px;color:var(--text);white-space:pre-line">' + esc(message) + "</p>" +
          '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-kit="cancel">취소</button>' +
          '<button type="button" class="btn ' + (danger ? "btn--danger" : "btn--primary") + '" data-kit="ok">' + esc(okLabel || "확인") + "</button></div></div></div>",
        focus: '[data-kit="ok"]',
        onClose: () => {
          if (!answered) resolve(false);
        },
      });
      ctx.modal.addEventListener("click", (e) => {
        const b = e.target.closest("[data-kit]");
        if (!b) return;
        answered = true;
        resolve(b.getAttribute("data-kit") === "ok");
        ctx.close(true);
      });
    });
  }

  /* ---------- CSV ---------- */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let q = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === "," || c === "\t") {
        row.push(cell);
        cell = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell);
        if (row.some((x) => x.trim() !== "")) rows.push(row);
        row = [];
        cell = "";
      } else cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim() !== "")) rows.push(row);
    return rows;
  }
  function toCsv(rows) {
    return "﻿" + rows.map((r) => r.map((v) => {
      const s = String(v == null ? "" : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",")).join("\r\n");
  }
  function saveText(name, text, type) {
    const blob = new Blob([text], { type: type || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function fileSize(bytes) {
    if (bytes == null) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }
  function num(v, digits) {
    if (v == null || v === "" || isNaN(v)) return "—";
    return Number(v).toLocaleString("ko-KR", { maximumFractionDigits: digits == null ? 0 : digits, minimumFractionDigits: digits || 0 });
  }

  // IR 일정 유형 (IR 캘린더·홈·종목 분석이 함께 쓴다)
  const IR_TYPES = [
    ["corp_day", "콥데이"], ["ndr", "NDR"], ["open_ir", "오픈IR"], ["ir_meeting", "IR미팅"], ["ipo", "IPO"],
    ["earnings", "실적발표"], ["conference", "컨퍼런스"], ["visit", "탐방"], ["seminar", "세미나"], ["etc", "기타"],
  ];
  const IR_LABEL = Object.fromEntries(IR_TYPES);
  const irEvents = () => collection("ir-events");
  // 여러 날 일정이면 그 기간의 모든 날짜에 걸친다
  function eventCovers(ev, day) {
    const end = ev.endDate && ev.endDate >= ev.date ? ev.endDate : ev.date;
    return ev.date <= day && day <= end;
  }
  function eventTime(ev) {
    if (!ev.time) return "시간 미정";
    return ev.endTime ? ev.time + "~" + ev.endTime : ev.time;
  }
  function byEventTime(a, b) {
    return (a.date || "").localeCompare(b.date || "") || (a.time || "99").localeCompare(b.time || "99") || (a.companies || "").localeCompare(b.companies || "", "ko");
  }

  /* ---------- 마크다운 (AI 답변 표시용, HTML 은 모두 이스케이프). [노트 N] 은 refs 의 N번째 노트 버튼 ---------- */
  function inline(text, refs) {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>");
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>");
    // [노트 3] → 참고 노트 버튼
    s = s.replace(/\[노트\s*(\d+)\]/g, (m, n) => {
      const notes = (refs || []).filter((r) => r.type === "note");
      const ref = notes[Number(n) - 1];
      return ref ? '<button type="button" class="note-ref" data-note="' + esc(String(ref.id)) + '" title="' + esc(ref.company + " · " + ref.title) + '">노트 ' + n + "</button>" : m;
    });
    return s;
  }

  function markdown(src, refs) {
    const lines = String(src || "").replace(/\r/g, "").split("\n");
    const out = [];
    let i = 0;
    const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        out.push("<h" + h[1].length + ">" + inline(h[2], refs) + "</h" + h[1].length + ">");
        i++;
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push(
          '<div class="md-table-wrap"><table class="md-table"><thead><tr>' + head.map((c) => "<th>" + inline(c, refs) + "</th>").join("") + "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + head.map((_, j) => "<td>" + inline(r[j] || "", refs) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>"
        );
        continue;
      }
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
        out.push("<blockquote>" + inline(buf.join(" "), refs) + "</blockquote>");
        continue;
      }
      if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, ""));
        out.push((ordered ? "<ol>" : "<ul>") + items.map((x) => "<li>" + inline(x, refs) + "</li>").join("") + (ordered ? "</ol>" : "</ul>"));
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+[.)])\s+)/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))) buf.push(lines[i++]);
      out.push("<p>" + buf.map((b) => inline(b, refs)).join("<br>") + "</p>");
    }
    return out.join("");
  }


  /* ---------- 섹터: WICS 26개 업종(S.E 와 같은 기준)과 주요 상장사 기본 분류 ---------- */
  const SECTORS = ["에너지", "화학", "비철금속", "철강", "건설", "기계", "조선", "상사,자본재", "운송", "자동차", "화장품,의류", "호텔,레저", "미디어,교육",
    "소매(유통)", "필수소비재", "건강관리", "은행", "증권", "보험", "소프트웨어", "IT하드웨어", "반도체", "IT가전", "디스플레이", "통신서비스", "유틸리티"];
  // 예전 섹터 이름 → WICS (저장해 둔 값이 있으면 바꿔 읽는다)
  const SECTOR_OLD = { "바이오·헬스케어": "건강관리", "IT·인터넷": "소프트웨어", "게임·엔터": "소프트웨어", "조선·기계": "기계", "방산·우주": "기계",
    "화학·에너지": "화학", "철강·소재": "철강", "건설·부동산": "건설", "소비재·유통": "필수소비재", "통신·미디어": "통신서비스", "운송·물류": "운송",
    "전기·전자": "IT하드웨어", "2차전지": "IT하드웨어", "금융": "증권", "기타": "" };
  function sectorNorm(s) {
    if (!s) return "";
    return Object.prototype.hasOwnProperty.call(SECTOR_OLD, s) ? SECTOR_OLD[s] : s;
  }
  const SECTOR_SEED = {
    "반도체": "삼성전자 SK하이닉스 한미반도체 DB하이텍 리노공업 이오테크닉스 원익IPS 주성엔지니어링 피에스케이 피에스케이홀딩스 테스 유진테크 솔브레인 동진쎄미켐 하나마이크론 ISC 티씨케이 고영 파두 에스앤에스텍 제주반도체 네패스 넥스틴 HPSP 가온칩스 오픈엣지테크놀로지 칩스앤미디어 에이디테크놀로지 심텍 코미코 원익QnC 케이씨텍 월덱스 하나머티리얼즈 엘오티베큠 에프에스티 제우스 디아이 와이씨 티에스이 레이저쎌 퀄리타스반도체 자람테크놀로지 에스티아이 에이피티씨 미코 두산테스나 SFA반도체 텔레칩스 어보브반도체 샘씨엔에스 매커스 프로텍 오로스테크놀로지 인텍플러스 GST 케이엔제이 서울반도체",
    "디스플레이": "LG디스플레이 선익시스템 AP시스템 덕산네오룩스 에스에프에이 SFA 동아엘텍 비아트론 이녹스첨단소재 덕산하이메탈",
    "IT하드웨어": "삼성전기 LG이노텍 삼성SDI LG에너지솔루션 대덕전자 이수페타시스 비에이치 삼화콘덴서 파트론 엠씨넥스 자화전자 인탑스 아모텍 서진시스템 SK아이이테크놀로지 삼기에너지솔루션즈 세방전지 한국단자 KEC 코리아써키트 LG헬로비전",
    "IT가전": "LG전자 코웨이 위닉스 쿠쿠홈시스 쿠쿠전자 신일전자 파세코",
    "상사,자본재": "HD현대일렉트릭 LS일렉트릭 효성중공업 일진전기 제룡전기 대한전선 가온전선 산일전기 LS에코에너지 대원전선 포스코인터내셔널 LX인터내셔널 삼성물산 SK LG CJ 두산 LS 한화 HD현대 롯데지주 코오롱 효성 SK스퀘어 AK홀딩스 HL홀딩스 SK네트웍스",
    "기계": "두산밥캣 HD현대건설기계 HD현대인프라코어 두산에너빌리티 비에이치아이 레인보우로보틱스 두산로보틱스 로보티즈 에스피지 유일로보틱스 씨에스윈드 한화에어로스페이스 한국항공우주 LIG넥스원 현대로템 한화시스템 쎄트렉아이 퍼스텍 빅텍 스페코 아이쓰리시스템 인텔리안테크 컨텍 제노코 휴니드 피엔티 씨아이에스 하나기술 윤성에프앤씨 원준 에이프로 유니슨 두산퓨얼셀 에스퓨얼셀 한독크린텍 우진 에스엠씨지 SNT다이내믹스",
    "조선": "HD한국조선해양 HD현대중공업 삼성중공업 한화오션 HD현대미포 HD현대마린솔루션 한국카본 동성화인텍 세진중공업 한화엔진 HD현대마린엔진 STX엔진 케이프 태광 성광벤드 하이록코리아 현대힘스 대창솔루션 삼영엠텍 SK오션플랜트",
    "자동차": "현대차 기아 현대모비스 현대위아 한온시스템 HL만도 에스엘 한국타이어앤테크놀로지 금호타이어 넥센타이어 화신 성우하이텍 서연이화 명신산업 SNT모티브 모트렉스 우리산업 상신이디피 신흥에스이씨",
    "에너지": "SK이노베이션 S-Oil S-OIL 에쓰오일 GS SK가스 E1 흥구석유 중앙에너비스",
    "화학": "LG화학 롯데케미칼 한화솔루션 금호석유화학 금호석유 SKC OCI홀딩스 OCI 한솔케미칼 코오롱인더스트리 대한유화 효성화학 롯데정밀화학 KCC 휴켐스 PI첨단소재 동성케미컬 효성첨단소재 에코프로 에코프로비엠 에코프로머티 포스코퓨처엠 엘앤에프 코스모신소재 천보 대주전자재료 나노신소재 솔루스첨단소재 엔켐 동화기업 금양 코스모화학 성일하이텍 새빗켐 후성 에코프로에이치엔 더블유씨피 에스엠랩 탑머티리얼 백광산업 SK케미칼 애경케미칼",
    "비철금속": "고려아연 영풍 풍산 풍산홀딩스 알루코 조일알미늄 삼아알미늄 대창 서원 이구산업",
    "철강": "POSCO홀딩스 포스코홀딩스 현대제철 동국제강 세아베스틸지주 KG스틸 세아제강 TCC스틸 한국철강 휴스틸 문배철강 포스코엠텍 태경비케이 동원시스템즈",
    "건설": "현대건설 대우건설 GS건설 DL이앤씨 HDC현대산업개발 삼성E&A 계룡건설 태영건설 한일시멘트 쌍용C&E 아이에스동서 금호건설 코오롱글로벌 동부건설 신세계건설 KCC건설 LX하우시스 한샘 한국자산신탁 한국토지신탁 SK리츠 롯데리츠 ESR켄달스퀘어리츠 제이알글로벌리츠",
    "운송": "대한항공 아시아나항공 제주항공 진에어 티웨이항공 HMM 팬오션 대한해운 현대글로비스 CJ대한통운 한진 한진칼 KSS해운 흥아해운 동방 세방 에어부산",
    "화장품,의류": "아모레퍼시픽 LG생활건강 코스맥스 한국콜마 에이피알 실리콘투 브이티 클리오 코스메카코리아 씨앤씨인터내셔널 잉글우드랩 토니모리 달바글로벌 마녀공장 아로마티카 에이블씨엔씨 F&F 한섬 휠라홀딩스 영원무역 한세실업 신세계인터내셔날 LF 대봉엘에스",
    "호텔,레저": "호텔신라 파라다이스 GKL 강원랜드 하나투어 모두투어 롯데관광개발 노랑풍선 참좋은여행",
    "미디어,교육": "스튜디오드래곤 SBS 제일기획 이노션 나스미디어 콘텐트리중앙 에코마케팅 하이브 JYP 에스엠 와이지엔터테인먼트 디어유 큐브엔터 에프엔씨엔터 드림어스컴퍼니 SOOP 아프리카TV 티캐스트 메가스터디교육 디지털대성 NHN벅스",
    "소매(유통)": "이마트 롯데쇼핑 신세계 현대백화점 BGF리테일 GS리테일 GS홈쇼핑 현대홈쇼핑 롯데하이마트",
    "필수소비재": "삼양식품 오리온 CJ제일제당 농심 오뚜기 롯데칠성 하이트진로 KT&G 빙그레 삼립 SPC삼립 롯데웰푸드 대상 동원F&B 풀무원 매일유업 남양유업 삼양사 사조대림 CJ프레시웨이 현대그린푸드",
    "건강관리": "삼성바이오로직스 셀트리온 알테오젠 유한양행 한미약품 한미사이언스 SK바이오팜 SK바이오사이언스 HLB 리가켐바이오 에이비엘바이오 오스코텍 올릭스 알지노믹스 GC녹십자 녹십자 종근당 대웅제약 대웅 동아에스티 보령 일동제약 셀트리온제약 휴젤 파마리서치 클래시스 메디톡스 삼천당제약 펩트론 루닛 뷰노 딥노이드 덴티움 레이 바텍 인바디 휴온스 삼진제약 부광약품 신풍제약 에스티팜 코오롱티슈진 브릿지바이오테라퓨틱스 지아이이노베이션 나이벡 앱클론 보로노이 온코닉테라퓨틱스 큐리언트 메지온 차바이오텍 씨젠 에스디바이오센서 바이오니아 프레스티지바이오파마 에이프릴바이오 디앤디파마텍 한올바이오파마 이수앱지스 라메디텍 광동헬스바이오 광동제약 바이오프로테크 프로젠 HK이노엔 JW중외제약 동국제약 원텍 제이시스메디칼 비올 아이센스 오스템임플란트 인트론바이오 알리코제약 셀비온 티움바이오 샤페론 네오이뮨텍 박셀바이오 에이치엘비생명과학 HLB생명과학 HLB제약 유바이오로직스 케어젠 현대바이오 에스바이오메딕스",
    "은행": "KB금융 신한지주 하나금융지주 우리금융지주 기업은행 BNK금융지주 JB금융지주 DGB금융지주 iM금융지주 카카오뱅크 제주은행",
    "증권": "미래에셋증권 한국금융지주 NH투자증권 삼성증권 키움증권 대신증권 한화투자증권 SK증권 유안타증권 교보증권 LS증권 다올투자증권 우리기술투자 메리츠금융지주 삼성카드",
    "보험": "삼성생명 삼성화재 한화생명 DB손해보험 현대해상 코리안리 한화손해보험 동양생명 미래에셋생명 흥국화재",
    "소프트웨어": "NAVER 네이버 카카오 크래프톤 엔씨소프트 넷마블 펄어비스 카카오게임즈 위메이드 컴투스 컴투스홀딩스 네오위즈 데브시스터즈 시프트업 웹젠 그라비티 조이시티 삼성에스디에스 삼성SDS 더존비즈온 포스코DX 현대오토에버 안랩 한글과컴퓨터 다우기술 솔트룩스 코난테크놀로지 폴라리스오피스 가비아 NHN 롯데이노베이트 신세계I&C 엠로 이스트소프트 알체라 셀바스AI 플랜티넷 심플랫폼 LS티라유텍 한컴위드 케이아이엔엑스 KG이니시스 다날 웹케시 비즈니스온 지니언스 윈스 파수 라온시큐어 카카오페이",
    "통신서비스": "SK텔레콤 KT LG유플러스 스카이라이프 KT스카이라이프",
    "유틸리티": "한국전력 한국가스공사 지역난방공사 한국지역난방공사 서울가스 삼천리 SGC에너지 한전기술 한전KPS 경동도시가스 대성에너지",
  };
  const SECTOR_MAP = new Map();
  Object.keys(SECTOR_SEED).forEach((sec) => SECTOR_SEED[sec].split(" ").forEach((n) => n && SECTOR_MAP.set(n.toUpperCase(), sec)));
  SECTOR_MAP.set("LS ELECTRIC", "상사,자본재");
  SECTOR_MAP.set("NHN KCP", "소프트웨어");
  SECTOR_MAP.set("LG CNS", "소프트웨어");
  SECTOR_MAP.set("CJ ENM", "미디어,교육");
  SECTOR_MAP.set("JYP ENT.", "미디어,교육");
  function sectorGuess(name) {
    if (!name) return "";
    const key = String(name).replace(/\s+\(.*\)$/, "").trim().toUpperCase();
    return SECTOR_MAP.get(key) || SECTOR_MAP.get(key.replace(/\s+/g, "")) || SECTOR_MAP.get(key.replace(/우$|우B$/, "")) || "";
  }

  window.Kit = {
    IR_TYPES, IR_LABEL, irEvents, eventCovers, eventTime, byEventTime,
    $, $$, esc, pad, uid, toast,
    today, nowTime, parse, ymd, addDays, addMonths, weekday, weekdayName, startOfWeek, monthStart, daysInMonth, diffDays, md, dot, kLabel, isoKst,
    WEEKDAYS,
    session: () => sessionPromise,
    currentUser,
    files,
    collection,
    readNotes,
    prefs,
    modal,
    isModalOpen,
    confirm: confirmBox,
    parseCsv, toCsv, saveText, fileSize, num,
    markdown,
    SECTORS, sectorGuess, sectorNorm,
  };
})();
