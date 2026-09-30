# engine-api-effects

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/effects/AmbientSnowVFX.ts
interface AmbientSnowVFXOptions — AmbientSnowVFX — a lightweight, pooled falling-particle weather effect
AmbientSnowVFXOptions.maxParticles: number
AmbientSnowVFXOptions.density: number
AmbientSnowVFXOptions.radius: number
AmbientSnowVFXOptions.columnHeight: number
AmbientSnowVFXOptions.groundDrop: number
AmbientSnowVFXOptions.fallSpeed: number
AmbientSnowVFXOptions.wind: THREE.Vector3
AmbientSnowVFXOptions.driftSpeed: number
AmbientSnowVFXOptions.flakeSize: number
AmbientSnowVFXOptions.color: THREE.ColorRepresentation
AmbientSnowVFXOptions.opacity: number
AmbientSnowVFXOptions.texture: THREE.Texture | string | null
const DEFAULT_AMBIENT_SNOW_VFX_OPTIONS: AmbientSnowVFXOptions
class AmbientSnowVFX
AmbientSnowVFX.constructor(scene: THREE.Scene, options: Partial<AmbientSnowVFXOptions> = {})
AmbientSnowVFX.setDensity(density: number): void
AmbientSnowVFX.setWind(wind: THREE.Vector3): void
AmbientSnowVFX.setFallSpeed(fallSpeed: number): void
AmbientSnowVFX.setTexture(texture: THREE.Texture | string): void
AmbientSnowVFX.update(deltaTime: number, center: THREE.Vector3): void
AmbientSnowVFX.dispose(): void

## engine/effects/BloomTint.ts
function applyBloomTint(object: THREE.Object3D): void
function clearBloomTint(material: THREE.Material): boolean

## engine/effects/BoneVoxelShatter.ts
interface BoneVoxelShatterOptions
BoneVoxelShatterOptions.maxDebris: number
BoneVoxelShatterOptions.boneSpeedMin: number
BoneVoxelShatterOptions.boneSpeedMax: number
BoneVoxelShatterOptions.upwardBias: number
BoneVoxelShatterOptions.voxelScatterSpeed: number
BoneVoxelShatterOptions.maxAngularSpeed: number
BoneVoxelShatterOptions.limbs: boolean
BoneVoxelShatterOptions.limbBurst: boolean
BoneVoxelShatterOptions.limbImpactGraceSec: number
BoneVoxelShatterOptions.limbMaxLifetimeSec: number
BoneVoxelShatterOptions.splashCount: number
BoneVoxelShatterOptions.splashColor: { r: number; g: number; b: number }
const DEFAULT_BONE_VOXEL_SHATTER: BoneVoxelShatterOptions
const limbPiecePool = new LimbPiecePool()
const boneVoxelLimbs = new BoneVoxelLimbsImpl()
function prewarmSkinnedVoxelShatter(root: THREE.Object3D): void
function shatterSkinnedVoxelCharacter(root: THREE.Object3D, physicsWorld: PhysicsWorld, debrisParent: THREE.Object3D, options: BoneVoxelShatterOptions, killerDirection?: THREE.Vector3): boolean

## engine/effects/BurstPresets.ts
type BurstPreset = 'sparks' | 'ricochet' | 'dust' | 'smoke' | 'flame' | 'embers' | 'frost' | 'poison' | 'heal' | 'magic' | 'portal' | 'confetti' | 'splash' | 'steam' | 'ash' | 'leaves' | 'bubbles' | 'fireflies' | 'snowflakes' | 'stardust' | 'tornado' | 'fountain' | 'shockwave' | 'charge' | 'comet' | 'petals'
type BurstMotion = 'cone' | 'plume' | 'orbit' | 'converge' | 'radial' | 'funnel' | 'fall' | 'float' | 'ring' | 'fountain' | 'trail'
interface BurstRecipe
BurstRecipe.motion: BurstMotion
BurstRecipe.count: number
BurstRecipe.duration: number
BurstRecipe.color: number
BurstRecipe.endColor: number
BurstRecipe.glow: boolean
BurstRecipe.size: number
BurstRecipe.stretch: number
BurstRecipe.speed: number
BurstRecipe.gravity: number
BurstRecipe.spread: number
BurstRecipe.curl: number
BurstRecipe.birthWindow: number
BurstRecipe.ring: number
BurstRecipe.tumble?: boolean
BurstRecipe.flutter?: number
const BURST_PRESETS: Readonly<Record<BurstPreset, Readonly<BurstRecipe>>>
function burstRecipe(preset: BurstPreset, overrides?: Partial<BurstRecipe>): Readonly<BurstRecipe>

