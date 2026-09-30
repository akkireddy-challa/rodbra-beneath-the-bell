/**
 * @jest-environment jsdom
 *
 * The override reads `window.location.search`; the cap itself is pure.
 *
 * The cap is now a number from the quality tier rather than a mobile boolean, which is what
 * lets the bottom rung render below the display. The tests that used to assert "never
 * sub-1" now pin the two things that replaced it: an unknown display still normalises UP to
 * 1, so only a rung (or an explicit flag) can ever take you below it.
 */
import {
    resolveRenderPixelRatio, MOBILE_MAX_PIXEL_RATIO,
    MAX_RENDER_PIXEL_RATIO, MIN_RENDER_PIXEL_RATIO,
} from 'engine/RenderPixelRatio.js';

/** The cap the top rung carries — effectively uncapped. */
const UNCAPPED = MAX_RENDER_PIXEL_RATIO;

function withSearch(query: string, fn: () => void): void {
    const original = window.location.search;
    const set = (search: string): void => {
        Object.defineProperty(window, 'location', {
            value: { ...window.location, search },
            writable: true,
            configurable: true,
        });
    };
    set(query);
    try { fn(); } finally { set(original); }
}

describe('resolveRenderPixelRatio', () => {
    it('caps at 2 — an iPhone reports 3, which is 2.25x the render-target memory', () => {
        withSearch('', () => {
            expect(resolveRenderPixelRatio(3, MOBILE_MAX_PIXEL_RATIO)).toBe(2);
            expect(resolveRenderPixelRatio(4, MOBILE_MAX_PIXEL_RATIO)).toBe(2);
        });
    });

    it('never RAISES a ratio: a display already under the cap keeps its own', () => {
        withSearch('', () => {
            expect(resolveRenderPixelRatio(1, MOBILE_MAX_PIXEL_RATIO)).toBe(1);
            expect(resolveRenderPixelRatio(1.5, MOBILE_MAX_PIXEL_RATIO)).toBe(1.5);
            expect(resolveRenderPixelRatio(1, UNCAPPED)).toBe(1);
        });
    });

    it('leaves the top rung alone — clamping a Retina Mac would visibly soften the editor', () => {
        withSearch('', () => {
            expect(resolveRenderPixelRatio(2, UNCAPPED)).toBe(2);
            expect(resolveRenderPixelRatio(3, UNCAPPED)).toBe(3);
        });
    });

    it('renders below the display when the rung asks for it', () => {
        // The rescue rung's whole point: resolution is the one lever that converts
        // reliably and instantly into frame time, and a blurry game that runs beats a
        // sharp one that does not.
        withSearch('', () => {
            expect(resolveRenderPixelRatio(3, 0.75)).toBe(0.75);
            expect(resolveRenderPixelRatio(1, 0.75)).toBe(0.75);
        });
    });

    it('holds the floor, so a rung cannot ask for something that stops being a picture', () => {
        withSearch('', () => expect(resolveRenderPixelRatio(3, 0.1)).toBe(MIN_RENDER_PIXEL_RATIO));
    });

    it('?dpr= overrides the rung, so a cap can be A/B tested on a device', () => {
        withSearch('?dpr=3', () => expect(resolveRenderPixelRatio(3, MOBILE_MAX_PIXEL_RATIO)).toBe(3));
        withSearch('?dpr=1', () => expect(resolveRenderPixelRatio(3, UNCAPPED)).toBe(1));
        // Previously parsed and then silently discarded by the `>= 1` clamp, so the flag
        // did nothing on exactly the values a low rung is tested with.
        withSearch('?dpr=0.5', () => expect(resolveRenderPixelRatio(3, UNCAPPED)).toBe(0.5));
    });

    it('clamps a runaway override rather than letting a URL allocate the tab out', () => {
        withSearch('?dpr=100', () => expect(resolveRenderPixelRatio(3, MOBILE_MAX_PIXEL_RATIO)).toBe(MAX_RENDER_PIXEL_RATIO));
    });

    it('falls back to the rung on junk, including a value under the floor', () => {
        withSearch('?dpr=abc', () => expect(resolveRenderPixelRatio(3, MOBILE_MAX_PIXEL_RATIO)).toBe(2));
        withSearch('?dpr=-2', () => expect(resolveRenderPixelRatio(3, MOBILE_MAX_PIXEL_RATIO)).toBe(2));
        // `?dpr=0.01` is a typo, not a request for the floor — clamping it up would make
        // a slipped decimal point look like it worked. Rejecting it shows the rung instead.
        withSearch('?dpr=0.01', () => expect(resolveRenderPixelRatio(3, UNCAPPED)).toBe(3));
        expect(MIN_RENDER_PIXEL_RATIO).toBe(0.5);
    });

    it('treats an unknown display as a normal one, not as licence to render at a quarter', () => {
        // Some emulated viewports report 0. Normalising UP before the cap is what keeps a
        // broken viewport from resolving to the rescue rung's ratio on a healthy machine.
        withSearch('', () => {
            expect(resolveRenderPixelRatio(0, MOBILE_MAX_PIXEL_RATIO)).toBe(1);
            expect(resolveRenderPixelRatio(Number.NaN, UNCAPPED)).toBe(1);
            expect(resolveRenderPixelRatio(-1, UNCAPPED)).toBe(1);
        });
    });
});
