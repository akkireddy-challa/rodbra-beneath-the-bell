import * as THREE from 'three';
import type { DebugCameraController } from '../debug/DebugCameraController.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { t } from 'engine/i18n/index.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import { SelectableObjectConfig } from '../debug/ObjectSelectionManager.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { OBJECT_INSPECTOR_CSS } from './object-inspector-styles.js';
import { injectEditorStyles, BM } from './editor-styles.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';
import { getEditorHost, type EditorHqMethod } from 'editor/EditorHost.js';
import { isPlaceholderAsset, type PlaceholderAssetFields } from './placeholderAsset.js';
import { describeAssetProduction } from './assetProduction.js';
import { isGeneratingHqAsset, onGeneratingHqAssetsChanged } from 'engine/HqGenerationState.js';
import type { GameData } from 'types/game.js';

/** Two-decimal rounding for mechanism inputs (avoids 2.6703537… in the UI). */
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The `environmentObjects` fields the inspector reads off a selected instance. */
interface InspectorEnvObjDef {
    id: string;
    assetId?: string;
    flattenTerrain?: boolean;
    destructible?: boolean;
}

/** The `assets` fields the inspector reads — a superset of the placeholder test's. */
interface InspectorAssetDef extends PlaceholderAssetFields {
    id: string;
    name?: string;
    type?: string;
    sourceModelUrl?: string;
    voxelEdited?: boolean;
    flattenTerrain?: boolean;
}

const PROPERTY_KEY_MAP: Record<string, string> = {
    'name': 'editor.panels.name',
    'type': 'editor.panels.type',
    'uuid': 'editor.panels.uuid',
    'layer': 'editor.panels.layer',
    'parent': 'editor.panels.parent',
    'position': 'editor.panels.position',
    'rotation': 'editor.panels.rotation',
    'scale': 'editor.panels.scale',
    'count': 'editor.panels.count',
    'items': 'editor.panels.items'
};

function translateKey(key: string): string {
    const translationKey = PROPERTY_KEY_MAP[key];
    return translationKey ? t(translationKey) : key;
}

/** Safe JSON stringify with circular reference and depth handling */
function safeStringify(value: unknown, maxDepth: number = 2): string {
    const seen = new WeakSet<object>();
    const helper = (v: unknown, depth: number): unknown => {
        if (v === null || typeof v !== 'object') return v;
        if (seen.has(v)) return '[Circular]';
        if (depth > maxDepth) return `[Object ${v.constructor?.name ?? 'Object'}]`;
        seen.add(v);
        if (Array.isArray(v)) return v.map(item => helper(item, depth + 1));
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(v)) {
            try {
                out[key] = helper((v as Record<string, unknown>)[key], depth + 1);
            } catch {
                out[key] = '[Unserializable]';
            }
        }
        return out;
    };
    try {
        return JSON.stringify(helper(value, 0));
    } catch {
        return '[Unserializable]';
    }
}

/**
 * Write `value` at a dotted `path` inside `root`; returns whether it landed.
 *
 * `createMissing` mints absent intermediate objects — right for a `mechanisms[]`
 * entry the creator upserts wholesale, wrong for a forged feature's params, where
 * an unknown branch means the persist path is stale and the edit must not invent
 * a shape the forger never wrote.
 */
function writeAtPath(root: Record<string, unknown>, path: string, value: number, createMissing: boolean): boolean {
    const segs = path.split('.');
    let node: Record<string, unknown> = root;
    for (const seg of segs.slice(0, -1)) {
        if (createMissing && (node[seg] === undefined || node[seg] === null)) node[seg] = {};
        const next = node[seg];
        if (!next || typeof next !== 'object') return false;
        node = next as Record<string, unknown>;
    }
    node[segs[segs.length - 1]!] = value;
    return true;
}

/** One read-only `label: value` row — the inspector's default field rendering. */
function labeledRow(label: string, value: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'oi-field-row';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'oi-field-label';
    labelSpan.textContent = label;
    const valueSpan = document.createElement('span');
    valueSpan.className = 'oi-field-value';
    valueSpan.textContent = value;
    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    return row;
}

/**
 * Append one analyzed `key: value` line to a section body: objects as
 * depth-limited JSON, arrays as a count line followed by one line per item.
 * Shared by the top-level sections and the Advanced ones so both read alike.
 */
function appendValueRow(body: HTMLElement, key: string, value: unknown): void {
    const line = document.createElement('div');
    line.className = 'oi-field-row';
    if (Array.isArray(value)) {
        line.innerHTML = `<span class="oi-field-label">${translateKey(key)}:</span> [${value.length} ${t('editor.panels.items')}]`;
        body.appendChild(line);
        value.forEach((item, index) => {
            const subLine = document.createElement('div');
            subLine.className = 'oi-field-subline';
            subLine.textContent = `${index}: ${typeof item === 'object' ? safeStringify(item) : item}`;
            body.appendChild(subLine);
        });
        return;
    }
    line.innerHTML = typeof value === 'object'
        ? `<span class="oi-field-label">${translateKey(key)}:</span> ${safeStringify(value)}`
        : `<span class="oi-field-label">${translateKey(key)}:</span> <span class="oi-field-value">${value}</span>`;
    body.appendChild(line);
}

/** Mapping of collision group flags to names */
const COLLISION_GROUP_MAP: [number, string][] = [
    [CollisionGroup.PLAYER, 'PLAYER'],
    [CollisionGroup.ENVIRONMENT, 'ENVIRONMENT'],
    [CollisionGroup.ENEMY, 'ENEMY'],
    [CollisionGroup.PROJECTILE, 'PROJECTILE'],
    [CollisionGroup.VEHICLE, 'VEHICLE'],
    [CollisionGroup.TRIGGER, 'TRIGGER'],
    [CollisionGroup.DEBRIS, 'DEBRIS'],
    [CollisionGroup.ANIMAL, 'ANIMAL'],
];

/** Bullet standard filter names */
const BULLET_FILTERS: Record<number, string> = {
    32: 'CharacterFilter (32)',
    2: 'StaticFilter (2)',
    1: 'DefaultFilter (1)',
};

/** Get collision group name(s) from a collision group value */
function getCollisionGroupNames(groupValue: number): string[] {
    const names = COLLISION_GROUP_MAP
        .filter(([flag]) => groupValue & flag)
        .map(([, name]) => name);

    if (names.length === 0) {
        return [BULLET_FILTERS[groupValue] ?? `Unknown (${groupValue})`];
    }
    return names;
}

/** Mapping of collision flags to descriptions */
const COLLISION_FLAGS_MAP: [number, string][] = [
    [1, 'CF_STATIC_OBJECT'],
    [2, 'CF_KINEMATIC_OBJECT'],
    [4, 'CF_NO_CONTACT_RESPONSE'],
    [16, 'CF_CHARACTER_OBJECT'],
];

/** Get collision flags description from collision flags value */
function getCollisionFlagsDescription(flags: number): string[] {
    const names = COLLISION_FLAGS_MAP.filter(([flag]) => flags & flag).map(([, name]) => name);
    return names.length > 0 ? names : ['None'];
}

interface FieldDefinition {
    key: string;
    label: string;
    type: 'slider';
    min: number;
    max: number;
    step: number;
    unit: string;
    decimals: number;
}

interface ConfigTypeDefinition {
    fields: FieldDefinition[];
    path: string[];
    title: string;
    /** Current values for `fields`, including each field's default when world.json is silent. */
    loadFromWorldJson: (worldProfileData: any) => Record<string, number>;
}

/**
 * Character configuration
 */
const CHARACTER_CONFIG: ConfigTypeDefinition = {
    fields: [
        { key: 'height', label: 'Height', type: 'slider', min: 0.5, max: 5.0, step: 0.05, unit: 'm', decimals: 2 },
        { key: 'runSpeed', label: 'Run Speed', type: 'slider', min: 1.0, max: 20.0, step: 0.1, unit: 'm/s', decimals: 1 },
    ],
    path: ['characterConfig'],
    title: 'Character',
    loadFromWorldJson: (worldProfileData: any) => {
        const characterConfig = worldProfileData?.characterConfig || {};
        return {
            height: characterConfig.height ?? worldProfileData?.characterHeight ?? 1.75,
            runSpeed: characterConfig.runSpeed ?? 5.0
        };
    }
};

/**
 * Object Inspector panel for displaying and editing object properties
 */
export class ObjectInspector {
    private panel: HTMLElement | null = null;
    private content: HTMLElement | null = null;
    private titleSpan: HTMLElement | null = null;
    private resizeHandle: HTMLElement | null = null;
    private minimized: boolean = false;
    private savedState: { top: number; right: number; width: number; height: number | null } = {
        top: 10,
        right: 10,
        width: 380,
        height: null
    };
    private collisionVisualization: THREE.Object3D | null = null;
    private scene: THREE.Scene | null = null;

    // World config state
    private worldSettings: Record<string, number> = {};
    private worldPendingChanges: boolean = false;

    constructor(
        private container: HTMLElement,
        private getDebugCamera: () => DebugCameraController | null,
        private getSceneEditingLocked: () => boolean,
        private getMarkerSystem?: () => any,
        private markSceneChanges?: (object?: THREE.Object3D) => void,
        private onSelectObject?: (object: THREE.Object3D, focusCamera: boolean) => void,
        private getGameData?: () => any,
        private onToggleFlattenTerrain?: (objectId: string, enable: boolean) => void,
        private onToggleDestructible?: (objectId: string, enable: boolean) => void,
        private onRemoveObject?: (object: THREE.Object3D) => void
    ) { }

