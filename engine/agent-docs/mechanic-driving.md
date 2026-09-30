# Mechanic: driving

## When to use

Prompts mentioning: drive, GTA, open-world driving, traffic, driving simulator, taxi, delivery, road trip. The gameplay loop is "drive vehicles around an open world, optionally with missions/objectives, but core fun is driving itself."

For lap-based competitive racing, use `@docs mechanic-racing.md` instead. For tight track combat (Mario Kart-style), use mechanic-racing too. **mechanic-driving is open-world / sandbox driving.**

## Camera / perspective

`cameraMode: 'third-person'` for both on-foot and driving — the engine switches the chase framing automatically on vehicle entry/exit (E to enter/exit). The player is an embodied character who walks up to vehicles; that walk→drive loop IS the genre. Top-down only for an explicitly retro ask ("GTA1/2-style", "Crazy Taxi top-down").

## Core systems

| System | Engine doc / handle | What it does |
|---|---|---|
| Vehicle controls | `@docs vehicle-system.md` | Player drives — set per vehicle: mass, engineForce, max speed, steering response |
| Vehicle entry/exit | `@docs vehicle-system.md` + `@docs control-system.md` | Player walks up to car, presses E to enter; presses E again to exit. Camera switches modes. |
| Traffic | `@docs vehicle-ai.md` BasicDrivingComponent | NPC vehicles follow road waypoints, idle when stopped, react to player |
| Speed / damage | engine | Vehicle takes damage on collision; HP system; explode + respawn at low HP |
| Missions (optional) | `@docs npc-system.md` + `@docs markers-system.md` | NPC quest givers, marker waypoints, objective-based gameplay |
| Wanted level (optional) | gameplay state | Police chases on bad behavior; escalating response |
| Money / progression (optional) | game state | Earn from missions; spend on better cars / upgrades |

## Variants

Pick ONE based on the prompt:

| Variant | Triggers | Distinct |
|---|---|---|
| **Open-world sandbox** (default) | "GTA", "open-world driving", "free-roam" | Roam freely, optional missions, traffic, vehicle variety |
| **Taxi / delivery** | "taxi", "delivery", "courier", "Crazy Taxi" | Pickup/drop-off marker chain; timer per ride; tip = score |
| **Stunt driving** | "stunt", "tricks", "ramps", "Tony Hawk for cars" | Ramp props throughout map; trick scoring system; combo timer |
| **Driving simulator** | "sim", "realistic driving" | Realistic physics, traffic laws, no aggressive elements |

## Win / lose conditions

Driving is OFTEN endless / sandbox-style — there's no win/lose by default. If the prompt asks for objectives:

| Variant | Win | Lose |
|---|---|---|
| Mission-based | Complete all missions | Optional — typically just "fail this mission" |
| Time-attack | Complete N deliveries before timer expires | Timer expires |
| Stunt scoring | Beat target score in time limit | Timer expires below target |
| Free-roam | (no end state) | (no fail state) |

## HUD plan

Required (cross-ref `@docs HUD_ELEMENTS.md`):

- **Speed** — bottom-center: km/h or mph
- **Vehicle HP** — bottom-left: damage state (none / minor / serious / critical)
- **Mini-map** — top-left or bottom-right: shows player + active mission markers
- **Money** (sandbox variant) — top-right: `$ 12,450`
- **Wanted level** (sandbox variant) — top-right or as star meter
- **Mission objective** (mission variant) — top-center banner: `Drive to the docks`
- **Speed-camera notification** (sim variant) — pop-up

## Cross-reference to world-plan.md

- **Use `archetype-city.md` for the world.** Driving needs roads, traffic, buildings to drive past.
- **Player spawn** outside or inside a vehicle at a defined location. If outside, player walks to nearest vehicle (key: E to enter).
- **Vehicle spawns** — scatter 10-20 vehicles around the city as both decoration and player-rideable assets. Each is an environmentObject with `interactable: true`.
- **Mission markers** (mission variant) — placed at NPCs / locations; use `@docs markers-system.md`.
- **Traffic spawn density** — define how many AI cars exist on streets. Default: 1 NPC car per 50m of road length.
- **Police spawn points** (sandbox variant) — at specific locations; trigger when wanted level rises.

