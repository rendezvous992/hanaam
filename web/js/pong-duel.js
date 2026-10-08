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
// 화면의 탁구대 크기(캔버스 폭·높이 대비). 양 끝 뒤에 손잡이까지 들어간 라켓이 보일 자리를 남긴다.
export const TABLE_W = 0.5, TABLE_H = 0.68;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ── 라켓(위에서 본 셰이크핸드). 실제 블레이드 약 150×158mm, 손잡이(FL, 끝이 넓어짐) 약 100mm.
//   지역 좌표: 원점 = 블레이드 가운데, 단위 = 블레이드 반폭, +y = 선수 손 쪽.
//   블레이드 폭(2 단위)은 물리의 PAD_W와 같게 그린다 — 보이는 라켓 = 공을 받는 폭.
let RACKET = null;
function racketPaths() {
  if (RACKET) return RACKET;
  // 블레이드: 가운데보다 조금 위가 가장 넓고, 아래로 좁아지다 어깨가 오목하게 손잡이 목으로 이어진다
  const blade = new Path2D();
  blade.moveTo(0, -1.08);
  blade.bezierCurveTo(0.57, -1.08, 1, -0.72, 1, -0.12);
  blade.bezierCurveTo(1, 0.42, 0.7, 0.84, 0.33, 0.97);
  blade.bezierCurveTo(0.22, 1.01, 0.19, 1.05, 0.185, 1.14);
  blade.lineTo(-0.185, 1.14);
  blade.bezierCurveTo(-0.19, 1.05, -0.22, 1.01, -0.33, 0.97);
  blade.bezierCurveTo(-0.7, 0.84, -1, 0.42, -1, -0.12);
  blade.bezierCurveTo(-1, -0.72, -0.57, -1.08, 0, -1.08);
  blade.closePath();
  // 손잡이: 블레이드 면에 붙은 볼(러버가 둥글게 잘린 곳) → 목 → 끝으로 갈수록 넓어지는 몸통 → 둥근 끝
  const handle = new Path2D();
  handle.moveTo(-0.29, 0.86);
  handle.bezierCurveTo(-0.29, 0.71, -0.15, 0.645, 0, 0.645);
  handle.bezierCurveTo(0.15, 0.645, 0.29, 0.71, 0.29, 0.86);
  handle.bezierCurveTo(0.29, 0.97, 0.19, 1.02, 0.178, 1.15);
  handle.bezierCurveTo(0.17, 1.42, 0.19, 1.78, 0.236, 2.18);
  handle.quadraticCurveTo(0.246, 2.32, 0.12, 2.335);
  handle.quadraticCurveTo(0, 2.35, -0.12, 2.335);
  handle.quadraticCurveTo(-0.246, 2.32, -0.236, 2.18);
  handle.bezierCurveTo(-0.19, 1.78, -0.17, 1.42, -0.178, 1.15);
  handle.bezierCurveTo(-0.19, 1.02, -0.29, 0.97, -0.29, 0.86);
  handle.closePath();
  // 볼 윗선(러버가 끝나는 곳)
  const cheekTop = new Path2D();
  cheekTop.moveTo(-0.29, 0.86);
  cheekTop.bezierCurveTo(-0.29, 0.71, -0.15, 0.645, 0, 0.645);
  cheekTop.bezierCurveTo(0.15, 0.645, 0.29, 0.71, 0.29, 0.86);
  // 손잡이 나뭇결: 길이 방향으로 조금씩 휘는 선
  const grain = new Path2D();
  for (const [x, ph, amp] of [[-0.15, 0.4, 0.012], [-0.095, 2.1, 0.018], [-0.04, 1.2, 0.01], [0.03, 3.0, 0.016], [0.085, 0.7, 0.012], [0.14, 2.6, 0.01]]) {
    for (let y = 0.72; y <= 2.34; y += 0.04) {
      const xx = x * (1 + Math.max(0, y - 1.5) * 0.22) + Math.sin(y * 7 + ph) * amp;
      y === 0.72 ? grain.moveTo(xx, y) : grain.lineTo(xx, y);
    }
  }
  return RACKET = { blade, handle, cheekTop, grain };
}

