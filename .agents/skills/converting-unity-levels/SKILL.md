---
name: converting-unity-levels
description: Convert a Unity level — a .unity scene, its prefabs, FBX models, materials and 2D/3D colliders — into a Bitmagic engine level with matching visuals (one GLB) and matching physics (collider data). Use this whenever a creator wants a Unity game or Unity scene ported, replicated, "converted to Bitmagic", "brought over", "made to look like the original", or asks to reuse original Unity assets, prefabs or level blocks — even if they only mention one symptom (pieces rotated 90 degrees, wrong scale, walls the ship flies through, a base that cannot be exited, an empty corner). Also use it when a converted level looks wrong in any of those ways, or after an engine upgrade changes how a ported level lights or collides.
---

# Converting a Unity level to Bitmagic

A Unity level is three things that Unity keeps apart and the port must reunite: **placement** (the
scene and prefab files), **art** (FBX models plus `.mat` files and textures), and **collision**
(colliders on prefabs, which may be 2D or 3D). The tools in `scripts/` read Unity's YAML directly,
rebuild the art in Blender into one GLB, and emit the collision as data the game builds physics
from. Every step below exists because skipping it produced a level that looked plausible and was
wrong — the references say which symptom each step prevents.

## What this covers, and what it does not

- **Visuals are general.** Scene and prefab reading, the override rules, FBX geometry, materials
  and textures, and the Blender rebuild into one GLB apply to any Unity project, 2D or 3D.
- **Collision extraction is general; the emitted level data is 2D-on-a-plane.**
  `unity_colliders2d.py` and `unity_extract.py` read every 2D and 3D collider Unity has
  (BoxCollider2D, CircleCollider2D, BoxCollider, SphereCollider, MeshCollider). `build_parts.py`
  and `write_arena_data.py` then reduce them to a gameplay plane — walls, floors, backdrop,
  foreground, bases — which is the right shape for a top-down or side-on game and the wrong shape
  for a 3D one.
- **For a 3D game**, stop after `unity_extract.py`: `tools/colliders.json` holds every collider
  with its world transform, size, centre and mesh, and the GLB holds the art. Build the game's
  physics from those directly (Rapier boxes and trimeshes from the same data), and skip the plane
  emitters. That consumer does not exist yet; write it for the game at hand and it becomes the
  next thing this skill ships.
- **The receiving game code is not part of the skill.** `ArenaData.ts` is a data contract; the
  code that builds physics bodies, occluders and stand-ins from it lives in the game. The origin
  game's `Arena.ts` is a worked example of that consumer, not a library.

Treat this as a **measured** conversion: after every stage, count things and render things, and
compare with the Unity editor. A symmetry score or a passing typecheck is not evidence; a top-down
render next to the creator's Unity screenshot is.

## 0. Install the tools and describe the project

The conversion scripts ship inside the Bitmagic CLI package, under `assets/unity-import/`. Copy
them into `tools/` of the game project once:

```
bitmagic tools install unity-import
```

They need Python 3, Blender 4.x
(`/Applications/Blender.app/Contents/MacOS/Blender` on macOS) and the Unity project on disk.

Everything that belongs to a particular game lives in one file, `tools/unity-import.json`. Copy the
example and fill it in — the scripts read it and never need editing:

| Key | What it is |
|---|---|
| `unityRoot` | the Unity tree holding `Assets/` and `ProjectSettings/` (see step 1 — a repo can hold two) |
| `scene`, `levelName` | the scene file relative to `unityRoot`, and the level name the game data is written under |
| `planeZ`, `planeHalf` | the gameplay plane's Unity z and the half-thickness a collider must cross to count (the ship's radius) |
| `arenaLimit` | instances farther than this from the origin are stray copies parked outside the level |
| `glb`, `assetName`, `outputTs` | where the GLB is built, the asset name it is uploaded under, where the level data is emitted |
| `markerScripts`, `markerPrefabs` | the MonoBehaviour scripts and prefab files that mark spawns, bases and pickups in this game |
| `badTags` | prefab tags whose colliders are never walls (decoration that would seal a room) |
| `wallFamilies` | render-mesh name families that must be solid although they carry no 2D collider |
| `prefabs`, `axisOverride` | prefabs for non-scene conversions; a per-pack axis override for experiments |

`UNITY_IMPORT_CONFIG` points at a different file; `UNITY_ROOT`, `UNITY_PLANE_Z` and
`UNITY_AXIS_OVERRIDE` override single values for an experiment. The scripts refuse to start with
an `unityRoot` that has no `Assets/`, and reject unknown keys, so a typo fails early.

## 1. Find the right scene, and the right project tree

Before extracting anything, answer three questions; on the game this skill was built from, each
wrong answer cost a full round of work:

1. **Which tree does the creator's editor open?** A repo can hold two Unity trees (a modern
   port and a legacy one) with different `TagManager` layer numbering. Unity Hub's recent-projects
   list (`~/Library/Application Support/UnityHub/projects-v1.json`) says which path was opened;
   `ProjectSettings/EditorBuildSettings.asset` lists the scenes in the build.
