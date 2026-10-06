// ⚫🏓 초파리 경기장: 연결체 뇌 두 개(워커 두 개 = 자리 두 개)가 오목을 두거나 탁구를 친다.
// 자리에는 명단의 어떤 초파리든 앉힐 수 있고(➕ 새 초파리 = 원래 연결체), 초파리마다 뇌가 따로 저장된다.
// 탁구 규칙·조련은 pong-duel.js.
//
// 수 선택(정위 반응): 판 그림을 그 초파리의 광수용체에 20ms 보여주고, 수용장을 아는
//   시각 뉴런 반응이 가장 강한 빈 칸에 둔다. 내 돌은 밝게, 상대 돌은 어둡게, 판 선은 희미하게
//   보인다. 수를 고르는 규칙·점수표·선생님은 없다 — 뇌 활동이 어디서 가장 크게 일어나는지가 전부다.
// 학습(조련사식 3요소 가소성): 🎓 훈련 판에서는 수가 놓일 때마다 조련사(심판)가 결과를 보고
//   좋은 일(5목·4·열린 3·상대 막기)이면 설탕 + 보상 도파민(PAM), 나쁜 일(이길 수 놓침·상대 5목
//   방치·동떨어진 수)이면 쓴맛 + 처벌 도파민(PPL1)을 준다. 그 수를 고르게 만든 시냅스 —
//   고른 칸을 보는 시각 뉴런으로 들어가며 방금 함께 발화한 입력 — 만 강화·약화된다.
//   조련사는 수를 대신 고르지 않는다. ▶ 공식 대결은 학습 없이 실력만 겨룬다.
// 보관(brain-store.js): 초파리마다 훈련으로 바뀐 시냅스와 기록이 사이트 공유 저장소에 남아,
//   링크로 들어온 누구나 그 뇌를 이어받아 대결시키거나 더 가르칠 수 있다.
// ♾️ 무한 조련: 멈출 때까지 계속 가르치고 일정 판마다 자동 저장. 조련 중에는 뒤에서 도는
//   뇌 애니메이션을 멈춰 CPU를 판 보기에만 쓴다(빠르게).
import { loadWiring } from './data.js';
import { FlyEye, SCREEN_W, SCREEN_H } from './vision.js';
import { BrainStore } from './brain-store.js';
import { PongDuel } from './pong-duel.js';

