# engine-api-nav

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/nav/NavSerialization.ts
const VOID_SENTINEL = 0xFFFF
const OBSTACLE_BIT = 0x0001
const TERRAIN_BIT = 0x0002
const BLOCKED_BITS = OBSTACLE_BIT | TERRAIN_BIT
const DELTA_SHIFT = 2
const DELTA_MAX = 0x3FFE
const NAV_SIDECAR_MAGIC = 0x564e4d42
const NAV_SIDECAR_VERSION = 1
const MAX_NAV_LAYERS = 8
const NAV_HEADER_BYTES = 56
interface TrivialChunk — Trivial chunk: uniform groundY, every cell walkable, never blocked.
TrivialChunk.kind: 'trivial'
TrivialChunk.cx: number
TrivialChunk.cz: number
TrivialChunk.groundY: number
interface GridChunk — Grid chunk: one packed cell per column, indexed [lx * cellsPerSide + lz].
GridChunk.kind: 'grid'
GridChunk.cx: number
GridChunk.cz: number
GridChunk.cellSize: number
GridChunk.cellsPerSide: number
GridChunk.baseY: number
GridChunk.voxelSize: number
GridChunk.data: Uint16Array
interface MultiLayerChunk — Multilayer chunk: several stacked walkable surfaces per column (dungeon
MultiLayerChunk.kind: 'multilayer'
MultiLayerChunk.cx: number
MultiLayerChunk.cz: number
MultiLayerChunk.cellSize: number
MultiLayerChunk.cellsPerSide: number
MultiLayerChunk.baseY: number
MultiLayerChunk.voxelSize: number
MultiLayerChunk.layerCount: number
MultiLayerChunk.data: Uint16Array
type NavChunk = TrivialChunk | GridChunk | MultiLayerChunk
interface NavHeader — Whole-mesh parameters. One header per sidecar.
NavHeader.cellSize: number
NavHeader.agentRadius: number
NavHeader.voxelSize: number
NavHeader.chunkWorldSize: number
NavHeader.minX: number
NavHeader.minZ: number
NavHeader.chunkCols: number
NavHeader.chunkRows: number
NavHeader.cellsPerChunkSide: number
NavHeader.maxClimbM: number
NavHeader.maxDropM: number
function encodeNavMesh(header: NavHeader, chunks: Iterable<NavChunk>): Uint8Array
function decodeNavMesh(data: ArrayBuffer): { header: NavHeader; chunks: NavChunk[] }

## engine/nav/PropFootprint.ts
const NAV_FOOTPRINT_SLICE_M = 1.2
function groundContactBounds(geometry: THREE.BufferGeometry): THREE.Box3 | null

## engine/nav/VehicleNavGrid.ts
interface NavPoint — A point on the XZ ground plane.
NavPoint.x: number
NavPoint.z: number
interface VehicleNavQueryOptions
VehicleNavQueryOptions.footprint: VehicleFootprint
VehicleNavQueryOptions.maxStepHeight: number
VehicleNavQueryOptions.maxClimbGrade: number
const DEFAULT_VEHICLE_NAV_QUERY_OPTIONS: VehicleNavQueryOptions
interface VehicleNavPath
VehicleNavPath.points: NavPoint[]
VehicleNavPath.reachedDestination: boolean
VehicleNavPath.shortfall: number
VehicleNavPath.provisional: boolean
VehicleNavPath.method: string
interface VehicleNav — The engine-facing nav contract. A procedural-voxel backend can implement it later.
VehicleNav.findVehiclePath(from: NavPoint, to: NavPoint, opts?: VehicleNavQueryOptions): VehicleNavPath
VehicleNav.isFullyBaked(): boolean
VehicleNav.getRevision(): number
interface VehicleCapabilitySource — Structural — deliberately NOT importing RapierVehicle (keeps this module pure).
VehicleCapabilitySource.getFootprint(): VehicleFootprint
VehicleCapabilitySource.getMaxClimbGrade(): number
VehicleCapabilitySource.getMaxStepHeight(): number
function queryOptionsForVehicle(vehicle: VehicleCapabilitySource): VehicleNavQueryOptions
interface VehicleNavGridDims
VehicleNavGridDims.cellSize: number
VehicleNavGridDims.width: number
VehicleNavGridDims.height: number
VehicleNavGridDims.minX: number
VehicleNavGridDims.minZ: number
interface GridCoord — A cell coordinate pair, as returned by `worldToCell`.
GridCoord.gx: number
GridCoord.gz: number
const CELL_VALIDATED = 1
const CELL_PROP_BLOCKED = 2
class VehicleNavGrid implements VehicleNav
VehicleNavGrid.dims: VehicleNavGridDims
VehicleNavGrid.constructor(dims: VehicleNavGridDims)
VehicleNavGrid.index(gx: number, gz: number): number
VehicleNavGrid.inBounds(gx: number, gz: number): boolean
VehicleNavGrid.worldToCell(x: number, z: number): GridCoord | null
VehicleNavGrid.cellToWorld(gx: number, gz: number): NavPoint
VehicleNavGrid.getCost(gx: number, gz: number): number
VehicleNavGrid.setCost(gx: number, gz: number, cost: number): void
VehicleNavGrid.getGroundY(gx: number, gz: number): number
VehicleNavGrid.setGroundY(gx: number, gz: number, y: number): void
VehicleNavGrid.getFlags(gx: number, gz: number): number
VehicleNavGrid.setFlags(gx: number, gz: number, flags: number): void
VehicleNavGrid.setEdgeMidpointY(indexA: number, indexB: number, y: number): void
VehicleNavGrid.getEdgeMidpointY(indexA: number, indexB: number): number | null
VehicleNavGrid.isFullyBaked(): boolean
VehicleNavGrid.markFullyBaked(): void
VehicleNavGrid.getRevision(): number
VehicleNavGrid.bumpRevision(): void
VehicleNavGrid.findVehiclePath(from: NavPoint, to: NavPoint, opts: VehicleNavQueryOptions = DEFAULT_VEHICLE_NAV_QUERY_OPTIONS): VehicleNavPath
type EdgeVerdict = { passable: boolean; reason: 'clear' | 'step' | 'blocked-cell' | 'unknown' | 'narrow' }
function evaluateGridEdge(grid: VehicleNavGrid, fromGx: number, fromGz: number, toGx: number, toGz: number, opts: VehicleNavQueryOptions): EdgeVerdict
function setGlobalVehicleNav(nav: VehicleNav | null): void
function getGlobalVehicleNav(): VehicleNav | null

## engine/nav/VehicleNavGridBake.ts
const VEHICLE_DRIVE_COST: Readonly<Record<number, number>>
const BAKE_STEP_BUDGET_MS = 4
const BAKE_PRIOR_BAND_M = 2
const BAKE_PROP_MIN_ABOVE_M = 0.3
const BAKE_PROP_MAX_ABOVE_M = 2.5
const BAKE_CANOPY_SKIP_LIMIT = 8
const BAKE_MIDPOINT_MIN_RISE_M = 0.05
const BAKE_OBSTRUCTION_MIN_ABOVE_M = 0.15
const BAKE_WALL_MIN_ABOVE_M = 0.25
const BAKE_WALL_MAX_ABOVE_M = 1.9
const BAKE_REVALIDATE_DELAY_MS = 8000
type CastDown = (x: number, fromY: number, z: number, maxDist: number) => { y: number; isTerrainBody: boolean } | null
type CheckObstruction = (x: number, groundY: number, z: number) => boolean
type CheckWallObstruction = (x: number, groundY: number, z: number) => boolean
function seedFromMask(grid: VehicleNavGrid, mask: Readonly<GroundMaskData>, maskMinX: number, maskMinZ: number): void
function repaintMaskRect(grid: VehicleNavGrid, mask: Readonly<GroundMaskData>, maskMinX: number, maskMinZ: number, rect: { minX: number; minZ: number; maxX: number; maxZ: number }): GridCoord[]
class VehicleNavGridBakePass — Time-sliced collider raycast pass: `start()` queues every drivable cell,
VehicleNavGridBakePass.constructor(grid: VehicleNavGrid, castDown: CastDown, checkObstruction: CheckObstruction, checkWallObstruction: CheckWallObstruction, now: () => number)
VehicleNavGridBakePass.get isDone(): boolean
VehicleNavGridBakePass.start(): void
VehicleNavGridBakePass.enqueueCell(gx: number, gz: number): void
VehicleNavGridBakePass.step(): void

## engine/nav/VehicleNavSearch.ts
const MAX_LEG_M = 25
const SNAP_RADIUS_M = 16
const MAX_EXPANSIONS = 150_000
const CLEARANCE_PENALTY = 0.75
function supercoverLine(x0: number, z0: number, x1: number, z1: number): GridCoord[]
function hasLineOfSight(grid: VehicleNavGrid, a: GridCoord, b: GridCoord, opts: VehicleNavQueryOptions): boolean
const CORNER_RADIUS_M = 8
function smoothRouteCorners(grid: VehicleNavGrid, points: NavPoint[], opts: VehicleNavQueryOptions): NavPoint[]
function findVehiclePathOnGrid(grid: VehicleNavGrid, from: NavPoint, to: NavPoint, opts: VehicleNavQueryOptions): VehicleNavPath
