// 앱 오케스트레이션: 데이터 로드 → 렌더러 + 시뮬레이션 워커 연결 → UI 바인딩
import { BrainRenderer } from './render.js';

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

async function fetchBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

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

    const worker = new Worker('js/sim-worker.js');
    worker.postMessage({
      type: 'init', n,
      indptr: indptrBuf, targets: targetsBuf, weights: weightsBuf,
    }, [indptrBuf, targetsBuf, weightsBuf]);

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
    const EMOJI = { sugar: '🍬', bitter: '☕', smell: '👃', sight: '💡',
                    sound: '🔊', temp: '🌡️', humid: '💧', touch: '🖐️' };
    for (const [key, p] of Object.entries(meta.presets)) {
      if (!p.idx.length) continue;
      const b = document.createElement('button');
      b.className = 'stim';
      b.innerHTML = `${EMOJI[key] || '⚡'} ${p.name_ko}<span>${p.idx.length.toLocaleString()}개</span>`;
      b.onclick = () => {
        const on = !b.classList.contains('on');
        b.classList.toggle('on', on);
        worker.postMessage({ type: 'stim', key, on, indices: p.idx });
      };
      stimBox.appendChild(b);
    }

    // ── 슬라이더 / 버튼 ───────────────────────────────
    const send = p => worker.postMessage({ type: 'params', ...p });
    $('rate').oninput = e => {
      $('rate-val').textContent = e.target.value + ' Hz';
      send({ stimRate: +e.target.value });
    };
    $('ethanol').oninput = e => {
      const v = +e.target.value / 100;
      $('ethanol-val').textContent = v === 0 ? '맨정신' :
        v < 0.3 ? '알딸딸 🍺' : v < 0.6 ? '취함 🍺🍺' : '만취 🍺🍺🍺';
      send({ ethanol: v });
    };
    $('speed').oninput = e => {
      $('speed-val').textContent = '×' + e.target.value;
      send({ speed: +e.target.value });
    };
    let running = true;
    $('pause').onclick = () => {
      running = !running;
      $('pause').textContent = running ? '⏸ 일시정지' : '▶ 재생';
      send({ running });
    };
    $('reset').onclick = () => worker.postMessage({ type: 'reset' });
    $('rotate').onclick = () => {
      renderer.autoRotate = !renderer.autoRotate;
      $('rotate').classList.toggle('on', renderer.autoRotate);
    };

    // ── 렌더 루프 ─────────────────────────────────────
    let last = performance.now();
    const frame = (now) => {
      renderer.draw((now - last) / 1000);
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
