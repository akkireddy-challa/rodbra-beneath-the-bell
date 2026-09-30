# engine-api-template

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/template/CreatorMessageHandler.ts
interface CreatorMessageContext
CreatorMessageContext.getEngine(): GameEngine | null
CreatorMessageContext.runtimeController: GameRuntimeController
CreatorMessageContext.getCurrentGameData(): any
CreatorMessageContext.setCurrentGameData(data: any): void
CreatorMessageContext.getCurrentGameId(): string | null
CreatorMessageContext.isGameLoading(): boolean
CreatorMessageContext.ensureNotification(): InGameNotification
CreatorMessageContext.loadGame(gameId: string, gameData: GameData, setPlayingState?: boolean): Promise<void>
CreatorMessageContext.reloadCurrentGame(): Promise<void>
CreatorMessageContext.disposeGame(): void
CreatorMessageContext.captureScreenshot(mode?: 'immediate' | 'warmup'): Promise<void>
CreatorMessageContext.handleGameStart(): Promise<void>
CreatorMessageContext.showMenu(): void
function registerCreatorMessageListener(context: CreatorMessageContext): void
function notifyPhysicsReady(): Promise<void>
function flushPendingToolMessages(): Promise<void>

## engine/template/EditorTabHandler.ts
function handleSetEditorTab(gameEngine: GameEngine, runtimeController: GameRuntimeController, getStateManager: () => import('engine/GameStateManager.js').GameStateManager, data: { tab?: string | null }, safePostMessage: (msg: any) => void): void

## engine/template/EnvObjectCollision.ts
function envObjectCollides(objDef: { collision?: boolean } | null | undefined, asset: { collision?: boolean } | null | undefined): boolean

## engine/template/EnvObjectRecord.ts
function findAssetById<A extends { id: string }>(assets: A[] | undefined, assetId: string | undefined): A | undefined
interface VoxelPlacementInput — Shared shape for the single-place / batch-place payloads' transform fields.
VoxelPlacementInput.asset_name: string
VoxelPlacementInput.asset_id?: string
VoxelPlacementInput.position: { x: number; z: number; y?: number }
VoxelPlacementInput.rotation?: { x: number; y: number; z: number }
VoxelPlacementInput.scale?: { x: number; y: number; z: number }
VoxelPlacementInput.name?: string
VoxelPlacementInput.interactable?: boolean
VoxelPlacementInput.placeOnTerrain?: boolean
VoxelPlacementInput.collectible?: boolean
VoxelPlacementInput.destructible?: boolean
VoxelPlacementInput.dynamic?: boolean
VoxelPlacementInput.mass?: number
VoxelPlacementInput.flatten_terrain?: boolean
VoxelPlacementInput.force_position?: boolean
VoxelPlacementInput.collision?: boolean
const INSTANCE_FLAG_FIELDS: ReadonlyArray<InstanceFlagField>
function activeLevelTag(): { levelId?: string }
function rotationDegToRad(rotation?: { x: number; y: number; z: number }): { x: number; y: number; z: number }
function buildEnvObject(input: VoxelPlacementInput, assetId: string, instanceId: string, position: { x: number; y: number; z: number }): Record<string, unknown>

## engine/template/FBXMessageHandlers.ts
function handleProcessFBXAnimation(ctx: GameTemplateContext, data: { requestId: string; fileData: ArrayBuffer; fileName: string }): Promise<void>
function handleTestFBXWithSkin(ctx: GameTemplateContext, data: { requestId: string; fileData: ArrayBuffer; fileName: string; position?: { x: number; y: number; z: number }; }): Promise<void>
function handleCleanupFBXTest(ctx: GameTemplateContext): void

