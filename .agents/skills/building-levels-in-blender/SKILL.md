---
name: building-levels-in-blender
description: Build a hand-designed low-poly 3D world — an interior, a space station, a house and its garden, a stylised set — in Blender from a short Python script instead of voxel terrain, and load it through the engine's MeshLevel: one GLB plus the collider, door, light and landmark JSON, audited with ray casts and reviewed from rendered stills before the game ever runs it. Use it when a creator asks for "low poly", "stylised 3D", a "hand-built level", an enclosed interior, "not voxels", or "in Blender" — and when such a level has walls you fall through, doors that do not open, z-fighting seams, or shows an empty world after publish.
---

# Building a level in Blender

A mesh level is one GLB that IS the whole world, plus a JSON that says what the art cannot: which
surfaces are solid, where the rooms, doors, lights and named points are. You write the level as a
Python script against `bmlevel` (game coordinates: metres, Y up, +Z forward), Blender builds it,
`audit.py` fires thousands of rays at the colliders, `review.py` renders every door and room, and
the engine's `MeshLevel` loads the result in six lines (`engine/agent-docs/mesh-level.md`). The
level that taught this skill was a five-module space station; every rule below was paid for there.

## 0. Is this path yours?

Take it only when BOTH hold:

- **You are a frontier model** — Claude Fable / Opus 5, GPT-6 class. Building a level part by part
  in code, reading a contact sheet and diagnosing a failed ray audit is sustained spatial reasoning
  over hundreds of lines; a smaller model produces a plausible script and a level with holes in it.
  If you are not sure you are one, you are not.
- **Blender is installed or installable here.** Run the probe below. If it cannot be installed
  (no admin rights, a sandbox), stop.

Otherwise use `bitmagic forge` (AGENTS.md, "Forging a whole level") — it builds a real level from a
prompt with no tooling beyond Chrome. The forge is also the right answer for natural terrain of
any kind; this path is for places that are designed, not grown.

**Declare the medium first.** A Blender level is a low-poly game, and the rest of the toolchain
assumes voxels until told otherwise: put `"artStyle": "low-poly"` at the top level of
`src/work/game.json` (or scaffold with `bitmagic init --art-style low-poly`). That one field
switches the cover and reference prompts to low-poly, makes `assets add` and `generate model|prop`
keep meshes instead of voxelizing, makes `bitmagic character generate` keep the textured rig, drops the
engine's voxel lighting/bloom presets, and gives `bitmagic judge` the medium when
`## Art direction` is missing. Set it before the first cover, or the cover is a picture of cubes.

```
python3 tools/blender-level/find_blender.py --check   # prints "Blender 4.x at <path>", or how to install it
export BLENDER="$(python3 tools/blender-level/find_blender.py)"
```

Install if needed: macOS `brew install --cask blender`, Debian/Ubuntu `sudo apt install blender`,
Windows `winget install BlenderFoundation.Blender`. Blender 4.2 or newer.

## 1. Install the library into the project

The scripts ship inside the Bitmagic CLI package; the CLI copies them for you (do not go looking
for the package on disk — under pnpm it is a shim, and the store is not where they live):

```
bitmagic tools install blender-level && mkdir -p tools/level build
grep -qx 'build/' .gitignore || echo 'build/' >> .gitignore
```

`tools/blender-level/README.md` lists what each file does. Level scripts go in `tools/level/`,
outputs in `build/level/`.

Run that install line again on an existing project too. It overwrites, and `bitmagic upgrade`
re-renders this skill but NOT the scripts — so a flag named below that your copy does not
recognise means the copy is old, not that the skill is wrong.

## 2. Plan the place in words, then as a table

Write the `## Art direction` of `GAME-DESIGN.md` first — `bitmagic judge` scores against it, and a
reference image (`bitmagic reference`) keeps every pass aimed at the same look. Then list, before
any code: every **room** with its size in metres, every **door** with which two rooms it joins,
every **route** a player must be able to walk, the **spawn**, and the named points the game needs
(extraction pad, guard posts, an altar). That table becomes `volume()`, `door()`, `link()`,
`spawn()` and `landmark()` calls — and the audit checks exactly those, so a room you did not
declare is a room nothing checks.

