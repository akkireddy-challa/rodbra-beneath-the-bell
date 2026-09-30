/**
 * Runtime renderer core for baked GLB-scene voxel worlds (design §5).
 *
 * Turns a decoded SoA VxlScene world into a SMALL set of THREE.BatchedMesh objects —
 * ONE per depth-bias step `b = offset + LOD` (times the world's material classes, see
 * below) — instead of one Mesh per chunk. Each chunk's per-LOD, per-offset sub-geometry
 * is added to the batch for its step as a single instance with an identity matrix
 * (geometry already bakes the world origin). The whole terrain therefore draws in
 * ~(distinct bias steps) draw calls via the batch's multi-draw — NOT the thousands a
 * per-chunk-mesh scene costs. Terrain is draw-call-bound; a shared atlas material alone
 * does not batch draws, a BatchedMesh does.
 *
 * Distance LOD is per-instance visibility: each frame every chunk picks one LOD by
 * camera distance and toggles its instances (across the bias-step batches) on/off.
 * BatchedMesh frustum-culls the visible instances per-object, so off-screen chunks
 * still cost nothing. Smooth surfaces are rendered via separate dedicated batches
 * (surfaceBatches) using a SMOOTH (flatShading:false) atlas material so the welded mesh's
 * analytic per-vertex normals light it by its real gradient (the step batches stay
 * flatShading:true for crisp per-voxel-face faceting); these are always-visible and never
 * LOD-toggled.
 *
 * The z-fight fix is unchanged from the per-mesh design: each bias step is its own batch
 * with its own `polygonOffset` material (a depth-test bias that pushes coarser/farther
 * near-coplanar surfaces back without moving geometry, so no gaps open). Every batch
 * material samples the ONE shared atlas texture (the genre fast path).
 *
 * EMISSIVE (v7 worlds): when the decoded world carries an `emissiveByCell` LUT, EVERY
 * sub-geometry added to ANY batch gets a per-vertex `emissive` float attribute (BatchedMesh
 * demands one attribute layout across a batch's geometries — zeros where nothing glows) and
 * the shared materials become the dual-backend emissive variant. Only the NEAR-CAMERA
 * representation glows: each offset group's finest KEPT level (which is the level backfilled
 * into the finer ones, and is not necessarily LOD0 — a mobile `applyEffectiveStepSkip` budget
 * sheds whole LOD0 groups), with every coarser level's attribute ZEROED. Since a bias step
 * mixes LOD levels under one material, that can only be an attribute decision, not a material
 * one. Worlds without the LUT (all pre-v7 bakes) build exactly as before: no attribute, plain
 * materials, no per-vertex cost.
 *
 * MATERIAL CLASSES (v9 worlds): a class selects a different three material TYPE
 * (`VxlSceneEmissiveMaterial.ts` — Phong for stone/wood, Physical for metal/glass), so
 * unlike emissive it cannot be a vertex attribute. The batch key therefore widens from
 * `b` to `(b, classIdx)` — packed as `b * CLASS_STRIDE + classIdx` — and each chunk's
 * quads partition by the class of their colour cell (`materialClassByCell`). The class
 * BUDGET (`classByColor.ts`, 3 non-matte classes) is what keeps this bounded: at most
 * 4x the batches of an unclassified world, each still one multi-draw. The smooth surface
 * splits the same way, one batch per class actually present. A world without the LUT —
 * or a load at material quality 'low' — takes classIdx 0 everywhere and builds exactly
 * the batches it always did.
 *
 * NOTE: physics colliders + engine wiring are handled in a separate phase — this module
 * only builds and toggles the render instances.
 */

import * as THREE from 'three';
import type {
    DecodedVxlSceneWorld, DecodedChunkQuads,
} from 'engine/vxlscene/VxlSceneFormat.js';
import { buildHintMeshSoA, type HintMeshCtx } from 'engine/vxlscene/buildHintMesh.js';
import {
    buildSurfaceField, measureChunkSurface, measureChunkSurfaceByClass,
    buildChunkSurfaceGeometry, buildChunkSurfaceGeometryForClass, type SurfaceGeometryData,
} from 'engine/vxlscene/SurfaceMeshBuilder.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { atlasCellRepr, ATLAS_CELL_COUNT } from 'engine/vxlscene/atlasColor.js';
import { releaseMeshCpuBuffersAfterUpload, type CpuReleaseMode } from 'engine/GeometryCpuRelease.js';
import {
    deriveEmissiveAttribute, deriveEmissiveFromUv, buildCellByPaletteUv,
} from 'engine/vxlscene/emissiveAttribute.js';
import { createVxlSceneBatchMaterial } from 'engine/vxlscene/VxlSceneEmissiveMaterial.js';
import { DEFAULT_MATERIAL_QUALITY, materialQualityPolicy, type MaterialQuality } from 'engine/MaterialQuality.js';

/**
 * z-fight depth-bias per coarseness step (offset+LOD). Positive pushes coarser/farther-LOD
 * surfaces back so finer ones win; tune up if z-fighting remains, down if coarse surfaces
 * wrongly hide finer ones. Geometry is NOT moved, so this never creates gaps.
 */
