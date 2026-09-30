# engine-api-ski

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/ski/NpcSkiHost.ts
class NpcSkiHost implements SkiMovementHost — Adapts an NPC's character to {@link SkiMovementHost} so AI riders run the
NpcSkiHost.player: THREE.Object3D
NpcSkiHost.playerBody: RAPIER.RigidBody
NpcSkiHost.physicsWorld: PhysicsWorld
NpcSkiHost.animationController: ICharacterAnimationController | null
NpcSkiHost.playerLoader: SkiMovementCharacter
NpcSkiHost.constructor(character: THREE.Object3D, characterBody: RAPIER.RigidBody, physicsWorld: PhysicsWorld, animationController: ICharacterAnimationController | null, characterLoader: CharacterLoader)
NpcSkiHost.getCameraController(): any
NpcSkiHost.enterTemporaryRagdoll(): boolean
NpcSkiHost.getTemporaryRagdollState(): null
NpcSkiHost.exitTemporaryRagdoll(): null

## engine/ski/NpcSkiMovement.ts
interface NpcSkiOptions — Options for an AI ski rider.
NpcSkiOptions.skill: Partial<SkiRiderSkill>
NpcSkiOptions.sprayMaxParticles: number
const DEFAULT_NPC_SKI_OPTIONS: NpcSkiOptions
class NpcSkiMovement extends SkiMovement — AI ski/snowboard rider. It runs the player's EXACT {@link SkiMovement} physics
NpcSkiMovement.constructor(_moveSpeed = 9, options?: Partial<NpcSkiOptions>)
NpcSkiMovement.onAttached(controller: SkiMovementHost): void
NpcSkiMovement.onDetached(_controller: SkiMovementHost): void
NpcSkiMovement.update(deltaTime: number, _controller: SkiMovementHost, _keys: PlayerMovementKeys, isGrounded: boolean, moveDirection: THREE.Vector3, playerBody: RAPIER.RigidBody, physicsWorld: PhysicsWorld): void

## engine/ski/SkiCameraDirector.ts
interface SkiDriveableCamera — Minimal camera surface the director drives. `driveOrbit` is required; the rest
SkiDriveableCamera.driveOrbit(theta: number, phi: number, radius?: number, snap?: boolean): void
SkiDriveableCamera.setChaseDamping?(opts: { horizontal: number; vertical: number; orbit: number } | null): void
SkiDriveableCamera.setCollideWithEnvironment?(enabled: boolean): void
SkiDriveableCamera.setFovOffset?(deltaDeg: number): void
SkiDriveableCamera.clearFovOffset?(): void
SkiDriveableCamera.applyShake?(intensity: number): void
interface SkiCameraFrame — Per-frame kinematics the director needs from the movement system.
SkiCameraFrame.mode: SkiCameraMode
SkiCameraFrame.velX: number
SkiCameraFrame.velZ: number
SkiCameraFrame.heading: number
SkiCameraFrame.slopeAngleDeg: number
class SkiCameraDirector
SkiCameraDirector.constructor(config: SkiConfig)
SkiCameraDirector.activate(cam: SkiDriveableCamera): void
SkiCameraDirector.reset(): void
SkiCameraDirector.registerImpact(intensity: number): void
SkiCameraDirector.deactivate(cam: SkiDriveableCamera): void
SkiCameraDirector.drive(cam: SkiDriveableCamera, deltaTime: number, frame: SkiCameraFrame): void

