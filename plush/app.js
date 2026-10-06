(function () {
"use strict";
const V3 = THREE.Vector3, Q = THREE.Quaternion;
const sm = THREE.MathUtils.smoothstep;
const hex = (h) => new V3(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255);
const css = (h) => "#" + h.toString(16).padStart(6, "0");
const $ = (id) => document.getElementById(id);

/* ---------- settings / action state ---------- */
const S = { tool: "hand", stuff: 0.62, pile: 0.45, damp: 0.4, slow: false, pause: false, curl: false, hang: false };
const act = { wave: 0, walk: 0, waveLeg: 0, flap: 0, wag: 0, shake: 0, hug: 0, waveArm: 0, ears: 0 };
let simT = 0, wingPh = 0;

/* ---------- renderer / scene ---------- */
const stage = $("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0xece9e3, 1);
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
const orbit = { theta: 0.1, phi: 1.1, dist: 11, target: new V3(0, 0.75, 0) };
const narrow = () => window.innerWidth < 760;
function zoomToSlider() { const z = document.getElementById("rZoom"); if (z) z.value = String(1 - Math.log(orbit.dist / 6) / Math.log(4)); }
function placeCamera() {
  zoomToSlider();
  const t = orbit.target;
  camera.position.set(
    t.x + orbit.dist * Math.sin(orbit.phi) * Math.sin(orbit.theta),
    t.y + orbit.dist * Math.cos(orbit.phi),
    t.z + orbit.dist * Math.sin(orbit.phi) * Math.cos(orbit.theta));
  camera.lookAt(t);
}
function frameCreature() {
  orbit.target.set(0, narrow() ? C.cam.y - 0.55 : C.cam.y, 0);
  orbit.dist = narrow() ? C.cam.dist * 1.55 : C.cam.dist;
  placeCamera();
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w / h < 0.8 ? 46 : 30;
  camera.updateProjectionMatrix();
  placeCamera();
}
window.addEventListener("resize", resize);
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(-3, 6, 4); scene.add(sun);
const LIGHT = new V3(-0.45, 0.85, 0.45).normalize();

/* ---------- shape helpers ---------- */
function sphereProf(n) { const a = []; for (let k = 0; k <= n; k++) { const t = k / n * Math.PI; a.push([Math.sin(t), Math.cos(t)]); } a[0][0] = 0; a[n][0] = 0; return a; }
function curveProf(pts, n) {
  const c = new THREE.CatmullRomCurve3(pts.map(p => new V3(p[0], p[1], 0)), false, "centripetal");
  const s = c.getSpacedPoints(n - 1).map(p => [p.x, p.y]); s[0][0] = 0; s[n - 1][0] = 0; return s;
}
function profRadiusAt(prof, y) { let best = 0, bd = 1e9; for (const p of prof) { const d = Math.abs(p[1] - y); if (d < bd && p[0] > 0.3) { bd = d; best = p[0]; } } return best; }
const gauss = (p, c, s2) => Math.exp(-p.distanceToSquared(c) / s2);
function blobDefaults(b) { b.kind = "blob"; b.center = b.center || new V3(); b.scale = b.scale || new V3(1, 1, 1); b.quat = b.quat || new Q(); b.seg = b.seg || 56; return b; }
// a point on an ellipsoid blob, addressed by a direction on its unit sphere
function onBlob(b, ux, uy, uz, lift) {
  const u = new V3(ux, uy, uz).normalize();
  const n = new V3(u.x / b.scale.x, u.y / b.scale.y, u.z / b.scale.z).applyQuaternion(b.quat).normalize();
  const p = new V3(u.x * b.scale.x, u.y * b.scale.y, u.z * b.scale.z).applyQuaternion(b.quat).add(b.center).addScaledVector(n, lift || 0);
  return { p, n };
}
const capR = (u, from) => u > from ? Math.sqrt(Math.max(0, 1 - Math.pow((u - from) / (1 - from), 2))) : 1;

/* ---------- decoration materials ---------- */
const MAT = {
  eye: new THREE.MeshStandardMaterial({ color: 0x17131a, roughness: 0.12, metalness: 0.15 }),
  eyeBrown: new THREE.MeshStandardMaterial({ color: 0x2c170e, roughness: 0.1, metalness: 0.15 }),
  glint: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  mouth: new THREE.MeshStandardMaterial({ color: 0x2b1d24, roughness: 0.6 }),
  fang: new THREE.MeshStandardMaterial({ color: 0xfbf7f0, roughness: 0.35 }),
  horn: new THREE.MeshStandardMaterial({ color: 0xeee0bf, roughness: 0.5 }),
  alt: new THREE.MeshStandardMaterial({ color: 0x9a80d8, roughness: 0.75 }),
  pad: new THREE.MeshStandardMaterial({ color: 0xc7a684, roughness: 0.95 })
};
function addEye(g, p, n, r, mat) {
  const e = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 20), mat || MAT.eye);
  e.position.copy(p); e.quaternion.setFromUnitVectors(new V3(0, 0, 1), n); e.scale.set(1, 1.12, 0.62);
  const g1 = new THREE.Mesh(new THREE.SphereGeometry(r * 0.32, 12, 8), MAT.glint); g1.position.set(-r * 0.25, r * 0.38, r * 0.86);
  const g2 = new THREE.Mesh(new THREE.SphereGeometry(r * 0.14, 10, 6), MAT.glint); g2.position.set(r * 0.32, -r * 0.28, r * 0.92);
  e.add(g1, g2); g.add(e);
}
function addTube(g, pts, r, mat) { g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, r, 8, false), mat)); }
function addCone(g, p, dir, r, h, mat) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 18), mat);
  const d = dir.clone().normalize();
  m.position.copy(p).addScaledVector(d, h * 0.38); m.quaternion.setFromUnitVectors(new V3(0, 1, 0), d); g.add(m);
}

function addHorn(g, p, up, back, r, len) {
  const u1 = up.clone().normalize(), b1 = back.clone().normalize();
  const pts = [0, 0.33, 0.66, 1].map(t => p.clone().addScaledVector(u1, len * t).addScaledVector(b1, len * 0.45 * t * t));
  const curve = new THREE.CatmullRomCurve3(pts), segs = 20, rad = 10;
  const tg = new THREE.TubeGeometry(curve, segs, r, rad, false), pa = tg.attributes.position, c = new V3(), v = new V3();
  for (let i = 0; i <= segs; i++) {
    curve.getPointAt(i / segs, c); const k = 1 - 0.92 * (i / segs);
    for (let j = 0; j <= rad; j++) { const vi = i * (rad + 1) + j; v.fromBufferAttribute(pa, vi).sub(c).multiplyScalar(k).add(c); pa.setXYZ(vi, v.x, v.y, v.z); }
  }
  tg.computeVertexNormals();
  g.add(new THREE.Mesh(tg, MAT.horn));
}

/* =================================================================
   Creatures. Each one is a list of rigid fur "blobs" (lathed shapes),
   floppy fur "limbs" (verlet chains), and a face built from small meshes.
   ================================================================= */
const OCT_PROF = curveProf([[0, 2.36], [0.58, 2.27], [0.98, 1.96], [1.12, 1.54], [1.05, 1.1], [0.84, 0.79], [0.66, 0.56], [0.56, 0.38], [0.34, 0.27], [0, 0.24]], 58);
const OCTOPUS = {
  key: "octopus", name: "Octopus.", no: "No. 012",
  desc: "보송한 털옷을 입은 솜 문어. 팔 여덟 개는 흐물흐물, 머리는 묵직해요. 손가락으로 꾹 눌러 보세요.",
  mass: [360, 240], vol: 2.41, com: new V3(0, 0.95, 0), inertia: 0.9, cam: { y: 0.75, dist: 11 }, jig: [0.6, 2.4], faceY: 1.1, shadow: [2.2, 5.0], poseK: 0.09,
  palettes: {
    coral: { label: "Coral", root: 0xa55048, tip: 0xf4a28d, under: 0xfff2ec },
    lilac: { label: "Lilac", root: 0x6a569e, tip: 0xbca8f2, under: 0xf4f0fb },
    lagoon: { label: "Lagoon", root: 0x1c747a, tip: 0x52c6c6, under: 0xe9f6f2 },
    oat: { label: "Oat", root: 0x8c755e, tip: 0xddc8aa, under: 0xfbf7ef }
  }, pal: "lilac",
  parts() {
    const head = blobDefaults({
      prof: OCT_PROF, seg: 72, pole: new V3(0, -0.55, 1), starY: 1.3,
      paint(lp, ln, f) {
        let dph = f.phi - Math.PI / 2; if (dph > Math.PI) dph -= Math.PI * 2;
        const fx = dph * f.r, fy = f.y - 1.08;
        let blush = 0;
        for (const sg of [-1, 1]) { const cx = (dph - sg * 0.66) * f.r, cy = f.y - 0.98; blush = Math.max(blush, Math.exp(-(cx * cx + cy * cy) / 0.026)); }
        return { under: 0.35 * (1 - sm(f.y, 0.3, 0.75)), blush, fur: 0.32 + 0.68 * sm((fx / 0.56) ** 2 + (fy / 0.3) ** 2, 0.55, 1.35) };
      }
    });
    const parts = [head];
    const ctl = [[0.3, 0.58], [0.65, 0.4], [1.0, 0.29], [1.36, 0.23], [1.72, 0.21], [2.04, 0.22], [2.3, 0.31], [2.42, 0.48], [2.34, 0.63], [2.16, 0.66]];
    for (let a = 0; a < 8; a++) {
      const phi = Math.PI / 2 + Math.PI / 8 + a * Math.PI / 4;
      const dir = new V3(Math.cos(phi), 0, Math.sin(phi)), side = new V3(-Math.sin(phi), 0, Math.cos(phi));
      const lenS = 1 + (a % 2 ? -0.07 : 0.04) + 0.03 * Math.sin(a * 2.3);
      const sway = (a % 2 ? 1 : -1) * (0.12 + 0.08 * Math.cos(a * 1.7));
      parts.push({
        kind: "limb", np: 14, rings: 42, aseg: 14, a,
        pts: ctl.map(([s, y], i) => dir.clone().multiplyScalar(s * lenS).addScaledVector(side, Math.sin(i / (ctl.length - 1) * Math.PI) * sway * lenS).setY(y)),
        radius: (u) => (0.29 * Math.pow(1 - u, 0.8) + 0.08) * capR(u, 0.9),
        kb: (u, st) => (0.012 + st * 0.05) * (1 - 0.65 * u),
        paint: (u, ang) => ({ under: sm(-Math.cos(ang), 0.05, 0.7) * sm(u, 0.12, 0.3) })
      });
    }
    return parts;
  },
  face(g) {
    for (const sg of [-1, 1]) {
      const ph = Math.PI / 2 + sg * 0.4, y = 1.17, r = profRadiusAt(OCT_PROF, y) + 0.035;
      addEye(g, new V3(r * Math.cos(ph), y, r * Math.sin(ph)), new V3(Math.cos(ph), 0, Math.sin(ph)), 0.125);
    }
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12 * 2 - 1, ph = Math.PI / 2 + t * 0.13, y = 0.99 - 0.05 * (1 - t * t), r = profRadiusAt(OCT_PROF, y) + 0.05;
      pts.push(new V3(r * Math.cos(ph), y, r * Math.sin(ph)));
    }
    addTube(g, pts, 0.021, MAT.mouth);
  },
  specials: [{ id: "wave", label: "Wave arms", run: () => { act.wave = 3.2; } }],
  pose(L, l, i, u, t, out) {
    if (act.wave <= 0) return false;
    out.y += Math.max(0, Math.sin(t * 6 - u * 5 + l.a * 0.8)) * 0.6 * u * u * Math.min(1, act.wave);
    return true;
  }
};