## engine/template/GameDataMessageHandlers.ts
interface GameDataCategorySummary
GameDataCategorySummary.name: string
GameDataCategorySummary.config: Record<string, unknown>
GameDataCategorySummary.entries: Array<{ id: string; values: Record<string, string | number>; data?: Record<string, unknown>; meta: { revision: number; createdAt: string; updatedAt: string; expireAt: string | null }; hasSecret?: boolean; }>
GameDataCategorySummary.error?: string
interface ResetCategoryResult
ResetCategoryResult.jobId: string
ResetCategoryResult.totalEstimate: number | null
interface UsageReport
UsageReport.usedBytes: number
UsageReport.quotaBytes: number
UsageReport.categoryCount: number
UsageReport.entryCount: number
function ensureGameRegistered(gameId: string, adminToken: string): Promise<void>
function fetchGameDataCategoriesForDialog(gameId: string, adminToken: string): Promise<GameDataCategorySummary[]>
function fetchGameDataUsage(gameId: string, adminToken: string): Promise<UsageReport>
function resetGameDataCategory(gameId: string, adminToken: string, category: string): Promise<ResetCategoryResult>
function deleteGameDataEntry(gameId: string, adminToken: string, category: string, entryId: string): Promise<void>

## engine/template/GameTemplateContext.ts
interface GameTemplateContext
GameTemplateContext.getGameEngine(): GameEngine | null
GameTemplateContext.getCurrentGameData(): any
GameTemplateContext.setCurrentGameData(data: any): void
GameTemplateContext.safePostMessage(message: any): void

## engine/template/GlbAnimationMessageHandlers.ts
interface GlbAnimationInspection
GlbAnimationInspection.hasAnimations: boolean
GlbAnimationInspection.hasRenderableMesh: boolean
GlbAnimationInspection.animationCount: number
GlbAnimationInspection.skeletonHeight: number
GlbAnimationInspection.unitScale: number
function inspectGlbAnimation(fileData: ArrayBuffer): Promise<GlbAnimationInspection>
function handleInspectGlbAnimation(ctx: GameTemplateContext, data: { requestId: string; fileData: ArrayBuffer; fileName: string }): Promise<void>

## engine/template/GlbAssetMessageHandlers.ts
interface GenerateGlbColliderData
GenerateGlbColliderData.requestId: string
GenerateGlbColliderData.glbUrl: string
GenerateGlbColliderData.assetName: string
function handleGenerateGlbCollider(ctx: GameTemplateContext, data: GenerateGlbColliderData): Promise<void>
interface GenerateGlbPreviewData
GenerateGlbPreviewData.requestId: string
GenerateGlbPreviewData.glbUrl: string
function handleGenerateGlbPreview(ctx: GameTemplateContext, data: GenerateGlbPreviewData): Promise<void>

## engine/template/GlbLevelInspectMessageHandlers.ts
interface LevelGlbObjectEntry
LevelGlbObjectEntry.name: string
LevelGlbObjectEntry.triangleCount: number
interface LevelGlbInspection
LevelGlbInspection.objects: LevelGlbObjectEntry[]
LevelGlbInspection.totalTriangleCount: number
LevelGlbInspection.suggestedSettings?: Record<string, unknown>
function inspectGlbForLevelVoxelize(fileData: ArrayBuffer): Promise<LevelGlbInspection>
function handleInspectGlbForLevelVoxelize(ctx: GameTemplateContext, data: { requestId: string; fileData: ArrayBuffer; fileName: string }): Promise<void>

## engine/template/HqGeneratingHandler.ts
function applyHqGeneratingAssets(assetIds: string[], gameData: GameData | null): void
function disposeHqGeneratingHighlight(): void

## engine/template/ObjectHighlight.ts
function findObjectAtPosition(gameEngine: GameEngine, position: { x: number; y: number; z: number }, searchRadius: number = 2): THREE.Object3D | null
function createHighlightBox(gameEngine: GameEngine, position: { x: number; y: number; z: number }, objectType?: string): void
function clearObjectHighlight(gameEngine: GameEngine): void

## engine/template/SceneFootprint.ts
interface FootprintEntry
FootprintEntry.k: string
FootprintEntry.c: [number, number, number]
FootprintEntry.s: [number, number, number]
FootprintEntry.col?: string
interface SceneFootprintResponse
SceneFootprintResponse.requestId: string
SceneFootprintResponse.entries?: FootprintEntry[]
SceneFootprintResponse.error?: string
function collectSceneFootprint(engine: GameEngine): FootprintEntry[]
function handleSceneFootprint(engine: GameEngine | null, data: unknown, post: (message: { type: 'SCENE_FOOTPRINT_RESPONSE'; data: SceneFootprintResponse }) => void): void

