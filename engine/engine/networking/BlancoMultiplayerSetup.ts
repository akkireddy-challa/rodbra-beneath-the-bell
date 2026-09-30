/**
 * BlancoMultiplayerSetup: event-based multiplayer for games WITHOUT a player
 * character.  Use this for board games, card games, puzzles, turn-based
 * strategy, party games — anything where players don't walk around a 3D world.
 *
 * For FPS/TPS/adventure games with a walking player character, use
 * `MultiplayerSetup` instead.
 *
 * USAGE (in a game template):
 *
 *   import { BlancoMultiplayerSetup } from 'engine/networking/index.js';
 *
 *   private multiplayer: BlancoMultiplayerSetup | null = null;
 *
 *   async load(gameId: string) {
 *       this.setupBoard();
 *
 *       this.multiplayer = new BlancoMultiplayerSetup({
 *           engine: this.engine,
 *           lobbyOptions: { waitForPlayers: true, minPlayersToStart: 2, maxPlayers: 2 },
 *           onConnected: (_net, playerName) => {
 *               this.localPlayerName = playerName;
 *           },
 *       });
 *
 *       // Register handlers BEFORE showLobby
 *       this.multiplayer.onGameState((_senderId, state) => this.applyGameState(state));
 *       this.multiplayer.onMove((_senderId, move) => {
 *           if (this.multiplayer!.isRoomHost) this.validateAndApplyMove(move);
 *       });
 *       this.multiplayer.onTurnChange((_senderId, data) => {
 *           this.currentTurn = data.currentPlayerId;
 *       });
 *
 *       this.multiplayer.showLobby(gameId);
 *   }
 *
 *   update(dt: number) { this.multiplayer?.update(dt); }
 *   dispose() { this.multiplayer?.dispose(); }
 */

import { NetworkManager } from 'engine/networking/NetworkManager.js';
import { NetworkRoomOwnership } from 'engine/networking/NetworkRoomOwnership.js';
import type { LobbyOptions } from 'engine/networking/NetworkLobbyUI.js';
import type { EngineLike } from 'types/game.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BlancoMultiplayerSetupOptions {
    /** Game engine reference. */
    engine: EngineLike;

    /** Lobby options (autoJoin, maxPlayers, waitForPlayers, etc.). */
    lobbyOptions?: LobbyOptions;

    /** Called after WebSocket connects and room ownership is established. */
    onConnected?: (networkManager: NetworkManager, localPlayerName: string) => void;

    /** Called when a remote player joins the room. */
    onPlayerJoined?: (playerId: string, playerName: string) => void;

    /** Called when a remote player leaves the room. */
    onPlayerLeft?: (playerId: string) => void;
}

// ---------------------------------------------------------------------------
// BlancoMultiplayerSetup
// ---------------------------------------------------------------------------

export class BlancoMultiplayerSetup {
    /** The underlying NetworkManager — use for sendEvent(), events, etc. */
    readonly networkManager: NetworkManager;

    /** The local player's display name (available after lobby). */
    get localPlayerName(): string {
        return this._localPlayerName;
    }

    /** The local player's unique ID (available after connection). */
    get localPlayerId(): string {
        return this.networkManager.localPlayerId;
    }

    /**
     * Whether this client is the room host (authority for game state).
     * The room creator is the initial host; ownership migrates if the host leaves.
     * Available after `onConnected` fires.
     */
    get isRoomHost(): boolean {
        return this._roomOwnership?.isOwner() ?? false;
    }

    /**
     * Read-only view of connected players, keyed by playerId → playerName.
     * Updated automatically on join/leave events.
     */
    get connectedPlayers(): ReadonlyMap<string, string> {
        return this._connectedPlayers;
    }

    // --- internal state ---
    private _localPlayerName: string = 'Player';
    private _roomOwnership: NetworkRoomOwnership | null = null;
    private _isRoomCreator: boolean = false;
    private readonly _connectedPlayers: Map<string, string> = new Map();
    private readonly opts: BlancoMultiplayerSetupOptions;
    private disposed: boolean = false;

