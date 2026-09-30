# engine-api-networking

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/networking/BlancoMultiplayerSetup.ts
interface BlancoMultiplayerSetupOptions
BlancoMultiplayerSetupOptions.engine: EngineLike
BlancoMultiplayerSetupOptions.lobbyOptions?: LobbyOptions
BlancoMultiplayerSetupOptions.onConnected?: (networkManager: NetworkManager, localPlayerName: string) => void
BlancoMultiplayerSetupOptions.onPlayerJoined?: (playerId: string, playerName: string) => void
BlancoMultiplayerSetupOptions.onPlayerLeft?: (playerId: string) => void
class BlancoMultiplayerSetup
BlancoMultiplayerSetup.networkManager: NetworkManager
BlancoMultiplayerSetup.get localPlayerName(): string
BlancoMultiplayerSetup.get localPlayerId(): string
BlancoMultiplayerSetup.get isRoomHost(): boolean
BlancoMultiplayerSetup.get connectedPlayers(): ReadonlyMap<string, string>
BlancoMultiplayerSetup.constructor(options: BlancoMultiplayerSetupOptions)
BlancoMultiplayerSetup.showLobby(gameId: string): void
BlancoMultiplayerSetup.update(deltaTime: number): void
BlancoMultiplayerSetup.sendGameState(state: Record<string, unknown>): void
BlancoMultiplayerSetup.onGameState(handler: (senderId: string, state: Record<string, unknown>) => void): void
BlancoMultiplayerSetup.sendMove(move: Record<string, unknown>): void
BlancoMultiplayerSetup.onMove(handler: (senderId: string, move: Record<string, unknown>) => void): void
BlancoMultiplayerSetup.sendTurnChange(data: { currentPlayerId: string; turnNumber: number; [key: string]: unknown }): void
BlancoMultiplayerSetup.onTurnChange(handler: (senderId: string, data: { currentPlayerId: string; turnNumber: number; [key: string]: unknown }) => void): void
BlancoMultiplayerSetup.dispose(): void

