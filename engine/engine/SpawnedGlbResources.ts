import * as THREE from 'three';

/** Own only the resources allocated for this spawn, even if game code replaces them later. */
export function cloneSpawnedGlb(template: THREE.Object3D): { object: THREE.Object3D; dispose: () => void } {
    const geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
    const materials = new Map<THREE.Material, THREE.Material>();
    const cloneMaterial = (source: THREE.Material): THREE.Material => {
        let material = materials.get(source);
        if (!material) {
            material = source.clone();
            materials.set(source, material);
        }
        return material;
    };
    const object = template.clone();
    object.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const source: THREE.BufferGeometry = child.geometry;
        let geometry = geometries.get(source);
        if (!geometry) {
            geometry = source.clone();
            geometries.set(source, geometry);
        }
        child.geometry = geometry;
        child.material = Array.isArray(child.material)
            ? child.material.map(cloneMaterial)
            : cloneMaterial(child.material);
    });
    return {
        object,
        dispose: () => {
            for (const geometry of geometries.values()) geometry.dispose();
            for (const material of materials.values()) material.dispose();
            geometries.clear();
            materials.clear();
        },
    };
}

/** Textures remain shared by the template and its material clones until every spawn is gone. */
export function disposeGlbTemplate(scene: THREE.Object3D): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    scene.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        geometries.add(child.geometry);
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
            materials.add(material);
            for (const value of Object.values(material)) {
                if (value instanceof THREE.Texture) textures.add(value);
            }
        }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
}
