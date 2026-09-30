/**
 * NetworkManager: Central hub for multiplayer networking.
 *
 * State machine: DISCONNECTED → LOBBY → CONNECTING → CONNECTED
 *
 * The lobby UI is mandatory and always shows two views:
 *   1. Name input — player must enter a display name
 *   2. Room browser — player creates or joins a room
 *
 * Usage:
 *   const net = new NetworkManager();
 *   net.onStateChanged = (state) => { ... };
 *   net.showLobby(gameId, container, (name) => { localPlayerName = name; });
 *   // In update loop:
 *   net.update(deltaTime);
 *   // Cleanup:
 *   net.disconnect();
 */
import { GAME_SERVER_WS_URL, GAME_SERVER_HTTP_URL } from 'engine/config.js';
import { isCreatorMode } from 'engine/CreatorMode.js';
import { NetworkEvents } from 'engine/networking/NetworkEvents.js';
import { PlayerLifeStateStore } from 'engine/networking/PlayerLifeState.js';
import { getActiveLevelManager } from 'engine/levels/levelManagerRegistry.js';
import { NetworkObject } from 'engine/networking/NetworkObject.js';
import { NetworkLobbyUI } from 'engine/networking/NetworkLobbyUI.js';
import { msgpackEncoder, msgpackDecoder } from 'engine/networking/NetworkBinaryCodec.js';
import type { LobbyOptions } from 'engine/networking/NetworkLobbyUI.js';
import type {
    NetworkState,
    NetworkMessage,
    AckMessage,
    BatchMessage,
    StateMessage,
    JoinMessage,
    LeaveMessage,
    PingMessage,
    EventMessage,
    RoomInfo,
    RemotePlayerInfo,
    ShootData,
    PlayerLifeState,
    PlayerLifeSnapshot,
} from 'engine/networking/NetworkTypes.js';
import {
    PING_INTERVAL,
    STALE_TIMEOUT,
    BATCH_SEND_INTERVAL,
    BINARY_MSG_ID_BYTES,
    isStateMessage,
    isJoinMessage,
    isLeaveMessage,
    isPingMessage,
    isEventMessage,
    isBatchMessage,
} from 'engine/networking/NetworkTypes.js';

export class NetworkManager {
    // --- State ---
    private _state: NetworkState = 'disconnected';
    private gameId: string = '';
    private roomId: string = '';
    private roomName: string = '';
    private playerName: string = 'Player';

    // --- Identity ---
    readonly localPlayerId: string;

    // --- Connection ---
    private ws: WebSocket | null = null;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private reconnectDelay: number = 1000;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // --- Registered objects ---
    private networkObjects: Map<string, NetworkObject> = new Map();

    // --- Remote players ---
    private remotePlayers: Map<string, RemotePlayerInfo> = new Map();
    private readonly playerLifeStates = new PlayerLifeStateStore();
    private localLifeState: Readonly<PlayerLifeSnapshot> | null = null;
    private lastPingReceived: Map<string, number> = new Map();

    // --- Timing ---
    private pingTimer: number = 0;

    // --- Outbox: batch outbound messages at batchInterval ---
    private outbox: NetworkMessage[] = [];
    private batchFlushTimer: number = 0;
    /** Batch flush interval in seconds. Default from BATCH_SEND_INTERVAL, overridable via setBatchSendRate(). */
    private batchInterval: number = BATCH_SEND_INTERVAL;

    // --- Binary protocol ---
    /** When true, outbox is serialized to binary and sent as binary WebSocket frames with 4-byte msgId prefix. */
    private binaryProto: boolean = false;
    /** Encoder: converts a NetworkMessage array (batch) or single NetworkMessage to Uint8Array. Must be set when binaryProto is true. */
    private binaryEncoder: ((msgs: NetworkMessage[]) => Uint8Array) | null = null;
    /** Decoder: converts a Uint8Array (payload after msgId stripped) back to NetworkMessage[]. Must be set when binaryProto is true. */
    private binaryDecoder: ((data: Uint8Array) => NetworkMessage[]) | null = null;