    /** Set scene reference for collision visualization */
    setScene(scene: THREE.Scene): void { this.scene = scene; }

    // Voxel editing entry points (Voxels section) — wired by EditorManager.
    private onEditVoxels: ((object: THREE.Object3D) => void) | null = null;
    private onOpenAssetAction: ((assetId: string, action: 'revoxelize' | 'reimport') => void) | null = null;

    /**
     * Resolve the selected instance's id, its `environmentObjects` entry and the
     * asset that entry points at. The Description, Voxels, Terrain and
     * Destructible sections all key off this triple and each used to spell the
     * same two `find` walks out in full.
     *
     * Every field is null/undefined when the instance isn't backed by game data,
     * so callers guard on what they actually need rather than on `gameData`.
     */
    private resolveInstanceAsset(object: THREE.Object3D): {
        objectId: string | undefined;
        envObjDef: InspectorEnvObjDef | null;
        assetDef: InspectorAssetDef | null;
    } {
        const gameData = this.getGameData?.();
        const objectId = object.userData?.objectId as string | undefined;
        const envObjDef: InspectorEnvObjDef | null = gameData && objectId
            ? (gameData.environmentObjects || []).find((o: { id: string }) => o.id === objectId) ?? null
            : null;
        const assetDef: InspectorAssetDef | null = envObjDef?.assetId
            ? (gameData.assets || []).find((a: { id: string }) => a.id === envObjDef.assetId) ?? null
            : null;
        return { objectId, envObjDef, assetDef };
    }

    /** Wire the Voxels section actions (Edit Voxels / Edit Source / Re-import). */
    setVoxelEditCallbacks(
        onEditVoxels: (object: THREE.Object3D) => void,
        onOpenAssetAction: (assetId: string, action: 'revoxelize' | 'reimport') => void,
    ): void {
        this.onEditVoxels = onEditVoxels;
        this.onOpenAssetAction = onOpenAssetAction;
    }

    /** Check if there are pending world config changes */
    hasPendingWorldConfig(): boolean {
        return this.worldPendingChanges;
    }

    /** Get pending world config for saving, returns null if no changes */
    getPendingWorldConfig(): { settings: Record<string, number>; path: string[]; title: string } | null {
        if (!this.worldPendingChanges) return null;
        return {
            settings: { ...this.worldSettings },
            path: [...CHARACTER_CONFIG.path],
            title: CHARACTER_CONFIG.title,
        };
    }

    /** Clear pending world config after saving */
    clearPendingWorldConfig(): void {
        this.worldPendingChanges = false;
    }

    /** Dispose a mesh's geometry and material(s) */
    private disposeMesh(mesh: THREE.Mesh): void {
        mesh.geometry?.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach(m => m.dispose());
        else mat?.dispose();
    }

    /** Remove any existing collision visualization */
    clearCollisionVisualization(): void {
        if (this.collisionVisualization && this.scene) {
            this.scene.remove(this.collisionVisualization);
            this.collisionVisualization.traverse((child) => {
                if ((child as THREE.Mesh).geometry) this.disposeMesh(child as THREE.Mesh);
            });
            this.collisionVisualization = null;
        }
    }

