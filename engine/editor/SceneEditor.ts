import type { EngineLike } from 'types/game.js';
import { isPickableOnScreen } from 'engine/GlbInstancing.js';
import type { PlacedObjectSystem } from 'engine/PlacedObjectSystem.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';
import { getEditorHost } from 'editor/EditorHost.js';
import * as THREE from 'three';

/**
 * SceneEditor - Handles editor functionality for the Scene tab
 * Manages adding objects from the asset library to the scene
 */
export class SceneEditor {
    private engine: EngineLike;
    private placedObjectSystem: PlacedObjectSystem;
    private raycaster: THREE.Raycaster;
    private contextMenuPosition: { x: number; y: number } | null = null;
    private currentDialogOverlay: HTMLElement | null = null;
    /** Bumped per open so a slow assets reply cannot repopulate a dialog the creator already closed. */
    private dialogGeneration = 0;

    constructor(engine: EngineLike, placedObjectSystem: PlacedObjectSystem) {
        this.engine = engine;
        this.placedObjectSystem = placedObjectSystem;
        this.raycaster = new THREE.Raycaster();
        this.raycaster.layers.set(0);
        this.raycaster.layers.disable(3);
    }
    
    /**
     * Close the add object dialog if it's open
     */
    public closeDialog(): void {
        this.dialogGeneration++;

        // Remove dialog overlay
        if (this.currentDialogOverlay) {
            this.currentDialogOverlay.remove();
            this.currentDialogOverlay = null;
        }
    }

    /**
     * Set the context menu position for object placement (same as markers use)
     */
    public setContextMenuPosition(position: { x: number; y: number }): void {
        this.contextMenuPosition = position;
    }

    /**
     * Show dialog to select and add an asset from the asset library.
     *
     * The list comes from the HOST rather than the loaded game data: an asset generated since this
     * world loaded is exactly the one the creator is reaching for, and only the host has seen it.
     */
    public showAddObjectDialog(): void {
        // Close any existing dialog first
        this.closeDialog();
        const generation = this.dialogGeneration;

        void getEditorHost().listAssets().then((assets) => {
            if (generation !== this.dialogGeneration) return;
            this.showAddObjectDialogWithAssets(assets);
        });
    }

    /**
     * Show dialog with assets (called after receiving assets from parent or fallback)
     */
    private showAddObjectDialogWithAssets(assets: any[]): void {
        // Close any existing dialog
        this.closeDialog();
        
        // Create dialog overlay
        const overlay = document.createElement('div');
        this.currentDialogOverlay = overlay;
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 20000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // Create dialog
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 8px;
            padding: 20px;
            max-width: 800px;
            max-height: 80vh;
            width: 90%;
            display: flex;
            flex-direction: column;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        `;

        // Dialog title
        const title = document.createElement('div');
        title.textContent = 'Select Asset';
        title.style.cssText = `
            color: #e2e8f0;
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 20px;
        `;
        dialog.appendChild(title);

        // Dialog body: the asset grid, or an empty state pointing at the Assets tab
        dialog.appendChild(assets.length === 0 ? this.buildEmptyState() : this.buildAssetGrid(assets));

        // Close button
        const closeButton = document.createElement('button');
        closeButton.textContent = 'Cancel';
        closeButton.style.cssText = `
            margin-top: 20px;
            padding: 10px 20px;
            background: #6c757d;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            align-self: flex-end;
        `;
        closeButton.onclick = () => {
            overlay.remove();
        };
        dialog.appendChild(closeButton);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Close on overlay click
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        };
    }

    /**
     * Placeholder shown when the asset library is empty.
     *
     * How you GET an asset differs per host, so the advice does too: a host with chrome of its own
     * gets a button into it, and one without (the `bitmagic dev` view, whose shell drops
     * `SWITCH_TO_TAB` on the floor) gets the command that does the same job. Offering a button that
     * silently does nothing is worse than offering none.
     */
    private buildEmptyState(): HTMLElement {
        const emptyState = document.createElement('div');
        emptyState.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 40px 20px;
            text-align: center;
            flex: 1;
        `;

        const emptyMessage = document.createElement('div');
        emptyMessage.textContent = 'No assets available.';
        emptyMessage.style.cssText = `
            color: #94a3b8;
            font-size: 16px;
            margin-bottom: 20px;
        `;
        emptyState.appendChild(emptyMessage);

        const host = getEditorHost();
        const emptySubmessage = document.createElement('div');
        emptySubmessage.textContent = host.capabilities.hostNavigation
            ? 'Upload assets in the Assets tab to add them to your world.'
            : 'Run "bitmagic assets add <file>" to bring one into this project.';
        emptySubmessage.style.cssText = `
            color: #64748b;
            font-size: 14px;
            margin-bottom: 30px;
        `;
        emptyState.appendChild(emptySubmessage);

        if (!host.capabilities.hostNavigation) return emptyState;

        const goToAssetsButton = document.createElement('button');
        goToAssetsButton.textContent = 'Go to Assets Tab';
        goToAssetsButton.style.cssText = `
            padding: 12px 24px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: background-color 0.2s;
        `;
        goToAssetsButton.onmouseenter = () => {
            goToAssetsButton.style.backgroundColor = '#5568d3';
        };
        goToAssetsButton.onmouseleave = () => {
            goToAssetsButton.style.backgroundColor = '#667eea';
        };
        goToAssetsButton.onclick = () => {
            this.closeDialog();
            host.navigate({ tab: 'assets' });
        };
        emptyState.appendChild(goToAssetsButton);

        return emptyState;
    }

