import * as THREE from 'three';
import { createProgressModal, updateProgressModal, closeProgressModal } from './ProgressModal.js';
import { showSaveNotification, showVisibilityNotification } from './SaveNotifications.js';
import { getAgentUrl } from 'engine/agentUrl.js';
import { VoxelWorld } from 'engine/VoxelWorld.js';
import { FloorMeshColliderManager, type MeshColliderData } from './FloorMeshColliderManager.js';
import { saveVoxelsToS3, saveFloorMeshesToS3, getFloorMeshUrlFromGameData, getColliderUrlFromGameData, saveColliderUrlToWorldJson } from './GaussianSplatSaveLoad.js';
import type { PvsController } from './PvsController.js';
import type { BoxColliderData, HeightmapData } from 'types/game.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';

// Re-export types for backwards compatibility
export type { BoxColliderData, HeightmapData };

/**
 * Send a SPLAT_BATCH_SAVED postMessage to the creator frame and wait for the
 * SPLAT_BATCH_SAVED_RESPONSE acknowledgement. Resolves true on success.
 *
 * Blocking the call site is critical: the agent's `tempGenreFilesMiddleware`
 * snapshots `work/world.json` on prompt submission. If the snapshot happens
 * before our save lands on disk, the agent operates on stale env-objects and
 * silently overwrites the splat changes when it writes back. Awaiting the
 * round-trip ensures the disk write is committed before the next operation.
 */
