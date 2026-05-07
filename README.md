# HIVEMIND

A retro-style arcade game mixed with Scrabble. Amass your bee army and create longer chains of words to defeat your rival hive.

See [`plans.md`](./plans.md) for the full design doc.

## Workspace layout

```
hivemind/
├── shared/         shared types, hex math, scoring, message protocol
├── client/         React 19 + Vite + Zustand + GSAP front-end
├── server/         Cloudflare Worker + Durable Objects (LobbyDO + RoomDO)
├── wrangler.jsonc  Cloudflare deployment config (Worker, DOs, [assets])
└── jest.config.cjs multi-project test runner
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

| Command              | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| `npm run dev`        | Start client + worker dev server in parallel               |
| `npm run dev:client` | Start only the Vite dev server (proxies `/ws` and `/api` to `:8787`) |
| `npm run dev:server` | Start only `wrangler dev` (Worker + DOs on `:8787`)         |
| `npm run build`      | Build shared, client, and server                           |
| `npm run deploy`     | Build the SPA and `wrangler deploy` the Worker             |
| `npm test`           | Run all jest projects (shared, client, server)             |
| `npm run lint`       | Type-check the whole monorepo (`tsc -b`)                   |

## Deploying to Cloudflare

The whole stack runs on a single Cloudflare Worker:

- The built Vite SPA in `client/dist` is served via the Worker's `[assets]`
  binding (with SPA fallback to `index.html`).
- `POST /api/rooms` mints a fresh room code via the singleton `LobbyDO`.
- `GET /ws/<code>` upgrades to a WebSocket and forwards to `RoomDO(code)`,
  which owns the authoritative `GameLoop` + 1–2 player sockets.

### One-time setup

1. Install the Wrangler CLI (already a workspace devDependency) and log in:
   ```bash
   npx wrangler login
   ```
2. Push this repo to GitHub.
3. In the Cloudflare dashboard, go to **Workers & Pages → Create → Connect to Git**,
   pick the repo, and configure:
   - Build command: `npm install && npm run build:shared && npm run build:client`
   - Deploy command: `npx wrangler deploy`
   - Production branch: `main`

   (The `build:server` step only runs `tsc -b` for type-checking — Wrangler
   bundles `server/src/worker.ts` itself, so it's not strictly needed for
   deploy. Including it catches type errors before the deploy command runs.)

That's it. Pushes to `main` deploy automatically; PRs get preview URLs.

### Manual deploy

```bash
npm run deploy
```

This runs the SPA build then `wrangler deploy`. The Durable Object migrations
in `wrangler.jsonc` create the SQLite-backed `LobbyDO` / `RoomDO` namespaces on
first deploy.

## Status

Tracking against `plans.md` milestones:

- [x] **M1** — Workspace + tooling, hex math + Scrabble bag + scoring, three-panel UI, WS server stub
- [x] **M2** — Solo loop: fixed-timestep tick, honey regen, flower respawn, worker bees deliver letters, drag-to-form-word drone caps, dummy AI
- [x] **M3** — Carpenter bees + build queue, branches through capped tiles, multi-word drone caps with chain ×1.5 bonus, async dictionary validation against dictionaryapi.dev with cached ✓/✗/`…` feedback
- [x] **M3.5** — Honey-only economy: HP and score variables retired, regen scales with hive size, cap scales with empty active tiles, word caps pay honey bonuses, victory by highest honey at timer end
- [ ] **M4** — GSAP feel pass, special bonus tiles, sound, animation polish
- [ ] **M5** — Real CPU AI (easy/medium/hard)
- [ ] **M6** — Authoritative multiplayer
- [ ] **M7** — Balance, accessibility, tutorial

## How to play (M3.5 solo)

- `1` / `2` / `3` (or arrow keys) to switch between your hive, the flower field, and the rival hive.
- **Honey is the only resource and the only score.**
  - Your hive trickles in honey at `0.04 / sec × number of owned hex tiles` (~0.76/sec on a fresh hive, faster as you build).
  - Honey is stored up to a cap of `10 + 2 × emptyActiveTileCount`. Empty active tiles are your honeycomb — placing letters or capping words shrinks your headroom; carpenters can grow it back out.
  - Every word you cap pays a **honey bonus** equal to the word's score. Two words on one drone flight that share a tile pay `(w1 + w2) × 1.5`. Bonuses are clamped to your current cap, so timing matters — if you're already maxed out you'll lose the spillover.
- **Win**: highest honey when the 5-minute timer expires. Tiebreak: largest hive. Otherwise stalemate. There is no instant-loss; both hives play out the round.
- Your hive starts as the central **hive tile** (gold) plus two rings:
  - 6 **storage slots** (dashed amber) at radius 1 — workers deliver fetched letters here. Holds up to 6 letters.
  - 12 **active tiles** (purple) at radius 2 — empty placement targets and cap headroom.
  - **Frontier** (dim, dashed-cyan stroke) — every hex touching your active hive is a buildable frontier hex. **There is no hard radius cap** — keep activating tiles to grow outward indefinitely (more regen, more cap, more board space). The grid auto-scales as it grows.
- The **flower field** holds exactly **3 patches** at all times. Each patch is a six-petal ring around an unused center hex, and is one of three types:
  - **vowel** (pink) — A E I O U. The bottleneck letters; high demand.
  - **common** (cyan) — R S T L N D. Reliable workhorses.
  - **rare** (magenta) — B C F G H J K M P Q V W X Y Z. High variance, big payoffs when you hit a J/Q/X/Z.
- Patches **wither**: petals fade and shrink as their drop time approaches, then fall off one by one. When a patch is empty (collected or fully withered), a fresh one spawns elsewhere a beat later. Get there before they wither.
- **Hold a petal** for 1 second to dispatch a worker (3 honey). A yellow border draws around the hex as the timer fills, then stays on as a "claimed" marker for the rest of the bee's flight. Rival claims show up as a dashed pink outline so contested petals are obvious at a glance. The bee flies hive → petal → hive, drops the letter into the next empty storage slot, and despawns. Holds can be aborted by lifting your finger or dragging it off the petal. **If the petal is gone when your bee arrives — the rival took it, or it withered — your bee just heads home.** Trying to hold without enough honey, or with no empty storage to land a letter in, plays a brief red flash and a contextual popup (e.g. "not enough honey") that drifts up out of the hex you just touched.
- On your hive, **drag a letter out of a storage slot onto an empty active tile** to place it. Empty active tiles glow cyan as drop targets while you drag, and a ghost letter follows your pointer. Once placed, the letter is locked.
- **Grow your hive**: hold a frontier hex (any dim hex touching your active hive) for 1 second to dispatch a carpenter (5 honey). One hold = one new tile, expanding your regen, your cap (while empty), and the frontier outward. The yellow outline persists on the hex until the carpenter arrives.
- To score, **drag across adjacent placed letters** (and any already-capped tiles, which act as branch points) to draft a word. **Drag a second time** to draft a second word — drone capacity is 2. Drafted words appear in the right panel with a `✓`/`✗`/`…` validation badge as the dictionary lookup resolves.
- Press `SUBMIT` to spend 7 honey on a drone that caps every valid word. Each capped word pays its score back to you as honey; chains pay 1.5×.
- A dummy AI on the rival side periodically dispatches workers and carpenters, places letters, and scores phantom words for honey. It exists only as a moving target; the real AI lands in M5.

### Layout & feedback

- The whole UI is **fluid** — the hex stage uses `vmin` so it scales to whatever screen you're on, and the player panel collapses from a three-column layout (controls · grid · words) to a single column with the controls and word panel as compact toolbars above and below the grid when there's no horizontal room (≤ 720px wide). Phones in portrait get a usable layout out of the box.
- All command-refusal feedback is **contextual**: if a hold or letter placement or word submit fails, a small red popup ("not enough honey", "storage full", "not in dictionary: BLERG") rises out of the hex you just touched and fades away, instead of a single shared status line. The toast is anchored to the tile via the same cross-panel coordinate registry the bee overlay uses, so it tracks correctly even while the panel deck is sliding.