## engine/networking/MultiplayerSetup.ts
type ExplosionEvent = { position: { x: number; y: number; z: number }; radius: number } & Partial<Omit<ExplosionConfig, 'enabled' | 'radius'>>
interface MultiplayerSetupOptions
MultiplayerSetupOptions.engine: EngineLike
MultiplayerSetupOptions.player?: THREE.Object3D
MultiplayerSetupOptions.playerController?: { velocity: THREE.Vector3; animationController?: unknown; getAnimationController?: () => unknown; }
MultiplayerSetupOptions.playerLoader?: { getAnimationController(): unknown }
MultiplayerSetupOptions.lobbyOptions?: LobbyOptions
MultiplayerSetupOptions.animationProvider?: (localPlayerName: string) => AnimationStateProvider
MultiplayerSetupOptions.onConnected?: (networkManager: NetworkManager, localPlayerName: string) => void
MultiplayerSetupOptions.onRemotePlayerCreated?: (senderId: string, character: NetworkCharacterController) => void
MultiplayerSetupOptions.onRemotePlayerRemoved?: (senderId: string, character: NetworkCharacterController) => void
MultiplayerSetupOptions.combatAnimations?: BaseAnimationDefinition[]
MultiplayerSetupOptions.gameAssets?: unknown[]
class MultiplayerSetup
MultiplayerSetup.networkManager: NetworkManager
MultiplayerSetup.get remoteCharacters(): ReadonlyMap<string, NetworkCharacterController>
MultiplayerSetup.get localPlayerName(): string
MultiplayerSetup.get isRoomHost(): boolean
MultiplayerSetup.constructor(options: MultiplayerSetupOptions)
MultiplayerSetup.showLobby(gameId: string): void
MultiplayerSetup.update(deltaTime: number): void
MultiplayerSetup.registerNpc(object3D: THREE.Object3D, npcId: string, options?: { /** Velocity getter for dead-reckoning. Defaults to zero velocity. */ velocityGetter?: () => { x: number; y: number; z: number }; /** * Animation controller from NpcController or CharacterAnimationController. * When provided, animation state is read automatically — you don't need * to build an AnimationStateProvider manually. */ animationController?: { getAnimationController?: () => unknown } | { getCurrentState?: () => string }; /** Explicit animation provider (takes precedence over animationController). */ animationProvider?: AnimationStateProvider; /** * NpcCustomizationConfig used to create this NPC's visual. * When provided, remote clients receive it and build identical NPC visuals * (same colors, clothing, body shape). Without this, remotes use the * default player block character factory. */ npcConfig?: NpcCustomizationConfig; /** Display name for the floating label on remote clients. Defaults to 'NPC'. */ displayName?: string; }): NetworkObject | null
MultiplayerSetup.unregisterNpc(npcId: string): void
MultiplayerSetup.registerAnimal(object3D: THREE.Object3D, animalId: string, animalType: string, options?: { /** Velocity getter for dead-reckoning. Defaults to zero velocity. */ velocityGetter?: () => { x: number; y: number; z: number }; /** * Animation controller from AnimalController's BlockAnimalAnimationController. * When provided, animation state is read automatically. */ animationController?: { getCurrentState?: () => string }; /** Explicit animation provider (takes precedence over animationController). */ animationProvider?: AnimationStateProvider; /** * BlockAnimalBodyConfig used to create this animal. * When provided, remote clients receive it and build identical block geometry * (same colors, shapes, proportions). Without this, remotes use a generic * brown animal mesh which won't match the host's visual. */ bodyConfig?: BlockAnimalBodyConfig; /** Display name for the floating label on remote clients. Defaults to animalType. */ displayName?: string; }): NetworkObject | null
MultiplayerSetup.unregisterAnimal(animalId: string): void
MultiplayerSetup.sendAnimalDeath(animalId: string): void
MultiplayerSetup.get remoteAnimals(): ReadonlyMap<string, NetworkAnimalController>
MultiplayerSetup.sendNpcDeath(npcId: string): void
MultiplayerSetup.get remoteNpcs(): ReadonlyMap<string, NetworkCharacterController>
MultiplayerSetup.sendNpcHit(networkId: string, damage: number, hitPosition?: { x: number; y: number; z: number }, hitDirection?: { x: number; y: number; z: number }): void
MultiplayerSetup.onNpcHit(handler: ( senderId: string, networkId: string, damage: number, hitPosition: { x: number; y: number; z: number }, hitDirection: { x: number; y: number; z: number }, ) => void): void
MultiplayerSetup.sendShoot(shootData: ShootData): void
MultiplayerSetup.sendHit(targetId: string, damage: number, extras?: Record<string, unknown>): void
MultiplayerSetup.onHit(handler: (senderId: string, targetId: string, damage: number, extras: Record<string, unknown>) => void): void
MultiplayerSetup.onRemoteShoot(handler: (senderId: string, shootData: ShootData) => void): void
MultiplayerSetup.sendAnimalHit(networkId: string, damage: number, hitPosition?: { x: number; y: number; z: number }, hitDirection?: { x: number; y: number; z: number }): void
MultiplayerSetup.onAnimalHit(handler: ( senderId: string, networkId: string, damage: number, hitPosition: { x: number; y: number; z: number }, hitDirection: { x: number; y: number; z: number }, ) => void): void
MultiplayerSetup.sendExplosion(data: ExplosionEvent): void
MultiplayerSetup.onExplosion(handler: ( senderId: string, data: ExplosionEvent, ) => void): void
MultiplayerSetup.sendEnvironmentDestruction(data: { position: { x: number; y: number; z: number }; radius: number; impulse?: number; upImpulse?: number; }): void
MultiplayerSetup.onEnvironmentDestruction(handler: ( senderId: string, data: { position: { x: number; y: number; z: number }; radius: number; impulse?: number; upImpulse?: number; }, ) => void): void
MultiplayerSetup.dispose(): void
static MultiplayerSetup.buildAnimationProviderFromController(controllerOrHost: { animationController?: unknown } | { getAnimationController?: () => unknown } | { getCurrentState?: () => string }): AnimationStateProvider

