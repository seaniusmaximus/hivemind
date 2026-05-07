/**
 * Cloudflare Worker entry. Handles three responsibilities:
 *
 * 1. `POST /api/rooms` — forwards to the singleton {@link LobbyDO} to mint a
 *    fresh, unique room code. Returns `{ code }` to the client. The RoomDO is
 *    *not* eagerly created; it spins up lazily on the first WebSocket upgrade.
 * 2. `GET /ws/<code>` — verifies the code is registered with the lobby, then
 *    forwards the WebSocket upgrade to `RoomDO(idFromName(code))`. All later
 *    traffic for that connection is owned by the RoomDO; the Worker never
 *    holds the socket itself.
 * 3. Anything else — served from the Vite build output via the static-assets
 *    binding (`env.ASSETS`). The SPA fallback is configured in `wrangler.jsonc`.
 *
 * The DO classes themselves are re-exported from this module so Wrangler can
 * find them via the `class_name` entries in `durable_objects.bindings`.
 */

import { LobbyDO } from './lobbyDO.js';
import { RoomDO } from './roomDO.js';

export { LobbyDO, RoomDO };

export interface Env {
  ASSETS: Fetcher;
  LOBBY: DurableObjectNamespace;
  ROOM: DurableObjectNamespace;
}

const lobbyStub = (env: Env): DurableObjectStub =>
  env.LOBBY.get(env.LOBBY.idFromName('singleton'));

const ROOM_CODE_RE = /^\/ws\/([A-Z0-9]{4,8})$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const upstream = await lobbyStub(env).fetch('https://lobby/create', {
        method: 'POST',
      });
      // Re-emit with a clean Content-Type so the client can parse it directly.
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const wsMatch = ROOM_CODE_RE.exec(url.pathname);
    if (wsMatch) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('expected websocket upgrade', { status: 426 });
      }
      const code = wsMatch[1]!.toUpperCase();
      // Cheap existence check before spinning up a fresh RoomDO. This stops a
      // typo (or a probing client) from leaving orphan empty DOs around.
      const exists = await lobbyStub(env).fetch(`https://lobby/exists?code=${code}`);
      if (exists.status !== 200) {
        return new Response('room not found', { status: 404 });
      }
      const id = env.ROOM.idFromName(code);
      // Forward the *original* request so the DO sees the upgrade headers.
      return env.ROOM.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
