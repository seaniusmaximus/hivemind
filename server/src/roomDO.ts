/**
 * Per-room Durable Object. One DO instance per room code, addressed by the
 * Worker via `env.ROOM.idFromName(code)`. Owns:
 *
 *   - 0–2 connected player WebSockets
 *   - the room phase (lobby → countdown → playing → over)
 *   - the authoritative {@link GameLoop} once both players are READY
 *
 * Wire flow on a fresh room code:
 *
 *   1. Client opens WS to `/ws/<code>`. The Worker forwards the upgrade here.
 *   2. We accept the socket and wait for the first `HELLO` message — that's
 *      what binds a socket to a player slot. First HELLO is the host; second
 *      is the joiner. Anything beyond two is rejected with `ROOM_FULL`.
 *   3. Both players send `READY` → we transition to `playing`, spin up the
 *      `GameLoop`, and broadcast `GAME_START` followed by the first snapshot.
 *   4. From then on `COMMAND`s are forwarded to the loop. The loop pushes
 *      `SNAPSHOT` / `WORD_RESULT` / `COMMAND_RESULT` / `GAME_OVER` back to
 *      players via the {@link GameLoopPort} we hand it.
 *
 * On the last disconnect we tell the LobbyDO to release the code, then let
 * the DO go idle. There's no persistent state worth keeping — a new game
 * starts from scratch.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
  ClientMessage,
  ServerMessage,
  Side,
} from '@hivemind/shared';
import { createGameLoop, type GameLoop, type GameLoopPort } from './gameLoop.js';
import { isWord } from './dictionary.js';
import type { Env } from './worker.js';

interface Player {
  id: string;
  socket: WebSocket;
  name: string;
  ready: boolean;
  /** Assigned at GAME_START; null while still in the lobby. */
  side: Side | null;
}

const newPlayerId = (): string => Math.random().toString(36).slice(2, 10);

const sendJson = (socket: WebSocket, msg: ServerMessage): void => {
  if (socket.readyState === WebSocket.READY_STATE_OPEN) {
    socket.send(JSON.stringify(msg));
  }
};

export class RoomDO extends DurableObject<Env> {
  private code: string = '';
  private players: Player[] = [];
  private phase: 'lobby' | 'countdown' | 'playing' | 'over' = 'lobby';
  private loop: GameLoop | null = null;

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    // The DO has no canonical name binding, so we read the code from the URL.
    // It's the same code the Worker validated against the LobbyDO before
    // forwarding, so we can trust it here.
    const url = new URL(request.url);
    const code = url.pathname.split('/').pop()?.toUpperCase() ?? '';
    if (code) this.code = code;

    if (this.players.length >= 2) {
      return new Response('room full', { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    server.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : '';
      void this.handleMessage(server, data);
    });
    server.addEventListener('close', () => {
      void this.handleClose(server);
    });
    server.addEventListener('error', () => {
      void this.handleClose(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- helpers ------------------------------------------------------------

  private broadcast(msg: ServerMessage): void {
    for (const p of this.players) sendJson(p.socket, msg);
  }

  private sendRoomState(): void {
    this.broadcast({
      type: 'ROOM_STATE',
      roomCode: this.code,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
      })),
      phase: this.phase,
    });
  }

  private port(): GameLoopPort {
    return {
      sendTo: (playerId, msg) => {
        const target = this.players.find((p) => p.id === playerId);
        if (target) sendJson(target.socket, msg);
      },
      validateWord: isWord,
    };
  }

  private startGame(): void {
    const [host, joiner] = this.players;
    if (!host || !joiner) return;

    // First-to-join is the host (canonical `'self'` on the server's World);
    // the other is `'opponent'`. `worldToSnapshot` swaps perspective per-player
    // so each client sees themselves as `self`.
    host.side = 'self';
    joiner.side = 'opponent';

    this.phase = 'countdown';
    this.sendRoomState();

    const seed = Math.floor(Math.random() * 0xffffffff);
    const startedAt = Date.now();
    for (const player of this.players) {
      const opponent = this.players.find((p) => p !== player);
      if (!opponent) continue;
      sendJson(player.socket, {
        type: 'GAME_START',
        selfId: player.id,
        opponentId: opponent.id,
        seed,
        tickRate: 15,
        startedAt,
      });
    }

    this.phase = 'playing';
    this.loop = createGameLoop(
      {
        players: [
          { id: host.id, side: 'self' },
          { id: joiner.id, side: 'opponent' },
        ],
        seed,
      },
      this.port(),
    );
    this.loop.start();
  }

  // --- inbound socket events ---------------------------------------------

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      sendJson(socket, {
        type: 'ERROR',
        code: 'BAD_JSON',
        message: 'malformed message',
      });
      return;
    }

    switch (msg.type) {
      case 'HELLO': {
        // Idempotent: a duplicate HELLO from an already-bound socket is a no-op.
        if (this.players.some((p) => p.socket === socket)) return;
        if (this.players.length >= 2) {
          sendJson(socket, {
            type: 'ERROR',
            code: 'ROOM_FULL',
            message: 'room is full',
          });
          socket.close(1000, 'room full');
          return;
        }
        const player: Player = {
          id: newPlayerId(),
          socket,
          name: msg.playerName,
          ready: false,
          side: null,
        };
        this.players.push(player);
        this.sendRoomState();
        break;
      }
      case 'READY': {
        const player = this.players.find((p) => p.socket === socket);
        if (!player) return;
        player.ready = true;
        this.sendRoomState();
        if (
          this.phase === 'lobby' &&
          this.players.length === 2 &&
          this.players.every((p) => p.ready)
        ) {
          this.startGame();
        }
        break;
      }
      case 'LEAVE': {
        await this.handleClose(socket);
        break;
      }
      case 'COMMAND': {
        const player = this.players.find((p) => p.socket === socket);
        if (!player || !this.loop) {
          sendJson(socket, {
            type: 'COMMAND_RESULT',
            commandId: msg.commandId,
            ok: false,
            reason: 'no active game',
          });
          return;
        }
        // Fire and forget — `receiveCommand` resolves to `void`. Errors are
        // surfaced to the client via `COMMAND_RESULT`, not via the promise.
        void this.loop.receiveCommand(player.id, msg.commandId, msg.cmd);
        break;
      }
    }
  }

  private async handleClose(socket: WebSocket): Promise<void> {
    const player = this.players.find((p) => p.socket === socket);
    if (!player) return;
    this.players = this.players.filter((p) => p !== player);

    // If the loop is running, the leaving player forfeits and the loop emits
    // GAME_OVER to the survivor. We then tear the room down once the survivor
    // also disconnects.
    if (this.loop) this.loop.forfeit(player.id);

    if (this.players.length === 0) {
      await this.teardown();
      return;
    }
    this.sendRoomState();
  }

  private async teardown(): Promise<void> {
    if (this.loop) {
      this.loop.stop();
      this.loop = null;
    }
    if (this.code) {
      try {
        const lobbyId = this.env.LOBBY.idFromName('singleton');
        await this.env.LOBBY.get(lobbyId).fetch('https://lobby/release', {
          method: 'POST',
          body: this.code,
        });
      } catch {
        // best-effort; if the lobby DO is unreachable it'll garbage-collect
        // the code on next eviction.
      }
    }
  }
}
