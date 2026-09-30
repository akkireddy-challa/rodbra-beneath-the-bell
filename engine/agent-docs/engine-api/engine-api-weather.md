# engine-api-weather

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/weather/RainHeightField.ts
interface RainFieldBounds
RainFieldBounds.minX: number
RainFieldBounds.maxX: number
RainFieldBounds.minY: number
RainFieldBounds.maxY: number
RainFieldBounds.minZ: number
RainFieldBounds.maxZ: number
class RainHeightField
RainHeightField.texture: THREE.DataTexture
RainHeightField.mapMin
RainHeightField.mapSize
RainHeightField.noHitFloorY
RainHeightField.constructor()
RainHeightField.get isReady(): boolean
RainHeightField.start(bounds: RainFieldBounds): void
RainHeightField.step(heightAt: (x: number, z: number) => number): void
RainHeightField.dispose(): void

## engine/weather/RainVFXGpu.ts
interface RainVFXGpuOptions — GPU-compute rain for the WebGPU backend — the three.js compute-rain
RainVFXGpuOptions.maxDrops: number
RainVFXGpuOptions.radius: number
RainVFXGpuOptions.columnHeight: number
RainVFXGpuOptions.fallSpeed: number
RainVFXGpuOptions.streakWidth: number
RainVFXGpuOptions.streakLength: number
RainVFXGpuOptions.splashSize: number
RainVFXGpuOptions.opacity: number
const DEFAULT_RAIN_VFX_GPU_OPTIONS: RainVFXGpuOptions
interface ComputeCapableRenderer — The slice of a renderer that can dispatch compute (WebGPURenderer).
ComputeCapableRenderer.compute(node: unknown): unknown
class RainVFXGpu
RainVFXGpu.posBuffer: ReturnType<typeof makeVec3Buffer>
RainVFXGpu.splashPosBuffer: ReturnType<typeof makeVec3Buffer>
RainVFXGpu.constructor(scene: THREE.Scene, field: RainHeightField, opts: RainVFXGpuOptions)
RainVFXGpu.setIntensity(intensity: number): void
RainVFXGpu.setFrameState(center: THREE.Vector3, windX: number, windZ: number): void
RainVFXGpu.syncField(field: RainHeightField): void
RainVFXGpu.computeStep(renderer: ComputeCapableRenderer, deltaSeconds?: number, elapsedSeconds?: number): void
RainVFXGpu.dispose(): void

## engine/weather/RainVFXWebGl.ts
interface RainVFXWebGlOptions — WebGL fallback rain — deliberately cheaper than the WebGPU compute path
RainVFXWebGlOptions.maxDrops: number
RainVFXWebGlOptions.radius: number
RainVFXWebGlOptions.columnHeight: number
RainVFXWebGlOptions.groundDrop: number
RainVFXWebGlOptions.fallSpeed: number
RainVFXWebGlOptions.streakWidth: number
RainVFXWebGlOptions.streakLength: number
RainVFXWebGlOptions.opacity: number
RainVFXWebGlOptions.splashCount: number
RainVFXWebGlOptions.splashRadius: number
RainVFXWebGlOptions.splashSize: number
const DEFAULT_RAIN_VFX_WEBGL_OPTIONS: RainVFXWebGlOptions
class RainVFXWebGl
RainVFXWebGl.constructor(scene: THREE.Scene, opts: RainVFXWebGlOptions)
RainVFXWebGl.setIntensity(intensity: number): void
RainVFXWebGl.update(deltaTime: number, timeSeconds: number, center: THREE.Vector3, windX: number, windZ: number, heightAt: (x: number, z: number) => number): void
RainVFXWebGl.dispose(): void

## engine/weather/VehicleWetFX.ts
interface WetFxVehicle — Structural slice of RapierVehicle the FX needs (keeps this module decoupled).
WetFxVehicle.getWheelTerrainInfo(): readonly WheelTerrainInfo[]
WetFxVehicle.getSpeed(): number
WetFxVehicle.getLinearVelocity(): THREE.Vector3
WetFxVehicle.isHibernating(): boolean
interface VehicleWetFXOptions
VehicleWetFXOptions.vaporEnabled: boolean
VehicleWetFXOptions.maxVaporParticles: number
VehicleWetFXOptions.vaporRate: number
VehicleWetFXOptions.minSpeed: number
VehicleWetFXOptions.minWetness: number
VehicleWetFXOptions.vaporAlpha: number
VehicleWetFXOptions.trailWidth: number
VehicleWetFXOptions.trailSpacing: number
VehicleWetFXOptions.trailLife: number
VehicleWetFXOptions.trailSegments: number
VehicleWetFXOptions.trailAlpha: number
const DEFAULT_VEHICLE_WET_FX_OPTIONS: VehicleWetFXOptions
class VehicleWetFX
VehicleWetFX.constructor(scene: THREE.Scene, opts: VehicleWetFXOptions)
VehicleWetFX.update(deltaTime: number, now: number, wetness: number, vehicles: readonly WetFxVehicle[]): void
VehicleWetFX.dispose(): void

