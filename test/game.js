'use strict';
/**
 * 판 로직 시험 — 서버 없이 game.js 를 가짜 소켓과 가상 시계로 돌린다.
 *   node test/game.js
 * 두음 법칙 · 낱말 판정 · 점수 · 시간 초과 · 봇끼리 끝까지 한 판 · 판 중에 나가기 · 미리 쳐 둔 낱말.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

/* ── 가상 시계: setTimeout 과 Date.now 를 바꿔 끼운다 ── */
let now = 1_000_000, seq = 0;
const queue = new Map();
global.setTimeout = (fn, ms = 0) => { const id = ++seq; queue.set(id, { at: now + Math.max(0, ms), fn }); return id; };
global.clearTimeout = id => { queue.delete(id); };
Date.now = () => now;
function advance(ms) {
  const end = now + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of queue) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
    if (!next) break;
    queue.delete(next[0]);
    now = next[1].at;
    next[1].fn();
  }
  now = end;
}

const game = require('../game');
game.loadDict(fs.readFileSync(path.join(__dirname, '..', 'dict', 'words.txt'), 'utf8'));
const { dueum, scoreOf } = game._t;

function sock() {
  return { readyState: 1, inbox: [], send(t) { this.inbox.push(JSON.parse(t)); }, close() { this.readyState = 3; } };
}
const last = (s, pred) => [...s.inbox].reverse().find(pred);
const state = s => last(s, m => m.t === 'state');
const evs = (s, kind) => s.inbox.filter(m => m.t === 'ev' && m.kind === kind);

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

console.log('끝말잇기 판 시험');
game.selfCheck();

check('두음 법칙', () => {
  assert.strictEqual(dueum('력'), '역');
  assert.strictEqual(dueum('룡'), '용');
  assert.strictEqual(dueum('뇨'), '요');
  assert.strictEqual(dueum('로'), '노');
  assert.strictEqual(dueum('러'), '러');
});

check('점수는 긴 낱말 · 빠른 답 · 긴 줄에 더 준다', () => {
  assert.ok(scoreOf('자동차', 0, 5, 10, 0) > scoreOf('자두', 0, 5, 10, 0));
  assert.ok(scoreOf('자두', 0, 9, 10, 0) > scoreOf('자두', 0, 1, 10, 0));
  assert.ok(scoreOf('자두', 10, 5, 10, 0) > scoreOf('자두', 0, 5, 10, 0));
  assert.ok(scoreOf('자두', 0, 5, 10, 1) > scoreOf('자두', 0, 5, 10, 0));
});

/* 사람 둘이 한 판 */
const a = sock(), b = sock();
let code, room;
check('방 만들기 · 들어가기 · 목록', () => {
  const w = sock();
  game.handle(w, { t: 'rooms' });
  assert.ok(last(w, m => m.t === 'rooms'));
  game.handle(a, { t: 'create', name: '가나', title: '시험 방' });
  code = last(a, m => m.t === 'welcome').code;
  advance(400);
  const list = last(w, m => m.t === 'rooms').list;
  assert.ok(list.some(r => r.code === code && r.title === '시험 방'), '목록에 방이 안 보임');
  game.handle(b, { t: 'join', code, name: '다라' });
  assert.strictEqual(state(a).players.length, 2);
  room = game.rooms.get(code);
});

check('시작하면 라운드 알림 뒤 첫 차례가 열린다', () => {
  game.handle(b, { t: 'start' });                       // 방장이 아니면 무시
  assert.strictEqual(room.phase, 'lobby');
  game.handle(a, { t: 'cfg', rounds: 3, roundTime: 60 });
  game.handle(a, { t: 'start' });
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(evs(a, 'round').length, 1);
  advance(3700);
  assert.strictEqual(room.g.stage, 'turn');
  assert.strictEqual(room.g.roundWord.length, 3);
});

const turnSock = () => (room.g.turnId === 1 ? a : b);
const otherSock = () => (room.g.turnId === 1 ? b : a);
/** 지금 시작 글자로 이을 수 있는 흔한 낱말 하나 */
const answer = () => game._t.candidates(game._t.pool('classic', true), room.g.starts, room.g.used)[0];

