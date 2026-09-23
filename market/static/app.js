/* 시장 — 국내 지수·관심 종목 시세(30초마다), 관심 종목 관리·메모, 팀 시황 메모, 기사 링크 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const watchStore = K.collection("watchlist");
  const briefStore = K.collection("market-briefs");
  const newsStore = K.collection("market-news");
  const uniStore = K.collection("discover-universe");
  const INDEXES = ["KOSPI", "KOSDAQ", "KPI200"];
  const REFRESH_MS = 30000;

  let session = { server: false };
  let watchlist = [];
  let briefs = [];
  let news = [];
  let uniRows = [];
  let quotes = new Map(); // 코드 → 시세
  let quotesAt = "";
  let quoteErr = "";
  let lastOk = 0;
  let timer = null;
  const st = {
    market: K.prefs.get("market.market", "all"),
    list: K.prefs.get("market.list", "order"),
    sector: "",
    brief: K.prefs.get("market.brief", "morning"),
    briefId: "",
    news: "all",
    newsPage: 0,
  };

  /* ---------- 공통 도구 ---------- */
  function normMarket(m) {
    const s = String(m || "").toUpperCase();
    if (/KOSDAQ|코스닥|KQ/.test(s)) return "KOSDAQ";
    if (/KOSPI|코스피|유가|KS/.test(s)) return "KOSPI";
    if (/KONEX|코넥스/.test(s)) return "KONEX";
    return "";
  }
  const MARKET_LABEL = { KOSPI: "코스피", KOSDAQ: "코스닥", KONEX: "코넥스" };
  const isCode = (s) => /^[0-9A-Z]{6}$/.test(String(s || ""));
  const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
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
  const dir = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
  const signed = (v, d) => (v == null || isNaN(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + K.num(Math.abs(v), d));
  const rate = (v) => (v == null || isNaN(v) ? "—" : signed(v, 2) + "%");
  function statusLabel(status) {
    const s = String(status || "").toUpperCase();
    if (/PRE/.test(s)) return "장 시작 전";
    if (/OPEN/.test(s)) return "장중";
    if (/CLOSE/.test(s)) return "장 마감";
    return clockStatus();
  }
  // 시세 상태가 없을 때 시계로 짐작 (공휴일은 모름)
  function clockStatus() {
    const wd = K.weekday(K.today());
    const t = K.nowTime();
    if (wd === 0 || wd === 6) return "휴장";
    if (t < "09:00") return "장 시작 전";
    if (t <= "15:30") return "장중";
    return "장 마감";
  }
  function timeOf(q) {
    const s = (q && q.time && K.isoKst(q.time)) || "";
    return s ? s.slice(5).replace("-", "/") : "";
  }

  /* ---------- 지수 ---------- */
  function renderIndexes() {
    $$("#market-list .market__item").forEach((li) => {
      const key = li.getAttribute("data-key");
      const q = quotes.get(key);
      const v = $('[data-role="value"]', li);
      const c = $('[data-role="change"]', li);
      const t = $('[data-role="time"]', li);
      if (!q || q.price == null) {
        li.setAttribute("data-direction", "flat");
        v.textContent = "—";
        c.textContent = "";
        t.textContent = session.server ? (quoteErr ? "시세 연결 안 됨" : "불러오는 중…") : "시세 미연결 (서버 모드에서 연결)";
        li.title = "";
        return;
      }
      li.setAttribute("data-direction", dir(q.change));
      li.setAttribute("data-delayed", String(!!quoteErr));
      v.textContent = K.num(q.price, 2);
      c.textContent = signed(q.change, 2) + " (" + rate(q.changeRate) + ")";
      t.textContent = (timeOf(q) || "") + " · " + statusLabel(q.status);
      li.title = (q.name || key) + " · " + (timeOf(q) || "") + " KST";
    });
    const hint = $("#market-hint");
    const idx = quotes.get("KOSPI");
    hint.textContent = session.server
      ? "국내 장 상태: " + (idx ? statusLabel(idx.status) : clockStatus()) + " · 시세 제공 시각은 한국시간(KST) · 30초 간격 확인" + (quotesAt ? " · 마지막 확인 " + K.isoKst(quotesAt).slice(11) : "")
      : "브라우저 저장 모드에서는 시세가 없습니다. 서버 모드에서 연결됩니다. · 지금 국내 장 상태(시계 기준): " + clockStatus();
  }
  function renderIndicators() {
    $("#indicator-grid").innerHTML = '<p class="card__empty" style="grid-column:1/-1">해외 지수·금리·원자재 시세는 아직 연결되지 않았습니다. 서버 시세는 국내 지수(KOSPI·KOSDAQ·KOSPI 200)와 국내 종목만 제공합니다.</p>';
    $("#indicator-source").textContent = "연결 안 됨 · 관리자가 해외 시세 자료를 연결하면 이곳에 표시됩니다.";
  }

  /* ---------- 관심 종목 표 ---------- */
  function sectorOf(w) {
    if (w.sector) return w.sector;
    const r = uniRows.find((x) => (w.code && x.code === w.code) || norm(x.name) === norm(w.name));
    return (r && r.sector) || "";
  }
  function visibleRows() {
    let rows = watchlist.map((w, i) => Object.assign({ _i: i, q: w.code ? quotes.get(w.code) : null, _sector: sectorOf(w) }, w));
    if (st.market !== "all") rows = rows.filter((r) => normMarket(r.market) === st.market);
    if (st.sector) rows = rows.filter((r) => r._sector === st.sector);
    const cr = (r) => (r.q && r.q.changeRate != null ? r.q.changeRate : null);
    if (st.list === "gainers") rows = rows.filter((r) => cr(r) > 0).sort((a, b) => cr(b) - cr(a));
    else if (st.list === "losers") rows = rows.filter((r) => cr(r) < 0).sort((a, b) => cr(a) - cr(b));
    else if (st.list === "memo") rows = rows.filter((r) => (r.memo || "").trim());
    return rows;
  }
  function renderTable() {
    $$("#mv-markets .segmented__btn").forEach((b) => {
      const on = b.getAttribute("data-market") === st.market;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    $$("#mv-tabs .segmented__btn").forEach((b) => {
      const on = b.getAttribute("data-list") === st.list;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    const rows = visibleRows();
    const tbody = $("#mv-body tbody");
    if (!watchlist.length) {
      tbody.innerHTML = '<tr><td colspan="8"><p class="card__empty">아직 관심 종목이 없습니다. <button type="button" class="btn btn--primary btn--sm" data-wl-add>+ 관심 종목 추가</button></p></td></tr>';
    } else if (!rows.length) {
      const why = st.list === "memo" ? "메모를 남긴 종목이 없습니다." : (st.list === "gainers" || st.list === "losers") && !quotes.size ? "시세가 있어야 상승·하락 종목을 고를 수 있습니다." : "조건에 맞는 종목이 없습니다.";
      tbody.innerHTML = '<tr><td colspan="8"><p class="card__empty">' + esc(why) + "</p></td></tr>";
    } else {
      tbody.innerHTML = rows.map((r) => {
        const q = r.q;
        const has = q && q.price != null;
        const d = has ? dir(q.change) : "flat";
        const link = "/company/?" + (r.code ? "code=" + encodeURIComponent(r.code) : "q=" + encodeURIComponent(r.name));
        return '<tr class="mv__row" data-id="' + esc(r.id) + '">' +
          '<td class="mv__name"><a href="' + link + '">' + esc(r.name) + '</a><span class="mv__code">' + esc([r.code || "코드 없음", MARKET_LABEL[normMarket(r.market)] || "", r._sector].filter(Boolean).join(" · ")) + "</span></td>" +
          '<td class="mv__n' + (has ? "" : " is-dim") + '">' + (has ? K.num(q.price) : "—") + "</td>" +
          '<td class="mv__n" data-direction="' + d + '">' + (has ? signed(q.change) : "—") + "</td>" +
          '<td class="mv__n" data-direction="' + d + '">' + (has ? rate(q.changeRate) : "—") + "</td>" +
          '<td class="mv__n is-dim">' + (has ? esc(statusLabel(q.status)) : session.server ? (r.code ? "—" : "코드 필요") : "—") + "</td>" +
          '<td class="mv__n is-dim">' + (has ? esc(timeOf(q) || "—") : "—") + "</td>" +
          '<td class="mv__memo"><button type="button" class="mv__memo-btn" data-wl-memo="' + esc(r.id) + '" title="메모 고치기">' + (r.memo ? esc(r.memo) : '<span class="is-dim">+ 메모</span>') + "</button></td>" +
          '<td class="mv__n"><button type="button" class="btn btn--ghost btn--sm" data-wl-edit="' + esc(r.id) + '">수정</button> ' +
          '<button type="button" class="btn btn--danger btn--sm" data-wl-del="' + esc(r.id) + '">삭제</button></td></tr>';
      }).join("");
    }
    // 표 아래 안내
    const note = $("#mv-note");
    const priced = watchlist.filter((w) => w.code && quotes.get(w.code)).length;
    let text = "관심 종목 " + watchlist.length + "개" + (rows.length !== watchlist.length ? " 중 " + rows.length + "개 표시" : "");
    if (!session.server) text += " · 브라우저 저장 모드에서는 시세가 없습니다 (서버 모드에서 연결). 관심 종목 관리만 할 수 있습니다.";
    else if (quoteErr && lastOk) text += " · 마지막 갱신 실패 — " + K.isoKst(new Date(lastOk).toISOString()).slice(11) + " 값을 보여 줍니다 (" + quoteErr + ")";
    else if (quoteErr) text += " · " + quoteErr;
    else if (watchlist.length) text += " · 시세 " + priced + "개";
    const noCode = watchlist.filter((w) => !w.code).length;
    if (noCode && session.server) text += " · 종목코드가 없는 " + noCode + "개는 시세를 볼 수 없습니다";
    note.textContent = text;
    note.setAttribute("data-stale", quoteErr && lastOk ? "1" : "0");
    const idx = quotes.get("KOSPI");
    $("#mv-stamp").textContent = session.server
      ? (quotesAt ? K.isoKst(quotesAt).slice(11) + " 기준 · " : "") + (idx ? statusLabel(idx.status) : clockStatus())
      : "시세 미연결";
    renderSectors();
  }
  // 섹터별 평균 등락률 막대 (누르면 그 섹터만)
  function renderSectors() {
    const box = $("#mv-sectors");
    const g = new Map();
    watchlist.forEach((w) => {
      const s = sectorOf(w);
      const q = w.code && quotes.get(w.code);
      if (!s || !q || q.changeRate == null) return;
      if (!g.has(s)) g.set(s, []);
      g.get(s).push(q.changeRate);
    });
    if (!g.size) {
      box.innerHTML = st.sector ? '<p class="mv__note">섹터 필터: ' + esc(st.sector) + ' <button type="button" class="mv__more" data-sector-clear>해제</button></p>' : "";
      return;
    }
    const rows = Array.from(g.entries()).map(([s, v]) => [s, v.reduce((a, b) => a + b, 0) / v.length, v.length]).sort((a, b) => b[1] - a[1]);
    const max = Math.max(0.5, ...rows.map((r) => Math.abs(r[1])));
    box.innerHTML = '<p class="brief__chart-title">섹터별 평균 등락률 (관심 종목)' + (st.sector ? ' · <button type="button" class="mv__more" data-sector-clear>필터 해제</button>' : "") + "</p>" +
      rows.map(([s, avg, n]) =>
        '<div class="mv__srow" data-direction="' + dir(avg) + '" data-sector="' + esc(s) + '" title="' + esc(s) + " · " + n + '종목"' + (st.sector && st.sector !== s ? ' style="opacity:.45"' : "") + ">" +
        '<span class="mv__sname">' + esc(s) + ' <span class="is-dim">' + n + "</span></span>" +
        '<span class="mv__strack"><span class="mv__sfill" style="width:' + Math.max(1, (Math.abs(avg) / max) * 50).toFixed(1) + '%"></span></span>' +
        '<span class="mv__sval">' + rate(avg) + "</span></div>"
      ).join("");
  }

  /* ---------- 시세 불러오기 ---------- */
  async function refresh() {
    if (!session.server) return;
    const codes = INDEXES.concat(Array.from(new Set(watchlist.map((w) => w.code).filter(isCode))));
    try {
      const next = new Map();
      let at = "";
      for (let i = 0; i < codes.length; i += 100) {
        const data = await getJson("/api/quotes?codes=" + encodeURIComponent(codes.slice(i, i + 100).join(",")));
        (data.items || []).forEach((q) => next.set(q.code, q));
        at = data.at || at;
      }
      quotes = next;
      quotesAt = at;
      quoteErr = "";
      lastOk = Date.now();
    } catch (err) {
      quoteErr = err.code === "not_connected" ? "시세 연결 안 됨: " + err.message : err.message;
    }
    renderIndexes();
    renderTable();
  }
  function schedule() {
    clearInterval(timer);
    if (!session.server) return;
    timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && session.server && Date.now() - lastOk > REFRESH_MS) refresh();
  });

  /* ---------- 관심 종목 추가·수정 ---------- */
  function localSuggest(q) {
    const nq = norm(q);
    if (!nq) return [];
    const seen = new Set();
    const out = [];
    uniRows.forEach((r) => {
      if (out.length >= 12) return;
      if ((norm(r.name).includes(nq) || (r.code || "").startsWith(q.toUpperCase())) && !seen.has(r.code || r.name)) {
        seen.add(r.code || r.name);
        out.push({ code: r.code || "", name: r.name, market: r.market || "", sector: r.sector || "" });
      }
    });
    return out;
  }
  function openEditor(existing) {
    const w = Object.assign({ name: "", code: "", market: "", sector: "", memo: "" }, existing || {});
    const html =
      '<form class="modal__body" id="wl-form" novalidate>' +
      (existing ? "" :
        '<label class="field"><span class="field__label">종목 검색 <span class="field__label-note">' + (session.server ? "이름이나 코드로 찾기" : "브라우저 모드: 종목 발굴에 올린 표에서 찾기") + '</span></span>' +
        '<input class="input" name="q" autocomplete="off" placeholder="예: 반도체, 005930"></label>' +
        '<ul class="mv-pick" data-results></ul>') +
      '<div class="field-row"><label class="field"><span class="field__label">종목명 <em class="required">*</em></span><input class="input" name="name" value="' + esc(w.name) + '" maxlength="60"></label>' +
      '<label class="field"><span class="field__label">종목코드 <span class="field__label-note">6자리 · 시세에 필요</span></span><input class="input" name="code" value="' + esc(w.code) + '" maxlength="6" inputmode="numeric" placeholder="예: 000000"></label></div>' +
      '<div class="field-row"><label class="field"><span class="field__label">시장</span><select class="input" name="market">' +
      [["", "모름"], ["KOSPI", "코스피"], ["KOSDAQ", "코스닥"], ["KONEX", "코넥스"]].map(([v, l]) => '<option value="' + v + '"' + (normMarket(w.market) === v ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>" +
      '<label class="field"><span class="field__label">섹터 <span class="field__label-note">선택</span></span><input class="input" name="sector" value="' + esc(w.sector) + '" maxlength="30"></label></div>' +
      '<label class="field"><span class="field__label">메모</span><textarea class="input input--textarea" name="memo" maxlength="500" placeholder="보는 이유, 목표가, 확인할 일정 등">' + esc(w.memo) + "</textarea></label>" +
      '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-cancel>취소</button><button type="submit" class="btn btn--primary">' + (existing ? "저장" : "추가") + "</button></div></div></form>";
    const ctx = K.modal({ title: existing ? "관심 종목 수정" : "관심 종목 추가", size: "modal--wide", html, focus: existing ? '[name="memo"]' : '[name="q"]' });
    const form = $("#wl-form", ctx.modal);
    const f = (n) => form.elements[n];
    let found = [];
    let seq = 0;
    let t = null;
    function drawResults(items, note) {
      found = items;
      const ul = $("[data-results]", form);
      if (!ul) return;
      ul.innerHTML = items.map((it, i) => '<li><button type="button" class="mv-pick__item" data-pick="' + i + '"><b>' + esc(it.name) + "</b><span>" + esc([it.code, MARKET_LABEL[normMarket(it.market)] || it.market || ""].filter(Boolean).join(" · ")) + "</span></button></li>").join("") +
        (note ? '<li class="mv-pick__note">' + esc(note) + "</li>" : "");
    }
    form.addEventListener("input", (e) => {
      if (e.target.name !== "q") return;
      clearTimeout(t);
      const q = e.target.value.trim();
      t = setTimeout(async () => {
        const my = ++seq;
        if (!q) return drawResults([]);
        const local = localSuggest(q);
        if (!session.server) return drawResults(local, local.length ? "" : "찾은 종목이 없습니다. 아래에 직접 적어 주세요.");
        drawResults(local, "검색 중…");
        try {
          const data = await getJson("/api/stock-search?q=" + encodeURIComponent(q));
          if (my !== seq) return;
          const items = (data.items || []).map((x) => ({ code: x.code, name: x.name, market: normMarket(x.market) || x.market }));
          const merged = items.concat(local.filter((l) => !items.some((x) => x.code === l.code)));
          drawResults(merged, data.offline ? "외부 종목 검색 연결 안 됨 · 아래에 직접 적어 주세요." : merged.length ? "" : "찾은 종목이 없습니다.");
        } catch (err) {
          if (my === seq) drawResults(local, "종목 검색 실패: " + err.message);
        }
      }, 200);
    });
    form.addEventListener("click", (e) => {
      if (e.target.closest("[data-cancel]")) return ctx.close();
      const p = e.target.closest("[data-pick]");
      if (!p) return;
      const it = found[Number(p.getAttribute("data-pick"))];
      f("name").value = it.name;
      f("code").value = it.code || "";
      f("market").value = normMarket(it.market);
      if (it.sector && !f("sector").value) f("sector").value = it.sector;
      drawResults([]);
      f("memo").focus();
    });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.name === "q") {
        e.preventDefault();
        if (found.length) $("[data-pick='0']", form).click();
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = {
        name: f("name").value.trim(),
        code: f("code").value.trim().toUpperCase(),
        market: f("market").value,
        sector: f("sector").value.trim(),
        memo: f("memo").value.trim(),
      };
      if (!data.name) return K.toast("종목명을 적어 주세요.", true), f("name").focus();
      if (data.code && !isCode(data.code)) return K.toast("종목코드는 6자리입니다.", true), f("code").focus();
      const dup = watchlist.find((x) => x.id !== w.id && ((data.code && x.code === data.code) || norm(x.name) === norm(data.name)));
      if (dup) return K.toast(dup.name + " 은(는) 이미 관심 종목에 있습니다.", true);
      try {
        if (existing) await watchStore.update(existing.id, data);
        else await watchStore.create(data);
        watchlist = watchStore.cached().slice();
        ctx.close(true);
        K.toast(existing ? "저장했습니다." : data.name + " 을(를) 관심 종목에 넣었습니다.");
        renderTable();
        if (!existing && data.code) refresh();
      } catch (err) {
        K.toast(err.message, true);
      }
    });
  }
  function openMemo(w) {
    const ctx = K.modal({
      title: "메모 · " + w.name,
      size: "modal--narrow",
      focus: "textarea",
      html: '<form class="modal__body" id="memo-form"><label class="field"><span class="field__label">메모</span><textarea class="input input--textarea" name="memo" maxlength="500">' + esc(w.memo || "") + "</textarea></label>" +
        '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-cancel>취소</button><button type="submit" class="btn btn--primary">저장</button></div></div></form>',
    });
    const form = $("#memo-form", ctx.modal);
    form.addEventListener("click", (e) => {
      if (e.target.closest("[data-cancel]")) ctx.close();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await watchStore.update(w.id, { memo: form.elements.memo.value.trim() });
        watchlist = watchStore.cached().slice();
        ctx.close(true);
        renderTable();
      } catch (err) {
        K.toast(err.message, true);
      }
    });
  }

  /* ---------- 시황 (팀이 쓰는 메모) ---------- */
  const SESSION_LABEL = { morning: "국내 모닝", global: "글로벌 마감" };
  const briefSwitch = $(".brief__switch");
  briefSwitch.insertAdjacentHTML("beforeend", '<div class="brief__actions"><select class="input input--compact" id="brief-pick" aria-label="지난 시황" style="min-width:120px"></select>' +
    '<button type="button" class="btn btn--primary btn--sm" id="brief-new">작성</button><button type="button" class="btn btn--ghost btn--sm" id="brief-edit">수정</button>' +
    '<button type="button" class="btn btn--danger btn--sm" id="brief-del">삭제</button></div>');
  function mdToHtml(text) {
    const lines = String(text || "").split(/\r?\n/);
    let html = "";
    let inList = false;
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    lines.forEach((ln) => {
      const t = ln.trim();
      const li = /^[-*•]\s+(.*)$/.exec(t);
      if (li) {
        if (!inList) html += "<ul>";
        inList = true;
        html += "<li>" + inline(li[1]) + "</li>";
        return;
      }
      if (inList) html += "</ul>";
      inList = false;
      const h = /^#{1,3}\s+(.*)$/.exec(t);
      if (h) html += "<h3>" + inline(h[1]) + "</h3>";
      else if (t) html += "<p>" + inline(t) + "</p>";
    });
    if (inList) html += "</ul>";
    return html;
  }
  function briefList() {
    return briefs.filter((b) => (b.session || "morning") === st.brief).sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
  }
  function renderBrief() {
    $$("#brief-tabs .brief__tab").forEach((b) => {
      const on = b.getAttribute("data-session") === st.brief;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    const list = briefList();
    const cur = list.find((b) => b.id === st.briefId) || list[0];
    st.briefId = cur ? cur.id : "";
    const pick = $("#brief-pick");
    pick.innerHTML = list.length ? list.map((b) => '<option value="' + esc(b.id) + '"' + (b === cur ? " selected" : "") + ">" + esc(K.dot(b.date)) + "</option>").join("") : "<option>기록 없음</option>";
    pick.disabled = list.length < 2;
    $("#brief-edit").style.display = cur ? "" : "none";
    $("#brief-del").style.display = cur ? "" : "none";
    const head = $("#brief-headline");
    const body = $("#brief-body");
    if (!cur) {
      head.classList.add("is-empty");
      head.textContent = "아직 작성된 " + SESSION_LABEL[st.brief] + " 시황이 없습니다. ‘작성’으로 오늘 시황을 남겨 주세요.";
      body.innerHTML = "";
      body.hidden = true;
      $("#brief-meta").textContent = "";
      return;
    }
    head.classList.remove("is-empty");
    head.textContent = cur.headline || "(요약 없음)";
    body.innerHTML = mdToHtml(cur.body);
    body.hidden = !cur.body;
    $("#brief-meta").textContent = K.kLabel(cur.date) + (cur.createdBy ? " · " + cur.createdBy : "") + (cur.date === K.today() ? " · 오늘" : "");
  }
  function openBriefEditor(existing) {
    const b = Object.assign({ session: st.brief, date: K.today(), headline: "", body: "" }, existing || {});
    const ctx = K.modal({
      title: (existing ? "시황 수정" : "시황 작성") + " · " + SESSION_LABEL[b.session],
      size: "modal--wide",
      focus: '[name="headline"]',
      html: '<form class="modal__body" id="brief-form" novalidate><div class="field-row">' +
        '<label class="field"><span class="field__label">종류</span><select class="input" name="session"><option value="morning"' + (b.session === "morning" ? " selected" : "") + '>국내 모닝</option><option value="global"' + (b.session === "global" ? " selected" : "") + ">글로벌 마감</option></select></label>" +
        '<label class="field"><span class="field__label">날짜</span><input class="input" type="date" name="date" value="' + esc(b.date) + '"></label></div>' +
        '<label class="field"><span class="field__label">한 줄 요약 <em class="required">*</em></span><input class="input" name="headline" maxlength="200" value="' + esc(b.headline) + '"></label>' +
        '<label class="field"><span class="field__label">본문 <span class="field__label-note">“- ” 로 시작하면 목록, “## ” 는 소제목, **굵게**</span></span><textarea class="input input--textarea" name="body" rows="10">' + esc(b.body) + "</textarea></label>" +
        '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-cancel>취소</button><button type="submit" class="btn btn--primary">저장</button></div></div></form>',
    });
    const form = $("#brief-form", ctx.modal);
    form.addEventListener("click", (e) => {
      if (e.target.closest("[data-cancel]")) ctx.close();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const el = form.elements;
      const data = { session: el.session.value, date: el.date.value || K.today(), headline: el.headline.value.trim(), body: el.body.value.trim() };
      if (!data.headline) return K.toast("한 줄 요약을 적어 주세요.", true), el.headline.focus();
      try {
        const saved = existing ? await briefStore.update(existing.id, data) : await briefStore.create(data);
        briefs = briefStore.cached().slice();
        st.brief = data.session;
        st.briefId = saved.id;
        K.prefs.set("market.brief", st.brief);
        ctx.close(true);
        renderBrief();
      } catch (err) {
        K.toast(err.message, true);
      }
    });
  }

  /* ---------- 기사 링크 ---------- */
  const NEWS_LABEL = { kr: "국내 증시", global: "해외 증시" };
  const PAGE = 5;
  $("#news .card__head .news__nav").insertAdjacentHTML("beforebegin", '<button type="button" class="btn btn--ghost btn--sm" id="news-add">+ 링크</button>');
  function renderNews() {
    $$("#news-tabs .news__tab").forEach((b) => {
      const on = b.getAttribute("data-sector") === st.news;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    const list = news.filter((n) => st.news === "all" || n.sector === st.news).sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    st.newsPage = Math.min(st.newsPage, pages - 1);
    const shown = list.slice(st.newsPage * PAGE, st.newsPage * PAGE + PAGE);
    $("#news-list").innerHTML = shown.length
      ? shown.map((n) => '<li class="news__item"><a class="news__title" href="' + esc(n.url) + '" target="_blank" rel="noopener noreferrer">' + esc(n.title) + "</a>" +
        '<p class="news__meta">' + esc([n.source, NEWS_LABEL[n.sector], K.md(n.date), n.createdBy].filter(Boolean).join(" · ")) +
        ' <button type="button" class="news__del" data-news-del="' + esc(n.id) + '" aria-label="링크 삭제">삭제</button></p></li>').join("")
      : '<li class="card__empty">남긴 기사 링크가 없습니다. ‘+ 링크’로 함께 볼 기사를 남겨 주세요.</li>';
    $("#news-index").textContent = list.length ? st.newsPage + 1 + "/" + pages : "0/0";
    $("#news-prev").disabled = st.newsPage <= 0;
    $("#news-next").disabled = st.newsPage >= pages - 1;
    $("#news-meta").textContent = list.length + "건";
  }
  function openNewsEditor() {
    const ctx = K.modal({
      title: "기사 링크 남기기",
      size: "modal--narrow",
      focus: '[name="url"]',
      html: '<form class="modal__body" id="news-form" novalidate>' +
        '<label class="field"><span class="field__label">주소 <em class="required">*</em></span><input class="input" name="url" type="url" placeholder="https://"></label>' +
        '<label class="field"><span class="field__label">제목 <em class="required">*</em></span><input class="input" name="title" maxlength="200"></label>' +
        '<div class="field-row"><label class="field"><span class="field__label">출처</span><input class="input" name="source" maxlength="40" placeholder="예: 언론사"></label>' +
        '<label class="field"><span class="field__label">분류</span><select class="input" name="sector"><option value="kr">국내 증시</option><option value="global">해외 증시</option></select></label></div>' +
        '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-cancel>취소</button><button type="submit" class="btn btn--primary">남기기</button></div></div></form>',
    });
    const form = $("#news-form", ctx.modal);
    if (st.news !== "all") form.elements.sector.value = st.news;
    form.addEventListener("click", (e) => {
      if (e.target.closest("[data-cancel]")) ctx.close();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const el = form.elements;
      const data = { url: el.url.value.trim(), title: el.title.value.trim(), source: el.source.value.trim(), sector: el.sector.value, date: K.today() };
      if (!/^https?:\/\/\S+$/i.test(data.url)) return K.toast("http:// 또는 https:// 로 시작하는 주소를 넣어 주세요.", true), el.url.focus();
      if (!data.title) return K.toast("제목을 적어 주세요.", true), el.title.focus();
      try {
        await newsStore.create(data);
        news = newsStore.cached().slice();
        st.newsPage = 0;
        ctx.close(true);
        renderNews();
      } catch (err) {
        K.toast(err.message, true);
      }
    });
  }

  /* ---------- 이벤트 ---------- */
  document.addEventListener("click", async (e) => {
    const t = e.target;
    const btn = t.closest("button");
    if (btn && btn.closest("#mv-markets")) {
      st.market = btn.getAttribute("data-market");
      K.prefs.set("market.market", st.market);
      return renderTable();
    }
    if (btn && btn.closest("#mv-tabs")) {
      st.list = btn.getAttribute("data-list");
      K.prefs.set("market.list", st.list);
      return renderTable();
    }
    const srow = t.closest(".mv__srow");
    if (srow) {
      const s = srow.getAttribute("data-sector");
      st.sector = st.sector === s ? "" : s;
      return renderTable();
    }
    if (t.closest("[data-sector-clear]")) {
      st.sector = "";
      return renderTable();
    }
    if (t.closest("[data-wl-add]")) return openEditor(null);
    const ed = t.closest("[data-wl-edit]");
    if (ed) return openEditor(watchlist.find((w) => w.id === ed.getAttribute("data-wl-edit")));
    const mm = t.closest("[data-wl-memo]");
    if (mm) return openMemo(watchlist.find((w) => w.id === mm.getAttribute("data-wl-memo")));
    const del = t.closest("[data-wl-del]");
    if (del) {
      const w = watchlist.find((x) => x.id === del.getAttribute("data-wl-del"));
      if (!w || !(await K.confirm(w.name + " 을(를) 관심 종목에서 뺄까요?\n모든 사용자의 관심 종목에서 빠집니다.", "삭제", true))) return;
      try {
        await watchStore.remove(w.id);
        watchlist = watchStore.cached().slice();
        renderTable();
      } catch (err) {
        K.toast(err.message, true);
      }
      return;
    }
    if (btn && btn.closest("#brief-tabs")) {
      st.brief = btn.getAttribute("data-session");
      st.briefId = "";
      K.prefs.set("market.brief", st.brief);
      return renderBrief();
    }
    if (btn && btn.id === "brief-new") return openBriefEditor(null);
    if (btn && btn.id === "brief-edit") return openBriefEditor(briefs.find((b) => b.id === st.briefId));
    if (btn && btn.id === "brief-del") {
      const b = briefs.find((x) => x.id === st.briefId);
      if (!b || !(await K.confirm(K.dot(b.date) + " " + SESSION_LABEL[b.session || "morning"] + " 시황을 지울까요?", "삭제", true))) return;
      try {
        await briefStore.remove(b.id);
        briefs = briefStore.cached().slice();
        st.briefId = "";
        renderBrief();
      } catch (err) {
        K.toast(err.message, true);
      }
      return;
    }
    if (btn && btn.closest("#news-tabs")) {
      st.news = btn.getAttribute("data-sector");
      st.newsPage = 0;
      return renderNews();
    }
    if (btn && btn.id === "news-prev") {
      st.newsPage = Math.max(0, st.newsPage - 1);
      return renderNews();
    }
    if (btn && btn.id === "news-next") {
      st.newsPage += 1;
      return renderNews();
    }
    if (btn && btn.id === "news-add") return openNewsEditor();
    const nd = t.closest("[data-news-del]");
    if (nd) {
      if (!(await K.confirm("이 기사 링크를 지울까요?", "삭제", true))) return;
      try {
        await newsStore.remove(nd.getAttribute("data-news-del"));
        news = newsStore.cached().slice();
        renderNews();
      } catch (err) {
        K.toast(err.message, true);
      }
    }
  });
  $("#brief-pick").addEventListener("change", (e) => {
    st.briefId = e.target.value;
    renderBrief();
  });

  // 표 제목줄에 관심 종목 추가 버튼
  $("#movers .card__head").insertAdjacentHTML("beforeend", '<button type="button" class="btn btn--primary btn--sm card__link" data-wl-add style="color:#fff">+ 관심 종목</button>');

  (async function init() {
    session = await K.session();
    renderIndicators();
    const [wl, br, nw, uni] = await Promise.all([
      watchStore.list().catch((err) => (K.toast("관심 종목을 불러오지 못했습니다: " + err.message, true), [])),
      briefStore.list().catch(() => []),
      newsStore.list().catch(() => []),
      uniStore.list().catch(() => []),
    ]);
    watchlist = (wl || []).slice();
    briefs = (br || []).slice();
    news = (nw || []).slice();
    const u = (uni || []).find((x) => Array.isArray(x.rows));
    uniRows = u ? u.rows : [];
    renderIndexes();
    renderTable();
    renderBrief();
    renderNews();
    await refresh();
    schedule();
  })();
})();
