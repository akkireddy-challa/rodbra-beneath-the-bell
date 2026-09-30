# World-edit CLI — inspect / write / duplicate / modify / delete

The canonical surface for **environmentObject** manipulation in the running game. Runs as a CLI invoked through `execTool`. The bundled binary lives at `bin/world-edit.mjs` in the session sandbox; call it with `node bin/world-edit.mjs <subcommand> [flags]`. Output is always a single line of JSON on stdout; exit 0 means success, exit 1 means failure.

The mutating subcommands write `world.json` directly inside the session and send a fire-and-forget `RELOAD` to `ws://localhost:8082`. If the WebSocket can't be reached the file change still lands — the next game load picks it up.

Seven subcommands:

| Subcommand | Purpose | Manual-edit gate? |
|---|---|---|
| `inspect`   | Filter / list environmentObjects from world.json. Read-only, no WS. | n/a |
| `write`     | Replace the **entire** environmentObjects array. | Yes — rejected if the user has manually edited the scene. |
| `duplicate` | Filter + offsets → server-side clones with fresh IDs. | Yes |
| `modify`    | Filter + patch → bulk update positions / rotations / flags. | Yes |
| `delete`    | Filter → remove every match. | No — surgical removal is always allowed. |
| `mechanism` | `upsert` / `list` / `remove` on the top-level `mechanisms[]` array. | n/a — not environmentObjects. |
| `spawnpoint`| `upsert` / `list` / `remove` on `worldProfileData.spawnPoints[]`. | n/a — not environmentObjects. |

> **Don't re-emit objects** to do bulk work. Whenever the goal is "tile / duplicate / shift / expand / clone every X", reach for `duplicate` or `modify` with a filter — both run server-side from a tiny payload. Re-emitting 500 objects through `write` costs minutes of LLM token output for what is a ~100ms server op.

## `inspect` — read environmentObjects

```
exec node bin/world-edit.mjs inspect \
  [--filter '<json>']    # {name_prefix?, name_pattern?, region?, types?, excludeTypes?}
  [--include MODE]       # ids (default) | positions | full
  [--limit N]
```

Filter shape (every field optional; an empty filter matches everything):
- `name_prefix` — match instance `name` startswith.
- `name_pattern` — match instance `name` against a regex.
- `region` — `{minX?, maxX?, minY?, maxY?, minZ?, maxZ?}` AABB; missing bounds are `±Infinity`.
- `types` — allow-list of asset types (case-insensitive).
- `excludeTypes` — deny-list of asset types (case-insensitive). Use to skip drivable cars, the player rig, etc.

Examples:

```
exec node bin/world-edit.mjs inspect --filter '{"types":["tree_oak"]}' --include positions
exec node bin/world-edit.mjs inspect --filter '{"region":{"maxY":5}}' --include ids
exec node bin/world-edit.mjs inspect --include full --limit 10
```

## `write` — replace the entire array

Reads a JSON array of environment objects from `--file` or `--stdin`. **REJECTED** when `worldProfileData.environmentObjectsManuallyEdited === true` — fall through to `duplicate` / `modify` / `delete` in that case (or the voxel CLI for asset-aware placement).

```
exec sh -c 'node bin/world-edit.mjs write --file objects.json'
exec sh -c 'cat objects.json | node bin/world-edit.mjs write --stdin'
```

Object shape (matches the deleted Mastra tool):
```json
{
  "type": "tree_oak",          // asset name; must match an entry in world.json assets[]
  "assetId": "asset_tree_oak", // asset id;   must match an entry in world.json assets[]
  "position": { "x": 10, "y": 1, "z": 5 },
  "rotation": { "y": 1.5708 },              // RADIANS, not degrees
  "scale":    { "x": 1, "y": 1, "z": 1 },
  "name": "track_wall",
  "levelId": "level_1785291491300_6dnhrc",  // multi-level games only — see below
  "destructible": true,
  "dynamic": true,
  "interactable": true,
  "collectible": true,
  "placeOnTerrain": true,    // mutually exclusive with flattenTerrain
  "flattenTerrain": true,
  "collision": false         // default true; set false for decorative props (vegetation, etc.) the player/NPCs walk through. Per-instance value overrides the asset-level `collision` flag.
}
```

Any other field on an input record (`forcePosition`, `boundingBox`, …) is preserved verbatim, and a supplied `id` is kept — so reading the array, editing it, and writing it back is lossless. Omit `id` for new objects and one is minted.

