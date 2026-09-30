import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { LeafCarver } from 'engine/voxelcarve/LeafCarver.js';

/**
 * Carving has to preserve the invariants the whole VXL v3 pipeline rests on:
 * every leaf size is `minVoxelSize × 2^n`, and every leaf is grid-aligned to
 * its own size. Break either and the mesher, the greedy collider builder and
 * the encoder all misbehave in ways that only show up much later, so they are
 * asserted directly here.
 *
 * The other property that matters is CONSERVATION: subdividing must not create
 * or destroy matter beyond the hole itself.
 */

const MIN = 0.0625;

function leaf(x: number, y: number, z: number, size: number, over: Partial<OctreeLeaf> = {}): OctreeLeaf {
    return { x, y, z, size, r: 200, g: 100, b: 50, ...over };
}

function volumeOf(leaves: readonly OctreeLeaf[]): number {
    return leaves.reduce((sum, l) => sum + l.size ** 3, 0);
}

/** Is `size` a power-of-two multiple of the minimum? */
function isOnSizeGrid(size: number, min: number): boolean {
    const ratio = size / min;
    const rounded = Math.round(ratio);
    if (Math.abs(ratio - rounded) > 1e-6) return false;
    return (rounded & (rounded - 1)) === 0; // power of two
}

/** Is the leaf aligned to its own size? */
function isAligned(l: OctreeLeaf): boolean {
    const near = (v: number): boolean => Math.abs(v / l.size - Math.round(v / l.size)) < 1e-6;
    return near(l.x) && near(l.y) && near(l.z);
}

function assertInvariants(leaves: readonly OctreeLeaf[]): void {
    for (const l of leaves) {
        expect(isOnSizeGrid(l.size, MIN)).toBe(true);
        expect(isAligned(l)).toBe(true);
        expect(l.size).toBeGreaterThanOrEqual(MIN - 1e-9);
    }
}

describe('carving a single leaf', () => {
    it('subdivides a large leaf down to hole size and removes only that cube', () => {
        // 1.0 is 16x the minimum, so this needs four levels of descent.
        const carver = new LeafCarver([leaf(0, 0, 0, 1)], MIN);
        const removed = carver.carve(0.03, 0.03, 0.03, MIN);

        expect(removed).not.toBeNull();
        expect(removed!.size).toBeCloseTo(MIN, 9);

        const { leaves } = carver.result();
        assertInvariants(leaves);
        // Four levels of descent leave 7 siblings each.
        expect(leaves.length).toBe(4 * 7);
    });

    it('conserves volume exactly, minus the hole', () => {
        const carver = new LeafCarver([leaf(0, 0, 0, 1)], MIN);
        carver.carve(0.5, 0.5, 0.5, MIN);
        const { leaves, removedVolume } = carver.result();
        expect(volumeOf(leaves) + removedVolume).toBeCloseTo(1, 9);
        expect(removedVolume).toBeCloseTo(MIN ** 3, 12);
    });

    it('removes the cube that actually contains the impact', () => {
        const carver = new LeafCarver([leaf(0, 0, 0, 1)], MIN);
        const hit = { x: 0.8, y: 0.2, z: 0.6 };
        const removed = carver.carve(hit.x, hit.y, hit.z, MIN)!;

        expect(hit.x).toBeGreaterThanOrEqual(removed.x);
        expect(hit.x).toBeLessThan(removed.x + removed.size);
        expect(hit.y).toBeGreaterThanOrEqual(removed.y);
        expect(hit.y).toBeLessThan(removed.y + removed.size);
        expect(hit.z).toBeGreaterThanOrEqual(removed.z);
        expect(hit.z).toBeLessThan(removed.z + removed.size);

        // ...and no surviving leaf covers the impact any more.
        for (const l of carver.result().leaves) {
            const inside = hit.x >= l.x && hit.x < l.x + l.size
                && hit.y >= l.y && hit.y < l.y + l.size
                && hit.z >= l.z && hit.z < l.z + l.size;
            expect(inside).toBe(false);
        }
    });

    it('never subdivides below the format minimum', () => {
        // Asking for a hole finer than the file can represent gets minVoxelSize.
        const carver = new LeafCarver([leaf(0, 0, 0, MIN)], MIN);
        const removed = carver.carve(0.01, 0.01, 0.01, 0.001)!;
        expect(removed.size).toBeCloseTo(MIN, 9);
        expect(carver.result().leaves.length).toBe(0);
    });

    it('removes a whole leaf when it is already hole-sized', () => {
        const carver = new LeafCarver([leaf(0, 0, 0, MIN)], MIN);
        carver.carve(0.01, 0.01, 0.01, MIN);
        const { leaves, removed } = carver.result();
        expect(removed.length).toBe(1);
        expect(leaves.length).toBe(0);
    });

    it('stops descending once the cube is at or under the requested size', () => {
        // A 0.5 leaf with a 0.25 hole should descend exactly one level.
        const carver = new LeafCarver([leaf(0, 0, 0, 0.5)], MIN);
        const removed = carver.carve(0.1, 0.1, 0.1, 0.25)!;
        expect(removed.size).toBeCloseTo(0.25, 9);
        expect(carver.result().leaves.length).toBe(7);
    });

    it('inherits the parent material onto every child', () => {
        const source = leaf(0, 0, 0, 0.5, { emissive: 120, blockType: 7, slot: 3 });
        const carver = new LeafCarver([source], MIN);
        carver.carve(0.1, 0.1, 0.1, MIN);
        for (const l of carver.result().leaves) {
            expect(l.r).toBe(source.r);
            expect(l.g).toBe(source.g);
            expect(l.b).toBe(source.b);
            expect(l.emissive).toBe(120);
            expect(l.blockType).toBe(7);
            expect(l.slot).toBe(3);
        }
    });
});

