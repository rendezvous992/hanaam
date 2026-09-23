/* 워크스페이스 공통 셸: 사이드바 접기/펼치기, 모바일 메뉴, 한국 시간 시계, 토스트 */
(function () {
  "use strict";

  var root = document.documentElement;
  var body = document.body;
  var SIDEBAR_KEY = "hana.sidebar";
  var MOBILE = window.matchMedia("(max-width: 900px)");

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) {
      return null;
    }
    return null;
  }

  /* ---------- 토스트 ---------- */
  var toastEl = null;
  var toastTimer = 0;
  function toast(message, isError) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "notice-toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.toggle("notice-toast--error", !!isError);
    // 다음 프레임에 켜야 transition 이 동작한다
    window.requestAnimationFrame(function () {
      toastEl.classList.add("notice-toast--on");
    });
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.classList.remove("notice-toast--on");
    }, 2600);
  }
  window.hanaToast = toast;

  /* ---------- 사이드바 ---------- */
  var sidebar = document.getElementById("hana-navigation");
  var toggles = document.querySelectorAll("[data-hana-toggle]");
  var backdrop = null;

  function isCollapsed() {
    return root.getAttribute("data-hana-sidebar") === "collapsed";
  }

  function syncToggles(expanded) {
    var label = expanded ? "메뉴 접기" : "메뉴 펼치기";
    toggles.forEach(function (btn) {
      btn.setAttribute("aria-expanded", String(expanded));
      btn.setAttribute("aria-label", label);
      if (btn.classList.contains("hana-sidebar-fold")) {
        btn.title = label + " · Alt+S";
        var span = btn.querySelector("span");
        if (span) span.textContent = label;
      }
    });
    if (sidebar) sidebar.setAttribute("aria-hidden", String(!expanded));
  }

  function setMobileOpen(open) {
    body.classList.toggle("hana-mobile-open", open);
    if (open && !backdrop) {
      backdrop = document.createElement("button");
      backdrop.type = "button";
      backdrop.className = "hana-backdrop";
      backdrop.setAttribute("aria-label", "메뉴 닫기");
      backdrop.addEventListener("click", function () {
        setMobileOpen(false);
      });
      body.appendChild(backdrop);
    }
    if (backdrop) backdrop.hidden = !open;
    syncToggles(open);
  }

  function setCollapsed(collapsed) {
    root.setAttribute("data-hana-sidebar", collapsed ? "collapsed" : "expanded");
    store(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
    syncToggles(!collapsed);
  }

  function toggleSidebar() {
    if (MOBILE.matches) {
      setMobileOpen(!body.classList.contains("hana-mobile-open"));
    } else {
      setCollapsed(!isCollapsed());
    }
  }

  function applyLayout() {
    if (MOBILE.matches) {
      setMobileOpen(false);
    } else {
      body.classList.remove("hana-mobile-open");
      if (backdrop) backdrop.hidden = true;
      syncToggles(!isCollapsed());
    }
  }

  if (store(SIDEBAR_KEY) === "collapsed") {
    root.setAttribute("data-hana-sidebar", "collapsed");
  }
  toggles.forEach(function (btn) {
    btn.addEventListener("click", toggleSidebar);
  });
  document.addEventListener("keydown", function (e) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === "KeyS" || e.key === "s" || e.key === "S")) {
      e.preventDefault();
      toggleSidebar();
    } else if (e.key === "Escape" && body.classList.contains("hana-mobile-open")) {
      setMobileOpen(false);
    }
  });
  if (MOBILE.addEventListener) MOBILE.addEventListener("change", applyLayout);
  applyLayout();

  /* ---------- 사이드바 그룹 열림 상태 기억 ---------- */
  document.querySelectorAll(".hana-nav-group").forEach(function (group, i) {
    var key = "hana.navgroup." + i;
    if (group.querySelector(".is-active")) group.open = true;
    else if (store(key) === "1") group.open = true;
    group.addEventListener("toggle", function () {
      store(key, group.open ? "1" : "0");
    });
  });

  /* ---------- 서버 모드: 로그인한 사용자 표시 · 로그아웃 · 비밀번호 변경 ---------- */
  // 서버가 내준 화면에는 <meta name="hana-mode" content="server"> 가 붙는다.
  // 파일로 열거나 정적 호스팅으로 열면 서버 없이(브라우저 저장) 동작한다.
  var serverMode = !!document.querySelector('meta[name="hana-mode"][content="server"]');

  function apiFetch(method, url, body) {
    var opts = { method: method, credentials: "same-origin", headers: { "X-Hana": "1" } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.status === 401 && url !== "/api/password") {
          window.location.href = "/login?next=" + encodeURIComponent(window.location.pathname + window.location.search);
        }
        if (!res.ok) throw new Error((data && typeof data.detail === "string" && data.detail) || "서버 오류 (" + res.status + ")");
        return data;
      });
    });
  }

  var ROLE_LABEL = { super: "최고 관리자", admin: "계정 관리자", member: "일반" };
  // 권한이 있어야 보이는 메뉴
  var NAV_FEATURE = { "/research/": "ai_research", "/portfolio/": "portfolio", "/workload/": "workload", "/stats/": "note_stats" };

  function applyUser(me) {
    var name = me.displayName || me.username;
    var strong = document.querySelector(".hana-account-copy strong");
    var small = document.querySelector(".hana-account-copy small");
    var avatar = document.querySelector(".hana-user-avatar");
    var metaLink = document.querySelector(".hana-topbar-meta > a");
    if (strong) strong.textContent = name;
    if (small) small.textContent = (ROLE_LABEL[me.role] || "일반") + " · " + (me.department || "미지정");
    if (avatar) avatar.textContent = name.charAt(0).toUpperCase();
    if (metaLink) metaLink.textContent = name;
    document.querySelectorAll(".hana-account, .hana-topbar-meta > a").forEach(function (a) {
      a.removeAttribute("data-hana-stub");
      a.setAttribute("href", "/account/");
      a.title = "내 정보";
    });
    var perms = me.permissions || [];
    document.querySelectorAll("#hana-navigation a[href]").forEach(function (a) {
      var href = a.getAttribute("href");
      var need = NAV_FEATURE[href];
      var hide = (need && perms.indexOf(need) < 0) || (href === "/admin/users/" && me.role !== "admin" && me.role !== "super");
      if (hide) a.hidden = true;
    });
    // 안쪽 메뉴가 모두 숨겨진 묶음은 묶음째 숨긴다
    document.querySelectorAll("#hana-navigation .hana-nav-group").forEach(function (g) {
      var kids = g.querySelectorAll("a.hana-nav-child");
      if (kids.length && Array.prototype.every.call(kids, function (k) { return k.hidden; })) g.hidden = true;
    });
    document.documentElement.setAttribute("data-hana-role", me.role);
  }

  function openPasswordDialog() {
    var overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML =
      '<div class="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="pw-title">' +
      '<div class="modal__header"><h2 id="pw-title">비밀번호 변경</h2><button type="button" class="modal__close" aria-label="닫기">×</button></div>' +
      '<form class="modal__body" novalidate>' +
      '<div class="banner banner--error banner--inline" hidden></div>' +
      '<label class="field"><span class="field__label">현재 비밀번호</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>' +
      '<label class="field"><span class="field__label">새 비밀번호 (8자 이상)</span><input class="input" type="password" name="next" autocomplete="new-password" minlength="8" required></label>' +
      '<label class="field"><span class="field__label">새 비밀번호 확인</span><input class="input" type="password" name="confirm" autocomplete="new-password" required></label>' +
      '<div class="modal__footer"><div class="modal__footer-right"><button type="button" class="btn btn--ghost" data-close>취소</button>' +
      '<button type="submit" class="btn btn--primary">변경</button></div></div></form></div>';
    body.appendChild(overlay);
    body.style.overflow = "hidden";
    var form = overlay.querySelector("form");
    var err = overlay.querySelector(".banner");
    function close() {
      overlay.remove();
      body.style.overflow = "";
      document.removeEventListener("keydown", onKey, true);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target.closest(".modal__close, [data-close]")) close();
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var f = form.elements;
      function fail(msg) {
        err.textContent = msg;
        err.hidden = false;
      }
      if (f.next.value.length < 8) return fail("새 비밀번호는 8자 이상이어야 합니다.");
      if (f.next.value !== f.confirm.value) return fail("새 비밀번호가 서로 다릅니다.");
      apiFetch("POST", "/api/password", { current: f.current.value, new: f.next.value })
        .then(function () {
          close();
          toast("비밀번호를 바꿨습니다.");
        })
        .catch(function (e2) {
          fail(e2.message);
        });
    });
    form.elements.current.focus();
  }

  // app.js 등 다른 스크립트가 기다릴 수 있도록 세션 정보를 약속(Promise)으로 내놓는다
  window.hanaSession = serverMode
    ? apiFetch("GET", "/api/me").then(function (me) {
        applyUser(me);
        return { server: true, me: me, api: apiFetch };
      })
    : Promise.resolve({ server: false, me: null, api: null });

  if (!serverMode) {
    var localName = store("hana.profile.name");
    if (localName) {
      var st = document.querySelector(".hana-account-copy strong");
      var av = document.querySelector(".hana-user-avatar");
      var ml = document.querySelector(".hana-topbar-meta > a");
      if (st) st.textContent = localName;
      if (av) av.textContent = localName.charAt(0).toUpperCase();
      if (ml) ml.textContent = localName;
    }
    var sm = document.querySelector(".hana-account-copy small");
    if (sm) sm.textContent = "이 브라우저에 저장";
  }

  window.hanaPasswordDialog = openPasswordDialog;

  if (serverMode) {
    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-hana-account]")) {
        e.preventDefault();
        openPasswordDialog();
      }
    });
    document.querySelectorAll("form[data-hana-stub-form]").forEach(function (form) {
      form.removeAttribute("data-hana-stub-form");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        apiFetch("POST", "/api/logout").finally(function () {
          window.location.href = "/login";
        });
      });
    });
  }

  /* ---------- 복제되지 않은 메뉴 ---------- */
  // data-hana-stub 이 붙은 링크는 이 저장소에 페이지가 없다.
  document.addEventListener("click", function (e) {
    var link = e.target.closest("[data-hana-stub]");
    if (!link) return;
    e.preventDefault();
    var name = link.getAttribute("data-hana-stub") || link.textContent.trim();
    toast("'" + name + "' 메뉴는 이 복제본에 포함되어 있지 않습니다.");
  });
  document.querySelectorAll("form[data-hana-stub-form]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      toast("로그인 기능이 없는 정적 복제본이라 로그아웃할 수 없습니다.");
    });
  });

  /* ---------- 한국 시간 시계 ---------- */
  var WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function kstNow() {
    // UTC 기준 +9시간을 더한 Date 의 UTC 필드를 KST 로 읽는다
    return new Date(Date.now() + 9 * 3600 * 1000);
  }
  function formatClock(d) {
    return (
      d.getUTCFullYear() + ". " + pad(d.getUTCMonth() + 1) + ". " + pad(d.getUTCDate()) +
      ". (" + WEEKDAYS[d.getUTCDay()] + ") " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " KST"
    );
  }
  var clocks = document.querySelectorAll("[data-hana-clock]");
  function tick() {
    var now = new Date();
    var text = formatClock(kstNow());
    clocks.forEach(function (el) {
      el.textContent = text;
      el.setAttribute("datetime", now.toISOString());
    });
  }
  if (clocks.length) {
    tick();
    // 분이 바뀌는 순간에 맞춰 갱신
    window.setTimeout(function () {
      tick();
      window.setInterval(tick, 60 * 1000);
    }, (60 - new Date().getSeconds()) * 1000);
  }
})();