const SPIDER = {
  key: "spider", name: "Spider.", no: "No. 013",
  desc: "줄무늬 다리 여덟 개에 동그란 털 엉덩이. 하나도 안 무서워요. 거미줄에 매달아 보세요.",
  mass: [300, 180], vol: 1.62, com: new V3(0, 1.15, -0.2), inertia: 0.8, cam: { y: 0.95, dist: 13 }, jig: [0.7, 2.2], faceY: 1.05, shadow: [1.4, 4.0], poseK: 0.3,
  palettes: {
    midnight: { label: "Midnight", root: 0x4a3c86, tip: 0x9a88e0, altRoot: 0x1e1838, altTip: 0x463a80, under: 0xe9e4f7 },
    tangerine: { label: "Tangerine", root: 0xb4561f, tip: 0xf6a35a, altRoot: 0x3a2116, altTip: 0x6b4430, under: 0xfff1e2 },
    moss: { label: "Moss", root: 0x4e6b2a, tip: 0xa9c76a, altRoot: 0xb89a2c, altTip: 0xf0dc84, under: 0xf6f6e4 }
  }, pal: "midnight",
  parts() {
    const ceph = blobDefaults({ prof: sphereProf(30), seg: 52, pole: new V3(0, 0, 1), center: new V3(0, 1.05, 0.42), scale: new V3(0.64, 0.54, 0.62) });
    const abd = blobDefaults({ prof: sphereProf(34), seg: 56, pole: new V3(0, -1, 0), center: new V3(0, 1.42, -0.78), scale: new V3(0.9, 1.02, 0.84),
      quat: new Q().setFromUnitVectors(new V3(0, 1, 0), new V3(0, 0.5, -1).normalize()) });
    const faceC = onBlob(ceph, 0, 0.05, 1, 0).p;
    const cheeks = [-1, 1].map(s => onBlob(ceph, s * 0.68, -0.15, 0.72, 0).p);
    ceph.paint = (lp) => ({ fur: 0.35 + 0.65 * sm(lp.distanceTo(faceC), 0.28, 0.52), blush: Math.max(gauss(lp, cheeks[0], 0.014), gauss(lp, cheeks[1], 0.014)) });
    abd.paint = (lp, ln, f) => { const a = 0.5 + 0.5 * Math.cos(Math.PI * 2 * f.t * 4.5); return { alt: sm(a, 0.4, 0.62) * sm(f.t, 0.1, 0.2) * (1 - sm(f.t, 0.85, 0.95)) }; };
    const parts = [ceph, abd];
    const ang = [0.85, 0.3, -0.2, -0.36], reach = [1.06, 1, 0.97, 1.04];
    const ctl = [[0, 1.0], [0.45, 1.42], [0.95, 1.62], [1.4, 1.25], [1.78, 0.6], [2.02, 0.13]];
    for (const s of [1, -1]) for (let k = 0; k < 4; k++) {
      const root = new V3(s * (0.42 + (k === 3 ? 0.06 : 0)), 1.0, 0.52 - k * 0.27), dir = new V3(s * Math.cos(ang[k]), 0, Math.sin(ang[k]));
      parts.push({
        kind: "limb", np: 12, rings: 40, aseg: 10, side: s, k,
        pts: ctl.map(([r, y]) => root.clone().addScaledVector(dir, r * reach[k]).setY(y)),
        radius: (u) => (0.115 + 0.035 * (1 - u)) * capR(u, 0.93),
        kb: (u, st) => (0.09 + st * 0.12) * (1 - 0.4 * u),
        paint: (u) => { const f = (u * 5.5) % 1; return { alt: sm(f, 0.5, 0.58) * (1 - sm(f, 0.92, 1.0)) * (1 - sm(u, 0.86, 0.9)), under: sm(u, 0.88, 0.95) }; }
      });
    }
    this._ceph = ceph; this._abd = abd;
    return parts;
  },
  face(g) {
    const c = this._ceph;
    for (const s of [-1, 1]) {
      let e = onBlob(c, s * 0.36, 0.12, 0.92, 0.02); addEye(g, e.p, e.n, 0.15);
      e = onBlob(c, s * 0.16, 0.52, 0.84, 0.01); addEye(g, e.p, e.n, 0.06);
      e = onBlob(c, s * 0.46, 0.44, 0.78, 0.01); addEye(g, e.p, e.n, 0.045);
      e = onBlob(c, s * 0.15, -0.48, 0.86, -0.01); addCone(g, e.p, new V3(0, -1, 0.35), 0.045, 0.14, MAT.fang);
    }
  },
  specials: [
    { id: "walk", label: "Walk", run: () => { act.walk = 3.4; } },
    { id: "hang", label: "Hang on silk", toggle: "hang" },
    { id: "curl", label: "Curl up", toggle: "curl" },
    { id: "waveLeg", label: "Wave", run: () => { act.waveLeg = 2.6; } }
  ],
  pose(L, l, i, u, t, out) {
    let on = false;
    if (act.walk > 0) {
      const w = t * 9 + (((l.k + (l.side > 0 ? 1 : 0)) % 2) ? Math.PI : 0);
      out.y += Math.max(0, Math.sin(w)) * 0.55 * u; out.z += Math.cos(w) * 0.32 * u; on = true;
    }
    if (S.curl) {
      const amt = 0.8 * u * u, r = l.rest[i];
      out.x += -r.x * amt; out.z += (0.2 - r.z) * amt; out.y += (1.0 - r.y) * amt; on = true;
    }
    if (act.waveLeg > 0 && L === 0) { out.y += (1.0 + Math.sin(t * 12) * 0.25) * u; out.z += 0.35 * u; out.x -= 0.3 * u; on = true; }
    return on;
  }
};

const DRAGON_BODY = curveProf([[0, 1.62], [0.52, 1.55], [0.8, 1.3], [0.92, 0.9], [0.88, 0.5], [0.66, 0.2], [0, 0.1]], 40);
const DRAGON = {
  key: "dragon", name: "Dragon.", no: "No. 014",
  desc: "민키 털과 펠트로 만든 아기 용. 날개는 베개처럼 누빈 솜이고, 아직 나는 법을 배우는 중이에요.",
  mass: [290, 200], vol: 2.12, com: new V3(0, 1.05, 0.05), inertia: 0.75, cam: { y: 1.3, dist: 12.5 }, jig: [0.9, 2.8], faceY: 2.1, shadow: [1.6, 4.2], poseK: 0.25,
  palettes: {
    mint: { label: "Mint", root: 0x3f9e8c, tip: 0x93e2cf, altRoot: 0x7a5cba, altTip: 0xc6b2f0, under: 0xf6ecd0 },
    ember: { label: "Ember", root: 0xc0582c, tip: 0xf6a26a, altRoot: 0x8e2a36, altTip: 0xe0707a, under: 0xfbefd6 },
    dusk: { label: "Dusk", root: 0x6a56a0, tip: 0xbba8ec, altRoot: 0x237f86, altTip: 0x7fd6d2, under: 0xf4eedc }
  }, pal: "mint",
  parts() {
    // belly: cream plates in soft horizontal bands
    const body = blobDefaults({ prof: DRAGON_BODY, seg: 56,
      paint: (lp, ln) => ({ under: sm(ln.z, 0.2, 0.55) * sm(lp.y, 0.18, 0.36) * (1 - sm(lp.y, 1.25, 1.5)) * (0.72 + 0.28 * sm(Math.cos(lp.y * 20), -0.2, 0.4)) }) });
    const head = blobDefaults({ prof: sphereProf(32), seg: 56, pole: new V3(0, -0.3, 1), center: new V3(0, 2.14, 0.06), scale: new V3(0.86, 0.74, 0.78) });
    const snout = blobDefaults({ prof: sphereProf(22), seg: 40, center: new V3(0, 1.9, 0.66), scale: new V3(0.44, 0.29, 0.34), fur: 0.55,
      paint: (lp, ln) => ({ under: 0.35 + 0.35 * sm(-ln.y, -0.2, 0.6) }) });
    const eyeC = [-1, 1].map(s => onBlob(head, s * 0.42, 0.2, 0.88, 0).p);
    const cheeks = [-1, 1].map(s => onBlob(head, s * 0.72, -0.3, 0.6, 0).p);
    head.paint = (lp) => ({
      fur: 0.4 + 0.6 * sm(Math.min(lp.distanceTo(eyeC[0]), lp.distanceTo(eyeC[1])), 0.2, 0.4),
      blush: Math.max(gauss(lp, cheeks[0], 0.02), gauss(lp, cheeks[1], 0.02))
    });
    const parts = [body, head, snout];
    for (const s of [1, -1]) {
      const qY = new Q().setFromAxisAngle(new V3(0, 1, 0), s > 0 ? 0.95 : Math.PI - 0.95);
      const quat = qY.clone().multiply(new Q().setFromAxisAngle(new V3(0, 0, 1), 0.6));
      const pivot = new V3(s * 0.36, 1.45, -0.62);
      parts.push(blobDefaults({
        prof: sphereProf(28), seg: 40, scale: new V3(1.02, 0.8, 0.07), quat, pivot,
        center: pivot.clone().add(new V3(0.88, 0.14, 0).applyQuaternion(quat)),
        // bat-wing outline: three scallops cut into the outer edge
        rmod: (ph, t) => 1 - 0.34 * Math.pow(Math.max(0, Math.cos(ph)), 3) * Math.pow(Math.sin(t * Math.PI * 3), 2),
        axis: new V3(0, 0, 1).applyQuaternion(qY), anim: () => 0.1 + Math.sin(wingPh) * (act.flap > 0 ? 0.62 : 0.07),
        fur: 0.5, paint: (lp, ln, f) => ({ alt: 1, under: 0.22 * Math.pow(Math.abs(Math.sin(f.t * Math.PI * 3)), 8) * sm(Math.cos(f.phi), 0.2, 0.9) })
      }));
    }
    parts.push({
      kind: "limb", np: 12, rings: 42, aseg: 12, tail: true,
      pts: [[0, 0.42, -0.55], [0.05, 0.24, -1.05], [0.3, 0.17, -1.55], [0.75, 0.15, -1.86], [1.22, 0.18, -1.86], [1.48, 0.3, -1.62]].map(p => new V3(...p)),
      radius: (u) => (0.27 * Math.pow(1 - u, 0.85) + 0.05) * capR(u, 0.92),
      kb: (u, st) => (0.03 + st * 0.08) * (1 - 0.5 * u),
      paint: (u, ang) => ({ under: sm(-Math.cos(ang), 0.1, 0.7) * 0.9 * (1 - sm(u, 0.85, 0.9)), alt: sm(u, 0.9, 0.95) }),
      decor: [0.12, 0.27, 0.42, 0.57, 0.72].map((u, i) => ({ type: "spike", u, h: 0.38 - i * 0.04, r: 0.1 - i * 0.01 })).concat([{ type: "spade", u: 1 }])
    });
    for (const s of [1, -1]) {
      // legs: plump thighs reaching forward into big padded feet
      parts.push({
        kind: "limb", np: 7, rings: 26, aseg: 12,
        pts: [[s * 0.54, 0.6, 0.16], [s * 0.82, 0.4, 0.54], [s * 0.8, 0.27, 0.84], [s * 0.82, 0.25, 1.12]].map(p => new V3(...p)),
        radius: (u) => (0.29 - 0.06 * u + 0.05 * sm(u, 0.7, 0.85)) * capR(u, 0.86),
        kb: (u, st) => 0.3 + st * 0.2,
        paint: (u, ang) => ({ under: Math.max(sm(u, 0.8, 0.9), sm(-Math.cos(ang), 0.3, 0.8) * sm(u, 0.7, 0.8)) }),
        decor: [-0.55, 0, 0.55].map(a => ({ type: "claw", u: 0.9, a: Math.PI * 0.5 + a }))
      });
      // arms: long enough to hug the belly, with little claws
      parts.push({
        kind: "limb", np: 7, rings: 26, aseg: 10,
        pts: [[s * 0.66, 1.32, 0.18], [s * 0.94, 1.12, 0.36], [s * 1.04, 0.86, 0.56], [s * 0.96, 0.66, 0.76], [s * 0.84, 0.6, 0.86]].map(p => new V3(...p)),
        radius: (u) => (0.17 - 0.04 * u + 0.025 * sm(u, 0.75, 0.88)) * capR(u, 0.84),
        kb: (u, st) => 0.16 + st * 0.18,
        paint: (u) => ({ under: sm(u, 0.82, 0.92) * 0.85 }),
        decor: [-0.45, 0, 0.45].map(a => ({ type: "claw", u: 0.9, a: Math.PI * 0.5 + a, small: true }))
      });
    }
    this._head = head; this._snout = snout;
    return parts;
  },
  face(g) {
    const h = this._head, sn = this._snout;
    for (const s of [-1, 1]) {
      let e = onBlob(h, s * 0.42, 0.2, 0.88, 0.03); addEye(g, e.p, e.n, 0.17, MAT.eyeBrown);
      e = onBlob(h, s * 0.5, 0.78, -0.2, -0.04); addHorn(g, e.p, new V3(s * 0.45, 1, -0.15), new V3(s * 0.1, -0.15, -1), 0.12, 0.62);
      e = onBlob(h, s * 0.9, 0.15, -0.25, -0.03); addCone(g, e.p, new V3(s, 0.35, -0.35), 0.07, 0.22, MAT.alt); // ear frills
      e = onBlob(sn, s * 0.36, 0.5, 0.8, 0.0); const nos = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), MAT.mouth);
      nos.position.copy(e.p); nos.scale.set(1.3, 0.8, 0.7); g.add(nos);
    }
    const pts = [];
    for (let k = 0; k <= 10; k++) { const t = k / 10 * 2 - 1; pts.push(onBlob(sn, t * 0.42, -0.25 - 0.18 * (1 - t * t), 0.9, 0.03).p); }
    addTube(g, pts, 0.017, MAT.mouth);
    for (const s of [-1, 1]) { const f = onBlob(sn, s * 0.3, -0.5, 0.8, 0.0); addCone(g, f.p, new V3(0, -1, 0.2), 0.026, 0.08, MAT.fang); }
    // spine ridge: head crown down the back
    [[0.85, -0.5, 0.34], [0.5, -0.86, 0.4], [0.05, -1, 0.38]].forEach(([y, z, hh]) => { const e = onBlob(h, 0, y, z, 0.0); addCone(g, e.p, e.n, 0.11, hh, MAT.alt); });
    [1.38, 1.1, 0.82, 0.55].forEach((y, i) => {
      const r = profRadiusAt(DRAGON_BODY, y);
      addCone(g, new V3(0, y, -r + 0.01), new V3(0, 0.3, -1), 0.12 - i * 0.01, 0.42 - i * 0.04, MAT.alt);
    });
  },
  specials: [
    { id: "flap", label: "Flap", run: () => { act.flap = 2.6; } },
    { id: "wag", label: "Wag tail", run: () => { act.wag = 2.4; } }
  ],
  pose(L, l, i, u, t, out) {
    if (act.wag > 0 && l.tail) { out.x += Math.sin(t * 11) * 0.55 * Math.pow(u, 1.4); out.y += 0.12 * u; return true; }
    return false;
  }
};
/* ---------- Jellycat-style friends ---------- */
function torusProf(R, a, n) { const p = []; for (let k = 0; k <= n; k++) { const t = k / n * Math.PI * 2; p.push([R + a * Math.sin(t), a * Math.cos(t)]); } return p; }
const qAim = (d) => new Q().setFromUnitVectors(new V3(0, 1, 0), d.clone().normalize());
const ell = (c, s, opt) => blobDefaults(Object.assign({ prof: sphereProf(opt && opt.n || 22), seg: opt && opt.seg || 40, center: c, scale: s, lean: 0.5, pole: new V3(0, -0.2, 1) }, opt || {}));
// fur trimmed short around the given face points, so bead eyes and noses sit on top of the pile
const trimNear = (pts, r0, r1, min) => (lp) => { let d = 1e9; for (const p of pts) d = Math.min(d, lp.distanceTo(p)); return min + (1 - min) * sm(d, r0, r1); };
function plushLimb(o) {
  return Object.assign({ kind: "limb", np: 8, rings: 30, aseg: 12, kb: (u, st) => 0.02 + st * 0.05 }, o, { pts: o.pts.map(p => new V3(...p)) });
}
function addNose(g, p, n, s, color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshStandardMaterial({ color, roughness: 0.45 }));
  m.position.copy(p); m.quaternion.setFromUnitVectors(new V3(0, 0, 1), n); m.scale.set(s[0], s[1], s[2]); g.add(m); return m;
}
function addMouthY(g, top, down, w, color) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const mid = top.clone().addScaledVector(UP, -down);
  addTube(g, [top, top.clone().lerp(mid, 0.5), mid], 0.01, mat);
  for (const s of [-1, 1]) addTube(g, [mid, mid.clone().add(new V3(s * w * 0.5, -w * 0.28, -0.01)), mid.clone().add(new V3(s * w, 0.0, -0.035))], 0.01, mat);
}
const plushPose = (L, l, i, u, t, out) => {
  let on = false;
  if (act.hug > 0 && l.role === "arm") { out.x += -l.side * 0.75 * u; out.z += 0.6 * u; out.y += 0.35 * u; on = true; }
  if (act.waveArm > 0 && l.role === "arm" && l.side > 0) { out.y += (1.3 + Math.sin(t * 12) * 0.25) * u; out.x += 0.25 * u; out.z += 0.2 * u; on = true; }
  if (act.ears > 0 && l.role === "ear") { const r = l.rest[i], r0 = l.rest[0]; out.x += (r0.x + l.side * 0.12 * u - r.x); out.z += (r0.z - r.z); out.y += (r0.y + u * 1.3 - r.y); on = true; }
  if (act.wag > 0 && l.role === "tail") { out.x += Math.sin(t * 11) * 0.5 * Math.pow(u, 1.3); out.y += 0.15 * u; on = true; }
  return on;
};

