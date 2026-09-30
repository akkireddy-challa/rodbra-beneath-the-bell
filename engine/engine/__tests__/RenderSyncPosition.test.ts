import * as THREE from 'three';
import { resolveRenderSyncPosition, RENDER_SYNC_MAX_DIVERGENCE } from 'engine/renderSyncPosition.js';

describe('resolveRenderSyncPosition', () => {
    const body = { x: 10, y: 5, z: -3 };

    it('returns the smooth position when within the divergence clamp on all axes', () => {
        const smooth = new THREE.Vector3(10.5, 4.2, -2.1);
        expect(resolveRenderSyncPosition(smooth, body)).toBe(smooth);
    });

    it('falls back to the body when there is no smooth position (motor without getRenderPosition)', () => {
        // Callers pass `getRenderPosition?.()` straight through, so both spellings arrive.
        expect(resolveRenderSyncPosition(null, body)).toBe(body);
        expect(resolveRenderSyncPosition(undefined, body)).toBe(body);
    });

    it.each([
        ['x', new THREE.Vector3(10 + RENDER_SYNC_MAX_DIVERGENCE, 5, -3)],
        ['y', new THREE.Vector3(10, 5 - RENDER_SYNC_MAX_DIVERGENCE, -3)],
        ['z', new THREE.Vector3(10, 5, -3 + RENDER_SYNC_MAX_DIVERGENCE)],
    ])('falls back to the body when the %s axis diverges (teleport/respawn)', (_axis, smooth) => {
        expect(resolveRenderSyncPosition(smooth, body)).toBe(body);
    });
});
