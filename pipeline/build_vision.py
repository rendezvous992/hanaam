#!/usr/bin/env python3
"""초파리 '눈' 데이터 생성: 광수용체 → 화면 좌표 매핑 + 수용장(RF) 측정.

1) 망막 지도: R1-6 광수용체 좌표를 눈마다 PCA로 펼쳐 화면 좌표 (u, v)에 매핑.
   u: 0 = 초파리 왼쪽 끝, 1 = 오른쪽 끝 (왼눈은 왼쪽 절반, 오른눈은 오른쪽 절반,
   정면이 화면 가운데), v: 0 = 위(등쪽), 1 = 아래.
2) 수용장 측정: 웹 워커와 같은 LIF 모델을 numpy로 돌리며 화면 패치를 하나씩
   비춰서, 각 시각 뉴런이 화면 어디에 반응하는지(RF 중심·크기) 측정한다.
   실제 신경과학의 수용장 매핑 실험과 같은 절차.
3) 검증: 다가오는 원(looming) vs 같은 밝기의 정지 원을 보여줬을 때 자이언트
   파이버(DNp01) 발화를 비교한다.

출력: web/data/vision.bin (uint32 인덱스 + uint16 좌표들), web/data/vision.json
사용법: python3 build_vision.py --src <FlyWire CSV 디렉터리> --data ../web/data
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

# ── 웹 워커(sim-worker.js)와 같은 LIF 파라미터 ──
DT = 0.5
DECAY = np.exp(-DT / 10)
THR = 25.0
REFR = 4
ADAPT_INC = 30.0
ADAPT_DECAY = np.exp(-DT / 100)
V_MIN = -60.0


class Brain:
    def __init__(self, data: Path):
        self.n = json.loads((data / "meta.json").read_text())["n_neurons"]
        self.indptr = np.frombuffer((data / "csr_indptr_u32.bin").read_bytes(), np.uint32).astype(np.int64)
        self.targets = np.frombuffer((data / "csr_targets_u32.bin").read_bytes(), np.uint32).astype(np.int64)
        self.weights = np.frombuffer((data / "csr_weights_i16.bin").read_bytes(), np.int16).astype(np.float32)
        self.reset()
        self.rng = np.random.default_rng(1)

    def reset(self):
        n = self.n
        self.v = np.zeros(n, np.float32)
        self.ad = np.zeros(n, np.float32)
        self.refr = np.zeros(n, np.int8)

    def step(self, drive_idx=None, drive_p=None):
        """1 tick. drive_idx 뉴런들을 확률 drive_p로 강제 발화. 발화한 뉴런 인덱스 반환."""
        self.v *= DECAY
        self.ad *= ADAPT_DECAY
        np.maximum(self.refr - 1, 0, out=self.refr)
        if drive_idx is not None and len(drive_idx):
            hit = drive_idx[self.rng.random(len(drive_idx)) < drive_p]
            self.v[hit] = THR + self.ad[hit] + 1
        spk = np.flatnonzero((self.refr == 0) & (self.v >= THR + self.ad))
        if len(spk):
            self.v[spk] = 0
            self.refr[spk] = REFR
            self.ad[spk] += ADAPT_INC
            starts, ends = self.indptr[spk], self.indptr[spk + 1]
            lens = ends - starts
            if lens.sum():
                sel = np.repeat(starts - np.cumsum(lens) + lens, lens) + np.arange(lens.sum())
                self.v += np.bincount(self.targets[sel], weights=self.weights[sel],
                                      minlength=self.n).astype(np.float32)
        np.maximum(self.v, V_MIN, out=self.v)
        return spk


def retina_map(src: Path, n_expected: int):
    cls = pd.read_csv(src / "classification.csv.gz", usecols=["root_id", "side", "super_class"])
    cls = cls.drop_duplicates("root_id").reset_index(drop=True)
    assert len(cls) == n_expected, "build_dataset.py와 뉴런 순서가 달라졌다"
    ct = pd.read_csv(src / "consolidated_cell_types.csv.gz", usecols=["root_id", "primary_type"])
    co = pd.read_csv(src / "coordinates.csv.gz", usecols=["root_id", "position"]).drop_duplicates("root_id")
    xyz = co.position.str.extract(r"\[\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*\]").astype(float)
    co = pd.concat([co.root_id, xyz.set_axis(["x", "y", "z"], axis=1)], axis=1)
    d = cls.reset_index().merge(ct, on="root_id", how="left").merge(co, on="root_id", how="left")
    d = d.sort_values("index").reset_index(drop=True)

    idx_all, u_all, v_all = [], [], []
    for side, sgn in (("left", -1), ("right", 1)):
        s = d[(d.primary_type == "R1-6") & (d.side == side)]
        p = s[["x", "y", "z"]].to_numpy()
        c = p - p.mean(0)
        _, _, vt = np.linalg.svd(c, full_matrices=False)
        # 판(sheet)의 두 주축 중 y와 가장 나란한 축 = 위아래, 나머지 = 앞뒤
        axes = vt[:2]
        iy = int(np.argmax(np.abs(axes[:, 1])))
        ay, ah = axes[iy], axes[1 - iy]
        if ay[1] < 0: ay = -ay              # +y(배쪽) = 화면 아래
        if ah[2] < 0: ah = -ah              # +z(뒤쪽) = 바깥(측면)
        rank = lambda a: (np.argsort(np.argsort(a)) + 0.5) / len(a)
        az = rank(c @ ah)                   # 0 = 정면, 1 = 측면
        el = rank(c @ ay)                   # 0 = 위, 1 = 아래
        u = 0.5 + sgn * 0.5 * az            # 정면이 화면 가운데
        idx_all.append(s["index"].to_numpy()); u_all.append(u); v_all.append(el)
    side_code = d.side.map({"left": 1, "right": 2}).fillna(0).astype(np.uint8).to_numpy()
    return (np.concatenate(idx_all), np.concatenate(u_all), np.concatenate(v_all), d, side_code)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--data", default=str(Path(__file__).parent.parent / "web" / "data"))
    ap.add_argument("--grid", default="20x14")
    args = ap.parse_args()
    src, data = Path(args.src), Path(args.data)
    brain = Brain(data)
    n = brain.n
    pidx, pu, pv, d, side = retina_map(src, n)
    print(f"광수용체(R1-6) {len(pidx)}개 → 화면 좌표 매핑")

    gx, gy = map(int, args.grid.split("x"))
    # 단순 LIF에서는 활동이 수 ms 만에 뇌 전체로 연쇄 확산되므로, 위치 정보가 남아 있는
    # 첫 반응 파동(20ms)만 센다. 패치마다 뇌를 초기화해 서로 섞이지 않게 한다.
    STIM_T, RATE = 40, 200.0
    p = RATE * DT / 1000
    is_photo = np.zeros(n, bool); is_photo[pidx] = True
    resp = np.zeros((gx * gy, n), np.uint16)
    print(f"수용장 측정: 패치 {gx}x{gy} ...")
    for k in range(gx * gy):
        cx, cy = k % gx, k // gx
        m = ((pu >= cx / gx) & (pu < (cx + 1) / gx) & (pv >= cy / gy) & (pv < (cy + 1) / gy))
        drive = pidx[m]
        brain.reset()
        for t in range(STIM_T):
            spk = brain.step(drive, p)
            resp[k, spk] += 1
        if k % 20 == 0:
            print(f"  패치 {k}/{gx*gy}: 광수용체 {m.sum()}개, 반응 뉴런 {(resp[k] > 0).sum()}개")

    # RF 중심 = 반응 가중 중심, 크기 = 가중 표준편차
    pcx = (np.arange(gx * gy) % gx + 0.5) / gx
    pcy = (np.arange(gx * gy) // gx + 0.5) / gy
    R = resp.astype(np.float32)
    tot = R.sum(0)
    w = R ** 2
    wsum = w.sum(0) + 1e-9
    rfu = (w * pcx[:, None]).sum(0) / wsum
    rfv = (w * pcy[:, None]).sum(0) / wsum
    spread = np.sqrt((w * ((pcx[:, None] - rfu) ** 2 + (pcy[:, None] - rfv) ** 2)).sum(0) / wsum)
    sc = d.super_class.to_numpy()
    cand = (~is_photo) & np.isin(sc, ["optic", "visual_projection"]) & (tot >= 2) & (spread < 0.1)
    sel = np.flatnonzero(cand)
    print(f"국소 수용장을 가진 시각 뉴런 {len(sel)}개 (전체 반응 뉴런 {(tot > 0).sum()}개)")
    cell = np.clip((rfu[sel] * gx).astype(int), 0, gx - 1) + gx * np.clip((rfv[sel] * gy).astype(int), 0, gy - 1)
    print(f"  화면 칸 커버리지(뉴런 3개 이상): {(np.bincount(cell, minlength=gx*gy) >= 3).sum()}/{gx*gy}")

    # 검증: 다가오는 원 vs 정지 원 → 자이언트 파이버 발화
    gf = d.index[d.primary_type == "DNp01"].to_numpy()
    def disk_drive(r):
        return pidx[(pu - 0.5) ** 2 + ((pv - 0.5) * 0.8) ** 2 < r * r]
    def run(radius_fn, ticks=400):
        brain.reset(); cnt = 0
        for t in range(ticks):
            spk = brain.step(disk_drive(radius_fn(t)), p)
            cnt += np.isin(spk, gf).sum()
        return cnt
    loom = run(lambda t: 0.02 + 0.45 * (t / 400) ** 3)
    static = run(lambda t: 0.25)
    print(f"자이언트 파이버 발화: 다가오는 원 {loom}회 vs 정지 원 {static}회")

    # 하행뉴런 좌우, 보상(PAM)·처벌(PPL1) 도파민 뉴런
    pt = d.primary_type.astype(str)
    dn = d.index[(sc == "descending")].to_numpy()
    out = {
        "photo_n": int(len(pidx)), "percept_n": int(len(sel)),
        "grid": [gx, gy],
        "gf": gf.tolist(),
        "dn_left": dn[side[dn] == 1].tolist(), "dn_right": dn[side[dn] == 2].tolist(),
        "pam": d.index[pt.str.startswith("PAM")].tolist(),
        "ppl1": d.index[pt.str.startswith("PPL1")].tolist(),
        "check": {"gf_looming": int(loom), "gf_static": int(static)},
    }
    q = lambda a: np.clip(np.round(a * 65535), 0, 65535).astype(np.uint16)
    blob = b"".join([
        pidx.astype(np.uint32).tobytes(), q(pu).tobytes(), q(pv).tobytes(),
        sel.astype(np.uint32).tobytes(), q(rfu[sel]).tobytes(), q(rfv[sel]).tobytes(),
    ])
    (data / "vision.bin").write_bytes(blob)
    (data / "vision.json").write_text(json.dumps(out))
    print(f"완료: vision.bin {len(blob)/1e3:.0f} KB")


if __name__ == "__main__":
    main()
