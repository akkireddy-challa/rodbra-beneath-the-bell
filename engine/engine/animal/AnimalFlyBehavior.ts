import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import { AnimalMediumSensor } from 'engine/animal/AnimalMediumSensor.js';

/**
 * AnimalFlyBehavior - 3D aerial wandering for birds.
 *
 * Continuously cruises between random air points around the spawn position,
 * holding an altitude band above the terrain. Birds never stop mid-air —
 * "rest" is the glide that emerges on descending legs of the route (the
 * animation controller blends flap → glide from vertical motion on its own).
 *
 * Use with a bird-plan animal (`bodyPlan: 'bird'` + wings):
 */
export class AnimalFlyBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private sensor: AnimalMediumSensor | null = null;
    private homePosition: THREE.Vector3 | null = null;
    private currentTarget: THREE.Vector3 | null = null;

    // Configuration
    private roamRadius: number;
    private minAltitude: number;
    private maxAltitude: number;

    constructor(config?: {
        roamRadius?: number;   // Max horizontal distance from spawn (default: 20)
        minAltitude?: number;  // Min height above terrain at the target (default: 4)
        maxAltitude?: number;  // Max height above terrain at the target (default: 12)
        focusOffsetY?: number; // Vertical offset from root to face (default: 0.5)
    }) {
        this.roamRadius = config?.roamRadius ?? 20;
        this.minAltitude = config?.minAltitude ?? 4;
        this.maxAltitude = config?.maxAltitude ?? 12;
        this.focusOffsetY = config?.focusOffsetY ?? 0.5;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.sensor = new AnimalMediumSensor(controller.getEngine());
        this.homePosition = controller.getPosition().clone();
    }

    update(
        _deltaTime: number,
        currentPosition: THREE.Vector3,
        _currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller || !this.homePosition) return null;

        // Always keep a destination — birds cruise continuously
        if (!this.currentTarget || currentPosition.distanceTo(this.currentTarget) < 1.2) {
            this.pickNewTarget();
        }
        return this.currentTarget;
    }

    private pickNewTarget(): void {
        if (!this.homePosition) return;

        const angle = Math.random() * Math.PI * 2;
        const distance = this.roamRadius * (0.3 + Math.random() * 0.7);
        const x = this.homePosition.x + Math.cos(angle) * distance;
        const z = this.homePosition.z + Math.sin(angle) * distance;

        // Altitude band rides the terrain when we can query it; otherwise hold
        // a band around the spawn height.
        const baseY = this.sensor?.getTerrainHeightAt(x, z) ?? (this.homePosition.y - this.minAltitude);
        const y = baseY + this.minAltitude + Math.random() * (this.maxAltitude - this.minAltitude);

        this.currentTarget = new THREE.Vector3(x, y, z);
    }

    onTargetReached(): void {
        this.pickNewTarget();
    }

    getName(): string {
        return 'Fly';
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