/* Bear: big hunched sitting bear, long suede snout, padded paws */
const BEAR_BODY = curveProf([[0, 1.74], [0.46, 1.69], [0.7, 1.48], [0.82, 1.08], [0.86, 0.64], [0.68, 0.22], [0, 0.12]], 44);
const SNOUT = curveProf([[0, 0.6], [0.13, 0.58], [0.2, 0.47], [0.25, 0.25], [0.28, 0.04], [0.2, -0.08], [0, -0.1]], 24);
const BEAR = {
  key: "bear", name: "Bear.", no: "No. 015", mass: [420, 260], vol: 3.4,
  desc: "덩치 큰 갈색 곰. 어깨가 둥글게 솟고, 긴 주둥이 끝에 커다란 코. 스웨이드 발바닥을 앞으로 내밀고 앉아 있어요.",
  com: new V3(0, 1.0, 0.1), inertia: 0.9, cam: { y: 1.25, dist: 13 }, jig: [1.0, 2.6], faceY: 2.05, shadow: [1.9, 4.4], poseK: 0.3,
  palettes: {
    bark: { label: "Bark", root: 0x3a2216, tip: 0x7c5136, under: 0xc7a684 },
    honey: { label: "Honey", root: 0x7a4a22, tip: 0xc58a50, under: 0xe6caa4 },
    mocha: { label: "Mocha", root: 0x5a4636, tip: 0xa48c74, under: 0xd9c6ae },
    snow: { label: "Snow", root: 0xb8b0a4, tip: 0xf4f0e8, under: 0xd8c8b4 }
  }, pal: "bark", pose: plushPose,
  specials: [{ id: "hug", label: "Hug", run: () => { act.hug = 2.2; } }, { id: "waveArm", label: "Wave", run: () => { act.waveArm = 2.4; } }],
  parts() {
    // pear-shaped teddy body: shallow back, round tummy pushed forward under the head
    const body = blobDefaults({ prof: BEAR_BODY, seg: 56, scale: new V3(1, 1, 0.7), center: new V3(0, 0, 0.12), fur: 1.3 });
    const head = ell(new V3(0, 1.98, 0.36), new V3(0.68, 0.62, 0.64), { n: 30, seg: 52, fur: 1.2 });
    const sdir = new V3(0, -0.22, 1).normalize();
    const snout = blobDefaults({ prof: SNOUT, seg: 40, center: head.center.clone().add(new V3(0, -0.1, 0.3)), quat: qAim(sdir), scale: new V3(1.05, 1.0, 0.88), fur: 0.28, lean: 0.6, paint: () => ({ under: 1 }) });
    const eyes = [-1, 1].map(s => onBlob(head, s * 0.44, 0.34, 0.82, 0).p);
    head.paint = (lp) => ({ fur: trimNear(eyes, 0.05, 0.16, 0.3)(lp) });
    const parts = [body, head, snout];
    // suede sole: the domed end of the limb, fur shaved to a nap and tinted
    const sole = (u) => ({ under: sm(u, 0.85, 0.9), fur: 1.3 - 1.3 * sm(u, 0.84, 0.9) });
    for (const s of [-1, 1]) {
      const e = onBlob(head, s * 0.66, 0.66, -0.2, -0.03);
      parts.push(ell(e.p, new V3(0.17, 0.16, 0.08), { quat: new Q().setFromAxisAngle(new V3(0, 0, 1), -s * 0.5), fur: 0.9, pole: new V3(0, -1, 0) }));
      parts.push(plushLimb({ role: "arm", side: s, aseg: 14,
        pts: [[s * 0.55, 1.5, 0.36], [s * 0.9, 1.28, 0.52], [s * 1.0, 0.9, 0.7], [s * 0.96, 0.52, 0.9], [s * 0.9, 0.34, 1.06]],
        rings: 36, radius: (u) => (0.25 - 0.03 * u + 0.05 * sm(u, 0.75, 0.88)) * capR(u, 0.86), paint: sole }));
      parts.push(plushLimb({ role: "leg", side: s, aseg: 14, np: 7,
        pts: [[s * 0.42, 0.5, 0.3], [s * 0.62, 0.36, 0.75], [s * 0.76, 0.33, 1.15], [s * 0.84, 0.37, 1.42]],
        rings: 36, radius: (u) => (0.31 - 0.04 * u + 0.05 * sm(u, 0.7, 0.86)) * capR(u, 0.86), kb: (u, st) => 0.06 + st * 0.08, paint: sole }));
    }
    parts.push(ell(new V3(0, 0.42, 0.12 - profRadiusAt(BEAR_BODY, 0.42) * 0.7 - 0.04), new V3(0.12, 0.11, 0.11), { fur: 1.0, pole: new V3(0, 0, 1), lean: 0 }));
    BEAR._head = head; BEAR._snout = snout; BEAR._sdir = sdir;
    return parts;
  },
  face(g) {
    const h = BEAR._head, sn = BEAR._snout, d = BEAR._sdir;
    for (const s of [-1, 1]) { const e = onBlob(h, s * 0.44, 0.34, 0.82, 0.035); addEye(g, e.p, e.n, 0.048); }
    const tip = sn.center.clone().addScaledVector(d, 0.64);
    addNose(g, tip, d.clone().add(new V3(0, 0.35, 0)).normalize(), [0.14, 0.1, 0.085], 0x3a2418);
  }
};

/* Lion: Jellycat Bashful lion: tall slim golden body, oval face with a white muzzle,
   spiky sunburst mane framing the face, small ears peeking out, long dangly limbs, tufted tail */
const LION_BODY = curveProf([[0, 1.62], [0.36, 1.57], [0.52, 1.38], [0.6, 1.0], [0.62, 0.58], [0.5, 0.2], [0, 0.12]], 40);
const LION = {
  key: "lion", name: "Lion.", no: "No. 016", mass: [250, 170], vol: 2.0,
  desc: "수줍은 금빛 사자. 삐죽삐죽한 갈기가 얼굴을 감싸고, 하얀 주둥이에 갈색 코. 팔다리는 길게 늘어지고 꼬리 끝엔 털뭉치.",
  com: new V3(0, 0.98, 0.06), inertia: 0.75, cam: { y: 1.35, dist: 12.5 }, jig: [0.9, 2.7], faceY: 2.1, shadow: [1.4, 3.8], poseK: 0.3,
  palettes: {
    bashful: { label: "Bashful", root: 0xa86c12, tip: 0xe6a836, altRoot: 0xa8660e, altTip: 0xf4c868, under: 0xfdf8ee },
    fuddle: { label: "Fuddle", root: 0xa8885e, tip: 0xe0c69e, altRoot: 0x6e3e1e, altTip: 0xae7040, under: 0xf4ebdc },
    sunset: { label: "Sunset", root: 0xb05a1c, tip: 0xf09a4a, altRoot: 0x8a3414, altTip: 0xd8642a, under: 0xfff4e6 }
  }, pal: "bashful", pose: plushPose,
  specials: [{ id: "roar", label: "Roar", run: () => { B.sqv -= 3.2; B.Jv.z += 3; B.Jv.y += 2; act.wag = 1.2; } }, { id: "wag", label: "Swish tail", run: () => { act.wag = 2.4; } }],
  parts() {
    const body = blobDefaults({ prof: LION_BODY, seg: 52, fur: 1.15 });
    const head = ell(new V3(0, 2.12, 0.14), new V3(0.48, 0.55, 0.48), { n: 30, seg: 52, fur: 0.9 });
    const muzzle = ell(new V3(0, 1.94, 0.5), new V3(0.25, 0.19, 0.19), { fur: 0.5, lean: 0.4, paint: () => ({ under: 1 }) });
    const eyes = [-1, 1].map(s => onBlob(head, s * 0.36, 0.26, 0.9, 0).p);
    head.paint = (lp) => ({ fur: trimNear(eyes, 0.05, 0.14, 0.35)(lp) });
    // mane: a long-pile shell behind the face; pile is shaved where the face sits so it frames it like a sunburst
    const mane = ell(new V3(0, 2.1, -0.06), new V3(0.64, 0.72, 0.5), { n: 30, seg: 56, fur: 4.3, lean: 0.04, pole: new V3(0, 0, -1), noCollide: true,
      paint: (lp, ln) => ({ alt: 1, fur: 1 - sm(ln.z, 0.35, 0.7) }) });
    const parts = [body, head, muzzle, mane];
    for (const s of [-1, 1]) {
      parts.push(ell(new V3(s * 0.4, 2.66, 0.2), new V3(0.13, 0.12, 0.06), { fur: 0.6, pole: new V3(0, -1, 0) }));
      parts.push(plushLimb({ role: "arm", side: s,
        pts: [[s * 0.44, 1.4, 0.12], [s * 0.6, 1.1, 0.2], [s * 0.66, 0.72, 0.28], [s * 0.66, 0.36, 0.36], [s * 0.64, 0.16, 0.46]],
        radius: (u) => (0.13 + 0.025 * sm(u, 0.8, 0.9)) * capR(u, 0.88) }));
      parts.push(plushLimb({ role: "leg", side: s,
        pts: [[s * 0.3, 0.4, 0.2], [s * 0.36, 0.22, 0.62], [s * 0.38, 0.18, 1.05], [s * 0.38, 0.26, 1.4]],
        radius: (u) => (0.16 - 0.015 * u + 0.03 * sm(u, 0.8, 0.9)) * capR(u, 0.88), kb: (u, st) => 0.04 + st * 0.07 }));
    }
    parts.push(plushLimb({ role: "tail", np: 12, rings: 40, aseg: 10,
      pts: [[0, 0.3, -0.5], [0.2, 0.1, -0.85], [0.6, 0.07, -1.1], [1.1, 0.07, -1.18], [1.55, 0.09, -1.05], [1.85, 0.13, -0.85]],
      radius: (u) => (0.05 + 0.05 * sm(u, 0.84, 0.92)) * capR(u, 0.94), kb: (u, st) => 0.012 + st * 0.03,
      paint: (u) => ({ alt: sm(u, 0.82, 0.88), fur: 1 + 1.8 * sm(u, 0.82, 0.88) }) }));
    LION._head = head; LION._muzzle = muzzle;
    return parts;
  },
  face(g) {
    const h = LION._head, mz = LION._muzzle;
    for (const s of [-1, 1]) { const e = onBlob(h, s * 0.36, 0.26, 0.9, 0.035); addEye(g, e.p, e.n, 0.045); }
    const n = onBlob(mz, 0, 0.62, 0.78, 0.03);
    addNose(g, n.p, n.n, [0.085, 0.06, 0.045], 0x5a321e);
    addMouthY(g, n.p.clone().add(new V3(0, -0.045, -0.005)), 0.08, 0.075, 0x5a321e);
  }
};

/* Bunny: Jellycat Bashful bunny. Egg-shaped head that droops forward with the nose at the low front tip,
   bead eyes set on the sides, very long ears hanging beside head and body almost to the feet,
   tall neckless body, long arms resting on big forward feet, long soft silver pile */
