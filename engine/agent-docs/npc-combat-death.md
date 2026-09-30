# NPC Combat, Damage & Death

Enemies that fight, and everything that happens when an NPC dies. For registering and spawning an
NPC at all, see `@docs npc-system.md`.

## Built-in Melee Enemies

`NpcEnemyBehavior` and `NpcHostileBehavior` both chase the player and punch them for real
damage — no extra wiring, no weapon, no animation pack to load. They differ only in what
they do when the player is out of range: the enemy roams inside a box around its spawn
point, the hostile one walks back to its spawn and waits.

**Always call `this.hud.showHealth({ width: 200 })` when a game registers either
one**, or the player takes damage with nothing on screen to show it.

```typescript
import { NpcEnemyBehavior } from 'engine/npc/index.js';

this.hud.showHealth({ width: 200 });
const goblin = engine.registerNpc('goblin', new NpcEnemyBehavior({
    worldBounds: 20,      // roams within 10m of its spawn
    detectionRange: 12,
    damage: 15,
    chaseSpeed: 5,
}), { characterAssetId: '<minted-asset-id>' });
await goblin.spawn(10, 5);
```

| Option | Default | Meaning |
|--------|---------|---------|
| `detectionRange` | 10 | Distance at which the player is noticed. **`0` = never aggro** (a pure ambient wanderer). |
| `loseInterestRange` | `detectionRange * 1.5` | Distance at which it gives up. The gap keeps aggro from flickering. |
| `attackRange` | 2.0 | Distance at which it stops and swings. |
| `attackCooldown` | 1.5 | Seconds between punches. The player has no invulnerability frames, so five NPCs each land their own hit. |
| `damage` | 10 | Per landed punch. **`attacksPlayer: false`** gives a menacing chaser that never hurts. |
| `chaseSpeed` | 4.0 | Applied on aggro, restored when the player escapes. This overrides a `controller.setMoveSpeed()` the moment the NPC aggroes — to freeze an enemy, set `attacksPlayer: false` and `detectionRange: 0`, or swap its behavior; a zeroed move speed does not survive the first sighting. |
| `weapon` | — | `{ type: 'sword' }` arms it: the engine equips the weapon and its swings land the damage. Absent = bare fists. See "Giving them weapons". |
| `worldBounds` / `retargetInterval` | 15 / 5 | `NpcEnemyBehavior` only: width of the wander box around its spawn, and how often it re-picks. |

Contact is registered by the engine, not by the behavior: these behaviors register punch
and kick moves carrying `damage` and `range`, and `NpcController` tests the striking limb
against the player capsule at fixed points through the clip. So the hit follows the
animation — stepping out of reach or behind the NPC mid-strike makes it miss.

For a full fighting-game opponent (jab/hook/uppercut/roundhouse vocabulary plus the guard
stance) use `UnarmedNpcBehavior`; for an enemy that swings a visible weapon, give a custom
behavior a `weapon` (below); for one that shoots use `RangedNpcBehavior`, worked out in
`game/src/engine/npc/examples/EXAMPLE_RangedNpcBehavior.ts`.

## Custom fight behaviors — compose `NpcMeleeAttack`, never hand-roll ⭐

The built-in enemies fight the **player** and nobody else. A battle royale, a last-one-standing
arena, warring factions — anything where NPCs fight **each other** — needs a custom behavior.
Build that behavior around `NpcMeleeAttack`; it is the same helper `NpcEnemyBehavior` and
`NpcHostileBehavior` are built from, and it owns the two things a hand-rolled fight always
gets wrong:

> **`startAttack()` does nothing on an NPC that has no attack moves registered.** A fresh NPC
> has none. It logs `No attack animations available`, returns `{ success: false }`, and plays
> no clip. A custom behavior that calls `startAttack()` and then applies damage itself ships an
> enemy that **drains health by standing near the player with no swing on screen** — the single
> most common way generated combat looks broken. Damage must ride the registered move, not a
> hand-placed `takeDamage()`: `NpcController` tests the striking limb against the target's
> capsule through the clip, so a hit that misses, misses.

