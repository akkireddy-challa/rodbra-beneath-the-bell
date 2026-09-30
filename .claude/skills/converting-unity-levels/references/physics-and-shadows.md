# Physics, walls and line-of-sight shadows

## Decide 2D or 3D from the player, not from the art

Open the player prefab. In the game this skill was built from, the player was a `Rigidbody2D` with
two `BoxCollider2D` and a `CircleCollider2D` (radius 0.8). Unity's 2D physics only ever collides
2D colliders with 2D colliders, so for such a game the playable walls are the small
designer-authored set of `BoxCollider2D` / `CircleCollider2D` on the level prefabs (there: tower
blocks, cross bars at 45° with circle tips, base door posts, barrier strips). The 3D
`MeshCollider`s on the art serve the land-check sphere-cast and shadows and never touch the ship.
Building physics from the 3D colliders (box-approximated, then triangle-rasterised) produced sealed
bases and walls of air; switching to the 2D set fixed both in one step and made every wall nameable.

`unity_colliders2d.py` emits `{kind: box, cx, cy, hw, hh, rot}` and `{kind: circle, cx, cy, r}`
with layer, trigger flag and prefab tag. `write_arena_data.py` turns them into `ARENA_BOXES` /
`ARENA_CIRCLES`; `Arena.buildWalls` makes a fixed body per collider (`cuboid(hw, hh)` with
`setRotation(rot)`, `ball(r)`), and an axis-aligned bound per collider for the flood and the
wall-hit log. Respect the Physics2D collision matrix (players hit Default and Terrain, not Shadows)
and skip triggers.

## Rapier needs to be told to report contacts

`PhysicsWorld2D.createCollider` does not enable collision events. Without
`.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS)` on the ship's collider, no wall-hit callback
ever fires — wall damage and ship-ship damage silently never worked. Keep `setCcdEnabled(true)`
too; a fast ship tunnels through a 0.8-thick bar otherwise.

## Geometry that must be solid but has no collider

The perimeter tunnel ring is plain scene decoration a 2D ship flies through. Rather than invent
boxes, `mesh_walls.py` slices the *render* mesh at the play plane inside Blender: sample every
triangle crossing a thin slab (half-depth 0.45 — wide enough for the walls, narrow enough to miss
the tunnel floor at depth 0, which otherwise fills the corridor solid), rasterise at 0.5 units,
close one-cell holes, merge greedily into rectangles. `write_arena_data.load_2d` appends the result
as axis-aligned boxes. Re-run it after every GLB rebuild that moves that geometry, and keep the
`FAMILIES` tuple to what genuinely needs it.

## Line-of-sight shadows: casters are the collision set

The original lit the arena from the player and projected a shadow-camera render back as a
visibility mask. The port does it with two shadow-casting point lights on the ship (a warm lantern
with falloff, a cool decay-0 fill whose shadow map *is* the mask). What casts matters more than
what receives:

- Let the **collision set** cast, not the art. `Arena.buildOccluders` extrudes every 2D collider
  and every sliced wall through the plane (z −8 … +8) into one merged mesh with a material that
  writes neither colour nor depth, `castShadow = true`; every art mesh has `castShadow = false`.
  This fixed two complaints at once: floor decks a hair behind the plane no longer darken the map,
  and a cross built of many small pieces no longer leaks light between them.
- Consequence to state explicitly: anything that is not a collider no longer occludes. In the
  origin game the base walls were not colliders (only their door posts were), so a ship inside a
  base lit the level around it. Unity's own SHADOWS layer held only the cross stand-ins, so this is closer to the
  original than art-casting was — but it is a design decision the creator should make.
- Visibility map 512 once the casters are a few hundred blocks; the six cube faces are cheap then.

## Lighting configuration, and what an engine upgrade does to it

- The engine reads scene lighting from `worldProfileData.lightingConfig` (`sunIntensity`,
  `sunColor`, `environmentIntensity`, `skyboxIntensity`, `ambientFloor`). A block under any other
  key is silently ignored and the sun runs at its daylight default of 5.0, colour-compensated —
  bright enough to wash the shadow mask out entirely.
- The game's own `dimSceneLighting` then scales every non-ship light by 0.35, sun included, so the
  effective sun is `5 / luminance(sunColor) × sunIntensity × 0.35`.
- After the upgrade from engine 3.1094 to 3.1122 the same point light read roughly **eight times
  weaker** (three.js itself unchanged). The fill at 2.6 no longer reached the arena; 22 restored
  the mask, 35 blew the deck out. Re-measure after every engine upgrade before trusting the
  constants in `VisibilityLight.ts` — and measure in the running game, not by reasoning about it
  (see `verification.md`).