const BUNNY_BODY = curveProf([[0, 1.6], [0.36, 1.55], [0.5, 1.36], [0.6, 0.96], [0.62, 0.56], [0.5, 0.2], [0, 0.1]], 40);
const BUNNY = {
  key: "bunny", name: "Bunny.", no: "No. 017", mass: [220, 160], vol: 2.1,
  desc: "수줍은 토끼. 앞으로 살짝 숙인 달걀 같은 머리, 옆에 붙은 콩알 눈, 발끝까지 축 늘어지는 긴 귀.",
  com: new V3(0, 0.95, 0.1), inertia: 0.75, cam: { y: 1.25, dist: 12.5 }, jig: [0.9, 2.6], faceY: 1.95, shadow: [1.3, 3.6], poseK: 0.3,
  palettes: {
    silver: { label: "Silver", root: 0xc6c2ba, tip: 0xf7f5f0, under: 0xfbfaf7 },
    beige: { label: "Beige", root: 0xbc9c78, tip: 0xf2dfc4, under: 0xf8eedf },
    blossom: { label: "Blossom", root: 0xc07c86, tip: 0xf2c4c6, under: 0xf8e0e2 },
    blue: { label: "Blue", root: 0x8296aa, tip: 0xd2dee8, under: 0xeaf0f4 }
  }, pal: "silver", pose: plushPose,
  specials: [
    { id: "hop", label: "Hop", run: () => { if (B.onGround) { const f = new V3(0, 0, 1).applyQuaternion(B.q).setY(0).normalize(); B.vel.set(f.x * 2.2, 6.5, f.z * 2.2); B.w.x += 1.5; } } },
    { id: "ears", label: "Perk ears", run: () => { act.ears = 0.9; } }
  ],
  parts() {
    const body = blobDefaults({ prof: BUNNY_BODY, seg: 52, scale: new V3(1, 1, 0.9), fur: 1.4 });
    // head: longer front-to-back than tall, tipped nose-down
    const head = ell(new V3(0, 1.92, 0.24), new V3(0.5, 0.48, 0.64), { n: 30, seg: 52, fur: 1.25, quat: new Q().setFromAxisAngle(new V3(1, 0, 0), 0.38) });
    const eyes = [-1, 1].map(s => onBlob(head, s * 0.66, 0.2, 0.58, 0).p), nose = onBlob(head, 0, -0.28, 0.96, 0).p;
    head.paint = (lp) => ({ fur: trimNear(eyes, 0.04, 0.12, 0.35)(lp) * trimNear([nose], 0.05, 0.16, 0.45)(lp), blush: 0.45 * gauss(lp, nose, 0.03) });
    const parts = [body, head];
    for (const s of [-1, 1]) {
      parts.push(plushLimb({ role: "ear", side: s, np: 14, rings: 50, aseg: 16, flat: 0.32,
        // ears start at the crown and drop straight down, lying flat against the side of the head and body
        seedDir: new V3(s * 0.8, 0, 0.6).normalize(),
        pts: [[s * 0.26, 2.3, -0.04], [s * 0.44, 2.26, -0.04], [s * 0.56, 2.0, 0.0], [s * 0.62, 1.62, 0.04], [s * 0.66, 1.2, 0.06], [s * 0.68, 0.82, 0.1], [s * 0.64, 0.52, 0.16]],
        radius: (u) => (0.11 + 0.17 * Math.sin(Math.min(1, u * 1.12) * Math.PI * 0.72)) * capR(u, 0.93),
        kb: (u, st) => 0.012 + st * 0.025, paint: () => ({ fur: 1.2 }) }));
      parts.push(plushLimb({ role: "arm", side: s, np: 9, rings: 32,
        pts: [[s * 0.44, 1.42, 0.2], [s * 0.56, 1.12, 0.34], [s * 0.54, 0.78, 0.5], [s * 0.44, 0.5, 0.64], [s * 0.36, 0.42, 0.74]],
        radius: (u) => (0.14 + 0.025 * sm(u, 0.8, 0.9)) * capR(u, 0.88), paint: () => ({ fur: 1.3 }) }));
      parts.push(plushLimb({ role: "leg", side: s, np: 7,
        pts: [[s * 0.3, 0.38, 0.18], [s * 0.34, 0.22, 0.48], [s * 0.36, 0.2, 0.8], [s * 0.36, 0.24, 1.06]],
        radius: (u) => (0.17 + 0.07 * sm(u, 0.45, 0.75)) * capR(u, 0.86), kb: (u, st) => 0.05 + st * 0.08, paint: () => ({ fur: 1.3 }) }));
    }
    parts.push(ell(new V3(0, 0.42, -0.62), new V3(0.17, 0.17, 0.17), { fur: 1.8, pole: new V3(0, 0, 1), lean: 0, paint: () => ({ under: 1 }) }));
    BUNNY._head = head;
    return parts;
  },
  face(g) {
    const h = BUNNY._head;
    for (const s of [-1, 1]) { const e = onBlob(h, s * 0.66, 0.2, 0.58, 0.035); addEye(g, e.p, e.n, 0.042); }
    const n = onBlob(h, 0, -0.28, 0.96, 0.04);
    addNose(g, n.p, n.n, [0.06, 0.04, 0.03], 0xe8a2aa);
    addMouthY(g, n.p.clone().add(new V3(0, -0.03, -0.012)), 0.055, 0.05, 0xb59090);
  }
};
const CREATURES = { octopus: OCTOPUS, spider: SPIDER, dragon: DRAGON, bear: BEAR, lion: LION, bunny: BUNNY };

/* ---------- fur shader (shell texturing) ---------- */
const NSH = 30;
const shared = {
  uLen: { value: 0.12 }, uForce: { value: new V3(0, -0.3, 0) }, uLight: { value: LIGHT }, uDensity: { value: 76 },
  uRoot: { value: new V3() }, uTip: { value: new V3() }, uAltRoot: { value: new V3() }, uAltTip: { value: new V3() },
  uUnder: { value: new V3() }, uBlush: { value: new V3(0.99, 0.5, 0.6) }
};
const VERT = `
attribute vec3 aT; attribute vec3 aB; attribute vec3 aSeed; attribute vec3 aSN; attribute vec2 aComb; attribute float aUnder, aFurMul, aBlush, aAlt;
uniform float uH, uLen; uniform vec3 uForce;
varying vec3 vSeed; varying vec3 vSN; varying vec3 vN; varying float len; varying vec3 vFur; varying float vUnder, vAgainst, vWith, vBlush, vAlt; varying vec3 vW;
void main(){
  vec3 lay = aT*aComb.x + aB*aComb.y;
  float h = uH;
  len = uLen * aFurMul; vBlush = aBlush; vAlt = aAlt;
  vec3 p = position + normal*len*h + lay*len*1.3*pow(h,1.5) + uForce*len*h*h;
  vFur = normalize(normal*0.55 + lay + uForce*0.25 + vec3(1e-4));
  vN = normal; vSeed = aSeed; vSN = aSN; vUnder = aUnder; vW = p;
  vAgainst = smoothstep(0.02, 0.5, -aComb.x);
  vWith = smoothstep(0.45, 0.9, length(aComb)) * step(0.0, aComb.x);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const FRAG = `
uniform float uH, uDensity; uniform vec3 uLight, uRoot, uTip, uAltRoot, uAltTip, uUnder, uBlush;
varying vec3 vSeed; varying vec3 vSN; varying vec3 vN; varying float len; varying vec3 vFur; varying float vUnder, vAgainst, vWith, vBlush, vAlt; varying vec3 vW;
float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
void main(){
  float h = uH, a = 1.0;
  if (h > 0.0) {
    // strands are seeded in 3D around the rest surface: no poles, no wrap seams
    vec3 g = vSeed * uDensity;
    vec3 cell = floor(g), f = g - cell;
    float rnd = hash(cell);
    vec3 c = vec3(0.5) + (vec3(hash(cell + 17.3), hash(cell + 91.7), hash(cell + 43.1)) - 0.5) * 0.5;
    vec3 dv = f - c; vec3 sn = normalize(vSN); dv -= sn * dot(dv, sn);
    float sl = 0.55 + 0.45 * rnd;
    float tall = mix(sl, 1.0, vAgainst * 0.6);
    if (h > tall || len < 0.004) discard;
    float rad = 0.68 * (1.0 - h / tall) + 0.04;
    a = smoothstep(rad, rad * 0.55, length(dv));
    if (a < 0.3) discard;
  }
  vec3 N = normalize(vN), L = normalize(uLight), V = normalize(cameraPosition - vW);
  float hh = smoothstep(0.0, 0.9, h);
  vec3 base = mix(mix(uRoot, uTip, hh), mix(uAltRoot, uAltTip, hh), vAlt);
  base = mix(base, uUnder * mix(0.82, 1.0, h), vUnder);
  base = mix(base, uBlush * mix(0.85, 1.1, h), vBlush);
  float diff = clamp(dot(N, L) * 0.55 + 0.5, 0.0, 1.0);
  vec3 T = normalize(vFur);
  float tl = dot(T, L), tv = dot(T, V);
  float sk = max(0.0, tl * tv + sqrt(max(0.0, 1.0 - tl*tl)) * sqrt(max(0.0, 1.0 - tv*tv)));
  float spec = pow(sk, 36.0) * (0.12 + 0.35 * vWith) * h;
  float ao = len < 0.004 ? 0.92 : mix(0.46, 1.0, pow(h, 0.75));
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.22 * h;
  vec3 c3 = base * (diff * 0.82 + 0.26) * ao;
  c3 = mix(c3, uUnder * (diff * 0.4 + 0.64) * mix(0.8, 1.0, h), vUnder * 0.85);
  c3 *= mix(1.0, 0.68, vAgainst);
  c3 += vec3(spec) + rim * mix(uTip, vec3(1.0), 0.5);
  gl_FragColor = vec4(c3, a);
}`;
const shells = [];
for (let l = 0; l <= NSH; l++) {
  const m = new THREE.ShaderMaterial({ uniforms: Object.assign({ uH: { value: l / NSH } }, shared), vertexShader: VERT, fragmentShader: FRAG });
  if (l > 0) m.alphaToCoverage = true;
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
  mesh.frustumCulled = false; mesh.renderOrder = l; scene.add(mesh); shells.push(mesh);
}
const baseMesh = shells[0];
const wire = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x23212b, wireframe: true, transparent: true, opacity: 0.22, depthTest: false }));
wire.frustumCulled = false; wire.visible = false; wire.renderOrder = 99; scene.add(wire);
const face = new THREE.Group(); scene.add(face);
const limbDecor = new THREE.Group(); scene.add(limbDecor);
const silk = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(), new V3()]), new THREE.LineBasicMaterial({ color: 0x9d968c, transparent: true, opacity: 0.8 }));
silk.frustumCulled = false; silk.visible = false; scene.add(silk);

/* shadow */
const SH_PTS = 40;
const shadowMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { uC: { value: new V3() }, uH: { value: 0 }, uS: { value: new THREE.Vector2(2.2, 5) }, uP: { value: Array.from({ length: SH_PTS }, () => new V3(0, 99, 0)) } },
  vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform vec3 uC; uniform float uH; uniform vec2 uS; uniform vec3 uP[${SH_PTS}]; varying vec3 vW;
  void main(){
    vec2 d = vW.xz - uC.xz; float lift = clamp(uH / 3.0, 0.0, 1.0);
    float s = exp(-dot(d,d) / mix(uS.x, uS.y, lift)) * 0.28 * (1.0 - lift * 0.7);
    s += exp(-dot(d,d) / 0.35) * 0.22 * (1.0 - lift);
    for (int i = 0; i < ${SH_PTS}; i++) { vec2 e = vW.xz - uP[i].xz; float hy = uP[i].y;
      s += exp(-dot(e,e) / (0.05 + hy * 0.25)) * 0.14 * (1.0 - smoothstep(0.1, 1.2, hy)); }
    gl_FragColor = vec4(0.22, 0.17, 0.12, min(s, 0.6));
  }`
});
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), shadowMat);
shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.001; shadow.renderOrder = -1; scene.add(shadow);

/* ---------- geometry state (rebuilt per creature) ---------- */
let C = null, blobs = [], limbs = [], NV = 0, RIG = 0, geo = null;
let pos, nor, tan, bit, comb, dent, dentV, dentF, rP, rN, rT, rB, rJ, rBlob;
let aPos, aNor, aTan, aBit, aComb;
const COMB0 = 0.42;
let combInit = new Float32Array(0);
function resetComb() { for (let i = 0; i < NV; i++) { comb[i * 2] = combInit[i]; comb[i * 2 + 1] = 0; } if (aComb) aComb.needsUpdate = true; }

