"""업무공간 서버.

- 로그인·회원가입(관리자 승인)·등급(최고 관리자/계정 관리자/일반)·본부·탭 권한
- 노트, 페이지별 데이터 모음(/api/c/*), 파일(조각 저장·Range 재생), 저장한 답변
- 계정 관리 API, Google 캘린더 구독(ICS) 주소
- 화면(.html)은 로그인한 사람에게만, CSS·JS 는 누구에게나

실행(내 PC·AWS):  uvicorn server.app:app --host 127.0.0.1 --port 8000 --proxy-headers
Vercel:           api/index.py 가 이 app 을 불러 쓴다 (DATABASE_URL 필요)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response

from .db import IS_PG, ROOT, STATIC_ONLY, IntegrityError, blob_bytes, connect, init_db

COOKIE_NAME = "hana_session"
SESSION_DAYS = int(os.environ.get("HANA_SESSION_DAYS", "30"))
MAX_UPLOAD_BYTES = int(os.environ.get("HANA_MAX_UPLOAD_MB", "500")) * 1024 * 1024
CHUNK_BYTES = 3 * 1024 * 1024  # Vercel 요청·응답 4.5MB 제한보다 작게
CATEGORIES = {"single", "group", "seminar", "report", "etc"}
KST = timezone(timedelta(hours=9))

# 탭·기능 권한 (계정 관리 화면의 체크박스)
FEATURES = {
    "portfolio": "포트폴리오 분석",
    "ai_research": "AI 리서치",
    "workload": "워크로드",
    "report": "개발자 탭",
    "changelog": "변경사항 추가",
    "requests": "개선요청 처리",
    "note_stats": "노트 통계",
}
# 권한이 있어야 열리는 화면
PAGE_FEATURES = {"portfolio": "portfolio", "research": "ai_research", "workload": "workload", "stats": "note_stats"}
ROLE_LABEL = {"super": "최고 관리자", "admin": "계정 관리자", "member": "일반"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 비밀번호 · 세션
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    n, r, p = 2**14, 8, 1
    digest = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=32)
    return f"scrypt${n}${r}${p}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_hex, digest_hex = stored.split("$")
        if algo != "scrypt":
            return False
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p), dklen=len(digest_hex) // 2)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def temp_password() -> str:
    return secrets.token_urlsafe(9)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(conn, user_id: int, request: Optional[Request] = None) -> str:
    token = secrets.token_urlsafe(32)
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
    ip = _client_ip(request) if request is not None else ""
    ua = (request.headers.get("user-agent", "") if request is not None else "")[:300]
    conn.execute("INSERT INTO sessions(token_hash, user_id, expires_at, created_at, ip, ua, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 (_token_hash(token), user_id, int(time.time()) + SESSION_DAYS * 86400, now_iso(), ip, ua, now_iso()))
    return token


def session_user(request: Request):
    if STATIC_ONLY:
        return None
    cached = getattr(request.state, "user", "unset")
    if cached != "unset":
        return cached
    token = request.cookies.get(COOKIE_NAME)
    user = None
    if token:
        with connect() as conn:
            user = conn.one(
                "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'",
                (_token_hash(token), int(time.time())),
            )
    request.state.user = user
    return user


def require_user(request: Request):
    user = session_user(request)
    if user is None:
        raise HTTPException(401, "로그인이 필요합니다.")
    return user


def perms(user) -> list[str]:
    try:
        v = json.loads(user["permissions"] or "[]")
        return [x for x in v if x in FEATURES]
    except (ValueError, TypeError, KeyError):
        return []


def has_feature(user, feature: str) -> bool:
    return user["role"] == "super" or feature in perms(user)


def is_admin(user) -> bool:
    return user["role"] in ("super", "admin")


def require_admin(request: Request):
    user = require_user(request)
    if not is_admin(user):
        raise HTTPException(403, "계정 관리자만 할 수 있습니다.")
    return user


def me_dict(user) -> dict[str, Any]:
    return {
        "id": user["id"],
        "username": user["username"],
        "displayName": user["display_name"],
        "role": user["role"],
        "roleLabel": ROLE_LABEL.get(user["role"], "일반"),
        "department": user["department"] or "",
        "email": user["email"] or "",
        "permissions": list(FEATURES) if user["role"] == "super" else perms(user),
        "mustChange": bool(user["must_change"]),
        "lastLoginAt": user["last_login_at"],
    }


# 로그인 실패가 반복되면 잠시 막는다 (IP+아이디 기준, 10분에 5번)
_FAILS: dict[str, list[float]] = {}
_FAILS_LOCK = threading.Lock()


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "?")


def _too_many(key: str) -> bool:
    with _FAILS_LOCK:
        recent = [t for t in _FAILS.get(key, []) if t > time.time() - 600]
        _FAILS[key] = recent
        return len(recent) >= 5


def _fail(key: str) -> None:
    with _FAILS_LOCK:
        _FAILS.setdefault(key, []).append(time.time())


def settings_get(conn, key: str, default: Any) -> Any:
    row = conn.one("SELECT value FROM settings WHERE key = ?", (key,))
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except ValueError:
        return default


def settings_set(conn, key: str, value: Any) -> None:
    raw = json.dumps(value, ensure_ascii=False)
    if conn.one("SELECT 1 FROM settings WHERE key = ?", (key,)):
        conn.execute("UPDATE settings SET value = ? WHERE key = ?", (raw, key))
    else:
        conn.execute("INSERT INTO settings(key, value) VALUES (?, ?)", (key, raw))


DEFAULT_DEPARTMENTS = ["미지정", "주식운용본부", "채권운용본부", "대체투자본부", "리서치본부", "마케팅본부", "리스크관리본부", "경영지원본부"]


# ---------------------------------------------------------------------------
# 앱
# ---------------------------------------------------------------------------

app = FastAPI(title="업무공간", docs_url=None, redoc_url=None, openapi_url=None)
init_db()

# 비밀번호를 바꾸기 전에도 쓸 수 있는 API
_MUST_CHANGE_OK = {"/api/me", "/api/password", "/api/logout", "/api/profile"}


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and not path.startswith("/api/health"):
        if STATIC_ONLY:
            return JSONResponse({"detail": "데이터베이스가 연결되지 않아 서버 기능을 쓸 수 없습니다."}, status_code=503)
        # 다른 사이트에서 보낸 폼·스크립트 요청(CSRF)을 막기 위해 전용 헤더를 요구한다
        # 텔레그램 웹훅은 텔레그램 서버가 부르므로 전용 헤더 대신 비밀 토큰으로 확인한다
        if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-hana") != "1" and path != "/api/telegram/webhook":
            return JSONResponse({"detail": "잘못된 요청입니다."}, status_code=403)
        user = session_user(request)
        if user is not None and user["must_change"] and path not in _MUST_CHANGE_OK:
            return JSONResponse({"detail": "첫 로그인입니다. 비밀번호를 먼저 바꿔 주세요.", "code": "must_change"}, status_code=403)
    response: Response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    if path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


def _is_https(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "") == "https"


def _set_session_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax", secure=_is_https(request), path="/")


def _safe_next(value: Optional[str]) -> str:
    # 로그인 뒤 이동할 주소는 이 사이트 안쪽 경로만 허용
    if value and value.startswith("/") and not value.startswith("//") and "\\" not in value:
        return value
    return "/"


async def _json(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "잘못된 요청입니다.")
    if not isinstance(data, dict):
        raise HTTPException(400, "잘못된 요청입니다.")
    return data


# --- 로그인 · 가입 · 내 정보 -----------------------------------------------------

USERNAME_RE = re.compile(r"[a-z0-9._@-]{2,60}")


def _clean_username(value: Any) -> str:
    return str(value or "").strip().lower()


@app.post("/api/login")
async def api_login(request: Request) -> Response:
    data = await _json(request)
    username = _clean_username(data.get("username"))
    password = str(data.get("password") or "")
    key = _client_ip(request) + "|" + username
    if _too_many(key):
        raise HTTPException(429, "로그인 실패가 반복되어 10분 동안 막혔습니다. 잠시 후 다시 시도해 주세요.")
    with connect() as conn:
        user = conn.one("SELECT * FROM users WHERE username = ?", (username,))
        if user is None or not verify_password(password, user["password_hash"]):
            _fail(key)
            raise HTTPException(401, "아이디 또는 비밀번호가 맞지 않습니다.")
        if user["status"] == "pending":
            raise HTTPException(403, "가입 승인을 기다리고 있습니다. 계정 관리자에게 승인을 요청하세요.")
        if user["status"] != "active":
            raise HTTPException(403, "사용이 중지된 계정입니다. 계정 관리자에게 문의하세요.")
        token = create_session(conn, user["id"], request)
        conn.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now_iso(), user["id"]))
    nxt = "/account/?first=1" if user["must_change"] else _safe_next(data.get("next"))
    response = JSONResponse({"ok": True, "next": nxt})
    _set_session_cookie(request, response, token)
    return response


@app.post("/api/logout")
def api_logout(request: Request) -> Response:
    token = request.cookies.get(COOKIE_NAME)
    if token:
        with connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE_NAME, path="/")
    return response


@app.get("/api/signup-info")
def api_signup_info() -> dict[str, Any]:
    with connect() as conn:
        first = conn.one("SELECT 1 FROM users LIMIT 1") is None
        depts = settings_get(conn, "departments", DEFAULT_DEPARTMENTS)
    return {"firstUser": first, "needsCode": first and bool(os.environ.get("HANA_SETUP_CODE", "").strip()), "departments": depts}


@app.post("/api/signup", status_code=201)
async def api_signup(request: Request) -> dict[str, Any]:
    data = await _json(request)
    username = _clean_username(data.get("username"))
    name = str(data.get("displayName") or "").strip()[:50]
    email = str(data.get("email") or "").strip()[:200]
    dept = str(data.get("department") or "").strip()[:50]
    password = str(data.get("password") or "")
    if not USERNAME_RE.fullmatch(username):
        raise HTTPException(400, "아이디는 영문 소문자·숫자·점(.)·밑줄(_)·하이픈(-)·@ 2~60자로 정해 주세요.")
    if not name:
        raise HTTPException(400, "이름을 입력해 주세요.")
    if len(password) < 8:
        raise HTTPException(400, "비밀번호는 8자 이상이어야 합니다.")
    if _too_many(_client_ip(request) + "|signup"):
        raise HTTPException(429, "가입 신청이 너무 많습니다. 잠시 후 다시 시도해 주세요.")
    with connect() as conn:
        first = conn.one("SELECT 1 FROM users LIMIT 1") is None
        # 첫 가입자는 최고 관리자가 된다. HANA_SETUP_CODE 를 정해 두면 그 코드를 아는 사람만 첫 가입 가능
        setup_code = os.environ.get("HANA_SETUP_CODE", "").strip()
        if first and setup_code and not hmac.compare_digest(str(data.get("setupCode") or "").strip(), setup_code):
            _fail(_client_ip(request) + "|signup")
            raise HTTPException(403, "처음 설정 코드가 맞지 않습니다.")
        role, status = ("super", "active") if first else ("member", "pending")
        try:
            conn.execute(
                "INSERT INTO users(username, display_name, role, password_hash, created_at, email, department, status, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (username, name, role, hash_password(password), now_iso(), email, dept, status, "[]"),
            )
        except IntegrityError:
            raise HTTPException(409, "이미 쓰고 있는 아이디입니다.")
    _fail(_client_ip(request) + "|signup")  # 가입 신청 횟수도 같은 제한으로 센다
    return {"ok": True, "first": first, "status": status}


@app.get("/api/me")
def api_me(request: Request) -> dict[str, Any]:
    user = require_user(request)
    out = me_dict(user)
    with connect() as conn:
        out["departments"] = settings_get(conn, "departments", DEFAULT_DEPARTMENTS)
    out["features"] = FEATURES
    return out


@app.post("/api/password")
async def api_password(request: Request) -> dict[str, Any]:
    user = require_user(request)
    data = await _json(request)
    current, new = str(data.get("current") or ""), str(data.get("new") or "")
    if not verify_password(current, user["password_hash"]):
        raise HTTPException(400, "현재 비밀번호가 맞지 않습니다.")
    if len(new) < 8:
        raise HTTPException(400, "새 비밀번호는 8자 이상이어야 합니다.")
    if new == current:
        raise HTTPException(400, "지금과 다른 비밀번호를 써 주세요.")
    with connect() as conn:
        conn.execute("UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?", (hash_password(new), user["id"]))
        token = request.cookies.get(COOKIE_NAME) or ""
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user["id"], _token_hash(token)))
    return {"ok": True}


@app.put("/api/profile")
async def api_profile(request: Request) -> dict[str, Any]:
    user = require_user(request)
    data = await _json(request)
    name = str(data.get("displayName") or "").strip()[:50]
    email = str(data.get("email") or "").strip()[:200]
    dept = str(data.get("department") if "department" in data else user["department"] or "").strip()[:50]
    if not name:
        raise HTTPException(400, "이름을 입력해 주세요.")
    with connect() as conn:
        conn.execute("UPDATE users SET display_name = ?, email = ?, department = ? WHERE id = ?", (name, email, dept, user["id"]))
        row = conn.one("SELECT * FROM users WHERE id = ?", (user["id"],))
    return me_dict(row)


@app.post("/api/logout-all")
def api_logout_all(request: Request) -> dict[str, Any]:
    user = require_user(request)
    token = request.cookies.get(COOKIE_NAME) or ""
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user["id"], _token_hash(token)))
    return {"ok": True}


# --- 계정 관리 ------------------------------------------------------------------

def _user_row(conn, user_id: int):
    row = conn.one("SELECT * FROM users WHERE id = ?", (user_id,))
    if row is None:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    return row


def _can_manage(me, target) -> bool:
    """최고 관리자는 본인을 뺀 모두, 계정 관리자는 일반 사용자만 관리한다."""
    if target["id"] == me["id"] or target["role"] == "super":
        return False
    if me["role"] == "super":
        return True
    return me["role"] == "admin" and target["role"] == "member"


def _admin_user(row) -> dict[str, Any]:
    return {
        "id": row["id"], "username": row["username"], "displayName": row["display_name"], "role": row["role"],
        "roleLabel": ROLE_LABEL.get(row["role"], "일반"), "status": row["status"], "department": row["department"] or "",
        "email": row["email"] or "", "permissions": perms(row), "lastLoginAt": row["last_login_at"], "createdAt": row["created_at"],
    }


@app.get("/api/admin/users")
def api_admin_users(request: Request) -> dict[str, Any]:
    me = require_admin(request)
    with connect() as conn:
        rows = conn.all("SELECT * FROM users ORDER BY CASE role WHEN 'super' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, username")
        depts = settings_get(conn, "departments", DEFAULT_DEPARTMENTS)
    users = []
    for r in rows:
        u = _admin_user(r)
        u["canManage"] = _can_manage(me, r)
        users.append(u)
    return {"me": me_dict(me), "users": users, "features": FEATURES, "departments": depts, "roles": ROLE_LABEL}


@app.post("/api/admin/users", status_code=201)
async def api_admin_create(request: Request) -> dict[str, Any]:
    me = require_admin(request)
    data = await _json(request)
    username = _clean_username(data.get("username"))
    name = str(data.get("displayName") or "").strip()[:50] or username
    role = data.get("role") if data.get("role") in ("admin", "member") else "member"
    if role == "admin" and me["role"] != "super":
        raise HTTPException(403, "계정 관리자 등급은 최고 관리자만 지정할 수 있습니다.")
    if not USERNAME_RE.fullmatch(username):
        raise HTTPException(400, "아이디는 영문 소문자·숫자·점(.)·밑줄(_)·하이픈(-)·@ 2~60자로 정해 주세요.")
    temp = temp_password()
    with connect() as conn:
        try:
            conn.execute(
                "INSERT INTO users(username, display_name, role, password_hash, created_at, email, department, status, permissions, must_change) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 1)",
                (username, name, role, hash_password(temp), now_iso(), str(data.get("email") or "")[:200], str(data.get("department") or "")[:50],
                 json.dumps([p for p in data.get("permissions", []) if p in FEATURES])),
            )
        except IntegrityError:
            raise HTTPException(409, "이미 있는 아이디입니다.")
    return {"ok": True, "username": username, "tempPassword": temp}


@app.post("/api/admin/users/{user_id}/{action}")
async def api_admin_action(user_id: int, action: str, request: Request) -> dict[str, Any]:
    me = require_admin(request)
    with connect() as conn:
        target = _user_row(conn, user_id)
        if not _can_manage(me, target):
            raise HTTPException(403, "이 계정은 바꿀 수 없습니다. (본인·최고 관리자·다른 관리자는 최고 관리자만 관리합니다)")
        if action == "approve":
            conn.execute("UPDATE users SET status = 'active' WHERE id = ?", (user_id,))
        elif action in ("reject", "disable"):
            conn.execute("UPDATE users SET status = 'disabled' WHERE id = ?", (user_id,))
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        elif action == "enable":
            conn.execute("UPDATE users SET status = 'active' WHERE id = ?", (user_id,))
        elif action == "reset-password":
            temp = temp_password()
            conn.execute("UPDATE users SET password_hash = ?, must_change = 1 WHERE id = ?", (hash_password(temp), user_id))
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            return {"ok": True, "tempPassword": temp}
        elif action == "delete":
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        else:
            raise HTTPException(404, "알 수 없는 작업입니다.")
    return {"ok": True}


@app.put("/api/admin/users/{user_id}")
async def api_admin_update(user_id: int, request: Request) -> dict[str, Any]:
    me = require_admin(request)
    data = await _json(request)
    with connect() as conn:
        target = _user_row(conn, user_id)
        if not _can_manage(me, target):
            raise HTTPException(403, "이 계정은 바꿀 수 없습니다.")
        if "department" in data:
            conn.execute("UPDATE users SET department = ? WHERE id = ?", (str(data["department"] or "")[:50], user_id))
        if "displayName" in data and str(data["displayName"]).strip():
            conn.execute("UPDATE users SET display_name = ? WHERE id = ?", (str(data["displayName"]).strip()[:50], user_id))
        if "permissions" in data and isinstance(data["permissions"], list):
            conn.execute("UPDATE users SET permissions = ? WHERE id = ?", (json.dumps([p for p in data["permissions"] if p in FEATURES]), user_id))
        if "role" in data:
            if me["role"] != "super":
                raise HTTPException(403, "등급은 최고 관리자만 바꿀 수 있습니다.")
            if data["role"] not in ("admin", "member"):
                raise HTTPException(400, "등급 값이 올바르지 않습니다.")
            conn.execute("UPDATE users SET role = ? WHERE id = ?", (data["role"], user_id))
        row = _user_row(conn, user_id)
    u = _admin_user(row)
    u["canManage"] = _can_manage(me, row)
    return u


def _device(ua: str) -> str:
    ua = ua or ""
    os_ = "Windows" if "Windows" in ua else "Mac" if "Mac OS" in ua and "Mobile" not in ua else "iPhone" if "iPhone" in ua else "Android" if "Android" in ua else "기타"
    br = "Edge" if "Edg/" in ua else "Chrome" if "Chrome/" in ua else "Safari" if "Safari/" in ua else "Firefox" if "Firefox/" in ua else "브라우저"
    return f"{os_} · {br}"


@app.get("/api/admin/sessions")
def api_admin_sessions(request: Request) -> list[dict[str, Any]]:
    me = require_admin(request)
    mine = _token_hash(request.cookies.get(COOKIE_NAME) or "")
    with connect() as conn:
        rows = conn.all(
            "SELECT s.token_hash, s.created_at, s.ip, s.ua, s.expires_at, u.id AS uid, u.username, u.display_name, u.role FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.expires_at > ? ORDER BY s.created_at DESC", (int(time.time()),))
    out = []
    for r in rows:
        if me["role"] != "super" and r["role"] != "member" and r["uid"] != me["id"]:
            continue
        out.append({"id": r["token_hash"][:24], "userId": r["uid"], "username": r["username"], "displayName": r["display_name"],
                    "createdAt": r["created_at"], "ip": r["ip"] or "", "device": _device(r["ua"] or ""), "current": r["token_hash"] == mine})
    return out


@app.delete("/api/admin/sessions/{sid}")
def api_admin_session_end(sid: str, request: Request) -> dict[str, Any]:
    me = require_admin(request)
    if not re.fullmatch(r"[0-9a-f]{24}", sid):
        raise HTTPException(404, "세션을 찾을 수 없습니다.")
    with connect() as conn:
        row = conn.one("SELECT s.token_hash, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash LIKE ?", (sid + "%",))
        if row is None:
            raise HTTPException(404, "세션을 찾을 수 없습니다.")
        if row["id"] != me["id"] and not _can_manage(me, row):
            raise HTTPException(403, "이 세션은 종료할 수 없습니다.")
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (row["token_hash"],))
    return {"ok": True}


@app.put("/api/admin/departments")
async def api_admin_departments(request: Request) -> dict[str, Any]:
    me = require_admin(request)
    if me["role"] != "super":
        raise HTTPException(403, "본부 목록은 최고 관리자만 바꿀 수 있습니다.")
    data = await _json(request)
    items = [str(x).strip()[:50] for x in data.get("departments", []) if str(x).strip()]
    if not items:
        raise HTTPException(400, "본부를 하나 이상 넣어 주세요.")
    with connect() as conn:
        settings_set(conn, "departments", list(dict.fromkeys(items)))
    return {"ok": True, "departments": list(dict.fromkeys(items))}


@app.get("/api/users/names")
def api_user_names(request: Request) -> list[dict[str, Any]]:
    """담당자 고르기 등에 쓰는 사용 중인 사람 이름 목록"""
    require_user(request)
    with connect() as conn:
        rows = conn.all("SELECT id, username, display_name, department FROM users WHERE status = 'active' ORDER BY display_name")
    return [{"id": r["id"], "username": r["username"], "displayName": r["display_name"], "department": r["department"] or ""} for r in rows]


# --- 노트 ------------------------------------------------------------------------

def file_meta(row) -> dict[str, Any]:
    return {"id": row["id"], "name": row["name"], "size": row["size"], "type": row["mime"], "duration": row["duration"]}


def note_dict(row, files: list) -> dict[str, Any]:
    audio = next((f for f in files if f["kind"] == "audio"), None)
    return {
        "id": row["id"], "company": row["company"], "ticker": row["ticker"], "category": row["category"], "type": row["type"],
        "author": row["author"], "date": row["date"], "title": row["title"], "body": row["body"], "link": row["link"],
        "review": {"reason": row["review_reason"]} if row["review_reason"] else None,
        "files": [file_meta(f) for f in files if f["kind"] == "attach"], "audio": file_meta(audio) if audio else None,
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def _text(data: dict[str, Any], key: str, max_len: int, required: bool = False) -> str:
    value = data.get(key, "")
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise HTTPException(400, f"{key} 값이 올바르지 않습니다.")
    value = value if key == "body" else value.strip()
    if required and not value.strip():
        raise HTTPException(400, f"{key} 값을 입력해 주세요.")
    if len(value) > max_len:
        raise HTTPException(400, f"{key} 값이 너무 깁니다.")
    return value


def clean_note(data: Any) -> dict[str, Any]:
    out = {
        "company": _text(data, "company", 100, True), "ticker": _text(data, "ticker", 6), "category": _text(data, "category", 20, True),
        "type": _text(data, "type", 40), "author": _text(data, "author", 60), "date": _text(data, "date", 10, True),
        "title": _text(data, "title", 200, True), "body": _text(data, "body", 500_000), "link": _text(data, "link", 2000),
    }
    if out["category"] not in CATEGORIES:
        raise HTTPException(400, "분류 값이 올바르지 않습니다.")
    if out["ticker"] and not re.fullmatch(r"[0-9A-Z]{6}", out["ticker"]):
        raise HTTPException(400, "종목코드는 6자리입니다.")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", out["date"]):
        raise HTTPException(400, "날짜 형식이 올바르지 않습니다.")
    if out["link"] and not re.match(r"https?://", out["link"], re.I):
        raise HTTPException(400, "링크는 http:// 또는 https:// 로 시작해야 합니다.")
    review = data.get("review")
    out["review_reason"] = str(review.get("reason") or "확인 필요")[:200] if isinstance(review, dict) else None
    return out


def _note_row(conn, note_id: int):
    row = conn.one("SELECT * FROM notes WHERE id = ?", (note_id,))
    if row is None:
        raise HTTPException(404, "노트를 찾을 수 없습니다.")
    return row


def _note_out(conn, note_id: int) -> dict[str, Any]:
    return note_dict(_note_row(conn, note_id), conn.all("SELECT * FROM files WHERE note_id = ? ORDER BY created_at", (note_id,)))


@app.get("/api/notes")
def api_notes(request: Request) -> list[dict[str, Any]]:
    require_user(request)
    with connect() as conn:
        rows = conn.all("SELECT * FROM notes ORDER BY date DESC, id DESC")
        files: dict[int, list] = {}
        for f in conn.all("SELECT * FROM files ORDER BY created_at"):
            files.setdefault(f["note_id"], []).append(f)
    return [note_dict(r, files.get(r["id"], [])) for r in rows]


@app.post("/api/notes", status_code=201)
async def api_note_create(request: Request) -> dict[str, Any]:
    user = require_user(request)
    data = clean_note(await _json(request))
    data["author"] = data["author"] or user["display_name"]
    with connect() as conn:
        row = conn.one(
            "INSERT INTO notes(company, ticker, category, type, author, date, title, body, link, review_reason, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
            (data["company"], data["ticker"], data["category"], data["type"], data["author"], data["date"], data["title"], data["body"], data["link"], data["review_reason"], user["id"], now_iso()),
        )
        return _note_out(conn, row["id"])


@app.put("/api/notes/{note_id}")
async def api_note_update(note_id: int, request: Request) -> dict[str, Any]:
    require_user(request)
    data = clean_note(await _json(request))
    with connect() as conn:
        _note_row(conn, note_id)
        conn.execute(
            "UPDATE notes SET company=?, ticker=?, category=?, type=?, author=?, date=?, title=?, body=?, link=?, review_reason=?, updated_at=? WHERE id=?",
            (data["company"], data["ticker"], data["category"], data["type"], data["author"], data["date"], data["title"], data["body"], data["link"], data["review_reason"], now_iso(), note_id),
        )
        return _note_out(conn, note_id)


@app.delete("/api/notes/{note_id}")
def api_note_delete(note_id: int, request: Request) -> dict[str, Any]:
    user = require_user(request)
    with connect() as conn:
        row = _note_row(conn, note_id)
        if not is_admin(user) and row["created_by"] not in (None, user["id"]):
            raise HTTPException(403, "노트는 등록한 사람이나 관리자만 삭제할 수 있습니다.")
        ids = [f["id"] for f in conn.all("SELECT id FROM files WHERE note_id = ?", (note_id,))]
        conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
        for fid in ids:
            conn.execute("DELETE FROM blobs WHERE id = ?", (fid,))
    return {"ok": True}


@app.post("/api/notes/{note_id}/files", status_code=201)
async def api_note_attach(note_id: int, request: Request) -> dict[str, Any]:
    """이미 올린 파일(blob)을 노트에 붙인다. kind=audio 면 기존 녹음을 바꾼다."""
    require_user(request)
    data = await _json(request)
    blob_id = str(data.get("blobId") or "")
    kind = data.get("kind") if data.get("kind") in ("attach", "audio") else "attach"
    with connect() as conn:
        _note_row(conn, note_id)
        blob = conn.one("SELECT * FROM blobs WHERE id = ? AND complete = 1", (blob_id,))
        if blob is None:
            raise HTTPException(404, "올린 파일을 찾을 수 없습니다.")
        if kind == "audio":
            for old in conn.all("SELECT id FROM files WHERE note_id = ? AND kind = 'audio'", (note_id,)):
                conn.execute("DELETE FROM files WHERE id = ?", (old["id"],))
                conn.execute("DELETE FROM blobs WHERE id = ?", (old["id"],))
        conn.execute(
            "INSERT INTO files(id, note_id, kind, name, size, mime, duration, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (blob_id, note_id, kind, blob["name"], blob["size"], blob["mime"], max(0, int(data.get("duration") or 0)), now_iso()),
        )
        return file_meta(conn.one("SELECT * FROM files WHERE id = ?", (blob_id,)))


@app.delete("/api/files/{file_id}")
def api_file_delete(file_id: str, request: Request) -> dict[str, Any]:
    require_user(request)
    with connect() as conn:
        conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
        conn.execute("DELETE FROM blobs WHERE id = ?", (file_id,))
    return {"ok": True}


@app.get("/api/files/{file_id}")
def api_file_get(file_id: str, request: Request, download: int = 0) -> Response:
    return api_blob_get(file_id, request, download)


# --- 저장한 답변 -------------------------------------------------------------------

@app.get("/api/saved")
def api_saved(request: Request) -> list[dict[str, Any]]:
    user = require_user(request)
    with connect() as conn:
        rows = conn.all("SELECT * FROM saved_answers WHERE user_id = ? ORDER BY saved_at DESC", (user["id"],))
    return [{"id": r["id"], "question": r["question"], "answerHtml": r["answer_html"], "notes": json.loads(r["notes_json"]), "savedAt": r["saved_at"]} for r in rows]


@app.post("/api/saved", status_code=201)
async def api_saved_add(request: Request) -> dict[str, Any]:
    user = require_user(request)
    data = await _json(request)
    question = str(data.get("question") or "").strip()[:1000]
    if not question:
        raise HTTPException(400, "질문이 비어 있습니다.")
    notes = [{"id": n.get("id"), "label": str(n.get("label", ""))[:300]} for n in (data.get("notes") or [])[:50] if isinstance(n, dict)]
    item = {"id": secrets.token_hex(8), "question": question, "answerHtml": str(data.get("answerHtml") or "")[:200_000], "notes": notes, "savedAt": now_iso()}
    with connect() as conn:
        conn.execute("INSERT INTO saved_answers(id, user_id, question, answer_html, notes_json, saved_at) VALUES (?,?,?,?,?,?)",
                     (item["id"], user["id"], question, item["answerHtml"], json.dumps(notes, ensure_ascii=False), item["savedAt"]))
    return item


@app.delete("/api/saved/{item_id}")
def api_saved_delete(item_id: str, request: Request) -> dict[str, Any]:
    user = require_user(request)
    with connect() as conn:
        conn.execute("DELETE FROM saved_answers WHERE id = ? AND user_id = ?", (item_id, user["id"]))
    return {"ok": True}


# --- 페이지별 데이터 모음 ------------------------------------------------------------
# 모음 이름이 my- 로 시작하면 사용자마다 따로 저장한다 (예: AI 리서치 대화).

MAX_RECORD_BYTES = 2_000_000
# 쓰기에 권한이 필요한 모음: 이름 → (권한, 설명)
WRITE_RULES = {
    "changelog": ("changelog", "변경사항 추가 권한이 있어야 합니다."),
    "morning-decks": ("admin", "아침회의 자료는 관리자만 올릴 수 있습니다."),
    "portfolio": ("portfolio", "포트폴리오 분석 권한이 있어야 합니다."),
    "workload": ("workload", "워크로드 권한이 있어야 합니다."),
}
READ_RULES = {"portfolio": "portfolio", "workload": "workload"}


def _collection_key(name: str, user) -> str:
    if not re.fullmatch(r"(my-)?[a-z0-9][a-z0-9_-]{0,39}", name):
        raise HTTPException(404, "알 수 없는 모음입니다.")
    if name in READ_RULES and not has_feature(user, READ_RULES[name]):
        raise HTTPException(403, "이 기능을 쓸 권한이 없습니다.")
    return f"{name}:{user['id']}" if name.startswith("my-") else name


def _check_write(name: str, user) -> None:
    rule = WRITE_RULES.get(name)
    if not rule:
        return
    need, msg = rule
    ok = is_admin(user) if need == "admin" else has_feature(user, need)
    if not ok:
        raise HTTPException(403, msg)


async def _record_body(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if len(raw) > MAX_RECORD_BYTES:
        raise HTTPException(413, "한 번에 저장할 수 있는 크기를 넘었습니다.")
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(400, "잘못된 요청입니다.")
    if not isinstance(data, dict):
        raise HTTPException(400, "잘못된 요청입니다.")
    return data


def _record_out(row) -> dict[str, Any]:
    data = json.loads(row["data"])
    data["id"] = row["id"]
    return data


@app.get("/api/c/{name}")
def api_records(name: str, request: Request) -> list[dict[str, Any]]:
    user = require_user(request)
    key = _collection_key(name, user)
    with connect() as conn:
        rows = conn.all("SELECT * FROM records WHERE collection = ? ORDER BY created_at, id", (key,))
    return [_record_out(r) for r in rows]


@app.post("/api/c/{name}", status_code=201)
async def api_record_create(name: str, request: Request) -> dict[str, Any]:
    user = require_user(request)
    key = _collection_key(name, user)
    _check_write(name, user)
    data = await _record_body(request)
    rid = str(data.get("id") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", rid):
        rid = secrets.token_hex(8)
    data["id"] = rid
    data["createdBy"] = user["display_name"]
    data["createdById"] = user["id"]
    data.setdefault("createdAt", now_iso())
    with connect() as conn:
        try:
            conn.execute("INSERT INTO records(collection, id, data, created_by, created_at) VALUES (?,?,?,?,?)",
                         (key, rid, json.dumps(data, ensure_ascii=False), user["id"], now_iso()))
        except IntegrityError:
            raise HTTPException(409, "같은 항목이 이미 있습니다.")
    return data


@app.put("/api/c/{name}/{rid}")
async def api_record_update(name: str, rid: str, request: Request) -> dict[str, Any]:
    user = require_user(request)
    key = _collection_key(name, user)
    _check_write(name, user)
    data = await _record_body(request)
    with connect() as conn:
        old = conn.one("SELECT * FROM records WHERE collection = ? AND id = ?", (key, rid))
        if old is None:
            raise HTTPException(404, "항목을 찾을 수 없습니다.")
        prev = json.loads(old["data"])
        # 개선요청: 상태·처리 메모는 처리 권한이 있어야 바꿀 수 있다
        if name == "requests" and not has_feature(user, "requests"):
            for k in ("status", "reply", "replyBy"):
                data[k] = prev.get(k)
            if old["created_by"] not in (None, user["id"]):
                raise HTTPException(403, "본인이 남긴 요청만 고칠 수 있습니다.")
        for k in ("createdBy", "createdById", "createdAt"):
            if k in prev:
                data[k] = prev[k]
        data["id"] = rid
        conn.execute("UPDATE records SET data = ?, updated_at = ? WHERE collection = ? AND id = ?", (json.dumps(data, ensure_ascii=False), now_iso(), key, rid))
    return data


@app.delete("/api/c/{name}/{rid}")
def api_record_delete(name: str, rid: str, request: Request) -> dict[str, Any]:
    user = require_user(request)
    key = _collection_key(name, user)
    with connect() as conn:
        row = conn.one("SELECT created_by FROM records WHERE collection = ? AND id = ?", (key, rid))
        if row is None:
            raise HTTPException(404, "항목을 찾을 수 없습니다.")
        allowed = is_admin(user) or row["created_by"] in (None, user["id"]) or (name == "requests" and has_feature(user, "requests")) or (name == "changelog" and has_feature(user, "changelog"))
        if not allowed:
            raise HTTPException(403, "등록한 사람이나 관리자만 삭제할 수 있습니다.")
        conn.execute("DELETE FROM records WHERE collection = ? AND id = ?", (key, rid))
    return {"ok": True}


# --- 파일: 조각으로 올리고 Range 로 내려준다 ----------------------------------------------

INLINE_TYPES = re.compile(r"^(image/(png|jpeg|gif|webp)|audio/.*|video/(mp4|webm)|application/pdf)$")


@app.post("/api/blobs/start", status_code=201)
async def api_blob_start(request: Request) -> dict[str, Any]:
    user = require_user(request)
    data = await _json(request)
    size = int(data.get("size") or 0)
    if size < 0 or size > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"파일이 너무 큽니다 (최대 {MAX_UPLOAD_BYTES // 1024 // 1024}MB).")
    blob_id = secrets.token_hex(16)
    name = Path(str(data.get("name") or "file")).name[:200] or "file"
    with connect() as conn:
        conn.execute("INSERT INTO blobs(id, name, size, mime, complete, created_by, created_at) VALUES (?,?,?,?,0,?,?)",
                     (blob_id, name, size, str(data.get("type") or "")[:100], user["id"], now_iso()))
    return {"id": blob_id, "chunkSize": CHUNK_BYTES}


@app.put("/api/blobs/{blob_id}/chunks/{seq}")
async def api_blob_chunk(blob_id: str, seq: int, request: Request) -> dict[str, Any]:
    user = require_user(request)
    body = await request.body()
    if not body or len(body) > CHUNK_BYTES:
        raise HTTPException(400, "파일 조각 크기가 올바르지 않습니다.")
    with connect() as conn:
        blob = conn.one("SELECT * FROM blobs WHERE id = ?", (blob_id,))
        if blob is None or blob["complete"] or blob["created_by"] != user["id"]:
            raise HTTPException(404, "올리는 중인 파일을 찾을 수 없습니다.")
        conn.execute("DELETE FROM blob_chunks WHERE blob_id = ? AND seq = ?", (blob_id, seq))
        conn.execute("INSERT INTO blob_chunks(blob_id, seq, data) VALUES (?,?,?)", (blob_id, seq, body))
    return {"ok": True}


@app.post("/api/blobs/{blob_id}/finish")
def api_blob_finish(blob_id: str, request: Request) -> dict[str, Any]:
    user = require_user(request)
    with connect() as conn:
        blob = conn.one("SELECT * FROM blobs WHERE id = ?", (blob_id,))
        if blob is None or blob["created_by"] != user["id"]:
            raise HTTPException(404, "올리는 중인 파일을 찾을 수 없습니다.")
        total = conn.one("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n, COUNT(*) AS c FROM blob_chunks WHERE blob_id = ?", (blob_id,))
        if int(total["n"]) != int(blob["size"]):
            raise HTTPException(400, "파일이 끝까지 올라가지 않았습니다. 다시 시도해 주세요.")
        conn.execute("UPDATE blobs SET complete = 1 WHERE id = ?", (blob_id,))
    return {"id": blob_id, "name": blob["name"], "size": blob["size"], "type": blob["mime"]}


def content_disposition(name: str, inline: bool) -> str:
    """한글 파일명도 깨지지 않도록 ASCII 대체 이름(filename)과 UTF-8 이름(filename*)을 함께 보낸다."""
    stem, suffix = Path(name).stem, Path(name).suffix
    ext = suffix if re.fullmatch(r"\.[A-Za-z0-9]{1,8}", suffix) else ""
    ascii_stem = re.sub(r"[^A-Za-z0-9-]+", "_", stem).strip("_")
    ascii_name = (ascii_stem if re.search(r"[A-Za-z0-9]", ascii_stem) else "file") + ext
    return f'{"inline" if inline else "attachment"}; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(name, safe="")}'


def _read_range(conn, blob_id: str, start: int, end: int) -> bytes:
    """[start, end] 구간 바이트를 조각들에서 모은다."""
    first, last = start // CHUNK_BYTES, end // CHUNK_BYTES
    out = bytearray()
    for row in conn.all("SELECT seq, data FROM blob_chunks WHERE blob_id = ? AND seq >= ? AND seq <= ? ORDER BY seq", (blob_id, first, last)):
        out += blob_bytes(row["data"])
    offset = start - first * CHUNK_BYTES
    return bytes(out[offset: offset + (end - start + 1)])


@app.get("/api/blobs/{blob_id}")
def api_blob_get(blob_id: str, request: Request, download: int = 0) -> Response:
    require_user(request)
    if not re.fullmatch(r"[0-9a-f]{32}", blob_id):
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    with connect() as conn:
        blob = conn.one("SELECT * FROM blobs WHERE id = ? AND complete = 1", (blob_id,))
        if blob is None:
            raise HTTPException(404, "파일을 찾을 수 없습니다.")
        size = int(blob["size"])
        inline = not download and bool(INLINE_TYPES.match(blob["mime"] or ""))
        headers = {
            "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600",
            "Content-Disposition": content_disposition(blob["name"], inline),
        }
        media = blob["mime"] if inline and blob["mime"] else "application/octet-stream"
        rng = request.headers.get("range", "")
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
        if size == 0:
            return Response(b"", media_type=media, headers=headers)
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:  # bytes=-N (끝에서 N 바이트)
                start = max(0, size - int(m.group(2)))
                end = size - 1
            if start >= size:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
            # 한 번 응답은 조각 하나 크기까지만 (Vercel 응답 크기 제한)
            end = min(end, size - 1, start + CHUNK_BYTES - 1)
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            return Response(_read_range(conn, blob_id, start, end), status_code=206, media_type=media, headers=headers)
        if size > CHUNK_BYTES:
            # 큰 파일은 Range 로 나눠 받아야 한다 (브라우저 재생·kit.js 내려받기는 알아서 나눠 받는다)
            headers["Content-Range"] = f"bytes 0-{CHUNK_BYTES - 1}/{size}"
            return Response(_read_range(conn, blob_id, 0, CHUNK_BYTES - 1), status_code=206, media_type=media, headers=headers)
        return Response(_read_range(conn, blob_id, 0, size - 1), media_type=media, headers=headers)


@app.delete("/api/blobs/{blob_id}")
def api_blob_delete(blob_id: str, request: Request) -> dict[str, Any]:
    user = require_user(request)
    with connect() as conn:
        blob = conn.one("SELECT created_by FROM blobs WHERE id = ?", (blob_id,))
        if blob is not None and (is_admin(user) or blob["created_by"] in (None, user["id"])):
            conn.execute("DELETE FROM blobs WHERE id = ?", (blob_id,))
    return {"ok": True}


# --- Google 캘린더 구독(ICS) ----------------------------------------------------------

@app.get("/api/calendar-link")
def api_calendar_link(request: Request) -> dict[str, Any]:
    user = require_user(request)
    with connect() as conn:
        row = conn.one("SELECT calendar_token FROM users WHERE id = ?", (user["id"],))
        memo = settings_get(conn, f"ics-memo:{user['id']}", False)
    token = row["calendar_token"] if row else None
    return {"enabled": bool(token), "url": _ics_url(request, token) if token else "", "includeMemo": memo}


def _ics_url(request: Request, token: str) -> str:
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    return f"{'https' if _is_https(request) else 'http'}://{host}/calendar/feed/{token}.ics"


@app.post("/api/calendar-link")
async def api_calendar_link_make(request: Request) -> dict[str, Any]:
    user = require_user(request)
    data = await _json(request)
    token = secrets.token_urlsafe(24)
    with connect() as conn:
        conn.execute("UPDATE users SET calendar_token = ? WHERE id = ?", (token, user["id"]))
        settings_set(conn, f"ics-memo:{user['id']}", bool(data.get("includeMemo")))
    return {"enabled": True, "url": _ics_url(request, token), "includeMemo": bool(data.get("includeMemo"))}


@app.delete("/api/calendar-link")
def api_calendar_link_off(request: Request) -> dict[str, Any]:
    user = require_user(request)
    with connect() as conn:
        conn.execute("UPDATE users SET calendar_token = NULL WHERE id = ?", (user["id"],))
    return {"enabled": False}


def _ics_escape(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def build_ics(events: list[dict[str, Any]], include_memo: bool) -> str:
    type_label = {"corp_day": "콥데이", "ndr": "NDR", "open_ir": "오픈IR", "ir_meeting": "IR미팅", "ipo": "IPO", "earnings": "실적발표",
                  "conference": "컨퍼런스", "visit": "탐방", "seminar": "세미나", "etc": "기타"}
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//hana-workspace//IR//KO", "CALSCALE:GREGORIAN", "X-WR-CALNAME:IR 캘린더", "X-WR-TIMEZONE:Asia/Seoul",
             "BEGIN:VTIMEZONE", "TZID:Asia/Seoul", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0900", "TZOFFSETTO:+0900", "TZNAME:KST", "END:STANDARD", "END:VTIMEZONE"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for ev in events:
        date = str(ev.get("date") or "")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            continue
        d = date.replace("-", "")
        end_date = str(ev.get("endDate") or "") or date
        title = f"[{type_label.get(ev.get('type'), '기타')}] {ev.get('companies') or ''}" + (f" · {ev['title']}" if ev.get("title") else "")
        desc = [f"증권사: {ev['brokers']}" if ev.get("brokers") else "", f"장소: {ev['location']}" if ev.get("location") else ""]
        if include_memo and ev.get("memo"):
            desc.append(str(ev["memo"]))
        lines += ["BEGIN:VEVENT", f"UID:{ev.get('id')}@hana-workspace", f"DTSTAMP:{stamp}", f"SUMMARY:{_ics_escape(title)}"]
        if ev.get("time") and re.fullmatch(r"\d{2}:\d{2}", str(ev["time"])):
            t = str(ev["time"]).replace(":", "")
            et = str(ev.get("endTime") or "").replace(":", "")
            if not re.fullmatch(r"\d{4}", et):
                h = int(t[:2]) + 1
                et = f"{min(h, 23):02d}{t[2:]}"
            lines += [f"DTSTART;TZID=Asia/Seoul:{d}T{t}00", f"DTEND;TZID=Asia/Seoul:{end_date.replace('-', '')}T{et}00"]
        else:
            nxt = (datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y%m%d")
            lines += [f"DTSTART;VALUE=DATE:{d}", f"DTEND;VALUE=DATE:{nxt}"]
        if ev.get("location"):
            lines.append(f"LOCATION:{_ics_escape(ev['location'])}")
        body = "\n".join(x for x in desc if x)
        if body:
            lines.append(f"DESCRIPTION:{_ics_escape(body)}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    # 긴 줄은 75바이트마다 접는다 (RFC 5545)
    out = []
    for line in lines:
        raw = line.encode()
        while len(raw) > 75:
            cut = 75
            while (raw[cut] & 0xC0) == 0x80:
                cut -= 1
            out.append(raw[:cut].decode())
            raw = b" " + raw[cut:]
        out.append(raw.decode())
    return "\r\n".join(out) + "\r\n"


@app.get("/calendar/feed/{token}.ics", include_in_schema=False)
def calendar_feed(token: str) -> Response:
    if STATIC_ONLY or not re.fullmatch(r"[A-Za-z0-9_-]{20,64}", token):
        raise HTTPException(404, "없는 주소입니다.")
    with connect() as conn:
        user = conn.one("SELECT id, status FROM users WHERE calendar_token = ?", (token,))
        if user is None or user["status"] != "active":
            raise HTTPException(404, "없는 주소입니다.")
        memo = settings_get(conn, f"ics-memo:{user['id']}", False)
        events = [_record_out(r) for r in conn.all("SELECT * FROM records WHERE collection = 'ir-events'")]
    return Response(build_ics(events, bool(memo)), media_type="text/calendar; charset=utf-8", headers={"Cache-Control": "no-cache"})


@app.get("/api/health", include_in_schema=False)
def health() -> dict[str, Any]:
    return {"ok": True, "db": "postgres" if IS_PG else ("none" if STATIC_ONLY else "sqlite"),
            "ai": bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()), "time": datetime.now(KST).isoformat(timespec="seconds")}


# 외부 데이터 연결 (시세·경제지표·DART·AI)
from . import integrations  # noqa: E402

integrations.register(app, require_user, has_feature, connect)


# --- 화면과 정적 파일 ------------------------------------------------------------------

PAGE_DIRS = {"notes", "calendar", "ndr", "events", "morning", "ops", "portfolio", "company", "research", "settings", "admin", "home",
             "static", "requests", "market", "account", "workload", "stats", "telegram"}
ASSET_TYPES = {".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}
PUBLIC_PAGES = {"login": "login.html", "signup": "signup.html"}


def _page(path: Path, request: Request, section: str) -> Response:
    if STATIC_ONLY:
        # DB 없이 뜬 Vercel: 브라우저 저장 모드로 동작하되, 화면이 '무엇이 빠졌는지' 안내할 수 있게 표시한다
        html = path.read_text(encoding="utf-8").replace("<head>", '<head><meta name="hana-mode" content="nodb">', 1)
        return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
    user = session_user(request)
    if user is None:
        target = request.url.path + (("?" + request.url.query) if request.url.query else "")
        return RedirectResponse("/login?next=" + quote(target, safe="/"), status_code=303)
    if user["must_change"] and section != "account":
        return RedirectResponse("/account/?first=1", status_code=303)
    feature = PAGE_FEATURES.get(section)
    if (feature and not has_feature(user, feature)) or (section == "admin" and not is_admin(user)):
        html = (ROOT / "server" / "denied.html").read_text(encoding="utf-8")
        return HTMLResponse(html, status_code=403)
    html = path.read_text(encoding="utf-8")
    html = html.replace("<head>", '<head><meta name="hana-mode" content="server">', 1)
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.get("/{path:path}", include_in_schema=False)
def site(path: str, request: Request) -> Response:
    parts = [p for p in path.split("/") if p]
    if len(parts) == 1 and parts[0] in PUBLIC_PAGES:
        if STATIC_ONLY:
            return RedirectResponse("/", status_code=303)
        if parts[0] == "login" and session_user(request) is not None:
            return RedirectResponse(_safe_next(request.query_params.get("next")), status_code=303)
        return HTMLResponse((ROOT / "server" / PUBLIC_PAGES[parts[0]]).read_text(encoding="utf-8"), headers={"Cache-Control": "no-store"})
    if any(p.startswith(".") for p in parts) or (parts and parts[0] not in PAGE_DIRS):
        raise HTTPException(404, "페이지를 찾을 수 없습니다.")
    target = (ROOT / "/".join(parts)).resolve()
    if ROOT not in target.parents and target != ROOT:
        raise HTTPException(404, "페이지를 찾을 수 없습니다.")
    if target.is_dir():
        if path and not path.endswith("/"):
            return RedirectResponse("/" + path + "/" + (("?" + request.url.query) if request.url.query else ""), status_code=308)
        target = target / "index.html"
    elif not target.exists() and target.with_suffix(".html").exists():
        target = target.with_suffix(".html")
    if not target.is_file():
        raise HTTPException(404, "페이지를 찾을 수 없습니다.")
    if target.suffix == ".html":
        return _page(target, request, parts[0] if parts else "home")
    media = ASSET_TYPES.get(target.suffix)
    if media is None:
        raise HTTPException(404, "페이지를 찾을 수 없습니다.")
    return FileResponse(target, media_type=media, headers={"Cache-Control": "no-cache"})
