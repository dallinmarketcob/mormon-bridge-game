// Rules tests: plays many random full games and checks scoring and secrecy.
// Run with: npm test
import assert from 'node:assert/strict';
import {
  roundList, resolveMaxCards, scoreFor, trickWinner, startGame, submitBid, fixDealerBid,
  playCard, dealRound, autoMove, legalCards, viewFor, DEFAULT_SETTINGS,
} from '../src/game.js';

assert.deepEqual(roundList(7, true), [7, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 7]);
assert.deepEqual(roundList(3, false), [3, 2, 1]);
assert.equal(resolveMaxCards('auto', 4), 7);
assert.equal(resolveMaxCards('auto', 8), 6);   // 8 x 7 = 56 cards: not enough, so 6
assert.equal(resolveMaxCards(13, 4), 13);
assert.equal(scoreFor(0, 0), 5);
assert.equal(scoreFor(1, 1), 10);
assert.equal(scoreFor(2, 2), 15);
assert.equal(scoreFor(2, 3), -5);
assert.equal(trickWinner([{ p: 'a', c: 'H14' }, { p: 'b', c: 'S2' }, { p: 'c', c: 'H10' }], 'S'), 'b');
assert.equal(trickWinner([{ p: 'a', c: 'H5' }, { p: 'b', c: 'D14' }, { p: 'c', c: 'H10' }], 'S'), 'c');
assert.equal(trickWinner([{ p: 'a', c: 'H5' }, { p: 'b', c: 'D14' }], null), 'a');

const lobby = (n, settings = {}) => ({
  code: 'TEST', hostId: 'u0', status: 'lobby', settings: { ...DEFAULT_SETTINGS, ...settings },
  players: Array.from({ length: n }, (_, i) => ({ id: 'u' + i, name: 'P' + i })),
});

// Secret bids: nobody else's bid is visible until all are in.
{
  let s = startGame(lobby(3));
  s = submitBid(s, 'u1', 2);
  const v0 = viewFor(s, 'u0', {});
  assert.deepEqual(v0.bids, {});
  assert.equal(v0.bidIn.u1, true);
  assert.deepEqual(viewFor(s, 'u1', {}).bids, { u1: 2 });
  assert.equal(v0.hand.length, 7);
  assert.equal(v0.hands, undefined, 'other hands never sent');
  s = submitBid(s, 'u1', 1); // can change before the last bid
  s = submitBid(s, 'u0', 0);
  s = submitBid(s, 'u2', 3);
  assert.equal(s.status, 'playing');
  assert.deepEqual(viewFor(s, 'u0', {}).bids, { u0: 0, u1: 1, u2: 3 });
  assert.throws(() => submitBid(s, 'u0', 1), /Bidding is over/);
}

// Dealer fix: bids add up to the tricks, so the dealer must move by one.
{
  let s = startGame(lobby(3, { dealerFix: true, maxCards: 3 }));
  s = submitBid(s, 'u0', 1); s = submitBid(s, 'u1', 1); s = submitBid(s, 'u2', 1);
  assert.equal(s.status, 'dealerFix');
  assert.throws(() => fixDealerBid(s, 'u1', 2), /Only the dealer/);
  assert.throws(() => fixDealerBid(s, 'u0', 3), /by one/);
  s = fixDealerBid(s, 'u0', 0);
  assert.equal(s.status, 'playing');
}

// Can't lead trump until it's broken, unless trump is all you have.
assert.deepEqual(legalCards(['H5', 'S9', 'H14'], [], 'H', false), ['S9']);
assert.deepEqual(legalCards(['H5', 'H14'], [], 'H', false), ['H5', 'H14']);
assert.deepEqual(legalCards(['H5', 'S9'], [], 'H', true), ['H5', 'S9']);
assert.deepEqual(legalCards(['H5', 'D9'], [{ p: 'x', c: 'S4' }], 'H', false), ['H5', 'D9'], 'may trump in when void');
{
  // Hand-built state: u0 leads with only a trump and a spade; trump not broken yet.
  let s = startGame(lobby(2, { maxCards: 2 }));
  const lead = s.seats[s.leader], other = s.seats.find(u => u !== lead);
  const t = s.trump;
  const off = ['S', 'C', 'D', 'H'].find(x => x !== t);
  const off2 = ['S', 'C', 'D', 'H'].find(x => x !== t && x !== off);
  s.hands[lead] = [t + '14', off + '2'];
  s.hands[other] = [off2 + '5', t + '3'];
  s = submitBid(s, lead, 1); s = submitBid(s, other, 1);
  assert.throws(() => playCard(s, lead, t + '14'), /can’t lead one/);
  s = playCard(s, lead, off + '2');
  s = playCard(s, other, t + '3'); // void in the led suit, trumps in: trump is broken
  assert.equal(s.trumpBroken, true);
  s = playCard(s, other, off2 + '5') ; // winner leads again
  s = playCard(s, lead, t + '14');
  assert.equal(s.status === 'roundEnd' || s.status === 'gameOver', true);
}

// Random full games, 2 to 10 players, with and without the dealer rule.
for (const n of [2, 3, 4, 5, 7, 10]) for (const dealerFix of [false, true]) {
  let s = startGame(lobby(n, { dealerFix }));
  let moves = 0;
  while (s.status !== 'gameOver') {
    if (s.status === 'bidding') {
      for (const u of s.seats) s = s.status === 'bidding' ? submitBid(s, u, Math.floor(Math.random() * (s.rounds[s.roundIdx] + 1))) : s;
    } else if (s.status === 'dealerFix') s = autoMove(s, s.seats[s.dealer]);
    else if (s.status === 'playing') {
      const u = s.seats[s.turn];
      const L = legalCards(s.hands[u], s.trick, s.trump, s.trumpBroken);
      if (Math.random() < .2) s = autoMove(s, u);
      else s = playCard(s, u, L[Math.floor(Math.random() * L.length)]);
    } else if (s.status === 'roundEnd') {
      const h = s.history.at(-1);
      assert.equal(Object.values(h.results).reduce((a, r) => a + r.won, 0), h.cards, 'every trick counted');
      if (dealerFix) assert.notEqual(Object.values(h.results).reduce((a, r) => a + r.bid, 0), h.cards);
      s = dealRound(s, s.roundIdx + 1);
    }
    if (++moves > 100000) throw new Error('game did not finish');
  }
  assert.equal(s.history.length, s.rounds.length);
  for (const u of s.seats) assert.equal(s.scores[u], s.history.reduce((a, h) => a + h.results[u].pts, 0));
  assert.equal(s.rounds[0], resolveMaxCards('auto', n));
}

console.log('All rules tests passed.');
