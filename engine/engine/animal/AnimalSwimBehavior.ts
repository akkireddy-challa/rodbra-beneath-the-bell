import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import { AnimalMediumSensor } from 'engine/animal/AnimalMediumSensor.js';

/**
 * AnimalSwimBehavior - 3D wandering inside a water volume, for fish.
 *
 * Picks random submerged points around the spawn position (a sphere, not a
 * disc — fish roam vertically too), validates each candidate against the
 * voxel water before committing, and hovers in place between moves.
 *
 * Use with a fish-plan animal (`bodyPlan: 'fish'` or a legless config):
 */
export class AnimalSwimBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private sensor: AnimalMediumSensor | null = null;
    private homePosition: THREE.Vector3 | null = null;
    private currentTarget: THREE.Vector3 | null = null;

    // Configuration
    private roamRadius: number;
    private verticalRange: number;
    private minIdleTime: number;
    private maxIdleTime: number;
    private idleChance: number;

    // State
    private idleTimer: number = 0;
    private idleDuration: number = 0;
    private isIdling: boolean = true;

    constructor(config?: {
        roamRadius?: number;      // Max horizontal distance from spawn (default: 10)
        verticalRange?: number;   // Max vertical distance from spawn (default: roamRadius * 0.5)
        minIdleTime?: number;     // Min seconds hovering between moves (default: 1)
        maxIdleTime?: number;     // Max seconds hovering between moves (default: 4)
        idleChance?: number;      // Chance to hover after reaching a target (default: 0.4)
        focusOffsetY?: number;    // Vertical offset from root to face (default: half-meter — fish are low)
    }) {
        this.roamRadius = config?.roamRadius ?? 10;
        this.verticalRange = config?.verticalRange ?? this.roamRadius * 0.5;
        this.minIdleTime = config?.minIdleTime ?? 1;
        this.maxIdleTime = config?.maxIdleTime ?? 4;
        this.idleChance = config?.idleChance ?? 0.4;
        this.focusOffsetY = config?.focusOffsetY ?? 0.5;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.sensor = new AnimalMediumSensor(controller.getEngine());
        this.homePosition = controller.getPosition().clone();
        this.startIdling();
    }

    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        _currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller || !this.homePosition) return null;

        if (this.isIdling) {
            this.idleTimer += deltaTime;
            if (this.idleTimer >= this.idleDuration) {
                this.pickNewTarget(currentPosition);
            }
            return this.currentTarget;
        }

        if (this.currentTarget) {
            if (currentPosition.distanceTo(this.currentTarget) < 0.8) {
                if (Math.random() < this.idleChance) {
                    this.startIdling();
                } else {
                    this.pickNewTarget(currentPosition);
                }
            }
            return this.currentTarget;
        }

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
        if (!this.homePosition) return;
        this.isIdling = false;

        // Sample candidate points in a flattened sphere around home and keep
        // the first one that is actually water. Falls back to hovering when
        // the pond is too cramped to find anything (e.g. water drained).
        for (let attempt = 0; attempt < 8; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const distance = Math.random() * this.roamRadius * 0.8;
            const candidate = new THREE.Vector3(
                this.homePosition.x + Math.cos(angle) * distance,
                this.homePosition.y + (Math.random() * 2 - 1) * this.verticalRange,
                this.homePosition.z + Math.sin(angle) * distance,
            );
            if (this.sensor?.isWaterAt(candidate.x, candidate.y, candidate.z)) {
                this.currentTarget = candidate;
                return;
            }
        }

        // Nothing valid found — drift back toward home if it is still water,
        // otherwise hover where we are.
        if (this.sensor?.isWaterAt(this.homePosition.x, this.homePosition.y, this.homePosition.z)) {
            this.currentTarget = this.homePosition.clone();
        } else {
            this.currentTarget = currentPosition.clone();
            this.startIdling();
        }
    }

    onTargetReached(): void {
        if (Math.random() < this.idleChance) {
            this.startIdling();
        } else if (this.controller) {
            this.pickNewTarget(this.controller.getPosition());
        }
    }

    getName(): string {
        return 'Swim';
    }

    isHostile(): boolean {
        return false;
    }

    dispose(): void {
        this.controller = null;
        this.sensor = null;
        this.homePosition = null;
        this.currentTarget = null;
    }
}
