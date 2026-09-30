/** @jest-environment jsdom */
import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { GameEngine } from 'engine/GameEngine.js';
import { viewModelVisible } from 'engine/GameEngineViewModel.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { MultiplayerSetup } from 'engine/networking/MultiplayerSetup.js';
import type { NetworkCharacterController } from 'engine/networking/NetworkCharacterController.js';
import type { PlayerLifeSnapshot } from 'engine/networking/NetworkTypes.js';
import { MultiplayerSpectator, DEFAULT_MULTIPLAYER_SPECTATOR_OPTIONS } from 'engine/networking/MultiplayerSpectator.js';
import { GameState, getGameStateManager } from 'engine/GameStateManager.js';

function fixture(orthographic = false, canSpectate = (_id: string) => true, delay = 0) {
    const perspective = new THREE.PerspectiveCamera(72, 1.5, 0.1, 1000);
    const original = orthographic ? new THREE.OrthographicCamera(-8, 8, 5, -5) : perspective;
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    container.append(canvas);
    document.body.append(container);
    const visibility = new Set<string>();
    const viewModel = new THREE.Scene();
    const engine = {
        camera: original, container, renderer: { domElement: canvas }, isWindowFocused: true,
        getDefaultCamera: () => perspective,
        setRenderCamera(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) { this.camera = camera; },
        getPlayerVisibility: () => ({ setHideReason(reason: string, hide: boolean) { if (hide) visibility.add(reason); else visibility.delete(reason); } }),
        getViewModelLayer: () => ({ scene: viewModel }),
        viewModelLayer: { scene: viewModel, hasContent: () => true },
    };
    const gameplayCamera = {
        enabled: true,
        setEnabled(value: boolean) {
            this.enabled = value;
            // TopDownCamera swaps render cameras on enable/disable.
            if (orthographic) engine.setRenderCamera(value ? original : perspective);
        },
    };
    let dead = false;
    let connected = true;
    let listener = () => {};
    let localLife: string | null = null;
    const states = new Map<string, PlayerLifeSnapshot>();
    const characters = new Map<string, NetworkCharacterController>();
    const player = {
        controls: true, enabled: true, interactions: false, velocity: new THREE.Vector3(4, 0, 0),
        addDeathListener(callback: () => void) { listener = callback; return () => { listener = () => {}; }; },
        isPlayerDead: () => dead, prepareForSpectating: jest.fn(),
        getControlsEnabled() { return this.controls; }, isPlayerEnabled() { return this.enabled; },
        areInteractionsSuppressed() { return this.interactions; },
        setControlsEnabled(value: boolean) { this.controls = value; },
        setPlayerEnabled(value: boolean) { this.enabled = value; },
        setInteractionsSuppressed(value: boolean) { this.interactions = value; },
        reviveAt: jest.fn(() => { dead = false; }),
    };
    const multiplayer = {
        remoteCharacters: characters,
        networkManager: {
            localPlayerId: 'local', isConnected: () => connected,
            getRemotePlayerLifeState: (id: string) => states.get(id) ?? null,
            getRemotePlayers: () => new Map(Array.from(characters.keys()).map(id => [id.slice(0, -7), {}])),
            setLocalPlayerLifeState: (state: string) => { localLife = state; },
        },
    };
    const hud = document.createElement('div');
    const hiddenHud = document.createElement('div');
    hiddenHud.hidden = true;
    const active = jest.fn();
    const spectator = new MultiplayerSpectator({
        engine: engine as unknown as EngineLike,
        multiplayer: multiplayer as unknown as MultiplayerSetup,
        playerController: player as unknown as PlayerController,
        getGameplayCamera: () => gameplayCamera,
    }, { ...DEFAULT_MULTIPLAYER_SPECTATOR_OPTIONS, deathDelaySeconds: delay, canSpectate, gameplayHud: [hud, hiddenHud], onActiveChanged: active });
    function add(id: string, x: number) {
        const root = new THREE.Object3D();
        root.position.x = x;
        root.updateMatrixWorld(true);
        characters.set(`${id}:player`, {
            getObject3D: () => root, getCapsuleHeight: () => 2, getName: () => id,
        } as unknown as NetworkCharacterController);
        return root;
    }
    return {
        spectator, engine, original, perspective, player, gameplayCamera, hud, hiddenHud, viewModel, visibility, characters, states, active,
        add, die: () => { dead = true; listener(); }, life: () => localLife,
        disconnect: () => { connected = false; },
    };
}

beforeEach(() => {
    getGameStateManager().setState(GameState.PLAYING);
    document.body.innerHTML = '';
});

