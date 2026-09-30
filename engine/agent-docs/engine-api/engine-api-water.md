# engine-api-water

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/water/CoastalDepthField.ts
type CoastalHeightAt = (x: number, z: number) => number | null
function addCoastalDepthAttribute(geometry: THREE.PlaneGeometry, centerX: number, centerZ: number, seaLevel: number, heightAt?: CoastalHeightAt): void

## engine/water/CoastalGroundSampler.ts
function createCoastalGroundSampler(mask: Readonly<GroundMaskData> | null, bounds: VxlWorldBounds | null, fallback: CoastalHeightAt): CoastalHeightAt

## engine/water/CoastalTerrainSampler.ts
function coastalTerrainSampler(engine: GameEngine): CoastalHeightAt

## engine/water/EngineWaterFeatures.ts
const DEFAULT_OPEN_WATER_VIEW_DISTANCE = 6000
interface CoastalBounds — Level bounds the coastal plane spans.
CoastalBounds.minX: number
CoastalBounds.maxX: number
CoastalBounds.minZ: number
CoastalBounds.maxZ: number
interface OpenWaterHost — What building the ocean needs from the engine. `GameEngine` satisfies it.
OpenWaterHost.readonly scene: THREE.Scene | null
OpenWaterHost.getSunDirection(): THREE.Vector3 | null
OpenWaterHost.addToWorld(object: THREE.Object3D): void
function resolveOpenWaterConfig(profile: { openWater?: OpenWaterConfig; waterLevelY?: number; skyboxUrl?: string; playerMovement?: { mode?: string }; } | null | undefined): OpenWaterConfig | null
class EngineWaterFeatures
EngineWaterFeatures.applyCoastal(scene: THREE.Object3D | null, waterLevelY: number | null, bounds: CoastalBounds | null, sunPosition: CoastalSunDirection, heightAt?: CoastalHeightAt): THREE.Mesh | null
EngineWaterFeatures.configureOpenWater(host: OpenWaterHost, config: OpenWaterConfig | null): void
EngineWaterFeatures.getOceanSurface(): OceanSurface | null
EngineWaterFeatures.update(deltaTime: number, camera: THREE.Object3D | null): void
EngineWaterFeatures.dispose(): void

## engine/water/FlatWaterSurface.ts
function flatWaterSurface(seaLevelY: number): WaterSurfaceQuery

## engine/water/OceanSurface.ts
interface OceanSurfaceOptions
OceanSurfaceOptions.waveField: OceanWaveField
OceanSurfaceOptions.seaLevelY: number
OceanSurfaceOptions.radius: number
OceanSurfaceOptions.innerRadius: number
OceanSurfaceOptions.ringCount: number
OceanSurfaceOptions.sectorCount: number
OceanSurfaceOptions.palette: Partial<OceanPalette>
OceanSurfaceOptions.sunDirection: THREE.Vector3
OceanSurfaceOptions.toneBands: number
OceanSurfaceOptions.foamThreshold: number
OceanSurfaceOptions.fleckStrength: number
OceanSurfaceOptions.waveFadeStart: number
OceanSurfaceOptions.waveFadeEnd: number
OceanSurfaceOptions.hazeStart: number
OceanSurfaceOptions.hazeEnd: number
OceanSurfaceOptions.detailFadeStart: number
OceanSurfaceOptions.detailFadeEnd: number
const DEFAULT_OCEAN_SURFACE_OPTIONS: Omit<OceanSurfaceOptions, 'waveField'>
interface OceanSurface
OceanSurface.readonly mesh: THREE.Mesh
OceanSurface.readonly waveField: OceanWaveField
OceanSurface.readonly material: StylizedOceanMaterialHandle
OceanSurface.readonly seaLevelY: number
OceanSurface.readonly time: number
OceanSurface.update(camera: THREE.Object3D, elapsedSeconds: number): void
OceanSurface.heightAt(x: number, z: number): number
OceanSurface.normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3
OceanSurface.setWaveFrame(frame: Readonly<OceanWaveFrame>): void
OceanSurface.setSunDirection(dir: THREE.Vector3): void
OceanSurface.dispose(): void
function createOceanSurface(options: Partial<OceanSurfaceOptions> = {}): OceanSurface
function oceanWaveFieldForPreset(preset: OceanWavePresetName, amplitudeScale = 1, windDirectionDeg = 0): OceanWaveField

## engine/water/OceanWaveField.ts
interface OceanWaveBand — One directional wave train in the field.
OceanWaveBand.dirX: number
OceanWaveBand.dirZ: number
OceanWaveBand.wavelength: number
OceanWaveBand.amplitude: number
OceanWaveBand.speed: number
OceanWaveBand.sharpness: number
interface OceanWaveFieldOptions — Tuning applied on top of a band preset.
OceanWaveFieldOptions.amplitudeScale: number
OceanWaveFieldOptions.speedScale: number
OceanWaveFieldOptions.windDirectionDeg: number
const DEFAULT_OCEAN_WAVE_FIELD_OPTIONS: OceanWaveFieldOptions
const OPEN_OCEAN_WAVE_BANDS: readonly OceanWaveBand[]
const CALM_LAGOON_WAVE_BANDS: readonly OceanWaveBand[]
const STORM_SEA_WAVE_BANDS: readonly OceanWaveBand[]
const OCEAN_WAVE_PRESETS = { calm: CALM_LAGOON_WAVE_BANDS, ocean: OPEN_OCEAN_WAVE_BANDS
type OceanWavePresetName = keyof typeof OCEAN_WAVE_PRESETS
interface OceanWaveField — The compiled wave field. Immutable: retune by building a new one (and
OceanWaveField.readonly bands: readonly CompiledBand[]
OceanWaveField.readonly maxAmplitude: number
OceanWaveField.heightAt(x: number, z: number, t: number): number
OceanWaveField.gradientAt(x: number, z: number, t: number, out: THREE.Vector2): THREE.Vector2
OceanWaveField.normalAt(x: number, z: number, t: number, out: THREE.Vector3): THREE.Vector3
OceanWaveField.glslSource(): string
OceanWaveField.tslWave(px: TslFloat, pz: TslFloat, timeNode: TslFloat): TslVec3
type TslFloat = Node<'float'>
type TslVec3 = Node<'vec3'>
function createOceanWaveField(bands: readonly OceanWaveBand[] = OPEN_OCEAN_WAVE_BANDS, options: Partial<OceanWaveFieldOptions> = {}): OceanWaveField

## engine/water/OceanWaveFrame.ts
interface OceanWaveFrame — Where the ocean's waves are sampled, relative to the world they are drawn in.
OceanWaveFrame.cos: number
OceanWaveFrame.sin: number
OceanWaveFrame.shiftX: number
OceanWaveFrame.shiftZ: number
const IDENTITY_OCEAN_WAVE_FRAME: Readonly<OceanWaveFrame>
function oceanWaveFrameForVoyage(pivotX: number, pivotZ: number, voyageX: number, voyageZ: number, swing: number, out: OceanWaveFrame): OceanWaveFrame
function toWaveSpace(frame: Readonly<OceanWaveFrame>, x: number, z: number, out: THREE.Vector2): THREE.Vector2
function gradientToWorld(frame: Readonly<OceanWaveFrame>, gradient: THREE.Vector2): THREE.Vector2

## engine/water/OpenWaterWorld.ts
function pinEnvironmentObjectsToAuthoredPositions(gameData: unknown): number

## engine/water/WaterSurfaceQuery.ts
interface WaterSurfaceQuery
WaterSurfaceQuery.heightAt(x: number, z: number): number
WaterSurfaceQuery.normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3
