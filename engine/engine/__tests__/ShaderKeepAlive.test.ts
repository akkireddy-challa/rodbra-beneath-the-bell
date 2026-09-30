/** @jest-environment jsdom */
import * as THREE from 'three';
import { ShaderKeepAlive, keepShaderAlive, SHADER_KEEP_ALIVE_GROUP_NAME, LIGHT_CENSUS_INTERVAL_FRAMES } from 'engine/effects/ShaderKeepAlive.js';

function twins(scene: THREE.Scene): THREE.Object3D[] {
    const group = scene.getObjectByName(SHADER_KEEP_ALIVE_GROUP_NAME);
    return group ? group.children : [];
}

/** The twins keyed by the `key` they were retained under — names are `Group:key`. */
function twinsByKey(scene: THREE.Scene): Map<string | undefined, THREE.Object3D> {
    return new Map(twins(scene).map((twin) => [twin.name.split(':')[1], twin]));
}

describe('ShaderKeepAlive', () => {
    it('holds one visible clipped twin per key, cloning the material', () => {
        const scene = new THREE.Scene();
        const material = new THREE.MeshBasicMaterial({ transparent: true, vertexColors: true });
        keepShaderAlive(scene, 'arc', material, 'mesh', [{ name: 'color', itemSize: 4 }]);
        keepShaderAlive(scene, 'arc', material, 'mesh', [{ name: 'color', itemSize: 4 }]);

        const held = twins(scene);
        expect(held).toHaveLength(1);
        const twin = held[0] as THREE.Mesh;
        expect(twin.visible).toBe(true);
        expect(twin.frustumCulled).toBe(false);
        // Three vertices far below the world: a real draw call, nothing rasterised.
        expect(twin.geometry.getAttribute('position').count).toBe(3);
        expect(twin.geometry.getAttribute('position').getY(0)).toBeLessThan(-1000);
        expect(twin.geometry.drawRange.count).toBe(Infinity);
        expect(twin.geometry.getAttribute('color').itemSize).toBe(4);
        // An explicit layout replaces the mesh default, it does not add to it.
        expect(twin.geometry.hasAttribute('normal')).toBe(false);
        expect(twin.material).not.toBe(material);
        expect((twin.material as THREE.MeshBasicMaterial).vertexColors).toBe(true);

        // Disposing the caller's material leaves the twin's alone.
        material.dispose();
        expect(ShaderKeepAlive.for(scene).has('arc')).toBe(true);
    });

    it('gives a mesh the built-in-geometry layout by default, and points/lines position only', () => {
        const scene = new THREE.Scene();
        const registry = ShaderKeepAlive.for(scene);
        registry.retain('m', new THREE.MeshBasicMaterial());
        registry.retain('p', new THREE.PointsMaterial(), 'points');
        const byKey = twinsByKey(scene);
        const mesh = byKey.get('m') as THREE.Mesh;
        expect(mesh.geometry.getAttribute('normal').itemSize).toBe(3);
        expect(mesh.geometry.getAttribute('uv').itemSize).toBe(2);
        expect((byKey.get('p') as THREE.Points).geometry.hasAttribute('normal')).toBe(false);
    });

    it('copies the layout of a geometry passed as the layout', () => {
        const scene = new THREE.Scene();
        const box = new THREE.BoxGeometry(1, 1, 1);
        ShaderKeepAlive.for(scene).retain('box', new THREE.MeshBasicMaterial(), 'mesh', box);
        const twin = twins(scene)[0] as THREE.Mesh;
        expect(Object.keys(twin.geometry.attributes).sort()).toEqual(Object.keys(box.attributes).sort());
        expect(twin.geometry.getAttribute('position').count).toBe(3);
    });

    it('builds the object type the kind asks for', () => {
        const scene = new THREE.Scene();
        const registry = ShaderKeepAlive.for(scene);
        registry.retain('p', new THREE.PointsMaterial(), 'points');
        registry.retain('l', new THREE.LineBasicMaterial(), 'line');
        registry.retain('m', new THREE.MeshBasicMaterial());
        const byKey = twinsByKey(scene);
        expect((byKey.get('p') as THREE.Points).isPoints).toBe(true);
        expect((byKey.get('l') as THREE.Line).isLine).toBe(true);
        expect((byKey.get('m') as THREE.Mesh).isMesh).toBe(true);
        expect(registry.size).toBe(3);
    });

    it('retainFor reads material, kind and attributes off a renderable', () => {
        const scene = new THREE.Scene();
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
        geometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(3), 1));
        const points = new THREE.Points(geometry, new THREE.PointsMaterial({ vertexColors: true }));
        ShaderKeepAlive.for(scene).retainFor('burst', points);

        const twin = twins(scene)[0] as THREE.Points;
        expect(twin.isPoints).toBe(true);
        expect(twin.geometry.getAttribute('size').itemSize).toBe(1);
        expect((twin.material as THREE.PointsMaterial).vertexColors).toBe(true);
    });

    it('re-adds its group after the scene was cleared', () => {
        const scene = new THREE.Scene();
        ShaderKeepAlive.for(scene).retain('a', new THREE.MeshBasicMaterial());
        scene.clear();
        expect(twins(scene)).toHaveLength(0);
        ShaderKeepAlive.for(scene).retain('b', new THREE.MeshBasicMaterial());
        expect(twins(scene)).toHaveLength(2);
    });

    it('re-keys the twins when the visible light census changes', () => {
        const scene = new THREE.Scene();
        const lamp = new THREE.PointLight();
        scene.add(lamp);
        const registry = ShaderKeepAlive.for(scene);
        registry.retain('a', new THREE.MeshBasicMaterial());
        const twin = twins(scene)[0] as THREE.Mesh;
        const material = twin.material as THREE.Material;
        const version = material.version;

        let frame = 0;
        const render = (frames: number): void => {
            for (let i = 0; i < frames; i++) {
                const renderer = { info: { render: { frame: ++frame } } };
                registry.onTwinBeforeRender(renderer);
                registry.onTwinBeforeRender(renderer);   // a second twin in the same frame is a no-op
            }
        };

        render(LIGHT_CENSUS_INTERVAL_FRAMES * 2);            // steady lights: nothing to do
        expect(material.version).toBe(version);

        lamp.visible = false;                                 // culled — the count changes
        render(LIGHT_CENSUS_INTERVAL_FRAMES);
        expect(material.version).toBe(version + 1);

        render(LIGHT_CENSUS_INTERVAL_FRAMES * 3);             // steady again
        expect(material.version).toBe(version + 1);
    });

    it('dispose removes the twins and forgets the scene', () => {
        const scene = new THREE.Scene();
        const registry = ShaderKeepAlive.for(scene);
        registry.retain('a', new THREE.MeshBasicMaterial());
        registry.dispose();
        expect(scene.getObjectByName(SHADER_KEEP_ALIVE_GROUP_NAME)).toBeUndefined();
        expect(registry.size).toBe(0);
        expect(ShaderKeepAlive.for(scene)).not.toBe(registry);
    });
});
