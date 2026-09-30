# engine-api-physics

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/physics/BallPhysics.ts
interface DynamicPhysicsBodyOptions — Options for VoxelObject.createDynamicPhysicsBody().
DynamicPhysicsBodyOptions.colliderShape: 'box' | 'sphere'
DynamicPhysicsBodyOptions.startAsleep: boolean
const DEFAULT_DYNAMIC_PHYSICS_BODY_OPTIONS: DynamicPhysicsBodyOptions
const DEFAULT_BALL_PHYSICS = { friction: 0.6, restitution: 0.55, linearDamping: 0.6, angu
function trueUpBodyMass(body: { mass(): number }, colliders: Array<{ density(): number; setDensity(d: number): void }>, targetMass: number): void
interface ColliderShapeView — Minimal view of a Rapier collider for radius estimation: a cuboid, or any
ColliderShapeView.translation(): { x: number; y: number; z: number }
ColliderShapeView.shape: { halfExtents?: { x: number; y: number; z: number }; radius?: number }
function computeColliderRadius(colliders: ColliderShapeView[], center: { x: number; y: number; z: number }, fallback = 0.4): number
function sphereColliderDesc(radius: number): RAPIER.ColliderDesc
function createBallColliderDesc(bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null, pivot: { x: number; y: number; z: number }, collisionGroups: number): RAPIER.ColliderDesc

## engine/physics/EnvObject2D.ts
interface EnvTransform
EnvTransform.translation: { x: number; y: number; z: number }
EnvTransform.rotation: { x: number; y: number; z: number; w: number }
EnvTransform.scale: { x: number; y: number; z: number }
const ENV_SLAB_HALF_DEPTH_M = 0.5
function envSliceFor(planeZ: number): GameplaySlice
function envBoxesToPlaneCuboids(boxes: readonly PhysicsBox[], transform: EnvTransform, slice: GameplaySlice): Cuboid2D[]
interface GroundCuboid2D — A top-down obstacle cuboid: 2D y is world Z, and `topY` is the box's world-Y top (what a vertical probe reports).
GroundCuboid2D.topY: number
function envBoxesToGroundCuboids(boxes: readonly PhysicsBox[], transform: EnvTransform, groundY: number | null): GroundCuboid2D[]
function envBoxesToGroundRects(boxes: readonly PhysicsBox[], transform: EnvTransform): GroundRect[]

## engine/physics/PhysicsBodyFactory.ts
interface RigidBodyConfig
RigidBodyConfig.type: 'dynamic' | 'static' | 'kinematic'
RigidBodyConfig.position: THREE.Vector3
RigidBodyConfig.rotation?: THREE.Quaternion
RigidBodyConfig.linearDamping?: number
RigidBodyConfig.angularDamping?: number
RigidBodyConfig.gravityScale?: number
RigidBodyConfig.canSleep?: boolean
RigidBodyConfig.ccdEnabled?: boolean
interface ColliderConfig
ColliderConfig.shape: ColliderShape
ColliderConfig.mass?: number
ColliderConfig.friction?: number
ColliderConfig.restitution?: number
ColliderConfig.collisionGroup?: number
ColliderConfig.collisionMask?: number
ColliderConfig.isSensor?: boolean
ColliderConfig.offset?: THREE.Vector3
ColliderConfig.offsetRotation?: THREE.Quaternion
type ColliderShape = | { type: 'box'; halfExtents: THREE.Vector3 } | { type: 'sphere'; radius: number } | { type: 'capsule'; halfHeight: number; radius: number } | { type: 'cylinder'; halfHeight: number; radius: number } | { type: 'convexHull'; vertices: Float32Array } | { type: 'trimesh'; vertices: Float32Array; indices: Uint32Array } /** * Rapier heightfield: `nrows` cells along Z, `ncols` along X, heights column-major * (index col·(nrows+1) + row), `scale` = the grid's full X/Z size (y = 1: heights are * absolute). Centred on the body, so place the body at the grid's centre. */ | { type: 'heightfield'; nrows: number; ncols: number; heights: Float32Array; scale: THREE.Vector3 }
class PhysicsBodyFactory
static PhysicsBodyFactory.createRigidBodyDesc(config: RigidBodyConfig): RAPIER.RigidBodyDesc
static PhysicsBodyFactory.createColliderDesc(config: ColliderConfig): RAPIER.ColliderDesc
static PhysicsBodyFactory.createCollisionGroups(memberOf: number, collidesWith: number): number
static PhysicsBodyFactory.createDynamicBody(world: PhysicsWorld, position: THREE.Vector3, colliderConfig: ColliderConfig, options?: Partial<RigidBodyConfig>): { rigidBody: RAPIER.RigidBody; collider: RAPIER.Collider }
static PhysicsBodyFactory.createStaticBody(world: PhysicsWorld, position: THREE.Vector3, colliderConfig: ColliderConfig, rotation?: THREE.Quaternion): { rigidBody: RAPIER.RigidBody; collider: RAPIER.Collider }
static PhysicsBodyFactory.createKinematicBody(world: PhysicsWorld, position: THREE.Vector3, colliderConfig: ColliderConfig, options?: Partial<RigidBodyConfig>): { rigidBody: RAPIER.RigidBody; collider: RAPIER.Collider }
static PhysicsBodyFactory.createCapsuleCharacter(world: PhysicsWorld, position: THREE.Vector3, height: number, radius: number, mass: number = 80, collisionGroup: number = CollisionGroup.PLAYER, collisionMask: number = CollisionMask.PLAYER): { rigidBody: RAPIER.RigidBody; collider: RAPIER.Collider }
static PhysicsBodyFactory.createProjectile(world: PhysicsWorld, position: THREE.Vector3, velocity: THREE.Vector3, radius: number = 0.05, mass: number = 0.1, collisionGroup: number = CollisionGroup.PROJECTILE, collisionMask: number = CollisionMask.PROJECTILE): { rigidBody: RAPIER.RigidBody; collider: RAPIER.Collider }

## engine/physics/PhysicsBodyFactory2D.ts
interface RigidBodyConfig2D
RigidBodyConfig2D.type: 'dynamic' | 'static' | 'kinematic'
RigidBodyConfig2D.position: { x: number; y: number }
RigidBodyConfig2D.rotation?: number
RigidBodyConfig2D.linearDamping?: number
RigidBodyConfig2D.angularDamping?: number
RigidBodyConfig2D.gravityScale?: number
RigidBodyConfig2D.canSleep?: boolean
RigidBodyConfig2D.ccdEnabled?: boolean
RigidBodyConfig2D.lockRotation?: boolean
interface ColliderConfig2D
ColliderConfig2D.shape: ColliderShape2D
ColliderConfig2D.mass?: number
ColliderConfig2D.friction?: number
ColliderConfig2D.restitution?: number
ColliderConfig2D.collisionGroup?: number
ColliderConfig2D.collisionMask?: number
ColliderConfig2D.isSensor?: boolean
ColliderConfig2D.offset?: { x: number; y: number }
type ColliderShape2D = | { type: 'cuboid'; halfWidth: number; halfHeight: number } | { type: 'ball'; radius: number } | { type: 'capsule'; halfHeight: number; radius: number } | { type: 'segment'; a: { x: number; y: number }; b: { x: number; y: number } } | { type: 'convexHull'; vertices: Float32Array } | { type: 'polyline'; vertices: Float32Array; indices?: Uint32Array }
class PhysicsBodyFactory2D
static PhysicsBodyFactory2D.createRigidBodyDesc(config: RigidBodyConfig2D): RAPIER2D.RigidBodyDesc
static PhysicsBodyFactory2D.createColliderDesc(config: ColliderConfig2D): RAPIER2D.ColliderDesc
static PhysicsBodyFactory2D.createCollisionGroups(memberOf: number, collidesWith: number): number
static PhysicsBodyFactory2D.createDynamicBody(world: PhysicsWorld2D, position: { x: number; y: number }, colliderConfig: ColliderConfig2D, options?: Partial<RigidBodyConfig2D>): { rigidBody: RAPIER2D.RigidBody; collider: RAPIER2D.Collider }
static PhysicsBodyFactory2D.createStaticBody(world: PhysicsWorld2D, position: { x: number; y: number }, colliderConfig: ColliderConfig2D, rotation?: number): { rigidBody: RAPIER2D.RigidBody; collider: RAPIER2D.Collider }
static PhysicsBodyFactory2D.createKinematicBody(world: PhysicsWorld2D, position: { x: number; y: number }, colliderConfig: ColliderConfig2D, options?: Partial<RigidBodyConfig2D>): { rigidBody: RAPIER2D.RigidBody; collider: RAPIER2D.Collider }

## engine/physics/PhysicsModeRule.ts
type PhysicsMode = '3d' | '2d' | 'none'
function effectivePhysicsMode(gameGenre: string, requested: PhysicsMode | undefined, physics2dCapable = false): PhysicsMode
function rapierFlavorForPhysicsMode(mode: PhysicsMode): '2d' | '3d'

## engine/physics/PhysicsWorld.ts
interface RaycastResult
RaycastResult.hasHit: boolean
RaycastResult.hitPoint: THREE.Vector3
RaycastResult.hitNormal: THREE.Vector3
RaycastResult.hitDistance: number
RaycastResult.hitCollider: RAPIER.Collider | null
RaycastResult.hitRigidBody: RAPIER.RigidBody | null
interface SpatialQueryResult
SpatialQueryResult.handle: number
SpatialQueryResult.userData: unknown
SpatialQueryResult.position: { x: number; y: number; z: number }
interface VehiclePathProbeOptions — Inputs for `probeVehiclePath`. No self-exclusion field: the query is filtered
VehiclePathProbeOptions.footprint: VehicleFootprint
VehiclePathProbeOptions.maxClimbGrade: number
VehiclePathProbeOptions.maxStepHeight: number
VehiclePathProbeOptions.rideHeight: number
interface ContactInfo
ContactInfo.bodyA: RAPIER.RigidBody
ContactInfo.bodyB: RAPIER.RigidBody
ContactInfo.colliderA: RAPIER.Collider
ContactInfo.colliderB: RAPIER.Collider
ContactInfo.contactPoint: THREE.Vector3
ContactInfo.contactNormal: THREE.Vector3
ContactInfo.penetrationDepth: number
ContactInfo.isGeometricNormal?: boolean
type CollisionCallback = (contact: ContactInfo) => void
interface SensorIntersectionListener — Listener for generic sensor (trigger) intersection events. Both handles are
SensorIntersectionListener.onIntersectionStart: (h1: number, h2: number) => void
SensorIntersectionListener.onIntersectionEnd: (h1: number, h2: number) => void
class PhysicsWorld
PhysicsWorld.lastStepSubstepCount
PhysicsWorld.getStepsTaken(): number
PhysicsWorld.constructor(gravity: THREE.Vector3 = new THREE.Vector3(0, -9.81, 0))
PhysicsWorld.isHalted(): boolean
PhysicsWorld.isDisposed(): boolean
PhysicsWorld.step(deltaTime: number): void
PhysicsWorld.registerPreSolveCallback(callback: () => void): void
PhysicsWorld.unregisterPreSolveCallback(callback: () => void): void
PhysicsWorld.quarantineBody(body: RAPIER.RigidBody): void
PhysicsWorld.flushCollisionCallbacks(): void
PhysicsWorld.registerPreStepCallback(callback: (dt: number) => void): void
PhysicsWorld.unregisterPreStepCallback(callback: (dt: number) => void): void
PhysicsWorld.registerPostStepCallback(callback: () => void): void
PhysicsWorld.unregisterPostStepCallback(callback: () => void): void
PhysicsWorld.forEachActiveRigidBody(f: (body: RAPIER.RigidBody) => void): void
PhysicsWorld.getFixedTimestep(): number
PhysicsWorld.getInterpolationAlpha(): number
PhysicsWorld.createRigidBody(desc: RAPIER.RigidBodyDesc): RAPIER.RigidBody
PhysicsWorld.createCollider(desc: RAPIER.ColliderDesc, parent: RAPIER.RigidBody): RAPIER.Collider
PhysicsWorld.addRigidBody(body: RAPIER.RigidBody, collisionGroup?: number, collisionMask?: number): void
PhysicsWorld.removeRigidBody(body: RAPIER.RigidBody): void
PhysicsWorld.removeCollider(collider: RAPIER.Collider): void
PhysicsWorld.createImpulseJoint(params: RAPIER.JointData, body1: RAPIER.RigidBody, body2: RAPIER.RigidBody): RAPIER.ImpulseJoint
PhysicsWorld.removeImpulseJoint(joint: RAPIER.ImpulseJoint): void
PhysicsWorld.removeRigidBodyImmediate(body: RAPIER.RigidBody): void
PhysicsWorld.removeColliderImmediate(collider: RAPIER.Collider): void
PhysicsWorld.setSimulationActive(active: boolean): void
PhysicsWorld.registerCollisionCallback(body: RAPIER.RigidBody, callback: CollisionCallback): void
PhysicsWorld.unregisterCollisionCallback(body: RAPIER.RigidBody, callback: CollisionCallback): void
PhysicsWorld.addSensorListener(listener: SensorIntersectionListener): void
PhysicsWorld.removeSensorListener(listener: SensorIntersectionListener): void
PhysicsWorld.setUserData(body: RAPIER.RigidBody, userData: any): void
PhysicsWorld.getUserData(body: RAPIER.RigidBody): any
PhysicsWorld.getUserDataFromHandle(handle: number): any
PhysicsWorld.forEachUserData(callback: (handle: number, userData: any) => void): void
PhysicsWorld.getBodyTranslation(handle: number): { x: number; y: number; z: number } | null
PhysicsWorld.getBodyLinvel(handle: number): { x: number; y: number; z: number } | null
PhysicsWorld.capsuleOverlaps(center: { x: number; y: number; z: number }, radius: number, halfHeight: number, collisionMask: number): boolean
PhysicsWorld.overlappingColliderHandles(center: { x: number; y: number; z: number }, radius: number, halfHeight: number, collisionMask: number, out: Set<number>): Set<number>
PhysicsWorld.computeGroupAvoidance(center: { x: number; y: number; z: number }, radius: number, halfHeight: number, margin: number, collisionMask: number, minBodySpeed = 0): { x: number; z: number } | null
PhysicsWorld.teleportDynamicBody(body: RAPIER.RigidBody, position: { x: number; y: number; z: number }, yaw?: number, options?: { overlapResolution?: 'none' | 'horizontal' | 'up'; /** Layers treated as solid for overlap resolution. Default: static world + props + vehicles. */ collisionMask?: number; /** Max distance to search / lift, in metres. Default 3. */ maxDistance?: number; }): { x: number; y: number; z: number }
PhysicsWorld.queryEntitiesInRadius(center: { x: number; y: number; z: number }, radius: number): SpatialQueryResult[]
PhysicsWorld.setColliderUserData(collider: RAPIER.Collider, userData: any): void
PhysicsWorld.getColliderUserData(collider: RAPIER.Collider): any
PhysicsWorld.getColliderUserDataFromHandle(handle: number): any
PhysicsWorld.raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number = 1000, collisionMask: number = CollisionMask.ALL, out?: RaycastResult): RaycastResult
PhysicsWorld.raycastWithFilter(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, filterGroups: number, filterMask: number, excludeBodies?: RAPIER.RigidBody[], out?: RaycastResult): RaycastResult
PhysicsWorld.getGravity(): THREE.Vector3
PhysicsWorld.setGravity(gravity: THREE.Vector3): void
PhysicsWorld.getRapierWorld(): RAPIER.World
PhysicsWorld.getCharacterController(): RAPIER.KinematicCharacterController
PhysicsWorld.detectStepUp(collider: RAPIER.Collider, dirX: number, dirZ: number, maxStep: number, minStep = 0.04): number
PhysicsWorld.probeVehiclePath(from: THREE.Vector3, to: THREE.Vector3, options: VehiclePathProbeOptions): VehiclePassResult
PhysicsWorld.intersectsBox(center: THREE.Vector3, halfExtents: THREE.Vector3, collisionMask: number, excludeBody?: RAPIER.RigidBody): boolean
PhysicsWorld.ledgeForMantle(collider: RAPIER.Collider, dirX: number, dirZ: number, minBelowCenter: number, maxBelowCenter: number): number | null
PhysicsWorld.groundDistBelowCenter(collider: RAPIER.Collider, maxDist: number): number
PhysicsWorld.groundSlopeUnder(collider: RAPIER.Collider): { tan: number; downX: number; downZ: number } | null
PhysicsWorld.kinematicBodyBelowCenter(collider: RAPIER.Collider, maxDist: number): RAPIER.RigidBody | null
PhysicsWorld.kinematicBodyOverlapping(collider: RAPIER.Collider, exclude: RAPIER.RigidBody | null): RAPIER.RigidBody | null
PhysicsWorld.capsuleOverlapsStatic(collider: RAPIER.Collider, at: { x: number; y: number; z: number }, shrink = 0.05): boolean
PhysicsWorld.addAction(_vehicle: unknown): void
PhysicsWorld.removeAction(_vehicle: unknown): void
PhysicsWorld.getStats(): { rigidBodyCount: number; colliderCount: number }
PhysicsWorld.dispose(): void

