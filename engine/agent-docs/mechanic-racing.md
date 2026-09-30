# Mechanic: racing

> **Coordinate convention:** Cars use **+Z gameplay forward** (matches the engine's gameplay convention — see `@docs coordinate-system.md` §2 and `@docs vehicle-system.md` for the yaw table). Use `headingToward()` / `headingTangent()` / `FACE.*` constants from `engine/Vehicle.js` rather than hand-rolling yaw math.

## When to use

Prompts mentioning: race, racing, lap, drift, circuit, derby, F1, NASCAR, GP, motorsport, rally. The gameplay loop is "drive around a track faster than opponents/clock."

For the WORLD layout (track shape, walls, spectators), ALSO load `@docs archetype-racetrack.md`.
In a Bitmagic GDK project the circuit is forged (`bitmagic forge`, ask first — see that doc's
"When to use"); this mechanic is what you wire onto the forged level, never a track painted in code.

## Camera / perspective

`cameraMode: 'third-person'` — the chase camera behind the vehicle (auto-engages while driving). NOT top-down: that is only for an explicitly retro/arcade ask ("top-down racer", "GTA1-style"). The player is locked into their vehicle for the whole race (`installRacingDefaults` enforces this — no on-foot sections, no exit prompt) unless the prompt explicitly mixes on-foot play.

## Core systems

| System | Engine doc / handle | What it does |
|---|---|---|
| Vehicle controls | `@docs vehicle-system.md` | Player drives a car/kart. Set `engineForce`, `mass`, `width`, `length` per vehicle spec. |
| AI opponents | `@docs vehicle-ai.md` | `BasicDrivingComponent` follows waypoint chain. Place 3-5 AI cars at start grid. |
| Lap timer | HUD element + trigger volume | Increments lap count when player crosses finish-line trigger after passing a checkpoint elsewhere. |
| Checkpoints | trigger volumes around track | Anti-cheat: player must hit each checkpoint in order before lap counts. |
| Finish line | trigger volume + visual arch | Lap-completion detection. |
| Leaderboard / standings | HUD element | Shows current position vs AI opponents. |
| Optional: weapons | `@docs combat-system.md` | Mario-Kart-style item pickups / boost |

## Recommended engine defaults (use these instead of inventing values)

Generated racing games should use the tuned engine defaults rather than spelling out their own physics + voxel-body shapes:

| Use | Where it lives | Notes |
|---|---|---|
| Vehicle assets (`design-vehicle` tool) | asset library / `vehicleFitment` | **The preferred car source.** Ask the asset agent to create the player car (+ optionally distinct AI cars) with the design-vehicle tool — presets `GT_RACER`, `F1_RACER`, `GO_KART`, `MUSCLE_CAR` fit racing and carry race top speeds; a custom prompt matches the theme but MUST set a fast `physics.handling.topSpeed` (the engine default is a ~28 m/s cruise, not a race pace). Spawn with `await spawner.spawnAndEnterFromAsset(pos, name, playerController, { spawnRotation })`; physics comes from the asset. |
| `DEFAULT_RACING_CAR_CONFIG` | `engine/Vehicle.js` | Fallback `PlatformVehicleConfig` when NO vehicle asset exists. Mass 1700kg, engineForce 7500, stiff suspension, friction 130. Pass directly to `spawner.spawnVehicle(...)` / `spawner.spawnAndEnter(...)`. |
| `VoxelCarBodyBuilder.sedanBody(color)` | `engine/builders/index.js` | Fallback box body matching `DEFAULT_RACING_CAR_CONFIG` — a Volvo-240-silhouette voxel sedan. Only for games without vehicle assets. |
| `installRacingDefaults(engine, playerController, DEFAULT_RACING_SETUP_OPTIONS)` | `engine/Vehicle.js` (re-export) | **Required for any racing game — the completion gate enforces it.** One call that applies every racing default: locks the player into their vehicle (no "Exit vehicle" prompt / E-to-exit), keeps the mouse cursor free (no pointer lock — racing has no mouse-look and the chase camera's drag-to-orbit needs a visible cursor), and creates the auto-right + unstuck safety systems (below). Returns a `RacingSetup`: call `.register(vehicle)` for EVERY spawned vehicle (player and AI) and `.update(dt)` each frame. Do NOT construct `VehicleAutoRightSystem` / `VehicleUnstuckSystem` directly — the preset owns them. |
| `VehicleAutoRightSystem` | included in `installRacingDefaults` | Snaps tilted vehicles back upright after ~1.5s — wipeouts otherwise leave cars stuck. |
| `VehicleRouteRecoverySystem` | included in `installRacingDefaults` | Route-aware rejoin for AI rivals — see **AI stuck off the racing line** below. Opt in per car with `racing.register(vehicle, route)`. |
| `VehicleUnstuckSystem` | included in `installRacingDefaults` | Last-resort recovery for two cars genuinely locked together (a grid stacking up, a rear-end shunt welding two cars into a train). Fires only when the chassis boxes are really touching (exact oriented-box test — never centre distance), the pair moves in LOCKSTEP (near-zero RELATIVE velocity — absolute speed is irrelevant, a welded train can be doing race pace), at least one is on the throttle, and it has held for `contactDuration`. It then de-penetrates by the depth they actually overlap and tops the pair up to `bumpSpeed` m/s of relative separation — centimetres and a walking pace, never a shove — and `RacingSetup` tells the ramming car's AI (`yieldThrottle` on its driving component) to lift for a moment so the pair doesn't immediately re-weld. A car passing another (real relative motion) is deliberately left alone. Call `racing.setStuckDetectionEnabled(false)` during a start countdown and `true` on GO. To tune, pass `{ ...DEFAULT_RACING_SETUP_OPTIONS, unstuck: { ...DEFAULT_VEHICLE_UNSTUCK_OPTIONS, debugLog: true } }` to `installRacingDefaults`. |

### Minimal racing setup

```ts
import { DEFAULT_RACING_CAR_CONFIG, BasicDrivingComponent,
         installRacingDefaults, DEFAULT_RACING_SETUP_OPTIONS } from 'engine/Vehicle.js';
import { VoxelCarBodyBuilder } from 'engine/builders/index.js';

const COLORS = [0xff3322, 0x2266ff, 0xffcc00, 0x33dd44];
// REQUIRED: locks player into the kart (no "Exit vehicle"), frees the mouse cursor
// (no pointer lock), and creates the auto-right + unstuck safety systems.
this.racing = installRacingDefaults(this.engine, playerController, DEFAULT_RACING_SETUP_OPTIONS);

// Build a starting grid ON the track (positions + tangent headings per slot).
// DO NOT share one yaw across all slots — tangent varies around the loop.
const grid = spawner.layoutGridOnLoop({
    center: trackLoopCenter, radius: trackRadius, travel: 'ccw',
    startAngle: -Math.PI / 2,   // pole position (cos/sin convention; matches waypoint loop)
    slots: 1 + NUM_AI, laneOffset: 1.5, slotSpacing: 4,
});

// Player — PREFERRED: a vehicle asset made by the design-vehicle tool
// (physics + visuals come from the asset; grid heading via options):
//   const playerSpawn = await spawner.spawnAndEnterFromAsset(
//       grid[0].position, 'PlayerKart', playerController, { spawnRotation: grid[0].heading });
// Fallback when the game has no vehicle asset:
const playerSpawn = spawner.spawnAndEnter(
    grid[0].position, DEFAULT_RACING_CAR_CONFIG,
    VoxelCarBodyBuilder.sedanBody(COLORS[0]),
    playerController, grid[0].heading,
);
if (playerSpawn) {
    this.racing.register(playerSpawn.vehicle);
}

// AI cars
for (let i = 1; i < grid.length; i++) {
    const r = spawner.spawnVehicle(grid[i].position, DEFAULT_RACING_CAR_CONFIG, undefined, grid[i].heading);
    if (!r) continue;
    VoxelCarBodyBuilder.addVoxelBody(r.vehicle, r.platform, VoxelCarBodyBuilder.sedanBody(COLORS[i % COLORS.length]));
    const driving = new BasicDrivingComponent();
    driving.maxSpeed = 13 + Math.random() * 3;   // jitter so AI doesn't drive in lockstep
    r.vehicle.setDrivingComponent(driving);
    r.vehicle.setAlwaysActive(true);
    this.racing.register(r.vehicle);
}

// In update():
this.racing.update(deltaTime);
```

**Stuck on scenery:** `installRacingDefaults` also installs `VehicleStuckSystem` — a car that is throttling but not moving (or standing with no wheel on the ground) gets nudged free, and after a few failed nudges respawned via `racing.setRespawnProvider(v => ({ position, heading }))` (hand back the last checkpoint). **The same provider also catches a car that falls off the map** — set it and the kill plane teleports the car back with the driver still in it; leave it unset and the racing exit lock alone saves them, at the player's spawn (see `@docs vehicle-system.md` → "Falling off the map"). Chassis restitution defaults to `DEFAULT_CHASSIS_RESTITUTION` (0.35) and chassis friction to `DEFAULT_CHASSIS_FRICTION` (0.15) — slippery on purpose, since all grip comes from the raycast wheels and a grippy chassis just welds cars to each other and to walls; override per vehicle with `VehicleConfig.chassisRestitution` / `chassisFriction`. **Suspend the detectors whenever the game holds cars still on purpose** — `racing.setStuckDetectionEnabled(false)` — or a held throttle at a locked start line reads as stuck; `RaceCountdown` does this for you.

**AI stuck off the racing line:** the systems above recover a car WHERE IT LANDED — upright, unwelded, nudged free. That is not enough for a rival, whose pursuit target is still the waypoint it can no longer reach: a kart shunted over a shortcut wall gets rescued and then drives away from the track, or shuffles against the wall forever. Pass each AI's route to `register` and the engine adds the missing half — put the car back ON the line, pointed down it, with its follower re-aimed:

```ts
this.racing.register(r.vehicle, {
    // `points` is the SAME waypoint array the AI is steering along.
    // `targetIndex` is that car's own progress — the engine only ever rejoins
    // AT or AHEAD of it, so a rescue can't hand back a lap.
    route: (v) => ({
        points: this.waypoints,
        targetIndex: this.progressOf(v),
        loop: true,
        corridorHalfWidth: TRACK_HALF_WIDTH,   // the painted half-width
    }),
    // Move your own lap/position bookkeeping to where the car actually is.
    onRejoined: (v, index) => { this.setProgressOf(v, index); },
});
```

It fires from two bounded places: after `VehicleStuckSystem` exhausts its nudges (in preference to `setRespawnProvider`, which gives a position but says nothing about follower progress), and after a rival has been outside `corridorHalfWidth` of the centerline for `offRouteGraceSeconds` (default 3) — long enough that a wide line, a cut corner or a spin that recovers on its own is never touched. The car is teleported to the nearest FORWARD centerline point, faced at the next one via `headingToward`, its velocity zeroed, and its driving component re-aimed at that next point. `setStuckDetectionEnabled(false)` gates this too, so a starting grid sitting a lane-width off the centerline is left alone during the countdown. Register the PLAYER's car without a route — the engine never steers a human back onto the line (and skips any car with no driving component regardless). Tune with `{ ...DEFAULT_RACING_SETUP_OPTIONS, route: { ...DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS, debugLog: true } }`.

**Drift / donuts / power oversteer:** a wheel has TWO independent grip knobs, and picking the wrong one is why sliding "won't work". `vehicle.setWheelFrictionSlip(i, v)` is the tyre's TOTAL force budget — forward and sideways share one friction circle, so cutting it to break the back loose also starves the drive force, and the per-substep terrain-grip pass overwrites it anyway (re-apply in a pre-step callback if you must use it). `vehicle.setWheelSideFrictionStiffness(i, v)` scales the SIDEWAYS impulse only: drop the REAR wheels to ~0.15 (or set `WheelConfig.sideFrictionStiffness` at spawn) and the back steps out under power while the wheels keep full thrust — ~0.05 is ice, 1 is stock. Nothing rewrites it per substep. Never fake a slide with an applied torque.

**Start-line countdown:** to hold the player at the line for a 3-2-1-GO, use `RaceCountdown` from the sample — it freezes the player's chassis body until GO and releases it idempotently. Do NOT gate the start with `playerController.setControlsEnabled(false)`: that does not reliably stop a *vehicle* (depending on timing the kart creeps off the line during the count, or never unlocks on GO).

Reference implementation: `samples/racing-setup.ts` (`setupRace` + `RaceCountdown` + `CenterlineAi` for track-following rivals, whose `routeRecovery()` wires the block above, compile-checked against the live engine).

For non-circular tracks, use `headingToward(spawnPos, firstWaypoint)` per slot instead — never a single shared `Math.PI`-style constant. See `@docs vehicle-system.md` "spawnRotation — yaw convention".

The AI waypoint-following loop itself is documented in `@docs vehicle-ai.md` — don't duplicate it here.

## AI waypoint chain

For a **baked GLB track** voxelized with the trimesh-collider option, the engine builds the chain for you: `getBakedLevel()?.getTrackCenterline(name)` (a voxel bake or a low-poly mesh level) returns a road-centered, evenly-spaced, closed waypoint loop — drive it through the follow loop in `@docs vehicle-ai.md` (`setTarget` → `updateAI` → advance on `isNear`); see `@docs named-trimesh-query.md`. The lap comes back running the way the `player` spawn faces, so it already matches the starting grid; override with `orientTo` only when the racing direction is defined by something else (details in `@docs named-trimesh-query.md`). For a **painted / procedural track** (no baked trimesh), build the centerline array yourself from the loop center(s) + radius the WorldGenerator paints. Two case-specific notes (most car games need neither; they don't apply to free-roam driving):

- **Cars confined to a painted track:** sample the same loop center(s) and radius the WorldGenerator paints and that you declare in `worldProfileData.tracks`. Mismatched points sit off the asphalt and the AI drives onto grass.
- **Figure-8 tracks:** two loops of OPPOSITE winding joined at one shared crossover (track spans ±2·radius from it). `layoutGridOnLoop` / `headingTangent` only fit a single loop, so derive each figure-8 spawn heading with `headingToward(spawnPos, firstWaypoint)` instead.

## Win / lose conditions

| Variant | Win | Lose |
|---|---|---|
| Sprint race (default) | Complete N laps faster than all AI opponents | An AI finishes before you |
| Time trial | Complete N laps under target time | Time exceeded |
| Demolition derby | Be the last vehicle still drivable | Your vehicle destroyed |
| Drift | Hit drift-score target before time runs out | Time expires |

Default to **sprint race, 3 laps, 5 AI opponents** unless prompt specifies otherwise.

For a time trial, or any prompt asking to race a best time / a friend's run,
add ghosts — recorded runs replayed as translucent competitors, plus a
leaderboard and a challenge link. See `@docs ghost-racing.md`.

## HUD plan

Required (cross-ref `@docs HUD_ELEMENTS.md`):

- **Lap counter** — top-center: `Lap 1 / 3`
- **Position** — top-left: `1st of 6`
- **Lap time** — top-right: current and best lap times
- **Speed** — bottom-center: km/h
- **Optional:** minimap of track + dot per car

For demolition derby, replace lap counter with **alive count** (`3 / 6 still in`).

## Cross-reference to world-plan.md

- **Start grid:** specific positions on the track for player + AI spawn. Mark in `world-plan.md` Landmarks as `start_grid_*` with positions matching the start line.
- **Finish line trigger:** at the start_line landmark; trigger volume size ~track-width × 2m.
- **Checkpoints:** 3-6 trigger volumes around the track at 1/3 / 2/3 / etc. spacing. Mark in `world-plan.md` Landmarks as `checkpoint_*`.
- **AI waypoint chain:** ~24-50 centerline points you build yourself (no engine generator) — see **AI waypoint chain** above. Center(s) + radius MUST match the painted asphalt.

## Track width — minimum to fit N cars

`DEFAULT_RACING_CAR_CONFIG.width` is **2.3m**. A track that's only "wide enough for 2 cars" makes overtaking impossible and cars constantly clip the inner wall on tight turns. Use this minimum for the painted-asphalt half-width in your WorldGenerator (full track width = `2 * halfWidth`):

| Cars side-by-side | Min full width | Min `halfWidth` | Notes |
|---|---|---|---|
| 2 (sprint, narrow) | 6 m | 3 m | bare minimum, cars touch on overtake |
| 4 (default) | **12 m** | **6 m** | recommended default — 2-wide grid + room to pass |
| 6 (wide GP) | 18 m | 9 m | F1-style, plenty of overtaking room |
| 8+ (NASCAR oval) | 24 m+ | 12 m+ | banked oval, dense pack racing |

Default to `halfWidth = 6` (12m wide track) unless the prompt explicitly asks for a narrow / sprint / kart track. Anything below `halfWidth = 5` should only be picked when the prompt says so — racing on an 8-meter track feels cramped on screen and the AI karts constantly bump the inside wall.

## Start arch / finish line — rotation must be PERPENDICULAR to the racing tangent

The start arch is a structure cars drive *under* — its long axis (the horizontal bar) must cross the racing line, not run parallel to it. The bug-class is the same as the kart-spawn rotation: a hand-picked `Math.PI/2`-ish constant works only at the four cardinal points of the loop and is 90° off everywhere else.

Compute the tangent at the arch position with `headingTangent`, then add `π/2` to get the perpendicular orientation:

```ts
import { headingTangent } from 'engine/Vehicle.js';

const archPos = { x: 14, z: -16 };               // on the track centerline
const tangent = headingTangent(loopCenter, archPos, 'ccw');  // racing direction here
const archRotY = tangent + Math.PI / 2;          // perpendicular → arch spans across the track
```

Then write the arch into world.json with that rotation and `onTrackOk: true` (so the painted-track-overlap warning doesn't fire on it):

```jsonc
{ "id": "start_arch", "type": "start_arch", "assetId": "...",
  "position": { "x": 14, "y": 0, "z": -16 },
  "rotation": { "x": 0, "y": -1.5708, "z": 0 },   // = tangent(-π/2) + π/2 = 0 — but verify per asset
  "onTrackOk": true }
```

**Asset-axis caveat:** the formula above assumes the arch asset's "long axis" is along its local +X. If the asset is built with the long axis along local +Z instead, drop the `+ π/2` (use `archRotY = tangent` directly). Verify empirically: place the arch alone at world origin with `rotation.y = 0` and look at it from +Z — if the cross-bar runs left-right, the long axis is +X (formula works as written); if it runs front-back, the long axis is +Z (skip the `+ π/2`).

The same rule applies to finish-line trigger arches and any other "drive-through" gate.

## Declare the painted track in `worldProfileData.tracks`

When the WorldGenerator paints asphalt onto a ring (the standard racetrack archetype), declare the same geometry in `worldProfileData.tracks`. The `validate-world-json` tool then checks every environmentObject against those rings and warns on objects that landed on the racing surface — typo'd boost-pad coords, walls placed at the inner edge of the asphalt instead of inside the island, and the figure-8 crossover trap (one loop's wall ring landing on the other loop's track).

```jsonc
"worldProfileData": {
  "tracks": [
    { "id": "right-loop", "shape": "ring", "center": { "x":  26, "z": 0 }, "radius": 30, "halfWidth": 6 },
    { "id": "left-loop",  "shape": "ring", "center": { "x": -26, "z": 0 }, "radius": 30, "halfWidth": 6 }
  ]
}
```

`center`, `radius`, `halfWidth` MUST match what `WorldGenerator.generateVoxelTerrain` actually paints — the validator can't catch a mismatch between code and declaration, only between declaration and object positions.

For environmentObjects that are intentionally on the racing surface (start arch, finish line, boost pads, on-track decor), set `onTrackOk: true` to suppress the warning per object:

```jsonc
{ "id": "finish_arch", "type": "voxelObject", "assetId": "...",
  "position": { "x": 26, "y": 0, "z": -30 }, "onTrackOk": true }
```

## Common gotchas

- **Tangent-spawn trap.** For circular / figure-8 tracks, every kart's heading must be the TANGENT of the loop at its OWN spawn position — not a single shared `Math.PI`-style constant. Use `spawner.layoutGridOnLoop(...)`, or `headingTangent(center, p, 'ccw')` per slot. This is the car-spawn analogue of the wall-rotation bug in `arc-wall-placement.md`. Symptom: every kart 90° sideways across the track.
- **Spawn slots must land on the track surface.** A 5-car grid stacked behind a straight start line drops the back rows onto raw terrain south of the loop. For a loop centered at `(cx, cz)` with track between `INNER_R` and `OUTER_R`, every spawn slot must satisfy `INNER_R + carWidth/2 ≤ √((x-cx)² + (z-cz)²) ≤ OUTER_R - carWidth/2`. `layoutGridOnLoop` does this automatically — for hand-rolled grids, assert it before spawning. `spawnVehicle` honors the requested X/Z exactly (only ground height is resolved), so a bad slot is never corrected — it just spawns off the asphalt.
- **Lap counts only after a checkpoint.** If you increment lap on every finish-line crossing, the player can drive a tight U-turn at the start and "complete" laps in seconds. ALWAYS gate by checkpoint progression.
- **AI vehicles spawn AT THE START LINE**, in formation behind the player. Don't randomize their positions — racing requires a clear starting grid.
- **Camera mode is third-person, NOT top-down** for most racing prompts. Top-down is for arcade/derby variants only. Read the prompt carefully.
- **Lap time = 0** at the start of each lap. Don't display "Lap 1 best: 0:00" — show only after lap 1 completes.
- **Don't put a finish-arch trigger volume at WORLD ORIGIN by default.** Place it at the actual start_line landmark from `world-plan.md`.
- **Vehicle mass matters.** For a standard racing sedan, use `DEFAULT_RACING_CAR_CONFIG` (1700kg, engineForce 7500). Only override for non-sedan variants — heavy truck (2000kg, 5000), kart (300kg, 1500).

## Asset references (cross-ref `archetype-racetrack.md`)

The racing MECHANIC needs the racing WORLD. Don't generate gameplay without reading the racetrack archetype for layout, walls, start arch, etc.

## Skeleton plan — copy-paste into `mechanics-plan.md`

```markdown
# Mechanics plan — <game name>

## Genre / archetype
Sprint race, 3 laps. Player drives third-person against 5 AI opponents on a figure-8 track. Best lap time tracked. Win by finishing first.

## Core systems
- Vehicle controls (`@docs vehicle-system.md`) — prefer a vehicle asset via the design-vehicle tool + `spawnAndEnterFromAsset`; fallback `DEFAULT_RACING_CAR_CONFIG` + `VoxelCarBodyBuilder.sedanBody(color)` (see "Recommended engine defaults" above)
- AI opponents (`@docs vehicle-ai.md`) — 5 AI cars with `BasicDrivingComponent`, follow waypoint chain
- Lap timer + checkpoint system — 4 checkpoints around the figure-8, 1 finish line trigger at start
- Leaderboard — track current position based on lap count + checkpoint progress

## Win / lose conditions
- Win: complete 3 laps before any AI does
- Lose: any AI completes 3 laps before you

## HUD plan (`@docs HUD_ELEMENTS.md`)
- Top-center: `Lap 1 / 3`
- Top-left: `1st of 6`
- Top-right: current lap time + best lap
- Bottom-center: speed (km/h)
- Bottom-left: minimap of figure-8 with car dots

## Cross-reference to world-plan.md
- Start grid (player + 5 AI) at the southern straight (y=-40 in figure-8 archetype layout); player at front, AI behind in formation
- Finish line trigger volume at start_line landmark, width = track surface (10m), depth 2m
- 4 checkpoints: at angles π/2 and 3π/2 of each loop center, trigger volume 4m square
- AI waypoints: ~32 centerline points around the figure-8 (see **AI waypoint chain**)
```
