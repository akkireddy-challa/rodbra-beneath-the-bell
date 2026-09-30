# Archetype: village

## When to use

Prompts mentioning: village, hamlet, medieval town, settlement, fantasy town, farm village, small town. Distinct from `archetype-city.md` — fewer buildings, no skyscrapers, often grass terrain (not asphalt), rural feel.

## Terrain config

Two valid options depending on the prompt:

```json
// Option A — flat (board-game-like, simple medieval village)
"terrain": { "shape": "flat", "groundBlockType": "grass" }

// Option B — procedural hills (village in a forest clearing, with terrain)
"terrain": (omit; default procedural noise — gives gentle hills)
```

If using procedural hills (Option B), buildings MUST have `flattenTerrain: true` per `PLAN BEFORE BUILD — complex worlds`. If flat (Option A), Y=0 is fine.

`cameraMode` typically `third-person` (player walks around) or `top-down` (RTS-like settlement view).

## Default region structure (3 regions)

| Region | Position | Radius | Character | Density |
|---|---|---|---|---|
| `village_center` | center (0, 0) | 10-15 m | Market square, well, central landmark; 3-5 buildings around the square | medium |
| `outskirts` | ring around center | 15-30 m | Smaller cottages, a couple of workshops, fences | sparse |
| `farmland_edge` | one side (typically +X) | 20-30 m | Optional crop fields, animal pens, maybe a windmill landmark | very sparse |

Smaller villages can drop `farmland_edge` and use just 2 regions.

## Asset palette suggestions

Buildings → `asset3dGenerationTool` (this is exactly what it's for). Wells, fences, carts, barrels → `voxelAssetCreationTool` (boxes are fine, much faster).

- `building_cottage` — small wood/thatch house, ~5m wide, ~4m tall — `asset3dGenerationTool`
- `building_inn` — slightly bigger, two-story, often the village's largest building — `asset3dGenerationTool`
- `building_blacksmith` / `building_workshop` — long low building with chimney — `asset3dGenerationTool`
- `building_chapel` — slim with a steeple, taller than cottages — `asset3dGenerationTool`
- `building_barn` — wide low for farmland_edge — `asset3dGenerationTool`
- `well` — small landmark, point-snap — `voxelAssetCreationTool`
- `fence` — short segments, point-snap (place along property edges) — `voxelAssetCreationTool`
- `cart` / `barrel` — point-snap props — `voxelAssetCreationTool`
- `voxelTree` (oak / pine variants) — point-snap, scattered

Use natural materials (wood, stone, thatch) — no glass-and-steel.

## Density per region

- `village_center`: ~0.04 buildings/m² (well-spaced around a square)
- `outskirts`: ~0.02 buildings + 0.05 props (fences, carts, barrels)
- `farmland_edge`: ~0.005 buildings (1-2 barns max) + scattered crops/trees

## Common gotchas

- **Village ≠ city.** A village has 8-15 buildings total, not 50+. Don't over-fill.
- **Pick a CENTRAL LANDMARK** — well, market square, chapel, statue. Without it, the village has no focal point and feels random. Mark it as a `landmark` in the plan.
- **Building variety matters at small counts.** With only ~10 buildings, repeating the same asset 10 times is obvious. Generate 3-4 variants.
- **Fences add a lot of perceived "village-ness"** — even sparse fence segments along property edges sell the lived-in feel. Use point-snap (`placeOnTerrain: true`).
- If using procedural hills, place the `village_center` on a relatively flat patch — flatten via `flattenTerrain: true` per building, OR carve a village-wide flat lot via the voxel CLI (`node bin/voxel.mjs place ... --flatten-terrain`; see `@docs voxel-cli.md`) first.

## Hybrid combinations

- **Village in a forest** → load also `@docs archetype-wilderness.md`. Use procedural hills, dense trees outside the village_center radius, scatter wilderness elements OUTSIDE the village circle.
- **Ruined / abandoned village** → load also `@docs archetype-ruins.md`. Replace `building_cottage` with `building_ruined_cottage`; suppress `well` to a broken version; reduce density to ~50%.
- **Castle next to village** → load also `@docs archetype-castle.md`. Castle is a `landmark` at one edge; village's 3-region structure unchanged.

## Skeleton plan (reference only — do NOT write to disk; use as inline planning structure)

```markdown
# World plan — <game name>

## Theme
Sleepy medieval hamlet on the edge of a forest. Wood-and-stone cottages around a central well, a chapel and an inn at the village square, scattered farms past the outskirts. Player walks third-person.

## Regions
- **village_center** — center (0, 0), radius 12m, medium density. Well at exact center; chapel + inn + 2-3 cottages arranged around it.
- **outskirts** — ring (12m to 25m radius), sparse. 4-6 smaller cottages + workshops; fences along property lines.
- **farmland_edge** — east side (centered at (35, 0)), radius 15m, very sparse. 1 barn + crop rows + 1 scarecrow.

## Asset palette per region
- village_center: `building_chapel`, `building_inn`, `building_cottage`, `well`, `fence`
- outskirts: `building_cottage`, `building_workshop`, `fence`, `cart`, `barrel`
- farmland_edge: `building_barn`, `crop_row`, `scarecrow`, `fence`

## Landmarks
- **central_well** — at (0, 0), exact village center, asset `well`. Visual focal point.
- **chapel** — at (5, -8), village_center, asset `building_chapel` (only one in the village).

## Layout sketch
```
                        outskirts
                  fence    cottage   fence
                        |          |
   outskirts       chapel  WELL  inn        farmland → barn
                  cottage  square cottage
                  fence    workshop  fence
                        outskirts
```
```
