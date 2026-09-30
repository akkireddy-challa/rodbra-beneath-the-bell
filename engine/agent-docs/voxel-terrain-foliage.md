# Voxel Terrain & Foliage

## Painting Terrain Materials by Area

The terrain generator (`generateVoxelTerrain()` in `WorldGenerator.ts`) assigns a block type to every surface position. By default it uses noise to blend between grass/sand/stone, but you can override this to paint specific materials in specific areas.

**To paint a shape on the terrain** (e.g., asphalt track on grass, dirt paths, stone plaza), modify the block assignment inside `generateVoxelTerrain()`:

```typescript
// Inside the x/z loop in generateVoxelTerrain(), BEFORE the default terrain type logic:
// Check if this position is on the track/road/path
const surfaceBlockType = this.getBlockForPosition(x, z, terrainType);

// In a helper method:
private getBlockForPosition(x: number, z: number, defaultTerrainType: number): number {
    // Example: paint a circular track
    const dist = Math.sqrt(x * x + z * z);
    if (dist > 12 && dist < 18) {
        return BlockTypes.ASPHALT;  // road surface
    }
    return this.getBlockForTerrain(defaultTerrainType);  // default
}
```

Use this approach for: racing tracks, roads, plazas, city blocks, rivers, paths, clearings, zones with different materials. Always choose the best material for each area of the level rather than making the entire terrain uniform.

Foliage automatically adapts — ASPHALT and STONE areas get no foliage, GRASS areas get meadow foliage.

## Changing Uniform Terrain Appearance

To change the **entire** terrain surface (e.g., make all grass snowy), edit `WorldGenerator.ts` → `registerBlockTypes()`:

1. **Register a new block type** (add to `BlockTypes`, create texture, register with atlas)
2. **Change the terrain-to-block mapping** in `registerBlockTypes()`:
   ```typescript
   this.terrainBlockMap.set(TerrainTypes.GRASS, BlockTypes.SNOW);
   ```

**Underground blocks** work the same way via `this.undergroundBlockMap`. For example, to put permafrost under snow:
```typescript
this.undergroundBlockMap.set(BlockTypes.SNOW, BlockTypes.ICE);
```

## Procedural Foliage

The built-in ground cover has rooted shader wind on **WebGPU and WebGL**:

- `FoliageSystem`: tapered, folded grass blades, terrain-conforming roots, colour
  patches, and faceted flowers with green stems. Existing palette overrides in
  `initializeFoliageTexture()` still apply.
- `VoxelFoliageSystem`: segmented square grass blades and block flowers. Petal
  colours do not tint the stems. Chunk regeneration is deterministic, and removed
  plants stop bending even below sea level.
- `GroundDetailSystem`: the forged-level grass described below uses a compact
  nine-triangle tuft and a nineteen-triangle flower. Its existing density/scale,
  mowing, instance pooling and distance thinning still apply. Stones and pebbles
  remain still.

Wind runs automatically when foliage renders; no new game update call is needed.
Each system exposes `appearance` with `windStrength` (default `0.28`, range
`0..0.65`), `windSpeed` (default `1`) and `windDirectionDeg` (default `28`, measured
from local +X toward +Z). Strength zero gives still plants. A fixed `time` in
seconds pauses the wind for comparison; `null` resumes automatic time. Inspection
`debug` modes are `final`, `roots`, `wind` and `normals`.

Optional construction overrides go in the final argument of `FoliageSystem`,
`VoxelFoliageConfig.appearance`, or `GroundDetailOptions.appearance`. Existing
constructors remain compatible. Custom voxel foliage creators keep their authored
materials and motion; the engine does not deform arbitrary custom meshes.

For repeatable visual checks, run `node game/scripts/preview-foliage.mjs
/tmp/foliage-preview webgpu` from the repository root (or use `webgl`). The script
builds a standalone HTML gallery of all three actual systems, captures fixed
views/seeds and diagnostics, checks chunk destruction/regeneration, records wind,
and closes its test browser. It starts no server. Final views have no post effects.

