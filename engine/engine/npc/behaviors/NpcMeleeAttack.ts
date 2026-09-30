import * as THREE from 'three';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import type { BaseAnimationDefinition, CustomAttackMove } from 'types/game.js';
import { MELEE_WEAPON_ANIMATIONS, UNARMED_COMBAT_ANIMATIONS } from 'engine/AnimationPacks.js';
import { registerWeaponAttackMoves, unregisterWeaponAttackMoves } from 'engine/MeleeWeaponMoves.js';
import type { WeaponTypeId } from 'engine/WeaponRegistry.js';
import { DEFAULT_NPC_MELEE_WEAPON, type NpcMeleeWeaponOptions } from 'engine/npc/core/NpcWeaponComponent.js';
import { playerMeleeTarget, type NpcMeleeTarget } from 'engine/npc/behaviors/NpcMeleeTarget.js';

/**
 * NpcMeleeAttack - shared melee combat wiring for hostile NPC behaviors, armed or not.
 *
 * Handles the DECIDING half of a fight: target selection, aggro with hysteresis, facing,
 * chase speed, an attack cooldown, and throwing a strike. Contact is NOT its job —
 * `NpcController` registers hits engine-side (it watches the NPC's attack system and tests
 * the striking fist/foot, or the swung blade, against the target's capsule), so this
 * module's only contribution to damage is registering moves that carry `damage` and
 * `range`.
 *
 * Bare fists by default. Pass `weapon` and the same helper arms the NPC instead: the
 * engine creates and holds the weapon, the NPC's locomotion becomes the weapon-carrying
 * set, and its swings are the weapon's own moves — an axe chops, a spear thrusts, from the
 * same table the player's swings come from.
 *
 * Behaviors compose it (they do NOT extend it — the NPC inheritance chain is already
 * taken by `RangedNpcBehavior extends NpcEnemyBehavior`) and keep only their own "what
 * to do when disengaged" logic: `NpcEnemyBehavior` wanders near its spawn,
 * `NpcHostileBehavior` walks back to its origin.
 *
 * Siblings: `examples/EXAMPLE_UnarmedNpcBehavior.ts` is the full fighting-game version
 * (bigger strike vocabulary, guard stance); `examples/EXAMPLE_MeleeNpcBehavior.ts` predates
 * `weapon` and hand-rolls its whole armed fight, sweep included — read it for how the
 * pieces fit, but reach for `weapon` rather than copying it.
 *
 * ## Usage
 * Resolve the config in the behavior's constructor (`resolveNpcMeleeAttackConfig`), build
 * and initialize the helper in `initialize()` — never in the constructor, see the note on
 * the callers' `melee` field — then call `update()` first thing each frame and switch on
 * the `NpcEngagement` it returns. `NpcHostileBehavior` is the shortest worked example.
 *
 * ## Fighting someone other than the player
 * By default an NPC fights the player and nobody else. Pass `findTargets` to widen that to
 * any mix of the player and other NPCs (`playerMeleeTarget()` / `npcMeleeTarget()`), which
 * is what a free-for-all or a two-faction brawl needs. Compose this helper rather than
 * hand-rolling the fight: a custom behavior that calls `startAttack()` on its own gets no
 * animation at all until it registers attack moves, and applying damage itself produces an
 * NPC that hurts by proximity with nothing on screen to explain it.
 */

/** `loseInterestRange` defaults to this multiple of `detectionRange`. The gap is
 *  hysteresis: without it an NPC hovering exactly at the detection boundary
 *  engages and disengages every frame. */
const LOSE_INTEREST_FACTOR = 1.5;

/**
 * The strikes a built-in hostile NPC registers, keyed by pack clip NAME so they resolve
 * under whichever animation library is active (under the CDN library only Punching and
 * Kicking exist; the rest drop out). Deliberately a subset of the fighting-game set in
 * `EXAMPLE_UnarmedNpcBehavior` — a roaming goblin throws a punch or a kick, it does not
 * need a jab/hook/uppercut vocabulary.
 */