## engine/effects/BurstVisual.ts
interface BurstOptions
BurstOptions.preset: BurstPreset
BurstOptions.recipe?: Partial<BurstRecipe>
BurstOptions.radius: number
BurstOptions.duration: number
BurstOptions.color: number
BurstOptions.amount: number
BurstOptions.variance: number
BurstOptions.seed: number
BurstOptions.style: VFXStyle
BurstOptions.quality: VFXQuality
BurstOptions.direction: THREE.Vector3
BurstOptions.layers: { particles: boolean; ring: boolean }
const DEFAULT_BURST_OPTIONS: BurstOptions
class BurstVisual — One particle draw + optional ring. Opaque clouds shrink; emissive particles use additive blending.
BurstVisual.group
BurstVisual.constructor(scene: THREE.Scene, readonly style: VFXStyle)
BurstVisual.rearm(position: THREE.Vector3, options: BurstOptions): void
BurstVisual.setProgress(progress: number): void
BurstVisual.retire(): void
BurstVisual.dispose(): void

## engine/effects/CustomEffectVisual.ts
interface CustomEffectOptions
CustomEffectOptions.duration: number
CustomEffectOptions.loop: boolean
const DEFAULT_CUSTOM_EFFECT_OPTIONS: CustomEffectOptions
interface CustomEffectDefinition<Options extends CustomEffectOptions> — Keep the definition at module scope: its identity and style are the pool key.
CustomEffectDefinition.defaults: Readonly<Options>
CustomEffectDefinition.create(scene: THREE.Scene, style: VFXStyle): CustomEffectVisual<Options>
class CustomEffectVisual<Options extends CustomEffectOptions> extends EffectShape — Extend in game code. Construct owned geometry/materials once, reset all state
CustomEffectVisual.rearm(position: THREE.Vector3, options: Readonly<Options>): void

## engine/effects/DamageFlash.ts
interface DamageFlashConfig
DamageFlashConfig.color?: number
DamageFlashConfig.intensity?: number
DamageFlashConfig.duration?: number
DamageFlashConfig.enabled?: boolean
class DamageFlash
DamageFlash.constructor(target: THREE.Object3D, config?: DamageFlashConfig)
DamageFlash.trigger(intensityMultiplier: number = 1.0): void
DamageFlash.setTarget(target: THREE.Object3D): void
DamageFlash.setEnabled(enabled: boolean): void
DamageFlash.isEnabled(): boolean
DamageFlash.setColor(color: number): void
DamageFlash.setIntensity(intensity: number): void
DamageFlash.setDuration(duration: number): void
DamageFlash.restoreImmediately(): void
DamageFlash.isCurrentlyFlashing(): boolean
DamageFlash.dispose(): void
function createDamageFlash(target: THREE.Object3D, config?: DamageFlashConfig): DamageFlash

## engine/effects/EffectPool.ts
interface PooledEffect — What an effect must implement to live in an `EffectPool`.
PooledEffect.readonly isFinished: boolean
PooledEffect.update(deltaTime: number): void
PooledEffect.retire(): void
PooledEffect.dispose(): void
interface EffectSpawn<T extends PooledEffect> — How to serve one spawn: reuse an idle effect that fits, else build a new one.
EffectSpawn.fits: (effect: T) => boolean
EffectSpawn.rearm: (effect: T) => void
EffectSpawn.create: () => T
class EffectPool<T extends PooledEffect> — Active effects are ticked in spawn order and retired when finished; retired
EffectPool.get activeCount(): number
EffectPool.get idleCount(): number
EffectPool.spawn(spawn: EffectSpawn<T>): T
EffectPool.update(deltaTime: number): void
EffectPool.retireOldest(count: number): void
EffectPool.retireAll(): void
EffectPool.dispose(): void

