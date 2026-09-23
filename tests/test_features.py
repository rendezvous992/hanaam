# -*- coding: utf-8 -*-
"""업무공간 서버 실동작 확인 — 계정생성·계정관리·녹음/받아쓰기·섹터·DART.
SQLite 로 진짜 서버를 띄우고(TestClient) 실제 HTTP 요청을 보낸다."""
import os, shutil, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

TMP = tempfile.mkdtemp(prefix="hana-e2e-")
os.environ["HANA_DATA_DIR"] = TMP
os.environ["HANA_SETUP_CODE"] = "letmein"
for k in ("DATABASE_URL", "POSTGRES_URL", "VERCEL", "ANTHROPIC_API_KEY", "XAI_API_KEY",
          "DART_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "STT_BASE_URL", "STT_API_KEY"):
    os.environ.pop(k, None)
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

# 가짜 받아쓰기 서버
CALLS = []


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        CALLS.append(self.rfile.read(int(self.headers["Content-Length"])))
        p = '{"text": "오늘 미팅에서 3분기 매출은 전년 대비 20% 늘었다고 했습니다. 설비 증설은 내년 상반기 마무리 예정입니다."}'.encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(p)))
        self.end_headers()
        self.wfile.write(p)


srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["STT_BASE_URL"] = "http://127.0.0.1:%d/v1" % srv.server_address[1]
os.environ["STT_API_KEY"] = "k"

from starlette.testclient import TestClient
from server.app import app

ok = fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS", name)
    else:
        fail += 1
        print("  FAIL", name, "->", extra)


J = {"X-Hana": "1"}
c = TestClient(app, base_url="http://test")

print("")
print("[1] 계정 생성 (첫 가입자 = 최고 관리자, 설정 코드 필요)")
r = c.get("/api/signup-info")
check("가입 화면 정보", r.status_code == 200 and r.json()["firstUser"] and r.json()["needsCode"], r.text)
r = c.post("/api/signup", json={"username": "boss", "displayName": "김대표", "password": "password123"}, headers=J)
check("설정 코드 없으면 거절", r.status_code == 403, r.text)
r = c.post("/api/signup", json={"username": "boss", "displayName": "김대표", "password": "short", "setupCode": "letmein"}, headers=J)
check("짧은 비밀번호 거절", r.status_code == 400, r.text)
r = c.post("/api/signup", json={"username": "boss", "displayName": "김대표", "email": "boss@x.com",
                                "department": "리서치본부", "password": "password123", "setupCode": "letmein"}, headers=J)
check("첫 가입 성공", r.status_code == 201 and r.json()["first"] and r.json()["status"] == "active", r.text)
r = c.post("/api/signup", json={"username": "kim", "displayName": "김연구", "password": "password123"}, headers=J)
check("두번째 가입은 승인 대기", r.status_code == 201 and r.json()["status"] == "pending", r.text)
r = c.post("/api/signup", json={"username": "kim", "displayName": "중복", "password": "password123"}, headers=J)
check("아이디 중복 거절", r.status_code == 409, r.text)

print("")
print("[2] 로그인 · 세션")
r = c.post("/api/login", json={"username": "kim", "password": "password123"}, headers=J)
check("승인 전 로그인 막힘", r.status_code == 403 and "승인" in r.json()["detail"], r.text)
r = c.post("/api/login", json={"username": "boss", "password": "wrong"}, headers=J)
check("틀린 비밀번호 거절", r.status_code == 401, r.text)
r = c.post("/api/login", json={"username": "boss", "password": "password123"}, headers=J)
check("로그인 성공", r.status_code == 200, r.text)
check("세션 쿠키 발급", "hana_session" in c.cookies)
me = c.get("/api/me").json()
check("내 정보 = 최고 관리자", me["role"] == "super" and me["displayName"] == "김대표", me)
check("최고 관리자는 모든 권한", "ai_research" in me["permissions"] and "portfolio" in me["permissions"], me["permissions"])
r = c.post("/api/notes", json={"company": "x", "category": "single", "date": "2026-09-23", "title": "t"})
check("전용 헤더 없는 쓰기 = CSRF 차단", r.status_code == 403, r.text)

