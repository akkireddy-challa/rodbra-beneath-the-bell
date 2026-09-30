/** @jest-environment jsdom */
import * as THREE from 'three';
import { VxlSceneRenderer, pickLod } from 'engine/vxlscene/VxlSceneRenderer.js';
import { releaseDecodedColumns } from 'engine/VxlSceneTerrainSystem.js';
import type {
    DecodedVxlSceneWorld, DecodedChunk, DecodedChunkQuads, DecodedChunkVoxels,
} from 'engine/vxlscene/VxlSceneFormat.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';

/** White +Y quads (axis=1, dir=+1, w=h=1) at the given grid positions, all offset 0. */
function quads(positions: Array<[number, number, number]>): DecodedChunkQuads {
    const n = positions.length;
    const gx = new Uint16Array(n), gy = new Uint16Array(n), gz = new Uint16Array(n);
    const w = new Uint16Array(n).fill(1), h = new Uint16Array(n).fill(1);
    const axisDir = new Uint8Array(n).fill(1 & 0x3); // axis=1 (Y), dir=+1, offset=0
    const colorIdx = new Uint16Array(n); // all index 0 (white)
    const disp = new Int8Array(n);
    for (let i = 0; i < n; i++) { const p = positions[i]!; gx[i] = p[0]; gy[i] = p[1]; gz[i] = p[2]; }
    return { count: n, gx, gy, gz, w, h, axisDir, colorIdx, disp };
}

/** White +Y quads at the given (position, offset) pairs — offset packed into axisDir bits 3-5. */
function quadsWithOffsets(items: Array<{ pos: [number, number, number]; offset: number }>): DecodedChunkQuads {
    const n = items.length;
    const gx = new Uint16Array(n), gy = new Uint16Array(n), gz = new Uint16Array(n);
    const w = new Uint16Array(n).fill(1), h = new Uint16Array(n).fill(1);
    const axisDir = new Uint8Array(n);
    const colorIdx = new Uint16Array(n);
    const disp = new Int8Array(n);
    for (let i = 0; i < n; i++) {
        const it = items[i]!;
        gx[i] = it.pos[0]; gy[i] = it.pos[1]; gz[i] = it.pos[2];
        // axis=1 (Y), dir=+1 (bit2=0), offset in bits [5:3].
        axisDir[i] = (1 & 0x3) | ((it.offset & 0x7) << 3);
    }
    return { count: n, gx, gy, gz, w, h, axisDir, colorIdx, disp };
}

function emptyVoxels(): DecodedChunkVoxels {
    return {
        count: 0, gx: new Uint16Array(0), gy: new Uint16Array(0), gz: new Uint16Array(0),
        sizeLevel: new Uint8Array(0), colorIdx: new Uint16Array(0), flags: new Uint8Array(0), disp: null,
    };
}

/** One displaced voxel (flags bit1 set) at (gx,gy,gz), sizeLevel 0, shifted +Y by dy/127. */
function oneDisplacedVoxel(gx: number, gy: number, gz: number, dy: number): DecodedChunkVoxels {
    return {
        count: 1,
        gx: new Uint16Array([gx]), gy: new Uint16Array([gy]), gz: new Uint16Array([gz]),
        sizeLevel: new Uint8Array([0]), colorIdx: new Uint16Array([0]),
        flags: new Uint8Array([2]), // bit1 = displaced
        disp: new Int8Array([0, dy, 0]),
    };
}

function chunk(cx: number, cz: number, lodLevels = 1): DecodedChunk {
    const hints: DecodedChunkQuads[] = [];
    for (let l = 0; l < lodLevels; l++) hints.push(quads([[0, 0, 0]]));
    return { cx, cy: 0, cz, voxels: emptyVoxels(), lodHints: hints, namedTrimeshes: [] };
}

