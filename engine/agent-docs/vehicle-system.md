# Vehicle System

> **Coordinate convention:** Vehicle local forward is **+Z**, matching the engine's gameplay convention (see `@docs coordinate-system.md` §2 / §7). The `spawnRotation` yaw table below is the canonical reference for cardinal headings — `spawnRotation: 0` faces +Z. Prefer `vehicle.getForwardDirection()` and the helpers (`FACE.*`, `headingToward`, `headingTangent`) over raw radians.

> **Activation default:** every vehicle is **always-active by default** — it keeps simulating and never falls through terrain off-screen, so AI-driven vehicles (e.g. racing opponents) never freeze or vanish out of view. Call `vehicle.setAlwaysActive(false)` ONLY for ambient/parked vehicles that are safe to freeze off-camera. Player-driven vehicles are always active regardless. See `@docs spawning-system.md` → "Entity Activation".

> **Exact spawn position + parking brake:** `spawnVehicle` / `spawnFromAsset` place the vehicle EXACTLY at the requested X/Z (only ground height is resolved) — grid slots and designer spawn points are honored as-is, never auto-adjusted. Slopes are safe: every vehicle spawns with the parking brake engaged and holds (even on a hill) until the first gas/reverse input — player key or AI throttle — releases it; exiting re-engages it. Override only via `vehicle.setParkingBrake(false)` when a driverless car should genuinely roll.

## Overview

The engine provides a complete vehicle system: spawning, entering, exiting, driving, AI control, and collision detection. Template code should only use the public API.

> **Driver controls & mobile parity:** for the steer/throttle/brake bindings, the enter/exit button, and how on-screen mobile controls map to driving (joystick to steer, action button to fire, etc.), read `@docs control-system.md`. Bind every driver input through the engine's action framework — never raw `pointer`/`keydown` listeners — so desktop and mobile stay at parity.

## Vehicle Public API (Quick Reference)

```typescript
// --- Spawning ---
const spawner = engine.getVehicleSpawner();
// PREFERRED — from a vehicle ASSET (created by the design-vehicle tool or an
// imported bmVehicle GLB). The asset's fitment supplies the platform size,
// wheel layout, mass and handling automatically; the asset IS the body:
const result = await spawner.spawnFromAsset({ x: 10, z: 20 }, 'PlayerCar', { spawnRotation: 0 });
const result = await spawner.spawnAndEnterFromAsset({ x: 10, z: 20 }, 'PlayerCar', playerController, { spawnRotation: 0 });
// Legacy — hand-built platform + box body (only when no vehicle asset exists):
const result = spawner.spawnVehicle({ x: 10, z: 20 }, platformConfig);
const result = spawner.spawnAndEnter({ x: 10, z: 20 }, platformConfig, bodyConfig, playerController);

// --- Position & Movement ---
vehicle.getPosition(): THREE.Vector3
vehicle.getLinearVelocity(): THREE.Vector3
vehicle.getSpeed(): number                    // m/s
vehicle.getForwardDirection(): THREE.Vector3
vehicle.getUpDirection(): THREE.Vector3
vehicle.getSteeringAngle(): number            // radians
vehicle.isGrounded(): boolean

// --- Forces ---
vehicle.applyImpulse(x, y, z): void          // world-space impulse
vehicle.applyLocalImpulse(x, y, z): void     // vehicle-local impulse (z = forward)
vehicle.applyForce(x, y, z): void            // continuous force
vehicle.applyTorque(x, y, z): void           // rotational torque

// --- AI Control ---
vehicle.setAIControls({ forward, backward, left, right, brake, steer?, throttle?, brakeAmount? }): void

// --- Parking brake (automatic: engaged at spawn/exit, released by first throttle) ---
vehicle.setParkingBrake(engaged: boolean): void
vehicle.isParkingBrakeEngaged(): boolean

// --- Collision Detection ---
vehicle.getChassisBody(): RAPIER.RigidBody | null   // for registerCollisionCallback

// --- Visual ---
vehicle.getChassisGroup(): THREE.Object3D
vehicle.addBodyVisual(object: THREE.Object3D): void

// --- State ---
vehicle.isDriverControlled(): boolean         // true if a player is driving
vehicle.getIsTwoWheeled(): boolean            // motorcycle vs car
vehicle.setAlwaysActive(true): void           // prevent hibernation for AI cars
vehicle.canPlayerEnter(): boolean
vehicle.getMass(): number                     // total mass in kg

// --- Current Control State (read-only) ---
vehicle.getEngineForce(): number
vehicle.getSteering(): number
vehicle.getBrakingForce(): number
vehicle.getMaxEngineForce(): number
vehicle.getMaxBrakingForce(): number
vehicle.getMaxSteering(): number

// --- Physics Internals ---
vehicle.getChassisCollider(): RAPIER.Collider | null   // bodywork only, wheels EXCLUDED
vehicle.getCollisionHalfExtents(): {x,y,z} | null      // bodywork + wheels — use for spacing/clearance

// --- Engine defaults (for racing games) ---
// import { DEFAULT_RACING_CAR_CONFIG, VehicleAutoRightSystem,
//          DEFAULT_VEHICLE_AUTO_RIGHT_OPTIONS,
//          VehicleUnstuckSystem, DEFAULT_VEHICLE_UNSTUCK_OPTIONS } from 'engine/Vehicle.js';
// import { VoxelCarBodyBuilder } from 'engine/builders/index.js';
DEFAULT_RACING_CAR_CONFIG                              // tuned PlatformVehicleConfig (sedan)
VoxelCarBodyBuilder.sedanBody(color)                   // matching voxel sedan body
new VehicleAutoRightSystem(DEFAULT_VEHICLE_AUTO_RIGHT_OPTIONS)  // snaps tilted vehicles upright; required for racing
new VehicleUnstuckSystem(DEFAULT_VEHICLE_UNSTUCK_OPTIONS)       // bumps stuck-together cars apart; required for any race with >1 car
```

