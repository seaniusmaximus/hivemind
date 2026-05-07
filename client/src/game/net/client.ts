import type { ClientMessage, ServerMessage } from '@hivemind/shared';

export interface NetClient {
  send: (msg: ClientMessage) => void;
  close: () => void;
}

export type NetHandler = (msg: ServerMessage) => void;

export const connect = (
  url: string,
  onMessage: NetHandler,
  onError?: (err: Event) => void,
): Promise<NetClient> =>
  new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(e);
      return;
    }

    ws.addEventListener('open', () => {
      resolve({
        send: (msg) => ws.send(JSON.stringify(msg)),
        close: () => ws.close(),
      });
    });
    ws.addEventListener('message', (e) => {
      try {
        onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        // ignore malformed messages
      }
    });
    ws.addEventListener('error', (e) => {
      onError?.(e);
      reject(e);
    });
  });
