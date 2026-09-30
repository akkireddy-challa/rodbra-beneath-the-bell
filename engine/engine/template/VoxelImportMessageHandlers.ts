/**
 * Creator-iframe message handlers for foreign voxel-model import (.vox / .qb).
 * Mirrors the VOXELIZE_GLB reliability protocol: immediate ACK, at-least-once
 * delivery with requestId dedup, progress + result messages.
 */
import type { GameTemplateContext } from 'engine/template/GameTemplateContext.js';
import { uploadFile } from 'engine/StorageUploadUtil.js';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import { isVoxFile, parseVox } from 'engine/import/VoxParser.js';
import { isQbFile, parseQb } from 'engine/import/QbParser.js';
import type { ImportedVoxelFile } from 'engine/import/ImportedVoxelModel.js';
import { compileImportedFile } from 'engine/import/VoxelModelCompiler.js';
import {
    compileVoxelModelToVxlAsset, DEFAULT_VOXEL_ASSET_IMPORT_OPTIONS,
} from 'engine/import/VoxelModelToAsset.js';
import {
    compileVoxelModelToVwld, DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS,
} from 'engine/import/VoxelModelToLevel.js';

const handledImportRequestIds = new Set<string>();

function dedupe(requestId: string): boolean {
    if (handledImportRequestIds.has(requestId)) return true;
    handledImportRequestIds.add(requestId);
    if (handledImportRequestIds.size > 64) {
        const oldest = handledImportRequestIds.values().next().value;
        if (oldest !== undefined) handledImportRequestIds.delete(oldest);
    }
    return false;
}

function parseVoxelModelFile(bytes: ArrayBuffer, fileName: string): ImportedVoxelFile {
    if (isVoxFile(bytes)) return parseVox(bytes);
    if (isQbFile(bytes) || fileName.toLowerCase().endsWith('.qb')) return parseQb(bytes);
    throw new Error('Unrecognized voxel model file (expected MagicaVoxel .vox or Qubicle .qb)');
}

export interface InspectVoxelModelData {
    requestId: string;
    fileData: number[];
    fileName: string;
}

export async function handleInspectVoxelModel(ctx: GameTemplateContext, data: InspectVoxelModelData): Promise<void> {
    ctx.safePostMessage({ type: 'INSPECT_VOXEL_MODEL_ACK', requestId: data.requestId });
    if (dedupe(data.requestId)) return;
    try {
        const file = parseVoxelModelFile(new Uint8Array(data.fileData).buffer, data.fileName);
        let totalVoxels = 0;
        const models = file.grids.map(g => {
            const count = g.voxels.length / 4;
            totalVoxels += count;
            return { name: g.name, sizeX: g.sizeX, sizeY: g.sizeY, sizeZ: g.sizeZ, voxelCount: count };
        });
        ctx.safePostMessage({
            type: 'VOXEL_MODEL_INSPECTED',
            requestId: data.requestId,
            success: true,
            format: file.format,
            models,
            instanceCount: file.instances.length,
            totalVoxels,
            notes: file.notes,
        });
    } catch (error) {
        ctx.safePostMessage({
            type: 'VOXEL_MODEL_INSPECTED',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Voxel model inspection failed',
        });
    }
}

export interface ImportVoxelModelData {
    requestId: string;
    fileData: number[];
    fileName: string;
    destination: 'asset' | 'level';
    settings: {
        voxelSize: number;
        multiModelMode: 'merge' | 'separate';
        additionalLodCount?: number;          // asset destination
        chunkSize?: number;                   // level destination
        additionalLodDistances?: number[];    // level destination
        sourceModelUrl?: string;              // retained source (level asset record)
        sourceModelFormat?: 'vox' | 'qb';
    };
}

