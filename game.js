'use strict';
/**
 * 끝말잇기 — 판 진행과 방 관리.
 *  - 낱말 판정 · 타이머 · 점수 · 봇은 전부 서버가 쥔다(권위 서버).
 *  - 통신 방식은 모른다. 소켓은 send(문자열) · close() · readyState 만 있으면 된다.
 *    Node 서버(server.js)와 Cloudflare(worker.js)가 이 파일을 똑같이 쓴다.
 *  - 사전은 밖에서 loadDict(글) 로 넣어 준다. 한 줄에 한 낱말, 앞에 붙은 표시:
 *    '*' 흔한 낱말 · '~' 외래어가 든 말 · '!' 표준어 명사가 아닌 말(방언 · 옛말 · 북한어 · 띄어 쓰는 구) · '+' 어인정.
 */

/* ─────────────────────────── 한글 ─────────────────────────── */

const isSyl = c => c >= '가' && c <= '힣';

// 두음 법칙 — 앞 낱말이 '력'으로 끝나면 '역'으로 시작해도 된다. (끄투와 같은 범위)
const R2N = new Set([0, 1, 8, 11, 13, 18]);   // ㄹ → ㄴ : ㅏ ㅐ ㅗ ㅚ ㅜ ㅡ   (라 → 나)
const R2I = new Set([2, 6, 7, 12, 17, 20]);   // ㄹ → ㅇ : ㅑ ㅕ ㅖ ㅛ ㅠ ㅣ   (력 → 역)
const N2I = new Set([6, 12, 17, 20]);         // ㄴ → ㅇ : ㅕ ㅛ ㅠ ㅣ         (녀 → 여)

function dueum(c) {
  if (!isSyl(c)) return c;
  const n = c.charCodeAt(0) - 0xAC00;
  const cho = (n / 588) | 0, jung = ((n % 588) / 28) | 0, jong = n % 28;
  let to = -1;
  if (cho === 5) to = R2N.has(jung) ? 2 : R2I.has(jung) ? 11 : -1;
  else if (cho === 2 && N2I.has(jung)) to = 11;
  return to < 0 ? c : String.fromCharCode(0xAC00 + to * 588 + jung * 28 + jong);
}
/** 앞 낱말의 끝 글자로 시작할 수 있는 글자들 */
const startsFrom = c => { const d = dueum(c); return d === c ? [c] : [c, d]; };

/* ─────────────────────────── 사전 ─────────────────────────── */

let WORDS = null;          // Set — 판정용 전체 낱말
let COMMON = null;         // Set — 흔한 낱말(봇이 먼저 고른다)
let FOREIGN = null;        // Set — 외래어이거나 외래어가 섞인 말 (버스 · 버스표). '외래어 금지' 방에서 막는다
let NONSTD = null;         // Set — 방언 · 옛말 · 북한어 · 띄어 쓰는 구(치과기공사). '표준어만' 방에서 막는다
let INJEONG = null;        // Set — 어인정 낱말(사전에 없는 말을 주제별로 모은 것). '사전 외 낱말'을 켠 방에서만 받는다
const POOLS = new Map();   // '모드:all|common:규칙' → Map(첫 글자 → [낱말]) — 최근 쓴 순서
const POOL_KEEP = 6;

function loadDict(text) {
  if (WORDS) return;
  WORDS = new Set(); COMMON = new Set(); FOREIGN = new Set(); NONSTD = new Set(); INJEONG = new Set();
  const marks = { '*': COMMON, '~': FOREIGN, '!': NONSTD, '+': INJEONG };
  for (let line of String(text).split('\n')) {
    line = line.trim();
    let i = 0;
    while (marks[line[i]]) i++;
    const w = line.slice(i);
    if (!w) continue;
    WORDS.add(w);
    for (let j = 0; j < i; j++) marks[line[j]].add(w);
  }
}

/* ─────────────────────────── 모드 ─────────────────────────── */
/* 모드는 여기 한 곳에서만 갈린다. 글자 수 조건과 차례 시간이 이 표에 있다.
   turn: [첫 차례 시간, 가장 짧은 시간, 한 번 이어질 때마다 줄어드는 시간] (ms) */
const MODES = {
  classic: { ko: '끝말잇기', fits: w => w.length >= 2, turn: [10000, 3500, 300] },
  kkt:     { ko: '쿵쿵따',   fits: w => w.length === 3, turn: [7000, 2500, 200] },
};
const MODE_KEYS = Object.keys(MODES);
const modeOf = room => MODES[room.cfg.mode] || MODES.classic;
const timed = room => room.cfg.roundTime > 0;

/** 모드와 규칙에 맞는 낱말을 첫 글자별로 묶은 것. 처음 쓸 때 만든다.
 *  rules: { noForeign, strict(표준어만), injeong(사전 외 낱말) } */
