import type * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { MultiplayerSetup } from 'engine/networking/MultiplayerSetup.js';
import type { NetworkCharacterController } from 'engine/networking/NetworkCharacterController.js';
import { SpectatorCamera, type SpectatorGameplayCamera } from 'engine/networking/SpectatorCamera.js';
import { SpectatorOverlay } from 'engine/networking/SpectatorOverlay.js';
import { GameState, getGameStateManager } from 'engine/GameStateManager.js';

export interface MultiplayerSpectatorOptions {
    deathDelaySeconds: number;
    distanceInHeights: number;
    /** Team games MUST supply their own team/round eligibility rule. IDs are player IDs. */
    canSpectate: (playerId: string) => boolean;
    /** Read-only countdown; the game owns when and where to respawn. */
    getRespawnSeconds: () => number | null;
    isMatchOver: () => boolean;
    /** Weapon/health HUD elements to hide, restoring their previous hidden flags on exit. */
    gameplayHud: readonly HTMLElement[];
    /** Gate custom combat/update paths here; the engine's player controls are gated automatically. */
    onActiveChanged: (active: boolean) => void;
}

export const DEFAULT_MULTIPLAYER_SPECTATOR_OPTIONS: MultiplayerSpectatorOptions = {
    deathDelaySeconds: 1,
    distanceInHeights: 3,
    canSpectate: () => true,
    getRespawnSeconds: () => null,
    isMatchOver: () => false,
    gameplayHud: [],
    onActiveChanged: () => {},
};

export interface MultiplayerSpectatorDependencies {
    engine: EngineLike;
    multiplayer: MultiplayerSetup;
    playerController: PlayerController;
    /** Resolve AFTER a death dismount, since entering vehicles swaps the active controller. */
    getGameplayCamera: () => SpectatorGameplayCamera;
}

interface Target {
    playerId: string;
    character: NetworkCharacterController;
}

interface SavedPlayer {
    controls: boolean;
    enabled: boolean;
    interactions: boolean;
    hud: Array<{ element: HTMLElement; hidden: HTMLElement['hidden'] }>;
    viewModel: { scene: THREE.Scene; visible: boolean } | null;
}

/**
 * Opt-in death spectating. Call update AFTER multiplayer.update and normal camera
 * updates. Never pauses the engine: a dead host continues NPC/world simulation.
 */
export class MultiplayerSpectator {
    private readonly overlay: SpectatorOverlay;
    private readonly unsubscribeDeath: () => void;
    private readonly onGameState = (): void => { this.refreshInput(); };
    private camera: SpectatorCamera | null = null;
    private saved: SavedPlayer | null = null;
    private target: Target | null = null;
    private elapsed = 0;
    private disposed = false;
    private previousBumpers = [false, false];

    constructor(
        private readonly deps: MultiplayerSpectatorDependencies,
        private readonly options: MultiplayerSpectatorOptions,
    ) {
        if (!Number.isFinite(options.deathDelaySeconds) || options.deathDelaySeconds < 0 ||
            !Number.isFinite(options.distanceInHeights) || options.distanceInHeights <= 0) {
            throw new Error('Spectator delay must be non-negative and camera distance must be positive');
        }
        this.overlay = new SpectatorOverlay(direction => this.cycleTarget(direction));
        this.unsubscribeDeath = deps.playerController.addDeathListener(() => this.enter());
        deps.multiplayer.networkManager.setLocalPlayerLifeState(deps.playerController.isPlayerDead() ? 'dead' : 'alive');
        getGameStateManager().addListener(this.onGameState);
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('blur', this.onBlur);
    }

    get isActive(): boolean { return this.saved !== null; }
    get targetPlayerId(): string | null { return this.target?.playerId ?? null; }

    /** Called automatically on PlayerController death; safe to call repeatedly. */
    enter(): void {
        if (this.disposed || this.isActive) return;
        const { playerController: player, multiplayer, engine } = this.deps;
        multiplayer.networkManager.setLocalPlayerLifeState('dead');
        if (!multiplayer.networkManager.isConnected() || this.options.isMatchOver()) return;
        const controls = player.getControlsEnabled();
        const enabled = player.isPlayerEnabled();
        player.prepareForSpectating();
        const viewModelScene = engine.getViewModelLayer?.()?.scene;
        this.saved = {
            controls, enabled,
            interactions: player.areInteractionsSuppressed(),
            hud: this.options.gameplayHud.map(element => ({ element, hidden: element.hidden })),
            viewModel: viewModelScene ? { scene: viewModelScene, visible: viewModelScene.visible } : null,
        };
        player.setControlsEnabled(false);
        player.setInteractionsSuppressed(true);
        player.setPlayerEnabled(false);
        player.velocity.set(0, 0, 0);
        engine.getPlayerVisibility().setHideReason('multiplayer-spectator', true);
        for (const { element } of this.saved.hud) element.hidden = true;
        if (viewModelScene) viewModelScene.visible = false;
        this.camera = new SpectatorCamera(engine, this.deps.getGameplayCamera(), this.options.distanceInHeights);
        this.elapsed = 0;
        this.target = null;
        this.previousBumpers = this.readBumpers();
        this.options.onActiveChanged(true);
        this.refreshInput();
        this.updateOverlay([]);
    }

