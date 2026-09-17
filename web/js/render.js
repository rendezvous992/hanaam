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
    this.dist = 2.6;
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
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.uMVP = gl.getUniformLocation(prog, 'uMVP');
    this.uPointScale = gl.getUniformLocation(prog, 'uPointScale');

    const attr = (name, buf, size, type, normalized, data) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, name === 'aGlow' ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
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
    c.addEventListener('touchstart', e => { const t = e.touches[0]; down(t.clientX, t.clientY); }, { passive: true });
    c.addEventListener('touchmove', e => { const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
    c.addEventListener('touchend', () => drag = false);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.dist = Math.max(1.2, Math.min(6, this.dist * (1 + e.deltaY * 0.001)));
    }, { passive: false });
  }

  _resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.dpr = dpr;
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

    gl.uniformMatrix4fv(this.uMVP, false, mvp);
    gl.uniform1f(this.uPointScale, 2.2 * this.dpr);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, this.n);
  }
}