## Spawning Vehicles

### Vehicle assets (preferred)

A vehicle asset is a world.json asset whose record carries `vehicleFitment`
(written automatically when a GLB with the `bmVehicle` scene extension is
imported — the design-vehicle tool produces these). `spawnFromAsset` /
`spawnAndEnterFromAsset` read everything from the fitment: platform
width/length, per-axle wheel positions/radii/duals, mass, handling, collision
boxes, and the visual body + wheels. Both are async — await them. Ask the
asset agent to run design-vehicle when a game needs a car and none exists;
never rebuild a box body for a game that has a vehicle asset.

Lights are built and lit automatically — never ask the designer for them. Each
is its own material on the voxel body, so game code can drive it live:
`voxelObject.setSlotEmissive(name, level)` where name is `headlights`,
`taillights`, `beacon` or `beacon2` (beacons need the `lightbar` accessory) and
level is 0 = off, 1 = normal, >1 = strobe. Use it to darken a parked car, brake-
flash the tail lights, or alternate the two beacon banks on an emergency run.

Bodywork shading is a RENDER SETTING, not an asset property. "Make the cars
shiny / glossy / realistic / like real car paint" is one call —
`configure_game(configType="render", vehicleFinish="paint")` (default
`"flat"`). Never regenerate the asset, write a material, or touch code for it.
The cars keep their exact colours, so it needs no exposure compensation.

Material classes ride the bake automatically: cabin glazing bakes as a `glass`
slot, steel accessories (bullbar, roof/ladder racks, roll cage, stacks…) as
`metal`, and the parametric runtime wheels render classed `chrome`/`metal`
rims — all clamped by the engine's material-quality ladder (`?matq=`, Phong on
mobile). A designer spec may additionally set `finish: { trim, accent }`
(chrome|gold|metal|plastic|wood|matte) to class those surfaces — "gold trim"
is a colour AND a finish. Classes only reach newly forged bakes; existing
vehicle assets are unchanged until re-forged.

### `spawnRotation` — yaw convention (READ THIS FIRST)

`spawnRotation` is yaw in radians around +Y. Vehicle local forward is +Z. The four cardinals:

```
                  -Z   (yaw =  Math.PI)
                   |
   (yaw=-π/2) -X --+-- +X  (yaw = Math.PI/2)
                   |
                  +Z   (yaw = 0)
```

Hand-computing yaw from a desired direction is the #1 vehicle-spawn bug — a 90° rotation puts every car sideways across the track. **Prefer the helpers below over raw radians.**

### Do / Don't — common conversions that go wrong

The agent keeps writing `Math.PI` while the comment says "-X" — both are 90° rotations of the world, but they're 90° APART, not the same. Read the table left-to-right:

| What you mean | Forward direction | Correct yaw | Common WRONG yaw |
|---|---|---|---|
| Face east  (+X) | `(+1, 0, 0)` | `Math.PI / 2`  | — |
| Face west  (−X) | `(−1, 0, 0)` | `-Math.PI / 2` | **`Math.PI` ← writes "-X" but yaw means "-Z"** |
| Face south (+Z) | `(0, 0, +1)` | `0`            | — |
| Face north (−Z) | `(0, 0, −1)` | `Math.PI`      | **`-Math.PI / 2` ← writes "-Z" but yaw means "-X"** |

If your comment says one cardinal direction but your yaw constant is `Math.PI` (or `-Math.PI/2`), STOP and re-derive. Better: don't pick a constant at all — `headingTangent(loopCenter, position, 'ccw')` returns the right value for any point on a loop, and `headingToward(from, to)` returns the right value for any pair of points.

```typescript
import { FACE, headingToward, headingTangent } from 'engine/Vehicle.js';

FACE.POS_X / FACE.NEG_X / FACE.POS_Z / FACE.NEG_Z   // cardinal-direction yaw constants
headingToward(from, to)                              // yaw to face `to` from `from`
headingTangent(center, p, 'ccw' | 'cw')              // yaw tangent to a circle at `p`
```

### Examples

```typescript
const spawner = engine.getVehicleSpawner();

// Spawn AI vehicle facing -X
const result = spawner.spawnVehicle({ x: 10, z: 20 }, platformConfig, undefined, FACE.NEG_X);

// Spawn + add voxel body + enter as player (one call), heading toward a waypoint
import { DEFAULT_RACING_CAR_CONFIG } from 'engine/Vehicle.js';
import { VoxelCarBodyBuilder } from 'engine/builders/index.js';

const spawnPos = { x: 0, z: 0 };
const result = spawner.spawnAndEnter(
    spawnPos,
    DEFAULT_RACING_CAR_CONFIG,                       // tuned racing-sedan physics
    VoxelCarBodyBuilder.sedanBody(0xff4400),         // Volvo-240-silhouette voxel body
    playerController,
    headingToward(spawnPos, firstWaypoint),          // self-documenting; never 90° wrong
);
```

### Starting grid on a circular loop

For race grids, never share a single yaw across all slots — the tangent direction varies around the loop. Use `layoutGridOnLoop`, which returns each slot's position AND its tangent heading:

```typescript
const grid = spawner.layoutGridOnLoop({
    center: { x: 30, z: 0 }, radius: 18, travel: 'ccw',
    startAngle: -Math.PI / 2,   // start point: position = center + (cos a, sin a) * R
    slots: 5, laneOffset: 1.5, slotSpacing: 4,
});
for (const slot of grid) {
    spawner.spawnVehicle(slot.position, platformConfig, undefined, slot.heading);
}
```

## AI-Controlled Vehicles

Use `setAIControls()` on non-player vehicles. This bypasses the player-driving check.

`VehicleControls` is `{ forward, backward, left, right, brake }` (all required
booleans) plus three optional analog channels — `steer`, `throttle`, `brakeAmount` —
that override their boolean counterparts when present:

