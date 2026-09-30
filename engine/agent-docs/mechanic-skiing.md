# Skiing mechanic (also snowboarding)

This recipe covers snowboard games too — snowboarding is the same motor with `equipmentStyle: 'snowboard'` (see the config table), not a separate mechanic.

Arcade ski controls (SSX / Steep feel) on the standard player character. Engine module: `engine/ski/`. The player gets procedural skis and poles automatically; gravity accelerates downhill, A/D carve, W tucks (or skate-pushes from standstill), S brakes, Space jumps, and in the air action+left/right spins while action+forward front-flips, with landing assist.

## Camera / perspective

`cameraMode: 'third-person'` on the embodied skier — the standard camera auto-follows behind the run and swings with carving; no custom camera code needed (see the wiring table below). Never top-down (slope gradient and jumps are unreadable) and never first-person unless explicitly asked.

## Terrain first

Skiing needs smooth designed slopes. The mountain/piste comes from the orchestrator's World-Forger (`runWorldForger`) — a generated level with exact smooth trimesh physics. Procedural voxel hills are walkable but wrong for sliding gameplay. The ski motor still autosteps small voxel steps, so mixed terrain works — but the core run should be a designed slope.

## Enabling

Preferred — world.json flag (no code):

    worldProfileData.playerMovement = { "mode": "ski", "ski": { "maxSpeed": 32 } }

Set it with edit-world-config. The engine installs ski movement at spawn. The optional `ski` object overrides any `SkiConfig` field; unknown keys are ignored.

Code path (for mount/dismount gameplay, e.g. walk in the lodge, ski outside):

    import { SkiMovement } from 'engine/ski/index.js';
    const ski = new SkiMovement({ maxSpeed: 32 });
    playerController.setMovementSystem(ski);          // mount
    playerController.setMovementSystem(walking);      // dismount (cleans up automatically)

## Key config fields (full list: engine/ski/SkiConfig.ts)

| Field | Default | Meaning |
|---|---|---|
| maxSpeed / tuckMaxSpeed | 28 / 38 | Speed caps (m/s) |
| turnRateLowDeg / turnRateHighDeg | 190 / 90 | Carve agility at low/high speed (deg/s) |
| gripRate | 5.5 | How fast carving redirects momentum (1/s) |
| brakeDecel | 14 | Braking strength (m/s^2) |
| jumpSpeed | 7.5 | Jump take-off speed (m/s) |
| spinRateDeg | 380 | Aerial spin rate (deg/s) |
| showEquipment / showPoles | true | Default ski/pole visuals (poles are ignored for snowboard) |
| equipmentStyle | ski | `ski` (two forward skis, upright glide) or `snowboard` (one sideways board, sideways stance) — pick this explicitly per game |
| stance / boardYawDeg | regular / 85 | Snowboard only: lead foot (`regular` = left forward, `goofy` = right) and board yaw off the travel heading (deg) |
| skiColor / poleColor | 0xe04a3a / 0x303438 | Equipment colors (hex) |
| cameraAutoFollow | true | Camera swings behind the skier |

## Game state (HUD, timers, scoring)

Poll per frame from game code:

    const s = ski.getSkiState();
    // s.speed (m/s), s.grounded, s.airtimeSeconds, s.slopeAngleDeg,
    // s.heading (rad), s.velocity (Vector3, world m/s),
    // s.skid (0 clean carve .. 1 fully sideways), s.lastTrick, s.bailing

Race recipe: start a timer when `s.speed` first exceeds 1.5 m/s; finish when the player enters a finish sphere; restart with `ski.teleport(startPosition, startYaw)`. `teleport` snaps the player onto the surface under the given position and zeroes velocity.

Snow-spray / powder: use the engine's `SnowSprayVFX` (from `engine/ski/index.js`) — lit, shadow-casting voxel-cube grains that read as real powder against snow (don't hand-roll a `THREE.Points` cloud; points can't be lit or cast shadows). Construct `const spray = new SnowSprayVFX(scene)`, then each frame `spray.update(deltaTime, ski.getSkiState(), playerWorldPosition)`. It scales the plume by `skid * speed`, emits from the board/snow line, and casts shadows automatically. Tune density/size/tint via an options bag spread over `DEFAULT_SNOW_SPRAY_VFX_OPTIONS`.

Crash recovery placement: hard crashes tumble the player (ragdoll) and stand them up where the tumble ended, at zero speed. To instead return the player to the course, watch for `bailing` flipping true to false and call `ski.teleport(lastCheckpointPosition, courseYaw)` that frame.

## Migrating from the removed snowboard module

`engine/snowboard/` no longer exists — but snowboarding does. It is now a style on the same motor: set `equipmentStyle: 'snowboard'` (plus `stance` / `boardYawDeg`), not a separate module. Replace:

| Old | New |
|---|---|
| `new SnowboardMovement(physicsWorld, scene, getSkiConfig())` | `new SkiMovement({ ...overrides })` |
| `snowboard.mount(position, rotation)` | `playerController.setMovementSystem(ski)` then `ski.teleport(position, yaw)` |
| `snowboard.dismount()` | `playerController.setMovementSystem(walkingMovement)` |
| `snowboard.getSnowboardState()` | `ski.getSkiState()` |
| `snowboard.teleport(position, quaternion)` | `ski.teleport(position, yaw)` |
| `snowboard.updateSnowboardConfig(cfg)` | `ski.updateConfig(partialSkiConfig)` |
| `SnowboardCamera` | nothing — the standard camera auto-follows |

Spawn the player at the slope start via the normal spawn position; no separate board body exists anymore.

## Gotchas

- The flag only applies when genre code does not pass an explicit movement system to PlayerController.
- Tricks use the built-in `action` key (Enter / left mouse / mobile action button) as a modifier — no new bindings needed.
- Brake is the backward key; there is no separate descend control while skiing.
- Equipment (`SkiEquipment`) is a procedural mesh group placed in world space at the player's feet, not bone-attached; set `showEquipment: false` (and/or `showPoles: false`) to ski without visuals.