## engine/effects/EffectShapes.ts
type EffectTarget = THREE.Vector3 | THREE.Object3D
interface EffectShapeOptions
EffectShapeOptions.radius: number
EffectShapeOptions.color: number
EffectShapeOptions.amount: number
EffectShapeOptions.variance: number
EffectShapeOptions.seed: number
EffectShapeOptions.style: VFXStyle
EffectShapeOptions.quality: VFXQuality
EffectShapeOptions.direction: THREE.Vector3
EffectShapeOptions.duration: number
const DEFAULT_EFFECT_SHAPE_OPTIONS: EffectShapeOptions
function resolveShape(options: EffectShapeOptions): EffectShapeOptions
function readEffectTarget(target: EffectTarget, out: THREE.Vector3): THREE.Vector3
function namedRecipe<K extends string, T>(catalog: Readonly<Record<K, T>>, preset: K): T
function effectInstances<M extends THREE.Material>(geometry: THREE.BufferGeometry, material: M, capacity: number, name: string): THREE.InstancedMesh<THREE.BufferGeometry, M>
class EffectShape — All children are effect-owned. Game targets are never parented here.
EffectShape.group
EffectShape.constructor(scene: THREE.Scene, name: string)
EffectShape.moveTo(position: THREE.Vector3): void
EffectShape.setProgress(progress: number): void
EffectShape.retire(): void
EffectShape.dispose(): void

## engine/effects/ExplosionPresets.ts
type ExplosionPreset = 'blast' | 'fireball' | 'fragmentation' | 'plasma' | 'emp' | 'frost' | 'poison' | 'dust' | 'inferno' | 'napalm' | 'volcanic' | 'steam' | 'sonic' | 'implosion' | 'arcane' | 'shatter'
type ExplosionLayer = 'flash' | 'fire' | 'smoke' | 'sparks' | 'debris' | 'ring'
interface ExplosionRecipe
ExplosionRecipe.color: number
ExplosionRecipe.smokeColor: number
ExplosionRecipe.sparkColor: number
ExplosionRecipe.debrisColor: number
ExplosionRecipe.ringColor: number
ExplosionRecipe.fire: number
ExplosionRecipe.smoke: number
ExplosionRecipe.sparks: number
ExplosionRecipe.debris: number
ExplosionRecipe.flash: number
ExplosionRecipe.ring: number
ExplosionRecipe.lift: number
ExplosionRecipe.speed: number
ExplosionRecipe.swirl: number
ExplosionRecipe.duration: number
ExplosionRecipe.debrisStretch: number
ExplosionRecipe.motion?: 'outward' | 'inward' | 'column' | 'disk'
const EXPLOSION_PRESETS: Readonly<Record<ExplosionPreset, Readonly<ExplosionRecipe>>>
function explosionRecipe(preset: ExplosionPreset, overrides?: Partial<ExplosionRecipe>): Readonly<ExplosionRecipe>

## engine/effects/ExplosionVisual.ts
type ExplosionStyle = 'voxel' | 'low-poly'
interface ExplosionVisualOptions
ExplosionVisualOptions.radius: number
ExplosionVisualOptions.color: number
ExplosionVisualOptions.style: ExplosionStyle
ExplosionVisualOptions.seed: number
ExplosionVisualOptions.preset?: ExplosionPreset
ExplosionVisualOptions.recipe?: Partial<ExplosionRecipe>
ExplosionVisualOptions.amount?: number
ExplosionVisualOptions.variance?: number
ExplosionVisualOptions.quality?: VFXQuality
ExplosionVisualOptions.layers?: Partial<Record<ExplosionLayer, number>>
const DEFAULT_EXPLOSION_VISUAL_OPTIONS: ExplosionVisualOptions
class ExplosionVisual — Six draws per burst, reusable buffers and analytic normalized-age motion on both renderers.
ExplosionVisual.group
ExplosionVisual.style: ExplosionStyle
static ExplosionVisual.acquire(scene: THREE.Scene, position: THREE.Vector3, options: ExplosionVisualOptions): ExplosionVisual
ExplosionVisual.setProgress(progress: number): void
ExplosionVisual.release(): void
static ExplosionVisual.disposeScene(scene: THREE.Scene): void

