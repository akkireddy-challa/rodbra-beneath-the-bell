/**
 * The upload frame that frees terrain CPU geometry before the scenery build.
 *
 * Two things here are easy to get wrong and impossible to see afterwards: restoring
 * culling one tick too early (so nothing ever draws un-culled and the whole step is a
 * no-op that still costs a frame), and leaving culling OFF when frames stop arriving
 * (which would silently tax every gameplay frame for the rest of the level). Both are
 * pinned below.
 */
import { drawTerrainUploadFrame } from 'engine/levels/terrainUploadFrame.js';

/** Records culling toggles, and lets a test drive `beforeRender` by hand. */
function harness() {
    const culling: boolean[] = [];
    const terrain = { setBatchCulling: (enabled: boolean) => { culling.push(enabled); } };
    const listeners = new Set<() => void>();
    const registerBeforeRender = (cb: () => void): (() => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
    };
    const tick = (): void => { for (const cb of [...listeners]) cb(); };
    return { culling, terrain, registerBeforeRender, tick, listeners };
}

describe('drawTerrainUploadFrame', () => {
    it('un-culls, waits for a frame to actually draw, then restores', async () => {
        const h = harness();
        const done = jest.fn();
        const promise = drawTerrainUploadFrame(h.terrain, h.registerBeforeRender).then(done);

        // Un-culled immediately, before any frame.
        expect(h.culling).toEqual([false]);

        // beforeRender fires BEFORE the draw, so one tick means nothing has been drawn
        // yet. Restoring here would put culling back before the batches rendered — the
        // exact mistake that would make this whole step pointless.
        h.tick();
        await Promise.resolve();
        expect(done).not.toHaveBeenCalled();
        expect(h.culling).toEqual([false]);

        // The second tick means the frame between the two has completed.
        h.tick();
        await promise;
        expect(h.culling).toEqual([false, true]);
    });

    it('unregisters its hook, so it costs nothing after the frame', async () => {
        const h = harness();
        const promise = drawTerrainUploadFrame(h.terrain, h.registerBeforeRender);
        h.tick();
        h.tick();
        await promise;
        expect(h.listeners.size).toBe(0);
    });

    it('gives up rather than hanging when frames never arrive', async () => {
        // A backgrounded tab, a headless run, a renderer held by something else. The load
        // must continue: the batches simply keep their CPU copies, which is what happened
        // before this step existed.
        jest.useFakeTimers();
        try {
            const h = harness();
            const promise = drawTerrainUploadFrame(h.terrain, h.registerBeforeRender);
            jest.advanceTimersByTime(5000);
            await promise;
            // Restored — leaving terrain permanently un-culled would tax every frame of
            // the level that follows.
            expect(h.culling).toEqual([false, true]);
            expect(h.listeners.size).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it('restores culling, and leaves no timer, when registration itself throws', async () => {
        // Registration failing must not leave a pending timeout behind: it used to, and
        // that orphan fired 750ms later against uninitialised bindings, taking the whole
        // process down with an uncaught ReferenceError long after the load had moved on.
        // Real timers here on purpose — the fake-timer version cannot see the orphan.
        const h = harness();
        const registerThrowing = (): (() => void) => { throw new Error('render hook rejected'); };
        await expect(drawTerrainUploadFrame(h.terrain, registerThrowing)).rejects.toThrow();
        expect(h.culling).toEqual([false, true]);
        await new Promise((r) => setTimeout(r, 900));
    }, 5000);
});
