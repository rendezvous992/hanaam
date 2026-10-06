// 커넥톰·시각 데이터 로더 (메인 화면과 오목 경기장이 같이 쓴다).

export async function fetchBin(url) {
  // 정적 서버에서는 .bin을 그대로, .bin을 서빙하지 못하는 호스팅(claude.ai
  // 아티팩트 등)에서는 base64 텍스트(.b64.txt) 폴백을 읽는다.
  const r = await fetch(url);
  if (r.ok) return r.arrayBuffer();
  const r2 = await fetch(url + '.b64.txt');
  if (!r2.ok) throw new Error(`${url}: ${r.status}/${r2.status}`);
  const s = (await r2.text()).replace(/\s+/g, '');
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

// 시뮬레이션 워커에 넘길 연결 데이터 (워커로 전송하면 원본이 비워지므로 매번 새로 받는다)
export async function loadWiring() {
  const [indptr, targets, weights] = await Promise.all([
    fetchBin('data/csr_indptr_u32.bin'),
    fetchBin('data/csr_targets_u32.bin'),
    fetchBin('data/csr_weights_i16.bin'),
  ]);
  return { indptr, targets, weights };
}

// 초파리 눈: R1-6 광수용체의 화면 좌표 + 수용장을 측정한 시각 뉴런들 (build_vision.py)
export async function loadVision() {
  const [info, blob] = await Promise.all([
    fetch('data/vision.json').then(r => r.json()),
    fetchBin('data/vision.bin'),
  ]);
  const P = info.photo_n, S = info.percept_n;
  let o = 0;
  const take = (Type, len) => { const a = new Type(blob, o, len); o += len * Type.BYTES_PER_ELEMENT; return a; };
  const photoIdx = take(Uint32Array, P);
  const pu = take(Uint16Array, P), pv = take(Uint16Array, P);
  const perIdx = take(Uint32Array, S);
  const su = take(Uint16Array, S), sv = take(Uint16Array, S);
  const f = a => Float32Array.from(a, x => x / 65535);
  return { info, photoIdx, pu: f(pu), pv: f(pv), perIdx, su: f(su), sv: f(sv) };
}
