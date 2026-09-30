// The observer inside a hidden automatic play test (?playtest=1). The page
// autostarts gameplay with no input — like the GDK's `bitmagic verify` — and
// this probe watches it: runtime errors, whether the engine keeps rendering,
// whether the player falls out of the world, and what the screen shows. It
// posts one PLAYTEST_REPORT to the Creator (useVerificationRound) and stops.
// See game/docs/playtest-mode.md.

import { ConsoleCapture } from 'engine/ConsoleCapture.js';
import type { GameEngine } from 'engine/GameEngine.js';
import { getGameStateManager } from 'engine/GameStateManager.js';
import { collectNewErrors, type ForwardedRuntimeError } from 'engine/RuntimeErrorForwarder.js';
import { PLAYTEST_TAG } from 'engine/playtest/PlaytestGuard.js';
import {
    classifyPlaytest,
    frameStats,
    hasSettled,
    summarizeEvents,
    PLAYTEST_POLL_MS,
    PLAYTEST_SETTLE,
    type FrameStats,
    type PlaytestEvents,
    type PlaytestFinding,
    type PlaytestSample,
    type PlaytestVerdict,
} from 'engine/playtest/playtestClassify.js';

/** Loading a big world can take a while; past this the game "never started". */
const START_DEADLINE_MS = 45_000;
const CAPTURE_WIDTH = 480;
const CAPTURE_HEIGHT = 270;
/** Logged by PlayerController when the fall rescue respawns the player. */
const RESPAWN_MARKER = 'Fell below';

export interface PlaytestReport {
    outcome: PlaytestVerdict['outcome'];
    failures: PlaytestFinding[];
    warnings: PlaytestFinding[];
    errors: ForwardedRuntimeError[];
    /** JPEG data URL of the end-of-test frame, null when it could not be captured. */
    screenshot: string | null;
    playedSeconds: number;
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function gameErrors(capture: ConsoleCapture): ForwardedRuntimeError[] {
    return collectNewErrors(capture.getMessages(), new Map())
        .filter(error => !error.message.includes(PLAYTEST_TAG));
}

function countErrors(errors: readonly ForwardedRuntimeError[]): number {
    return errors.reduce((sum, error) => sum + error.count, 0);
}

function playerY(engine: GameEngine): number | null {
    const player = engine.getCurrentPlayer() as { getPosition?: () => { y?: unknown }; player?: { position?: { y?: unknown } } } | null;
    const position = typeof player?.getPosition === 'function' ? player.getPosition() : player?.player?.position;
    const y = position?.y;
    return typeof y === 'number' && Number.isFinite(y) ? y : null;
}

/** Render once and read the frame back while the drawing buffer is still valid. */
function captureFrame(engine: GameEngine): { stats: FrameStats; dataUrl: string } | null {
    const { renderer, scene, camera } = engine;
    if (!renderer || !scene || !camera) return null;
    try {
        renderer.render(scene, camera);
        const canvas = document.createElement('canvas');
        canvas.width = CAPTURE_WIDTH;
        canvas.height = CAPTURE_HEIGHT;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(renderer.domElement, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);
        const pixels = ctx.getImageData(0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT).data;
        return { stats: frameStats(pixels, CAPTURE_WIDTH, CAPTURE_HEIGHT), dataUrl: canvas.toDataURL('image/jpeg', 0.8) };
    } catch (error) {
        console.warn(`${PLAYTEST_TAG} frame capture failed:`, error);
        return null;
    }
}

function readEvents(): PlaytestEvents | null {
    const debug = (window as unknown as { __bmDebug?: { getEvents?: () => unknown } }).__bmDebug;
    const events = debug?.getEvents?.();
    if (!Array.isArray(events)) return null;
    return summarizeEvents(events.filter((event): event is { frame: number; type: string } =>
        typeof event?.frame === 'number' && typeof event?.type === 'string'));
}

function postReport(report: PlaytestReport): void {
    if (window.parent === window) {
        console.log(`${PLAYTEST_TAG} report`, report);
        return;
    }
    window.parent.postMessage({ type: 'PLAYTEST_REPORT', data: report }, '*');
}

/**
 * Watch the play test and report once. `getEngine` is GameTemplate's live
 * engine reference (null until the world has loaded).
 */
export async function runPlaytestProbe(getEngine: () => GameEngine | null): Promise<void> {
    const capture = ConsoleCapture.getInstance();
    capture.start();

    let respawns = 0;
    const realLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
        realLog(...args);
        if (typeof args[0] === 'string' && args[0].includes(RESPAWN_MARKER)) respawns++;
    };

    let rafCount = 0;
    const tick = () => {
        rafCount++;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const stateManager = getGameStateManager();
    const pageStart = performance.now();
    while (!stateManager.hasStarted() && performance.now() - pageStart < START_DEADLINE_MS) {
        await wait(PLAYTEST_POLL_MS);
    }
    const started = stateManager.hasStarted();
    const errorsBeforeStart = countErrors(gameErrors(capture));

    const samples: PlaytestSample[] = [];
    const playStart = performance.now();
    while (started) {
        await wait(PLAYTEST_POLL_MS);
        const engine = getEngine();
        samples.push({
            atMs: performance.now() - playStart,
            rafCount,
            engineFrames: engine ? engine.getRenderedFrameCount() : null,
            gameState: stateManager.getCurrentState(),
            playerY: engine ? playerY(engine) : null,
            errorCount: countErrors(gameErrors(capture)),
            respawnCount: respawns,
        });
        if (hasSettled(samples) || (samples[samples.length - 1]?.atMs ?? 0) >= PLAYTEST_SETTLE.maxSettleMs) break;
    }

    const engine = getEngine();
    const frame = started && engine ? captureFrame(engine) : null;
    const verdict = classifyPlaytest({
        started,
        errorsBeforeStart,
        samples,
        frame: frame?.stats ?? null,
        events: started ? readEvents() : null,
    });
    const errors = gameErrors(capture);
    // Errors are failures too: a clean-looking frame over a throwing update loop is not a pass.
    const outcome = verdict.outcome === 'passed' && errors.length > 0 ? 'failed' : verdict.outcome;

    postReport({
        outcome,
        failures: verdict.failures,
        warnings: verdict.warnings,
        errors,
        screenshot: frame?.dataUrl ?? null,
        playedSeconds: Math.round((samples[samples.length - 1]?.atMs ?? 0) / 100) / 10,
    });
}
