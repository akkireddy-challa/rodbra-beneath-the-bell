/**
 * One real frame between the terrain and the scenery, so the terrain's CPU-side geometry
 * is freed BEFORE the scenery allocates.
 *
 * The peak this exists to cut: a level load builds terrain batches (each holding a full
 * CPU copy of its vertex arrays), then builds every environment object, and only then
 * warms up. For a baked circuit on a phone, both sets of copies are live at once at the
 * exact moment memory is tightest — which is what jetsam kills.
 *
 * The release itself is already ARMED when the batches are built
 * (`VxlSceneRenderer.releaseCpuGeometry`, via `onSceneWarmedUp`, which fires immediately
 * once the boot warmup has happened). Each batch then frees its arrays on its own first
 * draw — "drawn, therefore uploaded". So the gap is not the arming, it is the DRAW:
 *
 *  - The render loop does keep running through a level switch (the fade is DOM-only), and
 *    the scenery build awaits network fetches, so frames do get through. But a frame only
 *    draws what is IN FRUSTUM — and on a circuit that is a small slice of the track. Every
 *    other batch keeps its copy through the whole scenery build.
 *  - The GPU warmup, which does un-cull everything, is explicitly NOT an upload signal: it
 *    runs under `setGeometryReleaseSuspended(true)` because it renders before the level's
 *    real passes exist and so uploads less than they consume. Releasing on it once freed
 *    the terrain's `normal` before any shadow-receiving pass had used it, and
 *    `shadow.normalBias` then offset the shadow lookup along a 0-byte buffer — the racing
 *    surface shadow-tested against itself and rendered solid black.
 *
 * Hence this: un-cull the terrain batches, let ONE ordinary frame draw them through the
 * real pass chain, restore culling. Real passes, real uploads, so the per-batch guard is
 * satisfied honestly and every batch — not just the visible ones — drops its copy.
 *
 * The frame draws a level with terrain but no scenery yet. That is a partial picture, not
 * a broken one, and the level-switch fade covers it.
 */

/**
 * Whether to run it at all.
 *
 * OFF at the lower rungs, because the mechanism turns against itself there. Freeing the CPU
 * copies requires DRAWING every batch, which means un-culling the whole terrain for one frame —
 * and `WarmupPolicy`'s mobile default (`light`) sets `uncullScene: false` for exactly that
 * reason: a phone cannot afford a single frame that touches the entire level, a conclusion
 * reached by watching real iPhones die. Reintroducing that draw under another name brought
 * the failure back: a level that loaded at tier 1 on the previous build was killed on the
 * one carrying this.
 *
 * The top rungs keep it — the CPU-copy saving is real and the frame costs nothing anyone
 * sees. `?uploadframe=1` forces it on, for deliberately testing the constrained path.
 */
export function uploadFrameEnabled(fallback: boolean): boolean {
    try {
        const raw = new URLSearchParams(window.location.search).get('uploadframe');
        if (raw !== null) return raw !== '0';
    } catch { /* no window (tests, workers) */ }
    return fallback;
}

/** The slice of the terrain system this needs. */
export interface CullableTerrain {
    setBatchCulling(enabled: boolean): void;
}

/**
 * Frames can stop arriving — a backgrounded tab, a headless run, a warmup holding the
 * renderer. Waiting forever would trade a memory problem for a hung load, so the wait is
 * bounded and a timeout simply proceeds: the batches keep their copies, which is exactly
 * today's behaviour.
 */
const FRAME_WAIT_TIMEOUT_MS = 750;

/**
 * Draw one un-culled terrain frame and wait for it to complete.
 *
 * TWO ticks, not one: `beforeRender` fires ahead of the draw, so the frame that sees the
 * un-culled batches is the one BETWEEN tick 1 and tick 2. Restoring at tick 1 would put
 * culling back before anything had drawn.
 */
export async function drawTerrainUploadFrame(
    terrain: CullableTerrain,
    registerBeforeRender: (cb: () => void) => () => void,
): Promise<void> {
    terrain.setBatchCulling(false);
    try {
        await new Promise<void>((resolve) => {
            let ticks = 0;
            let done = false;
            // Both start null and are assigned below, because `finish` closes over them
            // and can be reached from either one. Ordering matters more than it looks:
            // arming the timer BEFORE registering left a live timeout behind whenever
            // registration threw, and that timeout then ran `finish` against bindings
            // that were never initialised — an uncaught ReferenceError on a dead load,
            // three quarters of a second after the failure it came from.
            let timer: ReturnType<typeof setTimeout> | null = null;
            let unregister: (() => void) | null = null;
            const finish = (): void => {
                if (done) return;
                done = true;
                if (timer !== null) clearTimeout(timer);
                unregister?.();
                resolve();
            };
            // A synchronous throw here rejects the promise, with no timer left running.
            unregister = registerBeforeRender(() => {
                if (++ticks >= 2) finish();
            });
            timer = setTimeout(finish, FRAME_WAIT_TIMEOUT_MS);
            // `.unref` keeps a test runner from being held open by the timer; browsers
            // have no such method, hence the optional call.
            (timer as unknown as { unref?: () => void }).unref?.();
        });
    } finally {
        // Restored even if the wait threw or timed out: leaving the terrain permanently
        // un-culled would cost every subsequent gameplay frame.
        terrain.setBatchCulling(true);
    }
}
