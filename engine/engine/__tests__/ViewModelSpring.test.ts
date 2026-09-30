import { Spring1, Spring3, expApproach, impulseGain } from 'engine/viewmodel/Spring.js';

/**
 * The view model's whole feel rests on these springs, and both failure modes are
 * invisible in code review and obvious on screen: an integrator that gains
 * energy flings the weapon off the frame on a hitching frame, and an impulse
 * whose size depends on the tuning makes every weapon need re-authoring when its
 * stiffness changes. Both are asserted here as numbers.
 */

/** Every frequency the shipping recoil/sway channels actually use. */
const OMEGAS = [18, 20, 22, 26, 34, 40, 46, 50];

/** The damping range the view model ships: snappy through critical. */
const DAMPINGS = [0.8, 0.9, 1.0];

/** Overdamped is supported but not shipped — see the accuracy note below. */
const OVERDAMPED = 1.4;

/** The engine clamps frame delta at 0.1 s; springs must be stable to there. */
const ENGINE_MAX_DELTA = 0.1;

/**
 * How long this tuning needs to be indistinguishable from rest.
 *
 * Decay is governed by the slowest pole, which is NOT ω: an overdamped spring
 * crawls back on the slow root ω(ζ − √(ζ²−1)), so a window sized for critical
 * damping would fail it for being slow rather than for being wrong.
 */
function settleSeconds(omega: number, damping: number): number {
    const rate = damping > 1
        ? omega * (damping - Math.sqrt(damping * damping - 1))
        : damping * omega;
    return 16 / rate;
}

describe('impulse gain', () => {
    it('matches the closed form in the critically damped case', () => {
        for (const omega of OMEGAS) {
            expect(impulseGain(omega, 1)).toBeCloseTo(1 / (omega * Math.E), 12);
        }
    });

    it('is continuous across the critical-damping boundary', () => {
        // The three regimes are separate closed forms; a discontinuity here
        // would make a weapon's kick jump when its damping is nudged past 1.
        for (const omega of OMEGAS) {
            const below = impulseGain(omega, 0.999);
            const at = impulseGain(omega, 1);
            const above = impulseGain(omega, 1.001);
            expect(Math.abs(below - at) / at).toBeLessThan(1e-3);
            expect(Math.abs(above - at) / at).toBeLessThan(1e-3);
        }
    });
});

describe('Spring1 impulses are authored as peak displacement', () => {
    /** Largest excursion after an authored impulse, sampled at a given rate. */
    function observedPeak(omega: number, damping: number, peak: number, dt: number): number {
        const s = new Spring1(omega, damping);
        s.addImpulsePeak(peak);
        let observed = 0;
        for (let t = 0; t < 8 / omega; t += dt) {
            observed = Math.max(observed, Math.abs(s.integrate(dt)));
        }
        return observed;
    }

    it('peaks at the requested distance when sampled finely', () => {
        const dt = 1 / 2000;
        for (const omega of OMEGAS) {
            for (const damping of [...DAMPINGS, OVERDAMPED]) {
                for (const peak of [0.006, 0.05, 0.15]) {
                    const observed = observedPeak(omega, damping, peak, dt);
                    expect(Math.abs(observed - peak) / peak).toBeLessThan(0.01);
                }
            }
        }
    });

    it('still peaks at the requested distance at real frame rates', () => {
        // THE regression guard for this module. A sub-stepped semi-implicit
        // integrator passes every stability check and silently lands a ω = 50
        // kick ~80% short, because h·ω = 0.42 is stable long before it is
        // accurate — so this asserts the amplitude at coarse deltas, tightly.
        //
        // Sampling a narrow peak at 60 Hz would miss it for reasons that have
        // nothing to do with the integrator, so instead each schedule lands
        // exactly on the analytic peak time and the displacement is read there.
        for (const omega of OMEGAS) {
            for (const damping of DAMPINGS) {
                const beta = damping * omega;
                const omegaD = omega * Math.sqrt(Math.max(1 - damping * damping, 0));
                const tPeak = damping < 1 ? Math.atan2(omegaD, beta) / omegaD : 1 / omega;
                for (const dt of [1 / 240, 1 / 120, 1 / 60, 1 / 30]) {
                    const s = new Spring1(omega, damping);
                    s.addImpulsePeak(0.05);
                    // Whole frames, then one partial frame onto the peak.
                    let elapsed = 0;
                    while (elapsed + dt < tPeak) { s.integrate(dt); elapsed += dt; }
                    s.integrate(tPeak - elapsed);
                    expect(Math.abs(s.getValue())).toBeCloseTo(0.05, 6);
                }
            }
        }
    });

    it('scales linearly, so doubling a weapon kick doubles the travel', () => {
        const dt = 1 / 2000;
        const travel = (peak: number): number => {
            const s = new Spring1(40, 1);
            s.addImpulsePeak(peak);
            let max = 0;
            for (let t = 0; t < 0.5; t += dt) max = Math.max(max, Math.abs(s.integrate(dt)));
            return max;
        };
        expect(travel(0.1) / travel(0.05)).toBeCloseTo(2, 3);
    });

    it('stacks, so sustained fire climbs', () => {
        const s = new Spring1(46, 1);
        s.addImpulsePeak(0.05);
        for (let t = 0; t < 0.02; t += 1 / 240) s.integrate(1 / 240);
        const single = s.getValue();
        s.addImpulsePeak(0.05);
        for (let t = 0; t < 0.02; t += 1 / 240) s.integrate(1 / 240);
        expect(s.getValue()).toBeGreaterThan(single);
    });
});