function pool(modeKey, common, rules = {}) {
  if (typeof rules === 'boolean') rules = { noForeign: rules };
  const { noForeign = false, strict = false, injeong = false } = rules;
  const key = modeKey + (common ? ':common' : ':all') + (noForeign ? ':nf' : '') + (strict ? ':st' : '') + (injeong ? ':ij' : '');
  let m = POOLS.get(key);
  // 묶음 하나가 수 MB 라 최근 쓴 것 몇 개만 들고 있는다(Durable Object 메모리 128MB). 다시 만드는 데는 0.1초 안쪽.
  if (m) { POOLS.delete(key); POOLS.set(key, m); return m; }
  while (POOLS.size >= POOL_KEEP) POOLS.delete(POOLS.keys().next().value);
  m = new Map();
  const fits = (MODES[modeKey] || MODES.classic).fits;
  for (const w of common ? COMMON : WORDS) {
    if (!fits(w) || (noForeign && FOREIGN.has(w)) || (strict && NONSTD.has(w)) || (!injeong && INJEONG.has(w))) continue;
    let a = m.get(w[0]);
    if (!a) m.set(w[0], a = []);
    a.push(w);
  }
  POOLS.set(key, m);
  return m;
}
/** 이 방 규칙(모드 · 외래어 금지)에 맞는 묶음 */
const poolFor = (room, common) => pool(room.cfg.mode, common,
  { noForeign: room.cfg.noForeign, strict: room.cfg.strict, injeong: room.cfg.injeong });

/** 이 글자들로 시작하는, 아직 안 쓴 낱말 */
function candidates(p, starts, used, limit = Infinity) {
  const out = [];
  for (const c of starts) {
    for (const w of p.get(c) || []) {
      if (!used.has(w)) { out.push(w); if (out.length >= limit) return out; }
    }
  }
  return out;
}

/** 이 낱말 다음에 이을 말이 사전에 하나라도 남아 있나 — 없으면 '한방 단어' */
function hasNext(room, word, used) {
  const p = poolFor(room, false);
  for (const c of startsFrom(word[word.length - 1])) {
    for (const w of p.get(c) || []) if (w !== word && !used.has(w)) return true;
  }
  return false;
}

/** 그 글자로 이을 수 있는 낱말 수 (봇이 상대를 몰아붙일 때 쓴다) */
const contCache = new Map();
function contCount(room, c) {
  const key = [room.cfg.mode, room.cfg.noForeign, room.cfg.strict, room.cfg.injeong, c].join(':');
  let n = contCache.get(key);
  if (n == null) {
    const p = poolFor(room, false);
    n = startsFrom(c).reduce((s, x) => s + (p.get(x) || []).length, 0);
    contCache.set(key, n);
  }
  return n;
}

/* ─────────────────────────── 상수 ─────────────────────────── */

const MAX_PLAYERS = 8;
const FAIL_PENALTY = 50;
const GAP_MS = 450;            // 낱말이 받아들여지고 다음 차례가 열리기까지 (시계는 멈춘다)
const FAIL_PAUSE = 2600;       // 시간 초과 뒤 다음 라운드까지
const INTRO_MS = 1800;         // 라운드 시작 알림
const GAME_INTRO_MS = 3600;    // 판 첫 라운드 — 화면이 제시어를 가운데 크게 띄웠다가 제자리로 넣는 동안
const DOOMED_MS = 5000;        // 이을 말이 사전에 없는 차례는 이만큼만 기다린다
const DC_MS = 8000;            // 시간제한 없는 방에서 연결이 끊긴 사람 차례는 이만큼 뒤에 넘긴다
const LOBBY_GRACE = 20_000;    // 대기실에서 끊긴 자리를 비우기까지 (새로고침은 이 안에 돌아온다)

const CFG_CHOICES = {
  rounds: [3, 4, 5, 6],
  roundTime: [0, 60, 90, 120, 150],   // 0 = 시간제한 없음 (라운드 · 차례 시계 모두 끔)
  botDiff: ['easy', 'normal', 'hard'],
};

const BOT = {
  easy:   { think: [2200, 4200], perChar: 180, miss: 0.12, full: 0.15 },
  normal: { think: [1300, 2600], perChar: 110, miss: 0.02, full: 0.6 },
  hard:   { think: [ 600, 1400], perChar:  60, miss: 0.01, full: 1 },
};
const BOT_NAMES = ['말똥이', '글벗', '낱말이', '또박이', '사전이', '한방이', '끝순이'];

// 미션 글자 — 흔한 낱말에 자주 나오는 글자에서 고른다
const MISSION_CHARS = '가고기구다대도동리마무부사상성수시신아어오우원이인자장전정조주지진하한해화'.split('');

/* ─────────────────────────── 유틸 ─────────────────────────── */

const rnd = (min, max) => min + Math.random() * (max - min);
const pick = a => a[Math.floor(Math.random() * a.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const token = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)),
  b => b.toString(16).padStart(2, '0')).join('');
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

/** 점수 — 긴 낱말일수록 크게, 이어진 횟수 · 빠르기 · 미션 글자에 덤. 시간제한이 없으면(limit 0) 빠르기는 1. */
function scoreOf(word, chain, left, limit, missionHits) {
  const n = word.length;
  const base = 4 + 4 * n + n * n;                        // 2글자 16 · 3글자 25 · 5글자 49 · 8글자 100
  const combo = 1 + Math.min(chain, 25) * 0.04;
  const speed = limit > 0 ? 0.7 + 0.6 * clamp(left / limit, 0, 1) : 1;
  return Math.round(base * combo * speed * (1 + 0.5 * missionHits));
}

