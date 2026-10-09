// LIF(leaky integrate-and-fire) 스파이킹 시뮬레이션 워커.
// 모델 관례는 Shiu et al. 2024 (Drosophila computational brain model)를 단순화한 것:
//  - 뉴런당 막전위 v, 시간상수 tau=10ms, 임계값 도달 시 스파이크 + 불응기
//  - 시냅스 가중치 = 부호 있는 시냅스 개수 (ACH/DA/SER/OCT +, GABA/GLUT -)
//  - 스파이크 즉시 전달(delta synapse), 전도 지연 없음
// "에탄올" 파라미터는 장난스러운 근사임: 저용량에서 흥분성↑·막 노이즈↑,
// 고용량에서 GABA 억제 강화 + 임계값 상승(진정). 실제 약리 모델이 아님.

let n = 0;
let indptr, targets, weights;   // CSR
let orig = null;                // 학습 전 원래 가중치(연결체 그대로) — 저장할 때 차이만 뽑는다
// 학습으로 바뀐 세기의 한계: 원래(시냅스 개수)의 0.05~4배, 부호는 그대로. 한계가 없으면 칭찬이
// 반복된 몇몇 시냅스가 수억 배로 커져 스파이크 하나로 목표 뉴런을 강제로 켜 버린다.
const W_MIN = 0.05, W_MAX = 4;
function bound(j, w) {
  const o = orig[j], a = Math.abs(o);
  if (Math.abs(w) > a * W_MAX) return Math.sign(o) * a * W_MAX;
  if (Math.abs(w) < a * W_MIN) return Math.sign(o) * a * W_MIN;
  return w;
}
let chg = null, nChg = 0;       // 시냅스별 '한 번이라도 바뀌었나' 표시와 그 개수(누적, 중복 없이)
let v, refr, glow, ad;          // 상태 (ad: 적응형 임계값 증분)
let readoutMask = null;         // 뉴런별 비트마스크: 어떤 판독 그룹 소속인지
let readoutCounts = null;       // 그룹별 프레임 내 스파이크 수
let nReadouts = 0;
let stimActive = {};            // key -> { idx, rate } 또는 { idx, rates(뉴런별 Hz) }
let driveSets = {};             // key -> Uint32Array — 시각 입력처럼 뉴런별 발화율로 매 프레임 갱신
let watchPos = null;            // 뉴런 → 감시 목록 위치(-1 = 감시 안 함)
let watchCounts = null;         // 감시 뉴런별 스파이크 수 (프레임/프로브 단위)
let probing = false;            // 프로브 중에는 모든 뉴런 발화 수를 센다(가소성용)
let probeCounts = null;
// 판 내용에 반응한 입력만 학습: 뉴런마다 '평소' 프로브 발화 수를 지수평균으로 기억하고,
// 이번 판에서 그보다 더 발화한 만큼만 학습 자격(eligibility)으로 친다. 판 선·배경처럼
// 늘 들어오는 입력은 자격이 없어져서 '이 칸이 좋다'가 아니라 '이런 판이면 여기'를 배운다.
let preAvg = null, havePrev = false;
let covLearn = true;
const AVG_RATE = 0.05;
let stimRate = 50;              // Hz, 자극 뉴런의 강제 발화율
let ethanol = 0;                // 0..1
let nicotine = 0;               // 0..1 — 니코틴성 ACh 수용체 작용제 근사: 흥분성 시냅스 증폭
let ticksPerFrame = 6;
let running = true;
let idleFade = false;            // 멈춰 있는 동안에도 화면용 글로우를 서서히 꺼지게 (경기장 뇌)

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
    // 가소성(보상 학습)으로 소수 단위 변화를 담기 위해 실수로 보관
    orig = new Int16Array(m.weights);
    weights = Float32Array.from(orig);
    chg = new Uint8Array(weights.length); nChg = 0;
    v = new Float32Array(n);
    refr = new Uint8Array(n);
    glow = new Float32Array(n);
    ad = new Float32Array(n);
    if (m.readouts) {           // [[idx...], ...] 순서 = 비트 순서 (최대 8그룹)
      nReadouts = m.readouts.length;
      readoutMask = new Uint8Array(n);
      m.readouts.forEach((idx, g) => {
        for (const i of idx) readoutMask[i] |= (1 << g);
      });
      readoutCounts = new Float64Array(nReadouts);
    }
    loop();
  } else if (m.type === 'driveSet') {
    driveSets[m.key] = new Uint32Array(m.indices);
  } else if (m.type === 'drive') {
    // rates: driveSets[key]와 같은 길이의 Float32Array(Hz). null이면 입력 끔
    if (m.rates) stimActive[m.key] = { idx: driveSets[m.key], rates: new Float32Array(m.rates) };
    else delete stimActive[m.key];
  } else if (m.type === 'watch') {
    watchPos = new Int32Array(n).fill(-1);
    m.indices.forEach((i, k) => { watchPos[i] = k; });
    watchCounts = new Uint16Array(m.indices.length);
  } else if (m.type === 'probe') {
    // 뇌를 초기화하고 입력을 ticks 동안만 보여준 뒤 감시 뉴런 반응을 돌려준다.
    // 활동이 수 ms 만에 뇌 전체로 퍼지므로 위치 정보가 남은 첫 반응 파동만 쓴다.
    v.fill(0); refr.fill(0); ad.fill(0);
    const saved = stimActive;
    stimActive = { probe: { idx: driveSets[m.key], rates: new Float32Array(m.rates) } };
    watchCounts.fill(0);
    if (m.learn) {
      if (!probeCounts) { probeCounts = new Uint16Array(n); preAvg = new Float32Array(n); }
      // 직전 프로브를 평소 평균에 접어 넣는다 (지금 판은 평균에 들어가기 전에 비교된다)
      if (havePrev) for (let i = 0; i < n; i++) preAvg[i] += AVG_RATE * (probeCounts[i] - preAvg[i]);
      probeCounts.fill(0); probing = true; havePrev = true;
    }
    for (let t = 0; t < m.ticks; t++) step();
    stimActive = saved;
    if (m.learn) {
      probing = false;   // probeCounts는 다음 reinforceCell까지 보관
      // 판을 '본' 순간 발화한 뉴런을 화면에 남긴다 (프로브는 한 번에 지나가므로)
      for (let i = 0; i < n; i++) if (probeCounts[i]) glow[i] = Math.max(glow[i], Math.min(1, 0.35 + 0.15 * probeCounts[i]));
    }
    const counts = watchCounts.slice();
    watchCounts.fill(0);
    postMessage({ type: 'probeResult', id: m.id, counts }, [counts.buffer]);
  } else if (m.type === 'reinforceCell') {
    // 도파민 신호 r로, 직전 프로브에서 post 뉴런들(고른 칸을 보는 시각 뉴런)을
    // 발화시키는 데 함께한 입력 시냅스만 강화(r>0)·약화(r<0)한다
    postMessage({ type: 'reinforced', id: m.id, ...reinforceCell(m.post, m.r, m.eta || 0.4) });
  } else if (m.type === 'exportDiff') {
    // 학습으로 바뀐 시냅스만 (인덱스, 현재 가중치)로 — 공유 저장소에 올릴 '훈련된 뇌'
    let k = 0;
    for (let j = 0; j < weights.length; j++) if (weights[j] !== orig[j]) k++;
    const idx = new Uint32Array(k), val = new Float32Array(k);
    k = 0;
    for (let j = 0; j < weights.length; j++) if (weights[j] !== orig[j]) { idx[k] = j; val[k++] = weights[j]; }
    postMessage({ type: 'diff', id: m.id, idx, val }, [idx.buffer, val.buffer]);
  } else if (m.type === 'importDiff') {
    // 원래 연결체로 되돌린 뒤 저장된 차이를 덮어쓴다 (idx가 비면 초기화)
    weights.set(orig); chg.fill(0);
    const idx = new Uint32Array(m.idx), val = new Float32Array(m.val);
    let k = 0;
    for (let q = 0; q < idx.length; q++) if (idx[q] < weights.length) { weights[idx[q]] = bound(idx[q], val[q]); chg[idx[q]] = 1; k++; }
    nChg = k;
    postMessage({ type: 'imported', id: m.id, changed: k });
  } else if (m.type === 'plastic') {
    plasticInit(m);
  } else if (m.type === 'plasticReset') {
    plasticReset(m.what || 'all');
  } else if (m.type === 'exportMem') {
    postMessage({ type: 'mem', id: m.id, ...exportMem() });
  } else if (m.type === 'importMem') {
    postMessage({ type: 'memImported', id: m.id, changed: importMem(m) });
  } else if (m.type === 'stim') {
    // rate 미지정 시 전역 stimRate 사용 (명령 뉴런은 강한 고정 자극)
    if (m.on) stimActive[m.key] = { idx: new Uint32Array(m.indices), rate: m.rate || 0 };
    else delete stimActive[m.key];
  } else if (m.type === 'params') {
    if (m.stimRate !== undefined) stimRate = m.stimRate;
    if (m.ethanol !== undefined) ethanol = m.ethanol;
    if (m.nicotine !== undefined) nicotine = m.nicotine;
    if (m.speed !== undefined) ticksPerFrame = m.speed;
    if (m.running !== undefined) running = m.running;
    if (m.idleFade !== undefined) idleFade = m.idleFade;
    if (m.covLearn !== undefined) covLearn = m.covLearn;
  } else if (m.type === 'reset') {
    v.fill(0); refr.fill(0); glow.fill(0); ad.fill(0); tick = 0;
  } else if (m.type === 'buffer') {
    spareBuf = new Uint8Array(m.buf);   // 프레임 버퍼 반환(핑퐁)
  }
};