describe('carveAlong — marching in from a coarse physics contact', () => {
    it('finds the surface a full physics-grid-step away from the contact', () => {
        // Prop colliders are greedy-meshed at ~4x the voxel size, so the
        // reported hit can sit that far off any real leaf. The march must cover
        // the gap; a fixed nudge (the first shipped version) cannot.
        const carver = new LeafCarver([leaf(0, 0, 0, MIN)], MIN);
        // Contact 4 voxels above the leaf, shooting straight down.
        const cube = carver.carveAlong(0.03, MIN * 4, 0.03, 0, -1, 0, MIN, MIN * 5);
        expect(cube).not.toBeNull();
        expect(carver.result().leaves.length).toBe(0);
    });

    it('gives up past maxDistance instead of tunnelling forever', () => {
        const carver = new LeafCarver([leaf(0, 0, 0, MIN)], MIN);
        const cube = carver.carveAlong(0.03, 10, 0.03, 0, -1, 0, MIN, MIN * 2);
        expect(cube).toBeNull();
        expect(carver.hasChanges()).toBe(false);
    });

    it('cannot step over a shell one voxel thick', () => {
        // Surface-voxelized assets are hollow; the march step is half a voxel
        // so a single-voxel wall is always sampled.
        const shell = [leaf(0, 0, 0, MIN)];
        const carver = new LeafCarver(shell, MIN);
        const cube = carver.carveAlong(0.03, MIN * 3, 0.03, 0, -1, 0, MIN, MIN * 4);
        expect(cube).not.toBeNull();
    });
});

describe('misses', () => {
    it('returns null for a point outside any leaf', () => {
        const carver = new LeafCarver([leaf(0, 0, 0, 0.5)], MIN);
        expect(carver.carve(5, 5, 5, MIN)).toBeNull();
        expect(carver.hasChanges()).toBe(false);
        expect(carver.result().leaves.length).toBe(1);
    });

    it('returns null for a second hit in an already-removed cube', () => {
        const carver = new LeafCarver([leaf(0, 0, 0, MIN)], MIN);
        expect(carver.carve(0.01, 0.01, 0.01, MIN)).not.toBeNull();
        expect(carver.carve(0.01, 0.01, 0.01, MIN)).toBeNull();
    });
});

describe('batched carving', () => {
    it('a burst of hits on one leaf keeps subdividing the survivors', () => {
        // The second round lands in a sibling the first one left behind — a leaf
        // the spatial index has never seen, so it must be found in the working set.
        const carver = new LeafCarver([leaf(0, 0, 0, 1)], MIN);
        const hits = [
            [0.1, 0.1, 0.1], [0.9, 0.1, 0.1], [0.1, 0.9, 0.1], [0.9, 0.9, 0.9],
            [0.5, 0.5, 0.5], [0.3, 0.7, 0.2], [0.15, 0.15, 0.15],
        ];
        for (const [x, y, z] of hits) {
            expect(carver.carve(x!, y!, z!, MIN)).not.toBeNull();
        }
        const { leaves, removed, removedVolume } = carver.result();
        expect(removed.length).toBe(hits.length);
        assertInvariants(leaves);
        expect(volumeOf(leaves) + removedVolume).toBeCloseTo(1, 9);
    });

    it('carves independent leaves independently', () => {
        const carver = new LeafCarver([
            leaf(0, 0, 0, 0.25),
            leaf(1, 0, 0, 0.25),
            leaf(2, 0, 0, 0.25),
        ], MIN);
        carver.carve(0.1, 0.1, 0.1, MIN);
        carver.carve(2.1, 0.1, 0.1, MIN);

        const { leaves, removed } = carver.result();
        expect(removed.length).toBe(2);
        // The untouched middle leaf survives whole.
        expect(leaves.some((l) => l.x === 1 && l.size === 0.25)).toBe(true);
        assertInvariants(leaves);
    });

    it('leaves the input array untouched', () => {
        const input = [leaf(0, 0, 0, 1)];
        const snapshot = JSON.stringify(input);
        const carver = new LeafCarver(input, MIN);
        carver.carve(0.5, 0.5, 0.5, MIN);
        carver.result();
        expect(JSON.stringify(input)).toBe(snapshot);
    });
});

describe('non-power-of-two minimums', () => {
    it('works at a forged level voxel size', () => {
        // Forged terrain and levels bake at sizes like 0.125; the invariant is
        // relative to the file's own minimum, not to any absolute scale.
        const min = 0.125;
        const carver = new LeafCarver([leaf(0, 0, 0, min * 8)], min);
        const removed = carver.carve(0.3, 0.3, 0.3, min)!;
        expect(removed.size).toBeCloseTo(min, 9);
        for (const l of carver.result().leaves) {
            expect(isOnSizeGrid(l.size, min)).toBe(true);
        }
    });
});
