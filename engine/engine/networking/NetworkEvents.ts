// Type-safe event callback system for network player lifecycle and custom events
import type { ShootData, PlayerLifeSnapshot } from 'engine/networking/NetworkTypes.js';

type CustomEventHandler = (senderId: string, data: Record<string, unknown>) => void;

export class NetworkEvents {
    private readonly lifeHandlers = new Set<(playerId: string, life: Readonly<PlayerLifeSnapshot>) => void>();

    /** Subscribe without replacing MultiplayerSetup's player lifecycle callbacks. */
    onPlayerLifeStateChanged(handler: (playerId: string, life: Readonly<PlayerLifeSnapshot>) => void): () => void {
        this.lifeHandlers.add(handler);
        return () => { this.lifeHandlers.delete(handler); };
    }

    /** @internal Emitted only after revision/ownership validation. */
    _emitPlayerLifeState(playerId: string, life: Readonly<PlayerLifeSnapshot>): void {
        for (const handler of this.lifeHandlers) handler(playerId, life);
    }
    /** Fired when a remote player joins the room */
    onPlayerJoined: ((playerId: string, playerName: string) => void) | null = null;

    /** Fired when a remote player leaves the room (explicit leave or stale timeout) */
    onPlayerLeft: ((playerId: string) => void) | null = null;

    /** Fired when a remote player fires a projectile */
    onRemoteShoot: ((senderId: string, shootData: ShootData) => void) | null = null;

    private customHandlers: Map<string, CustomEventHandler[]> = new Map();

    /** Register a handler for a custom event name */
    on(eventName: string, handler: CustomEventHandler): void {
        let handlers = this.customHandlers.get(eventName);
        if (!handlers) {
            handlers = [];
            this.customHandlers.set(eventName, handlers);
        }
        handlers.push(handler);
    }

    /** Unregister a handler for a custom event name */
    off(eventName: string, handler: CustomEventHandler): void {
        const handlers = this.customHandlers.get(eventName);
        if (!handlers) return;
        const idx = handlers.indexOf(handler);
        if (idx !== -1) {
            handlers.splice(idx, 1);
        }
        if (handlers.length === 0) {
            this.customHandlers.delete(eventName);
        }
    }

    /** @internal Called by NetworkManager when a join message is received */
    _emitPlayerJoined(playerId: string, playerName: string): void {
        this.onPlayerJoined?.(playerId, playerName);
    }

    /** @internal Called by NetworkManager when a leave or stale timeout occurs */
    _emitPlayerLeft(playerId: string): void {
        this.onPlayerLeft?.(playerId);
    }

    /** @internal Called by NetworkManager when a shoot event is received */
    _emitRemoteShoot(senderId: string, shootData: ShootData): void {
        this.onRemoteShoot?.(senderId, shootData);
    }

    /** @internal Called by NetworkManager when a custom event message is received */
    _emitCustomEvent(eventName: string, senderId: string, data: Record<string, unknown>): void {
        const handlers = this.customHandlers.get(eventName);
        if (!handlers) return;
        for (const handler of handlers) {
            handler(senderId, data);
        }
    }

    /** Remove all handlers */
    dispose(): void {
        this.lifeHandlers.clear();
        this.onPlayerJoined = null;
        this.onPlayerLeft = null;
        this.onRemoteShoot = null;
        this.customHandlers.clear();
    }
}