let spareBuf = null;

// 3요소 학습(겨냥형): 직전 프로브에서 함께 발화한 (pre → post) 시냅스만,
// Δw = η · r · √(e_pre·post발화 / 최대) · w. 부호(흥분/억제)는 유지된다.
// e_pre = 평소보다 더 발화한 만큼(covLearn) 또는 발화 수 그대로(예전 규칙).
let postMask = null;
function reinforceCell(post, r, eta) {
  if (!probeCounts || !r) return { changed: 0, total: nChg, meanChange: 0 };
  if (!postMask) postMask = new Uint8Array(n);
  for (const t of post) if (probeCounts[t]) postMask[t] = 1;
  const elig = i => covLearn ? Math.max(0, probeCounts[i] - preAvg[i]) : probeCounts[i];
  let mx = 0;
  for (let i = 0; i < n; i++) {
    if (!probeCounts[i]) continue;
    const ci = elig(i);
    if (!(ci > 0)) continue;
    for (let j = indptr[i], b = indptr[i + 1]; j < b; j++) {
      const t = targets[j];
      if (postMask[t] && ci * probeCounts[t] > mx) mx = ci * probeCounts[t];
    }
  }
  let changed = 0, sum = 0;
  if (mx > 0) {
    for (let i = 0; i < n; i++) {
      if (!probeCounts[i]) continue;
      const ci = elig(i);
      if (!(ci > 0)) continue;
      for (let j = indptr[i], b = indptr[i + 1]; j < b; j++) {
        const t = targets[j];
        if (!postMask[t]) continue;
        const f = Math.max(0.5, Math.min(1.5, 1 + eta * r * Math.sqrt(ci * probeCounts[t] / mx)));
        sum += Math.abs(weights[j] * (f - 1));
        weights[j] = bound(j, weights[j] * f);
        changed++;
        if (!chg[j]) { chg[j] = 1; nChg++; }
      }
    }
  }
  for (const t of post) postMask[t] = 0;
  return { changed, total: nChg, meanChange: changed ? sum / changed : 0 };
}