## engine/physics/PhysicsWorld2D.ts
interface RaycastResult2D
RaycastResult2D.hasHit: boolean
RaycastResult2D.hitPoint: THREE.Vector2
RaycastResult2D.hitNormal: THREE.Vector2
RaycastResult2D.hitDistance: number
RaycastResult2D.hitCollider: RAPIER2D.Collider | null
RaycastResult2D.hitRigidBody: RAPIER2D.RigidBody | null
interface ContactInfo2D
ContactInfo2D.bodyA: RAPIER2D.RigidBody
ContactInfo2D.bodyB: RAPIER2D.RigidBody
ContactInfo2D.colliderA: RAPIER2D.Collider
ContactInfo2D.colliderB: RAPIER2D.Collider
ContactInfo2D.contactPoint: THREE.Vector2
ContactInfo2D.contactNormal: THREE.Vector2
ContactInfo2D.penetrationDepth: number
type CollisionCallback2D = (contact: ContactInfo2D) => void
interface SensorIntersectionListener2D — Sensor (trigger) overlap notifications, in COLLIDER handles — resolve with
SensorIntersectionListener2D.onIntersectionStart: (h1: number, h2: number) => void
SensorIntersectionListener2D.onIntersectionEnd: (h1: number, h2: number) => void
class PhysicsWorld2D
PhysicsWorld2D.constructor(gravity: { x: number; y: number } = { x: 0, y: -30 })
PhysicsWorld2D.step(deltaTime: number): void
PhysicsWorld2D.flushCollisionCallbacks(): void
PhysicsWorld2D.setPhysicsHooks(hooks: RAPIER2D.PhysicsHooks | null): void
PhysicsWorld2D.addSensorListener(listener: SensorIntersectionListener2D): void
PhysicsWorld2D.removeSensorListener(listener: SensorIntersectionListener2D): void
PhysicsWorld2D.getCharacterController(): RAPIER2D.KinematicCharacterController
PhysicsWorld2D.registerPreStepCallback(callback: (dt: number) => void): void
PhysicsWorld2D.unregisterPreStepCallback(callback: (dt: number) => void): void
PhysicsWorld2D.registerPostStepCallback(callback: () => void): void
PhysicsWorld2D.unregisterPostStepCallback(callback: () => void): void
PhysicsWorld2D.createRigidBody(desc: RAPIER2D.RigidBodyDesc): RAPIER2D.RigidBody
PhysicsWorld2D.createCollider(desc: RAPIER2D.ColliderDesc, parent: RAPIER2D.RigidBody): RAPIER2D.Collider
PhysicsWorld2D.removeRigidBody(body: RAPIER2D.RigidBody): void
PhysicsWorld2D.removeCollider(collider: RAPIER2D.Collider): void
PhysicsWorld2D.removeRigidBodyImmediate(body: RAPIER2D.RigidBody): void
PhysicsWorld2D.removeColliderImmediate(collider: RAPIER2D.Collider): void
PhysicsWorld2D.registerCollisionCallback(body: RAPIER2D.RigidBody, callback: CollisionCallback2D): void
PhysicsWorld2D.unregisterCollisionCallback(body: RAPIER2D.RigidBody, callback: CollisionCallback2D): void
PhysicsWorld2D.setUserData(body: RAPIER2D.RigidBody, userData: unknown): void
PhysicsWorld2D.getUserData(body: RAPIER2D.RigidBody): unknown
PhysicsWorld2D.getUserDataFromHandle(handle: number): unknown
PhysicsWorld2D.forEachUserData(callback: (handle: number, userData: unknown) => void): void
PhysicsWorld2D.getBodyTranslation(handle: number): { x: number; y: number } | null
PhysicsWorld2D.raycast(origin: { x: number; y: number }, direction: { x: number; y: number }, maxDistance: number = 1000, collisionMask: number = 0xFFFF): RaycastResult2D
PhysicsWorld2D.getGravity(): { x: number; y: number }
PhysicsWorld2D.getStepsTaken(): number
PhysicsWorld2D.isDisposed(): boolean
PhysicsWorld2D.capsuleOverlaps(center: { x: number; y: number }, radius: number, halfHeight: number, collisionMask: number): boolean
PhysicsWorld2D.setGravity(gravity: { x: number; y: number }): void
PhysicsWorld2D.getRapierWorld(): RAPIER2D.World
PhysicsWorld2D.getStats(): { rigidBodyCount: number; colliderCount: number }
PhysicsWorld2D.dispose(): void