export async function handleImportVoxelModel(ctx: GameTemplateContext, data: ImportVoxelModelData): Promise<void> {
    ctx.safePostMessage({ type: 'IMPORT_VOXEL_MODEL_ACK', requestId: data.requestId });
    if (dedupe(data.requestId)) return;

    const progress = (label: string, index: number, total: number): void => {
        ctx.safePostMessage({ type: 'IMPORT_VOXEL_MODEL_PROGRESS', requestId: data.requestId, label, index, total });
    };

    try {
        const file = parseVoxelModelFile(new Uint8Array(data.fileData).buffer, data.fileName);
        const baseName = data.fileName.replace(/\.[^/.]+$/, '');

        if (data.destination === 'asset') {
            const compiled = compileImportedFile(file, { mode: data.settings.multiModelMode, baseName });
            const assets: Array<Record<string, unknown>> = [];
            const warnings: string[] = [];
            for (let i = 0; i < compiled.length; i++) {
                const model = compiled[i]!;
                progress(`Converting ${model.name} (${i + 1}/${compiled.length})…`, i, compiled.length);
                const r = await compileVoxelModelToVxlAsset(model, {
                    ...DEFAULT_VOXEL_ASSET_IMPORT_OPTIONS,
                    voxelSize: data.settings.voxelSize,
                    additionalLodCount: data.settings.additionalLodCount ?? DEFAULT_VOXEL_ASSET_IMPORT_OPTIONS.additionalLodCount,
                });
                if (r.warning) warnings.push(`${model.name}: ${r.warning}`);
                assets.push({
                    name: model.name,
                    vxlBytes: r.vxlBytes,
                    bounds: r.bounds,
                    effectiveVoxelSize: r.effectiveVoxelSize,
                    totalVoxels: r.totalVoxels,
                    voxelsPerLod: r.voxelsPerLod,
                    lodCount: r.lodCount,
                    fragmentCount: r.fragmentCount,
                    colliderBoxCount: r.colliderBoxCount,
                    trimeshTriangles: r.trimeshTriangles,
                });
            }
            ctx.safePostMessage({
                type: 'IMPORT_VOXEL_MODEL_RESULT',
                requestId: data.requestId,
                success: true,
                destination: 'asset',
                assets,
                warning: warnings.length > 0 ? warnings.join(' | ') : undefined,
                notes: file.notes,
            });
            return;
        }

        // destination === 'level'
        const currentGameData = ctx.getCurrentGameData();
        if (!currentGameData?.gameId) throw new Error('No current game / gameId');
        const [model] = compileImportedFile(file, { mode: 'merge', baseName });
        const result = await compileVoxelModelToVwld(model!, {
            voxelSize: data.settings.voxelSize,
            chunkSize: data.settings.chunkSize ?? DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS.chunkSize,
            additionalLods: (data.settings.additionalLodDistances ?? [60, 120]).map(d => ({ distance: d })),
            onProgress: info => progress(info.label, info.chunkIndex, info.totalChunks),
        });

        progress('Uploading level…', 1, 1);
        const safeName = baseName.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').slice(0, 48) || 'level';
        const filename = `${currentGameData.gameId}-${safeName}-${Date.now()}.vwld`;
        let vwldCompressedSize = result.vwldBytes.byteLength;
        const vwldUrl = await uploadFile(result.vwldBytes, filename, {
            contentType: 'application/octet-stream',
            gameId: currentGameData.gameId,
            onUploaded: (n: number) => { vwldCompressedSize = n; },
        });
        if (!vwldUrl) throw new Error('Failed to upload VWLD file');

        const assetRecord = {
            id: getObjectIdService().generateId('asset'),
            name: safeName,
            url: vwldUrl,
            type: 'vwld' as const,
            size: vwldCompressedSize,
            rawSize: result.vwldBytes.byteLength,
            boundingBox: { ...result.worldBounds },
            boundingBoxInMeters: true,
            sourceModelUrl: data.settings.sourceModelUrl ?? null,
            sourceModelName: data.fileName,
            sourceModelFormat: data.settings.sourceModelFormat,
            importSettings: {
                voxelSize: data.settings.voxelSize,
                multiModelMode: 'merge' as const,
                chunkSize: data.settings.chunkSize ?? DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS.chunkSize,
                additionalLodDistances: data.settings.additionalLodDistances ?? [60, 120],
            },
        };

        ctx.safePostMessage({
            type: 'IMPORT_VOXEL_MODEL_RESULT',
            requestId: data.requestId,
            success: true,
            destination: 'level',
            vwldUrl,
            vwldSize: result.vwldBytes.byteLength,
            vwldCompressedSize,
            assetRecord,
            worldBounds: result.worldBounds,
            nonEmptyChunkCount: result.nonEmptyChunkCount,
            totalLod0Leaves: result.totalLod0Cells,
            notes: file.notes,
        });
    } catch (error) {
        console.error('[IMPORT_VOXEL_MODEL] Error:', error);
        ctx.safePostMessage({
            type: 'IMPORT_VOXEL_MODEL_RESULT',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Voxel model import failed',
        });
    }
}
