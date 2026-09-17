// 초파리 아바타: 뇌 시뮬레이션의 운동·하행 뉴런 발화율을 읽어 행동으로 변환한다.
//  - 전진: DNp09 발화율, 후진(문워크): MDN, 점프: Giant Fiber, 주둥이: 주둥이 운동뉴런
//  - 에탄올: 비틀거림 → 병이 쓰러지고 → 침대에 뻗음. 니코틴: 흡연 애니메이션
// 렌더링은 SVG 요소를 매 프레임 갱신하는 방식. 의존성 없음.

const W = 380, H = 240, FLOOR = 206, HORIZON = 132;
const S = 1.15;          // 아바타 확대 배율
const BED_X = 165;       // 침대 위치

function roomGrid() {
  // 영상풍 원근 그리드 룸: 바닥은 소실점으로 수렴, 벽은 성긴 격자
  let d = '';
  for (let i = -6; i <= 6; i++)
    d += `M ${190 + i * 72} ${H} L ${190 + i * 15} ${HORIZON} `;
  for (const t of [0.10, 0.24, 0.42, 0.66, 0.95])
    d += `M 0 ${HORIZON + t * (H - HORIZON)} H ${W} `;
  let w = '';
  for (let x = 10; x < W; x += 48) w += `M ${x} 0 V ${HORIZON} `;
  for (let y = 24; y < HORIZON; y += 34) w += `M 0 ${y} H ${W} `;
  return { floor: d, wall: w };
}

