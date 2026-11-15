// Mormon Bridge rules. Pure functions: each takes a state and returns a new one.
// Used by the server (src/room.js) and the tests (test/game.test.js).

export const SUITS = ['S', 'H', 'D', 'C'];
export const suitOf = c => c[0];
export const rankOf = c => parseInt(c.slice(1), 10);

export const DEFAULT_SETTINGS = {
  maxCards: 'auto', // top hand size; 'auto' = 7, or fewer if there aren't enough cards
  backUp: true,     // after the 1-card round, go back up to the top
  dealerFix: false, // if the secret bids add up to the tricks, the dealer must change by one
};

export function newDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push(s + r);
  return d;
}

export function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function secureRandom() {
  const u = new Uint32Array(1);
  crypto.getRandomValues(u);
  return u[0] / 4294967296;
}

// Top hand size. Leaves one card over for trump when possible.
export function resolveMaxCards(setting, n) {
  const withTrump = Math.max(1, Math.floor(51 / n));
  if (setting === 'auto' || setting == null) return Math.min(7, withTrump);
  return Math.max(1, Math.min(Math.floor(52 / n), parseInt(setting, 10) || 1));
}

// Start at the top, go down to 1, then (optionally) back up: 7,6,...,1,2,...,7
export function roundList(max, backUp) {
  const r = [];
  for (let i = max; i >= 1; i--) r.push(i);
  if (backUp) for (let i = 2; i <= max; i++) r.push(i);
  return r;
}

// Family scoring: make your bid exactly = 5 + 5 per trick bid. Miss = -5.
export const scoreFor = (bid, won) => (bid === won ? 5 + 5 * bid : -5);

// House rule: you can't LEAD trump until a trump has been played earlier this round
// ("trump is broken"), unless trump is all you have left.
export function legalCards(hand, trick, trump = null, trumpBroken = true) {
  if (!trick.length) {
    if (trump && !trumpBroken) {
      const nonTrump = hand.filter(c => suitOf(c) !== trump);
      if (nonTrump.length) return nonTrump;
    }
    return hand.slice();
  }
  const led = suitOf(trick[0].c);
  const follow = hand.filter(c => suitOf(c) === led);
  return follow.length ? follow : hand.slice();
}

function beats(a, b, trump) {
  if (suitOf(a) === suitOf(b)) return rankOf(a) > rankOf(b);
  return trump != null && suitOf(a) === trump;
}

export function trickWinner(trick, trump) {
  let best = trick[0];
  for (const p of trick.slice(1)) if (beats(p.c, best.c, trump)) best = p;
  return best.p;
}

class RuleError extends Error {}
export { RuleError };
const fail = msg => { throw new RuleError(msg); };

export function startGame(lobby, rnd = secureRandom) {
  const players = lobby.players;
  if (players.length < 2) fail('You need at least 2 players to start.');
  if (players.length > 10) fail('Mormon Bridge works with up to 10 players.');
  const seats = players.map(p => p.id);
  const names = Object.fromEntries(players.map(p => [p.id, p.name]));
  const max = resolveMaxCards(lobby.settings.maxCards, seats.length);
  const s = {
    ...structuredClone(lobby),
    seats, names,
    rounds: roundList(max, lobby.settings.backUp),
    scores: Object.fromEntries(seats.map(u => [u, 0])),
    history: [],
  };
  return dealRound(s, 0, rnd);
}

export function dealRound(prev, roundIdx, rnd = secureRandom) {
  const s = structuredClone(prev);
  const n = s.seats.length;
  const cards = s.rounds[roundIdx];
  const deck = shuffle(newDeck(), rnd);
  s.roundIdx = roundIdx;
  s.dealer = roundIdx % n;
  s.hands = {}; s.bids = {}; s.tricksWon = {};
  s.seats.forEach(u => { s.hands[u] = []; s.tricksWon[u] = 0; });
  for (let k = 0; k < cards; k++)
    for (let i = 0; i < n; i++) s.hands[s.seats[(s.dealer + 1 + i) % n]].push(deck[k * n + i]);
  const flip = deck[cards * n];
  s.trumpCard = flip || null;
  s.trump = flip ? suitOf(flip) : null;
  s.leader = (s.dealer + 1) % n;
  s.turn = null; // everyone bids at once
  s.trick = [];
  s.lastTrick = null;
  s.trumpBroken = false;
  s.status = 'bidding';
  return s;
}

const bidSum = s => s.seats.reduce((t, u) => t + s.bids[u], 0);

