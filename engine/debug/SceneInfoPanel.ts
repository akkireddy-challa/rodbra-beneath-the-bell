// Type checking enabled
import * as THREE from 'three';
import { t } from 'engine/i18n/index.js';

// Panel position state for scene info
interface SceneInfoSavedState {
    top: number | null;
    right: number;
    bottom: number;
    width: number;
    height: number | null;
}

// Scene statistics result
interface SceneStatistics {
    objectCount: number;
    polygonCount: number;
    vertexCount: number;
    boundingBox: {
        size: THREE.Vector3;
        center: THREE.Vector3;
    };
}

// Engine interface with Gaussian splat support
interface SceneInfoEngine {
    scene: THREE.Scene | null;
    isGaussianSplatMode?: boolean;
    gaussianSplatRenderer?: {
        getColliderVisibility(): boolean;
        setColliderVisibility(visible: boolean): void;
    };
    getGameData?(): GameData | null;
}

// Game data structure
interface GameData {
    environmentObjectsGeneratedProcedurally?: boolean;
}

/**
 * Callback for when scene editing is unlocked
 */
export type UnlockSceneEditingCallback = () => Promise<void>;

/**
 * Scene info panel - displays scene statistics and editing controls
 */
export class SceneInfoPanel {
    private engine: SceneInfoEngine;
    private container: HTMLDivElement;
    private onUnlockSceneEditing: UnlockSceneEditingCallback;

    // Panel elements
    private panel: HTMLDivElement | null = null;
    private content: HTMLDivElement | null = null;
    private minimized: boolean = false;
    private savedState: SceneInfoSavedState = { top: null, right: 10, bottom: 10, width: 300, height: null };

    // State
    private updateInterval: ReturnType<typeof setInterval> | null = null;
    private showCollidersChecked: boolean = false;
    private sceneEditingLocked: boolean = true;

    constructor(
        engine: SceneInfoEngine,
        container: HTMLDivElement,
        onUnlockSceneEditing: UnlockSceneEditingCallback
    ) {
        this.engine = engine;
        this.container = container;
        this.onUnlockSceneEditing = onUnlockSceneEditing;
    }

    /**
     * Create the scene info panel
     */
    createPanel(): void {
        this.panel = document.createElement('div');
        const initialHeight = this.savedState.height || 350;
        const right = this.savedState.right ?? 10;
        const bottom = this.savedState.bottom ?? 10;
        this.panel.style.cssText = `
            position: absolute;
            right: ${right}px;
            bottom: ${bottom}px;
            width: ${this.savedState.width}px;
            height: ${initialHeight}px;
            background: rgba(0, 0, 0, 0.9);
            color: white;
            border: 1px solid #555;
            border-radius: 5px;
            overflow: hidden;
            pointer-events: auto;
            display: none;
            flex-direction: column;
            z-index: 1000;
        `;

        // Header with drag handle and minimize button
        const header = document.createElement('div');
        header.style.cssText = `
            background: #333;
            padding: 8px 12px;
            border-bottom: 1px solid #555;
            font-weight: bold;
            font-size: 14px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: move;
            user-select: none;
        `;

        const title = document.createElement('span');
        title.textContent = t('editor.panels.sceneInfo');

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
        `;

        const minimizeBtn = document.createElement('button');
        minimizeBtn.textContent = this.minimized ? '□' : '−';
        minimizeBtn.style.cssText = `
            background: none;
            border: none;
            color: white;
            font-size: 16px;
            cursor: pointer;
            padding: 0;
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        minimizeBtn.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            this.toggleMinimize();
        };

        buttonContainer.appendChild(minimizeBtn);
        header.appendChild(title);
        header.appendChild(buttonContainer);

