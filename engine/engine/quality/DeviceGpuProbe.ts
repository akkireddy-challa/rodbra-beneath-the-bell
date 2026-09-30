/**
 * Measure how long this device actually takes to draw this scene, once, under the loading
 * screen — the one moment in a session when that number is knowable.
 *
 * THE PROBLEM IT SOLVES. The render loop caps at 60 fps, so during gameplay a device that
 * renders a frame in 4 ms and one that renders it in 16 ms report the same frame time. That
 * makes the in-play sampler a one-way instrument: it can see a device falling behind, but
 * it can never see headroom, and so it can never justify raising a rung. The cap is applied
 * only by the rAF loop, though — the warmup path draws frames back to back with nothing
 * throttling them. Measuring there gives an uncapped number: 4 ms reads as 4, 16 reads 16.
 *
 * WHAT IT IS HONESTLY MEASURING:
 *
 *  - Render only. No physics, no NPC ticks, no AI, no gameplay. The real frame is dearer.
 *  - A cold device. Nothing has thermally throttled yet, so this is the best the device
 *    will ever look.
 *  - One view — wherever the player spawns. A denser part of the level costs more.
 *
 * This is diagnostic data only. Loading and first-draw work can contaminate a short probe,
 * so QualityController never applies or persists its suggested rung. Automatic reductions
 * require sustained gameplay windows after loading, settling frames and startup grace.
 *
 * Cost: a dozen frames inside a load that already takes seconds, and the result is about
 * THIS scene on THIS device rather than a guess from a user-agent string.
 */

import type * as THREE from 'three';
import {
    stepTier, type DeviceQualityTier,
} from 'engine/DeviceQuality.js';

/** Frames drawn but thrown away — they still pay first-draw and cache-warm costs. */
const DISCARD_FRAMES = 4;
/** Frames actually timed. */
const MEASURE_FRAMES = 8;

/**
 * Render budget against the 16.67 ms frame interval.
 *
 * Roughly 40% of the budget is reserved for everything the probe does not draw — physics,
 * AI, animation, gameplay — so ~9 ms of pure render is the point where a full frame stops
 * fitting. The suggested rung is diagnostic only, never an automatic correction.
 */
const PROBE_RENDER_BUDGET_MS = 9;

/** What the probe saw. `null` where it could not run at all. */
export interface GpuProbeResult {
    msPerFrame: number;
    /** The rung the measurement alone would choose, before combining with the guess. */
    tier: DeviceQualityTier;
}

/** Diagnostic suggestion only: at most one step down, never Low → Minimal. */
export function probeTier(msPerFrame: number, from: DeviceQualityTier): DeviceQualityTier {
    if (!Number.isFinite(msPerFrame) || msPerFrame < PROBE_RENDER_BUDGET_MS
        || from === 'low' || from === 'minimal') return from;
    return stepTier(from, -1);
}

/** `?tierprobe=0` skips the probe entirely. */
function probeEnabled(): boolean {
    try {
        return new URLSearchParams(window.location.search).get('tierprobe') !== '0';
    } catch {
        return false; // no window (tests, workers) — nothing to probe
    }
}

/**
 * Wait for the GPU to finish what was submitted, so the wall clock measures drawing rather
 * than the speed of the submit queue.
 *
 * Best-effort by design: on WebGPU the device's submitted-work promise is the right answer,
 * on classic WebGL a `finish()` is, and where neither is reachable the number degrades to
 * submit throughput — which still separates a catastrophic device from a healthy one, and
 * is the same information the probe would otherwise have had none of.
 */
async function waitForGpu(renderer: THREE.WebGLRenderer): Promise<void> {
    const backend = (renderer as unknown as {
        backend?: { device?: { queue?: { onSubmittedWorkDone?: () => Promise<void> } } };
    }).backend;
    const done = backend?.device?.queue?.onSubmittedWorkDone;
    if (typeof done === 'function') {
        try {
            await done.call(backend!.device!.queue);
            return;
        } catch {
            // Fall through: a lost device is not the probe's problem to report.
        }
    }
    const gl = (renderer as unknown as { getContext?: () => WebGL2RenderingContext | null }).getContext?.();
    try {
        gl?.finish();
    } catch {
        /* context gone */
    }
}

/**
 * Draw the current scene a dozen times and report the per-frame cost.
 *
 * `render` must be the SAME path the frame loop uses (`GameEngine.renderFrameNow`), not a
 * bespoke draw — otherwise the pipelines it warms are keyed differently from the ones
 * gameplay will use, and the probe both measures the wrong thing and leaves a compile stall
 * behind for the player to hit.
 *
 * Returns null when the probe is disabled or could not produce a usable number; the caller
 * then simply keeps the static guess.
 */
export async function runGpuProbe(
    renderer: THREE.WebGLRenderer,
    render: () => void,
    from: DeviceQualityTier,
    now: () => number = () => performance.now(),
): Promise<GpuProbeResult | null> {
    if (!probeEnabled()) return null;
    try {
        for (let i = 0; i < DISCARD_FRAMES; i++) render();
        await waitForGpu(renderer);

        const start = now();
        for (let i = 0; i < MEASURE_FRAMES; i++) render();
        await waitForGpu(renderer);
        const elapsed = now() - start;

        if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
        const msPerFrame = elapsed / MEASURE_FRAMES;
        const tier = probeTier(msPerFrame, from);
        console.log(`[DeviceQuality] GPU probe: ${msPerFrame.toFixed(1)}ms/frame (diagnostic only; suggested ${tier}, current ${from})`);
        return { msPerFrame, tier };
    } catch (err) {
        // A probe that throws must never be the reason a level fails to load.
        console.warn('[DeviceQuality] GPU probe failed (keeping the current tier):', err);
        return null;
    }
}
