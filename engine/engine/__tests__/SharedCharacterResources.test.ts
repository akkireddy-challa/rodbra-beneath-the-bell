import * as THREE from 'three';
import {
    markSharedCharacterResources,
    isSharedCharacterResource,
    SHARED_TEMPLATE_FLAG,
} from 'engine/character/SharedCharacterResources.js';

/**
 * A crowd is one template cloned many times, and the clones share their geometry and
 * materials with it by reference. These tests pin the ownership marker that keeps one
 * instance's teardown from freeing the buffers every other instance is still drawing with.
 */
describe('SharedCharacterResources', () => {
    const meshWith = (material: THREE.Material | THREE.Material[]): THREE.Mesh =>
        new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material as THREE.Material);

    it('flags the geometry and material of every mesh under the clone', () => {
        const root = new THREE.Group();
        const mesh = meshWith(new THREE.MeshBasicMaterial());
        const nested = new THREE.Group();
        const deep = meshWith(new THREE.MeshBasicMaterial());
        nested.add(deep);
        root.add(mesh, nested);

        markSharedCharacterResources(root);

        for (const m of [mesh, deep]) {
            expect(m.geometry.userData[SHARED_TEMPLATE_FLAG]).toBe(true);
            expect((m.material as THREE.Material).userData[SHARED_TEMPLATE_FLAG]).toBe(true);
            expect(isSharedCharacterResource(m.geometry)).toBe(true);
            expect(isSharedCharacterResource(m.material as THREE.Material)).toBe(true);
        }
    });

    it('flags every material of a multi-material mesh', () => {
        const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
        const mesh = meshWith(materials);
        const root = new THREE.Group().add(mesh);

        markSharedCharacterResources(root);

        for (const material of materials) expect(isSharedCharacterResource(material)).toBe(true);
    });

    it('leaves resources an instance genuinely owns unmarked', () => {
        const owned = new THREE.BoxGeometry(1, 1, 1);
        expect(isSharedCharacterResource(owned)).toBe(false);
        expect(isSharedCharacterResource(null)).toBe(false);
        expect(isSharedCharacterResource(undefined)).toBe(false);
    });

    it('still recognises the block-part cache flag, which predates this one', () => {
        const cached = new THREE.BoxGeometry(1, 1, 1);
        cached.userData['__sharedLodCache'] = true;
        expect(isSharedCharacterResource(cached)).toBe(true);
    });

    it('is idempotent — re-marking a clone changes nothing', () => {
        const mesh = meshWith(new THREE.MeshBasicMaterial());
        const root = new THREE.Group().add(mesh);
        markSharedCharacterResources(root);
        markSharedCharacterResources(root);
        expect(isSharedCharacterResource(mesh.geometry)).toBe(true);
    });
});