## engine/weather/WeatherEngineBridge.ts
function applyEngineWeatherConfig(eng: GameEngine, config?: WeatherConfig | null): void

## engine/weather/WeatherSystem.ts
interface WeatherTerrainInfo — WeatherSystem — one owner for everything `weatherConfig` drives: the falling
WeatherTerrainInfo.group: THREE.Object3D
WeatherTerrainInfo.bounds: RainFieldBounds | null
WeatherTerrainInfo.heightAt(x: number, z: number): number
WeatherTerrainInfo.generation: number
interface WeatherSystemDeps
WeatherSystemDeps.getScene(): THREE.Scene | null
WeatherSystemDeps.getCamera(): THREE.Camera | null
WeatherSystemDeps.getRenderer(): unknown
WeatherSystemDeps.getTerrain(): WeatherTerrainInfo | null
WeatherSystemDeps.getVehicles(): readonly WetFxVehicle[]
const DEFAULT_WEATHER_WIND = { x: 1.5, z: 0.5 }
function resolveWeatherUrlOverride(config: WeatherConfig | null): WeatherConfig | null
function resolveWetSurfaceLook(config: WeatherConfig | null | undefined): WetSurfaceLook
interface WeatherReflectionLook — Reflection dials read by the post-processing chain (GameEnginePostFx). Read
WeatherReflectionLook.strength: number
WeatherReflectionLook.highlight: number
WeatherReflectionLook.streak: number
WeatherReflectionLook.distance: number
const DEFAULT_WEATHER_REFLECTION_LOOK: WeatherReflectionLook
function resolveReflectionLook(config: WeatherConfig | null | undefined): WeatherReflectionLook
function weatherWantsSsr(config: WeatherConfig | null | undefined): boolean
class WeatherSystem
WeatherSystem.constructor(deps: WeatherSystemDeps)
WeatherSystem.getWetness(): number
WeatherSystem.applyConfig(config: WeatherConfig | null): void
WeatherSystem.frameUpdate(deltaTime: number, clockTime: number): void
WeatherSystem.dispose(): void

## engine/weather/WetSurfaceController.ts
class WetSurfaceController — Swaps the baked ride surface (`smoothSurface` batch) to the wet-asphalt
WetSurfaceController.apply(group: THREE.Object3D): boolean
WetSurfaceController.needsReapply(): boolean
WetSurfaceController.isApplied(): boolean
WetSurfaceController.setTime(seconds: number): void
WetSurfaceController.setWetness(wetness: number): void
WetSurfaceController.setPuddles(puddles: number): void
WetSurfaceController.setRippleAmount(amount: number): void
WetSurfaceController.setLook(look: WetSurfaceLook): void
WetSurfaceController.setEnvironment(env: THREE.Texture | null): void
WetSurfaceController.restore(): void
WetSurfaceController.dispose(): void

## engine/weather/WetSurfaceMaterial.ts
interface WetSurfaceLook — Runtime look dials, authored per game through `worldProfileData.weatherConfig`
WetSurfaceLook.filmGloss: number
WetSurfaceLook.surfaceDarkening: number
WetSurfaceLook.envSheen: number
WetSurfaceLook.rippleStrength: number
const DEFAULT_WET_SURFACE_LOOK: WetSurfaceLook
interface WetSurfaceHandle
WetSurfaceHandle.material: THREE.Material
WetSurfaceHandle.setLook(look: WetSurfaceLook): void
WetSurfaceHandle.setTime(seconds: number): void
WetSurfaceHandle.setWetness(wetness: number): void
WetSurfaceHandle.setPuddles(puddles: number): void
WetSurfaceHandle.setRippleAmount(amount: number): void
WetSurfaceHandle.setEnvironment(env: THREE.Texture | null): void
WetSurfaceHandle.dispose(): void
interface WetSurfaceMaterialOptions
WetSurfaceMaterialOptions.emissive: boolean
const DEFAULT_WET_SURFACE_OPTIONS: WetSurfaceMaterialOptions
function createWetSurfaceMaterial(opts: WetSurfaceMaterialOptions): WetSurfaceHandle