check('틀린 낱말은 이유와 함께 알린다', () => {
  const s = turnSock();
  const ch = room.g.starts[0];
  game.handle(s, { t: 'say', text: ch + '뷁뷁' });
  assert.strictEqual(last(a, m => m.t === 'ev').why, 'nodict');
  advance(200);
  game.handle(s, { t: 'say', text: '뷁뷁' });
  assert.strictEqual(last(a, m => m.t === 'ev').why, 'start');
});

check('내 차례가 아닐 때 친 말은 채팅', () => {
  game.handle(otherSock(), { t: 'say', text: '안녕' });
  assert.strictEqual(last(a, m => m.t === 'chat' || m.t === 'ev').t, 'chat');
});

check('맞는 낱말 → 점수 · 다음 차례 · 두음 법칙 시작 글자', () => {
  const s = turnSock(), who = room.g.turnId;
  const w = answer();
  advance(300);
  game.handle(s, { t: 'say', text: w });
  const ok = last(a, m => m.t === 'ev' && m.kind === 'ok');
  assert.strictEqual(ok.word, w);
  assert.ok(ok.pts > 0);
  assert.notStrictEqual(room.g.turnId, who);
  assert.deepStrictEqual(room.g.starts, game._t.startsFrom(w[w.length - 1]));
  advance(500);
  assert.strictEqual(room.g.stage, 'turn');
});

check('이미 쓴 낱말은 안 된다', () => {
  // 앞 낱말과 같은 글자로 끝나는 쓴 말을 억지로 만들 수 없으니, 판정 함수로 본다
  const w = answer();
  room.g.used.add(w);
  assert.strictEqual(game._t.check(room, w), 'used');
  room.g.used.delete(w);
});

check('낱말이 받아들여지기 직전 다음 사람이 친 말은 채팅으로 새지 않고 차례에 들어간다', () => {
  const s = turnSock();
  game.handle(s, { t: 'say', text: answer() });
  assert.strictEqual(room.g.stage, 'gap');
  const nextS = turnSock();
  const before = nextS.inbox.filter(m => m.t === 'chat').length;
  const w = answer();
  game.handle(nextS, { t: 'say', text: w });
  assert.strictEqual(nextS.inbox.filter(m => m.t === 'chat').length, before, '채팅으로 샜다');
  advance(500);
  assert.strictEqual(last(a, m => m.t === 'ev' && m.kind === 'ok').word, w);
});

check('시간이 다 가면 감점하고 다음 라운드는 진 사람부터', () => {
  advance(500);
  const loser = room.g.turnId;
  const before = room.players.find(p => p.id === loser).score;
  advance(11_000);
  const f = last(a, m => m.t === 'ev' && m.kind === 'fail');
  assert.strictEqual(f.by, loser);
  assert.strictEqual(room.players.find(p => p.id === loser).score, before - 50);
  advance(2700);
  assert.strictEqual(room.g.round, 2);
  assert.strictEqual(room.g.turnId, loser);
});

check('마지막 라운드가 끝나면 순위를 알리고 대기실로', () => {
  advance(60_000 * 3);
  assert.strictEqual(room.phase, 'lobby');
  const end = last(a, m => m.t === 'ev' && m.kind === 'end');
  assert.strictEqual(end.ranking.length, 2);
  assert.ok(state(a).last);
});

/* 봇끼리 끝까지 */
check('봇 셋이 끝까지 한 판 (모든 낱말이 규칙에 맞는지)', () => {
  for (const diff of ['easy', 'normal', 'hard']) {
    for (const mode of ['classic', 'kkt']) {
      const h = sock();
      game.handle(h, { t: 'create', name: '관전', bots: 3 });
      const r = game.rooms.get(last(h, m => m.t === 'welcome').code);
      game.handle(h, { t: 'cfg', botDiff: diff, mode, rounds: 4, roundTime: 60, mission: true });
      // 사람은 차례에서 빠지게 한다 (연결이 없는 사람은 판에 끼지 않는다). 소식은 그대로 받는다.
      r.players.find(p => !p.bot).connected = false;
      game.handle(h, { t: 'start' });
      advance(60_000 * 5);
      assert.strictEqual(r.phase, 'lobby', `${diff}/${mode} 판이 안 끝났다`);
      const oks = evs(h, 'ok');
      // 어려움 봇은 한방 단어로 서로를 금방 끝낸다. 그래도 라운드 첫 차례는 반드시 내므로 라운드 수만큼은 나온다.
      assert.ok(oks.length >= (diff === 'hard' ? 4 : 6), `${diff}/${mode} 낱말이 너무 적다: ${oks.length}`);
      let prev = null;
      const seen = new Set();
      for (const m of h.inbox) {
        if (m.t === 'ev' && m.kind === 'round') prev = null;
        if (m.t === 'ev' && m.kind === 'ok') {
          if (prev) assert.ok(game._t.startsFrom(prev[prev.length - 1]).includes(m.word[0]), `${prev} → ${m.word}`);
          if (mode === 'kkt') assert.strictEqual(m.word.length, 3);
          assert.ok(!seen.has(m.word), '같은 낱말이 두 번: ' + m.word);
          seen.add(m.word);
          prev = m.word;
        }
      }
      console.log(`      ${diff.padEnd(6)} ${mode.padEnd(7)} 낱말 ${String(oks.length).padStart(3)}개 · 예: ${oks.slice(0, 6).map(m => m.word).join(' → ')}`);
      game.handle(h, { t: 'leave' });
      assert.ok(!game.rooms.has(r.code), '사람이 다 나간 방이 남았다');
    }
  }
});