```typescript
import {
    NpcMeleeAttack, npcMeleeTarget, playerMeleeTarget,
    DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget,
} from 'engine/npc/index.js';
import type { NpcMeleeTarget } from 'engine/npc/index.js';

// The arena's roster — everyone still standing, built by the game, shared by every
// gladiator. `playerMeleeTarget` returns null when there is no player controller.
function fighters(): NpcMeleeTarget[] {
    return [
        playerMeleeTarget(engine.getPlayerController()),
        ...gladiators.map(npc => npcMeleeTarget(npc)),
    ].filter((t): t is NpcMeleeTarget => t !== null);
}

class GladiatorBehavior implements INpcBehavior {
    public focusOffsetY = DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
    private melee: NpcMeleeAttack | null = null;

    initialize(controller: ICharacterContext): void {
        this.melee = new NpcMeleeAttack({
            damage: 22,
            attackRange: 2.4,
            attackCooldown: 1.4,
            // The COMPLETE candidate list for this NPC. Dead targets and this NPC itself
            // are skipped; the nearest survivor wins, re-picked every frame.
            findTargets: () => fighters(),
        });
        this.melee.initialize(controller);
    }

    update(deltaTime: number, position: THREE.Vector3, _currentTarget: THREE.Vector3 | null): THREE.Vector3 | null {
        const engagement = this.melee!.update(deltaTime, position);
        // 'chase' → walk to targetPosition; 'attack' → null, hold still and swing.
        return engagement.state === 'chase' ? engagement.targetPosition : null;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    isHostile(): boolean { return true; }
    getName(): string { return 'Gladiator'; }
    dispose(): void { this.melee?.dispose(); this.melee = null; }
}
```

`NpcMeleeAttack` then handles aggro hysteresis, facing, chase speed, cooldown, loading the
strike clips on first aggro, and aiming the engine's contact test at the right victim
(`NpcController.setStrikeTarget()`). Tuning fields are the table above.

### Giving them weapons ⭐

Add `weapon` and the same helper fights armed — one field, nothing else to wire:

```typescript
this.melee = new NpcMeleeAttack({
    weapon: { type: 'axe' },   // any WeaponRegistry id: sword, axe, spear, mace, katana, …
    damage: 20,
    attackRange: 2.3,          // give a long weapon a matching range — see below
    findTargets: () => fighters(),
});
```

The engine then creates the weapon, holds it in the NPC's right hand, replaces its
locomotion with the weapon-carrying clips (from the moment it is drawn, so it *carries*
the thing while it patrols), registers **that weapon's** swings (an axe chops, a spear
thrusts — the same table the player's swings come from), and lands hits by sweeping the
blade, so a swing thrown while facing away misses. `dispose()` puts it away.

To change weapons at runtime, call `melee.setWeapon('axe')` on the helper — it re-draws
**and** re-registers the swing set. `NpcController.equipMeleeWeapon()` underneath is the
mesh half only; called directly it leaves the previous weapon's swings registered, so the
NPC keeps rolling clips for a weapon it is no longer holding.

The same field works on the built-in enemies, which take the same config — a sword-swinging
guard needs no custom behavior at all:

```typescript
new NpcHostileBehavior({ weapon: { type: 'sword' }, attackRange: 2.4, damage: 18 });
```

**Never attach a weapon mesh yourself next to an unarmed `NpcMeleeAttack`.** That is how an
NPC ends up **throwing punches while holding a sword**: the helper registers punch/kick
moves and the engine tests the fist, and the sword is scenery riding along. The mesh is not
what makes an NPC armed — `weapon` is.

**Match `attackRange` to the weapon.** It is both the distance the NPC closes to and how far
its swing reaches, so a spear wants ~3 and a dagger ~2. Leave a spear at the 2.0 default and
it walks into punching distance before swinging.

`EXAMPLE_MeleeNpcBehavior.ts` predates all of this and hand-rolls an armed fight —
aggro, swing timing, blade sweep and all — for the player only. Read it for how the pieces
fit; don't copy it. A behavior that runs its own sweep must **not** also use `weapon`, or
both sweeps land and every swing deals double damage.

### `MeleeNpcBehavior` options

