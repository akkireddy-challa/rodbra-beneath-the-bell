# Vehicle AI Driving

> **Coordinate convention:** Vehicles use **local +Z forward**, matching the engine's gameplay convention. See `@docs coordinate-system.md` §2 and `@docs vehicle-system.md` for the yaw table. `getForwardDirection()` returns the +Z column transformed.

Use the pluggable driving component system for AI-controlled vehicles. The engine provides `BasicDrivingComponent` which handles steering math, reversing, and stuck recovery, and `VehiclePathDrivingComponent` which drives a `BasicDrivingComponent` along a route planned against the engine's own vehicle nav grid — the one to reach for whenever an NPC needs to drive somewhere and stop. For custom behavior, implement `IVehicleDrivingComponent`. `updateAI(deltaTime)` is the tick that runs whichever component is attached — an AI vehicle that never reaches `updateAI` is not being driven by the engine.

Reference implementation for rivals following a baked track: `samples/racing-setup.ts` (`CenterlineAi`), compile-checked against the live engine.

> **Waypoints from a baked track:** if the track was voxelized with the trimesh-collider option, `getBakedLevel()?.getTrackCenterline(name)` returns a ready road-centered waypoint loop to drive through the loop below — no hand-authoring. See `@docs named-trimesh-query.md`.

## Driving to a destination (non-racing)

For an NPC that drives somewhere and stops — a chauffeur, a delivery van, an
escort, a cutscene car — use `VehiclePathDrivingComponent`. It plans a route
against the engine's global vehicle nav grid (a per-level grid the engine
builds and bakes from the baked ground mask, exposed as `getGlobalVehicleNav()`)

> **No AI vehicles in your game?** Set `worldProfileData.vehicleNavGrid: false` in world.json. The
> grid's bake is a time-sliced collider raycast over every drivable cell, run twice (a revalidation
> sweep follows the first), and on a forged city it steps ~4 ms of most frames for minutes after
> load — 16% of the main thread measured in a shooter that never spawns a vehicle.
and drives a `BasicDrivingComponent` along it, replanning on its own as it
goes. This is THE way to get an NPC from A to B — it replaces hand-rolling a
waypoint list, a route search, and probe-verified string-pulling yourself
(that machinery still exists and is documented under **Low-level driving**
below, for when you don't have or don't want the nav grid):

```typescript
import { VehiclePathDrivingComponent } from 'engine/VehiclePathDrivingComponent.js';
import { getGlobalVehicleNav } from 'engine/nav/VehicleNavGrid.js';
import {
    installVehicleSafety,
    DEFAULT_VEHICLE_SAFETY_OPTIONS,
} from 'engine/VehicleSafetySystems.js';

const safety = installVehicleSafety(DEFAULT_VEHICLE_SAFETY_OPTIONS);
safety.register(vehicle);

const driver = new VehiclePathDrivingComponent();
driver.driveTo(getGlobalVehicleNav(), { x: destX, z: destZ });
driver.setOnArrived(() => {
    vehicle.setParkingBrake(true);
    // show an arrival message, unlock a door, etc.
});
vehicle.setDrivingComponent(driver);
vehicle.setAlwaysActive(true);

// Every frame:
vehicle.updateAI(deltaTime);
safety.update(deltaTime); // ONCE per frame for the whole game, not per NPC
```

`vehicle.setDrivingComponent(driver)` is the ONLY registration this needs.
`VehiclePathDrivingComponent` ticks its OWN inner `BasicDrivingComponent`
itself from inside its `update()` — never call `driver.update()` yourself and
never register anything but `driver` with `setDrivingComponent`, or the car
gets driven twice a frame.

`driveTo(nav, destination, opts?)` takes whatever `getGlobalVehicleNav()`
returns, including `null` — a level with no baked ground mask, or one that
hasn't finished baking its collider-derived nav data yet. A `null` nav
degrades gracefully to a plain straight-line drive at the destination (the
same behavior as calling `driver.setTarget(x, z)` directly), so it's always
safe to call `driveTo` without checking for `null` first.

**Mid-drive redirection with `{ via }`:** pass an ordered list of points the
route must pass through before the destination — "turn left at the next
street" is one via point ~25 m down that street. The car flows through every
via without stopping: no arrival check, no park brake, no `onArrived` fires
at a via, only at the true destination. An unreachable via degrades to
best-effort (the route falls back to a direct drive to the destination)
rather than refusing to drive at all. `via` is ignored when `nav` is `null`.

