// Type checking enabled
import { isPickableOnScreen } from 'engine/GlbInstancing.js';
import * as THREE from 'three';
import { VoxelObject } from 'engine/VoxelObject.js';

// Engine interface for object selection
interface SelectionManagerEngine {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer & { domElement: HTMLCanvasElement };
}

/**
 * Configuration for selectable object types.
 * Add new selectable object types here instead of adding if clauses throughout the code.
 */
export class SelectableObjectConfig {
    /**
     * Group names that are directly selectable (must be THREE.Group instances)
     */
    static readonly SELECTABLE_GROUP_NAMES: readonly string[] = [
        'PlayerGroup',
        'VehiclePlatform',
    ];

    /**
     * Group names that support transform changes (gizmo + editable fields)
     * Objects not in this list will be view-only in the inspector
     */
    static readonly TRANSFORM_EDITABLE_GROUP_NAMES: readonly string[] = [
        // Currently no groups support transform editing
        // VoxelObjects and environment instances support it via their type, not name
    ];

    /**
     * Check if an object is a selectable group by name
     */
    static isSelectableGroup(object: THREE.Object3D): boolean {
        return object instanceof THREE.Group &&
               this.SELECTABLE_GROUP_NAMES.includes(object.name);
    }

    /**
     * Check if an object is a child of PlayerGroup (player's BlockCharacter)
     * Used to redirect player character clicks to PlayerGroup
     */
    static isPlayerCharacterChild(object: THREE.Object3D): boolean {
        let current: THREE.Object3D | null = object.parent;
        while (current) {
            if (current.name === 'PlayerGroup') {
                return true;
            }
            current = current.parent;
        }
        return false;
    }

    /**
     * Check if an object is a VoxelObject instance
     */
    static isVoxelObject(object: THREE.Object3D): boolean {
        return object instanceof VoxelObject;
    }

    /**
     * Check if an object is an environment instance (unpacked from InstancedMesh)
     */
    static isEnvironmentInstance(object: THREE.Object3D): boolean {
        return object.userData?.isEnvironmentInstance === true;
    }

    /**
     * Check if an object is a placed GLB environment object (EnvironmentObjectSystem's
     * `loadGlbObjects`): the group that carries its world.json transform — what the editor
     * selects, moves and saves, rather than a mesh inside it.
     */
    static isGlbEnvironmentObject(object: THREE.Object3D): boolean {
        return object.userData?.isGlbEnvironmentObject === true;
    }

    /**
     * Check if an object is a terrain chunk (VoxelWorld mesh)
     */
    static isTerrainChunk(object: THREE.Object3D): boolean {
        return object.name.startsWith('VoxelChunk_') ||
               object.userData?.isTerrainChunk === true;
    }

    /**
     * Check if an object should redirect to another object.
     * Only redirects player's BlockCharacter to PlayerGroup.
     * NPC and animal BlockCharacters are NOT redirected.
     */
    static getRedirectTarget(object: THREE.Object3D): string | null {
        // Only redirect BlockCharacter objects that are children of PlayerGroup
        if (object.name.startsWith('BlockCharacter') && this.isPlayerCharacterChild(object)) {
            return 'PlayerGroup';
        }
        return null;
    }

    /**
     * Check if an object is selectable (any type)
     */
    static isSelectable(object: THREE.Object3D): boolean {
        return this.isVoxelObject(object) ||
               this.isEnvironmentInstance(object) ||
               this.isGlbEnvironmentObject(object) ||
               this.isSelectableGroup(object) ||
               this.isTerrainChunk(object) ||
               this.isSpawnPointMarker(object);
    }

    /**
     * Check if an object is a spawn point marker
     */
    static isSpawnPointMarker(object: THREE.Object3D): boolean {
        return object.userData?.isSpawnPointMarker === true;
    }

    /**
     * Check if an object supports transform changes (gizmo + editable transform fields)
     * Only VoxelObjects and environment instances support transform editing.
     * Other selectable objects (PlayerGroup, VehiclePlatform) are view-only.
     * Objects that are descendants of selectable groups are never independently editable.
     */
    static supportsTransformChanges(object: THREE.Object3D): boolean {
        // Children of selectable groups (VehiclePlatform, PlayerGroup) are parts of
        // a compound object and should not be independently editable
        let parent = object.parent;
        while (parent) {
            if (this.isSelectableGroup(parent)) return false;
            parent = parent.parent;
        }

        return this.isVoxelObject(object) ||
               this.isEnvironmentInstance(object) ||
               this.isGlbEnvironmentObject(object) ||
               this.isSpawnPointMarker(object) ||
               (object instanceof THREE.Group && this.TRANSFORM_EDITABLE_GROUP_NAMES.includes(object.name));
    }
}

