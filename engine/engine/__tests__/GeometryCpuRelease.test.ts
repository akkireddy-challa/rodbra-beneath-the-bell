/** @jest-environment jsdom */
import * as THREE from 'three';
import {
    releaseGeometryCpuBuffers,
    releaseMeshCpuBuffersAfterUpload,
    setGeometryReleaseSuspended,
    isGeometryReleaseSuspended,
} from 'engine/GeometryCpuRelease.js';

/** Indexed unit-quad geometry with position/normal/uv/color. */
function makeGeometry(): THREE.BufferGeometry {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    ]), 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(12).fill(0), 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(8), 2));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12), 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1));
    return geom;
}

/**
 * Invoke a mesh's onAfterRender the way both renderer backends do. Defaults to
 * the mesh's own material — i.e. a real pass rather than an override one.
 */
function fireAfterRender(
    mesh: THREE.Mesh, material: THREE.Material = mesh.material as THREE.Material,
): void {
    mesh.onAfterRender(
        {} as unknown as THREE.WebGLRenderer,
        {} as unknown as THREE.Scene,
        {} as unknown as THREE.Camera,
        mesh.geometry,
        material,
        {} as unknown as THREE.Group,
    );
}

/** CPU-side length of a named vertex attribute's typed array. */
const attrLen = (geom: THREE.BufferGeometry, name: string): number =>
    geom.getAttribute(name).array.length;

describe('releaseGeometryCpuBuffers', () => {
    test('full mode zero-swaps every vertex attribute, keeping counts and types', () => {
        const geom = makeGeometry();
        const posCount = geom.attributes.position!.count;
        releaseGeometryCpuBuffers(geom, 'full');

        for (const name of ['position', 'normal', 'uv', 'color']) {
            expect(attrLen(geom, name)).toBe(0);
        }
        expect(geom.attributes.position!.array).toBeInstanceOf(Float32Array);
        expect(geom.attributes.position!.count).toBe(posCount);
    });

    // Regression guard: a released index is re-uploaded as a 0-byte WebGPU
    // buffer as soon as the geometry is bound to a new mesh (level switch →
    // rebuilt instanced LOD meshes). The failing DrawIndexed invalidates the
    // whole command buffer, so Queue.submit() drops the ENTIRE frame and a
    // published multi-level game renders nothing at all.
    test('NEVER releases the index, in either mode', () => {
        for (const mode of ['full', 'keep-pickable'] as const) {
            const geom = makeGeometry();
            releaseGeometryCpuBuffers(geom, mode);
            expect(geom.index!.array.length).toBe(6);
            expect(geom.index!.count).toBe(6);
            expect(geom.index!.array).toBeInstanceOf(Uint32Array);
        }
    });

    test('keep-pickable keeps position so raycasting still works', () => {
        const geom = makeGeometry();
        releaseGeometryCpuBuffers(geom, 'keep-pickable');

        expect(attrLen(geom, 'position')).toBe(12);
        expect(attrLen(geom, 'normal')).toBe(0);
        expect(attrLen(geom, 'uv')).toBe(0);
        expect(attrLen(geom, 'color')).toBe(0);
    });

    test('precomputes bounds before touching position, in both modes', () => {
        for (const mode of ['full', 'keep-pickable'] as const) {
            const geom = makeGeometry();
            expect(geom.boundingBox).toBeNull();
            expect(geom.boundingSphere).toBeNull();
            releaseGeometryCpuBuffers(geom, mode);
            expect(geom.boundingBox!.min.x).toBe(0);
            expect(geom.boundingBox!.max.x).toBe(1);
            expect(Number.isFinite(geom.boundingSphere!.radius)).toBe(true);
            expect(geom.boundingSphere!.radius).toBeGreaterThan(0);
        }
    });

    test('leaves interleaved attributes alone', () => {
        const geom = makeGeometry();
        const buf = new THREE.InterleavedBuffer(new Float32Array(16), 4);
        geom.setAttribute('foo', new THREE.InterleavedBufferAttribute(buf, 3, 0) as unknown as THREE.BufferAttribute);
        releaseGeometryCpuBuffers(geom, 'full');
        expect(buf.array.length).toBe(16);
    });
});

