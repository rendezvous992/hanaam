// 초파리 아바타: 뇌 시뮬레이션의 운동·하행 뉴런 발화율을 읽어 행동으로 변환한다.
//  - 전진: DNp09 발화율, 후진(문워크): MDN, 점프: Giant Fiber, 주둥이: 주둥이 운동뉴런
//  - 에탄올: 비틀거림(흔들림·갈지자), 고용량에서 기절
// 렌더링은 SVG 요소를 매 프레임 갱신하는 방식. 의존성 없음.

const W = 380, H = 240, FLOOR = 208;
const S = 1.45;   // 아바타 확대 배율

export class Fly {
  constructor(container) {
    this.x = W * 0.5;
    this.dir = 1;              // 바라보는 방향 (1: 오른쪽)
    this.jumpT = -1;           // 점프 경과 시간 (-1: 점프 아님)
    this.jumpCooldown = 0;
    this.prob = 0;             // 주둥이 뻗은 정도 0..1
    this.sway = 0;
    this.passedOut = false;
    this.passT = 0;            // 기절/기상 트윈 0..1
    this.t = 0;
    this.walkPhase = 0;
    this.eth = 0;
    this.rates = { fwd: 0, back: 0, jump: 0, prob: 0, dn: 0, motor: 0, brain: 0 };
    this.s = { fwd: 0, back: 0, jump: 0, prob: 0 };   // 행동 판정용 느린 평활 신호
    this.behavior = '대기';
    this._staggerVx = 0;

    container.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">
  <defs>
    <linearGradient id="floorg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgba(120,140,200,0.16)"/>
      <stop offset="1" stop-color="rgba(120,140,200,0.02)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${FLOOR}" width="${W}" height="${H - FLOOR}" fill="url(#floorg)"/>
  <line x1="0" y1="${FLOOR}" x2="${W}" y2="${FLOOR}" stroke="rgba(150,170,230,0.35)" stroke-width="1"/>
  <ellipse id="f-shadow" cx="0" cy="${FLOOR + 6}" rx="34" ry="5" fill="rgba(0,0,0,0.45)"/>
  <g id="f-root">
    <g id="f-legs" stroke="#6b5a3f" stroke-width="2.4" fill="none" stroke-linecap="round"></g>
    <g id="f-wings">
      <ellipse id="f-wing2" cx="-14" cy="-26" rx="30" ry="10" fill="rgba(190,210,255,0.28)"
               stroke="rgba(200,220,255,0.45)" stroke-width="1"/>
      <ellipse id="f-wing1" cx="-12" cy="-24" rx="32" ry="11" fill="rgba(200,220,255,0.38)"
               stroke="rgba(210,230,255,0.55)" stroke-width="1"/>
    </g>
    <ellipse cx="-18" cy="-6" rx="24" ry="15" fill="#b98d55"/>
    <path d="M -34 -10 Q -20 -20 -2 -14 L -2 2 Q -22 8 -36 -2 Z" fill="#a3763f" opacity="0.55"/>
    <ellipse cx="4" cy="-12" rx="14" ry="12" fill="#c99b60"/>
    <circle cx="18" cy="-12" r="10" fill="#d3a86b"/>
    <ellipse cx="21" cy="-13" rx="6.5" ry="7.5" fill="#8d2f2f"/>
    <ellipse cx="22.5" cy="-15" rx="2.2" ry="2.6" fill="#e8b9b9" opacity="0.85"/>
    <path id="f-ant" d="M 24 -21 Q 30 -27 34 -26" stroke="#7a6547" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    <path id="f-prob" d="M 24 -4 q 2 4 1 8" stroke="#8d6a3f" stroke-width="3.2" fill="none" stroke-linecap="round"/>
    <g id="f-cig" opacity="0">
      <path d="M 22 -6 q 6 -2 10 2" stroke="#6b5a3f" stroke-width="1.6" fill="none"/>
      <line x1="30" y1="-3" x2="39" y2="1" stroke="#ece6d6" stroke-width="2.8" stroke-linecap="round"/>
      <circle id="f-ember" cx="40" cy="1.5" r="1.7" fill="#ff7a30"/>
      <g id="f-smoke" fill="rgba(205,215,235,0.4)">
        <circle cx="41" cy="-4" r="2"/>
        <circle cx="42" cy="-12" r="2.6"/>
        <circle cx="43" cy="-20" r="3.2"/>
      </g>
    </g>
  </g>
</svg>`;
    this.root = container.querySelector('#f-root');
    this.legsG = container.querySelector('#f-legs');
    this.wing1 = container.querySelector('#f-wing1');
    this.wing2 = container.querySelector('#f-wing2');
    this.ant = container.querySelector('#f-ant');
    this.probEl = container.querySelector('#f-prob');
    this.shadow = container.querySelector('#f-shadow');
    this.cig = container.querySelector('#f-cig');
    this.ember = container.querySelector('#f-ember');
    this.smoke = [...container.querySelectorAll('#f-smoke circle')];
    this.nic = 0;
    this.cigO = 0;
    // 다리 6개 (앞2, 중2, 뒤2) — path를 매 프레임 갱신
    this.legs = [];
    const hips = [[10, 0], [2, 2], [-8, 2], [12, 0], [4, 2], [-6, 2]];
    for (let i = 0; i < 6; i++) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      if (i >= 3) p.setAttribute('opacity', '0.55');   // 반대편 다리
      this.legsG.appendChild(p);
      this.legs.push({ el: p, hip: hips[i], phase: (i % 3) * 2.1 + (i >= 3 ? Math.PI : 0) });
    }
  }

  setRates(r) { Object.assign(this.rates, r); }
  setEthanol(v) { this.eth = v; }
  setNicotine(v) { this.nic = v; }

  update(dt) {
    this.t += dt;
    const r = this.rates, eth = this.eth;

    // ── 행동 결정 ─────────────────────────────
    // (1) 전뇌 평균 발화율을 기준선으로 빼서, 점화 파도에 휩쓸린 발화가 아니라
    //     해당 그룹이 특이적으로 높을 때만 행동 신호로 인정하고,
    // (2) 순간 버스트에 휘둘리지 않게 느린 평활(τ≈0.4s)을 한 번 더 거친다.
    const k2 = Math.min(1, dt * 2.5);
    for (const key of ['fwd', 'back', 'jump', 'prob']) {
      const raw = Math.max(0, r[key] - 2.5 * r.brain - 2);
      this.s[key] += (raw - this.s[key]) * k2;
    }
    // GF는 2개뿐이라 잡음이 커서 임계값을 높게 잡는다 (명령 자극 수준에서만 점프)
    const wantJump = this.s.jump > 80 && this.jumpCooldown <= 0 && !this.passedOut;
    // 섭식 vs 보행 우선순위: 더 강한 쪽이 이긴다 (섭식 중에는 실제 초파리도 멈춘다)
    const loco = Math.abs(this.s.fwd - this.s.back);
    const feeding = this.s.prob > 12 && this.s.prob > 0.55 * loco;
    const probTarget = Math.max(0, Math.min(1, this.s.prob / 22)) * (feeding ? 1 : 0.35);
    const feedGate = feeding ? 0 : 1;
    const speed = Math.max(-1, Math.min(1, this.s.fwd / 45 - this.s.back / 45)) * feedGate;

    // 기절 판정 (히스테리시스)
    if (!this.passedOut && eth > 0.85) this.passedOut = true;
    if (this.passedOut && eth < 0.7) this.passedOut = false;
    this.passT += ((this.passedOut ? 1 : 0) - this.passT) * Math.min(1, dt * 3);

    if (wantJump) { this.jumpT = 0; this.jumpCooldown = 0.9; }
    if (this.jumpT >= 0) { this.jumpT += dt; if (this.jumpT > 0.55) this.jumpT = -1; }
    this.jumpCooldown -= dt;

    // ── 이동 ─────────────────────────────────
    const upright = 1 - this.passT;
    let vx = 0;
    if (this.jumpT < 0 && upright > 0.6) {
      vx = speed * 90 * this.dir * upright;
      // 만취 갈지자: 무작위 옆걸음
      if (eth > 0.1) {
        this._staggerVx += (Math.random() - 0.5) * eth * 260 * dt;
        this._staggerVx *= 1 - Math.min(1, dt * 2.5);
        vx += this._staggerVx;
      }
    }
    this.x += vx * dt;
    if (this.x < 42) { this.x = 42; this.dir = 1; }
    if (this.x > W - 42) { this.x = W - 42; this.dir = -1; }

    // ── 자세 ─────────────────────────────────
    const walking = Math.abs(speed) > 0.06 && this.jumpT < 0 && upright > 0.6;
    this.walkPhase += dt * (walking ? 10 + 14 * Math.abs(speed) : 1.2);

    let y = FLOOR - 22 * S;
    let rot = 0;
    if (this.jumpT >= 0) {                       // 점프 포물선
      const jt = this.jumpT / 0.55;
      y -= Math.sin(jt * Math.PI) * 62;
      rot = -14 * this.dir * Math.sin(jt * Math.PI);
    }
    y += Math.sin(this.t * 2.2) * 1.4 * upright; // 숨쉬기 보브
    // 만취 흔들림
    this.sway = eth * (10 * Math.sin(this.t * 3.1) + 5 * Math.sin(this.t * 5.7));
    rot += this.sway * upright;
    // 기절: 뒤로 벌러덩
    rot += this.passT * -168 * this.dir;
    y += this.passT * 9;

    this.root.setAttribute('transform',
      `translate(${this.x} ${y}) scale(${this.dir * S} ${S}) rotate(${rot * this.dir})`);
    this.shadow.setAttribute('cx', this.x);
    const air = Math.max(0, (FLOOR - 22 * S - y) / 62);
    this.shadow.setAttribute('rx', (34 - air * 14) * S);
    this.shadow.setAttribute('opacity', 0.45 - air * 0.25);

    // ── 다리 ─────────────────────────────────
    for (const leg of this.legs) {
      const [hx, hy] = leg.hip;
      let kx, ky, fx, fy;
      if (this.passT > 0.5) {                    // 기절: 다리 허우적
        const w = Math.sin(this.t * 6 + leg.phase) * 4;
        kx = hx + 4; ky = hy + 8 + w * 0.3; fx = hx + 8 + w; fy = hy + 15;
      } else if (this.jumpT >= 0) {              // 점프: 다리 접기
        kx = hx + 2; ky = hy + 7; fx = hx - 3; fy = hy + 12;
      } else {
        const ph = walking ? Math.sin(this.walkPhase + leg.phase) : Math.sin(this.t * 1.2 + leg.phase) * 0.12;
        const lift = walking ? Math.max(0, Math.cos(this.walkPhase + leg.phase)) * 4 : 0;
        kx = hx + 3 + ph * 5; ky = hy + 10;
        fx = hx + 6 + ph * 9; fy = hy + 20 - lift;
      }
      leg.el.setAttribute('d', `M ${hx} ${hy} Q ${kx} ${ky} ${fx} ${fy}`);
    }

    // ── 날개 (점프/보행 시 파닥임) ─────────────
    const flutter = this.jumpT >= 0 ? 1 : (walking ? 0.25 : 0.05);
    const wa = Math.sin(this.t * 90) * 16 * flutter;
    this.wing1.setAttribute('transform', `rotate(${-8 + wa} 6 -20)`);
    this.wing2.setAttribute('transform', `rotate(${-16 - wa * 0.7} 6 -20)`);

    // ── 더듬이 (하행뉴런 활동에 반응) ──────────
    const tw = Math.sin(this.t * 7) * Math.min(1, r.dn / 8) * 3;
    this.ant.setAttribute('d', `M 24 -21 Q ${30 + tw} ${-27 - tw} 34 -26`);

    // ── 담배 (니코틴) ─────────────────────────
    const cigTarget = (this.nic > 0.05 && upright > 0.7 && this.jumpT < 0) ? 1 : 0;
    this.cigO += (cigTarget - this.cigO) * Math.min(1, dt * 4);
    this.cig.setAttribute('opacity', this.cigO.toFixed(2));
    if (this.cigO > 0.05) {
      this.ember.setAttribute('r', (1.4 + Math.max(0, Math.sin(this.t * 2.4)) * 0.9).toFixed(2));
      this.smoke.forEach((c, i) => {
        const ph = (this.t * 0.35 + i / 3) % 1;
        c.setAttribute('cy', (-2 - ph * 26).toFixed(1));
        c.setAttribute('cx', (41 + Math.sin(this.t * 1.7 + i * 2) * 2.5).toFixed(1));
        c.setAttribute('r', (1.8 + ph * 2.6).toFixed(2));
        c.setAttribute('opacity', ((1 - ph) * 0.6 * this.cigO * this.nic).toFixed(2));
      });
    }

    // ── 주둥이 ────────────────────────────────
    this.prob += (probTarget - this.prob) * Math.min(1, dt * 6);
    const L = 4 + this.prob * 16;
    this.probEl.setAttribute('d', `M 24 -4 q ${3 + this.prob * 5} ${L * 0.5} ${1 + this.prob * 3} ${L}`);

    // ── 행동 라벨 ────────────────────────────
    this.behavior =
      this.passT > 0.5 ? '기절 💫' :
      this.jumpT >= 0 ? '점프! ⚡' :
      speed < -0.06 ? '문워크 🕺' :
      walking ? (eth > 0.25 ? '갈지자 걸음 🍺' : '걷는 중 🚶') :
      this.prob > 0.3 ? '냠냠 🍬' :
      this.nic > 0.25 ? '뻐끔뻐끔 🚬' :
      eth > 0.25 ? '알딸딸 🍺' : '대기 🪰';
    return this.behavior;
  }
}
