// 초파리 아바타: 뇌 시뮬레이션의 운동·하행 뉴런 발화율을 읽어 행동으로 변환한다.
//  - 전진: DNp09 발화율, 후진(문워크): MDN, 점프: Giant Fiber, 주둥이: 주둥이 운동뉴런
//  - 에탄올: 비틀거림 → 병이 쓰러지고 → 침대에 뻗음. 니코틴: 흡연 애니메이션
// 렌더링은 외곽선 없는 다층 그라데이션 SVG를 매 프레임 갱신하는 방식. 의존성 없음.

const W = 380, H = 240, FLOOR = 208, HORIZON = 128;
const S = 1.25;          // 아바타 확대 배율
const GROUND = 30;       // 로컬 좌표에서 발끝이 닿는 높이
const BED_X = 150;       // 침대 위치

function roomGrid() {
  // 원근 그리드 룸: 바닥은 소실점으로 수렴, 벽은 성긴 격자
  let d = '';
  for (let i = -6; i <= 6; i++)
    d += `M ${190 + i * 74} ${H} L ${190 + i * 14} ${HORIZON} `;
  for (const t of [0.10, 0.24, 0.42, 0.66, 0.95])
    d += `M 0 ${(HORIZON + t * (H - HORIZON)).toFixed(1)} H ${W} `;
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
    <radialGradient id="fg-abd" cx="0.38" cy="0.24" r="0.95">
      <stop offset="0" stop-color="#f8ecca"/><stop offset="0.5" stop-color="#e2c188"/>
      <stop offset="0.82" stop-color="#c09456"/><stop offset="1" stop-color="#96703c"/>
    </radialGradient>
    <radialGradient id="fg-thx" cx="0.4" cy="0.22" r="0.95">
      <stop offset="0" stop-color="#f9eed2"/><stop offset="0.55" stop-color="#e0be86"/>
      <stop offset="1" stop-color="#a87e46"/>
    </radialGradient>
    <radialGradient id="fg-head" cx="0.42" cy="0.3" r="0.9">
      <stop offset="0" stop-color="#f3e2ba"/><stop offset="1" stop-color="#bd955c"/>
    </radialGradient>
    <radialGradient id="fg-eye" cx="0.36" cy="0.3" r="0.95">
      <stop offset="0" stop-color="#ff8058"/><stop offset="0.45" stop-color="#d84a30"/>
      <stop offset="0.8" stop-color="#a02a1c"/><stop offset="1" stop-color="#6d1710"/>
    </radialGradient>
    <linearGradient id="fg-wing" x1="1" y1="0" x2="0" y2="0.25">
      <stop offset="0" stop-color="rgba(228,236,252,0.55)"/>
      <stop offset="0.5" stop-color="rgba(205,216,242,0.30)"/>
      <stop offset="1" stop-color="rgba(215,225,248,0.12)"/>
    </linearGradient>
    <linearGradient id="fg-sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="rgba(255,190,220,0.10)"/>
      <stop offset="0.5" stop-color="rgba(160,200,255,0.12)"/>
      <stop offset="1" stop-color="rgba(190,255,230,0.08)"/>
    </linearGradient>
    <radialGradient id="fg-lamp" cx="0.5" cy="0.15" r="0.8">
      <stop offset="0" stop-color="rgba(255,220,150,0.18)"/>
      <stop offset="0.5" stop-color="rgba(255,210,130,0.05)"/>
      <stop offset="1" stop-color="rgba(255,210,130,0)"/>
    </radialGradient>
    <radialGradient id="fg-vig" cx="0.5" cy="0.42" r="0.75">
      <stop offset="0.55" stop-color="rgba(3,5,14,0)"/><stop offset="1" stop-color="rgba(3,5,14,0.55)"/>
    </radialGradient>
    <linearGradient id="fg-wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0f22"/><stop offset="1" stop-color="#121a35"/>
    </linearGradient>
    <linearGradient id="fg-floorg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#151d3a"/><stop offset="1" stop-color="#0a0e20"/>
    </linearGradient>
    <pattern id="fg-facet" width="2.6" height="2.6" patternUnits="userSpaceOnUse">
      <circle cx="1.3" cy="1.3" r="0.55" fill="rgba(80,12,10,0.45)"/>
    </pattern>
    <filter id="fg-blur1"><feGaussianBlur stdDeviation="1.1"/></filter>
    <filter id="fg-blur3"><feGaussianBlur stdDeviation="3"/></filter>
  </defs>

  <rect x="0" y="0" width="${W}" height="${HORIZON}" fill="url(#fg-wall)"/>
  <rect x="0" y="${HORIZON}" width="${W}" height="${H - HORIZON}" fill="url(#fg-floorg)"/>
  <path d="${g.wall}" stroke="rgba(110,140,220,0.06)" stroke-width="1" fill="none"/>
  <line x1="0" y1="${HORIZON}" x2="${W}" y2="${HORIZON}" stroke="rgba(140,165,235,0.20)" stroke-width="1"/>
  <path d="${g.floor}" stroke="rgba(110,140,220,0.11)" stroke-width="1" fill="none"/>

  <g id="f-lampg">
    <line x1="292" y1="0" x2="292" y2="28" stroke="rgba(180,190,210,0.5)" stroke-width="1.2"/>
    <circle cx="292" cy="33" r="5.5" fill="#ffe1a0" opacity="0.9"/>
    <circle cx="292" cy="32" r="2.2" fill="#fff6dd"/>
    <ellipse cx="292" cy="64" rx="62" ry="54" fill="url(#fg-lamp)"/>
  </g>

  <g id="f-bed" opacity="0" transform="translate(${(BED_X * -0.5).toFixed(1)} ${(FLOOR * -0.5).toFixed(1)}) scale(1.5)">
    <rect x="${BED_X - 62}" y="${FLOOR - 26}" width="124" height="14" rx="6" fill="#d8dde9"/>
    <rect x="${BED_X - 62}" y="${FLOOR - 25}" width="124" height="4" rx="2" fill="#eef1f8" opacity="0.7"/>
    <rect x="${BED_X - 62}" y="${FLOOR - 14}" width="124" height="9" rx="3" fill="#5a647e"/>
    <rect x="${BED_X - 60}" y="${FLOOR - 5}" width="5" height="5" fill="#3f475c"/>
    <rect x="${BED_X + 55}" y="${FLOOR - 5}" width="5" height="5" fill="#3f475c"/>
    <ellipse cx="${BED_X - 44}" cy="${FLOOR - 27}" rx="16" ry="6.5" fill="#eef1f8"/>
    <path d="M ${BED_X - 6} ${FLOOR - 26} q 30 -6 62 2 l 4 10 q -20 8 -8 22 l -12 2 q -6 -14 -14 -6 q -16 -16 -32 -20 z"
          fill="#e3e8f2" stroke="#c3cadc" stroke-width="1"/>
  </g>

  <g id="f-bottle" opacity="0" transform="translate(-149 ${(FLOOR * -0.5).toFixed(1)}) scale(1.5)">
    <g id="f-bottle-up">
      <path d="M 306 ${FLOOR} l 0 -20 q 0 -4 2.5 -7 l 0 -8 l 5 0 l 0 8 q 2.5 3 2.5 7 l 0 20 z" fill="#3a6b46"/>
      <path d="M 306.8 ${FLOOR - 2} l 0 -17 q 0 -3 1.5 -5" stroke="rgba(255,255,255,0.25)" stroke-width="1.4" fill="none"/>
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

  <ellipse id="f-shadow" cx="0" cy="${FLOOR + 5}" rx="46" ry="6" fill="rgba(0,0,10,0.55)" filter="url(#fg-blur3)"/>

  <g id="f-root">
    <g id="f-legs-far"></g>
    <g id="f-wing2g" opacity="0.75">
      <path d="M 2 -26 Q -24 -37 -52 -33 Q -68 -30 -66 -23 Q -63 -15 -42 -14 Q -16 -14 2 -26 z"
            fill="url(#fg-wing)"/>
    </g>

    <!-- 복부: 외곽선 없는 그라데이션 + 은은한 체절 능선 -->
    <ellipse cx="-24" cy="-10" rx="31" ry="19" fill="url(#fg-abd)" transform="rotate(-8 -24 -10)"/>
    <g stroke="rgba(150,110,60,0.35)" stroke-width="1.6" fill="none">
      <path d="M -14 -27 q -5 11 -3 20"/>
      <path d="M -25 -28 q -5 11 -3 19"/>
      <path d="M -36 -26 q -4 9 -2.5 15"/>
      <path d="M -45 -21 q -3 6 -2 10"/>
    </g>
    <path d="M -48 -22 Q -26 -32 -8 -27" stroke="rgba(255,246,220,0.5)" stroke-width="3.5"
          fill="none" stroke-linecap="round" filter="url(#fg-blur1)"/>
    <ellipse cx="-22" cy="0" rx="22" ry="6" fill="rgba(70,45,20,0.28)" filter="url(#fg-blur3)"/>

    <!-- 가슴 -->
    <ellipse cx="1" cy="-18" rx="16.5" ry="14.5" fill="url(#fg-thx)"/>
    <path d="M -10 -29 Q 2 -35 13 -28" stroke="rgba(255,246,220,0.55)" stroke-width="2.6"
          fill="none" stroke-linecap="round" filter="url(#fg-blur1)"/>
    <g stroke="rgba(60,42,20,0.5)" stroke-width="0.8" stroke-linecap="round">
      <line x1="-4" y1="-31.5" x2="-6" y2="-35.5"/><line x1="1" y1="-32.4" x2="0.5" y2="-36.6"/>
      <line x1="6" y1="-31.6" x2="8" y2="-35.6"/><line x1="11" y1="-29.5" x2="13.5" y2="-32.8"/>
    </g>

    <!-- 머리 + 겹눈 -->
    <circle cx="22" cy="-16" r="11.5" fill="url(#fg-head)"/>
    <ellipse cx="26" cy="-16" rx="9.2" ry="11" fill="url(#fg-eye)"/>
    <ellipse cx="26" cy="-16" rx="9.2" ry="11" fill="url(#fg-facet)"/>
    <ellipse cx="23" cy="-21" rx="3.4" ry="4.2" fill="rgba(255,235,225,0.55)" filter="url(#fg-blur1)"/>
    <circle cx="22.2" cy="-22.5" r="1.1" fill="rgba(255,255,255,0.9)"/>
    <path id="f-ant" d="M 16.5 -23 q 2.5 -3.5 6 -3.5 m -3.5 0.7 q 2 -2.6 4.6 -2.8 m -2.6 0.6 l 1.6 -1.8 m -1 1.6 l 2 -0.6"
          stroke="#4d3b22" stroke-width="1.1" fill="none" stroke-linecap="round"/>

    <!-- 주둥이 -->
    <path id="f-prob" d="M 21 -6 q 2 4 1 8" stroke="#a37f4c" stroke-width="4" fill="none" stroke-linecap="round"/>
    <path id="f-probtip" d="M 21.5 2 q 2 1.5 0.5 3.4" stroke="#c39a5e" stroke-width="5" fill="none" stroke-linecap="round"/>

    <g id="f-legs"></g>

    <!-- 앞날개: 날개맥 + 홍채빛 -->
    <g id="f-wing1g" opacity="0.9">
      <path id="f-wingshape" d="M 4 -25 Q -26 -40 -58 -36 Q -76 -33 -74 -25 Q -70 -15 -46 -14 Q -16 -13 4 -25 z"
            fill="url(#fg-wing)"/>
      <path d="M 4 -25 Q -26 -40 -58 -36 Q -76 -33 -74 -25 Q -70 -15 -46 -14 Q -16 -13 4 -25 z"
            fill="url(#fg-sheen)"/>
      <g stroke="rgba(150,165,205,0.55)" stroke-width="0.7" fill="none">
        <path d="M 2 -24 Q -28 -37 -60 -33"/>
        <path d="M 0 -21 Q -26 -30 -56 -27"/>
        <path d="M -2 -18 Q -24 -22 -48 -18"/>
        <path d="M -30 -31 q -2 6 -4 12"/>
        <path d="M -48 -30 q -1 6 -2 12"/>
      </g>
      <path d="M -74 -25 Q -70 -15 -46 -14" stroke="rgba(120,135,175,0.5)" stroke-width="1" fill="none"/>
    </g>

    <g id="f-cig" opacity="0">
      <path d="M 20 -8 q 7 -3 12 1" stroke="#7c6138" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <line x1="30" y1="-7" x2="43" y2="-1" stroke="#f2ecdc" stroke-width="3.4" stroke-linecap="round"/>
      <line x1="30.6" y1="-7.3" x2="34" y2="-5.8" stroke="#d9a45a" stroke-width="3.4" stroke-linecap="round"/>
      <circle id="f-ember" cx="44.2" cy="-0.4" r="2" fill="#ff7a30"/>
      <g id="f-smoke" fill="rgba(210,220,240,0.5)" filter="url(#fg-blur1)">
        <circle cx="45" cy="-6" r="2.4"/><circle cx="46" cy="-15" r="3"/><circle cx="47" cy="-24" r="3.8"/>
      </g>
    </g>
  </g>

  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#fg-vig)" pointer-events="none"/>
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

    // 다리 6개: 앞/중/뒤 × 근·원측. 넓적다리-종아리-발목 3분절
    this.legs = [];
    const NS = 'http://www.w3.org/2000/svg';
    const mkLegs = (sel, hips, phase0, near) => {
      const box = q(sel);
      const col = near ? '#c8a266' : '#8f7347';
      for (let i = 0; i < 3; i++) {
        const grp = document.createElementNS(NS, 'g');
        const seg = [];
        for (const wdt of [3.1, 2.2, 1.4]) {
          const p = document.createElementNS(NS, 'path');
          p.setAttribute('stroke', col);
          p.setAttribute('stroke-width', near ? wdt : wdt * 0.85);
          p.setAttribute('stroke-linecap', 'round');
          p.setAttribute('fill', 'none');
          grp.appendChild(p);
          seg.push(p);
        }
        box.appendChild(grp);
        this.legs.push({ seg, hip: hips[i], phase: i * 2.1 + phase0, front: i === 0 });
      }
    };
    mkLegs('#f-legs-far', [[13, -10], [3, -8], [-8, -8]], Math.PI, false);
    mkLegs('#f-legs', [[14, -8], [4, -6], [-7, -6]], 0, true);
  }

  setRates(r) { Object.assign(this.rates, r); }
  setEthanol(v) { this.eth = v; }
  setNicotine(v) { this.nic = v; }

  _setLeg(leg, fx, fy, bend) {
    // 가짜 IK: 고관절-발 중점에서 법선 방향으로 무릎을 꺾고, 발목에서 발끝을 뻗는다
    const [hx, hy] = leg.hip;
    const mx = (hx + fx) / 2, my = (hy + fy) / 2;
    const dx = fx - hx, dy = fy - hy, len = Math.hypot(dx, dy) || 1;
    const kx = mx + (dy / len) * bend, ky = my - (dx / len) * bend;
    const ax = fx - (fx - kx) * 0.22, ay = fy - (fy - ky) * 0.22;
    leg.seg[0].setAttribute('d', `M ${hx} ${hy} L ${kx.toFixed(1)} ${ky.toFixed(1)}`);
    leg.seg[1].setAttribute('d', `M ${kx.toFixed(1)} ${ky.toFixed(1)} L ${ax.toFixed(1)} ${ay.toFixed(1)}`);
    leg.seg[2].setAttribute('d', `M ${ax.toFixed(1)} ${ay.toFixed(1)} L ${fx.toFixed(1)} ${fy.toFixed(1)} l 3.4 0.8`);
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
    this.bottleO += ((eth > 0.03 ? 1 : 0) - this.bottleO) * Math.min(1, dt * 3);
    this.bottle.setAttribute('opacity', this.bottleO.toFixed(2));
    this.spill += ((eth > 0.55 ? 1 : 0) - this.spill) * Math.min(1, dt * 1.6);
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
    if (this.x < 52) { this.x = 52; this.dir = 1; }
    if (this.x > W - 52) { this.x = W - 52; this.dir = -1; }

    // ── 자세 ─────────────────────────────────
    const walking = Math.abs(speed) > 0.06 && this.jumpT < 0 && upright > 0.6;
    this.walkPhase += dt * (walking ? 10 + 14 * Math.abs(speed) : 1.2);

    let y = FLOOR - GROUND * S;
    let rot = 0;
    if (this.jumpT >= 0) {
      const jt = this.jumpT / 0.55;
      y -= Math.sin(jt * Math.PI) * 64;
      rot = -14 * this.dir * Math.sin(jt * Math.PI);
    }
    y += Math.sin(this.t * 2.2) * 1.3 * upright;              // 숨쉬기
    rot += eth * (10 * Math.sin(this.t * 3.1) + 5 * Math.sin(this.t * 5.7)) * upright;
    // 기절: 침대 위로 엎어짐
    rot += this.passT * -22 * this.dir;
    y -= this.passT * 15;                                     // 배가 매트리스에 닿는 높이
    if (this.passT > 0.3) y += Math.sin(this.t * 1.1) * 1.6;  // 곯아떨어진 숨

    this.root.setAttribute('transform',
      `translate(${this.x.toFixed(1)} ${y.toFixed(1)}) scale(${this.dir * S} ${S}) rotate(${(rot * this.dir).toFixed(1)})`);
    this.shadow.setAttribute('cx', this.x.toFixed(1));
    const air = Math.max(0, (FLOOR - GROUND * S - y) / 64);
    this.shadow.setAttribute('rx', ((46 - air * 18) * S).toFixed(1));
    this.shadow.setAttribute('opacity', (0.55 - air * 0.3 - this.passT * 0.35).toFixed(2));

    // ── 다리 ─────────────────────────────────
    for (const leg of this.legs) {
      const [hx, hy] = leg.hip;
      let fx, fy, bend = -6;
      if (this.passT > 0.5) {                 // 기절: 다리를 옆으로 축 늘어뜨림
        const w = Math.sin(this.t * 1.1 + leg.phase) * 1.5;
        fx = hx + 13 + w; fy = 15; bend = -2.5;
      } else if (this.jumpT >= 0) {           // 점프: 접기
        fx = hx - 4; fy = hy + 14; bend = -8;
      } else {
        const ph = walking ? Math.sin(this.walkPhase + leg.phase) : Math.sin(this.t * 1.2 + leg.phase) * 0.12;
        const lift = walking ? Math.max(0, Math.cos(this.walkPhase + leg.phase)) * 5 : 0;
        fx = hx + 6 + ph * 10;
        fy = GROUND - lift;
        bend = leg.front ? -7 : -5.5;
      }
      this._setLeg(leg, fx, fy, bend);
    }

    // ── 날개 ─────────────────────────────────
    const flutter = this.jumpT >= 0 ? 1 : (walking ? 0.16 : 0.035);
    const wa = Math.sin(this.t * 90) * 18 * flutter;
    const droop = this.passT * 24 + eth * upright * 4;        // 취하면 날개 처짐
    this.wing1.setAttribute('transform', `rotate(${(-2 + wa + droop * 0.5).toFixed(1)} 4 -24)`);
    this.wing2.setAttribute('transform', `rotate(${(-9 - wa * 0.7 + droop).toFixed(1)} 4 -24)`);

    // ── 더듬이 ────────────────────────────────
    const tw = Math.sin(this.t * 7) * Math.min(1, r.dn / 8) * 2.5;
    this.ant.setAttribute('transform', `rotate(${tw.toFixed(1)} 16.5 -23)`);

    // ── 담배 ─────────────────────────────────
    const cigTarget = (this.nic > 0.05 && upright > 0.7 && this.jumpT < 0) ? 1 : 0;
    this.cigO += (cigTarget - this.cigO) * Math.min(1, dt * 4);
    this.cig.setAttribute('opacity', this.cigO.toFixed(2));
    if (this.cigO > 0.05) {
      this.ember.setAttribute('r', (1.4 + Math.max(0, Math.sin(this.t * 2.4)) * 0.9).toFixed(2));
      this.smoke.forEach((c, i) => {
        const ph = (this.t * 0.35 + i / 3) % 1;
        c.setAttribute('cy', (-4 - ph * 32).toFixed(1));
        c.setAttribute('cx', (45 + Math.sin(this.t * 1.7 + i * 2) * 3).toFixed(1));
        c.setAttribute('r', (2.2 + ph * 3.4).toFixed(2));
        c.setAttribute('opacity', ((1 - ph) * 0.85 * this.cigO * Math.max(0.5, this.nic)).toFixed(2));
      });
    }

    // ── 주둥이 ────────────────────────────────
    this.prob += (probTarget - this.prob) * Math.min(1, dt * 6);
    const L = 4 + this.prob * 16;
    this.probEl.setAttribute('d', `M 21 -6 q ${(3 + this.prob * 5).toFixed(1)} ${(L * 0.5).toFixed(1)} ${(1 + this.prob * 3).toFixed(1)} ${L.toFixed(1)}`);
    this.probTip.setAttribute('transform', `translate(${(this.prob * 4).toFixed(1)} ${(this.prob * 16).toFixed(1)})`);

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
