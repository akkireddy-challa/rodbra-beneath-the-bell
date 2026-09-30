# Moving Platforms & Mechanisms

Elevators, lifts, moving platforms, sliding doors, conveyors, spinners, pendulums, crushers, and crumbling floors are all kinematic mechanisms. There are two ways to create one — **prefer the data-driven way**:

## PREFERRED: data-driven mechanisms (world.json `mechanisms[]`)

Add an entry to the top-level `mechanisms` array in world.json and the ENGINE spawns and runs it — **no game code at all**. Data-driven mechanisms are first-class citizens: the user can select them in the creator editor, see their parameters, edit them live, and the edits PERSIST. A mechanism hardcoded in `.ts` is frozen — users cannot tune it without another AI round-trip. **Only write a code mechanism when the behavior cannot be expressed as data** (paths computed at runtime, triggers tied to game events, scripted sequences).

```jsonc
{
  "mechanisms": [
    { "id": "spinner_1", "type": "spinner", "name": "Ravine spinner",
      "position": { "x": 192, "z": 109 },                 // y omitted = resolved on the ground
      "params": { "angularSpeedRad": 1.4, "aboveGround": 0.9, "size": { "x": 4.6, "y": 0.4, "z": 0.7 } } },
    { "id": "ferry_1", "type": "movingPlatform",
      "params": { "waypoints": [{ "x": 10, "z": 5 }, { "x": 30, "z": 5 }], "speed": 2.2,
                   "aboveGround": 1.5, "size": { "x": 3.2, "y": 0.5, "z": 3.2 } } },
    { "id": "blade_1", "type": "pendulum", "position": { "x": 50, "z": 20 },
      "params": { "armLength": 3.4, "periodS": 2.2, "amplitudeDeg": 55, "swingYawDeg": 90, "pivotHeight": 4.6 } },
    { "id": "stomp_1", "type": "crusher", "position": { "x": 60, "z": 20 },
      "params": { "topClearance": 2.6, "floorGap": 0.15, "slamSpeed": 8, "riseSpeed": 2, "dwellS": 0.9 } },
    { "id": "belt_1", "type": "conveyor", "position": { "x": 70, "z": 20 },
      "params": { "surfaceVelocity": { "x": 2.5, "z": 0 }, "size": { "x": 12, "y": 0.4, "z": 3 } } },
    { "id": "crumble_1", "type": "crumbling", "position": { "x": 80, "z": 20 },
      "params": { "topAboveGround": 3, "breakAfterS": 0.7, "respawnAfterS": 3 } }
  ]
}
```

