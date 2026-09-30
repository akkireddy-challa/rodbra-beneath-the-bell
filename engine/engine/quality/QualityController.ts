/**
 * The engine-side owner of automatic quality adaptation: feeds the sampler, asks the tuner,
 * applies what it decides, persists the conclusion, and tells the player once.
 *
 * Everything with a rule in it lives elsewhere and is pure — `FrameBudgetSampler`
 * accumulates, `QualityAutoTune` decides, `DeviceQualityApply` applies. This class is the
 * wiring. Controller tests feed real frame windows and stub the GPU draw/application edges.
 *
 * WHEN IT IS OFF, and why each case matters:
 *
 *  - `?quality=` or a player pin. A run that exists to TEST a rung must not rewrite the
 *    value the device uses afterwards — the same rule `noteLevelLoadStarted` follows for
 *    `?lod=` — and a player who chose a rung has said what they want.
 *  - The Creator. An editor session's frame times are meaningless: panels, gizmos, a paused
 *    30 fps interval, and a scene being edited under it. Auto-degrading a creator's preview
 *    would be a bug report, not a feature.
 *  - `?autotune=0`, which still measures and logs but changes nothing.
 *
 * THE CRASH INTERLOCK. `LevelDetail`'s one-strike downgrade and this loop are two
 * independent automatic mechanisms that both lower quality, and they must not compound. The
 * composition itself is a MAX inside `resolveLevelDetail`; the other half is here — when a
 * crash rescue fired on this boot, this loop spends less. It skips the diagnostic probe,
 * halves its session budget, and doubles its grace. The reasoning is the same one
 * behind `DOWNGRADE_STEPS = 2`: the rescue has already been spent, and dropping again on the
 * first bad six seconds afterwards would be spending the last life on a guess.
 */

import type * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';
import { isCreatorMode } from 'engine/CreatorMode.js';
import {
    activeDeviceQualityTier, activeDeviceSignature, deviceQualitySource,
    setAutoDeviceTier, readAutoDeviceTier, qualityPreferenceEpoch,
    stepTier, type DeviceQualityTier,
} from 'engine/DeviceQuality.js';
import { applyDeviceTierLive } from 'engine/quality/DeviceQualityApply.js';
import { FrameBudgetSampler, type RendererCounters } from 'engine/quality/FrameBudgetSampler.js';
import {
    evaluateWindow, initialAutoTuneState, DEFAULT_AUTO_TUNE,
    type AutoTuneConfig, type AutoTuneState,
} from 'engine/quality/QualityAutoTune.js';
import { runGpuProbe } from 'engine/quality/DeviceGpuProbe.js';

/** Why the tier changed — decides what, if anything, the player is told. */
export type TierChangeReason = 'probe' | 'measure' | 'crash';

export type TierChangeListener = (tier: DeviceQualityTier, reason: TierChangeReason) => void;

/** Discard startup/return frames before anchoring a fresh gameplay window and grace period. */
export const QUALITY_SETTLE_FRAMES = 4;

/** What `window.__bmDebug.getRenderStats()` reports: the renderer's counters after the last frame. */
export interface RenderStatsDebugInfo {
    /**
     * Visible meshes in the scene — each is at least one draw call per pass, and unlike the
     * renderer's own counter it does not read 0 when sampled between a frame's reset and render.
     */
    visibleMeshes: number;
    /** Of those, InstancedMeshes (one draw call however many instances). */
    instancedMeshes: number;
    drawCalls: number;
    triangles: number;
    geometries: number;
    textures: number;
}

/** What `?tierlog=1` and `window.__bmDebug.getQuality()` report. */
export interface QualityDebugInfo {
    tier: DeviceQualityTier;
    source: string;
    adapting: boolean;
    downgradesUsed: number;
    lastWindowFps: number | null;
    probeMsPerFrame: number | null;
}

function urlFlag(name: string): string | null {
    try {
        return new URLSearchParams(window.location.search).get(name);
    } catch {
        return null;
    }
}

