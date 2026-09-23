#!/usr/bin/env bash
# 한 줄 설치/업데이트: 코드를 /opt/hana-notes-src 로 받아서 deploy/setup.sh 를 실행한다.
#
#   curl -fsSL https://raw.githubusercontent.com/rendezvous992/hanaam/HEAD/deploy/install.sh -o install.sh
#   sudo bash install.sh                 # https://<공인 IP>
#   sudo bash install.sh --port 8443     # 443 을 다른 사이트가 쓰고 있을 때
#
# 레포가 Private 이면 GitHub 토큰을 함께 준다:
#   sudo GITHUB_TOKEN=<토큰> bash install.sh
set -euo pipefail

REPO="${HANA_REPO:-rendezvous992/hanaam}"
SRC=/opt/hana-notes-src
TOKEN="${GITHUB_TOKEN:-}"

die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "sudo 로 실행해 주세요:  sudo bash install.sh"

if ! command -v git >/dev/null; then
  echo "▶ git 설치"
  if command -v apt-get >/dev/null; then
    apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q git
  elif command -v dnf >/dev/null; then
    dnf install -y -q git
  else
    die "Ubuntu 또는 Amazon Linux 2023 에서 실행해 주세요."
  fi
fi

# 토큰은 명령줄 옵션으로만 넘기고 .git/config 에는 남기지 않는다
git_auth=()
if [ -n "$TOKEN" ]; then
  basic="$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"
  git_auth=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $basic")
fi

echo "▶ 코드 받기 ($REPO)"
if [ -d "$SRC/.git" ]; then
  git "${git_auth[@]}" -C "$SRC" fetch -q --depth 1 origin HEAD \
    || die "코드를 받지 못했습니다. 레포가 Private 이면 GITHUB_TOKEN 을 확인해 주세요."
  git -C "$SRC" reset -q --hard FETCH_HEAD
else
  rm -rf "$SRC"
  git "${git_auth[@]}" clone -q --depth 1 "https://github.com/$REPO.git" "$SRC" \
    || die "코드를 받지 못했습니다. 레포가 Private 이면 GITHUB_TOKEN=<토큰> 을 붙여 실행해 주세요."
fi
echo "  최신 커밋: $(git -C "$SRC" log -1 --format='%h %s')"

exec bash "$SRC/deploy/setup.sh" "$@"