function build(creature) {
  C = creature;
  const parts = C.parts();
  blobs = parts.filter(p => p.kind === "blob"); limbs = parts.filter(p => p.kind === "limb");
  let nr = 0;
  blobs.forEach((b, bi) => { b.id = bi; b.start = nr; nr += b.prof.length * (b.seg + 1); b.aq = new Q(); });
  RIG = nr;
  limbs.forEach(l => {
    const curve = new THREE.CatmullRomCurve3(l.pts, false, "centripetal");
    l.rest = curve.getSpacedPoints(l.np - 1);
    l.rad = l.rest.map((p, i) => l.radius(i / (l.np - 1)));
    l.rest.forEach((p, i) => { if (i > 1) p.y = Math.max(p.y, l.rad[i] + 0.004); });
    l.restLen = []; for (let i = 0; i < l.np - 1; i++) l.restLen.push(l.rest[i].distanceTo(l.rest[i + 1]));
    l.len = l.restLen.reduce((s, v) => s + v, 0);
    l.x = l.rest.map(p => p.clone()); l.o = l.rest.map(p => p.clone()); l.posed = l.rest.map(p => p.clone());
    l.spine = Array.from({ length: l.rings }, () => new V3()); l.spT = Array.from({ length: l.rings }, () => new V3());
    l.avgR = l.rad.reduce((s, v) => s + v, 0) / l.np;
    l.push = l.rest.map(() => new V3());
    l.colR = l.rad.map(r => r * (l.flat ? l.flat + 0.12 : 0.8));
    l.start = nr; nr += l.rings * (l.aseg + 1);
  });
  NV = nr;
  pos = new Float32Array(NV * 3); nor = new Float32Array(NV * 3); tan = new Float32Array(NV * 3); bit = new Float32Array(NV * 3);
  comb = new Float32Array(NV * 2); combInit = new Float32Array(NV).fill(COMB0); dent = new Float32Array(NV); dentV = new Float32Array(NV); dentF = new Float32Array(NV);
  const seed = new Float32Array(NV * 3), seedN = new Float32Array(NV * 3), under = new Float32Array(NV), alt = new Float32Array(NV), blush = new Float32Array(NV), furMul = new Float32Array(NV);
  rP = new Float32Array(RIG * 3); rN = new Float32Array(RIG * 3); rT = new Float32Array(RIG * 3); rB = new Float32Array(RIG * 3);
  rJ = new Float32Array(RIG); rBlob = new Uint8Array(RIG);
  const idx = [];
  const lp = new V3(), ln = new V3(), lt = new V3(), lb = new V3();
  for (const b of blobs) {
    const P = b.prof, n = P.length;
    const maxR = Math.max(...P.map(p => p[0]));
    if (b.pole) {
      // Star-shaped remesh: the same surface, but with its grid poles turned to face `pole`
      // (front) and away from it (back). Fur then flows front-to-back with no crown parting.
      const ys = P.map(p => p[1]), yc = b.starY != null ? b.starY : (Math.max(...ys) + Math.min(...ys)) / 2;
      const pa = P.map(p => Math.atan2(p[0], p[1] - yc)), pr = P.map(p => Math.hypot(p[0], p[1] - yc));
      const rho = (al) => { for (let k = 0; k < n - 1; k++) if (al <= pa[k + 1] || k === n - 2) { const t = Math.max(0, Math.min(1, (al - pa[k]) / ((pa[k + 1] - pa[k]) || 1))); return pr[k] + (pr[k + 1] - pr[k]) * t; } return pr[n - 1]; };
      const lq = new Q().setFromUnitVectors(new V3(0, 1, 0), b.pole.clone().normalize());
      const S = [];
      for (let k = 0; k < n; k++) { const row = []; const th = k / (n - 1) * Math.PI;
        for (let j = 0; j <= b.seg; j++) { const ph = j / b.seg * Math.PI * 2;
          const d = new V3(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)).applyQuaternion(lq);
          const al = Math.acos(Math.max(-1, Math.min(1, d.y)));
          row.push(d.multiplyScalar(rho(al)).add(new V3(0, yc, 0)));
        } S.push(row); }
      const c0 = new V3(0, yc, 0), dT = new V3(), dP = new V3(), nn = new V3(), sh = new V3();
      for (let k = 0; k < n; k++) for (let j = 0; j <= b.seg; j++) {
        const i = b.start + k * (b.seg + 1) + j, s = S[k][j], th = k / (n - 1) * Math.PI;
        dT.subVectors(S[Math.min(n - 1, k + 1)][j], S[Math.max(0, k - 1)][j]);
        const jm = j === 0 ? b.seg - 1 : j - 1, jp = j === b.seg ? 1 : j + 1;
        dP.subVectors(S[k][jp], S[k][jm]);
        nn.crossVectors(dP, dT);
        sh.subVectors(s, c0);
        if (nn.lengthSq() < 1e-10) nn.copy(sh); if (nn.dot(sh) < 0) nn.negate(); nn.normalize();
        if (dT.lengthSq() < 1e-10) dT.set(0, 0, 1);
        dT.addScaledVector(nn, -dT.dot(nn)).normalize();
        lp.set(s.x * b.scale.x, s.y * b.scale.y, s.z * b.scale.z).applyQuaternion(b.quat).add(b.center);
        ln.set(nn.x / b.scale.x, nn.y / b.scale.y, nn.z / b.scale.z).normalize().applyQuaternion(b.quat);
        lt.set(dT.x * b.scale.x, dT.y * b.scale.y, dT.z * b.scale.z).normalize().applyQuaternion(b.quat);
        lt.addScaledVector(ln, -lt.dot(ln)).normalize(); lb.crossVectors(ln, lt);
        rP.set([lp.x, lp.y, lp.z], i * 3); rN.set([ln.x, ln.y, ln.z], i * 3); rT.set([lt.x, lt.y, lt.z], i * 3); rB.set([lb.x, lb.y, lb.z], i * 3);
        rJ[i] = sm(lp.y, C.jig[0], C.jig[1]); rBlob[i] = b.id;
        seed.set([lp.x, lp.y, lp.z], i * 3); seedN.set([ln.x, ln.y, ln.z], i * 3);
        combInit[i] = COMB0 * (b.lean == null ? 1 : b.lean) * sm(Math.sin(th), 0.05, 0.45);
        let phi = Math.atan2(s.z, s.x); if (phi < 0) phi += Math.PI * 2;
        const pt = b.paint ? b.paint(lp, ln, { phi, r: Math.hypot(s.x, s.z), y: s.y, k, t: Math.acos(Math.max(-1, Math.min(1, sh.y / (sh.length() || 1)))) / Math.PI }) : {};
        alt[i] = pt.alt || 0; under[i] = pt.under || 0; blush[i] = pt.blush || 0; furMul[i] = (pt.fur == null ? 1 : pt.fur) * (b.fur == null ? 1 : b.fur);
        if (k < n - 1 && j < b.seg) { const q = i + b.seg + 1; idx.push(i, i + 1, q, i + 1, q + 1, q); }
      }
      continue;
    }
    for (let k = 0; k < n; k++) {
      const a = P[Math.max(0, k - 1)], c = P[Math.min(n - 1, k + 1)];
      let dr = c[0] - a[0], dy = c[1] - a[1]; const ll = Math.hypot(dr, dy) || 1; dr /= ll; dy /= ll;
      for (let j = 0; j <= b.seg; j++) {
        const i = b.start + k * (b.seg + 1) + j, ph = j / b.seg * Math.PI * 2, cs = Math.cos(ph), sn = Math.sin(ph), y = P[k][1];
        const r = P[k][0] * (b.rmod ? b.rmod(ph, k / (n - 1)) : 1);
        lp.set(r * cs * b.scale.x, y * b.scale.y, r * sn * b.scale.z).applyQuaternion(b.quat).add(b.center);
        ln.set(-dy * cs / b.scale.x, dr / b.scale.y, -dy * sn / b.scale.z).normalize().applyQuaternion(b.quat);
        lt.set(dr * cs * b.scale.x, dy * b.scale.y, dr * sn * b.scale.z).normalize().applyQuaternion(b.quat);
        lb.set(-sn * b.scale.x, 0, cs * b.scale.z).normalize().applyQuaternion(b.quat);
        rP.set([lp.x, lp.y, lp.z], i * 3); rN.set([ln.x, ln.y, ln.z], i * 3); rT.set([lt.x, lt.y, lt.z], i * 3); rB.set([lb.x, lb.y, lb.z], i * 3);
        rJ[i] = sm(lp.y, C.jig[0], C.jig[1]); rBlob[i] = b.id;
        seed.set([lp.x, lp.y, lp.z], i * 3); seedN.set([ln.x, ln.y, ln.z], i * 3);
        combInit[i] = COMB0 * (b.lean == null ? 1 : b.lean) * sm(r / maxR, 0.03, 0.4);
        const pt = b.paint ? b.paint(lp, ln, { phi: ph, r, y, k, t: k / (n - 1) }) : {};
        alt[i] = pt.alt || 0; under[i] = pt.under || 0; blush[i] = pt.blush || 0; furMul[i] = (pt.fur == null ? 1 : pt.fur) * (b.fur == null ? 1 : b.fur);
        if (k < n - 1 && j < b.seg) { const q = i + b.seg + 1; idx.push(i, i + 1, q, i + 1, q + 1, q); }
      }
    }
  }
  limbs.forEach((l, li) => {
    for (let r = 0; r < l.rings; r++) for (let j = 0; j <= l.aseg; j++) {
      const i = l.start + r * (l.aseg + 1) + j, ang = j / l.aseg * Math.PI * 2, u = r / (l.rings - 1);
      seed.set([ang / (Math.PI * 2) * Math.max(4, Math.round(Math.PI * 2 * l.avgR * 76)) / 76 + li * 7.3, u * l.len, li * 3.1], i * 3); seedN.set([0, 0, 1], i * 3);
      const pt = l.paint ? l.paint(u, ang) : {};
      alt[i] = pt.alt || 0; under[i] = pt.under || 0; blush[i] = 0; furMul[i] = (pt.fur == null ? 1 : pt.fur) * (1 - 0.6 * sm(u, 0.93, 1));
      if (r < l.rings - 1 && j < l.aseg) { const q = i + l.aseg + 1; idx.push(i, i + 1, q, i + 1, q + 1, q); }
    }
  });
  resetComb();
  if (geo) geo.dispose();
  geo = new THREE.BufferGeometry();
  const dyn = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
  aPos = dyn(pos, 3); aNor = dyn(nor, 3); aTan = dyn(tan, 3); aBit = dyn(bit, 3); aComb = dyn(comb, 2);
  geo.setAttribute("position", aPos); geo.setAttribute("normal", aNor); geo.setAttribute("aT", aTan); geo.setAttribute("aB", aBit); geo.setAttribute("aComb", aComb);
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3)); geo.setAttribute("aSN", new THREE.BufferAttribute(seedN, 3)); geo.setAttribute("aUnder", new THREE.BufferAttribute(under, 1));
  geo.setAttribute("aAlt", new THREE.BufferAttribute(alt, 1)); geo.setAttribute("aBlush", new THREE.BufferAttribute(blush, 1)); geo.setAttribute("aFurMul", new THREE.BufferAttribute(furMul, 1));
  geo.setIndex(idx);
  shells.forEach(m => { m.geometry = geo; }); wire.geometry = geo;
  // limb decorations (claws, tail spikes, spade) ride on the limb frames
  limbDecor.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  limbDecor.clear();
  for (const l of limbs) {
    l.dec = (l.decor || []).map(d => {
      let m;
      if (d.type === "claw") m = new THREE.Mesh(new THREE.ConeGeometry(d.small ? 0.028 : 0.04, d.small ? 0.11 : 0.15, 12), MAT.fang);
      else if (d.type === "spike") m = new THREE.Mesh(new THREE.ConeGeometry(d.r, d.h, 14), MAT.alt);
      else if (d.type === "pad") { m = new THREE.Mesh(new THREE.CylinderGeometry(d.r, d.r * 0.92, 0.035, 28), MAT.pad); m.scale.set(d.sx, 1, d.sz); }
      else { m = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), MAT.alt); m.scale.set(0.24, 0.055, 0.3); }
      limbDecor.add(m);
      return Object.assign({ m, ring: Math.round(d.u * (l.rings - 1)) }, d);
    });
    l.fN = Array.from({ length: l.rings }, () => new V3()); l.fB = Array.from({ length: l.rings }, () => new V3());
  }
  // face
  face.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  face.clear();
  C.face(face);
  shadowMat.uniforms.uS.value.set(C.shadow[0], C.shadow[1]);
  COM.copy(C.com);
  blobs.forEach(prepCollider);
  // joints that sit inside the body in the rest pose (limb roots) are exempt
  // only joints whose centre is buried in the body at rest (the limb roots) skip body collision
  for (const l of limbs) l.inside = l.rest.map((p, i) => i < 1 || blobs.some(b => pushOut(b, p, 0, false) > 0));
  // contact samples: a sparse sprinkle of the fur surface, plus limb joints that rest on the floor
  contactPts = [];
  const stride = Math.max(1, Math.floor(RIG / 320));
  for (let i = 0; i < RIG; i += stride) contactPts.push({ p: new V3(rP[i * 3], rP[i * 3 + 1], rP[i * 3 + 2]), r: 0.02 });
  for (const l of limbs) for (let i = 1; i < l.np; i++) if (l.rest[i].y < Math.max(l.rad[i], 0.08) + 0.08) contactPts.push({ p: l.rest[i].clone(), r: l.rest[i].y });
}

/* ---------- body state ---------- */
const B = { pos: new V3(), vel: new V3(), lastVel: new V3(), q: new Q(), w: new V3(), sq: 0, sqv: 0, J: new V3(), Jv: new V3(), onGround: true };
const G = 14, UP = new V3(0, 1, 0), FWD = new V3(0, 0, 1);
const scale = new V3(1, 1, 1);
const tmp = new V3(), tmp2 = new V3(), tmp3 = new V3(), off = new V3();
// B.pos is the centre of mass; the body rotates about it
function toWorld(local, out) { return out.set((local.x - COM.x) * scale.x, (local.y - COM.y) * scale.y, (local.z - COM.z) * scale.z).applyQuaternion(B.q).add(B.pos); }
function applyImpulse(J, r, invM, invI) { B.vel.addScaledVector(J, invM); B.w.addScaledVector(tmpI.crossVectors(r, J), invI); }
function applyForce(F, r, dt, invM, invI) { B.vel.addScaledVector(F, invM * dt); B.w.addScaledVector(tmpI.crossVectors(r, F), invI * dt); }
const tmpI = new V3(), COM = new V3();
let contactPts = [], silkLen = 3, silkAnchor = new V3();
const SILK_AT = new V3(0, 2.0, -0.95);

const grab = { local: new V3(), kind: null, limb: -1, pi: -1, plane: new THREE.Plane(), target: new V3(), offset: new V3(), lastT: new V3(), vel: new V3() };
const press = { on: false, point: new V3(), normal: new V3(), limb: -1, pi: -1 };
let smoothT = 0;

/* ---------- limb vs body collision ----------
   Each lathed blob doubles as a collider: a joint is moved out along the nearest
   point of the blob's profile curve, so arms slide over the head instead of through it. */
