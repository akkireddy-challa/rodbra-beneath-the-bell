import {
    resolveDepenetration,
    DEPEN_REVERT_DIST,
    DEPEN_MAX_RISE,
    DEPEN_FRAME_RISE,
} from 'engine/WalkingAndJumpingMovement.js';

const DT = 1 / 60; // 8 * dt > DEPEN_FRAME_RISE, so the per-frame cap is the binding one
const at = (x: number, y: number, z: number) => ({ x, y, z });

describe('resolveDepenetration', () => {
    it('reverts to a nearby free position instead of climbing', () => {
        // The reported bug: walking into a tree floated the player up the trunk and
        // parked them on the canopy. Standing free a step away, the rescue is to go
        // back there — no height gain at all.
        const r = resolveDepenetration(at(0, 1.74, 13.9), at(0, 1.74, 12.5), true, 0, DT);
        expect(r.pos).toEqual(at(0, 1.74, 12.5));
        expect(r.riseUsed).toBe(0);
        expect(r.moved).toBe(true);
    });

    it('floats up when the remembered position is too far to revert to', () => {
        const far = at(0, 1.74, 13.9 - (DEPEN_REVERT_DIST + 0.1));
        const r = resolveDepenetration(at(0, 1.74, 13.9), far, true, 0, DT);
        expect(r.pos.z).toBe(13.9);
        expect(r.pos.y).toBeCloseTo(1.74 + DEPEN_FRAME_RISE, 6);
        expect(r.riseUsed).toBeCloseTo(DEPEN_FRAME_RISE, 6);
    });

    it('floats up when the remembered position is no longer clear', () => {
        // A block placed at the player's feet: reverting would bury them there, so the
        // upward float has to take over.
        const r = resolveDepenetration(at(0, 1.74, 13.9), at(0, 1.74, 13.85), false, 0, DT);
        expect(r.pos.y).toBeCloseTo(1.74 + DEPEN_FRAME_RISE, 6);
        expect(r.pos.z).toBe(13.9);
    });

    it('floats up when nothing free was ever recorded', () => {
        const r = resolveDepenetration(at(0, 1.74, 13.9), null, false, 0, DT);
        expect(r.pos.y).toBeCloseTo(1.74 + DEPEN_FRAME_RISE, 6);
    });

    it('caps the float in total across an episode', () => {
        const nearlySpent = DEPEN_MAX_RISE - 0.05;
        const r = resolveDepenetration(at(0, 5, 0), null, false, nearlySpent, DT);
        expect(r.pos.y).toBeCloseTo(5.05, 6);
        expect(r.riseUsed).toBeCloseTo(DEPEN_MAX_RISE, 6);

        // Budget spent: no further lift, and the caller is told nothing moved.
        const spent = resolveDepenetration(at(0, 5.05, 0), null, false, DEPEN_MAX_RISE, DT);
        expect(spent.pos.y).toBe(5.05);
        expect(spent.riseUsed).toBeCloseTo(DEPEN_MAX_RISE, 6);
        expect(spent.moved).toBe(false);
    });

    it('never lifts more than the frame cap on a long frame', () => {
        const r = resolveDepenetration(at(0, 1, 0), null, false, 0, 1.0);
        expect(r.pos.y - 1).toBeCloseTo(DEPEN_FRAME_RISE, 6);
    });

    it('lifts less than the frame cap on a very short frame', () => {
        const dt = 0.001; // 8 * dt = 0.008 < DEPEN_FRAME_RISE
        const r = resolveDepenetration(at(0, 1, 0), null, false, 0, dt);
        expect(r.pos.y - 1).toBeCloseTo(0.008, 6);
    });

    it('cannot climb out of a canopy over repeated frames', () => {
        // 2 m of canopy above the capsule: the total cap must stop it short of the top
        // even with no revert available.
        let pos = at(0, 3.5, 0), used = 0;
        for (let i = 0; i < 400; i++) {
            const r = resolveDepenetration(pos, null, false, used, DT);
            pos = r.pos; used = r.riseUsed;
        }
        expect(pos.y).toBeCloseTo(3.5 + DEPEN_MAX_RISE, 6);
        expect(pos.y).toBeLessThan(5.5 + 0.5); // nowhere near clearing a 4.5 m tree
    });
});
