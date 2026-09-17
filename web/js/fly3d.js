// 3D 초파리 아바타 (Three.js r128, vendor/three.min.js 의 전역 THREE 사용).
// 색·비율은 실제 매크로 사진 기준: 호박색 가슴, 복부 뒤쪽의 진한 줄무늬,
// 선명한 붉은 겹눈, 몸 뒤로 길게 뻗는 시맥 날개, 가늘고 긴 담황색 다리.
// 행동 판정 핵심 로직은 fly.js(SVG 폴백)와 동일 + 3D 전용 액션(그루밍/비행/홀짝/딸꾹).

const BOUND = 3.6;        // 걸어다닐 수 있는 x 범위
const BED_POS = -2.55;    // 침대 위치
const MATTRESS_TOP = 0.78;
const PUDDLE_X = 3.0;     // 쏟아진 와인 위치
const TUB_POS = -0.55;    // 욕조 위치

function bandTexture() {
  // 복부 텍스처. 구를 rotateZ(90°)로 눕혔으므로 몸축 방향이 v(위도)다:
  // v=1(캔버스 위쪽) = 꼬리 극. 체절 밴드는 캔버스의 가로 줄로 그려야
  // 몸통을 감는 고리가 된다. 꼬리로 갈수록 넓고 진하게 (사진처럼).
  const c = document.createElement('canvas');
  c.width = 128; c.height = 512;
  const g = c.getContext('2d');
  const base = g.createLinearGradient(0, 0, 0, 512);
  base.addColorStop(0, '#bd9459');   // 꼬리 쪽 약간 어둡게
  base.addColorStop(0.35, '#e2c48c');
  base.addColorStop(1, '#f0dcae');
  g.fillStyle = base; g.fillRect(0, 0, 128, 512);
  const bands = [[0.14, 30, 0.6], [0.26, 26, 0.55], [0.37, 20, 0.45], [0.47, 15, 0.34], [0.56, 11, 0.24]];
  for (const [vf, w, a] of bands) {
    g.fillStyle = `rgba(42,26,12,${a})`;
    g.beginPath(); g.ellipse(64, vf * 512, 96, w, 0, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;                   // 렌더러가 sRGB 출력이므로 필수
  return t;
}

function thoraxTexture() {
  // 가슴: 등쪽(v 위)은 적갈색, 배쪽은 담황색
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, '#a86f3e'); grad.addColorStop(0.42, '#c08d54');
  grad.addColorStop(0.75, '#e2ba7e'); grad.addColorStop(1, '#f0dcae');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  return t;
}

function wingTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 192;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 512, 192);
  // 막: 아주 옅은 갈색빛 투명
  g.fillStyle = 'rgba(226,222,210,0.75)';
  g.beginPath();
  g.moveTo(500, 62);
  g.bezierCurveTo(370, -14, 130, -2, 34, 48);
  g.bezierCurveTo(2, 66, 4, 106, 40, 126);
  g.bezierCurveTo(160, 188, 380, 166, 500, 106);
  g.closePath(); g.fill();
  // 시맥 (사진의 갈색 맥)
  g.strokeStyle = 'rgba(96,70,42,0.9)';
  g.lineWidth = 3;
  for (const [x1, y1, cx, cy, x2, y2] of [
    [494, 68, 300, 10, 58, 58],
    [490, 82, 300, 58, 50, 86],
    [486, 98, 320, 116, 76, 116],
    [300, 22, 296, 60, 292, 104],
    [180, 40, 176, 72, 172, 120],
  ]) { g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo(cx, cy, x2, y2); g.stroke(); }
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(96,70,42,0.7)';
  g.beginPath(); g.moveTo(500, 62); g.bezierCurveTo(370, -14, 130, -2, 34, 48); g.stroke();
  return new THREE.CanvasTexture(c);
}

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
    this.walkPhase = 0;
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
    scene.fog = new THREE.Fog(0x070b18, 14, 26);
    const cam = this.cam = new THREE.PerspectiveCamera(36, wpx / hpx, 0.1, 60);
    cam.position.set(1.1, 3.3, 13.4);
    cam.lookAt(0, 1.0, 0);

    // ── 조명 ─────────────────────────────────
    this.hemi = new THREE.HemisphereLight(0x8fa0d8, 0x181226, 0.5);
    scene.add(this.hemi);
    const spot = new THREE.SpotLight(0xffd9a0, 1.15, 40, 0.62, 0.85, 1.4);
    spot.position.set(3.1, 7.2, 1.2);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0015;
    scene.add(spot, spot.target);
    spot.target.position.set(0.5, 0, 0);
    const rim = new THREE.DirectionalLight(0x8fa8ff, 0.45);
    rim.position.set(-6, 4.5, -6);
    scene.add(rim);
    this.spotL = spot;
    this.rimL = rim;

    // ── 방 (바닥 + 벽 + 그리드) ────────────────
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 22),
      new THREE.MeshStandardMaterial({ color: 0x0d1228, roughness: 0.94 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(36, 36, 0x2c3a72, 0x1c2650);
    grid.position.y = 0.01;
    grid.material.transparent = true;
    grid.material.opacity = 0.4;
    scene.add(grid);
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 16),
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

    // ── 초파리 ────────────────────────────────
    const bodyMat = new THREE.MeshStandardMaterial({ map: bandTexture(), roughness: 0.55 });
    const thxMat = new THREE.MeshStandardMaterial({ map: thoraxTexture(), roughness: 0.5 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xd9b578, roughness: 0.55 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xd42314, roughness: 0.22 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0xcfae74, roughness: 0.6 });
    const briMat = new THREE.MeshStandardMaterial({ color: 0x2c1c0e, roughness: 0.8 });

    const fly = this.fly = new THREE.Group();
    scene.add(fly);
    const M = (geo, mat, parent) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      (parent || fly).add(m);
      return m;
    };

    // 복부: 매끈한 방추형 회전체 — 가슴 쪽에서 불룩했다가 꼬리로 뾰족해진다
    const prof = [];
    // 날렵한 유선형: 최대 반경을 줄이고 더 길게 테이퍼
    const profPts = [
      [0.02, 0], [0.4, 0.06], [0.64, 0.5], [0.78, 1.05], [0.8, 1.6],
      [0.7, 2.1], [0.53, 2.6], [0.33, 3.0], [0.15, 3.25], [0.02, 3.4],
    ];
    for (const [r, y] of profPts) prof.push(new THREE.Vector2(r, y));
    const abdGeo = new THREE.LatheGeometry(prof, 40);
    abdGeo.translate(0, -3.4, 0);                    // 끝(꼬리)을 원점 기준으로
    abdGeo.rotateZ(-Math.PI / 2);                    // +X가 머리 방향, 밴드는 v 방향
    this.abd = M(abdGeo, bodyMat);
    this.abd.scale.set(1.06, 0.85, 0.72);
    this.abd.position.set(0.34, 0.36, 0);            // 앞끝을 가슴 속에 파묻는다
    this.abd.rotation.z = -0.12;                     // 꼬리가 살짝 내려가게

    this.thx = M(new THREE.SphereGeometry(0.8, 40, 28), thxMat);
    this.thx.scale.set(1.0, 0.95, 0.8);
    this.thx.position.set(0.45, 0.4, 0);
    // 소순판(scutellum): 가슴 뒤쪽의 작은 혹
    const scu = M(new THREE.SphereGeometry(0.3, 20, 14), thxMat);
    scu.scale.set(1.1, 0.7, 0.9);
    scu.position.set(-0.2, 0.82, 0);

    this.head = M(new THREE.SphereGeometry(0.5, 32, 24), headMat);
    this.head.scale.set(0.78, 0.98, 0.85);
    this.head.position.set(1.46, 0.42, 0);

    for (const sz of [-1, 1]) {
      // 겹눈: 머리 옆면을 거의 다 덮는 큰 타원 (사진처럼)
      const eye = M(new THREE.SphereGeometry(0.42, 32, 24), eyeMat);
      eye.scale.set(0.72, 1.05, 0.78);
      eye.position.set(1.62, 0.42, sz * 0.26);
      eye.rotation.y = sz * 0.35;
      // 더듬이 + 아리스타(깃털털)
      const ant = M(new THREE.CylinderGeometry(0.016, 0.026, 0.22), legMat);
      ant.position.set(1.85, 0.5, sz * 0.1);
      ant.rotation.z = -0.7;
      const ari = M(new THREE.CylinderGeometry(0.005, 0.011, 0.2), briMat);
      ari.position.set(1.97, 0.58, sz * 0.11);
      ari.rotation.z = -1.05;
      // 작은 구기 촉수(palp)
      const palp = M(new THREE.CylinderGeometry(0.03, 0.045, 0.16), headMat);
      palp.position.set(1.72, 0.05, sz * 0.09);
      palp.rotation.z = 0.5;
    }

    // 가슴·머리 강모 (사진의 뻣뻣한 털)
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI - Math.PI / 2;
      const b = M(new THREE.CylinderGeometry(0.006, 0.014, 0.34), briMat);
      const px = 0.38 + Math.cos(a) * 0.55 + (Math.random() - 0.5) * 0.5;
      const pz = Math.sin(a) * 0.55 * (Math.random() > 0.5 ? 1 : -1) * 0.6;
      b.position.set(px, 1.18 + Math.random() * 0.1, pz);
      b.rotation.z = 0.5 + Math.random() * 0.5;      // 뒤로 눕게
      b.rotation.x = pz * 0.8;
    }

    // 주둥이 (위 끝을 피벗으로 아래로 뻗는다)
    this.probG = new THREE.Group();
    this.probG.position.set(1.68, -0.1, 0);
    fly.add(this.probG);
    const probGeo = new THREE.CylinderGeometry(0.085, 0.115, 1);
    probGeo.translate(0, -0.5, 0);
    this.probMesh = new THREE.Mesh(probGeo, headMat);
    this.probMesh.castShadow = true;
    this.probG.add(this.probMesh);
    const lab = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0xcaa268, roughness: 0.6 }));
    lab.position.y = -1;
    this.probMesh.add(lab);
    this.probLab = lab;

    // 날개: 실제 윤곽의 ShapeGeometry + 시맥 라인 — 복부 끝을 넘어 길게 접힌다
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0.05, 0.1);
    wingShape.bezierCurveTo(-1.3, 0.62, -2.9, 0.66, -3.6, 0.3);
    wingShape.bezierCurveTo(-3.95, 0.1, -3.95, -0.1, -3.6, -0.26);
    wingShape.bezierCurveTo(-2.7, -0.6, -1.1, -0.5, 0.05, -0.14);
    wingShape.closePath();
    const wingGeo = new THREE.ShapeGeometry(wingShape, 24);
    const veinPts = [
      [[0, 0.06], [-1.6, 0.42], [-3.4, 0.22]],
      [[0, 0.0], [-1.7, 0.12], [-3.65, 0.0]],
      [[0, -0.08], [-1.5, -0.3], [-3.2, -0.22]],
      [[-1.15, 0.5], [-1.18, 0.05], [-1.2, -0.4]],
      [[-2.2, 0.45], [-2.24, 0.05], [-2.28, -0.35]],
    ];
    const wtex = wingTexture(); void wtex;           // (텍스처 대신 라인 시맥 사용)
    this.wings = [];
    for (const sz of [-1, 1]) {
      const hinge = new THREE.Group();
      hinge.position.set(0.5, 1.18, sz * 0.2);       // 복부 위로 띄워 파묻힘 방지
      fly.add(hinge);
      const wmat = new THREE.MeshStandardMaterial({
        color: 0xdfe6f2, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
        depthWrite: false, roughness: 0.25,
      });
      const w = new THREE.Mesh(wingGeo, wmat);
      w.rotation.x = -Math.PI / 2 + 0.44;            // 등 위에 살짝 세워 카메라에 보이게
      hinge.add(w);
      // 시맥
      const vmat = new THREE.LineBasicMaterial({ color: 0x6b543a, transparent: true, opacity: 0.65 });
      for (const [a, b, c2] of veinPts) {
        const curve = new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(a[0], a[1], 0.002),
          new THREE.Vector3(b[0], b[1], 0.002),
          new THREE.Vector3(c2[0], c2[1], 0.002));
        const vg = new THREE.BufferGeometry().setFromPoints(curve.getPoints(20));
        w.add(new THREE.Line(vg, vmat));
      }
      hinge.rotation.y = sz * 0.17;
      this.wings.push({ hinge, sz });
    }

    // 다리 6개: femur→tibia→tarsus 관절 체인 (가늘고 길게)
    this.legs = [];
    const mkSeg = (parent, r1, r2, len, mat) => {
      const g = new THREE.Group();
      parent.add(g);
      const geo = new THREE.CylinderGeometry(r1, r2, len);
      geo.translate(0, -len / 2, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      g.add(mesh);
      const tip = new THREE.Group();
      tip.position.y = -len;
      g.add(tip);
      return [g, tip];
    };
    const hipDefs = [
      [1.05, -0.28, 0.42], [0.4, -0.4, 0.5], [-0.32, -0.36, 0.48],
      [1.05, -0.28, -0.42], [0.4, -0.4, -0.5], [-0.32, -0.36, -0.48],
    ];
    hipDefs.forEach((hd, i) => {
      const hip = new THREE.Group();
      hip.position.set(hd[0], hd[1], hd[2]);
      fly.add(hip);
      const [femur, kneeAt] = mkSeg(hip, 0.042, 0.034, 0.7, legMat);
      const [tibia, ankleAt] = mkSeg(kneeAt, 0.03, 0.02, 0.95, legMat);
      const [tarsus] = mkSeg(ankleAt, 0.016, 0.009, 0.72, legMat);
      this.legs.push({
        hip, femur, tibia, tarsus,
        side: Math.sign(hd[2]),
        idx: i % 3,                       // 0 앞 / 1 중간 / 2 뒤
        phase: (i % 3) * 2.1 + (i >= 3 ? Math.PI : 0),
        front: i % 3 === 0,
      });
    });

    // 담배 + 연기
    this.cigG = new THREE.Group();
    this.cigG.position.set(1.95, 0.04, 0.18);
    fly.add(this.cigG);
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
    this.puddleMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 28),
      new THREE.MeshStandardMaterial({ color: 0x7c1626, roughness: 0.3 }));
    this.puddleMesh.rotation.x = -Math.PI / 2;
    this.puddleMesh.position.set(PUDDLE_X - 3.35, 0.012, 0.25);
    this.puddleMesh.scale.set(0.001, 0.001, 1);
    bottleG.add(this.puddleMesh);
    bottleG.position.set(3.35, 0, 0.6);
    scene.add(mkFadeGroup(bottleG));

    const bedG = this.bedG = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.3, 1.7),
      new THREE.MeshStandardMaterial({ color: 0x525c78, roughness: 0.8 }));
    frame.position.y = 0.35;
    const mattress = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.34, 1.6),
      new THREE.MeshStandardMaterial({ color: 0xdfe3ee, roughness: 0.9 }));
    mattress.position.y = 0.61;
    mattress.castShadow = true;
    const pillow = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0xf1f3fa, roughness: 0.95 }));
    pillow.scale.set(0.52, 0.16, 0.55);
    pillow.position.set(-1.35, 0.86, 0);
    const blanket = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 1.7),
      new THREE.MeshStandardMaterial({ color: 0xe6eaf4, roughness: 0.95 }));
    blanket.position.set(0.6, 0.82, 0);
    blanket.rotation.z = 0.05;
    for (const [lx, lz] of [[-1.7, 0.7], [1.7, 0.7], [-1.7, -0.7], [1.7, -0.7]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.24, 0.14),
        new THREE.MeshStandardMaterial({ color: 0x3f475c }));
      leg.position.set(lx, 0.12, lz);
      bedG.add(leg);
    }
    bedG.add(frame, mattress, pillow, blanket);
    bedG.position.set(BED_POS, 0, 0.15);
    scene.add(mkFadeGroup(bedG));

    // ── 발코니 (흡연 씬): 난간 + 밤 건물 배경 ──
    const balG = this.balconyG = new THREE.Group();
    const railMat = new THREE.MeshStandardMaterial({ color: 0x2e3a58, roughness: 0.5, metalness: 0.5 });
    const topRail = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 2.8, 12), railMat);
    topRail.rotation.z = Math.PI / 2;
    topRail.position.set(2.3, 1.34, 0.3);
    topRail.castShadow = true;
    balG.add(topRail);
    const midRail = topRail.clone();
    midRail.position.y = 0.72;
    midRail.scale.set(0.7, 1, 0.7);
    balG.add(midRail);
    for (let i = 0; i < 6; i++) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.34, 10), railMat);
      bar.position.set(1.05 + i * 0.5, 0.67, 0.3);
      bar.castShadow = true;
      balG.add(bar);
    }
    const building = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 12),
      new THREE.MeshBasicMaterial({ map: windowTexture() }));
    building.position.set(2, 5.6, -7.3);
    balG.add(building);
    scene.add(mkFadeGroup(balG));

    // ── 욕조 (만취 반신욕 씬) ──────────────────
    const tubG = this.tubG = new THREE.Group();
    const tubMat = new THREE.MeshStandardMaterial({ color: 0xe9edf5, roughness: 0.35, side: THREE.DoubleSide });
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 0.78, 0.85, 28, 1, true), tubMat);
    shell.scale.set(1.55, 1, 0.85);
    shell.position.y = 0.52;
    shell.castShadow = true;
    const rimT = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.085, 12, 36), tubMat);
    rimT.rotation.x = Math.PI / 2;
    rimT.scale.set(1.55, 0.85, 1);
    rimT.position.y = 0.95;
    const tubBottom = new THREE.Mesh(new THREE.CircleGeometry(0.8, 28), tubMat);
    tubBottom.rotation.x = -Math.PI / 2;
    tubBottom.scale.set(1.55, 0.85, 1);
    tubBottom.position.y = 0.12;
    this.waterMesh = new THREE.Mesh(new THREE.CircleGeometry(0.97, 28),
      new THREE.MeshStandardMaterial({ color: 0x59b6d8, transparent: true, opacity: 0.72, roughness: 0.15 }));
    this.waterMesh.rotation.x = -Math.PI / 2;
    this.waterMesh.scale.set(1.5, 0.8, 1);
    this.waterMesh.position.y = 0.78;
    this.waterMesh.renderOrder = 5;
    this.waterMesh.material.depthWrite = false;
    for (const [fx2, fz2] of [[-1.25, 0.55], [1.25, 0.55], [-1.25, -0.55], [1.25, -0.55]]) {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), tubMat);
      foot.position.set(fx2, 0.1, fz2);
      tubG.add(foot);
    }
    const tubGlass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.075, 0.26, 14, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xdfe8fa, roughness: 0.15, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
    tubGlass.position.set(1.15, 1.08, 0.45);
    tubG.add(shell, rimT, tubBottom, this.waterMesh, tubGlass);
    tubG.position.set(TUB_POS, 0, 0.05);
    scene.add(mkFadeGroup(tubG));
  }

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
    let speed = Math.max(-1, Math.min(1, this.s.fwd / 45 - this.s.back / 45)) * (feeding ? 0 : 1);

    if (!this.passedOut && eth > 0.85) this.passedOut = true;
    if (this.passedOut && eth < 0.7) this.passedOut = false;
    this.passT += ((this.passedOut ? 1 : 0) - this.passT) * Math.min(1, dt * 2.2);
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

    // 와인 홀짝: 쏟아진 와인이 있고 적당히 취했을 때 웅덩이로 걸어가 마신다
    // (0.62를 넘으면 욕조 반신욕으로 넘어간다)
    const wantSip = this.spill > 0.7 && eth > 0.45 && eth <= 0.62 && upright > 0.7 &&
                    !flying && this.jumpT < 0 && !feeding && Math.abs(speed) < 0.1;
    let sipping = false, sipWalk = 0;
    if (wantSip) {
      const dx = PUDDLE_X - 0.9 - this.x;           // 웅덩이 앞에 선다
      if (Math.abs(dx) > 0.18) { sipWalk = Math.sign(dx); this.dir = Math.sign(dx) || 1; }
      else sipping = true;
    }
    this.sip += ((sipping ? 1 : 0) - this.sip) * Math.min(1, dt * 3);

    // 욕조 반신욕: 만취 구간(0.62~0.85)이면 욕조로 걸어가 몸을 담근다
    const wantBath = eth > 0.62 && upright > 0.7 && !flying && this.jumpT < 0 && !feeding;
    let bathWalk = 0, bathing = false;
    if (wantBath) {
      const dxb = TUB_POS - this.x;
      if (Math.abs(dxb) > 0.15 && this.bathT < 0.3) { bathWalk = Math.sign(dxb); this.dir = Math.sign(dxb) || 1; }
      else { bathing = true; this.dir = 1; }
    }
    this.bathT += ((bathing ? 1 : 0) - this.bathT) * Math.min(1, dt * 2);
    this.tubO += (((eth > 0.62 && this.passT < 0.3) ? 1 : 0) - this.tubO) * Math.min(1, dt * 2);
    this._fade(this.tubG, this.tubO);
    this.waterMesh.position.y = 0.78 + Math.sin(this.t * 2.4) * 0.012;

    // 난간 흡연: 니코틴이 있으면 난간으로 걸어가 두 발로 서서 태운다 (욕조 중엔 안 함)
    const STAND_X = 0.62;
    const wantStand = this.nic > 0.2 && upright > 0.7 && !flying && this.jumpT < 0 &&
                      !sipping && sipWalk === 0 && !feeding && Math.abs(speed) < 0.12 &&
                      !wantBath && this.bathT < 0.2;
    let standWalk = 0, standing = false;
    if (wantStand) {
      const dxs = STAND_X - this.x;
      if (Math.abs(dxs) > 0.15 && this.standT < 0.3) { standWalk = Math.sign(dxs); this.dir = Math.sign(dxs) || 1; }
      else { standing = true; this.dir = 1; }        // 난간(오른쪽)을 본다
    }
    this.standT += ((standing ? 1 : 0) - this.standT) * Math.min(1, dt * 2.2);
    this.balconyO += ((this.nic > 0.2 ? 1 : 0) - this.balconyO) * Math.min(1, dt * 1.8);
    this._fade(this.balconyG, this.balconyO);
    // 조명 무드: 흡연 씬에서 차가운 밤 + 어두운 웜라이트
    const mood = Math.max(this.standT, this.balconyO * 0.7);
    this.hemi.intensity = 0.5 - 0.17 * mood;
    this.spotL.intensity = 1.15 - 0.6 * mood;
    this.rimL.intensity = 0.45 + 0.32 * mood;

    // 그루밍: 한가할 때 가끔 앞다리를 비빈다
    const idle = !walkingLikely(speed, sipWalk) && !flying && this.jumpT < 0 &&
                 upright > 0.9 && !feeding && !sipping && this.hicT <= 0 &&
                 this.standT < 0.2 && this.bathT < 0.2;
    function walkingLikely(sp, sw) { return Math.abs(sp) > 0.06 || sw !== 0; }
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
    this.bedO += ((this.passT > 0.12 ? 1 : 0) - this.bedO) * Math.min(1, dt * 2.5);
    this._fade(this.bedG, this.bedO);
    this.bottleO += ((eth > 0.03 ? 1 : 0) - this.bottleO) * Math.min(1, dt * 3);
    this._fade(this.bottleG, this.bottleO);
    this.spill += ((eth > 0.55 ? 1 : 0) - this.spill) * Math.min(1, dt * 1.6);
    this.bottleBody.rotation.z = this.spill * (Math.PI / 2 + 0.06);
    this.bottleBody.position.y = this.spill * 0.24;
    this.puddleMesh.scale.set(Math.max(0.001, this.spill), Math.max(0.001, this.spill * 0.7), 1);

    // ── 이동 ─────────────────────────────────
    let vx = 0;
    if (this.jumpT < 0 && upright > 0.6 && !flying) {
      const propWalk = sipWalk || standWalk || bathWalk;
      vx = (propWalk !== 0 ? propWalk * 1.3 : speed * 2.3 * this.dir) * upright *
           (1 - this.standT) * (1 - this.bathT);
      if (eth > 0.1) {
        this._staggerVx += (Math.random() - 0.5) * eth * 6.5 * dt;
        this._staggerVx *= 1 - Math.min(1, dt * 2.5);
        vx += this._staggerVx;
      }
    }
    if (flying) vx = (0 - this.x) * 0.35 + Math.sin(this.t * 2.3) * 0.7;
    this.x += vx * dt;
    if (this.standT > 0.3) this.x += (STAND_X - this.x) * Math.min(1, dt * 4) * this.standT;
    if (this.bathT > 0.3) this.x += (TUB_POS - this.x) * Math.min(1, dt * 4) * this.bathT;
    if (this.passT > 0.05) this.x += (BED_POS - this.x) * Math.min(1, dt * 2.5) * this.passT;
    if (this.x < -BOUND) { this.x = -BOUND; this.dir = 1; }
    if (this.x > BOUND) { this.x = BOUND; this.dir = -1; }

    // ── 자세 ─────────────────────────────────
    const walking = (Math.abs(speed) > 0.06 || sipWalk !== 0 || standWalk !== 0 || bathWalk !== 0) &&
                    this.jumpT < 0 && upright > 0.6 && !flying &&
                    this.standT < 0.6 && this.bathT < 0.6;
    this.walkPhase += dt * (walking ? 10 + 14 * Math.max(Math.abs(speed), 0.5) : 1.2);

    let y = 1.18;
    let rotZ = 0;
    if (this.jumpT >= 0) {
      const jt = this.jumpT / 0.55;
      y += Math.sin(jt * Math.PI) * 1.7;
      rotZ = 0.26 * Math.sin(jt * Math.PI);
    }
    if (flying) {
      y += 1.9 + Math.sin(this.t * 3.7) * 0.22;
      rotZ = 0.12 + Math.sin(this.t * 2.9) * 0.06;
    }
    y += Math.sin(this.t * 2.2) * 0.035 * upright;
    rotZ += eth * (0.17 * Math.sin(this.t * 3.1) + 0.09 * Math.sin(this.t * 5.7)) * upright * (flying ? 0.3 : 1);
    if (this.hicT > 0) {                            // 딸꾹: 짧은 경련
      const h = Math.sin((0.4 - this.hicT) / 0.4 * Math.PI);
      y += h * 0.28;
      rotZ -= h * 0.14;
    }
    if (grooming) rotZ += 0.1;                      // 그루밍: 앞으로 숙임
    if (this.sip > 0.05) rotZ += this.sip * 0.22;   // 홀짝: 웅덩이로 숙임
    rotZ += this.standT * 0.88;                     // 난간: 두 발로 선다 (코 위로)
    y += this.standT * 0.95;
    rotZ += this.bathT * 0.62;                      // 욕조: 뒤로 기대 반신욕
    y -= this.bathT * 0.34;
    rotZ += this.passT * 0.35;
    y += this.passT * (MATTRESS_TOP + 0.62 - 1.18);
    if (this.passT > 0.3) y += Math.sin(this.t * 1.1) * 0.045;

    this.fly.position.set(this.x, y, 0);
    this.fly.rotation.set(0, this.dir > 0 ? 0 : Math.PI, rotZ * this.dir);

    // ── 다리 ─────────────────────────────────
    for (const leg of this.legs) {
      let swing, femurDown, knee, splay;
      if (this.passT > 0.5) {                       // 축 늘어짐
        swing = 0.5; femurDown = 1.9; knee = -0.35; splay = 0.85;
      } else if (this.jumpT >= 0 || flying) {       // 접기
        swing = -0.4; femurDown = 0.7; knee = -2.1; splay = 0.35;
      } else if (this.bathT > 0.5) {                // 욕조: 앞다리는 테두리에, 나머진 물속
        const st = [[0.95, 0.35, -0.5], [0.3, 0.8, -1.9], [-0.3, 0.9, -2.0]][leg.idx];
        swing = st[0]; femurDown = st[1]; knee = st[2]; splay = 0.3;
      } else if (this.standT > 0.5) {               // 난간에 기대 섬
        // 몸이 0.88rad 젖혀지므로 다리 각도는 그만큼 되돌린다.
        // 앞다리: 난간 위에 걸침 / 중간: 몸 옆에 늘어짐 / 뒷다리: 바닥 지탱
        const st = [[0.85, 0.5, -0.7], [-0.1, 0.75, -0.55], [-1.5, 0.3, -0.3]][leg.idx];
        swing = st[0] + Math.sin(this.t * 1.4 + leg.phase) * 0.03;
        femurDown = st[1]; knee = st[2]; splay = 0.22;
      } else if (grooming && leg.front) {           // 앞다리 비비기
        const rub = Math.sin(this.t * 16 + (leg.side > 0 ? 0 : Math.PI)) * 0.35;
        swing = 1.15 + rub * 0.3; femurDown = 0.35; knee = -2.3 + rub; splay = 0.15;
      } else {
        // 기본 스탠스는 사진처럼: 앞다리는 앞으로 뻗고, 뒷다리는 뒤로 밀려남
        const ph = walking ? Math.sin(this.walkPhase + leg.phase)
                           : Math.sin(this.t * 1.2 + leg.phase) * 0.1;
        const lift = walking ? Math.max(0, Math.cos(this.walkPhase + leg.phase)) : 0;
        const baseSwing = [0.55, -0.05, -0.55][leg.idx];
        const baseDown = [0.38, 0.6, 0.8][leg.idx];
        const baseKnee = [-1.75, -1.5, -1.05][leg.idx];
        swing = ph * 0.45 + baseSwing;
        femurDown = baseDown - lift * 0.3;
        knee = baseKnee + lift * 0.45;
        splay = 0.34;
      }
      const p = this.passT;
      leg.hip.rotation.set(leg.side * splay, 0, swing);
      leg.femur.rotation.z = femurDown * (1 - p * 0.4);
      leg.tibia.rotation.z = knee;
      leg.tarsus.rotation.z = -knee * 0.55 - femurDown * (1 - p * 0.4) - swing + 0.15;
    }

    // ── 날개 ─────────────────────────────────
    const flutter = (this.jumpT >= 0 || flying) ? 1 : (walking ? 0.12 : 0.025);
    const wa = Math.sin(this.t * 80) * (flying ? 0.9 : 0.5) * flutter;
    const droop = this.passT * 0.55 + eth * upright * 0.08 + this.bathT * 0.4;
    for (const { hinge, sz } of this.wings) {
      hinge.rotation.y = sz * (0.17 + droop * 0.6) + wa * sz;
      hinge.rotation.z = wa * 0.4 - droop * 0.25 + (flying ? 0.35 : 0);
    }

    // ── 담배 + 연기 ───────────────────────────
    const cigTarget = (this.nic > 0.05 && upright > 0.7 && this.jumpT < 0 && !flying && !grooming) ? 1 : 0;
    this.cigO += (cigTarget - this.cigO) * Math.min(1, dt * 4);
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

    // ── 주둥이 ────────────────────────────────
    this.prob += (probTarget - this.prob) * Math.min(1, dt * 6);
    this.probG.scale.y = 0.25 + this.prob * 0.95;
    this.probG.rotation.z = -0.15 - this.prob * 0.25;
    this.probLab.scale.setScalar(Math.min(1.4, 1 / Math.max(0.4, this.probG.scale.y)));

    // ── 카메라 미세 추적 + 렌더 ────────────────
    const camY = flying ? 3.9 : 3.3;
    this.cam.position.x += (this.x * 0.16 + 1.0 - this.cam.position.x) * Math.min(1, dt * 1.5);
    this.cam.position.y += (camY - this.cam.position.y) * Math.min(1, dt * 1.5);
    this.cam.lookAt(this.x * 0.35, flying ? 2.0 : 1.0, 0);
    this.rend.render(this.scene, this.cam);

    // ── 행동 라벨 ────────────────────────────
    this.behavior =
      this.passT > 0.5 ? '침대에 뻗음 💫' :
      this.jumpT >= 0 ? '점프! ⚡' :
      flying ? '비행 🪽' :
      this.bathT > 0.5 ? '욕조 반신욕 🛁🍷' :
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
