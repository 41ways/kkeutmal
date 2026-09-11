'use strict';
/**
 * 떠 있는 서버에 붙어서 한 판의 뼈대를 확인한다 — 어느 서버든 주소만 주면 된다.
 *   node test/smoke.js http://localhost:8820                 (node server.js)
 *   node test/smoke.js https://kkeutmal.41ways.workers.dev   (배포본)
 * 화면 · 뜻풀이 조각 · 방 목록 · 방 만들기 · 들어가기 · 채팅 · 시작 · 낱말 한 번 · 틀린 낱말 · 새로고침(resume).
 */
const assert = require('assert');
const WebSocket = require('ws');

const BASE = (process.argv[2] || 'http://localhost:8820').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.inbox = [];
    ws.on('message', raw => ws.inbox.push(JSON.parse(raw)));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
const tx = (ws, obj) => ws.send(JSON.stringify(obj));
async function waitFor(ws, pred, ms = 6000, what = '') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (let i = ws.inbox.length - 1; i >= 0; i--) if (pred(ws.inbox[i])) return ws.inbox[i];
    await sleep(25);
  }
  throw new Error('기다리던 메시지가 오지 않음 ' + what + ': ' + JSON.stringify(ws.inbox.slice(-2)).slice(0, 300));
}

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

(async () => {
  console.log('끝말잇기 연결 확인 → ' + BASE);
  let a, b, code, welcomeB;

  await check('화면 파일 · 뜻풀이 조각이 나온다', async () => {
    const html = await fetch(BASE + '/').then(r => r.text());
    assert.ok(html.includes('끝말잇기'), 'index.html 이 아님');
    assert.strictEqual((await fetch(BASE + '/style.css')).status, 200);
    const shard = await fetch(BASE + '/dict/' + '사'.charCodeAt(0).toString(16) + '.json').then(r => r.json());
    assert.ok(shard['사과'], '사과 뜻풀이가 없음');
  });

  await check('상태 확인', async () => {
    const h = await fetch(BASE + '/healthz').then(r => r.json());
    assert.strictEqual(h.ok, true);
  });

  await check('방 목록 · 방 만들기 · 들어가기', async () => {
    a = await open();
    tx(a, { t: 'rooms' });
    await waitFor(a, m => m.t === 'rooms', 8000, '방 목록');
    tx(a, { t: 'create', name: '시험A', title: '연결 시험', priv: true });
    code = (await waitFor(a, m => m.t === 'welcome', 6000, 'welcome A')).code;
    b = await open();
    tx(b, { t: 'join', code, name: '시험B' });
    welcomeB = await waitFor(b, m => m.t === 'welcome', 6000, 'welcome B');
    await waitFor(a, m => m.t === 'state' && m.players.length === 2, 6000, '둘이 된 상태');
  });

  await check('채팅', async () => {
    tx(b, { t: 'say', text: '안녕하세요' });
    await waitFor(a, m => m.t === 'chat' && m.text === '안녕하세요', 6000, '채팅');
  });

  let g;
  await check('시작 → 첫 차례', async () => {
    tx(a, { t: 'start' });
    g = (await waitFor(a, m => m.t === 'state' && m.g && m.g.stage === 'turn', 8000, '첫 차례')).g;
  });

  await check('틀린 낱말은 이유와 함께', async () => {
    const s = g.turnId === 1 ? a : b;
    tx(s, { t: 'say', text: g.starts[0] + '뷁뷁' });
    await waitFor(a, m => m.t === 'ev' && m.kind === 'bad' && m.why === 'nodict', 6000, '틀림');
  });

  await check('맞는 낱말 → 점수 · 다음 차례', async () => {
    const s = g.turnId === 1 ? a : b;
    let word = null;
    for (const c of g.starts) {
      const shard = await fetch(BASE + '/dict/' + c.charCodeAt(0).toString(16) + '.json').then(r => r.json());
      word = Object.keys(shard).find(w => w.length === 2 || w.length === 3);
      if (word) break;
    }
    assert.ok(word, '시작 글자로 된 낱말을 못 찾음');
    await sleep(150);
    tx(s, { t: 'say', text: word });
    const ok = await waitFor(a, m => m.t === 'ev' && m.kind === 'ok', 6000, '받아들여짐');
    assert.strictEqual(ok.word, word);
    assert.ok(ok.pts > 0);
  });

  await check('새로고침(resume)하면 같은 자리로', async () => {
    b.close();
    const b2 = await open();
    tx(b2, { t: 'resume', code, token: welcomeB.token });
    const w = await waitFor(b2, m => m.t === 'welcome', 6000, 'resume');
    assert.strictEqual(w.you, welcomeB.you);
    b = b2;
  });

  await check('나가면 방이 치워진다', async () => {
    tx(a, { t: 'leave' }); tx(b, { t: 'leave' });
    await sleep(300);
    const w = await open();
    tx(w, { t: 'join', code, name: 'x' });
    await waitFor(w, m => m.t === 'err', 6000, '없는 방');
    w.close();
  });

  a.close(); b.close();
  console.log(`\n${pass}개 통과 · ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})();