| Option | Default | Description |
|--------|---------|-------------|
| `aggroRange` | 25 | Metres at which the NPC notices the player and starts chasing. Set it from the fight the user described: a boss that charges the moment you enter its arena needs the arena's size (e.g. 60), a corridor guard the default. Every NPC inside this range pathfinds, so keep crowds tight. |
| `returnToOrigin` | true | Walk back to the spawn point after the player escapes (past `aggroRange` x 1.25). Set false for an enemy that should hold wherever it lost the player. |
| `attackRange` | 2.5 | Metres at which it stops and swings. |
| `attackCooldown` | 1.5 | Seconds between swings. |
| `damage` | 25 | Damage per hit. |
| `chaseSpeed` | 4.0 | Movement speed while chasing. |
| `weaponType` | `'sword'` | Weapon look and reach — `sword`, `axe`, `spear`. |

## Automatic death effects

- **Damage flash is automatic** — disable with `npc.setDamageFlashEnabled(false)`.
- **Which death effect you get by default differs between NPCs and animals.** An **NPC** collapses
  into a **ragdoll** unless told otherwise; an **animal** or **snake** explodes into voxel cubes.
  Ragdoll always wins over the explosion when both are set — the explosion only runs as a fallback
  if the ragdoll could not be built (a snake has no jointed skeleton, so it always explodes).
  Set it explicitly at either level whenever the choice matters.
- **Death explosion** — `npc.setDebrisLifetime(ms)` (default 10s, `0` = permanent),
  `npc.getExplodedDebris()` returns the live `{ mesh, body }[]` after the explosion,
  `npc.removeDebrisPiece(mesh)` removes one. Same on animals.
- **Ragdoll death / one-shot kill / knockback** — for the full ragdoll story (joint limits,
  self-collision, corpse lifetime) see **"Ragdoll death"** in `@docs combat-system.md`. Enable or
  disable it globally with `configure_game(configType="combat", ragdollOnDeath=…)`, or per NPC type
  with `damageable` (below). One-shot either with `damageable: { oneHitKill: true }` or by raising
  the projectile's damage, `p.setDamage(...)`. The "impact force" knockback is **automatic** — the
  engine derives it from the hitter (bullet `p.setKnockback(mps)`, melee force) and vehicles/crates
  push corpses via the physics solver — so do **not** hand-roll per-bullet impulses.
- **Bone-voxel shatter (automatic)** — NPCs with a `generate_character` voxelized GLB break apart into
  limbs (head/torso/arms/legs): the pieces separate as rigid chunks at the death pose and **fall under
  gravity, bouncing off the ground and off each other**, and by default they **stay solid** — the
  stage-2 voxel burst is off (`limbBurst` defaults to `false`). A cosmetic
  splash of small coloured voxels (`splashColor`, default red, `splashCount` of them) sprays from the
  body as the parts separate. Nothing to wire up; tune with
  `npc.setBoneVoxelShatterOptions({ maxDebris, boneSpeedMin, boneSpeedMax, upwardBias,
  voxelScatterSpeed, maxAngularSpeed, limbs, limbBurst, limbImpactGraceSec, limbMaxLifetimeSec,
  splashCount, splashColor })` — `upwardBias`/`boneSpeed*` control how hard pieces are flung (0/small
  = just fall), `limbBurst: true` makes each chunk burst into its actual coloured voxels when it hits
  the **world** (ground/wall) — limb-vs-limb contacts just bounce,
  `splashCount: 0` removes the spray, `limbs: false` gives a direct voxel burst with no limb
  stage. This debris is self-managing (own TTL + cap) —
  `getExplodedDebris()`/`removeDebrisPiece()`/`setDebrisLifetime()` do not apply to it.

## Destroying / detonating an NPC ⭐

A "robot that explodes", "enemy that blows up", "self-destructing NPC",
"detonate on interact", etc. all mean **shatter the character into its own
voxels** — call `controller.shatterIntoVoxels()` then despawn it:

```typescript
onPlayerInteract(): boolean {
    if (!this.ctx) return false;
    this.ctx.shatterIntoVoxels(); // breaks the character apart (limbs separate and fall)
    const npcId = (this.ctx as NpcController).getNpcId?.() ?? null;
    const manager = this.ctx.getEngine().getNpcRegistry?.()?.get('robot') ?? null;
    setTimeout(() => (npcId ? manager?.despawnNpc(npcId) : manager?.despawnNpc()), 0);
    return true;
}
```

