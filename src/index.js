// Worker entry: creates games and routes each phone's live connection to its game room.
// Everything else (the page itself) is served from /public.
export { GameRoom } from './room.js';

const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O: easy to read aloud

function randomCode() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map(x => LETTERS[x % LETTERS.length]).join('');
}

// Each phone keeps a private random token. Other players only ever see this hash of it,
// so nobody can pretend to be someone else.
async function playerId(token) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mb:' + token));
  return 'p' + [...new Uint8Array(d)].slice(0, 9).map(x => x.toString(16).padStart(2, '0')).join('');
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/new' && request.method === 'POST') {
      for (let i = 0; i < 8; i++) {
        const code = randomCode();
        const room = env.GAMES.get(env.GAMES.idFromName(code));
        const r = await room.fetch('https://room/init', { method: 'POST', body: code });
        if (r.ok) return json({ code });
      }
      return json({ error: 'Couldn’t make a game code. Try again.' }, 503);
    }

    const m = url.pathname.match(/^\/ws\/([A-Z]{4})$/);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const token = url.searchParams.get('t') || '';
      if (!/^[A-Za-z0-9-]{16,80}$/.test(token)) return new Response('Bad player token', { status: 400 });
      const headers = new Headers(request.headers);
      headers.set('X-Pid', await playerId(token));
      const room = env.GAMES.get(env.GAMES.idFromName(m[1]));
      return room.fetch(new Request(request.url, { headers }));
    }

    return env.ASSETS.fetch(request);
  },
};
