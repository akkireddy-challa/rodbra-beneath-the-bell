# engine-api-character

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/AgentAvoidance.ts
enum AgentPriority { ANIMAL, NPC, PLAYER, VEHICLE }
interface AgentAvoidanceOptions
AgentAvoidanceOptions.queryRadius: number
AgentAvoidanceOptions.timeHorizon: number
AgentAvoidanceOptions.safetyPadding: number
AgentAvoidanceOptions.maxDeflection: number
AgentAvoidanceOptions.yieldDeflectionMultiplier: number
AgentAvoidanceOptions.holdDeflectionMultiplier: number
AgentAvoidanceOptions.yieldSpeedMultiplier: number
AgentAvoidanceOptions.yieldSlowdownWindow: number
const DEFAULT_AGENT_AVOIDANCE_OPTIONS: AgentAvoidanceOptions
interface AgentSteerInput — Input snapshot for a single steering query.
AgentSteerInput.bodyHandle: number
AgentSteerInput.position: THREE.Vector3
AgentSteerInput.desiredDirection: THREE.Vector3
AgentSteerInput.targetSpeed: number
AgentSteerInput.radius: number
AgentSteerInput.priority: AgentPriority
interface AgentSteerResult
AgentSteerResult.steeredDirection: THREE.Vector3
AgentSteerResult.speedScale: number
class AgentAvoidanceSystem
AgentAvoidanceSystem.constructor(options: AgentAvoidanceOptions = DEFAULT_AGENT_AVOIDANCE_OPTIONS)
AgentAvoidanceSystem.setOptions(options: AgentAvoidanceOptions): void
AgentAvoidanceSystem.getOptions(): AgentAvoidanceOptions
AgentAvoidanceSystem.steer(physicsWorld: PhysicsWorld, agent: AgentSteerInput, navMesh?: VoxelNavMesh | null): AgentSteerResult
function setGlobalAgentAvoidance(system: AgentAvoidanceSystem): void
function getGlobalAgentAvoidance(): AgentAvoidanceSystem | null