**Multi-level games** (`worldProfileData.levels[]` non-empty): `levelId` scopes an instance to one level, and an instance **without** one is global — it loads in EVERY level. `write` replaces the array across all levels at once, so the payload must carry every level's objects, each still carrying its own `levelId`. Get both wrong and every track shows every other track's props. The command warns (never blocks) when objects arrive untagged or a level ends up empty. New objects belong to the level named in the system prompt's **Open Level** section — the one the user is looking at — unless they asked for another.

Terrain AUTO-GROWS chunk-aligned (with margin) to fit positions beyond the current `groundWorldSizeX/Z`. The starting 64×64 is a default — design at whatever scale the game needs.

Failure conditions worth knowing:
- `assetId` not in `world.json` `assets[]` → reject with the missing ids listed.
- `placeOnTerrain: true` AND `flattenTerrain: true` on the same object → reject (pick one).

## `duplicate` — server-side clones with offsets

```
exec node bin/world-edit.mjs duplicate \
  --filter '<json>' \
  --offsets '[{"dx":N,"dy"?:N,"dz":N,"rotateY"?:N}, ...]'
```

For each matched object × each offset entry: a fresh `inst_*` instance is appended with `position += {dx,dy,dz}` and `rotation.y += rotateY`. All other flags (`destructible`, `dynamic`, `interactable`, `collectible`, `placeOnTerrain`, `flattenTerrain`, `collision`, `name`, `scale`) are preserved.

Canonical example — expand the map outward in four cardinal directions:

```
exec node bin/world-edit.mjs duplicate \
  --filter '{"excludeTypes":["car","player"]}' \
  --offsets '[{"dx":100,"dz":0},{"dx":-100,"dz":0},{"dx":0,"dz":100},{"dx":0,"dz":-100}]'
```

Other useful patterns:

```
# Duplicate every prop in a region 50m to the north
--filter '{"region":{"minX":-20,"maxX":20,"minZ":-20,"maxZ":20}}' --offsets '[{"dx":0,"dz":50}]'

# Tile a city block in a 3x3 grid (8 offsets — skip the {0,0} since it's the original)
--filter '{"name_prefix":"city_a_"}' \
--offsets '[{"dx":50,"dz":0},{"dx":-50,"dz":0},{"dx":0,"dz":50},{"dx":0,"dz":-50},{"dx":50,"dz":50},{"dx":-50,"dz":-50},{"dx":50,"dz":-50},{"dx":-50,"dz":50}]'

# 4-way symmetric pinwheel: clone every barrier rotated 90/180/270°
--filter '{"name_prefix":"track_barrier_"}' \
--offsets '[{"dx":0,"dz":0,"rotateY":1.5708},{"dx":0,"dz":0,"rotateY":3.1416},{"dx":0,"dz":0,"rotateY":4.7124}]'
```

Pass an empty filter (`{}`) to clone every environmentObject.

## `modify` — patch matched objects

```
exec node bin/world-edit.mjs modify \
  --filter '<json>' \
  --patch  '<json>'
```

Patch shape — delta by default; nested `position`/`rotation`/`scale` overrides absolutely (per-axis; missing axes preserved). Boolean flags pass through directly.

```json
{
  "dx": 10, "dy": 0, "dz": 0,        // additive position offset
  "rotateY": 1.5708,                 // additive Y rotation (radians)
  "position": { "y": 2 },            // absolute — sets only y, leaves x/z
  "rotation": { "x": 0, "y": 0, "z": 0 },
  "scale":    { "x": 2, "y": 2, "z": 2 },
  "name": "barrier_v2",
  "destructible": true,
  "destructionMode": "shatter",     // or "partial"; omit = engine picks by size
  "dynamic": false,
  "interactable": true,
  "collectible": false,
  "placeOnTerrain": true,
  "flattenTerrain": false,
  "collision": true                  // false = walk-through prop; true = restore the collider
}
```

When both forms are present for the same axis, the absolute value is applied first and then the delta is added on top. `modify` with a filter that matches nothing returns `success: true, modified_count: 0` (not an error).

Examples:

```
# Lift every collectible 3 meters
exec node bin/world-edit.mjs modify --filter '{"types":["coin","gem"]}' --patch '{"dy":3}'

# Make every track wall destructible (bulk is fine — a destructible instance
# renders in the same batch as any other prop until it actually breaks)
exec node bin/world-edit.mjs modify --filter '{"name_prefix":"track_wall_"}' --patch '{"destructible":true}'

# Force whole-object shatter on a large asset (default for anything under 12m)
exec node bin/world-edit.mjs modify --filter '{"types":["watchtower"]}' --patch '{"destructible":true,"destructionMode":"shatter"}'

# Snap every tree to terrain (set absolute Y to 0 + placeOnTerrain flag)
exec node bin/world-edit.mjs modify --filter '{"types":["tree_oak","tree_pine"]}' --patch '{"position":{"y":0},"placeOnTerrain":true}'

# Make decorative bushes collidable again
exec node bin/world-edit.mjs modify --filter '{"types":["decor_bush"]}' --patch '{"collision":true}'
```

