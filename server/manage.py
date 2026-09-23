"""사용자 관리 명령.

    python -m server.manage adduser <아이디> [--name 표시이름] [--admin]
    python -m server.manage passwd <아이디>
    python -m server.manage deluser <아이디>
    python -m server.manage users
    python -m server.manage backup [저장할 폴더]
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from .app import DATA_DIR, DB_PATH, FILES_DIR, connect, hash_password, init_db, now_iso


def ask_password() -> str:
    env = os.environ.get("HANA_PASSWORD")
    if env:
        return env
    while True:
        first = getpass.getpass("비밀번호 (8자 이상): ")
        if len(first) < 8:
            print("8자 이상으로 입력해 주세요.")
            continue
        if getpass.getpass("비밀번호 확인: ") != first:
            print("두 번 입력한 비밀번호가 다릅니다.")
            continue
        return first


def cmd_adduser(args: argparse.Namespace) -> int:
    if not re.fullmatch(r"[A-Za-z0-9._-]{2,40}", args.username):
        print("아이디는 영문·숫자·점(.)·밑줄(_)·하이픈(-) 2~40자로 정해 주세요.")
        return 1
    password = ask_password()
    if len(password) < 8:
        print("비밀번호는 8자 이상이어야 합니다.")
        return 1
    with connect() as conn:
        try:
            conn.execute(
                "INSERT INTO users(username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                (args.username, args.name or args.username, "admin" if args.admin else "member", hash_password(password), now_iso()),
            )
        except sqlite3.IntegrityError:
            print(f"'{args.username}' 아이디가 이미 있습니다.")
            return 1
    print(f"'{args.username}' 사용자를 만들었습니다.{' (관리자)' if args.admin else ''}")
    return 0


def cmd_passwd(args: argparse.Namespace) -> int:
    password = ask_password()
    with connect() as conn:
        cur = conn.execute("UPDATE users SET password_hash = ? WHERE username = ?", (hash_password(password), args.username))
        if not cur.rowcount:
            print(f"'{args.username}' 사용자가 없습니다.")
            return 1
        conn.execute("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)", (args.username,))
    print("비밀번호를 바꿨습니다. 이 사용자의 기존 로그인은 모두 끊었습니다.")
    return 0


def cmd_deluser(args: argparse.Namespace) -> int:
    with connect() as conn:
        cur = conn.execute("DELETE FROM users WHERE username = ?", (args.username,))
    if not cur.rowcount:
        print(f"'{args.username}' 사용자가 없습니다.")
        return 1
    print(f"'{args.username}' 사용자를 지웠습니다. (등록한 노트는 남아 있습니다)")
    return 0


def cmd_users(_: argparse.Namespace) -> int:
    with connect() as conn:
        rows = conn.execute("SELECT username, display_name, role, created_at FROM users ORDER BY username").fetchall()
    if not rows:
        print("사용자가 없습니다. 'adduser' 로 만들어 주세요.")
        return 0
    for r in rows:
        print(f"{r['username']:<20} {r['display_name']:<16} {r['role']:<7} {r['created_at']}")
    return 0


def cmd_backup(args: argparse.Namespace) -> int:
    target_root = Path(args.dest or (DATA_DIR / "backups")).resolve()
    target = target_root / datetime.now().strftime("%Y%m%d-%H%M%S")
    target.mkdir(parents=True, exist_ok=True)
    # 서버가 돌고 있어도 안전하게 DB 를 복사한다
    with connect() as src, sqlite3.connect(target / "notes.db") as dst:
        src.backup(dst)
    shutil.copytree(FILES_DIR, target / "files", dirs_exist_ok=True)
    print(f"백업했습니다: {target}")
    return 0


def main(argv: list[str] | None = None) -> int:
    init_db()
    parser = argparse.ArgumentParser(prog="python -m server.manage", description="노트 아카이브 사용자 관리")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("adduser", help="사용자 추가")
    p.add_argument("username")
    p.add_argument("--name", help="화면에 보일 이름 (작성자로도 쓰임)")
    p.add_argument("--admin", action="store_true", help="관리자 권한 (모든 노트 삭제 가능)")
    p.set_defaults(func=cmd_adduser)

    p = sub.add_parser("passwd", help="비밀번호 변경")
    p.add_argument("username")
    p.set_defaults(func=cmd_passwd)

    p = sub.add_parser("deluser", help="사용자 삭제")
    p.add_argument("username")
    p.set_defaults(func=cmd_deluser)

    p = sub.add_parser("users", help="사용자 목록")
    p.set_defaults(func=cmd_users)

    p = sub.add_parser("backup", help="DB·첨부 파일 백업")
    p.add_argument("dest", nargs="?", help="백업 폴더 (기본: data/backups)")
    p.set_defaults(func=cmd_backup)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
