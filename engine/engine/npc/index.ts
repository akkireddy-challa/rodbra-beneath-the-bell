/**
 * NPC SYSTEM - For 2-Legged Humanoid Characters
 *
 * USE THIS FOR: enemy, villager, guard, warrior, wizard, shopkeeper, knight, soldier,
 *               and ANY 2-legged humanoid!
 *
 * DO NOT USE FOR: animals, pets, beasts, creatures (those are 4-LEGGED - use Animal System!)
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## Quick Start — engine.registerNpc() + handle.spawn()
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * `engine.registerNpc(name, behavior, options?)` registers the TYPE and returns a
 * handle; `handle.spawn(x, z)` puts an instance in the world (the engine finds the
 * ground for you) and `handle.spawn({ objectId, relation })` places it against a
 * scene object. The engine drives update and disposal — never call those yourself.
 * Enemy behaviors damage the player for real, so call `engine.getHUD().showHealth()`
 * when you use one. Worked examples: `@docs npc-system.md`.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## Spawning MULTIPLE NPCs (100 Zombies, Hordes, etc.)
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Each `handle.spawn()` call ADDS a new NPC to the manager, so a horde is one
 * `registerNpc` and N `spawn()` calls in a loop — never N `registerNpc` calls.
 * Registering the same name twice REPLACES its manager, and the NPCs already spawned
 * under the old one stop updating: they freeze in a T-pose with no error. Give each
 * instance its own name only when each needs its own behavior (`'explorer_' + i`).
 * Register mass NPCs with `importance: 'crowd'` so the engine scales their simulation
 * with distance — see "Importance tiers" below.
 * For a population that respawns, use `NpcManager` — see `@docs npc-managers.md`.
 *
 * Making NPCs Die on First Hit (One-Shot Kill): pass `damageable: { oneHitKill: true }`
 * to `registerNpc`. The whole `DamageableConfig` is documented in
 * `@docs npc-combat-death.md`; unset fields fall back to `DEFAULT_DAMAGEABLE_CONFIG`.
 *
 * COMMON MISTAKE: Double Explosion!
 *
 * Block-character NPCs ALREADY burst into their own voxels on death, and voxelized-GLB
 * NPCs already shatter bone-by-bone. Adding an `Explosion` (or `explodeTerrainSphere`)
 * in `onDeath`/`onDeathEffect` plays a second, unrelated blast AND craters the ground
 * where the NPC stood. Let the built-in death effect run; to destroy an NPC on cue use
 * `controller.shatterIntoVoxels()`, never a world-destruction primitive.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## Importance tiers — hero vs crowd (PERFORMANCE)
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * `registerNpc` options accept `importance: 'hero' | 'crowd'` (default 'hero').
 *
 * - 'crowd' (DEFAULT): pedestrians, fillers, hordes, ordinary enemies — the engine
 *   scales AI/animation/physics rates with distance, and a far crowd NPC pursuing
 *   NOTHING hibernates entirely. Crowd NPCs that are pursuing something keep
 *   progressing; they never freeze mid-chase.
 * - 'hero': full simulation fidelity at any distance — bosses, rivals, quest
 *   givers, escorts, anything gameplay-critical.
 * - Choose from what the NPC IS, never from how many the game might have. The
 *   tier is a hint; the scheduler may demote or promote under load anyway.
 * - Shared-target hordes chase via `new NpcChaseBehavior({ target: 'player' })` —
 *   all chasers sample one shared goal field instead of running per-NPC A*.
 * - Promote with `handle.setImportance('hero')` on gameplay-critical events.
 * - CUSTOM BEHAVIOURS: implement `isEngaged()` — the tier system reads it to decide
 *   whether a far crowd NPC can hibernate. Return true only while actually
 *   pursuing something. Reporting "engaged" whenever the NPC is merely hostile
 *   keeps it simulating forever at any distance.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## Available Appearance Presets
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * - `createVillagerNpcFactory()` - Brown/tan clothing
 * - `createWarriorNpcFactory()` - Armor, helmet, strong build
 * - `createWerewolfNpcFactory()` - Furry, pointed ears, tail
 * - `createWizardNpcFactory()` - Robes, hat, sparkles
 * - `createElfNpcFactory()` - Pointed ears, green clothing
 * - `createDemonNpcFactory()` - Horns, tail, red eyes
 * - `createRoyalNpcFactory()` - Crown, gold colors
 * - `createRobotNpcFactory()` - Metallic, gray
 * - `createCuteCreatureNpcFactory()` - Floppy ears, pastel colors
 * - `createRandomNpcFactory()` - Random appearance
 *
 * Different NPC types MUST have different appearances!
 *
 * Costume presets (see `customization/CostumePresets.ts`):
 * `createJediNpcFactory()`, `createSithNpcFactory()`, `createStormtrooperNpcFactory()`,
 * `createKnightNpcFactory()`, `createSoldierNpcFactory()`
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## NPC Behaviors
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * - `NpcEnemyBehavior` - Wanders near its spawn, chases and punches the player on sight
 * - `NpcChaseBehavior` - Hostile chase via shared goal field (`{ target: 'player' }`) — use for hordes
 * - `NpcVillagerBehavior` - Friendly, interactable with speech bubbles
 * - `NpcIdleBehavior` - Stays in place, can look at player
 * - `NpcFollowBehavior` - Follows player or target (use `target: 'player'`)
 * - `NpcPatrolBehavior` - Patrols between waypoints
 * - `NpcShopkeeperBehavior` - Shopkeeper with dialogue
 * - `NpcHostileBehavior` - Guards its spawn, chases and punches the player, returns home
 *
 * Both hostile behaviors deal damage out of the box — call `engine.getHUD().showHealth()`
 * so the player can see it, and pass `damage`/`attackCooldown`/`chaseSpeed` to tune them.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## Making NPCs Interactable (E Key)
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * NPCs are automatically interactable IF their behavior implements `onPlayerInteract()`.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## Following NPCs
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * `NpcFollowBehavior` follows the player when given the STRING `target: 'player'` —
 * not a mesh reference, which is the usual mistake. It also accepts any `Object3D`
 * as the target (a thief chasing the loot it steals), with `minDistance` setting how
 * close it gets. The thief pattern — follow, carry, react on pickup — is worked
 * through in `@docs npc-system.md` → "Collect & flee".
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## Combat: NPCs Can Be Hit
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * NPCs implement `IDamageable` — players can hit and damage them.
 * Melee detection uses raycasting (see engine/WeaponMeleeSystem.ts).
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## Armed NPCs - Ranged & Melee Weapons
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Ranged — `RangedNpcBehavior({ weaponType, shotInterval })`, see
 * `EXAMPLE_RangedNpcBehavior.ts`.
 *
 * Melee — `MeleeNpcBehavior({ weaponType })`, see `EXAMPLE_MeleeNpcBehavior.ts`.
 *
 * Projectile and hit detection are wired for you — don't add collision code.
 * Tuning and the unarmed behaviors are in `@docs npc-combat-death.md`.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## Custom NPC Appearance
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Default is a clean block character — no asset generation. Recolour it by passing
 * the genre's `createBlockNpcCharacter(...)` / `blockNpcVariant(i)` as the
 * `characterFactory` option. Its colour fields are exactly `skin`, `shirt`, `pants`,
 * `shoes` and `eye` — flat hex numbers, never nested, and no `*Color` suffix (that
 * vocabulary belongs to the different `createCustomizedNpcFactory` API).
 *
 * Only a large look block cannot represent justifies a highres `generate_character`
 * GLB, passed as `characterAssetId` — one generation per TYPE, shared by every
 * instance. Going highres is all-or-nothing: the player and every NPC type go
 * together, never mixed. Full rules and the authoritative field list:
 * `@docs npc-appearance.md`.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## Behavior Architecture: Custom Classes
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Create custom behavior classes when you need per-NPC initialize logic:
 *
 * Extend one of the behaviors above (commonly `NpcIdleBehavior`) and override
 * `initialize(controller)` for per-NPC setup or `onPlayerInteract()` for the E key.
 * Implementing `onPlayerInteract()` is all it takes to make the NPC interactable —
 * the prompt and the range check are automatic. A quest-giver worked through
 * end to end lives in `@docs npc-system.md` → "Example: Custom Interactable Behavior".
 *
 * ════════════════════════════════════════════════════════════════════════════════
 */