    /** Create a mesh from bounding box with given material */
    private createBoundingBoxMesh(object: THREE.Object3D, material: THREE.Material, position?: THREE.Vector3, quaternion?: THREE.Quaternion): THREE.Mesh | null {
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) return null;
        const size = box.getSize(new THREE.Vector3());
        const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
        const mesh = new THREE.Mesh(geo, material);
        if (position && quaternion) {
            mesh.position.copy(position);
            mesh.quaternion.copy(quaternion);
        } else {
            mesh.position.copy(box.getCenter(new THREE.Vector3()));
        }
        return mesh;
    }

    /** Create collision visualization from physics body */
    showCollisionVisualization(physicsBody: any, object: THREE.Object3D): void {
        if (!this.scene || !physicsBody) return;
        this.clearCollisionVisualization();

        const group = new THREE.Group();
        group.name = '__collision_visualization__';

        const collisionMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ff00, transparent: true, opacity: 0.5,
            side: THREE.DoubleSide, depthWrite: false
        });

        try {
            let foundCollisionMesh = false;

            // Check if object itself is a collision mesh or has collision geometry
            if (object instanceof THREE.Mesh && object.geometry) {
                const mesh = new THREE.Mesh(object.geometry.clone(), collisionMaterial.clone());
                mesh.position.copy(object.position);
                mesh.quaternion.copy(object.quaternion);
                mesh.scale.copy(object.scale);
                group.add(mesh);
                foundCollisionMesh = true;
                console.log('[ObjectInspector] Using object geometry for collision visualization');
            }

            // Check children for collision meshes
            if (!foundCollisionMesh) {
                object.traverse((child) => {
                    if (child instanceof THREE.Mesh && child.geometry?.attributes.position) {
                        const mesh = new THREE.Mesh(child.geometry.clone(), collisionMaterial.clone());
                        child.updateWorldMatrix(true, false);
                        mesh.applyMatrix4(child.matrixWorld);
                        group.add(mesh);
                        foundCollisionMesh = true;
                    }
                });
                if (foundCollisionMesh) {
                    console.log(`[ObjectInspector] Found ${group.children.length} collision mesh(es) in children`);
                }
            }

            // Try to build from Rapier physics body
            if (!foundCollisionMesh && physicsBody) {
                try {
                    const rapierBody = physicsBody as RAPIER.RigidBody;
                    if (rapierBody.translation && rapierBody.rotation) {
                        const t = rapierBody.translation();
                        const r = rapierBody.rotation();
                        const mesh = this.createBoundingBoxMesh(
                            object, collisionMaterial,
                            new THREE.Vector3(t.x, t.y, t.z),
                            new THREE.Quaternion(r.x, r.y, r.z, r.w)
                        );
                        if (mesh) {
                            group.add(mesh);
                            foundCollisionMesh = true;
                            console.log('[ObjectInspector] Created collision viz from Rapier body bounds');
                        }
                    }
                } catch (e) {
                    console.log('[ObjectInspector] Failed to read Rapier body:', e);
                }
            }

            // Last resort: show object bounding box (magenta to indicate fallback)
            if (!foundCollisionMesh) {
                console.log('[ObjectInspector] Using bounding box fallback');
                const fallbackMaterial = new THREE.MeshBasicMaterial({
                    color: 0xff00ff, transparent: true, opacity: 0.3,
                    side: THREE.DoubleSide, depthWrite: false
                });
                const mesh = this.createBoundingBoxMesh(object, fallbackMaterial);
                if (mesh) group.add(mesh);
            }
        } catch (e) {
            console.error('[ObjectInspector] Failed to create collision visualization:', e);
        }

        if (group.children.length > 0) {
            this.scene.add(group);
            this.collisionVisualization = group;
        }
    }

    /**
     * Create object inspector panel
     */
    createPanel() {
        // Shared Bitmagic tokens + inspector-specific rules. injectEditorStyles()
        // must run first because oi-* rules below reference `--bm-*` custom
        // properties declared by the shared sheet.
        injectEditorStyles();
        if (!document.getElementById('object-inspector-styles')) {
            const style = document.createElement('style');
            style.id = 'object-inspector-styles';
            style.textContent = OBJECT_INSPECTOR_CSS;
            document.head.appendChild(style);
        }

        this.panel = document.createElement('div');
        this.panel.className = 'oi-panel';
        const initialHeight = this.savedState.height || (window.innerHeight * 0.6);
        this.panel.style.top = `${this.savedState.top}px`;
        this.panel.style.right = `${this.savedState.right}px`;
        this.panel.style.width = `${this.savedState.width}px`;
        this.panel.style.height = `${initialHeight}px`;

        // Header with drag handle and minimize button
        const header = document.createElement('div');
        header.className = 'oi-header';

        const title = document.createElement('span');
        title.textContent = t('editor.panels.objectInspector');
        this.titleSpan = title;

        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'oi-header-buttons';

        const minimizeBtn = document.createElement('button');
        minimizeBtn.textContent = this.minimized ? '□' : '−';
        minimizeBtn.className = 'oi-header-btn oi-header-btn--minimize';
        minimizeBtn.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            this.toggleMinimize();
        };

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.className = 'oi-header-btn oi-header-btn--close';
        closeBtn.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            this.close();
        };

        buttonContainer.appendChild(minimizeBtn);
        buttonContainer.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(buttonContainer);

        // Scrollable content
        const content = document.createElement('div');
        content.className = 'oi-content';
        content.style.display = this.minimized ? 'none' : 'block';
        this.content = content;

        // Resize handles
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'oi-resize-handle';

        const resizeHandleCorner = document.createElement('div');
        resizeHandleCorner.className = 'oi-resize-corner';
        resizeHandle.appendChild(resizeHandleCorner);
        this.resizeHandle = resizeHandle;

        this.panel.appendChild(header);
        this.panel.appendChild(content);
        this.panel.appendChild(resizeHandle);
        this.container.appendChild(this.panel);

        // Drag functionality
        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let initialRight = 0;
        let initialTop = 0;

        header.onmousedown = (e: MouseEvent) => {
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = this.panel!.getBoundingClientRect();
            const containerRect = this.container.getBoundingClientRect();
            initialRight = containerRect.width - rect.right;
            initialTop = rect.top;
            e.preventDefault();
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            const deltaX = e.clientX - dragStartX;
            const deltaY = e.clientY - dragStartY;
            const containerRect = this.container.getBoundingClientRect();
            const newRight = initialRight - deltaX;
            const newTop = initialTop + deltaY;

            const maxRight = containerRect.width - this.panel!.offsetWidth;
            const maxTop = containerRect.height - (this.minimized ? 40 : this.panel!.offsetHeight);

            const clampedRight = Math.max(0, Math.min(newRight, maxRight));
            const clampedTop = Math.max(0, Math.min(newTop, maxTop));

            this.panel!.style.right = clampedRight + 'px';
            this.panel!.style.top = clampedTop + 'px';
            this.savedState.right = clampedRight;
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
            const rect = this.panel!.getBoundingClientRect();
            initialResizeWidth = rect.width;
            initialResizeHeight = rect.height;
            e.preventDefault();
            e.stopPropagation();
        };

        const onResizeMouseMove = (e: MouseEvent) => {
            if (!isResizing) return;
            const deltaX = resizeStartX - e.clientX; // Negative because we're resizing from left
            const deltaY = e.clientY - resizeStartY;

            const minWidth = 200;
            const minHeight = 100;
            const containerRect = this.container.getBoundingClientRect();
            const rect = this.panel!.getBoundingClientRect();
            const maxWidth = containerRect.width - (containerRect.width - rect.right);
            const maxHeight = containerRect.height - rect.top;

            const newWidth = Math.max(minWidth, Math.min(initialResizeWidth + deltaX, maxWidth));
            const newHeight = Math.max(minHeight, Math.min(initialResizeHeight + deltaY, maxHeight));

            this.panel!.style.width = newWidth + 'px';
            this.panel!.style.height = newHeight + 'px';
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
     * Toggle minimize state of object inspector panel
     */
    toggleMinimize() {
        this.minimized = !this.minimized;

        // Selected by class, not `querySelector('button')` — the close button is a
        // button in the same header, and the glyph tells the two apart either way.
        const minimizeBtn = this.panel?.querySelector<HTMLElement>('.oi-header-btn--minimize');
        if (minimizeBtn) minimizeBtn.textContent = this.minimized ? '□' : '−';

        if (this.minimized) {
            // Save current state
            const rect = this.panel!.getBoundingClientRect();
            const containerRect = this.container.getBoundingClientRect();
            this.savedState.top = rect.top;
            this.savedState.right = containerRect.width - rect.right;
            this.savedState.width = rect.width;
            this.savedState.height = rect.height;

            // Minimize: move to bottom, hide content
            this.panel!.style.top = (containerRect.height - 40) + 'px';
            this.panel!.style.height = '40px';
            this.content!.style.display = 'none';
            if (this.resizeHandle) {
                this.resizeHandle.style.display = 'none';
            }
        } else {
            // Restore: use saved state
            this.panel!.style.top = this.savedState.top + 'px';
            this.panel!.style.right = this.savedState.right + 'px';
            this.panel!.style.width = this.savedState.width + 'px';
            this.panel!.style.height = (this.savedState.height || window.innerHeight * 0.6) + 'px';
            this.content!.style.display = 'block';
            if (this.resizeHandle) {
                this.resizeHandle.style.display = 'block';
            }
        }
    }

    /** The object currently on display — re-shown when HQ generation state changes. */
    private shownObject: THREE.Object3D | null = null;
    private hqUnsubscribe: (() => void) | null = null;

    /**
     * Show object inspector
     */
    show(object: THREE.Object3D) {
        if (!this.panel || !this.content) return;

        this.shownObject = object;
        // Re-render when a background HQ generation starts or finishes, so the badge and
        // button flip on their own instead of only on the next manual reselect. Subscribed
        // lazily on first show and kept for the panel's lifetime.
        if (!this.hqUnsubscribe) {
            this.hqUnsubscribe = onGeneratingHqAssetsChanged(() => {
                if (this.shownObject && this.panel?.style.display !== 'none') {
                    this.show(this.shownObject);
                }
            });
        }

        // If minimized, restore it first
        if (this.minimized) {
            this.toggleMinimize();
        }

        // Ensure the panel, its content and (unless minimized) its resize handle are visible
        this.panel.style.display = 'flex';
        this.content.style.display = 'block';
        if (this.resizeHandle && !this.minimized) {
            this.resizeHandle.style.display = 'block';
        }

        this.content.innerHTML = '';

        // Update title with lock/unlock indicator based on editability
        if (this.titleSpan) {
            const icon = this.isObjectEditable(object) ? '\u270F\uFE0F' : '\uD83D\uDC41\uFE0F';
            this.titleSpan.textContent = `${icon} ${t('editor.panels.objectInspector')}`;
        }

        this.displayObjectInfo(this.analyzeObject(object), object);
    }


    /** First object in the scene matching `match`, or null. */
    private findInScene(match: (object: THREE.Object3D) => boolean): THREE.Object3D | null {
        let found: THREE.Object3D | null = null;
        this.scene?.traverse((child) => {
            if (!found && match(child)) found = child;
        });
        return found;
    }

    /**
     * Display cross-navigation links between related objects.
     * PlayerGroup ↔ player spawn point marker.
     */
    private displayCrossLinks(object: THREE.Object3D, container: HTMLElement): void {
        if (!this.scene || !this.onSelectObject) return;

        const isPlayer = (o: THREE.Object3D): boolean => o.name === 'PlayerGroup' || o.name === 'LocalPlayer';
        const isPlayerSpawn = (o: THREE.Object3D): boolean =>
            o.userData?.isSpawnPointMarker === true && o.userData.spawnPointId === 'player';

        // Each side of the pair links to the other.
        const [targetObject, linkLabel] = isPlayerSpawn(object) ? [this.findInScene(isPlayer), 'Player'] as const
            : isPlayer(object) ? [this.findInScene(isPlayerSpawn), 'Spawn Point'] as const
            : [null, ''] as const;

        if (!targetObject) return;

        const linkDiv = document.createElement('div');
        linkDiv.className = 'oi-crosslink';

        const arrow = document.createElement('span');
        arrow.textContent = '\u2192';
        arrow.className = 'oi-crosslink-arrow';

        const link = document.createElement('span');
        link.textContent = linkLabel;
        link.className = 'oi-crosslink-link';

        link.onclick = () => {
            this.onSelectObject!(targetObject, true);
        };

        linkDiv.appendChild(arrow);
        linkDiv.appendChild(link);
        container.appendChild(linkDiv);
    }

    private displayConfigSection(configDef: ConfigTypeDefinition) {
        const content = this.content;
        if (!content) return;

        // Get worldProfileData from game data provider or window global
        const gameData = this.getGameData ? this.getGameData() : (window as any).gameData;
        const worldProfileData = gameData?.worldProfileData || {};

        // Load settings
        this.worldSettings = configDef.loadFromWorldJson(worldProfileData);

        const section = document.createElement('div');
        section.className = 'oi-section';

        const header = document.createElement('div');
        header.className = 'oi-section-header--config';

        const titleSpan = document.createElement('span');
        titleSpan.textContent = configDef.title;
        header.appendChild(titleSpan);

        const body = document.createElement('div');
        body.className = 'oi-section-body';

        for (const field of configDef.fields) {
            const fieldGroup = document.createElement('div');
            fieldGroup.className = 'oi-config-field';

            const label = document.createElement('div');
            label.className = 'oi-config-label';
            label.textContent = field.label;

            const sliderRow = document.createElement('div');
            sliderRow.className = 'oi-slider-row';

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'oi-slider';
            slider.min = field.min.toString();
            slider.max = field.max.toString();
            slider.step = field.step.toString();
            slider.value = (this.worldSettings[field.key] ?? field.min).toString();

            const formatValue = (val: number) => `${val.toFixed(field.decimals)}${field.unit ? ' ' + field.unit : ''}`;

            const valueDisplay = document.createElement('span');
            valueDisplay.className = 'oi-slider-value';
            valueDisplay.textContent = formatValue(this.worldSettings[field.key] ?? field.min);

            slider.addEventListener('input', () => {
                const value = parseFloat(slider.value);
                valueDisplay.textContent = formatValue(value);
                this.worldSettings[field.key] = value;
                this.worldPendingChanges = true;
                // World config is tracked separately via hasPendingWorldConfig/getPendingWorldConfig
                // and saved on tab change via SceneTabHandler
            });

            sliderRow.appendChild(slider);
            sliderRow.appendChild(valueDisplay);
            fieldGroup.appendChild(label);
            fieldGroup.appendChild(sliderRow);
            body.appendChild(fieldGroup);
        }

        section.appendChild(header);
        section.appendChild(body);
        content.appendChild(section);
    }

    /**
     * Close object inspector
     */
    close() {
        if (this.panel) {
            this.panel.style.display = 'none';
        }
        this.shownObject = null;
    }

    /**
     * Mechanism section: engine-built movers/hazards (KinematicPlatform,
     * CrumblingPlatform, …) publish an editable-parameter contract on their
     * mesh (`userData.__editable` + `__mechanism`, optionally `__persistPaths`
     * for world-forger mechanisms). Render each editable key as a guarded
     * number input: clamped to the declared range, radians presented as
     * degrees, applied LIVE to the running mechanism, and — when a persist
     * path exists — written through to the level asset's worldForgerFeatures
     * in world.json via the creator.
     */
    private createMechanismSection(content: HTMLElement, object: THREE.Object3D): void {
        const editable = object.userData?.['__editable'] as
            Record<string, { min: number; max: number; step: number; display?: 'degPerSec' }> | undefined;
        const mechanism = object.userData?.['__mechanism'] as
            { applyEditableParam?: (key: string, value: number) => boolean } | undefined;
        if (!editable || !mechanism?.applyEditableParam) return;

        const section = document.createElement('div');
        section.className = 'oi-section';
        const header = document.createElement('div');
        header.className = 'oi-section-header--simple';
        header.textContent = t('editor.panels.mechanism');
        section.appendChild(header);
        const body = document.createElement('div');
        body.className = 'oi-section-body';

        // Read-only context first: what this is and where it came from. Set as text,
        // never innerHTML — these values come from the forge's own naming.
        for (const key of ['mechanism', 'feature', 'role', 'challenge', 'difficulty'] as const) {
            const value = object.userData?.[key];
            if (value === undefined || value === null) continue;
            body.appendChild(labeledRow(`${key}: `, String(value)));
        }

        const persistPaths = object.userData?.['__persistPaths'] as Record<string, string> | undefined;
        const RAD2DEG = 180 / Math.PI;

        for (const [key, spec] of Object.entries(editable)) {
            const current = object.userData?.[key];
            if (typeof current !== 'number') continue;
            const deg = spec.display === 'degPerSec';
            const toUi = (v: number): number => deg ? v * RAD2DEG : v;
            const fromUi = (v: number): number => deg ? v / RAD2DEG : v;

            const row = document.createElement('div');
            row.className = 'oi-field-row oi-mech-row';
            const label = document.createElement('span');
            label.className = 'oi-field-label';
            label.textContent = deg ? `${key.replace(/Rad$/, '')} (deg/s):` : `${key}:`;
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'oi-mech-input';
            input.min = String(round2(toUi(spec.min)));
            input.max = String(round2(toUi(spec.max)));
            input.step = String(deg ? 1 : spec.step);
            input.value = String(round2(toUi(current)));

            input.onchange = () => {
                const parsed = parseFloat(input.value);
                if (!Number.isFinite(parsed)) {
                    input.value = String(round2(toUi(object.userData?.[key] as number)));
                    return;
                }
                const applied = mechanism.applyEditableParam!(key, fromUi(parsed));
                if (!applied) {
                    input.value = String(round2(toUi(object.userData?.[key] as number)));
                    return;
                }
                const stored = object.userData?.[key] as number; // clamped by the mechanism
                input.value = String(round2(toUi(stored)));
                this.persistMechanismParam(object, key, stored, persistPaths);
            };

            row.appendChild(label);
            row.appendChild(input);
            body.appendChild(row);
        }

        // Where do edits go? Live-only for game-code mechanisms; through to
        // world.json for world-forger ones.
        const note = document.createElement('div');
        note.className = 'oi-field-row oi-mech-note';
        note.textContent = persistPaths
            ? t('editor.panels.mechanismPersisted')
            : t('editor.panels.mechanismRuntimeOnly');
        body.appendChild(note);

        section.appendChild(body);
        content.appendChild(section);
    }

    /**
     * Write an edited mechanism parameter through to world.json when the
     * mechanism declared a persist path (world-forger mechanisms only): update
     * the in-memory gameData copy (the iframe is the source of truth), then
     * hand the creator a minimal patch instruction.
     */
    private persistMechanismParam(
        object: THREE.Object3D,
        key: string,
        value: number,
        persistPaths: Record<string, string> | undefined,
    ): void {
        const paramPath = persistPaths?.[key];
        if (!paramPath || !this.getGameData) return;

        // Data-driven mechanisms (world.json `mechanisms[]`): patch the entry
        // in the iframe's gameData, then hand the creator a minimal upsert.
        const mechanismId = object.userData?.['mechanismId'] as string | undefined;
        if (mechanismId) {
            const gameData = this.getGameData() as { mechanisms?: Array<Record<string, unknown>> } | null;
            const entry = gameData?.mechanisms?.find(m => m.id === mechanismId);
            if (entry && writeAtPath(entry, paramPath, value, true)) {
                safePostMessageToCreator({
                    type: 'MECHANISM_PARAM_EDITED',
                    mechanismId,
                    paramPath,
                    value,
                });
            }
            return;
        }

        // World-forger mechanisms: the parameter lives in the level asset's
        // worldForgerFeatures.
        const featureName = object.userData?.['feature'] as string | undefined;
        if (!featureName) return;
        // `GameData`, not a local re-declaration of the slice we happen to touch: an
        // inline shape compiles against the guess and breaks silently when the handoff
        // moves. This scan keeps its own loop rather than using `findForgedFeature`
        // because writing the edit back needs the OWNING asset's id, not just the feature.
        const gameData = this.getGameData() as GameData | null;
        for (const asset of gameData?.assets ?? []) {
            const feature = asset.worldForgerFeatures?.find(f => f.name === featureName);
            if (!feature?.params) continue;
            if (writeAtPath(feature.params, paramPath, value, false)) {
                safePostMessageToCreator({
                    type: 'FORGER_PARAM_EDITED',
                    assetId: asset.id,
                    featureName,
                    paramPath,
                    value,
                });
            }
            return;
        }
    }

    /**
     * Check if an object is editable (has transform gizmo and editable fields)
     */
    /** How many placed objects share this asset — the "replace all" count. */
    private countInstancesOfAsset(assetId: string): number {
        const gameData = this.getGameData?.() as { environmentObjects?: Array<{ assetId?: string }> } | undefined;
        if (!gameData?.environmentObjects) return 1;
        return gameData.environmentObjects.filter((o) => o.assetId === assetId).length || 1;
    }

    private isObjectEditable(object: THREE.Object3D): boolean {
        // AI guide markers are always editable
        if (object.userData?.isMarker === true) return true;
        // Procedurally generated terrain chunks are never editable
        if (object.parent?.name === 'GroundChunks') return false;
        // Spawn markers are always editable
        if (SelectableObjectConfig.isSpawnPointMarker(object)) return true;
        // Everything else must support transform AND editing must be unlocked
        return !this.getSceneEditingLocked() && SelectableObjectConfig.supportsTransformChanges(object);
    }

    /**
     * Analyze object properties
     */
    analyzeObject(object: THREE.Object3D) {
        type KeyValue = Record<string, unknown>;
        type ChildInfo = { name: string; type: string };
        const info: {
            basic: KeyValue;
            transform: KeyValue;
            geometry: KeyValue;
            material: KeyValue;
            userData: KeyValue;
            physics: KeyValue;
            children: ChildInfo[];
        } = {
            basic: {},
            transform: {},
            geometry: {},
            material: {},
            userData: {},
            physics: {},
            children: []
        };

        // Basic info
        info.basic.name = object.name || 'Unnamed';
        info.basic.type = object.type || object.constructor.name;
        info.basic.uuid = object.uuid;

        // Object ID from ObjectIdService (if registered)
        if (object.userData && object.userData.objectId) {
            info.basic.objectId = object.userData.objectId;
        }

        // Collision layer (which layers this object is on)
        const layers: number[] = [];
        for (let i = 0; i < 32; i++) {
            if (object.layers.mask & (1 << i)) {
                layers.push(i);
            }
        }
        info.basic.layer = layers.length > 0 ? layers.join(', ') : '0';

        // Parent info
        if (object.parent) {
            info.basic.parent = object.parent.name || object.parent.type || 'Unnamed';
            info.basic.parentObject = object.parent; // Store reference for clicking
        } else {
            info.basic.parent = 'None (Scene root)';
        }

        // Marker-specific info
        if (object.userData && object.userData.isMarker) {
            const markerData = object.userData.markerData;
            if (markerData) {
                info.basic.markerId = markerData.id;
                info.basic.markerName = markerData.name;
                info.basic.markerColor = markerData.color;
            }
        }

        // Transform
        if (object.position) {
            info.transform.position = `${object.position.x.toFixed(3)}, ${object.position.y.toFixed(3)}, ${object.position.z.toFixed(3)}`;
        }
        if (object.rotation) {
            info.transform.rotation = `${object.rotation.x.toFixed(3)}, ${object.rotation.y.toFixed(3)}, ${object.rotation.z.toFixed(3)}`;
        }
        if (object.scale) {
            info.transform.scale = `${object.scale.x.toFixed(3)}, ${object.scale.y.toFixed(3)}, ${object.scale.z.toFixed(3)}`;
        }

        // Geometry and material: read the fields a drawable node carries (Mesh, Line,
        // Points, …) rather than asserting every Object3D is a Mesh.
        const drawable = object as Partial<THREE.Mesh>;

        if (drawable.geometry) {
            const geom = drawable.geometry;
            info.geometry.type = geom.type || geom.constructor?.name;
            info.geometry.vertices = geom.attributes.position?.count ?? 'N/A';
        }

        if (drawable.material) {
            const mat = drawable.material;
            if (Array.isArray(mat)) {
                info.material.type = `Array[${mat.length}]`;
                info.material.materials = mat.map(m => m.type || m.constructor?.name);
            } else {
                info.material.type = mat.type || mat.constructor?.name;
                // Only some material types have a colour; the base class doesn't declare one.
                const color = (mat as THREE.MeshStandardMaterial).color;
                if (color) {
                    info.material.color = `#${color.getHexString()}`;
                }
            }
        }

        // User data
        if (object.userData && Object.keys(object.userData).length > 0) {
            info.userData = { ...object.userData };
        }

        // Physics / Collision information
        if (object instanceof VoxelObject) {
            const pi = object.getPhysicsInfo();
            info.physics.hasCollider = pi.hasCollider;
            if (pi.hasCollider) {
                info.physics.bodyType = pi.isDynamic ? 'Dynamic' : 'Static';
                info.physics.colliderType = pi.colliderType;
                info.physics.colliderCount = pi.colliderCount;
                if (pi.triangleCount !== undefined) {
                    info.physics.trimeshTriangles = pi.triangleCount.toLocaleString();
                }
                if (object.userData.collisionGroup !== undefined) {
                    info.physics.collisionGroup = getCollisionGroupNames(object.userData.collisionGroup).join(' | ');
                }
                if (object.userData.collisionMask !== undefined) {
                    info.physics.collisionMask = getCollisionGroupNames(object.userData.collisionMask).join(' | ');
                }
                if (object.userData.mass !== undefined) {
                    info.physics.mass = object.userData.mass;
                }
            }
        } else {
            const physicsBody = (object.userData?.physicsBody || object.userData?.rigidBody) as Record<string, unknown> | undefined;
            if (physicsBody) {
                info.physics.hasCollider = true;
                info.physics.bodyType = (physicsBody as { constructor: { name: string } }).constructor.name;

                try {
                    const flags = (physicsBody as { getCollisionFlags?: () => number }).getCollisionFlags?.();
                    if (flags !== undefined) {
                        info.physics.collisionFlags = getCollisionFlagsDescription(flags).join(', ');
                        info.physics.collisionFlagsValue = flags;
                    }
                } catch (_) { /* Rapier bodies don't have getCollisionFlags */ }

                if (object.userData.collisionGroup !== undefined) {
                    info.physics.collisionGroup = getCollisionGroupNames(object.userData.collisionGroup).join(' | ');
                    info.physics.collisionGroupValue = object.userData.collisionGroup;
                }
                if (object.userData.collisionMask !== undefined) {
                    info.physics.collisionMask = getCollisionGroupNames(object.userData.collisionMask).join(' | ');
                    info.physics.collisionMaskValue = object.userData.collisionMask;
                }
                if ((physicsBody as { getMass?: () => number }).getMass) {
                    try {
                        const mass = (physicsBody as { getMass: () => number }).getMass();
                        info.physics.mass = mass === 0 ? 'Static (0)' : mass.toFixed(2);
                    } catch (_) { /* ignore */ }
                }
            } else {
                info.physics.hasCollider = false;
            }
        }

        // Children
        if (object.children && object.children.length > 0) {
            info.children = object.children.map((child: THREE.Object3D) => ({
                name: child.name || 'Unnamed',
                type: (child as any).type || child.constructor.name
            }));
        }

        return info;
    }

    /**
     * A titled section holding one labelled checkbox — the shape the Terrain and
     * Destructible toggles share. Clicking the label toggles the box.
     */
    private appendCheckboxSection(
        content: HTMLElement,
        title: string,
        label: string,
        checked: boolean,
        onChange: (checked: boolean) => void,
    ): void {
        const section = document.createElement('div');
        section.className = 'oi-section';

        const header = document.createElement('div');
        header.className = 'oi-terrain-header';
        header.textContent = title;
        section.appendChild(header);

        const body = document.createElement('div');
        body.className = 'oi-section-body';

        const row = document.createElement('div');
        row.className = 'oi-checkbox-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = checked;
        checkbox.className = 'oi-checkbox';
        checkbox.onchange = () => onChange(checkbox.checked);

        const labelEl = document.createElement('label');
        labelEl.textContent = label;
        labelEl.className = 'oi-checkbox-label';
        labelEl.onclick = () => { checkbox.click(); };

        row.appendChild(checkbox);
        row.appendChild(labelEl);
        body.appendChild(row);
        section.appendChild(body);
        content.appendChild(section);
    }

    /** Re-analyze and re-render the object after an edit made inside the panel. */
    private refresh(object: THREE.Object3D): void {
        this.displayObjectInfo(this.analyzeObject(object), object);
    }

    /**
     * Display object info in inspector
     */
    displayObjectInfo(info: any, object: THREE.Object3D) {
        const content = this.content;
        if (!content) return;

        const isEditingUnlocked = !this.getSceneEditingLocked();

        // Check if object is procedurally generated and shouldn't be edited
        // Objects with parent "GroundChunks" are procedurally generated terrain chunks
        const isProcedurallyGenerated = object.parent && object.parent.name === 'GroundChunks';

        // Check if object supports transform changes (only VoxelObjects and environment instances)
        const supportsTransformEditing = SelectableObjectConfig.supportsTransformChanges(object);

        // Check if object is a marker (AI guide marker or spawn point marker)
        const isMarker = object.userData && object.userData.isMarker;
        const isSpawnPointMarker = object.userData?.isSpawnPointMarker === true;

        // Helper function to create sections
        const createSection = (title: string, data: any, options?: { showJumpTo?: boolean; isTransform?: boolean }) => {
            if (!data || Object.keys(data).length === 0) return;

            const section = document.createElement('div');
            section.className = 'oi-section';

            const header = document.createElement('div');
            header.className = 'oi-section-header';

            const titleSpan = document.createElement('span');
            titleSpan.textContent = title;
            header.appendChild(titleSpan);

            // Add "Jump to" button for Basic Info
            if (options?.showJumpTo && object) {
                const jumpButton = document.createElement('button');
                jumpButton.textContent = t('editor.panels.jumpTo');
                jumpButton.className = 'oi-btn';
                jumpButton.onclick = () => {
                    const debugCamera = this.getDebugCamera();
                    if (debugCamera && object) {
                        debugCamera.focusOn(object);
                    }
                };
                header.appendChild(jumpButton);
            }

            const body = document.createElement('div');
            body.className = 'oi-section-body';

            Object.entries(data).forEach(([key, value]: [string, any]) => {
                // Skip parentObject - it's only used internally for the click handler
                if (key === 'parentObject') return;

                // Skip markerId - it's only used internally for marker editing
                if (key === 'markerId') return;

                // Rows that carry an editor build their own container; every other key
                // falls through to appendValueRow() at the bottom.
                const line = document.createElement('div');
                line.className = 'oi-field-row';

                // Special handling for marker properties
                // Markers are always editable (they are AI guides, not real world objects)
                if ((isEditingUnlocked || isMarker) && (key === 'markerName' || key === 'markerColor')) {
                    const markerId = (data as any).markerId;
                    if (markerId && this.getMarkerSystem) {
                        const markerSystem = this.getMarkerSystem();
                        if (markerSystem) {
                            const labelSpan = document.createElement('span');
                            labelSpan.className = 'oi-field-label';
                            labelSpan.textContent = `${key === 'markerName' ? 'Name' : 'Color'}: `;

                            if (key === 'markerColor') {
                                // Color dropdown with named colors
                                const select = document.createElement('select');
                                select.value = value as string;
                                select.className = 'oi-select';

                                // Add color options
                                const colorNames = markerSystem.getColorNames();
                                colorNames.forEach((colorName: string) => {
                                    const option = document.createElement('option');
                                    option.value = colorName;
                                    option.textContent = colorName;
                                    const colorHex = markerSystem.getColorHex(colorName);
                                    option.style.backgroundColor = colorHex;
                                    select.appendChild(option);
                                });

                                select.onchange = () => {
                                    markerSystem.updateMarker(markerId, { color: select.value });

                                    // Mark scene changes
                                    if (this.markSceneChanges) {
                                        this.markSceneChanges(object);
                                    }

                                    this.refresh(object);
                                };

                                line.appendChild(labelSpan);
                                line.appendChild(select);
                                body.appendChild(line);
                            } else {
                                // Name text input
                                const input = document.createElement('input');
                                input.type = 'text';
                                input.value = value as string;
                                input.className = 'oi-input oi-input--name';

                                input.onchange = () => {
                                    markerSystem.updateMarker(markerId, { name: input.value });

                                    // Mark scene changes
                                    if (this.markSceneChanges) {
                                        this.markSceneChanges(object);
                                    }

                                    // Update object name if marker name changed
                                    object.name = input.value;
                                    this.refresh(object);
                                };

                                line.appendChild(labelSpan);
                                line.appendChild(input);
                                body.appendChild(line);
                            }
                            return;
                        }
                    }
                }

                // Special handling for parent name - make it clickable
                if (key === 'parent' && value !== 'None (Scene root)' && (data as any).parentObject) {
                    const parentSpan = document.createElement('span');
                    parentSpan.className = 'oi-field-label';
                    parentSpan.textContent = `${translateKey(key)}: `;

                    const parentLink = document.createElement('span');
                    parentLink.className = 'oi-parent-link';
                    parentLink.textContent = value as string;
                    parentLink.onclick = () => {
                        // Select parent object
                        const parentObj = (data as any).parentObject;
                        if (parentObj) {
                            if (this.onSelectObject) {
                                this.onSelectObject(parentObj, false);
                            } else {
                                const info = this.analyzeObject(parentObj);
                                this.displayObjectInfo(info, parentObj);
                            }
                        }
                    };

                    line.appendChild(parentSpan);
                    line.appendChild(parentLink);
                    body.appendChild(line);
                    return;
                }

                // Markers and spawn points are always editable (they are AI guides, not real world objects)
                if (options?.isTransform && (isEditingUnlocked || isMarker || isSpawnPointMarker) && (key === 'position' || key === 'rotation' || key === 'scale')) {
                    // Check if this is a procedurally generated object or doesn't support transform changes
                    // Only VoxelObjects, environment instances, markers, and spawn points support transform editing
                    if (isProcedurallyGenerated || (!supportsTransformEditing && !isMarker && !isSpawnPointMarker)) {
                        // Display as read-only (no editing controls)
                        appendValueRow(body, key, value);
                        return;
                    }

                    // Parse the value string (format: "x, y, z")
                    const parts = (value as string).split(',').map(s => parseFloat(s.trim()));
                    if (parts.length !== 3 || parts.some(p => isNaN(p))) {
                        // Fallback to non-editable display if parsing fails
                        appendValueRow(body, key, value);
                        return;
                    }

                    // Create shared values array that all components will reference
                    const values = [parts[0]!, parts[1]!, parts[2]!];

                    // Create container for component editors
                    const lineContainer = document.createElement('div');
                    lineContainer.className = 'oi-transform-row';

                    const label = document.createElement('span');
                    label.className = 'oi-transform-label';
                    label.textContent = `${translateKey(key)}:`;
                    lineContainer.appendChild(label);

                    // Create draggable component editors for X, Y, Z
                    const axes = ['X', 'Y', 'Z'] as const;

                    // Helper function to apply values to object
                    const applyValues = () => {
                        // Check if object is a marker - update marker data if so
                        if (isMarker && object.userData?.markerData && this.getMarkerSystem) {
                            const markerSystem = this.getMarkerSystem();
                            const markerData = object.userData.markerData;

                            if (key === 'position' && object.position) {
                                object.position.set(values[0]!, values[1]!, values[2]!);
                                markerData.position = { x: values[0]!, y: values[1]!, z: values[2]! };
                                markerSystem.updateMarker(markerData.id, { position: markerData.position }, true);
                                if (this.markSceneChanges) {
                                    this.markSceneChanges(object);
                                }
                            } else if (key === 'rotation' && object.rotation) {
                                object.rotation.set(values[0]!, values[1]!, values[2]!);
                                markerData.rotation = { x: values[0]!, y: values[1]!, z: values[2]! };
                                markerSystem.updateMarker(markerData.id, { rotation: markerData.rotation }, true);
                                if (this.markSceneChanges) {
                                    this.markSceneChanges(object);
                                }
                            }
                            object.updateMatrixWorld(true);
                            return;
                        }

                        // Regular object transform updates
                        if (key === 'position' && object.position) {
                            object.position.set(values[0]!, values[1]!, values[2]!);
                            object.updateMatrixWorld(true);
                        } else if (key === 'rotation' && object.rotation) {
                            object.rotation.set(values[0]!, values[1]!, values[2]!);
                            object.updateMatrixWorld(true);
                        } else if (key === 'scale' && object.scale) {
                            object.scale.set(values[0]!, values[1]!, values[2]!);
                            object.updateMatrixWorld(true);
                        }

                        // Update VoxelObject physics if this is a voxel object
                        if (object instanceof VoxelObject && (key === 'position' || key === 'rotation' || key === 'scale')) {
                            object.updatePhysicsTransform();
                        }

                        // Update InstancedMesh if this object is part of one
                        updateInstancedMesh(object);

                        // Mark scene changes for non-procedural objects (placed objects, environment objects)
                        if (!isProcedurallyGenerated && this.markSceneChanges) {
                            this.markSceneChanges(object);
                        }
                    };

                    // Helper function to update InstancedMesh instance if applicable
                    const updateInstancedMesh = (obj: THREE.Object3D) => {
                        // Check if object is part of an InstancedMesh system
                        const instanceId = (obj as any).instanceId ?? (obj as any).environmentInstanceId;
                        const environmentType = (obj as any).environmentType;

                        if (instanceId !== undefined && instanceId !== null) {
                            // Try to find the InstancedMesh in the scene
                            // When unpacked, InstancedMeshes are removed from scene but may still exist
                            // Search scene for InstancedMeshes that match the object's type
                            let scene = obj.parent;
                            while (scene && !(scene as any).isScene) {
                                scene = scene.parent;
                            }

                            if (scene) {
                                scene.traverse((node: THREE.Object3D) => {
                                    if ((node as any).isInstancedMesh) {
                                        const instancedMesh = node as THREE.InstancedMesh;
                                        // Check if this InstancedMesh matches by name or type
                                        const meshName = instancedMesh.name.toLowerCase();
                                        const objName = obj.name.toLowerCase();

                                        const matches =
                                            (meshName === 'trees' && (objName.includes('tree') || environmentType === 'tree')) ||
                                            (meshName === 'rocks' && (objName.includes('rock') || environmentType === 'rock'));

                                        if (matches && instanceId < instancedMesh.count) {
                                            // Update the instance matrix
                                            const matrix = new THREE.Matrix4();
                                            obj.updateMatrixWorld(true);
                                            matrix.copy(obj.matrixWorld);
                                            instancedMesh.setMatrixAt(instanceId, matrix);
                                            instancedMesh.instanceMatrix.needsUpdate = true;
                                        }
                                    }
                                });
                            }

                            // Also check if parent is an InstancedMesh (in case it's still in hierarchy)
                            let parent = obj.parent;
                            while (parent) {
                                if ((parent as any).isInstancedMesh) {
                                    const instancedMesh = parent as THREE.InstancedMesh;
                                    if (instanceId < instancedMesh.count) {
                                        const matrix = new THREE.Matrix4();
                                        obj.updateMatrixWorld(true);
                                        matrix.copy(obj.matrixWorld);
                                        instancedMesh.setMatrixAt(instanceId, matrix);
                                        instancedMesh.instanceMatrix.needsUpdate = true;
                                    }
                                    break;
                                }
                                parent = parent.parent;
                            }
                        }
                    };

                    // Helper function to update all component displays
                    const updateAllDisplays = () => {
                        const allInputs = lineContainer.querySelectorAll('input[data-transform-type="' + key + '"]');
                        allInputs.forEach((input, idx) => {
                            (input as HTMLInputElement).value = values[idx]!.toFixed(3);
                            (input as HTMLInputElement).dataset.value = values[idx]!.toString();
                        });
                    };

                    axes.forEach((axis, index) => {
                        const componentContainer = document.createElement('div');
                        componentContainer.className = 'oi-transform-component';

                        const axisLabel = document.createElement('span');
                        axisLabel.textContent = axis;
                        axisLabel.className = 'oi-axis-label';
                        axisLabel.dataset.value = values[index]!.toString();
                        axisLabel.dataset.axis = axis.toLowerCase();
                        axisLabel.dataset.transformType = key;

                        const valueInput = document.createElement('input');
                        valueInput.type = 'number';
                        valueInput.step = key === 'rotation' ? '0.001' : '0.01';
                        valueInput.value = values[index]!.toFixed(3);
                        valueInput.className = 'oi-axis-input';
                        valueInput.dataset.value = values[index]!.toString();
                        valueInput.dataset.axis = axis.toLowerCase();
                        valueInput.dataset.transformType = key;

                        let isDragging = false;
                        let dragStartX = 0;
                        let dragStartValue = 0;

                        // Make axis label draggable for scrubbing
                        axisLabel.addEventListener('mousedown', (e) => {
                            e.stopPropagation();
                            e.preventDefault();

                            isDragging = true;
                            dragStartX = e.clientX;
                            dragStartValue = values[index]!;
                            // Aquamarine accent + dark text marks the active-scrub state (Bitmagic primary CTA).
                            axisLabel.style.background = BM.aqua;
                            axisLabel.style.color = BM.textOnAccent;
                            document.body.style.cursor = 'ew-resize';
                            document.body.style.userSelect = 'none';

                            const onMouseMove = (moveEvent: MouseEvent) => {
                                if (!isDragging) return;

                                moveEvent.preventDefault();

                                const deltaX = moveEvent.clientX - dragStartX;
                                // Sensitivity: 1 pixel = 0.01 units for position/scale, 0.001 radians for rotation
                                const sensitivity = key === 'rotation' ? 0.001 : 0.01;
                                const deltaValue = deltaX * sensitivity;
                                let newValue = dragStartValue + deltaValue;

                                // Apply snapping based on transform type
                                if (key === 'position') {
                                    newValue = Math.round(newValue * 100) / 100; // 0.01 snap (1cm)
                                } else if (key === 'rotation') {
                                    newValue = Math.round(newValue * 1000) / 1000; // 0.001 snap
                                } else if (key === 'scale') {
                                    newValue = Math.max(0.01, Math.round(newValue * 100) / 100); // 0.01 snap, min 0.01
                                }

                                // Update the value
                                values[index] = newValue;

                                // Apply to object immediately
                                applyValues();

                                // Update all displays
                                updateAllDisplays();
                            };

                            const onMouseUp = () => {
                                if (isDragging) {
                                    isDragging = false;
                                    axisLabel.style.background = '';
                                    axisLabel.style.color = '';
                                    document.body.style.cursor = '';
                                    document.body.style.userSelect = '';
                                    document.removeEventListener('mousemove', onMouseMove);
                                    document.removeEventListener('mouseup', onMouseUp);

                                    // Refresh the inspector to show updated values
                                    this.refresh(object);
                                }
                            };

                            document.addEventListener('mousemove', onMouseMove);
                            document.addEventListener('mouseup', onMouseUp);
                        });

                        // Text input editing
                        valueInput.addEventListener('change', () => {
                            const newValue = parseFloat(valueInput.value);
                            if (!isNaN(newValue)) {
                                values[index] = newValue;
                                applyValues();
                                updateAllDisplays();
                                this.refresh(object);
                            } else {
                                // Restore original value
                                valueInput.value = values[index]!.toFixed(3);
                            }
                        });

                        valueInput.addEventListener('blur', () => {
                            // Ensure value is formatted correctly
                            valueInput.value = values[index]!.toFixed(3);
                        });

                        componentContainer.appendChild(axisLabel);
                        componentContainer.appendChild(valueInput);
                        lineContainer.appendChild(componentContainer);
                    });

                    line.appendChild(lineContainer);
                    body.appendChild(line);
                    return;
                }

                appendValueRow(body, key, value);
            });

            section.appendChild(header);
            section.appendChild(body);
            content.appendChild(section);
        };

        // Display sections
        // Show read-only warning for procedurally generated objects when editing is unlocked
        if (isEditingUnlocked && isProcedurallyGenerated) {
            const warningDiv = document.createElement('div');
            warningDiv.className = 'oi-warning';
            warningDiv.textContent = t('editor.panels.readOnlyTerrainEdit');
            content.appendChild(warningDiv);
        }

        // Show info text for markers
        if (isMarker) {
            const infoDiv = document.createElement('div');
            infoDiv.className = 'oi-info';
            infoDiv.textContent = t('editor.panels.markersNotVisible');
            content.appendChild(infoDiv);
        }

        createSection(t('editor.panels.basicInfo'), info.basic, { showJumpTo: true });
        createSection(t('editor.panels.transform'), info.transform, { isTransform: true });

        // Cross-link: PlayerGroup → player spawn point, and vice versa
        this.displayCrossLinks(object, content);

        // Asset description — the generated description used for high-quality
        // graphics (e.g. forged-city landmarks/buildings). Read-only info, shown
        // regardless of the scene-editing lock.
        if ((SelectableObjectConfig.isEnvironmentInstance(object) || SelectableObjectConfig.isVoxelObject(object)) && this.getGameData) {
            const { assetDef } = this.resolveInstanceAsset(object);
            if (assetDef && (assetDef.name || assetDef.description)) {
                const descSection = document.createElement('div');
                descSection.className = 'oi-section';

                const descHeader = document.createElement('div');
                descHeader.className = 'oi-terrain-header';
                descHeader.textContent = 'Description';
                descSection.appendChild(descHeader);

                const descBody = document.createElement('div');
                descBody.className = 'oi-section-body';

                if (assetDef.name) {
                    descBody.appendChild(labeledRow('Asset: ', assetDef.name));
                }
                if (assetDef.description) {
                    const descText = document.createElement('div');
                    descText.className = 'oi-description-text';
                    descText.textContent = assetDef.description;
                    descBody.appendChild(descText);
                }

                // How this object was produced, and how to produce it again.
                //
                // The old rule was one-shot: the button appeared only while the
                // asset was still a forger stand-in, and a successful
                // generation wrote a description that suppressed it forever —
                // so the only way to re-roll was asking the agent, which
                // usually reverted to a procedural box model. Every method the
                // asset has inputs for now stays on offer.
                const production = describeAssetProduction(assetDef);
                const generating = isGeneratingHqAsset(assetDef.id);

                descBody.appendChild(labeledRow('Produced by: ', production.label));

                if (isPlaceholderAsset(assetDef)) {
                    const badge = document.createElement('div');
                    badge.className = generating ? 'oi-generating-badge' : 'oi-placeholder-badge';
                    badge.textContent = generating
                        ? 'Generating a detailed version…'
                        : 'AI placeholder — box-model stand-in';
                    descBody.appendChild(badge);
                }

                // Only the regenerations THIS host can actually run. A method the host would
                // drop on the floor is worse as a button than as an absence: the CLI's dev view
                // has no upload dialog and no procedural re-baker, and a creator who pressed
                // those got silence.
                const offered = getEditorHost().capabilities.hqMethods;

                if (generating) {
                    // A job is already running. Say so rather than offering a
                    // second run — generation takes minutes, and the only
                    // previous feedback was the object silently changing later.
                    const busy = document.createElement('button');
                    busy.className = 'oi-hq-generate-btn';
                    busy.textContent = 'Working on it — this takes a few minutes';
                    busy.disabled = true;
                    descBody.appendChild(busy);
                } else if (offered.length > 0) {
                    // Scope: an asset is shared by every instance of its type,
                    // so any of the actions below affect them all. That is
                    // nearly always what's wanted, hence the default; unticking
                    // it forks a copy for the selected instance alone. It reads
                    // as a modifier on the buttons, so it sits AFTER them.
                    const scopeRow = document.createElement('label');
                    scopeRow.className = 'oi-scope-row';
                    const scopeCheck = document.createElement('input');
                    scopeCheck.type = 'checkbox';
                    scopeCheck.checked = true;
                    const scopeText = document.createElement('span');
                    scopeText.className = 'oi-field-value';
                    const instanceCount = this.countInstancesOfAsset(assetDef.id);
                    scopeText.textContent = instanceCount > 1
                        ? `Apply to all ${instanceCount} of this type`
                        : 'Apply to all of this type';
                    scopeRow.appendChild(scopeCheck);
                    scopeRow.appendChild(scopeText);

                    const regenRow = document.createElement('div');
                    regenRow.className = 'oi-button-row';
                    const regen = (method: EditorHqMethod, label: string, title: string): void => {
                        if (!offered.includes(method)) return;
                        const btn = document.createElement('button');
                        btn.className = 'oi-hq-generate-btn';
                        btn.textContent = label;
                        btn.title = title;
                        btn.addEventListener('click', () => {
                            getEditorHost().requestHq({
                                assetId: assetDef.id,
                                assetName: assetDef.name ?? assetDef.id,
                                method,
                                replaceAllOfType: scopeCheck.checked,
                                objectId: (object.userData as { objectId?: string }).objectId ?? null,
                            });
                        });
                        regenRow.appendChild(btn);
                    };

                    if (production.canRegenerateProcedural) {
                        regen('procedural', 'Rebuild procedurally',
                            'Re-run the stored parts spec — same recipe, so you get the same object back');
                    }
                    // "Generate with AI" said nothing: these objects were ALREADY made
                    // by AI, and it reads equally well as the procedural rebuild beside
                    // it. What the button actually offers is the quality upgrade — a
                    // rendered-and-lifted mesh replacing the box-model stand-in — so it
                    // is named for that, as it was before the three-method split.
                    regen('generated', 'Generate high-quality version',
                        production.prompt
                            ? `Render a detailed model from: "${production.prompt.slice(0, 80)}"`
                            : 'Describe what this should look like and render a detailed model');
                    regen('upload', 'Replace by upload',
                        'Replace this object with a model you upload');
                    if (regenRow.childElementCount > 0) descBody.appendChild(regenRow);
                    descBody.appendChild(scopeRow);
                }

                descSection.appendChild(descBody);
                content.appendChild(descSection);
            }
        }

        // Voxels section: provenance + editing entry points for voxel objects
        // (docs/voxel-editor-design.md §3.1). Selection is allowed regardless
        // of the lock; the edit actions gate on the unlocked state.
        if ((SelectableObjectConfig.isEnvironmentInstance(object) || SelectableObjectConfig.isVoxelObject(object))
            && this.getGameData && this.onEditVoxels) {
            const { assetDef } = this.resolveInstanceAsset(object);

            const isVxlLike = SelectableObjectConfig.isVoxelObject(object)
                || (assetDef ? assetDef.type === 'vxl' : false);
            if (isVxlLike) {
                const voxSection = document.createElement('div');
                voxSection.className = 'oi-section';

                const voxHeader = document.createElement('div');
                voxHeader.className = 'oi-terrain-header';
                voxHeader.textContent = 'Voxels';
                voxSection.appendChild(voxHeader);

                const voxBody = document.createElement('div');
                voxBody.className = 'oi-section-body';

                // Provenance badge: what the voxels were generated from and
                // whether they carry manual edits.
                const hasGlbSource = !!assetDef?.sourceGlbUrl;
                const hasImportSource = !!assetDef?.sourceModelUrl;
                const provenance = hasGlbSource ? 'Voxelized from 3D model'
                    : hasImportSource ? 'Imported voxel model'
                    : 'Native voxels';
                const edited = assetDef?.voxelEdited === true;

                voxBody.appendChild(labeledRow('Source: ', provenance + (edited ? ' · hand-edited' : '')));

                if (isEditingUnlocked) {
                    const btnRow = document.createElement('div');
                    btnRow.className = 'oi-button-row';

                    const editBtn = document.createElement('button');
                    editBtn.className = 'oi-btn';
                    editBtn.textContent = '✏️ Edit Voxels';
                    editBtn.title = hasGlbSource
                        ? 'Edit voxels directly. Re-voxelizing from the source model will discard these edits.'
                        : 'Edit this object voxel by voxel';
                    editBtn.onclick = () => this.onEditVoxels!(object);
                    btnRow.appendChild(editBtn);

                    // Edit Source reaches the host through EditorHost.navigate(), which no-ops when
                    // the host has no chrome to open the re-bake dialog in (`bitmagic dev`,
                    // published games) — so without the capability this was a dead button there.
                    // Hiding it costs that lane nothing: `bitmagic assets revoxelize` re-bakes from
                    // `sourceGlbUrl`, so the action still exists, just as a command.
                    const canNavigate = getEditorHost().capabilities.hostNavigation;
                    if (hasGlbSource && assetDef?.id && this.onOpenAssetAction && canNavigate) {
                        const srcBtn = document.createElement('button');
                        srcBtn.className = 'oi-btn';
                        srcBtn.textContent = '🔧 Edit Source…';
                        srcBtn.title = 'Adjust voxelization settings or replace the source model, then re-voxelize (regenerates LODs)';
                        srcBtn.onclick = () => this.onOpenAssetAction!(assetDef.id, 'revoxelize');
                        btnRow.appendChild(srcBtn);
                    }
                    // Re-import is NOT gated, and the asymmetry is the point. Nothing in the CLI
                    // lane re-runs a `.vox`/`.qb` import — `chooseSource` (cli/src/assets/
                    // revoxelize.ts) reads only `sourceVxlMasterUrl` and `sourceGlbUrl`, and
                    // `sourceModelUrl` appears nowhere in `cli/src` — so hiding this leaves an
                    // imported asset with no way back to its settings at all, and re-adding the
                    // file mints a new id that orphans every placed instance. A button that
                    // reports it cannot act here beats a creator who cannot tell the action
                    // exists. Gate it once `bitmagic assets reimport` is real.
                    if (hasImportSource && assetDef?.id && this.onOpenAssetAction) {
                        const reimportBtn = document.createElement('button');
                        reimportBtn.className = 'oi-btn';
                        reimportBtn.textContent = '📥 Re-import…';
                        reimportBtn.title = 'Re-run the .vox/.qb import with different settings';
                        reimportBtn.onclick = () => this.onOpenAssetAction!(assetDef.id, 'reimport');
                        btnRow.appendChild(reimportBtn);
                    }

                    voxBody.appendChild(btnRow);
                }

                voxSection.appendChild(voxBody);
                content.appendChild(voxSection);
            }
        }

        // Terrain section: flatten terrain checkbox for environment instances
        if (isEditingUnlocked && SelectableObjectConfig.isEnvironmentInstance(object) && this.onToggleFlattenTerrain) {
            const { objectId, envObjDef, assetDef } = this.resolveInstanceAsset(object);
            if (envObjDef && objectId) {
                // Current flatten state: instance override → asset default → false
                const currentFlatten = envObjDef.flattenTerrain ?? assetDef?.flattenTerrain ?? false;
                this.appendCheckboxSection(content, 'Terrain', 'Flatten terrain', currentFlatten,
                    (checked) => this.onToggleFlattenTerrain!(objectId, checked));
            }
        }

        // Destructible toggle for environment instances and VoxelObjects
        if (isEditingUnlocked && (SelectableObjectConfig.isEnvironmentInstance(object) || SelectableObjectConfig.isVoxelObject(object)) && this.onToggleDestructible) {
            const { objectId, envObjDef } = this.resolveInstanceAsset(object);
            if (envObjDef && objectId) {
                const label = t('editor.panels.destructible');
                this.appendCheckboxSection(content, label, label, envObjDef.destructible === true,
                    (checked) => this.onToggleDestructible!(objectId, checked));
            }
        }

        // Remove Object button for editable environment instances
        if (isEditingUnlocked && SelectableObjectConfig.isEnvironmentInstance(object) && this.onRemoveObject) {
            const objectId = object.userData?.objectId as string | undefined;
            if (objectId) {
                const removeSection = document.createElement('div');
                removeSection.className = 'oi-section';

                const removeBtn = document.createElement('button');
                removeBtn.textContent = t('editor.panels.removeObject');
                removeBtn.className = 'oi-remove-btn';
                removeBtn.onclick = () => {
                    this.onRemoveObject!(object);
                };

                removeSection.appendChild(removeBtn);
                content.appendChild(removeSection);
            }
        }

        // If this is the character, also show Character Config
        if (object.name === 'PlayerGroup' || object.name === 'LocalPlayer') {
            this.displayConfigSection(CHARACTER_CONFIG);
        }

        // Engine mechanisms (spinners, movers, crushers, crumbling floors, …)
        // publish an editable-parameter contract on their mesh — render it as a
        // live-editable section.
        this.createMechanismSection(content, object);

        // Check if we have advanced sections to show
        const physicsBody = object.userData?.physicsBody || object.userData?.rigidBody;
        const hasGeometry = info.geometry && Object.keys(info.geometry).length > 0;
        const hasMaterial = info.material && Object.keys(info.material).length > 0;
        const hasUserData = info.userData && Object.keys(info.userData).length > 0;
        const hasPhysics = info.physics && Object.keys(info.physics).length > 0;
        const hasChildren = info.children && info.children.length > 0;

        if (hasGeometry || hasMaterial || hasUserData || hasPhysics || hasChildren) {
            // Create collapsible Advanced section
            const advancedContainer = document.createElement('div');
            advancedContainer.className = 'oi-advanced-container';

            const advancedToggle = document.createElement('button');
            advancedToggle.textContent = '▶ Advanced';
            advancedToggle.className = 'oi-advanced-toggle';

            const advancedContent = document.createElement('div');
            advancedContent.className = 'oi-advanced-content';
            advancedContent.style.display = 'none';

            advancedToggle.onclick = () => {
                const isExpanded = advancedContent.style.display !== 'none';
                advancedContent.style.display = isExpanded ? 'none' : 'block';
                advancedToggle.textContent = isExpanded ? '▶ Advanced' : '▼ Advanced';
                advancedToggle.classList.toggle('oi-advanced-toggle--expanded', !isExpanded);
            };

            // Helper to create a simple section inside Advanced
            const createAdvancedSection = (title: string, data: Record<string, unknown>) => {
                if (!data || Object.keys(data).length === 0) return;
                const section = document.createElement('div');
                section.className = 'oi-section';
                const header = document.createElement('div');
                header.className = 'oi-section-header--simple';
                header.textContent = title;
                section.appendChild(header);
                const body = document.createElement('div');
                body.className = 'oi-section-body';
                Object.entries(data).forEach(([key, value]) => appendValueRow(body, key, value));
                section.appendChild(body);
                advancedContent.appendChild(section);
            };

            // Geometry section
            if (hasGeometry) {
                createAdvancedSection(t('editor.panels.geometry'), info.geometry);
            }

            // Material section
            if (hasMaterial) {
                createAdvancedSection(t('editor.panels.material'), info.material);
            }

            // User Data section
            if (hasUserData) {
                createAdvancedSection(t('editor.panels.userData'), info.userData);
            }

            // Physics section with collision visualization toggle
            if (hasPhysics) {
                const section = document.createElement('div');
                section.className = 'oi-section';
                const header = document.createElement('div');
                header.className = 'oi-section-header';
                const titleSpan = document.createElement('span');
                titleSpan.textContent = 'Physics / Collision';
                header.appendChild(titleSpan);
                if (physicsBody) {
                    const showBtn = document.createElement('button');
                    showBtn.textContent = this.collisionVisualization ? 'Hide Collision' : 'Show Collision';
                    showBtn.className = 'oi-btn';
                    showBtn.onclick = () => {
                        if (this.collisionVisualization) {
                            this.clearCollisionVisualization();
                            showBtn.textContent = 'Show Collision';
                        } else {
                            this.showCollisionVisualization(physicsBody, object);
                            showBtn.textContent = 'Hide Collision';
                        }
                    };
                    header.appendChild(showBtn);
                }
                section.appendChild(header);
                const body = document.createElement('div');
                body.className = 'oi-section-body';
                Object.entries(info.physics).forEach(([key, value]) => {
                    const row = document.createElement('div');
                    row.className = 'oi-physics-row';
                    const label = document.createElement('span');
                    label.className = 'oi-physics-label';
                    label.textContent = translateKey(key) + ':';
                    const val = document.createElement('span');
                    val.className = 'oi-physics-value';
                    val.textContent = String(value);
                    row.appendChild(label);
                    row.appendChild(val);
                    body.appendChild(row);
                });
                section.appendChild(body);
                advancedContent.appendChild(section);
            }

            // Children section
            if (hasChildren) {
                const section = document.createElement('div');
                section.className = 'oi-section';
                const header = document.createElement('div');
                header.className = 'oi-section-header--simple';
                header.textContent = t('editor.panels.children');
                section.appendChild(header);
                const body = document.createElement('div');
                body.className = 'oi-section-body';

                // Count line
                const countLine = document.createElement('div');
                countLine.className = 'oi-field-row';
                countLine.innerHTML = `<span class="oi-field-label">${translateKey('count')}:</span> <span class="oi-field-value">${info.children.length}</span>`;
                body.appendChild(countLine);

                // Items
                const itemsLine = document.createElement('div');
                itemsLine.innerHTML = `<span class="oi-field-label">${translateKey('items')}:</span> [${info.children.length} ${t('editor.panels.items')}]`;
                body.appendChild(itemsLine);

                info.children.forEach((child: { name: string; type: string }, index: number) => {
                    const subLine = document.createElement('div');
                    subLine.className = 'oi-field-subline';
                    subLine.textContent = `${index}: ${safeStringify(child)}`;
                    body.appendChild(subLine);
                });

                section.appendChild(body);
                advancedContent.appendChild(section);
            }

            advancedContainer.appendChild(advancedToggle);
            advancedContainer.appendChild(advancedContent);
            content.appendChild(advancedContainer);
        }
    }

    /** Clean up when inspector is closed/hidden */
    cleanup(): void {
        this.clearCollisionVisualization();
    }
}

