// 초파리 눈: 화면 캔버스를 광수용체 발화율로 바꾸고, 수용장을 아는 시각 뉴런의
// 반응으로 "초파리 뇌가 본 화면"을 되살린다.
//
// 좌표: u 0 = 초파리 왼쪽, 1 = 오른쪽 / v 0 = 위, 1 = 아래 (초파리 시점).
// 광수용체 지도와 수용장은 pipeline/build_vision.py가 연결체 시뮬레이션으로 측정했다.

export const SCREEN_W = 160, SCREEN_H = 120;
export const MAX_HZ = 200;            // 가장 밝은 픽셀의 광수용체 발화율

export class FlyEye {
  constructor(v) {
    Object.assign(this, v);
    this.photoN = v.photoIdx.length;
    this.perN = v.perIdx.length;
    this.ema = new Float32Array(this.perN);
    // 광수용체가 샘플링할 화면 픽셀 위치(미리 계산)
    this.px = new Int32Array(this.photoN);
    for (let k = 0; k < this.photoN; k++) {
      const x = Math.min(SCREEN_W - 1, Math.floor(v.pu[k] * SCREEN_W));
      const y = Math.min(SCREEN_H - 1, Math.floor(v.pv[k] * SCREEN_H));
      this.px[k] = (y * SCREEN_W + x) * 4;
    }
  }

  // 화면 캔버스 → 광수용체별 발화율(Hz)
  rates(canvas) {
    const img = canvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, SCREEN_W, SCREEN_H).data;
    const r = new Float32Array(this.photoN);
    for (let k = 0; k < this.photoN; k++) {
      const p = this.px[k];
      r[k] = (0.3 * img[p] + 0.59 * img[p + 1] + 0.11 * img[p + 2]) / 255 * MAX_HZ;
    }
    return r;
  }

  // 감시 뉴런 스파이크 수 → 지수평활 (실시간 화면용)
  accumulate(counts, keep = 0.8) {
    const e = this.ema;
    for (let k = 0; k < this.perN; k++) e[k] = e[k] * keep + counts[k];
  }

  // 시각 뉴런 활동을 격자로 모은다. region = [u0, v0, u1, v1] 안만, 칸별 뉴런 수로 정규화.
  binGrid(act, gx, gy, region = [0, 0, 1, 1]) {
    const [u0, v0, u1, v1] = region;
    const sum = new Float32Array(gx * gy), cnt = new Float32Array(gx * gy);
    for (let k = 0; k < this.perN; k++) {
      const i = Math.floor((this.su[k] - u0) / (u1 - u0) * gx);
      const j = Math.floor((this.sv[k] - v0) / (v1 - v0) * gy);
      if (i < 0 || j < 0 || i >= gx || j >= gy) continue;
      sum[j * gx + i] += act[k]; cnt[j * gx + i]++;
    }
    for (let c = 0; c < sum.length; c++) sum[c] = cnt[c] ? sum[c] / cnt[c] : 0;
    return { act: sum, cover: cnt };
  }

  // "초파리 뇌가 본 화면": 각 시각 뉴런을 수용장 위치에 빛점으로 그린다
  drawPerceived(ctx, act = this.ema) {
    const { width: W, height: H } = ctx.canvas;
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, W, H);
    let mx = 1e-6;
    for (let k = 0; k < this.perN; k++) if (act[k] > mx) mx = act[k];
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < this.perN; k++) {
      const a = act[k] / mx;
      if (a < 0.04) continue;
      ctx.fillStyle = `rgba(255,${Math.round(150 + 90 * a)},${Math.round(60 + 60 * a)},${Math.min(1, a * 0.9)})`;
      ctx.beginPath();
      ctx.arc(this.su[k] * W, this.sv[k] * H, 2 + a * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
