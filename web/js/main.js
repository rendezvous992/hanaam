// 앱 오케스트레이션: 데이터 로드 → 렌더러 + 시뮬레이션 워커 연결 → UI 바인딩
import { BrainRenderer } from './render.js';
import { Fly } from './fly.js';
import { Fly3D } from './fly3d.js';
import { fetchBin, loadVision } from './data.js';
import { FlyEye } from './vision.js';
import { Lab } from './lab.js';
import { OmokArena } from './arena.js';
import { Experience } from './experience.js';

// 행동 판독 그룹 순서 (워커의 비트마스크 순서와 일치해야 함)
const READOUT_KEYS = ['fwd', 'back', 'jump', 'prob', 'dn', 'motor'];

const PALETTE = {
  optic:              [0.35, 0.45, 0.95],
  central:            [0.85, 0.55, 0.95],
  sensory:            [0.30, 0.95, 0.65],
  visual_projection:  [0.40, 0.75, 0.98],
  ascending:          [0.95, 0.75, 0.35],
  descending:         [0.98, 0.45, 0.35],
  sensory_ascending:  [0.45, 0.95, 0.85],
  visual_centrifugal: [0.60, 0.60, 0.98],
  motor:              [0.98, 0.35, 0.65],
  endocrine:          [0.95, 0.90, 0.45],
  unknown:            [0.55, 0.55, 0.60],
};

const $ = id => document.getElementById(id);

// ── 화면 표시 도우미 (시뮬레이션과 무관) ─────────────
const MB = b => (b / 1e6).toFixed(1);
// 슬라이더 채워진 구간 (CSS --p, WebKit 트랙 그라디언트용)
const fill = el => el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%');
// 에탄올 단계 이름 (경기장 카드와 같은 눈금)
const ethanolWord = v => v === 0 ? '맨정신' : v < 0.3 ? '알딸딸' : v < 0.6 ? '취함' : v < 0.85 ? '만취' : '인사불성';
const nicotineWord = v => v === 0 ? '안 피움' : v < 0.35 ? '한 모금' : v < 0.7 ? '한 개비' : '줄담배';

// 진행률을 알리며 바이너리를 받는다. 스트림을 못 쓰거나 .bin이 없으면 data.js의 fetchBin(.b64.txt 폴백)으로.
async function fetchBinTracked(url, progress) {
  let r;
  try { r = await fetch(url); } catch { r = null; }
  if (r && !r.ok) {
    // .bin을 서빙하지 않는 호스팅(이 아티팩트 등): base64 텍스트도 받은 만큼 진행률에 센다
    let r2;
    try { r2 = await fetch(url + '.b64.txt'); } catch { r2 = null; }
    if (r2 && r2.ok && r2.body && r2.body.getReader) {
      const txt = new TextDecoder().decode(await readTracked(r2, progress)).replace(/\s+/g, '');
      const bin = atob(txt), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8.buffer;
    }
    return fetchBin(url);
  }
  if (!r || !r.body || !r.body.getReader) return fetchBin(url);
  return (await readTracked(r, progress)).buffer;
}

// 응답 본문을 조각조각 읽으며 진행률을 올린다
async function readTracked(r, progress) {
  const len = +r.headers.get('content-length') || 0;
  progress.total += len;
  const reader = r.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    progress.add(value.length);
  }
  if (!len) progress.total += got;
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}


