# Archetype: racetrack

> **Coordinate convention:** Cars and walls use **+Z gameplay forward** — see `@docs coordinate-system.md` §2 and the cardinal-yaw table in `@docs vehicle-system.md`. Use `headingToward()` / `headingTangent()` / `layoutGridOnLoop()` rather than hand-rolling yaw constants.

## When to use

Prompts mentioning: race, racing, lap, circuit, loop, track, derby, drift, F1, NASCAR, GP, motorsport, rally course. For the player-vehicle and lap-counter mechanics, ALSO load `@docs mechanic-racing.md`.

**In a Bitmagic GDK project (a `bitmagic` CLI scaffold), the circuit itself comes from
`bitmagic forge`** — the level's shape is the mechanic, and a forge is tens of sparks, so ask the
creator first when they have not said prototype or polished (the project's
`choosing-asset-pipelines` skill has the rule and the costs). This recipe is then how you wire the
cars, the start grid, the lap counter and the walls onto the forged level. Do not paint a circuit
onto the baseline terrain in code. The voxel-pieces rule below is about the trackside PIECES, and
its "never a World-Forger rebuild" is for the hosted Creator, whose level already exists.

## Terrain config

```json
"terrain": { "shape": "flat", "groundBlockType": "asphalt" }
```

Always flat. Cars on hills handle terribly. `cameraMode` is your call — `top-down` for arcade/derby, `third-person` for behind-car GP-style, `first-person` for cockpit cam.

If the prompt explicitly asks for a "rally" / "off-road" track, use `'dirt'` or `'sand'` as `groundBlockType` instead of asphalt.

## Default track shapes (4 archetype variants)

Pick ONE shape based on the prompt:

| Shape | Triggers | Geometry |
|---|---|---|
| `oval` | "oval", "speedway", "NASCAR" | Single closed loop, ~60-100m long axis |
| `figure_8` | "figure-8", "figure of eight", "derby crossover" | Two loops meeting at a crossover X. Inner-island walls per loop + outer envelope |
| `road_course` | "road course", "GP", "Suzuka", default for "track" | Polygonal closed loop with 6-12 turns of varying radius |
| `drag_strip` | "drag", "1/4 mile" | Straight line + return road |

For each shape, the layout is **track surface (lighter asphalt) + barriers + start line + decorations**.

## Default region structure

| Region | What it contains |
|---|---|
| `track_surface` | The drivable lane. Painted on the flat ground per `voxel-terrain-foliage.md`. Width: 8-12m. |
| `inner_island` | Center of each loop — walls (jersey barriers), occasional decoration (palm tree, advertising sign) |
| `outer_envelope` | Outer-edge walls keeping cars on track. Tire walls or jersey barriers. |
| `pit_lane` | Optional. One straight section parallel to start line, with garage building |
| `spectator_zone` | Optional, perimeter. Stands, light poles, flags |

## Wall placement — CRITICAL

For curved walls along arcs of any track shape, **load `@docs arc-wall-placement.md` BEFORE writing wall placement code**. The doc explains the `rotY = π/2 - t` vs `rotY = -π/2 - t` distinction (inner-island walls front-faces-outward; outer-envelope walls front-faces-inward). Using one formula for both → half the walls 180° off (most common figure-8 bug).

Use `voxelAssetCreationTool` to make a `jersey_wall` or `tire_barrier` asset (a few colored boxes is enough — these are simple shapes), then place segments along the curve with the recipe from `arc-wall-placement.md`. Do NOT use `asset3dGenerationTool` for barriers — it's slow and the voxel look is correct.

## Track pieces are ALWAYS voxel — CRITICAL

(Hosted Creator agent. In a GDK project the circuit is forged — see "When to use" — and only the
trackside pieces below follow this rule.)

Every track piece in the palette below — barriers, walls, gates, arches, banners, bridges, marshal
posts, checkpoints, bollards, cones, grandstands, garages, signs — is built with
`voxelAssetCreationTool`, NEVER `asset3dGenerationTool` (GLB) and NEVER a World-Forger
(`runWorldForger`) rebuild. They are simple blocky shapes; the voxel look is correct and instant. A circuit has many
such pieces, so generating a bespoke 30–180s GLB for each one blows the entire time budget before
the game is wired — the single most common cause of a kart/race build timing out. If the manifest
arrived with a `glb` or `level` entry for track geometry, treat it as voxel here and note the
correction in your final report.

## Asset palette suggestions