/** A chunk whose single LOD0 carries exactly the given (position, offset) quads. */
function offsetChunk(cx: number, cz: number, items: Array<{ pos: [number, number, number]; offset: number }>): DecodedChunk {
    return { cx, cy: 0, cz, voxels: emptyVoxels(), lodHints: [quadsWithOffsets(items)], namedTrimeshes: [] };
}

function world(chunks: DecodedChunk[], lodDistances = [50]): DecodedVxlSceneWorld {
    return {
        chunkSize: 16, minVoxelSize: 1,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 16, maxZ: 16 },
        lodDistances,
        chunks,
    };
}

/**
 * The per-bias-step BatchedMeshes under the renderer root, ascending polygonOffset (≈ step).
 * Excludes the smooth-surface batch (tagged name="smoothSurface").
 */
function batches(r: VxlSceneRenderer): THREE.BatchedMesh[] {
    return r.group.children
        .filter((c): c is THREE.BatchedMesh => {
            if ((c as THREE.BatchedMesh).isBatchedMesh !== true) return false;
            // Exclude the surface batch — it is tagged name="smoothSurface".
            return c.name !== 'smoothSurface';
        })
        .sort((a, b) =>
            (a.material as THREE.MeshLambertMaterial).polygonOffsetUnits
            - (b.material as THREE.MeshLambertMaterial).polygonOffsetUnits);
}

/**
 * Returns the dedicated smooth-surface BatchedMesh (the one tagged name="smoothSurface"),
 * or null when no surface batch exists.
 */
function surfaceBatch(r: VxlSceneRenderer): THREE.BatchedMesh | null {
    const found = r.group.children.find((c): c is THREE.BatchedMesh => {
        if ((c as THREE.BatchedMesh).isBatchedMesh !== true) return false;
        return c.name === 'smoothSurface';
    });
    return found ?? null;
}

/** Number of currently-visible instances in a batch. */
function visibleCount(b: THREE.BatchedMesh): number {
    let n = 0;
    for (let i = 0; i < b.instanceCount; i++) if (b.getVisibleAt(i)) n++;
    return n;
}

/** Total visible instances across every batch (≈ what the camera would draw, pre-cull). */
function totalVisible(r: VxlSceneRenderer): number {
    return batches(r).reduce((sum, b) => sum + visibleCount(b), 0);
}

describe('pickLod', () => {
    it('selects by distance bands, clamped to maxLod', () => {
        expect(pickLod(10, [50, 120], 2)).toBe(0);
        expect(pickLod(60, [50, 120], 2)).toBe(1);
        expect(pickLod(200, [50, 120], 2)).toBe(2);
        expect(pickLod(200, [50, 120], 1)).toBe(1); // clamp to available
    });
});

describe('VxlSceneRenderer batching (draw-call bound by bias steps, not chunk count)', () => {
    it('collapses many chunks of the same bias step into ONE BatchedMesh', () => {
        // Three separate chunks, each a single offset-0 quad at LOD0 → all bias step 0.
        // The whole terrain must be ONE batch (≈ one draw call), not three meshes.
        const r = new VxlSceneRenderer(world([
            offsetChunk(0, 0, [{ pos: [0, 0, 0], offset: 0 }]),
            offsetChunk(1, 0, [{ pos: [0, 0, 0], offset: 0 }]),
            offsetChunk(2, 0, [{ pos: [0, 0, 0], offset: 0 }]),
        ]));
        const bs = batches(r);
        expect(bs.length).toBe(1);            // one batch for 3 chunks
        expect(bs[0]!.instanceCount).toBe(3); // three instances inside it
        r.dispose();
    });

    it('puts distinct bias steps into distinct batches with rising polygonOffset', () => {
        // One chunk, LOD0 with an offset-1 and an offset-2 quad → steps 1 and 2.
        const r = new VxlSceneRenderer(world([offsetChunk(0, 0, [
            { pos: [0, 0, 0], offset: 1 },
            { pos: [2, 0, 0], offset: 2 },
        ])]));
        const bs = batches(r);
        expect(bs.length).toBe(2);
        const mats = bs.map(b => b.material as THREE.MeshLambertMaterial);
        for (const m of mats) expect(m.polygonOffset).toBe(true);
        // batches() is sorted ascending by polygonOffsetUnits → coarser step is larger.
        expect(mats[1]!.polygonOffsetUnits).toBeGreaterThan(mats[0]!.polygonOffsetUnits);
        expect(bs[0]!.instanceCount).toBe(1);
        expect(bs[1]!.instanceCount).toBe(1);
        r.dispose();
    });

    it('material count is bounded by distinct bias steps, not instance count', () => {
        const r = new VxlSceneRenderer(world([
            offsetChunk(0, 0, [{ pos: [0, 0, 0], offset: 1 }]),
            offsetChunk(1, 0, [{ pos: [0, 0, 0], offset: 1 }]),
            offsetChunk(2, 0, [{ pos: [0, 0, 0], offset: 1 }]),
        ]));
        const mats = new Set(batches(r).map(b => b.material as THREE.Material));
        expect(batches(r)[0]!.instanceCount).toBe(3); // 3 instances...
        expect(mats.size).toBe(1);                     // ...one material
        r.dispose();
    });
});