const cV = new V3();
function prepCollider(b) {
  b.col = null;
  if (b.noCollide || b.anim || b.rmod) return;
  const P = b.prof, n = P.length;
  for (let k = 1; k < n; k++) if (P[k][1] > P[k - 1][1] + 1e-6) return; // only profiles that run top to bottom
  const segN = [];
  for (let k = 0; k < n - 1; k++) { const dr = P[k + 1][0] - P[k][0], dy = P[k + 1][1] - P[k][1], l = Math.hypot(dr, dy) || 1; segN.push([-dy / l, dr / l]); }
  b.col = { P, segN, ymin: P[n - 1][1], ymax: P[0][1], rmax: Math.max(...P.map(p => p[0])) };
  b.qInv = b.quat.clone().invert(); b.sAvg = (b.scale.x + b.scale.y + b.scale.z) / 3;
}
// returns how far `lp` (body-local) sits inside blob b, padded by rad; moves it out when apply is set
function pushOut(b, lp, rad, apply) {
  const c = b.col; if (!c) return 0;
  cV.copy(lp).sub(b.center).applyQuaternion(b.qInv);
  cV.x /= b.scale.x; cV.y /= b.scale.y; cV.z /= b.scale.z;
  const rr = rad / b.sAvg;
  if (cV.y > c.ymax + rr || cV.y < c.ymin - rr) return 0;
  const r = Math.hypot(cV.x, cV.z);
  if (r > c.rmax + rr) return 0;
  let best = 1e9, br = 0, by = 0, bn = null;
  const P = c.P;
  for (let k = 0; k < P.length - 1; k++) {
    const ax = P[k][0], ay = P[k][1], dx = P[k + 1][0] - ax, dy = P[k + 1][1] - ay;
    const t = Math.max(0, Math.min(1, ((r - ax) * dx + (cV.y - ay) * dy) / (dx * dx + dy * dy || 1)));
    const px = ax + dx * t, py = ay + dy * t, d2 = (r - px) * (r - px) + (cV.y - py) * (cV.y - py);
    if (d2 < best) { best = d2; br = px; by = py; bn = c.segN[k]; }
  }
  const sd = (r - br) * bn[0] + (cV.y - by) * bn[1];
  if (sd >= rr) return 0;
  const push = rr - sd;
  if (apply) {
    const nr = Math.max(0, r + bn[0] * push), ny = cV.y + bn[1] * push;
    const ux = r > 1e-5 ? cV.x / r : 0, uz = r > 1e-5 ? cV.z / r : 1;
    cV.set(ux * nr * b.scale.x, ny * b.scale.y, uz * nr * b.scale.z).applyQuaternion(b.quat).add(b.center);
    lp.copy(cV);
  }
  return push * b.sAvg;
}
const qInvB = new Q(), lpC = new V3(), oldX = new V3(), dX = new V3(), grabClamped = new V3();
// Move a joint out of the body (position only) and remember the push, so the step can
// cancel the bounce afterwards instead of turning every push into speed.
function collideBody(A, i) {
  if (A.inside[i]) return false;
  const p = A.x[i];
  qInvB.copy(B.q).invert();
  lpC.copy(p).sub(B.pos).applyQuaternion(qInvB).divide(scale).add(COM);
  let hit = false;
  for (const b of blobs) if (b.col && pushOut(b, lpC, A.colR[i], true) > 0) hit = true;
  if (!hit) return false;
  oldX.copy(p); toWorld(lpC, p);
  A.push[i].add(dX.subVectors(p, oldX));
  return true;
}
// After a step: a joint that was pushed keeps its sliding speed (minus a little friction)
// but loses all speed along the push, so contact never pumps energy into a limb.
function settleContacts(A) {
  for (let i = 1; i < A.np; i++) {
    const P = A.push[i]; const pl = P.length();
    if (pl < 1e-7) continue;
    dX.subVectors(A.x[i], A.o[i]);
    P.divideScalar(pl);
    dX.addScaledVector(P, -dX.dot(P)).multiplyScalar(0.9);
    A.o[i].subVectors(A.x[i], dX);
    P.set(0, 0, 0);
  }
}
// clamp a point (world) out of the body, for the hand that drags a limb
function clampOutOfBody(pt, rad) {
  qInvB.copy(B.q).invert();
  lpC.copy(pt).sub(B.pos).applyQuaternion(qInvB).divide(scale).add(COM);
  let hit = false;
  for (const b of blobs) if (b.col && pushOut(b, lpC, rad, true) > 0) hit = true;
  if (hit) toWorld(lpC, pt);
}
// Joints of different limbs (an ear and an arm, two octopus arms) push each other apart.
function collideLimbs() {
  for (let it = 0; it < 2; it++) for (let a = 0; a < limbs.length; a++) for (let c = a + 1; c < limbs.length; c++) {
    const A = limbs[a], Cn = limbs[c];
    for (let i = 2; i < A.np; i++) {
      if (A.inside[i]) continue;
      const p = A.x[i];
      for (let j = 2; j < Cn.np; j++) {
        if (Cn.inside[j]) continue;
        const q = Cn.x[j], min = (A.colR[i] + Cn.colR[j]) * 0.98;
        dX.subVectors(p, q); const d = dX.length();
        if (d >= min || d < 1e-6) continue;
        dX.multiplyScalar((min - d) / d * 0.5);
        p.add(dX); A.push[i].add(dX); q.sub(dX); Cn.push[j].sub(dX);
      }
    }
  }
  for (const A of limbs) { for (let i = 1; i < A.np; i++) collideBody(A, i); settleContacts(A); }
}

/* ---------- physics ---------- */
function stepPhysics(dt) {
  const st = S.stuff, dp = S.damp;
  simT += dt;
  for (const k in act) if (act[k] > 0) act[k] = Math.max(0, act[k] - dt);
  wingPh += dt * (act.flap > 0 ? 17 : 2.2);
  B.lastVel.copy(B.vel);
  const hanging = S.hang && C.key === "spider";
  const invM = 1, invI = 1 / C.inertia;
  // ---- forces, all applied at real points so they produce torque ----
  B.vel.y -= G * dt;
  if (act.flap > 0) { B.vel.y += G * 1.5 * dt; if (B.vel.y > 3) B.vel.y = 3; }
  if (grab.kind === "body") {
    // the grabbed spot hangs from the hand on a stiff, damped spring
    toWorld(grab.local, tmp);
    const r = tmp2.subVectors(tmp, B.pos);
    const vp = tmp3.crossVectors(B.w, r).add(B.vel);
    const F = new V3().subVectors(grab.target, tmp).multiplyScalar(260).addScaledVector(vp, -22);
    applyForce(F, r, dt, invM, invI);
  }
  if (hanging) {
    // silk: a rope that only pulls, reeling in to its rest length
    silkLen = Math.max(1.3, silkLen - 2.5 * dt);
    toWorld(SILK_AT, tmp);
    const d = tmp2.subVectors(silkAnchor, tmp), dl = d.length();
    if (dl > silkLen) {
      d.divideScalar(dl);
      const r = new V3().subVectors(tmp, B.pos), vp = new V3().crossVectors(B.w, r).add(B.vel);
      const F = d.clone().multiplyScalar((dl - silkLen) * 320 - vp.dot(d) * 18);
      if (F.dot(d) > 0) applyForce(F, r, dt, invM, invI);
    }
  }
  if (act.shake > 0 && grab.kind !== "body") {
    // rattle along the body's own left-right axis, with a twisting wobble
    const side = tmp.set(1, 0, 0).applyQuaternion(B.q).setY(0).normalize();
    const v = Math.cos(simT * 26) * 3.4 * Math.min(1, act.shake * 2);
    B.vel.x = side.x * v; B.vel.z = side.z * v;
    B.w.y += Math.sin(simT * 26) * 30 * dt;
    B.Jv.addScaledVector(side, Math.sin(simT * 26) * 9 * dt);
  }
  if (act.walk > 0 && B.onGround) {
    const f = tmp.copy(FWD).applyQuaternion(B.q).setY(0).normalize();
    B.vel.x = f.x * 1.15; B.vel.z = f.z * 1.15; B.w.y = 0.45;
  }
  // a stuffed toy is bottom-heavy: when it touches the floor it slowly rolls back upright
  if (B.onGround && !grab.kind) {
    const upB = tmp.copy(UP).applyQuaternion(B.q);
    const ax = tmp2.crossVectors(upB, UP);
    // nudge a perfectly inverted toy off its balance point
    if (upB.y < -0.97 && ax.lengthSq() < 1e-3) ax.set(1, 0, 0);
    // torque grows with tilt; past sideways it keeps a firm minimum so a toy on its back still rolls over
    const tl = ax.length(), mag = upB.y < 0.2 ? Math.max(tl, 0.6) * 50 : tl * 30;
    if (tl > 1e-6) B.w.addScaledVector(ax, mag / tl * dt);
  }
  B.vel.multiplyScalar(Math.exp(-0.08 * dt));
  B.w.multiplyScalar(Math.exp(-(hanging ? 0.8 : 0.35) * dt));

  // ---- integrate ----
  B.pos.addScaledVector(B.vel, dt);
  const wl = B.w.length();
  if (wl > 1e-6) { const dq = new Q().setFromAxisAngle(tmp3.copy(B.w).divideScalar(wl), wl * dt); B.q.premultiply(dq).normalize(); }

  // ---- floor contacts: every sample point on the body, plus resting feet ----
  const cts = []; let depth = 0;
  for (const c of contactPts) {
    toWorld(c.p, tmp);
    const pen = c.r - tmp.y;
    if (pen > 0) { cts.push(new V3().subVectors(tmp, B.pos).setY(tmp.y - c.r - B.pos.y)); if (pen > depth) depth = pen; }
  }
  B.onGround = cts.length > 0;
  if (cts.length) {
    const e = 0.32 - dp * 0.26, mu = 0.7;
    let impact = 0;
    const n = UP, rxn = new V3(), vp = new V3(), vt = new V3();
    for (let pass = 0; pass < 4; pass++) {
      for (const r of cts) {
        vp.crossVectors(B.w, r).add(B.vel);
        const vn = vp.y;
        if (vn >= 0) continue;
        if (pass === 0) impact = Math.max(impact, -vn);
        rxn.crossVectors(r, n);
        const kN = invM + invI * rxn.lengthSq();
        const jn = -(1 + (vn < -1.2 ? e : 0)) * vn / kN / (pass === 0 ? Math.max(1, cts.length * 0.35) : 1);
        applyImpulse(new V3(0, jn, 0), r, invM, invI);
        // Coulomb friction at the same point
        vp.crossVectors(B.w, r).add(B.vel); vt.set(vp.x, 0, vp.z);
        const vtl = vt.length();
        if (vtl > 1e-5) {
          vt.divideScalar(vtl);
          const rxt = new V3().crossVectors(r, vt);
          const jt = Math.min(vtl / (invM + invI * rxt.lengthSq()), mu * jn);
          applyImpulse(vt.multiplyScalar(-jt), r, invM, invI);
        }
      }
    }
    B.pos.y += depth;
    B.w.multiplyScalar(Math.exp(-2.2 * dt));
    if (impact > 1.5) { B.sqv += impact * (0.42 - st * 0.18); B.Jv.y -= impact * 0.06; for (let i = 0; i < NV; i++) dentV[i] += (Math.random() - 0.5) * impact * 0.02; }
  }
  const R = 7.5, rr = Math.hypot(B.pos.x, B.pos.z);
  if (rr > R) { B.pos.x *= R / rr; B.pos.z *= R / rr; B.vel.x *= -0.4; B.vel.z *= -0.4; }

  const ks = 150 + st * 300, cs = 3 + dp * 26;
  B.sqv += (-ks * B.sq - cs * B.sqv) * dt; B.sq += B.sqv * dt;
  B.sq = THREE.MathUtils.clamp(B.sq, -0.28, 0.42);
  scale.set(1 + B.sq * 0.55, 1 - B.sq, 1 + B.sq * 0.55);
  const acc = tmp.copy(B.vel).sub(B.lastVel).divideScalar(dt);
  if (acc.length() > 400) acc.setLength(400);
  const kj = 60 + st * 160, cj = 2.5 + dp * 20;
  B.Jv.addScaledVector(B.J, -kj * dt).addScaledVector(B.Jv, -cj * dt).addScaledVector(acc, -0.0045 * dt * 60);
  B.J.addScaledVector(B.Jv, dt);
  if (B.J.length() > 0.4) B.J.setLength(0.4);

  if (press.on && press.limb < 0) applyForce(tmp2.copy(press.normal).multiplyScalar(-2.5), tmp.subVectors(press.point, B.pos), dt, 1, 1 / C.inertia);

  const kd = 45 + st * 230, cd = 5 + dp * 34;
  for (let i = 0; i < NV; i++) {
    dentV[i] += (dentF[i] * kd - kd * dent[i] - cd * dentV[i]) * dt;
    dent[i] += dentV[i] * dt;
    if (dent[i] > 0.35) { dent[i] = 0.35; dentV[i] = 0; }
    if (dent[i] < -0.12) dent[i] = -0.12;
  }

  // limbs: verlet chains whose bend is measured from the previous joint, in the body's frame
  const air = 0.006 + dp * 0.05, g = G * dt * dt;
  for (let L = 0; L < limbs.length; L++) {
    const A = limbs[L], X = A.x, O = A.o, np = A.np;
    let posing = false;
    for (let i = 0; i < np; i++) {
      off.set(0, 0, 0);
      if (C.pose && C.pose(L, A, i, i / (np - 1), simT, off)) posing = true;
      A.posed[i].copy(A.rest[i]).add(off);
    }
    toWorld(A.rest[0], X[0]); O[0].copy(X[0]);
    for (let i = 1; i < np; i++) {
      const p = X[i], o = O[i];
      const vx = (p.x - o.x) * (1 - air), vy = (p.y - o.y) * (1 - air), vz = (p.z - o.z) * (1 - air);
      o.copy(p); p.x += vx; p.y += vy - g; p.z += vz;
      const u = i / (np - 1);
      let kb = i === 1 ? 0.6 : A.kb(u, st);
      // off the floor nothing holds the limbs up: stuffing alone can't fight gravity, so they go slack
      if (!B.onGround && i > 1) kb *= S.hang && C.key === "spider" ? 0.12 : 0.3;
      if (posing) kb = Math.max(kb, C.poseK);
      tmp.copy(A.posed[i]).sub(A.posed[i - 1]).multiply(scale).applyQuaternion(B.q).add(X[i - 1]);
      p.lerp(tmp, Math.min(kb, 0.9));
      if (press.on && press.limb === L) p.addScaledVector(press.normal, -0.5 * dt * Math.exp(-Math.pow(i - press.pi, 2) / 2.2));
    }
    if (grab.kind === "limb" && grab.limb === L) { grabClamped.copy(grab.target); if (!A.inside[grab.pi]) clampOutOfBody(grabClamped, A.rad[grab.pi] * 0.8); }
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < np - 1; i++) {
        const p = X[i], q = X[i + 1];
        tmp.subVectors(q, p); const Ln = tmp.length() || 1e-6;
        const diff = (Ln - A.restLen[i]) / Ln;
        if (i === 0) q.addScaledVector(tmp, -diff);
        else { p.addScaledVector(tmp, 0.5 * diff); q.addScaledVector(tmp, -0.5 * diff); }
      }
      // the hand wins over the chain, but the body wins over the hand: collision runs last
      if (grab.kind === "limb" && grab.limb === L) X[grab.pi].copy(grabClamped);
      for (let i = 1; i < np; i++) collideBody(A, i);
    }
    for (let i = 1; i < np; i++) {
      const p = X[i], o = O[i], r = A.rad[i] * 0.92;
      if (p.y < r) { p.y = r; o.x = p.x - (p.x - o.x) * 0.55; o.z = p.z - (p.z - o.z) * 0.55; if (o.y < p.y) o.y = p.y - (p.y - o.y) * 0.3; }
    }
    if (grab.kind === "limb" && grab.limb === L) {
      const d = tmp.subVectors(grab.target, X[0]); const reach = A.len * (grab.pi / (np - 1)) * 1.02;
      const ex = d.length() - reach;
      if (ex > 0) { d.setLength(ex * 60); applyForce(d, tmp2.subVectors(X[0], B.pos), dt, 1, 1 / C.inertia); }
    }
  }

  collideLimbs();

  if (smoothT > 0) {
    smoothT -= dt; const k = 1 - Math.exp(-6 * dt);
    for (let i = 0; i < NV; i++) { comb[i * 2] += (combInit[i] - comb[i * 2]) * k; comb[i * 2 + 1] *= 1 - k; }
    aComb.needsUpdate = true;
  }
}