        // Scrollable content
        const content = document.createElement('div');
        content.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 12px;
            font-size: 12px;
            line-height: 1.6;
            display: ${this.minimized ? 'none' : 'block'};
        `;
        this.content = content;

        // Create content sections
        this.updateContent();

        this.panel.appendChild(header);
        this.panel.appendChild(content);
        this.container.appendChild(this.panel);

        // Setup drag functionality
        this.setupDrag(header);

        // Check lock status on creation (silently - gameData may not be available yet)
        this.checkSceneEditingLockStatus(true);
    }

    /**
     * Setup drag functionality for the panel
     */
    private setupDrag(header: HTMLDivElement): void {
        if (!this.panel) return;

        const panel = this.panel;
        const container = this.container;

        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let initialRight = 0;
        let initialBottom = 0;

        header.onmousedown = (e: MouseEvent) => {
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = panel.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            initialRight = containerRect.width - rect.right;
            initialBottom = containerRect.height - rect.bottom;
            e.preventDefault();
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            const deltaX = dragStartX - e.clientX; // Inverted for right positioning
            const deltaY = dragStartY - e.clientY; // Inverted for bottom positioning
            const containerRect = container.getBoundingClientRect();
            const newRight = initialRight + deltaX;
            const newBottom = initialBottom + deltaY;

            const maxRight = containerRect.width - panel.offsetWidth;
            const maxBottom = containerRect.height - (this.minimized ? 40 : panel.offsetHeight);

            const clampedRight = Math.max(0, Math.min(newRight, maxRight));
            const clampedBottom = Math.max(0, Math.min(newBottom, maxBottom));

            panel.style.right = clampedRight + 'px';
            panel.style.bottom = clampedBottom + 'px';
            this.savedState.right = clampedRight;
            this.savedState.bottom = clampedBottom;
        };

        const onMouseUp = () => {
            isDragging = false;
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    /**
     * Toggle minimize state of the panel
     */
    toggleMinimize(): void {
        if (!this.panel || !this.content) return;

        this.minimized = !this.minimized;

        if (this.minimized) {
            // Save current state
            const rect = this.panel.getBoundingClientRect();
            const containerRect = this.container.getBoundingClientRect();
            this.savedState.right = containerRect.width - rect.right;
            this.savedState.bottom = containerRect.height - rect.bottom;
            this.savedState.width = rect.width;
            this.savedState.height = rect.height;

            // Minimize: move to bottom, hide content
            this.panel.style.bottom = '10px';
            this.panel.style.height = '40px';
            this.content.style.display = 'none';

            const minimizeBtn = this.panel.querySelector('button');
            if (minimizeBtn) minimizeBtn.textContent = '□';
        } else {
            // Restore: use saved state
            const right = this.savedState.right ?? 10;
            const bottom = this.savedState.bottom ?? 10;
            this.panel.style.right = right + 'px';
            this.panel.style.bottom = bottom + 'px';
            this.panel.style.width = this.savedState.width + 'px';
            this.panel.style.height = (this.savedState.height || 350) + 'px';
            this.content.style.display = 'block';

            const minimizeBtn = this.panel.querySelector('button');
            if (minimizeBtn) minimizeBtn.textContent = '−';
        }
    }

    /**
     * Show the panel
     */
    show(): void {
        if (this.panel) {
            this.panel.style.display = 'flex';
            this.startPeriodicUpdates();
            this.checkSceneEditingLockStatus();
        }
    }

    /**
     * Hide the panel
     */
    hide(): void {
        if (this.panel) {
            this.panel.style.display = 'none';
            this.stopPeriodicUpdates();
        }
    }

    /**
     * Update the panel content with current statistics
     */
    updateContent(): void {
        if (!this.content) return;

        const stats = this.calculateStatistics();

        // Clear existing content
        this.content.innerHTML = '';

        // Scene statistics section
        const statsSection = document.createElement('div');
        statsSection.style.cssText = 'margin-bottom: 20px;';

        const statsList = document.createElement('div');
        statsList.style.cssText = 'font-size: 11px; line-height: 1.8;';
        statsList.innerHTML = `
            <div>${t('editor.panels.objects')}: ${stats.objectCount.toLocaleString()}</div>
            <div>${t('editor.panels.polygons')}: ${stats.polygonCount.toLocaleString()}</div>
            <div>${t('editor.panels.vertices')}: ${stats.vertexCount.toLocaleString()}</div>
            <div style="margin-top: 8px;">${t('editor.panels.boundingBox')}:</div>
            <div style="margin-left: 12px; opacity: 0.8;">
                ${t('editor.panels.size')}: ${stats.boundingBox.size.x.toFixed(1)} × ${stats.boundingBox.size.y.toFixed(1)} × ${stats.boundingBox.size.z.toFixed(1)} m<br>
                ${t('editor.panels.center')}: (${stats.boundingBox.center.x.toFixed(1)}, ${stats.boundingBox.center.y.toFixed(1)}, ${stats.boundingBox.center.z.toFixed(1)})
            </div>
        `;
        statsSection.appendChild(statsList);

        // Lock status section
        const lockSection = this.createLockSection();

        // Show colliders checkbox section (for Gaussian Splat mode)
        const collidersSection = this.createCollidersSection();

        // Only show colliders section if Gaussian Splat mode is active
        if (this.engine.isGaussianSplatMode && this.engine.gaussianSplatRenderer) {
            this.content.appendChild(statsSection);
            this.content.appendChild(lockSection);
            this.content.appendChild(collidersSection);
        } else {
            this.content.appendChild(statsSection);
            this.content.appendChild(lockSection);
        }
    }

    /**
     * Create the lock status section
     */
    private createLockSection(): HTMLDivElement {
        const lockSection = document.createElement('div');
        lockSection.style.cssText = 'margin-top: 20px; padding-top: 15px; border-top: 1px solid #555;';

        const lockTitle = document.createElement('div');
        lockTitle.style.cssText = 'font-weight: bold; margin-bottom: 8px;';
        lockTitle.textContent = t('editor.panels.sceneEditingTitle');
        lockSection.appendChild(lockTitle);

        const lockStatus = document.createElement('div');
        lockStatus.style.cssText = 'font-size: 11px; line-height: 1.6; margin-bottom: 10px;';

        if (this.sceneEditingLocked) {
            lockStatus.innerHTML = `
                <div style="color: #ff9800;">🔒 ${t('editor.panels.sceneEditingIsLocked')}</div>
                <div style="margin-top: 6px; opacity: 0.8;">${t('editor.panels.levelObjectsNotEdited')} ${t('editor.panels.clickUnlockToEdit')}</div>
            `;

            const unlockBtn = document.createElement('button');
            unlockBtn.textContent = t('editor.panels.unlock');
            unlockBtn.style.cssText = `
                margin-top: 10px;
                padding: 6px 16px;
                background: #4CAF50;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                font-weight: bold;
            `;
            unlockBtn.onclick = () => {
                this.unlockSceneEditing();
            };
            lockSection.appendChild(lockStatus);
            lockSection.appendChild(unlockBtn);
        } else {
            lockStatus.innerHTML = `
                <div style="color: #4CAF50;">✓ ${t('editor.panels.sceneEnabled')}</div>
                <div style="margin-top: 6px; opacity: 0.8;">${t('editor.panels.sceneEnabledDescription')}</div>
            `;
            lockSection.appendChild(lockStatus);
        }

        return lockSection;
    }

    /**
     * Create the colliders checkbox section
     */
    private createCollidersSection(): HTMLDivElement {
        const collidersSection = document.createElement('div');
        collidersSection.style.cssText = 'margin-top: 20px; padding-top: 15px; border-top: 1px solid #555;';

        const collidersTitle = document.createElement('div');
        collidersTitle.style.cssText = 'font-weight: bold; margin-bottom: 8px;';
        collidersTitle.textContent = t('editor.panels.colliders');
        collidersSection.appendChild(collidersTitle);

        const collidersCheckboxContainer = document.createElement('div');
        collidersCheckboxContainer.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-top: 8px;';

        const collidersCheckbox = document.createElement('input');
        collidersCheckbox.type = 'checkbox';
        collidersCheckbox.id = 'show-colliders-checkbox';
        // Use stored state or sync with current visibility state
        if (this.engine.gaussianSplatRenderer) {
            collidersCheckbox.checked = this.showCollidersChecked || this.engine.gaussianSplatRenderer.getColliderVisibility();
        } else {
            collidersCheckbox.checked = this.showCollidersChecked;
        }
        collidersCheckbox.style.cssText = 'cursor: pointer;';

        const collidersLabel = document.createElement('label');
        collidersLabel.htmlFor = 'show-colliders-checkbox';
        collidersLabel.textContent = t('editor.panels.showColliders');
        collidersLabel.style.cssText = 'cursor: pointer; font-size: 11px; user-select: none;';

        collidersCheckbox.onchange = () => {
            this.showCollidersChecked = collidersCheckbox.checked;
            if (this.engine.gaussianSplatRenderer) {
                this.engine.gaussianSplatRenderer.setColliderVisibility(collidersCheckbox.checked);
            }
        };

        collidersCheckboxContainer.appendChild(collidersCheckbox);
        collidersCheckboxContainer.appendChild(collidersLabel);
        collidersSection.appendChild(collidersCheckboxContainer);

        return collidersSection;
    }

    /**
     * Calculate scene statistics
     */
    calculateStatistics(): SceneStatistics {
        let objectCount = 0;
        let polygonCount = 0;
        let vertexCount = 0;
        const boundingBox = new THREE.Box3();
        let hasObjects = false;

        if (!this.engine.scene) {
            return {
                objectCount: 0,
                polygonCount: 0,
                vertexCount: 0,
                boundingBox: {
                    size: new THREE.Vector3(),
                    center: new THREE.Vector3()
                }
            };
        }

        // Traverse scene to count objects and calculate bounding box
        this.engine.scene.traverse((object: THREE.Object3D) => {
            // Skip debug objects and UI elements
            if (object.name.startsWith('Debug') ||
                object.name.startsWith('HeightmapTool') ||
                object.name.startsWith('PlacementHelper') ||
                object.name === 'StartingPlate' ||
                object.name.startsWith('StartText') ||
                object.name.startsWith('MeasuringStick')) {
                return;
            }

            if (object instanceof THREE.Mesh) {
                objectCount++;

                const geometry = object.geometry;
                if (geometry) {
                    // Count vertices
                    const positions = geometry.attributes.position;
                    if (positions) {
                        vertexCount += positions.count;
                    }

                    // Count polygons (triangles)
                    if (geometry.index) {
                        polygonCount += geometry.index.count / 3;
                    } else if (positions) {
                        // Non-indexed geometry: assume triangles
                        polygonCount += positions.count / 3;
                    }

                    // Update bounding box
                    if (object.visible) {
                        geometry.computeBoundingBox();
                        if (geometry.boundingBox) {
                            const objectBox = geometry.boundingBox.clone();
                            objectBox.applyMatrix4(object.matrixWorld);
                            if (!hasObjects) {
                                boundingBox.copy(objectBox);
                                hasObjects = true;
                            } else {
                                boundingBox.union(objectBox);
                            }
                        }
                    }
                }
            } else if (object instanceof THREE.Group || object instanceof THREE.Object3D) {
                // Count groups and other objects
                if (object.children.length > 0) {
                    objectCount++;
                }
            }
        });

        const size = boundingBox.getSize(new THREE.Vector3());
        const center = boundingBox.getCenter(new THREE.Vector3());

        return {
            objectCount,
            polygonCount: Math.floor(polygonCount),
            vertexCount,
            boundingBox: { size, center }
        };
    }

    /**
     * Check if scene editing is locked (checks world.json flag)
     */
    async checkSceneEditingLockStatus(silent: boolean = false): Promise<void> {
        try {
            // Get gameData from engine (may not be available during initialization)
            if (!this.engine.getGameData) {
                if (!silent) {
                    console.warn('GameEngine.getGameData() not available yet - game may not be fully loaded');
                }
                this.sceneEditingLocked = true;
                this.updateContent();
                return;
            }

            const worldData = this.engine.getGameData();
            if (!worldData) {
                if (!silent) {
                    console.warn('gameData not available yet - will check again after game loads');
                }
                this.sceneEditingLocked = true;
                this.updateContent();
                return;
            }

            // Check if environmentObjectsGeneratedProcedurally is explicitly set to false
            if (worldData.environmentObjectsGeneratedProcedurally === false) {
                this.sceneEditingLocked = false;
            } else {
                this.sceneEditingLocked = true;
            }
        } catch (error) {
            if (!silent) {
                console.error('Error checking scene editing lock status:', error);
            }
            this.sceneEditingLocked = true;
        }

        this.updateContent();
    }

    /**
     * Unlock scene editing
     */
    async unlockSceneEditing(): Promise<void> {
        this.sceneEditingLocked = false;
        this.updateContent();
        await this.onUnlockSceneEditing();
        console.log('Scene editing unlocked - editing is now available');
    }

    /**
     * Get the current scene editing locked state
     */
    isSceneEditingLocked(): boolean {
        return this.sceneEditingLocked;
    }

    /**
     * Set the scene editing locked state
     */
    setSceneEditingLocked(locked: boolean): void {
        this.sceneEditingLocked = locked;
        this.updateContent();
    }

    /**
     * Start periodic updates for scene info statistics
     */
    startPeriodicUpdates(): void {
        // Update every 2 seconds
        this.updateInterval = setInterval(() => {
            if (this.content && this.panel && this.panel.style.display !== 'none') {
                this.updateContent();
            }
        }, 2000);
    }

    /**
     * Stop periodic updates for scene info statistics
     */
    stopPeriodicUpdates(): void {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
}