## engine/networking/MultiplayerSpectator.ts
interface MultiplayerSpectatorOptions
MultiplayerSpectatorOptions.deathDelaySeconds: number
MultiplayerSpectatorOptions.distanceInHeights: number
MultiplayerSpectatorOptions.canSpectate: (playerId: string) => boolean
MultiplayerSpectatorOptions.getRespawnSeconds: () => number | null
MultiplayerSpectatorOptions.isMatchOver: () => boolean
MultiplayerSpectatorOptions.gameplayHud: readonly HTMLElement[]
MultiplayerSpectatorOptions.onActiveChanged: (active: boolean) => void
const DEFAULT_MULTIPLAYER_SPECTATOR_OPTIONS: MultiplayerSpectatorOptions
interface MultiplayerSpectatorDependencies
MultiplayerSpectatorDependencies.engine: EngineLike
MultiplayerSpectatorDependencies.multiplayer: MultiplayerSetup
MultiplayerSpectatorDependencies.playerController: PlayerController
MultiplayerSpectatorDependencies.getGameplayCamera: () => SpectatorGameplayCamera
class MultiplayerSpectator — Opt-in death spectating. Call update AFTER multiplayer.update and normal camera
MultiplayerSpectator.constructor(private readonly deps: MultiplayerSpectatorDependencies, private readonly options: MultiplayerSpectatorOptions)
MultiplayerSpectator.get isActive(): boolean
MultiplayerSpectator.get targetPlayerId(): string | null
MultiplayerSpectator.enter(): void
MultiplayerSpectator.update(deltaTime: number): void
MultiplayerSpectator.respawn(position?: THREE.Vector3): void
MultiplayerSpectator.cycleTarget(direction: number): void
MultiplayerSpectator.dispose(): void

## engine/networking/NetworkAnimalController.ts
interface NetworkAnimalCreateParams — Parameters for NetworkAnimalController.create()
NetworkAnimalCreateParams.engine: EngineLike
NetworkAnimalCreateParams.networkId: string
NetworkAnimalCreateParams.initialState: StateMessage
NetworkAnimalCreateParams.animalType: string
NetworkAnimalCreateParams.displayName?: string
NetworkAnimalCreateParams.blockCharacterFactory?: IBlockCharacterFactory
NetworkAnimalCreateParams.animalConfig?: unknown
class NetworkAnimalController — Controller for remote (non-owner) networked animals.
static NetworkAnimalController.create(params: NetworkAnimalCreateParams): NetworkAnimalController
NetworkAnimalController.update(deltaTime: number): void
NetworkAnimalController.dispose(): void
NetworkAnimalController.getObject3D(): THREE.Object3D
NetworkAnimalController.getNetworkId(): string
NetworkAnimalController.getNetworkObject(): NetworkObject

## engine/networking/NetworkAnimationSync.ts
class NetworkAnimationSync — Coordinator that manages animation state sync for a single NetworkObject.
NetworkAnimationSync.constructor(provider: AnimationStateProvider | null, receiver: AnimationStateReceiver | null, weaponReceiver: WeaponStateReceiver | null = null)
NetworkAnimationSync.populateState(msg: StateMessage): boolean
NetworkAnimationSync.applyState(msg: StateMessage): void
NetworkAnimationSync.hasProvider(): boolean
NetworkAnimationSync.hasReceiver(): boolean

## engine/networking/NetworkBinaryCodec.ts
function msgpackEncoder(msgs: NetworkMessage[]): Uint8Array
function msgpackDecoder(data: Uint8Array): NetworkMessage[]

## engine/networking/NetworkCharacterController.ts
interface NetworkCharacterCreateParams — Parameters for NetworkCharacterController.create()
NetworkCharacterCreateParams.engine: EngineLike
NetworkCharacterCreateParams.networkId: string
NetworkCharacterCreateParams.initialState: StateMessage
NetworkCharacterCreateParams.playerName: string
NetworkCharacterCreateParams.characterUrl: string
NetworkCharacterCreateParams.blockCharacterFactory: IBlockCharacterFactory
NetworkCharacterCreateParams.baseAnimations: BaseAnimationDefinition[]
NetworkCharacterCreateParams.combatAnimations?: BaseAnimationDefinition[]
NetworkCharacterCreateParams.gameAssets?: unknown[]
NetworkCharacterCreateParams.targetHeight?: number
NetworkCharacterCreateParams.isNpc?: boolean
class NetworkCharacterController extends CharacterLoader — Controller for remote (non-owner) networked characters.
static NetworkCharacterController.create(params: NetworkCharacterCreateParams): Promise<NetworkCharacterController>
NetworkCharacterController.update(deltaTime: number): void
NetworkCharacterController.dispose(): void
NetworkCharacterController.getObject3D(): THREE.Object3D
NetworkCharacterController.getNetworkObject(): NetworkObject
NetworkCharacterController.getAnimationController(): CharacterAnimationController | null
NetworkCharacterController.getName(): string
NetworkCharacterController.setVisible(visible: boolean): void
NetworkCharacterController.getBodyPart(name: string): THREE.Object3D | null
NetworkCharacterController.tintBodyPart(name: string, color: number): boolean