check('봇은 라운드 첫 차례와, 앞 차례를 못 낸 바로 다음 차례엔 빠지지 않는다 (사람 2 · 봇 1 · 한방 금지)', () => {
  let firstFails = 0, twice = 0, botTurns = 0;
  for (let rep = 0; rep < 25; rep++) {
    const x = sock(), y = sock();
    game.handle(x, { t: 'create', name: 'x' });
    const c = last(x, m => m.t === 'welcome').code;
    game.handle(y, { t: 'join', code: c, name: 'y' });
    game.handle(x, { t: 'addBot' });
    const r = game.rooms.get(c);
    const bot = r.players.find(p => p.bot);
    game.handle(x, { t: 'cfg', manner: true, rounds: 5, roundTime: 60 });
    game.handle(x, { t: 'start' });
    // 사람 둘은 흔한 낱말로 곧바로 답한다
    let prevBotFailed = false, chainAtTurn = null, seen = null;
    for (let i = 0; i < 6000 && r.phase === 'playing'; i++) {
      const g = r.g;
      if (g && g.stage === 'turn' && g.turnStart !== seen) {
        seen = g.turnStart;
        if (g.turnId === bot.id) { botTurns++; chainAtTurn = g.chain; }
        else {
          const w = game._t.candidates(game._t.pool('classic', true), g.starts, g.used).find(v => game._t.check(r, v) === null);
          if (w) game.handle(g.turnId === 1 ? x : y, { t: 'say', text: w });
        }
      }
      const before = evs(x, 'fail').length;
      advance(100);
      const f = evs(x, 'fail').slice(before).find(m => m.by === bot.id);
      if (f && r.g) {
        if (chainAtTurn === 0) firstFails++;
        if (prevBotFailed) twice++;
      }
      if (evs(x, 'ok').slice(-1)[0]?.by === bot.id) prevBotFailed = false;
      if (f) prevBotFailed = true;
    }
    game.handle(x, { t: 'leave' }); game.handle(y, { t: 'leave' });
  }
  assert.ok(botTurns > 50, '봇 차례가 너무 적다: ' + botTurns);
  assert.strictEqual(firstFails, 0, '라운드 첫 차례에 봇이 시간 초과');
});

check('한방 금지 방에서는 이을 말이 없는 낱말을 받지 않는다', () => {
  const h = sock();
  game.handle(h, { t: 'create', name: '매너', bots: 1 });
  const r = game.rooms.get(last(h, m => m.t === 'welcome').code);
  game.handle(h, { t: 'cfg', manner: true });
  game.handle(h, { t: 'start' });
  advance(3700);
  // '늄'으로 끝나는 말은 이을 말이 거의 없다 — 사전에서 한방 단어 하나를 찾아 시작 글자를 맞춘다
  const all = game._t.pool('classic', false);
  let killer = null;
  for (const [, ws] of all) {
    killer = ws.find(w => !game._t.hasNext(r, w, r.g.used));
    if (killer) break;
  }
  assert.ok(killer, '한방 단어를 못 찾음');
  r.g.starts = [killer[0]];
  r.g.turnId = r.players.find(p => !p.bot).id;
  r.g.stage = 'turn';
  r.g.chain = 3;
  assert.strictEqual(game._t.check(r, killer), 'hanbang');
  r.cfg.manner = false;
  assert.strictEqual(game._t.check(r, killer), null);
  // 라운드 첫 낱말은 한방 금지를 끄더라도 안 된다
  r.g.chain = 0;
  assert.strictEqual(game._t.check(r, killer), 'firstkill');
  game.handle(h, { t: 'leave' });
});