- `jersey_wall` — concrete K-rail, ~4m × 2m × 1m, asymmetric (painted side faces the track)
- `tire_barrier` — stack of tires, 1m × 1m × 1m, symmetric (rotation doesn't matter)
- `start_finish_arch` — overhead structure spanning the track, landmark
- `pit_garage` — long flat-roofed building for pit_lane region
- `grandstand` — seating bank, for spectator_zone
- `flag_pole` / `cone` / `light_pole` — point-snap props
- `palm_tree` / `billboard` — inner_island decoration

## Density / placement

- **Track surface width: default 12m (halfWidth = 6) for car races.** Cars are 2.3m wide — anything narrower than ~12m won't fit 4 cars side-by-side and AI karts constantly bump the inside wall on overtakes. For kart/derby tracks, 6-8m is acceptable when the prompt specifically asks for a tight track. See `@docs mechanic-racing.md` "Track width — minimum to fit N cars" for the full table.
- Wall segments: 4-meter pieces with 2% overlap (per `arc-wall-placement.md`'s recipe).
- Inner island: 1-2 large decorations (palm cluster, billboard) per loop. Don't fill — it should look like a designated infield, not a forest.
- Pit lane: 4-6 garages along ~30m straight.

## Common gotchas

- **Figure-8 trap:** inner-island and outer-envelope walls need OPPOSITE rotation directions. Read `@docs arc-wall-placement.md` thoroughly before writing the placement loop.
- **Tangent-spawn trap (cars):** the SAME bug class hits the start grid. Each kart's spawn rotation must be the tangent of the loop AT ITS OWN POSITION — a single shared `Math.PI`-style yaw lands every kart 90° sideways across the track at every grid slot except one. Use `spawner.layoutGridOnLoop(...)` from `@docs vehicle-system.md`. See `@docs mechanic-racing.md` for the full spawn snippet.
- **Tangent-perpendicular trap (start arch / finish line):** drive-through structures (start arch, finish gate) must be rotated PERPENDICULAR to the racing tangent — long axis crosses the racing line so cars drive *under* the bar. A hand-picked `0` or `Math.PI/2` works at exactly the four cardinal points of the loop and is 90° off everywhere else, leaving the arch lying along the track instead of across it. Compute as `headingTangent(loopCenter, archPos, 'ccw') + Math.PI/2`; recipe in `@docs mechanic-racing.md` "Start arch / finish line — rotation must be PERPENDICULAR to the racing tangent".
- **Declare painted-track rings in `worldProfileData.tracks`** matching the loop geometry the WorldGenerator paints. `validate-world-json` then catches every wall/decoration that landed on the racing surface (boost-pad typos, inner-island walls placed at the inner asphalt edge, figure-8 crossover walls blocking the other loop). Schema and `onTrackOk` opt-out documented in `@docs mechanic-racing.md`.
- **Spawn slots stacked behind the start line land off the asphalt.** A grid placed by extending z (or x) in a straight line away from the start point will drop the back rows onto raw terrain south of the loop, not the ring. `layoutGridOnLoop` lays slots BACK ALONG THE LOOP itself; if hand-rolling, every slot must be within `[INNER_R, OUTER_R]` of the loop center. `spawnVehicle` places the car at EXACTLY the requested X/Z (only ground height is resolved) — nothing snaps a bad slot back onto the ring, so an off-ring slot silently lands on raw terrain.
- **Cars need flat ground.** Always set `terrain.shape: 'flat'`.
- **Don't put trees / rocks / random decor ON the track.** `biome-scatter` urban-suppression handles this if you set the track surface to `asphalt`. Check the visual — if there are trees on the track, density rules need adjusting.
- **Start line / finish line uses trigger volumes** from the engine's `mechanic-racing.md`. The asset (`start_finish_arch`) is just visual — gameplay is in `mechanics-plan.md`.
- **Cars are vehicles** — use `mechanic-racing.md` (lap-based) or `mechanic-driving.md` (sandbox/free-roam) patterns, not just decorations.
- **Install the racing defaults.** Lap-based races MUST call `installRacingDefaults(...)` from `engine/Vehicle.js` (locks the player into the kart — no "Exit vehicle" prompt — frees the mouse cursor, and wires the auto-right/unstuck safety systems). The coding completion gate rejects racing code without it; see `@docs mechanic-racing.md`.

## Hybrid combinations

- **Racing in a city** → load also `@docs archetype-city.md`. Track winds through city streets; outer_envelope walls at intersections. Buildings define the track shape rather than open-ground arcs.
- **Off-road forest rally** → load also `@docs archetype-wilderness.md`. Use `dirt` ground; track surface PAINTED through procedural-hill terrain via `voxel-terrain-foliage.md`. Walls become tree-line and rocks rather than jersey barriers.

## Skeleton plan (reference only — do NOT write to disk; use as inline planning structure)

```markdown
# World plan — <game name>

## Theme
Figure-8 demolition derby track. Two loops crossing in the middle. Asphalt surface, concrete jersey barriers, four palm trees in each inner island, grandstands on the outer perimeter. Player drives third-person.

## Regions
- **track_surface** — figure-8 shape, two 30m-radius loops centered at (-40, 0) and (+40, 0). Track width 10m. Painted asphalt over the whole world ground.
- **inner_island_left** — center (-40, 0), radius ~20m, sparse. 4 palm trees + 1 billboard. Walls along the radius=22m circle (32 segments).
- **inner_island_right** — mirror at (+40, 0).
- **outer_envelope** — outer boundary walls along radius=38m of each loop, with the figure-8 crossover gap (skip walls in the angle range where loops meet).
- **spectator_zone** — perimeter (north and south straights), 2 grandstand assets each side, ~50m apart.

## Asset palette per region
- track_surface: (none — terrain painting only)
- inner_island_*: `jersey_wall` (segments along radius=22m), `palm_tree`, `billboard`
- outer_envelope: `jersey_wall` (segments along radius=38m, with crossover gap)
- spectator_zone: `grandstand`, `light_pole`, `flag_pole`

## Landmarks
- **start_finish_arch** — at (0, -40), spanning the southern straight, asset `start_finish_arch`.

## Layout sketch
```
                  GRANDSTAND
              ____________________
             /                    \
            /  inner_left          \
   START → o----X----o   ← finish (figure-8 crossover at center)
            \  inner_right         /
             \____________________/
                  GRANDSTAND
```
**See `@docs arc-wall-placement.md` for wall rotation per arc — inner-island walls and outer-envelope walls use opposite rotation formulas. Skipping this read = walls 180° off on half the track.**
```