    update(deltaTime: number): void {
        if (this.disposed) return;
        const { playerController: player, multiplayer } = this.deps;
        if (!player.isPlayerDead()) {
            if (this.isActive) this.leave(true);
            multiplayer.networkManager.setLocalPlayerLifeState('alive');
            return;
        }
        if (!multiplayer.networkManager.isConnected()) {
            // A transient reconnect must not return controls to a dead player.
            if (this.isActive) {
                this.select(null);
                this.refreshInput();
                this.updateOverlay([]);
            }
            return;
        }
        if (!this.isActive) this.enter();
        if (!this.isActive) return;
        this.refreshInput();
        if (!this.canUseInput()) return;
        this.elapsed += Math.max(0, deltaTime);
        const targets = this.getTargets();
        if (this.elapsed >= this.options.deathDelaySeconds) {
            if (!targets.some(target => target.playerId === this.target?.playerId && target.character === this.target.character)) {
                this.select(targets[0] ?? null);
            }
            this.updateGamepad(Math.min(Math.max(deltaTime, 0), 0.1));
            this.camera?.update(deltaTime, this.target !== null);
        }
        this.updateOverlay(targets);
    }

    /** Complete revival at a safe feet position. Respawn timing remains game-owned. */
    respawn(position?: THREE.Vector3): void {
        if (this.disposed) throw new Error('Cannot respawn with a disposed spectator');
        this.deps.playerController.reviveAt(position);
        this.leave(true);
        this.deps.multiplayer.networkManager.setLocalPlayerLifeState('alive');
    }

    cycleTarget(direction: number): void {
        if (!this.canUseInput() || this.elapsed < this.options.deathDelaySeconds) return;
        const targets = this.getTargets();
        if (targets.length === 0) { this.select(null); return; }
        const current = targets.findIndex(target => target.playerId === this.target?.playerId);
        const index = current < 0 ? 0 : (current + (direction < 0 ? -1 : 1) + targets.length) % targets.length;
        this.select(targets[index]!);
        this.updateOverlay(targets);
    }

    private getTargets(): Target[] {
        const net = this.deps.multiplayer.networkManager;
        const targets: Target[] = [];
        for (const [networkId, character] of this.deps.multiplayer.remoteCharacters) {
            if (!networkId.endsWith(':player')) continue;
            const playerId = networkId.slice(0, -':player'.length);
            if (playerId === net.localPlayerId || net.getRemotePlayerLifeState(playerId)?.state === 'dead') continue;
            if (!net.getRemotePlayers().has(playerId) || !this.options.canSpectate(playerId)) continue;
            targets.push({ playerId, character });
        }
        return targets.sort((a, b) => a.playerId.localeCompare(b.playerId));
    }

    private select(target: Target | null): void {
        this.target = target;
        if (target) this.camera?.follow(target.character.getObject3D(), target.character.getCapsuleHeight());
        else this.camera?.hold();
    }

    private canUseInput(): boolean {
        return this.isActive && !this.options.isMatchOver() &&
            getGameStateManager().getCurrentState() === GameState.PLAYING && this.deps.engine.isWindowFocused;
    }

    private refreshInput(): void {
        const enabled = this.canUseInput();
        this.overlay.element.hidden = !enabled;
        this.camera?.setInputEnabled(enabled, this.target !== null);
        if (!enabled) this.previousBumpers = this.readBumpers();
    }

    private updateOverlay(targets: Target[]): void {
        this.overlay.render(this.target?.character.getName() ?? null, targets.length,
            this.options.getRespawnSeconds(), this.elapsed < this.options.deathDelaySeconds);
    }

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (!this.canUseInput() || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') return;
        event.preventDefault();
        this.cycleTarget(event.code === 'ArrowLeft' ? -1 : 1);
    };

    private readonly onBlur = (): void => { this.overlay.element.hidden = true; this.camera?.setInputEnabled(false, false); };

    private readGamepad(): Gamepad | null {
        return Array.from(navigator.getGamepads?.() ?? []).find(pad => pad?.connected && pad.mapping === 'standard') ?? null;
    }

    private readBumpers(): boolean[] {
        const pad = this.readGamepad();
        return [pad?.buttons[4]?.pressed ?? false, pad?.buttons[5]?.pressed ?? false];
    }

    private updateGamepad(dt: number): void {
        const pad = this.readGamepad();
        const bumpers = this.readBumpers();
        bumpers.forEach((pressed, index) => {
            if (pressed && !this.previousBumpers[index]) this.cycleTarget(index === 0 ? -1 : 1);
        });
        this.previousBumpers = bumpers;
        const axis = (index: number): number => {
            const value = pad?.axes[index] ?? 0;
            return Math.abs(value) < 0.15 ? 0 : value;
        };
        this.camera?.orbit(axis(2) * dt * 2, -axis(3) * dt * 2);
    }

    private leave(revived: boolean): void {
        if (!this.saved) return;
        const { playerController: player, engine } = this.deps;
        this.camera?.dispose();
        this.camera = null;
        this.target = null;
        player.setPlayerEnabled(revived ? true : this.saved.enabled);
        player.setControlsEnabled(this.saved.controls);
        player.setInteractionsSuppressed(this.saved.interactions);
        engine.getPlayerVisibility().setHideReason('multiplayer-spectator', false);
        for (const { element, hidden } of this.saved.hud) element.hidden = hidden;
        if (this.saved.viewModel) this.saved.viewModel.scene.visible = this.saved.viewModel.visible;
        this.saved = null;
        this.overlay.element.hidden = true;
        this.options.onActiveChanged(false);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.leave(false);
        this.unsubscribeDeath();
        getGameStateManager().removeListener(this.onGameState);
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('blur', this.onBlur);
        this.overlay.dispose();
    }
}
