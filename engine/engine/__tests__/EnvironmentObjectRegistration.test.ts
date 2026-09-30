import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import { ObjectIdService, getObjectIdService } from 'engine/ObjectIdService.js';

/**
 * Regression tests for the environment-object registration contract.
 *
 * Bug we're protecting against:
 *   EnvironmentObjectSystem used to register unpacked individual meshes as type 'env'
 *   while packed InstancedMeshes were type 'object'. This caused
 *   WorldGenerator.serializeEnvironmentObjects() (which queries getAllByType('object'))
 *   to silently miss every environment object whenever the editor was active.
 *   The original workaround — packing right before serializing — broke the editor
 *   when called from a read-only message handler.
 *
 * The contract these tests enforce:
 *   1. Every idService.register(...) in EnvironmentObjectSystem uses type 'object'.
 *   2. getAllByType('object') finds environment objects regardless of whether they're
 *      currently in packed (InstancedMesh) or unpacked (individual Mesh) form.
 */
describe('Environment object registration contract', () => {
    describe('static: type consistency in EnvironmentObjectSystem', () => {
        it('every idService.register call uses type "object"', () => {
            const sourcePath = path.resolve(__dirname, '../EnvironmentObjectSystem.ts');
            const source = fs.readFileSync(sourcePath, 'utf8');

            // Match `idService.register(` calls and capture the second argument (the type literal).
            // Pack/unpack must agree, otherwise serializeEnvironmentObjects() silently misses
            // objects in one of the two states.
            const callRegex = /idService\.register\(\s*[^,]+,\s*'([^']+)'/g;
            const types: string[] = [];
            let match: RegExpExecArray | null;
            while ((match = callRegex.exec(source)) !== null) {
                types.push(match[1]!);
            }

            expect(types.length).toBeGreaterThan(0);
            const inconsistent = types.filter(t => t !== 'object');
            expect(inconsistent).toEqual([]);
        });
    });

    describe('behavioral: registry survives a pack/unpack cycle', () => {
        beforeEach(() => {
            ObjectIdService.reset();
        });

        it('finds objects whether registered as packed or unpacked form', () => {
            const idService = getObjectIdService();
            const instancedMesh = new THREE.InstancedMesh(
                new THREE.BufferGeometry(),
                new THREE.MeshStandardMaterial(),
                3
            );

            // Packed form: each instance points to the same InstancedMesh with a distinct instanceIndex.
            idService.register('default_rock_0', 'object', instancedMesh, { instanceIndex: 0 });
            idService.register('default_rock_1', 'object', instancedMesh, { instanceIndex: 1 });
            idService.register('default_rock_2', 'object', instancedMesh, { instanceIndex: 2 });

            expect(idService.getAllByType('object')).toHaveLength(3);

            // Simulate unpack: unregister InstancedMesh entries, register individual meshes.
            // CRITICAL: type must stay 'object' or serializeEnvironmentObjects() will lose them.
            idService.unregister('default_rock_0');
            idService.unregister('default_rock_1');
            idService.unregister('default_rock_2');

            const mesh0 = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
            const mesh1 = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
            const mesh2 = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
            idService.register('default_rock_0', 'object', mesh0, { instanceIndex: 0 });
            idService.register('default_rock_1', 'object', mesh1, { instanceIndex: 1 });
            idService.register('default_rock_2', 'object', mesh2, { instanceIndex: 2 });

            // The bug: pre-fix, this assertion would have failed (type was 'env' → 0 results).
            expect(idService.getAllByType('object')).toHaveLength(3);
        });
    });
});
