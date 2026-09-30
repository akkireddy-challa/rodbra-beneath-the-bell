# Mechanic: combat

## When to use

Prompts mentioning: combat, fight, battle, arena, royale, deathmatch, gladiator, FPS combat, melee, brawler, boss fight. The gameplay loop is "defeat enemies / survive against opposition."

For the WORLD layout (arena, dungeon, ruined city, etc.), ALSO load the matching world archetype (`archetype-arena.md`, `archetype-dungeon.md`, etc.). Anything indoor and room-and-corridor is a FORGED level — read the fork at the top of `archetype-dungeon.md` before planning to paint rooms.

## Camera / perspective

`cameraMode: 'third-person'` with an embodied fighter is the default — melee reads best when the player sees their own character swing. First-person ONLY when the prompt says so ("first-person", "FPS-style melee", "Doom-like"); top-down for an explicit see-the-whole-arena ask. The camera choice decides the melee system — `WeaponMeleeSystem` (third-person/top-down, needs the visible animated character) vs `FirstPersonMeleeSystem` (first-person view-model) — a mismatch fails silently; see the gotcha below.

## Core systems

| System | Engine doc / handle | What it does |
|---|---|---|
| Player health | `@docs combat-system.md` | HP value, damage events, death state, optional regeneration |
| Weapons | `WeaponPickup` + `WeaponMeleeSystem` (third-person/top-down) or `FirstPersonMeleeSystem` (first-person) | Sword/club/etc. melee; ranged via projectile system |
| Enemies | `@docs npc-system.md` + `@docs npc-combat-death.md` | NPCs with `IDamageable` interface; AI via `enemy_spawner` markers |
| Damage system | engine | Player → enemy and enemy → player; damage values per weapon |
| Spawning / waves | engine triggers + spawners | Enemies appear at spawn points; waves trigger on player entry to a region |
| Score / kill count | HUD element | Counts defeated enemies |
| Win/lose conditions | gameplay state | Survival timer, last-standing, kill quota, boss defeat |

## Variants

Pick ONE based on the prompt:

| Variant | Triggers | Win | Lose |
|---|---|---|---|
| **Wave survival** (default) | "survival", "horde", "waves" | Survive N waves | HP reaches 0 |
| **Last-standing** | "battle royale", "last man" | Be the last alive | Defeated |
| **Score-attack** | "kill count", "deathmatch" | First to N kills (or kill leader after timer) | Timer expires below leader |
| **Boss fight** | "boss", "raid" | Defeat boss | HP reaches 0 / time expires |
| **Arena tournament** | "tournament", "rounds" | Win N consecutive rounds | Lose any round |

## Win / lose conditions

Be EXPLICIT in `mechanics-plan.md`. Default if prompt is vague: **wave survival, 10 waves, 100 player HP**.

**Always end the session via `engine.endGame()`** — never hand-roll a "You Died" / "Victory" overlay or use `hud.showToast` for game-over. The engine renders a themed modal, freezes the simulation, fires PokiSDK `gameplayStop()`, and provides a Replay button — all in one call:

```ts
this.engine.endGame({ outcome: 'lose', title: 'You Died' });
this.engine.endGame({ outcome: 'win',  title: 'Victory!', stats: [{label: 'Kills', value: 18}] });
```

See `@docs end-game.md` for the full options shape.

## HUD plan

Required (cross-ref `@docs HUD_ELEMENTS.md`):

- **Player HP bar** — top-left or bottom-center
- **Wave counter** (wave variant) or **kill count** (score variant) or **boss HP bar** (boss variant)
- **Score** — top-right
- **Ammo counter** (ranged) — engine-owned: `RangedWeaponSystem` auto-creates it bottom-right when reload is enabled. Do NOT create your own ammo counter (duplicates). Weapon name, if wanted, goes in a pickup/switch toast.
- **Optional:** mini-map with enemy dots

## Cross-reference to world-plan.md

- **Spawn points** for player and enemies. Player typically at one end of `combat_floor` or at `entrance_room`. Enemies spawn at `enemy_spawner` markers (specified in world-plan landmarks). Compute enemy spawn positions (rings, cardinal points, boss centre) relative to **`engine.getWorldCenter()`**, never a hardcoded `(0, 0)` — on a baked (`voxelUrl`) level `(0, 0)` is the corner, so the whole fight ends up off in a corner away from the arena and the player. See `@docs coordinate-system.md`.
- **Wave trigger volumes** — entering a region or reaching low HP triggers next wave. Mark in world-plan as `wave_trigger_*`.
- **Boss arena** (boss variant) — large `combat_floor` region with the boss spawner at center.
- **Loot drops** (battle royale / RPG-lite variants) — distribute pickups around the world's open areas.
- **Cover** — pillars / debris from `archetype-ruins.md` or `archetype-arena.md` provide tactical cover.

