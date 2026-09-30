# Porting a 2D level onto the engine

What the engine itself needs to know when a level arrives from another engine as one GLB plus a
collider table, rather than from the forge or the voxel tools. The conversion pipeline (Unity
scene → GLB + colliders) is the CLI's `converting-unity-levels` skill; this page is the engine
side of it — the facts that hold whatever the level came from.

## Physics: contacts must be switched on per collider

Rapier only reports contacts for colliders that ask for them. `PhysicsWorld2D.createCollider`
does not set it, so a ship or wall collider built by game code needs
`desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)` before any contact callback fires —
without it, wall damage and ship-ship damage silently never happen while everything still
bounces correctly. Keep `setCcdEnabled(true)` on anything fast: a 0.8-radius ship at speed
tunnels through a 0.8-thick bar otherwise.

A 2D-physics game only ever collides 2D colliders with 2D colliders. Build the wall set from the
source game's 2D colliders (oriented boxes and circles), not from its art or its 3D mesh
colliders; those are for raycasts and shadows there and produce sealed rooms and walls of air here.

## Lighting from data

Scene lighting is read from `worldProfileData.lightingConfig` — `sunIntensity`, `sunColor`,
`environmentIntensity`, `skyboxIntensity`, `ambientFloor` — and applied by
`GameEngine.applyLightingConfig` at load and on every level switch. A block under any other key is
ignored, and the sun then runs at its daylight default (5.0, luminance-compensated by
`sunColor`), which is bright enough to wash out any player-carried light. Dark interiors want
`sunIntensity` around 0.05–0.15 with `ambientFloor` lifting the unseen parts.

Point-light intensities are engine-version-sensitive: between 3.1094 and 3.1122 the same
`PointLight` read roughly eight times weaker with three.js unchanged. A game that tunes its own
lights should re-measure them in the running scene after an upgrade rather than trust constants.

## Line-of-sight shadows from a player-carried light

The pattern for "you see what your ship's light reaches": two shadow-casting `PointLight`s on
the player — a warm lantern with falloff and a cool decay-0 fill whose cube shadow map is the
visibility mask — with `renderer.shadowMap.enabled` on. Two rules make it hold up:

- Let the **collision set** cast, not the art. Extrude every 2D collider through the play plane
  into one merged mesh with a material that writes neither colour nor depth
  (`MeshBasicMaterial({ colorWrite: false, depthWrite: false })`), `castShadow = true`, and set
  `castShadow = false` on every art mesh. Art casting had floor decks a hair behind the plane
  darkening the map and pieced-together walls leaking light between their parts; a few hundred
  solid blocks are also far cheaper for the six cube faces than the art was.
- Anything that is not a collider then no longer occludes. That is a design decision to make
  explicitly (a room whose walls are decoration lights the outside from within).

## The GLB

For a 3D game whose GLB is the whole world — floors, walls, rooms the player walks through — use
`MeshLevel` (`mesh-level.md`): it builds the physics from a collider JSON and handles lighting and
spawning. The rest of this section is the 2D-on-a-plane case.

One GLB, flattened per material (one draw call each), textures capped and JPEG-compressed, loaded
through `engine.loader` from an uploaded asset and swapped in over procedural stand-ins so the
match is playable whether or not the fetch succeeds. `bitmagic verify` passes on the stand-ins
too, so a verify run during a network drop is not evidence the model loads — grep the console for
the game's own "model failed to load" line.
