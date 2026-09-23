"""외부 데이터 연결 — AI 리서치(Claude), 시세(네이버 금융), DART 공시, 경제지표(EODHD), 예약 리서치.

키는 환경변수로 넣는다. 키가 없으면 해당 기능은 '연결 안 됨' 으로 알려 주고,
AI 리서치는 저장된 노트 검색 결과만 돌려준다.

  ANTHROPIC_API_KEY   AI 리서치 답변
  HANA_AI_MODEL       (선택) 기본 claude-opus-5
  DART_API_KEY        DART OpenAPI (opendart.fss.or.kr 에서 무료 발급)
  EODHD_API_KEY       경제지표 일정 (eodhd.com)
  CRON_SECRET         예약 리서치를 깨우는 주기 호출(Vercel Cron) 확인용
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
        "filer": d.get("flr_nm") or "",
        "url": "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + (d.get("rcept_no") or ""),
    }


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
