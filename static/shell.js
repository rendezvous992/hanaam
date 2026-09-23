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
