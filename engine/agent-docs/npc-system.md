# NPC System

This doc is everything an ordinary NPC task needs: register, pick a behavior, spawn. Four companion
docs cover the specialised halves — read one only when the task calls for it:

| Need | Doc |
|------|-----|
| What the NPC LOOKS like — block vs highres GLB, `createBlockNpcCharacter` colour fields, `createCustomizedNpcFactory`, animation packs | `@docs npc-appearance.md` |
| Enemies that fight, HP/damage tuning, death effects, ragdoll, exploding/detonating an NPC | `@docs npc-combat-death.md` |
| A respawning/bulk population of one type (`NpcManager`, manager behaviors) | `@docs npc-managers.md` |
| Walkable targets, detecting arrival, navmesh cell size | `@docs npc-navigation.md` |

> **Activation default:** every NPC is **always-active by default** — it keeps simulating and never falls through terrain even when off-screen. For mass/background NPCs, register with `importance: 'crowd'` (see "Importance tiers" below) — the engine manages their simulation cost automatically. `controller.setAlwaysActive(false)` remains for full manual control (the entity freezes entirely when off-camera), so use it ONLY for ambient NPCs in large worlds that are safe to freeze — distance alone is not a safe rule. See `@docs spawning-system.md` → "Entity Activation".

> **Player-overlap reaction:** by default an NPC **steps back (without turning, keeping its facing) when the player walks into it**, then resumes. This is automatic — do nothing for normal/social NPCs. For a **hostile/aggressive** NPC that should stand its ground or push toward the player instead, call `controller.setRetreatFromPlayerOverlap(false)` and let the combat behaviour drive the approach. (NPCs already re-plan their walking paths around the player automatically.)

## The Only API You Need

```typescript
// Register NPC — returns a handle for spawning
const handle = engine.registerNpc(name, behavior, options?);

// Spawn at coordinates
await handle.spawn(x, z);

// Spawn relative to a scene object
await handle.spawn({ objectId: 'tower_001', relation: SpawnRelation.ON_TOP });
```

The engine handles updates, disposal, and combat discovery automatically.

**Appearance in one line:** omit the appearance options and the NPC renders the engine's clean block
character — that is the default and the strongly preferred choice. Pass
`characterFactory: createBlockNpcCharacter({ shirt: 0x4F7A52 })` to recolour it. Only a large look
block cannot represent justifies a highres `generate_character` GLB, and then the WHOLE cast (player
+ every NPC type) goes highres together, never mixed. Full rules and the exact colour field names:
`@docs npc-appearance.md`.

## Importance tiers (hero vs crowd)

`registerNpc` options accept `importance: 'hero' | 'crowd'` (default `'crowd'`). It is also on `createAnimal`/`createSnake`, which still default to `'hero'`. **Pass `'hero'` explicitly for every gameplay-critical NPC** — an omitted `importance` gets the LOD-scaled crowd tier, so a boss left unmarked is simulated like a pedestrian:

- **`'crowd'`:** the engine scales AI/animation/physics rates with distance and visibility, and a far crowd NPC that is pursuing nothing hibernates entirely — frozen, costing nothing. Crowd NPCs that ARE pursuing something keep progressing; they never freeze mid-chase.
- **`'hero'`:** full simulation fidelity at any distance. For bosses, rivals, quest givers, escorts — anything gameplay-critical.
- **Choose from what the NPC IS, never from how many the game might have.** "Is this a named boss?" is answerable; "will this game exceed 200 NPCs?" is not, and the engine does not need you to guess. The tier is a hint — the scheduler may demote or promote under load anyway.
- Promote later with `handle.setImportance('hero')` on gameplay-critical events.

```typescript
const zombies = engine.registerNpc('zombie', new NpcChaseBehavior({ target: 'player' }), {
    characterFactory: createZombieNpcFactory(),
    importance: 'crowd',
});
for (let i = 0; i < 60; i++) await zombies.spawn(40 + Math.random() * 400, 40 + Math.random() * 400);
```

## One `registerNpc` name = one manager

