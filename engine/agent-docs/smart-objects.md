# Smart Objects: props with moving parts and lights

A generated voxel prop is a static shell. A **smart object** is that same prop with its moving parts and light sources declared as DATA, so the engine animates it — a windmill's blades turn, a ferris wheel's cabins orbit the hub and hang level, a lamp post lights the street — with **no game code**.

There is one runtime for all of them (`SmartObjectSystem`), and one closed vocabulary of motions. You do not write a windmill class.

## How a prop becomes smart

1. **Forge with `smart`.** `generate-glb-asset` (voxel lane) / `bitmagic generate prop --smart` asks the Asset Forger to analyse the forged master: a vision model reads three orthographic views and answers with part boxes, a motion per part, and light positions, in the master's grid space. Give it the designer's intent as the hint ("the blades should spin", "eight cabins hang from the wheel") — it is passed verbatim and is the single biggest quality lever.
2. **Bake.** The master is baked as usual, plus a part channel in the `.vxl` (every voxel knows which part it belongs to) and, on the asset record, `smartObject` (pivots and motions in metres) and `light` / `lights` (the emitters). A static prop with no parts and no lights gets nothing extra.
3. **Place.** Put instances in `environmentObjects[]` exactly like any other asset. Every placed instance animates on its own, from gameplay time, and freezes on pause.

An asset that was forged before this existed can be made smart afterwards from its raw HFVX master (`sourceHfvxUrl`) — the analysis is a separate Forger call.

## Placeholders are smart from the first bake

A stand-in built from boxes or primitives does not need the Forger to move: it declares its parts itself, and the bake writes the same part channel.

- **`create-voxel-asset` (agent):** give the moving boxes a `part` name and pass `smart` — `{ parts: [{ name: 'blades', motion: { kind: 'spin', axis: [0, 0, 1], rpm: 12 } }], lights: [{ name: 'lamp', part: 'head', color: '#ffd27a' }] }`. Pivots and light positions are in the same MIN-corner metre frame as the boxes; a part's pivot defaults to its boxes' centre. "Rebuild procedurally" replays it from `production.spec`.
- **World-Forger props and scatters:** the same on a primitive (`part`) and on the prop (`smart`). The archetype GLB carries each part as a `BM_part_<name>` node and the declaration in `scene.extras.bmSmartObject`; the voxelizer tags every voxel with the part of its nearest triangle, so rotated blades work, and Re-voxelize re-reads the GLB.

## Low-poly props: the GLB carries it, nothing is voxelized