describe('VxlSceneRenderer LOD (per-instance visibility)', () => {
    it('shows exactly one LOD level per chunk and switches it by camera distance', () => {
        // One chunk, two LODs, both offset 0: LOD0 → bias step 0, LOD1 → bias step 1
        // (b = offset + lod), so the two levels land in DIFFERENT batches and a switch
        // is observable as visibility moving between batches.
        const r = new VxlSceneRenderer(world([chunk(0, 0, 2)], [50]));
        const [step0, step1] = batches(r); // sorted: step0 (offset off), step1 (offset on)

        // Initial build: LOD0 visible, LOD1 hidden.
        expect(visibleCount(step0!)).toBe(1);
        expect(visibleCount(step1!)).toBe(1 - 1); // 0
        expect(totalVisible(r)).toBe(1);

        // Far: switch to LOD1.
        r.updateLod(new THREE.Vector3(1000, 1000, 1000));
        expect(visibleCount(step0!)).toBe(0);
        expect(visibleCount(step1!)).toBe(1);
        expect(totalVisible(r)).toBe(1); // still exactly one level

        // Back near: switch to LOD0.
        r.updateLod(new THREE.Vector3(8, 8, 8));
        expect(visibleCount(step0!)).toBe(1);
        expect(visibleCount(step1!)).toBe(0);
        r.dispose();
    });
});

describe('VxlSceneRenderer render region', () => {
    // Two chunks of the same bias step (one batch): chunk 0 spans x 0..16, chunk 2 spans x 32..48.
    const keepChunk0 = new THREE.Box3(new THREE.Vector3(-4, -100, -4), new THREE.Vector3(12, 100, 12));

    it('draws only the chunks that touch the region, and every chunk again once it is cleared', () => {
        const r = new VxlSceneRenderer(world([chunk(0, 0), chunk(2, 0)]));
        expect(totalVisible(r)).toBe(2);

        r.setRenderRegion(keepChunk0);
        r.updateLod(new THREE.Vector3(8, 8, 8));
        expect(totalVisible(r)).toBe(1);

        r.setRenderRegion(null);
        r.updateLod(new THREE.Vector3(8, 8, 8));
        expect(totalVisible(r)).toBe(2);
        r.dispose();
    });

    it('keeps an excluded chunk hidden through a LOD switch', () => {
        // Two LODs each, so moving the camera away would normally re-show chunk 2 at LOD1.
        const r = new VxlSceneRenderer(world([chunk(0, 0, 2), chunk(2, 0, 2)], [50]));
        r.setRenderRegion(keepChunk0);
        r.updateLod(new THREE.Vector3(8, 8, 8));
        expect(totalVisible(r)).toBe(1);

        r.updateLod(new THREE.Vector3(1000, 1000, 1000));
        expect(totalVisible(r)).toBe(1);
        r.updateLod(new THREE.Vector3(40, 8, 8));
        expect(totalVisible(r)).toBe(1);
        r.dispose();
    });
});

