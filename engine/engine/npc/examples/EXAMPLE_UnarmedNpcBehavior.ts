/**
 * @fileoverview EXAMPLE_UnarmedNpcBehavior - Hand-to-hand combat NPC behavior
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ## 🥊 AI AGENT: UNARMED (FIGHTING GAME) NPC BEHAVIOR
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * The NPC half of a fighting game. `UnarmedMeleeSystem` gives the PLAYER
 * punches and kicks; this behavior gives NPCs the same moves, the same guard
 * stance, and hit detection that mirrors the player's:
 *
 * - Chases the player, squares up at `attackRange`
 * - Throws the SAME strike clips the player uses (cross, jab, hook, uppercut,
 *   front kick, roundhouse — random pick per attack via `startAttack()`)
 * - Hits are registered BY THE ENGINE: NpcController watches this NPC's
 *   attack system and tests the striking fist/foot against the player's body
 *   capsule at fixed points through the clip. The behavior only DECIDES —
 *   chase, when to strike — it never touches contact math, so it cannot get
 *   it wrong. (`registered damage` rides on each move; see NPC_STRIKES.)
 * - Adopts the `FightingIdle` guard between strikes (same pack name routing
 *   as the player's stance)
 *
 * ```typescript
 * // In Game.ts:
 * import { UnarmedNpcBehavior } from 'engine/npc/examples/EXAMPLE_UnarmedNpcBehavior.js';
 *
 * async load() {
 *     const handle = this.engine.registerNpc('brawler', new UnarmedNpcBehavior({
 *         attackRange: 1.9,     // fists are shorter than swords
 *         attackCooldown: 1.1,  // seconds between strikes
 *         damage: 10,           // player HP per landed hit
 *         chaseSpeed: 4.0,
 *     }), { hostile: true });
 *     await handle.spawn(10, 5);
 * }
 * ```
 *
 * ⚠️ Combat games must call `this.hud.showHealth()` — see the note in
 * EXAMPLE_MeleeNpcBehavior.ts.
 *
 * @see UnarmedMeleeSystem.ts - the player side of the same fight
 * @see EXAMPLE_MeleeNpcBehavior.ts - the armed equivalent this mirrors
 */

import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import { UNARMED_COMBAT_ANIMATIONS } from 'engine/AnimationPacks.js';
import type { CustomAttackMove } from 'types/game.js';

export interface UnarmedNpcConfig {
    /** Attack when the player is within this distance in metres (default: 1.9 — fist range). */
    attackRange?: number;
    /** Cooldown between strikes in seconds (default: 1.1). */
    attackCooldown?: number;
    /** Player HP removed per landed hit (default: 10). */
    damage?: number;
    /** Movement speed while chasing (default: 4.0). */
    chaseSpeed?: number;
    /**
     * Adopt the FightingIdle guard stance between strikes (default: true).
     * The stance clip rides the same animation pack as the strikes; disabling
     * this keeps the NPC's normal idle.
     */
    fightingStance?: boolean;
    /** Vertical offset from NPC root to face for conversation camera. */
    focusOffsetY?: number;
}

/**
 * The strike moves an unarmed NPC registers, keyed by the pack clip NAME so
 * they resolve under whichever animation library is active — under the CDN
 * library only Punching/Kicking exist and the rest simply drop out, exactly
 * like the pack itself.
 *
 * No `interruptOnMovement`: that flag exists to give a PLAYER back control
 * mid-kick; an NPC's movement is decided by this behavior, which already
 * stands still while striking.
 */
const NPC_STRIKES: ReadonlyArray<{ clipName: string; move: Omit<CustomAttackMove, 'animationMotionId'> }> = [
    { clipName: 'Punching',       move: { name: 'cross',      type: 'punch', side: 'right' } },
    { clipName: 'PunchJab',       move: { name: 'jab',        type: 'punch', side: 'left' } },
    { clipName: 'PunchHook',      move: { name: 'hook',       type: 'punch', side: 'left' } },
    { clipName: 'PunchUppercut',  move: { name: 'uppercut',   type: 'punch', side: 'right' } },
    { clipName: 'Kicking',        move: { name: 'frontKick',  type: 'kick',  side: 'right' } },
    { clipName: 'KickRoundhouse', move: { name: 'roundhouse', type: 'kick',  side: 'right' } },
];

/**
 * Hand-to-hand combat NPC: chases, squares up, and throws the shared unarmed
 * strike clips with limb-sweep hit detection against the player capsule.
 */
