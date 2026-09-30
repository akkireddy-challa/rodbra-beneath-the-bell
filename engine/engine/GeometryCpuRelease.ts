import * as THREE from 'three';

/**
 * Post-upload release of CPU-side geometry buffers.
 *
 * Three.js retains every BufferAttribute's typed array in JS memory forever,
 * even though static geometry is never read back after the GPU upload — for a
 * baked city (terrain batches + per-LOD instanced asset geometry) that is
 * gigabytes of live heap, and V8's incremental-mark steps over a live set that
 * size show up as 25–31 ms frames in an otherwise idle scene.
 *
 * Why not the classic `BufferAttribute.onUpload(dispose)` idiom:
 *  - the WebGPU backend never fires `onUploadCallback` (commented out in
 *    r183's WebGPUBackend), and WebGPU is the default renderer;
 *  - onUpload fires per attribute *consumed by the current pass's pipeline* —
 *    a shadow-only pass uploads `position` alone, so it cannot stand in for
 *    "all buffers reached the GPU".
 *
 * The portable signal used here is `Object3D.onAfterRender` with the mesh's
 * OWN material: both backends upload every pipeline-consumed vertex buffer
 * before issuing the draw, and both fire onAfterRender for override passes
 * too (WebGPU shadow-map passes render the scene with a shadow override
 * material), hence the own-material guard. An InstancedMesh with `count` 0
 * can reach onAfterRender without a guaranteed upload (the WebGPU backend
 * bails out of the draw before touching buffers), hence the count guard.
 *
 * Attributes a material's pipeline never consumes (e.g. `color` on an
 * atlas-textured mesh) are never uploaded by anyone — releasing them is pure
 * win as long as the mesh's material set is fixed, which holds for all voxel
 * meshes (material chosen once at assembly).
 */

/**
 * THE INDEX IS NEVER RELEASED, in either mode. WebGPU re-creates a geometry's
 * index buffer whenever the backend has no live buffer for it — which happens
 * as soon as an already-released geometry is bound to a NEW mesh, e.g. when a
 * multi-level game switches level and `EnvironmentObjectSystem` rebuilds its
 * instanced LOD meshes. The re-upload then reads the zero-length array and
 * allocates a 0-byte index buffer, and the next `DrawIndexed(count)` fails
 * validation:
 *
 *   Index range (first: 0, count: 495462, format: Uint32) does not fit in
 *   index buffer size (0). While encoding [RenderPassEncoder].DrawIndexed(…)
 *
 * In WebGPU a validation error while encoding invalidates the WHOLE command
 * buffer, so `Queue.submit()` discards the entire frame — one released index
 * blanked every published multi-level game (terrain, vehicles and props all
 * vanished; only the DOM HUD kept updating). Indices are a small share of the
 * heap this module exists to reclaim, so keeping them costs little.
 *
 * What to release:
 *  - `full`: every vertex attribute (the index is kept — see above). THREE
 *    raycasting against the mesh silently misses afterwards — only for
 *    published/standalone games, where gameplay raycasts go through physics
 *    (same contract as the vwld terrain batches' post-warmup release).
 *  - `keep-pickable`: everything except `position`, so THREE.Raycaster picking
 *    still works (editor click-select, PlacementHelper,
 *    melee sweeps against damageable objects). `Mesh.raycast` interpolates
 *    `intersection.uv`/`intersection.normal` from those attributes when
 *    present — released ones yield NaN there, so consumers must use
 *    `intersection.face.normal` (recomputed from positions; exact for
 *    flat-shaded voxel meshes). PlacementHelper already does.
 */
export type CpuReleaseMode = 'full' | 'keep-pickable';

