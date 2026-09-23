/* 개선요청 — 요청 남기기(익명·첨부), 상태 갈래·분류·검색, 처리 메모·상태 변경(처리 권한자), 본인 글 수정·삭제 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const store = K.collection("requests");

  const CATS = { bug: "오류", feature: "기능추가", improve: "개선", design: "디자인", etc: "기타" };
  const STATUS = { received: "접수", doing: "수정중", done: "완료", rejected: "반려" };
  const MAX_FILE = 10 * 1024 * 1024;

  let items = [];
  let me = null;
  let server = false;
  let canHandle = true; // 상태·처리 메모를 바꿀 수 있는 사람
  const open = new Set();
  const thumbs = new Map(); // 파일 id → 그림 주소
  const state = {
    status: "all",
    cat: K.prefs.get("req.cat", "all"),
    q: "",
  };

  /* ---------- 권한 ---------- */
  function isMine(it) {
    if (!server) return true;
    return !!me && it.createdById === me.id;
  }
  function isAdmin() {
    return !server || (me && (me.role === "admin" || me.role === "super"));
  }
  function canDelete(it) {
    return isMine(it) || canHandle || isAdmin();
  }

  /* ---------- 거르기 ---------- */
  function matches(it, q) {
    if (!q) return true;
    const hay = [it.title, it.body, it.reply, CATS[it.category], it.anonymous ? "" : it.createdBy].concat((it.files || []).map((f) => f.name)).join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  function base() {
    const q = state.q.trim();
    return items.filter((it) => (state.cat === "all" || (it.category || "etc") === state.cat) && matches(it, q));
  }
  function statusOf(it) {
    return STATUS[it.status] ? it.status : "received";
  }
  const isImage = (f) => /^image\//.test(f.type || "") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || "");

  /* ---------- 그리기 ---------- */
  function cardHtml(it) {
    const st = statusOf(it);
    const cat = CATS[it.category] ? it.category : "etc";
    const files = it.files || [];
    const isOpen = open.has(it.id);
    const author = it.anonymous
      ? '<span class="req-card__author req-card__author--anon">익명</span>'
      : '<span class="req-card__author">' + esc(it.createdBy || "이름 없음") + "</span>";
    const statusCtl = canHandle
      ? '<select class="input req-status-select req-status--' + st + '" data-status-select aria-label="처리 상태">' +
        Object.keys(STATUS).map((k) => '<option value="' + k + '"' + (k === st ? " selected" : "") + ">" + STATUS[k] + "</option>").join("") + "</select>"
      : '<span class="req-badge req-status--' + st + '">' + STATUS[st] + "</span>";
    let html =
      '<article class="req-card req-card--' + st + '" data-id="' + esc(it.id) + '">' +
      '<div class="req-card__head" data-toggle role="button" tabindex="0" aria-expanded="' + isOpen + '">' +
      '<div class="req-card__titles"><div class="req-card__line">' +
      '<span class="req-chip req-chip--cat req-chip--' + cat + '">' + CATS[cat] + "</span>" +
      '<strong class="req-card__title">' + esc(it.title || "(제목 없음)") + "</strong>" +
      (isMine(it) && server ? '<span class="req-chip req-chip--mine">내 글</span>' : "") +
      (it.reply && it.reply.trim() ? '<span class="req-chip req-chip--reply">처리 메모</span>' : "") +
      (files.length ? '<span class="req-chip req-chip--files">첨부 ' + files.length + "</span>" : "") +
      "</div>" +
      '<div class="req-card__meta">' + author + '<span class="req-card__when">' + esc(K.isoKst(it.createdAt || "")) + "</span>" +
      (it.editedAt ? '<span class="req-card__edited">(고침 ' + esc(K.isoKst(it.editedAt)) + ")</span>" : "") + "</div></div>" +
      '<div class="req-card__actions">' + statusCtl +
      (isMine(it) ? '<button type="button" class="btn btn--ghost btn--sm" data-edit>수정</button>' : "") +
      (canDelete(it) ? '<button type="button" class="btn btn--ghost btn--sm req-card__delete" data-del>삭제</button>' : "") +
      "</div></div>";
    if (isOpen) {
      html += '<div class="req-card__detail">' +
        (it.body && it.body.trim() ? '<pre class="req-card__text">' + esc(it.body) + "</pre>" : '<p class="req-card__text req-card__text--empty">내용 없이 제목만 남긴 요청입니다.</p>');
      if (files.length) {
        const imgs = files.map((f, i) => [f, i]).filter(([f]) => isImage(f));
        const others = files.map((f, i) => [f, i]).filter(([f]) => !isImage(f));
        html += '<div class="req-files"><span class="req-files__head">첨부 ' + files.length + "개</span>" +
          (imgs.length ? '<div class="req-files__images">' + imgs.map(([f, i]) =>
            '<a class="req-files__shot" href="#" data-view="' + i + '" title="' + esc(f.name) + ' 크게 보기"><img class="req-files__thumb" data-thumb="' + i + '" alt="' + esc(f.name) + '"></a>').join("") + "</div>" : "") +
          others.map(([f, i]) => '<a class="req-file" href="#" data-file="' + i + '">📎 ' + esc(f.name) + '<span class="req-file__size">' + esc(K.fileSize(f.size)) + "</span></a>").join("") +
          "</div>";
      }
      const hasReply = it.reply && it.reply.trim();
      if (hasReply || canHandle) {
        html += '<div class="req-reply"><span class="req-reply__head">처리 메모' + (it.replyBy ? " · " + esc(it.replyBy) : "") + (it.replyAt ? " · " + esc(K.isoKst(it.replyAt)) : "") + "</span>" +
          (canHandle
            ? '<textarea class="input input--textarea req-reply__input" data-reply-input rows="3" placeholder="어떻게 처리했는지, 반려했다면 이유를 적어 주세요.">' + esc(it.reply || "") + "</textarea>" +
              '<button type="button" class="btn btn--primary btn--sm" data-reply-save>메모 저장</button>'
            : '<p class="req-reply__text">' + esc(it.reply) + "</p>") +
          "</div>";
      }
      html += "</div>";
    }
    return html + "</article>";
  }

  function render() {
    const list = base();
    $("#req-total").textContent = String(items.length);
    const counts = { all: list.length };
    Object.keys(STATUS).forEach((k) => (counts[k] = list.filter((it) => statusOf(it) === k).length));
    $$("[data-count]").forEach((el) => (el.textContent = String(counts[el.getAttribute("data-count")] || 0)));
    $$("#req-status-tabs .req-tab").forEach((b) => {
      const on = b.getAttribute("data-status") === state.status;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    const shown = list.filter((it) => state.status === "all" || statusOf(it) === state.status)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    $("#req-list").innerHTML = shown.map(cardHtml).join("");
    const empty = $("#req-empty");
    empty.hidden = shown.length > 0;
    empty.textContent = !items.length
      ? "아직 등록된 요청이 없습니다. 불편한 점이 있으면 첫 요청을 남겨 주세요."
      : "조건에 맞는 요청이 없습니다." + (state.q.trim() ? " 검색어를 바꿔 보세요." : "");
    loadThumbs();
  }

  // 펼친 글의 그림 미리보기 주소 채우기
  function loadThumbs() {
    $$("[data-thumb]").forEach(async (img) => {
      const card = img.closest("[data-id]");
      const it = items.find((x) => x.id === card.getAttribute("data-id"));
      const f = it && (it.files || [])[Number(img.getAttribute("data-thumb"))];
      if (!f) return;
      if (!thumbs.has(f.id)) thumbs.set(f.id, K.files.url(f).then((u) => (u ? u.url : "")).catch(() => ""));
      const url = await thumbs.get(f.id);
      if (url) img.src = url;
      else img.alt = f.name + " (파일을 찾을 수 없습니다)";
    });
  }

  function viewImage(f) {
    const ctx = K.modal({ title: f.name, size: "modal--wide", html: '<div class="modal__body"><img class="req-view__img" alt="' + esc(f.name) + '"><div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-act="down">내려받기</button><button type="button" class="btn btn--primary" data-act="close">닫기</button></div></div></div>' });
    if (!thumbs.has(f.id)) thumbs.set(f.id, K.files.url(f).then((u) => (u ? u.url : "")).catch(() => ""));
    thumbs.get(f.id).then((u) => {
      if (u) $(".req-view__img", ctx.modal).src = u;
    });
    $('[data-act="down"]', ctx.modal).addEventListener("click", () => K.files.download(f));
    $('[data-act="close"]', ctx.modal).addEventListener("click", () => ctx.close());
  }

  /* ---------- 요청 남기기·고치기 ---------- */
  function openEditor(existing) {
    const it = existing || { category: "bug", title: "", body: "", anonymous: false, files: [] };
    const keep = (it.files || []).slice();
    const fresh = [];
    const html =
      '<form class="modal__body" id="req-form" novalidate>' +
      '<div class="field-row"><label class="field"><span class="field__label">분류</span><select class="input" name="category">' +
      Object.keys(CATS).map((k) => '<option value="' + k + '"' + (k === (it.category || "etc") ? " selected" : "") + ">" + CATS[k] + "</option>").join("") + "</select></label><div></div></div>" +
      '<label class="field"><span class="field__label">제목 <em class="required">*</em></span><input class="input" name="title" maxlength="120" placeholder="예: 노트 검색에서 회사 이름이 안 찾아집니다" value="' + esc(it.title) + '"></label>' +
      '<label class="field"><span class="field__label">내용</span><textarea class="input input--textarea" name="body" rows="7" placeholder="어느 화면에서 무엇을 했을 때 어떻게 됐는지 적어 주시면 빨리 고칠 수 있습니다.">' + esc(it.body) + "</textarea></label>" +
      '<label class="field field--inline req-anon"><input type="checkbox" name="anonymous"' + (it.anonymous ? " checked" : "") + '><span><span class="req-anon__text">익명으로 남기기</span>' +
      '<span class="req-anon__hint">목록에 이름 대신 ‘익명’으로 보입니다. (본인은 계속 고치거나 지울 수 있습니다)</span></span></label>' +
      '<div class="field"><span class="field__label">첨부 이미지 <span class="hint">(선택 · 한 개 10MB까지)</span></span>' +
      '<div class="req-drop" data-drop><button type="button" class="btn btn--ghost btn--sm" data-pick>이미지 고르기</button><input type="file" name="files" accept="image/*" multiple hidden>' +
      '<span class="req-drop__hint">화면을 캡처해 이 창에 붙여넣기(Ctrl+V)하거나 여기로 끌어 놓아도 됩니다.</span></div>' +
      '<ul class="req-filelist" data-list></ul></div>' +
      '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-act="cancel">취소</button>' +
      '<button type="submit" class="btn btn--primary">' + (existing ? "저장" : "요청 남기기") + "</button></div></div></form>";
    let saving = false;
    const ctx = K.modal({ title: existing ? "요청 고치기" : "개선요청 남기기", size: "modal--wide", html, focus: '[name="title"]', beforeClose: () => !saving });
    const form = $("#req-form", ctx.modal);
    const f = (n) => form.elements[n];
    function draw() {
      $("[data-list]", form).innerHTML =
        keep.map((m, i) => '<li class="req-filelist__item"><span class="req-filelist__name">' + esc(m.name) + '</span><span class="req-filelist__size">' + esc(K.fileSize(m.size)) + '</span><button type="button" class="btn btn--ghost btn--sm req-filelist__action" data-rm-keep="' + i + '">빼기</button></li>').join("") +
        fresh.map((x, i) => '<li class="req-filelist__item req-filelist__item--new"><span class="req-filelist__name">' + esc(x.name) + '</span><span class="req-filelist__size" data-pct="' + i + '">' + esc(K.fileSize(x.size)) + '</span><button type="button" class="btn btn--ghost btn--sm req-filelist__action" data-rm-new="' + i + '">빼기</button></li>').join("");
    }
    function add(list) {
      Array.from(list || []).forEach((file) => {
        if (file.size > MAX_FILE) return K.toast(file.name + ": 10MB 를 넘는 파일은 올릴 수 없습니다.", true);
        // 붙여넣은 캡처는 이름이 image.png 로 같아서 시각을 붙인다
        let name = file.name || "capture.png";
        if (/^image\.(png|jpe?g)$/i.test(name)) name = "캡처-" + K.today() + "-" + K.nowTime().replace(":", "") + "-" + (fresh.length + 1) + "." + name.split(".").pop();
        fresh.push({ file, name, size: file.size });
      });
      draw();
    }
    draw();
    $("[data-pick]", form).addEventListener("click", () => f("files").click());
    f("files").addEventListener("change", () => {
      add(f("files").files);
      f("files").value = "";
    });
    const drop = $("[data-drop]", form);
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("is-over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("is-over");
      add(e.dataTransfer && e.dataTransfer.files);
    });
    ctx.modal.addEventListener("paste", (e) => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((x) => /^image\//.test(x.type));
      if (!files.length) return;
      e.preventDefault();
      add(files);
      K.toast("캡처 이미지를 붙였습니다.");
    });
    form.addEventListener("click", (e) => {
      const a = e.target.closest("[data-rm-keep]");
      if (a) {
        keep.splice(Number(a.getAttribute("data-rm-keep")), 1);
        return draw();
      }
      const b = e.target.closest("[data-rm-new]");
      if (b) {
        fresh.splice(Number(b.getAttribute("data-rm-new")), 1);
        return draw();
      }
      if (e.target.closest('[data-act="cancel"]')) ctx.close();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (saving) return;
      const data = { category: f("category").value, title: f("title").value.trim(), body: f("body").value.replace(/\s+$/, ""), anonymous: f("anonymous").checked };
      if (!data.title) return K.toast("제목을 입력해 주세요.", true), f("title").focus();
      saving = true;
      const submit = $('button[type="submit"]', form);
      submit.disabled = true;
      const uploaded = [];
      try {
        for (let i = 0; i < fresh.length; i++) {
          uploaded.push(await K.files.put(fresh[i].file, fresh[i].name, (p) => {
            const el = $('[data-pct="' + i + '"]', form);
            if (el) el.textContent = "올리는 중 " + Math.round(p * 100) + "%";
          }));
        }
        data.files = keep.concat(uploaded);
        let saved;
        if (existing) {
          data.editedAt = new Date().toISOString();
          saved = await store.update(existing.id, data);
          (existing.files || []).filter((m) => !data.files.some((k) => k.id === m.id)).forEach((m) => K.files.remove(m));
        } else {
          saved = await store.create(Object.assign(data, { status: "received", reply: "", replyBy: "", replyAt: "" }));
          state.status = "all";
        }
        items = store.cached();
        open.add(saved.id);
        saving = false;
        ctx.close(true);
        render();
        K.toast(existing ? "고쳤습니다." : "요청을 남겼습니다. 고마워요!");
      } catch (err) {
        uploaded.forEach((m) => K.files.remove(m));
        K.toast("저장하지 못했습니다: " + err.message, true);
      } finally {
        saving = false;
        submit.disabled = false;
      }
    });
  }

  async function removeItem(it) {
    if (!(await K.confirm("‘" + (it.title || "") + "’ 요청을 삭제할까요? 되돌릴 수 없습니다.", "삭제", true))) return;
    try {
      await store.remove(it.id);
      (it.files || []).forEach((m) => K.files.remove(m));
      items = store.cached();
      open.delete(it.id);
      render();
      K.toast("삭제했습니다.");
    } catch (err) {
      K.toast("삭제하지 못했습니다: " + err.message, true);
    }
  }

  async function setStatus(it, status, sel) {
    try {
      const patch = { status };
      if (!it.replyBy) patch.replyBy = me ? me.displayName || me.username : K.currentUser();
      await store.update(it.id, patch);
      items = store.cached();
      render();
      K.toast("‘" + STATUS[status] + "’(으)로 바꿨습니다.");
    } catch (err) {
      if (sel) sel.value = statusOf(it);
      K.toast("바꾸지 못했습니다: " + err.message, true);
    }
  }

  async function saveReply(it, text) {
    try {
      const patch = { reply: text.replace(/\s+$/, ""), replyBy: me ? me.displayName || me.username : K.currentUser(), replyAt: new Date().toISOString() };
      await store.update(it.id, patch);
      items = store.cached();
      render();
      K.toast("처리 메모를 저장했습니다.");
    } catch (err) {
      K.toast("저장하지 못했습니다: " + err.message, true);
    }
  }

  /* ---------- 이벤트 ---------- */
  $("#req-new").addEventListener("click", () => openEditor(null));
  $("#req-reload").addEventListener("click", () => load(true));
  $("#req-status-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-status]");
    if (!b) return;
    state.status = b.getAttribute("data-status");
    render();
  });
  $("#req-filter-category").value = CATS[state.cat] ? state.cat : "all";
  state.cat = $("#req-filter-category").value;
  $("#req-filter-category").addEventListener("change", () => {
    state.cat = $("#req-filter-category").value;
    K.prefs.set("req.cat", state.cat);
    render();
  });
  $("#req-q").addEventListener("input", () => {
    state.q = $("#req-q").value;
    render();
  });
  const list = $("#req-list");
  list.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-status-select]");
    if (!sel) return;
    const it = items.find((x) => x.id === sel.closest("[data-id]").getAttribute("data-id"));
    if (it) setStatus(it, sel.value, sel);
  });
  list.addEventListener("click", (e) => {
    const card = e.target.closest("[data-id]");
    const it = card && items.find((x) => x.id === card.getAttribute("data-id"));
    if (!it) return;
    if (e.target.closest("[data-status-select]")) return;
    if (e.target.closest("[data-edit]")) return openEditor(it);
    if (e.target.closest("[data-del]")) return removeItem(it);
    if (e.target.closest("[data-reply-save]")) return saveReply(it, $("[data-reply-input]", card).value);
    const v = e.target.closest("[data-view]");
    if (v) {
      e.preventDefault();
      return viewImage(it.files[Number(v.getAttribute("data-view"))]);
    }
    const fl = e.target.closest("[data-file]");
    if (fl) {
      e.preventDefault();
      return K.files.download(it.files[Number(fl.getAttribute("data-file"))]);
    }
    if (e.target.closest("[data-toggle]") && !e.target.closest("button, select, a, textarea")) {
      if (open.has(it.id)) open.delete(it.id);
      else open.add(it.id);
      render();
    }
  });
  list.addEventListener("keydown", (e) => {
    const head = e.target.closest("[data-toggle]");
    if (!head || e.target !== head || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    const id = head.closest("[data-id]").getAttribute("data-id");
    if (open.has(id)) open.delete(id);
    else open.add(id);
    render();
    const again = $('[data-id="' + CSS.escape(id) + '"] [data-toggle]');
    if (again) again.focus();
  });

  /* ---------- 시작 ---------- */
  async function load(user) {
    try {
      items = await store.list();
      if (user) K.toast("새로 불러왔습니다.");
    } catch (err) {
      K.toast("불러오지 못했습니다: " + err.message, true);
      items = [];
    }
    render();
  }
  render();
  K.session().then((s) => {
    server = !!s.server;
    me = s.me || null;
    if (server) canHandle = !!me && (me.role === "super" || (me.permissions || []).includes("requests"));
    const id = new URLSearchParams(location.search).get("id");
    if (id) open.add(id);
    load();
  });
})();
