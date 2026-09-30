# Multi-level games (worldProfileData.levels)

A game may hold several baked `.vwld` levels and switch between them at runtime. One level is
active at a time; the whole multiplayer session shares it.

## Data model (asset-side)

- `worldProfileData.levels[]`: `{ id, name, vwldAssetId, spawnPoints?, overrides? }` +
  `worldProfileData.startLevelId`. Manage entries with the `manage-levels` tool (list / create /
  rename / setStart / delete) — it enforces every invariant below.
- A level references an `assets[]` entry of `type: 'vwld'` (from the world-forger or the level
  voxelizer). Deleting a level keeps the asset in the library.
- Placed objects (`environmentObjects[]`) and spawn points tagged with `levelId` belong to that
  level; untagged instances are global (appear in every level). Live placements are tagged with
  the active level automatically.
- The level the user has OPEN in the editor is named in the system prompt's **Open Level**
  section (the creator sends it with every prompt). A request that doesn't name a level means
  that one — not the start level.
- In levels mode a level's spawn points live ON ITS LEVEL ENTRY: update `levels[]` (predicate by
  `id`), not the global `spawnPoints` array. The global `spawnPoints`, `playerSpawnPosition` and
  `voxelUrl` always MIRROR the start level (maintained by the tools) — never hand-edit them in a
  levels-mode game. A level without its own spawn points falls back to the global set.
- `overrides` re-skins atmosphere per level: `skyboxUrl`, `fogConfig`, `lightingConfig`,
  `weatherConfig`, `waterLevelY` (applied over the game globals while the level is active).

## Runtime API (game code)

- `engine.loadLevel(levelId, { spawnPointId?, networked? })` — fades out, swaps terrain + the
  level's objects + atmosphere, respawns the player at the level's spawn, fades in. Rejects on
  unknown level/missing asset and while another switch is in flight. Calling it with the ACTIVE
  level id reloads it (arena reset).
- `engine.getLevels()`, `engine.getActiveLevelId()`, `engine.prefetchLevel(levelId)` (warm the
  next arena's download during a round).
- Events: `engine.getLevelManager()?.onLevelWillUnload(cb)` / `.onLevelDidLoad(cb)`. Despawn
  game-code-owned entities (NPCs, vehicles, projectiles) in `onLevelWillUnload`; per-level music
  goes in `onLevelDidLoad` via `playMusic`.
- Multiplayer: `loadLevel` broadcasts to the room and late joiners converge automatically. Gate
  switch calls on your authority model (the host / room owner) so clients don't race.

## Constraints

- Levels are baked `.vwld` assets. An authored mesh level (`mesh-level.md`) is single-level: a game
  with several disposes one `MeshLevel` and loads the next itself.

- Levels must be current-format baked levels (VLSC `.vwld`). Procedural-terrain games and
  legacy-format bakes cannot switch — re-bake first.
- Multi-level does not combine with `persistentWorld` (procedural-only) or Gaussian-splat
  environment scenes.