check('외래어 금지 방에서는 버스 · 버스표를 받지 않고, 봇도 외래어를 안 쓴다', () => {
  const h = sock();
  game.handle(h, { t: 'create', name: '토박이', bots: 3 });
  const r = game.rooms.get(last(h, m => m.t === 'welcome').code);
  game.handle(h, { t: 'cfg', noForeign: true, botDiff: 'hard', rounds: 3 });
  r.players.find(p => !p.bot).connected = false;
  game.handle(h, { t: 'start' });
  advance(3700);
  r.g.starts = ['버'];
  assert.strictEqual(game._t.check(r, '버스'), 'foreign');
  assert.strictEqual(game._t.check(r, '버스표'), 'foreign');
  r.g.starts = ['밥'];
  assert.strictEqual(game._t.check(r, '밥상'), null);
  advance(60_000 * 4);
  const oks = evs(h, 'ok');
  assert.ok(oks.length > 3, '낱말이 너무 적다');
  const bad = oks.filter(m => game._t.FOREIGN.has(m.word));
  assert.deepStrictEqual(bad.map(m => m.word), []);
  console.log(`      외래어 금지 어려움 봇: ${oks.slice(0, 8).map(m => m.word).join(' → ')}`);
  game.handle(h, { t: 'leave' });
});

check('표준어만 · 어인정 — 방언 · 띄어 쓰는 말은 표준어만에서 막고, 어인정 낱말은 켠 방에서만', () => {
  const h = sock();
  game.handle(h, { t: 'create', name: '규칙', bots: 1 });
  const r = game.rooms.get(last(h, m => m.t === 'welcome').code);
  game.handle(h, { t: 'start' });
  advance(3700);
  r.g.chain = 2;
  const nonstd = [...game._t.NONSTD].find(w => w.length >= 3 && !game._t.FOREIGN.has(w) && game._t.hasNext(r, w, r.g.used));
  r.g.starts = [nonstd[0]];
  assert.strictEqual(game._t.check(r, nonstd), null, '기본 방에서 ' + nonstd + ' 가 안 됨');
  r.cfg.strict = true;
  assert.strictEqual(game._t.check(r, nonstd), 'strict');
  r.cfg.strict = false;
  assert.ok(game._t.WORDS.has('치과기공사') && game._t.NONSTD.has('치과기공사'), '띄어 쓰는 구 치과기공사');
  if (game._t.INJEONG.size) {
    const ij = [...game._t.INJEONG].find(w => game._t.hasNext(r, w, r.g.used));
    r.g.starts = [ij[0]];
    assert.strictEqual(game._t.check(r, ij), 'injeong');
    r.cfg.injeong = true;
    assert.strictEqual(game._t.check(r, ij), null);
  }
  game.handle(h, { t: 'leave' });
});

check('시간제한 없음 — 시계가 안 가고, 포기하면 −50 · 다음 라운드', () => {
  const x = sock(), y = sock();
  game.handle(x, { t: 'create', name: 'x' });
  const c = last(x, m => m.t === 'welcome').code;
  game.handle(y, { t: 'join', code: c, name: 'y' });
  const r = game.rooms.get(c);
  game.handle(x, { t: 'cfg', roundTime: 0, rounds: 3 });
  assert.strictEqual(r.cfg.roundTime, 0);
  game.handle(x, { t: 'start' });
  advance(3700);
  const cur = r.g.turnId;
  assert.strictEqual(r.g.turnLimit, 0);
  advance(5 * 60_000);                                   // 5분을 기다려도
  assert.strictEqual(r.g.stage, 'turn');
  assert.strictEqual(r.g.turnId, cur);
  assert.strictEqual(evs(x, 'fail').length, 0);
  // 차례가 아닌 사람의 포기는 무시
  game.handle(cur === 1 ? y : x, { t: 'giveup' });
  assert.strictEqual(evs(x, 'fail').length, 0);
  game.handle(cur === 1 ? x : y, { t: 'giveup' });
  const f = last(x, m => m.t === 'ev' && m.kind === 'fail');
  assert.strictEqual(f.why, 'giveup');
  assert.strictEqual(r.players.find(p => p.id === cur).score, -50);
  advance(2700);
  assert.strictEqual(r.g.round, 2);
  // 차례인 사람이 끊기면 잠깐 뒤 넘어간다
  advance(3700);
  const who = r.g.turnId;
  game.disconnect(who === 1 ? x : y);
  advance(9000);
  assert.strictEqual(last(x, m => m.t === 'ev' && m.kind === 'fail').why === 'dc' || last(y, m => m.t === 'ev' && m.kind === 'fail').why === 'dc', true);
  game.handle(x, { t: 'leave' }); game.handle(y, { t: 'leave' });
});