const POLY_OFFSET_STEP = 1;

/**
 * Batch-key stride for the material-class dimension: `key = b * CLASS_STRIDE + classIdx`.
 * 8 leaves room over the 3-class budget; a foreign file carrying more classes than fit
 * has the excess clamped to matte at construction (see the constructor), so the packing
 * can never collide two (b, class) pairs.
 */
const CLASS_STRIDE = 8;

/** Renderer tuning knobs the decoded world doesn't carry. */
export interface VxlSceneRendererOptions {
    /**
     * Decimation step (in min-cells) for the smooth movement-surface mesh. 1 = full
     * resolution; 2 quarters the surface cell count, etc. Chosen by the load guard for
     * surface-heavy worlds. Applied once at load (no per-frame surface LOD).
     */
    surfaceStep: number;
    /**
     * The material-quality tier this load resolved to (`resolveMaterialQuality` at the
     * construction site — `VxlSceneTerrainSystem`). Decides how a v9 world's classes
     * shade and, at 'low', disables the class batch split entirely.
     */
    materialQuality: MaterialQuality;
}

export const DEFAULT_VXL_SCENE_RENDERER_OPTIONS: VxlSceneRendererOptions = {
    surfaceStep: 1,
    materialQuality: DEFAULT_MATERIAL_QUALITY,
};

/**
 * Pick the LOD index for a camera distance. `lodDistances[i]` is the max
 * distance for LOD i; the result is the number of thresholds the distance
 * meets or exceeds, clamped to `[0, maxLod]`.
 */
export function pickLod(distance: number, lodDistances: number[], maxLod: number): number {
    let lod = 0;
    for (let i = 0; i < lodDistances.length; i++) {
        if (lodDistances[i]! <= distance) lod++;
    }
    if (lod < 0) lod = 0;
    if (lod > maxLod) lod = maxLod;
    return lod;
}

/** A handle to one instance inside the per-(bias-step, class) BatchedMesh `key`. */
interface InstanceRef {
    /** Packed batch key `(offset + LOD) * CLASS_STRIDE + classIdx`; indexes `batchByKey`. */
    key: number;
    /** instanceId within that batch. */
    id: number;
}

interface ChunkEntry {
    cx: number;
    cy: number;
    cz: number;
    /** Chunk center in world space, used for camera-distance LOD selection. */
    center: THREE.Vector3;
    /**
     * Instance handles per LOD level (array index = LOD). All instances for the
     * active LOD are visible; switching LOD hides the old level's instances and
     * shows the new level's. Empty inner arrays are fine (an empty LOD).
     */
    lodInstances: InstanceRef[][];
    /** Currently-visible LOD index, or `HIDDEN_LOD` while outside the render region. */
    activeLod: number;
}

/** `ChunkEntry.activeLod` of a chunk the render region excludes: no LOD is drawn. */
const HIDDEN_LOD = -1;

export class VxlSceneRenderer {
    /** Scene-graph root holding the per-batch-key BatchedMeshes. Add this to your scene. */
    readonly group: THREE.Group;

    private readonly world: DecodedVxlSceneWorld;
    private readonly entries: ChunkEntry[] = [];
    /** World-space box outside which no chunk is drawn (`setRenderRegion`); null draws all. */
    private renderRegion: THREE.Box3 | null = null;
    private readonly chunkBoxScratch = new THREE.Box3();
    /**
     * One THREE.BatchedMesh per distinct packed key `(offset + LOD) * CLASS_STRIDE +
     * classIdx`. All of a key's chunk/LOD/offset sub-geometries live in this single batch
     * as instances and render in ONE multi-draw call — so terrain draw calls scale with
     * the handful of bias steps (x the few classes), not the thousands of chunks.
     */
    private readonly batchByKey = new Map<number, THREE.BatchedMesh>();
    /**
     * One shared atlas material per batch key. Between keys only `polygonOffset` (the
     * bias step) and the material CLASS differ; every material samples the SAME shared
     * atlas texture (VoxelWorld's atlas mode / genre fast path). Plain Lambert, a class's
     * Phong/Physical tier, or — for a world with an emissive LUT — the dual-backend
     * emissive variant of any of those, hence the `THREE.Material` type.
     */
    private readonly materialCache = new Map<number, THREE.Material>();
    /**
     * Material handed to `buildHintMeshSoA` for the throwaway Mesh wrapper it returns. The
     * batch material cannot be passed any more: the builder's parameter is typed
     * `THREE.MeshLambertMaterial` and the WebGPU emissive variant is a node material. The
     * wrapper Mesh is discarded immediately (the renderer keeps only `.geometry`, which the
     * batch copies out), so this material is NEVER rendered — it exists solely so the builder
     * does not allocate a fresh atlas material per sub-geometry. Created on first use (a
     * world with no quads never allocates it); one instance per renderer, disposed with it.
     */
    private geometryBuildMaterial: THREE.MeshLambertMaterial | null = null;
    /**
     * Fixed RGB444→atlas-UV table: `[u0,v0, u1,v1, …]`, length `2·ATLAS_CELL_COUNT`.
     * Indexed by a quad/voxel's `colorIdx` — which IS its 12-bit atlas cell — so the
     * per-vertex mesh loops in `buildHintMeshSoA` do no color math. No per-world palette.
     */
    private readonly paletteUV: Float32Array;
    /**
     * World-level emissive-strength LUT (v7), or null for every older world. Non-null is the
     * ONE switch for the whole emissive path: the per-vertex attribute, the emissive material
     * variant and the UV→cell table below all hang off it, so a null world costs nothing.
     */
    private readonly emissiveByCell: Uint8Array | null;
    /**
     * World-level material-class LUT (v9), cell → classIdx into `classNames` (+1; 0 =
     * matte), or null for an older world, an unclassified one, or a 'low'-quality load.
     * Non-null is the one switch for the class batch split. A defensive COPY of the
     * decoded LUT with out-of-range indices clamped to 0, so the batch-key packing and
     * `classNames` lookups can never go out of bounds on a foreign file.
     */
    private readonly classByCell: Uint8Array | null;
    /** The class names `classByCell` indexes into (empty when it is null). */
    private readonly classNames: string[];
    /**
     * Inverse of `paletteUV` (`u → v → cell`), built for an emissive OR classed world. The
     * smooth surface's builder resolves colour to atlas UVs internally and emits no
     * per-vertex cell, so its emissive strength — and its material class — are recovered
     * by inverting the table its UVs were copied from.
     */
    private readonly cellByUv: Map<number, Map<number, number>> | null;

