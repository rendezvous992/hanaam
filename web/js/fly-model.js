// 절차적 초파리 3D 모델 (Three.js r128 전역 THREE).
// 비율은 Drosophila melanogaster 암컷 기준 — 머리:가슴:배 길이 ≈ 0.6 : 1.4 : 2.2,
// 날개는 배 끝을 넘는다. 좌표: +x 머리, +y 등, ±z 좌우, 원점은 가슴 아래.
// 다리는 몸에 붙이지 않고 월드 공간에서 매 프레임 2관절 IK로 배치한다(LegRig).

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V3(0, 1, 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// r128은 재질 색 hex를 선형 값으로 읽는다 — sRGB 출력에서 의도한 색이 나오도록 변환
const srgb = hex => new THREE.Color(hex).convertSRGBToLinear();

let seed = 20261006;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.encoding = THREE.sRGBEncoding;
  t.anisotropy = 4;
  return t;
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function abdomenTexture() {
  // 회전체 UV: u는 둘레(0.75 = 등 정중앙), v는 몸축(0 = 꼬리 끝, 1 = 가슴 쪽).
  // 등판 뒤쪽 가장자리마다 진갈색 띠(배판)가 있고 꼬리로 갈수록 넓고 진하다.
  return canvasTexture(512, 512, (g, w, h) => {
    const ventral = [224, 196, 146], dorsal = [190, 138, 70];
    for (let x = 0; x < w; x++) {
      const dors = Math.max(0, Math.cos((x / w - 0.75) * Math.PI * 2));
      const c = mix(ventral, dorsal, Math.pow(dors, 0.6));
      g.fillStyle = `rgb(${c})`;
      g.fillRect(x, 0, 1, h);
      const bands = [[0.08, 0.07, 0.95], [0.2, 0.065, 0.9], [0.34, 0.06, 0.85],
                     [0.48, 0.05, 0.75], [0.62, 0.04, 0.6], [0.76, 0.03, 0.4]];
      for (const [v, bw, a] of bands) {
        const alpha = a * Math.pow(dors, 0.45);
        if (alpha < 0.02) continue;
        g.fillStyle = `rgba(52,30,14,${alpha})`;
        g.fillRect(x, (1 - v - bw) * h, 1, bw * h * 1.15);
      }
    }
    // 미세 털(미세강모) 점묘
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * w, y = rnd() * h;
      const dors = Math.max(0, Math.cos((x / w - 0.75) * Math.PI * 2));
      g.fillStyle = `rgba(60,38,18,${0.08 + dors * 0.18})`;
      g.fillRect(x, y, 1.5, 1.5);
    }
  });
}

function thoraxTextures() {
  // 구 UV: 캔버스 위쪽이 등. 등은 짙은 호박색, 옆·배 쪽으로 밝아진다.
  const draw = (g, w, h, bumpOnly) => {
    if (bumpOnly) { g.fillStyle = '#808080'; g.fillRect(0, 0, w, h); }
    else {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#7a4018'); grad.addColorStop(0.35, '#985624');
      grad.addColorStop(0.62, '#b7783a'); grad.addColorStop(1, '#d8b077');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
    }
    seed = 777;
    for (let i = 0; i < 2200; i++) {
      const x = rnd() * w, y = Math.pow(rnd(), 1.4) * h * 0.75;
      g.fillStyle = bumpOnly ? `rgba(255,255,255,0.35)` : `rgba(60,30,10,${0.05 + rnd() * 0.09})`;
      g.beginPath(); g.arc(x, y, 0.6 + rnd() * 0.5, 0, Math.PI * 2); g.fill();
    }
  };
  return {
    map: canvasTexture(512, 256, (g, w, h) => draw(g, w, h, false)),
    bump: canvasTexture(512, 256, (g, w, h) => draw(g, w, h, true), false),
  };
}

function eyeTextures() {
  // 겹눈: 육각 낱눈 격자 범프 + 중심이 밝은 진홍색
  const bump = canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    const s = 10;
    for (let row = 0; row * s * 0.866 < h + s; row++) {
      for (let col = 0; col * s < w + s; col++) {
        const cx = col * s + (row % 2) * s / 2, cy = row * s * 0.866;
        const rg = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.55);
        rg.addColorStop(0, '#fff'); rg.addColorStop(0.8, '#555'); rg.addColorStop(1, '#000');
        g.fillStyle = rg;
        g.beginPath(); g.arc(cx, cy, s * 0.55, 0, Math.PI * 2); g.fill();
      }
    }
  }, false);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.repeat.set(3, 2);
  const map = canvasTexture(64, 256, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#e2341c'); grad.addColorStop(0.45, '#b81c10');
    grad.addColorStop(1, '#5e0a06');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  });
  return { map, bump };
}