describe('releaseMeshCpuBuffersAfterUpload', () => {
    test('releases on the first draw with the mesh\'s own material, then restores the callback', () => {
        const geom = makeGeometry();
        const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial());
        const original = mesh.onAfterRender;
        releaseMeshCpuBuffersAfterUpload(mesh, 'full');

        fireAfterRender(mesh);
        expect(attrLen(geom, 'position')).toBe(0);
        expect(mesh.onAfterRender).toBe(original);
    });

    test('ignores override-material passes (shadow depth)', () => {
        const geom = makeGeometry();
        const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial());
        releaseMeshCpuBuffersAfterUpload(mesh, 'full');

        fireAfterRender(mesh, new THREE.MeshDepthMaterial());
        expect(attrLen(geom, 'position')).toBe(12);

        fireAfterRender(mesh);
        expect(attrLen(geom, 'position')).toBe(0);
    });

    test('waits for an InstancedMesh to draw at least one instance', () => {
        const geom = makeGeometry();
        const mesh = new THREE.InstancedMesh(geom, new THREE.MeshLambertMaterial(), 4);
        mesh.count = 0;
        releaseMeshCpuBuffersAfterUpload(mesh, 'keep-pickable');

        fireAfterRender(mesh);
        expect(attrLen(geom, 'normal')).toBe(12);

        mesh.count = 2;
        fireAfterRender(mesh);
        expect(attrLen(geom, 'normal')).toBe(0);
        expect(attrLen(geom, 'position')).toBe(12);
    });

    test('multi-material meshes release only after the LAST group draws', () => {
        const geom = makeGeometry();
        const mats = [new THREE.MeshLambertMaterial(), new THREE.MeshLambertMaterial()];
        const mesh = new THREE.Mesh(geom, mats);
        releaseMeshCpuBuffersAfterUpload(mesh, 'full');

        fireAfterRender(mesh, mats[0]!);
        expect(attrLen(geom, 'position')).toBe(12);
        fireAfterRender(mesh, mats[1]!);
        expect(attrLen(geom, 'position')).toBe(0);
    });

    // Regression guard: a warmup renders the scene once into a throwaway target
    // with each mesh's OWN material, so it looks exactly like a real draw — but
    // it runs before the level's real passes exist and uploads less than they
    // consume. Releasing on it freed the terrain's `normal` before any
    // shadow-receiving pass had used it; `shadow.normalBias` then offset the
    // shadow lookup along a 0-byte buffer and the racing surface shadow-tested
    // against itself, rendering solid black on an otherwise correct level.
    test('does NOT release during a warmup draw', () => {
        const geom = makeGeometry();
        const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial());
        releaseMeshCpuBuffersAfterUpload(mesh, 'full');

        setGeometryReleaseSuspended(true);
        try {
            fireAfterRender(mesh);
            expect(attrLen(geom, 'normal')).toBe(12);
            expect(attrLen(geom, 'position')).toBe(12);
        } finally {
            setGeometryReleaseSuspended(false);
        }
    });

    test('stays armed through a warmup and releases on the first real frame', () => {
        // The one-shot must not be consumed by the suspended draw, or the
        // buffers would be retained forever and the memory win is lost.
        const geom = makeGeometry();
        const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial());
        releaseMeshCpuBuffersAfterUpload(mesh, 'full');

        setGeometryReleaseSuspended(true);
        fireAfterRender(mesh);               // warmup — ignored
        setGeometryReleaseSuspended(false);

        fireAfterRender(mesh);               // first genuine frame
        expect(attrLen(geom, 'normal')).toBe(0);
        expect(attrLen(geom, 'position')).toBe(0);
    });

    test('suspension is reported and restored', () => {
        expect(isGeometryReleaseSuspended()).toBe(false);
        setGeometryReleaseSuspended(true);
        expect(isGeometryReleaseSuspended()).toBe(true);
        setGeometryReleaseSuspended(false);
        expect(isGeometryReleaseSuspended()).toBe(false);
    });

    test('chains a pre-existing onAfterRender and keeps it after release', () => {
        const mesh = new THREE.Mesh(makeGeometry(), new THREE.MeshLambertMaterial());
        const calls: string[] = [];
        mesh.onAfterRender = () => { calls.push('user'); };
        releaseMeshCpuBuffersAfterUpload(mesh, 'full');

        fireAfterRender(mesh);   // releases; user callback ran first
        fireAfterRender(mesh);   // restored user callback runs alone
        expect(calls).toEqual(['user', 'user']);
    });
});