| Field | Type | Meaning |
|-------|------|---------|
| `forward` / `backward` | required boolean | Throttle. Full engine force or none. Overridden by `throttle` when present. |
| `brake` | required boolean | Brake. Overridden by `brakeAmount` when present. |
| `left` / `right` | required boolean | Bang-bang steering. Ignored when `steer` is present. |
| `steer` | optional number | Analog steering in [-1, 1]; **+1 = full left**, -1 = full right. Use this for proportional controllers (racing lines, smooth cornering) instead of `left`/`right`. |
| `throttle` | optional number | Analog throttle in [-1, 1]; **+1 = full forward**, -1 = full reverse. Overrides `forward`/`backward` when present — lets a proportional controller hold a speed instead of bang-bang. |
| `brakeAmount` | optional number | Analog brake in [0, 1]. Overrides `brake` when present. Braking still wins over throttle. |

A proportional controller can pass `throttle` directly instead of gating `forward` — no
need to fake analog control by toggling the boolean on and off. To vary AI speed, pass an
analog `throttle` (see `setAIControls` above) or, for a full speed-holding driver with
arrival easing, use `BasicDrivingComponent`'s `SMOOTH_DRIVING_OPTIONS` (`@docs
vehicle-ai.md`) rather than hand-rolling the throttle math.

```typescript
const aiResult = spawner.spawnVehicle({ x: 10, z: 20 }, platformConfig);
const aiVehicle = aiResult.vehicle;
VoxelCarBodyBuilder.addVoxelBody(aiVehicle, aiResult.platform, VoxelCarBodyBuilder.sedanBody(0x0044ff));
aiVehicle.setAlwaysActive(true);

// In update loop:
const target = getNextWaypoint();
const pos = aiVehicle.getPosition();
const fwd = aiVehicle.getForwardDirection();
const toTarget = new THREE.Vector3(target.x - pos.x, 0, target.z - pos.z).normalize();
const cross = fwd.x * toTarget.z - fwd.z * toTarget.x;

aiVehicle.setAIControls({
    forward: true,
    backward: false,
    left: cross > 0.1,
    right: cross < -0.1,
    brake: false,
});
```

## Vehicle Collision Detection

Use `VehicleCollisionSystem` for automatic collision events between vehicles:

```typescript
import { VehicleCollisionSystem } from 'engine/VehicleCollisionSystem.js';

const collisionSystem = new VehicleCollisionSystem(engine.physicsWorld!, {
    minImpactSpeed: 3.0,   // ignore slow bumps
    cooldownMs: 500,        // prevent spam
    onCollision: (event) => {
        // event.vehicleA, event.vehicleB, event.impactSpeed, event.contactPoint
        const damage = event.impactSpeed * 5;
        applyDamage(event.vehicleA, damage);
        applyDamage(event.vehicleB, damage);
    },
});

// Register all vehicles
collisionSystem.registerVehicle(playerVehicle);
collisionSystem.registerVehicle(aiVehicle1);
collisionSystem.registerVehicle(aiVehicle2);

// In update loop:
collisionSystem.update(deltaTime);

// On dispose:
collisionSystem.dispose();
```

## Entering / Exiting

```typescript
playerController.enterVehicle(vehicle);
playerController.exitVehicle();
playerController.isPlayerInVehicle();
playerController.switchVehicle(otherVehicle);  // atomic exit + enter
playerController.setVehicleExitLocked(true);   // no "Exit vehicle" prompt / E-to-exit
```

For lap-based racing games, don't call `setVehicleExitLocked` directly — use the racing preset, which bundles it with free-mouse mode and the auto-right/unstuck safety systems (details in `@docs mechanic-racing.md`):

```typescript
import { installRacingDefaults, DEFAULT_RACING_SETUP_OPTIONS } from 'engine/Vehicle.js';
const racing = installRacingDefaults(engine, playerController, DEFAULT_RACING_SETUP_OPTIONS);
racing.register(vehicle);   // every spawned vehicle
racing.update(deltaTime);   // each frame
```

## Vehicle Camera Mode

For **top-down racing games**, do NOT change the camera mode. The default `'auto'` keeps the top-down camera and just retargets it to the vehicle. Use `configureVehicleCamera({ distance: 30 })` to zoom out.

Only change the mode for non-top-down games:

```typescript
playerController.setVehicleCameraMode('chase');   // third-person chase (ONLY for third-person games)
playerController.setVehicleCameraMode('cockpit'); // first-person
playerController.setVehicleCameraMode('keep');    // explicit: keep current camera
playerController.setVehicleCameraMode('auto');    // default: auto-detect from world camera mode
```

**IMPORTANT:** Call setVehicleCameraMode BEFORE entering the vehicle. The camera is created on entry.

## Vehicle Camera Configuration

One API works for all camera modes. Call either before or after entering the vehicle -- the config is stored and re-applied whenever the camera is created:

```typescript
// Set distance (zoom in top-down, distance behind in chase)
playerController.configureVehicleCamera({ distance: 25 });