## engine/physics/PlaneLockedPhysics.ts
interface CharacterDims — The 3D capsule a character was created with — what the movers read off `collider.shape` on either plane.
CharacterDims.radius: number
CharacterDims.halfHeight: number
class PlaneLockedCollider — A Rapier 2D collider seen through the 3D collider surface.
PlaneLockedCollider.characterDims: CharacterDims | null
PlaneLockedCollider.constructor(readonly raw: RAPIER2D.Collider, private readonly owner: PlaneLockedPhysics)
PlaneLockedCollider.get handle(): number
PlaneLockedCollider.isValid(): boolean
PlaneLockedCollider.isSensor(): boolean
PlaneLockedCollider.setSensor(sensor: boolean): void
PlaneLockedCollider.isEnabled(): boolean
PlaneLockedCollider.setEnabled(enabled: boolean): void
PlaneLockedCollider.radius(): number
PlaneLockedCollider.setRadius(radius: number): void
PlaneLockedCollider.halfHeight(): number
PlaneLockedCollider.setHalfHeight(halfHeight: number): void
PlaneLockedCollider.friction(): number
PlaneLockedCollider.setFriction(friction: number): void
PlaneLockedCollider.restitution(): number
PlaneLockedCollider.setRestitution(restitution: number): void
PlaneLockedCollider.collisionGroups(): number
PlaneLockedCollider.setCollisionGroups(groups: number): void
PlaneLockedCollider.setActiveEvents(events: number): void
PlaneLockedCollider.setActiveCollisionTypes(types: number): void
PlaneLockedCollider.translation(): Vec3Like
PlaneLockedCollider.parent(): PlaneLockedBody | null
PlaneLockedCollider.get shape(): RAPIER2D.Shape
class PlaneLockedBody — A Rapier 2D rigid body seen through the 3D rigid-body surface.
PlaneLockedBody.offPlane: number
PlaneLockedBody.characterDims: CharacterDims | null
PlaneLockedBody.grounded
PlaneLockedBody.constructor(readonly raw: RAPIER2D.RigidBody, private readonly owner: PlaneLockedPhysics, offPlane: number)
PlaneLockedBody.get handle(): number
PlaneLockedBody.get userData(): unknown
PlaneLockedBody.set userData(value: unknown)
PlaneLockedBody.isValid(): boolean
PlaneLockedBody.translation(): Vec3Like
PlaneLockedBody.setTranslation(p: Vec3In, wakeUp: boolean = true): void
PlaneLockedBody.setNextKinematicTranslation(p: Vec3In): void
PlaneLockedBody.nextTranslation(): Vec3Like
PlaneLockedBody.linvel(): Vec3Like
PlaneLockedBody.setLinvel(v: Vec3In, wakeUp: boolean = true): void
PlaneLockedBody.angvel(): Vec3Like
PlaneLockedBody.setAngvel(v: { x?: number; y?: number; z?: number }, wakeUp: boolean = true): void
PlaneLockedBody.rotation(): QuatLike
PlaneLockedBody.setRotation(q: QuatLike, wakeUp: boolean = true): void
PlaneLockedBody.setNextKinematicRotation(q: QuatLike): void
PlaneLockedBody.nextRotation(): QuatLike
PlaneLockedBody.gravityScale(): number
PlaneLockedBody.setGravityScale(scale: number, wakeUp: boolean = true): void
PlaneLockedBody.mass(): number
PlaneLockedBody.wakeUp(): void
PlaneLockedBody.sleep(): void
PlaneLockedBody.isSleeping(): boolean
PlaneLockedBody.isMoving(): boolean
PlaneLockedBody.setEnabled(enabled: boolean): void
PlaneLockedBody.isEnabled(): boolean
PlaneLockedBody.bodyType(): number
PlaneLockedBody.isKinematic(): boolean
PlaneLockedBody.isDynamic(): boolean
PlaneLockedBody.isFixed(): boolean
PlaneLockedBody.numColliders(): number
PlaneLockedBody.collider(i: number): PlaneLockedCollider
PlaneLockedBody.lockRotations(locked: boolean, wakeUp: boolean = true): void
PlaneLockedBody.lockTranslations(locked: boolean, wakeUp: boolean = true): void
PlaneLockedBody.applyImpulse(v: Vec3In, wakeUp: boolean = true): void
PlaneLockedBody.addForce(v: Vec3In, wakeUp: boolean = true): void
PlaneLockedBody.resetForces(wakeUp: boolean = true): void
PlaneLockedBody.resetTorques(wakeUp: boolean = true): void
PlaneLockedBody.linearDamping(): number
PlaneLockedBody.setLinearDamping(damping: number): void
interface CharacterCapsule2DOptions
CharacterCapsule2DOptions.x: number
CharacterCapsule2DOptions.y: number
CharacterCapsule2DOptions.z: number
CharacterCapsule2DOptions.radius: number
CharacterCapsule2DOptions.halfHeight: number
CharacterCapsule2DOptions.collisionGroup: number
CharacterCapsule2DOptions.collisionMask: number
CharacterCapsule2DOptions.friction: number
const DEFAULT_CHARACTER_CAPSULE_2D: Omit<CharacterCapsule2DOptions, 'x' | 'y' | 'z' | 'radius' | 'halfHeight'>
interface EnvironmentColliders2DOptions
EnvironmentColliders2DOptions.boxes: readonly PhysicsBox[]
EnvironmentColliders2DOptions.transform: EnvTransform
EnvironmentColliders2DOptions.collisionGroups: number
EnvironmentColliders2DOptions.friction: number
EnvironmentColliders2DOptions.restitution: number
interface EnvironmentBody2DOptions
EnvironmentBody2DOptions.kind: 'fixed' | { dynamic: { mass: number } }
EnvironmentBody2DOptions.userData?: unknown
EnvironmentBody2DOptions.terrain?: boolean
interface SensorBall2DOptions
SensorBall2DOptions.x: number
SensorBall2DOptions.y: number
SensorBall2DOptions.z: number
SensorBall2DOptions.radius: number
SensorBall2DOptions.collisionGroups: number
interface ProjectileBody2DOptions — A shot in flight — see {@link PlaneLockedPhysics.createProjectileBody}.
ProjectileBody2DOptions.x: number
ProjectileBody2DOptions.y: number
ProjectileBody2DOptions.z: number
ProjectileBody2DOptions.velocity: Vec3In
ProjectileBody2DOptions.radius: number
ProjectileBody2DOptions.collisionGroups: number
ProjectileBody2DOptions.gravityScale: number
interface PlaneLockedCharacterCollision — One collision reported by the character controller, in the 3D shape the movers read.
PlaneLockedCharacterCollision.collider: PlaneLockedCollider | null
PlaneLockedCharacterCollision.translationDeltaApplied: Vec3Like
PlaneLockedCharacterCollision.translationDeltaRemaining: Vec3Like
PlaneLockedCharacterCollision.toi: number
PlaneLockedCharacterCollision.witness1: Vec3Like
PlaneLockedCharacterCollision.witness2: Vec3Like
PlaneLockedCharacterCollision.normal1: Vec3Like
PlaneLockedCharacterCollision.normal2: Vec3Like
class PlaneLockedCharacterController — The shared Rapier 2D `KinematicCharacterController` behind the 3D surface the
PlaneLockedCharacterController.constructor(readonly raw: RAPIER2D.KinematicCharacterController, private readonly owner: PlaneLockedPhysics)
PlaneLockedCharacterController.computeColliderMovement(collider: unknown, desired: Vec3Like, filterFlags?: number, filterGroups?: number, filterPredicate?: (collider: PlaneLockedCollider) => boolean): void
PlaneLockedCharacterController.computedMovement(): Vec3Like
PlaneLockedCharacterController.computedGrounded(): boolean
PlaneLockedCharacterController.numComputedCollisions(): number
PlaneLockedCharacterController.computedCollision(i: number): PlaneLockedCharacterCollision | null
PlaneLockedCharacterController.enableAutostep(maxHeight: number, minWidth: number, includeDynamicBodies: boolean): void
PlaneLockedCharacterController.disableAutostep(): void
PlaneLockedCharacterController.autostepEnabled(): boolean
PlaneLockedCharacterController.enableSnapToGround(distance: number): void
PlaneLockedCharacterController.disableSnapToGround(): void
PlaneLockedCharacterController.snapToGroundEnabled(): boolean
PlaneLockedCharacterController.setSlideEnabled(enabled: boolean): void
PlaneLockedCharacterController.slideEnabled(): boolean
PlaneLockedCharacterController.setApplyImpulsesToDynamicBodies(enabled: boolean): void
PlaneLockedCharacterController.setCharacterMass(mass: number): void
PlaneLockedCharacterController.setMaxSlopeClimbAngle(angle: number): void
PlaneLockedCharacterController.setMinSlopeSlideAngle(angle: number): void
PlaneLockedCharacterController.setNormalNudgeFactor(factor: number): void
PlaneLockedCharacterController.offset(): number
PlaneLockedCharacterController.setOffset(value: number): void
class PlaneLockedPhysics — The 3D `PhysicsWorld` surface over a `PhysicsWorld2D`. Construct through
PlaneLockedPhysics.[BRAND]
PlaneLockedPhysics.lane
PlaneLockedPhysics.orientation: PlaneOrientation
PlaneLockedPhysics.planeZ: number
PlaneLockedPhysics.ground: TopDownGround | null
PlaneLockedPhysics.lastStepSubstepCount
PlaneLockedPhysics.constructor(readonly world2D: PhysicsWorld2D, plane: PhysicsPlane)
PlaneLockedPhysics.getPhysicsWorld2D(): PhysicsWorld2D
PlaneLockedPhysics.project(v: Vec3In): Vec2Like
PlaneLockedPhysics.projectDir(v: Vec3In): Vec2Like
PlaneLockedPhysics.lift(p: Vec2Like, offPlane: number): Vec3Like
PlaneLockedPhysics.liftDir(p: Vec2Like): Vec3Like
PlaneLockedPhysics.defaultOffPlane(): number
PlaneLockedPhysics.storeOffPlane(body: PlaneLockedBody, p: Vec3In): void
PlaneLockedPhysics.spinToQuat(a: number): QuatLike
PlaneLockedPhysics.quatToSpin(q: QuatLike): number
PlaneLockedPhysics.spinToAngvel(a: number): Vec3Like
PlaneLockedPhysics.angvelToSpin(v: { x?: number; y?: number; z?: number }): number
PlaneLockedPhysics.wrapBody(raw: RAPIER2D.RigidBody, offPlane: number = this.defaultOffPlane()): PlaneLockedBody
PlaneLockedPhysics.wrapCollider(raw: RAPIER2D.Collider): PlaneLockedCollider
PlaneLockedPhysics.unwrapBody(body: unknown): RAPIER2D.RigidBody
PlaneLockedPhysics.unwrapCollider(collider: unknown): RAPIER2D.Collider
PlaneLockedPhysics.createCharacterCapsule(options: CharacterCapsule2DOptions): PlaneLockedBody
PlaneLockedPhysics.createEnvironmentBody(options: EnvironmentBody2DOptions): { body: PlaneLockedBody; colliders: PlaneLockedCollider[] }
PlaneLockedPhysics.attachEnvironmentColliders(body: PlaneLockedBody, options: EnvironmentColliders2DOptions, targetMass: number | null = null): PlaneLockedCollider[]
PlaneLockedPhysics.createSensorBall(options: SensorBall2DOptions): { body: PlaneLockedBody; collider: PlaneLockedCollider }
PlaneLockedPhysics.attachSensorBall(body: unknown, options: { radius: number; collisionGroups: number }): PlaneLockedCollider
PlaneLockedPhysics.createProjectileBody(options: ProjectileBody2DOptions): PlaneLockedBody
PlaneLockedPhysics.addRigidBody(_body: unknown): void
PlaneLockedPhysics.removeRigidBody(body: unknown): void
PlaneLockedPhysics.removeRigidBodyImmediate(body: unknown): void
PlaneLockedPhysics.removeCollider(collider: unknown): void
PlaneLockedPhysics.removeColliderImmediate(collider: unknown): void
PlaneLockedPhysics.setUserData(body: unknown, userData: unknown): void
PlaneLockedPhysics.getUserData(body: unknown): unknown
PlaneLockedPhysics.getUserDataFromHandle(handle: number): unknown
PlaneLockedPhysics.forEachUserData(callback: (handle: number, userData: unknown) => void): void
PlaneLockedPhysics.getBodyTranslation(handle: number): Vec3Like | null
PlaneLockedPhysics.raycast(origin: Vec3Like, direction: Vec3Like, maxDistance: number = 1000, collisionMask: number = 0xFFFF, out?: RaycastResult): RaycastResult
PlaneLockedPhysics.raycastWithFilter(origin: Vec3Like, direction: Vec3Like, maxDistance: number, filterGroups: number, filterMask: number, excludeBodies?: unknown[], out?: RaycastResult): RaycastResult
PlaneLockedPhysics.capsuleOverlaps(center: Vec3Like, radius: number, halfHeight: number, collisionMask: number): boolean
PlaneLockedPhysics.overlappingColliderHandles(center: Vec3Like, radius: number, halfHeight: number, collisionMask: number, out: Set<number>): Set<number>
PlaneLockedPhysics.intersectsBox(center: Vec3Like, halfExtents: Vec3Like, collisionMask: number, excludeBody?: unknown): boolean
PlaneLockedPhysics.getCharacterController(): PlaneLockedCharacterController
PlaneLockedPhysics.getBodyLinvel(handle: number): Vec3Like | null
PlaneLockedPhysics.queryEntitiesInRadius(center: Vec3Like, radius: number): Array<{ handle: number; userData: unknown; position: Vec3Like }>
PlaneLockedPhysics.computeGroupAvoidance(center: Vec3Like, radius: number, halfHeight: number, margin: number, collisionMask: number, minBodySpeed: number = 0): { x: number; z: number } | null
PlaneLockedPhysics.groundDistBelowCenter(collider: unknown, maxDist: number): number
PlaneLockedPhysics.groundSlopeUnder(collider: unknown): { tan: number; downX: number; downZ: number } | null
PlaneLockedPhysics.kinematicBodyBelowCenter(collider: unknown, maxDist: number): PlaneLockedBody | null
PlaneLockedPhysics.kinematicBodyOverlapping(collider: unknown, exclude: unknown): PlaneLockedBody | null
PlaneLockedPhysics.capsuleOverlapsStatic(collider: unknown, at: Vec3Like, shrink: number = 0.05): boolean
PlaneLockedPhysics.detectStepUp(collider: unknown, dirX: number, dirZ: number, maxStep: number, minStep: number = 0.04): number
PlaneLockedPhysics.ledgeForMantle(collider: unknown, dirX: number, _dirZ: number, minBelowCenter: number, maxBelowCenter: number): number | null
PlaneLockedPhysics.step(deltaTime: number): void
PlaneLockedPhysics.flushCollisionCallbacks(): void
PlaneLockedPhysics.getFixedTimestep(): number
PlaneLockedPhysics.getStepsTaken(): number
PlaneLockedPhysics.getInterpolationAlpha(): number
PlaneLockedPhysics.registerCollisionCallback(body: unknown, callback: (contact: ContactInfo) => void): void
PlaneLockedPhysics.unregisterCollisionCallback(body: unknown, callback: (contact: ContactInfo) => void): void
PlaneLockedPhysics.addSensorListener(listener: { onIntersectionStart: (h1: number, h2: number) => void; onIntersectionEnd: (h1: number, h2: number) => void }): void
PlaneLockedPhysics.removeSensorListener(listener: { onIntersectionStart: (h1: number, h2: number) => void; onIntersectionEnd: (h1: number, h2: number) => void }): void
PlaneLockedPhysics.quarantineBody(_body: unknown): void
PlaneLockedPhysics.setColliderUserData(collider: unknown, userData: unknown): void
PlaneLockedPhysics.getColliderUserData(collider: unknown): unknown
PlaneLockedPhysics.getColliderUserDataFromHandle(handle: number): unknown
PlaneLockedPhysics.dispose(): void
PlaneLockedPhysics.registerPreSolveCallback(_callback: (dt: number) => void): void
PlaneLockedPhysics.unregisterPreSolveCallback(_callback: (dt: number) => void): void
PlaneLockedPhysics.forEachActiveRigidBody(callback: (body: PlaneLockedBody) => void): void
PlaneLockedPhysics.registerPreStepCallback(callback: (dt: number) => void): void
PlaneLockedPhysics.unregisterPreStepCallback(callback: (dt: number) => void): void
PlaneLockedPhysics.registerPostStepCallback(callback: () => void): void
PlaneLockedPhysics.unregisterPostStepCallback(callback: () => void): void
PlaneLockedPhysics.getGravity(): THREE.Vector3
PlaneLockedPhysics.setGravity(gravity: Vec3Like): void
PlaneLockedPhysics.getStats(): { rigidBodyCount: number; colliderCount: number }
PlaneLockedPhysics.isDisposed(): boolean
PlaneLockedPhysics.isHalted(): boolean
PlaneLockedPhysics.setSimulationActive(_active: boolean): void
PlaneLockedPhysics.getRapierWorld(): never
function createPlaneLockedPhysics(world2D: PhysicsWorld2D, plane: number | PhysicsPlane): PlaneLockedPhysics
function isPlaneLockedPhysics(world: unknown): world is PlaneLockedPhysics
function isPlaneLockedBody(body: unknown): body is PlaneLockedBody
function asPlayerPhysics(facade: PlaneLockedPhysics): PhysicsWorld
function queryPhysicsFor(engine: { physicsWorld: PhysicsWorld | null; getPlaneLockedPhysics?: () => PlaneLockedPhysics | null } | null | undefined): PhysicsWorld | null

