import * as THREE from 'three';
import { disposeSpawnedEnvObjectContent, type EnvObjectTeardownParts } from 'engine/levels/envObjectTeardown.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * Instanced props are drawn by an InstancedMesh, so their per-instance fixed
 * bodies hang off NO Object3D — walking the scene graph can never find them.
 * When the teardown missed them, a level switch left the unloaded level's whole
 * collision set in the world: invisible walls on the level you switched TO.
 */

function fakeBody(id: number): { id: number; isValid: () => boolean } {
    return { id, isValid: () => true };
}

function makeParts(over: Partial<EnvObjectTeardownParts> = {}): {
    parts: EnvObjectTeardownParts;
    removed: unknown[];
} {
    const removed: unknown[] = [];
    const physicsWorld = {
        removeRigidBody: (b: unknown) => { removed.push(b); },
    } as unknown as PhysicsWorld;
    return {
        removed,
        parts: {
            physicsWorld,
            objectStorage: new Map(),
            lodStorage: new Map(),
            chunkMeshes: new Map(),
            worldBodies: [],
            chunkPhysicsBodies: new Map(),
            dynamicObjects: [],
            individualObjects: [],
            ...over,
        },
    };
}

describe('disposeSpawnedEnvObjectContent', () => {
    test('removes every registered body, not just the ones hanging off a mesh', () => {
        const instanceBodies = [fakeBody(1), fakeBody(2), fakeBody(3)];
        const meshBody = fakeBody(4);
        const mesh = new THREE.Mesh();
        mesh.userData.rigidBody = meshBody;

        const { parts, removed } = makeParts({
            worldBodies: [...instanceBodies],
            chunkPhysicsBodies: new Map([['0,0', [...instanceBodies]]]),
            dynamicObjects: [{ syncWithPhysics: () => {} }],
            objectStorage: new Map([['Cactus', {
                instances: [], instancedMesh: null, unpackedMeshes: [mesh],
            }]]),
        });

        disposeSpawnedEnvObjectContent(parts);

        expect(removed).toEqual([meshBody, ...instanceBodies]);
        expect(parts.worldBodies).toHaveLength(0);
        expect(parts.chunkPhysicsBodies.size).toBe(0);
        expect(parts.dynamicObjects).toHaveLength(0);
        expect(mesh.userData.rigidBody).toBeNull();
    });

    test('takes down objects that own their scene node, and disposes dynamic props', () => {
        const disposed: string[] = [];
        const glbProp = new THREE.Group() as THREE.Group & { dispose?: () => void };
        const parent = new THREE.Object3D();
        parent.add(glbProp);
        // A dynamic GLB prop's body lives only inside its adapter closure.
        const dynamicAdapter = { syncWithPhysics: () => {}, dispose: () => { disposed.push('glbBody'); } };

        const { parts } = makeParts({
            individualObjects: [glbProp],
            dynamicObjects: [dynamicAdapter],
        });

        disposeSpawnedEnvObjectContent(parts);

        expect(glbProp.parent).toBeNull();
        expect(disposed).toEqual(['glbBody']);
        expect(parts.individualObjects).toHaveLength(0);
        expect(parts.dynamicObjects).toHaveLength(0);
    });

    test('skips bodies Rapier already invalidated', () => {
        const dead = { id: 9, isValid: () => false };
        const { parts, removed } = makeParts({ worldBodies: [dead] });

        disposeSpawnedEnvObjectContent(parts);

        expect(removed).toHaveLength(0);
        expect(parts.worldBodies).toHaveLength(0);
    });

    test('clears the registries even with no physics world', () => {
        const { parts } = makeParts({ physicsWorld: null, worldBodies: [fakeBody(1)] });

        expect(() => disposeSpawnedEnvObjectContent(parts)).not.toThrow();
        expect(parts.worldBodies).toHaveLength(0);
    });
});
