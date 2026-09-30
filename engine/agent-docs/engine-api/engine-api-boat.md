# engine-api-boat

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/boat/AiBoat.ts
interface AiBoatOptions
AiBoatOptions.waypoints: readonly THREE.Vector3[]
AiBoatOptions.config: Partial<BoatConfig>
AiBoatOptions.lookAhead: number
AiBoatOptions.steerGain: number
AiBoatOptions.laneOffset: number
AiBoatOptions.showWake: boolean
AiBoatOptions.startIndex: number
const DEFAULT_AI_BOAT_OPTIONS: Omit<AiBoatOptions, 'waypoints'>
class AiBoat
AiBoat.constructor(scene: THREE.Object3D, surface: WaterSurfaceQuery, options: Partial<AiBoatOptions> & Pick<AiBoatOptions, 'waypoints'>)
AiBoat.update(deltaTime: number): void
AiBoat.getState(): BoatState
AiBoat.getPosition(out: THREE.Vector3): THREE.Vector3
AiBoat.getLaps(): number
AiBoat.getTargetIndex(): number
AiBoat.dispose(): void

## engine/boat/BoatConfig.ts
interface BoatConfig — Tuning for `engine/boat/BoatMovement.ts`. Flat numbers and booleans only, so
BoatConfig.maxSpeed: number
BoatConfig.boostMaxSpeed: number
BoatConfig.reverseMaxSpeed: number
BoatConfig.acceleration: number
BoatConfig.boostAcceleration: number
BoatConfig.reverseAcceleration: number
BoatConfig.brakeDecel: number
BoatConfig.dragLinear: number
BoatConfig.turnRateLowDeg: number
BoatConfig.turnRateHighDeg: number
BoatConfig.turnPeakSpeed: number
BoatConfig.airTurnFactor: number
BoatConfig.gripRate: number
BoatConfig.rideHeight: number
BoatConfig.buoyancyRate: number
BoatConfig.waveSurfAccel: number
BoatConfig.gravity: number
BoatConfig.liftoffMargin: number
BoatConfig.jumpSpeed: number
BoatConfig.landingSpeedLoss: number
BoatConfig.waveAlign: number
BoatConfig.turnLeanDeg: number
BoatConfig.bowLiftDeg: number
BoatConfig.poseRate: number
BoatConfig.showHull: boolean
BoatConfig.hullColor: number
BoatConfig.trimColor: number
BoatConfig.seatColor: number
BoatConfig.hullScale: number
BoatConfig.showRider: boolean
BoatConfig.riderColor: number
BoatConfig.riderHelmetColor: number
BoatConfig.showWake: boolean
const DEFAULT_BOAT_CONFIG: BoatConfig
function quadraticDragFor(config: BoatConfig): number
function mergeBoatConfig(partial?: Partial<BoatConfig> | Record<string, unknown>): BoatConfig

## engine/boat/BoatHull.ts
class BoatHull
BoatHull.constructor(config: BoatConfig)
BoatHull.syncTransform(parent: THREE.Object3D | null, position: THREE.Vector3, orientation: THREE.Quaternion): void
BoatHull.detach(): void

## engine/boat/BoatMotor.ts
interface BoatInput — One frame of control input. All values are already smoothed/clamped.
BoatInput.throttle: number
BoatInput.steer: number
BoatInput.boost: boolean
BoatInput.jump: boolean
const NEUTRAL_BOAT_INPUT: BoatInput
interface BoatState — Everything a HUD, a VFX emitter or an AI needs to read back per frame.
BoatState.forwardSpeed: number
BoatState.speed: number
BoatState.heading: number
BoatState.velocity: THREE.Vector3
BoatState.onWater: boolean
BoatState.airtimeSeconds: number
BoatState.drift: number
BoatState.surfaceY: number
BoatState.hullY: number
BoatState.boosting: boolean
BoatState.landingImpact: number
class BoatMotor
BoatMotor.constructor(config: BoatConfig)
BoatMotor.setPosition(x: number, y: number, z: number, heading: number): void
BoatMotor.getPosition(out: THREE.Vector3): THREE.Vector3
BoatMotor.getHeading(): number
BoatMotor.setHeading(heading: number): void
BoatMotor.step(deltaTime: number, input: BoatInput, surface: WaterSurfaceQuery): THREE.Vector3
BoatMotor.commit(actual: THREE.Vector3, deltaTime: number): void
BoatMotor.getPose(deltaTime: number, input: BoatInput, out: THREE.Quaternion): THREE.Quaternion
BoatMotor.getState(): BoatState
BoatMotor.getSurfaceNormal(): THREE.Vector3

