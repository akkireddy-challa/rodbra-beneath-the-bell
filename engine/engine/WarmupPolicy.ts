/**
 * How much of the GPU warmup to run — the policy `GameEngine.warmUpScene` obeys.
 *
 * The warmup exists to pay a level's shader-compile and upload cost once, under the
 * loading screen, instead of one stutter at a time through the opening lap (see
 * `GameEngine.warmUpScene`). Every step that made it MORE thorough on desktop also made
 * the single pass more expensive, and thoroughness is exactly what a phone cannot
 * afford: it is one uninterruptible burst of work on the main thread and the GPU, and
 * iOS terminates a web process that stops responding for long enough. A desktop pays
 * a few seconds behind a fade; a phone can lose the tab.
 *
 * So the warmup is a POLICY rather than a fixed routine, and the expensive parts are
 * separable — the scene-wide un-cull, the empty-bucket reveal, and the async
 * pre-compile each multiply the work independently of the others.
 *
 * The modes form a ladder from most to least work, so a device that dies somewhere on
 * it identifies WHICH part is fatal rather than just "the warmup":
 *
 *   full       everything (desktop default)
 *   nocompile  drop the async pre-compile; still warms the whole scene by drawing it
 *   culled     pre-compile + warm frame, but only what the camera can actually see
 *   light      one ordinary frame, nothing extra (mobile default)
 *   off        no warmup at all
 *
 * `light` is the mobile default because it is the rung a real iPhone was VERIFIED to
 * survive (2026-08-11: every published game was dying mid-load on iOS, at every rung
 * above it, with terrain memory ruled out as a cause). Treat it as a floor, not a
 * preference — do not raise the mobile default without re-testing on a device.
 *
 * ⚠ It carries a known cost: mobile gets no real warmup, so the first-visit shader
 * stutter the warmup exists to prevent is back on phones. The fix for THAT is not a
 * higher rung, it is a warmup that never blocks for long. The pre-compile IS now
 * sliced — `GameEngineWarmup.warmUpSceneNow` runs `compileAsync(root, camera, scene)`
 * per subtree with a paint between slices (added for load-progress reporting, but it
 * also bounds each compile burst) — yet the warm FRAME is still one uninterruptible
 * burst, and `light` draws that frame, so raising the mobile default remains a
 * device-verified decision, not a code one. Until someone re-tests on a real iPhone,
 * `light` is what ships.
 *
 * Select per-load with `?warmup=<mode>`; a published bundle is frozen, so without the
 * override every experiment costs a republish.
 */

/** One rung of the warmup ladder. */
export type WarmupMode = 'full' | 'nocompile' | 'culled' | 'light' | 'off';

/** What a mode actually switches on. */
export interface WarmupPolicy {
    /**
     * `renderer.compileAsync(scene, camera)` before the frame. Prewarms shader-module
     * translation for the whole scene — but only the WebGPU backend compiles pipelines
     * off-thread; everywhere else the "async" call links every program synchronously.
     */
    compile: boolean;
    /**
     * Clear `frustumCulled` scene-wide, so the pass covers geometry the warmup camera
     * cannot see. This is what makes the warmup complete — and what makes its single
     * frame draw the ENTIRE level (every LOD, every shadow caster) instead of one
     * viewport's worth.
     */
    uncullScene: boolean;
    /**
     * Give every count-0 `InstancedMesh` one instance so its pipeline is built. Those
     * buckets are invisible to both the compile and the frame otherwise, and per-frame
     * culling packs them as the player moves — i.e. their pipelines would compile
     * during gameplay. Adds draw calls and pipeline variants to the warm frame.
     */
    revealEmptyInstanced: boolean;
    /** Draw the one warm frame. Without it nothing is uploaded and no pipeline is real. */
    frame: boolean;
}

const POLICIES: Readonly<Record<WarmupMode, WarmupPolicy>> = {
    full: { compile: true, uncullScene: true, revealEmptyInstanced: true, frame: true },
    nocompile: { compile: false, uncullScene: true, revealEmptyInstanced: true, frame: true },
    culled: { compile: true, uncullScene: false, revealEmptyInstanced: false, frame: true },
    light: { compile: false, uncullScene: false, revealEmptyInstanced: false, frame: true },
    off: { compile: false, uncullScene: false, revealEmptyInstanced: false, frame: false },
};

/** The steps `mode` switches on. */
export function warmupPolicyFor(mode: WarmupMode): WarmupPolicy {
    return POLICIES[mode];
}

/** Whether `value` names a mode (narrowing, so callers need no cast). */
export function isWarmupMode(value: string): value is WarmupMode {
    return Object.prototype.hasOwnProperty.call(POLICIES, value);
}

/**
 * The mode this load runs: `?warmup=<mode>` when it names one, else `fallback` — the
 * device quality tier's answer. An unrecognised value falls back rather than throwing — a
 * typo in a URL being handed round for device testing must not be the thing that breaks
 * the load.
 *
 * The mobile ceiling of `light` is no longer expressed here; it is a device FLOOR in
 * `DeviceQuality.clampPolicyToDevice`, so no rung — and no player pinning one — can raise
 * a phone above it. The 2026-08-11 verification paragraph above is why.
 */
export function resolveWarmupMode(fallback: WarmupMode): WarmupMode {
    try {
        const raw = new URLSearchParams(window.location.search).get('warmup');
        if (raw !== null && isWarmupMode(raw)) return raw;
    } catch {
        // No window/location (tests, workers) — the platform default stands.
    }
    return fallback;
}