describe('a shadow-receiving mesh keeps its normal', () => {
    /**
     * REGRESSION (2026-08-06): every dungeon wall, floor and door surround
     * rendered uniformly BLACK — immune to lamps, to the ambient floor, even to
     * a forced red albedo. The clad shell is env LOD-INSTANCED, and those meshes
     * are created with `receiveShadow = true`. Releasing their `normal` left
     * `shadow.normalBias` offsetting the shadow lookup along a 0-byte buffer, so
     * every clad surface shadow-tested against itself. The module header records
     * the same failure on racing terrain; this is the general rule it implies.
     *
     * `position` is a red herring here: it is kept in 'keep-pickable' anyway, and
     * the symptom is shading, not geometry — the walls were always in the right
     * place, just never shaded.
     */
    test('keeps normal when the mesh receives shadows, in BOTH modes', () => {
        for (const mode of ['full', 'keep-pickable'] as const) {
            const mesh = new THREE.Mesh(makeGeometry(), new THREE.MeshLambertMaterial());
            mesh.receiveShadow = true;
            releaseMeshCpuBuffersAfterUpload(mesh, mode, true);
            fireAfterRender(mesh);
            expect(attrLen(mesh.geometry, 'normal')).toBe(12);
            // Everything else it does not shade with still goes.
            expect(attrLen(mesh.geometry, 'uv')).toBe(0);
            expect(attrLen(mesh.geometry, 'color')).toBe(0);
        }
    });

    test('still releases normal when the mesh does NOT receive shadows', () => {
        const mesh = new THREE.Mesh(makeGeometry(), new THREE.MeshLambertMaterial());
        mesh.receiveShadow = false;
        releaseMeshCpuBuffersAfterUpload(mesh, 'full', true);
        fireAfterRender(mesh);
        expect(attrLen(mesh.geometry, 'normal')).toBe(0);
    });

    test('keeps uv when the material samples a texture through it', () => {
        // The dungeon cladding colours itself from the voxel ATLAS via uv. A
        // released uv is a 0-byte buffer, so every vertex samples the SAME texel
        // and the surface renders lit but flat and colourless.
        const mat = new THREE.MeshLambertMaterial();
        mat.map = new THREE.Texture();
        const mesh = new THREE.Mesh(makeGeometry(), mat);
        releaseMeshCpuBuffersAfterUpload(mesh, 'full', true);
        fireAfterRender(mesh);
        expect(attrLen(mesh.geometry, 'uv')).toBe(8);
        expect(attrLen(mesh.geometry, 'color')).toBe(0);
    });

    test('keeps color when the material reads vertex colors', () => {
        const mesh = new THREE.Mesh(makeGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
        releaseMeshCpuBuffersAfterUpload(mesh, 'full', true);
        fireAfterRender(mesh);
        expect(attrLen(mesh.geometry, 'color')).toBe(12);
        expect(attrLen(mesh.geometry, 'uv')).toBe(0);
    });

    test('releases uv and color when the material consumes neither', () => {
        const mesh = new THREE.Mesh(makeGeometry(), new THREE.MeshLambertMaterial());
        releaseMeshCpuBuffersAfterUpload(mesh, 'full', true);
        fireAfterRender(mesh);
        expect(attrLen(mesh.geometry, 'uv')).toBe(0);
        expect(attrLen(mesh.geometry, 'color')).toBe(0);
    });

    test('a multi-material mesh keeps what ANY of its materials consumes', () => {
        const textured = new THREE.MeshLambertMaterial();
        textured.map = new THREE.Texture();
        const plain = new THREE.MeshLambertMaterial();
        const mesh = new THREE.Mesh(makeGeometry(), [plain, textured]);
        releaseMeshCpuBuffersAfterUpload(mesh, 'full', true);
        fireAfterRender(mesh, textured);
        expect(attrLen(mesh.geometry, 'uv')).toBe(8);
    });

    test('an InstancedMesh receiving shadows keeps normal too', () => {
        // The dungeon cladding is exactly this shape.
        const mesh = new THREE.InstancedMesh(makeGeometry(), new THREE.MeshLambertMaterial(), 4);
        mesh.receiveShadow = true;
        mesh.count = 4;
        releaseMeshCpuBuffersAfterUpload(mesh, 'keep-pickable', true);
        fireAfterRender(mesh);
        expect(attrLen(mesh.geometry, 'normal')).toBe(12);
    });

    test('WITHOUT the opt-in, everything still goes — terrain keeps the memory win', () => {
        // Terrain batches are the bulk of the heap this module reclaims and are
        // never re-bound after release, so they must stay on the full release.
        const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
        mat.map = new THREE.Texture();
        const mesh = new THREE.Mesh(makeGeometry(), mat);
        mesh.receiveShadow = true;
        releaseMeshCpuBuffersAfterUpload(mesh, 'full');
        fireAfterRender(mesh);
        expect(attrLen(mesh.geometry, 'normal')).toBe(0);
        expect(attrLen(mesh.geometry, 'uv')).toBe(0);
        expect(attrLen(mesh.geometry, 'color')).toBe(0);
    });
});