## engine/physics/QueryFilter.ts
const QUERY_EXCLUDE_SENSORS = 8

## engine/physics/RapierPhysics.ts
function initRapier(): Promise<typeof RAPIER>
function getRapier(): typeof RAPIER
function isRapierReady(): boolean

## engine/physics/RapierPhysics2D.ts
function initRapier2D(): Promise<typeof RAPIER2D>
function getRapier2D(): typeof RAPIER2D
function isRapier2DReady(): boolean

## engine/physics/RapierReentrancyGuard.ts
function guardEnabled(): boolean
function rearmBorrowReporting(): void
function installRapierReentrancyGuard(): void

## engine/physics/RapierVehicle.ts
const DEFAULT_WHEEL_SIDE_FRICTION_STIFFNESS = 1.0
interface WheelConfig
WheelConfig.position: THREE.Vector3
WheelConfig.radius: number
WheelConfig.width: number
WheelConfig.suspensionRestLength: number
WheelConfig.suspensionStiffness: number
WheelConfig.suspensionDamping: number
WheelConfig.friction: number
WheelConfig.sideFrictionStiffness?: number
WheelConfig.isDriven: boolean
WheelConfig.isSteering: boolean
WheelConfig.torqueRatio?: number
WheelConfig.color?: number
function createWheelConfig(position: THREE.Vector3, options?: Partial<Omit<WheelConfig, 'position'>>): WheelConfig
const DEFAULT_CHASSIS_RESTITUTION = 0.35
const DEFAULT_CHASSIS_FRICTION = 0.15
interface VehicleConfig
VehicleConfig.chassisSize: { width: number; height: number; length: number }
VehicleConfig.mass: number
VehicleConfig.engineForce: number
VehicleConfig.maxClimbGrade?: number
VehicleConfig.centerOfMassOffset: number
VehicleConfig.chassisRestitution?: number
VehicleConfig.chassisFriction?: number
VehicleConfig.bodySway?: false | Partial<VehicleBodySwayOptions>
VehicleConfig.wheels?: WheelConfig[]
VehicleConfig.wheelRadius?: number
VehicleConfig.wheelWidth?: number
VehicleConfig.wheelPositions?: THREE.Vector3[]
VehicleConfig.suspensionRestLength?: number
VehicleConfig.suspensionStiffness?: number
VehicleConfig.suspensionDamping?: number
VehicleConfig.friction?: number
VehicleConfig.position: THREE.Vector3
VehicleConfig.spawnRotation?: number
VehicleConfig.chassisColor?: number
VehicleConfig.wheelColor?: number
VehicleConfig.renderer?: VehicleRenderer
VehicleConfig.handling?: VehicleHandlingConfig
VehicleConfig.disableTipOverGuard?: boolean
VehicleConfig.disableWheelGuards?: boolean
interface VehicleControls
VehicleControls.forward: boolean
VehicleControls.backward: boolean
VehicleControls.left: boolean
VehicleControls.right: boolean
VehicleControls.brake: boolean
VehicleControls.steer?: number
VehicleControls.throttle?: number
VehicleControls.brakeAmount?: number
interface VehicleCharacterImpactEvent — Fired when a player/NPC/animal enters the vehicle's impact-sensor volume.
VehicleCharacterImpactEvent.vehicle: RapierVehicle
VehicleCharacterImpactEvent.characterBody: RAPIER.RigidBody
VehicleCharacterImpactEvent.characterType: 'player' | 'npc' | 'animal'
VehicleCharacterImpactEvent.relativeSpeed: number
VehicleCharacterImpactEvent.vehicleSpeed: number
VehicleCharacterImpactEvent.impactPoint: THREE.Vector3
VehicleCharacterImpactEvent.mass: number
interface VehicleBodyPart
VehicleBodyPart.position: THREE.Vector3
VehicleBodyPart.size: { width: number; height: number; length: number }
VehicleBodyPart.mass?: number
interface WheelTerrainInfo — Per-wheel terrain information, updated each physics step.
WheelTerrainInfo.inContact: boolean
WheelTerrainInfo.contactPosition: THREE.Vector3
WheelTerrainInfo.blockType: number
WheelTerrainInfo.terrainTypeId: number
WheelTerrainInfo.groundType: number
WheelTerrainInfo.grip: number
WheelTerrainInfo.slip: number
WheelTerrainInfo.isDriven: boolean
WheelTerrainInfo.isSteering: boolean
function getActiveRapierVehicles(): ReadonlySet<RapierVehicle>
class RapierVehicle implements Interactable, ChunkManagedObject
RapierVehicle.constructor(engine: EngineLike, config: VehicleConfig)
RapierVehicle.onCharacterImpact(callback: (event: VehicleCharacterImpactEvent) => void): () => void
RapierVehicle.addBodyVisual(object: THREE.Object3D): void
RapierVehicle.addBodyPhysics(bodyPart: VehicleBodyPart): void
RapierVehicle.addBodyPhysicsBatch(bodyParts: VehicleBodyPart[]): void
RapierVehicle.rebuildPhysicsMass(): void
RapierVehicle.getChassisGroup(): THREE.Object3D
RapierVehicle.getPlatformConfig(): VehicleConfig
RapierVehicle.getWheelConfigs(): WheelConfig[]
RapierVehicle.updateControls(controls: VehicleControls, deltaTime: number = 0.016): void
RapierVehicle.physicsUpdate(dt: number): void
RapierVehicle.getWheelTerrainInfo(): readonly WheelTerrainInfo[]
RapierVehicle.setWheelFrictionSlip(wheelIndex: number, frictionSlip: number): void
RapierVehicle.setWheelSideFrictionStiffness(wheelIndex: number, stiffness: number): void
RapierVehicle.getWheelSideFrictionStiffness(wheelIndex: number): number
RapierVehicle.getWheelCount(): number
RapierVehicle.getWheelRotation(wheelIndex: number): number
RapierVehicle.captureInterpolationState(): void
RapierVehicle.visualUpdate(): void
RapierVehicle.setBodySway(options: Partial<VehicleBodySwayOptions> | null): void
RapierVehicle.update(): void
RapierVehicle.getPosition(): THREE.Vector3
RapierVehicle.getChassisObject(): THREE.Object3D
RapierVehicle.getFootprint(): VehicleFootprint
RapierVehicle.getMaxClimbGrade(): number
RapierVehicle.getMaxStepHeight(): number
RapierVehicle.probePath(fromX: number, fromZ: number, toX: number, toZ: number): VehiclePassResult
RapierVehicle.getSizeFactor(): number
RapierVehicle.getHandling(): Required<VehicleHandlingConfig>
RapierVehicle.setHandling(overrides: VehicleHandlingConfig): void
RapierVehicle.resetHandling(): void
RapierVehicle.isNearPosition(position: THREE.Vector3, maxDistance: number = 3.0): boolean
RapierVehicle.canPlayerEnter(): boolean
RapierVehicle.exitVehicle(): unknown
RapierVehicle.isPlayerInVehicle(): boolean
RapierVehicle.getCurrentDriver(): unknown
RapierVehicle.onInteractStart(): boolean
RapierVehicle.onInteractEnd(): void
RapierVehicle.getInteractStartDisplayName(): string
RapierVehicle.getInteractEndDisplayName(): string
RapierVehicle.applyImpulse(x: number, y: number, z: number): void
RapierVehicle.applyLocalImpulse(x: number, y: number, z: number): void
RapierVehicle.applyForce(x: number, y: number, z: number): void
RapierVehicle.applyTorque(x: number, y: number, z: number): void
RapierVehicle.getChassisBody(): RAPIER.RigidBody | null
RapierVehicle.setAIControls(controls: VehicleControls): void
RapierVehicle.setDrivingComponent(comp: IVehicleDrivingComponent | null): void
RapierVehicle.setParkingBrake(engaged: boolean): void
RapierVehicle.isParkingBrakeEngaged(): boolean
RapierVehicle.getDrivingComponent(): IVehicleDrivingComponent | null
RapierVehicle.updateAI(deltaTime: number): void
RapierVehicle.getLinearVelocity(): THREE.Vector3
RapierVehicle.getSpeed(): number
RapierVehicle.getForwardSpeed(): number
RapierVehicle.getSteeringAngle(): number
RapierVehicle.getAngularVelocity(): THREE.Vector3
RapierVehicle.isGrounded(): boolean
RapierVehicle.getUpDirection(): THREE.Vector3
RapierVehicle.getForwardDirection(): THREE.Vector3
RapierVehicle.setYawRotation(radians: number): void
RapierVehicle.teleportTo(position: { x: number; y: number; z: number }, heading?: number): void
RapierVehicle.getMass(): number
RapierVehicle.getChassisCollider(): RAPIER.Collider | null
RapierVehicle.getCollisionHalfExtents(): { x: number; y: number; z: number } | null
RapierVehicle.isDriverControlled(): boolean
RapierVehicle.getIsTwoWheeled(): boolean
RapierVehicle.getEngineForce(): number
RapierVehicle.getSteering(): number
RapierVehicle.getBrakingForce(): number
RapierVehicle.getMaxEngineForce(): number
RapierVehicle.getMaxBrakingForce(): number
RapierVehicle.getMaxSteering(): number
RapierVehicle.setControlsExtension(extension: VehicleControlsExtension | null): void
RapierVehicle.getControlsExtension(): VehicleControlsExtension | null
RapierVehicle.hibernate(): void
RapierVehicle.wake(): void
RapierVehicle.isHibernating(): boolean
RapierVehicle.setAlwaysActive(active: boolean): void
RapierVehicle.isAlwaysActive(): boolean
RapierVehicle.holdPhysicsUntilReady(): void
RapierVehicle.releasePhysics(): void
RapierVehicle.dispose(): void