    // --- Reliable delivery (ACK) ---
    private seenMsgIds: Set<number> = new Set();
    /** Watermark: all IDs <= this value are considered seen (monotonic IDs). */
    private lastEvictedMsgId: number = 0;
    private pendingAckIds: number[] = [];
    private ackFlushTimer: number = 0;
    private static readonly ACK_FLUSH_INTERVAL = 0.2; // seconds
    private static readonly MAX_SEEN_IDS = 2000;

    // --- UI ---
    private lobbyUI: NetworkLobbyUI | null = null;
    private waitForPlayers: boolean = false;
    private autoEnterGame: boolean = false;
    private onLocalGameplayStartRequested: (() => void) | null = null;
    // --- Events ---
    readonly events: NetworkEvents = new NetworkEvents();

    // --- Callbacks ---
    /** Called when the connection state changes */
    onStateChanged: ((state: NetworkState) => void) | null = null;
    /** Called when a state message arrives for an unregistered networkId. Template should create a visual + NetworkObject. */
    onUnknownObject: ((senderId: string, networkId: string, state: StateMessage) => void) | null = null;
    /** Called when the player creates or joins a room (before WebSocket connects). */
    onRoomJoined: ((event: { isCreator: boolean }) => void) | null = null;
    /**
     * Called when all reconnection attempts have been exhausted.
     * If set, the game template can handle the situation (e.g. return to menu).
     * If not set (null), the default behaviour is to reload the page.
     */
    onReconnectFailed: (() => void) | null = null;
    constructor() {
        this.localPlayerId = this.generateId();
        // Enable MsgPack binary protocol by default
        this.enableBinaryProtocol(msgpackEncoder, msgpackDecoder);
    }

    // =====================
    // Public API
    // =====================

    get state(): NetworkState {
        return this._state;
    }

    getLocalPlayerId(): string {
        return this.localPlayerId;
    }

    getGameId(): string {
        return this.gameId;
    }

    getRoomId(): string {
        return this.roomId;
    }

    /**
     * Show the lobby UI (name input → room browser or auto-join). Enters LOBBY state.
     * The lobby always shows a mandatory name input screen first.
     * With autoJoin (default true), it then auto-joins an open room or creates one.
     * With autoJoin false, it shows the room browser for manual selection.
     * @param gameId — the game UID (base ID, used for room listing)
     * @param container — DOM container element
     * @param onNameConfirmed — optional callback when the player confirms their name
     * @param options — lobby options (maxPlayers, autoJoin)
     * @param onLocalGameplayStartRequested — optional callback fired from a local
     * user gesture after the lobby flow is complete.
     */
    showLobby(gameId: string, container: HTMLElement, onNameConfirmed?: (playerName: string) => void, options?: LobbyOptions, onLocalGameplayStartRequested?: () => void): void {
        this.gameId = gameId;
        this.waitForPlayers = options?.waitForPlayers ?? false;
        this.autoEnterGame = options?.autoEnterGame ?? false;
        this.onLocalGameplayStartRequested = onLocalGameplayStartRequested ?? null;
        this.setState('lobby');

        // In creator mode, fetch rooms from all publish versions
        // so creators can see rooms from any published client version.
        const isInIframe = isCreatorMode;

        // In editor mode, use the version-aware multiplayerGameId for room creation
        // so the editor matches the correct published version for matchmaking.
        const multiplayerGameId: string | undefined = (window as any).__multiplayerGameId;

        // For room listing and display, use the versioned multiplayerGameId when available
        // (published standalone clients) or the base gameId (editor mode lists all versions).
        const lobbyGameId = isInIframe ? gameId : (multiplayerGameId ?? gameId);

        this.lobbyUI = new NetworkLobbyUI(container);
        this.lobbyUI.show(
            lobbyGameId,
            (gId) => NetworkManager.getRoomList(gId, isInIframe),
            (event) => {
                // Use the name collected by the lobby's name input view
                this.playerName = this.lobbyUI?.getPlayerName() ?? this.playerName;
                // Notify the template whether the player created or joined the room
                this.onRoomJoined?.({ isCreator: event.isCreator ?? false });
                // Use the room's actual gameId (may be versioned, e.g. "myGame-v2") so
                // creator clients can join rooms from any published version.
                // For new rooms in editor, use multiplayerGameId to match published version.
                const connectGameId = event.gameId ?? multiplayerGameId ?? gameId;
                this.connect(connectGameId, event.roomId, event.roomName, this.playerName, event.data);
            },
            (playerName) => {
                this.playerName = playerName;
                onNameConfirmed?.(playerName);
            },
            options,
        );
    }

