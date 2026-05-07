import type { ClientMessage, ServerMessage } from '@hivemind/shared';

/** Coarse lifecycle of one websocket. Fine enough for the lobby UI. */
export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface NetConnection {
  /** Send a typed client message. No-op when the socket isn't open. */
  readonly send: (msg: ClientMessage) => void;
  /** Close the socket. Idempotent. */
  readonly close: () => void;
}

export interface OpenConnectionHandlers {
  readonly onMessage: (msg: ServerMessage) => void;
  readonly onStatus: (status: ConnectionStatus) => void;
}

/**
 * Open a websocket to `url` and wire it up to the supplied handlers. The
 * returned handle hides the raw socket so callers can't leak it. Malformed
 * messages from the server are dropped silently — the wire protocol is
 * source-of-truth, but the client should never crash on a stray frame.
 */
export const openConnection = (
  url: string,
  handlers: OpenConnectionHandlers,
): NetConnection => {
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    handlers.onStatus('error');
    return { send: () => {}, close: () => {} };
  }
  handlers.onStatus('connecting');

  ws.addEventListener('open', () => handlers.onStatus('open'));
  ws.addEventListener('message', (e) => {
    try {
      const parsed = JSON.parse(String(e.data)) as ServerMessage;
      handlers.onMessage(parsed);
    } catch {
      // ignore malformed frames
    }
  });
  ws.addEventListener('close', () => handlers.onStatus('closed'));
  ws.addEventListener('error', () => handlers.onStatus('error'));

  return {
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    close: () => {
      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.close();
      }
    },
  };
};

/** Default development URL — the server boots on 8787. */
export const DEFAULT_WS_URL = 'ws://localhost:8787';
