# Persistent shared multiplayer state

The engine ships a generic helper, `SharedMultiplayerState`, for any multiplayer game that needs its state to survive across sessions: paint canvases, board positions, score tables, world mutations — anything the game can serialize. The game provides callbacks describing its state model; the helper handles live broadcast to other clients in the room, periodic + explicit persistence to Firestore via GameDataService, snapshot push on join, and host migration.

**One system, any state shape.** No voxel-specific assumptions.

## When to use it

Whenever the user asks for state to persist across reloads in a multiplayer game:

- "Save what we build / paint / place"
- "Everyone sees the same world, and it survives reload"
- "Mini-MMO / shared canvas / persistent room"
- "Score board that doesn't reset"

The helper is in `game/src/engine/networking/SharedMultiplayerState.ts`. It depends on `NetworkManager` (any of `MultiplayerSetup` / `BlancoMultiplayerSetup` provides this) and `GameDataService` (already wired in `GameEngine`).

## When NOT to use it

- **Single-player games.** No NetworkManager = nothing to broadcast over. Use `GameDataService` directly. See `@docs game-data-service.md`.
- **State that won't fit in a single 1 MB JSON snapshot.** GameDataService's `data` field caps at 1 MB per entry. For huge worlds (thousands of mutations, large voxel terrain), use per-shard storage instead: set `worldProfileData.persistentWorld` and the engine's `WorldShardSync` streams voxel edits to game-server's `world-shards` collection.
- **Edits the game has no way to serialize/deserialize cleanly.** If your state lives in random Three.js scene-graph nodes, factor out a plain-data model first.

## Anti-pattern — do NOT do this

The agent has previously written inline persistence directly in `Game.ts` like this:

```ts
// ❌ DO NOT WRITE THIS
const STORAGE_CATEGORY = 'paint-canvas';

private async loadPersistedCanvas() {
    const svc = this.engine.getGameDataService?.();
    const result = await svc.list(STORAGE_CATEGORY, {
        orderBy: 'values.savedAt', orderDir: 'desc', limit: 1,
    });
    // ... apply latest entry's data.cells ...
}

private async persistCanvas() {
    const svc = this.engine.getGameDataService?.();
    await svc.create(STORAGE_CATEGORY, {
        data: { cells: this.cells.slice() },
        values: { savedAt: Date.now() },
    });
}

// Plus manual onPlayerJoined → sendGameState({cells}) snapshot push
// Plus manual onMove → applyAndBroadcast routing through host
// Plus manual dirty flag + 5-second save tick in update()
// Plus manual `cellPaint` event broadcast/receive
```

This reimplements `SharedMultiplayerState` poorly. It picks arbitrary field names (`savedAt`) that may not be Firestore-indexed, it duplicates the host-detection + save-tick logic, it splits the snapshot push (`sendGameState`) from the persistence load (`loadPersistedCanvas`) so they get out of sync, and the multiplayer routing through `onMove` → host → `cellPaint` is custom for every game.

**Always prefer the helper.** The "How to use it" example above produces the same behavior in ~20 lines, with no inline `svc.create`/`svc.list` calls and no manual snapshot/host routing.

If you're modifying an existing game that uses this anti-pattern, migrate it to `SharedMultiplayerState`:
1. Replace `loadPersistedCanvas` + `persistCanvas` with one `SharedMultiplayerState` instance constructed in `load()`.
2. Replace `paintCell`'s host-vs-non-host routing with one `sharedState.emit({ ... })` call.
3. Delete the manual `onPlayerJoined → sendGameState` block; the helper's snapshot-request flow handles new joiners.
4. Delete the `cellPaint` / `onMove` event handlers; the helper routes deltas internally.
5. Delete the `dirty` flag + 5-second save tick in `update()`; the helper does its own host-gated tick.

## How to use it

In your `Game.ts`:

```ts
import { SharedMultiplayerState } from 'engine/networking/SharedMultiplayerState.js';
import { BlancoMultiplayerSetup } from 'engine/networking/index.js';

interface PaintDelta { idx: number; color: number }
interface CanvasSnapshot { colors: number[] }

export class MyGame implements GenreGameInterface {
    private multiplayer: BlancoMultiplayerSetup | null = null;
    private sharedState: SharedMultiplayerState<PaintDelta, CanvasSnapshot> | null = null;
    private cellColors: number[] = new Array(GRID_SIZE * GRID_SIZE).fill(0xffffff);

    async load(gameId: string): Promise<void> {
        // ...
        this.multiplayer = new BlancoMultiplayerSetup({
            engine: this.engine,
            lobbyOptions: { autoJoin: true, maxPlayers: 8 },
        });

        this.sharedState = new SharedMultiplayerState<PaintDelta, CanvasSnapshot>({
            name: 'canvas',                          // gamedata category + WS event prefix
            networkManager: this.multiplayer.networkManager,
            gameDataService: this.engine.getGameDataService(),
            isHost: () => this.multiplayer?.isRoomHost ?? false,
            applyDelta: (d) => this.setCellColor(d.idx, d.color),
            serializeSnapshot: () => ({ colors: this.cellColors.slice() }),
            applySnapshot: (s) => s.colors.forEach((c, i) => this.setCellColor(i, c)),
            // Optional: persistFlushIntervalMs (default 5000). Set to 0 to disable
            // the periodic tick and rely only on explicit save() calls.
        });
        await this.sharedState.start();

        await this.multiplayer.showLobby(gameId);
    }

    // Hook click handler — one emit replaces broadcast+persist+host-routing:
    private onPaintCell(idx: number, color: number) {
        this.sharedState?.emit({ idx, color });
    }

    // Explicit save (in addition to the periodic tick) when something
    // meaningful just happened:
    async onRoundEnd() {
        await this.sharedState?.save();
    }

    dispose() {
        this.sharedState?.dispose();
        this.multiplayer?.dispose();
    }
}
```

