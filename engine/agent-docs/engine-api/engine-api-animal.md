# engine-api-animal

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/animal/AnimalAnimationController.ts
class AnimalAnimationController — Animal Animation Controller - Procedural Animations for 4-Legged Animals
AnimalAnimationController.initializeWithCharacter(character: THREE.Object3D, gltf: any, loader: any, baseAnimations: BaseAnimationDefinition[]): Promise<void>
AnimalAnimationController.updateAnimation(isMoving: boolean, movementSpeed: number, isGrounded: boolean, isJumpPressed: boolean): void
AnimalAnimationController.update(deltaTime: number): void
AnimalAnimationController.dispose(): void
enum AnimalAnimationState { IDLE, WALK, TROT, RUN }

## engine/animal/AnimalAvoidanceComponent.ts
interface AnimalAvoidanceContext — Context callbacks the avoidance component uses to reach its host controller.
AnimalAvoidanceContext.getCharacter(): THREE.Object3D
AnimalAvoidanceContext.getPhysicsBody(): RAPIER.RigidBody | null
AnimalAvoidanceContext.getPhysicsWorld(): PhysicsWorld
AnimalAvoidanceContext.getEngine(): EngineLike
AnimalAvoidanceContext.getCapsuleRadius(): number
AnimalAvoidanceContext.getCapsuleHeight(): number
AnimalAvoidanceContext.getMoveSpeed(): number
AnimalAvoidanceContext.clearNavigation(): void
AnimalAvoidanceContext.clearPath(): void
AnimalAvoidanceContext.runMovementSystem(deltaTime: number, moveDirection: THREE.Vector3): void
class AnimalAvoidanceComponent — Reactive avoidance & recovery for animals:
AnimalAvoidanceComponent.constructor(private readonly ctx: AnimalAvoidanceContext)
AnimalAvoidanceComponent.setRetreatFromPlayerOverlap(retreat: boolean): void
AnimalAvoidanceComponent.avoidDynamicObstacles(deltaTime: number): boolean
AnimalAvoidanceComponent.reactToPlayerOverlap(deltaTime: number): boolean
AnimalAvoidanceComponent.recoverFromObstacle(deltaTime: number): boolean

