#!/usr/bin/env python3
"""FlyWire v783 공개 커넥톰 데이터를 브라우저용 바이너리로 변환하는 파이프라인.

입력 (https://codex.flywire.ai / 공개 GCS 버킷):
  - classification.csv.gz  뉴런 분류 (super_class, class, side, ...)
  - neurons.csv.gz         뉴런별 신경전달물질 예측
  - coordinates.csv.gz     뉴런 좌표 (FAFB 공간, nm)
  - connections.csv.gz     시냅스 연결 (pre, post, neuropil, syn_count, nt_type)
  - labels.csv.gz          커뮤니티 라벨 (설탕/쓴맛 GRN 등 식별에 사용)

출력 (web/data/):
  - positions_u16.bin   N x 3 uint16  (bbox 정규화 좌표)
  - group_u8.bin        N uint8       (super_class 인덱스)
  - csr_indptr_u32.bin  (N+1) uint32  (CSR 행 포인터)
  - csr_targets_u32.bin E uint32      (시냅스 후 뉴런 인덱스)
  - csr_weights_i16.bin E int16       (부호 있는 시냅스 가중치 = ±syn_count)
  - meta.json           메타데이터 + 자극 프리셋 인덱스

사용법:
  python3 build_dataset.py --src <csv 디렉터리> --out ../web/data
  (--download 를 주면 공개 버킷에서 CSV를 자동으로 받는다)
"""

import argparse
import gzip
import json
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

BUCKET = "https://storage.googleapis.com/flywire-data/codex/data/fafb/783"
SKEL_BUCKET = "https://storage.googleapis.com/flywire-data/codex/skeletons/fafb/lod1"
FILES = [
    "classification.csv.gz",
    "neurons.csv.gz",
    "coordinates.csv.gz",
    "connections.csv.gz",
    "labels.csv.gz",
]

# Shiu et al. 2024 (eLife) 관례: ACH/DA/SER/OCT 흥분(+), GABA/GLUT 억제(-)
NT_SIGN = {"ACH": 1, "DA": 1, "SER": 1, "OCT": 1, "GABA": -1, "GLUT": -1}

SUPER_CLASSES = [
    "optic", "central", "sensory", "visual_projection", "ascending",
    "descending", "sensory_ascending", "visual_centrifugal", "motor", "endocrine",
]


def download(src: Path):
    src.mkdir(parents=True, exist_ok=True)
    for f in FILES:
        dst = src / f
        if dst.exists():
            print(f"skip {f} (이미 있음)")
            continue
        print(f"downloading {f} ...")
        urllib.request.urlretrieve(f"{BUCKET}/{f}", dst)


def parse_positions(series: pd.Series) -> np.ndarray:
    # "[352484 175164 229040]" 형태의 문자열 파싱
    out = np.zeros((len(series), 3), dtype=np.float64)
    for i, s in enumerate(series):
        out[i] = [float(v) for v in re.findall(r"-?\d+", s)[:3]]
    return out