## 3. Write `tools/level/<name>.py`

Start from `tools/blender-level/example_level.py` — a two-room hut, porch, stairs and courtyard
using every helper. The vocabulary:

```python
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'blender-level'))
from bmlevel import *

mat('plaster', (0.82, 0.78, 0.7))          # rgb 0..1; glass* renders transparent, emissive* glows
with context('hall', origin=(0, 0, 0), yaw=0):   # a named part with its own local frame; nests
    slab('floor', (0, 0), (12, 8), 'plaster')                       # top surface at y=0
    wall('north', (-6, -4), (6, -4), 3.5, 'plaster', opening={'at': 6, 'width': 1.6, 'height': 2.4})
    door('north door', (0, 0, -4), yaw=0, width=1.6, height=2.4, jamb='timber')
    stairs('up', (4, 0, 0), rise=3, run=5, material='stone', rail='brass')
    decor('cornice', (0, 3.3, -3.85), (12, 0.2, 0.3), 'plaster')    # never collides
    prism('bay', [(-2, 4), (2, 4), (0, 6)], 0, 3.5, 'plaster')       # convex outline, extruded
    text('sign', 'HALL', (0, 2.9, -4.2), 'brass', size=0.4, both_faces=True)
    lamp('centre', (0, 3.2, 0), '#ffd9a0', intensity=10, distance=14)
    volume('hall', (0, 1.75, 0), (12, 3.5, 8), tags=['indoors'])
    landmark('altar', (0, 0.1, 5), tags=['objective'])
    spawn((0, 0.1, 2), yaw=3.14159)
link('hall', 'yard', door='north door')
export('build/level', 'temple')
```

Rules that are not style:

- **Everything solid by default.** `box()`, `wall()`, `slab()`, `prism()` and `stairs()` become
  colliders; `decor()` and `text()` never do. Cladding, trim, lamps, fasteners and rugs are
  `decor()` — a collider on a 5 mm strip is a step the player trips on and the audit flags.
- **Name everything, uniquely.** Names are the `.blend` outliner and the audit's error messages.
- **Overlap, never abut.** Two slabs meeting edge to edge leave a seam a ray, and a capsule, slips
  through; overlap them by 5 cm. Two faces on the same plane z-fight; offset by 5 cm or make the
  outer one deeper (the door header the library builds is 4 cm deeper than its jambs for this).
- **Convex prisms only** — a concave outline raises; split it. Mitred junctions are two prisms.
- **Doors are records, not meshes.** `door()` writes a `DoorDefinition`; the engine builds and
  animates the leaf. `jamb=` adds solid jambs and a header so the wall reads as a doorway.

## The two loops

Everything below runs in one of two loops, and knowing which one you are in is the difference
between building a level in a morning and building it in a day.

**The Blender loop** — edit `tools/level/<name>.py` → build → look → audit. Seconds each, all
local: nothing uploaded, no browser, no sparks. This is where the level is actually made, and you
should go round it tens of times.

**The engine handoff** — register the GLB → sync world.json → `check` → `verify` → `judge` →
walk it in `bitmagic dev`. `assets add` uploads to the CDN, `verify` type-checks the project and
drives a real Chrome through a settle loop, `judge` spends sparks and must not be run twice on
one milestone. Run it at the END of a pass — never after an edit.

**The gate: do not hand the level to the engine until the contact sheet has nothing wrong on it
and both audit modes exit 0.** Every build writes `build/level/<name>.glb` already; that is free.
Publishing it is what costs. A round trip through the engine to discover a hole in a floor is a
round trip the audit would have made for nothing, and the station lost a day to exactly that.

