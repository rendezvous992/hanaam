// 3D 초파리 아바타 (Three.js r128, vendor/three.min.js 의 전역 THREE 사용).
// 모델은 fly-model.js(절차적 모델 + 다리 IK), 여기서는 무대·소품·행동을 담당한다.
// 행동 판정 핵심 로직은 fly.js(SVG 폴백)와 동일 + 3D 전용 액션(그루밍/비행/홀짝/딸꾹).
//
// 색: 렌더러 출력이 sRGB이므로 재질 색은 모두 srgb()로 선형화해서 넣는다(fly-model.js와 같은 규칙).
// 캔버스 텍스처는 sRGBEncoding을 달아 그대로 쓴다.
import { buildFlyModel, LegRig } from './fly-model.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const srgb = hex => new THREE.Color(hex).convertSRGBToLinear();

const BOUND = 3.6;        // 걸어다닐 수 있는 x 범위
const BED_POS = -2.55;    // 침대 위치
const MATTRESS_TOP = 0.78;
const PUDDLE_X = 3.0;     // 쏟아진 와인 위치
const TUB_POS = -0.4;     // 욕조 위치
const STAND_X = 0.62;     // 난간 앞 흡연 위치
const RAIL_X = STAND_X + 1.15;
const RAIL_Y = 2.15;
const Y0 = 0.86;          // 서 있을 때 몸 높이
const STRIDE = 0.5;       // 보폭(디딤 구간 동안 발이 몸에 대해 미끄러지는 거리)
const TV_X = 1.75;        // TV 위치
const TV_ROT = -0.78;     // TV 방향: 시청 자리의 초파리를 보면서 무대 카메라에도 화면이 보이게
const WATCH_X = -0.95;    // TV 앞 시청 자리
const WALL_Z = -7.5;
const OUTLET = [4.6, 0.56];   // 벽 콘센트 (x, y) — TV 전원선이 여기로 간다
// (THREE가 없을 때도 모듈은 읽혀야 SVG 폴백이 돈다 — 색 상수는 생성자에서 만든다)
let TV_WHITE, LED_ON, LED_OFF;

// ── 작은 도구들 ─────────────────────────────────
const rng = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function canvasTex(w, h, draw, { color = true, repeat = null, aniso = 1 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (color) t.encoding = THREE.sRGBEncoding;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.anisotropy = aniso;
  return t;
}

function radialTex(stops, size = 128) {
  return canvasTex(size, size, (g, w) => {
    const rg = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    for (const [o, c] of stops) rg.addColorStop(o, c);
    g.fillStyle = rg; g.fillRect(0, 0, w, w);
  });
}

// 둥근 모서리 사각형 (가운데 원점)
function rrShape(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

// ExtrudeGeometry는 면마다 평평한 법선을 준다 — 각도가 작은 이웃 면끼리만 법선을 평균해
// 둥근 모서리 옆면은 매끈하게, 앞면·모따기 경계는 또렷하게 둔다.
function creaseNormals(geo, angle = 0.17) {
  const pos = geo.attributes.position, n = pos.count;
  const fn = new Float32Array(n * 3);
  const a = V3(), b = V3(), c = V3(), ab = V3(), cb = V3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    cb.subVectors(c, b); ab.subVectors(a, b); cb.cross(ab).normalize();
    for (let k = 0; k < 3; k++) { fn[(i + k) * 3] = cb.x; fn[(i + k) * 3 + 1] = cb.y; fn[(i + k) * 3 + 2] = cb.z; }
  }
  const key = i => `${Math.round(pos.getX(i) * 2e3)},${Math.round(pos.getY(i) * 2e3)},${Math.round(pos.getZ(i) * 2e3)}`;
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const k = key(i);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  }
  const out = new Float32Array(n * 3), cos = Math.cos(angle);
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0, z = 0;
    for (const j of buckets.get(key(i))) {
      const d = fn[i * 3] * fn[j * 3] + fn[i * 3 + 1] * fn[j * 3 + 1] + fn[i * 3 + 2] * fn[j * 3 + 2];
      if (d >= cos) { x += fn[j * 3]; y += fn[j * 3 + 1]; z += fn[j * 3 + 2]; }
    }
    const l = Math.hypot(x, y, z) || 1;
    out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return geo;
}

// 둥근 판재: 폭 w(x) × 높이 h(y) × 두께 d(z), 모서리 반지름 r, 모따기 bevel. 가운데 원점.
function slab(w, h, d, r, bevel = 0, seg = 3) {
  const geo = new THREE.ExtrudeGeometry(rrShape(w - 2 * bevel, h - 2 * bevel, Math.max(0.002, r - bevel)), {
    depth: Math.max(0.001, d - 2 * bevel), bevelEnabled: bevel > 0, bevelThickness: bevel,
    bevelSize: bevel, bevelSegments: seg, curveSegments: 10 });
  geo.translate(0, 0, -(d - 2 * bevel) / 2);
  return creaseNormals(geo);
}

// 잔잔한 회색 노이즈 (범프용, 선형)
function noiseTex(size, seed, { blobs = 0, repeat = [1, 1], lo = 110, hi = 150 } = {}) {
  return canvasTex(size, size, (g, w, h) => {
    const r = rng(seed), img = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = lo + (hi - lo) * r();
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < blobs; i++) {
      const x = r() * w, y = r() * h, rad = 4 + r() * 22;
      g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${0.025 + r() * 0.04})`;
      for (const [ox, oy] of [[0, 0], [w, 0], [-w, 0], [0, h], [0, -h]]) {
        g.beginPath(); g.arc(x + ox, y + oy, rad, 0, Math.PI * 2); g.fill();
      }
    }
  }, { color: false, repeat });
}

// 참나무 마루: 판 폭 128px, 엇갈린 이음매, 판마다 ±6% 톤, 1px 틈, 옅은 나뭇결. 세로로 이어 붙는다.
function oakFloorTex(aniso) {
  return canvasTex(1024, 1024, (g, W, H) => {
    const r = rng(23), cols = 8, bw = W / cols;
    g.fillStyle = '#1d1612'; g.fillRect(0, 0, W, H);
    for (let c = 0; c < cols; c++) {
      const x = c * bw;
      let y = r() * H;
      const end = y + H;
      while (y < end - 1) {
        let len = 330 + r() * 520;
        if (end - (y + len) < 200) len = end - y;            // 짧은 토막은 남기지 않는다
        const tone = 1 + (r() - 0.5) * 0.12, warm = (r() - 0.5) * 6;
        const base = [58 * tone + warm, 48 * tone, 41 * tone - warm * 0.5];
        for (const oy of [0, -H]) {
          const yy = y + oy;
          if (yy > H || yy + len < 0) continue;
          const gr = g.createLinearGradient(x, 0, x + bw, 0);
          gr.addColorStop(0, `rgb(${base.map(v => v * 0.95 | 0)})`);
          gr.addColorStop(0.5, `rgb(${base.map(v => v * 1.03 | 0)})`);
          gr.addColorStop(1, `rgb(${base.map(v => v * 0.96 | 0)})`);
          g.fillStyle = gr;
          g.fillRect(x + 1, yy + 1, bw - 2, len - 2);
          // 나뭇결: 판 길이를 따라 살짝 굽이치는 가는 선
          g.save();
          g.beginPath(); g.rect(x + 1, yy + 1, bw - 2, len - 2); g.clip();
          const gs = rng(Math.floor(y * 13 + c * 977) + 5);
          for (let k = 0; k < 16; k++) {
            const gx = x + 4 + gs() * (bw - 8), amp = 2 + gs() * 5, fr = 0.004 + gs() * 0.01, ph = gs() * 6;
            g.strokeStyle = gs() < 0.6 ? `rgba(20,12,8,${0.05 + gs() * 0.06})` : `rgba(255,230,200,${0.025 + gs() * 0.03})`;
            g.lineWidth = 0.6 + gs() * 1.4;
            g.beginPath();
            for (let s = 0; s <= len; s += 16) g.lineTo(gx + Math.sin(s * fr + ph) * amp, yy + s);
            g.stroke();
          }
          if (gs() < 0.25) {                                // 옹이
            const kx = x + bw * (0.3 + gs() * 0.4), ky = yy + len * (0.2 + gs() * 0.6);
            for (let k = 5; k > 0; k--) {
              g.strokeStyle = `rgba(25,15,10,${0.05 + 0.03 * k})`; g.lineWidth = 1;
              g.beginPath(); g.ellipse(kx, ky, 2 + k * 2.2, 5 + k * 6, 0, 0, Math.PI * 2); g.stroke();
            }
          }
          g.restore();
        }
        y += len;
      }
    }
  }, { repeat: [13, 3.6], aniso });
}

// 밤 건물 외벽 (가까운 층): 콘크리트 질감, 층 슬래브, 창마다 다른 상태. 지붕 위는 투명.
function cityNearTex(aniso) {
  return canvasTex(1024, 512, (g, W, H) => {
    const r = rng(41);
    const blds = [[0, 360, 300], [360, 690, 352], [690, 1024, 268]];   // x0, x1, 지붕 y(px)
    for (const [x0, x1, top] of blds) {
      const sh = 0.9 + r() * 0.2;
      g.fillStyle = `rgb(${27 * sh | 0},${29 * sh | 0},${34 * sh | 0})`;
      g.fillRect(x0, top, x1 - x0, H - top);
      for (let i = 0; i < 900; i++) {                     // 콘크리트 얼룩
        g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '200,200,210'},${0.02 + r() * 0.03})`;
        g.fillRect(x0 + r() * (x1 - x0), top + r() * (H - top), 1 + r() * 3, 1 + r() * 3);
      }
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(x0, top, x1 - x0, 3);           // 옥상 난간 그림자
      g.fillStyle = 'rgba(160,165,175,0.18)'; g.fillRect(x0, top, x1 - x0, 1);
      const fh = 40, ww = 22, wh = 25, gap = 14;
      for (let fy = top + 12; fy + wh < H; fy += fh) {
        g.fillStyle = 'rgba(150,150,160,0.10)'; g.fillRect(x0, fy + wh + 6, x1 - x0, 2);   // 층 슬래브
        for (let fx = x0 + 10; fx + ww < x1 - 6; fx += ww + gap) {
          const p = r();
          if (p < 0.70) {                                   // 꺼진 창: 하늘을 비추는 어두운 유리
            const gr = g.createLinearGradient(fx, fy, fx + ww, fy + wh);
            gr.addColorStop(0, '#26303e'); gr.addColorStop(0.55, '#141a24'); gr.addColorStop(1, '#0d1118');
            g.fillStyle = gr;
          } else if (p < 0.88) {                            // 따뜻한 불빛
            const gr = g.createLinearGradient(fx, fy, fx, fy + wh);
            gr.addColorStop(0, '#ffcf8a'); gr.addColorStop(1, '#e9a25a');
            g.fillStyle = gr;
          } else if (p < 0.92) {                            // TV 불빛
            g.fillStyle = r() < 0.5 ? '#7fa6d8' : '#5d7fb8';
          } else {                                          // 안쪽 스탠드만 켠 집
            g.fillStyle = '#5a4532';
          }
          g.fillRect(fx, fy, ww, wh);
          if (p >= 0.70 && p < 0.88) {
            if (r() < 0.5) {                                // 블라인드
              g.fillStyle = 'rgba(90,55,25,0.35)';
              for (let s = fy + 2; s < fy + wh; s += 3) g.fillRect(fx, s, ww, 1);
            } else {                                        // 커튼
              g.fillStyle = 'rgba(120,70,35,0.55)';
              g.fillRect(fx, fy, ww * 0.28, wh); g.fillRect(fx + ww * 0.78, fy, ww * 0.22, wh);
            }
          }
          g.fillStyle = 'rgba(10,11,14,0.9)';               // 창살
          g.fillRect(fx + ww / 2 - 0.5, fy, 1, wh); g.fillRect(fx, fy + wh * 0.38, ww, 1);
          g.fillStyle = 'rgba(150,155,165,0.16)'; g.fillRect(fx - 1, fy + wh, ww + 2, 2);  // 창턱
        }
      }
    }
  }, { aniso });
}

