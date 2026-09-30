# engine-api-vehicle

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/FirstPersonVehicleCamera.ts
class FirstPersonVehicleCamera — First-person vehicle camera that sits at a configurable driver's-eye offset
FirstPersonVehicleCamera.constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, domElement: HTMLElement, _engine: unknown = null)
FirstPersonVehicleCamera.setEnabled(enabled: boolean): void
FirstPersonVehicleCamera.update(deltaTime: number): void
FirstPersonVehicleCamera.setTarget(newTarget: THREE.Object3D): void
FirstPersonVehicleCamera.getTarget(): THREE.Object3D
FirstPersonVehicleCamera.setSeatOffset(x: number, y: number, z: number): void
FirstPersonVehicleCamera.getForwardVector(): THREE.Vector3
FirstPersonVehicleCamera.getRightVector(): THREE.Vector3
FirstPersonVehicleCamera.getCamera(): THREE.PerspectiveCamera
FirstPersonVehicleCamera.dispose(): void

## engine/PlayerDrivingVehicleMovement.ts
class PlayerDrivingVehicleMovement implements IPlayerMovement — Vehicle driving movement implementation
PlayerDrivingVehicleMovement.constructor(vehicleManager: VehicleManager, extension?: VehicleControlsExtension)
PlayerDrivingVehicleMovement.setExtension(extension: VehicleControlsExtension | null): void
PlayerDrivingVehicleMovement.getExtension(): VehicleControlsExtension | null
PlayerDrivingVehicleMovement.update(deltaTime: number, playerController: PlayerController, keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; interact: boolean; action: boolean; secondaryAction?: boolean; descend: boolean }, isGrounded: boolean, moveDirection: THREE.Vector3, playerBody: RAPIER.RigidBody, physicsWorld: PhysicsWorld): void
PlayerDrivingVehicleMovement.getCurrentSpeed(): number
PlayerDrivingVehicleMovement.isInAir(): boolean
PlayerDrivingVehicleMovement.getRotation(): number
PlayerDrivingVehicleMovement.setRotation(rotation: number): void
PlayerDrivingVehicleMovement.reset(): void
PlayerDrivingVehicleMovement.getAscendDisplayName(): string
PlayerDrivingVehicleMovement.getDescendDisplayName(): string
PlayerDrivingVehicleMovement.getSupportedKeys(): { ascend: boolean; descend: boolean }
PlayerDrivingVehicleMovement.getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' }
PlayerDrivingVehicleMovement.shouldShowPlayer(): boolean
PlayerDrivingVehicleMovement.handlesPlayerPositionSync(): boolean
PlayerDrivingVehicleMovement.getMoveSpeed(): number
PlayerDrivingVehicleMovement.setMoveSpeed(_speed: number): void
PlayerDrivingVehicleMovement.getVehicleManager(): VehicleManager
PlayerDrivingVehicleMovement.notifyVehicleEntered(): void
PlayerDrivingVehicleMovement.notifyVehicleExited(): void

## engine/PlayerVehicleController.ts
class PlayerVehicleController — Handles vehicle entry, exit, and control for the player.
PlayerVehicleController.constructor(engine: EngineLike | null)
PlayerVehicleController.setCameraMode(mode: CameraMode): void
PlayerVehicleController.getCameraMode(): CameraMode
PlayerVehicleController.setVehicleCameraMode(mode: VehicleCameraMode): void
PlayerVehicleController.getVehicleCameraMode(): VehicleCameraMode
PlayerVehicleController.setVehicleManager(vehicleManager: VehicleManager, walkingCamera: CameraController | null): void
PlayerVehicleController.setMobileControls(mobileControls: any): void
PlayerVehicleController.tryEnterVehicle(player: THREE.Object3D, playerPosition: THREE.Vector3, interactable: Interactable | null, getCameraController: () => CameraController | null, playerController?: any): boolean
PlayerVehicleController.exitVehicle(player: THREE.Object3D, playerBody: RAPIER.RigidBody, characterHeight: number, onCameraRestore: (camera: CameraController | null) => void, playerController?: any): void
PlayerVehicleController.switchVehicle(player: THREE.Object3D, newVehicle: Vehicle, playerController?: any): boolean
PlayerVehicleController.updateInteractionPrompts(showInteractionPrompt: (displayName: string) => void, hideInteractionPrompt: () => void): void
PlayerVehicleController.checkMobileExitPressed(): boolean
PlayerVehicleController.handleExitRequest(player: THREE.Object3D, playerBody: RAPIER.RigidBody, characterHeight: number, onCameraRestore: (camera: CameraController | null) => void, playerController?: any): void
PlayerVehicleController.getVehicleCamera(): VehicleCamera | FirstPersonVehicleCamera | null
PlayerVehicleController.isPlayerInVehicle(): boolean
PlayerVehicleController.getVehicleManager(): VehicleManager | null
PlayerVehicleController.getActiveVehicle(): any
PlayerVehicleController.getCurrentInteractable(): Interactable | null
PlayerVehicleController.clearInteractable(): void
PlayerVehicleController.validateState(playerController?: { getMovementSystem?: () => IPlayerMovement | null }): boolean
PlayerVehicleController.dispose(): void

