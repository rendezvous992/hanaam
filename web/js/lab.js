// 실험실: 📺 TV 보여주기 / 🏓 탁구 — 화면 → 광수용체 → 연결체 → 시각 뉴런 → 판독.
//
// 탁구 패들은 초파리 뇌가 직접 움직인다(정위 반응): 수용장을 아는 시각 뉴런 중
// 공 영역에서 가장 강하게 반응한 위치로 패들이 간다. 패들 위치도 뇌가 본 위치를 쓴다.
// 학습된 디코더나 정답 신호는 없다 — 뇌가 공을 어디서 보느냐가 전부다.
// 공을 치면 설탕 미각 뉴런 + 보상 도파민(PAM), 놓치면 쓴맛 + 처벌 도파민(PPL1)을 자극한다.
import { SCREEN_W, SCREEN_H } from './vision.js';

const COLS = 12;
const BAND_V = 0.78;                 // 이보다 아래(v 큼)는 패들 대역
const PAD_Y = 0.9, PAD_W = 0.24, BALL_R = 0.035;

export class Lab {
  constructor({ worker, eye, fly, meta, vis }) {
    this.worker = worker; this.eye = eye; this.fly = fly;
    this.mode = 'off'; this.channel = 'stripes';
    this.t = 0; this.lastDrive = 0;
    this.screen = document.createElement('canvas');
    this.screen.width = SCREEN_W; this.screen.height = SCREEN_H;
    this.ctx = this.screen.getContext('2d', { willReadFrequently: true });
    this.reward = {
      good: [...meta.presets.sugar.idx, ...vis.info.pam],
      bad: [...meta.presets.bitter.idx, ...vis.info.ppl1],
    };
    worker.postMessage({ type: 'driveSet', key: 'vis', indices: eye.photoIdx });
    worker.postMessage({ type: 'watch', indices: eye.perIdx });

    // 판독층 특징: 시각 뉴런 → (대역, 열)
    this.featOf = new Int16Array(eye.perN);
    this.featCnt = new Float32Array(2 * COLS);
    for (let k = 0; k < eye.perN; k++) {
      const band = eye.sv[k] >= BAND_V ? 1 : 0;
      const col = Math.min(COLS - 1, Math.floor(eye.su[k] * COLS));
      this.featOf[k] = band * COLS + col;
      this.featCnt[band * COLS + col]++;
    }
    this.resetPong();
    this.stars = [];
  }

  resetPong() {
    this.ball = this.newBall();
    this.pad = 0.5; this.padV = 0;
    this.hits = 0; this.misses = 0; this.recent = [];
    this.seenBall = null; this.seenPad = null;
  }

  newBall() {
    const a = (Math.random() - 0.5) * 1.1;
    return { x: 0.15 + Math.random() * 0.7, y: 0.12, vx: Math.sin(a) * 0.32, vy: Math.cos(a) * 0.32 };
  }

  setMode(mode) {
    this.mode = mode;
    this.eye.ema.fill(0);
    if (mode === 'off') this.worker.postMessage({ type: 'drive', key: 'vis', rates: null });
    this.fly.setScreen?.(mode === 'off' ? null : this.screen,
                         mode === 'pong' ? '🏓 탁구 치는 중' : '📺 TV 보는 중');
  }

  pulse(kind) {
    const key = 'rew-' + kind;
    this.worker.postMessage({ type: 'stim', key, on: true, rate: 150, indices: this.reward[kind] });
    clearTimeout(this['_t' + kind]);
    this['_t' + kind] = setTimeout(() => this.worker.postMessage({ type: 'stim', key, on: false }), 250);
  }