/**
 * Set while a WARMUP render is in flight (`GameEngine.warmUpScene`), which
 * suspends the after-upload release below.
 *
 * A warmup draws the scene once into a throwaway 4x4 target to force shader
 * compilation. It is a real draw with each mesh's own material, so it satisfies
 * the "has been drawn, therefore uploaded" signal — but it uploads only what
 * THAT pass's pipelines consume, and a warmup runs before the level's real
 * passes exist. Releasing on it frees attributes the real passes had not yet
 * uploaded.
 *
 * Measured: a level built by a switch (which since the per-level warmup landed
 * gets a warmup draw it never used to get) released the terrain's `normal`
 * before any shadow-receiving pass had consumed it. The lit pass survived —
 * `flatShading` reconstructs normals from derivatives — but `shadow.normalBias`
 * offsets the shadow lookup along the VERTEX normal, which was now a 0-byte
 * buffer, so the racing surface shadow-tested against itself and rendered
 * uniformly black while the terrain around it looked fine.
 *
 * A warmup is not the "real draw" this module waits for. Suspending keeps the
 * arming intact: the one-shot is not consumed, so the release still fires on
 * the first genuine frame — by which point every real pipeline, shadows
 * included, has uploaded what it needs.
 */
let releaseSuspended = false;

/**
 * Suspend/resume the after-upload release. Call around any render that is not
 * a genuine presented frame (warmup / shader precompile passes). Nesting is not
 * supported — the only caller is `GameEngine.warmUpScene`, which restores in a
 * `finally`.
 */
export function setGeometryReleaseSuspended(suspended: boolean): void {
    releaseSuspended = suspended;
}

/** Whether the after-upload release is currently suspended (test seam). */
export function isGeometryReleaseSuspended(): boolean {
    return releaseSuspended;
}

/**
 * Swap the attribute's array for a ZERO-LENGTH array of the same type (not
 * null), so metadata readers (BYTES_PER_ELEMENT, constructor checks) keep
 * working. `attribute.count` is a plain property assigned at construction and
 * intentionally keeps its original value — draw ranges and `position.count`
 * consumers stay correct.
 *
 * NOTE: a later re-upload from the empty view is NOT harmless — it allocates a
 * 0-byte GPU buffer. That is survivable for vertex attributes (the draw reads
 * garbage or nothing) but fatal for an index buffer under WebGPU, which is why
 * the index is never passed to this function. See the module header.
 */
export function releaseAttributeArray(attr: THREE.BufferAttribute): void {
    const Ctor = attr.array.constructor as new (n: number) => THREE.TypedArray;
    attr.array = new Ctor(0);
}

/**
 * Every sampler slot a mesh material can carry. Physical, not Standard: it has
 * every map Standard does plus the clearcoat/specular ones, so one list covers
 * the whole sampler surface. Any one of them consumes `uv`, and a released `uv`
 * breaks every one of them the same way.
 */
const SAMPLER_SLOTS = [
    'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
    'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'specularColorMap',
] as const;

/**
 * Attribute names a mesh's OWN shading reads, which therefore must survive the
 * release. The module only ever intended to drop what a material never
 * consumes; deriving that from the material is what makes it true.
 *
 *  normal  a shadow-RECEIVING mesh offsets its shadow lookup along the vertex
 *          normal (`shadow.normalBias`). Released, it shadow-tests against
 *          itself and renders uniformly black — immune to lights, to ambient
 *          and to its own albedo.
 *  uv      any sampled texture. Released, every vertex samples the SAME texel,
 *          so the surface renders lit but flat and colourless.
 *  color   `vertexColors`. Released, per-vertex colour is lost.
 *
 * Both failures blacked out / flattened every dungeon wall and floor at once:
 * the clad shell is env LOD-instanced, receives shadows, and takes its colour
 * from the voxel atlas through `uv`.
 */
export function attributesToKeep(mesh: THREE.Mesh): Set<string> {
    const keep = new Set<string>();
    if (mesh.receiveShadow === true) keep.add('normal');
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
        const m = material as THREE.MeshPhysicalMaterial | undefined;
        if (!m) continue;
        if (m.vertexColors === true) keep.add('color');
        if (SAMPLER_SLOTS.some((slot) => m[slot])) keep.add('uv');
    }
    return keep;
}

