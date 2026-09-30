// Type checking enabled
import * as THREE from 'three';
import { VoxelObject } from 'engine/VoxelObject.js';
import { t } from 'engine/i18n/index.js';
import { getActiveLevelManager } from 'engine/levels/levelManagerRegistry.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';
import { injectEditorStyles, BM } from 'editor/editor-styles.js';

// Panel position state for scene hierarchy
interface SceneHierarchySavedState {
    top: number;
    left: number;
    width: number;
    height: number | null;
}

// Scene object metadata stored in sceneObjects map
interface SceneObjectMetadata {
    name: string;
    type: string;
    visible: boolean;
    depth?: number;
    hasChildren?: boolean;
    arrow?: HTMLElement;
    childrenContainer?: HTMLElement;
    element?: HTMLElement;
}

/**
 * Callback for when an object is selected in the hierarchy
 */
export type ObjectSelectCallback = (object: THREE.Object3D, focusCamera: boolean) => void;

/**
 * Scene hierarchy panel - displays a tree view of all objects in the scene
 */
export class SceneHierarchyPanel {
    private scene: THREE.Scene;
    private container: HTMLDivElement;
    private onObjectSelect: ObjectSelectCallback;

    // Panel elements
    private panel: HTMLDivElement | null = null;
    private content: HTMLDivElement | null = null;
    private filterContainer: HTMLDivElement | null = null;
    private filterInput: HTMLInputElement | null = null;
    private levelSwitcherRow: HTMLDivElement | null = null;
    private levelSelect: HTMLSelectElement | null = null;
    private levelSwitchInFlight: boolean = false;
    private filterText: string = '';
    private resizeHandle: HTMLDivElement | null = null;
    private minimized: boolean = false;
    private savedState: SceneHierarchySavedState = { top: 10, left: 10, width: 400, height: null };

    // Scene hierarchy data
    private sceneObjects: Map<THREE.Object3D, SceneObjectMetadata> = new Map();
    private hierarchyItems: Map<THREE.Object3D, HTMLElement> = new Map();
    private expandedObjects: Set<THREE.Object3D> = new Set();

    constructor(
        scene: THREE.Scene,
        container: HTMLDivElement,
        onObjectSelect: ObjectSelectCallback
    ) {
        this.scene = scene;
        this.container = container;
        this.onObjectSelect = onObjectSelect;
    }

    /**
     * Create the scene hierarchy panel
     */
    createPanel(): void {
        injectEditorStyles();

        this.panel = document.createElement('div');
        this.panel.className = 'bm-editor-panel';
        this.panel.style.top = `${this.savedState.top}px`;
        this.panel.style.left = `${this.savedState.left}px`;
        this.panel.style.width = `${this.savedState.width}px`;
        this.panel.style.height = this.savedState.height ? `${this.savedState.height}px` : 'calc(100vh - 20px)';

        // Header with drag handle and minimize button
        const header = document.createElement('div');
        header.className = 'bm-editor-header';

        const title = document.createElement('span');
        title.textContent = t('editor.panels.sceneHierarchy');

        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'bm-editor-header-buttons';

        const minimizeBtn = document.createElement('button');
        minimizeBtn.className = 'bm-icon-btn';
        minimizeBtn.textContent = this.minimized ? '□' : '−';
        minimizeBtn.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            this.toggleMinimize();
        };

        buttonContainer.appendChild(minimizeBtn);
        header.appendChild(title);
        header.appendChild(buttonContainer);

        // Filter row
        const filterContainer = document.createElement('div');
        filterContainer.style.cssText = `padding: 8px 10px; border-bottom: 1px solid ${BM.borderMuted}; display: ${this.minimized ? 'none' : 'block'};`;
        this.filterContainer = filterContainer;

        const filterInput = document.createElement('input');
        filterInput.className = 'bm-input';
        filterInput.type = 'text';
        filterInput.placeholder = t('editor.panels.filterPlaceholder');
        filterInput.style.width = '100%';
        filterInput.addEventListener('input', () => {
            this.filterText = filterInput.value.toLowerCase();
            this.applyFilter();
        });
        // Prevent keyboard events from reaching the game
        filterInput.addEventListener('keydown', (e: KeyboardEvent) => e.stopPropagation());
        filterInput.addEventListener('keyup', (e: KeyboardEvent) => e.stopPropagation());
        this.filterInput = filterInput;
        filterContainer.appendChild(filterInput);