## engine/CharacterConfig.ts
const CHARACTER_CONFIG = { /** * Complete character model URL (includes mesh and all
interface AnimationConfig — Animation config type with merged values
AnimationConfig.idleAnimationName: string
AnimationConfig.runAnimationName: string
AnimationConfig.jumpAnimationName: string
AnimationConfig.runSpeed: number
AnimationConfig.transitionDuration: number
interface CharacterConfigOverrides — CharacterConfig from worldProfileData (optional speed overrides)
CharacterConfigOverrides.runSpeed?: number
function getDefaultCharacterUrl(): string
function getDefaultCharacterFallbackUrl(): string
function getSkeletonHeight(): number
function getSkinnedNpcHeight(): number
function getDefaultAnimationConfig()
function mergeCharacterConfig(overrides?: CharacterConfigOverrides): AnimationConfig
function scaleCharacterToHeight(character: THREE.Object3D, currentCharacterHeight: number, targetHeight: number, logPrefix: string = ''): number

## engine/DonaldDuckExampleCharacter.ts
const DONALD_DUCK_CONFIG = { targetHeight: 1.3, // meters }
function applyDonaldDuckModifications(player: THREE.Object3D, playerController: any, playerLoader: any, blockCharacterBuilder: any): void
function createDonaldDuckBlockCharacter(characterGroup: THREE.Group)

## engine/ExampleAnimalManager.ts
interface ExampleAnimalManagerConfig — Configuration options for this manager
ExampleAnimalManagerConfig.animalTypes?: string[]
ExampleAnimalManagerConfig.countPerType?: number
ExampleAnimalManagerConfig.worldBounds?: number
ExampleAnimalManagerConfig.oneHitKill?: boolean
ExampleAnimalManagerConfig.bloodEffects?: boolean
ExampleAnimalManagerConfig.deathExplosion?: boolean
class ExampleAnimalManager — Example manager that creates and manages a herd of animals.
ExampleAnimalManager.constructor(engine: EngineLike, config?: ExampleAnimalManagerConfig)
ExampleAnimalManager.spawnAll(): Promise<void>
ExampleAnimalManager.update(deltaTime: number): void
ExampleAnimalManager.dispose(): void
ExampleAnimalManager.getRegistry(): AnimalRegistry
ExampleAnimalManager.addAnimalConfig(name: string, config: BlockAnimalBodyConfig): void

## engine/ExampleEnemyCharacter.ts
function createExampleEnemyCharacter(characterGroup: THREE.Group): { width: number; height: number; depth: number }

## engine/IBlockCharacterFactory.ts
interface IBlockCharacterFactory — Interface for template-provided block character factory
IBlockCharacterFactory.createBlockCharacter(characterGroup: THREE.Group): void
IBlockCharacterFactory.getCharacterDimensions(): { width: number; height: number; depth: number }
IBlockCharacterFactory.getLocomotionMode?(): 'ground' | 'swim' | 'fly'
function isBlockCharacterFactory(obj: unknown): obj is IBlockCharacterFactory

## engine/IPlayerMovement.ts
interface PlayerMovementKeys — The per-frame input state passed to {@link IPlayerMovement.update}. This is the
PlayerMovementKeys.forward: boolean
PlayerMovementKeys.backward: boolean
PlayerMovementKeys.left: boolean
PlayerMovementKeys.right: boolean
PlayerMovementKeys.ascend: boolean
PlayerMovementKeys.interact: boolean
PlayerMovementKeys.action: boolean
PlayerMovementKeys.secondaryAction?: boolean
PlayerMovementKeys.descend: boolean
interface PlayerPhysicsConfig — The walking physics tuning read and replaced through
PlayerPhysicsConfig.gravity: number
PlayerPhysicsConfig.terminalVelocity: number
PlayerPhysicsConfig.jumpHeight: number
PlayerPhysicsConfig.airControlMultiplier: number
PlayerPhysicsConfig.groundFriction: number
PlayerPhysicsConfig.airFriction: number
interface IPlayerMovement — Interface for pluggable player movement systems
IPlayerMovement.update( deltaTime: number, playerController: PlayerController, keys: PlayerMovementKeys, isGrounded: boolean, moveDirection: THREE.Vector3, playerBody: RAPIER.RigidBody, physicsWorld: PhysicsWorld ): void
IPlayerMovement.getCurrentSpeed(): number
IPlayerMovement.isInAir(): boolean
IPlayerMovement.getRotation(): number
IPlayerMovement.reset(): void
IPlayerMovement.getAscendDisplayName(): string
IPlayerMovement.getDescendDisplayName(): string
IPlayerMovement.getSupportedKeys(): { ascend: boolean; descend: boolean; }
IPlayerMovement.getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous'; }
IPlayerMovement.shouldShowPlayer(): boolean
IPlayerMovement.handlesPlayerPositionSync?(): boolean
IPlayerMovement.setGroundFriction?(friction: number): void
IPlayerMovement.wasGroundedLastUpdate?(): boolean
IPlayerMovement.setCameraLockRotation?(enabled: boolean): void
IPlayerMovement.setCameraController?(camera: { getHorizontalAngle: () => number } | null): void
IPlayerMovement.setRotation?(rotation: number): void
IPlayerMovement.setFacingLock?(yaw: number | null): void
IPlayerMovement.getPhysicsConfig?(): PlayerPhysicsConfig
IPlayerMovement.setPhysicsConfig?(config: PlayerPhysicsConfig): void
IPlayerMovement.getMoveSpeed(): number
IPlayerMovement.setMoveSpeed(speed: number): void
IPlayerMovement.shouldPlayLocomotionAnimation?(): boolean
IPlayerMovement.getGroundRelativeSpeed?(): number
IPlayerMovement.getRenderPosition?(): THREE.Vector3 | null
IPlayerMovement.applyImpulse?(velocity: { x: number; y?: number; z: number }): void
IPlayerMovement.controlsBodyRotation?(): boolean
IPlayerMovement.getJumpCount?(): number
IPlayerMovement.isGravityEnabled?(): boolean
IPlayerMovement.setGravityEnabled?(enabled: boolean): void
IPlayerMovement.resetVerticalVelocity?(): void
IPlayerMovement.onAttached?(playerController: PlayerController): void
IPlayerMovement.onDetached?(playerController: PlayerController): void

## engine/LegacyNavMesh.ts
class LegacyNavMesh
LegacyNavMesh.constructor(engine: EngineLike)
LegacyNavMesh.findPath(start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3[]

## engine/PathConflictAvoidance.ts
interface PathConflictAvoidanceOptions — Engine-wide system that prevents NPC-vs-NPC path conflicts by injecting
PathConflictAvoidanceOptions.scanLookaheadSeconds: number
PathConflictAvoidanceOptions.maxScanDistance: number
PathConflictAvoidanceOptions.minScanDistance: number
PathConflictAvoidanceOptions.sampleSpacing: number
PathConflictAvoidanceOptions.obstacleTtlSeconds: number
PathConflictAvoidanceOptions.safetyPadding: number
PathConflictAvoidanceOptions.agentsScannedPerTick: number
PathConflictAvoidanceOptions.replanMovementThreshold: number
const DEFAULT_PATH_CONFLICT_OPTIONS: PathConflictAvoidanceOptions
interface PathScannerAgent — Self-describing interface an NPC/animal/vehicle registers with the
PathScannerAgent.bodyHandle: number
PathScannerAgent.position: THREE.Vector3
PathScannerAgent.radius: number
PathScannerAgent.getPath(): ReadonlyArray<THREE.Vector3>
PathScannerAgent.getCurrentWaypointIndex(): number
PathScannerAgent.getMoveSpeed(): number
PathScannerAgent.replanWithExtras(extras: ReadonlyArray<{ x: number; z: number; radius: number }>): void
interface VirtualObstacleDebugInfo — Debug-visualization snapshot of one active temp obstacle.
VirtualObstacleDebugInfo.handle: number
VirtualObstacleDebugInfo.x: number
VirtualObstacleDebugInfo.y: number
VirtualObstacleDebugInfo.z: number
VirtualObstacleDebugInfo.radius: number
VirtualObstacleDebugInfo.remainingFraction: number
class PathConflictAvoidanceSystem
PathConflictAvoidanceSystem.constructor(options: PathConflictAvoidanceOptions = DEFAULT_PATH_CONFLICT_OPTIONS)
PathConflictAvoidanceSystem.setOptions(options: PathConflictAvoidanceOptions): void
PathConflictAvoidanceSystem.getOptions(): PathConflictAvoidanceOptions
PathConflictAvoidanceSystem.register(agent: PathScannerAgent): void
PathConflictAvoidanceSystem.unregister(bodyHandle: number): void
PathConflictAvoidanceSystem.registerStaticBlocker(bodyHandle: number, livePosition: THREE.Vector3, getRadius: () => number): void
PathConflictAvoidanceSystem.tick(deltaTime: number, physicsWorld: PhysicsWorld): void
PathConflictAvoidanceSystem.getActiveExtrasForAgent(selfHandle: number): { x: number; z: number; radius: number }[]
PathConflictAvoidanceSystem.getActiveVirtualObstacles(): VirtualObstacleDebugInfo[]
function setGlobalPathConflictAvoidance(system: PathConflictAvoidanceSystem | null): void
function getGlobalPathConflictAvoidance(): PathConflictAvoidanceSystem | null

## engine/PlayerController.ts
interface CameraController
CameraController.getForwardVector: () => THREE.Vector3
CameraController.getRightVector: () => THREE.Vector3
CameraController.getCamera: () => THREE.PerspectiveCamera
CameraController.setTarget?: (target: THREE.Object3D) => void
interface VehicleCameraConfig — Tuning knobs for the driving camera. Every field is optional — callers set
VehicleCameraConfig.distance?: number
VehicleCameraConfig.height?: number
VehicleCameraConfig.lookAtHeight?: number
VehicleCameraConfig.followSpeed?: number
VehicleCameraConfig.positionSmoothness?: number
class PlayerController — PlayerController - Main player character controller
PlayerController.player: THREE.Object3D
PlayerController.playerBody: RAPIER.RigidBody
PlayerController.physicsWorld: PhysicsWorld
PlayerController.cameraController: CameraController | null
PlayerController.engine: EngineLike | null
PlayerController.maxSlope: number
PlayerController.stepHeight: number
PlayerController.keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; interact: boolean; action: boolean; secondaryAction: boolean; descend: boolean; [customAction: string]: boolean }
PlayerController.isGrounded: boolean
PlayerController.velocity: THREE.Vector3
PlayerController.moveDirection: THREE.Vector3
PlayerController.raycaster: THREE.Raycaster
PlayerController.raycastOrigin: THREE.Vector3
PlayerController.downVector: THREE.Vector3
PlayerController.characterHeight: number
PlayerController.startPosition: THREE.Vector3
PlayerController.fadeOverlay: FadeOverlay | null
PlayerController.animationController: ICharacterAnimationController | null
PlayerController.onFallRescue: ((event: FallRescueEvent) => boolean | void) | null
PlayerController.capsuleRadius: number
PlayerController.voxelBlockSize: number
PlayerController.playerLoader: PlayerLoader | null
PlayerController.onPlayerChanged: ((newPlayer: THREE.Object3D) => void) | null
PlayerController.onEnemyProjectileHit: (() => void) | null
PlayerController.onHealthChanged: ((current: number, max: number) => void) | null
PlayerController.onPlayerDeath: (() => void) | null
PlayerController.addDeathListener(listener: () => void): () => void
PlayerController.hud: IGameHUD | null
PlayerController.analogMoveX: number
PlayerController.analogMoveY: number
PlayerController.useAnalogMovement: boolean
PlayerController.actionType: string | null
PlayerController.secondaryActionType: string | null
PlayerController.constructor(player: THREE.Object3D, playerBody: RAPIER.RigidBody, physicsWorld: PhysicsWorld, cameraController: CameraController, engine: EngineLike | null = null, physicsConfig: { gravity: number; terminalVelocity: number; jumpHeight: number; airControlMultiplier: number; groundFriction: number; airFriction: number; } = { gravity: -35.0, terminalVelocity: 53.0, jumpHeight: 2.2, airControlMultiplier: 0.5, groundFriction: 0.9, airFriction: 0.98 }, worldGenerator: (unknown & Partial<TerrainFrictionProvider>) | null = null, movementSystem?: IPlayerMovement, constants?: Partial<GameConstants>)
PlayerController.getMobileMovementControlsAvailable(): boolean
PlayerController.setMobileMovementControlsAvailable(value: boolean | null): void
PlayerController.setVehicleManager(vehicleManager: VehicleManager): void
PlayerController.setVehicleCameraMode(mode: VehicleCameraMode): void
PlayerController.setWeaponPickupManager(manager: WeaponPickupManager): void
PlayerController.setOnWeaponPickedUp(handler: (category: string, weaponType: string, pickup: import('engine/WeaponPickup.js').WeaponPickup) => void): void
PlayerController.getWeaponPickupManager(): WeaponPickupManager | null
PlayerController.setWeaponPickupManagerReference(manager: WeaponPickupManager | null): void
PlayerController.onCharacterReady(callback: () => void): void
PlayerController.fireCharacterReady(): void
PlayerController.addExternalDisplacement(delta: THREE.Vector3): void
PlayerController.consumeExternalDisplacement(out: THREE.Vector3): THREE.Vector3
PlayerController.setActionHandler(actionType: string | null, handler: ((player: THREE.Object3D, controller: PlayerController) => void) | null, options?: { continuous?: boolean }): void
PlayerController.setSecondaryActionHandler(actionType: string | null, handler: ((player: THREE.Object3D, controller: PlayerController) => void) | null): void
PlayerController.registerCustomAction(def: { action: string; /** Desktop binding. Omit (or pass an empty `keys` array) for a mobile-only action. */ desktop?: { keys: string[] }; mobile: { label: string; /** Optional image URL drawn instead of the label (which stays the accessible name). */ imageUrl?: string; /** Optional theme role selecting the button color. Defaults to 'primary'. */ role?: 'primary' | 'danger' | 'warning'; /** @deprecated Ignored — mobile buttons follow the UI theme via `role`. */ baseColor?: string; /** @deprecated Ignored — mobile buttons follow the UI theme via `role`. */ pressedColor?: string; behavior: 'tap' | 'continuous'; position?: MobileButtonPosition; initiallyHidden?: boolean; }; }): void
PlayerController.declareMobileActions(specs: MobileActionSpec[]): void
PlayerController.verifyMobileParity(): MobileParityResult
PlayerController.setCharacterHeight(height: number): void
PlayerController.setCapsuleDimensions(height: number, radius: number): void
PlayerController.setAnimationController(animationController: ICharacterAnimationController | null): void
PlayerController.setPlayerLoader(playerLoader: PlayerLoader): void
PlayerController.setOnPlayerChangedCallback(callback: (newPlayer: THREE.Object3D) => void): void
PlayerController.getWorldGenerator(): any | null
PlayerController.shouldProcessInput(): boolean
PlayerController.setControlsEnabled(enabled: boolean): void
PlayerController.getControlsEnabled(): boolean
PlayerController.getDesktopControls(): DesktopControls
PlayerController.getMobileControls(): MobileControls
PlayerController.getGamepadControls(): GamepadControls
PlayerController.setLidControlEnabled(enabled: boolean): void
PlayerController.setMobilePreviewMode(enabled: boolean, config?: Record<string, unknown>): void
PlayerController.getMobilePreviewMode(): boolean
PlayerController.getLastActiveInput(): 'keyboard' | 'gamepad' | 'mobile'
PlayerController.getInputLabel(action: 'interact' | 'action' | 'secondaryAction' | 'ascend' | 'descend' | 'exit'): string
PlayerController.reassertMovementContract(): void
PlayerController.applyKnockback(velocityX: number, velocityZ: number, upwardVelocity: number = 0): void
PlayerController.setMovementSystem(movementSystem: IPlayerMovement): void
PlayerController.markCurrentMovementSystemControlsAsShown(): void
PlayerController.enforceCharacterSeparation(): void
PlayerController.setAttackSystem(attackSystem: IPlayerAttack | null): void
PlayerController.getAttackSystem(): IPlayerAttack | null
PlayerController.setJumpInputSuppressed(suppressed: boolean): void
PlayerController.isJumpInputSuppressed(): boolean
PlayerController.setInteractionsSuppressed(suppressed: boolean): void
PlayerController.areInteractionsSuppressed(): boolean
PlayerController.suppressActionsFor(seconds: number, actions?: SuppressibleAction[]): void
PlayerController.setSlidingVFX(slidingVFX: ISlidingVFX | null): void
PlayerController.getSlidingVFX(): ISlidingVFX | null
PlayerController.setPlayerEnabled(enabled: boolean): void
PlayerController.isPlayerEnabled(): boolean
PlayerController.setCapsuleCollidersEnabled(enabled: boolean): void
PlayerController.setCapsuleBodyEnabled(enabled: boolean): void
PlayerController.setRagdollOnDeath(enabled: boolean): void
PlayerController.enterTemporaryRagdoll(hubVelocity?: THREE.Vector3): boolean
PlayerController.getTemporaryRagdollState(): { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; speed: number } | null
PlayerController.exitTemporaryRagdoll(): { x: number; y: number; z: number } | null
PlayerController.getMovementSystem(): IPlayerMovement
PlayerController.setCoverPeek(peek: boolean): void
PlayerController.tryGrabLedge(): boolean
PlayerController.mantle(): boolean
PlayerController.vault(): boolean
PlayerController.getUp(): boolean
PlayerController.slide(): boolean
PlayerController.setPosture(posture: Posture): boolean
PlayerController.getPosture(): Posture
PlayerController.setFacingLock(yaw: number | null): void
PlayerController.handlesPlayerPositionSync(): boolean
PlayerController.get rotation(): number
PlayerController.toggleGravity(): void
PlayerController.getGravityEnabled(): boolean
PlayerController.traverseVisibleCharacter(callback: (child: THREE.Object3D) => void): void
PlayerController.getVisibleMeshes(): THREE.Mesh[]
PlayerController.getVisibleCharacterRoot(): THREE.Object3D
PlayerController.getSkeleton(): THREE.Object3D
PlayerController.attachToBodyPart(object: THREE.Object3D, bodyPartName: string, rotation?: THREE.Vector3 | { x: number; y: number; z: number } | null): boolean
PlayerController.detachFromBodyPart(object: THREE.Object3D): void
PlayerController.getBodyPartObject(bodyPartName: string): THREE.Object3D | null
PlayerController.hasObjectAttachedToHand(): boolean
PlayerController.regroundCharacter(newHeight: number): void
PlayerController.update(deltaTime: number): void
PlayerController.onInteract(): boolean
PlayerController.onActionTriggered(): void
PlayerController.onSecondaryActionTriggered(): void
PlayerController.getProjectiles(): any[]
PlayerController.isMiningActive(): boolean
PlayerController.removeProjectile(projectile: any): void
PlayerController.calculateMoveDirection(): void
PlayerController.showInteractionPrompt(displayName: string, worldPosition?: THREE.Vector3, actionable: boolean = true, worldYOffset?: number): void
PlayerController.hideInteractionPrompt(): void
PlayerController.fadeOut(): Promise<void>
PlayerController.fadeIn(): Promise<void>
PlayerController.getSpawnPosition(): THREE.Vector3
PlayerController.respawn(position?: THREE.Vector3): Promise<void>
PlayerController.reviveAt(position: THREE.Vector3 = this.startPosition): void
PlayerController.prepareForSpectating(): void
PlayerController.performTeleport(respawnPosition: THREE.Vector3): void
PlayerController.hasInteractablesInScene(): boolean
PlayerController.isPlayerInVehicle(): boolean
PlayerController.enterVehicle(vehicle: Vehicle): boolean
PlayerController.exitVehicle(): boolean
PlayerController.switchVehicle(newVehicle: Vehicle): boolean
PlayerController.setVehicleExitLocked(locked: boolean): void
PlayerController.configureVehicleCamera(options: VehicleCameraConfig): void
PlayerController.isVehicleExitLocked(): boolean
PlayerController.getVehicleManager(): VehicleManager | null
PlayerController.getActiveVehicle(): any
PlayerController.getCameraController(): any
PlayerController.setCameraController(controller: CameraController): void
PlayerController.getPosition(): THREE.Vector3
PlayerController.getCurrentSpeed(): number
PlayerController.getGroundPosition(): THREE.Vector3
PlayerController.getCapsuleRadius(): number
PlayerController.getCapsuleHeight(): number
PlayerController.syncVisibleBody(): void
PlayerController.teleportTo(x: number, y: number, z: number, rotationY?: number): void
PlayerController.getPlayerObject(): THREE.Object3D | null
PlayerController.dispose(): void
PlayerController.configureFallRescue(options: FallRescueOptions): void
PlayerController.getFallRescueOptions(): FallRescueOptions
PlayerController.setVehicleRespawnProvider(provider: VehicleRespawnProvider | null): void
PlayerController.getPlayerHealth(): number
PlayerController.getPlayerMaxHealth(): number
PlayerController.isPlayerDead(): boolean
PlayerController.isPlayerRagdolled(): boolean
PlayerController.hasRagdoll(): boolean
PlayerController.setPlayerMaxHealth(maxHealth: number): void
PlayerController.setProjectileDamage(damage: number): void
PlayerController.takeDamage(amount: number, source?: string, deathImpulse?: THREE.Vector3): void
PlayerController.heal(amount: number): void
PlayerController.resetHealth(): void
PlayerController.setCorpseLifetimeMs(ms: number): void