// Core classes
export { NpcController } from 'engine/npc/core/NpcController.js';
export { NpcManager } from 'engine/npc/core/NpcManager.js';
export type { SpawnNpcRelativeOptions } from 'engine/npc/core/NpcManager.js';
export { SpawnRelation } from 'engine/Spawner.js';
export type { CustomPositionFn } from 'engine/Spawner.js';
export { NpcRegistry } from 'engine/npc/core/NpcRegistry.js';
export type { NpcRegisterOptions, RegisterNpcOptions, RelativeSpawnConfig } from 'engine/npc/core/NpcRegistry.js';
export { NpcFactory } from 'engine/npc/core/NpcFactory.js';
export type { NpcHandle } from 'engine/npc/core/NpcHandle.js';
export { createNpcManager } from 'engine/npc/core/NpcManagerHelper.js';

// Interfaces
export type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
export { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
export { BaseNpcManagerBehavior, SimpleNpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';
export type { INpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';

// Behaviors (work with both NPCs and Animals)
export { NpcChaseBehavior } from 'engine/npc/behaviors/NpcChaseBehavior.js';
export { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';
export { NpcFollowBehavior } from 'engine/npc/behaviors/NpcFollowBehavior.js';
export { NpcHostileBehavior } from 'engine/npc/behaviors/NpcHostileBehavior.js';
export { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
export { NpcPatrolBehavior } from 'engine/npc/behaviors/NpcPatrolBehavior.js';
export { NpcShopkeeperBehavior } from 'engine/npc/behaviors/NpcShopkeeperBehavior.js';
// Compose these in a CUSTOM hostile behavior — a melee fight the built-in behaviors can't
// express, most often NPCs fighting each other. NpcMeleeAttack owns the strike animations
// and lets the engine register contact; hand-rolling either produces NPCs that damage by
// proximity with no swing to show for it. Pass its `weapon` config for an armed fighter —
// never attach a weapon mesh alongside an unarmed NpcMeleeAttack, which is how an NPC ends
// up throwing punches while holding a sword. See `@docs npc-combat-death.md`.
export { NpcMeleeAttack, resolveNpcMeleeAttackConfig, DEFAULT_NPC_MELEE_ATTACK } from 'engine/npc/behaviors/NpcMeleeAttack.js';
export type {
    NpcMeleeAttackConfig, NpcMeleeWeaponConfig, ResolvedNpcMeleeAttackConfig, NpcEngagement,
} from 'engine/npc/behaviors/NpcMeleeAttack.js';
export { playerMeleeTarget, npcMeleeTarget, segmentHitsTarget } from 'engine/npc/behaviors/NpcMeleeTarget.js';
export type { NpcMeleeTarget } from 'engine/npc/behaviors/NpcMeleeTarget.js';
// The engine-held weapon itself. Behaviors that drive their own attacks (rather than
// composing NpcMeleeAttack) arm an NPC through `NpcController.equipMeleeWeapon()`.
export { DEFAULT_NPC_MELEE_WEAPON } from 'engine/npc/core/NpcWeaponComponent.js';
export type { NpcMeleeWeaponOptions } from 'engine/npc/core/NpcWeaponComponent.js';

// Manager behaviors
export { NpcEnemyManagerBehavior } from 'engine/npc/manager-behaviors/NpcEnemyManagerBehavior.js';

// Customization (FOR HUMANOIDS ONLY - 2 legs, bipedal)
export { createCustomizedNpcFactory } from 'engine/npc/customization/NpcCustomization.js';
export type { NpcCustomizationConfig, NpcColorConfig, NpcEarConfig, NpcHornConfig, NpcTailConfig } from 'engine/npc/customization/NpcCustomization.js';
export {
    createWarriorNpcFactory,
    createWizardNpcFactory,
    createElfNpcFactory,
    createDemonNpcFactory,
    createCuteCreatureNpcFactory,
    createRobotNpcFactory,
    createRoyalNpcFactory,
    createRandomNpcFactory
} from 'engine/npc/customization/NpcCustomizationPresets.js';

// Visual systems (internal use - for advanced customization)
export { HumanoidVisualSystem } from 'engine/npc/visual/HumanoidVisualSystem.js';

// Example behaviors (copy and modify for your own NPCs!)
export { ExampleZombieBehavior } from 'engine/npc/examples/EXAMPLE_ZombieBehavior.js';
export {
    createZombieNpcFactory,
    createSkeletonNpcFactory,
    createGhoulNpcFactory
} from 'engine/npc/examples/EXAMPLE_ZombieFactory.js';

// Melee NPC example (NPCs with melee weapons - sword swing, hit detection)
export {
    MeleeNpcBehavior,
    DEFAULT_MELEE_NPC_AGGRO_RANGE,
    DEFAULT_MELEE_NPC_RETURN_TO_ORIGIN,
    createSwordNpcBehavior,
    createAxeNpcBehavior,
    createSpearNpcBehavior
} from 'engine/npc/examples/EXAMPLE_MeleeNpcBehavior.js';
export type { MeleeNpcConfig } from 'engine/npc/examples/EXAMPLE_MeleeNpcBehavior.js';

// Ranged NPC example (NPCs with guns/bows - shooting at player)
export { RangedNpcBehavior, RangedWeaponType as NpcRangedWeaponType } from 'engine/npc/examples/EXAMPLE_RangedNpcBehavior.js';
export type { RangedNpcConfig, RangedNpcWeaponType } from 'engine/npc/examples/EXAMPLE_RangedNpcBehavior.js';

// Costume presets (Jedi, Sith, Stormtrooper, Knight, Soldier)
export {
    CostumeType,
    COSTUME_CONFIGS,
    createJediNpcFactory,
    createSithNpcFactory,
    createStormtrooperNpcFactory,
    createKnightNpcFactory,
    createSoldierNpcFactory,
    getCostumeFactory,
    createCustomCostume
} from 'engine/npc/customization/CostumePresets.js';
export type { CostumeTypeId } from 'engine/npc/customization/CostumePresets.js';