// Then enter vehicle -- config is automatically applied
spawner.spawnAndEnter(...);
```

In **top-down** mode, `distance` controls camera height (higher = more zoomed out).
In **chase** mode, `distance` controls how far behind the car, `height` how high above.

## Controls Extension

```typescript
vehicle.setControlsExtension({
    showJump: true,
    onJump: () => { vehicle.applyImpulse(0, 5000, 0); },
    onUpdate: (keys, dt) => { /* custom per-frame logic */ },
});
```

## PlatformVehicleConfig Options

```typescript
interface PlatformVehicleConfig {
    width: number;           // Platform width in meters
    length: number;          // Platform length in meters
    mass?: number;           // Vehicle mass in kg (default: auto-calculated)
    engineForce?: number;    // Max engine force (default: mass * 1.5)
    wheelRadius?: number;    // Global wheel radius (default: 0.4)
    frontWheels?: { radius, width, suspensionStiffness, suspensionDamping, friction };
    rearWheels?: { radius, width, suspensionStiffness, suspensionDamping, friction };
}
```

For racing games, use the pre-tuned `DEFAULT_RACING_CAR_CONFIG` (exported from `engine/Vehicle.js`) — see `@docs mechanic-racing.md` for the full minimal-setup example.

## Vehicle Handling (top speed, steering, acceleration)

All optional — omit a field and it uses a sensible **size-scaled default** (smaller cars
automatically get a lower top speed and gentler acceleration). Set at spawn via
`config.handling`, or change it at runtime for boosts / upgrades.

```typescript
config.handling = {
    topSpeed?: number;          // m/s hard cap. Default: size-scaled (~28 at full size); set higher for racing
    reverseTopSpeed?: number;   // m/s hard cap when reversing. Default: 45% of topSpeed
    accelerationScale?: number; // drive-force multiplier. Default: size taper (<=1); >1 boosts
    maxSteerAngle?: number;     // degrees at full lock. Default: ~34
    steerSpeed?: number;        // degrees/sec the wheel ramps toward lock. Default: ~229
    steerSpeedFalloff?: number; // higher = steering softens sooner at speed. Default: 0.15
    minSteerAtSpeed?: number;   // 0-1, steering floor at top speed. Default: 0.25
    downforce?: number;         // aero load in x-weight at 30 m/s, rising with speed^2. Default: 1
                                // Keeps a fast car planted and stops it sailing off crests; slow driving is unaffected.
                                // Winged racer 2-3, sports 1.2-1.5, muscle 0.8, kart/truck 0.2-0.4, 0 = floaty stunt jumps.
};

// Runtime — takes effect immediately (speed-boost pickup, incremental upgrade, etc.):
const base = vehicle.getHandling().topSpeed;   // current EFFECTIVE values (degrees, m/s)
vehicle.setHandling({ topSpeed: base * 1.5 }); // merge one or more overrides
vehicle.setHandling({ topSpeed: undefined });  // revert just that field to its default
vehicle.resetHandling();                       // revert ALL overrides to defaults
```

## Repositioning (respawn / reset to track)

```typescript
vehicle.teleportTo({ x, y, z });               // place with velocities zeroed, keep current facing
vehicle.teleportTo(checkpoint.pos, yawRad);    // optional gameplay yaw (+Z forward, radians)
```

This is the ONLY supported way to move a vehicle from game code — do not set the chassis
body's translation/rotation directly (skips yaw-only rotation and keeps old momentum).

### Falling off the map (the kill plane)

The engine rescues the player when they drop below `killPlaneY` (default `-100`). If they are
driving, it acts on the **car**:

| The game has… | What happens to the car |
|---|---|
| a respawn provider | teleported to that point, **player still in it** |
| `lockVehicleExit: true` (racing default) | teleported to the player spawn, **player still in it** |
| neither | player ejected, **car destroyed** — every reference the game holds goes dead |

```typescript
// One call covers both being wedged on scenery and falling off the map:
racing.setRespawnProvider((v) => ({ position: lastCheckpoint(v).pos, heading: lastCheckpoint(v).yaw }));

