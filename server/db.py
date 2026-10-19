"""DB 연결 — SQLite(내 PC·AWS 한 대) 와 Postgres(Vercel+Neon 등) 를 같은 코드로 쓴다.

DATABASE_URL(또는 POSTGRES_URL) 이 postgres:// 로 시작하면 Postgres, 아니면 data/notes.db(SQLite).
SQL 은 SQLite 식 자리표시자(?) 로 쓰고, Postgres 에서는 %s 로 바꿔 실행한다.
"""

from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Optional

ROOT = Path(__file__).resolve().parent.parent
DB_URL = (os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or "").strip()
IS_PG = DB_URL.startswith(("postgres://", "postgresql://"))
ON_VERCEL = bool(os.environ.get("VERCEL"))
# Vercel 인데 DB 가 없으면 서버 기능 없이 화면만 내준다(브라우저 저장 모드)
STATIC_ONLY = ON_VERCEL and not IS_PG

DATA_DIR = Path(os.environ.get("HANA_DATA_DIR", ROOT / "data")).resolve()
DB_PATH = DATA_DIR / "notes.db"

if IS_PG:
    import psycopg
    from psycopg.rows import dict_row

    IntegrityError: tuple = (psycopg.errors.IntegrityError,)
else:
    IntegrityError = (sqlite3.IntegrityError,)

_QMARK = re.compile(r"\?")


class Conn:
    """sqlite3 / psycopg 연결을 같은 모양으로 감싼다. with 블록이 끝나면 커밋하고 닫는다."""

    def __init__(self) -> None:
        if IS_PG:
            self.raw = psycopg.connect(DB_URL, row_factory=dict_row, autocommit=False, connect_timeout=10)
        else:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            self.raw = sqlite3.connect(DB_PATH, timeout=15)
            self.raw.row_factory = sqlite3.Row
            self.raw.execute("PRAGMA foreign_keys = ON")
            self.raw.execute("PRAGMA busy_timeout = 15000")

    def execute(self, sql: str, params: Iterable[Any] = ()):
        if IS_PG:
            return self.raw.execute(_QMARK.sub("%s", sql), tuple(params))
        return self.raw.execute(sql, tuple(params))

    def one(self, sql: str, params: Iterable[Any] = ()) -> Optional[Any]:
        return self.execute(sql, params).fetchone()

    def all(self, sql: str, params: Iterable[Any] = ()) -> list:
        return self.execute(sql, params).fetchall()

    def __enter__(self) -> "Conn":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                self.raw.commit()
            else:
                self.raw.rollback()
        finally:
            self.raw.close()


def connect() -> Conn:
    return Conn()


def blob_bytes(value: Any) -> bytes:
    if value is None:
        return b""
    if isinstance(value, memoryview):
        return value.tobytes()
    return bytes(value)


# ---------------------------------------------------------------------------
# 스키마
# ---------------------------------------------------------------------------

ID = "BIGSERIAL PRIMARY KEY" if IS_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
BLOB = "BYTEA" if IS_PG else "BLOB"
BIGINT = "BIGINT" if IS_PG else "INTEGER"

SCHEMA = [
    f"""CREATE TABLE IF NOT EXISTS users (
      id {ID},
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id {BIGINT} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at {BIGINT} NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS notes (
      id {ID},
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
      created_by {BIGINT} REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT
    )""",
    f"""CREATE TABLE IF NOT EXISTS blobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size {BIGINT} NOT NULL DEFAULT 0,
      mime TEXT NOT NULL DEFAULT '',
      complete INTEGER NOT NULL DEFAULT 0,
      created_by {BIGINT} REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS blob_chunks (
      blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      data {BLOB} NOT NULL,
      PRIMARY KEY (blob_id, seq)
    )""",
    f"""CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      note_id {BIGINT} NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      size {BIGINT} NOT NULL,
      mime TEXT NOT NULL DEFAULT '',
      duration INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS saved_answers (
      id TEXT PRIMARY KEY,
      user_id {BIGINT} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer_html TEXT NOT NULL,
      notes_json TEXT NOT NULL,
      saved_at TEXT NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS records (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_by {BIGINT} REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (collection, id)
    )""",
    """CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_files_note ON files(note_id)",
    "CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_answers(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_records_coll ON records(collection)",
]

# 나중에 늘어난 사용자 열 (이미 만든 DB 에도 추가한다)
USER_COLUMNS = {
    "email": "TEXT NOT NULL DEFAULT ''",
    "department": "TEXT NOT NULL DEFAULT ''",
    "status": "TEXT NOT NULL DEFAULT 'active'",
    "permissions": "TEXT NOT NULL DEFAULT '[]'",
    "must_change": "INTEGER NOT NULL DEFAULT 0",
    "last_login_at": "TEXT",
    "calendar_token": "TEXT",
}


SESSION_COLUMNS = {"created_at": "TEXT", "ip": "TEXT", "ua": "TEXT", "seen_at": "TEXT"}


def _add_columns(conn, table: str, columns: dict[str, str]) -> None:
    if IS_PG:
        for col, decl in columns.items():
            conn.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {decl}")
    else:
        have = {r["name"] for r in conn.all(f"PRAGMA table_info({table})")}
        for col, decl in columns.items():
            if col not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


def init_db() -> None:
    if STATIC_ONLY:
        return
    with connect() as conn:
        if not IS_PG:
            conn.execute("PRAGMA journal_mode = WAL")
        for stmt in SCHEMA:
            conn.execute(stmt)
        _add_columns(conn, "users", USER_COLUMNS)
        _add_columns(conn, "sessions", SESSION_COLUMNS)
        # 예전 설치본: 최고 관리자가 없으면 가장 먼저 만든 관리자를 최고 관리자로
        if conn.one("SELECT 1 FROM users WHERE role = 'super'") is None:
            first = conn.one("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
            if first is not None:
                conn.execute("UPDATE users SET role = 'super' WHERE id = ?", (first["id"],))