    /**
     * Dedicated batches for the smooth movement surfaces (one instance per
     * chunk-with-surface, one batch per material class actually present — classIdx 0 for
     * every unclassified world). Separate from the bias-step batches both so the
     * always-visible surface is not LOD-toggled AND so it can use a SMOOTH
     * (flatShading:false) material: the welded geometry carries proper analytic
     * per-vertex normals (`SurfaceMeshBuilder.cornerNormal`, leaning with the slope), so
     * smooth shading lights it by its real gradient. The blocky step batches stay
     * flatShading:true (per-voxel-face faceting is correct there). Always visible; never
     * LOD-toggled.
     */
    private readonly surfaceBatches = new Map<number, THREE.BatchedMesh>();
    private readonly surfaceMaterials = new Map<number, THREE.Material>();

    /**
     * Set once the owning terrain system has freed the decoded columns. Only
     * `setChunkHints` cares — everything else the renderer does after `build()` reads
     * `lodDistances` and its own `entries`, never the columns.
     */
    private decodedColumnsReleased = false;

    private readonly opts: VxlSceneRendererOptions;

    constructor(world: DecodedVxlSceneWorld, opts: VxlSceneRendererOptions = DEFAULT_VXL_SCENE_RENDERER_OPTIONS) {
        this.world = world;
        this.opts = opts;
        this.emissiveByCell = world.emissiveByCell ?? null;

        // Material classes: sanitised local copy of the v9 LUT, or null when the world
        // has none — or when the quality tier's policy allows nothing above Lambert, in
        // which case splitting batches would spend draw calls on materials that all
        // construct identically ('low' renders a classified world exactly as an
        // unclassified one, by design).
        const policy = materialQualityPolicy(opts.materialQuality);
        const classesEnabled = policy.directTier || policy.environmentTier;
        this.classNames = classesEnabled ? (world.materialClassNames ?? []) : [];
        const sourceLut = classesEnabled ? (world.materialClassByCell ?? null) : null;
        if (sourceLut && this.classNames.length > 0) {
            const lut = new Uint8Array(sourceLut);
            const maxIdx = Math.min(this.classNames.length, CLASS_STRIDE - 1);
            for (let i = 0; i < lut.length; i++) {
                if (lut[i]! > maxIdx) lut[i] = 0;
            }
            this.classByCell = lut;
        } else {
            this.classByCell = null;
        }

        // Build the FIXED RGB444→atlas-UV table once: every color is one of the atlas's
        // 4096 cells and the stored `colorIdx` IS that cell (sRGB already baked in at
        // encode time), so map cell → UV directly — no per-world palette, no sRGB step.
        const atlas = getVoxelTextureAtlas();
        this.paletteUV = new Float32Array(ATLAS_CELL_COUNT * 2);
        for (let cell = 0; cell < ATLAS_CELL_COUNT; cell++) {
            const { r, g, b } = atlasCellRepr(cell);
            const uv = atlas.getColorPaletteUV(r, g, b);
            this.paletteUV[cell * 2] = (uv.u0 + uv.u1) / 2;
            this.paletteUV[cell * 2 + 1] = (uv.v0 + uv.v1) / 2;
        }
        this.cellByUv = this.emissiveByCell || this.classByCell ? buildCellByPaletteUv(this.paletteUV) : null;

        this.group = new THREE.Group();
        this.build();
    }

    /** The class index (0 = matte) of a colour cell — 0 everywhere without a class LUT. */
    private classOfCell(colorIdx: number): number {
        return this.classByCell ? this.classByCell[colorIdx]! : 0;
    }

    /** The class name a non-zero class index stands for. */
    private classNameFor(classIdx: number): string | undefined {
        return classIdx > 0 ? this.classNames[classIdx - 1] : undefined;
    }

