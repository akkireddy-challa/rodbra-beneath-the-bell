import {
    AUTHORED_STEP_HEIGHT_M,
    MAX_WORLD_STEP_HEIGHT_M,
    stepHeightForWorld,
} from 'engine/WalkingAndJumpingMovement.js';

describe('stepHeightForWorld', () => {
    it('keeps the authored limit for a world with no blocks', () => {
        // Every non-voxel world: its profile carries no voxelBlockSize at all.
        expect(stepHeightForWorld(undefined)).toBe(AUTHORED_STEP_HEIGHT_M);
    });

    it('lets a character step onto a one-block ledge in a 1 m block world', () => {
        // The regression: a 1 m ledge against a 0.65 m limit is unmountable, so
        // the player walks into every ledge the world is built from.
        expect(stepHeightForWorld(1)).toBeGreaterThan(1);
        expect(stepHeightForWorld(1)).toBeLessThanOrEqual(MAX_WORLD_STEP_HEIGHT_M);
    });

    it('does not lower the limit for worlds with blocks smaller than a curb', () => {
        for (const size of [0.25, 0.5, 0.6]) {
            expect(stepHeightForWorld(size)).toBe(AUTHORED_STEP_HEIGHT_M);
        }
    });

    it('caps an oversized block so it reads as a wall to jump, not a step', () => {
        expect(stepHeightForWorld(2)).toBe(MAX_WORLD_STEP_HEIGHT_M);
        expect(stepHeightForWorld(50)).toBe(MAX_WORLD_STEP_HEIGHT_M);
    });

    it('ignores a nonsensical block size rather than trusting it', () => {
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(stepHeightForWorld(bad)).toBe(AUTHORED_STEP_HEIGHT_M);
        }
    });
});
