import {
    LOAD_PHASE_ORDER,
    LOAD_PHASE_WEIGHTS,
    LoadProgressTracker,
    overallFraction,
    type LoadProgressSnapshot,
} from 'engine/progress/LoadProgress.js';

describe('overallFraction', () => {
    it('is 0 at the start of the first phase and 1 at the end of the last', () => {
        expect(overallFraction('boot', 0)).toBe(0);
        expect(overallFraction('warmup', 1)).toBeCloseTo(1, 10);
    });

    it('is non-decreasing across the phase sequence', () => {
        let prev = -1;
        for (const phase of LOAD_PHASE_ORDER) {
            const start = overallFraction(phase, 0);
            const end = overallFraction(phase, 1);
            expect(start).toBeGreaterThanOrEqual(prev);
            expect(end).toBeGreaterThanOrEqual(start);
            prev = end;
        }
    });

    it('phase end equals the next phase start (no gaps or overlaps)', () => {
        for (let i = 0; i + 1 < LOAD_PHASE_ORDER.length; i++) {
            expect(overallFraction(LOAD_PHASE_ORDER[i]!, 1))
                .toBeCloseTo(overallFraction(LOAD_PHASE_ORDER[i + 1]!, 0), 10);
        }
    });

    it('clamps out-of-range phase fractions', () => {
        expect(overallFraction('world', -1)).toBe(overallFraction('world', 0));
        expect(overallFraction('world', 2)).toBe(overallFraction('world', 1));
    });

    it('weights table covers exactly the ordered phases', () => {
        expect(Object.keys(LOAD_PHASE_WEIGHTS).sort()).toEqual([...LOAD_PHASE_ORDER].sort());
        for (const phase of LOAD_PHASE_ORDER) {
            expect(LOAD_PHASE_WEIGHTS[phase]).toBeGreaterThan(0);
        }
    });
});

describe('LoadProgressTracker', () => {
    it('advances through phases and never regresses', () => {
        const t = new LoadProgressTracker();
        t.reset();
        t.beginPhase('boot');
        t.beginPhase('data');
        const atData = t.getSnapshot().fraction;
        t.setPhaseFraction(0.5);
        const midData = t.getSnapshot().fraction;
        expect(midData).toBeGreaterThan(atData);

        // Regressing within-phase fraction keeps the bar still.
        t.setPhaseFraction(0.1);
        expect(t.getSnapshot().fraction).toBe(midData);

        // Re-entering an EARLIER phase must not move backwards either.
        t.beginPhase('world');
        const atWorld = t.getSnapshot().fraction;
        t.beginPhase('physics');
        expect(t.getSnapshot().fraction).toBe(atWorld);
    });

    it('skipped phases are credited when a later phase begins', () => {
        const t = new LoadProgressTracker();
        t.reset();
        t.beginPhase('assets');
        expect(t.getSnapshot().fraction).toBeCloseTo(overallFraction('assets', 0), 10);
    });

    it('complete() jumps to 1 and reset() returns to 0', () => {
        const t = new LoadProgressTracker();
        t.beginPhase('world');
        t.complete();
        expect(t.getSnapshot()).toMatchObject({ fraction: 1, phase: null });
        t.reset();
        expect(t.getSnapshot().fraction).toBe(0);
    });

    it('reportItems maps counts onto the current phase', () => {
        const t = new LoadProgressTracker();
        t.beginPhase('assets');
        t.reportItems(1, 4);
        expect(t.getSnapshot().fraction).toBeCloseTo(overallFraction('assets', 0.25), 10);
        t.reportItems(0, 0); // no-op, not NaN
        expect(Number.isFinite(t.getSnapshot().fraction)).toBe(true);
    });

    it('setPhaseFraction before any beginPhase is a no-op', () => {
        const t = new LoadProgressTracker();
        t.setPhaseFraction(0.9);
        expect(t.getSnapshot().fraction).toBe(0);
    });

    it('notifies listeners with snapshots, immediately on subscribe, and survives a throwing listener', () => {
        const t = new LoadProgressTracker();
        t.beginPhase('data', 'Loading data');
        const seen: LoadProgressSnapshot[] = [];
        t.addListener(() => { throw new Error('listener boom'); });
        t.addListener((s) => seen.push(s));
        // Immediate sync for late subscribers:
        expect(seen).toHaveLength(1);
        expect(seen[0]!.label).toBe('Loading data');

        t.setPhaseFraction(0.5, 'halfway');
        expect(seen).toHaveLength(2);
        expect(seen[1]!.label).toBe('halfway');
        expect(seen[1]!.phase).toBe('data');
    });

    it('setLabel updates the label without moving the bar', () => {
        const t = new LoadProgressTracker();
        t.beginPhase('world', 'a');
        const before = t.getSnapshot().fraction;
        t.setLabel('b');
        expect(t.getSnapshot()).toMatchObject({ fraction: before, label: 'b' });
    });
});