// Secret bidding: anyone can bid (or change their bid) until the last bid is in.
export function submitBid(prev, pid, bid) {
  const s = structuredClone(prev);
  if (s.status !== 'bidding') fail('Bidding is over for this round.');
  if (!s.seats.includes(pid)) fail('You aren’t playing in this game.');
  const cards = s.rounds[s.roundIdx];
  if (!Number.isInteger(bid) || bid < 0 || bid > cards) fail('That bid is out of range.');
  s.bids[pid] = bid;
  if (s.seats.every(u => s.bids[u] != null)) {
    if (s.settings.dealerFix && bidSum(s) === cards) s.status = 'dealerFix';
    else { s.status = 'playing'; s.turn = s.leader; }
  }
  return s;
}

// Dealer-fix rule: the dealer moves their bid up or down by one.
export function fixDealerBid(prev, pid, bid) {
  const s = structuredClone(prev);
  if (s.status !== 'dealerFix') fail('There’s nothing to fix right now.');
  const dealerId = s.seats[s.dealer];
  if (pid !== dealerId) fail('Only the dealer changes their bid.');
  const cards = s.rounds[s.roundIdx];
  const old = s.bids[pid];
  if (!(bid === old + 1 || bid === old - 1) || bid < 0 || bid > cards) fail('Change your bid by one, up or down.');
  s.bids[pid] = bid;
  s.status = 'playing';
  s.turn = s.leader;
  return s;
}

export function playCard(prev, pid, c) {
  const s = structuredClone(prev);
  if (s.status !== 'playing' || s.seats[s.turn] !== pid) fail('It isn’t your turn.');
  const hand = s.hands[pid];
  if (!hand.includes(c)) fail('That card isn’t in your hand.');
  if (!legalCards(hand, s.trick, s.trump, s.trumpBroken).includes(c)) {
    fail(s.trick.length ? 'You have to follow the suit that was led.' : 'Nobody has played a trump yet, so you can’t lead one.');
  }
  s.hands[pid] = hand.filter(x => x !== c);
  s.trick.push({ p: pid, c });
  if (s.trump && suitOf(c) === s.trump) s.trumpBroken = true;
  const n = s.seats.length;
  if (s.trick.length < n) { s.turn = (s.turn + 1) % n; return s; }

  const w = trickWinner(s.trick, s.trump);
  s.tricksWon[w] += 1;
  const cards = s.rounds[s.roundIdx];
  s.lastTrick = { plays: s.trick, winner: w, no: cards - s.hands[pid].length };
  s.trick = [];
  s.leader = s.turn = s.seats.indexOf(w);

  if (s.seats.every(u => s.hands[u].length === 0)) {
    const results = {};
    for (const u of s.seats) {
      const pts = scoreFor(s.bids[u], s.tricksWon[u]);
      results[u] = { bid: s.bids[u], won: s.tricksWon[u], pts };
      s.scores[u] += pts;
    }
    s.history.push({ cards, trump: s.trump, dealer: s.seats[s.dealer], results });
    s.status = s.roundIdx >= s.rounds.length - 1 ? 'gameOver' : 'roundEnd';
    s.turn = null;
  }
  return s;
}

// Make the move for a player who dropped out: bid 0, or play their lowest legal card.
export function autoMove(prev, pid) {
  const s = prev;
  if (s.status === 'bidding' && s.bids[pid] == null) return submitBid(s, pid, 0);
  if (s.status === 'dealerFix' && s.seats[s.dealer] === pid) {
    const old = s.bids[pid], cards = s.rounds[s.roundIdx];
    return fixDealerBid(s, pid, old + 1 <= cards ? old + 1 : old - 1);
  }
  if (s.status === 'playing' && s.seats[s.turn] === pid) {
    const legal = legalCards(s.hands[pid], s.trick, s.trump, s.trumpBroken).sort((a, b) => rankOf(a) - rankOf(b));
    return playCard(s, pid, legal[0]);
  }
  fail('That player doesn’t have a move to make.');
}

// What one player is allowed to see.
export function viewFor(s, pid, connected) {
  const v = {
    code: s.code, hostId: s.hostId, status: s.status, settings: s.settings,
    you: pid, connected,
    players: s.players.map(p => ({ id: p.id, name: p.name })),
  };
  if (s.status === 'lobby') return v;
  const hidden = s.status === 'bidding';
  Object.assign(v, {
    seats: s.seats, names: s.names, rounds: s.rounds, roundIdx: s.roundIdx,
    dealer: s.dealer, trumpCard: s.trumpCard, trump: s.trump, trumpBroken: !!s.trumpBroken, leader: s.leader, turn: s.turn,
    trick: s.trick, lastTrick: s.lastTrick, tricksWon: s.tricksWon, scores: s.scores, history: s.history,
    hand: s.hands?.[pid] || null,
    handCounts: Object.fromEntries(s.seats.map(u => [u, s.hands[u].length])),
    bidIn: Object.fromEntries(s.seats.map(u => [u, s.bids[u] != null])),
    bids: hidden ? (s.bids[pid] != null ? { [pid]: s.bids[pid] } : {}) : s.bids,
  });
  return v;
}