describe('VxlSceneRenderer backfill (effective-step skip substitution)', () => {
    it('an offset group with an EMPTY fine level renders its coarser instance at near LOD', () => {
        // Level 0 has only the offset-2 quad (the offset-0 group was shed by
        // applyEffectiveStepSkip); level 1 still has both. Near camera (LOD 0) the
        // offset-0 group must render via its level-1 instance — not disappear.
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: emptyVoxels(),
            lodHints: [
                quadsWithOffsets([{ pos: [2, 0, 0], offset: 2 }]),
                quadsWithOffsets([{ pos: [0, 0, 0], offset: 0 }, { pos: [2, 0, 0], offset: 2 }]),
            ],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c], [50]));
        // Initial LOD is 0: the offset-2 level-0 instance AND the backfilled offset-0
        // level-1 instance are both visible — 2 visible instances, nothing missing.
        expect(totalVisible(r)).toBe(2);

        // Far → LOD 1: both groups' level-1 instances visible (the backfilled one is
        // SHARED between the levels, so it stays visible through the switch).
        r.updateLod(new THREE.Vector3(1000, 0, 0));
        expect(totalVisible(r)).toBe(2);

        // Near again → LOD 0: back to the substituted pair.
        r.updateLod(new THREE.Vector3(0, 0, 0));
        expect(totalVisible(r)).toBe(2);
        r.dispose();
    });

    it('backfill shares the instance — no extra instances or geometry are created', () => {
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: emptyVoxels(),
            lodHints: [
                quadsWithOffsets([]),                              // fine level fully shed
                quadsWithOffsets([{ pos: [0, 0, 0], offset: 0 }]), // coarsest keeps the group
            ],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c], [50]));
        // One offset group, one surviving level → exactly ONE instance overall.
        const bs = batches(r);
        expect(bs.reduce((s, b) => s + b.instanceCount, 0)).toBe(1);
        expect(totalVisible(r)).toBe(1); // and it is visible at the initial LOD
        r.dispose();
    });
});

/**
 * Fire a batch's onAfterRender the way both backends do for a real (own-material)
 * pass — the signal releaseCpuGeometry arms against.
 */
function drawOnce(mesh: THREE.Mesh): void {
    mesh.onAfterRender(
        {} as unknown as THREE.WebGLRenderer,
        {} as unknown as THREE.Scene,
        {} as unknown as THREE.Camera,
        mesh.geometry,
        mesh.material as THREE.Material,
        {} as unknown as THREE.Group,
    );
}

