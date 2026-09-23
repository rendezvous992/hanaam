/* 계정 관리: 계정 만들기(임시 비밀번호), 가입 승인, 계정 목록(본부·등급·상태·비밀번호 초기화·삭제),
   탭·기능 권한, 본부 목록, 접속 중인 세션 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, esc, toast } = K;

  K.session().then((s) => {
    const root = $(".admin");
    if (!s.server) {
      root.insertAdjacentHTML(
        "afterbegin",
        '<div class="banner banner--warn">지금은 서버 없이(브라우저 저장) 열려 있어 계정 관리를 쓸 수 없습니다. 서버(Vercel+DB 또는 설치형)로 열면 가입 승인·권한 관리가 동작합니다.</div>'
      );
      root.querySelectorAll("form, button").forEach((el) => (el.disabled = true));
      return;
    }

    let data = null; // { me, users, features, departments, roles }
    const api = s.api;

    function showCredential(username, temp, what) {
      $("#admin-credential").innerHTML =
        '<div class="credential" role="status"><span>' + esc(what) + " <b>" + esc(username) + "</b> · 임시 비밀번호 <code>" + esc(temp) + "</code></span>" +
        '<span class="hint">이 화면을 벗어나면 다시 볼 수 없습니다. 본인에게 전달하세요. 첫 로그인에서 새 비밀번호로 바꾸게 됩니다.</span>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-copy="' + esc(temp) + '">복사</button></div>';
      $("#admin-credential").scrollIntoView({ block: "center" });
    }
    $("#admin-credential").addEventListener("click", (e) => {
      const b = e.target.closest("[data-copy]");
      if (!b) return;
      navigator.clipboard.writeText(b.getAttribute("data-copy")).then(
        () => toast("복사했습니다."),
        () => toast("복사하지 못했습니다. 직접 선택해 복사하세요.", true)
      );
    });

    const deptOptions = (cur) => {
      const list = data.departments.slice();
      if (cur && !list.includes(cur)) list.push(cur);
      return list.map((d) => {
        const v = d === "미지정" ? "" : d;
        return '<option value="' + esc(v) + '"' + ((cur || "") === v ? " selected" : "") + ">" + esc(d) + "</option>";
      }).join("");
    };
    const when = (iso) => (iso ? K.isoKst(iso) : "-");
    const STATUS = { active: "사용 중", pending: "승인 대기", disabled: "사용 중지" };

    function renderCreate() {
      const f = $("#create-form").elements;
      f.department.innerHTML = deptOptions("");
      const roles = [["member", "일반"]];
      if (data.me.role === "super") roles.push(["admin", "계정 관리자"]);
      f.role.innerHTML = roles.map((r) => '<option value="' + r[0] + '">' + r[1] + "</option>").join("");
    }

    function renderPending() {
      const list = data.users.filter((u) => u.status === "pending");
      $("#pending-count").textContent = list.length ? "(" + list.length + ")" : "";
      $("#pending-list").innerHTML = list.length
        ? list.map((u) =>
            '<div class="pending-card" data-id="' + u.id + '"><div class="pending-card__who"><b>' + esc(u.displayName) + " · " + esc(u.username) + "</b>" +
            "<small>" + esc(u.department || "본부 미지정") + (u.email ? " · " + esc(u.email) : "") + " · 신청 " + esc(when(u.createdAt)) + "</small></div>" +
            '<div class="pending-card__actions">' +
            (u.canManage ? '<button type="button" class="btn btn--primary btn--sm" data-act="approve">승인</button><button type="button" class="btn btn--ghost btn--sm" data-act="reject">거부</button>' : '<span class="hint">최고 관리자만 처리</span>') +
            "</div></div>"
          ).join("")
        : '<div class="empty-state"><p class="empty-state__text">대기 중인 신청이 없습니다.</p></div>';
    }

    function renderUsers() {
      const list = data.users.filter((u) => u.status !== "pending");
      $("#user-count").textContent = list.length;
      const superUser = data.users.find((u) => u.role === "super");
      if (superUser) {
        $("#admin-super-name").textContent = superUser.displayName + " (" + superUser.username + ")";
        $("#admin-super-name2").textContent = superUser.displayName + " (" + superUser.username + ")";
      }
      $("#user-rows").innerHTML = list.map((u) => {
        const m = u.canManage;
        const isSuper = data.me.role === "super";
        const role = m && isSuper
          ? '<select class="input input--compact" data-field="role"><option value="member"' + (u.role === "member" ? " selected" : "") + '>일반</option><option value="admin"' + (u.role === "admin" ? " selected" : "") + ">계정 관리자</option></select>"
          : '<span class="role-badge">' + esc(u.roleLabel) + "</span>";
        const dept = m
          ? '<div class="dept-form"><select class="input input--compact" data-field="department">' + deptOptions(u.department) + "</select></div>"
          : esc(u.department || "미지정");
        const acts = !m
          ? '<span class="muted">' + (u.id === data.me.id ? "본인 (내 정보에서)" : "변경 불가") + "</span>"
          : '<div class="row-actions">' +
            '<button type="button" class="btn btn--ghost btn--sm" data-act="reset-password">비밀번호 초기화</button>' +
            (u.status === "active"
              ? '<button type="button" class="btn btn--ghost btn--sm" data-act="disable">사용 중지</button>'
              : '<button type="button" class="btn btn--ghost btn--sm" data-act="enable">다시 사용</button>') +
            '<button type="button" class="btn btn--danger btn--sm" data-act="delete">삭제</button></div>';
        return '<tr data-id="' + u.id + '"><td>' + esc(u.username) + "</td><td>" + (m ? '<input class="input input--compact" data-field="displayName" value="' + esc(u.displayName) + '" maxlength="50">' : esc(u.displayName)) +
          "</td><td>" + dept + "</td><td>" + role + '</td><td><span class="status status--' + esc(u.status) + '">' + esc(STATUS[u.status] || u.status) +
          '</span></td><td class="muted">' + esc(when(u.lastLoginAt)) + '</td><td class="actions">' + acts + "</td></tr>";
      }).join("");
    }

    function renderPerms() {
      const keys = Object.keys(data.features);
      const list = data.users.filter((u) => u.status === "active");
      $("#perm-count").textContent = list.length;
      $("#perm-rows").innerHTML = list.map((u) => {
        const all = u.role === "super";
        // 계정 관리자의 업무 기능은 최고 관리자만 바꾼다
        const editable = u.canManage && (data.me.role === "super" || u.role === "member");
        const boxes = keys.map((k) => {
          const on = all || (u.permissions || []).includes(k);
          return '<td class="perm"><label class="perm__box"><input type="checkbox" data-perm="' + k + '"' + (on ? " checked" : "") + (editable && !all ? "" : " disabled") + ' aria-label="' + esc(u.displayName + " " + data.features[k]) + '"></label></td>';
        }).join("");
        return '<tr data-id="' + u.id + '"><td>' + esc(u.displayName) + ' <span class="muted">' + esc(u.username) + "</span>" + (all ? ' <span class="role-badge">전체</span>' : "") + "</td>" + boxes +
          '<td class="actions">' + (editable && !all ? '<button type="button" class="btn btn--primary btn--sm" data-act="save-perms" disabled>저장</button>' : "") + "</td></tr>";
      }).join("");
    }

    async function loadSessions() {
      try {
        const list = await api("GET", "/api/admin/sessions");
        $("#session-count").textContent = "(" + list.length + ")";
        $("#session-list").innerHTML = list.length
          ? '<div class="admin-table-scroll"><table class="admin-table"><thead><tr><th>계정</th><th>기기</th><th>IP</th><th>로그인</th><th></th></tr></thead><tbody>' +
            list.map((x) => '<tr data-sid="' + esc(x.id) + '"><td>' + esc(x.displayName) + ' <span class="muted">' + esc(x.username) + "</span></td><td>" + esc(x.device) + "</td><td class=\"muted\">" + esc(x.ip) +
              '</td><td class="muted">' + esc(when(x.createdAt)) + '</td><td class="actions">' + (x.current ? '<span class="muted">지금 이 기기</span>' : '<button type="button" class="btn btn--ghost btn--sm" data-act="end-session">종료</button>') + "</td></tr>").join("") +
            "</tbody></table></div>"
          : '<div class="empty-state"><p class="empty-state__text">접속 중인 세션이 없습니다.</p></div>';
      } catch (err) {
        $("#session-list").innerHTML = '<p class="hint">' + esc(err.message) + "</p>";
      }
    }

    function renderDepts() {
      $("#dept-section").hidden = data.me.role !== "super";
      $("#dept-form").elements.departments.value = data.departments.join("\n");
    }

    async function load() {
      data = await api("GET", "/api/admin/users");
      renderCreate();
      renderPending();
      renderUsers();
      renderPerms();
      renderDepts();
      loadSessions();
    }

    $("#create-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const username = f.username.value.trim().toLowerCase();
      if (!/^[a-z0-9._@-]{2,60}$/.test(username)) return toast("아이디는 영문 소문자·숫자·점·밑줄·하이픈·@ 2자 이상입니다.", true);
      if (!f.display_name.value.trim()) return toast("이름을 입력해 주세요.", true);
      try {
        const out = await api("POST", "/api/admin/users", {
          username, displayName: f.display_name.value.trim(), department: f.department.value, email: f.email.value.trim(), role: f.role.value,
        });
        e.target.reset();
        await load();
        showCredential(out.username, out.tempPassword, "계정을 만들었습니다:");
      } catch (err) {
        toast(err.message, true);
      }
    });

    root.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const act = b.getAttribute("data-act");
      if (act === "end-session") {
        const sid = b.closest("[data-sid]").getAttribute("data-sid");
        try {
          await api("DELETE", "/api/admin/sessions/" + sid);
          toast("세션을 종료했습니다.");
          loadSessions();
        } catch (err) {
          toast(err.message, true);
        }
        return;
      }
      const row = b.closest("[data-id]");
      if (!row) return;
      const id = Number(row.getAttribute("data-id"));
      const u = data.users.find((x) => x.id === id);
      if (!u) return;
      try {
        if (act === "save-perms") {
          const permsOn = Array.from(row.querySelectorAll("[data-perm]")).filter((c) => c.checked).map((c) => c.getAttribute("data-perm"));
          await api("PUT", "/api/admin/users/" + id, { permissions: permsOn });
          toast(u.displayName + " 권한을 저장했습니다.");
          await load();
          return;
        }
        if (act === "delete" && !(await K.confirm(u.displayName + " (" + u.username + ") 계정을 삭제할까요?\n남긴 노트와 자료는 그대로 남습니다.", "삭제", true))) return;
        if (act === "disable" && !(await K.confirm(u.displayName + " 계정을 사용 중지할까요? 바로 로그아웃됩니다.", "사용 중지", true))) return;
        if (act === "reject" && !(await K.confirm(u.displayName + " 가입 신청을 거부할까요?", "거부", true))) return;
        if (act === "reset-password" && !(await K.confirm(u.displayName + " 비밀번호를 임시 비밀번호로 바꿀까요? 지금 로그인은 끊깁니다.", "초기화"))) return;
        const out = await api("POST", "/api/admin/users/" + id + "/" + act);
        await load();
        if (out && out.tempPassword) showCredential(u.username, out.tempPassword, "비밀번호를 초기화했습니다:");
        else toast({ approve: "승인했습니다.", reject: "거부했습니다.", disable: "사용 중지했습니다.", enable: "다시 쓸 수 있게 했습니다.", delete: "삭제했습니다." }[act] || "처리했습니다.");
      } catch (err) {
        toast(err.message, true);
      }
    });

    // 표 안의 값(이름·본부·등급)은 바꾸면 바로 저장
    root.addEventListener("change", async (e) => {
      const el = e.target;
      if (el.matches("[data-perm]")) {
        const btn = el.closest("tr").querySelector('[data-act="save-perms"]');
        if (btn) btn.disabled = false;
        return;
      }
      const field = el.getAttribute("data-field");
      if (!field) return;
      const id = Number(el.closest("[data-id]").getAttribute("data-id"));
      const value = el.value.trim();
      if (field === "displayName" && !value) return toast("이름을 비울 수 없습니다.", true);
      try {
        await api("PUT", "/api/admin/users/" + id, { [field]: value });
        toast("저장했습니다.");
        await load();
      } catch (err) {
        toast(err.message, true);
        await load();
      }
    });

    $("#dept-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const items = e.target.elements.departments.value.split("\n").map((x) => x.trim()).filter(Boolean);
      try {
        const out = await api("PUT", "/api/admin/departments", { departments: items });
        data.departments = out.departments;
        renderCreate();
        renderUsers();
        toast("본부 목록을 저장했습니다.");
      } catch (err) {
        toast(err.message, true);
      }
    });

    load().catch((err) => toast(err.message, true));
  });
})();