// cx, cy: 블레이드 가운데(화면), bw: 블레이드 폭(px) = PAD_W × 탁구대 폭, rot: 회전(0 = 손잡이가 아래)
//   빛은 화면 왼쪽 위에서 온다(탁구대 반사광과 같은 쪽) — 라켓이 돌아가도 윤기·음영은 화면 기준으로 둔다.
function drawRacket(g, cx, cy, bw, rubber, rot, u) {
  const { blade, handle, cheekTop, grain } = racketPaths(), a = bw / 2, red = rubber === 'red';
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const L = (x, y) => [x * cs + y * sn, -x * sn + y * cs];      // 화면 방향 → 지역 방향
  const local = (dx = 0, dy = 0) => { g.translate(cx + dx, cy + dy); g.rotate(rot); g.scale(a, a); };
  const lw = 1 / a;                                               // 1px의 지역 단위
  // 1) 그림자 하나: 블레이드와 손잡이를 캔버스 밖에 함께 그리고 그림자만 탁구대 위로 (겹쳐 진해지지 않게)
  g.save();
  const OFF = 6000;
  g.translate(-OFF, 0); local();
  g.shadowColor = 'rgba(0,0,0,0.42)'; g.shadowBlur = 6 * u;
  g.shadowOffsetX = OFF + 3.5 * u; g.shadowOffsetY = 7 * u;
  g.fillStyle = '#000'; g.fill(blade); g.fill(handle);
  g.restore();
  // 2) 블레이드·손잡이 옆면(두께): 빛 반대쪽(오른쪽 아래)으로 살짝 비켜 그린 어두운 나무
  g.save(); local(0.45 * u, 1.1 * u);
  g.fillStyle = '#4b3019'; g.fill(blade); g.fill(handle);
  g.restore();
  g.save(); local();
  // 3) 블레이드 가장자리 합판 → 스펀지 → 러버(평평한 민러버)
  const [l0x, l0y] = L(-1, -1), [l1x, l1y] = L(1, 1);
  const ply = g.createLinearGradient(l0x, l0y, l1x, l1y);
  ply.addColorStop(0, '#d4aa75'); ply.addColorStop(0.5, '#b8895a'); ply.addColorStop(1, '#8a5f37');
  g.fillStyle = ply; g.fill(blade);
  g.strokeStyle = 'rgba(38,22,8,0.85)'; g.lineWidth = 0.5 * u * lw; g.stroke(blade);
  const inset = (px, draw) => { const k = 1 - px * lw; g.save(); g.translate(0, -0.04); g.scale(k, k); g.translate(0, 0.04); draw(); g.restore(); };
  inset(0.55 * u, () => { g.strokeStyle = 'rgba(70,42,18,0.5)'; g.lineWidth = 0.35 * u * lw; g.stroke(blade); });    // 합판 겹 선
  inset(1.05 * u, () => { g.fillStyle = red ? '#d9a453' : '#cf9d55'; g.fill(blade); });                                // 스펀지
  inset(1.6 * u, () => {
    const rg = g.createLinearGradient(l0x * 0.9, l0y * 0.9, l1x * 0.9, l1y * 0.9);
    if (red) { rg.addColorStop(0, '#c83a31'); rg.addColorStop(0.5, '#ab2821'); rg.addColorStop(1, '#831d19'); }
    else { rg.addColorStop(0, '#383a40'); rg.addColorStop(0.5, '#222327'); rg.addColorStop(1, '#141518'); }
    g.fillStyle = rg; g.fill(blade);
    g.save(); g.clip(blade);
    // 조명에 비친 넓고 부드러운 윤기 (민러버는 반무광)
    const [hx, hy] = L(-0.4, -0.45);
    const sh = g.createRadialGradient(hx, hy, 0, hx, hy, 1.1);
    sh.addColorStop(0, red ? 'rgba(255,200,185,0.22)' : 'rgba(215,220,235,0.15)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sh; g.fillRect(-1.3, -1.3, 2.6, 2.6);
    // 가장자리 쪽은 살짝 어둡게
    const rim = g.createRadialGradient(0, -0.05, 0.78, 0, -0.05, 1.08);
    rim.addColorStop(0, 'rgba(0,0,0,0)'); rim.addColorStop(1, 'rgba(0,0,0,0.18)');
    g.fillStyle = rim; g.fillRect(-1.3, -1.3, 2.6, 2.6);
    // 빛 쪽 가장자리의 가는 반사광 — 검은 러버가 어두운 바닥에서도 보이게
    const la = Math.atan2(...L(-0.6, -0.8).reverse());
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 0.7 * u * lw;
    g.beginPath(); g.ellipse(0, -0.1, 0.975, 0.955, 0, la - 0.55, la + 0.55); g.stroke();
    g.restore();
  });
  // 4) 손잡이: 둥근 나무(가로 음영, 빛 쪽이 밝게) + 길이 방향 나뭇결 + 가장자리 합판 선 + 끝의 나이테 면
  const side = L(-1, 0)[0] < 0 ? 1 : -1;                         // 지역 x에서 빛이 오는 쪽의 부호(-1 = 왼쪽)
  const wd = g.createLinearGradient(-0.25 * side, 0, 0.25 * side, 0);
  wd.addColorStop(0, '#6c4626'); wd.addColorStop(0.24, '#b98853'); wd.addColorStop(0.42, '#dbb47e');
  wd.addColorStop(0.7, '#b08050'); wd.addColorStop(1, '#5e3c20');
  g.fillStyle = wd; g.fill(handle);
  g.save(); g.clip(handle);
  g.strokeStyle = 'rgba(92,56,24,0.30)'; g.lineWidth = 0.45 * u * lw; g.stroke(grain);
  g.strokeStyle = 'rgba(64,38,16,0.38)'; g.lineWidth = 0.4 * u * lw;
  g.beginPath();
  for (const s of [-1, 1]) { g.moveTo(s * 0.152, 1.16); g.bezierCurveTo(s * 0.146, 1.42, s * 0.164, 1.78, s * 0.205, 2.3); }
  g.stroke();
  const end = g.createLinearGradient(0, 2.2, 0, 2.35);
  end.addColorStop(0, 'rgba(60,34,14,0)'); end.addColorStop(1, 'rgba(60,34,14,0.45)');
  g.fillStyle = end; g.fillRect(-0.3, 2.2, 0.6, 0.2);
  // 볼 아래, 블레이드와 맞닿는 곳의 옅은 그늘
  const neck = g.createLinearGradient(0, 0.95, 0, 1.2);
  neck.addColorStop(0, 'rgba(50,28,10,0)'); neck.addColorStop(0.5, 'rgba(50,28,10,0.16)'); neck.addColorStop(1, 'rgba(50,28,10,0)');
  g.fillStyle = neck; g.fillRect(-0.3, 0.95, 0.6, 0.25);
  g.restore();
  g.strokeStyle = 'rgba(40,22,8,0.7)'; g.lineWidth = 0.5 * u * lw; g.stroke(handle);
  // 러버가 끝나는 볼 윗선: 어두운 이음매 + 그 안쪽의 가는 빛
  g.strokeStyle = 'rgba(30,16,6,0.6)'; g.lineWidth = 0.6 * u * lw; g.stroke(cheekTop);
  g.save(); g.translate(0, 0.9 * u * lw);
  g.strokeStyle = 'rgba(255,236,205,0.30)'; g.lineWidth = 0.45 * u * lw; g.stroke(cheekTop);
  g.restore();
  g.restore();
}

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
          (this.swingT || (this.swingT = { A: -1e9, B: -1e9 }))[k] = performance.now();
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
        else if (d1 > d0 + 1e-4) [r, why] = [-0.2, '반대쪽으로'];
        else [r, why] = [-0.05, '제자리'];
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
    const tw = W * TABLE_W, th = H * TABLE_H, x0 = (W - tw) / 2, y0 = (H - th) / 2;
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
    // 상판 두께(25mm): 빛을 받는 왼쪽·위 모서리는 가는 밝은 선, 앞쪽 옆면은 어두운 띠
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x0, y0, tw, u); g.fillRect(x0, y0, u, th);
    g.fillStyle = '#123557'; g.fillRect(x0, y0 + th, tw, 2.2 * u);
    // 흰 테두리선(2cm)과 가운데 선(3mm)
    g.strokeStyle = 'rgba(245,247,250,0.92)';
    g.lineWidth = 3.2 * u; g.strokeRect(x0 + 1.6 * u, y0 + 1.6 * u, tw - 3.2 * u, th - 3.2 * u);
    g.lineWidth = 1.2 * u; g.beginPath(); g.moveTo(X(0.5), y0); g.lineTo(X(0.5), y0 + th); g.stroke();
    // 그물: 그림자 → 그물망 → 위 흰 띠 → 양옆 기둥(대 옆에 무는 죔쇠). 그물은 대 밖으로 폭의 약 10%만큼 나온다
    const ny = Y(0.5), ext = tw * 0.08;
    g.fillStyle = 'rgba(0,0,0,0.26)'; g.fillRect(x0 - ext, ny + 2 * u, tw + ext * 2, 5 * u);
    g.fillStyle = 'rgba(18,20,26,0.85)'; g.fillRect(x0 - ext, ny - 3 * u, tw + ext * 2, 6 * u);
    g.strokeStyle = 'rgba(200,205,215,0.16)'; g.lineWidth = 0.6 * u;
    g.beginPath();
    for (let x = x0 - ext + 1.75 * u; x < x0 + tw + ext; x += 3 * u) { g.moveTo(x, ny - 3 * u); g.lineTo(x, ny + 3 * u); }
    g.stroke();
    g.fillStyle = '#eceef1'; g.fillRect(x0 - ext, ny - 3.6 * u, tw + ext * 2, 1.6 * u);
    for (const px of [x0 - ext - 4 * u, x0 + tw + ext]) {
      g.fillStyle = '#3a3d45'; g.beginPath(); g.roundRect ? g.roundRect(px, ny - 4.5 * u, 4 * u, 9 * u, 1.2 * u) : g.rect(px, ny - 4.5 * u, 4 * u, 9 * u); g.fill();
      g.fillStyle = '#5a5e68'; g.fillRect(px + 0.8 * u, ny - 4.5 * u, 2.4 * u, u);
    }

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

    // 라켓(A 빨강 러버, 위쪽 B 검정 러버). 둘 다 오른손잡이: 손잡이는 선수 오른쪽 아래로 눕고,
    //   몸에서 먼 쪽으로 뻗을수록 더 눕고, 움직이는 반대쪽으로 살짝 끌린다(보기용 — 물리·초파리 화면과 무관).
    const bw = PAD_W * tw, first = !this.tilt;
    const tilt = this.tilt || (this.tilt = { A: 0, B: 0 });
    for (const k of ['A', 'B']) {
      const own = k === 'A' ? L(p.A, c.A) : 1 - L(p.B, c.B);          // 그 선수 시점의 라켓 위치
      const v = clamp((k === 'A' ? 1 : -1) * (this.vel[k] || 0) / PAD_SPEED, -1, 1);
      const target = -0.3 - (own - 0.5) * 0.55 - v * 0.08;
      tilt[k] = first ? target : tilt[k] + (target - tilt[k]) * 0.2;
    }
    // 휘두르기(보기용): 공이 다가오면 뒤로 젖혔다가(백스윙), 맞는 순간 앞으로 빠르게 휘두르고(팔로스루)
    //   0.3초에 걸쳐 제자리로. 손목(손잡이 끝 근처)을 축으로 돈다. 물리의 라켓 위치는 그대로다.
    const swT = this.swingT || (this.swingT = { A: -1e9, B: -1e9 }), bl = this.ball;
    const ease = x => x * x * (3 - 2 * x);
    const BACK = -0.35, FWD = 0.55, HIT = 110, REC = 310;
    const swing = (k, by) => {
      const since = now - swT[k];
      if (since < HIT) return { d: BACK + (FWD - BACK) * Math.sin(since / HIT * Math.PI / 2), push: since / HIT };
      if (since < HIT + REC) { const r = ease((since - HIT) / REC); return { d: FWD * (1 - r), push: 1 - r }; }
      const appr = !bl.passed && (k === 'A' ? bl.vy > 0 : bl.vy < 0);
      if (!appr) return { d: 0, push: 0 };
      const dist = Math.abs(by - (k === 'A' ? PAD_Y : 1 - PAD_Y));
      return { d: BACK * ease(clamp(1 - dist / 0.32, 0, 1)), push: 0 };
    };
    const byNow = L(p.y, c.y);
    const placeSwung = (k, cx, cy, rot) => {
      const { d, push } = swing(k, byNow), arm = 1.6 * bw / 2;      // 블레이드 중심에서 손목까지
      const px = cx - arm * Math.sin(rot), py = cy + arm * Math.cos(rot);   // 손목 위치(화면)
      const r2 = rot + d, toNet = (k === 'A' ? -1 : 1) * push * bw * 0.12;
      return [px + arm * Math.sin(r2), py - arm * Math.cos(r2) + toNet, r2];
    };
    { const [x, y, r] = placeSwung('B', X(L(p.B, c.B)), Y(1 - PAD_Y) + bw * 0.08, Math.PI + tilt.B); drawRacket(g, x, y, bw, 'black', r, u); }
    { const [x, y, r] = placeSwung('A', X(L(p.A, c.A)), Y(PAD_Y) - bw * 0.08, tilt.A); drawRacket(g, x, y, bw, 'red', r, u); }

    // 라켓에 맞은 순간: 공 자리에서 잠깐 퍼지는 옅은 고리
    this.fx = (this.fx || []).filter(e => now - e.t < 260);
    for (const e of this.fx) {
      const k = (now - e.t) / 260;
      g.strokeStyle = `rgba(255,240,220,${0.35 * (1 - k)})`; g.lineWidth = 1.2 * u;
      g.beginPath(); g.arc(X(e.x), Y(e.y), (5 + 9 * k) * u, 0, Math.PI * 2); g.stroke();
    }

    // 공: 높이(연출) → 그림자 오프셋·크기, 잔상
    const bx = L(p.x, c.x), by = L(p.y, c.y), b = this.ball;
    const from = b.vy > 0 ? 1 - PAD_Y : PAD_Y, s = clamp(Math.abs(by - from) / (2 * PAD_Y - 1), 0, 1.2);
    const h = s < 0.72 ? Math.sin(Math.PI * s / 0.72) : 0.5 * Math.sin(Math.PI * (s - 0.72) / 0.56);
    const hh = Math.max(0, h);
    this.trail = (this.trail || []).filter(q => now - q.t < 140);
    this.trail.push({ x: bx, y: by, h: hh, t: now });
    const br = BALL_R * tw * 0.9;
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
  //   (캔버스는 92 CSS px로 보인다 — 해상도는 경기장이 맞춰 준다)
  drawSeen(k, cv) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, u = W / 92, s = this.arena.flies[k].pongSeen;
    const cw = W / COLS, split = H * BAND_V;
    g.fillStyle = '#0b0f19'; g.fillRect(0, 0, W, H);
    // 열 테두리와 두 대역 사이 점선: 반응이 없어도 화면 구조가 읽히게
    g.strokeStyle = 'rgba(160,178,220,0.07)'; g.lineWidth = 0.5 * u;
    for (let c = 0; c < COLS; c++) {
      g.strokeRect(c * cw + 0.5 * u, 0.5 * u, cw - u, split - 1.5 * u);
      g.strokeRect(c * cw + 0.5 * u, split + u, cw - u, H - split - 1.5 * u);
    }
    g.save();
    g.strokeStyle = 'rgba(160,178,220,0.18)'; g.lineWidth = u; g.setLineDash([3 * u, 3 * u]);
    g.beginPath(); g.moveTo(0, split); g.lineTo(W, split); g.stroke();
    g.restore();
    if (!s) return;
    let mx = 1e-6; for (const x of s.fe) mx = Math.max(mx, x);
    for (let b = 0; b < 2; b++) for (let c = 0; c < COLS; c++) {
      const a = Math.sqrt(s.fe[b * COLS + c] / mx);
      if (a < 0.01) continue;
      g.fillStyle = `rgba(255,${120 + 100 * a | 0},${40 + 40 * a | 0},${a})`;
      g.fillRect(c * cw + 0.5 * u, b ? split + u : 0.5 * u, cw - u, b ? H - split - 1.5 * u : split - 1.5 * u);
    }
    g.strokeStyle = '#8cc8f5'; g.lineWidth = 1.25 * u;
    if (s.ball !== null) { g.beginPath(); g.arc(s.ball * W, split / 2, W * 0.055, 0, Math.PI * 2); g.stroke(); }
    if (s.pad !== null) { g.beginPath(); g.moveTo((s.pad - 0.1) * W, H - 4 * u); g.lineTo((s.pad + 0.1) * W, H - 4 * u); g.stroke(); }
  }
}
