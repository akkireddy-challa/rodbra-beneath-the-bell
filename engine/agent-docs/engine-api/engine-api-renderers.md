# engine-api-renderers

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/renderers/AssetVehicleRenderer.ts
interface AssetVehicleRendererOptions
AssetVehicleRendererOptions.chassisObject: THREE.Object3D
AssetVehicleRendererOptions.bodyLiftY: number
AssetVehicleRendererOptions.wheelMeshes: THREE.Mesh[]
class AssetVehicleRenderer implements VehicleRenderer
AssetVehicleRenderer.constructor(options: AssetVehicleRendererOptions)
AssetVehicleRenderer.createChassisMesh(_config: VehicleConfig, position: THREE.Vector3): THREE.Object3D
AssetVehicleRenderer.createWheelMeshes(_config: VehicleConfig, position: THREE.Vector3, wheelConfigs?: WheelConfig[]): THREE.Mesh[]

## engine/renderers/PlatformVehicleRenderer.ts
class PlatformVehicleRenderer implements VehicleRenderer — PlatformVehicleRenderer - Creates the basic flat platform visual for vehicles.
PlatformVehicleRenderer.createChassisMesh(config: VehicleConfig, position: THREE.Vector3): THREE.Object3D
PlatformVehicleRenderer.createWheelMeshes(config: VehicleConfig, position: THREE.Vector3, wheelConfigs?: WheelConfig[]): THREE.Mesh[]
PlatformVehicleRenderer.updateVisuals(_deltaTime: number, _speed: number): void
interface VoxelPlatformRendererOptions
VoxelPlatformRendererOptions.voxelSize?: number
VoxelPlatformRendererOptions.useAtlas?: boolean

## engine/renderers/VehicleWheelBuilder.ts
interface ParametricWheelOptions
ParametricWheelOptions.radius: number
ParametricWheelOptions.width: number
ParametricWheelOptions.style: BmWheelStyle
ParametricWheelOptions.dual: boolean
ParametricWheelOptions.tireColor?: number
const DEFAULT_PARAMETRIC_WHEEL: ParametricWheelOptions
function buildParametricWheelMesh(options: ParametricWheelOptions): THREE.Mesh
