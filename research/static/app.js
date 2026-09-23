/* AI 리서치: 대화 목록(사용자별 저장), 질문 → 노트 검색 + AI 답변(서버), 참고 자료, HTML 리포트, 예약 리서치 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc, toast } = K;

  const root = $("#research-root");
  const list = $("#message-list");
  const input = $("#message-input");
  const sendBtn = $("#message-send");
  const threads = K.collection("research", { personal: true });

  let session = { server: false };
  let status = { ai: false };
  let current = null; // 지금 보고 있는 대화
  let busy = false;
  let refFilter = "all";

  /* ---------- 마크다운 (답변 표시용, HTML 은 모두 이스케이프) ---------- */
  function inline(text, refs) {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>");
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>");
    // [노트 3] → 참고 노트 버튼
    s = s.replace(/\[노트\s*(\d+)\]/g, (m, n) => {
      const notes = (refs || []).filter((r) => r.type === "note");
      const ref = notes[Number(n) - 1];
      return ref ? '<button type="button" class="note-ref" data-note="' + esc(String(ref.id)) + '" title="' + esc(ref.company + " · " + ref.title) + '">노트 ' + n + "</button>" : m;
    });
    return s;
  }

  function markdown(src, refs) {
    const lines = String(src || "").replace(/\r/g, "").split("\n");
    const out = [];
    let i = 0;
    const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        out.push("<h" + h[1].length + ">" + inline(h[2], refs) + "</h" + h[1].length + ">");
        i++;
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push(
          '<div class="md-table-wrap"><table class="md-table"><thead><tr>' + head.map((c) => "<th>" + inline(c, refs) + "</th>").join("") + "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + head.map((_, j) => "<td>" + inline(r[j] || "", refs) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>"
        );
        continue;
      }
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
        out.push("<blockquote>" + inline(buf.join(" "), refs) + "</blockquote>");
        continue;
      }
      if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, ""));
        out.push((ordered ? "<ol>" : "<ul>") + items.map((x) => "<li>" + inline(x, refs) + "</li>").join("") + (ordered ? "</ol>" : "</ul>"));
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+[.)])\s+)/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))) buf.push(lines[i++]);
      out.push("<p>" + buf.map((b) => inline(b, refs)).join("<br>") + "</p>");
    }
    return out.join("");
  }

  /* ---------- 노트 검색 (브라우저 모드·AI 없음) ---------- */
  const STOP = new Set(["정리", "정리해줘", "해줘", "알려줘", "관련", "대한", "내용", "자료", "그리고", "최근", "무엇", "어떻게", "핵심", "변화", "근거", "찾아", "요약", "요약해줘", "비교", "있는", "없는", "대해", "보고서", "리포트"]);
  function terms(text) {
    const out = [];
    (String(text || "").match(/[0-9A-Za-z가-힣]{2,}/g) || []).forEach((w) => {
      w = w.toLowerCase();
      const w2 = w.replace(/(은|는|이|가|을|를|의|와|과|에|에서|으로|로|도|만|까지|부터)$/, "");
      if (w2.length >= 2) w = w2;
      if (!STOP.has(w) && !out.includes(w)) out.push(w);
    });
    return out.slice(0, 12);
  }
  async function localAnswer(question) {
    const notes = await K.readNotes();
    const ts = terms(question);
    const scored = notes
      .map((n) => {
        const company = (n.company || "").toLowerCase();
        const title = (n.title || "").toLowerCase();
        const body = (n.body || "").toLowerCase();
        let score = 0;
        ts.forEach((t) => {
          if (company.includes(t) || (n.ticker && String(n.ticker).toLowerCase() === t)) score += 6;
          if (title.includes(t)) score += 3;
          if (body.includes(t)) score += 1 + Math.min(body.split(t).length - 1, 5) * 0.2;
        });
        return { n, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || String(b.n.date).localeCompare(String(a.n.date)))
      .slice(0, 12)
      .map((x) => x.n);
    const refs = scored.map((n) => ({ type: "note", id: n.id, title: n.title, company: n.company, date: n.date, author: n.author || "" }));
    const lines = ["> 서버 없이 열려 있어 AI 답변 대신 이 브라우저에 저장된 노트에서 찾은 내용을 보여 줍니다.", ""];
    if (!scored.length) {
      lines.push("질문과 관련된 노트를 찾지 못했습니다. 기업명이나 핵심 단어를 넣어 다시 물어봐 주세요.");
    } else {
      lines.push("## 관련 노트 " + scored.length + "건", "", "| 날짜 | 기업 | 제목 | 작성 |", "|---|---|---|---|");
      scored.forEach((n) => lines.push("| " + [n.date, n.company, n.title, n.author || ""].map((x) => String(x || "").replace(/\|/g, "/")).join(" | ") + " |"));
      lines.push("");
      scored.slice(0, 5).forEach((n, i) => {
        const body = String(n.body || "").replace(/\s+/g, " ").trim();
        const low = body.toLowerCase();
        const hits = ts.map((t) => low.indexOf(t)).filter((p) => p >= 0);
        const start = Math.max(0, (hits.length ? Math.min.apply(null, hits) : 0) - 80);
        lines.push("**[노트 " + (i + 1) + "] " + n.company + " · " + n.title + "** (" + n.date + ")", "", (start ? "…" : "") + body.slice(start, start + 320) + (body.length > start + 320 ? "…" : ""), "");
      });
    }
    return { answer: lines.join("\n"), refs, ai: false };
  }

  /* ---------- 대화 목록 ---------- */
  const byUpdated = (a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));

  function renderThreads() {
    const q = $("#thread-search").value.trim().toLowerCase();
    const all = threads.cached().slice().sort(byUpdated);
    const shown = q
      ? all.filter((t) => (t.title || "").toLowerCase().includes(q) || (t.messages || []).some((m) => String(m.content || "").toLowerCase().includes(q)))
      : all;
    $("#thread-list").innerHTML = shown.length
      ? shown.map((t) =>
          '<button type="button" class="thread' + (current && current.id === t.id ? " is-active" : "") + '" data-thread="' + esc(t.id) + '"><b>' + (t.unread ? "● " : "") + esc(t.title || "새 리서치") +
          "</b><span>" + esc(K.isoKst(t.updatedAt || t.createdAt || "")) + " · 메시지 " + (t.messages || []).length + "</span></button>"
        ).join("")
      : '<p class="empty" style="font-size:12px;padding:8px 2px">' + (q ? "검색 결과가 없습니다." : "아직 대화가 없습니다.") + "</p>";
  }

  function allRefs(t) {
    const seen = new Set();
    const out = [];
    ((t && t.messages) || []).forEach((m) => (m.refs || []).forEach((r) => {
      const key = r.type + ":" + (r.id || r.url);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
    }));
    return out;
  }

  function renderRefs() {
    const refs = allRefs(current);
    const box = $("#reference-list");
    if (!refs.length) {
      box.className = "artifact-empty";
      box.textContent = "아직 참고한 자료가 없습니다.";
      return;
    }
    box.className = "";
    const notes = refs.filter((r) => r.type === "note");
    const web = refs.filter((r) => r.type === "web");
    const shown = refFilter === "note" ? notes : refFilter === "web" ? web : refs;
    box.innerHTML =
      '<div aria-label="참고 자료 형식" class="reference-filters" role="group">' +
      [["all", "전체", refs.length], ["note", "노트", notes.length], ["web", "웹", web.length]]
        .filter((f) => f[0] === "all" || f[2])
        .map((f) => '<button type="button" class="reference-filter" data-ref-filter="' + f[0] + '" aria-pressed="' + (refFilter === f[0]) + '">' + f[1] + " " + f[2] + "</button>").join("") +
      "</div>" +
      shown.map((r) =>
        r.type === "note"
          ? '<button type="button" class="reference-item" data-note="' + esc(String(r.id)) + '"><span class="file-badge">노트</span><b>' + esc(r.company + " · " + r.title) + "</b><span>" + esc((r.date || "") + (r.author ? " · " + r.author : "")) + "</span></button>"
          : '<a class="reference-item" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer"><span class="file-badge file-badge--json">웹</span><b>' + esc(r.title || r.url) + "</b><span>" + esc((r.url.split("/")[2] || "")) + "</span></a>"
      ).join("");
  }

  function renderArtifacts() {
    const arts = (current && current.artifacts) || [];
    const box = $("#artifact-list");
    box.className = arts.length ? "" : "artifact-empty";
    box.innerHTML = arts.length
      ? arts.slice().reverse().map((a, i) => '<button type="button" class="artifact-item" data-artifact="' + (arts.length - 1 - i) + '"><b>' + esc(a.name) + "</b><span>" + esc(K.isoKst(a.at)) + " · HTML 리포트</span></button>").join("")
      : "아직 생성된 결과물이 없습니다.";
    $("#export-html").disabled = !current || !(current.messages || []).some((m) => m.role === "assistant");
  }

  function msgHtml(m, idx) {
    if (m.role === "user") {
      return '<div class="msg msg--user"><div class="msg__top"><span class="msg__role">나</span></div><div class="msg__body">' + esc(m.content).replace(/\n/g, "<br>") + "</div></div>";
    }
    const notes = (m.refs || []).filter((r) => r.type === "note");
    const web = (m.refs || []).filter((r) => r.type === "web");
    const refs = notes.length || web.length
      ? '<div class="msg__refs"><b>참고 자료 ' + (notes.length + web.length) + "</b><div>" +
        notes.map((r, i) => '<button type="button" data-note="' + esc(String(r.id)) + '"><span>노트 ' + (i + 1) + "</span><em>" + esc(r.company + " · " + r.title + " (" + r.date + ")") + "</em></button>").join("") +
        web.slice(0, 8).map((r) => '<button type="button" data-url="' + esc(r.url) + '"><span>웹</span><em>' + esc(r.title || r.url) + "</em></button>").join("") +
        "</div></div>"
      : "";
    return (
      '<div class="msg' + (m.error ? " msg--error" : "") + '" data-idx="' + idx + '"><div class="msg__top"><span class="msg__role">AI 리서치' + (m.ai === false ? " · 노트 검색" : "") +
      '</span><span class="msg__actions" style="margin:0;gap:6px"><button type="button" class="msg__copy" data-copy="' + idx + '">복사</button>' +
      (session.server ? '<button type="button" class="msg__copy" data-save="' + idx + '">답변 저장</button>' : "") +
      '</span></div><div class="msg__body md">' + markdown(m.content, m.refs) + "</div>" + refs + "</div>"
    );
  }

  function renderMessages() {
    const msgs = (current && current.messages) || [];
    $("#thread-title").textContent = (current && current.title) || "새 리서치";
    $("#thread-delete").hidden = !current;
    if (!msgs.length) {
      list.innerHTML =
        '<div class="empty" style="padding:40px 8px;line-height:1.8">' +
        "<b>무엇을 리서치할까요?</b><br>저장된 노트" + (status.ai ? "와 웹 검색" : "") + "을 찾아 근거와 함께 정리합니다.<br>" +
        (session.server
          ? status.ai
            ? '<span style="font-size:12px">AI 연결됨 · 답변에 20초~2분쯤 걸립니다.</span>'
            : '<span style="font-size:12px">AI 가 아직 연결되지 않아 노트 검색 결과만 보여 줍니다. (관리자: ANTHROPIC_API_KEY)</span>'
          : '<span style="font-size:12px">서버 없이 열려 있어 이 브라우저의 노트에서만 찾습니다.</span>') +
        "</div>";
    } else {
      list.innerHTML = msgs.map(msgHtml).join("");
    }
    list.scrollTop = list.scrollHeight;
    renderRefs();
    renderArtifacts();
  }

  function select(t) {
    current = t;
    renderThreads();
    renderMessages();
    if (t && t.unread) {
      t.unread = false;
      threads.update(t.id, { unread: false }).catch(() => {});
    }
  }

  /* ---------- 질문 보내기 ---------- */
  function pendingHtml() {
    return '<div class="msg is-pending" id="pending-msg"><div class="msg__top"><span class="msg__role">AI 리서치</span></div><div class="msg__body">' +
      "<b>" + (session.server && status.ai ? "노트를 찾고 AI 가 답변을 쓰는 중입니다" : "노트를 찾는 중입니다") + '</b> · <span data-elapsed>0초</span>' +
      (session.server && status.ai ? '<br><small>필요하면 웹에서 최신 공시·실적을 확인합니다. 창을 닫아도 다음에 다시 물어볼 수 있습니다.</small>' : "") + "</div></div>";
  }

  async function ask(question) {
    question = question.trim();
    if (!question || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = "";
    const now = new Date().toISOString();
    try {
      if (!current) {
        current = await threads.create({ title: question.slice(0, 40), messages: [], artifacts: [], updatedAt: now });
      }
      const history = (current.messages || []).map((m) => ({ role: m.role, content: m.content }));
      current.messages = (current.messages || []).concat({ role: "user", content: question, at: now });
      renderMessages();
      renderThreads();
      list.insertAdjacentHTML("beforeend", pendingHtml());
      list.scrollTop = list.scrollHeight;
      const t0 = Date.now();
      const timer = setInterval(() => {
        const el = $("#pending-msg [data-elapsed]");
        if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + "초";
      }, 500);
      let result;
      try {
        result = session.server ? await session.api("POST", "/api/research/ask", { question, history }) : await localAnswer(question);
      } catch (err) {
        result = { answer: "답변을 받지 못했습니다: " + err.message, refs: [], ai: false, error: true };
      } finally {
        clearInterval(timer);
      }
      current.messages.push({ role: "assistant", content: result.answer, refs: result.refs || [], ai: !!result.ai, error: !!result.error, at: new Date().toISOString() });
      current = await threads.update(current.id, { title: current.title, messages: current.messages, artifacts: current.artifacts || [], updatedAt: new Date().toISOString() });
      renderThreads();
      renderMessages();
    } catch (err) {
      toast(err.message || "저장하지 못했습니다.", true);
      const p = $("#pending-msg");
      if (p) p.remove();
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    ask(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask(input.value);
    }
  });
  $$(".prompt[data-prompt]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!current || !(current.messages || []).length) {
        input.value = b.getAttribute("data-prompt");
        input.focus();
        return;
      }
      ask(b.getAttribute("data-prompt"));
    })
  );

  $("#thread-new").addEventListener("click", () => {
    select(null);
    input.focus();
  });
  $("#thread-search").addEventListener("input", renderThreads);
  $("#thread-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-thread]");
    if (!b) return;
    const t = threads.cached().find((x) => x.id === b.getAttribute("data-thread"));
    if (t) select(t);
  });
  $("#thread-delete").addEventListener("click", async () => {
    if (!current) return;
    if (!(await K.confirm("이 대화를 삭제할까요?", "삭제", true))) return;
    try {
      await threads.remove(current.id);
      select(null);
      toast("대화를 삭제했습니다.");
    } catch (err) {
      toast(err.message, true);
    }
  });

  /* ---------- 노트 보기 ---------- */
  let notesCache = null;
  async function openNote(id) {
    if (!notesCache) notesCache = await K.readNotes();
    const n = notesCache.find((x) => String(x.id) === String(id));
    if (!n) {
      window.open("/notes/#note-" + encodeURIComponent(id), "_blank");
      return;
    }
    K.modal({
      title: n.company + " · " + n.title,
      size: "modal--wide",
      html:
        '<div class="modal__body"><p class="hint">' + esc([n.date, n.type, n.author].filter(Boolean).join(" · ")) + "</p>" +
        '<div style="white-space:pre-wrap;line-height:1.75;font-size:14px;margin:14px 0">' + esc(n.body || "본문이 없는 노트입니다.") + "</div>" +
        '<div class="modal__footer"><div class="modal__footer-right"><a class="btn btn--primary" href="/notes/#note-' + esc(String(n.id)) + '" target="_blank" rel="noopener">노트에서 열기</a></div></div></div>',
    });
  }

  root.addEventListener("click", async (e) => {
    const note = e.target.closest("[data-note]");
    if (note) {
      openNote(note.getAttribute("data-note"));
      return;
    }
    const url = e.target.closest("[data-url]");
    if (url) {
      window.open(url.getAttribute("data-url"), "_blank", "noopener");
      return;
    }
    const f = e.target.closest("[data-ref-filter]");
    if (f) {
      refFilter = f.getAttribute("data-ref-filter");
      renderRefs();
      return;
    }
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      const m = current.messages[Number(copy.getAttribute("data-copy"))];
      navigator.clipboard.writeText(m.content).then(() => toast("복사했습니다."), () => toast("복사하지 못했습니다.", true));
      return;
    }
    const save = e.target.closest("[data-save]");
    if (save) {
      const idx = Number(save.getAttribute("data-save"));
      const m = current.messages[idx];
      const q = (current.messages.slice(0, idx).reverse().find((x) => x.role === "user") || {}).content || current.title;
      save.disabled = true;
      try {
        await session.api("POST", "/api/saved", {
          question: q,
          answerHtml: markdown(m.content, m.refs),
          notes: (m.refs || []).filter((r) => r.type === "note").map((r) => ({ id: r.id, label: r.company + " · " + r.title })),
        });
        save.textContent = "저장됨 ✓";
        toast("답변을 저장했습니다. 노트 화면의 🔖 저장한 답변에서 볼 수 있습니다.");
      } catch (err) {
        save.disabled = false;
        toast(err.message, true);
      }
      return;
    }
    const art = e.target.closest("[data-artifact]");
    if (art) openReport(current.artifacts[Number(art.getAttribute("data-artifact"))].name);
  });

  /* ---------- HTML 리포트 ---------- */
  function reportHtml(title) {
    const msgs = current.messages || [];
    const body = msgs.map((m) =>
      m.role === "user"
        ? '<h2 class="q">Q. ' + esc(m.content) + "</h2>"
        : '<section class="a">' + markdown(m.content, m.refs) + "</section>"
    ).join("");
    const refs = allRefs(current);
    return (
      '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + "</title>" +
      "<style>body{font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:860px;margin:40px auto;padding:0 24px;color:#17202b;line-height:1.75}" +
      "header{border-bottom:3px solid #00857b;padding-bottom:14px;margin-bottom:28px}h1{font-size:24px;margin:0 0 6px}header p{color:#6b7c73;margin:0;font-size:13px}" +
      ".q{font-size:16px;color:#00857b;margin:32px 0 10px}table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}th,td{border:1px solid #dbe4de;padding:6px 9px;text-align:left}th{background:#f1f6f3}" +
      "blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid #c9dcd2;color:#56695f;background:#f7faf8}.note-ref{border:1px solid #c7d2fe;border-radius:10px;background:#eef2ff;color:#4338ca;font-size:11px;padding:0 6px}" +
      "footer{margin-top:40px;border-top:1px solid #dbe4de;padding-top:14px;font-size:12px;color:#6b7c73}@media print{body{margin:0}}</style></head><body>" +
      "<header><h1>" + esc(title) + "</h1><p>업무공간 AI 리서치 · " + esc(K.isoKst(new Date().toISOString())) + " KST</p></header>" + body +
      (refs.length
        ? "<footer><b>참고 자료</b><ol>" + refs.map((r) => "<li>" + (r.type === "note" ? "노트 · " + esc(r.company + " · " + r.title + " (" + r.date + ")") : '<a href="' + esc(r.url) + '">' + esc(r.title || r.url) + "</a>") + "</li>").join("") + "</ol></footer>"
        : "") +
      "</body></html>"
    );
  }
  function openReport(name) {
    const url = URL.createObjectURL(new Blob([reportHtml(name)], { type: "text/html;charset=utf-8" }));
    const w = window.open(url, "_blank");
    if (!w) {
      const a = document.createElement("a");
      a.href = url;
      a.download = name + ".html";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  $("#export-html").addEventListener("click", async () => {
    if (!current) return;
    const name = (current.title || "리서치") + " 리포트";
    openReport(name);
    current.artifacts = (current.artifacts || []).concat({ name, at: new Date().toISOString() });
    try {
      current = await threads.update(current.id, { artifacts: current.artifacts });
    } catch (err) {
      /* 목록 저장 실패는 무시 */
    }
    renderArtifacts();
  });

  /* ---------- 오른쪽 패널·폭 조절 ---------- */
  $("#panel-close").addEventListener("click", () => {
    const collapsed = root.classList.toggle("research--panel-collapsed");
    $("#panel-close").textContent = collapsed ? "펼치기" : "접기";
    K.prefs.set("research.panel", collapsed);
  });
  if (K.prefs.get("research.panel", false)) {
    root.classList.add("research--panel-collapsed");
    $("#panel-close").textContent = "펼치기";
  }
  $("#reference-toggle").addEventListener("click", (e) => {
    const box = $("#reference-box");
    const collapsed = box.classList.toggle("is-collapsed");
    e.currentTarget.textContent = collapsed ? "펼치기" : "접기";
    e.currentTarget.setAttribute("aria-expanded", String(!collapsed));
  });
  ["side", "panel"].forEach((which) => {
    const saved = K.prefs.get("research." + which + "Width", null);
    if (saved) root.style.setProperty("--" + which + "-width", saved + "px");
  });
  $$("[data-resize]").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      const which = handle.getAttribute("data-resize");
      const startX = e.clientX;
      const startW = parseFloat(getComputedStyle(root).getPropertyValue("--" + which + "-width")) || (which === "side" ? 260 : 320);
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("is-resizing");
      let w = startW;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        w = Math.max(200, Math.min(520, which === "side" ? startW + dx : startW - dx));
        root.style.setProperty("--" + which + "-width", w + "px");
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        document.body.classList.remove("is-resizing");
        K.prefs.set("research." + which + "Width", Math.round(w));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  });

  /* ---------- 예약 리서치 ---------- */
  const dlg = $("#schedule-dialog");
  const sf = $("#schedule-form");
  let schedules = [];
  let editing = null;
  const CAD = { weekdays: "평일", daily: "매일", weekly: "매주", monthly: "매월", once: "한 번", cron: "cron" };
  const WD = ["월", "화", "수", "목", "금", "토", "일"];

  function schedValue() {
    return {
      name: $("#schedule-name").value.trim(),
      prompt: $("#schedule-prompt").value.trim(),
      cadence: $("#schedule-cadence").value,
      time: $("#schedule-time").value || "08:00",
      weekday: Number($("#schedule-weekday").value),
      monthday: Number($("#schedule-monthday").value || 1),
      date: $("#schedule-date").value,
      cron: $("#schedule-cron").value.trim(),
      enabled: editing ? editing.enabled !== false : true,
    };
  }
  function syncFields() {
    const c = $("#schedule-cadence").value;
    $("#schedule-time-wrap").hidden = c === "cron";
    $("#schedule-weekday-wrap").hidden = c !== "weekly";
    $("#schedule-monthday-wrap").hidden = c !== "monthly";
    $("#schedule-date-wrap").hidden = c !== "once";
    $("#schedule-cron-wrap").hidden = c !== "cron";
    preview();
  }
  let previewTimer = 0;
  function preview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const box = $("#schedule-preview");
      if (!session.server) return;
      try {
        const out = await session.api("POST", "/api/research/schedules/preview", schedValue());
        box.classList.remove("is-error");
        box.textContent = out.runs.length ? "다음 실행: " + out.runs.map((r) => K.isoKst(r)).join(" · ") : "다음 실행 시각이 없습니다.";
      } catch (err) {
        box.classList.add("is-error");
        box.textContent = err.message;
      }
    }, 250);
  }
  function describe(s) {
    if (s.cadence === "cron") return "cron <code>" + esc(s.cron) + "</code>";
    const when = s.cadence === "weekly" ? "매주 " + WD[s.weekday || 0] + "요일" : s.cadence === "monthly" ? "매월 " + (s.monthday || 1) + "일" : s.cadence === "once" ? s.date : CAD[s.cadence];
    return esc(when + " " + (s.time || ""));
  }
  function renderSchedules() {
    $("#schedule-count").textContent = schedules.length ? "(" + schedules.length + ")" : "";
    $("#schedule-list").innerHTML = schedules.length
      ? schedules.map((s) =>
          '<div class="schedule-card" data-sid="' + esc(s.id) + '"><div class="schedule-card__head"><h4>' + esc(s.name) + '</h4><span class="schedule-badge' + (s.enabled ? "" : " is-paused") + '">' + (s.enabled ? "사용 중" : "일시정지") + "</span></div>" +
          '<p class="schedule-card__prompt">' + esc(s.prompt) + "</p>" +
          '<p class="schedule-card__time">' + describe(s) + (s.enabled && s.nextRunAt ? " · 다음 " + esc(K.isoKst(s.nextRunAt)) : "") + (s.lastRunAt ? " · 마지막 " + esc(K.isoKst(s.lastRunAt)) + (s.lastStatus === "error" ? " (오류)" : "") : "") + "</p>" +
          '<div class="schedule-actions"><button type="button" class="btn btn--ghost btn--sm" data-sact="run">지금 실행</button><button type="button" class="btn btn--ghost btn--sm" data-sact="toggle">' + (s.enabled ? "일시정지" : "다시 시작") +
          '</button><button type="button" class="btn btn--ghost btn--sm" data-sact="edit">수정</button><button type="button" class="btn btn--ghost btn--sm" data-sact="delete">삭제</button>' +
          (s.lastThreadId ? '<button type="button" class="btn btn--ghost btn--sm" data-sact="open">결과 보기</button>' : "") + "</div></div>"
        ).join("")
      : '<p class="empty" style="font-size:13px">등록한 예약이 없습니다.</p>';
  }
  async function loadSchedules() {
    if (!session.server) {
      $("#schedule-list").innerHTML = '<p class="schedule-alert">예약 작업은 서버에서 실행되므로 서버 모드(로그인)에서만 쓸 수 있습니다.</p>';
      sf.querySelectorAll("input, textarea, select, button").forEach((el) => (el.disabled = true));
      return;
    }
    try {
      schedules = await session.api("GET", "/api/research/schedules");
      renderSchedules();
    } catch (err) {
      $("#schedule-list").innerHTML = '<p class="schedule-alert">' + esc(err.message) + "</p>";
    }
  }
  function resetForm() {
    editing = null;
    sf.reset();
    $("#schedule-time").value = "08:00";
    $("#schedule-form-title").textContent = "새 예약";
    $("#schedule-save").textContent = "예약 저장";
    syncFields();
  }
  $("#schedule-open").addEventListener("click", () => {
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    resetForm();
    loadSchedules();
  });
  $("#schedule-close").addEventListener("click", () => dlg.close());
  $("#schedule-reset").addEventListener("click", resetForm);
  $("#schedule-cadence").addEventListener("change", syncFields);
  ["#schedule-time", "#schedule-weekday", "#schedule-monthday", "#schedule-date", "#schedule-cron"].forEach((sel) => $(sel).addEventListener("input", preview));
  sf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = schedValue();
    if (!v.name || !v.prompt) return toast("작업 이름과 리서치 요청을 적어 주세요.", true);
    try {
      if (editing) await session.api("PUT", "/api/research/schedules/" + editing.id, v);
      else await session.api("POST", "/api/research/schedules", v);
      toast(editing ? "예약을 고쳤습니다." : "예약을 저장했습니다.");
      resetForm();
      loadSchedules();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#schedule-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-sact]");
    if (!b) return;
    const s = schedules.find((x) => x.id === b.closest("[data-sid]").getAttribute("data-sid"));
    if (!s) return;
    const act = b.getAttribute("data-sact");
    try {
      if (act === "edit") {
        editing = s;
        $("#schedule-name").value = s.name;
        $("#schedule-prompt").value = s.prompt;
        $("#schedule-cadence").value = s.cadence;
        $("#schedule-time").value = s.time || "08:00";
        $("#schedule-weekday").value = String(s.weekday || 0);
        $("#schedule-monthday").value = String(s.monthday || 1);
        $("#schedule-date").value = s.date || "";
        $("#schedule-cron").value = s.cron || "";
        $("#schedule-form-title").textContent = "예약 수정";
        $("#schedule-save").textContent = "수정 저장";
        syncFields();
      } else if (act === "toggle") {
        await session.api("PUT", "/api/research/schedules/" + s.id, Object.assign({}, s, { enabled: !s.enabled }));
        loadSchedules();
      } else if (act === "delete") {
        if (!(await K.confirm("'" + s.name + "' 예약을 삭제할까요?", "삭제", true))) return;
        await session.api("DELETE", "/api/research/schedules/" + s.id);
        loadSchedules();
      } else if (act === "run") {
        b.disabled = true;
        b.textContent = "실행 중…";
        const thread = await session.api("POST", "/api/research/schedules/" + s.id + "/run");
        await threads.list();
        renderThreads();
        toast("실행했습니다. 결과를 대화 목록에 저장했습니다.");
        loadSchedules();
        const t = threads.cached().find((x) => x.id === thread.id);
        if (t) {
          dlg.close();
          select(t);
        }
      } else if (act === "open") {
        await threads.list();
        const t = threads.cached().find((x) => x.id === s.lastThreadId);
        if (t) {
          dlg.close();
          select(t);
        } else toast("결과 대화를 찾지 못했습니다. 삭제되었을 수 있습니다.", true);
      }
    } catch (err) {
      toast(err.message, true);
      loadSchedules();
    }
  });

  /* ---------- 시작 ---------- */
  K.session().then(async (s) => {
    session = s;
    if (s.server) status = await s.api("GET", "/api/integrations").catch(() => ({ ai: false }));
    try {
      await threads.list();
    } catch (err) {
      toast(err.message, true);
    }
    const params = new URLSearchParams(location.search);
    const tid = params.get("thread");
    const t = tid ? threads.cached().find((x) => x.id === tid) : null;
    select(t || null);
    const q = params.get("q");
    if (q) {
      history.replaceState(null, "", location.pathname);
      ask(q);
    }
  });
})();
