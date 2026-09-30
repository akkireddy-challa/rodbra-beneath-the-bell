# engine-api-splats

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/splats/SpzLoader.ts
interface GpuSplatData
GpuSplatData.numSplats: number
GpuSplatData.centers: Float32Array
GpuSplatData.covA: Float32Array
GpuSplatData.covB: Float32Array
GpuSplatData.colorsU32: Uint32Array
GpuSplatData.boundsMin: { x: number; y: number; z: number }
GpuSplatData.boundsMax: { x: number; y: number; z: number }
function parseSpz(bytes: Uint8Array): GpuSplatData
function loadSpz(url: string, onProgress?: (loaded: number, total: number) => void): Promise<GpuSplatData>

## engine/splats/WebGpuSplatMesh.ts
interface WebGpuSplatMeshOptions
WebGpuSplatMeshOptions.kernelRadius: number
WebGpuSplatMeshOptions.sortMatrixEpsilon: number
WebGpuSplatMeshOptions.maxAxisPx: number
const DEFAULT_WEBGPU_SPLAT_OPTIONS: WebGpuSplatMeshOptions
function webGpuSplatsEnabled(): boolean
function maxWebGpuSplats(renderer: unknown): number
function installWebGpuSplatToggleButton(enabled: boolean): void
class WebGpuSplatMesh extends THREE.Mesh
WebGpuSplatMesh.count: number
WebGpuSplatMesh.numSplats: number
WebGpuSplatMesh.constructor(data: GpuSplatData, options: WebGpuSplatMeshOptions = DEFAULT_WEBGPU_SPLAT_OPTIONS)
WebGpuSplatMesh.updateForFrame(renderer: WebGPURenderer, camera: THREE.PerspectiveCamera): void
WebGpuSplatMesh.dispose(): void
function updateWebGpuSplatMeshes(renderer: unknown, camera: THREE.Camera | null): void

## engine/splats/WebGpuSplatSorter.ts
class WebGpuSplatSorter
WebGpuSplatSorter.constructor(numSplats: number, centersAttr: StorageBufferAttribute, sortedIndicesAttr: StorageBufferAttribute)
WebGpuSplatSorter.sort(renderer: WebGPURenderer, modelView: THREE.Matrix4, distMin: number, distRange: number): void
