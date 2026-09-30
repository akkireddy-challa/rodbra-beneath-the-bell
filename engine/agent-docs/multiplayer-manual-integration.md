# Multiplayer: Manual Integration

Raw `NetworkManager` / `NetworkObject` wiring, for full control over remote character creation,
custom matchmaking or non-standard object sync. For standard multiplayer use
`@docs multiplayer-setup.md` instead.

---

Use this approach when you need full control over remote character creation, custom matchmaking, or non-standard object sync. For standard multiplayer, use `MultiplayerSetup` — see `@docs multiplayer-setup.md`.

### 1. Properties

```typescript
import { NetworkManager, NetworkObject, NetworkCharacterController } from 'engine/networking/index.js';
import type { StateMessage } from 'engine/networking/index.js';
import { getDefaultCharacterUrl } from 'engine/CharacterConfig.js';
import { buildAnimationList } from 'engine/AnimationPacks.js';

private networkManager!: NetworkManager;
private remoteCharacters: Map<string, NetworkCharacterController> = new Map();
private pendingCharacters: Set<string> = new Set();
private localPlayerNetObj: NetworkObject | null = null;
private localPlayerName: string = 'Player';
```

### 2. Set up networking at END of load()

```typescript
async load(gameId: string): Promise<void> {
    // 1. Normal game setup first
    await this.worldGenerator.generateWorld();
    this.player = await this.playerLoader.loadPlayer();
    this.setupCamera();
    await this.setupPlayerController();

    // 2. Networking setup (player MUST exist)
    this.networkManager = new NetworkManager();

    this.networkManager.onUnknownObject = async (senderId: string, networkId: string, state: StateMessage) => {
        if (senderId === this.networkManager.getLocalPlayerId()) return;
        if (this.remoteCharacters.has(networkId)) return;
        if (this.pendingCharacters.has(networkId)) return;

        this.pendingCharacters.add(networkId);
        try {
            const remoteChar = await NetworkCharacterController.create({
                engine: this.engine,
                networkId,
                initialState: state,
                playerName: state.playerName ?? 'Player',
                characterUrl: getDefaultCharacterUrl(),
                blockCharacterFactory: this.engine.blockCharacterFactory!,
                baseAnimations: buildAnimationList(),
            });
            this.networkManager.registerObject(remoteChar.getNetworkObject());
            this.remoteCharacters.set(networkId, remoteChar);
        } finally {
            this.pendingCharacters.delete(networkId);
        }
    };

    this.networkManager.events.onPlayerLeft = (playerId: string) => {
        for (const [id, char] of this.remoteCharacters) {
            if (id.startsWith(playerId + ':')) {
                this.networkManager.unregisterObject(id);
                char.dispose();
                this.remoteCharacters.delete(id);
            }
        }
    };

    this.networkManager.onStateChanged = (state) => {
        if (state === 'connected') this.onMultiplayerConnected();
    };

    // 3. Show lobby LAST
    this.networkManager.showLobby(gameId, this.engine.container, (playerName) => {
        this.localPlayerName = playerName;
    });
}
```

### 3. Handle connection — register local player

```typescript
private onMultiplayerConnected(): void {
    const animController = this.playerLoader.getAnimationController();
    this.localPlayerNetObj = new NetworkObject(
        this.player,
        this.networkManager.getLocalPlayerId() + ':player',
        true,
        {
            speedGetter: () => this.playerController.velocity.length(),
            velocityGetter: () => ({
                x: this.playerController.velocity.x,
                y: this.playerController.velocity.y,
                z: this.playerController.velocity.z,
            }),
            playerName: this.localPlayerName,
            animationProvider: animController ? {
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
            } : undefined,
        }
    );
    this.networkManager.registerObject(this.localPlayerNetObj);
}
```

### 4. Remote Characters — MUST use NetworkCharacterController

**NEVER** use capsules/boxes/placeholders. Remote players MUST look identical to local player.

`NetworkCharacterController` handles internally: GLB skeleton, block character, animations, weapon equip/aim, name label, interpolation, cleanup. **DO NOT** reimplement any of this.

| Parameter | Source |
|-----------|--------|
| `characterUrl` | `getDefaultCharacterUrl()` from `engine/CharacterConfig.js` |
| `blockCharacterFactory` | `this.engine.blockCharacterFactory` |
| `baseAnimations` | `buildAnimationList()` from `engine/AnimationPacks.js` |

**Death/respawn:**

For snapshot-backed life state (including late joins), spectator cameras and revival,
prefer `MultiplayerSetup` with `MultiplayerSpectator`: `@docs multiplayer-spectator`.
The custom-event example below only changes existing visuals.

```typescript
this.networkManager.events.on('playerDeath', (senderId, _data) => {
    this.remoteCharacters.get(`${senderId}:player`)?.setVisible(false);
});
this.networkManager.events.on('playerRespawn', (senderId, _data) => {
    this.remoteCharacters.get(`${senderId}:player`)?.setVisible(true);
});
```

### 5. Update every frame

```typescript
update(deltaTime: number): void {
    this.networkManager.update(deltaTime);
    for (const [, char] of this.remoteCharacters) char.update(deltaTime);
}
```

### 6. Cleanup

```typescript
dispose(): void {
    for (const [, char] of this.remoteCharacters) char.dispose();
    this.remoteCharacters.clear();
    this.networkManager.disconnect();
}
```

### 7. Animation and weapon state

Both ride on `StateMessage` and work identically here and under `MultiplayerSetup`. The provider
methods, the fields they map to, and the receiver rules are in
`@docs multiplayer-entity-sync.md` → "Animation Sync" and
`@docs multiplayer-combat-sync.md` → "Weapon Sync".

The one thing specific to manual integration: `AnimationStateReceiver.applyAnimationState()` is
created internally by `NetworkCharacterController`, so implement it yourself only for custom
non-character objects.

### 8. Custom Object Sync

For objects that aren't characters or vehicles (platforms, doors, collectibles):

```typescript
// Host registers
const netObj = new NetworkObject(door.mesh, localId + ':door-' + door.id, true, {
    velocityGetter: () => ({ x: 0, y: 0, z: 0 }),
});
net.registerObject(netObj);

// Non-host creates non-owner mirror in onUnknownObject
const mirror = new NetworkObject(localDoor.mesh, networkId, false, {
    velocityGetter: () => ({ x: 0, y: 0, z: 0 }),
});
net.registerObject(mirror);
```

**Ownership model:** One client owns (sends state), all others interpolate. Room host typically owns world objects. Ownership can transfer (e.g. vehicle driver changes).

---