    /**
     * (Re)build every batch from `this.world`. Pass 1 tallies the exact vertex/index/instance
     * capacity per batch key from the decoded quad counts (`buildHintMeshSoA` emits
     * exactly 4 verts / 6 indices per quad — BatchedMesh throws if a buffer overflows,
     * so the sizing must be exact). Pass 2 creates one exactly-sized BatchedMesh per key,
     * plus the surface batches. Pass 3 builds each chunk's sub-geometries and adds them as
     * instances, visible only for LOD0; surface geometry goes into the surface batch of
     * its class.
     */
    private build(): void {
        const world = this.world;
        const chunkSize = world.chunkSize;
        const classOf = (colorIdx: number): number => this.classOfCell(colorIdx);

        // Build the smooth-surface heightfield once (dense typed arrays, not string Maps), then
        // MEASURE each chunk's welded surface — exact vert/index counts only, no geometry retained.
        // The geometry is built lazily per chunk in Pass 3 and dropped after GPU upload, so only one
        // chunk's surface arrays are ever resident (the whole-world surfaceGeoms array is gone).
        // For a classed world the measure is split per class, since each class is its own batch.
        const field = buildSurfaceField(world, this.opts.surfaceStep);
        const surfCounts: Array<Map<number, { vertCount: number; indexCount: number }>> = world.chunks.map(ch =>
            this.classByCell
                ? measureChunkSurfaceByClass(field, ch, this.classByCell)
                : new Map([[0, measureChunkSurface(field, ch)]]));

        // ── Pass 1: exact capacity per batch key (greedy quads) ─────────────────────
        const vtx = new Map<number, number>();
        const idx = new Map<number, number>();
        const inst = new Map<number, number>();
        const bump = (m: Map<number, number>, k: number, d: number): void => { m.set(k, (m.get(k) ?? 0) + d); };

        for (const chunk of world.chunks) {
            for (let lod = 0; lod < chunk.lodHints.length; lod++) {
                for (const [group, qCount] of quadCountsByOffsetAndClass(chunk.lodHints[lod]!, classOf)) {
                    const key = packedKey(offsetOfGroup(group) + lod, classOfGroup(group));
                    bump(vtx, key, qCount * 4);
                    bump(idx, key, qCount * 6);
                    bump(inst, key, 1);
                }
            }
        }

        // Surface batch capacity per class (sum over chunks with a non-empty surface).
        const surfVertsByClass = new Map<number, number>();
        const surfIdxByClass = new Map<number, number>();
        const surfInstByClass = new Map<number, number>();
        let surfVerts = 0, surfIdx = 0, surfInst = 0;
        for (const counts of surfCounts) {
            for (const [classIdx, c] of counts) {
                if (c.vertCount === 0) continue;
                bump(surfVertsByClass, classIdx, c.vertCount);
                bump(surfIdxByClass, classIdx, c.indexCount);
                bump(surfInstByClass, classIdx, 1);
                surfVerts += c.vertCount;
                surfIdx += c.indexCount;
                surfInst += 1;
            }
        }

        // ── Pass 2: one exactly-sized BatchedMesh per key + the surface batches ──────
        for (const [key, instCount] of inst) {
            const batch = new THREE.BatchedMesh(instCount, vtx.get(key)!, idx.get(key)!, this.material(key));
            batch.castShadow = true;
            batch.receiveShadow = true;
            this.batchByKey.set(key, batch);
            this.group.add(batch);
        }
        for (const [classIdx, instCount] of surfInstByClass) {
            const batch = new THREE.BatchedMesh(
                instCount, surfVertsByClass.get(classIdx)!, surfIdxByClass.get(classIdx)!, this.surfaceMat(classIdx),
            );
            // Identifies a surface batch (they are the only flatShading:false batches).
            batch.name = classIdx === 0 ? 'smoothSurface' : `smoothSurface:${this.classNameFor(classIdx)}`;
            batch.castShadow = true;
            batch.receiveShadow = true;
            this.surfaceBatches.set(classIdx, batch);
            this.group.add(batch);
        }

        // ── [SmoothSurface] diagnostic (temporary; remove once validated) ───────────
        // The smooth movement surface is rendered as welded meshes in `surfaceBatches`
        // (flatShading:false, smooth per-vertex normals). surfaceBatch="NONE" ⇒ NOT rendered.
        // surfaceBatch="CREATED" with columns>0 but the road still looks blocky ⇒ the
        // iframe is running an OLD engine build (the removed per-voxel cube path).
        console.log(
            `[SmoothSurface] renderer build: surfaceStep=${this.opts.surfaceStep}, ` +
            `surfaceColumns=${field.count}, chunksWithSurface=${surfInst}, ` +
            `surfaceVerts=${surfVerts}, surfaceQuads=${surfIdx / 6}, ` +
            `surfaceBatch=${surfInst > 0 ? 'CREATED (welded smooth mesh)' : 'NONE — surface skipped'}` +
            (this.classByCell ? `, materialClasses=[${this.classNames.join(', ')}]` : ''),
        );

        // ── Pass 3: build geometry + add instances ──────────────────────────────────
        for (let ci = 0; ci < world.chunks.length; ci++) {
            const chunk = world.chunks[ci]!;
            const { cx, cy, cz } = chunk;
            const ctx: HintMeshCtx = {
                minVoxelSize: world.minVoxelSize,
                originX: cx * chunkSize, originY: cy * chunkSize, originZ: cz * chunkSize,
            };
            const entry: ChunkEntry = {
                cx, cy, cz,
                center: new THREE.Vector3((cx + 0.5) * chunkSize, (cy + 0.5) * chunkSize, (cz + 0.5) * chunkSize),
                lodInstances: chunk.lodHints.map(() => [] as InstanceRef[]),
                activeLod: 0,
            };
            this.entries.push(entry);

            // Build one sub-instance per (LOD level, offset group, class). Track each
            // (offset, class) group's FINEST level that actually has quads: after an
            // effective-step skip (`applyEffectiveStepSkip`) a group's fine levels may
            // hold nothing, and those levels must be backfilled below with the group's
            // finest kept instance — otherwise the group would vanish whenever a near
            // LOD is active.
            const firstRefByGroup = new Map<number, { level: number; ref: InstanceRef }>();
            for (let lod = 0; lod < chunk.lodHints.length; lod++) {
                const quads = chunk.lodHints[lod]!;
                for (const group of distinctGroupsAscending(quads, classOf)) {
                    const offset = offsetOfGroup(group);
                    const classIdx = classOfGroup(group);
                    const sub = filterQuadsByGroup(quads, offset, classIdx, classOf);
                    const key = packedKey(offset + lod, classIdx);
                    // Levels ascend, so the first level a group appears at is that group's
                    // FINEST KEPT one — i.e. the instance backfilled as the near-camera
                    // representation. It glows even when it was built at lod > 0 (a mobile
                    // `applyEffectiveStepSkip` budget sheds whole LOD0 groups); only levels
                    // COARSER than it are zeroed. Identical to `lod` when nothing was shed.
                    const isFinestForGroup = !firstRefByGroup.has(group);
                    const id = this.addInstance(key, sub, ctx, isFinestForGroup ? 0 : lod);
                    this.batchByKey.get(key)!.setVisibleAt(id, false);
                    const ref: InstanceRef = { key, id };
                    entry.lodInstances[lod]!.push(ref);
                    if (isFinestForGroup) firstRefByGroup.set(group, { level: lod, ref });
                }
            }
            // Backfill: levels finer than a group's finest built instance SHARE
            // that instance (same {key, id} — no extra geometry, no extra batch
            // capacity). `updateLod` hides the outgoing level's refs before showing the
            // incoming level's, so a ref shared by both ends the frame visible.
            for (const { level, ref } of firstRefByGroup.values()) {
                for (let lod = 0; lod < level; lod++) entry.lodInstances[lod]!.push(ref);
            }
            // Initial visibility: exactly the refs the initial LOD (0) uses.
            for (const ref of entry.lodInstances[0] ?? []) {
                this.batchByKey.get(ref.key)!.setVisibleAt(ref.id, true);
            }

            for (const [classIdx, sc] of surfCounts[ci]!) {
                if (sc.vertCount === 0) continue;
                const surfaceBatch = this.surfaceBatches.get(classIdx);
                if (!surfaceBatch) continue;
                // Smooth surface: always-visible, never LOD-toggled. Build lazily here and drop
                // after upload — only this one chunk's surface arrays are resident, never the
                // whole world's. `addGeometry` copies into the batch buffers, so `sg` is GC'd
                // when the loop iteration ends.
                const sg = this.classByCell
                    ? buildChunkSurfaceGeometryForClass(field, chunk, this.paletteUV, this.classByCell, classIdx, sc)!
                    : buildChunkSurfaceGeometry(field, chunk, this.paletteUV, sc)!;
                const geom = surfaceGeometryToBuffer(sg, this.surfaceEmissive(sg));
                const geomId = surfaceBatch.addGeometry(geom);
                surfaceBatch.addInstance(geomId);
                geom.dispose();
            }
        }
    }