describe('Spring1 stability', () => {
    /** Peak excursion and final displacement for a fixed or varying dt schedule. */
    function run(omega: number, damping: number, nextDt: () => number, seconds: number) {
        const s = new Spring1(omega, damping);
        s.addImpulsePeak(1);
        let peak = 0;
        let elapsed = 0;
        while (elapsed < seconds) {
            const dt = nextDt();
            elapsed += dt;
            peak = Math.max(peak, Math.abs(s.integrate(dt)));
        }
        return { peak, final: Math.abs(s.getValue()), atRest: s.isAtRest() };
    }

    it('never gains energy at any fixed frame rate, and settles to rest', () => {
        for (const omega of OMEGAS) {
            for (const damping of DAMPINGS) {
                for (const dt of [1 / 240, 1 / 120, 1 / 60, 1 / 30, ENGINE_MAX_DELTA]) {
                    const { peak, final, atRest } = run(
                        omega, damping, () => dt, settleSeconds(omega, damping),
                    );
                    // Underdamped springs legitimately overshoot once; 1.5x the
                    // authored peak is far above that and far below a divergence.
                    expect(peak).toBeLessThan(1.5);
                    expect(final).toBeLessThan(1e-3);
                    expect(atRest).toBe(true);
                }
            }
        }
    });

    it('never gains energy under a randomly varying frame rate', () => {
        // A real session is a jittering delta, which is where a marginally
        // stable integrator actually breaks.
        let seed = 12345;
        const rand = (): number => {
            seed = (seed * 1664525 + 1013904223) % 4294967296;
            return seed / 4294967296;
        };
        for (const omega of OMEGAS) {
            for (const damping of DAMPINGS) {
                const { peak, final } = run(
                    omega, damping,
                    () => 0.001 + rand() * (ENGINE_MAX_DELTA - 0.001),
                    settleSeconds(omega, damping),
                );
                expect(peak).toBeLessThan(1.5);
                expect(final).toBeLessThan(1e-3);
            }
        }
    });

    it('stays bounded at absurd deltas, with no stability bound to respect', () => {
        // The closed form has no h·ω limit at all, so a multi-second frame after
        // a tab-switch decays correctly instead of flinging the weapon.
        for (const omega of OMEGAS) {
            const { peak, final } = run(omega, 1, () => 1.0, 40);
            expect(peak).toBeLessThan(1.5);
            expect(final).toBeLessThan(1e-6);
        }
    });

    it('reaches the same state regardless of frame rate', () => {
        // The strongest property the analytic step buys: a 30 Hz machine and a
        // 240 Hz machine see the identical weapon, not merely similar ones.
        const stateAfter = (dt: number, omega: number, damping: number) => {
            const s = new Spring1(omega, damping);
            s.addImpulsePeak(0.05);
            for (let t = 0; t < 0.25 - 1e-9; t += dt) s.integrate(dt);
            return { x: s.getValue(), v: s.getVelocity() };
        };
        for (const omega of OMEGAS) {
            for (const damping of DAMPINGS) {
                const fine = stateAfter(1 / 240, omega, damping);
                for (const dt of [1 / 120, 1 / 60, 1 / 48]) {
                    const coarse = stateAfter(dt, omega, damping);
                    expect(coarse.x).toBeCloseTo(fine.x, 9);
                    expect(coarse.v).toBeCloseTo(fine.v, 7);
                }
            }
        }
    });

    it('ignores non-positive and non-finite deltas', () => {
        const s = new Spring1(40, 1);
        s.addImpulsePeak(0.1);
        const before = s.getValue();
        s.integrate(0);
        s.integrate(-1);
        s.integrate(Number.NaN);
        expect(s.getValue()).toBe(before);
    });
});

