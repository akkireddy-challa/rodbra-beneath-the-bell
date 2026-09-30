import { ShatterScheduler, SHATTER_FRAME_BUDGET_MS } from 'engine/effects/ShatterScheduler.js';

/** A clock that advances by a scripted cost each time a job runs. */
function harness() {
    let t = 0;
    const s = new ShatterScheduler(() => t);
    const log: string[] = [];
    const job = (name: string, costMs: number) => () => { log.push(name); t += costMs; };
    return { s, log, job };
}

describe('shatter scheduler', () => {
    it('the first shatter of a frame runs now, whatever it costs', () => {
        const { s, log, job } = harness();
        expect(s.runOrDefer(job('a', 60))).toBe(true);
        expect(log).toEqual(['a']);
    });

    it('once the frame is over budget the rest queue, in order, and drain on later frames', () => {
        const { s, log, job } = harness();
        s.runOrDefer(job('a', 60));                       // over budget after this
        expect(s.runOrDefer(job('b', 60))).toBe(false);
        expect(s.runOrDefer(job('c', 1))).toBe(false);    // cheap, but must not overtake b
        expect(s.pending).toBe(2);
        expect(log).toEqual(['a']);
        s.beginFrame();                                   // b runs (costs 60 → budget gone), c waits
        expect(log).toEqual(['a', 'b']);
        expect(s.pending).toBe(1);
        s.beginFrame();
        expect(log).toEqual(['a', 'b', 'c']);
        expect(s.pending).toBe(0);
    });

    it('cheap shatters keep running in the same frame while under budget', () => {
        const { s, log, job } = harness();
        for (let i = 0; i < 5; i++) s.runOrDefer(job(`k${i}`, 1));
        expect(log).toHaveLength(5);                      // 5 ms total < budget
        s.runOrDefer(job('big', SHATTER_FRAME_BUDGET_MS));
        expect(s.runOrDefer(job('late', 1))).toBe(false); // now over budget
    });

    it('a frame drains several queued shatters while under budget', () => {
        const { s, log, job } = harness();
        s.runOrDefer(job('a', 60));
        for (let i = 0; i < 4; i++) s.runOrDefer(job(`q${i}`, 2));
        s.beginFrame();                                   // 4 × 2 ms = 8 ms: all four fit
        expect(log).toEqual(['a', 'q0', 'q1', 'q2', 'q3']);
    });

    it('a throwing job still charges the frame and does not wedge the queue', () => {
        const { s, log, job } = harness();
        s.runOrDefer(job('a', 60));
        s.runOrDefer(() => { throw new Error('boom'); });
        s.runOrDefer(job('after', 1));
        expect(() => s.beginFrame()).toThrow('boom');
        s.beginFrame();
        expect(log).toEqual(['a', 'after']);
    });

    it('clear drops what is waiting', () => {
        const { s, job } = harness();
        s.runOrDefer(job('a', 60));
        s.runOrDefer(job('b', 1));
        s.clear();
        expect(s.pending).toBe(0);
    });
});
