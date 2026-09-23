/* 경제 캘린더 — 주요국 경제지표 일정(서버: EODHD 자동 수집 + 직접 입력), 기간·국가·중요도·검색 필터(주소 쿼리와 동기화), CSV */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc } = K;
  const store = K.collection("economic-events");

  const MAJOR = ["KR", "US", "CN", "JP", "EU", "GB"];
  const COUNTRY = { KR: "한국", US: "미국", CN: "중국", JP: "일본", EU: "유로존", GB: "영국", DE: "독일", FR: "프랑스", IT: "이탈리아", CA: "캐나다", AU: "호주", IN: "인도", CH: "스위스", TW: "대만", HK: "홍콩" };
  const COUNTRY_ALIAS = { UK: "GB", EZ: "EU", EA: "EU", EMU: "EU", 한국: "KR", 미국: "US", 중국: "CN", 일본: "JP", 유로존: "EU", 유럽: "EU", 영국: "GB", 독일: "DE", 프랑스: "FR", 이탈리아: "IT", 캐나다: "CA", 호주: "AU", 인도: "IN", 스위스: "CH", 대만: "TW", 홍콩: "HK" };
  const IMPACT = { high: "높음", medium: "보통", low: "낮음" };
  const IMPACT_LEVEL = { high: 3, medium: 2, low: 1 };
  const MAX_API_DAYS = 93;

  const form = $(".economic-filters");
  const body = $("#eco-body");
  const statusBox = $("#eco-status");
  let session = { server: false, me: null, api: null };
  let connected = null; // 서버 모드에서 EODHD 연결 여부
  let manual = [];
  let apiItems = [];
  let apiNote = "";
  let apiError = "";
  let loadedAt = "";
  let shown = [];
  const apiCache = new Map();

  /* ---------- 값 다듬기 ---------- */
  function normCountry(v) {
    const s = String(v || "").trim();
    if (!s) return "";
    const up = s.toUpperCase();
    return COUNTRY_ALIAS[s] || COUNTRY_ALIAS[up] || (/^[A-Z]{2,3}$/.test(up) ? up : s);
  }
  function countryName(c) {
    return COUNTRY[c] || c || "—";
  }
  function normImpact(v) {
    const s = String(v || "").trim().toLowerCase();
    if (!s) return "";
    if (/^(high|높음|상|3|★★★|h)$/.test(s)) return "high";
    if (/^(medium|mid|보통|중간|중|2|★★|m)$/.test(s)) return "medium";
    if (/^(low|낮음|하|1|★|l)$/.test(s)) return "low";
    return "";
  }
  function normDate(v) {
    const s = String(v || "").trim();
    let m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/.exec(s);
    if (m) return m[1] + "-" + K.pad(+m[2]) + "-" + K.pad(+m[3]);
    m = /^(\d{1,2})\s*[-./월]\s*(\d{1,2})/.exec(s);
    if (m) return K.today().slice(0, 4) + "-" + K.pad(+m[1]) + "-" + K.pad(+m[2]);
    return "";
  }
  function normTime(v) {
    const m = /(\d{1,2})\s*:\s*(\d{2})/.exec(String(v || ""));
    if (!m || +m[1] > 23 || +m[2] > 59) return "";
    return K.pad(+m[1]) + ":" + m[2];
  }
  function validDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s || "") && K.parse(s) && K.ymd(K.parse(s)) === s;
  }
  function val(v) {
    return v == null || v === "" ? "—" : esc(String(v));
  }
  function canDelete(it) {
    if (!session.server) return true;
    const me = session.me || {};
    return me.role === "admin" || me.role === "super" || !it.createdById || it.createdById === me.id;
  }

  /* ---------- 주소 쿼리 ↔ 필터 ---------- */
  function readQuery() {
    const p = new URLSearchParams(location.search);
    const t = K.today();
    let start = validDate(p.get("start")) ? p.get("start") : t;
    let end = validDate(p.get("end")) ? p.get("end") : K.addDays(start, 6);
    if (end < start) [start, end] = [end, start];
    const country = normCountry(p.get("country") || "");
    const impact = IMPACT_LEVEL[p.get("impact")] ? p.get("impact") : "";
    return { start, end, country: MAJOR.includes(country) ? country : "", impact, q: (p.get("q") || "").slice(0, 120) };
  }
  let filt = readQuery();
  function fillForm() {
    form.elements.start.value = filt.start;
    form.elements.end.value = filt.end;
    form.elements.country.value = filt.country;
    form.elements.impact.value = filt.impact;
    form.elements.q.value = filt.q;
  }
  function queryString(f) {
    const p = new URLSearchParams();
    p.set("start", f.start);
    p.set("end", f.end);
    if (f.country) p.set("country", f.country);
    if (f.impact) p.set("impact", f.impact);
    if (f.q) p.set("q", f.q);
    return "?" + p.toString();
  }
  function go(next, replace) {
    filt = next;
    const url = location.pathname + queryString(filt);
    if (replace) history.replaceState(null, "", url);
    else if (url !== location.pathname + location.search) history.pushState(null, "", url);
    fillForm();
    drawPresets();
    load();
  }
  function drawPresets() {
    const t = K.today();
    const base = { country: filt.country, impact: filt.impact, q: filt.q };
    const sets = {
      today: [t, t],
      next7: [t, K.addDays(t, 6)],
      after7: [K.addDays(t, 7), K.addDays(t, 13)],
    };
    $$(".economic-presets a").forEach((a) => {
      const r = sets[a.getAttribute("data-preset")];
      if (!r) return;
      a.href = location.pathname + queryString(Object.assign({ start: r[0], end: r[1] }, base));
      a.dataset.start = r[0];
      a.dataset.end = r[1];
      const on = filt.start === r[0] && filt.end === r[1];
      if (on) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
      a.style.borderColor = on ? "var(--primary)" : "";
      a.style.color = on ? "var(--primary)" : "";
    });
  }

  /* ---------- 자동 수집(EODHD) ---------- */
  function chunks(start, end) {
    const out = [];
    for (let s = start; s <= end; s = K.addDays(s, 7)) {
      const e = K.addDays(s, 6) < end ? K.addDays(s, 6) : end;
      out.push([s, e]);
    }
    return out;
  }
  async function fetchApi(start, end) {
    apiNote = "";
    if (K.diffDays(start, end) + 1 > MAX_API_DAYS) {
      end = K.addDays(start, MAX_API_DAYS - 1);
      apiNote = "자동 수집 자료는 시작일부터 " + MAX_API_DAYS + "일까지만 불러옵니다.";
    }
    const lists = await Promise.all(chunks(start, end).map(([s, e]) => {
      const key = s + "|" + e;
      if (!apiCache.has(key)) {
        const p = session.api("GET", "/api/economic?start=" + s + "&end=" + e).then((r) => (r && r.items) || []);
        p.catch(() => apiCache.delete(key));
        apiCache.set(key, p);
      }
      return apiCache.get(key);
    }));
    const seen = new Set();
    const out = [];
    lists.flat().forEach((x) => {
      if (seen.has(x.id)) return;
      seen.add(x.id);
      const c = normCountry(x.country);
      if (!MAJOR.includes(c)) return;
      out.push(Object.assign({}, x, { country: c, countryName: countryName(c), auto: true }));
    });
    return out;
  }

  async function load() {
    body.innerHTML = '<tr><td class="economic-empty" colspan="6">불러오는 중…</td></tr>';
    apiError = "";
    try {
      manual = await store.list();
    } catch (err) {
      manual = [];
      K.toast("직접 입력한 일정을 불러오지 못했습니다: " + err.message, true);
    }
    apiItems = [];
    if (session.server && connected) {
      try {
        apiItems = await fetchApi(filt.start, filt.end);
        loadedAt = K.today() + " " + K.nowTime();
      } catch (err) {
        if (/연결되지 않았/.test(err.message)) connected = false;
        else apiError = err.message;
      }
    }
    render();
  }

  /* ---------- 그리기 ---------- */
  function passes(it) {
    if (!it.date || it.date < filt.start || it.date > filt.end) return false;
    if (filt.country && it.country !== filt.country) return false;
    if (filt.impact && (IMPACT_LEVEL[it.importance] || 0) < IMPACT_LEVEL[filt.impact]) return false;
    if (filt.q) {
      const hay = [it.title, it.period, it.country, countryName(it.country), it.memo].join(" ").toLowerCase();
      if (!filt.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
    }
    return true;
  }
  function impactHtml(level) {
    const n = IMPACT_LEVEL[level] || 0;
    if (!n) return "";
    return '<span class="economic-impact" title="중요도 ' + IMPACT[level] + '"><b>' + "●".repeat(n) + "</b>" + "●".repeat(3 - n) + "</span>";
  }
  function isFuture(it) {
    const now = K.today() + " " + K.nowTime();
    return it.date + " " + (it.time || "23:59") > now;
  }
  function rowHtml(it) {
    const title = '<span class="economic-title">' + esc(it.title) + impactHtml(it.importance) + "</span>";
    const period = it.period ? '<span class="economic-period">기간 ' + esc(it.period) + "</span>" : "";
    const who = it.auto ? "" : '<small class="economic-manual">직접 입력' + (it.createdBy ? " · " + esc(it.createdBy) : "") + (it.memo ? " · " + esc(it.memo) : "") + "</small>";
    const actual = it.auto && isFuture(it) && (it.actual == null || it.actual === "") ? '<span class="economic-pending">발표 예정</span>' : val(it.actual);
    return (
      '<tr class="economic-event' + (it.auto ? "" : " economic-original") + '">' +
      '<td class="economic-time">' + (it.time ? esc(it.time) : '<span class="economic-pending">시간 미정</span>') + "</td>" +
      '<td><span class="economic-country">' + esc(it.country || "—") + "</span><small>" + esc(countryName(it.country)) + "</small></td>" +
      "<td>" + (it.auto ? title : '<button type="button" class="economic-title-btn" data-edit="' + esc(it.id) + '" title="눌러서 수정">' + title + "</button>") + period + who + "</td>" +
      '<td class="numeric">' + actual + "</td>" +
      '<td class="numeric">' + val(it.forecast) + "</td>" +
      '<td class="numeric">' + val(it.previous) + "</td></tr>"
    );
  }
  function renderStatus() {
    const main = $("#eco-status-main");
    const range = $("#eco-status-range");
    statusBox.classList.remove("is-stale", "is-error");
    const nManual = shown.filter((x) => !x.auto).length;
    const nAuto = shown.length - nManual;
    const rangeText = "조회 범위 " + K.dot(filt.start).slice(5) + " ~ " + K.dot(filt.end).slice(5) + " KST";
    if (!session.server) {
      statusBox.classList.add("is-stale");
      main.textContent = "브라우저 저장 모드 · 직접 입력하거나 CSV로 가져온 일정만 표시합니다. 자동 수집(EODHD)은 서버 모드에서 연결됩니다.";
      range.textContent = rangeText + " · 직접 입력 " + nManual + "건";
    } else if (!connected) {
      statusBox.classList.add("is-stale");
      main.textContent = "자동 수집(EODHD) 연결 안 됨 · 관리자가 EODHD_API_KEY 를 설정하면 발표 일정이 자동으로 채워집니다. 지금은 직접 입력한 일정만 표시합니다.";
      range.textContent = rangeText + " · 직접 입력 " + nManual + "건";
    } else if (apiError) {
      statusBox.classList.add("is-error");
      main.textContent = "자동 수집 자료를 불러오지 못했습니다: " + apiError;
      range.textContent = rangeText + " · 직접 입력 " + nManual + "건";
    } else {
      main.textContent = "EODHD 자동 수집 · 불러온 시각 " + K.dot(loadedAt) + " KST" + (apiNote ? " · " + apiNote : "");
      range.textContent = rangeText + " · 자동 " + nAuto + "건 · 직접 입력 " + nManual + "건";
    }
  }
  function render() {
    shown = manual.map((x) => Object.assign({}, x, { country: normCountry(x.country) })).concat(apiItems).filter(passes);
    shown.sort((a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")) || (a.country || "").localeCompare(b.country || "") || (a.title || "").localeCompare(b.title || ""));
    $("#eco-count").textContent = String(shown.length);
    renderStatus();
    if (!shown.length) {
      const why = !session.server || !connected ? "위의 <b>+ 직접 추가</b>나 <b>CSV 가져오기</b>로 일정을 넣을 수 있습니다." : "날짜·국가·중요도 필터와 검색어를 확인해 주세요.";
      body.innerHTML = '<tr><td class="economic-empty" colspan="6">선택한 조건에 해당하는 일정이 없습니다.<br><small>' + why + "</small></td></tr>";
      return;
    }
    const days = new Map();
    shown.forEach((it) => {
      if (!days.has(it.date)) days.set(it.date, []);
      days.get(it.date).push(it);
    });
    let html = "";
    days.forEach((list, day) => {
      html += '<tr class="economic-day"><th colspan="6" scope="rowgroup">' + esc(K.kLabel(day)) + (day === K.today() ? " · 오늘" : "") + "<span>" + list.length + "건</span></th></tr>";
      html += list.map(rowHtml).join("");
    });
    body.innerHTML = html;
  }

  /* ---------- 직접 추가·수정 ---------- */
  function countryOptions(cur) {
    const codes = Object.keys(COUNTRY);
    if (cur && !codes.includes(cur)) codes.push(cur);
    return codes.map((c) => '<option value="' + esc(c) + '"' + (c === cur ? " selected" : "") + ">" + esc(countryName(c) + " (" + c + ")") + "</option>").join("");
  }
  function openEditor(existing) {
    const it = Object.assign({ date: filt.start, time: "", country: filt.country || "US", title: "", period: "", actual: "", forecast: "", previous: "", importance: "", memo: "" }, existing || {});
    it.country = normCountry(it.country);
    const f = (name, label, value, extra) =>
      '<label class="field"><span class="field__label">' + label + '</span><input class="input" name="' + name + '" value="' + esc(value == null ? "" : value) + '"' + (extra || "") + "></label>";
    const html =
      '<form class="modal__body" id="eco-form" novalidate>' +
      '<div class="economic-form-grid">' +
      f("date", '날짜 <em class="required">*</em>', it.date, ' type="date" required') +
      f("time", "발표 시각 (KST)", it.time, ' type="time"') +
      '<label class="field"><span class="field__label">국가·지역</span><select class="input" name="country">' + countryOptions(it.country) + "</select></label>" +
      '<label class="field field--wide"><span class="field__label">경제지표·일정 <em class="required">*</em></span><input class="input" name="title" maxlength="200" placeholder="예: 소비자물가지수(CPI), 기준금리 결정" value="' + esc(it.title) + '"></label>' +
      f("period", "기간", it.period, ' placeholder="예: 9월, 3분기"') +
      '<label class="field"><span class="field__label">중요도</span><select class="input" name="importance"><option value="">선택 안 함</option>' +
      ["high", "medium", "low"].map((k) => '<option value="' + k + '"' + (it.importance === k ? " selected" : "") + ">" + IMPACT[k] + "</option>").join("") + "</select></label>" +
      f("memo", "메모", it.memo, ' maxlength="200"') +
      f("actual", "발표치", it.actual, ' placeholder="예: 2.9%"') +
      f("forecast", "예상치", it.forecast) +
      f("previous", "이전치", it.previous) +
      "</div>" +
      '<div class="modal__footer">' + (existing && canDelete(existing) ? '<button type="button" class="btn btn--danger btn--sm" data-act="delete">삭제</button>' : "") +
      '<div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-act="cancel">취소</button><button type="submit" class="btn btn--primary">저장</button></div></div></form>';
    const ctx = K.modal({ title: existing ? "경제지표 일정 수정" : "경제지표 일정 직접 추가", size: "modal--wide", html, focus: '[name="title"]' });
    const fm = $("#eco-form", ctx.modal);
    fm.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const what = act.getAttribute("data-act");
      if (what === "cancel") ctx.close();
      else if (what === "delete") {
        if (!(await K.confirm("'" + existing.title + "' 일정을 삭제할까요?", "삭제", true))) return;
        try {
          await store.remove(existing.id);
          manual = store.cached();
          ctx.close(true);
          render();
          K.toast("삭제했습니다.");
        } catch (err) {
          K.toast(err.message, true);
        }
      }
    });
    fm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const g = (n) => fm.elements[n].value.trim();
      const data = {
        date: g("date"), time: g("time"), country: g("country"), title: g("title"), period: g("period"),
        actual: g("actual"), forecast: g("forecast"), previous: g("previous"), importance: g("importance"), memo: g("memo"),
      };
      if (!validDate(data.date)) return K.toast("날짜를 골라 주세요.", true), fm.elements.date.focus();
      if (!data.title) return K.toast("경제지표 이름을 입력해 주세요.", true), fm.elements.title.focus();
      try {
        if (existing) await store.update(existing.id, data);
        else await store.create(Object.assign({ source: "직접 입력" }, data));
        manual = store.cached();
        ctx.close(true);
        if (data.date < filt.start || data.date > filt.end) {
          K.toast("저장했습니다. 조회 기간 밖이라 해당 날짜로 이동합니다.");
          go(Object.assign({}, filt, { start: data.date, end: data.date }));
        } else {
          render();
          K.toast("저장했습니다.");
        }
      } catch (err) {
        K.toast(err.message, true);
      }
    });
  }

  /* ---------- CSV ---------- */
  const HEAD = ["날짜", "시간", "국가", "지표", "기간", "실제", "예상", "이전", "중요도"];
  const HEAD_ALIAS = {
    date: /^(날짜|일자|date|발표일)$/i,
    time: /^(시간|시각|time|발표시각|시각kst|시간\(kst\))$/i,
    country: /^(국가|국가·지역|국가\/지역|지역|country)$/i,
    title: /^(지표|경제지표|경제지표·일정|이벤트|일정|event|title|indicator)$/i,
    period: /^(기간|대상기간|period)$/i,
    actual: /^(실제|발표|발표치|실제치|actual)$/i,
    forecast: /^(예상|예상치|전망|컨센서스|forecast|consensus|estimate)$/i,
    previous: /^(이전|이전치|전월|직전|previous|prior)$/i,
    importance: /^(중요도|중요|importance|impact)$/i,
  };
  const FIELDS = ["date", "time", "country", "title", "period", "actual", "forecast", "previous", "importance"];
  function rowsToItems(rows) {
    let map = null;
    const first = rows[0] || [];
    const found = {};
    first.forEach((h, i) => {
      const k = Object.keys(HEAD_ALIAS).find((key) => HEAD_ALIAS[key].test(String(h).trim().replace(/\s+/g, "")));
      if (k && found[k] == null) found[k] = i;
    });
    if (found.date != null && found.title != null) {
      map = found;
      rows = rows.slice(1);
    } else {
      map = {};
      FIELDS.forEach((k, i) => (map[k] = i));
    }
    const items = [];
    let bad = 0;
    rows.forEach((r) => {
      const get = (k) => (map[k] == null ? "" : String(r[map[k]] == null ? "" : r[map[k]]).trim());
      const date = normDate(get("date"));
      const title = get("title");
      if (!date || !validDate(date) || !title) {
        bad++;
        return;
      }
      items.push({
        date, time: normTime(get("time")), country: normCountry(get("country")), title, period: get("period"),
        actual: get("actual"), forecast: get("forecast"), previous: get("previous"), importance: normImpact(get("importance")), memo: "", source: "CSV",
      });
    });
    return { items, bad };
  }
  function importCsv() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.txt,text/csv,text/plain";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const text = await readText(file);
        const { items, bad } = rowsToItems(K.parseCsv(text));
        const key = (x) => [x.date, x.time, normCountry(x.country), (x.title || "").toLowerCase()].join("|");
        const have = new Set(manual.map(key));
        const fresh = items.filter((x) => !have.has(key(x)));
        const dup = items.length - fresh.length;
        if (!fresh.length) return K.toast("가져올 새 일정이 없습니다." + (dup ? " (이미 있는 일정 " + dup + "건)" : "") + (bad ? " (형식 오류 " + bad + "줄)" : ""), true);
        const msg = file.name + "\n새 일정 " + fresh.length + "건을 가져올까요?" + (dup ? "\n이미 있는 일정 " + dup + "건은 건너뜁니다." : "") + (bad ? "\n날짜·지표가 없는 " + bad + "줄은 건너뜁니다." : "");
        if (!(await K.confirm(msg, "가져오기"))) return;
        await store.createMany(fresh);
        manual = store.cached();
        K.toast(fresh.length + "건을 가져왔습니다.");
        const dates = fresh.map((x) => x.date).sort();
        if (!fresh.some((x) => x.date >= filt.start && x.date <= filt.end)) {
          const end = K.diffDays(dates[0], dates[dates.length - 1]) > 92 ? K.addDays(dates[0], 92) : dates[dates.length - 1];
          go(Object.assign({}, filt, { start: dates[0], end, country: "", impact: "", q: "" }));
        } else render();
      } catch (err) {
        K.toast("가져오지 못했습니다: " + err.message, true);
      }
    });
    input.click();
  }
  function readText(file) {
    return file.arrayBuffer().then((buf) => {
      const utf = new TextDecoder("utf-8").decode(buf);
      // 엑셀에서 저장한 CP949(EUC-KR) CSV 도 읽는다
      if (utf.includes("�")) {
        try {
          return new TextDecoder("euc-kr").decode(buf);
        } catch (e) {
          return utf;
        }
      }
      return utf;
    });
  }
  function exportCsv() {
    if (!shown.length) return K.toast("내보낼 일정이 없습니다. 조회 조건을 확인해 주세요.", true);
    const rows = [HEAD].concat(shown.map((x) => [x.date, x.time || "", x.country || "", x.title || "", x.period || "", x.actual == null ? "" : x.actual, x.forecast == null ? "" : x.forecast, x.previous == null ? "" : x.previous, IMPACT[x.importance] || ""]));
    K.saveText("경제캘린더_" + filt.start + "_" + filt.end + ".csv", K.toCsv(rows), "text/csv;charset=utf-8");
  }
  function sampleCsv() {
    const d = K.addDays(K.today(), 7);
    const rows = [HEAD, [d, "21:30", "US", "소비자물가지수(CPI) 전년비", "", "", "", "", "높음"], [d, "08:00", "KR", "수출입 동향", "", "", "", "", "보통"]];
    K.saveText("경제캘린더_양식.csv", K.toCsv(rows), "text/csv;charset=utf-8");
  }

  /* ---------- 이벤트 ---------- */
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const el = form.elements;
    let start = validDate(el.start.value) ? el.start.value : filt.start;
    let end = validDate(el.end.value) ? el.end.value : start;
    if (end < start) [start, end] = [end, start];
    go({ start, end, country: el.country.value, impact: el.impact.value, q: el.q.value.trim().slice(0, 120) });
  });
  ["country", "impact"].forEach((n) => form.elements[n].addEventListener("change", () => form.requestSubmit()));
  $(".economic-presets").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-preset]");
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    go(Object.assign({}, filt, { start: a.dataset.start, end: a.dataset.end }));
  });
  window.addEventListener("popstate", () => {
    filt = readQuery();
    fillForm();
    drawPresets();
    load();
  });
  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-edit]");
    if (!b) return;
    const it = manual.find((x) => x.id === b.getAttribute("data-edit"));
    if (it) openEditor(it);
  });
  $("#eco-add").addEventListener("click", () => openEditor(null));
  $("#eco-csv-import").addEventListener("click", importCsv);
  $("#eco-csv-export").addEventListener("click", exportCsv);
  $("#eco-csv-sample").addEventListener("click", sampleCsv);

  K.session().then(async (s) => {
    session = s;
    if (s.server) {
      try {
        const st = await s.api("GET", "/api/integrations");
        connected = !!(st && st.economic);
      } catch (e) {
        connected = false;
      }
    }
    fillForm();
    drawPresets();
    history.replaceState(null, "", location.pathname + queryString(filt));
    load();
  });
})();
