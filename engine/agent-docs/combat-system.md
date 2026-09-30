# Combat Systems

> **Not for voxel mining.** `WeaponMeleeSystem` damages `IDamageable` entities (enemies/NPCs); it does NOT break voxel blocks, and its action handler hijacks the mining key. For mining, see `voxel-mining.md` — block-breaking is auto-wired (`VoxelMiningSystem`), and the in-hand tool + swing animation is handled by `PlayerToolSystem`. Never wire `WeaponMeleeSystem` / `setAttackSystem` / `WeaponType.AXE` as a "mining axe".

## Component-Based Architecture

Combat systems use a **component-based approach** - pluggable systems that can be attached to ANY `PlayerController`:

```typescript
import { WeaponMeleeSystem } from 'engine/WeaponMeleeSystem.js';
import { WeaponType } from 'engine/WeaponRegistry.js';

// 1. Create system
const meleeSystem = new WeaponMeleeSystem(engine, physicsWorld);

// 2. Equip weapon when character is ready (safe to call at any time)
playerController.onCharacterReady(() => {
    meleeSystem.equipWeaponByType(WeaponType.SWORD, player, playerController);
});

// 3. Set attack system (auto-sets Enter/click/mobile action handler)
playerController.setAttackSystem(meleeSystem);
```

All combat systems implement the `IPlayerAttack` interface for consistent pluggability.

## Combat System Components

**Read the inline documentation in these files for complete usage:**

| System | File | Description |
|--------|------|-------------|
| **Melee Weapon Combat** | `game/src/engine/WeaponMeleeSystem.ts` | Player sword/axe attacks (component) |
| **Ranged Weapon Combat** | `game/src/engine/RangedWeaponSystem.ts` | Player guns/bows/blasters (component) |
| **Unarmed Combat** | `game/src/engine/UnarmedMeleeSystem.ts` | Player punches/kicks (component) |
| **Weapon Pickup/Drop** | `game/src/engine/WeaponPickupSystem.ts` | Pick up and drop weapons (coordinator) |
| **Melee Weapon Registry** | `game/src/engine/WeaponRegistry.ts` | 12 built-in melee weapons (sword, axe, lightsaber, etc.) |
| **Ranged Weapon Registry** | `game/src/engine/RangedWeaponRegistry.ts` | Pistol, rifle, bow, laser blaster, etc. |
| **Static Cannons/Turrets** | `game/src/engine/ShootableComponent.ts` | World objects that fire projectiles |
| **Collision System** | `game/src/engine/CollisionLayers.ts` | Physics collision groups and masks |

## Player Unarmed Combat

Use `UnarmedMeleeSystem` when the prompt asks for "unarmed combat", "punch", "kick", "fistfight", "brawler", "martial arts", "kung fu", "karate", or any melee attack without a held weapon.

**Off by default.** No genre template wires it automatically — you opt in with one line per game. **Don't** wire `WeaponMeleeSystem` for unarmed combat (that's for held weapon meshes).

### One-line opt-in (uses the pre-loaded `mPunching01` + `mKicking01`)

```typescript
import { UnarmedMeleeSystem } from 'engine/UnarmedMeleeSystem.js';

const meleeSystem = new UnarmedMeleeSystem(engine, physicsWorld);
playerController.setAttackSystem(meleeSystem);
```

That's it. `setAttackSystem` calls `setController` / `setupEventListeners` / `setMobileControls` and binds Enter / left-click / mobile-action to attack. Don't add your own "Press Enter to attack" toasts or hints — mobile players get a touch button instead of keys, and the engine's interaction prompt and action button already communicate controls per device. When the character is ready, the system **auto-registers two attack moves** against the already-loaded core animations:

| Auto-registered move | motionId | type | Bone | Motion options applied |
|----------------------|----------|------|------|------------------------|
| `punch` | `mPunching01` | `'punch'` | right hand | `splitBodyOnRun: true`, `filterRootMotion: true`, `speed: 1.5` |
| `kick`  | `mKicking01`  | `'kick'`  | right foot | `interruptOnMovement: true`, `filterRootMotion: true`, `speed: 1.5` |

Each press of the attack button picks one at random. **No animation-pack load is required** — both clips are in `CORE_ANIMATIONS` for every character.

The same auto-registration also puts the character in a **fighting stance**:
the pack's `FightingIdle` guard (staggered feet, fists at the chin) replaces
the standing idle while the system is attached. On by default — pass
`fightingStance: false` in the config to keep the game's normal idle. Walk and
run are untouched; the guard is the between-strikes posture.

**Why those flags:**
- `splitBodyOnRun` on the punch — when the player throws a punch while running, only the upper body plays the punch clip; the legs keep cycling. Without this, the legs snap to the punch pose and the character visibly slides.
- `interruptOnMovement` on the kick — kicks are a full-body commit, so any movement input cancels the kick mid-swing and locomotion resumes immediately.
- `filterRootMotion` on both — locks the clip's hips translation track so physics owns the player's position; the visual rotates in place.

`CustomAttackMove` supports `splitBodyOnRun`, `filterRootMotion`, `interruptOnMovement`, and `speed` — set them on any move you register yourself with the same semantics.

### Tuning damage / range / forces

Pass a config to override defaults (punch=8 dmg, kick=12 dmg, range=2m, cone=30°):

```typescript
const meleeSystem = new UnarmedMeleeSystem(engine, physicsWorld, {
    attackRange: 2.5,
    punchImpulse: 12,
    kickImpulse: 18,
});
playerController.setAttackSystem(meleeSystem);
```

### Custom moves only (opt out of the defaults)

If you want a fully custom move set, disable auto-registration and register your own — registering any move yourself before the character is ready also suppresses the defaults:

```typescript
const meleeSystem = new UnarmedMeleeSystem(engine, physicsWorld, {
    autoRegisterDefaultMoves: false,
});
playerController.onCharacterReady(() => {
    playerController.animationController?.registerCustomAttack({
        name: 'jab',
        animationMotionId: 'mPunching01',
        type: 'punch',
        side: 'left',
        damage: 6,
        speed: 1.8,
    });
    // …more moves
});
playerController.setAttackSystem(meleeSystem);
```

### When to load the larger `UNARMED_COMBAT_ANIMATIONS` pack

Only if the prompt explicitly asks for **variety** — fighting-game combos, hooks,
uppercuts, roundhouse kicks, sweeps. The pack adds 6 extra strike clips to the
bundle, so skip it for a generic "punch and kick the enemies" game.

