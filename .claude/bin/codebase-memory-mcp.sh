#!/usr/bin/env bash
# Codebase Memory MCP 실행기 (https://github.com/DeusData/codebase-memory-mcp)
# - PATH 에 이미 있으면 그것을 쓰고, 없으면 ~/.cache/hanaam-cbm 에 pip 로 한 번 설치한다.
# - stdout 은 MCP 통신용이므로 설치 메시지는 모두 stderr 로 보낸다.
# - 인자를 주면 그대로 넘긴다:  .claude/bin/codebase-memory-mcp.sh cli list_projects
set -euo pipefail

VENV="${HANAAM_CBM_VENV:-$HOME/.cache/hanaam-cbm}"
VERSION="${HANAAM_CBM_VERSION:-0.11.0}"

if command -v codebase-memory-mcp >/dev/null 2>&1; then
  BIN="$(command -v codebase-memory-mcp)"
else
  BIN="$VENV/bin/codebase-memory-mcp"
  if [ ! -x "$BIN" ]; then
    echo "codebase-memory-mcp $VERSION 설치 중 → $VENV" >&2
    python3 -m venv "$VENV" >&2
    "$VENV/bin/pip" install -q "codebase-memory-mcp==$VERSION" >&2
  fi
fi

exec "$BIN" "$@"
