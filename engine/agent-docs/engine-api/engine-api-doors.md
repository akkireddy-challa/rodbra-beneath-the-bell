# engine-api-doors

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/doors/DoorEngineBridge.ts
class DoorEngineBridge
static DoorEngineBridge.gameDataHasDoors(gameData: GameData): boolean
DoorEngineBridge.constructor(engine: EngineLike, gameData: GameData)
DoorEngineBridge.getSystem(): DoorSystem
DoorEngineBridge.update(deltaTime: number): void
DoorEngineBridge.dispose(): void

## engine/doors/DoorNetworkSync.ts
const DOORS_SHARED_STATE_NAME = 'doors'
const DOORS_SNAPSHOT_REQUEST_EVENT = `${DOORS_SHARED_STATE_NAME}.snapshotRequest`
interface DoorNetworkSyncOptions
DoorNetworkSyncOptions.networkManager: NetworkManager
DoorNetworkSyncOptions.gameDataService: GameDataService
class DoorNetworkSync
DoorNetworkSync.constructor(system: DoorSystem, options: DoorNetworkSyncOptions)
DoorNetworkSync.emit(delta: DoorDelta): void
DoorNetworkSync.requestSnapshot(): void
DoorNetworkSync.dispose(): void

## engine/doors/DoorSystem.ts
type DoorDelta = { doorId: string; state: DungeonDoorState } | { grantKey: string }
interface DoorSnapshot — Full door/key state, small enough to sit well inside GameDataService's 1 MB cap.
DoorSnapshot.doors: Record<string, DungeonDoorState>
DoorSnapshot.keys: string[]
interface DoorSystemDeps
DoorSystemDeps.getGameData: () => GameData | null
DoorSystemDeps.getCharacterPositions: () => ReadonlyArray<{ x: number; y: number; z: number }>
DoorSystemDeps.network: { emit: (delta: DoorDelta) => void; requestSnapshot: () => void } | null
DoorSystemDeps.notify: (message: string) => void
const DOOR_PROXIMITY_INTERVAL_SECONDS = 0.1
class DoorSystem
DoorSystem.constructor(engine: EngineLike, deps: DoorSystemDeps)
static DoorSystem.gameDataHasDoors(gameData: GameData): boolean
DoorSystem.initForLevel(activeLevelId: string | null): void
DoorSystem.unloadLevel(): void
DoorSystem.update(deltaTime: number): void
DoorSystem.dispose(): void
DoorSystem.openDoor(id: string): boolean
DoorSystem.closeDoor(id: string): boolean
DoorSystem.lockDoor(id: string): boolean
DoorSystem.unlockDoor(id: string): boolean
DoorSystem.getDoorState(id: string): DungeonDoorState | null
DoorSystem.getKeyring(): Keyring
DoorSystem.applyDelta(delta: DoorDelta): void
DoorSystem.serializeSnapshot(): DoorSnapshot
DoorSystem.applySnapshot(snapshot: DoorSnapshot): void

## engine/doors/DungeonDoor.ts
type DungeonDoorState = 'closed' | 'opening' | 'open' | 'closing'
interface DungeonDoorEvents
DungeonDoorEvents.onStateChanged: (state: DungeonDoorState) => void
const DEFAULT_DOOR_AUTO_OPEN_RADIUS = 2.5
const DOOR_ANIM_MS = 700
const DOOR_CLOSE_DELAY_MS = 1500
const DEFAULT_HINGE_OPEN_ANGLE_DEG = 100
type DoorNotify = (message: string) => void
const DEFAULT_DOOR_NOTIFY: DoorNotify
class DungeonDoor implements Interactable
DungeonDoor.id: string
DungeonDoor.constructor(engine: EngineLike, def: DoorDefinition, keyring: Keyring, events: DungeonDoorEvents, notify: DoorNotify = DEFAULT_DOOR_NOTIFY)
DungeonDoor.open(): void
DungeonDoor.close(): void
DungeonDoor.getState(): DungeonDoorState
DungeonDoor.setLocked(locked: boolean): void
DungeonDoor.isLocked(): boolean
DungeonDoor.applyRemoteState(state: DungeonDoorState): void
DungeonDoor.updateProximity(positions: ReadonlyArray<{ x: number; y: number; z: number }>): void
DungeonDoor.onInteractStart(): boolean
DungeonDoor.getInteractStartDisplayName(): string
DungeonDoor.interactionEnabled(): boolean
DungeonDoor.isActionable(): boolean
DungeonDoor.dispose(): void

## engine/doors/KeyPickup.ts
interface CollectibleSensor — Minimal surface KeyPickup needs from its proximity sensor — satisfied by
CollectibleSensor.dispose(): void
type CollectibleSensorFactory = ( physicsWorld: PhysicsWorld, config: CollectibleComponentConfig, ) => CollectibleSensor
const DEFAULT_COLLECTIBLE_SENSOR_FACTORY: CollectibleSensorFactory
class KeyPickup
KeyPickup.constructor(engine: EngineLike, def: KeyItemDefinition, keyring: Keyring, notify: (message: string) => void, sensorFactory: CollectibleSensorFactory = DEFAULT_COLLECTIBLE_SENSOR_FACTORY)
KeyPickup.dispose(): void

## engine/doors/Keyring.ts
class Keyring — Keyring — session-scoped collection of key ids the player has picked up.
Keyring.grant(keyId: string): void
Keyring.has(keyId: string): boolean
Keyring.keys(): ReadonlyArray<string>
Keyring.onChanged(cb: (keyId: string) => void): () => void
