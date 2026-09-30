# Multiplayer Setup (3D character games)

Wiring `MultiplayerSetup` into a game with a walking player character. Start at
`@docs networking-system.md` for the rules, lobby and load order that apply first.

---

## Quick Start: MultiplayerSetup Helper (Recommended)

`MultiplayerSetup` handles all boilerplate: NetworkManager creation, lobby, remote character lifecycle, local player registration, and cleanup. Use this for standard multiplayer.

Animations (idle/walk/run/jump/attack) sync automatically — `playerController.animationController` is read each frame and forwarded to remote clients via `NetworkCharacterController`.

### Basic (no weapons)

```typescript
import { MultiplayerSetup } from 'engine/networking/index.js';

// Property
private multiplayer: MultiplayerSetup | null = null;

// End of load() — after player, controller, camera are ready
this.multiplayer = new MultiplayerSetup({
    engine:           this.engine,
    player:           this.player!,
    playerController: this.playerController!,  // animations sync automatically
});
this.multiplayer.showLobby(gameId);

// update()
this.multiplayer?.update(deltaTime);

// dispose()
this.multiplayer?.dispose();
```

### With weapon sync

```typescript
this.multiplayer = new MultiplayerSetup({
    engine: this.engine,
    player: this.player!,
    playerController: this.playerController!,
    animationProvider: () => ({
        getAnimationState: () => animController.getCurrentState(),
        getAttackId: () => animController.getIsAttacking() ? 'attack' : null,
        getCustomAnimId: () => null,
        getEquippedWeaponId: () => {
            if (this.meleeSystem?.getWeaponType()) return 'melee:' + this.meleeSystem.getWeaponType();
            if (this.rangedSystem?.getWeaponType()) return 'ranged:' + this.rangedSystem.getWeaponType();
            return null;
        },
        getWeaponAimYaw: () => this.rangedSystem?.getWeaponMesh()?.rotation.y ?? 0,
        getWeaponAimPitch: () => -(this.rangedSystem?.getWeaponMesh()?.rotation.x ?? 0),
    }),
});
this.multiplayer.showLobby(gameId);
```

### With spawn point teleport

```typescript
this.multiplayer = new MultiplayerSetup({
    engine: this.engine,
    player: this.player!,
    playerController: this.playerController!,
    onConnected: (net, _playerName) => {
        const spawnPoints = NetworkManager.getMultiplayerSpawnPoints(this.gameData);
        if (spawnPoints.length > 0) {
            const spawn = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
            this.player!.position.set(spawn.position.x, spawn.position.y, spawn.position.z);
        }
    },
});
this.multiplayer.showLobby(gameId);
```

### Lobby options

```typescript
this.multiplayer = new MultiplayerSetup({
    engine: this.engine,
    player: this.player!,
    playerController: this.playerController!,
    lobbyOptions: { autoJoin: false, maxPlayers: 4 },  // Manual room browser
});
```

### Accessing NetworkManager for custom events

`MultiplayerSetup` exposes `networkManager` for full API access:

```typescript
// Send custom events
this.multiplayer.networkManager.sendEvent('explosion', { x: 10, z: 5, radius: 3 });
this.multiplayer.networkManager.sendShoot({ position, direction, speed: 40 });

// Listen for events
this.multiplayer.networkManager.events.on('explosion', (senderId, data) => { ... });
this.multiplayer.networkManager.events.onRemoteShoot = (senderId, data) => { ... };

// Read remote players
const remotePlayers = this.multiplayer.networkManager.getRemotePlayers();
```

### Lifecycle callbacks

For death spectating, target switching, and complete revival, use the opt-in
`MultiplayerSpectator` helper: `@docs multiplayer-spectator` and the compiled
`@docs samples/multiplayer-spectator` example.

```typescript
this.multiplayer = new MultiplayerSetup({
    // ...required options...
    onConnected: (net, playerName) => { /* teleport to spawn, show HUD */ },
    onRemotePlayerCreated: (senderId, char) => { /* track for hit detection */ },
    onRemotePlayerRemoved: (senderId, char) => { /* update scoreboard */ },
});
```

### Per-player appearance (team colours / chosen tints)

