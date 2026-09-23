/* 내 정보: 프로필·본부·비밀번호·권한 (서버), 브라우저 모드에서는 이름·백업 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, esc, toast } = K;

  function feedback(el, msg, isError) {
    el.textContent = msg;
    el.classList.toggle("is-error", !!isError);
    el.hidden = false;
  }

  function fact(label, value) {
    return "<dt>" + esc(label) + "</dt><dd>" + esc(value || "-") + "</dd>";
  }

  K.session().then((s) => {
    const pf = $("#profile-form");
    if (!s.server) {
      document.querySelectorAll("[data-server-only]").forEach((el) => (el.hidden = true));
      $("#account-local").hidden = false;
      $("#account-role").textContent = "브라우저 저장";
      const name = localStorage.getItem("hana.profile.name") || "";
      $("#account-name").textContent = name || "사용자";
      pf.elements.displayName.value = name;
      $("#account-facts").innerHTML = fact("저장 위치", "이 브라우저 (localStorage·IndexedDB)");
      pf.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = pf.elements.displayName.value.trim();
        if (!v) return feedback($("#profile-feedback"), "이름을 입력해 주세요.", true);
        localStorage.setItem("hana.profile.name", v);
        feedback($("#profile-feedback"), "저장했습니다. 새로 쓰는 노트·일정의 작성자로 쓰입니다.");
        $("#account-name").textContent = v;
        const st = document.querySelector(".hana-account-copy strong");
        if (st) st.textContent = v;
      });
      $("#local-export").addEventListener("click", () => {
        const data = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf("hana.") === 0) data[k] = localStorage.getItem(k);
        }
        K.saveText("업무공간-백업-" + K.today() + ".json", JSON.stringify({ app: "hana-workspace", savedAt: new Date().toISOString(), data }, null, 1), "application/json");
      });
      $("#local-import").addEventListener("change", async (e) => {
        const f = e.target.files[0];
        e.target.value = "";
        if (!f) return;
        try {
          const j = JSON.parse(await f.text());
          if (!j || j.app !== "hana-workspace" || typeof j.data !== "object") throw new Error("업무공간 백업 파일이 아닙니다.");
          if (!(await K.confirm("백업을 불러오면 이 브라우저의 같은 항목을 덮어씁니다. 계속할까요?", "불러오기"))) return;
          Object.keys(j.data).forEach((k) => {
            if (k.indexOf("hana.") === 0) localStorage.setItem(k, j.data[k]);
          });
          toast("백업을 불러왔습니다.");
          setTimeout(() => location.reload(), 600);
        } catch (err) {
          toast(err.message || "파일을 읽지 못했습니다.", true);
        }
      });
      return;
    }

    let me = s.me;
    const first = me.mustChange || new URLSearchParams(location.search).get("first") === "1";
    $("#account-first").hidden = !me.mustChange;
    const sel = pf.elements.department;
    sel.innerHTML = (me.departments || []).map((d) => '<option value="' + esc(d === "미지정" ? "" : d) + '">' + esc(d) + "</option>").join("");
    if (me.department && !(me.departments || []).includes(me.department)) sel.insertAdjacentHTML("beforeend", '<option value="' + esc(me.department) + '">' + esc(me.department) + "</option>");

    function render() {
      $("#account-name").textContent = me.displayName;
      $("#account-role").textContent = me.roleLabel;
      $("#account-facts").innerHTML =
        fact("아이디", me.username) + fact("등급", me.roleLabel) + fact("본부", me.department || "미지정") + fact("마지막 로그인", me.lastLoginAt ? K.isoKst(me.lastLoginAt) : "");
      pf.elements.displayName.value = me.displayName;
      pf.elements.email.value = me.email || "";
      sel.value = me.department || "";
      const feats = me.features || {};
      $("#perm-list").innerHTML = Object.keys(feats)
        .map((k) => '<li class="' + ((me.permissions || []).includes(k) ? "is-on" : "") + '">' + ((me.permissions || []).includes(k) ? "✓ " : "") + esc(feats[k]) + "</li>")
        .join("");
    }
    render();
    if (first) {
      $("#password-form").elements.current.focus();
      $("#account-password").scrollIntoView({ block: "center" });
    }

    pf.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = pf.elements;
      try {
        const out = await s.api("PUT", "/api/profile", { displayName: f.displayName.value.trim(), email: f.email.value.trim(), department: f.department.value });
        me = Object.assign(me, out);
        render();
        const st = document.querySelector(".hana-account-copy strong");
        if (st) st.textContent = me.displayName;
        const sm = document.querySelector(".hana-account-copy small");
        if (sm) sm.textContent = me.roleLabel + " · " + (me.department || "미지정");
        feedback($("#profile-feedback"), "저장했습니다.");
      } catch (err) {
        feedback($("#profile-feedback"), err.message, true);
      }
    });

    const pw = $("#password-form");
    pw.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = pw.elements;
      const fb = $("#password-feedback");
      if (f.next.value.length < 8) return feedback(fb, "새 비밀번호는 8자 이상이어야 합니다.", true);
      if (f.next.value !== f.confirm.value) return feedback(fb, "새 비밀번호가 서로 다릅니다.", true);
      try {
        await s.api("POST", "/api/password", { current: f.current.value, new: f.next.value });
        pw.reset();
        feedback(fb, "비밀번호를 바꿨습니다. 다른 기기의 로그인은 끊었습니다.");
        if (me.mustChange) {
          me.mustChange = false;
          $("#account-first").hidden = true;
          toast("비밀번호를 바꿨습니다. 홈으로 이동합니다.");
          setTimeout(() => location.replace("/"), 900);
        }
      } catch (err) {
        feedback(fb, err.message, true);
      }
    });

    $("#logout-all").addEventListener("click", async () => {
      if (!(await K.confirm("모든 기기에서 로그아웃할까요?", "로그아웃"))) return;
      await s.api("POST", "/api/logout-all").catch(() => {});
      await s.api("POST", "/api/logout").catch(() => {});
      location.href = "/login";
    });
  });
})();