/* ─────────────────────────── 방 ─────────────────────────── */

const rooms = new Map();
const watchers = new Set();    // 방 목록을 보고 있는 소켓

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자 제외
  let code;
  do code = Array.from({ length: 4 }, () => pick(alphabet)).join('');
  while (rooms.has(code));
  return code;
}

function createRoom({ title, priv, mode }) {
  const room = {
    code: makeCode(),
    title: title || '끝말잇기 한 판',
    priv: !!priv,
    phase: 'lobby',               // lobby | playing
    hostId: null,
    players: [],
    nextId: 1,
    cfg: { mode: MODE_KEYS.includes(mode) ? mode : 'classic', rounds: 5, roundTime: 60,
           mission: false, manner: false, noForeign: false, strict: false, injeong: false, botDiff: 'normal' },
    g: null,
    timers: { turn: null, step: null, bot: null },
    lastActive: Date.now(),
    last: null,                   // 지난 판 결과 (대기실에서 다시 볼 수 있게)
  };
  rooms.set(room.code, room);
  listChanged();
  return room;
}

function addPlayer(room, { name, bot }) {
  const p = {
    id: room.nextId++,
    token: token(),
    name: name || `손님 ${room.nextId - 1}`,
    bot: !!bot,
    ws: null,
    connected: !!bot,
    inGame: false,
    score: 0, words: 0, best: null, longest: '',
  };
  room.players.push(p);
  if (!p.bot && room.hostId == null) room.hostId = p.id;
  listChanged();
  return p;
}

function removePlayer(room, id) {
  const i = room.players.findIndex(p => p.id === id);
  if (i < 0) return;
  const [gone] = room.players.splice(i, 1);
  clearTimeout(gone.leaveT);
  if (room.hostId === gone.id) {
    const next = room.players.find(p => !p.bot && p.connected) || room.players.find(p => !p.bot);
    room.hostId = next ? next.id : null;
  }
  if (!room.players.some(p => !p.bot)) { closeRoom(room); return; }
  listChanged();
  if (room.phase === 'playing' && room.g) leftMidGame(room, gone.id);
}

function closeRoom(room) {
  clearAll(room);
  rooms.delete(room.code);
  listChanged();
}

function clearAll(room) {
  for (const k of Object.keys(room.timers)) { clearTimeout(room.timers[k]); room.timers[k] = null; }
}

/* ─────────────────────────── 보내기 ─────────────────────────── */

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) { /* 막 닫힌 소켓 */ }
  }
}

function stateOf(room) {
  const g = room.g;
  return {
    t: 'state',
    code: room.code,
    title: room.title,
    priv: room.priv,
    phase: room.phase,
    hostId: room.hostId,
    cfg: room.cfg,
    now: Date.now(),
    players: room.players.map(p => ({
      id: p.id, name: p.name, bot: p.bot, connected: p.connected, inGame: p.inGame,
      score: p.score, words: p.words,
    })),
    g: g && {
      round: g.round, rounds: g.rounds, roundWord: g.roundWord,
      chain: g.chain, starts: g.starts, lastWord: g.lastWord, lastBy: g.lastBy,
      mission: g.mission, stage: g.stage,
      turnId: g.turnId, turnStart: g.turnStart, turnLimit: g.turnLimit, roundLeft: g.roundLeft,
      history: g.history.slice(-24),
    },
    last: room.last,
  };
}

function broadcast(room, obj) {
  const text = JSON.stringify(obj);
  for (const p of room.players) {
    if (!p.bot && p.ws && p.ws.readyState === 1) { try { p.ws.send(text); } catch (_) {} }
  }
}
const pushState = room => broadcast(room, stateOf(room));
const ev = (room, obj) => broadcast(room, Object.assign({ t: 'ev' }, obj));

/* 방 목록 — 대기실 화면을 보는 사람에게만, 여러 번 바뀌어도 한 번에 모아 보낸다 */
let listT = null;
function listChanged() {
  if (listT || !watchers.size) return;
  listT = setTimeout(() => { listT = null; pushList(); }, 300);
}
function roomList() {
  const list = [];
  for (const r of rooms.values()) {
    if (r.priv) continue;
    list.push({
      code: r.code, title: r.title, mode: r.cfg.mode, phase: r.phase,
      n: r.players.length, max: MAX_PLAYERS, host: (r.players.find(p => p.id === r.hostId) || {}).name || '',
    });
  }
  list.sort((a, b) => (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1) || b.n - a.n);
  let online = watchers.size;
  for (const r of rooms.values()) online += r.players.filter(p => !p.bot && p.connected).length;
  return { t: 'rooms', list, online };
}
function pushList() {
  if (!watchers.size) return;
  const text = JSON.stringify(roomList());
  for (const ws of watchers) {
    if (ws.readyState !== 1) { watchers.delete(ws); continue; }
    try { ws.send(text); } catch (_) { watchers.delete(ws); }
  }
}

/* ─────────────────────────── 판 ─────────────────────────── */

