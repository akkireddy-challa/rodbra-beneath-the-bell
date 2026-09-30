# engine-api-builders

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/builders/BoxCarBodyBuilder.ts
interface BoxPartConfig — Configuration for a box part of the car body.
BoxPartConfig.position: { x: number; y: number; z: number }
BoxPartConfig.size: { width: number; height: number; length: number }
BoxPartConfig.color: number
BoxPartConfig.isWindow?: boolean
interface BoxCarBodyConfig — Configuration for building a box-based car body.
BoxCarBodyConfig.parts: BoxPartConfig[]
BoxCarBodyConfig.windowOpacity?: number
class BoxCarBodyBuilder — BoxCarBodyBuilder creates car bodies using THREE.js boxes.
static BoxCarBodyBuilder.addBoxBody(vehicle: Vehicle, platform: VehiclePlatformStructure, config: BoxCarBodyConfig): THREE.Group
static BoxCarBodyBuilder.createBoxRenderer(platform: VehiclePlatformStructure, config: BoxCarBodyConfig): VehicleRenderer

## engine/builders/VoxelCarBodyBuilder.ts
interface VoxelBlockConfig — Configuration for a voxel block in the car body.
VoxelBlockConfig.x: number
VoxelBlockConfig.y: number
VoxelBlockConfig.z: number
VoxelBlockConfig.color: number
interface VoxelPartConfig — Configuration for a voxel box part (fills a rectangular region with voxels).
VoxelPartConfig.position: { x: number; y: number; z: number }
VoxelPartConfig.size: { width: number; height: number; length: number }
VoxelPartConfig.color: number
VoxelPartConfig.isWindow?: boolean
interface VoxelCarBodyConfig — Configuration for building a voxel car body.
VoxelCarBodyConfig.blocks?: VoxelBlockConfig[]
VoxelCarBodyConfig.parts?: VoxelPartConfig[]
VoxelCarBodyConfig.voxelSize?: number
class VoxelCarBodyBuilder — VoxelCarBodyBuilder creates car bodies using VoxelObjects.
static VoxelCarBodyBuilder.getCarBodyVoxelObjects(): Set<VoxelObject>
static VoxelCarBodyBuilder.isCarBody(voxelObject: VoxelObject): boolean
static VoxelCarBodyBuilder.sedanBody(color: number): VoxelCarBodyConfig
static VoxelCarBodyBuilder.addVoxelBody(vehicle: Vehicle, platform: VehiclePlatformStructure, config: VoxelCarBodyConfig): VoxelObject
static VoxelCarBodyBuilder.populateVoxels(target: VoxelObject, config: VoxelCarBodyConfig, voxelSize: number): void
static VoxelCarBodyBuilder.addPartAsVoxels(voxelBody: VoxelObject, part: VoxelPartConfig, voxelSize: number): void
static VoxelCarBodyBuilder.createVoxelRenderer(platform: VehiclePlatformStructure, config: VoxelCarBodyConfig): VehicleRenderer

## engine/builders/VoxelObjectBuilder.ts
interface VoxelBlockConfig — Configuration for a single voxel block in an object.
VoxelBlockConfig.x: number
VoxelBlockConfig.y: number
VoxelBlockConfig.z: number
VoxelBlockConfig.color: number
VoxelBlockConfig.blockType?: string | number
const SMART_PROP_BAKE = 'smartPropBake'
interface VoxelPartConfig
VoxelPartConfig.position: { x: number; y: number; z: number }
VoxelPartConfig.size: { width: number; height: number; length: number }
VoxelPartConfig.color: number
VoxelPartConfig.blockType?: string | number
VoxelPartConfig.shape?: 'box' | 'sphere'
VoxelPartConfig.emissive?: number
VoxelPartConfig.material?: string
VoxelPartConfig.materialClass?: string
VoxelPartConfig.part?: string
interface VoxelObjectConfig — Configuration for building a voxel object.
VoxelObjectConfig.name: string
VoxelObjectConfig.blocks?: VoxelBlockConfig[]
VoxelObjectConfig.parts?: VoxelPartConfig[]
VoxelObjectConfig.smart?: SmartPropSpec
VoxelObjectConfig.voxelSize?: number
VoxelObjectConfig.physicsMode?: 'static' | 'dynamic'
VoxelObjectConfig.mass?: number
VoxelObjectConfig.colliderShape?: 'box' | 'sphere'
VoxelObjectConfig.shadows?: boolean
VoxelObjectConfig.positionMode?: 'center' | 'corner'
interface VoxelObjectResult — Result from creating a voxel object
VoxelObjectResult.object: VoxelObject
VoxelObjectResult.id: string
class VoxelObjectBuilder — VoxelObjectBuilder - Creates voxel objects with automatic physics.
static VoxelObjectBuilder.setWorldGroup(group: THREE.Object3D | null): void
static VoxelObjectBuilder.getWorldGroup(): THREE.Object3D | null
static VoxelObjectBuilder.registerExternalObject(id: string, voxelObject: VoxelObject): void
static VoxelObjectBuilder.unregisterExternalObject(id: string): void
static VoxelObjectBuilder.getObject(id: string): VoxelObject | undefined
static VoxelObjectBuilder.getAllObjects(): Map<string, VoxelObject>
static VoxelObjectBuilder.getObjectsGroupedByName(): Map<string, VoxelObject[]>
static VoxelObjectBuilder.create(config: VoxelObjectConfig, parentOrPhysics?: THREE.Object3D | PhysicsWorld, physicsOrPosition?: PhysicsWorld | THREE.Vector3, positionOrAtlas?: THREE.Vector3 | VoxelTextureAtlas, atlas?: VoxelTextureAtlas): VoxelObjectResult
static VoxelObjectBuilder.createMultiple(config: VoxelObjectConfig, physicsWorld: PhysicsWorld | undefined, positions: THREE.Vector3[], atlas?: VoxelTextureAtlas): VoxelObjectResult[]
static VoxelObjectBuilder.addPartAsVoxels(voxelObject: VoxelObject, part: VoxelPartConfig, voxelSize: number, atlas?: VoxelTextureAtlas): number
static VoxelObjectBuilder.remove(id: string): void
static VoxelObjectBuilder.removeAll(): void
