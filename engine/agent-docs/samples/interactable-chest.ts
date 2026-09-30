/**
 * E-key interactable pattern (collectible-objects.md, Pattern B): a chest the
 * player deliberately opens. Place the object with `--interactable` so it
 * exists as an individual VoxelObject, then attach an InteractableComponent.
 *
 * Referenced from agent docs (read-docs name: `samples/interactable-chest`).
 * Compiled against the live engine by game's `pnpm run check`.
 */
import * as THREE from 'three';
import type { Interactable } from 'types/interactable.js';
import { InteractableComponent } from 'engine/InteractableComponent.js';
import { VoxelObjectBuilder } from 'engine/builders/VoxelObjectBuilder.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

export class ChestInteractable implements Interactable {
    private opened = false;
    private interactableComponent: InteractableComponent;

    constructor(physicsWorld: PhysicsWorld, private object3D: THREE.Object3D) {
        // Trigger sensor that surfaces the "[E] open chest" prompt in range.
        this.interactableComponent = new InteractableComponent(physicsWorld, {
            interactable: this,
            object3D: this.object3D,
            radius: 3.0,
        });
    }

    onInteractStart(): boolean {
        if (this.opened) return false;
        this.opened = true;
        // Reward logic goes here (score, spawn item, open lid animation…).
        return true;
    }

    getInteractStartDisplayName(): string {
        return 'open chest'; // shows as "[E] open chest"
    }

    interactionEnabled(): boolean {
        return !this.opened; // prompt disappears once opened
    }

    dispose(): void {
        this.interactableComponent.dispose();
    }
}

/**
 * Wire every placed object named `chest` (from `voxel place … --interactable
 * --name chest`). Call from the player controller / game setup; dispose the
 * returned interactables in the game's dispose().
 */
export function attachChestInteractables(physicsWorld: PhysicsWorld): ChestInteractable[] {
    const chests = VoxelObjectBuilder.getObjectsGroupedByName().get('chest') ?? [];
    return chests.map((chestObj) => new ChestInteractable(physicsWorld, chestObj));
}
