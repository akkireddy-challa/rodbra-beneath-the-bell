import { VisibleClock } from 'engine/progress/VisibleClock.js';

/**
 * The clock the heartbeat reports its visible-ms total from. What matters here
 * is that it only ever counts time the tab was actually visible — a backgrounded
 * game must not accrue the hours it spent behind another window, or every bucket
 * it lands in describes tab-open time rather than play time.
 */
describe('VisibleClock', () => {
    it('counts from construction when the tab starts visible', () => {
        const clock = new VisibleClock(1_000, true);
        expect(clock.elapsed(4_000)).toBe(3_000);
    });

    it('counts nothing while the tab starts hidden', () => {
        const clock = new VisibleClock(1_000, false);
        expect(clock.elapsed(60_000)).toBe(0);
    });

    it('banks the visible interval on hide and freezes there', () => {
        const clock = new VisibleClock(0, true);
        clock.hide(5_000);
        expect(clock.elapsed(5_000)).toBe(5_000);
        // An hour in the background adds nothing.
        expect(clock.elapsed(3_605_000)).toBe(5_000);
    });

    it('resumes on show without back-filling the hidden gap', () => {
        const clock = new VisibleClock(0, true);
        clock.hide(5_000);
        clock.show(3_605_000);
        expect(clock.elapsed(3_607_000)).toBe(7_000);
    });

    it('ignores a repeat hide or show rather than double-counting', () => {
        const clock = new VisibleClock(0, true);
        clock.hide(5_000);
        clock.hide(9_000); // already hidden — must not bank twice
        expect(clock.elapsed(9_000)).toBe(5_000);
        clock.show(10_000);
        clock.show(12_000); // already visible — must not move the mark forward
        expect(clock.elapsed(14_000)).toBe(9_000);
    });

    it('never goes backwards on a clock that jumps', () => {
        const clock = new VisibleClock(10_000, true);
        expect(clock.elapsed(5_000)).toBe(0);
        clock.hide(5_000);
        expect(clock.elapsed(5_000)).toBe(0);
    });
});