`VoxelFoliageSystem` generates decorative ground cover (grass, flowers, pebbles, cacti) at runtime. Foliage is controlled by the `foliageType` property on terrain types:

| Terrain Type | Default foliageType | What spawns |
|--------------|-------------------|-------------|
| GRASS | `FoliageType.MEADOW` | Grass + flowers |
| SAND | `FoliageType.BEACH` | Pebbles |
| ICE, STONE, DIRT, ASPHALT | `FoliageType.NONE` | Nothing |

**To remove all foliage** (e.g., for an ice rink or arena), edit `WorldGenerator.ts` → `registerTerrainTypes()` and set `foliageType: FoliageType.NONE` on the GRASS terrain type:
```typescript
// In registerTerrainTypes(), after creating GRASS terrain:
const grassProps = this.terrainRegistry.getType(TerrainTypes.GRASS);
if (grassProps) grassProps.foliageType = FoliageType.NONE;
```

Alternatively, comment out the `this.generateFoliage()` call in `generateWorld()` to disable all foliage generation.

**To remove foliage from specific areas only**, the terrain under those areas must use a type with `foliageType: FoliageType.NONE` (e.g., ICE, STONE, ASPHALT), or register a footprint exclusion (next section).

### Building footprints: flat, walkable, no grass

Grass and uneven ground showing through a custom building's floor (a diner, a shop) is fixed with one call. It flattens the lot and keeps foliage off it for good, even when its chunks are rebuilt later. Plain `flattenArea` does **not** clear foliage.

```ts
const terrain = this.worldGenerator.getVoxelTerrainSystem();
if (!terrain) return; // terrain.shape 'none' / open water: no voxel ground
// Lot centred on (x, z), 12 m × 8 m, plus 0.5 m of clear apron around the walls.
// The door faces -Z; level the floor with the path 1 m outside it.
const floorY = terrain.placeBuildingFoundation('dream-state-diner', x, z, 12, 8, { margin: 0.5, levelAt: { x, z: z - 4 - 1 } });
// Build the floor/walls on floorY. Removing a temporary building:
terrain.releaseBuildingFoundation('dream-state-diner'); // restores the ground; grass regrows
```

