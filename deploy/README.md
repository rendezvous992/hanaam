# AWS에 설치하기 (부서 공용 서버)

EC2 서버 한 대에 설치하면, 부서원들이 각자 아이디로 로그인해서 **같은 노트를 함께** 보고 씁니다.
설치는 스크립트 한 번이면 끝나고, 30분 정도 걸립니다.

```
부서원 브라우저 ──HTTPS──▶ EC2 [ Caddy(HTTPS) → 노트 서버(Python) → SQLite + 녹음·첨부 파일 ]
```

---

## 0. 준비물

| 항목 | 권장 |
| --- | --- |
| EC2 운영체제 | **Ubuntu 24.04 / 22.04** 또는 **Amazon Linux 2023** |
| 인스턴스 크기 | 부서원 10~20명이면 `t3.small` 정도로 충분 (`t3.micro`도 동작) |
| 디스크 | 30GB 이상 (녹음 1시간 ≈ 30MB 안팎) |
| 고정 IP | **탄력적 IP(Elastic IP)** 를 붙여 두기. 안 붙이면 서버를 껐다 켤 때 주소가 바뀝니다 |
| 도메인 | 없어도 됩니다. 있으면 브라우저 경고 없이 쓸 수 있습니다 (5번 참고) |

> 회사 보안 규정상 사내 정보를 외부 클라우드에 둘 때 승인이 필요한지 먼저 확인해 주세요.

## 1. 보안 그룹(방화벽) 열기

AWS 콘솔 → **EC2 → 인스턴스 → 내 인스턴스 → 보안 → 보안 그룹 → 인바운드 규칙 편집**

| 유형 | 포트 | 소스 |
| --- | --- | --- |
| HTTPS | 443 | 가능하면 **회사 IP 대역만** (모르면 `0.0.0.0/0`) |
| HTTP | 80 | 443과 같게 (HTTPS로 넘겨주는 용도) |
| SSH | 22 | 내 IP (아래 Instance Connect를 쓰면 AWS가 안내하는 대로) |

## 2. 서버에 접속

AWS 콘솔 → EC2 → 인스턴스 선택 → **연결** → **EC2 Instance Connect** 탭 → **연결**
브라우저 안에 까만 터미널 창이 열리면 됩니다.

## 3. 코드 내려받기

레포가 Private이면 GitHub **토큰**이 필요합니다.

1. GitHub → 오른쪽 위 프로필 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. Repository access: **Only select repositories → hanaam**, Permissions: **Contents: Read-only** → 생성 후 토큰 복사

터미널에서:

```bash
# git 설치 (Ubuntu)
sudo apt-get update && sudo apt-get install -y git
# git 설치 (Amazon Linux)
sudo dnf install -y git

git clone https://github.com/rendezvous992/hanaam.git
# Username: rendezvous992
# Password: (복사한 토큰 붙여넣기 — 화면에 안 보여도 입력되고 있습니다)
cd hanaam
```

## 4. 설치

```bash
sudo bash deploy/setup.sh
```

같은 서버에서 **이미 다른 사이트가 443 포트를 쓰고 있으면** 설치 스크립트가 멈추고 알려 줍니다.
기존 사이트는 그대로 두고 다른 포트로 설치하려면 `--port`를 붙이고, 보안 그룹에서 그 포트(예: 8443)를 여세요.

```bash
sudo bash deploy/setup.sh --port 8443    # 접속: https://<EC2 공인 IP>:8443/notes/
```

git clone 없이 한 번에 받아서 설치하려면 (업데이트도 같은 명령):

```bash
curl -fsSL https://raw.githubusercontent.com/rendezvous992/hanaam/HEAD/deploy/install.sh -o install.sh
sudo bash install.sh                            # 레포가 Public 일 때
sudo GITHUB_TOKEN=<토큰> bash install.sh        # 레포가 Private 일 때 (토큰은 3번 참고)
```

> Private 레포라면 `raw.githubusercontent.com` 주소도 토큰이 필요합니다. 이때는 3번처럼 `git clone` 후 `sudo bash deploy/setup.sh`가 더 간단합니다.

끝나갈 때 **관리자 아이디 · 이름 · 비밀번호**를 물어봅니다. 마지막에 접속 주소가 나옵니다.