describe('multiplayer death spectating', () => {
    it('keeps gameplay running, freezes local actions, filters teams and switches on death/leave', () => {
        const f = fixture(false, id => id !== 'enemy');
        f.add('alice', 10); f.add('bob', 1000); f.add('enemy', 20);
        f.die(); f.die(); f.spectator.update(1 / 60);
        expect(f.spectator.targetPlayerId).toBe('alice');
        expect(f.player.controls).toBe(false);
        expect(f.player.enabled).toBe(false);
        expect(f.player.interactions).toBe(true);
        expect(f.player.velocity.length()).toBe(0);
        expect(f.life()).toBe('dead');
        expect(f.viewModel.visible).toBe(false);
        expect(viewModelVisible(f.engine as unknown as GameEngine)).toBe(false);
        expect(f.active).toHaveBeenCalledTimes(1);
        expect(getGameStateManager().getCurrentState()).toBe(GameState.PLAYING);
        f.states.set('alice', { state: 'dead', revision: 1 });
        f.spectator.update(1 / 60);
        expect(f.spectator.targetPlayerId).toBe('bob');
        expect(f.engine.camera.position.x).toBeGreaterThan(990); // hard cut, no fly-through
        f.characters.delete('bob:player'); f.spectator.update(1 / 60);
        expect(f.spectator.targetPlayerId).toBeNull();
        expect(document.body.textContent).toContain('Waiting for players');
        f.states.set('alice', { state: 'alive', revision: 2 }); f.spectator.update(1 / 60);
        expect(f.spectator.targetPlayerId).toBe('alice');
        f.spectator.dispose();
    });

    it.each([false, true])('restores camera, HUD and input after repeated respawns (ortho=%s)', orthographic => {
        const f = fixture(orthographic);
        f.add('alice', 80);
        for (let i = 0; i < 3; i++) {
            f.die(); f.spectator.update(1 / 60); f.spectator.update(1 / 60);
            expect(f.engine.camera).not.toBe(f.original);
            expect(f.gameplayCamera.enabled).toBe(false);
            f.spectator.respawn(new THREE.Vector3(2, 3, 4));
            expect(f.engine.camera).toBe(f.original);
            expect(f.perspective.fov).toBe(72);
            expect(f.gameplayCamera.enabled).toBe(true);
            expect(f.player.controls).toBe(true);
            expect(f.player.enabled).toBe(true);
            expect(f.hud.hidden).toBe(false);
            expect(f.hiddenHud.hidden).toBe(true);
            expect(f.viewModel.visible).toBe(true);
            expect(f.visibility.size).toBe(0);
            expect(f.life()).toBe('alive');
        }
        f.spectator.dispose();
        expect(document.querySelector('.bm-spectator')).toBeNull();
    });

    it('holds the death view, switches by keys and buttons, and yields controls to pause/end', () => {
        const f = fixture(false, () => true, 1);
        f.add('alice', 10); f.add('bob', 40);
        f.die(); f.spectator.update(0.5);
        expect(f.engine.camera).toBe(f.original);
        f.spectator.cycleTarget(1);
        expect(f.spectator.targetPlayerId).toBeNull();
        f.spectator.update(0.5);
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' }));
        expect(f.spectator.targetPlayerId).toBe('bob');
        (document.querySelector('.bm-spectator button') as HTMLButtonElement).click();
        expect(f.spectator.targetPlayerId).toBe('alice');
        getGameStateManager().setState(GameState.PAUSED);
        expect((document.querySelector('.bm-spectator') as HTMLElement).hidden).toBe(true);
        f.spectator.cycleTarget(1);
        expect(f.spectator.targetPlayerId).toBe('alice');
        getGameStateManager().setState(GameState.END);
        expect((document.querySelector('.bm-spectator') as HTMLElement).hidden).toBe(true);
        f.spectator.dispose();
    });

    it('keeps a dead player disabled across reconnect and releases resources on dispose', () => {
        const f = fixture(); f.die(); f.disconnect(); f.spectator.update(0.1);
        expect(f.spectator.isActive).toBe(true);
        expect(f.player.controls).toBe(false);
        expect(f.player.enabled).toBe(false);
        f.spectator.dispose(); f.die();
        expect(f.spectator.isActive).toBe(false);
        expect(f.engine.camera).toBe(f.original);
    });

    it('uses gamepad bumper edges and right-stick orbit without restoring player controls', () => {
        const buttons = Array.from({ length: 6 }, () => ({ pressed: false }));
        const pad = { connected: true, mapping: 'standard', buttons, axes: [0, 0, 0, 0] };
        Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
        const f = fixture(); f.add('alice', 10); f.add('bob', 40);
        f.die(); f.spectator.update(0.1);
        buttons[5]!.pressed = true; f.spectator.update(0.1);
        expect(f.spectator.targetPlayerId).toBe('bob');
        f.spectator.update(0.1);
        expect(f.spectator.targetPlayerId).toBe('bob'); // held bumper is not repeated
        const before = f.engine.camera.position.clone();
        pad.axes[2] = 0.8; f.spectator.update(0.1);
        expect(f.engine.camera.position.distanceTo(before)).toBeGreaterThan(0.01);
        expect(f.player.controls).toBe(false);
        f.spectator.dispose();
        Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [] });
    });
});