/* ---------- geometry rebuild ---------- */
const pV = new V3(), nV = new V3(), tV = new V3(), bV = new V3(), decM = new THREE.Matrix4();
const cr = (p0, p1, p2, p3, t, out) => {
  const t2 = t * t, t3 = t2 * t;
  return out.set(
    0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3));
};
function rebuild() {
  for (const b of blobs) if (b.anim) b.aq.setFromAxisAngle(b.axis, b.anim());
  for (let i = 0; i < RIG; i++) {
    const i3 = i * 3, b = blobs[rBlob[i]];
    pV.set(rP[i3], rP[i3 + 1], rP[i3 + 2]); nV.set(rN[i3], rN[i3 + 1], rN[i3 + 2]);
    tV.set(rT[i3], rT[i3 + 1], rT[i3 + 2]); bV.set(rB[i3], rB[i3 + 1], rB[i3 + 2]);
    if (b.anim) { pV.sub(b.pivot).applyQuaternion(b.aq).add(b.pivot); nV.applyQuaternion(b.aq); tV.applyQuaternion(b.aq); bV.applyQuaternion(b.aq); }
    pV.addScaledVector(nV, -dent[i]);
    pV.sub(COM).multiply(scale).addScaledVector(B.J, rJ[i]).applyQuaternion(B.q).add(B.pos);
    nV.applyQuaternion(B.q); tV.applyQuaternion(B.q); bV.applyQuaternion(B.q);
    pos[i3] = pV.x; pos[i3 + 1] = pV.y; pos[i3 + 2] = pV.z;
    nor[i3] = nV.x; nor[i3 + 1] = nV.y; nor[i3 + 2] = nV.z;
    tan[i3] = tV.x; tan[i3 + 1] = tV.y; tan[i3 + 2] = tV.z;
    bit[i3] = bV.x; bit[i3 + 1] = bV.y; bit[i3 + 2] = bV.z;
  }
  const upB = tmp3.copy(UP).applyQuaternion(B.q), fwB = tmp2.copy(FWD).applyQuaternion(B.q);
  for (const l of limbs) {
    const X = l.x, np = l.np, R = l.rings;
    for (let r = 0; r < R; r++) {
      const fp = r / (R - 1) * (np - 1), i = Math.min(np - 2, Math.floor(fp)), t = fp - i;
      cr(X[Math.max(0, i - 1)], X[i], X[i + 1], X[Math.min(np - 1, i + 2)], t, l.spine[r]);
    }
    for (let r = 0; r < R; r++) l.spT[r].subVectors(l.spine[Math.min(R - 1, r + 1)], l.spine[Math.max(0, r - 1)]).normalize();
    // parallel transport frame, seeded with body-up (or forward when the limb starts vertical)
    const seed = l.seedDir ? tmp.copy(l.seedDir).applyQuaternion(B.q) : (l.seed === "fwd" || Math.abs(upB.dot(l.spT[0])) > 0.92 ? fwB : upB);
    nV.copy(seed).addScaledVector(l.spT[0], -seed.dot(l.spT[0])).normalize();
    for (let r = 0; r < R; r++) {
      const T = l.spT[r];
      nV.addScaledVector(T, -nV.dot(T)).normalize();
      bV.crossVectors(T, nV);
      l.fN[r].copy(nV); l.fB[r].copy(bV);
      const rad = l.radius(r / (R - 1)) * (1 + (scale.x - 1) * 0.5);
      // surface slope along the limb: where it tapers (paw domes, tips) the normal tilts toward the end
      const du = 1 / (R - 1), u0 = Math.max(0, r / (R - 1) - du), u1 = Math.min(1, r / (R - 1) + du);
      const slope = -(l.radius(u1) - l.radius(u0)) / Math.max(1e-4, (u1 - u0) * l.len);
      const tilt = Math.atan(slope), ct = Math.cos(tilt), st = Math.sin(tilt);
      for (let j = 0; j <= l.aseg; j++) {
        const vi = l.start + r * (l.aseg + 1) + j, i3 = vi * 3;
        const ang = j / l.aseg * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
        const dx = nV.x * c + bV.x * s, dy = nV.y * c + bV.y * s, dz = nV.z * c + bV.z * s;
        const rr = Math.max(0.004, rad - dent[vi] * Math.min(1, rad * 4));
        const fl = l.flat ? 1 - (1 - l.flat) * c * c : 1; // flattened ears: squash across the N axis
        pos[i3] = l.spine[r].x + dx * rr * fl; pos[i3 + 1] = l.spine[r].y + dy * rr * fl; pos[i3 + 2] = l.spine[r].z + dz * rr * fl;
        nor[i3] = dx * ct + T.x * st; nor[i3 + 1] = dy * ct + T.y * st; nor[i3 + 2] = dz * ct + T.z * st;
        tan[i3] = T.x; tan[i3 + 1] = T.y; tan[i3 + 2] = T.z;
        bit[i3] = -nV.x * s + bV.x * c; bit[i3 + 1] = -nV.y * s + bV.y * c; bit[i3 + 2] = -nV.z * s + bV.z * c;
      }
    }
  }
  for (const l of limbs) for (const d of l.dec) {
    const r = d.ring, T = l.spT[r], N = l.fN[r], Bn = l.fB[r], P = l.spine[r], rad = l.radius(r / (l.rings - 1));
    if (d.type === "pad") {
      // suede sole on the end of the paw, facing along the limb
      d.m.quaternion.setFromUnitVectors(UP, T);
      d.m.position.copy(P).addScaledVector(T, 0.012);
    } else if (d.type === "spade") {
      decM.makeBasis(Bn, N, T); d.m.quaternion.setFromRotationMatrix(decM);
      d.m.position.copy(P).addScaledVector(T, 0.16);
    } else {
      const a = d.type === "claw" ? d.a : 0;
      tV.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(Bn, Math.sin(a));
      if (d.type === "claw") {
        // claws: on the front of the paw, pointing along the limb and a little down
        tV.multiplyScalar(-0.35).add(T).normalize();
        d.m.position.copy(P).addScaledVector(T, rad * 0.55).addScaledVector(N, -rad * 0.35).addScaledVector(l.fB[r], Math.sin(d.a - Math.PI * 0.5) * rad * 0.6);
      } else {
        d.m.position.copy(P).addScaledVector(tV, rad * 0.85 + d.h * 0.4);
        tV.addScaledVector(T, 0.35).normalize();
      }
      d.m.quaternion.setFromUnitVectors(UP, tV);
    }
  }
  aPos.needsUpdate = aNor.needsUpdate = aTan.needsUpdate = aBit.needsUpdate = true;
  geo.boundingSphere = null;

  face.quaternion.copy(B.q); face.scale.copy(scale);
  face.position.copy(B.J).multiplyScalar(sm(C.faceY, C.jig[0], C.jig[1])).addScaledVector(tmp.copy(COM).multiply(scale), -1).applyQuaternion(B.q).add(B.pos);

  const f = shared.uForce.value;
  f.set(0, -0.32, 0).addScaledVector(B.vel, -0.035).addScaledVector(B.Jv, -0.5);
  if (f.length() > 1.1) f.setLength(1.1);

  shadowMat.uniforms.uC.value.copy(B.pos); shadowMat.uniforms.uH.value = Math.max(0, B.pos.y - COM.y);
  const U = shadowMat.uniforms.uP.value; let n = 0;
  const per = Math.max(1, Math.floor(SH_PTS / Math.max(1, limbs.length)));
  for (const l of limbs) for (let k = 0; k < per && n < SH_PTS; k++) U[n++].copy(l.x[Math.min(l.np - 1, Math.round(l.np * 0.3 + k * (l.np * 0.7 - 1) / Math.max(1, per - 1)))]);
  while (n < SH_PTS) U[n++].set(0, 99, 0);

  if (S.hang && C.key === "spider") {
    silk.visible = true;
    const a = silk.geometry.attributes.position;
    toWorld(tmp.set(0, 2.0, -0.95), tmp); a.setXYZ(0, tmp.x, tmp.y, tmp.z); a.setXYZ(1, silkAnchor.x, 16, silkAnchor.z); a.needsUpdate = true;
  } else silk.visible = false;
}

/* ---------- picking ---------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function setRay(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function pick(ev) {
  setRay(ev);
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  geo.computeBoundingBox();
  const hit = ray.intersectObject(baseMesh, false)[0];
  if (!hit) return null;
  const vi = hit.face.a;
  const out = { point: hit.point.clone(), normal: new V3(nor[vi * 3], nor[vi * 3 + 1], nor[vi * 3 + 2]), limb: -1, pi: -1 };
  if (vi >= RIG) {
    const L = limbs.findIndex(l => vi >= l.start && vi < l.start + l.rings * (l.aseg + 1));
    const l = limbs[L], ring = Math.floor((vi - l.start) / (l.aseg + 1));
    out.limb = L; out.pi = Math.max(1, Math.round(ring / (l.rings - 1) * (l.np - 1)));
  }
  return out;
}
function applyFinger(on) {
  dentF.fill(0);
  if (!on) return;
  const R2 = 0.11, depth = 0.24, P = press.point;
  for (let i = 0; i < NV; i++) {
    const dx = pos[i * 3] - P.x, dy = pos[i * 3 + 1] - P.y, dz = pos[i * 3 + 2] - P.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < R2 * 5) {
      const facing = nor[i * 3] * press.normal.x + nor[i * 3 + 1] * press.normal.y + nor[i * 3 + 2] * press.normal.z;
      if (facing > 0.1) dentF[i] = depth * Math.exp(-d2 / R2) * facing;
    }
  }
}
let lastBrush = null;
function brush(hit) {
  if (!lastBrush) { lastBrush = hit.point.clone(); return; }
  const s = tmp.subVectors(hit.point, lastBrush), sl = s.length();
  if (sl <= 0.004) return;
  s.divideScalar(sl);
  const R2 = 0.075, P = hit.point;
  for (let i = 0; i < NV; i++) {
    const i3 = i * 3;
    const dx = pos[i3] - P.x, dy = pos[i3 + 1] - P.y, dz = pos[i3 + 2] - P.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > R2 * 4) continue;
    if (nor[i3] * hit.normal.x + nor[i3 + 1] * hit.normal.y + nor[i3 + 2] * hit.normal.z < 0) continue;
    const ct = s.x * tan[i3] + s.y * tan[i3 + 1] + s.z * tan[i3 + 2];
    const cb = s.x * bit[i3] + s.y * bit[i3 + 1] + s.z * bit[i3 + 2];
    const cl = Math.hypot(ct, cb) || 1;
    const w = Math.exp(-d2 / R2) * 0.55 * Math.min(1, sl * 12);
    comb[i * 2] += (ct / cl * 0.95 - comb[i * 2]) * w;
    comb[i * 2 + 1] += (cb / cl * 0.95 - comb[i * 2 + 1]) * w;
  }
  aComb.needsUpdate = true;
  lastBrush = hit.point.clone();
}

/* ---------- pointer handling ---------- */
const el = renderer.domElement;
const pointers = new Map();
let mode = null, lastX = 0, lastY = 0, pinchD = 0;
function setCursor() { el.style.cursor = S.tool === "hand" ? (grab.kind ? "grabbing" : "grab") : S.tool === "finger" ? "pointer" : "crosshair"; }
el.addEventListener("pointerdown", (ev) => {
  el.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 2) { endAction(); mode = "pinch"; const p = [...pointers.values()]; pinchD = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); return; }
  lastX = ev.clientX; lastY = ev.clientY;
  const hit = pick(ev);
  if (!hit) { mode = "orbit"; return; }
  if (S.tool === "hand") {
    mode = "grab";
    grab.plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(tmp).negate(), hit.point);
    grab.target.copy(hit.point); grab.lastT.copy(hit.point); grab.vel.set(0, 0, 0);
    if (hit.limb >= 0) { grab.kind = "limb"; grab.limb = hit.limb; grab.pi = hit.pi; }
    else { grab.kind = "body"; grab.local.copy(hit.point).sub(B.pos).applyQuaternion(new Q().copy(B.q).invert()).divide(scale).add(COM); }
  } else if (S.tool === "finger") {
    mode = "press"; press.on = true; press.point.copy(hit.point); press.normal.copy(hit.normal); press.limb = hit.limb; press.pi = hit.pi;
    applyFinger(true);
  } else { mode = "comb"; lastBrush = null; brush(hit); }
  setCursor();
});
el.addEventListener("pointermove", (ev) => {
  if (!pointers.has(ev.pointerId)) return;
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (mode === "pinch" && pointers.size === 2) {
    const p = [...pointers.values()]; const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    orbit.dist = THREE.MathUtils.clamp(orbit.dist * pinchD / d, 6, 24); pinchD = d; placeCamera(); return;
  }
  const dx = ev.clientX - lastX, dy = ev.clientY - lastY; lastX = ev.clientX; lastY = ev.clientY;
  if (mode === "orbit") {
    orbit.theta -= dx * 0.006; orbit.phi = THREE.MathUtils.clamp(orbit.phi - dy * 0.005, 0.35, 1.5); placeCamera();
  } else if (mode === "grab") {
    setRay(ev);
    if (ray.ray.intersectPlane(grab.plane, tmp)) { tmp.y = Math.max(tmp.y, 0.05); grab.target.copy(tmp); }
  } else if (mode === "press") {
    const hit = pick(ev);
    if (hit) { press.point.copy(hit.point); press.normal.copy(hit.normal); press.limb = hit.limb; press.pi = hit.pi; applyFinger(true); }
  } else if (mode === "comb") {
    const hit = pick(ev); if (hit) brush(hit); else lastBrush = null;
  }
});
function endAction() {
  if (grab.kind === "limb") {
    const A = limbs[grab.limb];
    for (let i = 1; i < A.np; i++) A.o[i].addScaledVector(grab.vel, -(1 / 120) * Math.exp(-Math.pow(i - grab.pi, 2) / 6));
  }
  grab.kind = null; press.on = false; if (dentF) applyFinger(false); lastBrush = null; mode = null; setCursor();
}
function onUp(ev) {
  pointers.delete(ev.pointerId);
  if (mode === "pinch") { if (pointers.size === 0) mode = null; return; }
  endAction();
}
el.addEventListener("pointerup", onUp);
el.addEventListener("pointercancel", onUp);
el.addEventListener("wheel", (ev) => { ev.preventDefault(); orbit.dist = THREE.MathUtils.clamp(orbit.dist * Math.exp(ev.deltaY * 0.001), 6, 24); placeCamera(); }, { passive: false });

