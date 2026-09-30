/**
 * @jest-environment jsdom
 *
 * `resolveWarmupMode` reads `window.location.search`, and the point of the fallback
 * path is that it survives a missing one — so the URL cases need a real `window`.
 */
import { warmupPolicyFor, isWarmupMode, resolveWarmupMode, type WarmupMode } from 'engine/WarmupPolicy.js';

/** Point `window.location.search` at `query` for one assertion. */
function withSearch(query: string, fn: () => void): void {
    const original = window.location.search;
    Object.defineProperty(window, 'location', {
        value: { ...window.location, search: query },
        writable: true,
        configurable: true,
    });
    try { fn(); } finally {
        Object.defineProperty(window, 'location', {
            value: { ...window.location, search: original },
            writable: true,
            configurable: true,
        });
    }
}

describe('warmupPolicyFor', () => {
    it('is a LADDER: every step down switches work off and never back on', () => {
        // The modes only diagnose a device if they are ordered — if `culled` turned
        // something on that `nocompile` had off, a crash on one and not the other would
        // identify nothing.
        const ladder: WarmupMode[] = ['full', 'nocompile', 'culled', 'light', 'off'];
        const cost = (m: WarmupMode): number => {
            const p = warmupPolicyFor(m);
            return Number(p.compile) + Number(p.uncullScene) + Number(p.revealEmptyInstanced) + Number(p.frame);
        };
        for (let i = 1; i < ladder.length; i++) {
            expect(cost(ladder[i]!)).toBeLessThan(cost(ladder[i - 1]!));
        }
    });

    it('full runs every step and off runs none', () => {
        expect(warmupPolicyFor('full')).toEqual({ compile: true, uncullScene: true, revealEmptyInstanced: true, frame: true });
        expect(warmupPolicyFor('off')).toEqual({ compile: false, uncullScene: false, revealEmptyInstanced: false, frame: false });
    });

    it('isolates ONE variable per rung, so a crash points at a specific step', () => {
        // nocompile vs full differs only in the pre-compile; light vs culled likewise.
        expect(warmupPolicyFor('nocompile')).toEqual({ ...warmupPolicyFor('full'), compile: false });
        expect(warmupPolicyFor('light')).toEqual({ ...warmupPolicyFor('culled'), compile: false });
        // culled vs full drops exactly the two scene-wide expansions.
        expect(warmupPolicyFor('culled')).toEqual({ ...warmupPolicyFor('full'), uncullScene: false, revealEmptyInstanced: false });
    });

    it('every mode except off still draws the warm frame', () => {
        for (const m of ['full', 'nocompile', 'culled', 'light'] as WarmupMode[]) {
            expect(warmupPolicyFor(m).frame).toBe(true);
        }
    });
});

describe('resolveWarmupMode', () => {
    it('defaults to the full warmup on desktop and the light one on mobile', () => {
        withSearch('', () => {
            expect(resolveWarmupMode('full')).toBe('full');
            expect(resolveWarmupMode('light')).toBe('light');
        });
    });

    it('?warmup= overrides the platform default on BOTH platforms', () => {
        // A phone result has to be reproducible on a desktop browser, so the override
        // is not mobile-only.
        withSearch('?warmup=off', () => {
            expect(resolveWarmupMode('light')).toBe('off');
            expect(resolveWarmupMode('full')).toBe('off');
        });
        withSearch('?warmup=full', () => expect(resolveWarmupMode('light')).toBe('full'));
    });

    it('a typo falls back to the platform default rather than breaking the load', () => {
        withSearch('?warmup=lite', () => expect(resolveWarmupMode('light')).toBe('light'));
        withSearch('?warmup=', () => expect(resolveWarmupMode('full')).toBe('full'));
    });

    it('coexists with the other params a device test carries', () => {
        withSearch('?platform=mobile&terrainBands=1&warmup=culled', () => {
            expect(resolveWarmupMode('light')).toBe('culled');
        });
    });
});

describe('isWarmupMode', () => {
    it('accepts exactly the five modes', () => {
        for (const m of ['full', 'nocompile', 'culled', 'light', 'off']) expect(isWarmupMode(m)).toBe(true);
        for (const m of ['', 'FULL', 'none', 'toString', 'constructor']) expect(isWarmupMode(m)).toBe(false);
    });
});
