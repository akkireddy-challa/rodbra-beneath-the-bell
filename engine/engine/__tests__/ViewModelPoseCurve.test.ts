import * as THREE from 'three';
import {
    addScaledPose,
    createPose,
    createSwingCurve,
    easeInOutCubic,
    easeOutQuad,
    evaluatePoseCurve,
    mixPose,
    zeroPose,
    type PoseCurve,
} from 'engine/viewmodel/PoseCurve.js';
import {
    ACTION_CURVES,
    resolveBobGate,
    resolveSprintWeight,
    SPRINT_BLEND_HIGH,
    SPRINT_BLEND_LOW,
} from 'engine/viewmodel/ViewModelStates.js';

/**
 * The generic curve evaluator has to reproduce FirstPersonMeleeSystem's
 * hand-rolled three-phase swing blend EXACTLY, because the melee view model is
 * a shipped, tuned system that games already use — moving it onto this
 * evaluator must not change a single frame of its arcs.
 */

const WINDUP_END = 0.18;
const STRIKE_END = 0.62;

const WINDUP = createPose(0.14, 0.06, 0.08, -0.25, 0.55, 0.30);
const STRIKE = createPose(-0.34, -0.06, -0.22, -0.15, -1.05, -0.55);

/** The blend exactly as FirstPersonMeleeSystem.updateSwing computes it today. */
function legacySwing(t: number): { pos: THREE.Vector3; rot: THREE.Vector3 } {
    let fromRot: THREE.Vector3 | null = null;
    let fromPos: THREE.Vector3 | null = null;
    let rot: THREE.Vector3;
    let pos: THREE.Vector3;
    let blend: number;

    if (t < WINDUP_END) {
        blend = easeOutQuad(t / WINDUP_END);
        rot = WINDUP.rotation; pos = WINDUP.position;
    } else if (t < STRIKE_END) {
        blend = easeInOutCubic((t - WINDUP_END) / (STRIKE_END - WINDUP_END));
        fromRot = WINDUP.rotation; fromPos = WINDUP.position;
        rot = STRIKE.rotation; pos = STRIKE.position;
    } else {
        blend = 1 - easeOutQuad((t - STRIKE_END) / (1 - STRIKE_END));
        rot = STRIKE.rotation; pos = STRIKE.position;
    }

    const lerpFrom = (from: number, to: number): number => from + (to - from) * blend;
    return {
        pos: new THREE.Vector3(
            lerpFrom(fromPos?.x ?? 0, pos.x),
            lerpFrom(fromPos?.y ?? 0, pos.y),
            lerpFrom(fromPos?.z ?? 0, pos.z),
        ),
        rot: new THREE.Vector3(
            lerpFrom(fromRot?.x ?? 0, rot.x),
            lerpFrom(fromRot?.y ?? 0, rot.y),
            lerpFrom(fromRot?.z ?? 0, rot.z),
        ),
    };
}

describe('createSwingCurve reproduces the shipped melee swing', () => {
    it('matches the legacy blend at every point of the swing', () => {
        const curve = createSwingCurve(WINDUP, STRIKE, WINDUP_END, STRIKE_END);
        const out = zeroPose();
        for (let t = 0; t < 1; t += 1 / 512) {
            evaluatePoseCurve(curve, t, out);
            const legacy = legacySwing(t);
            expect(out.position.x).toBeCloseTo(legacy.pos.x, 12);
            expect(out.position.y).toBeCloseTo(legacy.pos.y, 12);
            expect(out.position.z).toBeCloseTo(legacy.pos.z, 12);
            expect(out.rotation.x).toBeCloseTo(legacy.rot.x, 12);
            expect(out.rotation.y).toBeCloseTo(legacy.rot.y, 12);
            expect(out.rotation.z).toBeCloseTo(legacy.rot.z, 12);
        }
    });

    it('starts and ends at the resting pose', () => {
        const curve = createSwingCurve(WINDUP, STRIKE, WINDUP_END, STRIKE_END);
        const out = zeroPose();
        for (const t of [0, 1]) {
            evaluatePoseCurve(curve, t, out);
            expect(out.position.length()).toBeCloseTo(0, 12);
            expect(out.rotation.length()).toBeCloseTo(0, 12);
        }
    });
});