describe('VxlSceneRenderer.releaseCpuGeometry', () => {
    it('empties every batch attribute but KEEPS the index, keeping types and instances', () => {
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: oneDisplacedVoxel(4, 0, 0, 64), // also creates the surface batch
            lodHints: [quadsWithOffsets([{ pos: [0, 0, 0], offset: 0 }, { pos: [2, 0, 0], offset: 1 }])],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c]));
        const all = [...batches(r), surfaceBatch(r)!];
        for (const b of all) {
            expect((b.geometry.getAttribute('position') as THREE.BufferAttribute).array.length).toBeGreaterThan(0);
        }

        r.releaseCpuGeometry();
        // Arming alone must NOT free anything — a level switch arms before the
        // new batches have ever drawn, and releasing there uploads 0-byte
        // buffers and blanks the level.
        for (const b of all) {
            expect((b.geometry.getAttribute('position') as THREE.BufferAttribute).array.length).toBeGreaterThan(0);
        }
        for (const b of all) drawOnce(b);

        for (const b of all) {
            for (const name of Object.keys(b.geometry.attributes)) {
                const attr = b.geometry.getAttribute(name) as THREE.BufferAttribute;
                expect(attr.array.length).toBe(0);
            }
            // The index survives 'full': re-uploading a released one gives a
            // 0-byte WebGPU index buffer, and the failed DrawIndexed drops the
            // entire frame (see GeometryCpuRelease's header).
            const index = b.geometry.index;
            if (index) {
                expect(index.array.length).toBeGreaterThan(0);
                expect(index.array.BYTES_PER_ELEMENT).toBeGreaterThan(0); // type retained
            }
        }
        // Visibility bookkeeping still works after the release (instance data is
        // texture-backed, not attribute-backed).
        expect(totalVisible(r)).toBeGreaterThan(0);
        r.updateLod(new THREE.Vector3(1000, 0, 0));
        r.dispose();
    });

    it('keep-pickable mode keeps position + index for editor raycasts, drops the rest', () => {
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: oneDisplacedVoxel(4, 0, 0, 64),
            lodHints: [quadsWithOffsets([{ pos: [0, 0, 0], offset: 0 }, { pos: [2, 0, 0], offset: 1 }])],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c]));
        const all = [...batches(r), surfaceBatch(r)!];

        r.releaseCpuGeometry('keep-pickable');
        for (const b of all) drawOnce(b);

        for (const b of all) {
            const position = b.geometry.getAttribute('position') as THREE.BufferAttribute;
            expect(position.array.length).toBeGreaterThan(0);
            expect(b.geometry.index!.array.length).toBeGreaterThan(0);
            for (const name of Object.keys(b.geometry.attributes)) {
                if (name === 'position') continue;
                expect((b.geometry.getAttribute(name) as THREE.BufferAttribute).array.length).toBe(0);
            }
        }
        r.dispose();
    });
});

describe('VxlSceneRenderer smooth surface batch', () => {
    it('creates a surface batch instance for a chunk with a displaced voxel', () => {
        // A chunk with one displaced voxel (flags bit1 set, disp Y non-zero) produces
        // exactly one instance in the surface batch — the smooth movement surface.
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: oneDisplacedVoxel(4, 0, 0, 64),
            lodHints: [quads([]), quads([])], // empty LOD quads (no step batches)
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c]));
        const sb = surfaceBatch(r);
        expect(sb).not.toBeNull();
        expect(sb!.instanceCount).toBe(1);
        // flatShading FALSE so the surface is lit smoothly by its analytic per-vertex normals
        // (the welded heightfield's real gradient); identified by name. No polygon offset.
        expect((sb!.material as THREE.MeshLambertMaterial).flatShading).toBe(false);
        expect((sb!.material as THREE.MeshLambertMaterial).polygonOffset).toBe(false);

        // Surface instances are always visible — never LOD-toggled even at extreme distance.
        r.updateLod(new THREE.Vector3(0, 0, 100000));
        expect(visibleCount(sb!)).toBe(1);
        r.dispose();
    });

    it('produces NO surface batch when no voxel is displaced', () => {
        // Plain single-offset chunk with no displaced voxels: no surface batch at all.
        const r = new VxlSceneRenderer(world([chunk(0, 0)]));
        expect(surfaceBatch(r)).toBeNull();
        // The step batch is still present.
        const bs = batches(r);
        expect(bs.length).toBe(1);
        expect(bs[0]!.instanceCount).toBe(1);
        r.dispose();
    });
});