    /**
     * Build one sub-geometry and add it as a new instance of the key's batch; returns
     * the instanceId. A shared placeholder material is passed to `buildHintMeshSoA` so no
     * throwaway material is created; the batch copies the geometry into its buffers, so the
     * source geometry is disposed immediately (the discarded Mesh wrapper is GC'd).
     *
     * For an emissive world the per-vertex `emissive` attribute is attached BEFORE the
     * geometry reaches the batch — the first added geometry fixes the batch's attribute
     * layout and every later one must match it. `emissiveLod` reaches the derivation because
     * the near-representation-only rule is enforced per sub-geometry (zeros for levels
     * coarser than the group's finest kept one), not per material: one key's batch
     * mixes LOD levels. The caller passes 0 for a group's finest kept level.
     */
    private addInstance(key: number, quads: DecodedChunkQuads, ctx: HintMeshCtx, emissiveLod: number): number {
        const batch = this.batchByKey.get(key)!;
        const geom = buildHintMeshSoA(quads, this.paletteUV, ctx, this.geometryBuildMat()).geometry;
        if (this.emissiveByCell) {
            // `count` (not the column length) is the quad count, and buildHintMeshSoA emits
            // 4 vertices per quad in quad order.
            const cells = quads.colorIdx.subarray(0, quads.count);
            const values = deriveEmissiveAttribute(cells, 4, this.emissiveByCell, emissiveLod);
            geom.setAttribute('emissive', new THREE.BufferAttribute(values, 1));
        }
        const geomId = batch.addGeometry(geom);
        const id = batch.addInstance(geomId);
        geom.dispose();
        return id;
    }

