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
 *   `'over'` (last player standing) or a player forfeits.
 */

import {
  applyCommand,
  buildInitialWorld,
  eliminateByForfeit,
  getPlayer,
  hexEquals,
  makeRng,
  tickWorld,
  tileHasDraftableLetter,
  worldToSnapshot,
  type GameCommand,
  type Letter,
  type ServerMessage,
  type World,
} from '@hivemind/shared';

export interface GameLoopPlayer {
  readonly id: string;
}

export interface GameLoopPort {
  readonly sendTo: (playerId: string, msg: ServerMessage) => void;
  readonly validateWord: (word: string) => Promise<boolean>;
}

export interface GameLoopOpts {
  readonly players: readonly GameLoopPlayer[];
  readonly seed: number;
  readonly initialWorld?: World;
  readonly tickHz?: number;
  readonly snapshotHz?: number;
}

export interface GameLoop {
  start: () => void;
  stop: () => void;
  receiveCommand: (
    playerId: string,
    commandId: string,
    cmd: GameCommand,
  ) => Promise<void>;
  forfeit: (playerId: string) => void;
  manualTick: (dt: number) => void;
  readonly getWorld: () => World;
}

const DEFAULT_TICK_HZ = 30;
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

  const players = [...opts.players];
  if (players.length < 2 || players.length > 4) {
    throw new Error('GameLoop requires 2–4 players');
  }
  const playerById = new Map<string, GameLoopPlayer>(
    players.map((p) => [p.id, p]),
  );
  const playerIds = players.map((p) => p.id);

  const rng = makeRng(opts.seed);
  let world: World =
    opts.initialWorld ?? buildInitialWorld(rng, { playerIds });
  let snapshotTick = 0;
  let tickCounter = 0;
  let gameOverSent = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  const broadcastSnapshot = () => {
    snapshotTick++;
    for (const player of players) {
      port.sendTo(player.id, {
        type: 'SNAPSHOT',
        tick: snapshotTick,
        world: worldToSnapshot(world, player.id, snapshotTick),
      });
    }
  };

  const sendGameOver = (reason: 'queen' | 'forfeit') => {
    if (gameOverSent) return;
    gameOverSent = true;
    const msg: ServerMessage = {
      type: 'GAME_OVER',
      winnerId: world.winnerId,
      reason,
    };
    for (const player of players) {
      port.sendTo(player.id, msg);
    }
  };

  const maybeEmitGameOver = () => {
    if (gameOverSent) return;
    if (world.phase !== 'over') return;
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

  const handleSubmitWords = async (
    player: GameLoopPlayer,
    commandId: string,
    paths: readonly (readonly { q: number; r: number }[])[],
  ): Promise<void> => {
    if (paths.length === 0) {
      ack(player.id, commandId, false, 'no words submitted');
      return;
    }
    const owner = getPlayer(world, player.id);
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
    const result = applyCommand(world, player.id, {
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
    if (!world.activePlayerIds.includes(player.id)) {
      ack(player.id, commandId, false, 'eliminated');
      return;
    }
    if (cmd.kind === 'submitWords') {
      await handleSubmitWords(player, commandId, cmd.paths);
      return;
    }
    const result = applyCommand(world, player.id, cmd);
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
      if (gameOverSent) return;
      world = eliminateByForfeit(world, playerId);
      if (world.phase === 'over') sendGameOver('forfeit');
      else broadcastSnapshot();
    },
    manualTick,
    getWorld: () => world,
  };
};