export class UnarmedNpcBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private npcController: NpcController | null = null;

    private attackRange: number;
    private attackCooldown: number;
    private attackDamage: number;
    private chaseSpeed: number;
    private fightingStance: boolean;

    // Attack state
    private attackCooldownTimer: number = 0;
    private isStriking: boolean = false;
    /** GAMEPLAY seconds into the current strike — advanced by update()'s
     *  deltaTime, never the wall clock. A wall-clock window expires during a
     *  pause, and the next strike's seq-guard then invalidates the hit checks
     *  GameplayTimers held across that pause: the swing silently whiffs. */
    private strikeElapsed: number = 0;
    private strikeDuration: number = 0;


    constructor(config: UnarmedNpcConfig = {}) {
        this.attackRange = config.attackRange ?? 1.9;
        this.attackCooldown = config.attackCooldown ?? 1.1;
        this.attackDamage = config.damage ?? 10;
        this.chaseSpeed = config.chaseSpeed ?? 4.0;
        this.fightingStance = config.fightingStance ?? true;
        this.focusOffsetY = config.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    /** Same clone contract as MeleeNpcBehavior — see the note there. */
    clone(): UnarmedNpcBehavior {
        const c = Object.assign(Object.create(Object.getPrototypeOf(this)), this) as UnarmedNpcBehavior;
        c.attackCooldownTimer = 0;
        c.isStriking = false;
        c.strikeElapsed = 0;
        c.strikeDuration = 0;
        c.controller = null;
        c.npcController = null;
        return c;
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.npcController = controller as NpcController;
        this.attackCooldownTimer = 0;
        controller.setMoveSpeed(this.chaseSpeed);
        void this.loadStrikes(this.npcController);
    }

    /**
     * Load the unarmed pack on THIS NPC's animation controller and register
     * the strike moves — the same two-step the player's UnarmedMeleeSystem
     * performs, so both sides of the fight draw from one move pool.
     */
    private async loadStrikes(controller: NpcController): Promise<void> {
        const animCtl = controller.getAnimationController();
        if (!animCtl?.loadAnimationPack || !animCtl.registerCustomAttack) return;

        const pack = this.fightingStance
            ? [...UNARMED_COMBAT_ANIMATIONS]
            : UNARMED_COMBAT_ANIMATIONS.filter(a => !a.name.toLowerCase().includes('idle'));
        // replaceLocomotion only when a stance clip is actually present — same
        // CDN-library guard as UnarmedMeleeSystem.
        const hasStance = pack.some(a => a.name.toLowerCase().includes('idle'));
        try {
            await animCtl.loadAnimationPack(pack, { replaceLocomotion: hasStance });
        } catch (error) {
            console.warn('🥊 UnarmedNpcBehavior: failed to load strike animations:', error);
            return;
        }

        const idByName = new Map(pack.map(a => [a.name, a.motionId]));
        for (const { clipName, move } of NPC_STRIKES) {
            const motionId = idByName.get(clipName);
            if (!motionId) continue;   // clip absent under this library
            // damage rides on the move: NpcController's engine-level strike
            // registration reads it when the limb connects.
            animCtl.registerCustomAttack({
                ...move,
                animationMotionId: motionId,
                damage: this.attackDamage,
                // Exact player-parity: the engine's strike test projects the
                // limb forward by `range`, the same number that gates when
                // this behavior starts an attack.
                range: this.attackRange,
            });
        }
    }

    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        _currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller) return null;

        if (this.attackCooldownTimer > 0) {
            this.attackCooldownTimer -= deltaTime;
        }

        const playerPos = this.getPlayerPosition();
        if (!playerPos) return null;

        const distanceToPlayer = currentPosition.distanceTo(playerPos);
        this.faceTarget(playerPos);

        if (this.isStriking) {
            // Contact is engine-registered (NpcController); the behavior only
            // waits out the swing so it doesn't slide mid-strike. Gameplay
            // time, so a pause holds the swing instead of expiring it.
            this.strikeElapsed += deltaTime;
            if (this.strikeElapsed >= this.strikeDuration) {
                this.isStriking = false;
            }
            return null;                       // planted while the strike plays
        }

        if (distanceToPlayer <= this.attackRange) {
            if (this.attackCooldownTimer <= 0) {
                this.startStrike();
            }
            return null;                       // square up instead of orbiting
        }

        // Chase to a STANDOFF POINT short of the player, not to the player's
        // own position. NPC↔player physics is deliberately one-sided (kinematic
        // NPCs pass through the player body — see CollisionLayers), so an NPC
        // pathed to the player's center visibly walks THROUGH them between
        // repath ticks. Stopping at ~70% of attack range keeps the fight at
        // arm's length; the engine's strike reach (move.range) spans the rest.
        const standoff = this.attackRange * 0.7;
        const dx = currentPosition.x - playerPos.x;
        const dz = currentPosition.z - playerPos.z;
        const len = Math.hypot(dx, dz) || 1;
        return playerPos.clone().add(new THREE.Vector3(dx / len * standoff, 0, dz / len * standoff));
    }

    /** Kick off a random registered strike through the NPC's own attack system. */
    private startStrike(): void {
        const animCtl = this.npcController?.getAnimationController();
        if (!animCtl?.startAttack) return;

        const result = animCtl.startAttack();
        if (!result.success) return;

        this.isStriking = true;
        this.strikeElapsed = 0;
        this.strikeDuration = Math.max(result.duration, 0.05);
        this.attackCooldownTimer = this.attackCooldown;
        // Hit detection: none here, on purpose. NpcController registered a
        // listener on this NPC's attack system and owns the contact test.
    }

    private getPlayerPosition(): THREE.Vector3 | null {
        if (!this.controller) return null;
        const engine = this.controller.getEngine();
        const playerController = engine.getPlayerController?.();
        return playerController?.getPosition ? playerController.getPosition() : null;
    }

    private faceTarget(targetPos: THREE.Vector3): void {
        if (!this.controller) return;
        const npcPos = this.controller.getPosition();
        const dx = targetPos.x - npcPos.x;
        const dz = targetPos.z - npcPos.z;
        if (dx * dx + dz * dz > 0.001) {
            const character = this.controller.getCharacter();
            if (character) character.rotation.y = Math.atan2(dx, dz);
        }
    }

    isHostile(): boolean {
        return true;
    }

    getName(): string {
        return 'UnarmedNpcBehavior';
    }

    dispose(): void {
        this.controller = null;
        this.npcController = null;
    }
}