describe('VxlSceneRenderer smooth surface batch — extended coverage', () => {
    it('two chunks each with displaced voxels → ONE surface batch with TWO instances', () => {
        // Each chunk contributes one instance to the shared surfaceBatch — all smooth
        // surfaces live in that single batch regardless of how many chunks have them.
        const c0: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: oneDisplacedVoxel(0, 0, 0, 64),
            lodHints: [quads([])],
            namedTrimeshes: [],
        };
        const c1: DecodedChunk = {
            cx: 1, cy: 0, cz: 0,
            voxels: oneDisplacedVoxel(0, 0, 0, 32),
            lodHints: [quads([])],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c0, c1]));
        const sb = surfaceBatch(r);
        expect(sb).not.toBeNull();
        expect(sb!.instanceCount).toBe(2); // one per chunk-with-surface
        r.dispose();
    });

    it('smooth surface batch is flatShading:false (smooth normals); step batches stay flatShading:true', () => {
        // The smooth surface uses its analytic per-vertex normals (flatShading:false) so it lights
        // smoothly by gradient; the blocky step batches keep flatShading:true for per-voxel-face
        // faceting. The surface batch is identified by its name ("smoothSurface").
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: oneDisplacedVoxel(4, 0, 0, 64),
            // Include a non-empty LOD quad so at least one step batch also exists.
            lodHints: [quads([[0, 0, 0]])],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c]));
        const sb = surfaceBatch(r);
        expect(sb).not.toBeNull();
        expect((sb!.material as THREE.MeshLambertMaterial).flatShading).toBe(false);
        for (const b of batches(r)) {
            expect((b.material as THREE.MeshLambertMaterial).flatShading).toBe(true);
        }
        r.dispose();
    });

    it('dispose() removes the surface batch from the group and disposes its material', () => {
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: oneDisplacedVoxel(4, 0, 0, 64),
            lodHints: [quads([])],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c]));
        const sb = surfaceBatch(r);
        expect(sb).not.toBeNull();
        const mat = sb!.material as THREE.MeshLambertMaterial;
        const matDisposeSpy = jest.spyOn(mat, 'dispose');

        r.dispose();

        expect(matDisposeSpy).toHaveBeenCalledTimes(1);
        // After dispose the group must not contain any surface batch.
        expect(surfaceBatch(r)).toBeNull();
        expect(r.group.children.length).toBe(0);
    });
});

describe('VxlSceneRenderer atlas texture (one shared atlas texture, genre fast path)', () => {
    it('every batch material samples the shared atlas texture (map set, no vertex colors)', () => {
        const r = new VxlSceneRenderer(world([
            offsetChunk(0, 0, [{ pos: [0, 0, 0], offset: 0 }]),
            offsetChunk(1, 0, [{ pos: [0, 0, 0], offset: 1 }]),
        ]));
        for (const b of batches(r)) {
            const mat = b.material as THREE.MeshLambertMaterial;
            expect(mat.map).toBeTruthy();
            expect(mat.vertexColors).toBe(false);
        }
        r.dispose();
    });

    it('the atlas texture object is identical across ALL bias-step batches (ONE texture)', () => {
        const r = new VxlSceneRenderer(world([
            offsetChunk(0, 0, [
                { pos: [0, 0, 0], offset: 0 },
                { pos: [2, 0, 0], offset: 1 },
                { pos: [4, 0, 0], offset: 2 },
            ]),
            offsetChunk(1, 0, [{ pos: [0, 0, 0], offset: 3 }]),
        ]));
        const bs = batches(r);
        const maps = new Set<THREE.Texture>();
        const mats = new Set<THREE.Material>();
        for (const b of bs) {
            const mat = b.material as THREE.MeshLambertMaterial;
            mats.add(mat);
            expect(mat.map).not.toBeNull();
            maps.add(mat.map!);
        }
        expect(mats.size).toBeGreaterThan(1);  // several distinct bias-step materials
        expect(maps.size).toBe(1);             // but exactly one shared atlas texture
        expect([...maps][0]).toBe(getVoxelTextureAtlas().getTexture());
        r.dispose();
    });

    it('step 0 has polygonOffset off; higher steps on and rising', () => {
        const r = new VxlSceneRenderer(world([offsetChunk(0, 0, [
            { pos: [0, 0, 0], offset: 0 },
            { pos: [2, 0, 0], offset: 1 },
            { pos: [4, 0, 0], offset: 2 },
        ])]));
        const mats = batches(r).map(b => b.material as THREE.MeshLambertMaterial); // ascending units
        expect(mats[0]!.polygonOffset).toBe(false);                 // step 0
        expect(mats[1]!.polygonOffset).toBe(true);
        expect(mats[2]!.polygonOffset).toBe(true);
        expect(mats[2]!.polygonOffsetUnits).toBeGreaterThan(mats[1]!.polygonOffsetUnits);
        r.dispose();
    });
});