/* ---------- actions ---------- */
// shake: held in place and rattled side to side (no jump); toss: thrown high with a spin
function shake() { act.shake = 1.4; for (let i = 0; i < NV; i++) dentV[i] += (Math.random() - 0.5) * 0.6; }
function squish() { B.sqv += 4.2 - S.stuff * 1.2; B.Jv.y -= 1.2; }
function toss() {
  B.vel.set((Math.random() - 0.5) * 2.4, 9.5, (Math.random() - 0.5) * 2.4);
  B.w.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 9);
}
function resetBody() {
  B.pos.copy(COM); B.vel.set(0, 0, 0); B.lastVel.set(0, 0, 0); B.q.identity(); B.w.set(0, 0, 0);
  B.sq = B.sqv = 0; B.J.set(0, 0, 0); B.Jv.set(0, 0, 0); scale.set(1, 1, 1);
  dent.fill(0); dentV.fill(0); dentF.fill(0); resetComb();
  for (const k in act) act[k] = 0;
  S.curl = false; S.hang = false; syncSpecials();
  for (const A of limbs) A.rest.forEach((p, i) => { A.x[i].copy(p); A.o[i].copy(p); });
  endAction();
}

/* ---------- UI ---------- */
const HOWTO = {
  hand: "<b>GRAB</b>몸통이나 팔·다리를 잡고 끌어 보세요. 놓으면 그 속도로 날아갑니다. 빈 곳을 끌면 시점이 돌아갑니다.",
  finger: "<b>POKE</b>꾹 누르면 솜이 들어갔다가 천천히 돌아옵니다. 팔이나 다리를 누르면 눌려서 휘어요.",
  comb: "<b>COMB</b>털을 쓸어 넘기면 결이 눕습니다. 결을 거슬러 빗으면 어둡게, 결대로 빗으면 반짝여요."
};
document.querySelectorAll("[data-tool]").forEach(b => b.addEventListener("click", () => {
  S.tool = b.dataset.tool;
  document.querySelectorAll("[data-tool]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  document.querySelector(".howto").innerHTML = HOWTO[S.tool];
  setCursor();
}));
function swatchBg(p) {
  if (C.key === "spider") return `repeating-linear-gradient(90deg, ${css(p.tip)} 0 8px, ${css(p.altTip)} 8px 13px)`;
  if (C.key === "dragon") return `linear-gradient(90deg, ${css(p.tip)} 0 62%, ${css(p.altTip)} 62% 82%, ${css(p.under)} 82%)`;
  return `linear-gradient(180deg, ${css(p.tip)}, ${css(p.root)})`;
}
function setPalette(name) {
  const p = C.palettes[name]; C.pal = name;
  shared.uRoot.value.copy(hex(p.root)); shared.uTip.value.copy(hex(p.tip));
  shared.uAltRoot.value.copy(hex(p.altRoot == null ? p.root : p.altRoot)); shared.uAltTip.value.copy(hex(p.altTip == null ? p.tip : p.altTip));
  shared.uUnder.value.copy(hex(p.under));
  MAT.pad.color.setHex(p.under).multiplyScalar(0.78);
  MAT.alt.color.setHex(p.altTip == null ? p.tip : p.altRoot).lerp(new THREE.Color(p.altTip == null ? p.tip : p.altTip), 0.5);
  document.querySelectorAll("[data-c]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.c === name)));
}
function renderSwatches() {
  const box = $("swatches"); box.innerHTML = "";
  for (const [k, p] of Object.entries(C.palettes)) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "sw"; b.id = "c-" + k; b.dataset.c = k;
    b.innerHTML = `<i style="background:${swatchBg(p)}"></i>${p.label}`;
    b.addEventListener("click", () => setPalette(k));
    box.appendChild(b);
  }
}
function syncSpecials() {
  document.querySelectorAll("[data-sp]").forEach(b => { const t = b.dataset.toggle; if (t) { b.classList.toggle("on", !!S[t]); b.setAttribute("aria-pressed", String(!!S[t])); } });
}
function renderSpecials() {
  const box = $("specials"); box.innerHTML = "";
  C.specials.forEach((sp, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn" + (C.specials.length % 2 && i === C.specials.length - 1 ? " wide" : ""); b.id = "sp-" + sp.id;
    b.dataset.sp = sp.id; b.textContent = sp.label;
    if (sp.toggle) { b.dataset.toggle = sp.toggle; b.setAttribute("aria-pressed", "false"); }
    b.addEventListener("click", () => {
      if (sp.toggle) {
        S[sp.toggle] = !S[sp.toggle];
        if (sp.toggle === "hang" && S.hang) { S.curl = false; silkAnchor.set(B.pos.x, B.pos.y + 4.4, B.pos.z); toWorld(SILK_AT, tmp); silkLen = tmp.distanceTo(silkAnchor); }
        if (sp.toggle === "curl" && S.curl) S.hang = false;
        syncSpecials();
      } else sp.run();
    });
    box.appendChild(b);
  });
}
function selectCreature(key) {
  const c = CREATURES[key] || OCTOPUS;
  build(c);
  resetBody();
  renderSwatches(); setPalette(c.pal); renderSpecials();
  $("eName").textContent = c.name; $("eNo").textContent = c.no; $("eFig").textContent = "fig. " + c.no.slice(-2); $("eDesc").textContent = c.desc;
  document.querySelectorAll("[data-k]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.k === c.key)));
  frameCreature();
  for (let i = 0; i < 90; i++) stepPhysics(STEP);
  rebuild();
  try { history.replaceState(null, "", "#" + c.key); } catch (e) { /* frame may refuse */ }
}
document.querySelectorAll("[data-k]").forEach(b => b.addEventListener("click", () => selectCreature(b.dataset.k)));
function syncSliders() {
  S.stuff = +$("rStuff").value; S.pile = +$("rPile").value; S.damp = +$("rDamp").value;
  $("oStuff").textContent = S.stuff.toFixed(2);
  $("oDamp").textContent = S.damp.toFixed(2);
  shared.uLen.value = 0.05 + S.pile * 0.17;
  $("oPile").textContent = Math.round(shared.uLen.value * 100) + " mm";
}
["rStuff", "rPile", "rDamp"].forEach(id => $(id).addEventListener("input", syncSliders));
const setZoom = (v) => { v = Math.max(0, Math.min(1, v)); orbit.dist = 6 * Math.pow(4, 1 - v); placeCamera(); };
$("rZoom").addEventListener("input", e => setZoom(+e.target.value));
$("bZoomIn").addEventListener("click", () => setZoom(+$("rZoom").value + 0.1));
$("bZoomOut").addEventListener("click", () => setZoom(+$("rZoom").value - 0.1));
$("bShake").addEventListener("click", shake);
$("bSquish").addEventListener("click", squish);
$("bToss").addEventListener("click", () => { if (S.hang) { S.hang = false; syncSpecials(); } toss(); });
$("bSmooth").addEventListener("click", () => { smoothT = 1.0; });
$("bReset").addEventListener("click", resetBody);
$("xSlow").addEventListener("change", e => { S.slow = e.target.checked; });
$("xMesh").addEventListener("change", e => { wire.visible = e.target.checked; });
$("bPause").addEventListener("click", e => { S.pause = !S.pause; e.target.setAttribute("aria-pressed", String(S.pause)); e.target.textContent = S.pause ? "Resume" : "Pause"; });
const panel = $("panel");
if (narrow()) panel.classList.add("collapsed");
$("sheetToggle").addEventListener("click", () => {
  panel.classList.toggle("collapsed");
  $("sheetToggle").textContent = panel.classList.contains("collapsed") ? "more ▾" : "less ▴";
});

/* ---------- loop ---------- */
const STEP = 1 / 120;
let accum = 0, last = performance.now(), statT = 0;
function updateStats(dt) {
  statT += dt; if (statT < 0.15) return; statT = 0;
  const m = (C.mass[0] + S.stuff * C.mass[1]) / 1000;
  let ke = 0.5 * m * B.vel.lengthSq(), contacts = 0;
  for (const A of limbs) for (let i = 1; i < A.np; i++) {
    ke += 0.5 * (0.03 / A.np) * A.x[i].distanceToSquared(A.o[i]) / (STEP * STEP);
    if (A.x[i].y <= A.rad[i] * 0.92 + 0.003) contacts++;
  }
  ke += 0.5 * 0.02 * B.w.lengthSq();
  let dsum = 0; for (let i = 0; i < RIG; i++) dsum += Math.max(0, dent[i]);
  $("sMass").innerHTML = Math.round(m * 1000) + "<small>g</small>";
  $("sVol").innerHTML = (C.vol * (1 - B.sq * 0.12) - dsum * 0.0009).toFixed(2) + "<small>L</small>";
  $("sKin").innerHTML = ke.toFixed(2) + "<small>J</small>";
  $("sCon").innerHTML = contacts + "<small>pts</small>";
}
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (grab.kind) {
    tmp.subVectors(grab.target, grab.lastT).divideScalar(Math.max(dt, 1e-3));
    grab.vel.lerp(tmp, 0.35); if (grab.vel.length() > 18) grab.vel.setLength(18);
    grab.lastT.copy(grab.target);
  }
  if (!S.pause) {
    accum += dt * (S.slow ? 0.5 : 1);
    let n = 0;
    while (accum >= STEP && n < 10) { stepPhysics(STEP); accum -= STEP; n++; }
    if (n === 10) accum = 0;
    rebuild();
    if (press.on) applyFinger(true);
  }
  updateStats(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

syncSliders(); resize(); setCursor();
const start = (location.hash || "").replace("#", "");
selectCreature(CREATURES[start] ? start : "octopus");
window.__plush = { tipScreen(L) { const l = limbs[L]; const v = l.x[l.np - 2].clone().project(camera); const r = renderer.domElement.getBoundingClientRect(); return { x: (v.x + 1) / 2 * r.width + r.left, y: (1 - v.y) / 2 * r.height + r.top }; }, rebuildNow() { rebuild(); }, spinePen() {
  // how deep the drawn limb centreline goes into the body, past each limb's root section
  let m = 0; const qi = B.q.clone().invert();
  for (const l of limbs) for (let r = Math.round(l.rings * 0.3); r < l.rings; r++) {
    const lp = l.spine[r].clone().sub(B.pos).applyQuaternion(qi).divide(scale).add(COM);
    for (const b of blobs) if (b.col) m = Math.max(m, pushOut(b, lp, 0, false));
  } return m; },
  jitter() { let e = 0; for (const l of limbs) for (let i = 1; i < l.np; i++) e += l.x[i].distanceTo(l.o[i]); return e; },
  limbIndex(role) { return limbs.findIndex(l => l.role === role); }, limbNp(L) { return limbs[L].np; }, view(th, ph, d) { orbit.theta = th; orbit.phi = ph; if (d) orbit.dist = d; placeCamera(); }, audit() {
  // rest pose: (1) limb joints past the root whose centre sits inside the body, (2) decorations whose base is off the limb surface
  const out = [];
  limbs.forEach((l, L) => {
    const buried = [];
    for (let i = 2; i < l.np; i++) { let d = 0; for (const b of blobs) d = Math.max(d, pushOut(b, l.rest[i], 0, false)); if (d > 0.01) buried.push(i + ':' + d.toFixed(2)); }
    if (buried.length) out.push((l.role || 'limb') + L + ' centre-inside ' + buried.join(' '));
    for (const d of l.dec) {
      const r = d.ring, P = l.spine[r], rad = l.radius(r / (l.rings - 1));
      const ax = new V3(0, 1, 0).applyQuaternion(d.m.quaternion);
      let h = 0;
      if (d.type === 'spike') h = d.h; else if (d.type === 'claw') h = d.small ? 0.11 : 0.15; else if (d.type === 'spade') h = 0;
      const base = d.m.position.clone().addScaledVector(ax, -h / 2);
      const gap = base.distanceTo(P) - rad;
      if (d.type === 'spade') { const g2 = d.m.position.distanceTo(l.spine[l.rings - 1]) - 0.3; if (g2 > 0.01) out.push((l.role || 'limb') + L + ' spade gap ' + g2.toFixed(2)); }
      else if (gap > 0.02) out.push((l.role || 'limb') + L + ' ' + d.type + ' base gap ' + gap.toFixed(2));
    }
  });
  return out.join('\n') || 'ok';
}, minPen() { let m = 0; for (const l of limbs) for (let i = 1; i < l.np; i++) { if (l.inside[i]) continue; const lp = l.x[i].clone().sub(B.pos).applyQuaternion(B.q.clone().invert()).divide(scale).add(COM); for (const b of blobs) m = Math.max(m, pushOut(b, lp, l.rad[i] * 0.8, false)); } return m; }, select: selectCreature, act, S, toss, shake, B, grab, run(n, f) { for (let i = 0; i < n; i++) { if (f) f(i); stepPhysics(STEP); } rebuild(); } };
requestAnimationFrame(frame);
})();
