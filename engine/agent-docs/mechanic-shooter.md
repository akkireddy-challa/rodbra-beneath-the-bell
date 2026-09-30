# Mechanic: shooter

## When to use

Prompts mentioning: shooter, shooting, FPS, top-down shooter, twin-stick shooter, hero shooter, doom-like, COD-like. The gameplay loop is "kill enemies with ranged weapons, manage ammo and health, complete the level."

For pure **melee combat without ranged weapons**, use `@docs mechanic-combat.md` instead.

## Camera / perspective

Camera mode is genre-defining and comes from the prompt — the Variants table below maps triggers to `cameraMode` and aim controls. "FPS"/"Doom-like" is unambiguously first-person; "top-down"/"twin-stick" is top-down with `useFreeMouse: true`; a bare "shooter" is ambiguous — default to top-down or third-person and ask if unclear. Never build an FPS when the prompt implies seeing the character (and vice versa).

## Core systems

| System | Engine doc / handle | What it does |
|---|---|---|
| Player health | `@docs combat-system.md` | HP, damage, regen options |
| Player weapons | `WeaponPickup` + projectile system | Ranged weapons with ammo. Multiple weapon types per game. |
| Aim controls | per camera mode (see Variants) | First-person mouse-look, top-down twin-stick (`@docs control-system.md`) |
| Enemies | `@docs npc-system.md` + `@docs npc-combat-death.md` | NPCs with HP + AI; can attack at range |
| Ammo / pickups | engine | Picked up from environment or dropped by enemies |
| Health pickups | engine | Healing items; or regen mechanic |
| Score / kill count | HUD element | Tracks defeated enemies |
| Win/lose | gameplay state | Survive level / clear all enemies / reach exit |

## Variants

Pick ONE based on the prompt:

| Variant | Triggers | Camera | Aim |
|---|---|---|---|
| **First-person shooter (FPS)** | "FPS", "Doom", "first-person", "Halo" | `cameraMode: 'first-person'` | mouse-look + crosshair, click to fire |

First-person weapons have their own systems — `FirstPersonWeaponSystem` for guns, `FirstPersonMeleeSystem` for melee. The third-person systems are not merely a worse fit there: their weapon is parented to the player body, which the engine hides in first person, so the weapon is invisible. See `@docs first-person-weapons.md`.
| **Third-person shooter** | "TPS", "third-person shooter", "Gears of War" | `cameraMode: 'third-person'` | over-shoulder camera; aim with mouse |
| **Top-down shooter** | "top-down shooter", "twin-stick", "Hotline Miami" | `cameraMode: 'top-down'` | shots fly toward mouse cursor; character faces movement, turns to cursor while firing (engine default) |
| **Side-scrolling shooter** | "Contra", "side-scroller shooter" | Voxel genre with `gameDimension: '2d'` (the sidescroller template fits best) — the side-on World-Forger generates the level; load `@docs sideon-forged-levels.md`. Do NOT switch the game to the Physics2D genre: it is unavailable in production and the forger refuses it | left/right walk, up/down aim, fire |

## Win / lose conditions

| Variant | Win | Lose |
|---|---|---|
| Wave survival | Survive N waves | HP reaches 0 |
| Level clear | Defeat all enemies / reach exit | HP reaches 0 |
| Score-attack | Highest score by timer | Timer expires below leader |

Default to **level clear, 1 level, 100 HP**.

## HUD plan

Required (cross-ref `@docs HUD_ELEMENTS.md`):

- **Player HP bar** — bottom-center or top-left
- **Ammo counter** — engine-owned: `RangedWeaponSystem` auto-creates a bottom-right `current/max` counter whenever reload is enabled. Do NOT `createCounter` your own ammo display — that produces two counters in the corner. Tune with `rangedSystem.setShowAmmoCounter('auto' | true | false)`. If you want the weapon NAME on screen, show it as a toast on pickup/switch, not a persistent bottom-right element.
- **Score / kill count** — top-right
- **Crosshair** — center of screen for FPS / TPS
- **Wave counter** (wave variant) — top-center
- **Level objective** — top-left or banner: `Find the exit` / `Defeat all enemies`