    /**
     * Per-vertex emissive floats for one chunk's welded smooth surface, or null when the world
     * has no emissive LUT. The surface builder resolves each vertex's atlas cell to UVs
     * internally and emits no cell column, so the cell is recovered by inverting the very
     * table those UVs were copied from (`cellByUv`) — exact, since the UV floats are verbatim
     * copies. The surface batch is never LOD-toggled (one resolution, always visible), so
     * there is no LOD zeroing here.
     */
    private surfaceEmissive(sg: SurfaceGeometryData): Float32Array | null {
        if (!this.emissiveByCell || !this.cellByUv) return null;
        return deriveEmissiveFromUv(sg.uvs, sg.vertCount, this.cellByUv, this.emissiveByCell);
    }

    /** The never-rendered material for `buildHintMeshSoA`'s discarded Mesh wrapper (see the field). */
    private geometryBuildMat(): THREE.MeshLambertMaterial {
        if (!this.geometryBuildMaterial) this.geometryBuildMaterial = getVoxelTextureAtlas().createMaterial();
        return this.geometryBuildMaterial;
    }

    /**
     * Per-frame: select one LOD per chunk by camera distance, toggling the previous
     * level's instances off and the new level's on. Surface instances are never
     * touched (always visible). BatchedMesh handles per-instance frustum culling.
     */
    updateLod(cameraWorldPos: THREE.Vector3): void {
        const half = this.world.chunkSize / 2;
        for (const entry of this.entries) {
            const maxLod = entry.lodInstances.length - 1;
            const dist = cameraWorldPos.distanceTo(entry.center);
            const lod = this.isOutsideRenderRegion(entry, half)
                ? HIDDEN_LOD
                : pickLod(dist, this.world.lodDistances, maxLod);
            if (lod === entry.activeLod) continue;
            if (entry.activeLod !== HIDDEN_LOD) {
                for (const ref of entry.lodInstances[entry.activeLod]!) this.batchByKey.get(ref.key)!.setVisibleAt(ref.id, false);
            }
            if (lod !== HIDDEN_LOD) {
                for (const ref of entry.lodInstances[lod]!) this.batchByKey.get(ref.key)!.setVisibleAt(ref.id, true);
            }
            entry.activeLod = lod;
        }
    }

    /**
     * Draw only the chunks whose box touches `region` (world space); `null` draws every
     * chunk again. Render-only — colliders are untouched. Applied inside `updateLod`, so
     * a LOD switch can never bring back a chunk the region excluded.
     */
    setRenderRegion(region: THREE.Box3 | null): void {
        this.renderRegion = region ? region.clone() : null;
    }

    private isOutsideRenderRegion(entry: ChunkEntry, half: number): boolean {
        if (!this.renderRegion) return false;
        this.chunkBoxScratch.min.set(entry.center.x - half, entry.center.y - half, entry.center.z - half);
        this.chunkBoxScratch.max.set(entry.center.x + half, entry.center.y + half, entry.center.z + half);
        return !this.renderRegion.intersectsBox(this.chunkBoxScratch);
    }

    /**
     * Tell the renderer its world's decoded columns have been freed, so `setChunkHints`
     * reports that rather than rebuilding a world whose other chunks are now empty.
     * Called by `VxlSceneTerrainSystem` at the end of a load (see `keepDecodedColumns`).
     */
    markDecodedColumnsReleased(): void {
        this.decodedColumnsReleased = true;
    }

    /**
     * Replace one chunk's LOD hints (dynamic-edit path) and rebuild. Because each batch is
     * sized to an exact fixed capacity, a hint change is handled by a full rebuild of the
     * batches — cheap relative to an interactive edit, and off every per-frame path. The
     * shared per-key materials in `materialCache` are intentionally preserved across the
     * rebuild (only the batch geometry buffers are freed).
     *
     * That rebuild re-reads EVERY chunk's hints, not just the replaced one, which is why
     * it needs the decoded columns still resident — and why it throws once they have been
     * released. Failing loudly is the point: rebuilding from freed columns would produce a
     * level that renders as empty sky, with nothing to attribute it to.
     */
    setChunkHints(cx: number, cy: number, cz: number, lodHints: DecodedChunkQuads[]): void {
        if (this.decodedColumnsReleased) {
            throw new Error(
                'VxlSceneRenderer.setChunkHints requires the decoded LOD columns, which are '
                + 'released after load to save memory. Set `keepDecodedColumns: true` on the '
                + 'VxlSceneTerrainConfig to retain them.',
            );
        }
        const idx = this.world.chunks.findIndex(c => c.cx === cx && c.cy === cy && c.cz === cz);
        if (idx < 0) return;
        this.world.chunks[idx]!.lodHints = lodHints;
        this.disposeBatches();
        this.entries.length = 0;
        this.build();
    }

