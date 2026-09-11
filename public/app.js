'use strict';
/* 끝말잇기 — 화면. 판정은 전부 서버가 하고, 여기는 보여 주고 친 것을 보낸다. */

const $ = s => document.querySelector(s);
const el = {
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
  board: $('#board'), sheet: $('#sheet'), by: $('#by'), def: $('#def'), attempt: $('#attempt'), stamp: $('#stamp'),
  chain: $('#chain'), players: $('#players'),
  entryForm: $('#entryForm'), entry: $('#entry'), entryTag: $('#entryTag'),
  dlgResult: $('#dlgResult'), ranking: $('#ranking'), resultNote: $('#resultNote'),
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
};

let toastT = null;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function show(which) {
  for (const k of ['scMain', 'scRoom', 'scGame']) el[k].hidden = k !== which;
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
    slots.push(`<li class="${cls}"><span class="badge">${badge}</span>${x}
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
  el.roundNo.textContent = `${g.round} / ${g.rounds} 라운드`;
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
  if (g.stage === 'intro') drawIntro();
  else if (sheetWord === null || sheetWord !== (g.lastWord || '')) drawSheet(g.lastWord, false);
  else drawNext();

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

/** 원고지 칸에 낱말을 앉히고, 이어 칠 글자를 점선 칸으로 */
function drawSheet(word, animate) {
  sheetWord = word || '';
  const cells = [...(word || '')].map((c, i) =>
    `<span class="cell ${animate ? 'in' : ''} ${i === word.length - 1 ? 'tail' : ''}" style="animation-delay:${i * 45}ms">${esc(c)}</span>`);
  // 방금 받아들여진 낱말이면 이어 칠 글자는 뒤따라 오는 상태가 채운다 (지금 S 는 아직 앞 차례의 것)
  el.sheet.innerHTML = cells.join('') + (animate ? '' : nextCell());
  el.sheet.style.setProperty('--n', Math.max(4, (word || '').length + 2));
  if (!word) { el.by.innerHTML = ''; el.def.innerHTML = ''; }
}
function nextCell() {
  const g = S && S.g;
  if (!g || !g.starts || !g.starts.length || g.stage === 'intro') return '';
  const alt = g.starts[1] ? `<small>또는 ‘${esc(g.starts[1])}’</small>` : '';
  return `<span class="cell next">${esc(g.starts[0])}${alt}</span>`;
}
function drawNext() {
  const old = el.sheet.querySelector('.cell.next');
  const html = nextCell();
  if (old) old.outerHTML = html || '';
  else if (html) el.sheet.insertAdjacentHTML('beforeend', html);
}
function drawIntro() {
  const g = S.g;
  sheetWord = null;
  el.sheet.innerHTML = '';
  el.sheet.style.setProperty('--n', 4);
  el.sheet.innerHTML = `<div class="intro"><span class="lbl">${g.round}라운드</span>
    <div style="display:flex"><span class="cell in">${esc(g.roundWord[g.round - 1])}</span></div></div>`;
  el.by.innerHTML = `<b>${esc(nameById(g.turnId))}</b>부터 시작`;
  el.def.innerHTML = '';
  el.attempt.textContent = '';
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
function onEvent(m) {
  switch (m.kind) {
    case 'round':
      beep('round');
      el.attempt.textContent = '';
      break;

    case 'ok': {
      drawSheet(m.word, true);
      const mine = m.by === me;
      beep(mine ? 'ok' : 'turn');
      el.by.innerHTML = `<b>${esc(nameById(m.by))}</b> <span class="pts">+${m.pts}</span>` +
        (m.chain > 1 ? ` · ${m.chain}번째 이음` : '');
      el.def.innerHTML = '';
      el.attempt.textContent = '';
      const req = ++defReq;
      defOf(m.word).then(d => { if (req === defReq) el.def.innerHTML = defHtml(d); });
      requestAnimationFrame(() => popPts(m.by, m.pts));
      if (m.killer) showStamp('한방!', '', 1600);
      else if (m.mission) showStamp(`미션 ‘${m.mission}’`, 'gold', 1400);
      addSys(`${esc(nameById(m.by))} · <b>${esc(m.word)}</b> +${m.pts}`, 'ok', true);
      break;
    }

    case 'bad': {
      el.attempt.textContent = `✗ ${m.word} — ${WHY[m.why] || '안 됨'}`;
      el.attempt.classList.remove('shake'); void el.attempt.offsetWidth; el.attempt.classList.add('shake');
      if (m.by === me) {
        beep('bad');
        // 친 말을 되돌려 고쳐 칠 수 있게
        if (!el.entry.value) { el.entry.value = m.word; el.entry.select(); }
        el.entryForm.classList.remove('shake'); void el.entryForm.offsetWidth; el.entryForm.classList.add('shake');
      }
      break;
    }

    case 'fail': {
      beep('fail');
      const who = nameById(m.by);
      showStamp(m.why === 'round' ? '라운드 끝' : '시간 초과', 'fail', 2400);
      el.by.innerHTML = `<b>${esc(who)}</b> <span class="pts">−${m.penalty}</span>`;
      el.def.innerHTML = m.hint ? `이런 말이 있었음 → <b>${esc(m.hint)}</b>` : '이을 말이 사전에 없었음';
      el.attempt.textContent = '';
      requestAnimationFrame(() => popPts(m.by, -m.penalty));
      drawNext();
      addSys(`${esc(who)} ${m.why === 'round' ? '라운드 시간' : '차례 시간'} 초과 −${m.penalty}`, 'bad', true);
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
  if (!el.dlgResult.open) el.dlgResult.showModal();
}

/* ───────────── 시계 ───────────── */
let lastTickSec = null;
function frame() {
  requestAnimationFrame(frame);
  if (!S || !S.g || el.scGame.hidden) return;
  const g = S.g;
  const now = Date.now() + clockOffset;
  const total = S.cfg.roundTime * 1000;
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
  const hurry = g.stage === 'turn' && turnLeft < 3000;
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

el.dlgResult.addEventListener('close', () => { if (S && S.phase === 'lobby') show('scRoom'); });
// 판 아무 데나 누르면 입력칸으로 (단추 · 채팅 칸은 빼고)
el.scGame.addEventListener('click', e => {
  if (e.target.closest('button, input, a, .chat-box')) return;
  if (!getSelection().toString()) el.entry.focus();
});

/* ───────────── 시작 ───────────── */
const hashCode = location.hash.replace('#', '').trim().toUpperCase();
if (saved()) {
  reconnect();
} else {
  show('scMain');
  connect(() => send({ t: 'rooms' }));
  if (/^[A-Z0-9]{4}$/.test(hashCode)) {
    el.inCode.value = hashCode;
    if (nameOf()) connect(() => send({ t: 'join', code: hashCode, name: nameOf() }));
    else { el.inName.focus(); toast(`방 ${hashCode} — 이름을 적고 ‘들어가기’를 누르세요`, 5000); }
  }
}
