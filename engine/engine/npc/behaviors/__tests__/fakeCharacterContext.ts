import * as THREE from 'three';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import type { BaseAnimationDefinition, CustomAttackMove } from 'types/game.js';
import { playerMeleeTarget, type NpcMeleeTarget } from 'engine/npc/behaviors/NpcMeleeTarget.js';
import type { NpcMeleeWeaponOptions } from 'engine/npc/core/NpcWeaponComponent.js';

/**
 * Minimal stand-in for an `NpcController` + engine + player, for testing NPC behaviors
 * without the physics/render stack. Each accessor mirrors the real controller's
 * semantics where a behavior could get it wrong — notably `getPosition()` returns the
 * LIVE character position (as `NpcController` does), so aliasing bugs reproduce here.
 */

export interface FakeAnimationState {
    /** Packs passed to loadAnimationPack, with the options they were loaded with. */
    packs: Array<{ animations: BaseAnimationDefinition[]; options?: { addToAttackCollection?: boolean; replaceLocomotion?: boolean } }>;
    registered: CustomAttackMove[];
    startAttackCalls: number;
}

/** What the engine was asked to hold, as `NpcController.equipMeleeWeapon` would see it. */
export interface FakeWeaponState {
    /** Every equip request, in order — empty for an NPC that never armed. */
    equipped: NpcMeleeWeaponOptions[];
    unequipCalls: number;
    /** Whether a weapon is held right now. */
    isArmed: () => boolean;
    /** Stand in for a character whose right hand isn't loaded yet: while false every
     *  equip fails, as `NpcWeaponComponent` does when the bone lookup comes back empty. */
    setHandReady(ready: boolean): void;
    /** Take the weapon away behind the helper's back, as game code calling
     *  `npc.unequipMeleeWeapon()` directly would. */
    disarm(): void;
}

export interface FakeWorld {
    context: ICharacterContext;
    /** The NPC's visual object — read `rotation.y` to assert facing. */
    character: THREE.Object3D;
    /** Move the NPC (its "physics" position and its visual are the same object). */
    setNpcAt(x: number, y: number, z: number): void;
    /** Move the player. Pass null to simulate "no player controller". */
    setPlayerAt(x: number, y: number, z: number): void;
    removePlayer(): void;
    damageTaken: Array<{ amount: number; source?: string }>;
    setMoveSpeedCalls: number[];
    moveSpeed: () => number;
    anim: FakeAnimationState | null;
    /** Whoever the last strike was aimed at, as `NpcController.setStrikeTarget` would see
     *  it. Null while the NPC has never aimed anywhere but the player. */
    strikeTarget: () => NpcMeleeTarget | null;
    weapon: FakeWeaponState;
}

export interface FakeWorldOptions {
    /** Where the NPC starts (default origin). */
    spawn?: THREE.Vector3;
    /** Where the player starts (default 100m away, i.e. far out of any range). */
    player?: THREE.Vector3;
    /** Default 3.0 — the NPC's pre-aggro move speed. */
    moveSpeed?: number;
    /** Default true. False exercises the "damage lands with no animation" branch. */
    withAnimationController?: boolean;
    /** Default true. False exercises the missing-takeDamage warning branch. */
    withTakeDamage?: boolean;
    /** Default true. False exercises the default-humanoid-capsule fallback. */
    withCapsule?: boolean;
    /** Pre-registered attack move names — non-empty means "template owns combat". */
    existingAttackMoves?: string[];
    /** Default true. False stands in for a host that cannot hold a weapon — an
     *  `AnimalController`, or a character whose hand isn't loaded yet. Flip it later
     *  with `world.weapon.setHandReady()` to simulate a hand that arrives late. */
    canEquipWeapon?: boolean;
}