    /** Grid of asset thumbnails; clicking one places it at the click position. */
    private buildAssetGrid(assets: any[]): HTMLElement {
        const grid = document.createElement('div');
        grid.style.cssText = `
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
            gap: 15px;
            overflow-y: auto;
            flex: 1;
            padding: 10px;
        `;

        for (const asset of assets) {
            const assetItem = document.createElement('div');
            assetItem.style.cssText = `
                background: #0f172a;
                border: 1px solid #334155;
                border-radius: 6px;
                padding: 10px;
                cursor: pointer;
                transition: all 0.2s;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 8px;
            `;
            assetItem.onmouseenter = () => {
                assetItem.style.backgroundColor = '#1e293b';
                assetItem.style.borderColor = '#667eea';
            };
            assetItem.onmouseleave = () => {
                assetItem.style.backgroundColor = '#0f172a';
                assetItem.style.borderColor = '#334155';
            };
            assetItem.onclick = () => {
                this.addObjectAtClickPosition(asset);
                this.closeDialog();
            };

            // Screenshot thumbnail
            const thumbnail = document.createElement('div');
            thumbnail.style.cssText = `
                width: 120px;
                height: 120px;
                background: #0a0a0a;
                border: 1px solid #334155;
                border-radius: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
            `;

            if (asset.screenshotUrl) {
                const img = document.createElement('img');
                img.crossOrigin = 'anonymous';
                img.src = asset.screenshotUrl;
                img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
                thumbnail.appendChild(img);
            } else {
                thumbnail.innerHTML = '<div style="color: #64748b; font-size: 11px; text-align: center; padding: 10px;">No Preview</div>';
            }
            assetItem.appendChild(thumbnail);

            // Asset name
            const name = document.createElement('div');
            name.textContent = asset.name || 'Unnamed';
            name.style.cssText = `
                color: #e2e8f0;
                font-size: 12px;
                text-align: center;
                word-break: break-word;
                max-width: 100%;
            `;
            assetItem.appendChild(name);

            // Asset type
            const type = document.createElement('div');
            type.textContent = asset.type || 'unknown';
            type.style.cssText = `
                color: #94a3b8;
                font-size: 10px;
                text-align: center;
            `;
            assetItem.appendChild(type);

            grid.appendChild(assetItem);
        }

        return grid;
    }