## engine/PlayerToolSystem.ts
interface PlayerToolOptions — PlayerToolSystem — visual tool in the player's hand + looping swing
PlayerToolOptions.swingIntervalSec: number
PlayerToolOptions.hitRadius: number
PlayerToolOptions.facingDotThreshold: number
const DEFAULT_TOOL_OPTIONS: PlayerToolOptions
class PlayerToolSystem
PlayerToolSystem.constructor(engine: EngineLike, opts: PlayerToolOptions = DEFAULT_TOOL_OPTIONS)
PlayerToolSystem.equipTool(toolType: WeaponTypeId, controller: PlayerController): void
PlayerToolSystem.update(deltaTime: number): void
PlayerToolSystem.dispose(): void

## engine/PlayerVisibility.ts
type BodyPartSelector = string[] | 'all' | null
class PlayerVisibility — Single owner of the player character's visibility.
PlayerVisibility.hide(): void
PlayerVisibility.show(): void
PlayerVisibility.isManuallyHidden(): boolean
PlayerVisibility.reset(): void
PlayerVisibility.setSkeletonRoot(root: THREE.Object3D | null): void
PlayerVisibility.setBlockRoot(root: THREE.Object3D | null): void
PlayerVisibility.setHideReason(reason: string, hide: boolean): void
PlayerVisibility.hasHideReason(reason: string): boolean
PlayerVisibility.setHiddenBodyParts(reason: string, parts: BodyPartSelector): void
PlayerVisibility.setManualOverride(override: boolean | null): void
PlayerVisibility.getManualOverride(): boolean | null
PlayerVisibility.isVisible(): boolean