const N = 9;
const REGION = [0.15, 0.15, 0.85, 0.85];
const PROBE_TICKS = 40;                     // 20ms 반응 — 수용장을 잰 창과 같다 (40ms일 때와 실력 차이 없음, 2배 빠름)
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
const inB = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 심판: 5목 판정 (1 흑 승, 2 백 승, 3 무승부, 0 진행 중)
export function winner(board) {
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
export function trainerReward(before, c, me) {
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

// ── 경기장 자리 하나 = 뇌 워커 + 눈. 어떤 초파리(명단의 한 마리)가 앉느냐에 따라 뇌가 바뀐다 ──
class FlyPlayer {
  constructor(slot, vis, n, wiring, rewardIdx) {
    this.slot = slot; this.vis = vis; this.rewardIdx = rewardIdx;
    this.eye = new FlyEye(vis);
    this.restore({});
    // 칸별로 그 칸을 보는 시각 뉴런(전역 인덱스) — 학습 대상
    this.cellNeurons = Array.from({ length: N * N }, () => []);
    const [u0, v0, u1, v1] = REGION;
    for (let k = 0; k < vis.perIdx.length; k++) {
      const i = Math.floor((this.eye.su[k] - u0) / (u1 - u0) * N), j = Math.floor((this.eye.sv[k] - v0) / (v1 - v0) * N);
      if (i >= 0 && j >= 0 && i < N && j < N) this.cellNeurons[j * N + i].push(vis.perIdx[k]);
    }
    this.glow = null;
    this.seq = 0; this.pending = new Map();
    const w = this.worker = new Worker('js/sim-worker.js');
    w.postMessage({ type: 'init', n, ...wiring, readouts: [] },
                  [wiring.indptr, wiring.targets, wiring.weights]);
    w.postMessage({ type: 'driveSet', key: 'vis', indices: vis.photoIdx });
    w.postMessage({ type: 'watch', indices: vis.perIdx });
    w.postMessage({ type: 'params', speed: 2 });
    w.onmessage = e => {
      const m = e.data;
      if (m.id && this.pending.has(m.id)) {
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

  // 학습으로 바뀐 시냅스만 꺼내기 / 저장본 덮어쓰기(빈 차이 = 원래 연결체로)
  exportDiff() { return this.call({ type: 'exportDiff' }); }
  async importDiff(diff) {
    const idx = diff ? diff.idx.slice() : new Uint32Array(0), val = diff ? diff.val.slice() : new Float32Array(0);
    const res = await this.call({ type: 'importDiff', idx, val }, [idx.buffer, val.buffer]);
    this.synChanged = res.changed;
  }
  meta() {
    return { name: this.name, createdAt: this.createdAt, record: this.record, trained: this.trained,
             synChanged: this.synChanged, praise: this.praise, pong: this.pong };
  }
  restore(m) {
    this.id = m.id ?? this.id ?? this.slot;
    this.name = m.name || `초파리 ${this.id}`;
    this.createdAt = m.createdAt || 0;
    this.record = { w: 0, l: 0, d: 0, ...m.record };
    this.trained = m.trained || 0;
    this.praise = Array.isArray(m.praise) ? m.praise.slice() : [];
    this.pong = { w: 0, l: 0, trained: 0, hits: '', ...m.pong };
    this.synChanged = m.synChanged || 0;
    this.lastSeen = null; this.lastMove = -1; this.pongSeen = null;
    this.dirty = false;
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
    const { counts } = await this.call({ type: 'probe', key: 'vis', rates, ticks: this.probeTicks ?? PROBE_TICKS, learn: true },
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

  // 조련사 보상: (pulse면) 맛(설탕/쓴맛) + 도파민(PAM/PPL1)을 짧게 주고, post 뉴런으로의 입력 시냅스를 바꾼다
  async rewardNeurons(post, r, pulse = true) {
    if (!r) return;
    if (pulse) {
      const idx = r > 0 ? this.rewardIdx.good : this.rewardIdx.bad;
      this.worker.postMessage({ type: 'stim', key: 'da', on: true, rate: 150, indices: idx });
      setTimeout(() => this.worker.postMessage({ type: 'stim', key: 'da', on: false }), 300);
    }
    const res = await this.call({ type: 'reinforceCell', post, r, eta: 0.4 });
    this.synChanged = res.total;            // 처음부터 지금까지 한 번이라도 바뀐 시냅스 수(누적)
    if (res.changed) this.dirty = true;
  }
  reward(c, r) { return this.rewardNeurons(this.cellNeurons[c], r, true); }
}

const HINT = {
  omok: '두 자리 모두 실제 연결체 뇌(뉴런 139,255개)입니다. 판을 20ms 보여주면 <b>그 뇌의 시각 뉴런이 가장 강하게 반응한 빈 칸</b>에 둡니다. 규칙·점수표·선생님은 없고, 5목 판정은 심판만 합니다. <b>🎓 조련</b>에서는 수가 놓일 때마다 조련사가 결과만 보고 칭찬(설탕 + 보상 도파민)이나 꾸지람(쓴맛 + 처벌 도파민)을 주고, 그 수를 고르게 만든 시냅스만 강화·약화됩니다. ▶ 대결은 학습 없이 실력만 겨룹니다. 위 선택 상자로 자리에 앉힐 초파리를 바꾸거나 ➕ 새 초파리를 만들 수 있습니다.',
  pong: '두 초파리가 마주 보고 탁구를 칩니다. 게임 시간 0.1초마다 각자의 눈에 <b>공과 자기 패들만</b> 20ms 보여주고, 시각 뉴런이 공을 가장 강하게 본 위치로 패들이 갑니다(정위 반응, 학습된 디코더 없음). <b>🎓 조련</b>에서는 공이 올 때마다 조련사가 떨어질 곳으로 다가갔는지만 보고 칭찬·꾸지람, 받아내면 설탕 + 보상 도파민, 놓치면 쓴맛 + 처벌 도파민을 주고, 그 움직임을 만든 시냅스만 바뀝니다. 🧑 나 vs 흑은 판 위에서 마우스·손가락으로 위쪽 패들을 움직입니다.',
};
const CAP = {
  omok: '{n}가 본 판<br>밝을수록 뇌 반응이 강함<br>파란 테두리 = 고른 칸',
  pong: '{n}가 본 화면(자기 시점)<br>위 = 공, 아래 = 자기 패들<br>파란 표시 = 뇌가 본 위치',
};
// 이름 뒤 조사: 받침 있으면 a(이/을), 없으면 b(가/를). 숫자는 읽는 소리로.
function josa(name, a, b) {
  const c = String(name).trim().slice(-1), code = c.charCodeAt(0);
  if (code >= 0xAC00 && code <= 0xD7A3) return name + ((code - 0xAC00) % 28 ? a : b);
  return name + ('013678'.includes(c) ? a : b);
}

const AUTOSAVE = { omok: 10, pong: 20 };       // 무한 조련 중 이만큼마다 저장 (판 / 점)

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
    this.game = 'omok';
    this.store = new BrainStore();
    this.savedAt = null;
    this.roster = new Map();      // id → 메타 (명단: 공유 저장소 + 이 창에서 만든 것)
    this.local = new Map();       // id → {meta, diff} — 자리에서 내려온 초파리의 이 창 사본
    const $ = id => document.getElementById(id);
    $('omok-close').onclick = () => this.close();
    $('arena-tab-omok').onclick = () => this.setGame('omok');
    $('arena-tab-pong').onclick = () => this.setGame('pong');
    $('omok-match').onclick = () => this.game === 'omok' ? this.run(1, 450, false) : this.runPong('match');
    $('omok-train').onclick = () => this.game === 'omok' ? this.run(10, 0, true) : this.runPong('train', 10);
    $('omok-forever').onclick = () => this.game === 'omok' ? this.run(Infinity, 0, true) : this.runPong('train', Infinity);
    $('omok-human').onclick = () => this.game === 'omok' ? this.humanGame() : this.runPong('human');
    $('omok-stop').onclick = () => { this.stop = true; };
    $('omok-reset').onclick = () => this.resetBrains();
    $('new-fly').onclick = () => this.newFly();
    $('new-fly-name').onkeydown = e => { if (e.key === 'Enter') this.newFly(); };
    for (const k of ['A', 'B']) {
      $(`slot-${k}`).onchange = e => this.seat(k, e.target.value);
      $(`del-${k}`).onclick = () => this.deleteFly(k);
    }
    this.boardCv.onclick = e => this.click(e);
    this.boardCv.onpointermove = e => {
      if (!this.pong) return;
      const r = this.boardCv.getBoundingClientRect();
      this.pong.humanX = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
  }

  say(t) { document.getElementById('omok-status').textContent = t; }

  async open(game = 'omok') {
    this.el.hidden = false;
    this.onOpen?.();
    if (!this.flies) {
      this.busy = true;
      this.say('뇌 두 개를 준비하는 중… (연결체 데이터를 두 벌 더 불러옵니다)');
      const [wa, wb] = await Promise.all([loadWiring(), loadWiring()]);
      this.flies = { A: new FlyPlayer('A', this.vis, this.n, wa, this.rewardIdx), B: new FlyPlayer('B', this.vis, this.n, wb, this.rewardIdx) };
      this.pong = new PongDuel(this);
      for (const k of ['A', 'B']) {
        document.getElementById(`omok-eth-${k}`).oninput = e => {
          const v = +e.target.value / 100;
          this.flies[k].setEthanol(v);
          document.getElementById(`omok-eth-${k}-val`).textContent = v ? `🍺 ${(v * 0.4).toFixed(2)} g/dL` : '맨정신';
        };
      }
      this.setGame(game, true);
      this.board.fill(0); this.drawBoard(); this.updateCards();
      this.say('공유 저장소에서 훈련된 초파리를 찾는 중…');
      const found = await this.loadShared();
      this.busy = false;
      this.updateCards(); this.showSave();
      const { A, B } = this.flies;
      this.say(found
        ? `저장된 뇌를 이어받았습니다 (${A.name} 오목 ${A.trained}판·탁구 ${A.pong.trained}점 / ${B.name} 오목 ${B.trained}판·탁구 ${B.pong.trained}점). 🎓 더 가르치거나 ▶ 대결시켜 보세요.`
        : '준비 완료. 두 뇌는 똑같은 연결체로 시작합니다. 🎓 조련으로 가르친 뒤 ▶ 대결로 붙여 보세요.');
    } else {
      for (const f of Object.values(this.flies)) f.setRunning(true);
      this.setGame(game);
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

  setGame(game, force) {
    if (!force && game === this.game) return;
    if (this.busy) { this.say('진행 중인 경기·훈련을 ⏹ 멈춘 뒤 바꿔 주세요.'); return; }
    this.game = game; this.human = false;
    const $ = id => document.getElementById(id), pong = game === 'pong';
    $('arena-tab-omok').classList.toggle('on', !pong);
    $('arena-tab-pong').classList.toggle('on', pong);
    $('arena-title').textContent = pong ? '🏓 초파리 탁구 대결' : '⚫ 초파리 오목 대결';
    $('arena-hint').innerHTML = HINT[game];
    $('omok-match').textContent = pong ? '▶ 대결 (5점)' : '▶ 대결';
    $('omok-train').textContent = pong ? '🎓 조련 ×10점' : '🎓 조련 ×10판';
    $('omok-human').textContent = pong ? '🧑 나 vs 아래' : '🧑 나 vs 흑';
    if (pong && this.pong) this.pong.reset();
    else { this.board.fill(0); this.lastMove = -1; this.drawBoard(); }
    if (this.flies) this.updateCards();
  }

  // ── 명단: 어느 초파리를 어느 자리에 ──
  async loadShared() {
    try {
      for (const m of await this.store.list()) this.roster.set(m.id, m);
    } catch (e) { this.store.lastError = e?.message || String(e); }
    // 저장된 초파리가 없으면 처음 두 마리(A·B)로 시작한다
    if (!this.roster.size) for (const id of ['A', 'B']) this.roster.set(id, { id, name: `초파리 ${id}` });
    while (this.roster.size < 2) this.makeFly();
    const [ia, ib] = this.sortedRoster().map(m => m.id);
    let found = false;
    found = (await this.loadInto('A', ia)) || found;
    found = (await this.loadInto('B', ib)) || found;
    this.fillPickers();
    return found;
  }

  // 자리 k에 초파리 id를 앉힌다 (저장본이 있으면 이어받고, 없으면 원래 연결체)
  async loadInto(k, id) {
    const f = this.flies[k];
    let s = this.local.get(id) || null, found = false;
    if (!s) {
      try { s = await this.store.load(id); } catch (e) { this.store.lastError = e?.message || String(e); }
      found = !!s;
    }
    const base = this.roster.get(id) || {};
    f.restore({ ...base, ...(s?.meta || {}), id });
    await f.importDiff(s?.diff || null);
    if (s?.meta?.updatedAt) this.savedAt = Math.max(this.savedAt || 0, s.meta.updatedAt);
    return found;
  }

  // 자리에서 내려오는 초파리를 이 창에 보관하고, 바뀐 게 있으면 공유 저장소에도
  async unseat(k) {
    const f = this.flies[k];
    const { idx, val } = await f.exportDiff();
    f.synChanged = idx.length;
    this.local.set(f.id, { meta: { ...f.meta(), praise: f.praise.slice(), pong: { ...f.pong } }, diff: { idx, val } });
    this.roster.set(f.id, { id: f.id, ...f.meta() });
    if (f.dirty && this.store.state === 'shared') await this.store.saveBrain(f.id, f.meta(), idx, val);
  }

  async seat(k, id) {
    if (this.busy) { this.fillPickers(); this.say('진행 중인 경기·훈련을 ⏹ 멈춘 뒤 바꿔 주세요.'); return; }
    const other = k === 'A' ? 'B' : 'A';
    if (this.flies[k].id === id) return;
    this.busy = true;
    this.say('초파리를 바꾸는 중…');
    if (this.flies[other].id === id) {          // 다른 자리에 있던 초파리면 서로 자리를 바꾼다
      const mine = this.flies[k].id;
      await this.unseat(k); await this.unseat(other);
      await this.loadInto(k, id); await this.loadInto(other, mine);
    } else {
      await this.unseat(k);
      await this.loadInto(k, id);
    }
    this.busy = false;
    this.fillPickers(); this.updateCards(); this.showSave();
    if (this.game === 'pong') this.pong.reset(); else { this.board.fill(0); this.lastMove = -1; this.drawBoard(); }
    this.say(`${josa(this.flies[k].name, '이', '가')} ${this.sideName(k)} 자리에 앉았습니다.`);
  }

  // 명단에 새 초파리(원래 연결체)를 올리고 id를 돌려준다
  makeFly(name) {
    const used = new Set([...this.roster.values()].map(m => m.name));
    name = (name || '').trim().slice(0, 16);
    if (!name) { let i = this.roster.size; do name = `초파리 ${++i}`; while (used.has(name)); }
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    this.roster.set(id, { id, name, createdAt: Date.now() });
    return id;
  }

  sortedRoster() {
    return [...this.roster.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(b.id));
  }

  async newFly() {
    if (this.busy || !this.flies) return;
    const input = document.getElementById('new-fly-name');
    const id = this.makeFly(input.value), name = this.roster.get(id).name;
    input.value = '';
    await this.seat('B', id);
    this.flies.B.dirty = true;
    await this.save(false);
    this.say(`🐣 새 초파리 "${name}"${josa(name, '이', '가').slice(name.length)} 태어났습니다 — 원래 연결체 그대로입니다. ${this.sideName('B')} 자리에 앉혔어요.`);
  }

  // 🗑 두 번 눌러야 지금 자리에 앉은 초파리를 명단과 공유 저장소에서 지운다.
  //   빈 자리에는 명단의 다른 초파리가(없으면 새로 태어난 초파리가) 앉는다.
  async deleteFly(k) {
    if (this.busy || !this.flies) return;
    const btn = document.getElementById(`del-${k}`), f = this.flies[k];
    if (this.delArmed !== k) {
      this.delArmed = k; btn.classList.add('armed'); btn.textContent = '🗑 정말?';
      this.say(`🗑 한 번 더 누르면 "${f.name}"의 뇌와 기록이 영구히 지워집니다.`);
      clearTimeout(this.delTimer);
      this.delTimer = setTimeout(() => { this.delArmed = null; btn.classList.remove('armed'); btn.textContent = '🗑'; }, 3000);
      return;
    }
    this.delArmed = null; btn.classList.remove('armed'); btn.textContent = '🗑';
    this.busy = true;
    const { id, name } = f, shared = this.store.state === 'shared';
    if (shared) await this.store.remove(id);
    this.roster.delete(id); this.local.delete(id);
    const otherId = this.flies[k === 'A' ? 'B' : 'A'].id;
    let next = this.sortedRoster().map(m => m.id).find(x => x !== otherId), born = false;
    if (!next) { next = this.makeFly(); born = true; }
    await this.loadInto(k, next);
    if (born) this.flies[k].dirty = true;
    this.busy = false;
    if (born) await this.save(false);
    this.fillPickers(); this.updateCards(); this.showSave();
    if (this.game === 'pong') this.pong.reset(); else { this.board.fill(0); this.lastMove = -1; this.drawBoard(); }
    this.say(`🗑 "${name}"${josa(name, '을', '를').slice(name.length)} ${shared ? '삭제했습니다' : '이 창의 명단에서 지웠습니다(공유 저장소에는 남아 있음)'}. ${this.sideName(k)} 자리에는 ${born ? '새로 태어난 ' : ''}${josa(this.flies[k].name, '이', '가')} 앉았습니다.`);
  }

  sideName(k) { return this.game === 'pong' ? (k === 'A' ? '아래' : '위') : (k === 'A' ? '흑' : '백'); }

  fillPickers() {
    const list = this.sortedRoster();
    for (const k of ['A', 'B']) {
      const sel = document.getElementById(`slot-${k}`);
      sel.textContent = '';
      for (const m of list) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = `${m.name || '초파리 ' + m.id} · 오목 ${m.trained || 0}판 · 탁구 ${m.pong?.trained || 0}점`;
        sel.append(o);
      }
      sel.value = this.flies[k].id;
    }
  }

  // 조련 중에는 뒤에서 도는 뇌 애니메이션을 멈춰 판 보기(프로브)에 CPU를 몰아준다
  fast(on) { for (const f of Object.values(this.flies)) f.setRunning(!on && !this.el.hidden); }

  // A(흑) vs B(백)를 games판. train이면 수마다 조련사가 칭찬·꾸지람하고 뇌가 배운다.
  async run(games, delay, train) {
    if (train) return this.runTrain(games);
    if (this.busy || !this.flies) return;
    this.busy = true; this.stop = false; this.human = false;
    const { A, B } = this.flies;
    const forever = games === Infinity, t0 = performance.now();
    if (train) this.fast(true);
    let done = 0;
    for (let gi = 0; gi < games && !this.stop; gi++) {
      this.board.fill(0); this.lastMove = -1; this.drawBoard();
      let me = 1, w = 0, moves = 0;
      const tally = { A: [0, 0], B: [0, 0] };          // [칭찬 수, 전체 수]
      let note = '';
      while (!(w = winner(this.board)) && !this.stop) {
        const k = me === 1 ? 'A' : 'B';
        const rate = done ? ` · 분당 ${(done / ((performance.now() - t0) / 60000)).toFixed(1)}판` : '';
        const head = forever ? `♾️ 무한 조련 ${gi + 1}판째${rate} · ` : train ? `🎓 조련 ${gi + 1}/${games} · ` : '';
        this.say(`${head}${this.flies[k].name}(${me === 1 ? '흑' : '백'}) 차례 — 판을 보는 중… (${moves + 1}수)${note}`);
        const before = this.board.slice();
        const c = await this.flies[k].choose(this.board, me);
        this.board[c] = me; this.lastMove = c; moves++;
        this.drawBoard(); this.drawSeen(k);
        if (train) {
          const [r, why] = trainerReward(before, c, me);
          tally[k][1]++; if (r > 0) tally[k][0]++;
          note = ` · ${this.flies[k].name}: ${why} ${r > 0 ? '🍬' : r < 0 ? '☕' : ''}`;
          await this.flies[k].reward(c, r);
        }
        me = 3 - me;
        if (delay) await sleep(delay);
      }
      if (!w) break;
      done++;
      if (w === 3) { A.record.d++; B.record.d++; }
      else { (w === 1 ? A : B).record.w++; (w === 1 ? B : A).record.l++; }
      if (train) for (const k of ['A', 'B']) {
        const f = this.flies[k]; f.trained++;
        f.praise.push(tally[k][1] ? tally[k][0] / tally[k][1] : 0);
      }
      this.say(`${w === 3 ? '무승부' : `${(w === 1 ? A : B).name}(${w === 1 ? '흑' : '백'}) 승리! 🎉`} (${moves}수)`);
      this.updateCards();
      if (forever && done % AUTOSAVE.omok === 0) await this.save(true);
      if (delay) await sleep(1200);
    }
    if (train) this.fast(false);
    if (this.stop) this.say(forever ? `♾️ 무한 조련을 멈췄습니다 — 이번에 ${done}판 가르쳤습니다.` : '멈췄습니다.');
    else if (train) this.say(`조련 ${games}판 끝. 카드의 발전 그래프가 오르는지 보세요. ▶ 대결은 학습 없이 실력만 겨룹니다.`);
    this.busy = false;
    await this.save(train);
  }

  // 🎓 조련: 두 판을 동시에 — 한 판은 A가 흑, 다른 판은 B가 흑. 두 판이 같은 박자로 진행되므로
  //   매 걸음 두 뇌(워커 두 개)가 서로 다른 판을 동시에 본다 → 한 뇌가 쉬지 않아 약 2배 빠르다.
  //   각 뇌의 메시지는 차례대로 처리되므로 '판 보기 → 그 수의 보상'이 섞이지 않는다.
  async runTrain(games) {
    if (this.busy || !this.flies) return;
    this.busy = true; this.stop = false; this.human = false;
    const forever = games === Infinity, t0 = performance.now(), other = k => k === 'A' ? 'B' : 'A';
    this.fast(true);
    const newGame = black => ({ board: new Int8Array(N * N), me: 1, black, moves: 0, last: -1, tally: { A: [0, 0], B: [0, 0] } });
    const mover = g => g.me === 1 ? g.black : other(g.black);
    const slots = [newGame('A')];
    let started = 1, done = 0, note = '';
    if (games > 1) { slots.push(newGame('B')); started++; }
    while (slots.length && !this.stop) {
      const rate = done ? ` · 분당 ${(done / ((performance.now() - t0) / 60000)).toFixed(1)}판` : '';
      const head = forever ? `♾️ 무한 조련 · ${done}판 끝${rate}` : `🎓 조련 ${done}/${games}판${rate}`;
      this.say(`${head} · ${slots.length > 1 ? '두 판 동시 진행' : '마지막 판'}${note}`);
      const notes = await Promise.all(slots.map(async (g, i) => {
        const k = mover(g), f = this.flies[k];
        const before = g.board.slice();
        const c = await f.choose(g.board, g.me);
        g.board[c] = g.me; g.last = c; g.moves++;
        const [r, why] = trainerReward(before, c, g.me);
        g.tally[k][1]++; if (r > 0) g.tally[k][0]++;
        if (i === 0) { this.board.set(g.board); this.lastMove = c; this.drawBoard(); }
        this.drawSeen(k);
        await f.reward(c, r);
        g.me = 3 - g.me;
        return `${f.name}: ${why} ${r > 0 ? '🍬' : r < 0 ? '☕' : ''}`;
      }));
      note = ' · ' + notes.join(' · ');
      for (let i = 0; i < slots.length; i++) {
        const g = slots[i], w = winner(g.board);
        if (!w) continue;
        const B = g.black, W = other(B);
        if (w === 3) { this.flies.A.record.d++; this.flies.B.record.d++; }
        else { this.flies[w === 1 ? B : W].record.w++; this.flies[w === 1 ? W : B].record.l++; }
        for (const k of ['A', 'B']) {
          const f = this.flies[k]; f.trained++;
          f.praise.push(g.tally[k][1] ? g.tally[k][0] / g.tally[k][1] : 0);
        }
        done++;
        this.updateCards();
        if (forever && done % AUTOSAVE.omok === 0) await this.save(true);
        if (started < games) {
          // 다른 판과 박자를 맞춘다: 그 판의 다음 차례가 아닌 초파리가 새 판의 흑
          const o = slots[1 - i], live = o && !winner(o.board);
          slots[i] = newGame(live ? other(mover(o)) : 'A'); started++;
        } else { slots.splice(i, 1); i--; }
      }
    }
    this.fast(false);
    this.say(this.stop
      ? (forever ? `♾️ 무한 조련을 멈췄습니다 — 이번에 ${done}판 가르쳤습니다.` : `멈췄습니다 (${done}판 조련).`)
      : `조련 ${games}판 끝. 카드의 발전 그래프가 오르는지 보세요. ▶ 대결은 학습 없이 실력만 겨룹니다.`);
    this.busy = false;
    await this.save(true);
  }

  // 🏓 mode: 'match' | 'train'(points점, Infinity = 멈출 때까지) | 'human'
  async runPong(mode, points = 10) {
    if (this.busy || !this.flies) return;
    this.busy = true; this.human = false;
    const train = mode === 'train', forever = points === Infinity;
    if (train) this.fast(true);
    const w = await this.pong.run(mode, {
      points, fast: train,
      onPoint: async n => { if (forever && n % AUTOSAVE.pong === 0) await this.save(true); },
    });
    if (train) this.fast(false);
    const { A, B } = this.flies;
    if (!w) this.say('멈췄습니다.');
    else if (mode === 'match') this.say(`${w === 'A' ? A.name : B.name} 승리! 🎉 (${this.pong.score.A} : ${this.pong.score.B})`);
    else if (mode === 'human') this.say(w === 'A' ? `${A.name} 승리! 🎉` : '내가 이겼다!');
    else this.say(`조련 ${points}점 끝. 카드의 '공 받아낸 비율' 그래프가 오르는지 보세요.`);
    this.busy = false;
    this.updateCards();
    await this.save(train);
  }

  // brain=true면 바뀐 시냅스까지, 아니면 기록만
  async save(brain) {
    if (!this.flies) return;
    const shared = this.store.state === 'shared';
    if (shared) this.showSave('💾 공유 저장소에 저장하는 중…');
    let ok = true;
    for (const k of ['A', 'B']) {
      const f = this.flies[k];
      if (brain) {
        const { idx, val } = await f.exportDiff();
        f.synChanged = idx.length;     // 같은 시냅스가 여러 번 바뀐 것은 한 번으로
        if (shared) ok = (await this.store.saveBrain(f.id, f.meta(), idx, val)) && ok;
      } else if (shared) ok = (await this.store.saveMeta(f.id, f.meta())) && ok;
      if (shared && ok) f.dirty = false;
      this.roster.set(f.id, { id: f.id, ...f.meta() });
    }
    if (shared && ok) this.savedAt = Date.now();
    this.fillPickers(); this.updateCards(); this.showSave();
  }

  showSave(text) {
    const el = document.getElementById('omok-save');
    if (text) { el.textContent = text; return; }
    const st = this.store.state;
    const when = this.savedAt ? ` · 마지막 저장 ${new Date(this.savedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
    el.textContent = st === 'shared'
      ? `💾 공유 저장소 연결됨 — 초파리마다 뇌와 기록이 자동 저장되고, 링크로 들어온 사람 모두가 이어받습니다${when}`
      : st === 'readonly'
        ? `👀 저장된 초파리를 불러왔습니다 (보기 전용). 여기서 더 가르치거나 새로 만든 초파리는 이 창에서만 유지됩니다${when}`
        : '💭 공유 저장소를 쓸 수 없어(로그인하지 않았거나 지원하지 않는 화면) 훈련과 새 초파리는 이 창에서만 유지됩니다';
    if (this.store.lastError) el.textContent += ` · ⚠️ ${this.store.lastError}`;
    document.getElementById('omok-reset').hidden = st !== 'shared';
  }

  // 두 번 눌러야 지금 자리에 앉은 두 초파리를 원래 연결체로 되돌린다
  async resetBrains() {
    if (this.busy || !this.flies) return;
    const btn = document.getElementById('omok-reset');
    if (!this.resetArmed) {
      this.resetArmed = true; btn.textContent = '⚠️ 한 번 더 누르면 초기화';
      setTimeout(() => { this.resetArmed = false; btn.textContent = '🧹 지금 두 뇌 초기화'; }, 3000);
      return;
    }
    this.resetArmed = false; btn.textContent = '🧹 지금 두 뇌 초기화';
    this.busy = true;
    for (const f of Object.values(this.flies)) {
      await f.importDiff(null);
      f.restore({ id: f.id, name: f.name, createdAt: f.createdAt });
      f.dirty = true;
      this.local.delete(f.id);
    }
    this.busy = false;
    this.updateCards();
    this.say(`${this.flies.A.name}·${josa(this.flies.B.name, '을', '를')} 원래 연결체로 되돌렸습니다.`);
    await this.save(true);
  }

  // 🧑 나(흑) vs 초파리(흑 자리 A가 백으로 응수)
  humanGame() {
    if (this.busy || !this.flies) return;
    this.board.fill(0); this.lastMove = -1; this.human = true; this.drawBoard();
    this.say(`나(흑) 차례 — 판을 클릭해서 두세요. ${josa(this.flies.A.name, '이', '가')} 백으로 응수합니다.`);
  }

  async click(e) {
    if (this.game !== 'omok' || !this.human || this.busy) return;
    const r = this.boardCv.getBoundingClientRect(), s = r.width / N;
    const c = Math.floor((e.clientY - r.top) / s) * N + Math.floor((e.clientX - r.left) / s);
    if (c < 0 || c >= N * N || this.board[c]) return;
    this.board[c] = 1; this.lastMove = c; this.drawBoard();
    let w = winner(this.board);
    const A = this.flies.A;
    if (!w) {
      this.busy = true;
      this.say(`${A.name}(백)가 판을 보는 중…`);
      const m = await A.choose(this.board, 2);
      this.board[m] = 2; this.lastMove = m; this.drawBoard(); this.drawSeen('A');
      this.busy = false;
      w = winner(this.board);
      if (!w) this.say('나(흑) 차례');
    }
    if (w) {
      this.human = false;
      if (w === 2) A.record.w++; else if (w === 1) A.record.l++; else A.record.d++;
      this.say(w === 3 ? '무승부!' : w === 1 ? '내가 이겼다!' : `${A.name} 승리! 🎉`);
      this.updateCards();
      this.save(false);
    }
  }

  updateCards() {
    const avg = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100);
    for (const k of ['A', 'B']) {
      const f = this.flies?.[k]; if (!f) continue;
      const $ = id => document.getElementById(id);
      $(`omok-name-${k}`).textContent = f.name;
      $(`omok-side-${k}`).textContent = this.sideName(k);
      $(`omok-seen-cap-${k}`).innerHTML = CAP[this.game].replace('{n}', '이 초파리');
      const syn = `지금까지 바뀐 시냅스 ${f.synChanged.toLocaleString()}개`;
      if (this.game === 'omok') {
        const r = f.record, p = f.praise, m = Math.min(10, Math.floor(p.length / 2));
        $(`omok-info-${k}`).textContent = `${r.w}승 ${r.l}패 ${r.d}무 · 누적 조련 ${f.trained}판`;
        $(`omok-pref-${k}`).textContent = !p.length
          ? `아직 오목 조련 전 · ${syn}`
          : p.length < 4
            ? `칭찬받은 수 ${avg(p)}% · ${syn}`
            : `칭찬받은 수: 처음 ${m}판 ${avg(p.slice(0, m))}% → 최근 ${m}판 ${avg(p.slice(-m))}% · ${syn}`;
        this.drawSeries(k, p, 10, '오목을 조련하면 판마다 칭찬받은 비율이 그려집니다');
        $(`omok-prog-${k}`).title = '조련 판마다 칭찬받은 수의 비율 · 노란 선 = 최근 10판 평균';
      } else {
        const P = f.pong, h = [...P.hits].map(Number), m = Math.min(20, Math.floor(h.length / 2));
        $(`omok-info-${k}`).textContent = `탁구 ${P.w}승 ${P.l}패 · 누적 조련 ${P.trained}점`;
        $(`omok-pref-${k}`).textContent = h.length < 4
          ? `공이 온 횟수 ${h.length}번 · ${syn}`
          : `공 받아낸 비율: 처음 ${m}번 ${avg(h.slice(0, m))}% → 최근 ${m}번 ${avg(h.slice(-m))}% · ${syn}`;
        this.drawSeries(k, h, 20, '공이 올 때마다 받아냈는지가 그려집니다');
        $(`omok-prog-${k}`).title = '공이 올 때마다 받아냄(1)/놓침(0) · 노란 선 = 최근 20번 평균';
      }
      this.drawSeen(k);
    }
  }

  // 발전 그래프: 값(점) + 최근 win개 이동 평균(선)
  drawSeries(k, p, win, empty) {
    const cv = document.getElementById(`omok-prog-${k}`), g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.fillStyle = '#0b0f1e'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    for (const y of [0.25, 0.5, 0.75]) { g.beginPath(); g.moveTo(0, H * y); g.lineTo(W, H * y); g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = '9px sans-serif';
    g.fillText('100%', 2, 9); g.fillText('0%', 2, H - 2);
    if (!p.length) { g.fillText(empty, 26, H / 2 + 3); return; }
    const x = i => p.length === 1 ? W / 2 : 24 + (W - 28) * i / (p.length - 1), y = v => H - 3 - (H - 6) * v;
    g.fillStyle = 'rgba(127,215,255,0.35)';
    p.forEach((v, i) => g.fillRect(x(i) - 1, y(v) - 1, 2, 2));
    g.strokeStyle = '#ffcf5a'; g.lineWidth = 2; g.beginPath();
    let s = 0;
    p.forEach((v, i) => {
      s += v; if (i >= win) s -= p[i - win];
      const a = s / Math.min(i + 1, win);
      i ? g.lineTo(x(i), y(a)) : g.moveTo(x(i), y(a));
    });
    g.stroke();
  }

  // 초파리가 본 판(오목) / 화면(탁구)
  drawSeen(k) {
    const cv = document.getElementById(`omok-seen-${k}`), g = cv.getContext('2d');
    if (this.game === 'pong') { this.pong.drawSeen(k, cv); return; }
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

  // 두 뇌의 활동을 위에서 내려다본 점그림으로 (+ 탁구면 탁구대)
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
    if (this.game === 'pong' && this.pong) {
      this.pong.draw(this.boardCv);
      if (this.pong.mode) { this.drawSeen('A'); this.drawSeen('B'); }
    }
    this.raf = requestAnimationFrame(() => this.loop());
  }
}