    /**
     * Add an asset object at the clicked position (same logic as addMarkerAtClickPosition)
     */
    private async addObjectAtClickPosition(asset: any): Promise<void> {
        // Perform raycast to find 3D position (same as marker)
        const rect = this.engine.renderer?.domElement.getBoundingClientRect();
        if (!rect || !this.contextMenuPosition) {
            console.error('[SceneEditor] Renderer or context menu position not available');
            return;
        }

        const x = ((this.contextMenuPosition.x - rect.left) / rect.width) * 2 - 1;
        const y = -((this.contextMenuPosition.y - rect.top) / rect.height) * 2 + 1;

        // Set up raycaster
        const camera = this.engine.camera;
        if (!camera) {
            console.error('[SceneEditor] Camera not available');
            return;
        }
        const mouse = new THREE.Vector2(x, y);
        this.raycaster.setFromCamera(mouse, camera);

        // Raycast against all objects to find intersection point
        const allObjects: any[] = [];
        if (!this.engine.scene) {
            console.error('[SceneEditor] Scene not available');
            return;
        }
        this.engine.scene.traverse((object: any) => {
            if (object.isMesh && object.geometry && object.material && isPickableOnScreen(object)) {
                allObjects.push(object);
            }
        });

        const intersects = this.raycaster.intersectObjects(allObjects, false);

        let position: THREE.Vector3;
        if (intersects.length > 0 && intersects[0]) {
            position = intersects[0].point.clone();
        } else {
            // No intersection - place object in front of camera
            const distance = 10;
            const direction = new THREE.Vector3(0, 0, -1);
            direction.applyQuaternion(camera.quaternion);
            position = camera.position.clone().add(direction.multiplyScalar(distance));
        }

        // Calculate rotation: horizontal (y-rotation = 0) matching camera's x/z direction
        const cameraForward = new THREE.Vector3(0, 0, -1);
        cameraForward.applyQuaternion(camera.quaternion);
        const yRotation = Math.atan2(cameraForward.x, cameraForward.z);
        const rotation = new THREE.Euler(0, yRotation, 0);

        // Adjust position based on bounding box
        // Center on x/z, but place y at bottom of bounding box
        let adjustedPosition = position.clone();
        if (asset.boundingBox) {
            const centerX = (asset.boundingBox.minX + asset.boundingBox.maxX) / 2;
            const centerZ = (asset.boundingBox.minZ + asset.boundingBox.maxZ) / 2;
            const minY = asset.boundingBox.minY;
            
            adjustedPosition.x -= centerX;
            adjustedPosition.y -= minY; // Place at bottom of bounding box
            adjustedPosition.z -= centerZ;
        }

        // Create object using PlacedObjectSystem
        // Only assetId is needed - URL/name/type looked up from assets array
        const objectData = await this.placedObjectSystem.createPlacedObject(
            asset.id,
            adjustedPosition,
            rotation,
            asset.boundingBox
        );

        // Send message to parent to save object to world.json
        // Use adjustedPosition (already adjusted for bounding box centering).
        // `levelId` comes from the engine's LevelManager (the single source of
        // truth for what is loaded) so the creator's mirror record carries the
        // same tag as the engine's — an untagged record is global, i.e. visible
        // in every level. Undefined for legacy games with no levels[].
        safePostMessageToCreator({
            type: 'ADD_OBJECT',
            asset: asset,
            position: { x: adjustedPosition.x, y: adjustedPosition.y, z: adjustedPosition.z },
            rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
            objectId: objectData.id,
            levelId: objectData.levelId
        });

        // Mark the scene dirty and show the placeholder in the hierarchy
        // (the object itself is still loading asynchronously).
        const editorManager = this.engine.editorManager as {
            markSceneHasChanges?: () => void;
            refreshSceneHierarchy?: () => void;
        } | undefined;
        editorManager?.markSceneHasChanges?.();
        editorManager?.refreshSceneHierarchy?.();

        // Note: Object selection will happen automatically when the object finishes loading
        // via the PlacedObjectSystem's loadAndReplacePlaceholder method
    }
}

