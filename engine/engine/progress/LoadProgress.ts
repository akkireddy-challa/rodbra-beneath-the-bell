/**
 * LoadProgress — the engine's single source of truth for "how far along is
 * this game load", driving the determinate progress bar on the main screen
 * (StartScreen) and, before the engine UI exists, the static boot shell in
 * index.html (via `window.__bmBoot`).
 *
 * The load is modeled as a fixed sequence of WEIGHTED PHASES rather than a
 * count of tracked bytes: most of the boot cost (module parse, WASM init,
 * terrain build, GPU warmup) has no byte stream to measure, so per-phase
 * weights approximate real wall-clock shares and each phase may report a
 * fraction within itself where a cheap real signal exists (vwld/splat byte
 * streaming, env-object instance counts).
 *
 * Contract:
 *   - The overall fraction is MONOTONIC within one load — a late `beginPhase`
 *     for an earlier phase, or a within-phase fraction that regresses, can
 *     never move the bar backwards (users read a reversing bar as a hang).
 *   - Phases may be skipped: `beginPhase('assets')` after `physics` simply
 *     credits the skipped `genre`/`world` weight as done.
 *   - `reset()` starts a new load (the engine instance survives reloads) and
 *     is the only way the fraction returns to 0.
 *
 * Dependency-trivial on purpose (no engine imports beyond nothing): consumed
 * from GameTemplate, GameEngine and loaders without cycles, and testable under
 * the node jest environment (all `window` access is guarded).
 */

import { installLoadProfiler } from 'engine/LoadProfile.js';

/** Load phases in boot order. Weights below must list every id exactly once. */
export type LoadPhaseId = 'boot' | 'data' | 'physics' | 'genre' | 'world' | 'assets' | 'warmup';

/**
 * Phase weights — approximate wall-clock share of a typical game load.
 * Absolute values are arbitrary (normalized at use); only the ratios matter.
 *   boot    — engine bundle executed up to template init (the static shell
 *             trickles before this; this phase completes almost immediately)
 *   data    — game.json/world.json fetch + parse
 *   physics — Rapier WASM fetch + init
 *   genre   — genre module import
 *   world   — genreModule.load(): terrain/vwld fetch + build, splats
 *   assets  — environment objects (GLBs), NPC skeleton, audio preload
 *   warmup  — GPU warmup (shader compile + upload) in preloadLevel()
 */
export const LOAD_PHASE_WEIGHTS: Record<LoadPhaseId, number> = {
    boot: 5,
    data: 5,
    physics: 10,
    genre: 5,
    world: 40,
    assets: 25,
    warmup: 10,
};

export const LOAD_PHASE_ORDER: readonly LoadPhaseId[] = ['boot', 'data', 'physics', 'genre', 'world', 'assets', 'warmup'];

const TOTAL_WEIGHT = LOAD_PHASE_ORDER.reduce((sum, id) => sum + LOAD_PHASE_WEIGHTS[id], 0);

/**
 * Overall 0..1 fraction for "inside `phase`, `phaseFraction` of the way
 * through it" — completed earlier phases plus the weighted share of this one.
 * Pure; the monotonic guard lives in the tracker, not here.
 */
export function overallFraction(phase: LoadPhaseId, phaseFraction: number): number {
    const clamped = Math.min(1, Math.max(0, phaseFraction));
    let before = 0;
    for (const id of LOAD_PHASE_ORDER) {
        if (id === phase) {
            return (before + LOAD_PHASE_WEIGHTS[id] * clamped) / TOTAL_WEIGHT;
        }
        before += LOAD_PHASE_WEIGHTS[id];
    }
    // Unreachable with a valid LoadPhaseId; keep the math total-safe anyway.
    return Math.min(1, before / TOTAL_WEIGHT);
}

export interface LoadProgressSnapshot {
    /** Overall 0..1, monotonic within one load. */
    fraction: number;
    /** Current phase, or null before the first beginPhase / after complete(). */
    phase: LoadPhaseId | null;
    /** Human-readable label for the current step (already translated). */
    label: string;
}

export type LoadProgressListener = (snapshot: LoadProgressSnapshot) => void;

/** The static boot shell's hook (installed by inline script in index.html). */
interface BootShellHook {
    set?: (fraction: number, label?: string) => void;
    handoff?: () => void;
}

function bootShell(): BootShellHook | null {
    if (typeof window === 'undefined') return null;
    const hook = (window as unknown as { __bmBoot?: BootShellHook }).__bmBoot;
    return hook ?? null;
}

export class LoadProgressTracker {
    private fraction = 0;
    private phase: LoadPhaseId | null = null;
    private label = '';
    private listeners: LoadProgressListener[] = [];