/** 라운드마다 시작 글자를 주는 제시어. 라운드 수만큼의 글자, 글자마다 이을 말이 넉넉해야 한다. */
function pickRoundWord(room) {
  const n = room.cfg.rounds, mk = room.cfg.mode;
  const common = poolFor(room, true);
  const good = c => (common.get(c) || []).length >= (mk === 'kkt' ? 6 : 25);
  const src = [...COMMON].filter(w => w.length === n);
  for (let i = 0; i < 600 && src.length; i++) {
    const w = pick(src);
    if ([...w].every(good)) return w;
  }
  // 알맞은 낱말이 없으면 흔한 글자를 이어 붙인다
  const chars = MISSION_CHARS.filter(good);
  return Array.from({ length: n }, () => pick(chars.length ? chars : MISSION_CHARS)).join('');
}

function newMission(room) {
  const g = room.g;
  const chars = MISSION_CHARS.filter(c => c !== g.mission);
  g.mission = room.cfg.mission ? pick(chars) : null;
}

function startGame(room) {
  clearAll(room);
  const order = room.players.filter(p => p.bot || p.connected);
  for (const p of room.players) {
    p.inGame = order.includes(p);
    p.score = 0; p.words = 0; p.best = null; p.longest = ''; p.missed = false;
  }
  room.phase = 'playing';
  room.last = null;
  room.g = {
    order: order.map(p => p.id),
    round: 0, rounds: room.cfg.rounds,
    roundWord: pickRoundWord(room),
    chain: 0, starts: [], lastWord: null, lastBy: null,
    used: new Set(), history: [],
    mission: null, stage: 'intro',
    turnId: null, turnStart: 0, turnLimit: 0, roundLeft: 0,
    pending: null,
  };
  newMission(room);
  listChanged();
  beginRound(room, pick(order).id);
}

function beginRound(room, firstId) {
  const g = room.g;
  g.round++;
  g.chain = 0;
  g.lastWord = null; g.lastBy = null;
  g.starts = startsFrom(g.roundWord[g.round - 1]);
  g.roundLeft = room.cfg.roundTime * 1000;       // 시간제한 없음이면 0 — 쓰지 않는다
  g.stage = 'intro';
  g.turnId = firstId;
  g.turnStart = 0; g.turnLimit = 0;
  ev(room, { kind: 'round', round: g.round, ch: g.roundWord[g.round - 1], by: firstId });
  pushState(room);
  room.timers.step = setTimeout(() => beginTurn(room, firstId), g.round === 1 ? GAME_INTRO_MS : INTRO_MS);
}

/** 이번 차례 시간 (ms). 0 이면 제한 없음. */
function turnLimitOf(room) {
  const g = room.g;
  if (!timed(room)) return 0;
  const [start, min, step] = modeOf(room).turn;
  return Math.min(g.roundLeft, Math.max(min, start - g.chain * step));
}

function beginTurn(room, id) {
  const g = room.g;
  if (!g || room.phase !== 'playing') return;
  clearTimeout(room.timers.turn); clearTimeout(room.timers.bot);
  g.stage = 'turn';
  g.turnId = id;
  g.turnStart = Date.now();
  g.turnLimit = turnLimitOf(room);
  const p = room.players.find(x => x.id === id);
  // 이을 말이 사전에 없으면(한방 단어를 받았으면) 오래 붙잡아 두지 않는다
  if (g.lastWord && !hasNext(room, g.lastWord, g.used)) g.turnLimit = Math.min(g.turnLimit || DOOMED_MS, DOOMED_MS);
  // 시간제한 없는 방이라도 연결이 끊긴 사람 차례에서 판이 멈추지 않게
  else if (!g.turnLimit && p && !p.bot && !p.connected) g.turnLimit = DC_MS;
  if (g.turnLimit) room.timers.turn = setTimeout(() => fail(room, id), g.turnLimit);
  pushState(room);

  if (p && p.bot) scheduleBot(room, p);

  // 앞 차례가 끝나기 직전에 쳐 둔 낱말
  const pend = g.pending; g.pending = null;
  if (pend && pend.id === id) tryWord(room, p, pend.w);
}

function nextId(room, id) {
  const order = room.g.order;
  const i = order.indexOf(id);
  return order[(i + 1) % order.length];
}

function check(room, word) {
  const g = room.g;
  if (!/^[가-힣]+$/.test(word)) return 'hangul';
  if (word.length < 2) return 'short';
  if (!modeOf(room).fits(word)) return 'len';
  if (!g.starts.includes(word[0])) return 'start';
  if (!WORDS.has(word)) return 'nodict';
  if (INJEONG.has(word) && !room.cfg.injeong) return 'injeong';
  if (g.used.has(word)) return 'used';
  if (room.cfg.noForeign && FOREIGN.has(word)) return 'foreign';
  if (room.cfg.strict && NONSTD.has(word)) return 'strict';
  // 라운드 첫 낱말은 언제나 한방 금지(끄투와 같다). 그 뒤로는 '한방 금지' 방에서만.
  if ((g.chain === 0 || room.cfg.manner) && !hasNext(room, word, new Set(g.used).add(word))) {
    return g.chain === 0 && !room.cfg.manner ? 'firstkill' : 'hanbang';
  }
  return null;
}