The full strike vocabulary (ids in `UNARMED_MOVES`, `engine/AnimationPacks.js`):

| move | motionId | what it is |
|---|---|---|
| `cross` | `mGenPunching01` | right cross (auto-registered default) |
| `jab` | `mGenPunchJab01` | fast left jab, 0.36s |
| `hook` | `mGenPunchHook01` | left hook, power from torso rotation |
| `uppercut` | `mGenPunchUppercut01` | right uppercut, dip-and-rise |
| `frontKick` | `mGenKicking01` | front kick (auto-registered default) |
| `roundhouse` | `mGenKickRoundhouse01` | waist-high right roundhouse |
| `sideKick` | `mGenKickSide01` | bladed piston side kick |
| `sweep` | `mGenKickSweep01` | deep-crouch low leg sweep |

```typescript
import { UNARMED_COMBAT_ANIMATIONS, UNARMED_MOVES } from 'engine/AnimationPacks.js';

await animCtl.loadAnimationPack(UNARMED_COMBAT_ANIMATIONS, { addToAttackCollection: true });
playerController.animationController?.registerCustomAttack({
    name: 'uppercut', animationMotionId: UNARMED_MOVES.uppercut,
    type: 'punch', side: 'right', damage: 14,
});
playerController.animationController?.registerCustomAttack({
    name: 'roundhouse', animationMotionId: UNARMED_MOVES.roundhouse,
    type: 'kick', side: 'right', damage: 16, interruptOnMovement: true,
});
// …one registerCustomAttack per move you want in the random attack pool.
```

## NPC Unarmed Combat (fighting games)

`UnarmedNpcBehavior` (`engine/npc/examples/EXAMPLE_UnarmedNpcBehavior.js`) is
the NPC half of a fist fight — use it whenever hostile NPCs should punch and
kick rather than swing weapons:

```typescript
import { UnarmedNpcBehavior } from 'engine/npc/examples/EXAMPLE_UnarmedNpcBehavior.js';

const handle = this.engine.registerNpc('brawler', new UnarmedNpcBehavior({
    attackRange: 1.9,     // fist range — shorter than sword NPCs
    attackCooldown: 1.1,
    damage: 10,           // player HP per landed hit
}), { hostile: true });
await handle.spawn(10, 5);
```

What it does: chases and squares up, throws the SAME strike clips the player
uses (random pick per attack), and adopts the `FightingIdle` guard between
strikes (`fightingStance: false` to opt out).

**Hit registration is ENGINE-level, both directions.** Player→NPC:
`UnarmedMeleeSystem` raycasts forward from the striking fist/foot bone →
`onMeleeHit` → damage + knockback (hits never stun or freeze the target —
there is no engine stun). NPC→player: `NpcController` itself
watches the NPC's attack system — any registered move of type `punch`/`kick`
that starts gets limb-vs-player-capsule checks at fixed points through the
clip, projected forward by the move's `range` (the same number that gates when
the behavior attacks). Behaviors only DECIDE (chase, when to strike); no
behavior or template code is involved in contact, so it cannot be mis-wired.
Weapon attacks (type `'attack'`) are landed the same way — a blade sweep the
engine runs — but only when the engine holds the weapon (an NPC configured with
`weapon`, tracked by `NpcWeaponComponent`). A behavior that attaches its own
weapon mesh and runs its own sweep is left alone, so the two never double up.
Remember `this.hud.showHealth()`.

**Character separation is also engine-owned.** The engine pushes the player's
capsule out of any NPC capsule every frame, after all character updates — so
the player cannot shove through enemies no matter which movement system is
active, including game-authored motors that move the body with
`setNextKinematicTranslation` and terrain-only wall probes. Do NOT hand-roll
player↔NPC blocking in game code.

For armed NPCs use `MeleeNpcBehavior` (sword swings, blade sweep) instead.

## Player Ranged Combat

> Works unchanged on a Voxel game running **Rapier 2D** (`physicsMode: '2d'`,
> the sidescroller and top-down templates): the shot's body is built by the
> plane-locked facade instead of the 3D descriptor, and flies in the gameplay
> plane. Top-down shots hold their muzzle height; side-on shots arc under
> gravity when the weapon asks for it. **Aim resolves itself** — a side-on game
> is put in cursor mode whatever `aim` you pass (camera aim would point down the
> one axis a 2D shot cannot travel along) and aims at the cursor projected onto
> the gameplay plane; facing stays the movement system's job there. Bullet holes
> fall back to decals (no carving). See `game/docs/physics-2d-lane.md`. The
> **Physics2D genre** is a different thing and has its own `Projectile2D` — see
> `physics2d-genre.md`.

Give the player a gun with `installRangedWeapon` — **one call, nothing else to wire**:

```typescript
import { installRangedWeapon } from 'engine/RangedWeaponSystem.js';

// Top-down arena: pistol that fires at the visible mouse cursor + ammo HUD
const weapon = installRangedWeapon(playerController, 'pistol', {
    aim: 'cursor',
    showAmmoCounter: true,
});
```

It constructs the `RangedWeaponSystem`, registers it as the controller's attack
system (input listeners, mobile controls, per-frame tick, disposal), equips the
weapon **readiness-safely** (call it before or after the character has loaded —
either way the gun, the hold-to-fire shoot action and the ammo counter appear),
and applies the ammo options. Options (all optional): `aim`, `cursorFacing`,
`projectileColor`, `magazineSize`, `reloadDurationMs`, `fireRate`, `showAmmoCounter`.
The returned handle gives you `switchWeapon(id)`, `remove()`, `isEquipped()` and
`system` (the low-level component, e.g. for `onProjectileCreated`).

**Cadence is `fireRate` (shots per second)** — the install option, or
`system.setFireRate(n)` at runtime; both persist across `switchWeapon`. Without it a
weapon fires at its preset rate (pistol 3/s, assault rifle 8/s, shotgun 1.2/s, bazooka
0.5/s). **`setShootingDelay(ms)` is NOT a fire-rate control**: it is the one-shot
"no firing for the next N ms" gate (now named `suppressFireFor`, the old name is a
deprecated alias) the engine uses so the click that locks the pointer is not also a
shot. Every reader so far has mistaken it for cadence and shipped a "machine gun"
that still fired at 8 rounds a second.

**NEVER hand-roll the install sequence.** Ordering `setAttackSystem` /
`onCharacterReady` / `equipWeapon` by hand is the classic "type-clean code, no
visible weapon, shooting does nothing" bug. The low-level API is still there for
games that must interleave their own steps:

```typescript
const rangedSystem = new RangedWeaponSystem(engine, physicsWorld);
playerController.setAttackSystem(rangedSystem);
playerController.onCharacterReady(() => rangedSystem.equipWeapon(RangedWeaponType.PISTOL, player, playerLoader));
```

**Features:** Dual weapons, weapon clearance detection, recoil, projectile physics.

**Ammo counter is engine-owned.** When reload is enabled (finite ammo), the
system auto-creates a bottom-right `current/max` HUD counter and keeps it
updated through fire, reload, and weapon swaps. **Never** `createCounter` your
own ammo display — the result is two counters stacked in the corner. Control it
with the install's `showAmmoCounter` option, or
`rangedSystem.setShowAmmoCounter('auto' | true | false)` (`'auto'` = show only
with finite ammo).

**Aim modes:** `RangedWeaponSystem` adapts its AIMING to the active camera automatically (`aimMode: 'auto'` is the default):

- **First/third-person:** camera-center aiming with a reticle.
- **Top-down:** cursor aiming — no reticle, no camera lock; shots fly toward the mouse cursor's ground point. By default the character faces its movement direction while traversing and turns to the cursor only while firing (plus a short linger) — natural walking, Hades-style. For classic twin-stick facing (always face the cursor, movement strafes) pass `cursorFacing: 'always'` in the options. On mobile, shots fire along the facing/movement direction.

> Aiming adapts to every camera mode, but the WEAPON MESH does not: it is parented to the player body, which the engine hides in first person, so the gun is invisible there however well it aims. First-person games use `FirstPersonWeaponSystem` instead — see `@docs first-person-weapons.md`.

**NEVER** hand-roll mouse aiming or hide the reticle in top-down games — install the weapon and the engine handles it. Force a mode only if needed:

```typescript
installRangedWeapon(playerController, 'pistol', { aim: 'cursor' });
// low level: new RangedWeaponSystem(engine, physicsWorld, { ...DEFAULT_RANGED_WEAPON_OPTIONS, aimMode: 'cursor' })
```

**Directional locomotion and torso aim are automatic.** Equipping under an
aim mode lazy-loads the directional pack. Standing RUN blends neighboring
captured directions on one foot-contact phase (including forward/back diagonals);
rifle-style holds use the rifle set, other holds use the neutral jog set.
WALK retains the slower procedural strafes/backpedal. Postures take priority;
an unavailable captured set retains the previous directional fallback.
Unequipping restores the ordinary running override. In top-down (cursor) games the
default `cursorFacing: 'while-firing'` produces the full behavior:

- **Not shooting** — the character faces where it moves, forward clips play,
  nothing tracks the cursor.
- **Actively shooting** (trigger held + a short linger) — small aim angles are
  covered by the TORSO twisting toward the reticle while the legs keep the
  forward cycle; beyond torso reach (or standing still) the body rotates to
  the cursor and the legs hand over to strafe/backpedal. Shots always fly
  toward the cursor either way.

Camera-aim (third-person over-shoulder) strafes the same way whenever the
player moves off the camera axis. Nothing to wire, nothing to configure — do
NOT hand-roll strafe animations or torso rotation in template code, and do
not switch `cursorFacing` to 'always' unless the prompt asks for classic
twin-stick facing.

**Projectile color:** defaults to the weapon preset's color. Override via `projectileColor` in the options above (player) or in the `RangedNpcBehavior` config (NPCs) — e.g. to make hostile fire visually distinct from the player's.

For NPC ranged weapons, see: `game/src/engine/npc/examples/EXAMPLE_RangedNpcBehavior.ts`

## Player Melee Combat

> **For voxel mining, do NOT use this.** `WeaponMeleeSystem` damages enemies only — it won't break voxel blocks, and its action handler collides with mining input. Use `PlayerToolSystem` for the visible axe + swing animation and let the auto-wired `VoxelMiningSystem` do the block damage. See `voxel-mining.md`.

Use `WeaponMeleeSystem` component for player melee weapons (sword, axe, spear, etc.):

```typescript
import { WeaponMeleeSystem } from 'engine/WeaponMeleeSystem.js';
import { WeaponType } from 'engine/WeaponRegistry.js';

// 1. Create system
const meleeSystem = new WeaponMeleeSystem(engine, physicsWorld);

// 2. Equip weapon when character is ready (safe to call at any time)
playerController.onCharacterReady(() => {
    meleeSystem.equipWeaponByType(WeaponType.SWORD, player, playerController);
});

// 3. Set attack system (auto-sets action handler for Enter/click/mobile)
playerController.setAttackSystem(meleeSystem);
```

**That's it!** The engine handles:
- `onCharacterReady` auto-fires if character already loaded (no ordering issues)
- `setAttackSystem` auto-configures the Enter key / mobile action button for melee
- Multiple `onCharacterReady` listeners are supported

### Weapon Pickup & Swap

For games where the player picks up and swaps weapons, use `WeaponPickupSystem` as coordinator:

```typescript
import { WeaponPickupSystem, WeaponPickupManager, WeaponCategory } from 'engine/WeaponPickupSystem.js';

// 1. Create manager + coordinator
const pickupManager = new WeaponPickupManager(engine, physicsWorld, spawner);
const pickupSystem = new WeaponPickupSystem(engine, physicsWorld, pickupManager);

// 2. Spawn weapon pickups in the world
pickupManager.spawnWeapon(WeaponCategory.MELEE, WeaponType.AXE, axePosition);

// 3. Attach coordinator when character is ready
playerController.onCharacterReady(() => {
    pickupSystem.attach(playerController);
    // To start with a weapon: spawn at player feet and auto-pickup
    pickupManager.spawnWeapon(WeaponCategory.MELEE, WeaponType.SWORD, playerPosition);
    pickupSystem.tryPickupWeapon();
});

// 4. Update in game loop
pickupSystem.update(deltaTime);
pickupManager.update(deltaTime);
```

**NEVER** mix manual `equipWeaponByType()` + `setAttackSystem()` with `WeaponPickupSystem` — the pickup system manages weapon state internally and manual equipping will corrupt it.

## Weapon visual styles

Every built-in melee and ranged design has **block** and **lowpoly** versions.
The base ID selects block (`sword`, `assault_rifle`); append `_lowpoly` for the
faceted version (`sword_lowpoly`, `assault_rifle_lowpoly`). Dual weapons follow
the same rule (`dual_pistols_lowpoly`). Use these IDs in the same player, NPC,
first-person, and pickup APIs. Combat stats and animations stay the same.