// 먼 스카이라인 실루엣 + 드문드문 불빛
function cityFarTex() {
  return canvasTex(1024, 256, (g, W, H) => {
    const r = rng(97);
    let x = 0;
    while (x < W) {
      const bw = 40 + r() * 90, top = 40 + r() * 140;
      g.fillStyle = `rgb(${17 + r() * 5 | 0},${19 + r() * 5 | 0},${25 + r() * 5 | 0})`;
      g.fillRect(x, top, bw + 1, H - top);
      for (let wy = top + 6; wy < H - 4; wy += 9) for (let wx = x + 4; wx < x + bw - 4; wx += 7) {
        const p = r();
        if (p < 0.07) { g.fillStyle = `rgba(255,${190 + r() * 40 | 0},120,${0.35 + r() * 0.4})`; g.fillRect(wx, wy, 3, 4); }
        else if (p < 0.085) { g.fillStyle = 'rgba(150,180,230,0.5)'; g.fillRect(wx, wy, 3, 4); }
      }
      x += bw;
    }
  });
}

function skyTex() {
  return canvasTex(16, 256, (g, W, H) => {
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#08090d'); gr.addColorStop(0.55, '#141419');
    gr.addColorStop(0.8, '#2b2621'); gr.addColorStop(1, '#3a2f25');     // 지평선 쪽 도시 불빛
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  });
}

// 수면 잔물결 노멀맵 (정수 주파수라 이음매 없이 반복)
function rippleNormalTex() {
  const N = 128, waves = [[3, 1, 0.9, 0.3], [1, 4, 0.6, 1.7], [5, -2, 0.35, 2.9], [-2, 7, 0.25, 4.1], [8, 3, 0.15, 0.7]];
  return canvasTex(N, N, (g) => {
    const img = g.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let dx = 0, dy = 0;
      for (const [fx, fy, a, ph] of waves) {
        const c = Math.cos(2 * Math.PI * (fx * x + fy * y) / N + ph) * a;
        dx += c * fx; dy += c * fy;
      }
      const nx = -dx * 0.08, ny = -dy * 0.08, l = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, { color: false, repeat: [3, 1.5] });
}

// 담배 연기: 여러 겹의 부드러운 덩어리
function smokeTex() {
  return canvasTex(128, 128, (g, W) => {
    const r = rng(5);
    for (let i = 0; i < 9; i++) {
      const x = W * (0.3 + r() * 0.4), y = W * (0.25 + r() * 0.5), rad = W * (0.12 + r() * 0.2);
      const rg = g.createRadialGradient(x, y, 0, x, y, rad);
      rg.addColorStop(0, `rgba(255,255,255,${0.18 + r() * 0.2})`); rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, W, W);
    }
  });
}

// 손잡이가 있는 와인잔 (높이 ≈ 0.46). liquid = 잔에 남은 와인
function wineGlass(env, liquid = true) {
  const g = new THREE.Group();
  const prof = [[0.001, 0], [0.12, 0], [0.122, 0.006], [0.1, 0.012], [0.035, 0.022], [0.014, 0.045], [0.012, 0.2],
    [0.018, 0.225], [0.05, 0.245], [0.085, 0.275], [0.105, 0.315], [0.11, 0.36], [0.104, 0.41], [0.092, 0.455], [0.091, 0.46]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const glassMat = new THREE.MeshPhysicalMaterial({ color: srgb(0xe4e8ec), roughness: 0.05, metalness: 0,
    envMap: env, envMapIntensity: 2.4, clearcoat: 1, clearcoatRoughness: 0.03,
    transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false });
  const glass = new THREE.Mesh(new THREE.LatheGeometry(prof, 32), glassMat);
  glass.renderOrder = 6;
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.0915, 0.0025, 4, 32), glassMat);
  lip.rotation.x = Math.PI / 2; lip.position.y = 0.46;
  lip.renderOrder = 6;
  g.add(glass, lip);
  if (liquid) {
    const lp = [[0.001, 0.232], [0.04, 0.245], [0.075, 0.268], [0.096, 0.3], [0.1, 0.318], [0.001, 0.318]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    const wine = new THREE.Mesh(new THREE.LatheGeometry(lp, 32),
      new THREE.MeshStandardMaterial({ color: srgb(0x4a0a14), roughness: 0.12, envMap: env, envMapIntensity: 0.8 }));
    g.add(wine);
  }
  return g;
}

export class Fly3D {
  constructor(container) {
    if (typeof THREE === 'undefined') throw new Error('THREE 없음');
    TV_WHITE = srgb(0xc8d8ff); LED_ON = srgb(0x9a9ea6); LED_OFF = srgb(0xff3b2f);
    this.x = 0;
    this.dir = 1;
    this.jumpT = -1;
    this.jumpCooldown = 0;
    this.flightT = 0;          // 비행 잔여 시간
    this.groomT = 0;           // 그루밍 잔여 시간
    this.hicT = 0;             // 딸꾹질 잔여 시간
    this.sip = 0;              // 와인 홀짝 몰입도 0..1
    this.prob = 0;
    this.passedOut = false;
    this.passT = 0;
    this.t = 0;
    this.gaitP = 0;            // 삼각보행 위상(주기 단위)
    this.walkW = 0;            // 보행 블렌드 0..1
    this.tuckW = 0;            // 다리 접기(점프·비행) 블렌드
    this.groomW = 0;
    this.spreadW = 0;          // 날개 펼침 블렌드
    this.eth = 0;
    this.nic = 0;
    this.cigO = 0;
    this.bedO = 0;
    this.bottleO = 0;
    this.spill = 0;
    this.standT = 0;           // 난간에 기대 서 있는 정도 0..1
    this.balconyO = 0;
    this.bathT = 0;            // 욕조에 들어가 있는 정도 0..1
    this.tubO = 0;
    this.tvOn = false;         // 실험실 화면(TV/탁구) 켜짐
    this.tvO = 0;
    this.tvPow = 0;            // 화면 밝기 램프 (켤 때 0→1)
    this.tvLum = 0;            // 화면 평균 밝기 (조명용)
    this.tvMean = new THREE.Color(0, 0, 0);
    this._tvTarget = new THREE.Color(0, 0, 0);
    this._tvN = 0;
    this._tint = new THREE.Color();
    this._chroma = new THREE.Color();
    this.watchT = 0;
    this.tvLabel = '';
    this.rates = { fwd: 0, back: 0, jump: 0, prob: 0, dn: 0, motor: 0, brain: 0 };
    this.s = { fwd: 0, back: 0, jump: 0, prob: 0 };
    this.behavior = '대기';
    this._staggerVx = 0;

    // ── 렌더러/카메라 ─────────────────────────
    container.innerHTML = '';
    const wpx = container.clientWidth || 520, hpx = container.clientHeight || 330;
    const rend = this.rend = new THREE.WebGLRenderer({ antialias: true });
    rend.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    rend.setSize(wpx, hpx);
    rend.shadowMap.enabled = true;
    rend.shadowMap.type = THREE.PCFSoftShadowMap;
    rend.outputEncoding = THREE.sRGBEncoding;
    rend.toneMapping = THREE.ACESFilmicToneMapping;
    rend.toneMappingExposure = 1.05;
    container.appendChild(rend.domElement);
    rend.domElement.style.width = '100%';
    rend.domElement.style.height = '100%';
    rend.domElement.style.borderRadius = '10px';
    addEventListener('resize', () => {
      const w2 = container.clientWidth, h2 = container.clientHeight;
      if (!w2 || !h2) return;
      rend.setSize(w2, h2);
      this.cam.aspect = w2 / h2;
      this.cam.updateProjectionMatrix();
    });
    const aniso = Math.min(8, rend.capabilities.getMaxAnisotropy());
    this.aniso = aniso;

    const scene = this.scene = new THREE.Scene();
    // 배경색(clear color)은 출력 공간 값 그대로 쓰이고, 안개는 선형 공간에서 섞인다
    scene.background = new THREE.Color(0x0e0e11);
    scene.fog = new THREE.Fog(srgb(0x0e0e11), 15, 31);
    // 앞쪽 3/4 시점: 얼굴과 옆모습이 함께 보이도록
    const cam = this.cam = new THREE.PerspectiveCamera(32, wpx / hpx, 0.1, 80);
    this.camT = V3(0, 1.15, 0);
    cam.position.set(3.6, 3.85, 9.6);
    cam.lookAt(this.camT);

    // ── 초파리: 바깥 그룹(위치·방향) → body(기울기·롤) ──
    const model = this.model = buildFlyModel(rend);
    const env = this.env = model.mats.head.envMap;     // fly-model의 작은 스튜디오 반사 환경
    this.fly = new THREE.Group();
    this.body = model.body;
    this.fly.add(this.body);
    scene.add(this.fly);
    this.wings = model.wings;
    this.probG = model.probG;
    this.probLab = model.probLab;
    this.rig = new LegRig(scene, model.mats);

    // ── 조명: 천장 전구 하나가 키 라이트, 차가운 림, 약한 앞 채움 ──
    this.hemi = new THREE.HemisphereLight(srgb(0xc3c8d2), srgb(0x2a2420), 0.95);
    scene.add(this.hemi);
    const spot = new THREE.SpotLight(srgb(0xffd6a0), 1.45, 40, 0.86, 0.85, 1.4);
    spot.position.set(3.1, 5.3, 1.2);                 // 전구 자리에서 그림자가 진다
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0015;
    spot.shadow.camera.near = 0.5;
    scene.add(spot, spot.target);
    spot.target.position.set(0.5, 0, 0);
    const rim = new THREE.DirectionalLight(srgb(0xbfcbe0), 0.6);
    rim.position.set(-6, 4.5, -6);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(srgb(0xfff0dc), 0.4);
    fill.position.set(4, 5, 10);
    scene.add(fill);
    this.spotL = spot;
    this.rimL = rim;

    this._buildRoom(scene, aniso);
    this._buildBulb(scene);
    this._buildCigarette(scene);

    // ── 소품 그룹: 재질을 그룹별로 두고 투명도로 나타났다 사라진다 ──
    // (재질을 복제하지 않는다 — this.screenMat 같은 핸들이 실제로 그려지는 재질이어야 한다)
    const mkFadeGroup = g => {
      const seen = new Map();
      g.traverse(o => {
        const m = o.material;
        if (!m || o.userData.noFade) return;
        if (!seen.has(m)) seen.set(m, { o: m.opacity ?? 1, t: m.transparent });
        const s = seen.get(m);
        o.userData.baseO = s.o;
        o.userData.alwaysT = o.userData.alwaysT || s.t;
      });
      for (const m of seen.keys()) { m.transparent = true; m.opacity = 0; }
      g.visible = false;
      return g;
    };
    scene.add(mkFadeGroup(this._buildBottle(env)));
    scene.add(mkFadeGroup(this._buildBed(aniso)));
    scene.add(mkFadeGroup(this._buildBalcony(aniso)));
    scene.add(mkFadeGroup(this._buildTub(env)));
    scene.add(mkFadeGroup(this._buildTV(env)));
    this.tvLight = new THREE.PointLight(TV_WHITE.clone(), 0, 7.5, 2);   // 화면 빛이 얼굴을 비춘다
    this.tvLight.position.copy(this.tvG.localToWorld(V3(0, 2.15, 0.9)));
    scene.add(this.tvLight);
  }