## engine/physics/TopDownGround.ts
const TOP_DOWN_STEP_MAX_M = 0.65
const TOP_DOWN_HEAD_CLEARANCE_M = 2.0
const TOP_DOWN_SNAP_DOWN_M = 0.5
const CLIFF_WALL_HALF_THICKNESS_M = 0.05
const GROUND_PLANE_MIN_CELL_M = 0.25
const NO_GROUND = -Infinity
interface VerticalMove
VerticalMove.dy: number
VerticalMove.grounded: boolean
function resolveVerticalMove(centerY: number, desiredDy: number, restY: number | null, wasGrounded: boolean): VerticalMove
function columnIndex(lx: number, lz: number): number
function columnTopsFromBoxes(boxes: readonly CollisionBox[], voxelSize: number, chunkWorldY: number): Float32Array
interface GroundRect — A walkable surface patch in world space (its top face), for `TopDownGround.setSourceRects`.
GroundRect.minX: number
GroundRect.maxX: number
GroundRect.minZ: number
GroundRect.maxZ: number
GroundRect.topY: number
interface CliffWall — One cliff wall, world space: centre, half extents (X and Z), and the two floor heights it separates.
CliffWall.x: number
CliffWall.z: number
CliffWall.hx: number
CliffWall.hz: number
CliffWall.top: number
CliffWall.low: number
function cliffWallsForStack(merged: Float32Array, rightEdge: Float32Array | null, frontEdge: Float32Array | null, originX: number, originZ: number, voxelSize: number): CliffWall[]
function stackKey(cx: number, cz: number): string
class TopDownGround — The ground of one top-down game: column heightmap + cliff walls, kept in
TopDownGround.constructor(private readonly world2D: PhysicsWorld2D)
TopDownGround.setGrid(minX: number, minY: number, minZ: number, voxelSize: number): void
TopDownGround.getGrid(): { minX: number; minY: number; minZ: number; voxelSize: number } | null
TopDownGround.setChunkTops(key: ChunkKey, cx: number, cy: number, cz: number, boxes: readonly CollisionBox[] | null): void
TopDownGround.setSourceRects(sourceId: string, rects: readonly GroundRect[]): void
TopDownGround.setSourceTriangles(sourceId: string, verts: Float32Array, indices: ArrayLike<number>): void
TopDownGround.removeSource(sourceId: string): void
TopDownGround.heightAt(x: number, z: number): number | null
TopDownGround.wallTopOf(colliderHandle: number): number | undefined
TopDownGround.ledgeBlocks(colliderHandle: number, y: number, allowance: number = TOP_DOWN_STEP_MAX_M): boolean
TopDownGround.setStackEnabled(key: string, enabled: boolean): void
TopDownGround.wallCount(): number
TopDownGround.clear(): void
TopDownGround.dispose(): void

