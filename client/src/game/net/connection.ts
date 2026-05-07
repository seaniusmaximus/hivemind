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
  /** Fired exactly once when the WebSocket transitions to OPEN. Useful for
   *  sending the initial HELLO without needing to listen on the status stream. */
  readonly onOpen?: () => void;
}

/** Build the absolute `ws[s]://host` prefix for the current page. In dev,
 *  Vite is configured to proxy `/ws` and `/api` to the wrangler dev server
 *  on :8787, so the same relative URL works in both dev and prod. */
export const wsBaseUrl = (): string => {
  if (typeof window === 'undefined') return 'ws://localhost:8787';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
};

/** Mint a new room code from the server. Returns the 6-char code on success. */
export const createRoomCode = async (): Promise<string> => {
  const resp = await fetch('/api/rooms', { method: 'POST' });
  if (!resp.ok) {
    throw new Error(`failed to create room (${resp.status})`);
  }
  const data = (await resp.json()) as { code: string };
  return data.code;
};

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

  ws.addEventListener('open', () => {
    handlers.onStatus('open');
    handlers.onOpen?.();
  });
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

/** Open a connection bound to a specific room code. The HELLO message is
 *  sent on `onOpen` by the caller — see {@link gameStore} `createRoom`/`joinRoom`. */
export const openRoomConnection = (
  code: string,
  handlers: OpenConnectionHandlers,
): NetConnection => openConnection(`${wsBaseUrl()}/ws/${code}`, handlers);