## engine/networking/NetworkEvents.ts
class NetworkEvents
NetworkEvents.onPlayerLifeStateChanged(handler: (playerId: string, life: Readonly<PlayerLifeSnapshot>) => void): () => void
NetworkEvents._emitPlayerLifeState(playerId: string, life: Readonly<PlayerLifeSnapshot>): void
NetworkEvents.onPlayerJoined: ((playerId: string, playerName: string) => void) | null
NetworkEvents.onPlayerLeft: ((playerId: string) => void) | null
NetworkEvents.onRemoteShoot: ((senderId: string, shootData: ShootData) => void) | null
NetworkEvents.on(eventName: string, handler: CustomEventHandler): void
NetworkEvents.off(eventName: string, handler: CustomEventHandler): void
NetworkEvents._emitPlayerJoined(playerId: string, playerName: string): void
NetworkEvents._emitPlayerLeft(playerId: string): void
NetworkEvents._emitRemoteShoot(senderId: string, shootData: ShootData): void
NetworkEvents._emitCustomEvent(eventName: string, senderId: string, data: Record<string, unknown>): void
NetworkEvents.dispose(): void

## engine/networking/NetworkInterpolation.ts
class NetworkInterpolation
NetworkInterpolation.lerpFactor: number
NetworkInterpolation.maxExtrapolationTime: number
NetworkInterpolation.targetSmoothing: number
NetworkInterpolation.positionDeadZoneSq: number
NetworkInterpolation.constructor(initialPosition: THREE.Vector3, initialQuaternion: THREE.Quaternion)
NetworkInterpolation.setTarget(position: THREE.Vector3, quaternion: THREE.Quaternion, speed: number, animState?: string, attackId?: string, customAnimId?: string, velocity?: THREE.Vector3, steeringAngle?: number): void
NetworkInterpolation.update(deltaTime: number, object3D: THREE.Object3D): void
NetworkInterpolation.getCurrentSpeed(): number
NetworkInterpolation.getAnimState(): string | undefined
NetworkInterpolation.getAttackId(): string | undefined
NetworkInterpolation.getCustomAnimId(): string | undefined
NetworkInterpolation.getSteeringAngle(): number

## engine/networking/NetworkLobbyUI.ts
interface LobbyJoinEvent
LobbyJoinEvent.roomId: string
LobbyJoinEvent.roomName: string
LobbyJoinEvent.gameId?: string
LobbyJoinEvent.data?: Record<string, unknown>
LobbyJoinEvent.isCreator?: boolean
interface LobbyOptions — Options controlling lobby behaviour.
LobbyOptions.maxPlayers?: number
LobbyOptions.autoJoin?: boolean
LobbyOptions.waitForPlayers?: boolean
LobbyOptions.minPlayersToStart?: number
LobbyOptions.autoEnterGame?: boolean
class NetworkLobbyUI
NetworkLobbyUI.constructor(container: HTMLElement)
NetworkLobbyUI.show(gameId: string, fetchRoomList: (gameId: string) => Promise<RoomInfo[]>, onJoin: (event: LobbyJoinEvent) => void, onNameConfirmed?: (playerName: string) => void, options?: LobbyOptions): void
NetworkLobbyUI.hide(): void
NetworkLobbyUI.dispose(): void
NetworkLobbyUI.getPlayerName(): string
NetworkLobbyUI.isWaitingForPlayers(): boolean
NetworkLobbyUI.showWaitingRoom(onGameStart: () => void): void
NetworkLobbyUI.showEnterGameView(onEnterGameRequested: () => void): void
NetworkLobbyUI.updateWaitingRoom(players: Array<{ playerId: string; playerName: string }>): void
NetworkLobbyUI.setVisible(visible: boolean): void

