# Multiplayer Networking System

Entry point for multiplayer. This doc covers choosing a setup, the rules that apply to every
multiplayer game, connection/lobby, spawn points and room data. Six companion docs cover the
rest — read one when the task calls for it:

| Need | Doc |
|------|-----|
| Wire multiplayer into a 3D character game — the `MultiplayerSetup` helper, lifecycle callbacks, per-player appearance | `@docs multiplayer-setup.md` |
| Board / card / puzzle / turn-based game with no walking avatar — `BlancoMultiplayerSetup` | `@docs multiplayer-blanco.md` |
| Syncing shooting, hits, explosions and weapons | `@docs multiplayer-combat-sync.md` |
| Syncing characters, animals and NPCs — animation state, visual config, client-side hit detection | `@docs multiplayer-entity-sync.md` |
| Syncing world objects — what must be synced, platforms/doors, host ownership, deterministic voxel destruction | `@docs multiplayer-world-sync.md` |
| Full manual control instead of the helper — raw `NetworkManager` / `NetworkObject` wiring | `@docs multiplayer-manual-integration.md` |


---

## Choose Your Multiplayer Setup

| Game Type | Setup Class | Section to Read |
|-----------|------------|-----------------|
| FPS/TPS/adventure — player character walks around a 3D world | `MultiplayerSetup` | `@docs multiplayer-setup.md` |
| Board/card/puzzle/strategy — **no walking avatar**, event-based sync | `BlancoMultiplayerSetup` | `@docs multiplayer-blanco.md` |

Both are imported from `engine/networking/index.js`. Pick one — do NOT mix them in the same game.

---

## MANDATORY RULES

**All multiplayer games:**
1. Load game fully first — show lobby LAST
2. Lobby: **name input** → **auto-join** (default) or room browser. Gameplay starts AFTER connecting.
3. **DO NOT** build custom networking — use the built-in setup classes.

**MultiplayerSetup only (character-based games):**
4. Import `getDefaultCharacterUrl` from `engine/CharacterConfig.js` and `buildAnimationList` from `engine/AnimationPacks.js`
5. Use `NetworkCharacterController.create()` in `onUnknownObject` for remote players
6. Pass `animationProvider` on local player's `NetworkObject`
7. **Sync ALL moving objects** (enemies, NPCs, platforms, doors) as `NetworkObject`. See `@docs multiplayer-world-sync.md`.
8. **NEVER** use capsules/boxes/placeholders for remote players — they MUST look identical to local player.

**BlancoMultiplayerSetup only (event-based games):**
9. Do NOT import character/NPC/animal/weapon/spawn-point systems.
10. Sync via `sendGameState()` / `sendMove()` / `sendTurnChange()` — not `NetworkObject`.
11. The room host is the authority — validate moves on the host, broadcast state from the host.

---

## Overview

Photon-like multiplayer module: WebSocket connections, room management, object state sync, lobby UI.

| Class | Import | Purpose |
|-------|--------|---------|
| `NetworkManager` | `engine/networking/index.js` | Connection, rooms, sync hub |
| `NetworkObject` | `engine/networking/index.js` | Attach to Object3D for network sync |
| `NetworkCharacterController` | `engine/networking/index.js` | Full animated remote character |
| `AnimationStateProvider` | `engine/networking/index.js` | Owner-side: provides anim + weapon state |
| `AnimationStateReceiver` | `engine/networking/index.js` | Receiver-side: applies anim state |
| `WeaponStateReceiver` | `engine/networking/index.js` | Receiver-side: weapon equip/aim (handled internally by `NetworkCharacterController`) |

---

## Connection Flow

```
DISCONNECTED → showLobby() → LOBBY (name input → auto-join/room browser) → CONNECTING → CONNECTED
```

**Default behavior (autoJoin=true):** After name input, automatically joins first open room with space or creates a new one. No room browser shown.

**Manual mode (autoJoin=false):** Shows room browser for manual create/join.

Every player has a unique `playerId` (UUID) and `playerName` (entered in lobby). Room list API returns `players` array with `{ playerId, playerName }` per room.

### Lobby Options

```typescript
// Default: auto-join, max 8 players per room
this.networkManager.showLobby(gameId, this.engine.container, (playerName) => {
    this.localPlayerName = playerName;
});

// Custom: manual room browser, max 4 players
this.networkManager.showLobby(gameId, this.engine.container, (playerName) => {
    this.localPlayerName = playerName;
}, { autoJoin: false, maxPlayers: 4 });

// Wait for players: shows waiting room until 4 players join, then host clicks "Start Game"
this.networkManager.showLobby(gameId, this.engine.container, (playerName) => {
    this.localPlayerName = playerName;
}, { waitForPlayers: true, minPlayersToStart: 4 });
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoJoin` | boolean | `true` | Auto-join open room or create one after name input |
| `maxPlayers` | number | `8` | Max players per room. Rooms at capacity are skipped/shown as "Full" |
| `waitForPlayers` | boolean | `false` | Show waiting room after connecting until `minPlayersToStart` met |
| `minPlayersToStart` | number | `2` | Min players needed before "Start Game" button enables (used with `waitForPlayers`) |

When `autoJoin` is true:
1. Player enters name → "Finding game..." screen
2. Fetches room list → joins fullest open room below `maxPlayers` cap
3. If no open room exists → auto-creates one (room data includes `{ maxPlayers }`)
4. On fetch error → falls back to manual room browser

Room browser shows player count as `3/8` badge per room. Full rooms show "Full" badge (not joinable).

### Waiting Room Mode (`waitForPlayers: true`)

For games that need all players present at start (races, rounds, etc.):