A low-poly game keeps its props as GLB meshes, so there is no part channel to bake. The same GLB
contract — `BM_part_<name>` nodes + `scene.extras.bmSmartObject` — is read when the asset loads
instead (`engine/GlbSmartObject.ts`): pivots, the rig and the motions come from the voxel lane's own
`smartPropBake`, each placed instance lifts its part nodes under the same `SmartObjectView`, and
`SmartObjectSystem` animates them exactly like a voxel smart object (`setPartSpeed`, `pivotOf`, …
work unchanged). A smart GLB is never instance-batched, and its static collider is the BODY only —
the moving parts are lifted out before the colliders are built, so no invisible part stays behind at
the rest pose. The agent authors these with the `blender`
tool (bmedit's `part()` + `export(..., smart=)`, `@docs blender.md`); `generate-glb-asset` refuses
`smart` in a low-poly game, because the Forger's part analysis needs the voxel master.

## Riding a part

Parts are not solid, so a prop is not rideable by itself — and should not be: a ferris wheel, a
carousel or a moving platform becomes rideable when game code asks for it. What the prop gives that
code is where everything is, every frame: `pivotOf(id, part)` is the part's pivot group, and a GLB
smart prop built with bmedit carries ANCHORS inside its parts (`anchor(cabin, 'floor', ...)`), found
by name under that group. A rideable cabin is a kinematic body kept on its anchor:

```ts
import * as THREE from 'three';
import { PhysicsBodyFactory } from 'engine/physics/index.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';

const smart = this.engine.getSmartObjectSystem?.();
const id = 'ferris_1';                                    // the environmentObjects[] entry's id
const floors = (smart?.partsOf(id) ?? []).filter((p) => p.startsWith('cabin_')).map((part) => {
    const anchor = smart!.pivotOf(id, part)!.getObjectByName('BM_anchor_floor')!;
    const at = anchor.getWorldPosition(new THREE.Vector3());
    const { rigidBody } = PhysicsBodyFactory.createKinematicBody(this.engine.physicsWorld!, at, {
        shape: { type: 'box', halfExtents: new THREE.Vector3(0.8, 0.06, 0.7) }, friction: 1,
        collisionGroup: CollisionGroup.ENVIRONMENT, collisionMask: CollisionMask.ALL,
    });
    return { anchor, body: rigidBody };
});

// Every frame, after the smart system posed the parts: the floors follow their cabins.
const next = new THREE.Vector3();
for (const floor of floors) floor.body.setNextKinematicTranslation(floor.anchor.getWorldPosition(next));
```

- An `upright` cabin stays level, so its floor only translates; a part that tilts (a spinning
  platform, a swing) also needs `setNextKinematicRotation(anchor.getWorldQuaternion(q))`.
- Walls, seats or a closing gate are more colliders on the same body, offset from the anchor.
- Stop, slow or start the ride with `setPartSpeed` / `setPaused`; the floors follow whatever the
  parts do. Anchors' names are the prop's contract — `floor`, `seat`, `door`, `top` — and the
  same on every part.
- An anchor on the static body (a door, an entrance) does not move; find it on the placed object:
  `getObjectIdService().getObjectById(id)?.getObjectByName('BM_anchor_door')`.

## "Generate high-quality version" keeps it moving

The HQ job turns the placeholder's declaration into the Forger's analysis hint ("Moving parts: blades spins about the z axis at 12 rpm…"), so the generated geometry is searched for the same parts under the same names, and bakes the returned spec. The new version carries fresh pivots for the new geometry — old ones are never copied across. The Creator's dialog shows what the placeholder declares, lets the creator add their own words, and can refuse the analysis. A mesh-path fallback, or an analysis that finds nothing, comes back static with a note in the toast.

## The motion vocabulary

| kind | what it does | params |
| --- | --- | --- |
| `spin` | continuous rotation about `axis` through the part's pivot | `axis`, `rpm` |
| `upright` | hangs from a hinge on its `parent` and stays level while the parent turns (ferris cabin, gondola) | — |
| `pendulum` | swings either side of rest about a hinge at its top (a shop sign) | `axis`, `amplitudeDeg`, `periodS` |
| `none` | a named part that does not move | — |

Parts can nest: a cabin's `parent` is the wheel, so it orbits the hub AND stays level.

## Controlling parts from game code

Parts animate without you. Reach for the system only to change a speed, stop a part, or hang something off it:

```ts
const smart = this.engine.getSmartObjectSystem?.();
smart?.setPartSpeed('windmill_1', 'blades', 0);      // becalmed — 0 = stopped
smart?.setPartSpeed('windmill_1', 'blades', 3);      // storm  — 3 × the authored rpm
smart?.setPartSpeed('windmill_1', 'blades', -1);     // reversed
smart?.setPaused('ferris_1', true);                  // freeze every part of one instance
const cabin = smart?.pivotOf('ferris_1', 'cabin_3'); // a THREE.Object3D that rides the part
```

- The instance id is the `environmentObjects[]` entry's `id` (`smart.ids()` lists what is attached; `smart.partsOf(id)` its parts in order).
- Speed changes re-phase, so a part never jumps when you change its rate.
- `pivotOf` returns the part's pivot group: add a particle emitter or a sound source to it and it moves with the part.
- `anchorToWorld(id, part, assetPoint, out)` gives the world position, now, of an asset-frame point riding a part — what the engine uses to keep a light with `part` on its cabin.
- A light emitter with `part` (`asset.light.part`, `asset.lights[].part`) rides that part: its `offset` is its rest position in the asset frame, and the light moves with the part every frame.

## Checking it in a real game

`cli/scripts/smart-e2e/` bakes a windmill, a lit windmill, a wheel with a hanging cabin and a swinging sign, and the World-Forger form of the windmill through the CLI's headless forge session, then measures each in gameplay (`run-all.mjs --project <dir>`; `--hq` adds the high-quality upgrade). Its README lists the prerequisites and the stale-copy pitfalls.

## What it does not do (yet)

- **Parts are not solid.** The instance keeps its rest-pose collider; blades and cabins do not push the player. Use a data-driven `spinner` mechanism (`@docs moving-platforms.md`) when the hazard is the point.
- **LOD 0 only** for the parts; a smart instance is drawn individually, not batched, like an interactable.
- Editor drags do not move parts live until reload, the same as light emitters.