const STRIKES: ReadonlyArray<{ clipName: string; move: Omit<CustomAttackMove, 'animationMotionId'> }> = [
    { clipName: 'Punching', move: { name: 'npc_cross', type: 'punch', side: 'right' } },
    { clipName: 'Kicking', move: { name: 'npc_frontKick', type: 'kick', side: 'right' } },
];

/** Prefix for the moves this helper registers for a weapon, so they are recognisable in
 *  `getRegisteredAttackMoves()` and cannot collide with a template's own names. */
const WEAPON_MOVE_PREFIX = 'npc_weapon:';

/** Attempts made to put the weapon in the NPC's hand, and the gap between them.
 *  The hand is normally there the moment `initialize()` runs; these cover a character
 *  whose skeleton lands late, the case the player's equip retries five times for. */
const WEAPON_EQUIP_ATTEMPTS = 5;
const WEAPON_EQUIP_RETRY_SECONDS = 0.2;

/** The weapon half of the config — see `NpcMeleeAttackConfig.weapon`. */
export interface NpcMeleeWeaponConfig {
    /** Weapon id from `WeaponRegistry` — a built-in (`'sword'`, `'axe'`, `'spear'`, …) or
     *  one the template registered. Unknown ids fall back to the sword. */
    type: WeaponTypeId;
}

export interface NpcMeleeAttackConfig {
    /** Distance at which the NPC notices the player and starts chasing (default 10).
     *  `0` disables engagement entirely — the NPC never aggros, chases, or attacks. */
    detectionRange?: number;
    /** Distance at which an engaged NPC gives up (default: `detectionRange * 1.5`). */
    loseInterestRange?: number;
    /** Distance at which the NPC stops and strikes (default 2.0). Also rides on each
     *  registered move as its `range`, so the engine's hit test reaches exactly as far
     *  as the behavior's decision to attack. */
    attackRange?: number;
    /** Seconds between strikes, per NPC (default 1.5). The player has no invulnerability
     *  frames, so this per-attacker cooldown is the only thing rate-limiting damage —
     *  N NPCs surrounding the player each land their own hit. */
    attackCooldown?: number;
    /** HP the target loses per landed hit (default 10). Rides on each registered move;
     *  `NpcController` reads it when the limb connects. */
    damage?: number;
    /** Move speed while chasing, m/s (default 4.0). The NPC's pre-aggro speed is
     *  captured on engage and restored on disengage/dispose. */
    chaseSpeed?: number;
    /** When false the NPC still detects, chases and faces its target but never strikes
     *  (default true). Named for the player because that is the only target the built-in
     *  behaviors have; it gates strikes against every target. */
    attacksPlayer?: boolean;
    /**
     * Arm this NPC with a visible melee weapon it actually fights with.
     *
     * Omitted — the default — the NPC fights bare-handed: it throws punches and kicks, and
     * the engine tests its fist against the target. Supplied, the whole armed path is wired
     * for you: the engine creates and holds the weapon (`NpcController.equipMeleeWeapon`),
     * this helper loads `MELEE_WEAPON_ANIMATIONS` so the NPC both carries and swings it,
     * registers that weapon's swing set, and the engine's contact test follows the blade
     * instead of the fist.
     *
     * `damage` and `attackRange` above still apply — they ride on the registered moves the
     * same way, so the weapon's reach is the distance at which the NPC decided to attack.
     * Give a long weapon a matching `attackRange` (a spear wants ~3, a dagger ~2) or it
     * will close to punching distance before it swings.
     *
     * Do NOT combine this with a behavior that attaches its own weapon mesh and runs its
     * own blade sweep (the `EXAMPLE_MeleeNpcBehavior` pattern): both sweeps would land and
     * every swing would deal double damage.
     */
    weapon?: NpcMeleeWeaponConfig;
    /**
     * Who this NPC is willing to fight. Omitted — the default — it fights the player and
     * nobody else, which is what the built-in hostile behaviors want.
     *
     * Supply a resolver for free-for-all or faction games. The array it returns is the
     * COMPLETE candidate set for that frame, so include `playerMeleeTarget(...)` when the
     * player is fair game; wrap other NPCs with `npcMeleeTarget(...)`. It is called once
     * per frame per NPC — return a cached array rather than rebuilding one per NPC. Dead
     * candidates and this NPC itself are skipped, and the nearest survivor wins.
     */
    findTargets?: () => readonly NpcMeleeTarget[];
}

