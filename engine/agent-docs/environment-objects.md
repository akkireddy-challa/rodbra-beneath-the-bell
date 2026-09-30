# Environment Objects — querying placements, binding gameplay, baked-level rules

`environmentObjects[]` in world.json (trees, rocks, huts, placed props) are rendered by the engine's `EnvironmentObjectSystem` as **per-type `InstancedMesh`es**. This doc covers how gameplay code reads those placements, what it can and cannot do with them, and the rules that change on a forged/baked level. Read this BEFORE grepping `EnvironmentObjectSystem.ts` — the file is 3300 lines and most of it is editor/serialization internals you don't need.

## The two placement paths — pick the right one

| | Declarative `environmentObjects[]` | Runtime `engine.spawnAsset()` |
|---|---|---|
| Authored in | world.json (asset-edit subagent / world forger) | game code, at runtime |
| Rendered as | shared `InstancedMesh` per type | individual `VoxelObject` per spawn |
| Can be removed/moved/hidden by game code | **NO** (see below) | **YES** — you own the returned object |
| Collectible/pickup wiring | no | yes (`collectible` option) |
| Cost per instance | ~free (instanced) | one object each — fine for dozens, not thousands |

**Rule of thumb:** scenery the player looks at → world.json. Objects gameplay consumes (pickups, drops, respawning resources, destructibles) → `spawnAsset` (see `@docs collectible-objects.md` and `engine/AssetSpawner.ts`).

## Reading placements: `gameData.environmentObjects` is the authoritative list

Gameplay that needs to know **where props are** (spawn coconuts near palms, count trees in a region, find the nearest boulder) reads `gameData.environmentObjects` — the same array the level installer wrote. Do NOT traverse the scene, and do NOT try to read positions back out of the InstancedMeshes (wrong in packed mode, see the culling warning below).

Each entry:

```ts
{
  id: string,             // "inst_…"
  type: string,           // registered type name, e.g. "CoconutPalms", "VolcanicBoulders"
  assetId?: string,
  position: { x, y, z },  // world meters; baked levels bake explicit y
  rotation: { x, y, z },  // Euler radians
  scale: { x, y, z },
  levelId?: string,       // present on multi-level games — filter by active level
}
```

```ts
// e.g. in a game system constructed with gameData (see @docs world-json-loading)
const palms = (this.gameData.environmentObjects ?? [])
    .filter(o => o.type === 'CoconutPalms');
for (const palm of palms) {
    // proximity gameplay against palm.position …
}
```

Filter by `type`. On a forged level the type names are the library archetype names from the forge spec (`JungleCanopyTrees`, `ShoreRocksAndDriftwood`, …) — list what exists with `worldJsonInspectTool` or `getRegisteredTypeNames()` rather than guessing.

## What game code CANNOT do to a placed instance

Placed environment objects are slots in a shared `InstancedMesh` (scene name `<Type>_instanced`). For LOD-instanced types the engine's `updateInstanceCulling` **repacks the instance buffer every frame** from a private authoritative matrix list:

- You cannot hide, move, or remove a single instance from game code. A `setMatrixAt()` you write is overwritten on the next culling pass.
- `getMatrixAt(i)` does not return logical instance `i` once culling has run. If you must read matrices (serialization-style code), call `environmentObjectSystem.restoreLogicalInstanceMatrices()` immediately before — but for gameplay, use `gameData.environmentObjects` instead.
- `unpackInstancedMeshes()` / `packInstancedMeshes()` are **Scene-editor transitions owned by EditorManager**. Never call them at runtime — unpacking turns thousands of instances into individual meshes and disables culling.

**If gameplay needs a prop to disappear** (chopped tree, looted chest), either:

1. Spawn it via `engine.spawnAsset()` in the first place — then remove it like any object you own; or
2. Keep the baked prop standing and gate it in game state: track harvested ids in a `Map`, put them on a cooldown, stop yielding while "depleted". The prop stays visible; the HUD tells the story. This is the standard pattern for baked levels.

## Useful runtime queries

Get the system via the template's generator: `worldGenerator.getEnvironmentObjectSystem()` (nullable — guard it).

- `isPositionOccupied(x, z, checkRadius?, maxObjectRadius?)` — true if a placed object's clear radius overlaps. Use before spawning pickups/NPCs so they don't clip into a tree. `maxObjectRadius` skips enclosure-scale footprints (a colosseum registers its whole bounding box, covering its own playable interior).
- `registerPlacedPosition(x, z, radius)` — make your own spawned objects visible to the occupancy queries above.
- `getAllPlacedPositions()` — every placement `{x, z, radius}`; used e.g. to mark nav-mesh obstacles.
- `getRegisteredTypeNames()` / `getInstanceCount(typeName)` — what types exist and how many of each.
- `getEnvTypeForObject(object3d)` — reverse-lookup which type a raycast-hit mesh belongs to (returns the type name or null). This is how you classify "the player's crosshair is pointing at a boulder": raycast, then map the hit object to a type — do NOT parse mesh names.

## Baked (forged) levels: mining is NOT auto-wired

`VoxelMiningSystem` is created inside `DynamicObjectManager.setTerrainSystem(voxelTerrain)`, and the genre `Game.ts` only makes that call when `worldGenerator.getVoxelTerrainSystem()` returns non-null. A forged `.vwld` level has **no `VoxelWorld`** — terrain is `VxlSceneTerrainSystem` — so on baked levels:

- `getVoxelTerrainSystem()` is null → `setTerrainSystem()` never runs → **no `VoxelMiningSystem` exists**.
- `PlayerToolSystem`'s swing bails silently (`if (!mining) return`): the axe animates, hits nothing, and no error appears anywhere. If chopping "does nothing" on a baked level, this is why.
- Even if a mining system existed, its name-based block classification cannot tell forged archetypes apart (`JungleCanopyTrees_instanced` and `JungleBushes_instanced` both tokenise to `jungle`).

**Recipe for harvesting on a baked level** (chop trees for wood, mine boulders for stone):

1. Keep `PlayerToolSystem` for the in-hand tool + swing animation — that part works everywhere (`@docs voxel-mining.md`).
2. Resolve hits yourself against `gameData.environmentObjects`: on each swing, find the nearest entry of a harvestable `type` within reach and in front of the player.
3. Track HP / yields / cooldowns per entry `id` in game state; credit resources through your inventory + HUD.
4. Don't try to make the harvested prop vanish (see above) — deplete it in state, optionally respawn its yield on a timer.

On PROCEDURAL voxel terrain none of this section applies: mining auto-wires exactly as `@docs voxel-mining.md` describes.

## Registering new procedural types

To add a new cube-based environment object type (bushes, crystals, logs) on procedural terrain, implement `EnvironmentObjectType` and call `environmentObjectSystem.registerEnvironmentObjectType(type)` — the system then handles procedural spawning, serialization, and editor pack/unpack automatically. See `registerTreeType()` / `registerRockType()` in the template's `EnvironmentObjects.ts` for complete examples. For one-off placed assets, prefer world.json entries or `spawnAsset` — don't register a type for a single instance.
