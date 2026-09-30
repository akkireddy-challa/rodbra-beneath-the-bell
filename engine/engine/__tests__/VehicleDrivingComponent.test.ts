import { BasicDrivingComponent, DEFAULT_BASIC_DRIVING_OPTIONS, SMOOTH_DRIVING_OPTIONS } from 'engine/VehicleDrivingComponent.js';
import type { Vehicle, VehicleControls } from 'engine/Vehicle.js';

/**
 * The AI driver must recover the way a human does: back off after ramming a
 * car (yieldThrottle), and back out FURTHER each consecutive time a reverse
 * burst fails to clear an obstacle — one second of reverse from a wall the
 * path leads straight back into loops forever.
 */

const DT = 1 / 60;

interface FakeState {
    x: number; z: number;
    speed: number;
    controls: VehicleControls[];
    /** speeds[i] is state.speed right after controls[i] was applied. */
    speeds?: number[];
}

function fakeVehicle(over: Partial<FakeState> = {}): { vehicle: Vehicle; state: FakeState } {
    const state: FakeState = { x: 0, z: 0, speed: 0, controls: [], ...over };
    const vehicle = {
        getPosition: () => ({ x: state.x, y: 0.5, z: state.z }),
        getForwardDirection: () => ({ x: 0, y: 0, z: 1 }),
        getSpeed: () => state.speed,
        setAIControls: (c: VehicleControls) => { state.controls.push(c); },
    } as unknown as Vehicle;
    return { vehicle, state };
}

function run(driver: BasicDrivingComponent, vehicle: Vehicle, seconds: number): void {
    for (let t = 0; t < seconds; t += DT) driver.update(DT, vehicle);
}

/**
 * A fake whose speed responds to throttle and brake, so a speed controller can
 * actually be seen to settle. Crude first-order model: throttle accelerates,
 * brake and drag decelerate. Enough to distinguish "holds a speed" from
 * "oscillates between full power and coasting".
 */
function respondingVehicle(): { vehicle: Vehicle; state: FakeState } {
    const state: FakeState = { x: 0, z: 0, speed: 0, controls: [], speeds: [] };
    const vehicle = {
        getPosition: () => ({ x: state.x, y: 0.5, z: state.z }),
        getForwardDirection: () => ({ x: 0, y: 0, z: 1 }),
        getSpeed: () => state.speed,
        setAIControls: (c: VehicleControls) => {
            state.controls.push(c);
            const throttle = c.throttle ?? (c.forward ? 1 : 0);
            const braking = c.brakeAmount ?? (c.brake ? 1 : 0);
            state.speed += (throttle * 8 - braking * 12 - state.speed * 0.4) * DT;
            state.speed = Math.max(0, state.speed);
            state.z += state.speed * DT;
            state.speeds!.push(state.speed);
        },
    } as unknown as Vehicle;
    return { vehicle, state };
}

/** Lengths (s) of each consecutive stretch of backward=true in the control log. */
function burstLengths(controls: VehicleControls[]): number[] {
    const lengths: number[] = [];
    let current = 0;
    for (const c of controls) {
        if (c.backward) {
            current += DT;
        } else if (current > 0) {
            lengths.push(current);
            current = 0;
        }
    }
    if (current > 0) lengths.push(current);
    return lengths;
}