## engine/networking/NetworkManager.ts
class NetworkManager
NetworkManager.localPlayerId: string
NetworkManager.events: NetworkEvents
NetworkManager.onStateChanged: ((state: NetworkState) => void) | null
NetworkManager.onUnknownObject: ((senderId: string, networkId: string, state: StateMessage) => void) | null
NetworkManager.onRoomJoined: ((event: { isCreator: boolean }) => void) | null
NetworkManager.onReconnectFailed: (() => void) | null
NetworkManager.constructor()
NetworkManager.get state(): NetworkState
NetworkManager.getLocalPlayerId(): string
NetworkManager.getGameId(): string
NetworkManager.getRoomId(): string
NetworkManager.showLobby(gameId: string, container: HTMLElement, onNameConfirmed?: (playerName: string) => void, options?: LobbyOptions, onLocalGameplayStartRequested?: () => void): void
NetworkManager.enableBinaryProtocol(encoder: (msgs: NetworkMessage[]) => Uint8Array, decoder: (data: Uint8Array) => NetworkMessage[]): void
NetworkManager.setBatchSendRate(hz: number): void
NetworkManager.connect(gameId: string, roomId: string, roomName: string, playerName?: string, data?: Record<string, unknown>): void
NetworkManager.disconnect(): void
NetworkManager.registerObject(obj: NetworkObject): void
NetworkManager.setLocalPlayerLifeState(state: PlayerLifeState): void
NetworkManager.getLocalPlayerLifeState(): Readonly<PlayerLifeSnapshot> | null
NetworkManager.getRemotePlayerLifeState(playerId: string): Readonly<PlayerLifeSnapshot> | null
NetworkManager.syncObjectNow(networkId: string): void
NetworkManager.unregisterObject(networkId: string): void
NetworkManager.sendEvent(eventName: string, data: Record<string, unknown>): void
NetworkManager.sendShoot(shootData: ShootData): void
NetworkManager.getPlayerName(): string
NetworkManager.update(deltaTime: number): void
static NetworkManager.getRoomList(gameId: string, allVersions = false): Promise<RoomInfo[]>
static NetworkManager.getRoomData(gameId: string, roomId: string): Promise<Record<string, unknown>>
static NetworkManager.getMultiplayerSpawnPoints(gameData: { worldProfileData?: { spawnPoints?: Array<{ id: string; type: string; position: { x: number; y: number; z: number }; rotationY: number }>; markers?: Array<{ name: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }> } }): Array<{ position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }>
static NetworkManager.updateRoomData(gameId: string, roomId: string, data: Record<string, unknown>): Promise<Record<string, unknown>>
NetworkManager.setLobbyVisible(visible: boolean): void
NetworkManager.isConnected(): boolean
NetworkManager.getRemotePlayers(): Map<string, RemotePlayerInfo>

## engine/networking/NetworkObject.ts
class NetworkObject
NetworkObject.networkId: string
NetworkObject.isOwner: boolean
NetworkObject.constructor(object3D: THREE.Object3D, networkId: string, isOwner: boolean, options: NetworkObjectOptions)
NetworkObject.collectState(deltaTime: number, senderId: string): StateMessage | null
NetworkObject.forceCollectState(senderId: string): StateMessage
NetworkObject.applyState(msg: StateMessage): void
NetworkObject.updateInterpolation(deltaTime: number): void
NetworkObject.getCurrentSpeed(): number
NetworkObject.getSteeringAngle(): number
NetworkObject.getObject3D(): THREE.Object3D
NetworkObject.destroy(): void
NetworkObject.isDestroyed(): boolean

## engine/networking/NetworkRoomOwnership.ts
class NetworkRoomOwnership
NetworkRoomOwnership.onAllLoaded: (() => void) | null
NetworkRoomOwnership.onTimeout: ((pendingPlayers: string[]) => void) | null
NetworkRoomOwnership.onOwnerChanged: ((ownerId: string) => void) | null
NetworkRoomOwnership.constructor(networkManager: NetworkManager, options?: { timeout?: number })
NetworkRoomOwnership.claimOwnership(): void
NetworkRoomOwnership.isOwner(): boolean
NetworkRoomOwnership.getOwnerId(): string | null
NetworkRoomOwnership.reportLoaded(): void
NetworkRoomOwnership.isAllLoaded(): boolean
NetworkRoomOwnership.getPendingPlayers(): string[]
NetworkRoomOwnership.handlePlayerJoined(playerId: string): void
NetworkRoomOwnership.handlePlayerLeft(playerId: string): void
NetworkRoomOwnership.update(deltaTime: number): void
NetworkRoomOwnership.reset(): void
NetworkRoomOwnership.dispose(): void

