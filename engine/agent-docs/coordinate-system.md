# Coordinate System, Forward Direction, and Rotation

This is the canonical reference for axis, forward, yaw, and rotation conventions in the engine. Read this before writing any movement, rotation, lookAt, spawn-offset, or camera math.

The engine straddles **two distinct "forward" conventions** that come from Three.js itself. Both are correct and both appear in real code. The first job of this doc is to teach you to recognize which one you're in.

---

## 1. The two-convention reality

| Layer | "Forward" is | Why |
|---|---|---|
| **Gameplay objects** (players, NPCs, vehicles, characters, props, glTF/VXL assets) | local **+Z** | `Object3D.getWorldDirection()` returns the local +Z column transformed to world space. glTF spec also defines model "front" as +Z. `WalkingAndJumpingMovement` sets `player.rotation.y = atan2(moveDir.x, moveDir.z)` so that the player's local +Z column lines up with motion direction. |
| **Cameras** | local **−Z** | `Camera.getWorldDirection()` overrides the base and negates — cameras look down −Z by default. `ThirdPersonCamera.getForwardVector()` and `TopDownCamera.getForwardVector()` both return world-space −Z. |

The engine is internally consistent: the camera reconciles the two conventions for you (e.g. `ThirdPersonCamera.applyAutoFollow` adds `+ Math.PI` when converting between player forward and camera theta). New code that follows the cheat sheet below stays consistent.

**Shared baseline both conventions agree on:**

- Right-handed coordinate system. Axes: **+X right, +Y up, +Z toward the viewer.**
- `right = forward × up` and `up = +Y` is constant.
- Positive `rotation.y` rotates a vector under the Three.js Y matrix:

  ```
  R_y(θ) · v   where   R_y = | cos θ   0   sin θ |
                             |   0     1    0    |
                             | −sin θ  0   cos θ |
  ```

  So `R_y(θ) · (0,0,1) = (sin θ, 0, cos θ)` and `R_y(θ) · (0,0,-1) = (-sin θ, 0, -cos θ)`.

---

## 2. Cheat sheet — yaw ↔ direction (+Z gameplay convention)

This is the convention you want when writing **player, NPC, vehicle, or character** code. It matches `WalkingAndJumpingMovement`, `Spawner`, `Object3D.getWorldDirection()`, and glTF authoring.

Yaw 0 ⇒ local +Z column points along world +Z (i.e. character "facing" +Z).

| Direction in entity local frame | World vector at yaw θ |
|---|---|
| forward (+Z) | `( sin θ, 0,  cos θ)` |
| backward (−Z) | `(−sin θ, 0, −cos θ)` |
| **right** (local **−X**) | `(−cos θ, 0,  sin θ)` |
| **left** (local **+X**) | `( cos θ, 0, −sin θ)` |
| up (+Y) | `(0, 1, 0)` constant |

⚠ **An entity facing +Z has its right hand on local −X, not +X** — `right = forward × up = (0,0,1) × (0,1,0) = (−1,0,0)`. This is the opposite of the camera table below, and it is the single most common sign bug in AI steering: `fwd.x*to.z − fwd.z*to.x` is "how far the target lies to my **left**". Steer-toward-target code wants the other sign:

```ts
// +ve ⇒ target is to the entity's LEFT ⇒ steer left
const cross = fwd.z * to.x - fwd.x * to.z;
```

**Inverse — facing direction → yaw:**

```ts
const yaw = Math.atan2(facing.x, facing.z);
```

This is exactly what `WalkingAndJumpingMovement.ts` uses to derive `targetRotation` from `moveDirection`. No sign flips. To make a character face a target, point its `rotation.y` at `atan2(target.x - self.x, target.z - self.z)`.

### 2b. Camera convention (−Z forward)

This is the convention for **camera math** only. Yaw 0 ⇒ camera looks toward −Z.

| Direction | World vector at yaw θ |
|---|---|
| forward (−Z) | `(−sin θ, 0, −cos θ)` |
| backward (+Z) | `( sin θ, 0,  cos θ)` |
| right (+X) | `( cos θ, 0, −sin θ)` |
| left (−X) | `(−cos θ, 0,  sin θ)` |

**Inverse:** `yaw = Math.atan2(-forward.x, -forward.z)`.

`ThirdPersonCamera.getForwardVector()` returns the row 1 vector; `TopDownCamera.getForwardVector()` does the same. Note the camera's right is local **+X** — the **opposite** world direction from a gameplay entity at the same yaw, because the two conventions' forwards are 180° apart. Never reuse a "right" vector across the two layers.

### 2c. Tilt — rotation about X or Z

Yaw is the safe axis; **tilt is where signs get inverted**, because the right-hand rule sends one end of the object down, and "positive = up" is the intuitive-but-wrong reading. Both conventions agree here (tilt has nothing to do with forward):

