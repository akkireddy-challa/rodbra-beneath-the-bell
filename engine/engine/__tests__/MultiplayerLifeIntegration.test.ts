/** @jest-environment jsdom */
import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { MultiplayerSetup } from 'engine/networking/MultiplayerSetup.js';
import { NetworkManager } from 'engine/networking/NetworkManager.js';
import { NetworkCharacterController } from 'engine/networking/NetworkCharacterController.js';
import { NetworkObject } from 'engine/networking/NetworkObject.js';
import type { StateMessage, NetworkMessage } from 'engine/networking/NetworkTypes.js';
import { msgpackDecoder } from 'engine/networking/NetworkBinaryCodec.js';

// Exercise the real receive path without opening external sockets in unit tests.
type Receiver = { processMessage(message: NetworkMessage): void };
function receive(net: NetworkManager, msg: NetworkMessage): void {
    (net as unknown as Receiver).processMessage(msg);
}
const snapshot = (revision: number, state: 'alive' | 'dead'): StateMessage => ({
    type: 'state', senderId: 'remote', networkId: 'remote:player', timestamp: revision,
    speed: 0, velocity: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 }, playerLifeState: { state, revision },
});

afterEach(() => { jest.restoreAllMocks(); });

it('flushes life changes while idle, including forced snapshots for a new peer', () => {
    const net = new NetworkManager();
    const sent: NetworkMessage[] = [];
    const socket = { readyState: WebSocket.OPEN, send: (data: Uint8Array | string) => {
        if (typeof data !== 'string') sent.push(...msgpackDecoder(data));
    } };
    Object.assign(net, { _state: 'connected', ws: socket });
    net.registerObject(new NetworkObject(new THREE.Object3D(), `${net.localPlayerId}:player`, true, {
        velocityGetter: () => ({ x: 0, y: 0, z: 0 }), playerLifeState: () => net.getLocalPlayerLifeState(),
    }));
    net.setLocalPlayerLifeState('dead');
    expect((sent.at(-1) as StateMessage).playerLifeState).toEqual({ state: 'dead', revision: 0 });
    net.setLocalPlayerLifeState('dead');
    expect(sent).toHaveLength(1);
    receive(net, { type: 'join', senderId: 'new-peer', timestamp: 1, playerName: 'New peer' } as NetworkMessage);
    expect((sent.at(-1) as StateMessage).playerLifeState?.state).toBe('dead');
    net.setLocalPlayerLifeState('alive');
    expect((sent.at(-1) as StateMessage).playerLifeState).toEqual({ state: 'alive', revision: 1 });
});

it.each(['death', 'leave', 'dispose'])('handles %s while the remote character is still loading', async action => {
    jest.spyOn(NetworkManager.prototype, 'showLobby').mockImplementation(() => {});
    const setup = new MultiplayerSetup({ engine: { container: document.body } as unknown as EngineLike });
    const netObject = new NetworkObject(new THREE.Object3D(), 'remote:player', false, {
        velocityGetter: () => ({ x: 0, y: 0, z: 0 }),
    });
    const character = { getNetworkObject: () => netObject, setVisible: jest.fn(), dispose: jest.fn() };
    let resolve!: (character: NetworkCharacterController) => void;
    jest.spyOn(NetworkCharacterController, 'create').mockImplementation(() => new Promise(done => { resolve = done; }));
    setup.showLobby('test-game');
    receive(setup.networkManager, snapshot(0, 'alive'));
    if (action === 'death') receive(setup.networkManager, snapshot(1, 'dead'));
    if (action === 'leave') receive(setup.networkManager, { type: 'leave', senderId: 'remote', timestamp: 1 });
    if (action === 'dispose') setup.dispose();
    resolve(character as unknown as NetworkCharacterController);
    await Promise.resolve();
    if (action === 'death') {
        expect(character.setVisible).toHaveBeenLastCalledWith(false);
        receive(setup.networkManager, snapshot(2, 'alive'));
        receive(setup.networkManager, snapshot(1, 'dead'));
        expect(character.setVisible).toHaveBeenLastCalledWith(true);
    } else {
        expect(character.dispose).toHaveBeenCalledTimes(1);
        expect(setup.remoteCharacters.size).toBe(0);
    }
    setup.dispose();
});
