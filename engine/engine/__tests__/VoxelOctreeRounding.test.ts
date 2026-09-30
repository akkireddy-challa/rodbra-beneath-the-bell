import { buildOctreeMesh, buildOctreeMeshFromBuffers, LeafBuffer, type OctreeLeaf, type OctreeMeshRounding } from 'engine/VoxelOctreeRenderer.js';

/** Build a white leaf at the given min-corner + edge size. */
const leaf = (x: number, y: number, z: number, size: number): OctreeLeaf =>
    ({ x, y, z, size, r: 1, g: 1, b: 1 });

const ROUNDING: OctreeMeshRounding = { radiusVoxels: 0.4, segments: 2 };

let zid = 0;
const nextZid = (): string => `rounding-test-${zid++}`;

interface MeshLike {
    geometry: {
        getIndex(): { count: number } | null;
        getAttribute(name: string): { count: number; array: ArrayLike<number>; itemSize: number } | undefined;
    };
}

function triangleCount(mesh: MeshLike | null): number {
    if (!mesh) return 0;
    const idx = mesh.geometry.getIndex();
    return idx ? idx.count / 3 : 0;
}

function positions(mesh: MeshLike): { x: number; y: number; z: number }[] {
    const attr = mesh.geometry.getAttribute('position')!;
    const out: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < attr.count; i++) {
        out.push({ x: attr.array[i * 3]!, y: attr.array[i * 3 + 1]!, z: attr.array[i * 3 + 2]! });
    }
    return out;
}

type Vec3 = { x: number; y: number; z: number };

/** Triangles whose three vertices all lie on the given y-plane inside [x0,x1]x[z0,z1]. */
function trianglesInPlaneRegion(
    mesh: MeshLike, axis: 'y', plane: number,
    x0: number, x1: number, z0: number, z1: number,
): [Vec3, Vec3, Vec3][] {
    void axis;
    const eps = 1e-6;
    const verts = positions(mesh);
    const idx = mesh.geometry.getIndex()!;
    const idxAttr = (idx as unknown as { array: ArrayLike<number> }).array;
    const out: [Vec3, Vec3, Vec3][] = [];
    for (let t = 0; t < idx.count / 3; t++) {
        const tri = [verts[idxAttr[t * 3]!]!, verts[idxAttr[t * 3 + 1]!]!, verts[idxAttr[t * 3 + 2]!]!] as [Vec3, Vec3, Vec3];
        const inRegion = tri.every(p =>
            Math.abs(p.y - plane) < eps &&
            p.x >= x0 - eps && p.x <= x1 + eps &&
            p.z >= z0 - eps && p.z <= z1 + eps);
        if (inRegion) out.push(tri);
    }
    return out;
}

function triangleAreaSum(tris: readonly [Vec3, Vec3, Vec3][]): number {
    let sum = 0;
    for (const [a, b, c] of tris) {
        const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
        const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
        const cx = aby * acz - abz * acy;
        const cy = abz * acx - abx * acz;
        const cz = abx * acy - aby * acx;
        sum += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
    }
    return sum;
}