    constructor(options: BlancoMultiplayerSetupOptions) {
        this.opts = options;
        this.networkManager = new NetworkManager();
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * Wire callbacks and show the lobby overlay.
     * Call at the END of your `load()` method, after game setup is complete.
     * Register event handlers (onGameState, onMove, etc.) BEFORE calling this.
     */
    showLobby(gameId: string): void {
        const net = this.networkManager;
        const { engine } = this.opts;
        const handoffToEngineStart = () => {
            engine.startGame?.();
        };

        engine.setStartupUiMode?.('external');

        // --- Room-join handler ---
        net.onRoomJoined = (event) => {
            this._isRoomCreator = event.isCreator;
        };

        // --- Player-joined handler ---
        net.events.onPlayerJoined = (playerId: string, playerName: string) => {
            this._connectedPlayers.set(playerId, playerName);
            this._roomOwnership?.handlePlayerJoined(playerId);
            this.opts.onPlayerJoined?.(playerId, playerName);
        };

        // --- Player-left handler ---
        net.events.onPlayerLeft = (playerId: string) => {
            this._connectedPlayers.delete(playerId);
            this._roomOwnership?.handlePlayerLeft(playerId);
            this.opts.onPlayerLeft?.(playerId);
        };

        // --- Connection handler ---
        net.onStateChanged = (state) => {
            if (state === 'connected') {
                this.onMultiplayerConnected();
            }
        };

        // --- Show lobby last ---
        net.showLobby(gameId, engine.container, (playerName: string) => {
            this._localPlayerName = playerName;
        }, this.opts.lobbyOptions, handoffToEngineStart);
    }

    /**
     * Call every frame.  Drives NetworkManager sync and room ownership.
     */
    update(deltaTime: number): void {
        if (this.disposed) return;
        this.networkManager.update(deltaTime);
        this._roomOwnership?.update(deltaTime);
    }

    // ------------------------------------------------------------------
    // Game State Sync
    // ------------------------------------------------------------------

    /**
     * Broadcast authoritative game state to all other clients.
     * Typically called by the room host after validating and applying a move.
     *
     * @param state - Serializable game state (board, scores, hands, etc.)
     */
    sendGameState(state: Record<string, unknown>): void {
        this.networkManager.sendEvent('_gameState', state);
    }

    /**
     * Register a handler for incoming game state updates.
     * Fires on all clients except the sender.
     */
    onGameState(handler: (senderId: string, state: Record<string, unknown>) => void): void {
        this.networkManager.events.on('_gameState', handler);
    }

    // ------------------------------------------------------------------
    // Move Sync
    // ------------------------------------------------------------------

    /**
     * Send a player move/action to all clients.
     * Non-host players send moves; the host validates and broadcasts
     * updated game state via `sendGameState()`.
     *
     * @param move - Serializable move data (e.g. { row: 1, col: 2 })
     */
    sendMove(move: Record<string, unknown>): void {
        this.networkManager.sendEvent('_move', move);
    }

    /**
     * Register a handler for incoming move events.
     * On the host: validate the move and broadcast updated state.
     * On non-host: optionally apply optimistic updates.
     */
    onMove(handler: (senderId: string, move: Record<string, unknown>) => void): void {
        this.networkManager.events.on('_move', handler);
    }

    // ------------------------------------------------------------------
    // Turn Sync
    // ------------------------------------------------------------------

    /**
     * Broadcast whose turn it is.  Called by the host after validating a move.
     *
     * @param data - Must include `currentPlayerId` and `turnNumber`.
     *               Additional fields (e.g. `timeLimit`) are forwarded as-is.
     */
    sendTurnChange(data: { currentPlayerId: string; turnNumber: number; [key: string]: unknown }): void {
        this.networkManager.sendEvent('_turnChange', data);
    }

    /**
     * Register a handler for turn change notifications.
     * Fires on all clients except the sender.
     */
    onTurnChange(handler: (senderId: string, data: { currentPlayerId: string; turnNumber: number; [key: string]: unknown }) => void): void {
        this.networkManager.events.on('_turnChange', (senderId: string, data: Record<string, unknown>) => {
            handler(senderId, data as { currentPlayerId: string; turnNumber: number; [key: string]: unknown });
        });
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /**
     * Clean up everything.  Disconnects from the server and releases resources.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.opts.engine.setStartupUiMode?.('engine');

        if (this._roomOwnership) {
            this._roomOwnership.dispose();
            this._roomOwnership = null;
        }

        this._connectedPlayers.clear();
        this.networkManager.disconnect();
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private onMultiplayerConnected(): void {
        const net = this.networkManager;

        // Track self in connected players
        this._connectedPlayers.set(net.localPlayerId, this._localPlayerName);

        // Initialize room ownership
        this._roomOwnership = new NetworkRoomOwnership(net);
        if (this._isRoomCreator) {
            this._roomOwnership.claimOwnership();
        }

        this.opts.onConnected?.(net, this._localPlayerName);
    }
}
