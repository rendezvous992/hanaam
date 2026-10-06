// ⚫ 초파리 오목 대결: 연결체 뇌 두 개(워커 두 개)가 직접 판을 보고 둔다.
//
// 수 선택(정위 반응): 판 그림을 그 초파리의 광수용체에 40ms 보여주고, 수용장을 아는
//   시각 뉴런 반응이 가장 강한 빈 칸에 둔다. 내 돌은 밝게, 상대 돌은 어둡게, 판 선은 희미하게
//   보인다. 수를 고르는 규칙·점수표·선생님은 없다 — 뇌 활동이 어디서 가장 크게 일어나는지가 전부다.
// 학습(조련사식 3요소 가소성): 🎓 훈련 판에서는 수가 놓일 때마다 조련사(심판)가 결과를 보고
//   좋은 일(5목·4·열린 3·상대 막기)이면 설탕 + 보상 도파민(PAM), 나쁜 일(이길 수 놓침·상대 5목
//   방치·동떨어진 수)이면 쓴맛 + 처벌 도파민(PPL1)을 준다. 그 수를 고르게 만든 시냅스 —
//   고른 칸을 보는 시각 뉴런으로 들어가며 방금 함께 발화한 입력 — 만 강화·약화된다.
//   조련사는 수를 대신 고르지 않는다. ▶ 공식 대결은 학습 없이 실력만 겨룬다.
import { loadWiring } from './data.js';
import { FlyEye, SCREEN_W, SCREEN_H } from './vision.js';

const N = 9;
const REGION = [0.15, 0.15, 0.85, 0.85];
const PROBE_TICKS = 80;                     // 40ms 반응
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
const inB = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 심판: 5목 판정 (1 흑 승, 2 백 승, 3 무승부, 0 진행 중)
function winner(board) {
  for (let c = 0; c < N * N; c++) {
    const p = board[c]; if (!p) continue;
    const x = c % N, y = (c / N) | 0;
    for (const [dx, dy] of DIRS) {
      let k = 1;
      while (k < 5 && inB(x + dx * k, y + dy * k) && board[(y + dy * k) * N + x + dx * k] === p) k++;
      if (k === 5) return p;
    }
  }
  return board.every(v => v) ? 3 : 0;
}

// 칸 c를 지나는 p의 가장 긴 연속과 열린 끝 수
function runInfo(board, c, p) {
  let best = { run: 0, open: 0 };
  const x0 = c % N, y0 = (c / N) | 0;
  for (const [dx, dy] of DIRS) {
    let run = 1, open = 0;
    for (const s of [1, -1]) {
      let x = x0 + dx * s, y = y0 + dy * s;
      while (inB(x, y) && board[y * N + x] === p) { run++; x += dx * s; y += dy * s; }
      if (inB(x, y) && !board[y * N + x]) open++;
    }
    if (run > best.run || (run === best.run && open > best.open)) best = { run, open };
  }
  return best;
}

function winningCells(board, p) {
  const out = [];
  for (let c = 0; c < N * N; c++) {
    if (board[c]) continue;
    board[c] = p;
    if (runInfo(board, c, p).run >= 5) out.push(c);
    board[c] = 0;
  }
  return out;
}

// 조련사: 방금 둔 수(before 판에서 me가 c에)의 결과만 보고 칭찬(+)·꾸지람(-)을 정한다
function trainerReward(before, c, me) {
  if (!before.some(v => v)) return [0, '첫 수'];
  const opp = 3 - me;
  const myWins = winningCells(before, me), oppWins = winningCells(before, opp);
  const after = before.slice(); after[c] = me;
  const own = runInfo(after, c, me);
  const asOpp = before.slice(); asOpp[c] = opp;
  const block = runInfo(asOpp, c, opp);
  if (own.run >= 5) return [1, '5목 완성'];
  if (myWins.length) return [-0.8, '이길 수를 놓침'];
  if (oppWins.length && !oppWins.includes(c)) return [-0.8, '상대 5목을 못 막음'];
  if (block.run >= 5) return [0.9, '상대 5목 저지'];
  if (own.run === 4 && own.open) return [own.open === 2 ? 0.85 : 0.6, own.open === 2 ? '열린 4' : '4 만들기'];
  if (block.run === 4 && block.open) return [0.6, '상대 4 막기'];
  if (own.run === 3 && own.open === 2) return [0.45, '열린 3'];
  if (block.run === 3 && block.open === 2) return [0.35, '상대 열린 3 막기'];
  if (own.run === 3) return [0.2, '3 잇기'];
  if (own.run === 2 && own.open) return [0.1, '2 잇기'];
  const x0 = c % N, y0 = (c / N) | 0;
  let nb = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
    if ((dx || dy) && inB(x0 + dx, y0 + dy) && before[(y0 + dy) * N + x0 + dx]) nb++;
  if (!nb) return [-0.4, '동떨어진 수'];
  return [-0.05, '의미 없는 수'];
}

