import {
    isGeneratingHqAsset, setGeneratingHqAssetIds, onGeneratingHqAssetsChanged, getGeneratingHqAssetIds,
} from 'engine/HqGenerationState.js';
import { saveEditorView, restoreEditorView } from 'engine/EditorViewMemory.js';
import * as THREE from 'three';

/**
 * Progress feedback for background HQ asset generation. Generation takes minutes and used
 * to be entirely invisible — the object looked untouched until the level suddenly reloaded
 * with a new mesh, dumping the user back at the default viewpoint.
 */

describe('HqGenerationState', () => {
    afterEach(() => setGeneratingHqAssetIds([]));

    it('tracks which assets are generating', () => {
        setGeneratingHqAssetIds(['a1', 'a2']);
        expect(isGeneratingHqAsset('a1')).toBe(true);
        expect(isGeneratingHqAsset('a2')).toBe(true);
        expect(isGeneratingHqAsset('a3')).toBe(false);
        expect(isGeneratingHqAsset(undefined)).toBe(false);
        expect([...getGeneratingHqAssetIds()].sort()).toEqual(['a1', 'a2']);
    });

    it('reports change only on a real change, so steady-state polls are free', () => {
        // The creator re-pushes every ~4 s for the whole job; the expensive consumers
        // (mesh walk + material clone, inspector re-render) must not run each time.
        expect(setGeneratingHqAssetIds(['a1'])).toBe(true);
        expect(setGeneratingHqAssetIds(['a1'])).toBe(false);
        expect(setGeneratingHqAssetIds(['a1', 'a2'])).toBe(true);
        expect(setGeneratingHqAssetIds(['a2', 'a1'])).toBe(false); // order is irrelevant
        expect(setGeneratingHqAssetIds(['a2'])).toBe(true);
        expect(setGeneratingHqAssetIds([])).toBe(true);
        expect(setGeneratingHqAssetIds([])).toBe(false);
    });

    it('notifies subscribers so the inspector re-renders on its own', () => {
        let calls = 0;
        const off = onGeneratingHqAssetsChanged(() => { calls++; });
        setGeneratingHqAssetIds(['a1']);
        expect(calls).toBe(1);
        setGeneratingHqAssetIds(['a1']);   // no change → no notification
        expect(calls).toBe(1);
        setGeneratingHqAssetIds([]);
        expect(calls).toBe(2);
        off();
        setGeneratingHqAssetIds(['a1']);
        expect(calls).toBe(2);
    });
});

describe('EditorViewMemory', () => {
    const camera = (): THREE.PerspectiveCamera => new THREE.PerspectiveCamera();
    beforeEach(() => sessionStorage.clear());

    it('puts the camera back where it was across a reload', () => {
        const before = camera();
        before.position.set(223.4, 15.2, 461.3);   // the far end of a big level
        before.quaternion.set(0.1, 0.2, 0.3, 0.927);
        saveEditorView('GAME1', before);

        const after = camera();
        expect(restoreEditorView('GAME1', after)).toBe(true);
        expect(after.position.toArray()).toEqual([223.4, 15.2, 461.3]);
        expect(after.quaternion.x).toBeCloseTo(0.1, 6);
        expect(after.quaternion.w).toBeCloseTo(0.927, 6);
    });

    it('is consumed on use, so later navigation is never overridden', () => {
        saveEditorView('GAME1', camera());
        expect(restoreEditorView('GAME1', camera())).toBe(true);
        expect(restoreEditorView('GAME1', camera())).toBe(false);
    });

    it('never hijacks a different game or a stale session', () => {
        const c = camera();
        c.position.set(1, 2, 3);
        saveEditorView('GAME1', c);
        // Switching games must not teleport the new level's camera to the old one's spot.
        const other = camera();
        expect(restoreEditorView('GAME2', other)).toBe(false);
        expect(other.position.toArray()).toEqual([0, 0, 0]);

        saveEditorView('GAME1', c);
        const stored = JSON.parse(sessionStorage.getItem('bm-editor-view')!);
        stored.at = Date.now() - 10 * 60_000; // ten minutes ago: not this reload
        sessionStorage.setItem('bm-editor-view', JSON.stringify(stored));
        expect(restoreEditorView('GAME1', camera())).toBe(false);
    });

    it('ignores missing inputs and corrupt storage instead of throwing mid-reload', () => {
        expect(restoreEditorView('GAME1', camera())).toBe(false); // nothing stored
        expect(restoreEditorView(null, camera())).toBe(false);
        expect(restoreEditorView('GAME1', null)).toBe(false);
        saveEditorView(null, camera());
        expect(sessionStorage.getItem('bm-editor-view')).toBeNull();
        sessionStorage.setItem('bm-editor-view', 'not json');
        expect(restoreEditorView('GAME1', camera())).toBe(false);
    });
});