export class Fly {
  constructor(container) {
    this.x = W * 0.5;
    this.dir = 1;              // 바라보는 방향 (1: 오른쪽)
    this.jumpT = -1;
    this.jumpCooldown = 0;
    this.prob = 0;             // 주둥이 뻗은 정도 0..1
    this.passedOut = false;
    this.passT = 0;
    this.t = 0;
    this.walkPhase = 0;
    this.eth = 0;
    this.nic = 0;
    this.cigO = 0;
    this.bedO = 0;
    this.bottleO = 0;
    this.spill = 0;
    this.rates = { fwd: 0, back: 0, jump: 0, prob: 0, dn: 0, motor: 0, brain: 0 };
    this.s = { fwd: 0, back: 0, jump: 0, prob: 0 };
    this.behavior = '대기';
    this._staggerVx = 0;

    const g = roomGrid();
    container.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">
  <defs>
    <radialGradient id="fg-eye" cx="0.35" cy="0.35" r="0.9">
      <stop offset="0" stop-color="#e8604a"/><stop offset="0.55" stop-color="#c03a2e"/>
      <stop offset="1" stop-color="#791f1a"/>
    </radialGradient>
    <linearGradient id="fg-abd" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ecd3a2"/><stop offset="0.6" stop-color="#d3ab6c"/>
      <stop offset="1" stop-color="#a97f45"/>
    </linearGradient>
    <linearGradient id="fg-thx" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e4c491"/><stop offset="1" stop-color="#b08850"/>
    </linearGradient>
    <linearGradient id="fg-wing" x1="0" y1="0" x2="1" y2="0.3">
      <stop offset="0" stop-color="rgba(215,228,255,0.45)"/>
      <stop offset="0.7" stop-color="rgba(190,205,245,0.28)"/>
      <stop offset="1" stop-color="rgba(225,235,255,0.14)"/>
    </linearGradient>
    <radialGradient id="fg-lamp" cx="0.5" cy="0.15" r="0.8">
      <stop offset="0" stop-color="rgba(255,220,150,0.20)"/>
      <stop offset="0.5" stop-color="rgba(255,210,130,0.06)"/>
      <stop offset="1" stop-color="rgba(255,210,130,0)"/>
    </radialGradient>
    <pattern id="fg-facet" width="3" height="3" patternUnits="userSpaceOnUse">
      <circle cx="1.5" cy="1.5" r="0.65" fill="rgba(70,10,10,0.5)"/>
    </pattern>
    <filter id="fg-blur"><feGaussianBlur stdDeviation="1.1"/></filter>
    <clipPath id="fg-abdclip"><ellipse cx="-21" cy="-6" rx="25" ry="15"/></clipPath>
  </defs>

  <path d="${g.wall}" stroke="rgba(110,140,220,0.07)" stroke-width="1" fill="none"/>
  <line x1="0" y1="${HORIZON}" x2="${W}" y2="${HORIZON}" stroke="rgba(140,165,235,0.22)" stroke-width="1"/>
  <path d="${g.floor}" stroke="rgba(110,140,220,0.13)" stroke-width="1" fill="none"/>

  <g id="f-lampg">
    <line x1="292" y1="0" x2="292" y2="30" stroke="rgba(180,190,210,0.5)" stroke-width="1.2"/>
    <circle cx="292" cy="35" r="6" fill="#ffe1a0" opacity="0.9"/>
    <circle cx="292" cy="34" r="2.4" fill="#fff6dd"/>
    <ellipse cx="292" cy="66" rx="66" ry="58" fill="url(#fg-lamp)"/>
  </g>

  <g id="f-bed" opacity="0" transform="translate(${(BED_X * -0.3).toFixed(1)} ${(FLOOR * -0.3).toFixed(1)}) scale(1.3)">
    <rect x="${BED_X - 62}" y="${FLOOR - 26}" width="124" height="14" rx="6" fill="#d8dde9"/>
    <rect x="${BED_X - 62}" y="${FLOOR - 14}" width="124" height="9" rx="3" fill="#5a647e"/>
    <rect x="${BED_X - 60}" y="${FLOOR - 5}" width="5" height="5" fill="#3f475c"/>
    <rect x="${BED_X + 55}" y="${FLOOR - 5}" width="5" height="5" fill="#3f475c"/>
    <ellipse cx="${BED_X - 44}" cy="${FLOOR - 27}" rx="16" ry="6.5" fill="#eef1f8"/>
    <path id="f-blanket" d="M ${BED_X - 6} ${FLOOR - 26} q 30 -6 62 2 l 4 10 q -20 8 -8 22 l -12 2 q -6 -14 -14 -6 q -16 -16 -32 -20 z"
          fill="#e3e8f2" stroke="#c3cadc" stroke-width="1"/>
  </g>

  <g id="f-bottle" opacity="0" transform="translate(-95 ${FLOOR * -0.32}) scale(1.32)">
    <g id="f-bottle-up">
      <path d="M 306 ${FLOOR} l 0 -20 q 0 -4 2.5 -7 l 0 -8 l 5 0 l 0 8 q 2.5 3 2.5 7 l 0 20 z" fill="#3a6b46"/>
      <rect x="307.5" y="${FLOOR - 17}" width="7" height="9" fill="#e8e2cf"/>
      <rect x="309.8" y="${FLOOR - 36.5}" width="2.4" height="3.5" fill="#7a4a2a"/>
      <path d="M 328 ${FLOOR} l 1.5 -12 l 7 0 l 1.5 12 q -5 2.5 -10 0 z" fill="rgba(220,230,250,0.35)" stroke="rgba(220,230,250,0.5)" stroke-width="0.8"/>
      <path d="M 330 ${FLOOR - 9} l 6 0 l -0.8 6 l -4.4 0 z" fill="rgba(150,30,50,0.75)"/>
    </g>
    <g id="f-bottle-down" opacity="0">
      <ellipse id="f-puddle" cx="300" cy="${FLOOR + 4}" rx="0" ry="0" fill="rgba(140,25,45,0.75)"/>
      <g transform="rotate(96 316 ${FLOOR - 3})">
        <path d="M 306 ${FLOOR} l 0 -20 q 0 -4 2.5 -7 l 0 -8 l 5 0 l 0 8 q 2.5 3 2.5 7 l 0 20 z" fill="#3a6b46"/>
        <rect x="307.5" y="${FLOOR - 17}" width="7" height="9" fill="#e8e2cf"/>
      </g>
      <path d="M 336 ${FLOOR + 2} l 12 -3 q 2.5 4 0 6 l -7 2 z" fill="rgba(220,230,250,0.35)" stroke="rgba(220,230,250,0.45)" stroke-width="0.8"/>
    </g>
  </g>

  <ellipse id="f-shadow" cx="0" cy="${FLOOR + 5}" rx="40" ry="5" fill="rgba(0,0,10,0.5)"/>

  <g id="f-root">
    <g id="f-legs-far" stroke="#5d4c33" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.55"></g>
    <g id="f-wing2g" opacity="0.8">
      <path id="f-wing2" d="M 2 -22 q -22 -9 -44 -4 q -8 2 -6 7 q 3 7 20 8 q 18 1 30 -11 z" fill="url(#fg-wing)" stroke="rgba(205,220,250,0.5)" stroke-width="0.8"/>
    </g>
    <path d="M -21 -6 m -25 0 a 25 15 0 1 0 50 0 a 25 15 0 1 0 -50 0" fill="url(#fg-abd)"/>
    <g clip-path="url(#fg-abdclip)" fill="#6d5028">
      <path d="M -14 -21 q -4 8 -3 16 l -4.5 0 q -2 -9 1.5 -17 z"/>
      <path d="M -24 -21 q -4 8 -3 16 l -4.5 0 q -2 -9 1.5 -17 z" opacity="0.9"/>
      <path d="M -33 -19 q -3.5 7 -2.5 13 l -4.5 0 q -1.5 -8 1.5 -14 z" opacity="0.8"/>
      <path d="M -41 -15 q -2.5 5 -2 9 l -4 0 q -1 -6 1.5 -10 z" opacity="0.7"/>
    </g>
    <ellipse cx="-21" cy="-11" rx="20" ry="7" fill="rgba(255,240,210,0.25)"/>
    <ellipse cx="3" cy="-15" rx="14.5" ry="12.5" fill="url(#fg-thx)"/>
    <path d="M -8 -22 q 10 -8 22 -2" stroke="#8a6a3c" stroke-width="1" fill="none" opacity="0.6"/>
    <g stroke="#4d3b22" stroke-width="0.9" stroke-linecap="round" opacity="0.7">
      <line x1="-2" y1="-27" x2="-4" y2="-31"/><line x1="3" y1="-27.6" x2="2.5" y2="-32"/>
      <line x1="8" y1="-27" x2="10" y2="-31"/>
    </g>
    <circle cx="20" cy="-13" r="10.5" fill="#dcb87e"/>
    <ellipse cx="24" cy="-13.5" rx="8" ry="9.6" fill="url(#fg-eye)"/>
    <ellipse cx="24" cy="-13.5" rx="8" ry="9.6" fill="url(#fg-facet)"/>
    <ellipse cx="21.5" cy="-17.5" rx="2.6" ry="3.2" fill="rgba(255,235,225,0.65)"/>
    <path id="f-ant" d="M 16 -20 q 3 -4 7 -4 m -4 1 q 2 -3 5 -3" stroke="#5d4c33" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    <path id="f-prob" d="M 22 -4 q 2 4 1 8" stroke="#7c5c34" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    <path id="f-probtip" d="M 23 4 q 1.5 1.5 0 3" stroke="#9a7442" stroke-width="4.2" fill="none" stroke-linecap="round"/>
    <g id="f-legs" stroke="#6b5638" stroke-width="2.3" fill="none" stroke-linecap="round"></g>
    <g id="f-wing1g" opacity="0.92">
      <path id="f-wing1" d="M 4 -21 q -24 -12 -48 -6 q -9 2 -7 8 q 4 8 23 9 q 20 1 32 -11 z" fill="url(#fg-wing)" stroke="rgba(215,228,255,0.65)" stroke-width="0.9"/>
      <g stroke="rgba(190,205,240,0.5)" stroke-width="0.6" fill="none">
        <path d="M 2 -20 q -20 -8 -42 -4"/><path d="M 0 -17 q -18 -4 -38 0"/>
        <path d="M -2 -14 q -14 -1 -30 3"/>
      </g>
    </g>
    <g id="f-cig" opacity="0">
      <path d="M 20 -6 q 7 -3 12 1" stroke="#5d4c33" stroke-width="1.6" fill="none"/>
      <line x1="30" y1="-5" x2="43" y2="1" stroke="#f2ecdc" stroke-width="3.4" stroke-linecap="round"/>
      <line x1="30.6" y1="-5.3" x2="34" y2="-3.8" stroke="#d9a45a" stroke-width="3.4" stroke-linecap="round"/>
      <circle id="f-ember" cx="44.2" cy="1.6" r="2" fill="#ff7a30"/>
      <g id="f-smoke" fill="rgba(210,220,240,0.5)" filter="url(#fg-blur)">
        <circle cx="45" cy="-4" r="2.4"/><circle cx="46" cy="-13" r="3"/><circle cx="47" cy="-22" r="3.8"/>
      </g>
    </g>
  </g>
</svg>`;
    const q = s => container.querySelector(s);
    this.root = q('#f-root');
    this.shadow = q('#f-shadow');
    this.wing1 = q('#f-wing1g');
    this.wing2 = q('#f-wing2g');
    this.ant = q('#f-ant');
    this.probEl = q('#f-prob');
    this.probTip = q('#f-probtip');
    this.cig = q('#f-cig');
    this.ember = q('#f-ember');
    this.smoke = [...container.querySelectorAll('#f-smoke circle')];
    this.bed = q('#f-bed');
    this.bottle = q('#f-bottle');
    this.bottleUp = q('#f-bottle-up');
    this.bottleDown = q('#f-bottle-down');
    this.puddle = q('#f-puddle');
    // 다리 6개: 앞/중/뒤 × 근·원측. hip 좌표는 몸통 로컬 기준
    this.legs = [];
    const mkLegs = (sel, hips, phase0) => {
      const box = q(sel);
      for (let i = 0; i < 3; i++) {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        box.appendChild(p);
        this.legs.push({ el: p, hip: hips[i], phase: i * 2.1 + phase0, front: i === 0 });
      }
    };
    mkLegs('#f-legs-far', [[12, -6], [3, -4], [-7, -4]], Math.PI);
    mkLegs('#f-legs', [[13, -5], [4, -3], [-6, -3]], 0);
  }

  setRates(r) { Object.assign(this.rates, r); }
  setEthanol(v) { this.eth = v; }
  setNicotine(v) { this.nic = v; }

  _legPath(hx, hy, fx, fy, bend) {
    // 가짜 IK: 고관절-발 중점에서 법선 방향으로 무릎을 꺾는다
    const mx = (hx + fx) / 2, my = (hy + fy) / 2;
    const dx = fx - hx, dy = fy - hy, len = Math.hypot(dx, dy) || 1;
    const kx = mx + (dy / len) * bend, ky = my - (dx / len) * bend;
    const tx = fx + 3.2 * this.dirLeg, ty = fy + 0.6;
    return `M ${hx.toFixed(1)} ${hy.toFixed(1)} L ${kx.toFixed(1)} ${ky.toFixed(1)} L ${fx.toFixed(1)} ${fy.toFixed(1)} L ${tx.toFixed(1)} ${ty.toFixed(1)}`;
  }

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
    const speed = Math.max(-1, Math.min(1, this.s.fwd / 45 - this.s.back / 45)) * (feeding ? 0 : 1);

    // 기절 판정 (히스테리시스)
    if (!this.passedOut && eth > 0.85) this.passedOut = true;
    if (this.passedOut && eth < 0.7) this.passedOut = false;
    this.passT += ((this.passedOut ? 1 : 0) - this.passT) * Math.min(1, dt * 2.2);

    if (wantJump) { this.jumpT = 0; this.jumpCooldown = 0.9; }
    if (this.jumpT >= 0) { this.jumpT += dt; if (this.jumpT > 0.55) this.jumpT = -1; }
    this.jumpCooldown -= dt;

    // ── 소품: 침대 / 와인병 ────────────────────
    this.bedO += ((this.passT > 0.12 ? 1 : 0) - this.bedO) * Math.min(1, dt * 2.5);
    this.bed.setAttribute('opacity', this.bedO.toFixed(2));
    const bottleTarget = eth > 0.03 ? 1 : 0;
    this.bottleO += (bottleTarget - this.bottleO) * Math.min(1, dt * 3);
    this.bottle.setAttribute('opacity', this.bottleO.toFixed(2));
    const spillTarget = eth > 0.55 ? 1 : 0;
    this.spill += (spillTarget - this.spill) * Math.min(1, dt * 1.6);
    this.bottleUp.setAttribute('opacity', (1 - this.spill).toFixed(2));
    this.bottleDown.setAttribute('opacity', this.spill.toFixed(2));
    this.puddle.setAttribute('rx', (this.spill * 26).toFixed(1));
    this.puddle.setAttribute('ry', (this.spill * 4.5).toFixed(1));

    // ── 이동 ─────────────────────────────────
    const upright = 1 - this.passT;
    let vx = 0;
    if (this.jumpT < 0 && upright > 0.6) {
      vx = speed * 90 * this.dir * upright;
      if (eth > 0.1) {                        // 만취 갈지자
        this._staggerVx += (Math.random() - 0.5) * eth * 260 * dt;
        this._staggerVx *= 1 - Math.min(1, dt * 2.5);
        vx += this._staggerVx;
      }
    }
    this.x += vx * dt;
    // 기절 진행 중엔 침대로 끌려간다
    if (this.passT > 0.05) this.x += (BED_X - this.x) * Math.min(1, dt * 2.5) * this.passT;
    if (this.x < 46) { this.x = 46; this.dir = 1; }
    if (this.x > W - 46) { this.x = W - 46; this.dir = -1; }

    // ── 자세 ─────────────────────────────────
    const walking = Math.abs(speed) > 0.06 && this.jumpT < 0 && upright > 0.6;
    this.walkPhase += dt * (walking ? 10 + 14 * Math.abs(speed) : 1.2);

    let y = FLOOR - 24 * S;
    let rot = 0;
    if (this.jumpT >= 0) {
      const jt = this.jumpT / 0.55;
      y -= Math.sin(jt * Math.PI) * 64;
      rot = -14 * this.dir * Math.sin(jt * Math.PI);
    }
    y += Math.sin(this.t * 2.2) * 1.3 * upright;              // 숨쉬기
    rot += eth * (10 * Math.sin(this.t * 3.1) + 5 * Math.sin(this.t * 5.7)) * upright;
    // 기절: 침대 위로 엎어짐 (머리를 베개 쪽으로)
    rot += this.passT * -24 * this.dir;
    y -= this.passT * (26 - 24 * S + 28);                     // 매트리스 높이만큼
    if (this.passT > 0.3) y += Math.sin(this.t * 1.1) * 1.6;  // 곯아떨어진 숨

    this.root.setAttribute('transform',
      `translate(${this.x.toFixed(1)} ${y.toFixed(1)}) scale(${this.dir * S} ${S}) rotate(${(rot * this.dir).toFixed(1)})`);
    this.shadow.setAttribute('cx', this.x.toFixed(1));
    const air = Math.max(0, (FLOOR - 24 * S - y) / 64);
    this.shadow.setAttribute('rx', ((40 - air * 16) * S).toFixed(1));
    this.shadow.setAttribute('opacity', (0.5 - air * 0.28 - this.passT * 0.3).toFixed(2));

    // ── 다리 ─────────────────────────────────
    this.dirLeg = 1;
    for (const leg of this.legs) {
      const [hx, hy] = leg.hip;
      let fx, fy, bend = -5.5;
      if (this.passT > 0.5) {                 // 기절: 다리 축 늘어짐
        const w = Math.sin(this.t * 1.1 + leg.phase) * 1.5;
        fx = hx + 9 + w; fy = hy + 20; bend = -2;
      } else if (this.jumpT >= 0) {           // 점프: 접기
        fx = hx - 4; fy = hy + 13; bend = -7;
      } else {
        const ph = walking ? Math.sin(this.walkPhase + leg.phase) : Math.sin(this.t * 1.2 + leg.phase) * 0.12;
        const lift = walking ? Math.max(0, Math.cos(this.walkPhase + leg.phase)) * 4.5 : 0;
        fx = hx + 5 + ph * 9;
        fy = hy + 24 - lift - hy;             // 발끝은 지면(로컬 y=24)
        bend = leg.front ? -6.5 : -5;
      }
      leg.el.setAttribute('d', this._legPath(hx, hy, fx, fy, bend));
    }

    // ── 날개 ─────────────────────────────────
    const flutter = this.jumpT >= 0 ? 1 : (walking ? 0.18 : 0.04);
    const wa = Math.sin(this.t * 90) * 18 * flutter;
    const droop = this.passT * 26 + eth * upright * 4;        // 취하면 날개 처짐
    this.wing1.setAttribute('transform', `rotate(${(-4 + wa + droop * 0.5).toFixed(1)} 5 -20)`);
    this.wing2.setAttribute('transform', `rotate(${(-12 - wa * 0.7 + droop).toFixed(1)} 5 -20)`);

    // ── 더듬이 ────────────────────────────────
    const tw = Math.sin(this.t * 7) * Math.min(1, r.dn / 8) * 2.5;
    this.ant.setAttribute('transform', `rotate(${tw.toFixed(1)} 16 -20)`);

    // ── 담배 ─────────────────────────────────
    const cigTarget = (this.nic > 0.05 && upright > 0.7 && this.jumpT < 0) ? 1 : 0;
    this.cigO += (cigTarget - this.cigO) * Math.min(1, dt * 4);
    this.cig.setAttribute('opacity', this.cigO.toFixed(2));
    if (this.cigO > 0.05) {
      this.ember.setAttribute('r', (1.4 + Math.max(0, Math.sin(this.t * 2.4)) * 0.9).toFixed(2));
      this.smoke.forEach((c, i) => {
        const ph = (this.t * 0.35 + i / 3) % 1;
        c.setAttribute('cy', (-2 - ph * 32).toFixed(1));
        c.setAttribute('cx', (45 + Math.sin(this.t * 1.7 + i * 2) * 3).toFixed(1));
        c.setAttribute('r', (2.2 + ph * 3.4).toFixed(2));
        c.setAttribute('opacity', ((1 - ph) * 0.85 * this.cigO * Math.max(0.5, this.nic)).toFixed(2));
      });
    }

    // ── 주둥이 ────────────────────────────────
    this.prob += (probTarget - this.prob) * Math.min(1, dt * 6);
    const L = 4 + this.prob * 15;
    this.probEl.setAttribute('d', `M 22 -4 q ${(3 + this.prob * 5).toFixed(1)} ${(L * 0.5).toFixed(1)} ${(1 + this.prob * 3).toFixed(1)} ${L.toFixed(1)}`);
    this.probTip.setAttribute('transform', `translate(${(this.prob * 4).toFixed(1)} ${(this.prob * 15).toFixed(1)})`);

    // ── 행동 라벨 ────────────────────────────
    this.behavior =
      this.passT > 0.5 ? '침대에 뻗음 💫' :
      this.jumpT >= 0 ? '점프! ⚡' :
      speed < -0.06 ? '문워크 🕺' :
      walking ? (eth > 0.25 ? '갈지자 걸음 🍺' : '걷는 중 🚶') :
      this.prob > 0.3 ? '냠냠 🍬' :
      this.nic > 0.25 ? '뻐끔뻐끔 🚬' :
      eth > 0.25 ? '알딸딸 🍺' : '대기 🪰';
    return this.behavior;
  }
}
