import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import type { NpcMeleeAttackConfig, ResolvedNpcMeleeAttackConfig } from 'engine/npc/behaviors/NpcMeleeAttack.js';
import { NpcMeleeAttack, resolveNpcMeleeAttackConfig } from 'engine/npc/behaviors/NpcMeleeAttack.js';

/**
 * NpcHostileBehavior - Guard an area, chase the player on sight, punch them.
 *
 * ## Behavior
 * - Waits at its spawn point until the player enters `detectionRange`
 * - Chases at `chaseSpeed`, facing the player
 * - Punches for `damage` every `attackCooldown` seconds once within `attackRange`
 * - Walks back to its spawn point when the player escapes (`returnToOrigin`)
 *
 * The combat itself lives in `NpcMeleeAttack`, shared with `NpcEnemyBehavior` — see
 * that file for the hit test, the attack animation, and the tuning fields inherited
 * from `NpcMeleeAttackConfig`. For an enemy that wanders instead of standing guard use
 * `NpcEnemyBehavior`; for one that swings a real weapon see `MeleeNpcBehavior`.
 *
 * **The player only sees the damage if the game shows a health bar** — call
 * `engine.getHUD().showHealth({ width: 200 })` when registering hostile NPCs.
 *
 * ## Configuration
 * @param detectionRange - Distance to detect and start chasing the player (default: 10.0)
 * @param attackRange - Distance to stop and punch (default: 2.0)
 * @param chaseSpeed - Movement speed while chasing (default: 4.0). Applied via
 *   `setMoveSpeed` on aggro and restored when the player escapes.
 * @param returnToOrigin - Walk back to spawn after losing the player (default: true)
 * @param updateInterval - How often to recalculate the chase path (default: 0.3)
 * @param damage - Damage per landed punch (default: 10); `0` for a harmless chaser
 * @param attackCooldown - Seconds between punches (default: 1.5)
 */
export class NpcHostileBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private returnToOrigin: boolean;
    private updateInterval: number;

    /** Resolved once so `clone()` can forward every field already defaulted. */
    private readonly meleeConfig: ResolvedNpcMeleeAttackConfig;
    /**
     * Per-NPC combat state, so it is built in initialize() (which runs once per spawn)
     * rather than the constructor — the registry holds one template instance and clones
     * it, and a constructor-built helper would leave the template holding live state.
     */
    private melee: NpcMeleeAttack | null = null;

    private originPosition: THREE.Vector3 | null = null;
    private updateTimer: number = 0;

    constructor(config?: NpcMeleeAttackConfig & {
        returnToOrigin?: boolean;
        updateInterval?: number;
        focusOffsetY?: number;
    }) {
        this.meleeConfig = resolveNpcMeleeAttackConfig(config);
        this.returnToOrigin = config?.returnToOrigin ?? true;
        this.updateInterval = config?.updateInterval ?? 0.3;
        this.focusOffsetY = config?.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    /**
     * Fresh per-NPC instance with the same config. REQUIRED: holds per-NPC state
     * (controller, originPosition, chase flags) set in initialize(); without
     * clone() one instance is shared across every spawn of a handle, so the last
     * spawn's originPosition wins and earlier NPCs return to the wrong origin.
     */
    clone(): INpcBehavior {
        return new NpcHostileBehavior({
            ...this.meleeConfig,
            returnToOrigin: this.returnToOrigin,
            updateInterval: this.updateInterval,
            focusOffsetY: this.focusOffsetY,
        });
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        // Clone: getPosition() hands back the character's live position vector.
        this.originPosition = controller.getPosition().clone();
        this.updateTimer = 0;
        this.melee = new NpcMeleeAttack(this.meleeConfig);
        this.melee.initialize(controller);
    }

    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller || !this.melee) return null;

        this.updateTimer += deltaTime;
        const engagement = this.melee.update(deltaTime, currentPosition);

        switch (engagement.state) {
            case 'attack':
                // Hold still while punching; the helper keeps the NPC facing the player.
                return null;

            case 'chase':
                if (this.updateTimer >= this.updateInterval) {
                    this.updateTimer = 0;
                    return engagement.targetPosition;
                }
                return currentTarget; // keep walking toward the last known position

            case 'disengaged':
                return this.walkHome(currentPosition);
        }
    }

    /** Head back to the spawn point once the player is gone, then stand down. */
    private walkHome(currentPosition: THREE.Vector3): THREE.Vector3 | null {
        if (!this.returnToOrigin || !this.originPosition) return null;
        return currentPosition.distanceTo(this.originPosition) > 1.0 ? this.originPosition : null;
    }

    onHit(): boolean {
        // Taking a hit interrupts the wind-up rather than landing the punch anyway.
        this.melee?.cancelSwing();
        return false; // keep the default damage/knockback response
    }

    getName(): string {
        return 'Hostile';
    }

    isHostile(): boolean {
        return true;
    }

    dispose(): void {
        this.melee?.dispose();
        this.melee = null;
        this.controller = null;
    }
}
