/* IR 캘린더 — 콥데이·NDR·탐방 일정 기록, 주간 캘린더/목록, 유형·증권사·장소·기업 필터 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const store = K.irEvents();
  const WEEKS = 4;
  const MAX_CHIPS = 6;
  const BROKERS = [
    "한국투자증권", "미래에셋증권", "NH투자증권", "삼성증권", "KB증권", "신한투자증권", "키움증권", "하나증권", "대신증권", "메리츠증권",
    "한화투자증권", "유안타증권", "교보증권", "IBK투자증권", "하이투자증권", "현대차증권", "SK증권", "DB금융투자", "LS증권", "iM증권",
    "Morgan Stanley", "Goldman Sachs", "J.P.Morgan", "BofA", "CLSA", "UBS", "Citi", "Macquarie", "Nomura", "Daiwa", "HSBC", "Jefferies",
  ];

  let events = [];
  const state = {
    view: K.prefs.get("cal.view", "calendar"),
    anchor: K.startOfWeek(K.today(), true),
    types: new Set(K.prefs.get("cal.types", K.IR_TYPES.map((t) => t[0]).filter((t) => t !== "earnings"))),
    company: "", // 정확히 고른 기업
    companyLike: "", // '…포함 모두'
    broker: "",
    location: "",
    q: "",
    expanded: new Set(),
  };

  /* ---------- 화면 뼈대 보강 ---------- */
  const grid = $("#cal-grid");
  const calView = $("#calendar-view");
  const listView = document.createElement("div");
  listView.id = "list-view";
  listView.hidden = true;
  calView.after(listView);

  const filtersToggle = $("#cal-filters-toggle");
  const filters = document.createElement("section");
  filters.className = "cal-filters";
  filters.id = "cal-filters";
  filters.hidden = true;
  filters.innerHTML =
    '<label class="filter filter--grow"><span class="filter__label">증권사</span><input class="input input--compact" id="f-broker" list="dl-brokers" placeholder="예: KB증권"></label>' +
    '<label class="filter filter--grow"><span class="filter__label">장소</span><input class="input input--compact" id="f-location" list="dl-locations" placeholder="예: 여의도"></label>' +
    '<label class="filter filter--grow"><span class="filter__label">검색어</span><input class="input input--compact" id="f-q" placeholder="제목·메모"></label>' +
    '<button type="button" class="btn btn--ghost btn--sm" id="f-reset">필터 초기화</button>';
  filtersToggle.after(filters);

  const cosearch = $("#cosearch");
  const coInput = $("#cosearch-input");
  const coList = document.createElement("div");
  coList.className = "cosearch__list";
  coList.id = "cosearch-list";
  coList.setAttribute("role", "listbox");
  coList.hidden = true;
  cosearch.style.position = "relative";
  cosearch.appendChild(coList);
  const coNote = document.createElement("p");
  coNote.className = "cosearch__note";
  coNote.hidden = true;
  cosearch.appendChild(coNote);

  // DART 연동 안내 자리에 이 사이트의 저장 상태와 CSV 가져오기·내보내기
  const syncHeading = $(".dart-sync__heading");
  if (syncHeading) {
    syncHeading.innerHTML = "<strong>IR 일정</strong><span>직접 등록 · CSV 가져오기</span>";
    const small = $(".dart-sync small");
    if (small) {
      small.innerHTML =
        '<a href="#" class="dart-source-link" id="csv-import">CSV 가져오기</a> · <a href="#" class="dart-source-link" id="csv-export">CSV 내보내기</a> · ' +
        '<a href="#" class="dart-source-link" id="csv-sample">양식 받기</a>' +
        '<span id="dart-ir-wrap" hidden> · <a href="#" class="dart-source-link" id="dart-ir">DART IR 공시 불러오기</a></span>';
    }
  }

  // DART 기업설명회(IR) 공시 목록 → 골라서 일정으로 추가 (서버 모드)
  async function showDartIr() {
    const ctx = K.modal({ title: "DART 기업설명회(IR) 공시 — 최근 14일", size: "modal--wide", html: '<div class="modal__body"><p class="hint">불러오는 중…</p></div>' });
    const body = $(".modal__body", ctx.modal);
    try {
      const s = await K.session();
      const out = await s.api("GET", "/api/dart/ir?days=14");
      const items = out.items || [];
      body.innerHTML = items.length
        ? '<p class="hint">개최일·시간은 공시 원문에 있습니다. 원문을 확인하고 <b>일정 추가</b>를 누르세요.</p><div class="dart-ir-list">' +
          items.map((it, i) =>
            '<div class="dart-ir-item"><div><b>' + esc(it.company) + "</b> <span class=\"hint\">" + esc(it.date) + " 공시</span><br><span>" + esc(it.title) + "</span></div>" +
            '<div class="dart-ir-item__actions"><a class="btn btn--ghost btn--sm" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">원문</a>' +
            '<button type="button" class="btn btn--primary btn--sm" data-dart="' + i + '">일정 추가</button></div></div>'
          ).join("") + "</div>"
        : '<p class="hint">최근 14일 동안 기업설명회 공시가 없습니다.</p>';
      body.addEventListener("click", (e) => {
        const b = e.target.closest("[data-dart]");
        if (!b) return;
        const it = items[Number(b.getAttribute("data-dart"))];
        ctx.close(true);
        openEditor(null, { type: "open_ir", companies: it.company, date: K.today(), memo: it.title + "\n" + it.url });
      });
    } catch (err) {
      body.innerHTML = '<p class="hint">' + esc(err.message) + "</p>";
    }
  }

  /* ---------- 거르기 ---------- */
  function splitNames(s) {
    return (s || "").split(/[,/·\n]+/).map((x) => x.trim()).filter(Boolean);
  }
  function passes(ev, ignoreType) {
    if (!ignoreType && !state.types.has(ev.type)) return false;
    if (state.company && !splitNames(ev.companies).includes(state.company)) return false;
    if (state.companyLike && !(ev.companies || "").toLowerCase().includes(state.companyLike.toLowerCase())) return false;
    if (state.broker && !(ev.brokers || "").toLowerCase().includes(state.broker.toLowerCase())) return false;
    if (state.location && !(ev.location || "").toLowerCase().includes(state.location.toLowerCase())) return false;
    if (state.q) {
      const hay = [ev.title, ev.memo, ev.companies, ev.brokers, ev.location].join(" ").toLowerCase();
      if (!hay.includes(state.q.toLowerCase())) return false;
    }
    return true;
  }
  function eventsOn(day) {
    return events.filter((ev) => K.eventCovers(ev, day) && passes(ev)).sort(K.byEventTime);
  }
  function label(ev) {
    const who = ev.companies || "기업 미정";
    return ev.title ? who + " · " + ev.title : who + (ev.brokers ? " · " + ev.brokers : "");
  }
  function tooltip(ev) {
    return [
      K.IR_LABEL[ev.type] || "기타", ev.title || "", ev.companies ? "기업: " + ev.companies : "", ev.brokers ? "증권사: " + ev.brokers : "",
      ev.location ? "장소: " + ev.location : "", K.eventTime(ev),
    ].filter(Boolean).join(" · ");
  }

  /* ---------- 그리기 ---------- */
  function rangeEnd() {
    return K.addDays(state.anchor, WEEKS * 7 - 3); // 마지막 주 금요일
  }
  function renderCalendar() {
    const today = K.today();
    let html = "";
    for (let w = 0; w < WEEKS; w++) {
      for (let d = 0; d < 5; d++) {
        const day = K.addDays(state.anchor, w * 7 + d);
        const list = eventsOn(day);
        const open = state.expanded.has(day);
        const shown = open ? list : list.slice(0, MAX_CHIPS);
        const cls = ["cal-cell"];
        if (day === today) cls.push("cal-cell--today");
        if (list.length > MAX_CHIPS) cls.push("cal-cell--overflow");
        html +=
          '<div class="' + cls.join(" ") + '" data-date="' + day + '"><div class="cal-cell__date">' + K.md(day) + "</div>" +
          '<div class="cal-cell__events">' +
          shown.map((ev) =>
            '<button type="button" class="ev-chip ev-chip--' + esc(ev.type) + '" data-id="' + esc(ev.id) + '" title="' + esc(tooltip(ev)) + '">' +
            '<span class="ev-chip__time">' + esc(ev.time || "미정") + '</span><span class="ev-chip__label">' + esc(label(ev)) + "</span></button>"
          ).join("") +
          (list.length > MAX_CHIPS
            ? '<span class="cal-cell__more" data-more="' + day + '" role="button" tabindex="0">' + (open ? "접기" : "+" + (list.length - MAX_CHIPS) + "건 더") + "</span>"
            : "") +
          "</div></div>";
      }
    }
    grid.innerHTML = html;
    $("#cal-label").textContent = K.md(state.anchor).replace("/", "월 ") + "일 ~ " + K.md(rangeEnd()).replace("/", "월 ") + "일";
  }

  function renderList() {
    const from = state.anchor;
    const to = K.addDays(state.anchor, WEEKS * 7 - 1);
    const today = K.today();
    const groups = [];
    for (let day = from; day <= to; day = K.addDays(day, 1)) {
      const list = eventsOn(day);
      if (list.length) groups.push([day, list]);
    }
    listView.innerHTML = groups.length
      ? '<div class="agenda">' +
        groups.map(([day, list]) =>
          '<section class="agenda__group"><h3 class="agenda__date' + (day === today ? " agenda__date--today" : "") + '">' + esc(K.kLabel(day)) +
          (day === today ? " · 오늘" : "") + "</h3>" +
          list.map((ev) =>
            '<button type="button" class="agenda-row" data-id="' + esc(ev.id) + '"><span class="agenda-row__time">' + esc(K.eventTime(ev)) + "</span>" +
            '<span class="agenda-row__main"><span class="agenda-row__title">' + esc(label(ev)) + "</span>" +
            '<span class="agenda-row__meta"><span class="type-badge type-badge--' + esc(ev.type) + '">' + esc(K.IR_LABEL[ev.type] || "기타") + "</span>" +
            (ev.brokers ? "<span>" + esc(ev.brokers) + "</span>" : "") +
            (ev.location ? '<span class="agenda-row__dot">·</span><span>' + esc(ev.location) + "</span>" : "") +
            "</span></span></button>"
          ).join("") + "</section>"
        ).join("") + "</div>"
      : '<div class="agenda__empty">이 기간에 보여줄 일정이 없습니다. 필터를 바꾸거나 <strong>+ 일정 추가</strong>로 등록해 보세요.</div>';
  }

  function renderCday() {
    const box = $("#cday");
    const input = $("#cday-date");
    const day = input.value || K.today();
    const list = events.filter((ev) => ev.type === "corp_day" && K.eventCovers(ev, day)).sort(K.byEventTime);
    const groups = new Map();
    list.forEach((ev) => {
      const key = (ev.brokers || "증권사 미정") + "|" + (ev.time || "");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    });
    $(".cday__title", box).textContent = day === K.today() ? "오늘의 콥데이" : K.kLabel(day) + " 콥데이";
    $("#cday-hint").textContent = list.length ? groups.size + "곳 · " + list.length + "건" : "등록된 콥데이가 없습니다";
    $("#cday-list").innerHTML = Array.from(groups.values()).map((g, i) => {
      const first = g[0];
      const poster = g.find((x) => x.poster);
      return (
        '<article class="cday-card" role="button" tabindex="0" data-group="' + i + '">' +
        '<div class="cday-card__head"><div class="cday-card__broker">' + esc(first.brokers || "증권사 미정") + "</div>" +
        '<div class="cday-card__when">' + esc(first.time || "시간 미정") + " · " + g.length + "건</div></div>" +
        (poster ? '<div class="cday-card__poster" data-poster="' + esc(poster.id) + '"></div>' : '<div class="cday-card__poster cday-card__poster--none">안내 이미지 없음</div>') +
        '<div class="cday-card__body"><div class="cday-card__lead">' + esc(g.map((x) => x.companies).filter(Boolean).join(", ") || "기업 미정") + "</div>" +
        (first.location ? '<div class="cday-card__place">' + esc(first.location) + "</div>" : "") + "</div></article>"
      );
    }).join("");
    box.dataset.groups = JSON.stringify(Array.from(groups.values()).map((g) => g.map((x) => x.id)));
    // 포스터 미리보기
    $$("[data-poster]", box).forEach(async (el) => {
      const ev = events.find((x) => x.id === el.getAttribute("data-poster"));
      const got = ev && ev.poster ? await K.files.url(ev.poster) : null;
      if (got) el.innerHTML = '<img src="' + esc(got.url) + '" alt="" style="width:100%;height:100%;object-fit:cover">';
    });
  }

  function renderLegend() {
    $$(".cal-legend__check").forEach((cb) => {
      cb.checked = state.types.has(cb.value);
      cb.closest(".cal-legend__item").classList.toggle("is-off", !cb.checked);
    });
    const all = K.IR_TYPES.every((t) => state.types.has(t[0]));
    $("#legend-all").textContent = all ? "전체 해제" : "전체 선택";
  }

  function renderDatalists() {
    const set = (id, values) => {
      let dl = document.getElementById(id);
      if (!dl) {
        dl = document.createElement("datalist");
        dl.id = id;
        document.body.appendChild(dl);
      }
      dl.innerHTML = Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko")).map((v) => '<option value="' + esc(v) + '"></option>').join("");
    };
    set("dl-brokers", BROKERS.concat(events.flatMap((e) => splitNames(e.brokers))));
    set("dl-companies", events.flatMap((e) => splitNames(e.companies)));
    set("dl-locations", ["여의도", "서울", "홍콩", "싱가포르", "화상컨퍼런스콜"].concat(events.map((e) => e.location)));
  }

  function renderFilterBadge() {
    const n = [state.broker, state.location, state.q].filter(Boolean).length;
    let badge = $(".cal-filters__badge", filtersToggle);
    if (n && !badge) {
      badge = document.createElement("span");
      badge.className = "cal-filters__badge";
      filtersToggle.appendChild(badge);
    }
    if (badge) {
      badge.hidden = !n;
      badge.textContent = String(n);
    }
  }

  function renderCoNote() {
    const name = state.company || (state.companyLike && "‘" + state.companyLike + "’ 포함 기업");
    coNote.hidden = !name;
    if (name) coNote.innerHTML = "<strong>" + esc(name) + '</strong> 일정만 보고 있습니다. <button type="button" class="cosearch__reset" id="co-reset">전체 보기</button>';
  }

  function render() {
    renderLegend();
    renderFilterBadge();
    renderCoNote();
    const isCal = state.view === "calendar";
    calView.hidden = !isCal;
    listView.hidden = isCal;
    $("#view-calendar").classList.toggle("is-active", isCal);
    $("#view-list").classList.toggle("is-active", !isCal);
    if (isCal) renderCalendar();
    else renderList();
    if (!isCal) $("#cal-label").textContent = K.md(state.anchor).replace("/", "월 ") + "일 ~ " + K.md(K.addDays(state.anchor, WEEKS * 7 - 1)).replace("/", "월 ") + "일";
    const inRange = events.filter((ev) => passes(ev) && ev.date <= K.addDays(state.anchor, WEEKS * 7 - 1) && (ev.endDate || ev.date) >= state.anchor);
    $("#cal-count").textContent = inRange.length + "건";
    $("#cal-prev").disabled = false;
    renderCday();
    const status = $("#dart-sync-status");
    if (status) status.textContent = "등록된 일정 " + events.length + "건" + (events.length ? " · 가장 최근 " + K.dot(events.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0].date) : "");
  }

  /* ---------- 일정 창 ---------- */
  function typeOptions(cur) {
    return K.IR_TYPES.map(([k, v]) => '<option value="' + k + '"' + (k === cur ? " selected" : "") + ">" + v + "</option>").join("");
  }

  function openEditor(existing, preset) {
    const ev = Object.assign({ type: "corp_day", date: K.today(), endDate: "", time: "", endTime: "", companies: "", brokers: "", location: "", title: "", memo: "", poster: null }, existing || preset || {});
    let poster = ev.poster;
    let newPoster = (preset && preset.posterBlob) || null;
    const html =
      '<form class="modal__body" id="ev-form" novalidate>' +
      '<div class="field-row"><label class="field"><span class="field__label">유형 <em class="required">*</em></span><select class="input" name="type">' + typeOptions(ev.type) + "</select></label>" +
      '<label class="field"><span class="field__label">제목 <span class="field__label-note">(선택)</span></span><input class="input" name="title" maxlength="120" value="' + esc(ev.title) + '" placeholder="예: 3분기 실적 NDR"></label></div>' +
      '<label class="field"><span class="field__label">기업 <em class="required">*</em> <span class="field__label-note">여러 곳이면 쉼표로</span></span><input class="input" name="companies" list="dl-companies" value="' + esc(ev.companies) + '" placeholder="예: 삼성전자, SK하이닉스"></label>' +
      '<div class="field-row"><label class="field"><span class="field__label">증권사</span><input class="input" name="brokers" list="dl-brokers" value="' + esc(ev.brokers) + '"></label>' +
      '<label class="field"><span class="field__label">장소</span><input class="input" name="location" list="dl-locations" value="' + esc(ev.location) + '"></label></div>' +
      '<div class="field-row"><label class="field"><span class="field__label">날짜 <em class="required">*</em></span><input class="input" type="date" name="date" value="' + esc(ev.date) + '" required></label>' +
      '<label class="field"><span class="field__label">끝나는 날 <span class="field__label-note">(여러 날 행사)</span></span><input class="input" type="date" name="endDate" value="' + esc(ev.endDate || "") + '"></label></div>' +
      '<div class="field"><span class="field__label">시간 <span class="field__label-note">비워 두면 ‘시간 미정’</span></span><div class="time-range">' +
      '<input class="input" type="time" name="time" value="' + esc(ev.time) + '"><span class="time-range__sep">~</span><input class="input" type="time" name="endTime" value="' + esc(ev.endTime) + '"></div></div>' +
      '<label class="field"><span class="field__label">메모</span><textarea class="input input--textarea" name="memo" rows="3">' + esc(ev.memo) + "</textarea></label>" +
      '<div class="field"><span class="field__label">안내 이미지 <span class="image-drop-hint"><span class="image-drop-hint__icon">🖼</span>파일을 고르거나 여기에 붙여넣기(Ctrl+V)</span></span>' +
      '<div data-poster-preview></div><input class="input input--file" type="file" name="poster" accept="image/*"></div>' +
      '<div class="modal__footer">' + (existing ? '<button type="button" class="btn btn--danger btn--sm" data-act="delete">삭제</button>' : "") +
      '<div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-act="cancel">취소</button><button type="submit" class="btn btn--primary">' + (existing ? "수정 저장" : "등록") + "</button></div></div></form>";
    const ctx = K.modal({ title: existing ? "일정 수정" : "일정 추가", size: "modal--wide", html, focus: existing ? '[name="companies"]' : '[name="companies"]' });
    const form = $("#ev-form", ctx.modal);
    const f = (n) => form.elements[n];
    const preview = $("[data-poster-preview]", form);
    let previewUrl = "";

    async function showPoster() {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = "";
      if (newPoster) {
        previewUrl = URL.createObjectURL(newPoster);
        preview.innerHTML = '<img class="modal-image" src="' + previewUrl + '" alt="안내 이미지"><button type="button" class="btn btn--ghost btn--sm" data-act="unposter" style="margin-top:6px">이미지 빼기</button>';
      } else if (poster) {
        const got = await K.files.url(poster);
        preview.innerHTML = got ? '<img class="modal-image" src="' + esc(got.url) + '" alt="안내 이미지"><button type="button" class="btn btn--ghost btn--sm" data-act="unposter" style="margin-top:6px">이미지 빼기</button>' : "";
      } else preview.innerHTML = "";
    }
    showPoster();
    f("poster").addEventListener("change", () => {
      newPoster = f("poster").files[0] || null;
      showPoster();
    });
    ctx.modal.addEventListener("paste", (e) => {
      const item = Array.from(e.clipboardData.items || []).find((it) => it.type.startsWith("image/"));
      if (item) {
        e.preventDefault();
        newPoster = item.getAsFile();
        showPoster();
      }
    });

    form.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const what = act.getAttribute("data-act");
      if (what === "cancel") ctx.close();
      else if (what === "unposter") {
        newPoster = null;
        poster = null;
        f("poster").value = "";
        showPoster();
      } else if (what === "delete") {
        if (!(await K.confirm("이 일정을 삭제할까요?", "삭제", true))) return;
        try {
          await store.remove(existing.id);
          if (existing.poster) K.files.remove(existing.poster);
          events = store.cached();
          ctx.close(true);
          refresh();
          K.toast("일정을 삭제했습니다.");
        } catch (err) {
          K.toast(err.message, true);
        }
      }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = {
        type: f("type").value,
        title: f("title").value.trim(),
        companies: splitNames(f("companies").value).join(", "),
        brokers: f("brokers").value.trim(),
        location: f("location").value.trim(),
        date: f("date").value,
        endDate: f("endDate").value && f("endDate").value > f("date").value ? f("endDate").value : "",
        time: f("time").value,
        endTime: f("time").value ? f("endTime").value : "",
        memo: f("memo").value.trim(),
      };
      if (!data.companies) return K.toast("기업을 입력해 주세요.", true), f("companies").focus();
      if (!data.date) return K.toast("날짜를 입력해 주세요.", true), f("date").focus();
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        if (newPoster) {
          data.poster = await K.files.put(newPoster, newPoster.name || "poster.png");
          if (existing && existing.poster) K.files.remove(existing.poster);
        } else {
          data.poster = poster || null;
          if (existing && existing.poster && !poster) K.files.remove(existing.poster);
        }
        const saved = existing ? await store.update(existing.id, data) : await store.create(data);
        events = store.cached();
        ctx.close(true);
        if (saved.date < state.anchor || saved.date > K.addDays(state.anchor, WEEKS * 7 - 1)) state.anchor = K.startOfWeek(saved.date, true);
        refresh();
        K.toast(existing ? "일정을 수정했습니다." : "일정을 등록했습니다.");
      } catch (err) {
        K.toast("저장하지 못했습니다: " + err.message, true);
        btn.disabled = false;
      }
    });
  }

  function openView(ids, index) {
    let i = index || 0;
    let url = "";
    const ctx = K.modal({ title: "일정", size: "", html: '<div class="modal__body" id="ev-view"></div>', onClose: () => url && URL.revokeObjectURL(url) });
    const body = $("#ev-view", ctx.modal);
    async function draw() {
      const ev = events.find((x) => x.id === ids[i]);
      if (!ev) {
        ctx.close(true);
        return;
      }
      ctx.setTitle((K.IR_LABEL[ev.type] || "일정") + " · " + (ev.companies || ""));
      const rows = [
        ["기업", ev.companies], ["제목", ev.title], ["증권사", ev.brokers], ["장소", ev.location],
        ["일시", K.dot(ev.date) + (ev.endDate ? " ~ " + K.dot(ev.endDate) : "") + " · " + K.eventTime(ev)], ["메모", ev.memo], ["등록", (ev.createdBy || "") + (ev.createdAt ? " · " + K.isoKst(ev.createdAt) : "")],
      ].filter((r) => r[1]);
      body.innerHTML =
        (ids.length > 1
          ? '<div class="view-nav"><button type="button" class="view-nav__btn" data-nav="-1"' + (i === 0 ? " disabled" : "") + ' aria-label="이전">‹</button><span class="view-nav__count">' + (i + 1) + " / " + ids.length +
            '</span><button type="button" class="view-nav__btn" data-nav="1"' + (i === ids.length - 1 ? " disabled" : "") + ' aria-label="다음">›</button></div>'
          : "") +
        '<div class="view-detail"><span class="type-badge type-badge--' + esc(ev.type) + '">' + esc(K.IR_LABEL[ev.type] || "기타") + "</span>" +
        rows.map((r) => '<div class="view-row"><span class="view-row__label">' + esc(r[0]) + '</span><span class="view-row__value">' + esc(r[1]) + "</span></div>").join("") +
        '<div data-img></div></div>' +
        '<div class="modal__footer modal__footer--view"><a class="btn btn--ghost btn--sm" href="/notes/?company=' + encodeURIComponent((ev.companies || "").split(",")[0].trim()) + '">이 기업 노트</a>' +
        '<div class="modal__footer-right"><button type="button" class="btn btn--danger btn--sm" data-act="delete">삭제</button><button type="button" class="btn btn--ghost btn--sm" data-act="edit">수정</button>' +
        '<button type="button" class="btn btn--primary btn--sm" data-act="close">닫기</button></div></div>';
      if (ev.poster) {
        const got = await K.files.url(ev.poster);
        if (got) {
          if (url) URL.revokeObjectURL(url);
          url = got.revoke ? got.url : "";
          $("[data-img]", body).innerHTML = '<img class="modal-image" src="' + esc(got.url) + '" alt="안내 이미지">';
        }
      }
    }
    body.addEventListener("click", async (e) => {
      const nav = e.target.closest("[data-nav]");
      if (nav) {
        i = Math.max(0, Math.min(ids.length - 1, i + Number(nav.getAttribute("data-nav"))));
        draw();
        return;
      }
      const img = e.target.closest(".modal-image");
      if (img) window.open(img.src, "_blank", "noopener");
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const ev = events.find((x) => x.id === ids[i]);
      const what = act.getAttribute("data-act");
      if (what === "close") ctx.close();
      else if (what === "edit") {
        ctx.close(true);
        openEditor(ev);
      } else if (what === "delete") {
        if (!(await K.confirm("이 일정을 삭제할까요?", "삭제", true))) return;
        try {
          await store.remove(ev.id);
          if (ev.poster) K.files.remove(ev.poster);
          events = store.cached();
          refresh();
          ids = ids.filter((x) => x !== ev.id);
          if (!ids.length) ctx.close(true);
          else {
            i = Math.min(i, ids.length - 1);
            draw();
          }
          K.toast("일정을 삭제했습니다.");
        } catch (err) {
          K.toast(err.message, true);
        }
      }
    });
    draw();
  }

  /* ---------- 기업 검색 ---------- */
  function companyCounts() {
    const m = new Map();
    events.forEach((ev) => splitNames(ev.companies).forEach((c) => m.set(c, (m.get(c) || 0) + 1)));
    return m;
  }
  function showCoList() {
    const q = coInput.value.trim().toLowerCase();
    const counts = companyCounts();
    if (!q) {
      coList.hidden = true;
      coInput.setAttribute("aria-expanded", "false");
      return;
    }
    const hits = Array.from(counts.entries()).filter(([n]) => n.toLowerCase().includes(q)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
    coList.innerHTML =
      '<button type="button" class="cosearch__item cosearch__item--all" data-like="' + esc(coInput.value.trim()) + '"><span class="cosearch__name">‘' + esc(coInput.value.trim()) +
      "’ 들어간 기업 모두</span></button>" +
      (hits.length
        ? hits.slice(0, 30).map(([n, c]) => '<button type="button" class="cosearch__item" data-co="' + esc(n) + '"><span class="cosearch__name">' + esc(n) + '</span><span class="cosearch__meta">' + c + "건</span></button>").join("") +
          (hits.length > 30 ? '<p class="cosearch__more">' + (hits.length - 30) + "곳 더 있습니다. 더 입력해 좁혀 보세요.</p>" : "")
        : '<p class="cosearch__empty">일치하는 기업이 없습니다.</p>');
    coList.hidden = false;
    coInput.setAttribute("aria-expanded", "true");
  }
  function pickCompany(name, like) {
    state.company = like ? "" : name;
    state.companyLike = like ? name : "";
    coList.hidden = true;
    coInput.value = name;
    // 그 기업의 가장 가까운 일정이 보이도록 이동
    const mine = events.filter((ev) => passes(ev, true)).sort(K.byEventTime);
    const next = mine.find((ev) => (ev.endDate || ev.date) >= K.today()) || mine[mine.length - 1];
    if (next) state.anchor = K.startOfWeek(next.date, true);
    state.view = "list";
    render();
  }

  /* ---------- CSV ---------- */
  const CSV_HEAD = ["유형", "기업", "증권사", "장소", "날짜", "끝나는날", "시작시간", "끝시간", "제목", "메모"];
  function exportCsv() {
    const rows = [CSV_HEAD].concat(events.slice().sort(K.byEventTime).map((e) => [K.IR_LABEL[e.type] || "기타", e.companies, e.brokers, e.location, e.date, e.endDate, e.time, e.endTime, e.title, e.memo]));
    K.saveText("IR일정_" + K.today() + ".csv", K.toCsv(rows), "text/csv;charset=utf-8");
  }
  function importCsv() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv,text/plain";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const rows = K.parseCsv(await file.text());
      const head = rows.shift() || [];
      const col = (name) => head.findIndex((h) => h.trim() === name);
      const idx = Object.fromEntries(CSV_HEAD.map((h) => [h, col(h)]));
      if (idx["기업"] < 0 || idx["날짜"] < 0) return K.toast("첫 줄에 ‘기업’, ‘날짜’ 열이 있어야 합니다. ‘양식 받기’를 참고하세요.", true);
      const typeByLabel = Object.fromEntries(K.IR_TYPES.map(([k, v]) => [v, k]));
      const normDate = (s) => {
        const m = /(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(s || "");
        return m ? m[1] + "-" + K.pad(+m[2]) + "-" + K.pad(+m[3]) : "";
      };
      const normTime = (s) => {
        const m = /(\d{1,2}):(\d{2})/.exec(s || "");
        return m ? K.pad(+m[1]) + ":" + m[2] : "";
      };
      const items = rows.map((r) => ({
        type: typeByLabel[(r[idx["유형"]] || "").trim()] || (K.IR_LABEL[(r[idx["유형"]] || "").trim()] ? r[idx["유형"]].trim() : "etc"),
        companies: (r[idx["기업"]] || "").trim(),
        brokers: idx["증권사"] >= 0 ? (r[idx["증권사"]] || "").trim() : "",
        location: idx["장소"] >= 0 ? (r[idx["장소"]] || "").trim() : "",
        date: normDate(r[idx["날짜"]]),
        endDate: idx["끝나는날"] >= 0 ? normDate(r[idx["끝나는날"]]) : "",
        time: idx["시작시간"] >= 0 ? normTime(r[idx["시작시간"]]) : "",
        endTime: idx["끝시간"] >= 0 ? normTime(r[idx["끝시간"]]) : "",
        title: idx["제목"] >= 0 ? (r[idx["제목"]] || "").trim() : "",
        memo: idx["메모"] >= 0 ? (r[idx["메모"]] || "").trim() : "",
      })).filter((x) => x.companies && x.date);
      if (!items.length) return K.toast("가져올 일정이 없습니다. 날짜 형식(2026-09-23)을 확인해 주세요.", true);
      if (!(await K.confirm(items.length + "건을 가져올까요?", "가져오기"))) return;
      try {
        await store.createMany(items);
        events = store.cached();
        refresh();
        K.toast(items.length + "건을 가져왔습니다.");
      } catch (err) {
        K.toast("가져오지 못했습니다: " + err.message, true);
      }
    };
    input.click();
  }

  /* ---------- 이벤트 ---------- */
  $("#add-btn").addEventListener("click", () => openEditor(null));
  $("#view-calendar").addEventListener("click", () => {
    state.view = "calendar";
    K.prefs.set("cal.view", state.view);
    render();
  });
  $("#view-list").addEventListener("click", () => {
    state.view = "list";
    K.prefs.set("cal.view", state.view);
    render();
  });
  $("#cal-prev").addEventListener("click", () => {
    state.anchor = K.addDays(state.anchor, -WEEKS * 7);
    render();
  });
  $("#cal-next").addEventListener("click", () => {
    state.anchor = K.addDays(state.anchor, WEEKS * 7);
    render();
  });
  $("#cal-today").addEventListener("click", () => {
    state.anchor = K.startOfWeek(K.today(), true);
    render();
  });
  filtersToggle.addEventListener("click", () => {
    const open = filters.hidden;
    filters.hidden = !open;
    filtersToggle.setAttribute("aria-expanded", String(open));
  });
  [["#f-broker", "broker"], ["#f-location", "location"], ["#f-q", "q"]].forEach(([sel, key]) => {
    $(sel).addEventListener("input", () => {
      state[key] = $(sel).value.trim();
      render();
    });
  });
  $("#f-reset").addEventListener("click", () => {
    state.broker = state.location = state.q = "";
    $("#f-broker").value = $("#f-location").value = $("#f-q").value = "";
    render();
  });
  $("#cal-legend").addEventListener("change", (e) => {
    const cb = e.target.closest(".cal-legend__check");
    if (!cb) return;
    if (cb.checked) state.types.add(cb.value);
    else state.types.delete(cb.value);
    K.prefs.set("cal.types", Array.from(state.types));
    render();
  });
  $("#legend-all").addEventListener("click", () => {
    const all = K.IR_TYPES.every((t) => state.types.has(t[0]));
    state.types = new Set(all ? [] : K.IR_TYPES.map((t) => t[0]));
    K.prefs.set("cal.types", Array.from(state.types));
    render();
  });

  grid.addEventListener("click", (e) => {
    const chip = e.target.closest(".ev-chip");
    if (chip) {
      const day = chip.closest(".cal-cell").getAttribute("data-date");
      const ids = eventsOn(day).map((x) => x.id);
      openView(ids, ids.indexOf(chip.getAttribute("data-id")));
      return;
    }
    const more = e.target.closest("[data-more]");
    if (more) {
      const day = more.getAttribute("data-more");
      if (state.expanded.has(day)) state.expanded.delete(day);
      else state.expanded.add(day);
      renderCalendar();
      return;
    }
    const cell = e.target.closest(".cal-cell");
    if (cell && e.target.closest(".cal-cell__events") === null) openEditor(null, { date: cell.getAttribute("data-date") });
  });
  listView.addEventListener("click", (e) => {
    const row = e.target.closest(".agenda-row");
    if (!row) return;
    const ids = Array.from(listView.querySelectorAll(".agenda-row")).map((r) => r.getAttribute("data-id"));
    openView(ids, ids.indexOf(row.getAttribute("data-id")));
  });
  $("#cday-list").addEventListener("click", (e) => {
    const card = e.target.closest(".cday-card");
    if (!card) return;
    const groups = JSON.parse($("#cday").dataset.groups || "[]");
    openView(groups[Number(card.getAttribute("data-group"))] || [], 0);
  });
  $("#cday-list").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest(".cday-card")) {
      e.preventDefault();
      e.target.click();
    }
  });
  $("#cday-date").addEventListener("change", renderCday);

  coInput.addEventListener("input", showCoList);
  coInput.addEventListener("focus", showCoList);
  coInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = coInput.value.trim();
      if (!v) return;
      const exact = Array.from(companyCounts().keys()).find((n) => n === v);
      pickCompany(exact || v, !exact);
    } else if (e.key === "Escape") coList.hidden = true;
  });
  $("#cosearch-btn").addEventListener("click", () => {
    const v = coInput.value.trim();
    if (v) pickCompany(v, !companyCounts().has(v));
  });
  coList.addEventListener("click", (e) => {
    const it = e.target.closest(".cosearch__item");
    if (!it) return;
    if (it.hasAttribute("data-like")) pickCompany(it.getAttribute("data-like"), true);
    else pickCompany(it.getAttribute("data-co"), false);
  });
  document.addEventListener("click", (e) => {
    if (!cosearch.contains(e.target)) coList.hidden = true;
  });
  coNote.addEventListener("click", (e) => {
    if (!e.target.closest("#co-reset")) return;
    state.company = state.companyLike = "";
    coInput.value = "";
    state.anchor = K.startOfWeek(K.today(), true);
    render();
  });

  document.addEventListener("click", (e) => {
    const id = e.target.closest("a[id^='csv-']");
    if (!id) return;
    e.preventDefault();
    if (id.id === "csv-export") exportCsv();
    else if (id.id === "csv-import") importCsv();
    else K.saveText("IR일정_양식.csv", K.toCsv([CSV_HEAD, ["콥데이", "삼성전자", "KB증권", "여의도", "2026-09-23", "", "09:00", "17:00", "", ""]]), "text/csv;charset=utf-8");
  });

  // 이미지를 페이지에 끌어다 놓으면 그 이미지로 새 일정 등록
  let dragDepth = 0;
  let overlay = null;
  function hasImage(e) {
    return Array.from((e.dataTransfer && e.dataTransfer.items) || []).some((it) => it.kind === "file" && it.type.startsWith("image/"));
  }
  document.addEventListener("dragenter", (e) => {
    if (!hasImage(e) || K.isModalOpen()) return;
    dragDepth++;
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "drop-overlay";
      overlay.innerHTML = '<div class="drop-overlay__box"><span class="drop-overlay__icon">🖼</span>안내 이미지를 놓으면 새 일정으로 등록합니다<br><small>기업·날짜는 직접 입력해 주세요</small></div>';
      document.body.appendChild(overlay);
    }
  });
  document.addEventListener("dragleave", () => {
    if (--dragDepth <= 0 && overlay) {
      overlay.remove();
      overlay = null;
      dragDepth = 0;
    }
  });
  document.addEventListener("dragover", (e) => {
    if (hasImage(e)) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    dragDepth = 0;
    const file = Array.from((e.dataTransfer && e.dataTransfer.files) || []).find((f) => f.type.startsWith("image/"));
    if (!file || K.isModalOpen()) return;
    e.preventDefault();
    openEditor(null, { posterBlob: file });
  });

  /* ---------- 시작 ---------- */
  async function refresh() {
    renderDatalists();
    render();
  }
  (async function init() {
    $("#cday-date").value = K.today();
    try {
      events = await store.list();
    } catch (err) {
      K.toast("일정을 불러오지 못했습니다: " + err.message, true);
      events = [];
    }
    const q = new URLSearchParams(location.search);
    if (q.get("company")) {
      coInput.value = q.get("company");
      pickCompany(q.get("company"), false);
    }
    refresh();
    if (q.get("new") === "1") openEditor(null, { date: q.get("date") || K.today() });
    const sess = await K.session();
    if (sess.server && $("#dart-ir-wrap")) {
      $("#dart-ir-wrap").hidden = false;
      $("#dart-ir").addEventListener("click", (e) => {
        e.preventDefault();
        showDartIr();
      });
    }
  })();
})();