/**
 * Raw raycast hit details forwarded alongside a selection. Lets the editor
 * resolve clicks on packed environment-object InstancedMeshes to the exact
 * instance that was clicked (instanceId is only meaningful for the frame the
 * click happened in — consume it immediately).
 */
export interface SelectionHit {
    object: THREE.Object3D;
    instanceId?: number;
    point: THREE.Vector3;
    /** World-space face normal of the hit, when the intersection carried one. */
    faceNormalWorld?: THREE.Vector3;
}

/**
 * Callback when an object is selected
 */
export type ObjectSelectedCallback = (object: THREE.Object3D, focusCamera: boolean, hit?: SelectionHit) => void;

/**
 * Callback when selection is cleared (clicking empty space)
 */
export type SelectionClearedCallback = () => void;

/**
 * Manages click-to-select functionality in debug mode
 */
export class ObjectSelectionManager {
    private engine: SelectionManagerEngine;
    private onObjectSelected: ObjectSelectedCallback;
    private onSelectionCleared: SelectionClearedCallback;

    // Selection state
    private selectedObject: THREE.Object3D | null = null;
    private boundingBoxHelper: THREE.Mesh | null = null;

    // Click detection
    private mouseDownTime: number = 0;
    private mouseDownPosition: { x: number; y: number } = { x: 0, y: 0 };
    private mouseMoveThreshold: number = 5; // pixels
    private clickTimeThreshold: number = 300; // milliseconds

    // Raycasting
    private raycaster: THREE.Raycaster;

    // Bound event handlers
    private boundOnMouseDown: ((event: MouseEvent) => void) | null = null;
    private boundOnMouseUp: ((event: MouseEvent) => void) | null = null;
    private boundOnMouseMove: ((event: MouseEvent) => void) | null = null;

    constructor(
        engine: SelectionManagerEngine,
        onObjectSelected: ObjectSelectedCallback,
        onSelectionCleared: SelectionClearedCallback
    ) {
        this.engine = engine;
        this.onObjectSelected = onObjectSelected;
        this.onSelectionCleared = onSelectionCleared;

        // Setup raycaster
        this.raycaster = new THREE.Raycaster();
        // Raycast against layer 0 (main objects) and layer 1 (characters) - exclude layer 3 (sub-objects/colliders)
        this.raycaster.layers.set(0);
        this.raycaster.layers.enable(1);
        this.raycaster.layers.disable(3);
    }

    /**
     * Get the currently selected object
     */
    getSelectedObject(): THREE.Object3D | null {
        return this.selectedObject;
    }

    /**
     * Set the selected object (used when selecting from hierarchy)
     */
    setSelectedObject(object: THREE.Object3D | null): void {
        this.selectedObject = object;
    }

    /**
     * Setup mouse listeners for click-to-select
     */
    setupMouseListeners(): void {
        this.boundOnMouseDown = this.onMouseDown.bind(this);
        this.boundOnMouseUp = this.onMouseUp.bind(this);
        this.boundOnMouseMove = this.onMouseMove.bind(this);

        this.engine.renderer.domElement.addEventListener('mousedown', this.boundOnMouseDown);
        this.engine.renderer.domElement.addEventListener('mouseup', this.boundOnMouseUp);
        this.engine.renderer.domElement.addEventListener('mousemove', this.boundOnMouseMove);
    }

    /**
     * Remove mouse listeners
     */
    removeMouseListeners(): void {
        if (this.boundOnMouseDown) {
            this.engine.renderer.domElement.removeEventListener('mousedown', this.boundOnMouseDown);
        }
        if (this.boundOnMouseUp) {
            this.engine.renderer.domElement.removeEventListener('mouseup', this.boundOnMouseUp);
        }
        if (this.boundOnMouseMove) {
            this.engine.renderer.domElement.removeEventListener('mousemove', this.boundOnMouseMove);
        }

        this.boundOnMouseDown = null;
        this.boundOnMouseUp = null;
        this.boundOnMouseMove = null;
    }

    /**
     * Handle mouse down for click-to-select
     */
    private onMouseDown(event: MouseEvent): void {
        // Only handle left mouse button
        if (event.button !== 0) return;

        this.mouseDownTime = Date.now();
        this.mouseDownPosition.x = event.clientX;
        this.mouseDownPosition.y = event.clientY;
    }

