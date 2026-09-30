# NPC Navigation

Where an NPC can walk, how to tell when it got there, and how fine the navmesh grid is. For
registering and spawning an NPC, see `@docs npc-system.md`.

## Navigation Targets

Not all positions are valid navigation targets — positions too close to walls, or inside buildings and other static obstacles, are not walkable. Use `getGlobalNavMesh()` from `engine/VoxelNavMesh.js` to access `isValidNavigationTarget(pos)` and `findNearestValidTarget(pos)` methods.

**An NPC is not guaranteed to reach the target you give it.** If the target is unreachable (inside an obstacle, or fully enclosed), the engine reroutes the NPC to the nearest walkable cell; the NPC may also stop short when blocked. It will often end up *near* the target rather than exactly on it.

## Detecting arrival

Use the controller's arrival API — do NOT roll your own distance-tolerance check, and do NOT poll `getCurrentPath().length === 0`:

- `npcController.hasReachedDestination()` → `true` once the NPC has finished its path.
- `npcController.isFollowingPath()` → `true` while a path is still active.

**Trap:** on a clean arrival the engine zeroes velocity but does NOT immediately empty the internal path array — so `getPath()/getCurrentPath().length === 0` stays `false` until the ~2-second stuck-detector eventually clears it. Code that gates behavior on path length therefore sees the NPC "freeze for ~2s, then react." `hasReachedDestination()` reports arrival on the same frame the NPC stops.

## Stopping precisely on the target

By default an NPC considers itself arrived within ~0.5m of the final waypoint, so it can stop ~1m short of a precise point. To tighten this:

- `npcController.setArrivalRadius(meters)` — e.g. `setArrivalRadius(0.2)` for a kicker that must reach the ball. The engine adds a deceleration band so the NPC eases in instead of overshooting. Minimum 0.05m.

A tight arrival radius is only meaningful if the navmesh grid is fine enough to represent the stop point — see below.

## Navmesh resolution (cell size)

The navmesh is a grid; its `cellSize` (default **1.0m**) is the smallest distance it can resolve. For gameplay that needs precise positioning (lining up on a ball, squeezing between props), lower it via the terrain system:

```ts
const vts = worldGenerator.getVoxelTerrainSystem(); // VoxelTerrainSystem | null
vts?.setNavMeshResolution({ cellSize: 0.125 });     // rebuilds the navmesh in place
vts?.getNavMeshResolution();                         // read current options
```

This is the single supported way to change resolution — it rebuilds the global navmesh and re-attaches all live dynamic obstacles (pushed crates, etc.), so paths around movable objects keep working across the rebuild. Memory scales ~1/cellSize², so don't go finer than the gameplay needs (0.125–0.25m is plenty for tight work).

## Forged levels (`.vwld`) get their navmesh from the ground mask

A forged city has no voxel columns to scan, so it used to have NO NPC navmesh: the horde flow
field had nothing to sample, every enemy walked a straight line at the player, and stood pushing
against the first bus or tree in the way. `VxlSceneTerrainSystem` now builds the navmesh at load
from the level's ground mask (`VoxelNavMesh.buildFromHeightSampler`): one pass over the mask's
per-column top surface, 1 m cells, 0.5 m step unit — no raycasts, nothing per frame. Buildings,
wrecks and trees block cells through the obstacle providers environment objects already register.
A prebuilt sidecar (`navUrl` on the level asset) still wins when one exists.
`?npcnav=off` on the game URL skips the build for an A/B test drive of the old beeline behaviour.

Related: a melee NPC now faces its target only when a strike is next (in range or mid-swing). While
chasing, its body turns along the path — `NavigationComponent` projects movement onto the facing,
so a chaser held facing the player could never walk a detour and stood "stuck" beside a wreck.

A prop's obstacle footprint is the XZ box of its ground-contact slice (the lowest 1.2 m of its
geometry, `engine/nav/PropFootprint.ts`), not its whole bounding box: a tree blocks its trunk,
not a canopy-sized square of sidewalk. Wide-at-the-ground props (a wreck, a wall) are unchanged.
