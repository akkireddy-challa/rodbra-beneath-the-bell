/**
 * Right-click context menu for the scene editor — extracted from
 * `EditorManager` so that file stays under the 2000-line ESLint cap and
 * gets some real headroom for future growth. Mirrors the manager-class
 * pattern already used in this directory (`SceneHierarchyPanel`,
 * `SceneInfoPanel`, `TransformControlsManager`): constructor takes a
 * `deps` bundle of engine refs + getters + callbacks; the host
 * (`EditorManager`) holds one instance and calls `attach()` /
 * `detach()` from its mouse-listener setup.
 *
 * Owns three pieces of state that used to live on `EditorManager`:
 *   - `contextMenu`        — the open menu's DOM element (null when closed)
 *   - `contextMenuPosition` — last right-click coords (read by the
 *                              raycast helpers when a menu item fires)
 *   - `markerPreviewDot`    — red preview sphere shown at the right-click
 *                              point while the menu is open
 *
 * The host owns:
 *   - `spawnPointMarkers` map (we read it to find the player marker)
 *   - `spawnPointsDirty` flag (we toggle it via the `markSpawnPointsDirty`
 *      callback when "Set player spawn point" is clicked)
 *   - Editor-mode / object-edit-mode / terrain-edit / scene-lock gates
 *      (we read them via the `is*` callbacks before opening the menu)
 *   - The selection + scene-hierarchy refresh actions (callbacks)
 */

import { isPickableOnScreen } from 'engine/GlbInstancing.js';
import * as THREE from 'three';
import type { MarkerSystem } from '../debug/MarkerSystem.js';
import type { SceneEditor } from './SceneEditor.js';
import { SpawnPointMarker } from './SpawnPointMarker.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';

export interface EditorContextMenuDeps {
    /** Subset of `EngineLike` the context menu actually reads. */
    engine: {
        renderer: { domElement: HTMLElement };
        camera: THREE.PerspectiveCamera;
        scene: THREE.Scene;
    };
    raycaster: THREE.Raycaster;
    markerSystem: MarkerSystem;
    sceneEditor: SceneEditor;
    spawnPointMarkers: Map<string, SpawnPointMarker>;

    /** Gates — checked before opening the menu. */
    isEditorMode: () => boolean;
    isInObjectEditMode: () => boolean;
    isTerrainEditEnabled: () => boolean;
    /** Drives the "Add object" item's enabled/disabled state. */
    isSceneEditingLocked: () => boolean;

    /** Highlight the given object in the scene hierarchy + inspector. */
    selectObject: (object: THREE.Object3D, focusCamera: boolean) => void;
    /** Refresh the scene hierarchy panel after a marker was added. */
    refreshSceneHierarchy: () => void;
    /** Tell EditorManager the spawn-point markers were edited (sets
     *  `spawnPointsDirty` so the change is included in the next save). */
    markSpawnPointsDirty: () => void;
}

export class EditorContextMenu {
    private deps: EditorContextMenuDeps;
    private contextMenu: HTMLDivElement | null = null;
    private contextMenuPosition: { x: number; y: number } = { x: 0, y: 0 };
    private markerPreviewDot: THREE.Mesh | null = null;
    private readonly onContextMenuBound: (event: MouseEvent) => void;

    constructor(deps: EditorContextMenuDeps) {
        this.deps = deps;
        this.onContextMenuBound = this.onContextMenu.bind(this);
    }

    /** Hook the canvas's `contextmenu` event. Called by the host when
     *  it sets up debug mouse listeners (entering editor mode). */
    attach(): void {
        this.deps.engine.renderer.domElement.addEventListener('contextmenu', this.onContextMenuBound);
    }

    /** Unhook the event and close any open menu. Called when leaving editor mode. */
    detach(): void {
        this.deps.engine.renderer.domElement.removeEventListener('contextmenu', this.onContextMenuBound);
        this.hideContextMenu();
    }

    /**
     * Handle right-click context menu.
     * Markers can be added even when scene editing is locked (they are AI
     * guides, not scene objects).
     */
    private onContextMenu(event: MouseEvent): void {
        if (!this.deps.isEditorMode()) return;
        // Skip if in object edit mode — it has its own context menu.
        if (this.deps.isInObjectEditMode()) return;
        // Skip if a voxel edit session is active — it has its own context menu.
        if (this.deps.isTerrainEditEnabled()) return;

        event.preventDefault();
        event.stopPropagation();

        this.hideContextMenu();
        this.contextMenuPosition.x = event.clientX;
        this.contextMenuPosition.y = event.clientY;
        this.showContextMenu(event.clientX, event.clientY);
    }

