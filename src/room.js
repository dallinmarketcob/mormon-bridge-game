// One Durable Object per game code. Holds the full game (hands included) and
// sends each connected phone only what that player is allowed to see.
import { DurableObject } from 'cloudflare:workers';
import {
  DEFAULT_SETTINGS, RuleError, startGame, dealRound, submitBid, fixDealerBid,
  playCard, autoMove, viewFor,
} from './game.js';

const IDLE_CLEANUP_MS = 7 * 24 * 60 * 60 * 1000; // forget games untouched for a week

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('state')) || null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      if (this.state) return new Response('taken', { status: 409 });
      const code = await request.text();
      this.state = {
        code, hostId: null, status: 'lobby', created: Date.now(),
        settings: { ...DEFAULT_SETTINGS }, players: [],
      };
      await this.save();
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const pid = request.headers.get('X-Pid');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid });
    if (!this.state) {
      server.send(JSON.stringify({ type: 'error', code: 'not_found', message: 'No game with that code.' }));
      server.close(4404, 'not found');
    } else {
      this.broadcast();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  connectedIds() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.pid) ids.add(a.pid);
    }
    return ids;
  }

  broadcast() {
    if (!this.state) return;
    const online = this.connectedIds();
    const connected = Object.fromEntries([...online].map(id => [id, true]));
    for (const ws of this.ctx.getWebSockets()) {
      const { pid } = ws.deserializeAttachment() || {};
      try { ws.send(JSON.stringify({ type: 'state', view: viewFor(this.state, pid, connected) })); } catch {}
    }
  }

  async save() {
    await this.ctx.storage.put('state', this.state);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
    this.state = null;
  }

  async webSocketMessage(ws, raw) {
    const { pid } = ws.deserializeAttachment() || {};
    if (!pid || !this.state || typeof raw !== 'string' || raw.length > 2000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      const next = this.handle(pid, msg);
      if (next) { this.state = next; await this.save(); }
      this.broadcast();
    } catch (e) {
      const message = e instanceof RuleError ? e.message : 'Something went wrong with that move. Try again.';
      if (!(e instanceof RuleError)) console.error(e);
      ws.send(JSON.stringify({ type: 'error', message }));
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch {}
    this.broadcast();
  }

  async webSocketError() { this.broadcast(); }

  // Returns the new state, or null when nothing needs saving.
  handle(pid, msg) {
    const s = this.state;
    const online = this.connectedIds();
    const seated = s.seats ? s.seats.includes(pid) : false;
    // The host runs the lobby. If the host's phone is gone, anyone can step in.
    const actsAsHost = pid === s.hostId || !online.has(s.hostId);
    const need = (ok, message) => { if (!ok) throw new RuleError(message); };

    switch (msg.type) {
      case 'hello':
        return null;

      case 'join': {
        const name = String(msg.name || '').trim().slice(0, 16);
        need(name, 'Type your name first.');
        const n = structuredClone(s);
        const existing = n.players.find(p => p.id === pid);
        if (existing) existing.name = name;
        else {
          need(n.status === 'lobby', 'This game already started. You can watch, and join the next one.');
          need(n.players.length < 10, 'This table is full (10 players).');
          n.players.push({ id: pid, name, joinedAt: Date.now() });
        }
        if (n.names && n.names[pid]) n.names[pid] = name;
        if (!n.hostId) n.hostId = pid;
        return n;
      }

      case 'leave': {
        need(s.status === 'lobby', 'You can only leave the table before the game starts.');
        const n = structuredClone(s);
        n.players = n.players.filter(p => p.id !== pid);
        if (n.hostId === pid) n.hostId = n.players[0]?.id || null;
        return n;
      }

      case 'kick': {
        need(s.status === 'lobby', 'Players can only be removed before the game starts.');
        need(actsAsHost, 'Only the host can remove players.');
        const n = structuredClone(s);
        n.players = n.players.filter(p => p.id !== msg.pid);
        if (n.hostId === msg.pid) n.hostId = pid;
        return n;
      }

      case 'settings': {
        need(s.status === 'lobby', 'Settings are locked once the game starts.');
        need(actsAsHost, 'Only the host can change settings.');
        const n = structuredClone(s);
        const p = msg.patch || {};
        // Clamped to what the table can actually deal when the game starts.
        if ('maxCards' in p) n.settings.maxCards = p.maxCards === 'auto' ? 'auto' : Math.max(1, Math.min(26, parseInt(p.maxCards, 10) || 1));
        if ('backUp' in p) n.settings.backUp = !!p.backUp;
        if ('dealerFix' in p) n.settings.dealerFix = !!p.dealerFix;
        return n;
      }

      case 'start': {
        need(s.status === 'lobby', 'The game already started.');
        need(actsAsHost, 'Only the host can deal.');
        const n = startGame(s);
        // If the host's phone is gone, whoever pressed Deal becomes the host.
        if (!online.has(s.hostId) && n.players.some(p => p.id === pid)) n.hostId = pid;
        return n;
      }

      case 'bid':
        return submitBid(s, pid, msg.bid);

      case 'fix':
        return fixDealerBid(s, pid, msg.bid);

      case 'play':
        return playCard(s, pid, String(msg.card || ''));

      case 'next': {
        need(s.status === 'roundEnd', 'The round isn’t over yet.');
        need(seated, 'Only players can deal.');
        return dealRound(s, s.roundIdx + 1);
      }

      case 'auto': {
        need(seated, 'Only players can do that.');
        need(s.seats.includes(msg.pid), 'That player isn’t in this game.');
        need(!online.has(msg.pid), 'That player is still here. Give them a moment.');
        return autoMove(s, msg.pid);
      }

      case 'end': {
        need(s.status !== 'lobby', 'The game hasn’t started.');
        need(actsAsHost, 'Only the host can end the game.');
        return {
          code: s.code, hostId: s.hostId, status: 'lobby', created: s.created,
          settings: s.settings, players: s.players,
        };
      }

      default:
        return null;
    }
  }
}