async function main() {
  const status = $('loading');
  const step = $('loading-step'), bar = $('loading-bar');
  try {
    // 커넥톰 약 17.7MB — 받은 양 / 전체 양 (전체는 응답 헤더가 도착하는 대로 더해진다)
    const progress = {
      got: 0, total: 0, shown: 0,
      add(n) {
        this.got += n;
        const now = performance.now();
        if (now - this.shown < 60) return;
        this.shown = now;
        const total = Math.max(this.total, this.got, 17.7e6);
        step.textContent = `커넥톰 데이터 ${MB(this.got)} / ${MB(total)} MB`;
        bar.style.width = Math.min(100, this.got / total * 100) + '%';
      },
    };
    step.textContent = '커넥톰 데이터를 불러오는 중…';
    // 버섯체 학습 회로 (경험 모드) — 없으면 경험 섹션만 숨긴다
    const mbP = fetch('data/mb.json').then(r => r.ok ? r.json() : null).catch(() => null);
    const [meta, posBuf, groupBuf, indptrBuf, targetsBuf, weightsBuf] = await Promise.all([
      fetch('data/meta.json').then(r => r.json()),
      fetchBinTracked('data/positions_u16.bin', progress),
      fetchBinTracked('data/group_u8.bin', progress),
      fetchBinTracked('data/csr_indptr_u32.bin', progress),
      fetchBinTracked('data/csr_targets_u32.bin', progress),
      fetchBinTracked('data/csr_weights_i16.bin', progress),
    ]);
    bar.style.width = '100%';
    step.textContent = '뇌 모델을 준비하는 중…';
    await new Promise(r => setTimeout(r, 30));   // 문구가 한 번 그려질 틈
    const n = meta.n_neurons;
    const group = new Uint8Array(groupBuf);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const c = PALETTE[meta.super_classes[group[i]]] || PALETTE.unknown;
      colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
    }

    const renderer = new BrainRenderer($('brain'), new Uint16Array(posBuf), colors, n);
    // 처음 거리는 render.js가 창 비율로 정한다. 폰에서는 뇌 캔버스가 화면 가운데 띠라서
    // 캔버스 비율로 다시 맞춘다 (같은 공식).
    {
      const c = $('brain'), asp = c.clientWidth / Math.max(c.clientHeight, 1);
      if (Math.abs(asp - innerWidth / Math.max(innerHeight, 1)) > 0.05)
        renderer.setDist(asp >= 1 ? 4.4 : 4.4 / Math.max(asp, 0.4) * 0.75, true);
    }

    // 뉴런 모폴로지(실제 3D 가지 형태) — 주요 뉴런 131개, 발화 시 번쩍임
    // (?noskel 로 끌 수 있음 — GPU 없는 환경/테스트용)
    renderer.showSkel = !location.search.includes('noskel');
    $('skel').classList.toggle('on', renderer.showSkel);
    const skelCap = location.search.match(/skelmax=(\d+)/);
    if (skelCap) renderer.skelMax = +skelCap[1];
    if (meta.skeletons && meta.skeletons.length) {
      fetchBin('data/skel_pos_u16.bin')
        .then(buf => renderer.setSkeletons(new Uint16Array(buf), meta.skeletons))
        .catch(err => console.warn('스켈레톤 로드 실패:', err));
    }

    const readouts = READOUT_KEYS.map(k => (meta.readouts && meta.readouts[k]) ? meta.readouts[k].idx : []);
    const worker = new Worker('js/sim-worker.js');
    worker.postMessage({
      type: 'init', n,
      indptr: indptrBuf, targets: targetsBuf, weights: weightsBuf,
      readouts,
    }, [indptrBuf, targetsBuf, weightsBuf]);

    // ── 초파리 아바타: 3D 우선, 실패 시 SVG 폴백 ────────
    let fly;
    try {
      fly = new Fly3D($('fly-svg'));
    } catch (err) {
      console.warn('3D 아바타 초기화 실패, SVG로 폴백:', err);
      fly = new Fly($('fly-svg'));
    }
    const rates = { fwd: 0, back: 0, jump: 0, prob: 0, dn: 0, motor: 0 };
    window.__fly = fly;   // 테스트용

    // ── 경험과 변화: 습관화·냄새 기억·내성 (워커의 경험 모드) ──
    const exp = new Experience({ worker, fly, meta });
    window.__exp = exp;
    mbP.then(mb => {
      // ?noexp: 경험 모드 없이 (연결체 그대로인 뇌 — 비교·테스트용)
      if (!mb || location.search.includes('noexp')) { $('exp').hidden = true; return; }
      const sensory = Object.fromEntries(Object.entries(meta.presets).map(([k, p]) => [k, p.idx]));
      worker.postMessage({ type: 'plastic', sensory, ...mb });
    });

    // ── 실험실(TV·탁구)과 오목 경기장: 초파리 눈 데이터가 있어야 켜진다 ──
    let lab = null, arena = null, arenaOpen = false;
    loadVision().then(vis => {
      lab = new Lab({ worker, eye: new FlyEye(vis), fly, meta, vis });
      arena = new OmokArena({
        n, positions: new Uint16Array(posBuf), vis, meta,
        // 경기장이 열려 있는 동안 메인 뇌·3D를 멈춰 두 뇌에 CPU를 몰아준다
        onOpen: () => { arenaOpen = true; document.body.classList.add('arena-open');
                        worker.postMessage({ type: 'params', running: false }); },
        onClose: () => { arenaOpen = false; document.body.classList.remove('arena-open');
                         worker.postMessage({ type: 'params', running }); },
      });
      window.__lab = lab; window.__arena = arena;
    }).catch(err => {
      console.warn('초파리 눈 데이터 로드 실패 — 실험실 비활성:', err);
      for (const id of ['lab-tv', 'lab-pong', 'lab-omok', 'lab-pongduel']) $(id).disabled = true;
    });

    // ── 통계 + 스파크라인 ───────────────────────────────
    const sparkEl = $('spark'), spark = sparkEl.getContext('2d');
    const rootCss = getComputedStyle(document.documentElement);
    const tok = (name, fb) => rootCss.getPropertyValue(name).trim() || fb;
    const SPARK = {
      accent: tok('--accent', '#f0b64e'), line: tok('--line', 'rgba(160,178,220,.12)'),
      faint: tok('--faint', '#78819a'), font: tok('--font-ui', 'sans-serif'),
      w: 0, h: 0,
    };
    const sizeSpark = () => {
      const w = sparkEl.clientWidth, h = sparkEl.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      sparkEl.width = Math.round(w * dpr); sparkEl.height = Math.round(h * dpr);
      spark.setTransform(dpr, 0, 0, dpr, 0, 0);
      SPARK.w = w; SPARK.h = h;
    };
    // 0.1초마다 한 칸 → 최근 12초 (워커 프레임 수와 무관하게 같은 시간 폭)
    const HIST = 120, SAMPLE_MS = 100;
    const history = new Array(HIST).fill(0), stamps = new Array(HIST).fill(0);
    let lastSample = 0;
    const drawSpark = () => {
      if (!SPARK.w) sizeSpark();
      const { w: W, h: H } = SPARK;
      if (!W) return;
      const g = spark, IN = 6, top = 20, bot = H - IN;
      g.clearRect(0, 0, W, H);
      const peak = Math.max(...history);
      const max = Math.max(peak, 1000) * 1.2;
      // 가는 눈금선 두 개 (위·가운데)
      g.strokeStyle = SPARK.line; g.lineWidth = 1;
      g.beginPath();
      for (const y of [top, (top + bot) / 2]) { g.moveTo(IN, Math.round(y) + 0.5); g.lineTo(W - IN, Math.round(y) + 0.5); }
      g.stroke();
      // 라벨: 왼쪽 무엇인지, 오른쪽 구간 최댓값
      const first = stamps.find(t => t > 0);
      const span = first ? Math.max(1, Math.round((stamps[HIST - 1] - first) / 1000)) : 0;
      g.font = `400 10px ${SPARK.font}`;
      if (g.fontVariantNumeric !== undefined) g.fontVariantNumeric = 'tabular-nums';
      g.fillStyle = SPARK.faint; g.textBaseline = 'top';
      g.textAlign = 'left';
      g.fillText(span ? `스파이크/초 · 최근 ${span}초` : '스파이크/초', IN, IN - 1);
      g.textAlign = 'right';
      g.fillText(`최대 ${Math.round(peak).toLocaleString()}`, W - IN, IN - 1);
      // 선 + 옅은 면
      const x = i => IN + (W - 2 * IN) * i / (HIST - 1);
      const y = v => bot - (bot - top) * Math.min(1, v / max);
      g.beginPath();
      history.forEach((v, i) => i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)));
      g.lineTo(x(HIST - 1), bot); g.lineTo(x(0), bot); g.closePath();
      g.globalAlpha = 0.12; g.fillStyle = SPARK.accent; g.fill(); g.globalAlpha = 1;
      g.beginPath();
      history.forEach((v, i) => i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)));
      g.strokeStyle = SPARK.accent; g.lineWidth = 1.25; g.lineJoin = 'round';
      g.stroke();
    };
    addEventListener('resize', () => { SPARK.w = 0; });
    const live = $('live');
    let emaRate = 0;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type !== 'frame') { exp.onMessage(m); return; }
      const glow = new Uint8Array(m.glow);
      renderer.updateGlow(glow);
      worker.postMessage({ type: 'buffer', buf: m.glow }, [m.glow]);
      lab?.onFrame(m);

      // 판독 그룹 발화율 (Hz/뉴런, 지수평활). brain = 전뇌 평균 —
      // 전뇌 점화 파도에 휩쓸린 발화와 진짜 명령 신호를 구분하는 기준선.
      if (m.counts && m.simMs > 0) {
        const sec = m.simMs / 1000;
        READOUT_KEYS.forEach((k, g) => {
          const sz = readouts[g].length || 1;
          rates[k] = rates[k] * 0.88 + (m.counts[g] / sz / sec) * 0.12;
        });
        rates.brain = (rates.brain || 0) * 0.88 + (m.spikes / n / sec) * 0.12;
        fly.setRates(rates);
      }

      const rate = m.simMs > 0 ? m.spikes / (m.simMs / 1000) : 0;
      emaRate = emaRate * 0.9 + rate * 0.1;
      const tTxt = (m.timeMs / 1000).toFixed(2) + ' s';
      const rTxt = Math.round(emaRate).toLocaleString(), aTxt = m.active.toLocaleString();
      $('stat-time').textContent = tTxt;
      $('stat-rate').textContent = rTxt;
      $('stat-active').textContent = aTxt;
      live.textContent = `${tTxt} · ${rTxt} 스파이크/초 · 활성 뉴런 ${aTxt}`;
      const tNow = performance.now();
      if (tNow - lastSample >= SAMPLE_MS) {
        lastSample = tNow;
        history.push(emaRate); history.shift();
        stamps.push(tNow); stamps.shift();
        drawSpark();
      }
    };

    // ── 자극 프리셋 버튼 ───────────────────────────────
    const stimBox = $('stimuli');
    for (const [key, p] of Object.entries(meta.presets)) {
      if (!p.idx.length) continue;
      const b = document.createElement('button');
      b.className = 'stim';
      // 이름 '설탕맛 (당분 GRN)' → 큰 글씨 '설탕맛', 작은 줄 '당분 GRN · 뉴런 23개' (버튼 폭을 넘지 않게)
      const m = p.name_ko.match(/^(.*?)\s*\((.*)\)\s*$/);
      const main = m ? m[1] : p.name_ko, detail = m ? `<em>${m[2]}</em> · ` : '';
      b.innerHTML = `${main}<span>${detail}<em>${p.idx.length.toLocaleString()}개</em></span>`;
      b.onclick = () => {
        const on = !b.classList.contains('on');
        b.classList.toggle('on', on);
        worker.postMessage({ type: 'stim', key, on, indices: p.idx });
        if (key === 'smell') exp.setSmell(on);
      };
      stimBox.appendChild(b);
    }

    // ── 행동 제어: 명령 뉴런 자극 (꾹 누르는 동안) ──────
    const cmdBox = $('commands');
    // 아래 줄 표기는 감각 자극 버튼('당분 GRN · 23개')과 같게
    const CMDS = [
      ['fwd', '전진', 'DNp09', readouts[0].length],
      ['back', '뒷걸음', 'MDN', readouts[1].length],
      ['jump', '점프', 'Giant Fiber', readouts[2].length],
      ['prob', '주둥이 뻗기', '운동뉴런', readouts[3].length],
    ];
    CMDS.forEach(([key, label, who, count]) => {
      const b = document.createElement('button');
      b.className = 'stim cmd';
      b.innerHTML = `${label}<span><em>${who}</em> · <em>${count.toLocaleString()}개</em></span>`;
      const set = on => {
        b.classList.toggle('on', on);
        worker.postMessage({ type: 'stim', key: 'cmd-' + key, on, rate: 130,
                             indices: readouts[READOUT_KEYS.indexOf(key)] });
      };
      b.addEventListener('pointerdown', e => { e.preventDefault(); set(true); });
      b.addEventListener('pointerup', () => set(false));
      b.addEventListener('pointerleave', () => set(false));
      b.addEventListener('contextmenu', e => e.preventDefault());
      cmdBox.appendChild(b);
    });

    // ── 슬라이더 / 버튼 ───────────────────────────────
    const send = p => worker.postMessage({ type: 'params', ...p });
    for (const id of ['rate', 'ethanol', 'nicotine', 'speed', 'zoom-bar']) {
      const el = $(id);
      fill(el);
      el.addEventListener('input', () => fill(el));
    }
    $('rate').oninput = e => {
      $('rate-val').textContent = e.target.value + ' Hz';
      send({ stimRate: +e.target.value });
    };
    $('ethanol').oninput = e => {
      const v = +e.target.value / 100;
      $('ethanol-val').textContent = ethanolWord(v);
      send({ ethanol: v });
      exp.setDrugs(v, undefined);      // 3D 초파리에는 내성만큼 덜 듣는다
      $('fly-sub').textContent = v === 0 ? '행동 (뇌 → 몸)' :
        `혈중 에탄올 ${(v * 0.4).toFixed(2)} g/dL`;
    };
    $('nicotine').oninput = e => {
      const v = +e.target.value / 100;
      $('nic-val').textContent = nicotineWord(v);
      send({ nicotine: v });
      exp.setDrugs(undefined, v);
    };
    $('speed').oninput = e => {
      $('speed-val').textContent = '×' + e.target.value;
      send({ speed: +e.target.value });
    };
    let running = true;
    $('pause').onclick = () => {
      running = !running;
      // 다른 토글처럼: 멈춰 있는 동안 켜진(호박색) 상태로 보인다
      $('pause').classList.toggle('on', !running);
      $('pause').setAttribute('aria-pressed', String(!running));
      send({ running });
    };
    $('reset').onclick = () => worker.postMessage({ type: 'reset' });
    // ── 확대·축소 막대: 0 = 가장 멀리, 100 = 가장 가까이 (거리는 로그 눈금) ──
    const zoomBar = $('zoom-bar');
    const distToBar = d => Math.round(100 * Math.log(renderer.distMax / d) / Math.log(renderer.distMax / renderer.distMin));
    const barToDist = v => renderer.distMax * Math.pow(renderer.distMin / renderer.distMax, v / 100);
    zoomBar.value = distToBar(renderer.dist);
    fill(zoomBar);
    zoomBar.oninput = () => renderer.setDist(barToDist(+zoomBar.value), true);
    renderer.onZoom = d => { zoomBar.value = distToBar(d); fill(zoomBar); };
    const nudge = k => { renderer.setDist(renderer.dist * k); };
    $('zoom-in').onclick = () => nudge(0.85);
    $('zoom-out').onclick = () => nudge(1 / 0.85);
    $('rotate').onclick = () => {
      renderer.autoRotate = !renderer.autoRotate;
      $('rotate').classList.toggle('on', renderer.autoRotate);
    };
    // ── 실험실 버튼 ──────────────────────────────────
    const LAB_NOTE = {
      tv: '화면 밝기를 R1-6 광수용체 8,456개의 발화로 바꿔 넣습니다. 오른쪽은 수용장을 측정한 시각 뉴런 2,670개의 반응을 각 뉴런이 보는 위치에 그린 것입니다.',
      pong: '라켓은 초파리 뇌가 직접 움직입니다. 시각 뉴런이 공을 가장 강하게 본 쪽으로 라켓이 갑니다(정위 반응, 학습된 디코더 없음). 받아내면 단맛과 보상 도파민을, 놓치면 쓴맛과 처벌 도파민을 줍니다.',
    };
    // 실험실 캔버스: 표시 크기 × 화면 배율로 해상도를 맞춘다. 160×120 원본을 1.07배 같은
    // 어중간한 배율로 픽셀 그대로 불리면 공과 라켓이 고르지 않게 일그러져 보인다.
    const labScreenEl = $('lab-screen'), labSeenEl = $('lab-seen');
    const labScreen = labScreenEl.getContext('2d'), labSeenCtx = labSeenEl.getContext('2d');
    const SRC_W = 160, SRC_H = 120;
    // vision.js drawPerceived는 ctx.canvas 크기를 160×120 좌표로 보고 그린다 → 같은 좌표로 그리고 확대만 한다
    const labSeen = new Proxy(labSeenCtx, {
      get(t, k) {
        if (k === 'canvas') return { width: SRC_W, height: SRC_H };
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
      set(t, k, v) { t[k] = v; return true; },
    });
    const sizeLabCanvases = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      for (const el of [labScreenEl, labSeenEl]) {
        const w = Math.round(el.clientWidth * dpr), h = Math.round(el.clientHeight * dpr);
        if (w && h && (el.width !== w || el.height !== h)) { el.width = w; el.height = h; }
      }
      labSeenCtx.setTransform(labSeenEl.width / SRC_W, 0, 0, labSeenEl.height / SRC_H, 0, 0);
    };
    // 데스크톱: 제목(부제가 두 줄이 되어도) 바로 아래에 카드를 둔다. 폰은 CSS 위치 그대로.
    const placeLabCard = () => {
      const card = $('lab-card');
      if (innerWidth <= 720) { card.style.top = ''; return; }
      const hb = document.querySelector('header').getBoundingClientRect().bottom;
      card.style.top = Math.max(112, Math.round(hb + 14)) + 'px';
    };
    addEventListener('resize', () => { if (lab && lab.mode !== 'off') { placeLabCard(); sizeLabCanvases(); } });
    const setLab = mode => {
      if (!lab) return;
      const next = lab.mode === mode ? 'off' : mode;
      lab.setMode(next);
      $('lab-tv').classList.toggle('on', next === 'tv');
      $('lab-pong').classList.toggle('on', next === 'pong');
      $('lab-card').hidden = next === 'off';
      $('lab-channels').hidden = next !== 'tv';
      $('lab-title').textContent = next === 'pong' ? '탁구 연습' : '초파리 TV';
      $('lab-note').textContent = LAB_NOTE[next] || '';
      $('lab-stats').textContent = '';
      document.body.classList.toggle('lab-on', next !== 'off');
      if (next === 'pong') lab.resetPong();
      // 카드 크기·초파리 카드 크기가 바뀌었으니 캔버스들(3D 포함)이 새 크기를 다시 재게 한다
      if (next !== 'off') { placeLabCard(); sizeLabCanvases(); }
      dispatchEvent(new Event('resize'));
      labDrawn = 0;
    };
    $('lab-tv').onclick = () => setLab('tv');
    $('lab-pong').onclick = () => setLab('pong');
    $('lab-omok').onclick = () => arena?.open('omok');
    $('lab-pongduel').onclick = () => arena?.open('pong');
    for (const b of document.querySelectorAll('#lab-channels button')) {
      b.onclick = () => {
        if (lab) lab.channel = b.dataset.ch;
        for (const o of document.querySelectorAll('#lab-channels button')) o.classList.toggle('on', o === b);
      };
    }
    let labDrawn = 0;
    const drawLabCard = now => {
      if (!lab || lab.mode === 'off' || now - labDrawn < 80) return;
      labDrawn = now;
      labScreen.imageSmoothingEnabled = true;
      labScreen.imageSmoothingQuality = 'high';
      labScreen.drawImage(lab.screen, 0, 0, labScreenEl.width, labScreenEl.height);
      lab.eye.drawPerceived(labSeen);
      if (lab.mode === 'pong') {
        const st = lab.stats();
        $('lab-stats').textContent = `받아냄 ${st.hits} · 놓침 ${st.misses}` +
          (st.n ? ` · 최근 ${st.n}번 ${Math.round(st.rate * 100)}%` : '');
      }
    };

    $('skel').onclick = () => {
      renderer.showSkel = !renderer.showSkel;
      $('skel').classList.toggle('on', renderer.showSkel);
    };

    // ── 렌더 루프 ─────────────────────────────────────
    const caption = $('fly-caption');
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      if (!arenaOpen) {
        renderer.draw(dt);
        lab?.tick(dt, now);
        caption.textContent = fly.update(dt);
        drawLabCard(now);
      }
      last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    // ── 패널 스크롤 신호: 아래에 더 있으면 아래 가장자리를 흐리게 ──
    const panel = $('panel');
    const moreCheck = () => panel.classList.toggle('more', panel.scrollTop + panel.clientHeight < panel.scrollHeight - 4);
    panel.addEventListener('scroll', moreCheck, { passive: true });
    addEventListener('resize', moreCheck);
    moreCheck();

    // 터치 화면이면 조작 안내를 손가락 기준으로
    if (matchMedia('(pointer: coarse)').matches) $('hint-input').textContent = '한 손가락으로 회전, 두 손가락으로 확대';

    status.classList.add('done');
    setTimeout(() => { status.style.display = 'none'; }, 450);
    document.body.classList.add('ready');
    panel.classList.add('ready');
  } catch (err) {
    status.classList.remove('done');
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    status.innerHTML = `<b>불러오기 실패</b><span>${esc(err.message)}</span><small>이 페이지는 로컬 서버로 열어야 합니다.<br>
      <code>cd web && python3 -m http.server 8000</code> 후 <code>http://localhost:8000</code> 접속</small>`;
    console.error(err);
  }
}

main();