export function makeFakeWorld(options: FakeWorldOptions = {}): FakeWorld {
    const character = new THREE.Object3D();
    character.position.copy(options.spawn ?? new THREE.Vector3(0, 0, 0));

    let playerPosition: THREE.Vector3 | null = (options.player ?? new THREE.Vector3(100, 0, 100)).clone();
    let moveSpeed = options.moveSpeed ?? 3.0;

    const damageTaken: FakeWorld['damageTaken'] = [];
    const setMoveSpeedCalls: number[] = [];

    const anim: FakeAnimationState | null = (options.withAnimationController ?? true)
        ? { packs: [], registered: [], startAttackCalls: 0 }
        : null;

    let strikeTarget: NpcMeleeTarget | null = null;

    const equipped: NpcMeleeWeaponOptions[] = [];
    let handReady = options.canEquipWeapon ?? true;
    let armed = false;
    let unequipCalls = 0;

    const animationController = anim === null ? null : {
        /**
         * Stands in for the real attack system AND for `NpcController`'s engine-level
         * strike hit registration: a strike with a registered move applies that move's
         * damage to whoever the NPC is currently aimed at, defaulting to the player.
         * The engine does this on a delay, at fixed fractions of the clip, and only if
         * the limb actually reaches the target's capsule — none of which is this module's
         * code, so the fake lands it immediately.
         */
        startAttack: (): { success: boolean; duration: number } => {
            anim.startAttackCalls += 1;
            const move = anim.registered[0];
            if (!move) return { success: false, duration: 0 };
            const victim = strikeTarget ?? playerMeleeTarget(playerController);
            if (victim && !victim.isDead()) victim.takeDamage(move.damage ?? 10, 'npc_strike');
            return { success: true, duration: 0.6 };
        },
        loadAnimationPack: async (
            animations: BaseAnimationDefinition[],
            packOptions?: { addToAttackCollection?: boolean; replaceLocomotion?: boolean },
        ): Promise<void> => { anim.packs.push({ animations, options: packOptions }); },
        registerCustomAttack: (move: CustomAttackMove): boolean => { anim.registered.push(move); return true; },
        unregisterCustomAttack: (name: string): boolean => {
            const index = anim.registered.findIndex(m => m.name === name);
            if (index < 0) return false;
            anim.registered.splice(index, 1);
            return true;
        },
        getRegisteredAttackMoves: (): string[] =>
            [...(options.existingAttackMoves ?? []), ...anim.registered.map(m => m.name)],
    };

    const playerController = {
        getPosition: (): THREE.Vector3 | undefined => playerPosition ?? undefined,
        // Feet position: the fake player's position IS its feet, matching PlayerController.
        getGroundPosition: (): THREE.Vector3 | undefined => playerPosition ?? undefined,
        ...((options.withCapsule ?? true) ? {
            getCapsuleHeight: (): number => 1.8,
            getCapsuleRadius: (): number => 0.4,
        } : {}),
        ...((options.withTakeDamage ?? true) ? {
            takeDamage: (amount: number, source?: string): void => { damageTaken.push({ amount, source }); },
        } : {}),
    };

    const engine = {
        getPlayerController: () => (playerPosition ? playerController : null),
        getWorldHeightAt: (): number => 0,
    };

    const context = {
        getEngine: () => engine,
        getCharacter: () => character,
        getPosition: () => character.position,
        isDead: () => false,
        isExploded: () => false,
        isStunned: () => false,
        getMoveSpeed: () => moveSpeed,
        setMoveSpeed: (speed: number) => { moveSpeed = speed; setMoveSpeedCalls.push(speed); },
        setTargetPosition: () => {},
        requestBehaviorChange: () => {},
        shatterIntoVoxels: () => false,
        // All reached through the same structural cast NpcMeleeAttack uses.
        getAnimationController: () => animationController,
        setStrikeTarget: (target: NpcMeleeTarget | null) => { strikeTarget = target; },
        equipMeleeWeapon: (weaponOptions: NpcMeleeWeaponOptions): boolean => {
            equipped.push(weaponOptions);
            // Mirrors NpcWeaponComponent: no hand, no weapon, and whatever was held stays.
            if (handReady) armed = true;
            return handReady;
        },
        unequipMeleeWeapon: (): void => { unequipCalls += 1; armed = false; },
        hasMeleeWeapon: (): boolean => armed,
        getMeleeWeaponGrip: (): 'one' | 'two' => 'one',
    } as unknown as ICharacterContext;

    return {
        context,
        character,
        setNpcAt: (x, y, z) => { character.position.set(x, y, z); },
        setPlayerAt: (x, y, z) => {
            if (playerPosition) playerPosition.set(x, y, z);
            else playerPosition = new THREE.Vector3(x, y, z);
        },
        removePlayer: () => { playerPosition = null; },
        damageTaken,
        setMoveSpeedCalls,
        moveSpeed: () => moveSpeed,
        anim,
        strikeTarget: () => strikeTarget,
        weapon: {
            equipped,
            get unequipCalls() { return unequipCalls; },
            isArmed: () => armed,
            setHandReady: (ready) => { handReady = ready; },
            disarm: () => { armed = false; },
        },
    };
}

/** A rival NPC to fight: a target that records what it took and where it stands. */
export interface FakeRival {
    target: NpcMeleeTarget;
    position: THREE.Vector3;
    damageTaken: Array<{ amount: number; source: string }>;
    setAt(x: number, y: number, z: number): void;
    kill(): void;
}

/**
 * Stand-in for another NPC in a free-for-all — what `npcMeleeTarget(otherController)`
 * produces, without a controller behind it. Its position is its feet, as an NPC's is.
 */
export function makeFakeRival(x: number, y: number, z: number): FakeRival {
    const position = new THREE.Vector3(x, y, z);
    const damageTaken: FakeRival['damageTaken'] = [];
    let dead = false;
    return {
        position,
        damageTaken,
        setAt: (nx, ny, nz) => { position.set(nx, ny, nz); },
        kill: () => { dead = true; },
        target: {
            isPlayer: false,
            getPosition: () => position,
            getFeetPosition: () => position,
            getCapsuleHeight: () => 1.8,
            getCapsuleRadius: () => 0.4,
            isDead: () => dead,
            takeDamage: (amount, source) => { damageTaken.push({ amount, source }); },
        },
    };
}

/**
 * Await an in-flight strike-animation load, given either the `NpcMeleeAttack` itself or
 * a behavior that owns one. The promise is private state; reaching it is deliberate —
 * the alternative is an arbitrary sleep in every test that strikes, and until the load
 * settles no move is registered and `startAttack()` cannot connect.
 */
export async function settleAnimations(target: object): Promise<void> {
    const owner = target as { animationLoad?: Promise<void> | null; melee?: { animationLoad?: Promise<void> | null } | null };
    const pending = owner.animationLoad ?? owner.melee?.animationLoad;
    if (pending) await pending;
}

/** Advance a behavior/helper by `seconds` in fixed 1/60s steps, running `tick` each frame. */
export function runFrames(seconds: number, tick: (deltaTime: number) => void): void {
    const dt = 1 / 60;
    const frames = Math.round(seconds / dt);
    for (let i = 0; i < frames; i++) tick(dt);
}
