import { resolvePhysicsPlane } from 'engine/GameplayPlane.js';
import type { GameData } from 'types/game.js';

const game = (over: Record<string, unknown>): GameData => over as unknown as GameData;

describe('resolvePhysicsPlane — which plane the 2D world simulates', () => {
    it('a top-down camera plays on the X/Z ground plane', () => {
        expect(resolvePhysicsPlane(game({ worldProfileData: { cameraMode: 'top-down' } }))).toEqual({ orientation: 'xz', planeZ: 0 });
        // Even when the game also declares itself 2D: Z is a real axis there.
        expect(resolvePhysicsPlane(game({ gameDimension: '2d', worldProfileData: { cameraMode: 'top-down' } }))).toEqual({ orientation: 'xz', planeZ: 0 });
    });

    it('a side-on 2D game is the X/Y plane at its locked Z', () => {
        expect(resolvePhysicsPlane(game({ gameDimension: '2d' }))).toEqual({ orientation: 'xy', planeZ: 0 });
        expect(resolvePhysicsPlane(game({ gameDimension: '2d', worldProfileData: { cameraMode: 'third-person' } }))).toEqual({ orientation: 'xy', planeZ: 0 });
    });

    it('anything else is side-on at z = 0 (no locked plane to report)', () => {
        expect(resolvePhysicsPlane(game({}))).toEqual({ orientation: 'xy', planeZ: 0 });
        expect(resolvePhysicsPlane(game({ worldProfileData: { cameraMode: 'first-person' } }))).toEqual({ orientation: 'xy', planeZ: 0 });
    });
});
