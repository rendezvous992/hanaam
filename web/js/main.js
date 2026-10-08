// 앱 오케스트레이션: 데이터 로드 → 렌더러 + 시뮬레이션 워커 연결 → UI 바인딩
import { BrainRenderer } from './render.js';
import { Fly } from './fly.js';
import { Fly3D } from './fly3d.js';
import { fetchBin, loadVision } from './data.js';
import { FlyEye } from './vision.js';
import { Lab } from './lab.js';
import { OmokArena } from './arena.js';

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


async function main() {
  const status = $('loading');
  try {
    status.textContent = '커넥톰 데이터 로드 중… (약 18MB)';
    const [meta, posBuf, groupBuf, indptrBuf, targetsBuf, weightsBuf] = await Promise.all([
      fetch('data/meta.json').then(r => r.json()),
      fetchBin('data/positions_u16.bin'),
      fetchBin('data/group_u8.bin'),
      fetchBin('data/csr_indptr_u32.bin'),
      fetchBin('data/csr_targets_u32.bin'),
      fetchBin('data/csr_weights_i16.bin'),
    ]);
    const n = meta.n_neurons;
    const group = new Uint8Array(groupBuf);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const c = PALETTE[meta.super_classes[group[i]]] || PALETTE.unknown;
      colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
    }

    const renderer = new BrainRenderer($('brain'), new Uint16Array(posBuf), colors, n);

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
    const spark = $('spark').getContext('2d');
    const history = new Array(120).fill(0);
    let emaRate = 0;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type !== 'frame') return;
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
      $('stat-time').textContent = (m.timeMs / 1000).toFixed(2) + ' s';
      $('stat-rate').textContent = Math.round(emaRate).toLocaleString();
      $('stat-active').textContent = m.active.toLocaleString();
      history.push(Math.min(1, emaRate / 1000000));
      history.shift();
      spark.clearRect(0, 0, 240, 48);
      spark.strokeStyle = '#ffcf5e';
      spark.lineWidth = 1.5;
      spark.beginPath();
      history.forEach((v, i) => {
        const x = i * 2, y = 46 - v * 44;
        i ? spark.lineTo(x, y) : spark.moveTo(x, y);
      });
      spark.stroke();
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
      };
      stimBox.appendChild(b);
    }

    // ── 행동 제어: 명령 뉴런 자극 (꾹 누르는 동안) ──────
    const cmdBox = $('commands');
    const CMDS = [
      ['fwd', '전진', 'DNp09 ×' + readouts[0].length],
      ['back', '문워크', 'MDN ×' + readouts[1].length],
      ['jump', '점프', 'Giant Fiber ×' + readouts[2].length],
      ['prob', '주둥이', '운동뉴런 ×' + readouts[3].length],
    ];
    CMDS.forEach(([key, label, sub], i) => {
      const b = document.createElement('button');
      b.className = 'stim cmd';
      b.innerHTML = `${label}<span>${sub}</span>`;
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
    $('rate').oninput = e => {
      $('rate-val').textContent = e.target.value + ' Hz';
      send({ stimRate: +e.target.value });
    };
    $('ethanol').oninput = e => {
      const v = +e.target.value / 100;
      $('ethanol-val').textContent = v === 0 ? '맨정신' :
        v < 0.3 ? '알딸딸 🍺' : v < 0.6 ? '취함 🍺🍺' :
        v < 0.85 ? '만취 🍺🍺🍺' : '필름 끊김 💫';
      send({ ethanol: v });
      fly.setEthanol(v);
      $('fly-sub').textContent = v === 0 ? '행동 (뇌 → 몸)' :
        `혈중 에탄올 ${(v * 0.4).toFixed(2)} g/dL`;
    };
    $('nicotine').oninput = e => {
      const v = +e.target.value / 100;
      $('nic-val').textContent = v === 0 ? '안 피움' :
        v < 0.35 ? '한 모금 🚬' : v < 0.7 ? '체인스모커 🚬🚬' : '골초 🚬🚬🚬';
      send({ nicotine: v });
      fly.setNicotine(v);
    };
    $('speed').oninput = e => {
      $('speed-val').textContent = '×' + e.target.value;
      send({ speed: +e.target.value });
    };
    let running = true;
    $('pause').onclick = () => {
      running = !running;
      $('pause').textContent = running ? '일시정지' : '재생';
      send({ running });
    };
    $('reset').onclick = () => worker.postMessage({ type: 'reset' });
    // ── 확대·축소 막대: 0 = 가장 멀리, 100 = 가장 가까이 (거리는 로그 눈금) ──
    const zoomBar = $('zoom-bar');
    const distToBar = d => Math.round(100 * Math.log(renderer.distMax / d) / Math.log(renderer.distMax / renderer.distMin));
    const barToDist = v => renderer.distMax * Math.pow(renderer.distMin / renderer.distMax, v / 100);
    zoomBar.value = distToBar(renderer.dist);
    zoomBar.oninput = () => renderer.setDist(barToDist(+zoomBar.value), true);
    renderer.onZoom = d => { zoomBar.value = distToBar(d); };
    const nudge = k => { renderer.setDist(renderer.dist * k); };
    $('zoom-in').onclick = () => nudge(0.85);
    $('zoom-out').onclick = () => nudge(1 / 0.85);
    $('rotate').onclick = () => {
      renderer.autoRotate = !renderer.autoRotate;
      $('rotate').classList.toggle('on', renderer.autoRotate);
    };
    // ── 실험실 버튼 ──────────────────────────────────
    const LAB_NOTE = {
      tv: '화면을 R1-6 광수용체 8,456개의 발화로 바꿔 넣습니다. 오른쪽은 수용장을 측정한 시각 뉴런 2,670개의 반응을 그 뉴런이 보는 위치에 그린 것입니다.',
      pong: '패들은 초파리 뇌가 움직입니다: 시각 뉴런이 공을 가장 강하게 본 위치로 갑니다(정위 반응, 학습된 디코더 없음). 치면 설탕 + 보상 도파민, 놓치면 쓴맛 + 처벌 도파민.',
    };
    const setLab = mode => {
      if (!lab) return;
      const next = lab.mode === mode ? 'off' : mode;
      lab.setMode(next);
      $('lab-tv').classList.toggle('on', next === 'tv');
      $('lab-pong').classList.toggle('on', next === 'pong');
      $('lab-card').hidden = next === 'off';
      $('lab-channels').hidden = next !== 'tv';
      $('lab-title').textContent = next === 'pong' ? '초파리 탁구' : '초파리 TV';
      $('lab-note').textContent = LAB_NOTE[next] || '';
      if (next === 'pong') lab.resetPong();
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
    const labScreen = $('lab-screen').getContext('2d'), labSeen = $('lab-seen').getContext('2d');
    let labDrawn = 0;
    const drawLabCard = now => {
      if (!lab || lab.mode === 'off' || now - labDrawn < 80) return;
      labDrawn = now;
      labScreen.drawImage(lab.screen, 0, 0);
      lab.eye.drawPerceived(labSeen);
      if (lab.mode === 'pong') {
        const st = lab.stats();
        $('lab-stats').textContent = `맞힘 ${st.hits} · 놓침 ${st.misses}` +
          (st.n ? ` · 최근 ${st.n}회 ${Math.round(st.rate * 100)}%` : '');
      } else $('lab-stats').textContent = '';
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

    status.style.display = 'none';
    $('panel').classList.add('ready');
  } catch (err) {
    status.innerHTML = `로드 실패: ${err.message}<br><small>이 페이지는 로컬 서버로 열어야 합니다.<br>
      <code>cd web && python3 -m http.server 8000</code> 후 <code>http://localhost:8000</code> 접속</small>`;
    console.error(err);
  }
}

main();
