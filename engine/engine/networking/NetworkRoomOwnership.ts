// NetworkRoomOwnership: Room ownership and level load coordination.
//
// Tracks which player is the "room owner" (authority for level sync decisions).
// The room creator becomes the initial owner. If the owner leaves, ownership
// migrates deterministically to the player with the smallest playerId.
//
// Level load sync is driven by the room owner:
// - Each client sends _levelLoaded event when done loading
// - The owner collects reports and broadcasts _allPlayersLoaded when all ready
// - Non-owners listen for _allPlayersLoaded to proceed
//
// USAGE:
//
//   const roomSync = new NetworkRoomOwnership(networkManager);
//
//   // When connected:
//   roomSync.claimOwnership();  // Call on the room creator
//
//   // When level loading completes:
//   roomSync.reportLoaded();
//
//   // When all players are ready:
//   roomSync.onAllLoaded = () => startGame();
//
//   // Wire player lifecycle from your template's handlers:
//   networkManager.events.onPlayerJoined = (playerId, name) => {
//       roomSync.handlePlayerJoined(playerId);
//       // ... your other join logic
//   };
//   networkManager.events.onPlayerLeft = (playerId) => {
//       roomSync.handlePlayerLeft(playerId);
//       // ... your other leave logic
//   };
//
//   // Every frame:
//   roomSync.update(deltaTime);
//
//   // Cleanup:
//   roomSync.dispose();

import type { NetworkManager } from 'engine/networking/NetworkManager.js';

type CustomEventHandler = (senderId: string, data: Record<string, unknown>) => void;

export class NetworkRoomOwnership {
    private networkManager: NetworkManager;
    private currentOwnerId: string | null = null;
    private knownPlayerIds: Set<string> = new Set();

    // Level load tracking
    private localLoaded: boolean = false;
    private remoteLoadedPlayers: Set<string> = new Set();
    private allLoadedFired: boolean = false;

    // Timeout
    private timeoutSeconds: number;
    private elapsedTime: number = 0;

    // Event handlers (stored for cleanup)
    private handleRoomOwnerEvent: CustomEventHandler;
    private handleLevelLoadedEvent: CustomEventHandler;
    private handleAllPlayersLoadedEvent: CustomEventHandler;

    /** Fires once when the room owner confirms all connected players have loaded. */
    onAllLoaded: (() => void) | null = null;

    /** Fires if the timeout expires before all players loaded. Receives list of pending playerIds. */
    onTimeout: ((pendingPlayers: string[]) => void) | null = null;

    /** Fires when ownership changes (initial claim or migration). Receives the new owner's playerId. */
    onOwnerChanged: ((ownerId: string) => void) | null = null;

    constructor(networkManager: NetworkManager, options?: { timeout?: number }) {
        this.networkManager = networkManager;
        this.timeoutSeconds = options?.timeout ?? 30;

        // Register custom event handlers
        this.handleRoomOwnerEvent = (_senderId: string, data: Record<string, unknown>) => {
            const ownerId = data['ownerId'] as string;
            if (ownerId && ownerId !== this.currentOwnerId) {
                this.currentOwnerId = ownerId;
                this.onOwnerChanged?.(ownerId);
            }
        };

        this.handleLevelLoadedEvent = (senderId: string, _data: Record<string, unknown>) => {
            this.remoteLoadedPlayers.add(senderId);
            // If we're the owner, check if all are loaded
            if (this.isOwner()) {
                this.checkAndBroadcastAllLoaded();
            }
        };

        this.handleAllPlayersLoadedEvent = (_senderId: string, _data: Record<string, unknown>) => {
            // Owner has confirmed all players loaded
            if (!this.allLoadedFired) {
                this.allLoadedFired = true;
                this.onAllLoaded?.();
            }
        };

        this.networkManager.events.on('_roomOwner', this.handleRoomOwnerEvent);
        this.networkManager.events.on('_levelLoaded', this.handleLevelLoadedEvent);
        this.networkManager.events.on('_allPlayersLoaded', this.handleAllPlayersLoadedEvent);
    }

    // =====================
    // Room Ownership
    // =====================

    /** Claim ownership of the room. Call this on the room creator after connecting. */
    claimOwnership(): void {
        this.currentOwnerId = this.networkManager.getLocalPlayerId();
        this.networkManager.sendEvent('_roomOwner', { ownerId: this.currentOwnerId });
        this.onOwnerChanged?.(this.currentOwnerId);
    }

    /** Whether the local player is the current room owner. */
    isOwner(): boolean {
        return this.currentOwnerId === this.networkManager.getLocalPlayerId();
    }

    /** Get the current room owner's playerId, or null if not yet established. */
    getOwnerId(): string | null {
        return this.currentOwnerId;
    }

    // =====================
    // Level Load Sync
    // =====================

    /** Report that the local client has finished loading the level. */
    reportLoaded(): void {
        this.localLoaded = true;
        this.networkManager.sendEvent('_levelLoaded', { loadedAt: Date.now() });

        // If we're the owner, check immediately
        if (this.isOwner()) {
            this.checkAndBroadcastAllLoaded();
        }
    }

