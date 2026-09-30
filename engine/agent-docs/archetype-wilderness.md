# Archetype: wilderness

## When to use

Prompts mentioning: forest, wilderness, woods, jungle, mountain, hills, island, taiga, savanna, beach, desert, arctic, tundra, ocean shoreline. The default 3D world archetype — most "non-urban" prompts land here.

## Terrain config

```json
"terrain": (omit; default procedural noise — gives gentle hills)
```

**Do NOT set `terrain.shape: 'flat'`.** The hills are the gameplay. Procedural noise terrain is exactly what wilderness needs. `cameraMode` typically `third-person` (player walks/runs) or `first-person` (immersive).

For biome variants, change `groundBlockType` only:
- Forest / generic: omit `terrain` entirely (default grass).
- Desert: `terrain: { groundBlockType: 'sand' }` (still procedural — sand has dunes).
- Snow / arctic: `terrain: { groundBlockType: 'ice' }`.
- Tropical / beach: `terrain: { groundBlockType: 'sand' }` + paint grass inland via `generateVoxelTerrain()`.

## Default region structure (variable)

Wilderness is the LEAST region-structured archetype. Most maps have one biome covering everything, with optional sparse landmarks. Three default patterns:

**Pattern A — single-biome forest / desert / snow:**
- One implicit region: the whole map. Density rules from `biome-scatter` per biome.
- 0-3 landmarks (cabin, ruins, watchtower) optionally placed.

**Pattern B — biome transition (e.g., forest → mountain → snow peak):**
- 2-3 zones across the map (e.g., low-elevation grass, mid-elevation stone, high-elevation snow). Use `voxel-terrain-foliage.md` per-area painting.

**Pattern C — island:**
- Inner land + shoreline + water. Set up via `voxel-terrain-foliage.md` painting (sand near the edges, grass inland, water at the boundary).

## Asset palette suggestions

Wilderness emphasizes natural decor over buildings.

- `voxelTree` (oak / pine / birch / palm variants) — point-snap, scattered via `biome-scatter`
- `voxelRock` (small / medium / boulder variants) — point-snap
- `voxelBush` / `voxelFlower` / `voxelMushroom` — point-snap, biome-dependent
- Landmarks (rare, agent-authored, NOT scattered):
  - `building_cabin` — single small cottage
  - `building_watchtower` — tall narrow structure with platform
  - `building_ruins` — degraded structure (use `archetype-ruins.md` aesthetics)
  - `tent` / `campfire` — small camp landmark

## Density per biome (via `biome-scatter`)

- `grass`: treeDensity 0.12, rockDensity 0.04, bushDensity 0.06, flowerDensity 0.04
- `stone` (mountain): rockDensity 0.18, treeDensity 0.02, mushroomDensity 0.02
- `sand` (desert): cactusDensity 0.02, rockDensity 0.02, treeDensity 0.03 (sparse palms)
- `snow` (arctic): rockDensity 0.05, no trees, no flowers
- `water` (ocean / lake): no scatter — paint terrain only

For a denser forest: explicitly use `scatterType: 'dense_forest'` per cell (treeDensity 0.30).

## Common gotchas

- **DON'T flatten the terrain.** The hills are the gameplay. If the user says "forest" but you're tempted to set `terrain.shape: 'flat'` because it's "easier" — DON'T. The wilderness archetype is the one place flat-mode is wrong.
- **All scattered objects use `placeOnTerrain: true`** (point-snap). Never `flattenTerrain` for a tree — flattening a forest into 100 carved lots looks awful.
- **Landmarks (cabin, ruins, watchtower) DO use `flattenTerrain: true`** — buildings on procedural hills need carved foundations or they clip.
- **Don't over-fill with named landmarks.** Wilderness shines as wilderness — 0-3 landmarks total. The "feel" comes from the terrain shape + density, not from landmarks.
- **For islands, water is the FRAME, not a region.** Paint sand near the shoreline and grass inland. The water surface is engine-rendered when `groundWorldSizeX/Z` extends past the painted terrain.

## Hybrid combinations

- **Wilderness with a town** → load also `@docs archetype-village.md`. Village goes in one bounded area (~30m radius); wilderness scatter fills the rest.
- **Castle in the wilderness** → load also `@docs archetype-castle.md`. Castle is one landmark on a flattened lot; rest of map is wilderness.
- **Wilderness with ruins** → load also `@docs archetype-ruins.md`. Sparse degraded structures scattered through the forest as found-environment landmarks.
- **Wilderness racetrack (rally)** → load also `@docs archetype-racetrack.md`. Track painted as `dirt` through the procedural terrain (NOT flattened); walls are tree-line + rocks rather than jersey barriers.

## Skeleton plan (reference only — do NOT write to disk; use as inline planning structure)

```markdown
# World plan — <game name>

## Theme
Dense temperate forest with rolling hills. A lone hunter's cabin sits in a clearing. Wildlife and weather sounds. Player walks third-person, can climb hills, finds the cabin as a hidden landmark.

## Regions
- **forest** — entire map, default biome 'grass' with `scatterType: 'dense_forest'`. Rolling hills via default procedural noise (heightMultiplier=3).
- **clearing** — one ~15m-radius patch at (40, -20), `scatterType: 'sparse'` (or 'none'), where the cabin sits.

## Asset palette per region
- forest: `voxelTree` (oak + pine variants), `voxelRock`, `voxelBush`, `voxelMushroom` (all via `biome-scatter`, dense_forest profile)
- clearing: `building_cabin` (1, with `flattenTerrain: true`), `tent` (1), `campfire` (1)

## Landmarks
- **hunters_cabin** — at (40, -20), in the clearing, asset `building_cabin`. Carved flat foundation, pointing southwest. Only "built" structure on the whole map.

## Layout sketch
```
                . . . . . . . . . .       (rolling forest, dense trees)
               . . . . . . . . . . .
              . . . . hills . . . . .
             . . . . . . . . . . . . .
              . . . . [cabin] . . . .   (clearing at (40, -20))
             . . . . . . . . . . . . .
              . . . . . . . . . . . .
                . . . . . . . . . .
```
```
