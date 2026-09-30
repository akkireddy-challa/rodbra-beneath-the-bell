/**
 * A batched environment prop must COLLIDE in the orientation it is DRAWN in.
 *
 * `EnvironmentObjectSystem` composes each InstancedMesh instance from the full
 * `rotationXYZ` a user set with the editor gizmo, but the physics body was
 * built from the Y component alone — so a prop tilted onto its side rendered
 * tilted and collided upright. The player is then blocked by, and stands on, a
 * shape that is not the one on screen.
 *
 * The rotation is fixed on the rigid BODY, so these tests stub the physics
 * world and read back the descriptor: no collider geometry, no stepping, and
 * no dependence on which collider branch the asset happens to take.
 */

import * as THREE from 'three';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

beforeAll(async () => {
    // RigidBodyDesc construction goes through the Rapier module.
    await initRapier();
});

interface Quat { x: number; y: number; z: number; w: number }

/** Records the descriptor `createPhysicsBodyAtPosition` builds its body from. */
function stubPhysicsWorld(): { world: PhysicsWorld; rotationOf: () => Quat } {
    let captured: Quat | null = null;
    const world = {
        createRigidBody: (desc: { rotation: Quat }) => {
            captured = { ...desc.rotation };
            return { handle: 1 };
        },
        createCollider: () => ({ handle: 2 }),
        setUserData: () => undefined,
    } as unknown as PhysicsWorld;
    return {
        world,
        rotationOf: () => {
            if (captured === null) throw new Error('no rigid body was created');
            return captured;
        },
    };
}

/** A minimal prop. The collider branch is irrelevant here — body rotation is
 *  set before any of them run. */
function prop(): VoxelObject {
    const object = new VoxelObject({ voxelSize: 0.25 });
    object.setVoxel(0, 0, 0, 1, 0x808080);
    object.setVoxel(1, 0, 0, 1, 0x808080);
    return object;
}

function expectSameRotation(actual: Quat, expected: THREE.Quaternion): void {
    for (const axis of ['x', 'y', 'z', 'w'] as const) {
        expect(actual[axis]).toBeCloseTo(expected[axis], 9);
    }
}

describe('batched env prop collider orientation', () => {
    it('collides in the tilted orientation it renders in', () => {
        // What EnvironmentObjectSystem composes the InstancedMesh matrix from:
        // `new THREE.Euler(rotationXYZ.x, rotationXYZ.y, rotationXYZ.z)`.
        const rotationXYZ = { x: 0.4, y: 1.1, z: -0.25 };
        const { world, rotationOf } = stubPhysicsWorld();

        prop().createPhysicsBodyAtPosition(world, 3, 1, -2, rotationXYZ.y, undefined, rotationXYZ);

        expectSameRotation(
            rotationOf(),
            new THREE.Quaternion().setFromEuler(
                new THREE.Euler(rotationXYZ.x, rotationXYZ.y, rotationXYZ.z),
            ),
        );
    });

    it('keeps the tilt even when the Y-only argument disagrees', () => {
        // The caller passes both; the full rotation is the authoritative one,
        // so a stale Y-only value can never quietly win.
        const { world, rotationOf } = stubPhysicsWorld();

        prop().createPhysicsBodyAtPosition(world, 0, 0, 0, 0, undefined, { x: 0.3, y: 2.0, z: 0.1 });

        expectSameRotation(
            rotationOf(),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 2.0, 0.1)),
        );
    });

    it('still accepts a Y-only rotation from callers that have nothing else', () => {
        const { world, rotationOf } = stubPhysicsWorld();

        prop().createPhysicsBodyAtPosition(world, 0, 0, 0, 0.75);

        expectSameRotation(
            rotationOf(),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.75, 0)),
        );
    });

    it('leaves an untilted prop exactly as before', () => {
        // A pure-Y `rotationXYZ` — every legacy prop — must produce the identical
        // quaternion the Y-only path produced, or this fix silently re-orients
        // every already-placed object in every published game.
        const { world: a, rotationOf: fromXYZ } = stubPhysicsWorld();
        const { world: b, rotationOf: fromY } = stubPhysicsWorld();

        prop().createPhysicsBodyAtPosition(a, 0, 0, 0, 0, undefined, { x: 0, y: 1.25, z: 0 });
        prop().createPhysicsBodyAtPosition(b, 0, 0, 0, 1.25);

        const tilted = fromXYZ();
        const upright = fromY();
        for (const axis of ['x', 'y', 'z', 'w'] as const) {
            expect(tilted[axis]).toBeCloseTo(upright[axis], 12);
        }
    });
});