For "each player picks a colour/team before the match and everyone sees it" games,
use the opt-in `PlayerAppearanceSync` helper instead of hand-building a picker +
custom event + per-join recolouring. It owns the whole flow: store the local choice,
tint the local character, broadcast it, and apply each remote player's choice on join
(re-broadcasting so late joiners stay in sync). Recolouring uses the existing
`tintBodyPart()` primitive (`BlockCharacterRenderer` locally, `NetworkCharacterController`
for remotes).

```typescript
import { PlayerAppearanceSync, DEFAULT_TEAM_COLORS } from 'engine/networking/index.js';

// 1. (optional) Lightweight pre-game picker — or supply a value from your own UI:
const appearance = await PlayerAppearanceSync.pickAppearance(this.engine.container, {
    title: 'Choose your team colour',
    partName: 'torso',          // body part to recolour (see character-system.md)
    choices: DEFAULT_TEAM_COLORS,
});

// 2. Create the helper after connecting, and forward remote-player creation to it:
this.multiplayer = new MultiplayerSetup({
    engine: this.engine,
    player: this.player!,
    playerController: this.playerController!,
    onRemotePlayerCreated: (senderId, char) =>
        this.appearanceSync?.handleRemotePlayerCreated(senderId, char),
});
this.multiplayer.showLobby(gameId);
// ...once connected and the player's block character exists:
this.appearanceSync = new PlayerAppearanceSync({
    multiplayer: this.multiplayer,
    localCharacter: this.playerLoader.getBlockCharacterRenderer()!, // anything with tintBodyPart()
    appearance,
});

// 3. Clean up in dispose():
this.appearanceSync?.dispose();
```

Pass `appearance: null` and call `appearanceSync.setAppearance({ partName, color })` later
if the choice resolves after construction (e.g. mid-game team switch).

### NPC / Enemy syncing

Room host registers NPCs — non-host clients see them automatically via `onUnknownObject`.
Pass `animationController` and animations sync automatically (idle/walk/run/jump/attack).

```typescript
// In onConnected callback or after load, register NPCs only on host:
if (this.multiplayer.isRoomHost) {
    for (const npc of this.npcs) {
        this.multiplayer.registerNpc(npc.mesh, npc.id, {
            // Pass NPC controller or animation controller — animations sync automatically
            animationController: npc.controller,
            velocityGetter: () => {
                const v = npc.controller.getVelocity();
                return { x: v.x, y: v.y, z: v.z };
            },
        });
    }
}
// Non-host: NPCs auto-appear as NetworkCharacterController (full animated characters)
// Remote clients see the same idle/walk/run/jump/attack animations as the host.

// When an NPC is defeated — sendNpcDeath, NOT unregisterNpc:
this.multiplayer.sendNpcDeath(npc.id);
```

⚠️ `unregisterNpc()` only stops sending state; it does NOT tell remote clients to remove the
visual, so every other player is left staring at a frozen NPC. `sendNpcDeath()` unregisters AND
broadcasts `_npcDeath`, which disposes the remote controller. Same trap on animals with
`unregisterAnimal()` vs `sendAnimalDeath()`.

`animationController` accepts any object with `getAnimationController()` (like `NpcController`) or a direct animation controller (with `getCurrentState()`, `getIsAttacking()`). For custom animation logic, pass `animationProvider` instead.

Passing `npcConfig` and `displayName` so remote clients see identical visuals, plus client-side
hit detection, are in `@docs multiplayer-entity-sync.md` → "NPC Multiplayer Sync".

## What to add, in order

**`MultiplayerSetup` (character-based games) only.** For blanco games, see `@docs multiplayer-blanco.md`.

| # | Add when | How | Result |
|---|---|---|---|
| 1 | Game has a controllable player character | Provide `player` and `playerController` — see "Basic" above | Position/rotation/animation synced at 10Hz; remote players appear as full animated block characters with name labels |
| 2 | Game has AI characters all players should see identically | Host only (`isRoomHost`) calls `registerNpc(...)` — see "NPC / Enemy syncing" above | Non-hosts display auto-created `NetworkCharacterController`s. Non-hosts must NOT run AI for synced enemies |
| 3 | Game has ranged weapons or projectiles | `@docs multiplayer-combat-sync.md` → "Shooting & hit sync" | Shot broadcast once, simulated locally; only the shooter runs hit detection |
| 4 | Players can equip/switch visible weapons | Add the three weapon getters to `animationProvider` — see "With weapon sync" above; receiver side in `@docs multiplayer-combat-sync.md` | Remote characters auto-equip the matching mesh, aim direction synced for ranged |

---