describe('octree rounded-edge meshing', () => {
    it('emits rounded geometry for an isolated voxel (more than the 12 sharp triangles)', () => {
        const mesh = buildOctreeMesh([leaf(0, 0, 0, 1)], 0, 0, 0, false, nextZid(), ROUNDING);
        expect(triangleCount(mesh)).toBeGreaterThan(12);
        // Rounding carves into the cube — every vertex stays inside its bounds.
        const eps = 1e-6;
        for (const p of positions(mesh)) {
            expect(p.x).toBeGreaterThanOrEqual(-eps);
            expect(p.x).toBeLessThanOrEqual(1 + eps);
            expect(p.y).toBeGreaterThanOrEqual(-eps);
            expect(p.y).toBeLessThanOrEqual(1 + eps);
            expect(p.z).toBeGreaterThanOrEqual(-eps);
            expect(p.z).toBeLessThanOrEqual(1 + eps);
        }
    });

    it('rounds outer corners away: no vertex sits on two face planes at once', () => {
        const mesh = buildOctreeMesh([leaf(0, 0, 0, 1)], 0, 0, 0, false, nextZid(), ROUNDING);
        const eps = 1e-6;
        for (const p of positions(mesh!)) {
            const onX = Math.abs(p.x) < eps || Math.abs(p.x - 1) < eps;
            const onY = Math.abs(p.y) < eps || Math.abs(p.y - 1) < eps;
            const onZ = Math.abs(p.z) < eps || Math.abs(p.z - 1) < eps;
            expect((onX ? 1 : 0) + (onY ? 1 : 0) + (onZ ? 1 : 0)).toBeLessThanOrEqual(1);
        }
    });

    it('keeps the seam between two face-adjacent voxels flush (hidden faces are not rounded)', () => {
        // Voxels at [0,1) and [1,2) along X. Their shared faces at x=1 are hidden,
        // so the top-face edge along the seam must NOT be inset: both voxels keep
        // top-face vertices exactly at x=1, y=1 (a continuous flat top).
        const mesh = buildOctreeMesh([leaf(0, 0, 0, 1), leaf(1, 0, 0, 1)], 0, 0, 0, false, nextZid(), ROUNDING);
        const eps = 1e-6;
        const seamTop = positions(mesh!).filter(p => Math.abs(p.x - 1) < eps && Math.abs(p.y - 1) < eps);
        expect(seamTop.length).toBeGreaterThan(0);
    });

    it('emits nothing for a fully enclosed voxel (exposure comes from the occupancy mask)', () => {
        // 3x3x3 solid block: the center voxel is fully hidden. The rounded mesh
        // must contain no geometry inside the block interior — every vertex lies
        // on (or within rounding distance of) the outer shell.
        const leaves: OctreeLeaf[] = [];
        for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) {
            leaves.push(leaf(x, y, z, 1));
        }
        const mesh = buildOctreeMesh(leaves, 0, 0, 0, false, nextZid(), ROUNDING);
        // Interior of the block is [1,2]^3; a vertex strictly inside it (beyond
        // the rounding radius from every inner face) would mean hidden voxels
        // emitted geometry.
        const inner = positions(mesh!).filter(p =>
            p.x > 1.01 && p.x < 1.99 && p.y > 1.01 && p.y < 1.99 && p.z > 1.01 && p.z < 1.99);
        expect(inner.length).toBe(0);
        expect(triangleCount(mesh)).toBeGreaterThan(0);
    });

    it('falls back to sharp faces when leaves are off the shared lattice', () => {
        // Same off-lattice case as the face-culling suite: occupancy culling is
        // skipped, so rounding cannot run — expect the plain 2 × 12 = 24 sharp
        // triangles instead of a throw or missing mesh.
        const mesh = buildOctreeMesh([leaf(0, 0, 0, 1), leaf(1.4, 0, 0, 1)], 0, 0, 0, false, nextZid(), ROUNDING);
        expect(triangleCount(mesh)).toBe(24);
    });

    it('rounds via the LeafBuffer load path too', () => {
        const buf = LeafBuffer.fromArray([leaf(0, 0, 0, 1)], 1, 0, 0, 0);
        const mesh = buildOctreeMeshFromBuffers([buf], 0, 0, 0, false, nextZid(), false, ROUNDING);
        expect(triangleCount(mesh as MeshLike | null)).toBeGreaterThan(12);
    });

    it('greedy-merges the flat interior of a slab top into a single rect', () => {
        // 4x4x1 slab of unit voxels. The 2x2 interior leaves' top faces have no
        // rounded edges and no L-chords — pure flat interior. They must merge
        // into ONE rect ([1,3]x[1,3] at y=1): 2 triangles, total area 4.
        const leaves: OctreeLeaf[] = [];
        for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) leaves.push(leaf(x, 0, z, 1));
        const mesh = buildOctreeMesh(leaves, 0, 0, 0, false, nextZid(), ROUNDING);
        const interior = trianglesInPlaneRegion(mesh!, 'y', 1, 1, 3, 1, 3);
        expect(interior.length).toBe(2);
        expect(triangleAreaSum(interior)).toBeCloseTo(4, 6);
        // Bottom plane interior merges the same way (region y=0, normal -Y).
        const bottom = trianglesInPlaneRegion(mesh!, 'y', 0, 1, 3, 1, 3);
        expect(bottom.length).toBe(2);
        expect(triangleAreaSum(bottom)).toBeCloseTo(4, 6);
    });

    it('merges mixed-size coplanar faces — no T-junction vertices left inside the flat region', () => {
        // 6x6x2 floor: a size-2 leaf in the center, unit leaves (two layers)
        // everywhere else. All tops are coplanar at y=2. The plain interior
        // [1,5]x[1,5] mixes a size-2 face with unit faces — today each emits its
        // own polygon, leaving vertices (T-junctions) inside the region. After
        // the merge the interior must be one rect: no vertex strictly inside.
        const leaves: OctreeLeaf[] = [leaf(2, 0, 2, 2)];
        for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) {
            if (x >= 2 && x < 4 && z >= 2 && z < 4) continue;
            leaves.push(leaf(x, 0, z, 1), leaf(x, 1, z, 1));
        }
        const mesh = buildOctreeMesh(leaves, 0, 0, 0, false, nextZid(), ROUNDING);
        const eps = 1e-6;
        const insideVerts = positions(mesh!).filter(p =>
            Math.abs(p.y - 2) < eps &&
            p.x > 1 + 0.01 && p.x < 5 - 0.01 &&
            p.z > 1 + 0.01 && p.z < 5 - 0.01);
        expect(insideVerts.length).toBe(0);
        const interior = trianglesInPlaneRegion(mesh!, 'y', 2, 1, 5, 1, 5);
        expect(interior.length).toBe(2);
        expect(triangleAreaSum(interior)).toBeCloseTo(16, 6);
    });

    it('does not merge flat faces across different colors', () => {
        // Same 4x4x1 slab but the interior 2x2 is split into two colors — the
        // interior must NOT collapse to a single 2-triangle rect.
        const leaves: OctreeLeaf[] = [];
        for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
            const l = leaf(x, 0, z, 1);
            if (x >= 1 && x < 3 && z >= 1 && z < 3 && x === 1) { l.r = 0; l.g = 0; l.b = 0; }
            leaves.push(l);
        }
        const mesh = buildOctreeMesh(leaves, 0, 0, 0, false, nextZid(), ROUNDING);
        const interior = trianglesInPlaneRegion(mesh!, 'y', 1, 1, 3, 1, 3);
        expect(interior.length).toBe(4);
        expect(triangleAreaSum(interior)).toBeCloseTo(4, 6);
    });

    it('scales the rounding radius with the leaf lattice (LOD parity)', () => {
        // A size-2 leaf alone: step = 2, so radius = 0.4 × 2 = 0.8 world units.
        // Corner vertices must be inset by that amount — no vertex on two face
        // planes at once, same as the unit-voxel case.
        const mesh = buildOctreeMesh([leaf(0, 0, 0, 2)], 0, 0, 0, false, nextZid(), ROUNDING);
        const eps = 1e-6;
        for (const p of positions(mesh!)) {
            const onX = Math.abs(p.x) < eps || Math.abs(p.x - 2) < eps;
            const onY = Math.abs(p.y) < eps || Math.abs(p.y - 2) < eps;
            const onZ = Math.abs(p.z) < eps || Math.abs(p.z - 2) < eps;
            expect((onX ? 1 : 0) + (onY ? 1 : 0) + (onZ ? 1 : 0)).toBeLessThanOrEqual(1);
        }
    });
});
