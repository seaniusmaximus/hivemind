import { WebSocketServer } from 'ws';
import { createRoomRegistry } from './rooms.js';

const PORT = Number(process.env.PORT ?? 8787);

const wss = new WebSocketServer({ port: PORT });
const rooms = createRoomRegistry();

wss.on('connection', (socket) => {
  rooms.register(socket);
});

wss.on('listening', () => {
  console.log(`[hivemind] websocket server listening on :${PORT}`);
});

const shutdown = () => {
  console.log('[hivemind] shutting down');
  wss.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