| The level is wrong like this | Found in |
|---|---|
| a hole in a floor, a doorway you cannot walk through, a route blocked by a prop, a room that is not sealed | the Blender loop — `audit.py`, both modes |
| z-fighting, a blank wall, a sign that reads backwards, a missing ceiling, stairs ending in air, a wedge of sky beside a junction, the wrong footprint | the Blender loop — the contact sheet |
| the level washed out or black, an empty published game, doors animating inside walls, no NPCs, the framerate | the engine handoff — nothing in Blender can see these |

## The Blender loop

### 4. Build

```
"$BLENDER" -b --python tools/level/<name>.py
```

It prints `LEVEL … colliders … doors … volumes …`, `BOUNDS`, and a `REGISTER bitmagic assets add …`
line to keep for step 7. Outputs: `build/level/<name>.glb` (one draw call per material),
`<name>.blend` (named, editable parts), `<name>.mesh-level.json`, `<name>.doors.json`. A syntax
or geometry error prints a Python traceback naming the helper and the object — fix and rebuild;
builds take seconds. `python3 tools/level/<name>.py --dry-run` gives the counts without Blender.

### 5. Render and look

```
"$BLENDER" -b --python tools/blender-level/review.py -- build/level/<name>.blend build/level/<name>.mesh-level.json build/level/review/
```

Read `build/level/review/contact-sheet.png` (the log says which frame is which), then any single
frame that looks wrong. You are looking for: a door with no wall around it, a room whose ceiling
is missing, stairs that end in the air, a sign that reads backwards, two surfaces flickering into
one another. Fix the script, rebuild, re-render. Do not go on to the audit while the sheet is
wrong; the audit finds holes, not ugliness.

The fixed set is what you read first. After that the flags turn it into a camera you can aim, so
a second look costs one render rather than a trip through the engine:

```
… review.py -- <blend> <level json> <out dir> --shot 'landmark:spawn -> volume:hall' --only        # just this frame
… review.py -- <blend> <level json> <out dir> --shot 'door:north door -> landmark:altar' --fov 50
… review.py -- <blend> <level json> <out dir> --lighting game                                     # the lamps and spots you declared
```

`--shot 'FROM -> TO'` takes `landmark:<name>`, `volume:<name>`, `door:<id>` or a raw `x,y,z`, and
repeats; `--only` renders those instead of the standard set. `--lighting game` swaps the review
fill for the engine's `interior` preset and the JSON's own `lamp()` / `spot()` records, which is
how you judge the lighting pass without a verify — dark under `--lighting game` is dark in the
game. Keep the default `--lighting review` while you are judging geometry: it is lit so that
nothing can hide.

### 6. Audit

```
"$BLENDER" -b --python tools/blender-level/audit.py -- build/level/<name>.mesh-level.json                   # doors open: floors, doorways, routes
"$BLENDER" -b --python tools/blender-level/audit.py -- build/level/<name>.mesh-level.json --doors closed    # envelopes sealed with the leaves in
```

Every check prints its ray count and its failures with coordinates; exit 1 means the level is
not done. A failed `floor_continuity` is a hole a player falls through; a failed `door_clearance`
or `link_clearance` is a doorway or route the player cannot walk (a jamb in the opening, a table
on the line between two rooms, a step that ends short); a failed `sealed_envelope` is a gap in a
roof or wall. `coplanar_overlap` is a warning: two faces on one plane, which flicker. Never
answer a failure by removing the volume or the link that found it.

A failure sends you back to step 4, not on to step 7. Both modes exiting 0 with a clean contact
sheet is the whole gate; nothing below can be trusted until you have it.

## The engine handoff — once per pass

Steps 7 and 8 are the expensive half: an upload, a type-check, a real browser. Do them when the
Blender loop has nothing left to say, and then do all of them — a partial handoff is what makes
`verify` pass on stale files.

### 7. Register the GLB, sync world.json, write the game code