    /**
     * Release the CPU-side copies of every batch's vertex/index buffers, keeping the
     * GPU copies. A big baked world's BatchedMesh buffers are hundreds of MB and
     * three.js retains the CPU arrays indefinitely (its WebGPU backend never fires
     * `onUploadCallback`, so the classic dispose-on-upload idiom is unavailable) —
     * on phones that CPU copy alone can jetsam the tab.
     *
     * ARMS the release rather than performing it: each batch frees its arrays only
     * once it has actually drawn with its own material. Both backends copy the
     * arrays into GPU buffers during that first render, after which static geometry
     * never reads them again. Array-swap semantics live in GeometryCpuRelease.
     *
     * The caller's cue (`GameEngine.onSceneWarmedUp`) fires IMMEDIATELY once the
     * boot warmup has happened, so on a multi-level game's level switch it lands
     * before the freshly built batches have ever rendered. Releasing there uploaded
     * a 0-byte vertex buffer and the whole level drew as empty sky — hence the
     * per-mesh arming. A batch that is never drawn simply keeps its arrays.
     *
     * Modes: `full` (published/standalone) drops every vertex attribute — THREE
     * raycasting against the terrain silently misses afterwards (gameplay uses
     * physics raycasts). `keep-pickable` (editor) keeps position so PlacementHelper
     * picking still works and drops the rest (normals/uv — roughly half the CPU
     * copy). The INDEX is kept in both modes; releasing it blanks every frame on
     * WebGPU once the geometry is re-bound (see GeometryCpuRelease's header).
     * Frustum culling is unaffected either way: BatchedMesh culls from its
     * instance bounds, never the attribute arrays. `setChunkHints` rebuilds
     * construct fresh batches, so they are unaffected too.
     */
    releaseCpuGeometry(mode: CpuReleaseMode = 'full'): void {
        for (const batch of this.batchByKey.values()) releaseMeshCpuBuffersAfterUpload(batch, mode);
        for (const batch of this.surfaceBatches.values()) releaseMeshCpuBuffersAfterUpload(batch, mode);
    }

    /**
     * Enable/disable frustum culling on every batch. Turned off for exactly one frame
     * during a level load so that batches outside the camera still DRAW and their armed
     * CPU-buffer release fires — see levels/terrainUploadFrame.ts. Safe to toggle: a
     * BatchedMesh culls from its instance bounds, and nothing else reads the flag.
     */
    setBatchCulling(enabled: boolean): void {
        for (const batch of this.batchByKey.values()) batch.frustumCulled = enabled;
        for (const batch of this.surfaceBatches.values()) batch.frustumCulled = enabled;
    }

    /** Dispose all batch geometry/GPU buffers + every shared material, and clear the group. */
    dispose(): void {
        this.disposeBatches();
        this.entries.length = 0;
        // Materials are shared across batches, so they are freed here exactly once
        // (per-batch disposal only touches the batch's own geometry buffers).
        for (const mat of this.materialCache.values()) mat.dispose();
        this.materialCache.clear();
        if (this.geometryBuildMaterial) { this.geometryBuildMaterial.dispose(); this.geometryBuildMaterial = null; }
        for (const mat of this.surfaceMaterials.values()) mat.dispose();
        this.surfaceMaterials.clear();
    }

    /** Dispose + detach every batch (geometry/GPU buffers only); keeps the shared materials. */
    private disposeBatches(): void {
        for (const batch of this.batchByKey.values()) {
            this.group.remove(batch);
            batch.dispose();
        }
        this.batchByKey.clear();
        for (const batch of this.surfaceBatches.values()) {
            this.group.remove(batch);
            batch.dispose();
        }
        this.surfaceBatches.clear();
    }

    /**
     * The shared atlas material for one packed batch key. Created once and cached, so
     * every cached material samples the ONE shared atlas texture (the genre fast path).
     * `polygonOffset` is enabled only when the bias step `b > 0`, with factor and units
     * proportional to the step so coarser/farther surfaces lose near-coplanar depth ties
     * (geometry is never moved, so no gaps open). Step 0 ⇒ no offset. The class half of
     * the key picks the lighting tier; for an emissive world every tier is the
     * dual-backend emissive variant reading the geometry's per-vertex `emissive` attribute.
     */
    private material(key: number): THREE.Material {
        const cached = this.materialCache.get(key);
        if (cached) return cached;
        const b = Math.floor(key / CLASS_STRIDE);
        const classIdx = key % CLASS_STRIDE;
        const mat = createVxlSceneBatchMaterial({
            flatShading: true,
            polygonOffset: b > 0,
            polygonOffsetFactor: b * POLY_OFFSET_STEP,
            polygonOffsetUnits: b * POLY_OFFSET_STEP,
            materialQuality: this.opts.materialQuality,
        }, this.emissiveByCell !== null, this.classNameFor(classIdx));
        this.materialCache.set(key, mat);
        return mat;
    }