    /**
     * Handle mouse move to track if user is dragging
     */
    private onMouseMove(_event: MouseEvent): void {
        // We don't need to do anything here, just track that movement happened
        // The actual camera movement is handled by the debug camera controller
    }

    /**
     * Handle mouse up for click-to-select
     */
    private onMouseUp(event: MouseEvent): void {
        // Only handle left mouse button
        if (event.button !== 0) return;

        const mouseUpTime = Date.now();
        const clickDuration = mouseUpTime - this.mouseDownTime;

        // Calculate mouse movement distance
        const mouseMoveDistance = Math.sqrt(
            Math.pow(event.clientX - this.mouseDownPosition.x, 2) +
            Math.pow(event.clientY - this.mouseDownPosition.y, 2)
        );

        // Check if this was a quick click (not a drag)
        const wasQuickClick = clickDuration < this.clickTimeThreshold;
        const wasSmallMovement = mouseMoveDistance < this.mouseMoveThreshold;

        if (wasQuickClick && wasSmallMovement) {
            this.performWorldRaycast(event.clientX, event.clientY);
        }
    }

    /**
     * Perform raycast from camera to world and select clicked object
     */
    performWorldRaycast(mouseX: number, mouseY: number): void {
        // Convert mouse coordinates to normalized device coordinates (-1 to +1)
        const rect = this.engine.renderer.domElement.getBoundingClientRect();
        const x = ((mouseX - rect.left) / rect.width) * 2 - 1;
        const y = -((mouseY - rect.top) / rect.height) * 2 + 1;

        // Set up raycaster
        this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.engine.camera);

        // Get all visible objects with geometry for raycasting
        // Include layer 0 (main objects) and layer 1 (characters), exclude layer 3 (sub-objects)
        const allObjects: THREE.Object3D[] = [];
        let terrainChunkCount = 0;
        let skippedInvisible = 0;
        let skippedLayer = 0;
        this.engine.scene.traverse((object: THREE.Object3D) => {
            // Only raycast against objects that have actual visual geometry
            if (object instanceof THREE.Mesh && object.geometry && object.material) {
                // Skip invisible objects
                const material = object.material as THREE.Material;
                // An instanced GLB copy is hidden but drawn by its batch — still clickable (GlbInstancing.ts).
                if (isPickableOnScreen(object) && (material as { visible?: boolean }).visible !== false) {
                    const layerMask = object.layers.mask;
                    const onLayer0or1 = (layerMask & ((1 << 0) | (1 << 1))) !== 0;
                    const onLayer3 = (layerMask & (1 << 3)) !== 0;

                    if (onLayer0or1 && !onLayer3) {
                        allObjects.push(object);
                        if (object.name.startsWith('VoxelChunk_')) {
                            terrainChunkCount++;
                        }
                    } else {
                        skippedLayer++;
                    }
                } else {
                    skippedInvisible++;
                    if (object.name.startsWith('VoxelChunk_')) {
                        console.log(`[Selection] Skipped invisible terrain chunk: ${object.name}, visible=${object.visible}`);
                    }
                }
            }
        });
        // Count environment instances and VoxelObjects
        let envInstanceCount = 0;
        let voxelObjectCount = 0;
        for (const obj of allObjects) {
            if (obj.userData?.isEnvironmentInstance) envInstanceCount++;
            let current: THREE.Object3D | null = obj;
            while (current) {
                if (SelectableObjectConfig.isVoxelObject(current)) {
                    voxelObjectCount++;
                    break;
                }
                current = current.parent;
            }
        }
        console.log(`[Selection] Found ${allObjects.length} raycastable objects (${terrainChunkCount} terrain, ${envInstanceCount} env instances, ${voxelObjectCount} VoxelObjects, ${skippedInvisible} invisible, ${skippedLayer} wrong layer)`);

        // Perform raycast
        const intersects = this.raycaster.intersectObjects(allObjects, false);

