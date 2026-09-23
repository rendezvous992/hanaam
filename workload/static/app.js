/* 워크로드: 업무 카드 보드 (상태별·담당자별), 끌어서 상태 바꾸기, 추가·수정·삭제 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc, toast } = K;

  const cards = K.collection("workload");
  const STATUS = [
    ["todo", "할 일"],
    ["doing", "진행 중"],
    ["hold", "대기·보류"],
    ["done", "완료"],
  ];
  const STATUS_LABEL = Object.fromEntries(STATUS);
  let view = K.prefs.get("workload.view", "status");
  let people = [];
  let canEdit = true;

  function dueClass(c) {
    if (!c.due || c.status === "done") return "";
    const d = K.diffDays(K.today(), c.due);
    return d < 0 ? "is-late" : d <= 2 ? "is-soon" : "";
  }
  function dueText(c) {
    if (!c.due) return "";
    const d = K.diffDays(K.today(), c.due);
    const tail = c.status === "done" ? "" : d < 0 ? " (" + -d + "일 지남)" : d === 0 ? " (오늘)" : d <= 7 ? " (D-" + d + ")" : "";
    return "마감 " + K.md(c.due) + tail;
  }

  function filtered() {
    const q = $("#wl-q").value.trim().toLowerCase();
    const owner = $("#wl-owner").value;
    const showOld = $("#wl-done").checked;
    const cutoff = K.addDays(K.today(), -30);
    return cards.cached().filter((c) => {
      if (owner && (c.owner || "") !== owner) return false;
      if (!showOld && c.status === "done" && (c.doneAt || c.updatedAt || "").slice(0, 10) < cutoff) return false;
      if (q && ![c.title, c.company, c.memo, c.owner].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
  }
  const order = (a, b) => (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1) || String(a.due || "9999").localeCompare(String(b.due || "9999")) || String(a.createdAt).localeCompare(String(b.createdAt));

  function cardHtml(c) {
    return (
      '<article class="wl-card" draggable="' + canEdit + '" data-id="' + esc(c.id) + '" data-status="' + esc(c.status || "todo") + '" tabindex="0">' +
      '<p class="wl-card__title">' + (c.priority === "high" ? '<span class="wl-card__pri">!</span> ' : "") + esc(c.title) + "</p>" +
      '<div class="wl-card__meta">' +
      (view === "status" ? "<span>" + esc(c.owner || "담당자 없음") + "</span>" : "<span>" + esc(STATUS_LABEL[c.status] || "할 일") + "</span>") +
      (c.company ? '<span class="wl-card__tag">' + esc(c.company) + "</span>" : "") +
      (c.due ? '<span class="wl-card__due ' + dueClass(c) + '">' + esc(dueText(c)) + "</span>" : "") +
      "</div></article>"
    );
  }

  function render() {
    const list = filtered().sort(order);
    const board = $("#wl-board");
    let cols;
    if (view === "owner") {
      const names = Array.from(new Set(list.map((c) => c.owner || "").concat($("#wl-owner").value ? [] : people))).sort((a, b) => (a || "힣").localeCompare(b || "힣", "ko"));
      cols = names.map((n) => ({ key: n, label: n || "담당자 없음", items: list.filter((c) => (c.owner || "") === n) }));
    } else {
      cols = STATUS.map(([k, label]) => ({ key: k, label, items: list.filter((c) => (c.status || "todo") === k) }));
    }
    board.innerHTML = cols.length
      ? cols.map((col) =>
          '<section class="wl-col" data-col="' + esc(col.key) + '"><div class="wl-col__head">' + esc(col.label) + " <span>" + col.items.length + "</span></div>" +
          (col.items.length ? col.items.map(cardHtml).join("") : '<div class="wl-empty">카드 없음</div>') + "</section>"
        ).join("")
      : '<div class="wl-empty">업무 카드가 없습니다. <b>+ 업무 카드</b>로 추가하세요.</div>';
    const all = cards.cached();
    const open = all.filter((c) => c.status !== "done");
    const late = open.filter((c) => c.due && c.due < K.today());
    $("#wl-summary").innerHTML =
      '<span class="wl-chip">진행 전·중 <b>' + open.length + "</b></span>" +
      '<span class="wl-chip">이번 주 마감 <b>' + open.filter((c) => c.due && c.due >= K.today() && c.due <= K.addDays(K.startOfWeek(K.today(), true), 6)).length + "</b></span>" +
      (late.length ? '<span class="wl-chip wl-chip--late">마감 지남 <b>' + late.length + "</b></span>" : "") +
      '<span class="wl-chip">완료 <b>' + (all.length - open.length) + "</b></span>";
    $$(".wl-view__btn").forEach((b) => b.classList.toggle("is-active", b.getAttribute("data-view") === view));
  }

  function renderOwners() {
    const sel = $("#wl-owner");
    const cur = sel.value;
    const names = Array.from(new Set(people.concat(cards.cached().map((c) => c.owner).filter(Boolean)))).sort((a, b) => a.localeCompare(b, "ko"));
    sel.innerHTML = '<option value="">담당자 전체</option>' + names.map((n) => '<option value="' + esc(n) + '"' + (n === cur ? " selected" : "") + ">" + esc(n) + "</option>").join("");
  }

  function openEditor(card, preset) {
    const c = Object.assign({ status: "todo", priority: "normal", owner: K.currentUser() }, preset || {}, card || {});
    const names = Array.from(new Set(people.concat(c.owner ? [c.owner] : [])));
    const ctx = K.modal({
      title: card ? "업무 카드 수정" : "업무 카드 추가",
      focus: 'input[name="title"]',
      html:
        '<form class="modal__body" novalidate><div class="wl-form">' +
        '<label class="field field--full"><span class="field__label">제목</span><input class="input" name="title" maxlength="120" required value="' + esc(c.title || "") + '"></label>' +
        '<label class="field"><span class="field__label">담당자</span><input class="input" name="owner" list="wl-people" maxlength="40" value="' + esc(c.owner || "") + '"><datalist id="wl-people">' + names.map((n) => '<option value="' + esc(n) + '">').join("") + "</datalist></label>" +
        '<label class="field"><span class="field__label">상태</span><select class="input" name="status">' + STATUS.map(([k, l]) => '<option value="' + k + '"' + (c.status === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>" +
        '<label class="field"><span class="field__label">관련 기업 (선택)</span><input class="input" name="company" maxlength="60" value="' + esc(c.company || "") + '"></label>' +
        '<label class="field"><span class="field__label">마감일 (선택)</span><input class="input" type="date" name="due" value="' + esc(c.due || "") + '"></label>' +
        '<label class="field"><span class="field__label">중요도</span><select class="input" name="priority"><option value="normal">보통</option><option value="high"' + (c.priority === "high" ? " selected" : "") + ">높음</option></select></label>" +
        '<label class="field field--full"><span class="field__label">메모</span><textarea class="input" name="memo" maxlength="4000">' + esc(c.memo || "") + "</textarea></label>" +
        "</div>" +
        '<div class="modal__footer">' + (card ? '<button type="button" class="btn btn--danger" data-del>삭제</button>' : "") +
        '<div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-cancel>취소</button><button type="submit" class="btn btn--primary">저장</button></div></div></form>',
    });
    const form = $("form", ctx.modal);
    $("[data-cancel]", ctx.modal).addEventListener("click", () => ctx.close());
    const del = $("[data-del]", ctx.modal);
    if (del) {
      del.addEventListener("click", async () => {
        if (!(await K.confirm("'" + card.title + "' 카드를 삭제할까요?", "삭제", true))) return;
        try {
          await cards.remove(card.id);
          ctx.close(true);
          toast("삭제했습니다.");
          renderOwners();
          render();
        } catch (err) {
          toast(err.message, true);
        }
      });
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements;
      const data = { title: f.title.value.trim(), owner: f.owner.value.trim(), status: f.status.value, company: f.company.value.trim(), due: f.due.value, priority: f.priority.value, memo: f.memo.value.trim() };
      if (!data.title) return toast("제목을 적어 주세요.", true);
      if (data.status === "done" && (!card || card.status !== "done")) data.doneAt = new Date().toISOString();
      try {
        if (card) await cards.update(card.id, data);
        else await cards.create(data);
        ctx.close(true);
        toast("저장했습니다.");
        renderOwners();
        render();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  /* 끌어서 옮기기 */
  const board = $("#wl-board");
  let dragId = null;
  board.addEventListener("dragstart", (e) => {
    const el = e.target.closest(".wl-card");
    if (!el || !canEdit) return;
    dragId = el.getAttribute("data-id");
    el.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragId);
  });
  board.addEventListener("dragend", (e) => {
    const el = e.target.closest(".wl-card");
    if (el) el.classList.remove("is-dragging");
    $$(".wl-col.is-over").forEach((c) => c.classList.remove("is-over"));
  });
  board.addEventListener("dragover", (e) => {
    const col = e.target.closest(".wl-col");
    if (!col || !dragId) return;
    e.preventDefault();
    $$(".wl-col.is-over").forEach((c) => c !== col && c.classList.remove("is-over"));
    col.classList.add("is-over");
  });
  board.addEventListener("drop", async (e) => {
    const col = e.target.closest(".wl-col");
    if (!col || !dragId) return;
    e.preventDefault();
    col.classList.remove("is-over");
    const id = dragId;
    dragId = null;
    const c = cards.cached().find((x) => x.id === id);
    if (!c) return;
    const key = col.getAttribute("data-col");
    const patch = view === "owner" ? { owner: key } : { status: key };
    if (view === "status" && key === "done" && c.status !== "done") patch.doneAt = new Date().toISOString();
    if ((view === "owner" ? c.owner || "" : c.status || "todo") === key) return;
    try {
      await cards.update(id, patch);
      render();
    } catch (err) {
      toast(err.message, true);
    }
  });
  board.addEventListener("click", (e) => {
    const el = e.target.closest(".wl-card");
    if (!el) return;
    const c = cards.cached().find((x) => x.id === el.getAttribute("data-id"));
    if (c) openEditor(c);
  });
  board.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const el = e.target.closest(".wl-card");
    if (el) el.click();
  });

  $("#wl-add").addEventListener("click", () => openEditor(null, view === "status" ? {} : {}));
  $("#wl-q").addEventListener("input", render);
  $("#wl-owner").addEventListener("change", render);
  $("#wl-done").addEventListener("change", render);
  $$(".wl-view__btn").forEach((b) =>
    b.addEventListener("click", () => {
      view = b.getAttribute("data-view");
      K.prefs.set("workload.view", view);
      render();
    })
  );

  K.session().then(async (s) => {
    if (s.server) {
      canEdit = (s.me.permissions || []).includes("workload");
      $("#wl-add").hidden = !canEdit;
      people = await s.api("GET", "/api/users/names").then((l) => l.map((u) => u.displayName)).catch(() => []);
    } else {
      people = [K.currentUser()];
    }
    try {
      await cards.list();
    } catch (err) {
      toast(err.message, true);
    }
    const me = s.server ? s.me.displayName : "";
    if (me && K.prefs.get("workload.mineFirst", false)) $("#wl-owner").value = me;
    renderOwners();
    render();
    if (new URLSearchParams(location.search).get("new") === "1" && canEdit) openEditor(null);
  });
})();