## engine/SpatialGrid.ts
class SpatialGrid<T> — Generic 2D spatial grid for efficient range queries.
SpatialGrid.constructor(cellSize: number)
SpatialGrid.clear(): void
SpatialGrid.insert(x: number, z: number, item: T): void
SpatialGrid.queryRadius(x: number, z: number, radius: number, out?: T[]): T[]
SpatialGrid.get activeCellCount(): number

## engine/SwimmingMovement.ts
class SwimmingMovement implements IPlayerMovement — Swimming movement implementation for underwater/diving gameplay
SwimmingMovement.constructor(moveSpeed: number = 4.0, swimAcceleration: number = 15.0, swimFriction: number = 0.85, maxVerticalSpeed: number = 6.0, pitchTransitionSpeed: number = 5.0)
SwimmingMovement.update(deltaTime: number, playerController: PlayerController, keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; interact: boolean; action: boolean; descend: boolean }, isGrounded: boolean, moveDirection: THREE.Vector3, playerBody: RAPIER.RigidBody, physicsWorld: PhysicsWorld): void
SwimmingMovement.getCurrentSpeed(): number
SwimmingMovement.isInAir(): boolean
SwimmingMovement.getRotation(): number
SwimmingMovement.setRotation(rotation: number): void
SwimmingMovement.reset(): void
SwimmingMovement.getAscendDisplayName(): string
SwimmingMovement.getDescendDisplayName(): string
SwimmingMovement.getSupportedKeys(): { ascend: boolean; descend: boolean }
SwimmingMovement.getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' }
SwimmingMovement.shouldShowPlayer(): boolean
SwimmingMovement.getMoveSpeed(): number
SwimmingMovement.setMoveSpeed(speed: number): void
SwimmingMovement.getSwimAcceleration(): number
SwimmingMovement.setSwimAcceleration(acceleration: number): void
SwimmingMovement.getSwimFriction(): number
SwimmingMovement.setSwimFriction(friction: number): void
SwimmingMovement.getMaxVerticalSpeed(): number
SwimmingMovement.setMaxVerticalSpeed(speed: number): void
SwimmingMovement.getPitchRotation(): number