/**
 * The config with every tuning field filled in. `findTargets` and `weapon` stay optional:
 * their absence is the meaningful default (fight the player only; fight bare-handed) and
 * no value could stand in for either — the player is reached through the controller, which
 * the config is resolved without, and there is no "no weapon" weapon.
 */
export type ResolvedNpcMeleeAttackConfig =
    Required<Omit<NpcMeleeAttackConfig, 'findTargets' | 'weapon'>>
    & Pick<NpcMeleeAttackConfig, 'findTargets' | 'weapon'>;

export const DEFAULT_NPC_MELEE_ATTACK: Readonly<Omit<ResolvedNpcMeleeAttackConfig, 'loseInterestRange' | 'findTargets' | 'weapon'>> = {
    detectionRange: 10.0,
    attackRange: 2.0,
    attackCooldown: 1.5,
    damage: 10,
    chaseSpeed: 4.0,
    attacksPlayer: true,
};

/**
 * Fill in defaults once. Behaviors resolve in their constructor and keep the result,
 * so `clone()` can forward every field already resolved — cloning a behavior
 * configured with `detectionRange: 30` must not silently reset its derived
 * `loseInterestRange` back to the default range's 15.
 */
export function resolveNpcMeleeAttackConfig(config?: NpcMeleeAttackConfig): ResolvedNpcMeleeAttackConfig {
    // `??` throughout, never `||`: `damage: 0` and `detectionRange: 0` are meaningful.
    const detectionRange = config?.detectionRange ?? DEFAULT_NPC_MELEE_ATTACK.detectionRange;
    return {
        detectionRange,
        loseInterestRange: config?.loseInterestRange ?? detectionRange * LOSE_INTEREST_FACTOR,
        attackRange: config?.attackRange ?? DEFAULT_NPC_MELEE_ATTACK.attackRange,
        attackCooldown: config?.attackCooldown ?? DEFAULT_NPC_MELEE_ATTACK.attackCooldown,
        damage: config?.damage ?? DEFAULT_NPC_MELEE_ATTACK.damage,
        chaseSpeed: config?.chaseSpeed ?? DEFAULT_NPC_MELEE_ATTACK.chaseSpeed,
        attacksPlayer: config?.attacksPlayer ?? DEFAULT_NPC_MELEE_ATTACK.attacksPlayer,
        findTargets: config?.findTargets,
        weapon: config?.weapon,
    };
}

/** What the owning behavior should do with this frame's movement target. */
export type NpcEngagement =
    | { readonly state: 'disengaged' }
    /** Target seen but out of reach — move toward `targetPosition` (already a clone,
     *  safe to hand straight back from `update()`). */
    | { readonly state: 'chase'; readonly targetPosition: THREE.Vector3; readonly target: NpcMeleeTarget }
    /** In reach or mid-strike — the behavior must return `null` so the NPC holds still. */
    | { readonly state: 'attack'; readonly targetPosition: THREE.Vector3; readonly target: NpcMeleeTarget };

const DISENGAGED: NpcEngagement = { state: 'disengaged' };
const EMPTY_TARGETS: readonly NpcMeleeTarget[] = [];

/**
 * The subset of `NpcController` this module needs. `ICharacterContext` cannot grow a
 * `getAnimationController()` member: `AnimalController` already has one returning a
 * different type, so declaring it on the shared interface would fail to compile there.
 */
interface NpcAnimationController {
    startAttack?: () => { success: boolean; duration: number };
    loadAnimationPack?: (
        animations: BaseAnimationDefinition[],
        options?: { addToAttackCollection?: boolean; replaceLocomotion?: boolean },
    ) => Promise<void>;
    registerCustomAttack?: (move: CustomAttackMove) => boolean;
    unregisterCustomAttack?: (name: string) => boolean;
    getRegisteredAttackMoves?: () => string[];
}
/** An animation controller that can register moves — what `loadStrikes()` has already
 *  established before it picks the armed or unarmed set. */