describe('BasicDrivingComponent', () => {
    it('escalates consecutive reverse bursts instead of repeating a failed one', () => {
        const driver = new BasicDrivingComponent();
        const { vehicle, state } = fakeVehicle({ speed: 0 }); // pinned against a wall
        driver.setTarget(0, 100);

        run(driver, vehicle, 14);

        const bursts = burstLengths(state.controls);
        expect(bursts.length).toBeGreaterThanOrEqual(4);
        expect(bursts[0]!).toBeCloseTo(1.0, 1);
        expect(bursts[1]!).toBeCloseTo(1.6, 1);
        expect(bursts[2]!).toBeCloseTo(2.56, 1);
        expect(bursts[3]!).toBeCloseTo(3.0, 1); // capped
    });

    it('forgets the escalation after a stretch of normal driving', () => {
        const driver = new BasicDrivingComponent();
        const { vehicle, state } = fakeVehicle({ speed: 0 });
        driver.setTarget(0, 100);

        run(driver, vehicle, 4); // burst 1 (1.0s) + into burst 2 territory
        state.speed = 8; // broke free, driving normally
        run(driver, vehicle, 5); // longer than the escalation window
        state.speed = 0; // stuck on something new
        state.controls.length = 0;
        run(driver, vehicle, 3);

        const bursts = burstLengths(state.controls);
        expect(bursts[0]!).toBeCloseTo(1.0, 1); // back to the base duration
    });

    it('yieldThrottle coasts with live steering, then resumes', () => {
        const driver = new BasicDrivingComponent();
        const { vehicle, state } = fakeVehicle({ speed: 10, x: 3 }); // target off to the side
        driver.setTarget(0, 100);

        run(driver, vehicle, 0.2);
        expect(state.controls.at(-1)!.forward).toBe(true);

        driver.yieldThrottle(0.5);
        state.controls.length = 0;
        run(driver, vehicle, 0.4);
        // Coasting: no throttle, no brake, steering still tracking the path.
        for (const c of state.controls) {
            expect(c.forward).toBe(false);
            expect(c.brake).toBe(false);
            expect(c.steer).toBeDefined();
        }

        run(driver, vehicle, 0.3); // past the yield window
        expect(state.controls.at(-1)!.forward).toBe(true);
    });

    it('extends a yield to the longest request, never shortens it', () => {
        const driver = new BasicDrivingComponent();
        const { vehicle, state } = fakeVehicle({ speed: 10 });
        driver.setTarget(0, 100);

        driver.yieldThrottle(0.6);
        driver.yieldThrottle(0.2); // must not cut the earlier request short
        run(driver, vehicle, 0.5);
        expect(state.controls.at(-1)!.forward).toBe(false);
    });

    it('a stuck car still backs out while yielding — recovery outranks the lift', () => {
        const driver = new BasicDrivingComponent();
        const { vehicle, state } = fakeVehicle({ speed: 0 });
        driver.setTarget(0, 100);
        driver.yieldThrottle(10);

        run(driver, vehicle, 2);
        expect(state.controls.some((c) => c.backward)).toBe(true);
    });

    it('the default options reproduce the hardcoded behaviour exactly', () => {
        // Same scenario as the escalation test above, but constructed with the
        // options object rather than no arguments. If the defaults have drifted
        // from the constants they replaced, the burst lengths diverge.
        const driver = new BasicDrivingComponent(DEFAULT_BASIC_DRIVING_OPTIONS);
        const { vehicle, state } = fakeVehicle({ speed: 0 });
        driver.setTarget(0, 100);

        run(driver, vehicle, 14);

        const bursts = burstLengths(state.controls);
        expect(bursts[0]!).toBeCloseTo(1.0, 1);
        expect(bursts[1]!).toBeCloseTo(1.6, 1);
        expect(bursts[2]!).toBeCloseTo(2.56, 1);
        expect(bursts[3]!).toBeCloseTo(3.0, 1);
    });

    it('the exported default holds the exact values the module constants had', () => {
        // Pins the refactor's claim: these are the numbers that were hardcoded
        // before the options object existed. Tasks 4 and 5 build on them, and a
        // drifted default here is invisible to the behavioural tests above.
        expect(DEFAULT_BASIC_DRIVING_OPTIONS).toEqual({
            analogThrottle: false,
            cruiseSpeed: 0,
            slowRadius: 0,
            crawlSpeed: 0,
            arriveRadius: 0.5,
            steerDeadzoneAngle: 0.05,
            steerFullLockAngle: 0.6,
            reverseDistanceThreshold: 8,
            noProgressTimeout: 8,
            recovery: {
                enabled: true,
                speedThreshold: 1.5,
                speedFractionOfTarget: 0,
                requireThrottle: false,
                timeThreshold: 1.0,
                burstDuration: 1.0,
                burstEscalation: 1.6,
                burstMaxDuration: 3.0,
                escalationWindow: 4.0,
            },
        });
    });

    it('defaults keep the analog fields off, so shipped games see boolean controls', () => {
        const driver = new BasicDrivingComponent();
        const { vehicle, state } = fakeVehicle({ speed: 5 });
        driver.setTarget(0, 100);

        run(driver, vehicle, 0.5);

        for (const c of state.controls) {
            expect(c.throttle).toBeUndefined();
            expect(c.brakeAmount).toBeUndefined();
        }
    });

    it('a deliberate crawl never arms recovery', () => {
        // 2.5 m/s cruise with a 0.35 fraction puts the effective threshold at
        // 0.875 m/s, so a car steadily doing 1.2 m/s is driving, not stuck.
        // Under the old absolute 1.5 m/s threshold this shuffled forever.
        const driver = new BasicDrivingComponent({
            ...DEFAULT_BASIC_DRIVING_OPTIONS,
            cruiseSpeed: 2.5,
            recovery: {
                ...DEFAULT_BASIC_DRIVING_OPTIONS.recovery,
                speedFractionOfTarget: 0.35,
            },
        });
        const { vehicle, state } = fakeVehicle({ speed: 1.2 });
        driver.setTarget(0, 100);

        run(driver, vehicle, 10);

        expect(state.controls.some((c) => c.backward)).toBe(false);
    });

    it('still recovers when genuinely wedged, even with the fraction cap on', () => {
        const driver = new BasicDrivingComponent({
            ...DEFAULT_BASIC_DRIVING_OPTIONS,
            cruiseSpeed: 2.5,
            recovery: {
                ...DEFAULT_BASIC_DRIVING_OPTIONS.recovery,
                speedFractionOfTarget: 0.35,
            },
        });
        const { vehicle, state } = fakeVehicle({ speed: 0 }); // pinned on a wall
        driver.setTarget(0, 100);

        run(driver, vehicle, 4);

        expect(state.controls.some((c) => c.backward)).toBe(true);
    });

    it('requireThrottle keeps a braking car from being treated as stuck', () => {
        const driver = new BasicDrivingComponent({
            ...DEFAULT_BASIC_DRIVING_OPTIONS,
            recovery: { ...DEFAULT_BASIC_DRIVING_OPTIONS.recovery, requireThrottle: true },
        });
        const { vehicle, state } = fakeVehicle({ speed: 0 });
        driver.setTarget(0, 100);
        driver.yieldThrottle(10); // coasting the whole time — no throttle asked for

        run(driver, vehicle, 6);

        expect(state.controls.some((c) => c.backward)).toBe(false);
    });

    it('recovery.enabled false disables the reverse burst entirely', () => {
        const driver = new BasicDrivingComponent({
            ...DEFAULT_BASIC_DRIVING_OPTIONS,
            recovery: { ...DEFAULT_BASIC_DRIVING_OPTIONS.recovery, enabled: false },
        });
        const { vehicle, state } = fakeVehicle({ speed: 0 });
        driver.setTarget(0, 100);

        run(driver, vehicle, 10);

        expect(state.controls.some((c) => c.backward)).toBe(false);
    });

    it('holds the cruise speed instead of surging between power and coast', () => {
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 1000); // far away — no arrival easing in play

        run(driver, vehicle, 12);

        // A pure-proportional controller settles below cruiseSpeed by design
        // (drag supplies the steady-state offset — see the comment on the
        // analog branch), so pin a band rather than the exact value: close
        // enough to call it "holding cruise", never above it.
        expect(state.speed).toBeGreaterThan(0.9 * SMOOTH_DRIVING_OPTIONS.cruiseSpeed);
        expect(state.speed).toBeLessThanOrEqual(SMOOTH_DRIVING_OPTIONS.cruiseSpeed);
        // The tell-tale of bang-bang control is the throttle slamming between
        // its extremes. A settled controller sits somewhere in between on
        // EVERY frame once settled — `some` would also accept a controller
        // that spends most of its time at 0 or 1 and only passes through an
        // intermediate value once.
        const settled = state.controls.slice(-120);
        expect(settled.every((c) => c.throttle !== undefined)).toBe(true);
        expect(settled.every((c) => c.throttle! > 0 && c.throttle! < 1)).toBe(true);
    });

    it('eases down to a crawl on the approach and parks at the destination', () => {
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = respondingVehicle();
        let arrived = false;
        driver.setTarget(0, 60);

        run(driver, vehicle, 30);
        arrived = driver.isNear(0, 60, SMOOTH_DRIVING_OPTIONS.arriveRadius);

        expect(arrived).toBe(true);
        expect(state.speed).toBeLessThan(1);
        // It must have genuinely slowed BEFORE arriving, not braked from cruise.
        expect(state.controls.some((c) => (c.throttle ?? 0) > 0 && (c.throttle ?? 0) < 0.5)).toBe(true);
        // The assertion above is also satisfied by the initial ramp-up from a
        // standstill (throttle rises through (0, 0.5) on its way to cruise
        // too), so it alone does not pin arrival easing. Nail it down
        // directly: at the last frame the analog branch was still driving
        // (before the hard stop takes over inside arriveRadius), speed must
        // already be down near crawlSpeed, not still near cruiseSpeed.
        const lastAnalogIndex = state.controls.map((c) => c.throttle !== undefined).lastIndexOf(true);
        expect(lastAnalogIndex).toBeGreaterThanOrEqual(0);
        expect(state.speeds![lastAnalogIndex]!).toBeLessThan(SMOOTH_DRIVING_OPTIONS.crawlSpeed + 1.5);
    });

    it('an intermediate-leg target inside slowRadius reaches full cruise (isFinal: false)', () => {
        // Same shape as a waypoint follower's "aim at the next waypoint" call:
        // the point handed to setTarget (22m away) sits well inside
        // slowRadius (26m), same as a real intermediate waypoint always does.
        // Before `isFinal` existed this was indistinguishable from heading at
        // the actual destination, so targetSpeedFor eased off immediately and
        // cruiseSpeed (9) was never reached — see the next test for the
        // contrast at the exact same distance.
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 22, false);

        run(driver, vehicle, 3); // the car reaches this target well inside 3s

        const peakSpeed = Math.max(...state.speeds!);
        expect(peakSpeed).toBeGreaterThan(0.85 * SMOOTH_DRIVING_OPTIONS.cruiseSpeed);
    });

    it('the identical target treated as final (isFinal: true) eases down instead of reaching cruise', () => {
        // Only `isFinal` differs from the test above — same options, same
        // fake vehicle, same 22m target distance. If targetSpeedFor's
        // easing were not actually gated on isFinal, this peak would match
        // the intermediate-leg test's, not fall well under it.
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 22, true);

        run(driver, vehicle, 3);

        const peakSpeed = Math.max(...state.speeds!);
        expect(peakSpeed).toBeLessThan(0.85 * SMOOTH_DRIVING_OPTIONS.cruiseSpeed);
    });

    it('a final-leg target (isFinal defaulted, matching every pre-existing caller) still eases down and parks', () => {
        // Pins that the DEFAULT (no third argument, exactly what all 22
        // pre-existing tests and every caller before this branch did) still
        // reproduces the original "eases down to a crawl and parks" behaviour
        // — the two-argument call path must be unaffected by isFinal existing.
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 60);

        run(driver, vehicle, 30);

        expect(driver.isNear(0, 60, SMOOTH_DRIVING_OPTIONS.arriveRadius)).toBe(true);
        expect(state.speed).toBeLessThan(1);
    });

    it('leaves boolean output alone when analogThrottle is off', () => {
        const driver = new BasicDrivingComponent(DEFAULT_BASIC_DRIVING_OPTIONS);
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 1000);

        run(driver, vehicle, 3);

        expect(state.controls.every((c) => c.throttle === undefined)).toBe(true);
        expect(state.controls.some((c) => c.forward)).toBe(true);
    });

    it('a car coasting under its speed limit is not treated as stuck', () => {
        // Pins the `overSpeed ? 0 : 1` arm: the car is limited to 0.5 m/s and
        // doing 0.6, so it is permanently under the 1.5 m/s absolute floor.
        // Only "coasting means no throttle asked for" keeps it out of recovery.
        const driver = new BasicDrivingComponent({
            ...DEFAULT_BASIC_DRIVING_OPTIONS,
            recovery: { ...DEFAULT_BASIC_DRIVING_OPTIONS.recovery, requireThrottle: true },
        });
        driver.maxSpeed = 0.5;
        const { vehicle, state } = fakeVehicle({ speed: 0.6 });
        driver.setTarget(0, 100);

        run(driver, vehicle, 6);

        expect(state.controls.some((c) => c.backward)).toBe(false);
    });

    it('never reverses during a normal analog approach and park', () => {
        // Under SMOOTH_DRIVING_OPTIONS, dist < 7.22 m (crawlSpeed * slowRadius
        // / cruiseSpeed = 2.5 * 26 / 9) is enough to pull the eased target
        // below crawlSpeed, so the Math.max(crawlSpeed, eased) floor is
        // actually BINDING for the entire final approach band down to
        // arriveRadius (4.5 m) — not a corner case. With the floor holding
        // the target at 2.5, real speed settles around ~2.38 m/s there (the
        // same proportional-drag offset as the cruise case) and never dips
        // toward the 1.5 m/s stuck bar at all — a comfortable 0.88 m/s of
        // margin. The one place real speed DOES legitimately dip under 1.5
        // is the opposite end of the run: launching from a standing start,
        // full-saturated throttle takes ~0.18 s (11 frames) to accelerate
        // through it — measured on the shipped config, this is the entire
        // 0.183 s of stuckTimer accrued across the whole 30 s run, a 13x
        // margin under the 2.5 s timeThreshold. Once inside arriveRadius the
        // arrival branch's early return exempts the final hard stop from the
        // stuck check too. See the next test for a config where the crawl
        // floor's margin over the stuck bar is gone.
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 60);

        run(driver, vehicle, 30);

        expect(state.controls.some((c) => c.backward)).toBe(false);
    });

    it('a slow-cruising driver below the absolute stuck floor relies on the fraction cap, not requireThrottle', () => {
        // A driver deliberately cruising BELOW the absolute stuck floor
        // (1.5 m/s). The analog controller's steady-state throttle here is
        // small but never zero (settles at speed 0.952, throttle ~0.048 —
        // the same proportional-drag offset seen elsewhere), so
        // requireThrottle alone cannot save it: lastThrottleCommanded stays
        // positive forever, so askingForThrottle is always true. Only the
        // fraction cap (speedFractionOfTarget) saves it, by pulling the
        // stuck bar itself down below the cruise speed (min(1.5, 1.0*0.35)
        // = 0.35, comfortably under the 0.952 m/s settled speed).
        const driver = new BasicDrivingComponent({
            ...SMOOTH_DRIVING_OPTIONS,
            cruiseSpeed: 1.0,
            slowRadius: 0,
        });
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 1000);

        run(driver, vehicle, 20);

        expect(state.controls.some((c) => c.backward)).toBe(false);
    });

    it('adjusts the stuck bar to the eased target, not just the configured cruise', () => {
        // Spreading a smaller crawlSpeed/arriveRadius onto SMOOTH_DRIVING_OPTIONS
        // is exactly the kind of one-field tweak its own JSDoc invites
        // ("Spread it to adjust one field"). Before this fix, the stuck bar
        // was computed from the *configured* cruiseSpeed (9), so the fraction
        // cap clamped to the absolute 1.5 m/s floor regardless of how slow
        // the eased crawl target actually was — a car genuinely gliding at
        // ~0.76 m/s near the destination read as stuck and reversed.
        const driver = new BasicDrivingComponent({
            ...SMOOTH_DRIVING_OPTIONS,
            arriveRadius: 1,
            crawlSpeed: 0.8,
        });
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 60);

        run(driver, vehicle, 30);

        expect(state.controls.some((c) => c.backward)).toBe(false);
    });

    it('brakes instead of emitting NaN when the target produces a non-finite distance', () => {
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = fakeVehicle({ speed: 5 });
        driver.setTarget(NaN, 100); // e.g. game code normalizing a zero-length vector

        run(driver, vehicle, 1);

        expect(state.controls.length).toBeGreaterThan(0);
        for (const c of state.controls) {
            expect(Number.isNaN(c.throttle ?? 0)).toBe(false);
            expect(Number.isNaN(c.brakeAmount ?? 0)).toBe(false);
            expect(c.brake).toBe(true);
            expect(c.forward).toBe(false);
            expect(c.backward).toBe(false);
        }
    });

    it('brakes instead of emitting NaN when dist is exactly 0 and arriveRadius is configured to 0', () => {
        // dx/dist below the arrival check is 0/0 = NaN whenever the vehicle is
        // sitting exactly on the target AND arriveRadius is 0 — the finite
        // guard above only catches NaN/Infinity, not an exact zero, so this
        // needs its own floor (Math.max(arriveRadius, 1e-6)).
        const driver = new BasicDrivingComponent({ ...DEFAULT_BASIC_DRIVING_OPTIONS, arriveRadius: 0 });
        const { vehicle, state } = fakeVehicle({ speed: 5, x: 10, z: 10 });
        driver.setTarget(10, 10); // exactly on top of the vehicle: dist === 0

        run(driver, vehicle, 1);

        expect(state.controls.length).toBeGreaterThan(0);
        for (const c of state.controls) {
            expect(Number.isNaN(c.steer ?? 0)).toBe(false);
            expect(Number.isNaN(c.throttle ?? 0)).toBe(false);
            expect(Number.isNaN(c.brakeAmount ?? 0)).toBe(false);
            expect(c.brake).toBe(true);
        }
    });

    it('brakes instead of emitting NaN when getSpeed() is non-finite', () => {
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = fakeVehicle({ speed: NaN }); // e.g. a diverged physics body
        driver.setTarget(0, 100);

        run(driver, vehicle, 1);

        expect(state.controls.length).toBeGreaterThan(0);
        for (const c of state.controls) {
            expect(Number.isNaN(c.throttle ?? 0)).toBe(false);
            expect(Number.isNaN(c.brakeAmount ?? 0)).toBe(false);
            expect(c.brake).toBe(true);
            expect(c.forward).toBe(false);
            expect(c.backward).toBe(false);
        }
    });

    it('cruiseSpeed 0 with maxSpeed 0 drives full throttle instead of parking and reversing', () => {
        // A natural spread: { ...DEFAULT_BASIC_DRIVING_OPTIONS, analogThrottle: true }.
        // maxSpeed's "0 = unlimited" convention would otherwise invert to
        // "0 = never move" under analog throttle, and a car that never moves
        // reads as stuck and starts reversing after timeThreshold.
        const driver = new BasicDrivingComponent({ ...DEFAULT_BASIC_DRIVING_OPTIONS, analogThrottle: true });
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 1000);

        run(driver, vehicle, 3);

        expect(state.controls.some((c) => c.backward)).toBe(false);
        expect(state.controls.every((c) => (c.throttle ?? 0) > 0)).toBe(true);
    });
});

