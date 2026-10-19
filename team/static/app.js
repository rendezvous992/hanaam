/* 팀 오피스: 픽셀 사무실에 팀원을 자리·회의실·라운지에 앉히고, 접속·상태·하는 일을 보여 준다.
 * 서버 모드: /api/team (접속·내가 정한 상태·이번 주 노트) + 워크로드 권한이 있으면 진행 중 카드 + /api/integrations (AI 룸)
 * 브라우저 저장 모드: 나와 이 브라우저 워크로드의 담당자만 보여 준다.
 */
(function () {
  "use strict";
  const K = window.Kit;
  const { $, $$, esc, toast } = K;

  const STATES = [
    ["working", "업무 중"],
    ["focus", "집중 근무"],
    ["meeting", "회의 중"],
    ["visit", "외근·탐방"],
    ["away", "자리 비움"],
    ["leave", "휴가"],
  ];
  const STATE_LABEL = Object.fromEntries(STATES);
  // 말풍선 색 [배경, 글자, 테두리]
  const TONE = {
    working: ["#00857b", "#ffffff", "#005a52"],
    focus: ["#7c5cd6", "#ffffff", "#563aa8"],
    meeting: ["#4f63d9", "#ffffff", "#3445a8"],
    visit: ["#e08a2c", "#ffffff", "#a85f12"],
    away: ["#b8925a", "#ffffff", "#87663a"],
    leave: ["#2f9e5b", "#ffffff", "#1d6e3e"],
    online: ["#e4f6ec", "#14713f", "#7cc79d"],
    offline: ["#eceff2", "#6b7280", "#c4cad2"],
    bot: ["#1f2a37", "#7ff0cf", "#0f1720"],
  };

  // AI 룸: 서버에 연결된 AI·자동 수집 기능 (/api/integrations)
  const BOTS = [
    { name: "리서치봇", color: "#d97757", role: () => "AI 리서치 · Claude", on: (s) => s.ai, need: "ANTHROPIC_API_KEY", href: "/research/" },
    { name: "예약봇", color: "#c9a227", role: () => "예약 리서치 (10분마다)", on: (s) => s.ai && s.cron, need: "ANTHROPIC_API_KEY · CRON_SECRET", href: "/research/" },
    { name: "요약봇", color: "#8a78d6", role: (s) => "노트 요약 · " + (s.summaryProvider || "Grok/Claude"), on: (s) => s.summary, need: "XAI_API_KEY 또는 ANTHROPIC_API_KEY", href: "/notes/" },
    { name: "받아쓰기봇", color: "#4fb3c0", role: (s) => "녹음 받아쓰기 · " + (s.sttProvider || "Whisper"), on: (s) => s.stt, need: "OPENAI_API_KEY 또는 GROQ_API_KEY", href: "/notes/" },
    { name: "공시봇", color: "#5f9ed6", role: () => "DART IR 일정·공시", on: (s) => s.dart, need: "DART_API_KEY", href: "/calendar/" },
    { name: "지표봇", color: "#5fb98a", role: () => "경제 캘린더", on: (s) => s.economic, need: "EODHD_API_KEY", href: "/events/economic/" },
  ];

  let S = { server: false };
  let members = [];
  let integ = {};
  let canWork = false;
  let work = new Map(); // 담당자 이름 -> { doing: [], todo, late }
  let onlineMinutes = 5;
  let skew = 0; // 서버 시각 - 내 PC 시각
  let lastLoad = 0;
  const workStore = K.collection("workload");

  /* ---------- 사람 상태 ---------- */
  function view(m) {
    const w = work.get(m.displayName);
    const doing = !!(w && w.doing.length);
    if (m.state) {
      const where = m.state === "meeting" ? "meeting" : m.state === "away" ? "lounge" : m.state === "visit" || m.state === "leave" ? "out" : "desk";
      return { where, label: m.stateLabel || STATE_LABEL[m.state] || "", tone: m.state, busy: where === "desk" };
    }
    if (m.online || (m.local && doing)) {
      return doing ? { where: "desk", label: "업무 중", tone: "working", busy: true } : { where: "desk", label: "접속 중", tone: "online", busy: false };
    }
    return { where: "out", label: m.local ? "대기" : "오프라인", tone: "offline", busy: false };
  }

  function ago(iso) {
    const t = Date.parse(iso || "");
    if (isNaN(t)) return "";
    const sec = (Date.now() + skew - t) / 1000;
    if (sec < 90) return "방금";
    if (sec < 3600) return Math.round(sec / 60) + "분 전";
    const kst = K.isoKst(iso);
    const day = kst.slice(0, 10);
    if (day === K.today()) return "오늘 " + kst.slice(11);
    if (day === K.addDays(K.today(), -1)) return "어제 " + kst.slice(11);
    const d = K.diffDays(day, K.today());
    return d < 7 ? d + "일 전" : K.md(day);
  }

  function workLine(m) {
    const w = work.get(m.displayName);
    if (!w || !w.doing.length) return "";
    return "진행 중: " + w.doing[0].title + (w.doing.length > 1 ? " 외 " + (w.doing.length - 1) + "건" : "");
  }
  function noteLine(m) {
    const n = m.lastNote;
    return n ? "노트: " + (n.company ? "[" + n.company + "] " : "") + n.title : "";
  }

  /* ---------- 픽셀 그림 ---------- */
  const SKIN = ["#f7d7b8", "#f0c29c", "#e3ad84", "#f5cdaa", "#d39a70"];
  const HAIR = ["#2a1f17", "#4b2f1e", "#1d1d29", "#6e4429", "#8f5b37", "#3b3b40", "#a0612d"];
  const SHIRT = ["#4f8fd9", "#e6b538", "#5fb98a", "#d96a6a", "#8a78d6", "#ef8a4a", "#4fb3c0", "#f1f2f4", "#35506e"];
  const HEAD = [
    ["...HHHHHH...", "..HHHHHHHH..", ".HHHHHHHHHH.", ".HHHHHHHHHH.", ".HSSSSSSSSH.", ".SSESSSSESS.", ".SSSSSSSSSS.", "..SSSMMSSS..", "...SSSSSS..."],
    ["...HHHHHH...", "..HHHHHHHH..", ".HHHHHHHHHH.", "HHHHHHHHHHHH", "HHSSSSSSSSHH", "HSSESSSSESSH", "HSSSSSSSSSSH", "HHSSSMMSSSHH", "HH.SSSSSS.HH"],
    ["..H.HH.HH.H.", ".HHHHHHHHHH.", "HHHHHHHHHHHH", ".HHHHHHHHHH.", ".HSSSSSSSSH.", ".SSESSSSESS.", ".SSSSSSSSSS.", "..SSSMMSSS..", "...SSSSSS..."],
  ];
  const BACK_HEAD = ["...HHHHHH...", "..HHHHHHHH..", ".HHHHHHHHHH.", ".HHHHHHHHHH.", ".HHHHHHHHHH.", ".HHHHHHHHHH.", ".HHHHHHHHHH.", "..HHHHHHHH..", "...SSSSSS..."];
  const BODY = ["..CCCWWCCC..", ".CCCCWWCCCC.", "SCCCCWWCCCCS", "SCCCCCCCCCCS", ".CCCCCCCCCC."];
  const BACK_BODY = ["..CCCCCCCC..", ".CCCCCCCCCC.", "SCCCCCCCCCCS", "SCCCCCCCCCCS", ".CCCCCCCCCC."];
  const LEGS = ["..PPPPPPPP..", "..PPP..PPP..", "..PPP..PPP..", "..BBB..BBB.."];
  const BOT = [".....T......", ".....A......", "..GGGGGGGG..", ".GGVVVVVVGG.", ".GVVEVVEVVG.", ".GVVVVVVVVG.", ".GVVVEEVVVG.", ".GGVVVVVVGG.", "..GGGGGGGG..", "....DDDD....", ".GGGGGGGGGG.", "GGGGGLLGGGGG", "GGGGGGGGGGGG", ".GGGGGGGGGG."];

  function strHash(s) {
    let h = 2166136261;
    for (const ch of String(s)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function palette(m) {
    const h = strHash(m.key);
    return {
      H: HAIR[h % HAIR.length], S: SKIN[(h >>> 5) % SKIN.length], C: SHIRT[(h >>> 10) % SHIRT.length], style: (h >>> 15) % HEAD.length,
      E: "#262833", M: "#c97a6e", W: "#fbfbfb", P: "#3d4b63", B: "#262b33",
    };
  }
  const rect = (x, y, w, h, fill, extra) => '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + fill + '"' + (extra || "") + "/>";
  // 같은 색이 이어지는 칸은 한 사각형으로 합쳐 그린다
  function sprite(rows, x, y, pal) {
    let out = "";
    rows.forEach((row, r) => {
      let c = 0;
      while (c < row.length) {
        const ch = row[c];
        if (ch === ".") {
          c++;
          continue;
        }
        let e = c + 1;
        while (e < row.length && row[e] === ch) e++;
        out += rect(x + c, y + r, e - c, 1, pal[ch]);
        c = e;
      }
    });
    return out;
  }
  function person(m, x, y, pose) {
    const pal = palette(m);
    const rows = pose === "back" ? BACK_HEAD.concat(BACK_BODY) : HEAD[pal.style].concat(BODY, pose === "stand" ? LEGS : []);
    return sprite(rows, x, y, pal);
  }
  function avatar(m, size) {
    const pal = palette(m);
    return '<svg viewBox="0 0 12 12" width="' + size + '" height="' + size + '" shape-rendering="crispEdges" aria-hidden="true">' + sprite(HEAD[pal.style].concat(BODY.slice(0, 3)), 0, 0, pal) + "</svg>";
  }
  function botSprite(b, on, x, y) {
    const pal = { T: on ? "#ffd166" : "#6b7280", A: "#9aa4b2", G: on ? b.color : "#8a919c", V: "#1d2430", E: on ? "#7ff0cf" : "#4b5563", D: "#596273", L: on ? "#ffd166" : "#4b5563" };
    return sprite(BOT, x, y, pal);
  }

  function textW(s, size) {
    let w = 0;
    for (const ch of s) w += /[ᄀ-ᇿ㄰-㆏가-힯一-鿿]/.test(ch) ? 1 : ch === " " ? 0.32 : 0.6;
    return w * size;
  }
  function short(s, n) {
    const a = Array.from(String(s || ""));
    return a.length > n ? a.slice(0, n - 1).join("") + "…" : a.join("");
  }
  function bubble(cx, y, text, tone) {
    const [bg, fg, bd] = TONE[tone] || TONE.offline;
    const w = Math.ceil(textW(text, 5) + 8);
    const h = 9;
    const x = Math.round(cx - w / 2);
    return (
      rect(x, y + 1, w, h - 2, bd) + rect(x + 1, y, w - 2, h, bd) + rect(x + 1, y + 1, w - 2, h - 2, bg) + rect(Math.round(cx) - 1, y + h, 2, 1, bd) +
      '<text x="' + cx + '" y="' + (y + 6.4) + '" font-size="5" font-weight="700" fill="' + fg + '" text-anchor="middle">' + esc(text) + "</text>"
    );
  }
  function nameText(cx, y, text, opts) {
    const o = opts || {};
    return (
      '<text x="' + cx + '" y="' + y + '" font-size="' + (o.size || 5.5) + '" font-weight="700" text-anchor="middle" fill="' + (o.fill || "#1f2a37") +
      '" stroke="' + (o.halo || "rgba(255,255,255,.9)") + '" stroke-width="1.6" paint-order="stroke" stroke-linejoin="round">' + esc(text) + "</text>"
    );
  }
  function tip(m, v) {
    return [m.displayName, v.label, m.note || workLine(m)].filter(Boolean).join(" · ");
  }

  /* ---------- 사무실 배치 ---------- */
  const F = 3; // 바깥 테두리
  const DW = 44; // 책상 칸
  const DH = 52;
  const COLS = 6;
  const PAD = 10;
  const WALL = 24;
  const ZH = 14; // 본부 팻말 높이
  const GAP = 8;
  const LW = PAD * 2 + COLS * DW;
  const PART = 4; // 칸막이 벽
  const RW = 140;
  const W = F + LW + PART + RW + F;
  const MH = 82; // 회의실
  const LH = 76; // 라운지
  const CHAIR = "#3e4756";

  const DEFS =
    "<defs>" +
    '<pattern id="tm-floor" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#cfd9d1"/><rect width="8" height="8" fill="#c6d1c8"/><rect x="8" y="8" width="8" height="8" fill="#c6d1c8"/></pattern>' +
    '<pattern id="tm-wood" width="24" height="6" patternUnits="userSpaceOnUse"><rect width="24" height="6" fill="#d8b98d"/><rect y="5" width="24" height="1" fill="#c6a576"/><rect x="11" width="1" height="5" fill="#c6a576"/></pattern>' +
    '<pattern id="tm-warm" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#ebdcc3"/><rect width="6" height="6" fill="#e3d2b6"/><rect x="6" y="6" width="6" height="6" fill="#e3d2b6"/></pattern>' +
    '<pattern id="tm-grid" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#2c3644"/><rect width="10" height="1" fill="#344152"/><rect width="1" height="10" fill="#344152"/></pattern>' +
    "</defs>";

  function sign(x, y, text, dark) {
    const w = Math.ceil(textW(text, 5) + 8);
    return rect(x, y, w, 9, dark ? "#1b222c" : "#2f3a48") + rect(x, y + 9, w, 1, "rgba(0,0,0,.25)") +
      '<text x="' + (x + 4) + '" y="' + (y + 6.5) + '" font-size="5" font-weight="700" fill="#ffffff">' + esc(text) + "</text>";
  }
  function plant(x, y) {
    return rect(x + 1, y, 6, 3, "#5daa5f") + rect(x, y + 2, 8, 4, "#4c9a52") + rect(x + 2, y + 1, 1, 2, "#79c27a") + rect(x + 1, y + 6, 6, 5, "#b5651d") + rect(x + 1, y + 6, 6, 1, "#cf7c2e");
  }
  function windowAt(x, y) {
    return rect(x, y, 28, 13, "#7d8f99") + rect(x + 1, y + 1, 26, 11, "#bfe6f2") + rect(x + 14, y + 1, 1, 11, "#7d8f99") + rect(x + 3, y + 3, 5, 1, "#effafd") + rect(x + 17, y + 3, 4, 1, "#effafd");
  }
  function wall(x, y, w, h, color) {
    return rect(x, y, w, h, color || "#ece6d8") + rect(x, y, w, 2, "#3a4250") + rect(x, y + h - 3, w, 3, "#c4b79c");
  }

  function deskCell(m, dx, dy) {
    const v = view(m);
    const at = v.where === "desk";
    let s = '<g class="tm-person' + (m.me ? " is-me" : "") + '" data-id="' + esc(m.key) + '"><title>' + esc(tip(m, v)) + "</title>";
    s += rect(dx + 1, dy, DW - 2, DH - 2, "transparent", ' class="tm-hit"');
    s += rect(dx + 15, dy + 15, 14, 11, CHAIR) + rect(dx + 16, dy + 15, 12, 1, "#5b6678");
    if (at) s += '<g class="tm-body' + (v.busy ? " is-busy" : "") + '">' + person(m, dx + 16, dy + 12, "front") + "</g>";
    s += rect(dx + 3, dy + 24, 38, 8, "#c8955a") + rect(dx + 3, dy + 24, 38, 1, "#ddb07a") + rect(dx + 3, dy + 32, 38, 6, "#a5713d") + rect(dx + 4, dy + 38, 36, 1, "rgba(0,0,0,.12)");
    s += rect(dx + 29, dy + 16, 10, 9, "#2b313b") + rect(dx + 30, dy + 17, 8, 7, "#363d49") + rect(dx + 33, dy + 25, 2, 2, "#2b313b") + rect(dx + 31, dy + 27, 6, 1, "#2b313b");
    s += rect(dx + 37, dy + 23, 1, 1, at ? "#3ddc84" : "#6b7280", at ? ' class="tm-led"' : "");
    s += rect(dx + 17, dy + 27, 10, 2, "#e7e9ee") + rect(dx + 7, dy + 25, 3, 3, "#f4f4f5") + rect(dx + 10, dy + 26, 1, 1, "#f4f4f5") + rect(dx + 6, dy + 29, 7, 2, "#fbfbf8");
    s += bubble(dx + 22, dy + 1, v.label, v.tone);
    s += nameText(dx + 22, dy + 46, short(m.displayName, 7), m.me ? { fill: "#00857b" } : null);
    return s + "</g>";
  }

  function personGroup(m, inner) {
    return '<g class="tm-person' + (m.me ? " is-me" : "") + '" data-id="' + esc(m.key) + '"><title>' + esc(tip(m, view(m))) + "</title>" + inner + "</g>";
  }

  function meetingRoom(x, y, w, h, people) {
    let s = rect(x, y, w, h, "url(#tm-wood)") + wall(x, y, w, 14);
    s += rect(x + 46, y + 3, 40, 9, "#9aa4b2") + rect(x + 47, y + 4, 38, 7, "#ffffff") + rect(x + 50, y + 6, 14, 1, "#4f63d9") + rect(x + 50, y + 8, 22, 1, "#d96a6a") + rect(x + 74, y + 6, 8, 3, "#5fb98a");
    s += sign(x + 4, y + 3, "회의실 " + people.length);
    const seats = [0, 1, 2, 3].map((i) => x + 32 + i * 25);
    const top = people.slice(0, 4);
    const bottom = people.slice(4, 8);
    seats.forEach((cx) => (s += rect(cx - 7, y + 31, 14, 10, CHAIR) + rect(cx - 6, y + 31, 12, 1, "#5b6678")));
    top.forEach((m, i) => (s += personGroup(m, person(m, seats[i] - 6, y + 29, "front") + nameText(seats[i], y + 27, short(m.displayName, 5), { size: 4.6 }))));
    s += rect(x + 20, y + 42, w - 40, 14, "#b98552") + rect(x + 20, y + 42, w - 40, 1, "#d4a06c") + rect(x + 20, y + 56, w - 40, 2, "#8e6136");
    s += rect(x + 44, y + 46, 8, 5, "#ffffff") + rect(x + 86, y + 47, 3, 3, "#f4f4f5");
    bottom.forEach((m, i) => (s += personGroup(m, person(m, seats[i] - 6, y + 52, "back") + nameText(seats[i], y + 76, short(m.displayName, 5), { size: 4.6 }))));
    seats.forEach((cx) => (s += rect(cx - 7, y + 61, 14, 8, CHAIR) + rect(cx - 6, y + 61, 12, 1, "#5b6678")));
    if (people.length > 8) s += nameText(x + w - 12, y + 52, "+" + (people.length - 8), { size: 5 });
    if (!people.length) s += '<text x="' + (x + w / 2) + '" y="' + (y + 51) + '" font-size="4.6" fill="#f3e3cc" text-anchor="middle">비어 있음</text>';
    return s;
  }

  function lounge(x, y, w, h, people) {
    let s = rect(x, y, w, h, "url(#tm-warm)") + wall(x, y, w, 14);
    s += sign(x + 4, y + 3, "라운지 " + people.length);
    // 냉장고·커피 카운터·자판기·화분
    s += rect(x + 6, y + 28, 14, 22, "#e9edf1") + rect(x + 6, y + 36, 14, 1, "#c3cad3") + rect(x + 17, y + 30, 1, 4, "#9aa3ad") + rect(x + 17, y + 39, 1, 5, "#9aa3ad");
    s += rect(x + 24, y + 38, 34, 12, "#8d6a4b") + rect(x + 24, y + 38, 34, 2, "#a88160") + rect(x + 28, y + 29, 9, 9, "#2b313b") + rect(x + 35, y + 31, 1, 1, "#ff6b6b") + rect(x + 31, y + 35, 3, 3, "#ffffff") + rect(x + 42, y + 35, 3, 3, "#ffffff") + rect(x + 47, y + 35, 3, 3, "#ffffff");
    s += rect(x + w - 24, y + 16, 18, 34, "#d64545") + rect(x + w - 22, y + 18, 10, 20, "#bfe6f2") + rect(x + w - 22, y + 22, 10, 1, "#7d8f99") + rect(x + w - 22, y + 28, 10, 1, "#7d8f99") + rect(x + w - 10, y + 22, 2, 4, "#ffd166") + rect(x + w - 22, y + 42, 14, 4, "#2b313b");
    s += plant(x + w - 36, y + 39);
    const spots = [0, 1, 2, 3, 4].map((i) => x + 20 + i * 24);
    people.slice(0, 5).forEach((m, i) => {
      const cx = spots[i];
      s += personGroup(m, person(m, cx - 6, y + 50, "stand") + rect(cx + 6, y + 61, 2, 3, "#ffffff") + nameText(cx, y + h - 2, short(m.displayName, 5), { size: 4.6 }));
    });
    if (people.length > 5) s += nameText(x + w - 10, y + 62, "+" + (people.length - 5), { size: 5 });
    return s;
  }

  function aiRoom(x, y, w, h) {
    const onCount = BOTS.filter((b) => b.on(integ)).length;
    let s = rect(x, y, w, h, "url(#tm-grid)") + wall(x, y, w, 14, "#3d4757");
    s += rect(x + w - 30, y + 3, 10, 9, "#1b222c") + rect(x + w - 18, y + 3, 10, 9, "#1b222c");
    [0, 1, 2].forEach((r) => (s += rect(x + w - 28, y + 5 + r * 2, 1, 1, "#3ddc84", ' class="tm-led"') + rect(x + w - 16, y + 5 + r * 2, 1, 1, r === 1 ? "#ffd166" : "#3ddc84")));
    s += sign(x + 4, y + 3, "AI 룸 " + onCount + "/" + BOTS.length, true);
    BOTS.forEach((b, i) => {
      const on = !!b.on(integ);
      const dx = x + 4 + (i % 3) * DW;
      const dy = y + 30 + Math.floor(i / 3) * 46;
      const cx = dx + 22;
      s += '<g class="tm-bot" data-bot="' + i + '"><title>' + esc(b.name + " · " + b.role(integ) + " · " + (on ? "대기 중" : "미연결")) + "</title>";
      s += rect(dx + 1, dy, DW - 2, 44, "transparent", ' class="tm-hit"');
      s += bubble(cx, dy, on ? "대기 중" : "미연결", on ? "bot" : "offline");
      s += '<g class="tm-body' + (on ? " is-idle" : "") + '">' + botSprite(b, on, cx - 6, dy + 11) + "</g>";
      s += rect(dx + 6, dy + 23, 32, 6, "#8d99ab") + rect(dx + 6, dy + 23, 32, 1, "#aab4c3") + rect(dx + 6, dy + 29, 32, 4, "#6c7789");
      s += rect(dx + 28, dy + 19, 8, 5, "#1b222c") + rect(dx + 29, dy + 20, 6, 3, on ? "#2e8b74" : "#3b4350");
      s += nameText(cx, dy + 40, b.name, { size: 5, fill: on ? "#ffffff" : "#aab4c3", halo: "rgba(20,26,34,.9)" });
      s += "</g>";
    });
    return s;
  }

  function groupsOf(list) {
    const me = list.find((m) => m.me);
    const map = new Map();
    list.forEach((m) => {
      const d = m.department || "";
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(m);
    });
    const groups = Array.from(map, ([dept, ms]) => ({ dept, members: ms.sort((a, b) => a.displayName.localeCompare(b.displayName, "ko")) }));
    const mine = me ? me.department || "" : null;
    return groups.sort((a, b) => (a.dept === mine ? -1 : b.dept === mine ? 1 : 0) || (!a.dept ? 1 : !b.dept ? -1 : 0) || b.members.length - a.members.length || a.dept.localeCompare(b.dept, "ko"));
  }

  function renderScene(list) {
    // 왼쪽 업무 공간: 본부별 책상 묶음을 왼쪽부터 채우고, 넘치면 다음 줄로
    const islands = [];
    let x = F + PAD;
    let y = F + WALL + 6;
    let band = 0;
    groupsOf(list).forEach((g) => {
      const cols = Math.min(COLS, g.members.length);
      const rows = Math.ceil(g.members.length / cols);
      const w = cols * DW;
      const h = ZH + rows * DH;
      if (x + w > F + LW - PAD && x > F + PAD) {
        x = F + PAD;
        y += band + 6;
        band = 0;
      }
      islands.push({ g, x, y, cols, w, h });
      x += w + GAP;
      band = Math.max(band, h);
    });
    const leftH = (islands.length ? y + band : y + 60) + PAD + 8 - F;
    const aiMin = 30 + Math.ceil(BOTS.length / 3) * 46;
    const H = Math.max(leftH, MH + 3 + LH + 3 + aiMin) + F * 2;

    let s = DEFS + rect(0, 0, W, H, "#262c36");
    // 업무 공간
    s += rect(F, F, LW, H - F * 2, "url(#tm-floor)") + wall(F, F, LW, WALL);
    for (let wx = F + 14; wx + 28 < F + LW - 34; wx += 60) s += windowAt(wx, F + 6);
    s += rect(F + LW - 24, F + 7, 11, 11, "#3a4250") + rect(F + LW - 23, F + 8, 9, 9, "#ffffff") + rect(F + LW - 19, F + 10, 1, 3, "#262833") + rect(F + LW - 19, F + 12, 3, 1, "#262833");
    s += plant(F + 3, H - F - 14) + plant(F + LW - 12, H - F - 14);
    islands.forEach((it) => {
      s += rect(it.x - 3, it.y + ZH - 3, it.w + 6, it.h - ZH + 3, "#bfcdc3") + rect(it.x - 2, it.y + ZH - 2, it.w + 4, it.h - ZH + 1, "#dbe5dd");
      s += sign(it.x, it.y, (it.g.dept || "본부 미지정") + " " + it.g.members.length);
      it.g.members.forEach((m, i) => (s += deskCell(m, it.x + (i % it.cols) * DW, it.y + ZH + Math.floor(i / it.cols) * DH)));
    });
    if (!islands.length) s += '<text x="' + (F + LW / 2) + '" y="' + (F + WALL + 40) + '" font-size="6" fill="#5b6b62" text-anchor="middle">표시할 팀원이 없습니다</text>';

    // 오른쪽: 회의실 · 라운지 · AI 룸
    const rx = F + LW + PART;
    const meet = list.filter((m) => view(m).where === "meeting");
    const rest = list.filter((m) => view(m).where === "lounge");
    s += rect(F + LW, F, PART, H - F * 2, "#3a4250");
    s += meetingRoom(rx, F, RW, MH, meet);
    s += rect(rx, F + MH, RW, 3, "#3a4250");
    s += lounge(rx, F + MH + 3, RW, LH, rest);
    s += rect(rx, F + MH + 3 + LH, RW, 3, "#3a4250");
    s += aiRoom(rx, F + MH + 3 + LH + 3, RW, H - F * 2 - MH - 3 - LH - 3);
    // 문 (칸막이에 뚫린 틈)
    s += rect(F + LW, F + 40, PART, 16, "#c9b48f") + rect(F + LW, F + MH + 3 + 40, PART, 16, "#c9b48f");

    const busy = list.filter((m) => view(m).tone !== "offline").length;
    $("#tm-scene").innerHTML =
      '<svg class="tm-svg" viewBox="0 0 ' + W + " " + H + '" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="' +
      esc("사무실 배치도: 팀원 " + list.length + "명 중 " + busy + "명 활동 중, 회의실 " + meet.length + "명, 라운지 " + rest.length + "명") + '">' + s + "</svg>";
  }

  /* ---------- 아래 팀원 카드 ---------- */
  function cardHtml(m) {
    const v = view(m);
    const line = m.note || workLine(m) || noteLine(m);
    const seen = m.local ? "" : m.online ? "접속 중" : m.lastSeenAt ? "마지막 접속 " + ago(m.lastSeenAt) : "접속 기록 없음";
    return (
      '<button type="button" class="tm-card tm-card--' + esc(v.tone) + (m.me ? " is-me" : "") + '" data-id="' + esc(m.key) + '">' +
      '<span class="tm-card__avatar">' + avatar(m, 34) + (m.online ? '<i class="tm-dot" title="접속 중"></i>' : "") + "</span>" +
      '<span class="tm-card__body"><span class="tm-card__top"><b>' + esc(m.displayName) + (m.me ? " <small>나</small>" : "") + "</b>" +
      '<span class="tm-pill tm-pill--' + esc(v.tone) + '">' + esc(v.label) + "</span></span>" +
      '<span class="tm-card__sub">' + esc([m.department || "본부 미지정", seen].filter(Boolean).join(" · ")) + "</span>" +
      '<span class="tm-card__note' + (line ? "" : " is-empty") + '">' + esc(line || (m.me ? "눌러서 지금 하는 일을 적어 보세요" : "—")) + "</span></span></button>"
    );
  }

  function filtered() {
    const dept = $("#tm-dept").value;
    return members.filter((m) => !dept || (dept === "-" ? !m.department : m.department === dept));
  }

  function render() {
    const list = filtered();
    renderScene(list);
    const rank = (m) => (m.me ? 0 : view(m).tone === "offline" ? 2 : 1);
    $("#tm-dock").innerHTML = list.length
      ? list.slice().sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName, "ko")).map(cardHtml).join("")
      : '<p class="tm-empty">표시할 팀원이 없습니다.</p>';
    const n = (f) => list.filter(f).length;
    const chips = [["전체", list.length + "명"]];
    if (!S.server) chips.push(["업무 중", n((m) => view(m).tone === "working")]);
    else {
      chips.push(["접속 중", n((m) => m.online)]);
      STATES.forEach(([k, label]) => {
        const c = n((m) => m.state === k || (k === "working" && !m.state && view(m).tone === "working"));
        if (c) chips.push([label, c]);
      });
    }
    $("#tm-summary").innerHTML = chips.map(([l, c]) => '<span class="tm-chip">' + esc(l) + " <b>" + esc(c) + "</b></span>").join("");
    $("#tm-updated").textContent = lastLoad ? K.nowTime() + " 기준" + (S.server ? " · 1분마다 새로 고침" : "") : "";
  }

  function renderDepts() {
    const sel = $("#tm-dept");
    const cur = sel.value || K.prefs.get("team.dept", "");
    const depts = Array.from(new Set(members.map((m) => m.department).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko"));
    const hasNone = members.some((m) => !m.department);
    sel.innerHTML =
      '<option value="">전체 본부</option>' + depts.map((d) => '<option value="' + esc(d) + '">' + esc(d) + "</option>").join("") + (hasNone ? '<option value="-">본부 미지정</option>' : "");
    sel.value = depts.includes(cur) || (cur === "-" && hasNone) ? cur : "";
  }

  /* ---------- 자세히 · 내 상태 ---------- */
  function openMember(m) {
    const v = view(m);
    const w = work.get(m.displayName);
    const row = (k, val) => '<div class="tm-detail__row"><dt>' + esc(k) + "</dt><dd>" + val + "</dd></div>";
    let rows = row("상태", '<span class="tm-pill tm-pill--' + esc(v.tone) + '">' + esc(v.label) + "</span>" + (m.until && m.until !== K.today() ? " <small>" + esc(K.md(m.until)) + "까지</small>" : ""));
    if (m.note) rows += row("메모", esc(m.note));
    if (!m.local) rows += row("접속", m.online ? "접속 중 <small>(최근 " + onlineMinutes + "분 안에 사용)</small>" : m.lastSeenAt ? "마지막 접속 " + esc(ago(m.lastSeenAt)) : "접속 기록 없음");
    rows += row("본부", esc(m.department || "미지정") + (m.roleLabel ? " · " + esc(m.roleLabel) : ""));
    if (!m.local) {
      rows += row("노트", "이번 주 " + (m.notesWeek || 0) + "건 · 오늘 " + (m.notesToday || 0) + "건" +
        (m.lastNote ? '<br><a href="/notes/#note-' + encodeURIComponent(m.lastNote.id) + '">' + esc(noteLine(m).replace(/^노트: /, "")) + "</a> <small>" + esc(ago(m.lastNote.at)) + "</small>" : ""));
    }
    if (canWork || m.local) {
      const items = w ? w.doing : [];
      rows += row("워크로드", (w ? "진행 중 " + w.doing.length + " · 할 일 " + w.todo + (w.late ? ' · <b class="tm-late">마감 지남 ' + w.late + "</b>" : "") : "카드 없음") +
        (items.length ? '<ul class="tm-detail__list">' + items.slice(0, 5).map((c) => "<li>" + esc(c.title) + (c.due ? " <small>마감 " + esc(K.md(c.due)) + "</small>" : "") + "</li>").join("") + "</ul>" : "") +
        ' <a href="/workload/">워크로드 열기</a>');
    }
    const ctx = K.modal({
      title: m.displayName + (m.me ? " (나)" : ""),
      size: "modal--narrow",
      html:
        '<div class="modal__body"><div class="tm-detail"><div class="tm-detail__avatar">' + avatar(m, 60) + '</div><dl class="tm-detail__rows">' + rows + "</dl></div>" +
        '<div class="modal__footer"><div class="modal__footer-right">' + (m.me ? '<button type="button" class="btn btn--primary" data-set>내 상태 바꾸기</button>' : "") +
        '<button type="button" class="btn btn--ghost" data-close>닫기</button></div></div></div>',
    });
    $("[data-close]", ctx.modal).addEventListener("click", () => ctx.close());
    const set = $("[data-set]", ctx.modal);
    if (set) set.addEventListener("click", () => {
      ctx.close();
      openStatus();
    });
  }

  function openBot(i) {
    const b = BOTS[i];
    const on = !!b.on(integ);
    const body = !S.server
      ? "브라우저 저장 모드에서는 AI 기능을 쓸 수 없습니다. 서버(DB)를 연결하면 이 방의 봇들이 출근합니다."
      : on
      ? "연결되어 있어 언제든 일을 맡길 수 있습니다."
      : "아직 연결되지 않았습니다. 관리자가 서버 환경변수에 <code>" + esc(b.need) + "</code> 를 넣고 다시 배포하면 일을 시작합니다.";
    const ctx = K.modal({
      title: b.name,
      size: "modal--narrow",
      html:
        '<div class="modal__body"><p class="hint"><strong>' + esc(b.role(integ)) + "</strong> · " + (on ? "대기 중" : "미연결") + '</p><p class="hint">' + body + "</p>" +
        '<div class="modal__footer"><div class="modal__footer-right"><a class="btn btn--ghost" href="' + esc(b.href) + '">화면 열기</a><button type="button" class="btn btn--primary" data-close>닫기</button></div></div></div>',
    });
    $("[data-close]", ctx.modal).addEventListener("click", () => ctx.close());
  }

  function openStatus() {
    const me = members.find((m) => m.me) || {};
    const today = K.today();
    const cur = { state: me.state || "", note: me.note || "", until: me.until || today };
    const opts = [["", "자동"]].concat(STATES);
    const ctx = K.modal({
      title: "내 상태 바꾸기",
      focus: 'input[name="state"]:checked',
      html:
        '<form class="modal__body" novalidate>' +
        '<fieldset class="tm-states"><legend class="field__label">지금 상태</legend>' +
        opts.map(([k, l]) => '<label class="tm-state tm-state--' + (k || "auto") + '"><input type="radio" name="state" value="' + k + '"' + (cur.state === k ? " checked" : "") + "><span>" + esc(l) + "</span></label>").join("") +
        '</fieldset><p class="hint">자동은 접속해 있으면 \'접속 중\', 워크로드에 진행 중 카드가 있으면 \'업무 중\'으로 보여 줍니다. 회의 중은 회의실, 자리 비움은 라운지에 앉습니다.</p>' +
        '<label class="field"><span class="field__label">지금 하는 일 (선택, 80자)</span><input class="input" name="note" maxlength="80" placeholder="예: 삼성전자 탐방 노트 정리 중" value="' + esc(cur.note) + '"></label>' +
        '<label class="field"><span class="field__label">언제까지</span><input class="input" type="date" name="until" min="' + today + '" max="' + K.addDays(today, 60) + '" value="' + esc(cur.until < today ? today : cur.until) + '"></label>' +
        '<p class="hint">이 날이 지나면 상태와 메모가 저절로 사라집니다. 휴가처럼 며칠 이어지면 마지막 날을 고르세요.</p>' +
        '<div class="modal__footer"><button type="button" class="btn btn--danger" data-clear>상태 지우기</button><div class="modal__footer-right">' +
        '<button type="button" class="btn btn--ghost" data-cancel>취소</button><button type="submit" class="btn btn--primary">저장</button></div></div></form>',
    });
    const form = $("form", ctx.modal);
    $("[data-cancel]", ctx.modal).addEventListener("click", () => ctx.close());
    $("[data-clear]", ctx.modal).addEventListener("click", async () => {
      if (await saveStatus({ state: "", note: "", until: today })) ctx.close(true);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements;
      const data = { state: f.state.value, note: f.note.value.trim(), until: f.until.value || today };
      if (data.until < today) return toast("'언제까지'는 오늘이나 그 뒤로 골라 주세요.", true);
      if (await saveStatus(data)) ctx.close(true);
    });
  }

  async function saveStatus(data) {
    try {
      if (S.server) await S.api("PUT", "/api/team/me", data);
      else K.prefs.set("team.me", data.state || data.note ? data : null);
      toast(data.state || data.note ? "상태를 바꿨습니다." : "상태를 지웠습니다.");
      await refresh();
      return true;
    } catch (err) {
      toast(err.message, true);
      return false;
    }
  }

  /* ---------- 불러오기 ---------- */
  function tallyWork(cards) {
    work = new Map();
    const today = K.today();
    (cards || []).forEach((c) => {
      if (!c.owner || c.status === "done") return;
      if (!work.has(c.owner)) work.set(c.owner, { doing: [], todo: 0, late: 0 });
      const w = work.get(c.owner);
      if (c.status === "doing") w.doing.push(c);
      else if ((c.status || "todo") === "todo") w.todo++;
      if (c.due && c.due < today) w.late++;
    });
    work.forEach((w) => w.doing.sort((a, b) => (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1) || String(a.due || "9999").localeCompare(String(b.due || "9999"))));
  }

  function localMembers() {
    const me = K.currentUser();
    const mine = K.prefs.get("team.me", null);
    const valid = mine && mine.until >= K.today();
    const names = Array.from(new Set([me].concat(Array.from(work.keys()))));
    return names.map((name) => ({
      key: "n:" + name, displayName: name, department: "", me: name === me, local: true, online: name === me,
      state: name === me && valid ? mine.state || "" : "", stateLabel: name === me && valid ? STATE_LABEL[mine.state] || "" : "",
      note: name === me && valid ? mine.note || "" : "", until: name === me && valid ? mine.until : "",
    }));
  }

  async function refresh() {
    try {
      if (S.server) {
        const [team, cards] = await Promise.all([S.api("GET", "/api/team"), canWork ? workStore.list().catch(() => null) : Promise.resolve(null)]);
        if (cards) tallyWork(cards);
        onlineMinutes = team.onlineMinutes || 5;
        skew = Date.parse(team.now) - Date.now() || 0;
        members = team.members.map((m) => Object.assign({ key: "u" + m.id }, m));
      } else {
        tallyWork(await workStore.list().catch(() => []));
        members = localMembers();
      }
      lastLoad = Date.now();
    } catch (err) {
      toast(err.message, true);
    }
    renderDepts();
    render();
  }

  /* ---------- 이벤트 ---------- */
  const byKey = (key) => members.find((m) => m.key === key);
  $("#tm-scene").addEventListener("click", (e) => {
    const bot = e.target.closest(".tm-bot");
    if (bot) return openBot(+bot.getAttribute("data-bot"));
    const p = e.target.closest(".tm-person");
    const m = p && byKey(p.getAttribute("data-id"));
    if (m) openMember(m);
  });
  const dock = $("#tm-dock");
  dock.addEventListener("click", (e) => {
    const card = e.target.closest(".tm-card");
    const m = card && byKey(card.getAttribute("data-id"));
    if (!m) return;
    if (m.me && !m.note && !m.state) openStatus();
    else openMember(m);
  });
  // 카드에 마우스를 올리거나 키보드로 고르면 사무실의 그 사람 자리를 비춘다
  function pick(card, on) {
    if (!card) return;
    const key = card.getAttribute("data-id");
    $$(".tm-person").forEach((g) => g.classList.toggle("is-picked", on && g.getAttribute("data-id") === key));
  }
  dock.addEventListener("mouseover", (e) => pick(e.target.closest(".tm-card"), true));
  dock.addEventListener("mouseout", (e) => pick(e.target.closest(".tm-card"), false));
  dock.addEventListener("focusin", (e) => pick(e.target.closest(".tm-card"), true));
  dock.addEventListener("focusout", (e) => pick(e.target.closest(".tm-card"), false));
  $("#tm-set").addEventListener("click", openStatus);
  $("#tm-dept").addEventListener("change", () => {
    K.prefs.set("team.dept", $("#tm-dept").value);
    render();
  });

  K.session().then(async (s) => {
    S = s;
    if (s.server) {
      canWork = (s.me.permissions || []).includes("workload");
      integ = await s.api("GET", "/api/integrations").catch(() => ({}));
      $("#tm-legend").textContent =
        "접속 중 = 최근 5분 안에 이 사이트를 쓴 사람입니다. 내가 정한 상태는 '언제까지' 날이 지나면 저절로 사라집니다. " +
        (canWork ? "진행 중 업무는 워크로드 카드에서 가져옵니다. " : "") + "AI 룸은 서버에 연결된 AI·자동 수집 기능입니다.";
      setInterval(() => {
        if (document.visibilityState === "visible") refresh();
      }, 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastLoad > 30 * 1000) refresh();
      });
    } else {
      canWork = true;
      const note = $("#tm-notice");
      note.hidden = false;
      note.textContent = "브라우저 저장 모드입니다. 팀원 접속 현황은 서버(DB)를 연결하면 보이고, 지금은 나와 이 브라우저 워크로드의 담당자만 보여 줍니다.";
      $("#tm-legend").textContent = "내가 정한 상태는 이 브라우저에만 저장됩니다.";
    }
    await refresh();
  });
})();
