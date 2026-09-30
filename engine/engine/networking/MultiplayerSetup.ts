/**
 * MultiplayerSetup: high-level helper that wires NetworkManager,
 * NetworkCharacterController, and lobby UI into a game template with
 * minimal boilerplate.
 *
 * Multiplayer is strictly opt-in — instantiate this class only when the
 * game should support online play.  Games that never create a
 * MultiplayerSetup remain purely single-player.
 *
 * USAGE (in a game template):
 *
 *   import { MultiplayerSetup } from 'engine/networking/index.js';
 *
 *   // Property
 *   private multiplayer: MultiplayerSetup | null = null;
 *
 *   // End of load()
 *   this.multiplayer = new MultiplayerSetup({
 *       engine:           this.engine,
 *       player:           this.player!,           // optional — omit for strategy/RTS
 *       playerController: this.playerController!,  // animations sync automatically
 *   });
 *   this.multiplayer.showLobby(gameId);
 *
 *   // update()
 *   this.multiplayer?.update(deltaTime);
 *
 *   // dispose()
 *   this.multiplayer?.dispose();
 *
 * For custom matchmaking or advanced control, access the underlying
 * NetworkManager via `this.multiplayer.networkManager`.
 */

import * as THREE from 'three';
import type { ExplosionConfig } from 'engine/Projectile.js';
import { NetworkManager } from 'engine/networking/NetworkManager.js';
import { NetworkObject } from 'engine/networking/NetworkObject.js';
import { NetworkCharacterController } from 'engine/networking/NetworkCharacterController.js';
import { NetworkAnimalController } from 'engine/networking/NetworkAnimalController.js';
import { NetworkRoomOwnership } from 'engine/networking/NetworkRoomOwnership.js';
import { getActiveLevelManager } from 'engine/levels/levelManagerRegistry.js';
import type { LobbyOptions } from 'engine/networking/NetworkLobbyUI.js';
import type { StateMessage, AnimationStateProvider, ShootData } from 'engine/networking/NetworkTypes.js';
import { getDefaultCharacterUrl } from 'engine/CharacterConfig.js';
import { buildAnimationList } from 'engine/AnimationPacks.js';
import type { BlockAnimalBodyConfig } from 'engine/animal/BlockAnimalBodyBuilder.js';
import { createCustomizedNpcFactory, type NpcCustomizationConfig } from 'engine/npc/customization/NpcCustomization.js';
import type { EngineLike, BaseAnimationDefinition } from 'types/game.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Optional visual fields preserve older clients while allowing seeded preset parity. */
export type ExplosionEvent = { position: { x: number; y: number; z: number }; radius: number }
    & Partial<Omit<ExplosionConfig, 'enabled' | 'radius'>>;

export interface MultiplayerSetupOptions {
    /** Game engine reference. */
    engine: EngineLike;

    /**
     * The local player's Object3D (must be loaded before calling showLobby).
     * Omit for strategy/RTS games that have no player character — use
     * `onConnected` to register custom objects instead.
     */
    player?: THREE.Object3D;

    /**
     * Player controller — used to read velocity for dead-reckoning and
     * animation state for sync.  Required when `player` is provided.
     *
     * If the controller has an `animationController` property (like
     * `PlayerController`) or a `getAnimationController()` method,
     * animation state is read automatically — no need for `playerLoader`.
     */
    playerController?: {
        velocity: THREE.Vector3;
        animationController?: unknown;
        getAnimationController?: () => unknown;
    };

    /**
     * Player loader — legacy option for animation controller access.
     * Only needed if `playerController` does not expose the animation
     * controller directly (unusual).  `getAnimationController()` is called.
     */
    playerLoader?: { getAnimationController(): unknown };

    /** Lobby options (autoJoin, maxPlayers, waitForPlayers, etc.). */
    lobbyOptions?: LobbyOptions;

    /**
     * Custom AnimationStateProvider factory.  Called once after lobby
     * connection with the confirmed player name.  Return the provider
     * that reads from your animation / weapon systems.
     *
     * If omitted, a default provider is created that reads basic
     * animation state (idle/walk/run/jump/attack) from the animation
     * controller — sufficient for games without ranged-weapon aim sync.
     */
    animationProvider?: (localPlayerName: string) => AnimationStateProvider;

    /** Called after WebSocket connects and the local player is registered. */
    onConnected?: (networkManager: NetworkManager, localPlayerName: string) => void;

    /**
     * Called after a remote character has been fully loaded and registered.
     * Use this instead of `networkManager.events.onPlayerJoined` — that
     * callback is reserved by MultiplayerSetup for room ownership tracking.
     */
    onRemotePlayerCreated?: (senderId: string, character: NetworkCharacterController) => void;

    /**
     * Called just before a remote character is disposed (on player leave).
     * Use this instead of `networkManager.events.onPlayerLeft` — that
     * callback is reserved by MultiplayerSetup for room ownership tracking.
     */
    onRemotePlayerRemoved?: (senderId: string, character: NetworkCharacterController) => void;

