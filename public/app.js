'use strict';
/* 끝말잇기 — 화면. 판정은 전부 서버가 하고, 여기는 보여 주고 친 것을 보낸다. */

const $ = s => document.querySelector(s);
const el = {
  scTitle: $('#scTitle'), btnEnter: $('#btnEnter'), btnHome: $('#btnHome'),
  demoSheet: $('#demoSheet'), demoNote: $('#demoNote'), titleOnline: $('#titleOnline'),
  scMain: $('#scMain'), scRoom: $('#scRoom'), scGame: $('#scGame'),
  inName: $('#inName'), inCode: $('#inCode'), joinForm: $('#joinForm'),
  btnQuick: $('#btnQuick'), btnCreate: $('#btnCreate'), btnSolo: $('#btnSolo'),
  roomList: $('#roomList'), roomEmpty: $('#roomEmpty'), online: $('#online'),
  dlgCreate: $('#dlgCreate'), createForm: $('#createForm'), inTitle: $('#inTitle'), inPriv: $('#inPriv'),
  roomTitle: $('#roomTitle'), roomCode: $('#roomCode'), btnInvite: $('#btnInvite'), btnLeave: $('#btnLeave'),
  slots: $('#slots'), settings: $('#settings'), lastResult: $('#lastResult'),
  btnStart: $('#btnStart'), waitHost: $('#waitHost'),
  chatLobby: $('#chatLobby'), chatGame: $('#chatGame'),
  roundWord: $('#roundWord'), roundNo: $('#roundNo'), mission: $('#mission'), btnStop: $('#btnStop'), btnSound: $('#btnSound'),
  roundFill: $('#roundFill'), roundSec: $('#roundSec'), turnFill: $('#turnFill'), turnSec: $('#turnSec'),
  board: $('#board'), sheet: $('#sheet'), prevSheet: $('#prevSheet'), by: $('#by'), def: $('#def'), attempt: $('#attempt'), stamp: $('#stamp'),
  rwIntro: $('#rwIntro'), rwCells: $('#rwCells'), rwSub: $('#rwSub'),
  chain: $('#chain'), players: $('#players'),
  timers: $('.timers'), roundBar: $('.tbar.round'), turnBar: $('.tbar.turn'),
  entryForm: $('#entryForm'), entry: $('#entry'), entryTag: $('#entryTag'), btnGiveup: $('#btnGiveup'),
  dlgResult: $('#dlgResult'), ranking: $('#ranking'), resultNote: $('#resultNote'),
  btnAgain: $('#btnAgain'), btnResultClose: $('#btnResultClose'),
  toast: $('#toast'),
};

/* 저장 — 사생활 보호 모드 등에서 저장소가 막혀 있어도 게임은 돌아야 한다 */
const store = {
  get(k, area = localStorage) { try { return area.getItem(k); } catch (_) { return null; } },
  set(k, v, area = localStorage) { try { area.setItem(k, v); } catch (_) {} },
  del(k, area = localStorage) { try { area.removeItem(k); } catch (_) {} },
};

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MODE_KO = { classic: '끝말잇기', kkt: '쿵쿵따' };
const WHY = {
  hangul: '한글 낱말만',
  short: '두 글자 이상',
  len: '쿵쿵따는 세 글자만',
  start: '시작 글자가 다름',
  nodict: '사전에 없는 말',
  used: '이미 나온 말',
  hanbang: '한방 단어 금지',
  foreign: '외래어 금지',
  strict: '표준어만 — 방언 · 옛말 · 띄어 쓰는 말은 안 됨',
  injeong: '사전 외 낱말 — 이 방은 꺼져 있음',
  firstkill: '라운드 첫 낱말은 한방 단어 안 됨',
};
// 포기도 판에서는 시간 초과로 보인다 — 차례를 못 넘긴 건 같다
const FAIL_STAMP = { round: '라운드 끝', time: '시간 초과', giveup: '시간 초과', dc: '연결 끊김' };
const FAIL_LINE = { round: '라운드 시간 초과', time: '차례 시간 초과', giveup: '시간 초과(포기)', dc: '연결이 끊겨 차례를 넘김' };
const timedRoom = () => S && S.cfg.roundTime > 0;

let toastT = null;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function show(which) {
  for (const k of ['scTitle', 'scMain', 'scRoom', 'scGame']) el[k].hidden = k !== which;
}

/* ───────────── 소리 (기본은 끔) ───────────── */
let soundOn = store.get('kmSound') === '1';
let actx = null;
function renderSound() { el.btnSound.textContent = soundOn ? '🔊' : '🔈'; el.btnSound.title = soundOn ? '소리 끄기' : '소리 켜기'; }
renderSound();
el.btnSound.onclick = () => { soundOn = !soundOn; store.set('kmSound', soundOn ? '1' : '0'); renderSound(); if (soundOn) beep('ok'); };
function beep(kind) {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = {
      ok: [[660, 0, .07], [880, .07, .1]],
      mine: [[520, 0, .08], [780, .08, .08], [1040, .16, .12]],
      bad: [[180, 0, .14]],
      fail: [[440, 0, .14], [330, .14, .14], [220, .28, .26]],
      tick: [[1200, 0, .03]],
      round: [[523, 0, .1], [659, .1, .1], [784, .2, .18]],
      turn: [[880, 0, .06]],
    }[kind] || [];
    const t0 = actx.currentTime;
    for (const [f, at, len] of notes) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = kind === 'bad' ? 'square' : 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(.12, t0 + at + .01);
      g.gain.exponentialRampToValueAtTime(.0001, t0 + at + len);
      o.connect(g).connect(actx.destination);
      o.start(t0 + at); o.stop(t0 + at + len + .02);
    }
  } catch (_) { /* 소리가 안 나도 게임은 된다 */ }
}

