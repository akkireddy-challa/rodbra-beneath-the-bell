/**
 * FragmentConnectivity — fragment-level support analysis for pre-fragmented
 * voxel assets.
 *
 * A multi-fragment VoxelObject detaches blast-hit fragments whole
 * (`detachAffectedFragments`). Historically nothing checked what the removal
 * left behind, so smashing a cactus trunk left the arms hovering in the air:
 * the leaf-level structural-collapse callback (`setOnPostExplosion`) never
 * fires on the fragmented path — the container has no leaves of its own to
 * flood-fill. This module supplies the missing check at the granularity the
 * fragmented path actually works in: fragment AABBs.
 *
 * Support model: a fragment is supported when it is connected — through
 * face-touching AABB adjacency — to a fragment resting on the object's ground
 * plane (the minimum Y across all fragments, which pre-fragmentation aligns
 * with the asset's base). Everything not reachable from the ground set is
 * unsupported and should detach and fall.
 *
 * Pure functions over plain AABBs — no THREE / physics imports — so the
 * flood fill is trivially unit-testable and reusable (the same shape covers
 * future editor-side "will this break apart?" queries).
 */

/** Object-local fragment AABB as stored in `VoxelObject._fragmentAabbs`. */
export interface FragmentAabb {
    min: [number, number, number];
    max: [number, number, number];
}

/**
 * Tolerance for face contact and for membership in the ground layer, in
 * object-local units (world meters for v3 assets). Pre-fragmented assets tile
 * their fragments on the voxel grid (≥ 0.05 m in practice), so 10 mm cleanly
 * separates "shares a face" from "merely nearby" without false negatives from
 * float error.
 */
const CONTACT_EPS = 0.01;

/** Two AABBs share a face: touching along one axis, overlapping on the other two. */
export function aabbsShareFace(a: FragmentAabb, b: FragmentAabb, eps: number = CONTACT_EPS): boolean {
    const overlapX = a.min[0] < b.max[0] - eps && b.min[0] < a.max[0] - eps;
    const overlapY = a.min[1] < b.max[1] - eps && b.min[1] < a.max[1] - eps;
    const overlapZ = a.min[2] < b.max[2] - eps && b.min[2] < a.max[2] - eps;

    const touchX = Math.abs(a.max[0] - b.min[0]) < eps || Math.abs(b.max[0] - a.min[0]) < eps;
    const touchY = Math.abs(a.max[1] - b.min[1]) < eps || Math.abs(b.max[1] - a.min[1]) < eps;
    const touchZ = Math.abs(a.max[2] - b.min[2]) < eps || Math.abs(b.max[2] - a.min[2]) < eps;

    return (touchX && overlapY && overlapZ)
        || (touchY && overlapX && overlapZ)
        || (touchZ && overlapX && overlapY);
}

/** The object's original base plane: minimum Y over the FULL fragment set. */
export function groundPlaneY(aabbs: ReadonlyArray<FragmentAabb>): number {
    let minY = Infinity;
    for (const box of aabbs) {
        if (box.min[1] < minY) minY = box.min[1];
    }
    return minY;
}

/**
 * Indices of fragments NOT connected (via face adjacency) to the ground
 * layer. The ground layer is every fragment whose bottom face lies within
 * `eps` of `groundY`.
 *
 * `groundY` MUST be the object's ORIGINAL base plane (captured from the full
 * fragment set at load — see `groundPlaneY`), never recomputed from the
 * surviving fragments: once a blast removes the base, the lowest SURVIVOR is
 * the floating remnant itself, which would then anchor the flood fill and
 * report everything as supported. That is exactly how a smashed cactus is
 * left with its top hanging in mid-air.
 *
 * Returns an empty array when everything is supported, and — deliberately —
 * when NOTHING reaches the ground layer: a fully airborne remnant is the
 * caller's decision (shatter mode releases it wholesale), not something to
 * silently delete here.
 *
 * O(n²) adjacency over ≤ ~100 fragments per asset; runs only at break
 * events, never per frame.
 */
export function findUnsupportedFragments(
    aabbs: ReadonlyArray<FragmentAabb>,
    groundY: number,
    eps: number = CONTACT_EPS,
): number[] {
    const n = aabbs.length;
    if (n === 0) return [];

    const connected = new Uint8Array(n);
    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
        if (aabbs[i]!.min[1] <= groundY + eps) {
            connected[i] = 1;
            queue.push(i);
        }
    }
    // No seed means nothing touches the ground any more: the flood fill below
    // does nothing and every fragment is reported unsupported. The caller
    // decides what that means.
    while (queue.length > 0) {
        const current = queue.pop()!;
        const box = aabbs[current]!;
        for (let i = 0; i < n; i++) {
            if (connected[i]) continue;
            if (aabbsShareFace(box, aabbs[i]!, eps)) {
                connected[i] = 1;
                queue.push(i);
            }
        }
    }

    const unsupported: number[] = [];
    for (let i = 0; i < n; i++) {
        if (!connected[i]) unsupported.push(i);
    }
    return unsupported;
}
