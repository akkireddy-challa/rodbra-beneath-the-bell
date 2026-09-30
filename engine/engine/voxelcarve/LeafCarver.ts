import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { LeafSpatialIndex } from 'engine/VoxelObjectLeafEdit.js';

/**
 * Carving bullet-sized holes out of a VXL v3 octree leaf set.
 *
 * A leaf is a variable-size cube, and a bullet hole is usually much smaller
 * than the leaf it lands in. So rather than deleting the whole leaf — which
 * turns a rifle round into a crater — the struck leaf is SUBDIVIDED into eight
 * children, the child containing the impact is subdivided again, and so on
 * until it is hole-sized. Only that last child is removed; its siblings stay as
 * real leaves. The result is a hole in otherwise untouched geometry.
 *
 * This works because of an invariant the format already guarantees (see
 * VoxelObjectLeafEdit's header): every leaf size is `minVoxelSize × 2^n`, and
 * every leaf is grid-aligned to its own size relative to the bounds origin.
 * Halving a leaf therefore produces eight children that are themselves valid
 * leaves on the same grid — nothing downstream (mesher, greedy collider,
 * encoder, LOD regeneration) needs to learn a new representation. The voxelizer
 * already descends exactly this way at bake time (GLBVoxelizer's octree
 * subdivision); this is the same descent, run at runtime and in reverse.
 *
 * THE FLOOR IS `minVoxelSize`, and it is not negotiable here: LeafBuffer stores
 * leaf positions as integer multiples of it, so a leaf finer than the file's own
 * minimum cannot be encoded or re-quantised. Asking for a smaller hole gets one
 * exactly `minVoxelSize` across. At the sizes assets and forged levels actually
 * bake to (0.0625 m and ~0.125 m) that is already hole-scale.
 *
 * Pure data — no three.js, no scene, no engine. All coordinates are in the leaf
 * set's own bounds-space object units, the same space `OctreeLeaf.x/y/z` use.
 */

/** A cube removed by a carve, for debris and damage accounting. */
export interface CarvedCube {
    x: number;
    y: number;
    z: number;
    size: number;
    r: number;
    g: number;
    b: number;
}

export interface CarveOutcome {
    /** The full leaf list after carving. A new array; the input is untouched. */
    leaves: OctreeLeaf[];
    /** Cubes removed, in carve order. */
    removed: CarvedCube[];
    /** Total volume removed, in cubic object units. */
    removedVolume: number;
}

/** Relative tolerance for float comparisons against leaf sizes. */
const EPSILON_SCALE = 1e-3;

/** Copy a leaf's material identity onto a new child cube. */
function childOf(parent: OctreeLeaf, x: number, y: number, z: number, size: number): OctreeLeaf {
    const child: OctreeLeaf = { x, y, z, size, r: parent.r, g: parent.g, b: parent.b };
    if (parent.emissive !== undefined) child.emissive = parent.emissive;
    if (parent.blockType !== undefined) child.blockType = parent.blockType;
    if (parent.slot !== undefined) child.slot = parent.slot;
    return child;
}

/**
 * Applies a batch of carves to one leaf set.
 *
 * Batched deliberately: a carve costs the owning object a full remesh and
 * collider rebuild, so a burst of automatic fire must produce ONE rebuild, not
 * one per round. Construct, call `carve` per impact, then read `result` once.
 */
export class LeafCarver {
    private readonly source: readonly OctreeLeaf[];
    private readonly index: LeafSpatialIndex;
    private readonly minVoxelSize: number;
    private readonly epsilon: number;

    /** Indices into `source` that have been consumed by a split or removal. */
    private readonly consumed = new Set<number>();
    /** Leaves produced by splitting. Small, so a linear scan is the right lookup. */
    private working: OctreeLeaf[] = [];
    private readonly removed: CarvedCube[] = [];
    private removedVolume = 0;

    constructor(leaves: readonly OctreeLeaf[], minVoxelSize: number) {
        this.source = leaves;
        this.minVoxelSize = minVoxelSize > 0 ? minVoxelSize : 1;
        this.epsilon = this.minVoxelSize * EPSILON_SCALE;
        this.index = new LeafSpatialIndex(leaves as OctreeLeaf[], this.minVoxelSize);
    }

    /** Whether any carve actually removed matter. */
    hasChanges(): boolean {
        return this.removed.length > 0;
    }

    getRemoved(): readonly CarvedCube[] {
        return this.removed;
    }