function tryWord(room, p, word) {
  const g = room.g;
  if (!p || !g || g.stage !== 'turn' || g.turnId !== p.id) return;
  const why = check(room, word);
  if (why) { ev(room, { kind: 'bad', by: p.id, word, why }); return; }

  clearTimeout(room.timers.turn); clearTimeout(room.timers.bot);
  const now = Date.now();
  const used = now - g.turnStart;
  const left = Math.max(0, g.turnLimit - used);
  if (timed(room)) g.roundLeft = Math.max(0, g.roundLeft - used);

  const hits = g.mission ? [...word].filter(c => c === g.mission).length : 0;
  const pts = scoreOf(word, g.chain, left, g.turnLimit, hits);
  g.used.add(word);
  g.chain++;
  g.lastWord = word; g.lastBy = p.id;
  g.starts = startsFrom(word[word.length - 1]);
  g.history.push({ w: word, by: p.id, pts });
  if (g.history.length > 60) g.history.splice(0, g.history.length - 60);
  p.score += pts; p.words++;
  if (!p.best || pts > p.best.pts) p.best = { w: word, pts };
  if (word.length > p.longest.length) p.longest = word;

  const killer = !hasNext(room, word, g.used);
  ev(room, { kind: 'ok', by: p.id, word, pts, chain: g.chain, mission: hits > 0 ? g.mission : null, killer });
  if (hits) newMission(room);

  g.stage = 'gap';
  g.turnId = nextId(room, p.id);
  g.turnStart = 0;
  pushState(room);
  room.timers.step = setTimeout(() => beginTurn(room, g.turnId), GAP_MS);
}

/** 차례를 못 넘겼다 — 시간 초과, 포기(why 'giveup'), 연결 끊김 */
function fail(room, id, why) {
  const g = room.g;
  if (!g || g.stage !== 'turn' || g.turnId !== id) return;
  clearTimeout(room.timers.turn); clearTimeout(room.timers.bot);
  const used = Date.now() - g.turnStart;
  if (timed(room)) g.roundLeft = Math.max(0, g.roundLeft - used);
  const p0 = room.players.find(x => x.id === id);
  if (!why) why = timed(room) ? (g.roundLeft <= 0 ? 'round' : 'time') : p0 && !p0.bot && !p0.connected ? 'dc' : 'time';
  const p = room.players.find(x => x.id === id);
  if (p) p.score -= FAIL_PENALTY;
  g.stage = 'fail';
  const hint = candidates(poolFor(room, true), g.starts, g.used, 40);
  ev(room, {
    kind: 'fail', by: id, penalty: FAIL_PENALTY, why,
    // 이런 말이 있었다 — 흔한 낱말에서 하나, 없으면 전체에서
    hint: hint.length ? pick(hint) : (candidates(poolFor(room, false), g.starts, g.used, 1)[0] || null),
  });
  pushState(room);
  room.timers.step = setTimeout(() => {
    if (g.round >= g.rounds) endGame(room);
    else beginRound(room, g.order.includes(id) ? id : g.order[0]);
  }, FAIL_PAUSE);
}

/** 판 도중에 누가 나갔다 — 차례에서 빼고, 그 사람 차례였으면 다음 사람에게 넘긴다(감점 없음) */
function leftMidGame(room, id) {
  const g = room.g;
  const i = g.order.indexOf(id);
  if (i < 0) return;
  const next = g.order.length > 1 ? g.order[(i + 1) % g.order.length] : null;
  g.order.splice(i, 1);
  if (g.order.length < 2) { endGame(room); return; }
  if (g.turnId !== id) { pushState(room); return; }
  if (g.stage === 'turn') {
    if (timed(room)) {
      g.roundLeft = Math.max(0, g.roundLeft - (Date.now() - g.turnStart));
      if (g.roundLeft <= 0) { g.turnId = next; g.turnStart = Date.now(); fail(room, next); return; }
    }
    beginTurn(room, next);
  } else {
    g.turnId = next;              // 라운드 시작 알림 · 낱말 사이 — 예약된 차례가 이 사람을 가리키게
    clearTimeout(room.timers.step);
    room.timers.step = setTimeout(() => beginTurn(room, next), GAP_MS);
    pushState(room);
  }
}

function endGame(room) {
  clearAll(room);
  const g = room.g;
  const ranking = room.players.filter(p => p.inGame || (g && g.order.includes(p.id)))
    .sort((a, b) => b.score - a.score)
    .map(p => ({ id: p.id, name: p.name, bot: p.bot, score: p.score, words: p.words, best: p.best, longest: p.longest }));
  room.last = { ranking, roundWord: g ? g.roundWord : '', total: g ? g.used.size : 0 };
  room.phase = 'lobby';
  room.g = null;
  for (const p of room.players) p.inGame = false;
  ev(room, { kind: 'end', ranking });
  pushState(room);
  listChanged();
}

/* ─────────────────────────── 봇 ─────────────────────────── */