Read `@docs weapon-visuals.md` before creating or restyling weapons. It covers
the complete catalog, geometry/material rules, compiled melee and ranged examples,
and the standalone comparison gallery. Prefer the built-ins when they fit.

## Static Shootable Objects (Cannons, Turrets)

**IMPORTANT: This is for WORLD OBJECTS, not player weapons!**
- For **player guns/bows/blasters** → Use `RangedWeaponSystem` component (see above)
- For **static cannons, turrets, mounted guns** → Use `ShootableComponent` (this section)

**ShootableComponent** - Add to any static world object that fires projectiles (cannons, turrets, traps).

See `ShootableComponent.ts` for component details and `ExampleCannon.ts` for a complete implementation.

**Key Features:**
- Automatic fire rate control with cooldowns
- Physics-enabled projectiles with lifetime management
- Customizable projectile visuals and behavior

### Barrel Orientation (Cylinders)

When attaching to a cannon barrel made of `CylinderGeometry`:
1. `CylinderGeometry` is aligned along the **Y-axis** (0, 1, 0) by default
2. **ALWAYS** set `localFireDirection` to `new THREE.Vector3(0, 1, 0)` for cylinders

**Nested Objects (Turrets):**
`ShootableComponent` automatically handles world rotation for nested objects (e.g., Tank -> Turret -> Barrel).

## Voxel Destruction APIs

These destroy the WORLD (terrain, placed objects, debris). They are NOT for
killing a creature: a "robot that explodes" / "enemy that blows up" / NPC that
detonates means `controller.shatterIntoVoxels()` (see `@docs npc-combat-death.md` →
*Destroying / detonating an NPC*), NOT a terrain crater. Using
`explodeTerrainSphere` for an NPC death blows a hole in the ground where it
stood — a bug, not the effect.

| Target | Method | File |
|--------|--------|------|
| Terrain | `terrainSystem.explodeTerrainSphere(pos, radius, impulse, upImpulse)` | `VoxelTerrainSystem.ts` |
| VoxelObjects | `VoxelObject.fromRigidBody(hitBody, physicsWorld)` then `.explodeAt(pos, radius)` | `VoxelObject.ts` |
| Debris | `VoxelDebrisManager.explodeDebrisInRadius(pos, radius, impulse, upImpulse)` | `VoxelDebrisManager.ts` |

For explosive weapons that should crater the world, call all three in the projectile hit callback. See inline docs in each file.

### Destructible VXL Assets

To make placed VXL assets (towers, barrels, walls, etc.) destructible, pass `--destructible` when placing with the voxel CLI (`node bin/voxel.mjs place ...`; see `@docs voxel-cli.md`). This creates individual VoxelObjects that retain voxel data for `explodeAt()`.

### Projectile Hit → VoxelObject Destruction (CRITICAL PATTERN)

**ALWAYS use the projectile's hit body to find VoxelObjects — NEVER scan rigid bodies by origin position.**

The projectile already knows which physics body it hit via `getHitBody()`. Use `VoxelObject.fromRigidBody()` to resolve it:

```typescript
// ✅ CORRECT — works at any height on the object
rangedSystem.onProjectileCreated = (projectile: Projectile) => {
    const origUpdate = projectile.update.bind(projectile);
    let wasHit = false;
    projectile.update = function(dt: number) {
        origUpdate(dt);
        if (!wasHit && projectile.hasHit()) {
            wasHit = true;
            const pos = projectile.getPosition();
            // 1. Destroy the hit VoxelObject (if any)
            const hitBody = projectile.getHitBody();
            if (hitBody) {
                const voxelObj = VoxelObject.fromRigidBody(hitBody, physicsWorld);
                if (voxelObj && !voxelObj.isDestroyed()) {
                    voxelObj.explodeAt(pos, radius, impulse, upImpulse);
                }
            }
            // 2. Destroy terrain
            terrainSystem?.explodeTerrainSphere(pos, radius, impulse, upImpulse);
            // 3. Destroy nearby debris
            VoxelDebrisManager.explodeDebrisInRadius(pos, radius, impulse, upImpulse);
        }
    };
};
```

**Why not scan all bodies?** A rigid body's `translation()` returns its origin (base/pivot), not its full bounding volume. For a 14m tower placed at y=1, the body origin is at y=1 — a projectile hitting the top at y=15 would fail any distance check against the origin. The hit body approach works because the projectile's collider directly intersects the object's collider (which spans the full height), and Rapier returns the parent rigid body.

## AOE (Area of Effect) Explosions

Projectiles with an `ExplosionConfig` automatically deal AOE damage to all nearby NPCs, animals, remote entities, and players. **No template code needed** — the engine handles everything.

### Bullet holes in scenery cost a geometry clone

A projectile that hits a voxel prop or building queues a real carved hole. For a
batched (instanced) object that means PROMOTING the instance first — cloning its whole
geometry inside the hit callback. Measured on forged-city assets that is 30–370 ms per
object and does not follow leaf count, so a spray that misses and lands on scenery is a
visible hitch. Monsters are never carved. A game that would rather keep its frame turns
it off at load and keeps the decals:

```typescript
import { getVoxelCarveSystem } from 'engine/voxelcarve/VoxelCarveSystem.js';
getVoxelCarveSystem()?.configure({ maxLeavesPerObject: 0 });   // decals only, no promotion
```

### Projectile visibility

Ballistic bullets default to a slim emissive **tracer** (a thin cylinder ~9x
its radius long), not a sphere — a bullet reads as a streak of light. Weapons
with their own mesh factory (rockets, laser bolts, arrows) keep theirs.

On top of that, projectile visuals are grown automatically so they never fall
below ~1% of viewport height on a perspective camera — physics is untouched,
only the mesh and its trail scale, and only upward (capped at 3x). Without it
a pistol round drew about 5 pixels from a third-person camera and crossed the
screen in a fraction of a second: on screen, but invisible in practice.

So don't "fix" invisible bullets by inflating `projectileRadius` — that also
changes nothing about hit detection (collisions use `collisionRadius`) but does
make close-up shots look wrong. If a projectile still reads poorly, reach for
`trailLength` and the trail `color`.

### Camera-aim mode (first / third person)

With `aimMode: 'auto'` a non-top-down camera gets **camera-center aiming**: the
shot converges on the first surface the camera ray meets under the reticle —
terrain, environment, NPCs, animals, props — so you hit what the crosshair
covers at whatever range it happens to be. If the ray meets nothing (open sky)
the shot travels to a fixed point 20m down the ray.

