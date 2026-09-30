import * as THREE from 'three';
import { segmentHitsCapsule } from 'engine/MeleeSweepTargets.js';

/**
 * NpcMeleeTarget - the body an NPC's fists (or blade) can reach.
 *
 * The player and another NPC describe themselves through different accessors —
 * `PlayerController` has `getGroundPosition()` and `getCapsuleHeight()` methods, while an
 * `NpcController`'s position IS its feet and its capsule is a pair of getters — so both are
 * wrapped here rather than used structurally.
 *
 * Two things consume a target: `NpcMeleeAttack` picks the nearest one to chase and face,
 * and `NpcController.setStrikeTarget()` tests the striking limb — or the swung blade —
 * against the capsule it describes. Games that want NPCs to fight each other (a battle
 * royale, warring factions)
 * build the candidate list with these two factories and hand it to `NpcMeleeAttack` through
 * its `findTargets` config — see `@docs npc-combat-death.md`.
 */

/** Capsule used for a target that cannot report its own — an average humanoid. */
export const DEFAULT_MELEE_TARGET_HEIGHT = 1.8;
export const DEFAULT_MELEE_TARGET_RADIUS = 0.4;

export interface NpcMeleeTarget {
    /** True for the player. `NpcEnemyBehavior` reads it to decide whether the shared
     *  chase goal-field applies — that field has exactly one goal, the player, so an NPC
     *  chasing another NPC must not write to it. */
    readonly isPlayer: boolean;
    /** Aim point for range checks and facing, or null once the target is gone. This is
     *  the target's own live vector — clone it before storing. */
    getPosition(): THREE.Vector3 | null;
    /** Feet position, from which the body capsule is built. Null falls back to
     *  `getPosition()`, matching how the engine has always built the player's capsule. */
    getFeetPosition(): THREE.Vector3 | null;
    getCapsuleHeight(): number;
    getCapsuleRadius(): number;
    /** Dead targets are skipped when picking a target and when landing a hit. */
    isDead(): boolean;
    takeDamage(damage: number, source: string): void;
}

const _capsuleCenter = new THREE.Vector3();

/**
 * Does a swept segment reach the target's body?
 *
 * The one place the target capsule is built, so a fist and a sword agree on where a body
 * is: centre at feet + height/2 (falling back to the visual position for a target that
 * cannot report its feet), radius padded by `extraRadius` — the striker's own girth plus
 * its forgiveness margin. Mirrors the player-side body test (`gatherMeleeBodyHits`).
 *
 * Returns false for a target that has no position at all, which is how a despawned target
 * stops being hittable without every caller re-checking.
 */
export function segmentHitsTarget(
    from: THREE.Vector3,
    to: THREE.Vector3,
    target: NpcMeleeTarget,
    extraRadius: number,
): boolean {
    const height = target.getCapsuleHeight();
    const radius = target.getCapsuleRadius() + extraRadius;
    const feet = target.getFeetPosition();
    if (feet) {
        _capsuleCenter.set(feet.x, feet.y + height / 2, feet.z);
    } else {
        const visual = target.getPosition();
        if (!visual) return false;
        _capsuleCenter.copy(visual);
    }
    // Spine length shrinks as the padded radius grows, so the capsule keeps the
    // target's actual height rather than growing end-caps beyond its head and feet.
    const halfSpine = Math.max(0, height / 2 - radius);
    return segmentHitsCapsule(from, to, _capsuleCenter, halfSpine, radius);
}

/** The subset of `PlayerController` a melee target needs. Every member is optional
 *  because the frozen `MultiplayerSetup` player shims implement only part of it. */
interface PlayerControllerLike {
    getPosition?: () => THREE.Vector3 | undefined;
    getGroundPosition?: () => THREE.Vector3 | undefined;
    getCapsuleHeight?: () => number;
    getCapsuleRadius?: () => number;
    isPlayerDead?: () => boolean;
    takeDamage?: (damage: number, source?: string) => void;
}

/**
 * One wrapper per controller, for the whole session.
 *
 * Both factories are called every frame — once per NPC by `NpcMeleeAttack`, and again by
 * whatever roster a game hands to `findTargets` — so a fresh object each time would be a
 * per-NPC-per-frame allocation in a path that used to allocate nothing. Memoizing also
 * makes target identity stable, which is what lets a caller compare targets with `===`.
 */
const playerTargets = new WeakMap<object, NpcMeleeTarget>();
const npcTargets = new WeakMap<object, NpcMeleeTarget>();

/**
 * Wrap the player. Null when there is no player controller at all — a player that cannot
 * `takeDamage` still makes a valid target so the NPC keeps chasing and swinging at it,
 * exactly as it did before targets existed; the strike simply removes no HP.
 */
export function playerMeleeTarget(player: PlayerControllerLike | null | undefined): NpcMeleeTarget | null {
    if (!player) return null;
    const cached = playerTargets.get(player);
    if (cached) return cached;
    const target: NpcMeleeTarget = {
        isPlayer: true,
        getPosition: () => player.getPosition?.() ?? null,
        getFeetPosition: () => player.getGroundPosition?.() ?? null,
        getCapsuleHeight: () => player.getCapsuleHeight?.() ?? DEFAULT_MELEE_TARGET_HEIGHT,
        getCapsuleRadius: () => player.getCapsuleRadius?.() ?? DEFAULT_MELEE_TARGET_RADIUS,
        isDead: () => player.isPlayerDead?.() ?? false,
        takeDamage: (damage, source) => { player.takeDamage?.(damage, source); },
    };
    playerTargets.set(player, target);
    return target;
}

/** The subset of `NpcController` a melee target needs. */
interface NpcControllerLike {
    getPosition: () => THREE.Vector3;
    readonly capsuleHeight: number;
    readonly capsuleRadius: number;
    isDead: () => boolean;
    takeDamage: (damage: number, source?: string) => void;
}

/**
 * Wrap another NPC. Its `getPosition()` is already its feet (the character origin), so it
 * serves as both the aim point and the capsule base.
 */
export function npcMeleeTarget(npc: NpcControllerLike): NpcMeleeTarget {
    const cached = npcTargets.get(npc);
    if (cached) return cached;
    const target: NpcMeleeTarget = {
        isPlayer: false,
        getPosition: () => npc.getPosition(),
        getFeetPosition: () => npc.getPosition(),
        getCapsuleHeight: () => npc.capsuleHeight,
        getCapsuleRadius: () => npc.capsuleRadius,
        isDead: () => npc.isDead(),
        takeDamage: (damage, source) => { npc.takeDamage(damage, source); },
    };
    npcTargets.set(npc, target);
    return target;
}