function botPick(room) {
  const g = room.g;
  const B = BOT[room.cfg.botDiff] || BOT.normal;
  let cands = [];
  if (B.full < 1) cands = candidates(poolFor(room, true), g.starts, g.used);
  if (!cands.length && Math.random() < B.full) cands = candidates(poolFor(room, false), g.starts, g.used);
  if (room.cfg.manner || g.chain === 0) cands = cands.filter(w => hasNext(room, w, new Set(g.used).add(w)));
  if (!cands.length) return null;

  if (room.cfg.botDiff === 'easy') {
    const short = cands.filter(w => w.length <= 3);
    return pick(short.length ? short : cands);
  }
  if (room.cfg.botDiff === 'hard') {
    // 길고, 다음 사람이 잇기 어려운 말을 고른다
    let best = null, bestS = -Infinity;
    for (let i = 0; i < 80; i++) {
      const w = pick(cands);
      const s = w.length * 1.2 - Math.log2(1 + contCount(room, w[w.length - 1])) * 1.5 + Math.random() * 2;
      if (s > bestS) { best = w; bestS = s; }
    }
    return best;
  }
  return pick(cands);
}

function scheduleBot(room, p) {
  const g = room.g;
  const B = BOT[room.cfg.botDiff] || BOT.normal;
  // 가끔 생각이 안 난다. 다만 라운드 첫 차례이거나 바로 앞 차례에 못 냈으면 빠지지 않는다 —
  // 진 사람이 다음 라운드를 시작하므로, 그렇지 않으면 한 번 못 낸 봇이 라운드마다 연달아 시간 초과로 보였다.
  const mayMiss = g.chain > 0 && !p.missed;
  let word = null;
  try { word = mayMiss && Math.random() < B.miss ? null : botPick(room); }
  catch (err) { console.error('봇 낱말 고르기 실패', err); }
  p.missed = !word;
  if (!word) {
    // 시간이 흐르는 방이면 다 가길 기다린다. 시간제한이 없으면 잠깐 고민하다 포기한다.
    if (!g.turnLimit) {
      room.timers.bot = setTimeout(() => { room.timers.bot = null; if (room.g === g) fail(room, p.id, 'giveup'); },
        rnd(B.think[1], B.think[1] * 2));
    }
    return;
  }
  const delay = rnd(B.think[0], B.think[1]) + word.length * B.perChar;
  if (g.turnLimit && delay >= g.turnLimit - 80) { p.missed = true; return; }   // 늦는다
  room.timers.bot = setTimeout(() => {
    room.timers.bot = null;
    if (room.g !== g || g.stage !== 'turn' || g.turnId !== p.id) return;
    // 고른 뒤 판이 바뀌어 안 되는 말이 됐으면 그 자리에서 다시 고른다 — 조용히 시간만 흘려보내지 않게
    const w = check(room, word) ? botPick(room) : word;
    if (w) tryWord(room, p, w);
  }, delay);
}

/* ─────────────────────────── 메시지 처리 ─────────────────────────── */

function attach(room, p, ws) {
  clearTimeout(p.leaveT);
  watchers.delete(ws);
  const g = room.g;
  // 시간제한 없는 방에서 끊겨 있던 사이 걸어 둔 '차례 넘기기'를 푼다 (새로고침하고 돌아왔다)
  if (!p.connected && g && g.stage === 'turn' && g.turnId === p.id && !timed(room) && g.turnLimit === DC_MS) {
    clearTimeout(room.timers.turn); room.timers.turn = null;
    g.turnLimit = 0;
  }
  p.ws = ws; p.connected = true;
  ws.roomCode = room.code; ws.playerId = p.id;
  send(ws, { t: 'welcome', you: p.id, token: p.token, code: room.code });
  pushState(room);
  listChanged();
}

function botName(room) {
  const used = new Set(room.players.map(p => p.name));
  return BOT_NAMES.find(n => !used.has(n)) || `봇 ${room.players.length + 1}`;
}

function joinRoom(ws, r, name) {
  if (r.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '방이 가득 찼어요.' });
  const p = addPlayer(r, { name: clean(name, 10) || `손님 ${r.players.length + 1}` });
  attach(r, p, ws);
  ev(r, { kind: 'joined', by: p.id, name: p.name, watching: r.phase === 'playing' });
}