The ray starts just past the player, not at the camera, because a chase camera
is routinely pushed inside terrain or a wall; a ray from the camera itself would
hit at ~0m and drop every shot at the player's feet.

**The crosshair is authoritative.** The aim ray is cast through the reticle's
actual screen position (52% of viewport height, over-the-shoulder framing —
one constant shared between the HUD CSS and `RangedWeaponSystem`), and each
shot's direction is converged muzzle → aim point at fire time, so bullets land
exactly on the crosshair at any range. Don't offset the reticle in game code —
move the shared constant if a game needs different framing. Bullets also do
NOT collide with debris (corpse shatter, destruction chunks): wreckage at the
point of aim must never eat follow-up shots.

**Point-blank shots land.** Characters do not collide with each other, so a charging
enemy can stand INSIDE the gap between the shooter's body and the muzzle (0.6–0.9 m).
Every shot spawns from the shooter's centre instead of the muzzle whenever something the
projectile can hit sits on that segment (`engine/weapons/PointBlank.ts`), so it flies into
the target rather than leaving from behind it. Scenery never triggers this: pressed into
a wall, a shot still leaves from the muzzle as before. Nothing to configure.

Top-down games use cursor aim instead, which deliberately flattens shots to
muzzle height (`calculateTargetPoint`) so bullets fly horizontally rather than
being planted in the ground a metre ahead.

### Enabling AOE Damage

Set `damage` and `damageRadius` in the projectile's `ExplosionConfig`:

```typescript
const visualConfig: ProjectileVisualConfig = {
    explosion: {
        enabled: true,
        radius: 3.0,         // Visual explosion radius (meters)
        duration: 1.5,        // Visual effect duration (seconds)
        damage: 50,           // Base damage at center
        damageRadius: 5.0,    // Damage falloff radius (meters) — can be larger than visual radius
        color: 0xff4400,      // Optional: explosion color
    },
    // ... other visual config
};
```

**Damage falloff:** Linear from center to edge. At center = 100% damage, at edge = 0%.

Example with `damage: 50, damageRadius: 5.0`:
- 0m from center: 50 damage
- 2.5m: 25 damage
- 5m: 0 damage (at edge)

### What Happens Automatically

When a projectile with `ExplosionConfig` hits something:
1. The directly-hit entity takes normal projectile damage (direct hit)
2. An explosion spawns with visual effects
3. **All nearby entities in `damageRadius`** take AOE damage with distance falloff:
   - Local NPCs via `NpcRegistry`
   - Local animals via `AnimalRegistry`
   - Remote entities via multiplayer hit events
   - The player (if enemy projectile)
4. The directly-hit entity is **skipped** in the AOE pass (no double damage)

An explosive projectile that never contacts anything (fired into the sky, out
over a cliff, or simply flying past everything) **detonates at the end of its
10s lifetime** instead of silently disappearing, so a shot always resolves.

**Explosive projectiles need an arc.** `gravityScale` defaults to `0` — a dead
straight line. A rocket fired flat then travels at muzzle height (~2m) for its
whole life and can never touch the ground, so a miss produces no explosion at
all. Top-down aiming makes this sharper: `calculateTargetPoint` deliberately
flattens shots to muzzle height, so a flat rocket sails over the very heads it
was aimed at. Give any explosive projectile a small `gravityScale` (the bazooka
presets use `0.05` — roughly a 2m drop over 20m of travel at 7 m/s) so it
reaches the ground, buildings and NPCs. Leave it `0` for bullets and lasers.

### If `damage` is not set

If `ExplosionConfig.damage` is omitted or 0, the AOE system uses the **projectile's own damage** (`projectile.getDamage()`) as the base AOE damage. This means any explosive projectile deals AOE damage — you don't need to configure `damage` separately.

### Creating AOE Weapons (Ranged)

```typescript
import { RangedWeaponSystem } from 'engine/RangedWeaponSystem.js';

const rangedSystem = new RangedWeaponSystem(engine, physicsWorld);
rangedSystem.equipWeapon(RangedWeaponType.BAZOOKA, player, playerLoader);
playerController.setAttackSystem(rangedSystem);

// Customize projectile visuals + explosion
rangedSystem.onProjectileCreated = (projectile: Projectile) => {
    projectile.setDamage(40); // Direct hit damage AND AOE base damage (if no explosion.damage set)
};
```

### Creating AOE Weapons (ShootableComponent / Cannons)

For static world objects (turrets, cannons), set the explosion config in `ShootableComponent`:

```typescript
const cannon = new ShootableComponent(engine, physicsWorld, {
    // ... other config
    visualConfig: {
        explosion: {
            enabled: true,
            radius: 4.0,
            duration: 1.0,
            damage: 60,
            damageRadius: 6.0,
        },
    },
});
```

### NPC/Enemy AOE Projectiles

For enemy projectiles that explode near the player:

```typescript
const projectile = new Projectile(pos, dir, speed, physicsWorld, engine, undefined, {
    explosion: {
        enabled: true,
        radius: 2.0,
        duration: 0.8,
        damage: 30,
        damageRadius: 4.0,
    },
}, ProjectileType.DESTRUCTION, CollisionMask.ENEMY_PROJECTILE);

projectile.setEnemyProjectile((proj) => {
    // Player takes AOE damage (amount is distance-based)
    playerController.takeDamage(proj.getDamage(), 'explosion');
});
```

## Common Mistakes — MUST AVOID

### 0. Never Hand-Roll a Game-Over Overlay

When the player's HP hits 0 (lose), the boss falls (win), or any other win/lose condition fires, you MUST call `engine.endGame()`. **Never** use `hud.showToast`, `hud.createCustomElement`, or a local `gameOver = true` flag to fake an end screen — those bypass the engine's simulation freeze, PokiSDK `gameplayStop()` reporting, and themed Replay button.

```typescript
// ❌ WRONG — toast vanishes, simulation keeps running, no replay path
if (playerHp <= 0) {
    this.gameOver = true;
    this.hud.showToast('You died!', { variant: 'error' });
}

// ✅ CORRECT — themed modal, frozen sim, Replay button, Poki reporting
if (playerHp <= 0) {
    this.engine.endGame({ outcome: 'lose', title: 'You Died' });
}
```

See `@docs end-game.md` for the full `EndGameOptions` shape (outcome, title, message, stats, replayLabel).

### 1. Never Override Projectile Damage to Absurd Values

