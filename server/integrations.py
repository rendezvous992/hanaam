"""외부 데이터 연결 — AI 리서치(Claude), 시세(네이버 금융), DART 공시, 경제지표(EODHD), 예약 리서치.

키는 환경변수로 넣는다. 키가 없으면 해당 기능은 '연결 안 됨' 으로 알려 주고,
AI 리서치는 저장된 노트 검색 결과만 돌려준다.

  ANTHROPIC_API_KEY   AI 리서치 답변
  HANA_AI_MODEL       (선택) 기본 claude-opus-5
  DART_API_KEY        DART OpenAPI (opendart.fss.or.kr 에서 무료 발급)
  EODHD_API_KEY       경제지표 일정 (eodhd.com)
  CRON_SECRET         예약 리서치를 깨우는 주기 호출(Vercel Cron) 확인용
  XAI_API_KEY         노트 요약(Grok). 있으면 요약은 Grok 으로, 없으면 Claude 로 한다
  XAI_MODEL           (선택) Grok 모델 이름, 기본 grok-4
"""

from __future__ import annotations

import io
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
from xml.etree import ElementTree

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

KST = timezone(timedelta(hours=9))
UA = "Mozilla/5.0 (compatible; hana-workspace/1.0)"


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 작은 도우미
# ---------------------------------------------------------------------------

_CACHE: dict[str, tuple[float, Any]] = {}
_CACHE_LOCK = threading.Lock()


def cached(key: str, ttl: float, fn: Callable[[], Any]) -> Any:
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
    value = fn()
    with _CACHE_LOCK:
        _CACHE[key] = (time.time() + ttl, value)
    return value


def http_get(url: str, timeout: float = 10, headers: Optional[dict[str, str]] = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (정해진 https 주소만 부른다)
        return res.read()


def http_json(url: str, timeout: float = 10, headers: Optional[dict[str, str]] = None) -> Any:
    return json.loads(http_get(url, timeout, headers).decode("utf-8", "replace"))


def _num(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "").replace("+", "").strip())
    except ValueError:
        return None


def not_connected(what: str, env: str) -> JSONResponse:
    return JSONResponse({"detail": f"{what}이(가) 연결되지 않았습니다. 관리자가 {env} 를 설정하면 쓸 수 있습니다.", "code": "not_connected"}, status_code=503)


# ---------------------------------------------------------------------------
# 노트 검색 (AI 리서치의 근거 자료)
# ---------------------------------------------------------------------------

_WORD = re.compile(r"[0-9A-Za-z가-힣]{2,}")
_STOP = {"정리", "정리해줘", "해줘", "알려줘", "관련", "대한", "내용", "자료", "그리고", "최근", "무엇", "어떻게", "핵심", "변화", "근거", "찾아", "요약", "요약해줘", "비교", "있는", "없는", "대해", "보고서", "리포트"}


def terms_of(text: str) -> list[str]:
    out: list[str] = []
    for w in _WORD.findall(text or ""):
        w = w.lower()
        # 조사 떼기 (삼성전자의 → 삼성전자)
        w2 = re.sub(r"(은|는|이|가|을|를|의|와|과|에|에서|으로|로|도|만|까지|부터)$", "", w)
        if len(w2) >= 2:
            w = w2
        if w not in _STOP and w not in out:
            out.append(w)
    return out[:12]


def search_notes(conn, question: str, limit: int = 12) -> list[dict[str, Any]]:
    terms = terms_of(question)
    rows = conn.all("SELECT id, company, ticker, category, type, author, date, title, body FROM notes ORDER BY date DESC, id DESC LIMIT 2000")
    scored = []
    for r in rows:
        company = (r["company"] or "").lower()
        title = (r["title"] or "").lower()
        body = (r["body"] or "").lower()
        score = 0.0
        for t in terms:
            if t in company or (r["ticker"] and t == str(r["ticker"]).lower()):
                score += 6
            if t in title:
                score += 3
            if t in body:
                score += 1 + min(body.count(t), 5) * 0.2
        if score > 0:
            scored.append((score, r))
    scored.sort(key=lambda x: (x[0], x[1]["date"] or ""), reverse=True)
    return [dict(r) for _, r in scored[:limit]]


def note_ref(n: dict[str, Any]) -> dict[str, Any]:
    return {"type": "note", "id": n["id"], "title": n["title"], "company": n["company"], "date": n["date"], "author": n.get("author") or ""}


# ---------------------------------------------------------------------------
# AI 리서치 (Claude)
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """당신은 한국 자산운용사 리서치 팀의 리서치 도우미입니다.
사용자는 펀드매니저·애널리스트이며, 답변은 한국어로 씁니다.

- 아래 <notes> 는 팀이 직접 남긴 미팅·IR 노트입니다. 질문과 관련 있으면 먼저 활용하고, 인용할 때는 [노트 N] 처럼 번호를 붙입니다.
- 노트에 없는 최신 정보(실적, 공시, 주가, 뉴스)는 웹 검색으로 확인하고 출처를 밝힙니다.
- 숫자는 단위와 기준 시점을 함께 적습니다. 확인하지 못한 내용은 추정이라고 분명히 적습니다.
- 표가 도움이 되면 마크다운 표를 씁니다. 제목은 ## 로 시작하고, 불필요한 서론 없이 핵심부터 씁니다.
- 투자 판단을 대신하지 말고 근거와 쟁점을 정리합니다."""


def _notes_block(notes: list[dict[str, Any]]) -> str:
    if not notes:
        return "<notes>\n(관련 노트 없음)\n</notes>"
    parts = []
    for i, n in enumerate(notes, 1):
        body = (n.get("body") or "").strip()
        if len(body) > 3000:
            body = body[:3000] + " …(생략)"
        parts.append(f'<note n="{i}" company="{n["company"]}" date="{n["date"]}" type="{n.get("type") or n.get("category")}" title="{n["title"]}">\n{body}\n</note>')
    return "<notes>\n" + "\n".join(parts) + "\n</notes>"


def _fallback_answer(question: str, notes: list[dict[str, Any]], reason: str) -> str:
    lines = [f"> {reason}", ""]
    if not notes:
        lines.append("질문과 관련된 노트를 찾지 못했습니다. 기업명이나 핵심 단어를 넣어 다시 물어봐 주세요.")
        return "\n".join(lines)
    lines.append(f"## 관련 노트 {len(notes)}건")
    lines.append("")
    lines.append("| 날짜 | 기업 | 제목 | 작성 |")
    lines.append("|---|---|---|---|")
    for n in notes:
        lines.append(f"| {n['date']} | {n['company']} | {n['title']} | {n.get('author') or ''} |")
    lines.append("")
    terms = terms_of(question)
    for i, n in enumerate(notes[:5], 1):
        body = re.sub(r"\s+", " ", n.get("body") or "").strip()
        # 검색어가 처음 나오는 곳 주변을 보여 준다
        pos = min([body.lower().find(t) for t in terms if body.lower().find(t) >= 0] or [0])
        start = max(0, pos - 80)
        snippet = body[start:start + 320]
        lines.append(f"**[노트 {i}] {n['company']} · {n['title']}** ({n['date']})")
        lines.append("")
        lines.append(("…" if start else "") + snippet + ("…" if len(body) > start + 320 else ""))
        lines.append("")
    return "\n".join(lines)


