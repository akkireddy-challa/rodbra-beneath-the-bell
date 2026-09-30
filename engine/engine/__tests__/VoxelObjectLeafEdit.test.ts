/** @jest-environment jsdom */
import { LeafSpatialIndex, computeLeafBounds, buildEditedVxlV3Data } from 'engine/VoxelObjectLeafEdit.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { encodeVxlV3, type DecodedVxlV3 } from 'engine/VxlV3Format.js';
import { LeafBuffer } from 'engine/VoxelOctreeRenderer.js';

const MIN = 0.1;

function leaf(x: number, y: number, z: number, size: number, r = 1, g = 0, b = 0): OctreeLeaf {
    return { x, y, z, size, r, g, b };
}

describe('computeLeafBounds', () => {
    it('spans min corners to max corners', () => {
        const bounds = computeLeafBounds([leaf(0, 0, 0, MIN), leaf(0.4, 0.2, 0, 0.2)]);
        expect(bounds.minX).toBeCloseTo(0);
        expect(bounds.maxX).toBeCloseTo(0.6);
        expect(bounds.maxY).toBeCloseTo(0.4);
        expect(bounds.maxZ).toBeCloseTo(0.2);
    });

    it('returns zeros for an empty list', () => {
        expect(computeLeafBounds([])).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });
    });
});

describe('LeafSpatialIndex', () => {
    const leaves = [
        leaf(0, 0, 0, MIN),
        leaf(0.2, 0, 0, 0.2),      // merged (2x) leaf next to a min leaf
        leaf(-0.3, 0.5, -0.3, MIN), // negative coords
    ];
    const index = new LeafSpatialIndex(leaves, MIN);

    it('finds the containing leaf for interior points (variable sizes)', () => {
        expect(index.leafIndexAt(0.05, 0.05, 0.05)).toBe(0);
        expect(index.leafIndexAt(0.3, 0.1, 0.1)).toBe(1);
        expect(index.leafIndexAt(-0.25, 0.55, -0.25)).toBe(2);
    });

    it('misses empty space', () => {
        expect(index.leafIndexAt(1.0, 1.0, 1.0)).toBe(-1);
        expect(index.leafIndexAt(0.05, 0.5, 0.05)).toBe(-1);
    });

    it('reports box overlaps against any leaf', () => {
        // Overlapping the big leaf's interior
        expect(index.overlapsBox(0.25, 0.05, 0.05, 0.35, 0.15, 0.15)).toBe(true);
        // A free cell directly above the min leaf
        expect(index.overlapsBox(0, MIN, 0, MIN, 2 * MIN, MIN)).toBe(false);
        // Face-adjacent (touching, not overlapping) must NOT count
        expect(index.overlapsBox(MIN, 0, 0, 2 * MIN, MIN, MIN)).toBe(false);
    });
});