## engine/physics/TrappedBodies.ts
function movesAwayFrom(move: { x: number; z: number }, self: { x: number; z: number }, other: { x: number; z: number }): boolean

## engine/physics/VoxelColliders.ts
type VoxelColliderMode = 'trimesh' | 'voxels'
const DEFAULT_VOXEL_COLLIDER_MODE: VoxelColliderMode
function installVoxelColliderMode(mode: VoxelColliderMode | null): void
function getVoxelColliderMode(): VoxelColliderMode
function voxelCollidersEnabled(): boolean
interface IntBoxRun — The integer box runs every greedy mesher in the engine produces: min corner
IntBoxRun.x: number
IntBoxRun.y: number
IntBoxRun.z: number
IntBoxRun.w: number
IntBoxRun.h: number
IntBoxRun.d: number
function cellsFromIntBoxes(boxes: readonly IntBoxRun[], offX: number = 0, offY: number = 0, offZ: number = 0): Int32Array
function cellsFromDenseGrid(grid: Uint8Array, nx: number, ny: number, nz: number): Int32Array
function voxelsDesc(cells: Int32Array, sizeX: number, sizeY: number, sizeZ: number, tx: number, ty: number, tz: number): RAPIER.ColliderDesc
interface CellShift — Offset from collider `a`'s cell (0,0,0) to collider `b`'s, in whole cells.
CellShift.x: number
CellShift.y: number
CellShift.z: number
function coupleVoxelColliders(a: RAPIER.Collider, b: RAPIER.Collider, shift: CellShift): void
function decoupleVoxelFace(doomed: RAPIER.Collider, cells: Int32Array, neighbour: RAPIER.Collider, shift: CellShift, axis: 0 | 1 | 2, faceCoord: number): number
interface ChunkVoxelCollider — A chunk's voxels collider with the cell set it was built from — what decoupling needs.
ChunkVoxelCollider.collider: RAPIER.Collider
ChunkVoxelCollider.cells: Int32Array
const CHUNK_FACE_NEIGHBOURS: ReadonlyArray<readonly [number, number, number]>
const CHUNK_POSITIVE_NEIGHBOURS: ReadonlyArray<readonly [number, number, number]>
function coupleChunkVoxelColliders(own: readonly RAPIER.Collider[], cellsPerChunk: number, neighbourAt: (dx: number, dy: number, dz: number) => readonly RAPIER.Collider[] | undefined, dirs: ReadonlyArray<readonly [number, number, number]> = CHUNK_FACE_NEIGHBOURS): void
function decoupleChunkVoxelColliders(own: readonly ChunkVoxelCollider[], cellsPerChunk: number, neighbourAt: (dx: number, dy: number, dz: number) => readonly RAPIER.Collider[] | undefined): void