```typescript
// ❌ WRONG — one-shots everything, makes balancing meaningless
rangedSystem.onProjectileCreated = (projectile) => {
    projectile.setDamage(9999);
};

// ✅ CORRECT — use the weapon preset's built-in damage, or adjust moderately
// The BAZOOKA preset already does 100 damage. Only override if you have a reason:
rangedSystem.onProjectileCreated = (projectile) => {
    projectile.setDamage(120); // Slightly higher than default
};
```

### 2. Always Override Explosion Config for Arena-Sized Games

Built-in explosion presets use sensible defaults, but you MUST check that `damageRadius` fits your arena. A `damageRadius` larger than your arena means every entity takes damage from every explosion.

**Rule of thumb:** `damageRadius` should be **≤ 10% of the arena's smallest dimension**.

```typescript
// ❌ WRONG — using BAZOOKA in a 60×60 arena without checking damageRadius
rangedSystem.equipWeapon(RangedWeaponType.BAZOOKA, player, playerLoader);
// Default damageRadius: 6m — fine for most arenas, but check!

// ✅ CORRECT — register a custom variant with smaller explosion for small arenas
// Explosion config is baked at projectile creation time via the weapon preset.
// Override it by registering a custom weapon with your desired explosion values:
RangedWeaponRegistry.register('small_bazooka', {
    preset: {
        ...BUILT_IN_BAZOOKA_PRESET,  // Copy base BAZOOKA stats
        explosion: {
            enabled: true,
            radius: 3.0,        // Visual radius
            duration: 1.0,
            damage: 80,          // AOE base damage
            damageRadius: 4.0,   // Must fit your arena!
            color: 0xff4400,
        },
    },
    createMesh: createBazooka,   // Reuse built-in mesh
});
rangedSystem.equipWeapon('small_bazooka', player, playerLoader);
```

### 3. Always Implement `onRemoteShoot` for Multiplayer Ranged Games

Without this, remote players' projectiles are **invisible** — other players see nothing when someone fires.

```typescript
// ❌ WRONG — empty handler, remote projectiles invisible
multiplayer.onRemoteShoot((senderId, shootData) => {
    // Remote player shot
});

// ✅ CORRECT — spawn a visual-only mesh for remote shooters
multiplayer.onRemoteShoot((_senderId, data) => {
    const pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
    const dir = new THREE.Vector3(data.direction.x, data.direction.y, data.direction.z);
    const speed = data.speed;
    const gravity = (data.gravityScale ?? 0) * 9.81;

    // Simple bullet mesh (no physics — visual only)
    const bullet = new THREE.Mesh(
        new THREE.SphereGeometry(data.radius ?? 0.05),
        new THREE.MeshBasicMaterial({ color: data.color ?? 0xffff00 })
    );
    bullet.position.copy(pos);
    engine.scene.add(bullet);

    // Animate flight
    let elapsed = 0;
    const animate = () => {
        elapsed += 1 / 60;
        if (elapsed > 3) {
            engine.scene.remove(bullet);
            bullet.geometry.dispose();
            (bullet.material as THREE.Material).dispose();
            return;
        }
        bullet.position.addScaledVector(dir, speed / 60);
        bullet.position.y -= gravity / 60 * elapsed;
        requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
});
```

### 4. Use RangedNpcBehavior for Ranged Enemy NPCs

If your game has ranged combat (guns, bazookas, blasters), NPCs should **shoot back** — not just walk toward the player.

```typescript
// ❌ WRONG for a gun game — NpcEnemyBehavior is a MELEE enemy: it closes to punching
// range instead of shooting, so a firefight turns into a brawl
const enemy = engine.registerNpc('enemy', new NpcEnemyBehavior(), {
    characterFactory: createWarriorNpcFactory(),
});

// ✅ CORRECT — use RangedNpcBehavior so NPCs shoot projectiles
// See: game/src/engine/npc/examples/EXAMPLE_RangedNpcBehavior.ts
import { RangedNpcBehavior, createStormtrooperNpcFactory } from 'engine/npc/index.js';

const enemy = engine.registerNpc('enemy', new RangedNpcBehavior({
    weaponType: 'laser_blaster',
    shotInterval: 1.0,
}), {
    characterFactory: createStormtrooperNpcFactory(),
});
await enemy.spawn(10, 5);
```

### 5. Use onHitCallback — Never Poll Projectiles Per Frame

The engine provides callbacks for projectile hits. **Never** write a manual loop that checks every projectile every frame.

```typescript
// ❌ WRONG — manual per-frame polling loop
update(deltaTime: number) {
    for (const projectile of this.projectiles) {
        if (projectile.hasHit()) {
            const hitBody = projectile.getHitBody();
            // ... manual damage logic
        }
    }
}

// ✅ CORRECT — use the callback-based pattern
rangedSystem.onProjectileCreated = (projectile: Projectile) => {
    const origUpdate = projectile.update.bind(projectile);
    let wasHit = false;
    projectile.update = function(dt: number) {
        origUpdate(dt);
        if (!wasHit && projectile.hasHit()) {
            wasHit = true;
            // Handle hit once — see "Projectile Hit → VoxelObject Destruction" section
        }
    };
};
```

## Multiplayer Explosion & Destruction Sync

**CRITICAL for multiplayer games with explosive weapons:** Without this wiring, remote players never see explosions, terrain craters, or take AOE damage.

### Two Damage Types (BOTH required)

Explosive weapons cause **two independent damage events** to remote players:

| Event | Mechanism | What it does |
|-------|-----------|--------------|
| **Hit** (`sendHit`) | `setOnAoePlayerHit()` → engine auto-scans `remoteCharacters` | Targeted PvP AOE damage with distance falloff — goes through `onHit` on all clients |
| **Explosion** (`sendExplosion`) | `setOnExplosionTriggered()` → manual broadcast | Visual explosion + environmental damage — receiver applies self-damage via `onExplosion` |

Both must be wired. Hit damage = targeted (sender decides who gets hit). Explosion damage = environmental (receiver checks own proximity).

### Sending (in `onProjectileCreated`)

```typescript
// 1. Sync explosion visual + environment destruction
projectile.setOnExplosionTriggered((pos, config) => {
    // Spread the whole config so preset/seed/amount/… replicate the same visual
    multiplayer.sendExplosion({ ...config, position: { x: pos.x, y: pos.y, z: pos.z } });
    multiplayer.sendEnvironmentDestruction({
        position: { x: pos.x, y: pos.y, z: pos.z },
        radius: 3.0, impulse: 8, upImpulse: 5,
    });
});

// 2. PvP AOE hits — engine auto-detects remote players in blast radius
projectile.setOnAoePlayerHit(
    multiplayer.remoteCharacters,
    (networkId, damage) => multiplayer.sendHit(networkId, damage, { type: 'explosion' }),
);
```