function wingTexture() {
  // 날개 평면 UV: u=1 날개 뿌리, u=0 날개 끝 / 캔버스 위쪽 = 앞 가장자리(costa).
  // 좌표는 [u(끝→뿌리), v(앞→뒤)] 정규화 값으로 적어 캔버스에 매핑한다.
  return canvasTexture(1024, 512, (g, w, h) => {
    const P = (u, v) => [u * w, v * h];
    const path = () => {
      g.beginPath();
      g.moveTo(...P(0.985, 0.43));
      g.bezierCurveTo(...P(0.86, 0.2), ...P(0.6, 0.1), ...P(0.3, 0.12));
      g.bezierCurveTo(...P(0.12, 0.14), ...P(0.01, 0.3), ...P(0.015, 0.5));
      g.bezierCurveTo(...P(0.02, 0.72), ...P(0.15, 0.9), ...P(0.38, 0.92));
      g.bezierCurveTo(...P(0.62, 0.94), ...P(0.85, 0.78), ...P(0.95, 0.62));
      g.bezierCurveTo(...P(0.97, 0.56), ...P(0.98, 0.5), ...P(0.985, 0.43));
      g.closePath();
    };
    g.clearRect(0, 0, w, h);
    g.save();
    path(); g.clip();
    g.fillStyle = 'rgba(226,232,244,0.22)';
    g.fillRect(0, 0, w, h);
    // 박막 간섭 무지개빛
    const ir = g.createLinearGradient(0, 0, w, h);
    ir.addColorStop(0, 'rgba(255,120,200,0.12)'); ir.addColorStop(0.3, 'rgba(255,220,120,0.10)');
    ir.addColorStop(0.55, 'rgba(120,255,190,0.10)'); ir.addColorStop(0.8, 'rgba(110,180,255,0.12)');
    ir.addColorStop(1, 'rgba(190,130,255,0.10)');
    g.fillStyle = ir; g.fillRect(0, 0, w, h);
    g.restore();
    // 시맥: 앞가장자리(costa), 종맥 L1~L6, 앞·뒤 횡맥
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(104,76,46,0.95)';
    const vein = (lw, ...pts) => {
      g.lineWidth = lw;
      g.beginPath(); g.moveTo(...P(...pts[0]));
      if (pts.length === 3) g.quadraticCurveTo(...P(...pts[1]), ...P(...pts[2]));
      else g.lineTo(...P(...pts[1]));
      g.stroke();
    };
    vein(7, [0.985, 0.43], [0.62, 0.11], [0.12, 0.15]);
    vein(5, [0.12, 0.15], [0.03, 0.26], [0.015, 0.45]);
    vein(4, [0.95, 0.38], [0.8, 0.22], [0.6, 0.13]);
    vein(4, [0.9, 0.4], [0.5, 0.2], [0.14, 0.2]);
    vein(4, [0.92, 0.44], [0.5, 0.37], [0.025, 0.44]);
    vein(4, [0.93, 0.48], [0.5, 0.55], [0.05, 0.66]);
    vein(4, [0.91, 0.53], [0.6, 0.72], [0.34, 0.91]);
    vein(3, [0.92, 0.57], [0.82, 0.68], [0.7, 0.8]);
    vein(4, [0.61, 0.32], [0.61, 0.5]);
    vein(4, [0.42, 0.56], [0.46, 0.79]);
    g.lineWidth = 2.5;
    g.strokeStyle = 'rgba(120,96,64,0.6)';
    path(); g.stroke();
  });
}