print("")
print("[3] 계정 관리 (승인·권한·본부·임시 비밀번호)")
users = c.get("/api/admin/users").json()["users"]
kim = [u for u in users if u["username"] == "kim"][0]
check("가입 신청이 목록에 보임", kim["status"] == "pending", kim)
r = c.post("/api/admin/users/%d/approve" % kim["id"], json={}, headers=J)
check("가입 승인", r.status_code == 200, r.text)
r = c.put("/api/admin/users/%d" % kim["id"], json={"permissions": ["ai_research", "portfolio"], "department": "주식운용본부"}, headers=J)
check("탭 권한·본부 저장", r.status_code == 200, r.text)
kim2 = [u for u in c.get("/api/admin/users").json()["users"] if u["username"] == "kim"][0]
check("권한 반영", sorted(kim2["permissions"]) == ["ai_research", "portfolio"], kim2)
check("본부 반영", kim2["department"] == "주식운용본부", kim2)
r = c.post("/api/admin/users", json={"username": "park", "displayName": "박주임", "department": "리서치본부"}, headers=J)
temppw = r.json().get("tempPassword", "")
check("임시 비밀번호로 계정 생성", r.status_code == 201 and len(temppw) >= 8, r.text)
r = c.put("/api/admin/departments", json={"departments": ["리서치본부", "주식운용본부", "대체투자본부"]}, headers=J)
check("본부 목록 편집", r.status_code == 200, r.text)
check("가입 화면에 본부 반영", "대체투자본부" in c.get("/api/signup-info").json()["departments"])
sessions = c.get("/api/admin/sessions").json()
check("접속 중인 세션 조회", isinstance(sessions, list) and len(sessions) >= 1, sessions)

print("")
print("[4] 임시 비밀번호 -> 첫 로그인 시 비밀번호 변경 강제")
c2 = TestClient(app, base_url="http://test")
r = c2.post("/api/login", json={"username": "park", "password": temppw}, headers=J)
check("임시 비밀번호 로그인", r.status_code == 200 and r.json()["next"].startswith("/account/"), r.text)
r = c2.get("/api/notes")
check("비번 바꾸기 전 다른 기능 차단", r.status_code == 403 and r.json().get("code") == "must_change", r.text)
r = c2.post("/api/password", json={"current": temppw, "new": "newpassword1"}, headers=J)
check("비밀번호 변경", r.status_code == 200, r.text)
check("변경 뒤 기능 열림", c2.get("/api/notes").status_code == 200)
r = c2.get("/api/admin/users")
check("일반 사용자는 계정 관리 못 봄", r.status_code == 403, r.text)

print("")
print("[5] 섹터 배분 (종목 -> WICS 26 업종)")
from server import integrations as I
check("KSIC 반도체", I.ksic_to_wics("26110") == "반도체", I.ksic_to_wics("26110"))
check("KSIC 의약품 -> 건강관리", I.ksic_to_wics("21102") == "건강관리", I.ksic_to_wics("21102"))
check("KSIC 은행", I.ksic_to_wics("64110") == "은행", I.ksic_to_wics("64110"))
check("KSIC 자동차", I.ksic_to_wics("30110") == "자동차", I.ksic_to_wics("30110"))
check("KSIC 조선", I.ksic_to_wics("31111") == "조선", I.ksic_to_wics("31111"))
check("모르는 코드는 빈값", I.ksic_to_wics("99999") == "")
check("업종 26개", len(I.WICS26) == 26, len(I.WICS26))
r = c.post("/api/sectors/auto", json={"companies": ["삼성전자"]}, headers=J)
check("키 없으면 이유를 알려 줌", r.status_code == 200 and "DART_API_KEY" in r.json().get("detail", ""), r.text)
r = c.post("/api/c/company-sectors", json={"company": "삼성전자", "sector": "반도체"}, headers=J)
check("섹터 저장", r.status_code == 201, r.text)
rows = c.get("/api/c/company-sectors").json()
check("섹터 조회", len(rows) == 1 and rows[0]["sector"] == "반도체", rows)

print("")
print("[6] 녹음 저장 -> 받아쓰기 -> 본문 반영")
note = c.post("/api/notes", json={"company": "삼성전자", "ticker": "005930", "category": "group", "type": "NDR",
                                  "date": "2026-09-23", "title": "삼성전자 NDR", "body": ""}, headers=J).json()