    private showContextMenu(x: number, y: number): void {
        this.hideContextMenu();
        this.showMarkerPreviewDot(x, y);

        const menu = document.createElement('div');
        menu.id = 'scene-context-menu';
        menu.style.cssText = `
            position: fixed;
            left: ${x}px;
            top: ${y}px;
            background: #2d3748;
            border: 1px solid #4a5568;
            border-radius: 4px;
            padding: 4px 0;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            min-width: 180px;
        `;

        // "Add a marker" — always enabled (markers are AI guides, not scene objects).
        const addMarkerItem = document.createElement('div');
        addMarkerItem.textContent = 'Add a marker';
        addMarkerItem.style.cssText = `
            padding: 8px 16px;
            color: white;
            cursor: pointer;
            font-size: 13px;
            transition: background-color 0.2s;
        `;
        addMarkerItem.onmouseenter = () => { addMarkerItem.style.backgroundColor = '#4a5568'; };
        addMarkerItem.onmouseleave = () => { addMarkerItem.style.backgroundColor = 'transparent'; };
        addMarkerItem.onclick = () => {
            this.addMarkerAtClickPosition();
            this.hideContextMenu();
        };
        menu.appendChild(addMarkerItem);

        // "Add object" — only enabled when scene editing is unlocked.
        const addObjectItem = document.createElement('div');
        addObjectItem.textContent = 'Add object';
        const isSceneEditingEnabled = !this.deps.isSceneEditingLocked();

        if (isSceneEditingEnabled) {
            addObjectItem.style.cssText = `
                padding: 8px 16px;
                color: white;
                cursor: pointer;
                font-size: 13px;
                transition: background-color 0.2s;
                border-top: 1px solid #4a5568;
            `;
            addObjectItem.onmouseenter = () => { addObjectItem.style.backgroundColor = '#4a5568'; };
            addObjectItem.onmouseleave = () => { addObjectItem.style.backgroundColor = 'transparent'; };
            addObjectItem.onclick = () => {
                // Pass the context menu position to SceneEditor (same as markers use).
                this.deps.sceneEditor.setContextMenuPosition(this.contextMenuPosition);
                this.deps.sceneEditor.showAddObjectDialog();
                this.hideContextMenu();
            };
        } else {
            addObjectItem.style.cssText = `
                padding: 8px 16px;
                color: #64748b;
                cursor: not-allowed;
                font-size: 13px;
                border-top: 1px solid #4a5568;
                opacity: 0.5;
            `;
            addObjectItem.title = 'Scene editing is locked. Enable scene editing in the Scene tab to add objects.';
        }
        menu.appendChild(addObjectItem);

        // "Set player spawn point" — always enabled.
        const setSpawnItem = document.createElement('div');
        setSpawnItem.textContent = 'Set player spawn point';
        setSpawnItem.style.cssText = `
            padding: 8px 16px;
            color: white;
            cursor: pointer;
            font-size: 13px;
            transition: background-color 0.2s;
            border-top: 1px solid #4a5568;
        `;
        setSpawnItem.onmouseenter = () => { setSpawnItem.style.backgroundColor = '#4a5568'; };
        setSpawnItem.onmouseleave = () => { setSpawnItem.style.backgroundColor = 'transparent'; };
        setSpawnItem.onclick = () => {
            this.setPlayerSpawnAtClickPosition();
            this.hideContextMenu();
        };
        menu.appendChild(setSpawnItem);

        // Close menu on click outside.
        const closeMenu = (e: MouseEvent): void => {
            if (!menu.contains(e.target as Node)) {
                this.hideContextMenu();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => { document.addEventListener('click', closeMenu); }, 0);

        document.body.appendChild(menu);
        this.contextMenu = menu;
    }

    private hideContextMenu(): void {
        if (this.contextMenu) {
            this.contextMenu.remove();
            this.contextMenu = null;
        }
        this.hideMarkerPreviewDot();
    }

    private showMarkerPreviewDot(mouseX: number, mouseY: number): void {
        this.hideMarkerPreviewDot();
        const position = this.raycastWorldPosition(mouseX, mouseY);

        const dotGeometry = new THREE.SphereGeometry(0.15, 8, 8);
        const dotMaterial = new THREE.MeshBasicMaterial({
            color: 0xff0000,
            transparent: true,
            opacity: 0.7,
        });
        const dot = new THREE.Mesh(dotGeometry, dotMaterial);
        dot.name = 'MarkerPreviewDot';
        dot.position.copy(position);
        dot.layers.set(0);

        this.deps.engine.scene.add(dot);
        this.markerPreviewDot = dot;
    }

    private hideMarkerPreviewDot(): void {
        if (!this.markerPreviewDot) return;
        this.deps.engine.scene.remove(this.markerPreviewDot);
        this.markerPreviewDot.geometry.dispose();
        if (this.markerPreviewDot.material instanceof THREE.Material) {
            this.markerPreviewDot.material.dispose();
        }
        this.markerPreviewDot = null;
    }

    /**
     * Raycast from screen-space mouse coords into the scene; return the
     * first visible-mesh hit, or a point 10 m in front of the camera if
     * nothing's hit. Shared between the preview dot, add-marker, and
     * set-spawn paths so they all agree on the click-target position.
     */
    private raycastWorldPosition(mouseX: number, mouseY: number): THREE.Vector3 {
        const rect = this.deps.engine.renderer.domElement.getBoundingClientRect();
        const x = ((mouseX - rect.left) / rect.width) * 2 - 1;
        const y = -((mouseY - rect.top) / rect.height) * 2 + 1;
        this.deps.raycaster.setFromCamera(new THREE.Vector2(x, y), this.deps.engine.camera);

        const allObjects: THREE.Mesh[] = [];
        this.deps.engine.scene.traverse((object: THREE.Object3D) => {
            const mesh = object as THREE.Mesh;
            if (mesh.isMesh && mesh.geometry && mesh.material && isPickableOnScreen(object)) {
                allObjects.push(mesh);
            }
        });

        const intersects = this.deps.raycaster.intersectObjects(allObjects, false);
        if (intersects.length > 0) return intersects[0]!.point.clone();

        // No intersection — place 10 m in front of camera.
        const distance = 10;
        const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(this.deps.engine.camera.quaternion);
        return this.deps.engine.camera.position.clone().add(direction.multiplyScalar(distance));
    }

    /**
     * Camera's forward direction projected onto the horizontal plane,
     * expressed as a yaw angle. Used to align newly-placed markers and
     * spawn points with the camera so they face roughly the way the
     * editor was looking.
     */
    private cameraYaw(): number {
        const cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.deps.engine.camera.quaternion);
        cameraForward.y = 0;
        cameraForward.normalize();
        return Math.atan2(cameraForward.x, cameraForward.z);
    }