> ⚠️ **`registerNpc(name, …)` is ONE manager per `name` — never call it twice with the same name.**
> Re-registering a name **replaces** its manager, and the NPCs you already spawned under the old one
> become orphaned: they stay in the scene but **never get `update()`** again, so they freeze in a
> **T-pose and stop moving** (a silent bug — no error). To spawn multiple instances, register the type
> **once** and call `handle.spawn()` N times.
>
> ```typescript
> // ❌ WRONG — same name in a loop: only the LAST NPC animates; the rest T-pose.
> for (let i = 0; i < 3; i++) {
>   const npc = engine.registerNpc('explorer', new NpcPatrolBehavior({ waypoints: ringAround(i) }), { characterUrl });
>   await npc.spawn(p.x, p.z);
> }
> ```
>
> If each instance needs its **own** behavior/waypoints, give each a **unique name** —
> `engine.registerNpc('explorer_' + i, new NpcPatrolBehavior({ waypoints: ringAround(i) }), { characterUrl })`
> then `spawn` — so each gets its own (updated) manager. (Sharing one behavior across `spawn()` calls
> means all instances share its waypoints.)

```typescript
// ✅ RIGHT — register the type once, spawn as many instances as you want:
const goblin = engine.registerNpc('goblin', new NpcEnemyBehavior(), { characterAssetId: '<goblin-asset-id>' });
for (let i = 0; i < 6; i++) await goblin.spawn(10 + i, 5);
```

## NPCs move like the player — for free

Every NPC registered via `engine.registerNpc()` inherits the player's full movement stack through `WalkingAndJumpingMovement`:

- Sprint
- Jump
- Double-jump
- Step climb (walk up small ledges)

You never need to write a Rapier dynamic body, capsule collider, grounded raycast, or jump code for a creature — `registerNpc()` wires all of that automatically. Pick the right behavior (wanders, follows, attacks) and the movement "just works". Speed can be tuned per-NPC at runtime via the controller's `setMoveSpeed(mps)` method.

## Quick Decision - NPC Type

Pick the behavior. Default look = clean block (`characterFactory` or nothing) — customize colours/
outfits there for small/simple looks. Only for a large look block cannot represent (and only as an
all-or-nothing highres cast) generate a highres GLB and pass its `characterAssetId`.

| Need | Behavior | Appearance |
|------|----------|------------|
| Friendly villager | `new NpcVillagerBehavior({ greetingMessages: [...] })` | clean block (`characterFactory`); GLB only if a specific look is asked |
| Idle/ambient | `new NpcIdleBehavior({ lookAtPlayer: true })` | clean block |
| Enemy (roams, chases, punches) | `new NpcEnemyBehavior()` | clean block; GLB on request — e.g. "snarling green goblin" |
| **Horde / many enemies converging on the player** | `new NpcChaseBehavior({ target: 'player' })` — converges only, **deals no damage**; for a horde that bites use `NpcEnemyBehavior` with a large `detectionRange` | clean block |
| Enemy guarding a spot | `new NpcHostileBehavior()` | clean block; GLB on request |
| Enemy with gun | `new RangedNpcBehavior({ weaponType: 'laser_blaster' })` | clean block; GLB on request — e.g. "white-armored space trooper" |
| Enemy with sword | `new NpcHostileBehavior({ weapon: { type: 'sword' }, attackRange: 2.4 })` | clean block; GLB on request — e.g. "armored knight with a helmet" |
| Following NPC | `new NpcFollowBehavior({ target: 'player' })` | clean block |
| Shopkeeper | `new NpcShopkeeperBehavior({ items: [...] })` | clean block; GLB on request — e.g. "regal merchant in royal robes" |
| **NPCs fighting each other** (battle royale, factions) | custom behavior around `NpcMeleeAttack` + `findTargets`; add `weapon: { type: 'axe' }` to arm them — `@docs npc-combat-death.md` | clean block |

The enemy behaviors chase and damage the player out of the box — their tuning options and the
mandatory health-bar call are in `@docs npc-combat-death.md`. Every built-in one fights the
**player only**; NPC-vs-NPC combat is a custom behavior, and that doc's "Custom fight behaviors"
section is required reading before writing one — a hand-rolled fight loop is why NPCs end up
damaging by proximity with no attack animation.

