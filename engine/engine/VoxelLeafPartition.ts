import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

/**
 * Repeatedly split the largest leaf list in half along its longest axis
 * until we have `targetPieces` lists (or every list is single-leaf). The
 * split plane is jittered ±15 % so identical fragments don't all bisect
 * at the same plane. Used by `VoxelObject.splitInPlace` to break up a
 * stuck dynamic fragment.
 */
export function spatialMidpointPartition(leaves: OctreeLeaf[], targetPieces: number): OctreeLeaf[][] {
    const aabbOf = (list: OctreeLeaf[]): { min: [number, number, number]; max: [number, number, number] } => {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const l of list) {
            if (l.x < minX) minX = l.x;
            if (l.y < minY) minY = l.y;
            if (l.z < minZ) minZ = l.z;
            const ex = l.x + l.size, ey = l.y + l.size, ez = l.z + l.size;
            if (ex > maxX) maxX = ex;
            if (ey > maxY) maxY = ey;
            if (ez > maxZ) maxZ = ez;
        }
        return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
    };

    const pieces: OctreeLeaf[][] = [leaves.slice()];
    while (pieces.length < targetPieces) {
        let largestIdx = 0;
        let largestSize = pieces[0]!.length;
        for (let i = 1; i < pieces.length; i++) {
            if (pieces[i]!.length > largestSize) {
                largestSize = pieces[i]!.length;
                largestIdx = i;
            }
        }
        if (largestSize < 2) break;
        const piece = pieces[largestIdx]!;
        const aabb = aabbOf(piece);
        const dx = aabb.max[0] - aabb.min[0];
        const dy = aabb.max[1] - aabb.min[1];
        const dz = aabb.max[2] - aabb.min[2];
        const axis = dx >= dy && dx >= dz ? 0 : (dy >= dz ? 1 : 2);
        const t = 0.5 + (Math.random() - 0.5) * 0.3;
        const mid = aabb.min[axis]! + (aabb.max[axis]! - aabb.min[axis]!) * t;
        const lower: OctreeLeaf[] = [];
        const upper: OctreeLeaf[] = [];
        for (const leaf of piece) {
            const half = leaf.size * 0.5;
            const c = (axis === 0 ? leaf.x : axis === 1 ? leaf.y : leaf.z) + half;
            if (c < mid) lower.push(leaf); else upper.push(leaf);
        }
        if (lower.length === 0 || upper.length === 0) break;
        pieces.splice(largestIdx, 1, lower, upper);
    }
    return pieces;
}
