/* 저장한 답변 모아보기 — '노트에게 물어보기'에서 저장한 답변(localStorage)을 보여준다 */
(function () {
  "use strict";

  const SAVED_KEY = "hana.notes.savedAnswers";
  const list = document.getElementById("saved-list");
  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function kstLabel(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return "";
    const d = new Date(t + 9 * 3600 * 1000);
    return d.getUTCFullYear() + ". " + pad(d.getUTCMonth() + 1) + ". " + pad(d.getUTCDate()) +
      " (" + WEEKDAYS[d.getUTCDay()] + ") " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  }
  // 서버 모드면 /api/saved, 아니면 이 브라우저의 localStorage
  let session = { server: false, api: null };

  function readLocal() {
    try {
      const v = JSON.parse(window.localStorage.getItem(SAVED_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }
  async function read() {
    return session.server ? session.api("GET", "/api/saved") : readLocal();
  }
  async function remove(id) {
    if (session.server) {
      await session.api("DELETE", "/api/saved/" + encodeURIComponent(id));
      return;
    }
    try {
      window.localStorage.setItem(SAVED_KEY, JSON.stringify(readLocal().filter((a) => a.id !== id)));
    } catch (e) {
      /* 저장 공간 오류는 무시 */
    }
  }

  async function render() {
    let items;
    try {
      items = await read();
    } catch (err) {
      list.innerHTML = '<div class="banner banner--error">저장한 답변을 불러오지 못했습니다: ' + esc(err.message) + "</div>";
      return;
    }
    if (!items.length) {
      list.innerHTML =
        '<div class="results__empty"><p class="results__empty-title">저장한 답변이 없습니다</p>' +
        '<p class="results__empty-text">노트 화면의 <strong>노트에게 물어보기</strong>에서 답변을 받은 뒤 <strong>답변 저장</strong>을 누르면 여기에 모입니다.</p></div>';
      return;
    }
    list.innerHTML = items
      .map(
        (a) =>
          '<article class="ask" style="margin-bottom:0" data-id="' + esc(a.id) + '">' +
          '<div class="ask__meta"><span>' + esc(kstLabel(a.savedAt)) + " 저장</span>" +
          '<button type="button" class="ask__close" data-remove="' + esc(a.id) + '" aria-label="이 답변 삭제" title="삭제">×</button></div>' +
          '<div class="ask__form"><span class="ask__icon" aria-hidden="true">✦</span><strong class="note-card__company">' + esc(a.question) + "</strong></div>" +
          '<div class="ask__result"><div class="ask__answer">' + neutralize(a.answerHtml) + "</div>" +
          (a.notes && a.notes.length
            ? '<div class="ask__cited"><span class="ask__cited-label">근거 노트</span>' +
              a.notes
                .map((n, i) => '<a class="ask__cite ask__cite--full" href="./#note-' + esc(n.id) + '">[' + (i + 1) + "] " + esc(n.label) + "</a>")
                .join("") +
              "</div>"
            : "") +
          "</div></article>"
      )
      .join("");
  }

  // 저장된 답변 HTML 은 이 앱이 만든 것이지만, 인용 버튼만 노트 링크로 바꾸고 나머지 스크립트성 속성은 걷어낸다
  function neutralize(html) {
    const tpl = document.createElement("template");
    // 저장된 HTML 을 그대로 붙이기 전에 걸러낸다 (서버 모드에서는 다른 경로로 들어온 값일 수도 있다)
    tpl.innerHTML = html || "";
    tpl.content.querySelectorAll("script, iframe, object, embed").forEach((n) => n.remove());
    tpl.content.querySelectorAll("*").forEach((n) => {
      Array.from(n.attributes).forEach((attr) => {
        if (/^on/i.test(attr.name) || (attr.name === "href" && /^\s*javascript:/i.test(attr.value))) n.removeAttribute(attr.name);
      });
      if (n.matches("button[data-open]")) {
        const a = document.createElement("a");
        a.className = n.className;
        a.href = "./#note-" + n.getAttribute("data-open");
        a.textContent = n.textContent;
        n.replaceWith(a);
      }
    });
    return tpl.innerHTML;
  }

  list.addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-remove]");
    if (!rm) return;
    if (!window.confirm("이 답변을 삭제할까요?")) return;
    try {
      await remove(rm.getAttribute("data-remove"));
    } catch (err) {
      window.alert("삭제하지 못했습니다: " + err.message);
    }
    render();
  });
  window.addEventListener("storage", (e) => {
    if (!session.server && e.key === SAVED_KEY) render();
  });

  (window.hanaSession || Promise.resolve(session))
    .then((s) => {
      session = s;
    })
    .catch(() => {})
    .then(render);
})();