/**
 * The controller of the live engine, for observers that must not import `GameEngine`.
 *
 * Same shape as `EnvironmentObjectSystem`'s active-system reference and for the same
 * reason: `BmDebug` is installed at module level, before any engine exists, so it needs to
 * ASK for the current one rather than hold it.
 */
let activeController: QualityController | null = null;

/** The live session's controller, or null before an engine exists. */
export function getActiveQualityController(): QualityController | null {
    return activeController;
}

export class QualityController {
    private readonly cfg: AutoTuneConfig;
    private readonly sampler: FrameBudgetSampler;
    private state: AutoTuneState | null = null;
    private readonly listeners: TierChangeListener[] = [];
    /** Context/URL gates are fixed; the player's choice is checked live. */
    private readonly enabledInContext: boolean;
    private readonly measureOnly: boolean;
    private preferenceEpoch = qualityPreferenceEpoch();
    /** One diagnostic probe; only gameplay may lower quality. */
    private probeAttempted = false;
    private probeInFlight = false;
    private readonly log: boolean;
    /** A crash rescue already fired this boot, so this loop spends less. */
    private readonly crashRescued: boolean;
    /** A tier change that happened before any listener existed. See `onTierChanged`. */
    private pendingAnnouncement: { tier: DeviceQualityTier; reason: TierChangeReason } | null = null;
    /** One toast per session: a game that keeps announcing its own degradation reads worse. */
    private announced = false;
    private lastWindowFps: number | null = null;
    private probeMsPerFrame: number | null = null;
    private settleFrames = QUALITY_SETTLE_FRAMES;
    private needsGameplayGrace = true;
    private readonly counters: RendererCounters = { programs: 0, geometries: 0, textures: 0 };

    constructor(private readonly engine: GameEngine, crashRescued: boolean) {
        const autotune = urlFlag('autotune');
        // `?autotune=0` measures and logs but never acts, which is how a rung is observed
        // under load without the loop moving it out from under the observation.
        this.measureOnly = autotune === '0';
        this.enabledInContext = (!isCreatorMode || autotune === '1') && !this.measureOnly
            && deviceQualitySource() !== 'url';
        this.log = urlFlag('tierlog') === '1';
        this.crashRescued = crashRescued;
        this.cfg = crashRescued
            ? {
                ...DEFAULT_AUTO_TUNE,
                maxDowngradesPerSession: Math.max(1, Math.floor(DEFAULT_AUTO_TUNE.maxDowngradesPerSession / 2)),
                graceMs: DEFAULT_AUTO_TUNE.graceMs * 2,
            }
            : DEFAULT_AUTO_TUNE;
        this.sampler = new FrameBudgetSampler(this.cfg.windowMs);
        if (crashRescued) {
            this.pendingAnnouncement = { tier: activeDeviceQualityTier(), reason: 'crash' };
        }
        activeController = this;
    }

    private get acting(): boolean {
        const source = deviceQualitySource();
        return this.enabledInContext && source !== 'url' && source !== 'pinned';
    }

    /** Loading, menus and held renders are not gameplay performance evidence. */
    private isGameplayReady(): boolean {
        const engine = this.engine;
        return engine['gameLoadComplete'] && engine['renderActive'] && engine['isGameplayRunning']()
            && !engine['warmupCompileInFlight'] && !engine['levelManager']?.isLoading();
    }

    onTierChanged(cb: TierChangeListener): void {
        this.listeners.push(cb);
        // A crash rescue happens during BOOT, long before anything has a HUD to show a
        // toast on, so its announcement waits here for the first listener. Without this
        // the rescue lowered the player's quality and never said so — which is the exact
        // failure `applyPendingDowngrade` returns its tier to prevent ("the game silently
        // looking worse after a crash reads as a broken game rather than a rescue").
        const pending = this.pendingAnnouncement;
        if (pending) {
            this.pendingAnnouncement = null;
            this.announce(pending.tier, pending.reason);
        }
    }