// Without RacingSetup, set it straight on the controller:
playerController.setVehicleRespawnProvider((v) => ({ position: safeSpot, heading }));

// Move the plane for a world whose terrain reaches below -100:
import { DEFAULT_FALL_RESCUE_OPTIONS } from 'engine/PlayerController.js';
playerController.configureFallRescue({ ...DEFAULT_FALL_RESCUE_OPTIONS, killPlaneY: -500 });

// React BEFORE the engine acts — the vehicle reference is still live here:
playerController.onFallRescue = (e) => {
    if (e.action === 'vehicle-destroyed') raceDirector.abandonRun();  // stop reading that car
};

// Or take the fall over completely — return true and the engine does nothing:
playerController.onFallRescue = (e) => {
    if (!e.vehicle) return;              // on foot: let the engine respawn as usual
    showWastedScreen();
    e.vehicle.teleportTo(lastCheckpoint, heading);
    return true;                          // engine keeps its hands off
};
```

A handler that returns `true` **must** move the player or the vehicle itself — the body is
still below the plane, so the event fires again next frame, and every frame after, until
something moves it.

Do NOT write a per-frame altitude guard in game code to beat the plane to it — set a respawn
provider instead. A game that keeps polling `getPosition()` on a destroyed car reads stale
coordinates forever, which is how a lap clock, checkpoints and the finish line all silently
corrupt at once.

## Critical Rules

1. **NEVER call `_INTERNAL` methods** — they bypass state management.
2. **NEVER manipulate VehicleManager directly** — use PlayerController for enter/exit.
3. **Start from this doc, but read the engine source whenever you need it** — to confirm an exact type or signature, or to understand what a method actually does internally (ordering, side effects, guards, what a field feeds into). `RapierVehicle.ts` and `VehicleManager.ts` are the ground truth when the docs are silent or ambiguous. **Never guess a field name or a behaviour you could have read.**
4. **Type vehicles as `Vehicle` from `engine/Vehicle.js`** so the compiler checks your payloads. Don't weaken that with an `any`/`unknown[]` method signature, an optional-method stand-in, or a try/catch that swallows the call — those turn a wrong payload into a clean compile and a silently dead game.
5. Two ways to drive a non-player vehicle, both valid — pick per game, don't mix on one vehicle:
   - `setAIControls(controls)` — works on any vehicle, no driving state needed. Steering is applied instantly.
   - `updateControls(controls, deltaTime)` — the player's own path, so boolean `left`/`right` get the gradual steering ramp and return rate that `setAIControls` does not apply. A non-zero analog `controls.steer` positions the wheel directly on this path too — only `steer: 0` falls through to the ramp, so releasing a stick unwinds the wheel normally. Both paths share the same size-normalized steer falloff and `minSteerAtSpeed` floor. It is a no-op unless the vehicle is in player-driving state, so it only drives a vehicle the player is actually in.
6. Use `VehicleCollisionSystem` for collision detection — don't build proximity-based workarounds.


## Box-part car bodies

`BoxCarBodyBuilder` assembles a car from positioned boxes. Mark glass parts with
`isWindow` so they render transparent.

```typescript
parts: [
  { position: { x: 0, y: 0.3, z: 0 },   size: { width: 1.8, height: 0.6, length: 3.5 },  color: 0xff0000 },
  { position: { x: 0, y: 0.8, z: 0.2 }, size: { width: 1.6, height: 0.5, length: 1.5 },  color: 0xff0000 },
  { position: { x: 0, y: 0.8, z: 1.0 }, size: { width: 1.4, height: 0.4, length: 0.05 }, color: 0x1a1a44, isWindow: true },
]
```
