import * as THREE from 'three';
import { t } from 'engine/i18n/index.js';
import { GaussianSplatEditor } from '../debug/GaussianSplatEditor.js';
import { HeightmapEditor } from '../debug/HeightmapEditor.js';
import { ExampleFlyingMovement } from '../debug/ExampleFlyingMovement.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import { ObjectInspector } from './ObjectInspector.js';
import { MarkerSystem } from '../debug/MarkerSystem.js';
import { PlacedObjectSystem } from 'engine/PlacedObjectSystem.js';
import { SceneEditor } from './SceneEditor.js';
import type { EngineLike, CameraControllerLike } from 'types/game.js';
import type { Asset } from 'types/game.js';
import ASSET_MAP from 'bundle/BundledAssetData.js';
import type { GenreGameInterface } from 'engine/GenreRegistry.js';
import type { RendererBackend } from 'engine/RendererType.js';
import { SceneHierarchyPanel } from './SceneHierarchyPanel.js';
import { SceneInfoPanel } from '../debug/SceneInfoPanel.js';
import { DebugGameInfoPanel } from '../debug/DebugGameInfoPanel.js';
import { frameSpanRecorder } from '../debug/FrameSpanRecorder.js';
import { DebugCameraManager } from '../debug/DebugCameraManager.js';
import { ObjectSelectionManager, SelectableObjectConfig, type SelectionHit } from '../debug/ObjectSelectionManager.js';
import { DebugSpawnManager } from '../debug/DebugSpawnManager.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { VoxelEditor } from './VoxelEditor.js';
import { VoxelObjectSaveService } from './VoxelObjectSaveService.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { calculateWorldChecksum, calculateTerrainChecksum } from './VoxelChecksum.js';
import { DebugManager } from 'engine/DebugManager.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';
import { getEditorHost, setEditorHostAssetFallback } from 'editor/EditorHost.js';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import { getGlobalLodScheduler } from 'engine/character/CharacterLodScheduler.js';
import { getActiveEnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import { InGameNotification } from 'engine/InGameNotification.js';
import { TransformControlsManager } from './TransformControlsManager.js';
import { PlacementHelper } from 'engine/PlacementHelper.js';
import { SpawnPointMarker } from './SpawnPointMarker.js';
import { setEditorModeForPointerLock, wireNavmeshPathProviderToDebugPanel } from './EditorWiring.js';
import { wirePvsProvidersToDebugPanel, type PvsEditor } from './PvsDebugWiring.js';
import { EditorContextMenu } from './EditorContextMenu.js';
import { VoxelEditSession } from './voxel-edit/VoxelEditSession.js';
import type { IEditableVoxelVolume } from './voxel-edit/VoxelEditTypes.js';
import { TerrainVolume } from './voxel-edit/TerrainVolume.js';
import { VoxelObjectVolume } from './voxel-edit/VoxelObjectVolume.js';
import { VoxelEditToolbar } from './voxel-edit/VoxelEditToolbar.js';
import { createAssetEditProxy, createEnvInstanceEditProxy, type EnvInstanceEditProxy } from './voxel-edit/EnvInstanceEditProxy.js';
import { getActiveLevelIdOrNull } from 'engine/levels/levelManagerRegistry.js';

interface ExtendedGenreModule extends GenreGameInterface {
    cameraController?: CameraControllerLike;
}

// Extended engine interface with methods used by EditorManager
interface EditorManagerEngine extends Omit<EngineLike, 'scene' | 'camera' | 'renderer' | 'genreModule'> {
    getCurrentPlayer(): PlayerControllerProxy | null;
    // Non-null versions for use after initialization
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer & { domElement: HTMLCanvasElement };
    genreModule: ExtendedGenreModule | null;
    // Physics world for raycasting (used by snap-to-ground)
    physicsWorld: import('engine/physics/PhysicsWorld.js').PhysicsWorld | null;
    // Outline pass for selection highlighting
    hasOutlinePass?(): boolean;
    setupSelectionOutline?(): void;
    setOutlineSelectedObjects?(objects: THREE.Object3D[]): void;
    // Environment object system for managing environment objects
    getEnvironmentObjectSystem?(): { removeVoxelObjectFromStorage(obj: THREE.Object3D): boolean } | null;
    // Get world.json data
    getGameData(): any;
    // Debug-only render-rate toggle (forces 60 FPS in editor/menu when ON)
    getDebugForceActiveRate(): boolean;
    setDebugForceActiveRate(v: boolean): void;
    // Debug-only NPC ablation (freezes and hides every NPC/animal when ON)
    getDebugDisableNpcs(): boolean;
    setDebugDisableNpcs(v: boolean): void;
    // Real GPU backend in use (WebGPURenderer may fall back to the WebGL2 backend)
    getActiveBackend(): RendererBackend;
}

// Player controller proxy returned by getCurrentPlayer
// Using interface to allow different implementations
interface PlayerControllerProxy {
    player: THREE.Object3D;
    getWorldGenerator?(): WorldGeneratorProxy | null;
    generateBlockCharacter?(): void;
    setMovementSystem?(movement: IPlayerMovement): void;
    getMovementSystem?(): IPlayerMovement | null;
    respawn?(): void;
    setControlsEnabled?(enabled: boolean): void;
    setEnabled?(enabled: boolean): void;
}

// World generator proxy interface
interface WorldGeneratorProxy {
    getHeightAt?(x: number, z: number): number;
    unpackInstancedMeshes?(): void;
    packInstancedMeshes?(): void;
    getEnvironmentObjectSystem?(): any;
}

/**
 * What a voxel or terrain save reports back.
 *
 * `ok` is the field that matters: a save whose upload failed must not commit the session, or the
 * creator's sculpt is gone with only a console warning to show for it.
 */
export interface VoxelSaveResult {
    ok: boolean;
    error?: string;
}

/** A terrain save additionally hands back the URL the host writes into `world.json`. */
export interface TerrainSaveResult extends VoxelSaveResult {
    voxelUrl?: string;
}

/**
 * What the toolbar says when the bytes never left the browser.
 *
 * Deliberately names the cause a creator can act on. In the pro lane the usual reason is being
 * logged out — `bitmagic dev` runs fine offline, and only the upload needs an account.
 */
export const UPLOAD_FAILED_NOTICE =
    'Could not upload the edit — it is still here, unsaved. Check you are signed in, then save again.';

/**
 * EditorManager handles editor mode functionality
 * - Camera switching between game and editor cameras
 * - Debug UI panels (scene hierarchy, object inspector)
 * - Voxel editing mode
 * 
 * Debug functionality (F4-F7, etc.) is handled by engine/DebugManager.ts
 */
export class EditorManager {
    // Core references
    private engine: EditorManagerEngine;
    public isEditorMode: boolean;
    
    // Debug manager for debug-only functionality
    private debugManager: DebugManager;

    // Managers (Phase 2 extractions)
    private cameraManager: DebugCameraManager;
    private selectionManager: ObjectSelectionManager;
    private spawnManager: DebugSpawnManager;
    private transformControlsManager: TransformControlsManager | null = null;

    // Terrain chunk culling is frustum/distance-based and follows the live camera.
    // In the editor the free camera roams independently of where the game aimed,
    // so culling would hide ground the user is looking at. We disable it on entry
    // and restore the game's prior setting on exit. Null = not currently overridden.
    private terrainCullingWasEnabled: boolean | null = null;

    // Debug UI elements
    private debugContainer: HTMLDivElement | null;
    private sceneHierarchyPanel: SceneHierarchyPanel | null;
    public objectInspector: ObjectInspector | null;
    public selectedObject: THREE.Object3D | null;

    // Scene info dialog
    private sceneInfoPanel: SceneInfoPanel | null;
    public sceneEditingLocked: boolean;

    // Standalone debug info panel (independent of full debug mode)
    private debugGameInfoPanel: DebugGameInfoPanel | null;

    // Gaussian splat editor for Gaussian splat colliders
    private gaussianSplatEditor: GaussianSplatEditor | null;
    private gaussianSplatEditorEnabled: boolean;

    // Heightmap editor
    public heightmapEditor: HeightmapEditor | null;
    private heightmapEditorEnabled: boolean;

    // Flying movement toggle
    private flyingMovement: IPlayerMovement | null;
    private normalMovement: IPlayerMovement | null;
    private isFlyingEnabled: boolean;

    // Marker system for Scene editor
    public markerSystem: MarkerSystem;

    // Placed object system for asset library objects
    private placedObjectSystem: PlacedObjectSystem;

    // Scene editor for adding objects from asset library
    private sceneEditor: SceneEditor;

    // Placement helper for snap-to-ground (scene-based raycasting with foliage filtering)
    private placementHelper: PlacementHelper;

    // Spawn point markers (visible in editor, hidden in play mode)
    private spawnPointMarkers: Map<string, SpawnPointMarker> = new Map();
    private spawnPointsDirty: boolean = false;
    private hasMultiplayerSpawns: boolean = false;

    // Pause/play functionality
    private isPaused: boolean;

    // Right-click context menu — extracted to EditorContextMenu.
    private contextMenu: EditorContextMenu;
    private raycaster: THREE.Raycaster;

    // Scene change tracking - tracks specific object IDs that were modified or deleted
    private modifiedObjectIds: Set<string>;
    private deletedObjectIds: Set<string>;

    // Original environment object snapshots — captured at scene editing start for per-object undo
    private originalObjectSnapshots: Map<string, any> = new Map();

    // Voxel editing — persistence service (S3 upload + world.json asset update)
    private voxelEditor: VoxelEditor | null = null;

    // World/terrain modification baselines (captured at load, read by the
    // creator's modified-state queries via CreatorMessageHandler)
    private initialWorldChecksum: number = 0;
    private initialTerrainChecksum: number = 0;

    // Unified voxel edit session (Editor tab): one session drives terrain and
    // object voxel editing through IEditableVoxelVolume — see
    // docs/voxel-editor-design.md §4.1.
    private voxelEditSession: VoxelEditSession | null = null;
    private voxelEditToolbar: VoxelEditToolbar;
    // Session-scoped VoxelObject overlaid on a clicked environment instance
    // (instances render as plain meshes; the proxy carries the editable voxels).
    private envInstanceEditProxy: EnvInstanceEditProxy | null = null;
    /** An object voxel session borrowed the camera from the debug controller. */
    private debugCameraSuspended = false;

    constructor(engine: EditorManagerEngine) {
        this.engine = engine;
        this.isEditorMode = false;

        // Initialize debug manager for debug-only functionality
        this.debugManager = new DebugManager(engine);
        this.debugManager.setCallbacks({
            onSpawnTestObjects: () => this.spawnManager.spawnAllTestObjects(),
            onTestPlacement: () => this.testPlacement(),
            onToggleFlyingMovement: () => this.toggleFlyingMovement(),
            onToggleDebugInfo: () => this.toggleDebugGameInfo(),
            onToggleNpcs: () => this.toggleNpcsDisabled(),
            onTakeScreenshot: () => this.takeScreenshot()
        });

        // Initialize managers
        this.cameraManager = new DebugCameraManager(
            engine,
            () => this.engine.getPlayerController()
        );
        this.selectionManager = new ObjectSelectionManager(
            engine,
            (object, focusCamera, hit) => this.selectObject(object, focusCamera, hit),
            () => this.closeObjectInspector()
        );
        this.spawnManager = new DebugSpawnManager(engine);
        
        // Production editors - VoxelEditor is lazily initialized when needed
        this.voxelEditor = null;

        // Debug UI elements
        this.debugContainer = null;
        this.sceneHierarchyPanel = null;
        this.objectInspector = null;
        this.selectedObject = null;

        // Scene info dialog
        this.sceneInfoPanel = null;
        this.sceneEditingLocked = true; // Locked by default until world.json has flag set to false

        // Standalone debug info panel (independent of full debug mode)
        this.debugGameInfoPanel = null;

        // Gaussian splat editor for Gaussian splat colliders
        this.gaussianSplatEditor = null;
        this.gaussianSplatEditorEnabled = false;

        // Heightmap editor
        this.heightmapEditor = null;
        this.heightmapEditorEnabled = false;

        // Flying movement toggle
        this.flyingMovement = null;
        this.normalMovement = null;
        this.isFlyingEnabled = false;

        // Marker system for Scene editor
        this.markerSystem = new MarkerSystem(engine.scene);

        // Placed object system for asset library objects
        this.placedObjectSystem = new PlacedObjectSystem(engine.scene, engine);

        // Scene editor for adding objects from asset library
        this.sceneEditor = new SceneEditor(engine, this.placedObjectSystem);

        // Where the editor reads assets from when there is NO host — a published or standalone
        // build, where EditorManager is still constructed but nothing answers a postMessage.
        setEditorHostAssetFallback(() => engine.getGameData?.()?.assets ?? []);

        // Build the host NOW rather than at first use, so its hello goes out at engine construction
        // and the answer is long since in by the time anything reads a capability. Lazily, the very
        // first read is the one that triggers the handshake and therefore the one that still sees
        // the defaults — which silently dropped the first journalled event of every session.
        getEditorHost();

        // Placement helper for snap-to-ground (scene-based raycasting with foliage filtering)
        this.placementHelper = new PlacementHelper(engine.scene);

        // Spawn point marker — initialized later via initSpawnPointMarker() after game data is loaded

        // Pause/play functionality
        this.isPaused = false;

        // Right-click context menu owns its own DOM/state — see EditorContextMenu.
        this.raycaster = new THREE.Raycaster();
        // Only raycast against layer 0 (main objects) - exclude layer 3 (sub-objects/colliders)
        this.raycaster.layers.set(0);
        this.raycaster.layers.disable(3);

        this.contextMenu = new EditorContextMenu({
            engine: this.engine,
            raycaster: this.raycaster,
            markerSystem: this.markerSystem,
            sceneEditor: this.sceneEditor,
            spawnPointMarkers: this.spawnPointMarkers,
            isEditorMode: () => this.isEditorMode,
            // Both gates map to the unified voxel edit session now — it owns
            // its own context menu while active.
            isInObjectEditMode: () => this.isVoxelSessionActive(),
            isTerrainEditEnabled: () => this.isVoxelSessionActive(),
            isSceneEditingLocked: () => this.sceneEditingLocked,
            selectObject: (object, focusCamera) => this.selectObject(object, focusCamera),
            refreshSceneHierarchy: () => this.refreshSceneHierarchy(),
            markSpawnPointsDirty: () => { this.spawnPointsDirty = true; },
        });

        // Toolbar shown while a voxel edit session is active. Buttons drive
        // the session; the session's callbacks (wired lazily in
        // getOrCreateVoxelSession) drive the toolbar's state back.
        this.voxelEditToolbar = new VoxelEditToolbar({
            onDeleteSelected: () => { this.voxelEditSession?.deleteSelected(); },
            onDuplicateSelected: () => { this.voxelEditSession?.duplicateSelected(); },
            onFloodSelect: () => { this.voxelEditSession?.selectConnectedSameMaterial(); },
            onUndo: () => { this.voxelEditSession?.undo(); },
            onMaterialPicked: (material) => {
                const session = this.voxelEditSession;
                if (!session) return;
                if (session.getSelected().length > 0) session.changeSelectedMaterial(material);
                else session.setLastMaterial(material);
            },
            onSelectSimilar: (fuzziness) => this.voxelEditSession?.selectSimilar(fuzziness) ?? -1,
            onSlotPicked: (slot) => { this.voxelEditSession?.setSelectedSlot(slot); },
            onSlotEmissiveChanged: (slot, emissive) => {
                const volume = this.voxelEditSession?.getVolume();
                if (!volume?.setSlotEmissive(slot, emissive)) return;
                // Retuning a material is a save-worthy change even though no
                // voxel moved, so the session must notice.
                this.voxelEditToolbar.setHasChanges(this.voxelEditSession?.hasChanges() ?? false);
            },
            onSlotMaterialClassChanged: (slot, materialClass) => {
                const volume = this.voxelEditSession?.getVolume();
                if (!volume?.setSlotMaterialClass(slot, materialClass)) return;
                // Same reasoning as the glow above: changing what a material is
                // MADE OF moves no voxel, so without this the session reports no
                // changes and Save & Exit throws the edit away.
                this.voxelEditToolbar.setHasChanges(this.voxelEditSession?.hasChanges() ?? false);
            },
            onCreateMaterial: (name, emissive, materialClass) => {
                const session = this.voxelEditSession;
                const volume = session?.getVolume();
                if (!session || !volume) return null;
                const slot = volume.createMaterialSlot(name, emissive, materialClass);
                // Put the selection straight into the new material — creating
                // one and not applying it is never what the user meant.
                if (slot !== null) session.setSelectedSlot(slot);
                return slot;
            },
            onSaveAndExit: () => { void this.endVoxelSession(true); },
            onCancel: () => { void this.endVoxelSession(false); },
        });

        // Scene change tracking
        this.modifiedObjectIds = new Set();
        this.deletedObjectIds = new Set();

        // Bind methods that need 'this' context
        this.markObjectModified = this.markObjectModified.bind(this);

        // Event handlers
        this.onKeyDown = this.onKeyDown.bind(this);

        this.setupEventListeners();
        this.createDebugUI();
        this.createStandaloneDebugInfo();
    }
    
    /**
     * Mark a specific object as modified (for precise change tracking)
     */
    markObjectModified(objectId: string) {
        if (objectId) {
            this.modifiedObjectIds.add(objectId);
            console.log(`[EditorManager] Marked object modified: ${objectId} (total: ${this.modifiedObjectIds.size})`);
        }
    }

    /**
     * Mark that a full save is needed (used when we can't track individual objects)
     * This adds a special marker that tells SaveController to save everything
     */
    markFullSaveNeeded() {
        this.modifiedObjectIds.add('__FULL_SAVE__');
        console.log('[EditorManager] Marked full save needed');
    }

    /**
     * Shared transform-change handler for gizmo drag/snap and inspector input.
     * Marks the object as user-positioned (forcePosition) and adds its id to the
     * modified set; falls back to a full save when no specific id can be resolved.
     */
    private commitTransformChange(object: THREE.Object3D | null): void {
        if (!object) { this.markFullSaveNeeded(); return; }
        if (object.userData?.isSpawnPointMarker) {
            const spawnId = object.userData.spawnPointId as string;
            const marker = this.spawnPointMarkers.get(spawnId);
            if (marker) {
                this.snapSpawnMarkerToGround(marker);
                this.syncPlayerSpawnToLegacy(marker);
                this.spawnPointsDirty = true;
            }
            this.markObjectModified(`spawn_${spawnId}`);
            return;
        }
        const objectId = this.resolveObjectId(object);
        if (objectId) {
            const _rd = getObjectIdService().getDataById(objectId);
            if (_rd) _rd.forcePosition = true;
            this.markObjectModified(objectId);
        } else {
            console.warn('[EditorManager] Object modified but has no ID, marking full save:', object.name);
            this.markFullSaveNeeded();
        }
    }

    /**
     * Toggle terrain flattening for a specific environment object instance.
     * Updates the object's flattenTerrain field in gameData and applies/reverts terrain changes.
     */
    handleToggleFlattenTerrain(objectId: string, enable: boolean): void {
        const gameData = this.engine.getGameData?.();
        if (!gameData) return;

        const objDef = (gameData.environmentObjects || []).find((o: { id: string }) => o.id === objectId);
        if (!objDef) return;

        // Mark only this object as modified (not full save)
        this.markObjectModified(objectId);

        // Update the instance data in gameData
        objDef.flattenTerrain = enable;

        // Also update ObjectIdService registration data — this is what
        // serializeEnvironmentObjects() reads during save
        const idService = getObjectIdService();
        const regData = idService.getDataById(objectId);
        if (regData) {
            regData.flattenTerrain = enable;
        }

        const voxelTerrainSystem = this.getVoxelTerrainSystem();
        if (!voxelTerrainSystem) return;

        if (enable) {
            // Find asset definition for bounding box info
            const assetDef = objDef.assetId
                ? (gameData.assets || []).find((a: { id: string }) => a.id === objDef.assetId)
                : null;
            if (assetDef?.boundingBox) {
                const pos = objDef.position || { x: 0, y: 0, z: 0 };
                const bbox = assetDef.boundingBox;
                const scaleW = objDef.scale?.x ?? objDef.scale?.width ?? 1;
                const scaleD = objDef.scale?.z ?? objDef.scale?.depth ?? 1;
                let width = (bbox.maxX - bbox.minX) * scaleW;
                let depth = (bbox.maxZ - bbox.minZ) * scaleD;
                const flattenMargin = assetDef.flattenMargin ?? 2;
                const terrainHeight = voxelTerrainSystem.getTerrainOnlyHeight(pos.x, pos.z);

                // Apply rotation to width/depth if rotated 90/270 degrees
                const rotY = objDef.rotation?.y ? Math.abs(objDef.rotation.y) % (Math.PI * 2) : 0;
                if (Math.abs(rotY - Math.PI / 2) < 0.1 || Math.abs(rotY - Math.PI * 3 / 2) < 0.1) {
                    const temp = width;
                    width = depth;
                    depth = temp;
                }

                voxelTerrainSystem.flattenArea(pos.x, pos.z, width, depth, terrainHeight, undefined, true, flattenMargin, objectId);
            }
        } else {
            // Unflatten: restore original terrain from snapshot
            voxelTerrainSystem.unflattenArea(objectId, true);
        }
    }

    /**
     * Check if a full save is needed (vs just saving specific objects)
     */
    isFullSaveNeeded(): boolean {
        return this.modifiedObjectIds.has('__FULL_SAVE__');
    }

    /**
     * Get the list of modified object IDs
     */
    getModifiedObjectIds(): string[] {
        return Array.from(this.modifiedObjectIds);
    }

    /**
     * Get the list of deleted object IDs
     */
    getDeletedObjectIds(): string[] {
        return Array.from(this.deletedObjectIds);
    }

    /**
     * Clear the scene changes (after successful save)
     */
    clearSceneChanges() {
        this.modifiedObjectIds.clear();
        this.deletedObjectIds.clear();
        this.spawnPointsDirty = false;
        // Also clear pending world config
        this.objectInspector?.clearPendingWorldConfig();
    }

    /**
     * Reset object snapshots for a new edit session (Scene tab activated).
     * Each object's snapshot is captured on first modification via captureObjectSnapshot().
     */
    captureObjectSnapshots(): void {
        this.originalObjectSnapshots.clear();
    }

    /**
     * Capture a single object's snapshot on first modification.
     * Stores both the gameData definition and the live Three.js transform.
     */
    private captureObjectSnapshot(objectId: string, liveObject?: THREE.Object3D): void {
        // Try to find the gameData entry (environment objects have one, spawn markers don't)
        const gameData = this.engine.getGameData?.();
        const envObjects = gameData?.environmentObjects;
        const obj = envObjects?.find((o: any) => o.id === objectId);
        const snapshot: any = obj ? JSON.parse(JSON.stringify(obj)) : { id: objectId };

        // Find the live Three.js object if not provided
        if (!liveObject) {
            const idService = getObjectIdService();
            liveObject = idService.getObjectById(objectId) ?? undefined;
        }

        // Capture the live Three.js transform (the actual rendered position,
        // which may differ from serialized data due to terrain snapping etc.)
        if (liveObject) {
            snapshot._liveTransform = {
                position: { x: liveObject.position.x, y: liveObject.position.y, z: liveObject.position.z },
                rotation: { x: liveObject.rotation.x, y: liveObject.rotation.y, z: liveObject.rotation.z },
                scale: { x: liveObject.scale.x, y: liveObject.scale.y, z: liveObject.scale.z }
            };
        }

        this.originalObjectSnapshots.set(objectId, snapshot);
    }

    /**
     * Resolve the object ID for a Three.js object by checking userData, ObjectIdService,
     * and traversing the parent hierarchy.
     */
    private resolveObjectId(object: THREE.Object3D): string | null {
        // Spawn point markers use a different ID field
        if (object.userData?.isSpawnPointMarker && object.userData?.spawnPointId) {
            return `spawn_${object.userData.spawnPointId}`;
        }

        let objectId = object.userData?.id || object.userData?.objectId;

        if (!objectId) {
            const idService = getObjectIdService();
            const registration = idService.findByObject(object);
            if (registration) {
                objectId = registration.id;
            }
        }

        if (!objectId) {
            let parent = object.parent;
            while (parent && !objectId) {
                objectId = parent.userData?.id || parent.userData?.objectId;
                if (!objectId) {
                    const idService = getObjectIdService();
                    const reg = idService.findByObject(parent);
                    if (reg) objectId = reg.id;
                }
                parent = parent.parent;
            }
        }

        return objectId || null;
    }

    /**
     * Check if a specific object can be undone (has original snapshot AND is modified)
     */
    canUndoObject(objectId: string): boolean {
        return this.originalObjectSnapshots.has(objectId) && this.modifiedObjectIds.has(objectId);
    }

    /**
     * Undo all changes to a specific object, restoring it to its state at session start.
     * Returns the Three.js object if visual update is needed, null otherwise.
     */
    undoObjectChanges(objectId: string, liveObjectHint?: THREE.Object3D): THREE.Object3D | null {
        const original = this.originalObjectSnapshots.get(objectId);
        if (!original) return null;

        // Restore the object definition in gameData (if it has one — spawn markers don't)
        const gameData = this.engine.getGameData?.();
        const envObjects = gameData?.environmentObjects;
        if (envObjects) {
            const index = envObjects.findIndex((obj: any) => obj.id === objectId);
            if (index !== -1) {
                const restored = JSON.parse(JSON.stringify(original));
                delete restored._liveTransform;
                envObjects[index] = restored;
            }
        }

        // Remove from modified set
        this.modifiedObjectIds.delete(objectId);

        // Handle spawn marker undo — also clear spawnPointsDirty if applicable
        if (objectId.startsWith('spawn_')) {
            const spawnId = objectId.slice(6); // Remove "spawn_" prefix
            const marker = this.spawnPointMarkers.get(spawnId);
            if (marker) {
                // Check if any OTHER spawn markers are still dirty
                const hasOtherDirtySpawns = Array.from(this.modifiedObjectIds).some(id => id.startsWith('spawn_'));
                if (!hasOtherDirtySpawns) {
                    this.spawnPointsDirty = false;
                }
            }
        }

        // Find the live Three.js object and apply the captured live transform
        const idService = getObjectIdService();
        const liveObject = liveObjectHint || idService.getObjectById(objectId);
        const transform = original._liveTransform;
        if (liveObject && transform) {
            liveObject.position.set(transform.position.x, transform.position.y, transform.position.z);
            liveObject.rotation.set(transform.rotation.x, transform.rotation.y, transform.rotation.z);
            liveObject.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);

            // Update physics for VoxelObjects
            if (liveObject instanceof VoxelObject) {
                liveObject.updatePhysicsTransform();
            }

            return liveObject;
        }

        return null;
    }

    /**
     * Check if the scene has unsaved changes
     */
    hasSceneChanges() {
        return this.modifiedObjectIds.size > 0 || this.deletedObjectIds.size > 0 || this.spawnPointsDirty || (this.objectInspector?.hasPendingWorldConfig() ?? false);
    }

    /**
     * Get pending world config (e.g., character settings from ObjectInspector)
     */
    getPendingWorldConfig(): { settings: Record<string, number>; path: string[]; title: string } | null {
        return this.objectInspector?.getPendingWorldConfig() ?? null;
    }
    
    /**
     * Initialize spawn point markers from worldProfileData.
     * Called by GameEngine after game data is loaded.
     * Supports both new spawnPoints array and legacy playerSpawnPosition fields.
     */
    initSpawnPointMarkers(): void {
        const gameData = this.engine.getGameData();
        const wpd = gameData?.worldProfileData;
        if (!wpd) return;

        // Check if multiplayer spawn point markers exist
        this.hasMultiplayerSpawns = wpd.markers?.some(
            (m: { name: string }) => m.name.startsWith('Multiplayer Spawn Point')
        ) ?? false;

        // Determine spawn points: prefer spawnPoints array, fall back to legacy fields
        let points = wpd.spawnPoints;
        if (!points || points.length === 0) {
            const sp = wpd.playerSpawnPosition;
            points = [{
                id: 'player',
                type: 'player',
                position: { x: sp.x, y: sp.y, z: sp.z },
                rotationY: wpd.playerSpawnRotationY ?? 0
            }];
        }

        for (const sp of points) {
            const marker = new SpawnPointMarker(sp.id, sp.type);
            marker.setPosition(sp.position.x, sp.position.y, sp.position.z);
            marker.setRotationY(sp.rotationY);
            marker.hide();
            this.engine.scene.add(marker.mesh);
            this.spawnPointMarkers.set(sp.id, marker);
        }

        // If multiplayer spawn points exist, permanently hide the player spawn point
        // (multiplayer spawn points replace it and are shown via MarkerSystem instead)
        if (this.hasMultiplayerSpawns) {
            for (const [, marker] of this.spawnPointMarkers) {
                if (marker.type === 'player') {
                    marker.hide();
                    // Remove from scene so it doesn't show in editor mode
                    this.engine.scene.remove(marker.mesh);
                }
            }
        }
    }

    /**
     * Get pending spawn points for batch save.
     * Returns the full spawnPoints array if any marker was modified, null otherwise.
     */
    getPendingSpawnPoints(): import('types/game.js').SpawnPoint[] | null {
        if (!this.spawnPointsDirty || this.spawnPointMarkers.size === 0) return null;
        return Array.from(this.spawnPointMarkers.values()).map(m => m.toSpawnPoint());
    }

    /**
     * Snap a spawn marker's Y to terrain surface — but only when it's safe to.
     *
     * Previously this unconditionally raycast from above and replaced the
     * marker's Y with the topmost hit. For voxelised buildings that's the
     * roof, so any interior spawn placement was immediately destroyed and the
     * marker (and the saved spawn point) drifted onto the roof every time the
     * editor was entered or the gizmo was dragged.
     *
     * Now: skip the snap if (a) anything solid sits directly above the marker
     * within a few metres — meaning we're under a roof / inside a building /
     * inside a cave — or (b) the marker is already at or above the ground hit
     * (the user explicitly placed it in the air). Only when the marker is
     * floating below the surface in open sky do we lift it back to the ground.
     */
    private snapSpawnMarkerToGround(marker: SpawnPointMarker): void {
        const pos = marker.getPosition();

        // Open-sky test: if anything solid is overhead within ~6m, the marker
        // sits inside a structure (building interior, cave). Trust the user-
        // placed Y — auto-snapping would otherwise raycast from above, hit
        // the roof, and drag the spawn onto the rooftop on every editor enter.
        if (this.placementHelper.isAnythingAbove(pos.x, pos.y + 0.05, pos.z, 6, marker.mesh)) return;

        const groundY = this.placementHelper.findGroundHeightAt(pos.x, pos.z, marker.mesh);
        if (groundY === null) return;
        // Only snap UPWARD onto a ground that's above the marker. If the user
        // intentionally raised the marker above ground level (e.g. for a
        // platform spawn), don't drag them back down.
        if (pos.y >= groundY - 0.05) return;
        marker.setPosition(pos.x, groundY, pos.z);
    }

    /**
     * Sync player spawn point back to legacy worldProfileData fields
     * so WorldGenerator and PlayerLoader can read it.
     */
    private syncPlayerSpawnToLegacy(marker: SpawnPointMarker): void {
        if (marker.type !== 'player') return;
        const gameData = this.engine.getGameData();
        const wpd = gameData?.worldProfileData;
        if (!wpd) return;
        const pos = marker.getPosition();
        wpd.playerSpawnPosition.x = pos.x;
        wpd.playerSpawnPosition.y = pos.y;
        wpd.playerSpawnPosition.z = pos.z;
        wpd.playerSpawnRotationY = marker.getRotationY();
    }

    /**
     * Setup global event listeners
     */
    setupEventListeners() {
        document.addEventListener('keydown', this.onKeyDown);
    }
    
    /**
     * Setup debug mode mouse listeners
     */
    setupDebugMouseListeners() {
        this.selectionManager.setupMouseListeners();
        this.contextMenu.attach();
    }

    /**
     * Remove debug mode mouse listeners
     */
    removeDebugMouseListeners() {
        this.selectionManager.removeMouseListeners();
        this.contextMenu.detach();
    }
    
    /**
     * Handle global keyboard events
     */
    onKeyDown(event: KeyboardEvent) {
        // F3 toggle Gaussian splat collider editor
        if (event.code === 'F3') {
            event.preventDefault();
            this.toggleGaussianColliderEditor();
            return;
        }

        // Delegate debug keys to DebugManager
        this.debugManager.onKeyDown(event);
    }

    /**
     * Generate a block character for debugging (skeleton visualization)
     */
    generateBlockCharacter() {
        const currentPlayer = this.engine.getCurrentPlayer();
        if (currentPlayer && typeof currentPlayer.generateBlockCharacter === 'function') {
            console.log('EditorManager: Generating block character via F5...');
            currentPlayer.generateBlockCharacter();
        } else {
            console.warn('EditorManager: No player controller available for block character generation');
        }
    }

    /**
     * Test placement helper by spawning a small box 1 meter forward from player
     */
    testPlacement() {
        this.spawnManager.testPlacement();
    }

    /**
     * Toggle flying movement on/off for the current player
     */
    toggleFlyingMovement() {
        const currentPlayer = this.engine.getCurrentPlayer();
        if (!currentPlayer || typeof currentPlayer.setMovementSystem !== 'function') {
            console.warn('EditorManager: No player controller available for flying movement toggle');
            return;
        }

        this.isFlyingEnabled = !this.isFlyingEnabled;

        if (this.isFlyingEnabled) {
            // Save normal movement system if not already saved
            if (!this.normalMovement) {
                this.normalMovement = currentPlayer.getMovementSystem?.() ?? null;
            }

            // Create flying movement if not exists
            if (!this.flyingMovement) {
                this.flyingMovement = new ExampleFlyingMovement(8, 5);
            }

            // Switch to flying
            currentPlayer.setMovementSystem(this.flyingMovement);
            console.log('🦅 Flying movement ENABLED (F6 to disable)');
            console.log('   Controls: WASD to move, Space to ascend, Ctrl to descend');
        } else {
            // Switch back to normal movement
            if (this.normalMovement) {
                currentPlayer.setMovementSystem(this.normalMovement);
                console.log('🚶 Flying movement DISABLED - back to walking (F6 to enable)');
            }
        }
    }

    /**
     * Respawn the current player to their start position
     */
    respawnPlayer() {
        const currentPlayer = this.engine.getCurrentPlayer();
        if (currentPlayer && typeof currentPlayer.respawn === 'function') {
            console.log('EditorManager: Respawning player via F7...');
            currentPlayer.respawn();
        } else {
            console.warn('EditorManager: No player controller available for respawn');
        }
    }

    /**
     * Take a screenshot of the game and copy it to the clipboard
     */
    async takeScreenshot(): Promise<void> {
        const canvas = this.engine.renderer.domElement;

        try {
            // Convert canvas to blob
            const blob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob(resolve, 'image/png');
            });

            if (!blob) {
                console.error('EditorManager: Failed to create screenshot blob');
                return;
            }

            // Copy to clipboard using the Clipboard API
            await navigator.clipboard.write([
                new ClipboardItem({
                    'image/png': blob
                })
            ]);

            console.log('📸 Screenshot copied to clipboard');
        } catch (error) {
            console.error('EditorManager: Failed to copy screenshot to clipboard:', error);
        }
    }

    /**
     * Lazily obtain the collider editor created in GameEngine. Returns true once
     * `this.gaussianSplatEditor` is populated, false if no renderer/editor exists.
     */
    private ensureGaussianSplatEditor(): boolean {
        if (this.gaussianSplatEditor) return true;

        const gaussianRenderer = this.engine.gaussianSplatRenderer;
        if (!gaussianRenderer) return false;

        console.log('🔧 Getting existing GaussianSplatEditor from renderer');
        this.gaussianSplatEditor = gaussianRenderer.getColliderEditor();
        if (!this.gaussianSplatEditor) {
            console.error('❌ No collider editor found in renderer - this should have been created in GameEngine');
            return false;
        }
        console.log('✅ GaussianSplatEditor reference obtained (colliders already loaded in GameEngine)');
        return true;
    }

    /**
     * Toggle Gaussian splat collider editor visibility
     */
    async toggleGaussianColliderEditor() {
        const gaussianRenderer = this.engine.gaussianSplatRenderer;

        if (!gaussianRenderer) {
            console.log('EditorManager: No Gaussian splat loaded (collider editor only works in splat mode)');
            return;
        }

        console.log('EditorManager: Toggling Gaussian splat editor via F3...');

        // Reuse the existing editor from GameEngine instead of creating a new one
        if (!this.ensureGaussianSplatEditor()) return;

        // Toggle the editor state
        this.gaussianSplatEditorEnabled = !this.gaussianSplatEditorEnabled;

        // Toggle GLB mesh visibility
        const glbMesh = gaussianRenderer.getGlbMesh();
        if (glbMesh) {
            glbMesh.visible = this.gaussianSplatEditorEnabled;
            console.log(`   GLB collider visibility: ${glbMesh.visible ? 'visible' : 'hidden'}`);
        }

        // Toggle Gaussian splat editor
        if (this.gaussianSplatEditor) {
            this.gaussianSplatEditor.setEnabled(this.gaussianSplatEditorEnabled);
            console.log(`   Gaussian splat editor: ${this.gaussianSplatEditorEnabled ? 'enabled' : 'disabled'}`);
        }
    }

    async enableGaussianColliderEditor() {
        if (this.gaussianSplatEditorEnabled) return;

        const gaussianRenderer = this.engine.gaussianSplatRenderer;

        if (!gaussianRenderer) {
            console.log('EditorManager: No Gaussian splat loaded (collider editor only works in splat mode)');
            return;
        }

        console.log('EditorManager: Enabling Gaussian splat editor...');

        // Reuse the existing editor from GameEngine instead of creating a new one
        if (!this.ensureGaussianSplatEditor()) return;

        // Enable the editor state
        this.gaussianSplatEditorEnabled = true;

        // Show GLB mesh visibility
        const glbMesh = gaussianRenderer.getGlbMesh();
        if (glbMesh) {
            glbMesh.visible = true;
            console.log(`   GLB collider visibility: visible`);
        }

        // Enable Gaussian splat editor (no floating UI — the Splats side panel
        // in creator hosts every control now).
        if (this.gaussianSplatEditor) {
            this.gaussianSplatEditor.setEnabled(true);
            console.log(`   Gaussian splat editor: enabled`);
        }
    }

    async disableGaussianColliderEditor() {
        if (!this.gaussianSplatEditorEnabled) return;

        const gaussianRenderer = this.engine.gaussianSplatRenderer;

        if (!gaussianRenderer) {
            return;
        }

        console.log('EditorManager: Disabling Gaussian splat editor...');

        // Disable the editor state
        this.gaussianSplatEditorEnabled = false;

        // Hide GLB mesh visibility
        const glbMesh = gaussianRenderer.getGlbMesh();
        if (glbMesh) {
            glbMesh.visible = false;
            console.log(`   GLB collider visibility: hidden`);
        }

        // Disable Gaussian splat editor
        if (this.gaussianSplatEditor) {
            this.gaussianSplatEditor.setEnabled(false);
            console.log(`   Gaussian splat editor: disabled`);
        }
    }
    
    enableHeightmapEditor() {
        if (this.heightmapEditorEnabled) return;
        
        console.log('EditorManager: Enabling heightmap editor...');
        
        if (!this.heightmapEditor) {
            this.heightmapEditor = new HeightmapEditor(
                this.engine.scene,
                this.engine.getDefaultCamera(),
                this.engine
            );
        }
        
        this.heightmapEditorEnabled = true;
        this.heightmapEditor.setEnabled(true);
        
        console.log('   Heightmap editor: enabled');
    }
    
    disableHeightmapEditor() {
        if (!this.heightmapEditorEnabled) return;
        
        console.log('EditorManager: Disabling heightmap editor...');
        
        this.heightmapEditorEnabled = false;
        
        if (this.heightmapEditor) {
            this.heightmapEditor.setEnabled(false);
        }
        
        console.log('   Heightmap editor: disabled');
    }

    // ============================================================================
    // UNIFIED VOXEL EDIT SESSION (Editor tab — docs/voxel-editor-design.md §4.1)
    // ============================================================================

    isVoxelSessionActive(): boolean {
        return this.voxelEditSession?.isActive() ?? false;
    }

    private getOrCreateVoxelSession(): VoxelEditSession {
        if (!this.voxelEditSession) {
            this.voxelEditSession = new VoxelEditSession(
                {
                    scene: this.engine.scene,
                    renderer: this.engine.renderer,
                    camera: this.engine.camera,
                },
                {
                    onSelectionChanged: (selected) => {
                        const volume = this.voxelEditSession?.getVolume();
                        if (volume) this.voxelEditToolbar.setSelection(selected, volume);
                    },
                    onEdited: () => {
                        this.voxelEditToolbar.setHasChanges(this.voxelEditSession?.hasChanges() ?? false);
                    },
                    onRequestExit: () => { void this.requestVoxelSessionExit(); },
                    setOutlineObjects: (objects) => {
                        if (!this.engine.hasOutlinePass?.()) {
                            this.engine.setupSelectionOutline?.();
                        }
                        this.engine.setOutlineSelectedObjects?.(objects);
                    },
                    isLocked: () => this.sceneEditingLocked,
                    onLockedAction: () => this.showVoxelEditingLockedMessage(),
                },
            );
        }
        return this.voxelEditSession;
    }

    /**
     * Start a whole-terrain voxel edit session. Clicking ANY terrain chunk in
     * the Editor tab lands here — the session operates on the entire
     * VoxelWorld; chunk boundaries are invisible to the user (cross-chunk
     * edits ride VoxelWorld's neighbor-dirty + batch-rebuild machinery).
     */
    startTerrainVoxelSession(hit?: SelectionHit): void {
        if (this.isVoxelSessionActive()) return;
        const voxelWorld = this.getVoxelWorld();
        if (!voxelWorld) return;

        this.closeObjectInspector();
        this.selectionManager.removeMouseListeners();

        const session = this.getOrCreateVoxelSession();
        session.enter(new TerrainVolume({ scene: this.engine.scene, voxelWorld }));
        this.voxelEditToolbar.show(session.getVolume()!, 'Terrain voxels');

        if (hit) {
            session.selectFromHit(hit.point, hit.faceNormalWorld ?? new THREE.Vector3(0, 1, 0), false);
        }
    }

    /**
     * Start a voxel edit session for the voxel object owning `object`
     * (entry point for the inspector's "Edit Voxels" action).
     *
     * Placed environment instances render as plain meshes sharing the asset
     * geometry (no per-instance VoxelObject) — those get a session-scoped
     * proxy loaded from the asset's VXL, overlaid on the clicked instance.
     */
    async startObjectVoxelSessionFor(object: THREE.Object3D): Promise<void> {
        if (this.isVoxelSessionActive()) return;
        if (this.isSceneEditingLocked()) {
            this.showVoxelEditingLockedMessage();
            return;
        }

        let voxelObject = this.findVoxelObjectInHierarchy(object);
        if (!voxelObject && (object.userData as { isEnvironmentInstance?: boolean }).isEnvironmentInstance) {
            const gameData = this.engine.getGameData?.();
            if (!gameData) {
                this.showEditorToast('Game data not available');
                return;
            }
            const result = await createEnvInstanceEditProxy(object, gameData);
            if (!result.proxy) {
                this.showEditorToast(result.error ?? 'Could not load voxels for editing');
                return;
            }
            // Guard: the user may have clicked something else during the load.
            if (this.isVoxelSessionActive()) {
                result.proxy.dispose();
                return;
            }
            this.envInstanceEditProxy = result.proxy;
            voxelObject = result.proxy.voxelObject;
        }
        if (!voxelObject) {
            this.showEditorToast('This object has no editable voxels');
            return;
        }

        this.enterObjectVoxelSession(voxelObject);
    }

    /**
     * Start a voxel edit session for an asset by id, with no placed instance
     * involved — the Assets-tab entry point. The asset is loaded into a
     * session-scoped `VoxelObject` at the origin; the session's isolated view
     * hides the rest of the world and frames it.
     */
    async startAssetVoxelSession(assetId: string): Promise<void> {
        // The creator opens its modal BEFORE this runs and closes it on
        // VOXEL_OBJECT_EDIT_ENDED, so every early return has to report — a
        // silent failure would leave the user staring at a modal with no way
        // out and no reason given.
        const abort = (reason: string): void => {
            this.showEditorToast(reason);
            safePostMessageToCreator({
                type: 'VOXEL_OBJECT_EDIT_ENDED',
                hasChanges: false,
                canceled: true,
                error: reason,
            });
        };

        if (this.isVoxelSessionActive()) {
            abort('A voxel edit session is already open');
            return;
        }
        if (this.isSceneEditingLocked()) {
            // Its own toast already explains the lock — abort() would stack a
            // second one on top.
            this.showVoxelEditingLockedMessage();
            safePostMessageToCreator({
                type: 'VOXEL_OBJECT_EDIT_ENDED',
                hasChanges: false,
                canceled: true,
                error: 'Scene editing is locked for this game',
            });
            return;
        }

        const gameData = this.engine.getGameData?.();
        if (!gameData) {
            abort('Game data not available');
            return;
        }

        const result = await createAssetEditProxy(assetId, gameData, this.engine.scene);
        if (!result.proxy) {
            abort(result.error ?? 'Could not load voxels for editing');
            return;
        }
        // Guard: the user may have started another session during the load.
        if (this.isVoxelSessionActive()) {
            result.proxy.dispose();
            abort('A voxel edit session is already open');
            return;
        }
        this.envInstanceEditProxy = result.proxy;

        const editability = VoxelObjectVolume.editability(result.proxy.voxelObject);
        if (!editability.editable) {
            this.disposeEnvInstanceEditProxy();
            abort(editability.reason ?? 'This object cannot be voxel-edited');
            return;
        }

        this.enterObjectVoxelSession(result.proxy.voxelObject);
    }

    /**
     * Report whether `assetId` is stored in the legacy JSON form.
     *
     * Runs HERE rather than in the creator because the two are different ORIGINS. The
     * asset bucket answers CORS per origin and does not send `Vary: Origin`, so a probe
     * from the creator (:3000) leaves a cached response stamped for the creator, and the
     * game's (:3001) next fetch of the same asset is rejected against it — the probe
     * breaks the very load it was meant to describe. `no-store` keeps this request out of
     * the cache for the same reason.
     */
    async reportVxlAssetFormat(assetId: string): Promise<void> {
        const gameData = this.engine.getGameData?.();
        const asset = gameData?.assets?.find((a: Asset) => a.id === assetId);
        if (!asset?.url) {
            safePostMessageToCreator({ type: 'VXL_FORMAT_CHECKED', assetId, legacy: false });
            return;
        }
        let legacy = false;
        try {
            // Read the first DECODED bytes off the stream and cancel, rather than asking
            // for `Range: bytes=0-3`.
            //
            // A range request returns bytes 0-3 of the ENCODED body while the response
            // still declares `Content-Encoding: br` — every asset is brotli-served — so the
            // browser tries to brotli-decode a 4-byte fragment and fails the request with
            // ERR_CONTENT_DECODING_FAILED. The catch below then reported "not legacy" for
            // every asset in the catalog, which is the same answer it gives for a healthy
            // VXL3 file: the check looked like it worked and had stopped working entirely,
            // while logging one console error per asset on every visit to the Assets tab.
            //
            // Cancelling after the first chunk keeps the original intent — do not download
            // a whole asset just to read a magic number.
            const response = await fetch(ASSET_MAP.get(asset.url) ?? asset.url, { cache: 'no-store' });
            const reader = response.ok ? response.body?.getReader() : null;
            if (reader) {
                const head = new Uint8Array(4);
                let filled = 0;
                // A chunk boundary can land inside the magic, so read until we have four
                // bytes or the stream ends.
                while (filled < 4) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    for (let i = 0; i < value.length && filled < 4; i++) head[filled++] = value[i]!;
                }
                void reader.cancel();
                // 'VXL3'; anything else at offset 0 is the JSON form.
                legacy = filled === 4
                    && !(head[0] === 0x56 && head[1] === 0x58 && head[2] === 0x4C && head[3] === 0x33);
            }
        } catch {
            legacy = false; // a transient failure offers no conversion rather than a broken one
        }
        safePostMessageToCreator({ type: 'VXL_FORMAT_CHECKED', assetId, legacy });
    }

    /**
     * Convert one legacy JSON `.vxl` asset to VXL3, in place.
     *
     * The runtime loader refuses the old format outright, so this is the only way back in
     * for an asset already published in it — read it once through the conversion-only
     * entry point, re-save through the normal asset write, and repoint the record. The
     * instances in world.json never move; they simply start resolving to a file the game
     * can load.
     *
     * Also refreshes `asset.size`, which the catalog displays. That field is written at
     * creation and never updated, so a converted asset would otherwise keep advertising
     * its pre-conversion size — the one number someone hunting for heavy assets reads.
     */
    async convertLegacyVxlAsset(assetId: string): Promise<void> {
        const report = (ok: boolean, detail: Record<string, unknown> = {}): void => {
            safePostMessageToCreator({ type: 'LEGACY_VXL_CONVERTED', assetId, ok, ...detail });
        };

        const gameData = this.engine.getGameData?.();
        const asset = gameData?.assets?.find((a: Asset) => a.id === assetId);
        if (!gameData || !asset?.url) {
            report(false, { error: 'Asset not found' });
            return;
        }

        let voxelObject: VoxelObject | null = null;
        try {
            const response = await fetch(ASSET_MAP.get(asset.url) ?? asset.url);
            if (!response.ok) {
                report(false, { error: `Could not fetch the asset (${response.status})` });
                return;
            }
            const buffer = await response.arrayBuffer();
            const beforeBytes = buffer.byteLength;

            voxelObject = new VoxelObject({
                voxelSize: asset.voxelSize ?? 0.5,
                shadows: true,
            });
            // Reads BOTH forms: an asset that is already VXL3 converts to itself, so a
            // double click cannot corrupt anything.
            await voxelObject.loadLegacyJsonForConversion(buffer);

            // Constructed directly rather than reached through `getVoxelEditor()`.
            // `VoxelObjectSaveService` is stateless — it takes the object, the name and the
            // game data as arguments and holds nothing — but `VoxelEditor` requires an
            // `EnvironmentObjectSystem` for its OTHER job (updating prefab instances). So a
            // game whose world generator exposes no env-object system failed conversion with
            // "Voxel save service unavailable", reporting a missing dependency that was
            // constructible all along. It read as intermittent; it tracked the game.
            const saveService = new VoxelObjectSaveService();
            const uploaded = await saveService.saveVoxelObjectAsAsset(
                voxelObject, asset.name ?? 'converted', gameData,
            );
            if (!uploaded) {
                report(false, { error: 'Upload failed' });
                return;
            }

            asset.url = uploaded.url;
            asset.size = uploaded.size;
            // Persistence goes through the creator, which routes it to the agent's
            // edit-world-config — the same message the voxel editor sends after a save.
            // Mutating gameData alone would leave the new url in memory only, and the
            // next load would fetch the legacy file again as if nothing had happened.
            safePostMessageToCreator({
                type: 'VOXEL_ASSET_SAVED',
                prefabType: asset.name ?? 'converted',
                asset,
                environmentObjects: [],
            });
            report(true, { beforeBytes, afterBytes: uploaded.size });
        } catch (err) {
            report(false, { error: err instanceof Error ? err.message : String(err) });
        } finally {
            voxelObject?.dispose();
        }
    }

    /**
     * Shared tail of both object-session entry points: enter the session, show
     * the toolbar, and surface the provenance warning.
     */
    private enterObjectVoxelSession(voxelObject: VoxelObject): void {
        this.closeObjectInspector();
        this.selectionManager.removeMouseListeners();
        // The session's orbit controls take the camera; the debug camera has
        // to let go or the two fight over every drag and wheel event.
        this.debugCameraSuspended = this.cameraManager.suspendDebugCamera();
        // Nothing about the scene tree applies while editing one object's
        // voxels, and the panel covers the toolbar.
        this.sceneHierarchyPanel?.hide();

        const session = this.getOrCreateVoxelSession();
        session.enter(new VoxelObjectVolume({
            scene: this.engine.scene,
            renderer: this.engine.renderer,
            camera: this.engine.camera,
            voxelObject,
            onCameraRestored: () => this.reSyncDebugCamera(),
        }));
        this.voxelEditToolbar.show(session.getVolume()!, `Voxels — ${voxelObject.name || 'object'}`);

        // Source-retained assets get the persistent loss warning: manual voxel
        // edits are discarded by a future re-voxelize / re-import
        // (docs/voxel-editor-design.md §3.1).
        const asset = this.findAssetForVoxelObject(voxelObject);
        if (asset?.sourceGlbUrl) {
            this.voxelEditToolbar.setNotice('Voxelized from a source model — re-voxelizing will discard manual voxel edits');
        } else if (asset?.sourceModelUrl) {
            this.voxelEditToolbar.setNotice('Imported from a voxel file — re-importing will discard manual voxel edits');
        } else if (asset?.sourceVxlMasterUrl) {
            this.voxelEditToolbar.setNotice('Forged from a voxel master — re-voxelizing will discard manual voxel edits');
        }

        safePostMessageToCreator({
            type: 'VOXEL_OBJECT_EDIT_STARTED',
            objectName: voxelObject.name,
        });
    }

    /** Resolve the world.json asset record backing a placed voxel object, if any. */
    private findAssetForVoxelObject(voxelObject: VoxelObject): {
        id?: string; sourceGlbUrl?: string; sourceModelUrl?: string; sourceVxlMasterUrl?: string; voxelEdited?: boolean;
    } | null {
        const gameData = this.engine.getGameData?.();
        if (!gameData) return null;
        const userData = voxelObject.userData as { assetId?: string; objectId?: string };
        let assetId = userData.assetId;
        if (!assetId && userData.objectId) {
            const envObj = (gameData.environmentObjects || []).find((o: { id: string }) => o.id === userData.objectId);
            assetId = envObj?.assetId;
        }
        if (!assetId) return null;
        return (gameData.assets || []).find((a: { id: string }) => a.id === assetId) ?? null;
    }

    /** Escape pressed inside a session — keep or discard changes. */
    private async requestVoxelSessionExit(): Promise<void> {
        const session = this.voxelEditSession;
        if (!session?.isActive()) return;
        if (!session.hasChanges()) {
            await this.endVoxelSession(false);
            return;
        }
        const keep = window.confirm('Save voxel edits?\n\nOK saves them, Cancel discards them.');
        await this.endVoxelSession(keep);
    }

    /**
     * Persist an edited voxel OBJECT (as opposed to the terrain volume).
     *
     * Wraps `VoxelEditor.saveEditedObject`'s boolean in the same shape terrain uses, so
     * `endVoxelSession` has one thing to check. The boolean was already there and already false on
     * a failed upload — nobody read it.
     */
    private async saveEditedVoxelObject(volume: IEditableVoxelVolume): Promise<VoxelSaveResult> {
        if (!(volume instanceof VoxelObjectVolume)) return { ok: true };
        const voxelEditor = this.getVoxelEditor();
        if (!voxelEditor) return { ok: true };
        const gameData = this.engine.getGameData?.() || null;
        const saved = await voxelEditor.saveEditedObject(volume.getVoxelObject(), gameData);
        if (!saved) {
            getEditorHost().journal({
                event: 'voxel.saveFailed',
                assetName: volume.getVoxelObject().name || 'voxel object',
                error: UPLOAD_FAILED_NOTICE,
            });
            return { ok: false, error: UPLOAD_FAILED_NOTICE };
        }
        return { ok: true };
    }

    /**
     * End the active voxel session. `save: true` persists — terrain through
     * the existing saveTerrainChanges flow (VXL → S3 + TERRAIN_SAVED_INTERNAL
     * to the host), objects through VoxelEditor.saveEditedObject (toVXL
     * re-encodes edited octree leaves with regenerated LODs).
     *
     * A failed save keeps the session open. That is the whole point of the return value: the bytes
     * live only in this tab until the upload lands, so committing on failure is data loss.
     */
    async endVoxelSession(save: boolean): Promise<void> {
        const session = this.voxelEditSession;
        const volume = session?.getVolume() ?? null;
        if (!session || !volume) return;

        const hadChanges = session.hasChanges();

        if (!save && hadChanges) {
            session.cancel();
        } else {
            if (save && hadChanges) {
                const saved = volume.kind === 'terrain'
                    ? await this.saveTerrainChanges()
                    : await this.saveEditedVoxelObject(volume);
                if (!saved.ok) {
                    // Keep the session, the toolbar and the edits. Committing here is what used to
                    // throw the work away: the volume is still dirty, so the creator can retry once
                    // whatever failed is fixed, or cancel deliberately.
                    this.voxelEditToolbar.setNotice(saved.error ?? UPLOAD_FAILED_NOTICE);
                    return;
                }
                session.markCommitted();
            }
            session.exit({ committed: true });
        }

        this.voxelEditToolbar.hide();
        this.engine.setOutlineSelectedObjects?.([]);
        // After the volume finalized (physics/mesh) — drop the instance
        // overlay proxy and restore the hidden instance mesh.
        this.disposeEnvInstanceEditProxy();

        // Give the camera and the scene tree back (object sessions only —
        // terrain sessions never took them).
        if (this.debugCameraSuspended) {
            this.cameraManager.resumeDebugCamera();
            this.debugCameraSuspended = false;
            this.sceneHierarchyPanel?.show();
        }

        if (volume.kind === 'object') {
            safePostMessageToCreator({
                type: 'VOXEL_OBJECT_EDIT_ENDED',
                hasChanges: save && hadChanges,
                ...(save ? {} : { canceled: true }),
            });
        }

        const isInEditorMode = this.isEditorMode || this.cameraManager.isFreeCameraEnabled();
        if (isInEditorMode) {
            this.selectionManager.setupMouseListeners();
        }
    }

    private disposeEnvInstanceEditProxy(): void {
        this.envInstanceEditProxy?.dispose();
        this.envInstanceEditProxy = null;
    }

    /** Small transient toast for editor-mode messages. */
    private showEditorToast(message: string): void {
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(30, 41, 59, 0.95);
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 14px;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            pointer-events: none;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.transition = 'opacity 0.3s ease';
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    /**
     * Get the VoxelWorld from the terrain system
     */
    private getVoxelWorld(): VoxelWorld | null {
        const terrainSystem = this.getVoxelTerrainSystem();
        if (terrainSystem && typeof terrainSystem.getVoxelWorld === 'function') {
            return terrainSystem.getVoxelWorld();
        }
        return null;
    }

    /**
     * Check if there are unsaved terrain changes (public for message handlers)
     */
    hasUnsavedTerrainChanges(): boolean {
        const session = this.voxelEditSession;
        if (!session?.isActive() || session.getVolume()?.kind !== 'terrain') return false;
        return session.hasChanges();
    }

    /**
     * Save terrain changes and re-chunk (public for message handlers)
     */
    public async saveTerrainChangesAsync(sessionId?: string): Promise<TerrainSaveResult> {
        return this.saveTerrainChanges(sessionId);
    }

    /**
     * Save terrain changes and re-chunk.
     *
     * Reports failure rather than swallowing it. The upload is the only step here that can fail, it
     * fails for ordinary reasons (a 500, an expired token, no network), and the caller has to know:
     * this used to return the same shape either way while the session was marked committed
     * regardless, so a failed upload discarded a creator's sculpt with nothing on screen to say so.
     */
    private async saveTerrainChanges(sessionId?: string): Promise<TerrainSaveResult> {
        // Generate sessionId if not provided (for save button clicks within iframe)
        const effectiveSessionId = sessionId || `edit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const wasSessionIdProvided = !!sessionId;

        // Re-chunk the terrain
        const voxelWorld = this.getVoxelWorld();
        if (voxelWorld) {
            voxelWorld.updatePhysicsAndMeshing(true);
        }

        // Save terrain VXL to S3. The world.json write is the HOST's — it arrives there as
        // TERRAIN_SAVED_INTERNAL below, or as the reply to SAVE_TERRAIN_CHANGES.
        const terrainSystem = this.getVoxelTerrainSystem();
        const gameData = this.engine.getGameData?.();
        if (!terrainSystem || !gameData?.gameId) {
            const error = 'This world has no terrain system to save.';
            console.warn('[TerrainEdit] ⚠️ Cannot save terrain: missing terrainSystem or gameId');
            getEditorHost().journal({ event: 'terrain.saveFailed', error });
            return { ok: false, error };
        }

        const voxelUrl: string | null = await terrainSystem.saveToS3(gameData.gameId);
        if (!voxelUrl) {
            console.warn('[TerrainEdit] ⚠️ Failed to save terrain to S3');
            getEditorHost().journal({ event: 'terrain.saveFailed', error: UPLOAD_FAILED_NOTICE });
            return { ok: false, error: UPLOAD_FAILED_NOTICE };
        }

        // Reset the session's changes baseline to the just-saved state
        this.voxelEditSession?.markCommitted();

        // If sessionId wasn't provided by parent, notify parent so it can add history entry
        if (!wasSessionIdProvided) {
            safePostMessageToCreator({
                type: 'TERRAIN_SAVED_INTERNAL',
                voxelUrl,
                sessionId: effectiveSessionId
            });
        }
        getEditorHost().journal({ event: 'terrain.saved', voxelUrl });

        return { ok: true, voxelUrl };
    }

    /**
     * Get the VoxelTerrainSystem from the world generator
     */
    private getVoxelTerrainSystem(): any {
        const worldGenerator = this.getWorldGenerator();
        if (worldGenerator && typeof worldGenerator.getVoxelTerrainSystem === 'function') {
            return worldGenerator.getVoxelTerrainSystem();
        }
        return null;
    }

    /**
     * Cancel terrain changes and restore original state (public for message handlers)
     */
    public cancelTerrainChanges(): void {
        const session = this.voxelEditSession;
        if (session?.isActive() && session.getVolume()?.kind === 'terrain') {
            void this.endVoxelSession(false);
        }
    }

    /**
     * Check if scene editing is locked
     * Returns true if procedural generation is still active (scene not unlocked)
     */
    isSceneEditingLocked(): boolean {
        return this.sceneEditingLocked;
    }
    
    
    /**
     * Refresh all open inspectors after lock state change
     */
    private refreshInspectorsAfterUnlock(): void {
        if (this.sceneInfoPanel) {
            this.sceneInfoPanel.setSceneEditingLocked(false);
        }
    }

    /**
     * Show message that voxel editing is locked
     */
    private showVoxelEditingLockedMessage(): void {
        // Create a temporary toast message
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(239, 68, 68, 0.95);
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 14px;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            pointer-events: none;
        `;
        toast.textContent = `🔒 ${t('editor.panels.sceneEditingLocked')}`;
        document.body.appendChild(toast);
        
        // Fade out and remove after 3 seconds
        setTimeout(() => {
            toast.style.transition = 'opacity 0.3s ease';
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    /**
     * Find VoxelObject in the object hierarchy
     */
    private findVoxelObjectInHierarchy(obj: THREE.Object3D | null): VoxelObject | null {
        if (!obj) return null;
        
        if (obj instanceof VoxelObject) return obj;
        
        // Check children
        for (const child of obj.children) {
            const found = this.findVoxelObjectInHierarchy(child);
            if (found) return found;
        }
        
        // Check parent
        let current: THREE.Object3D | null = obj.parent;
        while (current) {
            if (current instanceof VoxelObject) return current;
            current = current.parent;
        }
        
        return null;
    }

    /**
     * Make a prefab instance unique: creates a new VXL asset and updates only
     * this instance to use it (public — wired to the inspector's Voxels section).
     */
    async makeVoxelObjectUnique(object: THREE.Object3D): Promise<void> {
        // Check if scene editing is locked
        if (this.isSceneEditingLocked()) {
            this.showVoxelEditingLockedMessage();
            return;
        }

        const voxelObject = this.findVoxelObjectInHierarchy(object);
        if (!voxelObject) {
            return;
        }

        const gameData = this.engine.getGameData?.();
        if (!gameData) {
            return;
        }

        const voxelEditor = this.getVoxelEditor();
        if (!voxelEditor || !voxelEditor.isPrefab(voxelObject)) {
            return;
        }

        // Generate a unique asset name
        const timestamp = Date.now();
        const uniqueTypeName = `${voxelEditor.getPrefabType(voxelObject) || 'voxelObject'}-unique-${timestamp}`;

        // Upload to S3
        const saveService = voxelEditor.getSaveService();
        const uploadResult = await saveService.saveVoxelObjectAsAsset(voxelObject, uniqueTypeName, gameData);
        
        if (!uploadResult) {
            return;
        }
        
        // Get bounding box
        const bounds = voxelObject.getBounds();
        const boundingBox = bounds ? {
            minX: bounds.minX,
            minY: bounds.minY,
            minZ: bounds.minZ,
            maxX: bounds.maxX,
            maxY: bounds.maxY,
            maxZ: bounds.maxZ
        } : undefined;
        
        // Create a new asset entry with unique ID
        const idService = getObjectIdService();
        const assetId = idService.generateId('asset');
        const newAsset = {
            id: assetId,
            name: uniqueTypeName,
            url: uploadResult.url,
            type: 'vxl' as const,
            // Recorded at creation for the same reason the edit path refreshes it: an
            // asset with no size shows as 0 B (or inherits a stale figure on re-save),
            // and the catalog's size column is what a size problem is found through.
            size: uploadResult.size,
            boundingBox
        };
        
        // Add to gameData assets
        if (!gameData.assets) {
            gameData.assets = [];
        }
        gameData.assets.push(newAsset);
        
        if (!gameData.environmentObjects) {
            gameData.environmentObjects = [];
        }
        
        // Get the environment object ID from the VoxelObject's userData
        const existingId = voxelObject.userData.id;
        if (!existingId) {
            return;
        }
        
        // Find the existing entry by ID and UPDATE it in place
        const existingIndex = gameData.environmentObjects.findIndex((obj: any) => obj.id === existingId);
        
        if (existingIndex !== -1) {
            const existingObj = gameData.environmentObjects[existingIndex];
            existingObj.type = uniqueTypeName;
            existingObj.assetId = assetId;
            existingObj.boundingBox = boundingBox;
        } else {
            return;
        }
        
        // Remove the object from EnvironmentObjectSystem's prefab storage
        const envSystem = this.engine.getEnvironmentObjectSystem?.();
        if (envSystem) {
            envSystem.removeVoxelObjectFromStorage(voxelObject);
        }

        // Mark the VoxelObject as unique (no longer a shared prefab)
        voxelObject.markAsUnique();
        
        // Store the asset ID and unique type name in userData for identification
        voxelObject.userData.assetId = assetId;
        voxelObject.userData.environmentType = uniqueTypeName;
        
        // Mark scene as having changes
        this.markFullSaveNeeded();
        
        // Notify parent to save world.json
        safePostMessageToCreator({
            type: 'VOXEL_ASSET_SAVED',
            prefabType: uniqueTypeName,
            asset: newAsset,
            updateObjectId: existingId,
            updateValues: {
                type: uniqueTypeName,
                assetId: assetId,
                boundingBox: boundingBox
            }
        });

        // Refresh the inspector so the object shows as unique (no longer a prefab)
        if (this.objectInspector) {
            this.objectInspector.show(voxelObject);
        }
    }

    /**
     * Mark that voxels have been modified.
     * Change state now lives in the voxel edit session; kept for message handlers.
     */
    markVoxelChanges(): void {
        // no-op — the session tracks changes via volume checksums
    }

    /**
     * Clear the voxel changes flag.
     * Change state now lives in the voxel edit session; kept for message handlers.
     */
    clearVoxelChanges(): void {
        this.voxelEditSession?.markCommitted();
    }

    /**
     * Check if there are unsaved voxel changes
     */
    hasVoxelChanges(): boolean {
        return this.voxelEditSession?.isActive() === true && this.voxelEditSession.hasChanges();
    }

    /**
     * Get whether an environment object is marked as destructible in gameData
     */
    private getObjectDestructible(objectId: string): boolean {
        const gameData = this.engine.getGameData?.();
        if (!gameData?.environmentObjects) return false;
        const obj = (gameData.environmentObjects as any[]).find((o: any) => o.id === objectId);
        return obj?.destructible === true;
    }

    /**
     * Set the destructible flag on an environment object in gameData
     */
    private setObjectDestructible(objectId: string, value: boolean): void {
        const gameData = this.engine.getGameData?.();
        if (!gameData?.environmentObjects) return;
        const obj = (gameData.environmentObjects as any[]).find((o: any) => o.id === objectId);
        if (!obj) return;

        if (value) {
            obj.destructible = true;
        } else {
            delete obj.destructible;
        }

        // Also update ObjectIdService registration data — this is what
        // serializeEnvironmentObjects() reads during save
        const idService = getObjectIdService();
        const regData = idService.getDataById(objectId);
        if (regData) {
            if (value) {
                regData.destructible = true;
            } else {
                delete regData.destructible;
            }
        }

        this.markObjectModified(objectId);
    }

    /**
     * Remove an environment object from the scene and gameData.
     * Called from ObjectInspector when the user clicks the Remove Object button.
     */
    private handleRemoveObject(object: THREE.Object3D): void {
        const objectId = this.resolveObjectId(object);
        if (!objectId) {
            console.warn('[EditorManager] handleRemoveObject: could not resolve objectId for', object.name);
            return;
        }

        // Remove from scene
        const parent = object.parent;
        if (parent) {
            parent.remove(object);
            object.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    // Unpacked env instances SHARE their type's geometry (owned by
                    // EnvironmentObjectSystem's pack/unpack lifecycle); disposing it
                    // here would drop GPU buffers still used by every other instance,
                    // and post-upload-released CPU arrays cannot re-upload them.
                    if (child.userData.isEnvironmentInstance !== true) {
                        child.geometry?.dispose();
                    }
                    const mat = child.material;
                    if (Array.isArray(mat)) mat.forEach(m => m.dispose());
                    else mat?.dispose();
                }
            });
        }

        // Unregister from ObjectIdService
        getObjectIdService().unregister(objectId);

        // Remove from gameData.environmentObjects
        const gameData = this.engine.getGameData?.();
        if (gameData?.environmentObjects) {
            const idx = (gameData.environmentObjects as any[]).findIndex((o: any) => o.id === objectId);
            if (idx !== -1) {
                gameData.environmentObjects.splice(idx, 1);
            }
        }

        // Deselect
        this.selectedObject = null;
        this.selectionManager.setSelectedObject(null);
        if (this.transformControlsManager) {
            this.transformControlsManager.detach();
        }
        this.closeObjectInspector();

        // Track deletion so it can be saved surgically on tab switch
        this.deletedObjectIds.add(objectId);
        this.modifiedObjectIds.delete(objectId);

        console.log(`[EditorManager] Removed object "${objectId}" from scene`);
    }

    /**
     * Capture the initial checksums of the world state.
     * Should be called once the game has finished loading.
     */
    captureInitialChecksums(): void {
        const voxelWorld = this.getVoxelWorld();
        this.initialWorldChecksum = calculateWorldChecksum(voxelWorld, this.engine.scene);
        this.initialTerrainChecksum = calculateTerrainChecksum(voxelWorld);
    }

    /**
     * Check if the world has been modified since initial load.
     * Compares current state checksum against the initial checksum.
     */
    isWorldModified(): boolean {
        const voxelWorld = this.getVoxelWorld();
        const currentChecksum = calculateWorldChecksum(voxelWorld, this.engine.scene);
        return currentChecksum !== this.initialWorldChecksum;
    }

    /**
     * Check if the terrain has been modified since initial load.
     * Separate from full world check - only checks terrain voxels.
     */
    isTerrainModified(): boolean {
        const voxelWorld = this.getVoxelWorld();
        const currentChecksum = calculateTerrainChecksum(voxelWorld);
        return currentChecksum !== this.initialTerrainChecksum;
    }

    /**
     * Update the initial terrain checksum after saving.
     * Called after terrain changes are saved to reflect the new baseline.
     */
    updateTerrainChecksum(): void {
        const voxelWorld = this.getVoxelWorld();
        this.initialTerrainChecksum = calculateTerrainChecksum(voxelWorld);
    }

    /**
     * Update all checksums (called after world reload or after saving changes)
     */
    updateAllChecksums(): void {
        this.captureInitialChecksums();
    }

    /**
     * Toggle enemy character spawn/despawn
     */
    toggleEnemyCharacter(spawnX?: number, spawnZ?: number) {
        this.spawnManager.toggleEnemyCharacter(spawnX, spawnZ);
    }

    /**
     * Spawn example enemy character
     */
    spawnEnemyCharacter() {
        this.spawnManager.spawnEnemyCharacter();
    }

    /**
     * Despawn example enemy character
     */
    despawnEnemyCharacter() {
        this.spawnManager.despawnEnemyCharacter();
    }

    /**
     * Spawn a vehicle near the player
     */
    spawnVehicle() {
        this.spawnManager.spawnVehicle();
    }

    /**
     * Toggle Debug Game Info visibility
     */
    toggleDebugGameInfo() {
        if (this.debugGameInfoPanel) {
            this.debugGameInfoPanel.toggle();
        } else {
            console.warn('Debug Game Info panel not found');
        }
    }

    /**
     * Toggle the NPC perf A/B ablation (N key). Freezes and hides every NPC and
     * animal while leaving terrain, environment, physics and the player running.
     *
     * Bound to a key rather than only the panel checkbox because gameplay holds
     * pointer lock: clicking the checkbox means alt-tabbing out of the game,
     * which disturbs the frame rate the toggle exists to measure. Logs the new
     * state so a reading can be attributed after the fact — the panel checkbox
     * is not visible unless the panel is open.
     */
    toggleNpcsDisabled() {
        const next = !this.engine.getDebugDisableNpcs();
        this.engine.setDebugDisableNpcs(next);
        console.log(`[Debug] NPCs ${next ? 'DISABLED (frozen + hidden)' : 'ENABLED'} — perf A/B toggle (N)`);
    }
    
    /**
     * Enable editor mode
     */
    enableEditorMode() {
        if (this.isEditorMode) return;

        console.log('Enabling editor mode...');
        this.isEditorMode = true;

        // Enable debug features when in editor mode
        this.debugManager.enableDebug();

        setEditorModeForPointerLock(this.engine, true);

        // Save current camera state
        this.saveCameraState();

        // Disable player controls (like heightmap editor does)
        this.cameraManager.disablePlayerControls();

        // Switch to debug camera
        this.switchToDebugCamera();

        // Show debug UI
        this.showDebugUI();

        // Setup click-to-select
        this.setupDebugMouseListeners();

        // Refresh scene hierarchy
        this.refreshSceneHierarchy();

        // Environment-object InstancedMeshes are intentionally NOT unpacked on
        // editor entry. Unpacking hundreds of instanced buildings (a geometry
        // clone per instance) blocked the main thread for seconds on city-scale
        // scenes. Types now stay packed ("locked") and are unpacked lazily, one
        // type at a time, only when the user explicitly unlocks it for editing
        // (see unlockEnvironmentType + the Scene-editor unlock affordance).

        // Show markers (hidden in play mode)
        if (this.markerSystem) {
            this.markerSystem.setVisible(true);
        }

        // Show spawn point markers (skip player spawn if multiplayer spawns exist)
        for (const marker of this.spawnPointMarkers.values()) {
            if (this.hasMultiplayerSpawns && marker.type === 'player') continue;
            this.snapSpawnMarkerToGround(marker);
            marker.show();
        }

        // Focus window and renderer for keyboard input
        window.focus();
        if (this.engine.renderer && this.engine.renderer.domElement) {
            this.engine.renderer.domElement.focus();
        }

        console.log('Editor mode enabled');
    }

    /**
     * Disable editor mode
     */
    disableEditorMode() {
        if (!this.isEditorMode) return;

        console.log('Disabling editor mode...');
        this.isEditorMode = false;

        // Disable debug features when leaving editor mode
        this.debugManager.disableDebug();

        setEditorModeForPointerLock(this.engine, false);

        // Pack back any environment types the user unlocked for editing this
        // session (no-op if nothing was unlocked). Routed straight to the shared
        // engine system so it reaches existing games.
        getActiveEnvironmentObjectSystem()?.packInstancedMeshes();

        // Restore player controls
        this.cameraManager.restorePlayerControls();

        // Switch back to original camera
        this.switchToOriginalCamera();

        // Remove click-to-select
        this.removeDebugMouseListeners();

        // Hide debug UI
        this.hideDebugUI();

        // Hide markers (only visible in debug mode)
        if (this.markerSystem) {
            this.markerSystem.setVisible(false);
        }

        // Hide spawn point markers
        for (const marker of this.spawnPointMarkers.values()) {
            marker.hide();
        }

        console.log('Debug mode disabled');
    }
    
    /**
     * Get WorldGenerator from genre module
     */
    private getWorldGenerator(): any {
        return (this.engine as any).genreModule?.worldGenerator ?? null;
    }
    
    /**
     * Unlock a single environment-object type for individual editing in the Scene
     * editor. Unpacks just that type's InstancedMesh into individually selectable
     * meshes — fast, because only one type is touched (unlike the old unpack-all
     * on editor entry). Routes straight to the shared engine system so it reaches
     * existing games (whose frozen genre WorldGenerator can't take a per-type arg).
     */
    unlockEnvironmentType(typeName: string): void {
        getActiveEnvironmentObjectSystem()?.unpackInstancedMeshes(typeName);
    }

    private envUnlockNotification: InGameNotification | null = null;

    /**
     * Scene-editor click on a packed environment-object InstancedMesh (e.g. a
     * forged-city building or landmark): unlock just that type and immediately
     * select the exact instance that was clicked, so one click yields the
     * inspector + transform gizmo. Returns false when the hit isn't a packed
     * environment-object mesh.
     */
    private trySelectPackedEnvironmentInstance(hit: SelectionHit): boolean {
        const sys = getActiveEnvironmentObjectSystem();
        if (!sys) return false;

        // The hit object is one of the type's LOD/packed InstancedMeshes.
        let typeName: string | null = null;
        let node: THREE.Object3D | null = hit.object;
        while (node && !typeName) {
            typeName = sys.getEnvTypeForObject(node);
            node = node.parent;
        }
        if (!typeName) return false;

        // World position of the clicked instance: its instance matrix is valid
        // for the frame the click happened in; fall back to the surface point.
        const instancePos = hit.point.clone();
        if (hit.object instanceof THREE.InstancedMesh && hit.instanceId !== undefined) {
            const matrix = new THREE.Matrix4();
            hit.object.getMatrixAt(hit.instanceId, matrix);
            instancePos.setFromMatrixPosition(matrix);
        }

        if (!sys.isTypeUnpacked(typeName)) {
            const count = sys.getTypeInstanceCount(typeName);
            this.unlockEnvironmentType(typeName);
            this.refreshSceneHierarchy();
            if (!this.envUnlockNotification) {
                this.envUnlockNotification = new InGameNotification();
            }
            this.envUnlockNotification.show(`Unlocked ${typeName} (${count}) for editing.`, 4000);
        }

        const mesh = sys.findUnpackedMeshNear(typeName, instancePos);
        if (!mesh) return false;
        this.selectObject(mesh, false);
        return true;
    }

    /**
     * Handle a click on a packed (locked) environment-object type in the Scene
     * editor: unlock just that type (fast — only this type's instances are
     * unpacked, not the whole scene) and tell the user it's now editable. The
     * first click unlocks; a second click on the now-individual mesh selects it.
     */
    private onLockedEnvironmentTypeClicked(typeName: string): void {
        const sys = getActiveEnvironmentObjectSystem();
        if (!sys) return;
        const count = sys.getTypeInstanceCount(typeName);
        this.unlockEnvironmentType(typeName);
        this.refreshSceneHierarchy();
        if (!this.envUnlockNotification) {
            this.envUnlockNotification = new InGameNotification();
        }
        this.envUnlockNotification.show(
            `Unlocked ${typeName} (${count}) for editing — click it again to select.`,
            4000,
        );
    }
    
    /**
     * Get VoxelEditor, creating it lazily if needed
     */
    private getVoxelEditor(): VoxelEditor | null {
        if (this.voxelEditor) {
            return this.voxelEditor;
        }
        
        const worldGenerator = this.getWorldGenerator();
        if (worldGenerator && typeof worldGenerator.getEnvironmentObjectSystem === 'function') {
            const envSystem = worldGenerator.getEnvironmentObjectSystem();
            if (envSystem) {
                this.voxelEditor = new VoxelEditor(envSystem);
                return this.voxelEditor;
            }
        }
        
        console.warn('[EditorManager] Could not create VoxelEditor: EnvironmentObjectSystem not available');
        return null;
    }
    

    /**
     * Save current camera state
     */
    saveCameraState() {
        this.cameraManager.saveCameraState();
    }

    /**
     * Switch to debug camera
     */
    switchToDebugCamera() {
        this.cameraManager.switchToDebugCamera();
    }

    /**
     * Switch back to original camera
     */
    switchToOriginalCamera() {
        this.cameraManager.switchToOriginalCamera();
    }

    /**
     * Enable free camera controls without debug UI (for Splats tab)
     */
    enableFreeCamera() {
        this.cameraManager.enableFreeCamera();
        this.disableTerrainCullingForEditor();
        // Now that the debug camera exists, tell it when to defer its Shift
        // "fly faster" modifier: only while a voxel edit session is active,
        // since that's the only mode that consumes Shift+WASD (to nudge voxels).
        // Outside that mode Shift always means "fly faster".
        this.cameraManager.getDebugCamera()?.setShiftReservedCallback(
            () => this.isVoxelSessionActive()
        );
    }

    /**
     * Disable free camera controls
     */
    disableFreeCamera() {
        // Leaving the editor with a live voxel session (tab switch): keep the
        // user's work — save-and-close rather than silently dropping edits.
        if (this.isVoxelSessionActive()) {
            void this.endVoxelSession(true);
        }
        this.cameraManager.disableFreeCamera();
        this.restoreTerrainCulling();
    }

    /**
     * The editor must show the whole world regardless of where the free camera
     * points, so suppress terrain chunk culling while editing (remembering the
     * game's setting to restore on exit). Environment-object culling is already
     * disabled in editor mode; this brings terrain in line with it.
     */
    private disableTerrainCullingForEditor(): void {
        if (this.terrainCullingWasEnabled !== null) return; // already overridden
        const terrain = this.getVoxelTerrainSystem();
        if (!terrain || typeof terrain.isCullingEnabled !== 'function') return;
        this.terrainCullingWasEnabled = terrain.isCullingEnabled();
        terrain.setCullingEnabled(false);
    }

    /** Restore the game's terrain-culling setting captured on editor entry. */
    private restoreTerrainCulling(): void {
        if (this.terrainCullingWasEnabled === null) return;
        const terrain = this.getVoxelTerrainSystem();
        if (terrain && typeof terrain.setCullingEnabled === 'function') {
            terrain.setCullingEnabled(this.terrainCullingWasEnabled);
        }
        this.terrainCullingWasEnabled = null;
    }
    
    /**
     * Re-sync the debug camera with current camera position
     * Used after exiting voxel object edit mode to restore WASD controls
     */
    reSyncDebugCamera() {
        this.cameraManager.reSyncDebugCamera();
    }
    
    /**
     * Create debug UI elements
     */
    createDebugUI() {
        // Main debug container
        this.debugContainer = document.createElement('div');
        this.debugContainer.id = 'debug-container';
        this.debugContainer.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 10000;
            font-family: 'Courier New', monospace;
            display: none;
        `;
        document.body.appendChild(this.debugContainer);

        // Scene hierarchy panel
        this.sceneHierarchyPanel = new SceneHierarchyPanel(
            this.engine.scene,
            this.debugContainer,
            (object, focusCamera) => this.selectObject(object, focusCamera)
        );
        this.sceneHierarchyPanel.createPanel();

        // Object inspector panel
        this.objectInspector = new ObjectInspector(
            this.debugContainer,
            () => this.cameraManager.getDebugCamera(),
            () => this.sceneEditingLocked,
            () => this.markerSystem,
            (object?: THREE.Object3D) => this.commitTransformChange(object ?? this.selectedObject ?? null),
            (object, focusCamera) => this.selectObject(object, focusCamera),
            () => this.engine.getGameData(),
            (objectId, enable) => this.handleToggleFlattenTerrain(objectId, enable),
            (objectId, enable) => this.setObjectDestructible(objectId, enable),
            (object) => this.handleRemoveObject(object)
        );
        this.objectInspector.createPanel();
        this.objectInspector.setScene(this.engine.scene);
        this.objectInspector.setVoxelEditCallbacks(
            (object) => { void this.startObjectVoxelSessionFor(object); },
            (assetId, action) => {
                // The re-bake dialogs belong to the host (the Creator's Assets tab flows); ask it to
                // open the right one. A host with no chrome of its own ignores this rather than
                // having the editor post into the void.
                getEditorHost().navigate({ assetAction: { assetId, action } });
            },
        );

        // Transform controls for visual object manipulation
        this.transformControlsManager = new TransformControlsManager(
            this.engine.scene,
            this.engine.camera,
            this.engine.renderer,
            {
                onBeforeTransform: (object: THREE.Object3D) => {
                    // Capture snapshot before any transform change (drag or snap)
                    const objectId = this.resolveObjectId(object);
                    if (objectId && !this.originalObjectSnapshots.has(objectId)) {
                        this.captureObjectSnapshot(objectId, object);
                    }
                },
                setDragging: (isDragging) => {
                    const debugCamera = this.cameraManager.getDebugCamera();
                    if (debugCamera) {
                        debugCamera.setEnabled(!isDragging);
                    }
                },
                onTransformChange: (_object) => {
                    // Object inspector updates are handled when Advanced is clicked
                    // Don't auto-show it here
                },
                onTransformEnd: (_object) => {
                    // Transform gizmo remains visible - no need to show bounding box
                },
                markSceneChanges: (object: THREE.Object3D) => this.commitTransformChange(object),
                getGroundHeight: (x: number, z: number, excludeObject?: THREE.Object3D) => {
                    // Use scene-based raycasting with foliage filtering
                    // This snaps to any solid surface (terrain, buildings) but ignores foliage/grass
                    const height = this.placementHelper.findGroundHeightAt(x, z, excludeObject);
                    if (height !== null) {
                        return height;
                    }
                    // Fallback to heightmap if no raycast hit
                    const worldGenerator = this.getWorldGenerator();
                    if (worldGenerator && typeof worldGenerator.getHeightAt === 'function') {
                        return worldGenerator.getHeightAt(x, z);
                    }
                    return 0;
                },
                isObjectModified: (object: THREE.Object3D): boolean => {
                    const objectId = this.resolveObjectId(object);
                    if (!objectId) return false;
                    return this.canUndoObject(objectId);
                },
                undoObject: (object: THREE.Object3D) => {
                    const objectId = this.resolveObjectId(object);
                    if (!objectId) return;
                    // Detach transform controls first to prevent change events from overwriting position
                    this.transformControlsManager?.detach();
                    const revertedObject = this.undoObjectChanges(objectId, object);
                    if (revertedObject && this.transformControlsManager) {
                        this.transformControlsManager.attach(revertedObject);
                    }
                }
            }
        );

        // Connect transform controls to debug camera to prevent camera movement when gizmo is active
        const debugCamera = this.cameraManager.getDebugCamera();
        if (debugCamera && this.transformControlsManager) {
            debugCamera.setShouldIgnoreInput(() => this.transformControlsManager?.isGizmoActive() ?? false);
        }

        // Scene info dialog
        this.sceneInfoPanel = new SceneInfoPanel(
            this.engine,
            this.debugContainer,
            () => this.unlockSceneEditingInternal()
        );
        this.sceneInfoPanel.createPanel();

        // Debug info overlay (removed - now shown in Debug tab in creator)
    }
    
    /**
     * Internal method for unlocking scene editing (called by SceneInfoPanel)
     * This is the unified unlock method for all tabs
     * For voxel genre, this performs the full unlock flow (convert procedural to assets, save terrain)
     */
    private async unlockSceneEditingInternal(): Promise<void> {
        // For voxel genre, perform the full unlock flow
        const voxelEditor = this.getVoxelEditor();
        if (voxelEditor) {
            await this.performVoxelUnlock();
            return;
        }

        // Update unified lock state
        this.sceneEditingLocked = false;

        // Refresh all inspectors to reflect the unlocked state
        this.refreshInspectorsAfterUnlock();
    }

    /**
     * Perform the full voxel unlock flow
     * Shared between Scene tab and Voxels tab unlock functionality
     */
    private async performVoxelUnlock(): Promise<void> {
        const voxelEditor = this.getVoxelEditor();
        if (!voxelEditor) return;

        const gameData = this.engine.getGameData?.() || null;
        const result = await voxelEditor.unlockScene(gameData);
        if (!result.success) {
            console.warn('[EditorManager] Voxel unlock failed:', result.message);
            return;
        }

        // Also save terrain VXL to S3. A failure here does NOT abort the unlock: the unlock
        // converted procedural geometry into real assets and environmentObjects, and throwing that
        // away because the terrain bytes did not land would lose far more than it saves. Say so
        // instead, so the creator knows the terrain half needs saving again.
        let voxelUrl: string | null = null;
        const terrainSystem = this.getVoxelTerrainSystem();
        if (terrainSystem && gameData?.gameId) {
            voxelUrl = await terrainSystem.saveToS3(gameData.gameId);
            if (voxelUrl) {
                console.log('[EditorManager] Terrain saved to S3:', voxelUrl);
            } else {
                console.warn('[EditorManager] Terrain upload failed during unlock');
                this.voxelEditToolbar.setNotice(UPLOAD_FAILED_NOTICE);
                getEditorHost().journal({ event: 'terrain.saveFailed', error: UPLOAD_FAILED_NOTICE });
            }
        }

        // Send to parent for saving to world.json.
        // `activeLevelId` declares WHICH LEVEL environmentObjects covers: the
        // conversion walks EnvironmentObjectSystem, which only holds the loaded
        // level's instances plus the untagged/global ones. Without it the
        // creator would write this partial array over the whole world and wipe
        // every other level's scenery. `null` = single-level/legacy game, where
        // the array really is everything.
        safePostMessageToCreator({
            type: 'VOXEL_SCENE_UNLOCKED',
            assets: result.assets,
            environmentObjects: result.environmentObjects,
            activeLevelId: getActiveLevelIdOrNull(),
            worldProfileData: {
                voxelUrl: voxelUrl || undefined
            }
        });

        // Update state and refresh UI
        this.sceneEditingLocked = false;
        this.refreshInspectorsAfterUnlock();
        // Mark changes so tab switch will trigger save
        this.markFullSaveNeeded();
        this.markVoxelChanges();

        console.log('[EditorManager] Voxel unlock completed');
    }
    
    /**
     * Create standalone debug info panel (always available, independent of debug mode)
     */
    createStandaloneDebugInfo() {
        this.debugGameInfoPanel = new DebugGameInfoPanel(this.engine.scene, this.engine);
        this.debugGameInfoPanel.createPanel();

        // Wire up player position provider
        this.debugGameInfoPanel.setPositionProvider(() => {
            return (this.engine.getPlayerController() as any)?.player?.position ?? null;
        });

        // Wire up animation state provider from player controller
        this.debugGameInfoPanel.setAnimationStateProvider(() => {
            const pc = this.engine.getPlayerController() as any;
            const animController = pc?.animationController;
            if (animController && typeof animController.getCurrentState === 'function') {
                return animController.getCurrentState();
            }
            return '—';
        });

        // Wire up the NPC LOD scheduler stats line
        this.debugGameInfoPanel.setNpcLodProvider(() => getGlobalLodScheduler().getStatsLine());

        // Wire up the frame-span attribution line (worst ms per animate() span)
        this.debugGameInfoPanel.setFrameSpanProvider(() => frameSpanRecorder.getWorstLine());

        wireNavmeshPathProviderToDebugPanel(this.debugGameInfoPanel, this.engine);

        this.debugGameInfoPanel.attachGaussianSplatDebugDialog(this.engine);

        wirePvsProvidersToDebugPanel(this.debugGameInfoPanel, () => (this.engine as unknown as { pvsController?: PvsEditor | null }).pvsController ?? null);
    }

    /**
     * Update game name in debug info panel
     */
    updateGameName(gameName: string) {
        if (this.debugGameInfoPanel) {
            this.debugGameInfoPanel.updateGameName(gameName);
        }
    }

    /**
     * Check if scene editing is locked (delegates to SceneInfoPanel)
     */
    async checkSceneEditingLockStatus(silent: boolean = false): Promise<void> {
        if (this.sceneInfoPanel) {
            await this.sceneInfoPanel.checkSceneEditingLockStatus(silent);
            this.sceneEditingLocked = this.sceneInfoPanel.isSceneEditingLocked();
        }
    }

    /**
     * Unlock scene editing (delegates to SceneInfoPanel)
     */
    async unlockSceneEditing(): Promise<void> {
        if (this.sceneInfoPanel) {
            await this.sceneInfoPanel.unlockSceneEditing();
            this.sceneEditingLocked = false;
        }
    }

    /**
     * Toggle pause/play state in the editor UI mirror.
     * Runtime simulation is controlled by GameStateManager in the engine loop.
     */
    togglePause() {
        this.isPaused = !this.isPaused;
        console.log(this.isPaused ? '⏸️ Game paused' : '▶️ Game resumed');
    }
    
    /**
     * Set pause state explicitly in the editor UI mirror.
     * Runtime simulation is controlled by GameStateManager in the engine loop.
     */
    setPaused(paused: boolean) {
        if (this.isPaused !== paused) {
            this.isPaused = paused;
            console.log(this.isPaused ? '⏸️ Game paused' : '▶️ Game resumed');
        } else {
            console.log(`[EditorManager] setPaused(${paused}) called but state already ${this.isPaused ? 'paused' : 'unpaused'}`);
        }
    }
    
    /**
     * Update pause/play button appearance
     */
    updatePausePlayButton() {
        // Button removed - runtime state is now reported via GAME_STATE_CHANGED.
    }
    
    /**
     * Legacy helper for editor-only callers.
     * Runtime simulation pause is no longer driven through EditorManager.
     */
    getDeltaTime(originalDeltaTime: number) {
        return this.isPaused ? 0 : originalDeltaTime;
    }
    
    /**
     * Show debug UI (respects current edit mode)
     */
    showDebugUI() {
        if (this.debugContainer) {
            this.debugContainer.style.display = 'block';
        }
        
        // While a voxel edit session runs, don't show scene-related panels
        if (this.isVoxelSessionActive()) {
            return;
        }

        // Check scene editing lock status but don't auto-show the panel
        // SceneInfoPanel and ObjectInspector are opened via "Advanced..." button
        if (this.sceneInfoPanel) {
            this.sceneEditingLocked = this.sceneInfoPanel.isSceneEditingLocked();
        }
        // Capture snapshots for per-object undo
        this.captureObjectSnapshots();
        if (this.sceneHierarchyPanel) {
            this.sceneHierarchyPanel.show();
        }
    }

    /**
     * Hide debug UI
     */
    hideDebugUI() {
        if (this.debugContainer) {
            this.debugContainer.style.display = 'none';
        }
        if (this.sceneInfoPanel) {
            this.sceneInfoPanel.hide();
        }
        this.closeObjectInspector();
    }
    
    /**
     * Refresh scene hierarchy display (not in voxel edit mode)
     */
    refreshSceneHierarchy() {
        // Never refresh scene hierarchy while a voxel edit session runs
        if (this.isVoxelSessionActive()) return;
        
        if (this.sceneHierarchyPanel) {
            this.sceneHierarchyPanel.refresh();
        }
    }

    /**
     * Select an object in the hierarchy (not in voxel edit mode)
     */
    selectObject(object: THREE.Object3D | string, focusCamera: boolean = true, hit?: SelectionHit) {
        // An active voxel edit session owns canvas clicks entirely.
        if (this.isVoxelSessionActive()) return;

        const obj = object as THREE.Object3D;
        const resolvedObject = this.selectionManager.resolveSelectableObject(obj);

        // Clicking terrain in the Editor tab opens the whole-terrain voxel
        // session — chunks are an engine detail, never a selection target
        // (docs/voxel-editor-design.md §3.2).
        if (SelectableObjectConfig.isTerrainChunk(resolvedObject)) {
            this.startTerrainVoxelSession(hit);
            return;
        }

        // Clicking a packed (locked) environment-object type — e.g. an instanced
        // building or landmark in a forged city — resolves to the raw
        // InstancedMesh, which carries no per-instance info. Unlock the type and
        // select the exact clicked instance instead.
        if (hit && !SelectableObjectConfig.isSelectable(resolvedObject)
            && this.trySelectPackedEnvironmentInstance(hit)) {
            return;
        }
        this.selectedObject = resolvedObject;
        this.selectionManager.setSelectedObject(resolvedObject);

        // Focus camera on object (only if requested)
        const debugCamera = this.cameraManager.getDebugCamera();
        if (focusCamera && debugCamera) {
            debugCamera.focusOn(resolvedObject);
        }

        // Attach transform controls if editing is unlocked AND object supports transform changes
        // Spawn point marker is always editable regardless of scene lock state
        const supportsTransform = SelectableObjectConfig.supportsTransformChanges(resolvedObject);
        const isSpawnMarker = SelectableObjectConfig.isSpawnPointMarker(resolvedObject);
        if (this.transformControlsManager && (!this.sceneEditingLocked || isSpawnMarker) && supportsTransform) {
            // Hide bounding box when transform controls are active
            this.selectionManager.hideBoundingBox();
            this.transformControlsManager.attach(resolvedObject, { scaleEnabled: !isSpawnMarker });
            // Auto-show object inspector when selecting an object
            this.showObjectInspector(resolvedObject);
        } else {
            // Detach any existing transform controls
            if (this.transformControlsManager) {
                this.transformControlsManager.detach();
            }
            // Show bounding box for view-only objects or in read-only mode
            this.selectionManager.showBoundingBox(resolvedObject);
            // Show object inspector (transform fields will be read-only if !supportsTransform)
            this.showObjectInspector(resolvedObject);
        }

        // Highlight in hierarchy
        if (this.sceneHierarchyPanel) {
            this.sceneHierarchyPanel.highlightObject(resolvedObject);
        }

        console.log('Selected object:', resolvedObject);
    }

    /**
     * Show object inspector (not in voxel edit mode)
     */
    showObjectInspector(object: THREE.Object3D) {
        // Never show the object inspector while a voxel edit session runs
        if (this.isVoxelSessionActive()) return;
        
        if (this.objectInspector) {
            this.objectInspector.show(object);
        }
    }

    /**
     * Close object inspector
     */
    closeObjectInspector() {
        // Detach transform controls
        if (this.transformControlsManager) {
            this.transformControlsManager.detach();
        }

        if (this.objectInspector) {
            this.objectInspector.close();
        }

        // Clear selection (hides bounding box)
        this.selectionManager.clearSelection();

        // Clear hierarchy highlight
        if (this.sceneHierarchyPanel) {
            this.sceneHierarchyPanel.clearHighlights();
        }

        this.selectedObject = null;
    }
    
    update(deltaTime: number) {
        // Update FPS counter in debug info panel (substep count feeds the
        // frame-pacing "beat" meter — see PhysicsWorld.lastStepSubstepCount).
        if (this.debugGameInfoPanel) {
            this.debugGameInfoPanel.recordFrame(this.engine.physicsWorld?.lastStepSubstepCount);
        }
        
        // Update spawn manager (physics test box, enemy, vehicle, cannon)
        this.spawnManager.update(deltaTime);

        // Update heightmap editor (independent of debug mode)
        if (this.heightmapEditorEnabled && this.heightmapEditor) {
            this.heightmapEditor.update(deltaTime);
        }

        // Active voxel edit session: object sessions run their own orbit
        // controls (skip other cameras); terrain sessions keep the free camera.
        if (this.voxelEditSession?.isActive()) {
            this.voxelEditSession.update();
            if (this.voxelEditSession.getVolume()?.kind === 'object') {
                return;
            }
        }

        // Update camera manager (debug camera if in debug mode OR free camera mode)
        this.cameraManager.update(deltaTime, this.isEditorMode);
    }

    /**
     * Get the current camera to use for rendering
     * In edit mode, we now use the main camera with orbit controls, so this returns null
     */
    getObjectEditModeCamera(): THREE.PerspectiveCamera | null {
        // Object voxel edit sessions use the main camera with orbit controls
        return null;
    }

    /**
     * Check if currently in object edit mode
     */
    isInVoxelObjectEditMode(): boolean {
        return this.voxelEditSession?.isActive() === true
            && this.voxelEditSession.getVolume()?.kind === 'object';
    }

    /**
     * Whether the debug free camera is flying the main camera around.
     *
     * The free camera moves `engine.camera` in place rather than swapping in
     * its own, so anything glued to the camera — the first-person view model
     * especially — has to know the viewpoint is no longer the player's eye.
     */
    isFreeCameraEnabled(): boolean {
        return this.cameraManager.isFreeCameraEnabled();
    }
    
    dispose() {
        document.removeEventListener('keydown', this.onKeyDown);

        // Remove debug mouse listeners
        this.removeDebugMouseListeners();

        // Dispose managers
        this.debugManager.dispose();
        this.selectionManager.dispose();
        this.spawnManager.dispose();
        this.cameraManager.dispose();

        // Dispose transform controls
        if (this.transformControlsManager) {
            this.transformControlsManager.dispose();
            this.transformControlsManager = null;
        }

        // Dispose Gaussian splat editor
        if (this.gaussianSplatEditor) {
            this.gaussianSplatEditor.dispose();
            this.gaussianSplatEditor = null;
        }

        // Dispose the voxel edit session (uncommitted — teardown only)
        if (this.voxelEditSession?.isActive()) {
            this.voxelEditSession.exit({ committed: false });
        }
        this.voxelEditSession = null;
        this.voxelEditToolbar.hide();

        if (this.debugContainer && this.debugContainer.parentNode) {
            this.debugContainer.parentNode.removeChild(this.debugContainer);
        }

        if (this.debugGameInfoPanel) {
            this.debugGameInfoPanel.dispose();
        }
    }
    
    closeSceneGraph() {
        if (this.isEditorMode) {
            this.disableEditorMode();
        }
    }

    /**
     * Update visibility culling system (stub - not currently implemented)
     */
    updateVisibilityCullingSystem(): void {
        // Stub method - visibility culling integration placeholder
    }
}