| Rotation | Which end rises | Which end drops |
|---|---|---|
| positive about **X** | −Z end | **+Z end** |
| positive about **Z** | **+X end** | −X end |

So a slab you want to slope *up toward +Z* needs a **negative** X rotation. Mirrored pairs (the two halves of a pitched roof, a pair of buttresses) need **opposite** signs, and the half on the −Z side takes the positive one.

**Prefer a shape that has no sign to get wrong.** In the world-forger primitive DSL, pitched roofs and ramps are the `wedge` part (ridge at the top along an explicit `ridgeAxis`), never two tilted boxes — every hand-derived gable in the forged games got the sign backwards and produced an upside-down valley roof that no validator can see.

---

## 3. Mouse-look and input-rotation sign rule

Dragging the mouse to the right should turn the character/camera to its right. Working through the right-handed Y rotation: positive yaw rotates `+Z → +X` (and equivalently `−Z → −X`). For a gameplay entity at yaw 0 facing +Z, the entity's own right is `+Z × +Y = −X` — so positive yaw tips facing toward +X, which is to its left. The same calculation for a camera facing −Z gives positive yaw tipping facing toward −X, also its left. **Both conventions agree: increasing yaw is a left turn. Decrement yaw to turn right on right-drag:**

```ts
yaw -= deltaX * sensitivity;   // mouse right  → turn right
pitch -= deltaY * sensitivity; // mouse down   → look down (depending on invert pref)
```

A stray `+=` here is the most common cause of "rotation feels backwards."