## Common gotchas

- **Vehicle entry/exit is critical UX.** Without smooth E-to-enter / E-to-exit, the game feels broken. Test the camera transition: third-person walk → third-person drive.
- **Don't make vehicles too fragile.** Players will crash a lot. Default vehicle HP should be high enough to survive 10+ minor collisions.
- **Traffic AI is tricky.** Use `BasicDrivingComponent` per `@docs vehicle-ai.md`; give traffic cars simple loop waypoints (not random).
- **Don't put trees/rocks/random decor ON the road.** City archetype handles this via `biome-scatter` urban suppression — trust it. If anything spawns on the road, density rules need adjusting.
- **GTA-style needs `cameraMode: 'third-person'`**, not top-down. Top-down driving is more arcade (Crazy Taxi, GTA1/2).
- **Money / progression scales matter.** A $50 starter car vs. a $50,000 sports car gives the player something to grind toward. Without a price ladder, money is meaningless.

## Asset references

- Vehicles: create with the `design-vehicle` tool — it builds a DRIVABLE vehicle asset (any type: sedan, pickup, taxi, police car, sports car…) with physics fitment included; spawn via `spawnAndEnterFromAsset`. Use `presetName` (SEDAN, PICKUP, POLICE_CRUISER, …) for standard vehicles (fast, free); a custom prompt for themed ones. Never build drivable vehicles from voxel boxes or `asset3dGenerationTool` — those produce static props without fitment.
- City elements: `archetype-city.md` covers buildings + streetlights + parked cars
- Mission markers: `marker_pin`, `marker_destination`
- Police: `enemy_police_officer` NPC + `vehicle_police_car`

## Skeleton plan — copy-paste into `mechanics-plan.md`

```markdown
# Mechanics plan — <game name>

## Genre / archetype
GTA-style open-world driving sandbox. Player walks third-person; can enter any of 15 scattered vehicles. Free-roam city with light traffic. No combat in V1; just driving + exploring + light missions (deliver to marker).

## Core systems
- Vehicle controls (`@docs vehicle-system.md`) — variety: sedan (default), sports car (faster), truck (slower, tougher)
- Vehicle entry/exit (`@docs vehicle-system.md` + `@docs control-system.md`) — E key, configured via `setVehicleExitLocked(false)`
- Traffic (`@docs vehicle-ai.md`) — 8 NPC sedans patrolling the city streets, BasicDrivingComponent
- Vehicle HP — 100, regen on standing still for 5 seconds (idle repair)
- Optional V1 mission: 3 delivery markers; reach each within timer

## Win / lose conditions
Free-roam — no end state.
Optional mission: complete all 3 deliveries within 3 minutes for a "tip" reward; missing = mission fail (no game-over).

## HUD plan (`@docs HUD_ELEMENTS.md`)
- Bottom-center: speed (km/h)
- Bottom-left: vehicle HP indicator (icon + bar)
- Top-left: mini-map showing player + 8 traffic dots + 3 delivery markers
- Top-right: `$ 0` (money — used for V2 vehicle purchases)
- Top-center: optional mission banner `Deliver pizza to the docks (1:23 left)`

## Cross-reference to world-plan.md
- Use `archetype-city.md` for the world (downtown_core + residential + industrial + parks).
- Player spawns outside of `vehicle_sedan` parked at downtown_core (0, 0). E to enter.
- 15 vehicles scattered as environmentObjects with `interactable: true`: 8 in residential + 4 in downtown + 3 in industrial. Mix of sedan / truck / sportscar.
- 8 traffic NPC vehicles patrolling pre-defined waypoint loops on main streets.
- 3 mission delivery markers placed at random street corners (using `@docs markers-system.md`).
```
