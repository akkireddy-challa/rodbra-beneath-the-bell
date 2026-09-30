# Named trimesh query

Baked levels expose the collider geometry of their named trimesh surfaces, queryable at
runtime by the object's GLB node name: a VxlScene `.vwld` (objects flagged with the
**trimesh collider** voxelize option) or a mesh level (its trimesh colliders — a low-poly
forged world). For a race track, ask the engine for its driving line directly
(`getTrackCenterline`). For other surfaces, read the raw geometry (`getTrimesh`) — e.g.
to place checkpoints along a road or sample a ramp.

## Which source for a track/run path? (precedence)

1. **A World-Forger `kind: "path"` gameplay feature exists** (`worldForgerFeatures` on the
   level asset / `bmGameplayFeatures` GLB extras) → use it. It is the designer's authored
   flow: ordered control points in travel direction, with start/finish/checkpoints, for
   open runs AND loops. This is authoritative — do NOT re-derive from geometry. See
   `@docs world-glb-forge.md`.
2. **No path feature, but the surface is a single closed loop** (imported/hand-built circuit)
   → `getTrackCenterline(name)`. It reconstructs a centered driving line from geometry, but
   only resolves clean LOOPS (open runs and figure-8s do not).
3. **You need raw surface samples** (ramp heights, road shoulders) → `getTrimesh(name)`.

## API

On the voxel `WorldGenerator`, via `getBakedLevel()` — the VxlScene bake or the declared
mesh level, whichever the world has; null for procedural voxel terrain.
(`getVxlSceneTerrain()` still returns the VxlScene alone.)

- `getTrimeshNames(): string[]` — node names of every flagged trimesh object in the level.
- `getTrackCenterline(name, options?): { x, y, z }[]` — an ordered, road-centered,
  evenly-spaced, **closed loop of waypoints** along that surface, in world coordinates,
  ready to drive (see `@docs vehicle-ai.md` for the follow loop). This is the path you
  want for a track: it already handles corners, road-centering, layered bridges, and
  sections that run parallel across the infield, so build the racing line with it rather
  than deriving one from raw geometry. Returns `[]` if the object isn't found or its
  surface isn't a usable loop. `options` are all optional — `waypointCount`, `reverse`
  (flip direction), and sampling/recenter tuning; defaults in `DEFAULT_TRACK_CENTERLINE_OPTIONS`.

  **Direction is resolved for you**: the lap is returned running the way the `player`
  spawn point faces, so its order already matches the grid the level was designed around.
  Override with `orientTo: { position, heading }` when the racing direction is defined by
  something else (a lap-gate sequence, a level with no player spawn); `reverse: true` then
  flips whatever that resolved to. Use the SAME returned array for grid placement, AI
  waypoints and lap progress so they can never disagree.
- `getTrimesh(name): { vertices: Float32Array; indices: Uint32Array } | null` — the raw
  surface, merged across all chunks. `vertices` is a flat x, y, z array; `indices` index
  into it. For uses other than a driving line.

World coordinates match the physics bodies, so results need no transform to line up with
the running level. The engine builds the line's geometry only — the AI follow logic lives
in game code.

## Notes

- Only objects flagged as a trimesh collider at voxelize time are returned. The query name is the GLB node name used there.
- `getTrackCenterline` assumes a single loop — oval, ring, and bent/kidney shapes all work. A figure-8's self-crossing is ambiguous and may not resolve into a clean lap; author those waypoints manually.
- Results are cached per name on first query.
- Levels baked before this feature carry a single unnamed surface and return no names until re-baked.
