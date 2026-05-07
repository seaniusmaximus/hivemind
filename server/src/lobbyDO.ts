/**
 * Singleton Durable Object that owns the registry of active room codes.
 *
 * Endpoints (called from the Worker; never reachable by clients directly):
 *
 *   POST /create            → mint a fresh, unused 6-char code; respond { code }
 *   GET  /exists?code=XYZ   → 200 if registered, 404 otherwise
 *   POST /release  body=XYZ → remove a code from the registry (called by the
 *                             RoomDO on its last disconnect)
 *
 * The active-code set is persisted to DO storage so a singleton eviction
 * doesn't drop in-flight rooms. That said, code reuse after eviction is
 * benign — the worst case is a stray /exists check returning 404 for a
 * room that's fully torn down, which is exactly what we want.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './worker.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ambiguous chars (I/O/0/1) removed
const CODE_LEN = 6;

export class LobbyDO extends DurableObject<Env> {
  private codes: Set<string> = new Set();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<string[]>('codes');
      if (stored) this.codes = new Set(stored);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      let code: string;
      // Vanishingly unlikely to collide at 32^6 ≈ 1B but guard anyway.
      do {
        code = mintCode();
      } while (this.codes.has(code));
      this.codes.add(code);
      await this.ctx.storage.put('codes', [...this.codes]);
      return Response.json({ code });
    }

    if (url.pathname === '/exists' && request.method === 'GET') {
      const code = url.searchParams.get('code')?.toUpperCase() ?? '';
      return new Response(null, { status: this.codes.has(code) ? 200 : 404 });
    }

    if (url.pathname === '/release' && request.method === 'POST') {
      const code = (await request.text()).toUpperCase();
      if (this.codes.delete(code)) {
        await this.ctx.storage.put('codes', [...this.codes]);
      }
      return new Response(null, { status: 200 });
    }

    return new Response('not found', { status: 404 });
  }
}

const mintCode = (): string => {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
};