- `id` must be unique (edits persist by id); `name` is the editor display name.
- Coordinates are WORLD-space. Omit `y` (or a waypoint's `y`) to ground-resolve it, offset by `aboveGround`.
- `movingPlatform` also accepts `returnSpeed`, `dwellS`, `loop` (`pingpong`/`loop`/`once`), `trigger` (`always`/`proximity`/`key`), `proximityRadius`.
- `spinner` also accepts `shape` (`box`/`cylinder`/`sphere`) for blade bars / rolling logs / boulders.
- All mechanisms have real colliders: they carry riders and physically push/fling anyone they sweep into.

Editing world.json is the ASSET side's job — add/edit entries with the world-edit CLI (`exec node bin/world-edit.mjs mechanism upsert --json '{...}'`, see `@docs world-edit-cli.md`). The coding agent should not create these in `.ts`.

## Custom mechanisms: new behaviors and looks, still data-configurable

Data and code are two DIMENSIONS, not alternatives. The decision tree:

1. **Standard hazard, standard look** ("add a spinner") → a `mechanisms[]` entry. Nothing else.
2. **Standard behavior, custom look** ("a spinner with sword blades", "a 3-blade spinner") →
   the coding agent builds the visual (asset meshes / multiple bars) and drives it, but ALL
   tunables come from a `mechanisms[]` entry (open `type` string, e.g. `"bladeSpinner"`).
3. **Custom behavior or a brand-new hazard type** ("a spinner that stops when it hits the
   player") → same: code implements the behavior; the entry holds the numbers.

The contract for cases 2-3 (`MechanismSystem` on the engine):

```ts
const registry = this.engine.getMechanismSystem?.();
const spec = registry?.getSpec('blade_spinner_1');          // the world.json entry
const speed = Number(spec?.params?.angularSpeedRad ?? 1.2); // config comes from DATA
// ...build the custom mechanism from spec.params...
registry?.registerCustom('blade_spinner_1', rootObject, {   // bind for the editor
  angularSpeedRad: { min: -8, max: 8, step: 0.05, display: 'degPerSec', apply: v => { this.speed = v; } },
  stopOnHitS:      { min: 0, max: 10, step: 0.5, apply: v => { this.stopDuration = v; } },
});
```

`registerCustom` gives the object the same editor treatment as engine-built mechanisms:
selecting it shows its name and parameters, edits clamp + apply live via your callbacks, and
every change persists into the entry's `params` automatically. **Every tunable number MUST live
in the entry's `params` and be registered — never as a code literal.** The orchestrator plans the
entry (asset side) and the custom class (coding side) together; the shared `id` links them.

## Code mechanisms: `KinematicPlatform`

For behavior data can't express, the engine class is the fallback — **never build a mover from `setNextKinematicTranslation()` primitives, and never a visual-only mesh with a distance check**.

**Riders are carried by the engine.** The movement motor detects the kinematic body a character stands on and replays its per-frame motion onto them: position sweeps with the surface (including the tangential sweep of a rotation), facing turns with a spin, and jumping off inherits the platform's velocity. This works for ANY kinematic body — `KinematicPlatform` or your own. **NEVER move or rotate the rider yourself** (no `setTranslation` on the player body, no manual "carry" math): the engine already does it, and a manual carry fights the character controller and freezes player input.

**Sweepers push the player.** A kinematic collider that moves INTO the player (a spinner arm, a sweeping bar, a closing door) physically shoves them along its motion — the engine handles it. So for a "spinning obstacle that knocks the player around", a `KinematicPlatform` with `angularSpeed` and a real collider is enough; add game logic (damage, knockback burst via `playerController.applyKnockback(...)`) on top only for the extra kick. A visual-only mesh with a distance check does NOT push — the obstacle must have a kinematic body.

### Using `KinematicPlatform` in code

```typescript
import * as THREE from 'three';
import { KinematicPlatform, DEFAULT_KINEMATIC_PLATFORM_OPTIONS } from 'engine/KinematicPlatform.js';

// Elevator between floor 0 and floor 10, called with the E key.
const elevator = new KinematicPlatform(engine, {
    ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
    waypoints: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 10, 0)],
    speed: 3,
    trigger: 'key',
    keyBindings: { up: null, down: null, toggle: 'KeyE' },
});

// In your Game.update(deltaTime):
elevator.update(deltaTime);

// When the game is torn down:
elevator.dispose();
```

`KinematicPlatform` handles the full pattern for you: it creates the `kinematicPositionBased` body, a cuboid collider on `CollisionGroup.ENVIRONMENT` (so the player can stand on it), a default box mesh, the waypoint interpolator, and the per-frame `setNextKinematicTranslation()`/`setNextKinematicRotation()` calls.

### Options

| Option | Type | Purpose |
|--------|------|---------|
| `waypoints` | `THREE.Vector3[]` | Ordered world-space path. At least 2 entries — or exactly 1 for a stationary spinner (`angularSpeed`), a pendulum pivot (`pendulum`), or a parked conveyor (`surfaceVelocity`). |
| `speed` | `number` | Travel speed in m/s. |
| `angularSpeed` | `number` | Continuous spin about Y in rad/s (sign sets direction). Default `0`. |
| `loop` | `'loop' \| 'pingpong' \| 'once'` | Behavior at the end of the path. Default `'pingpong'`. |
| `trigger` | `'always' \| 'proximity' \| 'key'` | What activates waypoint travel. Default `'always'`. Spin runs regardless. |
| `keyBindings` | `{ up, down, toggle }` | `KeyboardEvent.code` values for `trigger: 'key'`. `up`/`down` drive while held; `toggle` flips an auto-drive flag. |
| `proximityRadius` | `number` | Meters; only used when `trigger === 'proximity'`. |
| `size` | `THREE.Vector3` | Collider/mesh dimensions when no `mesh` override is supplied. Default `2 × 0.25 × 2`. |
| `mesh` | `THREE.Object3D \| null` | Optional visual override. Collider is sized from its bounding box. |
| `shape?` | `'box' \| 'cylinder' \| 'sphere'` | Collider/default-mesh shape. `cylinder` lies along local X (rolling logs, blade bars: length `size.x`, radius `max(size.y, size.z)/2`), `sphere` for boulders (radius `size.x/2`). Default `'box'`. |
| `dwellS?` | `number` | Pause (s) at each end of the run — crusher telegraphs, piston rests. Default `0`. |
| `returnSpeed?` | `number` | Speed for the backward leg of a pingpong (toward `waypoints[0]`). A crusher slams at `speed` and rises at `returnSpeed`. Defaults to `speed`. |
| `pendulum?` | `{ armLength, periodS, amplitudeDeg, swingYawDeg, phaseDeg }` | Swing mode: the body becomes a bob hanging `armLength` below `waypoints[0]` (the pivot), swinging `amplitudeDeg` each way with period `periodS`; the bob displaces along world yaw `swingYawDeg` and tilts with the arm. Swinging blades / wrecking balls. Exactly 1 waypoint; mutually exclusive with `angularSpeed`. |
| `surfaceVelocity?` | `{ x, z } \| null` | Conveyor belt: the body stays parked, but characters standing on it are transported at this velocity (jump-off inherits it). |
| `name?` | `string` | Editor display name (mesh.name). Auto-derived from the kind when omitted — never leave hazards reading "Unnamed" in the editor. |
| `editorData?` | `Record<string, unknown> \| null` | Extra key/values shown in the editor's object inspector (what feature it belongs to, where its params live). |

The base fields are required — spread `DEFAULT_KINEMATIC_PLATFORM_OPTIONS` and override the ones you care about; the `?` fields are optional extras.

### Common recipes

```typescript
// Shuttle platform sliding back and forth continuously.
new KinematicPlatform(engine, {
    ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
    waypoints: [new THREE.Vector3(-5, 1, 0), new THREE.Vector3(5, 1, 0)],
    speed: 2,
    trigger: 'always',
    loop: 'pingpong',
});

// Conveyor belt: parked body, riders drift along it at 2.5 m/s.
new KinematicPlatform(engine, {
    ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
    waypoints: [new THREE.Vector3(0, 0.5, 0)],
    size: new THREE.Vector3(12, 0.4, 3),
    surfaceVelocity: { x: 2.5, z: 0 },
});

// Swinging blade (castle axe): pivot 5 m up, 3 m arm, 2.2 s period.
new KinematicPlatform(engine, {
    ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
    waypoints: [new THREE.Vector3(0, 5, 0)], // the PIVOT
    speed: 0,
    pendulum: { armLength: 3, periodS: 2.2, amplitudeDeg: 55, swingYawDeg: 90, phaseDeg: 0 },
    size: new THREE.Vector3(0.5, 1.2, 0.4),
});

// Crusher/stomper: slams down fast, rests, rises slow.
new KinematicPlatform(engine, {
    ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
    waypoints: [new THREE.Vector3(0, 3.9, 0), new THREE.Vector3(0, 0.9, 0)],
    speed: 8, returnSpeed: 2, dwellS: 0.9,
    size: new THREE.Vector3(2.4, 1.4, 2.2),
});

// Spinning platform (Crash-style ride-the-spinner): stationary, rotates about Y.
new KinematicPlatform(engine, {
    ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
    waypoints: [new THREE.Vector3(10, 3, 20)],
    angularSpeed: Math.PI / 5, // one revolution every 10 s
    size: new THREE.Vector3(8, 0.5, 8),
});

// Pressure-plate lift: rises while the player is near, pauses otherwise.
new KinematicPlatform(engine, {
    ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
    waypoints: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 6, 0)],
    speed: 2,
    trigger: 'proximity',
    proximityRadius: 4,
    loop: 'pingpong',
});

// Sliding door: opens once, stays open.
new KinematicPlatform(engine, {
    ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
    waypoints: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(3, 1, 0)],
    speed: 4,
    trigger: 'proximity',
    proximityRadius: 2,
    loop: 'once',
    size: new THREE.Vector3(0.2, 2, 2),
});
```

---

## Advanced: raw kinematic bodies

Only reach for this if `KinematicPlatform` cannot express what you need (e.g. orbital paths, non-linear easing, rotation about a non-vertical axis).

1. **Body type:** `RAPIER.RigidBodyDesc.kinematicPositionBased()`.
2. **Collision group:** one the player can stand on — `CollisionGroup.ENVIRONMENT`, `DYNAMIC_PROP`, `VEHICLE`, `DEBRIS`, or `TERRAIN`.
3. **Update each frame:** call `setNextKinematicTranslation(newPos)` / `setNextKinematicRotation(newRot)` — NOT `setTranslation()`, which teleports without computing velocity for collision resolution. Calling from `Game.update()` is correct (it sets the pose for the next frame's physics step).
4. **Visual sync:** copy the pose to the mesh.
5. **Do NOT touch the rider.** Rider carry (position + facing + jump-off momentum) is handled by the engine's movement motor for any kinematic body. Note: facing carry follows rotation about Y only; a rider on a platform spinning about a horizontal axis keeps their world facing.

### Dynamic platforms

If the platform is a **dynamic** rigid body (pushed by forces or driven by velocity), the player is not pose-carried; standing on one behaves like standing on any moving obstacle. Prefer kinematic bodies for anything the player should ride.