describe('progress watchdog', () => {
    it('reports unreachable once a pinned car stops making progress', () => {
        // fakeVehicle never changes position, so the distance to the target
        // never improves — exactly the wedged-against-a-kerb case.
        const { vehicle } = fakeVehicle({ speed: 0 });
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        driver.setTarget(0, 100);

        run(driver, vehicle, 7);
        expect(driver.getDrivingStatus().unreachable).toBe(false);

        run(driver, vehicle, 3); // total 10 s, past the 8 s default timeout
        const status = driver.getDrivingStatus();
        expect(status.unreachable).toBe(true);
        expect(status.bestDistance).toBeCloseTo(100, 1);
        expect(status.secondsWithoutProgress).toBeGreaterThan(8);
    });

    it('never reports unreachable while the car is closing on its target', () => {
        // respondingVehicle advances +z under throttle, so the distance falls.
        const { vehicle } = respondingVehicle();
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        driver.setTarget(0, 100);

        run(driver, vehicle, 10);

        const status = driver.getDrivingStatus();
        expect(status.unreachable).toBe(false);
        expect(status.bestDistance).toBeLessThan(60);
    });

    it('resets when the target moves, but not when the same target is re-set', () => {
        const { vehicle } = fakeVehicle({ speed: 0 });
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);

        // A waypoint follower re-sets the SAME target every single frame. That
        // must not keep the watchdog permanently alive.
        for (let t = 0; t < 10; t += DT) {
            driver.setTarget(0, 100);
            driver.update(DT, vehicle);
        }
        expect(driver.getDrivingStatus().unreachable).toBe(true);

        // Advancing to the next waypoint is a fresh start: the distance to it
        // is larger, which must not read as failure.
        driver.setTarget(0, 200);
        const status = driver.getDrivingStatus();
        expect(status.unreachable).toBe(false);
        expect(status.secondsWithoutProgress).toBe(0);
        expect(status.bestDistance).toBe(Infinity);
    });

    it('clears the watchdog on arrival, so a parked car never reports unreachable', () => {
        const { vehicle, state } = fakeVehicle({ speed: 0 });
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        driver.setTarget(0, 100);

        run(driver, vehicle, 10);
        expect(driver.getDrivingStatus().unreachable).toBe(true);

        // The car finally gets there: 1 m out, inside SMOOTH's 4.5 m arriveRadius.
        state.z = 99;
        run(driver, vehicle, 1);

        expect(driver.getDrivingStatus().unreachable).toBe(false);
    });
});

