var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/lobbyDO.ts
import { DurableObject } from "cloudflare:workers";
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var CODE_LEN = 6;
var LobbyDO = class extends DurableObject {
  static {
    __name(this, "LobbyDO");
  }
  codes = /* @__PURE__ */ new Set();
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get("codes");
      if (stored) this.codes = new Set(stored);
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/create" && request.method === "POST") {
      let code;
      do {
        code = mintCode();
      } while (this.codes.has(code));
      this.codes.add(code);
      await this.ctx.storage.put("codes", [...this.codes]);
      return Response.json({ code });
    }
    if (url.pathname === "/exists" && request.method === "GET") {
      const code = url.searchParams.get("code")?.toUpperCase() ?? "";
      return new Response(null, { status: this.codes.has(code) ? 200 : 404 });
    }
    if (url.pathname === "/release" && request.method === "POST") {
      const code = (await request.text()).toUpperCase();
      if (this.codes.delete(code)) {
        await this.ctx.storage.put("codes", [...this.codes]);
      }
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }
};
var mintCode = /* @__PURE__ */ __name(() => {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}, "mintCode");

// src/roomDO.ts
import { DurableObject as DurableObject2 } from "cloudflare:workers";

// ../shared/dist/hex.js
var hex = /* @__PURE__ */ __name((q, r) => ({ q, r }), "hex");
var hexEquals = /* @__PURE__ */ __name((a, b) => a.q === b.q && a.r === b.r, "hexEquals");
var hexKey = /* @__PURE__ */ __name((h) => `${h.q},${h.r}`, "hexKey");
var AXIAL_DIRECTIONS = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
];
var neighbors = /* @__PURE__ */ __name((h) => AXIAL_DIRECTIONS.map((d) => ({ q: h.q + d.q, r: h.r + d.r })), "neighbors");
var distance = /* @__PURE__ */ __name((a, b) => {
  const ax = a.q;
  const az = a.r;
  const ay = -ax - az;
  const bx = b.q;
  const bz = b.r;
  const by = -bx - bz;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}, "distance");
var range = /* @__PURE__ */ __name((center, radius) => {
  const result = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const rMin = Math.max(-radius, -dq - radius);
    const rMax = Math.min(radius, -dq + radius);
    for (let dr = rMin; dr <= rMax; dr++) {
      result.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return result;
}, "range");
var isAdjacent = /* @__PURE__ */ __name((a, b) => distance(a, b) === 1, "isAdjacent");
var isValidPath = /* @__PURE__ */ __name((path) => {
  if (path.length === 0)
    return false;
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < path.length; i++) {
    const here = path[i];
    const key = hexKey(here);
    if (seen.has(key))
      return false;
    seen.add(key);
    if (i > 0 && !isAdjacent(path[i - 1], here))
      return false;
  }
  return true;
}, "isValidPath");

// ../shared/dist/letters.js
var LETTER_STATS = {
  A: { count: 9, value: 1 },
  B: { count: 2, value: 3 },
  C: { count: 2, value: 3 },
  D: { count: 4, value: 2 },
  E: { count: 12, value: 1 },
  F: { count: 2, value: 4 },
  G: { count: 3, value: 2 },
  H: { count: 2, value: 4 },
  I: { count: 9, value: 1 },
  J: { count: 1, value: 8 },
  K: { count: 1, value: 5 },
  L: { count: 4, value: 1 },
  M: { count: 2, value: 3 },
  N: { count: 6, value: 1 },
  O: { count: 8, value: 1 },
  P: { count: 2, value: 3 },
  Q: { count: 1, value: 10 },
  R: { count: 6, value: 1 },
  S: { count: 4, value: 1 },
  T: { count: 6, value: 1 },
  U: { count: 4, value: 1 },
  V: { count: 2, value: 4 },
  W: { count: 2, value: 4 },
  X: { count: 1, value: 8 },
  Y: { count: 2, value: 4 },
  Z: { count: 1, value: 10 }
};
var ALL_LETTERS = Object.keys(LETTER_STATS);
var letterValue = /* @__PURE__ */ __name((l) => LETTER_STATS[l].value, "letterValue");
var makeRng = /* @__PURE__ */ __name((seed) => {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}, "makeRng");
var VOWEL_LETTERS = ["A", "E", "I", "O", "U"];
var COMMON_LETTERS = ["R", "S", "T", "L", "N", "D"];
var RARE_LETTERS = [
  "B",
  "C",
  "F",
  "G",
  "H",
  "J",
  "K",
  "M",
  "P",
  "Q",
  "V",
  "W",
  "X",
  "Y",
  "Z"
];
var FLOWER_LETTER_POOLS = {
  vowel: VOWEL_LETTERS,
  common: COMMON_LETTERS,
  rare: RARE_LETTERS
};
var drawFlowerLetter = /* @__PURE__ */ __name((type, rng) => {
  const pool = FLOWER_LETTER_POOLS[type];
  const total = pool.reduce((s, l) => s + LETTER_STATS[l].count, 0);
  let pick = Math.floor(rng() * total);
  for (const l of pool) {
    pick -= LETTER_STATS[l].count;
    if (pick < 0)
      return l;
  }
  return pool[0];
}, "drawFlowerLetter");

// ../shared/dist/bees.js
var BEE_STATS = {
  // Workers and carpenters are now single-trip dispatches: each hold-to-send
  // gesture spawns one bee that visits exactly one target and returns.
  worker: { capacity: 1, honeyCost: 3, flightSeconds: 1.5 },
  carpenter: { capacity: 1, honeyCost: 5, flightSeconds: 1.2 },
  // Drone caps are free — words pay you, they never charge you.
  drone: { capacity: 2, honeyCost: 0, flightSeconds: 1.6 },
  queen: { capacity: 1, honeyCost: 20, flightSeconds: 10 }
};
var HIVE = {
  startingHoney: 5,
  /** Honey regenerated per second, per owned hex tile. */
  regenPerHex: 0.04,
  /** Capacity contributed by the central hive tile itself. */
  hiveStorage: 5
};
var FLIGHT_TIMES = {
  hiveToFlower: 1.5,
  flowerToHive: 1.5,
  flowerToFlower: 0.5,
  hiveToHive: 0.5,
  hiveToTile: 0.7,
  tileToTile: 0.5,
  tileToHive: 0.7,
  /** Drone time to walk a single word path. Total cap time scales with path count. */
  cappingPerPath: 1.4,
  queenToHive: 10
};

// ../shared/dist/scoring.js
var lengthMultiplier = /* @__PURE__ */ __name((length) => {
  if (length <= 4)
    return 1;
  if (length <= 6)
    return 1.5;
  if (length <= 8)
    return 2;
  return 3;
}, "lengthMultiplier");
var wordScore = /* @__PURE__ */ __name((word) => {
  const base = word.reduce((sum, l) => sum + letterValue(l), 0);
  return Math.round(base * lengthMultiplier(word.length));
}, "wordScore");
var chainScore = /* @__PURE__ */ __name((words) => {
  if (words.length === 0)
    return 0;
  const total = words.reduce((s, w) => s + wordScore(w), 0);
  if (words.length === 1)
    return total;
  return Math.round(total * 1.5);
}, "chainScore");

// ../shared/dist/tileHp.js
var HEX_HP_SCALE = 2;
var hexHpForTile = /* @__PURE__ */ __name((tile) => {
  const base = !tile.letter ? 1 : tile.state !== "capped" ? 2 : 4 + (tile.reuseCount ?? 0) * 2;
  return base * HEX_HP_SCALE;
}, "hexHpForTile");

