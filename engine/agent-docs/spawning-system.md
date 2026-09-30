# Entity Spawning System & Vehicles

> **Coordinate convention:** Spawn positions are absolute world coordinates. Spawn rotation, when supplied, is yaw in radians around +Y. Entities use the **+Z gameplay forward** convention — `spawnRotation: 0` places the entity facing world +Z (its local +Z column). `SpawnRelation.IN_FRONT` correctly offsets along the entity's +Z (its visible front). See `@docs coordinate-system.md` §2 and `@docs vehicle-system.md` for the cardinal-yaw table.

## Where to spawn: the unified spawnPoints data

WHERE entities start is world.json DATA, not code literals: `worldProfileData.spawnPoints[]`
holds typed entries (`{ id, type, position, rotationY, params? }`, open `type` vocabulary).
`player` entries are engine-consumed automatically (first = start, all = multiplayer spread);
for everything else read `engine.getSpawnPoints('npc' | 'animal' | 'vehicle' | ...)` and spawn
one entity per entry using its `params` (archetype/behavior, species, vehicleType, ...). Reading
the data keeps positions editable without code changes; hardcode positions only for entities the
data genuinely doesn't describe. The asset side writes entries via the world-edit CLI
(`spawnpoint upsert`).

## Two-Tier Spawning Architecture

The game provides a two-tier spawning architecture:
1. **Generic `Spawner`** - Foundation for ground height detection and positioning (any entity type)
2. **Specialized Helpers** - Entity-specific logic (e.g., `VehicleSpawner` for vehicles)

## Generic Spawner - Foundation for All Entities

The `Spawner` class provides core ground detection utilities for ANY entity type.
See `Spawner.ts` for implementation details and methods like `getGroundHeight`, `calculateSpawnPosition`, and `findNearbyValidPosition`.

**Use Generic Spawner For:**
- NPCs, props, collectibles, obstacles
- Custom entities that need ground positioning
- Manual positioning calculations
- Ground height queries for gameplay logic

## Placement validation: NEVER assume a uniform ground level

On a world without a voxel grid (`terrain.shape: 'none'` with a `MeshLevel`, or a baked map)
`findValidVoxelSpawnPosition` resolves the floor with physics raycasts — pass the storey's Y for
interior spawns so a roofed room resolves to its own floor (`mesh-level.md`).

**Ground height is NOT uniform.** Baked VXL levels, hills, and multi-level terrain all return different `getGroundHeight(x,z)` values across the map, and the **player spawn pad is frequently several meters above the surrounding streets/ground**. So:

- ❌ **NEVER hardcode a ground Y** (`const BASE_GROUND_Y = 13`) or **infer a single global ground level from the player spawn position**. A guessed constant + tight tolerance will reject the entire map wherever the real ground differs, and your cars/NPCs/props silently never appear.
- ❌ **NEVER gate placement on `Math.abs(getGroundHeight(x,z) - SOME_CONSTANT) <= tol`.**
- ✅ To place an entity at `(x,z)`, call `spawner.getGroundHeight(x, z)` (or `calculateSpawnPosition`) **per position** and **use the returned value as the spawn Y**. Reject a candidate **only when it returns `null`** (void / out of bounds). The specialized spawners (`VehicleSpawner.spawnVehicle`, `engine.registerNpc(...).spawn(x, z)`) already snap to ground internally on any terrain including baked levels — let them.
- ✅ If you genuinely must **exclude rooftops** (e.g. only place on streets, not on buildings), compare each candidate against a **street reference sampled at runtime**, e.g. `const streetY = spawner.getGroundHeight(playerSpawn.x, playerSpawn.z)` then `Math.abs(getGroundHeight(x,z) - streetY) <= tol` — **never a literal constant**, and remember the spawn pad itself may be elevated above the streets, so sample a known street point if you have one.

```typescript
// ❌ WRONG — guessed constant rejects the whole baked city; nothing spawns.
const BASE_GROUND_Y = 13;
const isOpen = (x, z) => Math.abs(spawner.getGroundHeight(x, z) - BASE_GROUND_Y) <= 3.5;

// ✅ RIGHT — accept any real ground; let the spawner place at the actual height.
const findOpen = (x, z) => spawner.getGroundHeight(x, z) !== null ? { x, z } : null;
```

## Entity Activation: importance tiers and always-active

**Preferred for mass entities: `importance: 'crowd'` (NPCs and animals).** Register mass/filler entities with `importance: 'crowd'` (`engine.registerNpc(name, behavior, { importance: 'crowd' })`, `createAnimal(..., { importance: 'crowd' })`). The engine then manages activation dynamically per distance and visibility: crowd entities scale their AI/animation/physics rates down with distance, hibernate entirely only when idle AND far, and **keep progressing toward their goals instead of freezing** — a chasing horde still arrives even when off-screen. The default tier is `'hero'`: full simulation fidelity at any distance, for anything gameplay-critical (racing opponents, escort/chase targets, bosses, patrols, scripted movers). Promote at runtime with `handle.setImportance('hero')` when a crowd entity becomes gameplay-critical.

**Distance is measured as min(camera, player):** crowd entities near the PLAYER keep full simulation rates even when the camera is far overhead (top-down or cinematic views).

**Manual control: `setAlwaysActive(boolean)`.** Every spawned **NPC, animal, and vehicle** also carries an **always-active** flag, toggled via `setAlwaysActive(boolean)` on its controller (`NpcController` / `AnimalController` / `RapierVehicle`); the engine default is `true` — except for snakes (`createSnake` / `SnakeController`), which default to `false` and need an explicit `setAlwaysActive(true)` to keep simulating off-camera. With `false` the entity **hibernates** (AI + physics suspended, mesh hidden) whenever its terrain chunk leaves the camera frustum — it does not move, react, collide, or take damage until it returns to view. This remains supported for full manual control — e.g. activating exactly the current race's participants, or freezing a village until the player arrives — and it is the only mechanism for vehicles, which have no importance tier. For ordinary mass NPCs/animals, prefer `importance: 'crowd'`, which subsumes it.

**Why it matters (engine internals):** terrain collider enable/disable is driven by camera frustum, and the kinematic character controller treats a frustum-disabled collider as absent. A non-anchored (`setAlwaysActive(false)`) entity standing on a chunk outside the frustum — common, because thin ground slabs fall below the view while a taller body still renders — finds no floor and sinks through the world. always-active anchors that chunk so the floor is always present. Crowd-tier entities handle this automatically: the engine keeps the floor present for any crowd entity that is still simulating. (Player-driven vehicles are always active regardless of the flag.)