describe('buildEditedVxlV3Data', () => {
    function makeTemplate(overrides: Partial<DecodedVxlV3> = {}): DecodedVxlV3 {
        return {
            minVoxelSize: MIN,
            maxVoxelSize: 0.4,
            physicsGridStep: 0.5,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
            useAtlas: false,
            fragments: [{ aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], leaves: LeafBuffer.fromArray([], MIN, 0, 0, 0) }],
            ...overrides,
        };
    }

    it('emits a single fragment with recomputed bounds from the live leaves', () => {
        const leaves = [leaf(0, 0, 0, MIN), leaf(0.5, 0.5, 0.5, MIN)];
        const data = buildEditedVxlV3Data(leaves, makeTemplate(), {
            voxelSize: MIN, physicsGridStep: 0.5, useAtlas: false,
        });
        expect(data.fragments).toHaveLength(1);
        expect(data.fragments[0]!.leaves).toBe(leaves);
        expect(data.bounds.minX).toBeCloseTo(0);
        expect(data.bounds.maxX).toBeCloseTo(0.6);
        expect(data.minVoxelSize).toBe(MIN);
        expect(data.physicsGridStep).toBe(0.5);
    });

    it('regenerates coarser LODs from the edited leaves (volume-weighted majority color)', () => {
        // A full 2x2x2 block of min leaves at the grid origin: 7 red, 1 green.
        const leaves: OctreeLeaf[] = [];
        for (let x = 0; x < 2; x++) {
            for (let y = 0; y < 2; y++) {
                for (let z = 0; z < 2; z++) {
                    const isGreen = x === 0 && y === 0 && z === 0;
                    leaves.push(leaf(x * MIN, y * MIN, z * MIN, MIN, isGreen ? 0 : 1, isGreen ? 1 : 0, 0));
                }
            }
        }
        // Plus one already-coarse leaf elsewhere that must survive unchanged.
        const big = leaf(0.4, 0, 0, 0.2, 0, 0, 1);
        leaves.push(big);

        const template = makeTemplate({
            additionalLods: [{
                minVoxelSize: 0.2,
                maxVoxelSize: 0.4,
                fragments: [{ aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], leaves: LeafBuffer.fromArray([], MIN, 0, 0, 0) }],
            }],
        });

        const data = buildEditedVxlV3Data(leaves, template, {
            voxelSize: MIN, physicsGridStep: 0.5, useAtlas: false,
        });

        expect(data.additionalLods).toHaveLength(1);
        const lod = data.additionalLods![0]!;
        expect(lod.minVoxelSize).toBe(0.2);
        const lodLeaves = lod.fragments[0]!.leaves;

        // The 8 min leaves collapse into ONE 0.2 leaf, majority-red.
        const merged = lodLeaves.filter(l => Math.abs(l.x) < 1e-6 && Math.abs(l.y) < 1e-6 && Math.abs(l.z) < 1e-6);
        expect(merged).toHaveLength(1);
        expect(merged[0]!.size).toBeCloseTo(0.2);
        expect(merged[0]!.r).toBe(1);
        expect(merged[0]!.g).toBe(0);

        // The already-coarse leaf survives as-is.
        const survivor = lodLeaves.find(l => Math.abs(l.x - 0.4) < 1e-6);
        expect(survivor).toBeDefined();
        expect(survivor!.size).toBeCloseTo(0.2);
        expect(survivor!.b).toBe(1);

        expect(lodLeaves).toHaveLength(2);
    });

    it('encodes when the file bounds are looser than the voxels they contain', async () => {
        // A voxelized asset stores the SOURCE MODEL's AABB, which routinely sits
        // outside the snapped voxel grid — a real one had bounds min X -1.25 with
        // its first leaf at -1.0625, three cells in. Re-encoding recomputes the
        // tight bounds, so a coarse grid still anchored at the old origin starts
        // BELOW the new minimum, and `writeFragments` — which encodes every LOD as
        // `round((leaf.x - bounds.minX) / lodVoxelSize)` — cannot represent that.
        // The save threw "VXL3 grid coord overflow: (-1, 0, 0)" and the edit was
        // lost. Nothing had to move: re-encoding every LOD is what a save does.
        const leaves = [leaf(3 * MIN, 0, 0, MIN), leaf(4 * MIN, 0, 0, MIN)];
        const template = makeTemplate({
            // Loose on X by 3 cells, tight on Y and Z — the shape that yields
            // exactly (-1, 0, 0).
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
            additionalLods: [{
                minVoxelSize: 4 * MIN,
                maxVoxelSize: 4 * MIN,
                fragments: [{ aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], leaves: LeafBuffer.fromArray([], MIN, 0, 0, 0) }],
            }],
        });

        const data = buildEditedVxlV3Data(leaves, template, {
            voxelSize: MIN, physicsGridStep: 0.5, useAtlas: false,
        });

        // The bounds tighten onto the leaves; every LOD cell must stay inside them.
        expect(data.bounds.minX).toBeCloseTo(3 * MIN);
        for (const lod of data.additionalLods!) {
            for (const l of lod.fragments[0]!.leaves) {
                expect(l.x).toBeGreaterThanOrEqual(data.bounds.minX - 1e-6);
                expect(l.y).toBeGreaterThanOrEqual(data.bounds.minY - 1e-6);
                expect(l.z).toBeGreaterThanOrEqual(data.bounds.minZ - 1e-6);
            }
        }
        // The assertion that actually reproduces the user-visible failure.
        await expect(encodeVxlV3(data, { compression: 'none' })).resolves.toBeDefined();
    });

    describe('a light survives coarsening and the file round trip', () => {
        // One glowing voxel inside a 2x2x2 cell of dark ones — a bulb in its
        // fixture, which is what every lamp actually looks like. It loses the
        // volume vote 7 to 1, and losing it is why distant lamps went dark.
        function lampLeaves(): OctreeLeaf[] {
            const out: OctreeLeaf[] = [];
            for (let x = 0; x < 2; x++) {
                for (let y = 0; y < 2; y++) {
                    for (let z = 0; z < 2; z++) {
                        const bulb = x === 1 && y === 1 && z === 1;
                        out.push(bulb
                            ? { x: x * MIN, y: y * MIN, z: z * MIN, size: MIN, r: 1, g: 0.9, b: 0.6, emissive: 255, slot: 1 }
                            : { x: x * MIN, y: y * MIN, z: z * MIN, size: MIN, r: 0.1, g: 0.1, b: 0.1 });
                    }
                }
            }
            return out;
        }

        const lampTemplate = (): DecodedVxlV3 => makeTemplate({
            additionalLods: [{
                minVoxelSize: 2 * MIN,
                maxVoxelSize: 2 * MIN,
                fragments: [{ aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], leaves: LeafBuffer.fromArray([], MIN, 0, 0, 0) }],
            }],
        });

        it('keeps the coarse cell lit, in the light own colour', () => {
            const data = buildEditedVxlV3Data(lampLeaves(), lampTemplate(), {
                voxelSize: MIN, physicsGridStep: 0.5, useAtlas: false,
            }, [{ name: 'glow', emissive: 255 }]);

            const coarse = data.additionalLods![0]!.fragments[0]!.leaves;
            expect(coarse).toHaveLength(1);
            expect(coarse[0]!.emissive).toBe(255);
            expect(coarse[0]!.slot).toBe(1);
            // The bulb's hue, not the fixture's grey — a glow is albedo-tinted.
            expect(coarse[0]!.r).toBeCloseTo(1);
            expect(coarse[0]!.g).toBeCloseTo(0.9);
        });

    });

    it('omits additionalLods when the template had none', () => {
        const data = buildEditedVxlV3Data([leaf(0, 0, 0, MIN)], makeTemplate(), {
            voxelSize: MIN, physicsGridStep: 0.5, useAtlas: false,
        });
        expect(data.additionalLods).toBeUndefined();
    });

    it('grows maxVoxelSize to cover the largest live leaf', () => {
        const data = buildEditedVxlV3Data([leaf(0, 0, 0, 0.8)], makeTemplate(), {
            voxelSize: MIN, physicsGridStep: 0.5, useAtlas: false,
        });
        expect(data.maxVoxelSize).toBeCloseTo(0.8);
    });

    /**
     * Whatever the file carried, the save has to carry back.
     *
     * This has now gone wrong twice at one version's remove: v7's slot table was
     * dropped here and every named material — with every light riding on one — went
     * with it, and v10's rig was dropped the same way, which turns a character back
     * into a pile of voxels. The sections are ASSET-level, so nothing downstream can
     * reconstruct or even notice them: the save reports success and the loss surfaces
     * on the next load. Each new section needs a case here.
     */
    describe('asset-level sections a re-save must not drop', () => {
        const rig = {
            skeletonRef: 'mixamo-22-v1',
            bindPositions: new Float32Array(22 * 3).map((_, i) => i * 0.01),
            bones: new Uint8Array(),
            lodBones: [],
            fillers: {
                count: 1,
                gx: new Uint16Array([0]), gy: new Uint16Array([1]), gz: new Uint16Array([0]),
                bone: new Uint8Array([1]), color: new Uint16Array([0x0f00]),
            },
            sockets: [{ name: 'head', joint: 5, offset: [0, 1.5, 0] as [number, number, number] }],
        };

        it('carries the template rig, so an edited character is still rigged', () => {
            const data = buildEditedVxlV3Data([leaf(0, 0, 0, MIN)], makeTemplate({ rig }), {
                voxelSize: MIN, physicsGridStep: 0.5, useAtlas: false,
            });
            // Present at all is what decides v10 vs v9 — absent means no skeleton.
            expect(data.rig).toBeDefined();
            expect(data.rig!.skeletonRef).toBe('mixamo-22-v1');
            expect(data.rig!.sockets).toHaveLength(1);
            expect(data.rig!.fillers.count).toBe(1);
        });

        it('does not hand back a stale bone column', () => {
            // The encoder reads the owning joint off each leaf, in ITS order. A column
            // captured at decode no longer lines up once the editor adds or deletes a
            // voxel, so the input type has no room for one.
            const data = buildEditedVxlV3Data([leaf(0, 0, 0, MIN)], makeTemplate({ rig }), {
                voxelSize: MIN, physicsGridStep: 0.5, useAtlas: false,
            });
            expect((data.rig as unknown as { bones?: unknown }).bones).toBeUndefined();
            expect((data.rig as unknown as { lodBones?: unknown }).lodBones).toBeUndefined();
        });

        it('leaves a rig-free asset rig-free', () => {
            const data = buildEditedVxlV3Data([leaf(0, 0, 0, MIN)], makeTemplate(), {
                voxelSize: MIN, physicsGridStep: 0.5, useAtlas: false,
            });
            expect(data.rig).toBeUndefined();
        });

        it('keeps each coarse LOD cell on the joint it came from', () => {
            // Per-LOD bones exist for the same reason per-LOD slots do (v8): a column
            // written only at LOD 0 leaves a distant character animating from the root.
            // Two limbs of ONE colour meeting in a coarse cell is the ordinary case, so
            // pooling by material alone would hand the cell an arbitrary joint.
            const template = makeTemplate({
                rig,
                additionalLods: [{
                    minVoxelSize: 0.2, maxVoxelSize: 0.2,
                    fragments: [{ aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], leaves: LeafBuffer.fromArray([], 0.2, 0, 0, 0) }],
                }],
            });
            // Four same-coloured leaves in one 0.2 cell: three on joint 7, one on 3.
            const leaves: OctreeLeaf[] = [
                { ...leaf(0, 0, 0, MIN), bone: 7 },
                { ...leaf(0.1, 0, 0, MIN), bone: 7 },
                { ...leaf(0, 0.1, 0, MIN), bone: 7 },
                { ...leaf(0.1, 0.1, 0, MIN), bone: 3 },
            ];
            const data = buildEditedVxlV3Data(leaves, template, {
                voxelSize: MIN, physicsGridStep: 0.5, useAtlas: false,
            });
            const coarse = data.additionalLods![0]!.fragments[0]!.leaves;
            expect(coarse).toHaveLength(1);
            // The majority joint, carried rather than dropped to 0 (the root).
            expect(coarse[0]!.bone).toBe(7);
        });

        // The encode-level half of this invariant — that the payload really does come
        // back out of the encoder as v10 — lives in `VxlV3Rig.test.ts`, which runs under
        // the node environment. This file is jsdom, and jsdom has no global TextEncoder.
    });
});