    /**
     * The smooth-surface atlas material for one class (0 = matte). flatShading FALSE —
     * unlike the blocky step materials — so the welded heightfield is lit by its own
     * analytic per-vertex normals (`SurfaceMeshBuilder.cornerNormal`, which lean with the
     * surface gradient) and reads as one continuous slope instead of a fan of facets.
     * Samples the shared atlas texture; no polygon offset (displaced cells are excluded
     * from greedy meshing). The batches are tagged `name="smoothSurface[:class]"` so
     * callers/tests identify them without relying on flatShading.
     */
    private surfaceMat(classIdx: number): THREE.Material {
        const cached = this.surfaceMaterials.get(classIdx);
        if (cached) return cached;
        // SMOOTH shading: use the welded mesh's analytic per-vertex normals (cornerNormal, which
        // lean with the surface gradient) so the piste is lit + self-shadowing by its real slope.
        // flatShading:true would instead derive one normal per triangle (faceted) and bypass them.
        const mat = createVxlSceneBatchMaterial({
            flatShading: false,
            polygonOffset: false,
            polygonOffsetFactor: 0,
            polygonOffsetUnits: 0,
            materialQuality: this.opts.materialQuality,
        }, this.emissiveByCell !== null, this.classNameFor(classIdx));
        this.surfaceMaterials.set(classIdx, mat);
        return mat;
    }
}

// ── (offset, class) group packing for the per-chunk build loops ───────────────
//
// A "group" is one (source coarseness offset, material class) pair within one LOD
// level's quads, packed as `offset * CLASS_STRIDE + classIdx` — NOT the batch key
// (that packs `offset + lod`). Unpacked with the two helpers below so the packing
// arithmetic lives in one place.

function packedKey(b: number, classIdx: number): number {
    return b * CLASS_STRIDE + classIdx;
}

function packedGroup(offset: number, classIdx: number): number {
    return offset * CLASS_STRIDE + classIdx;
}

function offsetOfGroup(group: number): number {
    return Math.floor(group / CLASS_STRIDE);
}

function classOfGroup(group: number): number {
    return group % CLASS_STRIDE;
}

/** A quad's source coarseness offset (axisDir bits 3-5). */
function quadOffset(quads: DecodedChunkQuads, i: number): number {
    return (quads.axisDir[i]! >> 3) & 0x7;
}

/** Distinct (offset, class) groups in ascending packed order — deterministic output. */
function distinctGroupsAscending(quads: DecodedChunkQuads, classOf: (colorIdx: number) => number): number[] {
    const seen = new Set<number>();
    for (let i = 0; i < quads.count; i++) {
        seen.add(packedGroup(quadOffset(quads, i), classOf(quads.colorIdx[i]!)));
    }
    return Array.from(seen).sort((a, b) => a - b);
}

/** Quad count per (offset, class) group. */
function quadCountsByOffsetAndClass(
    quads: DecodedChunkQuads,
    classOf: (colorIdx: number) => number,
): Map<number, number> {
    const m = new Map<number, number>();
    for (let i = 0; i < quads.count; i++) {
        const g = packedGroup(quadOffset(quads, i), classOf(quads.colorIdx[i]!));
        m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
}

/** A new DecodedChunkQuads holding only the quads of one (offset, class) group. */
function filterQuadsByGroup(
    quads: DecodedChunkQuads,
    offset: number,
    classIdx: number,
    classOf: (colorIdx: number) => number,
): DecodedChunkQuads {
    const idx: number[] = [];
    for (let i = 0; i < quads.count; i++) {
        if (quadOffset(quads, i) === offset && classOf(quads.colorIdx[i]!) === classIdx) idx.push(i);
    }
    const n = idx.length;
    const gx = new Uint16Array(n), gy = new Uint16Array(n), gz = new Uint16Array(n);
    const w = new Uint16Array(n), h = new Uint16Array(n);
    const axisDir = new Uint8Array(n), colorIdx = new Uint16Array(n), disp = new Int8Array(n);
    for (let j = 0; j < n; j++) {
        const i = idx[j]!;
        gx[j] = quads.gx[i]!; gy[j] = quads.gy[i]!; gz[j] = quads.gz[i]!;
        w[j] = quads.w[i]!; h[j] = quads.h[i]!;
        axisDir[j] = quads.axisDir[i]!; colorIdx[j] = quads.colorIdx[i]!; disp[j] = quads.disp[i]!;
    }
    return { count: n, gx, gy, gz, w, h, axisDir, colorIdx, disp };
}

/**
 * Wrap raw surface arrays into a THREE.BufferGeometry (positions/uv/normal/index), plus the
 * per-vertex `emissive` float attribute when the world has an emissive LUT (null otherwise,
 * which keeps pre-v7 surface geometry exactly as it was).
 */
function surfaceGeometryToBuffer(g: SurfaceGeometryData, emissive: Float32Array | null): THREE.BufferGeometry {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    // unorm16, like the greedy-quad builder's uv — `normalized: true` is what makes the
    // shader read 0..1 back out of the packed integers.
    geom.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2, true));
    geom.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
    if (emissive) geom.setAttribute('emissive', new THREE.BufferAttribute(emissive, 1));
    geom.setIndex(new THREE.BufferAttribute(g.indices, 1));
    return geom;
}