        // Scrollable content
        const content = document.createElement('div');
        content.style.cssText = `flex: 1; overflow-y: auto; padding: 10px; font-size: 12px; line-height: 1.5; color: ${BM.textPrimary}; display: ${this.minimized ? 'none' : 'block'};`;
        this.content = content;

        // Resize handle (bottom-right corner)
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'bm-resize-handle';
        resizeHandle.style.cssText = `bottom: 0; right: 0; cursor: nwse-resize;`;

        const resizeHandleCorner = document.createElement('div');
        resizeHandleCorner.className = 'bm-resize-corner';
        resizeHandleCorner.style.cssText = `bottom: 2px; right: 2px; border-left: 10px solid transparent;`;
        resizeHandle.appendChild(resizeHandleCorner);
        this.resizeHandle = resizeHandle;

        this.panel.appendChild(header);
        this.panel.appendChild(filterContainer);
        this.panel.appendChild(content);
        this.panel.appendChild(resizeHandle);
        this.container.appendChild(this.panel);

        // Level switcher: may be created later when LevelManager is installed.
        this.syncLevelSwitcher();

        // Setup drag and resize functionality
        this.setupDragAndResize(header, resizeHandle);
    }

    /**
     * Setup drag and resize functionality for the panel
     */
    private setupDragAndResize(header: HTMLDivElement, resizeHandle: HTMLDivElement): void {
        if (!this.panel) return;

        const panel = this.panel;
        const container = this.container;

        // Drag functionality
        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let initialLeft = 0;
        let initialTop = 0;

        header.onmousedown = (e: MouseEvent) => {
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = panel.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            e.preventDefault();
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            const deltaX = e.clientX - dragStartX;
            const deltaY = e.clientY - dragStartY;
            const newLeft = initialLeft + deltaX;
            const newTop = initialTop + deltaY;

            const containerRect = container.getBoundingClientRect();
            const maxLeft = containerRect.width - panel.offsetWidth;
            const maxTop = containerRect.height - (this.minimized ? 40 : panel.offsetHeight);

            const clampedLeft = Math.max(0, Math.min(newLeft, maxLeft));
            const clampedTop = Math.max(0, Math.min(newTop, maxTop));

            panel.style.left = clampedLeft + 'px';
            panel.style.top = clampedTop + 'px';
            this.savedState.left = clampedLeft;
            this.savedState.top = clampedTop;
        };

        const onMouseUp = () => {
            isDragging = false;
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        // Resize functionality
        let isResizing = false;
        let resizeStartX = 0;
        let resizeStartY = 0;
        let initialResizeWidth = 0;
        let initialResizeHeight = 0;

        resizeHandle.onmousedown = (e: MouseEvent) => {
            if (this.minimized) return;
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;
            const rect = panel.getBoundingClientRect();
            initialResizeWidth = rect.width;
            initialResizeHeight = rect.height;
            e.preventDefault();
            e.stopPropagation();
        };

        const onResizeMouseMove = (e: MouseEvent) => {
            if (!isResizing) return;
            const deltaX = e.clientX - resizeStartX;
            const deltaY = e.clientY - resizeStartY;

            const minWidth = 200;
            const minHeight = 100;
            const maxWidth = window.innerWidth - panel.offsetLeft;
            const maxHeight = window.innerHeight - panel.offsetTop;

            const newWidth = Math.max(minWidth, Math.min(initialResizeWidth + deltaX, maxWidth));
            const newHeight = Math.max(minHeight, Math.min(initialResizeHeight + deltaY, maxHeight));

            panel.style.width = newWidth + 'px';
            panel.style.height = newHeight + 'px';
            this.savedState.width = newWidth;
            this.savedState.height = newHeight;
        };

        const onResizeMouseUp = () => {
            isResizing = false;
        };

        document.addEventListener('mousemove', onResizeMouseMove);
        document.addEventListener('mouseup', onResizeMouseUp);
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
            this.savedState.top = rect.top;
            this.savedState.left = rect.left;
            this.savedState.width = rect.width;
            this.savedState.height = rect.height;

            // Minimize: move to bottom, hide content
            const containerRect = this.container.getBoundingClientRect();
            this.panel.style.top = (containerRect.height - 40) + 'px';
            this.panel.style.height = '40px';
            this.content.style.display = 'none';
            if (this.filterContainer) {
                this.filterContainer.style.display = 'none';
            }
            if (this.levelSwitcherRow) {
                this.levelSwitcherRow.style.display = 'none';
            }
            if (this.resizeHandle) {
                this.resizeHandle.style.display = 'none';
            }

            const minimizeBtn = this.panel.querySelector('button');
            if (minimizeBtn) minimizeBtn.textContent = '□';
        } else {
            // Restore: use saved state
            this.panel.style.top = this.savedState.top + 'px';
            this.panel.style.left = this.savedState.left + 'px';
            this.panel.style.width = this.savedState.width + 'px';
            this.panel.style.height = (this.savedState.height || window.innerHeight - 20) + 'px';
            this.content.style.display = 'block';
            if (this.filterContainer) {
                this.filterContainer.style.display = 'block';
            }
            if (this.levelSwitcherRow) {
                this.levelSwitcherRow.style.display = 'block';
            }
            if (this.resizeHandle) {
                this.resizeHandle.style.display = 'block';
            }

            const minimizeBtn = this.panel.querySelector('button');
            if (minimizeBtn) minimizeBtn.textContent = '−';
        }
    }

    /**
     * Sync the level switcher row with the current LevelManager state.
     * Called from createPanel(), show(), and refresh() so the dropdown appears
     * as soon as the LevelManager is installed (production ordering).
     */
    private syncLevelSwitcher(): void {
        const levelManager = getActiveLevelManager();
        const shouldShow = levelManager && levelManager.getLevels().length >= 2;

        if (this.levelSwitcherRow && !shouldShow) {
            this.levelSwitcherRow.remove();
            this.levelSwitcherRow = null;
            this.levelSelect = null;
            return;
        }

        if (!this.levelSwitcherRow && shouldShow && levelManager) {
            const row = this.createLevelSwitcher();
            if (row && this.panel && this.filterContainer) {
                this.panel.insertBefore(row, this.filterContainer);
                if (this.minimized) {
                    row.style.display = 'none';
                }
            }
            return;
        }

        if (this.levelSwitcherRow && shouldShow && levelManager && !this.levelSwitchInFlight) {
            if (this.levelSelect) {
                this.levelSelect.value = levelManager.getActiveLevelId();
            }
        }
    }

    /**
     * Level dropdown for multi-level games. Null in legacy single-world mode
     * (no LevelManager) or with fewer than 2 levels. The switch is a runtime
     * re-filter only — nothing is saved; leaving the Editor tab reloads the
     * game back to the start level (creator-side deactivateScene).
     */
    private createLevelSwitcher(): HTMLDivElement | null {
        const levelManager = getActiveLevelManager();
        if (!levelManager) return null;
        const levels = levelManager.getLevels();
        if (levels.length < 2) return null;

        const row = document.createElement('div');
        row.className = 'bm-editor-level-switcher';
        this.levelSwitcherRow = row;

        const select = document.createElement('select');
        select.className = 'bm-input bm-editor-level-select';
        select.setAttribute('aria-label', t('editor.panels.levelSwitcher'));
        select.title = t('editor.panels.levelSwitcherTooltip');
        for (const level of levels) {
            const option = document.createElement('option');
            option.value = level.id;
            option.textContent = level.name;
            select.appendChild(option);
        }
        select.value = levelManager.getActiveLevelId();
        select.addEventListener('change', () => { void this.switchLevel(select.value); });
        // Keep keyboard events from reaching the game (mirrors filterInput).
        select.addEventListener('keydown', (e: KeyboardEvent) => e.stopPropagation());
        select.addEventListener('keyup', (e: KeyboardEvent) => e.stopPropagation());
        row.appendChild(select);
        this.levelSelect = select;

        // Creator-initiated switches (Levels tab) come back through didLoad —
        // sync the select and show the newly active level's objects.
        levelManager.onLevelDidLoad((levelId: string) => {
            if (this.levelSelect) this.levelSelect.value = levelId;
            this.refresh();
        });

        return row;
    }

    private async switchLevel(levelId: string): Promise<void> {
        const levelManager = getActiveLevelManager();
        if (!levelManager || this.levelSwitchInFlight) return;
        if (levelId === levelManager.getActiveLevelId()) return;
        this.levelSwitchInFlight = true;
        if (this.levelSelect) this.levelSelect.disabled = true;
        try {
            await levelManager.loadLevel(levelId, { networked: false });
            safePostMessageToCreator({ type: 'LEVEL_LOADED', levelId, success: true });
        } catch (err) {
            if (this.levelSelect) this.levelSelect.value = levelManager.getActiveLevelId();
            safePostMessageToCreator({
                type: 'LEVEL_LOADED', levelId, success: false,
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            this.levelSwitchInFlight = false;
            if (this.levelSelect) this.levelSelect.disabled = false;
        }
    }

    /**
     * Refresh the scene hierarchy display
     */
    refresh(): void {
        if (!this.content) return;

        // Clear existing content
        this.content.innerHTML = '';
        this.hierarchyItems.clear();
        this.sceneObjects.clear();

        // Build hierarchy from scene
        this.buildHierarchy(this.scene, this.content, 0);

        // Re-apply filter if active
        if (this.filterText) {
            this.applyFilter();
        }

        // Level manager may have been installed after panel creation
        this.syncLevelSwitcher();
    }


    /**
     * Build hierarchy recursively
     */
    private buildHierarchy(object: THREE.Object3D, parentElement: HTMLElement, depth: number): void {
        const item = document.createElement('div');
        item.style.cssText = `padding: 4px 6px; padding-left: ${depth * 16 + 6}px; cursor: pointer; user-select: none; border-radius: 4px; transition: background 0.1s ease;`;

        const name = object.name || object.constructor.name || 'Object';
        const type = object.type || object.constructor.name;
        const hasChildren = object.children && object.children.length > 0;
        const isExpanded = this.expandedObjects.has(object);

        const arrow = document.createElement('span');
        arrow.style.cssText = `color: ${BM.textDim}; cursor: pointer; padding: 2px; margin-right: 2px;`;
        arrow.textContent = hasChildren ? (isExpanded ? '▼' : '▶') : '•';

        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = `color: ${BM.textPrimary}; margin-left: 4px; cursor: pointer;`;
        nameSpan.textContent = name;

        const typeSpan = document.createElement('span');
        typeSpan.style.cssText = `color: ${BM.textDim}; margin-left: 8px; font-size: 10px;`;
        typeSpan.textContent = `(${type})`;

        item.appendChild(arrow);
        item.appendChild(nameSpan);
        item.appendChild(typeSpan);

        // Store object metadata
        this.sceneObjects.set(object, {
            name: name,
            type: type,
            visible: true,
            depth: depth,
            hasChildren: hasChildren,
            element: item,
            arrow: arrow
        });

        this.hierarchyItems.set(object, item);

        // Arrow click handler (expand/collapse)
        if (hasChildren) {
            arrow.onclick = (e: MouseEvent) => {
                e.stopPropagation();
                this.toggleObjectExpansion(object);
            };
        }

        // Name click handler (select object and focus camera)
        nameSpan.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            this.onObjectSelect(object, true); // Focus camera when clicking in hierarchy
        };

        // Hover effects — elevated card surface to signal interactivity (Bitmagic hover lift)
        item.onmouseenter = () => {
            if (!item.dataset.selected) item.style.backgroundColor = BM.surfaceCard;
        };
        item.onmouseleave = () => {
            if (!item.dataset.selected) item.style.backgroundColor = 'transparent';
        };

        parentElement.appendChild(item);

        // Create children container
        if (hasChildren) {
            const childrenContainer = document.createElement('div');
            childrenContainer.style.display = isExpanded ? 'block' : 'none';

            object.children.forEach((child: THREE.Object3D) => {
                this.buildHierarchy(child, childrenContainer, depth + 1);
            });

            parentElement.appendChild(childrenContainer);

            // Store container reference for expand/collapse
            const metadata = this.sceneObjects.get(object);
            if (metadata) {
                metadata.childrenContainer = childrenContainer;
            }
        }
    }

    /**
     * Toggle object expansion in hierarchy
     */
    private toggleObjectExpansion(object: THREE.Object3D): void {
        const metadata = this.sceneObjects.get(object);
        if (!metadata || !metadata.hasChildren || !metadata.arrow || !metadata.childrenContainer) return;

        const isExpanded = this.expandedObjects.has(object);

        if (isExpanded) {
            this.expandedObjects.delete(object);
            metadata.arrow.textContent = '▶';
            metadata.childrenContainer.style.display = 'none';
        } else {
            this.expandedObjects.add(object);
            metadata.arrow.textContent = '▼';
            metadata.childrenContainer.style.display = 'block';
        }
    }

    /**
     * Check if an object or any of its descendants match the current filter
     */
    private objectOrDescendantMatches(object: THREE.Object3D): boolean {
        const metadata = this.sceneObjects.get(object);
        if (metadata && metadata.name.toLowerCase().includes(this.filterText)) {
            return true;
        }
        for (const child of object.children) {
            if (this.objectOrDescendantMatches(child)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Apply the current filter text to show/hide hierarchy items
     */
    private applyFilter(): void {
        if (!this.filterText) {
            // No filter — show everything and restore expand/collapse state
            this.sceneObjects.forEach((metadata, object) => {
                if (metadata.element) {
                    metadata.element.style.display = '';
                }
                if (metadata.childrenContainer) {
                    metadata.childrenContainer.style.display =
                        this.expandedObjects.has(object) ? 'block' : 'none';
                }
            });
            return;
        }

        this.sceneObjects.forEach((metadata, object) => {
            const subtreeMatches = this.objectOrDescendantMatches(object);

            if (metadata.element) {
                metadata.element.style.display = subtreeMatches ? '' : 'none';
            }

            if (metadata.childrenContainer) {
                // Auto-expand if any child subtree has matches
                const hasMatchingDescendants = object.children.some(
                    child => this.objectOrDescendantMatches(child)
                );
                metadata.childrenContainer.style.display = hasMatchingDescendants ? 'block' : 'none';
            }
        });
    }

    /**
     * Highlight an object in the hierarchy
     */
    highlightObject(object: THREE.Object3D): void {
        // Resolve to selectable object (e.g., VoxelObject)
        const resolvedObject = this.resolveSelectableObject(object);

        // Clear previous highlights
        this.hierarchyItems.forEach((item: HTMLElement) => {
            item.style.backgroundColor = 'transparent';
            item.style.boxShadow = 'none';
            delete item.dataset.selected;
        });

        // Highlight selected object — Bitmagic selection token:
        // inset Aquamarine border + Aquamarine glow flourish.
        const item = this.hierarchyItems.get(resolvedObject);
        if (item) {
            item.style.backgroundColor = BM.surfaceCard;
            item.style.boxShadow = `inset 0 0 0 2px ${BM.aqua}, ${BM.glowAqua}`;
            item.dataset.selected = '1';

            // Expand parent nodes to make the object visible
            this.expandParentsInHierarchy(resolvedObject);

            // Scroll the item into view
            item.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });

            console.log('Highlighted object in hierarchy:', resolvedObject.name || resolvedObject.constructor.name);
        } else {
            console.log('Object not found in hierarchy:', resolvedObject.name || resolvedObject.constructor.name);
        }
    }

    /**
     * Resolve to the appropriate selectable object (e.g., VoxelObject parent, PlayerGroup)
     */
    private resolveSelectableObject(object: THREE.Object3D): THREE.Object3D {
        if (!object) return object;

        let current: THREE.Object3D | null = object;
        while (current) {
            // Check for VoxelObject first (environment objects, etc.)
            if (current instanceof VoxelObject) {
                return current;
            }
            // Check for PlayerGroup (player character container)
            if (current.name === 'PlayerGroup' && current instanceof THREE.Group) {
                return current;
            }
            current = current.parent;
        }

        return object;
    }

    /**
     * Expand parent nodes in hierarchy to make object visible
     */
    private expandParentsInHierarchy(object: THREE.Object3D): void {
        let current = object.parent;
        let expandedCount = 0;

        while (current && current !== this.scene) {
            const metadata = this.sceneObjects.get(current);
            if (metadata && metadata.hasChildren) {
                if (!this.expandedObjects.has(current)) {
                    // Expand this parent
                    this.toggleObjectExpansion(current);
                    expandedCount++;
                }
            }
            current = current.parent;
        }

        if (expandedCount > 0) {
            console.log(`Expanded ${expandedCount} parent nodes`);
        }
    }

    /**
     * Clear all highlights in the hierarchy
     */
    clearHighlights(): void {
        this.hierarchyItems.forEach((item: HTMLElement) => {
            item.style.backgroundColor = 'transparent';
            item.style.boxShadow = 'none';
            delete item.dataset.selected;
        });
    }

    /**
     * Get the scene objects metadata map
     */
    getSceneObjects(): Map<THREE.Object3D, SceneObjectMetadata> {
        return this.sceneObjects;
    }

    /**
     * Hide the panel
     */
    hide(): void {
        if (this.panel) {
            this.panel.style.display = 'none';
        }
    }

    /**
     * Show the panel
     */
    show(): void {
        if (this.panel) {
            this.panel.style.display = 'flex';
        }
        this.syncLevelSwitcher();
    }
}
