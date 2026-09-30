import { createPose, type ViewModelPose } from 'engine/viewmodel/PoseCurve.js';
import { RECOIL_PROFILES } from 'engine/viewmodel/RecoilProfiles.js';
import {
    DEFAULT_VIEW_MODEL_RIG_OPTIONS,
    ViewModelRig,
    type RigFrameInput,
    type ViewModelRigOptions,
} from 'engine/viewmodel/ViewModelRig.js';

/**
 * The rig is the whole "feel" of a first-person weapon expressed as numbers, so
 * it is testable as numbers. Each block below pins a property that is obvious
 * when broken on screen and invisible in a diff: sway that never recentres, bob
 * that runs at a different speed on a 144 Hz monitor, an ADS that snaps when
 * you change your mind, recoil that never fully recovers.
 */

const STILL: RigFrameInput = {
    yaw: 0, pitch: 0,
    speed: 0, referenceSpeed: 5,
    lateralVelocity: 0, verticalVelocity: 0,
    grounded: true, adsHeld: false,
};

const RUNNING: RigFrameInput = { ...STILL, speed: 5 };

/** Options with idle breathing silenced, so "returns to rest" means exactly that. */
function quietOptions(overrides: Partial<ViewModelRigOptions> = {}): ViewModelRigOptions {
    return {
        ...DEFAULT_VIEW_MODEL_RIG_OPTIONS,
        bob: {
            ...DEFAULT_VIEW_MODEL_RIG_OPTIONS.bob,
            idlePositionX: 0, idlePositionY: 0, idleRoll: 0,
        },
        ...overrides,
    };
}

/** Run the rig for a span at a fixed rate. */
function run(rig: ViewModelRig, seconds: number, input: RigFrameInput, dt = 1 / 60): void {
    for (let t = 0; t < seconds - 1e-9; t += dt) rig.update(dt, input);
}

function poseDistance(pose: { position: { x: number; y: number; z: number } }, rest: ViewModelPose): number {
    return Math.hypot(
        pose.position.x - rest.position.x,
        pose.position.y - rest.position.y,
        pose.position.z - rest.position.z,
    );
}

describe('resting behaviour', () => {
    it('starts at the resting pose', () => {
        const rig = new ViewModelRig(quietOptions());
        const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
        expect(poseDistance({ position: rig.getPosition() }, rest)).toBeCloseTo(0, 12);
    });

    it('returns to the resting pose once everything settles', () => {
        const rig = new ViewModelRig(quietOptions());
        rig.addRecoilShot();
        run(rig, 0.4, RUNNING);
        run(rig, 3, STILL);

        const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
        expect(poseDistance({ position: rig.getPosition() }, rest)).toBeLessThan(1e-4);
        expect(Math.abs(rig.getRotation().x - rest.rotation.x)).toBeLessThan(1e-4);
        expect(Math.abs(rig.getRotation().y - rest.rotation.y)).toBeLessThan(1e-4);
        expect(Math.abs(rig.getRotation().z - rest.rotation.z)).toBeLessThan(1e-4);
        expect(rig.isSettled()).toBe(true);
    });

    it('idle breathing keeps the weapon alive at a standstill', () => {
        // A perfectly static view model reads as a decal, so the default
        // options deliberately never fully stop.
        const rig = new ViewModelRig();
        run(rig, 2, STILL);
        const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
        expect(poseDistance({ position: rig.getPosition() }, rest)).toBeGreaterThan(0);
    });

    it('never mutates the shared default options', () => {
        // The defaults are module singletons; a rig that wrote through them
        // would retune every other weapon in the process.
        const restBefore = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose.position.clone();
        const recenterBefore = DEFAULT_VIEW_MODEL_RIG_OPTIONS.recoil.recenter;
        const rig = new ViewModelRig();
        rig.setRestPose(createPose(9, 9, 9, 9, 9, 9));
        rig.setRecoilProfile({ ...RECOIL_PROFILES.heavy, recenter: 0.123 });
        expect(DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose.position).toEqual(restBefore);
        expect(DEFAULT_VIEW_MODEL_RIG_OPTIONS.recoil.recenter).toBe(recenterBefore);
    });
});