    /** Start a fresh load. The ONLY path that moves the fraction backwards. */
    reset(): void {
        this.fraction = 0;
        this.phase = null;
        this.label = '';
        this.notify();
    }

    /**
     * Enter a phase (at its 0%). Entering a LATER phase implicitly completes
     * everything before it; entering an earlier/current one only updates the
     * label (monotonic guard swallows the would-be regression).
     */
    beginPhase(phase: LoadPhaseId, label?: string): void {
        this.phase = phase;
        if (label !== undefined) this.label = label;
        this.advanceTo(overallFraction(phase, 0));
    }

    /** Within-phase progress, 0..1 of the CURRENT phase. No-op before beginPhase. */
    setPhaseFraction(phaseFraction: number, label?: string): void {
        if (!this.phase) return;
        if (label !== undefined) this.label = label;
        this.advanceTo(overallFraction(this.phase, phaseFraction));
    }

    /** Convenience for count-based phases (`done`/`total` items). */
    reportItems(done: number, total: number, label?: string): void {
        if (total <= 0) return;
        this.setPhaseFraction(done / total, label);
    }

    /** Update only the label line (keeps the bar where it is). */
    setLabel(label: string): void {
        this.label = label;
        this.notify();
    }

    /** Jump to 100% (load finished; the bar hides when READY shows Play). */
    complete(): void {
        this.phase = null;
        this.advanceTo(1);
    }

    getSnapshot(): LoadProgressSnapshot {
        return { fraction: this.fraction, phase: this.phase, label: this.label };
    }

    addListener(listener: LoadProgressListener): void {
        this.listeners.push(listener);
        // Late subscribers (StartScreen rebuilt on game-data arrival) sync
        // immediately instead of waiting for the next phase boundary.
        try {
            listener(this.getSnapshot());
        } catch (error) {
            console.error('[LoadProgress] listener failed:', error);
        }
    }

    removeListener(listener: LoadProgressListener): void {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) this.listeners.splice(index, 1);
    }

    private advanceTo(fraction: number): void {
        // Monotonic within a load: regressions (out-of-order begins, resetting
        // byte counters) keep the bar still rather than moving it backwards.
        this.fraction = Math.max(this.fraction, Math.min(1, fraction));
        this.notify();
    }

    private notify(): void {
        const snapshot = this.getSnapshot();
        // Keep the static boot shell's bar in sync until StartScreen mounts and
        // calls handoff(); afterwards the hook is a no-op (shell removed).
        bootShell()?.set?.(snapshot.fraction, snapshot.label);
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch (error) {
                console.error('[LoadProgress] listener failed:', error);
            }
        }
    }
}

// Engine-wide singleton: one game load is in flight at a time (reloads reuse
// the tracker via reset()). Mirrors levelManagerRegistry's module-scope style.
const tracker = new LoadProgressTracker();

// `?profile=1` timings. Installed here rather than at a call site so the profiler sees
// EVERY phase — including the ones that run before whichever component would otherwise
// have imported it — and costs nothing when the flag is absent.
installLoadProfiler((fn) => tracker.addListener((snapshot: LoadProgressSnapshot) => fn(snapshot.phase)));

export function getLoadProgress(): LoadProgressTracker {
    return tracker;
}

/** Tell the static boot shell the engine UI now owns the screen (idempotent). */
export function handoffBootShell(): void {
    bootShell()?.handoff?.();
}

/**
 * Sub-signals inside the 'world' phase (genreModule.load()), mapped onto
 * fixed slices of it. The reporters live in shared engine loaders that ALSO
 * run outside a game load (runtime level switches, editor asset reloads), so
 * everything funnels through here: reports are dropped unless the tracker is
 * actually in the 'world' phase, and the slice mapping policy has exactly one
 * home. Slices overlap deliberately — the monotonic guard keeps the bar sane
 * when loaders race (splats and env objects load concurrently).
 */
const WORLD_SUB_SLICES: Record<WorldSubSignal, readonly [number, number]> = {
    // Baked terrain (.vwld) byte streaming — the first big fetch of a load.
    'terrain-fetch': [0, 0.3],
    // Gaussian splat byte streaming — dominates splat games' world load.
    'splat-fetch': [0.1, 0.8],
    // Environment object instances (GLBs/voxel assets) — the tail of the load.
    'objects': [0.35, 1],
};

export type WorldSubSignal = 'terrain-fetch' | 'splat-fetch' | 'objects';

export function reportWorldSubProgress(signal: WorldSubSignal, fraction: number, label?: string): void {
    if (tracker.getSnapshot().phase !== 'world') return;
    const [lo, hi] = WORLD_SUB_SLICES[signal];
    const clamped = Math.min(1, Math.max(0, fraction));
    tracker.setPhaseFraction(lo + (hi - lo) * clamped, label);
}