describe('Spring1 tracks a moving target', () => {
    it('converges to a held target and stays there', () => {
        const s = new Spring1(18, 0.85);
        for (let t = 0; t < 2; t += 1 / 60) s.integrate(1 / 60, 0.03);
        expect(s.getValue()).toBeCloseTo(0.03, 4);
    });

    it('lags the target, which is what reads as weight', () => {
        const s = new Spring1(18, 0.85);
        s.integrate(1 / 60, 0.03);
        expect(Math.abs(s.getValue())).toBeLessThan(0.03);
    });
});

describe('Spring3', () => {
    it('integrates each axis exactly as three Spring1s would', () => {
        const three = new Spring3(34, 1);
        const x = new Spring1(34, 1);
        const y = new Spring1(34, 1);
        const z = new Spring1(34, 1);
        three.addImpulsePeak(0.01, -0.02, 0.03);
        x.addImpulsePeak(0.01);
        y.addImpulsePeak(-0.02);
        z.addImpulsePeak(0.03);
        for (let t = 0; t < 0.4; t += 1 / 90) {
            three.integrate(1 / 90);
            x.integrate(1 / 90);
            y.integrate(1 / 90);
            z.integrate(1 / 90);
        }
        expect(three.getX()).toBeCloseTo(x.getValue(), 12);
        expect(three.getY()).toBeCloseTo(y.getValue(), 12);
        expect(three.getZ()).toBeCloseTo(z.getValue(), 12);
    });

    it('returns to rest after an impulse', () => {
        const s = new Spring3(46, 1);
        s.addImpulsePeak(0.02, 0.05, 0.01);
        for (let t = 0; t < 0.5; t += 1 / 60) s.integrate(1 / 60);
        expect(s.isAtRest()).toBe(true);
    });

    it('reset discards all motion', () => {
        const s = new Spring3(40, 1);
        s.addImpulsePeak(0.1, 0.1, 0.1);
        s.integrate(1 / 60);
        s.reset();
        expect(s.isAtRest()).toBe(true);
        s.integrate(1 / 60);
        expect(s.getX()).toBe(0);
    });
});

describe('expApproach', () => {
    it('closes exactly half the gap in one half-life, at any frame rate', () => {
        for (const dt of [1 / 240, 1 / 60, 0.05]) {
            let v = 0;
            for (let t = 0; t < 0.2 - 1e-9; t += dt) v = expApproach(v, 1, 0.2, dt);
            expect(v).toBeCloseTo(0.5, 6);
        }
    });

    it('is frame-rate independent', () => {
        // The naive lerp(a, b, dt * rate) form fails exactly this test, which is
        // why nothing in the view model uses it.
        const settle = (dt: number): number => {
            let v = 0;
            for (let t = 0; t < 1 - 1e-9; t += dt) v = expApproach(v, 1, 0.1, dt);
            return v;
        };
        expect(settle(1 / 240)).toBeCloseTo(settle(1 / 30), 6);
    });

    it('never overshoots, however long the frame', () => {
        expect(expApproach(0, 1, 0.05, 10)).toBeLessThanOrEqual(1);
        expect(expApproach(0, 1, 0.05, 10)).toBeGreaterThan(0.999);
    });
});
