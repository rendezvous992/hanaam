/* 텔레그램 수집: 봇이 받은 메시지 목록, 검색·방 필터, 노트로 보내기, 관리자 연결 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, esc, toast } = K;
  const store = K.collection("telegram");
  let items = [];

  function filtered() {
    const q = $("#tg-q").value.trim().toLowerCase();
    const chat = $("#tg-chat").value;
    const r = $("#tg-range").value;
    const from = r === "all" ? "" : K.addDays(K.today(), -Number(r));
    return items
      .filter((m) => (!chat || m.chat === chat) && (!from || (m.date || "") >= from) && (!q || (m.text + " " + m.chat + " " + (m.forwardFrom || "")).toLowerCase().includes(q)))
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  }

  function render() {
    const list = filtered();
    $("#tg-count").textContent = list.length + "건";
    const chats = Array.from(new Set(items.map((m) => m.chat))).sort((a, b) => a.localeCompare(b, "ko"));
    const cur = $("#tg-chat").value;
    $("#tg-chat").innerHTML = '<option value="">모든 방</option>' + chats.map((c) => '<option value="' + esc(c) + '"' + (c === cur ? " selected" : "") + ">" + esc(c) + "</option>").join("");
    if (!list.length) {
      $("#tg-list").innerHTML = '<p class="tg-empty">' + (items.length ? "조건에 맞는 메시지가 없습니다." : "아직 모인 메시지가 없습니다. 위 안내대로 봇을 방에 넣으면 새 메시지부터 모입니다.") + "</p>";
      return;
    }
    let day = "";
    $("#tg-list").innerHTML = list.slice(0, 300).map((m) => {
      const head = m.date !== day ? '<h3 class="tg-day">' + esc(K.kLabel(m.date)) + "</h3>" : "";
      day = m.date;
      return head +
        '<article class="tg-msg" data-id="' + esc(m.id) + '"><div class="tg-msg__head"><span class="tg-msg__chat">' + esc(m.chat) + "</span><span>" + esc(m.time || "") + "</span>" +
        (m.forwardFrom ? "<span>전달: " + esc(m.forwardFrom) + "</span>" : "") + (m.edited ? "<span>수정됨</span>" : "") + "</div>" +
        '<div class="tg-msg__text">' + esc(m.text) + "</div>" +
        '<div class="tg-msg__actions"><button type="button" class="btn btn--ghost btn--sm" data-act="more">펼치기</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="note">노트로 보내기</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="copy">복사</button>' +
        (m.link ? '<a class="btn btn--ghost btn--sm" href="' + esc(m.link) + '" target="_blank" rel="noopener noreferrer">텔레그램에서 보기</a>' : "") +
        (m.urls || []).slice(0, 3).map((u) => '<a class="btn btn--ghost btn--sm" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">링크 ↗</a>').join("") +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="del">삭제</button></div></article>';
    }).join("");
  }

  $("#tg-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const card = b.closest("[data-id]");
    const m = items.find((x) => x.id === card.getAttribute("data-id"));
    if (!m) return;
    const act = b.getAttribute("data-act");
    if (act === "more") {
      card.classList.toggle("is-open");
      b.textContent = card.classList.contains("is-open") ? "접기" : "펼치기";
    } else if (act === "copy") {
      navigator.clipboard.writeText(m.text).then(() => toast("복사했습니다."), () => toast("복사하지 못했습니다.", true));
    } else if (act === "note") {
      // 노트 화면이 이 초안으로 등록 창을 연다
      try {
        sessionStorage.setItem("hana.noteDraft", JSON.stringify({ title: m.text.split("\n")[0].slice(0, 100), body: m.text + (m.link ? "\n\n출처: " + m.link : "\n\n출처: 텔레그램 " + m.chat), link: (m.urls || [])[0] || m.link || "", date: m.date }));
      } catch (err) {
        /* 저장 공간이 막혀 있으면 그냥 연다 */
      }
      location.href = "/notes/?draft=1";
    } else if (act === "del") {
      if (!(await K.confirm("이 메시지를 목록에서 지울까요?", "삭제", true))) return;
      try {
        await store.remove(m.id);
        items = items.filter((x) => x.id !== m.id);
        render();
      } catch (err) {
        toast(err.message, true);
      }
    }
  });
  ["#tg-q", "#tg-chat", "#tg-range"].forEach((sel) => $(sel).addEventListener(sel === "#tg-q" ? "input" : "change", render));

  function guide(extra) {
    return "<ol><li>텔레그램에서 <b>@BotFather</b> 에게 <code>/newbot</code> 을 보내 봇을 만들고 토큰을 받습니다 (무료).</li>" +
      "<li>버셀 → Settings → Environment Variables 에 <code>TELEGRAM_BOT_TOKEN</code> 으로 토큰을 넣고 Redeploy 합니다.</li>" +
      "<li>이 화면에서 관리자가 <b>웹훅 연결</b>을 누릅니다.</li>" +
      "<li>GPT 요약을 받는 채널·그룹에 봇을 넣습니다. 채널은 봇을 <b>관리자</b>로 추가해야 메시지를 받습니다. 그룹은 BotFather 의 <code>/setprivacy</code> 를 Disable 로 바꾸세요.</li></ol>" + (extra || "");
  }

  K.session().then(async (s) => {
    const box = $("#tg-status");
    if (!s.server) {
      box.classList.add("is-off");
      box.innerHTML = "<b>서버(로그인) 모드에서만 모을 수 있습니다.</b> 데이터베이스를 연결한 뒤 아래 순서대로 봇을 붙이세요." + guide();
      render();
      return;
    }
    const isAdmin = s.me.role === "super" || s.me.role === "admin";
    try {
      const st = await s.api("GET", "/api/telegram/status");
      if (!st.connected) {
        box.classList.add("is-off");
        box.innerHTML = "<b>텔레그램 봇이 아직 연결되지 않았습니다.</b>" + guide();
      } else {
        const hooked = st.webhook && st.webhook.indexOf(location.host) >= 0;
        box.classList.toggle("is-off", !hooked);
        box.innerHTML = "봇 <b>@" + esc(st.bot || "?") + "</b> · " + (hooked ? "연결됨 · 새 메시지가 자동으로 모입니다." : "웹훅이 이 사이트에 연결되지 않았습니다.") +
          (st.lastError ? '<br><span style="color:var(--danger)">텔레그램 마지막 오류: ' + esc(st.lastError) + "</span>" : "") +
          (isAdmin ? '<br><button type="button" class="btn btn--primary btn--sm" id="tg-setup">' + (hooked ? "웹훅 다시 연결" : "웹훅 연결") + "</button>" : "") +
          (hooked ? "" : guide());
        const btn = $("#tg-setup");
        if (btn)
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            try {
              await s.api("POST", "/api/telegram/setup");
              toast("연결했습니다. 봇이 들어간 방의 새 메시지부터 모입니다.");
              setTimeout(() => location.reload(), 800);
            } catch (err) {
              toast(err.message, true);
              btn.disabled = false;
            }
          });
      }
    } catch (err) {
      box.textContent = err.message;
    }
    try {
      items = await store.list();
    } catch (err) {
      toast(err.message, true);
    }
    render();
    setInterval(async () => {
      if (document.hidden) return;
      try {
        items = await store.list();
        render();
      } catch (err) {
        /* 잠깐의 오류는 무시 */
      }
    }, 60000);
  });
})();
