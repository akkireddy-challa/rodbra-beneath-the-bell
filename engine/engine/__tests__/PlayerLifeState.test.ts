import * as THREE from 'three';
import { PlayerLifeStateStore } from 'engine/networking/PlayerLifeState.js';
import { NetworkObject } from 'engine/networking/NetworkObject.js';
import { msgpackEncoder, msgpackDecoder } from 'engine/networking/NetworkBinaryCodec.js';
import type { PlayerLifeSnapshot, StateMessage } from 'engine/networking/NetworkTypes.js';

function state(life?: PlayerLifeSnapshot): StateMessage {
    return {
        type: 'state', senderId: 'alice', networkId: 'alice:player', timestamp: 0,
        position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
        velocity: { x: 0, y: 0, z: 0 }, speed: 0, playerLifeState: life,
    };
}

describe('player life snapshots', () => {
    it('retains death before visuals exist and rejects delayed death after revival', () => {
        const store = new PlayerLifeStateStore();
        expect(store.apply(state({ state: 'dead', revision: 1 }))).toBe(true);
        expect(store.get('alice')?.state).toBe('dead');
        expect(store.apply(state({ state: 'alive', revision: 2 }))).toBe(true);
        expect(store.apply(state({ state: 'dead', revision: 1 }))).toBe(false);
        expect(store.apply(state({ state: 'dead', revision: 2 }))).toBe(false);
        expect(store.apply(state())).toBe(false);
        expect(store.get('alice')?.state).toBe('alive');
    });

    it('rejects NPC/other-owner and invalid life states', () => {
        const store = new PlayerLifeStateStore();
        const dead = state({ state: 'dead', revision: 1 });
        expect(store.apply({ ...dead, networkId: 'bob:player' })).toBe(false);
        expect(store.apply({ ...dead, networkId: 'alice:npc-1' })).toBe(false);
        for (const revision of [-1, NaN, Infinity, 1.5]) {
            expect(store.apply(state({ state: 'dead', revision }))).toBe(false);
        }
        expect(store.get('alice')).toBeNull();
        store.apply(dead);
        store.remove('alice');
        expect(store.apply(state({ state: 'alive', revision: 0 }))).toBe(true);
    });

    it('carries death through idle, forced late-join and binary snapshots with no residual attack', () => {
        let life: PlayerLifeSnapshot = { state: 'dead', revision: 5 };
        const player = new NetworkObject(new THREE.Object3D(), 'alice:player', true, {
            velocityGetter: () => ({ x: 20, y: 1, z: 0 }), speedGetter: () => 20,
            playerLifeState: () => life,
            animationProvider: {
                getAnimationState: () => 'attack', getAttackId: () => 'swing',
                getCustomAnimId: () => null, getEquippedWeaponId: () => 'melee:sword',
            },
        });
        for (const snapshot of [player.collectState(2, 'alice')!, player.forceCollectState('alice')]) {
            const decoded = msgpackDecoder(msgpackEncoder([snapshot]))[0] as StateMessage;
            expect(decoded.playerLifeState).toEqual(life);
            expect(decoded.velocity).toEqual({ x: 0, y: 0, z: 0 });
            expect(decoded.speed).toBe(0);
            expect(decoded.attackId).toBeUndefined();
            expect(decoded.equippedWeaponId).toBeUndefined();
        }
        life = { state: 'alive', revision: 6 };
        expect(player.forceCollectState('alice').speed).toBe(20);
        const legacy = new NetworkObject(new THREE.Object3D(), 'old:player', true, {
            velocityGetter: () => ({ x: 0, y: 0, z: 0 }),
        });
        expect(legacy.forceCollectState('old').playerLifeState).toBeUndefined();
    });
});
