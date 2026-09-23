#!/usr/bin/env bash
# 노트 아카이브 서버 설치 스크립트 (AWS EC2: Ubuntu 22.04+/Amazon Linux 2023)
#
#   sudo bash deploy/setup.sh                    # 도메인 없이: https://<EC2 공인 IP> (자체 인증서, 첫 접속 때 경고 1회)
#   sudo bash deploy/setup.sh --port 8443        # 443 을 이미 다른 사이트가 쓰고 있을 때: https://<IP>:8443
#   sudo bash deploy/setup.sh notes.example.com  # 도메인 있으면: 정식 HTTPS 인증서 자동 발급
#
# 다시 실행하면 코드만 새로 복사하고 서버를 재시작한다 (데이터는 그대로).
set -euo pipefail

DOMAIN=""
HTTPS_PORT=443
while [ $# -gt 0 ]; do
  case "$1" in
    --port) HTTPS_PORT="${2:-}"; shift 2 ;;
    --port=*) HTTPS_PORT="${1#--port=}"; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    -*) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
    *) DOMAIN="$1"; shift ;;
  esac
done
APP_DIR=/opt/hana-notes
DATA_DIR=/var/lib/hana-notes
APP_USER=hana
CADDY_VERSION=2.8.4
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "sudo 로 실행해 주세요:  sudo bash deploy/setup.sh"
[ -f "$SRC_DIR/server/app.py" ] || die "저장소 폴더 안에서 실행해 주세요 (server/app.py 를 찾지 못했습니다)."
[[ "$HTTPS_PORT" =~ ^[0-9]+$ ]] && [ "$HTTPS_PORT" -ge 1 ] && [ "$HTTPS_PORT" -le 65535 ] || die "--port 값이 올바르지 않습니다: $HTTPS_PORT"
[ -z "$DOMAIN" ] || [ "$HTTPS_PORT" = 443 ] || die "도메인을 쓸 때는 443 포트만 됩니다 (인증서 발급에 80·443 이 필요)."

# 이미 이 서버에서 돌고 있는 다른 사이트와 포트가 겹치면 건드리지 않고 멈춘다
port_owner() {
  ss -Hltnp "sport = :$1" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2 || true
}
check_port() {
  local owner
  owner="$(port_owner "$1")"
  case "$owner" in
    ""|caddy) ;;
    uvicorn|python*) [ "$1" = 8000 ] && systemctl is-active --quiet hana-notes 2>/dev/null || die "$1 번 포트를 이미 '$owner' 프로그램이 쓰고 있습니다." ;;
    *) die "$1 번 포트를 이미 '$owner' 프로그램이 쓰고 있습니다 (기존 사이트일 수 있습니다).
   기존 사이트는 그대로 두고 다른 포트로 설치하려면:
     sudo bash deploy/setup.sh --port 8443" ;;
  esac
}
if command -v ss >/dev/null; then
  check_port "$HTTPS_PORT"
  if [ "$HTTPS_PORT" = 443 ]; then check_port 80; fi
  check_port 8000
fi

# ---------------------------------------------------------------- 1. 패키지
say "1/6 필요한 프로그램 설치"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q python3 python3-venv python3-pip curl tar rsync sqlite3
elif command -v dnf >/dev/null; then
  dnf install -y -q python3 python3-pip curl tar rsync sqlite
else
  die "Ubuntu 또는 Amazon Linux 2023 에서 실행해 주세요."
fi
python3 - <<'PY' || die "Python 3.9 이상이 필요합니다. Ubuntu 22.04 이상이나 Amazon Linux 2023 을 써 주세요."
import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)
PY

# ---------------------------------------------------------------- 2. 앱
say "2/6 앱 설치 ($APP_DIR)"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
rsync -a --delete --exclude .git --exclude data --exclude venv --exclude '__pycache__' "$SRC_DIR"/ "$APP_DIR"/
[ -d "$APP_DIR/venv" ] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/server/requirements.txt"
chown -R root:root "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

[ -f /etc/hana-notes.env ] || { printf '# 키를 넣고 sudo systemctl restart hana-notes\n# ANTHROPIC_API_KEY=\n# DART_API_KEY=\n# EODHD_API_KEY=\n' > /etc/hana-notes.env; chmod 600 /etc/hana-notes.env; }

cat > /etc/systemd/system/hana-notes.service <<EOF
[Unit]
Description=Note archive (uvicorn)
After=network.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=HANA_DATA_DIR=$DATA_DIR
# 외부 연결 키(ANTHROPIC_API_KEY, DART_API_KEY, EODHD_API_KEY)를 넣는 파일 (없어도 됨)
EnvironmentFile=-/etc/hana-notes.env
ExecStart=$APP_DIR/venv/bin/uvicorn server.app:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips 127.0.0.1
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------- 3. Caddy (HTTPS)
say "3/6 HTTPS 서버(Caddy) 설치"
if ! /usr/local/bin/caddy version 2>/dev/null | grep -q "v$CADDY_VERSION"; then
  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "지원하지 않는 CPU 입니다: $(uname -m)" ;;
  esac
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz" -o "$TMP/caddy.tgz"
  tar -xzf "$TMP/caddy.tgz" -C "$TMP" caddy
  install -m 755 "$TMP/caddy" /usr/local/bin/caddy
  rm -rf "$TMP"