describe('VxlSceneRenderer disposal', () => {
    it('dispose() disposes every batch and every cached material, and empties the group', () => {
        const r = new VxlSceneRenderer(world([offsetChunk(0, 0, [
            { pos: [0, 0, 0], offset: 1 },
            { pos: [2, 0, 0], offset: 2 },
        ])]));
        const bs = batches(r);
        const batchSpies = bs.map(b => jest.spyOn(b, 'dispose'));
        const matSpies = bs.map(b => jest.spyOn(b.material as THREE.MeshLambertMaterial, 'dispose'));

        r.dispose();

        for (const s of batchSpies) expect(s).toHaveBeenCalledTimes(1);
        for (const s of matSpies) expect(s).toHaveBeenCalledTimes(1);
        expect(r.group.children.length).toBe(0);

        // Cache cleared → a fresh renderer builds NEW material instances.
        const before = bs.map(b => b.material as THREE.Material);
        const r2 = new VxlSceneRenderer(world([offsetChunk(0, 0, [{ pos: [0, 0, 0], offset: 1 }])]));
        const after = batches(r2)[0]!.material as THREE.Material;
        expect(before.includes(after)).toBe(false);
        r2.dispose();
    });

    it('setChunkHints rebuilds the affected chunk, preserving shared materials', () => {
        // Two chunks share the offset-1 (step 1) material. Rebuilding chunk 0's hints must
        // NOT dispose that material (chunk 1 still uses it), and must reflect the new hints.
        const r = new VxlSceneRenderer(world([
            offsetChunk(0, 0, [{ pos: [0, 0, 0], offset: 1 }]),
            offsetChunk(1, 0, [{ pos: [0, 0, 0], offset: 1 }]),
        ]));
        const sharedMat = batches(r)[0]!.material as THREE.MeshLambertMaterial;
        const disposeSpy = jest.spyOn(sharedMat, 'dispose');

        // Rebuild chunk 0 with TWO offset-1 quads (step 1 grows).
        r.setChunkHints(0, 0, 0, [quadsWithOffsets([
            { pos: [0, 0, 0], offset: 1 },
            { pos: [1, 0, 0], offset: 1 },
        ])]);

        expect(disposeSpy).not.toHaveBeenCalled();                 // shared material survived
        const after = batches(r);
        expect(after.length).toBe(1);                              // still one step-1 batch
        expect(after[0]!.material).toBe(sharedMat);                // ...the same cached instance
        expect(after[0]!.instanceCount).toBe(2);                   // chunk0 (2 quads) + chunk1 (1 quad)
        // chunk0 now 2 quads, chunk1 1 quad → 3 quads × 4 verts; the batch buffer is
        // sized exactly to that capacity (proves the rebuild used the new hints).
        expect((after[0]!.geometry.getAttribute('position') as THREE.BufferAttribute).count).toBe(12);
        r.dispose();
    });
});

