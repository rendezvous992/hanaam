// 💾 훈련된 오목 초파리 뇌를 사이트(아티팩트) 공유 저장소에 보관한다.
//
// 링크로 들어온 사람은 누구나 마지막으로 저장된 뇌를 이어받는다. 저장(쓰기)은
// 아티팩트 주인과 편집 권한자만 되고, 나머지는 불러와서 이 창에서만 더 가르칠 수 있다.
// 뇌 전체(가중치 270만 개)가 아니라 학습으로 바뀐 시냅스만 (인덱스, 가중치)로 담는다:
//   인덱스는 정렬된 차이를 varint로, 가중치는 float32로 → base64 → 문서당 ~200KB 조각.
// 문서 구조: flies/<id> (이름·기록·훈련 이력·현재 조각 버전) — 초파리마다 하나,
//            flies/<id>/brain/<버전>_<i> (뇌 조각)
// 메인 초파리의 경험(버섯체 기억·내성)은 같은 방식으로 mainfly/<id> 아래에 둔다.

const CHUNK = 200000;          // base64 글자 수 (문서 한도 256KiB 아래)
const MAX_PRAISE = 5000;       // 판별 칭찬 비율 이력 상한

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// idx(오름차순)와 val → 바이트: [개수 u32][varint 차이...][float32 값...]
export function encodeDiff(idx, val) {
  const out = new Uint8Array(4 + idx.length * 5 + val.length * 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, idx.length, true);
  let p = 4, prev = 0;
  for (let k = 0; k < idx.length; k++) {
    let d = idx[k] - prev; prev = idx[k];
    while (d >= 0x80) { out[p++] = (d & 0x7f) | 0x80; d >>>= 7; }
    out[p++] = d;
  }
  for (let k = 0; k < val.length; k++, p += 4) dv.setFloat32(p, val[k], true);
  return out.subarray(0, p);
}

export function decodeDiff(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(0, true);
  const idx = new Uint32Array(n), val = new Float32Array(n);
  let p = 4, prev = 0;
  for (let k = 0; k < n; k++) {
    let d = 0, sh = 0, b;
    do { b = u8[p++]; d += (b & 0x7f) * 2 ** sh; sh += 7; } while (b & 0x80);
    prev += d; idx[k] = prev;
  }
  for (let k = 0; k < n; k++, p += 4) val[k] = dv.getFloat32(p, true);
  return { idx, val };
}

export class BrainStore {
  constructor(base = 'flies', trim = trimMeta) {
    this.base = base; this.trim = trim;
    this.db = null; this.canWrite = false;
    this.state = 'local';          // 'local' | 'shared' | 'readonly'
    this.queue = Promise.resolve();
    this.ready = this.init();
  }

  async init() {
    try {
      if (!window.claude?.use) return;
      this.db = await window.claude.use('db');
      if (!this.db) return;
      const user = await window.claude.use('user');
      const can = user ? await user.can('data.write') : null;
      this.canWrite = can !== false;         // null = 알 수 없음 → 써 보고 거절되면 읽기 전용
      this.state = this.canWrite ? 'shared' : 'readonly';
    } catch { this.db = null; }
  }

  // 저장된 초파리 목록 [{id, ...메타}] (뇌 조각은 하위 컬렉션이라 안 딸려 온다)
  async list() {
    await this.ready;
    if (!this.db) return [];
    const q = await this.db.collection(this.base).limit(200).get();
    return q.docs.filter(d => d.exists).map(d => ({ id: d.id, ...d.data() }));
  }

