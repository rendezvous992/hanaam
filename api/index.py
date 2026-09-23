"""Vercel 서버리스 함수 입구 — 모든 요청(vercel.json rewrites)이 이 FastAPI 앱으로 들어온다."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.app import app  # noqa: E402,F401
