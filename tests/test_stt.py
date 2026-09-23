"""server/stt.py 실동작 확인 — 표준 라이브러리만 쓰므로 fastapi 없이 돌아간다."""
import io, json, os, sys, threading, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
for k in ("STT_API_KEY", "STT_BASE_URL", "OPENAI_API_KEY", "GROQ_API_KEY", "STT_MODEL", "STT_LANGUAGE"):
    os.environ.pop(k, None)

from server import stt

ok = fail = 0
def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1; print("  PASS", name)
    else:
        fail += 1; print("  FAIL", name, extra)

print("1) 키가 없으면 꺼져 있다")
check("stt_ready False", stt.stt_ready() is False)
check("provider 빈 문자열", stt.stt_provider() == "")
try:
    stt.transcribe_audio(b"x")
    check("키 없이 부르면 SttError", False)
except stt.SttError as e:
    check("키 없이 부르면 SttError", "연결되지 않" in str(e))

print("2) 키에 따라 서버·모델이 정해진다")
os.environ["GROQ_API_KEY"] = "g-1"
check("Groq 인식", stt.stt_config()["base"].startswith("https://api.groq.com"))
check("Groq 기본 모델", stt.stt_config()["model"] == "whisper-large-v3-turbo")
os.environ["OPENAI_API_KEY"] = "o-1"
check("OpenAI 우선", stt.stt_config()["base"] == "https://api.openai.com/v1")
check("OpenAI 기본 모델", stt.stt_config()["model"] == "whisper-1")
os.environ["STT_MODEL"] = "gpt-4o-mini-transcribe"
check("STT_MODEL 우선", stt.stt_config()["model"] == "gpt-4o-mini-transcribe")
del os.environ["STT_MODEL"]

print("3) 파일 이름·형식 정리")
check("한글 파일명 → ascii + 확장자 유지", stt._safe_name("녹음_20260923.webm") == "audio.webm")
check("m4a 유지", stt._safe_name("회의.m4a") == "audio.m4a")
check("모르는 확장자 → webm", stt._safe_name("a.bin") == "audio.webm")
check("경로 제거", stt._safe_name(chr(67)+chr(58)+chr(92)+"tmp"+chr(92)+"x.mp3") == "audio.mp3")
check("mime 추정", stt._guess_mime("a.mp3", "") == "audio/mpeg")
check("mime 파라미터 제거", stt._guess_mime("a.webm", "audio/webm;codecs=opus") == "audio/webm")

print("4) 크기 제한")
try:
    stt.transcribe_audio(b"0" * (stt.MAX_AUDIO_BYTES + 1), "a.webm")
    check("25MB 초과 거절", False)
except stt.SttError as e:
    check("24MB 초과 거절", "너무 큽니다" in str(e), str(e))
try:
    stt.transcribe_audio(b"", "a.webm")
    check("빈 파일 거절", False)
except stt.SttError as e:
    check("빈 파일 거절", "비어" in str(e))

print("5) 실제 HTTP 왕복 (가짜 Whisper 서버)")
seen = {}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        seen["path"] = self.path
        seen["auth"] = self.headers.get("Authorization")
        seen["ctype"] = self.headers.get("Content-Type")
        seen["body"] = self.rfile.read(int(self.headers["Content-Length"]))
        code = int(self.headers.get("X-Force-Code", "200"))
        payload = b'{"text": "  \xec\x95\x88\xeb\x85\x95\xed\x95\x98\xec\x84\xb8\xec\x9a\x94 \xed\x85\x8c\xec\x8a\xa4\xed\x8a\xb8  "}' if code == 200 else b'{"error":"nope"}'
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d/v1" % srv.server_address[1]
for k in ("OPENAI_API_KEY", "GROQ_API_KEY"):
    os.environ.pop(k, None)
os.environ["STT_BASE_URL"] = base
os.environ["STT_API_KEY"] = "secret-key"
os.environ["STT_MODEL"] = "whisper-1"

text, provider = stt.transcribe_audio(b"RIFFfake-audio-bytes", "녹음_20260923.webm", "audio/webm;codecs=opus")
check("받아쓴 글", text == "안녕하세요 테스트", repr(text))
check("provider", provider == "STT")
check("경로", seen["path"] == "/v1/audio/transcriptions", seen.get("path"))
check("Bearer 키", seen["auth"] == "Bearer secret-key")
check("multipart boundary", "multipart/form-data; boundary=----hana" in seen["ctype"], seen.get("ctype"))
body = seen["body"]
check("model 필드", b'name="model"' in body and b"whisper-1" in body)
check("language 기본 ko", b'name="language"' in body and b"\r\n\r\nko\r\n" in body)
check("파일 필드", b'name="file"; filename="audio.webm"' in body)
check("오디오 바이트 그대로", b"RIFFfake-audio-bytes" in body)
check("boundary 가 끝맺음", body.rstrip().endswith(b"--"))

print("6) 서버 오류를 한국어로 알린다")
import urllib.request as _u
_orig = _u.Request
class ForcedCode(_orig):
    code = "401"
    def __init__(self, *a, **kw):
        kw.setdefault("headers", {})
        kw["headers"]["X-Force-Code"] = ForcedCode.code
        super().__init__(*a, **kw)
_u.Request = ForcedCode
try:
    for code, want in (("401", "키가 올바르지"), ("429", "사용량"), ("413", "한도"), ("500", "받아쓰기 오류(500)")):
        ForcedCode.code = code
        try:
            stt.transcribe_audio(b"x" * 10, "a.webm")
            check(code + " 처리", False)
        except stt.SttError as e:
            check(code + " → " + want, want in str(e), str(e))
finally:
    _u.Request = _orig
srv.shutdown()

print("\n%d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
