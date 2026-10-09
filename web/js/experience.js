// 경험과 변화: 메인 초파리 뇌의 가소성(습관화·버섯체 냄새 기억·내성)을 보여 주고 저장한다.
// 계산은 전부 sim-worker.js가 하고, 여기서는 워커가 보내는 통계를 그리고
// 오래 가는 기억(KC → MBON 세기와 내성)을 사이트 공유 저장소에 보관한다.
import { BrainStore } from './brain-store.js';

const CS_NAME = { smell: '냄새', temp: '온도', humid: '습도', sight: '빛' };
const SAVE_EVERY = 30000;      // ms — 바뀐 게 있으면 이 간격으로 저장 (저장 권한이 있을 때만)
const KEY = 'fly';             // 메인 초파리는 한 마리

const pct = x => Math.round(Math.abs(x) * 100) + '%';

export class Experience {
  constructor({ worker, fly, meta }) {
    this.worker = worker; this.fly = fly;
    this.names = Object.fromEntries(Object.entries(meta.presets).map(([k, p]) => [k, p.name_ko.replace(/\s*\(.*\)\s*$/, '')]));
    this.tolE = 0; this.tolN = 0; this.eth = 0; this.nic = 0;
    this.smellOn = false;
    this.last = null; this.savedSig = ''; this.loaded = false; this.saving = false;
    this.store = new BrainStore('mainfly', m => ({
      tolE: +(+m.tolE || 0).toFixed(4), tolN: +(+m.tolN || 0).toFixed(4),
      memSyn: m.memSyn | 0, savedAt: Date.now(),
    }));
    this.el = {
      mem: document.getElementById('mem-rows'), hab: document.getElementById('hab-grid'),
      tol: document.getElementById('tol-rows'), line: document.getElementById('exp-line'),
      save: document.getElementById('exp-save'), reset: document.getElementById('exp-reset'),
    };
    this.el.reset.onclick = () => this.resetClick();
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.maybeSave(true); });
    setInterval(() => this.maybeSave(false), SAVE_EVERY);
    this.setSave('불러오는 중…');
  }

  // 워커 메시지 (main.js가 frame 외의 것을 넘긴다)
  onMessage(m) {
    if (m.type === 'plasticReady') this.load();
    else if (m.type === 'plasticStats') this.update(m);
    else if (m.type === 'mem') this.onMem(m);
    else if (m.type === 'memImported') { this.savedSig = null; this.loaded = true; this.refreshSave(); }
  }

  // ── 표시 ─────────────────────────────────────
  update(st) {
    this.last = st;
    // 불러온 직후(또는 저장본이 없을 때) 첫 통계를 '저장된 상태'로 잡는다
    if (this.loaded && this.savedSig === null) this.savedSig = this.sig();
    this.tolE = st.tolE; this.tolN = st.tolN;
    this.applyDrugs();
    // 냄새가 나는 동안: 지금 켜진 KC로 읽은 학습된 가치 → 다가가기/피하기
    this.fly.setValence?.(this.smellOn ? st.live.pref : 0);

    const { mem, hab, tol, line } = this.el;
    // 냄새 기억: 버섯체로 가는 길이 있는 자극만 (빛은 2시냅스 길이 거의 없어 뺀다)
    const keys = Object.keys(st.mem).filter(k => st.mem[k].strength >= 0.05);
    if (mem.childElementCount !== keys.length) {
      mem.innerHTML = keys.map(k => `<div class="meter two" data-k="${k}"><span class="m-name">${CS_NAME[k] || k}</span>` +
        `<span class="m-track"><i></i></span><span class="m-val"></span></div>`).join('');
    }
    for (const row of mem.children) {
      const v = st.mem[row.dataset.k], p = Math.max(-1, Math.min(1, v.pref));
      const bar = row.querySelector('i');
      bar.style.width = (Math.abs(p) * 50) + '%';
      bar.style.left = p >= 0 ? '50%' : (50 - Math.abs(p) * 50) + '%';
      row.classList.toggle('like', p > 0.02); row.classList.toggle('dislike', p < -0.02);
      row.querySelector('.m-val').textContent = Math.abs(p) < 0.02 ? '중립' : (p > 0 ? '좋아함 ' : '싫어함 ') + pct(p);
      row.title = `좋아함 쪽 변화 ${pct(v.like)} · 싫어함 쪽 변화 ${pct(v.dislike)} (버섯체로 가는 길의 굵기 ${v.strength})`;
    }
    // 습관화: 모든 감각 자극 (2% 미만은 흐리게)
    const hk = Object.keys(st.hab);
    if (hab.childElementCount !== hk.length) {
      hab.innerHTML = hk.map(k => `<div class="hab" data-k="${k}"><span>${this.names[k] || k}</span><b></b><i><u></u></i></div>`).join('');
    }
    for (const cell of hab.children) {
      const v = st.hab[cell.dataset.k];
      cell.querySelector('b').textContent = v < 0.02 ? '–' : pct(v);
      cell.querySelector('u').style.width = Math.min(100, v / 0.7 * 100) + '%';
      cell.classList.toggle('dim', v < 0.02);
    }
    // 내성 (최대 60%)
    if (!tol.childElementCount) {
      tol.innerHTML = [['E', '에탄올'], ['N', '니코틴']].map(([k, n]) =>
        `<div class="meter one" data-k="${k}"><span class="m-name">${n}</span><span class="m-track"><i></i></span><span class="m-val"></span></div>`).join('');
    }
    for (const row of tol.children) {
      const v = row.dataset.k === 'E' ? st.tolE : st.tolN;
      row.querySelector('i').style.width = Math.min(100, v / 0.6 * 100) + '%';
      row.querySelector('.m-val').textContent = v < 0.01 ? '없음' : pct(v);
    }
    line.textContent = `기억으로 바뀐 시냅스 ${st.memSyn.toLocaleString()}개 / ${st.memTotal.toLocaleString()}` +
      (st.habN ? ` · 둔해진 감각 뉴런 ${st.habN.toLocaleString()}개` : '');
    if (this.loaded) this.refreshSave();
  }

  // 에탄올·니코틴: 3D 초파리에도 내성만큼 덜 듣게
  setDrugs(eth, nic) { if (eth !== undefined) this.eth = eth; if (nic !== undefined) this.nic = nic; this.applyDrugs(); }
  applyDrugs() {
    this.fly.setEthanol(this.eth * (1 - this.tolE));
    this.fly.setNicotine(this.nic * (1 - this.tolN));
  }
  setSmell(on) { this.smellOn = on; this.fly.setOdor?.(on); if (!on) this.fly.setValence?.(0); }

  // ── 저장 ─────────────────────────────────────
  sig() {
    const st = this.last;
    if (!st) return '';
    // 2% 눈금: 아주 느린 망각·내성 회복 때문에 쉴 새 없이 저장하지 않게
    const mem = Object.values(st.mem).map(v => Math.round(v.like * 50) + ':' + Math.round(v.dislike * 50)).join(',');
    return `${Math.round(st.memSyn / 20)}|${mem}|${Math.round(st.tolE * 50)}|${Math.round(st.tolN * 50)}`;
  }

  async load() {
    try {
      await this.store.ready;
      const got = await this.store.load(KEY);
      this.loadedNote = got ? '저장된 경험을 이어받음' : '';
      if (got && (got.diff || got.meta)) {
        // 워커가 기억을 넣고 memImported를 보내면 그때부터 저장 기준을 잡는다
        const d = got.diff || { idx: [], val: [] };
        this.worker.postMessage({ type: 'importMem', idx: d.idx, val: d.val, tolE: got.meta.tolE, tolN: got.meta.tolN });
        return;
      }
      this.loaded = true;
      this.savedSig = null;
    } catch (e) {
      this.loaded = false;            // 못 불러왔으면 덮어쓰지 않는다
      this.setSave('저장소를 읽지 못해 이 창에서만 유지됩니다');
      return;
    }
    this.refreshSave();
  }

  refreshSave() {
    const s = this.store;
    if (this.saving) return;
    if (!s.db) { this.setSave('이 창에서만 유지됩니다 (공유 저장소 없음)'); return; }
    if (!s.canWrite) { this.setSave((this.loadedNote ? this.loadedNote + ' · ' : '') + '이 창의 변화는 저장되지 않습니다 (저장은 주인만)'); return; }
    const dirty = this.savedSig !== null && this.sig() !== this.savedSig;
    this.setSave(dirty ? '바뀐 경험은 잠시 뒤 자동 저장됩니다' :
      (this.savedAt ? `공유 저장소에 저장됨 · ${new Date(this.savedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` :
        (this.loadedNote || '공유 저장소와 같은 상태')));
  }

  maybeSave(now) {
    const s = this.store;
    if (!this.loaded || !s.db || !s.canWrite || this.saving || !this.last || this.savedSig === null) return;
    if (this.sig() === this.savedSig) return;
    this.saving = true;
    this.pendingSig = this.sig();
    this.setSave('저장 중…');
    this.worker.postMessage({ type: 'exportMem', id: Date.now() });
    if (now) this.flushOnHide = true;
  }

  async onMem(m) {
    const meta = { tolE: m.tolE, tolN: m.tolN, memSyn: this.last?.memSyn || 0 };
    const ok = await this.store.saveBrain(KEY, meta, m.idx, m.val);
    this.saving = false;
    if (ok) { this.savedSig = this.pendingSig; this.savedAt = Date.now(); }
    else this.setSave('저장 실패: ' + (this.store.lastError || '알 수 없는 오류'));
    if (ok) this.refreshSave();
  }

  setSave(t) { this.el.save.textContent = t; }

  // ── 초기화 (두 번 눌러 확인) ──────────────────
  resetClick() {
    const b = this.el.reset;
    if (!b.classList.contains('warn')) {
      b.classList.add('warn');
      b.textContent = '한 번 더 누르면 초기화';
      clearTimeout(this._rt);
      this._rt = setTimeout(() => { b.classList.remove('warn'); b.textContent = '경험 초기화'; }, 3000);
      return;
    }
    clearTimeout(this._rt);
    b.classList.remove('warn'); b.textContent = '경험 초기화';
    this.worker.postMessage({ type: 'plasticReset', what: 'all' });
  }
}
