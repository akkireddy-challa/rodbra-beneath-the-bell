/**
 * Keyring — session-scoped collection of key ids the player has picked up.
 *
 * Pure data structure with zero engine imports so it can be unit-tested in
 * isolation and shared freely between the pieces that need it: `KeyPickup`
 * (grants on collect), `DungeonDoor` (checks `has()` to unlock), and
 * `DoorSystem` (owns the instance, feeds `grant()` from remote network
 * deltas, reads `keys()` into the multiplayer snapshot). Session-scoped by
 * construction — `DoorSystem` builds one instance per game session, so it
 * survives respawns and level switches but resets naturally on a page
 * reload (a fresh engine boot builds a fresh instance); nothing here
 * persists on its own.
 */
export class Keyring {
    /** Insertion-ordered list of granted key ids. */
    private readonly order: string[] = [];
    /** Same ids as `order`, for O(1) `has()`/duplicate checks. */
    private readonly held = new Set<string>();
    private readonly listeners = new Set<(keyId: string) => void>();

    /** Add a key id. No-op — and fires no event — if already held. */
    grant(keyId: string): void {
        if (this.held.has(keyId)) return;
        this.held.add(keyId);
        this.order.push(keyId);
        for (const listener of this.listeners) listener(keyId);
    }

    /** Whether this key id has already been granted. */
    has(keyId: string): boolean {
        return this.held.has(keyId);
    }

    /** All held key ids, in the deterministic order they were granted. */
    keys(): ReadonlyArray<string> {
        return [...this.order];
    }

    /**
     * Subscribe to newly granted keys. Fires once per `grant()` call that
     * actually adds a new key (never for a duplicate grant of an already-held
     * key). Returns an unsubscribe function.
     */
    onChanged(cb: (keyId: string) => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
}
