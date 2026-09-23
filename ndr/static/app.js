/* 미확정 일정 — 여러 후보 시간(슬롯) 중 아직 고르지 않은 NDR. 슬롯을 확정하면 IR 캘린더에 올라간다. */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const store = K.collection("ndr-proposals");
  const calendar = K.irEvents();

  let items = [];
  let view = K.prefs.get("ndr.view", "calendar");
  const open = new Set();

  /* ---------- 화면 뼈대 ---------- */
  const actions = $(".topbar__actions");
  actions.insertAdjacentHTML("beforeend", '<button id="ndr-add" class="btn btn--primary btn--sm">+ 후보 등록</button>');
  const calBox = $("#ndr-calendar");
  const listBox = document.createElement("div");
  listBox.className = "ndr-list";
  listBox.id = "ndr-list";
  calBox.after(listBox);
  const guide = $(".ndr-guide");
  if (guide) {
    // 텔레그램 자동 수집은 이 사이트에 없으므로 안내를 바꾼다
    guide.innerHTML =
      "<li><strong>NDR 미확정 일정</strong>을 보여줍니다. 막대를 누르면 슬롯과 원문을 볼 수 있습니다.</li>" +
      "<li>증권사 안내문을 <em>+ 후보 등록</em>에 붙여넣으면 날짜·시간 후보를 찾아 슬롯으로 만듭니다.</li>" +
      "<li>참석할 시간이 정해지면 슬롯의 <em>확정</em>을 눌러 IR 캘린더에 올리고, 끝난 건은 <em>목록</em> 보기에서 <em>폐기</em>로 내립니다.</li>" +
      "<li>컨퍼런스콜·콥데이·오픈IR처럼 <em>고를 슬롯이 없는 안내</em>는 IR 캘린더에 바로 등록하세요.</li>";
  }

  /* ---------- 슬롯 찾기 ---------- */
  // "9/24(수) 10:00, 14:00~15:00", "2026-09-24 10:00", "9월 25일 오후 2시" 같은 표현에서 후보를 뽑는다
  function parseSlots(text) {
    const year = Number(K.today().slice(0, 4));
    const slots = [];
    const lines = text.split(/\n+/);
    const dateRe = /(?:(20\d{2})[-./년]\s*)?(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/g;
    const timeRe = /(오전|오후)?\s*(\d{1,2})\s*(?::|시)\s*(\d{2})?\s*분?(?:\s*[~-]\s*(오전|오후)?\s*(\d{1,2})\s*(?::|시)\s*(\d{2})?)?/g;
    const to24 = (ap, h) => {
      h = Number(h);
      if (ap === "오후" && h < 12) h += 12;
      if (ap === "오전" && h === 12) h = 0;
      if (!ap && h >= 1 && h <= 6) h += 12; // 1~6시는 보통 오후
      return h;
    };
    lines.forEach((line) => {
      const dates = [];
      let m;
      dateRe.lastIndex = 0;
      while ((m = dateRe.exec(line))) {
        const mo = Number(m[2]);
        const d = Number(m[3]);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
        dates.push({ date: (m[1] || year) + "-" + K.pad(mo) + "-" + K.pad(d), end: dateRe.lastIndex });
      }
      if (!dates.length) return;
      dates.forEach((dt, i) => {
        const seg = line.slice(dt.end, i + 1 < dates.length ? line.indexOf(line.slice(dates[i + 1].end - 1), dt.end) : undefined);
        const times = [];
        timeRe.lastIndex = 0;
        let t;
        while ((t = timeRe.exec(seg))) {
          if (!t[2] || (t[0].indexOf(":") < 0 && t[0].indexOf("시") < 0)) continue;
          const h = to24(t[1], t[2]);
          if (h > 23) continue;
          const time = K.pad(h) + ":" + (t[3] || "00");
          const endTime = t[5] ? K.pad(to24(t[4] || t[1], t[5])) + ":" + (t[6] || "00") : "";
          times.push({ time, endTime });
        }
        if (!times.length) slots.push({ date: dt.date, time: "", endTime: "" });
        times.forEach((x) => slots.push({ date: dt.date, time: x.time, endTime: x.endTime }));
      });
    });
    // 같은 슬롯 제거
    const seen = new Set();
    return slots.filter((s) => {
      const k = s.date + s.time;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }

  /* ---------- 그리기 ---------- */
  function active() {
    return items.filter((x) => x.status !== "discarded");
  }
  function pending() {
    return items.filter((x) => x.status === "open");
  }
  function slotLabel(s) {
    return s.time ? s.time + (s.endTime ? "~" + s.endTime : "") : "시간 미정";
  }
  function slotsHtml(it) {
    if (!it.slots || !it.slots.length) return '<div class="ndr-slots"><p class="ndr-slots__none">후보 시간이 없습니다. 수정에서 슬롯을 추가해 주세요.</p></div>';
    const byDay = new Map();
    it.slots.forEach((s, i) => {
      if (!byDay.has(s.date)) byDay.set(s.date, []);
      byDay.get(s.date).push([s, i]);
    });
    return (
      '<div class="ndr-slots">' +
      Array.from(byDay.entries()).map(([day, list]) =>
        '<div class="ndr-day"><span class="ndr-day__label">' + esc(K.kLabel(day)) + "</span>" +
        list.map(([s, i]) =>
          '<div class="ndr-slot' + (it.confirmedSlot === i ? " ndr-slot--confirmed" : "") + '"><span class="ndr-slot__time">' + esc(slotLabel(s)) + "</span>" +
          (it.status === "open"
            ? '<button type="button" class="btn btn--primary btn--sm ndr-slot__confirm" data-confirm="' + esc(it.id) + '" data-slot="' + i + '">확정</button>'
            : it.confirmedSlot === i ? '<span class="ndr-chip ndr-chip--done">확정됨</span>' : "") +
          "</div>"
        ).join("") + "</div>"
      ).join("") + "</div>"
    );
  }
  function sourceHtml(it) {
    return '<div class="ndr-source"><div class="ndr-source__head">원문</div>' +
      (it.source ? '<div class="ndr-source__text">' + esc(it.source) + "</div>" : '<p class="ndr-source__none">원문이 없습니다.</p>') + "</div>";
  }

  function renderCalendar() {
    const list = pending().filter((x) => x.slots && x.slots.length);
    if (!list.length) {
      calBox.innerHTML = "";
      return;
    }
    const first = K.startOfWeek(list.map((x) => x.slots[0].date).sort()[0], true);
    const last = list.map((x) => x.slots[x.slots.length - 1].date).sort().pop();
    const today = K.today();
    let html = '<p class="ndr-calnote">막대 하나가 NDR 한 건입니다. 막대는 첫 후보일부터 마지막 후보일까지 이어집니다.</p>';
    for (let wk = first; wk <= last; wk = K.addDays(wk, 7)) {
      const fri = K.addDays(wk, 4);
      const inWeek = list.filter((x) => x.slots[0].date <= fri && x.slots[x.slots.length - 1].date >= wk);
      if (!inWeek.length) continue;
      html += '<section class="ndr-week" data-week="' + wk + '"><div class="ndr-week__head">' +
        [0, 1, 2, 3, 4].map((d) => {
          const day = K.addDays(wk, d);
          return '<span class="ndr-week__day' + (day === today ? " is-today" : "") + '">' + K.md(day) + " (" + K.weekdayName(day) + ")</span>";
        }).join("") + '</div><div class="ndr-week__body">';
      inWeek.forEach((it) => {
        const s = it.slots[0].date < wk ? 0 : Math.min(4, K.diffDays(wk, it.slots[0].date));
        const e = Math.min(4, Math.max(s, K.diffDays(wk, it.slots[it.slots.length - 1].date)));
        html += '<div class="ndr-lane">' + [0, 1, 2, 3, 4].map((d) => '<span class="ndr-lane__cell" style="grid-column:' + (d + 1) + '"></span>').join("") +
          '<button type="button" class="ndr-bar ndr-bar--' + esc(it.type || "ndr") + '" data-toggle="' + esc(it.id) + '" style="grid-column:' + (s + 1) + " / " + (e + 2) + '" title="' +
          esc(it.company + " · " + (it.brokers || "") + " · 후보 " + it.slots.length + "개") + '"><span class="ndr-bar__name">' + esc(it.company) + '</span><span class="ndr-bar__broker">' + esc(it.brokers || "") + "</span></button></div>";
        if (open.has(it.id + "@" + wk)) html += '<div class="ndr-detail">' + slotsHtml(it) + sourceHtml(it) + "</div>";
      });
      html += "</div></section>";
    }
    calBox.innerHTML = html;
  }

  function renderList() {
    const list = active().sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || (b.createdAt || "").localeCompare(a.createdAt || ""));
    listBox.innerHTML = list.map((it) => {
      const isOpen = open.has(it.id);
      return (
        '<article class="ndr-card"><div class="ndr-card__head ndr-card__head--clickable" data-card="' + esc(it.id) + '"><div class="ndr-card__titles">' +
        '<div class="ndr-card__line"><strong class="ndr-card__company">' + esc(it.company) + '</strong><span class="ndr-chip ndr-chip--type">' + esc(K.IR_LABEL[it.type || "ndr"]) + "</span>" +
        (it.brokers ? '<span class="ndr-chip ndr-chip--broker">' + esc(it.brokers) + "</span>" : "") +
        (it.status === "done" ? '<span class="ndr-chip ndr-chip--done">확정 · IR 캘린더 등록</span>' : "") + "</div>" +
        '<div class="ndr-card__meta"><span class="ndr-card__counts">후보 ' + (it.slots || []).length + "개</span>" + (it.location ? "<span>" + esc(it.location) + "</span>" : "") +
        "<span>" + esc((it.createdBy || "") + " · " + K.isoKst(it.createdAt || "")) + "</span></div></div>" +
        '<div class="ndr-card__actions"><button type="button" class="btn btn--ghost btn--sm" data-edit="' + esc(it.id) + '">수정</button>' +
        '<button type="button" class="btn btn--ghost btn--sm ndr-card__discard" data-discard="' + esc(it.id) + '">폐기</button></div></div>' +
        (isOpen ? slotsHtml(it) + sourceHtml(it) : "") + "</article>"
      );
    }).join("");
  }

  function render() {
    const n = pending().length;
    $("#ndr-count").textContent = String(n);
    const isCal = view === "calendar";
    $("#view-calendar").classList.toggle("is-active", isCal);
    $("#view-list").classList.toggle("is-active", !isCal);
    calBox.hidden = !isCal;
    listBox.hidden = isCal;
    $("#ndr-empty").hidden = isCal ? n > 0 : active().length > 0;
    if (isCal) renderCalendar();
    else renderList();
  }

  /* ---------- 등록·수정 ---------- */
  function openEditor(existing) {
    const it = Object.assign({ company: "", brokers: "", location: "", type: "ndr", source: "", slots: [] }, existing || {});
    let slots = (it.slots || []).map((s) => Object.assign({}, s));
    const html =
      '<form class="modal__body" id="ndr-form" novalidate>' +
      '<label class="field"><span class="field__label">안내문 붙여넣기 <span class="field__label-note">— 날짜·시간이 적힌 줄에서 후보를 찾습니다</span></span>' +
      '<textarea class="input input--textarea" name="source" rows="5" placeholder="예) 삼성전자 NDR 안내&#10;9/24(수) 10:00, 14:00&#10;9/25(목) 오전 10시~11시">' + esc(it.source) + "</textarea></label>" +
      '<div><button type="button" class="btn btn--ghost btn--sm" data-act="parse">후보 찾기</button></div>' +
      '<div class="field-row field-row--three"><label class="field"><span class="field__label">기업 <em class="required">*</em></span><input class="input" name="company" value="' + esc(it.company) + '"></label>' +
      '<label class="field"><span class="field__label">증권사</span><input class="input" name="brokers" value="' + esc(it.brokers) + '"></label>' +
      '<label class="field"><span class="field__label">장소</span><input class="input" name="location" value="' + esc(it.location) + '"></label></div>' +
      '<div class="field"><span class="field__label">후보 시간 (슬롯)</span><ul class="opt-list" data-slots></ul>' +
      '<div class="opt-add"><input class="input" type="date" data-new-date value="' + K.today() + '"><input class="input" type="time" data-new-time><input class="input" type="time" data-new-end>' +
      '<button type="button" class="btn btn--ghost btn--sm" data-act="add-slot">슬롯 추가</button></div></div>' +
      '<div class="modal__footer">' + (existing ? '<button type="button" class="btn btn--danger btn--sm" data-act="delete">삭제</button>' : "") +
      '<div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-act="cancel">취소</button><button type="submit" class="btn btn--primary">저장</button></div></div></form>';
    const ctx = K.modal({ title: existing ? "후보 수정" : "NDR 후보 등록", size: "modal--wide", html, focus: '[name="source"]' });
    const form = $("#ndr-form", ctx.modal);
    const f = (n) => form.elements[n];
    function drawSlots() {
      $("[data-slots]", form).innerHTML = slots.length
        ? slots.map((s, i) => '<li class="opt-item"><span class="opt-item__name">' + esc(K.kLabel(s.date) + " " + slotLabel(s)) + '</span><button type="button" class="btn btn--ghost btn--sm" data-del="' + i + '">빼기</button></li>').join("")
        : '<li class="opt-list__empty">아직 슬롯이 없습니다. 안내문에서 찾거나 직접 추가하세요.</li>';
    }
    drawSlots();
    form.addEventListener("click", async (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        slots.splice(Number(del.getAttribute("data-del")), 1);
        drawSlots();
        return;
      }
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const what = act.getAttribute("data-act");
      if (what === "cancel") ctx.close();
      else if (what === "parse") {
        const text = f("source").value;
        const found = parseSlots(text);
        if (!f("company").value.trim()) {
          const m = /([가-힣A-Za-z0-9&]+)\s*(?:NDR|ndr|IR|탐방)/.exec(text);
          if (m) f("company").value = m[1];
        }
        if (!f("brokers").value.trim()) {
          const b = /([가-힣A-Za-z]+(?:증권|투자증권|Securities))/.exec(text);
          if (b) f("brokers").value = b[1];
        }
        if (!found.length) K.toast("안내문에서 날짜를 찾지 못했습니다. 슬롯을 직접 추가해 주세요.", true);
        else {
          slots = found;
          drawSlots();
          K.toast("후보 " + found.length + "개를 찾았습니다.");
        }
      } else if (what === "add-slot") {
        const date = $("[data-new-date]", form).value;
        if (!date) return K.toast("날짜를 골라 주세요.", true);
        slots.push({ date, time: $("[data-new-time]", form).value, endTime: $("[data-new-end]", form).value });
        slots.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
        drawSlots();
      } else if (what === "delete") {
        if (!(await K.confirm("이 후보를 삭제할까요?", "삭제", true))) return;
        await store.remove(existing.id);
        items = store.cached();
        ctx.close(true);
        render();
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = { company: f("company").value.trim(), brokers: f("brokers").value.trim(), location: f("location").value.trim(), source: f("source").value.trim(), slots, type: "ndr" };
      if (!data.company) return K.toast("기업을 입력해 주세요.", true), f("company").focus();
      try {
        if (existing) await store.update(existing.id, data);
        else await store.create(Object.assign({ status: "open", confirmedSlot: null }, data));
        items = store.cached();
        ctx.close(true);
        render();
        K.toast("저장했습니다.");
      } catch (err) {
        K.toast(err.message, true);
      }
    });
  }

  async function confirmSlot(id, index) {
    const it = items.find((x) => x.id === id);
    const s = it && it.slots[index];
    if (!s) return;
    if (!(await K.confirm(it.company + " · " + K.kLabel(s.date) + " " + slotLabel(s) + "\n이 시간으로 확정해 IR 캘린더에 올릴까요?", "확정"))) return;
    try {
      const ev = await calendar.create({
        type: "ndr", companies: it.company, brokers: it.brokers || "", location: it.location || "", date: s.date, endDate: "", time: s.time || "", endTime: s.endTime || "",
        title: "", memo: it.source || "", poster: null,
      });
      await store.update(id, { status: "done", confirmedSlot: index, eventId: ev.id });
      items = store.cached();
      render();
      K.toast("IR 캘린더에 등록했습니다.");
    } catch (err) {
      K.toast("등록하지 못했습니다: " + err.message, true);
    }
  }

  /* ---------- 이벤트 ---------- */
  $("#ndr-add").addEventListener("click", () => openEditor(null));
  $("#reload-btn").addEventListener("click", load);
  $("#view-calendar").addEventListener("click", () => {
    view = "calendar";
    K.prefs.set("ndr.view", view);
    render();
  });
  $("#view-list").addEventListener("click", () => {
    view = "list";
    K.prefs.set("ndr.view", view);
    render();
  });
  document.querySelector(".page").addEventListener("click", async (e) => {
    const tg = e.target.closest("[data-toggle]");
    if (tg) {
      // 막대는 주마다 따로 펼친다 (키: 항목id@그 주 월요일)
      const key = tg.getAttribute("data-toggle") + "@" + tg.closest(".ndr-week").getAttribute("data-week");
      const had = open.has(key);
      Array.from(open).filter((k) => k.includes("@")).forEach((k) => open.delete(k));
      if (!had) open.add(key);
      renderCalendar();
      return;
    }
    const card = e.target.closest("[data-card]");
    if (card && !e.target.closest("button")) {
      const id = card.getAttribute("data-card");
      if (open.has(id)) open.delete(id);
      else open.add(id);
      renderList();
      return;
    }
    const conf = e.target.closest("[data-confirm]");
    if (conf) return confirmSlot(conf.getAttribute("data-confirm"), Number(conf.getAttribute("data-slot")));
    const ed = e.target.closest("[data-edit]");
    if (ed) return openEditor(items.find((x) => x.id === ed.getAttribute("data-edit")));
    const dis = e.target.closest("[data-discard]");
    if (dis) {
      if (!(await K.confirm("이 건을 목록에서 내릴까요? (삭제하지 않고 폐기로 표시합니다)", "폐기"))) return;
      await store.update(dis.getAttribute("data-discard"), { status: "discarded" });
      items = store.cached();
      render();
    }
  });
  async function load() {
    try {
      items = await store.list();
    } catch (err) {
      K.toast("불러오지 못했습니다: " + err.message, true);
      items = [];
    }
    render();
  }
  load();
})();
