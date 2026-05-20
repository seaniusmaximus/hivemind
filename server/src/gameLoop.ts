/**
 * Authoritative per-room game loop.
 *
 * Each room owns one {@link GameLoop}. The loop:
 * - Holds the canonical {@link World} for the room.
 * - Ticks the engine at `tickHz` (default 30 Hz) using a fixed `dt`.
 * - Broadcasts a perspective-swapped `SNAPSHOT` to each connected player at
 *   `snapshotHz` (default 15 Hz).
 * - Processes inbound {@link GameCommand}s synchronously, *except* for
 *   `submitWords` which awaits per-path dictionary validation before applying
 *   the surviving paths.
 * - Emits `GAME_OVER` exactly once when the engine flips `world.phase` to
 *   `'over'` (queen breach) or a player forfeits.
 *
 * The loop has no opinion on transport. It talks to the outside through
 * {@link GameLoopPort}, which `rooms.ts` bridges to the live WebSocket and
 * `dictionary.isWord`. Tests supply a stub port and drive the simulation
 * via {@link GameLoop.manualTick} so timer mocking is unnecessary.
 */

import {
  applyCommand,
  buildInitialWorld,
  hexEquals,
  makeRng,
  tickWorld,
  tileHasDraftableLetter,
  worldToSnapshot,
  type GameCommand,
  type Letter,
  type ServerMessage,
  type Side,
  type World,
} from '@hivemind/shared';

export interface GameLoopPlayer {
  readonly id: string;
  /** Which side in the server's `World` this player owns. */
  readonly side: Side;
}

export interface GameLoopPort {
  /** Deliver one server message to one player. The implementation should be a
   *  no-op if the player's transport is no longer open. */
  readonly sendTo: (playerId: string, msg: ServerMessage) => void;
  /** Async dictionary check. */
  readonly validateWord: (word: string) => Promise<boolean>;
}

export interface GameLoopOpts {
  readonly players: readonly [GameLoopPlayer, GameLoopPlayer];
  readonly seed: number;
  /** Override for tests; defaults to `buildInitialWorld(rng, { selfId, opponentId })`. */
  readonly initialWorld?: World;
  /** Internal simulation rate, in ticks per second. Default 30. */
  readonly tickHz?: number;
  /** Snapshot broadcast rate. Default 5. */
  readonly snapshotHz?: number;
}

export interface GameLoop {
  /** Begin the timer-driven loop. Idempotent. */
  start: () => void;
  /** Stop the timer and prevent further ticks/snapshots. Idempotent. */
  stop: () => void;
  /** Receive a `COMMAND` from one of the players. The loop validates the
   *  player owns a side in this room before applying. Returns a promise that
   *  resolves once any async work (e.g. dictionary lookup for `submitWords`)
   *  completes — `rooms.ts` fires-and-forgets, but tests can `await`. */
  receiveCommand: (
    playerId: string,
    commandId: string,
    cmd: GameCommand,
  ) => Promise<void>;
  /** Mark a player as forfeit. Triggers `GAME_OVER` for the other side. */
  forfeit: (playerId: string) => void;
  /** Test seam: advance the simulation by `dt` seconds and send any due
   *  snapshot. Same code path as the timer-driven step. */
  manualTick: (dt: number) => void;
  /** Read-only access for tests. */
  readonly getWorld: () => World;
}

const DEFAULT_TICK_HZ = 30;
/**
 * Snapshot broadcast cadence. 5Hz is enough for correctness — clients run
 * the pure engine locally for prediction and only replace world state when a
 * snapshot arrives — but a 200ms reconciliation gap is visible whenever the
 * server diverges from the prediction (e.g. a command is rejected). 15Hz
 * keeps the corrective hiccup imperceptible without notably increasing
 * bandwidth (typical snapshot is a few KB and most fields are unchanged).
 */
const DEFAULT_SNAPSHOT_HZ = 15;