**Scale is handled for you.** `NpcEnemyBehavior` routes its chase through the shared goal field
automatically once several enemies pursue the same target, so a wandering-and-chasing enemy scales
without you choosing anything. Reach for `NpcChaseBehavior` when the NPCs exist ONLY to converge on
the player (a zombie horde, a swarm) — it skips the wander entirely and is the leaner behavior for
that job, not a performance workaround.

**Custom behaviors: implement `isEngaged()`.** The simulation tier uses it to decide whether a crowd
NPC far from both the camera and the player can hibernate. Return true only while actually
pursuing something — chasing, fleeing, running an errand. Returning true whenever the NPC is merely hostile keeps it simulating
forever at any distance, which is what makes a world full of enemies expensive. It is optional and
defaults to "engaged while holding a navigation target", which is correct for any behavior that only
sets a target when it has a reason to move.

## Example: Armed NPC

```typescript
import { RangedNpcBehavior, SpawnRelation } from 'engine/npc/index.js';

// characterAssetId is the manifest id of the generate_character GLB (one per NPC type).
const trooper = engine.registerNpc('trooper', new RangedNpcBehavior({
    weaponType: 'laser_blaster',
    shotInterval: 3.0,
}), {
    characterAssetId: '<minted-asset-id>',
});
await trooper.spawn(10, 5);
```

## Example: Interactable Villager

```typescript
import { NpcVillagerBehavior } from 'engine/npc/index.js';

const villager = engine.registerNpc('villager', new NpcVillagerBehavior({
    greetingMessages: ['Hello!', 'Welcome!', 'Nice day!'],
}), {
    characterAssetId: '<minted-asset-id>',
});
await villager.spawn(10, 5);
// Player presses E near villager → speech bubble appears
```

## Example: Custom Interactable Behavior

```typescript
import { NpcIdleBehavior } from 'engine/npc/index.js';
import { NpcSpeechBubble } from 'engine/npc/utils/NpcSpeechBubble.js';

class MyCustomBehavior extends NpcIdleBehavior {
    onPlayerInteract(): boolean {
        if (!this.controller) return false;
        const engine = this.controller.getEngine();
        const character = this.controller.getCharacter();
        new NpcSpeechBubble(character, engine, 'Hello!', 3000);
        return true;
    }
}

const npc = engine.registerNpc('custom', new MyCustomBehavior(), {
    characterAssetId: '<minted-asset-id>',
});
await npc.spawn(5, 8);
```

## Collect & flee (thief pattern)

Compose three existing primitives — **no custom physics**:

```typescript
import { NpcFollowBehavior } from 'engine/npc/index.js';
import { CarryableComponent } from 'engine/CarryableComponent.js';
import { getInteractionManager } from 'engine/InteractionManager.js';

// 1. NPC chases the target (carrot, gem, player, etc.) using player-equivalent movement
const rabbit = engine.registerNpc('rabbit', new NpcFollowBehavior({ target: carrotMesh, minDistance: 0.3 }));
await rabbit.spawn(5, 5);

// 2. Target is pickup-able via the standard carry system
new CarryableComponent(physicsWorld, { object3D: carrotMesh, displayName: 'carrot' });

// 3. React when a carryable/collectible is taken — update score, respawn, despawn rabbit, etc.
getInteractionManager().onCollected((objectId, name) => {
    // e.g., hud.updateCounter('score', ++score);  // counter created once via hud.createCounter('score', …)
});
```

## Example: Deferred Spawn (area trigger)

```typescript
// Register during load — no spawn yet. NpcHostileBehavior guards this spot and
// punches the player on sight, so show the health bar too.
this.hud.showHealth({ width: 200 });
const guard = engine.registerNpc('guard', new NpcHostileBehavior(), {
    characterAssetId: '<minted-asset-id>',
});

// Spawn later when player enters a zone
await guard.spawn(10, 5);
```

## Object-Relative Spawning