    /**
     * Mark whatever window is in flight as not the device's fault.
     *
     * Called from the level load, respawn, resize, tab-return and pause paths — and by this
     * class itself after every change it applies, so the loop measures the RESULT of its
     * action rather than the frame it changed the pixel ratio on.
     */
    noteDisturbance(reason: string): void {
        this.sampler.noteDisturbance();
        if (this.log) console.debug(`[DeviceQuality] disturbance: ${reason}`);
    }

    /** Drop stale evidence; preserve the session budget and any remaining cooldown. */
    resetSampling(): void {
        this.sampler.reset();
        this.settleFrames = QUALITY_SETTLE_FRAMES;
        this.needsGameplayGrace = true;
        this.lastWindowFps = null;
        if (this.state?.consecutiveBad) this.state = { ...this.state, consecutiveBad: 0 };
    }

    /**
     * Probe once for diagnostics when no valid automatic conclusion exists. Loading-time
     * measurements never change or persist a tier; only sustained gameplay may do that.
     *
     * Skipped after a crash rescue to avoid extra loading work on a struggling device.
     */
    async runProbe(renderer: THREE.WebGLRenderer): Promise<void> {
        if (!this.acting || this.crashRescued || this.probeAttempted
            || (this.state?.downgradesUsed ?? 0) > 0
            || (deviceQualitySource() === 'auto' && readAutoDeviceTier(activeDeviceSignature()) !== null)) return;
        this.probeAttempted = true;
        this.probeInFlight = true;
        const preferenceEpoch = qualityPreferenceEpoch();
        const from = activeDeviceQualityTier();
        try {
            const result = await runGpuProbe(renderer, () => this.engine.renderFrameNow(), from);
            if (!result) return;
            // A preference change while waiting for the GPU invalidates the measurement,
            // including a quick pin → Auto round trip that ends on the same rung.
            if (!this.acting || qualityPreferenceEpoch() !== preferenceEpoch
                || activeDeviceQualityTier() !== from) return;
            this.probeMsPerFrame = result.msPerFrame;
        } finally {
            this.probeInFlight = false;
            this.resetSampling();
        }
    }

    /**
     * One rendered frame. Called unconditionally from `GameEngine.animate`, so it does
     * arithmetic on numbers already computed there and nothing else.
     */
    recordFrame(nowMs: number, gapMs: number, busyMs: number, renderMs: number): void {
        const preferenceEpoch = qualityPreferenceEpoch();
        if (this.preferenceEpoch !== preferenceEpoch) {
            this.preferenceEpoch = preferenceEpoch;
            this.resetSampling();
            this.lastWindowFps = null;
            this.state = {
                consecutiveBad: 0,
                quietUntilMs: Math.max(this.state?.quietUntilMs ?? 0, nowMs + this.cfg.graceMs),
                downgradesUsed: this.state?.downgradesUsed ?? 0,
            };
        }
        if ((!this.acting && !this.measureOnly) || this.probeInFlight
            || !this.isGameplayReady()) {
            this.resetSampling();
            return;
        }
        if (this.settleFrames > 0) {
            this.settleFrames--;
            return;
        }
        if (this.needsGameplayGrace) {
            this.needsGameplayGrace = false;
            const state = this.state ?? initialAutoTuneState(nowMs, this.cfg);
            this.state = {
                ...state,
                consecutiveBad: 0,
                quietUntilMs: Math.max(state.quietUntilMs, nowMs + this.cfg.graceMs),
            };
        }
        const renderer = this.engine['renderer'];
        if (!renderer) return;
        const info = renderer.info;
        // WebGPU (including its WebGL fallback) exposes a numeric memory counter;
        // classic WebGL exposes the program array on info itself.
        this.counters.programs = 'programs' in info.memory && typeof info.memory.programs === 'number'
            ? info.memory.programs : info.programs?.length ?? 0;
        this.counters.geometries = info.memory.geometries;
        this.counters.textures = info.memory.textures;

        const win = this.sampler.recordFrame(
            nowMs, gapMs, busyMs, renderMs, this.engine.getTargetFps(), this.counters,
        );
        if (!win) return;

        this.state ??= initialAutoTuneState(win.startMs, this.cfg);
        this.lastWindowFps = win.renderedFrames / ((win.endMs - win.startMs) / 1000);
        const { next, decision } = evaluateWindow(this.state, win, this.cfg);
        this.state = next;

        if (this.log) {
            console.debug(
                `[DeviceQuality] window ${this.lastWindowFps.toFixed(1)}fps/${win.targetFps} ` +
                `dropped=${win.droppedFrames} prog=${win.programDelta} geo=${win.geometryDelta} ` +
                `tex=${win.textureDelta} disturbed=${win.disturbed} → ${decision.kind}` +
                (decision.kind === 'none' ? '' : `(${decision.why})`),
            );
        }
        if (decision.kind !== 'downgrade' || !this.acting) return;

        const from = activeDeviceQualityTier();
        const to = stepTier(from, -1);
        if (to === from) return; // already at the bottom; nothing left to shed
        console.warn(`[DeviceQuality] lowering ${from} → ${to}: ${decision.why}`);
        this.adopt(to, 'measure');
    }