/* ───────────── 뜻풀이 (첫 글자별 조각을 받아 둔다) ───────────── */
const shards = new Map();
function defOf(word) {
  const key = word.charCodeAt(0).toString(16);
  if (!shards.has(key)) {
    shards.set(key, fetch(`dict/${key}.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({})));
  }
  return shards.get(key).then(m => m[word] || null);
}
function defHtml(d) {
  if (!d) return '';
  if (typeof d === 'string') return esc(d);
  return d.map((x, i) => `<i>${'①②③④'[i]}</i>${esc(x)}`).join('  ');
}

/* ───────────── 연결 ───────────── */
/* 서버(Cloudflare 무료 플랜)는 켜져 있는 시간이 한도라서,
   20분 동안 아무 조작이 없으면 서버가 연결을 닫는다(4000). 그때는 스스로 다시 붙지 않고
   화면을 다시 만질 때 이어 붙는다. 켜 두기만 한 탭이 서버를 붙잡아 두지 않게. */
let ws = null, pingT = null, resting = false, wokeUp = false;
let me = null, S = null, clockOffset = 0;
const saved = () => { try { return JSON.parse(store.get('km', sessionStorage) || 'null'); } catch (_) { return null; } };

function wake(e) {
  if (!resting) return;
  if (e.type === 'visibilitychange' && document.hidden) return;
  resting = false;
  el.toast.hidden = true;
  wokeUp = true;
  reconnect();
}
['pointerdown', 'keydown'].forEach(t => addEventListener(t, wake, true));
document.addEventListener('visibilitychange', wake);

function connect(onOpen) {
  if (ws && ws.readyState === 1) { onOpen && onOpen(); return; }
  // 붙는 중이던 옛 소켓은 손을 떼고 닫는다 — 둘이 서로를 밀어내며 끝없이 다시 붙지 않게
  if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; try { ws.close(); } catch (_) {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    if (sock !== ws) return;
    clearInterval(pingT);
    pingT = setInterval(() => send({ t: 'ping' }), 25_000);
    onOpen && onOpen();
  };
  ws.onmessage = e => {
    if (sock !== ws) return;
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.t === 'moved' || m.t === 'idle') {
      sock.onclose({ code: m.t === 'moved' ? 4001 : 4000 });
      ws = null;
      try { sock.close(); } catch (_) {}
      return;
    }
    onMessage(m);
  };
  ws.onclose = e => {
    if (sock !== ws) return;
    clearInterval(pingT);
    if (e.code === 4000 || e.code === 4001) {
      resting = true;
      el.toast.textContent = e.code === 4000
        ? '한동안 조작이 없어서 연결을 쉬고 있음. 아무 곳이나 누르면 다시 붙음.'
        : '다른 창에서 이 자리를 이어받았음. 여기서 계속하려면 아무 곳이나 누르세요.';
      el.toast.hidden = false;
      clearTimeout(toastT);
      return;
    }
    if (S) toast('연결이 끊겼음. 다시 붙는 중…');
    setTimeout(reconnect, 1200);
  };
}
const send = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

/** 방에 있었으면 그 자리로, 아니면 방 목록으로 */
function reconnect() {
  const sv = saved();
  if (sv) connect(() => send({ t: 'resume', code: sv.code, token: sv.token }));
  else connect(() => send({ t: 'rooms' }));
}

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      wokeUp = false;
      if (m.code !== (S && S.code)) chatReset();
      me = m.you;
      store.set('km', JSON.stringify({ code: m.code, token: m.token }), sessionStorage);
      history.replaceState(null, '', '#' + m.code);
      break;
    case 'state': onState(m); break;
    case 'ev': onEvent(m); break;
    case 'chat': addChat(m.name, m.text, m.from === me); break;
    case 'rooms': renderRooms(m); break;
    case 'err':
      toast(m.fatal && wokeUp ? '오래 비워 둔 사이 방이 정리됐음. 새로 들어가 주세요.' : m.msg);
      if (m.fatal) goMain();
      wokeUp = false;
      break;
  }
}

function goMain() {
  store.del('km', sessionStorage);
  S = null; me = null;
  history.replaceState(null, '', location.pathname);
  show('scMain');
  connect(() => send({ t: 'rooms' }));
}

/* ───────────── 첫 화면 ───────────── */
const nameOf = () => el.inName.value.trim().slice(0, 10) || '';
function needName() {
  const n = nameOf();
  if (n) { store.set('kmName', n); return n; }
  el.inName.focus();
  toast('이름을 먼저 적어 주세요');
  return null;
}
el.inName.value = store.get('kmName') || '';
el.inName.addEventListener('change', () => store.set('kmName', nameOf()));

el.btnQuick.onclick = () => { const n = needName(); if (n) connect(() => send({ t: 'quick', name: n })); };
el.btnSolo.onclick = () => {
  const n = needName();
  if (n) connect(() => send({ t: 'create', name: n, title: '혼자 연습', priv: true, bots: 3 }));
};
let createMode = 'classic';
el.btnCreate.onclick = () => {
  const n = needName(); if (!n) return;
  el.inTitle.value = `${n}의 방`;
  el.dlgCreate.showModal();
  el.inTitle.select();
};
el.dlgCreate.querySelector('[data-name="cMode"]').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  createMode = b.dataset.v;
  for (const x of b.parentNode.children) x.classList.toggle('on', x === b);
});
el.dlgCreate.addEventListener('close', () => {
  if (el.dlgCreate.returnValue !== 'ok') return;
  const n = needName(); if (!n) return;
  connect(() => send({ t: 'create', name: n, title: el.inTitle.value.trim(), mode: createMode, priv: el.inPriv.checked }));
});
el.joinForm.onsubmit = e => {
  e.preventDefault();
  const code = el.inCode.value.trim().toUpperCase();
  if (code.length !== 4) { toast('방 코드는 네 글자'); el.inCode.focus(); return; }
  const n = needName(); if (!n) return;
  connect(() => send({ t: 'join', code, name: n }));
};

function renderRooms(m) {
  el.online.textContent = `${m.online}명 접속 중`;
  el.titleOnline.textContent = `지금 ${m.online}명 접속 · 열린 방 ${m.list.length}개`;
  el.roomEmpty.hidden = m.list.length > 0;
  el.roomList.innerHTML = m.list.map(r => `
    <li data-code="${r.code}" class="${r.phase === 'playing' ? 'playing' : ''}">
      <span class="r-title">${esc(r.title)}</span>
      <span class="r-meta">
        <span class="pill">${MODE_KO[r.mode] || r.mode}</span>
        <span class="pill">${r.n}/${r.max}명</span>
        <span class="pill ${r.phase === 'playing' ? 'live' : ''}">${r.phase === 'playing' ? '게임 중' : '기다리는 중'}</span>
        <span>${esc(r.host)}</span>
      </span>
    </li>`).join('');
}
el.roomList.addEventListener('click', e => {
  const li = e.target.closest('li[data-code]'); if (!li) return;
  const n = needName(); if (!n) return;
  connect(() => send({ t: 'join', code: li.dataset.code, name: n }));
});

/* ───────────── 상태 ───────────── */
function onState(s) {
  const prev = S;
  S = s;
  clockOffset = s.now - Date.now();
  if (s.phase === 'lobby') { renderRoom(); show('scRoom'); }
  else { renderGame(prev); show('scGame'); }
  syncEntry();
}

const meP = () => S && S.players.find(p => p.id === me);
const isHost = () => S && S.hostId === me;
const nameById = id => { const p = S && S.players.find(x => x.id === id); return p ? p.name : '누군가'; };

/* ───────────── 대기실 ───────────── */
function renderRoom() {
  el.roomTitle.textContent = S.title;
  el.roomCode.textContent = S.code;
  const host = isHost();
  const slots = [];
  for (let i = 0; i < 8; i++) {
    const p = S.players[i];
    if (!p) {
      slots.push(`<li class="slot empty ${host ? 'can' : ''}" data-add="1">${host ? '+ 봇 부르기' : '빈자리'}</li>`);
      continue;
    }
    const cls = ['slot', p.id === S.hostId ? 'host' : '', p.id === me ? 'me' : '', p.connected ? '' : 'off'].join(' ');
    const badge = p.id === S.hostId ? '방장' : p.bot ? '봇' : '';
    const x = host && p.id !== me ? `<button class="x" data-kick="${p.id}" title="${p.bot ? '봇 빼기' : '내보내기'}">×</button>` : '';
    const give = host && p.id !== me && !p.bot && p.connected
      ? `<button class="give" data-host="${p.id}" title="${esc(p.name)}에게 방장 넘기기">방장 넘기기</button>` : '';
    slots.push(`<li class="${cls}"><span class="badge">${badge}</span>${x}${give}
      <span class="face">${esc(p.name.slice(0, 1))}</span><span class="nm">${esc(p.name)}</span></li>`);
  }
  el.slots.innerHTML = slots.join('');

  // 설정 — 방장만 바꿀 수 있다
  el.settings.classList.toggle('locked', !host);
  for (const seg of el.settings.querySelectorAll('.seg[data-cfg]')) {
    const v = String(S.cfg[seg.dataset.cfg]);
    seg.classList.toggle('locked', !host);
    for (const b of seg.children) b.classList.toggle('on', b.dataset.v === v);
  }
  for (const cb of el.settings.querySelectorAll('input[data-cfg]')) {
    cb.checked = cb.dataset.cfg === 'priv' ? S.priv : !!S.cfg[cb.dataset.cfg];
    cb.disabled = !host;
  }

  el.btnStart.hidden = !host;
  el.waitHost.hidden = host;
  el.btnStart.disabled = S.players.filter(p => p.bot || p.connected).length < 2;
  el.btnStart.textContent = el.btnStart.disabled ? '둘 이상이어야 시작' : '시작';

  // 지난 판
  const L = S.last;
  el.lastResult.hidden = !L;
  if (L) {
    el.lastResult.innerHTML = `<h4>지난 판 · 제시어 ‘${esc(L.roundWord)}’ · 낱말 ${L.total}개</h4><ol>` +
      L.ranking.map(r => `<li><b>${esc(r.name)}</b> ${r.score}점 <span class="muted">${r.best ? `· 최고 ‘${esc(r.best.w)}’ ${r.best.pts}점` : ''}</span></li>`).join('') + '</ol>';
  }
}

el.slots.addEventListener('click', e => {
  const k = e.target.closest('[data-kick]');
  if (k) { send({ t: 'kick', id: Number(k.dataset.kick) }); return; }
  const h = e.target.closest('[data-host]');
  if (h) {
    const id = Number(h.dataset.host);
    if (confirm(`${nameById(id)}에게 방장을 넘길까요? 설정 · 시작은 그 사람이 하게 됩니다.`)) send({ t: 'host', id });
    return;
  }
  if (e.target.closest('[data-add]') && isHost()) send({ t: 'addBot' });
});
el.settings.addEventListener('click', e => {
  const b = e.target.closest('.seg[data-cfg] button');
  if (!b || !isHost()) return;
  const key = b.parentNode.dataset.cfg;
  const v = /^\d+$/.test(b.dataset.v) ? Number(b.dataset.v) : b.dataset.v;
  send({ t: 'cfg', [key]: v });
});
el.settings.addEventListener('change', e => {
  const cb = e.target.closest('input[data-cfg]');
  if (cb && isHost()) send({ t: 'cfg', [cb.dataset.cfg]: cb.checked });
});
el.btnStart.onclick = () => send({ t: 'start' });
el.btnLeave.onclick = () => { send({ t: 'leave' }); goMain(); };
el.btnStop.onclick = () => { if (confirm('이 판을 여기서 접을까요? 지금 점수로 순위를 매김.')) send({ t: 'stop' }); };
el.btnInvite.onclick = async () => {
  const url = `${location.origin}${location.pathname}#${S.code}`;
  try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했음 — ' + url); }
  catch (_) { toast('초대 링크: ' + url, 6000); }
};

/* ───────────── 게임 ───────────── */
function renderGame(prev) {
  const g = S.g;
  if (!g) return;
  // 제시어
  el.roundWord.innerHTML = [...g.roundWord].map((c, i) =>
    `<span class="${i + 1 < g.round ? 'done' : i + 1 === g.round ? 'now' : 'next'}">${esc(c)}</span>`).join('');
  el.roundNo.textContent = `${g.round} / ${g.rounds} 라운드` + (timedRoom() ? '' : ' · 시간제한 없음');
  el.mission.hidden = !g.mission;
  if (g.mission) {
    if (!prev || !prev.g || prev.g.mission !== g.mission) { el.mission.classList.remove('pop'); void el.mission.offsetWidth; el.mission.classList.add('pop'); }
    el.mission.innerHTML = `미션 <b>${esc(g.mission)}</b>`;
  }
  el.btnStop.hidden = !isHost();

  // 사람들
  el.players.innerHTML = S.players.map(p => {
    const cls = ['pl', p.id === me ? 'me' : '', g.turnId === p.id && (g.stage === 'turn' || g.stage === 'gap') ? 'turn' : '',
      !p.inGame ? 'watch' : '', p.inGame && !p.connected ? 'off' : ''].join(' ');
    const tag = !p.inGame ? '구경 중' : p.bot ? '봇' : !p.connected ? '연결 끊김' : p.id === me ? '나' : `${p.words}개`;
    return `<li class="${cls}" data-id="${p.id}"><span class="nm">${esc(p.name)}</span>
      <span class="sc ${p.score < 0 ? 'neg' : ''}">${p.score}</span><span class="tag">${tag}</span></li>`;
  }).join('');

  // 이어 온 낱말
  const hist = g.history.slice(-24);
  el.chain.innerHTML = hist.map(h => `<li class="${h.by === me ? 'mine' : ''}" title="${esc(nameById(h.by))} +${h.pts}">${esc(h.w)}</li>`).join('');
  el.chain.scrollLeft = el.chain.scrollWidth;

  // 판 — 방금 들어온 낱말은 이벤트에서 그린다. 여기서는 새로 붙었을 때(새로고침 등) 채운다.
  if (g.stage === 'intro') { if (!prev || !prev.g || prev.g.stage !== 'intro' || prev.g.round !== g.round) drawIntro(); }
  else if (sheetWord === null || sheetWord !== (g.lastWord || '')) drawSheet(g.lastWord, false);
  else drawNext();
  if (introPending && g.round === 1 && g.stage === 'intro') { introPending = false; requestAnimationFrame(() => playRoundWordIntro(g)); }

  // 내 차례 알림
  const myTurn = g.stage === 'turn' && g.turnId === me;
  const wasMine = prev && prev.g && prev.g.stage === 'turn' && prev.g.turnId === me;
  if (myTurn && !wasMine) { beep('mine'); if (document.hidden) flashTitle(); }
}

let sheetWord = null;
/** '으로' / '로' — 받침이 없거나 ㄹ 받침이면 '로' */
function ro(c) {
  const n = c.charCodeAt(0) - 0xAC00;
  const jong = n >= 0 && n < 11172 ? n % 28 : 0;
  return jong === 0 || jong === 8 ? '로' : '으로';
}
/** ‘력’ 또는 ‘역’으로 */
function startsLabel(starts) {
  const last = starts[starts.length - 1];
  return starts.map(c => `‘${c}’`).join(' 또는 ') + ro(last);
}

/** 앞 사람 낱말은 위에 작은 원고지 칸으로, 이어야 할 글자는 가운데 큰 칸으로 */
function drawSheet(word, animate) {
  sheetWord = word || '';
  el.prevSheet.innerHTML = [...(word || '')].map((c, i) =>
    `<span class="cell ${animate ? 'in' : ''} ${i === word.length - 1 ? 'tail' : ''}" style="animation-delay:${i * 40}ms">${esc(c)}</span>`).join('');
  el.prevSheet.style.setProperty('--n', Math.max(5, (word || '').length));
  // 방금 받아들여진 낱말이면 가운데 글자는 뒤따라 오는 상태가 채운다 (지금 S 는 아직 앞 차례의 것)
  if (animate) el.sheet.innerHTML = '';
  else drawNext(false);
  if (!word) { el.by.innerHTML = ''; el.def.innerHTML = ''; }
}
let nextShown = '';
function drawNext(animate = true) {
  const g = S && S.g;
  if (!g || !g.starts || !g.starts.length || g.stage === 'intro') { el.sheet.innerHTML = ''; nextShown = ''; return; }
  const key = g.starts.join(',');
  el.sheet.classList.toggle('wait', g.stage === 'fail');
  if (key === nextShown && el.sheet.firstElementChild) return;     // 같은 글자면 다시 그리지 않는다(숨쉬는 움직임이 끊기지 않게)
  nextShown = key;
  const alt = g.starts[1] ? `<small class="alt">또는 ‘${esc(g.starts[1])}’</small>` : '';
  el.sheet.innerHTML = `<span class="cell big-next ${animate ? 'in' : ''}">${esc(g.starts[0])}${alt}</span>`;
}
function drawIntro() {
  const g = S.g;
  sheetWord = null; nextShown = '';
  el.prevSheet.innerHTML = '';
  el.sheet.classList.remove('wait');
  el.sheet.innerHTML = `<div class="intro"><span class="lbl">${g.round}라운드</span>
    <span class="cell big-next in">${esc(g.roundWord[g.round - 1])}</span></div>`;
  el.by.innerHTML = `<b>${esc(nameById(g.turnId))}</b>부터 시작`;
  el.def.innerHTML = '';
}

/** 틀린 낱말 — 판 한가운데에 크게, 모두에게 */
let badT = null;
function showBad(m) {
  const b = el.attempt;
  b.innerHTML = `<span class="w">${esc(m.word)}</span><span class="why">✗ ${WHY[m.why] || '안 됨'}</span>` +
    `<span class="who">${m.by === me ? '내가 친 말' : esc(nameById(m.by))}</span>`;
  b.hidden = false;
  b.classList.remove('show', 'hide'); void b.offsetWidth; b.classList.add('show');
  clearTimeout(badT);
  badT = setTimeout(() => { b.classList.add('hide'); badT = setTimeout(() => { b.hidden = true; }, 320); }, 1500);
}
function hideBad() { clearTimeout(badT); el.attempt.hidden = true; }

/** 판 시작 — 제시어를 가운데 크게 띄웠다가 줄이며 위 제시어 칸 자리로 넣는다 (서버는 그동안 3.6초 기다린다) */
function playRoundWordIntro(g) {
  const word = g.roundWord;
  el.rwCells.style.setProperty('--n', word.length);
  el.rwCells.innerHTML = [...word].map((c, i) =>
    `<span class="cell in ${i === 0 ? 'first' : ''}" style="animation-delay:${120 + i * 110}ms">${esc(c)}</span>`).join('');
  el.rwSub.textContent = `${word.length}라운드 — 라운드마다 이 글자로 시작`;
  el.rwIntro.hidden = false;
  el.rwIntro.style.opacity = '';
  el.roundWord.classList.add('waiting');
  el.roundWord.classList.remove('landed');
  const land = () => {
    const targets = [...el.roundWord.children];
    const cells = [...el.rwCells.children];
    const motions = cells.map((cell, i) => {
      const t = targets[i];
      if (!t || !cell.animate) return null;
      const a = cell.getBoundingClientRect(), b = t.getBoundingClientRect();
      const dx = (b.left + b.width / 2) - (a.left + a.width / 2), dy = (b.top + b.height / 2) - (a.top + a.height / 2);
      return cell.animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${b.width / a.width})` }],
        { duration: 650, easing: 'cubic-bezier(.6, 0, .25, 1)', fill: 'forwards', delay: i * 40 });
    });
    el.rwIntro.animate([{ backgroundColor: 'rgba(251, 248, 241, .94)' }, { backgroundColor: 'rgba(251, 248, 241, 0)' }],
      { duration: 650, fill: 'forwards' });
    for (const x of el.rwIntro.querySelectorAll('.rw-lbl, .rw-sub')) x.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' });
    const done = () => {
      el.rwIntro.hidden = true;
      el.rwIntro.getAnimations({ subtree: true }).forEach(x => x.cancel());
      el.roundWord.classList.remove('waiting');
      el.roundWord.classList.add('landed');
    };
    const last = motions.filter(Boolean).pop();
    if (last) last.finished.then(done, done); else done();
  };
  clearTimeout(playRoundWordIntro.t);
  playRoundWordIntro.t = setTimeout(land, 1500 + word.length * 110);
}

function showStamp(text, cls, ms = 1400) {
  el.stamp.className = 'stamp ' + (cls || '');
  el.stamp.textContent = text;
  el.stamp.hidden = false;
  clearTimeout(showStamp.t);
  showStamp.t = setTimeout(() => { el.stamp.hidden = true; }, ms);
}
function popPts(id, pts) {
  const card = el.players.querySelector(`[data-id="${id}"]`);
  if (!card) return;
  const s = document.createElement('span');
  s.className = 'pop-pts' + (pts < 0 ? ' neg' : '');
  s.textContent = (pts > 0 ? '+' : '') + pts;
  card.appendChild(s);
  setTimeout(() => s.remove(), 1300);
}

let defReq = 0;
let introPending = false;     // 판이 막 시작했다 — 첫 상태에서 제시어를 가운데 크게
let restored = null;          // 틀려서 입력칸에 되돌려 둔 낱말
function onEvent(m) {
  switch (m.kind) {
    case 'round':
      beep('round');
      hideBad();
      if (m.round === 1) introPending = true;       // 판 시작 — 상태가 오면 제시어 연출
      break;

    case 'ok': {
      drawSheet(m.word, true);
      const mine = m.by === me;
      beep(mine ? 'ok' : 'turn');
      el.by.innerHTML = `<b>${esc(nameById(m.by))}</b> <span class="pts">+${m.pts}</span>` +
        (m.chain > 1 ? ` · ${m.chain}번째 이음` : '');
      el.def.innerHTML = '';
      hideBad();
      const req = ++defReq;
      defOf(m.word).then(d => { if (req === defReq) el.def.innerHTML = defHtml(d); });
      requestAnimationFrame(() => popPts(m.by, m.pts));
      if (m.killer) showStamp('한방!', '', 1600);
      else if (m.mission) showStamp(`미션 ‘${m.mission}’`, 'gold', 1400);
      addSys(`${esc(nameById(m.by))} · <b>${esc(m.word)}</b> +${m.pts}`, 'ok', true);
      break;
    }

    case 'bad': {
      showBad(m);
      if (m.by === me) {
        beep('bad');
        // 친 말을 되돌려 고쳐 칠 수 있게
        if (!el.entry.value) { el.entry.value = restored = m.word; el.entry.select(); }
        el.entryForm.classList.remove('shake'); void el.entryForm.offsetWidth; el.entryForm.classList.add('shake');
      }
      break;
    }

    case 'fail': {
      beep('fail');
      // 내 차례가 끝났다 — 되돌려 둔 틀린 낱말이 그대로면 치운다 (Enter 한 번에 채팅으로 나가지 않게)
      if (m.by === me && restored && el.entry.value === restored) el.entry.value = '';
      restored = null;
      const who = nameById(m.by);
      showStamp(FAIL_STAMP[m.why] || '시간 초과', 'fail', 2400);
      el.by.innerHTML = `<b>${esc(who)}</b> <span class="pts">−${m.penalty}</span>`;
      el.def.innerHTML = m.hint ? `이런 말이 있었음 → <b>${esc(m.hint)}</b>` : '이을 말이 사전에 없었음';
      hideBad();
      requestAnimationFrame(() => popPts(m.by, -m.penalty));
      addSys(`${esc(who)} ${FAIL_LINE[m.why] || '시간 초과'} −${m.penalty}`, 'bad', true);
      break;
    }

    case 'end':
      showResult(m.ranking);
      break;

    case 'joined':
      addSys(`${esc(m.name)} 들어옴${m.watching ? ' (다음 판부터)' : ''}`);
      break;
    case 'left':
      addSys(`${esc(m.name)} 나감`);
      break;
    case 'host':
      addSys(`${esc(m.from)} → ${esc(m.name)} 방장 넘김`);
      if (m.to === me) toast('방장이 됐어요. 설정을 바꾸고 시작할 수 있어요.');
      break;
  }
}

function showResult(ranking) {
  el.ranking.innerHTML = ranking.map((r, i) => `
    <li><span class="rk">${i + 1}</span>
      <span><span class="nm">${esc(r.name)}${r.bot ? ' <small>봇</small>' : ''}</span><br>
      <span class="meta">낱말 ${r.words}개${r.best ? ` · 최고 ‘${esc(r.best.w)}’ ${r.best.pts}점` : ''}${r.longest && r.longest.length >= 4 ? ` · 가장 긴 말 ‘${esc(r.longest)}’` : ''}</span></span>
      <span class="sc">${r.score}</span></li>`).join('');
  const mine = ranking.findIndex(r => r.id === me);
  el.resultNote.textContent = mine === 0 ? '1등!' : mine > 0 ? `${mine + 1}등` : '';
  // 방장은 같은 설정으로 바로 한 판 더 (Enter 로도)
  el.btnAgain.hidden = !isHost();
  el.btnResultClose.textContent = isHost() ? '대기실로' : '확인';
  el.dlgResult.returnValue = '';               // Esc 로 닫으면 지난번 값이 남아 '한 판 더'가 눌린 셈이 되지 않게
  if (!el.dlgResult.open) el.dlgResult.showModal();
  (isHost() ? el.btnAgain : el.btnResultClose).focus();
}

/* ───────────── 시계 ───────────── */
let lastTickSec = null;
function frame() {
  requestAnimationFrame(frame);
  if (!S || !S.g || el.scGame.hidden) return;
  const g = S.g;
  const now = Date.now() + clockOffset;
  const timed = timedRoom();
  const total = S.cfg.roundTime * 1000 || 1;
  // 시간제한 없는 방: 라운드 막대는 없고, 차례 막대는 이을 말이 없거나 연결이 끊긴 차례에만(자동으로 넘어가기까지) 뜬다
  const turnClock = g.stage === 'turn' ? g.turnLimit > 0 : timed;
  el.roundBar.hidden = !timed;
  el.turnBar.hidden = !turnClock;
  el.timers.hidden = !timed && !turnClock;
  let roundLeft = g.roundLeft, turnLeft = g.turnLimit, turnTotal = g.turnLimit || 1;
  if (g.stage === 'turn') {
    const used = now - g.turnStart;
    roundLeft = Math.max(0, g.roundLeft - used);
    turnLeft = Math.max(0, g.turnLimit - used);
  } else if (g.stage !== 'fail') {
    turnLeft = turnTotal = 1;
  }
  el.roundFill.style.transform = `scaleX(${roundLeft / total})`;
  el.roundSec.textContent = (roundLeft / 1000).toFixed(0) + '초';
  el.turnFill.style.transform = `scaleX(${g.stage === 'turn' ? turnLeft / turnTotal : g.stage === 'fail' ? 0 : 1})`;
  el.turnSec.textContent = g.stage === 'turn' ? (turnLeft / 1000).toFixed(1) + '초' : '';
  const hurry = turnClock && g.stage === 'turn' && turnLeft < 3000;
  el.turnFill.parentNode.parentNode.classList.toggle('hurry', hurry);
  if (hurry && g.turnId === me) {
    const sec = Math.ceil(turnLeft / 1000);
    if (sec !== lastTickSec) { lastTickSec = sec; beep('tick'); }
  } else lastTickSec = null;
}
requestAnimationFrame(frame);

let titleT = null;
function flashTitle() {
  clearInterval(titleT);
  let on = false;
  titleT = setInterval(() => {
    if (!document.hidden) { clearInterval(titleT); document.title = '끝말잇기'; return; }
    on = !on; document.title = on ? '▶ 내 차례!' : '끝말잇기';
  }, 700);
}

/* ───────────── 입력 ───────────── */
/* 한글 입력기는 마지막 글자를 조합 중일 때 Enter 를 누르면, 조합이 끝나기 전에 keydown 이 온다.
   그때 입력칸을 비우면 조합 중이던 글자가 빈 칸에 다시 들어온다. 조합이 끝나기를 기다렸다가 보낸다.
   조합 끝 알림이 안 오는 입력기도 있어서, 잠깐 기다려도 안 오면 그냥 보낸다. */
function bindEnter(input, submit) {
  let waiting = false;
  const flush = () => { if (!waiting) return; waiting = false; submit(); };
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.isComposing || e.keyCode === 229) { waiting = true; setTimeout(flush, 60); return; }
    submit();
  });
  input.addEventListener('compositionend', () => { if (waiting) setTimeout(flush, 0); });
  input.form && input.form.addEventListener('submit', e => { e.preventDefault(); submit(); });
}

bindEnter(el.entry, () => {
  const text = el.entry.value.trim();
  if (!text) return;
  el.entry.value = '';
  send({ t: 'say', text });
});
for (const f of document.querySelectorAll('[data-chat]')) {
  const input = f.querySelector('input');
  bindEnter(input, () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    send({ t: 'say', text });
  });
}

function syncEntry() {
  const g = S && S.g;
  const p = meP();
  const playing = g && p && p.inGame;
  const myTurn = playing && (g.stage === 'turn' || g.stage === 'gap') && g.turnId === me;
  el.entryForm.classList.toggle('myturn', !!myTurn);
  el.board.classList.toggle('mine', !!(myTurn && g.stage === 'turn'));
  el.btnGiveup.hidden = !(myTurn && g.stage === 'turn');
  el.entryTag.textContent = myTurn ? '낱말' : '채팅';
  el.entry.placeholder = myTurn
    ? `${startsLabel(g.starts)} 시작하는 낱말${S.cfg.mode === 'kkt' ? ' (세 글자)' : ''}`
    : playing ? '내 차례가 아닐 때 친 말은 채팅' : S && S.phase === 'playing' ? '구경 중 — 채팅' : '채팅';
  if (myTurn && !el.scGame.hidden && document.activeElement !== el.entry && !el.dlgResult.open) el.entry.focus();
}

/* ───────────── 채팅 ───────────── */
/** 채팅은 대기실과 게임 두 곳에 같이 쌓는다. 낱말 기록(gameOnly)은 게임 쪽에만. */
function pushChat(html, cls, gameOnly) {
  for (const ul of gameOnly ? [el.chatGame] : [el.chatLobby, el.chatGame]) {
    const li = document.createElement('li');
    if (cls) li.className = cls;
    li.innerHTML = html;
    ul.appendChild(li);
    while (ul.children.length > 120) ul.firstChild.remove();
    ul.scrollTop = ul.scrollHeight;
  }
}
function addChat(name, text, mine) { pushChat(`<span class="who">${esc(name)}</span>${esc(text)}`, mine ? 'mine' : ''); }
function addSys(html, kind, gameOnly) { pushChat(html, 'sys ' + (kind || ''), gameOnly); }
function chatReset() { el.chatLobby.innerHTML = el.chatGame.innerHTML = ''; }

el.dlgResult.addEventListener('close', () => {
  if (el.dlgResult.returnValue === 'again' && isHost() && S.phase === 'lobby') { send({ t: 'start' }); return; }
  if (S && S.phase === 'lobby') show('scRoom');
});
el.btnGiveup.onclick = () => { send({ t: 'giveup' }); el.entry.focus(); };
// 판 아무 데나 누르면 입력칸으로 (단추 · 채팅 칸은 빼고)
el.scGame.addEventListener('click', e => {
  if (e.target.closest('button, input, a, .chat-box')) return;
  if (!getSelection().toString()) el.entry.focus();
});

/* ───────────── 시작 화면 ───────────── */
/* 낱말이 원고지 칸에 한 글자씩 이어지는 시연. 앞 낱말의 끝 글자(빨간 칸)에서 다음 낱말이 자란다. */
const DEMO = ['끝말', '말놀이', '이야기', '기차', '차례', '예술', '술래', '내일', '일기', '기억', '억새',
  '새벽', '벽돌', '돌잔치', '치약', '약속', '속담', '담력', '역사', '사과', '과자', '자두', '두부'];
let demoI = 0, demoT = null;
function demoStep() {
  const word = DEMO[demoI], prev = demoI ? DEMO[demoI - 1] : null;
  const carried = prev && prev[prev.length - 1] !== word[0];          // 두음 법칙으로 바뀐 글자
  el.demoSheet.classList.remove('out');
  el.demoSheet.innerHTML = [...word].map((c, i) =>
    `<span class="cell ${i === 0 && prev ? 'carry' : 'in'}" style="animation-delay:${i * 120}ms">${c}</span>`).join('');
  el.demoNote.innerHTML = prev
    ? `${prev} → <b>${word}</b>` + (carried ? `<span class="dueum">두음 법칙 ${prev[prev.length - 1]}→${word[0]}</span>` : '')
    : '&nbsp;';
  // 잠깐 뒤 끝 글자만 남기고 걷어 낸다
  demoT = setTimeout(() => {
    const cells = el.demoSheet.children;
    if (cells.length) cells[cells.length - 1].classList.add('last');
    el.demoSheet.classList.add('out');
    demoI = (demoI + 1) % DEMO.length;
    demoT = setTimeout(() => { if (!el.scTitle.hidden) demoStep(); else demoT = null; }, 420);
  }, 1500 + word.length * 120);
}
function showTitle() {
  show('scTitle');
  if (!demoT) demoStep();
  el.btnEnter.focus();
}
function enterMain() {
  show('scMain');
  if (!nameOf()) el.inName.focus();
}
el.btnEnter.onclick = enterMain;
el.btnHome.onclick = showTitle;
addEventListener('keydown', e => {
  if (el.scTitle.hidden || e.target.closest('input')) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterMain(); }
});

/* ───────────── 시작 ───────────── */
const hashCode = location.hash.replace('#', '').trim().toUpperCase();
if (saved()) {
  reconnect();
} else {
  // 초대 링크(#코드)로 왔으면 시작 화면을 건너뛴다
  if (/^[A-Z0-9]{4}$/.test(hashCode)) show('scMain'); else showTitle();
  connect(() => send({ t: 'rooms' }));
  if (/^[A-Z0-9]{4}$/.test(hashCode)) {
    el.inCode.value = hashCode;
    if (nameOf()) connect(() => send({ t: 'join', code: hashCode, name: nameOf() }));
    else { el.inName.focus(); toast(`방 ${hashCode} — 이름을 적고 ‘들어가기’를 누르세요`, 5000); }
  }
}