### Receiving (once, during setup)

```typescript
import { Explosion } from 'engine/Projectile.js';

// Spawn visual explosion + apply environmental damage to local player
multiplayer.onExplosion((_senderId, data) => {
    const pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
    new Explosion(pos,
        { ...data, enabled: true, duration: data.duration ?? 1.0, damage: 0, damageRadius: 0 },
        engine
    );
    // Environmental AOE self-damage
    if (playerController && data.damageRadius && data.damage) {
        const playerPos = playerController.getGroundPosition();
        const dist = pos.distanceTo(playerPos);
        if (dist < data.damageRadius) {
            const aoeDmg = Math.round(data.damage * (1 - dist / data.damageRadius));
            if (aoeDmg > 0) playerController.takeDamage(aoeDmg, 'explosion');
        }
    }
});

// Apply terrain/debris destruction on remote clients
multiplayer.onEnvironmentDestruction((_senderId, data) => {
    const pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
    terrainSystem?.explodeTerrainSphere(pos, data.radius, data.impulse ?? 8, data.upImpulse ?? 5);
    VoxelDebrisManager.explodeDebrisInRadius(pos, data.radius, data.impulse ?? 8, data.upImpulse ?? 5);
});

// PvP hit sync (applies targeted AOE hits from sendHit)
multiplayer.onHit((_senderId, targetId, damage, extras) => {
    if (targetId === multiplayer.networkManager.localPlayerId) {
        playerController.takeDamage(damage, (extras?.type as string) || 'hit');
    }
});
```

**Key rules:**
- Remote `Explosion` uses `damage: 0, damageRadius: 0` — damage is handled separately via `onHit` + `onExplosion` self-check
- `sendHit` auto-normalizes `networkId` (strips `:player` suffix) — safe to pass keys from `remoteCharacters`
- `setOnAoePlayerHit` is called once per projectile in `onProjectileCreated` — engine handles distance calc + falloff

See `EXAMPLE_BazookaGame.ts` and `EXAMPLE_HandGrenadeWeapon.ts` for complete wiring.

## Weapon Archetype Examples

**IMPORTANT: Read the matching example file BEFORE implementing these weapon types.**

| Weapon Type | Example File | Key Concepts |
|-------------|-------------|--------------|
| **Bazooka / Rocket Launcher** | `fileReadTool(file="examples/EXAMPLE_BazookaGame.ts", code_type="engine")` | AOE explosion, onRemoteShoot, RangedNpcBehavior, PvP hit sync |
| **Hand Grenade / Throwable** | `fileReadTool(file="examples/EXAMPLE_HandGrenadeWeapon.ts", code_type="engine")` | `gravityScale: 1.0` for arc, custom weapon registration, voxel destruction |
| **Flamethrower / Fire Weapon** | `fileReadTool(file="examples/EXAMPLE_FlamethrowerWeapon.ts", code_type="engine")` | Rapid-fire projectiles, throttled multiplayer sync, short range |

**Keyword mapping** (user request → example):

| User Says | Read This Example |
|-----------|-------------------|
| bazooka, rocket launcher, RPG, missile, explosive weapon | EXAMPLE_BazookaGame |
| grenade, frag, thrown bomb, lobbed explosive, mortar | EXAMPLE_HandGrenadeWeapon |
| flamethrower, fire breath, napalm, flame weapon, spray | EXAMPLE_FlamethrowerWeapon |

## Custom Weapon Creation

To create custom ranged weapons (revolvers, shotguns, laser guns, etc.):

**READ THE GUIDE:** `fileReadTool(file="examples/RangedWeaponGuide.ts", code_type="engine")`

The guide (~470 lines) includes:
- Preset templates to copy (PISTOL, RIFLE, LAUNCHER, DUAL)
- Helper functions for barrels, grips, stocks, magazines
- Material classes for part materials (`createWeaponPartMaterial`) + legacy presets
- Complete revolver creation example

**Weapon Type Mapping:**

| User Request | Preset Template | Hands |
|--------------|-----------------|-------|
| Revolver, six-shooter, handgun, pistol | `PISTOL_PRESET_TEMPLATE` | 1 |
| Rifle, shotgun, carbine, SMG | `RIFLE_PRESET_TEMPLATE` | 2 |
| Bazooka, rocket launcher, RPG | `LAUNCHER_PRESET_TEMPLATE` | 2 |
| Dual pistols, akimbo | `DUAL_PISTOL_PRESET_TEMPLATE` | dual |

**Quick Steps:**
1. Read the guide file above
2. Copy the matching preset template
3. Customize name/damage/fireRate/color
4. Create a `createMesh` function using THREE.js — part materials via `createWeaponPartMaterial('<class>', { color })` from `engine/WeaponPartMaterial.js` (vocabulary: matte, cloth, fur, leather, wood, stone, plastic, paint, metal, gold, chrome, gem, glass, filament, neon, lava; glowing classes take `glow:`). Classes respect the `?matq=` quality ladder; raw metalness/roughness numbers do not.
5. Register: `RangedWeaponRegistry.register('weapon_id', { preset, createMesh })`

## Voxel Death & Damage Effects

**IMPORTANT: Use `npc.enableVoxelEffects()` instead of writing custom particle/fragment code.**

One call on any `NpcController` enables both death fragments and progressive damage visuals. The engine handles block character discovery, per-frame updates, and cleanup automatically.

```typescript
// Basic — all defaults (normal death, tint + jitter + chip-off on damage)
npc.enableVoxelEffects();

// With options
npc.enableVoxelEffects({
    deathVariant: 'explosion',    // 'normal' | 'ice' | 'explosion' | 'boss'
    deathFragmentCount: 16,       // default 12
    damageChipOff: false,         // disable chip-off fragments
});
```

**Death variants:**
- `normal` — standard scatter and duration
- `ice` — blue tint, slower scatter, crystalline feel
- `explosion` — faster scatter, larger radius
- `boss` — 2x fragments, longer duration

**Damage stages** (based on HP thresholds at 75%, 50%, 25%):
- Stage 0 (>75% HP): normal appearance
- Stage 1 (51-75%): slight red tint, mild jitter
- Stage 2 (26-50%): stronger tint, more jitter, chip-off fragments
- Stage 3 (<25%): heavy red/dark tint, intense jitter, body lean, constant particle chips