type RegisteringAnimationController = NpcAnimationController & {
    registerCustomAttack: NonNullable<NpcAnimationController['registerCustomAttack']>;
};

/**
 * The one thing this module needs from navigation. Declared here rather than on
 * `ICharacterContext` for the same reason as the animation host above: not every context
 * that can fight can also path (an animal steers itself), and an optional member keeps
 * both compiling.
 */
interface NpcNavigationHost {
    isFollowingPath?: () => boolean;
}

interface NpcAnimationHost {
    getAnimationController?: () => NpcAnimationController | null;
    /** Present on `NpcController`: aims the engine's limb-vs-capsule contact test at
     *  someone other than the player. Absent on `AnimalController`. */
    setStrikeTarget?: (target: NpcMeleeTarget | null) => void;
    /** Present on `NpcController`: the engine-held weapon. Absent on `AnimalController`,
     *  which is why a `weapon` config on an animal simply leaves it unarmed rather than
     *  throwing — an animal has no hand to put a sword in. */
    equipMeleeWeapon?: (options: NpcMeleeWeaponOptions) => boolean;
    unequipMeleeWeapon?: () => void;
    /** The authority on whether this NPC is armed — never mirrored into a local flag, so
     *  a weapon removed behind this helper's back cannot leave it registering swings the
     *  engine will refuse to land. */
    hasMeleeWeapon?: () => boolean;
    getMeleeWeaponGrip?: () => 'one' | 'two';
}

/** A candidate and everything the frame's decisions need about it. */
interface AimedTarget {
    readonly target: NpcMeleeTarget;
    /** The target's own live vector — clone before storing or returning. */
    readonly position: THREE.Vector3;
    readonly distance: number;
}

export class NpcMeleeAttack {
    private readonly config: ResolvedNpcMeleeAttackConfig;
    private controller: ICharacterContext | null = null;

    private engaged: boolean = false;
    private cooldownTimer: number = 0;
    /** Seconds left of the strike the NPC is currently planted for. */
    private strikeHoldTimer: number = 0;

    /** The NPC's move speed before aggro, or null when not currently overridden.
     *  Doubles as the "speed is ours to restore" flag, which makes restore idempotent. */
    private baseMoveSpeed: number | null = null;

    /** In-flight (or settled) animation load; also the "already requested" flag. */
    private animationLoad: Promise<void> | null = null;

    /** Names of the swings registered for the weapon currently held, so a swap can take
     *  them back out of the random-pick pool. Empty while unarmed. */
    private registeredWeaponMoves: string[] = [];

    /** Equip attempts still owed, and the countdown to the next one. Both zero once the
     *  weapon is in hand — or once we have given up and said so. */
    private equipAttemptsLeft = 0;
    private equipRetryTimer = 0;

    /** Scratch list backing the player-only default — see `defaultTargets()`. */
    private readonly defaultTargetList: NpcMeleeTarget[] = [];

    constructor(config?: NpcMeleeAttackConfig) {
        this.config = resolveNpcMeleeAttackConfig(config);
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.engaged = false;
        this.cooldownTimer = 0;
        this.strikeHoldTimer = 0;
        this.baseMoveSpeed = null;
        this.registeredWeaponMoves = [];
        this.equipAttemptsLeft = this.config.weapon ? WEAPON_EQUIP_ATTEMPTS : 0;
        this.equipRetryTimer = 0;
        this.tryEquipWeapon();
    }