## engine/ski/SkiCameraMath.ts
type SkiCameraMode = 'grounded' | 'airborne' | 'wipeout'
interface SkiCameraConfig — Structural config subset the camera math reads (SkiConfig satisfies it).
SkiCameraConfig.cameraDistance: number
SkiCameraConfig.cameraDistanceSpeedGain: number
SkiCameraConfig.tuckMaxSpeed: number
SkiCameraConfig.cameraElevationBaseDeg: number
SkiCameraConfig.cameraElevationSlopeFactor: number
SkiCameraConfig.cameraElevationMaxDeg: number
SkiCameraConfig.cameraGroundSmoothTime: number
SkiCameraConfig.cameraHorizontalSmoothTime: number
SkiCameraConfig.cameraOrbitSmoothTime: number
SkiCameraConfig.cameraAirSmoothTime: number
SkiCameraConfig.cameraFovSpeedGainDeg: number
SkiCameraConfig.cameraAirElevationDeg: number
SkiCameraConfig.cameraAirDistanceGain: number
SkiCameraConfig.cameraWipeoutElevationDeg: number
SkiCameraConfig.cameraWipeoutDistanceGain: number
SkiCameraConfig.cameraWipeoutSmoothTime: number
interface SkiCameraInput
SkiCameraInput.mode: SkiCameraMode
SkiCameraInput.speed: number
SkiCameraInput.slopeAngleDeg: number
interface SkiCameraDamping — Chase smoothing this frame (seconds). `horizontal`/`vertical` are per-axis
SkiCameraDamping.horizontal: number
SkiCameraDamping.vertical: number
SkiCameraDamping.orbit: number
interface SkiCameraTargets
SkiCameraTargets.elevationDeg: number
SkiCameraTargets.phi: number
SkiCameraTargets.radius: number
SkiCameraTargets.fovGainDeg: number
SkiCameraTargets.damping: SkiCameraDamping
function skiCameraFovGain(speed: number, tuckMaxSpeed: number, maxGainDeg: number): number
function skiCameraDistance(base: number, speedGain: number, speed: number, tuckMaxSpeed: number, extraGainFrac: number): number
function computeSkiCameraTargets(input: SkiCameraInput, cfg: SkiCameraConfig): SkiCameraTargets

## engine/ski/SkiConfig.ts
interface SkiConfig — Configuration for the arcade ski movement system (engine/ski/).
SkiConfig.gravity: number
SkiConfig.terminalVelocity: number
SkiConfig.slopeAccelFactor: number
SkiConfig.baseDrag: number
SkiConfig.tuckDrag: number
SkiConfig.brakeDecel: number
SkiConfig.maxSpeed: number
SkiConfig.tuckMaxSpeed: number
SkiConfig.skatePushAccel: number
SkiConfig.skatePushMaxSpeed: number
SkiConfig.turnRateLowDeg: number
SkiConfig.turnRateHighDeg: number
SkiConfig.turnRampSec: number
SkiConfig.turnTapFactor: number
SkiConfig.gripRate: number
SkiConfig.gripRateLow: number
SkiConfig.gripRateHigh: number
SkiConfig.airDragK: number
SkiConfig.snowDragK: number
SkiConfig.tuckDragScale: number
SkiConfig.tuckPushAccel: number
SkiConfig.crouchDropMax: number
SkiConfig.jumpChargeDrop: number
SkiConfig.crouchTorsoPitchDeg: number
SkiConfig.crouchRampSec: number
SkiConfig.maxSpeedClamp: number
SkiConfig.liftoffStickMargin: number
SkiConfig.ballisticLiftoff: boolean
SkiConfig.launchVyMax: number
SkiConfig.launchNormalSmoothTime: number
SkiConfig.footProbeReach: number
SkiConfig.coyoteGroundDistance: number
SkiConfig.brakeGripRate: number
SkiConfig.carveSpeedBleed: number
SkiConfig.carveSkidBleed: number
SkiConfig.normalSmoothTime: number
SkiConfig.jumpSpeed: number
SkiConfig.airSteerRateDeg: number
SkiConfig.airDrag: number
SkiConfig.spinRateDeg: number
SkiConfig.landingAssistTime: number
SkiConfig.spawnSettleMaxDrop: number
SkiConfig.badLandingAngleDeg: number
SkiConfig.badLandingSpeedKeep: number
SkiConfig.carveLeanMaxDeg: number
SkiConfig.showEquipment: boolean
SkiConfig.showPoles: boolean
SkiConfig.equipmentStyle: 'ski' | 'snowboard'
SkiConfig.stance: 'regular' | 'goofy'
SkiConfig.boardYawDeg: number
SkiConfig.torsoWindDeg: number
SkiConfig.kneeBendDeg: number
SkiConfig.stanceHalfWidth: number
SkiConfig.skiLength: number
SkiConfig.skiWidth: number
SkiConfig.poleLength: number
SkiConfig.skiColor: number
SkiConfig.poleColor: number
SkiConfig.cameraAutoFollow: boolean
SkiConfig.cameraFollowResponse: number
SkiConfig.cameraDistance: number
SkiConfig.cameraDistanceSpeedGain: number
SkiConfig.cameraElevationBaseDeg: number
SkiConfig.cameraElevationSlopeFactor: number
SkiConfig.cameraElevationMaxDeg: number
SkiConfig.cameraGroundSmoothTime: number
SkiConfig.cameraHorizontalSmoothTime: number
SkiConfig.cameraOrbitSmoothTime: number
SkiConfig.cameraAirSmoothTime: number
SkiConfig.cameraFovSpeedGainDeg: number
SkiConfig.cameraAirElevationDeg: number
SkiConfig.cameraAirDistanceGain: number
SkiConfig.cameraWipeoutElevationDeg: number
SkiConfig.cameraWipeoutDistanceGain: number
SkiConfig.cameraWipeoutSmoothTime: number
SkiConfig.cameraCollideEnvironment: boolean
SkiConfig.cameraImpactKickScale: number
SkiConfig.cameraAirEnterSec: number
SkiConfig.cameraAirExitTailSec: number
SkiConfig.obstacleBounciness: number
SkiConfig.crashSpeedLoss: number
SkiConfig.crashMinSpeed: number
SkiConfig.bailRestitution: number
SkiConfig.bailRecoverySpeed: number
SkiConfig.bailRecoveryDelaySec: number
SkiConfig.bailMaxDurationSec: number
const DEFAULT_SKI_CONFIG: SkiConfig
function mergeSkiConfig(partial?: Partial<SkiConfig> | Record<string, unknown>): SkiConfig

