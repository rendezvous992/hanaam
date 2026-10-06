#!/usr/bin/env bash
# 클라우드 세션 시작 때 Codebase Memory MCP 를 설치하고 이 레포를 미리 색인한다.
# 내 PC 에서는 아무것도 하지 않는다 (처음 MCP 를 켤 때 실행기가 알아서 설치).
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

CBM="$CLAUDE_PROJECT_DIR/.claude/bin/codebase-memory-mcp.sh"
"$CBM" --version >/dev/null
"$CBM" config set auto_index true >/dev/null
"$CBM" cli --quiet index_repository --repo-path "$CLAUDE_PROJECT_DIR" >/dev/null