## engine/physics/VoxelPhysics2D.ts
interface ZSlice
ZSlice.min: number
ZSlice.max: number
type ExplosionWorldCenter2D = { x: number; y: number; z?: number }
interface VoxelBody2D
VoxelBody2D.body: RAPIER2D.RigidBody
VoxelBody2D.colliders: RAPIER2D.Collider[]
VoxelBody2D.voxelObject: VoxelObject
interface Debris2D
Debris2D.body: RAPIER2D.RigidBody
Debris2D.mesh: THREE.Mesh
Debris2D.spawnTime: number
Debris2D.fadeOffset?: number
function createVoxelColliders2D(voxelObj: VoxelObject, physicsWorld: PhysicsWorld2D, position: { x: number; y: number }, collisionGroups?: number, zSlice?: ZSlice): VoxelBody2D
function rebuildVoxelColliders2D(voxelBody: VoxelBody2D, physicsWorld: PhysicsWorld2D, collisionGroups?: number, zSlice?: ZSlice): RAPIER2D.Collider[] | null
function explodeVoxelObject2D(voxelBody: VoxelBody2D, worldCenter: ExplosionWorldCenter2D, radius: number, physicsWorld: PhysicsWorld2D, scene: THREE.Scene, impulseStrength: number = 5, collisionGroups?: number, zSlice?: ZSlice): Debris2D[]
function applyExplosionImpulseToDebris2D(debris: Debris2D[], centerX: number, centerY: number, radius: number, impulseStrength: number): void
function applyFootKickDebris2D(debris: Debris2D[], feetX: number, feetY: number, velocityX: number, deltaTime: number): void
function updateDebris2D(debris: Debris2D[], physicsWorld: PhysicsWorld2D, scene: THREE.Scene, maxLifetime: number = 4000, minY: number = -50): Debris2D[]

