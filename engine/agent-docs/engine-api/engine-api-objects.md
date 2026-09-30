# engine-api-objects

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/CarryableComponent.ts
type CarryState = 'idle' | 'carried' | 'placed'
interface CarryableEntityAdapter — Adapter for entities that have their own interaction/physics systems
CarryableEntityAdapter.getObject3D(): THREE.Object3D
CarryableEntityAdapter.disablePhysics(): void
CarryableEntityAdapter.enablePhysics(position: THREE.Vector3): void
CarryableEntityAdapter.pauseBehavior?(): void
CarryableEntityAdapter.resumeBehavior?(): void
interface CarryableConfig
CarryableConfig.object3D?: THREE.Object3D
CarryableConfig.displayName: string
CarryableConfig.radius?: number
CarryableConfig.carryOffset?: THREE.Vector3
CarryableConfig.rotateWithPlayer?: boolean
CarryableConfig.attachToHand?: string | null
CarryableConfig.onPickedUp?: (component: CarryableComponent) => void
CarryableConfig.onDropped?: (component: CarryableComponent) => void
CarryableConfig.onPlacedInZone?: (component: CarryableComponent, zoneName: string) => void
CarryableConfig.meta?: { objectId: string; name: string }
CarryableConfig.entityAdapter?: CarryableEntityAdapter
type CarryEventListener = ( event: 'pickedUp' | 'dropped' | 'placedInZone', objectName: string, object3D: THREE.Object3D, zoneName?: string, ) => void
function onCarryEvent(listener: CarryEventListener): void
function removeCarryEventListener(listener: CarryEventListener): void
function clearCarryEventListeners(): void
interface CarryableAnimalLike — Duck-typed AnimalController interface (avoids circular imports)
CarryableAnimalLike.getCharacter(): THREE.Object3D
CarryableAnimalLike.getPhysicsBody(): import('@dimforge/rapier3d-compat').RigidBody | null
CarryableAnimalLike.setTargetPosition(target: THREE.Vector3 | null, maxPathLength?: number): void
CarryableAnimalLike.setBeingCarried(carried: boolean): void
CarryableAnimalLike.setBehavior(behavior: INpcBehavior): void
CarryableAnimalLike.detachBehavior(): INpcBehavior | null
function createAnimalAdapter(animal: CarryableAnimalLike): CarryableEntityAdapter
class CarryableComponent implements Interactable
CarryableComponent.constructor(physicsWorld: PhysicsWorld, config: CarryableConfig)
static CarryableComponent.fromAnimal(animal: CarryableAnimalLike, physicsWorld: PhysicsWorld, config: Omit<CarryableConfig, 'object3D' | 'entityAdapter'>): CarryableComponent
CarryableComponent.onInteractStart(): boolean
CarryableComponent.getInteractStartDisplayName(): string
CarryableComponent.interactionEnabled(): boolean
CarryableComponent.isFollowingPlayer(): boolean
CarryableComponent.get state(): CarryState
CarryableComponent.get displayName(): string
CarryableComponent.getObject3D(): THREE.Object3D
CarryableComponent.isCarried(): boolean
CarryableComponent.forceDrop(): void
CarryableComponent.update(_deltaTime: number, playerPosition: THREE.Vector3, playerQuaternion: THREE.Quaternion): void
CarryableComponent.isDisposed(): boolean
CarryableComponent.onCarryAttach(controller: CarryPlayerController): void
CarryableComponent.onCarryDetach(controller: CarryPlayerController): void
CarryableComponent.dispose(): void

## engine/CollectibleComponent.ts
interface CollectibleComponentConfig
CollectibleComponentConfig.collectible: Collectible
CollectibleComponentConfig.object3D: THREE.Object3D
CollectibleComponentConfig.radius?: number
CollectibleComponentConfig.yOffset?: number
CollectibleComponentConfig.meta?: { objectId: string; name: string }
class CollectibleComponent
CollectibleComponent.constructor(physicsWorld: PhysicsWorld, config: CollectibleComponentConfig)
CollectibleComponent.getCollectible(): Collectible
CollectibleComponent.getObject3D(): THREE.Object3D
CollectibleComponent.getSensorHandle(): number | null
CollectibleComponent.isDisposed(): boolean
CollectibleComponent.dispose(): void