    /** Add a marker at the last right-click position (from "Add a marker" menu item). */
    private addMarkerAtClickPosition(): void {
        const position = this.raycastWorldPosition(this.contextMenuPosition.x, this.contextMenuPosition.y);
        const rotation = new THREE.Euler(0, this.cameraYaw(), 0);

        // Ensure markers are visible (in case debug mode visibility wasn't set yet).
        this.deps.markerSystem.setVisible(true);

        const markerData = this.deps.markerSystem.createMarker(position, rotation);

        safePostMessageToCreator({
            type: 'ADD_MARKER',
            marker: markerData,
        });

        const markerObject = this.deps.markerSystem.getMarkerObject(markerData.id);
        if (markerObject) {
            this.deps.selectObject(markerObject, false);
        }

        this.deps.refreshSceneHierarchy();
    }

    /** Move the player spawn point to the right-click position (from menu item). */
    private setPlayerSpawnAtClickPosition(): void {
        let playerMarker: SpawnPointMarker | null = null;
        for (const [, marker] of this.deps.spawnPointMarkers) {
            if (marker.type === 'player') {
                playerMarker = marker;
                break;
            }
        }
        if (!playerMarker) return;

        const position = this.raycastWorldPosition(this.contextMenuPosition.x, this.contextMenuPosition.y);
        const yaw = this.cameraYaw();

        playerMarker.setPosition(position.x, position.y, position.z);
        playerMarker.setRotationY(yaw);
        playerMarker.show();

        // Make sure spawn marker is in the scene (it may have been removed for multiplayer).
        if (!playerMarker.mesh.parent) {
            this.deps.engine.scene.add(playerMarker.mesh);
        }

        this.deps.markSpawnPointsDirty();
        this.deps.selectObject(playerMarker.mesh, false);
    }
}