// ../shared/dist/engine/state.js
var HIVE_RADIUS = 2;
var FIELD_RADIUS = 4;
var PATCH_RESPAWN_SECONDS = 1.5;
var PATCH_LIFETIME_SECONDS = 28;
var PATCH_MIN_CENTER_DISTANCE = 3;
var QUEEN_ASSAULT_DURATION_SECONDS = 5;
var QUEEN_ACTION_INTERVAL_SECONDS = 0.72;
var QUEEN_DAMAGE_PER_STRIKE = 2;
var FREED_LETTER_LIFETIME_SECONDS = 6;
var LOG_MAX_ENTRIES = 14;
var PATCH_TYPES = ["vowel", "common", "rare"];
var AI_WORKER_BASE = 6;
var AI_PLACE_BASE = 5;
var AI_PHANTOM_BASE = 14;
var AI_CARPENTER_BASE = 20;
var ringIndex = /* @__PURE__ */ __name((h) => Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r)), "ringIndex");
var cubeDistance = /* @__PURE__ */ __name((a, b) => {
  const az = -a.q - a.r;
  const bz = -b.q - b.r;
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(az - bz)) / 2;
}, "cubeDistance");
var pickQueenLandingHex = /* @__PURE__ */ __name((defender) => defender.tiles.filter((t) => t.state !== "hive").sort((a, b) => {
  const d = cubeDistance(b.hex, hex(0, 0)) - cubeDistance(a.hex, hex(0, 0));
  if (d !== 0)
    return d;
  return hexKey(a.hex).localeCompare(hexKey(b.hex));
})[0]?.hex ?? null, "pickQueenLandingHex");
var buildPlayer = /* @__PURE__ */ __name((id) => {
  const tiles = [];
  for (const h of range(hex(0, 0), HIVE_RADIUS)) {
    const ri = ringIndex(h);
    if (ri === 0)
      tiles.push({ hex: h, state: "hive", letter: null, reuseCount: 0, damage: 0 });
    else if (ri === 1)
      tiles.push({ hex: h, state: "storage", letter: null, reuseCount: 0, damage: 0 });
    else
      tiles.push({ hex: h, state: "active", letter: null, reuseCount: 0, damage: 0 });
  }
  return {
    id,
    honey: HIVE.startingHoney,
    tiles,
    freedLetters: [],
    bees: [],
    usedWordSignatures: []
  };
}, "buildPlayer");
var honeyRateFor = /* @__PURE__ */ __name((player) => HIVE.regenPerHex * player.tiles.length, "honeyRateFor");
var honeyCapFor = /* @__PURE__ */ __name((player) => {
  let cap = 0;
  for (const t of player.tiles) {
    if (t.state === "hive")
      cap += HIVE.hiveStorage;
    else if (t.state === "storage")
      continue;
    else
      cap += 1;
  }
  return cap;
}, "honeyCapFor");
var grantHoney = /* @__PURE__ */ __name((player, bonus) => ({
  ...player,
  honey: Math.min(honeyCapFor(player), player.honey + bonus)
}), "grantHoney");
var patchCenterCandidates = range(hex(0, 0), FIELD_RADIUS).filter((h) => neighbors(h).every((n) => ringIndex(n) <= FIELD_RADIUS));
var spawnPatch = /* @__PURE__ */ __name((existing, type, rng, spawnedAt) => {
  const free = patchCenterCandidates.filter((c) => existing.every((p) => cubeDistance(p.center, c) >= PATCH_MIN_CENTER_DISTANCE));
  if (free.length === 0)
    return null;
  const center = free[Math.floor(rng() * free.length)];
  const order = neighbors(center).map((h, i) => ({ h, i, sort: rng() })).sort((a, b) => a.sort - b.sort).map((x) => x.h);
  const petals = order.map((h, i) => ({
    hex: h,
    letter: drawFlowerLetter(type, rng),
    witherAt: spawnedAt + PATCH_LIFETIME_SECONDS * (0.45 + 0.55 * (i + 1) / order.length) + (rng() - 0.5) * 1.2
  }));
  return {
    id: newId(),
    type,
    center,
    petals,
    spawnedAt,
    lifetimeSeconds: PATCH_LIFETIME_SECONDS
  };
}, "spawnPatch");
var missingPatchTypes = /* @__PURE__ */ __name((patches) => {
  const present = new Set(patches.map((p) => p.type));
  return PATCH_TYPES.filter((t) => !present.has(t));
}, "missingPatchTypes");
var seedPatches = /* @__PURE__ */ __name((rng, t) => {
  const result = [];
  for (const type of PATCH_TYPES) {
    const p = spawnPatch(result, type, rng, t);
    if (!p)
      break;
    result.push(p);
  }
  return result;
}, "seedPatches");
var petalAt = /* @__PURE__ */ __name((patches, h) => {
  for (const patch of patches) {
    const petal = patch.petals.find((p) => hexEquals(p.hex, h));
    if (petal)
      return { patch, petal };
  }
  return null;
}, "petalAt");
var removePetal = /* @__PURE__ */ __name((patches, patchId, petalHex) => patches.map((p) => p.id === patchId ? { ...p, petals: p.petals.filter((pt) => !hexEquals(pt.hex, petalHex)) } : p).filter((p) => p.petals.length > 0), "removePetal");
var buildInitialWorld = /* @__PURE__ */ __name((rng, ids = { selfId: "self", opponentId: "opponent" }) => ({
  t: 0,
  phase: "playing",
  self: buildPlayer(ids.selfId),
  opponent: buildPlayer(ids.opponentId),
  patches: seedPatches(rng, 0),
  patchCooldown: PATCH_RESPAWN_SECONDS,
  aiWorkerCooldown: AI_WORKER_BASE,
  aiPlaceCooldown: AI_PLACE_BASE,
  aiPhantomCooldown: AI_PHANTOM_BASE,
  aiCarpenterCooldown: AI_CARPENTER_BASE,
  winner: null,
  log: []
}), "buildInitialWorld");
var setPlayer = /* @__PURE__ */ __name((world, side, player) => side === "self" ? { ...world, self: player } : { ...world, opponent: player }, "setPlayer");
var otherSide = /* @__PURE__ */ __name((side) => side === "self" ? "opponent" : "self", "otherSide");
var sideHivePanel = /* @__PURE__ */ __name((side) => side === "self" ? "self-hive" : "opponent-hive", "sideHivePanel");
var logEvent = /* @__PURE__ */ __name((world, entry) => ({
  ...world,
  log: [{ ...entry, id: newId() }, ...world.log].slice(0, LOG_MAX_ENTRIES)
}), "logEvent");
var newId = /* @__PURE__ */ __name(() => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function")
    return c.randomUUID();
  return Math.random().toString(36).slice(2, 10);
}, "newId");
var tickHoney = /* @__PURE__ */ __name((player, dt) => ({
  ...player,
  honey: Math.min(honeyCapFor(player), player.honey + honeyRateFor(player) * dt)
}), "tickHoney");
var flight = /* @__PURE__ */ __name((fromPanel, fromHex, toPanel, toHex, startedAt, duration) => ({
  from: { panel: fromPanel, hex: fromHex },
  to: { panel: toPanel, hex: toHex },
  startedAt,
  arrivesAt: startedAt + duration
}), "flight");
var pickEmptyStorage = /* @__PURE__ */ __name((player) => {
  for (const t of player.tiles) {
    if (t.state === "storage" && !t.letter)
      return t;
  }
  return null;
}, "pickEmptyStorage");
var tickWorld = /* @__PURE__ */ __name((world, dt, rng) => {
  if (world.phase === "over")
    return world;
  let next = {
    ...world,
    t: world.t + dt,
    self: tickHoney(world.self, dt),
    opponent: tickHoney(world.opponent, dt)
  };
  next = resolveArrivedBees(next);
  next = tickQueens(next);
  next = tickFreedLetters(next);
  next = tickPatches(next, dt, rng);
  return next;
}, "tickWorld");
var tickFreedLetters = /* @__PURE__ */ __name((world) => {
  const trim = /* @__PURE__ */ __name((letters) => letters.filter((l) => l.witherAt > world.t), "trim");
  const selfCurrent = world.self.freedLetters ?? [];
  const oppCurrent = world.opponent.freedLetters ?? [];
  const self = trim(selfCurrent);
  const opponent = trim(oppCurrent);
  if (self.length === selfCurrent.length && opponent.length === oppCurrent.length) {
    return world;
  }
  return {
    ...world,
    self: { ...world.self, freedLetters: self },
    opponent: { ...world.opponent, freedLetters: opponent }
  };
}, "tickFreedLetters");
var tickPatches = /* @__PURE__ */ __name((world, dt, rng) => {
  const wilted = [];
  let patches = world.patches.map((p) => {
    const surviving = p.petals.filter((pt) => pt.witherAt > world.t);
    for (const pt of p.petals) {
      if (!surviving.includes(pt))
        wilted.push({ type: p.type, letter: pt.letter });
    }
    return { ...p, petals: surviving };
  });
  patches = patches.filter((p) => p.petals.length > 0);
  let cooldown = world.patchCooldown - dt;
  const missing = missingPatchTypes(patches);
  if (missing.length > 0) {
    if (cooldown <= 0) {
      const type = missing[Math.floor(rng() * missing.length)];
      const fresh = spawnPatch(patches, type, rng, world.t);
      if (fresh) {
        patches = [...patches, fresh];
        cooldown = PATCH_RESPAWN_SECONDS;
      }
    }
  } else {
    cooldown = PATCH_RESPAWN_SECONDS;
  }
  let next = { ...world, patches, patchCooldown: cooldown };
  if (wilted.length > 0) {
    const summary = wilted.slice(0, 3).map((w) => w.letter).join(",");
    next = logEvent(next, {
      t: next.t,
      ownerId: "field",
      text: `${summary}${wilted.length > 3 ? "\u2026" : ""} withered`
    });
  }
  return next;
}, "tickPatches");
function tileHasDraftableLetter(tile) {
  return !!tile?.letter && (tile.state === "capped" || tile.state === "letter" || tile.state === "active" && !!tile.letter);
}
__name(tileHasDraftableLetter, "tileHasDraftableLetter");
var resolveArrivedBees = /* @__PURE__ */ __name((world) => {
  let next = world;
  for (const side of ["self", "opponent"]) {
    next = resolveSideBees(next, side);
  }
  return next;
}, "resolveArrivedBees");
var resolveSideBees = /* @__PURE__ */ __name((world, side) => {
  const player = world[side];
  let next = world;
  let updatedPlayer = player;
  let updatedPatches = world.patches;
  let beesChanged = false;
  const remainingBees = [];
  for (const bee of player.bees) {
    const arrival = arrivalOf(bee);
    if (arrival === null || arrival > world.t) {
      if (bee.state.kind === "queen-flying" && (!Number.isFinite(bee.state.expiresAt) || world.t >= bee.state.expiresAt)) {
        beesChanged = true;
        continue;
      }
      if (bee.state.kind === "queen-flying") {
        const defender = world[otherSide(side)];
        const desired = pickQueenLandingHex(defender);
        if (!desired) {
          beesChanged = true;
          continue;
        }
        const f = bee.state.flight;
        const needRetarget = !hexEquals(desired, bee.state.landingHex) || !hexEquals(desired, f.to.hex);
        const nextState = needRetarget ? {
          ...bee.state,
          landingHex: desired,
          flight: {
            ...f,
            to: { panel: bee.state.assaultPanel, hex: desired }
          }
        } : bee.state;
        if (needRetarget)
          beesChanged = true;
        remainingBees.push({ ...bee, state: nextState });
        continue;
      }
      remainingBees.push(bee);
      continue;
    }
    if (bee.state.kind === "worker-flying-to-flower") {
      const target = bee.state.target;
      const found = petalAt(updatedPatches, target);
      if (found) {
        updatedPatches = removePetal(updatedPatches, found.patch.id, target);
        const drop = pickEmptyStorage(updatedPlayer);
        if (!drop) {
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `storage full, ${found.petal.letter} lost`
          });
          remainingBees.push({
            ...bee,
            state: {
              kind: "worker-returning",
              flight: flight("flowers", target, sideHivePanel(side), hex(0, 0), next.t, FLIGHT_TIMES.flowerToHive)
            }
          });
        } else {
          remainingBees.push({
            ...bee,
            state: {
              kind: "worker-flying-to-drop",
              queue: bee.state.queue,
              carrying: found.petal.letter,
              dropTile: drop.hex,
              flight: flight("flowers", target, sideHivePanel(side), drop.hex, next.t, FLIGHT_TIMES.flowerToHive)
            }
          });
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `${found.petal.letter} grabbed`
          });
        }
        beesChanged = true;
        continue;
      }
      next = logEvent(next, {
        t: next.t,
        ownerId: player.id,
        text: `petal at ${target.q},${target.r} missed`
      });
      const [nextTarget, ...rest] = bee.state.queue;
      if (!nextTarget) {
        remainingBees.push({
          ...bee,
          state: {
            kind: "worker-returning",
            flight: flight("flowers", target, sideHivePanel(side), hex(0, 0), next.t, FLIGHT_TIMES.flowerToHive)
          }
        });
      } else {
        remainingBees.push({
          ...bee,
          state: {
            kind: "worker-flying-to-flower",
            queue: rest,
            target: nextTarget,
            flight: flight("flowers", target, "flowers", nextTarget, next.t, FLIGHT_TIMES.flowerToFlower)
          }
        });
      }
      beesChanged = true;
      continue;
    }
    if (bee.state.kind === "worker-flying-to-drop") {
      const dropTile = bee.state.dropTile;
      const letter = bee.state.carrying;
      const tile = updatedPlayer.tiles.find((t) => hexEquals(t.hex, dropTile));
      if (tile && tile.state === "storage" && !tile.letter) {
        updatedPlayer = {
          ...updatedPlayer,
          tiles: updatedPlayer.tiles.map((t) => hexEquals(t.hex, dropTile) ? { ...t, letter } : t)
        };
        next = logEvent(next, {
          t: next.t,
          ownerId: player.id,
          text: `${letter} stored`
        });
      } else {
        const fallback = pickEmptyStorage(updatedPlayer);
        if (fallback) {
          updatedPlayer = {
            ...updatedPlayer,
            tiles: updatedPlayer.tiles.map((t) => hexEquals(t.hex, fallback.hex) ? { ...t, letter } : t)
          };
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `${letter} stored`
          });
        } else {
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `${letter} lost`
          });
        }
      }
      const newCapacity = bee.capacity - 1;
      const [nextTarget, ...rest] = bee.state.queue;
      if (newCapacity > 0 && nextTarget) {
        remainingBees.push({
          ...bee,
          capacity: newCapacity,
          state: {
            kind: "worker-flying-to-flower",
            queue: rest,
            target: nextTarget,
            flight: flight(sideHivePanel(side), dropTile, "flowers", nextTarget, next.t, FLIGHT_TIMES.hiveToFlower)
          }
        });
      } else {
        remainingBees.push({
          ...bee,
          capacity: newCapacity,
          state: {
            kind: "worker-returning",
            flight: flight(sideHivePanel(side), dropTile, sideHivePanel(side), hex(0, 0), next.t, FLIGHT_TIMES.hiveToHive)
          }
        });
      }
      beesChanged = true;
      continue;
    }
    if (bee.state.kind === "worker-flying-to-freed") {
      const freedTargetHex = bee.state.target;
      const found = (updatedPlayer.freedLetters ?? []).find((f) => hexEquals(f.hex, freedTargetHex));
      if (!found) {
        remainingBees.push({
          ...bee,
          state: {
            kind: "worker-returning",
            flight: flight(sideHivePanel(side), freedTargetHex, sideHivePanel(side), hex(0, 0), next.t, FLIGHT_TIMES.tileToHive)
          }
        });
        beesChanged = true;
        continue;
      }
      updatedPlayer = {
        ...updatedPlayer,
        freedLetters: (updatedPlayer.freedLetters ?? []).filter((f) => f.id !== found.id)
      };
      const drop = pickEmptyStorage(updatedPlayer);
      if (!drop) {
        remainingBees.push({
          ...bee,
          state: {
            kind: "worker-returning",
            flight: flight(sideHivePanel(side), freedTargetHex, sideHivePanel(side), hex(0, 0), next.t, FLIGHT_TIMES.tileToHive)
          }
        });
      } else {
        remainingBees.push({
          ...bee,
          state: {
            kind: "worker-flying-to-drop",
            queue: [],
            carrying: found.letter,
            dropTile: drop.hex,
            flight: flight(sideHivePanel(side), freedTargetHex, sideHivePanel(side), drop.hex, next.t, FLIGHT_TIMES.tileToHive)
          }
        });
      }
      beesChanged = true;
      continue;
    }
    if (bee.state.kind === "worker-returning") {
      beesChanged = true;
      continue;
    }
    if (bee.state.kind === "capping") {
      const paths = bee.state.paths;
      const wordsLetters = [];
      const allCappedHexes = [];
      const reuseIncrementsByKey = /* @__PURE__ */ new Map();
      for (const path of paths) {
        const letters = [];
        let valid = true;
        const cappedHitsThisPath = [];
        for (const h of path) {
          const tile = updatedPlayer.tiles.find((t) => hexEquals(t.hex, h));
          if (!tile || !tileHasDraftableLetter(tile)) {
            valid = false;
            break;
          }
          letters.push(tile.letter);
          if (tile.state === "capped")
            cappedHitsThisPath.push(h);
        }
        if (valid && letters.length >= 2) {
          wordsLetters.push(letters);
          for (const h of path) {
            if (!allCappedHexes.some((c) => hexEquals(c, h)))
              allCappedHexes.push(h);
          }
          for (const h of cappedHitsThisPath) {
            const k = hexKey(h);
            reuseIncrementsByKey.set(k, (reuseIncrementsByKey.get(k) ?? 0) + 1);
          }
        } else {
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `${letters.join("") || "word"} missed`
          });
        }
      }
      if (wordsLetters.length > 0) {
        const sharesTile = wordsLetters.length >= 2 && paths.some((p1, i) => paths.some((p2, j) => i < j && p1.some((a) => p2.some((b) => hexEquals(a, b)))));
        const bonus = sharesTile ? chainScore(wordsLetters) : wordsLetters.reduce((s, w) => s + wordScore(w), 0);
        updatedPlayer = {
          ...updatedPlayer,
          tiles: updatedPlayer.tiles.map((t) => {
            const k = hexKey(t.hex);
            const shouldCap = allCappedHexes.some((h) => hexEquals(h, t.hex));
            const reuseInc = reuseIncrementsByKey.get(k) ?? 0;
            if (!shouldCap && reuseInc === 0)
              return t;
            return {
              ...t,
              state: shouldCap ? "capped" : t.state,
              reuseCount: (t.reuseCount ?? 0) + reuseInc
            };
          })
        };
        updatedPlayer = grantHoney(updatedPlayer, bonus);
        const summary = wordsLetters.map((w) => w.join("")).join(" + ");
        const tag = sharesTile && wordsLetters.length >= 2 ? " chain!" : "";
        next = logEvent(next, {
          t: next.t,
          ownerId: player.id,
          text: `${summary} +${bonus} \u{1F728}${tag}`
        });
      }
      beesChanged = true;
      continue;
    }
    if (bee.state.kind === "carpenter-flying") {
      const target = bee.state.target;
      const tile = updatedPlayer.tiles.find((t) => hexEquals(t.hex, target));
      if (tile) {
        if (tile.state === "inactive") {
          updatedPlayer = {
            ...updatedPlayer,
            tiles: updatedPlayer.tiles.map((t) => hexEquals(t.hex, target) ? { ...t, state: "active" } : t)
          };
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `tile activated`
          });
        } else {
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `tile already active`
          });
        }
      } else {
        const stillFrontier = neighbors(target).some((n) => updatedPlayer.tiles.some((t) => hexEquals(t.hex, n) && (t.state === "active" || t.state === "letter" || t.state === "capped")));
        if (stillFrontier) {
          updatedPlayer = {
            ...updatedPlayer,
            tiles: [
              ...updatedPlayer.tiles,
              { hex: target, state: "active", letter: null, reuseCount: 0, damage: 0 }
            ]
          };
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `tile activated`
          });
        } else {
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `tile no longer reachable`
          });
        }
      }
      const newCapacity = bee.capacity - 1;
      const [nextTarget, ...rest] = bee.state.queue;
      if (newCapacity > 0 && nextTarget) {
        remainingBees.push({
          ...bee,
          capacity: newCapacity,
          state: {
            kind: "carpenter-flying",
            queue: rest,
            target: nextTarget,
            flight: flight(sideHivePanel(side), target, sideHivePanel(side), nextTarget, next.t, FLIGHT_TIMES.tileToTile)
          }
        });
      } else {
        remainingBees.push({
          ...bee,
          capacity: newCapacity,
          state: {
            kind: "carpenter-returning",
            flight: flight(sideHivePanel(side), target, sideHivePanel(side), hex(0, 0), next.t, FLIGHT_TIMES.tileToHive)
          }
        });
      }
      beesChanged = true;
      continue;
    }
    if (bee.state.kind === "carpenter-returning") {
      beesChanged = true;
      continue;
    }
    if (bee.state.kind === "queen-flying") {
      if (!Number.isFinite(bee.state.expiresAt) || world.t >= bee.state.expiresAt) {
        beesChanged = true;
        continue;
      }
      remainingBees.push({
        ...bee,
        state: {
          kind: "queen-assault",
          panel: bee.state.assaultPanel,
          currentHex: bee.state.landingHex,
          expiresAt: next.t + QUEEN_ASSAULT_DURATION_SECONDS,
          nextActionAt: next.t + 0.45
        }
      });
      next = logEvent(next, {
        t: next.t,
        ownerId: player.id,
        text: `queen lands`
      });
      beesChanged = true;
      continue;
    }
    if (bee.state.kind === "queen-assault") {
      remainingBees.push(bee);
      continue;
    }
  }
  if (beesChanged) {
    updatedPlayer = { ...updatedPlayer, bees: remainingBees };
  }
  next = setPlayer(next, side, updatedPlayer);
  if (updatedPatches !== world.patches) {
    next = { ...next, patches: updatedPatches };
  }
  return next;
}, "resolveSideBees");
var shortestQueenHopTowardHive = /* @__PURE__ */ __name((defender, from) => {
  const goal = hex(0, 0);
  const tileByHex = new Map(defender.tiles.map((t) => [hexKey(t.hex), t]));
  const goalKey = hexKey(goal);
  if (!tileByHex.has(goalKey))
    return null;
  const maxHullRadius = defender.tiles.reduce((m, t) => Math.max(m, cubeDistance(t.hex, goal)), 0);
  const maxVoidReach = Math.max(maxHullRadius + 32, 32);
  const visitBudget = Math.min(6e4, defender.tiles.length * 96 + 2048);
  const dist = /* @__PURE__ */ new Map();
  dist.set(goalKey, 0);
  const q = [goal];
  let visits = 0;
  while (q.length > 0 && visits < visitBudget) {
    visits++;
    const cur = q.shift();
    const dc = dist.get(hexKey(cur));
    const nextDc = dc + 1;
    for (const nbr of neighbors(cur)) {
      const nk = hexKey(nbr);
      if (dist.has(nk))
        continue;
      if (cubeDistance(nbr, goal) > maxVoidReach)
        continue;
      dist.set(nk, nextDc);
      q.push(nbr);
    }
  }
  if (!dist.has(hexKey(from)))
    return null;
  let best = null;
  let bestD = Infinity;
  for (const nbr of neighbors(from)) {
    const nk = hexKey(nbr);
    const d = dist.get(nk);
    if (d === void 0)
      continue;
    if (best === null || d < bestD || d === bestD && nk.localeCompare(hexKey(best)) < 0) {
      bestD = d;
      best = nbr;
    }
  }
  return best;
}, "shortestQueenHopTowardHive");
var destroyTile = /* @__PURE__ */ __name((player, h, t) => {
  const tile = player.tiles.find((x) => hexEquals(x.hex, h));
  if (!tile || tile.state === "hive")
    return player;
  const nextTiles = player.tiles.filter((x) => !hexEquals(x.hex, h));
  const freed = tile.letter !== null ? [
    ...player.freedLetters ?? [],
    {
      id: newId(),
      hex: h,
      letter: tile.letter,
      spawnedAt: t,
      witherAt: t + FREED_LETTER_LIFETIME_SECONDS
    }
  ] : player.freedLetters ?? [];
  return { ...player, tiles: nextTiles, freedLetters: freed };
}, "destroyTile");
var tickQueens = /* @__PURE__ */ __name((world) => {
  let next = world;
  for (const side of ["self", "opponent"]) {
    const attacker = next[side];
    const defenderSide = otherSide(side);
    let defender = next[defenderSide];
    const bees = [];
    let dirty = false;
    for (const bee of attacker.bees) {
      if (bee.state.kind !== "queen-assault") {
        bees.push(bee);
        continue;
      }
      dirty = true;
      if (!Number.isFinite(bee.state.expiresAt) || next.t >= bee.state.expiresAt)
        continue;
      if (next.t < bee.state.nextActionAt) {
        bees.push(bee);
        continue;
      }
      const ch = bee.state.currentHex;
      const tileHere = defender.tiles.find((t) => hexEquals(t.hex, ch));
      if (tileHere?.state === "hive") {
        next = logEvent(next, {
          t: next.t,
          ownerId: attacker.id,
          text: `queen breached hive!`
        });
        return { ...next, phase: "over", winner: side };
      }
      if (tileHere) {
        const nextDamage2 = (tileHere.damage ?? 0) + QUEEN_DAMAGE_PER_STRIKE;
        if (nextDamage2 >= hexHpForTile(tileHere)) {
          defender = destroyTile(defender, ch, next.t);
          next = logEvent(next, {
            t: next.t,
            ownerId: attacker.id,
            text: `queen smashed ${tileHere.letter ?? "tile"}`
          });
        } else {
          defender = {
            ...defender,
            tiles: defender.tiles.map((t) => hexEquals(t.hex, ch) ? { ...t, damage: nextDamage2 } : t)
          };
        }
        bees.push({
          ...bee,
          state: { ...bee.state, nextActionAt: next.t + QUEEN_ACTION_INTERVAL_SECONDS }
        });
        continue;
      }
      const step = shortestQueenHopTowardHive(defender, ch);
      if (!step) {
        bees.push({
          ...bee,
          state: { ...bee.state, nextActionAt: next.t + QUEEN_ACTION_INTERVAL_SECONDS }
        });
        continue;
      }
      const targetTile = defender.tiles.find((t) => hexEquals(t.hex, step));
      if (!targetTile) {
        bees.push({
          ...bee,
          state: {
            ...bee.state,
            currentHex: step,
            nextActionAt: next.t + QUEEN_ACTION_INTERVAL_SECONDS
          }
        });
        continue;
      }
      if (targetTile.state === "hive") {
        next = logEvent(next, {
          t: next.t,
          ownerId: attacker.id,
          text: `queen breached hive!`
        });
        return { ...next, phase: "over", winner: side };
      }
      const nextDamage = (targetTile.damage ?? 0) + QUEEN_DAMAGE_PER_STRIKE;
      if (nextDamage >= hexHpForTile(targetTile)) {
        defender = destroyTile(defender, step, next.t);
        next = logEvent(next, {
          t: next.t,
          ownerId: attacker.id,
          text: `queen smashed ${targetTile.letter ?? "tile"}`
        });
        bees.push({
          ...bee,
          state: {
            ...bee.state,
            currentHex: step,
            nextActionAt: next.t + QUEEN_ACTION_INTERVAL_SECONDS
          }
        });
      } else {
        defender = {
          ...defender,
          tiles: defender.tiles.map((t) => hexEquals(t.hex, step) ? { ...t, damage: nextDamage } : t)
        };
        bees.push({
          ...bee,
          state: { ...bee.state, nextActionAt: next.t + QUEEN_ACTION_INTERVAL_SECONDS }
        });
      }
    }
    if (dirty) {
      const updatedAttacker = { ...attacker, bees };
      next = setPlayer(next, side, updatedAttacker);
      next = setPlayer(next, defenderSide, defender);
    }
  }
  return next;
}, "tickQueens");
var arrivalOf = /* @__PURE__ */ __name((bee) => {
  switch (bee.state.kind) {
    case "worker-flying-to-flower":
    case "worker-flying-to-drop":
    case "worker-flying-to-freed":
    case "worker-returning":
    case "carpenter-flying":
    case "carpenter-returning":
    case "queen-flying":
      return bee.state.flight.arrivesAt;
    case "capping":
      return bee.state.arrivesAt;
    default:
      return null;
  }
}, "arrivalOf");
var dispatchWorker = /* @__PURE__ */ __name((world, side, target) => {
  const player = world[side];
  const cost = BEE_STATS.worker.honeyCost;
  if (player.honey < cost)
    return { ok: false, world, reason: "not enough honey" };
  const flowerTarget = petalAt(world.patches, target);
  const freedTarget = (player.freedLetters ?? []).find((f) => hexEquals(f.hex, target));
  if (!flowerTarget && !freedTarget)
    return { ok: false, world, reason: "no letter here" };
  const emptyStorage = player.tiles.some((t) => t.state === "storage" && !t.letter);
  if (!emptyStorage) {
    return { ok: false, world, reason: "storage is full" };
  }
  const panel = sideHivePanel(side);
  const bee = {
    id: newId(),
    kind: "worker",
    ownerId: player.id,
    capacity: BEE_STATS.worker.capacity,
    state: flowerTarget ? {
      kind: "worker-flying-to-flower",
      queue: [],
      target,
      flight: flight(panel, hex(0, 0), "flowers", target, world.t, FLIGHT_TIMES.hiveToFlower)
    } : {
      kind: "worker-flying-to-freed",
      target,
      flight: flight(panel, hex(0, 0), panel, target, world.t, FLIGHT_TIMES.hiveToTile)
    }
  };
  const updated = {
    ...player,
    honey: player.honey - cost,
    bees: [...player.bees, bee]
  };
  return { ok: true, world: setPlayer(world, side, updated) };
}, "dispatchWorker");
var dispatchQueen = /* @__PURE__ */ __name((world, side) => {
  const player = world[side];
  const cost = BEE_STATS.queen.honeyCost;
  if (player.honey < cost)
    return { ok: false, world, reason: "not enough honey" };
  const alreadyPresent = player.bees.some((b) => b.state.kind === "queen-flying" || b.state.kind === "queen-assault");
  if (alreadyPresent)
    return { ok: false, world, reason: "queen already active" };
  const enemy = world[otherSide(side)];
  const landing = pickQueenLandingHex(enemy);
  if (!landing)
    return { ok: false, world, reason: "enemy hive unavailable" };
  const ownerPanel = sideHivePanel(side);
  const enemyPanel = sideHivePanel(otherSide(side));
  const bee = {
    id: newId(),
    kind: "queen",
    ownerId: player.id,
    capacity: 1,
    state: {
      kind: "queen-flying",
      assaultPanel: enemyPanel,
      landingHex: landing,
      expiresAt: world.t + FLIGHT_TIMES.queenToHive + QUEEN_ASSAULT_DURATION_SECONDS,
      flight: flight(ownerPanel, hex(0, 0), enemyPanel, landing, world.t, FLIGHT_TIMES.queenToHive)
    }
  };
  const updated = {
    ...player,
    honey: player.honey - cost,
    bees: [...player.bees, bee]
  };
  return { ok: true, world: setPlayer(world, side, updated) };
}, "dispatchQueen");
var placeLetter = /* @__PURE__ */ __name((world, side, fromHex, toHex) => {
  if (hexEquals(fromHex, toHex)) {
    return { ok: false, world, reason: "source and destination are the same" };
  }
  const player = world[side];
  const source = player.tiles.find((t) => hexEquals(t.hex, fromHex));
  const dest = player.tiles.find((t) => hexEquals(t.hex, toHex));
  if (!source?.letter) {
    return { ok: false, world, reason: "no letter at source" };
  }
  if (source.state === "capped") {
    return { ok: false, world, reason: "capped letters cannot be moved" };
  }
  const fromStorage = source.state === "storage";
  const fromGrid = source.state === "active" && source.letter || source.state === "letter" && source.letter;
  if (!fromStorage && !fromGrid) {
    return { ok: false, world, reason: "invalid source for letter move" };
  }
  if (!dest || dest.letter) {
    return { ok: false, world, reason: "destination already holds a letter" };
  }
  if (dest.state !== "active" && dest.state !== "storage") {
    return { ok: false, world, reason: "destination is not a letter slot" };
  }
  const letter = source.letter;
  const updated = {
    ...player,
    tiles: player.tiles.map((t) => {
      if (hexEquals(t.hex, fromHex)) {
        if (fromStorage)
          return { ...t, letter: null };
        return { ...t, state: "active", letter: null };
      }
      if (hexEquals(t.hex, toHex)) {
        return dest.state === "storage" ? { ...t, letter } : { ...t, state: "active", letter };
      }
      return t;
    })
  };
  return { ok: true, world: setPlayer(world, side, updated) };
}, "placeLetter");
var trySubmitWord = /* @__PURE__ */ __name((world, side, paths) => {
  const player = world[side];
  const cost = BEE_STATS.drone.honeyCost;
  if (player.honey < cost)
    return { ok: false, world, reason: "not enough honey" };
  if (paths.length === 0)
    return { ok: false, world, reason: "no words submitted" };
  const seenSignatures = new Set(player.usedWordSignatures);
  const nextSignatures = [];
  for (const path of paths) {
    if (path.length < 2)
      return { ok: false, world, reason: "word too short" };
    if (!isValidPath(path))
      return { ok: false, world, reason: "path is not contiguous" };
    const letters = [];
    const placements = [];
    for (const h of path) {
      const tile = player.tiles.find((t) => hexEquals(t.hex, h));
      if (!tile || !tileHasDraftableLetter(tile)) {
        return { ok: false, world, reason: "path includes a non-letter tile" };
      }
      letters.push(tile.letter);
      placements.push(`${h.q},${h.r}:${tile.letter}`);
    }
    const word = letters.join("");
    const signature = `${word}|${placements.sort().join("|")}`;
    if (seenSignatures.has(signature)) {
      return { ok: false, world, reason: "word already used on these tiles" };
    }
    seenSignatures.add(signature);
    nextSignatures.push(signature);
  }
  const flightSeconds = FLIGHT_TIMES.cappingPerPath * paths.length;
  const bee = {
    id: newId(),
    kind: "drone",
    ownerId: player.id,
    capacity: BEE_STATS.drone.capacity,
    state: {
      kind: "capping",
      panel: sideHivePanel(side),
      paths,
      startedAt: world.t,
      arrivesAt: world.t + flightSeconds
    }
  };
  const updated = {
    ...player,
    honey: player.honey - cost,
    bees: [...player.bees, bee],
    usedWordSignatures: [...player.usedWordSignatures, ...nextSignatures]
  };
  return { ok: true, world: setPlayer(world, side, updated) };
}, "trySubmitWord");
var isCarpenterEligible = /* @__PURE__ */ __name((player, h) => {
  const tile = player.tiles.find((t) => hexEquals(t.hex, h));
  if (tile)
    return tile.state === "inactive";
  return neighbors(h).some((n) => {
    const nb = player.tiles.find((t) => hexEquals(t.hex, n));
    if (!nb)
      return false;
    return nb.state === "active" || nb.state === "letter" || nb.state === "capped";
  });
}, "isCarpenterEligible");
var dispatchCarpenter = /* @__PURE__ */ __name((world, side, target) => {
  const player = world[side];
  const cost = BEE_STATS.carpenter.honeyCost;
  if (player.honey < cost)
    return { ok: false, world, reason: "not enough honey" };
  if (!isCarpenterEligible(player, target)) {
    return { ok: false, world, reason: "tile must touch your hive" };
  }
  const bee = {
    id: newId(),
    kind: "carpenter",
    ownerId: player.id,
    capacity: BEE_STATS.carpenter.capacity,
    state: {
      kind: "carpenter-flying",
      queue: [],
      target,
      flight: flight(sideHivePanel(side), hex(0, 0), sideHivePanel(side), target, world.t, FLIGHT_TIMES.hiveToTile)
    }
  };
  const updated = {
    ...player,
    honey: player.honey - cost,
    bees: [...player.bees, bee]
  };
  return { ok: true, world: setPlayer(world, side, updated) };
}, "dispatchCarpenter");
var applyCommand = /* @__PURE__ */ __name((world, side, cmd) => {
  switch (cmd.kind) {
    case "dispatchWorker":
      return dispatchWorker(world, side, cmd.target);
    case "dispatchCarpenter":
      return dispatchCarpenter(world, side, cmd.target);
    case "dispatchQueen":
      return dispatchQueen(world, side);
    case "placeLetter":
      return placeLetter(world, side, cmd.from, cmd.to);
    case "submitWords":
      return trySubmitWord(world, side, cmd.paths);
  }
}, "applyCommand");
var flipPanel = /* @__PURE__ */ __name((panel) => panel === "self-hive" ? "opponent-hive" : panel === "opponent-hive" ? "self-hive" : panel, "flipPanel");
var flipFlight = /* @__PURE__ */ __name((flight2) => ({
  ...flight2,
  from: { ...flight2.from, panel: flipPanel(flight2.from.panel) },
  to: { ...flight2.to, panel: flipPanel(flight2.to.panel) }
}), "flipFlight");
var flipBeePanels = /* @__PURE__ */ __name((bee) => {
  const s = bee.state;
  let next;
  switch (s.kind) {
    case "worker-flying-to-flower":
    case "worker-flying-to-drop":
    case "worker-flying-to-freed":
    case "worker-returning":
    case "carpenter-flying":
    case "carpenter-returning":
      next = { ...s, flight: flipFlight(s.flight) };
      break;
    case "queen-flying":
      next = {
        ...s,
        flight: flipFlight(s.flight),
        assaultPanel: flipPanel(s.assaultPanel)
      };
      break;
    case "capping":
    case "queen-assault":
      next = { ...s, panel: flipPanel(s.panel) };
      break;
  }
  return { ...bee, state: next };
}, "flipBeePanels");
var flipPlayerBees = /* @__PURE__ */ __name((player) => ({
  ...player,
  bees: player.bees.map(flipBeePanels)
}), "flipPlayerBees");
var worldToSnapshot = /* @__PURE__ */ __name((world, viewerSide, tick) => {
  const swap = viewerSide !== "self";
  const rawSelf = swap ? world.opponent : world.self;
  const rawOpp = swap ? world.self : world.opponent;
  const self = swap ? flipPlayerBees(rawSelf) : rawSelf;
  const opponent = swap ? flipPlayerBees(rawOpp) : rawOpp;
  const winner = world.winner === null ? null : world.winner === viewerSide ? "self" : "opponent";
  return {
    t: world.t,
    tick,
    phase: world.phase,
    winner,
    self,
    opponent,
    patches: world.patches,
    log: world.log
  };
}, "worldToSnapshot");