    /**
     * Additional animation packs to load on remote characters (e.g. combat animations).
     * When the local game loads combat/weapon animation packs, pass them here so remote
     * characters can play the same attack animations.
     */
    combatAnimations?: BaseAnimationDefinition[];

    /**
     * Game data assets array — enables custom animation playback on remote characters.
     * When a `customAnimId` arrives from the network (e.g. emotes, interactions),
     * the remote character loads the animation on demand from this list.
     *
     * Pass the assets from your world data (e.g. `gameData.assets`).
     */
    gameAssets?: unknown[];
}

// ---------------------------------------------------------------------------
// MultiplayerSetup
// ---------------------------------------------------------------------------

export class MultiplayerSetup {
    /** The underlying NetworkManager — use for sendEvent(), sendShoot(), events, etc. */
    readonly networkManager: NetworkManager;

    /**
     * Read-only view of active remote characters, keyed by networkId.
     * Useful for iterating over all remote players (e.g. hit detection).
     */
    get remoteCharacters(): ReadonlyMap<string, NetworkCharacterController> {
        return this._remoteCharacters;
    }

    /** The local player's display name (available after lobby). */
    get localPlayerName(): string {
        return this._localPlayerName;
    }

    /**
     * Whether this client is the room host (authority for NPCs / world objects).
     * The room creator is the initial host; ownership migrates if the host leaves.
     * Available after `onConnected` fires.
     */
    get isRoomHost(): boolean {
        return this._roomOwnership?.isOwner() ?? false;
    }

    // --- internal state ---
    private readonly _remoteCharacters: Map<string, NetworkCharacterController> = new Map();
    private readonly _remoteAnimals: Map<string, NetworkAnimalController> = new Map();
    private readonly _remoteNpcs: Map<string, NetworkCharacterController> = new Map();
    private readonly _pendingCharacters: Set<string> = new Set();
    private readonly pendingPlayerStates = new Map<string, StateMessage>();
    private readonly playerLoadTokens = new Map<string, object>();
    private readonly unsubscribeLifeState: () => void;
    private _localPlayerName: string = 'Player';
    private _localNetworkObject: NetworkObject | null = null;
    private _roomOwnership: NetworkRoomOwnership | null = null;
    private _isRoomCreator: boolean = false;
    private readonly opts: MultiplayerSetupOptions;
    private disposed: boolean = false;

