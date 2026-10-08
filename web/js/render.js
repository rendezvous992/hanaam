// WebGL 포인트 클라우드 렌더러 — 139k 뉴런을 실제 FAFB 좌표로 그린다.
// 의존성 없음(순수 WebGL1). 글로우 값은 매 프레임 bufferSubData로 갱신.

const VS = `
attribute vec3 aPos;      // 0..1 정규화 좌표
attribute vec3 aColor;
attribute float aGlow;    // 0..1
uniform mat4 uMVP;
uniform float uPointScale;
varying vec3 vColor;
varying float vGlow;
void main() {
  vec3 p = aPos * 2.0 - 1.0;
  p.y = -p.y;                       // 이미지 좌표계 → 화면 위쪽이 등쪽
  gl_Position = uMVP * vec4(p, 1.0);
  float size = (1.2 + aGlow * 5.0) * uPointScale;
  gl_PointSize = size / max(gl_Position.w, 0.1);
  vColor = aColor;
  vGlow = aGlow;
}`;

const FS = `
precision mediump float;
varying vec3 vColor;
varying float vGlow;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float soft = 1.0 - smoothstep(0.05, 0.25, r2);
  vec3 hot = vec3(1.0, 0.85, 0.35);
  vec3 c = vColor * (0.20 + 0.30 * soft) + hot * vGlow * soft * 1.6;
  gl_FragColor = vec4(c, 1.0);
}`;

// 뉴런 스켈레톤(모폴로지) 라인용 셰이더
const VS_LINE = `
attribute vec3 aPos;
uniform mat4 uMVP;
void main() {
  vec3 p = aPos * 2.0 - 1.0;
  p.y = -p.y;
  gl_Position = uMVP * vec4(p, 1.0);
}`;
const FS_LINE = `
precision mediump float;
uniform vec3 uColor;
uniform float uAlpha;
void main() { gl_FragColor = vec4(uColor * uAlpha, 1.0); }`;

function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                     a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