## Ragdoll death (alternative to the explosion)

`ragdollOnDeath` selects the limp-collapse death instead of exploding into debris: the
body's limbs go limp and collapse under gravity as a jointed physics ragdoll. It works
for the **player**, **NPCs**, and **animals** (humanoids get a ~10-bone skeleton; animals
get a coarse body+head+tail+legs skeleton). When set, it takes precedence over
`explodeOnDeath` — the explosion runs only as a fallback, if the ragdoll could not be built.

**The default differs by entity type.** An **NPC** ragdolls unless told otherwise; an **animal**
or **snake** explodes unless ragdoll is turned on; the **player** does neither unless ragdoll is
turned on. Set it explicitly at either level below whenever the choice matters.

**Global toggle (creator-facing, recommended).** Set it in `world.json` via the
`configure-game` tool — it applies to the player and to every NPC/animal spawned afterwards:

```
configure_game(configType="combat", ragdollOnDeath=true)
```

This writes `worldProfileData.combatConfig.ragdollOnDeath`. Each controller reads it as a
default at spawn; a per-entity setting (below) still wins.

**Ragdoll realism options** (also in `combatConfig`, set the same way). Both default **on** for best
quality — only touch them to turn a behaviour *off*:
- `ragdollJointLimits` (default **on**) — hinge the elbows/knees so the corpse keeps an articulated
  shape instead of folding flat like a house of cards.
- `ragdollSelfCollision` (default **on**) — limbs collide with each other / the torso so the body
  heaps in a pile instead of folding through itself. Self-collision on jointed bodies is the classic
  ragdoll instability; the physics safety net keeps it from halting the sim, but a particular
  character can look jittery — if so, turn it off:
  `configure_game(configType="combat", ragdollSelfCollision=false)`.

**Per-entity (code).**
- **Animals / snakes:** `animal.configure({ ragdollOnDeath: true })`.
- **Player:** `playerController.setRagdollOnDeath(true)`.
- **NPCs via `engine.registerNpc`:** pass `damageable`, which takes any
  `Partial<DamageableConfig>` (`maxHealth`, `health`, `canDie`, `explodeOnDeath`,
  `ragdollOnDeath`, `oneHitKill`, `debrisLifetimeMs`) and applies to every NPC of that type:
  `engine.registerNpc('ogre', new NpcEnemyBehavior(), { damageable: { ragdollOnDeath: true } })`.
  Unset fields fall back to `DEFAULT_DAMAGEABLE_CONFIG`.

Precedence for the death effect is: this spawn's own `damageable` setting → the creator's global
`combatConfig` → the engine default for that entity type.

**One-shot kill.** NPCs default to 100 HP. Either make the NPC die to any hit —
`engine.registerNpc(name, behavior, { damageable: { oneHitKill: true } })` — or raise the
projectile's damage so the shot exceeds their HP:
`rangedSystem.onProjectileCreated = p => p.setDamage(150)`.

**Knockback ("force impact") is automatic — the engine derives it from the hitter.** Death flows
`HealthComponent.takeDamage(amount, source, deathImpulse?)` → `onRagdoll(deathImpulse?)` →
`RagdollComponent` (engine: `character/RagdollComponent.ts`). You do **not** write per-bullet
impulse code. There are two regimes, and they don't share a knob:

- **Guns / melee (the killing blow):** the damage path builds the knockback from the source and
  applies it to the corpse's torso. For a gun it's the **projectile's own `knockback`** (a speed in
  m/s along the bullet's travel direction). Tune per-weapon punch in `onProjectileCreated`, e.g.
  `p.setDamage(150); p.setKnockback(10);` (default knockback ≈ 6 m/s; `0` = collapse straight down).
  Because it lives on the weapon, cranking a revolver's knockback never affects car/crate collisions.
- **Cars / crates / barrels (anything that stays in contact):** the ragdoll **physically collides**
  with vehicles and dynamic props (collision group `RAGDOLL`), so the Rapier solver transfers their
  real `mass·velocity` for free — a speeding car launches a corpse with honest momentum, no code and
  no knockback number. (Don't also push these in code — you'd double-count.)

So: set `p.setDamage(...)` for one-shot, optionally `p.setKnockback(...)` for punch, and **nothing
else**. Never query `__type:'ragdoll'` bodies and `applyImpulse` yourself — that fights the engine.

Notes: a player with ragdoll turned on ragdolls on death and is restored on `respawnAtStart()`; the spawn point itself
is readable via `playerController.getSpawnPosition()`. NPC/animal corpses
auto-clean after `debrisLifetimeMs`. Snakes have no jointed skeleton → fall back to the explosion.

> ⚠️ **Skinned NPCs (`characterUrl`) and the ragdoll/explosion source.** An NPC given a
> `generate_character` GLB renders the skinned GLB; its block character is hidden and is what the
> ragdoll/explosion is built from. The engine snapshots the live pose into the block character at
> death so the corpse spawns correctly — you don't need to do anything, but don't be surprised that
> the corpse is made of voxel blocks, not the GLB mesh.


## Hit and death effects

Effect factories return callbacks you assign to an entity's hooks — they are not
called directly.

```typescript
import { createBloodSplatterEffect, createCombatEffects } from 'engine/effects/index.js';
// createDeathExplosionEffect is not re-exported by the barrel — import it directly.
import { createDeathExplosionEffect } from 'engine/effects/HitEffects.js';

const animal = await createAnimal(scene, physics, engine, pos, 'Dog');
animal.onMeleeHitEffect = createBloodSplatterEffect(scene);
animal.onDeathEffect = createDeathExplosionEffect(scene, { createGroundSplat: true, splatSize: 3.0 });
```

Both take config: `createBloodSplatterEffect(scene, { color: 0x00ff00, particleCount: 30 })`.

`createCombatEffects` bundles both and takes an on-kill callback — use it to score:

```typescript
const effects = createCombatEffects(scene, () => questManager.recordAnimalKill());
animal.onMeleeHitEffect = effects.onMeleeHitEffect;
animal.onDeathEffect = effects.onDeathEffect;
```

A hook can do anything, so combine an effect with physics for a knockback:

```typescript
animal.onMeleeHitEffect = (pos, dir, dmg) => {
    createBloodSplatter(pos, dir);
    applyThrowForce(animal.getPhysicsBody(), dir, dmg);
};
```

### Damage flash

```typescript
const flash = new DamageFlash(myObject);
flash.trigger();        // e.g. from an onDamage callback
flash.trigger(2.0);     // custom intensity
```