    constructor(options: MultiplayerSetupOptions) {
        this.opts = options;
        this.networkManager = new NetworkManager();
        this.unsubscribeLifeState = this.networkManager.events.onPlayerLifeStateChanged((playerId, life) => {
            this._remoteCharacters.get(`${playerId}:player`)?.setVisible(life.state === 'alive');
        });
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * Wire callbacks and show the lobby overlay.
     * Call at the END of your `load()` method, after player / controller /
     * camera are fully initialised.
     */
    showLobby(gameId: string): void {
        const net = this.networkManager;
        const { engine } = this.opts;
        const handoffToEngineStart = () => {
            engine.startGame?.();
        };

        engine.setStartupUiMode?.('external');

        // --- Unknown-object handler (creates remote characters) ----------
        net.onUnknownObject = async (senderId: string, networkId: string, state: StateMessage) => {
            // Ignore own echoes
            if (senderId === net.localPlayerId) return;
            if (this.disposed) return;
            if (networkId === `${senderId}:player`) this.pendingPlayerStates.set(networkId, state);
            // Dedup: already created or in-flight
            if (this._remoteCharacters.has(networkId) || this._pendingCharacters.has(networkId)) return;

            // Only auto-handle character and animal objects.  Vehicles and custom
            // types must be handled via networkManager.onUnknownObject
            // override or custom events.
            if (state.objectType === 'vehicle') return;

            // --- Handle remote animals ---
            if (state.objectType === 'animal') {
                if (this._remoteAnimals.has(networkId)) return;
                const remoteAnimal = NetworkAnimalController.create({
                    engine,
                    networkId,
                    initialState: state,
                    animalType: state.animalType ?? 'Dog',
                    displayName: state.playerName ?? state.animalType ?? 'Animal',
                    animalConfig: state.animalConfig,
                });
                net.registerObject(remoteAnimal.getNetworkObject());
                this._remoteAnimals.set(networkId, remoteAnimal);
                return;
            }

            // --- Handle remote NPCs ---
            if (state.objectType === 'npc') {
                if (this._remoteNpcs.has(networkId) || this._pendingCharacters.has(networkId)) return;
                this._pendingCharacters.add(networkId);
                try {
                    // Build factory from transmitted config, or fall back to engine default
                    const npcFactory = state.characterConfig
                        ? createCustomizedNpcFactory(state.characterConfig as NpcCustomizationConfig)
                        : engine.blockCharacterFactory!;

                    const remoteNpc = await NetworkCharacterController.create({
                        engine,
                        networkId,
                        initialState: state,
                        playerName: state.playerName ?? 'NPC',
                        characterUrl: getDefaultCharacterUrl(),
                        blockCharacterFactory: npcFactory,
                        baseAnimations: buildAnimationList(),
                        combatAnimations: this.opts.combatAnimations,
                        gameAssets: this.opts.gameAssets,
                        isNpc: true,
                    });
                    net.registerObject(remoteNpc.getNetworkObject());
                    this._remoteNpcs.set(networkId, remoteNpc);
                    this._pendingCharacters.delete(networkId);
                } catch (err) {
                    this._pendingCharacters.delete(networkId);
                    console.error(`[MultiplayerSetup] Failed to create remote NPC ${networkId}:`, err);
                }
                return;
            }

            this._pendingCharacters.add(networkId);
            const loadToken = {};
            this.playerLoadTokens.set(networkId, loadToken);

            try {
                const remoteChar = await NetworkCharacterController.create({
                    engine,
                    networkId,
                    initialState: state,
                    playerName: state.playerName ?? 'Player',
                    characterUrl: getDefaultCharacterUrl(),
                    blockCharacterFactory: engine.blockCharacterFactory!,
                    baseAnimations: buildAnimationList(),
                    combatAnimations: this.opts.combatAnimations,
                    gameAssets: this.opts.gameAssets,
                });

                if (this.disposed || this.playerLoadTokens.get(networkId) !== loadToken) {
                    remoteChar.dispose();
                    return;
                }
                const latest = this.pendingPlayerStates.get(networkId);
                if (latest) remoteChar.getNetworkObject().applyState(latest);
                remoteChar.setVisible(net.getRemotePlayerLifeState(senderId)?.state !== 'dead');
                net.registerObject(remoteChar.getNetworkObject());
                this._remoteCharacters.set(networkId, remoteChar);
                this._pendingCharacters.delete(networkId);

                this.opts.onRemotePlayerCreated?.(senderId, remoteChar);
            } catch (err) {
                console.error(`[MultiplayerSetup] Failed to create remote character ${networkId}:`, err);
            } finally {
                if (this.playerLoadTokens.get(networkId) === loadToken) {
                    this.playerLoadTokens.delete(networkId);
                    this.pendingPlayerStates.delete(networkId);
                    this._pendingCharacters.delete(networkId);
                }
            }
        };

        // --- Player-left handler -----------------------------------------
        net.events.onPlayerLeft = (playerId: string) => {
            for (const id of this.playerLoadTokens.keys()) {
                if (!id.startsWith(playerId + ':')) continue;
                this.playerLoadTokens.delete(id);
                this.pendingPlayerStates.delete(id);
                this._pendingCharacters.delete(id);
            }
            // Notify room ownership (triggers host migration if owner left)
            this._roomOwnership?.handlePlayerLeft(playerId);

            // Unregister + dispose every remote object owned by the leaving
            // player — networkIds are prefixed with the owner's playerId.
            const disposeOwnedBy = <T extends { dispose(): void }>(
                map: Map<string, T>,
                beforeDispose?: (owned: T) => void,
            ): void => {
                for (const [id, owned] of map) {
                    if (!id.startsWith(playerId + ':')) continue;
                    beforeDispose?.(owned);
                    net.unregisterObject(id);
                    owned.dispose();
                    map.delete(id);
                }
            };

            disposeOwnedBy(this._remoteCharacters, (char) => this.opts.onRemotePlayerRemoved?.(playerId, char));
            disposeOwnedBy(this._remoteAnimals);
            disposeOwnedBy(this._remoteNpcs);
        };

        // --- Death handlers (auto-remove remote animal / NPC visuals) -----
        const disposeOnDeath = <T extends { dispose(): void }>(
            map: Map<string, T>,
            data: Record<string, unknown>,
        ): void => {
            const networkId = data['networkId'] as string;
            if (!networkId) return;
            const remote = map.get(networkId);
            if (!remote) return;
            net.unregisterObject(networkId);
            remote.dispose();
            map.delete(networkId);
        };
        net.events.on('_animalDeath', (_senderId, data) => disposeOnDeath(this._remoteAnimals, data));
        net.events.on('_npcDeath', (_senderId, data) => disposeOnDeath(this._remoteNpcs, data));

        // --- Multi-level sync (levels mode only) ---------------------------
        // The switching client broadcasts _levelChange; everyone follows (all
        // session players share one level). The room owner answers each join
        // with _levelState so late joiners converge — same handler, and the
        // already-there guard makes it a no-op for everyone else. A follow
        // that fails (e.g. the joiner's own world is still booting) retries a
        // few times before giving up loudly.
        const levelManager = getActiveLevelManager();
        let remoteLevelSeq = 0;
        if (levelManager) {
            levelManager.installNetworkHooks((levelId, spawnPointId) => {
                net.sendEvent('_levelChange', spawnPointId ? { levelId, spawnPointId } : { levelId });
            });
            const followRemoteLevel = (_senderId: string, data: Record<string, unknown>): void => {
                const levelId = data['levelId'] as string;
                if (!levelId) return;
                const spawnPointId = data['spawnPointId'] as string | undefined;
                const seq = ++remoteLevelSeq;
                const attempt = (retriesLeft: number): void => {
                    if (seq !== remoteLevelSeq) return;             // superseded by a newer event
                    if (levelId === levelManager.getActiveLevelId()) return; // already there
                    levelManager.loadLevel(levelId, { networked: false, spawnPointId }).catch((err) => {
                        if (retriesLeft > 0) setTimeout(() => attempt(retriesLeft - 1), 2000);
                        else console.error('[Levels] remote level switch failed:', err);
                    });
                };
                attempt(5);
            };
            net.events.on('_levelChange', followRemoteLevel);
            net.events.on('_levelState', followRemoteLevel);
        }

        // --- Room-join handler (fires before WebSocket connects) ----------
        net.onRoomJoined = (event) => {
            this._isRoomCreator = event.isCreator;
        };

        // --- Player-joined handler (room ownership tracking) -------------
        net.events.onPlayerJoined = (playerId: string, _playerName: string) => {
            this._roomOwnership?.handlePlayerJoined(playerId);
            // Room owner tells late joiners the current level (levels mode).
            const lm = getActiveLevelManager();
            if (lm && this._roomOwnership?.isOwner()) {
                net.sendEvent('_levelState', { levelId: lm.getActiveLevelId() });
            }
        };

        // --- Connection handler (registers local player) -----------------
        net.onStateChanged = (state) => {
            if (state === 'connected') {
                this.onMultiplayerConnected();
            }
        };

        // --- Show lobby last (mandatory) ---------------------------------
        net.showLobby(gameId, engine.container, (playerName: string) => {
            this._localPlayerName = playerName;
        }, this.opts.lobbyOptions, handoffToEngineStart);
    }

    /**
     * Call every frame.  Drives NetworkManager sync, interpolation, stale
     * detection, and remote character animation/visual updates.
     */
    update(deltaTime: number): void {
        if (this.disposed) return;
        this.networkManager.update(deltaTime);
        this._roomOwnership?.update(deltaTime);
        for (const char of this._remoteCharacters.values()) {
            char.update(deltaTime);
        }
        for (const animal of this._remoteAnimals.values()) {
            animal.update(deltaTime);
        }
        for (const npc of this._remoteNpcs.values()) {
            npc.update(deltaTime);
        }
    }

    // ------------------------------------------------------------------
    // NPC / World-Object Helpers
    // ------------------------------------------------------------------

    /**
     * Register an NPC or world object for network sync.
     *
     * Only the room host should call this — non-hosts receive NPC state
     * via the automatic `onUnknownObject` handler, which creates a
     * `NetworkCharacterController` for each incoming character-type object.
     *
     * **Animation sync:** Pass `animationController` (from `npc.getAnimationController()`)
     * and animations will sync automatically to remote clients.  Alternatively,
     * provide a custom `animationProvider` for full control.
     *
     * @returns the NetworkObject (useful for later unregister), or `null`
     *          if this client is not the room host.
     */
    registerNpc(
        object3D: THREE.Object3D,
        npcId: string,
        options?: {
            /** Velocity getter for dead-reckoning.  Defaults to zero velocity. */
            velocityGetter?: () => { x: number; y: number; z: number };
            /**
             * Animation controller from NpcController or CharacterAnimationController.
             * When provided, animation state is read automatically — you don't need
             * to build an AnimationStateProvider manually.
             */
            animationController?: { getAnimationController?: () => unknown } | { getCurrentState?: () => string };
            /** Explicit animation provider (takes precedence over animationController). */
            animationProvider?: AnimationStateProvider;
            /**
             * NpcCustomizationConfig used to create this NPC's visual.
             * When provided, remote clients receive it and build identical NPC visuals
             * (same colors, clothing, body shape). Without this, remotes use the
             * default player block character factory.
             */
            npcConfig?: NpcCustomizationConfig;
            /** Display name for the floating label on remote clients. Defaults to 'NPC'. */
            displayName?: string;
        },
    ): NetworkObject | null {
        if (!this.isRoomHost) return null;
        const networkId = `${this.networkManager.localPlayerId}:npc-${npcId}`;

        // Resolve animation provider: explicit > from controller > none
        let animProvider = options?.animationProvider;
        if (!animProvider && options?.animationController) {
            animProvider = MultiplayerSetup.buildAnimationProviderFromController(
                options.animationController,
            );
        }

        const netObj = new NetworkObject(object3D, networkId, true, {
            velocityGetter: options?.velocityGetter ?? (() => ({ x: 0, y: 0, z: 0 })),
            objectType: 'npc',
            characterConfig: options?.npcConfig,
            npcDisplayName: options?.displayName ?? 'NPC',
            animationProvider: animProvider,
        });
        this.networkManager.registerObject(netObj);
        return netObj;
    }

    /**
     * Stop syncing a previously registered NPC, WITHOUT telling remote clients to
     * remove it — they keep the last state and show a frozen NPC. For a defeat or
     * any other despawn the remotes must see, call `sendNpcDeath()` instead, which
     * unregisters AND broadcasts `_npcDeath`. This is the raw half, for cases where
     * the NPC should stop syncing but stay on screen (e.g. ownership handover).
     */
    unregisterNpc(npcId: string): void {
        const networkId = `${this.networkManager.localPlayerId}:npc-${npcId}`;
        this.networkManager.unregisterObject(networkId);
    }

    // ------------------------------------------------------------------
    // Animal Sync Helpers
    // ------------------------------------------------------------------

    /**
     * Register a local animal for multiplayer sync.
     * Only the room host should register animals — non-host clients receive
     * animal state automatically via the `onUnknownObject` handler, which
     * creates a NetworkAnimalController.
     *
     * The animal's position, rotation, and animation state will sync
     * automatically to remote clients.
     *
     * @param animalController - The animal's AnimalController (used for position + animation)
     * @param animalId - Unique identifier for this animal (must be unique per game)
     * @param animalType - Species type (e.g. 'Dog', 'Horse') — sent to remotes for mesh building
     * @param options - Optional velocity getter and animation provider overrides
     *
     * @returns the NetworkObject (useful for later unregister), or `null`
     *          if this client is not the room host.
     */
    registerAnimal(
        object3D: THREE.Object3D,
        animalId: string,
        animalType: string,
        options?: {
            /** Velocity getter for dead-reckoning. Defaults to zero velocity. */
            velocityGetter?: () => { x: number; y: number; z: number };
            /**
             * Animation controller from AnimalController's BlockAnimalAnimationController.
             * When provided, animation state is read automatically.
             */
            animationController?: { getCurrentState?: () => string };
            /** Explicit animation provider (takes precedence over animationController). */
            animationProvider?: AnimationStateProvider;
            /**
             * BlockAnimalBodyConfig used to create this animal.
             * When provided, remote clients receive it and build identical block geometry
             * (same colors, shapes, proportions). Without this, remotes use a generic
             * brown animal mesh which won't match the host's visual.
             */
            bodyConfig?: BlockAnimalBodyConfig;
            /** Display name for the floating label on remote clients. Defaults to animalType. */
            displayName?: string;
        },
    ): NetworkObject | null {
        if (!this.isRoomHost) return null;
        const networkId = `${this.networkManager.localPlayerId}:animal-${animalId}`;

        // Resolve animation provider: explicit > from controller > none
        let animProvider = options?.animationProvider;
        if (!animProvider && options?.animationController) {
            const ctrl = options.animationController;
            animProvider = {
                getAnimationState: () => ctrl.getCurrentState?.() ?? 'idle',
                getAttackId: () => null,
                getCustomAnimId: () => null,
            };
        }

        const netObj = new NetworkObject(object3D, networkId, true, {
            velocityGetter: options?.velocityGetter ?? (() => ({ x: 0, y: 0, z: 0 })),
            objectType: 'animal',
            animalType,
            animalConfig: options?.bodyConfig,
            animalDisplayName: options?.displayName ?? animalType,
            animationProvider: animProvider,
        });
        this.networkManager.registerObject(netObj);
        return netObj;
    }

    /**
     * Unregister a previously registered animal.
     * Call when an animal is removed from the game (e.g. killed).
     */
    unregisterAnimal(animalId: string): void {
        const networkId = `${this.networkManager.localPlayerId}:animal-${animalId}`;
        this.networkManager.unregisterObject(networkId);
    }

    /**
     * Kill an animal and sync its removal across all clients.
     *
     * On the host:
     * - Unregisters the animal's NetworkObject (stops sending state)
     * - Broadcasts an `_animalDeath` event with the network ID
     *
     * On remote clients (automatic):
     * - The `_animalDeath` listener disposes the NetworkAnimalController
     * - Removes the remote animal visual from the scene
     *
     * @param animalId - The animal ID used when calling registerAnimal()
     */
    sendAnimalDeath(animalId: string): void {
        const networkId = `${this.networkManager.localPlayerId}:animal-${animalId}`;
        this.networkManager.unregisterObject(networkId);
        this.networkManager.sendEvent('_animalDeath', { networkId });
    }

    /**
     * Read-only view of active remote animals, keyed by networkId.
     * Useful for iterating over all remote animals (e.g. proximity checks).
     */
    get remoteAnimals(): ReadonlyMap<string, NetworkAnimalController> {
        return this._remoteAnimals;
    }

    // ------------------------------------------------------------------
    // NPC Death / Hit Sync
    // ------------------------------------------------------------------

    /**
     * Kill an NPC and sync its removal across all clients.
     *
     * On the host:
     * - Unregisters the NPC's NetworkObject (stops sending state)
     * - Broadcasts an `_npcDeath` event with the network ID
     *
     * On remote clients (automatic):
     * - The `_npcDeath` listener disposes the remote NetworkCharacterController
     * - Removes the remote NPC visual from the scene
     *
     * @param npcId - The NPC ID used when calling registerNpc()
     */
    sendNpcDeath(npcId: string): void {
        const networkId = `${this.networkManager.localPlayerId}:npc-${npcId}`;
        this.networkManager.unregisterObject(networkId);
        this.networkManager.sendEvent('_npcDeath', { networkId });
    }

    /**
     * Read-only view of active remote NPCs, keyed by networkId.
     */
    get remoteNpcs(): ReadonlyMap<string, NetworkCharacterController> {
        return this._remoteNpcs;
    }

    /**
     * Report a projectile hit on a remote NPC — sends to host for damage application.
     *
     * Called by non-host clients when a local projectile collides with a remote NPC's
     * physics body (tagged `__type: 'remoteNpc'`). The host receives this via
     * `onNpcHit()` and applies actual damage to the NpcController.
     *
     * Visual effects (blood, flash) should be spawned immediately on the client.
     */
    sendNpcHit(networkId: string, damage: number,
        hitPosition?: { x: number; y: number; z: number },
        hitDirection?: { x: number; y: number; z: number },
    ): void {
        this.networkManager.sendEvent('_npcHit', {
            networkId,
            damage,
            hitPosition: hitPosition ?? { x: 0, y: 0, z: 0 },
            hitDirection: hitDirection ?? { x: 0, y: 0, z: 0 },
        });
    }

    /**
     * Register a handler for incoming NPC hit events.
     * Called on the HOST when a non-host client reports hitting a remote NPC.
     *
     * The handler should find the local NpcController by npcId and apply damage:
     */
    onNpcHit(handler: (
        senderId: string,
        networkId: string,
        damage: number,
        hitPosition: { x: number; y: number; z: number },
        hitDirection: { x: number; y: number; z: number },
    ) => void): void {
        this.networkManager.events.on('_npcHit', (senderId: string, data: Record<string, unknown>) => {
            handler(
                senderId,
                data['networkId'] as string,
                data['damage'] as number,
                data['hitPosition'] as { x: number; y: number; z: number },
                data['hitDirection'] as { x: number; y: number; z: number },
            );
        });
    }

    // ------------------------------------------------------------------
    // Shooting / Hit Sync Helpers
    // ------------------------------------------------------------------

    /**
     * Fire a projectile — broadcasts to all clients for visual sync.
     * All clients (including the local one) should spawn a visual projectile
     * in their `onRemoteShoot` handler.  Only the shooter runs hit detection.
     */
    sendShoot(shootData: ShootData): void {
        this.networkManager.sendShoot(shootData);
    }

    /**
     * Report a hit — broadcasts to all clients for damage / effect sync.
     * Call from the shooter's client after local hit detection confirms a hit.
     *
     * `targetId` can be either a raw playerId (e.g. `"abc123"`) or a
     * networkId from the `remoteCharacters` map (e.g. `"abc123:player"`).
     * The `:player` suffix is stripped automatically so the receiver can
     * always compare against `networkManager.localPlayerId`.
     */
    sendHit(targetId: string, damage: number, extras?: Record<string, unknown>): void {
        if (this.networkManager.getLocalPlayerLifeState()?.state === 'dead') return;
        // Normalize: strip the ":player" suffix so the receiver can match
        // against the raw localPlayerId.  Other suffixes (e.g. ":npc") are
        // left intact — NPC hit events use separate sendNpcHit/sendAnimalHit.
        const normalizedId = targetId.endsWith(':player')
            ? targetId.slice(0, -':player'.length)
            : targetId;
        if (this.networkManager.getRemotePlayerLifeState(normalizedId)?.state === 'dead') return;
        this.networkManager.sendEvent('_hit', { targetId: normalizedId, damage, ...extras });
    }

    /**
     * Register a handler for incoming hits.
     * Called on ALL clients when any player reports a hit — use `targetId`
     * to check whether this client's player/NPC is the target.
     */
    onHit(handler: (senderId: string, targetId: string, damage: number, extras: Record<string, unknown>) => void): void {
        this.networkManager.events.on('_hit', (senderId: string, data: Record<string, unknown>) => {
            if (data['targetId'] === this.networkManager.localPlayerId &&
                this.networkManager.getLocalPlayerLifeState()?.state === 'dead') return;
            handler(senderId, data['targetId'] as string, data['damage'] as number, data);
        });
    }

    /**
     * Register a handler for remote shoot events (visual projectile spawning).
     * Fires on all clients except the shooter.  Use to spawn a visual-only
     * projectile matching the shooter's fire data.
     */
    onRemoteShoot(handler: (senderId: string, shootData: ShootData) => void): void {
        this.networkManager.events.onRemoteShoot = handler;
    }

    // ------------------------------------------------------------------
    // Animal Hit Sync (client → host)
    // ------------------------------------------------------------------

    /**
     * Report a projectile hit on a remote animal — sends to host for damage application.
     *
     * Called by non-host clients when a local projectile collides with a remote animal's
     * physics body (tagged `__type: 'remoteAnimal'`). The host receives this via
     * `onAnimalHit()` and applies actual damage to the AnimalController.
     *
     * Visual effects (blood, gore) should be spawned immediately on the client for
     * responsiveness — the host handles authoritative damage/death.
     *
     * @param networkId - The remote animal's networkId (from physics body userData)
     * @param damage - Damage amount (from projectile.getDamage())
     * @param hitPosition - World-space hit position (for visual effects on host)
     * @param hitDirection - Direction of impact (for knockback/blood direction on host)
     */
    sendAnimalHit(networkId: string, damage: number,
        hitPosition?: { x: number; y: number; z: number },
        hitDirection?: { x: number; y: number; z: number },
    ): void {
        this.networkManager.sendEvent('_animalHit', {
            networkId,
            damage,
            hitPosition: hitPosition ?? { x: 0, y: 0, z: 0 },
            hitDirection: hitDirection ?? { x: 0, y: 0, z: 0 },
        });
    }

    /**
     * Register a handler for incoming animal hit events.
     * Called on the HOST when a non-host client reports hitting a remote animal.
     *
     * The handler should find the local AnimalController by networkId and apply damage:
     */
    onAnimalHit(handler: (
        senderId: string,
        networkId: string,
        damage: number,
        hitPosition: { x: number; y: number; z: number },
        hitDirection: { x: number; y: number; z: number },
    ) => void): void {
        this.networkManager.events.on('_animalHit', (senderId: string, data: Record<string, unknown>) => {
            handler(
                senderId,
                data['networkId'] as string,
                data['damage'] as number,
                data['hitPosition'] as { x: number; y: number; z: number },
                data['hitDirection'] as { x: number; y: number; z: number },
            );
        });
    }

    // ------------------------------------------------------------------
    // Explosion Sync
    // ------------------------------------------------------------------

    /**
     * Broadcast an explosion event to all other clients.
     * Call from the `Projectile.setOnExplosionTriggered()` callback when a
     * local projectile explodes. Remote clients receive this via `onExplosion()`
     * and should spawn a visual `Explosion` + apply environment destruction.
     */
    sendExplosion(data: ExplosionEvent): void {
        this.networkManager.sendEvent('_explosion', data);
    }

    /**
     * Register a handler for remote explosion events.
     * Fires on all clients except the one that fired the projectile.
     * Use to spawn a visual `Explosion` on remote clients.
     */
    onExplosion(handler: (
        senderId: string,
        data: ExplosionEvent,
    ) => void): void {
        this.networkManager.events.on('_explosion', (senderId: string, data: Record<string, unknown>) => {
            handler(senderId, data as unknown as ExplosionEvent);
        });
    }

    // ------------------------------------------------------------------
    // Environment Destruction Sync
    // ------------------------------------------------------------------

    /**
     * Broadcast environment destruction (terrain crater, debris scatter) to all
     * other clients. Call alongside `sendExplosion()` when a projectile destroys
     * terrain or voxel objects.
     *
     * Remote clients receive this via `onEnvironmentDestruction()` and should
     * call `terrain.explodeTerrainSphere()` + `VoxelDebrisManager.explodeDebrisInRadius()`.
     */
    sendEnvironmentDestruction(data: {
        position: { x: number; y: number; z: number };
        radius: number;
        impulse?: number;
        upImpulse?: number;
    }): void {
        this.networkManager.sendEvent('_envDestruction', data);
    }

    /**
     * Register a handler for remote environment destruction events.
     * Fires on all clients except the one that caused the destruction.
     */
    onEnvironmentDestruction(handler: (
        senderId: string,
        data: {
            position: { x: number; y: number; z: number };
            radius: number;
            impulse?: number;
            upImpulse?: number;
        },
    ) => void): void {
        this.networkManager.events.on('_envDestruction', (senderId: string, data: Record<string, unknown>) => {
            handler(senderId, data as unknown as {
                position: { x: number; y: number; z: number };
                radius: number;
                impulse?: number;
                upImpulse?: number;
            });
        });
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /**
     * Clean up everything.  Disconnects from the server, disposes all
     * remote characters, and unregisters the local player object.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribeLifeState();
        this.playerLoadTokens.clear();
        this.pendingPlayerStates.clear();
        this.opts.engine.setStartupUiMode?.('engine');

        // Unregister local player object before disconnect flushes outbox
        if (this._localNetworkObject) {
            this.networkManager.unregisterObject(this._localNetworkObject.networkId);
            this._localNetworkObject = null;
        }

        if (this._roomOwnership) {
            this._roomOwnership.dispose();
            this._roomOwnership = null;
        }

        for (const char of this._remoteCharacters.values()) {
            char.dispose();
        }
        this._remoteCharacters.clear();

        for (const animal of this._remoteAnimals.values()) {
            animal.dispose();
        }
        this._remoteAnimals.clear();

        for (const npc of this._remoteNpcs.values()) {
            npc.dispose();
        }
        this._remoteNpcs.clear();

        this._pendingCharacters.clear();

        this.networkManager.disconnect();
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /**
     * Called when the WebSocket reaches 'connected' state.
     * Registers the local player as a NetworkObject with animation sync.
     */
    private onMultiplayerConnected(): void {
        const { player, playerController, playerLoader } = this.opts;
        const net = this.networkManager;

        // Register local player only when a player Object3D is provided.
        // Strategy/RTS games omit player and register custom objects via onConnected.
        if (player && playerController) {
            const localId = net.localPlayerId;
            const networkId = `${localId}:player`;

            // Build animation provider (explicit factory > playerController > playerLoader > none)
            const animSource = (playerController.animationController || playerController.getAnimationController)
                ? playerController
                : playerLoader;
            const animProvider = this.opts.animationProvider
                ? this.opts.animationProvider(this._localPlayerName)
                : animSource
                    ? MultiplayerSetup.buildAnimationProviderFromController(animSource)
                    : undefined;

            const localNetObj = new NetworkObject(player, networkId, true, {
                speedGetter: () => playerController.velocity.length(),
                velocityGetter: () => ({
                    x: playerController.velocity.x,
                    y: playerController.velocity.y,
                    z: playerController.velocity.z,
                }),
                playerName: this._localPlayerName,
                objectType: 'character',
                animationProvider: animProvider,
                playerLifeState: () => net.getLocalPlayerLifeState(),
            });

            net.registerObject(localNetObj);
            this._localNetworkObject = localNetObj;
        }

        // Initialize room ownership tracking (used by isRoomHost / NPC helpers).
        // Only the room creator claims ownership — other clients learn
        // the owner via the _roomOwner event broadcast by claimOwnership().
        this._roomOwnership = new NetworkRoomOwnership(net);
        if (this._isRoomCreator) {
            this._roomOwnership.claimOwnership();
        }

        // Always fire callback — strategy games use this to register custom objects
        this.opts.onConnected?.(net, this._localPlayerName);
    }

    /**
     * Build an AnimationStateProvider from any controller-like object.
     *
     * Accepts any of:
     *  - An object with `animationController` property (e.g. PlayerController)
     *  - An object with `getAnimationController()` method (e.g. PlayerLoader, NpcController)
     *  - An animation controller directly (with `getCurrentState`, `getIsAttacking`, etc.)
     *
     * Duck-types the methods so templates aren't forced into a single controller type.
     * The controller reference is resolved lazily each frame, so hot-swapping
     * controllers (e.g. after character respawn) is supported.
     */
    static buildAnimationProviderFromController(
        controllerOrHost: { animationController?: unknown }
            | { getAnimationController?: () => unknown }
            | { getCurrentState?: () => string },
    ): AnimationStateProvider {
        // Build a lazy resolver that re-reads the controller each frame.
        // This handles cases where the controller is swapped (e.g. respawn).
        type AnimCtrlLike = {
            getCurrentState?: () => string;
            getIsAttacking?: () => boolean;
            isPlayingCustom?: () => boolean;
            getCustomMotionId?: () => string | null;
        } | null;

        const resolveCtrl = (): AnimCtrlLike => {
            // 1. Direct property: obj.animationController
            if ('animationController' in controllerOrHost && controllerOrHost.animationController) {
                return controllerOrHost.animationController as AnimCtrlLike;
            }
            // 2. Getter method: obj.getAnimationController()
            if ('getAnimationController' in controllerOrHost && controllerOrHost.getAnimationController) {
                return controllerOrHost.getAnimationController() as AnimCtrlLike;
            }
            // 3. Is the controller itself
            return controllerOrHost as AnimCtrlLike;
        };

        return {
            getAnimationState: () => resolveCtrl()?.getCurrentState?.() ?? 'idle',
            getAttackId: () => (resolveCtrl()?.getIsAttacking?.() ? 'attack' : null),
            getCustomAnimId: () => {
                const ctrl = resolveCtrl();
                return ctrl?.isPlayingCustom?.() ? (ctrl.getCustomMotionId?.() ?? null) : null;
            },
        };
    }
}