describe('setCruiseOverride', () => {
    // VehiclePathDrivingComponent's corner-slowdown feature (task 6) is the
    // only caller; these pin the contract it depends on directly against the
    // concrete class, independent of that follower.

    it('caps an analog cruise speed below its configured value', () => {
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 1000); // far away — no arrival easing in play
        driver.setCruiseOverride(3); // well under the 9 m/s configured cruise

        run(driver, vehicle, 8);

        expect(state.speed).toBeLessThanOrEqual(3);
        expect(state.speed).toBeGreaterThan(0.5 * 3); // actually settled near the cap, not stalled
    });

    it('caps the Infinity case (cruiseSpeed 0 / maxSpeed 0) — the whole point on a straightaway', () => {
        // cruiseSpeed 0 with maxSpeed 0 resolves to Infinity in targetSpeedFor
        // (see the "cruiseSpeed 0 with maxSpeed 0" test above) — an override
        // must still cap that, or corner slowdown would have no effect on the
        // very config where speed is otherwise completely unbounded.
        const driver = new BasicDrivingComponent({ ...DEFAULT_BASIC_DRIVING_OPTIONS, analogThrottle: true });
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 1000);
        driver.setCruiseOverride(2.5);

        run(driver, vehicle, 8);

        expect(state.speed).toBeLessThanOrEqual(2.5);
        // Settled, not pinned at full send — the tail of the run only, since
        // the initial ramp-up from a standstill legitimately saturates.
        const settled = state.controls.slice(-60);
        expect(settled.every((c) => (c.throttle ?? 0) < 1)).toBe(true);
    });

    it('does not undercut the crawlSpeed/arrival easing floor when the override is larger', () => {
        // Deep in the arrival easing band (well inside slowRadius), the
        // resolved target is already down near crawlSpeed. A generous
        // override (as a straight-road corner speed would be) must leave it
        // alone rather than pulling it down further via a naive additional
        // clamp.
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 6); // well inside the 26m slowRadius, near crawlSpeed territory
        driver.setCruiseOverride(40); // a wide-open "straight road" corner speed

        run(driver, vehicle, 3);

        // Same shape as the "eases down to a crawl" pinned test above: speed
        // settles near crawlSpeed (2.5), nowhere near the override's 40.
        expect(state.speed).toBeLessThan(SMOOTH_DRIVING_OPTIONS.crawlSpeed + 1.5);
    });

    it('a null override clears the cap and restores the configured cruise', () => {
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 1000);
        driver.setCruiseOverride(2);

        run(driver, vehicle, 6);
        expect(state.speed).toBeLessThanOrEqual(2);

        driver.setCruiseOverride(null);
        run(driver, vehicle, 8);

        expect(state.speed).toBeGreaterThan(0.9 * SMOOTH_DRIVING_OPTIONS.cruiseSpeed);
    });

    it('is invisible until called — default behaviour is bit-for-bit unaffected', () => {
        // A driver that never calls setCruiseOverride must behave exactly as
        // it did before the method existed. Mirrors the pinned "holds the
        // cruise speed" test above verbatim.
        const driver = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
        const { vehicle, state } = respondingVehicle();
        driver.setTarget(0, 1000);

        run(driver, vehicle, 12);

        expect(state.speed).toBeGreaterThan(0.9 * SMOOTH_DRIVING_OPTIONS.cruiseSpeed);
        expect(state.speed).toBeLessThanOrEqual(SMOOTH_DRIVING_OPTIONS.cruiseSpeed);
    });
});
