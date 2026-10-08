// 🏓 초파리 두 마리 탁구 대결: 오목 경기장의 두 뇌(A·B)가 마주 보고 공을 친다.
//
// 보기: 매 순간(게임 시간 0.1초마다) 각자의 눈에 자기 시점 화면 — 공과 자기 패들(아래쪽) — 을
//   20ms 보여 준다. B는 반대편에 서 있으므로 화면을 180° 돌려서 본다. 상대 패들은 보이지 않는다.
// 움직임(정위 반응): 시각 뉴런 반응이 가장 강한 공 대역의 열 = 뇌가 본 공 위치,
//   아래 대역 = 뇌가 본 자기 패들 위치. 패들은 뇌가 본 공 쪽으로 간다. 학습된 디코더나
//   정답 신호는 없다.
// 조련: 공이 자기 쪽으로 올 때마다 조련사(심판)가 결과만 본다 — 공이 떨어질 곳으로 다가갔으면
//   칭찬, 멀어졌으면 꾸지람, 받아내면 크게 칭찬(설탕 + PAM), 놓치면 크게 꾸지람(쓴맛 + PPL1).
//   그 움직임을 만든 시냅스(뇌가 공을 본 열의 시각 뉴런으로 들어가며 방금 함께 발화한 입력)만
//   강화·약화된다. 조련사는 패들을 대신 움직이지 않는다.
import { SCREEN_W, SCREEN_H } from './vision.js';

