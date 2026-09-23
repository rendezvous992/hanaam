/* 홈 — 오늘·이번 주 IR 일정, 실적발표, 최근 노트, 확인 필요, 내 계정, 웹사이트 변경사항 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const LABEL_TO_TYPE = Object.fromEntries(K.IR_TYPES.map(([k, v]) => [v, k]));
  LABEL_TO_TYPE["탐방"] = "visit";
  LABEL_TO_TYPE["컨퍼런스콜"] = "conference";
  const changelog = K.collection("changelog");

  function row(ev, day, today) {
    return (
      '<li><a class="sched__row' + (day === today ? " sched__row--today" : "") + '" data-type="' + esc(ev.type) + '" href="/calendar/?company=' + encodeURIComponent((ev.companies || "").split(",")[0].trim()) + '">' +
      '<span class="sched__when"><b class="sched__dd">' + K.md(day) + '</b><i class="sched__tt' + (ev.time ? "" : " is-muted") + '">' + esc(ev.time || "시간 미정") + "</i></span>" +
      '<span class="sched__main"><span class="sched__company">' + esc(ev.companies || "기업 미정") + '</span><span class="sched__broker">' + esc(ev.brokers || ev.title || "") + "</span></span>" +
      '<span class="badge badge--' + esc(ev.type) + '">' + esc(K.IR_LABEL[ev.type] || "기타") + "</span></a></li>"
    );
  }

  function renderSchedule(events) {
    const today = K.today();
    const cards = $$(".summary__main .sched");
    const [heroCard, weekCard, earnCard] = cards;
    const nonEarn = events.filter((e) => e.type !== "earnings");

    // 오늘
    const todays = nonEarn.filter((e) => K.eventCovers(e, today)).sort(K.byEventTime);
    $(".sched__chip", heroCard).textContent = todays.length + "건";
    $(".card__meta", heroCard).textContent = K.kLabel(today);
    const heroList = $(".sched__list", heroCard);
    heroList.innerHTML = todays.map((e) => row(e, today, today)).join("");
    if (!todays.length) heroList.insertAdjacentHTML("afterend", '<p class="card__empty" data-home-empty>오늘 등록된 IR 일정이 없습니다. <a href="/calendar/?new=1">일정 추가</a></p>');

    // 이번 주 남은 일정 (내일부터 이번 주 일요일까지, 최대 5건)
    const sun = K.startOfWeek(today, false);
    const sat = K.addDays(sun, 6);
    const weekAll = [];
    for (let d = sun; d <= sat; d = K.addDays(d, 1)) nonEarn.filter((e) => K.eventCovers(e, d)).forEach((e) => weekAll.push([d, e]));
    const rest = weekAll.filter(([d]) => d > today).sort((a, b) => a[0].localeCompare(b[0]) || K.byEventTime(a[1], b[1]));
    $(".card__meta", weekCard).textContent = K.md(sun) + " ~ " + K.md(sat) + " · " + weekAll.length + "건 중 " + Math.min(5, rest.length) + "건";
    const weekList = $(".sched__list", weekCard);
    weekList.innerHTML = rest.slice(0, 5).map(([d, e]) => row(e, d, today)).join("");
    if (!rest.length) weekList.insertAdjacentHTML("afterend", '<p class="card__empty" data-home-empty>이번 주에 남은 일정이 없습니다.</p>');

    // 다가오는 실적발표 (30일)
    const earn = events.filter((e) => e.type === "earnings" && e.date >= today && e.date <= K.addDays(today, 30)).sort(K.byEventTime);
    $(".card__meta", earnCard).textContent = earn.length + "건";
    const empty = $(".card__empty", earnCard);
    if (earn.length) {
      if (empty) empty.remove();
      earnCard.insertAdjacentHTML("beforeend", '<ul class="sched__list">' + earn.slice(0, 6).map((e) => row(e, e.date, today)).join("") + "</ul>");
    }
  }

  function renderNotes(notes) {
    const card = $(".nrec-card");
    const list = notes.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id - a.id);
    const recent = list.slice(0, 8);
    const days = [];
    recent.forEach((n) => {
      const last = days[days.length - 1];
      if (last && last.date === n.date) last.items.push(n);
      else days.push({ date: n.date, items: [n] });
    });
    const latest = days[0];
    $(".card__meta", card).textContent = latest ? K.md(latest.date) + " · " + list.filter((n) => n.date === latest.date).length + "건" : "0건";
    $("ol.nrec", card).innerHTML = days.map((g) =>
      '<li class="nrec__day"><p class="nrec__date' + (g.date === K.today() ? " is-today" : "") + '"> ' + K.md(g.date) + "<span>(" + K.weekdayName(g.date) + ")</span><i>" + g.items.length + "건</i></p>" +
      '<ul class="nrec__list">' + g.items.map((n) =>
        '<li><a class="nrec__row" href="/notes/#note-' + esc(n.id) + '" title="' + esc(n.title) + '"><span class="nrec__co"> ' + esc(n.company) + "<i>" + esc(n.ticker || "") + "</i></span>" +
        '<span class="badge badge--' + esc(LABEL_TO_TYPE[n.type] || "etc") + '">' + esc(n.type || "기타") + "</span>" +
        '<span class="nrec__body"><span class="nrec__title">' + esc(n.title) + '</span><span class="nrec__by">' + esc(n.author || "") + "</span></span></a></li>"
      ).join("") + "</ul></li>"
    ).join("") || '<li class="card__empty">아직 등록된 노트가 없습니다. <a href="/notes/">노트 쓰기</a></li>';
  }

  function renderChecks(ndr, notes) {
    const pending = ndr.filter((x) => x.status === "open").length;
    const lead = $(".checks__lead");
    $(".checks__lead-count", lead).textContent = String(pending);
    lead.classList.toggle("is-zero", !pending);
    const review = notes.filter((n) => n.review).length;
    const rowEl = $(".checks__row");
    $(".checks__count", rowEl).innerHTML = review + "<i>건</i>";
    rowEl.classList.toggle("is-zero", !review);
    return { pending, review };
  }

  function renderMe(session) {
    const name = session.me ? session.me.displayName || session.me.username : K.currentUser();
    $(".signin__name").innerHTML = esc(name) + (session.me && session.me.role === "admin" ? ' <span class="signin__admin">관리자</span>' : "");
    $(".signin__dept").textContent = session.server ? session.me.username : "이 브라우저에 저장하는 모드";
    const lastKey = "home.lastVisit";
    const last = K.prefs.get(lastKey, "");
    $(".signin__last").textContent = last ? "지난 방문 " + last.slice(5).replace("-", "/") : "첫 방문";
    K.prefs.set(lastKey, K.today() + " " + K.nowTime());
    // 프로필 설정·로그아웃
    $$(".signin__actions a").forEach((a) => {
      if (session.server) {
        a.removeAttribute("data-hana-stub");
        a.setAttribute("href", "#account");
        a.setAttribute("data-hana-account", "");
        a.textContent = "비밀번호 변경";
      }
    });
    const avatar = $(".signin__avatar");
    if (avatar) {
      avatar.removeAttribute("data-hana-stub");
      avatar.setAttribute("href", session.server ? "#account" : "/settings/");
      if (session.server) avatar.setAttribute("data-hana-account", "");
    }
  }

  function renderNotify(counts, todayCount) {
    const btn = $("#notify-btn");
    const box = $("#notify");
    const total = counts.pending + counts.review;
    let badge = $(".notify__badge", btn);
    if (total && !badge) {
      badge = document.createElement("span");
      badge.className = "notify__badge";
      btn.appendChild(badge);
    }
    if (badge) {
      badge.textContent = String(total);
      badge.hidden = !total;
    }
    let panel = $(".notify__panel", box);
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "notify__panel";
      panel.id = "notify-panel";
      panel.hidden = true;
      box.appendChild(panel);
    }
    const items = [];
    if (counts.pending) items.push(['/ndr/', "미확정 일정 " + counts.pending + "건이 슬롯 확정을 기다립니다."]);
    if (counts.review) items.push(['/notes/?review=1', "확인이 필요한 노트가 " + counts.review + "건 있습니다."]);
    if (todayCount) items.push(['/calendar/', "오늘 IR 일정이 " + todayCount + "건 있습니다."]);
    panel.innerHTML = '<div class="notify__panel-head"><span class="notify__panel-title">알림</span></div>' +
      (items.length
        ? '<ul class="notify__list">' + items.map(([href, t]) => '<li class="notify__item"><a class="notify__text" href="' + href + '">' + esc(t) + "</a></li>").join("") + "</ul>"
        : '<p class="notify__empty">' + esc(box.getAttribute("data-empty") || "현재 알림이 없습니다.") + "</p>");
  }

  /* ---------- 웹사이트 변경사항 ---------- */
  let logs = [];
  let wnWeek = null;
  function weekKey(ymd) {
    return K.startOfWeek(ymd, true);
  }
  function renderChangelog() {
    const weeks = Array.from(new Set(logs.map((x) => weekKey(x.date)))).sort().reverse().slice(0, 4);
    if (!wnWeek || !weeks.includes(wnWeek)) wnWeek = weeks[0] || weekKey(K.today());
    $("#whatsnew-tabs").innerHTML = weeks.map((w) => '<button type="button" class="whatsnew__tab' + (w === wnWeek ? " is-active" : "") + '" role="tab" data-week="' + w + '">' + K.md(w) + "주</button>").join("");
    const list = logs.filter((x) => weekKey(x.date) === wnWeek).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    $("#whatsnew-panels").innerHTML =
      '<p class="whatsnew__range">' + K.md(wnWeek) + " ~ " + K.md(K.addDays(wnWeek, 6)) + "</p>" +
      (list.length
        ? '<ul class="whatsnew__list">' + list.map((x) => '<li class="whatsnew__item"><span class="whatsnew__text">[' + esc(x.kind || "개선") + "] " + esc(x.text) +
          '</span><button type="button" class="whatsnew__del" data-del="' + esc(x.id) + '" aria-label="삭제">×</button></li>').join("") + "</ul>"
        : '<p class="card__empty">이 주에는 변경사항이 없습니다.</p>') +
      '<form class="whatsnew__form" id="wn-form"><div class="whatsnew__form-row"><select class="input input--compact" id="wn-kind"><option>추가</option><option>개선</option><option>수정</option></select>' +
      '<input class="input input--compact" id="wn-text" maxlength="200" placeholder="변경사항 한 줄"></div><div class="whatsnew__form-row"><button type="submit" class="btn btn--ghost btn--sm">변경사항 남기기</button></div></form>';
  }
  document.addEventListener("click", async (e) => {
    const tab = e.target.closest(".whatsnew__tab");
    if (tab) {
      wnWeek = tab.getAttribute("data-week");
      renderChangelog();
      return;
    }
    const del = e.target.closest(".whatsnew__del");
    if (del) {
      if (!(await K.confirm("이 변경사항을 지울까요?", "삭제", true))) return;
      await changelog.remove(del.getAttribute("data-del")).catch((err) => K.toast(err.message, true));
      logs = changelog.cached();
      renderChangelog();
      return;
    }
    const nb = e.target.closest("#notify-btn");
    if (nb) {
      const panel = $("#notify-panel");
      panel.hidden = !panel.hidden;
      nb.setAttribute("aria-expanded", String(!panel.hidden));
    } else if (!e.target.closest("#notify")) {
      const panel = $("#notify-panel");
      if (panel) panel.hidden = true;
    }
  });
  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "wn-form") return;
    e.preventDefault();
    const text = $("#wn-text").value.trim();
    if (!text) return;
    try {
      await changelog.create({ date: K.today(), kind: $("#wn-kind").value, text });
      logs = changelog.cached();
      wnWeek = weekKey(K.today());
      renderChangelog();
    } catch (err) {
      K.toast(err.message, true);
    }
  });

  (async function init() {
    const session = await K.session();
    renderMe(session);
    const [events, ndr, notes] = await Promise.all([
      K.irEvents().list().catch(() => []),
      K.collection("ndr-proposals").list().catch(() => []),
      K.readNotes(),
    ]);
    renderSchedule(events);
    renderNotes(notes);
    const counts = renderChecks(ndr, notes);
    renderNotify(counts, events.filter((e) => e.type !== "earnings" && K.eventCovers(e, K.today())).length);
    logs = await changelog.list().catch(() => []);
    renderChangelog();
  })();
})();