def ask_claude(question: str, history: list[dict[str, str]], notes: list[dict[str, Any]], use_web: bool = True) -> dict[str, Any]:
    import anthropic

    client = anthropic.Anthropic(api_key=_env("ANTHROPIC_API_KEY"), timeout=280.0, max_retries=1)
    model = _env("HANA_AI_MODEL") or "claude-opus-5"
    today = datetime.now(KST).strftime("%Y-%m-%d (%a)")

    messages: list[dict[str, Any]] = []
    for m in history[-10:]:
        role = m.get("role")
        content = str(m.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            if messages and messages[-1]["role"] == role:
                messages[-1]["content"] += "\n\n" + content
            else:
                messages.append({"role": role, "content": content[:20000]})
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    if messages and messages[-1]["role"] == "user":
        messages.pop()
    messages.append({"role": "user", "content": f"{_notes_block(notes)}\n\n오늘: {today} (한국 시간)\n\n질문: {question}"})

    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 5, "user_location": {"type": "approximate", "country": "KR", "timezone": "Asia/Seoul"}}] if use_web else []
    params: dict[str, Any] = dict(
        model=model,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        thinking={"type": "adaptive"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if tools:
        params["tools"] = tools

    response = None
    for _ in range(4):  # 웹 검색이 길어지면 pause_turn 으로 끊겨 오므로 이어서 부른다
        response = client.beta.messages.create(messages=messages, **params)
        if response.stop_reason != "pause_turn":
            break
        messages = messages + [{"role": "assistant", "content": response.content}]

    assert response is not None
    if response.stop_reason == "refusal":
        return {"answer": "이 질문에는 답할 수 없다는 응답을 받았습니다. 질문을 조금 바꿔 다시 시도해 주세요.", "web": [], "model": response.model}

    texts: list[str] = []
    web: list[dict[str, str]] = []
    seen: set[str] = set()
    for block in response.content:
        if block.type == "text":
            texts.append(block.text)
            for c in getattr(block, "citations", None) or []:
                url = getattr(c, "url", None)
                if url and url not in seen:
                    seen.add(url)
                    web.append({"type": "web", "url": url, "title": getattr(c, "title", None) or url})
    answer = "".join(texts).strip()
    if response.stop_reason == "max_tokens":
        answer += "\n\n> 답변이 길어 중간에 끊겼습니다. 범위를 좁혀 다시 물어봐 주세요."
    return {"answer": answer or "답변이 비어 있습니다. 다시 시도해 주세요.", "web": web, "model": response.model}


# ---------------------------------------------------------------------------
# Claude 한 번 부르기 (요약 등 짧은 작업)
# ---------------------------------------------------------------------------

def claude_text(system: str, user: str, max_tokens: int = 8000) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=_env("ANTHROPIC_API_KEY"), timeout=180.0, max_retries=1)
    response = client.beta.messages.create(
        model=_env("HANA_AI_MODEL") or "claude-opus-5",
        max_tokens=max_tokens,
        system=system,
        thinking={"type": "adaptive"},
        output_config={"effort": "medium"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        messages=[{"role": "user", "content": user}],
    )
    if response.stop_reason == "refusal":
        raise ValueError("이 내용은 처리할 수 없다는 응답을 받았습니다.")
    return "".join(b.text for b in response.content if b.type == "text").strip()


# ---------------------------------------------------------------------------
# Grok (xAI) — 노트 요약용. OpenAI 호환 chat/completions 를 표준 라이브러리로 부른다
# ---------------------------------------------------------------------------

XAI_BASE = "https://api.x.ai/v1"


class GrokError(Exception):
    pass


def _xai(method: str, path: str, body: Optional[dict[str, Any]] = None, timeout: float = 120) -> Any:
    req = urllib.request.Request(
        XAI_BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": "Bearer " + _env("XAI_API_KEY"), "Content-Type": "application/json", "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (xAI 고정 주소)
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        if e.code in (401, 403):
            raise GrokError("Grok API 키가 올바르지 않습니다. 관리자에게 XAI_API_KEY 를 확인해 달라고 해 주세요.")
        if e.code == 429:
            raise GrokError("Grok 사용량이 잠시 많거나 크레딧이 부족합니다. 잠시 뒤 다시 시도해 주세요.")
        raise GrokError(f"Grok 오류({e.code}): {detail}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise GrokError(f"Grok 서버에 연결하지 못했습니다. ({type(e).__name__})")


def _grok_models() -> list[str]:
    def load() -> list[str]:
        data = _xai("GET", "/models", timeout=20)
        ids = [m.get("id", "") for m in data.get("data", []) if isinstance(m, dict)]
        return sorted([i for i in ids if i.startswith("grok") and not re.search(r"image|vision|imagine|embed", i)], reverse=True)

    return cached("xai:models", 3600, load)


def grok_text(system: str, user: str, max_tokens: int = 6000) -> str:
    def call(model: str) -> str:
        data = _xai("POST", "/chat/completions", {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": max_tokens,
            "temperature": 0.2,
        })
        choice = (data.get("choices") or [{}])[0]
        return str((choice.get("message") or {}).get("content") or "").strip()

    model = _env("XAI_MODEL") or "grok-4"
    try:
        out = call(model)
    except GrokError as e:
        # 모델 이름이 바뀌었으면 계정에서 쓸 수 있는 grok 모델로 한 번 더 시도한다
        if "model" not in str(e).lower() or _env("XAI_MODEL"):
            raise
        models = _grok_models()
        if not models:
            raise
        out = call(models[0])
    if not out:
        raise GrokError("Grok 이 빈 답을 보냈습니다. 다시 시도해 주세요.")
    return out


def summarize_text(system: str, user: str) -> tuple[str, str]:
    """요약: Grok 키가 있으면 Grok, 없으면 Claude. (본문, 사용한 AI 이름)"""
    if _env("XAI_API_KEY"):
        return grok_text(system, user), "Grok"
    return claude_text(system, user), "Claude"


def ai_error_message(e: Exception) -> str:
    import anthropic

    if isinstance(e, GrokError):
        return str(e)

    if isinstance(e, anthropic.AuthenticationError):
        return "AI 키가 올바르지 않습니다. 관리자에게 ANTHROPIC_API_KEY 를 확인해 달라고 해 주세요."
    if isinstance(e, anthropic.RateLimitError):
        return "AI 사용량이 잠시 많습니다. 1분쯤 뒤에 다시 시도해 주세요."
    if isinstance(e, anthropic.APIStatusError):
        return f"AI 서버 오류({e.status_code})입니다."
    if isinstance(e, anthropic.APIConnectionError):
        return "AI 서버에 연결하지 못했습니다."
    return str(e) or "AI 처리 중 오류가 났습니다."


SUMMARY_PROMPT = """당신은 자산운용사 리서치 팀의 노트 정리 도우미입니다. 미팅·IR·기사 원문을 받아 팀 노트 형식으로 정리합니다.
형식 (마크다운, 한국어):
# 한 줄 요약
## 핵심 내용
- 사실·숫자 위주 불릿 (단위·기준 시점 포함)
## Q&A
Q. 질문
A. 답변   (원문에 문답이 있을 때만)
## 투자 포인트 / 리스크
- 원문 근거가 있는 것만
원문에 없는 내용은 만들지 말고, 불확실한 것은 (확인 필요) 라고 적습니다. 서론·맺음말 없이 위 형식만 출력합니다."""


# ---------------------------------------------------------------------------
# 링크 본문 가져오기 (내부망 주소는 막는다)
# ---------------------------------------------------------------------------

import html as _html
import ipaddress
import socket
from html.parser import HTMLParser


def _public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


def _check_url(url: str) -> urllib.parse.ParseResult:
    u = urllib.parse.urlparse(url.strip())
    if u.scheme not in ("http", "https") or not u.hostname:
        raise HTTPException(400, "http:// 또는 https:// 로 시작하는 주소를 넣어 주세요.")
    if u.port not in (None, 80, 443):
        raise HTTPException(400, "이 주소는 가져올 수 없습니다.")
    if not _public_host(u.hostname):
        raise HTTPException(400, "사내망·내부 주소는 가져올 수 없습니다.")
    return u


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _PageText(HTMLParser):
    SKIP = {"script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg", "button", "iframe"}
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "tr", "section", "article", "blockquote"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_title = False
        self._skip = 0
        self._article = 0
        self.parts: list[str] = []
        self.article_parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and a.get("content"):
                self.meta.setdefault(key, a["content"])
        elif tag == "title":
            self._in_title = True
        if tag in self.SKIP:
            self._skip += 1
        if tag == "article":
            self._article += 1
        if tag in self.BLOCK:
            self.parts.append("\n")
            if self._article:
                self.article_parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        if tag == "article" and self._article:
            self._article -= 1

    def handle_data(self, data):
        if self._in_title:
            self.title += data
            return
        if self._skip:
            return
        self.parts.append(data)
        if self._article:
            self.article_parts.append(data)


def _clean_text(parts: list[str]) -> str:
    text = "".join(parts)
    lines = [re.sub(r"[ \t ]+", " ", ln).strip() for ln in text.split("\n")]
    # 너무 짧은 메뉴 조각은 버리고 문단만 남긴다
    keep = [ln for ln in lines if len(ln) >= 25 or (ln and ln[-1:] in ".다요?!")]
    return "\n".join(keep).strip()


def fetch_link(url: str) -> dict[str, Any]:
    _check_url(url)
    opener = urllib.request.build_opener(_SafeRedirect())
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
                                               "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.6"})
    with opener.open(req, timeout=10) as res:
        ctype = (res.headers.get("Content-Type") or "").lower()
        raw = res.read(3_000_001)
        final = res.geturl()
    if len(raw) > 3_000_000:
        raw = raw[:3_000_000]
    if "pdf" in ctype:
        return {"url": final, "title": final.rsplit("/", 1)[-1], "text": "", "kind": "pdf",
                "detail": "PDF 파일은 본문을 자동으로 가져오지 못합니다. 파일을 내려받아 첨부해 주세요."}
    if "html" not in ctype and "text" not in ctype:
        raise HTTPException(400, "웹 페이지(HTML)만 가져올 수 있습니다.")
    m = re.search(r"charset=([\w-]+)", ctype) or re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', raw[:4000], re.I)
    enc = (m.group(1).decode() if isinstance(m.group(1), bytes) else m.group(1)) if m else "utf-8"
    try:
        doc = raw.decode(enc, "replace")
    except LookupError:
        doc = raw.decode("utf-8", "replace")
    p = _PageText()
    p.feed(doc)
    text = _clean_text(p.article_parts) if len(_clean_text(p.article_parts)) > 200 else _clean_text(p.parts)
    title = p.meta.get("og:title") or _html.unescape(p.title).strip()
    published = p.meta.get("article:published_time") or p.meta.get("og:regdate") or p.meta.get("date") or ""
    return {
        "url": final,
        "title": title[:300],
        "description": (p.meta.get("og:description") or p.meta.get("description") or "")[:1000],
        "site": (p.meta.get("og:site_name") or urllib.parse.urlparse(final).hostname or "")[:100],
        "published": published[:40],
        "text": text[:30000],
        "kind": "html",
    }


def run_research(conn_factory, question: str, history: list[dict[str, str]]) -> dict[str, Any]:
    with conn_factory() as conn:
        notes = search_notes(conn, question + " " + " ".join(str(m.get("content", "")) for m in history[-2:] if m.get("role") == "user"))
    refs = [note_ref(n) for n in notes]
    if not _env("ANTHROPIC_API_KEY"):
        return {"answer": _fallback_answer(question, notes, "AI 가 연결되지 않아 저장된 노트에서 찾은 내용만 보여 줍니다. (관리자: ANTHROPIC_API_KEY 설정)"),
                "refs": refs, "ai": False}
    import anthropic

    try:
        out = ask_claude(question, history, notes)
    except anthropic.AuthenticationError:
        reason = "AI 키가 올바르지 않습니다. 관리자에게 ANTHROPIC_API_KEY 를 확인해 달라고 해 주세요."
    except anthropic.RateLimitError:
        reason = "AI 사용량이 잠시 많습니다. 1분쯤 뒤에 다시 시도해 주세요."
    except anthropic.APIStatusError as e:
        reason = f"AI 서버 오류({e.status_code})로 답변을 만들지 못했습니다."
    except anthropic.APIConnectionError:
        reason = "AI 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요."
    else:
        return {"answer": out["answer"], "refs": refs + out["web"], "ai": True, "model": out["model"]}
    return {"answer": _fallback_answer(question, notes, reason), "refs": refs, "ai": False, "error": reason}


# ---------------------------------------------------------------------------
# 예약 리서치 — 다음 실행 시각 계산 (한국 시간)
# ---------------------------------------------------------------------------

CADENCES = {"weekdays", "daily", "weekly", "monthly", "once", "cron"}


def _cron_field(expr: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
    for part in expr.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/", 1)
            step = int(s)
            if step < 1:
                raise ValueError("step")
        if part in ("*", ""):
            a, b = lo, hi
        elif "-" in part:
            a, b = (int(x) for x in part.split("-", 1))
        else:
            a = b = int(part)
        if a < lo or b > hi or a > b:
            raise ValueError("range")
        out.update(range(a, b + 1, step))
    return out


def parse_cron(expr: str) -> tuple[set[int], set[int], set[int], set[int], set[int], bool, bool]:
    f = expr.split()
    if len(f) != 5:
        raise ValueError("cron 은 '분 시 일 월 요일' 다섯 칸입니다.")
    minute = _cron_field(f[0], 0, 59)
    hour = _cron_field(f[1], 0, 23)
    dom = _cron_field(f[2], 1, 31)
    month = _cron_field(f[3], 1, 12)
    dow = {d % 7 for d in _cron_field(f[4], 0, 7)}
    return minute, hour, dom, month, dow, f[2] == "*", f[4] == "*"


def _last_day(d: datetime) -> int:
    nxt = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    return (nxt - timedelta(days=1)).day


def next_runs(s: dict[str, Any], after: datetime, count: int = 1) -> list[datetime]:
    """스케줄 s 의 after 이후 실행 시각 (KST aware)."""
    after = after.astimezone(KST)
    cadence = s.get("cadence") or "weekdays"
    hh, mm = 8, 0
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(s.get("time") or "08:00"))
    if m:
        hh, mm = min(int(m.group(1)), 23), min(int(m.group(2)), 59)
    out: list[datetime] = []
    if cadence == "once":
        try:
            d = datetime.strptime(str(s.get("date")), "%Y-%m-%d")
        except ValueError:
            return []
        t = d.replace(hour=hh, minute=mm, tzinfo=KST)
        return [t] if t > after else []
    if cadence == "cron":
        minute, hour, dom, month, dow, dom_star, dow_star = parse_cron(str(s.get("cron") or ""))
        day = after.replace(hour=0, minute=0, second=0, microsecond=0)
        for _ in range(800):
            wd = (day.weekday() + 1) % 7  # cron: 0=일요일
            if dom_star and dow_star:
                day_ok = True
            elif dom_star:
                day_ok = wd in dow
            elif dow_star:
                day_ok = day.day in dom
            else:
                day_ok = day.day in dom or wd in dow
            if day.month in month and day_ok:
                for h in sorted(hour):
                    for mi in sorted(minute):
                        t = day.replace(hour=h, minute=mi)
                        if t > after:
                            out.append(t)
                            if len(out) >= count:
                                return out
            day += timedelta(days=1)
        return out
    day = after.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if day <= after:
        day += timedelta(days=1)
    weekday = int(s.get("weekday") or 0)  # 0=월
    monthday = int(s.get("monthday") or 1)
    for _ in range(800):
        ok = (
            cadence == "daily"
            or (cadence == "weekdays" and day.weekday() < 5)
            or (cadence == "weekly" and day.weekday() == weekday)
            or (cadence == "monthly" and day.day == min(monthday, _last_day(day)))
        )
        if ok:
            out.append(day)
            if len(out) >= count:
                break
        day += timedelta(days=1)
    return out


def clean_schedule(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise HTTPException(400, "잘못된 요청입니다.")
    name = str(data.get("name") or "").strip()[:80]
    prompt = str(data.get("prompt") or "").strip()[:4000]
    cadence = str(data.get("cadence") or "weekdays")
    if not name or not prompt:
        raise HTTPException(400, "이름과 요청을 적어 주세요.")
    if cadence not in CADENCES:
        raise HTTPException(400, "반복 주기를 다시 골라 주세요.")
    s = {
        "name": name,
        "prompt": prompt,
        "cadence": cadence,
        "time": str(data.get("time") or "08:00")[:5],
        "weekday": int(data.get("weekday") or 0) % 7,
        "monthday": max(1, min(31, int(data.get("monthday") or 1))),
        "date": str(data.get("date") or "")[:10],
        "cron": str(data.get("cron") or "").strip()[:100],
        "enabled": bool(data.get("enabled", True)),
    }
    try:
        runs = next_runs(s, datetime.now(KST))
    except ValueError as e:
        raise HTTPException(400, f"cron 식이 올바르지 않습니다. {e}")
    if not runs and s["enabled"]:
        raise HTTPException(400, "다음 실행 시각이 없습니다. 날짜·시간을 확인해 주세요.")
    s["nextRunAt"] = runs[0].isoformat() if runs else None
    return s


# ---------------------------------------------------------------------------
# 시세 (네이버 금융 공개 조회 주소)
# ---------------------------------------------------------------------------

INDEX_CODES = {"KOSPI": "코스피", "KOSDAQ": "코스닥", "KPI200": "코스피200"}


def _naver_rows(kind: str, codes: list[str]) -> list[dict[str, Any]]:
    url = f"https://polling.finance.naver.com/api/realtime/domestic/{kind}/" + ",".join(codes)
    data = http_json(url, timeout=8)
    out = []
    for d in data.get("datas") or []:
        change = _num(d.get("compareToPreviousClosePrice"))
        direction = ((d.get("compareToPreviousPrice") or {}).get("name") or "").upper()
        if change is not None and direction in ("FALLING", "LOWER_LIMIT") and change > 0:
            change = -change
        rate = _num(d.get("fluctuationsRatio"))
        if rate is not None and change is not None and change < 0 and rate > 0:
            rate = -rate
        out.append({
            "code": d.get("itemCode") or d.get("symbolCode") or "",
            "name": d.get("stockName") or d.get("indexName") or INDEX_CODES.get(d.get("itemCode") or "", ""),
            "price": _num(d.get("closePrice")),
            "change": change,
            "changeRate": rate,
            "status": d.get("marketStatus") or "",
            "time": d.get("localTradedAt") or "",
        })
    return out


def quotes(codes: list[str]) -> list[dict[str, Any]]:
    stocks = [c for c in codes if re.fullmatch(r"[0-9A-Z]{6}", c)]
    indexes = [c for c in codes if c in INDEX_CODES]
    out: list[dict[str, Any]] = []
    for i in range(0, len(stocks), 20):
        part = stocks[i:i + 20]
        out += cached("q:" + ",".join(part), 20, lambda part=part: _naver_rows("stock", part))
    if indexes:
        out += cached("i:" + ",".join(indexes), 20, lambda: _naver_rows("index", indexes))
    return out


def stock_search(q: str) -> list[dict[str, str]]:
    url = "https://ac.stock.naver.com/ac?" + urllib.parse.urlencode({"q": q, "target": "stock"})
    data = http_json(url, timeout=6)
    out = []
    for it in data.get("items") or []:
        code = it.get("code") or ""
        if re.fullmatch(r"[0-9A-Z]{6}", code) and (it.get("nationCode") in (None, "KOR")):
            out.append({"code": code, "name": it.get("name") or "", "market": it.get("typeName") or it.get("typeCode") or ""})
    return out[:15]


# ---------------------------------------------------------------------------
# DART
# ---------------------------------------------------------------------------

def _dart_corp_codes() -> dict[str, dict[str, str]]:
    """종목코드 → {corp_code, name} (하루 캐시)."""
    def load() -> dict[str, dict[str, str]]:
        raw = http_get("https://opendart.fss.or.kr/api/corpCode.xml?" + urllib.parse.urlencode({"crtfc_key": _env("DART_API_KEY")}), timeout=30)
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            xml = z.read(z.namelist()[0])
        out: dict[str, dict[str, str]] = {}
        for el in ElementTree.fromstring(xml).iter("list"):
            stock = (el.findtext("stock_code") or "").strip()
            if stock:
                out[stock] = {"corp_code": (el.findtext("corp_code") or "").strip(), "name": (el.findtext("corp_name") or "").strip()}
        return out

    return cached("dart:corp", 86400, load)


def _dart_list(params: dict[str, str]) -> list[dict[str, Any]]:
    q = {"crtfc_key": _env("DART_API_KEY"), "page_count": "100", **params}
    data = http_json("https://opendart.fss.or.kr/api/list.json?" + urllib.parse.urlencode(q), timeout=15)
    status = data.get("status")
    if status == "013":  # 조회된 데이터 없음
        return []
    if status != "000":
        raise HTTPException(502, f"DART 오류: {data.get('message') or status}")
    return data.get("list") or []


def _disclosure(d: dict[str, Any]) -> dict[str, Any]:
    dt = d.get("rcept_dt") or ""
    return {
        "company": d.get("corp_name") or "",
        "code": d.get("stock_code") or "",
        "title": (d.get("report_nm") or "").strip(),
        "date": f"{dt[:4]}-{dt[4:6]}-{dt[6:8]}" if len(dt) == 8 else dt,
        "filed": f"{dt[:4]}-{dt[4:6]}-{dt[6:8]}" if len(dt) == 8 else dt,
        "filer": d.get("flr_nm") or "",
        "url": "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + (d.get("rcept_no") or ""),
    }


# ---------------------------------------------------------------------------
# DART 기업설명회(IR) 공시 원문 → IR 일정 (개최일·시간·목적·장소)
# ---------------------------------------------------------------------------

_DATE_RE = re.compile(r"(20\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})")
_TIME_RE = re.compile(r"(?<!\d)([01]?\d|2[0-3])\s*[:시]\s*([0-5]\d)(?!\d)")
_TAG_RE = re.compile(r"<[^>]+>")


def _cell_text(html_part: str) -> str:
    return re.sub(r"\s+", " ", _html.unescape(_TAG_RE.sub(" ", html_part))).strip()


def dart_doc_rows(xml: str) -> list[list[str]]:
    """공시 원문(XML)의 표를 행·칸 글자로 푼다."""
    rows = []
    for tr in re.findall(r"<TR\b[^>]*>(.*?)</TR>", xml, re.S | re.I):
        cells = [_cell_text(c) for c in re.findall(r"<T[DHEU]\b[^>]*>(.*?)</T[DHEU]>", tr, re.S | re.I)]
        cells = [c for c in cells if c]
        if cells:
            rows.append(cells)
    return rows


def _row_value(rows: list[list[str]], *keys: str) -> str:
    for r in rows:
        head = r[0].replace(" ", "")
        if any(k in head for k in keys):
            return " ".join(r[1:]).strip()
    return ""


def parse_ir_doc(xml: str) -> dict[str, Any]:
    rows = dart_doc_rows(xml)
    when = _row_value(rows, "일시", "개최일", "일자")
    if not when:
        m = re.search(r"일\s*시[^0-9]{0,20}(.{0,80})", _cell_text(xml))
        when = m.group(1) if m else ""
    dates = ["%s-%02d-%02d" % (y, int(mo), int(d)) for y, mo, d in _DATE_RE.findall(when)]
    times = ["%02d:%s" % (int(h), mi) for h, mi in _TIME_RE.findall(_DATE_RE.sub(" ", when))]
    return {
        "date": dates[0] if dates else "",
        "endDate": dates[-1] if len(dates) > 1 and dates[-1] != dates[0] else "",
        "time": times[0] if times else "",
        "endTime": times[1] if len(times) > 1 else "",
        "place": _row_value(rows, "장소")[:200],
        "target": _row_value(rows, "대상")[:200],
        "method": _row_value(rows, "방식", "방법")[:200],
        "purpose": (_row_value(rows, "목적") or _row_value(rows, "주요설명회내용", "내용"))[:300],
    }


def _dart_document(rcept_no: str) -> str:
    raw = http_get("https://opendart.fss.or.kr/api/document.xml?" + urllib.parse.urlencode({"crtfc_key": _env("DART_API_KEY"), "rcept_no": rcept_no}), timeout=20)
    if raw[:2] != b"PK":  # 오류는 zip 대신 짧은 XML/JSON 으로 온다
        raise ValueError(raw[:200].decode("utf-8", "replace"))
    parts = []
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        for name in z.namelist():
            data = z.read(name)
            for enc in ("utf-8", "euc-kr", "cp949"):
                try:
                    parts.append(data.decode(enc))
                    break
                except UnicodeDecodeError:
                    continue
    return "\n".join(parts)


BROKER_RE = re.compile(r"([가-힣A-Za-z]+(?:증권|투자증권|자산운용|금융투자))")


def ir_event_type(text: str) -> str:
    t = text.lower()
    if "ndr" in t or "논딜" in text:
        return "ndr"
    if "corporate day" in t or "콥데이" in text or "corp day" in t:
        return "corp_day"
    if "conference" in t or "컨퍼런스" in text or "weeks" in t or "포럼" in text:
        return "conference"
    return "ir_meeting"


def dart_ir_schedule(conn_factory, days: int = 30, budget_s: float = 200) -> dict[str, Any]:
    """최근 IR 공시를 원문까지 읽어 일정으로 만든다. 읽은 결과는 DB(dart-ir)에 남겨 다시 읽지 않는다."""
    end = datetime.now(KST)
    start = end - timedelta(days=max(1, min(days, 90)))
    listed: list[dict[str, Any]] = []
    for page in range(1, 31):
        rows = _dart_list({"bgn_de": start.strftime("%Y%m%d"), "end_de": end.strftime("%Y%m%d"), "pblntf_ty": "I", "page_no": str(page)})
        listed += [d for d in rows if "기업설명회" in (d.get("report_nm") or "")]
        if len(rows) < 100:
            break
    listed.sort(key=lambda d: d.get("rcept_no") or "")  # 오래된 공시부터 → 정정 공시가 뒤에 덮어쓴다
    with conn_factory() as conn:
        have = {r["id"]: json.loads(r["data"]) for r in conn.all("SELECT id, data FROM records WHERE collection = 'dart-ir'")}
    deadline = time.time() + budget_s
    parsed, failed, pending = [], 0, 0
    for d in listed:
        no = d.get("rcept_no") or ""
        info = have.get(no)
        if info is None:
            if time.time() > deadline:
                pending += 1
                continue
            try:
                info = parse_ir_doc(_dart_document(no))
            except Exception:  # noqa: BLE001 — 한 건 실패해도 나머지는 읽는다
                failed += 1
                continue
            disc = _disclosure(d)
            disc.pop("date", None)  # date 는 공시일이 아니라 개최일
            info.update(disc)
            info["rcept_no"] = no
            with conn_factory() as conn:
                conn.execute("INSERT INTO records(collection, id, data, created_at) VALUES ('dart-ir', ?, ?, ?)", (no, json.dumps(info, ensure_ascii=False), now_iso()))
        parsed.append(info)
    return {"items": parsed, "failed": failed, "pending": pending, "listed": len(listed)}


def sync_dart_ir(conn_factory, days: int = 30) -> dict[str, Any]:
    """IR 일정(ir-events)에 DART 일정을 넣는다. 사람이 고친 일정(dartEdited)은 덮어쓰지 않는다."""
    out = dart_ir_schedule(conn_factory, days)
    today = datetime.now(KST).strftime("%Y-%m-%d")
    added = updated = 0
    with conn_factory() as conn:
        for it in out["items"]:
            if not it.get("date") or (it.get("endDate") or it["date"]) < today:
                continue
            code = it.get("code") or it.get("company")
            rid = re.sub(r"[^A-Za-z0-9_-]", "", f"dart-{code}-{it['date']}-{(it.get('time') or 'na').replace(':', '')}")[:64]
            purpose = it.get("purpose") or ""
            broker = ", ".join(dict.fromkeys(BROKER_RE.findall(purpose + " " + (it.get("place") or "") + " " + (it.get("method") or ""))))
            ev = {
                "id": rid, "type": ir_event_type(" ".join([it.get("title", ""), purpose, it.get("method", "")])),
                "title": purpose[:120], "companies": it.get("company", ""), "brokers": broker, "location": (it.get("place") or "")[:120],
                "date": it["date"], "endDate": it.get("endDate", ""), "time": it.get("time", ""), "endTime": it.get("endTime", ""),
                "memo": "\n".join(x for x in [("대상: " + it["target"]) if it.get("target") else "", ("방식: " + it["method"]) if it.get("method") else "",
                                              "DART 공시 " + (it.get("filed") or "") + ": " + it.get("url", "")] if x),
                "source": "dart", "dartNo": it.get("rcept_no", ""), "dartUrl": it.get("url", ""), "filedAt": it.get("filed", ""),
                "createdBy": "DART", "createdAt": now_iso(),
            }
            row = conn.one("SELECT data FROM records WHERE collection = 'ir-events' AND id = ?", (rid,))
            if row is None:
                conn.execute("INSERT INTO records(collection, id, data, created_at) VALUES ('ir-events', ?, ?, ?)", (rid, json.dumps(ev, ensure_ascii=False), now_iso()))
                added += 1
            else:
                prev = json.loads(row["data"])
                if prev.get("dartEdited") or prev.get("dartNo") == ev["dartNo"]:
                    continue
                ev["createdAt"] = prev.get("createdAt", ev["createdAt"])
                conn.execute("UPDATE records SET data = ?, updated_at = ? WHERE collection = 'ir-events' AND id = ?", (json.dumps(ev, ensure_ascii=False), now_iso(), rid))
                updated += 1
        from .app import settings_set  # noqa: PLC0415 (순환 import 피하기)
        settings_set(conn, "dart-ir-sync", {"at": now_iso(), "added": added, "updated": updated, "listed": out["listed"], "failed": out["failed"], "pending": out["pending"]})
    return {"added": added, "updated": updated, "listed": out["listed"], "failed": out["failed"], "pending": out["pending"]}


# ---------------------------------------------------------------------------
# 종목 → WICS 26 업종 자동 지정 (DART 업종코드(KSIC) → WICS, 없으면 Grok)
# ---------------------------------------------------------------------------

WICS26 = ["에너지", "화학", "비철금속", "철강", "건설", "기계", "조선", "상사,자본재", "운송", "자동차", "화장품,의류", "호텔,레저", "미디어,교육",
          "소매(유통)", "필수소비재", "건강관리", "은행", "증권", "보험", "소프트웨어", "IT하드웨어", "반도체", "IT가전", "디스플레이", "통신서비스", "유틸리티"]

# 앞자리가 길게 맞는 것부터 본다 (한국표준산업분류 KSIC → WICS 26)
KSIC_WICS = [
    ("2611", "반도체"), ("2612", "반도체"), ("2621", "디스플레이"), ("262", "IT하드웨어"), ("263", "IT하드웨어"), ("264", "IT하드웨어"),
    ("265", "IT가전"), ("266", "IT하드웨어"), ("261", "반도체"), ("271", "건강관리"), ("27", "IT하드웨어"),
    ("282", "IT하드웨어"), ("285", "IT가전"), ("28", "상사,자본재"), ("29", "기계"), ("30", "자동차"), ("311", "조선"), ("31", "기계"),
    ("19", "에너지"), ("2042", "화장품,의류"), ("21", "건강관리"), ("20", "화학"), ("22", "화학"), ("23", "건설"),
    ("242", "비철금속"), ("24", "철강"), ("252", "기계"), ("25", "철강"),
    ("10", "필수소비재"), ("11", "필수소비재"), ("12", "필수소비재"), ("13", "화장품,의류"), ("14", "화장품,의류"), ("15", "화장품,의류"),
    ("16", "건설"), ("17", "화학"), ("18", "미디어,교육"), ("32", "IT가전"), ("33", "화장품,의류"),
    ("35", "유틸리티"), ("36", "유틸리티"), ("37", "유틸리티"), ("38", "유틸리티"), ("41", "건설"), ("42", "건설"), ("68", "건설"),
    ("45", "소매(유통)"), ("46", "상사,자본재"), ("47", "소매(유통)"),
    ("49", "운송"), ("50", "운송"), ("51", "운송"), ("52", "운송"),
    ("55", "호텔,레저"), ("56", "호텔,레저"), ("91", "호텔,레저"), ("75", "호텔,레저"),
    ("5811", "미디어,교육"), ("5812", "미디어,교육"), ("58", "소프트웨어"), ("59", "미디어,교육"), ("60", "미디어,교육"), ("61", "통신서비스"),
    ("62", "소프트웨어"), ("63", "소프트웨어"),
    ("641", "은행"), ("64992", "상사,자본재"), ("64", "증권"), ("65", "보험"), ("66", "증권"),
    ("7011", "건강관리"), ("70", "상사,자본재"), ("713", "미디어,교육"), ("71", "상사,자본재"), ("72", "상사,자본재"), ("73", "상사,자본재"),
    ("74", "상사,자본재"), ("85", "미디어,교육"), ("86", "건강관리"), ("90", "미디어,교육"),
]


def ksic_to_wics(code: str) -> str:
    code = re.sub(r"\D", "", code or "")
    for prefix, sector in sorted(KSIC_WICS, key=lambda x: -len(x[0])):
        if code.startswith(prefix):
            return sector
    return ""


def _norm_name(n: str) -> str:
    return re.sub(r"\s+|\(주\)|주식회사", "", str(n or "")).upper()


def _dart_name_index() -> dict[str, dict[str, str]]:
    def build() -> dict[str, dict[str, str]]:
        return {_norm_name(v["name"]): {**v, "stock_code": k} for k, v in _dart_corp_codes().items()}

    return cached("dart:byname", 86400, build)


def _dart_industry(corp_code: str) -> str:
    data = http_json("https://opendart.fss.or.kr/api/company.json?" + urllib.parse.urlencode({"crtfc_key": _env("DART_API_KEY"), "corp_code": corp_code}), timeout=10)
    return str(data.get("induty_code") or "") if data.get("status") == "000" else ""


GROK_SECTOR_PROMPT = ("당신은 한국 상장사 업종 분류 도우미입니다. 각 종목을 WICS 26개 업종 중 하나로 분류합니다. "
                      "업종 이름은 다음 중에서 정확히 골라 씁니다: " + ", ".join(WICS26) + ". "
                      "모르는 종목은 빈 문자열로 둡니다. 설명 없이 JSON 객체 {\"종목명\": \"업종\"} 만 출력합니다.")


def auto_sectors(conn_factory, names: list[str], budget_s: float = 90) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    left = [n for n in dict.fromkeys(n.strip() for n in names if n and n.strip())][:300]
    deadline = time.time() + budget_s
    if _env("DART_API_KEY") and left:
        try:
            index = _dart_name_index()
        except Exception:  # noqa: BLE001 — DART 가 안 되면 Grok 으로 넘어간다
            index = {}
        with conn_factory() as conn:
            have = {r["id"]: json.loads(r["data"]) for r in conn.all("SELECT id, data FROM records WHERE collection = 'company-industry'")}
        rest = []
        for name in left:
            corp = index.get(_norm_name(name))
            if not corp:
                rest.append(name)
                continue
            info = have.get(corp["corp_code"])
            if info is None and time.time() < deadline:
                try:
                    info = {"induty_code": _dart_industry(corp["corp_code"]), "name": corp["name"], "stock_code": corp["stock_code"]}
                    with conn_factory() as conn:
                        conn.execute("INSERT INTO records(collection, id, data, created_at) VALUES ('company-industry', ?, ?, ?)",
                                     (corp["corp_code"], json.dumps(info, ensure_ascii=False), now_iso()))
                except Exception:  # noqa: BLE001
                    info = None
            sector = ksic_to_wics((info or {}).get("induty_code", ""))
            if sector:
                out[name] = {"sector": sector, "source": "DART 업종코드 " + info["induty_code"]}
            else:
                rest.append(name)
        left = rest
    if _env("XAI_API_KEY") and left and time.time() < deadline:
        try:
            raw = grok_text(GROK_SECTOR_PROMPT, "\n".join(left[:150]), max_tokens=4000)
            m = re.search(r"\{.*\}", raw, re.S)
            guess = json.loads(m.group(0)) if m else {}
            for name, sec in guess.items():
                if name in left and sec in WICS26:
                    out[name] = {"sector": sec, "source": "Grok"}
        except Exception:  # noqa: BLE001
            pass
    return out


# ---------------------------------------------------------------------------
# 경제지표 (EODHD)
# ---------------------------------------------------------------------------

COUNTRY_KO = {"US": "미국", "KR": "한국", "CN": "중국", "JP": "일본", "EU": "유로존", "DE": "독일", "GB": "영국", "UK": "영국", "FR": "프랑스"}


def economic_events(start: str, end: str, country: str = "") -> list[dict[str, Any]]:
    q = {"api_token": _env("EODHD_API_KEY"), "fmt": "json", "from": start, "to": end, "limit": "1000"}
    if country:
        q["country"] = country
    data = http_json("https://eodhd.com/api/economic-events?" + urllib.parse.urlencode(q), timeout=20)
    out = []
    for d in data if isinstance(data, list) else []:
        raw = str(d.get("date") or "")
        try:
            t = datetime.fromisoformat(raw.replace(" ", "T")).replace(tzinfo=timezone.utc).astimezone(KST)
        except ValueError:
            continue
        c = (d.get("country") or "").upper()
        out.append({
            "id": "eod-" + re.sub(r"[^0-9A-Za-z]", "", f"{c}{raw}{d.get('type')}")[:60],
            "date": t.strftime("%Y-%m-%d"),
            "time": t.strftime("%H:%M"),
            "country": c,
            "countryName": COUNTRY_KO.get(c, c),
            "title": d.get("type") or "",
            "period": d.get("period") or "",
            "actual": d.get("actual"),
            "forecast": d.get("estimate"),
            "previous": d.get("previous"),
            "source": "EODHD",
        })
    return out


# ---------------------------------------------------------------------------
# 라우트
# ---------------------------------------------------------------------------

def register(app: FastAPI, require_user, has_feature, connect) -> None:

    def status() -> dict[str, bool]:
        return {
            "ai": bool(_env("ANTHROPIC_API_KEY")),
            "dart": bool(_env("DART_API_KEY")),
            "economic": bool(_env("EODHD_API_KEY")),
            "quotes": _env("HANA_QUOTES") != "off",
            "cron": bool(_env("CRON_SECRET")),
            # 요약은 Grok(XAI_API_KEY) 우선, 없으면 Claude
            "summary": bool(_env("XAI_API_KEY") or _env("ANTHROPIC_API_KEY")),
            "summaryProvider": "Grok" if _env("XAI_API_KEY") else ("Claude" if _env("ANTHROPIC_API_KEY") else ""),
        }

    @app.get("/api/integrations")
    def api_integrations(request: Request) -> dict[str, Any]:
        require_user(request)
        return status()

    # --- AI 리서치 ---------------------------------------------------------

    def research_user(request: Request):
        user = require_user(request)
        if not has_feature(user, "ai_research"):
            raise HTTPException(403, "AI 리서치 권한이 없습니다.")
        return user

    @app.post("/api/research/ask")
    async def api_research_ask(request: Request) -> dict[str, Any]:
        research_user(request)
        try:
            data = await request.json()
        except ValueError:
            raise HTTPException(400, "잘못된 요청입니다.")
        question = str((data or {}).get("question") or "").strip()
        if not question:
            raise HTTPException(400, "질문을 적어 주세요.")
        if len(question) > 8000:
            raise HTTPException(400, "질문이 너무 깁니다.")
        history = [m for m in (data.get("history") or []) if isinstance(m, dict)][-10:]
        import anyio

        return await anyio.to_thread.run_sync(lambda: run_research(connect, question, history))

    def _sched_key(user) -> str:
        return f"my-research-schedules:{user['id']}"

    def _sched_out(row) -> dict[str, Any]:
        d = json.loads(row["data"])
        d["id"] = row["id"]
        return d

    @app.get("/api/research/schedules")
    def api_sched_list(request: Request) -> list[dict[str, Any]]:
        user = research_user(request)
        with connect() as conn:
            rows = conn.all("SELECT * FROM records WHERE collection = ? ORDER BY created_at", (_sched_key(user),))
        return [_sched_out(r) for r in rows]

    @app.post("/api/research/schedules/preview")
    async def api_sched_preview(request: Request) -> dict[str, Any]:
        research_user(request)
        data = await request.json()
        data = {**(data or {}), "name": "x", "prompt": "x"}
        s = clean_schedule(data)
        runs = next_runs(s, datetime.now(KST), 3) if s["enabled"] else []
        return {"runs": [r.isoformat() for r in runs]}

    @app.post("/api/research/schedules", status_code=201)
    async def api_sched_create(request: Request) -> dict[str, Any]:
        user = research_user(request)
        s = clean_schedule(await request.json())
        rid = secrets.token_hex(8)
        s.update({"createdAt": now_iso(), "lastRunAt": None, "lastStatus": ""})
        with connect() as conn:
            if len(conn.all("SELECT id FROM records WHERE collection = ?", (_sched_key(user),))) >= 20:
                raise HTTPException(400, "예약은 20개까지 만들 수 있습니다.")
            conn.execute("INSERT INTO records(collection, id, data, created_by, created_at) VALUES (?,?,?,?,?)",
                         (_sched_key(user), rid, json.dumps(s, ensure_ascii=False), user["id"], now_iso()))
        return {**s, "id": rid}

    @app.put("/api/research/schedules/{sid}")
    async def api_sched_update(sid: str, request: Request) -> dict[str, Any]:
        user = research_user(request)
        s = clean_schedule(await request.json())
        with connect() as conn:
            row = conn.one("SELECT * FROM records WHERE collection = ? AND id = ?", (_sched_key(user), sid))
            if row is None:
                raise HTTPException(404, "예약을 찾을 수 없습니다.")
            prev = json.loads(row["data"])
            for k in ("createdAt", "lastRunAt", "lastStatus", "lastThreadId"):
                s[k] = prev.get(k)
            conn.execute("UPDATE records SET data = ?, updated_at = ? WHERE collection = ? AND id = ?", (json.dumps(s, ensure_ascii=False), now_iso(), _sched_key(user), sid))
        return {**s, "id": sid}

    @app.delete("/api/research/schedules/{sid}")
    def api_sched_delete(sid: str, request: Request) -> dict[str, Any]:
        user = research_user(request)
        with connect() as conn:
            conn.execute("DELETE FROM records WHERE collection = ? AND id = ?", (_sched_key(user), sid))
        return {"ok": True}

    def run_schedule(user_id: int, sid: str, s: dict[str, Any], manual: bool = False) -> dict[str, Any]:
        """예약 하나를 실행하고 결과를 새 리서치 대화로 저장한다."""
        started = datetime.now(KST)
        result = run_research(connect, s["prompt"], [])
        tid = secrets.token_hex(8)
        stamp = started.strftime("%m/%d %H:%M")
        thread = {
            "id": tid,
            "title": f"[예약] {s['name']} · {stamp}",
            "scheduleId": sid,
            "messages": [
                {"role": "user", "content": s["prompt"], "at": started.isoformat()},
                {"role": "assistant", "content": result["answer"], "refs": result.get("refs", []), "ai": result.get("ai", False), "at": datetime.now(KST).isoformat()},
            ],
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "unread": True,
        }
        with connect() as conn:
            conn.execute("INSERT INTO records(collection, id, data, created_by, created_at) VALUES (?,?,?,?,?)",
                         (f"my-research:{user_id}", tid, json.dumps(thread, ensure_ascii=False), user_id, now_iso()))
            row = conn.one("SELECT data FROM records WHERE collection = ? AND id = ?", (f"my-research-schedules:{user_id}", sid))
            if row is not None:
                cur = json.loads(row["data"])
                cur["lastRunAt"] = started.isoformat()
                cur["lastStatus"] = "ok" if result.get("ai") or not result.get("error") else "error"
                cur["lastThreadId"] = tid
                if not manual:
                    runs = next_runs(cur, datetime.now(KST)) if cur.get("cadence") != "once" else []
                    cur["nextRunAt"] = runs[0].isoformat() if runs else None
                    if not runs:
                        cur["enabled"] = False
                conn.execute("UPDATE records SET data = ?, updated_at = ? WHERE collection = ? AND id = ?",
                             (json.dumps(cur, ensure_ascii=False), now_iso(), f"my-research-schedules:{user_id}", sid))
        return {**thread}

    @app.post("/api/research/schedules/{sid}/run")
    async def api_sched_run(sid: str, request: Request) -> dict[str, Any]:
        user = research_user(request)
        with connect() as conn:
            row = conn.one("SELECT * FROM records WHERE collection = ? AND id = ?", (_sched_key(user), sid))
        if row is None:
            raise HTTPException(404, "예약을 찾을 수 없습니다.")
        import anyio

        s = json.loads(row["data"])
        return await anyio.to_thread.run_sync(lambda: run_schedule(user["id"], sid, s, manual=True))

    @app.get("/api/cron/research")
    def api_cron(request: Request) -> dict[str, Any]:
        secret = _env("CRON_SECRET")
        if not secret or request.headers.get("authorization") != f"Bearer {secret}":
            raise HTTPException(401, "권한이 없습니다.")
        now = datetime.now(KST)
        with connect() as conn:
            rows = conn.all("SELECT collection, id, data FROM records WHERE collection LIKE ?", ("my-research-schedules:%",))
        due = []
        for r in rows:
            s = json.loads(r["data"])
            nxt = s.get("nextRunAt")
            if s.get("enabled") and nxt and datetime.fromisoformat(nxt) <= now:
                due.append((int(r["collection"].split(":", 1)[1]), r["id"], s))
        due.sort(key=lambda x: x[2]["nextRunAt"])
        done = []
        deadline = time.time() + 240
        for uid, sid, s in due:
            if time.time() > deadline:
                break
            # 먼저 다음 시각으로 넘겨 두어 겹쳐 실행되지 않게 한다
            with connect() as conn:
                runs = next_runs(s, now) if s.get("cadence") != "once" else []
                s2 = {**s, "nextRunAt": runs[0].isoformat() if runs else None, "enabled": bool(runs) if s.get("cadence") == "once" else s.get("enabled")}
                conn.execute("UPDATE records SET data = ? WHERE collection = ? AND id = ?", (json.dumps(s2, ensure_ascii=False), f"my-research-schedules:{uid}", sid))
            try:
                run_schedule(uid, sid, s)
                done.append(sid)
            except Exception as e:  # noqa: BLE001 (한 예약이 실패해도 다음 예약은 돌린다)
                done.append(f"{sid}:error:{type(e).__name__}")
        return {"ran": done, "due": len(due)}

    # --- 링크 가져오기 · AI 요약 ---------------------------------------------

    @app.post("/api/fetch-link")
    async def api_fetch_link(request: Request) -> Any:
        require_user(request)
        data = await request.json()
        url = str((data or {}).get("url") or "").strip()[:2000]
        import anyio

        try:
            return await anyio.to_thread.run_sync(lambda: fetch_link(url))
        except HTTPException:
            raise
        except urllib.error.HTTPError as e:
            return JSONResponse({"detail": f"그 사이트가 요청을 거절했습니다 ({e.code}). 로그인이 필요한 페이지일 수 있습니다."}, status_code=502)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            return JSONResponse({"detail": f"페이지를 가져오지 못했습니다. ({type(e).__name__})"}, status_code=502)

    @app.post("/api/ai/summarize")
    async def api_ai_summarize(request: Request) -> Any:
        user = require_user(request)
        if not has_feature(user, "ai_research"):
            raise HTTPException(403, "AI 기능 권한(AI 리서치)이 없습니다.")
        if not (_env("XAI_API_KEY") or _env("ANTHROPIC_API_KEY")):
            return not_connected("AI 요약", "XAI_API_KEY(Grok)")
        data = await request.json()
        text = str((data or {}).get("text") or "").strip()
        if len(text) < 30:
            raise HTTPException(400, "요약할 내용이 너무 짧습니다.")
        head = " · ".join(x for x in [str(data.get("company") or ""), str(data.get("title") or "")] if x)
        prompt = (f"<source title=\"{head}\">\n{text[:60000]}\n</source>\n\n위 원문을 노트 형식으로 정리해 주세요.")
        import anyio

        try:
            out, provider = await anyio.to_thread.run_sync(lambda: summarize_text(SUMMARY_PROMPT, prompt))
        except Exception as e:  # noqa: BLE001 — 사용자에게 이유만 알려 준다
            return JSONResponse({"detail": ai_error_message(e)}, status_code=502)
        return {"summary": out, "provider": provider}

    # --- 시세 --------------------------------------------------------------

    @app.get("/api/quotes")
    def api_quotes(request: Request, codes: str = "") -> dict[str, Any]:
        require_user(request)
        wanted = [c.strip().upper() for c in codes.split(",") if c.strip()][:120]
        if not wanted:
            return {"items": [], "at": now_iso()}
        if _env("HANA_QUOTES") == "off":
            return not_connected("시세", "HANA_QUOTES")
        try:
            return {"items": quotes(wanted), "at": now_iso()}
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            return JSONResponse({"detail": f"시세를 불러오지 못했습니다. ({type(e).__name__})", "code": "upstream"}, status_code=502)

    @app.get("/api/stock-search")
    def api_stock_search(request: Request, q: str = "") -> dict[str, Any]:
        require_user(request)
        q = q.strip()[:40]
        if not q:
            return {"items": []}
        try:
            return {"items": cached("ss:" + q, 3600, lambda: stock_search(q))}
        except (urllib.error.URLError, TimeoutError, ValueError):
            return {"items": [], "offline": True}

    # --- DART --------------------------------------------------------------

    @app.get("/api/dart/disclosures")
    def api_dart_disclosures(request: Request, code: str = "", days: int = 90) -> Any:
        require_user(request)
        if not _env("DART_API_KEY"):
            return not_connected("DART", "DART_API_KEY")
        code = code.strip()
        if not re.fullmatch(r"[0-9A-Z]{6}", code):
            raise HTTPException(400, "종목코드 6자리를 넣어 주세요.")
        try:
            corp = _dart_corp_codes().get(code)
            if not corp:
                return {"items": [], "detail": "DART 에서 이 종목코드를 찾지 못했습니다."}
            end = datetime.now(KST)
            start = end - timedelta(days=max(1, min(days, 365)))
            rows = cached(f"dart:{code}:{days}", 600, lambda: _dart_list({"corp_code": corp["corp_code"], "bgn_de": start.strftime("%Y%m%d"), "end_de": end.strftime("%Y%m%d")}))
        except (urllib.error.URLError, TimeoutError, zipfile.BadZipFile, ElementTree.ParseError) as e:
            return JSONResponse({"detail": f"DART 에 연결하지 못했습니다. ({type(e).__name__})"}, status_code=502)
        return {"company": corp["name"], "items": [_disclosure(d) for d in rows]}

    @app.get("/api/dart/ir")
    def api_dart_ir(request: Request, days: int = 14) -> Any:
        """최근 기업설명회(IR) 개최 공시 목록."""
        require_user(request)
        if not _env("DART_API_KEY"):
            return not_connected("DART", "DART_API_KEY")
        end = datetime.now(KST)
        start = end - timedelta(days=max(1, min(days, 30)))

        def load() -> list[dict[str, Any]]:
            out = []
            for page in range(1, 16):
                rows = _dart_list({"bgn_de": start.strftime("%Y%m%d"), "end_de": end.strftime("%Y%m%d"), "pblntf_ty": "I", "page_no": str(page)})
                out += [_disclosure(d) for d in rows if "기업설명회" in (d.get("report_nm") or "")]
                if len(rows) < 100:
                    break
            return out

        try:
            items = cached(f"dart:ir:{days}", 900, load)
        except (urllib.error.URLError, TimeoutError) as e:
            return JSONResponse({"detail": f"DART 에 연결하지 못했습니다. ({type(e).__name__})"}, status_code=502)
        return {"items": items}

    @app.get("/api/dart/ir/schedule")
    def api_dart_ir_schedule(request: Request, days: int = 30) -> Any:
        """DART IR 공시 원문에서 읽은 일정 (개최일 순). 캘린더 'DART IR 일정' 목록용."""
        require_user(request)
        if not _env("DART_API_KEY"):
            return not_connected("DART", "DART_API_KEY")
        try:
            out = cached(f"dart:irs:{days}", 600, lambda: dart_ir_schedule(connect, days, budget_s=60))
        except (urllib.error.URLError, TimeoutError) as e:
            return JSONResponse({"detail": f"DART 에 연결하지 못했습니다. ({type(e).__name__})"}, status_code=502)
        today = datetime.now(KST).strftime("%Y-%m-%d")
        items = sorted([i for i in out["items"] if (i.get("endDate") or i.get("date") or "9999") >= today],
                       key=lambda i: (i.get("date") or "9999", i.get("time") or "99"))
        return {**out, "items": items}

    @app.post("/api/dart/ir/sync")
    def api_dart_ir_sync(request: Request, days: int = 30) -> Any:
        """DART IR 일정을 IR 캘린더에 반영 (누구나 누를 수 있고, 매일 21:00 자동)."""
        require_user(request)
        if not _env("DART_API_KEY"):
            return not_connected("DART", "DART_API_KEY")
        try:
            return sync_dart_ir(connect, days)
        except (urllib.error.URLError, TimeoutError) as e:
            return JSONResponse({"detail": f"DART 에 연결하지 못했습니다. ({type(e).__name__})"}, status_code=502)

    @app.get("/api/dart/ir/status")
    def api_dart_ir_status(request: Request) -> Any:
        require_user(request)
        with connect() as conn:
            row = conn.one("SELECT value FROM settings WHERE key = 'dart-ir-sync'")
        return {"connected": bool(_env("DART_API_KEY")), "last": json.loads(row["value"]) if row else None}

    @app.get("/api/cron/dart-ir")
    def api_cron_dart_ir(request: Request) -> Any:
        secret = _env("CRON_SECRET")
        if not secret or request.headers.get("authorization") != f"Bearer {secret}":
            raise HTTPException(401, "권한이 없습니다.")
        if not _env("DART_API_KEY"):
            return {"skipped": "DART_API_KEY 없음"}
        return sync_dart_ir(connect, 30)

    @app.post("/api/sectors/auto")
    async def api_sectors_auto(request: Request) -> Any:
        """종목명 목록 → WICS 26 업종 (DART 업종코드, 없으면 Grok). 저장은 화면이 한다."""
        require_user(request)
        data = await request.json()
        names = [str(x) for x in (data or {}).get("companies", []) if isinstance(x, str)][:300]
        if not (_env("DART_API_KEY") or _env("XAI_API_KEY")):
            return {"sectors": {}, "detail": "DART_API_KEY 또는 XAI_API_KEY 가 있어야 자동 지정할 수 있습니다."}
        import anyio

        return {"sectors": await anyio.to_thread.run_sync(lambda: auto_sectors(connect, names))}

    # --- 경제지표 -----------------------------------------------------------

    @app.get("/api/economic")
    def api_economic(request: Request, start: str = "", end: str = "", country: str = "") -> Any:
        require_user(request)
        if not _env("EODHD_API_KEY"):
            return not_connected("경제지표 자료", "EODHD_API_KEY")
        if not (re.fullmatch(r"\d{4}-\d{2}-\d{2}", start) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", end)):
            raise HTTPException(400, "기간을 YYYY-MM-DD 로 넣어 주세요.")
        country = country.upper() if re.fullmatch(r"[A-Za-z]{2}", country or "") else ""
        try:
            items = cached(f"eco:{start}:{end}:{country}", 1800, lambda: economic_events(start, end, country))
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            return JSONResponse({"detail": f"경제지표를 불러오지 못했습니다. ({type(e).__name__})"}, status_code=502)
        return {"items": items}