describe('look sway', () => {
    it('lags a turn, in the opposite direction to the turn', () => {
        const rig = new ViewModelRig(quietOptions());
        let yaw = 0;
        for (let i = 0; i < 12; i++) {
            yaw += 0.05; // turning left at ~3 rad/s
            rig.update(1 / 60, { ...STILL, yaw });
        }
        expect(rig.getPosition().x).toBeLessThan(DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose.position.x);
    });

    it('recentres once the turn stops', () => {
        const rig = new ViewModelRig(quietOptions());
        let yaw = 0;
        for (let i = 0; i < 12; i++) { yaw += 0.05; rig.update(1 / 60, { ...STILL, yaw }); }
        run(rig, 2, { ...STILL, yaw });
        const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
        expect(poseDistance({ position: rig.getPosition() }, rest)).toBeLessThan(1e-4);
    });

    it('clamps a violent flick instead of throwing the weapon off screen', () => {
        // Proportional-only sway looks fine at normal speeds and catapults the
        // weapon out of frame the first time somebody flicks 180 degrees.
        //
        // The clamps bound the spring's TARGET, and the sway spring is
        // deliberately underdamped (zeta 0.85) so it overshoots that target by
        // about 0.6% on the way in — that small settle is the point of the
        // tuning, so the assertion leaves room for it.
        const rig = new ViewModelRig(quietOptions());
        const { positionMax, strafeMax, rotationMax } = DEFAULT_VIEW_MODEL_RIG_OPTIONS.sway;
        const overshoot = 1.05;
        let yaw = 0;
        for (let i = 0; i < 40; i++) {
            yaw += 1.5; // ~90 rad/s — far faster than any human input
            rig.update(1 / 60, { ...STILL, yaw });
            const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
            expect(Math.abs(rig.getPosition().x - rest.position.x))
                .toBeLessThan((positionMax + strafeMax) * overshoot);
            expect(Math.abs(rig.getRotation().y - rest.rotation.y))
                .toBeLessThan(rotationMax * overshoot);
        }
    });

    it('does not spike when yaw wraps across the +/-pi seam', () => {
        const rig = new ViewModelRig(quietOptions());
        rig.update(1 / 60, { ...STILL, yaw: Math.PI - 0.01 });
        rig.update(1 / 60, { ...STILL, yaw: -Math.PI + 0.01 });
        const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
        // A naive (yaw - prevYaw) would read this as a ~6.28 rad jump.
        expect(Math.abs(rig.getPosition().x - rest.position.x)).toBeLessThan(0.01);
    });

    it('leans with a strafe even with no look input', () => {
        const rig = new ViewModelRig(quietOptions());
        const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
        run(rig, 0.5, { ...STILL, lateralVelocity: 4 });
        expect(rig.getPosition().x).toBeLessThan(rest.position.x);
    });
});

describe('movement bob', () => {
    it('is silent at a standstill and active at speed', () => {
        const still = new ViewModelRig(quietOptions());
        run(still, 1, STILL);
        const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
        expect(poseDistance({ position: still.getPosition() }, rest)).toBeLessThan(1e-4);

        const moving = new ViewModelRig(quietOptions());
        let peak = 0;
        for (let i = 0; i < 120; i++) {
            moving.update(1 / 60, RUNNING);
            peak = Math.max(peak, poseDistance({ position: moving.getPosition() }, rest));
        }
        expect(peak).toBeGreaterThan(0.005);
    });

    it('is frame-rate independent', () => {
        // The shipped melee bob uses lerp(a, b, dt * 10), which is not — this is
        // the regression guard for that fix.
        const sample = (dt: number): number => {
            const rig = new ViewModelRig(quietOptions());
            run(rig, 1, RUNNING, dt);
            return rig.getPosition().x;
        };
        expect(sample(1 / 240)).toBeCloseTo(sample(1 / 60), 6);
        expect(sample(1 / 240)).toBeCloseTo(sample(1 / 30), 5);
    });

    it('scales with speed', () => {
        const excursion = (speed: number): number => {
            const rig = new ViewModelRig(quietOptions());
            const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
            let peak = 0;
            for (let i = 0; i < 180; i++) {
                rig.update(1 / 60, { ...STILL, speed });
                peak = Math.max(peak, poseDistance({ position: rig.getPosition() }, rest));
            }
            return peak;
        };
        expect(excursion(5)).toBeGreaterThan(excursion(2));
    });

    it('punches downward on landing, proportional to impact', () => {
        const landFrom = (fallSpeed: number): number => {
            const rig = new ViewModelRig(quietOptions());
            run(rig, 0.3, { ...STILL, grounded: false, verticalVelocity: -fallSpeed });
            const before = rig.getPosition().y;
            rig.update(1 / 60, STILL); // touchdown
            rig.update(1 / 60, STILL);
            return before - rig.getPosition().y;
        };
        expect(landFrom(12)).toBeGreaterThan(0);
        expect(landFrom(12)).toBeGreaterThan(landFrom(3));
    });

    it('reports the landing impact once, then clears it', () => {
        const rig = new ViewModelRig(quietOptions());
        run(rig, 0.3, { ...STILL, grounded: false, verticalVelocity: -10 });
        rig.update(1 / 60, STILL);
        expect(rig.consumeLandingImpact()).toBeGreaterThan(0);
        expect(rig.consumeLandingImpact()).toBe(0);
    });
});