function step() {
  // 내성: 같은 양을 넣어도 뇌가 받는 효과가 줄어든다 (경험 모드에서만 쌓임)
  const eth = pl ? ethanol * (1 - pl.tolE) : ethanol;
  const nic = pl ? nicotine * (1 - pl.tolN) : nicotine;
  // 에탄올 곡선: 저용량 임계값↓(들뜸), 고용량 임계값↑(진정)
  const thrEff = THR * (1 - 0.25 * eth + 1.6 * Math.max(0, eth - 0.55));
  const inhBoost = 1 + 1.2 * eth;          // GABA/GLUT 강화
  // 니코틴: 초파리 뇌의 주 흥분성 전달물질이 ACh라서, 흥분성 시냅스를 증폭시킨다
  const excBoost = 1 + 0.6 * nic;
  const noiseAmp = 6 * eth + 2 * nic;      // 막 노이즈
  const noiseFrac = (eth > 0 || nic > 0) ? 0.08 : 0;

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

  // 3) 외부 자극: 각 자극 뉴런이 지정 Hz로 포아송 발화
  const p0 = stimRate * DT / 1000;
  for (const key in stimActive) {
    const s = stimActive[key];
    const idx = s.idx;
    if (s.rates) {
      const rr = s.rates, kk = DT / 1000;
      for (let k = 0; k < idx.length; k++) {
        if (rr[k] > 0 && frand() < rr[k] * kk) { const i = idx[k]; v[i] = thrEff + ad[i] + 1; }
      }
      continue;
    }
    const p = s.rate ? s.rate * DT / 1000 : p0;
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
      if (watchPos !== null && watchPos[i] >= 0) watchCounts[watchPos[i]]++;
      if (probing) probeCounts[i]++;
      if (spkWin !== null) spkWin[i]++;
      if (readoutMask !== null && readoutMask[i]) {
        const mb = readoutMask[i];
        for (let g = 0; g < nReadouts; g++) if (mb & (1 << g)) readoutCounts[g]++;
      }
      const a = indptr[i], b = indptr[i + 1];
      for (let j = a; j < b; j++) {
        let w = weights[j];
        w *= (w < 0) ? inhBoost : excBoost;
        v[targets[j]] += w;
      }
    } else if (v[i] < V_MIN) {
      v[i] = V_MIN;
    }
    glow[i] *= GLOW_DECAY;
  }
  tick++;
  if (pl !== null && ++pl.tick >= PL_WIN) { pl.tick = 0; plasticUpdate(); }
  return spikes;
}

