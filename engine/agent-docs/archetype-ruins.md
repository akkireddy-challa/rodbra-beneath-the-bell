# Archetype: ruins

## When to use

Prompts mentioning: ruins, post-apocalyptic, wasteland, abandoned, derelict, fallout, decayed, ancient, overgrown ruins, ghost town. Almost always a HYBRID — ruins as a STYLE applied to another archetype (city, village, wilderness, castle).

## Terrain config

Match the host archetype, but lean toward dirt/sand/grass with debris textures rather than asphalt:

```json
// Wasteland aesthetic
"terrain": { "shape": "flat", "groundBlockType": "dirt" }

// Overgrown ruins (default)
"terrain": (omit; default procedural with mid-level grass)

// Sand-buried (desert ruins)
"terrain": { "shape": "flat", "groundBlockType": "sand" }
```

`cameraMode` typically `third-person` (exploration) or `first-person` (atmosphere/horror).

## Default region structure (sparse derivative)

Ruins replace ALL building density rules with **degraded versions at ~30-50% of the host archetype's density**. Inherit the host's region structure but modify each region's character and asset palette:

| Host region | Ruins variant |
|---|---|
| `downtown_core` | Half the buildings remaining (some collapsed); broken streetlights; cars rusted/burnt |
| `residential` | Sparse intact cottages + many collapsed shells; overgrown gardens |
| `village_center` | Broken well; collapsed chapel; one or two intact cottages |
| `outer_walls` (castle) | Half-collapsed walls (gaps every 3-5 segments); one tower missing |

Density typically 30-50% of the base archetype. Empty space and overgrowth do the work.

## Asset palette suggestions

Variant-style: replace each building asset with a degraded version. Buildings → `asset3dGenerationTool`. Debris, broken props, vegetation patches → `voxelAssetCreationTool` (boxes/chunks read as "ruined" just fine — don't generate GLBs for debris piles or broken hydrants).

- `building_ruined_<X>` — cracked, partial wall, overgrown vines (ruined cottage, ruined chapel, etc.) — `asset3dGenerationTool`
- `debris_pile` — chunks of stone / brick / wood, point-snap, scattered — `voxelAssetCreationTool`
- `rusted_car` (replaces parked_car for urban ruins) — `voxelAssetCreationTool`
- `broken_streetlight` / `fallen_streetlight` — point-snap variants — `voxelAssetCreationTool`
- `collapsed_pillar` / `tilted_statue` — ancient-ruins flavor — `voxelAssetCreationTool` (use `asset3dGenerationTool` only if user explicitly wants a detailed statue)
- `overgrown_vine` / `wild_grass_patch` — point-snap, fills empty plots — `voxelAssetCreationTool`
- `voxelTree` (gnarled / dead variants) — sparse, irregular distribution

Use weathered materials: cracked concrete (custom block), mossy stone, rusted iron.

## Density per region

- All "intact" buildings: **30-50% of host archetype density**
- "Ruined" building shells: **same count again** as intact (so total footprint count is ~equal but only half are habitable)
- `debris_pile` props: **0.05-0.10 per m²** in former-built zones (heavy)
- Foliage (overgrowth): use `biome-scatter` `swamp` profile (dense bushes/mushrooms) on former plazas/streets

## Common gotchas

- **Ruins are SPARSE, not empty.** A truly empty map reads as "incomplete", not "ruined". Keep ~30% intact buildings to show "this used to be a place".
- **Don't generate one ruined-X asset per building type.** Pick 3-5 ruined variants and reuse heavily — the inconsistency is part of the ruined aesthetic.
- **Debris piles are essential.** They sell "things were destroyed here". Without them, ruins look "abandoned" rather than "destroyed".
- **Match the host archetype.** "Post-apocalyptic city" needs urban ruined assets (skyscraper-shells, rusted cars), not generic "ancient ruins" (stone columns, statues). Pick the visual era.
- **Suppress streetlights / functional infrastructure.** Working streetlights in ruins look wrong. Use broken/fallen variants only, and at HALF the host density.

## Hybrid combinations

Ruins is almost always a hybrid:

- **Post-apocalyptic city** → load also `@docs archetype-city.md`. Take city's 4-region structure; replace `building_*` with `building_ruined_*`; reduce density to 50%; add lots of debris; add `rusted_car` for parked_car.
- **Ruined village** → load also `@docs archetype-village.md`. Same village layout; broken well; collapsed chapel; 50% intact cottages + 50% ruined.
- **Ancient ruins in wilderness** → load also `@docs archetype-wilderness.md`. Mostly forest; 1 cluster of ancient ruins (collapsed_pillar + tilted_statue + overgrown_vine) as a discoverable landmark.
- **Ruined castle** → load also `@docs archetype-castle.md`. Half the outer walls collapsed (skip every 3rd segment); one corner tower missing; keep partially collapsed; gatehouse intact.

## Skeleton plan (reference only — do NOT write to disk; use as inline planning structure)

```markdown
# World plan — <game name>

## Theme
Post-apocalyptic ruined city, decades after collapse. Cracked asphalt streets, half-collapsed skyscraper shells, rusted cars, debris piles, overgrowth pushing through pavement. Atmospheric, sparse, exploration-focused. Player walks third-person.

## Regions (inherits from archetype-city.md, ruined variant)
- **downtown_core** — center (0, 0), radius 25m. ~3-4 intact ruined skyscrapers + 2-3 collapsed shells. Heavy debris. Rusted cars.
- **residential** — ring 25-50m. ~6 ruined cottages + 6 collapsed shells. Overgrowth on every empty plot.
- **industrial** — south edge (0, 60), radius 30m. 2 ruined warehouses + 5 collapsed shells. Lots of debris and rusted machinery.
- (no parks region — overgrowth is everywhere instead)

## Asset palette per region
- downtown_core: `building_ruined_skyscraper`, `building_ruined_office`, `rusted_car`, `broken_streetlight`, `debris_pile`, `overgrown_vine`
- residential: `building_ruined_cottage`, `rusted_car`, `debris_pile`, `wild_grass_patch`, `dead_tree`
- industrial: `building_ruined_warehouse`, `debris_pile`, `rusted_car`, `dead_tree`

## Landmarks
- **fallen_obelisk** — at (0, 0), in downtown_core, asset `tilted_statue`. The ruined city's central monument. A landmark visible from far away.
- **collapsed_overpass** — at (-30, 30), large debris cluster, asset `debris_pile` (scaled 3x), suggests a former highway.

## Layout sketch
```
              T  (dead trees)
       . . . T . . . . . . T . .
        . r . . . . . r . . . . .       (r = ruined building, . = debris/grass)
       . . [overpass] . . . T . .
        . r . . [obelisk] . r . . .
       . . . . . . . . . . . . .
        . r . . . . . . r . . . T .
       . . T . . [warehouse] . . T
        . . . . . . . . . . T .
              (industrial south)
```
```