## `delete` — remove matched objects

```
exec node bin/world-edit.mjs delete --filter '<json>'
```

No manual-edit gate — surgical removal is always allowed. No-match is a no-op (`success: true, deleted_count: 0`).

```
# Drop every default tree
exec node bin/world-edit.mjs delete --filter '{"types":["tree_oak"]}'

# Clear everything from a region
exec node bin/world-edit.mjs delete --filter '{"region":{"minX":-10,"maxX":10,"minZ":-10,"maxZ":10}}'

# Wipe the array (start fresh — then `write`)
exec node bin/world-edit.mjs delete --filter '{}'
```

## Common flags

- `--work-dir PATH` — defaults to `./src/work`. Rarely needed.
- `--ws-url URL`    — defaults to `$WEBSOCKET_URL` or `ws://localhost:8082`.
- `--timeout MS`    — WS connect timeout (default 10s). Failure to deliver the reload is reported in the result but the file change still lands.

## When NOT to use the world-edit CLI

- **Asset creation** — the CLI only manipulates existing assets. Generate assets first with `voxelAssetCreationTool`, `asset3dGenerationTool`, `generateBlockTypeTool`, etc.
- **Voxel-specific placement** with engine-computed terrain Y, individual `place-on-terrain` raycasts, or asset-aware destructible voxels → use the `bin/voxel` CLI (`@docs voxel-cli.md`). The voxel CLI is the right tool when you need engine-confirmed placement; `world-edit` is the right tool when you already know the positions.
- **Skybox / spawn / character config / asset metadata** — use `worldJsonInspectTool` for read; targeted Mastra tools (`configTool`, `setMapAssetTool`, `writeHudThemeTool`) for write.

## `mechanism` — data-driven moving hazards & platforms

Manages the top-level `mechanisms[]` array (spinners, moving platforms, pendulums, crushers,
conveyors, crumbling floors — plus custom types owned by game code). Engine-spawned, editable by
the user in the creator editor, persisted. **This is the write path for ALL moving hazards — do
not hand-edit world.json for these.** Schema: `@docs moving-platforms.md`.

```bash
# Add / replace (by id) — one entry or an array
exec node bin/world-edit.mjs mechanism upsert --json '{"id":"spinner_1","type":"spinner","name":"Ravine spinner","position":{"x":192,"z":109},"params":{"angularSpeedRad":1.4,"aboveGround":0.9}}'

# List entries
exec node bin/world-edit.mjs mechanism list

# Remove by id
exec node bin/world-edit.mjs mechanism remove --id spinner_1
```

Custom types (anything other than spinner/movingPlatform/pendulum/crusher/conveyor/crumbling) are
stored but NOT engine-spawned — the upsert output reminds you that game code must build them
(`getSpec` + `registerCustom`); plan that coding-side work in the same request.

## `spawnpoint` — unified typed spawn points

Manages `worldProfileData.spawnPoints[]` — ONE array for every "something starts here" position,
typed per entry instead of per-category arrays. Entry: `{ id, type, position: {x,y,z},
rotationY?, name?, params? }`. `type` is open vocabulary:

- `player` — engine-consumed: first entry = the start position; ALL entries = multiplayer spread
  (`NetworkManager.getMultiplayerSpawnPoints`). Keep 2+ for multiplayer games.
- `npc` / `animal` / `vehicle` / anything else — placement contracts game code realizes via
  `engine.getSpawnPoints('<type>')`; put the payload in `params` (npc: archetype/behavior/count,
  animal: species, vehicle: vehicleType).

`position.y` must be standable ground height — on forged levels take a trail point y from
`inspect-world-json` query `"forge"` (which also lists existing spawn points).

```bash
# Add / replace (by id) — one entry or an array
exec node bin/world-edit.mjs spawnpoint upsert --json '{"id":"npc_guard_1","type":"npc","position":{"x":42,"y":6.5,"z":-13},"rotationY":1.57,"params":{"archetype":"guard","behavior":"patrols the gate"}}'

# List (optionally by type)
exec node bin/world-edit.mjs spawnpoint list --type player

# Remove by id
exec node bin/world-edit.mjs spawnpoint remove --id npc_guard_1
```
