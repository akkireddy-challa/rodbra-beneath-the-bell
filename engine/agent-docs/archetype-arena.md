# Archetype: arena

## When to use

Prompts mentioning: arena, colosseum, battle royale, gladiator, fighting pit, boss arena, dome, multiplayer arena, deathmatch map. Often paired with `@docs mechanic-combat.md` for the actual gameplay loop.

## Arena centre

Every position in this archetype — combat floor, walls, spawn rings, the shrinking-zone centre — is relative to the **arena centre, `engine.getWorldCenter()`**. On a procedural flat arena that resolves to `(0, 0)`; on a **forged/baked level (`voxelUrl` set) it is the level centre, and `(0, 0)` is the corner**. Anchor BOTH the asset placement and the gameplay code (enemy/gladiator spawns, shrinking zone, weapon pickups) to `engine.getWorldCenter()` so they line up with the arena on either world type. See `@docs coordinate-system.md`.

## Terrain config

An arena authored as one GLB (a Blender-built stadium, a station deck) skips the terrain config
entirely: `terrain: { shape: 'none' }` plus a `MeshLevel` (`mesh-level.md`).

```json
"terrain": { "shape": "flat", "groundBlockType": "sand" }
```

Almost always flat. Sand for gladiator/colosseum aesthetic; `'stone'` for stone arena; `'asphalt'` for modern combat sport; `'grass'` for outdoor LARP-style.

`cameraMode` typically `top-down` (overview), `third-person` (action), or `first-person` (FPS arena). Battle-royale prompts often want a large open `top-down` or `third-person` view.

## Default region structure (3 concentric rings)

| Region | Position | Radius | Character |
|---|---|---|---|
| `combat_floor` | arena centre (`engine.getWorldCenter()`) | varies (10-30m) | The fighting space. Open. Sand/stone/asphalt floor. Maybe 1-2 props (pillar, brazier) for cover but mostly open. |
| `walls` | ring at perimeter of combat_floor | wall thickness ~1m | Tall wall keeping combatants in. Often with battlements or stands above. Use `arc-wall-placement.md` for circular arenas. |
| `spectator_zone` | ring outside walls | 5-15m | Stands, banners, torches/lanterns. Decorative — gameplay doesn't reach here. |

For battle-royale-scale, scale up: combat_floor radius 50-100m, walls become a perimeter fence, spectator_zone may not exist.

## Asset palette suggestions

Build with `voxelAssetCreationTool` by default. Use `asset3dGenerationTool` ONLY for the 1-2 hero buildings here (`royal_box`, `entrance_gate`) — and only if the user wants a detailed look. Walls, pillars, braziers, flagpoles, grandstands are all simple geometry — voxel boxes are correct and fast.

- `arena_wall` — tall stone/wood wall segment with battlements on top, asymmetric (battlements face combat floor) — `voxelAssetCreationTool`
- `arena_pillar` — vertical stone column, point-snap, cover prop — `voxelAssetCreationTool`
- `arena_brazier` — fire bowl on a stand, point-snap, atmospheric — `voxelAssetCreationTool`
- `grandstand` — sloped seating bank — `voxelAssetCreationTool`
- `royal_box` — a special spectator structure on one side (for kings/announcers) — building, `asset3dGenerationTool` OK
- `flag_pole` — tall thin, point-snap — `voxelAssetCreationTool`
- `entrance_gate` — large arch, replaces 1 wall segment — building, `asset3dGenerationTool` OK
- `enemy_spawner` (invisible, gameplay) — for combat plan

For boss arena: 1-2 large pillars + 1 boss spawner at center. Otherwise keep the floor open.

## Wall placement — CRITICAL

For circular arenas, walls are the **outer envelope** case from `@docs arc-wall-placement.md` (track / combat is INSIDE the wall, so wall fronts face INWARD = `R = -π/2 - t`). Read the doc before placing arena walls — single rotation formula error puts the battlement-side facing the wrong way around the entire arena.

For square/rectangular arenas the SAME outer-envelope rule applies — fronts face INWARD, so `R = atan2(front.x, front.z)` with `front` pointing at the centre: north wall (the `+Z` side) `rotY = Math.PI`, east (`+X`) `-Math.PI / 2`, south (`-Z`) `0`, west (`-X`) `Math.PI / 2`.

> Do NOT copy the per-side values from `@docs archetype-castle.md`. A castle's battlements face OUTWARD (inner-island case, `R = π/2 - t`), so its four values are these ones plus π. Same walls, opposite facing — mixing them up points every arena wall's front at the spectators instead of the fighters.