check("녹음 노트 생성", "id" in note, note)
audio = b"OggS" + os.urandom(200000)
up = c.post("/api/blobs/start", json={"name": "녹음_20260923.webm", "size": len(audio), "type": "audio/webm"}, headers=J).json()
check("업로드 시작", "id" in up and up["chunkSize"] > 0, up)
r = c.put("/api/blobs/%s/chunks/0" % up["id"], content=audio, headers=J)
check("조각 업로드", r.status_code == 200, r.text)
r = c.post("/api/blobs/%s/finish" % up["id"], json={}, headers=J)
check("업로드 완료", r.status_code == 200, r.text)
r = c.post("/api/notes/%d/files" % note["id"], json={"blobId": up["id"], "kind": "audio", "duration": 930}, headers=J)
check("노트에 녹음 붙이기", r.status_code == 201 and r.json()["duration"] == 930, r.text)
fid = r.json()["id"]
r = c.get("/api/blobs/%s" % fid, headers={"Range": "bytes=0-99"})
check("녹음 되받기(Range 재생)", r.status_code == 206 and r.content == audio[:100], r.status_code)
st = c.get("/api/integrations").json()
check("받아쓰기 연결됨으로 보고", st["stt"] is True and st["sttMaxMb"] == 24, st)
r = c.post("/api/ai/transcribe", json={"fileId": fid}, headers=J)
check("받아쓰기 성공", r.status_code == 200 and "3분기 매출" in r.json()["text"], r.text[:300])
check("녹음 바이트가 그대로 전달됨", any(audio[:50] in b for b in CALLS), len(CALLS))
r2 = c.post("/api/ai/transcribe", json={"fileId": "0" * 32}, headers=J)
check("없는 녹음은 404", r2.status_code == 404, r2.text)
r3 = c.post("/api/ai/transcribe", json={"fileId": fid, "summarize": 1}, headers=J)
check("요약 키 없으면 받아쓰기만 돌려줌", r3.status_code == 200 and "summary" not in r3.json(), list(r3.json()))
saved = c.put("/api/notes/%d" % note["id"], json=dict(note, body=r.json()["text"]), headers=J)
check("받아쓴 글을 본문에 저장", saved.status_code == 200 and "3분기 매출" in saved.json()["body"], saved.text[:200])

print("")
print("[7] DART IR 불러오기")
r = c.get("/api/dart/ir/status")
check("DART 키 없으면 상태로 알림", r.status_code in (200, 503), r.text[:200])
r = c.post("/api/dart/ir/sync", json={}, headers=J)
check("키 없이 부르면 안내", r.status_code == 503 and "DART_API_KEY" in r.json()["detail"], r.text[:200])
xml = ("<TABLE><TR><TD>일 시</TD><TD>2026년 10월 15일 14:00 ~ 16:00</TD></TR>"
       "<TR><TD>장 소</TD><TD>여의도 콘래드호텔</TD></TR><TR><TD>대 상</TD><TD>기관투자자</TD></TR>"
       "<TR><TD>방 법</TD><TD>미래에셋증권 주관 NDR</TD></TR><TR><TD>목 적</TD><TD>3분기 실적 설명회</TD></TR></TABLE>")
info = I.parse_ir_doc(xml)
check("공시 원문에서 개최일", info["date"] == "2026-10-15", info)
check("시작 시각", info["time"] == "14:00", info)
check("끝 시각", info["endTime"] == "16:00", info)
check("장소", info["place"] == "여의도 콘래드호텔", info)
check("목적", info["purpose"] == "3분기 실적 설명회", info)
check("NDR 로 분류", I.ir_event_type("미래에셋증권 주관 NDR") == "ndr")
check("콥데이로 분류", I.ir_event_type("코퍼레이트데이 Corporate Day") == "corp_day")
check("주관 증권사 추출", "미래에셋증권" in I.BROKER_RE.findall(info["method"]), info["method"])
ev = {"id": "x", "type": "ndr", "title": "3분기 실적 설명회", "companies": "삼성전자", "date": "2026-10-15", "time": "14:00", "source": "dart"}
r = c.post("/api/c/ir-events", json=ev, headers=J)
check("IR 캘린더에 일정 저장", r.status_code == 201, r.text)
check("IR 캘린더 조회", len(c.get("/api/c/ir-events").json()) == 1)

print("")
print("[8] 구글 캘린더 구독 · 로그아웃")
r = c.post("/api/calendar-link", json={}, headers=J)
check("구독 주소 발급", r.status_code == 200 and ".ics" in r.json().get("url", ""), r.text)
token = r.json()["url"].rsplit("/", 1)[-1].replace(".ics", "")
feed = c.get("/calendar/feed/%s.ics" % token)
check("ICS 피드 열림(로그인 없이)", feed.status_code == 200 and "BEGIN:VCALENDAR" in feed.text, feed.status_code)
check("일정이 피드에 들어감", "20261015" in feed.text, feed.text[:400])
r = c.post("/api/logout", json={}, headers=J)
check("로그아웃", r.status_code == 200)
check("로그아웃 뒤 차단", c.get("/api/me").status_code == 401)

srv.shutdown()
shutil.rmtree(TMP, ignore_errors=True)
print("")
print("==== %d passed, %d failed ====" % (ok, fail))
sys.exit(1 if fail else 0)