// src/gameLoop.ts
var DEFAULT_TICK_HZ = 30;
var DEFAULT_SNAPSHOT_HZ = 15;
var createGameLoop = /* @__PURE__ */ __name((opts, port) => {
  const tickHz = opts.tickHz ?? DEFAULT_TICK_HZ;
  const snapshotHz = opts.snapshotHz ?? DEFAULT_SNAPSHOT_HZ;
  const tickIntervalMs = 1e3 / tickHz;
  const snapshotEvery = Math.max(1, Math.round(tickHz / snapshotHz));
  const dt = 1 / tickHz;
  const [hostPlayer, joinerPlayer] = opts.players;
  if (hostPlayer.side === joinerPlayer.side) {
    throw new Error("GameLoop requires two players on opposite sides");
  }
  const playerById = /* @__PURE__ */ new Map([
    [hostPlayer.id, hostPlayer],
    [joinerPlayer.id, joinerPlayer]
  ]);
  const playerIdBySide = /* @__PURE__ */ new Map([
    [hostPlayer.side, hostPlayer.id],
    [joinerPlayer.side, joinerPlayer.id]
  ]);
  const rng = makeRng(opts.seed);
  let world = opts.initialWorld ?? buildInitialWorld(rng, {
    selfId: playerIdBySide.get("self") ?? hostPlayer.id,
    opponentId: playerIdBySide.get("opponent") ?? joinerPlayer.id
  });
  let snapshotTick = 0;
  let tickCounter = 0;
  let gameOverSent = false;
  let interval = null;
  const broadcastSnapshot = /* @__PURE__ */ __name(() => {
    snapshotTick++;
    for (const player of [hostPlayer, joinerPlayer]) {
      port.sendTo(player.id, {
        type: "SNAPSHOT",
        tick: snapshotTick,
        world: worldToSnapshot(world, player.side, snapshotTick)
      });
    }
  }, "broadcastSnapshot");
  const sendGameOver = /* @__PURE__ */ __name((reason) => {
    if (gameOverSent) return;
    gameOverSent = true;
    const winnerId = world.winner === null ? null : playerIdBySide.get(world.winner) ?? null;
    const msg = {
      type: "GAME_OVER",
      winnerId,
      reason
    };
    port.sendTo(hostPlayer.id, msg);
    port.sendTo(joinerPlayer.id, msg);
  }, "sendGameOver");
  const maybeEmitGameOver = /* @__PURE__ */ __name(() => {
    if (gameOverSent) return;
    if (world.phase !== "over") return;
    sendGameOver("queen");
  }, "maybeEmitGameOver");
  const ack = /* @__PURE__ */ __name((playerId, commandId, ok, reason) => {
    port.sendTo(playerId, {
      type: "COMMAND_RESULT",
      commandId,
      ok,
      ...reason !== void 0 ? { reason } : {}
    });
  }, "ack");
  const handleSubmitWords = /* @__PURE__ */ __name(async (player, commandId, paths) => {
    if (paths.length === 0) {
      ack(player.id, commandId, false, "no words submitted");
      return;
    }
    const owner = world[player.side];
    const lettersForPath = /* @__PURE__ */ __name((path) => {
      const letters = [];
      for (const h of path) {
        const tile = owner.tiles.find((t) => hexEquals(t.hex, h));
        if (!tile || !tileHasDraftableLetter(tile)) {
          return null;
        }
        letters.push(tile.letter);
      }
      return letters;
    }, "lettersForPath");
    const wordsAtSubmit = paths.map(lettersForPath);
    const validations = await Promise.all(
      wordsAtSubmit.map(async (letters) => {
        if (!letters) return false;
        return port.validateWord(letters.join(""));
      })
    );
    port.sendTo(player.id, {
      type: "WORD_RESULT",
      ownerId: player.id,
      words: paths.map((_, i) => ({
        letters: wordsAtSubmit[i] ?? [],
        valid: validations[i] ?? false
      }))
    });
    const validPaths = paths.filter((_, i) => validations[i]);
    if (validPaths.length === 0) {
      ack(player.id, commandId, false, "no valid words");
      return;
    }
    const result = applyCommand(world, player.side, {
      kind: "submitWords",
      paths: validPaths
    });
    if (!result.ok) {
      ack(player.id, commandId, false, result.reason);
      return;
    }
    world = result.world;
    ack(player.id, commandId, true);
    maybeEmitGameOver();
  }, "handleSubmitWords");
  const handleCommand = /* @__PURE__ */ __name(async (player, commandId, cmd) => {
    if (gameOverSent || world.phase === "over") {
      ack(player.id, commandId, false, "game over");
      return;
    }
    if (cmd.kind === "submitWords") {
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
  }, "handleCommand");
  const manualTick = /* @__PURE__ */ __name((stepDt) => {
    if (gameOverSent) return;
    world = tickWorld(world, stepDt, rng);
    tickCounter++;
    if (tickCounter % snapshotEvery === 0) broadcastSnapshot();
    maybeEmitGameOver();
  }, "manualTick");
  return {
    start: /* @__PURE__ */ __name(() => {
      if (interval !== null) return;
      broadcastSnapshot();
      interval = setInterval(() => manualTick(dt), tickIntervalMs);
    }, "start"),
    stop: /* @__PURE__ */ __name(() => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }, "stop"),
    receiveCommand: /* @__PURE__ */ __name(async (playerId, commandId, cmd) => {
      const player = playerById.get(playerId);
      if (!player) {
        port.sendTo(playerId, {
          type: "COMMAND_RESULT",
          commandId,
          ok: false,
          reason: "unknown player"
        });
        return;
      }
      await handleCommand(player, commandId, cmd);
    }, "receiveCommand"),
    forfeit: /* @__PURE__ */ __name((playerId) => {
      const player = playerById.get(playerId);
      if (!player || gameOverSent) return;
      const winnerSide = player.side === "self" ? "opponent" : "self";
      world = { ...world, phase: "over", winner: winnerSide };
      sendGameOver("forfeit");
    }, "forfeit"),
    manualTick,
    getWorld: /* @__PURE__ */ __name(() => world, "getWorld")
  };
}, "createGameLoop");