describe('releaseDecodedColumns (post-load memory reclaim)', () => {
    /** A chunk with mixed face directions across two LOD levels. */
    function mixedChunk(cx: number, cz: number): DecodedChunk {
        const mk = (axisDirs: number[]): DecodedChunkQuads => {
            const n = axisDirs.length;
            const q = quads(Array.from({ length: n }, () => [0, 0, 0] as [number, number, number]));
            q.axisDir = new Uint8Array(axisDirs);
            return q;
        };
        // axis bits [1:0], dir bit 2. 1 = +Y (up-facing), 5 = -Y, 0 = +X, 2 = +Z.
        return {
            cx, cy: 0, cz,
            voxels: oneDisplacedVoxel(0, 0, 0, 10),
            lodHints: [mk([1, 5, 0, 2, 1]), mk([1, 0])],
            namedTrimeshes: [],
            surfaceTile: {
                count: 1,
                localGx: new Uint16Array([0]), localGz: new Uint16Array([0]),
                gy: new Uint16Array([0]), dy: new Int8Array([0]), colorIdx: new Uint16Array([0]),
            },
        };
    }

    function mixedWorld(): DecodedVxlSceneWorld {
        return {
            chunkSize: 4, minVoxelSize: 1, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 8, maxY: 4, maxZ: 4 },
            lodDistances: [50, 1e9], chunks: [mixedChunk(0, 0), mixedChunk(1, 0)],
        };
    }

    it('frees every quad, voxel and surface tile when nothing needs them', () => {
        const world = mixedWorld();
        const freed = releaseDecodedColumns(world, false);
        expect(freed).toBe(14); // (5 + 2) per chunk, both chunks
        for (const c of world.chunks) {
            expect(c.lodHints).toEqual([]);
            expect(c.voxels.count).toBe(0);
            expect(c.surfaceTile).toBeNull();
        }
    });

    it('keeps exactly the up-facing finest-kept quads for ground detail', () => {
        const world = mixedWorld();
        const freed = releaseDecodedColumns(world, true);
        // Per chunk, level 0 holds two +Y quads; everything else goes.
        expect(freed).toBe(10);
        for (const c of world.chunks) {
            expect(c.lodHints).toHaveLength(1);
            expect(c.lodHints[0]!.count).toBe(2);
            for (let i = 0; i < c.lodHints[0]!.count; i++) {
                const axisDir = c.lodHints[0]!.axisDir[i]!;
                expect(axisDir & 0x3).toBe(1);        // axis Y
                expect((axisDir >> 2) & 1).toBe(0);   // +dir
            }
            // The heavy columns still go, ground detail or not.
            expect(c.voxels.count).toBe(0);
            expect(c.surfaceTile).toBeNull();
        }
    });

    it('leaves the chunk list and world metadata intact — later reads depend on them', () => {
        const world = mixedWorld();
        releaseDecodedColumns(world, false);
        expect(world.chunks).toHaveLength(2);
        expect(world.chunks.map(c => [c.cx, c.cy, c.cz])).toEqual([[0, 0, 0], [1, 0, 0]]);
        expect(world.bounds.maxX).toBe(8);
        expect(world.chunkSize).toBe(4);
        expect(world.lodDistances).toEqual([50, 1e9]);
    });

    it('drops a chunk with no up-facing quads to no levels at all', () => {
        const world = mixedWorld();
        const q = quads([[0, 0, 0]]);
        q.axisDir = new Uint8Array([5]); // -Y only
        world.chunks[0]!.lodHints = [q];
        releaseDecodedColumns(world, true);
        expect(world.chunks[0]!.lodHints).toEqual([]);
    });
});

describe('VxlSceneRenderer.setChunkHints after the columns are released', () => {
    it('throws a message naming the opt-in instead of rebuilding an empty world', () => {
        const world: DecodedVxlSceneWorld = {
            chunkSize: 4, minVoxelSize: 1, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 4, maxZ: 4 },
            lodDistances: [1e9], chunks: [chunk(0, 0)],
        };
        const r = new VxlSceneRenderer(world);
        // Before the release it still works.
        expect(() => r.setChunkHints(0, 0, 0, [quads([[1, 0, 1]])])).not.toThrow();

        r.markDecodedColumnsReleased();
        expect(() => r.setChunkHints(0, 0, 0, [quads([[1, 0, 1]])]))
            .toThrow(/keepDecodedColumns/);
    });
});
