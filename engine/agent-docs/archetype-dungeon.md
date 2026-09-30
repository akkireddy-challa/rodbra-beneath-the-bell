# Archetype: dungeon

## When to use

Prompts mentioning: dungeon, crypt, catacombs, cave system, mine, tunnels, underground, labyrinth, vault. Distinct from other archetypes — **indoor**, room-and-corridor structure, NOT biome-driven, NOT scattered with foliage.

## FIRST: which of the two paths is this?

**A whole interior — the level IS the dungeon.** Use the World-Forger. Call `runWorldForger` with a high-level prompt naming the place and the kind of game; the director routes interior prompts on its own, so omit `dungeonMode` unless the concept does not read as an interior and the user asked for one anyway. **Do NOT hand-build it from voxel-painted rooms.** The forger is the only thing that builds real roofed interiors, and one call gives you:

- rooms and corridors embedded in 3D across several floors, with stairs between them
- swinging, sliding and dissolving doors, locked doors and the key pickups that open them
- carved stone walls, floors and ceilings — a per-theme masonry kit, so a crypt reads as mortared granite and an alien hive as faceted crystal
- a multi-layer navmesh, so NPCs path between floors
- torches, braziers or emissive crystals placed by the design, plus the dark atmosphere config
- enemy and player spawn points, and a validated key-before-lock progression

Everything below this section is for the OTHER path.

**A hand-designed interior authored in Blender** — one GLB plus a collider JSON — is a third path:
`MeshLevel` (`mesh-level.md`). The GDK's `building-levels-in-blender` skill covers the authoring side.

**A room or two inside a level that already exists** — a basement under a city shop, a bunker in a field, one vault at the end of an outdoor ruin. A whole level rebuild is overkill there. Hand-author it with the voxel painting and prop guidance below.

## Feature walls in a forged dungeon

The forged path supports an accent wall: one wall of a chosen room clad in a material of its own — the gold wall behind the treasure, the black basalt behind the boss. Ask for it in the prompt in plain language ("its reliquary's far wall is a sheet of beaten gold"). The designer picks which rooms get one and in which style, and the generator picks which wall. Most rooms should not have one; it reads as a feature only while it stays rare.

## Terrain config

```json
"terrain": { "shape": "flat", "groundBlockType": "stone" }
```

Always flat. The dungeon "floor" is the world ground; walls/ceilings are voxel-painted on top. `cameraMode` typically `top-down` (dungeon-crawler view) or `third-person` (immersive 3D dungeon). `first-person` works for spelunking/horror — for first-person MELEE combat use `FirstPersonMeleeSystem` (see `@docs mechanic-combat.md` gotchas; `WeaponMeleeSystem` silently cannot work there).

For a "cave" feel, use `groundBlockType: 'stone'` or `'dirt'`. For a "crypt", use `'marble'`. For a "mine", use `'wood'` or `'dirt'` with stone walls.

## Default region structure (room-based, NOT density-driven)

Dungeon design is **rooms + corridors connecting them**, not biome density. Replace the standard region structure with **named rooms**:

| Element | Description |
|---|---|
| `entrance_room` | Where the player spawns. Often larger, has a clear "facing forward" direction. |
| `corridor_*` | Narrow passages connecting rooms. ~3m wide, walls/ceilings on both sides. |
| `room_<theme>` | Themed chamber: `room_treasure`, `room_boss`, `room_puzzle`, `room_trap`. Larger than corridors. |
| `dead_end` | Optional. Adds illusion of choice without functional branching. |

A small dungeon has 4-6 rooms; a larger one 10-15. Use a graph in the plan's "Layout sketch" section.

## Walls / floors / ceilings

These are NOT environmentObjects — they're VOXEL BLOCKS. For rectangular rooms, use `building` hotspots (`worldProfileData.hotspots[]`, asset side): each paints a hollow shell with guaranteed doorway openings and an optional roof — chain them door-to-door for room + corridor layouts, no TS needed. Blocks can also be painted via the voxel CLI (`node bin/voxel.mjs place ... --force-position`; see `@docs voxel-cli.md`) or `WorldGenerator` `setTerrainBlock` calls in template TS code.