  // 한 마리의 저장본: { meta, diff:{idx,val}|null } 또는 null
  async load(k) {
    await this.ready;
    if (!this.db) return null;
    const snap = await this.db.doc(`${this.base}/${k}`).get();
    if (!snap.exists) return null;
    const meta = snap.data();
    let diff = null;
    if (meta.ver && meta.chunks) {
      const parts = await Promise.all(Array.from({ length: meta.chunks },
        (_, i) => this.db.doc(`${this.base}/${k}/brain/${meta.ver}_${i}`).get()));
      if (parts.every(s => s.exists)) diff = decodeDiff(fromB64(parts.map(s => s.data().d).join('')));
      else meta.broken = true;   // 다른 창이 막 저장하는 중 — 기록만 가져온다
    }
    return { meta, diff };
  }

  // 쓰기는 한 번에 하나씩 (같은 문서에 겹쳐 쓰지 않도록)
  enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  // 기록만 갱신 (대결 결과 등 — 뇌는 그대로)
  saveMeta(k, meta) {
    if (!this.db || !this.canWrite) return Promise.resolve(false);
    return this.enqueue(async () => {
      try {
        const ref = this.db.doc(`${this.base}/${k}`);
        const cur = await ref.get();
        const keep = cur.exists ? { ver: cur.data().ver || null, chunks: cur.data().chunks || 0 } : { ver: null, chunks: 0 };
        await ref.set({ ...this.trim(meta), ...keep, updatedAt: Date.now() });
        return true;
      } catch (e) { return this.fail(e); }
    });
  }

  // 뇌(바뀐 시냅스) + 기록 저장. 새 버전 조각을 다 쓴 뒤 메타를 가리키게 하고 옛 조각을 지운다.
  saveBrain(k, meta, idx, val) {
    if (!this.db || !this.canWrite) return Promise.resolve(false);
    return this.enqueue(async () => {
      try {
        const ref = this.db.doc(`${this.base}/${k}`);
        const cur = await ref.get();
        const old = cur.exists ? cur.data() : null;
        const b64 = idx.length ? toB64(encodeDiff(idx, val)) : '';
        const ver = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const chunks = Math.ceil(b64.length / CHUNK);
        for (let i = 0; i < chunks; i++)
          await this.db.doc(`${this.base}/${k}/brain/${ver}_${i}`).set({ d: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
        await ref.set({ ...this.trim(meta), ver: chunks ? ver : null, chunks, bytes: b64.length, updatedAt: Date.now() });
        if (old?.ver) for (let i = 0; i < (old.chunks || 0); i++)
          await this.db.doc(`${this.base}/${k}/brain/${old.ver}_${i}`).delete().catch(() => {});
        return true;
      } catch (e) { return this.fail(e); }
    });
  }

  // 초파리 한 마리를 저장소에서 지운다 (뇌 조각 → 메타 순서)
  remove(id) {
    if (!this.db || !this.canWrite) return Promise.resolve(false);
    return this.enqueue(async () => {
      try {
        const ref = this.db.doc(`${this.base}/${id}`);
        const cur = await ref.get();
        if (cur.exists) {
          const m = cur.data();
          if (m.ver) for (let i = 0; i < (m.chunks || 0); i++)
            await this.db.doc(`${this.base}/${id}/brain/${m.ver}_${i}`).delete().catch(() => {});
        }
        await ref.delete();
        return true;
      } catch (e) { return this.fail(e); }
    });
  }

  fail(e) {
    if (e?.code === 'invalid_argument' || e?.code === 'revoked' || e?.code === 'not_granted') {
      this.canWrite = false; this.state = 'readonly';
    }
    this.lastError = e?.code === 'quota_exceeded' ? '저장 공간이 가득 찼습니다' : (e?.message || String(e));
    return false;
  }
}

function trimMeta(m) {
  return {
    name: String(m.name || '').slice(0, 16), createdAt: m.createdAt || 0,
    record: m.record, trained: m.trained, synChanged: m.synChanged,
    praise: m.praise.slice(-MAX_PRAISE).map(x => Math.round(x * 1000) / 1000),
    pong: { w: m.pong.w, l: m.pong.l, trained: m.pong.trained, hits: m.pong.hits.slice(-MAX_PRAISE) },
  };
}
