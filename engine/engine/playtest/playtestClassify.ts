// Pure verdict logic for the in-browser play test (PlaytestProbe). The settle
// rule and thresholds are ported from the GDK's `bitmagic verify`
// (cli/src/verify/settle.ts, classify.ts) so both lanes judge a game the same
// way; change one, check the other.

/** One poll of the running page, taken every PLAYTEST_POLL_MS once gameplay starts. */
export interface PlaytestSample {
    /** ms since gameplay started. */
    atMs: number;
    /** requestAnimationFrame ticks — does the BROWSER still run this page. */
    rafCount: number;
    /** GameEngine.getRenderedFrameCount(), null when unobservable. */
    engineFrames: number | null;
    /** GameStateManager state ('playing', 'paused', 'end', …), null when unobservable. */
    gameState: string | null;
    /** Player world-Y, null without a player. */
    playerY: number | null;
    /** Runtime errors seen so far (monotonic). */
    errorCount: number;
    /** "Fell below …, respawning" lines seen so far (monotonic). */
    respawnCount: number;
}

export const PLAYTEST_POLL_MS = 500;

/** Mirrors DEFAULT_SETTLE_CONFIG in cli/src/verify/settle.ts. */
export const PLAYTEST_SETTLE = {
    minSettleMs: 4_000,
    minFrames: 90,
    quietMs: 1_500,
    maxSettleMs: 15_000,
} as const;

const FREEFALL_DROP_PER_SAMPLE = 2;
const FREEFALL_SAMPLES = 3;
/** More respawns than this in one short test is a world with no floor, not bad luck. */
const MAX_RESPAWNS = 2;
const STILL_FALLING_BELOW_Y = -50;
const BLACK_LIT_FRACTION = 0.005;
const FLAT_DISTINCT_COLORS = 3;
const EARLY_DEATHS = 3;
const EARLY_MATCH_END_SECONDS = 5;

/** The player is in sustained freefall at the end of `samples`. */
export function isFreefalling(samples: readonly PlaytestSample[]): boolean {
    const positioned = samples.filter(sample => sample.playerY !== null);
    if (positioned.length < FREEFALL_SAMPLES + 1) return false;
    const tail = positioned.slice(-(FREEFALL_SAMPLES + 1));
    for (let i = 1; i < tail.length; i++) {
        const before = tail[i - 1]?.playerY;
        const after = tail[i]?.playerY;
        if (before == null || after == null || before - after < FREEFALL_DROP_PER_SAMPLE) return false;
    }
    return true;
}

/** True once the game has run long enough, steadily enough, to judge. */
export function hasSettled(samples: readonly PlaytestSample[]): boolean {
    const latest = samples[samples.length - 1];
    if (!latest || latest.atMs < PLAYTEST_SETTLE.minSettleMs) return false;
    if (latest.gameState !== null && latest.gameState !== 'playing' && latest.gameState !== 'end') return false;
    const frames = latest.engineFrames ?? latest.rafCount;
    if (frames < PLAYTEST_SETTLE.minFrames) return false;

    const quiet = samples.filter(sample => sample.atMs >= latest.atMs - PLAYTEST_SETTLE.quietMs);
    const earliest = quiet[0];
    if (!earliest || earliest === latest) return false;
    if (quiet.some(sample => sample.errorCount !== latest.errorCount || sample.respawnCount !== latest.respawnCount)) {
        return false;
    }
    const earliestFrames = earliest.engineFrames ?? earliest.rafCount;
    if (frames <= earliestFrames) return false;
    return !isFreefalling(samples);
}

/** Pixel statistics of the end-of-test frame (see PlaytestProbe.captureFrame). */
export interface FrameStats {
    /** Share of sampled pixels with any channel above 4. */
    litFraction: number;
    /** Distinct colours, bucketed to 5 bits per channel. */
    distinctColors: number;
}

export interface PlaytestEvents {
    /** Deaths in the first 10 s of gameplay. */
    earlyDeaths: number;
    /** Gameplay seconds of the first match-end, or null. */
    matchEndAtSeconds: number | null;
}

export interface PlaytestObservations {
    /** Gameplay started (the engine reached 'playing' at least once). */
    started: boolean;
    /** Runtime errors seen before gameplay started (a load or start that threw). */
    errorsBeforeStart: number;
    /** Samples from gameplay start to the end of the test. */
    samples: readonly PlaytestSample[];
    /** Null when the frame could not be captured. */
    frame: FrameStats | null;
    events: PlaytestEvents | null;
}

export type PlaytestFailureCode =
    | 'never_started'
    | 'start_threw'
    | 'frame_black'
    | 'frame_flat'
    | 'fell_out_of_world'
    | 'render_stalled';

export interface PlaytestFinding {
    code: string;
    message: string;
}

export interface PlaytestVerdict {
    outcome: 'passed' | 'failed' | 'inconclusive';
    failures: PlaytestFinding[];
    warnings: PlaytestFinding[];
}

