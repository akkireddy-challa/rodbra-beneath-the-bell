# engine-api-shaders

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/shaders/CurvedGroundShader.ts
function createCurvedGroundShaderMaterial(color: THREE.Color | number, options: { roughness?: number; metalness?: number; emissive?: THREE.Color | number; emissiveIntensity?: number; curveIntensity?: number; horizontalCurveIntensity?: number; } = {}): THREE.Material
function applyCurvedShaderToObject(object: THREE.Object3D, options: { curveIntensity?: number; horizontalCurveIntensity?: number; } = {}): void

## engine/shaders/StylizedOceanMaterial.ts
interface OceanPalette — The colours the posterized surface is built from.
OceanPalette.deep: THREE.ColorRepresentation
OceanPalette.mid: THREE.ColorRepresentation
OceanPalette.bright: THREE.ColorRepresentation
OceanPalette.shallow: THREE.ColorRepresentation
OceanPalette.foam: THREE.ColorRepresentation
OceanPalette.horizon: THREE.ColorRepresentation
interface StylizedOceanMaterialOptions
StylizedOceanMaterialOptions.palette: OceanPalette
StylizedOceanMaterialOptions.waveField: OceanWaveField
StylizedOceanMaterialOptions.toneBands: number
StylizedOceanMaterialOptions.foamThreshold: number
StylizedOceanMaterialOptions.fleckStrength: number
StylizedOceanMaterialOptions.waveFadeStart: number
StylizedOceanMaterialOptions.waveFadeEnd: number
StylizedOceanMaterialOptions.hazeStart: number
StylizedOceanMaterialOptions.hazeEnd: number
StylizedOceanMaterialOptions.detailFadeStart: number
StylizedOceanMaterialOptions.detailFadeEnd: number
StylizedOceanMaterialOptions.sunDirection: THREE.Vector3
const DEFAULT_OCEAN_PALETTE: OceanPalette
const DEFAULT_STYLIZED_OCEAN_OPTIONS: Omit<StylizedOceanMaterialOptions, 'waveField'>
interface StylizedOceanMaterialHandle
StylizedOceanMaterialHandle.material: THREE.Material
StylizedOceanMaterialHandle.setTime(seconds: number): void
StylizedOceanMaterialHandle.setOrigin(x: number, z: number): void
StylizedOceanMaterialHandle.setWaveFrame(frame: Readonly<OceanWaveFrame>): void
StylizedOceanMaterialHandle.setSunDirection(dir: THREE.Vector3): void
StylizedOceanMaterialHandle.setHorizonColor(color: THREE.ColorRepresentation): void
StylizedOceanMaterialHandle.dispose(): void
function createStylizedOceanMaterial(options: Partial<StylizedOceanMaterialOptions> = {}): StylizedOceanMaterialHandle

## engine/shaders/WaterMaterial.ts
interface WaterMaterialHandle — Realtime, see-through animated water SURFACE for coastal levels. ONE plane spans the whole
WaterMaterialHandle.material: THREE.Material
WaterMaterialHandle.setTime: (seconds: number) => void
WaterMaterialHandle.setSunDirection: (dir: THREE.Vector3) => void
function createWaterMaterial(color: THREE.ColorRepresentation = DEFAULT_WATER_COLOR, options: { bathymetry?: boolean } = {}): WaterMaterialHandle