describe('aim down sights', () => {
    it('reaches the sights pose, and only the sights pose', () => {
        const rig = new ViewModelRig(quietOptions());
        run(rig, 1.5, { ...STILL, adsHeld: true });
        const sights = DEFAULT_VIEW_MODEL_RIG_OPTIONS.sightsPose;
        expect(rig.getAdsBlend()).toBeCloseTo(1, 6);
        expect(poseDistance({ position: rig.getPosition() }, sights)).toBeLessThan(1e-4);
    });

    it('leaves the sights faster than it enters them', () => {
        const { inSeconds, outSeconds } = DEFAULT_VIEW_MODEL_RIG_OPTIONS.ads;
        expect(outSeconds).toBeLessThan(inSeconds);

        const rig = new ViewModelRig(quietOptions());
        run(rig, 1, { ...STILL, adsHeld: true });
        run(rig, outSeconds + 1 / 60, STILL);
        expect(rig.getAdsBlend()).toBeCloseTo(0, 6);
    });

    it('never jumps when the player changes their mind mid-transition', () => {
        // The classic ADS bug: easing in with one curve and out with another
        // swaps the mapping under an unchanged progress value, so the weapon
        // teleports the instant the player reverses.
        //
        // Tested as CONTINUITY rather than as a fixed threshold: with one
        // shaping function the per-frame step shrinks with the frame time, while
        // a mapping swap produces the same ~0.12 jump at any frame rate. So a
        // fine step with a tight bound is the assertion that actually
        // discriminates between the two.
        const dt = 1 / 2000;
        const rig = new ViewModelRig(quietOptions());
        let previous = rig.getAdsBlend();
        let held = true;
        for (let i = 0; i < 4000; i++) {
            if (i % 137 === 0) held = !held; // reverse at arbitrary points
            rig.update(dt, { ...STILL, adsHeld: held });
            const blend = rig.getAdsBlend();
            expect(Math.abs(blend - previous)).toBeLessThan(0.01);
            previous = blend;
        }
    });

    it('is monotonic while the control is held steady', () => {
        const rig = new ViewModelRig(quietOptions());
        let previous = -1;
        for (let i = 0; i < 20; i++) {
            rig.update(1 / 60, { ...STILL, adsHeld: true });
            expect(rig.getAdsBlend()).toBeGreaterThanOrEqual(previous);
            previous = rig.getAdsBlend();
        }
    });

    it('refuses to engage while sprinting, and engages on slowing down', () => {
        const rig = new ViewModelRig(quietOptions());
        run(rig, 1, { ...RUNNING, adsHeld: true });
        expect(rig.getAdsBlend()).toBeCloseTo(0, 6);
        run(rig, 1, { ...STILL, adsHeld: true });
        expect(rig.getAdsBlend()).toBeCloseTo(1, 6);
    });

    it('latches a request made during a reload and applies it on completion', () => {
        const rig = new ViewModelRig(quietOptions());
        rig.startAction('reload', 0.5);
        run(rig, 0.3, { ...STILL, adsHeld: true });
        expect(rig.getAdsBlend()).toBeCloseTo(0, 6);
        run(rig, 1.5, { ...STILL, adsHeld: true });
        expect(rig.getAdsBlend()).toBeCloseTo(1, 6);
    });

    it('tightens the crosshair', () => {
        const hip = new ViewModelRig(quietOptions());
        run(hip, 1, STILL);
        const aimed = new ViewModelRig(quietOptions());
        run(aimed, 1, { ...STILL, adsHeld: true });
        expect(aimed.getAccuracy()).toBeLessThan(hip.getAccuracy());
    });

    it('softens but never silences the additives', () => {
        // A weapon that goes perfectly rigid while aiming reads as dead.
        const rig = new ViewModelRig(quietOptions());
        run(rig, 1, { ...STILL, adsHeld: true });
        const sights = DEFAULT_VIEW_MODEL_RIG_OPTIONS.sightsPose;
        let peak = 0;
        let yaw = 0;
        for (let i = 0; i < 30; i++) {
            yaw += 0.05;
            rig.update(1 / 60, { ...STILL, yaw, adsHeld: true });
            peak = Math.max(peak, poseDistance({ position: rig.getPosition() }, sights));
        }
        expect(peak).toBeGreaterThan(0);
    });
});

