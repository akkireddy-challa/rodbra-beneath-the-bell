# Archetype: castle

## When to use

Prompts mentioning: castle, fortress, citadel, keep, stronghold, palace, donjon, fortified manor. Often paired with combat (siege) or adventure (king's hall) mechanics — load `@docs mechanic-combat.md` if applicable.

## Terrain config

Two valid options:

```json
// Option A — flat (board-game-like, top-down strategy view)
"terrain": { "shape": "flat", "groundBlockType": "grass" }

// Option B — castle on a hill (procedural terrain with the keep on a flattened lot)
"terrain": (omit; default procedural noise)
```

Option B is more visually striking (castles on hills). The castle-keep landmark uses `flattenTerrain: true` for its foundation; the surrounding wilderness keeps procedural hills. `cameraMode` typically `third-person` (siege/walk-around) or `top-down` (strategy/RTS).

## Default region structure (4 regions, concentric)

| Region | Position | Radius | Character |
|---|---|---|---|
| `keep` | center (0, 0) | ~10 m | The central tall structure. Carved flat foundation. The castle's "soul" — should be visually dominant. |
| `inner_courtyard` | concentric ring around keep | 10-20 m | Open space with practice dummies, well, banners, stables, smaller buildings (chapel, barracks) |
| `outer_walls` | ring at the perimeter | 25-35 m | Tall stone walls forming a ring or rectangle. Corner towers at quarter-marks. Gatehouse facing one direction. |
| `outside_walls` | beyond the perimeter | varies | Surrounding terrain — wilderness, village approach, moat. NOT castle-specific; depends on hybrid context. |

For circular outer walls, **load `@docs arc-wall-placement.md`** before placing wall segments — front face needs to point OUTWARD (toward attackers), so this is the "inner-island" case from that doc (`R = π/2 - t`).

## Asset palette suggestions

Buildings → `asset3dGenerationTool` (this is exactly what it's for). Walls and props → `voxelAssetCreationTool` (boxes, fast).

- `building_keep` — main castle tower, tall, square or round, asymmetric (arrow slits face outward) — needs `flattenTerrain: true` — `asset3dGenerationTool`
- `building_corner_tower` — narrower tower at wall corners — `asset3dGenerationTool`
- `building_gatehouse` — wider structure with archway, replaces a section of outer wall — `asset3dGenerationTool`
- `building_chapel` / `building_barracks` / `building_stables` — courtyard buildings — `asset3dGenerationTool`
- `castle_wall` — straight wall segment, ~5m tall, ~4m wide piece (asymmetric — battlements/arrow slits face outward) — `voxelAssetCreationTool`
- `well` / `practice_dummy` / `banner_pole` — courtyard props — `voxelAssetCreationTool`
- `cannon` (optional) — for late-medieval / siege context — `voxelAssetCreationTool`

Walls are CRITICAL: castle aesthetics require a clear walled perimeter. Don't skip them.

## Density / count guidance

- 1 keep (always, exactly one)
- 4 corner towers (square layout) or 6 (hexagonal)
- 1 gatehouse (always one — there's a "front" of the castle)
- 3-6 courtyard buildings (chapel + 1-2 barracks + 1-2 stables)
- ~30-50 wall segments around the perimeter (use `arc-wall-placement.md` recipe)
- Sparse courtyard props: 2-4 (well + dummies + banner)

## Common gotchas

- **Wall rotation matters.** For circular castles, walls' front faces (battlements, arrow slits) must point OUTWARD (toward attackers), so use `R = π/2 - t` per `arc-wall-placement.md` (inner-island case). For square castles with linear walls, set rotation per side (north wall: `rotY = 0`, east: `Math.PI / 2`, etc.).
- **Don't forget the gatehouse.** A castle without an entrance reads weird. Replace one straight wall segment with `building_gatehouse` asset.
- **Keep should be tallest.** If the corner towers come out taller than the keep, the silhouette is wrong. Scale-clamp the towers in `building-asset-matcher` config OR generate them at smaller `targetHeight`.
- **Keep needs a flat foundation.** With procedural hills, set `flattenTerrain: true` on the keep object so the engine carves a flat lot. Optionally also for corner towers.
- **Castle interior is its own thing.** If the prompt asks for "castle dungeon", the dungeon is a FORGED interior level of its own, below the keep — load `@docs archetype-dungeon.md` and read its fork first.

## Hybrid combinations

- **Castle on a hill** → procedural terrain + flattened keep foundation + ring of walls. Most natural. Use Option B terrain config.
- **Castle in wilderness** → load also `@docs archetype-wilderness.md`. The castle is one bounded area; wilderness fills the rest.
- **Castle dungeon** → load also `@docs archetype-dungeon.md`. Forge the dungeon as its OWN level and register both in `worldProfileData.levels[]`; `engine.loadLevel(levelId)` switches between them — see `@docs level-system.md` — so the keep's down stairs can hand off to the dungeon properly. A forged dungeon also spans several floors internally, with its own stairs. Procedural-terrain games cannot switch levels; there, put the dungeon adjacent on the same plane but stylized as "underground".
- **Castle siege battle** → load also `@docs mechanic-combat.md`. Defenders on walls, attackers approach from `outside_walls`.

## Skeleton plan (reference only — do NOT write to disk; use as inline planning structure)

```markdown
# World plan — <game name>

## Theme
Medieval circular castle perched on a low hill. Stone keep in the center, 4 corner towers, ringed by tall battlemented walls with a single south-facing gatehouse. Wilderness surrounds the castle.

## Regions
- **keep** — at (0, 0), radius 5m (the building's footprint), 1 building (tall stone keep, ~12m tall) with `flattenTerrain: true`.
- **inner_courtyard** — ring 5m to 18m radius around keep, 4-5 small buildings (chapel + 2 barracks + 1 stables) + 2 props (well + practice_dummy).
- **outer_walls** — circle at radius 25m, 32 wall segments via `arc-wall-placement.md` recipe (inner-island case: front faces OUTWARD). Replace 1 segment at the south (angle ≈ -π/2) with the gatehouse asset.
- **outside_walls** — beyond radius 25m, default procedural wilderness (per `@docs archetype-wilderness.md`).

## Asset palette per region
- keep: `building_keep` (1, with flattenTerrain)
- inner_courtyard: `building_chapel`, `building_barracks`, `building_stables`, `well`, `practice_dummy`, `banner_pole`
- outer_walls: `castle_wall` (32 segments), `building_corner_tower` (4), `building_gatehouse` (1)
- outside_walls: `voxelTree` + `voxelRock` via biome-scatter (`dense_forest`)

## Landmarks
- **the_keep** — at (0, 0), asset `building_keep`. The castle's signature. Tallest structure.
- **gatehouse** — at (0, -25), asset `building_gatehouse`. Player's entry point.

## Layout sketch
```
                  voxelTrees (forest)
              ┌───────┬───────┐
              │  T    │    T  │   ← corner towers
              │   ────┴────   │
              │  /          \ │
              │ │  chapel    ││
              │ │      KEEP  ││   ← walls all around
              │ │  barracks   ││
              │  \          /
              │   ────┬────   │
              │  T    │    T  │
              └───────┴───────┘
                  GATEHOUSE
                  voxelTrees
```
**See `@docs arc-wall-placement.md` BEFORE placing castle walls — circular walls use `R = π/2 - t` (inner-island case, front-face outward).**
```
