/**
 * Verdict of the in-browser play test. Only clear failures fail it (the
 * Creator auto-fixes those); a page the browser starved of frames is
 * inconclusive, never a failure of the game.
 */
import {
    classifyPlaytest,
    frameStats,
    hasSettled,
    summarizeEvents,
    type PlaytestObservations,
    type PlaytestSample,
} from 'engine/playtest/playtestClassify.js';

function samples(count: number, overrides: (i: number) => Partial<PlaytestSample> = () => ({})): PlaytestSample[] {
    return Array.from({ length: count }, (_, i) => ({
        atMs: (i + 1) * 500,
        rafCount: (i + 1) * 30,
        engineFrames: (i + 1) * 30,
        gameState: 'playing',
        playerY: 1,
        errorCount: 0,
        respawnCount: 0,
        ...overrides(i),
    }));
}

const litFrame = { litFraction: 0.9, distinctColors: 200 };

function observe(overrides: Partial<PlaytestObservations> = {}): PlaytestObservations {
    return { started: true, errorsBeforeStart: 0, samples: samples(12), frame: litFrame, events: null, ...overrides };
}

describe('hasSettled', () => {
    it('waits for the minimum time, frames and a quiet error window', () => {
        expect(hasSettled(samples(6))).toBe(false);
        expect(hasSettled(samples(12))).toBe(true);
        expect(hasSettled(samples(12, i => ({ errorCount: i === 11 ? 1 : 0 })))).toBe(false);
    });

    it('never settles while the player is falling', () => {
        expect(hasSettled(samples(12, i => ({ playerY: -i * 10 })))).toBe(false);
    });
});

describe('classifyPlaytest', () => {
    it('passes a steady, lit game', () => {
        expect(classifyPlaytest(observe())).toEqual({ outcome: 'passed', failures: [], warnings: [] });
    });

    it('fails a game that never started, naming a start that threw', () => {
        expect(classifyPlaytest(observe({ started: false, samples: [] })).failures[0]?.code).toBe('never_started');
        expect(classifyPlaytest(observe({ started: false, errorsBeforeStart: 2, samples: [] })).failures[0]?.code).toBe('start_threw');
    });

    it('fails black and flat frames', () => {
        expect(classifyPlaytest(observe({ frame: { litFraction: 0, distinctColors: 1 } })).failures.map(f => f.code)).toEqual(['frame_black']);
        expect(classifyPlaytest(observe({ frame: { litFraction: 1, distinctColors: 1 } })).failures.map(f => f.code)).toEqual(['frame_flat']);
    });

    it('fails a player that keeps falling out of the world', () => {
        const respawning = samples(12, i => ({ respawnCount: i }));
        expect(classifyPlaytest(observe({ samples: respawning })).failures.map(f => f.code)).toEqual(['fell_out_of_world']);
        const falling = samples(12, i => ({ playerY: -i * 20 }));
        expect(classifyPlaytest(observe({ samples: falling })).failures.map(f => f.code)).toEqual(['fell_out_of_world']);
    });

    it('fails a stalled render only while the browser still runs the page', () => {
        const stalled = samples(12, i => ({ engineFrames: Math.min(i, 6) * 30 }));
        expect(classifyPlaytest(observe({ samples: stalled })).failures.map(f => f.code)).toEqual(['render_stalled']);
        const throttled = samples(12, i => ({ engineFrames: Math.min(i, 6) * 30, rafCount: Math.min(i, 6) * 30 }));
        expect(classifyPlaytest(observe({ samples: throttled })).outcome).toBe('inconclusive');
    });

    it('only warns about softer signals', () => {
        const verdict = classifyPlaytest(observe({
            samples: samples(12, i => ({ gameState: i === 11 ? 'menu' : 'playing' })),
            events: { earlyDeaths: 3, matchEndAtSeconds: 2 },
        }));
        expect(verdict.outcome).toBe('passed');
        expect(verdict.warnings.map(w => w.code)).toEqual(['left_gameplay', 'early_deaths', 'early_match_end']);
    });
});

describe('frameStats', () => {
    it('measures lit share and colour variety', () => {
        const black = new Uint8ClampedArray(8 * 8 * 4);
        expect(frameStats(black, 8, 8)).toEqual({ litFraction: 0, distinctColors: 1 });
        const mixed = Uint8ClampedArray.from({ length: 8 * 8 * 4 }, (_, i) => (i * 37) % 256);
        expect(frameStats(mixed, 8, 8).litFraction).toBeGreaterThan(0.5);
    });
});

describe('summarizeEvents', () => {
    it('counts early deaths and the first match end', () => {
        expect(summarizeEvents([
            { frame: 10, type: 'player-death' },
            { frame: 700, type: 'player-death' },
            { frame: 240, type: 'match-end' },
        ])).toEqual({ earlyDeaths: 1, matchEndAtSeconds: 4 });
    });
});
