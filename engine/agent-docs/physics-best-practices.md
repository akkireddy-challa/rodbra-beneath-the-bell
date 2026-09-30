# Physics & Three.js Best Practices

## Rapier Physics Integration

The physics system uses Rapier (physics engine compiled to WebAssembly).

## Raycast Queries (ground checks, line of sight, aiming)

`engine.physicsWorld.raycast(origin, direction, maxDistance, collisionMask)` — null-guard `engine.physicsWorld` first (Rapier loads async). The mask is a bitmask from `engine/CollisionLayers.js`: ground checks want `CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT`; line-of-sight/hit-scans want `CollisionMask.ALL`; to hit only NPCs use `CollisionGroup.ENEMY`. Sensor colliders (water, triggers) never register hits. The result carries `hasHit`, `hitPoint`, `hitNormal`, `hitDistance`, `hitRigidBody`. `raycastWithFilter(...)` additionally excludes specific bodies (e.g. the shooter's own).

**Characters block the player one way, and can never trap it.** The player's collide-and-slide
treats NPCs, animals and dynamic props as solid, but none of them are blocked by the player
(their masks decide; see `CollisionLayers`), so a melee NPC can walk straight into the player's
capsule. Rapier then refuses any move deeper into that body. So after a blocked frame the motor
looks up the bodies overlapping the capsule (`PhysicsWorld.overlappingColliderHandles`) and
ignores each of them for moves AWAY from it only (`engine/physics/TrappedBodies.ts`): you can
always step out of a body that is inside you, and you can never walk through one. A ring of
attackers that has closed in is therefore a real trap — by design; NPCs step back from a moving
player that overlaps them (`setRetreatFromPlayerOverlap`, on by default) unless a game turns
that off for its attackers.

Reference implementation: `samples/raycast-ground-check.ts` — read it via `read-docs(name="samples/raycast-ground-check")` when implementing ground probes or line-of-sight.

## Collision & Trigger Events

Subscribe to contacts per rigid body: `engine.physicsWorld.registerCollisionCallback(body, callback)` / `unregisterCollisionCallback(body, callback)`. The callback receives a `ContactInfo`: `bodyA`/`bodyB`, `colliderA`/`colliderB`, `contactPoint`, `contactNormal` (world space), `penetrationDepth`. Callbacks fire while the physics substep drains its event queue (same frame, not mid-solve); multiple callbacks per body are fine and unregistering is idempotent.

Trigger volumes are SENSOR colliders — they report overlap but never push back. Subscribe globally with `engine.physicsWorld.addSensorListener({ onIntersectionStart(h1, h2), onIntersectionEnd(h1, h2) })` / `removeSensorListener(...)`. The two arguments are COLLIDER handles — keep your own sensor's `collider.handle` and filter on it, then map the other handle back to the entity. Remember raycasts skip sensors entirely (see Raycast Queries above).

## Three.js Geometry Orientation

### CRITICAL: CylinderGeometry Default Orientation

`THREE.CylinderGeometry` creates cylinders that are oriented along the **Y-axis (vertical)** by default, NOT the Z-axis!
When creating weapons or tools, ensure you rotate the geometry or mesh correctly.

## Interactive UI (Dialogues, Shops, Menus)

When showing in-game UI that needs mouse clicks (NPC dialogues, shops, inventory screens), use `this.engine.enterInteractiveUI()` to release the cursor without the blur overlay, and `this.engine.exitInteractiveUI()` when the UI is dismissed. **NEVER call `document.exitPointerLock()` directly** — the engine reads a lost lock as the player leaving, and pauses the game behind the pause card.

## Forced Object Positioning (force_position)

When placing voxel objects with the voxel CLI (`node bin/voxel.mjs place ...`; see `@docs voxel-cli.md`), positions are normally auto-adjusted to the terrain surface. Use `--force-position` to skip **all** automatic ground-height calculation and terrain adjustments, placing the object at the exact (x, y, z) you provide. **`--y` is required when using `--force-position`.**

Use `force_position` when:
- Placing objects inside tunnels or caves (raycast hits the ceiling otherwise)
- Placing objects partially underground or embedded in terrain
- Placing objects in mid-air (hanging signs, floating platforms)
- Any situation where the automatic ground snap gives the wrong result

## Common Mistakes to Avoid

1. **Creating Visual Objects Without Physics Bodies:** Always add physics bodies for collidable objects.
2. **Rigid Body Construction Info:** Pass all parameters to the constructor; setters are often missing.
3. **Physics Body Name Assignment Issue:** Always assign `name` to the physics body if collision logic depends on it (e.g. `body.name = mesh.name`).
4. **Moving Platforms: setTranslation vs setNextKinematicTranslation:** For kinematic moving platforms, use `setNextKinematicTranslation()`—NOT `setTranslation()`. Only `setNextKinematicTranslation()` lets Rapier compute velocity so the player moves with the platform. See `@docs moving-platforms.md`.

## Scaling Physics Objects

Rapier colliders cannot be scaled in place, so scaling a physics object means scaling the visual and REBUILDING the body. For the player: `scaleCharacterToHeight()` (`engine/CharacterConfig.js`) for the mesh, then `playerController.setCapsuleDimensions(height, radius)` + `playerLoader.updateCapsuleDimensions(height, radius)` and `playerLoader.recreatePhysicsBody(player)` — which preserves position and velocity across the swap. See `engine/DonaldDuckExampleCharacter.ts` for the complete worked example.

## Moving / teleporting a DYNAMIC object (chair, crate, barrel, cart, prop)

**Never reposition a dynamic rigid body by setting its Three.js mesh transform, and never call `body.setTranslation()` on its own.** Both leave the body's old velocity intact and can drop it overlapping a neighbour (e.g. a chair placed into a table). A frame or two later Rapier's solver violently ejects the penetrating body — the prop "suddenly shoots across the map." This is a common, hard-to-debug failure.

Use the engine helper, which zeroes linear + angular velocity, sets the transform with the correct Rapier calls, and wakes the body: `engine.physicsWorld.teleportDynamicBody(body, { x, y, z }, yaw?, { overlapResolution }?)` — `body` is the `RAPIER.RigidBody` (e.g. `voxelObject.getRigidBody()`), `yaw` is an optional Y rotation in radians (omit to keep current).

**You choose how an overlap is resolved**, because the right direction depends on the object. Overlap is detected from the body's actual colliders (not a bounding box). Returns the final world position (moved only if resolution moved it).

- `overlapResolution: 'horizontal'` — if the placement overlaps something, slide outward in X/Z to the nearest clear floor spot. Use for **floor objects**: a chair an NPC sits on must move *beside* the table, never end up *on* it. (This is the right choice for the tavern chairs.)
- `overlapResolution: 'up'` — lift straight up until clear. Use for objects that belong **on a surface**: a cup/mug/plate goes onto the table, not next to it.
- `'none'` (default) — place exactly where asked; zeroed velocity still prevents the momentum launch. Use when you've already computed a guaranteed-clear spot.

If the object also drives a navmesh obstacle, the obstacle follows automatically — no extra call.

## Runtime-movable placed props need `dynamic: true`

An environment-object prop that gameplay code moves at runtime (kicked ball, pushed crate, thrown barrel) **must be placed with `dynamic: true`** (`voxel place … --dynamic`, or `dynamic: true` in a `world-edit write` record). The engine only builds an individual `VoxelObject` (with its own physics body, registered in `ObjectIdService`) for props flagged `interactable` / `collectible` / `destructible` / `dynamic`; everything else is merged into a static InstancedMesh for performance. So a runtime `getObjectIdService().getAllByType('object')` lookup of a plain prop returns the shared mesh, not a movable object — and the mechanic can neither grab nor move it. Symptom: a `…not an individual VoxelObject (likely batched as static)…` warning and an inert prop. This is a cross-step contract: when a mechanic will move a placed prop, that placement must be `dynamic`.

Beyond scripted movement, **small loose props are `dynamic: true` by default as a matter of feel**: traffic cones, trash cans, barrels, crates and similar knockables should be plowed aside by a car, not stop it dead like a bollard (players read a static cone as broken). Dynamic props spawn asleep and wake on contact, so a level full of them costs nothing at rest — the
engine keeps them asleep through its own gravity hold/release at load, and a batched (pristine)
prop that Rapier wakes without a real push — it sits a few centimetres inside the voxel-rounded
surface, or the environment collider under it was not enabled yet (colliders are enabled lazily by
camera frustum) or got toggled — is put back to sleep where it was authored instead of promoted
(`PristineDynamicVoxelObject.shouldPromoteOnWake`). Only a prop pushed faster than 0.75 m/s or
displaced more than 20 cm leaves the batch. Before this, every prop in a forged city woke on the
first step after Play and stayed awake: two hundred awake compound bodies cost ~180 ms per physics
step (2 fps); asleep they cost nothing. Anchored objects (lamp posts, hydrants, fences, statues) stay static — hitting those SHOULD stop a vehicle. **Give each dynamic prop its real-world `mass` in kg** (traffic cone ~4, trash can ~15, crate ~40, barrel ~80): an omitted mass falls back to a bounding-box estimate that reads sparse shapes (poles, torches) as far too heavy.

## Keeping Objects Active Off-Screen

NPCs, animals and vehicles are **always-active by default** (`NpcController`, `AnimalController`, `Vehicle`) — they keep simulating, and keep the terrain beneath them loaded, regardless of camera direction. Snakes (`SnakeController`) are the exception among animals: they default to not always-active. Call `setAlwaysActive(false)` only for ambient/background entities that are safe to freeze off-camera. Dynamic `VoxelObject`s are the exception: they hibernate (frozen and hidden) when outside the camera view, so a rolling boulder or any other prop that must keep moving off-screen needs an explicit `setAlwaysActive(true)`. See `@docs spawning-system.md` → "Entity Activation".