/**
 * Release the geometry's CPU-side buffers per `mode`, keeping every attribute in
 * `keep` (see `attributesToKeep`). Bounding box + sphere are computed first if
 * missing: frustum culling, `Mesh.raycast`'s early-out sphere test,
 * `InstancedMesh.computeBoundingSphere()` and the melee sweep's candidate gather
 * all lazily compute them from `position`, which would yield NaN bounds after
 * the release.
 *
 * Interleaved and instanced attributes are skipped: interleaved arrays are
 * shared across attributes, and instanced ones (per-instance data on custom
 * geometry) are re-read by the CPU every repack. `geom.index` is skipped in
 * BOTH modes — releasing it blanks every frame on WebGPU once the geometry is
 * re-bound (see the module header).
 */
export function releaseGeometryCpuBuffers(
    geom: THREE.BufferGeometry, mode: CpuReleaseMode, keep: ReadonlySet<string> = new Set(),
): void {
    if (geom.boundingBox === null) geom.computeBoundingBox();
    if (geom.boundingSphere === null) geom.computeBoundingSphere();

    for (const [name, attribute] of Object.entries(geom.attributes)) {
        if (mode === 'keep-pickable' && name === 'position') continue;
        if (keep.has(name)) continue;
        const attr = attribute as THREE.BufferAttribute & {
            isInterleavedBufferAttribute?: boolean;
            isInstancedBufferAttribute?: boolean;
        };
        if (attr.isInterleavedBufferAttribute || attr.isInstancedBufferAttribute) continue;
        releaseAttributeArray(attr);
    }
}

/**
 * Release `mesh.geometry`'s CPU buffers once the mesh has actually been drawn
 * with its own material — the earliest point at which every attribute its
 * real pipelines consume is guaranteed to be on the GPU (see module doc).
 * One-shot: the previous onAfterRender is chained and restored after the
 * release fires. Never fires for meshes that are never drawn (e.g. template
 * geometry kept only as a clone source), which leaves them untouched.
 *
 * `keepShadingAttributes` retains the attributes the mesh's own shading reads
 * (`attributesToKeep`). Pass it for geometry that gets RE-BOUND after release —
 * env LOD-instanced meshes are cloned, shared with the shadow-only mesh, and
 * rebuilt on level switches, and a re-upload from a released array allocates a
 * 0-BYTE GPU buffer (see `releaseAttributeArray`). Empty `normal` then makes the
 * surface shadow-test against itself and render uniformly BLACK; empty `uv`
 * makes every vertex sample one atlas texel, so it renders lit but colourless.
 * Both together blacked out every dungeon wall and floor. Terrain batches are
 * not re-bound this way and stay on the full release — they are the bulk of the
 * heap this module reclaims.
 */
export function releaseMeshCpuBuffersAfterUpload(
    mesh: THREE.Mesh, mode: CpuReleaseMode, keepShadingAttributes = false,
): void {
    const previous = mesh.onAfterRender;
    mesh.onAfterRender = function released(renderer, scene, camera, geometry, material, group): void {
        previous.call(mesh, renderer, scene, camera, geometry, material, group);
        // A warmup render is a real own-material draw but NOT a real frame: it
        // precedes the level's actual passes, so it has not uploaded what they
        // consume. Bail without consuming the one-shot — the release then fires
        // on the first genuine frame instead. See releaseSuspended's doc.
        if (releaseSuspended) return;
        // Override passes (shadow depth, velocity, outline) draw with a
        // material that is not the mesh's own and may upload only a subset of
        // the attributes — wait for a real pass. Multi-material meshes fire
        // once per group in order; wait for the last group so every group's
        // pipeline has consumed (uploaded) its attributes.
        const own = mesh.material;
        const isOwnMaterial = Array.isArray(own) ? own[own.length - 1] === material : own === material;
        if (!isOwnMaterial) return;
        const instanced = mesh as Partial<THREE.InstancedMesh>;
        if (instanced.isInstancedMesh === true && (instanced.count ?? 0) === 0) return;
        mesh.onAfterRender = previous;
        // Keep whatever this mesh's own shading reads, when the caller asks —
        // see `attributesToKeep` and `keepShadingAttributes`.
        releaseGeometryCpuBuffers(
            mesh.geometry, mode, keepShadingAttributes ? attributesToKeep(mesh) : new Set<string>(),
        );
    };
}