    /**
     * Swap this NPC's weapon at runtime — draws the new one AND re-registers its swings,
     * so an NPC handed an axe stops swinging its old sword's clips.
     *
     * The supported way to change weapons. `NpcController.equipMeleeWeapon()` underneath is
     * the mesh half only: called directly it leaves the previous weapon's moves registered,
     * and the caller owns putting that right.
     */
    setWeapon(type: WeaponTypeId): boolean {
        if (!this.controller) return false;
        this.config.weapon = { type };
        this.equipAttemptsLeft = WEAPON_EQUIP_ATTEMPTS;
        this.equipRetryTimer = 0;
        if (!this.tryEquipWeapon()) return false;
        // Only re-register when the pack is already in — otherwise the load that is still
        // to come registers the new weapon's moves itself, and doing it twice would
        // register them twice.
        if (this.animationLoad) this.syncWeaponMoves();
        return true;
    }

    /** True while the ENGINE holds this NPC's weapon. Read through the host rather than
     *  cached, so game code that disarms the NPC directly can't leave this helper
     *  registering weapon swings the engine will refuse to land. */
    private isArmed(): boolean {
        return this.getHost()?.hasMeleeWeapon?.() ?? false;
    }

    /**
     * Hand the engine this NPC's weapon, if it has one. At initialize() rather than on
     * first aggro: a guard should be holding its axe while it patrols, not draw it the
     * instant it notices you.
     *
     * @returns whether the NPC is armed now — false while retries remain, and permanently
     *          false for a host with no hand to hold a weapon (an animal).
     */
    private tryEquipWeapon(): boolean {
        const weapon = this.config.weapon;
        if (!weapon || this.equipAttemptsLeft <= 0) return false;

        this.equipAttemptsLeft -= 1;
        const equipped = this.getHost()?.equipMeleeWeapon?.({
            ...DEFAULT_NPC_MELEE_WEAPON,
            type: weapon.type,
            damage: this.config.damage,
            reach: this.config.attackRange,
        }) ?? false;

        if (equipped) {
            this.equipAttemptsLeft = 0;
            // Weapon clips are loaded eagerly, unlike the lazy unarmed ones: this NPC is
            // going to fight with the thing in its hand, and `replaceLocomotion` is what
            // makes it CARRY the weapon rather than drag one around an empty-handed walk
            // cycle for however long it takes to notice a target.
            this.ensureStrikesRegistered();
            return true;
        }

        if (this.equipAttemptsLeft <= 0) {
            // Never silent: without this the NPC just fights bare-handed forever, which
            // is indistinguishable from having configured no weapon at all.
            console.warn(
                `[NpcMeleeAttack] could not equip '${String(weapon.type)}' — no right hand on this `
                + 'character. The NPC will fight unarmed.',
            );
        }
        return false;
    }

    /** Retry a failed equip on the frames after initialize(), for a character whose
     *  skeleton was not ready yet. No-op once armed or once the attempts run out. */
    private updateEquipRetry(deltaTime: number): void {
        if (this.equipAttemptsLeft <= 0) return;
        this.equipRetryTimer -= deltaTime;
        if (this.equipRetryTimer > 0) return;
        this.equipRetryTimer = WEAPON_EQUIP_RETRY_SECONDS;
        this.tryEquipWeapon();
    }

    /**
     * One frame of detect → face → chase → strike. Call first in the owning behavior's
     * `update()`, then act on the returned engagement.
     */
    update(deltaTime: number, npcPosition: THREE.Vector3): NpcEngagement {
        this.updateEquipRetry(deltaTime);
        this.cooldownTimer = Math.max(0, this.cooldownTimer - deltaTime);
        this.strikeHoldTimer = Math.max(0, this.strikeHoldTimer - deltaTime);

        if (!this.controller) return DISENGAGED;

        const aimed = this.selectTarget(npcPosition);
        if (!aimed) {
            this.disengage();
            return DISENGAGED;
        }

        if (this.engaged) {
            if (aimed.distance > this.config.loseInterestRange) {
                this.disengage();
                return DISENGAGED;
            }
        } else if (this.config.detectionRange > 0 && aimed.distance <= this.config.detectionRange) {
            this.engage();
        } else {
            return DISENGAGED;
        }

        // Planted for the length of the strike clip so the NPC doesn't slide mid-punch.
        if (this.strikeHoldTimer > 0) {
            this.faceTarget(npcPosition, aimed.position);
            return this.engagement('attack', aimed);
        }

        if (aimed.distance <= this.config.attackRange) {
            this.faceTarget(npcPosition, aimed.position);
            if (this.config.attacksPlayer && this.cooldownTimer <= 0) {
                this.startStrike(aimed.target);
            }
            return this.engagement('attack', aimed);
        }

        // Chasing: face the target only while nothing else is steering the body. A
        // path-following NPC must be free to turn along its route — movement is projected
        // onto the facing, so a chaser held pointing at the player cannot walk the detour a
        // navmesh hands it around a wreck, commanded movement reads (0, 0) every frame and
        // it stands there apparently stuck. But an NPC nothing is steering (no navmesh, a
        // pending path, or simply standing its ground) owns its own facing, or it never
        // turns to its target at all and strikes whatever direction it arrived facing.
        if (!this.isSteeredByPath()) {
            this.faceTarget(npcPosition, aimed.position);
        }
        return this.engagement('chase', aimed);
    }

