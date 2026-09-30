import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';

/**
 * NpcFollowBehavior - Follow a target entity (player or another NPC)
 * 
 * ## Behavior
 * - Follow target while maintaining minimum/maximum distance
 * - Stop following if target too far away (max distance exceeded)
 * - Recalculate path periodically based on update interval
 * 
 * ## Configuration
 * @param target - The entity to follow (player object, another NPC, or 'player' string to auto-follow player)
 * @param minDistance - Stop moving when this close (default: 2.0)
 * @param maxDistance - Stop following if beyond this (default: 20.0)
 * @param updateInterval - How often to recalculate path in seconds (default: 0.5)
 * 
 * ## Usage Examples
 */
export class NpcFollowBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private target: THREE.Object3D | null = null;
    private targetString: 'player' | null = null;
    private minDistance: number;
    private maxDistance: number;
    private updateInterval: number;

    private updateTimer: number = 0;

    constructor(config: {
        target: THREE.Object3D | 'player';
        minDistance?: number;
        maxDistance?: number;
        updateInterval?: number;
        focusOffsetY?: number;
    }) {
        if (!config.target) {
            throw new Error('NpcFollowBehavior requires a target');
        }

        // Handle 'player' string - will resolve in initialize()
        if (config.target === 'player') {
            this.targetString = 'player';
            this.target = null; // Will be resolved in initialize()
        } else {
            this.target = config.target;
            this.targetString = null;
        }

        this.minDistance = config.minDistance ?? 2.0;
        this.maxDistance = config.maxDistance ?? 20.0;
        this.updateInterval = config.updateInterval ?? 0.5;
        this.focusOffsetY = config.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    /**
     * Fresh per-NPC instance with the same config. REQUIRED so each spawn of a
     * registered handle gets its own behaviour (per-NPC state — controller,
     * resolved target, timer — lives in initialize()). The original target spec
     * ('player' string or an Object3D) is preserved so the clone re-resolves it.
     */
    clone(): INpcBehavior {
        return new NpcFollowBehavior({
            target: this.targetString ?? this.target!,
            minDistance: this.minDistance,
            maxDistance: this.maxDistance,
            updateInterval: this.updateInterval,
            focusOffsetY: this.focusOffsetY,
        });
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.updateTimer = 0;

        // Resolve 'player' target if needed
        if (this.targetString === 'player' && !this.target) {
            this.target = this.resolvePlayerTarget();
            if (!this.target) {
                console.warn('⚠️ [NpcFollowBehavior] Could not resolve player target - following will not work');
            }
        }
    }

    /**
     * Resolve player target from engine
     * Uses engine.getPlayerController().getPlayerObject() for reliable access
     */
    private resolvePlayerTarget(): THREE.Object3D | null {
        const playerController = this.controller?.getEngine().getPlayerController();
        return playerController?.getPlayerObject?.() ?? null;
    }

    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller) return null;

        // Re-resolve player target if needed (in case player wasn't ready during initialize)
        if (this.targetString === 'player' && !this.target) {
            this.target = this.resolvePlayerTarget();
        }

        if (!this.target) return null;

        this.updateTimer += deltaTime;

        // Get target position
        const targetPos = this.target.position.clone();
        const distanceToTarget = currentPosition.distanceTo(targetPos);

        // If target is too far, stop following
        if (distanceToTarget > this.maxDistance) {
            return null;
        }

        // If close enough, stop moving
        if (distanceToTarget <= this.minDistance) {
            return null;
        }

        // Only update target position at intervals to avoid constant pathfinding
        if (this.updateTimer >= this.updateInterval) {
            this.updateTimer = 0;
            return targetPos;
        }

        // Keep current target if we have one
        return currentTarget;
    }

    /**
     * Set a new target to follow
     */
    setTarget(target: THREE.Object3D | 'player'): void {
        if (target === 'player') {
            this.targetString = 'player';
            this.target = this.resolvePlayerTarget();
        } else {
            this.target = target;
            this.targetString = null;
        }
        this.updateTimer = 0; // Force immediate update
    }

    getName(): string {
        return 'Follow';
    }

    isHostile(): boolean {
        return false; // Follower NPCs are not hostile
    }

    dispose(): void {
        this.controller = null;
    }
}

