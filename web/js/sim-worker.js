// LIF(leaky integrate-and-fire) 스파이킹 시뮬레이션 워커.
// 모델 관례는 Shiu et al. 2024 (Drosophila computational brain model)를 단순화한 것:
//  - 뉴런당 막전위 v, 시간상수 tau=10ms, 임계값 도달 시 스파이크 + 불응기
//  - 시냅스 가중치 = 부호 있는 시냅스 개수 (ACH/DA/SER/OCT +, GABA/GLUT -)
//  - 스파이크 즉시 전달(delta synapse), 전도 지연 없음
// "에탄올" 파라미터는 장난스러운 근사임: 저용량에서 흥분성↑·막 노이즈↑,
// 고용량에서 GABA 억제 강화 + 임계값 상승(진정). 실제 약리 모델이 아님.

let n = 0;
let indptr, targets, weights;   // CSR
let v, refr, glow, ad;          // 상태 (ad: 적응형 임계값 증분)
let stimActive = {};            // key -> Uint32Array (뉴런 인덱스)
let stimRate = 50;              // Hz, 자극 뉴런의 강제 발화율
let ethanol = 0;                // 0..1
let ticksPerFrame = 6;
let running = true;

const DT = 0.5;                  // ms / tick
const TAU = 10;                  // ms
const DECAY = Math.exp(-DT / TAU);
const THR = 25;                  // 발화 임계값 (시냅스 단위, ≈ Shiu et al.의 7mV/0.275mV)
const V_RESET = 0;
const V_MIN = -60;
const REFR_TICKS = 4;            // 2ms 불응기
const GLOW_DECAY = 0.93;
// 발화율 적응(adaptive threshold): 스파이크마다 임계값이 올라갔다가 서서히 복귀.
// 순수 LIF에서는 재귀 회로가 한 번 점화되면 영구 폭주하므로 이를 막는다.
const ADAPT_INC = 30;
const ADAPT_TAU = 100;           // ms
const ADAPT_DECAY = Math.exp(-DT / ADAPT_TAU);

let tick = 0;
let spikeWindow = [];            // 최근 프레임들의 스파이크 수

// 빠른 xorshift PRNG (노이즈용)
let rs = 2463534242;
function frand() {
  rs ^= rs << 13; rs >>>= 0;
  rs ^= rs >> 17;
  rs ^= rs << 5; rs >>>= 0;
  return rs / 4294967296;
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    n = m.n;
    indptr = new Uint32Array(m.indptr);
    targets = new Uint32Array(m.targets);
    weights = new Int16Array(m.weights);
    v = new Float32Array(n);
    refr = new Uint8Array(n);
    glow = new Float32Array(n);
    ad = new Float32Array(n);
    loop();
  } else if (m.type === 'stim') {
    if (m.on) stimActive[m.key] = new Uint32Array(m.indices);
    else delete stimActive[m.key];
  } else if (m.type === 'params') {
    if (m.stimRate !== undefined) stimRate = m.stimRate;
    if (m.ethanol !== undefined) ethanol = m.ethanol;
    if (m.speed !== undefined) ticksPerFrame = m.speed;
    if (m.running !== undefined) running = m.running;
  } else if (m.type === 'reset') {
    v.fill(0); refr.fill(0); glow.fill(0); ad.fill(0); tick = 0;
  } else if (m.type === 'buffer') {
    spareBuf = new Uint8Array(m.buf);   // 프레임 버퍼 반환(핑퐁)
  }
};

let spareBuf = null;

function step() {
  const eth = ethanol;
  // 에탄올 곡선: 저용량 임계값↓(들뜸), 고용량 임계값↑(진정)
  const thrEff = THR * (1 - 0.25 * eth + 1.6 * Math.max(0, eth - 0.55));
  const inhBoost = 1 + 1.2 * eth;          // GABA/GLUT 강화
  const noiseAmp = 6 * eth;                // 막 노이즈
  const noiseFrac = eth > 0 ? 0.08 : 0;    // 노이즈 받는 뉴런 비율/tick

  // 1) 누수(감쇠) + 적응 회복
  for (let i = 0; i < n; i++) {
    v[i] *= DECAY;
    ad[i] *= ADAPT_DECAY;
    if (refr[i] > 0) refr[i]--;
  }

  // 2) 막 노이즈 (에탄올)
  if (noiseFrac > 0) {
    const kicks = (n * noiseFrac) | 0;
    for (let k = 0; k < kicks; k++) {
      const i = (frand() * n) | 0;
      v[i] += (frand() - 0.4) * noiseAmp;
    }
  }

  // 3) 외부 자극: 각 자극 뉴런이 stimRate Hz 포아송 발화
  const p = stimRate * DT / 1000;
  for (const key in stimActive) {
    const idx = stimActive[key];
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      if (frand() < p) v[i] = thrEff + ad[i] + 1;
    }
  }

  // 4) 발화 판정 + 전파
  let spikes = 0;
  for (let i = 0; i < n; i++) {
    if (refr[i] === 0 && v[i] >= thrEff + ad[i]) {
      spikes++;
      v[i] = V_RESET;
      refr[i] = REFR_TICKS;
      ad[i] += ADAPT_INC;
      glow[i] = 1;
      const a = indptr[i], b = indptr[i + 1];
      for (let j = a; j < b; j++) {
        let w = weights[j];
        if (w < 0) w *= inhBoost;
        v[targets[j]] += w;
      }
    } else if (v[i] < V_MIN) {
      v[i] = V_MIN;
    }
    glow[i] *= GLOW_DECAY;
  }
  tick++;
  return spikes;
}

function loop() {
  let frameSpikes = 0;
  if (running) {
    for (let t = 0; t < ticksPerFrame; t++) frameSpikes += step();
  }

  // 글로우를 uint8로 양자화해 메인 스레드로 전송
  let buf = spareBuf && spareBuf.length === n ? spareBuf : new Uint8Array(n);
  spareBuf = null;
  let active = 0;
  for (let i = 0; i < n; i++) {
    const g = glow[i];
    buf[i] = g > 0.004 ? (g * 255) | 0 : 0;
    if (g > 0.5) active++;
  }
  const simMs = running ? ticksPerFrame * DT : 0;
  postMessage({
    type: 'frame',
    glow: buf.buffer,
    tick,
    timeMs: tick * DT,
    spikes: frameSpikes,
    simMs,
    active,
  }, [buf.buffer]);

  setTimeout(loop, 12);
}