Only for genuinely non-rectangular shapes (curved caverns, irregular caves) write a template TS helper that paints walls block-by-block. The agent should read `@docs voxel-terrain-foliage.md` for block-level painting techniques.

**Ceilings are fully supported — build ROOFED rooms.** Spawning is interior-aware: the player's configured spawn Y is preserved verbatim (PlayerLoader snaps onto the interior floor), and NPCs spawn inside rooms via `handle.spawn(x, z, y)` with `y` at the room's walk height (floor + ~1m) — without the `y`, the NPC lands on the ROOF, because the default spawn resolves the topmost surface. Wall columns are auto-rejected (no headroom) and the spawn drifts to a nearby floor tile.

## Darkness & lighting

A dungeon must actually be DARK — by default the engine keeps full daylight (sun + bright sky ambient) no matter what the walls look like. Three pieces, all data-driven:

1. **Kill the daylight:** `configure_game(configType="lighting", sunIntensity=0.05, environmentIntensity=0.08, skyboxIntensity=0.1, ambientFloor=0.5)`. The intensities are multipliers (1 = daylight). `ambientFloor` is different — an absolute minimum light on every surface, independent of the sky, so geometry beyond every torch's reach reads as dark-but-navigable instead of pure black. When a dungeon is reported TOO DARK, raise `ambientFloor` (0.5 → 1.5); raising `environmentIntensity` does nothing underground, because it only scales light from a sky the player cannot see. Use 0 for true blackness.
2. **Light the rooms with emitting props:** give the torch/brazier asset a `light` block in world.json `assets[]` — e.g. `"light": { "color": "#ffa040", "intensity": 12, "distance": 10, "flicker": true }` — and every placed instance glows. Lights are pooled (nearest few are real); place torches freely every 6–10m. Positions refresh on reload.
3. **Optional close fog for dread:** `configure_game(configType="fog", color="#0a0a12", near=4, far=45)`.

A dark skybox image (night sky via skybox generation) completes the look when open sky is visible at the entrance.

## Asset palette suggestions

- `treasure_chest` — interactable, point-snap, often the goal
- `door` — rotatable barrier between rooms, point-snap
- `torch` / `wall_brazier` — point-snap on walls (specify Y for wall height)
- `pillar` — vertical column, point-snap (large rooms)
- `statue` — landmark inside a room
- `trap_pressure_plate` / `spike_trap` — gameplay props
- `enemy_spawner` — invisible marker for combat (delegated to `@docs npc-system.md`)

Don't generate "dungeon-themed buildings" — dungeons are made of walls + props, not buildings.

## Density / placement

Density isn't a useful concept for dungeons. Instead:

- **Room dimensions:** small (4×4m), medium (8×8m), large (12×12m, with pillars).
- **Corridor width:** 3m (one-character) or 5m (two-character abreast).
- **Wall thickness:** 1m (1 voxel at default `voxelBlockSize`).
- **Ceiling height:** 3m typical; 5m for grand chambers.
- **Props per room:** 0-5 small props (torch, statue), 1 themed centerpiece (treasure chest, boss spawner).
- **Keep doorways clear.** Corridors run through the doorway openings (for `building` hotspots, doors are centred on the wall — usually on the corridor centreline). A large collidable prop (sarcophagus, statue, pillar, rubble pile) placed on a doorway or the corridor centreline walls the player out of the next room — they can only jump it, which reads as broken. Place big props flush against a **side** wall, clear of the opening. Only when a prop is MEANT to seal a passage (a gate/portcullis the player must destroy or open) put it on the doorway and set `blocksDoorway: true` on the instance. `validate-world-json` warns on any large solid prop found on a doorway.

## Common gotchas