describe('evaluatePoseCurve', () => {
    const curve: PoseCurve = [
        { t: 0, pose: zeroPose(), ease: easeOutQuad },
        { t: 0.5, pose: createPose(1, 2, 3, 4, 5, 6), ease: easeOutQuad },
        { t: 1, pose: zeroPose(), ease: (x) => x },
    ];

    it('clamps outside the curve rather than extrapolating', () => {
        const out = zeroPose();
        evaluatePoseCurve(curve, -5, out);
        expect(out.position.length()).toBe(0);
        evaluatePoseCurve(curve, 5, out);
        expect(out.position.length()).toBe(0);
    });

    it('eases with the curve attached to the segment it is ENDING, not starting', () => {
        const out = zeroPose();
        // 0 → 0.5 is eased by the key AT 0.5 (easeOutQuad)...
        evaluatePoseCurve(curve, 0.25, out);
        expect(out.position.x).toBeCloseTo(easeOutQuad(0.5), 12);
        // ...while 0.5 → 1 is eased by the key at 1 (linear), so the midpoint
        // of that segment is exactly half way back to rest.
        evaluatePoseCurve(curve, 0.75, out);
        expect(out.position.x).toBeCloseTo(0.5, 12);
    });

    it('handles empty and single-key curves without throwing', () => {
        const out = createPose(9, 9, 9, 9, 9, 9);
        evaluatePoseCurve([], 0.5, out);
        expect(out.position.length()).toBe(0);
        evaluatePoseCurve([{ t: 0, pose: createPose(1, 1, 1), ease: (x) => x }], 0.9, out);
        expect(out.position.x).toBe(1);
    });

    it('does not allocate a new pose per evaluation', () => {
        const out = zeroPose();
        const pos = out.position;
        evaluatePoseCurve(curve, 0.3, out);
        expect(out.position).toBe(pos);
    });
});

describe('pose arithmetic', () => {
    it('addScaledPose accumulates additive contributions', () => {
        const target = zeroPose();
        addScaledPose(target, createPose(1, 0, 0, 0, 1, 0), 0.5);
        addScaledPose(target, createPose(2, 0, 0, 0, 2, 0), 0.25);
        expect(target.position.x).toBeCloseTo(1, 12);
        expect(target.rotation.y).toBeCloseTo(1, 12);
    });

    it('mixPose blends toward the source', () => {
        const target = createPose(0, 0, 0);
        mixPose(target, createPose(4, 0, 0), 0.25);
        expect(target.position.x).toBeCloseTo(1, 12);
    });
});

describe('state tables', () => {
    it('every action curve has strictly ascending, normalised key times', () => {
        for (const [name, curve] of Object.entries(ACTION_CURVES)) {
            let previous = -Infinity;
            for (const key of curve) {
                expect(key.t).toBeGreaterThan(previous);
                previous = key.t;
            }
            expect(curve[0]?.t).toBe(0);
            expect(curve[curve.length - 1]?.t).toBe(1);
            expect(name.length).toBeGreaterThan(0);
        }
    });

    it('equip ends at rest and holster starts at rest', () => {
        // Otherwise the weapon would jump the instant an action finished.
        const out = zeroPose();
        evaluatePoseCurve(ACTION_CURVES.equip, 1, out);
        expect(out.position.length()).toBeCloseTo(0, 12);
        evaluatePoseCurve(ACTION_CURVES.holster, 0, out);
        expect(out.position.length()).toBeCloseTo(0, 12);
    });

    it('reload and inspect both start and end at rest', () => {
        const out = zeroPose();
        for (const curve of [ACTION_CURVES.reload, ACTION_CURVES.inspect]) {
            for (const t of [0, 1]) {
                evaluatePoseCurve(curve, t, out);
                expect(out.position.length()).toBeCloseTo(0, 12);
                expect(out.rotation.length()).toBeCloseTo(0, 12);
            }
        }
    });

    it('reload dips the weapon out of the aiming line in the middle', () => {
        const out = zeroPose();
        evaluatePoseCurve(ACTION_CURVES.reload, 0.5, out);
        expect(out.position.y).toBeLessThan(-0.05);
    });
});

describe('locomotion weights', () => {
    it('sprint blends in only above the sprint threshold, and only on the ground', () => {
        expect(resolveSprintWeight(0, true)).toBe(0);
        expect(resolveSprintWeight(SPRINT_BLEND_LOW, true)).toBe(0);
        expect(resolveSprintWeight(SPRINT_BLEND_HIGH, true)).toBe(1);
        expect(resolveSprintWeight(2, true)).toBe(1);
        // Jumping mid-sprint brings the weapon back up — you can shoot on landing.
        expect(resolveSprintWeight(2, false)).toBe(0);
    });

    it('sprint weight is monotonic across the blend band', () => {
        let previous = -1;
        for (let u = 0; u <= 1.2; u += 0.02) {
            const w = resolveSprintWeight(u, true);
            expect(w).toBeGreaterThanOrEqual(previous);
            previous = w;
        }
    });

    it('bob is fully off at a standstill and fully on at walking pace', () => {
        expect(resolveBobGate(0)).toBe(0);
        expect(resolveBobGate(1)).toBe(1);
        expect(resolveBobGate(0.15)).toBeGreaterThan(0);
        expect(resolveBobGate(0.15)).toBeLessThan(1);
    });
});