    /** This frame's engagement for an aimed target. The position is cloned on the way out
     *  so a caller holding onto it cannot alias the target's live vector. */
    private engagement(state: 'chase' | 'attack', aimed: AimedTarget): NpcEngagement {
        return { state, targetPosition: aimed.position.clone(), target: aimed.target };
    }

    /** True while a navigation path is walking this NPC somewhere. */
    private isSteeredByPath(): boolean {
        const host = this.controller as NpcNavigationHost | null;
        return host?.isFollowingPath?.() === true;
    }

    /**
     * The nearest living thing this NPC may fight, or null when there is nothing to fight.
     * Re-picked every frame: in a free-for-all the nearest fighter changes as bodies drop,
     * and re-picking is also what makes an NPC give up on a target that dies in front of it.
     */
    private selectTarget(npcPosition: THREE.Vector3): AimedTarget | null {
        const candidates = this.config.findTargets?.() ?? this.defaultTargets();
        let best: AimedTarget | null = null;
        for (const target of candidates) {
            if (target.isDead()) continue;
            const position = target.getPosition();
            if (!position) continue;
            // Guards against a resolver that hands back the whole roster including this
            // NPC — self is always at distance 0 and would otherwise win every time.
            if (position === npcPosition) continue;
            const distance = npcPosition.distanceTo(position);
            if (!best || distance < best.distance) best = { target, position, distance };
        }
        return best;
    }

    /** No `findTargets` configured: the player, and nobody else. Reuses its one-element
     *  array — this runs every frame for every hostile NPC in the world. */
    private defaultTargets(): readonly NpcMeleeTarget[] {
        const player = playerMeleeTarget(this.controller?.getEngine().getPlayerController());
        if (!player) return EMPTY_TARGETS;
        if (this.defaultTargetList[0] !== player) this.defaultTargetList[0] = player;
        return this.defaultTargetList;
    }

    /** Un-plant the NPC mid-strike — call from the behavior's `onHit()` so a staggered
     *  NPC resumes moving. Contact is engine-scheduled off the animation, so this stops
     *  the NPC standing still, not the strike already in flight. */
    cancelSwing(): void {
        this.strikeHoldTimer = 0;
    }

    /** Restores the pre-aggro move speed, puts the weapon away, and releases the
     *  controller. Idempotent. */
    dispose(): void {
        this.restoreMoveSpeed();
        // Drop the engine's aim so a pooled/respawned controller doesn't inherit a
        // reference to whoever this NPC was last swinging at.
        this.getHost()?.setStrikeTarget?.(null);
        if (this.config.weapon) {
            const animController = this.getAnimationController();
            // Before the unequip, while the moves are still ours to name: a controller
            // that outlives this helper (behavior swap) must not keep swings for a
            // weapon that is no longer in its hand.
            if (animController) unregisterWeaponAttackMoves(animController, this.registeredWeaponMoves);
            this.getHost()?.unequipMeleeWeapon?.();
        }
        this.registeredWeaponMoves = [];
        this.equipAttemptsLeft = 0;
        this.strikeHoldTimer = 0;
        this.engaged = false;
        this.controller = null;
    }