export const createGameLoop = (
  opts: GameLoopOpts,
  port: GameLoopPort,
): GameLoop => {
  const tickHz = opts.tickHz ?? DEFAULT_TICK_HZ;
  const snapshotHz = opts.snapshotHz ?? DEFAULT_SNAPSHOT_HZ;
  const tickIntervalMs = 1000 / tickHz;
  const snapshotEvery = Math.max(1, Math.round(tickHz / snapshotHz));
  const dt = 1 / tickHz;

  const [hostPlayer, joinerPlayer] = opts.players;
  if (hostPlayer.side === joinerPlayer.side) {
    throw new Error('GameLoop requires two players on opposite sides');
  }
  const playerById = new Map<string, GameLoopPlayer>([
    [hostPlayer.id, hostPlayer],
    [joinerPlayer.id, joinerPlayer],
  ]);
  const playerIdBySide = new Map<Side, string>([
    [hostPlayer.side, hostPlayer.id],
    [joinerPlayer.side, joinerPlayer.id],
  ]);

  const rng = makeRng(opts.seed);
  let world: World =
    opts.initialWorld ??
    buildInitialWorld(rng, {
      selfId: playerIdBySide.get('self') ?? hostPlayer.id,
      opponentId: playerIdBySide.get('opponent') ?? joinerPlayer.id,
    });
  let snapshotTick = 0;
  let tickCounter = 0;
  let gameOverSent = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  const broadcastSnapshot = () => {
    snapshotTick++;
    for (const player of [hostPlayer, joinerPlayer]) {
      port.sendTo(player.id, {
        type: 'SNAPSHOT',
        tick: snapshotTick,
        world: worldToSnapshot(world, player.side, snapshotTick),
      });
    }
  };

  const sendGameOver = (reason: 'queen' | 'forfeit') => {
    if (gameOverSent) return;
    gameOverSent = true;
    const winnerId =
      world.winner === null ? null : (playerIdBySide.get(world.winner) ?? null);
    const msg: ServerMessage = {
      type: 'GAME_OVER',
      winnerId,
      reason,
    };
    port.sendTo(hostPlayer.id, msg);
    port.sendTo(joinerPlayer.id, msg);
  };

  const maybeEmitGameOver = () => {
    if (gameOverSent) return;
    if (world.phase !== 'over') return;
    // The engine only flips `phase` to `'over'` via a queen breach now;
    // forfeits are routed through `forfeit()` directly.
    sendGameOver('queen');
  };

  const ack = (playerId: string, commandId: string, ok: boolean, reason?: string) => {
    port.sendTo(playerId, {
      type: 'COMMAND_RESULT',
      commandId,
      ok,
      ...(reason !== undefined ? { reason } : {}),
    });
  };

  /**
   * Resolve each path's letters from the *current* world, validate them
   * against the dictionary, then apply only the surviving paths. We do dict
   * lookups concurrently and keep the input order so `WORD_RESULT.words`
   * lines up with the client's draft order.
   */
  const handleSubmitWords = async (
    player: GameLoopPlayer,
    commandId: string,
    paths: readonly (readonly { q: number; r: number }[])[],
  ): Promise<void> => {
    if (paths.length === 0) {
      ack(player.id, commandId, false, 'no words submitted');
      return;
    }
    const owner = world[player.side];
    const lettersForPath = (path: readonly { q: number; r: number }[]): Letter[] | null => {
      const letters: Letter[] = [];
      for (const h of path) {
        const tile = owner.tiles.find((t) => hexEquals(t.hex, h));
        if (!tile || !tileHasDraftableLetter(tile)) {
          return null;
        }
        letters.push(tile.letter);
      }
      return letters;
    };
    const wordsAtSubmit = paths.map(lettersForPath);
    // Run dict lookups concurrently, treating any path that didn't resolve
    // to letters (e.g. tile destroyed mid-validation) as invalid.
    const validations = await Promise.all(
      wordsAtSubmit.map(async (letters) => {
        if (!letters) return false;
        return port.validateWord(letters.join(''));
      }),
    );
    port.sendTo(player.id, {
      type: 'WORD_RESULT',
      ownerId: player.id,
      words: paths.map((_, i) => ({
        letters: wordsAtSubmit[i] ?? [],
        valid: validations[i] ?? false,
      })),
    });
    const validPaths = paths.filter((_, i) => validations[i]);
    if (validPaths.length === 0) {
      ack(player.id, commandId, false, 'no valid words');
      return;
    }
    // One word per drone — cap only the first valid path when several were sent.
    const result = applyCommand(world, player.side, {
      kind: 'submitWords',
      paths: [validPaths[0]!],
    });
    if (!result.ok) {
      ack(player.id, commandId, false, result.reason);
      return;
    }
    world = result.world;
    ack(player.id, commandId, true);
    maybeEmitGameOver();
  };

  const handleCommand = async (
    player: GameLoopPlayer,
    commandId: string,
    cmd: GameCommand,
  ): Promise<void> => {
    if (gameOverSent || world.phase === 'over') {
      ack(player.id, commandId, false, 'game over');
      return;
    }
    if (cmd.kind === 'submitWords') {
      await handleSubmitWords(player, commandId, cmd.paths);
      return;
    }
    const result = applyCommand(world, player.side, cmd);
    if (!result.ok) {
      ack(player.id, commandId, false, result.reason);
      return;
    }
    world = result.world;
    ack(player.id, commandId, true);
    maybeEmitGameOver();
  };

  const manualTick: GameLoop['manualTick'] = (stepDt) => {
    if (gameOverSent) return;
    world = tickWorld(world, stepDt, rng);
    tickCounter++;
    if (tickCounter % snapshotEvery === 0) broadcastSnapshot();
    maybeEmitGameOver();
  };

  return {
    start: () => {
      if (interval !== null) return;
      // Send an initial snapshot at t=0 so clients can render immediately on
      // GAME_START rather than waiting for the first scheduled broadcast.
      broadcastSnapshot();
      interval = setInterval(() => manualTick(dt), tickIntervalMs);
    },
    stop: () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    },
    receiveCommand: async (playerId, commandId, cmd) => {
      const player = playerById.get(playerId);
      if (!player) {
        port.sendTo(playerId, {
          type: 'COMMAND_RESULT',
          commandId,
          ok: false,
          reason: 'unknown player',
        });
        return;
      }
      await handleCommand(player, commandId, cmd);
    },
    forfeit: (playerId) => {
      const player = playerById.get(playerId);
      if (!player || gameOverSent) return;
      // The remaining player wins by forfeit.
      const winnerSide: Side = player.side === 'self' ? 'opponent' : 'self';
      world = { ...world, phase: 'over', winner: winnerSide };
      sendGameOver('forfeit');
    },
    manualTick,
    getWorld: () => world,
  };
};
