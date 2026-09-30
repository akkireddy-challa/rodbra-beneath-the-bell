/** @jest-environment jsdom */
import * as THREE from 'three';
import { PlayerController } from 'engine/PlayerController.js';

describe('spectator player lifecycle', () => {
    it('explicitly disabled controls win over pointer lock and mobile preview', () => {
        Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: document.body });
        for (const mobilePreviewMode of [true, false]) {
            const player = { controlsEnabled: false, mobilePreviewMode } as unknown as PlayerController;
            expect(PlayerController.prototype.shouldProcessInput.call(player)).toBe(false);
        }
        Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: null });
    });

    it.each([true, false])('revives through the feet teleport and preserves gravity (already holding=%s)', holding => {
        const actions: string[] = [];
        const host = {
            player: new THREE.Object3D(), playerBody: { gravityScale: () => holding ? 0 : 1.5 },
            _waitingForColliders: holding, _originalGravityScale: holding ? 1.5 : 0,
            _savedSpawnPosition: null as { x: number; y: number; z: number } | null,
            startPosition: new THREE.Vector3(1, 2, 3), velocity: new THREE.Vector3(8, 0, 0),
            restoreFromRagdoll: () => { actions.push('ragdoll'); },
            leaveRideForDeath: () => { actions.push('dismount'); },
            setPlayerEnabled: () => { actions.push('enable'); },
            resetAllKeys: () => { actions.push('clear-keys'); },
            movementSystem: { reset: () => { actions.push('reset-movement'); } },
            teleportTo: jest.fn(() => { actions.push('teleport'); host._originalGravityScale = 0; }),
            resetHealth: () => { actions.push('revive'); },
        };
        PlayerController.prototype.reviveAt.call(host as unknown as PlayerController);
        expect(host.teleportTo).toHaveBeenCalledWith(1, 2, 3);
        expect(host._originalGravityScale).toBe(1.5);
        expect(host._savedSpawnPosition).toEqual({ x: 1, y: 2, z: 3 });
        expect(host.velocity.length()).toBe(0);
        expect(actions).toEqual(['ragdoll', 'dismount', 'enable', 'clear-keys', 'reset-movement', 'teleport', 'revive']);
    });
});