## engine/boat/BoatMovement.ts
class BoatMovement implements IPlayerMovement
BoatMovement.constructor(config?: Partial<BoatConfig> | Record<string, unknown>)
BoatMovement.setWaterSurface(surface: WaterSurfaceQuery): void
BoatMovement.onAttached(playerController: PlayerController): void
BoatMovement.onDetached(): void
BoatMovement.update(deltaTime: number, playerController: PlayerController, keys: PlayerMovementKeys, _isGrounded: boolean, _moveDirection: THREE.Vector3, playerBody: RAPIER.RigidBody, physicsWorld: PhysicsWorld): void
BoatMovement.getCurrentSpeed(): number
BoatMovement.isInAir(): boolean
BoatMovement.getRotation(): number
BoatMovement.setRotation(rotation: number): void
BoatMovement.reset(): void
BoatMovement.getAscendDisplayName(): string
BoatMovement.getDescendDisplayName(): string
BoatMovement.getSupportedKeys(): { ascend: boolean; descend: boolean }
BoatMovement.getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' }
BoatMovement.shouldShowPlayer(): boolean
BoatMovement.shouldPlayLocomotionAnimation(): boolean
BoatMovement.handlesPlayerPositionSync(): boolean
BoatMovement.controlsBodyRotation(): boolean
BoatMovement.isGravityEnabled(): boolean
BoatMovement.getMoveSpeed(): number
BoatMovement.setMoveSpeed(_speed: number): void
BoatMovement.getBoatState(): BoatState
BoatMovement.getHullPosition(out: THREE.Vector3): THREE.Vector3
BoatMovement.teleport(position: THREE.Vector3, yaw: number): void
BoatMovement.updateConfig(partial: Partial<BoatConfig> | Record<string, unknown>): void

## engine/boat/BoatRaceCourse.ts
interface BoatRaceCourseOptions
BoatRaceCourseOptions.waypoints: THREE.Vector3[]
BoatRaceCourseOptions.closed: boolean
BoatRaceCourseOptions.surface: WaterSurfaceQuery
BoatRaceCourseOptions.halfWidth: number
BoatRaceCourseOptions.edgeWidth: number
BoatRaceCourseOptions.subdivisions: number
BoatRaceCourseOptions.ribbonColor: THREE.ColorRepresentation
BoatRaceCourseOptions.ribbonEdgeColor: THREE.ColorRepresentation
BoatRaceCourseOptions.ribbonOpacity: number
BoatRaceCourseOptions.ribbonLift: number
BoatRaceCourseOptions.gateCount: number
BoatRaceCourseOptions.gateHalfWidth: number
BoatRaceCourseOptions.buoyColor: THREE.ColorRepresentation
BoatRaceCourseOptions.buoyPostColor: THREE.ColorRepresentation
BoatRaceCourseOptions.scatterBuoyCount: number
BoatRaceCourseOptions.scatterRadius: number
BoatRaceCourseOptions.seed: number
const DEFAULT_BOAT_RACE_COURSE_OPTIONS: Omit<BoatRaceCourseOptions, 'waypoints' | 'surface'>
interface CourseGate — One gate: the pair of buoys and the line between them a boat must cross.
CourseGate.center: THREE.Vector3
CourseGate.forward: THREE.Vector3
CourseGate.across: THREE.Vector3
CourseGate.halfWidth: number
interface BoatRaceCourse
BoatRaceCourse.readonly group: THREE.Group
BoatRaceCourse.readonly gates: readonly CourseGate[]
BoatRaceCourse.readonly centerline: readonly THREE.Vector3[]
BoatRaceCourse.update(): void
BoatRaceCourse.gateCrossed(index: number, from: THREE.Vector3, to: THREE.Vector3): boolean
BoatRaceCourse.distanceAlong(point: THREE.Vector3): number
BoatRaceCourse.readonly length: number
BoatRaceCourse.dispose(): void
function createBoatRaceCourse(options: Partial<BoatRaceCourseOptions> & Pick<BoatRaceCourseOptions, 'waypoints' | 'surface'>): BoatRaceCourse

## engine/boat/BoatWakeVFX.ts
interface BoatWakeVFXOptions
BoatWakeVFXOptions.maxParticles: number
BoatWakeVFXOptions.particleLife: number
BoatWakeVFXOptions.particleSize: number
BoatWakeVFXOptions.baseEmitRate: number
BoatWakeVFXOptions.driftEmitRate: number
BoatWakeVFXOptions.landingBurstPerImpact: number
BoatWakeVFXOptions.sprayColor: THREE.ColorRepresentation
BoatWakeVFXOptions.gravity: number
BoatWakeVFXOptions.wakeSamples: number
BoatWakeVFXOptions.wakeSpacing: number
BoatWakeVFXOptions.wakeHalfWidth: number
BoatWakeVFXOptions.wakeSpread: number
BoatWakeVFXOptions.wakeLift: number
BoatWakeVFXOptions.wakeColor: THREE.ColorRepresentation
BoatWakeVFXOptions.wakeOpacity: number
const DEFAULT_BOAT_WAKE_OPTIONS: BoatWakeVFXOptions
class BoatWakeVFX
BoatWakeVFX.constructor(scene: THREE.Object3D, surface: WaterSurfaceQuery, options: Partial<BoatWakeVFXOptions> = {})
BoatWakeVFX.setSurface(surface: WaterSurfaceQuery): void
BoatWakeVFX.update(deltaTime: number, state: BoatState, hullPosition: THREE.Vector3): void
BoatWakeVFX.reset(): void
BoatWakeVFX.dispose(): void