function handle(ws, msg) {
  switch (msg.t) {
    case 'rooms':
      if (!ws.roomCode) { watchers.add(ws); send(ws, roomList()); }
      return;

    case 'create': {
      if (ws.roomCode) leaveRoom(ws);
      const name = clean(msg.name, 10) || '손님 1';
      const r = createRoom({ title: clean(msg.title, 20) || `${name}의 방`, priv: msg.priv, mode: msg.mode });
      const p = addPlayer(r, { name });
      const bots = clamp(Number(msg.bots) | 0, 0, 3);
      for (let i = 0; i < bots; i++) addPlayer(r, { name: botName(r), bot: true });
      attach(r, p, ws);
      return;
    }

    case 'join': {
      if (ws.roomCode) leaveRoom(ws);
      const r = rooms.get(clean(msg.code, 8).toUpperCase());
      if (!r) return send(ws, { t: 'err', msg: '그런 방이 없어요. 코드를 확인해 주세요.' });
      joinRoom(ws, r, msg.name);
      return;
    }

    // 빠른 입장 — 사람이 기다리는 공개 방 가운데 가장 붐비는 곳, 없으면 새로 만든다
    case 'quick': {
      if (ws.roomCode) leaveRoom(ws);
      const open = [...rooms.values()]
        .filter(r => !r.priv && r.phase === 'lobby' && r.players.length < MAX_PLAYERS && r.players.some(p => !p.bot && p.connected))
        .sort((a, b) => b.players.length - a.players.length)[0];
      if (open) return joinRoom(ws, open, msg.name);
      return handle(ws, { t: 'create', name: msg.name, mode: msg.mode });
    }

    case 'resume': {
      const r = rooms.get(clean(msg.code, 8).toUpperCase());
      if (!r) return send(ws, { t: 'err', msg: '방이 사라졌어요.', fatal: true });
      const p = r.players.find(x => x.token === msg.token);
      if (!p) return send(ws, { t: 'err', msg: '자리를 찾을 수 없어요.', fatal: true });
      // 먼저 붙어 있던 소켓(복제한 탭 등)은 4001 로 닫는다. 그 탭은 스스로 다시 붙지 않는다.
      // 닫는 코드는 중간 프록시가 떨궈 버리기도 해서 알림을 먼저 보낸다.
      if (p.ws && p.ws !== ws) { send(p.ws, { t: 'moved' }); try { p.ws.close(4001, 'moved'); } catch (_) {} }
      attach(r, p, ws);
      return;
    }
  }

  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const me = room.players.find(p => p.id === ws.playerId);
  if (!me) return;
  const isHost = room.hostId === me.id;
  const lobby = room.phase === 'lobby';
  room.lastActive = Date.now();

  switch (msg.t) {
    case 'name':
      me.name = clean(msg.name, 10) || me.name;
      pushState(room); listChanged();
      break;

    case 'addBot':
      if (!isHost || !lobby) return;
      if (room.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '자리가 없어요.' });
      addPlayer(room, { name: botName(room), bot: true });
      pushState(room);
      break;

    // 방장 넘기기 — 사람에게만. 판 중에도 된다(판 접기 · 한 판 더를 누를 사람이 바뀐다).
    case 'host': {
      if (!isHost) return;
      const target = room.players.find(p => p.id === msg.id && p.id !== me.id && !p.bot);
      if (!target) return;
      if (!target.connected) return send(ws, { t: 'err', msg: '연결이 끊긴 사람에게는 넘길 수 없어요.' });
      room.hostId = target.id;
      ev(room, { kind: 'host', by: me.id, to: target.id, from: me.name, name: target.name });
      pushState(room); listChanged();
      break;
    }

    case 'kick': {
      if (!isHost || !lobby) return;
      const target = room.players.find(p => p.id === msg.id && p.id !== me.id);
      if (!target) return;
      if (target.ws) {
        send(target.ws, { t: 'err', msg: '방장이 내보냈어요.', fatal: true });
        target.ws.roomCode = null;
      }
      removePlayer(room, target.id);
      if (rooms.has(room.code)) pushState(room);
      break;
    }

    case 'cfg': {
      if (!isHost || !lobby) return;
      const c = room.cfg;
      if (MODE_KEYS.includes(msg.mode)) c.mode = msg.mode;
      for (const k of Object.keys(CFG_CHOICES)) if (CFG_CHOICES[k].includes(msg[k])) c[k] = msg[k];
      if (typeof msg.mission === 'boolean') c.mission = msg.mission;
      if (typeof msg.manner === 'boolean') c.manner = msg.manner;
      if (typeof msg.noForeign === 'boolean') c.noForeign = msg.noForeign;
      if (typeof msg.strict === 'boolean') c.strict = msg.strict;
      if (typeof msg.injeong === 'boolean') c.injeong = msg.injeong;
      if (typeof msg.priv === 'boolean') room.priv = msg.priv;
      if (typeof msg.title === 'string' && clean(msg.title, 20)) room.title = clean(msg.title, 20);
      pushState(room); listChanged();
      break;
    }

    case 'start':
      if (!isHost || !lobby) return;
      if (room.players.filter(p => p.bot || p.connected).length < 2) {
        return send(ws, { t: 'err', msg: '둘 이상이어야 시작할 수 있어요. 봇을 불러 보세요.' });
      }
      startGame(room);
      break;

    // 입력칸 하나로 친다. 내 차례에 한글만 친 것은 낱말, 나머지는 채팅.
    case 'say': {
      const text = clean(msg.text, 200);
      if (!text) return;
      const now = Date.now();
      const g = room.g;
      const w = text.replace(/\s+/g, '');
      if (g && me.inGame && /^[가-힣]{1,40}$/.test(w)) {
        if (g.stage === 'turn' && g.turnId === me.id) {
          if (now - (me.lastTry || 0) < 120) return;
          me.lastTry = now;
          return tryWord(room, me, w);
        }
        // 앞 사람 낱말이 막 받아들여져 내 차례가 열리기 직전 — 채팅으로 새지 않게 잡아 두었다가 낸다
        if (g.stage === 'gap' && g.turnId === me.id) { g.pending = { id: me.id, w }; return; }
      }
      if (now - (me.lastChat || 0) < 400) return;      // 도배 막기
      me.lastChat = now;
      broadcast(room, { t: 'chat', from: me.id, name: me.name, text });
      break;
    }

    case 'giveup':                                       // 내 차례를 포기한다 — 시간이 다 간 것과 같다
      if (room.g && room.g.stage === 'turn' && room.g.turnId === me.id) fail(room, me.id, 'giveup');
      break;

    case 'stop':                                         // 방장이 판을 접는다
      if (!isHost || lobby) return;
      endGame(room);
      break;

    case 'leave':
      leaveRoom(ws);
      break;
  }
}