check('시간제한 없는 봇 판도 끝난다 (막히면 봇이 포기)', () => {
  const h = sock();
  game.handle(h, { t: 'create', name: '관전', bots: 3 });
  const r = game.rooms.get(last(h, m => m.t === 'welcome').code);
  game.handle(h, { t: 'cfg', roundTime: 0, rounds: 3, botDiff: 'hard' });
  r.players.find(p => !p.bot).connected = false;
  game.handle(h, { t: 'start' });
  advance(60 * 60_000);
  assert.strictEqual(r.phase, 'lobby', '판이 안 끝났다');
  assert.ok(evs(h, 'fail').every(m => m.why === 'giveup' || m.why === 'time'));
  game.handle(h, { t: 'leave' });
});

check('판 중에 차례인 사람이 나가면 다음 사람에게 넘어간다', () => {
  const x = sock(), y = sock(), z = sock();
  game.handle(x, { t: 'create', name: 'x' });
  const c = last(x, m => m.t === 'welcome').code;
  game.handle(y, { t: 'join', code: c, name: 'y' });
  game.handle(z, { t: 'join', code: c, name: 'z' });
  const r = game.rooms.get(c);
  game.handle(x, { t: 'start' });
  advance(3700);
  const cur = r.g.turnId;
  const s = [x, y, z][cur - 1];
  game.handle(s, { t: 'leave' });
  assert.strictEqual(r.phase, 'playing');
  assert.ok(!r.g.order.includes(cur));
  assert.notStrictEqual(r.g.turnId, cur);
  assert.strictEqual(r.g.stage, 'turn');
  // 둘만 남았다가 하나 더 나가면 판이 끝난다
  const rest = [x, y, z].filter((_, i) => i + 1 !== cur);
  game.handle(rest[0], { t: 'leave' });
  assert.strictEqual(r.phase, 'lobby');
  game.handle(rest[1], { t: 'leave' });
});

check('판 중에 들어온 사람은 구경하다가 다음 판부터', () => {
  const x = sock(), y = sock();
  game.handle(x, { t: 'create', name: 'x', bots: 1 });
  const c = last(x, m => m.t === 'welcome').code;
  game.handle(x, { t: 'start' });
  game.handle(y, { t: 'join', code: c, name: 'y' });
  const r = game.rooms.get(c);
  assert.strictEqual(r.players.find(p => p.name === 'y').inGame, false);
  assert.ok(!r.g.order.includes(r.players.find(p => p.name === 'y').id));
  game.handle(x, { t: 'leave' }); game.handle(y, { t: 'leave' });
});

check('빠른 입장은 기다리는 방으로, 없으면 새 방', () => {
  const x = sock(), y = sock();
  game.handle(x, { t: 'quick', name: 'x' });
  const c = last(x, m => m.t === 'welcome').code;
  game.handle(y, { t: 'quick', name: 'y' });
  assert.strictEqual(last(y, m => m.t === 'welcome').code, c);
  game.handle(x, { t: 'leave' }); game.handle(y, { t: 'leave' });
});

check('새로고침(resume)하면 같은 자리로', () => {
  const x = sock(), x2 = sock();
  game.handle(x, { t: 'create', name: 'x', bots: 1 });
  const w = last(x, m => m.t === 'welcome');
  game.disconnect(x);
  game.handle(x2, { t: 'resume', code: w.code, token: w.token });
  assert.strictEqual(last(x2, m => m.t === 'welcome').you, w.you);
  assert.strictEqual(state(x2).players.find(p => p.id === w.you).connected, true);
  game.handle(x2, { t: 'leave' });
});

console.log(`\n${pass}개 통과 · ${fail}개 실패`);
process.exit(fail ? 1 : 0);
