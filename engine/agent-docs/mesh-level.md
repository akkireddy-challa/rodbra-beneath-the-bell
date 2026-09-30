# Mesh levels: an authored GLB as the whole world (`MeshLevel`)

A mesh level is a hand-designed 3D world — a space station, a house and its garden, a stylised
low-poly set — built in Blender (or any DCC tool) and exported as ONE GLB, plus a companion JSON
that says what the art alone cannot: where the solid surfaces are, the named rooms and points,
and the interior lights. `MeshLevel` loads both, builds the physics, registers the level as the
main terrain and applies an interior lighting preset. The game code is a few lines; the level is
whatever the artist or the Blender script made it.

Runnable reference: `samples/mesh-level-setup.ts`.

## When to use it — and when not

| The world is… | Use |
|---|---|
| A hand-designed interior or set, authored as one GLB with matching colliders | **`MeshLevel`** (this page) |
| A natural landscape, city, dungeon or track described in words | the World-Forger (`world-glb-forge.md`) — it bakes to voxels and carries its own navmesh, doors and spawn points |
| A single voxel map asset (`.vxl`) as the ground | `set_map_asset` (`glb-map-system.md`) |
| A 2D-on-a-plane port from another engine | `porting-2d-levels.md` (contact events, player-carried shadow light) |

A mesh level is single-level: `worldProfileData.levels[]` switching (`level-system.md`) is for
baked `.vwld` levels. A game that needs several mesh levels disposes one `MeshLevel` and loads
the next itself.

## The recipe

1. Register the GLB: `bitmagic assets add build/level/<name>.glb --name <name> --keep-glb --asset-id level-<name> --height <native height>`.
   `--keep-glb` keeps it a polygon mesh (no voxel bake); the CDN URL lands in `assets[]`, which is
   what survives publish. **A GLB fetched from a path under `src/work/` loads in dev and 404s in
   the published bundle** — the bundle is one HTML file with no siblings.
2. Copy `<name>.mesh-level.json` into `src/work/` and import it statically; the bundler inlines it.
3. Set `terrain: { shape: 'none' }` in `world.json`. Without it the voxel ground plane is built
   under the level too. With it there is no ground and no safety plane at all: pair it with a
   `MeshLevel`, or every body falls for ever.
4. In `Game.ts`, after physics exists and before NPCs spawn:

```ts
import { MeshLevel, DEFAULT_MESH_LEVEL_OPTIONS } from 'engine/meshlevel/MeshLevel.js';
import stationJson from './station.mesh-level.json';

const level = new MeshLevel(engine, { glb: { assetId: 'level-station' }, level: { data: stationJson } }, DEFAULT_MESH_LEVEL_OPTIONS);
const result = await level.load();
const spawn = level.landmark('spawn');
playerController.teleportTo(spawn.position[0], spawn.position[1], spawn.position[2], spawn.yaw);
playerController.configureFallRescue({ ...DEFAULT_FALL_RESCUE_OPTIONS, killPlaneY: result.bounds.minY - 50 });
```

5. Doors go in `worldProfileData.doors[]` (`doors-and-locks.md`) — the same `DoorDefinition`
   records the forger writes. The Blender exporter emits `<name>.doors.json` in that shape.

### Or declare it: `worldProfileData.meshLevel`

Instead of step 4, a world can DECLARE its level and let the engine load it:
`"meshLevel": { "glbAssetId": "level-station", "levelAssetId": "level-station-json", "spawnLandmark": "spawn" }`
beside `terrain: { shape: 'none' }`. The world generator loads it (`loadDeclaredMeshLevel` in
`engine/meshlevel/DeclaredMeshLevel.ts`) before placing environment objects and before the player
spawns, with `DEFAULT_MESH_LEVEL_OPTIONS` except lighting: `"lighting"` picks the mode and defaults to
`'exterior'` (a declared level is usually outdoors; say `'interior'` for an enclosed one). `levelAssetId` is a `.json` asset (omit it for
`'trimesh-from-glb'`); `spawnLandmark` moves `playerSpawnPosition`/`playerSpawnRotationY` to that
landmark. Low-poly games created in the web Creator get their template's ready-made ground this way
(`tools/low-poly-grounds/build_grounds.py`, installed by the agent's template import). Declare OR
construct — a game that does both loads the level twice. Mesh levels need the 3D physics world:
games on the Rapier 2D lane (sidescroller, top-down) cannot use one yet.

`MeshLevelOptions` (spread `DEFAULT_MESH_LEVEL_OPTIONS`): `collisionGroup` (default group for
colliders whose record names none, `'terrain'`), `friction`, `lighting`, `shadows`
(`'cached' | 'dynamic' | 'none'`), `materialConventions`, `registerAsTerrain`, `trimeshFallback`.

## What `load()` does, in order

1. Resolves the GLB URL from `assets[]` by id (a missing id throws and lists the GLB assets that
   exist). A literal `{ url }` is accepted; a relative one is warned about.
2. Loads the scene, applies the material conventions (below) and parents it under the world group.
3. Validates the JSON (`MeshLevelSchemaError` names the JSON path of the first violation) and
   builds one static Rapier body per collider record — `box`, `convexHull` or `trimesh`.
4. Steps physics once, so the colliders answer raycasts before anything spawns.
5. Registers itself as the main terrain: shadow coverage fits the level, `groundWorldSizeX/Z`
   grow to its extent (NPC spawn clamping would otherwise collapse spawns into a corner), and
   the engine's `findValidVoxelSpawnPosition` hook becomes a physics-raycast finder.
6. Applies the lighting preset.

It logs one line: `[MeshLevel] loaded "<url>" — N colliders (a box, b hull, c trimesh), M lights, …`.
`dispose()` undoes all of it, including the lighting config and the spawn finder it replaced.

## The JSON contract (`bitmagic-mesh-level` v1)

Metres, Y up, positions in world space, sizes are full extents, `yaw` in radians about +Y in the
gameplay convention (`coordinate-system.md`: forward at yaw θ is `(sin θ, 0, cos θ)`). The GLB
must be exported with the same origin.

```jsonc
{
  "format": "bitmagic-mesh-level", "version": 1, "units": "meters",
  "colliders": [
    { "name": "deck", "shape": "box", "position": [0, -0.3, 0], "size": [48, 0.6, 48], "yaw": 0 },
    { "name": "ramp", "shape": "convexHull", "vertices": [x0, y0, z0, x1, y1, z1, ...] },
    { "name": "cage", "shape": "trimesh", "vertices": [...], "indices": [...], "group": "environment" }
  ],
  "volumes":   [ { "name": "airlock", "position": [0, 3, -31], "size": [10, 7, 14], "yaw": 0, "tags": ["pressure"] } ],
  "landmarks": [ { "name": "spawn", "position": [0, 1.2, 13], "yaw": 3.14159, "tags": [] },
                 { "name": "guard_1", "position": [-7, 1.1, 0], "tags": ["security"] } ],
  "lights":    [ { "name": "hall", "type": "point", "position": [0, 9, 0], "color": "#ffd09a", "intensity": 8, "distance": 30 },
                 { "name": "gate", "type": "spot", "position": [0, 8, -20], "target": [0, 0, -20], "color": "#9ddfff", "intensity": 20, "castShadow": true } ],
  "extras": { "modules": [] }
}
```

- Unknown top-level keys are rejected; `extras` is the one open bag (read it with `getExtras()`).
- Names are unique within each array. `yaw`, `tags`, `group` and the light tuning fields are
  optional; everything else is required and every number must be finite.
- A collider's `group` is `'terrain'` (floors, walls — the default) or `'environment'` (crates,
  furniture). The camera always collides with TERRAIN and the spawn finder reads "surface well
  above the bare TERRAIN ground" as a prop top, so this split reproduces baked-level behaviour.