## engine/RacingSetup.ts
interface RacingSetupOptions
RacingSetupOptions.lockVehicleExit: boolean
RacingSetupOptions.freeMouse: boolean
RacingSetupOptions.autoRight: VehicleAutoRightOptions
RacingSetupOptions.unstuck: VehicleUnstuckOptions
RacingSetupOptions.stuck: VehicleStuckOptions
RacingSetupOptions.route?: VehicleRouteRecoveryOptions
const DEFAULT_RACING_SETUP_OPTIONS: RacingSetupOptions
class RacingSetup — Everything a lap-based racing game must wire up to feel right, behind one call.
RacingSetup.constructor(opts: RacingSetupOptions, playerController: PlayerController | null = null)
RacingSetup.getSafetySystems(): VehicleSafetySystems
RacingSetup.register(vehicle: Vehicle, route?: VehicleRouteRegistration): void
RacingSetup.unregister(vehicle: Vehicle): void
RacingSetup.setStuckDetectionEnabled(enabled: boolean): void
RacingSetup.setRespawnProvider(provider: VehicleRespawnProvider | null): void
RacingSetup.update(deltaTime: number): void
function installRacingDefaults(engine: GameEngine, playerController: PlayerController, options: RacingSetupOptions): RacingSetup

## engine/TrackCenterline.ts
type CenterlinePoint = { x: number; y: number; z: number }
interface NamedTrimeshLevel — A baked level that can answer named-trimesh queries — `VxlSceneTerrainSystem` (a voxel bake)
NamedTrimeshLevel.getTrimeshNames(): string[]
NamedTrimeshLevel.getTrimesh(name: string): { vertices: Float32Array; indices: Uint32Array } | null
NamedTrimeshLevel.getTrackCenterline(name: string, options?: Partial<TrackCenterlineOptions>): CenterlinePoint[]
interface TrackCenterlineOptions
TrackCenterlineOptions.waypointCount: number
TrackCenterlineOptions.sampleGridSize: number
TrackCenterlineOptions.maxStepDistance: number
TrackCenterlineOptions.smoothingWindow: number
TrackCenterlineOptions.recenter: boolean
TrackCenterlineOptions.recenterHalfWidth: number
TrackCenterlineOptions.recenterForwardTol: number
TrackCenterlineOptions.recenterYTol: number
TrackCenterlineOptions.recenterGapThreshold: number
TrackCenterlineOptions.reverse: boolean
TrackCenterlineOptions.orientTo?: { position: { x: number; z: number }; heading: { x: number; z: number } }
const DEFAULT_TRACK_CENTERLINE_OPTIONS: TrackCenterlineOptions
function buildTrackCenterline(trimesh: { vertices: Float32Array; indices: Uint32Array }, options?: Partial<TrackCenterlineOptions>): CenterlinePoint[]

## engine/VehicleAutoRightSystem.ts
interface VehicleAutoRightOptions
VehicleAutoRightOptions.tiltDotThreshold: number
VehicleAutoRightOptions.tiltDurationMs: number
VehicleAutoRightOptions.liftMeters: number
const DEFAULT_VEHICLE_AUTO_RIGHT_OPTIONS: VehicleAutoRightOptions
class VehicleAutoRightSystem — Auto-rights any registered vehicle that has been tilted past the threshold for too long.
VehicleAutoRightSystem.constructor(opts: VehicleAutoRightOptions)
VehicleAutoRightSystem.register(vehicle: Vehicle): void
VehicleAutoRightSystem.unregister(vehicle: Vehicle): void
VehicleAutoRightSystem.update(deltaTime: number): void

## engine/VehicleCamera.ts
class VehicleCamera — VehicleCamera provides a specialized camera controller for driving vehicles
VehicleCamera.constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, domElement: HTMLElement, engine: any = null, sizeScale: number = 1)
VehicleCamera.setDistance(distance: number): void
VehicleCamera.setHeight(height: number): void
VehicleCamera.setLookAtHeight(height: number): void
VehicleCamera.setFollowSpeed(speed: number): void
VehicleCamera.setPositionSmoothness(smoothness: number): void
VehicleCamera.setLookSmoothness(smoothness: number): void
VehicleCamera.setGroundClearance(clearance: number): void
VehicleCamera.setDescentBoost(maxHeight: number, speedRef: number = this.descentSpeedRef): void
VehicleCamera.setSteeringSoftening(softZone: number, minResponse: number): void
VehicleCamera.getDistance(): number
VehicleCamera.getHeight(): number
VehicleCamera.setEnabled(enabled: boolean): void
VehicleCamera.update(deltaTime: number): void
VehicleCamera.setTarget(newTarget: THREE.Object3D): void
VehicleCamera.getTarget(): THREE.Object3D
VehicleCamera.setCameraSettings(distance?: number, height?: number, followSpeed?: number): void
VehicleCamera.getForwardVector(): THREE.Vector3
VehicleCamera.getRightVector(): THREE.Vector3
VehicleCamera.getCamera(): THREE.PerspectiveCamera
VehicleCamera.dispose(): void

