"""자동 받아쓰기(STT) — 녹음 파일을 글로 옮긴다.

OpenAI 호환 `/audio/transcriptions` 를 표준 라이브러리로 부른다. 키는 환경변수로 넣는다.

  OPENAI_API_KEY   https://platform.openai.com  (모델 기본 whisper-1)
  GROQ_API_KEY     https://console.groq.com     (모델 기본 whisper-large-v3-turbo, 무료 한도 있음)
  STT_BASE_URL     (선택) 다른 OpenAI 호환 서버를 쓸 때. STT_API_KEY 와 함께 넣는다
  STT_MODEL        (선택) 모델 이름 직접 지정
  STT_LANGUAGE     (선택) 기본 ko

키가 없으면 화면은 브라우저 실시간 받아쓰기(Web Speech API)만 쓴다.
"""

from __future__ import annotations

import json
import mimetypes
import os
import secrets
import urllib.error
import urllib.request
from typing import Any, Optional

UA = "Mozilla/5.0 (compatible; hana-workspace/1.0)"

# OpenAI·Groq 모두 업로드 한도가 25MB 다. 여유를 두고 자른다.
MAX_AUDIO_BYTES = 24 * 1024 * 1024


class SttError(Exception):
    pass


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def stt_config() -> Optional[dict[str, str]]:
    """쓸 수 있는 받아쓰기 서버 설정. 없으면 None."""
    if _env("STT_API_KEY") and _env("STT_BASE_URL"):
        return {
            "base": _env("STT_BASE_URL").rstrip("/"),
            "key": _env("STT_API_KEY"),
            "model": _env("STT_MODEL") or "whisper-1",
            "name": "STT",
        }
    if _env("OPENAI_API_KEY"):
        return {
            "base": "https://api.openai.com/v1",
            "key": _env("OPENAI_API_KEY"),
            "model": _env("STT_MODEL") or "whisper-1",
            "name": "Whisper",
        }
    if _env("GROQ_API_KEY"):
        return {
            "base": "https://api.groq.com/openai/v1",
            "key": _env("GROQ_API_KEY"),
            "model": _env("STT_MODEL") or "whisper-large-v3-turbo",
            "name": "Groq Whisper",
        }
    return None


def stt_ready() -> bool:
    return stt_config() is not None


def stt_provider() -> str:
    cfg = stt_config()
    return cfg["name"] if cfg else ""


def _guess_mime(filename: str, mime: str) -> str:
    if mime and "/" in mime:
        return mime.split(";")[0].strip()
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"


# 받아쓰기 서버가 받아 주는 확장자 (OpenAI·Groq 공통)
ALLOWED_EXT = ("mp3", "mp4", "m4a", "wav", "webm", "ogg", "oga", "flac", "mpeg", "mpga")
# 확장자가 없거나 낯설 때 mime 으로 고른다
MIME_EXT = [("audio/mpeg", "mp3"), ("audio/mp3", "mp3"), ("audio/mp4", "m4a"), ("audio/aac", "m4a"), ("audio/x-m4a", "m4a"),
            ("video/mp4", "mp4"), ("audio/wav", "wav"), ("audio/x-wav", "wav"), ("audio/flac", "flac"),
            ("audio/ogg", "ogg"), ("audio/opus", "ogg"), ("audio/webm", "webm"), ("video/webm", "webm")]


def _safe_name(filename: str, mime: str = "") -> str:
    """서버가 확장자로 형식을 가리므로 확장자는 남기고 나머지는 ASCII 로 바꾼다."""
    name = (filename or "audio.webm").replace("\\", "/").split("/")[-1]
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext in ALLOWED_EXT:
        return "audio." + ext
    base = (mime or "").split(";")[0].strip().lower()
    for m, e in MIME_EXT:
        if base == m:
            return "audio." + e
    return "audio.webm"


def _multipart(fields: dict[str, str], filename: str, mime: str, data: bytes) -> tuple[bytes, str]:
    """multipart/form-data 본문을 만든다 (파일 하나 + 문자열 필드들)."""
    boundary = "----hana" + secrets.token_hex(16)
    out = bytearray()
    for key, value in fields.items():
        if value is None or value == "":
            continue
        out += f"--{boundary}\r\n".encode()
        out += f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode()
        out += str(value).encode("utf-8") + b"\r\n"
    out += f"--{boundary}\r\n".encode()
    out += f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
    out += f"Content-Type: {mime}\r\n\r\n".encode()
    out += data + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def transcribe_audio(data: bytes, filename: str = "audio.webm", mime: str = "", language: str = "", timeout: float = 240) -> tuple[str, str]:
    """녹음 바이트 → (받아쓴 글, 쓴 서비스 이름)."""
    cfg = stt_config()
    if cfg is None:
        raise SttError("자동 받아쓰기가 연결되지 않았습니다. 관리자가 OPENAI_API_KEY 또는 GROQ_API_KEY 를 넣어야 합니다.")
    if not data:
        raise SttError("녹음 파일이 비어 있습니다.")
    if len(data) > MAX_AUDIO_BYTES:
        raise SttError(
            f"녹음이 너무 큽니다 ({len(data) // 1024 // 1024}MB). 받아쓰기는 {MAX_AUDIO_BYTES // 1024 // 1024}MB 까지만 됩니다. "
            "녹음 화면의 실시간 받아쓰기를 쓰거나 파일을 나눠 올려 주세요."
        )
    name = _safe_name(filename, mime)
    body, content_type = _multipart(
        {
            "model": cfg["model"],
            "language": (language or _env("STT_LANGUAGE") or "ko"),
            "response_format": "json",
            "temperature": "0",
        },
        name,
        _guess_mime(filename, mime),
        data,
    )
    req = urllib.request.Request(
        cfg["base"] + "/audio/transcriptions",
        data=body,
        method="POST",
        headers={"Authorization": "Bearer " + cfg["key"], "Content-Type": content_type, "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (정해진 https 주소만 부른다)
            payload: Any = json.loads(res.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        if e.code in (401, 403):
            raise SttError("받아쓰기 API 키가 올바르지 않습니다. 관리자에게 키를 확인해 달라고 해 주세요.")
        if e.code == 413:
            raise SttError("녹음 파일이 받아쓰기 서버의 한도를 넘었습니다. 나눠서 올려 주세요.")
        if e.code == 429:
            raise SttError("받아쓰기 사용량이 잠시 많거나 크레딧이 부족합니다. 잠시 뒤 다시 시도해 주세요.")
        raise SttError(f"받아쓰기 오류({e.code}): {detail}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise SttError(f"받아쓰기 서버에 연결하지 못했습니다. ({type(e).__name__})")
    text = str((payload or {}).get("text") or "").strip()
    if not text:
        raise SttError("녹음에서 말소리를 찾지 못했습니다. 마이크 입력을 확인해 주세요.")
    return text, cfg["name"]