    /**
     * Enable or replace the binary protocol codec. MsgPack is enabled by default in the constructor.
     * Call this to substitute a different codec before connect/showLobby.
     * When enabled, outbox messages are serialized via the encoder and sent as binary WebSocket frames.
     * The server prepends a 4-byte msgId; on receive, this class strips the msgId and passes the
     * remaining bytes to the decoder. ACKs still use JSON text frames.
     *
     * @param encoder — converts an array of NetworkMessages to a single Uint8Array payload
     * @param decoder — converts a Uint8Array payload back to an array of NetworkMessages
     */
    enableBinaryProtocol(
        encoder: (msgs: NetworkMessage[]) => Uint8Array,
        decoder: (data: Uint8Array) => NetworkMessage[],
    ): void {
        this.binaryProto = true;
        this.binaryEncoder = encoder;
        this.binaryDecoder = decoder;
    }

    /** @param hz — send rate in Hz (messages per second). Clamped to 5–60. */
    setBatchSendRate(hz: number): void {
        if (!Number.isFinite(hz)) return;
        const clamped = Math.max(5, Math.min(60, hz));
        this.batchInterval = 1 / clamped;
    }

    /** Connect to a room directly (skips lobby). */
    connect(gameId: string, roomId: string, roomName: string, playerName?: string, data?: Record<string, unknown>): void {
        if (this._state === 'connected' || this._state === 'connecting') {
            this.disconnect();
        }

        this.gameId = gameId;
        this.roomId = roomId;
        this.roomName = roomName;
        if (playerName) this.playerName = playerName;

        this.setState('connecting');

        let fullUrl = `${GAME_SERVER_WS_URL}/ws/${encodeURIComponent(gameId)}/${encodeURIComponent(roomId)}?name=${encodeURIComponent(roomName)}&playerId=${encodeURIComponent(this.localPlayerId)}&playerName=${encodeURIComponent(this.playerName)}&ack=1`;
        if (this.binaryProto) {
            fullUrl += '&proto=binary';
        }
        if (data && Object.keys(data).length > 0) {
            fullUrl += `&data=${encodeURIComponent(JSON.stringify(data))}`;
        }

        this.ws = new WebSocket(fullUrl);
        if (this.binaryProto) {
            this.ws.binaryType = 'arraybuffer';
        }
        this.ws.onopen = () => this.handleOpen();
        this.ws.onclose = (e) => this.handleClose(e);
        this.ws.onerror = () => this.handleError();
        this.ws.onmessage = (e) => this.handleMessage(e);
    }

