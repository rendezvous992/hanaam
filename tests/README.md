# 확인용 스크립트

서버를 SQLite 로 띄워 실제 HTTP 요청을 보내 확인합니다. 키·DB 없이도 돌아갑니다.

```bash
python -m venv venv && venv/bin/pip install -r server/requirements.txt
venv/bin/python tests/test_stt.py        # 녹음 받아쓰기 모듈 (가짜 Whisper 서버로 왕복)
venv/bin/python tests/test_features.py   # 계정 생성·계정 관리·녹음/받아쓰기·섹터·DART IR·캘린더 구독
```

둘 다 `0 failed` 로 끝나야 합니다. 바깥 서비스(OpenAI·DART·xAI)는 부르지 않습니다.
