"""노트 아카이브 서버.

노트·첨부 파일·저장한 답변을 SQLite(data/notes.db)와 data/files/ 에 저장하고,
로그인한 사용자에게만 화면(notes/*.html)과 API(/api/*)를 내준다.

실행:  uvicorn server.app:app --host 127.0.0.1 --port 8000 --proxy-headers
사용자 추가:  python -m server.manage adduser <아이디>
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("HANA_DATA_DIR", ROOT / "data")).resolve()
FILES_DIR = DATA_DIR / "files"
DB_PATH = DATA_DIR / "notes.db"

COOKIE_NAME = "hana_session"
SESSION_DAYS = int(os.environ.get("HANA_SESSION_DAYS", "30"))
MAX_UPLOAD_BYTES = int(os.environ.get("HANA_MAX_UPLOAD_MB", "500")) * 1024 * 1024

CATEGORIES = {"single", "group", "seminar", "report", "etc"}
KST = timezone(timedelta(hours=9))


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  ticker TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  review_reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  duration INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_answers (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer_html TEXT NOT NULL,
  notes_json TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_note ON files(note_id);
CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_answers(user_id);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)


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
        digest = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p), dklen=len(digest_hex) // 2
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(conn: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires = int(time.time()) + SESSION_DAYS * 86400
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
    conn.execute(
        "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)", (_token_hash(token), user_id, expires)
    )
    return token


def session_user(request: Request) -> Optional[sqlite3.Row]:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    with connect() as conn:
        return conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
            (_token_hash(token), int(time.time())),
        ).fetchone()


def require_user(request: Request) -> sqlite3.Row:
    user = session_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


# 로그인 실패가 반복되면 잠시 막는다 (IP+아이디 기준, 10분에 5번)
_FAILS: dict[str, list[float]] = {}
_FAILS_LOCK = threading.Lock()
FAIL_WINDOW = 600
FAIL_LIMIT = 5


def _fail_key(request: Request, username: str) -> str:
    ip = request.client.host if request.client else "?"
    return f"{ip}|{username.lower()}"


def too_many_failures(key: str) -> bool:
    with _FAILS_LOCK:
        recent = [t for t in _FAILS.get(key, []) if t > time.time() - FAIL_WINDOW]
        _FAILS[key] = recent
        return len(recent) >= FAIL_LIMIT


def record_failure(key: str) -> None:
    with _FAILS_LOCK:
        _FAILS.setdefault(key, []).append(time.time())


# ---------------------------------------------------------------------------
# 직렬화 · 검증
# ---------------------------------------------------------------------------

def file_meta(row: sqlite3.Row) -> dict[str, Any]:
    return {"id": row["id"], "name": row["name"], "size": row["size"], "type": row["mime"], "duration": row["duration"]}


def note_dict(conn: sqlite3.Connection, row: sqlite3.Row, files: Optional[list[sqlite3.Row]] = None) -> dict[str, Any]:
    if files is None:
        files = conn.execute("SELECT * FROM files WHERE note_id = ? ORDER BY created_at", (row["id"],)).fetchall()
    audio = next((f for f in files if f["kind"] == "audio"), None)
    return {
        "id": row["id"],
        "company": row["company"],
        "ticker": row["ticker"],
        "category": row["category"],
        "type": row["type"],
        "author": row["author"],
        "date": row["date"],
        "title": row["title"],
        "body": row["body"],
        "link": row["link"],
        "review": {"reason": row["review_reason"]} if row["review_reason"] else None,
        "files": [file_meta(f) for f in files if f["kind"] == "attach"],
        "audio": file_meta(audio) if audio else None,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _text(data: dict[str, Any], key: str, max_len: int, required: bool = False) -> str:
    value = data.get(key, "")
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise HTTPException(400, f"{key} 값이 올바르지 않습니다.")
    value = value.strip() if key != "body" else value
    if required and not value.strip():
        raise HTTPException(400, f"{key} 값을 입력해 주세요.")
    if len(value) > max_len:
        raise HTTPException(400, f"{key} 값이 너무 깁니다.")
    return value


def clean_note(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise HTTPException(400, "잘못된 요청입니다.")
    out = {
        "company": _text(data, "company", 100, required=True),
        "ticker": _text(data, "ticker", 6),
        "category": _text(data, "category", 20, required=True),
        "type": _text(data, "type", 40),
        "author": _text(data, "author", 60),
        "date": _text(data, "date", 10, required=True),
        "title": _text(data, "title", 200, required=True),
        "body": _text(data, "body", 500_000),
        "link": _text(data, "link", 2000),
    }
    if out["category"] not in CATEGORIES:
        raise HTTPException(400, "분류 값이 올바르지 않습니다.")
    if out["ticker"] and not re.fullmatch(r"[0-9]{6}", out["ticker"]):
        raise HTTPException(400, "종목코드는 숫자 6자리입니다.")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", out["date"]):
        raise HTTPException(400, "날짜 형식이 올바르지 않습니다.")
    if out["link"] and not re.match(r"https?://", out["link"], re.I):
        raise HTTPException(400, "링크는 http:// 또는 https:// 로 시작해야 합니다.")
    review = data.get("review")
    out["review_reason"] = (
        str(review.get("reason") or "확인 필요")[:200] if isinstance(review, dict) else None
    )
    return out


def get_note_row(conn: sqlite3.Connection, note_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "노트를 찾을 수 없습니다.")
    return row


def delete_file_blob(file_id: str) -> None:
    path = FILES_DIR / file_id
    try:
        path.unlink()
    except FileNotFoundError:
        pass


# ---------------------------------------------------------------------------
# 앱
# ---------------------------------------------------------------------------

app = FastAPI(title="노트 아카이브", docs_url=None, redoc_url=None, openapi_url=None)
init_db()


@app.middleware("http")
async def api_guard(request: Request, call_next):
    # 다른 사이트에서 보낸 폼·스크립트 요청(CSRF)을 막기 위해, 데이터를 바꾸는 API 는 전용 헤더를 요구한다
    if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("x-hana") != "1":
            return JSONResponse({"detail": "잘못된 요청입니다."}, status_code=403)
    response: Response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


def _set_session_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )


# --- 화면 ------------------------------------------------------------------

def _page(path: Path, request: Request) -> Response:
    if session_user(request) is None:
        target = request.url.path + (("?" + request.url.query) if request.url.query else "")
        return RedirectResponse("/login?next=" + _quote(target), status_code=303)
    html = path.read_text(encoding="utf-8")
    # 화면 스크립트가 서버 모드로 동작하도록 표시
    html = html.replace("<head>", '<head><meta name="hana-mode" content="server">', 1)
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


def _quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="/")


@app.get("/", include_in_schema=False)
def root() -> Response:
    return RedirectResponse("/notes/", status_code=303)


@app.get("/notes", include_in_schema=False)
def notes_no_slash() -> Response:
    return RedirectResponse("/notes/", status_code=303)


@app.get("/notes/", include_in_schema=False)
@app.get("/notes/index.html", include_in_schema=False)
def notes_page(request: Request) -> Response:
    return _page(ROOT / "notes" / "index.html", request)


@app.get("/notes/saved.html", include_in_schema=False)
@app.get("/notes/saved", include_in_schema=False)
def saved_page(request: Request) -> Response:
    return _page(ROOT / "notes" / "saved.html", request)


@app.get("/login", include_in_schema=False)
def login_page(request: Request) -> Response:
    if session_user(request) is not None:
        return RedirectResponse(_safe_next(request.query_params.get("next")), status_code=303)
    return HTMLResponse((ROOT / "server" / "login.html").read_text(encoding="utf-8"), headers={"Cache-Control": "no-store"})


def _safe_next(value: Optional[str]) -> str:
    # 로그인 뒤 이동할 주소는 이 사이트 안쪽 경로만 허용
    if value and value.startswith("/") and not value.startswith("//") and "\\" not in value:
        return value
    return "/notes/"


# --- 인증 API ---------------------------------------------------------------

@app.post("/api/login")
async def api_login(request: Request) -> Response:
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "잘못된 요청입니다.")
    username = str(data.get("username") or "").strip()
    password = str(data.get("password") or "")
    key = _fail_key(request, username)
    if too_many_failures(key):
        raise HTTPException(429, "로그인 실패가 반복되어 10분 동안 막혔습니다. 잠시 후 다시 시도해 주세요.")
    with connect() as conn:
        user = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if user is None or not verify_password(password, user["password_hash"]):
            record_failure(key)
            raise HTTPException(401, "아이디 또는 비밀번호가 맞지 않습니다.")
        token = create_session(conn, user["id"])
    response = JSONResponse({"ok": True, "next": _safe_next(data.get("next"))})
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


@app.get("/api/me")
def api_me(request: Request) -> dict[str, Any]:
    user = require_user(request)
    return {"username": user["username"], "displayName": user["display_name"], "role": user["role"]}


@app.post("/api/password")
async def api_password(request: Request) -> dict[str, Any]:
    user = require_user(request)
    data = await request.json()
    current = str(data.get("current") or "")
    new = str(data.get("new") or "")
    if not verify_password(current, user["password_hash"]):
        raise HTTPException(400, "현재 비밀번호가 맞지 않습니다.")
    if len(new) < 8:
        raise HTTPException(400, "새 비밀번호는 8자 이상이어야 합니다.")
    with connect() as conn:
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(new), user["id"]))
        # 다른 기기의 로그인은 끊는다
        token = request.cookies.get(COOKIE_NAME) or ""
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user["id"], _token_hash(token)))
    return {"ok": True}


# --- 노트 API ---------------------------------------------------------------

@app.get("/api/notes")
def api_list_notes(request: Request) -> list[dict[str, Any]]:
    require_user(request)
    with connect() as conn:
        rows = conn.execute("SELECT * FROM notes ORDER BY date DESC, id DESC").fetchall()
        files: dict[int, list[sqlite3.Row]] = {}
        for f in conn.execute("SELECT * FROM files ORDER BY created_at").fetchall():
            files.setdefault(f["note_id"], []).append(f)
        return [note_dict(conn, r, files.get(r["id"], [])) for r in rows]


@app.post("/api/notes", status_code=201)
async def api_create_note(request: Request) -> dict[str, Any]:
    user = require_user(request)
    data = clean_note(await request.json())
    if not data["author"]:
        data["author"] = user["display_name"]
    with connect() as conn:
        cur = conn.execute(
            """INSERT INTO notes(company, ticker, category, type, author, date, title, body, link, review_reason, created_by, created_at)
               VALUES (:company, :ticker, :category, :type, :author, :date, :title, :body, :link, :review_reason, :created_by, :created_at)""",
            dict(data, created_by=user["id"], created_at=now_iso()),
        )
        return note_dict(conn, get_note_row(conn, cur.lastrowid))


@app.put("/api/notes/{note_id}")
async def api_update_note(note_id: int, request: Request) -> dict[str, Any]:
    require_user(request)
    data = clean_note(await request.json())
    with connect() as conn:
        get_note_row(conn, note_id)
        conn.execute(
            """UPDATE notes SET company=:company, ticker=:ticker, category=:category, type=:type, author=:author,
               date=:date, title=:title, body=:body, link=:link, review_reason=:review_reason, updated_at=:updated_at
               WHERE id=:id""",
            dict(data, updated_at=now_iso(), id=note_id),
        )
        return note_dict(conn, get_note_row(conn, note_id))


@app.delete("/api/notes/{note_id}")
def api_delete_note(note_id: int, request: Request) -> dict[str, Any]:
    user = require_user(request)
    with connect() as conn:
        row = get_note_row(conn, note_id)
        if user["role"] != "admin" and row["created_by"] not in (None, user["id"]):
            raise HTTPException(403, "노트는 등록한 사람이나 관리자만 삭제할 수 있습니다.")
        file_ids = [f["id"] for f in conn.execute("SELECT id FROM files WHERE note_id = ?", (note_id,))]
        conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    for fid in file_ids:
        delete_file_blob(fid)
    return {"ok": True}


# --- 파일 API ---------------------------------------------------------------

@app.post("/api/notes/{note_id}/files", status_code=201)
async def api_upload_file(
    note_id: int,
    request: Request,
    file: UploadFile = File(...),
    kind: str = Form("attach"),
    duration: int = Form(0),
) -> dict[str, Any]:
    require_user(request)
    if kind not in ("attach", "audio"):
        raise HTTPException(400, "파일 종류가 올바르지 않습니다.")
    with connect() as conn:
        get_note_row(conn, note_id)

    file_id = secrets.token_hex(16)
    path = FILES_DIR / file_id
    size = 0
    try:
        with path.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"파일이 너무 큽니다 (최대 {MAX_UPLOAD_BYTES // 1024 // 1024}MB).")
                out.write(chunk)
    except BaseException:
        delete_file_blob(file_id)
        raise

    name = Path(file.filename or "file").name[:200] or "file"
    old_audio: list[str] = []
    with connect() as conn:
        # 노트가 그사이 지워졌으면 파일도 버린다
        if conn.execute("SELECT 1 FROM notes WHERE id = ?", (note_id,)).fetchone() is None:
            delete_file_blob(file_id)
            raise HTTPException(404, "노트를 찾을 수 없습니다.")
        if kind == "audio":
            old_audio = [r["id"] for r in conn.execute("SELECT id FROM files WHERE note_id = ? AND kind = 'audio'", (note_id,))]
            conn.execute("DELETE FROM files WHERE note_id = ? AND kind = 'audio'", (note_id,))
        conn.execute(
            "INSERT INTO files(id, note_id, kind, name, size, mime, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (file_id, note_id, kind, name, size, (file.content_type or "")[:100], max(0, int(duration)), now_iso()),
        )
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    for fid in old_audio:
        delete_file_blob(fid)
    return file_meta(row)


@app.get("/api/files/{file_id}")
def api_get_file(file_id: str, request: Request, download: int = 0) -> Response:
    require_user(request)
    if not re.fullmatch(r"[0-9a-f]{32}", file_id):
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    with connect() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    path = FILES_DIR / file_id
    if row is None or not path.exists():
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    # 녹음은 브라우저에서 바로 재생, 첨부는 내려받기 (HTML 등이 이 사이트 안에서 열리지 않게)
    inline = row["kind"] == "audio" and not download
    return FileResponse(
        path,
        media_type=row["mime"] if inline and row["mime"] else "application/octet-stream",
        headers={
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": content_disposition(row["name"], inline),
        },
    )


def content_disposition(name: str, inline: bool) -> str:
    """한글 파일명도 깨지지 않도록 ASCII 대체 이름(filename)과 UTF-8 이름(filename*)을 함께 보낸다."""
    from urllib.parse import quote

    stem, suffix = Path(name).stem, Path(name).suffix
    ext = suffix if re.fullmatch(r"\.[A-Za-z0-9]{1,8}", suffix) else ""
    ascii_stem = re.sub(r"[^A-Za-z0-9-]+", "_", stem).strip("_")
    ascii_name = (ascii_stem if re.search(r"[A-Za-z0-9]", ascii_stem) else "file") + ext
    return f'{"inline" if inline else "attachment"}; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(name, safe="")}'


@app.delete("/api/files/{file_id}")
def api_delete_file(file_id: str, request: Request) -> dict[str, Any]:
    require_user(request)
    with connect() as conn:
        row = conn.execute("SELECT id FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "파일을 찾을 수 없습니다.")
        conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
    delete_file_blob(file_id)
    return {"ok": True}


# --- 저장한 답변 API ---------------------------------------------------------

@app.get("/api/saved")
def api_list_saved(request: Request) -> list[dict[str, Any]]:
    user = require_user(request)
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM saved_answers WHERE user_id = ? ORDER BY saved_at DESC", (user["id"],)
        ).fetchall()
    return [
        {
            "id": r["id"],
            "question": r["question"],
            "answerHtml": r["answer_html"],
            "notes": json.loads(r["notes_json"]),
            "savedAt": r["saved_at"],
        }
        for r in rows
    ]


@app.post("/api/saved", status_code=201)
async def api_add_saved(request: Request) -> dict[str, Any]:
    user = require_user(request)
    data = await request.json()
    question = str(data.get("question") or "").strip()[:1000]
    answer_html = str(data.get("answerHtml") or "")[:200_000]
    notes = data.get("notes") if isinstance(data.get("notes"), list) else []
    notes = [{"id": int(n.get("id", 0)), "label": str(n.get("label", ""))[:300]} for n in notes[:50] if isinstance(n, dict)]
    if not question:
        raise HTTPException(400, "질문이 비어 있습니다.")
    item = {"id": secrets.token_hex(8), "question": question, "answerHtml": answer_html, "notes": notes, "savedAt": now_iso()}
    with connect() as conn:
        conn.execute(
            "INSERT INTO saved_answers(id, user_id, question, answer_html, notes_json, saved_at) VALUES (?, ?, ?, ?, ?, ?)",
            (item["id"], user["id"], question, answer_html, json.dumps(notes, ensure_ascii=False), item["savedAt"]),
        )
    return item


@app.delete("/api/saved/{item_id}")
def api_delete_saved(item_id: str, request: Request) -> dict[str, Any]:
    user = require_user(request)
    with connect() as conn:
        conn.execute("DELETE FROM saved_answers WHERE id = ? AND user_id = ?", (item_id, user["id"]))
    return {"ok": True}


@app.get("/api/health", include_in_schema=False)
def health() -> dict[str, Any]:
    return {"ok": True, "time": datetime.now(KST).isoformat(timespec="seconds")}


# --- 정적 파일 (CSS·JS·아이콘: 로그인 없이 받아도 되는 것만) -------------------

app.mount("/notes/static", StaticFiles(directory=ROOT / "notes" / "static"), name="notes-static")
app.mount("/company/static", StaticFiles(directory=ROOT / "company" / "static"), name="company-static")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
