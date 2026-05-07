# HIVEMIND — Design Plan

A retro-arcade word game where you command a hive of bees to harvest letters from a flower field and assemble them into chains of words on a hexagonal grid before your rival does.

> Status: design draft. Sections marked **(open)** still need decisions.

---

## 1. Tech stack

| Concern              | Choice                                              | Notes                                                                 |
| -------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| Framework            | React 18                                            | Functional components + hooks                                         |
| Language             | TypeScript                                          | Strict mode; game logic benefits a lot from types                     |
| Build / dev          | Vite                                                | Fast HMR for tweaking neon styles & GSAP timelines                    |
| State management     | Zustand                                             | Lightweight, no boilerplate, works well with game tick loops          |
| Animations           | GSAP                                                | Bee flight paths, hex pulses, chain reveal timelines                  |
| Word validation      | [dictionaryapi.dev](https://dictionaryapi.dev/)     | Cached client + server-side; whitelist for very common short words    |
| Multiplayer          | Node.js + `ws`                                      | Authoritative server; room codes; deterministic seeds                 |
| Solo fallback        | Local CPU opponent                                  | Used when no websocket connection or "VS CPU" is selected             |
| Testing              | Jest + ts-jest + React Testing Library              | Unit-test hex math, scoring, bee state machines; component snapshots  |
| Repo layout          | npm workspaces (`client`, `server`, `shared`)       | Shared types/constants between client and server                      |

> The original plan said "React and npm for framework and state management". I'm interpreting that as "React + npm packages, pick a state lib" and recommending Zustand. Easy to swap later if you'd rather use Redux Toolkit or plain context.

---

## 2. Aesthetic

- **Palette**: deep purple/black background, neon magenta and cyan primaries, hot pink accents, amber/gold for honey and successful words.
- **Type**: pixel/CRT-feel display font (`Press Start 2P` for headings, `VT323` for HUD numbers), system sans for body text.
- **Effects**: scanline overlay, bloom/glow on active hexes, subtle CRT curvature on the playfield, screen shake on big chains.
- **Hex orientation**: pointy-top. Width = `√3 · size`, height = `2 · size`, vertical spacing = `1.5 · size`.
- **Sound** *(open)*: chiptune background loop; SFX for buzz, hex activation, word cap, chain.

---

## 3. Domain model

```
Hive          central immortal hex tile per player; honey reservoir + bee launch pad
Hex tile      pointy-top hex on a player grid; states: inactive | active | letter | capped
Letter tile   active hex holding a letter glyph + Scrabble point value
Capped tile   a letter that has been included in a submitted (validated) word
Flower        hex in the central field carrying a letter; despawns when picked
Bee           transient unit dispatched from a hive; types below
```

**Honey is the only resource and the only score.** There is no HP and no
separate score variable; the size of your honey pool *is* your standing in
the match.

### Bee types

| Bee        | Purpose                                                          | Capacity  | Honey cost |
| ---------- | ---------------------------------------------------------------- | --------- | ---------- |
| Worker     | Visit each flower in the player's queue, drop letters into hive storage (radius 1) | 5 letters | 3          |
| Carpenter  | Activate inactive tiles adjacent to active                       | 2 hexes   | 5          |
| Drone      | Cap a sequence of placed letters as a word                       | 2 caps    | 7          |

A bee despawns when its capacity is exhausted. Bees in flight are uninterruptible. Workers fly hive→flower→hive→flower→…→hive, dropping each letter into the next empty storage slot; if they reach a flower the rival has already taken, they skip it and move on to the next entry in their queue.

---

## 4. Hex coordinate system

Use **axial coordinates** `(q, r)` for storage and rendering, **cube coordinates** `(x, y, z)` (with `x + y + z = 0`) for distance and neighbor math. Reference: [redblobgames hex guide](https://www.redblobgames.com/grids/hexagons/).

Core helpers (in `shared/src/hex.ts`):

- `axialToPixel(hex, size) -> {x, y}`
- `pixelToAxial({x, y}, size) -> hex` (with cube rounding)
- `neighbors(hex) -> Hex[6]`
- `distance(a, b) -> number`
- `lineBetween(a, b) -> Hex[]`
- `ring(center, radius) -> Hex[]`

Player grid:

- **Radius 0** — central `'hive'` tile. Not playable. Bees launch from and return to here. Visually distinct (gold, glowing).
- **Radius 1** — 6 `'storage'` slots. Workers deliver letters into these slots (max 6 letters at a time). Visually distinct: smaller hexes with a dashed amber outline when empty, filled with a soft honey glow when occupied.
- **Radius 2** — 12 `'active'` tiles seeded at start. The player drags a letter from a storage slot onto an empty active tile to **place** it. Once placed, the letter is locked and the tile becomes `'letter'`.
- **Frontier** — *not* a fixed ring. Any hex adjacent to one of your `active` / `letter` / `capped` tiles is part of the **frontier**, derived on the fly by the renderer. Clicking a frontier hex adds it to the carpenter queue; once activated, the hive owns one more `active` tile and the frontier shifts outward. **The hive can grow indefinitely** — there's no hard radius cap, only the practical limit of fitting on screen (the SVG auto-scales).

The player's controls (queue, SEND WORKER, word builder, SUBMIT) live in the side panels flanking the hive grid.

Flower field: a radius-4 hex grid (61 tiles) hosting exactly **3 flower patches** at all times.

---

## 5. Gameplay loop

### Panels

Three swipeable / keyboardable panels:

1. **Your hive** (left, default key `1`)
2. **Flower field** (center, key `2`)
3. **Opponent hive** (right, key `3`, read-only)

Mouse: drag to swipe. Touch: native swipe. Keyboard: `1/2/3` or `←/→`.

### Real-time vs turn-based

**Real-time with cooldowns.** Matches the arcade feel and keeps both players engaged. Every action goes through the bee economy:

1. Hive passively generates **honey** at `regenPerHex` (0.04 / sec) × your owned tile count. A starter hive (19 tiles) trickles in ≈0.76 / sec; a fully expanded hive ticks faster.
2. Honey is stored up to a per-player **cap** = `capBase (10) + capPerEmptyTile (2) × emptyActiveCount`. Empty active tiles are your *honeycomb* — the more open cells you have, the more honey you can stash. Filling a tile with a letter (or capping it into a word) shrinks your headroom.
3. Spend honey to spawn bees (see costs above).
4. Issue an order (target flower / target tile / target word) — bee animates 1.0–1.8s flight.
5. Effects resolve when the bee lands. Capping a word pays a **honey bonus** equal to the word's score (or `(w1 + w2) × 1.5` for a chain) — clamped to your current cap, so timing matters.

### Flower patches

- Each patch is a six-petal arrangement around an unused **center** hex. Each petal is one pickable letter on its own hex.
- Three patch types, each drawing from its own letter pool:
  - **vowel** — A E I O U (pink). The bottleneck letters; high demand.
  - **common** — R S T L N D (cyan). Reliable workhorses.
  - **rare** — B C F G H J K M P Q V W X Y Z (magenta). High variance, big payoffs when you hit a J/Q/X/Z.
- Within each pool, draws stay weighted by the underlying Scrabble counts so a vowel patch still tilts toward A/E and a rare patch only rarely surfaces a Q or Z.
- Patches **wither** over their lifetime (~28s): petals fall off in random order, one every few seconds, until either bees collect them all or the patch is empty. As a petal nears its `witherAt` time it visibly fades and shrinks.
- Exactly **3 patches** are alive in the field at all times; when one despawns, a fresh one of a random type spawns elsewhere after a brief delay. Centers are kept ≥ 3 hexes apart so petal rings don't overlap.

### Letter selection (the queue)

- Tap any **petal** in the field to add it to your queue. Tap again to remove.
- Queue is capped at the worker capacity (5).
- Both players' queues are visible to each other — yours is gold, the rival's is pink.
- Press **SEND WORKER** to spend 3 honey, dispatch a worker, and clear the queue. The bee visits each queued petal in order.
- If a petal is gone when your bee arrives (collected by the rival, withered, or its patch despawned), your bee skips it and moves on to the next entry.

### Letter placement

- Workers deliver each fetched letter into the next empty storage slot (radius 1). If all 6 are full when the bee arrives, the letter is **lost** — keep storage moving.
- The player drags a letter from a storage slot onto any empty active tile (radius 2). Two interactions live on the same hive grid; the engine distinguishes them by where the drag *starts*:
  - drag from **storage** → letter-move (drop targets glow cyan; a pointer-following ghost shows the letter being carried).
  - drag from a **letter tile** → word-draft (existing behavior).
- Once a letter is placed, the tile becomes `'letter'` and the letter is locked there until it's capped.

### Word formation

- A **word** is a path of `letter` or `capped` tiles where consecutive tiles are hex-adjacent and form a contiguous letter sequence.
- Like Scrabble, a single letter tile can serve as the start of multiple branching words (e.g. an `A` shared by `BAT` and `CART`). Once a tile is `capped`, it remains on the board and can be reused as a branch point in future drafts.
- The player drafts up to **two** word paths per drone submission (drone capacity = 2). Each draft is committed when the user releases the pointer; the next pointer-down on a letter/capped tile starts the second word.
- Each drafted word is asynchronously validated against [dictionaryapi.dev](https://dictionaryapi.dev) — results are cached for the session. The word builder shows ✓ / ✗ / `…` (pending) per word.
- On **SUBMIT**, only valid words are dispatched to the drone. Invalid words are surfaced in the error line; their tiles stay as `letter` (not capped). On a network error the lookup falls back to "valid" so play stays unblocked offline.

### Carpenter bees & unbounded growth

- Any hex adjacent to one of your `active` / `letter` / `capped` tiles is a **frontier** hex, derived on the fly. Tap one to add it to the **build queue** (cap = 2). Eligible tiles glow with a dashed cyan stroke; queued tiles get a numbered cyan badge.
- Press **SEND CARPENTER** to spend 5 honey and dispatch one carpenter bee. The bee flies hive → target₁ → target₂ → hive, activating each tile.
- The hive grows **without a fixed radius cap** — every newly-active tile pushes its own ring of frontier hexes outward, so you can keep building as long as you have honey and screen real estate. The SVG auto-scales as the hive grows so the panel stays in frame.

### Chains

If a drone caps multiple words **on the same flight** (capacity 2), and the words share at least one letter, the chain bonus applies: total score = `(w1 + w2) · 1.5` (see scoring). Two words submitted together that don't share a tile still both get capped — they just don't pay the bonus.

---

## 6. Scoring (= honey payouts)

```
wordScore = sum(letterValue) · lengthMultiplier
```

| Length | Multiplier |
| ------ | ---------- |
| ≤ 4    | 1.0×       |
| 5–6    | 1.5×       |
| 7–8    | 2.0×       |
| 9+     | 3.0×       |

Letter values: standard Scrabble distribution (`shared/src/letters.ts`).

`wordScore` is paid out as **honey** when the drone caps the word. There is no separate "score" track.

**Chain bonus**: if a drone caps two words that share a letter on one flight, total honey = `(w1 + w2) · 1.5`.

Honey from word caps is **clipped at the cap**: spamming words while you're already maxed out wastes the bonus. Keep empty actives (or grow the hive) to widen the ceiling before payday.

**Special tiles** *(open)*: occasional double-letter / triple-word hexes spawned on the frontier to encourage carpenter use.

---

## 7. Win condition

Pure honey race against the clock:

- **Time limit**: 5-minute round.
- **Win**: highest honey total when the timer expires.
- **Tiebreaker 1**: largest hive (most owned tiles).
- **Tiebreaker 2**: stalemate.

There is no instant-loss mechanic — both hives play out the full round.

---

## 8. Bee behavior detail

| Step | Worker                                  | Carpenter                              | Drone                                                |
| ---- | --------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| 1    | Player taps flower in center field      | Player taps inactive tile (must be    | Player drags across letter path (must be contiguous |
|      |                                         |  adjacent to active)                   |  + adjacent + a complete word)                       |
| 2    | Player taps target empty active tile   | Bee flies, lands, hex pulses → active  | Bee flies along the path                            |
| 3    | Bee flies flower→hive→tile, drops letter|                                        | Each letter caps as bee passes                      |
| 4    | Capacity decremented; if 0, despawn     | Capacity decremented; if 0, despawn    | Word validated; on success → honey bonus + tiles capped; on fail → letters un-cap and tile flashes red |

Bees queue: while one bee is in flight, you can immediately issue more orders. Multiple bees can be airborne simultaneously.

---

## 9. Flower field

- Radius-4 hex grid (61 cells).
- Always exactly **3 flower patches**. Each patch is a 6-petal arrangement around an unused center hex (so 1 patch = 7 hexes total, 6 of them pickable).
- Each patch is one of three types — `vowel`, `common`, `rare` — and draws each petal's letter from that type's pool, weighted by the underlying Scrabble distribution.
- Patches **wither** over their `PATCH_LIFETIME_SECONDS` (~28s): petal `witherAt` times are spread across the second half of the lifetime, with a small jitter, in random order. Petals fade and shrink as their drop time approaches.
- A patch despawns when its last petal is gone (collected or withered). A new patch of a random type spawns ~1.5s later in a non-overlapping slot — centers must be ≥ 3 hexes apart so petal rings never collide.
- Server is authoritative for the bag, seed, and patch lifecycle in multiplayer.

---

## 10. Multiplayer / networking

- WebSocket server (Node + `ws`).
- **Lobby**: 6-character room code; first to join is host.
- **Server-authoritative** for: random seeds, flower spawns, dictionary calls, honey balances + caps.
- **Client-predictive** for: bee flight visuals, swipe transitions.
- **Reconciliation**: server snapshots tick at 5Hz; clients reconcile with the latest snapshot.

### Message types (`shared/src/messages.ts`)

```
C→S: JOIN_ROOM, READY, SPAWN_BEE, ASSIGN_BEE_TARGET, SUBMIT_WORD, LEAVE
S→C: ROOM_STATE, GAME_START, TICK, BEE_EVENT, FLOWER_EVENT, WORD_RESULT, GAME_OVER, ERROR
```

### Disconnect handling

- 10s reconnect grace window; if it expires, opponent wins by default.
- If WebSocket can't connect on game start, immediately offer "VS CPU".

---

## 11. CPU opponent

Three difficulty levels.

| Level  | Letter selection           | Word selection                              | Reaction time |
| ------ | -------------------------- | ------------------------------------------- | ------------- |
| Easy   | Random                     | Random valid 3–4 letter from common list    | 3–6s          |
| Medium | Highest-value bias         | Trie-based 4–6 letter; one-step lookahead   | 1.5–3s        |
| Hard   | Targeted to enable chains  | Trie + branch detection + chain planning    | 0.7–1.5s      |

Implemented in `client/src/game/ai/` so single-player works without the server.

---

## 12. Word validation

- Try `https://api.dictionaryapi.dev/api/v2/entries/en/<word>`.
- Cache by lowercased word in `localStorage` (client) and an LRU map (server).
- Multiplayer: client sends `SUBMIT_WORD`, server validates against cache or API and broadcasts the result.
- Maintain a small whitelist (`shared/src/whitelist.ts`) for very common words the API sometimes 404s on.

---

## 13. Project structure

```
hivemind/
├── package.json              (root, npm workspaces)
├── tsconfig.base.json
├── plans.md
├── README.md
├── shared/
│   ├── package.json
│   └── src/
│       ├── hex.ts            (axial/cube math, neighbors, distance)
│       ├── letters.ts        (Scrabble bag + values)
│       ├── messages.ts       (WS message types)
│       └── index.ts
├── client/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── styles/           (neon palette, scanlines, fonts)
│       ├── components/
│       │   ├── Panels/       (PanelDeck, swipe controller)
│       │   ├── HiveGrid/
│       │   ├── FlowerField/
│       │   ├── Hud/
│       │   └── Bee/
│       ├── game/
│       │   ├── engine/       (tick loop, scoring, word resolution)
│       │   ├── ai/           (CPU opponent)
│       │   └── net/          (websocket client, reconciliation)
│       └── state/            (Zustand stores)
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          (ws server bootstrap)
│       ├── rooms.ts          (lobby + room lifecycle)
│       └── dictionary.ts     (validation + cache)
└── __tests__/                (project-wide integration tests)
```

---

## 14. Testing strategy

- **Unit**: hex math, letter bag draws, scoring, word path validation, bee state machines.
- **Component**: HiveGrid renders given a state, BeePath animates correct path.
- **Integration**: simulate a full round vs CPU; assert win condition resolves.
- **Coverage target**: 80% on `shared/` and `client/src/game/`.

---

## 15. Milestones

1. **M1 — Skeleton** _(done)_: workspace scaffolding, three-panel layout, hex grid renders, Zustand store wired, jest passes.
2. **M2 — Solo loop** _(done)_: flower spawning + regrow, hive tile + 6 storage slots + ring-2 active tiles + panel-side UI (queue, SEND WORKER, word builder), per-player letter queue with first-bee-wins races, multi-phase worker bees (hive→flower→hive→…) delivering into storage, drag-from-storage letter placement with pointer-following ghost, drag-to-form-word drone caps, cross-panel bee animations via global overlay, fixed-timestep tick loop, dummy AI.
3. **M3 — Full mechanics** _(done)_: carpenter bees with build queue (tap frontier → SEND CARPENTER, capacity 2 per flight) for unbounded hive expansion, drone supports up to 2 word paths per flight with chain ×1.5 bonus when paths share a tile, capped tiles are reusable branch points (drafts walk through `letter` and `capped`), async dictionary validation against dictionaryapi.dev with per-session cache and ✓/✗/`…` UI on the word builder, AI also dispatches carpenters to grow its hive. Special tiles deferred to M4.
4. **M3.5 — Honey-only economy** _(done)_: HP and score variables removed; honey is the sole resource. Regen scales with owned hex count; cap scales with empty active tiles; word caps pay honey bonuses (clamped to cap).
5. **M4 - Queen mechanic _(done)_: Added queen that can spawn and attack enemy hive. Win condition is queen touching enemy hive.
7. **M5 — Multiplayer**: ws server, lobby, authoritative ticks, reconciliation.
6. **M6 — CPU**: easy/medium/hard AI replacing the M3 dummy.
8. **M7 — Polish**:  GSAP timelines for bee flight + chain reveal, special bonus tiles (double-letter / triple-word), polish neon styling, scanline overlay, sound.

---

## 16. Open questions

- **Sound design**: tracker/chiptune library or hand-rolled WebAudio?
- **Account/persistence**: any progression (cosmetic hives, bee skins) or strictly arcade single-session?
- **Spectator mode**: trivial to add given authoritative server — desirable?
