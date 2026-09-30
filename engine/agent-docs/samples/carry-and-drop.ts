/**
 * Carry-and-place pattern (collectible-objects.md, Pattern C): pick something
 * up with E, carry it, deposit it in a drop zone. Two variants — simple
 * objects (crates, keys) get their own sensor; animals hook into their
 * existing interaction via CarryableComponent.fromAnimal().
 *
 * Referenced from agent docs (read-docs name: `samples/carry-and-drop`).
 * Compiled against the live engine by game's `pnpm run check`.
 */
import * as THREE from 'three';
import { CarryableComponent, onCarryEvent, removeCarryEventListener, type CarryEventListener } from 'engine/CarryableComponent.js';
import { DropZoneComponent } from 'engine/DropZoneComponent.js';
import { VoxelObjectBuilder } from 'engine/builders/VoxelObjectBuilder.js';
import { createAnimal, AnimalRoamBehavior } from 'engine/animal/index.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { EngineLike } from 'types/game.js';

/** Variant A: crates placed via `voxel place … --interactable --name crate`. */
export function setupCrateStorage(physicsWorld: PhysicsWorld): { carryables: CarryableComponent[]; zone: DropZoneComponent } {
    const zone = new DropZoneComponent(physicsWorld, {
        position: new THREE.Vector3(50, 0, 50),
        radius: 5,
        name: 'storage',
        displayName: 'storage area',
        onObjectPlaced: (_objectName) => {
            // score/HUD update on each stored crate
        },
    });

    const crates = VoxelObjectBuilder.getObjectsGroupedByName().get('crate') ?? [];
    const carryables = crates.map((crateObj) => new CarryableComponent(physicsWorld, {
        object3D: crateObj,
        displayName: 'crate',
    }));
    return { carryables, zone };
}

/**
 * Variant B: a carryable chicken. fromAnimal() wraps the animal's existing
 * roam behavior with carry interaction — no custom behavior class needed.
 * Build `factory` with createBlockAnimalFactory(<body config>) — see the
 * animal-instructions doc for body configs.
 */
export async function spawnCarryableChicken(
    scene: THREE.Scene,
    physicsWorld: PhysicsWorld,
    engine: EngineLike,
    position: THREE.Vector3,
    factory: IBlockCharacterFactory,
): Promise<CarryableComponent> {
    const chicken = await createAnimal(scene, physicsWorld, engine, position, 'Chicken', 2.0, factory);
    chicken.setBehavior(new AnimalRoamBehavior({ roamRadius: 12 }));
    return CarryableComponent.fromAnimal(chicken, physicsWorld, {
        displayName: 'chicken',
        carryOffset: new THREE.Vector3(0, 0.6, 1.0),
    });
}

/** Global carry events — one listener for every pickup/drop/zone placement. */
export function watchCarryEvents(): () => void {
    const listener: CarryEventListener = (event, objectName, _object3D, zoneName) => {
        if (event === 'placedInZone') {
            // e.g. count `${objectName}` delivered to `${zoneName}`
        }
    };
    onCarryEvent(listener);
    return () => removeCarryEventListener(listener);
}
