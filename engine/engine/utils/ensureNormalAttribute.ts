import * as THREE from 'three';

/**
 * Adds a dummy `(0, 1, 0)` normal attribute to the given geometry if one is missing.
 *
 * WebGPU's TSL pipeline warns whenever a NodeMaterial pulls in `attribute('normal')`
 * against a geometry without a normal attribute. WebGL silently filled in zero;
 * WebGPU does too (TSL substitutes `vec3(0, 1, 0)`) but logs a warning each time.
 * For meshes that rely on `flatShading: true` derivative-based normals or use unlit
 * materials, the attribute values don't matter at all — they just need to exist.
 */
export function ensureNormalAttribute(geometry: THREE.BufferGeometry): void {
    if (geometry.hasAttribute('normal')) return;
    const position = geometry.getAttribute('position');
    if (!position) return;
    const count = position.count;
    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        normals[i * 3 + 1] = 1;
    }
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
}