function loop() {
  let frameSpikes = 0;
  if (running) {
    for (let t = 0; t < ticksPerFrame; t++) frameSpikes += step();
  } else if (idleFade) {
    for (let i = 0; i < n; i++) glow[i] *= 0.88;
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
  const counts = readoutCounts ? Array.from(readoutCounts) : null;
  if (readoutCounts) readoutCounts.fill(0);
  let watch = null;
  if (watchCounts) { watch = watchCounts.slice(); watchCounts.fill(0); }
  postMessage({
    type: 'frame',
    glow: buf.buffer,
    tick,
    timeMs: tick * DT,
    spikes: frameSpikes,
    simMs,
    active,
    counts,
    watch,
  }, watch ? [buf.buffer, watch.buffer] : [buf.buffer]);

  setTimeout(loop, 12);
}

// ── 경험 모드(메인 초파리): 자극이 쌓이면 뇌가 바뀐다 ─────────────────
// 세 가지 가소성. 실제로는 수 분~수 시간 걸리는 변화를 시뮬레이션 시간 몇 초로 압축했다.
//  1) 습관화(감각 시냅스 억압): 계속 발화하는 감각 뉴런의 출력 시냅스가 약해지고, 쉬면 회복된다.
//  2) 버섯체 연합 기억: 자극을 받은 케년세포(KC)와 같은 구획의 도파민 뉴런(DAN)이 함께 활동하면
//     그 KC → MBON 시냅스가 약해진다(장기 억압, Hige et al. 2015; Cohn et al. 2015).
//     KC 입력 없이 DAN만 활동하면 약해졌던 시냅스가 원래대로 돌아온다(Berry et al. 2018).
//     보상(PAM) 구획 MBON은 회피를, 처벌(PPL1) 구획 MBON은 다가가기를 부추기므로(Aso et al. 2014)
//     냄새 + 단맛 → 회피 출력 감소 → 그 냄새를 좋아하게 된다.
//     KC가 '무슨 자극'에 반응하는지는 감각 뉴런의 실제 발화 × 연결체의 2시냅스 직통 경로(상위 5% KC)로
//     정한다 — 이 모델의 KC 발화는 자극 몇 ms 뒤 뇌 전체 점화에 휩쓸려 자극끼리 구별되지 않는다.
//  3) 내성: 에탄올·니코틴에 노출될수록 같은 양의 효과가 줄고, 끊으면 천천히 돌아온다.
let pl = null, spkWin = null;
const PL_WIN = 100;                         // 갱신 주기: 100틱 = 모의 50ms
const PL_DT = PL_WIN * DT / 1000;           // s
const HAB_K = 0.004, HAB_TAU = 8;           // 억압 속도(1/스파이크), 회복 시간상수(s)
const HAB_FLOOR = { sight: 0.7 };           // 기본 바닥 0.3 (빛은 광적응 수준만)
const REF_HZ = 50;                          // 감각 입력 기준 발화율 (자극 강도 기본값)
const KC_TAU = 0.4;                         // KC 자격 흔적 감쇠(s)
const DAN_MARGIN = 8, DAN_SPAN = 30;        // 평소(직전 맥락)보다 이만큼(Hz) 넘게 오른 도파민만 학습 신호
const DAN_SMOOTH = 0.3;                     // 구획 DAN이 1~3개뿐이라 창마다 들쭉날쭉 → 지수평활
const LTD = 0.05, LTP = 0.015, W_FLOOR_MB = 0.15, FORGET_TAU = 900;
const TOL_UP = 1 / 3, TOL_DOWN = 1 / 40, TOL_MAX = 0.6;
const US_SUGAR = 60, US_BITTER = 100, US_ETH = 30;  // 무조건 자극이 켜는 도파민 뉴런 발화율(Hz) — PPL1은 전뇌 점화로 이미 ~35Hz라 더 세게

function plasticInit(m) {
  const sens = {}, all = new Set();
  for (const [k, idx] of Object.entries(m.sensory)) { sens[k] = Uint32Array.from(idx); for (const i of idx) all.add(i); }
  const sIdx = Uint32Array.from(all);
  const sPos = new Map(); sIdx.forEach((i, q) => sPos.set(i, q));
  const floor = new Float32Array(sIdx.length).fill(0.3);
  for (const [k, f] of Object.entries(HAB_FLOOR)) if (sens[k]) for (const i of sens[k]) floor[sPos.get(i)] = Math.max(floor[sPos.get(i)], f);
  const sensQ = {};
  for (const k in sens) sensQ[k] = Uint32Array.from(sens[k], i => sPos.get(i));
  const kc = Uint32Array.from(m.kc), mbon = Uint32Array.from(m.mbon);
  const mPos = new Int16Array(n).fill(-1); mbon.forEach((i, q) => { mPos[i] = q; });
  const pamSet = new Set(m.pam), pplSet = new Set(m.ppl1);
  // 각 MBON의 구획 DAN 중 그 MBON 계열(PAM/PPL1)에 속하는 것
  const famDan = m.comp_dan.map((ds, q) => Uint32Array.from(ds.filter(d =>
    m.family[q] === 'PAM' ? pamSet.has(d) : m.family[q] === 'PPL1' ? pplSet.has(d) : false)));
  const sj = [], sk = [], sm = [];
  for (let k = 0; k < kc.length; k++) {
    const i = kc[k];
    for (let j = indptr[i]; j < indptr[i + 1]; j++) {
      const q = mPos[targets[j]];
      if (q >= 0 && m.valence[q] !== 0 && famDan[q].length && orig[j] !== 0) { sj.push(j); sk.push(k); sm.push(q); }
    }
  }
  // 자극별 KC 코드 (KC 위치, 0..1 세기 × 버섯체로 가는 길의 굵기)
  const cs = {};
  for (const [k, c] of Object.entries(m.cs || {})) {
    if (!sens[k]) continue;
    const code = new Float32Array(kc.length);
    c.kc.forEach((q, t) => { code[q] = c.w[t]; });
    cs[k] = { code, strength: c.strength };
  }
  pl = {
    tick: 0, sens, sensQ, sIdx, floor, hg: new Float32Array(sIdx.length).fill(1), hgOn: new Float32Array(sIdx.length).fill(1),
    kc, mbon, val: Int8Array.from(m.valence), fam: m.family.slice(), famDan,
    pam: Uint32Array.from(m.pam), ppl1: Uint32Array.from(m.ppl1),
    synJ: Uint32Array.from(sj), synK: Uint16Array.from(sk), synM: Uint8Array.from(sm),
    cs, e: new Float32Array(kc.length), g: new Float32Array(mbon.length), danBase: new Float32Array(mbon.length), danHz: new Float32Array(mbon.length),
    act: {}, tolE: 0, tolN: 0, win: 0, us: { pam: 0, ppl1: 0 },
  };
  spkWin = new Uint16Array(n);
  postMessage({ type: 'plasticReady', synapses: sj.length, sensory: sIdx.length });
}

// 감각 뉴런 q의 출력 시냅스를 습관화 이득대로 다시 쓴다
function applyHab(q) {
  const i = pl.sIdx[q], gq = pl.hg[q];
  for (let j = indptr[i], b = indptr[i + 1]; j < b; j++) weights[j] = orig[j] * gq;
  pl.hgOn[q] = gq;
}

const habOf = k => {
  const qs = pl.sensQ[k];
  if (!qs || !qs.length) return 1;
  let s = 0;
  for (let t = 0; t < qs.length; t++) s += pl.hg[qs[t]];
  return s / qs.length;
};

function plasticUpdate() {
  const P = pl, dt = PL_DT;
  // 1) 습관화 + 자극별 실제 출력 (발화 × 남은 시냅스 세기, 기준 발화율 대비)
  const rec = dt / HAB_TAU;
  for (let q = 0; q < P.sIdx.length; q++) {
    const c = spkWin[P.sIdx[q]];
    let gq = P.hg[q];
    gq += -HAB_K * c * gq + (1 - gq) * rec;
    if (gq < P.floor[q]) gq = P.floor[q]; else if (gq > 1) gq = 1;
    P.hg[q] = gq;
    if (Math.abs(gq - P.hgOn[q]) > 0.01 || (gq === 1 && P.hgOn[q] !== 1)) applyHab(q);
  }
  for (const k in P.cs) {
    const qs = P.sensQ[k];
    let s = 0;
    for (let t = 0; t < qs.length; t++) s += spkWin[P.sIdx[qs[t]]] * P.hg[qs[t]];
    P.act[k] = Math.min(1.5, s / qs.length / (REF_HZ * dt));
  }
  // 2) KC 자격 흔적: 지금 들어오는 자극 코드 (빨리 오르고 천천히 사그라든다)
  const dec = Math.exp(-dt / KC_TAU);
  for (let q = 0; q < P.e.length; q++) P.e[q] *= dec;
  for (const k in P.cs) {
    const a = P.act[k] * P.cs[k].strength;
    if (a < 0.01) continue;
    const code = P.cs[k].code;
    for (let q = 0; q < code.length; q++) if (code[q] > 0) { const x = Math.min(1, a * code[q]); if (x > P.e[q]) P.e[q] = x; }
  }
  // 3) 구획별 도파민: MBON마다 자기 계열 DAN의 평균 발화율. 무조건 자극이 없을 땐 그 수준을
  //    '평소'로 따라가고(전뇌 점화로 오른 DAN 활동은 학습 신호가 아니다), 있을 땐 고정해 둔 평소보다
  //    오른 만큼만 학습 신호로 친다.
  const usOn = { PAM: !!(stimActive['us-pam'] || stimActive['rew-good']), PPL1: !!(stimActive['us-ppl1'] || stimActive['rew-bad']) };
  const bDec = Math.exp(-dt / 1);
  let anyDan = false;
  for (let q = 0; q < P.mbon.length; q++) {
    const ds = P.famDan[q];
    if (!ds.length) { P.g[q] = 0; continue; }
    let s = 0;
    for (let d = 0; d < ds.length; d++) s += spkWin[ds[d]];
    const hz = (P.danHz[q] += DAN_SMOOTH * (s / ds.length / dt - P.danHz[q]));
    if (!usOn[P.fam[q]]) { P.danBase[q] = Math.max(hz, P.danBase[q] * bDec); P.g[q] = 0; continue; }
    const gq = Math.max(0, Math.min(1, (hz - P.danBase[q] - DAN_MARGIN) / DAN_SPAN));
    P.g[q] = gq; if (gq > 0) anyDan = true;
  }
  // 4) KC → MBON: 함께 → 억압, 도파민만 → 회복, 아주 느린 망각
  const fg = dt / FORGET_TAU;
  for (let s = 0; s < P.synJ.length; s++) {
    const j = P.synJ[s], o = orig[j];
    let r = weights[j] / o;
    if (anyDan) {
      const gq = P.g[P.synM[s]];
      if (gq > 0) {
        const ek = P.e[P.synK[s]];
        if (ek > 0.02) r -= LTD * gq * ek;
        else r += LTP * gq * (1 - r);
      }
    }
    if (r !== 1) r += (1 - r) * fg;
    if (r < W_FLOOR_MB) r = W_FLOOR_MB; else if (r > 1) r = 1;
    if (Math.abs(r - 1) < 1e-4) r = 1;
    weights[j] = o * r;
  }
  // 5) 내성
  P.tolE += (TOL_UP * ethanol * (TOL_MAX - P.tolE) - TOL_DOWN * P.tolE) * dt;
  P.tolN += (TOL_UP * nicotine * (TOL_MAX - P.tolN) - TOL_DOWN * P.tolN) * dt;
  // 6) 무조건 자극(US) → 도파민: 단맛·적당한 취기 → 보상(PAM), 쓴맛 → 처벌(PPL1).
  //    이 모델 연결만으로는 맛 뉴런이 PAM을 충분히 켜지 못해 직접 넣는다 (맛 뉴런이 지치면 약해짐).
  const effE = ethanol * (1 - P.tolE);
  const ethRew = effE > 0.02 ? Math.max(0, 1 - Math.abs(effE - 0.3) / 0.3) : 0;   // 알딸딸할 때 가장 크다
  const pamHz = Math.max(stimActive.sugar ? US_SUGAR * habOf('sugar') : 0, US_ETH * ethRew);
  const pplHz = stimActive.bitter ? US_BITTER * habOf('bitter') : 0;
  setUS('us-pam', P.pam, pamHz); setUS('us-ppl1', P.ppl1, pplHz);
  P.us.pam = pamHz; P.us.ppl1 = pplHz;
  spkWin.fill(0);
  if (++P.win % 4 === 0) postMessage({ type: 'plasticStats', ...plasticStats() });
}

function setUS(key, idx, hz) {
  if (hz > 0.5) stimActive[key] = { idx, rate: hz };
  else delete stimActive[key];
}

// KC 가중 벡터 w로 본 기억: 좋아함(회피 MBON 입력이 준 비율) − 싫어함(다가가기 MBON 입력이 준 비율)
function memoryFor(w) {
  const P = pl;
  let lA = 0, oA = 0, lP = 0, oP = 0;
  for (let s = 0; s < P.synJ.length; s++) {
    const wk = w[P.synK[s]];
    if (!(wk > 0)) continue;
    const j = P.synJ[s], loss = (orig[j] - weights[j]) / orig[j];   // 0..0.85
    if (P.val[P.synM[s]] < 0) { lA += wk * loss; oA += wk; } else { lP += wk * loss; oP += wk; }
  }
  const sat = 1 - W_FLOOR_MB;
  const like = oA ? lA / oA / sat : 0, dislike = oP ? lP / oP / sat : 0;
  return { like, dislike, pref: like - dislike };
}

function plasticStats() {
  const P = pl;
  const hab = {};
  for (const k in P.sens) hab[k] = 1 - habOf(k);
  const mem = {};
  for (const k in P.cs) mem[k] = { ...memoryFor(P.cs[k].code), strength: P.cs[k].strength, act: P.act[k] || 0 };
  let eSum = 0;
  for (let q = 0; q < P.e.length; q++) eSum += P.e[q];
  const live = eSum > 2 ? memoryFor(P.e) : { like: 0, dislike: 0, pref: 0 };
  let memSyn = 0;
  for (let s = 0; s < P.synJ.length; s++) if (weights[P.synJ[s]] / orig[P.synJ[s]] < 0.98) memSyn++;
  let habSyn = 0, habN = 0;
  for (let q = 0; q < P.sIdx.length; q++) if (P.hg[q] < 0.95) { habN++; habSyn += indptr[P.sIdx[q] + 1] - indptr[P.sIdx[q]]; }
  const dan = {};
  for (const f of ['PAM', 'PPL1']) {
    let hz = 0, base = 0, g = 0, c = 0;
    for (let q = 0; q < P.mbon.length; q++) if (P.fam[q] === f && P.famDan[q].length) { hz += P.danHz[q]; base += P.danBase[q]; g += P.g[q]; c++; }
    dan[f] = { hz: hz / c, base: base / c, g: g / c };
  }
  return { hab, mem, live: { ...live, kc: eSum }, tolE: P.tolE, tolN: P.tolN, dan,
           memSyn, memTotal: P.synJ.length, habN, habSyn, us: { ...P.us } };
}

function plasticReset(what) {
  const P = pl;
  if (!P) return;
  if (what === 'all' || what === 'mem') {
    for (let s = 0; s < P.synJ.length; s++) weights[P.synJ[s]] = orig[P.synJ[s]];
    P.e.fill(0);
  }
  if (what === 'all' || what === 'hab') { P.hg.fill(1); for (let q = 0; q < P.sIdx.length; q++) if (P.hgOn[q] !== 1) applyHab(q); }
  if (what === 'all' || what === 'tol') { P.tolE = 0; P.tolN = 0; }
  postMessage({ type: 'plasticStats', ...plasticStats() });
}

// 오래 가는 기억만 저장: KC → MBON 세기(원래와 다른 것)와 내성. 습관화는 단기라 저장하지 않는다.
function exportMem() {
  const P = pl;
  if (!P) return { idx: new Uint32Array(0), val: new Float32Array(0), tolE: 0, tolN: 0 };
  const idx = [], val = [];
  for (let s = 0; s < P.synJ.length; s++) { const j = P.synJ[s]; if (weights[j] !== orig[j]) { idx.push(j); val.push(weights[j]); } }
  return { idx: Uint32Array.from(idx), val: Float32Array.from(val), tolE: P.tolE, tolN: P.tolN };
}

function importMem(m) {
  const P = pl;
  if (!P) return 0;
  for (let s = 0; s < P.synJ.length; s++) weights[P.synJ[s]] = orig[P.synJ[s]];
  const ok = new Set(P.synJ);
  let k = 0;
  const idx = m.idx || [], val = m.val || [];
  for (let q = 0; q < idx.length; q++) {
    const j = idx[q];
    if (!ok.has(j)) continue;
    weights[j] = orig[j] * Math.max(W_FLOOR_MB, Math.min(1, val[q] / orig[j]));
    k++;
  }
  P.tolE = Math.max(0, Math.min(TOL_MAX, +m.tolE || 0));
  P.tolN = Math.max(0, Math.min(TOL_MAX, +m.tolN || 0));
  postMessage({ type: 'plasticStats', ...plasticStats() });
  return k;
}