## engine/ski/SkiEquipment.ts
class SkiEquipment
SkiEquipment.constructor(config: SkiConfig)
SkiEquipment.attach(_host: SkiMovementHost): void
SkiEquipment.syncTransform(host: SkiMovementHost, feet: THREE.Vector3, orientation: THREE.Quaternion): void
SkiEquipment.detach(_host: SkiMovementHost): void

## engine/ski/SkiMath.ts
function downhillAcceleration(n: THREE.Vector3, gravity: number, slopeAccelFactor: number, out: THREE.Vector3): THREE.Vector3
function applyDrag(vx: number, vz: number, airK: number, snowK: number, dt: number): { x: number; z: number }
function terminalSpeed(aGravity: number, airK: number, snowK: number): number
function groundFollowDy(n: THREE.Vector3, vx: number, vz: number, deltaTime: number): number
function wouldSeparate(followDescent: number, freeFallDescent: number, stickMargin: number): boolean
function skiCameraElevationDeg(slopeDeg: number, baseDeg: number, slopeFactor: number, maxDeg: number): number
function turnRateDegFor(speed: number, cfg: { turnRateLowDeg: number; turnRateHighDeg: number; maxSpeed: number }): number
function gripRateFor(speed: number, cfg: { gripRateLow: number; gripRateHigh: number; maxSpeed: number }): number
function carveVelocity(velX: number, velZ: number, headingYaw: number, gripRate: number, speedBleed: number, dt: number, skidBleed: number = speedBleed): { x: number; z: number }
function frictionMultipliers(friction: number): { drag: number; grip: number }
function nearestSpinRest(spinDeg: number): number
function landingSpinErrorDeg(spinDeg: number): number
function surfaceFollowVy(n: THREE.Vector3, vx: number, vz: number): number
interface LiftoffInput — Inertia-based liftoff decision for a grounded snowboard (law of inertia: the
LiftoffInput.followDescent: number
LiftoffInput.actualVy: number
LiftoffInput.gravity: number
LiftoffInput.dt: number
LiftoffInput.stable: boolean
LiftoffInput.margin: number
LiftoffInput.launchVyMax: number
LiftoffInput.terminalVelocity: number
function evaluateLiftoff(a: LiftoffInput): { separate: boolean; launchVy: number }

## engine/ski/SkiMovement.ts
interface SkiState
SkiState.speed: number
SkiState.heading: number
SkiState.velocity: THREE.Vector3
SkiState.skid: number
SkiState.grounded: boolean
SkiState.boardContactY: number
SkiState.airtimeSeconds: number
SkiState.slopeAngleDeg: number
SkiState.lastTrick: 'spin' | 'flip' | 'bail' | null
SkiState.bailing: boolean
class SkiMovement implements IPlayerMovement
SkiMovement.constructor(config?: Partial<SkiConfig> | Record<string, unknown>)
SkiMovement.onAttached(playerController: SkiMovementHost): void
SkiMovement.onDetached(playerController: SkiMovementHost): void
SkiMovement.update(deltaTime: number, playerController: SkiMovementHost, keys: PlayerMovementKeys, isGrounded: boolean, moveDirection: THREE.Vector3, playerBody: RAPIER.RigidBody, physicsWorld: PhysicsWorld): void
SkiMovement.getCurrentSpeed(): number
SkiMovement.isInAir(): boolean
SkiMovement.wasGroundedLastUpdate(): boolean
SkiMovement.getRotation(): number
SkiMovement.reset(): void
SkiMovement.getAscendDisplayName(): string
SkiMovement.getDescendDisplayName(): string
SkiMovement.getSupportedKeys(): { ascend: boolean; descend: boolean }
SkiMovement.getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' }
SkiMovement.handlesPlayerPositionSync(): boolean
SkiMovement.shouldShowPlayer(): boolean
SkiMovement.shouldPlayLocomotionAnimation(): boolean
SkiMovement.controlsBodyRotation(): boolean
SkiMovement.getJumpCount(): number
SkiMovement.setGroundFriction(friction: number): void
SkiMovement.isGravityEnabled(): boolean
SkiMovement.resetVerticalVelocity(): void
SkiMovement.setCameraLockRotation(enabled: boolean): void
SkiMovement.setCameraController(camera: { getHorizontalAngle: () => number } | null): void
SkiMovement.getMoveSpeed(): number
SkiMovement.setMoveSpeed(speed: number): void
SkiMovement.getSkiState(): SkiState
SkiMovement.teleport(position: THREE.Vector3, yaw?: number): void
SkiMovement.updateConfig(partial: Partial<SkiConfig> | Record<string, unknown>): void

## engine/ski/SkiMovementHost.ts
type SkiMovementCharacter = Pick<PlayerLoader, 'getBlockCharacterRenderer' | 'getFeetOffsetY'>
interface SkiMovementHost — The controller `SkiMovement` drives. `PlayerController` satisfies this directly;
SkiMovementHost.readonly player: THREE.Object3D
SkiMovementHost.readonly playerBody: RAPIER.RigidBody
SkiMovementHost.readonly physicsWorld: PhysicsWorld
SkiMovementHost.readonly animationController: ICharacterAnimationController | null
SkiMovementHost.readonly playerLoader: SkiMovementCharacter | null
SkiMovementHost.getCameraController(): any
SkiMovementHost.enterTemporaryRagdoll(hubVelocity?: THREE.Vector3): boolean
SkiMovementHost.getTemporaryRagdollState(): { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; speed: number } | null
SkiMovementHost.exitTemporaryRagdoll(): { x: number; y: number; z: number } | null

## engine/ski/SkiRiderInput.ts
interface SkiRiderKeys — Synthetic control input for an AI ski/snowboard rider — the SAME `keys` shape
SkiRiderKeys.forward: boolean
SkiRiderKeys.backward: boolean
SkiRiderKeys.left: boolean
SkiRiderKeys.right: boolean
SkiRiderKeys.ascend: boolean
SkiRiderKeys.interact: boolean
SkiRiderKeys.action: boolean
SkiRiderKeys.secondaryAction: boolean
SkiRiderKeys.descend: boolean
interface SkiRiderSkill — How the AI rides — the "skill" knobs. All-equal physics means difficulty is
SkiRiderSkill.steerDeadzoneRad: number
SkiRiderSkill.brakeAngleRad: number
SkiRiderSkill.brakeMinSpeed: number
const DEFAULT_SKI_RIDER_SKILL: SkiRiderSkill
function computeSkiRiderKeys(currentHeading: number, speed: number, desiredDir: THREE.Vector3, skill: SkiRiderSkill): SkiRiderKeys

## engine/ski/SnowSprayVFX.ts
interface SnowSprayVFXOptions — Snow-spray / powder VFX for skiing & snowboarding.
SnowSprayVFXOptions.maxParticles: number
SnowSprayVFXOptions.color: THREE.ColorRepresentation
SnowSprayVFXOptions.grainSize: number
SnowSprayVFXOptions.grainSizeJitter: number
SnowSprayVFXOptions.lifetime: number
SnowSprayVFXOptions.gravity: number
SnowSprayVFXOptions.emissionThreshold: number
SnowSprayVFXOptions.emissionFull: number
SnowSprayVFXOptions.maxEmissionRate: number
SnowSprayVFXOptions.boardHalfLength: number
SnowSprayVFXOptions.sprayOutScale: number
SnowSprayVFXOptions.castShadow: boolean
const DEFAULT_SNOW_SPRAY_VFX_OPTIONS: SnowSprayVFXOptions
class SnowSprayVFX
SnowSprayVFX.constructor(scene: THREE.Scene, options: SnowSprayVFXOptions = DEFAULT_SNOW_SPRAY_VFX_OPTIONS)
SnowSprayVFX.update(deltaTime: number, state: SkiState, playerRootPos: THREE.Vector3): void
SnowSprayVFX.dispose(): void