// ── 초파리 한 마리 = 뇌 워커 + 눈 ──────────────────────
class FlyPlayer {
  constructor(name, vis, n, wiring, rewardIdx) {
    this.name = name; this.vis = vis; this.rewardIdx = rewardIdx;
    this.eye = new FlyEye(vis);
    this.record = { w: 0, l: 0, d: 0 };
    this.trained = 0; this.synChanged = 0;
    this.praise = [];          // 훈련 판마다 칭찬받은 수의 비율
    // 칸별로 그 칸을 보는 시각 뉴런(전역 인덱스) — 학습 대상
    this.cellNeurons = Array.from({ length: N * N }, () => []);
    const [u0, v0, u1, v1] = REGION;
    for (let k = 0; k < vis.perIdx.length; k++) {
      const i = Math.floor((this.eye.su[k] - u0) / (u1 - u0) * N), j = Math.floor((this.eye.sv[k] - v0) / (v1 - v0) * N);
      if (i >= 0 && j >= 0 && i < N && j < N) this.cellNeurons[j * N + i].push(vis.perIdx[k]);
    }
    this.lastSeen = null; this.lastMove = -1; this.glow = null;
    this.seq = 0; this.pending = new Map();
    const w = this.worker = new Worker('js/sim-worker.js');
    w.postMessage({ type: 'init', n, ...wiring, readouts: [] },
                  [wiring.indptr, wiring.targets, wiring.weights]);
    w.postMessage({ type: 'driveSet', key: 'vis', indices: vis.photoIdx });
    w.postMessage({ type: 'watch', indices: vis.perIdx });
    w.postMessage({ type: 'params', speed: 2 });
    w.onmessage = e => {
      const m = e.data;
      if (m.type === 'probeResult' || m.type === 'reinforced') {
        this.pending.get(m.id)(m); this.pending.delete(m.id);
      } else if (m.type === 'frame') {
        this.glow = new Uint8Array(m.glow);
        w.postMessage({ type: 'buffer', buf: m.glow }, [m.glow]);
      }
    };
    this.canvas = document.createElement('canvas');
    this.canvas.width = SCREEN_W; this.canvas.height = SCREEN_H;
  }