- Warnings (logged, never fatal): no colliders, no `spawn` landmark, more than 8 lights, a box
  thinner than 5 cm (decoration should not be a collider).
- `level: 'trimesh-from-glb'` derives one trimesh per top-level GLB node instead of reading a JSON
  — quick to try, but there are then no landmarks, volumes or lights, and a node over the
  triangle budget is coarsened. Meshes named `nocollide*` are skipped.

## Queries

- `level.landmark(name)` — throws, listing the known names, when there is none. `hasLandmark(name)`
  when absence is a legitimate state. `landmarksTagged(tag)` for every post carrying a tag.
- `level.volume(name)` / `level.volumesAt(point)` — oriented-box containment, in JSON order.
- `level.getBounds()`, `level.getRoot()`, `level.getColliders()`, `level.getLights()` (the spots),
  `level.getExtras()`, `level.refreshShadows()` after static geometry changed.

## Declare the art style

Put `"artStyle": "low-poly"` at the top level of `game.json`, beside `physicsMode`. Absent means
`voxel`. In the engine it switches off two voxel presets the templates add on load: the warm
"sunset" `HemisphereLight` in `setupVoxelLighting()` (a MeshLevel brings its own, and the two
stacked wash out an interior) and the faint voxel bloom default (`bloomConfig` in world.json still
wins when set). Outside the engine the same field steers `bitmagic cover`, `bitmagic reference`,
the `assets add` / `generate` defaults and the judge's fallback art direction — the
`building-levels-in-blender` skill describes those. Read it from `gameData.artStyle`.

## Lighting: why the preset goes through `lightingConfig`

The engine sun is a `DirectionalLight` at full daylight, and `worldProfileData.lightingConfig` is
re-applied on every load and level switch — dimming the light object by hand is overwritten. The
`interior` preset (default) applies `{ sunIntensity: 0.08, environmentIntensity: 0.22,
skyboxIntensity: 0.3, ambientFloor: 0.8 }` through `engine.applyLightingConfig`; a sun that low
also switches the sun shadow pass off. It retargets the template's `HemisphereLight` (or creates
one) at intensity 0.65. `mode: 'exterior'` leaves the sun alone; `'none'` touches nothing.

JSON point lights share one `PointLightPool` (`lighting-best-practices.md`: the light COUNT must
stay constant — a change recompiles every material's shader, a hard freeze on WebGPU). Spots are
real `SpotLight`s; the first `maxShadowCastingSpots` (2) with `castShadow: true` cast. With
`shadows: 'cached'` their shadow maps are baked once from the static level — moving characters
do not cast into them. On WebGPU cached degrades to dynamic.

## Material conventions in the GLB

- A material named `glass*` renders as a thin transparent pane (opacity 0.1, no depth write,
  double-sided, casts no shadow).
- A material named `emissive*` is guaranteed to glow (`emissiveIntensity ≥ 1`; bloom picks it up).
- Every mesh casts and receives shadows.

## Spawning on a mesh level

There is no voxel grid, so `findValidVoxelSpawnPosition` resolves the floor with raycasts against
the level colliders (it did return null before, which silently spawned zero NPCs). Interior spawns
must pass the storey: `npc.spawn(x, z, y)` probes DOWN from `y`, so a roofed room resolves to its
own floor instead of the roof. A column hemmed in by walls (no standing room) is rejected so the
caller retries nearby.

## Publishing

The GLB is served from the CDN URL in `assets[]`; the JSON is inlined by the static import. Nothing
under `src/work/assets/` is served by a published bundle — `bitmagic verify` passes on a local
path and the published game shows an empty world. Register the file instead.