async function sendSplatBatchSavedAndAwait(
    objects: Array<{ envObjectId: string; fields: Record<string, unknown> }>,
    description: string,
): Promise<boolean> {
    if (!window.parent || window.parent === window) {
        console.warn('[SplatBatchSave] No parent frame — cannot persist');
        return false;
    }
    const requestId = `splat-batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return new Promise<boolean>((resolve) => {
        const timeoutId = window.setTimeout(() => {
            window.removeEventListener('message', handler);
            console.error('[SplatBatchSave] Timeout waiting for SPLAT_BATCH_SAVED_RESPONSE');
            resolve(false);
        }, 15000);
        const handler = (e: MessageEvent) => {
            if (e.data?.type === 'SPLAT_BATCH_SAVED_RESPONSE' && e.data?.requestId === requestId) {
                window.clearTimeout(timeoutId);
                window.removeEventListener('message', handler);
                if (!e.data.success) console.error('[SplatBatchSave] Save failed:', e.data.error);
                resolve(!!e.data.success);
            }
        };
        window.addEventListener('message', handler);
        window.parent.postMessage({
            type: 'SPLAT_BATCH_SAVED',
            requestId,
            objects,
            description,
        }, '*');
    });
}

export interface ColliderFileData {
    colliders: BoxColliderData[];
    meshColliders?: MeshColliderData[];
    heightmap?: HeightmapData;
    voxelSize?: number;
}

export class GaussianSplatEditor {
    private scene: THREE.Scene;
    private camera: THREE.Camera;
    private physicsWorld: any;
    private domElement: HTMLElement;
    
    private colliders: Array<{ data: BoxColliderData; mesh: THREE.Mesh; body: any }> = [];
    private selectedCollider: { data: BoxColliderData; mesh: THREE.Mesh; body: any } | null = null;
    private floorMeshManager: FloorMeshColliderManager;
    private isEnabled: boolean = false;
    private splatFilename: string = '';
    private splatUrl: string = '';
    
    private raycaster: THREE.Raycaster;
    private mouse: THREE.Vector2;
    private ground: THREE.Mesh | null = null;
    
    private heightmapData: HeightmapData | null = null;
    private heightmapMesh: THREE.Mesh | null = null;
    private onHeightmapGenerated: ((heightmapData: HeightmapData) => void) | null = null;
    
    private splatTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 } | null = null;
    private splatVisibilityCallback: ((visible: boolean) => void) | null = null;
    private loadTestSplatCallback: ((url: string) => Promise<void>) | null = null;
    private splatTransformChangeCallback: ((transform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }) => void) | null = null;
    private getGameDataCallback: (() => any) | null = null; // Callback to get current game data
    private getSplatRenderersCallback: (() => any[]) | null = null; // Callback to get all splat renderers
    
    private transformsDirty: boolean = false; // Track if transforms have changed since last save
    
    private voxelParent: THREE.Group | null = null;
    private debugShowAllVoxels: boolean = false; // Forces all voxels visible (Splats panel debug toggle)
    
    // Visibility state driven by the Creator's Splats panel and by loadColliders():
    // 0 = Gaussians only, 1 = Gaussians + Voxels, 2 = Voxels only, 3 = Collision boxes solid
    private visibilityState: number = 0;
    private previousVisibilityState: number = 0; // Store state when entering Collider tab
    
    // VoxelWorld ownership lives on the per-splat GaussianSplatRenderer (so
    // game / template / work-folder code never has to reach into anything
    // called "editor" to read collider data). The editor only keeps an
    // *active pointer* — convenience for the editor's own UI flows (visibility
    // visualisation toggle, voxelisation tool, save) — that swaps to whichever
    // renderer is currently active. The same VoxelWorld instance is shared:
    // editor.voxelWorld === activeRenderer.getVoxelWorld(). Reads/writes
    // through the pointer hit the renderer's owned grid directly.
    private voxelWorld: VoxelWorld | null = null;
    private currentVoxelSize: number = 0.4; // default; updated on generation if needed
    /**
     * Opacity threshold for voxelisation: gaussians with opacity ≤ this are
     * treated as transparent noise and skipped during voxel placement. Lower
     * values (e.g. 0.1) keep more wispy detail; higher values (e.g. 0.5) keep
     * only the dense core. Side panel exposes this; defaults to 0.3.
     */
    private currentOpacityThreshold: number = 0.3;
    /**
     * 'center' (default): only the centre voxel of each gaussian receives a
     * hit (with a small disc-fill along the two largest axes — fast).
     * 'coverage': rasterise every voxel inside the gaussian's 3-σ ellipsoid.
     * Slower, but flat surfaces with sparse gaussian coverage fill cleanly.
     */
    private currentVoxelizeMode: 'center' | 'coverage' = 'center';
    private voxelWorldBounds: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number } | null = null;
    /**
     * Fallback grid for the legacy / "no active renderer" case. Used only
     * before any GaussianSplatRenderer is registered — ordinary per-splat
     * flows live on the renderers themselves.
     */
    private fallbackVoxelWorld: VoxelWorld | null = null;
    /** Neutral PVS owner (engine-level), set by the renderer. Lets the editor's
     *  visibility cycle follow the walkable overlay; bake/cull is driven via
     *  GameTemplate → GameEngine.pvsController, not here. */
    private pvsController: PvsController | null = null;
    setPvsController(controller: PvsController | null): void { this.pvsController = controller; }
    /** Used when no env-object can be resolved (legacy worldProfileData.voxelUrl path). */
    private static readonly LEGACY_VOXEL_KEY = '__legacy__';

    /** A collider id belongs to a generated voxel grid (vs. a manual box collider). */
    private static isVoxelColliderId(id: string): boolean {
        return id.startsWith('voxel_') || id.startsWith('merged_');
    }

    // Legacy properties (still used by some code)
    private gridOrigin: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
    private voxelCellSet: Set<string> = new Set();
    
    private boundOnMouseDown: (event: MouseEvent) => void;
    private boundOnMouseUp: (event: MouseEvent) => void;
    private boundOnMouseMove: (event: MouseEvent) => void;
    private boundOnKeyDown: (event: KeyboardEvent) => void;
    
    /**
     * No-op UI stub. The floating in-canvas editor panel was retired in favour
     * of the Splats side panel in creator. Existing call sites keep invoking
     * `this.ui.update()` etc.; routing them through a stub avoids mass-edits
     * and leaves the door open if a future surface wants to subscribe.
     */
    private ui: { show(): void; hide(): void; update(): void } = { show: () => {}, hide: () => {}, update: () => {} };
    
    private isDragging: boolean = false;
    private isMouseButtonDown: boolean = false; // Track if LMB is currently held down
    private dragStartMouse: THREE.Vector2 = new THREE.Vector2();
    private dragStartPosition: THREE.Vector3 = new THREE.Vector3();
    private dragStartGroundPoint: THREE.Vector3 = new THREE.Vector3(); // Initial ground intersection point
    private hasMovedWhileDragging: boolean = false;

    private isEditingInput: boolean = false;
    
    constructor(scene: THREE.Scene, camera: THREE.Camera, physicsWorld: any, domElement: HTMLElement, onHeightmapGenerated?: (heightmapData: HeightmapData) => void) {
        this.scene = scene;
        this.camera = camera;
        this.physicsWorld = physicsWorld;
        this.domElement = domElement;
        this.onHeightmapGenerated = onHeightmapGenerated || null;
        this.floorMeshManager = new FloorMeshColliderManager(scene, physicsWorld);
        
        this.raycaster = new THREE.Raycaster();
        // Only raycast against layer 0 (colliders) - exclude layer 1 (block characters)
        this.raycaster.layers.set(0);
        this.mouse = new THREE.Vector2();
        
        this.boundOnMouseDown = this.onMouseDown.bind(this);
        this.boundOnMouseUp = this.onMouseUp.bind(this);
        this.boundOnMouseMove = this.onMouseMove.bind(this);
        this.boundOnKeyDown = this.onKeyDown.bind(this);
        
        // Create voxel parent group (legacy support)
        this.voxelParent = new THREE.Group();
        this.voxelParent.name = 'VoxelColliders';
        this.voxelParent.visible = true;
        this.voxelParent.frustumCulled = false;
        this.scene.add(this.voxelParent);
        
        // Initialize a default VoxelWorld under the legacy key — lets existing
        // flows that touch `this.voxelWorld` before any splat is active keep
        // working. Per-splat worlds are created lazily on `setActiveVoxelWorld`.
        this.setActiveVoxelWorld(GaussianSplatEditor.LEGACY_VOXEL_KEY);
        
        // No global key binds visibility here any more. This editor is constructed in
        // PUBLISHED games too (GameEngine.ensureGaussianSplatEditor — it owns the splat's
        // colliders, which the game needs at runtime), so a keydown registered here reached
        // players, who have no reason to press V and every chance of doing it by accident.
        // The diagnostic moved to `?splats=` / `__bmDebug.setSplatViewMode` — engine/SplatViewMode.ts.
        
        // Ground plane is created lazily when editor is enabled
    }
    
    private setupGroundPlane(): void {
        if (this.ground) return; // Already created
        
        const groundGeometry = new THREE.PlaneGeometry(1000, 1000);
        const groundMaterial = new THREE.MeshBasicMaterial({ visible: false });
        this.ground = new THREE.Mesh(groundGeometry, groundMaterial);
        this.ground.name = 'GaussianSplatEditorGround';
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.position.y = 0;
        
        // Set ground to layer 0 (raycaster checks this layer)
        this.ground.layers.set(0);
    }
    
    private addGroundToScene(): void {
        if (this.ground && !this.ground.parent) {
            this.scene.add(this.ground);
        }
    }
    
    private removeGroundFromScene(): void {
        if (this.ground && this.ground.parent) {
            this.scene.remove(this.ground);
        }
    }
    
    setEnabled(enabled: boolean): void {
        if (enabled === this.isEnabled) return;

        this.isEnabled = enabled;

        if (enabled) {
            // Create and add ground plane for raycasting
            this.setupGroundPlane();
            this.addGroundToScene();

            // Entering editor mode (Collider tab)
            document.addEventListener('mousedown', this.boundOnMouseDown, true);
            document.addEventListener('mouseup', this.boundOnMouseUp, true);
            document.addEventListener('mousemove', this.boundOnMouseMove, true);
            document.addEventListener('keydown', this.boundOnKeyDown, true);
            this.setManualCollidersVisible(true);

            // Store current visibility state. Default to "Gaussians only"
            // (state 0) so opening the Splats tab doesn't flash every splat's
            // collider visualisation onscreen — the side panel's per-row
            // checkboxes drive voxel visibility from there, scoping it to
            // whichever splat the user is actually editing.
            this.previousVisibilityState = this.visibilityState;
            this.setVisibilityState(0);

            // Show voxels at full scale in editor mode
            if (this.voxelParent) {
                this.voxelParent.visible = true;
            }
            this.setVoxelsToFullScale();

            this.ui.show();
        } else {
            // Leaving editor mode (Collider tab)
            document.removeEventListener('mousedown', this.boundOnMouseDown, true);
            document.removeEventListener('mouseup', this.boundOnMouseUp, true);
            document.removeEventListener('mousemove', this.boundOnMouseMove, true);
            document.removeEventListener('keydown', this.boundOnKeyDown, true);
            this.setManualCollidersVisible(false);
            
            // Remove ground plane from scene when not in use
            this.removeGroundFromScene();
            
            // Restore previous visibility state
            this.setVisibilityState(this.previousVisibilityState);
            
            // Return voxels to wave effect control (only affects legacy voxels, not VoxelWorld)
            this.resetVoxelsForWaveEffect();
            
            this.ui.hide();
            this.selectedCollider = null;
            this.isDragging = false;
            this.isMouseButtonDown = false;
        }
    }
    
    private setVoxelsToFullScale(): void {
        // Editor mode: show all voxels at full scale
        this.colliders.forEach(collider => {
            const isVoxel = GaussianSplatEditor.isVoxelColliderId(collider.data.id);
            if (isVoxel) {
                collider.mesh.visible = true;
                collider.mesh.scale.set(1, 1, 1);
                if (collider.mesh.material instanceof THREE.MeshStandardMaterial) {
                    const m = collider.mesh.material as THREE.MeshStandardMaterial;
                    m.transparent = false;
                    m.opacity = 1.0;
                    m.depthWrite = true;
                    m.depthTest = true;
                    m.needsUpdate = true;
                }
            }
        });
    }
    
    private resetVoxelsForWaveEffect(): void {
        // Voxel wave effect is now handled by the game template, not the editor
    }
    
    isEditorEnabled(): boolean {
        return this.isEnabled;
    }

    /**
     * Set visibility state directly (0 = Gaussians only, 1 = Gaussians+Voxels, 2 = Voxels only)
     */
    private setVisibilityState(state: number): void {
        this.visibilityState = state;
        this.applyVisibilityState();
    }
    
    /**
     * Apply the current visibility state globally. Three states:
     *   0 = gaussians only, 1 = gaussians + colliders, 2 = colliders only.
     *
     * This is what the Splats panel and `?splats=` drive. It targets every splat renderer's
     * gaussian mesh, every per-splat VoxelWorld, the WorldGroup scenery
     * voxels, and any legacy box colliders — so the keypress is "everything
     * on / everything off" the way it always has been. Per-splat fine-grained
     * toggles live separately on `setSplatVisibilityByIndex`, driven from
     * the side-panel eye icons.
     */
    private applyVisibilityState(): void {
        const showGaussians = this.visibilityState === 0 || this.visibilityState === 1;
        const showActiveColliders = this.visibilityState === 1 || this.visibilityState === 2;

        if (this.getSplatRenderersCallback) {
            const renderers = this.getSplatRenderersCallback();
            if (renderers && Array.isArray(renderers)) {
                for (const renderer of renderers) {
                    if (renderer && typeof renderer.setSplatVisibility === 'function') {
                        renderer.setSplatVisibility(showGaussians);
                    }
                    if (renderer && typeof renderer.setColliderVisualizationVisible === 'function') {
                        renderer.setColliderVisualizationVisible(showActiveColliders);
                    }
                }
            }
        }
        if (this.splatVisibilityCallback) {
            this.splatVisibilityCallback(showGaussians);
        }

        // Per-splat VoxelWorlds + the legacy fallback grid in lock-step.
        for (const world of this.iterAllVoxelWorlds()) {
            world.setChunksVisible(showActiveColliders);
        }
        // Walkable-map overlay follows the voxel-collider channel — V cycles
        // both together so "voxels only" / "gaussians + voxels" both reveal
        // the walkable cells. The independent side-panel checkbox can override
        // this for finer control without rebuilding the BFS.
        this.pvsController?.setWalkableMapVisible(showActiveColliders);

        // Scenery voxels under WorldGroup (e.g. shadow voxels) follow the
        // same toggle.
        const worldGroup = this.scene.getObjectByName('WorldGroup');
        if (worldGroup) {
            for (const child of worldGroup.children) {
                if (typeof (child as { getVoxelData?: () => unknown }).getVoxelData === 'function') {
                    child.visible = showActiveColliders;
                }
            }
        }

        // Legacy per-id voxel colliders.
        this.colliders.forEach(collider => {
            const isVoxel = GaussianSplatEditor.isVoxelColliderId(collider.data.id);
            if (isVoxel) {
                collider.mesh.visible = showActiveColliders;
                if (showActiveColliders) collider.mesh.scale.set(1, 1, 1);
            }
        });

        const stateNames = ['Gaussians only', 'Gaussians + voxels', 'Voxels only'];
        console.log(`👁️ Visibility: ${stateNames[this.visibilityState]}`);
    }

    /**
     * Set visibility on a single splat. Used by the side-panel per-row eye
     * icons. Either flag may be omitted to leave that channel alone.
     */
    setSplatVisibilityByIndex(splatIndex: number, gaussians?: boolean, voxels?: boolean): boolean {
        const renderers = this.getSplatRenderersCallback?.() ?? null;
        if (!renderers || !Array.isArray(renderers)) return false;
        const renderer = renderers[splatIndex] ?? null;
        if (!renderer) return false;
        if (typeof gaussians === 'boolean' && typeof renderer.setSplatVisibility === 'function') {
            renderer.setSplatVisibility(gaussians);
        }
        if (typeof voxels === 'boolean') {
            if (typeof renderer.setColliderVisualizationVisible === 'function') {
                renderer.setColliderVisualizationVisible(voxels);
            }
            const w = typeof renderer.getVoxelWorld === 'function' ? renderer.getVoxelWorld() : null;
            if (w) w.setChunksVisible(voxels);
        }
        return true;
    }
    
    /**
     * Get the current visibility state (0 = Gaussians only, 1 = Gaussians + Voxels, 2 = Voxels only)
     */
    getVisibilityState(): number {
        return this.visibilityState;
    }
    
    private setManualCollidersVisible(visible: boolean): void {
        this.colliders.forEach(collider => {
            // Only set visibility for non-voxel colliders (voxels are controlled by parent group)
            const isVoxel = GaussianSplatEditor.isVoxelColliderId(collider.data.id);
            if (!isVoxel) {
                collider.mesh.visible = visible;
            }
        });
        
        if (this.heightmapMesh) {
            this.heightmapMesh.visible = visible;
        }
    }
    
    private onMouseDown(event: MouseEvent): void {
        if (!this.isEnabled) return;
        
        // Check if click is on UI elements - if so, don't process
        const target = event.target as HTMLElement;
        if (target.closest('#collider-editor-ui')) {
            return; // Let UI handle it
        }
        
        // Allow RMB to pass through for camera controls
        if (event.button === 2) {
            return; // Let camera handle it
        }
        
        // Mark that mouse button is down
        this.isMouseButtonDown = true;
        
        this.updateMousePosition(event);
        
        if (event.shiftKey) {
            // Shift+click creates collider - prevent camera from handling this
            event.stopPropagation();
            event.preventDefault();
            this.createColliderAtMouse();
        } else {
            // Check if clicking on a collider
            this.raycaster.setFromCamera(this.mouse, this.camera);
            const colliderMeshes = this.colliders.map(c => c.mesh);
            const intersects = this.raycaster.intersectObjects(colliderMeshes);
            
            if (intersects.length > 0 && intersects[0]) {
                // Clicked on a collider - select it (but don't prevent camera rotation yet)
                const selectedMesh = intersects[0].object as THREE.Mesh;
                const clickedCollider = this.colliders.find(c => c.mesh === selectedMesh) || null;
                
                this.selectedCollider = clickedCollider;
                this.updateColliderHighlights();
                this.ui.update();
                this.isDragging = false;
                this.hasMovedWhileDragging = false;
                
                // Store drag start position for potential dragging
                this.dragStartMouse.copy(this.mouse);
                if (this.selectedCollider) {
                    this.dragStartPosition.copy(this.selectedCollider.mesh.position);
                    
                    // Get initial ground intersection point for delta calculation
                    if (this.ground) {
                        this.raycaster.setFromCamera(this.mouse, this.camera);
                        const groundIntersects = this.raycaster.intersectObject(this.ground);
                        if (groundIntersects.length > 0 && groundIntersects[0]) {
                            this.dragStartGroundPoint.copy(groundIntersects[0].point);
                        }
                    }
                }
                
                // Don't prevent default - let camera controller also receive the event
                // We'll only prevent camera rotation if user starts dragging (small movement)
            } else {
                // Clicked on empty space - deselect and let camera handle it
                this.selectedCollider = null;
                this.updateColliderHighlights();
                this.ui.update();
                this.isDragging = false;
                this.hasMovedWhileDragging = false;
                // Don't prevent default - let camera controller handle it
            }
        }
    }
    
    private onMouseUp(event: MouseEvent): void {
        if (!this.isEnabled) return;
        
        // Allow RMB to pass through for camera controls
        if (event.button === 2) {
            return; // Let camera handle it
        }
        
        // NO DRAGGING - don't prevent default, let camera controller handle it
        // Mark that mouse button is released
        this.isMouseButtonDown = false;
        this.isDragging = false;
        this.hasMovedWhileDragging = false;
    }
    
    private onMouseMove(event: MouseEvent): void {
        if (!this.isEnabled) return;
        
        // NO DRAGGING - always let camera controller handle mouse movement
        // Just update mouse position for potential future use (like UI updates)
        this.updateMousePosition(event);
        
        // Don't prevent default or stop propagation - let camera rotate
    }
    
    private onKeyDown(event: KeyboardEvent): void {
        if (!this.isEnabled) return;

        if (event.key === 'Delete' && this.selectedCollider) {
            event.preventDefault();
            event.stopPropagation();
            this.deleteSelectedCollider();
        } else if ((event.key === 'r' || event.key === 'R') && this.selectedCollider) {
            event.preventDefault();
            event.stopPropagation();
            this.rotateSelectedCollider(1);
        } else if ((event.key === 't' || event.key === 'T') && this.selectedCollider) {
            event.preventDefault();
            event.stopPropagation();
            this.rotateSelectedCollider(-1);
        }
    }
    
    private rotateSelectedCollider(direction: number = 1): void {
        if (!this.selectedCollider) return;
        
        const step = (Math.PI / 36) * direction; // 5 degrees * direction
        const currentRotation = this.selectedCollider.data.rotation || 0;
        let newRotation = currentRotation + step;
        
        // Normalize to 0-2π range
        while (newRotation < 0) newRotation += Math.PI * 2;
        while (newRotation >= Math.PI * 2) newRotation -= Math.PI * 2;
        
        this.selectedCollider.data.rotation = newRotation;
        this.selectedCollider.mesh.rotation.y = newRotation;
        
        console.log(`Rotating collider from ${(currentRotation * 180 / Math.PI).toFixed(1)}° to ${(newRotation * 180 / Math.PI).toFixed(1)}°`);
        
        this.updatePhysicsBody(this.selectedCollider);
        this.ui.update();
    }
    
    private updateMousePosition(event: MouseEvent): void {
        // Use window dimensions instead of domElement rect (which can be 0x0 in some cases)
        this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    }
    
    private createColliderAtMouse(): void {
        if (!this.ground) return;
        
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObject(this.ground);
        
        if (intersects.length > 0 && intersects[0]) {
            const point = intersects[0].point;
            
            const colliderData: BoxColliderData = {
                id: this.generateId(),
                position: { x: Math.round(point.x * 20) / 20, y: 0.5, z: Math.round(point.z * 20) / 20 },
                scale: { x: 1, y: 1, z: 1 },
                rotation: 0
            };
            
            this.addCollider(colliderData);
            this.selectedCollider = this.colliders[this.colliders.length - 1] || null;
            this.updateColliderHighlights();
            this.ui.update();
            
            console.log('Created new collider:', colliderData);
        }
    }
    
    private addCollider(data: BoxColliderData): void {
        const geometry = new THREE.BoxGeometry(data.scale.x, data.scale.y, data.scale.z);
        
        // Voxel and merged colliders are opaque, manual colliders are transparent
        const isVoxel = GaussianSplatEditor.isVoxelColliderId(data.id);
        
        const color = data.color !== undefined ? data.color : 0x00ff00;
        
        const material = new THREE.MeshStandardMaterial({
            color: color,
            transparent: false, // Opaque by default to avoid sorting issues
            opacity: 1.0,
            wireframe: false,
            roughness: 0.8,
            metalness: 0.0,
            emissive: isVoxel ? color : 0x000000,
            emissiveIntensity: isVoxel ? 0.2 : 0,
            depthWrite: true
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(data.position.x, data.position.y, data.position.z);
        mesh.rotation.y = data.rotation || 0;
        
        // Voxels: always set mesh.visible=true, parent group controls visibility
        // Non-voxels: hidden by default, shown only when editor is enabled
        if (isVoxel) {
            mesh.visible = true; // Parent group controls visibility
        } else {
            mesh.visible = this.isEnabled;
        }
        
        // Explicitly set collider to layer 0 (raycaster checks this layer)
        mesh.layers.set(0);
        
        // Disable frustum culling for voxels (they scale 0-1, need to always be considered)
        if (isVoxel) {
            mesh.frustumCulled = false;
        }
        
        // Add voxels to parent group, other colliders directly to scene
        if (isVoxel && this.voxelParent) {
            this.voxelParent.add(mesh);
            
            // Populate occupancy grid for all covered cells of this AABB
            const s = this.currentVoxelSize || 0.4;
            const half = new THREE.Vector3(data.scale.x / 2, data.scale.y / 2, data.scale.z / 2);
            const aabbMin = new THREE.Vector3(data.position.x - half.x, data.position.y - half.y, data.position.z - half.z);
            const aabbMax = new THREE.Vector3(data.position.x + half.x, data.position.y + half.y, data.position.z + half.z);
            
            const ix0 = Math.floor((aabbMin.x - this.gridOrigin.x) / s);
            const iy0 = Math.floor((aabbMin.y - this.gridOrigin.y) / s);
            const iz0 = Math.floor((aabbMin.z - this.gridOrigin.z) / s);
            const ix1 = Math.floor((aabbMax.x - this.gridOrigin.x) / s);
            const iy1 = Math.floor((aabbMax.y - this.gridOrigin.y) / s);
            const iz1 = Math.floor((aabbMax.z - this.gridOrigin.z) / s);
            
            for (let ix = ix0; ix <= ix1; ix++) {
                for (let iy = iy0; iy <= iy1; iy++) {
                    for (let iz = iz0; iz <= iz1; iz++) {
                        this.voxelCellSet.add(`${ix},${iy},${iz}`);
                    }
                }
            }
        } else {
            this.scene.add(mesh);
        }
        
        const body = this.createPhysicsBody(data);
        
        this.colliders.push({ data, mesh, body });
    }
    
    private createPhysicsBody(data: BoxColliderData): RAPIER.RigidBody | null {
        const RAPIER = getRapier();
        if (!RAPIER) {
            console.warn('[GaussianSplatEditor] Rapier not initialized');
            return null;
        }

        const rapierWorld = this.physicsWorld.getWorld?.();
        if (!rapierWorld) {
            console.warn('[GaussianSplatEditor] Physics world not available');
            return null;
        }

        // Create quaternion from Y-axis rotation
        const euler = new THREE.Euler(0, data.rotation || 0, 0);
        const quat = new THREE.Quaternion().setFromEuler(euler);

        // Create static rigid body
        const bodyDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(data.position.x, data.position.y, data.position.z)
            .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
        const body = rapierWorld.createRigidBody(bodyDesc);

        // Create box collider with half extents
        const colliderDesc = RAPIER.ColliderDesc.cuboid(
            data.scale.x / 2,
            data.scale.y / 2,
            data.scale.z / 2
        );
        colliderDesc.setFriction(0.8);
        colliderDesc.setRestitution(0.2);
        rapierWorld.createCollider(colliderDesc, body);

        return body;
    }
    
    private updateColliderHighlights(): void {
        this.colliders.forEach(collider => {
            const isVoxel = GaussianSplatEditor.isVoxelColliderId(collider.data.id);

            // Don't change voxel/merged colors - they use their own colors
            if (isVoxel) return;
            
            const material = collider.mesh.material as THREE.MeshStandardMaterial;
            if (collider === this.selectedCollider) {
                material.color.setHex(0xffff00);
                material.opacity = 0.5;
            } else {
                material.color.setHex(0x00ff00);
                material.opacity = 0.3;
            }
        });
    }
    
    private removePhysicsBody(body: RAPIER.RigidBody | null): void {
        if (!body) return;
        const rapierWorld = this.physicsWorld.getWorld?.();
        if (rapierWorld) {
            rapierWorld.removeRigidBody(body);
        }
    }

    private clearAllColliders(): void {
        console.log(`Clearing ${this.colliders.length} colliders and ${this.floorMeshManager.getCount()} floor meshes...`);
        
        this.colliders.forEach(collider => {
            // Remove from parent or scene
            if (collider.mesh.parent) {
                collider.mesh.parent.remove(collider.mesh);
            } else {
                this.scene.remove(collider.mesh);
            }
            collider.mesh.geometry.dispose();
            (collider.mesh.material as THREE.Material).dispose();
            
            // Remove physics body - Rapier handles cleanup automatically
            this.removePhysicsBody(collider.body);
        });
        
        // Clear floor mesh colliders
        this.floorMeshManager.clearAll();
        
        this.colliders = [];
        this.selectedCollider = null;
        console.log('✅ All colliders cleared');
    }
    
    private clearVoxelColliders(): void {
        const isVoxel = GaussianSplatEditor.isVoxelColliderId;
        const voxelColliders = this.colliders.filter(c => isVoxel(c.data.id));
        const manualColliders = this.colliders.filter(c => !isVoxel(c.data.id));
        
        console.log(`Clearing ${voxelColliders.length} voxel colliders (keeping ${manualColliders.length} manual colliders)...`);
        
        voxelColliders.forEach(collider => {
            // Remove from parent or scene
            if (collider.mesh.parent) {
                collider.mesh.parent.remove(collider.mesh);
            } else {
                this.scene.remove(collider.mesh);
            }
            collider.mesh.geometry.dispose();
            (collider.mesh.material as THREE.Material).dispose();
            
            // Remove physics body - Rapier handles cleanup automatically
            this.removePhysicsBody(collider.body);
        });
        
        // Keep only manual colliders
        this.colliders = manualColliders;
        
        // Clear selection if it was a voxel
        if (this.selectedCollider && isVoxel(this.selectedCollider.data.id)) {
            this.selectedCollider = null;
        }
        
        console.log(`✅ Voxel colliders cleared, ${this.colliders.length} manual colliders preserved`);
    }
    
    private deleteSelectedCollider(): void {
        if (!this.selectedCollider) return;
        
        const index = this.colliders.indexOf(this.selectedCollider);
        if (index >= 0) {
            const collider = this.colliders[index];
            if (!collider) return;
            
            // Remove from parent or scene
            if (collider.mesh.parent) {
                collider.mesh.parent.remove(collider.mesh);
            } else {
                this.scene.remove(collider.mesh);
            }
            collider.mesh.geometry.dispose();
            (collider.mesh.material as THREE.Material).dispose();
            
            // Remove physics body - Rapier handles cleanup automatically
            this.removePhysicsBody(collider.body);
            
            this.colliders.splice(index, 1);
            this.selectedCollider = null;
            this.ui.update();
            
            console.log('Deleted collider');
            this.saveColliders();
        }
    }
    
    updateSelectedColliderPosition(axis: 'x' | 'y' | 'z', value: number): void {
        if (!this.selectedCollider) return;
        
        const snapped = Math.round(value * 20) / 20; // 0.05 unit increments
        this.selectedCollider.data.position[axis] = snapped;
        this.selectedCollider.mesh.position[axis] = snapped;
        
        this.updatePhysicsBody(this.selectedCollider);
    }
    
    updateSelectedColliderScale(axis: 'x' | 'y' | 'z', value: number): void {
        if (!this.selectedCollider) return;
        
        const snapped = Math.max(0.25, Math.round(value * 4) / 4);
        this.selectedCollider.data.scale[axis] = snapped;
        
        // Rebuild geometry with new scale
        this.selectedCollider.mesh.geometry.dispose();
        this.selectedCollider.mesh.geometry = new THREE.BoxGeometry(
            this.selectedCollider.data.scale.x,
            this.selectedCollider.data.scale.y,
            this.selectedCollider.data.scale.z
        );
        
        this.updatePhysicsBody(this.selectedCollider);
    }
    
    private updatePhysicsBody(collider: { data: BoxColliderData; mesh: THREE.Mesh; body: any }): void {
        // Remove old physics body - Rapier handles cleanup automatically
        this.removePhysicsBody(collider.body);
        
        // Create new physics body with updated transform
        collider.body = this.createPhysicsBody(collider.data);
        
        // Ensure mesh stays visible if editor is enabled
        if (this.isEnabled) {
            collider.mesh.visible = true;
        }
    }
    
    setSplatTransform(position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3): void {
        this.splatTransform = { position, rotation, scale };
    }
    
    setSplatVisibilityCallback(callback: (visible: boolean) => void): void {
        this.splatVisibilityCallback = callback;
    }

    setLoadTestSplatCallback(callback: (url: string) => Promise<void>): void {
        this.loadTestSplatCallback = callback;
    }

    setSplatTransformChangeCallback(callback: (transform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }) => void): void {
        this.splatTransformChangeCallback = callback;
    }

    /** The env-object id of the currently active splat. */
    private activeEnvObjectId: string | null = null;

    /** Set by callers (SET_ACTIVE_SPLAT) when switching splats. */
    setActiveEnvObjectId(id: string | null): void {
        this.activeEnvObjectId = id;
        // Swap the editor's voxelWorld pointer onto the active splat's instance.
        // Other splats' VoxelWorlds remain alive in physicsWorld so all per-splat
        // colliders stay active simultaneously.
        this.setActiveVoxelWorld(id ?? GaussianSplatEditor.LEGACY_VOXEL_KEY);
    }

    /**
     * Find the GaussianSplatRenderer for an env-object id (the canonical owner
     * of that splat's VoxelWorld + bounds). Returns null for the legacy key
     * or when no matching renderer is registered.
     */
    private findRendererByEnvId(key: string): { ensureVoxelWorld: (voxelSize?: number) => VoxelWorld; getVoxelWorld: () => VoxelWorld | null; getVoxelWorldBoundsRaw: () => { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number } | null; setVoxelWorldBoundsRaw: (b: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number } | null) => void; getEnvObjectId: () => string | null } | null {
        if (key === GaussianSplatEditor.LEGACY_VOXEL_KEY) return null;
        if (!this.getSplatRenderersCallback) return null;
        const renderers = this.getSplatRenderersCallback() as any[] | null;
        if (!renderers) return null;
        for (const r of renderers) {
            if (r && typeof r.getEnvObjectId === 'function' && r.getEnvObjectId() === key) {
                return r;
            }
        }
        return null;
    }

    /**
     * Lazily get-or-create the per-splat VoxelWorld. Ownership lives on the
     * GaussianSplatRenderer for that env id, so the editor delegates rather
     * than holding the instance itself. The legacy/no-renderer case still
     * needs *something* to write into — that uses a fallback grid owned by
     * the editor.
     */
    private ensureVoxelWorldForKey(key: string, voxelSize?: number): VoxelWorld {
        const renderer = this.findRendererByEnvId(key);
        if (renderer) {
            return renderer.ensureVoxelWorld(voxelSize);
        }
        // No renderer registered yet (e.g. very early init or legacy
        // worldProfileData.voxelUrl path). Use a single fallback grid so the
        // editor's `this.voxelWorld` pointer always has somewhere to point.
        if (!this.fallbackVoxelWorld) {
            this.fallbackVoxelWorld = new VoxelWorld(isPlaneLockedPhysics(this.physicsWorld) ? null : this.physicsWorld, this.scene, {
                voxelSize: voxelSize ?? this.currentVoxelSize,
            });
        } else if (voxelSize !== undefined && Math.abs(this.fallbackVoxelWorld.getVoxelSize() - voxelSize) > 1e-6) {
            this.fallbackVoxelWorld.setVoxelSize(voxelSize);
        }
        return this.fallbackVoxelWorld;
    }

    /** Point `this.voxelWorld` and `this.voxelWorldBounds` at the given splat's owned grid. */
    private setActiveVoxelWorld(key: string): void {
        this.voxelWorld = this.ensureVoxelWorldForKey(key);
        const renderer = this.findRendererByEnvId(key);
        this.voxelWorldBounds = renderer ? renderer.getVoxelWorldBoundsRaw() : null;
    }

    /**
     * Persist the current voxelWorld's bounds back to the renderer that owns
     * it. Called after voxelization or after loading a .vxl file. Splats with
     * no renderer (legacy path) keep their bounds on the editor's pointer.
     */
    private rememberCurrentVoxelBounds(): void {
        if (!this.voxelWorldBounds) return;
        const key = this.activeEnvObjectId ?? GaussianSplatEditor.LEGACY_VOXEL_KEY;
        const renderer = this.findRendererByEnvId(key);
        if (renderer) renderer.setVoxelWorldBoundsRaw(this.voxelWorldBounds);
    }

    /**
     * Iterate every per-splat VoxelWorld currently registered (one per
     * GaussianSplatRenderer). Used by editor-only flows that toggle every
     * splat's visualisation in lock-step (visibility checkboxes, `?splats=`).
     */
    private *iterAllVoxelWorlds(): Generator<VoxelWorld> {
        const renderers = this.getSplatRenderersCallback?.() as any[] | null;
        if (renderers) {
            for (const r of renderers) {
                const w = typeof r?.getVoxelWorld === 'function' ? r.getVoxelWorld() : null;
                if (w) yield w;
            }
        }
        if (this.fallbackVoxelWorld) yield this.fallbackVoxelWorld;
    }

    private getActiveEnvObjectId(): string | null {
        // Prefer explicitly-set value; fall back to the active renderer's id.
        if (this.activeEnvObjectId) return this.activeEnvObjectId;
        if (!this.getSplatRenderersCallback) return null;
        const renderers = this.getSplatRenderersCallback();
        const r = renderers?.[0];
        return (r && typeof r.getEnvObjectId === 'function') ? (r.getEnvObjectId() ?? null) : null;
    }


    /**
     * Find the env-object that owns the given splat URL by looking up the asset
     * (matching `assets[].url`), then the env-object referencing that asset.
     * Used to route a renderer's loadColliders call to the correct per-splat
     * VoxelWorld even before SET_ACTIVE_SPLAT has fired.
     */
    private findEnvObjectIdForSplatUrl(gameData: any, splatUrl: string): string | null {
        const assets = gameData?.assets as Array<{ id?: string; url?: string }> | undefined;
        const envs = gameData?.environmentObjects as Array<{ id?: string; assetId?: string; assetUrl?: string }> | undefined;
        if (!assets || !envs) return null;
        const asset = assets.find(a => a?.url === splatUrl);
        if (!asset?.id) {
            const env = envs.find(e => e?.assetUrl === splatUrl);
            return env?.id ?? null;
        }
        const env = envs.find(e => e?.assetId === asset.id);
        return env?.id ?? null;
    }

    setSplatUrl(splatUrl: string): void {
        const filename = this.extractFilename(splatUrl);
        this.splatFilename = filename;
        this.splatUrl = splatUrl;
        console.log(`✅ Splat URL set for voxelization: ${filename}`);
    }

    async loadColliders(splatUrl: string): Promise<void> {
        const filename = this.extractFilename(splatUrl);
        const isNewSplat = this.splatFilename !== filename; // Check if this is a new splat or reload
        
        // Reset visibility state to "Gaussians only" (0) when loading a new world
        // But retain current state when reloading the same world
        if (isNewSplat) {
            this.visibilityState = 0;
            this.previousVisibilityState = 0;
            this.applyVisibilityState();
        }
        
        this.splatFilename = filename;
        this.splatUrl = splatUrl; // Store full URL for voxelization

        let vxlLoaded = false;
        let jsonLoaded = false;
        
        // Get game data from callback
        const gameData = this.getGameDataCallback?.() || null;

        // Each splat owns its own VoxelWorld on the renderer. Switch the
        // editor's active pointer to that renderer's grid so editor flows
        // (visibility cycle, voxelisation tool, save) operate on the correct one.
        // The actual load already happened in
        // GaussianSplatRenderer.loadVoxelColliders — so the editor doesn't
        // re-fetch the .vxl here. Keeps the runtime path editor-independent.
        const envIdForUrl = this.findEnvObjectIdForSplatUrl(gameData, splatUrl);
        if (envIdForUrl) {
            this.setActiveVoxelWorld(envIdForUrl);
        }
        const renderer = envIdForUrl ? this.findRendererByEnvId(envIdForUrl) : null;
        if (renderer && (renderer.getVoxelWorld()?.getChunkCount() ?? 0) > 0) {
            vxlLoaded = true;
        }
        // No legacy worldProfileData.voxelUrl fallback — splat voxel
        // colliders only ever live on the env-object now.
                            
        // Load floor meshes from per-splat floorMeshUrl (falls back to global)
        const floorMeshUrl = getFloorMeshUrlFromGameData(gameData, this.splatUrl || undefined);
        if (floorMeshUrl) {
            await this.floorMeshManager.loadFromUrl(floorMeshUrl);
        }
        
        // Load manual colliders from S3 URL stored in gameData
        const colliderUrl = getColliderUrlFromGameData(gameData);
        if (colliderUrl) {
            try {
                console.log(`🔍 Loading manual colliders from S3: ${colliderUrl}`);
                const response = await fetch(colliderUrl);
                if (response.ok) {
                    const data: ColliderFileData = await response.json();
                    await this.processLoadedColliders(data, true);
                    jsonLoaded = true;
                    console.log(`✅ Loaded manual colliders from S3`);
                }
            } catch (error) {
                console.warn(`⚠️ Failed to load manual colliders from S3:`, error);
            }
        }
        
        // Both files are optional, so no warning if neither exists
        if (vxlLoaded || jsonLoaded) {
            console.log(`✅ Collider loading complete (voxels: ${vxlLoaded ? 'yes' : 'no'}, colliders: ${jsonLoaded ? 'yes' : 'no'})`);
        }
        
        // Ensure visibility state is applied after all loading is complete
        // This handles cases where voxels might have been loaded/generated
        this.applyVisibilityState();
    }
    
    private async processLoadedColliders(data: ColliderFileData, skipVoxelColliders: boolean = false): Promise<void> {
        console.log(`   Collider data:`, data);
        
        if (data.colliders.length === 0) {
            console.warn(`⚠️ Collider file exists but contains 0 colliders`);
        }

        // Load voxel size if it exists
        // Only use JSON file voxel size if we don't already have a voxel size from a .vxl file
        // The .vxl file is the source of truth for voxel size (it's saved with the voxels)
        if (data.voxelSize && !this.currentVoxelSize) {
            this.currentVoxelSize = data.voxelSize;
        }
        
        // Load floor mesh colliders if they exist
        if (data.meshColliders && data.meshColliders.length > 0) {
            console.log(`   Loading ${data.meshColliders.length} floor mesh colliders...`);
            for (const meshData of data.meshColliders) {
                this.floorMeshManager.createFloorMeshCollider(meshData);
            }
        }
        
        // Filter out voxel colliders if requested (when loading manual colliders separately)
        const collidersToAdd = skipVoxelColliders
            ? data.colliders.filter(c => !GaussianSplatEditor.isVoxelColliderId(c.id || ''))
            : data.colliders;
        
        console.log(`📦 Adding ${collidersToAdd.length} colliders to scene${skipVoxelColliders ? ' (manual colliders only)' : ''}...`);
        const colliderCountBefore = this.colliders.length;
        
        collidersToAdd.forEach((colliderData, index) => {
            // Ensure rotation field exists (backwards compatibility)
            if (colliderData.rotation === undefined) {
                colliderData.rotation = 0;
            }
            console.log(`   Adding collider ${index + 1}/${collidersToAdd.length}: ${colliderData.id} at (${colliderData.position.x}, ${colliderData.position.y}, ${colliderData.position.z})`);
            this.addCollider(colliderData);
        });
        
        const colliderCountAfter = this.colliders.length;
        console.log(`✅ Colliders added: ${colliderCountBefore} → ${colliderCountAfter} (added ${colliderCountAfter - colliderCountBefore})`);

        // Initialize voxels for wave effect (hidden, revealed by projectile impacts)
        // Only if we're not skipping voxel colliders (they're handled by VoxelWorld)
        if (!skipVoxelColliders) {
            this.resetVoxelsForWaveEffect();
            
            // Refresh AABBs for all voxel bodies to ensure broadphase correctness far from origin
            this.colliders.forEach(c => {
                const isVoxel = GaussianSplatEditor.isVoxelColliderId(c.data.id);
                if (isVoxel && c.body) {
                    c.body.activate(true);
                    this.physicsWorld.updateSingleAabb(c.body);
                }
            });
        }
        
        // Update UI to reflect loaded colliders
        this.updateColliderHighlights();
        this.ui.update();
        
        // Load heightmap if it exists
        if (data.heightmap) {
            console.log(`🗺️ Heightmap found in collider file`);
            this.loadHeightmap(data.heightmap);
        }
    }
    
    private loadHeightmap(heightmapData: HeightmapData): void {
        this.heightmapData = heightmapData;
        // Only create visualization in editor - physics is handled by WorldGenerator
        this.createHeightmapVisualization();
        console.log(`✅ Heightmap loaded: ${heightmapData.width}x${heightmapData.height} samples`);
    }
    
    async generateVoxelColliders(): Promise<void> {
        // Show progress dialog IMMEDIATELY
        const progressModal = createProgressModal('Generating Voxel Colliders for Splat');
        updateProgressModal(progressModal, 0, 'Preparing...');

        // Get splat renderers to read current transforms directly
        if (!this.getSplatRenderersCallback) {
            console.error('❌ Cannot get splat renderers - callback not set');
            closeProgressModal(progressModal);
            alert('❌ Cannot generate voxels: Splat renderers not available');
            return;
        }

        const allRenderers = this.getSplatRenderersCallback();
        if (!allRenderers || allRenderers.length === 0) {
            console.error('❌ No splat renderers found');
            closeProgressModal(progressModal);
            alert('❌ Cannot generate voxels: No splats in scene');
            return;
        }

        // Voxelize ONLY the active splat. Each splat is voxelized independently
        // with its own voxel size — the result is saved per-splat to the env
        // object's voxelUrl/voxelSize so the runtime can load each splat's
        // colliders separately.
        const activeId = this.getActiveEnvObjectId();
        const activeRenderer = activeId
            ? allRenderers.find((r: any) => typeof r.getEnvObjectId === 'function' && r.getEnvObjectId() === activeId)
            : (allRenderers[0] ?? null);
        if (!activeRenderer) {
            closeProgressModal(progressModal);
            alert('❌ Cannot generate voxels: no active splat. Pick a splat in the Splats tab first.');
            return;
        }
        const renderers = [activeRenderer];

        // Make sure the editor pointer matches the splat being voxelised, so
        // results land in this splat's per-instance VoxelWorld and don't
        // disturb other splats' already-built voxel colliders.
        this.setActiveVoxelWorld(activeId ?? GaussianSplatEditor.LEGACY_VOXEL_KEY);
        
        try {
            updateProgressModal(progressModal, 5, 'Loading world data...');

        if (!this.getGameDataCallback) {
            closeProgressModal(progressModal);
            throw new Error('Game data callback not available');
        }
        const gameData = this.getGameDataCallback();

        // Resolve splat config per renderer from env-objects + assets.
        const envs: any[] = Array.isArray(gameData?.environmentObjects) ? gameData.environmentObjects : [];
        const assets: any[] = Array.isArray(gameData?.assets) ? gameData.assets : [];
        const assetById = new Map<string, any>();
        for (const a of assets) {
            if (a?.id) assetById.set(a.id, a);
        }
        const envById = new Map<string, any>();
        for (const e of envs) {
            if (e?.id) envById.set(e.id, e);
        }

        updateProgressModal(progressModal, 10, 'Reading splat transforms...');

        // Build splat data using LIVE transforms from renderers, URLs/bounds from env-objects (or assets).
        const allSplats: Array<{
            url: string;
            position: { x: number; y: number; z: number };
            eulerAngles: { x: number; y: number; z: number };
            scale: { x: number; y: number; z: number };
            bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null;
            untransformedBounds?: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null;
            cropBounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null;
        }> = [];
        for (let i = 0; i < renderers.length; i++) {
            const renderer = renderers[i];
            const envObjectId: string | null = typeof renderer.getEnvObjectId === 'function' ? renderer.getEnvObjectId() : null;
            const env = envObjectId ? envById.get(envObjectId) : null;
            const asset = env?.assetId ? assetById.get(env.assetId) : null;
            const url = renderer.getSplatUrl?.() || asset?.url || env?.assetUrl;
            if (!url) {
                console.error(`❌ Splat ${i + 1}: cannot resolve URL (envObjectId=${envObjectId})`);
                closeProgressModal(progressModal);
                alert(`❌ Cannot generate voxels: splat ${i + 1} has no URL`);
                return;
            }

            const pos = renderer.getPosition();
            const rot = renderer.getRotation();
            const scl = renderer.getScale();

            // Bounds priority: env.bounds > asset.boundingBox (computed at upload) > calculate-bounds API.
            let bounds = (env?.bounds as any) || (asset?.boundingBox as any) || null;

            if (!bounds) {
                console.log(`[Bounds] Splat ${i + 1} missing bounds, calculating from splat file...`);
                updateProgressModal(progressModal, 10 + i, `Calculating bounds for splat ${i + 1}...`);
                try {
                    const boundsResponse = await fetch(`${getAgentUrl()}/api/splats/calculate-bounds`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            splatUrl: url,
                            transform: {
                                position: { x: pos.x, y: pos.y, z: pos.z },
                                rotation: { x: rot.x, y: rot.y, z: rot.z },
                                scale: { x: scl.x, y: scl.y, z: scl.z }
                            }
                        })
                    });
                    if (boundsResponse.ok) {
                        const boundsData = await boundsResponse.json();
                        if (boundsData.success && boundsData.bounds) {
                            bounds = boundsData.bounds;
                            console.log(`[Bounds] ✅ Calculated bounds for splat ${i + 1}`);
                        } else {
                            const errorMsg = boundsData.error || 'Unknown error calculating bounds';
                            throw new Error(`Splat ${i + 1} bounds calculation failed: ${errorMsg}`);
                        }
                    } else {
                        const errorText = await boundsResponse.text();
                        throw new Error(`Splat ${i + 1} bounds API failed (${boundsResponse.status}): ${errorText}`);
                    }
                } catch (error) {
                    console.error(`[Bounds] ❌ Failed to calculate bounds for splat ${i + 1}:`, error);
                    closeProgressModal(progressModal);
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    alert(`❌ Cannot voxelize: Failed to calculate bounds for splat ${i + 1}\n\nURL: ${url}\n\nError: ${errorMsg}\n\nThe splat file may be invalid or corrupted, or the format (.sog) may not be supported by the bounds calculator.`);
                    return;
                }
            }

            allSplats.push({
                url,
                position: { x: pos.x, y: pos.y, z: pos.z },
                eulerAngles: { x: rot.x, y: rot.y, z: rot.z },
                scale: { x: scl.x, y: scl.y, z: scl.z },
                bounds,
                untransformedBounds: (env?.untransformedBounds as any) || (asset?.untransformedBounds as any) || null,
                // User-defined collider crop box in untransformed/SPZ-local
                // coords. The voxeliser uses this to skip far-away noise
                // gaussians so collider voxels only land where the subject is.
                cropBounds: (asset?.cropBounds as any) ?? null,
            });

            console.log(`[SPLAT] Splat ${i + 1} for voxelization: pos=(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}) envObjectId=${envObjectId}`);
        }
            
            // Voxelization can't self-save: saving writes game/src/work/world.json,
            // which tsc-watch sees and broadcasts /trigger-reload → RELOAD_IFRAME.
            // That reload tears down the SSE EventSource ~30 ms after the first
            // progress event (`skipReload: true` only suppresses the agent's own
            // recordWrite hook, not tsc-watch's independent fs watcher). The
            // creator-side Voxelize button is greyed out while transformsDirty
            // is true so the user can't reach this branch; this alert is just
            // a defensive check.
            if (this.transformsDirty) {
                closeProgressModal(progressModal);
                alert('❌ Splat transforms have unsaved changes. Click "Save Splat Settings" first, wait for the save to complete, then voxelize.');
                return;
            }
            
        if (allSplats.length === 0) {
            console.error('❌ No splats in level');
                closeProgressModal(progressModal);
            alert('❌ Cannot generate voxels: No splats found in level');
            return;
        }
        
        console.log(`🧊 Voxelizing ${allSplats.length} splat(s) for entire level...`);
        
        // Voxel size: side panel calls setCurrentVoxelSize() before invoking
        // this method; the legacy floating UI input no longer exists.
        const voxelSize = this.currentVoxelSize > 0 ? this.currentVoxelSize : 0.4;
        
            updateProgressModal(progressModal, 20, 'Starting voxelization...');
        
            // Clear existing physics before starting voxelization
            this.clearVoxelColliders();
            if (this.voxelWorld) {
                this.voxelWorld.clear();
            }
            
            // Initialize combined bounds
            let combinedBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null = null;
            let totalVoxels = 0;
            let totalChunks = 0;
            
            // Calculate combined bounds from stored bounds in world.json
            for (let i = 0; i < allSplats.length; i++) {
                const splat = allSplats[i]!;
                const splatBounds = splat.bounds;
                
                if (!splatBounds) {
                    // This should never happen since we now fail early during bounds calculation
                    throw new Error(`Splat ${i + 1} has no bounds - this indicates a bug in the bounds calculation flow`);
                }
                
                if (!combinedBounds) {
                    combinedBounds = { ...splatBounds };
                } else {
                    combinedBounds.minX = Math.min(combinedBounds.minX, splatBounds.minX);
                    combinedBounds.minY = Math.min(combinedBounds.minY, splatBounds.minY);
                    combinedBounds.minZ = Math.min(combinedBounds.minZ, splatBounds.minZ);
                    combinedBounds.maxX = Math.max(combinedBounds.maxX, splatBounds.maxX);
                    combinedBounds.maxY = Math.max(combinedBounds.maxY, splatBounds.maxY);
                    combinedBounds.maxZ = Math.max(combinedBounds.maxZ, splatBounds.maxZ);
                }
            }
            
            // Set final bounds ONCE before placing any voxels
            if (this.voxelWorld) {
                this.voxelWorldBounds = combinedBounds;
                this.voxelWorld.setBounds(combinedBounds);
            }
            
            // Process each splat and place voxels using the final bounds
            for (let i = 0; i < allSplats.length; i++) {
                const splat = allSplats[i]!;
                const splatFilename = this.extractFilename(splat.url);
                // Use default scale of (3, 3, 3) to match GaussianSplatRenderer default
                // This ensures voxelization matches the visual representation
                const transform = {
                    position: splat.position || { x: 0, y: 0, z: 0 },
                    rotation: splat.eulerAngles ? {
                        x: splat.eulerAngles.x || 0,
                        y: splat.eulerAngles.y || 0,
                        z: splat.eulerAngles.z || 0
                    } : { x: 0, y: 0, z: 0 },
                    scale: splat.scale || { x: 3, y: 3, z: 3 }
                };
                
                updateProgressModal(progressModal, Math.floor((i / allSplats.length) * 90), `Processing splat ${i + 1}/${allSplats.length}: ${splatFilename}`);
                
                // Call API for this splat
                const params = new URLSearchParams({
                    splatFilename: splatFilename,
                    splatUrl: splat.url,
                    voxelSize: voxelSize.toString(),
                    opacityThreshold: this.currentOpacityThreshold.toString(),
                    voxelizeMode: this.currentVoxelizeMode,
                    transform: JSON.stringify(transform)
                });
                
                // Pass untransformed bounds if available to skip expensive bounds calculation
                if (splat.untransformedBounds) {
                    params.set('untransformedBounds', JSON.stringify(splat.untransformedBounds));
                }

                // User-defined collider crop in untransformed/SPZ-local coords.
                // When present, the server skips gaussians outside this box —
                // voxels only land where the subject is, ignoring background
                // noise that would otherwise produce stray colliders far away.
                if (splat.cropBounds) {
                    params.set('cropBounds', JSON.stringify(splat.cropBounds));
                    console.log(`[VoxelGen] Using cropBounds for splat ${i + 1}:`, splat.cropBounds);
                }
                
                const voxelStreamUrl = `${getAgentUrl()}/api/voxel-generation/stream?${params}`;
                console.log(`[VoxelGen] POST ${voxelStreamUrl}`);
                const result = await new Promise<any>((resolve, reject) => {
                    const eventSource = new EventSource(voxelStreamUrl);
                    let hasReceivedAnyEvent = false;
                    let lastEventAt = 0;
                    const eventLog: Array<{ t: number; type: string; dataBytes: number }> = [];
                    const startedAt = performance.now();

                    eventSource.addEventListener('progress', (event) => {
                        hasReceivedAnyEvent = true;
                        lastEventAt = performance.now();
                        const messageEvent = event as MessageEvent;
                        eventLog.push({ t: Math.round(lastEventAt - startedAt), type: 'progress', dataBytes: messageEvent.data?.length ?? 0 });
                        try {
                            const data = JSON.parse(messageEvent.data);
                            const baseProgress = (i / allSplats.length) * 90;
                            const splatProgress = (data.progress / 100) * (90 / allSplats.length);
                            updateProgressModal(progressModal, Math.floor(baseProgress + splatProgress), `Splat ${i + 1}/${allSplats.length}: ${data.message}`);
                        } catch (e) {
                            console.warn('Failed to parse progress event:', e);
                        }
                    });

                    eventSource.addEventListener('complete', (event) => {
                        const messageEvent = event as MessageEvent;
                        const dataBytes = messageEvent.data?.length ?? 0;
                        eventLog.push({ t: Math.round(performance.now() - startedAt), type: 'complete', dataBytes });
                        console.log(`[VoxelGen] complete event received, ${dataBytes} bytes`);
                        try {
                            const data = JSON.parse(messageEvent.data);
                            eventSource.close();
                            resolve(data.result);
                        } catch (e) {
                            eventSource.close();
                            console.error('[VoxelGen] complete event JSON parse failed', { firstChars: messageEvent.data?.slice(0, 200), lastChars: messageEvent.data?.slice(-200) });
                            reject(new Error(`Failed to parse complete event (${dataBytes} bytes): ${e instanceof Error ? e.message : String(e)}`));
                        }
                    });

                    eventSource.addEventListener('error', async (event: Event) => {
                        const messageEvent = event as MessageEvent;
                        // EventSource fires `error` with no payload on connection-level
                        // failures (network down, server unreachable, CORS, 4xx/5xx
                        // status, URL too long, lock busy returning JSON 409). Log
                        // the readyState + URL + whether we ever saw any event so
                        // the user can diagnose from DevTools.
                        const stateNames = ['CONNECTING', 'OPEN', 'CLOSED'];
                        const readyState = stateNames[eventSource.readyState] ?? `unknown(${eventSource.readyState})`;
                        const sinceLastEventMs = lastEventAt > 0 ? Math.round(performance.now() - lastEventAt) : null;
                        console.error('[VoxelGen] EventSource error', {
                            url: voxelStreamUrl,
                            urlLength: voxelStreamUrl.length,
                            readyState,
                            hasReceivedAnyEvent,
                            sinceLastEventMs,
                            eventLog,
                            eventData: messageEvent?.data ?? null,
                        });

                        // EventSource swallows the response body for non-200 statuses,
                        // so re-fetch the same URL to surface what the server actually
                        // said — most useful when the lock is busy (409 JSON) or the
                        // URL is misrouted (404). Skip when we already saw events
                        // (the stream opened fine and broke mid-flight, server body
                        // is moot in that case).
                        let probe: { status?: number; body?: string } = {};
                        if (!hasReceivedAnyEvent) {
                            try {
                                const resp = await fetch(voxelStreamUrl);
                                probe = {
                                    status: resp.status,
                                    body: (await resp.text()).slice(0, 400),
                                };
                                console.error('[VoxelGen] Direct-fetch probe response', probe);
                            } catch (probeErr) {
                                console.error('[VoxelGen] Direct-fetch probe also failed', probeErr);
                                probe = { status: 0, body: probeErr instanceof Error ? probeErr.message : String(probeErr) };
                            }
                        }

                        let errorMessage = hasReceivedAnyEvent
                            ? 'Stream interrupted before completion (check browser console + agent logs)'
                            : probe.status !== undefined
                                ? `Voxel-generation stream rejected by server (status=${probe.status}): ${probe.body || '(empty body)'}`
                                : `Could not open voxel-generation stream (readyState=${readyState}, url length=${voxelStreamUrl.length}). Check the agent server is running and the URL is reachable.`;
                        try {
                            if (messageEvent.data) {
                                const data = JSON.parse(messageEvent.data);
                                errorMessage = data.message || errorMessage;
                            }
                        } catch (e) {
                            // If parsing fails, use default error message
                        }
                        eventSource.close();
                        reject(new Error(errorMessage));
                    });
                });
                
                const stats = result.stats;
                const voxelWorldData = result.voxelWorld;
                const floorMeshes = result.floorMeshes || [];
                
                // Store and visualize floor meshes for this splat
                if (floorMeshes.length > 0) {
                    console.log(`[editor] Received ${floorMeshes.length} floor meshes for splat ${i + 1}`);
                    for (const floorMeshData of floorMeshes) {
                        this.floorMeshManager.createFloorMeshCollider(floorMeshData);
                    }
                }
                
                // Update voxel size (should be same for all splats)
                if (stats && typeof stats.voxelSize === 'number') {
                    this.currentVoxelSize = stats.voxelSize;
                } else {
                    this.currentVoxelSize = voxelSize;
                }
                
                // Update VoxelWorld voxel size
                if (this.voxelWorld) {
                    this.voxelWorld.setVoxelSize(this.currentVoxelSize);
                }
                
                // Bounds are already set from first pass - no need to update them here
                // Updating bounds after placing voxels would cause them to shift positions
                
                // Load voxel data into VoxelWorld
                // Backend provides world coordinates directly, so we just place voxels at those coordinates
                if (voxelWorldData && this.voxelWorld && combinedBounds) {
                    
                    for (const [chunkKey, chunkData] of Object.entries(voxelWorldData)) {
                        const parts = chunkKey.split(',');
                        if (parts.length !== 3) continue;
                        const cxStr = parts[0];
                        const cyStr = parts[1];
                        const czStr = parts[2];
                        if (!cxStr || !cyStr || !czStr) continue;
                        const cx = parseInt(cxStr, 10);
                        const cy = parseInt(cyStr, 10);
                        const cz = parseInt(czStr, 10);
                        if (isNaN(cx) || isNaN(cy) || isNaN(cz)) continue;
                        
                        if ((chunkData as any).voxels) {
                            for (const voxel of (chunkData as any).voxels) {
                                // Backend provides world coordinates directly - use them
                                const worldX = voxel.worldX;
                                const worldY = voxel.worldY;
                                const worldZ = voxel.worldZ;
                                
                                // Place voxel at the world coordinates provided by backend
                                const color = voxel.color !== undefined ? voxel.color : undefined;
                                this.voxelWorld.setBlock(worldX, worldY, worldZ, voxel.blockId, color);
                            }
                        }
                    }
                    
                    totalVoxels += stats.populatedVoxels || 0;
                    totalChunks += stats.chunkCount || 0;
                }
            }
            
            // Bounds are already set during voxel placement (set immediately after first splat)
            // Just ensure they're set if somehow they weren't set during processing
            if (combinedBounds && this.voxelWorld && !this.voxelWorldBounds) {
                this.voxelWorldBounds = combinedBounds;
                this.voxelWorld.setBounds(combinedBounds);
            }
            // Persist bounds under the active env-object key so a later splat
            // switch restores them along with the voxelWorld pointer.
            this.rememberCurrentVoxelBounds();
            
            // Update physics and meshing - this creates Rapier physics bodies
            if (this.voxelWorld) {
                updateProgressModal(progressModal, 90, `Creating physics colliders for ${totalChunks} chunks...`);
                try {
                    this.voxelWorld.updatePhysicsAndMeshing(true);
                } catch (physicsError) {
                    // Enhance OOM error with voxel context
                    if (physicsError instanceof Error && (physicsError.message.includes('Out of Memory') || physicsError.message.includes('OOM'))) {
                        const enhancedMsg = `${physicsError.message}\n\nVoxel Context: ${totalVoxels.toLocaleString()} voxels in ${totalChunks} chunks (voxel size: ${voxelSize}m)`;
                        throw new Error(enhancedMsg);
                    }
                    throw physicsError;
                }
                this.applyVisibilityState();
                
                const voxelCount = this.getVoxelCount();
                console.log(`✅ Level voxelization complete: ${voxelCount.toLocaleString()} voxels in ${totalChunks} chunks`);
                
                // Force UI refresh
                if (this.ui) {
                    this.ui.update();
                }
            }
            
            // Notify game to move flat ground plane to bottom of combined voxels
            if (this.onHeightmapGenerated && combinedBounds) {
                console.log('🔔 Notifying game to move ground plane to bottom of voxels');
                const fakeHeightmap = {
                    width: 2,
                    height: 2,
                    minX: combinedBounds.minX,
                    maxX: combinedBounds.maxX,
                    minZ: combinedBounds.minZ,
                    maxZ: combinedBounds.maxZ,
                    minY: combinedBounds.minY,
                    maxY: combinedBounds.maxY,
                    heights: [combinedBounds.minY, combinedBounds.minY, combinedBounds.minY, combinedBounds.minY]
                };
                this.onHeightmapGenerated(fakeHeightmap);
            }
            
            updateProgressModal(progressModal, 95, `Complete: ${totalVoxels.toLocaleString()} voxels from ${allSplats.length} splat(s). Saving...`);
            
            // Automatically save voxels to S3 after generation (per-splat).
            // envObjectId is required — splats always live on env-objects, and
            // voxel colliders are stored exclusively on that env-object.
            const activeEnvObjectId = this.getActiveEnvObjectId();
            if (!activeEnvObjectId) {
                console.error('❌ Cannot save voxels: no active env-object id (splat without env-object?)');
            } else {
                if (this.voxelWorld) {
                    const gameData = this.getGameDataCallback?.() || null;
                    await saveVoxelsToS3(this.voxelWorld, this.currentVoxelSize, this.voxelWorldBounds, gameData, activeEnvObjectId);
                }

                updateProgressModal(progressModal, 97, 'Saving floor meshes...');
                const gameDataForFloorMeshes = this.getGameDataCallback?.() || null;
                await saveFloorMeshesToS3(this.floorMeshManager, gameDataForFloorMeshes, activeEnvObjectId);
            }
            
            updateProgressModal(progressModal, 100, `Saved: ${totalVoxels.toLocaleString()} voxels from ${allSplats.length} splat(s)`);
            
            // Notify parent that voxels have been saved (triggers auto-save)
            safePostMessageToCreator({
                type: 'VOXELS_SAVED',
                success: true
            });
            
            setTimeout(() => {
                closeProgressModal(progressModal);
            }, 1500);
            
        } catch (error) {
            console.error('Error generating voxel colliders:', error);
            closeProgressModal(progressModal);
            alert(`❌ Failed to generate voxel colliders: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    
    async generateVisibilityData(): Promise<void> {
        if (!this.splatFilename) {
            console.error('❌ No splat filename set - cannot generate visibility data');
            return;
        }
        
        const hasVoxels = this.colliders.some(c => GaussianSplatEditor.isVoxelColliderId(c.data.id));
        if (!hasVoxels) {
            console.error('❌ No voxels generated - cannot generate visibility data');
            alert('❌ Generate voxel colliders first before creating visibility data!');
            return;
        }
        
        console.log(`👁️ Generating visibility data from ${this.splatFilename}...`);
        
        // Show progress modal
        const progressModal = createProgressModal('Generating Visibility Data');
        
        try {
            // Use SSE to stream progress
            const params = new URLSearchParams({
                splatFilename: this.splatFilename,
                cellSize: '5.0',
                subCellDivisions: '3',
                maxVisibilityDistance: '100.0'
            });
            
            const eventSource = new EventSource(`${getAgentUrl()}/api/stream-visibility-generation?${params}`);
            
            eventSource.addEventListener('progress', (event) => {
                const data = JSON.parse(event.data);
                updateProgressModal(progressModal, data.progress, data.message);
            });
            
            eventSource.addEventListener('complete', (event) => {
                const data = JSON.parse(event.data);
                updateProgressModal(progressModal, 100, data.message);
                eventSource.close();
                
                setTimeout(() => {
                    closeProgressModal(progressModal);
                    showVisibilityNotification(true, data.result);
                }, 1000);
            });
            
            eventSource.addEventListener('error', (event: Event) => {
                const messageEvent = event as MessageEvent;
                let errorMessage = 'Unknown error occurred';
                
                try {
                    if (messageEvent.data) {
                        const data = JSON.parse(messageEvent.data);
                        errorMessage = data.message || errorMessage;
                    }
                } catch (e) {
                    // If parsing fails, use default error message
                }
                
                console.error('Error generating visibility data:', errorMessage);
                eventSource.close();
                closeProgressModal(progressModal);
                showVisibilityNotification(false);
            });
            
        } catch (error) {
            console.error('Error generating visibility data:', error);
            closeProgressModal(progressModal);
                showVisibilityNotification(false);
        }
    }
    
    async generateHeightmap(): Promise<void> {
        if (!this.splatFilename) {
            console.error('❌ No splat filename set - cannot generate heightmap');
            return;
        }
        
        console.log(`🗺️ Generating heightmap from ${this.splatFilename}...`);
        
        try {
            // Prepare transform data to send to backend
            const transform = this.splatTransform ? {
                position: { x: this.splatTransform.position.x, y: this.splatTransform.position.y, z: this.splatTransform.position.z },
                rotation: { x: this.splatTransform.rotation.x, y: this.splatTransform.rotation.y, z: this.splatTransform.rotation.z },
                scale: { x: this.splatTransform.scale.x, y: this.splatTransform.scale.y, z: this.splatTransform.scale.z }
            } : null;
            
            console.log('🔄 Sending splat transform to backend:', transform);
            
            // Request heightmap generation from backend
            const response = await fetch(`${getAgentUrl()}/api/generate-heightmap`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    splatFilename: this.splatFilename,
                    splatUrl: this.splatUrl, // Send full URL so backend can fetch remote files
                    resolution: 128,
                    worldSize: 100,
                    transform: transform
                })
            });
            
            if (response.ok) {
                const result = await response.json();
                const heightmapData: HeightmapData = result.heightmap;
                this.heightmapData = heightmapData;
                
                console.log(`✅ Heightmap generated: ${heightmapData.width}x${heightmapData.height} samples`);
                console.log(`   Height range: ${heightmapData.minY.toFixed(2)} to ${heightmapData.maxY.toFixed(2)}`);
                
                // Remove old heightmap visualization/physics if exists
                this.removeHeightmap();
                
                // Create visualization ONLY (no physics - WorldGenerator handles that)
                this.createHeightmapVisualization();
                
                // Notify the game to replace ground plane with heightfield
                // WorldGenerator will create the physics body
                if (this.onHeightmapGenerated && this.heightmapData) {
                    console.log('🔔 Notifying game of heightmap generation');
                    this.onHeightmapGenerated(this.heightmapData);
                }
                
                // Update UI to show heightmap is ready (user must press F5 to save)
                this.ui.update();
                
                this.showHeightmapNotification(true);
            } else {
                console.error('Failed to generate heightmap:', response.status, await response.text());
                this.showHeightmapNotification(false);
            }
        } catch (error) {
            console.error('Error generating heightmap:', error);
            this.showHeightmapNotification(false);
        }
    }
    
    private createHeightmapVisualization(): void {
        if (!this.heightmapData) return;
        
        const { width, height, minX, maxX, minZ, maxZ, heights } = this.heightmapData;
        
        // Create geometry from heightmap
        const geometry = new THREE.PlaneGeometry(
            maxX - minX,
            maxZ - minZ,
            width - 1,
            height - 1
        );
        
        // Rotate to XZ plane FIRST (before applying heights)
        geometry.rotateX(-Math.PI / 2);
        
        // Update vertex heights AFTER rotation
        const positions = geometry.attributes.position;
        if (positions) {
            for (let z = 0; z < height; z++) {
                for (let x = 0; x < width; x++) {
                    const index = z * width + x;
                    const heightValue = heights[index] || 0;
                    positions.setY(index, heightValue);
                }
            }
            positions.needsUpdate = true;
        }
        
        geometry.computeVertexNormals();
        
        const material = new THREE.MeshStandardMaterial({
            color: 0x00aaff,
            transparent: true,
            opacity: 0.4,
            wireframe: false,
            side: THREE.DoubleSide
        });
        
        this.heightmapMesh = new THREE.Mesh(geometry, material);
        this.heightmapMesh.name = 'GaussianSplatHeightmapVisualization';
        this.heightmapMesh.position.set(
            (minX + maxX) / 2,
            0,
            (minZ + maxZ) / 2
        );
        this.heightmapMesh.visible = this.isEnabled;
        this.heightmapMesh.layers.set(0);
        
        this.scene.add(this.heightmapMesh);
        console.log('✅ Heightmap visualization created');
    }
    
    private removeHeightmap(): void {
        if (this.heightmapMesh) {
            this.scene.remove(this.heightmapMesh);
            this.heightmapMesh.geometry.dispose();
            (this.heightmapMesh.material as THREE.Material).dispose();
            this.heightmapMesh = null;
        }
        
        // GaussianSplatEditor no longer creates physics bodies for heightmap
        // Physics is handled by WorldGenerator
    }
    
    toggleHeightmapVisibility(): void {
        if (this.heightmapMesh) {
            this.heightmapMesh.visible = !this.heightmapMesh.visible;
            console.log(`Heightmap visibility: ${this.heightmapMesh.visible ? 'visible' : 'hidden'}`);
        }
    }
    
    private showHeightmapNotification(success: boolean): void {
        const notification = document.createElement('div');
        const bgColor = success ? 'rgba(76, 175, 80, 0.95)' : 'rgba(244, 67, 54, 0.95)';
        
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: ${bgColor};
            color: white;
            padding: 20px 40px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 16px;
            z-index: 2000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            text-align: center;
        `;
        
        if (success) {
            notification.innerHTML = `
                <strong>✅ Heightmap Generated!</strong><br>
                <span style="font-size: 14px; color: #e0e0e0;">
                    ${this.heightmapData?.width}x${this.heightmapData?.height} resolution
                </span><br>
                <span style="font-size: 12px; color: #ffeb3b;">
                    Range: ${this.heightmapData?.minY.toFixed(2)}m to ${this.heightmapData?.maxY.toFixed(2)}m
                </span>
            `;
        } else {
            notification.innerHTML = `
                <strong>❌ Heightmap Generation Failed</strong><br>
                <span style="font-size: 14px; color: #e0e0e0;">Check console for errors</span>
            `;
        }
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                document.body.removeChild(notification);
            }
        }, 3000);
    }
    
    private extractFilename(url: string): string {
        try {
            const urlObj = new URL(url, window.location.href);
            const pathname = urlObj.pathname;
            return pathname.substring(pathname.lastIndexOf('/') + 1);
        } catch {
            return url.substring(url.lastIndexOf('/') + 1);
        }
    }
    
    async saveFloorMeshes(): Promise<void> {
        const envId = this.getActiveEnvObjectId();
        if (!envId) { console.error('❌ saveFloorMeshes: no active envObjectId'); return; }
        const gameData = this.getGameDataCallback?.() || null;
        await saveFloorMeshesToS3(this.floorMeshManager, gameData, envId);
    }

    async saveVoxels(): Promise<void> {
        if (!this.voxelWorld) return;
        const envId = this.getActiveEnvObjectId();
        if (!envId) { console.error('❌ saveVoxels: no active envObjectId'); return; }
        const gameData = this.getGameDataCallback?.() || null;
        await saveVoxelsToS3(this.voxelWorld, this.currentVoxelSize, this.voxelWorldBounds, gameData, envId);
    }

    async saveColliders(): Promise<void> {
        if (!this.splatFilename) {
            console.error('❌ Cannot save: splatFilename is not set');
            showSaveNotification('', false);
            return;
        }
        
        const baseFilename = this.splatFilename.replace(/\.spz$/i, '');
        const jsonFilename = `${baseFilename}.json`;
        
        // Save manual colliders (.json) - filter out voxel colliders
        const manualColliders = this.colliders.filter(c => !GaussianSplatEditor.isVoxelColliderId(c.data.id || ''));
        
        if (manualColliders.length === 0 && !this.heightmapData) {
            showSaveNotification('No colliders or heightmap to save', false);
            return;
        }
        
        try {
            console.log('💾 Saving manual colliders to .json format...');
            const data: ColliderFileData = {
                colliders: manualColliders.map(c => c.data),
                voxelSize: this.currentVoxelSize
            };
            if (this.heightmapData) {
                data.heightmap = this.heightmapData;
            }
            // Add floor mesh colliders if any exist
            const floorMeshColliders = this.floorMeshManager.getFloorMeshColliders();
            if (floorMeshColliders.length > 0) {
                data.meshColliders = floorMeshColliders.map(c => c.data);
                console.log(`   Floor mesh colliders: ${floorMeshColliders.length}`);
            }
            const jsonString = JSON.stringify(data, null, 2);
            console.log(`   Manual colliders: ${manualColliders.length}`);
            if (this.heightmapData) {
                console.log(`   Heightmap: ${this.heightmapData.width}x${this.heightmapData.height}`);
            }
            
            const response = await fetch(`${getAgentUrl()}/api/save-collider-file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    filename: jsonFilename,
                    content: jsonString
                })
            });
            
            if (response.ok) {
                const result = await response.json();
                if (result.success && result.s3Url) {
                    await saveColliderUrlToWorldJson(result.s3Url);
                    console.log(`✅ Manual colliders saved successfully to S3: ${result.s3Url}`);
                    showSaveNotification(jsonFilename, true, result.s3Url);
                } else {
                    showSaveNotification(jsonFilename, false, null, 'Save returned success but no S3 URL');
                }
            } else {
                let errorData: unknown;
                try {
                    errorData = await response.json();
                } catch {
                    const errorText = await response.text();
                    errorData = { error: errorText };
                }
                const errorMsg = (errorData as {error?: string}).error || 'Unknown error';
                console.error(`Failed to save manual colliders: ${errorMsg}`);
                showSaveNotification(jsonFilename, false, null, errorMsg);
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Network error';
            console.error(`Error saving manual colliders:`, error);
            showSaveNotification(jsonFilename, false, null, errorMsg);
        }
    }
    
    private generateId(): string {
        return `collider_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        
    // Getter methods for UI access
    getColliders(): Array<{ data: BoxColliderData; mesh: THREE.Mesh; body: any }> {
        return this.colliders;
    }
    
    getFloorMeshCount(): number {
        return this.floorMeshManager.getCount();
    }
    
    getVoxelsVisible(): boolean {
        // Check if voxel chunks are visible
        if (this.voxelWorld) {
            const chunks = this.voxelWorld.getChunks();
            for (const chunk of chunks.values()) {
                if (chunk.collisionMesh) {
                    return chunk.collisionMesh.visible;
                }
            }
        }
        return false;
    }
    
    getCollidersVisible(): boolean {
        const colliders = this.floorMeshManager.getFloorMeshColliders();
        return colliders.length > 0 ? colliders[0]?.mesh.visible ?? true : true;
    }
    
    getSplatsVisible(): boolean {
        return this.visibilityState !== 2; // Not in "voxels only" mode
    }
    
    setVoxelsVisible(visible: boolean): void {
        // Toggle every per-splat VoxelWorld, not just the active pointer —
        // otherwise scenes with multiple voxelised splats would only show one.
        for (const world of this.iterAllVoxelWorlds()) {
            world.setChunksVisible(visible);
        }
        console.log(`[editor] Voxels visibility: ${visible}`);
    }
    
    setCollidersVisible(visible: boolean): void {
        const colliders = this.floorMeshManager.getFloorMeshColliders();
        colliders.forEach(c => {
            c.mesh.visible = visible;
        });
        console.log(`[editor] Floor mesh colliders visibility: ${visible}`);
    }
    
    setSplatsVisible(visible: boolean): void {
        if (this.splatVisibilityCallback) {
            this.splatVisibilityCallback(visible);
            console.log(`[editor] Splats visibility: ${visible}`);
        }
    }
    
    getSelectedCollider(): { data: BoxColliderData; mesh: THREE.Mesh; body: any } | null {
        return this.selectedCollider;
    }
    
    getHeightmapData(): HeightmapData | null {
        return this.heightmapData;
    }
    
    getSplatTransform(): { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 } | null {
        return this.splatTransform;
    }
    
    getSplatUrl(): string {
        return this.splatUrl;
    }
    
    getSplatVisibilityCallback(): ((visible: boolean) => void) | null {
        return this.splatVisibilityCallback;
                    }
    
    getSplatTransformChangeCallback(): ((transform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }) => void) | null {
        return this.splatTransformChangeCallback;
    }
    
    setGetGameDataCallback(callback: () => any): void {
        this.getGameDataCallback = callback;
                    }
    
    setGetSplatRenderersCallback(callback: () => any[]): void {
        this.getSplatRenderersCallback = callback;
                }
    
    /**
     * Save all splat transforms from renderers to world.json before voxelization
     * This ensures voxelization uses the current visual positions/rotations/scales
     */

    async ensureAllSplatBoundsCalculated(): Promise<void> {
        if (!this.getGameDataCallback) {
            console.error('❌ Cannot get game data - getGameDataCallback not set');
            return;
        }
        if (!this.getSplatRenderersCallback) {
            console.error('❌ Cannot get splat renderers - callback not set');
            return;
        }

        const gameData = this.getGameDataCallback();
        const renderers = this.getSplatRenderersCallback();
        if (!renderers || renderers.length === 0) return;

        const envs: any[] = Array.isArray(gameData?.environmentObjects) ? gameData.environmentObjects : [];
        const assets: any[] = Array.isArray(gameData?.assets) ? gameData.assets : [];
        const assetById = new Map<string, any>();
        for (const a of assets) if (a?.id) assetById.set(a.id, a);
        const envById = new Map<string, any>();
        for (const e of envs) if (e?.id) envById.set(e.id, e);

        // Persist newly-calculated bounds via the same env-object save flow
        // we use elsewhere (request/response, git-tracked, in-memory mirror).
        const patches: Array<{ envObjectId: string; fields: Record<string, unknown> }> = [];

        for (let i = 0; i < renderers.length; i++) {
            const renderer = renderers[i];
            const envObjectId: string | null = typeof renderer.getEnvObjectId === 'function' ? renderer.getEnvObjectId() : null;
            if (!envObjectId) continue;
            const env = envById.get(envObjectId);
            const asset = env?.assetId ? assetById.get(env.assetId) : null;
            const url = renderer.getSplatUrl?.() || asset?.url || env?.assetUrl;
            if (!url) continue;

            // Bounds priority: env.bounds > asset.boundingBox.
            const existingBounds = (env?.bounds as any) || (asset?.boundingBox as any);
            if (existingBounds) continue;

            console.log(`[Bounds] Calculating missing bounds for splat ${i + 1} (envObjectId=${envObjectId})...`);
            const pos = renderer.getPosition();
            const rot = renderer.getRotation();
            const scl = renderer.getScale();
            try {
                const boundsResponse = await fetch(`${getAgentUrl()}/api/splats/calculate-bounds`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        splatUrl: url,
                        transform: {
                            position: { x: pos.x, y: pos.y, z: pos.z },
                            rotation: { x: rot.x, y: rot.y, z: rot.z },
                            scale: { x: scl.x, y: scl.y, z: scl.z },
                        },
                    }),
                });
                if (!boundsResponse.ok) {
                    throw new Error(`bounds API failed: ${boundsResponse.statusText}`);
                }
                const boundsData = await boundsResponse.json();
                if (!boundsData.success || !boundsData.bounds) {
                    throw new Error('bounds API returned no data');
                }
                console.log(`[Bounds] ✅ Calculated bounds for splat ${i + 1}:`, boundsData.bounds);
                patches.push({ envObjectId, fields: { bounds: boundsData.bounds } });
            } catch (error) {
                console.error(`[Bounds] ❌ Error calculating bounds for splat ${i + 1}:`, error);
                throw new Error(`Failed to calculate bounds for splat ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        if (patches.length > 0) {
            console.log('[Bounds] Persisting calculated bounds...');
            await sendSplatBatchSavedAndAwait(patches, 'Save calculated splat bounds');
            console.log('[Bounds] ✅ Saved bounds to env-objects');
        } else {
            console.log('[Bounds] All splats already have bounds - no save needed');
    }
    }

    /**
     * Save all splat transforms (position/rotation/scale) to their corresponding env-objects.
     * Uses the SPLAT_FIELD_SAVED postMessage with multi-field payload, which the creator
     * persists via edit-world-config upsertRoot on `environmentObjects` keyed by id.
     */
    async saveAllSplatTransforms(): Promise<any[]> {
        if (!this.getSplatRenderersCallback) return [];

        const renderers = this.getSplatRenderersCallback();
        if (!renderers || renderers.length === 0) return [];

        const objects: Array<{ envObjectId: string; fields: Record<string, unknown> }> = [];
        const updatedSplats: any[] = [];

        console.log('[editor] [SaveTransforms] Saving transforms for all splats:');
        for (let i = 0; i < renderers.length; i++) {
            const renderer = renderers[i];
            if (!renderer || typeof renderer.getEnvObjectId !== 'function') continue;
            const envObjectId = renderer.getEnvObjectId();
            if (!envObjectId) continue;

            const p = renderer.getPosition();
            const r = renderer.getRotation();
            const s = renderer.getScale();

            console.log(`[editor] [SaveTransforms]   ${envObjectId}: pos=(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}), rot=(${(r.x * 180 / Math.PI).toFixed(1)}°, ${(r.y * 180 / Math.PI).toFixed(1)}°, ${(r.z * 180 / Math.PI).toFixed(1)}°)`);

            const fields = {
                position: { x: p.x, y: p.y, z: p.z },
                rotation: { x: r.x, y: r.y, z: r.z },
                scale: { x: s.x, y: s.y, z: s.z },
            };
            objects.push({ envObjectId, fields });
            updatedSplats.push({ url: renderer.getSplatUrl?.(), envObjectId, ...fields });
        }

        if (objects.length === 0) return [];

        await sendSplatBatchSavedAndAwait(objects, 'Save splat transforms');
        return updatedSplats;
    }
    
    getGetGameDataCallback(): (() => any) | null {
        return this.getGameDataCallback;
    }
    
    setIsEditingInput(value: boolean): void {
        this.isEditingInput = value;
    }
    
    markTransformsDirty(): void {
        const wasDirty = this.transformsDirty;
        this.transformsDirty = true;
        if (!wasDirty && this.ui) this.ui.update();
        if (!wasDirty) this.broadcastTransformsDirty(true);
    }

    clearTransformsDirty(): void {
        const wasDirty = this.transformsDirty;
        this.transformsDirty = false;
        if (wasDirty && this.ui) this.ui.update();
        if (wasDirty) this.broadcastTransformsDirty(false);
    }

    /**
     * Push the dirty status to the creator so its Voxelize button can grey
     * itself out the moment an unsaved transform edit lands (or un-grey on
     * save). Without this push the creator only learns about dirty state when
     * it polls via CHECK_SPLAT_TRANSFORMS_DIRTY, which doesn't run during a
     * gizmo drag.
     */
    private broadcastTransformsDirty(isDirty: boolean): void {
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({ type: 'SPLAT_TRANSFORMS_DIRTY_STATUS', isDirty }, '*');
            }
        } catch { /* parent unreachable — harmless */ }
    }
    
    getTransformsDirty(): boolean {
        return this.transformsDirty;
    }

    /**
     * Per-splat lookup. Game / template / work-folder code should NOT call
     * this — it lives on a debug/editor class. Use the public method on the
     * GaussianSplatRenderer (`renderer.getVoxelWorld()`) instead. This stub
     * is kept only so that other editor-internal flows that already address
     * voxels by env-id keep working; it just proxies to the renderer.
     */
    getVoxelWorldForEnvObject(envObjectId: string | null): VoxelWorld | null {
        if (!envObjectId) return null;
        const renderer = this.findRendererByEnvId(envObjectId);
        return renderer ? renderer.getVoxelWorld() : null;
    }

    getVoxelWorldBoundsForEnvObject(envObjectId: string | null): { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number } | null {
        if (!envObjectId) return null;
        const renderer = this.findRendererByEnvId(envObjectId);
        return renderer ? renderer.getVoxelWorldBoundsRaw() : null;
    }

    getVoxelWorld(): VoxelWorld | null {
        return this.voxelWorld;
    }

    getCurrentVoxelSize(): number {
        return this.currentVoxelSize;
    }

    setCurrentVoxelSize(size: number): void {
        if (Number.isFinite(size) && size > 0) {
            this.currentVoxelSize = size;
        }
    }

    getCurrentOpacityThreshold(): number {
        return this.currentOpacityThreshold;
    }

    setCurrentOpacityThreshold(threshold: number): void {
        if (Number.isFinite(threshold) && threshold >= 0 && threshold < 1) {
            this.currentOpacityThreshold = threshold;
        }
    }

    getCurrentVoxelizeMode(): 'center' | 'coverage' {
        return this.currentVoxelizeMode;
    }

    setCurrentVoxelizeMode(mode: 'center' | 'coverage'): void {
        if (mode === 'center' || mode === 'coverage') this.currentVoxelizeMode = mode;
    }
    
    getVoxelCount(): number {
        if (!this.voxelWorld) {
            console.log('[getVoxelCount] No voxelWorld');
            return 0;
        }
        // Count total voxels across all chunks
        let totalVoxels = 0;
        const chunks = this.voxelWorld.getChunks();
        const chunkCount = chunks.size;
        
        for (const chunk of chunks.values()) {
            if (!chunk || !chunk.palette) {
                continue;
            }
            chunk.forEachRun((paletteIndex, len) => {
                if (paletteIndex >= chunk.palette.length) return;
                const blockId = chunk.palette[paletteIndex] ?? 0;
                if (blockId !== 0) {
                    totalVoxels += len;
                }
            });
        }
        
        return totalVoxels;
    }
    
    async saveSplatTransform(): Promise<void> {
        if (!this.splatTransform || !this.splatUrl) {
            console.error('No splat transform or URL available');
            return;
        }

        if (!this.getGameDataCallback) {
            console.error('No getGameData callback available');
            alert('❌ Cannot save: Game data not available');
            return;
        }

        const gameData = this.getGameDataCallback();
        if (!gameData?.worldProfileData) {
            console.error('Game data or worldProfileData not found');
            alert('❌ Cannot save: Game data not found');
            return;
        }

        const eulerAnglesRad = {
            x: this.splatTransform.rotation.x,
            y: this.splatTransform.rotation.y,
            z: this.splatTransform.rotation.z,
        };
        const position = {
            x: this.splatTransform.position.x,
            y: this.splatTransform.position.y,
            z: this.splatTransform.position.z,
        };
        const scale = {
            x: this.splatTransform.scale.x,
            y: this.splatTransform.scale.y,
            z: this.splatTransform.scale.z,
        };

        const transform = {
            position,
            rotation: { x: this.splatTransform.rotation.x, y: this.splatTransform.rotation.y, z: this.splatTransform.rotation.z },
            scale,
        };

        let bounds = null;
        try {
            const boundsResponse = await fetch(`${getAgentUrl()}/api/splats/calculate-bounds`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ splatUrl: this.splatUrl, transform })
            });
            if (boundsResponse.ok) {
                const boundsData = await boundsResponse.json();
                if (boundsData.success && boundsData.bounds) {
                    bounds = boundsData.bounds;
                }
            }
        } catch (error) {
            console.warn(`[SaveTransform] Error recalculating bounds:`, error);
        }

        // Persist to the env-object the active splat belongs to.
        const envObjectId = this.getActiveEnvObjectId();
        if (!envObjectId) {
            console.error('[SaveSplatTransform] No active env-object id — cannot save');
            alert('❌ Cannot save: splat env-object id missing');
            return;
        }

        const fields: Record<string, unknown> = {
            position,
            rotation: eulerAnglesRad,
            scale,
        };
        if (bounds) fields.bounds = bounds;

        console.log('💾 [SaveSplatTransform] Saving to env-object', envObjectId, fields);

        try {
            const ok = await sendSplatBatchSavedAndAwait([{ envObjectId, fields }], 'Save splat transform');
            if (ok) {
                alert('✅ Splat settings saved successfully!');
            } else {
                alert('❌ Failed to save splat settings');
            }
        } catch (error) {
            console.error('❌ [SaveSplatTransform] Error:', error);
            alert(`❌ Error saving: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    
    private forceActivateAllVoxelColliders(): void {
        this.colliders.forEach(collider => {
            const isVoxel = GaussianSplatEditor.isVoxelColliderId(collider.data.id);
            if (isVoxel && collider.body) {
                try {
                    // Check if body is still valid (has collision shape)
                    // Bodies that have been removed from physics world may still be referenced
                    // but will cause memory access errors if we try to update them
                    const shape = collider.body.getCollisionShape();
                    if (!shape) {
                        return; // Body is invalid, skip it
                    }
                    collider.body.activate(true);
                    this.physicsWorld.updateSingleAabb(collider.body);
                } catch (error) {
                    // Body may have been destroyed/removed from physics world
                    // Skip it silently to prevent crashes during recording
                    console.warn('Skipping invalid voxel body:', collider.data.id);
                }
            }
        });
    }
    
    dispose(): void {
        this.setEnabled(false);
        
        this.colliders.forEach(collider => {
            if (collider.mesh.parent) {
                collider.mesh.parent.remove(collider.mesh);
            } else {
                this.scene.remove(collider.mesh);
            }
            collider.mesh.geometry.dispose();
            (collider.mesh.material as THREE.Material).dispose();
            
            // Remove physics body - Rapier handles cleanup automatically
            this.removePhysicsBody(collider.body);
        });
        
        this.colliders = [];
        
        // Clean up voxel parent
        if (this.voxelParent) {
            this.scene.remove(this.voxelParent);
            this.voxelParent = null;
        }
        
        this.removeHeightmap();
        
        if (this.ground) {
            this.scene.remove(this.ground);
            this.ground.geometry.dispose();
            (this.ground.material as THREE.Material).dispose();
            this.ground = null;
        }
    }

    // Fast occupancy query for projectile fallback (world space)
    public hasVoxelAtPosition(worldPos: THREE.Vector3): boolean {
        const s = this.currentVoxelSize || 0.4;
        const gx = (worldPos.x - this.gridOrigin.x) / s;
        const gy = (worldPos.y - this.gridOrigin.y) / s;
        const gz = (worldPos.z - this.gridOrigin.z) / s;
        
        const tests: Array<[number, number, number]> = [
            [Math.floor(gx), Math.floor(gy), Math.floor(gz)],
            [Math.round(gx), Math.round(gy), Math.round(gz)],
            [Math.ceil(gx), Math.ceil(gy), Math.ceil(gz)]
        ];
        
        for (const [ix, iy, iz] of tests) {
            const key = `${ix},${iy},${iz}`;
            if (this.voxelCellSet.has(key)) {
                return true;
            }
        }
        return false;
    }
}