        if (intersects.length > 0) {
            // Use first hit - resolve to a known selectable parent if possible
            const intersection = intersects[0]!;
            const clickedObject = intersection.object;
            const clickedMeshName = clickedObject.name || clickedObject.constructor.name;

            // Debug: log the parent chain
            const parentChain: string[] = [];
            let debugCurrent: THREE.Object3D | null = clickedObject;
            while (debugCurrent) {
                parentChain.push(`${debugCurrent.name || debugCurrent.constructor.name}(${debugCurrent.type})`);
                debugCurrent = debugCurrent.parent;
            }
            console.log(`Hit: ${clickedMeshName}, Parent chain: ${parentChain.join(' → ')}`);

            // Resolve to appropriate selectable parent (VoxelObject, PlayerGroup, or environment instance)
            // For unrecognized objects, returns the original clicked object
            const resolvedObject = this.resolveSelectableObject(clickedObject);
            const resolvedName = resolvedObject.name || resolvedObject.constructor.name;
            console.log(`Clicked mesh: ${clickedMeshName} → Resolved to: ${resolvedName}`);

            // Notify callback - all objects can be selected (non-editable ones open read-only)
            this.onObjectSelected(resolvedObject, false, {
                object: clickedObject,
                instanceId: intersection.instanceId,
                point: intersection.point.clone(),
                faceNormalWorld: intersection.face
                    ? intersection.face.normal.clone().transformDirection(clickedObject.matrixWorld).normalize()
                    : undefined,
            });
        } else {
            console.log('Clicked empty space');

            // Notify callback
            this.onSelectionCleared();
        }
    }

    /**
     * Resolve to the appropriate selectable object (e.g., VoxelObject parent, PlayerGroup, environment instance, terrain chunk)
     */
    resolveSelectableObject(object: THREE.Object3D): THREE.Object3D {
        if (!object) return object;

        let current: THREE.Object3D | null = object;
        while (current) {
            // Check for VoxelObject (environment objects, etc.)
            if (SelectableObjectConfig.isVoxelObject(current)) {
                return current;
            }
            // Check for unpacked environment instances
            if (SelectableObjectConfig.isEnvironmentInstance(current)) {
                return current;
            }
            // A placed GLB object: select the object, not the mesh that was hit inside it
            if (SelectableObjectConfig.isGlbEnvironmentObject(current)) {
                return current;
            }
            // Check for spawn point marker
            if (SelectableObjectConfig.isSpawnPointMarker(current)) {
                return current;
            }
            // Check for selectable groups (PlayerGroup, VehiclePlatform, etc.)
            if (SelectableObjectConfig.isSelectableGroup(current)) {
                return current;
            }
            // Check for terrain chunks (VoxelWorld meshes)
            if (SelectableObjectConfig.isTerrainChunk(current)) {
                return current;
            }
            // Check for redirect rules (e.g., BlockCharacter → PlayerGroup)
            const redirectTarget = SelectableObjectConfig.getRedirectTarget(current);
            if (redirectTarget) {
                const targetObject = this.engine.scene.getObjectByName(redirectTarget);
                if (targetObject) {
                    return targetObject;
                }
            }
            current = current.parent;
        }

        return object;
    }

    /**
     * Show wireframe bounding box for selected object
     */
    showBoundingBox(object: THREE.Object3D): void {
        // Remove existing bounding box
        this.hideBoundingBox();

        try {
            // Calculate bounding box
            const box = new THREE.Box3().setFromObject(object);

            // Skip if box is empty or invalid
            if (box.isEmpty()) {
                console.warn('Object has empty bounding box:', object);
                return;
            }

            // Create wireframe box geometry
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());

            const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
            const material = new THREE.MeshBasicMaterial({
                color: 0x00ff00,
                wireframe: true,
                transparent: true,
                opacity: 0.8
            });

            const boxMesh = new THREE.Mesh(geometry, material);
            boxMesh.position.copy(center);
            boxMesh.name = 'BoundingBoxHelper';
            // Put on layer 3 (non-clickable) so it can't be selected
            boxMesh.layers.set(3);

            this.boundingBoxHelper = boxMesh;

            // Add to scene
            this.engine.scene.add(boxMesh);

            console.log(`Showing bounding box for ${object.name || 'object'}:`, {
                size: size,
                center: center
            });

        } catch (error) {
            console.warn('Failed to create bounding box for object:', error);
        }
    }

    /**
     * Hide bounding box
     */
    hideBoundingBox(): void {
        if (this.boundingBoxHelper) {
            this.engine.scene.remove(this.boundingBoxHelper);
            this.boundingBoxHelper.geometry.dispose();
            // Handle material disposal - can be single material or array
            const material = this.boundingBoxHelper.material;
            if (Array.isArray(material)) {
                material.forEach(m => m.dispose());
            } else {
                material.dispose();
            }
            this.boundingBoxHelper = null;
        }
    }

    /**
     * Clear selection
     */
    clearSelection(): void {
        this.selectedObject = null;
        this.hideBoundingBox();
    }

    /**
     * Dispose of the selection manager
     */
    dispose(): void {
        this.removeMouseListeners();
        this.hideBoundingBox();
        this.selectedObject = null;
    }
}
