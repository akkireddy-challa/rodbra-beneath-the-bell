/**
 * Read and write a voxel asset's MATERIAL CLASSES from outside the engine.
 *
 * Two messages, and the split between them is deliberate:
 *
 *   READ_VXL_MATERIAL_SIGNATURE  → what is this asset made of, as far as its own
 *                                  bytes can say (see `VxlMaterialSignature`)
 *   APPLY_VXL_MATERIALS          → here is the answer; write it into the file
 *
 * Nothing here classifies anything. The engine has no model and needs none: the
 * signature is text, the answer is a short verdict list, and whichever lane holds
 * a language model — the Creator's agent, or the creator's own coding agent in a
 * pro project — supplies the middle step. That is also what makes classification
 * structurally unable to break a bake: the asset is uploaded, registered and live
 * before either of these messages is sent, so the worst outcome is an asset that
 * stays exactly as it is today.
 *
 * `APPLY_VXL_MATERIALS` takes an `upload` flag rather than always uploading,
 * mirroring the split `handleCreateAssetFromVxlMaster` and
 * `handleRevoxelizeFromVxlMaster` already draw, and for the same reason: in a pro
 * project the CLI owns `world.json`, and two writers on one asset thrash the
 * reload watcher. The web lane wants the asset row back; the CLI wants the bytes.
 *
 * The stored MASTER is never touched. `VxlMasterAssetHandler` records why
 * recompiling one in the browser is a bad idea — a 640k-leaf master loses the
 * WebGL context and blanks the editor — and there is no reason to: a material
 * class is metadata on the working asset, not a property of the source grid.
 */

import { decodeVxlV3 } from 'engine/VxlV3Format.js';
import { uploadFile } from 'engine/StorageUploadUtil.js';
import {
    buildMaterialSignature, formatMaterialSignatureTable,
    type MaterialSignature,
} from 'engine/template/VxlMaterialSignature.js';
import {
    applyMaterialSlotsToVxlBytes, clearMaterialClassesFromVxlBytes,
    type MaterialAssignment, type MaterialSlotPlan,
} from 'engine/template/VxlMaterialSlotTransforms.js';
import type { GameTemplateContext } from 'engine/template/GameTemplateContext.js';