`shatterIntoVoxels()` lives on `ICharacterContext`, returns `true` on success,
and removes the character for you. Killing via `takeDamage` shatters
automatically — no extra code.

The shatter parses the voxel body the first time a body type needs it (tens of
ms on a detailed character). The engine does that parse on the NPC's first hit,
so a kill never pays it, and a crowd that is never fought never pays it at all.
An NPC you detonate on cue has no first hit — call `controller.prewarmShatter()`
on it during `load()` so the cutscene frame stays smooth. One call covers every
NPC of that body type.

**NEVER use `Explosion` (from `engine/Projectile.js`),
`VoxelTerrainSystem.explodeTerrainSphere()`, or
`VoxelDebrisManager.explodeDebrisInRadius()` to destroy an NPC.** Those are
WORLD/terrain destruction primitives — they spawn a fireball and carve a hole
in the ground where the NPC stood; they have nothing to do with the character
and leave the player standing in a crater. Reach for terrain destruction ONLY
when the request is explicitly about cratering the world, not a creature.

## Death, damage, and removal hooks

- **A kill builds nothing.** Each limb piece is baked ONCE per character asset in its anchor bone's
  frame (pose-independent), and the pieces' bodies, colliders and meshes live in a pool: a death
  re-enables six pooled pieces at the death-pose bone frames and flings them. The bake happens at
  `prewarmShatter()` (spawn time) or the first kill of that asset. Many kills in one frame — a rocket
  into a pack — are additionally spread over frames by `engine/effects/ShatterScheduler.ts` (8 ms of
  shatter per frame, then queue; a queued corpse stands frozen in its death pose for a few frames).
  Before this a kill skinned the death pose on the CPU and baked six geometries: ~100 ms, and a
  rocket kill was a 500 ms freeze. Nothing to configure.
- `npc.onDamage = (damage, currentHealth, maxHealth, source?) => …` — fires on EVERY hit (not just lethal). Use for health bars, hit reactions, aggro.
- `npc.onDeathEffect = (killerDirection?) => …` — fires once on death, before the configured ragdoll/explosion. Use for loot drops, score, death VFX.
- `INpcBehavior.onNpcDeath?()` — behavior-side death hook, fires before removal effects; use inside custom behaviors for cleanup (e.g. transferring in-flight projectiles).
- Query state via `npc.isDead()`, `npc.getHealth()`, `npc.getMaxHealth()`; apply damage via `npc.takeDamage(amount, source?)`.
- **Health/death tuning at registration** — pass `damageable` to `engine.registerNpc()`. Unset fields fall back to `DEFAULT_DAMAGEABLE_CONFIG` (`engine/IDamageable.js`, 100 HP), so name only what you change:

```typescript
engine.registerNpc('ogre', new NpcEnemyBehavior(), {
    damageable: { maxHealth: 250, ragdollOnDeath: true },
});
```

  Fields: `maxHealth`, `health`, `canDie`, `explodeOnDeath`, `ragdollOnDeath`, `oneHitKill`, `debrisLifetimeMs`.
  `maxHealth` alone spawns the NPC at full health at that max; pass `health` only for an NPC
  that should start wounded.
- Retune a LIVE NPC with `npc.setMaxHealth(n)` (difficulty scaling, buffs). It also refills health to the new max and revives a dead NPC.
- Heal without changing the ceiling via `npc.heal(amount)` — capped at max health, returns `false` if the NPC was already full or is dead. `onDamage` does NOT fire on a heal, so update health bars from the return value. `npc.resetHealth()` restores full health and revives.
- Corpse timing: `npc.setCorpseLifetimeMs(ms)` sets how long the body lingers after a ragdoll death — `<= 0` keeps it until `dispose()`, and it takes effect immediately so it also retunes a corpse already on the ground. At spawn that value comes from `damageable.debrisLifetimeMs`, which ALSO drives explosion-debris lifetime, so this setter is the only way to control the corpse independently.
- `npc.dispose()` removes an NPC immediately (scene + physics + behavior teardown) — for despawns unrelated to death.
