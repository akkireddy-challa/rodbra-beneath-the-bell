/**
 * @jest-environment jsdom
 *
 * The parser reads `window.location.search`; the controller is pure and takes its world
 * through provider callbacks, so neither needs an engine.
 */
import {
    resolveSplatViewMode,
    isSplatViewMode,
    SplatViewController,
    DEFAULT_SPLAT_VIEW_MODE,
    type SplatViewMode,
} from 'engine/SplatViewMode.js';

function withSearch(query: string, fn: () => void): void {
    const original = window.location.search;
    const set = (search: string): void => {
        Object.defineProperty(window, 'location', {
            value: { ...window.location, search },
            writable: true,
            configurable: true,
        });
    };
    set(query);
    try { fn(); } finally { set(original); }
}

describe('resolveSplatViewMode', () => {
    it('defaults to both — a game must never load with half its world hidden', () => {
        withSearch('', () => expect(resolveSplatViewMode()).toBe('both'));
        expect(DEFAULT_SPLAT_VIEW_MODE).toBe('both');
    });

    it.each<SplatViewMode>(['both', 'splats', 'voxels'])('accepts ?splats=%s', (mode) => {
        withSearch(`?splats=${mode}`, () => expect(resolveSplatViewMode()).toBe(mode));
    });

    /** Typed by hand into a URL bar, so a typo must degrade, not break the load. */
    it('warns and falls back on an unrecognised value rather than throwing', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        withSearch('?splats=colliders', () => expect(resolveSplatViewMode()).toBe('both'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('colliders'));
        warn.mockRestore();
    });

    it('ignores an empty value', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        withSearch('?splats=', () => expect(resolveSplatViewMode()).toBe('both'));
        warn.mockRestore();
    });

    it('is not confused by other params', () => {
        withSearch('?lod=2&splats=voxels&dpr=1', () => expect(resolveSplatViewMode()).toBe('voxels'));
    });
});

describe('isSplatViewMode', () => {
    it('accepts only the three modes', () => {
        expect(isSplatViewMode('both')).toBe(true);
        expect(isSplatViewMode('splats')).toBe(true);
        expect(isSplatViewMode('voxels')).toBe(true);
        for (const bad of ['Both', 'colliders', '', null, undefined, 2, {}]) {
            expect(isSplatViewMode(bad)).toBe(false);
        }
    });
});

describe('SplatViewController', () => {
    function harness(mode: SplatViewMode) {
        const world = { visible: true } as unknown as import('three').Object3D;
        const renderers = [
            { setSplatVisibility: jest.fn() },
            { setSplatVisibility: jest.fn() },
        ];
        const colliderEditor = { setVoxelsVisible: jest.fn() };
        const controller = new SplatViewController({
            getWorldGroup: () => world,
            getRenderers: () => renderers,
            getColliderEditor: () => colliderEditor,
        }, mode);
        return { world, renderers, colliderEditor, controller };
    }

    it('both shows the world and every splat', () => {
        const h = harness('both');
        h.controller.refresh();
        expect(h.world.visible).toBe(true);
        expect(h.colliderEditor.setVoxelsVisible).toHaveBeenCalledWith(true);
        for (const r of h.renderers) expect(r.setSplatVisibility).toHaveBeenCalledWith(true);
    });

    it('splats hides the voxel world on both surfaces that carry it', () => {
        const h = harness('splats');
        h.controller.refresh();
        expect(h.world.visible).toBe(false);
        // The per-splat collider worlds add their meshes straight to the scene, so hiding the
        // WorldGroup does not reach them — this second call is the one that does.
        expect(h.colliderEditor.setVoxelsVisible).toHaveBeenCalledWith(false);
        for (const r of h.renderers) expect(r.setSplatVisibility).toHaveBeenCalledWith(true);
    });

    it('voxels hides every splat, not just the active one', () => {
        const h = harness('voxels');
        h.controller.refresh();
        expect(h.world.visible).toBe(true);
        for (const r of h.renderers) expect(r.setSplatVisibility).toHaveBeenCalledWith(false);
    });

    it('setMode applies immediately', () => {
        const h = harness('both');
        h.controller.setMode('voxels');
        expect(h.controller.getMode()).toBe('voxels');
        for (const r of h.renderers) expect(r.setSplatVisibility).toHaveBeenCalledWith(false);
    });

    /** The engine calls refresh() after every renderer registers, before anything has loaded. */
    it('is safe with nothing loaded, and idempotent', () => {
        const controller = new SplatViewController({
            getWorldGroup: () => null,
            getRenderers: () => [],
            getColliderEditor: () => null,
        }, 'voxels');
        expect(() => { controller.refresh(); controller.refresh(); }).not.toThrow();
    });

    it('tolerates a renderer that predates setSplatVisibility', () => {
        const controller = new SplatViewController({
            getWorldGroup: () => null,
            getRenderers: () => [{}],
            getColliderEditor: () => ({}),
        }, 'voxels');
        expect(() => controller.refresh()).not.toThrow();
    });
});