That's the entire integration. Three callbacks (`applyDelta`, `serializeSnapshot`, `applySnapshot`) plus one host predicate (`isHost`).

## What the helper does for you

| Concern | Behavior |
|---|---|
| **Local edit** | `emit(delta)` calls `applyDelta(delta, 'self')` (optimistic local update) then broadcasts a `<name>.delta` event over the multiplayer WS. |
| **Remote edit** | Server relays the delta to other clients; their `SharedMultiplayerState` receives it and calls `applyDelta(delta, senderId)`. |
| **Cross-session load** | On `start()`, reads the latest snapshot entry from `GameDataService.list(<name>, { orderBy: 'createdAt', desc, limit: 1, fields: 'all' })` and calls `applySnapshot`. |
| **Catch-up on join** | Also broadcasts a `<name>.snapshotRequest` so any current host responds with its live state via `<name>.snapshot` — covers the gap between "last persisted save" and "right now." |
| **Periodic save** | Every `persistFlushIntervalMs` (default 5 s), if `isHost()` returns true, serializes the snapshot and writes one entry to GameDataService. Non-hosts skip. |
| **Explicit save** | `await sharedState.save()` triggers an immediate save (still host-gated). Use for "I want this committed now" moments — round end, before navigating away, etc. |
| **Host migration** | The helper polls `isHost()` per tick. When `NetworkRoomOwnership` migrates the host (smallest-playerId after disconnect), the new host's next tick starts saving. No special handoff code in the game. |

## Storage layout

Whatever `name` you pick becomes the gamedata category. The latest entry is the current state.

```
games/{gameId}/categories/{name}/entries/{auto-id}
  data:   <your snapshot, JSON, up to 1 MB>
  values: { t: <timestamp ms> }
```

On load, `orderBy: 'createdAt' desc limit: 1` pulls the latest. `createdAt` is server-stamped at insert time, single-field-indexed by Firestore automatically, no composite index needed. Older entries grow but stay there (no automatic GC in v1 — Firestore retains everything until a manual prune).

## Wire protocol (handled by the helper — don't call directly)

| Event name | Direction | Purpose |
|---|---|---|
| `<name>.delta` | client → server (broadcast to room) | One game state change |
| `<name>.snapshotRequest` | client → server (broadcast) | "Send me current state" |
| `<name>.snapshot` | host → room | Full snapshot reply |

Each name (`canvas`, `voxel-world`, whatever) gets its own event namespace so multiple `SharedMultiplayerState` instances can coexist on different state streams within one game.

## Host responsibility

Only the room host writes to Firestore. Non-host emits broadcast their delta and the host receives + applies it; on the host's next save tick, that delta is part of the snapshot the host serializes. So **every player's edits get persisted via the host's view**.

If the host disconnects, `NetworkRoomOwnership` automatically migrates ownership to the smallest-playerId remaining client. That new host's `isHost()` flips to true on their next tick; their save fires. Continuity preserved without per-game code.

If the room is empty (no host), saves don't happen — edits buffered in-memory in clients but no Firestore writes. When a player rejoins, that player becomes host, the next save tick commits everything they have locally.

## Common pitfalls

- **Don't use this in single-player games.** No NetworkManager means `emit` has nothing to broadcast over and snapshot requests have nothing to ask. Use `GameDataService` directly with create/list calls.
- **Don't write huge snapshots.** Each save serializes the full state. If your snapshot is approaching 1 MB JSON-encoded, you'll hit GameDataService's per-entry cap. Either downsample (e.g., quantize colors) or move to per-shard storage (`worldProfileData.persistentWorld` + `WorldShardSync`).
- **Don't forget `isHost`.** Without a working `isHost()` callback, no client ever saves. The helper polls it every tick — make sure it returns truthy on the host and falsy elsewhere. `BlancoMultiplayerSetup.isRoomHost` works out of the box.
- **Don't subscribe to `<name>.delta` events manually.** The helper does it. Game code calls `emit()`; remote application happens via the `applyDelta` callback you provided at construction.
- **Don't write your own snapshot-on-join logic.** The helper handles it. Specifically: no manual `onPlayerJoined → sendGameState({...})` — the `snapshotRequest` flow replaces that.

## Migration from per-paint-event GameDataService writes

If a saved game has `persistPaint(idx, color, t) → svc.create('paint-events', { values: { idx, color, t } })` plus `loadPersistedCanvas() → svc.list('paint-events', { orderBy: 'values.t' })`, that's the old event-log model — every paint = one entry, reload replays all entries. It works but writes are per-paint (high Firestore cost) and storage grows linearly forever.

To migrate: replace both methods with one `SharedMultiplayerState` instance (see usage example above). The save tick captures the full state every 5 s, so writes are bounded; reads are O(1) (latest entry only). Existing data in the old `paint-events` category stays but won't be read by the new code — manual migration or accepted loss.
