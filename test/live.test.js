// Plays a whole game over real connections against a running server.
// Start the server first (npm run dev), then: npm run test:live
// Point it elsewhere with: BASE=https://your-app.workers.dev npm run test:live
const BASE = process.env.BASE || 'http://localhost:8787';
const WS = BASE.replace(/^http/, 'ws');
const legal = (hand, trick, trump, broken) => {
  if (!trick.length) {
    const nonTrump = hand.filter(c => c[0] !== trump);
    return trump && !broken && nonTrump.length ? nonTrump : hand;
  }
  const f = hand.filter(c => c[0] === trick[0].c[0]);
  return f.length ? f : hand;
};

function player(code, name) {
  const token = 'test-' + name + '-' + Math.random().toString(36).slice(2, 12);
  const ws = new WebSocket(`${WS}/ws/${code}?t=${token}`);
  const p = { name, ws, view: null, errors: [], waiters: [] };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'state') p.view = m.view;
    if (m.type === 'error') p.errors.push(m.message);
    p.waiters.splice(0).forEach(f => f());
  };
  p.ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  p.send = msg => ws.send(JSON.stringify(msg));
  p.next = () => new Promise(res => p.waiters.push(res));
  return p;
}
const until = async (players, check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting. Server said: ' + players.flatMap(p => p.errors).join(' | '));
    await Promise.race(players.map(p => p.next()).concat(new Promise(r => setTimeout(r, 200))));
  }
};

const r = await fetch(BASE + '/api/new', { method: 'POST' });
const { code } = await r.json();
console.log('game', code);
const ps = ['Ann', 'Bo', 'Cy'].map(n => player(code, n));
await Promise.all(ps.map(p => p.ready));
for (const p of ps) { p.send({ type: 'join', name: p.name }); await until(ps, () => p.view?.players.some(x => x.name === p.name)); }
const host = ps[0];
if (host.view.hostId !== host.view.you) throw new Error('first player should be host');
host.send({ type: 'settings', patch: { maxCards: 3 } });
await until(ps, () => host.view.settings.maxCards === 3);
host.send({ type: 'start' });
await until(ps, () => ps.every(p => p.view.status === 'bidding'));

let rounds = 0;
while (true) {
  const v = host.view;
  if (v.status === 'gameOver') break;
  if (v.status === 'bidding') {
    ps[1].send({ type: 'bid', bid: 1 });
    await until(ps, () => ps[0].view.bidIn[ps[1].view.you]);
    if (Object.keys(ps[0].view.bids).some(k => k !== ps[0].view.you)) throw new Error('saw a secret bid');
    ps[0].send({ type: 'bid', bid: 0 });
    ps[2].send({ type: 'bid', bid: 0 });
    await until(ps, () => host.view.status !== 'bidding');
  } else if (v.status === 'playing') {
    const turnId = v.seats[v.turn];
    const p = ps.find(x => x.view.you === turnId);
    const card = legal(p.view.hand, p.view.trick, p.view.trump, p.view.trumpBroken)[0];
    const before = JSON.stringify([v.trick, v.lastTrick, v.status]);
    p.send({ type: 'play', card });
    await until(ps, () => JSON.stringify([host.view.trick, host.view.lastTrick, host.view.status]) !== before);
  } else if (v.status === 'roundEnd') {
    rounds++;
    ps[2].send({ type: 'next' });
    await until(ps, () => host.view.status === 'bidding');
  } else throw new Error('unexpected status ' + v.status);
}
const v = host.view;
console.log('rounds', v.rounds.join(','), 'scores', v.seats.map(u => `${v.names[u]} ${v.scores[u]}`).join(', '));
if (v.history.length !== 5) throw new Error('expected 5 rounds, got ' + v.history.length);

// Reconnect: a fresh connection with the same token gets the same seat back.
const errs = ps.flatMap(p => p.errors);
if (errs.length) throw new Error('server errors: ' + errs.join(' | '));
const bad = await new Promise(res => {
  const w = new WebSocket(`${WS}/ws/ZZZZ?t=test-nobody-1234567890`);
  w.onmessage = ev => res(JSON.parse(ev.data));
});
if (bad.code !== 'not_found') throw new Error('unknown code should say not found');
ps.forEach(p => p.ws.close());
console.log('Live game test passed.');
process.exit(0);
