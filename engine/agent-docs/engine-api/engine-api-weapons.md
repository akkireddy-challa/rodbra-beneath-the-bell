# engine-api-weapons

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/weapons/CameraAim.ts
const CAMERA_AIM_MAX_DISTANCE = 300
const CAMERA_AIM_RAY_START_MARGIN = 0.5
const RETICLE_VERTICAL_FRACTION = 0.52
interface AimRaycaster — The one physics capability camera aiming needs.
AimRaycaster.raycast( origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, collisionMask: number, ): { hasHit: boolean; hitPoint: THREE.Vector3 } | null
const OPEN_SKY_CONVERGENCE_DISTANCE = 20
function calculateCameraAimPoint(camera: THREE.PerspectiveCamera, player: THREE.Object3D, physicsWorld: AimRaycaster | null, target?: THREE.Vector3): THREE.Vector3

## engine/weapons/MeleeWeaponModels.ts
function createMeleeWeaponModel(group: THREE.Group, preset: WeaponPreset, type: BaseWeaponType, style: WeaponVisualStyle): number

## engine/weapons/PelletSpread.ts
const DEFAULT_PELLET_SPREAD_RAD = 0.08
function scatterAimPoints(muzzle: THREE.Vector3, aimPoint: THREE.Vector3, count: number, spreadRad: number, random: () => number): THREE.Vector3[]

## engine/weapons/PointBlank.ts
type SegmentBlockedQuery = ( origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, mask: number, ) => boolean
function resolveProjectileSpawn(muzzle: THREE.Vector3, shooterCentre: THREE.Vector3 | null, projectileMask: number, blocked: SegmentBlockedQuery, out = new THREE.Vector3()): THREE.Vector3

## engine/weapons/RangedProjectileConfig.ts
function createRangedProjectileConfig(preset: RangedWeaponPreset, projectileColorOverride?: number): ProjectileConfig

## engine/weapons/RangedWeaponGrip.ts
function setRangedWeaponHoldUpdater(target: THREE.Object3D, update: () => void): void
const SKINNED_RANGED_HOLD = { single: { drop: 0.44, inward: 0.07, forward: 0 }, rifle: {
function bringSkinnedDualWeaponsInward(scale: THREE.Vector3, rightWeapon: THREE.Object3D, leftWeapon: THREE.Object3D, rightGrip: THREE.Vector3, leftGrip: THREE.Vector3): void
function createSkinnedRangedGrip(target: THREE.Object3D, side: 'left' | 'right', point: THREE.Vector3, scale: THREE.Vector3, role: 'trigger' | 'support' = side === 'left' ? 'support' : 'trigger'): ArmGrip
function fitRangedWeaponToArmReach(root: THREE.Object3D, grips: ReadonlyMap<'left' | 'right', ArmGrip>): void

## engine/weapons/RangedWeaponModels.ts
function createRangedWeaponModel(group: THREE.Group, preset: RangedWeaponPreset, type: SingleRangedType, style: WeaponVisualStyle): RangedWeaponMeshResult

## engine/weapons/WeaponMeshBuilder.ts
type WeaponSurface = 'steel' | 'edge' | 'dark' | 'wood' | 'grip' | 'brass' | 'body' | 'glow'
class WeaponMeshBuilder — Small authored parts compile into ONE mesh per surface, not one draw per rivet.
WeaponMeshBuilder.constructor(readonly style: WeaponVisualStyle, private readonly colors: Partial<Record<WeaponSurface, number>> = {})
WeaponMeshBuilder.add(geometry: THREE.BufferGeometry, surface: WeaponSurface, position: Point = [0, 0, 0], rotation: Point = [0, 0, 0]): void
WeaponMeshBuilder.box(surface: WeaponSurface, size: Point, position: Point, rotation: Point = [0, 0, 0]): void
WeaponMeshBuilder.profile(surface: WeaponSurface, outline: readonly (readonly [number, number])[], thickness: number, bevel: number, position: Point = [0, 0, 0], rotation: Point = [0, 0, 0]): void
WeaponMeshBuilder.rod(surface: WeaponSurface, radiusBottom: number, radiusTop: number, start: Point, end: Point): void
WeaponMeshBuilder.blade(surface: WeaponSurface, rings: readonly { y: number; z: number; width: number; thickness: number }[], tip: Point, ridgeSurface: WeaponSurface = surface): void
WeaponMeshBuilder.finish(group: THREE.Group): void

## engine/weapons/WeaponVolley.ts
function fireWeaponShot(shootable: ShootableComponent, muzzleTransform: THREE.Object3D, physicsWorld: PhysicsWorld, engine: EngineLike, preset: RangedWeaponPreset | null, aimPoint: THREE.Vector3 | null): Projectile[]