```typescript
// Redirect an already-driving car through a specific street, still heading
// to the same destination:
driver.driveTo(getGlobalVehicleNav(), destination, { via: [{ x: viaX, z: viaZ }] });
```

Poll `driver.getStatus()` for the HUD or game logic instead of tracking
progress yourself:

```typescript
const status = driver.getStatus();
// status.activity: 'idle' | 'planning' | 'driving' | 'arrived' | 'blocked'
// status.distanceRemaining: metres left along the planned route
// status.arrived: true once parked at the destination
// status.replans: how many times the follower has replanned since driveTo()
// status.inner: the underlying BasicDrivingComponent's own VehicleDrivingStatus
```

`'blocked'` is the follower's own honest "cannot get there" report — it
replans automatically on drift, a dead end, a provisional-plan upgrade once
the collider bake finishes, and a post-bake nav-grid edit, and only gives up
after several replans fail to make progress. Read `status.activity` rather
than polling `status.inner.unreachable` the way hand-rolled drivers do (see
**Knowing when the driver is stuck for good** below) — the follower already
turns that low-level signal into the higher-level `'blocked'` state, probing
before it commits to a full replan so a momentary wedge (another car briefly
in the way) doesn't trigger one.

It also reports `'blocked'` for a car that simply stops covering ground —
several `stallWindowS` windows with under `stallProgressEpsilonM` of progress
along the route, whatever the probe and the inner component think is going
on. A car wedged against terrain a metre off its path has a clear line ahead
of it and keeps nudging enough to look alive to both of them, so "has this
car actually moved" is the only question that catches it. Lower
`stallWindowS` if your game wants to hear about it sooner than the ~50 s the
defaults take.

`stop()` abandons the current route and returns to `'idle'`. The class also
implements the plain `IVehicleDrivingComponent` interface — calling
`setTarget(x, z)` directly on it abandons path-following for that one target
and behaves like a bare `BasicDrivingComponent`, matching any code written
against the generic interface.

The safety bundle (`installVehicleSafety`) is unrelated to routing and always
needed regardless of which driving component you use — see **Low-level
driving** below for the "why one shared bundle, not one per NPC" reasoning.

## Low-level driving

The building blocks `VehiclePathDrivingComponent` is built from, useful
directly when you don't have (or don't want) the global vehicle nav grid — a
level with no baked ground mask, racing AI, formation driving, or a fixed
route you want to hand-author yourself.

### Hand-rolled waypoint driving (BasicDrivingComponent directly)

Construct `BasicDrivingComponent` with `SMOOTH_DRIVING_OPTIONS`, not the
no-argument default:

```typescript
import { BasicDrivingComponent, SMOOTH_DRIVING_OPTIONS } from 'engine/VehicleDrivingComponent.js';

const driving = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
vehicle.setDrivingComponent(driving);
vehicle.setAlwaysActive(true);
```

`new BasicDrivingComponent()` with no argument is tuned for racing — bang-bang
throttle, and stuck-recovery that treats anything under 1.5 m/s as a wedge —
so a car asked to cruise slowly or ease into a stop trips the stuck check and
shuffles forward and back instead of driving smoothly. `SMOOTH_DRIVING_OPTIONS`
switches to analog throttle that holds a town cruise speed and eases to a
crawl on approach, and its recovery only arms when the car is genuinely
wedged (throttle held, not moving), not merely driving slowly.

`setTarget(x, z, isFinal)` takes an optional third argument, `isFinal`
(default `true`), that tells `BasicDrivingComponent` whether this point IS the
destination or just an intermediate waypoint on the way there. This matters
because arrival easing (`slowRadius` / `crawlSpeed`) ramps down based on
distance to WHATEVER POINT `setTarget` was last given — a waypoint follower
that always aims at the next waypoint (typically well inside `slowRadius`,
e.g. an 8m advance radius against a 26m `slowRadius`) would otherwise never
leave the crawl band for the whole route; `cruiseSpeed` would never be
reached. Pass `false` for every intermediate waypoint and `true` (or omit —
`true` is the default) only for the real destination:

```typescript
const target = waypoints[i] ?? destination;
driving.setTarget(target.x, target.z, target === destination);
```

The arrival RADIUS check (braking and holding once inside `arriveRadius`) is
unaffected by `isFinal` either way — a car still brakes and holds when it
reaches whatever target it was given; only the easing RAMP is gated. See
`samples/chauffeur-drive.ts` for the full pattern.

For the safety bundle a non-racing game still needs — auto-righting a flipped
car, splitting welded car-to-car pairs, freeing a car wedged on scenery —
call `installVehicleSafety(DEFAULT_VEHICLE_SAFETY_OPTIONS)` from
`engine/VehicleSafetySystems.js` instead of `installRacingDefaults`, which
also locks vehicle exit and forces free-mouse mode and is wrong outside a race.
Create **one** safety bundle for the whole game and register every vehicle
with it, never one bundle per NPC — car-to-car unwelding only fires when both
cars in a collision are registered in the same bundle, so a bundle per
instance silently drops recovery between two NPCs that hit each other.

Full reference implementation — waypoint-list following, arrival detection,
parking, and a multi-NPC fleet sharing one safety bundle — with all of the
above wired together: `samples/chauffeur-drive.ts` (`ChauffeurDrive`,
`createChauffeurFleet`), compile-checked against the live engine.

### Quick Start — AI cars following waypoints

```typescript
import { BasicDrivingComponent } from 'engine/VehicleDrivingComponent.js';
import type { Vehicle } from 'engine/Vehicle.js';

interface AICar {
    vehicle: Vehicle;
    driving: BasicDrivingComponent;
    waypoints: { x: number; z: number }[];
    currentWaypoint: number;
}

// Setup:
const driving = new BasicDrivingComponent();
driving.maxSpeed = 15; // m/s — vehicle coasts above this, brakes if 20% over
vehicle.setDrivingComponent(driving);
vehicle.setAlwaysActive(true);

const aiCar: AICar = {
    vehicle,
    driving,
    waypoints: [{ x: 20, z: 0 }, { x: 0, z: 20 }, { x: -20, z: 0 }, { x: 0, z: -20 }],
    currentWaypoint: 0,
};

// Update loop (called every frame):
function updateAICar(ai: AICar, deltaTime: number): void {
    const wp = ai.waypoints[ai.currentWaypoint];
    if (!wp) return;

    ai.driving.setTarget(wp.x, wp.z);
    ai.vehicle.updateAI(deltaTime);

    // Advance waypoint when close
    if (ai.driving.isNear(wp.x, wp.z, 5)) {
        ai.currentWaypoint = (ai.currentWaypoint + 1) % ai.waypoints.length;
    }
}
```

### Putting a stuck AI back on its route

The safety bundle recovers a car WHERE IT LANDED. For an AI following a fixed
line — a race track centerline, a patrol loop, a rally stage — that leaves the
actual failure untouched: the car is upright and free, but its pursuit target
is still a waypoint it can no longer reach, so it drives away from the route or
grinds against whatever it was shunted over. Register the vehicle WITH its
route and the engine adds the missing half:

```typescript
safety.register(vehicle, {
    // `points` is the same waypoint array the AI steers along; `targetIndex`
    // is this car's own progress, so a rejoin only ever moves it FORWARD.
    route: (v) => ({
        points: waypoints,
        targetIndex: progressOf(v),
        loop: true,                  // false for a point-to-point stage
        corridorHalfWidth: 8,        // how far off the line still counts as on-route
    }),
    onRejoined: (v, index) => { setProgressOf(v, index); },
});
```