## engine/TraversalChallengeSystem.ts
type ChallengeFeatureLike = ForgedLevelFeature
class TraversalChallengeSystem
TraversalChallengeSystem.constructor(engine: EngineLike)
TraversalChallengeSystem.update(deltaTime: number): void
TraversalChallengeSystem.dispose(): void
TraversalChallengeSystem.buildFromFeature(f: ChallengeFeatureLike): void

## engine/WalkingAndJumpingMovement.ts
interface DepenPos — A position the depenetration net reads or produces.
DepenPos.x: number
DepenPos.y: number
DepenPos.z: number
const DEPEN_REVERT_DIST = 1.5
const DEPEN_MAX_RISE = 1.5
const DEPEN_FRAME_RISE = 0.12
function resolveDepenetration(target: Readonly<DepenPos>, lastFree: Readonly<DepenPos> | null, lastFreeStillClear: boolean, riseUsed: number, deltaTime: number): { pos: DepenPos; riseUsed: number; moved: boolean }
const AUTHORED_STEP_HEIGHT_M = 0.65
const MAX_WORLD_STEP_HEIGHT_M = 1.25
function stepHeightForWorld(voxelBlockSize: number | undefined): number
class WalkingAndJumpingMovement implements IPlayerMovement
WalkingAndJumpingMovement.getRenderPosition(): THREE.Vector3 | null
WalkingAndJumpingMovement.maxStepHeight: number | null
WalkingAndJumpingMovement.enableStepClimbing: boolean
WalkingAndJumpingMovement.smoothBumpHeight: number
WalkingAndJumpingMovement.enableStuckDetection: boolean
WalkingAndJumpingMovement.constructor(moveSpeed: number = 5, physicsConfig: { gravity: number; terminalVelocity: number; jumpHeight: number; airControlMultiplier: number; groundFriction: number; airFriction: number; } = { gravity: -35.0, terminalVelocity: 53.0, jumpHeight: 2.2, airControlMultiplier: 0.5, groundFriction: 0.9, airFriction: 0.98 }, maxJumps: number = 1)
WalkingAndJumpingMovement.update(deltaTime: number, playerController: PlayerController, keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; interact: boolean; action: boolean; descend: boolean }, isGrounded: boolean, moveDirection: THREE.Vector3, playerBody: RAPIER.RigidBody, physicsWorld: PhysicsWorld): void
WalkingAndJumpingMovement.getCurrentSpeed(): number
WalkingAndJumpingMovement.isStepClimbing(): boolean
WalkingAndJumpingMovement.isInAir(): boolean
WalkingAndJumpingMovement.wasGroundedLastUpdate(): boolean
WalkingAndJumpingMovement.getGroundRelativeSpeed(): number
WalkingAndJumpingMovement.isGravityEnabled(): boolean
WalkingAndJumpingMovement.resetVerticalVelocity(): void
WalkingAndJumpingMovement.getRotation(): number
WalkingAndJumpingMovement.setRotation(rotation: number): void
WalkingAndJumpingMovement.reset(): void
WalkingAndJumpingMovement.applyImpulse(velocity: { x: number; y?: number; z: number }): void
WalkingAndJumpingMovement.setGravityEnabled(enabled: boolean): void
WalkingAndJumpingMovement.getPhysicsConfig(): typeof this.physicsConfig
WalkingAndJumpingMovement.setPhysicsConfig(config: typeof this.physicsConfig): void
WalkingAndJumpingMovement.getMoveSpeed(): number
WalkingAndJumpingMovement.setMoveSpeed(speed: number): void
WalkingAndJumpingMovement.getJumpCount(): number
WalkingAndJumpingMovement.getAcceleration(): number
WalkingAndJumpingMovement.setAcceleration(acceleration: number): void
WalkingAndJumpingMovement.getMaxJumps(): number
WalkingAndJumpingMovement.setMaxJumps(maxJumps: number): void
WalkingAndJumpingMovement.setGroundFriction(friction: number): void
WalkingAndJumpingMovement.getGroundFriction(): number
WalkingAndJumpingMovement.getAscendDisplayName(): string
WalkingAndJumpingMovement.getDescendDisplayName(): string
WalkingAndJumpingMovement.getSupportedKeys(): { ascend: boolean; descend: boolean }
WalkingAndJumpingMovement.getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' }
WalkingAndJumpingMovement.shouldShowPlayer(): boolean
WalkingAndJumpingMovement.setCameraLockRotation(enabled: boolean): void
WalkingAndJumpingMovement.setFacingLock(yaw: number | null): void
WalkingAndJumpingMovement.getFacingLock(): number | null
WalkingAndJumpingMovement.setCameraController(camera: { getHorizontalAngle: () => number } | null): void
WalkingAndJumpingMovement.getCameraLockRotation(): boolean

