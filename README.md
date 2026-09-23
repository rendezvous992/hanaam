# 업무공간

부서용 업무 도구입니다. 홈, IR 캘린더, 미확정 일정(NDR), 경제·기업 이벤트 캘린더, 노트, AI 리서치, 아침회의,
운용 현황, 개선요청, 시장, 포트폴리오 분석, 종목 분석·발굴, Setting, 계정 관리, 내 정보 화면이 있습니다.

로그인·회원가입(관리자 승인)·등급·본부·탭 권한을 갖춘 **서버 모드**로 쓰는 것이 기본이고,
서버 없이 파일만 열어도 각 브라우저에 저장하며 동작합니다(**브라우저 저장 모드**).

## 1) Vercel 에 올리기 (권장)

GitHub 에 푸시하면 Vercel 이 자동으로 배포합니다. 데이터베이스(Neon Postgres)를 붙이면 부서원이 같은 데이터를 함께 씁니다.

1. Vercel → **Add New… → Project** → `hanaam` 레포 **Import** → Framework Preset **Other** → **Deploy**
   (`vercel.json` 에 빌드·함수·주기 실행 설정이 들어 있어 따로 바꿀 것이 없습니다.)
2. 프로젝트 → **Storage** 탭 → **Create Database → Neon (Postgres)** → 만들고 이 프로젝트에 **Connect**
   → `DATABASE_URL` 등이 환경변수로 자동 추가됩니다.
3. 프로젝트 → **Settings → Environment Variables** 에 추가 (Production·Preview 모두)

   | 이름 | 필수 | 내용 |
   | --- | --- | --- |
   | `HANA_SETUP_CODE` | 권장 | 첫 가입자(=최고 관리자)만 아는 코드. 아무나 먼저 가입해 관리자가 되는 것을 막습니다 |
   | `ANTHROPIC_API_KEY` | AI 리서치 | https://console.anthropic.com 에서 발급. 없으면 AI 리서치가 노트 검색 결과만 보여 줍니다 |
   | `CRON_SECRET` | 예약 리서치 | 아무 긴 문자열. Vercel 이 10분마다 예약 작업을 깨울 때 확인용 |
   | `DART_API_KEY` | 선택 | https://opendart.fss.or.kr 무료 발급 — 종목 분석의 공시, IR 공시 목록 |
   | `EODHD_API_KEY` | 선택 | https://eodhd.com — 경제 캘린더 자동 일정 |
   | `HANA_AI_MODEL` | 선택 | AI 모델 (기본 `claude-opus-5`) |

4. **Deployments → 최근 배포 → Redeploy** (환경변수는 다시 배포해야 반영)
5. 사이트 주소 → `/signup` 에서 첫 계정을 만들면 **최고 관리자**가 됩니다. 이후 가입 신청은 **계정 관리**에서 승인합니다.

> DB 를 연결하지 않으면 로그인 없이 브라우저 저장 모드로 뜹니다(테스트용).
> 파일(녹음·발표 자료)은 3MB 조각으로 DB 에 저장합니다. Neon 무료 용량(0.5GB)을 넘으면 요금제를 올려 주세요.

## 2) 설치형 서버 (AWS EC2 등)

[deploy/README.md](deploy/README.md) — `sudo bash deploy/setup.sh` 한 번으로 HTTPS·자동 시작·매일 백업까지 설치합니다.
데이터는 SQLite(`data/notes.db`) 에 저장하며, `DATABASE_URL` 을 주면 Postgres 를 씁니다. 키는 `/etc/hana-notes.env` 에 넣습니다.

내 PC 에서 서버 모드로 써 보기:

```bash
python3 -m venv venv && venv/bin/pip install -r server/requirements.txt
venv/bin/uvicorn server.app:app --port 8000
# http://localhost:8000/signup 에서 첫 계정(최고 관리자) 만들기
```

## 3) 서버 없이 (혼자 써 보기)

```bash
python3 -m http.server 8000     # http://localhost:8000/
```

데이터가 **지금 브라우저에만** 저장됩니다. 내 정보 화면에서 백업(.json)을 내려받아 다른 PC 로 옮길 수 있습니다.

## 회원·권한

| 등급 | 할 수 있는 일 |
| --- | --- |
| 최고 관리자 | 모든 기능, 계정 관리자 지정, 본부 목록 편집 (첫 가입자) |
| 계정 관리자 | 일반 사용자 가입 승인·계정 만들기(임시 비밀번호)·본부·탭 권한·비밀번호 초기화·사용 중지·삭제, 세션 종료 |
| 일반 | 기본 화면 + 받은 탭 권한 |

탭·기능 권한: 포트폴리오 분석, AI 리서치, 워크로드, 개발자 탭, 변경사항 추가, 개선요청 처리, 노트 통계.
권한이 없으면 메뉴가 숨겨지고, 주소를 직접 쳐도 서버가 막습니다. 임시 비밀번호로 처음 로그인하면 비밀번호를 바꿔야 다른 화면을 쓸 수 있습니다.

명령으로 관리하기: `python -m server.manage adduser <아이디> --super|--admin`, `passwd`, `deluser`, `users`, `backup`

## 구성

| 경로 | 내용 |
| --- | --- |
| `index.html`, `<화면>/index.html` | 화면 (원본 마크업) |
| `<화면>/static/*.js` | 화면 동작 |
| `static/shell.js` | 사이드바·시계·토스트·로그인 사용자·권한별 메뉴 |
| `static/kit.js` | 공용: 저장소(서버/브라우저), 파일 조각 업로드, 모달, 날짜(KST), CSV |
| `server/app.py` | 로그인·가입·계정 관리·노트·데이터 모음·파일·캘린더 구독(ICS) API |
| `server/integrations.py` | AI 리서치(Claude), 예약 리서치, 시세, DART, 경제지표 |
| `server/db.py` | SQLite / Postgres 연결과 테이블 |
| `api/index.py`, `vercel.json`, `scripts/build-public.mjs` | Vercel 배포 |
| `deploy/` | 설치형 서버 스크립트 |