## engine/networking/NetworkTypes.ts
type NetworkState = 'disconnected' | 'lobby' | 'connecting' | 'connected'
type PlayerLifeState = 'alive' | 'dead'
interface PlayerLifeSnapshot
PlayerLifeSnapshot.state: PlayerLifeState
PlayerLifeSnapshot.revision: number
interface NetworkMessage
NetworkMessage.type: 'state' | 'join' | 'leave' | 'ping' | 'event' | 'ack' | 'batch'
NetworkMessage.senderId: string
NetworkMessage.timestamp: number
NetworkMessage._msgId?: number
interface BatchMessage — Batch message: packs multiple outbound messages into a single WebSocket frame.
BatchMessage.type: 'batch'
BatchMessage.msgs: NetworkMessage[]
interface AckMessage — ACK message sent by clients to confirm receipt of messages. Not relayed to other clients.
AckMessage.type: 'ack'
AckMessage.msgIds: number[]
interface StateMessage
StateMessage.type: 'state'
StateMessage.playerLifeState?: PlayerLifeSnapshot
StateMessage.networkId: string
StateMessage.position: { x: number; y: number; z: number }
StateMessage.speed: number
StateMessage.velocity: { x: number; y: number; z: number }
StateMessage.playerName?: string
StateMessage.animState?: string
StateMessage.attackId?: string
StateMessage.customAnimId?: string
StateMessage.equippedWeaponId?: string
StateMessage.weaponAimYaw?: number
StateMessage.weaponAimPitch?: number
StateMessage.quaternion: { x: number; y: number; z: number; w: number }
StateMessage.steeringAngle?: number
StateMessage.objectType?: 'character' | 'vehicle' | 'animal' | 'npc'
StateMessage.animalType?: string
StateMessage.animalConfig?: unknown
StateMessage.characterConfig?: unknown
interface JoinMessage
JoinMessage.type: 'join'
JoinMessage.playerName: string
interface LeaveMessage
LeaveMessage.type: 'leave'
interface PingMessage
PingMessage.type: 'ping'
PingMessage.networkIds: string[]
interface EventMessage
EventMessage.type: 'event'
EventMessage.eventName: string
EventMessage.data: Record<string, unknown>
interface ShootData — Data sent when a projectile is fired. Used by NetworkManager.sendShoot().
ShootData.position: { x: number; y: number; z: number }
ShootData.direction: { x: number; y: number; z: number }
ShootData.speed: number
ShootData.color?: number
ShootData.radius?: number
ShootData.gravityScale?: number
interface RoomPlayerInfo
RoomPlayerInfo.playerId: string
RoomPlayerInfo.playerName: string
interface RoomInfo
RoomInfo.roomId: string
RoomInfo.gameId: string
RoomInfo.name: string
RoomInfo.clients: number
RoomInfo.players: RoomPlayerInfo[]
RoomInfo.data: Record<string, unknown>
interface RemotePlayerInfo
RemotePlayerInfo.playerId: string
RemotePlayerInfo.playerName: string
RemotePlayerInfo.lastPingTime: number
interface AnimationStateProvider — Owner-side: provides current animation state to include in network messages.
AnimationStateProvider.getAnimationState(): string
AnimationStateProvider.getAttackId(): string | null
AnimationStateProvider.getCustomAnimId(): string | null
AnimationStateProvider.getEquippedWeaponId?(): string | null
AnimationStateProvider.getWeaponAimYaw?(): number
AnimationStateProvider.getWeaponAimPitch?(): number
interface AnimationStateReceiver — Receiver-side: applies animation state received from a network message.
AnimationStateReceiver.applyAnimationState(animState: string, speed: number, attackId?: string, customAnimId?: string): void
interface WeaponStateReceiver — Receiver-side: applies weapon state received from a network message.
WeaponStateReceiver.applyWeaponState(weaponId: string | null, aimYaw: number, aimPitch: number): void
interface VehicleDescriptor — Describes a vehicle's visual appearance for remote clients to build a ghost vehicle.
VehicleDescriptor.assetId?: string
VehicleDescriptor.chassisSize: { width: number; height: number; length: number }
VehicleDescriptor.chassisColor: number
VehicleDescriptor.wheels: Array<{ position: { x: number; y: number; z: number }; radius: number; width: number; suspensionRestLength: number; color?: number; isSteering: boolean; }>
VehicleDescriptor.bodyParts: Array<{ position: { x: number; y: number; z: number }; size: { width: number; height: number; length: number }; color: number; isWindow?: boolean; }>
interface NetworkObjectOptions
NetworkObjectOptions.playerLifeState?: () => Readonly<PlayerLifeSnapshot> | null
NetworkObjectOptions.speedGetter?: () => number
NetworkObjectOptions.velocityGetter: () => { x: number; y: number; z: number }
NetworkObjectOptions.positionThreshold?: number
NetworkObjectOptions.rotationThreshold?: number
NetworkObjectOptions.playerName?: string
NetworkObjectOptions.steeringAngleGetter?: () => number
NetworkObjectOptions.objectType?: 'character' | 'vehicle' | 'animal' | 'npc'
NetworkObjectOptions.animalType?: string
NetworkObjectOptions.animalConfig?: unknown
NetworkObjectOptions.animalDisplayName?: string
NetworkObjectOptions.characterConfig?: unknown
NetworkObjectOptions.npcDisplayName?: string
NetworkObjectOptions.animationProvider?: AnimationStateProvider
NetworkObjectOptions.animationReceiver?: AnimationStateReceiver
NetworkObjectOptions.weaponReceiver?: WeaponStateReceiver
function isStateMessage(msg: NetworkMessage): msg is StateMessage
function isJoinMessage(msg: NetworkMessage): msg is JoinMessage
function isLeaveMessage(msg: NetworkMessage): msg is LeaveMessage
function isPingMessage(msg: NetworkMessage): msg is PingMessage
function isEventMessage(msg: NetworkMessage): msg is EventMessage
function isBatchMessage(msg: NetworkMessage): msg is BatchMessage
const ACTIVE_SYNC_INTERVAL = 0.016
const IDLE_SYNC_INTERVAL = 1.0
const PING_INTERVAL = 5.0
const STALE_TIMEOUT = 10.0
const BATCH_SEND_INTERVAL = 0.04
const BINARY_MSG_ID_BYTES = 4