## engine/template/ViewCaptureHandler.ts
type Vec3 = { x: number; y: number; z: number }
type ViewTarget = | { kind: 'current-view' } | { kind: 'player' } /** `id` is looked up in the scene; `position` (+ `radius`) frames a spot when the id is not found or not given. */ | { kind: 'entity'; id?: string; position?: Vec3; radius?: number } | { kind: 'level'; preset: 'topdown' | 'isometric' } /** * A stored camera pose (a current view's `info.camera`), rendered off-screen at * `width`×`height`. The visual check after an edit uses it to re-take the * creator's view from exactly where they were looking, whatever the reload * did to the live camera. */ | { kind: 'camera'; position: Vec3; forward: Vec3; fov: number; width: number; height: number }
interface CaptureViewRequest
CaptureViewRequest.requestId: string
CaptureViewRequest.target: ViewTarget
CaptureViewRequest.angles: 1 | 4
CaptureViewRequest.upload: boolean
CaptureViewRequest.pins: PinInput[]
interface ViewCaptureInfo
ViewCaptureInfo.resolved: string
ViewCaptureInfo.center?: [number, number, number]
ViewCaptureInfo.size?: [number, number, number]
ViewCaptureInfo.views: string[]
ViewCaptureInfo.gameState: string
ViewCaptureInfo.hudIncluded: false
ViewCaptureInfo.width: number
ViewCaptureInfo.height: number
ViewCaptureInfo.note?: string
ViewCaptureInfo.camera?: { position: [number, number, number]; forward: [number, number, number]; fov?: number }
ViewCaptureInfo.pins?: ViewPin[]
ViewCaptureInfo.geometryCoverage?: number
interface ViewCaptureResponse
ViewCaptureResponse.requestId: string
ViewCaptureResponse.url?: string
ViewCaptureResponse.dataUrl?: string
ViewCaptureResponse.info?: ViewCaptureInfo
ViewCaptureResponse.error?: string
function parseCaptureViewRequest(data: unknown): CaptureViewRequest | string
function buildFramingCamera(box: THREE.Box3, forward: THREE.Vector3, view: { yaw: number; pitch: number }, aspect: number): THREE.PerspectiveCamera
function geometryCoverage(camera: THREE.PerspectiveCamera, world: THREE.Object3D, reach: number): number
function handleCaptureView(engine: GameEngine | null, data: unknown, post: (message: { type: 'VIEW_CAPTURE_RESPONSE'; data: ViewCaptureResponse }) => void): Promise<void>

## engine/template/ViewPins.ts
interface PinInput
PinInput.id: string
PinInput.label: string
PinInput.position: { x: number; y: number; z: number }
interface ViewPin
ViewPin.n: number
ViewPin.id: string
ViewPin.label: string
ViewPin.position: [number, number, number]
ViewPin.screen: [number, number]
ViewPin.distance: number
const MAX_VIEW_PINS = 20
function parsePinInputs(raw: unknown): PinInput[]
function projectPins(candidates: readonly PinInput[], camera: THREE.Camera, width: number, height: number, max: number = MAX_VIEW_PINS): ViewPin[]
function engineActorPins(engine: GameEngine): PinInput[]
function drawPins(ctx: CanvasRenderingContext2D, pins: readonly ViewPin[]): void

