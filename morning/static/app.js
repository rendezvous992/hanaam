/* 아침회의 — 날짜별 발표 자료 올리기, 발표 순서 정하기, 발표 화면(원본·미리보기), 지난 자료 보관함 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const store = K.collection("morning-decks");

  let items = [];
  let canWrite = true; // 서버 모드에서는 관리자만
  let people = []; // 발표자 자동 완성 [{name, dept}]
  const state = {
    view: "today",
    date: K.today(),
    q: "",
    range: K.prefs.get("mm.range", "all"),
  };

  /* ---------- 파일 종류 ---------- */
  const EXT = {
    pdf: ["pdf", "PDF"],
    image: ["png jpg jpeg gif webp bmp svg", "IMG"],
    slides: ["ppt pptx pps ppsx key odp", "PPT"],
    sheet: ["xls xlsx xlsm csv ods", "XLS"],
    doc: ["doc docx hwp hwpx txt md rtf odt", "DOC"],
  };
  function ext(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }
  function kindOf(file) {
    const e = ext(file.name);
    if ((file.type || "") === "application/pdf" || e === "pdf") return "pdf";
    if (/^image\//.test(file.type || "") || EXT.image[0].split(" ").includes(e)) return "image";
    for (const k of ["slides", "sheet", "doc"]) if (EXT[k][0].split(" ").includes(e)) return k;
    return "doc";
  }
  function kindLabel(k, file) {
    if (k === "link") return "LINK";
    const e = ext(file && file.name);
    if (k === "doc" && e === "hwp") return "HWP";
    if (k === "doc" && (e === "txt" || e === "md")) return "TXT";
    if (k === "sheet" && e === "csv") return "CSV";
    return EXT[k] ? EXT[k][1] : "FILE";
  }
  function linkName(link) {
    if (link.label) return link.label;
    try {
      return new URL(link.url).host;
    } catch (e) {
      return link.url;
    }
  }

  /* ---------- 자료 묶음 ---------- */
  function byOrder(a, b) {
    return (a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order) || (a.createdAt || "").localeCompare(b.createdAt || "");
  }
  function decksOn(day) {
    return items.filter((x) => x.date === day).sort(byOrder);
  }
  // 발표 화면에서 넘길 순서: 발표 순서 → 그 안의 파일 순서 → 링크
  function slidesOf(decks) {
    const out = [];
    decks.forEach((d) => {
      (d.files || []).forEach((f, i) => out.push({ deck: d, file: f, index: i, kind: kindOf(f) }));
      if (d.link && d.link.url) out.push({ deck: d, link: d.link, index: "link", kind: "link" });
    });
    return out;
  }

  function chipHtml(deck, file, i) {
    const k = kindOf(file);
    return (
      '<span class="mm-chipwrap"><button type="button" class="mm-chip mm-chip--' + k + '" data-play="' + esc(deck.id) + '" data-i="' + i + '" title="발표 화면으로 열기">' +
      '<span class="mm-chip__kind">' + esc(kindLabel(k, file)) + '</span><span class="mm-chip__name">' + esc(file.name) + '</span><span class="mm-chip__size">' + esc(K.fileSize(file.size)) + "</span></button>" +
      '<button type="button" class="mm-raw mm-raw--text" data-preview="' + esc(deck.id) + '" data-i="' + i + '">미리보기</button>' +
      '<a href="#" class="mm-raw" data-down="' + esc(deck.id) + '" data-i="' + i + '" title="내려받기" aria-label="' + esc(file.name) + ' 내려받기">↓</a></span>'
    );
  }
  function linkChipHtml(deck) {
    return (
      '<span class="mm-chipwrap"><button type="button" class="mm-chip mm-chip--link" data-play="' + esc(deck.id) + '" data-i="link" title="발표 화면으로 열기">' +
      '<span class="mm-chip__kind">LINK</span><span class="mm-chip__name">' + esc(linkName(deck.link)) + "</span></button>" +
      '<a class="mm-raw" href="' + esc(safeUrl(deck.link.url)) + '" target="_blank" rel="noopener noreferrer" title="새 창에서 열기" aria-label="링크 새 창에서 열기">↗</a></span>'
    );
  }
  function filesHtml(deck) {
    return (deck.files || []).map((f, i) => chipHtml(deck, f, i)).join("") + (deck.link && deck.link.url ? linkChipHtml(deck) : "");
  }
  function safeUrl(u) {
    return /^https?:\/\//i.test(u || "") ? u : "#";
  }

  /* ---------- 탭 ---------- */
  function setView(v) {
    if (v === "upload" && !canWrite) v = "today";
    state.view = v;
    $$("#mm-tabs .segmented__btn").forEach((b) => {
      const on = b.getAttribute("data-view") === v;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    $$("section.mm-view").forEach((s) => (s.hidden = s.getAttribute("data-view") !== v));
    const hash = v === "today" ? "" : "#" + v;
    if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
    render();
  }

  /* ---------- 오늘 발표 ---------- */
  function renderToday() {
    const day = state.date;
    $("#mm-date").value = day;
    const decks = decksOn(day);
    const nFiles = slidesOf(decks).length;
    $("#mm-day-count").textContent = decks.length ? K.kLabel(day) + " · 발표 " + decks.length + "건 · 자료 " + nFiles + "개" : K.kLabel(day);
    $("#mm-start").disabled = !nFiles;
    $("#mm-today-empty").hidden = decks.length > 0;
    $(".mm-hint").hidden = !decks.length;
    $("#mm-today-list").innerHTML = decks.map((d, i) =>
      '<article class="mm-card" data-id="' + esc(d.id) + '"><div class="mm-card__head">' +
      (canWrite ? '<span class="mm-grip" data-grip title="끌어서 발표 순서 바꾸기" aria-hidden="true">⠿</span>' : "") +
      '<span class="mm-card__no">' + (i + 1) + "</span>" +
      '<div class="mm-card__who"><strong>' + esc(d.presenter || "발표자 미정") + "</strong>" + (d.dept ? '<span class="mm-card__dept">' + esc(d.dept) + "</span>" : "") + "</div>" +
      (d.title ? '<span class="mm-card__title">' + esc(d.title) + "</span>" : "") +
      (canWrite
        ? '<div class="mm-card__tools"><button type="button" class="mm-icon" data-move="-1" aria-label="앞으로"' + (i === 0 ? " disabled" : "") + ">↑</button>" +
          '<button type="button" class="mm-icon" data-move="1" aria-label="뒤로"' + (i === decks.length - 1 ? " disabled" : "") + ">↓</button>" +
          '<button type="button" class="mm-icon" data-edit>수정</button><button type="button" class="mm-icon mm-icon--danger" data-del>삭제</button></div>'
        : "") +
      '</div><div class="mm-card__files">' + filesHtml(d) + "</div></article>"
    ).join("");
  }

  /* ---------- 지난 자료 ---------- */
  function matches(d, q) {
    if (!q) return true;
    const hay = [d.presenter, d.dept, d.title, d.date, d.link && d.link.label, d.link && d.link.url].concat((d.files || []).map((f) => f.name)).join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  function renderArchive() {
    const q = state.q.trim();
    const from = state.range === "all" ? "" : K.addDays(K.today(), -Number(state.range));
    const list = items.filter((d) => (!from || d.date >= from) && matches(d, q));
    const days = Array.from(new Set(list.map((d) => d.date))).sort().reverse();
    $("#mm-archive-count").textContent = list.length ? days.length + "일 · 발표 " + list.length + "건" : "";
    $("#mm-archive-empty").hidden = list.length > 0;
    $("#mm-archive-empty-title").textContent = items.length ? "찾는 자료가 없습니다." : "아직 올라온 발표 자료가 없습니다.";
    $("#mm-archive").innerHTML = days.map((day) => {
      const decks = list.filter((d) => d.date === day).sort(byOrder);
      return (
        '<section class="mm-daygroup" data-day="' + day + '"><div class="mm-daygroup__head"><h2>' + esc(day.slice(0, 4) + "년 " + K.kLabel(day)) + "</h2>" +
        '<span class="mm-daycount">' + decks.length + "건</span>" +
        '<button type="button" class="btn btn--ghost btn--sm" data-open-day="' + day + '">이 날 발표 보기</button></div>' +
        decks.map((d) =>
          '<div class="mm-arow" data-id="' + esc(d.id) + '"><div class="mm-arow__who"><strong>' + esc(d.presenter || "발표자 미정") + "</strong>" +
          (d.dept ? '<span class="mm-card__dept">' + esc(d.dept) + "</span>" : "") + "</div>" +
          (d.title ? '<span class="mm-card__title">' + esc(d.title) + "</span>" : "") +
          '<div class="mm-arow__files">' + filesHtml(d) + "</div>" +
          (canWrite ? '<button type="button" class="mm-icon mm-icon--danger" data-del>삭제</button>' : "") + "</div>"
        ).join("") + "</section>"
      );
    }).join("");
  }

  /* ---------- 올리기·고치기 폼 ---------- */
  function formHtml() {
    return (
      '<div class="field-row"><label class="field"><span class="field__label">발표 날짜 <em class="required">*</em></span><input class="input" type="date" name="date" required></label>' +
      '<label class="field"><span class="field__label">발표자 <em class="required">*</em></span><input class="input" name="presenter" list="mm-people" autocomplete="off" maxlength="40" placeholder="이름"></label></div>' +
      '<div class="field-row"><label class="field"><span class="field__label">부서·팀 <span class="field__note">(선택)</span></span><input class="input" name="dept" maxlength="40" placeholder="예: 리서치팀"></label>' +
      '<label class="field"><span class="field__label">제목 <span class="field__note">(선택)</span></span><input class="input" name="title" maxlength="120" placeholder="예: 반도체 업황 점검"></label></div>' +
      '<div class="mm-either"><span class="field__label">발표 자료 <span class="field__note">— 파일과 링크 중 하나는 꼭 넣어 주세요</span></span>' +
      '<div class="mm-drop" data-drop><button type="button" class="btn btn--ghost btn--sm" data-pick>파일 고르기</button>' +
      '<input type="file" name="files" multiple hidden>' +
      '<span class="mm-drop__hint">여기로 끌어 놓아도 됩니다. <strong>PDF·이미지</strong>는 원본 그대로, PPT·엑셀·워드는 글자·표 미리보기로 발표합니다.<br>여러 개를 올리면 올린 순서대로 넘어갑니다.</span></div>' +
      '<ul class="mm-filelist" data-filelist></ul>' +
      '<div class="mm-either__or">또는</div>' +
      '<label class="field"><span class="field__label field__label--sub">링크 주소 (구글 슬라이드·원드라이브 등 공유 주소)</span><input class="input" type="url" name="linkUrl" placeholder="https://"></label>' +
      '<label class="field"><span class="field__label field__label--sub">링크 이름 (선택)</span><input class="input" name="linkLabel" maxlength="80"></label></div>'
    );
  }

  // 폼 하나를 다룬다. existing 이 있으면 고치기
  function bindForm(form, existing, onDone) {
    const f = (n) => form.elements[n];
    let keep = existing ? (existing.files || []).slice() : [];
    let fresh = []; // { file, pct }
    let busy = false;
    function fill() {
      const d = existing || {};
      f("date").value = d.date || state.date || K.today();
      f("presenter").value = d.presenter || "";
      f("dept").value = d.dept || "";
      f("title").value = d.title || "";
      f("linkUrl").value = (d.link && d.link.url) || "";
      f("linkLabel").value = (d.link && d.link.label) || "";
      keep = existing ? (existing.files || []).slice() : [];
      fresh = [];
      drawFiles();
    }
    function drawFiles() {
      const rows = keep.map((m, i) =>
        '<li class="mm-fileitem"><span class="mm-fileitem__name">' + esc(m.name) + '</span><span class="mm-fileitem__size">' + esc(K.fileSize(m.size)) + "</span>" +
        '<button type="button" class="mm-icon mm-icon--danger" data-rm-keep="' + i + '"' + (busy ? " disabled" : "") + ">빼기</button></li>"
      ).concat(fresh.map((x, i) =>
        '<li class="mm-fileitem"><span class="mm-fileitem__name">' + esc(x.file.name) + '</span><span class="mm-fileitem__size" data-pct="' + i + '">' +
        esc(x.pct == null ? K.fileSize(x.file.size) : "올리는 중 " + Math.round(x.pct * 100) + "%") + "</span>" +
        '<button type="button" class="mm-icon mm-icon--danger" data-rm-new="' + i + '"' + (busy ? " disabled" : "") + ">빼기</button></li>"
      ));
      $("[data-filelist]", form).innerHTML = rows.join("");
    }
    function addFiles(list) {
      Array.from(list || []).forEach((file) => {
        if (file.size > 500 * 1024 * 1024) K.toast(file.name + ": 500MB 를 넘는 파일은 올릴 수 없습니다.", true);
        else fresh.push({ file, pct: null });
      });
      drawFiles();
    }
    const drop = $("[data-drop]", form);
    $("[data-pick]", form).addEventListener("click", () => f("files").click());
    f("files").addEventListener("change", () => {
      addFiles(f("files").files);
      f("files").value = "";
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("is-over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("is-over");
      addFiles(e.dataTransfer && e.dataTransfer.files);
    });
    form.addEventListener("click", (e) => {
      const a = e.target.closest("[data-rm-keep]");
      if (a) {
        keep.splice(Number(a.getAttribute("data-rm-keep")), 1);
        return drawFiles();
      }
      const b = e.target.closest("[data-rm-new]");
      if (b) {
        fresh.splice(Number(b.getAttribute("data-rm-new")), 1);
        drawFiles();
      }
    });
    // 발표자를 고르면 부서를 채운다
    f("presenter").addEventListener("change", () => {
      const p = people.find((x) => x.name === f("presenter").value.trim());
      if (p && p.dept && !f("dept").value.trim()) f("dept").value = p.dept;
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      const url = f("linkUrl").value.trim();
      const data = {
        date: f("date").value,
        presenter: f("presenter").value.trim(),
        dept: f("dept").value.trim(),
        title: f("title").value.trim(),
        link: url ? { url, label: f("linkLabel").value.trim() } : null,
      };
      if (!data.date) return K.toast("발표 날짜를 골라 주세요.", true), f("date").focus();
      if (!data.presenter) return K.toast("발표자를 입력해 주세요.", true), f("presenter").focus();
      if (url && !/^https?:\/\/\S+$/i.test(url)) return K.toast("링크는 http:// 또는 https:// 로 시작해야 합니다.", true), f("linkUrl").focus();
      if (!keep.length && !fresh.length && !url) return K.toast("발표 자료 파일을 고르거나 링크를 넣어 주세요.", true);
      const submit = $('button[type="submit"]', form);
      const label = submit.textContent;
      busy = true;
      submit.disabled = true;
      drawFiles();
      const uploaded = [];
      try {
        const total = fresh.reduce((s, x) => s + (x.file.size || 1), 0) || 1;
        let doneBytes = 0;
        for (let i = 0; i < fresh.length; i++) {
          const x = fresh[i];
          const meta = await K.files.put(x.file, x.file.name, (p) => {
            x.pct = p;
            const el = $('[data-pct="' + i + '"]', form);
            if (el) el.textContent = "올리는 중 " + Math.round(p * 100) + "%";
            submit.textContent = "올리는 중… " + Math.round(((doneBytes + (x.file.size || 1) * p) / total) * 100) + "%";
          });
          doneBytes += x.file.size || 1;
          uploaded.push(meta);
        }
        data.files = keep.concat(uploaded);
        const sameDay = items.filter((x) => x.date === data.date && (!existing || x.id !== existing.id));
        const nextOrder = sameDay.reduce((m, x) => Math.max(m, x.order == null ? -1 : x.order), -1) + 1;
        let saved;
        if (existing) {
          if (existing.date !== data.date) data.order = nextOrder;
          saved = await store.update(existing.id, data);
          // 뺀 파일은 저장소에서도 지운다
          (existing.files || []).filter((m) => !data.files.some((k) => k.id === m.id)).forEach((m) => K.files.remove(m));
        } else {
          data.order = nextOrder;
          saved = await store.create(data);
        }
        items = store.cached();
        fresh = [];
        K.toast(existing ? "고쳤습니다." : "발표 자료를 올렸습니다.");
        onDone(saved);
      } catch (err) {
        uploaded.forEach((m) => K.files.remove(m));
        fresh.forEach((x) => (x.pct = null));
        K.toast("올리지 못했습니다: " + err.message, true);
      } finally {
        busy = false;
        submit.disabled = false;
        submit.textContent = label;
        drawFiles();
      }
    });
    fill();
    return { fill, isBusy: () => busy, dirty: () => fresh.length > 0 };
  }

  let uploadForm = null;
  function setupUploadForm() {
    const form = $("#mm-upload-form");
    form.innerHTML = formHtml() +
      '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-reset>비우기</button>' +
      '<button type="submit" class="btn btn--primary">올리기</button></div></div>';
    uploadForm = bindForm(form, null, (saved) => {
      state.date = saved.date;
      const keepDate = saved.date;
      uploadForm.fill();
      form.elements.date.value = keepDate;
      setView("today");
    });
    $("[data-reset]", form).addEventListener("click", () => uploadForm.fill());
  }

  function openEditor(deck) {
    const ctx = K.modal({
      title: "발표 자료 고치기",
      size: "modal--wide",
      html: '<form class="modal__body" id="mm-edit-form" novalidate>' + formHtml() +
        '<div class="modal__footer"><button type="button" class="btn btn--danger btn--sm" data-act="delete">삭제</button><div class="modal__footer-right">' +
        '<button type="button" class="btn btn--ghost" data-act="cancel">취소</button><button type="submit" class="btn btn--primary">저장</button></div></div></form>',
      focus: '[name="presenter"]',
      beforeClose: () => !(binder && binder.isBusy()),
    });
    const form = $("#mm-edit-form", ctx.modal);
    const binder = bindForm(form, deck, () => {
      ctx.close(true);
      render();
    });
    $('[data-act="cancel"]', form).addEventListener("click", () => ctx.close());
    $('[data-act="delete"]', form).addEventListener("click", async () => {
      if (await removeDeck(deck)) ctx.close(true);
    });
  }

  async function removeDeck(deck) {
    const n = (deck.files || []).length;
    if (!(await K.confirm((deck.presenter || "") + " · " + K.kLabel(deck.date) + "\n이 발표 자료" + (n ? "(파일 " + n + "개)" : "") + "를 삭제할까요? 되돌릴 수 없습니다.", "삭제", true))) return false;
    try {
      await store.remove(deck.id);
      (deck.files || []).forEach((m) => K.files.remove(m));
      items = store.cached();
      render();
      K.toast("삭제했습니다.");
      return true;
    } catch (err) {
      K.toast("삭제하지 못했습니다: " + err.message, true);
      return false;
    }
  }

  /* ---------- 발표 순서 ---------- */
  async function saveOrder(ids) {
    try {
      for (let i = 0; i < ids.length; i++) {
        const d = items.find((x) => x.id === ids[i]);
        if (d && d.order !== i) await store.update(d.id, { order: i });
      }
      items = store.cached();
    } catch (err) {
      K.toast("순서를 저장하지 못했습니다: " + err.message, true);
      items = await store.list().catch(() => items);
    }
    render();
  }
  function moveDeck(id, delta) {
    const ids = decksOn(state.date).map((d) => d.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ids.splice(i, 1)[0]);
    saveOrder(ids);
  }
  // ⠿ 를 잡고 끌기 (마우스·터치 모두 pointer 이벤트로)
  function setupDrag() {
    const list = $("#mm-today-list");
    let drag = null;
    list.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest("[data-grip]");
      if (!grip || e.button > 0) return;
      e.preventDefault();
      const card = grip.closest(".mm-card");
      drag = { card, before: $$(".mm-card", list).map((c) => c.getAttribute("data-id")).join(","), id: e.pointerId };
      card.classList.add("mm-card--ghost");
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 무시 */
      }
    });
    list.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const cards = $$(".mm-card", list).filter((c) => c !== drag.card);
      const after = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      if (after) {
        if (drag.card.nextElementSibling !== after) list.insertBefore(drag.card, after);
      } else if (list.lastElementChild !== drag.card) list.appendChild(drag.card);
    });
    function end() {
      if (!drag) return;
      const d = drag;
      drag = null;
      d.card.classList.remove("mm-card--ghost");
      const ids = $$(".mm-card", list).map((c) => c.getAttribute("data-id"));
      if (ids.join(",") !== d.before) saveOrder(ids);
    }
    list.addEventListener("pointerup", end);
    list.addEventListener("pointercancel", end);
  }

  /* ---------- 미리보기용 글자 뽑기 (PPTX·DOCX·XLSX 는 zip 안의 XML) ---------- */
  async function unzip(blob) {
    if (typeof DecompressionStream === "undefined") throw new Error("이 브라우저는 압축 풀기를 지원하지 않습니다.");
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("파일 구조를 읽지 못했습니다.");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = {};
    const dec = new TextDecoder();
    for (let n = 0; n < count && p + 46 <= buf.length; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const nameLen = dv.getUint16(p + 28, true);
      entries[dec.decode(buf.subarray(p + 46, p + 46 + nameLen))] = { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), local: dv.getUint32(p + 42, true) };
      p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return {
      names: Object.keys(entries),
      async text(name) {
        const e = entries[name];
        if (!e) return null;
        const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
        const data = buf.subarray(start, start + e.size);
        if (e.method === 0) return dec.decode(data);
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Response(stream).text();
      },
    };
  }
  const xml = (s) => new DOMParser().parseFromString(s || "<x/>", "application/xml");
  const tags = (node, name) => Array.from(node.getElementsByTagNameNS("*", name));
  // 접두어(w:, r: 등)와 상관없이 속성 값 읽기
  function attr(node, local) {
    if (!node) return "";
    const a = Array.from(node.attributes).find((x) => x.localName === local);
    return a ? a.value : "";
  }
  const byNum = (a, b) => Number((/(\d+)\.xml$/.exec(a) || [0, 0])[1]) - Number((/(\d+)\.xml$/.exec(b) || [0, 0])[1]);
  function tableHtml(rows) {
    if (!rows.length) return "";
    return '<table class="mp-table"><tbody>' + rows.map((r, i) => "<tr>" + r.map((c) => (i === 0 ? "<th>" : "<td>") + esc(c) + (i === 0 ? "</th>" : "</td>")).join("") + "</tr>").join("") + "</tbody></table>";
  }
  async function previewPptx(zip) {
    const slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNum);
    let html = "";
    for (let i = 0; i < slides.length; i++) {
      const doc = xml(await zip.text(slides[i]));
      const paras = tags(doc, "p").map((p) => tags(p, "t").map((t) => t.textContent).join("")).filter((t) => t.trim());
      html += "<h4>슬라이드 " + (i + 1) + "</h4>" + (paras.length ? paras.map((t) => "<p>" + esc(t) + "</p>").join("") : '<p class="mm-empty">(글자 없음 — 그림·도표만 있는 장)</p>');
    }
    return html || '<p class="mm-empty">슬라이드를 찾지 못했습니다.</p>';
  }
  async function previewDocx(zip) {
    const doc = xml(await zip.text("word/document.xml"));
    const body = tags(doc, "body")[0];
    if (!body) return '<p class="mm-empty">본문을 찾지 못했습니다.</p>';
    const paraText = (p) => {
      let s = "";
      p.querySelectorAll("*").forEach((n) => {
        if (n.localName === "t") s += n.textContent;
        else if (n.localName === "tab") s += "\t";
        else if (n.localName === "br") s += "\n";
      });
      return s;
    };
    let html = "";
    Array.from(body.children).forEach((node) => {
      if (node.localName === "p") {
        const t = paraText(node);
        if (!t.trim()) return;
        const sv = attr(tags(node, "pStyle")[0], "val");
        html += /heading|title|제목/i.test(sv) ? "<h4>" + esc(t) + "</h4>" : "<p>" + esc(t) + "</p>";
      } else if (node.localName === "tbl") {
        const rows = tags(node, "tr").map((tr) => Array.from(tr.children).filter((c) => c.localName === "tc").map((tc) => tags(tc, "p").map(paraText).join("\n")));
        html += tableHtml(rows);
      }
    });
    return html || '<p class="mm-empty">글자가 없습니다.</p>';
  }
  async function previewXlsx(zip) {
    const shared = zip.names.includes("xl/sharedStrings.xml") ? tags(xml(await zip.text("xl/sharedStrings.xml")), "si").map((si) => tags(si, "t").map((t) => t.textContent).join("")) : [];
    const wb = xml(await zip.text("xl/workbook.xml"));
    const rels = xml(await zip.text("xl/_rels/workbook.xml.rels"));
    const target = {};
    tags(rels, "Relationship").forEach((r) => (target[r.getAttribute("Id")] = r.getAttribute("Target")));
    let sheets = tags(wb, "sheet").map((s) => {
      const rid = s.getAttribute("r:id") || Array.from(s.attributes).filter((a) => a.localName === "id" && a.prefix).map((a) => a.value)[0];
      let t = target[rid] || "";
      t = t.replace(/^\//, "");
      if (t && !t.startsWith("xl/")) t = "xl/" + t;
      return { name: s.getAttribute("name"), path: t };
    }).filter((s) => s.path);
    if (!sheets.length) sheets = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNum).map((p, i) => ({ name: "시트 " + (i + 1), path: p }));
    const colNo = (ref) => {
      const m = /^([A-Z]+)/.exec(ref || "");
      if (!m) return 0;
      return m[1].split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    };
    let html = "";
    for (const sh of sheets.slice(0, 12)) {
      const doc = xml(await zip.text(sh.path));
      const grid = [];
      tags(doc, "row").slice(0, 300).forEach((row) => {
        const r = [];
        tags(row, "c").forEach((c, i) => {
          const col = c.getAttribute("r") ? colNo(c.getAttribute("r")) : i;
          if (col > 40) return;
          const t = c.getAttribute("t");
          const v = tags(c, "v")[0];
          let val = "";
          if (t === "s") val = shared[Number(v && v.textContent)] || "";
          else if (t === "inlineStr") val = tags(c, "t").map((x) => x.textContent).join("");
          else if (t === "b") val = v && v.textContent === "1" ? "TRUE" : "FALSE";
          else val = v ? v.textContent : "";
          if (t !== "s" && t !== "inlineStr" && t !== "str" && val !== "" && !isNaN(val) && /\./.test(val)) val = String(Math.round(Number(val) * 10000) / 10000);
          r[col] = val;
        });
        if (r.some((x) => x != null && x !== "")) grid.push(r);
      });
      const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
      html += "<h4>" + esc(sh.name) + "</h4>" + (grid.length ? tableHtml(grid.map((r) => Array.from({ length: width }, (_, i) => r[i] == null ? "" : r[i]))) : '<p class="mm-empty">빈 시트</p>');
    }
    return html || '<p class="mm-empty">시트를 찾지 못했습니다.</p>';
  }
  // 미리보기 HTML (글자·표). 못 읽는 형식이면 null
  async function previewHtml(file) {
    const e = ext(file.name);
    const blob = await K.files.blob(file);
    if (!blob) throw new Error("파일을 찾을 수 없습니다.");
    if (e === "csv") return tableHtml(K.parseCsv(await blob.text()).slice(0, 500));
    if (e === "txt" || e === "md" || /^text\//.test(file.type || "")) return '<pre class="mp-pre">' + esc(await blob.text()) + "</pre>";
    if (e === "pptx" || e === "ppsx") return previewPptx(await unzip(blob));
    if (e === "docx") return previewDocx(await unzip(blob));
    if (e === "xlsx" || e === "xlsm") return previewXlsx(await unzip(blob));
    return null;
  }

  /* ---------- 발표 화면 ---------- */
  let stage = null;
  function openStage(slides, start, mode) {
    if (!slides.length) return;
    closeStage();
    const decks = Array.from(new Set(slides.map((s) => s.deck)));
    const el = document.createElement("div");
    el.className = "mm-stage";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "발표 화면");
    el.tabIndex = -1;
    el.innerHTML =
      '<div class="mm-stage__bar"><div class="mm-stage__who"><strong data-s="who"></strong><span class="mm-stage__dept" data-s="dept"></span></div>' +
      '<div class="mm-stage__title" data-s="title"></div><div class="mm-stage__tools">' +
      '<div class="segmented mm-modes" role="tablist" aria-label="보기 방식"><button type="button" class="segmented__btn" data-mode="raw">원본</button><button type="button" class="segmented__btn" data-mode="preview">미리보기</button></div>' +
      '<span class="mm-stage__count" data-s="count"></span>' +
      '<button type="button" class="btn btn--sm" data-act="full" title="전체화면 (F)">전체화면</button>' +
      '<button type="button" class="btn mm-stage__close" data-act="close">닫기 (Esc)</button></div></div>' +
      (decks.length > 1 ? '<div class="mm-stage__sections" role="tablist" aria-label="발표자">' + decks.map((d, i) =>
        '<button type="button" class="mm-sectiontab" data-sec="' + i + '">' + (i + 1) + ". " + esc(d.presenter || "발표자") + (d.title ? " · " + esc(d.title) : "") + "</button>").join("") + "</div>" : "") +
      '<div class="mm-stage__body" data-s="body"></div>' +
      '<div class="mm-stage__foot"><button type="button" class="mm-nav" data-act="prev" aria-label="이전 자료"><span class="mm-nav__arrow">‹</span><span class="mm-nav__label">이전</span></button>' +
      '<a class="btn mm-foot__open" data-s="open" href="#">파일 받기</a>' +
      '<button type="button" class="mm-nav" data-act="next" aria-label="다음 자료"><span class="mm-nav__label">다음</span><span class="mm-nav__arrow">›</span></button></div>';
    document.body.appendChild(el);
    document.body.classList.add("mm-locked");
    stage = { el, slides, decks, i: Math.max(0, Math.min(start || 0, slides.length - 1)), mode: mode || "raw", urls: [], token: 0, returnFocus: document.activeElement };
    el.addEventListener("click", onStageClick);
    showSlide();
    el.focus();
    if (!mode || mode === "raw") enterFullscreen();
  }
  function enterFullscreen() {
    const el = stage && stage.el;
    if (!el || document.fullscreenElement || !el.requestFullscreen) return;
    el.requestFullscreen().catch(() => {});
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else enterFullscreen();
  }
  function revokeAll() {
    if (!stage) return;
    stage.urls.forEach((u) => URL.revokeObjectURL(u));
    stage.urls = [];
  }
  function closeStage() {
    if (!stage) return;
    revokeAll();
    const back = stage.returnFocus;
    stage.el.remove();
    stage = null;
    document.body.classList.remove("mm-locked");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (back && document.contains(back)) back.focus();
  }
  function go(delta) {
    if (!stage) return;
    const j = stage.i + delta;
    if (j < 0 || j >= stage.slides.length) return;
    stage.i = j;
    showSlide();
  }
  function onStageClick(e) {
    const act = e.target.closest("[data-act]");
    if (act) {
      const a = act.getAttribute("data-act");
      if (a === "close") closeStage();
      else if (a === "prev") go(-1);
      else if (a === "next") go(1);
      else if (a === "full") toggleFullscreen();
      else if (a === "to-preview") {
        stage.mode = "preview";
        showSlide();
      } else if (a === "download") {
        const s = stage.slides[stage.i];
        if (s.file) K.files.download(s.file);
      }
      return;
    }
    const m = e.target.closest("[data-mode]");
    if (m) {
      stage.mode = m.getAttribute("data-mode");
      showSlide();
      return;
    }
    const sec = e.target.closest("[data-sec]");
    if (sec) {
      const deck = stage.decks[Number(sec.getAttribute("data-sec"))];
      stage.i = stage.slides.findIndex((s) => s.deck === deck);
      showSlide();
      return;
    }
    const open = e.target.closest('[data-s="open"]');
    if (open && open.getAttribute("href") === "#") {
      e.preventDefault();
      const s = stage.slides[stage.i];
      if (s.file) K.files.download(s.file);
    }
  }
  function fallbackHtml(msg, withPreview) {
    return '<div class="mm-fallback"><p>' + msg + '</p><div class="mm-fallback__actions">' +
      (withPreview ? '<button type="button" class="btn btn--primary" data-act="to-preview">미리보기로 보기</button>' : "") +
      '<button type="button" class="btn btn--ghost" data-act="download">파일 받기</button></div></div>';
  }
  async function showSlide() {
    const st = stage;
    if (!st) return;
    const s = st.slides[st.i];
    const token = ++st.token;
    revokeAll();
    const q = (k) => $('[data-s="' + k + '"]', st.el);
    q("who").textContent = s.deck.presenter || "발표자 미정";
    q("dept").textContent = s.deck.dept || "";
    q("title").textContent = [s.deck.title, s.file ? s.file.name : linkName(s.link)].filter(Boolean).join(" · ");
    q("count").textContent = st.i + 1 + " / " + st.slides.length;
    $$("[data-mode]", st.el).forEach((b) => b.classList.toggle("is-active", b.getAttribute("data-mode") === st.mode));
    $$("[data-sec]", st.el).forEach((b) => b.classList.toggle("is-active", st.decks[Number(b.getAttribute("data-sec"))] === s.deck));
    const act = $(".mm-sectiontab.is-active", st.el);
    if (act && act.scrollIntoView) act.scrollIntoView({ block: "nearest", inline: "nearest" });
    $('[data-act="prev"]', st.el).disabled = st.i === 0;
    $('[data-act="next"]', st.el).disabled = st.i === st.slides.length - 1;
    const open = q("open");
    const body = q("body");
    if (s.link) {
      open.textContent = "새 창에서 열기";
      open.href = safeUrl(s.link.url);
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      body.innerHTML = '<div class="mm-doc"><div class="mm-linkbar"><span class="mm-linkbar__note">외부 링크 자료입니다. 사이트에 따라 이 화면 안에서 보이지 않을 수 있습니다 — 그럴 때는 아래 <strong>새 창에서 열기</strong>를 누르세요.</span>' +
        '<span class="mm-linkbar__when">' + esc(K.isoKst(s.deck.createdAt || "")) + "</span></div>" +
        '<iframe class="mm-frame" src="' + esc(safeUrl(s.link.url)) + '" title="링크 자료" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe></div>';
      return;
    }
    open.textContent = "파일 받기";
    open.href = "#";
    open.removeAttribute("target");
    const file = s.file;
    const kind = s.kind;
    body.innerHTML = '<div class="mm-loading">불러오는 중…</div>';
    try {
      if (st.mode === "raw" && (kind === "pdf" || kind === "image")) {
        const got = await K.files.url(file);
        if (token !== st.token || stage !== st) {
          if (got && got.revoke) URL.revokeObjectURL(got.url);
          return;
        }
        if (!got) throw new Error("파일을 찾을 수 없습니다.");
        if (got.revoke) st.urls.push(got.url);
        body.innerHTML = kind === "pdf"
          ? '<iframe class="mm-frame" src="' + esc(got.url) + '#view=Fit" title="' + esc(file.name) + '"></iframe>'
          : '<img class="mm-shot" src="' + esc(got.url) + '" alt="' + esc(file.name) + '">';
        return;
      }
      if (kind === "image") {
        // 미리보기에서도 그림은 그대로 (긴 그림은 스크롤)
        const got = await K.files.url(file);
        if (token !== st.token || stage !== st) return;
        if (!got) throw new Error("파일을 찾을 수 없습니다.");
        if (got.revoke) st.urls.push(got.url);
        body.innerHTML = '<div class="mm-pageshot"><img class="mm-pageshot__img" src="' + esc(got.url) + '" alt="' + esc(file.name) + '"></div>';
        return;
      }
      if (kind === "pdf") {
        body.innerHTML = fallbackHtml("PDF 는 <strong>원본</strong> 보기에서 그대로 넘겨 볼 수 있습니다.", false);
        return;
      }
      if (st.mode === "raw" && !["csv", "txt", "md"].includes(ext(file.name))) {
        const canPreview = ["pptx", "ppsx", "docx", "xlsx", "xlsm"].includes(ext(file.name));
        body.innerHTML = fallbackHtml(
          esc(kindLabel(kind, file)) + " 파일은 브라우저에서 원본 그대로 열 수 없습니다." +
            (canPreview ? "<br><strong>미리보기</strong>로 글자·표를 보거나, 파일을 받아 프로그램에서 여세요." : "<br>파일을 받아 프로그램에서 여세요. 원본 그대로 발표하려면 PDF 로 저장해 올려 주세요."),
          canPreview
        );
        return;
      }
      const html = await previewHtml(file);
      if (token !== st.token || stage !== st) return;
      body.innerHTML = html == null
        ? fallbackHtml("이 형식은 미리보기를 지원하지 않습니다. 파일을 받아 프로그램에서 여세요.", false)
        : '<div class="mm-doc"><div class="mm-doc__body">' + html + "</div></div>";
    } catch (err) {
      if (token !== st.token || stage !== st) return;
      body.innerHTML = fallbackHtml("자료를 열지 못했습니다: " + esc(err.message), false);
    }
  }
  document.addEventListener("keydown", (e) => {
    if (!stage || K.isModalOpen()) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) {
      e.preventDefault();
      go(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(-stage.i);
    } else if (e.key === "End") {
      e.preventDefault();
      go(stage.slides.length - 1 - stage.i);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeStage();
    } else if (e.key === "f" || e.key === "F") {
      toggleFullscreen();
    }
  });

  // 자료 하나부터 발표 화면 열기 (오늘 탭: 그 날 전체, 지난 자료: 그 날 전체)
  function playFrom(deckId, idx, mode) {
    const deck = items.find((x) => x.id === deckId);
    if (!deck) return;
    const slides = slidesOf(decksOn(deck.date));
    const start = slides.findIndex((s) => s.deck.id === deckId && String(s.index) === String(idx));
    openStage(slides, Math.max(0, start), mode);
  }

  /* ---------- 그리기 ---------- */
  function render() {
    if (state.view === "today") renderToday();
    else if (state.view === "archive") renderArchive();
  }

  /* ---------- 이벤트 ---------- */
  $("#mm-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (b) setView(b.getAttribute("data-view"));
  });
  $("#mm-date").addEventListener("change", () => {
    if (K.parse($("#mm-date").value)) state.date = $("#mm-date").value;
    render();
  });
  $("#mm-day-prev").addEventListener("click", () => {
    state.date = K.addDays(state.date, -1);
    render();
  });
  $("#mm-day-next").addEventListener("click", () => {
    state.date = K.addDays(state.date, 1);
    render();
  });
  $("#mm-day-today").addEventListener("click", () => {
    state.date = K.today();
    render();
  });
  $("#mm-start").addEventListener("click", () => openStage(slidesOf(decksOn(state.date)), 0, "raw"));
  $("#mm-q").addEventListener("input", () => {
    state.q = $("#mm-q").value;
    renderArchive();
  });
  $("#mm-range").value = state.range;
  $("#mm-range").addEventListener("change", () => {
    state.range = $("#mm-range").value;
    K.prefs.set("mm.range", state.range);
    renderArchive();
  });
  $(".page").addEventListener("click", async (e) => {
    const play = e.target.closest("[data-play]");
    if (play) return playFrom(play.getAttribute("data-play"), play.getAttribute("data-i"), "raw");
    const pv = e.target.closest("[data-preview]");
    if (pv) return playFrom(pv.getAttribute("data-preview"), pv.getAttribute("data-i"), "preview");
    const dn = e.target.closest("[data-down]");
    if (dn) {
      e.preventDefault();
      const deck = items.find((x) => x.id === dn.getAttribute("data-down"));
      const f = deck && (deck.files || [])[Number(dn.getAttribute("data-i"))];
      if (f) K.files.download(f);
      return;
    }
    const day = e.target.closest("[data-open-day]");
    if (day) {
      state.date = day.getAttribute("data-open-day");
      return setView("today");
    }
    const holder = e.target.closest("[data-id]");
    const deck = holder && items.find((x) => x.id === holder.getAttribute("data-id"));
    if (!deck || !canWrite) return;
    const mv = e.target.closest("[data-move]");
    if (mv) return moveDeck(deck.id, Number(mv.getAttribute("data-move")));
    if (e.target.closest("[data-edit]")) return openEditor(deck);
    if (e.target.closest("[data-del]")) return removeDeck(deck);
  });
  setupDrag();

  /* ---------- 시작 ---------- */
  async function load() {
    try {
      items = await store.list();
    } catch (err) {
      K.toast("불러오지 못했습니다: " + err.message, true);
      items = [];
    }
    people = [];
    items.forEach((d) => {
      if (d.presenter && !people.some((p) => p.name === d.presenter)) people.push({ name: d.presenter, dept: d.dept || "" });
    });
    render();
  }

  K.session().then(async (s) => {
    if (s.server && s.me) canWrite = s.me.role === "admin" || s.me.role === "super";
    const upTab = $('#mm-tabs [data-view="upload"]');
    upTab.hidden = !canWrite;
    const badge = $(".mm-badge");
    if (badge) badge.textContent = canWrite ? "관리자 전용" : "보기 전용";
    if (badge) badge.title = "자료 올리기·고치기·삭제는 관리자만 할 수 있습니다.";
    if (!canWrite) $("#mm-today-empty-text").textContent = "관리자가 발표 자료를 올리면 여기에 보입니다.";
    if (canWrite) setupUploadForm();
    const params = new URLSearchParams(location.search);
    if (K.parse(params.get("date") || "")) state.date = params.get("date");
    await load();
    if (s.server) {
      s.api("GET", "/api/users/names").then((list) => {
        (list || []).forEach((u) => {
          const name = u.displayName || u.username;
          if (!people.some((p) => p.name === name)) people.push({ name, dept: u.department || "" });
        });
        drawPeople();
      }).catch(() => {});
    }
    drawPeople();
    const h = location.hash.replace("#", "");
    setView(["upload", "archive"].includes(h) ? h : "today");
  });
  window.addEventListener("hashchange", () => {
    const h = location.hash.replace("#", "");
    setView(["upload", "archive"].includes(h) ? h : "today");
  });
  function drawPeople() {
    let dl = $("#mm-people");
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = "mm-people";
      document.body.appendChild(dl);
    }
    dl.innerHTML = people.map((p) => '<option value="' + esc(p.name) + '">' + esc(p.dept) + "</option>").join("");
  }
})();