## Common gotchas

- **Pick the melee system by camera mode — mismatches fail silently.** `WeaponMeleeSystem` is animation-driven: it needs a VISIBLE animated character (third-person / top-down). In first-person the character (and the hand-attached sword) is hidden, and with `hasPlayerCharacter: false` (the standard first-person setup) there is no animation controller at all — every attack input is ignored. For first-person melee use the engine's `FirstPersonMeleeSystem`: a camera-attached view-model sword with procedural swings that needs no skeleton, wired the same way (`playerController.setAttackSystem(...)`, handles click / Enter / mobile action). Same enemies, same `IDamageable` damage path.
- **Don't hardcode enemies as VXL assets.** Enemies are NPCs (use `npc-system.md`). Their assets matter visually but the AI/HP/damage logic comes from the NPC system.
- **`WeaponMeleeSystem` only damages `IDamageable` entities, NOT voxel blocks.** If the prompt says "axe to chop trees", that's `voxel-mining.md` (PlayerToolSystem), NOT a combat weapon. Read carefully.
- **Wave pacing matters.** Wave 1: 2-3 weak enemies. Wave 5: 6-8 medium. Wave 10: 1 boss + minions. Without escalation, "survive 10 waves" is boring.
- **Player respawn** for last-standing variants is OFF by default. Battle royale = death is permanent. Arena tournaments = respawn between rounds.
- **Don't forget the GAME-OVER state.** `Game.ts` needs explicit handling for "player died" — display a "You Died" screen, allow restart. Without this, the game stalls on player death.
- **Combat visuals start with the effect catalog.** Explosions, branching/chain lightning, beams, sparks and elemental effects use `getVisualEffects(engine)`; read `visual-effects.md`. For an adapted recipe, layered ability or new custom effect, read `visual-effect-authoring.md`. Damage remains separate.
- **Boss fight needs telegraphs.** Bosses without warning attacks feel unfair. Use the telegraph + ground-effect primitives in `game/src/engine/effects/TelegraphVFX.ts` (`CircleTelegraph`, `ConeTelegraph`, `LineTelegraph`, `GroundZone`) if this is a boss prompt.

## Asset references

- Player weapons: see `WeaponPickup` system. Built-in IDs such as `sword`, `axe`,
  and `pistol` select block art; `sword_lowpoly`, `axe_lowpoly`, and
  `pistol_lowpoly` select faceted art. See `@docs weapon-visuals.md`.
- Enemy assets: NPC system handles spawning; provide `enemy_skeleton`, `enemy_zombie`, `enemy_bandit` etc.

## Skeleton plan — copy-paste into `mechanics-plan.md`

```markdown
# Mechanics plan — <game name>

## Genre / archetype
Wave-survival arena combat. Player vs. waves of skeleton enemies in a colosseum. Melee-only with a sword. Score-attack run for kill count.

## Core systems
- Player health (`@docs combat-system.md`) — 100 HP, no regen, dies on 0
- Player weapon — `weapon_sword` melee, 25 damage per hit
- Enemies (`@docs npc-system.md`) — `enemy_skeleton`, 30 HP, 10 damage melee, simple chase AI
- Wave system — 10 waves, escalating count + difficulty
- Score = total enemies defeated; persists across waves

## Win / lose conditions
- Win: survive all 10 waves (final wave is a boss skeleton with 200 HP)
- Lose: HP reaches 0

## HUD plan (`@docs HUD_ELEMENTS.md`)
- Bottom-center: HP bar (100 → 0)
- Top-center: `Wave 3 / 10`
- Top-right: `Kills: 18`
- Bottom-right: active weapon icon (`weapon_sword`)
- On HP=0: call `engine.endGame({ outcome: 'lose', title: 'You Died' })` — engine renders the modal and Replay button (`@docs end-game.md`).

## Cross-reference to world-plan.md
- Player spawn at the entrance_gate landmark from `archetype-arena.md`
- Enemy spawners at 4 cardinal points along the wall (north, east, south, west, just inside `combat_floor`)
- Wave 1 spawns 2 skeletons; wave N spawns N+1; wave 10 = 1 boss
- Wave trigger: previous wave's enemies all defeated → 5-second pause → next wave
- Boss spawner at the arena centre (`engine.getWorldCenter()`); only used on wave 10
```