  call(msg, transfer = []) {
    return new Promise(res => {
      const id = ++this.seq;
      this.pending.set(id, res);
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  setEthanol(v) { this.worker.postMessage({ type: 'params', ethanol: v }); }
  setRunning(on) { this.worker.postMessage({ type: 'params', running: on }); }

  // 초파리 눈에 보이는 판: 내 돌 밝게, 상대 돌 어둡게, 판 선 희미하게
  ratesFor(board, me) {
    const g = this.canvas.getContext('2d', { willReadFrequently: true });
    const [u0, v0, u1, v1] = REGION, W = SCREEN_W, H = SCREEN_H;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgb(38,38,38)'; g.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      const u = u0 + (u1 - u0) * (i + 0.5) / N, v = v0 + (v1 - v0) * (i + 0.5) / N;
      g.beginPath(); g.moveTo(u0 * W, v * H); g.lineTo(u1 * W, v * H); g.stroke();
      g.beginPath(); g.moveTo(u * W, v0 * H); g.lineTo(u * W, v1 * H); g.stroke();
    }
    const r = (u1 - u0) / N * 0.38;
    for (let c = 0; c < N * N; c++) {
      if (!board[c]) continue;
      g.fillStyle = board[c] === me ? '#fff' : 'rgb(100,100,100)';
      const u = u0 + (u1 - u0) * ((c % N) + 0.5) / N, v = v0 + (v1 - v0) * (((c / N) | 0) + 0.5) / N;
      g.beginPath(); g.ellipse(u * W, v * H, r * W, r * H, 0, 0, Math.PI * 2); g.fill();
    }
    return this.eye.rates(this.canvas);
  }

  // 판을 보고 → 뇌 반응이 가장 강한 빈 칸
  async choose(board, me) {
    const rates = this.ratesFor(board, me);
    const keep = rates.slice();
    const { counts } = await this.call({ type: 'probe', key: 'vis', rates, ticks: PROBE_TICKS, learn: true },
                                      [rates.buffer]);
    // 쉬는 동안에도 판을 계속 바라보게 (뇌 화면이 살아 있도록)
    this.worker.postMessage({ type: 'drive', key: 'vis', rates: keep }, [keep.buffer]);
    const act = this.eye.binGrid(counts, N, N, REGION).act;
    let best = -1, bs = -1;
    for (let c = 0; c < N * N; c++) {
      if (board[c]) continue;
      const s = act[c] + Math.random() * 1e-6;     // 동점일 때만 가르는 아주 작은 떨림
      if (s > bs) { bs = s; best = c; }
    }
    this.lastSeen = act; this.lastMove = best;
    return best;
  }

  // 조련사 보상: 맛(설탕/쓴맛) + 도파민(PAM/PPL1)을 짧게 주고, 고른 칸 뉴런으로의 입력 시냅스를 바꾼다
  async reward(c, r) {
    if (!r) return;
    const idx = r > 0 ? this.rewardIdx.good : this.rewardIdx.bad;
    this.worker.postMessage({ type: 'stim', key: 'da', on: true, rate: 150, indices: idx });
    setTimeout(() => this.worker.postMessage({ type: 'stim', key: 'da', on: false }), 300);
    const res = await this.call({ type: 'reinforceCell', post: this.cellNeurons[c], r, eta: 0.4 });
    this.synChanged += res.changed;
  }
}

// ── 경기장 UI ────────────────────────────────────────
export class OmokArena {
  constructor({ n, positions, vis, meta, onOpen, onClose }) {
    Object.assign(this, { n, positions, vis, onOpen, onClose });
    this.rewardIdx = {
      good: [...meta.presets.sugar.idx, ...vis.info.pam],
      bad: [...meta.presets.bitter.idx, ...vis.info.ppl1],
    };
    this.el = document.getElementById('arena');
    this.boardCv = document.getElementById('omok-board');
    this.board = new Int8Array(N * N);
    this.busy = false; this.human = false; this.lastMove = -1;
    document.getElementById('omok-close').onclick = () => this.close();
    document.getElementById('omok-match').onclick = () => this.run(1, 450, false);
    document.getElementById('omok-train').onclick = () => this.run(10, 0, true);
    document.getElementById('omok-human').onclick = () => this.humanGame();
    document.getElementById('omok-stop').onclick = () => { this.stop = true; };
    this.boardCv.onclick = e => this.click(e);
  }

  say(t) { document.getElementById('omok-status').textContent = t; }

  async open() {
    this.el.hidden = false;
    this.onOpen?.();
    if (!this.flies) {
      this.say('뇌 두 개를 준비하는 중… (연결체 데이터를 두 벌 더 불러옵니다)');
      const [wa, wb] = await Promise.all([loadWiring(), loadWiring()]);
      this.flies = { A: new FlyPlayer('A', this.vis, this.n, wa, this.rewardIdx), B: new FlyPlayer('B', this.vis, this.n, wb, this.rewardIdx) };
      for (const k of ['A', 'B']) {
        document.getElementById(`omok-eth-${k}`).oninput = e => {
          const v = +e.target.value / 100;
          this.flies[k].setEthanol(v);
          document.getElementById(`omok-eth-${k}-val`).textContent = v ? `🍺 ${(v * 0.4).toFixed(2)} g/dL` : '맨정신';
        };
      }
      this.board.fill(0); this.drawBoard(); this.updateCards();
      this.say('준비 완료. 두 뇌는 똑같은 연결체로 시작합니다. 🎓 조련 훈련으로 가르친 뒤 ▶ 대결로 붙여 보세요.');
    } else {
      for (const f of Object.values(this.flies)) f.setRunning(true);
    }
    if (!this.raf) this.loop();
  }

  close() {
    this.stop = true;
    this.el.hidden = true;
    cancelAnimationFrame(this.raf); this.raf = null;
    if (this.flies) for (const f of Object.values(this.flies)) f.setRunning(false);
    this.onClose?.();
  }

  // A(흑) vs B(백)를 games판. train이면 수마다 조련사가 칭찬·꾸지람하고 뇌가 배운다.
  async run(games, delay, train) {
    if (this.busy || !this.flies) return;
    this.busy = true; this.stop = false; this.human = false;
    const { A, B } = this.flies;
    for (let gi = 0; gi < games && !this.stop; gi++) {
      this.board.fill(0); this.lastMove = -1; this.drawBoard();
      let me = 1, w = 0, moves = 0;
      const tally = { A: [0, 0], B: [0, 0] };          // [칭찬 수, 전체 수]
      let note = '';
      while (!(w = winner(this.board)) && !this.stop) {
        const k = me === 1 ? 'A' : 'B';
        const head = train ? `🎓 훈련 ${gi + 1}/${games} · ` : '';
        this.say(`${head}초파리 ${k}(${me === 1 ? '흑' : '백'}) 차례 — 판을 보는 중… (${moves + 1}수)${note}`);
        const before = this.board.slice();
        const c = await this.flies[k].choose(this.board, me);
        this.board[c] = me; this.lastMove = c; moves++;
        this.drawBoard(); this.drawSeen(k);
        if (train) {
          const [r, why] = trainerReward(before, c, me);
          tally[k][1]++; if (r > 0) tally[k][0]++;
          note = ` · ${k}: ${why} ${r > 0 ? '🍬' : r < 0 ? '☕' : ''}`;
          await this.flies[k].reward(c, r);
        }
        me = 3 - me;
        if (delay) await sleep(delay);
      }
      if (!w) break;
      if (w === 3) { A.record.d++; B.record.d++; }
      else { (w === 1 ? A : B).record.w++; (w === 1 ? B : A).record.l++; }
      if (train) for (const k of ['A', 'B']) {
        const f = this.flies[k]; f.trained++;
        f.praise.push(tally[k][1] ? tally[k][0] / tally[k][1] : 0);
      }
      this.say(`${w === 3 ? '무승부' : `초파리 ${w === 1 ? 'A(흑)' : 'B(백)'} 승리! 🎉`} (${moves}수)`);
      this.updateCards();
      if (delay) await sleep(1200);
    }
    if (this.stop) this.say('멈췄습니다.');
    else if (train) this.say(`훈련 ${games}판 끝. 카드의 칭찬 비율이 오르는지 보세요. ▶ 대결은 학습 없이 실력만 겨룹니다.`);
    this.busy = false;
  }

  // 🧑 나(흑) vs 초파리 A(백)
  humanGame() {
    if (this.busy || !this.flies) return;
    this.board.fill(0); this.lastMove = -1; this.human = true; this.drawBoard();
    this.say('나(흑) 차례 — 판을 클릭해서 두세요. 초파리 A가 백으로 응수합니다.');
  }

  async click(e) {
    if (!this.human || this.busy) return;
    const r = this.boardCv.getBoundingClientRect(), s = r.width / N;
    const c = Math.floor((e.clientY - r.top) / s) * N + Math.floor((e.clientX - r.left) / s);
    if (c < 0 || c >= N * N || this.board[c]) return;
    this.board[c] = 1; this.lastMove = c; this.drawBoard();
    let w = winner(this.board);
    if (!w) {
      this.busy = true;
      this.say('초파리 A(백)가 판을 보는 중…');
      const m = await this.flies.A.choose(this.board, 2);
      this.board[m] = 2; this.lastMove = m; this.drawBoard(); this.drawSeen('A');
      this.busy = false;
      w = winner(this.board);
      if (!w) this.say('나(흑) 차례');
    }
    if (w) {
      this.human = false;
      const A = this.flies.A;
      if (w === 2) A.record.w++; else if (w === 1) A.record.l++; else A.record.d++;
      this.say(w === 3 ? '무승부!' : w === 1 ? '내가 이겼다!' : '초파리 A 승리! 🎉');
      this.updateCards();
    }
  }

  updateCards() {
    for (const k of ['A', 'B']) {
      const f = this.flies?.[k]; if (!f) continue;
      const r = f.record;
      document.getElementById(`omok-info-${k}`).textContent =
        `${r.w}승 ${r.l}패 ${r.d}무 · 훈련 ${f.trained}판`;
      const avg = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100);
      const p = f.praise;
      document.getElementById(`omok-pref-${k}`).textContent = !p.length
        ? '아직 훈련 전 (원래 연결체 그대로)'
        : p.length < 4
          ? `칭찬받은 수 ${avg(p)}% · 바뀐 시냅스 ${f.synChanged.toLocaleString()}개`
          : `칭찬받은 수: 처음 ${avg(p.slice(0, 3))}% → 최근 ${avg(p.slice(-3))}% · 바뀐 시냅스 ${f.synChanged.toLocaleString()}개`;
      this.drawSeen(k);
    }
  }

  // 초파리가 본 판: 칸별 시각 뉴런 반응(밝을수록 강함), 고른 칸은 고리로
  drawSeen(k) {
    const cv = document.getElementById(`omok-seen-${k}`), g = cv.getContext('2d');
    const f = this.flies[k], s = cv.width / N;
    g.fillStyle = '#0b0f1e'; g.fillRect(0, 0, cv.width, cv.height);
    if (!f.lastSeen) return;
    let mx = 1e-6; for (const x of f.lastSeen) mx = Math.max(mx, x);
    for (let c = 0; c < N * N; c++) {
      const a = Math.sqrt(f.lastSeen[c] / mx);
      g.fillStyle = `rgba(255,${120 + 100 * a | 0},${40 + 40 * a | 0},${a})`;
      g.fillRect((c % N) * s + 1, ((c / N) | 0) * s + 1, s - 2, s - 2);
    }
    if (f.lastMove >= 0) {
      g.strokeStyle = '#7fd7ff'; g.lineWidth = 2;
      g.strokeRect((f.lastMove % N) * s + 1.5, ((f.lastMove / N) | 0) * s + 1.5, s - 3, s - 3);
    }
  }

  drawBoard() {
    const g = this.boardCv.getContext('2d'), W = this.boardCv.width, s = W / N;
    g.fillStyle = '#c9a063'; g.fillRect(0, 0, W, W);
    g.strokeStyle = 'rgba(60,40,20,0.7)'; g.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      g.beginPath(); g.moveTo(s / 2, s / 2 + i * s); g.lineTo(W - s / 2, s / 2 + i * s); g.stroke();
      g.beginPath(); g.moveTo(s / 2 + i * s, s / 2); g.lineTo(s / 2 + i * s, W - s / 2); g.stroke();
    }
    for (let c = 0; c < N * N; c++) {
      if (!this.board[c]) continue;
      const x = (c % N + 0.5) * s, y = (((c / N) | 0) + 0.5) * s;
      const grd = g.createRadialGradient(x - s * 0.12, y - s * 0.12, 1, x, y, s * 0.42);
      if (this.board[c] === 1) { grd.addColorStop(0, '#555'); grd.addColorStop(1, '#0a0a0a'); }
      else { grd.addColorStop(0, '#fff'); grd.addColorStop(1, '#cfcfcf'); }
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, s * 0.42, 0, Math.PI * 2); g.fill();
      if (c === this.lastMove) {
        g.strokeStyle = '#e8442c'; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, s * 0.18, 0, Math.PI * 2); g.stroke();
      }
    }
  }

  // 두 뇌의 활동을 위에서 내려다본 점그림으로
  loop() {
    const draw = k => {
      const f = this.flies?.[k], cv = document.getElementById(`omok-brain-${k}`);
      if (!f || !f.glow) return;
      const g = cv.getContext('2d'), W = cv.width, H = cv.height;
      const img = g.createImageData(W, H), d = img.data, P = this.positions;
      for (let i = 0; i < d.length; i += 4) { d[i] = 6; d[i + 1] = 9; d[i + 2] = 20; d[i + 3] = 255; }
      for (let i = 0; i < this.n; i += 5) {
        const x = (P[i * 3] / 65535 * (W - 1)) | 0, y = (P[i * 3 + 1] / 65535 * (H - 1)) | 0;
        const q = (y * W + x) * 4, gl = f.glow[i];
        d[q] = Math.min(255, d[q] + 18 + gl);
        d[q + 1] = Math.min(255, d[q + 1] + 22 + gl * 0.8);
        d[q + 2] = Math.min(255, d[q + 2] + 40 + gl * 0.3);
      }
      g.putImageData(img, 0, 0);
    };
    draw('A'); draw('B');
    this.raf = requestAnimationFrame(() => this.loop());
  }
}
