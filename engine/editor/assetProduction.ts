/**
 * How an asset was produced, and what can be done about it.
 *
 * Two jobs:
 *
 *  1. **Answer for every asset, including legacy ones.** `Asset.production` is
 *     stamped by the creation paths from now on, but world.json is full of
 *     records that predate it. Those are read from the source fields each path
 *     has always written (`sourceGlbUrl`, `sourceVxlMasterUrl`,
 *     `sourceModelUrl`), falling back to procedural — which is what an asset
 *     with no source at all actually is.
 *
 *  2. **Say which regenerations are available.** The old rule was one-shot: the
 *     inspector offered "Generate high-quality version" only while
 *     `isPlaceholderAsset` held, and a successful generation wrote a
 *     description that permanently suppressed it. So the only way back was
 *     asking the agent, which usually re-rolled a procedural stand-in. Here
 *     every method the asset has the inputs for stays available forever.
 */

import type { Asset, AssetProduction, AssetProductionMethod } from 'types/game.js';
import { isPlaceholderAsset } from 'editor/placeholderAsset.js';

/** What the inspector needs to describe an asset and offer regeneration. */
export interface AssetProductionInfo {
    method: AssetProductionMethod;
    /** Short human label, e.g. "Procedurally generated" or "AI-generated mesh". */
    label: string;
    /** Replay the stored procedural spec. */
    canRegenerateProcedural: boolean;
    /** Re-run AI generation (needs something to prompt with). */
    canRegenerateGenerated: boolean;
    /** Replacing by upload is always possible. */
    canReplaceByUpload: true;
    /** The prompt a regeneration would use, when there is one. */
    prompt: string | null;
}

/** Fields `describeAssetProduction` reads — a subset of `Asset`. */
export type ProducedAssetFields = Pick<Asset,
    'production' | 'sourceGlbUrl' | 'sourceVxlMasterUrl' | 'sourceModelUrl' | 'description' | 'prompt' | 'source'
    | 'placeholder' | 'fitBox'
>;

const LABELS: Record<AssetProductionMethod, string> = {
    procedural: 'Procedurally generated',
    generated: 'AI-generated',
    uploaded: 'Uploaded',
};

/**
 * A forger stand-in is a composition of primitive parts, voxelized. It reaches
 * the asset library through the same GLB handler a real generated mesh does, so
 * it was being STAMPED `generated` and shown as "Produced by: AI-generated" —
 * directly above its own "AI placeholder — box-model stand-in" badge and an
 * offer to generate it. The panel argued with itself, and the reasonable read
 * was that the generation had already happened.
 *
 * The stamp is fixed at the source (`handleCreateAssetFromGlbUrl` records
 * `procedural` for a placeholder bake), but every already-forged game carries
 * the old record, so the label is corrected here too — the display must not
 * depend on a re-forge to stop contradicting itself.
 */
function labelFor(asset: ProducedAssetFields, method: AssetProductionMethod): string {
    return isPlaceholderAsset(asset) ? LABELS.procedural : LABELS[method];
}

/** The stored production record, or one inferred from an older asset's source fields. */
export function assetProductionOf(asset: ProducedAssetFields): AssetProduction {
    if (asset.production?.method) return asset.production;

    // Inference order matters: an uploaded .vox/.qb and an uploaded GLB both
    // leave a source URL behind, and only `source` distinguishes a GLB the user
    // uploaded from one the generator made.
    if (asset.sourceModelUrl) return { method: 'uploaded', sourceUrl: asset.sourceModelUrl };
    if (asset.sourceGlbUrl) {
        return asset.source === 'uploaded'
            ? { method: 'uploaded', sourceUrl: asset.sourceGlbUrl }
            : { method: 'generated', prompt: asset.description ?? asset.prompt };
    }
    if (asset.sourceVxlMasterUrl) {
        return { method: 'generated', prompt: asset.description ?? asset.prompt };
    }
    return { method: 'procedural' };
}

export function describeAssetProduction(asset: ProducedAssetFields): AssetProductionInfo {
    const production = assetProductionOf(asset);
    const prompt = production.prompt ?? asset.description ?? asset.prompt ?? null;

    return {
        method: production.method,
        label: labelFor(asset, production.method),
        // Only a stored spec can be replayed. Procedural assets made before
        // this existed have nothing to re-run, and saying so is better than
        // offering a button that silently produces a different object.
        canRegenerateProcedural: !!production.spec,
        // Anything with a description can be re-generated; without one there is
        // no brief to generate FROM.
        canRegenerateGenerated: !!prompt?.trim(),
        canReplaceByUpload: true,
        prompt: prompt?.trim() ? prompt : null,
    };
}
