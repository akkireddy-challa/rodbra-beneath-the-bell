/**
 * Build a voxel asset from a high-resolution `.vxl` master instead of a GLB.
 *
 * The GLB path voxelizes a mesh and keeps the mesh around so the asset can be
 * re-voxelized later at a different height or voxel size. When an asset is
 * forged straight to voxels there is no mesh to keep — the master takes that
 * role, and it is roughly 100x smaller than the GLB it replaces (measured
 * 0.4-0.9 MB against 50-100 MB).
 *
 * Two artifacts are uploaded per asset:
 *   master   — TRELLIS's own grid, the source every later size derives from
 *   working  — the asset at the requested voxel size, what the game loads
 *
 * The mesh path is untouched and remains the default; polygonal games still
 * need it. This runs only when the caller has a master to offer.
 */

import { VoxelObjectSaveService } from 'editor/VoxelObjectSaveService.js';
import { buildAutoLodRamp } from 'engine/autoLodRamp.js';
import { additionalLodsForBake } from 'engine/EnvLodPolicy.js';
import {
    compileVoxelModelToVxlAsset, type SmartPartsInput, type VoxelAssetImportResult,
} from 'engine/import/VoxelModelToAsset.js';
import {
    assignPartJoints, cellsPartFromWorking, fitmentFromSpec, lightsFromSpec,
    masterPointToCells, partsTableFromSpec,
} from 'engine/import/SmartObjectParts.js';
import {
    DEFAULT_RESAMPLE_COLOR_MODE,
    MASTER_UP_AXIS,
    masterExtents,
    readVoxelMaster,
    resampleMaster,
    rgb444ToImporterBytes,
    type ResampledVoxels,
    type VoxelMaster,
} from 'engine/import/VoxelMaster.js';
import { uploadFile } from 'engine/StorageUploadUtil.js';
import { decodeVxlV3 } from 'engine/VxlV3Format.js';
import { packCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { GameTemplateContext } from 'engine/template/GameTemplateContext.js';
import type { Asset, AssetLightEmitter } from 'types/game.js';
import type { SmartObjectFitment, SmartObjectSpec } from 'types/smartObject.js';

/**
 * Leaf budget for the master.
 *
 * The compiler halves resolution until it fits, which is right for a renderable
 * asset and wrong for a master: coarsening the source silently caps every future
 * size derived from it. Set high enough that a 512³ forge never trips it.
 */
const MASTER_MAX_LEAVES = 4_000_000;

/** Leaf budget for the working asset — the renderer's practical limit. */
const WORKING_MAX_LEAVES = 600_000;

/** `'HFVX'` little-endian — a raw master straight off the forge server. */
const HFVX_MAGIC = 0x58_56_46_48;

/** True for a raw HFVX master; false for the compiled `.vxl` master in storage. */
function isHfvxMaster(buffer: ArrayBuffer): boolean {
    return buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === HFVX_MAGIC;
}

/** Fetch a master's bytes, failing loudly — both entry points start here. */
async function fetchMasterBuffer(masterUrl: string): Promise<ArrayBuffer> {
    const response = await fetch(masterUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch voxel master: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
}

export interface CreateAssetFromVxlMasterData {
    requestId: string;
    name: string;
    /** Where to fetch the HFVX master, mirroring how the GLB path takes a URL. */
    masterUrl: string;
    /** Pre-generated id from the AI manifest, honored as the asset id. */
    assetId?: string;
    options: {
        /** Voxel edge length for the working asset. */
        minVoxelSize: number;
        maxVoxelSize: number;
        /**
         * Object height in world units. When absent, derived from `fitBox` so the
         * model fits its allocated slot on every axis; 2 m if neither is given.
         */
        targetHeight?: number;
        /** Allocated box from the World-Forger, recorded so a regen fits the same slot. */
        fitBox?: { x: number; z: number; height: number };
        /** What this object should look like — the prompt for a later regeneration. */
        description?: string;
        /**
         * Whether to register the asset in the loaded game.
         *
         * True for the agent path, which owns the whole write. False for the
         * Creator's Re-voxelize, where the Creator persists the returned record
         * itself — registering here as well gives one asset two writers, and the
         * duplicate world.json churn reload-thrashes the game iframe. The GLB
         * flows already split this way: the agent's handler registers, and
         * Re-voxelize returns bytes for the Creator to store.
         */
        registerAsset?: boolean;
    };
    /**
     * The Forger's smart-object analysis for this master (grid space). When
     * present the working asset is baked with a v12 part channel and the
     * record carries `smartObject` + `light`/`lights`. See types/smartObject.ts.
     */
    smartObject?: SmartObjectSpec;
    /** The raw HFVX URL, recorded so the asset can be re-analysed later. */
    sourceHfvxUrl?: string;
}

/**
 * Compile sparse voxels into `.vxl` bytes through the same importer the Creator uses.
 *
 * Note `effectiveVoxelSize` on the result: it differs from `voxelSize` when the model
 * did not fit `maxLeaves` and the compiler halved its way down to something that did.
 * Every caller here records THAT as the asset's `voxelSize`, never the request, which
 * is a number the uploaded file would contradict.
 */
async function compile(
    name: string,
    voxels: { x: Uint16Array; y: Uint16Array; z: Uint16Array; color: Uint32Array; count: number },
    voxelSize: number,
    maxLeaves: number,
    additionalLodCount: number,
    smartParts?: SmartPartsInput,
): Promise<VoxelAssetImportResult> {
    const cells = new Map<number, number>();
    for (let i = 0; i < voxels.count; i++) {
        cells.set(packCell(voxels.x[i]!, voxels.y[i]!, voxels.z[i]!), voxels.color[i]!);
    }
    const result = await compileVoxelModelToVxlAsset(
        { name, sizeX: 0, sizeY: 0, sizeZ: 0, cells, cellsEmissive: null },
        { voxelSize, additionalLodCount, maxLeaves, ...(smartParts ? { smartParts } : {}) },
    );
    if (result.warning) console.warn(`⚠️ ${name}: ${result.warning}`);
    return result;
}

/** Height with no `targetHeight` and no `fitBox` — matches the GLB path's default. */
const DEFAULT_TARGET_HEIGHT = 2.0;

/** What a smart-object bake adds to the asset record beside the `.vxl`. */
interface SmartBakeExtras {
    smartObject: SmartObjectFitment;
    light?: AssetLightEmitter;
    lights?: AssetLightEmitter[];
}

/**
 * Resample and compile a master, splitting it into smart-object parts when a
 * spec is given. The split is decided on MASTER voxels (`assignPartJoints`) and
 * carried onto the working lattice by majority vote, so any size re-bakes to the
 * same parts; pivots and lights ride the same mapping into metres.
 *
 * Returns the compiled working asset and, for a smart object, the record fields
 * it implies. A spec with no parts and no lights is not smart and adds nothing.
 */
async function resampleAndCompile(
    name: string,
    master: VoxelMaster,
    targetHeight: number,
    voxelSize: number,
    additionalLodCount: number | ((working: ResampledVoxels) => number),
    spec: SmartObjectSpec | undefined,
): Promise<{ working: ResampledVoxels; built: VoxelAssetImportResult; extras?: SmartBakeExtras }> {
    const parts = spec?.parts ?? [];
    const joints = spec && parts.length > 0 ? assignPartJoints(master, spec) : undefined;
    const working = resampleMaster(master, {
        targetHeight,
        voxelSize,
        colorMode: DEFAULT_RESAMPLE_COLOR_MODE,
        ...(joints ? { attribute: joints } : {}),
    });
    const lodCount = typeof additionalLodCount === 'function' ? additionalLodCount(working) : additionalLodCount;

    if (!spec || (parts.length === 0 && spec.lights.length === 0)) {
        const built = await compile(name, working, voxelSize, WORKING_MAX_LEAVES, lodCount);
        return { working, built };
    }

    const table = partsTableFromSpec(parts);
    const smartParts: SmartPartsInput | undefined = parts.length > 0
        ? {
            cellsPart: cellsPartFromWorking(working, packCell),
            parts: table,
            pivots: parts.map((part) => masterPointToCells(working, part.pivot)),
        }
        : undefined;
    const built = await compile(name, working, voxelSize, WORKING_MAX_LEAVES, lodCount, smartParts);

    const lights = lightsFromSpec(spec, working, built.bounds, voxelSize);
    const extras: SmartBakeExtras = {
        smartObject: fitmentFromSpec(spec, table, built.smartPivots ?? []),
        // `light` is the first emitter and `lights` the rest: the light system reads
        // both, and a reader of the single field alone still gets the main one.
        ...(lights.length > 0 ? { light: lights[0]! } : {}),
        ...(lights.length > 1 ? { lights: lights.slice(1) } : {}),
    };
    console.log(`⚙️ Smart object: ${table.length} part(s) [${table.map((p) => p.name).join(', ')}], `
        + `${lights.length} light(s)`);
    return { working, built, extras };
}

/**
 * The height to resample to.
 *
 * An explicit `targetHeight` wins. Otherwise the model is shrunk to fit inside
 * its allocated box on *every* axis, not just height — a wide building given a
 * narrow slot has to be limited by its width, or it overruns neighbours the
 * World-Forger placed around it. Mirrors `extractGlbForVoxelization`.
 */
function resolveTargetHeight(
    span: readonly [number, number, number],
    targetHeight: number | undefined,
    fitBox: { x: number; z: number; height: number } | undefined,
): number {
    if (targetHeight !== undefined) return targetHeight;
    if (!fitBox) return DEFAULT_TARGET_HEIGHT;

    const horizontal = span.filter((_, axis) => axis !== MASTER_UP_AXIS);
    const height = span[MASTER_UP_AXIS];
    const width = horizontal[0] ?? height;
    const depth = horizontal[1] ?? height;
    return Math.min(
        fitBox.height,
        (fitBox.x * height) / Math.max(1, width),
        (fitBox.z * height) / Math.max(1, depth),
    );
}

/**
 * How many LODs beyond LOD 0 to bake — the same rule the GLB path applies.
 *
 * This path used to hardcode 2, which is right for a prop and one level short for
 * a building: `EnvironmentObjectSystem` still classifies the loaded asset as a
 * building from its rendered bbox and applies the wide 100/200/300 schedule, so a
 * 3-level building loses its 300 m band AND culls 100 m early.
 *
 * With no `fitBox` the resampled span is the honest fallback — it is the bbox the
 * runtime will measure — and it subsumes `targetHeight`, which the resample has
 * already scaled the model to.
 */
function resolveAdditionalLodCount(
    fitBox: { x: number; z: number; height: number } | undefined,
    workingDimensions: readonly number[],
    voxelSize: number,
): number {
    return additionalLodsForBake(fitBox, Math.max(...workingDimensions) * voxelSize);
}

/**
 * Read a master from either form it legitimately arrives in.
 *
 * A freshly forged master comes straight off the forge server as HFVX. Once the
 * asset exists, the stored master is the compiled `.vxl` in cloud storage — that
 * is the whole point, since `.vxl` is a fraction of the size and the engine's
 * own format. Re-voxelize hands back the second, so accepting only the first
 * fails every size change with "Not an HFVX voxel master".
 */
async function readMasterFrom(buffer: ArrayBuffer): Promise<VoxelMaster> {
    if (isHfvxMaster(buffer)) return readVoxelMaster(buffer);

    const decoded = await decodeVxlV3(buffer);

    // Expand LOD leaves back to unit cells: a leaf at lod n covers 2^n cells per
    // axis, and the master must be a flat grid for resampling to be uniform.
    let total = 0;
    for (const fragment of decoded.fragments) {
        for (let i = 0; i < fragment.leaves.count; i++) total += (1 << fragment.leaves.lod[i]!) ** 3;
    }
    const xs = new Uint16Array(total), ys = new Uint16Array(total), zs = new Uint16Array(total);
    const cs = new Uint32Array(total);
    let n = 0;
    const voxelSize = decoded.minVoxelSize ?? 0;
    for (const fragment of decoded.fragments) {
        const leaves = fragment.leaves;
        for (let i = 0; i < leaves.count; i++) {
            const span = 1 << leaves.lod[i]!;
            for (let dz = 0; dz < span; dz++) {
                for (let dy = 0; dy < span; dy++) {
                    for (let dx = 0; dx < span; dx++) {
                        xs[n] = leaves.gx[i]! + dx;
                        ys[n] = leaves.gy[i]! + dy;
                        zs[n] = leaves.gz[i]! + dz;
                        // Leaf colours are RGB444; the master space is 0xRRGGBB.
                        cs[n] = rgb444ToImporterBytes(leaves.color[i]!);
                        n++;
                    }
                }
            }
        }
    }
    if (n === 0) throw new Error('Stored voxel master decoded to no voxels');

    // Resolution comes from the voxel size the master was compiled at (1/N for a
    // unit cube); fall back to the occupied extent when it is missing.
    // Looped, not spread: `Math.max(...xs)` overflows the argument limit on a
    // master with hundreds of thousands of voxels.
    let extent = 0;
    for (let i = 0; i < n; i++) {
        if (xs[i]! > extent) extent = xs[i]!;
        if (ys[i]! > extent) extent = ys[i]!;
        if (zs[i]! > extent) extent = zs[i]!;
    }
    const fromVoxelSize = voxelSize > 0 ? Math.round(1 / voxelSize) : 0;
    const resolution = fromVoxelSize > 0 ? fromVoxelSize : extent + 1;

    return {
        resolution,
        x: xs.subarray(0, n), y: ys.subarray(0, n), z: zs.subarray(0, n),
        color: cs.subarray(0, n), count: n,
    };
}

/**
 * Fetch a master, resample it to the requested size, upload both, return the asset.
 *
 * Throws rather than returning a partial asset: the caller falls back to the GLB
 * path, and a half-written asset would be worse than not having one.
 */
async function buildAssetFromMaster(
    ctx: GameTemplateContext,
    data: CreateAssetFromVxlMasterData,
): Promise<Record<string, unknown>> {
    const opts = data.options;
    const currentGameData = ctx.getCurrentGameData();
    if (!currentGameData?.gameId) throw new Error('No current game data or gameId');
    if (!data.masterUrl) throw new Error('No master URL provided');

    console.log(`🧊 CREATE_ASSET_FROM_VXL_MASTER: name=${data.name}, url=${data.masterUrl}`);

    const raw = await fetchMasterBuffer(data.masterUrl);
    // HFVX means a fresh forge, so the master still has to be compiled and
    // stored. Anything else is the compiled master already in cloud storage —
    // re-voxelizing only changes the working size, so recompiling it would
    // re-upload an identical file and, at 640k+ leaves, build atlas textures
    // large enough to lose the WebGL context and blank the whole editor.
    const isFreshForge = isHfvxMaster(raw);
    const master = await readMasterFrom(raw);
    const span = masterExtents(master).span;
    console.log(`📦 Master: ${master.count} voxels at ${master.resolution}³, `
        + `extents ${span[0]}x${span[1]}x${span[2]} (height ${span[MASTER_UP_AXIS]})`);

    const targetHeight = resolveTargetHeight(span, opts.targetHeight, opts.fitBox);
    const timestamp = Date.now();
    const { working, built: workingAsset, extras } = await resampleAndCompile(
        data.name, master, targetHeight, opts.minVoxelSize,
        (resampled) => resolveAdditionalLodCount(opts.fitBox, resampled.dimensions, opts.minVoxelSize),
        data.smartObject);
    const additionalLodCount = workingAsset.lodCount - 1;
    console.log(`🔻 Resampled to ${working.dimensions.join('x')} cells (${working.count} voxels) `
        + `at ${targetHeight} m, ${workingAsset.lodCount} LOD levels`);
    const workingKb = (workingAsset.vxlBytes.byteLength / 1024).toFixed(0);
    const vxlUrl = await uploadFile(
        workingAsset.vxlBytes, `${currentGameData.gameId}-${data.name}-${timestamp}.vxl`,
        { contentType: 'application/octet-stream', gameId: currentGameData.gameId });
    if (!vxlUrl) throw new Error('Failed to upload the VXL asset');

    // No LODs on the master: it is a source, never rendered, and the extra
    // levels would be pure storage on the artifact we are shrinking.
    let masterUrl = data.masterUrl;
    if (isFreshForge) {
        const masterAsset = await compile(
            `${data.name}-master`, master, 1 / master.resolution, MASTER_MAX_LEAVES, 0);
        const uploaded = await uploadFile(
            masterAsset.vxlBytes, `${currentGameData.gameId}-${data.name}-${timestamp}-master.vxl`,
            { contentType: 'application/octet-stream', gameId: currentGameData.gameId });
        if (!uploaded) throw new Error('Failed to upload the voxel master');
        masterUrl = uploaded;
        console.log(`✅ Uploaded master ${(masterAsset.vxlBytes.byteLength / 1e6).toFixed(1)} MB `
            + `and working ${workingKb} KB`);
    } else {
        console.log(`✅ Reused stored master, uploaded working ${workingKb} KB`);
    }

    // What the compiler ACHIEVED, which is the requested size until the model does not fit the
    // working budget and gets halved into it. Recording the request instead leaves world.json
    // asserting a resolution the uploaded file contradicts.
    const bakedVoxelSize = workingAsset.effectiveVoxelSize;
    // The ladder scaled by the same factor, so `voxelSize` and `voxelizeSettings`
    // below can never describe two different resolutions for one file.
    const bakedMaxVoxelSize = opts.maxVoxelSize * (bakedVoxelSize / opts.minVoxelSize);
    if (workingAsset.warning) {
        console.warn(`⚠️ ${data.name}: baked at ${bakedVoxelSize} m, not the requested `
            + `${opts.minVoxelSize} m — ${workingAsset.warning}`);
    }

    // Fields the save service does not know about ride on the record it registered
    // and on the reply, so both writers of world.json see the same asset.
    const sourceHfvxUrl = data.sourceHfvxUrl ?? (isFreshForge ? data.masterUrl : undefined);
    const smartFields = {
        ...(extras ?? {}),
        ...(sourceHfvxUrl ? { sourceHfvxUrl } : {}),
    };

    let assetId = data.assetId;
    if (opts.registerAsset !== false) {
        const saveService = new VoxelObjectSaveService();
        assetId = saveService.addOrUpdateAsset(
            currentGameData, data.name, vxlUrl, workingAsset.bounds,
            data.assetId, false, undefined, bakedVoxelSize);
        const registered = currentGameData.assets?.find((asset: Asset) => asset.id === assetId);
        if (registered) Object.assign(registered, smartFields);
    }

    return {
        ...smartFields,
        id: assetId, name: data.name, url: vxlUrl, type: 'vxl',
        size: workingAsset.vxlBytes.byteLength, boundingBox: workingAsset.bounds,
        voxelSize: bakedVoxelSize,
        voxelCount: workingAsset.totalVoxels,
        // The source, in place of `sourceGlbUrl` — this is what Re-voxelize reads.
        sourceVxlMasterUrl: masterUrl,
        sourceVxlMasterResolution: master.resolution,
        ...(opts.fitBox ? { fitBox: opts.fitBox } : {}),
        ...(opts.description ? { description: opts.description } : {}),
        placeholder: false,
        // Forged straight to voxels — a generator produced it, and the
        // description is the brief a regeneration would re-use.
        production: {
            method: 'generated' as const,
            at: new Date().toISOString(),
            ...(opts.description ? { prompt: opts.description } : {}),
            ...(masterUrl ? { sourceUrl: masterUrl } : {}),
        },
        voxelizeSettings: {
            minVoxelSize: bakedVoxelSize,
            maxVoxelSize: bakedMaxVoxelSize,
            targetHeight,
            // Meaningless on this path: there is no mesh interior to fill, and the
            // master is already a closed shell. Recorded so the re-voxelize dialog
            // round-trips a complete settings object.
            fillInterior: false,
            // The baked ladder, persisted for the same reason the GLB path persists it:
            // the re-voxelize dialog reads it, and an absent block re-bakes at whatever
            // the handler's fallback is rather than at what this asset actually has.
            // Only the LENGTH drives a master re-bake (resampling is by cell count, not
            // pitch) — the sizes are what the dialog shows and what a CONVERT to the
            // mesh path would use, so they follow the same ramp as the GLB path.
            ...(additionalLodCount > 0
                ? { additionalLods: buildAutoLodRamp(bakedVoxelSize, bakedMaxVoxelSize, additionalLodCount) }
                : {}),
        },
    };
}

/**
 * Message entry point, mirroring `handleCreateAssetFromGlbUrl`.
 *
 * The reply channel depends on who asked, because the channel has side effects.
 * `ASSET_FROM_GLB_URL_SAVED` is what the agent path needs: the Creator bridges it
 * to `ASSET_FROM_GLB_URL_RESULT`, which the dev reload watcher intercepts to
 * persist the asset and reload the iframe. Re-voxelize must NOT take that route —
 * it persists the record itself, so the watcher's write is a second one, and its
 * reload thrashes the running game. The GLB flows already split the same way.
 */
export async function handleCreateAssetFromVxlMaster(
    ctx: GameTemplateContext,
    data: CreateAssetFromVxlMasterData,
): Promise<void> {
    // Acked immediately: the Creator's `requestFromIframe` re-posts an
    // unacknowledged request, and a second forge would upload a duplicate pair
    // of artifacts under a new timestamp.
    ctx.safePostMessage({ type: 'ASSET_FROM_VXL_MASTER_ACK', requestId: data.requestId });
    const replyType = data.options.registerAsset === false
        ? 'ASSET_FROM_VXL_MASTER_SAVED'
        : 'ASSET_FROM_GLB_URL_SAVED';
    try {
        const asset = await buildAssetFromMaster(ctx, data);
        console.log(`✅ CREATE_ASSET_FROM_VXL_MASTER complete: ${data.name}, id: ${asset.id as string}`);
        ctx.safePostMessage({ type: replyType, requestId: data.requestId, success: true, asset });
    } catch (error) {
        console.error('[CREATE_ASSET_FROM_VXL_MASTER] Error:', error);
        ctx.safePostMessage({
            type: replyType,
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create asset from voxel master',
        });
    }
}

/**
 * Re-voxelize from a stored master, returning bytes exactly like the GLB flow.
 *
 * Deliberately a mirror of `VOXELIZE_GLB`: resample instead of voxelize, and
 * otherwise identical — no upload, no asset registration, no world.json write,
 * no reload. The Creator owns all of that, and every attempt to do any of it
 * here produced a duplicate write that reload-thrashed the running game.
 */
export async function handleRevoxelizeFromVxlMaster(
    ctx: GameTemplateContext,
    data: {
        requestId: string;
        masterUrl: string;
        options: { minVoxelSize: number; maxVoxelSize: number; targetHeight?: number; additionalLods?: unknown[] };
        /** The asset's grid-space spec (`smartObject.source`), so the re-bake keeps its parts. */
        smartObject?: SmartObjectSpec;
    },
): Promise<void> {
    ctx.safePostMessage({ type: 'REVOXELIZE_FROM_VXL_MASTER_ACK', requestId: data.requestId });
    try {
        const master = await readMasterFrom(await fetchMasterBuffer(data.masterUrl));
        const targetHeight = resolveTargetHeight(
            masterExtents(master).span, data.options.targetHeight, undefined);
        // The caller's ladder wins — that is the dialog's whole purpose. With none
        // sent, fall back to the same size-derived count the create path bakes,
        // rather than a flat 2 that quietly drops a building's coarsest level.
        const { working, built, extras } = await resampleAndCompile(
            'revoxelize', master, targetHeight, data.options.minVoxelSize,
            (resampled) => data.options.additionalLods?.length
                ?? resolveAdditionalLodCount(undefined, resampled.dimensions, data.options.minVoxelSize),
            data.smartObject);

        console.log(`🔻 Re-voxelized from master: ${working.dimensions.join('x')} cells `
            + `(${built.totalVoxels} voxels) at ${targetHeight} m`);
        ctx.safePostMessage({
            type: 'REVOXELIZE_FROM_VXL_MASTER_RESULT',
            requestId: data.requestId,
            success: true,
            vxlBytes: built.vxlBytes,
            bounds: built.bounds,
            totalVoxels: built.totalVoxels,
            // Both OPTIONAL additions, and both about the same thing: the compiler halves
            // resolution to fit the leaf budget, and used to say so only as a console.warn inside
            // a headless browser nobody reads. The caller still reads the truth off the .vxl
            // header — it drives whatever engine the project vendored, which may predate these —
            // so these make the reply self-describing rather than being the only source.
            voxelSize: built.effectiveVoxelSize,
            ...(built.warning ? { warning: built.warning } : {}),
            // Pivots and light offsets moved with the new size; the caller stores these
            // beside the bytes exactly as the create path does.
            ...(extras ?? {}),
        });
    } catch (error) {
        console.error('[REVOXELIZE_FROM_VXL_MASTER] Error:', error);
        ctx.safePostMessage({
            type: 'REVOXELIZE_FROM_VXL_MASTER_RESULT',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Re-voxelize from master failed',
        });
    }
}