## engine/ColliderEstimate.ts
function estimateColliderCount(leaves: ReadonlyArray<{ x: number; y: number; z: number; size: number }>, gridStep: number): number

## engine/CollisionLayers.ts
const CollisionGroup = { PLAYER: 1, // 0x0001 - Player character ENVIRONMENT: 2, //
const CollisionMask = { // Player collides with: terrain, environment, vehicles, p
type CollisionGroupType = typeof CollisionGroup[keyof typeof CollisionGroup]
type CollisionMaskType = typeof CollisionMask[keyof typeof CollisionMask]
function makeCollisionGroups(memberOf: number, collidesWith: number): number

## engine/CrumblingPlatform.ts
interface CrumblingPlatformOptions
CrumblingPlatformOptions.center: THREE.Vector3
CrumblingPlatformOptions.size: THREE.Vector3
CrumblingPlatformOptions.breakAfterS: number
CrumblingPlatformOptions.respawnAfterS: number
CrumblingPlatformOptions.color: number
CrumblingPlatformOptions.getPlayerFeet: () => THREE.Vector3 | null
CrumblingPlatformOptions.name?: string
CrumblingPlatformOptions.editorData?: Record<string, unknown> | null
const DEFAULT_CRUMBLING_PLATFORM_OPTIONS: Omit<CrumblingPlatformOptions, 'center' | 'getPlayerFeet'>
class CrumblingPlatform — CrumblingPlatform — a static slab that breaks away shortly after a player
CrumblingPlatform.constructor(engine: EngineLike, options: CrumblingPlatformOptions)
CrumblingPlatform.applyEditableParam(key: string, value: number): boolean
CrumblingPlatform.update(deltaTime: number): void
CrumblingPlatform.dispose(): void

## engine/DeterministicDestruction.ts
interface DeterministicExplosionParams — Parameters that fully describe a deterministic explosion.
DeterministicExplosionParams.cx: Fixed16
DeterministicExplosionParams.cy: Fixed16
DeterministicExplosionParams.cz: Fixed16
DeterministicExplosionParams.radius: Fixed16
DeterministicExplosionParams.impulseStrength: Fixed16
DeterministicExplosionParams.impulseUp: Fixed16
DeterministicExplosionParams.seq?: number
const DeterministicDestruction = { // ── Parameter creation ─────────────────────────────────

## engine/Door.ts
interface DoorOptions
DoorOptions.position: THREE.Vector3
DoorOptions.rotation: number
DoorOptions.width: number
DoorOptions.height: number
DoorOptions.thickness: number
DoorOptions.slideDistance: number
DoorOptions.slideAxis: 'x' | 'y' | 'z'
DoorOptions.slideDurationMs: number
DoorOptions.requiresKeycardId: string | null
DoorOptions.onOpen: (() => void) | null
DoorOptions.onClose: (() => void) | null
const DEFAULT_DOOR_OPTIONS: DoorOptions
class Door implements Interactable
Door.constructor(engine: EngineLike, options: DoorOptions)
Door.open(): void
Door.close(): void
Door.toggle(): void
Door.isOpen(): boolean
Door.setLocked(locked: boolean): void
Door.isLocked(): boolean
Door.getRequiredKeycardId(): string | null
Door.onInteractStart(): boolean
Door.getInteractStartDisplayName(): string
Door.isActionable(): boolean
Door.dispose(): void

## engine/DropZoneComponent.ts
interface DropZoneConfig
DropZoneConfig.position: THREE.Vector3
DropZoneConfig.radius?: number
DropZoneConfig.name: string
DropZoneConfig.displayName: string
DropZoneConfig.onObjectPlaced?: (objectName: string, object3D: THREE.Object3D) => void
DropZoneConfig.capacity?: number
class DropZoneComponent
DropZoneComponent.constructor(physicsWorld: PhysicsWorld, config: DropZoneConfig)
static DropZoneComponent.findZoneAtPosition(position: THREE.Vector3): DropZoneComponent | null
static DropZoneComponent.findZoneByName(name: string): DropZoneComponent | null
static DropZoneComponent.clearRegistry(): void
DropZoneComponent.get name(): string
DropZoneComponent.get displayName(): string
DropZoneComponent.canAccept(): boolean
DropZoneComponent.getPosition(): THREE.Vector3
DropZoneComponent.getRadius(): number
DropZoneComponent.getPlacedCount(): number
DropZoneComponent.notifyObjectPlaced(objectName: string, object3D: THREE.Object3D): void
DropZoneComponent.isDisposed(): boolean
DropZoneComponent.dispose(): void

## engine/DynamicObjectManager.ts
interface DynamicObjectStats
DynamicObjectStats.total: number
DynamicObjectStats.active: number
DynamicObjectStats.hibernating: number
DynamicObjectStats.byType: Map<string, { active: number; hibernating: number }>
interface TerrainBounds — World-space AABB of the main terrain (same shape for procedural and baked runtimes).
TerrainBounds.minX: number
TerrainBounds.minY: number
TerrainBounds.minZ: number
TerrainBounds.maxX: number
TerrainBounds.maxY: number
TerrainBounds.maxZ: number
interface BakedTerrainProvider — The subset of a baked terrain system (`VxlSceneTerrainSystem` / `VxlChunkedTerrainSystem`)
BakedTerrainProvider.getBounds(): TerrainBounds | null
class DynamicObjectManager
DynamicObjectManager.constructor(engine?: EngineLike)
DynamicObjectManager.setTerrainSystem(terrainSystem: VoxelTerrainSystem, miningOpts?: Partial<VoxelMiningOptions>): void
DynamicObjectManager.updateMining(deltaTime: number): void
DynamicObjectManager.disposeMining(): void
DynamicObjectManager.getVoxelMiningSystem(): VoxelMiningSystem | null
DynamicObjectManager.getMainVoxelWorld(): import('engine/VoxelWorld.js').VoxelWorld | null
DynamicObjectManager.setBakedTerrain(terrain: BakedTerrainProvider | null): void
DynamicObjectManager.getBakedTerrain(): BakedTerrainProvider | null
DynamicObjectManager.getTerrainBounds(): TerrainBounds | null
DynamicObjectManager.hasTerrainSystem(): boolean
DynamicObjectManager.areTerrainCollidersReady(): boolean
DynamicObjectManager.forceActivateChunksAtPosition(x: number, z: number): void
DynamicObjectManager.register(obj: ChunkManagedObject, type: string, radius: number = 0.5): void
DynamicObjectManager.unregister(obj: ChunkManagedObject): void
DynamicObjectManager.updatePosition(obj: ChunkManagedObject): void
DynamicObjectManager.getStats(): DynamicObjectStats
DynamicObjectManager.maybeLogStats(): void
DynamicObjectManager.clear(): void
DynamicObjectManager.getCountByType(type: string): number
DynamicObjectManager.isRegistered(obj: ChunkManagedObject): boolean
DynamicObjectManager.getVoxelFloorY(x: number, feetY: number, z: number): number | null
DynamicObjectManager.setVoxelBlockSize(size: number): void

## engine/FragmentConnectivity.ts
interface FragmentAabb — Object-local fragment AABB as stored in `VoxelObject._fragmentAabbs`.
FragmentAabb.min: [number, number, number]
FragmentAabb.max: [number, number, number]
function aabbsShareFace(a: FragmentAabb, b: FragmentAabb, eps: number = CONTACT_EPS): boolean
function groundPlaneY(aabbs: ReadonlyArray<FragmentAabb>): number
function findUnsupportedFragments(aabbs: ReadonlyArray<FragmentAabb>, groundY: number, eps: number = CONTACT_EPS): number[]

## engine/FragmentInstancePool.ts
interface FragmentVisualSource — Geometry/material source for one fragment index.
FragmentVisualSource.geometry: THREE.BufferGeometry
FragmentVisualSource.material: THREE.Material | THREE.Material[]
class FragmentSlot — Handle to one rented slot. Stable across pool growth and other slots'
FragmentSlot.slot: number
FragmentSlot.constructor(private readonly pool: FragmentInstancePool, readonly fragIndex: number, slot: number)
FragmentSlot.setMatrix(matrix: THREE.Matrix4): void
FragmentSlot.release(): void
FragmentSlot.get released(): boolean
class FragmentInstancePool
FragmentInstancePool.constructor(private readonly parent: THREE.Object3D, private readonly sources: ReadonlyArray<FragmentVisualSource>, private readonly namePrefix: string, private readonly shadows: boolean = true)
FragmentInstancePool.get fragmentCount(): number
FragmentInstancePool.activeCount(fragIndex: number): number
FragmentInstancePool.acquire(fragIndex: number, matrix: THREE.Matrix4): FragmentSlot | null
FragmentInstancePool._writeMatrix(fragIndex: number, slot: number, matrix: THREE.Matrix4): void
FragmentInstancePool._release(fragIndex: number, slot: number): void
FragmentInstancePool.dispose(): void

## engine/InteractableComponent.ts
interface InteractableComponentConfig
InteractableComponentConfig.interactable: Interactable
InteractableComponentConfig.object3D: THREE.Object3D
InteractableComponentConfig.radius?: number
InteractableComponentConfig.physicsBody?: RAPIER.RigidBody
InteractableComponentConfig.yOffset?: number
class InteractableComponent
InteractableComponent.constructor(physicsWorld: PhysicsWorld, config: InteractableComponentConfig)
InteractableComponent.syncPosition(): void
InteractableComponent.syncToWorldPosition(worldPos: THREE.Vector3): void
InteractableComponent.getInteractable(): Interactable
InteractableComponent.getObject3D(): THREE.Object3D
InteractableComponent.getSensorHandle(): number | null
InteractableComponent.isDisposed(): boolean
InteractableComponent.setEnabled(enabled: boolean): void
InteractableComponent.dispose(): void

## engine/InteractionController.ts
interface InteractionControllerOptions
InteractionControllerOptions.playerController: PlayerController
InteractionControllerOptions.promptUI: InteractionPromptUI
InteractionControllerOptions.vehicleControllerHelper: PlayerVehicleController
InteractionControllerOptions.animalControllerHelper: PlayerAnimalController
InteractionControllerOptions.mobileControls: MobileControls
InteractionControllerOptions.getWeaponPickupManager: () => WeaponPickupManager | null
InteractionControllerOptions.getCameraController: () => CameraController | null
InteractionControllerOptions.setCameraController: (camera: CameraController) => void
InteractionControllerOptions.getEngine: () => EngineLike | null
InteractionControllerOptions.retargetCamera: (camera: CameraController | null) => void
InteractionControllerOptions.weaponPickupRange: number
class InteractionController
InteractionController.constructor(opts: InteractionControllerOptions)
InteractionController.setSuppressed(suppressed: boolean): void
InteractionController.isSuppressed(): boolean
InteractionController.update(): void
InteractionController.findNearbyInteractable(): NearestInteractableResult | null
InteractionController.onInteract(): boolean
InteractionController.hasInteractablesInScene(): boolean

## engine/InteractionManager.ts
interface NearestInteractableResult
NearestInteractableResult.interactable: Interactable
NearestInteractableResult.worldPosition: THREE.Vector3
type CollectionListener = (objectId: string, objectName: string, object3D: THREE.Object3D) => void
interface CarryPlayerController — Duck-typed PlayerController for carry hand attachment
CarryPlayerController.attachToBodyPart(object: THREE.Object3D, bodyPartName: string, rotation?: { x: number; y: number; z: number } | null): boolean
CarryPlayerController.detachFromBodyPart(object: THREE.Object3D): void
interface CarryableUpdatable — Interface for carryable objects that need automatic position updates
CarryableUpdatable.update(deltaTime: number, playerPosition: THREE.Vector3, playerQuaternion: THREE.Quaternion): void
CarryableUpdatable.onCarryAttach(controller: CarryPlayerController): void
CarryableUpdatable.onCarryDetach(controller: CarryPlayerController): void
CarryableUpdatable.isDisposed(): boolean
CarryableUpdatable.isCarried(): boolean
function getInteractionManager(): InteractionManager
function resetInteractionManager(): void
class InteractionManager
InteractionManager.register(sensorHandle: number, component: InteractableComponent): void
InteractionManager.unregister(sensorHandle: number): void
InteractionManager.registerCollectible(sensorHandle: number, component: CollectibleComponent, meta?: { objectId: string; name: string }): void
InteractionManager.unregisterCollectible(sensorHandle: number): void
InteractionManager.registerPickupProbe(colliderHandle: number): void
InteractionManager.unregisterPickupProbe(colliderHandle: number): void
InteractionManager.onCollected(listener: CollectionListener): void
InteractionManager.removeCollectionListener(listener: CollectionListener): void
InteractionManager.onIntersectionStart(sensorHandle: number, otherHandle: number): void
InteractionManager.onIntersectionEnd(sensorHandle: number, otherHandle: number): void
InteractionManager.getNearestInteractable(playerPosition: THREE.Vector3): NearestInteractableResult | null
InteractionManager.isInRange(interactable: Interactable): boolean
InteractionManager.getActiveOverlapCount(): number
InteractionManager.getRegisteredCount(): number
InteractionManager.getCollectibleCount(): number
InteractionManager.isCarrying(): boolean
InteractionManager.registerCarryable(carryable: CarryableUpdatable): void
InteractionManager.unregisterCarryable(carryable: CarryableUpdatable): void
InteractionManager.updateCarryables(deltaTime: number, playerPosition: THREE.Vector3, playerQuaternion: THREE.Quaternion, controller?: CarryPlayerController): void
InteractionManager.dispose(): void

## engine/KeycardReader.ts
interface KeycardReaderOptions
KeycardReaderOptions.position: THREE.Vector3
KeycardReaderOptions.rotation: number
KeycardReaderOptions.keycardId: string
KeycardReaderOptions.getPlayerCarriedItemId: () => string | null
KeycardReaderOptions.onUnlock: (() => void) | null
KeycardReaderOptions.onWrongCard: (() => void) | null
const DEFAULT_KEYCARD_READER_OPTIONS: KeycardReaderOptions
class KeycardReader implements Interactable
KeycardReader.constructor(engine: EngineLike, options: KeycardReaderOptions)
KeycardReader.onInteractStart(): boolean
KeycardReader.getInteractStartDisplayName(): string
KeycardReader.isActionable(): boolean
KeycardReader.dispose(): void

## engine/KinematicPlatform.ts
type KinematicPlatformLoopMode = 'loop' | 'pingpong' | 'once'
type KinematicPlatformTrigger = 'proximity' | 'key' | 'always'
interface KinematicPlatformKeyBindings
KinematicPlatformKeyBindings.up: string | null
KinematicPlatformKeyBindings.down: string | null
KinematicPlatformKeyBindings.toggle: string | null
interface KinematicPlatformPendulum — Pendulum swing mode: the body becomes a BOB hanging `armLength` below
KinematicPlatformPendulum.armLength: number
KinematicPlatformPendulum.periodS: number
KinematicPlatformPendulum.amplitudeDeg: number
KinematicPlatformPendulum.swingYawDeg: number
KinematicPlatformPendulum.phaseDeg: number
interface KinematicPlatformOptions
KinematicPlatformOptions.waypoints: THREE.Vector3[]
KinematicPlatformOptions.speed: number
KinematicPlatformOptions.angularSpeed: number
KinematicPlatformOptions.loop: KinematicPlatformLoopMode
KinematicPlatformOptions.trigger: KinematicPlatformTrigger
KinematicPlatformOptions.keyBindings: KinematicPlatformKeyBindings
KinematicPlatformOptions.proximityRadius: number
KinematicPlatformOptions.size: THREE.Vector3
KinematicPlatformOptions.mesh: THREE.Object3D | null
KinematicPlatformOptions.shape?: 'box' | 'cylinder' | 'sphere'
KinematicPlatformOptions.dwellS?: number
KinematicPlatformOptions.returnSpeed?: number
KinematicPlatformOptions.pendulum?: KinematicPlatformPendulum | null
KinematicPlatformOptions.surfaceVelocity?: { x: number; z: number } | null
KinematicPlatformOptions.name?: string
KinematicPlatformOptions.editorData?: Record<string, unknown> | null
const DEFAULT_KINEMATIC_PLATFORM_OPTIONS: KinematicPlatformOptions
class KinematicPlatform — KinematicPlatform — a kinematic rigid body that travels along waypoints,
KinematicPlatform.constructor(engine: EngineLike, options: KinematicPlatformOptions)
KinematicPlatform.applyEditableParam(key: string, value: number): boolean
KinematicPlatform.update(deltaTime: number): void
KinematicPlatform.dispose(): void

## engine/MechanismSystem.ts
type MechanismType = 'spinner' | 'movingPlatform' | 'pendulum' | 'crusher' | 'conveyor' | 'crumbling'
interface MechanismSpecLike
MechanismSpecLike.id?: string
MechanismSpecLike.type?: string
MechanismSpecLike.name?: string
MechanismSpecLike.position?: { x?: number; y?: number; z?: number }
MechanismSpecLike.params?: Record<string, unknown>
interface CustomEditableParam — Editable-parameter binding for a CUSTOM (game-code) mechanism: the clamp
CustomEditableParam.min: number
CustomEditableParam.max: number
CustomEditableParam.step: number
CustomEditableParam.display?: 'degPerSec'
CustomEditableParam.apply: (value: number) => void
class MechanismSystem
MechanismSystem.constructor(engine: EngineLike)
MechanismSystem.update(deltaTime: number): void
MechanismSystem.dispose(): void
MechanismSystem.getSpec(id: string): MechanismSpecLike | null
MechanismSystem.registerCustom(id: string, object3D: THREE.Object3D, editable: Record<string, CustomEditableParam>): boolean
MechanismSystem.buildFromSpec(spec: MechanismSpecLike): void

## engine/ObjectIdService.ts
type ObjectType = 'asset' | 'inst' | 'marker' | 'object' | 'env'
interface BoundingBox — Bounding box definition for objects
BoundingBox.minX: number
BoundingBox.minY: number
BoundingBox.minZ: number
BoundingBox.maxX: number
BoundingBox.maxY: number
BoundingBox.maxZ: number
interface ObjectTransform — Object transform data for NPC relative spawning
ObjectTransform.position: THREE.Vector3
ObjectTransform.rotation: THREE.Euler
ObjectTransform.boundingBox: BoundingBox | null
interface RegisteredObject — Registered object entry
RegisteredObject.id: string
RegisteredObject.type: ObjectType
RegisteredObject.object: THREE.Object3D
RegisteredObject.data?: any
class ObjectIdService — ObjectIdService - Centralized service for generating and managing object IDs
static ObjectIdService.getInstance(): ObjectIdService
static ObjectIdService.reset(): void
ObjectIdService.generateId(type: ObjectType): string
ObjectIdService.isValidId(id: string): boolean
ObjectIdService.parseIdType(id: string): string | null
ObjectIdService.register(id: string, type: ObjectType, object: THREE.Object3D, data?: any): void
ObjectIdService.unregister(id: string): void
ObjectIdService.getById(id: string): RegisteredObject | null
ObjectIdService.getObjectById(id: string): THREE.Object3D | null
ObjectIdService.getTypeById(id: string): string | null
ObjectIdService.getDataById(id: string): any | null
ObjectIdService.getObjectTransform(id: string): ObjectTransform | null
ObjectIdService.isRegistered(id: string): boolean
ObjectIdService.getAllByType(type: ObjectType): RegisteredObject[]
ObjectIdService.getAll(): RegisteredObject[]
ObjectIdService.updateData(id: string, data: any): void
ObjectIdService.findByObject(object: THREE.Object3D): RegisteredObject | null
ObjectIdService.findAllByObject(object: THREE.Object3D): RegisteredObject[]
ObjectIdService.getCount(): number
ObjectIdService.getCountByType(type: ObjectType): number
ObjectIdService.clear(): void
ObjectIdService.clearByType(type: ObjectType): void
function getObjectIdService(): ObjectIdService

## engine/ObjectPool.ts
class ObjectPool<T> — Generic object pool to avoid create/destroy churn.
ObjectPool.constructor(factory: () => T, reset: (obj: T) => void, initialSize = 0)
ObjectPool.get(): T
ObjectPool.release(obj: T): void
ObjectPool.releaseAll(): void
ObjectPool.get activeCount(): number
ObjectPool.get poolSize(): number
ObjectPool.prewarm(count: number): void

## engine/PristineDestructible.ts
interface PristineDestructibleHooks — PristineDestructibleVoxelObject — a destructible env-object instance that
PristineDestructibleHooks.hideBatchInstance: () => void
PristineDestructibleHooks.acquireFragmentSlot: (fragIndex: number, matrix: THREE.Matrix4) => FragmentSlot | null
class PristineDestructibleVoxelObject extends VoxelObject
PristineDestructibleVoxelObject.constructor(private readonly template: VoxelObject, private readonly hooks: PristineDestructibleHooks, options: { voxelSize: number; useAtlas: boolean; shadows: boolean })
PristineDestructibleVoxelObject.initPristinePhysics(physicsWorld: PhysicsWorld): void
PristineDestructibleVoxelObject.isPromoted(): boolean
PristineDestructibleVoxelObject.prepareForCarving(): boolean
PristineDestructibleVoxelObject.explodeAt(worldCenter: THREE.Vector3, radius: number, impulseStrength: number = 5, impulseUp: number = 2, parentGroup?: THREE.Object3D, voxelWorld?: VoxelWorld, mergeBlockType?: number): VoxelObjectDebris[]
interface PristineDestructibleInstance — Per-instance placement data as stored by the env-object batch build.
PristineDestructibleInstance.x: number
PristineDestructibleInstance.y: number
PristineDestructibleInstance.z: number
PristineDestructibleInstance.rotation?: number
PristineDestructibleInstance.rotationXYZ?: { x: number; y: number; z: number }
PristineDestructibleInstance.scale?: { width: number; height: number; depth: number }
PristineDestructibleInstance.objDef?: { id?: string; name?: string; obstacle?: boolean; collision?: boolean; destructionMode?: string; [key: string]: unknown; }
function resolveDestructionMode(objDef: { destructionMode?: string } | null | undefined, boundingBox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null | undefined, scale?: { width: number; height: number; depth: number }): VoxelDestructionMode
function spawnPristineDestructibleProxy(opts: { typeName: string; instance: PristineDestructibleInstance; template: VoxelObject; assetDefinition: { collision?: boolean } | null | undefined; /** Scene group the proxy (and later its fragments) live under. */ world: THREE.Object3D; physicsWorld: PhysicsWorld | null; /** How the object comes apart — see `resolveDestructionMode`. */ destructionMode: VoxelDestructionMode; /** The type's batch culling spheres; slot nulled on promotion. */ spheres: (THREE.Sphere | null)[] | null; instanceIndex: number; /** Lazy per-type fragment pool (null → clone fallback on promotion). */ getPool: () => FragmentInstancePool | null; }): PristineDestructibleVoxelObject

## engine/PristineDynamic.ts
interface PristineDynamicHooks — PristineDynamicVoxelObject — a `dynamic: true` env-object instance that costs
PristineDynamicHooks.hideBatchInstance: () => void
PristineDynamicHooks.onPromoted: (obj: PristineDynamicVoxelObject) => void
class PristineDynamicVoxelObject extends VoxelObject
PristineDynamicVoxelObject.constructor(private readonly template: VoxelObject, private readonly hooks: PristineDynamicHooks, options: { voxelSize: number; useAtlas: boolean; shadows: boolean })
PristineDynamicVoxelObject.initPristinePhysics(physicsWorld: PhysicsWorld, mass: number): void
PristineDynamicVoxelObject.isPromoted(): boolean
PristineDynamicVoxelObject.carveLeafCount(): number
PristineDynamicVoxelObject.shouldPromoteOnWake(): boolean
PristineDynamicVoxelObject.prepareForCarving(): boolean
PristineDynamicVoxelObject.promote(): void
PristineDynamicVoxelObject.explodeAt(worldCenter: THREE.Vector3, radius: number, impulseStrength: number = 5, impulseUp: number = 2, parentGroup?: THREE.Object3D, voxelWorld?: VoxelWorld, mergeBlockType?: number): VoxelObjectDebris[]
interface PristineDynamicInstance — Per-instance placement data as stored by the env-object batch build.
PristineDynamicInstance.x: number
PristineDynamicInstance.y: number
PristineDynamicInstance.z: number
PristineDynamicInstance.rotation?: number
PristineDynamicInstance.rotationXYZ?: { x: number; y: number; z: number }
PristineDynamicInstance.scale?: { width: number; height: number; depth: number }
PristineDynamicInstance.objDef?: { id?: string; name?: string; obstacle?: boolean; collision?: boolean; mass?: number; [key: string]: unknown; }
function resolveDynamicPropMass(objDef: { mass?: number } | null | undefined, boundingBox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null | undefined, scale?: { width: number; height: number; depth: number }): number
function spawnPristineDynamicProxy(opts: { typeName: string; instance: PristineDynamicInstance; template: VoxelObject; assetDefinition: { collision?: boolean; boundingBox?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } } | null | undefined; /** Scene group the proxy (and later its clone) lives under. */ world: THREE.Object3D; physicsWorld: PhysicsWorld | null; /** The type's batch culling spheres; slot nulled on promotion. */ spheres: (THREE.Sphere | null)[] | null; instanceIndex: number; /** Wire the promoted object into per-step sync + the chunk manager. */ onPromoted: (obj: PristineDynamicVoxelObject) => void; }): PristineDynamicVoxelObject