def build(src: Path, out: Path):
    out.mkdir(parents=True, exist_ok=True)

    print("classification 로드 ...")
    cls = pd.read_csv(src / "classification.csv.gz",
                      usecols=["root_id", "super_class", "class", "side"])
    cls = cls.drop_duplicates("root_id").reset_index(drop=True)
    n = len(cls)
    root_ids = cls["root_id"].to_numpy(dtype=np.uint64)
    index_of = pd.Series(np.arange(n, dtype=np.int64), index=root_ids)
    print(f"  뉴런 {n:,}개")

    print("coordinates 로드 ...")
    coords = pd.read_csv(src / "coordinates.csv.gz", usecols=["root_id", "position"])
    coords = coords.drop_duplicates("root_id", keep="first")
    coords = coords[coords["root_id"].isin(index_of.index)]
    pos_f = np.full((n, 3), np.nan)
    idx = index_of.loc[coords["root_id"].to_numpy(dtype=np.uint64)].to_numpy()
    pos_f[idx] = parse_positions(coords["position"])
    missing = np.isnan(pos_f[:, 0])
    print(f"  좌표 없음: {missing.sum():,}개 → 중앙값 근처에 배치")
    med = np.nanmedian(pos_f, axis=0)
    rng = np.random.default_rng(42)
    pos_f[missing] = med + rng.normal(0, 3000, (missing.sum(), 3))

    lo, hi = np.nanmin(pos_f, axis=0), np.nanmax(pos_f, axis=0)
    pos_u16 = np.clip((pos_f - lo) / (hi - lo) * 65535.0, 0, 65535).astype(np.uint16)

    group = np.array(
        [SUPER_CLASSES.index(sc) if sc in SUPER_CLASSES else len(SUPER_CLASSES)
         for sc in cls["super_class"].fillna("")],
        dtype=np.uint8)

    print("connections 로드 (수 분 소요) ...")
    con = pd.read_csv(src / "connections.csv.gz",
                      usecols=["pre_root_id", "post_root_id", "syn_count", "nt_type"])
    con = con[con["pre_root_id"].isin(index_of.index)
              & con["post_root_id"].isin(index_of.index)]
    sign = con["nt_type"].map(NT_SIGN).fillna(1).astype(np.int64)
    con["w"] = con["syn_count"] * sign
    print(f"  연결 행 {len(con):,}개 → (pre,post) 쌍으로 집계 ...")
    agg = con.groupby(["pre_root_id", "post_root_id"], sort=False)["w"].sum().reset_index()
    pre = index_of.loc[agg["pre_root_id"].to_numpy(dtype=np.uint64)].to_numpy()
    post = index_of.loc[agg["post_root_id"].to_numpy(dtype=np.uint64)].to_numpy()
    w = np.clip(agg["w"].to_numpy(), -32767, 32767).astype(np.int16)
    e = len(w)
    print(f"  고유 시냅스 쌍 {e:,}개")

    order = np.lexsort((post, pre))
    pre, post, w = pre[order], post[order], w[order]
    indptr = np.zeros(n + 1, dtype=np.uint32)
    np.add.at(indptr, pre + 1, 1)
    indptr = np.cumsum(indptr, dtype=np.uint64).astype(np.uint32)

    print("자극 프리셋 구성 ...")
    lab = pd.read_csv(src / "labels.csv.gz", usecols=["root_id", "label"])
    lab = lab[lab["root_id"].isin(index_of.index)]

    def by_label(pattern):
        ids = lab[lab["label"].str.contains(pattern, case=False, na=False,
                                            regex=True)]["root_id"].unique()
        return sorted(index_of.loc[ids].tolist())

    def by_class(name):
        return sorted(index_of.loc[
            cls[cls["class"] == name]["root_id"].to_numpy(dtype=np.uint64)].tolist())

    presets = {
        "sugar":   {"name_ko": "설탕맛 (당분 GRN)",  "idx": by_label(r"sugar gustatory")},
        "bitter":  {"name_ko": "쓴맛 (쓴맛 GRN)",    "idx": by_label(r"bitter gustatory")},
        "smell":   {"name_ko": "냄새 (후각 ORN)",     "idx": by_class("olfactory")},
        "sight":   {"name_ko": "빛 (시각)",           "idx": by_class("visual")},
        "sound":   {"name_ko": "소리·진동 (JO)",      "idx": by_label(r"^JO-")},
        "temp":    {"name_ko": "온도",                "idx": by_class("thermosensory")},
        "humid":   {"name_ko": "습도",                "idx": by_class("hygrosensory")},
        "touch":   {"name_ko": "촉각 (기계감각)",     "idx": by_class("mechanosensory")},
    }
    for k, v in presets.items():
        print(f"  {k}: {len(v['idx']):,}개 뉴런")

    # 행동 판독(readout)·명령 뉴런 그룹: 문헌에서 동정된 뉴런들의 커뮤니티 라벨 사용
    def by_label_prefix(pattern):
        ids = lab[lab["label"].str.match(pattern, case=False, na=False)]["root_id"].unique()
        return sorted(index_of.loc[ids].tolist())

    def by_super(name):
        return sorted(index_of.loc[
            cls[cls["super_class"] == name]["root_id"].to_numpy(dtype=np.uint64)].tolist())

    readouts = {
        # 전진 보행 명령 (Bidaye et al. 2020)
        "fwd":   {"name_ko": "전진 (DNp09)",        "idx": by_label_prefix(r"DNp09")},
        # 후진 보행 명령, 문워커 뉴런 (Bidaye et al. 2014)
        "back":  {"name_ko": "문워크 (MDN)",         "idx": by_label(r"MDN \(Moonwalker")},
        # 도약·탈출 반사 (Giant Fiber)
        "jump":  {"name_ko": "점프 (Giant Fiber)",   "idx": by_label(r"giant fib")},
        # 주둥이 뻗기: 주둥이 운동뉴런 (Sterne et al. 2021 라벨)
        "prob":  {"name_ko": "주둥이 (운동뉴런)",     "idx": by_label(r"proboscis motor neuron|Motor neuron 9; MN9")},
        # 전체 하행뉴런: 전반적 운동 신호
        "dn":    {"name_ko": "하행뉴런 전체",         "idx": by_super("descending")},
        "motor": {"name_ko": "운동뉴런 전체",         "idx": by_super("motor")},
    }
    for k, v in readouts.items():
        print(f"  readout {k}: {len(v['idx']):,}개 뉴런")

    # ── 뉴런 스켈레톤(모폴로지): 주요 뉴런의 실제 3D 가지 형태 ──
    # 릴스/논문 시각화처럼 뉴런을 실뭉치 형태로 그리기 위해 lod1 SWC를 받는다.
    print("스켈레톤 다운로드 (주요 뉴런) ...")
    skel_groups = [
        ("sugar", presets["sugar"]["idx"]), ("bitter", presets["bitter"]["idx"]),
        ("fwd", readouts["fwd"]["idx"]), ("back", readouts["back"]["idx"]),
        ("jump", readouts["jump"]["idx"]), ("prob", readouts["prob"]["idx"]),
    ]
    skel_neurons = []          # [{i: 전역 인덱스, g: 그룹, s: 시작 정점, c: 정점 수}]
    verts = []                 # (x,y,z) 라인 리스트 (2개씩 한 선분)
    seen = set()
    for gname, idxs in skel_groups:
        for gi in idxs:
            if gi in seen:
                continue
            seen.add(gi)
            rid = int(root_ids[gi])
            try:
                with urllib.request.urlopen(f"{SKEL_BUCKET}/{rid}.swc", timeout=90) as rsp:
                    txt = rsp.read().decode()
            except Exception:
                continue
            nodes, edges = {}, []
            for line in txt.splitlines():
                if not line or line[0] == "#":
                    continue
                p = line.split()
                nodes[int(p[0])] = (float(p[2]), float(p[3]), float(p[4]))
                par = int(p[6])
                if par != -1:
                    edges.append((par, int(p[0])))
            # 데시메이션: 큰 뉴런일수록 선분을 성기게 샘플링해 용량을 줄인다
            if len(edges) > 4000: edges = edges[::5]
            elif len(edges) > 1500: edges = edges[::3]
            elif len(edges) > 500: edges = edges[::2]
            start = len(verts)
            for a, b in edges:
                if a in nodes and b in nodes:
                    verts.append(nodes[a]); verts.append(nodes[b])
            cnt = len(verts) - start
            if cnt > 0:
                skel_neurons.append({"i": int(gi), "g": gname, "s": start, "c": cnt})
    if verts:
        sv = np.array(verts)
        sv_u16 = np.clip((sv - lo) / (hi - lo) * 65535.0, 0, 65535).astype(np.uint16)
        (out / "skel_pos_u16.bin").write_bytes(sv_u16.tobytes())
        print(f"  스켈레톤 뉴런 {len(skel_neurons)}개, 정점 {len(verts):,}개 "
              f"({len(verts) * 6 / 1e6:.1f} MB)")

    print("바이너리 저장 ...")
    (out / "positions_u16.bin").write_bytes(pos_u16.tobytes())
    (out / "group_u8.bin").write_bytes(group.tobytes())
    (out / "csr_indptr_u32.bin").write_bytes(indptr.tobytes())
    (out / "csr_targets_u32.bin").write_bytes(post.astype(np.uint32).tobytes())
    (out / "csr_weights_i16.bin").write_bytes(w.tobytes())

    meta = {
        "source": "FlyWire connectome v783 (public snapshot), https://codex.flywire.ai",
        "citation": [
            "Dorkenwald et al. 2024, Nature — Neuronal wiring diagram of an adult brain",
            "Schlegel et al. 2024, Nature — Whole-brain annotation of the Drosophila connectome",
            "Shiu et al. 2024, Nature — A Drosophila computational brain model reveals sensorimotor processing",
        ],
        "n_neurons": int(n),
        "n_edges": int(e),
        "super_classes": SUPER_CLASSES + ["unknown"],
        "presets": presets,
        "readouts": readouts,
        "bbox": {"lo": lo.tolist(), "hi": hi.tolist()},
        "skeletons": skel_neurons,
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    total = sum(f.stat().st_size for f in out.iterdir())
    print(f"완료: {out} ({total/1e6:.1f} MB)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="flywire_csv", help="CSV 디렉터리")
    ap.add_argument("--out", default=str(Path(__file__).parent.parent / "web" / "data"))
    ap.add_argument("--download", action="store_true", help="공개 버킷에서 CSV 다운로드")
    args = ap.parse_args()
    src = Path(args.src)
    if args.download:
        download(src)
    build(src, Path(args.out))
