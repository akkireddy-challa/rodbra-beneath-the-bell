/**
 * The host contract's backward-compatibility promise, pinned.
 *
 * A project's vendored editor and the thing embedding it move independently — `bitmagic upgrade`
 * ships a new editor into a project whose CLI is whatever the creator installed, and the Creator
 * deploys on its own schedule. So the editor meets hosts that have never heard of a capability it
 * asks about, and the rule that keeps every one of those pairings working is: an unannounced field
 * keeps its LEGACY value, not its safest-looking one.
 *
 * `mergeCapabilities` is where that rule lives, which is why it is tested apart from the browser.
 */
import {
    DEFAULT_EDITOR_HOST_CAPABILITIES,
    NO_EDITOR_HOST_CAPABILITIES,
    getEditorHost,
    mergeCapabilities,
    resetEditorHostForTests,
    setEditorHostAssetFallback,
} from 'editor/EditorHost.js';

describe('what a host that says nothing gets', () => {
    it('is the web Creator behaviour, so nothing regresses by upgrading the engine', () => {
        expect(DEFAULT_EDITOR_HOST_CAPABILITIES).toEqual({
            hqMethods: ['procedural', 'generated', 'upload'],
            hostNavigation: true,
            journal: false,
        });
    });

    it('survives a host that answers with nonsense', () => {
        for (const junk of [null, undefined, 'yes', 42, []]) {
            expect(mergeCapabilities(junk)).toEqual(DEFAULT_EDITOR_HOST_CAPABILITIES);
        }
    });
});

describe('folding a host announcement into the defaults', () => {
    it('keeps the legacy value for every field the host did not mention', () => {
        // The property the whole design rests on: a host built before a capability existed cannot
        // announce it, and must land on the behaviour it already had.
        expect(mergeCapabilities({ hostNavigation: false })).toEqual({
            hqMethods: ['procedural', 'generated', 'upload'],
            hostNavigation: false,
            journal: false,
        });
    });

    it('takes the bitmagic dev view exactly as it announces itself', () => {
        expect(mergeCapabilities({ hqMethods: ['generated'], hostNavigation: false, journal: true }))
            .toEqual({ hqMethods: ['generated'], hostNavigation: false, journal: true });
    });

    it('drops methods it does not recognise rather than offering them', () => {
        // An unknown method would render a button whose click nothing on either side handles.
        expect(mergeCapabilities({ hqMethods: ['generated', 'teleport'] }).hqMethods)
            .toEqual(['generated']);
    });

    it('lets a host announce that it can service nothing', () => {
        // Distinct from "said nothing": an empty array is a decision, and hides the section.
        expect(mergeCapabilities({ hqMethods: [] }).hqMethods).toEqual([]);
    });

    it('ignores a field of the wrong type instead of coercing it', () => {
        expect(mergeCapabilities({ journal: 'true', hqMethods: 'all' }))
            .toEqual(DEFAULT_EDITOR_HOST_CAPABILITIES);
    });
});

describe('running with no host at all', () => {
    // A published or standalone build: `EditorManager` is still constructed, but nothing is
    // listening on the other side of `postMessage`.
    beforeEach(() => resetEditorHostForTests());
    afterEach(() => resetEditorHostForTests());

    it('offers nothing, so no dead button is ever drawn', () => {
        expect(getEditorHost().capabilities).toEqual(NO_EDITOR_HOST_CAPABILITIES);
    });

    it('serves assets from the loaded game data instead of asking', async () => {
        const assets = [{ id: 'a1', name: 'Rock', url: 'rock.vxl', type: 'voxels' }];
        setEditorHostAssetFallback(() => assets);
        await expect(getEditorHost().listAssets()).resolves.toEqual(assets);
    });

    it('does not throw when the editor asks it for something', () => {
        const host = getEditorHost();
        expect(() => host.requestHq({
            assetId: 'a1', assetName: 'Rock', method: 'generated',
            replaceAllOfType: true, objectId: null,
        })).not.toThrow();
        expect(() => host.navigate({ tab: 'assets' })).not.toThrow();
        expect(() => host.journal({ event: 'terrain.saved', voxelUrl: 'x.vxl' })).not.toThrow();
    });
});
