# Handing the level to the engine

The engine side is `MeshLevel` — `engine/agent-docs/mesh-level.md` is the full reference and
`engine/agent-docs/samples/mesh-level-setup.ts` the compile-checked sample. This page is the
seam: what the build wrote, what each command does with it, and the four ways it goes wrong.

**This is the outer loop — run it once per pass, and run all of it.** An upload, a type-check and
a real browser, against a level the contact sheet and both audit modes have already cleared. Every
question you can answer in Blender, answer in Blender; what is left here is what only the running
game knows: how it feels to walk, how it is lit on a phone, and whether the published bundle can
fetch what it needs.

## The files the build wrote

| File | Goes | Carries |
|---|---|---|
| `build/level/<name>.glb` | `bitmagic assets add … --keep-glb` → CDN, an `assets[]` entry with id `level-<name>` | the art, one mesh per material |
| `build/level/<name>.mesh-level.json` | `cp` into `src/work/`, static `import` in `Game.ts` | colliders, volumes, landmarks, lights, `extras.links` |
| `build/level/<name>.doors.json` | `sync_world.py` → `worldProfileData.doors[]` | `DoorDefinition` records the engine animates |
| `build/level/<name>.blend` | nowhere; open it to look | the named parts |

## Registering: `--keep-glb` and `--height`

```
bitmagic assets add build/level/<name>.glb --name <name> --keep-glb --asset-id level-<name> --height <native height>
```

- Without `--keep-glb` the file is voxelized into a `.vxl` and the level becomes a blocky prop.
  In a project whose game.json says `artStyle: "low-poly"` keeping is already the default and the
  flag is harmless; keep passing it so the line works in a project that forgot to declare.

## What `artStyle: "low-poly"` flips

| Where | voxel (absent) | low-poly |
|---|---|---|
| `bitmagic cover`, `bitmagic reference make` | MagicaVoxel-style prompt lead and tail | flat-shaded low-poly lead and tail; same image model |
| `bitmagic assets add x.glb` | voxelized in a headless browser | kept as a `glb` asset (`--voxelize` to bake) |
| `bitmagic generate model` / `prop` | voxel master baked in the browser | mesh generated, re-uploaded, registered as `glb` (`--voxelize` to bake) |
| `bitmagic character generate` | voxelized rig, library search | textured low-poly rig, its own library shelf where enabled (`--voxelize` to override) |
| `bitmagic character search` / `add` | searches the voxel shelf | searches the low-poly shelf; free, never forges |
| `bitmagic generate vehicle` | voxel car | voxel car anyway — the builder is voxel-native; it says so |
| engine on load | sunset hemisphere light + faint bloom | neither; `MeshLevel`'s own lighting stands |
| `bitmagic judge` with no `## Art direction` | grades style as it finds it | judges within low-poly |
- The entry's `targetHeight` defaults to 2 m. `MeshLevel` does not scale by it, but anything else
  that reads the asset (the Creator's asset panel, a placement) would squash a 40 m station into a
  2 m box. The build's `REGISTER` line has the real number.
- Re-registering with the same `--asset-id` replaces the entry; the game code does not change.
- **A GLB that is not an asset is not in the published game.** `bitmagic publish` bundles one HTML
  file whose assets are absolute CDN URLs; a path under `src/work/` or `build/` resolves in
  `bitmagic dev` and in `bitmagic verify` and returns 404 from the published page, which then shows
  the sky and a falling player. `MeshLevel` warns when handed a local `{ url }`; use `{ assetId }`.

## Syncing: doors, spawn, terrain

```
python3 tools/blender-level/sync_world.py build/level/<name>.doors.json build/level/<name>.mesh-level.json src/work/world.json
```

- **Doors** are upserted by id. The build owns `position`, `rotationY`, `width`, `height`,
  `thickness`, `animation`; a `kind: 'locked'`, `keyId`, `assetId`, `color` or `autoOpenRadius` set
  in world.json by the creator (or by you, for a key-and-lock design — `engine/agent-docs/doors-and-locks.md`)
  survives a rebuild. Doors the build no longer has are listed, never deleted.
- **Spawn**: the `spawn` landmark becomes `playerSpawnPosition` and `playerSpawnRotation`. The game
  code teleports there too (below) so the two cannot disagree.
- **Terrain**: `terrain.shape` becomes `'none'` — no voxel ground, no invisible safety plane. That
  is the mode `MeshLevel` needs; it also means a level with no floor under the spawn is a player
  falling for ever, which `configureFallRescue` turns into a respawn.

Run it after EVERY rebuild; a door moved in the script and not synced is a leaf animating in a wall.

## The game code

```ts
import { MeshLevel, DEFAULT_MESH_LEVEL_OPTIONS } from 'engine/meshlevel/MeshLevel.js';
import { DEFAULT_FALL_RESCUE_OPTIONS } from 'engine/FallRescue.js';
import levelJson from './<name>.mesh-level.json';

// After setupPlayerController(), before any NPC spawns.
this.level = new MeshLevel(this.engine, { glb: { assetId: 'level-<name>' }, level: { data: levelJson } }, DEFAULT_MESH_LEVEL_OPTIONS);
const loaded = await this.level.load();
const spawn = this.level.landmark('spawn');
this.playerController.teleportTo(spawn.position[0], spawn.position[1], spawn.position[2], spawn.yaw);
this.playerController.configureFallRescue({ ...DEFAULT_FALL_RESCUE_OPTIONS, killPlaneY: loaded.bounds.minY - 50 });

const guards = this.engine.registerNpc('guards', new NpcIdleBehavior(), { autoRespawn: false });   // any INpcBehavior — engine/agent-docs/npc-system.md
for (const post of this.level.landmarksTagged('guard')) {
    await guards.spawn(post.position[0], post.position[2], post.position[1]);   // (x, z, y): Y picks the storey
}
```

- `landmark(name)` throws with the known names when one is missing; a typo cannot spawn the boss
  at the origin. `landmarksTagged(tag)` for posts, `volumesAt(position)` for "which room am I in".
- NPC spawns on a mesh level resolve the floor with raycasts (there is no voxel grid). Pass the
  storey's Y for interior spawns, or an upstairs room resolves to the roof above it.
- `DEFAULT_MESH_LEVEL_OPTIONS.lighting.mode` is `interior`: the sun is dimmed through
  `lightingConfig`, the template's hemisphere light reused, JSON point lights pooled, the first two
  shadow-casting spots cached. An outdoor level (the courtyard game) wants
  `{ ...DEFAULT_MESH_LEVEL_OPTIONS, lighting: { ...DEFAULT_MESH_LEVEL_LIGHTING, mode: 'exterior' } }`.
- `dispose()` removes bodies, lights and the scene, and restores the lighting config and the spawn
  finder it replaced — call it before loading another level.

## Verify, and the four ways it fails silently

`bitmagic verify` must print `[MeshLevel] loaded "<cdn url>" — N colliders …` with the count the
build printed. Then:

1. **Verify passes, published game is empty** — the GLB was a local path (above).
2. **Verify passes, doors animate inside walls** — `sync_world.py` was not re-run after a rebuild.
3. **Verify passes, zero NPCs** — spawns given without the storey's Y on a multi-floor level, or
   posts declared inside a wall; the console shows the finder returning null for each.
4. **Verify passes, the level is bright white** — `lighting.mode` is `exterior`, or `lightingConfig`
   in world.json sets a sun the preset then merges with. The preset only lowers what it names.
