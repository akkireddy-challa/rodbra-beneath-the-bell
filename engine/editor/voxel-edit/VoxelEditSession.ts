/**
 * VoxelEditSession — the one interactive voxel editor (design:
 * docs/voxel-editor-design.md §4.1).
 *
 * Owns everything volume-independent about editing: the selection set,
 * tap-vs-drag click handling, the add-voxel context menu, keyboard
 * bindings (Delete, Shift+WASD/QE moves, Ctrl+Z undo, Escape), selection
 * highlights, the per-action undo log, and has-changes tracking. All
 * voxel data access goes through an `IEditableVoxelVolume` — the session
 * never touches chunks, leaves, or coordinate conversions itself.
 *
 * Replaces the per-backend halves of the old `TerrainEditManager` and
 * `VoxelObjectEditMode` (both deleted with the Voxels tab).
 */

import * as THREE from 'three';
import {
    type EditVoxel,
    type IEditableVoxelVolume,
    type VoxelMaterial,
    fuzzinessToThreshold,
    materialsEqual,
} from './VoxelEditTypes.js';

export interface VoxelEditSessionDeps {
    scene: THREE.Scene;
    /** Only `domElement` is used, so both renderer backends work. */
    renderer: { domElement: HTMLCanvasElement };
    camera: THREE.PerspectiveCamera;
}

export interface VoxelEditSessionCallbacks {
    /** Selection changed (click, flood-select, post-edit reselection, clear). */
    onSelectionChanged: (selected: EditVoxel[]) => void;
    /** Fired after every committed mutation batch (add/remove/material/move/undo). */
    onEdited: () => void;
    /** Escape pressed — the host decides whether to prompt, cancel, or commit. */
    onRequestExit: () => void;
    setOutlineObjects: ((objects: THREE.Object3D[]) => void) | null;
    /** When locked, mutations are rejected and `onLockedAction` fires instead. */
    isLocked: (() => boolean) | null;
    onLockedAction: (() => void) | null;
}

/** One reversible mutation. A user action groups several into a batch. */
type EditOp =
    | { type: 'add'; voxel: EditVoxel }
    | { type: 'remove'; voxel: EditVoxel }
    | { type: 'material'; before: EditVoxel; after: EditVoxel }
    | { type: 'slot'; before: EditVoxel; after: EditVoxel }
    | { type: 'move'; from: EditVoxel; to: EditVoxel };

const TAP_THRESHOLD_MS = 200;
const TAP_DISTANCE_THRESHOLD = 5;

/**
 * Above this many selected voxels the outline pass is skipped and the tinted
 * overlay carries the highlight alone. `selectSimilar` routinely selects tens
 * of thousands, and OutlinePass re-renders every selected object into its own
 * depth buffer — cheap for a handful, a stall for a whole material.
 */
const OUTLINE_MAX_VOXELS = 512;

export class VoxelEditSession {
    private deps: VoxelEditSessionDeps;
    private callbacks: VoxelEditSessionCallbacks;
    private raycaster = new THREE.Raycaster();

    private volume: IEditableVoxelVolume | null = null;
    private baselineChecksum = 0;

    private selected: EditVoxel[] = [];
    private highlightMesh: THREE.InstancedMesh | null = null;
    private lastMaterial: VoxelMaterial | null = null;

    /**
     * The voxel `selectSimilar` measures against. Held across slider drags so
     * re-running at a new fuzziness compares to the originally clicked voxel,
     * not to whatever the last sweep happened to select.
     */
    private similarityAnchor: EditVoxel | null = null;

    private undoLog: EditOp[][] = [];

    private contextMenu: HTMLElement | null = null;
    private pendingAdd: { x: number; y: number; z: number; size: number } | null = null;

    private mouseDownTime = 0;
    private mouseDownX = 0;
    private mouseDownY = 0;

    private boundOnMouseDown: ((e: MouseEvent) => void) | null = null;
    private boundOnMouseUp: ((e: MouseEvent) => void) | null = null;
    private boundOnContextMenu: ((e: MouseEvent) => void) | null = null;
    private boundOnKeyDown: ((e: KeyboardEvent) => void) | null = null;
    private boundOnDocumentClick: ((e: MouseEvent) => void) | null = null;

