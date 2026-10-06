// 3D 초파리 아바타 (Three.js r128, vendor/three.min.js 의 전역 THREE 사용).
// 모델은 fly-model.js(절차적 모델 + 다리 IK), 여기서는 무대·소품·행동을 담당한다.
// 행동 판정 핵심 로직은 fly.js(SVG 폴백)와 동일 + 3D 전용 액션(그루밍/비행/홀짝/딸꾹).
import { buildFlyModel, LegRig } from './fly-model.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

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
const WATCH_X = -0.95;    // TV 앞 시청 자리

function windowTexture() {
  // 밤 건물 외벽: 창문 격자, 대부분 꺼져 있고 몇 개만 따뜻하게 켜짐
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0c1430'; g.fillRect(0, 0, 512, 256);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 12; col++) {
      const lit = rnd() < 0.14;
      g.fillStyle = lit ? 'rgba(255,214,140,0.85)' : 'rgba(70,88,140,0.30)';
      g.fillRect(14 + col * 42, 14 + row * 42, 26, 30);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  return t;
}

function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  rg.addColorStop(0, 'rgba(225,232,246,0.85)');
  rg.addColorStop(1, 'rgba(225,232,246,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Fly3D {
  constructor(container) {
    if (typeof THREE === 'undefined') throw new Error('THREE 없음');
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

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b18);
    scene.fog = new THREE.Fog(0x070b18, 16, 30);
    // 앞쪽 3/4 시점: 얼굴과 옆모습이 함께 보이도록
    const cam = this.cam = new THREE.PerspectiveCamera(32, wpx / hpx, 0.1, 80);
    this.camT = V3(0, 1.15, 0);
    cam.position.set(3.6, 3.85, 9.6);
    cam.lookAt(this.camT);

    // ── 조명 ─────────────────────────────────
    this.hemi = new THREE.HemisphereLight(0x8fa0d8, 0x181226, 0.55);
    scene.add(this.hemi);
    const spot = new THREE.SpotLight(0xffd9a0, 1.3, 40, 0.62, 0.85, 1.4);
    spot.position.set(3.1, 7.2, 1.2);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0015;
    scene.add(spot, spot.target);
    spot.target.position.set(0.5, 0, 0);
    const rim = new THREE.DirectionalLight(0x8fa8ff, 0.55);
    rim.position.set(-6, 4.5, -6);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xfff0dc, 0.35);
    fill.position.set(4, 5, 10);
    scene.add(fill);
    this.spotL = spot;
    this.rimL = rim;

    // ── 방 (바닥 + 벽 + 그리드) ────────────────
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(44, 26),
      new THREE.MeshStandardMaterial({ color: 0x0d1228, roughness: 0.94 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(40, 40, 0x2c3a72, 0x1c2650);
    grid.position.y = 0.01;
    grid.material.transparent = true;
    grid.material.opacity = 0.4;
    scene.add(grid);
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(44, 16),
      new THREE.MeshStandardMaterial({ color: 0x0a0f22, roughness: 1 }));
    wall.position.set(0, 8, -7.5);
    scene.add(wall);
    const wgrid = new THREE.GridHelper(30, 30, 0x232f5e, 0x182142);
    wgrid.rotation.x = Math.PI / 2;
    wgrid.position.set(0, 7.4, -7.45);
    wgrid.material.transparent = true;
    wgrid.material.opacity = 0.22;
    scene.add(wgrid);

    // ── 전구 ─────────────────────────────────
    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.015, 2.6),
      new THREE.MeshBasicMaterial({ color: 0x9aa4bc }));
    cord.position.set(3.1, 6.9, 1.2);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe6b0 }));
    bulb.position.set(3.1, 5.55, 1.2);
    const bulbLight = new THREE.PointLight(0xffe1a0, 0.5, 7, 2);
    bulbLight.position.set(3.1, 5.4, 1.2);
    scene.add(cord, bulb, bulbLight);

    // ── 초파리: 바깥 그룹(위치·방향) → body(기울기·롤) ──
    const model = this.model = buildFlyModel(rend);
    this.fly = new THREE.Group();
    this.body = model.body;
    this.fly.add(this.body);
    scene.add(this.fly);
    this.wings = model.wings;
    this.probG = model.probG;
    this.probLab = model.probLab;
    this.rig = new LegRig(scene, model.mats);

    // 담배 + 연기 (입에 문다)
    this.cigG = new THREE.Group();
    this.cigG.position.set(1.66, 0.36, 0.1);
    this.body.add(this.cigG);
    const cigBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xf2ecdc, roughness: 0.6 }));
    cigBody.rotation.z = -1.15;
    cigBody.position.set(0.24, -0.05, 0);
    this.ember = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xff6a20 }));
    this.ember.position.set(0.52, 0.07, 0);
    this.cigLight = new THREE.PointLight(0xff9a40, 0, 2.6, 2);
    this.cigLight.position.set(0.55, 0.12, 0.1);
    this.cigG.add(cigBody, this.ember, this.cigLight);
    const ptex = puffTexture();
    this.puffs = [];
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: ptex, transparent: true, opacity: 0, depthWrite: false }));
      sp.scale.set(0.4, 0.4, 1);
      this.cigG.add(sp);
      this.puffs.push(sp);
    }

    // ── 소품: 와인병 + 잔 / 침대 ───────────────
    const mkFadeGroup = g => {
      g.traverse(o => {
        if (o.material) {
          o.material = o.material.clone();
          o.userData.baseO = o.material.opacity ?? 1;
          o.material.transparent = true;
          o.material.opacity = 0;
        }
      });
      return g;
    };
    const bottleG = this.bottleG = new THREE.Group();
    const pts = [];
    for (const [r, y] of [[0.001, 0], [0.24, 0.0], [0.25, 0.55], [0.22, 0.62], [0.1, 0.78], [0.09, 1.1], [0.11, 1.12], [0.001, 1.12]])
      pts.push(new THREE.Vector2(r, y));
    const bottleMesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 28),
      new THREE.MeshStandardMaterial({ color: 0x2f6b43, roughness: 0.25 }));
    bottleMesh.castShadow = true;
    const label = new THREE.Mesh(new THREE.CylinderGeometry(0.255, 0.255, 0.28, 28),
      new THREE.MeshStandardMaterial({ color: 0xe8e2cf, roughness: 0.7 }));
    label.position.y = 0.3;
    this.bottleBody = new THREE.Group();
    this.bottleBody.add(bottleMesh, label);
    bottleG.add(this.bottleBody);
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.09, 0.3, 16, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xdfe8fa, roughness: 0.15, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
    glass.position.set(0.55, 0.15, 0.25);
    bottleG.add(glass);
    // 웅덩이는 초파리가 걸어가 마실 수 있게 몸 바로 앞 선상(z≈0.1)에 퍼진다
    this.puddleMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 28),
      new THREE.MeshStandardMaterial({ color: 0x7c1626, roughness: 0.3 }));
    this.puddleMesh.rotation.x = -Math.PI / 2;
    this.puddleMesh.position.set(PUDDLE_X - 4.3, 0.012, -0.65);
    this.puddleMesh.scale.set(0.001, 0.001, 1);
    bottleG.add(this.puddleMesh);
    bottleG.position.set(4.3, 0, 0.75);
    scene.add(mkFadeGroup(bottleG));

    const bedG = this.bedG = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.3, 1.7),
      new THREE.MeshStandardMaterial({ color: 0x525c78, roughness: 0.8 }));
    frame.position.y = 0.35;
    const mattress = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.34, 1.6),
      new THREE.MeshStandardMaterial({ color: 0xdfe3ee, roughness: 0.9 }));
    mattress.position.y = 0.61;
    mattress.castShadow = true;
    mattress.receiveShadow = true;
    const pillow = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0xf1f3fa, roughness: 0.95 }));
    pillow.scale.set(0.52, 0.16, 0.55);
    pillow.position.set(-1.35, 0.86, 0);
    const blanket = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 1.7),
      new THREE.MeshStandardMaterial({ color: 0xe6eaf4, roughness: 0.95 }));
    blanket.position.set(1.15, 0.8, 0);
    for (const [lx, lz] of [[-1.7, 0.7], [1.7, 0.7], [-1.7, -0.7], [1.7, -0.7]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.24, 0.14),
        new THREE.MeshStandardMaterial({ color: 0x3f475c }));
      leg.position.set(lx, 0.12, lz);
      bedG.add(leg);
    }
    bedG.add(frame, mattress, pillow, blanket);
    bedG.position.set(BED_POS, 0, 0.15);
    bedG.scale.set(1.25, 1, 1.2);                     // 몸길이 4.4에 맞춘 침대
    scene.add(mkFadeGroup(bedG));

    // ── 발코니 (흡연 씬): 초파리 앞을 가로지르는 난간 + 뒤쪽 측면 난간 + 밤 건물 ──
    const balG = this.balconyG = new THREE.Group();
    const railMat = new THREE.MeshStandardMaterial({ color: 0x2e3a58, roughness: 0.45, metalness: 0.6 });
    const rod = (len, r, x, y, z, axis) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), railMat);
      if (axis === 'z') m.rotation.x = Math.PI / 2;
      if (axis === 'x') m.rotation.z = Math.PI / 2;
      m.position.set(x, y, z);
      m.castShadow = true;
      balG.add(m);
    };
    rod(3.6, 0.065, RAIL_X, RAIL_Y, 0, 'z');
    rod(3.6, 0.045, RAIL_X, 0.32, 0, 'z');
    for (let z = -1.7; z <= 1.71; z += 0.34) rod(RAIL_Y, 0.032, RAIL_X, RAIL_Y / 2, z);
    rod(3.5, 0.065, RAIL_X - 1.75, RAIL_Y, -1.8, 'x');
    rod(3.5, 0.045, RAIL_X - 1.75, 0.32, -1.8, 'x');
    for (let x = RAIL_X - 3.4; x <= RAIL_X + 0.01; x += 0.34) rod(RAIL_Y, 0.032, x, RAIL_Y / 2, -1.8);
    const building = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 12),
      new THREE.MeshBasicMaterial({ map: windowTexture() }));
    building.position.set(2, 5.6, -7.3);
    balG.add(building);
    scene.add(mkFadeGroup(balG));

    // ── 욕조 (만취 반신욕 씬): 몸이 뒤로 기대 누울 만큼 길게 ──
    const TX = 2.0, TZ = 1.0;
    const tubG = this.tubG = new THREE.Group();
    const tubMat = new THREE.MeshStandardMaterial({ color: 0xe9edf5, roughness: 0.35, side: THREE.DoubleSide });
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 0.78, 0.85, 36, 1, true), tubMat);
    shell.scale.set(TX, 1, TZ);
    shell.position.y = 0.52;
    shell.castShadow = true;
    const rimT = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.07, 12, 48), tubMat);
    rimT.rotation.x = Math.PI / 2;
    rimT.scale.set(TX, TZ, 1);
    rimT.position.y = 0.95;
    const tubBottom = new THREE.Mesh(new THREE.CircleGeometry(0.8, 36), tubMat);
    tubBottom.rotation.x = -Math.PI / 2;
    tubBottom.scale.set(TX, TZ, 1);
    tubBottom.position.y = 0.12;
    this.waterMesh = new THREE.Mesh(new THREE.CircleGeometry(0.97, 36),
      new THREE.MeshStandardMaterial({ color: 0x59b6d8, transparent: true, opacity: 0.72, roughness: 0.15 }));
    this.waterMesh.rotation.x = -Math.PI / 2;
    this.waterMesh.scale.set(TX * 0.98, TZ * 0.97, 1);
    this.waterMesh.position.y = 0.78;
    this.waterMesh.renderOrder = 5;
    this.waterMesh.material.depthWrite = false;
    for (const [fx2, fz2] of [[-1.65, 0.62], [1.65, 0.62], [-1.65, -0.62], [1.65, -0.62]]) {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), tubMat);
      foot.position.set(fx2, 0.1, fz2);
      tubG.add(foot);
    }
    const tubGlass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.075, 0.26, 14, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xdfe8fa, roughness: 0.15, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
    tubGlass.position.set(1.55, 1.08, 0.66);
    tubG.add(shell, rimT, tubBottom, this.waterMesh, tubGlass);
    tubG.position.set(TUB_POS, 0, 0.05);
    scene.add(mkFadeGroup(tubG));

    // ── TV (실험실): 화면 텍스처 = 초파리 광수용체에 들어가는 바로 그 캔버스 ──
    const tvG = this.tvG = new THREE.Group();
    const tvMat = new THREE.MeshStandardMaterial({ color: 0x1b2030, roughness: 0.4, metalness: 0.3 });
    const tvBox = new THREE.Mesh(new THREE.BoxGeometry(2.9, 2.2, 0.16), tvMat);
    tvBox.position.y = 2.15; tvBox.castShadow = true;
    const tvStand = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.05), tvMat);
    tvStand.position.y = 0.55;
    const tvBase = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.5), tvMat);
    tvBase.position.y = 0.03;
    this.screenMat = new THREE.MeshBasicMaterial({ color: 0x0a0c12 });
    this.screenMat.toneMapped = false;
    const tvScreen = new THREE.Mesh(new THREE.PlaneGeometry(2.66, 2.0), this.screenMat);
    tvScreen.position.set(0, 2.15, 0.085);
    tvG.add(tvBox, tvStand, tvBase, tvScreen);
    tvG.position.set(TV_X, 0, -0.3);
    tvG.rotation.y = -Math.PI / 2 + 0.45;               // 초파리와 카메라 쪽을 향하게
    scene.add(mkFadeGroup(tvG));
    this.tvLight = new THREE.PointLight(0xc8d8ff, 0, 7, 2);   // 화면 빛이 얼굴을 비춘다
    this.tvLight.position.set(TV_X - 0.9, 2.0, 0.2);
    scene.add(this.tvLight);
  }

  // 실험실 화면 연결: canvas가 null이면 TV를 끈다. label은 시청 중 행동 이름.
  setScreen(canvas, label = '📺 TV 보는 중') {
    this.tvOn = !!canvas;
    this.tvLabel = label;
    if (!canvas) return;
    if (!this.screenTex || this.screenTex.image !== canvas) {
      this.screenTex = new THREE.CanvasTexture(canvas);
      this.screenTex.encoding = THREE.sRGBEncoding;
      this.screenMat.map = this.screenTex;
      this.screenMat.color.set(0xffffff);
      this.screenMat.needsUpdate = true;
    }
  }

  screenUpdated() { if (this.screenTex) this.screenTex.needsUpdate = true; }

  setRates(r) { Object.assign(this.rates, r); }
  setEthanol(v) { this.eth = v; }
  setNicotine(v) { this.nic = v; }

  _fade(group, o) {
    group.visible = o > 0.02;
    group.traverse(x => { if (x.material) x.material.opacity = o * (x.userData.baseO ?? 1); });
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
    this.tubO = ease(this.tubO, (eth > 0.62 && this.passT < 0.3) ? 1 : 0, 2);
    this._fade(this.tubG, this.tubO);
    this.waterMesh.position.y = 0.78 + Math.sin(this.t * 2.4) * 0.012;

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
    this.balconyO = ease(this.balconyO, this.nic > 0.2 ? 1 : 0, 1.8);
    this._fade(this.balconyG, this.balconyO);
    // 조명 무드: 흡연 씬에서 차가운 밤 + 어두운 웜라이트
    const mood = Math.max(this.standT, this.balconyO * 0.7);
    this.hemi.intensity = 0.55 - 0.18 * mood;
    this.spotL.intensity = 1.3 - 0.65 * mood;
    this.rimL.intensity = 0.55 + 0.35 * mood;

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
    this.tvLight.intensity = this.tvO * 0.9;

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
    this.bottleBody.rotation.z = this.spill * (Math.PI / 2 + 0.06);
    this.bottleBody.position.y = this.spill * 0.24;
    this.puddleMesh.scale.set(Math.max(0.001, this.spill), Math.max(0.001, this.spill * 0.7), 1);

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
    if (this.cigG.visible) {
      this.ember.material.color.setHSL(0.05, 1, 0.45 + Math.max(0, Math.sin(this.t * 2.4)) * 0.2);
      this.cigLight.intensity = this.cigO * (0.5 + Math.max(0, Math.sin(this.t * 2.4)) * 0.55);
      this.puffs.forEach((sp, i) => {
        const ph = (this.t * 0.35 + i / 3) % 1;
        sp.position.set(0.55 + Math.sin(this.t * 1.7 + i * 2) * 0.1, 0.15 + ph * 1.5, 0);
        const sc = 0.3 + ph * 0.75;
        sp.scale.set(sc, sc, 1);
        sp.material.opacity = (1 - ph) * 0.7 * this.cigO * Math.max(0.5, this.nic);
      });
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

    // ── 행동 라벨 ────────────────────────────
    this.behavior =
      this.passT > 0.5 ? '침대에 뻗음 💫' :
      this.jumpT >= 0 ? '점프! ⚡' :
      flying ? '비행 🪽' :
      this.bathT > 0.5 ? '욕조 반신욕 🛁🍷' :
      this.watchT > 0.5 && this.prob <= 0.3 ? this.tvLabel :
      sipping || this.sip > 0.4 ? '와인 홀짝 🍷' :
      this.hicT > 0 ? '딸꾹! 🫧' :
      speed < -0.06 ? '문워크 🕺' :
      walking ? (eth > 0.25 ? '갈지자 걸음 🍺' : '걷는 중 🚶') :
      grooming ? '그루밍 🧼' :
      this.prob > 0.3 ? '냠냠 🍬' :
      this.standT > 0.5 ? '난간에서 한 대 🚬' :
      this.nic > 0.25 ? '뻐끔뻐끔 🚬' :
      eth > 0.25 ? '알딸딸 🍺' : '대기 🪰';
    return this.behavior;
  }
}