## Density / count

- Combat floor: **0-3 props** (pillars for cover, brazier centerpiece). MORE is wrong — combatants need open space.
- Walls: 16-32 segments around the perimeter (depending on radius and segment length).
- Spectator zone: 4-8 grandstand segments + 4 flag poles + 1 royal_box on the "good" side.
- Battle royale variant: NO spectator zone, just perimeter fence + scattered loot/cover props inside.

## Common gotchas

- **Don't fill the combat floor with props.** It's an arena — fighters need room. 0-3 cover pieces max.
- **Walls' battlement side faces INWARD** (toward combat). Use `arc-wall-placement.md` outer-envelope formula `R = -π/2 - t`. Don't flip this — battlements facing outward looks like a fortress, not an arena.
- **Pick ONE entrance.** Multiple gates dilute the "trapped" feeling. One entrance_gate facing the spectator side.
- **Boss arena ≠ small arena.** Boss arenas often have 1-2 strategic pillars + a clear boss-marker; battle royale arenas are large with dispersed cover.
- **Don't generate "arena buildings"** (apartment blocks, shops). Arenas are ENCLOSED FIGHTING SPACES, not built environments. Keep aesthetic minimal and ceremonial.
- **End the match via `engine.endGame()`**, not a custom modal or `hud.showToast`. When the player dies (lose), the last enemy falls (win), or the zone collapses fully (battle-royale lose) — call `this.engine.endGame({ outcome: 'win'|'lose', title: '...' })`. The engine handles the themed overlay, Replay button, and PokiSDK reporting. See `@docs end-game.md`.

## Hybrid combinations

- **Castle with arena courtyard** → load also `@docs archetype-castle.md`. Arena replaces the castle's `inner_courtyard` region.
- **Battle royale on a wilderness map** → load also `@docs archetype-wilderness.md`. The "arena" is a large bounded outdoor area; perimeter is implicit (the play-area shrink mechanic from `mechanic-combat.md`'s battle-royale variant). Scatter cover (rocks, ruined walls) across it.
- **Boss arena in a dungeon** → load also `@docs archetype-dungeon.md` and forge the whole thing as one interior level: say in the prompt that it ends in a great boss chamber, and the generator sizes and places it. Do not hand-build the arena and bolt a dungeon onto it. Combat is delegated to the mechanics plan.

## Skeleton plan (reference only — do NOT write to disk; use as inline planning structure)

```markdown
# World plan — <game name>

## Theme
Roman-style colosseum. Sand combat floor 30m across, ringed by tall stone walls with battlements, surrounded by sloped wooden grandstands. Single entrance gate on the south. Player fights third-person.

## Regions
- **combat_floor** — center (0, 0), radius 15m, sand. 2 stone pillars at (-8, 0) and (+8, 0) for cover. Empty otherwise.
- **walls** — circle at radius 15m, 32 wall segments via `arc-wall-placement.md` (outer-envelope: front faces INWARD, `R = -π/2 - t`). Replace 1 segment at (0, +15) (south side) with `entrance_gate`.
- **spectator_zone** — ring 17m to 25m, 8 grandstand segments evenly spaced + 1 royal_box at (0, -22) (north side, "the king's view") + 4 flag poles at compass points.

## Asset palette per region
- combat_floor: `arena_pillar` (2)
- walls: `arena_wall` (32 segments, with arc-wall-placement.md recipe), `entrance_gate` (1)
- spectator_zone: `grandstand` (8), `royal_box` (1), `flag_pole` (4)

## Landmarks
- **entrance_gate** — at (0, 15), south side, asset `entrance_gate`. Player's spawn-and-enter location.
- **royal_box** — at (0, -22), north side, asset `royal_box`. The visual focal point for the spectator side.

## Layout sketch
```
                  ROYAL BOX
              ────────────────
             ___grandstand___
        ┌───/                \───┐
        │  /   walls (32)    \   │
        │ │                   │  │
        │ │      [pillar]     │  │
        │ │   COMBAT FLOOR    │  │
        │ │      [pillar]     │  │
        │ │                   │  │
        │  \                 /   │
        └───\___grandstand_/────┘
              ────────────────
                  GATE (entrance)
```
**See `@docs arc-wall-placement.md` BEFORE placing walls — circular arena uses outer-envelope formula `R = -π/2 - t`.**
```
