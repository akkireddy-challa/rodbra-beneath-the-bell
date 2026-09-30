import * as THREE from 'three';

/**
 * Height of the ground-contact slice a prop's navmesh footprint is taken from:
 * above a character's knee, below any canopy, awning or table top a character
 * walks under.
 */
export const NAV_FOOTPRINT_SLICE_M = 1.2;

/**
 * The XZ box of a geometry's GROUND-CONTACT slice — the vertices within
 * `NAV_FOOTPRINT_SLICE_M` of its lowest point — rather than its whole bounding
 * box. A tree's canopy is five metres wide; its trunk, the only part a
 * character collides with, is half a metre. Footprinting the box blocked a
 * canopy-sized square of sidewalk around every tree and bush (a forged city
 * has ~280 of them), and NPCs spawned or pushed into that "void" had no
 * navmesh cell to path from and stood still. A bus, a wall or a crate is as
 * wide at the ground as anywhere and is unchanged. Cached on the geometry:
 * one vertex pass per asset, never per instance. Null for a geometry with no
 * computable bounds.
 */
export function groundContactBounds(geometry: THREE.BufferGeometry): THREE.Box3 | null {
    const cached = geometry.userData.navFootprintBounds as THREE.Box3 | undefined;
    if (cached) return cached;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const full = geometry.boundingBox;
    if (!full) return null;
    const position = geometry.getAttribute('position');
    let box = full;
    if (position && position.count > 0) {
        const cutY = full.min.y + NAV_FOOTPRINT_SLICE_M;
        const slice = new THREE.Box3();
        const v = new THREE.Vector3();
        for (let i = 0; i < position.count; i++) {
            if (position.getY(i) > cutY) continue;
            slice.expandByPoint(v.set(position.getX(i), position.getY(i), position.getZ(i)));
        }
        if (!slice.isEmpty()) box = slice;
    }
    geometry.userData.navFootprintBounds = box;
    return box;
}