## engine/animal/AnimalController.ts
interface AnimalConfigOptions — Configuration options for the fluent configure() API
AnimalConfigOptions.oneHitKill?: boolean
AnimalConfigOptions.bloodOnHit?: boolean
AnimalConfigOptions.bloodConfig?: BloodSplatterConfig
AnimalConfigOptions.explodeWithGore?: boolean
AnimalConfigOptions.goreConfig?: DeathExplosionConfig
AnimalConfigOptions.onDeath?: (killerDirection?: THREE.Vector3) => void
interface RiderInput — Input state from a rider controlling the animal.
RiderInput.forward: boolean
RiderInput.backward: boolean
RiderInput.left: boolean
RiderInput.right: boolean
RiderInput.sprint: boolean
RiderInput.targetRotation?: number
class AnimalController implements Interactable, IDamageable, ChunkManagedObject, ICharacterContext — AnimalController - AI-controlled 4-legged animal with physics and procedural animations
AnimalController.lodState: CharacterLodState
AnimalController.isGrounded: boolean
AnimalController.onRiderForceDismount: (animal: AnimalController, rider: THREE.Object3D) => void
AnimalController.onMeleeHitEffect: (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void
AnimalController.onProjectileHitEffect: (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void
AnimalController.get onDamage()
AnimalController.set onDamage(cb: ((damage: number, currentHealth: number, maxHealth: number, source?: string) => void) | undefined)
AnimalController.get onDeathEffect()
AnimalController.set onDeathEffect(cb: ((killerDirection?: THREE.Vector3) => void) | undefined)
AnimalController.onMeleeHit: (impactDirection?: THREE.Vector3, impulseStrength?: number) => void
static AnimalController.create(scene: THREE.Scene, physicsWorld: PhysicsWorld, engine: EngineLike, spawnPosition: THREE.Vector3, animalType: string, moveSpeed: number, factory: IBlockCharacterFactory): Promise<AnimalController>
AnimalController.update(deltaTime: number): void
AnimalController.setRetreatFromPlayerOverlap(retreat: boolean): void
AnimalController.setBehavior(behavior: INpcBehavior): void
AnimalController.getBehavior(): INpcBehavior | null
AnimalController.detachBehavior(): INpcBehavior | null
AnimalController.requestBehaviorChange(newBehavior: INpcBehavior): void
AnimalController.shatterIntoVoxels(): boolean
AnimalController.getCurrentPath(): THREE.Vector3[]
AnimalController.setTargetPosition(target: THREE.Vector3 | null, maxPathLength?: number): void
AnimalController.getLocomotionMode(): 'ground' | 'swim' | 'fly'
AnimalController.getMediumSensor(): AnimalMediumSensor | null
AnimalController.getEngine(): EngineLike
AnimalController.getNavMesh(): LegacyNavMesh | null
AnimalController.getPosition(): THREE.Vector3
AnimalController.getCharacter(): THREE.Object3D
AnimalController.getPhysicsWorld(): PhysicsWorld
AnimalController.getAnimalType(): string
AnimalController.isStunned(): boolean
AnimalController.getPhysicsBody(): RAPIER.RigidBody | null
AnimalController.setMaxStepUpHeight(height: number): void
AnimalController.getMaxStepUpHeight(): number
AnimalController.setStepHopEnabled(enabled: boolean): void
AnimalController.isStepHopEnabled(): boolean
AnimalController.setArrivalRadius(radius: number): void
AnimalController.getArrivalRadius(): number
AnimalController.setAvoidanceEnabled(enabled: boolean): void
AnimalController.isAvoidanceEnabled(): boolean
AnimalController.setStraightLinePath(enabled: boolean): void
AnimalController.isStraightLinePath(): boolean
AnimalController.setRotationSpeed(radiansPerSecond: number): void
AnimalController.getRotationSpeed(): number
AnimalController.setMoveSpeed(speed: number): void
AnimalController.getMoveSpeed(): number
AnimalController.setDebrisLifetime(ms: number): void
AnimalController.getExplodedDebris(): { mesh: THREE.Mesh; body: RAPIER.RigidBody }[]
AnimalController.removeDebrisPiece(mesh: THREE.Mesh): boolean
AnimalController.getPath(): THREE.Vector3[]
AnimalController.getCurrentWaypointIndex(): number
AnimalController.getCurrentWaypoint(): THREE.Vector3 | null
AnimalController.isFollowingPath(): boolean
AnimalController.hasReachedDestination(): boolean
AnimalController.getAnimationController(): GlbAnimalBody | BlockAnimalAnimationController
AnimalController.getVelocity(): THREE.Vector3
AnimalController.getRotation(): THREE.Quaternion
AnimalController.get player(): THREE.Object3D
AnimalController.get characterHeight(): number
AnimalController.get capsuleRadius(): number
AnimalController.voxelBlockSize: number
AnimalController.holdPhysicsUntilReady(): void
AnimalController.releasePhysics(): void
AnimalController.setAlwaysActive(active: boolean): void
AnimalController.isAlwaysActive(): boolean
AnimalController.canHibernate(): boolean
AnimalController.setImportance(importance: 'hero' | 'crowd'): void
AnimalController.getImportance(): 'hero' | 'crowd'
AnimalController.hasActiveGoal(): boolean
AnimalController.isDeadOrRagdolled(): boolean
AnimalController.hibernate(): void
AnimalController.wake(): void
AnimalController.isHibernating(): boolean
AnimalController.onInteractStart(): boolean
AnimalController.getInteractStartDisplayName(): string
AnimalController.interactionEnabled(): boolean
AnimalController.setBeingCarried(carried: boolean): void
AnimalController.isBeingCarried(): boolean
AnimalController.setRideable(rideable: boolean): void
AnimalController.isRideable(): boolean
AnimalController.isBeingRidden(): boolean
AnimalController.getMountHeight(): number
AnimalController.setRiderInput(input: RiderInput | null): void
AnimalController.getCurrentSpeed(): number
AnimalController.mountRider(rider: THREE.Object3D): boolean
AnimalController.dismountRider(): THREE.Object3D | null
AnimalController.canMount(): boolean
AnimalController.getDismountPosition(): THREE.Vector3
AnimalController.forceDismountRider(): void
AnimalController.defaultMeleeHitHandler(impactDirection?: THREE.Vector3, impulseStrength: number = 8): void
AnimalController.onProjectileCollision(projectile: { getDamage?: () => number; getDirection?: () => THREE.Vector3; getKnockback?: () => number }): void
AnimalController.isExploded(): boolean
AnimalController.isDead(): boolean
AnimalController.isRagdolled(): boolean
AnimalController.hasRagdoll(): boolean
AnimalController.getHealth(): number
AnimalController.getMaxHealth(): number
AnimalController.setDamageFlashEnabled(enabled: boolean): void
AnimalController.getDamageFlash(): import('engine/effects/DamageFlash.js').DamageFlash | null
AnimalController.configure(options: AnimalConfigOptions): this
AnimalController.takeDamage(amount: number, source?: string, deathImpulse?: THREE.Vector3): void
AnimalController.setMaxHealth(maxHealth: number): void
AnimalController.heal(amount: number): boolean
AnimalController.resetHealth(): void
AnimalController.setStunDuration(seconds: number): void
AnimalController.setCorpseLifetimeMs(ms: number): void
AnimalController.dispose(): void
function convertGroupToLambertLighting(group: THREE.Object3D): void
function createAnimalBlockCharacterFactory(): IBlockCharacterFactory
interface CreateAnimalOptions — Options for creating an animal
CreateAnimalOptions.moveSpeed?: number
CreateAnimalOptions.factory?: IBlockCharacterFactory
CreateAnimalOptions.rideable?: boolean
CreateAnimalOptions.importance?: 'hero' | 'crowd'
function createAnimal(scene: THREE.Scene, physicsWorld: PhysicsWorld, engine: EngineLike, spawnPosition: THREE.Vector3, animalType: string, moveSpeed: number, factory: IBlockCharacterFactory, options?: { rideable?: boolean; importance?: 'hero' | 'crowd' }): Promise<AnimalController>

## engine/animal/AnimalEyeController.ts
type EyeStyle = 'square' | 'round'
type EyePlacement = 'front' | 'side'
interface AnimalEyeConfig — Extended eye configuration for animal eyes
AnimalEyeConfig.style?: EyeStyle
AnimalEyeConfig.placement?: EyePlacement
AnimalEyeConfig.size?: number
AnimalEyeConfig.color?: number
AnimalEyeConfig.scleraColor?: number
AnimalEyeConfig.positionOffset?: { x?: number; y?: number; z?: number }
AnimalEyeConfig.disabled?: boolean
AnimalEyeConfig.playerTrackingDistance?: number
class AnimalEyeController — Controls animal eye animations including blinking and player tracking.
AnimalEyeController.constructor(config: AnimalEyeConfig = {})
AnimalEyeController.setEyeReferences(head: THREE.Object3D, leftEye: THREE.Object3D, rightEye: THREE.Object3D, leftPupil: THREE.Mesh, rightPupil: THREE.Mesh, leftSclera: THREE.Mesh, rightSclera: THREE.Mesh, pupilOffset: number): void
AnimalEyeController.update(deltaTime: number, animalPosition: THREE.Vector3, playerPosition: THREE.Vector3 | null): void
AnimalEyeController.updateAlong(deltaTime: number, direction: THREE.Vector3): void
AnimalEyeController.dispose(): void

## engine/animal/AnimalFlyBehavior.ts
class AnimalFlyBehavior implements INpcBehavior — AnimalFlyBehavior - 3D aerial wandering for birds.
AnimalFlyBehavior.focusOffsetY: number
AnimalFlyBehavior.constructor(config?: { roamRadius?: number; // Max horizontal distance from spawn (default: 20) minAltitude?: number; // Min height above terrain at the target (default: 4) maxAltitude?: number; // Max height above terrain at the target (default: 12) focusOffsetY?: number; // Vertical offset from root to face (default: 0.5) })
AnimalFlyBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
AnimalFlyBehavior.initialize(controller: ICharacterContext): void
AnimalFlyBehavior.update(_deltaTime: number, currentPosition: THREE.Vector3, _currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
AnimalFlyBehavior.onTargetReached(): void
AnimalFlyBehavior.getName(): string
AnimalFlyBehavior.isHostile(): boolean
AnimalFlyBehavior.dispose(): void

## engine/animal/AnimalLocomotion3D.ts
interface Animal3DMovementOptions — Options for free-volume (3D) creature movement.
Animal3DMovementOptions.verticalSpeedRatio: number
Animal3DMovementOptions.turnRate: number
Animal3DMovementOptions.acceleration: number
Animal3DMovementOptions.drag: number
Animal3DMovementOptions.outOfMediumGravity: number
Animal3DMovementOptions.outOfMediumTerminalVelocity: number
const DEFAULT_SWIM_MOVEMENT_OPTIONS: Animal3DMovementOptions
const DEFAULT_FLIGHT_MOVEMENT_OPTIONS: Animal3DMovementOptions
class Animal3DMovement implements IPlayerMovement — Free-volume kinematic movement for swimming and flying creatures.
Animal3DMovement.constructor(moveSpeed: number, options: Animal3DMovementOptions)
Animal3DMovement.setInMedium(inMedium: boolean): void
Animal3DMovement.isInMedium(): boolean
Animal3DMovement.update(deltaTime: number, playerController: PlayerController, _keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; interact: boolean; action: boolean; secondaryAction?: boolean; descend: boolean }, _isGrounded: boolean, moveDirection: THREE.Vector3, playerBody: RAPIER.RigidBody, physicsWorld: PhysicsWorld): void
Animal3DMovement.getCurrentSpeed(): number
Animal3DMovement.isInAir(): boolean
Animal3DMovement.wasGroundedLastUpdate(): boolean
Animal3DMovement.getRotation(): number
Animal3DMovement.setRotation(rotation: number): void
Animal3DMovement.getVelocity(): THREE.Vector3
Animal3DMovement.reset(): void
Animal3DMovement.getMoveSpeed(): number
Animal3DMovement.setMoveSpeed(speed: number): void
Animal3DMovement.getAscendDisplayName(): string
Animal3DMovement.getDescendDisplayName(): string
Animal3DMovement.getSupportedKeys(): { ascend: boolean; descend: boolean }
Animal3DMovement.getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' }
Animal3DMovement.shouldShowPlayer(): boolean

## engine/animal/AnimalMediumSensor.ts
class AnimalMediumSensor — Medium queries for swimming and flying creatures.
AnimalMediumSensor.constructor(private readonly engine: EngineLike)
AnimalMediumSensor.isWaterAt(x: number, y: number, z: number): boolean
AnimalMediumSensor.findWaterSurfaceY(x: number, fromY: number, z: number): number | null
AnimalMediumSensor.getTerrainHeightAt(x: number, z: number): number | null
AnimalMediumSensor.findSubmergedY(x: number, z: number): number | null
AnimalMediumSensor.hasVoxelWorld(): boolean

## engine/animal/AnimalRegistry.ts
interface RegistrableCreature — Minimal interface for any creature (snake, animal, etc.) that the registry
RegistrableCreature.update(deltaTime: number): void
RegistrableCreature.dispose(): void
RegistrableCreature.isHibernating(): boolean
RegistrableCreature.getCharacter(): THREE.Object3D
RegistrableCreature.getPosition(): THREE.Vector3
RegistrableCreature.voxelBlockSize: number
RegistrableCreature.onDeathEffect?: ((killerDirection?: THREE.Vector3) => void)
type AnimalDeathCallback = (animalId: string, animalType: string, position: THREE.Vector3) => void
class AnimalRegistry
AnimalRegistry.onAnimalDeath: AnimalDeathCallback
AnimalRegistry.constructor(engine: EngineLike)
AnimalRegistry.register(name: string, animal: AnimalController): void
AnimalRegistry.setVoxelBlockSize(size: number): void
AnimalRegistry.registerCreature(name: string, creature: RegistrableCreature): void
AnimalRegistry.spawnMany(animalType: string, count: number, factory: IBlockCharacterFactory, positions?: Array<{ x: number; z: number }>): Promise<string[]>
AnimalRegistry.forEach(callback: (animal: AnimalController, id: string) => void): void
AnimalRegistry.getAll(): AnimalController[]
AnimalRegistry.unregister(name: string): void
AnimalRegistry.get(name: string): AnimalController | undefined
AnimalRegistry.has(name: string): boolean
AnimalRegistry.getNames(): string[]
AnimalRegistry.get count(): number
AnimalRegistry.updateAll(deltaTime: number): void
AnimalRegistry.disposeAll(): void

## engine/animal/AnimalRidingCamera.ts
class AnimalRidingCamera implements CameraController — Camera controller for when the player is riding an animal.
AnimalRidingCamera.constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, domElement: HTMLElement, engine: EngineLike | null = null)
AnimalRidingCamera.setEnabled(enabled: boolean): void
AnimalRidingCamera.update(deltaTime: number): void
AnimalRidingCamera.setTarget(newTarget: THREE.Object3D): void
AnimalRidingCamera.getTarget(): THREE.Object3D
AnimalRidingCamera.setCameraSettings(distance?: number, height?: number): void
AnimalRidingCamera.getForwardVector(): THREE.Vector3
AnimalRidingCamera.getRightVector(): THREE.Vector3
AnimalRidingCamera.getCamera(): THREE.PerspectiveCamera
AnimalRidingCamera.getHorizontalAngle(): number
AnimalRidingCamera.dispose(): void

## engine/animal/AnimalRoamBehavior.ts
class AnimalRoamBehavior implements INpcBehavior — AnimalRoamBehavior - Slow idle wandering for animals
AnimalRoamBehavior.focusOffsetY: number
AnimalRoamBehavior.constructor(config?: { roamRadius?: number; // Max distance from spawn to roam (default: 8) minIdleTime?: number; // Min seconds to idle (default: 2) maxIdleTime?: number; // Max seconds to idle (default: 6) idleChance?: number; // Chance to idle after reaching target (default: 0.7) focusOffsetY?: number; // Vertical offset from root to face (default: standing-human eye height) })
AnimalRoamBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
AnimalRoamBehavior.initialize(controller: ICharacterContext): void
AnimalRoamBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, _currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
AnimalRoamBehavior.onTargetReached(): void
AnimalRoamBehavior.getName(): string
AnimalRoamBehavior.isHostile(): boolean
AnimalRoamBehavior.dispose(): void

## engine/animal/AnimalSwimBehavior.ts
class AnimalSwimBehavior implements INpcBehavior — AnimalSwimBehavior - 3D wandering inside a water volume, for fish.
AnimalSwimBehavior.focusOffsetY: number
AnimalSwimBehavior.constructor(config?: { roamRadius?: number; // Max horizontal distance from spawn (default: 10) verticalRange?: number; // Max vertical distance from spawn (default: roamRadius * 0.5) minIdleTime?: number; // Min seconds hovering between moves (default: 1) maxIdleTime?: number; // Max seconds hovering between moves (default: 4) idleChance?: number; // Chance to hover after reaching a target (default: 0.4) focusOffsetY?: number; // Vertical offset from root to face (default: half-meter — fish are low) })
AnimalSwimBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
AnimalSwimBehavior.initialize(controller: ICharacterContext): void
AnimalSwimBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, _currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
AnimalSwimBehavior.onTargetReached(): void
AnimalSwimBehavior.getName(): string
AnimalSwimBehavior.isHostile(): boolean
AnimalSwimBehavior.dispose(): void

## engine/animal/BlockAnimalAnimationController.ts
class BlockAnimalAnimationController — Block Animal Animation Controller - Procedural Animations for Box-Based Animals
BlockAnimalAnimationController.initializeWithCharacter(character: THREE.Object3D, _gltf: unknown, _loader: unknown, _baseAnimations: unknown[]): Promise<void>
BlockAnimalAnimationController.getLocomotionMode(): 'ground' | 'swim' | 'fly'
BlockAnimalAnimationController.getCurrentState(): string
BlockAnimalAnimationController.setState(state: string): void
BlockAnimalAnimationController.updateAnimation(isMoving: boolean, movementSpeed: number, _isGrounded: boolean, _isJumpPressed: boolean): void
BlockAnimalAnimationController.update(deltaTime: number): void
static BlockAnimalAnimationController.GAIT_WALK: BlockAnimalGaitPhases
static BlockAnimalAnimationController.GAIT_TROT: BlockAnimalGaitPhases
static BlockAnimalAnimationController.GAIT_GALLOP: BlockAnimalGaitPhases
BlockAnimalAnimationController.dispose(): void
interface BlockAnimalGaitPhases — Footfall phase offsets (fraction of a full gait cycle) for each leg.
BlockAnimalGaitPhases.frontLeft: number
BlockAnimalGaitPhases.frontRight: number
BlockAnimalGaitPhases.backLeft: number
BlockAnimalGaitPhases.backRight: number
enum BlockAnimalAnimationState { IDLE, WALK, TROT, RUN, SWIM, SWIM_FAST, FLY, GLIDE }

## engine/animal/BlockAnimalBodyBuilder.ts
interface AnimalBlockConfig — Configuration for a single block within an animal part.
AnimalBlockConfig.position: { x?: number; y: number; z?: number }
AnimalBlockConfig.size: { width: number; height: number; depth: number }
AnimalBlockConfig.color: number
AnimalBlockConfig.rotation?: { x?: number; y?: number; z?: number }
AnimalBlockConfig.shape?: 'box' | 'wedge'
type AnimalBodyPlan = 'quadruped' | 'biped' | 'fish' | 'bird' | 'dragon' | 'cephalopod'
interface BlockAnimalBodyConfig — Configuration for an AI-composed animal body.
BlockAnimalBodyConfig.bodyBlocks: AnimalBlockConfig[]
BlockAnimalBodyConfig.headBlocks: AnimalBlockConfig[]
BlockAnimalBodyConfig.headAttachmentOffset?: { x?: number; y?: number; z?: number }
BlockAnimalBodyConfig.tailBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.tailAttachmentOffset?: { x?: number; y?: number; z?: number }
BlockAnimalBodyConfig.bodyPlan?: AnimalBodyPlan
BlockAnimalBodyConfig.frontLeftLegBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.frontRightLegBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.backLeftLegBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.backRightLegBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.leftWingBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.rightWingBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.leftWingOuterBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.rightWingOuterBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.wingAttachmentOffsets?: { left?: { x?: number; y?: number; z?: number }; right?: { x?: number; y?: number; z?: number }; }
BlockAnimalBodyConfig.leftFinBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.rightFinBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.finAttachmentOffsets?: { left?: { x?: number; y?: number; z?: number }; right?: { x?: number; y?: number; z?: number }; }
BlockAnimalBodyConfig.dorsalFinBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.dorsalFinAttachmentOffset?: { x?: number; y?: number; z?: number }
BlockAnimalBodyConfig.tailFinBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.tentacleBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.tentacleCount?: number
BlockAnimalBodyConfig.longTentacleBlocks?: AnimalBlockConfig[]
BlockAnimalBodyConfig.tentacleAttachmentOffset?: { x?: number; y?: number; z?: number }
BlockAnimalBodyConfig.legAttachmentOffsets?: { frontLeft?: { x?: number; y?: number; z?: number }; frontRight?: { x?: number; y?: number; z?: number }; backLeft?: { x?: number; y?: number; z?: number }; backRight?: { x?: number; y?: number; z?: number }; }
BlockAnimalBodyConfig.eyes?: AnimalEyeConfig
BlockAnimalBodyConfig.detail?: AnimalDetailConfig
BlockAnimalBodyConfig.shoulderHeight?: number
interface AnimalDimensions — Calculated dimensions for physics and positioning.
AnimalDimensions.width: number
AnimalDimensions.height: number
AnimalDimensions.depth: number
interface AnimalAttachmentPoint — A resolved attachment point (defaults + offsets applied), in body-local metres.
AnimalAttachmentPoint.x: number
AnimalAttachmentPoint.y: number
AnimalAttachmentPoint.z: number
type AnimalLegAttachments = Record<'frontLeft' | 'frontRight' | 'backLeft' | 'backRight', AnimalAttachmentPoint>
class BlockAnimalBodyBuilder — Block Animal Body Builder
static BlockAnimalBodyBuilder.resolveBodyPlan(config: BlockAnimalBodyConfig): AnimalBodyPlan
static BlockAnimalBodyBuilder.locomotionModeForPlan(plan: AnimalBodyPlan): 'ground' | 'swim' | 'fly'
static BlockAnimalBodyBuilder.calculateBodyBounds(bodyBlocks: AnimalBlockConfig[]): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number; width: number; height: number; depth: number; }
static BlockAnimalBodyBuilder.calculateDefaultAttachments(config: BlockAnimalBodyConfig): { headAttachment: AnimalAttachmentPoint; tailAttachment: AnimalAttachmentPoint; legAttachments: AnimalLegAttachments; wingAttachments: { left: AnimalAttachmentPoint; right: AnimalAttachmentPoint }; finAttachments: { left: AnimalAttachmentPoint; right: AnimalAttachmentPoint }; dorsalFinAttachment: AnimalAttachmentPoint; }
static BlockAnimalBodyBuilder.buildAnimal(characterGroup: THREE.Group, config: BlockAnimalBodyConfig): void
static BlockAnimalBodyBuilder.calculateDimensions(config: BlockAnimalBodyConfig): AnimalDimensions
static BlockAnimalBodyBuilder.calculateShoulderHeight(config: BlockAnimalBodyConfig): number
function createBlockAnimalFactory(config: BlockAnimalBodyConfig): IBlockCharacterFactory

## engine/animal/BlockAnimalVoxelDetailer.ts
type AnimalDetailPartKind = 'body' | 'head' | 'tail' | 'leg' | 'wing' | 'fin' | 'tentacle'
interface AnimalPatternConfig — Surface pattern presets, computed in part-local space so they wrap blocks seamlessly.
AnimalPatternConfig.type: 'spots' | 'stripes' | 'patches' | 'belly' | 'scales'
AnimalPatternConfig.color: number
AnimalPatternConfig.scale?: number
AnimalPatternConfig.parts?: AnimalDetailPartKind[]
interface AnimalDetailConfig — Optional voxel-detail style for a block animal. Set on
AnimalDetailConfig.voxelSize?: 'auto' | number
AnimalDetailConfig.colorJitter?: number
AnimalDetailConfig.roundness?: number
AnimalDetailConfig.pattern?: AnimalPatternConfig
AnimalDetailConfig.seed?: number
interface ResolvedAnimalDetail — Fully-resolved detail settings (required fields per engine options convention).
ResolvedAnimalDetail.voxelSize: 'auto' | number
ResolvedAnimalDetail.colorJitter: number
ResolvedAnimalDetail.roundness: number
ResolvedAnimalDetail.pattern: AnimalPatternConfig | null
ResolvedAnimalDetail.seed: number
const DEFAULT_ANIMAL_DETAIL: ResolvedAnimalDetail
function resolveAnimalDetail(config: AnimalDetailConfig): ResolvedAnimalDetail
function resolveAnimalVoxelSize(detail: ResolvedAnimalDetail, bodyLargestDim: number, allBlocks: ReadonlyArray<AnimalBlockConfig>): number
function clearAnimalDetailGeometryCache(): void
function getAnimalDetailGeometryCacheSize(): number
const SHARED_DETAIL_GEOMETRY_FLAG = 'sharedDetailGeometry'
function buildDetailedPartMesh(partKind: AnimalDetailPartKind, blocks: ReadonlyArray<AnimalBlockConfig>, detail: ResolvedAnimalDetail, animalVoxelSize: number): THREE.Mesh

## engine/animal/GlbAnimalBody.ts
class GlbAnimalBody
static GlbAnimalBody.load(resolved: ResolvedVoxelAnimal, scale = 1.0): Promise<GlbAnimalBody>
GlbAnimalBody.getObject3D(): THREE.Object3D
GlbAnimalBody.getDimensions(): Dimensions
GlbAnimalBody.getCurrentState(): string
GlbAnimalBody.updateAnimation(isMoving: boolean, movementSpeed: number, _isGrounded: boolean, _isJumpPressed: boolean): void
GlbAnimalBody.update(deltaTime: number): void
GlbAnimalBody.dispose(): void

## engine/animal/PlayerAnimalController.ts
class PlayerAnimalController — Handles animal mounting, dismounting, and control for the player.
PlayerAnimalController.constructor(engine: EngineLike | null)
PlayerAnimalController.isPlayerRiding(): boolean
PlayerAnimalController.getCurrentAnimal(): AnimalController | null
PlayerAnimalController.getAnimalMovement(): PlayerRidingAnimalMovement
PlayerAnimalController.getAnimalCamera(): AnimalRidingCamera | null
PlayerAnimalController.findRideableAnimal(playerPosition: THREE.Vector3, maxDistance: number = 3.0): AnimalController | null
PlayerAnimalController.tryMountAnimal(player: THREE.Object3D, playerPosition: THREE.Vector3, animal: AnimalController | null, getCameraController: () => CameraController | null, playerController?: any): boolean
PlayerAnimalController.setOnCameraRestoredCallback(callback: (camera: CameraController | null) => void): void
PlayerAnimalController.handleDismountRequest(player: THREE.Object3D, playerBody: RAPIER.RigidBody | null, characterHeight: number, onCameraRestored: (camera: CameraController | null) => void, playerController?: any): void
PlayerAnimalController.update(deltaTime: number): void
PlayerAnimalController.dismountCurrentAnimal(): void
PlayerAnimalController.isPlayerRidingAnimal(): boolean
PlayerAnimalController.dispose(): void

## engine/animal/PlayerRidingAnimalMovement.ts
class PlayerRidingAnimalMovement implements IPlayerMovement — Movement system for when the player is riding an animal.
PlayerRidingAnimalMovement.setMountedAnimal(animal: AnimalController | null): void
PlayerRidingAnimalMovement.getMountedAnimal(): AnimalController | null
PlayerRidingAnimalMovement.setCameraController(camera: { getHorizontalAngle: () => number; getForwardVector: () => THREE.Vector3; getRightVector: () => THREE.Vector3 } | null): void
PlayerRidingAnimalMovement.update(deltaTime: number, playerController: PlayerController, keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; interact: boolean; action: boolean; descend: boolean }, isGrounded: boolean, moveDirection: THREE.Vector3, playerBody: RAPIER.RigidBody, physicsWorld: PhysicsWorld): void
PlayerRidingAnimalMovement.getCurrentSpeed(): number
PlayerRidingAnimalMovement.isInAir(): boolean
PlayerRidingAnimalMovement.getRotation(): number
PlayerRidingAnimalMovement.setRotation(rotation: number): void
PlayerRidingAnimalMovement.reset(): void
PlayerRidingAnimalMovement.getAscendDisplayName(): string
PlayerRidingAnimalMovement.getDescendDisplayName(): string
PlayerRidingAnimalMovement.getSupportedKeys(): { ascend: boolean; descend: boolean }
PlayerRidingAnimalMovement.getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' }
PlayerRidingAnimalMovement.shouldShowPlayer(): boolean
PlayerRidingAnimalMovement.getMoveSpeed(): number
PlayerRidingAnimalMovement.setMoveSpeed(_speed: number): void

## engine/animal/SkeletonAnimalLoader.ts
interface SkeletonAnimalConfig — Configuration for an animal's block appearance attached to skeleton
SkeletonAnimalConfig.name: string
SkeletonAnimalConfig.glbUrl: string
SkeletonAnimalConfig.animations: string[]
SkeletonAnimalConfig.bodyColor: number
SkeletonAnimalConfig.headColor?: number
SkeletonAnimalConfig.legColor?: number
SkeletonAnimalConfig.tailColor?: number
SkeletonAnimalConfig.accentColor?: number
SkeletonAnimalConfig.scale?: number
SkeletonAnimalConfig.bodyScale?: { x: number; y: number; z: number }
SkeletonAnimalConfig.headScale?: { x: number; y: number; z: number }
SkeletonAnimalConfig.legScale?: { x: number; y: number; z: number }
SkeletonAnimalConfig.boneMapping?: { root?: string; spine?: string[]; head?: string; tail?: string[]; frontLeftLeg?: string[]; frontRightLeg?: string[]; backLeftLeg?: string[]; backRightLeg?: string[]; }
type SkeletonBase = 'chicken' | 'deer' | 'dog' | 'horse' | 'kitty' | 'pinguin' | 'tiger'
function findBestSkeletonBase(animalType: string): SkeletonBase
function getSkeletonGlbUrl(skeleton: SkeletonBase, baseUrl?: string): string
const SKELETON_ANIMAL_PRESETS: Record<string, Partial<SkeletonAnimalConfig>>
interface SkeletonAnimalInstance — Result of loading a skeleton animal
SkeletonAnimalInstance.root: THREE.Group
SkeletonAnimalInstance.skeleton: THREE.Object3D
SkeletonAnimalInstance.mixer: THREE.AnimationMixer
SkeletonAnimalInstance.animations: Map<string, THREE.AnimationClip>
SkeletonAnimalInstance.currentAction: THREE.AnimationAction | null
SkeletonAnimalInstance.blockMeshes: THREE.Mesh[]
SkeletonAnimalInstance.playAnimation: (name: string, options?: { loop?: boolean; crossFade?: number }) => void
SkeletonAnimalInstance.update: (deltaTime: number) => void
SkeletonAnimalInstance.dispose: () => void
function loadSkeletonAnimal(loader: any, config: SkeletonAnimalConfig): Promise<SkeletonAnimalInstance>
function getSkeletonAnimalPreset(animalType: string): Partial<SkeletonAnimalConfig>
function createSkeletonAnimalConfig(animalDef: { name: string; glbUrl: string; animations: string[] }, presetOverrides?: Partial<SkeletonAnimalConfig>): SkeletonAnimalConfig
function createAnimalConfigFromType(animalType: string, baseUrl: string = 'https://mini.bitmagic.ai/worlds/v3/animations/animals', overrides?: Partial<SkeletonAnimalConfig>): SkeletonAnimalConfig

## engine/animal/SnakeAnimationController.ts
enum SnakeAnimationState { IDLE, SLITHER, FAST }
interface SnakeTerrainConformOptions — Ground sampling callback for terrain conforming (idle animation only)
SnakeTerrainConformOptions.sampleGroundY: (worldX: number, worldZ: number) => number | null
interface WaveParams
WaveParams.amplitude: number
WaveParams.frequency: number
WaveParams.speed: number
interface SnakeBodyParts — Snapshot of the snake's body part references.
SnakeBodyParts.head: THREE.Object3D | null
SnakeBodyParts.segments: THREE.Object3D[]
SnakeBodyParts.tail: THREE.Object3D | null
SnakeBodyParts.tongue: THREE.Object3D | null
class SnakeAnimationController
SnakeAnimationController.setTerrainConform(options: SnakeTerrainConformOptions | null): void
SnakeAnimationController.getBodyParts(): SnakeBodyParts
SnakeAnimationController.getHead(): THREE.Object3D | null
SnakeAnimationController.getTail(): THREE.Object3D | null
SnakeAnimationController.getTongue(): THREE.Object3D | null
SnakeAnimationController.getSegments(): THREE.Object3D[]
SnakeAnimationController.getSegment(index: number): THREE.Object3D | null
SnakeAnimationController.getSegmentCount(): number
SnakeAnimationController.setWaveParams(state: SnakeAnimationState, params: Partial<WaveParams>): void
SnakeAnimationController.getWaveParams(state: SnakeAnimationState): Readonly<WaveParams>
SnakeAnimationController.setTotalLength(newLength: number): void
SnakeAnimationController.initializeWithCharacter(character: THREE.Object3D, _gltf: unknown, _loader: unknown, _baseAnimations: unknown[]): Promise<void>
SnakeAnimationController.updateAnimation(isMoving: boolean, movementSpeed: number, _isGrounded: boolean, _isJumpPressed: boolean): void
SnakeAnimationController.dispose(): void
SnakeAnimationController.update(deltaTime: number): void

## engine/animal/SnakeBodyBuilder.ts
interface SnakeConfig — Configuration for creating a voxel-block snake.
SnakeConfig.segmentCount?: number
SnakeConfig.headColor: number
SnakeConfig.bodyColor: number
SnakeConfig.bellyColor?: number
SnakeConfig.patternColor?: number
SnakeConfig.patternType?: 'none' | 'stripes' | 'diamonds' | 'zigzag'
SnakeConfig.bodyThickness?: number
SnakeConfig.totalLength?: number
SnakeConfig.headSize?: { width: number; height: number; depth: number }
SnakeConfig.eyes?: AnimalEyeConfig
SnakeConfig.scale?: number
SnakeConfig.moveSpeed?: number
SnakeConfig.terrainFollowSmoothing?: number
SnakeConfig.terrainFollowMaxSpeed?: number
interface SnakeDimensions — Resolved dimensions returned after building, used by the controller.
SnakeDimensions.width: number
SnakeDimensions.height: number
SnakeDimensions.depth: number
SnakeDimensions.segmentSpacing: number
SnakeDimensions.segmentCount: number
class SnakeBodyBuilder
static SnakeBodyBuilder.buildSnake(characterGroup: THREE.Group, config: SnakeConfig): SnakeDimensions
function createSnakeFactory(config: SnakeConfig): IBlockCharacterFactory & { snakeDimensions?: SnakeDimensions }

## engine/animal/SnakeController.ts
interface CreateSnakeOptions — Options for {@link createSnake} factory.
CreateSnakeOptions.damageConfig?: Partial<DamageableConfig>
CreateSnakeOptions.importance?: 'hero' | 'crowd'
interface SnakeConfigOptions — Configuration options for the fluent {@link SnakeController.configure} API.
SnakeConfigOptions.oneHitKill?: boolean
SnakeConfigOptions.maxHealth?: number
SnakeConfigOptions.debrisLifetimeMs?: number
SnakeConfigOptions.explodeOnDeath?: boolean
SnakeConfigOptions.ragdollOnDeath?: boolean
SnakeConfigOptions.bloodOnHit?: boolean
SnakeConfigOptions.bloodConfig?: BloodSplatterConfig
SnakeConfigOptions.explodeWithGore?: boolean
SnakeConfigOptions.goreConfig?: DeathExplosionConfig
SnakeConfigOptions.onDeath?: (killerDirection?: THREE.Vector3) => void
class SnakeController implements Interactable, IDamageable, ChunkManagedObject, ICharacterContext
SnakeController.isGrounded
SnakeController.voxelBlockSize
SnakeController.lodState: CharacterLodState
SnakeController.get onDamage()
SnakeController.set onDamage(cb: ((damage: number, currentHealth: number, maxHealth: number, source?: string) => void) | undefined)
SnakeController.get onDeathEffect()
SnakeController.set onDeathEffect(cb: ((killerDirection?: THREE.Vector3) => void) | undefined)
SnakeController.onMeleeHitEffect: (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void
SnakeController.onProjectileHitEffect: (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void
SnakeController.onMeleeHit: (impactDirection?: THREE.Vector3, impulseStrength?: number) => void
static SnakeController.create(scene: THREE.Scene, physicsWorld: PhysicsWorld, engine: EngineLike, spawnPosition: THREE.Vector3, snakeName: string, config: SnakeConfig, options?: CreateSnakeOptions): Promise<SnakeController>
SnakeController.update(deltaTime: number): void
SnakeController.setBehavior(b: INpcBehavior): void
SnakeController.requestBehaviorChange(b: INpcBehavior): void
SnakeController.shatterIntoVoxels(): boolean
SnakeController.setTargetPosition(t: THREE.Vector3 | null, maxPathLength?: number): void
SnakeController.getEngine(): EngineLike
SnakeController.getNavMesh(): LegacyNavMesh | null
SnakeController.getPosition(): THREE.Vector3
SnakeController.getCharacter(): THREE.Object3D
SnakeController.getPhysicsWorld(): PhysicsWorld
SnakeController.getPhysicsBody(): RAPIER.RigidBody | null
SnakeController.getSnakeName(): string
SnakeController.isStunned(): boolean
SnakeController.getMoveSpeed(): number
SnakeController.getCurrentSpeed(): number
SnakeController.getPath(): THREE.Vector3[]
SnakeController.getCurrentWaypointIndex(): number
SnakeController.getCurrentWaypoint(): THREE.Vector3 | null
SnakeController.isFollowingPath(): boolean
SnakeController.hasReachedDestination(): boolean
SnakeController.getExplodedDebris(): { mesh: THREE.Mesh; body: RAPIER.RigidBody }[]
SnakeController.removeDebrisPiece(mesh: THREE.Mesh): boolean
SnakeController.setArrivalRadius(radius: number): void
SnakeController.getArrivalRadius(): number
SnakeController.setAvoidanceEnabled(enabled: boolean): void
SnakeController.isAvoidanceEnabled(): boolean
SnakeController.setStraightLinePath(enabled: boolean): void
SnakeController.isStraightLinePath(): boolean
SnakeController.setMoveSpeed(speed: number): void
SnakeController.setMaxStepUpHeight(h: number): void
SnakeController.getMaxStepUpHeight(): number
SnakeController.setStepHopEnabled(e: boolean): void
SnakeController.isStepHopEnabled(): boolean
SnakeController.setRotationSpeed(r: number): void
SnakeController.getRotationSpeed(): number
SnakeController.get player(): THREE.Object3D
SnakeController.get characterHeight(): number
SnakeController.get capsuleRadius(): number
SnakeController.get externallyControlsVerticalFeet(): boolean
SnakeController.holdPhysicsUntilReady(): void
SnakeController.releasePhysics(): void
SnakeController.setAlwaysActive(a: boolean): void
SnakeController.isAlwaysActive(): boolean
SnakeController.canHibernate(): boolean
SnakeController.hibernate(): void
SnakeController.wake(): void
SnakeController.isHibernating(): boolean
SnakeController.setImportance(importance: 'hero' | 'crowd'): void
SnakeController.getImportance(): 'hero' | 'crowd'
SnakeController.hasActiveGoal(): boolean
SnakeController.isDeadOrRagdolled(): boolean
SnakeController.onInteractStart(): boolean
SnakeController.getInteractStartDisplayName(): string
SnakeController.interactionEnabled(): boolean
SnakeController.defaultMeleeHitHandler(impactDirection?: THREE.Vector3, impulseStrength = 6): void
SnakeController.onProjectileCollision(projectile: { getDamage?: () => number; getDirection?: () => THREE.Vector3; getKnockback?: () => number }): void
SnakeController.takeDamage(amount: number, source?: string, deathImpulse?: THREE.Vector3): void
SnakeController.isExploded(): boolean
SnakeController.isDead(): boolean
SnakeController.isRagdolled(): boolean
SnakeController.hasRagdoll(): boolean
SnakeController.getHealth(): number
SnakeController.getMaxHealth(): number
SnakeController.setMaxHealth(maxHealth: number): void
SnakeController.heal(amount: number): boolean
SnakeController.resetHealth(): void
SnakeController.setDamageFlashEnabled(e: boolean): void
SnakeController.getDamageFlash(): import('engine/effects/DamageFlash.js').DamageFlash | null
SnakeController.setDebrisLifetime(ms: number): void
SnakeController.setStunDuration(seconds: number): void
SnakeController.setCorpseLifetimeMs(ms: number): void
SnakeController.configure(options: SnakeConfigOptions): this
SnakeController.getBodyParts(): SnakeBodyParts
SnakeController.getHead(): THREE.Object3D | null
SnakeController.getTail(): THREE.Object3D | null
SnakeController.getTongue(): THREE.Object3D | null
SnakeController.getSegments(): THREE.Object3D[]
SnakeController.getSegment(index: number): THREE.Object3D | null
SnakeController.getSegmentCount(): number
SnakeController.setTotalLength(length: number): void
SnakeController.setWaveParams(state: SnakeAnimationState, params: Partial<WaveParams>): void
SnakeController.getWaveParams(state: SnakeAnimationState): Readonly<WaveParams>
SnakeController.dispose(): void
function createSnake(scene: THREE.Scene, physicsWorld: PhysicsWorld, engine: EngineLike, spawnPosition: THREE.Vector3, snakeName: string, config: SnakeConfig, options?: CreateSnakeOptions): Promise<SnakeController>

## engine/animal/VoxelAnimalRegistry.ts
interface ResolvedVoxelAnimal — A resolved voxel body: which GLB to load and whether it's an aquatic fish.
ResolvedVoxelAnimal.file: string
ResolvedVoxelAnimal.isFish: boolean
function resolveVoxelAnimal(animalType: string): ResolvedVoxelAnimal | null
function resolveVoxelAnimalFile(animalType: string): string | null

## engine/animal/voxelAnimalFiles.ts
const VOXEL_ANIMAL_FILES: string[]

## engine/animal/voxelFishFiles.ts
const VOXEL_FISH_FILES: string[]