## engine/character/BlockExplosionComponent.ts
interface ExplosionConfig — Configuration for explosion behavior.
ExplosionConfig.blockSize: number
ExplosionConfig.forceMin: number
ExplosionConfig.forceMax: number
ExplosionConfig.debrisLifetimeMs?: number
ExplosionConfig.onBodyCreated?: (body: RAPIER.RigidBody) => void
interface ExplosionCallbacks — Callbacks for controller-specific explosion operations.
ExplosionCallbacks.getEngine(): EngineLike
ExplosionCallbacks.getPhysicsWorld(): PhysicsWorld
ExplosionCallbacks.getCharacter(): THREE.Object3D
ExplosionCallbacks.getPhysicsBody(): RAPIER.RigidBody | null
ExplosionCallbacks.collectMeshes(): THREE.Mesh[]
ExplosionCallbacks.onPostExplosion(): void
ExplosionCallbacks.restoreFlashImmediately(): void
class BlockExplosionComponent — BlockExplosionComponent - Manages death explosion into physics blocks.
BlockExplosionComponent.constructor(config: ExplosionConfig, callbacks: ExplosionCallbacks)
BlockExplosionComponent.setDebrisLifetimeMs(ms: number): void
BlockExplosionComponent.hasExplodedBlocks(): boolean
BlockExplosionComponent.getDebrisPieces(): { mesh: THREE.Mesh; body: RAPIER.RigidBody }[]
BlockExplosionComponent.removeDebrisPiece(mesh: THREE.Mesh): boolean
BlockExplosionComponent.explode(): void
BlockExplosionComponent.syncExplodedBlocks(): void
BlockExplosionComponent.dispose(physicsWorld: PhysicsWorld): void

## engine/character/CharacterBodyBounds.ts
function computeCharacterBodyBox(root: THREE.Object3D, out: THREE.Box3): THREE.Box3

