# engine-api-voxelcarve

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/voxelcarve/LeafCarver.ts
interface CarvedCube — A cube removed by a carve, for debris and damage accounting.
CarvedCube.x: number
CarvedCube.y: number
CarvedCube.z: number
CarvedCube.size: number
CarvedCube.r: number
CarvedCube.g: number
CarvedCube.b: number
interface CarveOutcome
CarveOutcome.leaves: OctreeLeaf[]
CarveOutcome.removed: CarvedCube[]
CarveOutcome.removedVolume: number
class LeafCarver — Applies a batch of carves to one leaf set.
LeafCarver.constructor(leaves: readonly OctreeLeaf[], minVoxelSize: number)
LeafCarver.hasChanges(): boolean
LeafCarver.getRemoved(): readonly CarvedCube[]
LeafCarver.carveAlong(x: number, y: number, z: number, dirX: number, dirY: number, dirZ: number, holeSize: number, maxDistance: number): CarvedCube | null
LeafCarver.carve(x: number, y: number, z: number, holeSize: number): CarvedCube | null
LeafCarver.result(): CarveOutcome

## engine/voxelcarve/VoxelCarveSystem.ts
const DEFAULT_BULLET_HOLE_SIZE = 0.05
interface VoxelCarveConfig
VoxelCarveConfig.holeSize: number
VoxelCarveConfig.maxObjectsPerFrame: number
VoxelCarveConfig.maxLeavesPerObject: number
const DEFAULT_VOXEL_CARVE_CONFIG: VoxelCarveConfig
class VoxelCarveSystem
VoxelCarveSystem.onObjectCarved: ((object: VoxelObject, removed: readonly CarvedCube[]) => void) | null
VoxelCarveSystem.constructor(config: VoxelCarveConfig = DEFAULT_VOXEL_CARVE_CONFIG)
VoxelCarveSystem.configure(overrides: Partial<VoxelCarveConfig>): void
VoxelCarveSystem.canCarve(object: VoxelObject | null): object is VoxelObject
VoxelCarveSystem.queueHit(object: VoxelObject | null, worldPoint: THREE.Vector3, holeSize?: number, hit?: { body: RAPIER.RigidBody; physicsWorld: PhysicsWorld; normal?: THREE.Vector3; /** The bullet's flight direction — the preferred march axis. */ travelDirection?: THREE.Vector3; }): boolean
VoxelCarveSystem.processPendingCarves(): void
VoxelCarveSystem.getLastRemoved(): readonly CarvedCube[]
VoxelCarveSystem.dispose(): void
function initVoxelCarveSystem(config?: VoxelCarveConfig): VoxelCarveSystem
function getVoxelCarveSystem(): VoxelCarveSystem | null