```
bitmagic assets add build/level/<name>.glb --name <name> --keep-glb --asset-id level-<name> --height <native height>   # the REGISTER line from step 4
python3 tools/blender-level/sync_world.py build/level/<name>.doors.json build/level/<name>.mesh-level.json src/work/world.json
cp build/level/<name>.mesh-level.json src/work/
```

`--keep-glb` keeps it a polygon mesh and puts a CDN URL in `assets[]`, which is the only thing a
published bundle can load — a GLB fetched from `src/work/` works in `bitmagic dev` and shows an
empty world after `bitmagic publish`. `--height` is the level's real height: the entry's default
is 2 m. `sync_world.py` upserts the doors into `worldProfileData.doors[]` (creator-set keys and
locks survive), sets the spawn, and sets `terrain.shape` to `none` so no voxel ground is built
under the level. Then, in `src/work/Game.ts`, after the player controller exists:

```ts
import { MeshLevel, DEFAULT_MESH_LEVEL_OPTIONS } from 'engine/meshlevel/MeshLevel.js';
import { DEFAULT_FALL_RESCUE_OPTIONS } from 'engine/FallRescue.js';
import levelJson from './<name>.mesh-level.json';

const level = new MeshLevel(this.engine, { glb: { assetId: 'level-<name>' }, level: { data: levelJson } }, DEFAULT_MESH_LEVEL_OPTIONS);
const loaded = await level.load();
const spawn = level.landmark('spawn');
this.playerController.teleportTo(spawn.position[0], spawn.position[1], spawn.position[2], spawn.yaw);
this.playerController.configureFallRescue({ ...DEFAULT_FALL_RESCUE_OPTIONS, killPlaneY: loaded.bounds.minY - 50 });
```

`engine/agent-docs/mesh-level.md` has the rest: `landmarksTagged('guard')` for NPC posts
(`npc.spawn(x, z, y)` — pass the storey's Y for interiors), `volumesAt(position)` for room logic,
the lighting modes, and `samples/mesh-level-setup.ts`.

### 8. Check, verify, walk it

`bitmagic check`, then `bitmagic verify`: the console must show one `[MeshLevel] loaded …` line
with the collider and light counts you expect, and no `404` for the GLB. Then walk it in the
`bitmagic dev` browser — through every door, up every stair, into every room — because an audit
proves geometry, not that the place is good to be in. `bitmagic verify --platform mobile` too if
phones matter.

All three of step 7 again on every handoff — register with the SAME `--asset-id` (the entry is
replaced), re-run `sync_world.py`, re-copy the JSON. Skip one and `verify` grades the previous
build: the collider count in `[MeshLevel] loaded …` is how you catch it.

## 9. Judge, then iterate in passes

`bitmagic judge` scores the verify screenshot against your art direction. Improve the level in
passes — and a pass is **many turns of the Blender loop followed by one handoff**, not a handoff
per edit:

1. **Structure** — rooms, doors, routes, stairs, the spawn. Audit clean in both modes; the one
   verify is for walking it in `bitmagic dev`, which is the only thing Blender cannot tell you.
2. **Detail** — cladding, casings, coffers, deck plates, signage, props. All `decor()` unless the
   player should bump into it; keep every travel clearance. The sheet and the audit carry this
   pass almost alone; the one verify is to confirm nothing regressed.
3. **Surfaces and light** — materials, emissive strips, warm and cool lamps, a spot or two with
   shadows. Render with `--lighting game` (step 5) until the rooms read, then verify and judge
   once against the real thing.

`references/level-design-passes.md` says what each pass contains and when to stop.

## Where the deep material is

| Read when… | File |
|---|---|
| a piece is mirrored, rotated, at the wrong height, or the `.blend` no longer matches the GLB | `references/blender-conventions.md` |
| an audit check fails and the fix is not obvious, or a render looks wrong | `references/audits-and-review.md` |
| the level is walkable but plain, and you want it to look like the reference | `references/level-design-passes.md` |
| registering, syncing doors, spawning NPCs, lighting, publishing, or a level that is empty in the published game | `references/engine-handoff.md` |
