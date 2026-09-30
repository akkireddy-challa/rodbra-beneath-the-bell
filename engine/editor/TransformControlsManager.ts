import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { t } from 'engine/i18n/index.js';
import { injectEditorStyles } from './editor-styles.js';

/** Matrix elements closer than this count as unchanged (float noise from the pivot round trip). */
const MATRIX_EPSILON = 1e-6;

function matricesEqual(a: THREE.Matrix4, b: THREE.Matrix4): boolean {
    return a.elements.every((value, i) => Math.abs(value - b.elements[i]!) <= MATRIX_EPSILON);
}

export type TransformMode = 'translate' | 'rotate' | 'scale';

export interface TransformControlsCallbacks {
    onTransformStart?: () => void;
    onTransformChange?: (object: THREE.Object3D) => void;
    onTransformEnd?: (object: THREE.Object3D) => void;
    setDragging?: (isDragging: boolean) => void;
    /** Mark an object as modified. Pass the object so caller can extract ID for change tracking. */
    markSceneChanges?: (object: THREE.Object3D) => void;
    /** Get ground height at X/Z position for snap-to-ground feature. Optionally exclude an object from raycast. */
    getGroundHeight?: (x: number, z: number, excludeObject?: THREE.Object3D) => number;
    /** Called before any transform change (drag start, snap). Use to capture pre-modification state. */
    onBeforeTransform?: (object: THREE.Object3D) => void;
    /** Check if the currently attached object has been modified and can be undone */
    isObjectModified?: (object: THREE.Object3D) => boolean;
    /** Undo all changes to the currently attached object */
    undoObject?: (object: THREE.Object3D) => void;
}

/**
 * TransformControlsManager - Visual gizmo for moving, rotating, and scaling objects
 *
 * Features:
 * - Three.js TransformControls gizmo
 * - Floating toolbar with mode buttons (Move, Rotate, Scale, Snap to Ground)
 * - World space transforms
 * - Coordinates with camera (disables camera while dragging)
 */
export class TransformControlsManager {
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private renderer: THREE.WebGLRenderer;
    private transformControls: TransformControls | null = null;
    private currentObject: THREE.Object3D | null = null;
    private currentMode: TransformMode = 'translate';
    private callbacks: TransformControlsCallbacks;

    // Pivot for centering gizmo on bounding box
    private pivot: THREE.Object3D | null = null;
    private boundingBoxCenter: THREE.Vector3 = new THREE.Vector3();
    private objectPositionOffset: THREE.Vector3 = new THREE.Vector3();

    // Toolbar UI
    private toolbar: HTMLDivElement | null = null;
    private translateBtn: HTMLButtonElement | null = null;
    private rotateBtn: HTMLButtonElement | null = null;
    private scaleBtn: HTMLButtonElement | null = null;
    private undoBtn: HTMLButtonElement | null = null;
    private undoSeparator: HTMLDivElement | null = null;

    // State
    private scaleEnabled: boolean = true;
    /** Object's local matrix when the gizmo was pressed — mouseUp only commits a change when it moved. */
    private matrixAtMouseDown: THREE.Matrix4 | null = null;

    constructor(
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera,
        renderer: THREE.WebGLRenderer,
        callbacks: TransformControlsCallbacks
    ) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.callbacks = callbacks;