```
 접속 주소:  https://<EC2 공인 IP>/notes/
```

처음 접속하면 **"연결이 비공개로 설정되어 있지 않습니다"** 경고가 뜹니다 (자체 인증서라서).
**고급 → (주소)(으)로 이동**을 한 번 누르면 이후로는 그냥 열립니다.
이 경고를 없애려면 5번처럼 도메인을 연결하세요.

## 5. (선택) 도메인 연결 — 경고 없는 정식 HTTPS

1. 가진 도메인의 DNS에서 `notes.회사도메인` 같은 이름의 **A 레코드**를 EC2 탄력적 IP로 지정
2. 몇 분 뒤 서버에서:

```bash
cd ~/hanaam && sudo bash deploy/setup.sh notes.회사도메인
```

인증서(Let's Encrypt)는 자동으로 발급·갱신됩니다. 80·443 포트가 열려 있어야 합니다.

## 6. 부서원 관리

서버 터미널에서 실행합니다. (앞부분은 항상 같습니다)

```bash
cd /opt/hana-notes
M="sudo -u hana env HANA_DATA_DIR=/var/lib/hana-notes venv/bin/python -m server.manage"

$M adduser kim.analyst --name 김분석        # 부서원 추가 (비밀번호를 물어봄)
$M adduser lee.lead --name 이팀장 --admin   # 관리자 추가
$M users                                    # 목록
$M passwd kim.analyst                       # 비밀번호 초기화
$M deluser kim.analyst                      # 삭제 (쓴 노트는 남음)
```

- 부서원은 로그인 후 왼쪽 아래 **내 이름**을 눌러 비밀번호를 바꿀 수 있습니다.
- 노트 **수정**은 모두가, **삭제**는 등록한 사람과 관리자만 할 수 있습니다.
- 로그인 5번 실패하면 그 아이디는 10분 동안 막힙니다.

## 7. 업데이트 (코드가 바뀌었을 때)

```bash
cd ~/hanaam && git pull && sudo bash deploy/setup.sh
```

노트와 파일(`/var/lib/hana-notes`)은 그대로 남습니다. 도메인을 쓰고 있다면 뒤에 도메인을 다시 붙여 주세요.

## 8. 백업

- 매일 새벽 3시 30분(한국 시간)에 `/var/lib/hana-notes/backups/`로 자동 백업하고, **14일치**를 보관합니다.
- 서버 자체가 고장 나는 경우에 대비해 AWS 콘솔의 **EBS 스냅샷(수명 주기 관리자)** 도 켜 두시길 권합니다.
- 지금 바로 백업: `$M backup`

## 9. 문제가 생기면

```bash
sudo systemctl status hana-notes caddy     # 둘 다 active (running) 이어야 정상
sudo journalctl -u hana-notes -n 50         # 노트 서버 기록
sudo journalctl -u caddy -n 50              # HTTPS 서버 기록
sudo systemctl restart hana-notes caddy     # 재시작
```

| 증상 | 확인할 것 |
| --- | --- |
| 접속이 아예 안 됨 | 보안 그룹 443/80 인바운드, 인스턴스 실행 중인지 |
| 서버를 껐다 켰더니 주소가 바뀜 | 탄력적 IP를 붙이고 `sudo bash deploy/setup.sh` 다시 실행 |
| 녹음 버튼이 안 됨 | `https://` 로 접속했는지, 브라우저 주소창 왼쪽 사이트 설정에서 마이크 허용 |
| 큰 녹음 파일 업로드 실패 | 한 파일 최대 500MB (서버 환경변수 `HANA_MAX_UPLOAD_MB`로 조정) |

## 설치되는 것 (참고)

| 경로 | 내용 |
| --- | --- |
| `/opt/hana-notes` | 프로그램 (업데이트 때마다 덮어씀) |
| `/var/lib/hana-notes/notes.db` | 노트·사용자 데이터 (SQLite) |
| `/var/lib/hana-notes/files/` | 녹음·첨부 파일 |
| `/etc/caddy/Caddyfile` | HTTPS 설정 |
| 서비스 | `hana-notes`(노트 서버), `caddy`(HTTPS), `hana-notes-backup.timer`(매일 백업) |
