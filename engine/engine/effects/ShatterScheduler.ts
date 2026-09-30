/**
 * Spreads death shatters over frames.
 *
 * A bone-voxel shatter costs ~60 ms on a forged character (skinning the death
 * pose on the CPU, baking one geometry per limb, spawning limb bodies and the
 * splash debris). One kill a frame is fine. A rocket kills eight in the SAME
 * frame, inside the projectile's hit callback, and the frame is gone for half a
 * second — measured 473 ms of a 567 ms frame in `shatterMeshIntoLimbs`.
 *
 * The rule: the first shatter of a frame always runs now; after the frame has
 * spent `SHATTER_FRAME_BUDGET_MS` on shatters, the rest queue and drain on the
 * following frames, at least one per frame and more while under budget. The
 * corpse waits frozen in its death pose for those few frames — the eighth kill
 * of a blast shatters ~120 ms late, inside the explosion, and no one can see it.
 *
 * `beginFrame()` is ticked from GameEngine next to `boneVoxelLimbs.update`.
 * The clock is injectable so the policy is unit-tested without a browser.
 */

/** Shatter time a frame may spend before further shatters defer. */
export const SHATTER_FRAME_BUDGET_MS = 8;

export type ShatterJob = () => void;

export class ShatterScheduler {
    private spentMs = 0;
    private readonly queue: ShatterJob[] = [];

    constructor(private readonly now: () => number = () => performance.now()) {}

    /**
     * Run `job` now if this frame still has budget and nothing is already
     * waiting (order is kept), else queue it. Returns true when it ran.
     */
    runOrDefer(job: ShatterJob): boolean {
        if (this.queue.length > 0 || this.spentMs >= SHATTER_FRAME_BUDGET_MS) {
            this.queue.push(job);
            return false;
        }
        this.run(job);
        return true;
    }

    /** New frame: reset the budget, then drain what waited — one at least. */
    beginFrame(): void {
        this.spentMs = 0;
        let ran = 0;
        while (this.queue.length > 0 && (ran === 0 || this.spentMs < SHATTER_FRAME_BUDGET_MS)) {
            this.run(this.queue.shift()!);
            ran++;
        }
    }

    /** Jobs still waiting for a frame. */
    get pending(): number {
        return this.queue.length;
    }

    /** Drop everything queued (level unload). */
    clear(): void {
        this.queue.length = 0;
        this.spentMs = 0;
    }

    private run(job: ShatterJob): void {
        const t0 = this.now();
        try {
            job();
        } finally {
            this.spentMs += this.now() - t0;
        }
    }
}

/** The engine's one scheduler; GameEngine ticks `beginFrame()` each frame. */
export const shatterScheduler = new ShatterScheduler();