const COLS = 12;
const BAND_V = 0.78;                    // 초파리 시점에서 이보다 아래는 자기 패들 대역
const PAD_Y = 0.9, PAD_W = 0.24, BALL_R = 0.035;
const PROBE_TICKS = 40;                 // 20ms — 수용장을 측정한 창과 같다
export const GAME_DT = 0.1;             // 뇌가 한 번 보고 정하는 간격(게임 시간, 초)
const PAD_SPEED = 0.9;                  // 화면 폭/초
const SERVE_SPEED = 0.42, MAX_SPEED = 0.9;
export const WIN_POINTS = 5, TRAIN_POINTS = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class PongDuel {
  constructor(arena) {
    this.arena = arena;
    const eye = arena.flies.A.eye;
    this.featOf = new Int16Array(eye.perN);
    this.featCnt = new Float32Array(2 * COLS);
    this.colNeurons = Array.from({ length: COLS }, () => []);   // 공 대역 열별 시각 뉴런(전역 인덱스)
    for (let k = 0; k < eye.perN; k++) {
      const band = eye.sv[k] >= BAND_V ? 1 : 0;
      const col = Math.min(COLS - 1, Math.floor(eye.su[k] * COLS));
      this.featOf[k] = band * COLS + col;
      this.featCnt[band * COLS + col]++;
      if (!band) this.colNeurons[col].push(arena.vis.perIdx[k]);
    }
    this.canvas = document.createElement('canvas');
    this.canvas.width = SCREEN_W; this.canvas.height = SCREEN_H;
    this.humanX = 0.5;
    this.reset();
  }

  reset() {
    this.score = { A: 0, B: 0 };
    this.pad = { A: 0.5, B: 0.5 }; this.vel = { A: 0, B: 0 };
    this.serve(Math.random() < 0.5 ? 'A' : 'B');
    this.prev = this.snap(); this.stepAt = performance.now(); this.stepDur = GAME_DT * 1000;
    this.note = ''; this.mode = null;
  }

  // 가운데에서 to 쪽으로
  serve(to) {
    const a = (Math.random() - 0.5) * 0.9;
    const dir = to === 'A' ? 1 : -1;
    this.ball = { x: 0.3 + Math.random() * 0.4, y: 0.5, vx: Math.sin(a) * SERVE_SPEED, vy: dir * Math.cos(a) * SERVE_SPEED, passed: false };
  }

  snap() { return { x: this.ball.x, y: this.ball.y, A: this.pad.A, B: this.pad.B }; }

  // 초파리 k의 시점: A는 그대로, B는 180° 돌려서 (자기 패들이 아래)
  view(k) {
    const g = this.canvas.getContext('2d', { willReadFrequently: true }), W = SCREEN_W, H = SCREEN_H, b = this.ball;
    const bx = k === 'A' ? b.x : 1 - b.x, by = k === 'A' ? b.y : 1 - b.y;
    const px = k === 'A' ? this.pad.A : 1 - this.pad.B;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(bx * W, by * H, BALL_R * W, 0, Math.PI * 2); g.fill();
    g.fillRect((px - PAD_W / 2) * W, PAD_Y * H - 3, PAD_W * W, 6);
    return this.arena.flies[k].eye.rates(this.canvas);
  }

  // 20ms 보여 주고 → 뇌가 본 공·패들 위치 → 패들 속도(월드 좌표)
  async look(k) {
    const f = this.arena.flies[k];
    const rates = this.view(k), keep = rates.slice();
    const { counts } = await f.call({ type: 'probe', key: 'vis', rates, ticks: PROBE_TICKS, learn: true }, [rates.buffer]);
    f.worker.postMessage({ type: 'drive', key: 'vis', rates: keep }, [keep.buffer]);
    const fe = new Float32Array(2 * COLS);
    for (let q = 0; q < counts.length; q++) fe[this.featOf[q]] += counts[q];
    for (let j = 0; j < fe.length; j++) fe[j] = this.featCnt[j] ? fe[j] / this.featCnt[j] : 0;
    const peak = band => {
      let best = -1, bv = 0;
      for (let c = 0; c < COLS; c++) if (fe[band * COLS + c] > bv) { bv = fe[band * COLS + c]; best = c; }
      if (best < 0) return null;
      let sw = 0, sx = 0;
      for (let c = Math.max(0, best - 1); c <= Math.min(COLS - 1, best + 1); c++) {
        sw += fe[band * COLS + c]; sx += fe[band * COLS + c] * (c + 0.5) / COLS;
      }
      return { x: sx / sw, col: best };
    };
    const ball = peak(0), pad = peak(1);
    const own = k === 'A' ? this.pad.A : 1 - this.pad.B;
    let v = 0;
    if (ball) v = clamp((ball.x - (pad ? pad.x : own)) * 4, -1, 1) * PAD_SPEED;
    f.pongSeen = { fe, ball: ball?.x ?? null, pad: pad?.x ?? null };
    return { v: k === 'A' ? v : -v, col: ball ? ball.col : -1 };
  }

  approaching(k) { return k === 'A' ? this.ball.vy > 0 && !this.ball.passed : this.ball.vy < 0 && !this.ball.passed; }

  // 패들이 없다고 치고 공이 k의 패들 선에 닿는 x (옆벽 반사 포함) — 조련사만 안다
  landingX(k) {
    const b = this.ball, yLine = k === 'A' ? PAD_Y - BALL_R : 1 - PAD_Y + BALL_R;
    const t = (yLine - b.y) / b.vy;
    if (!(t > 0)) return b.x;
    const span = 1 - 2 * BALL_R;
    let x = (b.x - BALL_R + b.vx * t) % (2 * span);
    if (x < 0) x += 2 * span;
    return BALL_R + (x > span ? 2 * span - x : x);
  }

  // 게임 시간 dt 동안 물리. 반환: [{k, hit}] — 공이 k에게 와서 받았는지/놓쳤는지
  physics(dt) {
    const ev = [], n = 4, h = dt / n, b = this.ball;
    for (let s = 0; s < n; s++) {
      for (const k of ['A', 'B']) this.pad[k] = clamp(this.pad[k] + this.vel[k] * h, PAD_W / 2, 1 - PAD_W / 2);
      b.x += b.vx * h; b.y += b.vy * h;
      if (b.x < BALL_R) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
      if (b.x > 1 - BALL_R) { b.x = 1 - BALL_R; b.vx = -Math.abs(b.vx); }
      for (const k of ['A', 'B']) {
        const down = k === 'A';
        const line = down ? PAD_Y - BALL_R : 1 - PAD_Y + BALL_R;
        if (b.passed || (down ? b.vy <= 0 || b.y < line : b.vy >= 0 || b.y > line)) continue;
        const off = (b.x - this.pad[k]) / (PAD_W / 2 + BALL_R);
        if (Math.abs(off) <= 1) {
          const sp = Math.min(MAX_SPEED, Math.hypot(b.vx, b.vy) * 1.05), a = off * 0.9;
          b.vx = Math.sin(a) * sp; b.vy = (down ? -1 : 1) * Math.abs(Math.cos(a) * sp);
          b.y = line;
          ev.push({ k, hit: true });
          (this.fx || (this.fx = [])).push({ x: b.x, y: line, t: performance.now() });
        } else b.passed = true;
      }
      if (b.y > 1.04 || b.y < -0.04) {
        const loser = b.y > 1 ? 'A' : 'B', winner = loser === 'A' ? 'B' : 'A';
        ev.push({ k: loser, hit: false });
        this.score[winner]++;
        this.serve(loser);
        break;
      }
    }
    return ev;
  }

  // 한 걸음: (두) 뇌가 동시에 보고 → 패들 속도 → 물리 → (조련이면) 칭찬·꾸지람
  async step(mode) {
    const players = mode === 'human' ? ['A'] : ['A', 'B'];
    const looks = await Promise.all(players.map(k => this.look(k)));
    players.forEach((k, i) => { this.vel[k] = looks[i].v; });
    if (mode === 'human') this.vel.B = clamp((this.humanX - this.pad.B) / GAME_DT, -PAD_SPEED * 1.2, PAD_SPEED * 1.2);
    const before = { ...this.pad }, land = {}, appr = {};
    for (const k of players) { appr[k] = this.approaching(k); if (appr[k]) land[k] = this.landingX(k); }
    this.prev = this.snap();
    const ev = this.physics(GAME_DT);
    if (ev.some(e => !e.hit)) this.prev = this.snap();     // 새 서브 — 화면에서 공이 순간 이동하지 않게
    // 공이 올 때마다 받았는지(1)/놓쳤는지(0) — 모든 경기에서 기록 (실력 측정)
    for (const e of ev) {
      const f = this.arena.flies[e.k];
      if (mode === 'human' && e.k === 'B') continue;
      f.pong.hits = (f.pong.hits + (e.hit ? '1' : '0')).slice(-5000);
    }
    if (mode !== 'train') return ev;
    const notes = [];
    await Promise.all(players.map(async (k, i) => {
      const e = ev.find(x => x.k === k);
      let r = 0, why = '';
      if (e) [r, why] = e.hit ? [1, '받아냄'] : [-1, '놓침'];
      else if (appr[k]) {
        const d0 = Math.abs(before[k] - land[k]), d1 = Math.abs(this.pad[k] - land[k]);
        if (d1 < PAD_W * 0.3) [r, why] = [0.1, '자리 잡음'];
        else if (d1 < d0 - 1e-4) [r, why] = [0.2, '공 쪽으로'];
        else if (d1 > d0 + 1e-4) [r, why] = [-0.2, '반대로'];
        else [r, why] = [-0.05, '멈춤'];
      }
      if (!r || looks[i].col < 0) return;
      const c = looks[i].col, post = [];
      for (let j = Math.max(0, c - 1); j <= Math.min(COLS - 1, c + 1); j++) post.push(...this.colNeurons[j]);
      await this.arena.flies[k].rewardNeurons(post, r, Math.abs(r) >= 1);
      if (e || Math.random() < 0.15) notes.push(`${this.arena.flies[k].name}: ${why} ${r > 0 ? '🍬' : '☕'}`);
    }));
    if (notes.length) this.note = ' · ' + notes.join(' · ');
    return ev;
  }

  // mode: 'match'(5점 먼저) · 'train'(points점, Infinity면 멈출 때까지) · 'human'(나 vs A)
  async run(mode, { points = TRAIN_POINTS, fast = false, onPoint } = {}) {
    const a = this.arena;
    this.reset(); this.mode = mode; a.stop = false;
    const t0 = performance.now();
    let played = 0;
    while (!a.stop) {
      const s0 = performance.now();
      const ev = await this.step(mode);
      for (const e of ev) if (!e.hit) {
        played++;
        if (mode === 'train') for (const k of ['A', 'B']) a.flies[k].pong.trained++;
        await onPoint?.(played);
      }
      const head = mode === 'train'
        ? (points === Infinity ? `무한 조련 ${played}점째 · 분당 ${Math.round(played / ((performance.now() - t0) / 60000) || 0)}점` : `조련 ${Math.min(played + 1, points)}/${points}점`)
        : mode === 'human' ? `나(위) vs ${a.flies.A.name}(아래)` : '대결 (5점 먼저)';
      a.say(`${head} · ${a.flies.A.name} ${this.score.A} : ${this.score.B} ${a.flies.B.name}${this.note}`);
      if (ev.length) a.updateCards();
      if (mode === 'train' ? played >= points : Math.max(this.score.A, this.score.B) >= WIN_POINTS) break;
      // 대결·사람 대국은 실제 시간보다 빠르지 않게, 조련은 뇌가 허락하는 만큼 빠르게
      const el = performance.now() - s0;
      if (!fast) await sleep(Math.max(0, GAME_DT * 1000 - el));
      this.stepDur = Math.max(16, performance.now() - this.stepAt); this.stepAt = performance.now();
    }
    this.stepAt = performance.now();
    if (a.stop) return null;
    const w = this.score.A > this.score.B ? 'A' : 'B';
    if (mode === 'match') { a.flies[w].pong.w++; a.flies[w === 'A' ? 'B' : 'A'].pong.l++; }
    if (mode === 'human') { if (w === 'A') a.flies.A.pong.w++; else a.flies.A.pong.l++; }
    return w;
  }

  // 화면: 위에서 내려다본 탁구대. 두 걸음 사이를 이어 그린다.
  //   물리 좌표 y = 0.1(위 라켓 줄) ~ 0.9(아래 라켓 줄)이 탁구대 양 끝에 오고, 놓친 공은 대 밖 바닥으로 나간다.
  //   공 높이는 보는 사람을 위한 연출이다(보낸 쪽에서 떠서 상대 코트에 한 번 튀고 라켓으로) —
  //   초파리 눈에 보여 주는 자극 화면(view)은 그대로 공과 자기 라켓만 있는 흑백 화면이다.
  draw(cv) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, u = W / 360;
    const now = performance.now();
    const t = clamp((now - this.stepAt) / this.stepDur, 0, 1), p = this.prev, c = this.snap();
    const L = (a, b) => a + (b - a) * t;
    const tw = W * 0.6, th = H * 0.84, x0 = (W - tw) / 2, y0 = (H - th) / 2;
    const X = x => x0 + x * tw, Y = y => y0 + (y - (1 - PAD_Y)) / (2 * PAD_Y - 1) * th;
    // 바닥
    const fl = g.createRadialGradient(W / 2, H / 2, W * 0.1, W / 2, H / 2, W * 0.75);
    fl.addColorStop(0, '#1b1d24'); fl.addColorStop(1, '#0c0d11');
    g.fillStyle = fl; g.fillRect(0, 0, W, H);
    // 탁구대 그림자 + 상판
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 18 * u; g.shadowOffsetY = 6 * u;
    g.fillStyle = '#1d4f7c'; g.fillRect(x0, y0, tw, th);
    g.restore();
    const top = g.createLinearGradient(x0, y0, x0 + tw, y0 + th);
    top.addColorStop(0, '#2563a0'); top.addColorStop(0.55, '#1d5590'); top.addColorStop(1, '#17477a');
    g.fillStyle = top; g.fillRect(x0, y0, tw, th);
    // 위쪽 조명 반사
    const sheen = g.createRadialGradient(x0 + tw * 0.35, y0 + th * 0.3, 0, x0 + tw * 0.35, y0 + th * 0.3, tw * 0.9);
    sheen.addColorStop(0, 'rgba(255,255,255,0.07)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sheen; g.fillRect(x0, y0, tw, th);
    // 흰 테두리선(2cm)과 가운데 선(3mm)
    g.strokeStyle = 'rgba(245,247,250,0.92)';
    g.lineWidth = 3.2 * u; g.strokeRect(x0 + 1.6 * u, y0 + 1.6 * u, tw - 3.2 * u, th - 3.2 * u);
    g.lineWidth = 1.2 * u; g.beginPath(); g.moveTo(X(0.5), y0); g.lineTo(X(0.5), y0 + th); g.stroke();
    // 그물: 그림자 → 그물망 → 위 흰 띠 → 양옆 기둥
    const ny = Y(0.5), ext = 10 * u;
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(x0 - ext, ny + 2 * u, tw + ext * 2, 6 * u);
    g.fillStyle = 'rgba(18,20,26,0.85)'; g.fillRect(x0 - ext, ny - 3 * u, tw + ext * 2, 6 * u);
    g.strokeStyle = 'rgba(200,205,215,0.18)'; g.lineWidth = 0.8 * u;
    for (let x = x0 - ext; x < x0 + tw + ext; x += 3.5 * u) { g.beginPath(); g.moveTo(x, ny - 3 * u); g.lineTo(x, ny + 3 * u); g.stroke(); }
    g.fillStyle = '#f2f3f5'; g.fillRect(x0 - ext, ny - 3.6 * u, tw + ext * 2, 1.6 * u);
    g.fillStyle = '#2b2e36';
    for (const px of [x0 - ext - 3 * u, x0 + tw + ext]) g.fillRect(px, ny - 5 * u, 3 * u, 10 * u);

    // 점수판 (대 옆 바닥)
    const f = this.arena.flies, nameB = this.mode === 'human' ? '나' : f.B.name;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const side = (W - tw) / 4;
    for (const [nm, sc, y] of [[nameB, this.score.B, H * 0.3], [f.A.name, this.score.A, H * 0.7]]) {
      g.fillStyle = 'rgba(255,255,255,0.9)'; g.font = `600 ${30 * u}px "IBM Plex Mono", ui-monospace, monospace`;
      g.fillText(String(sc), W - side, y);
      g.fillStyle = 'rgba(200,206,220,0.55)'; g.font = `500 ${10 * u}px "IBM Plex Sans KR", system-ui, sans-serif`;
      g.fillText(nm.length > 7 ? nm.slice(0, 7) + '…' : nm, W - side, y + 24 * u);
    }
    g.textBaseline = 'alphabetic'; g.textAlign = 'left';

    // 라켓: 둥근 판 + 러버(A 빨강, 위쪽 검정) + 나무 테두리 + 손잡이(선수 쪽)
    const paddle = (x, y, rubber, out) => {
      const rx = PAD_W / 2 * tw, ry = rx * 0.78, cx = X(x), cy = Y(y);
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 8 * u; g.shadowOffsetY = 4 * u;
      // 손잡이
      const hw = rx * 0.3, hl = ry * 1.25, hy = out > 0 ? cy + ry * 0.75 : cy - ry * 0.75 - hl;
      const wood = g.createLinearGradient(cx - hw / 2, 0, cx + hw / 2, 0);
      wood.addColorStop(0, '#9c6d3d'); wood.addColorStop(0.5, '#d2a46a'); wood.addColorStop(1, '#8e6134');
      g.fillStyle = wood;
      g.beginPath(); g.roundRect ? g.roundRect(cx - hw / 2, hy, hw, hl, hw * 0.35) : g.rect(cx - hw / 2, hy, hw, hl); g.fill();
      // 판(나무 테두리)
      g.fillStyle = '#c9965e';
      g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.fill();
      g.restore();
      // 러버
      const rg = g.createRadialGradient(cx - rx * 0.3, cy - ry * 0.35, rx * 0.1, cx, cy, rx);
      if (rubber === 'red') { rg.addColorStop(0, '#e2483f'); rg.addColorStop(1, '#a8211c'); }
      else { rg.addColorStop(0, '#3a3c43'); rg.addColorStop(1, '#141519'); }
      g.fillStyle = rg;
      g.beginPath(); g.ellipse(cx, cy, rx - 2.2 * u, ry - 2.2 * u, 0, 0, Math.PI * 2); g.fill();
      // 러버 돌기 결
      g.fillStyle = 'rgba(255,255,255,0.05)';
      for (let i = -3; i <= 3; i++) for (let j = -2; j <= 2; j++) {
        const dx = i * rx * 0.24, dy = j * ry * 0.3;
        if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) < 0.7) { g.beginPath(); g.arc(cx + dx, cy + dy, 1.1 * u, 0, Math.PI * 2); g.fill(); }
      }
    };
    paddle(L(p.B, c.B), 1 - PAD_Y, 'black', -1);
    paddle(L(p.A, c.A), PAD_Y, 'red', 1);

    // 라켓에 맞은 순간의 고리
    this.fx = (this.fx || []).filter(e => now - e.t < 350);
    for (const e of this.fx) {
      const k = (now - e.t) / 350;
      g.strokeStyle = `rgba(255,236,200,${0.6 * (1 - k)})`; g.lineWidth = 2 * u;
      g.beginPath(); g.arc(X(e.x), Y(e.y), (8 + 26 * k) * u, 0, Math.PI * 2); g.stroke();
    }

    // 공: 높이(연출) → 그림자 오프셋·크기, 잔상
    const bx = L(p.x, c.x), by = L(p.y, c.y), b = this.ball;
    const from = b.vy > 0 ? 1 - PAD_Y : PAD_Y, s = clamp(Math.abs(by - from) / (2 * PAD_Y - 1), 0, 1.2);
    const h = s < 0.72 ? Math.sin(Math.PI * s / 0.72) : 0.5 * Math.sin(Math.PI * (s - 0.72) / 0.56);
    const hh = Math.max(0, h);
    this.trail = (this.trail || []).filter(q => now - q.t < 140);
    this.trail.push({ x: bx, y: by, h: hh, t: now });
    const br = BALL_R * tw * 0.75;
    g.fillStyle = `rgba(0,0,0,${0.35 - hh * 0.15})`;
    g.beginPath(); g.ellipse(X(bx) + hh * 7 * u, Y(by) + hh * 12 * u, br * (1 + hh * 0.3), br * 0.8 * (1 + hh * 0.3), 0, 0, Math.PI * 2); g.fill();
    for (const q of this.trail) {
      const a = 1 - (now - q.t) / 140;
      g.fillStyle = `rgba(255,170,90,${0.18 * a})`;
      g.beginPath(); g.arc(X(q.x), Y(q.y) - q.h * 9 * u, br * (1 + q.h * 0.35), 0, Math.PI * 2); g.fill();
    }
    const bxs = X(bx), bys = Y(by) - hh * 9 * u, rr = br * (1 + hh * 0.35);
    const ball = g.createRadialGradient(bxs - rr * 0.35, bys - rr * 0.4, rr * 0.1, bxs, bys, rr);
    ball.addColorStop(0, '#fff6ea'); ball.addColorStop(0.45, '#ffb15a'); ball.addColorStop(1, '#e07a22');
    g.fillStyle = ball;
    g.beginPath(); g.arc(bxs, bys, rr, 0, Math.PI * 2); g.fill();
  }

  // 초파리가 본 화면(자기 시점): 위 = 공 대역, 아래 = 패들 대역, 밝을수록 반응이 강함
  drawSeen(k, cv) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, s = this.arena.flies[k].pongSeen;
    g.fillStyle = '#0b0f1e'; g.fillRect(0, 0, W, H);
    if (!s) return;
    let mx = 1e-6; for (const x of s.fe) mx = Math.max(mx, x);
    const cw = W / COLS, split = H * BAND_V;
    for (let b = 0; b < 2; b++) for (let c = 0; c < COLS; c++) {
      const a = Math.sqrt(s.fe[b * COLS + c] / mx);
      g.fillStyle = `rgba(255,${120 + 100 * a | 0},${40 + 40 * a | 0},${a})`;
      g.fillRect(c * cw + 1, b ? split + 2 : 1, cw - 2, b ? H - split - 3 : split - 2);
    }
    g.strokeStyle = '#7fd7ff'; g.lineWidth = 2;
    if (s.ball !== null) { g.beginPath(); g.arc(s.ball * W, split / 2, 6, 0, Math.PI * 2); g.stroke(); }
    if (s.pad !== null) { g.beginPath(); g.moveTo(s.pad * W - 12, H - 4); g.lineTo(s.pad * W + 12, H - 4); g.stroke(); }
  }
}