2. **Which scene?** Ask, or take the one the creator screenshots. A "Room for 10" in one tree and
   a "Room for 9" in the other were different games entirely.
3. **Does the scene match the creator's memory?** Instances can be parked off-map, root-inactive,
   or under a parent group with an offset (a `WallsLeft` group at x = −161). Run the census in
   step 3 before believing either the creator or the file.

## 2. Decide the physics model first

Open the player prefab. If it carries `Rigidbody2D` and `BoxCollider2D`/`CircleCollider2D`, the
game uses Unity **2D physics**, and the only walls that exist are the 2D colliders on the level —
the 3D `MeshCollider`s on the art are for raycasts and shadows and never touch a 2D body. Extract
with `unity_colliders2d.py` and stop guessing from geometry. If the player is a `Rigidbody`, use
the 3D path (`unity_extract.py` + `build_parts.py`, which slices MeshColliders at the plane).
Mixing the two produced sealed bases and invisible walls; see `references/physics-and-shadows.md`.

## 3. Extract and census

```
python3 tools/unity_renderers.py  "<scene>.unity"   # visible geometry with world transforms
python3 tools/unity_colliders2d.py "<scene>.unity" > tools/colliders2d.json    # 2D games
python3 tools/unity_extract.py    "<scene>.unity" > tools/colliders.json       # 3D colliders
python3 tools/unity_markers.py    "<scene>.unity" > tools/markers.json         # spawns, bases
```

Then census before converting: renderers and colliders **per prefab name**, positions of the big
structural pieces, anything beyond the arena limit, and which scene instances are switched off.
The walkers already honour what bit the origin port — nested prefab expansion, `m_Layer`,
`m_IsActive` and `m_Enabled` overrides (including on objects inside nested prefabs), parent
groups with offsets, LOD-named objects without an LODGroup. `references/unity-scene-traps.md`
lists each trap, the symptom it caused, and how the walkers handle it, so you can recognise a new one.

## 4. Build the GLB

```
python3 tools/convert_assets.py "scene:<Scene Name>"     # ~15 min; run in the background
```

It writes `build/glb/<scene>.glb`, one draw call per material, textures capped and JPEG-compressed.
The FBX rules that took longest to get right — geometric transforms, Unity's X negation, unit
scale, multi-mesh files, ASCII FBX — are in `references/fbx-conversion.md`. When a piece looks
rotated or scaled wrong, read that file before touching axis permutations: the fix was never a
permutation.

Immediately render it and look:

```
blender -b --python tools/render_topdown.py -- build/glb/<scene>.glb .bitmagic/topdown.png
```

Put the render next to the creator's Unity screenshot. Crosses, corners, perimeter, statue — if
any differ, fix them now, not after the physics is built on top.

## 5. Emit collision and gameplay data

```
python3 tools/write_arena_data.py "<Scene Name>"      # -> src/work/ArenaData.ts
bitmagic check
```

For geometry that must be solid but has no collider in Unity (a decorative perimeter ring a 2D
ship would fly through), slice the render mesh at the play plane instead of inventing boxes:

```
blender -b --python tools/mesh_walls.py -- build/glb/<scene>.glb tools/render_walls.json
```

Then run the **reachability flood** (in `references/verification.md`): every spawn must reach
the same connected region. A level that seals when a wall is "fixed" is telling you the scene
differs from what you think — investigate, do not patch.

## 6. Upload, verify, confirm on screen

```
bitmagic assets add build/glb/<scene>.glb --name <asset-name> --keep-glb --asset-id <id>
bitmagic verify && grep -q "\[YourGame\] loaded" .bitmagic/verify/console.log
```

`verify` passing means the game boots. It does not mean the walls are where the art is, the
crosses cast solid shadows, or the statue is the right size. Drive the running game in the
browser pane, get past the pre-match menus, teleport the ship next to the thing in question, and
look — `references/verification.md` has the exact moves, and the two traps that once let three
"fixes" be presented that had not reached the browser.

## 7. Iterate with patches, not rewrites

Genuine gameplay edits (move a corner block so it overlaps the wall, remove a stray instance) go in
`tools/level_patches.json` and are applied identically by the visual and collider walkers. Every
entry that file ever held before the corner-block one turned out to be a walker bug in disguise:
when a patch is needed to make Unity's own scene coherent, suspect the extraction first.

## Where the deep material is

| Read when… | File |
|---|---|
| a piece is missing, doubled, parked, rotated by a parent, or "not in Unity" | `references/unity-scene-traps.md` |
| pieces are rotated, mirrored, wrongly scaled, or a multi-mesh FBX picks the wrong mesh | `references/fbx-conversion.md` |
| walls do not collide, a base seals, shadows leak or floors cast, lights vanish after an upgrade | `references/physics-and-shadows.md` |
| deciding whether a change is real: census, render, flood, browser drive, stale-server checks | `references/verification.md` |