/** Frames advanced over the last second, for the given counter. */
function recentProgress(samples: readonly PlaytestSample[], key: 'rafCount' | 'engineFrames'): number | null {
    const latest = samples[samples.length - 1];
    if (!latest) return null;
    const earlier = [...samples].reverse().find(sample => sample.atMs <= latest.atMs - 1_000);
    if (!earlier) return null;
    const now = latest[key];
    const then = earlier[key];
    if (now === null || then === null) return null;
    return now - then;
}

/**
 * The verdict. Only clear failures fail the test — the automatic fix acts on
 * them. Softer signals are warnings the user sees but the agent is not sent.
 * A test the browser itself starved of frames (a throttled hidden page) is
 * inconclusive: it says nothing about the game.
 */
export function classifyPlaytest(obs: PlaytestObservations): PlaytestVerdict {
    const failures: PlaytestFinding[] = [];
    const warnings: PlaytestFinding[] = [];

    if (!obs.started) {
        failures.push(obs.errorsBeforeStart > 0
            ? { code: 'start_threw', message: 'Play test: the game threw an error while loading or starting and never reached gameplay.' }
            : { code: 'never_started', message: 'Play test: the game never reached gameplay.' });
        return { outcome: 'failed', failures, warnings };
    }

    const samples = obs.samples;
    const latest = samples[samples.length - 1];
    const browserProgress = recentProgress(samples, 'rafCount');
    if (!latest || browserProgress === null || browserProgress <= 0) {
        return { outcome: 'inconclusive', failures, warnings };
    }

    const engineProgress = recentProgress(samples, 'engineFrames');
    if (engineProgress !== null && engineProgress <= 0) {
        failures.push({ code: 'render_stalled', message: 'Play test: the game stopped rendering during gameplay.' });
    }

    if (latest.respawnCount > MAX_RESPAWNS) {
        failures.push({
            code: 'fell_out_of_world',
            message: `Play test: the player fell out of the world ${latest.respawnCount} times without any input.`,
        });
    } else if (isFreefalling(samples) && latest.playerY !== null && latest.playerY < STILL_FALLING_BELOW_Y) {
        failures.push({ code: 'fell_out_of_world', message: 'Play test: the player was still falling through the world when the test ended.' });
    }

    if (obs.frame) {
        if (obs.frame.litFraction <= BLACK_LIT_FRACTION) {
            failures.push({ code: 'frame_black', message: 'Play test: the screen stayed black during gameplay.' });
        } else if (obs.frame.distinctColors < FLAT_DISTINCT_COLORS) {
            failures.push({ code: 'frame_flat', message: 'Play test: the screen showed a single flat colour during gameplay.' });
        }
    }

    if (latest.gameState !== null && latest.gameState !== 'playing' && latest.gameState !== 'end') {
        warnings.push({ code: 'left_gameplay', message: `The game left gameplay on its own (state: ${latest.gameState}).` });
    }
    if (obs.events) {
        if (obs.events.earlyDeaths >= EARLY_DEATHS) {
            warnings.push({ code: 'early_deaths', message: `The player died ${obs.events.earlyDeaths} times in the first 10 s without any input.` });
        }
        if (obs.events.matchEndAtSeconds !== null && obs.events.matchEndAtSeconds < EARLY_MATCH_END_SECONDS) {
            warnings.push({ code: 'early_match_end', message: `The match ended ${obs.events.matchEndAtSeconds} s after it started.` });
        }
    }

    return { outcome: failures.length > 0 ? 'failed' : 'passed', failures, warnings };
}

/** Pixel statistics from RGBA data, sampling every `step`-th pixel on each axis. */
export function frameStats(rgba: ArrayLike<number>, width: number, height: number, step = 4): FrameStats {
    let sampled = 0;
    let lit = 0;
    const colors = new Set<number>();
    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const i = (y * width + x) * 4;
            const r = rgba[i] ?? 0;
            const g = rgba[i + 1] ?? 0;
            const b = rgba[i + 2] ?? 0;
            sampled++;
            if (r > 4 || g > 4 || b > 4) lit++;
            colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
        }
    }
    return { litFraction: sampled === 0 ? 0 : lit / sampled, distinctColors: colors.size };
}

/** Early deaths and match-end timing from the event log (`__bmDebug.getEvents()`, 60 frames/s). */
export function summarizeEvents(events: readonly { frame: number; type: string }[]): PlaytestEvents {
    const earlyWindowFrames = 10 * 60;
    let earlyDeaths = 0;
    let matchEndAtSeconds: number | null = null;
    for (const event of events) {
        if (event.type === 'player-death' && event.frame < earlyWindowFrames) earlyDeaths++;
        if (event.type === 'match-end' && matchEndAtSeconds === null) {
            matchEndAtSeconds = Math.round((event.frame / 60) * 10) / 10;
        }
    }
    return { earlyDeaths, matchEndAtSeconds };
}