## engine/networking/NetworkUtils.ts
function createNameLabelSprite(name: string): THREE.Sprite

## engine/networking/NetworkVehicleController.ts
interface NetworkVehicleCreateParams — Parameters for NetworkVehicleController.create()
NetworkVehicleCreateParams.engine: EngineLike
NetworkVehicleCreateParams.networkId: string
NetworkVehicleCreateParams.initialState: StateMessage
NetworkVehicleCreateParams.vehicleDescriptor: VehicleDescriptor
NetworkVehicleCreateParams.playerName: string
class NetworkVehicleController — Controller for remote (non-owner) networked vehicles.
static NetworkVehicleController.create(params: NetworkVehicleCreateParams): NetworkVehicleController
NetworkVehicleController.update(deltaTime: number): void
NetworkVehicleController.dispose(): void
NetworkVehicleController.getObject3D(): THREE.Object3D
NetworkVehicleController.getNetworkObject(): NetworkObject

## engine/networking/PlayerAppearanceSync.ts
interface PlayerAppearance — A per-player appearance choice — which body part to recolour and to what colour.
PlayerAppearance.partName: string
PlayerAppearance.color: number
interface AppearanceChoice — A selectable colour in the pre-game picker.
AppearanceChoice.label: string
AppearanceChoice.color: number
interface AppearancePickerOptions — Options for the optional lightweight pre-game picker.
AppearancePickerOptions.title: string
AppearancePickerOptions.partName: string
AppearancePickerOptions.choices: AppearanceChoice[]
interface TintableCharacter — Anything that can recolour a named body part — both the local player's
TintableCharacter.tintBodyPart(name: string, color: number): boolean
interface PlayerAppearanceSyncOptions
PlayerAppearanceSyncOptions.multiplayer: MultiplayerSetup
PlayerAppearanceSyncOptions.localCharacter: TintableCharacter
PlayerAppearanceSyncOptions.appearance: PlayerAppearance | null
const DEFAULT_TEAM_COLORS: AppearanceChoice[]
class PlayerAppearanceSync — Synchronises per-player appearance choices across a multiplayer session.
PlayerAppearanceSync.constructor(options: PlayerAppearanceSyncOptions)
PlayerAppearanceSync.setAppearance(appearance: PlayerAppearance): void
PlayerAppearanceSync.getAppearance(): PlayerAppearance | null
PlayerAppearanceSync.handleRemotePlayerCreated(senderId: string, character: NetworkCharacterController): void
PlayerAppearanceSync.dispose(): void
static PlayerAppearanceSync.pickAppearance(container: HTMLElement, options: AppearancePickerOptions): Promise<PlayerAppearance>

