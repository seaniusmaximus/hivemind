import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@hivemind/shared';

interface Player {
  id: string;
  socket: WebSocket;
  name: string;
  ready: boolean;
}

interface Room {
  code: string;
  players: Player[];
  phase: 'lobby' | 'countdown' | 'playing' | 'over';
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

export const createRoomRegistry = (): RoomRegistry => {
  const rooms = new Map<string, Room>();
  const playerRoom = new WeakMap<WebSocket, { room: Room; player: Player }>();

  const findOrCreate = (code: string): Room => {
    const existing = rooms.get(code);
    if (existing) return existing;
    const room: Room = { code, players: [], phase: 'lobby' };
    rooms.set(code, room);
    return room;
  };

  const handleClose = (socket: WebSocket): void => {
    const entry = playerRoom.get(socket);
    if (!entry) return;
    const { room, player } = entry;
    room.players = room.players.filter((p) => p !== player);
    playerRoom.delete(socket);
    if (room.players.length === 0) {
      rooms.delete(room.code);
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
        if (entry.room.players.length === 2 && entry.room.players.every((p) => p.ready)) {
          entry.room.phase = 'countdown';
          sendRoomState(entry.room);
          broadcast(entry.room, {
            type: 'GAME_START',
            seed: Math.floor(Math.random() * 0xffffffff),
            opponentId:
              entry.room.players.find((p) => p !== entry.player)?.id ?? entry.player.id,
            tickRate: 5,
          });
          entry.room.phase = 'playing';
        }
        break;
      }
      case 'LEAVE': {
        handleClose(socket);
        break;
      }
      default: {
        // SPAWN_BEE / ASSIGN_BEE_TARGET — engine integration is the next milestone.
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