    /** Disconnect and return to DISCONNECTED state. */
    disconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Flush any pending outbox messages before leaving
            this.flushOutbox();
            const msg: LeaveMessage = {
                type: 'leave',
                senderId: this.localPlayerId,
                timestamp: performance.now(),
            };
            this.sendImmediate(msg);
        }

        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            this.ws.close();
            this.ws = null;
        }

        if (this.lobbyUI) {
            this.lobbyUI.dispose();
            this.lobbyUI = null;
        }
        this.onLocalGameplayStartRequested = null;

        for (const playerId of this.remotePlayers.keys()) this.handlePlayerLeft(playerId);
        this.remotePlayers.clear();
        this.playerLifeStates.clear();
        this.lastPingReceived.clear();
        this.pingTimer = 0;
        this.seenMsgIds.clear();
        this.lastEvictedMsgId = 0;
        this.pendingAckIds = [];
        this.ackFlushTimer = 0;
        this.outbox = [];
        this.batchFlushTimer = 0;

        this.setState('disconnected');
    }

    /** Register a NetworkObject for syncing. */
    registerObject(obj: NetworkObject): void {
        this.networkObjects.set(obj.networkId, obj);
    }

    /** Opt in to life-state sync. Existing games omit it and retain their behavior. */
    setLocalPlayerLifeState(state: PlayerLifeState): void {
        if (this.localLifeState?.state === state) return;
        this.localLifeState = Object.freeze({ state, revision: (this.localLifeState?.revision ?? -1) + 1 });
        this.syncObjectNow(`${this.localPlayerId}:player`);
    }

    getLocalPlayerLifeState(): Readonly<PlayerLifeSnapshot> | null { return this.localLifeState; }
    getRemotePlayerLifeState(playerId: string): Readonly<PlayerLifeSnapshot> | null {
        return this.playerLifeStates.get(playerId);
    }

    /** Flush a local object's snapshot without waiting for its idle heartbeat. */
    syncObjectNow(networkId: string): void {
        const object = this.networkObjects.get(networkId);
        if (!this.isConnected() || !object?.isOwner || object.isDestroyed()) return;
        this.send(object.forceCollectState(this.localPlayerId));
        this.flushOutbox();
    }

    /** Unregister a NetworkObject by its networkId. */
    unregisterObject(networkId: string): void {
        this.networkObjects.delete(networkId);
    }

    /** Broadcast a custom event to all other clients in the room. */
    sendEvent(eventName: string, data: Record<string, unknown>): void {
        if (this._state !== 'connected') return;
        const msg: EventMessage = {
            type: 'event',
            senderId: this.localPlayerId,
            timestamp: performance.now(),
            eventName,
            data,
        };
        this.send(msg);
    }

    /**
     * Broadcast a projectile fire event to all players in the room.
     * Remote clients receive this via `events.onRemoteShoot` callback.
     * @param shootData — position, direction, speed, and optional visual properties
     */
    sendShoot(shootData: ShootData): void {
        if (this.localLifeState?.state === 'dead') return;
        if (this._state !== 'connected') return;
        this.sendEvent('_shoot', shootData as unknown as Record<string, unknown>);
    }

    /** Get the local player's display name. */
    getPlayerName(): string {
        return this.playerName;
    }

    /**
     * Call this every frame from the template's update() method.
     * Handles sync, ping, interpolation, and stale detection.
     * No-ops if not connected.
     */
    update(deltaTime: number): void {
        if (this._state !== 'connected') return;

        // --- Collect and send state for owned objects ---
        for (const [, obj] of this.networkObjects) {
            if (obj.isDestroyed()) continue;
            if (!obj.isOwner) continue;

            const stateMsg = obj.collectState(deltaTime, this.localPlayerId);
            if (stateMsg) {
                this.send(stateMsg);
            }
        }

        // --- Ping heartbeat ---
        this.pingTimer += deltaTime;
        if (this.pingTimer >= PING_INTERVAL) {
            this.pingTimer = 0;
            this.sendPing();
        }

        // --- Interpolate non-owned objects ---
        for (const [, obj] of this.networkObjects) {
            if (obj.isDestroyed()) continue;
            if (obj.isOwner) continue;
            obj.updateInterpolation(deltaTime);
        }

        // --- Stale player detection ---
        const now = performance.now();
        for (const [playerId, lastTime] of this.lastPingReceived) {
            if ((now - lastTime) / 1000 > STALE_TIMEOUT) {
                this.handlePlayerLeft(playerId);
            }
        }

        // --- Flush batched ACKs (immediate — server intercepts ACKs by prefix) ---
        this.ackFlushTimer += deltaTime;
        if (this.ackFlushTimer >= NetworkManager.ACK_FLUSH_INTERVAL) {
            if (this.pendingAckIds.length > 0) {
                const ack: AckMessage = { type: 'ack', senderId: this.localPlayerId, timestamp: performance.now(), msgIds: this.pendingAckIds };
                this.sendImmediate(ack);
                this.pendingAckIds = [];
            }
            this.ackFlushTimer = 0;
        }

        // --- Flush outbox at configured rate (default 25Hz) ---
        this.batchFlushTimer += deltaTime;
        if (this.batchFlushTimer >= this.batchInterval) {
            this.batchFlushTimer = 0;
            this.flushOutbox();
        }

        // --- Clean up destroyed objects ---
        for (const [id, obj] of this.networkObjects) {
            if (obj.isDestroyed()) {
                this.networkObjects.delete(id);
            }
        }
    }

    /** Fetch the room list for a game (static, no connection needed). Pass allVersions=true to include rooms from all publish versions. */
    static async getRoomList(gameId: string, allVersions = false): Promise<RoomInfo[]> {
        const httpUrl = GAME_SERVER_HTTP_URL;
        let url = `${httpUrl}/rooms/${encodeURIComponent(gameId)}`;
        if (allVersions) {
            url += '?allVersions=true';
        }
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch room list: ${response.status}`);
        }
        return response.json() as Promise<RoomInfo[]>;
    }

    /** Fetch room data (static, no connection needed). */
    static async getRoomData(gameId: string, roomId: string): Promise<Record<string, unknown>> {
        const response = await fetch(`${GAME_SERVER_HTTP_URL}/rooms/${encodeURIComponent(gameId)}/${encodeURIComponent(roomId)}/data`);
        if (!response.ok) {
            throw new Error(`Failed to fetch room data: ${response.status}`);
        }
        return response.json() as Promise<Record<string, unknown>>;
    }

    /**
     * Get multiplayer spawn points from world data. Primary source: the unified
     * `worldProfileData.spawnPoints` array (every `type: 'player'` entry, sorted
     * by id — spread joining players with `spawnPoints[playerIndex % length]`).
     * Legacy fallback: markers named "Multiplayer Spawn Point 1", "... 2", etc.
     * Returns an empty array when neither is configured.
     */
    static getMultiplayerSpawnPoints(gameData: { worldProfileData?: { spawnPoints?: Array<{ id: string; type: string; position: { x: number; y: number; z: number }; rotationY: number }>; markers?: Array<{ name: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }> } }): Array<{ position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }> {
        // Levels mode: the active level's spawn points win over the global set
        // (all session players share one level, so every client resolves the
        // same list). Falls through to the global array in legacy games.
        const levelPts = getActiveLevelManager()?.getActiveLevel().spawnPoints;
        const sourcePts = levelPts && levelPts.length > 0
            ? levelPts
            : (gameData.worldProfileData?.spawnPoints ?? []);
        const playerPoints = sourcePts.filter(sp => sp.type === 'player');
        if (playerPoints.length > 0) {
            return playerPoints
                .sort((a, b) => a.id.localeCompare(b.id))
                .map(sp => ({ position: sp.position, rotation: { x: 0, y: sp.rotationY, z: 0 } }));
        }
        const markers = gameData.worldProfileData?.markers;
        if (!markers) return [];
        return markers
            .filter(m => m.name.startsWith('Multiplayer Spawn Point'))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(m => ({ position: m.position, rotation: m.rotation }));
    }

    /** Update room data (merge). Returns the updated data. */
    static async updateRoomData(gameId: string, roomId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
        const response = await fetch(`${GAME_SERVER_HTTP_URL}/rooms/${encodeURIComponent(gameId)}/${encodeURIComponent(roomId)}/data`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            throw new Error(`Failed to update room data: ${response.status}`);
        }
        return response.json() as Promise<Record<string, unknown>>;
    }

    /**
     * Temporarily hide or show the lobby UI without disposing it.
     * Used by the editor to hide the lobby when switching to non-prompt tabs.
     */
    setLobbyVisible(visible: boolean): void {
        if (this.lobbyUI) {
            this.lobbyUI.setVisible(visible);
        }
    }

    isConnected(): boolean {
        return this._state === 'connected';
    }

    getRemotePlayers(): Map<string, RemotePlayerInfo> {
        return this.remotePlayers;
    }

    // =====================
    // Internal
    // =====================

    private setState(newState: NetworkState): void {
        if (this._state === newState) return;
        this._state = newState;
        this.onStateChanged?.(newState);
    }

    private handleOpen(): void {
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.setState('connected');

        const sendRate = (window as unknown as Record<string, unknown>).__networkSendRate;
        if (typeof sendRate === 'number' && sendRate > 0) {
            this.setBatchSendRate(sendRate);
        }

        if (this.lobbyUI) {
            if (this.waitForPlayers && this.lobbyUI.isWaitingForPlayers()) {
                // Show waiting room — lobby stays visible until game starts
                this.lobbyUI.showWaitingRoom(() => {
                    this.sendEvent('gameStart', {});
                    if (this.onLocalGameplayStartRequested) {
                        this.lobbyUI?.hide();
                        this.onLocalGameplayStartRequested();
                    } else {
                        this.lobbyUI?.hide();
                    }
                });
                // Initial update with just the local player
                this.updateWaitingRoomPlayerList();
            } else if (this.onLocalGameplayStartRequested) {
                if (this.autoEnterGame) {
                    this.lobbyUI.hide();
                    this.onLocalGameplayStartRequested();
                } else {
                    this.lobbyUI.showEnterGameView(() => {
                        this.lobbyUI?.hide();
                        this.onLocalGameplayStartRequested?.();
                    });
                }
            } else {
                // Normal mode — hide lobby immediately
                this.lobbyUI.hide();
            }
        }

        // Announce ourselves (immediate — must arrive before any batched state)
        const msg: JoinMessage = {
            type: 'join',
            senderId: this.localPlayerId,
            timestamp: performance.now(),
            playerName: this.playerName,
        };
        this.sendImmediate(msg);

        // Flush owned state so anyone already in the room sees us.
        // Force-flush the outbox immediately so initial state isn't delayed by up to 100ms.
        this.flushOwnedState();
        this.flushOutbox();
    }

    private handleClose(_closeEvent: CloseEvent): void {
        this.ws = null;

        // Clean up all remote players immediately — their data is stale now.
        // If we reconnect, they'll re-announce via fresh state messages.
        if (this.remotePlayers.size > 0) {
            const staleIds = [...this.remotePlayers.keys()];
            for (const playerId of staleIds) {
                this.handlePlayerLeft(playerId);
            }
        }

        if (this._state === 'connected' || this._state === 'connecting') {
            this.attemptReconnect();
        }
    }

    private handleError(): void {
        // onclose will fire after onerror, reconnection handled there
    }

    private handleMessage(event: MessageEvent): void {
        // Binary protocol: binary frames arrive as ArrayBuffer with 4-byte msgId prefix.
        // binaryType is set to 'arraybuffer' on connect, so Blob path is not needed.
        if (this.binaryProto && event.data instanceof ArrayBuffer) {
            this.handleBinaryMessage(event.data);
            return;
        }

        let msg: NetworkMessage;
        try {
            msg = JSON.parse(event.data as string) as NetworkMessage;
        } catch {
            return; // Ignore malformed messages
        }

        // Ignore own messages (shouldn't arrive since server doesn't echo, but safety)
        if (msg.senderId === this.localPlayerId) return;

        // --- Reliable delivery: deduplicate and ACK ---
        const msgId = msg._msgId;
        if (msgId !== undefined) {
            if (!this.ackAndDedup(msgId)) return;
        }

        // Batch messages: unpack and process each sub-message
        if (isBatchMessage(msg)) {
            for (const sub of msg.msgs) {
                this.processMessage(sub);
            }
            return;
        }

        this.processMessage(msg);
    }

    /** Handle an incoming binary frame: strip 4-byte msgId prefix, decode payload, process messages. */
    private handleBinaryMessage(buffer: ArrayBuffer): void {
        if (buffer.byteLength < BINARY_MSG_ID_BYTES) return;

        const view = new DataView(buffer);
        const msgId = view.getUint32(0, false); // big-endian

        if (!this.ackAndDedup(msgId)) return;

        // Decode payload (everything after the 4-byte msgId)
        const payload = new Uint8Array(buffer, BINARY_MSG_ID_BYTES);
        if (!this.binaryDecoder) return;

        const msgs = this.binaryDecoder(payload);
        for (const msg of msgs) {
            if (msg.senderId === this.localPlayerId) continue;
            this.processMessage(msg);
        }
    }

    /**
     * ACK a msgId and check for duplicates. Returns true if the message should be processed,
     * false if it's a duplicate. Always ACKs (even duplicates) so the server stops retrying.
     */
    private ackAndDedup(msgId: number): boolean {
        this.pendingAckIds.push(msgId);

        // Watermark check: IDs at or below the watermark are already processed
        if (msgId <= this.lastEvictedMsgId) return false;

        // Skip processing if we've already seen this message
        if (this.seenMsgIds.has(msgId)) return false;
        this.seenMsgIds.add(msgId);

        // Cap seen set using watermark eviction — O(n log n) sort but runs rarely (when set exceeds 2000)
        if (this.seenMsgIds.size > NetworkManager.MAX_SEEN_IDS) {
            let maxRemoved = 0;
            const removeCount = Math.floor(this.seenMsgIds.size / 2);
            const ids = [...this.seenMsgIds].sort((a, b) => a - b);
            for (let i = 0; i < removeCount; i++) {
                const evictId = ids[i]!;
                this.seenMsgIds.delete(evictId);
                if (evictId > maxRemoved) maxRemoved = evictId;
            }
            this.lastEvictedMsgId = maxRemoved;
        }

        return true;
    }

    /** Process a single network message (called directly or from batch unpack). */
    private processMessage(msg: NetworkMessage): void {
        if (isStateMessage(msg)) {
            this.handleStateMessage(msg);
        } else if (isJoinMessage(msg)) {
            this.handleJoinMessage(msg);
        } else if (isLeaveMessage(msg)) {
            this.handlePlayerLeft(msg.senderId);
        } else if (isPingMessage(msg)) {
            this.handlePingMessage(msg);
        } else if (isEventMessage(msg)) {
            this.events._emitCustomEvent(msg.eventName, msg.senderId, msg.data);
            if (msg.eventName === '_shoot') {
                this.events._emitRemoteShoot(msg.senderId, msg.data as unknown as ShootData);
            }
            // Auto-hide waiting room on remote clients when gameStart is received
            if (msg.eventName === 'gameStart' && this.waitForPlayers && this.lobbyUI) {
                if (this.onLocalGameplayStartRequested) {
                    if (this.autoEnterGame) {
                        this.lobbyUI.hide();
                        this.onLocalGameplayStartRequested();
                    } else {
                        this.lobbyUI.showEnterGameView(() => {
                            this.lobbyUI?.hide();
                            this.onLocalGameplayStartRequested?.();
                        });
                    }
                } else {
                    this.lobbyUI.hide();
                }
            }
        }
    }

    private handleStateMessage(msg: StateMessage): void {
        const previousLife = this.playerLifeStates.get(msg.senderId);
        if (msg.networkId === `${msg.senderId}:player` && previousLife && msg.playerLifeState &&
            (msg.playerLifeState.revision < previousLife.revision ||
            (msg.playerLifeState.revision === previousLife.revision && msg.playerLifeState.state !== previousLife.state))) {
            return; // A retried death snapshot must not move/animate a revived player either.
        }
        // Process before asynchronous character loading; keep the latest state
        // even when onUnknownObject is still awaiting its GLB.
        if (this.playerLifeStates.apply(msg)) {
            this.events._emitPlayerLifeState(msg.senderId, this.playerLifeStates.get(msg.senderId)!);
        }
        const obj = this.networkObjects.get(msg.networkId);
        if (obj) {
            obj.applyState(msg);
        } else {
            // Unknown object — let the template create it
            this.onUnknownObject?.(msg.senderId, msg.networkId, msg);
        }

        // Update last-seen for stale detection
        this.lastPingReceived.set(msg.senderId, performance.now());

        // Update remote player name from state messages (state arrives every frame,
        // so this ensures the name is always up-to-date even if the join message was missed)
        if (msg.playerName) {
            const remote = this.remotePlayers.get(msg.senderId);
            if (remote) {
                remote.playerName = msg.playerName;
            } else {
                this.remotePlayers.set(msg.senderId, {
                    playerId: msg.senderId,
                    playerName: msg.playerName,
                    lastPingTime: performance.now(),
                });
            }
        }
    }

    private handleJoinMessage(msg: JoinMessage): void {
        // Track remote player (update if already known — handles reconnections)
        this.remotePlayers.set(msg.senderId, {
            playerId: msg.senderId,
            playerName: msg.playerName,
            lastPingTime: performance.now(),
        });
        this.lastPingReceived.set(msg.senderId, performance.now());

        this.events._emitPlayerJoined(msg.senderId, msg.playerName);

        // Update waiting room UI if active
        this.updateWaitingRoomPlayerList();

        // Flush all owned objects' state so the new player sees everything immediately
        this.flushOwnedState();
        this.flushOutbox();
    }

    private handlePingMessage(msg: PingMessage): void {
        this.lastPingReceived.set(msg.senderId, performance.now());

        // Update remote player info
        const remote = this.remotePlayers.get(msg.senderId);
        if (remote) {
            remote.lastPingTime = performance.now();
        }
    }

    private handlePlayerLeft(playerId: string): void {
        this.playerLifeStates.remove(playerId);
        this.remotePlayers.delete(playerId);
        this.lastPingReceived.delete(playerId);

        // Remove all NetworkObjects owned by this player
        for (const [id, obj] of this.networkObjects) {
            // NetworkIds from remote players start with their senderId
            if (id.startsWith(playerId + ':')) {
                obj.destroy();
                this.networkObjects.delete(id);
            }
        }

        this.events._emitPlayerLeft(playerId);

        // Update waiting room UI if active
        this.updateWaitingRoomPlayerList();
    }

    /** Update the waiting room player list if it's currently shown. */
    private updateWaitingRoomPlayerList(): void {
        if (!this.lobbyUI || !this.waitForPlayers) return;
        // Build full player list: local player + all remote players
        const players: Array<{ playerId: string; playerName: string }> = [
            { playerId: this.localPlayerId, playerName: this.playerName },
        ];
        for (const [, remote] of this.remotePlayers) {
            players.push({ playerId: remote.playerId, playerName: remote.playerName });
        }
        this.lobbyUI.updateWaitingRoom(players);
    }

    /** Force-send current state of all owned objects. Called on join and when a new player appears. */
    private flushOwnedState(): void {
        for (const [, obj] of this.networkObjects) {
            if (obj.isDestroyed() || !obj.isOwner) continue;
            const stateMsg = obj.forceCollectState(this.localPlayerId);
            this.send(stateMsg);
        }
    }

    private sendPing(): void {
        const ownedIds: string[] = [];
        for (const [id, obj] of this.networkObjects) {
            if (obj.isOwner && !obj.isDestroyed()) {
                ownedIds.push(id);
            }
        }
        const msg: PingMessage = {
            type: 'ping',
            senderId: this.localPlayerId,
            timestamp: performance.now(),
            networkIds: ownedIds,
        };
        this.send(msg);
    }

    /** Queue a message for the next batch flush (default 25Hz, configurable via setBatchSendRate). */
    private send(msg: NetworkMessage): void {
        this.outbox.push(msg);
    }

    /** Send a message immediately, bypassing the outbox. Used for join/leave/ACK. */
    private sendImmediate(msg: NetworkMessage): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    /** Flush the outbox: pack all queued messages into a single batch and send. */
    private flushOutbox(): void {
        if (this.outbox.length === 0) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.outbox.length = 0;
            return;
        }

        if (this.binaryProto && this.binaryEncoder) {
            // Binary protocol: encode all outbox messages into a single binary frame.
            // Server prepends 4-byte msgId on relay. No batch wrapper needed — the encoder
            // packs the array directly and the decoder unpacks it on the other end.
            const encoded = this.binaryEncoder(this.outbox);
            // TS 6.0's lib.dom narrowed WebSocket.send to ArrayBuffer-backed views.
            // The public encoder signature stays the wider `Uint8Array` so encoders in
            // already-published games keep type-checking; nothing here is SharedArrayBuffer-backed.
            this.ws.send(encoded as Uint8Array<ArrayBuffer>);
        } else if (this.outbox.length === 1) {
            // Single message — send directly, no batch wrapper overhead
            this.ws.send(JSON.stringify(this.outbox[0]));
        } else {
            const batch: BatchMessage = {
                type: 'batch',
                senderId: this.localPlayerId,
                timestamp: performance.now(),
                msgs: this.outbox,
            };
            this.ws.send(JSON.stringify(batch));
        }
        this.outbox = [];
    }

    private attemptReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.setState('disconnected');
            if (this.onReconnectFailed) {
                this.onReconnectFailed();
            } else {
                // Default: reload the page to get a clean game state
                console.warn('🔌 All reconnection attempts failed — reloading page');
                window.location.reload();
            }
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 16000);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this._state === 'disconnected') return; // User explicitly disconnected
            this.connect(this.gameId, this.roomId, this.roomName, this.playerName);
        }, delay);
    }

    private generateId(): string {
        // crypto.randomUUID() is available in modern browsers
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback
        return 'xxxx-xxxx-xxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
    }
}
