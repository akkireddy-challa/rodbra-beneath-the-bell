import * as THREE from 'three';

/** Static vertical bathymetry, not reconstructed camera depth. Missing ground is deep water. */
export type CoastalHeightAt = (x: number, z: number) => number | null;

/** One query per water vertex, bounded by the builder's 161² vertex budget. */
export function addCoastalDepthAttribute(
    geometry: THREE.PlaneGeometry, centerX: number, centerZ: number, seaLevel: number,
    heightAt?: CoastalHeightAt,
): void {
    const positions = geometry.getAttribute('position');
    const depth = new Float32Array(positions.count);
    for (let i = 0; i < positions.count; i++) {
        // Plane local +Y becomes world -Z after its -PI/2 X rotation.
        // Sampling a second, coarser grid used to miss channels the water mesh
        // could resolve. Bathymetry controls shading, never water visibility:
        // still finer features are revealed by the actual terrain depth test.
        const ground = heightAt?.(centerX + positions.getX(i), centerZ - positions.getY(i));
        depth[i] = ground !== null && ground !== undefined && Number.isFinite(ground)
            ? THREE.MathUtils.clamp(seaLevel - ground, -10, 30) : 12;
    }
    geometry.setAttribute('waterDepth', new THREE.BufferAttribute(depth, 1));
}
