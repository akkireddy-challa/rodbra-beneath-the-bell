import { movesAwayFrom } from 'engine/physics/TrappedBodies.js';

describe('trapped bodies: ignore a penetrating body only when moving away from it', () => {
    const self = { x: 0, z: 0 };
    const east = { x: 0.3, z: 0 };   // a body inside the capsule, to the east

    it('a move away from the body, or tangent to it, ignores it', () => {
        expect(movesAwayFrom({ x: -0.08, z: 0 }, self, east)).toBe(true);
        expect(movesAwayFrom({ x: 0, z: 0.08 }, self, east)).toBe(true);
    });

    it('a move into the body keeps it solid', () => {
        expect(movesAwayFrom({ x: 0.08, z: 0 }, self, east)).toBe(false);
        expect(movesAwayFrom({ x: 0.05, z: 0.05 }, self, east)).toBe(false);
    });

    it('a body sitting exactly on the centre has no "toward" and is ignored', () => {
        expect(movesAwayFrom({ x: 0.08, z: 0 }, self, { x: 0, z: 0 })).toBe(true);
    });
});
