import { buildOctreeMesh, buildOctreeMeshFromBuffers, LeafBuffer, type OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

/** Build a white leaf at the given min-corner + edge size. */
const leaf = (x: number, y: number, z: number, size: number): OctreeLeaf =>
    ({ x, y, z, size, r: 1, g: 1, b: 1 });

/** Number of quad faces in the returned mesh (6 indices per face). */
function faceCount(mesh: { geometry: { getIndex(): { count: number } | null } } | null): number {
    if (!mesh) return 0;
    const idx = mesh.geometry.getIndex();
    return idx ? idx.count / 6 : 0;
}

let zid = 0;
const nextZid = (): string => `face-cull-test-${zid++}`;

describe('octree hidden-face removal — buildOctreeMesh', () => {
    it('keeps all 6 faces of an isolated voxel', () => {
        const mesh = buildOctreeMesh([leaf(0, 0, 0, 1)], 0, 0, 0, false, nextZid());
        expect(faceCount(mesh)).toBe(6);
    });

    it('culls the shared face between two face-adjacent unit voxels', () => {
        const leaves = [leaf(0, 0, 0, 1), leaf(1, 0, 0, 1)];
        // 12 faces total minus the 2 faces that share the x=1 boundary = 10.
        expect(faceCount(buildOctreeMesh(leaves, 0, 0, 0, false, nextZid()))).toBe(10);
    });

    it('does NOT cull edge-adjacent (diagonal) voxels — no fully covered face', () => {
        const leaves = [leaf(0, 0, 0, 1), leaf(1, 1, 0, 1)];
        expect(faceCount(buildOctreeMesh(leaves, 0, 0, 0, false, nextZid()))).toBe(12);
    });

    it('keeps only the 24 surface faces of a solid 2x2x2 block of unit voxels', () => {
        const leaves: OctreeLeaf[] = [];
        for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
            leaves.push(leaf(x, y, z, 1));
        }
        // 8 voxels * 6 = 48 faces; only the 6*(2*2)=24 outer faces survive.
        expect(faceCount(buildOctreeMesh(leaves, 0, 0, 0, false, nextZid()))).toBe(24);
    });

    it('culls between two equal-size LOD-1 leaves (step derived from min leaf size)', () => {
        // Both size-2 leaves, adjacent along x. Cell step = 2, so they are unit cells (0,0,0)/(1,0,0).
        const leaves = [leaf(0, 0, 0, 2), leaf(2, 0, 0, 2)];
        expect(faceCount(buildOctreeMesh(leaves, 0, 0, 0, false, nextZid()))).toBe(10);
    });

    it('keeps a large leaf face only partially covered by a smaller neighbor', () => {
        // size-2 leaf occupies cells x,y,z in {0,1}; a unit voxel sits at cell (2,0,0).
        const leaves = [leaf(0, 0, 0, 2), leaf(2, 0, 0, 1)];
        // Big leaf: +X face spans 4 cells, only 1 occupied -> kept -> all 6 faces.
        // Unit voxel: -X neighbor cell (1,0,0) occupied -> culled -> 5 faces.
        expect(faceCount(buildOctreeMesh(leaves, 0, 0, 0, false, nextZid()))).toBe(11);
    });

    it('keeps all faces when leaves are off the shared lattice (no false-adjacency cull)', () => {
        // B sits at x=1.4 (size 1) — NOT on the step=1 lattice A defines. Snapping B to
        // cell 1 would make it look face-adjacent to A and wrongly cull the touching
        // faces, even though A=[0,1) and B=[1.4,2.4) don't actually touch. The lattice
        // guard must detect the off-grid leaf and keep every face: 2 × 6 = 12.
        const leaves = [leaf(0, 0, 0, 1), leaf(1.4, 0, 0, 1)];
        expect(faceCount(buildOctreeMesh(leaves, 0, 0, 0, false, nextZid()))).toBe(12);
    });
});

describe('octree hidden-face removal — buildOctreeMeshFromBuffers (building load path)', () => {
    it('culls interior faces of a solid 2x2x2 block, matching the object path', () => {
        const leaves: OctreeLeaf[] = [];
        for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
            leaves.push(leaf(x, y, z, 1));
        }
        const buf = LeafBuffer.fromArray(leaves, 1, 0, 0, 0);
        const mesh = buildOctreeMeshFromBuffers([buf], 0, 0, 0, false, nextZid());
        expect(faceCount(mesh)).toBe(24);
    });
});