- **Hand-authoring a WHOLE dungeon is the wrong path.** If you find yourself chaining more than two or three rooms by hand, stop and forge the level instead — see the fork at the top. Doors that lock, keys, a navmesh that crosses floors and carved masonry all come free there and are a great deal of work here.
- **Hotspots fit poorly here.** The hotspot system (village/tower interpreters) is for organic outdoor regions. Don't use it for dungeons. Hand-author rooms via voxel painting + environmentObjects for props.
- **`biome-scatter` is irrelevant.** Don't scatter foliage in a dungeon.
- **`flattenTerrain` is irrelevant** (terrain is already flat). Use `placeOnTerrain: true` on chests, doors, statues.
- **`force_position: true`** is your friend — for wall-mounted props (torches, wall-decorations) you need exact Y coords, not engine-snapped Y.
- **Don't generate enemy NPC assets here** — load `@docs npc-system.md` and use the NPC system. The dungeon is the LEVEL; NPCs are the inhabitants and live in `mechanics-plan.md` cross-refs.
- **Interior NPC spawns need the Y argument.** Under a ceiling, `handle.spawn(x, z)` puts the NPC ON THE ROOF (top-down surface resolution). Always `handle.spawn(x, z, y)` with y ≈ floor + 1m for enemies inside roofed rooms.
- **Don't skip the lighting config.** Torch props alone can't darken a scene — without the "Darkness & lighting" steps above the dungeon stays in full daylight and reads as an open-air ruin, not a dungeon.

## Hybrid combinations

- **Castle dungeon** → forge the dungeon as its own level and register it in `worldProfileData.levels[]`; the castle above is a separate level. Load also `@docs archetype-castle.md` for the keep.
- **Mine with combat** → load also `@docs mechanic-combat.md`. Mine layout follows dungeon rules; enemies come from combat mechanics plan.
- **Dungeon crawler RPG** → load also `@docs mechanic-combat.md` plus the relevant NPC docs (`@docs npc-system.md` for quest-givers, `@docs collectible-objects.md` for treasure pickups). The dungeon is the PLACE; mechanics define the loop.

## Skeleton plan (reference only — do NOT write to disk; use as inline planning structure)

```markdown
# World plan — <game name>

## Theme
Small fantasy crypt with three connected rooms. Player explores top-down, finds a treasure chest, fights a skeleton boss. Stone walls, torchlit, rough flagstone floor.

## Regions (rooms)
- **entrance_room** — at (0, 0), 8m × 8m, ceiling 3m. Player spawn here, facing the corridor (toward +Z). Under the +Z gameplay forward convention this is `spawnRotation: 0` (see `@docs coordinate-system.md` §2). One door leading "north" (toward +Z in this doc's layout) into corridor_a.
- **corridor_a** — from (0, 8) to (0, 20), width 3m. Connects entrance to treasure room. Two torches halfway.
- **room_treasure** — at (0, 24), 10m × 10m. Treasure chest at center. Two pillars. Door leading east into corridor_b.
- **corridor_b** — from (5, 24) to (15, 24), width 3m.
- **room_boss** — at (20, 24), 12m × 12m, ceiling 5m. Skeleton boss spawner at center. Pillars at corners. Door back to corridor_a (one-way exit).

## Asset palette
- All rooms: `torch`, `pillar` (where noted)
- entrance_room: (none beyond walls + spawn marker)
- room_treasure: `treasure_chest` (1, at center), `pillar` (2)
- room_boss: `statue` (decorative, 2), `pillar` (4 at corners), `enemy_spawner_skeleton` (1, at center)

## Landmarks
- **boss_spawner** — at (20, 24), in room_boss, asset `enemy_spawner_skeleton`. Triggers wave when player enters the room.
- **chest_of_doom** — at (0, 24), in room_treasure, asset `treasure_chest`. Holds the level's reward.

## Layout sketch
```
                                     room_boss
                                  ┌──────────────┐
                                  │  P P  (statues) │
                                  │       *       │  * = boss spawner
                                  │  P P          │
                                  └────┬─────────┘
                                       │ corridor_b
                                       │
        room_treasure                  │
   ┌────────────────────┐              │
   │       │            │              │
   │   C  P  P          │              │
   │       *            │──────────────┘
   │                    │  corridor_b
   └────────┬───────────┘
            │ corridor_a (torches)
            │
        entrance_room
   ┌────────┴────────┐
   │                 │
   │      [PLAYER]   │
   │                 │
   └─────────────────┘
```
**Walls + floors are painted via template TS code (`setTerrainBlock` calls), NOT environmentObjects. See `@docs voxel-terrain-foliage.md` for the painting recipe.**
```