## engine/VehicleCollisionSystem.ts
interface VehicleCollisionEvent
VehicleCollisionEvent.vehicleA: Vehicle
VehicleCollisionEvent.vehicleB: Vehicle
VehicleCollisionEvent.contactPoint: { x: number; y: number; z: number }
VehicleCollisionEvent.impactSpeed: number
interface VehicleCollisionSystemOptions
VehicleCollisionSystemOptions.minImpactSpeed: number
VehicleCollisionSystemOptions.cooldownMs: number
VehicleCollisionSystemOptions.onCollision: (event: VehicleCollisionEvent) => void
const DEFAULT_VEHICLE_COLLISION_OPTIONS: VehicleCollisionSystemOptions
class VehicleCollisionSystem — Detects collisions between registered vehicles using physics callbacks.
VehicleCollisionSystem.constructor(physicsWorld: PhysicsWorld, options: Partial<VehicleCollisionSystemOptions> = {})
VehicleCollisionSystem.registerVehicle(vehicle: Vehicle): void
VehicleCollisionSystem.unregisterVehicle(vehicle: Vehicle): void
VehicleCollisionSystem.update(deltaTime: number): void
VehicleCollisionSystem.dispose(): void

## engine/VehicleDrivingComponent.ts
interface IVehicleDrivingComponent — Interface for pluggable vehicle AI driving behavior.
IVehicleDrivingComponent.update(deltaTime: number, vehicle: Vehicle): void
IVehicleDrivingComponent.setTarget(x: number, z: number, isFinal?: boolean): void
IVehicleDrivingComponent.stop(): void
IVehicleDrivingComponent.isNear(x: number, z: number, radius: number): boolean
IVehicleDrivingComponent.yieldThrottle?(seconds: number): void
interface BasicDrivingRecoveryOptions — Stuck-recovery tuning. The defaults are the values that were hardcoded
BasicDrivingRecoveryOptions.enabled: boolean
BasicDrivingRecoveryOptions.speedThreshold: number
BasicDrivingRecoveryOptions.speedFractionOfTarget: number
BasicDrivingRecoveryOptions.requireThrottle: boolean
BasicDrivingRecoveryOptions.timeThreshold: number
BasicDrivingRecoveryOptions.burstDuration: number
BasicDrivingRecoveryOptions.burstEscalation: number
BasicDrivingRecoveryOptions.burstMaxDuration: number
BasicDrivingRecoveryOptions.escalationWindow: number
interface VehicleDrivingStatus — What the driver can tell game code about its own progress.
VehicleDrivingStatus.unreachable: boolean
VehicleDrivingStatus.secondsWithoutProgress: number
VehicleDrivingStatus.bestDistance: number
VehicleDrivingStatus.failedRecoveries: number
interface BasicDrivingOptions
BasicDrivingOptions.analogThrottle: boolean
BasicDrivingOptions.cruiseSpeed: number
BasicDrivingOptions.slowRadius: number
BasicDrivingOptions.crawlSpeed: number
BasicDrivingOptions.arriveRadius: number
BasicDrivingOptions.steerDeadzoneAngle: number
BasicDrivingOptions.steerFullLockAngle: number
BasicDrivingOptions.reverseDistanceThreshold: number
BasicDrivingOptions.noProgressTimeout?: number
BasicDrivingOptions.recovery: BasicDrivingRecoveryOptions
const DEFAULT_BASIC_DRIVING_OPTIONS: BasicDrivingOptions
const SMOOTH_DRIVING_OPTIONS: BasicDrivingOptions
class BasicDrivingComponent implements IVehicleDrivingComponent — Default driving component that steers a vehicle toward a target point.
BasicDrivingComponent.constructor(options: BasicDrivingOptions = DEFAULT_BASIC_DRIVING_OPTIONS)
BasicDrivingComponent.maxSpeed
BasicDrivingComponent.setTarget(x: number, z: number, isFinal = true): void
BasicDrivingComponent.setCruiseOverride(speed: number | null): void
BasicDrivingComponent.stop(): void
BasicDrivingComponent.yieldThrottle(seconds: number): void
BasicDrivingComponent.isNear(x: number, z: number, radius: number): boolean
BasicDrivingComponent.getDrivingStatus(): VehicleDrivingStatus
BasicDrivingComponent.update(deltaTime: number, vehicle: Vehicle): void