## engine/physics/VoxelTerrain2D.ts
interface GameplaySlice — The slab of world-Z that counts as "on the gameplay plane".
GameplaySlice.z: number
GameplaySlice.halfDepth: number
interface VoxelTerrain2DOptions
VoxelTerrain2DOptions.voxelSize: number
VoxelTerrain2DOptions.chunkWorldX: number
VoxelTerrain2DOptions.chunkWorldY: number
VoxelTerrain2DOptions.chunkWorldZ: number
VoxelTerrain2DOptions.slice: GameplaySlice
VoxelTerrain2DOptions.frictionForBlock?: (blockType: number | undefined) => number
interface Cuboid2D — One emitted cuboid, in world space. Exported for testing without a physics world.
Cuboid2D.x: number
Cuboid2D.y: number
Cuboid2D.hx: number
Cuboid2D.hy: number
Cuboid2D.blockType?: number
function sliceBoxesToPlane(boxes: readonly CollisionBox[], options: VoxelTerrain2DOptions): Cuboid2D[]
function buildChunkColliders2D(world: PhysicsWorld2D, body: RAPIER2D.RigidBody, boxes: readonly CollisionBox[], options: VoxelTerrain2DOptions): RAPIER2D.Collider[]

## engine/physics/VoxelTerrain2DBridge.ts
interface TerrainGridBounds
TerrainGridBounds.minX: number
TerrainGridBounds.minY: number
TerrainGridBounds.minZ: number
TerrainGridBounds.maxX: number
TerrainGridBounds.maxY: number
TerrainGridBounds.maxZ: number
interface TerrainGridSource — The voxel-grid facts the bridge needs; `VoxelWorld` satisfies it structurally.
TerrainGridSource.getBounds(): TerrainGridBounds | null
TerrainGridSource.getVoxelSize(): number
interface VoxelTerrain2DBridgeOptions
VoxelTerrain2DBridgeOptions.world2D: PhysicsWorld2D
VoxelTerrain2DBridgeOptions.grid: TerrainGridSource
VoxelTerrain2DBridgeOptions.planeZ: number
VoxelTerrain2DBridgeOptions.frictionForBlock: (blockType: number | undefined) => number
VoxelTerrain2DBridgeOptions.ground?: TopDownGround | null
const DEFAULT_TERRAIN_FRICTION_2D = 0.5
function gameplaySliceFor(minZ: number, voxelSize: number, planeZ: number): GameplaySlice
function chunkColumnKey(cx: number, cz: number): string
class VoxelTerrain2DBridge
VoxelTerrain2DBridge.constructor(private readonly options: VoxelTerrain2DBridgeOptions)
VoxelTerrain2DBridge.getSlice(): GameplaySlice | null
VoxelTerrain2DBridge.onChunkRebuilt(key: ChunkKey, boxes: readonly CollisionBox[] | null, cx: number, cy: number, cz: number): void
VoxelTerrain2DBridge.setColumnEnabled(chunkKey2D: string, enabled: boolean): void
VoxelTerrain2DBridge.colliderCount(): number
VoxelTerrain2DBridge.dispose(): void

## engine/physics/chassisFootprint.ts
interface Vec3Like — Exact ground-plane (XZ) separation between two oriented chassis boxes —
Vec3Like.x: number
Vec3Like.y: number
Vec3Like.z: number
interface QuatLike
QuatLike.x: number
QuatLike.y: number
QuatLike.z: number
QuatLike.w: number
interface BoxFootprint — Ground-plane shadow of an oriented box, plus its world vertical span.
BoxFootprint.cx: number
BoxFootprint.cz: number
BoxFootprint.axes: Array<{ x: number; z: number }>
BoxFootprint.minY: number
BoxFootprint.maxY: number
BoxFootprint.radius: number
interface FootprintSeparation — Separation of two footprints along the best separating axis.
FootprintSeparation.gap: number
FootprintSeparation.nx: number
FootprintSeparation.nz: number
function boxFootprint(center: Vec3Like, rotation: QuatLike, halfExtents: Vec3Like): BoxFootprint
function footprintSeparation(a: BoxFootprint, b: BoxFootprint): FootprintSeparation
function verticalOverlap(a: BoxFootprint, b: BoxFootprint): number

## engine/physics/vehicleStability.ts
const TIP_FORCE_MARGIN = 0.75
interface TipGeometry — Static, per-vehicle tip geometry (chassis-local, from the wheel layout).
TipGeometry.minWheelZ: number
TipGeometry.maxWheelZ: number
TipGeometry.staticContactY: number
function maxTipSafeDriveForce(mass: number, gravity: number, comHeight: number, comZ: number, geometry: TipGeometry, forward: boolean, margin: number = TIP_FORCE_MARGIN): number
