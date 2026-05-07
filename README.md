# HIVEMIND

A retro-style arcade game mixed with Scrabble. Amass your bee army and create longer chains of words to defeat your rival hive.

See [`plans.md`](./plans.md) for the full design doc.

## Workspace layout

```
hivemind/
├── shared/   shared types, hex math, scoring, message protocol
├── client/   React 19 + Vite + Zustand + GSAP front-end
├── server/   Node + ws lobby/room server
└── jest.config.cjs   multi-project test runner
```

Managed with npm workspaces.

## Prerequisites

- Node.js 20+ (developed on Node 22)
- npm 10+

## Quickstart

```bash
npm install
npm run dev          # runs client (vite) and server (ws) in parallel
```

Open http://localhost:5173 — the client will boot into a local solo state with the three-panel layout (your hive, flower field, opponent hive). Use keys `1` / `2` / `3` or arrow keys to switch panels.

## Useful scripts

| Command            | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `npm run dev`      | Start client + server in parallel                            |
| `npm run dev:client` | Start only the Vite dev server                              |
| `npm run dev:server` | Start only the websocket server                             |
| `npm run build`    | Build shared, client, and server                             |
| `npm test`         | Run all jest projects (shared, client, server)               |
| `npm run lint`     | Type-check the whole monorepo (`tsc -b`)                     |

## Status

Tracking against `plans.md` milestones:

- [x] **M1** — Workspace + tooling, hex math + Scrabble bag + scoring, three-panel UI, WS server stub
- [x] **M2** — Solo loop: fixed-timestep tick, honey regen, flower respawn, worker bees deliver letters, drag-to-form-word drone caps, scoring + HP damage, dummy AI, win condition
- [x] **M3** — Carpenter bees + build queue, branches through capped tiles, multi-word drone caps with chain ×1.5 bonus, async dictionary validation against dictionaryapi.dev with cached ✓/✗/`…` feedback
- [ ] **M4** — GSAP feel pass, special bonus tiles, sound, animation polish
- [ ] **M5** — Real CPU AI (easy/medium/hard)
- [ ] **M6** — Authoritative multiplayer
- [ ] **M7** — Balance, accessibility, tutorial

## How to play (M3 solo)

- `1` / `2` / `3` (or arrow keys) to switch between your hive, the flower field, and the rival hive.
- Your hive starts as the central **hive tile** (gold) plus two rings:
  - 6 **storage slots** (dashed amber) at radius 1 — workers deliver fetched letters here. Holds up to 6 letters.
  - 12 **active tiles** (purple) at radius 2 — empty placement targets.
  - **Frontier** (dim, dashed-cyan stroke) — every hex touching your active hive is a buildable frontier hex. **There is no hard radius cap** — keep activating tiles to grow outward indefinitely. The grid auto-scales as it grows.
- The **flower field** holds exactly **3 patches** at all times. Each patch is a six-petal ring around an unused center hex, and is one of three types:
  - **vowel** (pink) — A E I O U. The bottleneck letters; high demand.
  - **common** (cyan) — R S T L N D. Reliable workhorses.
  - **rare** (magenta) — B C F G H J K M P Q V W X Y Z. High variance, big payoffs when you hit a J/Q/X/Z.
- Patches **wither**: petals fade and shrink as their drop time approaches, then fall off one by one. When a patch is empty (collected or fully withered), a fresh one spawns elsewhere a beat later. Get there before they wither.
- Tap any **petal** to queue it for your next worker (gold badge = yours, pink badge = the rival's). Tap again to remove. Queue is capped at 5.
- Press `SEND WORKER` (left side of your hive panel) to spend 3 honey. A bee flies hive → petal → hive → petal → …, dropping each letter into the next empty storage slot. **If a petal is gone when your bee arrives — the rival took it, or it withered — your bee skips it and moves on.**
- On your hive, **drag a letter out of a storage slot onto an empty active tile** to place it. Empty active tiles glow cyan as drop targets while you drag, and a ghost letter follows your pointer. Once placed, the letter is locked.
- **Grow your hive**: tap a frontier hex (any dim hex touching your active hive) to add it to the build queue (cap = 2). It gets a numbered cyan badge. Press `SEND CARPENTER` to spend 5 honey on a bee that flies out and activates each queued tile in order — this also expands the frontier outward, so you can keep building.
- To score, **drag across adjacent placed letters** (and any already-capped tiles, which act as branch points) to draft a word. **Drag a second time** to draft a second word — drone capacity is 2. Drafted words appear in the right panel with a `✓`/`✗`/`…` validation badge as the dictionary lookup resolves.
- Press `SUBMIT` to spend 7 honey on a drone that caps every valid word. If both words share a tile, you get a **chain ×1.5 bonus** on top of the combined score.
- A dummy AI on the rival side queues petals, sends workers, places letters, dispatches carpenters to expand its hive, and scores phantom words. It exists only as a moving target; the real AI lands in M5.