## engine/VehicleHeading.ts
const FACE = { POS_X: Math.PI / 2, NEG_X: -Math.PI / 2, POS_Z: 0, NEG_Z:
function headingToward(from: { x: number; z: number }, to: { x: number; z: number }): number
function headingTangent(center: { x: number; z: number }, p: { x: number; z: number }, dir: 'cw' | 'ccw'): number

## engine/VehicleManager.ts
class VehicleManager — VehicleManager - Manages all vehicles in the game world.
VehicleManager.constructor(engine: EngineLike)
VehicleManager.createVehicle(config: VehicleConfig): Vehicle
VehicleManager.update(): void
VehicleManager.findNearestVehicle(position: THREE.Vector3, maxDistance: number = 5.0): Vehicle | null
VehicleManager.findInteractableVehicle(playerPosition: THREE.Vector3): Vehicle | null
VehicleManager.exitCurrentVehicle(): unknown
VehicleManager.getActiveVehicle(): Vehicle | null
VehicleManager.isPlayerInVehicle(): boolean
VehicleManager.updateVehicleControls(controls: { forward: boolean; backward: boolean; left: boolean; right: boolean; brake: boolean; steer?: number; }, deltaTime: number = 0.016): void
VehicleManager.getAllVehicles(): Vehicle[]
VehicleManager.removeVehicle(vehicle: Vehicle): boolean
VehicleManager.dispose(): void
VehicleManager.getVehicleCount(): number
VehicleManager.isValidVehiclePosition(position: THREE.Vector3): boolean
VehicleManager.getGroundHeightAt(x: number, z: number, searchHeight: number = 100): number | null

## engine/VehiclePathDrivingComponent.ts
function planRouteWithVias(nav: VehicleNav, from: NavPoint, vias: NavPoint[], destination: NavPoint, opts: VehicleNavQueryOptions): { result: VehicleNavPath; viaArcs: number[] }
const VIA_CONSUMPTION_EPSILON_M = 0.5
function projectOntoPath(points: NavPoint[], cumulative: number[], lastS: number, x: number, z: number, windowM: number): { s: number; distance: number }
function pointAtArc(points: NavPoint[], cumulative: number[], s: number): NavPoint
const PURSUIT_ARRIVE_CLEARANCE_M = 1.5
const INTERMEDIATE_ARRIVE_RADIUS_M = 1.2
const MIN_CORNER_SPEED_MPS = 1.5
const STALL_DEFER_LIMIT = 2
const STALL_BLOCKED_LIMIT = 4
const UNREACHABLE_RETRIGGER_S = 10
function advanceToClearArc(points: NavPoint[], cumulative: number[], startS: number, x: number, z: number, minDistance: number): number | null
const CURVATURE_CHORD_M = 2.5
function curvatureAt(points: NavPoint[], cumulative: number[], s: number, spanM: number): number
interface VehiclePathFollowOptions
VehiclePathFollowOptions.lookAheadBaseM: number
VehiclePathFollowOptions.lookAheadPerSpeed: number
VehiclePathFollowOptions.lookAheadMinM: number
VehiclePathFollowOptions.lookAheadMaxM: number
VehiclePathFollowOptions.maxLateralAccelMps2: number
VehiclePathFollowOptions.offPathReplanFactor: number
VehiclePathFollowOptions.replanFailureLimit: number
VehiclePathFollowOptions.stallProgressEpsilonM: number
VehiclePathFollowOptions.stallWindowS: number
VehiclePathFollowOptions.driving: BasicDrivingOptions
const DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS: VehiclePathFollowOptions
type VehiclePathActivity = 'idle' | 'planning' | 'driving' | 'arrived' | 'blocked'
interface VehiclePathDrivingStatus
VehiclePathDrivingStatus.activity: VehiclePathActivity
VehiclePathDrivingStatus.distanceRemaining: number
VehiclePathDrivingStatus.arrived: boolean
VehiclePathDrivingStatus.replans: number
VehiclePathDrivingStatus.inner: VehicleDrivingStatus
interface DriveToOptions — Optional third argument to `driveTo` — mid-drive "turn left here"
DriveToOptions.via?: NavPoint[]
class VehiclePathDrivingComponent implements IVehicleDrivingComponent
VehiclePathDrivingComponent.constructor(options: VehiclePathFollowOptions = DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS)
VehiclePathDrivingComponent.driveTo(nav: VehicleNav | null, destination: NavPoint, opts?: DriveToOptions): void
VehiclePathDrivingComponent.setOnArrived(cb: (() => void) | null): void
VehiclePathDrivingComponent.getStatus(): VehiclePathDrivingStatus
VehiclePathDrivingComponent.update(deltaTime: number, vehicle: Vehicle): void
VehiclePathDrivingComponent.setTarget(x: number, z: number, isFinal = true): void
VehiclePathDrivingComponent.stop(): void
VehiclePathDrivingComponent.isNear(x: number, z: number, radius: number): boolean
VehiclePathDrivingComponent.yieldThrottle(seconds: number): void

## engine/VehiclePlatform.ts
interface PlatformWheelConfig — Per-wheel configuration for platform vehicles.
PlatformWheelConfig.radius: number
PlatformWheelConfig.width?: number
PlatformWheelConfig.suspensionRestLength?: number
PlatformWheelConfig.suspensionStiffness?: number
PlatformWheelConfig.suspensionDamping?: number
PlatformWheelConfig.friction?: number
PlatformWheelConfig.isDriven?: boolean
PlatformWheelConfig.torqueRatio?: number
PlatformWheelConfig.color?: number
interface PlatformVehicleConfig — Configuration for a platform-based vehicle.
PlatformVehicleConfig.width: number
PlatformVehicleConfig.length: number
PlatformVehicleConfig.frontWheels?: PlatformWheelConfig
PlatformVehicleConfig.rearWheels?: PlatformWheelConfig
PlatformVehicleConfig.middleWheels?: PlatformWheelConfig
PlatformVehicleConfig.wheelRadius?: number
PlatformVehicleConfig.wheelWidth?: number
PlatformVehicleConfig.suspensionStiffness?: number
PlatformVehicleConfig.suspensionDamping?: number
PlatformVehicleConfig.friction?: number
PlatformVehicleConfig.wheelCount?: number
PlatformVehicleConfig.color?: number
PlatformVehicleConfig.wheelColor?: number
PlatformVehicleConfig.mass?: number
PlatformVehicleConfig.engineForce?: number
PlatformVehicleConfig.handling?: VehicleHandlingConfig
interface VehiclePlatformStructure — Represents the flat platform structure that forms the base of a vehicle.
VehiclePlatformStructure.vehicleConfig: VehicleConfig
VehiclePlatformStructure.platformWidth: number
VehiclePlatformStructure.platformLength: number
VehiclePlatformStructure.platformHeight: number
VehiclePlatformStructure.wheelConfigs: WheelConfig[]
VehiclePlatformStructure.wheelPositions: THREE.Vector3[]
VehiclePlatformStructure.maxWheelRadius: number
VehiclePlatformStructure.topSurfaceY: number
VehiclePlatformStructure.wheelRadius: number
VehiclePlatformStructure.wheelWidth: number
interface PlatformBlock — Block definition for platform body parts.
PlatformBlock.position: THREE.Vector3
PlatformBlock.size: { width: number; height: number; length: number }
PlatformBlock.color: number
class VehiclePlatformBuilder — VehiclePlatformBuilder creates flat vehicle platforms.
static VehiclePlatformBuilder.PLATFORM_HEIGHT
static VehiclePlatformBuilder.createPlatform(position: THREE.Vector3, config: PlatformVehicleConfig): VehiclePlatformStructure
static VehiclePlatformBuilder.getPlatformBlocks(structure: VehiclePlatformStructure): PlatformBlock[]
static VehiclePlatformBuilder.getPlatformSubBlocks(structure: VehiclePlatformStructure, blockSize: number = 0.5): PlatformBlock[]

## engine/VehicleRenderer.ts
interface VehicleRenderer — Interface for pluggable vehicle visual renderers
VehicleRenderer.createChassisMesh(config: VehicleConfig, position: THREE.Vector3): THREE.Object3D
VehicleRenderer.createWheelMeshes(config: VehicleConfig, position: THREE.Vector3, wheelConfigs?: WheelConfig[]): THREE.Mesh[]
VehicleRenderer.updateVisuals?(deltaTime: number, speed: number): void

## engine/VehicleRouteRecovery.ts
interface VehicleRouteState — The route an AI vehicle is meant to be on, as the game already knows it.
VehicleRouteState.points: ReadonlyArray<CenterlinePoint>
VehicleRouteState.targetIndex: number
VehicleRouteState.loop: boolean
VehicleRouteState.corridorHalfWidth: number
type VehicleRouteProvider = (vehicle: Vehicle) => VehicleRouteState | null
interface VehicleRouteRegistration — What a vehicle hands the engine when it opts into route recovery.
VehicleRouteRegistration.route: VehicleRouteProvider
VehicleRouteRegistration.onRejoined?: (vehicle: Vehicle, index: number) => void
interface VehicleRejoinPlan — Where a vehicle should rejoin its route, and how far off it currently is.
VehicleRejoinPlan.index: number
VehicleRejoinPlan.position: { x: number; y: number; z: number }
VehicleRejoinPlan.heading: number
VehicleRejoinPlan.distance: number
interface VehicleRouteRecoveryOptions
VehicleRouteRecoveryOptions.offRouteGraceSeconds: number
VehicleRouteRecoveryOptions.searchAhead: number
VehicleRouteRecoveryOptions.dropHeight: number
VehicleRouteRecoveryOptions.debugLog: boolean
const DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS: VehicleRouteRecoveryOptions
class VehicleRouteRecoverySystem
VehicleRouteRecoverySystem.constructor(opts: VehicleRouteRecoveryOptions)
VehicleRouteRecoverySystem.register(vehicle: Vehicle, registration: VehicleRouteRegistration): void
VehicleRouteRecoverySystem.unregister(vehicle: Vehicle): void
VehicleRouteRecoverySystem.has(vehicle: Vehicle): boolean
VehicleRouteRecoverySystem.setEnabled(enabled: boolean): void
VehicleRouteRecoverySystem.planRejoin(vehicle: Vehicle): VehicleRejoinPlan | null
VehicleRouteRecoverySystem.resumeAt(vehicle: Vehicle, plan: VehicleRejoinPlan): void
VehicleRouteRecoverySystem.recover(vehicle: Vehicle): boolean
VehicleRouteRecoverySystem.update(deltaTime: number): void

## engine/VehicleSafetySystems.ts
interface VehicleSafetyOptions — The vehicle safety systems every physics-car game needs, independent of
VehicleSafetyOptions.autoRight: VehicleAutoRightOptions
VehicleSafetyOptions.unstuck: VehicleUnstuckOptions
VehicleSafetyOptions.stuck: VehicleStuckOptions
VehicleSafetyOptions.route?: VehicleRouteRecoveryOptions
const DEFAULT_VEHICLE_SAFETY_OPTIONS: VehicleSafetyOptions
class VehicleSafetySystems
VehicleSafetySystems.constructor(opts: VehicleSafetyOptions, playerController: PlayerController | null = null)
VehicleSafetySystems.register(vehicle: Vehicle, route?: VehicleRouteRegistration): void
VehicleSafetySystems.unregister(vehicle: Vehicle): void
VehicleSafetySystems.setStuckDetectionEnabled(enabled: boolean): void
VehicleSafetySystems.setRespawnProvider(provider: VehicleRespawnProvider | null): void
VehicleSafetySystems.getRouteRecovery(): VehicleRouteRecoverySystem
VehicleSafetySystems.update(deltaTime: number): void
function installVehicleSafety(options: VehicleSafetyOptions, playerController: PlayerController | null = null): VehicleSafetySystems

## engine/VehicleSpawner.ts
const DEFAULT_RACING_CAR_CONFIG: PlatformVehicleConfig
interface SpawnFromAssetOptions — Options for spawnFromAsset / spawnAndEnterFromAsset.
SpawnFromAssetOptions.spawnRotation: number
const DEFAULT_SPAWN_FROM_ASSET_OPTIONS: SpawnFromAssetOptions
class VehicleSpawner — VehicleSpawner - Specialized helper for spawning platform-based vehicles
VehicleSpawner.constructor(spawner: Spawner, vehicleManager: VehicleManager)
VehicleSpawner.spawnVehicle(xz: { x: number; z: number }, config: PlatformVehicleConfig, renderer?: VehicleRenderer, spawnRotation?: number): { vehicle: Vehicle; platform: VehiclePlatformStructure } | null
VehicleSpawner.spawnVehicleRelativeTo(referencePos: { x: number; z: number }, offset: { x: number; z: number }, config: PlatformVehicleConfig, renderer?: VehicleRenderer): { vehicle: Vehicle; platform: VehiclePlatformStructure } | null
VehicleSpawner.spawnVehicleWithFallback(xz: { x: number; z: number }, config: PlatformVehicleConfig, renderer?: VehicleRenderer, searchRadius: number = 20, spawnRotation?: number): { vehicle: Vehicle; platform: VehiclePlatformStructure } | null
VehicleSpawner.spawnVehicleWithRenderer(xz: { x: number; z: number }, config: PlatformVehicleConfig, renderer: VehicleRenderer): Vehicle | null
VehicleSpawner.spawnMultipleVehicles(spawns: Array<{ position: { x: number; z: number }; config: PlatformVehicleConfig; renderer?: VehicleRenderer; }>): Array<{ vehicle: Vehicle; platform: VehiclePlatformStructure } | null>
VehicleSpawner.createPlatformStructure(config: PlatformVehicleConfig): VehiclePlatformStructure
VehicleSpawner.spawnAndEnter(xz: { x: number; z: number }, config: PlatformVehicleConfig, bodyConfig: VoxelCarBodyConfig, playerController: PlayerController, spawnRotation?: number): { vehicle: Vehicle; platform: VehiclePlatformStructure } | null
VehicleSpawner.layoutGridOnLoop(opts: { center: { x: number; z: number }; radius: number; travel: 'cw' | 'ccw'; startAngle: number; slots: number; laneOffset: number; slotSpacing: number; }): Array<{ position: { x: number; z: number }; heading: number }>
VehicleSpawner.spawnFromAsset(xz: { x: number; z: number }, assetIdOrName: string, options: SpawnFromAssetOptions = DEFAULT_SPAWN_FROM_ASSET_OPTIONS): Promise<{ vehicle: Vehicle; platform: VehiclePlatformStructure } | null>
VehicleSpawner.spawnAndEnterFromAsset(xz: { x: number; z: number }, assetIdOrName: string, playerController: PlayerController, options: SpawnFromAssetOptions = DEFAULT_SPAWN_FROM_ASSET_OPTIONS): Promise<{ vehicle: Vehicle; platform: VehiclePlatformStructure } | null>
VehicleSpawner.getSpawner(): Spawner
VehicleSpawner.getVehicleManager(): VehicleManager

## engine/VehicleStuckSystem.ts
type VehicleRespawnProvider = (vehicle: Vehicle) => { position: { x: number; y: number; z: number }; /** Gameplay yaw (+Z forward). Omit to keep the vehicle's current heading. */ heading?: number; } | null
interface VehicleStuckOptions
VehicleStuckOptions.stuckSpeedThreshold: number
VehicleStuckOptions.throttleFraction: number
VehicleStuckOptions.stuckDurationMs: number
VehicleStuckOptions.nudgeMeters: number
VehicleStuckOptions.nudgeSpeed: number
VehicleStuckOptions.maxNudgeAttempts: number
VehicleStuckOptions.debugLog: boolean
const DEFAULT_VEHICLE_STUCK_OPTIONS: VehicleStuckOptions
class VehicleStuckSystem — Frees vehicles that have wedged against scenery — the classic case being a
VehicleStuckSystem.constructor(opts: VehicleStuckOptions)
VehicleStuckSystem.register(vehicle: Vehicle): void
VehicleStuckSystem.unregister(vehicle: Vehicle): void
VehicleStuckSystem.setEnabled(enabled: boolean): void
VehicleStuckSystem.isEnabled(): boolean
VehicleStuckSystem.setRespawnProvider(provider: VehicleRespawnProvider | null): void
VehicleStuckSystem.update(deltaTime: number): void

## engine/VehicleUnstuckSystem.ts
interface VehicleUnstuckOptions — Configuration for {@link VehicleUnstuckSystem}.
VehicleUnstuckOptions.contactDistance: number
VehicleUnstuckOptions.minSeparationGain: number
VehicleUnstuckOptions.contactDuration: number
VehicleUnstuckOptions.disableDuration: number
VehicleUnstuckOptions.bumpSpeed: number
VehicleUnstuckOptions.bumpTeleport: number
VehicleUnstuckOptions.cooldownMs: number
VehicleUnstuckOptions.debugLog: boolean
VehicleUnstuckOptions.maxStuckSpeed?: number
VehicleUnstuckOptions.maxLockstepSpeed?: number
VehicleUnstuckOptions.contactSlop?: number
VehicleUnstuckOptions.onSeparated?: (event: VehicleSeparationEvent) => void
interface VehicleSeparationEvent — Payload of {@link VehicleUnstuckOptions.onSeparated}.
VehicleSeparationEvent.vehicleA: Vehicle
VehicleSeparationEvent.vehicleB: Vehicle
VehicleSeparationEvent.nx: number
VehicleSeparationEvent.nz: number
const DEFAULT_VEHICLE_UNSTUCK_OPTIONS: VehicleUnstuckOptions
class VehicleUnstuckSystem — Frees vehicles that have genuinely locked together — the race-start grid
VehicleUnstuckSystem.constructor(options: VehicleUnstuckOptions)
VehicleUnstuckSystem.register(vehicle: Vehicle): void
VehicleUnstuckSystem.unregister(vehicle: Vehicle): void
VehicleUnstuckSystem.setEnabled(enabled: boolean): void
VehicleUnstuckSystem.update(deltaTime: number): void
VehicleUnstuckSystem.bumpPair(a: Vehicle, b: Vehicle): void

## engine/vehicle/BmVehicleFitment.ts
const BM_VEHICLE_EXTRAS_KEY = 'bmVehicle'
const BM_WHEEL_NODE_PREFIX = 'BM_wheel_'
interface FitmentDerivation
FitmentDerivation.fitment: VehicleAssetFitment
FitmentDerivation.warnings: string[]
interface AuthoredBounds
AuthoredBounds.min: { x: number; y: number; z: number }
AuthoredBounds.max: { x: number; y: number; z: number }
interface DeriveFitmentOptions
DeriveFitmentOptions.bodyBounds: AuthoredBounds
DeriveFitmentOptions.hasWheelNodes: boolean
DeriveFitmentOptions.appliedScale?: number
function deriveVehicleFitment(sceneExtras: unknown, options: DeriveFitmentOptions): FitmentDerivation | null
function isBmWheelNodeName(name: string | undefined): boolean

## engine/vehicle/PlatformVehicleParts.ts
const SPINE_WIDTH_RATIO = 0.4
const DEFAULT_CHASSIS_COLOR = 0x444444
const DEFAULT_WHEEL_COLOR = 0x222222
const DEFAULT_WINDOW_OPACITY = 0.7
interface BodyPartBox — The box shape shared by `BoxPartConfig` and `VoxelPartConfig` — everything
BodyPartBox.position: { x: number; y: number; z: number }
BodyPartBox.size: { width: number; height: number; length: number }
BodyPartBox.color: number
BodyPartBox.isWindow?: boolean
function createBodyPartMaterial(part: BodyPartBox, windowOpacity: number): ClassedPartMaterial
function addSolidPartsPhysics(vehicle: Vehicle, platform: VehiclePlatformStructure, parts: readonly BodyPartBox[]): void
interface PlatformSlabOptions
PlatformSlabOptions.size: { width: number; height: number; length: number }
PlatformSlabOptions.wheelZs: number[]
PlatformSlabOptions.material: THREE.Material
function addPlatformSlab(group: THREE.Object3D, options: PlatformSlabOptions): void
interface CylinderWheelOptions
CylinderWheelOptions.name: string
CylinderWheelOptions.segments: number
function createCylinderWheelMeshes(config: VehicleConfig, position: THREE.Vector3, wheelConfigs: WheelConfig[] | undefined, options: CylinderWheelOptions): THREE.Mesh[]

## engine/vehicle/VehicleAssetVisual.ts
interface LoadedWheelNode
LoadedWheelNode.name: string
LoadedWheelNode.position: THREE.Vector3
LoadedWheelNode.mesh: THREE.Mesh
interface LoadedVehicleVisual
LoadedVehicleVisual.chassisObject: THREE.Object3D
LoadedVehicleVisual.wheelNodes: LoadedWheelNode[]
LoadedVehicleVisual.tireColor?: number
function clearVehicleAssetCache(): void
function loadVehicleAssetVisual(engine: EngineLike, asset: Asset, fitment: VehicleAssetFitment): Promise<LoadedVehicleVisual>
function wheelMeshForAxleSide(visual: LoadedVehicleVisual, axle: VehicleFitmentAxle, side: 1 | -1): THREE.Mesh

## engine/vehicle/VehicleBodySway.ts
interface VehicleBodySwayOptions
VehicleBodySwayOptions.rollDegPerG: number
VehicleBodySwayOptions.pitchDegPerG: number
VehicleBodySwayOptions.maxRollDeg: number
VehicleBodySwayOptions.maxPitchDeg: number
VehicleBodySwayOptions.frequencyHz: number
VehicleBodySwayOptions.dampingRatio: number
VehicleBodySwayOptions.accelSmoothingHz: number
const DEFAULT_VEHICLE_BODY_SWAY: VehicleBodySwayOptions
interface VehicleBodySwayInput — Per-frame vehicle state the sway is derived from (body frame, +Z forward).
VehicleBodySwayInput.forwardSpeed: number
VehicleBodySwayInput.yawRate: number
interface VehicleBodySwayAngles — The lean to apply to the rendered body, in radians.
VehicleBodySwayAngles.rollRad: number
VehicleBodySwayAngles.pitchRad: number
class VehicleBodySway — Integrates the body's lean. One instance per vehicle; call `update` once per
VehicleBodySway.constructor(opts: VehicleBodySwayOptions = DEFAULT_VEHICLE_BODY_SWAY)
VehicleBodySway.setOptions(opts: Partial<VehicleBodySwayOptions>): void
VehicleBodySway.reset(): void
VehicleBodySway.getAngles(): VehicleBodySwayAngles
VehicleBodySway.update(deltaTime: number, input: VehicleBodySwayInput): VehicleBodySwayAngles

## engine/vehicle/VehicleDownforce.ts
interface VehicleDownforceModel — Shape of the aero curve. Shared by every vehicle; per-car strength is separate.
VehicleDownforceModel.referenceSpeed: number
VehicleDownforceModel.maxG: number
VehicleDownforceModel.groundedFraction: number
const DEFAULT_DOWNFORCE_MODEL: VehicleDownforceModel
function downforceGravityScale(airspeed: number, downforceG: number, anyWheelInContact: boolean, model: VehicleDownforceModel = DEFAULT_DOWNFORCE_MODEL): number

## engine/vehicle/WheelGuards.ts
const SUSPENSION_MAX_TRAVEL_FRACTION = 0.8
const WHEEL_GUARD_GROUND_CLEARANCE_FRACTION = 0.55
const WHEEL_GUARD_LENGTH_FRACTION = 0.85
interface WheelGuardInput — The wheel geometry a guard is derived from (chassis-local, meters).
WheelGuardInput.position: { x: number; y: number; z: number }
WheelGuardInput.radius: number
WheelGuardInput.width: number
WheelGuardInput.suspensionRestLength: number
interface WheelGuardBox — A guard cuboid, chassis-local, in the same shape as a vehicle body part.
WheelGuardBox.position: { x: number; y: number; z: number }
WheelGuardBox.size: { width: number; height: number; length: number }
function wheelGuardBox(wheel: WheelGuardInput): WheelGuardBox | null

## engine/vehicleConfigScaling.ts
function scaleVehicleConfig(base: PlatformVehicleConfig, scale: number): PlatformVehicleConfig

## engine/vehicleHandling.ts
interface VehicleHandlingConfig — Optional per-vehicle handling overrides. Set at spawn via `config.handling`, or at runtime via `vehicle.setHandling(...)`.
VehicleHandlingConfig.topSpeed?: number
VehicleHandlingConfig.reverseTopSpeed?: number
VehicleHandlingConfig.accelerationScale?: number
VehicleHandlingConfig.maxSteerAngle?: number
VehicleHandlingConfig.steerSpeed?: number
VehicleHandlingConfig.steerSpeedFalloff?: number
VehicleHandlingConfig.minSteerAtSpeed?: number
VehicleHandlingConfig.downforce?: number
interface ResolvedVehicleHandling — Engine-internal resolved handling — every field present, angles in RADIANS.
ResolvedVehicleHandling.topSpeed: number
ResolvedVehicleHandling.reverseTopSpeed: number
ResolvedVehicleHandling.accelerationScale: number
ResolvedVehicleHandling.maxSteerAngleRad: number
ResolvedVehicleHandling.steerSpeedRad: number
ResolvedVehicleHandling.steerReturnSpeedRad: number
ResolvedVehicleHandling.steerSpeedFalloff: number
ResolvedVehicleHandling.minSteerAtSpeed: number
ResolvedVehicleHandling.downforceG: number
const HANDLING_DEFAULTS = { /** Footprint (m) the defaults are tuned for = the default
function resolveVehicleHandling(overrides: VehicleHandlingConfig | undefined, sizeFactor: number): ResolvedVehicleHandling
function gateDriveForce(engineForce: number, forwardSpeed: number, h: Pick<ResolvedVehicleHandling, 'topSpeed' | 'reverseTopSpeed'>): number
const THROTTLE_PARKING_BRAKE_EPSILON = 0.01
function resolveThrottle(throttle: number | undefined, forward: boolean, backward: boolean): number
function resolveBraking(brakeAmount: number | undefined, brake: boolean): number
function resolveSteering(steer: number | undefined, left: boolean, right: boolean, current: number, maxAngle: number, rampDelta: number, returnDelta: number): number
function steeringSoftening(speed: number, sizeFactor: number, steerSpeedFalloff: number): number
function steeringSpeedFactor(speed: number, sizeFactor: number, h: Pick<ResolvedVehicleHandling, 'steerSpeedFalloff' | 'minSteerAtSpeed'>): number
function handlingToAgentUnits(r: ResolvedVehicleHandling): Required<VehicleHandlingConfig>

## engine/vehicleTraversability.ts
interface VehicleFootprint — Chassis box dimensions in metres.
VehicleFootprint.width: number
VehicleFootprint.height: number
VehicleFootprint.length: number
type PassFailure = 'clear' | 'step' | 'obstacle' | 'gap'
interface VehiclePassResult
VehiclePassResult.passable: boolean
VehiclePassResult.blockedAt: number
VehiclePassResult.reason: PassFailure
VehiclePassResult.peakGrade: number
interface PathSample — One ground sample along the segment. `height: null` = the down-ray hit nothing.
PathSample.distance: number
PathSample.height: number | null
function derivedStepHeight(wheelRadius: number): number
function bridgeableGapWidth(maxStepHeight: number): number
function derivedClimbGrade(engineForce: number, mass: number): number
function evaluateVehiclePath(samples: PathSample[], maxClimbGrade: number, maxStepHeight: number, sweepHitAt: number | null): VehiclePassResult