fi
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy

# EC2 메타데이터에서 IP 를 읽는다 (IMDSv2)
imds() {
  local token
  token="$(curl -fsS -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
  curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true
}
PUBLIC_IP="$(imds public-ipv4)"
PRIVATE_IP="$(imds local-ipv4)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"

if [ -n "$DOMAIN" ]; then
  SITE_URL="https://$DOMAIN"
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	request_body {
		max_size 600MB
	}
	reverse_proxy 127.0.0.1:8000
}
EOF
else
  [ -n "$PUBLIC_IP" ] || die "공인 IP 를 알아내지 못했습니다. EC2 에 공인 IP(또는 탄력적 IP)를 붙이거나 도메인을 인자로 주세요."
  if [ "$HTTPS_PORT" = 443 ]; then
    PORT_SUFFIX=""
    GLOBAL_EXTRA=""
    REDIRECT_BLOCK="http://$PUBLIC_IP {
	redir https://{host}{uri} permanent
}"
  else
    # 80 번 포트는 기존 사이트 몫으로 남겨 둔다
    PORT_SUFFIX=":$HTTPS_PORT"
    GLOBAL_EXTRA="	auto_https disable_redirects
	http_port 18080"
    REDIRECT_BLOCK=""
  fi
  SITE_URL="https://$PUBLIC_IP$PORT_SUFFIX"
  # 브라우저는 IP 로 접속할 때 SNI 를 보내지 않으므로 default_sni 로 인증서를 고르게 한다
  cat > /etc/caddy/Caddyfile <<EOF
{
	default_sni $PUBLIC_IP
$GLOBAL_EXTRA
}

https://$PUBLIC_IP$PORT_SUFFIX${PRIVATE_IP:+, https://$PRIVATE_IP$PORT_SUFFIX} {
	tls internal
	encode gzip
	request_body {
		max_size 600MB
	}
	reverse_proxy 127.0.0.1:8000
}

$REDIRECT_BLOCK
EOF
fi
/usr/local/bin/caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy (HTTPS)
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------- 4. 매일 백업
say "4/6 매일 새벽 백업 설정 (14일 보관)"
cat > /etc/systemd/system/hana-notes-backup.service <<EOF
[Unit]
Description=Note archive backup

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=HANA_DATA_DIR=$DATA_DIR
ExecStart=$APP_DIR/venv/bin/python -m server.manage backup $DATA_DIR/backups
ExecStartPost=/usr/bin/find $DATA_DIR/backups -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
EOF
cat > /etc/systemd/system/hana-notes-backup.timer <<'EOF'
[Unit]
Description=Daily note archive backup

[Timer]
OnCalendar=*-*-* 18:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF

# ---------------------------------------------------------------- 5. 시작
say "5/6 서버 시작"
systemctl daemon-reload
systemctl enable --now hana-notes.service caddy.service hana-notes-backup.timer >/dev/null
systemctl restart hana-notes.service
systemctl reload caddy.service 2>/dev/null || systemctl restart caddy.service
sleep 2
curl -fsS http://127.0.0.1:8000/api/health >/dev/null || die "앱 서버가 뜨지 않았습니다.  sudo journalctl -u hana-notes -n 50  으로 확인해 주세요."

# ---------------------------------------------------------------- 6. 첫 관리자
say "6/6 사용자 확인"
# server 패키지를 $APP_DIR 에서 불러오도록 그 폴더에서 실행한다
manage() { (cd "$APP_DIR" && sudo -u "$APP_USER" env HANA_DATA_DIR="$DATA_DIR" "$APP_DIR/venv/bin/python" -m server.manage "$@"); }
if manage users | grep -q "사용자가 없습니다"; then
  echo "아직 사용자가 없습니다. 관리자 계정을 만듭니다."
  # 파이프로 실행돼도 키보드 입력을 받도록 /dev/tty 에서 읽는다
  read -r -p "관리자 아이디 (영문): " ADMIN_ID </dev/tty
  read -r -p "화면에 보일 이름: " ADMIN_NAME </dev/tty
  manage adduser "$ADMIN_ID" --name "${ADMIN_NAME:-$ADMIN_ID}" --super
else
  manage users
fi

cat <<EOF

============================================================
 설치 완료
 접속 주소:  $SITE_URL/
$( [ -z "$DOMAIN" ] && echo " (자체 인증서라 첫 접속 때 '안전하지 않음' 경고가 뜹니다 → 고급 → 계속 진행)" )

 부서원 추가: 사이트의 '계정 관리' 화면에서 계정을 만들거나,
   부서원이 로그인 화면의 '가입 신청' 을 하면 계정 관리에서 승인합니다.
 AI 리서치를 켜려면 /etc/hana-notes.env 에 ANTHROPIC_API_KEY=... 를 넣고
   sudo systemctl restart hana-notes

 AWS 보안 그룹에서 인바운드 $HTTPS_PORT(HTTPS)$( [ "$HTTPS_PORT" = 443 ] && echo "과 80(HTTP)" ) 포트를 열어야 접속됩니다.
============================================================
EOF