/** Fetch a `.vxl`'s bytes, failing loudly — both handlers start here. */
async function fetchVxlBytes(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch .vxl: ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

export interface ReadVxlMaterialSignatureData {
    requestId: string;
    /** Where to fetch the asset's working `.vxl`. */
    vxlUrl: string;
}

/**
 * Answer with the asset's material signature, plus the same table a reader would
 * be shown.
 *
 * The rendered table travels with the structured data on purpose: it is generated
 * beside the signature, so a caller that prints it and a caller that feeds it to a
 * model are looking at the identical text, and a column cannot silently stop
 * matching its header in one lane but not the other.
 */
export async function handleReadVxlMaterialSignature(
    ctx: GameTemplateContext,
    data: ReadVxlMaterialSignatureData,
): Promise<void> {
    ctx.safePostMessage({ type: 'READ_VXL_MATERIAL_SIGNATURE_ACK', requestId: data.requestId });
    try {
        const bytes = await fetchVxlBytes(data.vxlUrl);
        const dec = await decodeVxlV3(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        );
        const signature: MaterialSignature = buildMaterialSignature(dec);
        ctx.safePostMessage({
            type: 'READ_VXL_MATERIAL_SIGNATURE_RESULT',
            requestId: data.requestId,
            success: true,
            signature,
            table: formatMaterialSignatureTable(signature),
        });
    } catch (error) {
        console.error('[READ_VXL_MATERIAL_SIGNATURE] Error:', error);
        ctx.safePostMessage({
            type: 'READ_VXL_MATERIAL_SIGNATURE_RESULT',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Reading the material signature failed',
        });
    }
}

export interface ApplyVxlMaterialsData {
    requestId: string;
    /** The asset whose `.vxl` is being rewritten. Kept — never re-minted. */
    assetId: string;
    assetName: string;
    vxlUrl: string;
    /**
     * The verdicts to apply, bound to a signature hash. Omit and pass `clear` to
     * strip every class instead.
     */
    assignment?: MaterialAssignment;
    /** Strip all material classes rather than applying any. The undo. */
    clear?: boolean;
    /**
     * The prompt or description this asset was generated from, if known. Used only
     * by the plausibility guard in `planMaterialSlots`.
     */
    promptText?: string;
    /**
     * true — upload the new `.vxl` and update the asset in place, answering with
     *        the asset row (the Creator owns `world.json` there).
     * false — answer with the bytes and let the caller upload and upsert (a pro
     *        project's CLI owns `world.json`, and two writers thrash its watcher).
     */
    upload: boolean;
}

/** What the reply carries on success. */
interface ApplyResultPayload {
    type: 'APPLY_VXL_MATERIALS_RESULT';
    requestId: string;
    success: true;
    /** True when nothing was classified and the file was left byte-identical. */
    unchanged: boolean;
    /** The named material classes now on the asset. */
    slots: string[];
    /** Classes that lost a share floor, the budget, or the plausibility guard. */
    dropped: MaterialSlotPlan['dropped'];
    baseShare: number;
    signatureHash: string;
    /** Present when `upload` was true. */
    url?: string;
    size?: number;
    /** Present when `upload` was false — the caller uploads these. */
    vxlBytes?: number[];
}

export async function handleApplyVxlMaterials(
    ctx: GameTemplateContext,
    data: ApplyVxlMaterialsData,
): Promise<void> {
    ctx.safePostMessage({ type: 'APPLY_VXL_MATERIALS_ACK', requestId: data.requestId });
    try {
        const original = await fetchVxlBytes(data.vxlUrl);

        if (data.clear) {
            const cleared = await clearMaterialClassesFromVxlBytes(original);
            const unchanged = cleared === original;
            await reply(ctx, data, {
                type: 'APPLY_VXL_MATERIALS_RESULT',
                requestId: data.requestId,
                success: true,
                unchanged,
                slots: [],
                dropped: [],
                baseShare: 1,
                signatureHash: '',
            }, unchanged ? null : cleared);
            return;
        }

        if (!data.assignment) {
            throw new Error('APPLY_VXL_MATERIALS needs either an assignment or clear: true');
        }

        const result = await applyMaterialSlotsToVxlBytes(
            original, data.assignment,
            data.promptText === undefined ? {} : { promptText: data.promptText },
        );
        // A class-free outcome writes nothing: leaving the file alone keeps "the
        // classifier found nothing" byte-identical to "it never ran", so an asset's
        // url does not churn and every placed instance keeps pointing at one file.
        await reply(ctx, data, {
            type: 'APPLY_VXL_MATERIALS_RESULT',
            requestId: data.requestId,
            success: true,
            unchanged: result.unchanged,
            slots: result.plan.slots
                .filter((s) => s.materialClass !== undefined)
                .map((s) => s.name),
            dropped: result.plan.dropped,
            baseShare: result.plan.baseShare,
            signatureHash: result.signature.hash,
        }, result.unchanged ? null : result.bytes);
    } catch (error) {
        console.error('[APPLY_VXL_MATERIALS] Error:', error);
        ctx.safePostMessage({
            type: 'APPLY_VXL_MATERIALS_RESULT',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Applying material classes failed',
        });
    }
}

/**
 * Send the reply, uploading first when the caller asked for it.
 *
 * `bytes === null` means the file was left alone, so there is nothing to upload
 * and nothing to point a new url at.
 */
async function reply(
    ctx: GameTemplateContext,
    data: ApplyVxlMaterialsData,
    payload: ApplyResultPayload,
    bytes: Uint8Array | null,
): Promise<void> {
    if (bytes === null) {
        ctx.safePostMessage(payload);
        return;
    }
    if (!data.upload) {
        // Structured-clone across the iframe boundary cannot carry a Uint8Array
        // view reliably across every host, and the import handlers already settled
        // on a plain number array for the same reason.
        ctx.safePostMessage({ ...payload, vxlBytes: Array.from(bytes) });
        return;
    }
    const fileName = `${sanitizeName(data.assetName || data.assetId)}-materials-${Date.now()}.vxl`;
    const url = await uploadFile(bytes, fileName);
    if (url === null) throw new Error('Upload of the re-encoded .vxl failed');
    ctx.safePostMessage({ ...payload, url, size: bytes.byteLength });
}

/** Storage-safe file stem, matching what the other asset writers produce. */
function sanitizeName(name: string): string {
    const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 48) : 'asset';
}