    constructor(deps: VoxelEditSessionDeps, callbacks: VoxelEditSessionCallbacks) {
        this.deps = deps;
        this.callbacks = callbacks;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    enter(volume: IEditableVoxelVolume): void {
        if (this.volume) this.exit({ committed: false });

        this.volume = volume;
        volume.onSessionStart();
        this.baselineChecksum = volume.checksum();
        this.undoLog = [];
        this.selected = [];
        this.similarityAnchor = null;
        this.lastMaterial = volume.defaultMaterial();

        this.attachListeners();
        this.createContextMenu();
    }

    /**
     * End the session. `committed: true` means the host persisted (or will
     * persist) the current state; `false` means it is walking away from it
     * (typically after `undoAll()` via `cancel()`).
     */
    exit(opts: { committed: boolean }): void {
        if (!this.volume) return;

        this.detachListeners();
        this.removeContextMenu();
        this.clearHighlights();
        this.selected = [];
        this.similarityAnchor = null;
        this.undoLog = [];

        const volume = this.volume;
        this.volume = null;
        volume.onSessionEnd(opts.committed);
        this.callbacks.onSelectionChanged([]);
    }

    /** Revert every change made this session, then exit. */
    cancel(): void {
        if (!this.volume) return;
        this.undoAll();
        this.exit({ committed: false });
    }

    isActive(): boolean {
        return this.volume !== null;
    }

    getVolume(): IEditableVoxelVolume | null {
        return this.volume;
    }

    /** Per-frame tick (orbit-control damping etc.). */
    update(): void {
        this.volume?.update();
    }

    // ------------------------------------------------------------------
    // Change tracking
    // ------------------------------------------------------------------

    hasChanges(): boolean {
        if (!this.volume) return false;
        return this.volume.checksum() !== this.baselineChecksum;
    }

    /** Reset the changes baseline after the host persisted the volume. */
    markCommitted(): void {
        if (!this.volume) return;
        this.baselineChecksum = this.volume.checksum();
        this.undoLog = [];
    }

    // ------------------------------------------------------------------
    // Selection
    // ------------------------------------------------------------------

    getSelected(): EditVoxel[] {
        return this.selected;
    }

    getLastMaterial(): VoxelMaterial | null {
        return this.lastMaterial;
    }

    setLastMaterial(material: VoxelMaterial): void {
        this.lastMaterial = material;
    }

    clearSelection(): void {
        this.selected = [];
        this.similarityAnchor = null;
        this.refreshHighlights();
        this.callbacks.onSelectionChanged(this.selected);
    }

    /**
     * The voxel `selectSimilar` compares against — the last one picked by hand.
     * Null when nothing has been clicked, which is when the fuzziness slider
     * has nothing to work from.
     */
    getSimilarityAnchor(): EditVoxel | null {
        return this.similarityAnchor;
    }

    /**
     * Replace the selection with every voxel in the volume whose color is
     * within `fuzziness` (0-100) of the anchor's. Re-runs from the SAME anchor
     * each time, so dragging the slider back and forth is non-destructive
     * rather than progressively swallowing the object.
     *
     * Returns the number of voxels selected, or -1 when there is no anchor.
     */
    selectSimilar(fuzziness: number): number {
        if (!this.volume) return -1;
        const anchor = this.similarityAnchor;
        if (!anchor) return -1;

        const matches = this.volume.selectSimilar(anchor, fuzzinessToThreshold(fuzziness));
        // The anchor itself must survive even at fuzziness 0, whatever the
        // volume's sweep decided about floating-point equality.
        this.selected = matches.length > 0 ? matches : [anchor];
        this.refreshHighlights();
        this.callbacks.onSelectionChanged(this.selected);
        return this.selected.length;
    }

    /**
     * Select from a world-space hit (also the entry point for the scene
     * editor's initial click handoff when the session starts on a click).
     */
    selectFromHit(point: THREE.Vector3, normalWorld: THREE.Vector3, additive: boolean): boolean {
        if (!this.volume) return false;
        const voxel = this.volume.pickVoxel({ point, normalWorld });
        if (!voxel) {
            if (!additive) this.clearSelection();
            return false;
        }
        this.selectVoxel(voxel, additive);
        return true;
    }

    selectVoxel(voxel: EditVoxel, additive: boolean): void {
        const idx = this.selected.findIndex(v => this.samePosition(v, voxel));
        if (idx >= 0) {
            if (additive) {
                // Ctrl-click on an already-selected voxel deselects it.
                this.selected.splice(idx, 1);
                this.refreshHighlights();
                this.callbacks.onSelectionChanged(this.selected);
            }
            return;
        }

        if (additive) this.selected.push(voxel);
        else this.selected = [voxel];

        this.lastMaterial = voxel.material;
        // A hand-picked voxel is what "similar to THIS" means from here on.
        this.similarityAnchor = voxel;
        this.refreshHighlights();
        this.callbacks.onSelectionChanged(this.selected);
    }

    /** Flood-select all connected voxels sharing the selected voxel's material. */
    selectConnectedSameMaterial(): boolean {
        if (!this.volume || this.selected.length !== 1) return false;
        const start = this.selected[0];
        if (!start) return false;

        const visited = new Set<string>();
        const toVisit: EditVoxel[] = [start];
        const result: EditVoxel[] = [];

        while (toVisit.length > 0) {
            const current = toVisit.pop()!;
            const key = this.positionKey(current);
            if (visited.has(key)) continue;
            visited.add(key);
            result.push(current);

            for (const neighbor of this.volume.sameMaterialNeighbors(current)) {
                if (!visited.has(this.positionKey(neighbor))) toVisit.push(neighbor);
            }
        }

        this.selected = result;
        this.refreshHighlights();
        this.callbacks.onSelectionChanged(this.selected);
        return true;
    }

    // ------------------------------------------------------------------
    // Mutations (each is one undo batch)
    // ------------------------------------------------------------------

    deleteSelected(): boolean {
        if (!this.volume || this.selected.length === 0) return false;
        if (this.rejectWhenLocked()) return false;

        const batch: EditOp[] = [];
        for (const voxel of [...this.selected]) {
            if (this.volume.remove(voxel)) {
                batch.push({ type: 'remove', voxel });
            }
        }
        if (batch.length === 0) return false;

        this.selected = [];
        this.commitBatch(batch);
        this.callbacks.onSelectionChanged(this.selected);
        return true;
    }

    addVoxelAt(x: number, y: number, z: number, size: number, material: VoxelMaterial): boolean {
        if (!this.volume) return false;
        if (this.rejectWhenLocked()) return false;

        const created = this.volume.add(x, y, z, size, material);
        if (!created) return false;

        this.selected = [created];
        this.lastMaterial = created.material;
        this.commitBatch([{ type: 'add', voxel: created }]);
        this.callbacks.onSelectionChanged(this.selected);
        return true;
    }

    changeSelectedMaterial(material: VoxelMaterial): boolean {
        if (!this.volume || this.selected.length === 0) return false;
        if (this.rejectWhenLocked()) return false;

        const batch: EditOp[] = [];
        const updated: EditVoxel[] = [];
        for (const voxel of this.selected) {
            if (materialsEqual(voxel.material, material)) {
                updated.push(voxel);
                continue;
            }
            const after = this.volume.changeMaterial(voxel, material);
            if (after) {
                batch.push({ type: 'material', before: voxel, after });
                updated.push(after);
            } else {
                updated.push(voxel);
            }
        }
        if (batch.length === 0) return false;

        this.selected = updated;
        this.lastMaterial = material;
        this.commitBatch(batch);
        this.callbacks.onSelectionChanged(this.selected);
        return true;
    }

    /**
     * Move every selected voxel into material `slot` (0 = the base material).
     *
     * One undo step for the whole assignment. This is how a selection is made
     * to glow: the glow lives on the material, so assigning an emissive
     * material lights exactly these voxels and nothing else that happens to
     * share their colour.
     */
    setSelectedSlot(slot: number): boolean {
        if (!this.volume || this.selected.length === 0) return false;
        if (!this.volume.capabilities().materials) return false;
        if (this.rejectWhenLocked()) return false;

        const batch: EditOp[] = [];
        const updated: EditVoxel[] = [];
        for (const voxel of this.selected) {
            if (voxel.slot === slot) {
                updated.push(voxel);
                continue;
            }
            const after = this.volume.setSlot(voxel, slot);
            if (after) {
                batch.push({ type: 'slot', before: voxel, after });
                updated.push(after);
            } else {
                updated.push(voxel);
            }
        }
        if (batch.length === 0) return false;

        this.selected = updated;
        this.commitBatch(batch);
        this.callbacks.onSelectionChanged(this.selected);
        return true;
    }

    /**
     * Move the selection one step. XZ input is camera-aligned (W = away
     * from camera), Y is absolute. Each voxel steps by its own size, so
     * variable-size octree voxels stay grid-aligned.
     */
    moveSelected(dx: number, dy: number, dz: number): boolean {
        if (!this.volume || this.selected.length === 0) return false;
        if (this.rejectWhenLocked()) return false;

        let finalDx = dx;
        let finalDz = dz;
        if (dx !== 0 || dz !== 0) {
            const aligned = this.cameraAlignXZ(dx, dz);
            finalDx = aligned.dx;
            finalDz = aligned.dz;
        }
        if (finalDx === 0 && dy === 0 && finalDz === 0) return false;

        const targets = this.selected.map(voxel => ({
            voxel,
            x: voxel.x + finalDx * voxel.size,
            y: voxel.y + dy * voxel.size,
            z: voxel.z + finalDz * voxel.size,
        }));

        // Occupancy: each target must be empty (or vacated by the move itself)
        // and no two moved voxels may land on the same cell.
        const vacated = new Set(this.selected.map(v => this.positionKey(v)));
        const targetKeys = new Set<string>();
        for (const t of targets) {
            const key = `${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)}`;
            if (targetKeys.has(key)) return false;
            targetKeys.add(key);
            if (vacated.has(key)) continue;
            if (this.volume.voxelAt(t.x, t.y, t.z) !== null) return false;
        }

        // Remove all, then re-add all — order-independent for overlapping moves.
        for (const t of targets) this.volume.remove(t.voxel);

        const batch: EditOp[] = [];
        const moved: EditVoxel[] = [];
        for (const t of targets) {
            const added = this.volume.add(t.x, t.y, t.z, t.voxel.size, t.voxel.material);
            if (added) {
                batch.push({ type: 'move', from: t.voxel, to: added });
                moved.push(added);
            }
        }

        this.selected = moved;
        this.commitBatch(batch);
        this.callbacks.onSelectionChanged(this.selected);
        return true;
    }

    /** Copy the (single) selected voxel into the first free adjacent cell. */
    duplicateSelected(): boolean {
        if (!this.volume || this.selected.length === 0) return false;
        if (this.rejectWhenLocked()) return false;

        const voxel = this.selected[0];
        if (!voxel) return false;
        const s = voxel.size;
        const offsets = [
            [0, s, 0],
            [s, 0, 0], [-s, 0, 0],
            [0, 0, s], [0, 0, -s],
            [0, -s, 0],
        ] as const;

        for (const [ox, oy, oz] of offsets) {
            const x = voxel.x + ox, y = voxel.y + oy, z = voxel.z + oz;
            if (this.volume.voxelAt(x, y, z) === null) {
                return this.addVoxelAt(x, y, z, s, voxel.material);
            }
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Undo
    // ------------------------------------------------------------------

    undo(): boolean {
        if (!this.volume) return false;
        const batch = this.undoLog.pop();
        if (!batch) return false;

        this.revertBatch(batch, this.volume);

        this.volume.refresh();
        this.selected = [];
        this.refreshHighlights();
        // Every session op undone ⇒ logically back at the baseline. Re-baseline
        // explicitly: representation-level residue (e.g. a terrain chunk's
        // palette keeps entries for removed block types) would otherwise make
        // the checksum report phantom unsaved changes.
        if (this.undoLog.length === 0) {
            this.baselineChecksum = this.volume.checksum();
        }
        this.callbacks.onSelectionChanged(this.selected);
        this.callbacks.onEdited();
        return true;
    }

    undoAll(): void {
        while (this.undoLog.length > 0) {
            const batch = this.undoLog.pop()!;
            if (this.volume) this.revertBatch(batch, this.volume);
        }
        if (this.volume) {
            this.volume.refresh();
            this.selected = [];
            this.refreshHighlights();
            // Log fully drained ⇒ baseline state (see undo() for why the
            // checksum may still differ representationally).
            this.baselineChecksum = this.volume.checksum();
            this.callbacks.onSelectionChanged(this.selected);
            this.callbacks.onEdited();
        }
    }

    /** Reverse every op in a batch (applied newest-first), without refreshing. */
    private revertBatch(batch: EditOp[], volume: IEditableVoxelVolume): void {
        for (let i = batch.length - 1; i >= 0; i--) {
            const op = batch[i];
            if (!op) continue;
            switch (op.type) {
                case 'add':
                    volume.remove(op.voxel);
                    break;
                case 'remove':
                    volume.add(op.voxel.x, op.voxel.y, op.voxel.z, op.voxel.size, op.voxel.material);
                    break;
                case 'material':
                    volume.changeMaterial(op.after, op.before.material);
                    break;
                case 'slot':
                    volume.setSlot(op.after, op.before.slot);
                    break;
                case 'move':
                    volume.remove(op.to);
                    volume.add(op.from.x, op.from.y, op.from.z, op.from.size, op.from.material);
                    break;
            }
        }
    }

    private commitBatch(batch: EditOp[]): void {
        if (!this.volume) return;
        this.undoLog.push(batch);
        this.volume.refresh();
        this.refreshHighlights();
        this.callbacks.onEdited();
    }

    private rejectWhenLocked(): boolean {
        if (this.callbacks.isLocked?.()) {
            this.callbacks.onLockedAction?.();
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Input
    // ------------------------------------------------------------------

    private attachListeners(): void {
        this.boundOnMouseDown = this.onMouseDown.bind(this);
        this.boundOnMouseUp = this.onMouseUp.bind(this);
        this.boundOnContextMenu = this.onContextMenu.bind(this);
        this.boundOnKeyDown = this.onKeyDown.bind(this);
        this.boundOnDocumentClick = this.onDocumentClick.bind(this);

        const el = this.deps.renderer.domElement;
        el.addEventListener('mousedown', this.boundOnMouseDown);
        el.addEventListener('mouseup', this.boundOnMouseUp);
        el.addEventListener('contextmenu', this.boundOnContextMenu);
        document.addEventListener('keydown', this.boundOnKeyDown);
        document.addEventListener('click', this.boundOnDocumentClick);
    }

    private detachListeners(): void {
        const el = this.deps.renderer.domElement;
        if (this.boundOnMouseDown) el.removeEventListener('mousedown', this.boundOnMouseDown);
        if (this.boundOnMouseUp) el.removeEventListener('mouseup', this.boundOnMouseUp);
        if (this.boundOnContextMenu) el.removeEventListener('contextmenu', this.boundOnContextMenu);
        if (this.boundOnKeyDown) document.removeEventListener('keydown', this.boundOnKeyDown);
        if (this.boundOnDocumentClick) document.removeEventListener('click', this.boundOnDocumentClick);
        this.boundOnMouseDown = null;
        this.boundOnMouseUp = null;
        this.boundOnContextMenu = null;
        this.boundOnKeyDown = null;
        this.boundOnDocumentClick = null;
    }

    private onMouseDown(event: MouseEvent): void {
        if (event.button !== 0) return;
        this.mouseDownTime = Date.now();
        this.mouseDownX = event.clientX;
        this.mouseDownY = event.clientY;
        this.hideContextMenu();
    }

    private onMouseUp(event: MouseEvent): void {
        if (event.button !== 0 || !this.volume) return;

        // Tap, not drag (camera rotation) — same thresholds the old editors used.
        const elapsed = Date.now() - this.mouseDownTime;
        const dist = Math.hypot(event.clientX - this.mouseDownX, event.clientY - this.mouseDownY);
        if (elapsed >= TAP_THRESHOLD_MS || dist >= TAP_DISTANCE_THRESHOLD) return;

        const hit = this.raycastVolume(event.clientX, event.clientY);
        const additive = event.ctrlKey || event.metaKey;
        if (hit) {
            this.selectFromHit(hit.point, hit.normalWorld, additive);
        } else if (!additive) {
            this.clearSelection();
        }
    }

    private onContextMenu(event: MouseEvent): void {
        if (!this.volume) return;
        if (this.callbacks.isLocked?.()) return;

        event.preventDefault();
        event.stopPropagation();

        const hit = this.raycastVolume(event.clientX, event.clientY);
        if (!hit) return;
        const addPos = this.volume.addPositionFor(hit);
        if (!addPos) return;

        this.pendingAdd = addPos;
        this.showContextMenu(event.clientX, event.clientY);
    }

    private onKeyDown(event: KeyboardEvent): void {
        // Typing into the toolbar is not a shortcut. These listeners are on
        // `document`, so every key aimed at a field in the panel arrives here
        // too, and the collisions are destructive rather than merely annoying:
        // Backspace DELETES THE SELECTED VOXELS while you name a material,
        // Escape ends the whole session, Ctrl+Z undoes a voxel edit instead of
        // the text, and the Shift+WASD block below moves geometry on the capital
        // letters in "Sign" or "Window".
        //
        // SELECT is in the list because the "Made of" dropdown already had this
        // bug: with it focused, `s` jumped to `stone` AND moved the selection.
        // It was unreachable while the only text entry in a session was a
        // `window.prompt`, which is a browser modal the page never sees keys
        // from — the moment the toolbar grew a real field, it was live.
        const target = event.target as HTMLElement | null;
        if (target && (target.isContentEditable
            || target.tagName === 'INPUT'
            || target.tagName === 'TEXTAREA'
            || target.tagName === 'SELECT')) {
            return;
        }

        this.hideContextMenu();
        if (!this.volume) return;

        if (event.key === 'Escape') {
            this.callbacks.onRequestExit();
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            this.undo();
            return;
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            if (this.selected.length > 0) {
                event.preventDefault();
                this.deleteSelected();
            }
            return;
        }

        // Shift+WASD/QE moves the selection; bare WASD stays free for the camera.
        if (this.selected.length > 0 && event.shiftKey) {
            let moved = false;
            switch (event.key.toLowerCase()) {
                case 'w': moved = this.moveSelected(0, 0, -1); break;
                case 's': moved = this.moveSelected(0, 0, 1); break;
                case 'a': moved = this.moveSelected(-1, 0, 0); break;
                case 'd': moved = this.moveSelected(1, 0, 0); break;
                case 'q': moved = this.moveSelected(0, -1, 0); break;
                case 'e': moved = this.moveSelected(0, 1, 0); break;
            }
            if (moved) event.preventDefault();
        }
    }

    private onDocumentClick(event: MouseEvent): void {
        if (this.contextMenu && !this.contextMenu.contains(event.target as Node)) {
            this.hideContextMenu();
        }
    }

    private raycastVolume(clientX: number, clientY: number): { point: THREE.Vector3; normalWorld: THREE.Vector3 } | null {
        if (!this.volume) return null;

        const rect = this.deps.renderer.domElement.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((clientY - rect.top) / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.deps.camera);

        const intersects = this.raycaster.intersectObjects(this.volume.getPickMeshes(), false);
        const hit = intersects[0];
        if (!hit) return null;

        const normalWorld = hit.face
            ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
            : new THREE.Vector3(0, 1, 0);
        return { point: hit.point.clone(), normalWorld };
    }

    private cameraAlignXZ(dx: number, dz: number): { dx: number; dz: number } {
        const forward = new THREE.Vector3();
        this.deps.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3();
        right.crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();
        right.negate();

        const outputX = dx * right.x + (-dz) * forward.x;
        const outputZ = dx * right.z + (-dz) * forward.z;

        let finalDx = Math.round(outputX);
        let finalDz = Math.round(outputZ);
        if (Math.abs(finalDx) > 0 && Math.abs(finalDz) > 0) {
            if (Math.abs(outputX) > Math.abs(outputZ)) finalDz = 0;
            else finalDx = 0;
        }
        return { dx: finalDx, dz: finalDz };
    }

    // ------------------------------------------------------------------
    // Highlights
    // ------------------------------------------------------------------

    /**
     * One `InstancedMesh` for the whole selection.
     *
     * A mesh per voxel was fine when selections were hand-clicked handfuls;
     * `selectSimilar` makes 50k-voxel selections routine, and 50k
     * BoxGeometries plus 50k draw calls hangs the tab. Instancing keeps that
     * to one geometry, one material and one draw call — the unit-cube geometry
     * is scaled per instance, which also handles the octree's variable leaf
     * sizes for free.
     */
    private refreshHighlights(): void {
        this.clearHighlights();
        if (!this.volume || this.selected.length === 0) return;

        const quaternion = this.volume.getHighlightQuaternion();
        const padding = 0.02;

        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            transparent: true,
            // Large selections get no outline (see OUTLINE_MAX_VOXELS), so the
            // tint has to read on its own; small ones keep the lighter wash
            // that the outline sits on top of.
            opacity: this.selected.length > OUTLINE_MAX_VOXELS ? 0.35 : 0.15,
            depthTest: true,
            depthWrite: false,
        });

        const mesh = new THREE.InstancedMesh(geometry, material, this.selected.length);
        const matrix = new THREE.Matrix4();
        const scale = new THREE.Vector3();
        for (let i = 0; i < this.selected.length; i++) {
            const voxel = this.selected[i]!;
            const size = voxel.size + padding * 2;
            scale.set(size, size, size);
            matrix.compose(voxel.worldCenter, quaternion, scale);
            mesh.setMatrixAt(i, matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.name = 'VoxelEditHighlight';
        mesh.renderOrder = 999;
        mesh.frustumCulled = false;
        mesh.raycast = () => {};

        this.deps.scene.add(mesh);
        this.highlightMesh = mesh;

        this.callbacks.setOutlineObjects?.(
            this.selected.length <= OUTLINE_MAX_VOXELS ? [mesh] : [],
        );
    }

    private clearHighlights(): void {
        this.callbacks.setOutlineObjects?.([]);
        if (this.highlightMesh) {
            this.deps.scene.remove(this.highlightMesh);
            this.highlightMesh.geometry.dispose();
            (this.highlightMesh.material as THREE.Material).dispose();
            this.highlightMesh.dispose();
            this.highlightMesh = null;
        }
    }

    // ------------------------------------------------------------------
    // Context menu (game-side DOM, matching the editor-dir pattern)
    // ------------------------------------------------------------------

    private createContextMenu(): void {
        this.contextMenu = document.createElement('div');
        this.contextMenu.id = 'voxel-edit-context-menu';
        this.contextMenu.style.cssText = `
            position: fixed;
            background: rgba(15, 23, 42, 0.98);
            border: 1px solid #334155;
            border-radius: 8px;
            padding: 4px 0;
            min-width: 160px;
            z-index: 10000;
            display: none;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;
        document.body.appendChild(this.contextMenu);
    }

    private showContextMenu(x: number, y: number): void {
        if (!this.contextMenu || !this.volume) return;

        const material = this.lastMaterial ?? this.volume.defaultMaterial();
        this.contextMenu.innerHTML = '';

        const addItem = document.createElement('div');
        addItem.textContent = `➕ Add ${this.volume.materialName(material)}`;
        addItem.style.cssText = `
            padding: 10px 16px;
            cursor: pointer;
            color: white;
            font-size: 13px;
            transition: background 0.15s;
        `;
        addItem.onmouseenter = () => { addItem.style.background = '#1e40af'; };
        addItem.onmouseleave = () => { addItem.style.background = 'transparent'; };
        addItem.onclick = () => {
            if (this.pendingAdd) {
                this.addVoxelAt(this.pendingAdd.x, this.pendingAdd.y, this.pendingAdd.z, this.pendingAdd.size, material);
            }
            this.hideContextMenu();
        };
        this.contextMenu.appendChild(addItem);

        this.contextMenu.style.left = `${x}px`;
        this.contextMenu.style.top = `${y}px`;
        this.contextMenu.style.display = 'block';
    }

    private hideContextMenu(): void {
        if (this.contextMenu) this.contextMenu.style.display = 'none';
        this.pendingAdd = null;
    }

    private removeContextMenu(): void {
        this.contextMenu?.remove();
        this.contextMenu = null;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private positionKey(voxel: EditVoxel): string {
        return `${voxel.x.toFixed(3)},${voxel.y.toFixed(3)},${voxel.z.toFixed(3)}`;
    }

    private samePosition(a: EditVoxel, b: EditVoxel): boolean {
        return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001 && Math.abs(a.z - b.z) < 0.001;
    }
}
