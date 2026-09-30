# Mechanic: tower-defense

## When to use

Prompts mentioning: tower defense, TD, wave defense, defend the base, lane defense, attack the castle. The gameplay loop is "place towers along enemy paths to stop waves before they reach your base."

## Camera / perspective — strategy view, no walking player

Tower defense is a STRATEGY genre. The default is a fixed top-down view of the whole map with **no embodied player character**:

- `worldProfileData.cameraMode: 'top-down'` with `topDownFitWorld: true` (asset subagent, see `@docs topdown-fit-camera.md`) — the player sees the entire path and every tower spot at once.
- **Disable scene fog** in the same edit: `"fogConfig": { "enabled": false }`. The fit camera hovers ~200m up, so any distance fog reads as a full-screen haze over the whole map (see "Fog" in `@docs topdown-fit-camera.md`).
- **Size the map for enemy readability.** Enemies are fixed-size (1.3–1.84m; NPCs cannot be scaled up), so keep the fitted span ≤ ~120m — ground sized to the path + base, or fit the play rect programmatically. On a 200m+ ground, marching skeletons are single pixels and the genre's watch-the-wave appeal dies.
- Placement is cursor/tap-driven (click a spot, pick a tower), not walk-up-and-interact.
- Flat or gently-shaped terrain that reads clearly from above; do NOT forge dramatic 3D elevation the top-down view can't show.
- First-person prompt phrasing ("I defend my castle", "I place cannons") does NOT mean an embodied player — that's just how users describe any game.

Build an embodied third-person hybrid ONLY when the prompt explicitly asks to fight alongside the towers ("I run around and shoot too", "play as a hero defending with the towers"). That variant is the exception and costs the genre's signature readability — never drift into it by default.

## Core systems

| System | What it does |
|---|---|
| Enemy paths | Pre-defined chain of waypoints from spawn → base. Visualized as roads/paths in world. |
| Towers | Player-placed defensive structures. Each has range, damage, fire rate, target priority. |
| Currency / economy | Player earns currency per enemy defeated; spends on tower placement / upgrades. |
| Waves | Pre-scripted enemy spawn sequences. Each wave has count + types + delay between. |
| Base HP | Health pool that decreases when enemies reach the end. Loss = base HP reaches 0. |
| Tower placement UI | Click-to-place mode with cost preview + grid snapping |
| Tower upgrade UI | Click an existing tower to upgrade (more damage, range, etc.) at increasing cost |

## Win / lose conditions

| Variant | Win | Lose |
|---|---|---|
| Standard (default) | Survive all N waves; base HP > 0 | Base HP reaches 0 |
| Endless | Survive as long as possible (score = wave reached) | Base HP reaches 0 |

Default to **standard, 15 waves, 20 base HP**, balanced so the player loses some HP but can recover with good play.

## HUD plan

Required (cross-ref `@docs HUD_ELEMENTS.md`):

- **Base HP bar** — top-center: `Base 18 / 20`
- **Wave counter** — top-left: `Wave 3 / 15`
- **Currency** — top-right: `$425`
- **Tower picker** — bottom panel: 3-5 tower types with cost; clicking enters placement mode
- **Tower upgrade panel** — appears when a placed tower is selected; shows current stats + upgrade cost
- **Wave preview** — bottom-left or in-wave-button: "Next: 5 archers + 1 ogre"
- **Speed control** — top-right corner: 1x / 2x / 4x speed buttons (TD games benefit hugely from time control)

## Cross-reference to world-plan.md

- **Enemy paths** — explicit waypoint chains from spawn points to base. Mark in `world-plan.md` as multi-segment landmarks with `path_*` ids.
- **Spawn points** — at the start of each path; visually marked (portal, dungeon entrance, road end).
- **Base** — the structure enemies are trying to reach. Often a castle/keep landmark — load `@docs archetype-castle.md` and use the `keep` as the base.
- **Tower placement zones** — where the player is allowed to place towers. Highlight via terrain painting or hotspot regions. Don't allow placement on the path itself.

## Common gotchas

- **Path ≠ road texture.** The path is a logical waypoint chain that enemies follow. Visualize it with a road material (asphalt or dirt strip) painted via `voxel-terrain-foliage.md`, but keep the LOGIC separate.
- **Don't make the path too short.** Player needs distance to place towers and let them fire. ~80-120m total path length is a reasonable minimum.
- **Multi-path TD** is harder to balance. For first iteration, ONE path. Add branching paths only if explicitly requested.
- **Tower placement grid** — snap to whole-meter grid so towers visually align. Engineer-built game feel.
- **Wave pacing matters.** Wave 1: 5 weak. Wave 5: 12 medium. Wave 10: 8 medium + 1 boss. Wave 15: 1 huge boss. Without escalation, the game's a checkbox.
- **Don't forget the BUILD/PREP phase.** Most TD games have a 30-second window between waves where the player buys/upgrades towers. Without it, the game's pure reaction.
- **Currency must equal expense + small surplus.** Per wave, player earns ~80% of tower-cost-needed-for-next-wave, forcing strategic choices. Too much = no challenge; too little = unwinnable.

## Asset references

- Path materials: `voxel-terrain-foliage.md` for ground painting
- Tower assets: `tower_archer`, `tower_cannon`, `tower_magic`, `tower_freeze` — generated via `asset3dGenerationTool`
- Enemy assets: NPC system per `@docs npc-system.md`
- Base asset: typically a castle keep — see `archetype-castle.md`

## Skeleton plan — copy-paste into `mechanics-plan.md`

```markdown
# Mechanics plan — <game name>

## Genre / archetype
Tower defense. Player builds towers along a single winding path; enemies spawn at one end, march toward the base. Standard 15-wave format with currency-based tower buying and upgrading.

## Camera
Fixed top-down strategy view: `cameraMode: 'top-down'` + `topDownFitWorld: true` + `fogConfig: { enabled: false }` (`@docs topdown-fit-camera.md`). No player character. Fitted span ≤ ~120m so enemies stay readable.

## Core systems
- Enemy path — single chain of 30 waypoints from spawn → base, painted as dirt road
- 4 tower types: `tower_archer` (cheap, fast), `tower_cannon` (slow, AoE), `tower_freeze` (slows enemies), `tower_magic` (chain damage)
- Currency: start $200; +$5 per kill; tower costs $50/$100/$80/$150
- 15 waves, escalating count + types; 30-second prep between waves
- Base HP 20; -1 per enemy reaching the base; lose at 0
- Time control: 1x / 2x / 4x speed buttons

## Win / lose conditions
- Win: survive all 15 waves (final wave = 1 boss with 500 HP + 5 minions)
- Lose: base HP reaches 0

## HUD plan (`@docs HUD_ELEMENTS.md`)
- Top-center: Base HP bar `18 / 20`
- Top-left: `Wave 3 / 15`
- Top-right: `$425` + speed buttons
- Bottom panel: 4-tower picker with cost; click to enter placement mode
- Tower-upgrade modal: appears on placed-tower click
- "Game over" + "You won" overlays with restart button

## Cross-reference to world-plan.md
- Path: 30 waypoints from (-50, 0) (spawn portal landmark) winding through the world to (50, 0) (base/keep landmark). Path painted as dirt strip.
- Tower placement zones: 3m off the path, restricted to grass biome cells (no placement on water / cliffs / inside the path)
- Spawn point: `enemy_portal` at (-50, 0). Spawns 1 enemy per second during a wave.
- Base: `archetype-castle.md` keep landmark at (50, 0). Visually highlights HP via flag color (green > 50%, yellow > 25%, red < 25%).
```