        this.createControls();
        this.createToolbar();
    }

    /** Only a VoxelObject carries a physics body that must follow the visual transform. */
    private syncPhysicsTransform(object: THREE.Object3D): void {
        if (object instanceof VoxelObject) {
            object.updatePhysicsTransform();
        }
    }

    /**
     * Create the Three.js TransformControls
     */
    private createControls(): void {
        this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
        this.transformControls.setSpace('world');
        this.transformControls.setMode('translate');
        this.transformControls.setSize(0.75);  // Reasonable gizmo size

        // Create invisible pivot object for centering gizmo on bounding box
        this.pivot = new THREE.Object3D();
        this.pivot.name = '__transformControlsPivot__';
        this.scene.add(this.pivot);

        // Add the transform controls helper to the scene
        // In Three.js 0.182.0+, TransformControls no longer directly extends Object3D
        // Instead, use getHelper() to get the visual gizmo that should be added to the scene
        this.scene.add(this.transformControls.getHelper());

        // Disable camera immediately when user clicks on gizmo (before dragging starts)
        this.transformControls.addEventListener('mouseDown', () => {
            if (this.currentObject) {
                this.callbacks.onBeforeTransform?.(this.currentObject);
                this.currentObject.updateMatrix();
                this.matrixAtMouseDown = this.currentObject.matrix.clone();
            }
            this.callbacks.setDragging?.(true);
        });

        // Re-enable camera when dragging ends
        this.transformControls.addEventListener('dragging-changed', (event) => {
            const isDragging = (event as { value: boolean }).value;
            if (!isDragging) {
                this.callbacks.setDragging?.(false);
            }
        });

        // Handle transform changes during drag - sync pivot transforms to actual object
        // TransformControls also emits 'change' on hover (axis highlight) and
        // mode/space switches; syncing then would rewrite an untouched object
        // (its rotation re-encoded from the pivot quaternion), so only a drag
        // moves the object.
        this.transformControls.addEventListener('change', () => {
            if (this.currentObject && this.pivot && this.transformControls?.dragging) {
                // Rotate the offset by the pivot's rotation so object rotates around bounding box center
                const rotatedOffset = this.objectPositionOffset.clone();
                rotatedOffset.applyQuaternion(this.pivot.quaternion);

                // Apply pivot position minus rotated offset to get new object position
                this.currentObject.position.copy(this.pivot.position).sub(rotatedOffset);
                this.currentObject.rotation.copy(this.pivot.rotation);
                this.currentObject.scale.copy(this.pivot.scale);

                // Update VoxelObject physics during drag for immediate feedback
                this.syncPhysicsTransform(this.currentObject);
                this.callbacks.onTransformChange?.(this.currentObject);
            }
        });

        // Handle transform end (mouse up) - mark scene as changed, but only
        // when the press actually moved the object: a click on the gizmo that
        // never drags is not an edit and must not reach the edit history.
        this.transformControls.addEventListener('mouseUp', () => {
            const before = this.matrixAtMouseDown;
            this.matrixAtMouseDown = null;
            if (this.currentObject) {
                // Final physics update for VoxelObjects
                this.syncPhysicsTransform(this.currentObject);
                this.callbacks.onTransformEnd?.(this.currentObject);
                this.currentObject.updateMatrix();
                if (!before || !matricesEqual(before, this.currentObject.matrix)) {
                    this.callbacks.markSceneChanges?.(this.currentObject);
                }
                this.updateUndoButtonVisibility();
            }
        });
    }

    /**
     * Create the floating toolbar UI
     */
    private createToolbar(): void {
        injectEditorStyles();
        // Pill-shaped toolbar surface — positional state inline, visual styling
        // from the shared bm-* classes.
        this.toolbar = document.createElement('div');
        this.toolbar.className = 'bm-editor-panel';
        this.toolbar.style.cssText = `
            bottom: 100px;
            left: 50%;
            transform: translateX(-50%);
            display: none;
            border-radius: 9999px;
            padding: 6px 10px;
            gap: 6px;
            flex-direction: row;
        `;

        const modeContainer = document.createElement('div');
        modeContainer.style.cssText = `display: flex; gap: 4px;`;

        this.translateBtn = this.createModeButton(t('editor.transform.move'), 'translate');
        this.rotateBtn = this.createModeButton(t('editor.transform.rotate'), 'rotate');
        this.scaleBtn = this.createModeButton(t('editor.transform.scale'), 'scale');

        modeContainer.appendChild(this.translateBtn);
        modeContainer.appendChild(this.rotateBtn);
        modeContainer.appendChild(this.scaleBtn);

        const separator1 = document.createElement('div');
        separator1.className = 'bm-separator-v';

        const snapBtn = document.createElement('button');
        snapBtn.className = 'bm-pill';
        snapBtn.textContent = t('editor.transform.snap');
        snapBtn.title = t('editor.transform.snapTooltip');
        snapBtn.onclick = () => this.snapToGround();

        this.toolbar.appendChild(modeContainer);
        this.toolbar.appendChild(separator1);
        this.toolbar.appendChild(snapBtn);

        // Destructive undo button — hidden until an object is modified.
        this.undoSeparator = document.createElement('div');
        this.undoSeparator.className = 'bm-separator-v';
        this.undoSeparator.style.display = 'none';

        this.undoBtn = document.createElement('button');
        this.undoBtn.className = 'bm-pill bm-pill--destructive';
        this.undoBtn.textContent = t('editor.transform.undo');
        this.undoBtn.title = t('editor.transform.undoTooltip');
        this.undoBtn.style.display = 'none';
        this.undoBtn.onclick = () => {
            if (this.currentObject) {
                this.callbacks.undoObject?.(this.currentObject);
                this.updateUndoButtonVisibility();
            }
        };

        this.toolbar.appendChild(this.undoSeparator);
        this.toolbar.appendChild(this.undoBtn);

        const container = this.renderer.domElement.parentElement || document.body;
        container.appendChild(this.toolbar);

        this.updateButtonStates();
    }

    /**
     * Create a mode button for the toolbar
     */
    private createModeButton(label: string, mode: TransformMode): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = 'bm-pill';
        btn.textContent = label;
        btn.dataset.mode = mode;
        btn.style.minWidth = '80px';
        btn.onclick = () => this.setMode(mode);
        return btn;
    }

    /**
     * Toggle the Aquamarine "active" modifier on the currently selected mode
     * button. The visual treatment lives entirely in editor-styles.ts under
     * `.bm-pill--active`.
     */
    private updateButtonStates(): void {
        // `dataset.mode` is set by createModeButton, so there is no second list
        // of mode names here that could drift out of step with the buttons.
        for (const btn of [this.translateBtn, this.rotateBtn, this.scaleBtn]) {
            if (!btn) continue;
            btn.classList.toggle('bm-pill--active', btn.dataset.mode === this.currentMode);
        }
    }

    /**
     * Show/hide undo button based on whether the current object is modified
     */
    updateUndoButtonVisibility(): void {
        if (!this.undoBtn || !this.undoSeparator) return;
        const display = this.currentObject && this.callbacks.isObjectModified?.(this.currentObject) ? '' : 'none';
        this.undoBtn.style.display = display;
        this.undoSeparator.style.display = display;
    }

    /**
     * Attach transform controls to an object
     * Gizmo is centered on the object's bounding box for intuitive manipulation
     */
    attach(object: THREE.Object3D, options?: { scaleEnabled?: boolean }): void {
        if (!this.transformControls || !this.pivot) return;

        this.currentObject = object;

        // Show/hide scale button based on options
        this.scaleEnabled = options?.scaleEnabled ?? true;
        if (this.scaleBtn) {
            this.scaleBtn.style.display = this.scaleEnabled ? '' : 'none';
        }

        // Calculate bounding box center
        const box = new THREE.Box3().setFromObject(object);
        box.getCenter(this.boundingBoxCenter);

        // Calculate offset from object position to bounding box center in LOCAL space
        // This is important so rotation works correctly around the bounding box center
        this.objectPositionOffset.copy(this.boundingBoxCenter).sub(object.position);
        // Transform to local space by applying inverse of object's rotation
        const inverseQuat = object.quaternion.clone().invert();
        this.objectPositionOffset.applyQuaternion(inverseQuat);

        // Position pivot at bounding box center with object's rotation and scale
        this.pivot.position.copy(this.boundingBoxCenter);
        this.pivot.quaternion.copy(object.quaternion);
        this.pivot.scale.copy(object.scale);

        // Attach transform controls to pivot (not the actual object)
        this.transformControls.attach(this.pivot);

        // Show toolbar
        if (this.toolbar) {
            this.toolbar.style.display = 'flex';
        }

        // Reset to translate mode
        this.setMode('translate');

        this.updateUndoButtonVisibility();

        console.log('[TransformControls] Attached to:', object.name || object.uuid, 'at bounding box center');
    }

    /**
     * Detach transform controls
     */
    detach(): void {
        if (!this.transformControls) return;

        this.transformControls.detach();
        this.currentObject = null;

        // Hide toolbar
        if (this.toolbar) {
            this.toolbar.style.display = 'none';
        }

        console.log('[TransformControls] Detached');
    }

    /**
     * Set the transform mode
     */
    setMode(mode: TransformMode): void {
        if (mode === 'scale' && !this.scaleEnabled) return;

        this.currentMode = mode;

        if (this.transformControls) {
            this.transformControls.setMode(mode);
        }

        this.updateButtonStates();

        console.log('[TransformControls] Mode:', mode);
    }

    /**
     * Get the current transform mode
     */
    getMode(): TransformMode {
        return this.currentMode;
    }

    /**
     * Check if controls are attached to an object
     */
    isAttached(): boolean {
        return this.currentObject !== null;
    }

    /**
     * Get the currently attached object
     */
    getAttachedObject(): THREE.Object3D | null {
        return this.currentObject;
    }

    /**
     * Check if the gizmo is currently being hovered or dragged
     * Used by camera controller to avoid handling mouse events when gizmo is active
     */
    isGizmoActive(): boolean {
        if (!this.transformControls) return false;
        // TransformControls sets 'axis' to non-null when hovering over a control
        // and 'dragging' to true when actively dragging
        const gizmo = this.transformControls as unknown as { axis: string | null; dragging: boolean };
        return gizmo.axis !== null || gizmo.dragging === true;
    }

    /**
     * Snap object to ground (places bottom of bounding box on ground surface)
     * Called when Snap button is clicked
     */
    snapToGround(): void {
        if (!this.currentObject || !this.pivot || !this.callbacks.getGroundHeight) return;
        this.callbacks.onBeforeTransform?.(this.currentObject);

        // Get current bounding box to find the bottom of the object
        const box = new THREE.Box3().setFromObject(this.currentObject);
        const bottomY = box.min.y;
        const objectY = this.currentObject.position.y;

        // Distance from object's origin to its bottom
        const groundOffset = objectY - bottomY;

        // Get ground height at object's current X/Z position (exclude self from raycast)
        const groundY = this.callbacks.getGroundHeight(
            this.currentObject.position.x,
            this.currentObject.position.z,
            this.currentObject
        );

        // Snap object so its bottom touches the ground
        this.currentObject.position.y = groundY + groundOffset;

        // Update pivot position to match (accounting for bounding box offset)
        const newBox = new THREE.Box3().setFromObject(this.currentObject);
        newBox.getCenter(this.boundingBoxCenter);
        this.pivot.position.copy(this.boundingBoxCenter);

        // Update physics for VoxelObjects
        this.syncPhysicsTransform(this.currentObject);

        // Mark scene as changed
        this.callbacks.markSceneChanges?.(this.currentObject);
        this.updateUndoButtonVisibility();
    }

    /**
     * Update the camera reference (if camera changes)
     */
    updateCamera(camera: THREE.PerspectiveCamera): void {
        this.camera = camera;
        if (this.transformControls) {
            // TransformControls needs to be recreated with new camera
            const wasAttached = this.currentObject;
            this.detach();
            this.scene.remove(this.transformControls.getHelper());
            if (this.pivot) {
                this.scene.remove(this.pivot);
            }
            this.transformControls.dispose();
            this.createControls();
            if (wasAttached) {
                this.attach(wasAttached);
            }
        }
    }

    /**
     * Dispose of the transform controls manager
     */
    dispose(): void {
        // Remove transform controls from scene
        if (this.transformControls) {
            this.transformControls.detach();
            this.scene.remove(this.transformControls.getHelper());
            this.transformControls.dispose();
            this.transformControls = null;
        }

        // Remove pivot from scene
        if (this.pivot) {
            this.scene.remove(this.pivot);
            this.pivot = null;
        }

        // Remove toolbar
        if (this.toolbar && this.toolbar.parentElement) {
            this.toolbar.parentElement.removeChild(this.toolbar);
            this.toolbar = null;
        }

        this.currentObject = null;
    }
}