## engine/character/CharacterLodScheduler.ts
enum SimClass { FULL, COARSE, VIRTUAL, HIBERNATED }
type LodRing = 0 | 1 | 2
type CharacterImportance = 'hero' | 'crowd'
interface CharacterLodState
CharacterLodState.ring: LodRing
CharacterLodState.distRing: LodRing
CharacterLodState.simClass: SimClass
CharacterLodState.tickAi: boolean
CharacterLodState.tickAnim: boolean
CharacterLodState.tickAvoidance: boolean
CharacterLodState.castShadow: boolean
CharacterLodState.onFrustum: boolean
interface LodManagedCharacter
LodManagedCharacter.getPosition(): THREE.Vector3
LodManagedCharacter.getImportance(): CharacterImportance
LodManagedCharacter.isDeadOrRagdolled(): boolean
LodManagedCharacter.hasActiveGoal(): boolean
LodManagedCharacter.lodState: CharacterLodState
LodManagedCharacter.onLodChanged?(prev: CharacterLodState, next: CharacterLodState): void
LodManagedCharacter.getLodDebugInfo?(): string
interface CharacterLodConfig — The scheduler's tuning. An explicit interface rather than `typeof DEFAULT_CHARACTER_LOD`,
CharacterLodConfig.r0DistanceM: number
CharacterLodConfig.r1DistanceM: number
CharacterLodConfig.hysteresisFraction: number
CharacterLodConfig.rates: { r0: { aiHz: number; animHz: number; avoidanceHz: number }; r1: { aiHz: number; animHz: number; avoidanceHz: number }; r2: { aiHz: number; animHz: number; avoidanceHz: number }; }
CharacterLodConfig.caps: { aiPerFrame: number; animPerFrame: number; avoidancePerFrame: number }
CharacterLodConfig.virtualOnFrustumHz: number
CharacterLodConfig.farEvalStaggerFrames: number
CharacterLodConfig.nearEvalDistanceM: number
CharacterLodConfig.boundingRadiusM: number
CharacterLodConfig.shadowMaxRing: LodRing
CharacterLodConfig.accumClampS: number
const DEFAULT_CHARACTER_LOD: CharacterLodConfig
function scaleCharacterLod(base: CharacterLodConfig, scale: number): CharacterLodConfig
const ALWAYS_FULL_LOD_STATE: CharacterLodState
interface CharacterLodStats
CharacterLodStats.total: number
CharacterLodStats.byRing: [number, number, number]
CharacterLodStats.bySimClass: { full: number; coarse: number; virtual: number; hibernated: number }
CharacterLodStats.aiGrantedLastFrame: number
CharacterLodStats.animGrantedLastFrame: number
CharacterLodStats.avoidanceGrantedLastFrame: number
CharacterLodStats.maxFramesSinceAiTick: number
class CharacterLodScheduler
CharacterLodScheduler.constructor(config: CharacterLodConfig = DEFAULT_CHARACTER_LOD)
CharacterLodScheduler.registerCharacter(c: LodManagedCharacter): void
CharacterLodScheduler.unregisterCharacter(c: LodManagedCharacter): void
CharacterLodScheduler.setConfig(config: CharacterLodConfig): void
CharacterLodScheduler.setEnabled(enabled: boolean): void
CharacterLodScheduler.isEnabled(): boolean
CharacterLodScheduler.evaluate(camera: THREE.Camera | null, deltaTime: number, playerPosition?: THREE.Vector3 | null): void
CharacterLodScheduler.getLastNavDrainMs(): number
CharacterLodScheduler.getStats(): CharacterLodStats
CharacterLodScheduler.getStatsLine(): string
CharacterLodScheduler.dumpStates(): string
function getGlobalLodScheduler(): CharacterLodScheduler
function disposeGlobalLodScheduler(): void

## engine/character/HealthComponent.ts
interface HealthCallbacks — Callbacks for controller-specific health/death operations.
HealthCallbacks.onPreDeath(): void
HealthCallbacks.onExplode(): void
HealthCallbacks.onRagdoll(deathImpulse?: THREE.Vector3): boolean | void
class HealthComponent — HealthComponent - Manages health, damage, death, and damage flash.
HealthComponent.onDamage: (damage: number, currentHealth: number, maxHealth: number, source?: string) => void
HealthComponent.onDeathEffect: (killerDirection?: THREE.Vector3) => void
HealthComponent.constructor(callbacks: HealthCallbacks, damageableConfig?: Partial<DamageableConfig>)
HealthComponent.initDamageFlash(root: THREE.Object3D): void
HealthComponent.takeDamage(amount: number, source?: string, deathImpulse?: THREE.Vector3): void
HealthComponent.isDead(): boolean
HealthComponent.isExploded(): boolean
HealthComponent.isRagdolled(): boolean
HealthComponent.markExploded(): void
HealthComponent.getHealth(): number
HealthComponent.getMaxHealth(): number
HealthComponent.setMaxHealth(maxHealth: number): void
HealthComponent.heal(amount: number): boolean
HealthComponent.resetHealth(): void
HealthComponent.getDamageableConfig(): Required<DamageableConfig>
HealthComponent.getDamageFlash(): DamageFlash | null
HealthComponent.setDamageFlashEnabled(enabled: boolean): void
HealthComponent.restoreFlashImmediately(): void
HealthComponent.disposeDamageFlash(): void

## engine/character/HibernationComponent.ts
interface HibernationCallbacks — Callbacks for controller-specific hibernate/wake physics operations.
HibernationCallbacks.onHibernate(): void
HibernationCallbacks.onWake(): void
class HibernationComponent — HibernationComponent - Manages chunk-based hibernation and physics hold state.
HibernationComponent.constructor(callbacks: HibernationCallbacks)
HibernationComponent.hibernate(): void
HibernationComponent.wake(): void
HibernationComponent.isHibernating(): boolean
HibernationComponent.holdPhysicsUntilReady(): void
HibernationComponent.releasePhysics(): void
HibernationComponent.isPhysicsHeld(): boolean
HibernationComponent.setAlwaysActive(active: boolean): void
HibernationComponent.isAlwaysActive(): boolean
HibernationComponent.setSimClass(simClass: SimClass): void
HibernationComponent.getSimClass(): SimClass

## engine/character/ICharacterContext.ts
interface ICharacterContext — Shared context interface that both NpcController and AnimalController implement.
ICharacterContext.getEngine(): EngineLike
ICharacterContext.getCharacter(): THREE.Object3D
ICharacterContext.getPhysicsBody(): RAPIER.RigidBody | null
ICharacterContext.getPhysicsWorld(): PhysicsWorld
ICharacterContext.getNavMesh(): LegacyNavMesh | null
ICharacterContext.getPosition(): THREE.Vector3
ICharacterContext.isStunned(): boolean
ICharacterContext.isDead(): boolean
ICharacterContext.isExploded(): boolean
ICharacterContext.getMoveSpeed(): number
ICharacterContext.setMoveSpeed(speed: number): void
ICharacterContext.setTargetPosition(target: THREE.Vector3 | null, maxPathLength?: number): void
ICharacterContext.requestBehaviorChange(newBehavior: INpcBehavior): void
ICharacterContext.shatterIntoVoxels(): boolean