## Cross-reference to world-plan.md

- **Player spawn** at level start, with starting weapon/ammo nearby
- **Enemy spawners** placed throughout the level; trigger volumes activate them when player is in range
- **Ammo pickups** scattered through the level — cluster some at choke points
- **Health pickups** between combat zones; sparser the longer the level
- **Cover** — walls, pillars, debris from `archetype-arena.md` / `archetype-ruins.md` for tactical play
- **Exit / extraction point** for level-clear variant; mark in world-plan landmarks

## Common gotchas

- **Camera mode is genre-defining.** Read the prompt carefully. "Shooter" alone is ambiguous — assume top-down or third-person, ASK if unclear. "FPS" is unambiguous = first-person.
- **Don't use `WeaponMeleeSystem` for guns.** Ranged weapons use the projectile system, NOT melee. Read `@docs control-system.md` for mouse-aim binding.
- **Aim controls vary per camera.** First-person = mouse-look (cursor locked); top-down = mouse-aim (cursor visible, points at world position; the character faces movement while traversing and only turns to the cursor while firing — pass `cursorFacing: 'always'` to `RangedWeaponSystem` only when the prompt explicitly asks for classic twin-stick strafing); third-person = over-shoulder mouse-aim.
- **Set `useFreeMouse: true`** in `worldProfileData` for top-down shooters (cursor stays visible to aim with).
- **Ammo matters.** Without ammo limits, FPS games lose tension. Each weapon should have starting ammo + reload + max-carry rules.
- **Enemy hit feedback.** Damaging an enemy needs visual feedback (flash, knockback, sound). Otherwise combat feels mushy.
- **Don't forget the GAME-OVER state.** `Game.ts` needs explicit handling for "player died" — display "You Died" with restart button.

## Asset references

- Weapons: `weapon_pistol`, `weapon_rifle`, `weapon_shotgun`, `weapon_grenade_launcher` — engine handles projectile firing
- Enemies: NPC system per `@docs npc-system.md`; assets like `enemy_zombie`, `enemy_robot`, `enemy_bandit`
- Pickups: `ammo_box`, `health_kit`, `armor_plate` — small point-snap props with collectible behavior
- Cover: `barrel`, `crate`, `low_wall`, `pillar`

## Skeleton plan — copy-paste into `mechanics-plan.md`

```markdown
# Mechanics plan — <game name>

## Genre / archetype
Top-down twin-stick shooter. Player vs. waves of zombies in a derelict city. Pistol-only with limited ammo. Score-attack with leaderboard.

## Core systems
- Camera: top-down + `useFreeMouse: true` for aim cursor
- Player health (`@docs combat-system.md`) — 100 HP, no regen, dies on 0
- Player weapon: `weapon_pistol` ranged, 25 damage per hit, 12-round magazine, 60 reserve max
- Aim controls (`@docs control-system.md`) — mouse aims, click fires, R reloads
- Enemies (`@docs npc-system.md`) — `enemy_zombie`, 50 HP, 15 damage melee on contact, slow chase AI
- Wave system — 5 waves, escalating count
- Ammo/health pickups — drop chance from defeated enemies + scattered around level

## Win / lose conditions
- Win: survive all 5 waves
- Lose: HP reaches 0

## HUD plan (`@docs HUD_ELEMENTS.md`)
- Bottom-center: HP bar (100 → 0)
- Bottom-right: `Pistol: 12 / 60` (current mag / reserve)
- Top-right: `Kills: 18`
- Top-center: `Wave 3 / 5`
- Crosshair at mouse cursor (top-down aim)
- "You died" / "You survived!" overlay at end with restart

## Cross-reference to world-plan.md
- Use `archetype-ruins.md` for the world (post-apocalyptic city ruins)
- Player spawn at the central plaza (0, 0) with starting pistol + 24 reserve ammo
- 4 enemy spawners at compass-point streets entering the plaza; activate per-wave
- 6 ammo_box pickups + 3 health_kit pickups scattered through the ruined buildings
- Cover from `archetype-ruins.md`'s debris piles + ruined walls
```
