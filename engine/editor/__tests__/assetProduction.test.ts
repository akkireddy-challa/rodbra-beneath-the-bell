/**
 * Provenance has to answer for EVERY asset, including the ones written before
 * `production` existed — otherwise the Regenerate offer is missing exactly
 * where it is most needed. And it must only offer what it can actually deliver:
 * a procedural rebuild with no stored spec would produce a different object.
 */

import { assetProductionOf, describeAssetProduction } from 'editor/assetProduction.js';

describe('inferring production for legacy assets', () => {
    it('reads the stored record when present', () => {
        expect(assetProductionOf({ production: { method: 'uploaded' }, sourceGlbUrl: 'x.glb' }).method)
            .toBe('uploaded');
    });

    it('treats a .vox/.qb import as uploaded', () => {
        expect(assetProductionOf({ sourceModelUrl: 'thing.vox' }).method).toBe('uploaded');
    });

    it('separates a user-uploaded GLB from a generated one', () => {
        expect(assetProductionOf({ sourceGlbUrl: 'a.glb', source: 'uploaded' }).method).toBe('uploaded');
        expect(assetProductionOf({ sourceGlbUrl: 'a.glb' }).method).toBe('generated');
    });

    it('treats a forged voxel master as generated', () => {
        expect(assetProductionOf({ sourceVxlMasterUrl: 'm.vxl' }).method).toBe('generated');
    });

    it('falls back to procedural when nothing was recorded', () => {
        // An asset with no source of any kind was built from primitives — which
        // is precisely the case that used to render "none recorded".
        expect(assetProductionOf({}).method).toBe('procedural');
    });
});

describe('which regenerations are offered', () => {
    it('offers a procedural rebuild only when the spec was kept', () => {
        expect(describeAssetProduction({}).canRegenerateProcedural).toBe(false);
        expect(describeAssetProduction({
            production: { method: 'procedural', spec: { parts: [] } },
        }).canRegenerateProcedural).toBe(true);
    });

    it('offers AI generation whenever there is a brief to generate from', () => {
        expect(describeAssetProduction({ description: 'a rusty barrel' }).canRegenerateGenerated).toBe(true);
        expect(describeAssetProduction({ production: { method: 'generated', prompt: 'a lamp' } }).canRegenerateGenerated).toBe(true);
        expect(describeAssetProduction({}).canRegenerateGenerated).toBe(false);
        expect(describeAssetProduction({ description: '   ' }).canRegenerateGenerated).toBe(false);
    });

    it('always allows replacement by upload', () => {
        expect(describeAssetProduction({}).canReplaceByUpload).toBe(true);
    });

    it('never expires the offer once an asset has been generated', () => {
        // The old one-shot rule keyed on `placeholder`, so writing a description
        // (which every successful generation does) permanently hid the button.
        const regenerated = { sourceGlbUrl: 'a.glb', description: 'a lamp post', placeholder: false };
        expect(describeAssetProduction(regenerated).canRegenerateGenerated).toBe(true);
    });

    it('labels each method for display', () => {
        expect(describeAssetProduction({}).label).toBe('Procedurally generated');
        expect(describeAssetProduction({ sourceGlbUrl: 'a.glb' }).label).toBe('AI-generated');
        expect(describeAssetProduction({ sourceModelUrl: 'a.vox' }).label).toBe('Uploaded');
    });

    it('never calls a forger stand-in AI-generated', () => {
        // The panel showed "Produced by: AI-generated" directly above the same
        // asset's "AI placeholder — box-model stand-in" badge and the button
        // offering to generate it. Forged games on disk still carry the stored
        // `generated` record, so the label must not wait for a re-forge.
        const forgedStandIn = {
            production: { method: 'generated' as const, prompt: 'a broad shade oak' },
            sourceGlbUrl: 'OakTrees.glb',
            fitBox: { x: 6.9, z: 5.5, height: 7.6 },
            description: 'a broad shade oak',
            placeholder: true,
        };
        expect(describeAssetProduction(forgedStandIn).label).toBe('Procedurally generated');
        // It is still the thing you regenerate — the offer must survive the relabel.
        expect(describeAssetProduction(forgedStandIn).canRegenerateGenerated).toBe(true);
    });

    it('still calls a real generated mesh AI-generated', () => {
        // A completed HQ regeneration clears the flag; that asset IS generated.
        expect(describeAssetProduction({
            production: { method: 'generated', prompt: 'a broad shade oak' },
            sourceGlbUrl: 'OakTree-hq.glb',
            fitBox: { x: 6.9, z: 5.5, height: 7.6 },
            description: 'a broad shade oak',
            placeholder: false,
        }).label).toBe('AI-generated');
    });
});