function environmentMap(renderer) {
  // 키틴·겹눈의 반사광용 소형 스튜디오 환경: 따뜻한 키 소프트박스 + 차가운 림.
  const s = new THREE.Scene();
  const sky = new THREE.SphereGeometry(10, 32, 16);
  const cols = [];
  const pos = sky.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / 10;
    const c = t > 0 ? new THREE.Color(0x1a2348).lerp(new THREE.Color(0x46588f), t)
                    : new THREE.Color(0x1a2348).lerp(new THREE.Color(0x06080f), -t);
    cols.push(c.r, c.g, c.b);
  }
  sky.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  s.add(new THREE.Mesh(sky, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const box = (hex, k, p, sw, sh) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.copy(p); m.lookAt(0, 0, 0); s.add(m);
  };
  box(0xffe0b0, 7, V3(3, 6, 4), 4, 3);
  box(0x9fb4ff, 3.5, V3(-6, 3, -5), 3, 5);
  box(0xffffff, 0.8, V3(0, 2, 9), 7, 1.5);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0.03).texture;
  pm.dispose();
  return tex;
}

// 다리 정의: 부착점(가슴 아래), 고관절(기절 끝), 넓적다리·종아리·발목 길이,
// 기본 발 위치(몸 기준 수평 좌표), 비행 시 접는 위치, 삼각보행 위상.
const LEG_DEFS = [
  { idx: 0, attach: [0.92, 0.3, 0.14], hip: [0.98, 0.14, 0.26], l: [0.78, 0.8, 0.62],
    home: [1.55, 0.86], tuck: [1.2, -0.28, 0.4] },
  { idx: 1, attach: [0.56, 0.22, 0.2], hip: [0.56, 0.08, 0.32], l: [0.85, 0.92, 0.68],
    home: [0.38, 1.22], tuck: [0.45, -0.42, 0.55] },
  { idx: 2, attach: [0.2, 0.24, 0.2], hip: [0.16, 0.1, 0.3], l: [0.92, 1.0, 0.72],
    home: [-0.92, 1.06], tuck: [-0.35, -0.32, 0.5] },
];

