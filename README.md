# 🪰 가상 초파리 뇌 (Virtual Fly Brain)

실제 초파리(*Drosophila melanogaster*) 커넥톰 데이터로 돌아가는 **브라우저 스파이킹 뇌 시뮬레이터**.

FlyWire 프로젝트가 공개한 성체 초파리 뇌 전체 배선도 — **뉴런 139,255개, 시냅스 연결 270만 쌍** — 를
leaky integrate-and-fire(LIF) 모델로 실시간 시뮬레이션하고, WebGL 포인트 클라우드로 렌더링합니다.
설탕맛·쓴맛·냄새·빛·소리 같은 실제 감각 뉴런을 자극하면 활동이 뇌 전체로 퍼지는 걸 눈으로 볼 수 있고,
🍺 에탄올 슬라이더로 "만취 초파리"도 만들어볼 수 있습니다.

![스크린샷](docs/screenshot.png)

## 실행 방법

데이터가 저장소에 포함되어 있어서 바로 실행됩니다 (별도 빌드 불필요):

```bash
cd web
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000 접속
```

- **감각 자극** 버튼: 실제 논문에서 식별된 감각 뉴런 집단을 포아송 발화로 자극
  - 🍬 설탕맛 GRN (23개) / ☕ 쓴맛 GRN (38개) — Engert et al. 2022, Shiu et al. 2022 라벨
  - 👃 후각 ORN (2,281개), 💡 시각 (11,426개), 🔊 존스턴 기관 JO (894개), 🌡️ 온도, 💧 습도, 🖐️ 기계감각
- **🍺 에탄올** 슬라이더: 저용량에서 막 노이즈·과활동, 고용량에서 억제 강화 + 임계값 상승(진정).
  실제 약리 모델이 아닌 장난스러운 근사입니다.
- 드래그로 회전, 휠로 확대·축소. 색은 뉴런 super_class(시엽/중심뇌/감각/운동 등) 기준.

## 구조

```
pipeline/build_dataset.py   FlyWire v783 공개 CSV → 브라우저용 바이너리 변환
web/index.html              UI (한국어)
web/js/sim-worker.js        LIF 시뮬레이션 (Web Worker, 139k 뉴런 실시간)
web/js/render.js            WebGL1 포인트 클라우드 렌더러 (의존성 없음)
web/js/main.js              데이터 로드 + 오케스트레이션
web/data/                   변환된 커넥톰 (~18MB: CSR 인접 구조 + 좌표 + 분류)
```

### 시뮬레이션 모델

Shiu et al. 2024 (*Nature*, "A Drosophila computational brain model reveals
sensorimotor processing")의 관례를 단순화한 LIF 모델:

- 시냅스 가중치 = 부호 있는 시냅스 개수. 신경전달물질 예측에 따라
  ACH/DA/SER/OCT는 흥분(+), GABA/GLUT는 억제(−)
- 막 시간상수 10ms, 발화 임계값 25 시냅스 단위(≈ 7mV ÷ 0.275mV/시냅스), 불응기 2ms
- 스파이크 즉시 전달(delta synapse), 전도 지연 없음
- **적응형 임계값**(spike-frequency adaptation, +30/τ=100ms): 순수 LIF에서는 재귀
  회로가 한 번 점화되면 영구 폭주하므로, 발화할수록 임계값이 올라갔다가 서서히
  복귀하게 해서 자극을 끄면 활동이 소멸하도록 했습니다

### 데이터 재생성

```bash
cd pipeline
pip install pandas numpy
python3 build_dataset.py --download --src flywire_csv --out ../web/data
```

공개 버킷(`storage.googleapis.com/flywire-data/codex/data/fafb/783`)에서 약 60MB를
내려받아 처리합니다 (수 분 소요).

## 데이터 출처와 인용

데이터: [FlyWire Connectome](https://codex.flywire.ai) v783 공개 스냅숏.
사용 조건은 FlyWire의 데이터 이용 약관을 따르며, 이용 시 아래 논문을 인용해야 합니다:

- Dorkenwald et al. 2024, *Nature* — Neuronal wiring diagram of an adult brain
- Schlegel et al. 2024, *Nature* — Whole-brain annotation and multi-connectome cell typing of Drosophila
- Shiu et al. 2024, *Nature* — A Drosophila computational brain model reveals sensorimotor processing (LIF 모델 참고)