    /** Apply, persist and announce a new rung. */
    private adopt(tier: DeviceQualityTier, reason: TierChangeReason): void {
        applyDeviceTierLive(this.engine, tier, 'auto');
        setAutoDeviceTier(tier, reason, activeDeviceSignature());
        // Measure the result of the change, not the frame it landed on.
        this.noteDisturbance(`tier → ${tier}`);
        this.announce(tier, reason);
    }

    /**
     * Tell the player, at most once a session.
     *
     * Diagnostic probes never announce a quality change. A second gameplay change updates
     * the settings row silently, because a game that keeps
     * announcing its own degradation reads worse than one that quietly settles.
     */
    private announce(tier: DeviceQualityTier, reason: TierChangeReason): void {
        if (reason === 'probe' || this.announced) return;
        if (this.listeners.length === 0) {
            this.pendingAnnouncement = { tier, reason };
            return;
        }
        this.announced = true;
        for (const cb of this.listeners) {
            try {
                cb(tier, reason);
            } catch (err) {
                console.warn('[DeviceQuality] tier-change listener threw:', err);
            }
        }
    }

    /**
     * The renderer's own counters for the last rendered frame — how a scene's draw-call cost is
     * measured from outside (e.g. GLB instancing, headless play tests). Null before a renderer exists.
     */
    renderStats(): RenderStatsDebugInfo | null {
        const renderer = this.engine['renderer'];
        if (!renderer) return null;
        const render = renderer.info.render as { calls?: number; drawCalls?: number; triangles: number };
        let visibleMeshes = 0;
        let instancedMeshes = 0;
        this.engine.scene?.traverseVisible((o) => {
            if (!(o as THREE.Mesh).isMesh) return;
            visibleMeshes++;
            if ((o as THREE.InstancedMesh).isInstancedMesh) instancedMeshes++;
        });
        return {
            visibleMeshes,
            instancedMeshes,
            drawCalls: render.drawCalls ?? render.calls ?? 0,
            triangles: render.triangles,
            geometries: renderer.info.memory.geometries,
            textures: renderer.info.memory.textures,
        };
    }

    /** Read-only snapshot for `window.__bmDebug` and QA. */
    debugInfo(): QualityDebugInfo {
        return {
            tier: activeDeviceQualityTier(),
            source: deviceQualitySource(),
            adapting: this.acting,
            downgradesUsed: this.state?.downgradesUsed ?? 0,
            lastWindowFps: this.lastWindowFps,
            probeMsPerFrame: this.probeMsPerFrame,
        };
    }
}