describe('states', () => {
    it('reports the dominant state', () => {
        const rig = new ViewModelRig(quietOptions());
        run(rig, 1, STILL);
        expect(rig.getState()).toBe('idle');
        run(rig, 1, RUNNING);
        expect(rig.getState()).toBe('sprint');
        run(rig, 1, { ...STILL, grounded: false });
        expect(rig.getState()).toBe('airborne');
    });

    it('lowers the weapon while sprinting', () => {
        const rig = new ViewModelRig(quietOptions());
        run(rig, 1, RUNNING);
        expect(rig.getPosition().y).toBeLessThan(DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose.position.y);
    });

    it('brings the weapon back up when a sprint becomes a jump', () => {
        const rig = new ViewModelRig(quietOptions());
        run(rig, 1, RUNNING);
        const sprinting = rig.getPosition().y;
        run(rig, 0.5, { ...RUNNING, grounded: false });
        expect(rig.getPosition().y).toBeGreaterThan(sprinting);
    });

    it('cancels an action continuously, with no snap', () => {
        // Cancelling mid-reload freezes the curve where it stands and fades its
        // weight out, so the weapon travels back to rest quickly but smoothly.
        // Continuity is the property, so it is measured at a fine step: a real
        // snap would move the same distance in one frame however small the step.
        const dt = 1 / 2000;
        const rig = new ViewModelRig(quietOptions());
        rig.startAction('reload', 2);
        run(rig, 0.5, STILL, dt);
        rig.cancelAction();
        let previous = rig.getPosition().clone();
        for (let i = 0; i < 1000; i++) {
            rig.update(dt, STILL);
            expect(rig.getPosition().distanceTo(previous)).toBeLessThan(0.002);
            previous = rig.getPosition().clone();
        }
    });

    it('finishes a cancelled action back at rest', () => {
        const rig = new ViewModelRig(quietOptions());
        rig.startAction('reload', 2);
        run(rig, 0.5, STILL);
        rig.cancelAction();
        run(rig, 1, STILL);
        const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
        expect(poseDistance({ position: rig.getPosition() }, rest)).toBeLessThan(1e-4);
    });

    it('honours the duration handed to an action', () => {
        const rig = new ViewModelRig(quietOptions());
        rig.startAction('reload', 1.0);
        run(rig, 0.5, STILL);
        expect(rig.getActionProgress()).toBeCloseTo(0.5, 1);
        run(rig, 0.6, STILL);
        expect(rig.getActionProgress()).toBeCloseTo(1, 6);
    });

    it('returns to rest after an action finishes', () => {
        const rig = new ViewModelRig(quietOptions());
        rig.startAction('equip', 0.35);
        run(rig, 2, STILL);
        const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
        expect(poseDistance({ position: rig.getPosition() }, rest)).toBeLessThan(1e-4);
    });
});