export function buildFlyModel(renderer) {
  const env = environmentMap(renderer);
  const body = new THREE.Group();
  const M = (geo, mat, parent = body) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  const thx = thoraxTextures();
  const eye = eyeTextures();
  const mats = {
    abd: new THREE.MeshPhysicalMaterial({ map: abdomenTexture(), roughness: 0.5,
      clearcoat: 0.35, clearcoatRoughness: 0.45, envMap: env, envMapIntensity: 0.55 }),
    thx: new THREE.MeshPhysicalMaterial({ map: thx.map, bumpMap: thx.bump, bumpScale: 0.003,
      roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.3, envMap: env, envMapIntensity: 0.6 }),
    head: new THREE.MeshPhysicalMaterial({ color: srgb(0x8a5426), roughness: 0.55, clearcoat: 0.15,
      clearcoatRoughness: 0.5, envMap: env, envMapIntensity: 0.25 }),
    frons: new THREE.MeshPhysicalMaterial({ color: srgb(0xa04e18), roughness: 0.6, envMap: env, envMapIntensity: 0.2 }),
    eye: new THREE.MeshPhysicalMaterial({ map: eye.map, bumpMap: eye.bump, bumpScale: 0.01,
      roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.12, emissive: srgb(0x2a0402),
      envMap: env, envMapIntensity: 1.0 }),
    bristle: new THREE.MeshStandardMaterial({ color: srgb(0x1c120a), roughness: 0.55 }),
    leg: new THREE.MeshPhysicalMaterial({ color: srgb(0x7a4a20), roughness: 0.55, clearcoat: 0.1,
      clearcoatRoughness: 0.5, envMap: env, envMapIntensity: 0.25 }),
    tarsus: new THREE.MeshPhysicalMaterial({ color: srgb(0x5e3a1a), roughness: 0.55, envMap: env, envMapIntensity: 0.2 }),
    claw: new THREE.MeshStandardMaterial({ color: srgb(0x24170c), roughness: 0.5 }),
    wing: new THREE.MeshPhysicalMaterial({ map: wingTexture(), transparent: true, side: THREE.DoubleSide,
      depthWrite: false, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08,
      envMap: env, envMapIntensity: 0.9, alphaTest: 0.01 }),
  };

  // ── 가슴: 앞쪽 등이 솟은 혹 모양 ─────────────
  const thoraxGeo = new THREE.SphereGeometry(1, 48, 32);
  {
    const p = thoraxGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      const hump = 1 + 0.2 * clamp((x + 0.2) / 1.0, 0, 1);
      p.setY(i, y > 0 ? y * hump : y * 0.85);
    }
    thoraxGeo.computeVertexNormals();
  }
  const thorax = M(thoraxGeo, mats.thx);
  thorax.scale.set(0.72, 0.58, 0.56);
  thorax.position.set(0.45, 0.64, 0);
  const scutellum = M(new THREE.SphereGeometry(1, 28, 18), mats.thx);
  scutellum.scale.set(0.26, 0.12, 0.24);
  scutellum.position.set(-0.18, 0.95, 0);

  // ── 배: 호 길이 등간격으로 재샘플한 방추형 회전체 ──
  const prof = new THREE.SplineCurve([
    [0.0, 0], [0.1, 0.04], [0.22, 0.14], [0.35, 0.34], [0.45, 0.64], [0.51, 0.98],
    [0.52, 1.28], [0.5, 1.58], [0.43, 1.86], [0.32, 2.08], [0.16, 2.22], [0.0, 2.26],
  ].map(([r, y]) => new THREE.Vector2(r, y))).getSpacedPoints(56);
  prof[0].x = 0.001; prof[prof.length - 1].x = 0.001;
  const abdGeo = new THREE.LatheGeometry(prof, 56);
  abdGeo.translate(0, -2.26, 0);
  abdGeo.rotateZ(-Math.PI / 2);                     // 꼬리 x=-2.26, 가슴 쪽 x=0
  const abdomen = M(abdGeo, mats.abd);
  abdomen.scale.set(1, 0.88, 0.94);
  abdomen.position.set(0.12, 0.52, 0);
  abdomen.rotation.z = 0.08;

  // ── 머리: 좌우로 넓고 앞뒤로 얇다. 겹눈이 옆면을 거의 다 덮는다 ──
  const head = new THREE.Group();
  head.position.set(1.38, 0.7, 0);
  body.add(head);
  const skull = M(new THREE.SphereGeometry(1, 40, 28), mats.head, head);
  skull.scale.set(0.3, 0.44, 0.47);
  const frons = M(new THREE.SphereGeometry(1, 24, 16), mats.frons, head);
  frons.scale.set(0.09, 0.3, 0.17);
  frons.position.set(0.25, 0.06, 0);
  for (const sz of [-1, 1]) {
    const e = M(new THREE.SphereGeometry(1, 48, 32), mats.eye, head);
    e.rotation.x = sz * Math.PI / 2;                // 극(밝은 중심)이 바깥을 향하게
    e.rotation.z = -sz * 0.25;
    e.scale.set(0.26, 0.2, 0.41);
    e.position.set(0.06, 0.03, sz * 0.32);
    // 더듬이: 자루마디 + 타원형 3절 + 깃털 아리스타
    const ped = M(new THREE.SphereGeometry(0.05, 12, 8), mats.head, head);
    ped.position.set(0.28, 0.17, sz * 0.07);
    const fun = M(new THREE.SphereGeometry(1, 16, 12), mats.frons, head);
    fun.scale.set(0.06, 0.11, 0.05);
    fun.position.set(0.32, 0.07, sz * 0.08);
    fun.rotation.z = 0.35;
    const ari = new THREE.Group();
    ari.position.set(0.34, 0.12, sz * 0.1);
    ari.quaternion.setFromUnitVectors(UP, V3(0.7, 0.55, sz * 0.45).normalize());
    head.add(ari);
    const ariGeo = new THREE.CylinderGeometry(0.004, 0.009, 1, 6);
    ariGeo.translate(0, 0.5, 0);
    const shaft = M(ariGeo, mats.bristle, ari);
    shaft.scale.set(1, 0.34, 1);
    for (let k = 0; k < 6; k++) {
      const br = M(ariGeo, mats.bristle, ari);
      br.position.y = 0.07 + k * 0.045;
      br.rotation.z = (k % 2 ? 1 : -1) * 0.9;
      br.scale.set(0.7, 0.06, 0.7);
    }
  }
  // 홑눈 3개 (정수리 삼각형)
  for (const [x, z] of [[0.04, 0], [-0.03, 0.055], [-0.03, -0.055]]) {
    const oc = M(new THREE.SphereGeometry(0.032, 10, 8), mats.eye, head);
    oc.position.set(x, 0.43, z);
  }

  // ── 강모(굵은 털): 표면 법선과 뒤쪽 방향을 섞어 눕힌다 ──
  const bristleGeo = new THREE.CylinderGeometry(0.003, 0.014, 1, 6);
  bristleGeo.translate(0, 0.5, 0);
  const addBristle = (parent, p, dir, len) => {
    const b = M(bristleGeo, mats.bristle, parent);
    b.position.copy(p);
    b.quaternion.setFromUnitVectors(UP, dir.normalize());
    b.scale.set(1, len, 1);
  };
  const onThorax = (nx, nz) => {
    const ny = Math.sqrt(Math.max(0.05, 1 - nx * nx - nz * nz));
    const hump = 1 + 0.2 * clamp((nx + 0.2) / 1.0, 0, 1);
    const p = V3(0.45 + nx * 0.72, 0.64 + ny * hump * 0.58, nz * 0.56);
    const n = V3(nx / 0.72, ny / 0.58, nz / 0.56).normalize();
    return [p, n];
  };
  for (const [nx, nz, len] of [[0.28, 0.26, 0.36], [-0.22, 0.27, 0.4], [0.05, 0.62, 0.3],
                               [-0.35, 0.58, 0.3], [0.55, 0.66, 0.26], [0.36, 0.76, 0.24],
                               [0.74, 0.5, 0.22], [-0.05, 0.08, 0.16], [0.4, 0.1, 0.15]]) {
    for (const sz of [-1, 1]) {
      const [p, n] = onThorax(nx, nz * sz);
      addBristle(body, p, n.multiplyScalar(0.55).add(V3(-1, 0.18, 0)), len);
    }
  }
  for (const sz of [-1, 1]) {
    addBristle(body, V3(-0.26, 1.03, sz * 0.12), V3(-1, 0.45, sz * 0.25), 0.38);
    addBristle(body, V3(-0.36, 0.98, sz * 0.07), V3(-1, 0.3, sz * 0.1), 0.42);
    addBristle(head, V3(-0.02, 0.4, sz * 0.12), V3(-0.6, 1, sz * 0.4), 0.24);
    addBristle(head, V3(0.06, 0.36, sz * 0.24), V3(-0.5, 1, sz * 0.7), 0.2);
    addBristle(head, V3(0.14, 0.32, sz * 0.28), V3(0.4, 1, sz * 0.5), 0.16);
  }

  // ── 평형곤: 날개 뒤의 작은 곤봉 ──
  for (const sz of [-1, 1]) {
    const st = M(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 6), mats.leg);
    st.position.set(-0.08, 0.8, sz * 0.42);
    st.rotation.x = sz * 0.6;
    const knob = M(new THREE.SphereGeometry(0.045, 10, 8), mats.leg);
    knob.position.set(-0.08, 0.86, sz * 0.5);
  }

  // ── 주둥이: 머리 아래 피벗, 아래로 늘어나는 관 + 두 갈래 순판 ──
  const probG = new THREE.Group();
  probG.position.set(1.52, 0.34, 0);
  body.add(probG);
  const probGeo = new THREE.CylinderGeometry(0.07, 0.09, 1, 12);
  probGeo.translate(0, -0.5, 0);
  M(probGeo, mats.head, probG);
  const probLab = new THREE.Group();
  probLab.position.y = -1;
  probG.add(probLab);
  for (const sz of [-1, 1]) {
    const lobe = M(new THREE.SphereGeometry(1, 14, 10), mats.head, probLab);
    lobe.scale.set(0.11, 0.07, 0.08);
    lobe.position.set(0.02, -0.02, sz * 0.06);
  }

  // ── 날개: flap(몸 x축 날갯짓) → yaw(벌림) → pitch → roll(지붕꼴) → 평면 ──
  const L = 2.85, W = 1.42;
  const wingGeo = new THREE.PlaneGeometry(L, W, 1, 1);
  wingGeo.translate(-L / 2, 0, 0);                   // 뿌리(u=1)가 경첩에
  wingGeo.rotateX(-Math.PI / 2);                     // 수평으로 눕힘, 앞가장자리 = -z
  const wings = [];
  for (const sz of [-1, 1]) {
    const flapG = new THREE.Group();
    flapG.position.set(0.05, 1.12 + (sz > 0 ? 0.012 : 0), sz * 0.3);
    const yawG = new THREE.Group(), pitchG = new THREE.Group(), rollG = new THREE.Group();
    body.add(flapG); flapG.add(yawG); yawG.add(pitchG); pitchG.add(rollG);
    const mesh = new THREE.Mesh(wingGeo, mats.wing);
    mesh.scale.z = -sz;                               // 앞가장자리가 바깥을 향하게
    mesh.renderOrder = sz > 0 ? 3 : 2;
    rollG.add(mesh);
    wings.push({ sz, flapG, yawG, pitchG, rollG, mesh });
  }

  return { body, head, probG, probLab, wings, mats, legDefs: LEG_DEFS };
}

