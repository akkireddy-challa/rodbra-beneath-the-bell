# Archetype: city

> **Default path is the World-Forger, not this doc.** City / town / village / urban prompts are built by the **World-Forger** (`runWorldForger` — it self-directs to a city build from GAME-DESIGN.md, so normally OMIT `cityMode`; set `cityMode: true` only to FORCE a city the concept does not capture), which generates the connected street grid, buildings, landmarks, parks and water — flat or hilly. Use this placed-asset approach ONLY when the user explicitly opts out of a generated city level, or to upgrade individual hero buildings the forger produced.

## When to use

Prompts mentioning: city, town, downtown, urban, GTA, metropolis, cyberpunk city, modern town. Also matches "industrial complex" (use the `industrial` region as the dominant one) and "city with a park" (keep all 4 regions, density-shift toward parks).

## Terrain config

```json
"worldProfileData": {
  "terrain": { "shape": "flat", "groundBlockType": "asphalt" },
  "cameraMode": "third-person"
}
```

`cameraMode` is the player-perspective choice — **`third-person`** for GTA-style street-level, **`first-person`** for walking simulator, **`top-down`** for SimCity-like. Cities ALWAYS use `terrain.shape: 'flat'` regardless of camera — buildings on hills clip badly. GTA-style is NOT top-down; don't conflate "looks like a city" with "needs top-down camera".

## Default region structure (4 regions)

| Region | Position | Radius | Character | Density |
|---|---|---|---|---|
| `downtown_core` | center (0, 0) | 20-30 m | Tallest buildings, dense streetlights, glass skyscrapers, busiest visual | dense |
| `residential` | concentric ring around core | 30-50 m | Smaller apartments, houses, modest height, more spacing | medium |
| `industrial` | one edge (e.g., -X side) | 25-40 m | Warehouses, factories, smokestacks, parked trucks, sparse streetlights | sparse + props |
| `parks` | 1-2 patches (e.g., +Z side) | 15-20 m | Grass swatch via per-area material painting; trees + benches; NO buildings | grass+trees |

A "GTA city park" or any forested patch in the city goes here — paint asphalt away to grass via `generateVoxelTerrain()` per `@docs voxel-terrain-foliage.md`.

## Asset palette suggestions

Buildings → `asset3dGenerationTool` (this is exactly what it's for). Street props → `voxelAssetCreationTool` (boxes are fine, much faster — do NOT generate GLBs for streetlights, parked cars, dumpsters, benches, hydrants).

- `building_skyscraper` — tall, ~30m, glass + steel, downtown core — `asset3dGenerationTool`
- `building_office` — medium-tall, ~20m, brick + glass, downtown / residential — `asset3dGenerationTool`
- `building_apartment` — mid-rise, ~15m, residential — `asset3dGenerationTool`
- `building_shop` — wide low building with awnings, ~8m, residential / downtown corners — `asset3dGenerationTool`
- `building_warehouse` — long flat-roofed, ~10m, industrial — `asset3dGenerationTool`
- `streetlight` — point-snap prop, vertical, with bulb at top — `voxelAssetCreationTool`
- `parked_car` (or several variants: sedan, SUV, truck) — point-snap props, low — `voxelAssetCreationTool`
- `dumpster` / `bench` / `fire_hydrant` — small point-snap props — `voxelAssetCreationTool`

**Naming matters:** prefix building assets with `building_` so `building-asset-matcher` picks them up automatically when computing lot fits.

## Density per region (buildings/m²)

- `downtown_core`: **0.10** (≈1 building per 10 m²) → dense canyon feel
- `residential`: **0.05** → comfortable spacing
- `industrial`: **0.02** buildings + **0.05** props (cars, dumpsters, crates) → sparse but cluttered with small objects
- `parks`: **0** buildings, **0.02** trees + benches via `biome-scatter` (use `garden` profile)

## Common gotchas

- **GTA-style ≠ top-down.** Set `cameraMode: 'third-person'`. The "GTA look" is third-person on flat ground, not top-down.
- **Don't sprinkle trees on asphalt.** `biome-scatter`'s urban-suppression rule kicks in when `building_lot + asphalt > 30%` — trust it. If you want a forest patch, use `parks` region with explicit `scatterType: 'garden'`.
- **All buildings need `flattenTerrain: true`** if terrain isn't shape='flat' (per `PLAN BEFORE BUILD — complex worlds` in voxel-asset-instructions.md). For asphalt-flat city, Y=0 placement is fine.
- **Streetlights / cars / decorations are point-snap** (`placeOnTerrain: true`), NOT flatten-footprint. Only buildings carve foundations.
- **Don't generate one of every building type per region** — pick 2-4 and reuse them with rotation/scale variation. Asset reuse keeps the city feeling cohesive.
- **Camera mode top-down + `terrain.shape: 'flat'`** is belt-and-suspenders for top-down city games — set both.

## Hybrid combinations

- **Post-apocalyptic city** → load also `@docs archetype-ruins.md`. Replace `building_*` assets with degraded versions; add debris props; suppress streetlights and parked-car density.
- **Forest park inside city** → keep 4-region structure; `parks` region uses `archetype-wilderness.md` biome-scatter rules instead of city decor.
- **Castle next to city** → load also `@docs archetype-castle.md`. Castle goes in a `landmark` slot (1 entry) at the edge; city's 4-region structure unchanged.

## Skeleton plan (reference only — do NOT write to disk; use as inline planning structure)

```markdown
# World plan — <game name>

## Theme
Late-1980s GTA-style downtown. Gritty third-person urban driving. Asphalt streets, glass-and-concrete skyscrapers in the core, brownstone apartments outside, an industrial wharf at the south edge, and a small green park at the north.

## Regions
- **downtown_core** — center (0, 0), radius 25m, dense, 6-8 tall buildings (skyscraper + office mix). Wide cross streets at N-S and E-W axes.
- **residential** — concentric ring around core, outer radius 50m, medium, 12-15 apartments + shops at corners.
- **industrial** — south edge (centered at (0, 60)), radius 30m, sparse, 3-4 warehouses + 8-10 parked trucks + dumpsters.
- **parks** — north edge (centered at (0, -45)), radius 15m, grass patch (paint via generateVoxelTerrain), 6-10 trees + 2 benches, NO buildings.

## Asset palette per region
- downtown_core: `building_skyscraper`, `building_office`, `streetlight`, `parked_car_sedan`
- residential: `building_apartment`, `building_shop`, `streetlight`, `parked_car_sedan`, `bench`
- industrial: `building_warehouse`, `parked_truck`, `dumpster`, `crate`
- parks: `voxelTree`, `bench`

## Landmarks
- **city_hall** — at (0, 0), centered in downtown_core, asset `building_office` scaled 1.5x.
- **harbor_lighthouse** — at (-50, 60), industrial edge, asset `building_lighthouse` (generate explicitly).

## Layout sketch
```
        parks
          |
   residential
          |
   downtown_core (city_hall)
          |
   residential
          |
   industrial -- lighthouse
```
```