  // ── 화면 그리기 ─────────────────────────────
  draw(dt) {
    const g = this.ctx, W = SCREEN_W, H = SCREEN_H, t = this.t;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    if (this.mode === 'pong') {
      const b = this.ball;
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(b.x * W, b.y * H, BALL_R * W, 0, Math.PI * 2); g.fill();
      g.fillRect((this.pad - PAD_W / 2) * W, PAD_Y * H - 3, PAD_W * W, 6);
      return;
    }
    if (this.channel === 'stripes') {           // 흐르는 줄무늬 (광운동 반응 실험)
      for (let x = 0; x < W; x++) {
        const l = 0.5 + 0.5 * Math.sin(2 * Math.PI * (x / 26 - t * 0.7));
        g.fillStyle = `rgb(${l * 255 | 0},${l * 255 | 0},${l * 255 | 0})`;
        g.fillRect(x, 0, 1, H);
      }
    } else if (this.channel === 'loom') {       // 다가오는 원 (천적 접근)
      const p = (t % 2.6) / 1.7;
      if (p < 1) {
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(W / 2, H / 2, 3 + 70 * p * p * p, 0, Math.PI * 2); g.fill();
      }
    } else if (this.channel === 'flicker') {    // 깜빡이는 화면
      if (Math.floor(t * 6) % 2 === 0) { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); }
    } else if (this.channel === 'stars') {      // 반딧불
      if (Math.random() < dt * 14) this.stars.push({ x: Math.random() * W, y: Math.random() * H, life: 1 });
      for (const s of this.stars) {
        s.life -= dt * 0.8;
        g.fillStyle = `rgba(255,240,170,${Math.max(0, s.life)})`;
        g.beginPath(); g.arc(s.x, s.y, 3 + 3 * s.life, 0, Math.PI * 2); g.fill();
      }
      this.stars = this.stars.filter(s => s.life > 0);
    }
  }

  // ── 탁구 물리 (실시간) ───────────────────────
  stepPong(dt) {
    const b = this.ball;
    this.pad = Math.max(PAD_W / 2, Math.min(1 - PAD_W / 2, this.pad + this.padV * dt));
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.x < BALL_R) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
    if (b.x > 1 - BALL_R) { b.x = 1 - BALL_R; b.vx = -Math.abs(b.vx); }
    if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); }
    if (b.vy > 0 && b.y >= PAD_Y - BALL_R && b.y < PAD_Y + 0.02) {
      const off = (b.x - this.pad) / (PAD_W / 2 + BALL_R);
      if (Math.abs(off) <= 1) {
        const sp = Math.hypot(b.vx, b.vy), a = off * 0.9;
        b.vx = Math.sin(a) * sp; b.vy = -Math.abs(Math.cos(a) * sp);
        this.hits++; this.recent.push(1); this.pulse('good');
      }
    }
    if (b.y > 1.05) {
      this.misses++; this.recent.push(0); this.pulse('bad');
      this.ball = this.newBall();
    }
    if (this.recent.length > 20) this.recent.shift();
  }

  // ── 뇌 → 패들: 정위 반응 ────────────────────
  // 위 대역(공)에서 시각 뉴런 반응이 가장 강한 열 주변의 무게중심 = 뇌가 본 공 위치,
  // 아래 대역 무게중심 = 뇌가 본 패들 위치. 패들은 뇌가 본 공 쪽으로 움직인다.
  readout() {
    const e = this.eye.ema, f = new Float32Array(2 * COLS);
    for (let k = 0; k < this.eye.perN; k++) f[this.featOf[k]] += e[k];
    for (let j = 0; j < f.length; j++) f[j] = this.featCnt[j] ? f[j] / this.featCnt[j] : 0;
    const peak = band => {
      let best = -1, bv = 0;
      for (let c = 0; c < COLS; c++) if (f[band * COLS + c] > bv) { bv = f[band * COLS + c]; best = c; }
      if (best < 0) return null;
      let sw = 0, sx = 0;
      for (let c = Math.max(0, best - 1); c <= Math.min(COLS - 1, best + 1); c++) {
        sw += f[band * COLS + c]; sx += f[band * COLS + c] * (c + 0.5) / COLS;
      }
      return sx / sw;
    };
    this.seenBall = peak(0);
    this.seenPad = peak(1);
    if (this.seenBall === null) { this.padV = 0; return; }
    const pad = this.seenPad ?? this.pad;
    this.padV = Math.max(-1, Math.min(1, (this.seenBall - pad) * 4)) * 0.9;
  }

  // 워커 프레임마다: 시각 뉴런 반응 누적 → 판독
  onFrame(m) {
    if (this.mode === 'off' || !m.watch) return;
    this.eye.accumulate(m.watch, 0.75);
    if (this.mode === 'pong') this.readout();
  }

  // 애니메이션 프레임마다: 화면 갱신 → 광수용체 입력
  tick(dt, now) {
    if (this.mode === 'off') return;
    this.t += dt;
    if (this.mode === 'pong') this.stepPong(dt);
    this.draw(dt);
    this.fly.screenUpdated?.();
    if (now - this.lastDrive > 33) {
      this.lastDrive = now;
      const rates = this.eye.rates(this.screen);
      this.worker.postMessage({ type: 'drive', key: 'vis', rates }, [rates.buffer]);
    }
  }

  stats() {
    const rate = this.recent.length ? this.recent.reduce((a, b) => a + b, 0) / this.recent.length : 0;
    return { hits: this.hits, misses: this.misses, rate, n: this.recent.length,
             seenBall: this.seenBall, ball: this.ball.x };
  }
}