    /** Whether all currently connected players have reported loaded. */
    isAllLoaded(): boolean {
        if (!this.localLoaded) return false;
        const remotePlayers = this.networkManager.getRemotePlayers();
        for (const [playerId] of remotePlayers) {
            if (!this.remoteLoadedPlayers.has(playerId)) return false;
        }
        return true;
    }

    /** Get list of playerIds who haven't loaded yet. */
    getPendingPlayers(): string[] {
        const pending: string[] = [];
        if (!this.localLoaded) pending.push(this.networkManager.getLocalPlayerId());
        const remotePlayers = this.networkManager.getRemotePlayers();
        for (const [playerId] of remotePlayers) {
            if (!this.remoteLoadedPlayers.has(playerId)) {
                pending.push(playerId);
            }
        }
        return pending;
    }

    // =====================
    // Player Lifecycle
    // =====================

    /** Call this from your template's onPlayerJoined handler. */
    handlePlayerJoined(playerId: string): void {
        this.knownPlayerIds.add(playerId);

        // If we're the owner, announce ownership so the new player knows
        if (this.isOwner()) {
            this.networkManager.sendEvent('_roomOwner', { ownerId: this.currentOwnerId });

            // If loading already completed, re-broadcast so the late joiner can proceed
            if (this.allLoadedFired) {
                this.networkManager.sendEvent('_allPlayersLoaded', {});
            }
        }
    }

    /** Call this from your template's onPlayerLeft handler. */
    handlePlayerLeft(playerId: string): void {
        this.knownPlayerIds.delete(playerId);
        this.remoteLoadedPlayers.delete(playerId);

        // Check if the departed player was the owner
        if (playerId === this.currentOwnerId) {
            this.migrateOwnership();
        }

        // If we're the (possibly new) owner, re-check load status
        if (this.isOwner() && !this.allLoadedFired) {
            this.checkAndBroadcastAllLoaded();
        }
    }

    // =====================
    // Update Loop
    // =====================

    /** Call every frame. Handles timeout for level load coordination. */
    update(deltaTime: number): void {
        if (this.allLoadedFired) return;

        this.elapsedTime += deltaTime;
        if (this.elapsedTime >= this.timeoutSeconds) {
            const pending = this.getPendingPlayers();
            if (pending.length > 0) {
                this.onTimeout?.(pending);
            }

            // Fire allLoaded anyway so the game proceeds
            this.allLoadedFired = true;
            this.onAllLoaded?.();

            // If owner, broadcast so non-owners also proceed
            if (this.isOwner()) {
                this.networkManager.sendEvent('_allPlayersLoaded', {});
            }
        }
    }

    /** Reset for a new level transition. Clears all load state but preserves ownership. */
    reset(): void {
        this.localLoaded = false;
        this.remoteLoadedPlayers.clear();
        this.allLoadedFired = false;
        this.elapsedTime = 0;
    }

    /** Clean up event listeners. */
    dispose(): void {
        this.networkManager.events.off('_roomOwner', this.handleRoomOwnerEvent);
        this.networkManager.events.off('_levelLoaded', this.handleLevelLoadedEvent);
        this.networkManager.events.off('_allPlayersLoaded', this.handleAllPlayersLoadedEvent);
        this.onAllLoaded = null;
        this.onTimeout = null;
        this.onOwnerChanged = null;
    }

    // =====================
    // Internal
    // =====================

    /**
     * Migrate ownership after the current owner leaves.
     * Uses deterministic selection: smallest playerId among remaining players.
     * All clients compute the same result independently.
     */
    private migrateOwnership(): void {
        const localId = this.networkManager.getLocalPlayerId();
        const remotePlayers = this.networkManager.getRemotePlayers();

        // Collect all remaining playerIds
        const candidates: string[] = [localId];
        for (const [playerId] of remotePlayers) {
            candidates.push(playerId);
        }

        if (candidates.length === 0) {
            this.currentOwnerId = null;
            return;
        }

        // Deterministic: pick lexicographically smallest
        candidates.sort();
        const newOwnerId = candidates[0]!;
        this.currentOwnerId = newOwnerId;
        this.onOwnerChanged?.(newOwnerId);

        // If we became the new owner, announce and take over level sync
        if (newOwnerId === localId) {
            this.networkManager.sendEvent('_roomOwner', { ownerId: newOwnerId });

            // Re-check if all players have loaded (we may have inherited completed reports)
            if (!this.allLoadedFired) {
                this.checkAndBroadcastAllLoaded();
            }
        }
    }

    /**
     * (Owner only) Check if all players are loaded and broadcast _allPlayersLoaded if so.
     */
    private checkAndBroadcastAllLoaded(): void {
        if (this.allLoadedFired) return;
        if (!this.isAllLoaded()) return;

        this.allLoadedFired = true;
        this.networkManager.sendEvent('_allPlayersLoaded', {});
        this.onAllLoaded?.();
    }
}