## engine/template/VoxelImportMessageHandlers.ts
interface InspectVoxelModelData
InspectVoxelModelData.requestId: string
InspectVoxelModelData.fileData: number[]
InspectVoxelModelData.fileName: string
function handleInspectVoxelModel(ctx: GameTemplateContext, data: InspectVoxelModelData): Promise<void>
interface ImportVoxelModelData
ImportVoxelModelData.requestId: string
ImportVoxelModelData.fileData: number[]
ImportVoxelModelData.fileName: string
ImportVoxelModelData.destination: 'asset' | 'level'
ImportVoxelModelData.settings: { voxelSize: number; multiModelMode: 'merge' | 'separate'; additionalLodCount?: number; // asset destination chunkSize?: number; // level destination additionalLodDistances?: number[]; // level destination sourceModelUrl?: string; // retained source (level asset record) sourceModelFormat?: 'vox' | 'qb'; }
function handleImportVoxelModel(ctx: GameTemplateContext, data: ImportVoxelModelData): Promise<void>

## engine/template/VoxelMessageHandlers.ts
function handleCreateVoxelAsset(ctx: GameTemplateContext, data: { requestId: string; name: string; parts: VoxelPartConfig[]; voxelSize: number; flattenTerrain?: boolean; flattenMargin?: number; assetId?: string; // pre-generated id from the AI manifest — honored as the asset id colliderShape?: 'box' | 'sphere'; // 'sphere' = dynamic instances roll (single ball collider) /** Moving parts and lights by the boxes' `part` names — a smart object from the first bake. */ smart?: SmartPropSpec; }): Promise<void>
function handlePlaceVoxelObject(ctx: GameTemplateContext, data: VoxelPlacementInput & { requestId: string }): Promise<void>
function handleBatchPlaceVoxelObjects(ctx: GameTemplateContext, data: { requestId: string; objects: VoxelPlacementInput[] }): Promise<void>
function handleModifyVoxelObject(ctx: GameTemplateContext, data: { requestId: string; object_id: string; position?: { x: number; z: number; y?: number }; rotation?: { x: number; y: number; z: number }; scale?: { x: number; y: number; z: number }; flatten_terrain?: boolean; force_position?: boolean; collision?: boolean; }): Promise<void>
function handleDeleteVoxelObject(ctx: GameTemplateContext, data: { requestId: string; object_id: string }): Promise<void>
function handleGenerateVoxelPreview(ctx: GameTemplateContext, data: { requestId: string; vxlData: number[] }): Promise<void>
function handleRegisterCustomBlockType(ctx: GameTemplateContext, data: { name: string; textureUrl: string; sideTextureUrl?: string | null; textureSize: number }): Promise<void>
function handleVoxelizeGLB(ctx: GameTemplateContext, data: { requestId: string; glbData: number[]; options: { minVoxelSize: number; maxVoxelSize: number; targetHeight?: number; fillInterior: boolean; preFragment?: { targetFragments?: number; individualVoxels?: number }; additionalLods?: Array<{ minVoxelSize: number; maxVoxelSize: number }>; algorithm?: 'surface' | 'octree'; }; }): Promise<void>
function handleVoxelizeGlbAsLevel(ctx: GameTemplateContext, data: { requestId: string; /** GLB bytes — used for first-time voxelize where the file was just picked. */ glbData?: number[]; /** Already-uploaded GLB URL — used for re-voxelize where the source GLB * was uploaded on the original run and persisted on the asset record. */ glbUrl?: string; /** User-friendly label for the asset record (typically the source GLB name). */ levelName: string; options: { levelSizeX: number; levelSizeZ: number; levelSizeY?: number; chunkSize: number; minVoxelSize: number; maxVoxelSize: number; fillInterior: boolean; /** Per-LOD shape; `distance` is round-tripped onto the asset * record so the runtime can apply it to the chunked-terrain * system at load time. Voxelizer itself ignores `distance`. */ additionalLods?: Array<{ minVoxelSize: number; maxVoxelSize: number; distance?: number }>; /** Per-object LOD-offset overrides keyed by top-level GLB node * name. Missing/empty = no overrides (single-pass voxelize). */ objectLodOffsets?: Record<string, number>; /** Per-object "pin LOD" flags (same key space as offsets). * Pinned objects' triangles voxelize only at LOD 0; their * LOD-0 leaves get replicated into every additional LOD slot * so the object renders at constant quality regardless of * camera distance. Missing/empty = no pins. */ objectLodPins?: Record<string, true>; /** Per-object "trimesh collider" flags (same key space). * Tagged objects' GLB triangles are baked into each chunk as * a Rapier trimesh collider; their voxel leaves are marked * "no-collider" so they only render. Missing/empty = no * trimesh colliders (all objects use voxel-cube physics). */ objectTrimeshColliders?: Record<string, true>; /** Per-object "no collider" flags (same key space). Tagged objects * are decoration: their voxels/quads are excluded from ALL collision * (no voxel, quad, or trimesh collider) so painted lines and similar * surface detail aren't steps vehicles/players collide with. They * still render. Missing/empty = all objects collide. */ objectNoColliders?: Record<string, true>; /** Per-object collision-only nodes: named trimesh collision with no render output. */ objectCollisionOnlyNodes?: Record<string, true>; /** Per-object smooth-surface axis ('x' | 'y' | 'z'). Voxels * for that object slide along the chosen axis to put cube * faces on the actual surface. One axis per object to avoid * within-object gaps; missing = grid-aligned. */ objectDisplacementAxes?: Record<string, 'x' | 'y' | 'z'>; /** Per-object "library-asset instance" flags (same key space). * Tagged objects are EXCLUDED from the bake — they are * placeholder instance groups for library assets placed as * environment objects (World Forger levels). Missing/empty = * every object bakes. */ objectAssetInstances?: Record<string, true>; /** Per-object ground-type names (same key space; GroundTypes.ts * registry). Rasterized into the v6 ground mask that drives the * runtime cobble domes / grass cover. Missing/empty = no mask. */ objectGroundTypes?: Record<string, string>; /** * Bake-time per-color emissive: keys are `#RRGGBB` authored colors, values * 1..255 strength. Matched EXACTLY (RGB444 cell equality — see * `emissiveByColor.ts`) against the colors this bake produces and written * into the v7 world-level emissive palette. Unmatched keys are reported * back as `emissiveUnmatched` (a bake note, not an error). Missing/empty = * no emissive palette section. */ emissiveByColor?: Record<string, number>; /** * Bake-time per-color MATERIAL CLASSES: keys are `#RRGGBB` authored colors, * values `VoxelMaterialClass` names ('stone', 'wood', 'metal', …). Matched * with a small tolerance and budget-capped (see `classByColor.ts`) and * written into the v9 world-level class section. Unmatched keys come back * as `materialUnmatched`, collapse decisions as `materialNotes` (bake * notes, not errors). Missing/empty = no class section. */ materialByColor?: Record<string, string>; /** * Trim the world to a corridor around the level's designed path (the * World Forger's `path` gameplay feature, which the creator reads off * the asset record and sends here as `points`). `distanceM` is the * horizontal keep radius from the centerline; `mode: 'outside'` keeps * everything a closed circuit encloses and trims only beyond the loop. * `pointSpace` is the level size the points were authored at, so * changing the world size in the same dialog pass still culls the * right ground. Missing = no cull. */ pathCull?: { points: Array<{ x: number; y?: number; z: number }>; closed: boolean; distanceM: number; mode: 'both' | 'outside'; pointSpace?: { levelSizeX: number; levelSizeZ: number; levelSizeY?: number; chunkSize: number }; }; }; }): Promise<void>
function handleCreateAssetFromGlbUrl(ctx: GameTemplateContext, data: { requestId: string; name: string; glbUrl: string; assetId?: string; // pre-generated id from the AI manifest — honored as the asset id options: { minVoxelSize: number; maxVoxelSize: number; targetHeight?: number; // Allocated box (m) from the World-Forger; when set and targetHeight is unset, the // voxelizer derives a height that fits the GLB within it (ExtractGlbForVoxelization). fitBox?: { x: number; z: number; height: number }; fillInterior: boolean; preFragment?: { targetFragments?: number; individualVoxels?: number }; algorithm?: 'surface' | 'octree'; // True only for World-Forger placeholder bakes: the asset entry records it so the // editor can offer one-click HQ regeneration; any regeneration (which comes through // this same handler without the flag) clears it. placeholder?: boolean; /** * Bake-time per-color emissive: keys are `#RRGGBB` authored colors, values * 1..255 strength. Matched EXACTLY against the baked palette's RGB444 atlas * cells (see `emissiveByColor.ts`) and set on the `.vxl` v6 emissive block — * rune inlays, crystal veins, lava seams baked with zero manual editing. * Unmatched keys are reported back as `emissiveUnmatched` (a bake note, not * an error). Missing/empty = no emissive from this option (vehicle * auto-emissive, if any, still applies). */ emissiveByColor?: Record<string, number>; /** * Bake-time per-color MATERIAL CLASSES: keys are `#RRGGBB` authored colors, * values the closed `VoxelMaterialClass` vocabulary. Each key claims the * baked colour group it lands in (exact cell, else one RGB444 step) and the * classes are written as the asset's material slots through the same plan * the classify path uses (`VxlMaterialByColor.ts`). Unmatched keys come * back as `materialUnmatched`, the slots written as `materialSlots`. */ materialByColor?: Record<string, string>; }; }): Promise<void>
function handleRegisterGlbAsset(ctx: GameTemplateContext, data: { requestId: string; asset: { id: string; name: string; url: string; type: string; size: number; screenshotUrl?: string; source?: string; thrixelSubmissionId?: string; }; }): Promise<void>

## engine/template/VxlEmissiveTransforms.ts
function collectVxlPalette(dec: DecodedVxlV3): { colors: number[]; emissive: number[] }
function applyEmissiveToVxlBytes(vxlBytes: Uint8Array, emissive: number[]): Promise<Uint8Array>

## engine/template/VxlMasterAssetHandler.ts
interface CreateAssetFromVxlMasterData
CreateAssetFromVxlMasterData.requestId: string
CreateAssetFromVxlMasterData.name: string
CreateAssetFromVxlMasterData.masterUrl: string
CreateAssetFromVxlMasterData.assetId?: string
CreateAssetFromVxlMasterData.options: { /** Voxel edge length for the working asset. */ minVoxelSize: number; maxVoxelSize: number; /** * Object height in world units. When absent, derived from `fitBox` so the * model fits its allocated slot on every axis; 2 m if neither is given. */ targetHeight?: number; /** Allocated box from the World-Forger, recorded so a regen fits the same slot. */ fitBox?: { x: number; z: number; height: number }; /** What this object should look like — the prompt for a later regeneration. */ description?: string; /** * Whether to register the asset in the loaded game. * * True for the agent path, which owns the whole write. False for the * Creator's Re-voxelize, where the Creator persists the returned record * itself — registering here as well gives one asset two writers, and the * duplicate world.json churn reload-thrashes the game iframe. The GLB * flows already split this way: the agent's handler registers, and * Re-voxelize returns bytes for the Creator to store. */ registerAsset?: boolean; }
CreateAssetFromVxlMasterData.smartObject?: SmartObjectSpec
CreateAssetFromVxlMasterData.sourceHfvxUrl?: string
function handleCreateAssetFromVxlMaster(ctx: GameTemplateContext, data: CreateAssetFromVxlMasterData): Promise<void>
function handleRevoxelizeFromVxlMaster(ctx: GameTemplateContext, data: { requestId: string; masterUrl: string; options: { minVoxelSize: number; maxVoxelSize: number; targetHeight?: number; additionalLods?: unknown[] }; /** The asset's grid-space spec (`smartObject.source`), so the re-bake keeps its parts. */ smartObject?: SmartObjectSpec; }): Promise<void>

## engine/template/VxlMaterialAssetHandler.ts
interface ReadVxlMaterialSignatureData
ReadVxlMaterialSignatureData.requestId: string
ReadVxlMaterialSignatureData.vxlUrl: string
function handleReadVxlMaterialSignature(ctx: GameTemplateContext, data: ReadVxlMaterialSignatureData): Promise<void>
interface ApplyVxlMaterialsData
ApplyVxlMaterialsData.requestId: string
ApplyVxlMaterialsData.assetId: string
ApplyVxlMaterialsData.assetName: string
ApplyVxlMaterialsData.vxlUrl: string
ApplyVxlMaterialsData.assignment?: MaterialAssignment
ApplyVxlMaterialsData.clear?: boolean
ApplyVxlMaterialsData.promptText?: string
ApplyVxlMaterialsData.upload: boolean
function handleApplyVxlMaterials(ctx: GameTemplateContext, data: ApplyVxlMaterialsData): Promise<void>

## engine/template/VxlMaterialByColor.ts
interface MaterialByColorPlan
MaterialByColorPlan.verdicts: MaterialVerdict[]
MaterialByColorPlan.unmatched: string[]
interface MaterialByColorApplied
MaterialByColorApplied.bytes: Uint8Array
MaterialByColorApplied.slots: string[]
MaterialByColorApplied.unmatched: string[]
MaterialByColorApplied.unchanged: boolean
function planMaterialByColor(sig: MaterialSignature, materialByColor: Record<string, string>, useAtlas: boolean): MaterialByColorPlan
function applyMaterialByColorToVxl(vxlBytes: Uint8Array, materialByColor: Record<string, string>, options: { promptText?: string } = {}): Promise<MaterialByColorApplied>

## engine/template/VxlMaterialSignature.ts
const MATERIAL_SIGNATURE_VERSION = 1
const DEFAULT_MAX_GROUPS = 16
const MAX_MATERIAL_GROUPS = 24
const DEFAULT_MIN_SHARE = 0.002
type MaterialGroupShape = 'thin-long' | 'flat-shell' | 'blob' | 'scattered'
interface MaterialGroupStats
MaterialGroupStats.id: string
MaterialGroupStats.hex: string
MaterialGroupStats.cells: number[]
MaterialGroupStats.share: number
MaterialGroupStats.y: [number, number, number]
MaterialGroupStats.extent: [number, number, number]
MaterialGroupStats.radial: number
MaterialGroupStats.shape: MaterialGroupShape
MaterialGroupStats.blobs: number
interface MaterialSignature
MaterialSignature.version: number
MaterialSignature.hash: string
MaterialSignature.voxelCount: number
MaterialSignature.paletteSize: number
MaterialSignature.bboxVoxels: [number, number, number]
MaterialSignature.groups: MaterialGroupStats[]
MaterialSignature.existingSlots: string[]
interface MaterialSignatureOptions
MaterialSignatureOptions.maxGroups?: number
MaterialSignatureOptions.minShare?: number
function buildMaterialSignature(dec: DecodedVxlV3, options: MaterialSignatureOptions = {}): MaterialSignature
function formatMaterialSignatureTable(sig: MaterialSignature): string
function nearestGroupId(sig: MaterialSignature, cell: number, useAtlas: boolean): string | null

## engine/template/VxlMaterialSlotTransforms.ts
const MAX_MATERIAL_SLOTS_PER_ASSET = 4
const MIN_VERDICT_CONFIDENCE = 0.45
interface MaterialVerdict — One group's verdict. `class` is a name from the closed vocabulary, never a number.
MaterialVerdict.id: string
MaterialVerdict.class: string
MaterialVerdict.confidence: number
type MaterialClassifier = 'agent' | 'ai' | 'manual' | 'heuristic'
interface MaterialAssignment
MaterialAssignment.signatureVersion: number
MaterialAssignment.signatureHash: string
MaterialAssignment.verdicts: MaterialVerdict[]
MaterialAssignment.classifier: MaterialClassifier
MaterialAssignment.model?: string
interface DroppedClass — Why a class did not become a slot — reported as a note, never as an error.
DroppedClass.class: string
DroppedClass.reason: 'low-confidence' | 'too-small' | 'implausible-bulk' | 'over-budget' | 'unknown-class'
DroppedClass.share: number
interface MaterialSlotPlan
MaterialSlotPlan.slots: VoxelSlot[]
MaterialSlotPlan.slotOfCell: Map<number, number>
MaterialSlotPlan.dropped: DroppedClass[]
MaterialSlotPlan.baseShare: number
interface PlanOptions
PlanOptions.maxSlots?: number
PlanOptions.promptText?: string
function planMaterialSlots(sig: MaterialSignature, assignment: MaterialAssignment, options: PlanOptions = {}): MaterialSlotPlan
interface AppliedMaterials — What an apply produced, alongside the bytes.
AppliedMaterials.bytes: Uint8Array
AppliedMaterials.plan: MaterialSlotPlan
AppliedMaterials.signature: MaterialSignature
AppliedMaterials.unchanged: boolean
function applyMaterialSlotsToVxlBytes(vxlBytes: Uint8Array, assignment: MaterialAssignment, options: PlanOptions = {}): Promise<AppliedMaterials>
function clearMaterialClassesFromVxlBytes(vxlBytes: Uint8Array): Promise<Uint8Array>