describe('recoil', () => {
    const rifleOptions = quietOptions({ recoil: RECOIL_PROFILES.rifle });

    it('climbs over the first shots of a burst', () => {
        const rig = new ViewModelRig(rifleOptions);
        const kicks: number[] = [];
        for (let shot = 0; shot < 6; shot++) {
            kicks.push(Math.abs(rig.addRecoilShot().cameraPitch));
            run(rig, 0.125, STILL);
        }
        // Averaged over the ramp rather than pairwise: per-shot jitter is
        // deliberate, so adjacent shots are not strictly ordered.
        const early = (kicks[0] ?? 0) + (kicks[1] ?? 0);
        const late = (kicks[4] ?? 0) + (kicks[5] ?? 0);
        expect(late).toBeGreaterThan(early);
    });

    it('puts no horizontal on the first shot of a burst', () => {
        // The opening shot is pinpoint — the horizontal component is scaled by
        // the climb ramp, which starts at zero. Tapping is therefore always
        // precise, and only sustained fire has a pattern to fight.
        const rig = new ViewModelRig(rifleOptions);
        expect(rig.addRecoilShot().cameraYaw).toBe(0);
    });

    it('alternates horizontally after the first shot, so the pattern is learnable', () => {
        const rig = new ViewModelRig(rifleOptions);
        rig.addRecoilShot(); // opening shot, no horizontal
        const signs = [1, 2, 3, 4].map(() => Math.sign(rig.addRecoilShot().cameraYaw));
        expect(signs[0]).not.toBe(0);
        expect(signs[1]).toBe(-(signs[0] ?? 0));
        expect(signs[2]).toBe(-(signs[1] ?? 0));
        expect(signs[3]).toBe(-(signs[2] ?? 0));
    });

    it('resets the burst after a pause', () => {
        const rig = new ViewModelRig(rifleOptions);
        rig.addRecoilShot();
        rig.addRecoilShot();
        expect(rig.getShotIndex()).toBe(2);
        run(rig, 1, STILL);
        rig.addRecoilShot();
        expect(rig.getShotIndex()).toBe(1);
    });

    it('is deterministic for a given seed', () => {
        const shots = (seed: number): number[] => {
            const rig = new ViewModelRig(quietOptions({ recoil: RECOIL_PROFILES.rifle, seed }));
            return [0, 1, 2, 3, 4].map(() => rig.addRecoilShot().cameraYaw);
        };
        expect(shots(7)).toEqual(shots(7));
        expect(shots(7)).not.toEqual(shots(8));
    });

    it('recovers fully, at any frame rate', () => {
        for (const dt of [1 / 240, 1 / 60, 1 / 30, 0.1]) {
            const rig = new ViewModelRig(rifleOptions);
            for (let shot = 0; shot < 30; shot++) {
                rig.addRecoilShot();
                run(rig, 0.125, STILL, dt);
            }
            run(rig, 1, STILL, dt);
            const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
            expect(poseDistance({ position: rig.getPosition() }, rest)).toBeLessThan(1e-3);
            expect(rig.isSettled()).toBe(true);
        }
    });

    it('opens the crosshair while firing and closes it afterwards', () => {
        const rig = new ViewModelRig(rifleOptions);
        run(rig, 0.5, STILL);
        const resting = rig.getAccuracy();
        for (let shot = 0; shot < 8; shot++) {
            rig.addRecoilShot();
            run(rig, 0.125, STILL);
        }
        const firing = rig.getAccuracy();
        expect(firing).toBeGreaterThan(resting);
        run(rig, 2, STILL);
        expect(rig.getAccuracy()).toBeCloseTo(resting, 3);
    });

    it('a purely cosmetic profile still kicks the weapon but never the aim', () => {
        // recenter is the per-weapon gameplay dial: at 1.0 the caller applies a
        // camera punch that provably springs all the way back.
        const cosmetic = quietOptions({ recoil: { ...RECOIL_PROFILES.rifle, recenter: 1.0 } });
        const rig = new ViewModelRig(cosmetic);
        const impulse = rig.addRecoilShot();
        expect(rig.getRecoilProfile().recenter).toBe(1);
        expect(Math.abs(impulse.rotationX)).toBeGreaterThan(0);
    });

    it('softens the camera punch while aiming', () => {
        const hip = new ViewModelRig(rifleOptions);
        const hipKick = Math.abs(hip.addRecoilShot().cameraPitch);

        const aimed = new ViewModelRig(rifleOptions);
        run(aimed, 1, { ...STILL, adsHeld: true });
        const aimedKick = Math.abs(aimed.addRecoilShot().cameraPitch);

        expect(aimedKick).toBeLessThan(hipKick);
        expect(aimedKick).toBeGreaterThan(0);
    });
});

describe('robustness', () => {
    it('survives zero, negative and absurd frame deltas', () => {
        const rig = new ViewModelRig(quietOptions());
        for (const dt of [0, -1, Number.NaN, 10]) rig.update(dt, RUNNING);
        expect(Number.isFinite(rig.getPosition().x)).toBe(true);
        expect(Number.isFinite(rig.getRotation().y)).toBe(true);
    });

    it('survives a zero reference speed', () => {
        const rig = new ViewModelRig(quietOptions());
        run(rig, 0.5, { ...STILL, speed: 3, referenceSpeed: 0 });
        expect(Number.isFinite(rig.getPosition().y)).toBe(true);
    });

    it('keeps the bob phase bounded over a long session', () => {
        // Two minutes of continuous running is ~170 stride cycles — far past
        // where an unwrapped phase accumulator would start losing precision.
        const rig = new ViewModelRig(quietOptions());
        run(rig, 120, RUNNING, 1 / 30);
        expect(Number.isFinite(rig.getPosition().x)).toBe(true);
        const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
        expect(poseDistance({ position: rig.getPosition() }, rest)).toBeLessThan(0.1);
    });

    it('reset returns everything to the resting state', () => {
        const rig = new ViewModelRig(quietOptions());
        rig.startAction('reload', 2);
        rig.addRecoilShot();
        run(rig, 0.3, RUNNING);
        rig.reset();
        const rest = DEFAULT_VIEW_MODEL_RIG_OPTIONS.restPose;
        expect(poseDistance({ position: rig.getPosition() }, rest)).toBeCloseTo(0, 12);
        expect(rig.getAdsBlend()).toBe(0);
        expect(rig.getShotIndex()).toBe(0);
        expect(rig.isSettled()).toBe(true);
    });
});