export class BrainRenderer {
  constructor(canvas, positionsU16, colorsF32, n) {
    this.canvas = canvas;
    this.n = n;
    this.rotX = 0.12;
    this.rotY = 0.18;
    // 카메라 거리: 처음에는 뇌 전체가 여유 있게 보이도록 멀리서 시작한다 (세로 화면이면 더 멀리)
    this.distMin = 1.2; this.distMax = 10;
    const asp = innerWidth / Math.max(innerHeight, 1);
    this.dist = Math.min(this.distMax, asp >= 1 ? 4.4 : 4.4 / Math.max(asp, 0.4) * 0.75);
    this.onZoom = null;              // 휠·핀치로 거리가 바뀌면 알린다 (확대 막대 동기화)
    this.autoRotate = true;

    const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL을 사용할 수 없습니다');
    this.gl = gl;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const link = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(p));
      return p;
    };
    const prog = this.prog = link(VS, FS);
    this.lineProg = link(VS_LINE, FS_LINE);
    this.uMVPLine = gl.getUniformLocation(this.lineProg, 'uMVP');
    this.uColorLine = gl.getUniformLocation(this.lineProg, 'uColor');
    this.uAlphaLine = gl.getUniformLocation(this.lineProg, 'uAlpha');
    this.aPosLine = gl.getAttribLocation(this.lineProg, 'aPos');
    this.skel = null;
    this.showSkel = true;
    this.skelMax = Infinity;   // 저사양 검증용 정점 상한
    gl.useProgram(prog);
    this.uMVP = gl.getUniformLocation(prog, 'uMVP');
    this.uPointScale = gl.getUniformLocation(prog, 'uPointScale');

    // 포인트/라인 프로그램을 오가므로 어트리뷰트는 매 프레임 재바인딩한다
    this.pointAttribs = [];
    const attr = (name, buf, size, type, normalized, data) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, name === 'aGlow' ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, name);
      this.pointAttribs.push({ loc, buf, size, type, normalized });
    };
    attr('aPos', gl.createBuffer(), 3, gl.UNSIGNED_SHORT, true, positionsU16);
    attr('aColor', gl.createBuffer(), 3, gl.FLOAT, false, colorsF32);
    this.glowBuf = gl.createBuffer();
    this.glowData = new Uint8Array(n);
    attr('aGlow', this.glowBuf, 1, gl.UNSIGNED_BYTE, true, this.glowData);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);          // 가산 블렌딩
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0.015, 0.02, 0.045, 1);

    this._bindInput();
    this._resize();
    addEventListener('resize', () => this._resize());
  }

  _bindInput() {
    const c = this.canvas;
    let drag = false, px = 0, py = 0;
    const down = (x, y) => { drag = true; px = x; py = y; this.autoRotate = false; };
    const move = (x, y) => {
      if (!drag) return;
      this.rotY += (x - px) * 0.006;
      this.rotX += (y - py) * 0.006;
      this.rotX = Math.max(-1.5, Math.min(1.5, this.rotX));
      px = x; py = y;
    };
    c.addEventListener('mousedown', e => down(e.clientX, e.clientY));
    addEventListener('mousemove', e => move(e.clientX, e.clientY));
    addEventListener('mouseup', () => drag = false);
    // 손가락 하나 = 회전, 두 개 = 핀치 확대·축소
    let pinch = 0;
    const span = ts => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    c.addEventListener('touchstart', e => {
      if (e.touches.length === 2) { drag = false; pinch = span(e.touches); return; }
      const t = e.touches[0]; down(t.clientX, t.clientY);
    }, { passive: true });
    c.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && pinch) {
        const s = span(e.touches);
        this.setDist(this.dist * pinch / Math.max(s, 1));
        pinch = s;
        return;
      }
      const t = e.touches[0]; move(t.clientX, t.clientY);
    }, { passive: true });
    c.addEventListener('touchend', e => { drag = false; if (e.touches.length < 2) pinch = 0; });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.setDist(this.dist * (1 + e.deltaY * 0.001));
    }, { passive: false });
  }

  setDist(d, silent) {
    this.dist = Math.max(this.distMin, Math.min(this.distMax, d));
    if (!silent) this.onZoom?.(this.dist);
  }

  _resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.dpr = dpr;
  }

  // 뉴런 스켈레톤 등록: posU16 = 라인 리스트 정점, neurons = [{i, g, s, c}]
  setSkeletons(posU16, neurons) {
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, posU16, gl.STATIC_DRAW);
    const hsl = (h, s, l) => {
      const f = (nn) => {
        const k = (nn + h * 12) % 12;
        return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      };
      return [f(0), f(8), f(4)];
    };
    this.skel = {
      buf,
      neurons: neurons.map((nr, k) => ({
        ...nr,
        color: hsl((k * 0.61803) % 1, 0.8, 0.62),
      })),
    };
  }

  updateGlow(u8) {
    this.glowData.set(u8);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glowBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.glowData);
  }

  draw(dt) {
    if (this.autoRotate) this.rotY += dt * 0.12;
    const gl = this.gl;
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const f = 1 / Math.tan(0.45);
    const near = 0.1, far = 20;
    const proj = new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, 2 * far * near / (near - far), 0,
    ]);
    const cx = Math.cos(this.rotX), sx = Math.sin(this.rotX);
    const cy = Math.cos(this.rotY), sy = Math.sin(this.rotY);
    const rotYm = new Float32Array([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]);
    const rotXm = new Float32Array([1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1]);
    const trans = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -this.dist, 1]);
    const mvp = mat4Mul(proj, mat4Mul(trans, mat4Mul(rotXm, rotYm)));

    gl.useProgram(this.prog);
    for (const a of this.pointAttribs) {
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, a.type, a.normalized, 0, 0);
    }
    gl.uniformMatrix4fv(this.uMVP, false, mvp);
    gl.uniform1f(this.uPointScale, 2.2 * this.dpr);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, this.n);

    // 스켈레톤(모폴로지) 레이어: 발화하면 그 뉴런 전체가 밝아진다
    if (this.skel && this.showSkel) {
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(this.uMVPLine, false, mvp);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.skel.buf);
      gl.enableVertexAttribArray(this.aPosLine);
      gl.vertexAttribPointer(this.aPosLine, 3, gl.UNSIGNED_SHORT, true, 0, 0);
      let drawn = 0;
      for (const nr of this.skel.neurons) {
        if ((drawn += nr.c) > this.skelMax) break;
        const g = this.glowData[nr.i] / 255;
        gl.uniform3fv(this.uColorLine, nr.color);
        gl.uniform1f(this.uAlphaLine, 0.28 + g * 1.6);
        gl.drawArrays(gl.LINES, nr.s, nr.c);
      }
    }
  }
}
