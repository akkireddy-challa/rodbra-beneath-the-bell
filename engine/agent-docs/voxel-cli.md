# Voxel CLI — place / batch-place / modify / delete

Voxel object placement runs as a CLI invoked through `execTool`. The bundled binary lives at `bin/voxel.mjs` in the session sandbox; call it with `node bin/voxel.mjs <subcommand> [flags]`. Output is always a single line of JSON on stdout; exit 0 means success, exit 1 means failure.

> **Use `batch-place` for 3+ objects.** Individual `place` calls are fine for one-off edits and for objects that need engine-computed Y from `--place-on-terrain`. For level layouts of computed positions, prefer `bin/world-edit write` (`@docs world-edit-cli.md`) — single call, server-side write — when the level has NOT been manually edited.

The CLI talks to the running game iframe over `ws://localhost:8082` (same handlers as before). The game iframe must be connected; if it isn't, the CLI returns `{"success":false,"message":"No game client is connected …"}` within ~10s.

## `place` — single instance

```
exec node bin/voxel.mjs place \
  --asset NAME --x N --z N \
  [--y N]                              # auto-calculated unless --force-position
  [--rx N --ry N --rz N]               # rotation in DEGREES (default 0)
  [--sx N --sy N --sz N]               # scale (default 1)
  [--name STR]                         # instance name, e.g. for collection events
  [--interactable]                     # individual VoxelObject for E-key interaction
  [--place-on-terrain]                 # adjust Y to terrain height at load
  [--collectible]                      # auto-collect trigger sensor
  [--destructible]                     # retain voxel data for explodeAt()
  [--dynamic]                          # dynamic rigid body: pushable; rolls if the asset has colliderShape:"sphere"
  [--flatten-terrain | --no-flatten-terrain]   # override asset default
  [--no-collision]                     # decorative prop: player/NPCs walk through (default: collidable)
  [--force-position]                   # exact (x,y,z), skip ground snap. --y required
```

Examples:
```
exec node bin/voxel.mjs place --asset wooden_barrel --x 10 --z 15 --ry 45
exec node bin/voxel.mjs place --asset door --x 10 --z 15 --y 3 --force-position
exec node bin/voxel.mjs place --asset mushroom --x 10 --z 15 --collectible --place-on-terrain --name mushroom
```

## `batch-place` — many instances in one round-trip

Reads a JSON array of objects from a file or stdin. Use this any time you need 3+ placements. JSON entries match the `place` flags by name (snake_case). Per-entry `"collision": false` makes a prop non-collidable (decorative vegetation, etc. the player and NPCs walk through):

```json
[
  { "asset_name": "tree_oak", "position": { "x": 10, "z": 15 } },
  { "asset_name": "tree_oak", "position": { "x": 20, "z": 25 }, "rotation": { "y": 90 } },
  { "asset_name": "rock_small", "position": { "x": 12, "z": 18 }, "placeOnTerrain": true },
  { "asset_name": "decor_bush", "position": { "x": 14, "z": 9 }, "placeOnTerrain": true, "collision": false }
]
```

Invoke with either form:
```
exec sh -c 'node bin/voxel.mjs batch-place --file objects.json'
exec sh -c 'cat objects.json | node bin/voxel.mjs batch-place --stdin'
```

For ad-hoc batches, build the JSON in-memory and pipe it in:
```
exec sh -c 'cat <<EOF | node bin/voxel.mjs batch-place --stdin
[
  {"asset_name":"tree_oak","position":{"x":10,"z":15}},
  {"asset_name":"tree_oak","position":{"x":20,"z":25}}
]
EOF'
```

Result includes `placed_count` and `object_ids` for downstream `modify` / `delete`.

## `modify` — update an existing instance

```
exec node bin/voxel.mjs modify --id INSTANCE_ID \
  [--x N --z N] [--y N]                # changing position requires both --x and --z
  [--rx N --ry N --rz N]
  [--sx N --sy N --sz N]
  [--flatten-terrain | --no-flatten-terrain] [--force-position]
  [--collision | --no-collision]       # toggle collider on an existing instance
```

## `delete` — remove an instance

```
exec node bin/voxel.mjs delete --id INSTANCE_ID
```

If the WebSocket round-trip fails (e.g. engine is unresponsive), the CLI falls back to removing the entry from session `world.json` directly and returns `success: true` with a note that the 3D scene may need a reload.

## Coordinates / rotation / scale

- All rotations are in **degrees** (the engine converts to radians internally).
- Default Y position is engine-computed from terrain. Pass `--force-position --y N` to skip the snap (required for objects inside tunnels, caves, mid-air, or aligned to a previously placed structure's `final_position.y`).
- Terrain AUTO-GROWS to fit your positions. Initial `groundWorldSizeX/Z` (typically 64×64) is a STARTING value — design at whatever scale the game needs. Growth is reported in the result message.

## Common flags

- `--work-dir PATH` — defaults to `./src/work` (the editable game source inside the session). Rarely needed.
- `--ws-url URL` — defaults to `$WEBSOCKET_URL` or `ws://localhost:8082`.
- `--timeout MS` — defaults: `place`/`modify`/`delete` 10000, `batch-place` 30000.

## When NOT to use the voxel CLI

- **Level layout generation with many objects at computed positions** → `bin/world-edit write` (single call replaces all environmentObjects; see `@docs world-edit-cli.md`). Only available when `worldProfileData.environmentObjectsManuallyEdited !== true`.
- **Tiling / duplicating / shifting / deleting batches of existing objects** → `bin/world-edit duplicate` / `modify` / `delete` with a filter. Don't iterate per-object via the voxel CLI when one filter expression covers the whole set.
- **Creating new asset types** → `create-voxel-asset` (instant box-array) or `asset3dGenerationTool` (AI mesh). The CLI only places existing assets.
- **Asset existence**: if the asset isn't in `world.json`'s `assets[]`, `place` returns `success: false` with "Asset not found. Create it first using the create-voxel-asset tool."
