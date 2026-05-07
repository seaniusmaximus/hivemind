import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage, Side } from '@hivemind/shared';
import { createGameLoop, type GameLoop, type GameLoopPort } from './gameLoop.js';
import { isWord } from './dictionary.js';

interface Player {
  id: string;
  socket: WebSocket;
  name: string;
  ready: boolean;
  /** Assigned at GAME_START. `null` while still in the lobby. */
  side: Side | null;
}

interface Room {
  code: string;
  players: Player[];
  phase: 'lobby' | 'countdown' | 'playing' | 'over';
  /** The authoritative loop, present once the room transitions to `playing`. */
  loop: GameLoop | null;
}

export interface RoomRegistry {
  register: (socket: WebSocket) => void;
}

const newCode = (): string =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

const newPlayerId = (): string =>
  Math.random().toString(36).slice(2, 10);

const send = (socket: WebSocket, msg: ServerMessage): void => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
};

const broadcast = (room: Room, msg: ServerMessage): void => {
  for (const p of room.players) send(p.socket, msg);
};

const sendRoomState = (room: Room): void => {
  broadcast(room, {
    type: 'ROOM_STATE',
    roomCode: room.code,
    players: room.players.map((p) => ({ id: p.id, name: p.name, ready: p.ready })),
    phase: room.phase,
  });
};

/**
 * Bridge a {@link GameLoopPort} onto the room's live sockets. We resolve
 * `playerId → socket` on every send so the loop never holds a stale socket
 * reference (e.g. after a reconnect — eventually planned for M5.3+).
 */
const portFor = (room: Room): GameLoopPort => ({
  sendTo: (playerId, msg) => {
    const target = room.players.find((p) => p.id === playerId);
    if (target) send(target.socket, msg);
  },
  validateWord: isWord,
});

const startGame = (room: Room): void => {
  const [host, joiner] = room.players;
  if (!host || !joiner) return;
  // First-to-join is the host and gets the canonical `'self'` side on the
  // server's World; the other player is `'opponent'`. Each client sees
  // themselves as `self` after worldToSnapshot's perspective swap.
  host.side = 'self';
  joiner.side = 'opponent';

  room.phase = 'countdown';
  sendRoomState(room);

  const seed = Math.floor(Math.random() * 0xffffffff);
  const startedAt = Date.now();
  for (const player of room.players) {
    const opponent = room.players.find((p) => p !== player);
    if (!opponent) continue;
    send(player.socket, {
      type: 'GAME_START',
      selfId: player.id,
      opponentId: opponent.id,
      seed,
      tickRate: 15,
      startedAt,
    });
  }

  room.phase = 'playing';
  room.loop = createGameLoop(
    {
      players: [
        { id: host.id, side: 'self' },
        { id: joiner.id, side: 'opponent' },
      ],
      seed,
    },
    portFor(room),
  );
  room.loop.start();
};

export const createRoomRegistry = (): RoomRegistry => {
  const rooms = new Map<string, Room>();
  const playerRoom = new WeakMap<WebSocket, { room: Room; player: Player }>();

  const findOrCreate = (code: string): Room => {
    const existing = rooms.get(code);
    if (existing) return existing;
    const room: Room = { code, players: [], phase: 'lobby', loop: null };
    rooms.set(code, room);
    return room;
  };

  const teardownRoom = (room: Room): void => {
    if (room.loop) {
      room.loop.stop();
      room.loop = null;
    }
    rooms.delete(room.code);
  };

  const handleClose = (socket: WebSocket): void => {
    const entry = playerRoom.get(socket);
    if (!entry) return;
    const { room, player } = entry;
    room.players = room.players.filter((p) => p !== player);
    playerRoom.delete(socket);
    // If the loop is running, the leaving player forfeits and the loop
    // emits GAME_OVER to the survivor. We then tear the room down once
    // both sockets close.
    if (room.loop) {
      room.loop.forfeit(player.id);
    }
    if (room.players.length === 0) {
      teardownRoom(room);
      return;
    }
    sendRoomState(room);
  };

  const handleMessage = (socket: WebSocket, raw: string): void => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      send(socket, { type: 'ERROR', code: 'BAD_JSON', message: 'malformed message' });
      return;
    }

    switch (msg.type) {
      case 'CREATE_ROOM': {
        const room = findOrCreate(newCode());
        const player: Player = {
          id: newPlayerId(),
          socket,
          name: msg.playerName,
          ready: false,
          side: null,
        };
        room.players.push(player);
        playerRoom.set(socket, { room, player });
        sendRoomState(room);
        break;
      }
      case 'JOIN_ROOM': {
        const room = rooms.get(msg.roomCode);
        if (!room) {
          send(socket, { type: 'ERROR', code: 'NO_ROOM', message: 'room not found' });
          return;
        }
        if (room.players.length >= 2) {
          send(socket, { type: 'ERROR', code: 'ROOM_FULL', message: 'room is full' });
          return;
        }
        const player: Player = {
          id: newPlayerId(),
          socket,
          name: msg.playerName,
          ready: false,
          side: null,
        };
        room.players.push(player);
        playerRoom.set(socket, { room, player });
        sendRoomState(room);
        break;
      }
      case 'READY': {
        const entry = playerRoom.get(socket);
        if (!entry) return;
        entry.player.ready = true;
        sendRoomState(entry.room);
        if (
          entry.room.phase === 'lobby' &&
          entry.room.players.length === 2 &&
          entry.room.players.every((p) => p.ready)
        ) {
          startGame(entry.room);
        }
        break;
      }
      case 'LEAVE': {
        handleClose(socket);
        break;
      }
      case 'COMMAND': {
        const entry = playerRoom.get(socket);
        if (!entry || !entry.room.loop) {
          send(socket, {
            type: 'COMMAND_RESULT',
            commandId: msg.commandId,
            ok: false,
            reason: 'no active game',
          });
          return;
        }
        // Fire and forget — `receiveCommand` resolves to `void`. Errors are
        // surfaced to the client via `COMMAND_RESULT`, not via the promise.
        void entry.room.loop.receiveCommand(
          entry.player.id,
          msg.commandId,
          msg.cmd,
        );
        break;
      }
    }
  };

  return {
    register: (socket) => {
      socket.on('message', (data) => handleMessage(socket, data.toString()));
      socket.on('close', () => handleClose(socket));
      socket.on('error', () => handleClose(socket));
    },
  };
};
