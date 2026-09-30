import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { EngineLike } from 'types/game.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';

/**
 * Ground-placement regression: an elongated animal (e.g. Dog) gets a capsule
 * radius derived from its LENGTH, which can exceed height/2 (a short, fat
 * capsule). The visual must still plant on the ground.
 *
 * A settled kinematic capsule rests with its TRUE lowest point on the terrain:
 *   center.y - (cylinderHalfHeight + radius) = terrainY
 * syncCharacterWithPhysics must place the character group's feet at terrainY,
 * i.e. group.y == terrainY (feetOffset 0, origin at feet) — regardless of the
 * radius/height ratio.
 */
function settledBodyOnGround(height: number, radius: number, terrainY = 0): RAPIER.RigidBody {
    const cylinderHalf = Math.max(0, (height - 2 * radius) / 2);
    const centerY = terrainY + cylinderHalf + radius; // true bottom sits on terrain
    return { translation: () => ({ x: 0, y: centerY, z: 0 }) } as unknown as RAPIER.RigidBody;
}

/** A loader sized to the given capsule, with the GLB origin at the feet. */
function loaderForCapsule(height: number, radius: number): CharacterLoader {
    const loader = new CharacterLoader({} as unknown as EngineLike);
    loader.setCapsuleDimensions(height, radius);
    loader.setFeetOffset(0);
    return loader;
}

// A tall capsule — the ordinary player/NPC proportions (height/2 >= radius).
const TALL = { height: 1.75, radius: 0.3 };

describe('CharacterLoader ground placement', () => {
    it('plants feet on the ground for a fat capsule (radius > height/2) — Dog', () => {
        const height = 0.783; // 0.9 * Dog height (~0.87)
        const radius = 0.5;   // from length, clamped — exceeds height/2 (0.39)
        const loader = loaderForCapsule(height, radius);

        const group = new THREE.Group();
        loader.syncCharacterWithPhysics(group, settledBodyOnGround(height, radius));

        expect(group.position.y).toBeCloseTo(0, 3); // feet on ground, not floating
    });

    it('is unchanged for a tall capsule (height/2 >= radius) — player/NPC', () => {
        const loader = loaderForCapsule(TALL.height, TALL.radius);

        const group = new THREE.Group();
        loader.syncCharacterWithPhysics(group, settledBodyOnGround(TALL.height, TALL.radius));

        expect(group.position.y).toBeCloseTo(0, 3);
    });

    it('applies the identical feet mapping to a positionOverride (render-position sync)', () => {
        const loader = loaderForCapsule(TALL.height, TALL.radius);

        const body = settledBodyOnGround(TALL.height, TALL.radius);
        const override = { x: 7, y: body.translation().y + 0.4, z: -2 };

        const group = new THREE.Group();
        loader.syncCharacterWithPhysics(group, body, override);

        // XZ come from the override, and Y gets the same capsule-bottom mapping
        // applied to the override's Y (0.4 above the settled body → feet at 0.4).
        expect(group.position.x).toBe(7);
        expect(group.position.z).toBe(-2);
        expect(group.position.y).toBeCloseTo(0.4, 3);
    });
});
