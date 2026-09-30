/**
 * PathRequestTracker — sequence bookkeeping for async path requests.
 *
 * NavigationComponent submits pathfinding work to the PathRequestQueue and
 * needs to answer "is a request still in flight?" (isPending) so owning
 * controllers can hold their no-path fallbacks (e.g. AnimalController's
 * beeline approach) until the queue has actually answered. Without that gate
 * the fallback fires on the empty-path frames between submit and result,
 * clears the target, cancels the queued request, and the loop repeats
 * forever (beeline-cancel livelock).
 *
 * Contract:
 * - land() marks a result delivered EVEN when the delivered path is empty —
 *   an unreachable result must clear the pending state, otherwise the
 *   controller would wait forever.
 * - cancelAll() marks everything landed — nothing is pending after a cancel
 *   (setTargetPosition(null), clearPath, dispose).
 * - isCurrent(seq) tells the caller whether a landing result should be
 *   APPLIED: only the newest, not-yet-cancelled submission qualifies;
 *   superseded or cancelled results are still land()ed but dropped.
 */
export class PathRequestTracker {
    private lastSubmittedSeq = 0;
    private lastLandedSeq = 0;

    /** Register a new submission; returns its sequence number. */
    submit(): number {
        return ++this.lastSubmittedSeq;
    }

    /** Mark `seq` landed (result delivered — including an empty/unreachable path). */
    land(seq: number): void {
        if (seq > this.lastLandedSeq) this.lastLandedSeq = seq;
    }

    /** Cancel everything in flight: nothing is pending after this. */
    cancelAll(): void {
        this.lastLandedSeq = this.lastSubmittedSeq;
    }

    /** True while a submitted request has not yet landed (or been cancelled). */
    isPending(): boolean {
        return this.lastSubmittedSeq > this.lastLandedSeq;
    }

    /**
     * True when `seq` is the newest submission AND has not been cancelled —
     * i.e. its result should be applied by the caller.
     */
    isCurrent(seq: number): boolean {
        return seq === this.lastSubmittedSeq && seq > this.lastLandedSeq;
    }
}