## engine/networking/PlayerLifeState.ts
class PlayerLifeStateStore — Life state survives missing visuals and reliable-delivery retries.
PlayerLifeStateStore.get(playerId: string): Readonly<PlayerLifeSnapshot> | null
PlayerLifeStateStore.apply(message: StateMessage): boolean
PlayerLifeStateStore.remove(playerId: string): void
PlayerLifeStateStore.clear(): void

## engine/networking/SharedMultiplayerState.ts
interface SharedMultiplayerStateOptions<TDelta, TSnapshot>
SharedMultiplayerStateOptions.name: string
SharedMultiplayerStateOptions.networkManager: NetworkManager
SharedMultiplayerStateOptions.gameDataService: GameDataService
SharedMultiplayerStateOptions.isHost: () => boolean
SharedMultiplayerStateOptions.applyDelta: (delta: TDelta, senderId: string) => void
SharedMultiplayerStateOptions.serializeSnapshot: () => TSnapshot
SharedMultiplayerStateOptions.applySnapshot: (snapshot: TSnapshot) => void
SharedMultiplayerStateOptions.persistFlushIntervalMs?: number
class SharedMultiplayerState<TDelta, TSnapshot>
SharedMultiplayerState.constructor(opts: SharedMultiplayerStateOptions<TDelta, TSnapshot>)
SharedMultiplayerState.start(): Promise<void>
SharedMultiplayerState.emit(delta: TDelta): void
SharedMultiplayerState.save(): Promise<void>
SharedMultiplayerState.dispose(): void

## engine/networking/SpectatorCamera.ts
interface SpectatorGameplayCamera — Minimal adapter also supported by custom game cameras.
SpectatorGameplayCamera.enabled: boolean
SpectatorGameplayCamera.setEnabled(enabled: boolean): void
class SpectatorCamera — Owns a separate perspective camera; the walking camera keeps its target and lens.
SpectatorCamera.constructor(private readonly engine: EngineLike, private readonly gameplayCamera: SpectatorGameplayCamera, private readonly distanceInHeights: number)
SpectatorCamera.follow(target: THREE.Object3D, height: number): void
SpectatorCamera.hold(): void
SpectatorCamera.setInputEnabled(enabled: boolean, following: boolean): void
SpectatorCamera.update(deltaTime: number, following: boolean): void
SpectatorCamera.orbit(x: number, y: number): void
SpectatorCamera.dispose(): void

## engine/networking/SpectatorOverlay.ts
class SpectatorOverlay — Separate from gameplay HUD, so hiding weapon/health UI cannot hide spectating.
SpectatorOverlay.element
SpectatorOverlay.constructor(onCycle: (direction: number) => void)
SpectatorOverlay.render(name: string | null, count: number, respawnSeconds: number | null, deathDelay: boolean): void
SpectatorOverlay.dispose(): void

## engine/networking/WorldShardSync.ts
const SHARD_VOXEL_SIZE = SHARD_REGION_CHUNKS * SHARD_CHUNK_SIZE
interface WorldShardSyncOptions
WorldShardSyncOptions.gameId: string
WorldShardSyncOptions.voxelWorld: VoxelWorld
WorldShardSyncOptions.networkManager: NetworkManager | null
WorldShardSyncOptions.spawnX: number
WorldShardSyncOptions.spawnY: number
WorldShardSyncOptions.spawnZ: number
WorldShardSyncOptions.spawnLoadRadiusVoxels: number
WorldShardSyncOptions.flushIntervalMs: number
WorldShardSyncOptions.maxEditsPerFlush: number
WorldShardSyncOptions.serverBaseUrl: string
const DEFAULT_WORLD_SHARD_SYNC_OPTIONS: Omit<WorldShardSyncOptions, 'gameId' | 'voxelWorld' | 'networkManager'>
class WorldShardSync
WorldShardSync.constructor(opts: WorldShardSyncOptions)
WorldShardSync.bootstrap(): Promise<{ shardCount: number; editCount: number }>
WorldShardSync.flushNow(): Promise<void>
WorldShardSync.dispose(): void