    /**
     * Punch one hole at the first solid matter along a ray, in bounds space.
     *
     * Exists because the physics surface a bullet reports hitting is NOT the
     * voxel surface: prop colliders are greedy-meshed on a coarsened grid
     * (physicsGridStep, typically 4x the voxel size), so the reported contact
     * can sit a full grid step outside any actual leaf. A fixed inward nudge
     * therefore lands in air as often as not — the carve must MARCH inward
     * until it finds the real surface.
     *
     * @param maxDistance how far to march before giving up (bounds units) —
     *        callers pass the object's physics grid step plus a voxel.
     * @returns the removed cube, or null if the march exhausted `maxDistance`.
     */
    carveAlong(
        x: number, y: number, z: number,
        dirX: number, dirY: number, dirZ: number,
        holeSize: number, maxDistance: number,
    ): CarvedCube | null {
        const len = Math.hypot(dirX, dirY, dirZ);
        if (!(len > 0)) return this.carve(x, y, z, holeSize);
        const nx = dirX / len, ny = dirY / len, nz = dirZ / len;
        // Half a voxel per step cannot tunnel through a shell one voxel thick.
        const step = this.minVoxelSize * 0.5;
        for (let travelled = 0; travelled <= maxDistance; travelled += step) {
            const cube = this.carve(x + nx * travelled, y + ny * travelled, z + nz * travelled, holeSize);
            if (cube) return cube;
        }
        return null;
    }

    /**
     * Punch one hole at a point in bounds space.
     *
     * @param holeSize desired hole edge length; raised to `minVoxelSize` if smaller.
     * @returns the cube removed, or null if the point was not inside solid matter
     *          (a graze, or a hit on a leaf already carved away this batch).
     */
    carve(x: number, y: number, z: number, holeSize: number): CarvedCube | null {
        const target = Math.max(holeSize, this.minVoxelSize);

        // Leaves added by an earlier carve in this same batch are checked first:
        // a second round through the same spot lands in one of the siblings the
        // first one left behind, which the spatial index has never seen.
        const workingHit = this.findInWorking(x, y, z);
        if (workingHit >= 0) {
            const leaf = this.working[workingHit]!;
            // swap-remove: order is irrelevant and this keeps it O(1)
            const last = this.working.pop()!;
            if (workingHit < this.working.length) this.working[workingHit] = last;
            return this.splitDownAndRemove(leaf, x, y, z, target);
        }

        const sourceHit = this.index.leafIndexAt(x, y, z);
        if (sourceHit < 0 || this.consumed.has(sourceHit)) return null;
        this.consumed.add(sourceHit);
        return this.splitDownAndRemove(this.source[sourceHit]!, x, y, z, target);
    }

    /**
     * Descend from `leaf` toward the impact, halving as we go, and remove the
     * final cube. Every sibling passed on the way down is kept.
     */
    private splitDownAndRemove(
        leaf: OctreeLeaf, x: number, y: number, z: number, target: number,
    ): CarvedCube {
        let current = leaf;

        // Stop when the cube is already at or below the requested hole size, or
        // when halving would go finer than the format can represent.
        while (
            current.size > target + this.epsilon
            && current.size * 0.5 >= this.minVoxelSize - this.epsilon
        ) {
            const half = current.size * 0.5;
            // Which octant holds the impact. Clamped so a hit exactly on the
            // far face still resolves to a real child rather than falling out.
            const hx = x >= current.x + half ? 1 : 0;
            const hy = y >= current.y + half ? 1 : 0;
            const hz = z >= current.z + half ? 1 : 0;

            let chosen: OctreeLeaf | null = null;
            for (let ix = 0; ix < 2; ix++) {
                for (let iy = 0; iy < 2; iy++) {
                    for (let iz = 0; iz < 2; iz++) {
                        const child = childOf(
                            current,
                            current.x + ix * half,
                            current.y + iy * half,
                            current.z + iz * half,
                            half,
                        );
                        if (ix === hx && iy === hy && iz === hz) chosen = child;
                        else this.working.push(child);
                    }
                }
            }
            // chosen is always assigned: hx/hy/hz are each 0 or 1.
            current = chosen!;
        }

        const cube: CarvedCube = {
            x: current.x, y: current.y, z: current.z, size: current.size,
            r: current.r, g: current.g, b: current.b,
        };
        this.removed.push(cube);
        this.removedVolume += current.size * current.size * current.size;
        return cube;
    }

    private findInWorking(x: number, y: number, z: number): number {
        const e = this.epsilon;
        for (let i = 0; i < this.working.length; i++) {
            const leaf = this.working[i]!;
            if (
                x >= leaf.x - e && x < leaf.x + leaf.size + e
                && y >= leaf.y - e && y < leaf.y + leaf.size + e
                && z >= leaf.z - e && z < leaf.z + leaf.size + e
            ) return i;
        }
        return -1;
    }

    /** The carved leaf set. Safe to call once; cheap to call again. */
    result(): CarveOutcome {
        const leaves: OctreeLeaf[] = [];
        for (let i = 0; i < this.source.length; i++) {
            if (!this.consumed.has(i)) leaves.push(this.source[i]!);
        }
        for (const leaf of this.working) leaves.push(leaf);
        return { leaves, removed: this.removed.slice(), removedVolume: this.removedVolume };
    }
}
