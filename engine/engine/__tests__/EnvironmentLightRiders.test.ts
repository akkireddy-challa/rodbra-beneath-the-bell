/**
 * Lights that ride smart-object parts: placed at rest from the record, then
 * moved every frame to wherever the part's pivot is — and left alone for
 * instances the smart-object system never attached.
 *
 * @jest-environment jsdom
 */
import * as THREE from 'three';
import { EnvironmentLightSystem, type SmartPartAnchors } from 'engine/EnvironmentLightSystem.js';
import type { GameData } from 'types/game.js';

/** A ferris wheel with a lamp on its cabin and a fixed lamp at its base, placed twice. */
function gameData(): GameData {
    return {
        assets: [{
            id: 'asset_wheel', name: 'wheel', type: 'environment', url: 'wheel.vxl',
            light: { color: '#ffd27a', offset: { x: 0, y: 3.5, z: 0 }, part: 'cabin' },
            lights: [{ color: '#ffffff', offset: { x: 0, y: 0.5, z: 0 } }],
        }],
        environmentObjects: [
            { id: 'wheel-1', type: 'wheel', assetId: 'asset_wheel', position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
            { id: 'wheel-2', type: 'wheel', assetId: 'asset_wheel', position: { x: -10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        ],
    } as unknown as GameData;
}

/** A stand-in smart-object system: only `wheel-1` is attached, and its cabin has swung to the bottom. */
const anchors: SmartPartAnchors = {
    anchorToWorld: (id, part, point, out) => {
        if (id !== 'wheel-1' || part !== 'cabin') return false;
        out.set(10 + point.x, 0.5 - (point.y - 3.5), point.z);
        return true;
    },
};

function sources(system: EnvironmentLightSystem): THREE.Vector3[] {
    return (system as unknown as { sources: Array<{ position: THREE.Vector3 }> }).sources.map((s) => s.position);
}

describe('EnvironmentLightSystem part riders', () => {
    it('places part lights at rest from the record, and only they follow the part', () => {
        const system = new EnvironmentLightSystem(new THREE.Scene(), { poolSize: 2 });
        system.initFromGameData(gameData());
        expect(system.hasRiders()).toBe(true);
        const [cabin1, base1, cabin2, base2] = sources(system);
        expect(cabin1!.toArray()).toEqual([10, 3.5, 0]);
        expect(base1!.toArray()).toEqual([10, 0.5, 0]);

        system.followSmartParts(anchors);
        // wheel-1's cabin lamp moved with the cabin; its base lamp did not.
        expect(cabin1!.toArray()).toEqual([10, 0.5, 0]);
        expect(base1!.toArray()).toEqual([10, 0.5, 0]);
        // wheel-2 is not attached: its lamps keep the rest placement.
        expect(cabin2!.toArray()).toEqual([-10, 3.5, 0]);
        expect(base2!.toArray()).toEqual([-10, 0.5, 0]);
        system.dispose();
    });

    it('is a no-op without a smart-object system, and after dispose', () => {
        const system = new EnvironmentLightSystem(new THREE.Scene(), { poolSize: 2 });
        system.initFromGameData(gameData());
        const [cabin1] = sources(system);
        system.followSmartParts(null);
        expect(cabin1!.toArray()).toEqual([10, 3.5, 0]);
        system.dispose();
        expect(system.hasRiders()).toBe(false);
    });
});
