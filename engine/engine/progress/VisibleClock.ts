/**
 * Running visible time for one play session.
 *
 * The XP heartbeat records only WHOLE visible minutes and its first beat lands
 * 60 s in, so nothing shorter than that was ever recorded. This clock is the
 * unfloored figure the client reports alongside the beat (and flushes on
 * pagehide), which is what makes a sub-minute visit visible at all.
 *
 * Pure and unit-testable: the caller supplies every clock reading, so no test
 * has to wait for real time to pass. Only VISIBLE time accrues — a backgrounded
 * game must not bank the hours it spent behind another window, or every average
 * it lands in describes tab-open time rather than play time.
 */
export class VisibleClock {
    private accruedMs = 0;
    private since: number | null;

    constructor(nowMs: number, visible: boolean) {
        this.since = visible ? nowMs : null;
    }

    /** Bank the open interval when the tab hides; ignore a repeat hide. */
    hide(nowMs: number): void {
        if (this.since === null) return;
        this.accruedMs += Math.max(0, nowMs - this.since);
        this.since = null;
    }

    /** Reopen the interval when the tab shows; ignore a repeat show. */
    show(nowMs: number): void {
        if (this.since === null) this.since = nowMs;
    }

    /** Visible milliseconds so far — a running total, never a delta. */
    elapsed(nowMs: number): number {
        return this.accruedMs + (this.since === null ? 0 : Math.max(0, nowMs - this.since));
    }
}