The second argument is optional and inert without it — a vehicle registered the
old way behaves exactly as before. When it IS given, the car is put back on the
nearest FORWARD centerline point, faced at the next one (`headingToward`), its
velocity zeroed by `teleportTo`, and its driving component re-aimed at that
next point as an intermediate target. It triggers only after
`VehicleStuckSystem` runs out of nudges (taking precedence over
`setRespawnProvider`, which gives a position but nothing about follower
progress) or after the car has been outside `corridorHalfWidth` for
`offRouteGraceSeconds` (default 3) — a wide line or a self-correcting spin is
never touched, and neither is a car with no driving component (the player's).
`setStuckDetectionEnabled(false)` suspends the corridor watch along with the
other detectors. Tune via `VehicleSafetyOptions.route` /
`RacingSetupOptions.route` (`DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS`).

`VehiclePathDrivingComponent` does not need this — it replans against the nav
grid on its own. This is for hand-rolled followers driving a fixed line.

### Knowing when the driver is stuck for good

`VehiclePathDrivingComponent` (above) already turns this into the
higher-level `'blocked'` activity — read this section when you're driving
`BasicDrivingComponent` directly, or writing your own follower on top of it.

`BasicDrivingComponent` never gives up on its own — recovery escalates the
reverse burst up to `burstMaxDuration` and then repeats forever, re-aiming at
the same point. Poll `getDrivingStatus()` to notice:

```typescript
const status = driving.getDrivingStatus();
if (status.unreachable) {
    // No meaningful progress for `noProgressTimeout` seconds (default 8).
    // Re-plan the route, skip the waypoint, or tell the player.
}
```

`VehicleDrivingStatus` also carries `secondsWithoutProgress`, `bestDistance`
(the closest this driver has been to its current target) and
`failedRecoveries` (consecutive reverse bursts that did not clear the
obstacle).

The watchdog measures progress toward a STATIONARY target: it resets whenever
`setTarget` is given different coordinates, so a pursuit that re-aims every
frame never trips it. `unreachable` means "this driver is not getting there",
not "no route exists" — a wedged car and a car whose target sits inside a
building look identical from here. Set `noProgressTimeout: 0` to disable.

### Asking whether the car can get there

`VehiclePathDrivingComponent` (above) already calls this itself, at planning
time and again as a recovery-gated check before every replan — read this
section only if you're building your own route search or hand-rolled
follower rather than using it.

Route planning off the ground-material mask alone drives cars into things. The
mask stores material with no elevation, and `getBakedSurfaceHeightAt` skips prop
instances — so kerbs, lampposts, trees and buildings are all invisible to it.
`probePath` asks the physics world instead, which sees the static ones:

```typescript
const check = vehicle.probePath(fromX, fromZ, toX, toZ);
if (!check.passable) {
    // check.reason: 'step' (kerb/ledge) | 'obstacle' (prop or wall) | 'gap' (hole)
    // check.blockedAt: how far along the segment the car can actually GET —
    //                  in front of the kerb, never on top of it, so it is safe
    //                  to trim a leg to this distance
    // check.peakGrade: steepest rise/run seen — 'barely too steep' vs 'a wall'
}
```

Use it to validate each straight leg of a route, not just the endpoints: a
waypoint pair the car cannot drive between is the usual cause of a car that
grinds against scenery.

`vehicle.getMaxClimbGrade()` and `vehicle.getFootprint()` are the same numbers
`probePath` uses. Ask for them rather than hardcoding a slope limit — a 1.5 N/kg
compact and a rally car do not agree about what a hill is.

**Probe only when the colliders are there.** This is the caveat that bites
first. Baked maps create their map colliders *disabled* and switch them on about
15 frames after load, and voxel worlds of 64 m or more disable terrain and
environment colliders outside the physics radius. A route search run at init
gets `'gap'` for every leg, and — worse — a building whose chunk is culled reads
as **clear road**, a silent wrong pass. Plan after the world is live, and only
over ground that is inside `physicsDistance` of the car.

It does not see shoveable **dynamic props** (crates, barrels): they are not
queried, on purpose — a car pushes them aside, so routing around them would
reject good roads. Gates that open, cars that park later and bridges that spawn
are invisible for the same reason: the probe reports the static world at the
instant you ask.

**Planning-time only.** A 20 m segment costs about 20 raycasts plus 20 shape
casts (up to 40 raycasts over ground far above or below the car, where each
sample needs a second, higher ray): fine for the few thousand calls a route
search makes at load, wrong to call every frame. For per-frame trouble, poll
`getDrivingStatus()` instead — plan with the probe, drive with the watchdog.

## API Reference

### VehiclePathDrivingComponent (nav-grid path follower)

| Member | Description |
|--------|-------------|
| `new VehiclePathDrivingComponent(options?)` | `options` defaults to `DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS` (look-ahead, cornering, and replan tuning, plus the inner `BasicDrivingComponent`'s own options — `SMOOTH_DRIVING_OPTIONS` by default). Owns and ticks its own inner `BasicDrivingComponent`. |
| `driveTo(nav, destination, opts?)` | Start (or restart) driving to `{ x, z }`. `nav` is whatever `getGlobalVehicleNav()` returns, including `null` (degrades to a plain straight-line drive). Planning happens lazily on the first `update()`. `opts.via` (optional, ignored when `nav` is `null`): ordered points the route is forced through before the destination, followed as one continuous path with no stopping at a via — see "Mid-drive redirection with `{ via }`" above. |
| `setOnArrived(cb)` | Fired once, the frame the car settles at the destination after the parking brake is automatically set by the component (the class, not the callback, sets it — see the example above). Pass `null` to clear. |
| `getStatus()` | Returns `{ activity, distanceRemaining, arrived, replans, inner }` — see below. |
| `stop()` | Abandon the current route/target and return to `'idle'`. |
| `setTarget(x, z, isFinal?)` / `isNear(...)` / `yieldThrottle(...)` | The plain `IVehicleDrivingComponent` surface (see below) — `setTarget` bypasses path-following for that one call, behaving like a bare `BasicDrivingComponent`. |

`getStatus().activity` (`VehiclePathActivity`): `'idle'` (no `driveTo` call
yet, or `stop()`), `'planning'` (finding a route — usually resolves within the
same frame), `'driving'`, `'arrived'`, `'blocked'` (replanning has
repeatedly failed to make progress). `getStatus().inner` is the wrapped
`BasicDrivingComponent`'s own `VehicleDrivingStatus` — see **Knowing when the
driver is stuck for good** above for what it carries.

### VehicleNav / getGlobalVehicleNav()

| Member | Description |
|--------|-------------|
| `getGlobalVehicleNav()` | From `engine/nav/VehicleNavGrid.js`. Returns the current level's `VehicleNav`, or `null` if none is built yet (no baked ground mask, or too early in level load). This is what you pass to `driveTo`. |
| `nav.findVehiclePath(from, to, opts?)` | A* over the nav grid. Returns a `VehicleNavPath`: `{ points, reachedDestination, shortfall, provisional, method }` — `points` is a dense polyline (no leg longer than 25 m) whose corners are rounded to the largest arc the grid allows, so a follower reading curvature off it sees a corner's real radius instead of a zero-radius kink, `shortfall` is metres short of `to` when the search couldn't fully connect, and `provisional` means the answer came back before the collider bake finished (accurate cost-wise, but not yet confirmed against real geometry). `VehiclePathDrivingComponent` calls this for you; call it directly only if you're building your own follower. |
| `nav.isFullyBaked()` | Whether the per-level collider bake that fills in real ground heights/obstructions has finished. A route found before this is `provisional`. |
| `nav.getRevision()` | Bumped whenever the grid changes (bake progress, a ground-type edit). `VehiclePathDrivingComponent` uses this to know when to replan after the world changes under a car already driving. |

### On Vehicle (RapierVehicle)

| Method | Description |
|--------|-------------|
| `setDrivingComponent(comp)` | Set the AI driving component (or null to remove) |
| `getDrivingComponent()` | Get the current driving component |
| `updateAI(deltaTime)` | Tick the driving component. Call each frame for AI vehicles. |
| `probePath(fromX, fromZ, toX, toZ)` | Can this vehicle drive that straight segment? Returns `{ passable, reason, blockedAt, peakGrade }` — see "Asking whether the car can get there". Planning-time only, and only once map colliders are live and within the physics radius. |
| `getFootprint()` | The vehicle's real collision extents `{ width, height, length }` in metres — the union of every collision box, so `height` is the roof, not the platform slab. |
| `getMaxClimbGrade()` | Steepest rise/run this vehicle can climb, as an absolute grade. Derived from total driven-wheel force vs. weight (or the asset's `maxClimbGrade`). Ask instead of hardcoding a slope limit. |
| `setAIControls(controls)` | Low-level: `{ forward, backward, left, right, brake }` — the five required booleans — plus optional analog overrides: `steer` in [-1, 1] (+1 = full left, overrides `left`/`right`), `throttle` in [-1, 1] (+1 = full forward, overrides `forward`/`backward`), and `brakeAmount` in [0, 1] (overrides `brake`). Prefer analog `throttle`/`brakeAmount` over the booleans for anything that should hold a speed or arrive smoothly — see `BasicDrivingComponent`'s `SMOOTH_DRIVING_OPTIONS` below. See `@docs vehicle-system.md`. |

### IVehicleDrivingComponent interface

```typescript
interface IVehicleDrivingComponent {
    update(deltaTime: number, vehicle: Vehicle): void;
    /** isFinal (optional, default true): destination vs. intermediate waypoint — see below. */
    setTarget(x: number, z: number, isFinal?: boolean): void;
    stop(): void;
    isNear(x: number, z: number, radius: number): boolean;
    /** Optional: coast (no throttle, keep steering) for `seconds`. Used by
     *  RacingSetup after splitting a welded pair so the ramming car backs off
     *  instead of re-welding within a second. */
    yieldThrottle?(seconds: number): void;
}
```

### BasicDrivingComponent behavior

- **`maxSpeed`** (m/s, default 0 = unlimited): coasts when above this speed, gently brakes when 20% over
- **Target ahead or to the side:** drives forward, steers toward target
- **Target far behind (>8m):** drives forward with full steering lock (U-turn)
- **Target close behind (<=8m):** reverses with inverted steering
- **Stuck (speed < 1.5 m/s for > 1s):** reverse burst for 1s, then resumes — this is the **default** recovery, tuned for racing where any car under 1.5 m/s really is in trouble. It is configurable via `BasicDrivingRecoveryOptions`. A game whose cars deliberately drive slowly (a chauffeur easing to a stop, a car holding a low cruise) must use `SMOOTH_DRIVING_OPTIONS` below, or the default recovery will misread ordinary slow driving as stuck and the car will shuffle forward and back forever.

## Custom Driving Component

When `BasicDrivingComponent` doesn't fit (e.g., aggressive ramming, speed limits, formation driving), implement `IVehicleDrivingComponent`:

```typescript
import type { IVehicleDrivingComponent } from 'engine/VehicleDrivingComponent.js';
import type { Vehicle } from 'engine/Vehicle.js';

class AggressiveDriver implements IVehicleDrivingComponent {
    private targetX: number | null = null;
    private targetZ: number | null = null;

    setTarget(x: number, z: number): void { this.targetX = x; this.targetZ = z; }
    stop(): void { this.targetX = null; this.targetZ = null; }
    isNear(x: number, z: number, radius: number): boolean {
        // ... distance check using vehicle position
    }

    update(deltaTime: number, vehicle: Vehicle): void {
        if (this.targetX === null || this.targetZ === null) {
            vehicle.setAIControls({ forward: false, backward: false, left: false, right: false, brake: true });
            return;
        }
        // Custom steering logic here — use vehicle.getPosition(), getForwardDirection(), getSpeed()
        // Call vehicle.setAIControls({ forward, backward, left, right, brake })
        // For proportional steering add `steer` ([-1, 1], +1 = full left) — it
        // overrides left/right. `forward: true` is what produces engine force.
    }
}

vehicle.setDrivingComponent(new AggressiveDriver());
```

Read `engine/VehicleDrivingComponent.ts` (BasicDrivingComponent source) as a reference for the steering math.

## Steering Math Reference

For manual steering calculations (custom components), the correct cross product for XZ-plane:

```typescript
const fwd = vehicle.getForwardDirection(); // vehicle-local +Z transformed (matches the engine's +Z gameplay forward convention — see @docs coordinate-system.md §2)
const pos = vehicle.getPosition();
const toTargetX = targetX - pos.x;
const toTargetZ = targetZ - pos.z;

// Normalize in XZ
const dist = Math.sqrt(toTargetX * toTargetX + toTargetZ * toTargetZ);
const dirX = toTargetX / dist;
const dirZ = toTargetZ / dist;
const fwdX = fwd.x; // already normalized-ish, flatten Y
const fwdZ = fwd.z;

const cross = fwdZ * dirX - fwdX * dirZ;
// cross > 0 → target is LEFT  → setAIControls({ left: true })
// cross < 0 → target is RIGHT → setAIControls({ right: true })

const dot = fwdX * dirX + fwdZ * dirZ;
// dot > 0 → target is ahead
// dot < 0 → target is behind
```