// src/dictionary.ts
var CACHE_MAX = 5e3;
var cache = /* @__PURE__ */ new Map();
var cacheGet = /* @__PURE__ */ __name((key) => {
  if (!cache.has(key)) return void 0;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}, "cacheGet");
var cacheSet = /* @__PURE__ */ __name((key, value) => {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== void 0) cache.delete(oldest);
  }
  cache.set(key, value);
}, "cacheSet");
var isWord = /* @__PURE__ */ __name(async (raw) => {
  const word = raw.trim().toLowerCase();
  if (!/^[a-z]{2,}$/.test(word)) return false;
  const cached = cacheGet(word);
  if (cached !== void 0) return cached;
  try {
    const resp = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
    );
    const valid = resp.ok;
    cacheSet(word, valid);
    return valid;
  } catch {
    return true;
  }
}, "isWord");

// src/roomDO.ts
var newPlayerId = /* @__PURE__ */ __name(() => Math.random().toString(36).slice(2, 10), "newPlayerId");
var sendJson = /* @__PURE__ */ __name((socket, msg) => {
  if (socket.readyState === WebSocket.READY_STATE_OPEN) {
    socket.send(JSON.stringify(msg));
  }
}, "sendJson");
var RoomDO = class extends DurableObject2 {
  static {
    __name(this, "RoomDO");
  }
  code = "";
  players = [];
  phase = "lobby";
  loop = null;
  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const code = url.pathname.split("/").pop()?.toUpperCase() ?? "";
    if (code) this.code = code;
    if (this.players.length >= 2) {
      return new Response("room full", { status: 409 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      void this.handleMessage(server, data);
    });
    server.addEventListener("close", () => {
      void this.handleClose(server);
    });
    server.addEventListener("error", () => {
      void this.handleClose(server);
    });
    return new Response(null, { status: 101, webSocket: client });
  }
  // --- helpers ------------------------------------------------------------
  broadcast(msg) {
    for (const p of this.players) sendJson(p.socket, msg);
  }
  sendRoomState() {
    this.broadcast({
      type: "ROOM_STATE",
      roomCode: this.code,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.ready
      })),
      phase: this.phase
    });
  }
  port() {
    return {
      sendTo: /* @__PURE__ */ __name((playerId, msg) => {
        const target = this.players.find((p) => p.id === playerId);
        if (target) sendJson(target.socket, msg);
        if (msg.type === "GAME_OVER") this.handleGameOver();
      }, "sendTo"),
      validateWord: isWord
    };
  }
  /** Idempotent: the loop emits GAME_OVER once per player; we only act once. */
  handleGameOver() {
    if (this.phase === "over") return;
    this.phase = "over";
    for (const p of this.players) p.ready = false;
    this.sendRoomState();
  }
  startGame() {
    const [host, joiner] = this.players;
    if (!host || !joiner) return;
    if (this.loop) {
      this.loop.stop();
      this.loop = null;
    }
    host.side = "self";
    joiner.side = "opponent";
    this.phase = "countdown";
    this.sendRoomState();
    const seed = Math.floor(Math.random() * 4294967295);
    const startedAt = Date.now();
    for (const player of this.players) {
      const opponent = this.players.find((p) => p !== player);
      if (!opponent) continue;
      sendJson(player.socket, {
        type: "GAME_START",
        selfId: player.id,
        opponentId: opponent.id,
        seed,
        tickRate: 15,
        startedAt
      });
    }
    this.phase = "playing";
    this.loop = createGameLoop(
      {
        players: [
          { id: host.id, side: "self" },
          { id: joiner.id, side: "opponent" }
        ],
        seed
      },
      this.port()
    );
    this.loop.start();
  }
  // --- inbound socket events ---------------------------------------------
  async handleMessage(socket, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      sendJson(socket, {
        type: "ERROR",
        code: "BAD_JSON",
        message: "malformed message"
      });
      return;
    }
    switch (msg.type) {
      case "HELLO": {
        if (this.players.some((p) => p.socket === socket)) return;
        if (this.players.length >= 2) {
          sendJson(socket, {
            type: "ERROR",
            code: "ROOM_FULL",
            message: "room is full"
          });
          socket.close(1e3, "room full");
          return;
        }
        const player = {
          id: newPlayerId(),
          socket,
          name: msg.playerName,
          ready: false,
          side: null
        };
        this.players.push(player);
        this.sendRoomState();
        break;
      }
      case "READY": {
        const player = this.players.find((p) => p.socket === socket);
        if (!player) return;
        if (this.phase !== "lobby" && this.phase !== "over") return;
        player.ready = true;
        this.sendRoomState();
        if (this.players.length === 2 && this.players.every((p) => p.ready)) {
          this.startGame();
        }
        break;
      }
      case "LEAVE": {
        await this.handleClose(socket);
        break;
      }
      case "COMMAND": {
        const player = this.players.find((p) => p.socket === socket);
        if (!player || !this.loop) {
          sendJson(socket, {
            type: "COMMAND_RESULT",
            commandId: msg.commandId,
            ok: false,
            reason: "no active game"
          });
          return;
        }
        void this.loop.receiveCommand(player.id, msg.commandId, msg.cmd);
        break;
      }
    }
  }
  async handleClose(socket) {
    const player = this.players.find((p) => p.socket === socket);
    if (!player) return;
    this.players = this.players.filter((p) => p !== player);
    if (this.loop) this.loop.forfeit(player.id);
    if (this.players.length === 0) {
      await this.teardown();
      return;
    }
    this.sendRoomState();
  }
  async teardown() {
    if (this.loop) {
      this.loop.stop();
      this.loop = null;
    }
    if (this.code) {
      try {
        const lobbyId = this.env.LOBBY.idFromName("singleton");
        await this.env.LOBBY.get(lobbyId).fetch("https://lobby/release", {
          method: "POST",
          body: this.code
        });
      } catch {
      }
    }
  }
};

// src/worker.ts
var lobbyStub = /* @__PURE__ */ __name((env) => env.LOBBY.get(env.LOBBY.idFromName("singleton")), "lobbyStub");
var ROOM_CODE_RE = /^\/ws\/([A-Z0-9]{4,8})$/i;
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const upstream = await lobbyStub(env).fetch("https://lobby/create", {
        method: "POST"
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": "application/json" }
      });
    }
    const wsMatch = ROOM_CODE_RE.exec(url.pathname);
    if (wsMatch) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const code = wsMatch[1].toUpperCase();
      const exists = await lobbyStub(env).fetch(`https://lobby/exists?code=${code}`);
      if (exists.status !== 200) {
        return new Response("room not found", { status: 404 });
      }
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

// ../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-epq71o/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-epq71o/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  LobbyDO,
  RoomDO,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