```typescript
import { SpawnRelation } from 'engine/npc/index.js';

const princess = engine.registerNpc('princess', new NpcIdleBehavior(), {
    characterAssetId: '<minted-asset-id>',
});
await princess.spawn({
    objectId: 'tower_001',
    relation: SpawnRelation.ON_TOP,
});
```

**SpawnRelation enum:** `ON_TOP`, `BESIDE`, `IN_FRONT`, `BEHIND`

> **Forward-axis note:** `IN_FRONT` / `BEHIND` are computed along the entity's local +Z column (its visible front under the +Z gameplay convention — see `@docs coordinate-system.md` §2). At `rotation.y = 0`, `IN_FRONT` offsets toward world +Z; rotate the entity to change which direction "front" points.

**Finding object IDs:** Objects in `gameData.environmentObjects` have `id` field (format: `object_timestamp_random`)

## registerNpc Options

| Option | Type | Description |
|--------|------|-------------|
| `characterFactory` | factory | **Default clean-block look.** Pass `createBlockNpcCharacter({ shirt: 0x4F7A52 })` / `blockNpcVariant(i)` from `./BlockNpcCharacter.js` to recolour the block NPC. Its five optional colour fields are **exactly** `skin`, `shirt`, `pants`, `shoes`, `eye` (hex numbers, passed flat, omitted ones fall back to `DEFAULT_BLOCK_NPC_COLORS`) — see "the complete field list" in `@docs npc-appearance.md`. Omit everything → engine's default block character. |
| `characterAssetId` | string | **Highres look — on demand only.** The minted asset id of a `generate_character` entry in `assets[]` (one per NPC type, shared across instances). Use ONLY when the user asks for a specific/custom appearance. Takes precedence over `characterFactory`. |
| `characterUrl` | string | Highres via a literal rigged-GLB url. Takes precedence over `characterAssetId`; use only when you have a url but no manifest id. |
| `characterModelRotationY` | number | Yaw correction in radians for a GLB authored facing the wrong way (`Math.PI` flips a back-to-front asset). Skinned meshes only — no effect on block NPCs. |
| `eyeLook` | `VxlEyeLook` | Eye colours for every NPC of this type, overriding what a rigged voxel character's eye record implies: `EVIL_VXL_EYE_LOOK` (black eyes, glowing red pupils) for monsters, or `{ ...DEFAULT_VXL_EYE_LOOK, pupil: 0x2060ff }` — both from `engine/loaders/VxlCharacterEyes.js`. No effect on a character without eye metadata. |
| `importance` | `'hero' \| 'crowd'` | Simulation tier (default: `'crowd'`). Pass `'hero'` for gameplay-critical NPCs (bosses, rivals, quest givers) — see "Importance tiers" above. |
| `autoRespawn` | boolean | Respawn when destroyed (default: false) |
| `onDeath` | callback | `(npcId, npcType, position) => void` |
| `damageable` | `Partial<DamageableConfig>` | Health/death tuning for every NPC of this type — `maxHealth`, `health`, `canDie`, `explodeOnDeath`, `ragdollOnDeath`, `oneHitKill`, `debrisLifetimeMs`. Unset fields fall back to `DEFAULT_DAMAGEABLE_CONFIG`. See "Death, damage, and removal hooks" in `@docs npc-combat-death.md`. |
| `planeLock` | boolean | Side-on 2D games lock every NPC to the gameplay plane by default; pass `false` ONLY for deliberate backdrop actors that keep their authored Z. Meaningless in 3D and top-down games. Never hand-roll plane constraints in game code. |

Those ten are the **whole** of `RegisterNpcOptions` — there is no per-NPC `speed`, `scale`, `color`,
`health` or `damageableConfig` option. Set move speed with `controller.setMoveSpeed(mps)` and HP with
`damageable: { maxHealth: n }`.

## Holding a pose (seated lean, one raised hand)

When an NPC must **hold** something the animation does not do — leaning toward the bar on its
stool, one hand raised beside the mouth while whispering — take a pose override. Never pose the
body parts by hand.