1. Player connects to room normally (via auto-join or room browser)
2. Instead of hiding lobby → shows **waiting room UI** with live player list
3. "Start Game" button disabled until `playerCount >= minPlayersToStart`
4. Any connected player can click "Start Game" → broadcasts `gameStart` event to all clients → hides lobby

```typescript
// Listen for game start (all clients, including the one who pressed Start)
this.networkManager.events.on('gameStart', (_senderId, _data) => {
    this.beginGameplay(); // start countdown, enable controls, etc.
});
```

WebSocket is already connected during the waiting room — state sync, chat, etc. all work. The waiting room is purely a UI gate.

---

## Multiplayer Spawn Points

Spawn points are typed entries in the unified `worldProfileData.spawnPoints` array
(`{ id, type: 'player', position, rotationY }`). **ALWAYS ensure 2+ `player` entries**
when implementing multiplayer — the asset side writes them via
`bin/world-edit spawnpoint upsert` (forged levels already ship with 4). The engine
starts the local player at the first entry; spread joins across all of them:

```typescript
const spawnPoints = NetworkManager.getMultiplayerSpawnPoints(gameData); // all type:'player' entries, sorted by id
if (spawnPoints.length > 0) {
    const spawn = spawnPoints[playerIndex % spawnPoints.length];
    this.player.position.set(spawn.position.x, spawn.position.y, spawn.position.z);
}
```

(Legacy games without `spawnPoints` fall back to markers named `"Multiplayer Spawn Point N"` — same call, no code change.)

---

## CRITICAL: Load Order

Lobby MUST be shown AFTER game is fully loaded. If shown before player exists, connecting fails silently.

**Correct order in `load()`:**
1. Generate world, load player, create controller, set up camera
2. Create `NetworkManager`
3. Set up `onUnknownObject` and `onStateChanged` callbacks
4. Call `showLobby()` — LAST thing in load()

---

## Owner Concept

- **Owner** (`isOwner: true`): Controls object, sends state at 10Hz (moving) / 1Hz (idle)
- **Non-owner** (`isOwner: false`): Receives + interpolates. Animation applied immediately (discrete).
- **Join flush**: On new player join, all owners immediately send current state
- **networkId format**: `{localPlayerId}:{objectType}` (e.g. `abc123:player`, `abc123:enemy-1`)
- Pass `playerName` in options — included in every state message for name labels

---

## Room Data

Free-form `Record<string, unknown>` per room. Starts empty, visible in room list before joining.

```typescript
// Set initial data on connect (first client creates room)
this.networkManager.connect(gameId, roomId, roomName, playerName, { gameMode: 'deathmatch' });

// Read from room list
const rooms = await NetworkManager.getRoomList(gameId);
const filtered = rooms.filter(r => r.data.gameMode === 'deathmatch');

// Read/update via HTTP
const data = await NetworkManager.getRoomData(gameId, roomId);
await NetworkManager.updateRoomData(gameId, roomId, { currentRound: 3 }); // shallow merge
await NetworkManager.updateRoomData(gameId, roomId, { timeLeft: null }); // null = delete key
```

**Cross-version visibility**: Published clients scope by version (`myGame-v1`). Editor fetches all versions via `allVersions=true`.

**HTTP API** (base: `GAME_SERVER_HTTP_URL`):

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/rooms/:gameId` | List rooms. `?allVersions=true` for all versions |
| `GET` | `/rooms/:gameId/:roomId/data` | Get room data |
| `PUT` | `/rooms/:gameId/:roomId/data` | Merge-update (64 KB cap, 413 if exceeded) |

Room data is ephemeral — cleared when room destroyed (last client leaves or 60s timeout).

---

## Custom Events

```typescript
this.networkManager.sendEvent('explosion', { x: 10, y: 0, z: 5, radius: 3 });
this.networkManager.events.on('explosion', (senderId, data) => { ... });
```

**Combat damage:**
```typescript
this.networkManager.sendEvent('playerHit', { targetId: hitPlayerId, damage: 25 });
this.networkManager.events.on('playerHit', (senderId, data) => {
    if (data.targetId === this.networkManager.getLocalPlayerId()) {
        this.takeDamage(data.damage as number, senderId);
    }
});
```

**Death/respawn:**
```typescript
this.networkManager.sendEvent('playerDeath', { position: { x, y, z } });
this.networkManager.sendEvent('playerRespawn', { position: { x, y, z } });
```

---

## Important Notes

- Game server is already deployed — no setup needed
- `NetworkManager.update(deltaTime)` must be called every frame
- Always call `disconnect()` in `dispose()`
- **Testing across agent turns (CLI lane):** every dev-server reload re-creates the game and every client rejoins as a new player. `touch .bitmagic/hold-reload` in the project before a multi-client session and the dev server drops all reloads until it is removed
- Show lobby AFTER player is loaded — never before
- Do NOT create `NetworkLobbyUI` directly — use `showLobby()`
- Lobby always shows name input first, then room browser
- **ALWAYS use `NetworkCharacterController` for remote players** — NEVER capsules/boxes/placeholders. `PlayerController`/`NpcController` are for LOCAL entities only.
- Remote character imports: `getDefaultCharacterUrl()`, `buildAnimationList()`, `this.engine.blockCharacterFactory`
- Pass `playerName` in NetworkObject options — included in every state message
- Animation receiver: `NetworkCharacterController` handles it — DO NOT implement your own
- Weapon receiver: `NetworkCharacterController` handles it — DO NOT create weapon meshes manually
- Use `pendingCharacters` Set to prevent duplicate `NetworkCharacterController.create()` calls
- DO NOT create `createNameLabel()` — `NetworkCharacterController` manages name labels internally
