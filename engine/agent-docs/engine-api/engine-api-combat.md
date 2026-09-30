# engine-api-combat

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/AttackVFX.ts
interface ImpactEffectConfig — Configuration for impact effects
ImpactEffectConfig.particleCount?: number
ImpactEffectConfig.duration?: number
ImpactEffectConfig.color?: { r: number; g: number; b: number }
ImpactEffectConfig.minSize?: number
ImpactEffectConfig.maxSize?: number
ImpactEffectConfig.spreadAngle?: number
ImpactEffectConfig.minSpeed?: number
ImpactEffectConfig.maxSpeed?: number
ImpactEffectConfig.gravity?: number
ImpactEffectConfig.seed?: number | null
ImpactEffectConfig.variance?: number
ImpactEffectConfig.drag?: number
ImpactEffectConfig.material?: 'spark' | 'debris'
ImpactEffectConfig.stretch?: number
const DEFAULT_IMPACT_EFFECT: Required<ImpactEffectConfig>
const IMPACT_EFFECT_PRESETS = { metal: DEFAULT_IMPACT_EFFECT, stone: { ...DEFAULT_IMPACT_E
class AttackVFX — Attack VFX System
AttackVFX.constructor(scene: THREE.Scene, impactConfig?: ImpactEffectConfig)
AttackVFX.updateImpactConfig(config: Partial<ImpactEffectConfig>): void
AttackVFX.getImpactConfig(): Required<ImpactEffectConfig>
AttackVFX.createAttackTrail(player: THREE.Object3D, duration: number, animationName: string): void
AttackVFX.createImpactEffect(position: THREE.Vector3, normal: THREE.Vector3): void
AttackVFX.update(deltaTime: number): void
AttackVFX.dispose(): void

## engine/BallSportsSystem.ts
interface BallSportsOptions — BallSportsSystem — kicking a dynamic ball prop in ball-sports games (soccer,
BallSportsOptions.ballName: string
BallSportsOptions.actionName: string
BallSportsOptions.kickAnimation: string
BallSportsOptions.kickSpeed: number
BallSportsOptions.kickLift: number
BallSportsOptions.spin: number
BallSportsOptions.kickRange: number
BallSportsOptions.cooldown: number
BallSportsOptions.contactSlack: number
const DEFAULT_BALL_SPORTS_OPTIONS: BallSportsOptions
class BallSportsSystem
BallSportsSystem.constructor(playerController: PlayerController, options?: Partial<BallSportsOptions>)
BallSportsSystem.getBallBody(): RAPIER.RigidBody | null
BallSportsSystem.getBallObject(): VoxelObject | null
BallSportsSystem.resetBall(x: number, y: number, z: number): void
BallSportsSystem.update(deltaTime: number): void
BallSportsSystem.dispose(): void

## engine/ExampleCannon.ts
class ExampleCannon implements Interactable — Example cannon implementation for testing ShootableComponent
ExampleCannon.group: THREE.Group
ExampleCannon.shootable: ShootableComponent
ExampleCannon.constructor(engine: EngineLike)
ExampleCannon.onInteractStart(): boolean
ExampleCannon.getInteractStartDisplayName(): string
ExampleCannon.interactionEnabled(): boolean
ExampleCannon.fire()
ExampleCannon.update(deltaTime: number = 0.016)
ExampleCannon.aimAt(target: THREE.Vector3)
ExampleCannon.setPosition(x: number, y: number, z: number)
ExampleCannon.dispose()

## engine/FirstPersonMeleeSystem.ts
interface FirstPersonMeleeOptions — First-person melee combat — NO skeleton, NO animation clips.
FirstPersonMeleeOptions.weaponType: WeaponTypeId
FirstPersonMeleeOptions.reachScale: number
FirstPersonMeleeOptions.swingDuration: number
FirstPersonMeleeOptions.rig?: Partial<ViewModelRigOptions>
const DEFAULT_FIRST_PERSON_MELEE_OPTIONS: FirstPersonMeleeOptions
class FirstPersonMeleeSystem implements IPlayerAttack
FirstPersonMeleeSystem.constructor(engine: EngineLike, options: FirstPersonMeleeOptions)
FirstPersonMeleeSystem.equipWeapon(weaponType: WeaponTypeId): void
FirstPersonMeleeSystem.unequipWeapon(): void
FirstPersonMeleeSystem.getWeaponPreset(): WeaponPreset | null
FirstPersonMeleeSystem.setController(controller: PlayerController): void
FirstPersonMeleeSystem.setupEventListeners(): void
FirstPersonMeleeSystem.removeEventListeners(): void
FirstPersonMeleeSystem.setMobileControls(mobileControls: unknown): void
FirstPersonMeleeSystem.getActionHandler(): AttackActionHandler
FirstPersonMeleeSystem.triggerSwing(): void
FirstPersonMeleeSystem.update(deltaTime: number): boolean
FirstPersonMeleeSystem.dispose(): void

## engine/FirstPersonWeaponSystem.ts
interface FirstPersonAdsOptions — Aim-down-sights configuration.
FirstPersonAdsOptions.fovNarrowDegrees: number
FirstPersonAdsOptions.sensitivityScale: number | null
FirstPersonAdsOptions.hideReticle: boolean
FirstPersonAdsOptions.bindRightMouse: boolean
FirstPersonAdsOptions.desktopKeys: string[]
interface FirstPersonWeaponOptions
FirstPersonWeaponOptions.weaponType: RangedWeaponTypeId
FirstPersonWeaponOptions.ads: FirstPersonAdsOptions | null
FirstPersonWeaponOptions.muzzleFlash: MuzzleFlashOptions | null
FirstPersonWeaponOptions.shellEjection: ShellEjectionOptions | null
FirstPersonWeaponOptions.dynamicCrosshair: boolean
FirstPersonWeaponOptions.magazine: IWeaponMagazine | null
FirstPersonWeaponOptions.recoil: RecoilProfile | null
FirstPersonWeaponOptions.rig: Partial<ViewModelRigOptions>
FirstPersonWeaponOptions.recoilSeed: number
const DEFAULT_FIRST_PERSON_ADS_OPTIONS: FirstPersonAdsOptions
const DEFAULT_FIRST_PERSON_WEAPON_OPTIONS: FirstPersonWeaponOptions
class FirstPersonWeaponSystem implements IPlayerAttack
FirstPersonWeaponSystem.onProjectileCreated: ((projectile: Projectile) => void) | null
FirstPersonWeaponSystem.constructor(engine: EngineLike, physicsWorld: PhysicsWorld, options: FirstPersonWeaponOptions)
FirstPersonWeaponSystem.equipWeapon(weaponType: RangedWeaponTypeId): void
FirstPersonWeaponSystem.unequipWeapon(): void
FirstPersonWeaponSystem.getWeaponType(): RangedWeaponTypeId | null
FirstPersonWeaponSystem.getWeaponPreset(): RangedWeaponPreset | null
FirstPersonWeaponSystem.getRig(): ViewModelRig
FirstPersonWeaponSystem.getMagazine(): IWeaponMagazine | null
FirstPersonWeaponSystem.isAimingDownSights(): boolean
FirstPersonWeaponSystem.setMagazine(magazine: IWeaponMagazine | null): void
FirstPersonWeaponSystem.playInspect(): void
FirstPersonWeaponSystem.setTriggerHeld(held: boolean): void
FirstPersonWeaponSystem.setAimDownSights(active: boolean): void
FirstPersonWeaponSystem.reload(): void
FirstPersonWeaponSystem.triggerShoot(): void
FirstPersonWeaponSystem.setController(controller: PlayerController): void
FirstPersonWeaponSystem.setMobileControls(mobileControls: unknown): void
FirstPersonWeaponSystem.getActionHandler(): AttackActionHandler
FirstPersonWeaponSystem.setupEventListeners(): void
FirstPersonWeaponSystem.removeEventListeners(): void
FirstPersonWeaponSystem.update(deltaTime: number): boolean
FirstPersonWeaponSystem.getProjectiles(): Projectile[]
FirstPersonWeaponSystem.removeProjectile(projectile: Projectile): void
FirstPersonWeaponSystem.dispose(): void

## engine/IDamageable.ts
interface DamageableConfig — Configuration for health and death behavior
DamageableConfig.maxHealth?: number
DamageableConfig.health?: number
DamageableConfig.canDie?: boolean
DamageableConfig.explodeOnDeath?: boolean
DamageableConfig.ragdollOnDeath?: boolean
DamageableConfig.oneHitKill?: boolean
DamageableConfig.debrisLifetimeMs?: number
interface IDamageable — Interface for entities that can receive damage
IDamageable.onMeleeHit(impactDirection?: THREE.Vector3, impulseStrength?: number): void
IDamageable.onProjectileHit?(): void
IDamageable.isExploded(): boolean
IDamageable.isDead?(): boolean
IDamageable.getHealth?(): number
IDamageable.getMaxHealth?(): number
IDamageable.takeDamage?(amount: number, source?: string): void
IDamageable.onMeleeHitEffect?(position: THREE.Vector3, direction: THREE.Vector3, damage: number): void
IDamageable.onProjectileHitEffect?(position: THREE.Vector3, direction: THREE.Vector3, damage: number): void
IDamageable.onDamage?(damage: number, currentHealth: number, maxHealth: number, source?: string): void
IDamageable.onDeathEffect?(killerDirection?: THREE.Vector3): void
const DEFAULT_DAMAGEABLE_CONFIG: Required<DamageableConfig>

## engine/IPlayerAttack.ts
interface AttackActionHandler — Action handler config returned by attack systems that want auto-setup
AttackActionHandler.actionType: string
AttackActionHandler.handler: (player: THREE.Object3D, controller: PlayerController) => void
interface IPlayerAttack — Interface for pluggable player attack systems.
IPlayerAttack.setController(controller: PlayerController): void
IPlayerAttack.setupEventListeners(): void
IPlayerAttack.removeEventListeners(): void
IPlayerAttack.setMobileControls(mobileControls: any): void
IPlayerAttack.update(deltaTime: number): boolean
IPlayerAttack.dispose(): void
IPlayerAttack.getActionHandler?(): AttackActionHandler

## engine/IWeaponMagazine.ts
interface IWeaponMagazine — Interface for weapon magazine/ammunition management.
IWeaponMagazine.tryConsume(): boolean
IWeaponMagazine.startReload(): void
IWeaponMagazine.update(): void
IWeaponMagazine.reset(magazineSize: number, reloadDuration?: number): void
IWeaponMagazine.getCurrentAmmo(): number
IWeaponMagazine.getMagazineSize(): number
IWeaponMagazine.getIsReloading(): boolean
IWeaponMagazine.getAmmoState(): { current: number; max: number; isReloading: boolean }
IWeaponMagazine.setReloadDuration(ms: number): void
IWeaponMagazine.getReloadDuration(): number
IWeaponMagazine.isAutoReloadEnabled(): boolean
IWeaponMagazine.isReloadAllowed(): boolean
IWeaponMagazine.setAutoReload(enabled: boolean): void
IWeaponMagazine.setReloadEnabled(enabled: boolean): void

## engine/MeleeSweepTargets.ts
const MELEE_SWEEP_BOUNDS_MARGIN = 1.0
function segmentPassesNear(from: THREE.Vector3, to: THREE.Vector3, pos: THREE.Vector3, reach: number): boolean
function gatherMeleeSweepCandidates(scene: THREE.Scene, from: THREE.Vector3, to: THREE.Vector3, radius: number): THREE.Object3D[]
const MELEE_BODY_HIT_MARGIN = 0.15
function gatherMeleeBodyHits(scene: THREE.Scene, from: THREE.Vector3, to: THREE.Vector3, bladeRadius: number): THREE.Intersection[]
function segmentHitsCapsule(from: THREE.Vector3, to: THREE.Vector3, center: THREE.Vector3, halfSpine: number, radius: number): boolean

## engine/MeleeWeaponMoves.ts
type MeleeWeaponMove = keyof typeof WEAPON_MOVES
const WEAPON_TYPE_MOVES: Record<string, readonly MeleeWeaponMove[]>
const GRIP_FALLBACK_MOVES: Record<'one' | 'two', readonly MeleeWeaponMove[]>
function primaryMoveFor(moves: readonly MeleeWeaponMove[]): MeleeWeaponMove | null
function weaponMovesFor(weaponType: string, grip: 'one' | 'two' | undefined): readonly MeleeWeaponMove[]
interface AttackMoveRegistrar — The move-registration surface of an animation controller. Structural because the two
AttackMoveRegistrar.registerCustomAttack?: (move: CustomAttackMove) => boolean
AttackMoveRegistrar.unregisterCustomAttack?: (name: string) => boolean
interface WeaponMoveOptions
WeaponMoveOptions.weaponType: string
WeaponMoveOptions.grip: 'one' | 'two' | undefined
WeaponMoveOptions.namePrefix: string
WeaponMoveOptions.damage: number
WeaponMoveOptions.range: number
WeaponMoveOptions.splitBodyOnRun: boolean
interface WeaponMoveRegistration
WeaponMoveRegistration.names: string[]
WeaponMoveRegistration.primaryName: string | null
function registerWeaponAttackMoves(registrar: AttackMoveRegistrar, options: WeaponMoveOptions): WeaponMoveRegistration
function unregisterWeaponAttackMoves(registrar: AttackMoveRegistrar, names: string[]): void

## engine/MeleeWeaponOrientation.ts
const BLADE_IDLE_FORWARD = new THREE.Quaternion() .setFromAxisAngle(new THREE.Vector3(1
const BLADE_SWING_TILT_RAD = -Math.PI / 6
function extractYawOnly(q: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion
function orientBladeYawFramed(weaponMesh: THREE.Object3D, characterObj: THREE.Object3D, offset: THREE.Quaternion): void
function seatGripTowardFingers(weaponMesh: THREE.Object3D, dist: number): boolean
function alignBladeToArm(weaponMesh: THREE.Object3D, characterObj: THREE.Object3D, tiltRad: number = BLADE_SWING_TILT_RAD): boolean
function rollEdgeToLead(weaponMesh: THREE.Object3D, tipTravelWorld: THREE.Vector3, minTravel: number = 1e-3): boolean

## engine/Projectile.ts
function registerPlayerBodyForProjectiles(body: RAPIER.RigidBody): void
function unregisterPlayerBodyForProjectiles(body: RAPIER.RigidBody): void
enum ProjectileType { WAVE_REVEAL, DESTRUCTION }
interface ExplosionConfig
ExplosionConfig.enabled: boolean
ExplosionConfig.radius: number
ExplosionConfig.duration: number
ExplosionConfig.color?: number
ExplosionConfig.damage?: number
ExplosionConfig.damageRadius?: number
ExplosionConfig.visualStyle?: ExplosionStyle
ExplosionConfig.seed?: number
ExplosionConfig.preset?: ExplosionPreset
ExplosionConfig.amount?: number
ExplosionConfig.variance?: number
ExplosionConfig.quality?: ExplosionVisualOptions['quality']
ExplosionConfig.layers?: ExplosionVisualOptions['layers']
interface ProjectileVisualConfig
ProjectileVisualConfig.geometry?: THREE.BufferGeometry
ProjectileVisualConfig.material?: THREE.Material
ProjectileVisualConfig.customMesh?: THREE.Object3D
ProjectileVisualConfig.castShadow?: boolean
ProjectileVisualConfig.bloomLayer?: boolean
ProjectileVisualConfig.collisionRadius?: number
ProjectileVisualConfig.trail?: { enabled: boolean; length?: number; geometry?: THREE.BufferGeometry; material?: THREE.Material; opacityFalloff?: boolean; /** Trail tint when no custom material is given (default: 0xffaa00) */ color?: number; }
ProjectileVisualConfig.explosion?: ExplosionConfig
ProjectileVisualConfig.gravityScale?: number
ProjectileVisualConfig.windVector?: { x: number; y: number; z: number }
class Projectile
Projectile.constructor(position: THREE.Vector3, direction: THREE.Vector3, speed: number, physicsWorld: EngineLike['physicsWorld'], engine: EngineLike, onHitCallback?: (projectile: Projectile, hitBody?: RAPIER.RigidBody) => void, visualConfig?: ProjectileVisualConfig, projectileType: ProjectileType = ProjectileType.WAVE_REVEAL, customCollisionMask?: number)
Projectile.getBodyHandle(): number
Projectile.hasAlreadyHit(): boolean
Projectile.handleCollision(otherBody: RAPIER.RigidBody, contactPoint: THREE.Vector3, contactNormal: THREE.Vector3): void
Projectile.updateWithoutCollisionCheck(deltaTime: number): void
Projectile.update(deltaTime: number): void
Projectile.hasExplosionFinished(): boolean
Projectile.getExplosion(): Explosion | null
Projectile.callOnHit(): void
Projectile.isExpired(): boolean
Projectile.getPosition(): THREE.Vector3
Projectile.getMesh(): THREE.Object3D
Projectile.getRigidBody(): RAPIER.RigidBody | null
Projectile.getRigidBodyHandle(): number
Projectile.getDirection(): THREE.Vector3
Projectile.getSpeed(): number
Projectile.getDamage(): number
Projectile.setDamage(damage: number): void
Projectile.getKnockback(): number
Projectile.setKnockback(knockback: number): void
Projectile.setEnemyProjectile(onPlayerHit: (projectile: Projectile) => void): this
Projectile.setOnRemoteAnimalHit(callback: ( networkId: string, damage: number, hitPosition: THREE.Vector3, hitDirection: THREE.Vector3, ) => void): this
Projectile.setOnRemoteNpcHit(callback: ( networkId: string, damage: number, hitPosition: THREE.Vector3, hitDirection: THREE.Vector3, ) => void): this
Projectile.setOnExplosionTriggered(callback: ( position: THREE.Vector3, config: ExplosionConfig, ) => void): this
Projectile.setOnAoePlayerHit(targets: ReadonlyMap<string, { getObject3D(): THREE.Object3D }>, callback: (networkId: string, damage: number) => void): this
Projectile.setDecalColor(color: number | undefined): this
Projectile.getDecalColor(): number | undefined
Projectile.getIsEnemyProjectile(): boolean
Projectile.hasHit(): boolean
Projectile.getHitPosition(): THREE.Vector3 | null
Projectile.getHitNormal(): THREE.Vector3 | null
Projectile.getHitBody(): RAPIER.RigidBody | null
Projectile.getProjectileType(): ProjectileType
Projectile.getVelocity(): THREE.Vector3
Projectile.setWindVector(windVector: { x: number; y: number; z: number } | undefined): void
Projectile.getGravityScale(): number
Projectile.dispose(): void
class Explosion — Explosion visual effect with unchanged damage calculation helpers.
Explosion.constructor(position: THREE.Vector3, config: ExplosionConfig, engine: EngineLike)
Explosion.update(deltaTime: number): void
Explosion.isFinished(): boolean
Explosion.getPosition(): THREE.Vector3
Explosion.getDamageRadius(): number
Explosion.getBaseDamage(): number
Explosion.calculateDamageAtPosition(targetPosition: THREE.Vector3): number
Explosion.getTargetsInRange<T extends { getPosition(): THREE.Vector3 }>(potentialTargets: T[]): Array<{ target: T; damage: number; distance: number }>
Explosion.dispose(): void

## engine/Projectile2D.ts
interface ProjectileVisualConfig2D
ProjectileVisualConfig2D.geometry?: THREE.BufferGeometry
ProjectileVisualConfig2D.material?: THREE.Material
ProjectileVisualConfig2D.customMesh?: THREE.Object3D
ProjectileVisualConfig2D.castShadow?: boolean
ProjectileVisualConfig2D.bloomLayer?: boolean
ProjectileVisualConfig2D.collisionRadius?: number
ProjectileVisualConfig2D.visualZ?: number
ProjectileVisualConfig2D.trail?: { enabled: boolean; length?: number; geometry?: THREE.BufferGeometry; material?: THREE.Material; opacityFalloff?: boolean; }
ProjectileVisualConfig2D.explosion?: ExplosionConfig2D
ProjectileVisualConfig2D.gravityScale?: number
ProjectileVisualConfig2D.windVector?: { x: number; y: number }
interface ExplosionConfig2D
ExplosionConfig2D.enabled: boolean
ExplosionConfig2D.radius: number
ExplosionConfig2D.duration: number
ExplosionConfig2D.color?: number
ExplosionConfig2D.damage?: number
ExplosionConfig2D.damageRadius?: number
class Projectile2D — 2D projectile using Rapier2D physics.
Projectile2D.constructor(position: { x: number; y: number }, direction: { x: number; y: number }, speed: number, physicsWorld: PhysicsWorld2D, scene: THREE.Scene, onHitCallback?: (projectile: Projectile2D, hitBody?: RAPIER2D.RigidBody) => void, visualConfig?: ProjectileVisualConfig2D, customCollisionMask?: number)
Projectile2D.update(deltaTime: number): void
Projectile2D.isExpired(): boolean
Projectile2D.hasHit(): boolean
Projectile2D.getPosition(): { x: number; y: number }
Projectile2D.getPosition3D(): THREE.Vector3
Projectile2D.getMesh(): THREE.Object3D
Projectile2D.getDirection(): { x: number; y: number }
Projectile2D.getSpeed(): number
Projectile2D.getDamage(): number
Projectile2D.setDamage(damage: number): void
Projectile2D.getIsEnemyProjectile(): boolean
Projectile2D.setEnemyProjectile(onPlayerHit: (projectile: Projectile2D) => void): this
Projectile2D.getVelocity(): { x: number; y: number }
Projectile2D.setWindVector(windVector: { x: number; y: number } | undefined): void
Projectile2D.getGravityScale(): number
Projectile2D.getHitBody(): RAPIER2D.RigidBody | null
Projectile2D.getExplosion(): Explosion2D | null
Projectile2D.getRigidBody(): RAPIER2D.RigidBody | null
Projectile2D.dispose(): void
class Explosion2D — Lightweight 2D explosion effect (visual only, no physics).
Explosion2D.constructor(position: THREE.Vector3, config: ExplosionConfig2D, scene: THREE.Scene)
Explosion2D.update(deltaTime: number): void
Explosion2D.isFinished(): boolean
Explosion2D.getPosition(): THREE.Vector3
Explosion2D.getDamageRadius(): number
Explosion2D.getBaseDamage(): number
Explosion2D.calculateDamageAtPosition(targetPos: THREE.Vector3): number
Explosion2D.dispose(): void

## engine/ProjectileManager.ts
class ProjectileManager — Centralized manager for all projectiles in the game.
static ProjectileManager.getInstance(): ProjectileManager
static ProjectileManager.hasInstance(): boolean
ProjectileManager.setPhysicsWorld(physicsWorld: PhysicsWorld): void
ProjectileManager.register(projectile: Projectile): void
ProjectileManager.update(deltaTime: number): void
ProjectileManager.getAll(): Projectile[]
ProjectileManager.getCount(): number
ProjectileManager.getEnemyProjectiles(): Projectile[]
ProjectileManager.getPlayerProjectiles(): Projectile[]
ProjectileManager.remove(projectile: Projectile, dispose: boolean = true): void
ProjectileManager.clear(): void
static ProjectileManager.dispose(): void

## engine/ProjectileManager2D.ts
class ProjectileManager2D — Centralized manager for all 2D projectiles (Physics2D genre).
static ProjectileManager2D.getInstance(): ProjectileManager2D
static ProjectileManager2D.hasInstance(): boolean
ProjectileManager2D.register(projectile: Projectile2D): void
ProjectileManager2D.update(deltaTime: number): void
ProjectileManager2D.getAll(): Projectile2D[]
ProjectileManager2D.getCount(): number
ProjectileManager2D.getEnemyProjectiles(): Projectile2D[]
ProjectileManager2D.getPlayerProjectiles(): Projectile2D[]
ProjectileManager2D.remove(projectile: Projectile2D, dispose = true): void
ProjectileManager2D.clear(): void
static ProjectileManager2D.dispose(): void

## engine/ProjectileShootSystem.ts
class ProjectileShootSystem implements IPlayerAttack — Handles projectile shooting system including:
ProjectileShootSystem.constructor(engine: EngineLike | null, physicsWorld: PhysicsWorld)
ProjectileShootSystem.setEditorTab(tab: string | null): void
ProjectileShootSystem.setController(controller: PlayerController): void
ProjectileShootSystem.setupEventListeners(): void
ProjectileShootSystem.removeEventListeners(): void
ProjectileShootSystem.setMobileControls(mobileControls: any): void
ProjectileShootSystem.update(deltaTime: number): boolean
ProjectileShootSystem.shoot(player: THREE.Object3D, cameraController: CameraController | null): void
ProjectileShootSystem.setProjectileType(type: ProjectileType): void
ProjectileShootSystem.getProjectileType(): ProjectileType
ProjectileShootSystem.getProjectiles(): Projectile[]
ProjectileShootSystem.removeProjectile(projectile: Projectile): void
ProjectileShootSystem.dispose(): void

## engine/RangedWeaponMeshes.ts
function createRocketMesh(radius: number, color: number): THREE.Group
function createArrowMesh(radius: number, color: number): THREE.Group
function createCrossbowBoltMesh(radius: number, color: number): THREE.Group
function createLaserBeamMesh(radius: number, color: number): THREE.Group
function createTracerMesh(radius: number, color: number): THREE.Group
function createPistol(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult
function createShotgun(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult
function createAssaultRifle(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult
function createBazooka(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult
function createBow(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult
function createCrossbow(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult
function createLaserBlaster(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult
function createLaserPistol(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult
function createDualWeapon(group: THREE.Group, preset: RangedWeaponPreset, baseWeaponCreator: RangedWeaponMeshCreator, weaponName: string = 'Weapon'): RangedWeaponMeshResult
function createDualPistols(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult
function createDualAssaultRifles(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult
function createDualBazookas(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult

## engine/RangedWeaponRegistry.ts
const RangedWeaponRegistry = new RangedWeaponRegistryClass()
function parseRangedWeaponType(weaponTypeStr: string | undefined | null): RangedWeaponTypeId
function createRangedWeaponMesh(weaponType: RangedWeaponTypeId): RangedWeaponCreationResult
function makeRangedWeaponVisualOnly(weaponGroup: THREE.Object3D): void

## engine/RangedWeaponSystem.ts
type RangedWeaponAimMode = 'auto' | 'camera' | 'cursor'
type RangedWeaponCursorFacing = 'while-firing' | 'always'
const CURSOR_FACING_LINGER_MS = 500
interface RangedWeaponSystemOptions
RangedWeaponSystemOptions.aimMode: RangedWeaponAimMode
RangedWeaponSystemOptions.projectileColor: number | null
RangedWeaponSystemOptions.cursorFacing?: RangedWeaponCursorFacing
const DEFAULT_RANGED_WEAPON_OPTIONS: RangedWeaponSystemOptions
class RangedWeaponSystem implements IPlayerAttack — RangedWeaponSystem - Pluggable ranged weapon combat component
RangedWeaponSystem.onProjectileCreated: ((projectile: Projectile) => void) | null
RangedWeaponSystem.constructor(engine: EngineLike | null, physicsWorld: PhysicsWorld, options: RangedWeaponSystemOptions = DEFAULT_RANGED_WEAPON_OPTIONS)
RangedWeaponSystem.setController(controller: PlayerController): void
RangedWeaponSystem.setupEventListeners(): void
RangedWeaponSystem.removeEventListeners(): void
RangedWeaponSystem.setMobileControls(mobileControls: unknown): void
RangedWeaponSystem.update(deltaTime: number): boolean
RangedWeaponSystem.dispose(): void
RangedWeaponSystem.equipWeapon(weaponType: RangedWeaponTypeId, player: THREE.Object3D, playerLoader: PlayerLoader, retryCount: number = 0): void
RangedWeaponSystem.unequipWeapon(): void
RangedWeaponSystem.getWeaponType(): RangedWeaponTypeId | null
RangedWeaponSystem.hasWeapon(): boolean
RangedWeaponSystem.getWeaponMesh(): THREE.Group | null
RangedWeaponSystem.getProjectiles(): Projectile[]
RangedWeaponSystem.removeProjectile(projectile: Projectile): void
RangedWeaponSystem.isAimBlocked(): boolean
RangedWeaponSystem.getWeaponHeightOffset(): number
RangedWeaponSystem.suppressFireFor(delayMs: number): void
RangedWeaponSystem.setShootingDelay(delayMs: number): void
RangedWeaponSystem.setFireRate(shotsPerSecond: number | null): void
RangedWeaponSystem.getAmmoState(): { current: number; max: number; isReloading: boolean }
RangedWeaponSystem.getCurrentAmmo(): number
RangedWeaponSystem.getMagazineSize(): number
RangedWeaponSystem.getIsReloading(): boolean
RangedWeaponSystem.reload(): void
RangedWeaponSystem.setReloadDuration(durationMs: number): void
RangedWeaponSystem.setMagazine(magazine: IWeaponMagazine): void
RangedWeaponSystem.getMagazine(): IWeaponMagazine
RangedWeaponSystem.setShowAmmoCounter(mode: 'auto' | boolean): void
RangedWeaponSystem.triggerShoot(): void
interface RangedWeaponInstallOptions — Everything a ranged-weapon install can be told, in one place.
RangedWeaponInstallOptions.aim: RangedWeaponAimMode
RangedWeaponInstallOptions.cursorFacing: RangedWeaponCursorFacing
RangedWeaponInstallOptions.projectileColor: number | null
RangedWeaponInstallOptions.magazineSize: number | null
RangedWeaponInstallOptions.reloadDurationMs: number | null
RangedWeaponInstallOptions.fireRate: number | null
RangedWeaponInstallOptions.showAmmoCounter: 'auto' | boolean
const DEFAULT_RANGED_WEAPON_INSTALL_OPTIONS: RangedWeaponInstallOptions
interface RangedWeaponHandle — Live handle to an installed ranged weapon, returned by {@link installRangedWeapon}.
RangedWeaponHandle.readonly system: RangedWeaponSystem
RangedWeaponHandle.getWeaponType(): RangedWeaponTypeId
RangedWeaponHandle.isEquipped(): boolean
RangedWeaponHandle.switchWeapon(weaponType: RangedWeaponTypeId): void
RangedWeaponHandle.remove(): void
function installRangedWeapon(controller: PlayerController, weaponType: RangedWeaponTypeId, options: Partial<RangedWeaponInstallOptions> = {}): RangedWeaponHandle

## engine/RangedWeaponTypes.ts
interface RangedWeaponPreset
RangedWeaponPreset.name: string
RangedWeaponPreset.damage: number
RangedWeaponPreset.fireRate: number
RangedWeaponPreset.projectileSpeed: number
RangedWeaponPreset.magazineSize: number
RangedWeaponPreset.reloadDuration?: number
RangedWeaponPreset.autoReload?: boolean
RangedWeaponPreset.reloadEnabled?: boolean
RangedWeaponPreset.hands: 1 | 2
RangedWeaponPreset.muzzleOffset: THREE.Vector3
RangedWeaponPreset.gripOffset: THREE.Vector3
RangedWeaponPreset.foregrip?: THREE.Vector3
RangedWeaponPreset.recoilStrength?: number
RangedWeaponPreset.pelletCount?: number
RangedWeaponPreset.pelletSpreadRad?: number
RangedWeaponPreset.viewBobScale?: number
RangedWeaponPreset.ejectsShells?: boolean
RangedWeaponPreset.ejectPort?: THREE.Vector3
RangedWeaponPreset.dual?: boolean
RangedWeaponPreset.dualSpacing?: number
RangedWeaponPreset.heightOffset?: number
RangedWeaponPreset.xOffset?: number
RangedWeaponPreset.forwardOffset?: number
RangedWeaponPreset.weaponScale?: THREE.Vector3
RangedWeaponPreset.projectileRadius?: number
RangedWeaponPreset.projectileColor?: number
RangedWeaponPreset.trailLength?: number
RangedWeaponPreset.createProjectileMesh?: (radius: number, color: number) => THREE.Object3D
RangedWeaponPreset.gravityScale?: number
RangedWeaponPreset.explosion?: { enabled: boolean; radius: number; // Explosion visual radius duration: number; // How long explosion lasts (seconds) color?: number; // Explosion color (default: orange) damage?: number; // Damage at center (for future NPC damage) damageRadius?: number; // Radius for damage falloff (for future NPC damage) }
interface RangedWeaponMeshResult
RangedWeaponMeshResult.grip?: THREE.Vector3
RangedWeaponMeshResult.foregrip: THREE.Vector3 | null
type RangedWeaponMeshCreator = (group: THREE.Group, preset: RangedWeaponPreset) => RangedWeaponMeshResult
interface CustomRangedWeaponDefinition
CustomRangedWeaponDefinition.preset: RangedWeaponPreset
CustomRangedWeaponDefinition.createMesh: RangedWeaponMeshCreator
interface RangedWeaponCreationResult
RangedWeaponCreationResult.grip?: THREE.Vector3
RangedWeaponCreationResult.mesh: THREE.Group
RangedWeaponCreationResult.preset: RangedWeaponPreset
RangedWeaponCreationResult.foregrip: THREE.Vector3 | null
RangedWeaponCreationResult.isDual?: boolean
RangedWeaponCreationResult.rightWeaponMesh?: THREE.Group
RangedWeaponCreationResult.leftWeaponMesh?: THREE.Group
RangedWeaponCreationResult.rightGrip?: THREE.Vector3
RangedWeaponCreationResult.leftGrip?: THREE.Vector3
const RangedWeaponType = { PISTOL: 'pistol', ASSAULT_RIFLE: 'assault_rifle', SHOTGUN:
type BaseRangedWeaponType = typeof RangedWeaponType[keyof typeof RangedWeaponType]
type BuiltInRangedWeaponType = BaseRangedWeaponType | `${BaseRangedWeaponType}_lowpoly`
type RangedWeaponTypeId = BuiltInRangedWeaponType | (string & {})
function isBuiltInRangedWeapon(typeId: string): typeId is BuiltInRangedWeaponType

## engine/ShootableComponent.ts
interface ProjectileConfig
ProjectileConfig.speed: number
ProjectileConfig.visualConfig?: ProjectileVisualConfig
ProjectileConfig.localFireDirection?: THREE.Vector3
ProjectileConfig.onHitCallback?: (projectile: Projectile, hitBody?: RAPIER.RigidBody) => void
ProjectileConfig.collisionMask?: number
class ShootableComponent
ShootableComponent.muzzleOffset: THREE.Vector3
ShootableComponent.fireRate: number
ShootableComponent.projectileConfig: ProjectileConfig
ShootableComponent.constructor(muzzleOffset: THREE.Vector3, fireRate: number, projectileConfig: ProjectileConfig)
ShootableComponent.canShoot(): boolean
ShootableComponent.shoot(parentTransform: THREE.Object3D, physicsWorld: PhysicsWorld, engine: EngineLike, aimPoint?: THREE.Vector3): Projectile | null
ShootableComponent.shootVolley(parentTransform: THREE.Object3D, physicsWorld: PhysicsWorld, engine: EngineLike, aimPoints: readonly THREE.Vector3[]): Projectile[]

## engine/UnarmedMeleeSystem.ts
const DEFAULT_UNARMED_ATTACK_MOVES: readonly CustomAttackMove[]
interface UnarmedMeleeConfig — Configuration for unarmed melee combat system
UnarmedMeleeConfig.attackRange?: number
UnarmedMeleeConfig.hitboxRadius?: number
UnarmedMeleeConfig.coneAngle?: number
UnarmedMeleeConfig.punchForce?: number
UnarmedMeleeConfig.kickForce?: number
UnarmedMeleeConfig.punchImpulse?: number
UnarmedMeleeConfig.kickImpulse?: number
UnarmedMeleeConfig.autoRegisterDefaultMoves?: boolean
UnarmedMeleeConfig.fightingStance?: boolean
class UnarmedMeleeSystem implements IPlayerAttack — Handles unarmed melee combat system including:
UnarmedMeleeSystem.constructor(engine: EngineLike | null, physicsWorld: PhysicsWorld, config?: UnarmedMeleeConfig)
UnarmedMeleeSystem.updateConfig(config: Partial<UnarmedMeleeConfig>): void
UnarmedMeleeSystem.getConfig(): Required<UnarmedMeleeConfig>
UnarmedMeleeSystem.setController(controller: PlayerController): void
UnarmedMeleeSystem.setupEventListeners(): void
UnarmedMeleeSystem.removeEventListeners(): void
UnarmedMeleeSystem.setMobileControls(mobileControls: any): void
UnarmedMeleeSystem.update(deltaTime: number): boolean
UnarmedMeleeSystem.triggerAttack(animationController: ICharacterAnimationController, player: THREE.Object3D): void
UnarmedMeleeSystem.getActionHandler(): AttackActionHandler
UnarmedMeleeSystem.dispose(): void

## engine/WeaponMagazineComponent.ts
interface WeaponMagazineConfig
WeaponMagazineConfig.magazineSize: number
WeaponMagazineConfig.reloadDuration?: number
WeaponMagazineConfig.startLoaded?: boolean
WeaponMagazineConfig.autoReload?: boolean
WeaponMagazineConfig.reloadEnabled?: boolean
class WeaponMagazineComponent implements IWeaponMagazine
WeaponMagazineComponent.constructor(config: WeaponMagazineConfig)
WeaponMagazineComponent.isInfinite(): boolean
WeaponMagazineComponent.tryConsume(): boolean
WeaponMagazineComponent.startReload(): void
WeaponMagazineComponent.update(): void
WeaponMagazineComponent.reset(magazineSize: number, reloadDuration?: number): void
WeaponMagazineComponent.getCurrentAmmo(): number
WeaponMagazineComponent.getMagazineSize(): number
WeaponMagazineComponent.getIsReloading(): boolean
WeaponMagazineComponent.getAmmoState(): { current: number; max: number; isReloading: boolean }
WeaponMagazineComponent.setReloadDuration(ms: number): void
WeaponMagazineComponent.getReloadDuration(): number
WeaponMagazineComponent.isAutoReloadEnabled(): boolean
WeaponMagazineComponent.isReloadAllowed(): boolean
WeaponMagazineComponent.setAutoReload(enabled: boolean): void
WeaponMagazineComponent.setReloadEnabled(enabled: boolean): void

## engine/WeaponMeleeSystem.ts
interface WeaponConfig — Configuration for a melee weapon
WeaponConfig.name: string
WeaponConfig.weaponMesh: THREE.Object3D
WeaponConfig.damage: number
WeaponConfig.impactForce: number
WeaponConfig.impulseStrength: number
WeaponConfig.hiltOffset: THREE.Vector3
WeaponConfig.tipOffset: THREE.Vector3
WeaponConfig.bladeRadius: number
WeaponConfig.attackRange: number
WeaponConfig.animationPrefix: string
interface WeaponMeleeConfig — Configuration for weapon melee combat system
WeaponMeleeConfig.attackRange?: number
WeaponMeleeConfig.coneAngle?: number
class WeaponMeleeSystem implements IPlayerAttack — Handles weapon-based melee combat system including:
WeaponMeleeSystem.constructor(engine: EngineLike | null, physicsWorld: PhysicsWorld, config?: WeaponMeleeConfig)
WeaponMeleeSystem.updateConfig(config: Partial<WeaponMeleeConfig>): void
WeaponMeleeSystem.getConfig(): Required<WeaponMeleeConfig>
WeaponMeleeSystem.equipWeapon(weapon: WeaponConfig): void
WeaponMeleeSystem.unequipWeapon(): void
WeaponMeleeSystem.getEquippedWeapon(): WeaponConfig | null
WeaponMeleeSystem.setController(controller: PlayerController): void
WeaponMeleeSystem.setupEventListeners(): void
WeaponMeleeSystem.removeEventListeners(): void
WeaponMeleeSystem.setMobileControls(mobileControls: unknown): void
WeaponMeleeSystem.equipWeaponByType(weaponType: WeaponTypeId, player: THREE.Object3D, controller: PlayerController, retryCount: number = 0): Promise<void>
WeaponMeleeSystem.unequipWeaponByType(): Promise<void>
WeaponMeleeSystem.getWeaponType(): WeaponTypeId | null
WeaponMeleeSystem.hasWeapon(): boolean
WeaponMeleeSystem.update(deltaTime: number): boolean
WeaponMeleeSystem.triggerAttack(animationController: ICharacterAnimationController, player: THREE.Object3D): void
WeaponMeleeSystem.getActionHandler(): AttackActionHandler
WeaponMeleeSystem.dispose(): void

## engine/WeaponPartMaterial.ts
const WEAPON_PART_CLASS = CLASSED_PART_CLASS
const WEAPON_PART_COLOR = CLASSED_PART_COLOR
const WEAPON_PART_GLOW = CLASSED_PART_GLOW
type WeaponPartMaterialOptions = ClassedPartMaterialOptions
function createWeaponPartMaterial(className: string, options: WeaponPartMaterialOptions): ClassedPartMaterial
function clampWeaponPartMaterialsToDirect(root: THREE.Object3D): void

## engine/WeaponPickup.ts
enum WeaponCategory { MELEE, RANGED }
type AnyWeaponType = WeaponTypeId | RangedWeaponTypeId
interface WeaponPickupConfig — Weapon pickup configuration
WeaponPickupConfig.category: WeaponCategory
WeaponPickupConfig.weaponType: AnyWeaponType
WeaponPickupConfig.position: THREE.Vector3
WeaponPickupConfig.rotation?: number
WeaponPickupConfig.scale?: number
WeaponPickupConfig.floatingAnimation?: boolean
WeaponPickupConfig.glowEffect?: boolean
type OnWeaponPickupCallback = (pickup: WeaponPickup) => void
const WEAPON_PICKUP_PROMPT_Y_OFFSET = 0.5
class WeaponPickup implements Interactable — WeaponPickup - An interactable weapon on the ground
WeaponPickup.constructor(engine: EngineLike, physicsWorld: import('./physics/PhysicsWorld.js').PhysicsWorld, category: WeaponCategory, weaponType: AnyWeaponType, position: THREE.Vector3, options: Partial<Omit<WeaponPickupConfig, 'category' | 'weaponType' | 'position'>> = {})
WeaponPickup.onInteractStart(): boolean
WeaponPickup.getInteractStartDisplayName(): string
WeaponPickup.interactionEnabled(): boolean
WeaponPickup.setOnPickupCallback(callback: OnWeaponPickupCallback): void
WeaponPickup.getCategory(): WeaponCategory
WeaponPickup.getWeaponType(): AnyWeaponType
WeaponPickup.getWeaponName(): string
WeaponPickup.getPosition(): THREE.Vector3
WeaponPickup.isCollected(): boolean
WeaponPickup.getWeaponMeshClone(): THREE.Object3D | null
WeaponPickup.update(deltaTime: number): void
WeaponPickup.dispose(): void

## engine/WeaponPickupManager.ts
interface RandomWeaponSpawnConfig — Configuration for spawning random weapons
RandomWeaponSpawnConfig.count: number
RandomWeaponSpawnConfig.center: THREE.Vector3
RandomWeaponSpawnConfig.radius: number
RandomWeaponSpawnConfig.meleeWeapons?: WeaponTypeId[]
RandomWeaponSpawnConfig.rangedWeapons?: RangedWeaponTypeId[]
RandomWeaponSpawnConfig.minDistance?: number
RandomWeaponSpawnConfig.minDistanceFromCenter?: number
type OnAnyWeaponPickupCallback = ( category: WeaponCategory, weaponType: AnyWeaponType, pickup: WeaponPickup ) => void
class WeaponPickupManager — WeaponPickupManager - Manages all weapon pickups in the game world
WeaponPickupManager.constructor(engine: EngineLike, physicsWorld: import('./physics/PhysicsWorld.js').PhysicsWorld, spawner: Spawner)
WeaponPickupManager.spawnWeapon(category: WeaponCategory, weaponType: AnyWeaponType, position: THREE.Vector3, options: { rotation?: number; scale?: number } = {}): WeaponPickup
WeaponPickupManager.spawnRandomWeapons(config: RandomWeaponSpawnConfig): WeaponPickup[]
WeaponPickupManager.dropWeapon(category: WeaponCategory, weaponType: AnyWeaponType, position: THREE.Vector3, direction?: THREE.Vector3): WeaponPickup
WeaponPickupManager.setOnPickupCallback(callback: OnAnyWeaponPickupCallback): void
WeaponPickupManager.findNearestPickup(position: THREE.Vector3, maxDistance: number = 3): WeaponPickup | null
WeaponPickupManager.getActivePickups(): WeaponPickup[]
WeaponPickupManager.getActiveCount(): number
WeaponPickupManager.update(deltaTime: number): void
WeaponPickupManager.dispose(): void

## engine/WeaponPickupSystem.ts
class WeaponPickupSystem — WeaponPickupSystem - Coordinates weapon pickup/drop and delegates to weapon systems
WeaponPickupSystem.constructor(engine: EngineLike, physicsWorld: PhysicsWorld, pickupManager: WeaponPickupManager)
WeaponPickupSystem.attach(controller: PlayerController): void
WeaponPickupSystem.detach(): void
WeaponPickupSystem.update(deltaTime: number): void
WeaponPickupSystem.tryPickupWeapon(): boolean
WeaponPickupSystem.getCurrentWeapon(): { category: WeaponCategory | null; type: AnyWeaponType | null; name: string | null }
WeaponPickupSystem.isArmed(): boolean
WeaponPickupSystem.getMeleeSystem(): WeaponMeleeSystem | null
WeaponPickupSystem.getRangedSystem(): RangedWeaponSystem | null
WeaponPickupSystem.getPickupManager(): WeaponPickupManager
WeaponPickupSystem.forceDropWeapon(): Promise<void>
WeaponPickupSystem.isShowingPickupPrompt(): boolean
WeaponPickupSystem.getProjectiles(): import('engine/Projectile.js').Projectile[]
WeaponPickupSystem.removeProjectile(projectile: import('engine/Projectile.js').Projectile): void
WeaponPickupSystem.dispose(): void

## engine/WeaponRegistry.ts
interface WeaponPreset
WeaponPreset.name: string
WeaponPreset.damage: number
WeaponPreset.impactForce: number
WeaponPreset.impulseStrength: number
WeaponPreset.attackRange: number
WeaponPreset.bladeRadius: number
WeaponPreset.gripOffset: number
WeaponPreset.forwardOffset: number
WeaponPreset.grip?: 'one' | 'two'
type WeaponMeshCreator = (group: THREE.Group, preset: WeaponPreset) => number
interface CustomWeaponDefinition
CustomWeaponDefinition.preset: WeaponPreset
CustomWeaponDefinition.createMesh: WeaponMeshCreator
interface WeaponCreationResult
WeaponCreationResult.mesh: THREE.Group
WeaponCreationResult.config: Omit<WeaponConfig, 'weaponMesh'>
WeaponCreationResult.preset: WeaponPreset
const WeaponType = { SWORD: 'sword', DAGGER: 'dagger', AXE: 'axe', SPEAR: 'spea
type BaseWeaponType = typeof WeaponType[keyof typeof WeaponType]
type BuiltInWeaponType = BaseWeaponType | `${BaseWeaponType}_lowpoly`
type WeaponTypeId = BuiltInWeaponType | (string & {})
function isBuiltInWeapon(typeId: string): typeId is BuiltInWeaponType
const WeaponRegistry = new WeaponRegistryClass()
function parseWeaponType(weaponTypeStr: string | undefined | null): WeaponTypeId
function createWeaponMesh(weaponType: WeaponTypeId): WeaponCreationResult
function makeWeaponVisualOnly(weaponGroup: THREE.Object3D): void

## engine/WeaponSlashArc.ts
interface SlashArcOptions — How the arc looks. Everything here is per-swing, so weapons can differ.
SlashArcOptions.innerFraction: number
SlashArcOptions.color: THREE.Color
SlashArcOptions.opacity: number
SlashArcOptions.fadeSeconds: number
SlashArcOptions.maxSamples: number
SlashArcOptions.strikeSpeedFraction: number
const DEFAULT_SLASH_ARC: SlashArcOptions
class SlashArc implements PooledEffect — One sweep. Owns its mesh for its whole life; `WeaponSlashArcs` re-arms a
SlashArc.capacity: number
SlashArc.constructor(scene: THREE.Scene, weapon: THREE.Object3D, hiltOffset: THREE.Vector3, tipOffset: THREE.Vector3, swingSeconds: number, opts: SlashArcOptions = DEFAULT_SLASH_ARC)
SlashArc.get isFinished(): boolean
SlashArc.update(deltaTime: number): void
SlashArc.rearm(weapon: THREE.Object3D, hiltOffset: THREE.Vector3, tipOffset: THREE.Vector3, swingSeconds: number, opts: SlashArcOptions): void
SlashArc.retire(): void
SlashArc.dispose(): void
class WeaponSlashArcs — Owns the arcs and pumps them. One per melee system.
WeaponSlashArcs.constructor(scene: THREE.Scene)
WeaponSlashArcs.spawn(weapon: THREE.Object3D, hiltOffset: THREE.Vector3, tipOffset: THREE.Vector3, swingSeconds: number, opts?: Partial<SlashArcOptions>): void
WeaponSlashArcs.update(deltaTime: number): void
WeaponSlashArcs.dispose(): void

## engine/WeaponSwishSound.ts
interface SwishAudioHost — The slice of the engine this needs. Declared structurally rather than taking
SwishAudioHost.getAudioContext?(): AudioContext | null
SwishAudioHost.getAudioDestination?(): AudioNode | null
interface SwishVoice — How a weapon sounds when it moves. Derived from its preset, not authored per weapon.
SwishVoice.peakHz: number
SwishVoice.sweep: number
SwishVoice.resonance: number
SwishVoice.gain: number
SwishVoice.peakAt: number
const DEFAULT_SWISH_VOICE: SwishVoice
function voiceForWeapon(opts: { bladeRadius: number; attackRange: number; grip?: 'one' | 'two'; moveName?: string; }): SwishVoice
class WeaponSwishSound — Synthesises one swish per swing.
WeaponSwishSound.constructor(host: SwishAudioHost)
WeaponSwishSound.play(durationSeconds: number, voice: SwishVoice = DEFAULT_SWISH_VOICE): void
WeaponSwishSound.dispose(): void

## engine/WeaponVisualStyle.ts
type WeaponVisualStyle = 'block' | 'lowpoly'
function weaponStyleId<T extends string>(baseId: T, style: WeaponVisualStyle): T | `${T}_lowpoly`
function splitWeaponStyleId(id: string): { baseId: string; style: WeaponVisualStyle }
