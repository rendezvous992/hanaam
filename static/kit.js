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
  };
})();