## engine/character/NavigationComponent.ts
interface NavigationCallbacks — Callback interface for controller-specific movement operations.
NavigationCallbacks.getCharacter(): THREE.Object3D
NavigationCallbacks.getPhysicsBody(): RAPIER.RigidBody | null
NavigationCallbacks.getPhysicsWorld(): PhysicsWorld
NavigationCallbacks.getEngine(): EngineLike
NavigationCallbacks.getNavMesh(): LegacyNavMesh | null
NavigationCallbacks.isGrounded(): boolean
NavigationCallbacks.runMovementSystem(deltaTime: number, moveDirection: THREE.Vector3, shouldHop: boolean): void
NavigationCallbacks.getAgentRadius(): number
NavigationCallbacks.getAgentPriority(): AgentPriority
interface SpeedRampingConfig — Optional configuration for speed ramping (used by AnimalController).
SpeedRampingConfig.enabled: boolean
SpeedRampingConfig.getCharacterDepth?: () => number
class NavigationComponent — NavigationComponent - Handles path following, stuck detection, step-hop, and rotation.
NavigationComponent.constructor(moveSpeed: number, callbacks: NavigationCallbacks, speedRampingConfig?: SpeedRampingConfig)
NavigationComponent.setTargetPosition(target: THREE.Vector3 | null, extraObstacles?: ReadonlyArray<{ x: number; z: number; radius: number }>, maxPathLength?: number): void
NavigationComponent.setLodPriorityProvider(provider: (() => { hero: boolean; distSq: number }) | null): void
NavigationComponent.isPathPending(): boolean
NavigationComponent.setNavKey(key: string): void
NavigationComponent.dispose(): void
NavigationComponent.getCurrentTarget(): THREE.Vector3 | null
NavigationComponent.getPath(): THREE.Vector3[]
NavigationComponent.getCurrentWaypointIndex(): number
NavigationComponent.getCurrentWaypoint(): THREE.Vector3 | null
NavigationComponent.advanceWaypoint(): void
NavigationComponent.hasPath(): boolean
NavigationComponent.getStuckFrameCount(): number
NavigationComponent.setMoveSpeed(speed: number): void
NavigationComponent.getMoveSpeed(): number
NavigationComponent.getCurrentSpeed(): number
NavigationComponent.setArrivalRadius(radius: number): void
NavigationComponent.getArrivalRadius(): number
NavigationComponent.setAvoidanceEnabled(enabled: boolean): void
NavigationComponent.isAvoidanceEnabled(): boolean
NavigationComponent.setStraightLinePath(enabled: boolean): void
NavigationComponent.isStraightLinePath(): boolean
NavigationComponent.setMaxStepUpHeight(height: number): void
NavigationComponent.getMaxStepUpHeight(): number
NavigationComponent.setStepHopEnabled(enabled: boolean): void
NavigationComponent.isStepHopEnabled(): boolean
NavigationComponent.setRotationSpeed(radiansPerSecond: number): void
NavigationComponent.getRotationSpeed(): number
NavigationComponent.setOrchestratedFacing(enabled: boolean): void
NavigationComponent.updateIdle(deltaTime: number): boolean
NavigationComponent.updateStuck(): boolean
NavigationComponent.moveTowardTarget(deltaTime: number): void
NavigationComponent.smoothRotateTowards(targetRotation: number, deltaTime: number): void
NavigationComponent.stopMovement(): void
NavigationComponent.initializePreviousPosition(position: THREE.Vector3): void
NavigationComponent.updateNoPathApproach(deltaTime: number, animalRadius: number): void
NavigationComponent.isNoPathApproachBlocked(): boolean
NavigationComponent.hasStoppedShortOfTarget(): boolean
NavigationComponent.clearPath(): void

## engine/character/RagdollComponent.ts
interface RagdollPartSpec — One articulated segment of a ragdoll. `nodes` are the source visual groups whose blocks make up
RagdollPartSpec.name: string
RagdollPartSpec.parent: string | null
RagdollPartSpec.nodes: THREE.Object3D[]
RagdollPartSpec.jointType?: 'ball' | 'hinge'
interface RagdollConfig — Tuning for a ragdoll collapse. Required fields + exported defaults (see game/CLAUDE.md).
RagdollConfig.corpseLifetimeMs: number
RagdollConfig.jointLimits: boolean
RagdollConfig.selfCollision: boolean
RagdollConfig.onBodyCreated: ((body: RAPIER.RigidBody) => void) | null
const DEFAULT_RAGDOLL_CONFIG: RagdollConfig
interface SkinnedRagdollRig — Skinned-character mode: instead of cloning blocks and removing the GLB, KEEP the visible skinned
SkinnedRagdollRig.root: THREE.Object3D
SkinnedRagdollRig.resolveBone(partName: string): THREE.Object3D | null
interface RagdollCallbacks — Controller-specific operations the ragdoll needs (mirrors ExplosionCallbacks).
RagdollCallbacks.getEngine(): EngineLike
RagdollCallbacks.getPhysicsWorld(): PhysicsWorld
RagdollCallbacks.getCharacter(): THREE.Object3D
RagdollCallbacks.getPhysicsBody(): RAPIER.RigidBody | null
RagdollCallbacks.restoreFlashImmediately(): void
RagdollCallbacks.collectParts(): RagdollPartSpec[]
RagdollCallbacks.onPostRagdoll(): void
RagdollCallbacks.getSkinnedRig?(): SkinnedRagdollRig | null
class RagdollComponent — Collapses a block character into a limp jointed physics ragdoll on death — an alternative to
RagdollComponent.constructor(config: RagdollConfig, callbacks: RagdollCallbacks)
RagdollComponent.hasRagdoll(): boolean
RagdollComponent.getHubState(): { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; speed: number } | null
RagdollComponent.setCorpseLifetimeMs(ms: number): void
RagdollComponent.ragdoll(hubVelocity?: THREE.Vector3): boolean
RagdollComponent.usesSkinnedRig(): boolean
RagdollComponent.syncRagdoll(): void
RagdollComponent.dispose(physicsWorld: PhysicsWorld): void
function ragdollKnockback(direction: THREE.Vector3, speed: number): THREE.Vector3
function buildHumanoidRagdollParts(getBodyPart: (name: string) => THREE.Object3D | null): RagdollPartSpec[]
function buildAnimalRagdollParts(characterRoot: THREE.Object3D): RagdollPartSpec[]

## engine/character/SharedCharacterResources.ts
const SHARED_TEMPLATE_FLAG = '__sharedCharacterTemplate'
function isSharedCharacterResource(resource: FlaggableUserData | null | undefined): boolean
function markSharedCharacterResources(clone: THREE.Object3D): void
