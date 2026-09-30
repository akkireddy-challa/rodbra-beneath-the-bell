import { DEFAULT_VIEW_MODEL_RIG_OPTIONS, ViewModelRig } from 'engine/viewmodel/ViewModelRig.js';

/** A heavy two-hander bobs less than a pistol: the per-weapon bob scale. */
describe('rig bob scale', () => {
    const quiet = {
        ...DEFAULT_VIEW_MODEL_RIG_OPTIONS,
        bob: { ...DEFAULT_VIEW_MODEL_RIG_OPTIONS.bob, idlePositionX: 0, idlePositionY: 0, idleRoll: 0 },
    };
    // WALKING, not sprinting: above the sprint threshold the rig also blends
    // in the lowered sprint pose, and that displacement is not bob.
    const running = {
        yaw: 0, pitch: 0, speed: 3, referenceSpeed: 5,
        lateralVelocity: 0, verticalVelocity: 0, grounded: true, adsHeld: false,
    };
    const excursion = (scale: number): number => {
        const rig = new ViewModelRig(quiet);
        rig.setBobScale(scale);
        const rest = quiet.restPose.position;
        let peak = 0;
        for (let i = 0; i < 120; i++) {
            rig.update(1 / 60, running);
            peak = Math.max(peak, rig.getPosition().distanceTo(rest));
        }
        return peak;
    };

    it('halves the bob at 0.5 and silences it at 0', () => {
        const full = excursion(1);
        expect(excursion(0.5)).toBeCloseTo(full * 0.5, 6);
        expect(excursion(0)).toBeCloseTo(0, 9);
    });

    it('rejects nonsense scales rather than exploding', () => {
        const rig = new ViewModelRig(quiet);
        rig.setBobScale(Number.NaN);
        rig.setBobScale(-3);
        expect(excursion(1)).toBeGreaterThan(0);
    });
});