    private engage(): void {
        this.engaged = true;
        const controller = this.controller;
        if (!controller) return;
        if (this.baseMoveSpeed === null) {
            // Captured here rather than in initialize() because the template may change
            // the NPC's speed after construction. Known corner: a setMoveSpeed() call
            // made *during* aggro is discarded on disengage.
            this.baseMoveSpeed = controller.getMoveSpeed();
            controller.setMoveSpeed(this.config.chaseSpeed);
        }
        this.ensureStrikesRegistered();
    }

    private disengage(): void {
        this.engaged = false;
        this.cancelSwing();
        this.restoreMoveSpeed();
    }

    private restoreMoveSpeed(): void {
        if (this.baseMoveSpeed === null) return;
        this.controller?.setMoveSpeed(this.baseMoveSpeed);
        this.baseMoveSpeed = null;
    }

    private faceTarget(npcPosition: THREE.Vector3, target: THREE.Vector3): void {
        const character = this.controller?.getCharacter();
        if (!character) return;
        const dx = target.x - npcPosition.x;
        const dz = target.z - npcPosition.z;
        if (dx * dx + dz * dz < 1e-6) return;
        // Gameplay convention: +Z is forward, so yaw is atan2(x, z). See docs/coordinate-system.md.
        character.rotation.y = Math.atan2(dx, dz);
    }

    /**
     * Throw a strike — a punch, a kick, or a swing of the held weapon, depending on which
     * moves got registered. Damage is NOT applied here: `startAttack()` picks one of the
     * registered moves, and `NpcController` registers the contact for it engine-side
     * using the `damage`/`range` those moves carry. A strike thrown before the clips
     * finish loading returns `success: false` and simply doesn't connect — the next
     * one, a cooldown later, does.
     */
    private startStrike(target: NpcMeleeTarget): void {
        // Point the engine's contact test at whoever we picked, BEFORE the swing starts:
        // the hit checks are scheduled off `startAttack()` and read the target when they
        // fire. Without this every strike would be tested against the player.
        this.getHost()?.setStrikeTarget?.(target);
        // Cooldown starts at strike START, so the rate is one strike per attackCooldown
        // whether or not it lands.
        this.cooldownTimer = this.config.attackCooldown;
        const result = this.getAnimationController()?.startAttack?.();
        this.strikeHoldTimer = result?.success ? result.duration : 0;
    }

    private getHost(): NpcAnimationHost | null {
        return this.controller as unknown as NpcAnimationHost | null;
    }

    private getAnimationController(): NpcAnimationController | null {
        return this.getHost()?.getAnimationController?.() ?? null;
    }

    /**
     * Unarmed strike clips load on first aggro rather than at initialize(): the frozen
     * `RangedNpcBehavior` and `ExampleZombieBehavior` examples extend `NpcEnemyBehavior`
     * and call `super.initialize()`, and a gunner that never throws a punch should not
     * pay for the skeleton retargets. The chase from detection range to attack range
     * covers the load. An ARMED NPC calls this from the equip instead — see
     * `tryEquipWeapon` for why its clips cannot wait for aggro.
     */
    private ensureStrikesRegistered(): void {
        if (this.animationLoad) return;
        this.animationLoad = this.loadStrikes().catch((error: unknown) => {
            console.error('[NpcMeleeAttack] failed to load strike animations:', error);
        });
    }

    private async loadStrikes(): Promise<void> {
        const animController = this.getAnimationController();
        if (!animController?.registerCustomAttack) return;

        // A template that already gave this NPC its own moves owns its combat.
        if ((animController.getRegisteredAttackMoves?.() ?? []).length > 0) return;

        // The guard above is what makes this true; narrowing an optional METHOD doesn't
        // narrow the object holding it, so the two loaders can't be handed the raw type.
        const registering = animController as RegisteringAnimationController;
        if (this.isArmed()) {
            await this.loadWeaponSwings(registering);
        } else {
            await this.loadUnarmedStrikes(registering);
        }
    }

