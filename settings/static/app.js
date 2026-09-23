/* Setting — Google 캘린더 연동.
 * 서버 모드: 사용자별 구독 주소(.ics)를 만들고, 복사·Google 등록·다시 만들기·해제를 한다.
 * 브라우저 모드: 구독 주소를 만들 수 없으므로 IR 일정을 .ics 파일로 내려받게 한다. */
(function () {
  "use strict";
  const K = window.Kit;
  const { $ } = K;

  const form = $("#google-form");
  const memoBox = $("#google-include-memo");
  const mainBtn = $("#google-enable");
  const stateEl = $("#google-state");
  const card = $("#google-calendar");
  if (!form || !card) return;

  // 안내·결과 문구 자리
  const feedback = document.createElement("p");
  feedback.className = "settings-feedback";
  feedback.setAttribute("role", "status");
  feedback.hidden = true;
  form.after(feedback);

  function say(msg, isError) {
    feedback.textContent = msg;
    feedback.classList.toggle("is-error", !!isError);
    feedback.hidden = !msg;
  }
  function setState(label, on) {
    stateEl.textContent = label;
    stateEl.classList.toggle("is-enabled", !!on);
  }
  function busy(on) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = on));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // 권한이 없거나 http 주소일 때
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (err) {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  function googleUrl(url) {
    return "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(url.replace(/^https?:/i, "webcal:"));
  }

  /* ---------- 서버 모드: 구독 주소 ---------- */
  function initServer(api) {
    let info = { enabled: false, url: "", includeMemo: false };

    const area = document.createElement("div");
    area.className = "settings-link-area";
    area.hidden = true;
    area.innerHTML =
      '<label for="google-url">내 구독 주소</label>' +
      '<div class="settings-link-row">' +
      '<input id="google-url" type="text" readonly spellcheck="false" aria-describedby="google-url-note"/>' +
      '<button type="button" class="btn btn--ghost" id="google-copy">주소 복사</button>' +
      '<a class="btn btn--primary" id="google-open" target="_blank" rel="noopener noreferrer" href="#">Google에 등록하기</a>' +
      "</div>" +
      '<p class="settings-note" id="google-url-note">이 주소를 아는 사람은 누구나 IR 일정을 볼 수 있습니다. 다른 사람에게 알리지 마세요. 주소가 새어 나갔다면 다시 만들어 주세요.</p>' +
      '<div class="settings-buttons">' +
      '<button type="button" class="settings-text-button" id="google-renew">주소 다시 만들기</button>' +
      '<button type="button" class="settings-text-button" id="google-disable">연동 해제</button>' +
      "</div>";
    form.after(area);
    area.after(feedback);

    const urlInput = $("#google-url", area);

    // syncMemo: 서버 값으로 체크 상자를 맞출 때만 true
    function render(syncMemo) {
      setState(info.enabled ? "연동 중" : "연동 안 됨", info.enabled);
      if (syncMemo) memoBox.checked = !!info.includeMemo;
      area.hidden = !info.enabled;
      mainBtn.textContent = info.enabled ? "설정 반영해 주소 다시 만들기" : "연동 주소 만들기";
      // 연동 중이면 메모 설정을 바꿨을 때만 위 버튼을 보인다 (바꾸면 주소가 새로 바뀜)
      mainBtn.hidden = info.enabled && memoBox.checked === !!info.includeMemo;
      if (info.enabled) {
        urlInput.value = info.url;
        $("#google-open", area).href = googleUrl(info.url);
      }
    }

    async function load() {
      try {
        info = await api("GET", "/api/calendar-link");
        render(true);
      } catch (e) {
        setState("확인 실패", false);
        say("연동 상태를 불러오지 못했습니다. " + e.message, true);
      }
    }

    async function make(again) {
      busy(true);
      try {
        info = await api("POST", "/api/calendar-link", { includeMemo: memoBox.checked });
        render(true);
        say(again ? "새 주소를 만들었습니다. 이전 주소는 더 이상 쓸 수 없으니 Google 캘린더에서도 새 주소로 다시 등록해 주세요." : "연동 주소를 만들었습니다. 주소를 복사하거나 ‘Google에 등록하기’를 누르세요.");
      } catch (e) {
        say("주소를 만들지 못했습니다. " + e.message, true);
      } finally {
        busy(false);
      }
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (info.enabled) {
        const ok = await K.confirm("메모 포함 설정을 바꾸려면 주소를 새로 만들어야 합니다.\n지금 쓰는 주소는 더 이상 작동하지 않습니다. 계속할까요?", "다시 만들기");
        if (!ok) {
          render(true);
          return;
        }
      }
      make(info.enabled);
    });
    memoBox.addEventListener("change", () => {
      render();
      if (info.enabled && !mainBtn.hidden) say("메모 포함 설정은 주소를 다시 만들 때 반영됩니다.");
      else say("");
    });

    $("#google-copy", area).addEventListener("click", async () => {
      const ok = await copyText(info.url);
      if (ok) say("구독 주소를 복사했습니다. Google 캘린더의 ‘URL로 추가’에 붙여넣으세요.");
      else {
        urlInput.select();
        say("자동 복사가 되지 않았습니다. 주소 칸을 선택해 직접 복사해 주세요.", true);
      }
    });
    urlInput.addEventListener("focus", () => urlInput.select());

    $("#google-renew", area).addEventListener("click", async () => {
      const ok = await K.confirm("새 주소를 만들면 지금 주소는 바로 무효가 됩니다.\nGoogle 캘린더에도 새 주소로 다시 등록해야 합니다. 계속할까요?", "다시 만들기", true);
      if (ok) make(true);
    });

    $("#google-disable", area).addEventListener("click", async () => {
      const ok = await K.confirm("연동을 해제하면 Google 캘린더가 더 이상 일정을 받아 가지 못합니다.\n이미 보이는 일정은 Google에서 구독을 취소해야 지워집니다. 해제할까요?", "연동 해제", true);
      if (!ok) return;
      busy(true);
      try {
        await api("DELETE", "/api/calendar-link");
        info = { enabled: false, url: "", includeMemo: memoBox.checked };
        render();
        say("연동을 해제했습니다. Google 캘린더에서도 해당 캘린더 구독을 취소해 주세요.");
      } catch (e) {
        say("연동을 해제하지 못했습니다. " + e.message, true);
      } finally {
        busy(false);
      }
    });

    load();
  }

  /* ---------- 브라우저 모드: .ics 파일 ---------- */
  function icsEscape(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }
  // 75바이트마다 접기 (한글이 잘리지 않게 글자 단위로)
  function fold(line) {
    const enc = new TextEncoder();
    const out = [];
    let cur = "";
    let bytes = 0;
    for (const ch of line) {
      const n = enc.encode(ch).length;
      if (bytes + n > 75) {
        out.push(cur);
        cur = " ";
        bytes = 1;
      }
      cur += ch;
      bytes += n;
    }
    out.push(cur);
    return out.join("\r\n");
  }
  function utcStamp(d) {
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  }

  function buildIcs(events, includeMemo) {
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//hana-workspace//IR//KO", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "X-WR-CALNAME:IR 캘린더", "X-WR-TIMEZONE:Asia/Seoul",
      "BEGIN:VTIMEZONE", "TZID:Asia/Seoul", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0900", "TZOFFSETTO:+0900", "TZNAME:KST", "END:STANDARD", "END:VTIMEZONE",
    ];
    const stamp = utcStamp(new Date());
    let count = 0;
    events.forEach((ev) => {
      const date = String(ev.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const endDate = /^\d{4}-\d{2}-\d{2}$/.test(ev.endDate || "") && ev.endDate >= date ? ev.endDate : date;
      const title = "[" + (K.IR_LABEL[ev.type] || "기타") + "] " + (ev.companies || "") + (ev.title ? " · " + ev.title : "");
      const desc = [];
      if (ev.brokers) desc.push("증권사: " + ev.brokers);
      if (ev.location) desc.push("장소: " + ev.location);
      if (includeMemo && ev.memo) desc.push(String(ev.memo));
      lines.push("BEGIN:VEVENT", "UID:" + (ev.id || K.uid("ev")) + "@hana-workspace", "DTSTAMP:" + stamp, "SUMMARY:" + icsEscape(title.trim()));
      if (/^\d{2}:\d{2}$/.test(ev.time || "")) {
        // 시간 일정: 한국 시간(TZID) 그대로
        const t = ev.time.replace(":", "");
        let et = /^\d{2}:\d{2}$/.test(ev.endTime || "") ? ev.endTime.replace(":", "") : "";
        if (!et) et = K.pad(Math.min(Number(t.slice(0, 2)) + 1, 23)) + t.slice(2);
        if (endDate === date && et <= t) et = K.pad(Math.min(Number(t.slice(0, 2)) + 1, 23)) + t.slice(2);
        lines.push("DTSTART;TZID=Asia/Seoul:" + date.replace(/-/g, "") + "T" + t + "00", "DTEND;TZID=Asia/Seoul:" + endDate.replace(/-/g, "") + "T" + et + "00");
      } else {
        // 종일 일정: 끝 날짜는 다음 날(배타적)
        lines.push("DTSTART;VALUE=DATE:" + date.replace(/-/g, ""), "DTEND;VALUE=DATE:" + K.addDays(endDate, 1).replace(/-/g, ""));
      }
      if (ev.location) lines.push("LOCATION:" + icsEscape(ev.location));
      if (desc.length) lines.push("DESCRIPTION:" + icsEscape(desc.join("\n")));
      lines.push("END:VEVENT");
      count++;
    });
    lines.push("END:VCALENDAR");
    return { text: lines.map(fold).join("\r\n") + "\r\n", count };
  }

  function initBrowser() {
    setState("브라우저 모드", false);
    mainBtn.textContent = "IR 일정 .ics 내려받기";
    const intro = $(".settings-intro", card);
    if (intro) {
      intro.textContent =
        "지금은 이 브라우저에 저장하는 모드라 Google이 조회할 구독 주소를 만들 수 없습니다. 대신 이 브라우저의 IR 일정을 .ics 파일로 내려받아 Google 캘린더에 가져올 수 있습니다. 구독 주소는 서버 모드에서 만들 수 있습니다.";
    }
    const help = $(".settings-help", card);
    if (help) {
      $("summary", help).textContent = ".ics 파일을 Google 캘린더로 가져오는 방법";
      $("ol", help).innerHTML =
        "<li>위에서 <b>IR 일정 .ics 내려받기</b>를 누르세요.</li>" +
        "<li>PC 웹브라우저에서 Google 캘린더를 열고 <b>설정 → 가져오기 및 내보내기 → 가져오기</b>를 선택하세요.</li>" +
        "<li>내려받은 파일과 넣을 캘린더를 고른 뒤 <b>가져오기</b>를 누르세요.</li>";
      const ps = help.querySelectorAll("p");
      if (ps[0]) ps[0].textContent = "가져온 일정은 그 시점의 사본입니다. IR 캘린더에서 일정을 바꾸면 파일을 다시 내려받아 가져와야 합니다. 같은 일정은 같은 고유번호(UID)로 덮어씁니다.";
      if (ps[1]) ps[1].textContent = "서버 모드에서는 구독 주소를 만들어 Google이 자동으로 새 일정을 받아 가게 할 수 있습니다.";
    }
    memoBox.checked = !!K.prefs.get("settings.icsMemo", false);
    memoBox.addEventListener("change", () => K.prefs.set("settings.icsMemo", memoBox.checked));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      busy(true);
      try {
        const events = (await K.irEvents().list()).slice().sort(K.byEventTime);
        if (!events.length) {
          say("내려받을 IR 일정이 없습니다. IR 캘린더에서 일정을 먼저 등록해 주세요.", true);
          return;
        }
        const ics = buildIcs(events, memoBox.checked);
        K.saveText("IR캘린더_" + K.today().replace(/-/g, "") + ".ics", ics.text, "text/calendar;charset=utf-8");
        say("IR 일정 " + ics.count + "건을 .ics 파일로 내려받았습니다" + (memoBox.checked ? " (메모 포함)" : "") + ". Google 캘린더의 ‘가져오기’에서 올려 주세요.");
      } catch (err) {
        say("파일을 만들지 못했습니다. " + err.message, true);
      } finally {
        busy(false);
      }
    });
  }

  K.session().then((s) => {
    if (s.server && s.api) initServer(s.api);
    else initBrowser();
  });
})();
