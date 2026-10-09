"""버섯체(mushroom body) 학습 회로 데이터 → web/data/mb.json

초파리의 연합 학습(냄새 + 보상/처벌)은 버섯체에서 일어난다:
  케년세포(KC, 냄새마다 다른 일부가 켜짐) → 버섯체 출력 뉴런(MBON) 시냅스가,
  같은 구획의 도파민 뉴런(DAN)이 함께 활동하면 약해진다(장기 억압, Hige et al. 2015; Cohn et al. 2015).
  보상 도파민(PAM) 구획의 MBON은 회피를, 처벌 도파민(PPL1) 구획의 MBON은 다가가기를 부추긴다
  (Aso et al. 2014). 그래서 냄새 + 단맛(보상)을 짝지으면 회피 출력이 줄어 그 냄새를 좋아하게 된다.

구획은 연결체에서 직접 정한다: 각 MBON에 시냅스를 보내는 DAN(PAM/PPL1)을 그 MBON의 구획 DAN으로,
더 많이 보내는 계열을 그 MBON의 계열로 본다.

자극별 KC 코드(cs): 감각 뉴런 → (한 다리) → KC로 이어지는 흥분성 2시냅스 경로의 세기를 KC마다 더하고,
APL 억제가 만드는 희소 코드처럼 가장 강하게 입력받는 5%만 남긴다. 시뮬레이션 속 KC 발화는 자극 몇 ms 뒤
뇌 전체 점화에 휩쓸려 자극끼리 거의 같아지므로(상관 0.99), '무슨 자극인지'는 이 직통 입력으로 정한다.
2시냅스 안에 KC에 닿는 감각은 냄새·온도·습도(조금은 빛)뿐이고 맛·소리·촉각은 닿지 않는다.

입력: FlyWire v783 classification / consolidated_cell_types (build_dataset.py와 같은 뉴런 순서),
      web/data의 CSR 연결.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

MIN_DAN_SYN = 5          # 이 이상 시냅스를 보내는 DAN만 그 MBON의 구획으로 본다
CS_FRAC = 0.05           # 자극별 KC 코드: 2시냅스 입력 상위 5%


def main(src: Path, out: Path):
    cls = pd.read_csv(src / "classification.csv.gz", usecols=["root_id", "class"])
    cls = cls.drop_duplicates("root_id").reset_index(drop=True)
    ct = pd.read_csv(src / "consolidated_cell_types.csv.gz", usecols=["root_id", "primary_type"])
    d = cls.reset_index().merge(ct, on="root_id", how="left").sort_values("index").reset_index(drop=True)
    n = len(d)
    indptr = np.fromfile(out / "csr_indptr_u32.bin", dtype=np.uint32)
    targets = np.fromfile(out / "csr_targets_u32.bin", dtype=np.uint32)
    weights = np.fromfile(out / "csr_weights_i16.bin", dtype=np.int16)
    assert len(indptr) == n + 1, "build_dataset.py와 뉴런 순서가 달라졌다"

    pt = d.primary_type.astype(str)
    kc = np.where(d["class"] == "Kenyon_Cell")[0]
    mbon = np.where(d["class"] == "MBON")[0]
    pam = np.where(pt.str.startswith("PAM"))[0]
    ppl1 = np.where(pt.str.startswith("PPL1"))[0]
    pos = np.full(n, -1)
    pos[mbon] = np.arange(len(mbon))

    # DAN → MBON 직접 시냅스 수
    syn = {}
    for fam, idx in (("PAM", pam), ("PPL1", ppl1)):
        for i in idx:
            a, b = indptr[i], indptr[i + 1]
            for t, w in zip(targets[a:b], weights[a:b]):
                m = pos[t]
                if m >= 0:
                    syn.setdefault(int(m), {}).setdefault(fam, {}).setdefault(int(i), 0)
                    syn[int(m)][fam][int(i)] += abs(int(w))

    comp, valence, fams = [], [], []
    for m in range(len(mbon)):
        s = syn.get(m, {})
        pam_n = sum(s.get("PAM", {}).values())
        ppl_n = sum(s.get("PPL1", {}).values())
        dans = sorted(i for fam in s for i, c in s[fam].items() if c >= MIN_DAN_SYN)
        comp.append(dans)
        if pam_n == 0 and ppl_n == 0:
            valence.append(0); fams.append("")
        elif ppl_n > pam_n:
            valence.append(1); fams.append("PPL1")       # 처벌 구획 MBON → 다가가기
        else:
            valence.append(-1); fams.append("PAM")       # 보상 구획 MBON → 회피

    # 자극별 KC 코드: 감각 → 한 다리 → KC 흥분성 경로 (KC → KC 경로는 뺀다)
    src = np.repeat(np.arange(n), np.diff(indptr.astype(np.int64)))
    wpos = np.maximum(weights.astype(np.float64), 0)
    is_kc = np.zeros(n, bool); is_kc[kc] = True
    meta = json.loads((out / "meta.json").read_text())
    cs, ref = {}, None
    for key, p in meta["presets"].items():
        x = np.zeros(n); x[p["idx"]] = 1
        h1 = np.bincount(targets, weights=x[src] * wpos, minlength=n)
        direct = h1[kc].copy()
        h1[is_kc] = 0
        h2 = np.bincount(targets, weights=h1[src] * wpos, minlength=n)
        d = direct + h2[kc]
        if d.max() <= 0:
            continue
        k_top = int(len(kc) * CS_FRAC)
        order = np.argsort(-d)[:k_top]
        order = order[d[order] > 0]
        thr = d[order[-1]]
        if key == "smell":
            ref = thr
        cs[key] = {"kc": order.tolist(), "w": np.round(d[order] / d[order[0]], 3).tolist(), "thr": float(thr)}
    for key, c in cs.items():
        # 버섯체로 들어가는 길의 굵기 (냄새 = 1). 제곱근으로 눌러 차이를 줄인다
        c["strength"] = round(float(np.sqrt(min(1.0, c.pop("thr") / ref))), 3)

    kc_mbon = 0
    for i in kc:
        a, b = indptr[i], indptr[i + 1]
        kc_mbon += int((pos[targets[a:b]] >= 0).sum())

    data = {
        "kc": kc.tolist(), "mbon": mbon.tolist(), "pam": pam.tolist(), "ppl1": ppl1.tolist(),
        "mbon_type": pt.iloc[mbon].tolist(), "valence": valence, "family": fams, "comp_dan": comp,
        "kc_mbon_synapses": kc_mbon, "cs": cs,
    }
    (out / "mb.json").write_text(json.dumps(data, separators=(",", ":")))
    print(f"KC {len(kc)}, MBON {len(mbon)} (회피 {valence.count(-1)}, 다가가기 {valence.count(1)}, 미정 {valence.count(0)}), "
          f"PAM {len(pam)}, PPL1 {len(ppl1)}, KC→MBON 시냅스 쌍 {kc_mbon}")
    print("자극별 KC 코드:", ", ".join(f"{k} {len(c['kc'])}개 (길 {c['strength']})" for k, c in cs.items()))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else Path("web/data"))