// ── 다리 리그: 월드 공간 2관절 IK ─────────────────
export class LegRig {
  constructor(scene, mats) {
    this.root = new THREE.Group();
    scene.add(this.root);
    const seg = (r0, r1, mat) => {
      const geo = new THREE.CylinderGeometry(r1, r0, 1, 10, 1);
      geo.translate(0, 0.5, 0);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      this.root.add(m);
      return m;
    };
    const joint = (r, mat) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat);
      m.castShadow = true;
      this.root.add(m);
      return m;
    };
    this.legs = [];
    for (const side of [-1, 1]) {
      for (const d of LEG_DEFS) {
        const s = d.idx === 2 ? 1.06 : 1;
        this.legs.push({
          side, idx: d.idx,
          attach: V3(d.attach[0], d.attach[1], d.attach[2] * side),
          hip: V3(d.hip[0], d.hip[1], d.hip[2] * side),
          l1: d.l[0], l2: d.l[1], l3: d.l[2],
          home: { x: d.home[0], z: d.home[1] * side },
          tuck: V3(d.tuck[0], d.tuck[1], d.tuck[2] * side),
          // 삼각보행: 왼앞·오중·왼뒤 / 오앞·왼중·오뒤
          gaitOff: ((d.idx % 2 === 0) === (side < 0)) ? 0 : 0.5,
          target: V3(),
          coxa: seg(0.085 * s, 0.07 * s, mats.leg),
          femur: seg(0.068 * s, 0.05 * s, mats.leg),
          tibia: seg(0.046 * s, 0.032 * s, mats.leg),
          tarsus: seg(0.03, 0.016, mats.tarsus),
          jHip: joint(0.07 * s, mats.leg),
          jKnee: joint(0.052 * s, mats.leg),
          jAnkle: joint(0.035, mats.tarsus),
          claw: joint(0.028, mats.claw),
        });
      }
    }
  }

  static place(mesh, a, b) {
    const d = b.clone().sub(a);
    const len = d.length() || 1e-4;
    mesh.position.copy(a);
    mesh.quaternion.setFromUnitVectors(UP, d.divideScalar(len));
    mesh.scale.set(1, len, 1);
  }

  // body.matrixWorld가 최신이어야 한다. 각 다리의 target(월드)을 미리 채워둘 것.
  update(body) {
    const side = V3(0, 0, 1).transformDirection(body.matrixWorld);
    for (const g of this.legs) {
      const A = g.attach.clone().applyMatrix4(body.matrixWorld);
      const H = g.hip.clone().applyMatrix4(body.matrixWorld);
      const F = g.target;
      const dh = V3(F.x - H.x, 0, F.z - H.z);
      if (dh.lengthSq() < 1e-6) dh.copy(side).multiplyScalar(g.side).setY(0);
      dh.normalize();
      const ank = F.clone().addScaledVector(dh, -g.l3 * 0.9);
      ank.y += g.l3 * 0.4;
      const d = ank.clone().sub(H);
      const dist = d.length() || 1e-4;
      const u = d.divideScalar(dist);
      const D = clamp(dist, Math.abs(g.l1 - g.l2) + 0.02, g.l1 + g.l2 - 0.002);
      const pole = UP.clone().addScaledVector(side, g.side * 1.1);
      pole.addScaledVector(u, -pole.dot(u));
      if (pole.lengthSq() < 1e-6) pole.copy(side).multiplyScalar(g.side);
      pole.normalize();
      const cosA = clamp((g.l1 * g.l1 + D * D - g.l2 * g.l2) / (2 * g.l1 * D), -1, 1);
      const a = Math.acos(cosA);
      const K = H.clone().addScaledVector(u, g.l1 * Math.cos(a)).addScaledVector(pole, g.l1 * Math.sin(a));
      const Ae = H.clone().addScaledVector(u, D);
      LegRig.place(g.coxa, A, H);
      LegRig.place(g.femur, H, K);
      LegRig.place(g.tibia, K, Ae);
      LegRig.place(g.tarsus, Ae, F);
      g.jHip.position.copy(H);
      g.jKnee.position.copy(K);
      g.jAnkle.position.copy(Ae);
      g.claw.position.copy(F);
    }
  }
}