## engine/effects/FireVisual.ts
type FirePreset = 'torch' | 'campfire' | 'flamethrower' | 'engine-exhaust' | 'fire-wall'
interface FireRecipe
FireRecipe.color: number
FireRecipe.tip: number
FireRecipe.width: number
FireRecipe.length: number
FireRecipe.smoke: number
FireRecipe.embers: number
FireRecipe.cycle: number
FireRecipe.wall: boolean
const FIRE_PRESETS: Readonly<Record<FirePreset, FireRecipe>>
class FireVisual extends EffectShape
FireVisual.constructor(scene: THREE.Scene, style: VFXStyle)
FireVisual.rearm(preset: FirePreset, position: THREE.Vector3, options: EffectShapeOptions): void
FireVisual.setDirection(direction: THREE.Vector3): void
FireVisual.setProgress(progress: number): void

## engine/effects/HitEffects.ts
type HitEffectCallback = (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void
type DeathEffectCallback = (killerDirection?: THREE.Vector3) => void
interface BloodSplatterConfig — Configuration for blood splatter effects
BloodSplatterConfig.color?: number
BloodSplatterConfig.particleCount?: number
BloodSplatterConfig.particleSize?: number
BloodSplatterConfig.duration?: number
BloodSplatterConfig.colorVariation?: boolean
interface DeathExplosionConfig — Configuration for death explosion effects
DeathExplosionConfig.color?: number
DeathExplosionConfig.secondaryColor?: number
DeathExplosionConfig.particleCount?: number
DeathExplosionConfig.createGroundSplat?: boolean
DeathExplosionConfig.splatDuration?: number
DeathExplosionConfig.splatSize?: number
DeathExplosionConfig.duration?: number
interface ThrowConfig — Configuration for throw/knockback effects
ThrowConfig.forceMultiplier?: number
ThrowConfig.maxForce?: number
ThrowConfig.upwardBias?: number
function createBloodSplatterEffect(scene: THREE.Scene, config?: BloodSplatterConfig): HitEffectCallback
function createDeathExplosionEffect(scene: THREE.Scene, config?: DeathExplosionConfig): (position: THREE.Vector3, killerDirection?: THREE.Vector3) => void
function createCombatEffects(scene: THREE.Scene, onKill?: () => void, bloodConfig?: BloodSplatterConfig, deathConfig?: DeathExplosionConfig): { onMeleeHitEffect: HitEffectCallback; onDeathEffect: DeathEffectCallback; }
function applyThrowForce(physicsBody: RAPIER.RigidBody, direction: THREE.Vector3, damage: number, config?: ThrowConfig): void

## engine/effects/LightningVisual.ts
type BeamPreset = 'laser' | 'energy-beam' | 'ion' | 'railgun' | 'healing-link' | 'tractor-beam'
type LightningPreset = 'lightning' | 'tesla' | 'chain' | 'storm' | BeamPreset
interface LightningRecipe
LightningRecipe.color: number
LightningRecipe.width: number
LightningRecipe.displacement: number
LightningRecipe.branches: number
LightningRecipe.flicker: number
LightningRecipe.duration: number
LightningRecipe.shape?: 'jagged' | 'straight' | 'helix' | 'wave'
const LIGHTNING_PRESETS: Readonly<Record<LightningPreset, Readonly<LightningRecipe>>>
interface LightningOptions
LightningOptions.sustained?: boolean
LightningOptions.preset: LightningPreset
LightningOptions.color: number
LightningOptions.width: number
LightningOptions.duration: number
LightningOptions.amount: number
LightningOptions.variance: number
LightningOptions.seed: number
LightningOptions.style: VFXStyle
LightningOptions.quality: VFXQuality
LightningOptions.roughness: number
LightningOptions.branches: number
LightningOptions.layers: { core: boolean; glow: boolean; endpoints: boolean }
const DEFAULT_LIGHTNING_OPTIONS: LightningOptions
class LightningVisual — Anchored, branching volumetric arcs. No hardware lines, screen-space width or custom shader.
LightningVisual.group
LightningVisual.constructor(scene: THREE.Scene, readonly style: VFXStyle)
LightningVisual.rearm(points: readonly THREE.Vector3[], options: LightningOptions): void
LightningVisual.moveEndpoints(points: readonly THREE.Vector3[], progress = 0): void
LightningVisual.setProgress(progress: number): void
LightningVisual.retire(): void
LightningVisual.dispose(): void

## engine/effects/RibbonTrailVisual.ts
type TrailPreset = 'missile' | 'smoke-trail' | 'sword' | 'magic-trail' | 'ribbon'
const TRAIL_PRESETS = { missile: { color: 0xffb25c, width: 0.12, lifetime: 0.45 },
interface TrailOptions
TrailOptions.width: number
TrailOptions.lifetime: number
TrailOptions.teleportDistance: number
const DEFAULT_TRAIL_OPTIONS: TrailOptions
class RibbonTrailVisual extends EffectShape — Two crossing ribbons keep a moving trail visible from arbitrary camera directions.
RibbonTrailVisual.constructor(scene: THREE.Scene, style: VFXStyle = 'voxel')
RibbonTrailVisual.rearm(preset: TrailPreset, position: THREE.Vector3, options: TrailOptions): void
RibbonTrailVisual.advance(dt: number, position: THREE.Vector3): void
RibbonTrailVisual.stopEmission(): void
RibbonTrailVisual.get isFinished(): boolean
RibbonTrailVisual.get sampleCount(): number
RibbonTrailVisual.setProgress(_progress: number): void

## engine/effects/ShaderKeepAlive.ts
type KeepAliveKind = 'mesh' | 'instanced' | 'points' | 'line'
interface KeepAliveAttribute — A vertex attribute the effect's geometry carries that shapes its program.
KeepAliveAttribute.name: string
KeepAliveAttribute.itemSize: number
const SHADER_KEEP_ALIVE_GROUP_NAME = 'ShaderKeepAlive'
const DEFAULT_MESH_ATTRIBUTES: readonly KeepAliveAttribute[]
type KeepAliveLayout = readonly KeepAliveAttribute[] | THREE.BufferGeometry
const LIGHT_CENSUS_INTERVAL_FRAMES = 30
class ShaderKeepAlive
static ShaderKeepAlive.for(scene: THREE.Scene): ShaderKeepAlive
ShaderKeepAlive.onTwinBeforeRender
ShaderKeepAlive.has(key: string): boolean
ShaderKeepAlive.get size(): number
ShaderKeepAlive.retain(key: string, material: THREE.Material, kind: KeepAliveKind = 'mesh', layout?: KeepAliveLayout): void
ShaderKeepAlive.retainFor(key: string, object: THREE.Mesh | THREE.Points | THREE.Line): void
ShaderKeepAlive.dispose(): void
function keepShaderAlive(scene: THREE.Scene, key: string, material: THREE.Material, kind: KeepAliveKind = 'mesh', layout?: KeepAliveLayout): void

## engine/effects/ShatterScheduler.ts
const SHATTER_FRAME_BUDGET_MS = 8
type ShatterJob = () => void
class ShatterScheduler
ShatterScheduler.constructor(private readonly now: () => number = () => performance.now())
ShatterScheduler.runOrDefer(job: ShatterJob): boolean
ShatterScheduler.beginFrame(): void
ShatterScheduler.get pending(): number
ShatterScheduler.clear(): void
const shatterScheduler = new ShatterScheduler()

## engine/effects/ShieldVisual.ts
type ShieldPreset = 'bubble' | 'dome' | 'hex-shield' | 'barrier' | 'hit-ripple' | 'shield-break'
const SHIELD_PRESETS = { bubble: { color: 0x4bafff, duration: 0 }, dome: { color: 0
class ShieldVisual extends EffectShape
ShieldVisual.constructor(scene: THREE.Scene, style: VFXStyle)
ShieldVisual.rearm(preset: ShieldPreset, position: THREE.Vector3, options: EffectShapeOptions): void
ShieldVisual.setProgress(progress: number): void

## engine/effects/SurfaceVisual.ts
type SurfacePreset = 'scorch' | 'bullet-mark' | 'cracks' | 'wet-splash' | 'puddle' | 'ripples'
const SURFACE_PRESETS = { scorch: { color: 0x26201b, duration: 30 }, 'bullet-mark':
class SurfaceVisual extends EffectShape
SurfaceVisual.constructor(scene: THREE.Scene, style: VFXStyle)
SurfaceVisual.rearm(preset: SurfacePreset, position: THREE.Vector3, options: EffectShapeOptions): void
SurfaceVisual.setProgress(progress: number): void

## engine/effects/TelegraphVFX.ts
interface CircleTelegraphConfig
CircleTelegraphConfig.radius: number
CircleTelegraphConfig.position: THREE.Vector3
CircleTelegraphConfig.chargeDuration: number
CircleTelegraphConfig.colorStart: number
CircleTelegraphConfig.colorEnd: number
CircleTelegraphConfig.layers: ('fill' | 'ring' | 'pulse')[]
const DEFAULT_CIRCLE_TELEGRAPH_CONFIG: CircleTelegraphConfig
class CircleTelegraph
CircleTelegraph.constructor(scene: THREE.Scene, config: CircleTelegraphConfig)
CircleTelegraph.update(deltaTime: number): void
CircleTelegraph.trigger(): void
CircleTelegraph.isComplete(): boolean
CircleTelegraph.dispose(): void
interface ConeTelegraphConfig
ConeTelegraphConfig.angle: number
ConeTelegraphConfig.length: number
ConeTelegraphConfig.direction: THREE.Vector3
ConeTelegraphConfig.position: THREE.Vector3
ConeTelegraphConfig.chargeDuration: number
ConeTelegraphConfig.colorStart: number
ConeTelegraphConfig.colorEnd: number
const DEFAULT_CONE_TELEGRAPH_CONFIG: ConeTelegraphConfig
class ConeTelegraph
ConeTelegraph.constructor(scene: THREE.Scene, config: ConeTelegraphConfig)
ConeTelegraph.update(deltaTime: number): void
ConeTelegraph.trigger(): void
ConeTelegraph.isComplete(): boolean
ConeTelegraph.dispose(): void
interface LineTelegraphConfig
LineTelegraphConfig.width: number
LineTelegraphConfig.length: number
LineTelegraphConfig.direction: THREE.Vector3
LineTelegraphConfig.position: THREE.Vector3
LineTelegraphConfig.chargeDuration: number
LineTelegraphConfig.colorStart: number
LineTelegraphConfig.colorEnd: number
const DEFAULT_LINE_TELEGRAPH_CONFIG: LineTelegraphConfig
class LineTelegraph
LineTelegraph.constructor(scene: THREE.Scene, config: LineTelegraphConfig)
LineTelegraph.update(deltaTime: number): void
LineTelegraph.trigger(): void
LineTelegraph.isComplete(): boolean
LineTelegraph.dispose(): void
const ZONE_THEME_COLORS: Record<'fire' | 'poison' | 'void' | 'frost', number>
interface GroundZoneConfig
GroundZoneConfig.radius: number
GroundZoneConfig.position: THREE.Vector3
GroundZoneConfig.zoneType: 'fire' | 'poison' | 'void' | 'frost' | 'custom'
GroundZoneConfig.color: number
GroundZoneConfig.duration: number
GroundZoneConfig.fadeInTime: number
GroundZoneConfig.fadeOutTime: number
const DEFAULT_GROUND_ZONE_CONFIG: GroundZoneConfig
class GroundZone
GroundZone.constructor(scene: THREE.Scene, config: GroundZoneConfig)
GroundZone.update(deltaTime: number): void
GroundZone.isComplete(): boolean
GroundZone.dispose(): void
const ORB_TYPE_COLORS: Record<'damage' | 'buff' | 'delayed' | 'moving', number>
interface OrbEffectConfig
OrbEffectConfig.position: THREE.Vector3
OrbEffectConfig.orbType: 'damage' | 'buff' | 'delayed' | 'moving'
OrbEffectConfig.color: number
OrbEffectConfig.radius: number
OrbEffectConfig.lifetime: number
OrbEffectConfig.auraRadius: number
const DEFAULT_ORB_EFFECT_CONFIG: OrbEffectConfig
class OrbEffect
OrbEffect.constructor(scene: THREE.Scene, config: OrbEffectConfig)
OrbEffect.setTarget(pos: THREE.Vector3): void
OrbEffect.update(deltaTime: number): void
OrbEffect.isComplete(): boolean
OrbEffect.dispose(): void

## engine/effects/TransitionVisual.ts
type TransitionPreset = 'dissolve' | 'materialize' | 'teleport-in' | 'teleport-out' | 'spawn' | 'despawn'
const TRANSITION_PRESETS = { dissolve: { color: 0xffb062, duration: 1.5, incoming: fals
class TransitionVisual extends EffectShape — Alpha-hashed copies fade the actual object without mutating materials shared by other objects.
TransitionVisual.constructor(scene: THREE.Scene, style: VFXStyle)
static TransitionVisual.validateTarget(target: THREE.Object3D): void
TransitionVisual.overlaps(target: THREE.Object3D): boolean
TransitionVisual.rearm(preset: TransitionPreset, target: THREE.Object3D, options: EffectShapeOptions): void
TransitionVisual.setProgress(progress: number): void
TransitionVisual.retire(completed = false): void
TransitionVisual.dispose(): void

## engine/effects/VFXUtils.ts
type VFXQuality = 'low' | 'medium' | 'high'
type VFXStyle = 'voxel' | 'low-poly'
const VFX_DENSITY: Readonly<Record<VFXQuality, number>>
function effectRandom(seed: number): () => number
function effectNumber(value: number, name: string, min: number, max: number): number
function effectPosition(value: THREE.Vector3): void
function updateEffectAttribute(attribute: THREE.BufferAttribute, count: number): void
function effectDensity(quality: VFXQuality): number
const EFFECT_UP = new THREE.Vector3(0, 1, 0)
function effectGeometry(style: VFXStyle): THREE.BufferGeometry

## engine/effects/VisualEffects.ts
interface VisualEffectsOptions
VisualEffectsOptions.style: VFXStyle
VisualEffectsOptions.quality: VFXQuality
VisualEffectsOptions.maxActive: number
VisualEffectsOptions.maxRetained: number
VisualEffectsOptions.maxEmitters: number
VisualEffectsOptions.seed: number
const DEFAULT_VISUAL_EFFECTS_OPTIONS: VisualEffectsOptions
interface EffectHandle
EffectHandle.readonly isAlive: boolean
EffectHandle.stop(): void
EffectHandle.seek(progress: number): void
type ExplosionSpawnOptions = Partial<ExplosionVisualOptions> & { duration?: number }
type BurstSpawnOptions = Partial<BurstOptions>
type LightningSpawnOptions = Partial<LightningOptions>
interface FollowEffectHandle
FollowEffectHandle.moveTo(target: EffectTarget): void
interface FireEffectHandle
FireEffectHandle.setDirection(direction: THREE.Vector3): void
interface ShieldEffectHandle
ShieldEffectHandle.hit(position: THREE.Vector3, normal?: THREE.Vector3): EffectHandle | null
ShieldEffectHandle.break(): EffectHandle | null
interface ContinuousBeamHandle
ContinuousBeamHandle.setEndpoints(from: EffectTarget, to: EffectTarget): void
interface TrailHandle
TrailHandle.readonly isAlive: boolean
TrailHandle.stop(): void
TrailHandle.clear(): void
TrailHandle.moveTo(target: EffectTarget): void
interface EmitterOptions
EmitterOptions.interval: number
EmitterOptions.duration: number
EmitterOptions.burst: BurstSpawnOptions
const DEFAULT_EMITTER_OPTIONS: EmitterOptions
interface EmitterHandle
EmitterHandle.readonly isAlive: boolean
EmitterHandle.stop(): void
EmitterHandle.moveTo(position: THREE.Vector3): void
class VisualEffects — Scene-owned playback with bounded concurrency and stale-handle-safe pooling. All effects are visual only.
VisualEffects.options: Readonly<VisualEffectsOptions>
static VisualEffects.forScene(scene: THREE.Scene, options: Partial<VisualEffectsOptions> = {}): VisualEffects
static VisualEffects.clearScene(scene: THREE.Scene): void
static VisualEffects.updateScene(scene: THREE.Scene, deltaTime: number): void
static VisualEffects.disposeScene(scene: THREE.Scene): void
VisualEffects.constructor(private readonly scene: THREE.Scene, options: VisualEffectsOptions)
VisualEffects.prepare(): void
VisualEffects.explosion(preset: ExplosionPreset, position: THREE.Vector3, overrides: ExplosionSpawnOptions = {}): EffectHandle
VisualEffects.burst(preset: BurstPreset, position: THREE.Vector3, overrides: BurstSpawnOptions = {}): EffectHandle
VisualEffects.lightning(points: readonly THREE.Vector3[], overrides: LightningSpawnOptions = {}): EffectHandle
VisualEffects.beam(from: THREE.Vector3, to: THREE.Vector3, preset: BeamPreset = 'laser', overrides: LightningSpawnOptions = {}): EffectHandle
VisualEffects.continuousBeam(from: EffectTarget, to: EffectTarget, preset: BeamPreset = 'laser', overrides: LightningSpawnOptions = {}): ContinuousBeamHandle
VisualEffects.fire(preset: FirePreset, target: EffectTarget, overrides: Partial<EffectShapeOptions> = {}): FireEffectHandle
VisualEffects.shield(preset: ShieldPreset, target: EffectTarget, overrides: Partial<EffectShapeOptions> = {}): ShieldEffectHandle
VisualEffects.surface(preset: SurfacePreset, position: THREE.Vector3, overrides: Partial<EffectShapeOptions> = {}): EffectHandle
VisualEffects.trail(preset: TrailPreset, target: EffectTarget, overrides: Partial<TrailOptions> = {}): TrailHandle
VisualEffects.transition(preset: TransitionPreset, target: THREE.Object3D, overrides: Partial<EffectShapeOptions> = {}): EffectHandle
VisualEffects.custom<Options extends CustomEffectOptions>(definition: CustomEffectDefinition<Options>, target: EffectTarget, overrides: Partial<Options> = {}): FollowEffectHandle
VisualEffects.emit(preset: BurstPreset, position: THREE.Vector3, overrides: Partial<EmitterOptions> = {}): EmitterHandle
VisualEffects.update(deltaTime: number): void
VisualEffects.clear(): void
VisualEffects.get stats(): { active: number; retained: number; maxActive: number; emitters: number }
VisualEffects.dispose(): void
function getVisualEffects(engine: Pick<EngineLike, 'scene' | 'getGameData'>, options: Partial<VisualEffectsOptions> = {}): VisualEffects

## engine/effects/VoxelEffects.ts
interface VoxelDeathEffectConfig
VoxelDeathEffectConfig.fragmentCount?: number
VoxelDeathEffectConfig.fragmentScale?: number
VoxelDeathEffectConfig.scatterRadius?: number
VoxelDeathEffectConfig.duration?: number
VoxelDeathEffectConfig.deathFlash?: boolean
VoxelDeathEffectConfig.variant?: 'normal' | 'ice' | 'explosion' | 'boss'
VoxelDeathEffectConfig.simplifyThreshold?: number
VoxelDeathEffectConfig.getPosition: () => THREE.Vector3
VoxelDeathEffectConfig.getSourceMesh?: () => THREE.Object3D | undefined
function createVoxelDeathEffect(scene: THREE.Scene, config: VoxelDeathEffectConfig): (killerDirection?: THREE.Vector3) => void
interface DamageVisualConfig
DamageVisualConfig.thresholds?: [number, number, number]
DamageVisualConfig.damageTint?: boolean
DamageVisualConfig.maxTintStrength?: number
DamageVisualConfig.jitter?: boolean
DamageVisualConfig.chipOff?: boolean
interface DamageVisualController
DamageVisualController.update(hpRatio: number, deltaTime: number): void
DamageVisualController.dispose(): void
function createDamageVisualSystem(scene: THREE.Scene, targetMesh: THREE.Object3D, config?: DamageVisualConfig): DamageVisualController