  // ── 방: 참나무 마루, 회반죽 벽, 걸레받이, 콘센트 ─────────
  _buildRoom(scene, aniso) {
    const oak = oakFloorTex(aniso);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(44, 26),
      new THREE.MeshStandardMaterial({ color: srgb(0xffffff), map: oak, bumpMap: oak, bumpScale: 0.006, roughness: 0.8 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const plaster = noiseTex(256, 3, { blobs: 220, repeat: [10, 4], lo: 118, hi: 138 });
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(44, 16),
      new THREE.MeshStandardMaterial({ color: srgb(0x5b5651), roughness: 0.95, bumpMap: plaster, bumpScale: 0.01 }));
    wall.position.set(0, 8, WALL_Z);
    wall.receiveShadow = true;
    scene.add(wall);
    const trimMat = new THREE.MeshStandardMaterial({ color: srgb(0x1c1b1e), roughness: 0.5 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(44, 0.28, 0.05), trimMat);
    base.position.set(0, 0.14, WALL_Z + 0.025);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(44, 0.025, 0.065), trimMat);
    cap.position.set(0, 0.29, WALL_Z + 0.03);
    scene.add(base, cap);
    // 벽 콘센트 (TV 전원선이 꽂히는 곳)
    const plate = new THREE.Mesh(slab(0.16, 0.24, 0.016, 0.02, 0.004),
      new THREE.MeshStandardMaterial({ color: srgb(0xcfcac2), roughness: 0.45 }));
    plate.position.set(OUTLET[0], OUTLET[1], WALL_Z + 0.008);
    const holeMat = new THREE.MeshStandardMaterial({ color: srgb(0x8f8b85), roughness: 0.6 });
    for (const dy of [-0.055, 0.055]) {
      const h = new THREE.Mesh(new THREE.CircleGeometry(0.038, 20), holeMat);
      h.position.set(OUTLET[0], OUTLET[1] + dy, WALL_Z + 0.0175);
      scene.add(h);
    }
    scene.add(plate);
  }

  // ── 천장 펜던트: 패브릭 전선 + 황동 소켓 + 에디슨 전구(필라멘트) ──
  _buildBulb(scene) {
    const g = this.bulbG = new THREE.Group();
    g.position.set(3.1, 8.2, 1.2);                     // 천장 쪽 매달린 점(흔들림 축)
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 2.3, 6),
      new THREE.MeshStandardMaterial({ color: srgb(0x1a1a1a), roughness: 0.85 }));
    cord.position.y = -1.15;
    const brass = new THREE.MeshStandardMaterial({ color: srgb(0xb08d57), metalness: 0.9, roughness: 0.35, envMap: this.env });
    const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.066, 0.072, 0.24, 24), brass);
    sock.position.y = -2.42;
    const capM = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.05, 0.05, 16), brass);
    capM.position.y = -2.29;
    g.add(cord, sock, capM);
    for (const y of [-2.36, -2.4, -2.44]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.0045, 6, 28), brass);
      ring.rotation.x = Math.PI / 2; ring.position.y = y;
      g.add(ring);
    }
    // ST64 유리 (선반 단면)
    const ctrl = new THREE.CatmullRomCurve3([[0.05, 0], [0.052, -0.04], [0.07, -0.09], [0.11, -0.16], [0.145, -0.24],
      [0.16, -0.31], [0.156, -0.38], [0.132, -0.44], [0.088, -0.485], [0.035, -0.5], [0.001, -0.503]].map(([r, y]) => V3(r, y, 0)));
    const prof = ctrl.getPoints(40).map(p => new THREE.Vector2(Math.max(0.001, p.x), p.y));
    const glass = new THREE.Mesh(new THREE.LatheGeometry(prof, 40),
      new THREE.MeshPhysicalMaterial({ color: srgb(0xffe6c0), roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16,
        emissive: srgb(0xffa850), emissiveIntensity: 0.12, envMap: this.env, envMapIntensity: 1.5, clearcoat: 1,
        clearcoatRoughness: 0.02, depthWrite: false }));
    glass.position.y = -2.54;
    // 필라멘트: 왕관 모양 지그재그 + 지지선
    const fp = [];
    for (let k = 0; k <= 12; k++) {
      const a = k / 12 * Math.PI * 2;
      fp.push(V3(Math.cos(a) * 0.055, -2.8 - (k % 2 ? 0.07 : 0), Math.sin(a) * 0.055));
    }
    const filMat = new THREE.MeshBasicMaterial({ color: srgb(0xffc27a) });
    filMat.toneMapped = false;
    const fil = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(fp, true), 72, 0.0045, 4, true), filMat);
    const wireMat = new THREE.MeshBasicMaterial({ color: srgb(0x6a5a48) });
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, 0.26, 3), wireMat);
      w.position.set(s * 0.03, -2.67, 0); w.rotation.z = s * 0.1;
      g.add(w);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTex([[0, 'rgba(255,200,130,0.9)'], [0.25, 'rgba(255,170,90,0.35)'], [1, 'rgba(255,150,70,0)']]),
      blending: THREE.AdditiveBlending, transparent: true, opacity: 0.4, depthWrite: false }));
    glow.scale.set(1.3, 1.3, 1);
    glow.position.y = -2.84;
    g.add(glass, fil, glow);
    scene.add(g);
    const bulbLight = new THREE.PointLight(srgb(0xffd49a), 0.55, 7, 2);
    bulbLight.position.set(3.1, 5.36, 1.2);
    scene.add(bulbLight);
  }

  // ── 담배: 코르크 필터 + 금색 띠 + 종이 + 재, 불씨는 재 속의 얇은 고리. 연기는 월드 공간 ──
  _buildCigarette(scene) {
    this.cigG = new THREE.Group();
    this.cigG.position.set(1.66, 0.36, 0.1);
    this.body.add(this.cigG);
    const rod = new THREE.Group();                   // 입 쪽 끝이 원점, +y가 담배 축
    rod.position.set(-0.03, -0.17, 0);
    rod.rotation.z = -1.38;                           // 앞으로, 살짝 위로
    this.cigG.add(rod);
    const R = 0.042;
    const seg = (y0, y1, mat, r0 = R, r1 = R) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, y1 - y0, 20), mat);
      m.position.y = (y0 + y1) / 2;
      rod.add(m);
      return m;
    };
    const cork = canvasTex(64, 64, (g, w, h) => {
      const r = rng(9);
      g.fillStyle = '#c98a4b'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 160; i++) {
        g.fillStyle = r() < 0.6 ? `rgba(120,70,30,${0.3 + r() * 0.4})` : `rgba(240,200,150,${0.3 + r() * 0.3})`;
        g.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2);
      }
    });
    seg(0, 0.16, new THREE.MeshStandardMaterial({ map: cork, roughness: 0.85 }));
    seg(0.16, 0.168, new THREE.MeshStandardMaterial({ color: srgb(0xc9a24f), metalness: 0.8, roughness: 0.35, envMap: this.env }), R + 0.0006, R + 0.0006);
    seg(0.168, 0.53, new THREE.MeshStandardMaterial({ color: srgb(0xf1eee8), roughness: 0.9 }));
    const emberMat = new THREE.MeshBasicMaterial({ color: srgb(0xff5a1a) });
    emberMat.toneMapped = false;
    this.ember = seg(0.53, 0.545, emberMat, R, R - 0.001);
    seg(0.545, 0.585, new THREE.MeshStandardMaterial({ color: srgb(0x8d8a85), roughness: 1 }), R - 0.001, R - 0.006);
    this.cigTip = new THREE.Object3D();
    this.cigTip.position.y = 0.59;
    rod.add(this.cigTip);
    this.cigLight = new THREE.PointLight(srgb(0xff9a40), 0, 2.6, 2);
    this.cigLight.position.set(0.55, 0.12, 0.1);
    this.cigG.add(this.cigLight);
    // 연기 입자: 불씨 위치에서 태어나 세계 기준 위로 오르며 퍼진다
    const tex = smokeTex();
    this.smoke = [];
    for (let i = 0; i < 14; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: srgb(0xb9c2cf), transparent: true, opacity: 0, depthWrite: false }));
      sp.visible = false;
      scene.add(sp);
      this.smoke.push({ sp, age: i / 14, alive: false, o: V3(), seed: Math.random() * 10, spin: (Math.random() - 0.5) * 0.6 });
    }
  }

  // ── 와인병(눕는다) + 와인잔 + 웅덩이 ─────────
  _buildBottle(env) {
    const bottleG = this.bottleG = new THREE.Group();
    const prof = [[0.001, 0.025], [0.07, 0.008], [0.16, 0], [0.17, 0.02], [0.17, 0.78], [0.165, 0.83], [0.142, 0.89],
      [0.105, 0.94], [0.075, 0.98], [0.063, 1.02], [0.06, 1.18], [0.07, 1.19], [0.071, 1.24], [0.058, 1.25], [0.001, 1.25]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    const bottleMesh = new THREE.Mesh(new THREE.LatheGeometry(prof, 36),
      new THREE.MeshPhysicalMaterial({ color: srgb(0x1e3b26), roughness: 0.08, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05,
        envMap: env, envMapIntensity: 1.3, transparent: true, opacity: 0.9 }));
    bottleMesh.castShadow = true;
    const foil = new THREE.Mesh(new THREE.CylinderGeometry(0.064, 0.066, 0.25, 28),
      new THREE.MeshStandardMaterial({ color: srgb(0x5a1420), metalness: 0.6, roughness: 0.35, envMap: env }));
    foil.position.y = 1.13;
    const labelTex = canvasTex(512, 256, (g, w, h) => {
      const r = rng(77);
      g.fillStyle = '#e8dfc8'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(120,100,70,${r() * 0.06})`; g.fillRect(r() * w, r() * h, 2, 2); }
      g.strokeStyle = '#6b5a3a'; g.lineWidth = 3; g.strokeRect(150, 14, 212, h - 28);
      g.lineWidth = 1; g.strokeRect(158, 22, 196, h - 44);
      // 작은 문장(紋章): 방패 윤곽 + 가로띠
      g.beginPath(); g.moveTo(236, 44); g.lineTo(276, 44); g.lineTo(276, 70); g.quadraticCurveTo(256, 92, 236, 70); g.closePath();
      g.lineWidth = 2; g.stroke();
      g.fillStyle = '#6b1a24'; g.fillRect(238, 56, 36, 6);
      g.fillStyle = '#3d2f1e'; g.textAlign = 'center';
      g.font = 'bold 30px Georgia, "Times New Roman", serif'; g.fillText('ROUGE', 256, 136);
      g.font = '16px Georgia, "Times New Roman", serif'; g.fillText('2019', 256, 162);
      g.fillStyle = 'rgba(61,47,30,0.55)';
      for (const [y, lw] of [[186, 120], [198, 96], [210, 110]]) g.fillRect(256 - lw / 2, y, lw, 3);
    });
    const label = new THREE.Mesh(new THREE.CylinderGeometry(0.1725, 0.1725, 0.36, 36, 1, true, -1.3, 2.6),
      new THREE.MeshStandardMaterial({ map: labelTex, roughness: 0.8 }));
    label.position.y = 0.42;
    this.bottleBody = new THREE.Group();
    this.bottleBody.add(bottleMesh, foil, label);
    bottleG.add(this.bottleBody);
    const glass = wineGlass(env);
    glass.position.set(0.6, 0, 0.3);
    bottleG.add(glass);
    // 웅덩이는 초파리가 걸어가 마실 수 있게 몸 바로 앞 선상(z≈0.1)에 퍼진다
    const shape = new THREE.Shape();
    for (let i = 0; i <= 40; i++) {
      const a = i / 40 * Math.PI * 2;
      const rr = 1 + 0.16 * Math.sin(3 * a + 0.4) + 0.09 * Math.sin(5 * a + 1.3) + 0.04 * Math.sin(9 * a + 2.1);
      const p = new THREE.Vector2(Math.cos(a) * rr * 0.92, Math.sin(a) * rr * 0.92);
      if (i === 0) shape.moveTo(p.x, p.y); else shape.lineTo(p.x, p.y);
    }
    this.puddleMesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 1),
      new THREE.MeshStandardMaterial({ color: srgb(0x4a0812), roughness: 0.08, metalness: 0, envMap: env, envMapIntensity: 0.3,
        transparent: true, opacity: 0.96 }));
    this.puddleMesh.rotation.x = -Math.PI / 2;
    this.puddleMesh.position.set(PUDDLE_X - 4.3, 0.012, -0.65);
    this.puddleMesh.scale.set(0.001, 0.001, 1);
    this.puddleMesh.receiveShadow = true;
    bottleG.add(this.puddleMesh);
    bottleG.position.set(4.3, 0, 0.75);
    return bottleG;
  }

  // ── 침대: 원목 프레임 + 둥근 매트리스 + 헤드보드 + 부푼 베개 + 늘어진 이불 ──
  _buildBed(aniso) {
    const bedG = this.bedG = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: srgb(0x5b4636), roughness: 0.6 });
    const fabricBump = noiseTex(128, 17, { repeat: [6, 6], lo: 100, hi: 160 });
    // 프레임: 옆 레일 + 발치 레일 + 가늘어지는 다리
    for (const z of [-0.84, 0.84]) {
      const rail = new THREE.Mesh(slab(3.78, 0.16, 0.08, 0.02, 0.01), wood);
      rail.position.set(0, 0.42, z);
      rail.castShadow = true;
      bedG.add(rail);
    }
    const foot = new THREE.Mesh(slab(1.76, 0.16, 0.08, 0.02, 0.01), wood);
    foot.rotation.y = Math.PI / 2; foot.position.set(1.85, 0.42, 0);
    foot.castShadow = true;
    bedG.add(foot);
    for (const [lx, lz] of [[-1.82, 0.82], [1.82, 0.82], [-1.82, -0.82], [1.82, -0.82]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.034, 0.36, 14), wood);
      leg.position.set(lx, 0.18, lz);
      leg.castShadow = true;
      bedG.add(leg);
    }
    // 매트리스: 둥근 직육면체, 윗면 0.78
    const mattress = new THREE.Mesh(slab(3.6, 1.6, 0.36, 0.12, 0.05),
      new THREE.MeshStandardMaterial({ color: srgb(0xe9e6df), roughness: 0.95, bumpMap: fabricBump, bumpScale: 0.004 }));
    mattress.rotation.x = -Math.PI / 2;
    mattress.position.y = MATTRESS_TOP - 0.18;
    mattress.castShadow = true;
    mattress.receiveShadow = true;
    bedG.add(mattress);
    // 헤드보드: 세로 골(채널 터프팅)이 있는 패브릭
    const tuft = canvasTex(128, 32, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, w, 0);
      for (let i = 0; i <= 4; i++) { gr.addColorStop(i / 4, '#404040'); if (i < 4) gr.addColorStop(i / 4 + 0.125, '#c8c8c8'); }
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }, { color: false, repeat: [1, 1] });
    const head = new THREE.Mesh(slab(1.78, 1.12, 0.1, 0.06, 0.035),
      new THREE.MeshStandardMaterial({ color: srgb(0x5d6670), roughness: 0.92, bumpMap: tuft, bumpScale: 0.03 }));
    head.rotation.y = Math.PI / 2;
    head.position.set(-1.9, 0.98, 0);
    head.castShadow = true;
    head.receiveShadow = true;
    bedG.add(head);
    for (const z of [-0.86, 0.86]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.034, 0.44, 12), wood);
      post.position.set(-1.9, 0.22, z);
      bedG.add(post);
    }
    // 베개: 상자를 부풀린다 — 가장자리는 솔기로 모이고 가운데가 볼록, 머리 자국
    const pw = 0.95, ph = 0.3, pd = 0.72;
    const pg = new THREE.BoxGeometry(pw, ph, pd, 14, 4, 12);
    const pp = pg.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
      const fx = 1 - Math.pow(Math.abs(2 * x / pw), 4), fz = 1 - Math.pow(Math.abs(2 * z / pd), 4);
      const f = Math.pow(Math.max(0, fx * fz), 0.35);
      let ny = y * f;
      if (y > 0) ny -= 0.06 * f * Math.exp(-((x + 0.08) ** 2 + z * z) / 0.05);
      pp.setXYZ(i, x * (1 + 0.05 * f), ny, z * (1 + 0.05 * f));
    }
    pg.computeVertexNormals();
    const pillow = new THREE.Mesh(pg, new THREE.MeshStandardMaterial({ color: srgb(0xeeebe5), roughness: 0.95,
      bumpMap: fabricBump, bumpScale: 0.003 }));
    pillow.position.set(-1.33, MATTRESS_TOP + ph / 2 - 0.03, 0);
    pillow.castShadow = true;
    pillow.receiveShadow = true;
    bedG.add(pillow);
    // 이불: 발치 쪽을 덮고 양옆·끝으로 흘러내린다
    const DW = 1.9, DD = 2.24, x0 = 0.08;
    const dg = new THREE.PlaneGeometry(DW, DD, 30, 30);
    dg.rotateX(-Math.PI / 2);
    const dp = dg.attributes.position;
    const drape = (s, edge) => {                  // 가장자리 너머 거리 s → (바깥쪽, 높이 낮춤)
      const R0 = 0.06;
      if (s <= 0) return [0, 0];
      if (s < R0 * Math.PI / 2) { const a = s / R0; return [R0 * Math.sin(a), R0 * (1 - Math.cos(a))]; }
      return [R0 + 0.004 * (s - R0 * Math.PI / 2) * 10 * edge, R0 + (s - R0 * Math.PI / 2)];
    };
    for (let i = 0; i < dp.count; i++) {
      let x = dp.getX(i) + x0 + DW / 2, z = dp.getZ(i);
      let y = MATTRESS_TOP + 0.03 + 0.012 * Math.sin(x * 7 + z * 2.3) + 0.008 * Math.sin(z * 9 - x * 3);
      const sz = Math.abs(z) - 0.8, sx = x - 1.8;
      if (sz > 0) {
        const [o, d] = drape(sz, 1);
        z = Math.sign(z) * (0.8 + o + 0.02 * Math.max(0, sz - 0.1) * Math.sin(x * 11));
        y -= d;
      }
      if (sx > 0) { const [o, d] = drape(sx, 1); x = 1.8 + o; y -= d; }
      dp.setXYZ(i, x, Math.max(0.47, y), z);
    }
    dg.computeVertexNormals();
    const duvetMat = new THREE.MeshStandardMaterial({ color: srgb(0x6c7a86), roughness: 0.93, side: THREE.DoubleSide,
      bumpMap: fabricBump, bumpScale: 0.003 });
    const duvet = new THREE.Mesh(dg, duvetMat);
    duvet.castShadow = true;
    duvet.receiveShadow = true;
    const hem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.66, 12), duvetMat);
    hem.rotation.x = Math.PI / 2;
    hem.position.set(x0 + 0.06, MATTRESS_TOP + 0.05, 0);
    hem.castShadow = true;
    bedG.add(duvet, hem);
    bedG.position.set(BED_POS, 0, 0.15);
    bedG.scale.set(1.25, 1, 1.2);                     // 몸길이 4.4에 맞춘 침대
    return bedG;
  }

  // ── 발코니 (흡연 씬): 각진 기둥 + 원목 손잡이 + 살대, 타일 바닥, 밤 도시 ──
  _buildBalcony(aniso) {
    const balG = this.balconyG = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: srgb(0x2b2d31), roughness: 0.55, metalness: 0.4, envMap: this.env, envMapIntensity: 0.5 });
    const oakTop = new THREE.MeshStandardMaterial({ color: srgb(0x6b4f37), roughness: 0.55 });
    const box = (w, h, d, x, y, z, mat = metal) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      balG.add(m);
      return m;
    };
    const Z0 = -1.8, Z1 = 1.8, XB = RAIL_X - 3.5;
    // 기둥 (끝과 모서리) + 작은 캡
    for (const [x, z] of [[RAIL_X, Z0], [RAIL_X, Z1], [XB, Z0]]) {
      box(0.08, RAIL_Y, 0.08, x, RAIL_Y / 2, z);
    }
    // 앞 난간 (z 방향) / 옆 난간 (x 방향): 원목 손잡이, 그 밑 평철, 아래 띠
    box(0.14, 0.06, Z1 - Z0 + 0.14, RAIL_X, RAIL_Y + 0.035, 0, oakTop);
    box(0.05, 0.03, Z1 - Z0, RAIL_X, RAIL_Y - 0.01, 0);
    box(0.05, 0.04, Z1 - Z0, RAIL_X, 0.16, 0);
    box(RAIL_X - XB + 0.14, 0.06, 0.14, (RAIL_X + XB) / 2, RAIL_Y + 0.035, Z0, oakTop);
    box(RAIL_X - XB, 0.03, 0.05, (RAIL_X + XB) / 2, RAIL_Y - 0.01, Z0);
    box(RAIL_X - XB, 0.04, 0.05, (RAIL_X + XB) / 2, 0.16, Z0);
    // 살대: 한 면에 InstancedMesh 하나
    const bh = RAIL_Y - 0.2, bgeo = new THREE.BoxGeometry(0.035, bh, 0.035);
    const place = (pts) => {
      const im = new THREE.InstancedMesh(bgeo, metal, pts.length);
      const m4 = new THREE.Matrix4();
      pts.forEach(([x, z], i) => im.setMatrixAt(i, m4.makeTranslation(x, 0.18 + bh / 2, z)));
      im.castShadow = true;
      balG.add(im);
    };
    const front = [], side = [];
    for (let z = Z0 + 0.3; z < Z1 - 0.1; z += 0.3) front.push([RAIL_X, z]);
    for (let x = XB + 0.3; x < RAIL_X - 0.1; x += 0.3) side.push([x, Z0]);
    place(front); place(side);
    // 바닥 타일 + 슬래브 끝
    const tiles = canvasTex(256, 256, (g, w, h) => {
      const r = rng(31);
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        const v = 66 + r() * 10;
        g.fillStyle = `rgb(${v | 0},${v - 3 | 0},${v - 7 | 0})`; g.fillRect(i * 64, j * 64, 64, 64);
        for (let k = 0; k < 60; k++) { g.fillStyle = `rgba(0,0,0,${r() * 0.08})`; g.fillRect(i * 64 + r() * 64, j * 64 + r() * 64, 2, 2); }
      }
      g.fillStyle = '#2a2724';
      for (let i = 0; i <= 4; i++) { g.fillRect(i * 64 - 1, 0, 2, h); g.fillRect(0, i * 64 - 1, w, 2); }
    }, { repeat: [3, 3], aniso });
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(RAIL_X - XB + 0.5, Z1 - Z0 + 0.5),
      new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.8 }));
    deck.rotation.x = -Math.PI / 2;
    deck.position.set((RAIL_X + XB) / 2 + 0.05, 0.006, 0);
    deck.receiveShadow = true;
    balG.add(deck);
    box(0.22, 0.05, Z1 - Z0 + 0.5, RAIL_X + 0.19, 0.025, 0, new THREE.MeshStandardMaterial({ color: srgb(0x55524e), roughness: 0.9 }));
    // 밤 도시: 하늘 → 먼 스카이라인 → 가까운 건물
    const basic = (map, opts = {}) => {
      const m = new THREE.MeshBasicMaterial({ map, ...opts });
      m.toneMapped = false;
      return m;
    };
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(30, 12), basic(skyTex()));
    sky.position.set(2, 5.6, WALL_Z + 0.06);
    const far = new THREE.Mesh(new THREE.PlaneGeometry(28, 7), basic(cityFarTex(), { transparent: true }));
    far.position.set(2, 3.0, WALL_Z + 0.1);
    const near = new THREE.Mesh(new THREE.PlaneGeometry(24, 12), basic(cityNearTex(aniso), { transparent: true }));
    near.position.set(2, 5.6, WALL_Z + 0.2);
    balG.add(sky, far, near);
    return balG;
  }

  // ── 욕조 (만취 반신욕 씬): 몸이 뒤로 기대 누울 만큼 길게 ──
  _buildTub(env) {
    const TX = 2.0, TZ = 1.0;
    const tubG = this.tubG = new THREE.Group();
    const shellGeo = new THREE.CylinderGeometry(1.02, 0.78, 0.85, 64, 1, true);
    const outer = new THREE.Mesh(shellGeo, new THREE.MeshStandardMaterial({ color: srgb(0x2f3236), roughness: 0.38,
      metalness: 0.15, envMap: env, envMapIntensity: 0.6 }));
    outer.scale.set(TX, 1, TZ);
    outer.position.y = 0.52;
    outer.castShadow = true;
    const enamel = new THREE.MeshPhysicalMaterial({ color: srgb(0xf1efe9), roughness: 0.18, clearcoat: 0.6,
      clearcoatRoughness: 0.15, envMap: env, envMapIntensity: 0.7, side: THREE.BackSide });
    const inner = new THREE.Mesh(shellGeo, enamel);
    inner.scale.set(TX * 0.965, 1, TZ * 0.965);
    inner.position.y = 0.53;
    inner.receiveShadow = true;
    const rimMat = enamel.clone();
    rimMat.side = THREE.FrontSide;
    const rimT = new THREE.Mesh(new THREE.TorusGeometry(0.99, 0.065, 14, 96), rimMat);
    rimT.rotation.x = Math.PI / 2;
    rimT.scale.set(TX, TZ, 1);
    rimT.position.y = 0.95;
    rimT.castShadow = true;
    const bottomMat = rimMat.clone();
    const tubBottom = new THREE.Mesh(new THREE.CircleGeometry(0.78 * 0.965, 48), bottomMat);
    tubBottom.rotation.x = -Math.PI / 2;
    tubBottom.scale.set(TX, TZ, 1);
    tubBottom.position.y = 0.11;
    // 황동 발: 공 + 가늘어지는 다리, 바깥으로 살짝 벌어짐
    const brass = new THREE.MeshStandardMaterial({ color: srgb(0xa07a45), metalness: 0.9, roughness: 0.35, envMap: env });
    const footProf = [[0.001, 0], [0.04, 0.008], [0.068, 0.04], [0.07, 0.07], [0.05, 0.1], [0.035, 0.13], [0.045, 0.16],
      [0.08, 0.18], [0.001, 0.18]].map(([r, y]) => new THREE.Vector2(r, y));
    const footGeo = new THREE.LatheGeometry(footProf, 18);
    for (const [fx, fz] of [[-1.18, 0.42], [1.18, 0.42], [-1.18, -0.42], [1.18, -0.42]]) {
      const f = new THREE.Mesh(footGeo, brass);
      f.position.set(fx, 0, fz);
      f.rotation.set(Math.sign(fz) * 0.22, 0, -Math.sign(fx) * 0.22);
      f.castShadow = true;
      tubG.add(f);
    }
    // 수전: 뒤쪽 테두리 위 크롬 거위목 + 십자 손잡이 두 개, 바닥 배수구
    const chrome = new THREE.MeshStandardMaterial({ color: srgb(0xdcdfe3), metalness: 1, roughness: 0.14, envMap: env, envMapIntensity: 1.2 });
    const FX = -1.2, FZ = -0.8, FY = 1.0;
    for (const dx of [-0.13, 0.13]) {
      const riser = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.16, 14), chrome);
      riser.position.set(FX + dx, FY + 0.08, FZ);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.04, 10), chrome);
      hub.position.set(FX + dx, FY + 0.18, FZ);
      tubG.add(riser, hub);
      for (const a of [0, Math.PI / 2]) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.13, 8), chrome);
        arm.rotation.set(Math.PI / 2, a, 0);
        arm.rotation.order = 'YXZ';
        arm.position.set(FX + dx, FY + 0.2, FZ);
        tubG.add(arm);
      }
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.28, 12), chrome);
    bar.rotation.z = Math.PI / 2; bar.position.set(FX, FY + 0.1, FZ);
    const spout = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      V3(FX, FY + 0.1, FZ), V3(FX, FY + 0.38, FZ - 0.01), V3(FX, FY + 0.5, FZ + 0.1),
      V3(FX, FY + 0.44, FZ + 0.24), V3(FX, FY + 0.33, FZ + 0.27)]), 40, 0.02, 10), chrome);
    const drain = new THREE.Mesh(new THREE.CircleGeometry(0.06, 20), chrome);
    drain.rotation.x = -Math.PI / 2; drain.position.set(-1.3, 0.115, 0);
    for (const m of [bar, spout]) m.castShadow = true;
    tubG.add(bar, spout, drain);
    // 물: 맑은 물 + 흐르는 잔물결
    this.waterG = new THREE.Group();
    this.rippleTex = rippleNormalTex();
    const rIn = (0.78 + 0.24 * (0.78 - 0.105) / 0.85) * 0.965;
    this.waterMesh = new THREE.Mesh(new THREE.CircleGeometry(rIn, 64),
      new THREE.MeshStandardMaterial({ color: srgb(0xbfd9de), transparent: true, opacity: 0.42, roughness: 0.04,
        metalness: 0, envMap: env, envMapIntensity: 1.1, normalMap: this.rippleTex, normalScale: new THREE.Vector2(0.35, 0.35) }));
    this.waterMesh.rotation.x = -Math.PI / 2;
    this.waterMesh.scale.set(TX, TZ, 1);
    this.waterMesh.renderOrder = 5;
    this.waterMesh.material.depthWrite = false;
    // 거품: 테두리를 따라, 몸 양옆에 모인다
    const r = rng(53), foamN = 110;
    const foam = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshStandardMaterial({ color: srgb(0xf4f4f2), roughness: 0.95 }), foamN);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = V3();
    for (let i = 0; i < foamN; i++) {
      let x, z;
      if (i < 64) {                                    // 테두리 안쪽 둘레
        const a = r() * Math.PI * 2, k = 0.86 + r() * 0.1;
        x = Math.cos(a) * rIn * TX * k; z = Math.sin(a) * rIn * TZ * k;
      } else {                                         // 몸 양옆
        x = 0.45 + (r() - 0.5) * 2.2; z = (r() < 0.5 ? -1 : 1) * (0.48 + r() * 0.3);
      }
      const e = Math.hypot(x / (rIn * TX), z / (rIn * TZ));
      if (e > 0.94) { x *= 0.94 / e; z *= 0.94 / e; }          // 물 밖(욕조 벽)으로 나가지 않게
      const s = 0.03 + r() * r() * 0.07;
      sc.set(s, s * 0.8, s);
      m4.compose(V3(x, s * 0.2, z), q, sc);
      foam.setMatrixAt(i, m4);
    }
    this.waterG.add(this.waterMesh, foam);
    this.waterG.position.y = 0.78;
    // 테두리 위 와인잔
    const tg = wineGlass(env);
    tg.scale.setScalar(0.78);
    tg.position.set(1.55, 1.012, 0.6);
    tubG.add(outer, inner, rimT, tubBottom, this.waterG, tg);
    tubG.position.set(TUB_POS, 0, 0.05);
    return tubG;
  }

  // ── TV (실험실): 화면 텍스처 = 초파리 광수용체에 들어가는 바로 그 캔버스 ──
  // 16:9 패널에 4:3 자극 화면을 좌우 검은 띠로 띄운다(필러박스). 얇은 테두리, 유리, 뒤판, 바닥 스탠드, 전원선.
  _buildTV(env) {
    const tvG = this.tvG = new THREE.Group();
    const PW = 3.2, PH = 1.8, PICW = PH * 4 / 3, BZ = 0.04, CHIN = 0.075, CY = 2.2;
    const CW = PW + 2 * BZ, CH = PH + BZ + CHIN, D = 0.055;
    const casingMat = new THREE.MeshStandardMaterial({ color: srgb(0x141518), roughness: 0.42, metalness: 0.25,
      envMap: env, envMapIntensity: 0.6 });
    const casing = new THREE.Mesh(slab(CW, CH, D, 0.035, 0.01), casingMat);
    casing.position.set(0, CY - (CHIN - BZ) / 2, 0);
    casing.castShadow = true;
    const zf = D / 2;                                     // 앞면
    // 패널(꺼진 화면·필러박스): 반사는 위 유리층이 맡는다
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH),
      new THREE.MeshStandardMaterial({ color: srgb(0x07080a), roughness: 0.6 }));
    panel.position.set(0, CY, zf + 0.0015);
    this.screenMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.screenMat.toneMapped = false;
    this.tvPic = new THREE.Mesh(new THREE.PlaneGeometry(PICW, PH), this.screenMat);
    this.tvPic.position.set(0, CY, zf + 0.003);
    this.tvPic.visible = false;
    // 유리: 옅은 사선 글레어를 더한다(가산 혼합 — 화면을 어둡게 하지 않는다).
    // 환경맵 반사는 화면 가운데 밝은 점으로 맺혀 탁구공처럼 보이므로 쓰지 않는다.
    const glare = canvasTex(256, 128, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, w, h);
      gr.addColorStop(0, 'rgba(255,255,255,0.0)'); gr.addColorStop(0.3, 'rgba(255,255,255,0.55)');
      gr.addColorStop(0.42, 'rgba(255,255,255,0.12)'); gr.addColorStop(0.62, 'rgba(255,255,255,0.0)');
      gr.addColorStop(1, 'rgba(255,255,255,0.08)');
      g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    const glassMat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: glare, opacity: 0.07,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    const glassM = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), glassMat);
    glassM.position.set(0, CY, zf + 0.0045);
    glassM.renderOrder = 2;
    // 아래 턱: 무광 로고 판 + 전원 LED
    const logo = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.016),
      new THREE.MeshStandardMaterial({ color: srgb(0x6f7176), metalness: 0.8, roughness: 0.3, envMap: env }));
    logo.position.set(0, CY - PH / 2 - CHIN / 2, zf + 0.001);
    this.ledMat = new THREE.MeshBasicMaterial({ color: srgb(0xff3b2f) });
    this.ledMat.toneMapped = false;
    const led = new THREE.Mesh(new THREE.PlaneGeometry(0.022, 0.012), this.ledMat);
    led.position.set(CW / 2 - 0.2, CY - PH / 2 - CHIN / 2, zf + 0.001);
    // 뒤판: 둥근 덮개 + 통풍 홈 + 벽걸이(VESA) 판
    const backMat = new THREE.MeshStandardMaterial({ color: srgb(0x1a1b1e), roughness: 0.55, metalness: 0.1 });
    const rear = new THREE.Mesh(slab(2.3, 1.25, 0.13, 0.12, 0.04), backMat);
    rear.position.set(0, CY - 0.08, -zf - 0.065 + 0.01);
    rear.castShadow = true;
    const zb = -zf - 0.13 + 0.01;                        // 뒤판 뒷면
    const ventMat = new THREE.MeshStandardMaterial({ color: srgb(0x0b0b0d), roughness: 0.8 });
    for (let i = 0; i < 8; i++) {
      const v = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.014, 0.008), ventMat);
      v.position.set(0, CY + 0.16 + i * 0.042, zb - 0.002);
      tvG.add(v);
    }
    const metal = new THREE.MeshStandardMaterial({ color: srgb(0x2a2b2f), metalness: 0.65, roughness: 0.38,
      envMap: env, envMapIntensity: 0.8 });
    const vesa = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.025), metal);
    vesa.position.set(0, CY - 0.12, zb - 0.012);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.12), metal);
    arm.position.set(0, CY - 0.12, zb - 0.08);
    // 스탠드: 납작한 기둥 + 둥근 받침판
    const colZ = zb - 0.165, colTop = CY + 0.18, colBot = 0.045;
    const column = new THREE.Mesh(slab(0.2, colTop - colBot, 0.07, 0.03, 0.008), metal);
    column.position.set(0, (colTop + colBot) / 2, colZ);
    column.castShadow = true;
    const base = new THREE.Mesh(slab(1.4, 0.78, 0.045, 0.16, 0.014), metal);
    base.rotation.x = -Math.PI / 2;
    base.position.set(0, 0.0225, colZ + 0.06);
    base.castShadow = true;
    base.receiveShadow = true;
    // 화면 빛이 바닥에 떨어지는 자리 (가산, 화면 밝기에 따라)
    this.tvFloorMat = new THREE.MeshBasicMaterial({ map: radialTex([[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]),
      blending: THREE.AdditiveBlending, transparent: true, opacity: 0, depthWrite: false });
    this.tvFloorMat.toneMapped = false;
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.8), this.tvFloorMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.014, 1.5);
    pool.userData.noFade = true;
    tvG.add(casing, panel, this.tvPic, glassM, logo, led, rear, vesa, arm, column, base, pool);
    tvG.position.set(TV_X, 0, -0.3);
    tvG.rotation.y = TV_ROT;                              // 초파리(시청 자리)와 카메라 쪽을 함께 향하게
    tvG.updateMatrixWorld(true);
    // 전원선: 뒤판 아래에서 기둥 뒤로 내려와 바닥을 따라 벽 콘센트까지
    const L = (x, y, z) => V3(x, y, z);
    const W = (x, y, z) => tvG.worldToLocal(V3(x, y, z));
    const pts = [L(0.45, CY - 0.62, zb + 0.02), L(0.32, CY - 0.75, zb - 0.06), L(0.16, 1.1, colZ - 0.06),
      L(0.12, 0.3, colZ - 0.07), L(0.1, 0.075, colZ - 0.16), L(0.1, 0.066, colZ - 0.3),
      L(0.12, 0.016, colZ - 0.5), L(0.2, 0.016, colZ - 0.9)];
    const wallPts = [W(3.5, 0.016, -3.6), W(4.35, 0.016, -6.4), W(OUTLET[0], 0.016, WALL_Z + 0.1),
      W(OUTLET[0], 0.2, WALL_Z + 0.05), W(OUTLET[0], OUTLET[1] - 0.12, WALL_Z + 0.05)];
    const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([...pts, ...wallPts], false, 'centripetal'), 220, 0.016, 6),
      new THREE.MeshStandardMaterial({ color: srgb(0x111214), roughness: 0.6 }));
    cable.castShadow = true;
    const plug = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.1, 0.05), new THREE.MeshStandardMaterial({ color: srgb(0x16171a), roughness: 0.5 }));
    plug.position.copy(W(OUTLET[0], OUTLET[1] - 0.055, WALL_Z + 0.04));
    plug.rotation.y = -TV_ROT;
    tvG.add(cable, plug);
    // 평균 색 샘플러 (8×6)
    const sc = document.createElement('canvas');
    sc.width = 8; sc.height = 6;
    this._sampleCtx = sc.getContext('2d', { willReadFrequently: true });
    return tvG;
  }

  // 실험실 화면 연결: canvas가 null이면 TV를 끈다. label은 시청 중 행동 이름.
  setScreen(canvas, label = 'TV 시청') {
    this.tvOn = !!canvas;
    // 행동 이름에서 그림 문자는 뺀다 (차분한 캡션)
    this.tvLabel = String(label).replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/\s+/g, ' ').trim() || 'TV 시청';
    if (!canvas) return;                                  // 화면은 update()에서 어두워진 뒤 비운다
    if (!this.screenTex || this.screenTex.image !== canvas) {
      this.screenTex = new THREE.CanvasTexture(canvas);
      this.screenTex.encoding = THREE.sRGBEncoding;
      this.screenTex.minFilter = THREE.LinearFilter;
      this.screenTex.generateMipmaps = false;
      this.screenTex.anisotropy = this.aniso;
    }
    if (this.screenMat.map !== this.screenTex) {
      this.screenMat.map = this.screenTex;
      this.screenMat.needsUpdate = true;
    }
  }

  screenUpdated() {
    if (!this.screenTex) return;
    this.screenTex.needsUpdate = true;
    // 네 번에 한 번 화면 평균색을 구해 방을 비추는 빛에 쓴다
    if ((this._tvN = (this._tvN + 1) % 4) !== 0) return;
    const g = this._sampleCtx;
    g.drawImage(this.screenTex.image, 0, 0, 8, 6);
    const d = g.getImageData(0, 0, 8, 6).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4 * 255;
    this._tvTarget.setRGB(r / n, gg / n, b / n);         // sRGB 평균
  }

  setRates(r) { Object.assign(this.rates, r); }
  setEthanol(v) { this.eth = v; }
  setNicotine(v) { this.nic = v; }

  // 소품 그룹 페이드: 다 나타나면 불투명 재질로 돌려 정렬·깊이 문제를 없앤다
  _fade(group, o) {
    group.visible = o > 0.02;
    if (!group.visible) return;
    const solid = o > 0.995;
    group.traverse(x => {
      const m = x.material;
      if (!m || x.userData.noFade) return;
      m.opacity = o * (x.userData.baseO ?? 1);
      m.transparent = !!x.userData.alwaysT || !solid;
    });
  }

  update(dt) {
    this.t += dt;
    const r = this.rates, eth = this.eth;
    const ease = (cur, target, k) => cur + (target - cur) * Math.min(1, dt * k);

    // ── 행동 결정 (fly.js와 동일 핵심 로직) ────
    const k2 = Math.min(1, dt * 2.5);
    for (const key of ['fwd', 'back', 'jump', 'prob']) {
      const raw = Math.max(0, r[key] - 2.5 * r.brain - 2);
      this.s[key] += (raw - this.s[key]) * k2;
    }
    // GF가 다른 운동 신호보다 우세할 때만 점프 — 강한 보행 명령의 부수 발화 차단
    const jumpDominant = this.s.jump > 1.15 * this.s.fwd && this.s.jump > 1.15 * this.s.back;
    const wantJump = this.s.jump > 80 && jumpDominant && this.jumpCooldown <= 0 && this.flightT <= 0 && !this.passedOut;
    const loco = Math.abs(this.s.fwd - this.s.back);
    const feeding = this.s.prob > 12 && this.s.prob > 0.55 * loco;
    const probTargetBase = Math.max(0, Math.min(1, this.s.prob / 22)) * (feeding ? 1 : 0.35);
    const speed = Math.max(-1, Math.min(1, this.s.fwd / 45 - this.s.back / 45)) * (feeding ? 0 : 1);

    if (!this.passedOut && eth > 0.85) this.passedOut = true;
    if (this.passedOut && eth < 0.7) this.passedOut = false;
    this.passT = ease(this.passT, this.passedOut ? 1 : 0, 2.2);
    const upright = 1 - this.passT;

    if (wantJump) { this.jumpT = 0; this.jumpCooldown = 0.9; }
    if (this.jumpT >= 0) {
      this.jumpT += dt;
      if (this.jumpT > 0.55) {
        // GF 자극이 계속되면 점프가 탈출 비행으로 이어진다
        this.flightT = (this.s.jump > 60 && jumpDominant) ? 2.6 : 0;
        this.jumpT = -1;
      }
    }
    this.jumpCooldown -= dt;
    if (this.flightT > 0) {
      this.flightT -= dt;
      if (this.s.jump > 60 && jumpDominant) this.flightT = Math.max(this.flightT, 0.6);
    }
    const flying = this.flightT > 0 && upright > 0.6;
    const airborne = this.jumpT >= 0 || flying;

    // 와인 홀짝: 쏟아진 와인이 있고 적당히 취했을 때 웅덩이로 걸어가 마신다
    // (0.62를 넘으면 욕조 반신욕으로 넘어간다)
    const wantSip = !this.tvOn && this.spill > 0.7 && eth > 0.45 && eth <= 0.62 && upright > 0.7 &&
                    !flying && this.jumpT < 0 && !feeding && Math.abs(speed) < 0.1;
    let sipping = false, sipWalk = 0;
    if (wantSip) {
      const dx = PUDDLE_X - 1.55 - this.x;          // 주둥이가 웅덩이에 닿는 자리
      if (Math.abs(dx) > 0.18) { sipWalk = Math.sign(dx); this.dir = Math.sign(dx) || 1; }
      else { sipping = true; this.dir = 1; }
    }
    this.sip = ease(this.sip, sipping ? 1 : 0, 3);

    // 욕조 반신욕: 만취 구간(0.62~0.85)이면 욕조로 걸어가 몸을 담근다
    const BATH_X = TUB_POS + 0.45;
    const wantBath = !this.tvOn && eth > 0.62 && upright > 0.7 && !flying && this.jumpT < 0 && !feeding;
    let bathWalk = 0, bathing = false;
    if (wantBath) {
      const dxb = BATH_X - this.x;
      if (Math.abs(dxb) > 0.15 && this.bathT < 0.3) { bathWalk = Math.sign(dxb); this.dir = Math.sign(dxb) || 1; }
      else { bathing = true; this.dir = 1; }
    }
    this.bathT = ease(this.bathT, bathing ? 1 : 0, 2);
    // TV가 켜져 있으면 욕조·발코니는 쓰지 않으므로 치워 둔다 (TV와 겹치지 않게)
    this.tubO = ease(this.tubO, (eth > 0.62 && this.passT < 0.3 && !this.tvOn) ? 1 : 0, 2);
    this._fade(this.tubG, this.tubO);
    if (this.tubG.visible) {
      this.waterG.position.y = 0.78 + Math.sin(this.t * 2.4) * 0.012;
      this.rippleTex.offset.set(this.t * 0.02, this.t * 0.013);
    }

    // 난간 흡연: 니코틴이 있으면 난간으로 걸어가 두 발로 서서 태운다 (욕조 중엔 안 함)
    const wantStand = !this.tvOn && this.nic > 0.2 && upright > 0.7 && !flying && this.jumpT < 0 &&
                      !sipping && sipWalk === 0 && !feeding && Math.abs(speed) < 0.12 &&
                      !wantBath && this.bathT < 0.2;
    let standWalk = 0, standing = false;
    if (wantStand) {
      const dxs = STAND_X - this.x;
      if (Math.abs(dxs) > 0.15 && this.standT < 0.3) { standWalk = Math.sign(dxs); this.dir = Math.sign(dxs) || 1; }
      else { standing = true; this.dir = 1; }        // 난간(오른쪽)을 본다
    }
    this.standT = ease(this.standT, standing ? 1 : 0, 2.2);
    this.balconyO = ease(this.balconyO, (this.nic > 0.2 && !this.tvOn) ? 1 : 0, 1.8);
    this._fade(this.balconyG, this.balconyO);
    // 조명 무드: 흡연 씬에서 차가운 밤 + 어두운 웜라이트
    const mood = Math.max(this.standT, this.balconyO * 0.7);
    this.hemi.intensity = 0.95 - 0.35 * mood;
    this.spotL.intensity = 1.45 - 0.7 * mood;
    this.rimL.intensity = 0.6 + 0.35 * mood;

    // TV 시청: 화면 앞 자리로 걸어가 올려다본다
    const wantWatch = this.tvOn && upright > 0.7 && !flying && this.jumpT < 0;
    let watchWalk = 0, watching = false;
    if (wantWatch) {
      const dxw = WATCH_X - this.x;
      if (Math.abs(dxw) > 0.15 && this.watchT < 0.3) { watchWalk = Math.sign(dxw); this.dir = Math.sign(dxw) || 1; }
      else { watching = true; this.dir = 1; }
    }
    this.watchT = ease(this.watchT, watching ? 1 : 0, 2.5);
    this.tvO = ease(this.tvO, this.tvOn ? 1 : 0, 3);
    this._fade(this.tvG, this.tvO);
    // 화면: 켤 때 0.35초에 걸쳐 밝아지고, 끄면 빠르게 어두워진 뒤 비운다
    this.tvPow = this.tvOn ? Math.min(1, this.tvPow + dt / 0.35) : Math.max(0, this.tvPow - dt / 0.15);
    if (!this.tvOn && this.tvPow === 0 && this.screenMat.map) {
      this.screenMat.map = null;
      this.screenMat.needsUpdate = true;
    }
    this.tvPic.visible = this.tvPow > 0.002 && !!this.screenMat.map;
    this.screenMat.color.setScalar(this.tvPow * this.tvPow);
    this.ledMat.color.copy(this.tvOn ? LED_ON : LED_OFF);
    this.tvMean.lerp(this._tvTarget, Math.min(1, dt * 10));
    const m = this.tvMean, lum = 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;   // sRGB 평균 밝기
    const pw = this.tvO * this.tvPow;
    // 빛 색: 화면 평균색의 색조(밝기는 뺀다) 반 + 차가운 화면 백색 반
    const mx = Math.max(m.r, m.g, m.b), tint = this._tint.copy(TV_WHITE);
    if (mx > 0.04) tint.lerp(this._chroma.copy(m).multiplyScalar(1 / mx).convertSRGBToLinear(), 0.5);
    this.tvLight.color.copy(tint);
    this.tvLight.intensity = pw * (0.18 + 1.05 * lum);
    this.tvFloorMat.color.copy(tint);
    this.tvFloorMat.opacity = pw * (0.015 + 0.12 * lum);

    // 그루밍: 한가할 때 가끔 앞다리를 비빈다
    const propWalk = sipWalk || standWalk || bathWalk || watchWalk;
    const idle = Math.abs(speed) <= 0.06 && propWalk === 0 && !airborne &&
                 upright > 0.9 && !feeding && !sipping && this.hicT <= 0 &&
                 this.standT < 0.2 && this.bathT < 0.2 && this.watchT < 0.2;
    if (idle && this.groomT <= 0 && Math.random() < dt * 0.12) this.groomT = 2.6;
    if (!idle) this.groomT = 0;
    if (this.groomT > 0) this.groomT -= dt;
    const grooming = this.groomT > 0;

    // 딸꾹질: 취하면 가끔 몸이 튀어오른다
    if (eth > 0.3 && upright > 0.7 && this.hicT <= 0 && Math.random() < dt * eth * 0.35)
      this.hicT = 0.4;
    if (this.hicT > 0) this.hicT -= dt;

    const probTarget = Math.max(probTargetBase, this.sip);

    // ── 소품 페이드 ───────────────────────────
    this.bedO = ease(this.bedO, this.passT > 0.12 ? 1 : 0, 2.5);
    this._fade(this.bedG, this.bedO);
    this.bottleO = ease(this.bottleO, eth > 0.03 ? 1 : 0, 3);
    this._fade(this.bottleG, this.bottleO);
    this.spill = ease(this.spill, eth > 0.55 ? 1 : 0, 1.6);
    this.bottleBody.rotation.z = this.spill * Math.PI / 2;
    this.bottleBody.position.y = this.spill * 0.172;       // 몸통 반지름만큼 들려 옆으로 눕는다
    this.puddleMesh.scale.set(Math.max(0.001, this.spill), Math.max(0.001, this.spill * 0.7), 1);

    // 전구: 아주 느린 흔들림
    this.bulbG.rotation.z = 0.008 * Math.sin(this.t * 0.6);
    this.bulbG.rotation.x = 0.005 * Math.sin(this.t * 0.43 + 1);

    // ── 이동 ─────────────────────────────────
    let vx = 0;
    if (this.jumpT < 0 && upright > 0.6 && !flying) {
      vx = (propWalk !== 0 ? propWalk * 1.3 : speed * 2.3 * this.dir) * upright *
           (1 - this.standT) * (1 - this.bathT) * (1 - this.watchT);
      if (eth > 0.1) {
        this._staggerVx += (Math.random() - 0.5) * eth * 6.5 * dt;
        this._staggerVx *= 1 - Math.min(1, dt * 2.5);
        vx += this._staggerVx;
      }
    }
    if (flying) vx = (0 - this.x) * 0.35 + Math.sin(this.t * 2.3) * 0.7;
    this.x += vx * dt;
    if (this.standT > 0.3) this.x += (STAND_X - this.x) * Math.min(1, dt * 4) * this.standT;
    if (this.bathT > 0.3) this.x += (BATH_X - this.x) * Math.min(1, dt * 4) * this.bathT;
    if (this.watchT > 0.3) this.x += (WATCH_X - this.x) * Math.min(1, dt * 4) * this.watchT;
    if (this.passT > 0.05) {
      // 베개(왼쪽 끝)에 머리를 두고 엎어진다
      this.x += (BED_POS - 0.1 - this.x) * Math.min(1, dt * 2.5) * this.passT;
      if (this.passT > 0.3) this.dir = -1;
    }
    if (this.x < -BOUND) { this.x = -BOUND; this.dir = 1; }
    if (this.x > BOUND) { this.x = BOUND; this.dir = -1; }

    // ── 보행 위상: 디딤발이 몸 속도와 같은 속도로 뒤로 밀리도록 ──
    const walking = (Math.abs(speed) > 0.06 || propWalk !== 0) && !airborne &&
                    upright > 0.6 && this.standT < 0.6 && this.bathT < 0.6 && this.watchT < 0.6;
    this.walkW = ease(this.walkW, walking ? 1 : 0, 6);
    if (walking) this.gaitP += dt * Math.max(-3, Math.min(3, (vx * this.dir) / (2 * STRIDE)));
    this.tuckW = ease(this.tuckW, airborne ? 1 : 0, 8);
    this.spreadW = ease(this.spreadW, airborne ? 1 : 0, 10);
    this.groomW = ease(this.groomW, grooming ? 1 : 0, 5);

    // ── 몸 자세 (pitch + = 코가 위로) ─────────
    let y = Y0, pitch = 0, roll = 0;
    if (this.jumpT >= 0) {
      const jt = Math.sin(this.jumpT / 0.55 * Math.PI);
      y += jt * 1.7;
      pitch += 0.26 * jt;
    }
    if (flying) {
      y += 2.0 + Math.sin(this.t * 3.7) * 0.22;
      pitch += 0.12 + Math.sin(this.t * 2.9) * 0.06;
    }
    y += Math.sin(this.t * 2.2) * 0.02 * upright;
    y += this.walkW * 0.03 * Math.abs(Math.sin(this.gaitP * Math.PI * 2));
    roll += eth * (0.14 * Math.sin(this.t * 3.1) + 0.07 * Math.sin(this.t * 5.7)) * upright * (flying ? 0.3 : 1);
    pitch += eth * 0.05 * Math.sin(this.t * 2.3) * upright;
    if (this.hicT > 0) {                            // 딸꾹: 짧은 경련
      const h = Math.sin((0.4 - this.hicT) / 0.4 * Math.PI);
      y += h * 0.28;
      pitch += h * 0.16;
    }
    pitch += this.groomW * 0.06;                    // 그루밍: 살짝 젖힘
    pitch -= this.sip * 0.28;                       // 홀짝: 웅덩이로 고개 숙임
    y -= this.sip * 0.12;
    pitch += this.standT * 0.95;                    // 난간: 두 발로 선다
    y += this.standT * (1.62 - Y0);
    pitch += this.watchT * 0.14;                    // TV: 화면을 올려다본다
    pitch += this.bathT * 0.42;                     // 욕조: 뒤로 기대 눕는다
    y += this.bathT * (0.8 - Y0);
    pitch -= this.passT * 0.04;                     // 침대: 배를 깔고 엎어짐
    roll += this.passT * 0.3;
    y += this.passT * (MATTRESS_TOP + 0.1 - Y0);
    if (this.passT > 0.3) y += Math.sin(this.t * 1.1) * 0.03;

    this.fly.position.set(this.x, y, 0);
    this.fly.rotation.set(0, this.dir > 0 ? 0 : Math.PI, 0);
    this.body.rotation.set(roll, 0, pitch);
    this.fly.updateMatrixWorld(true);

    // ── 다리: 상태별 발 목표점(월드) → IK ─────
    const toW = (lx, ly, lz) => this.body.localToWorld(V3(lx, ly, lz));
    for (const g of this.rig.legs) {
      const ph = (((this.gaitP + g.gaitOff) % 1) + 1) % 1;
      let dx, lift;
      if (ph < 0.5) { dx = STRIDE * (0.5 - 2 * ph); lift = 0; }   // 디딤
      else {                                                       // 내딛기
        const q = (ph - 0.5) * 2, sm = q * q * (3 - 2 * q);
        dx = STRIDE * (-0.5 + sm);
        lift = Math.sin(q * Math.PI) * 0.3;
      }
      dx *= this.walkW; lift *= this.walkW;
      const T = g.target.set(this.x + this.dir * (g.home.x + dx), lift, this.dir * g.home.z);
      if (this.tuckW > 0.01) T.lerp(toW(g.tuck.x, g.tuck.y, g.tuck.z), this.tuckW);
      if (g.idx === 0 && this.groomW > 0.01) {
        const rub = Math.sin(this.t * 16 + (g.side > 0 ? 0 : Math.PI));
        T.lerp(toW(1.92, 0.3 + 0.07 * rub, g.side * 0.05), this.groomW);
      }
      if (this.standT > 0.01) {
        const S = g.idx === 0 ? V3(RAIL_X - 0.02, RAIL_Y + 0.07, g.side * 0.3)
                : g.idx === 1 ? toW(0.6, -0.55, g.side * 0.85)
                : V3(STAND_X - 0.3, 0, g.side * 0.8);
        T.lerp(S, this.standT);
      }
      if (this.bathT > 0.01) {
        const B = g.idx === 0 ? V3(TUB_POS + 1.0, 0.99, 0.05 + g.side * 0.87)
                : g.idx === 1 ? V3(TUB_POS - 0.3, 0.99, 0.05 + g.side * 0.99)
                : toW(-0.2, -0.32, g.side * 0.5);
        T.lerp(B, this.bathT);
      }
      if (this.passT > 0.01) {
        const bx = this.x + this.dir * g.home.x * 1.1, bz = this.dir * g.home.z * 1.2;
        // 매트리스 밖으로 나간 다리는 가장자리 너머로 쭉 뻗는다 (발목이 매트리스 밖에 오도록)
        const off = Math.abs(bz - 0.15) - 0.96;
        const ez = off > 0 ? 0.15 + Math.sign(bz - 0.15) * 1.66 : bz;
        T.lerp(V3(bx, off > 0 ? MATTRESS_TOP - 0.1 : MATTRESS_TOP + 0.02, ez), this.passT);
      }
    }
    this.rig.update(this.body);

    // ── 날개 ─────────────────────────────────
    const flapA = (flying ? 0.85 : 0.55) * Math.sin(this.t * 58) * this.spreadW;
    const droop = this.passT * 0.6 + this.bathT * 0.45 + eth * upright * 0.12;
    const flick = walking ? Math.sin(this.t * 7) * 0.03 : 0;
    for (const w of this.wings) {
      w.yawG.rotation.y = w.sz * (0.1 + this.spreadW * 1.2 + droop * 0.6 + flick);
      w.pitchG.rotation.z = -0.07 * (1 - this.spreadW) + droop * 0.1;
      w.rollG.rotation.x = w.sz * (0.2 * (1 - this.spreadW) + droop * 0.35);
      w.flapG.rotation.x = -w.sz * (0.25 * this.spreadW + flapA);
    }
    this.model.mats.wing.opacity = 1 - 0.4 * this.spreadW * (flying ? 1 : 0.5);

    // ── 담배 + 연기 ───────────────────────────
    const cigTarget = (this.nic > 0.05 && upright > 0.7 && !airborne && !grooming) ? 1 : 0;
    this.cigO = ease(this.cigO, cigTarget, 4);
    this.cigG.visible = this.cigO > 0.05;
    this.cigG.rotation.z = -0.8 * 0.95 * this.standT;   // 서 있을 때도 담배가 하늘을 향하지 않게
    const draw = Math.max(0, Math.sin(this.t * 2.4));   // 빨아들일 때 불씨가 밝아진다
    if (this.cigG.visible) {
      this.ember.material.color.setRGB(1, 0.16 + 0.22 * draw, 0.03 + 0.05 * draw);
      this.cigLight.intensity = this.cigO * (0.35 + draw * 0.45);
    }
    if (this.cigG.visible || this.smoke.some(p => p.alive)) {
      this.cigG.updateMatrixWorld(true);
      const tip = this.cigTip.getWorldPosition(V3());
      const op = 0.17 * this.cigO * Math.max(0.5, Math.min(1, this.nic));
      for (const p of this.smoke) {
        p.age += dt / 3.2;
        if (p.age >= 1) {
          p.age -= 1;
          p.alive = this.cigG.visible;
          p.o.copy(tip);
          p.seed = Math.random() * 10;
        }
        p.sp.visible = p.alive;
        if (!p.alive) continue;
        const a = p.age;
        p.sp.position.set(
          p.o.x + Math.sin(this.t * 0.9 + p.seed * 6) * 0.18 * a + 0.12 * a,
          p.o.y + a * 1.6,
          p.o.z + Math.cos(this.t * 0.7 + p.seed * 4) * 0.12 * a);
        const s = 0.14 + a * 1.05;
        p.sp.scale.set(s, s, 1);
        p.sp.material.rotation += p.spin * dt;
        p.sp.material.opacity = Math.pow(Math.sin(Math.PI * Math.min(1, a * 1.15)), 1.3) * op;
      }
    }

    // ── 주둥이: 앞아래로 뻗는다 ────────────────
    this.prob = ease(this.prob, probTarget, 6);
    this.probG.scale.y = 0.25 + this.prob * 0.95;
    this.probG.rotation.z = 0.1 + this.prob * 0.2;
    this.probLab.scale.set(1, 1 / this.probG.scale.y, 1);

    // ── 카메라: 부드럽게 따라가는 앞쪽 3/4 시점 ──
    const camGoal = V3(this.x * 0.45, 1.15 + (flying ? 1.4 : 0) + this.standT * 0.7, 0);
    this.camT.lerp(camGoal, Math.min(1, dt * 2));
    this.cam.position.lerp(V3(this.camT.x + 3.6, this.camT.y + 2.7, 9.6), Math.min(1, dt * 2));
    this.cam.lookAt(this.camT);
    this.rend.render(this.scene, this.cam);

    // ── 행동 라벨 (그림 문자 없이) ──────────────
    this.behavior =
      this.passT > 0.5 ? '침대에 뻗음' :
      this.jumpT >= 0 ? '점프' :
      flying ? '비행' :
      this.bathT > 0.5 ? '욕조 반신욕' :
      this.watchT > 0.5 && this.prob <= 0.3 ? this.tvLabel :
      sipping || this.sip > 0.4 ? '와인 홀짝' :
      this.hicT > 0 ? '딸꾹질' :
      speed < -0.06 ? '문워크' :
      walking ? (eth > 0.25 ? '갈지자 걸음' : '걷는 중') :
      grooming ? '그루밍' :
      this.prob > 0.3 ? '먹는 중' :
      this.standT > 0.5 ? '난간에서 흡연' :
      this.nic > 0.25 ? '흡연 중' :
      eth > 0.25 ? '알딸딸' : '대기';
    return this.behavior;
  }
}
