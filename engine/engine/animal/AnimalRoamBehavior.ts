import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';

/**
 * AnimalRoamBehavior - Slow idle wandering for animals
 * 
 * Animals will:
 * - Stay near their spawn point (within roamRadius)
 * - Occasionally pick a random nearby point to walk to
 * - Pause and idle between movements
 * - Move slowly and naturally
 */
export class AnimalRoamBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private spawnPosition: THREE.Vector3 | null = null;
    private currentTarget: THREE.Vector3 | null = null;

    // Configuration
    private roamRadius: number;
    private minIdleTime: number;
    private maxIdleTime: number;
    private idleChance: number;  // Chance to idle after reaching target (0-1)

    // State
    private idleTimer: number = 0;
    private idleDuration: number = 0;
    private isIdling: boolean = true;  // Start idling

    constructor(config?: {
        roamRadius?: number;      // Max distance from spawn to roam (default: 8)
        minIdleTime?: number;     // Min seconds to idle (default: 2)
        maxIdleTime?: number;     // Max seconds to idle (default: 6)
        idleChance?: number;      // Chance to idle after reaching target (default: 0.7)
        focusOffsetY?: number;    // Vertical offset from root to face (default: standing-human eye height)
    }) {
        this.roamRadius = config?.roamRadius ?? 8;
        this.minIdleTime = config?.minIdleTime ?? 2;
        this.maxIdleTime = config?.maxIdleTime ?? 6;
        this.idleChance = config?.idleChance ?? 0.7;
        this.focusOffsetY = config?.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.spawnPosition = controller.getPosition().clone();
        this.startIdling();
    }

    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        _currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller || !this.spawnPosition) return null;

        // If idling, count down timer
        if (this.isIdling) {
            this.idleTimer += deltaTime;
            if (this.idleTimer >= this.idleDuration) {
                // Done idling, pick a new target
                this.pickNewTarget(currentPosition);
            }
            return null;  // Stay still while idling
        }

        // If we have a target, check if we've reached it
        if (this.currentTarget) {
            const distance = currentPosition.distanceTo(this.currentTarget);
            if (distance < 0.8) {
                // Reached target
                if (Math.random() < this.idleChance) {
                    this.startIdling();
                    return null;
                } else {
                    // Pick another target immediately
                    this.pickNewTarget(currentPosition);
                }
            }
            return this.currentTarget;
        }

        // No target, start idling
        this.startIdling();
        return null;
    }

    private startIdling(): void {
        this.isIdling = true;
        this.idleTimer = 0;
        this.idleDuration = this.minIdleTime + Math.random() * (this.maxIdleTime - this.minIdleTime);
        this.currentTarget = null;
    }

    private pickNewTarget(currentPosition: THREE.Vector3): void {
        if (!this.spawnPosition) return;
        
        this.isIdling = false;
        
        // Pick a random point within roam radius of spawn
        // Use a bias toward spawn center to prevent drifting too far
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.random() * this.roamRadius * 0.7;  // Bias toward center
        
        const targetX = this.spawnPosition.x + Math.cos(angle) * distance;
        const targetZ = this.spawnPosition.z + Math.sin(angle) * distance;
        
        // Ensure target is within roam radius
        const newTarget = new THREE.Vector3(targetX, currentPosition.y, targetZ);
        const distFromSpawn = newTarget.distanceTo(this.spawnPosition);
        
        if (distFromSpawn > this.roamRadius) {
            // Clamp to roam radius
            const dir = newTarget.clone().sub(this.spawnPosition).normalize();
            newTarget.copy(this.spawnPosition).add(dir.multiplyScalar(this.roamRadius * 0.8));
        }
        
        this.currentTarget = newTarget;
    }

    onTargetReached(): void {
        // Start idling when target is reached
        if (Math.random() < this.idleChance) {
            this.startIdling();
        } else {
            this.pickNewTarget(this.controller?.getPosition() ?? new THREE.Vector3());
        }
    }

    getName(): string {
        return 'Roam';
    }

    isHostile(): boolean {
        return false;
    }

    dispose(): void {
        this.controller = null;
        this.spawnPosition = null;
        this.currentTarget = null;
    }
}