function leaveRoom(ws) {
  const room = rooms.get(ws.roomCode);
  ws.roomCode = null;
  if (!room) return;
  const me = room.players.find(p => p.id === ws.playerId);
  if (!me) return;
  removePlayer(room, me.id);
  if (rooms.has(room.code)) { ev(room, { kind: 'left', name: me.name }); pushState(room); }
}

/** 소켓이 닫혔다. 그 사이 같은 자리가 새 소켓으로 다시 붙었으면(새로고침) 건드리지 않는다.
 *  keepSeat — 서버가 스스로 끊은 경우(오래 조작 없음 · 소식 없음). 사람이 나간 게 아니라서 자리는 둔다. */
function disconnect(ws, { keepSeat = false } = {}) {
  if (watchers.delete(ws)) listChanged();
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const p = room.players.find(x => x.id === ws.playerId);
  if (!p || p.ws !== ws) return;
  p.connected = false; p.ws = null;
  room.lastActive = Date.now();              // 빈 방 청소는 마지막 사람이 떠난 때부터 센다

  if (room.hostId === p.id) {
    const next = room.players.find(x => !x.bot && x.connected);
    if (next) room.hostId = next.id;
  }
  if (room.phase === 'lobby') {
    // 새로고침·앱 전환은 소켓이 먼저 닫히고 곧바로 다시 붙는다. 잠깐 기다렸다가 그래도 없으면 뺀다.
    clearTimeout(p.leaveT);
    if (!keepSeat) {
      p.leaveT = setTimeout(() => {
        if (p.connected || rooms.get(room.code) !== room) return;
        if (room.phase === 'lobby') { removePlayer(room, p.id); if (rooms.has(room.code)) pushState(room); }
      }, LOBBY_GRACE);
    }
  }
  // 판 중에 끊긴 사람은 자리를 지킨다. 차례가 오면 시간이 흘러 넘어간다.
  // 시간제한 없는 방이면 시간이 흐르지 않으니 잠깐 뒤 넘긴다.
  const g = room.g;
  if (g && g.stage === 'turn' && g.turnId === p.id && !g.turnLimit) {
    g.turnLimit = DC_MS;
    g.turnStart = Date.now();
    room.timers.turn = setTimeout(() => fail(room, p.id, 'dc'), DC_MS);
  }
  pushState(room);
  listChanged();
}

/** 사람이 다 떠난 방을 치운다. 통신 쪽이 30초마다 부른다. */
function sweepRooms(now = Date.now()) {
  for (const room of [...rooms.values()]) {
    const humans = room.players.filter(p => !p.bot && p.connected).length;
    const seated = room.phase === 'lobby' && room.players.some(p => !p.bot);
    if (humans === 0 && now - room.lastActive > (seated ? 10 * 60_000 : 90_000)) closeRoom(room);
  }
}

/** 한글 규칙과 사전이 어긋나면 게임 중이 아니라 켤 때 바로 터지게 한다 */
function selfCheck() {
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: ${a} ≠ ${b}`); };
  const cases = { 력: '역', 라: '나', 락: '낙', 래: '내', 로: '노', 뢰: '뇌', 루: '누', 르: '느', 례: '예',
                  률: '율', 리: '이', 녀: '여', 뇨: '요', 뉴: '유', 니: '이', 러: '러', 나: '나', 가: '가' };
  for (const [a, b] of Object.entries(cases)) eq(dueum(a), b, `두음 ${a}`);
  if (!WORDS || WORDS.size < 1000) throw new Error('사전이 비었습니다 — loadDict 를 먼저 부르세요');
  for (const w of ['사과', '과자', '자동차', '역사', '이력']) if (!WORDS.has(w)) throw new Error(`사전에 '${w}' 가 없습니다`);
  for (const w of ['버스', '컴퓨터']) if (!FOREIGN.has(w)) throw new Error(`'${w}' 가 외래어로 표시되지 않았습니다`);
  for (const w of ['사과', '밥상']) if (FOREIGN.has(w)) throw new Error(`'${w}' 가 외래어로 잘못 표시됐습니다`);
  for (const k of MODE_KEYS) {
    const n = [...pool(k, false).values()].reduce((s, a) => s + a.length, 0);
    console.log(`  ${MODES[k].ko.padEnd(5)} 낱말 ${n.toLocaleString()}개`);
  }
}

module.exports = {
  rooms, handle, disconnect, sweepRooms, selfCheck, loadDict, MAX_PLAYERS,
  // 시험용
  _t: { dueum, startsFrom, scoreOf, check, hasNext, candidates, pool, get WORDS() { return WORDS; }, get FOREIGN() { return FOREIGN; }, get NONSTD() { return NONSTD; }, get INJEONG() { return INJEONG; } },
};