(The +π reconciliation in `ThirdPersonCamera.applyAutoFollow` is independent of this — it's about which orbit angle puts the camera *behind* the player, not which direction yaw turns.)

---

## 4. Rapier physics interop

- Rapier is right-handed; its quaternions are wire-compatible with `THREE.Quaternion`. Copy quaternions directly — **do not multiply in a 180° flip** when syncing a Rapier body to a Three.js `Object3D`.
- Rapier has **no opinion about "forward."** Orientation semantics live on the rendering side.
- Linear velocity is in world space. If you have input in camera-local space ("WASD relative to camera"), convert it through `ThirdPersonCamera.getForwardVector()` / `getRightVector()` before setting the rigid body velocity.
- Angular velocity around Y in Rapier follows the same right-handed sign as Three.js.

---

## 5. Canonical APIs (use these, do not reinvent)

- **`Object3D.getWorldDirection(target)`** — Three.js built-in. Returns the object's local **+Z** column transformed into world space. For a player/NPC/vehicle, this is the visible facing direction.
- **`Camera.getWorldDirection(target)`** — Three.js override. Returns local **−Z** transformed. For a camera, this is the look-at direction.
- **`ThirdPersonCamera.getForwardVector()`** — world-space camera forward (calls `camera.getWorldDirection`, flattens to XZ plane). Use this whenever you want "move in the direction the camera is looking."
- **`ThirdPersonCamera.getRightVector()`** — world-space camera right (computed as `forward × up`).
- **`TopDownCamera.getForwardVector()`** — same shape as ThirdPerson; safe to use the same way.
- **`Vehicle.getForwardDirection()`** — vehicle local +Z transformed (matches gameplay convention).
- **`engine.getWorldCenter()`** — world-space centre of the active level (ground-snapped). Procedural voxel worlds are centred on the origin, so this is `(0, 0)`; **baked (`.vwld`) levels are corner-origin — content occupies `[0, size]`, so their centre is `(size/2, size/2)` and `(0, 0)` is the CORNER**. Use this for "the middle of the world" — arena centre, enemy spawn rings, zone centre, patrol anchors — instead of hardcoding `(0, 0)`, which lands at the corner on a baked level.

- **`engine.resolveGroundPlacement(x, z, options?)`** — the standable point at `(x, z)` in the **active** world. X/Z are validated against the real terrain bounds (`DynamicObjectManager.getTerrainBounds()`, which covers both the procedural VoxelWorld and the baked `.vwld` level), and Y is resolved through whichever terrain path is live. Use it for every spawn instead of assuming an extent: a forged park can start hundreds of metres from the origin, and `groundWorldSizeX/Z` is a *configured* plane that is often far larger than the level actually is (a 2016 × 2016 plane around a ~51 × 34 m board). The result is discriminated, never a fallback number:
  - `{ status: 'ok', position, groundY, clampedToBounds }` — place here.
  - `{ status: 'out-of-bounds', bounds, nearestX, nearestZ }` — the point is off the map; retry at the nearest values, or pass `{ clampToBounds: true }` to have the engine pull it in for you.
  - `{ status: 'no-ground', x, z, bounds }` — inside the map but nothing underneath (a hole, a gap between islands). **Do not substitute `y = 0`** — that is the sky, and it is how objects end up buried under or floating over a level. Pick another X/Z.

  Options (all optional, spread over `DEFAULT_GROUND_PLACEMENT_OPTIONS`): `sampleRadius` samples a cross of that radius and takes the lowest ground so an object next to a slope does not float; `boundsMargin` (default 0.5 m) keeps the point off the terrain edge; `clampToBounds` converts an out-of-bounds request into a clamped `'ok'`.

No general-purpose `MathUtils.yawFromDirection()` / `directionFromYaw()` helper exists in `game/src/engine/`. If you find yourself reaching for one repeatedly, the right place to add it is `engine/MathUtils.ts` — using the §2 (+Z gameplay) form, because every existing gameplay caller already does that math inline.

---

## 6. Real inconsistencies (do not propagate)

Code that genuinely deviates from the §2 / §2b conventions and should be treated as a known anomaly:

- **`BlockCharacterRenderer`'s `FLIP_Y_180`** flips only the head 180° at render time. The body parts follow a different correction. If you see a head/body desync in a block character, this is why. Visual artifacts here are the most likely cause of any "left and right look wrong" complaint about block characters. Fix at asset-load time on the root node when authoring is done; don't add more per-bone flips.
- **`mechanic-soccer.md` "kick-where-player-faces" fallback** — historical anomaly, now corrected: the doc uses the §2 gameplay form `dirX = sin(yaw); dirZ = cos(yaw)`. Older generated games may still carry the §2b camera form (`-sin/-cos`), which kicks the ball **opposite** to the player's visible facing; fix those to the gameplay form.
- **`archetype-dungeon.md`** layout assumes the player faces +Z at spawn (the corridor is at +Z). That requires `spawnRotation: 0` under the §2 gameplay convention — the archetype doc is already corrected to reflect this.

---

## 7. Vehicles — same convention, different surface

Vehicles use the same +Z-forward gameplay convention as players. The wrinkle is just that `vehicle-system.md` exposes a yaw table where `spawnRotation: 0` means "face +Z" — that's already the §2 convention, not an override. Use the helpers:

```ts
import { FACE, headingToward, headingTangent } from 'engine/Vehicle.js';
```

`vehicle.getForwardDirection()` returns local +Z transformed (matches §2). Treat it like any other gameplay forward.

`Vehicle.setAIControls` takes `steer` with **+1 = left** — matching the §2 cross sign, so the correct signed steering error is:

```ts
const cross = fwd.z * to.x - fwd.x * to.z;   // +ve ⇒ target is left ⇒ steer left
const steer = Math.atan2(cross, dot);        // see engine/VehicleDrivingComponent.ts
```

---

## 8. Red flags / lint heuristics

Code smells that almost always signal a convention bug. Each one points to which convention is being mishandled:

- **`new THREE.Vector3(0, 0, -1)` used as a gameplay forward.** Gameplay forward is `+1` on Z, not `−1`. Camera forward is `−1` — make sure you're in the right layer.
- **`Math.atan2(forward.x, -forward.z)` to derive a yaw from a gameplay direction.** The gameplay form is `atan2(x, z)`. The negation is only correct for camera/-Z directions, and even then you should also negate `x` — see §2b.
- **Two `atan2(x, z)` / `atan2(x, -z)` call sites in the same file with different sign conventions on `z`.** Pick one (gameplay or camera, per §2 / §2b) and rewrite.
- **`rotation.y = Math.PI` or `quaternion.multiply(flip180)` inside gameplay or per-frame code.** A 180° flip is an asset-load-time fix, applied once on the root node — never per frame, never per bone. (Known intentional exceptions: `BlockCharacterRenderer`'s head/neck flips and the pose-v2 torso flip — these correct a bone-basis that points backward and are gated/documented in place.)
- **A `+ Math.PI` added to a yaw used for camera math when the yaw came from a gameplay `atan2(x, z)`.** That's the inter-convention bridge (gameplay forward → camera-behind orbit angle). It belongs in camera code only; do not propagate into spawn/movement code.
- **`fwd.x * to.z - fwd.z * to.x` used to decide "turn right".** That cross is positive when the target is to a +Z-forward entity's **left**. AI steering that uses it unnegated turns away from every target and circles forever. See §2.
- **A mirrored pair of tilted slabs (a pitched roof, opposing ramps) whose tilt signs match the side they sit on** — e.g. the `+z` half tilted `+x`. That inverts the pitch: both halves rise outward and the middle sinks. See §2c.

---

## 9. Summary (one sentence)

**Gameplay objects (players, NPCs, vehicles, glTF) use local +Z forward; use `atan2(facing.x, facing.z)` and `(sin θ, 0, cos θ)`. Cameras use local −Z forward; use `atan2(-forward.x, -forward.z)` and `(−sin θ, 0, −cos θ)`. "Right" is **opposite** between the two: a gameplay entity's right is local −X, a camera's is local +X. **Decrement** yaw to turn right (both conventions). Tilting, positive X drops the +Z end and positive Z lifts the +X end. The +π adjustment in camera follow code is the bridge between the two — leave it where it lives.**