```typescript
// Anywhere you hold an NpcController — e.g. onNpcCreated(npc, engine) in a manager
// behavior (@docs npc-managers.md), or manager.getAllNpcs() / manager.getNpc(id).
const pose = npc.acquirePoseOverride({ parts: ['torso', 'neck', 'head'] });
if (pose) {
    // Offsets are ABSOLUTE, measured from the pose captured on install — setting the
    // same value every frame never deepens the lean.
    pose.setPartOffset('torso', {
        rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2),
    });
    // ONE hand reaches a world point; the other arm keeps swinging with the idle.
    pose.setHandTarget('right', npc.getPosition().clone().add(new THREE.Vector3(0.15, 1.45, 0.25)));
}
```

- **Owned parts are captured once** and held there, so the idle animation stops fighting the pose.
  Every part not listed in `parts` keeps animating.
- **`preserveRootHeight` (default true)** keeps the seated height. Otherwise the engine re-aligns the
  lowest block to the ground every frame, and a posed silhouette makes that shift the whole body —
  the character visibly sinks into the stool. **`preserveFeet` (default true)** keeps the feet planted.
- **`pose.setWeight(0..1)`** fades the whole pose in or out; **`pose.release()`** puts every captured
  part back exactly as it was and hands it to the animation again (automatic on NPC disposal).
- Defaults come from `DEFAULT_NPC_POSE_OVERRIDE_OPTIONS` in `engine/npc/core/NpcPoseOverride.js` —
  a seated upper-body lean. `npc.getPoseOverride()` returns the handle currently held, or null;
  acquiring a second one releases the first.
- **Never pose an NPC with `detachFromAnimation()` / `reattachToAnimation()`.** A detached part is
  not driven at all, so the caller inherits the base pose, the height and both arms — that is how a
  lean deepens every frame, the body sinks, and the second arm ends up dangling.
- Block-rendered NPCs only (the default look). A highres/skinned NPC's block character is a hidden
  proxy, so a pose written onto it is never drawn.

## Key Rules

- **Use `engine.registerNpc()` + `handle.spawn()`** — this is the only NPC API
- The engine handles update and dispose automatically — never call these manually
- **One `registerNpc` name = one manager** — never register the same name twice (see above); register the type once and `spawn()` N times
- **Appearance defaults to a clean block character** (`characterFactory: createBlockNpcCharacter(...)` / `blockNpcVariant(i)`, or nothing) — customize colours/outfits there for small/simple looks. Use a `generate_character` GLB via `characterAssetId` (or `characterUrl`) **only for a large look block cannot represent**
- **All-or-nothing:** never mix block and highres in one game. If any character goes highres, the player and every NPC type go highres together; otherwise the whole cast stays block
- Different NPC types should look different — recolour the block factory per type, or (in an all-highres cast) give each type its own `generate_character` GLB. One `generate_character` per type, shared across all its instances
- For following NPCs: use `target: 'player'` string (not object reference)
- NPC ranged/melee behaviors handle projectile/hit collision automatically
- **Damage flash, death explosion, ragdoll and bone-voxel shatter are all automatic** — see `@docs npc-combat-death.md` before writing any death effect by hand
- **Crowds of `.vxl` characters are cheap by design** — a `'crowd'`-tier NPC with a library `.vxl` body is drawn by one GPU-posed instanced batch per body type once it is outside LOD ring 0 (25 m by default), with its own skeleton taken out of the scene graph; it switches back to its articulated body as it comes near, keeps its pose across the swap, and leaves the batch on damage, death, a held weapon or a pose override. Nothing to wire up; the only cost that still scales per NPC is its AI and navigation, so spawn the crowd for the scene, not for the frame budget.
- **Destroying an NPC on cue** (interaction / timer / cutscene) → `controller.shatterIntoVoxels()`, then despawn. NEVER `Explosion` / `explodeTerrainSphere` / `explodeDebrisInRadius`. See *Destroying / detonating an NPC* in `@docs npc-combat-death.md`

## Making NPCs Interactable

NPCs are automatically interactable IF their behavior implements `onPlayerInteract()`. No additional setup needed.

1. `NpcController` implements `Interactable` interface automatically
2. NPCs register themselves as interactable when created
3. PlayerController detects NPCs within 3.0 unit range
4. Player presses E → `behavior.onPlayerInteract()` is called