    private async loadUnarmedStrikes(animController: RegisteringAnimationController): Promise<void> {
        // Strikes only — no `FightingIdle`, and so no `replaceLocomotion`. These are
        // roamers and guards, not brawlers; a boxing guard stance would look wrong on a
        // wandering enemy. `UnarmedNpcBehavior` is the one that wants the stance.
        const pack = UNARMED_COMBAT_ANIMATIONS.filter(a => !a.name.toLowerCase().includes('idle'));
        if (animController.loadAnimationPack) {
            // No `addToAttackCollection` — it would bind one clip as the character's sole
            // ATTACK state override. Registering the moves is what makes startAttack()
            // pick between them, exactly as UnarmedMeleeSystem does for the player.
            await animController.loadAnimationPack(pack);
        }

        // Disposed while the pack was loading.
        if (!this.controller) return;

        const idByName = new Map(pack.map(a => [a.name, a.motionId]));
        for (const { clipName, move } of STRIKES) {
            const motionId = idByName.get(clipName);
            if (!motionId) continue; // clip absent under this animation library
            animController.registerCustomAttack({
                ...move,
                animationMotionId: motionId,
                // Both ride the move into NpcController's engine-level hit registration:
                // `damage` is what the player loses, `range` is how far the limb projects,
                // matching the distance at which this helper decided to attack.
                damage: this.config.damage,
                range: this.config.attackRange,
                // Physics owns the kinematic NPC's translation; the strike is in place.
                filterRootMotion: true,
                // Deliberately no interruptOnMovement — that exists to give a *player*
                // back control mid-kick. An NPC stands still to strike.
            });
        }
    }

    /**
     * The armed equivalent: the weapon pack, and the swings the held weapon can actually
     * make. `startAttack()` rolls one of them per strike, which is what stops a whole
     * arena of gladiators playing the same clip in unison.
     */
    private async loadWeaponSwings(animController: RegisteringAnimationController): Promise<void> {
        if (animController.loadAnimationPack) {
            // `replaceLocomotion` is the difference between carrying a sword and dragging
            // one: without it the NPC walks and idles empty-handed around a weapon welded
            // to its fist. Still no `addToAttackCollection` — see the unarmed note.
            await animController.loadAnimationPack(MELEE_WEAPON_ANIMATIONS, { replaceLocomotion: true });
        }

        // Disposed while the pack was loading.
        if (!this.controller) return;

        this.syncWeaponMoves();
    }

    /**
     * Make the registered swings match the weapon actually in hand: out with the last
     * weapon's, in with this one's. Idempotent, so a weapon swap re-runs it.
     */
    private syncWeaponMoves(): void {
        const animController = this.getAnimationController();
        const weaponType = this.config.weapon?.type;
        if (!animController || !weaponType || !this.isArmed()) return;

        unregisterWeaponAttackMoves(animController, this.registeredWeaponMoves);
        const { names } = registerWeaponAttackMoves(animController, {
            weaponType,
            grip: this.getHost()?.getMeleeWeaponGrip?.(),
            namePrefix: WEAPON_MOVE_PREFIX,
            // Both ride the move into NpcController's engine-level hit registration:
            // `damage` is what the target loses, `range` is how far the blade projects,
            // matching the distance at which this helper decided to attack.
            damage: this.config.damage,
            range: this.config.attackRange,
            // Physics owns the kinematic NPC's translation, and an NPC plants to swing
            // rather than keeping its legs running the way a mid-run player does.
            splitBodyOnRun: false,
        });
        this.registeredWeaponMoves = names;

        if (names.length === 0) {
            // Zero moves means `startAttack()` has nothing to play and returns
            // success:false forever — an armed NPC that stands in its target's face doing
            // nothing. Loud, because the alternative is a silently inert fighter.
            console.warn(
                `[NpcMeleeAttack] no swing animations registered for '${String(weaponType)}' — `
                + 'the NPC is holding a weapon it cannot swing.',
            );
        }
    }
}