- The floor is levelled to the most common ground level across the footprint (a bump or dip under part of the lot doesn't decide it) and returned as the walkable top. To make the doorway exactly level with a path, pass `levelAt: { x, z }`, a point on the path just outside the door; the floor then matches the ground there, so don't add a step or a raised slab. For an explicit level, pass `height`, a flatten target like `flattenArea`'s (the surface block's base, e.g. `pathTopY - blockSize`).
- Options (all optional, defaults in `DEFAULT_BUILDING_FOUNDATION_OPTIONS`): `height`, `levelAt`, `blockType` (default stone), `margin`, `rebuildMeshes` (default `true`: re-meshes only the lot's chunks, and does nothing before the terrain is first built, so the plain call is fine anywhere in `generateWorld()` or at runtime).
- Calling it again with the same id moves or resizes that lot.
- `getFoliageSystem()` also offers foliage-only calls that leave the terrain unchanged: `addFoliageExclusion(id, minX, minZ, maxX, maxZ)` / `removeFoliageExclusion(id)` for a persistent rectangle, `clearFoliageInRect(...)` (persistent, returns its id), and `clearFoliageAt(x, z, radius)` (one-shot).

## Ground cover on a FORGED level

Everything above is the PROCEDURAL voxel terrain path (`VoxelFoliageSystem`, driven by block types). A forged `.vwld` level has no `VoxelWorld`, so none of it runs there — but forged levels grow ground cover too, from their own **ground mask**: one surface material per 0.5 m cell, baked from the forge spec's `terrain.groundType` / `groundZones` / a path's `groundType`. **A forged level is not a reason to fall back to procedural terrain when a game needs grass.**

Both worlds classify cover with the same `FoliageType` vocabulary (`groundFoliageType()` mirrors `TerrainTypeProperties.foliageType`), so the same design reads on either:

| Ground type | Cover | FoliageType |
|-------------|-------|-------------|
| `grassLush` | dense grass tufts (long grass) | MEADOW |
| `grass` | normal grass | MEADOW |
| `grassDry` | sparse stubble (cut/dry grass) | FIELD |
| `sand`, `dirt`, `gravel` | pebbles only | BEACH |
| `asphalt`, `cobble`, `brick`, `pavers`, `sidewalk` | nothing | NONE |

Ground types also drive **vehicle tyre grip** — asphalt 1.0 down to sand 0.6 — so a forged rally stage behaves differently on dirt than on tarmac with no game code at all.

### NEVER scatter grass as objects

Grass is ground cover, not props. Placing grass patches / tufts / clumps as `environmentObjects` on a forged level is always wrong: it costs thousands of instances, still reads as objects standing ON the ground rather than a field growing out of it, and none of it responds to mowing or trampling. If the field looks thin, **raise the density** — that is the only correct answer:

```
configure_game(configType="groundCover", density=5, scale=1.4)
```

`density` 1 is a city-park sprinkle; 3–6 is a thick meadow with real volume. `scale` grows the tufts. `distance` (default 60 m) is how far out cover is grown — raise it on an open field where thin ground in the distance is obvious. Long grass (`grassLush`) is automatically thicker AND taller than cut grass (`grassDry`), so a mown stripe reads from the driver's seat without any extra work.

### Changing the ground at runtime

The material is mutable, and the engine refreshes the cover for whatever changed. This is how area-clearing gameplay works — mowing, ploughing, burning, paving — with no mesh handling in game code:

```ts
// cells actually converted; 0 when the patch was already cut
const cells = terrain.setGroundTypeInRadius(x, z, deckRadius,
    GROUND_TYPE.grassDry,     // becomes short grass
    GROUND_TYPE.grassLush);   // only where long grass stands
```

`setGroundTypeInRadius` / `setGroundTypeInRect` return **how many cells actually changed**, which is the score: `cells × cellSize²` = m² cleared. Re-driving cut ground returns 0, so points can't be farmed by circling one patch. `getGroundTypeAt(x, y, z)` reads the material under a point. The baked geometry never changes — only what grows on it.

Reference implementation: `samples/ground-type-clearing.ts` (mower scoring loop, compile-checked against the live engine).

## Rounded Voxels

Pass `voxelRoundingRadiusVoxels` (in voxel units, e.g. `0.12`) and optionally `voxelRoundingSegments` (default `2`) to `VoxelWorld` or `VoxelObject` options to give voxel blocks smooth rounded edges and corners — grouped voxels round their outer silhouette only; physics colliders are unchanged; smooth-surface blocks keep the existing sharp/subdivided path.

GLB-voxelized assets support the same look per asset: set `voxelizeSettings.roundedEdges: true` on the asset record in `world.json` (the creator's Re-voxelize dialog exposes it as "Rounded edges"). Render-time only — the baked `.vxl` data is unchanged; the engine applies a fixed 0.4-voxel radius when instantiating the asset.


## Registering block textures

`VoxelTextureAtlas` takes a generated texture per face. Omitted faces fall back to the
one you supply.

```typescript
atlas.registerBlockTexture({
    id: BlockType.SAND,
    name: 'sand',
    size: 16,
    top: this.generateSandTexture(16),
});
```

For a block type that is not in `BlockType`, claim an id first:

```typescript
const SNOW_BLOCK = atlas.getNextBlockId();
atlas.registerBlockTexture({ id: SNOW_BLOCK, name: 'snow', size: 16, top: snowTexture });
```
