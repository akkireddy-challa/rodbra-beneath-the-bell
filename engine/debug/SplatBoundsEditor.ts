/**
 * SplatBoundsEditor — visual editor for `Asset.cropBounds`.
 *
 * Workflow:
 *   1. enable(renderer, initialBounds) — creates a wireframe Box (parented to
 *      the splat mesh, so it inherits the splat's world transform) and attaches
 *      a TransformControls gizmo to it. Bounds are in untransformed/SPZ-local
 *      coords and the wireframe lives in that same local space.
 *   2. setMode('translate' | 'scale') — switches gizmo mode. Translate moves
 *      the box centre; scale resizes about the centre. Both operate in local
 *      space so the gizmo axes follow the splat's local axes (the only frame
 *      the user can reason about for cropping).
 *   3. The tool fires onBoundsChanged on every drag tick and on mouseUp. The
 *      creator panel mirrors the latest bounds and saves on user "Save".
 *   4. disable() removes the wireframe + gizmo and restores camera control.
 *
 * The bounds are kept in sync with the underlying proxy mesh:
 *   - mesh.position = bounds centre (local)
 *   - mesh.scale    = bounds size (local)
 *   The mesh geometry is a unit BoxGeometry(1,1,1), so scale * geometry directly
 *   yields the box extents.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { GaussianSplatRenderer } from 'engine/GaussianSplatRenderer.js';

export type Bounds = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
export type BoundsEditMode = 'translate' | 'scale';

export interface BoundsEditorCallbacks {
    onBoundsChanged?: (bounds: Bounds) => void;
    onDragStart?: () => void;
    onDragEnd?: (bounds: Bounds) => void;
    onExited?: () => void;
}

export class SplatBoundsEditor {
    private scene: THREE.Scene;
    private camera: THREE.Camera;
    private domElement: HTMLElement;
    private callbacks: BoundsEditorCallbacks;

    private renderer: GaussianSplatRenderer | null = null;
    private proxyMesh: THREE.Mesh | null = null;
    private wireframe: THREE.LineSegments | null = null;
    private transformControls: TransformControls | null = null;
    private gizmoHelper: THREE.Object3D | null = null;
    private currentMode: BoundsEditMode = 'translate';
    private cameraDisableHook: ((dragging: boolean) => void) | null = null;

    constructor(
        scene: THREE.Scene,
        camera: THREE.Camera,
        domElement: HTMLElement,
        callbacks: BoundsEditorCallbacks,
        cameraDisableHook?: (dragging: boolean) => void,
    ) {
        this.scene = scene;
        this.camera = camera;
        this.domElement = domElement;
        this.callbacks = callbacks;
        this.cameraDisableHook = cameraDisableHook ?? null;
    }

    isEnabled(): boolean {
        return this.proxyMesh !== null;
    }

    getMode(): BoundsEditMode {
        return this.currentMode;
    }

    enable(renderer: GaussianSplatRenderer, initialBounds: Bounds): boolean {
        if (this.proxyMesh) this.disable(/* silent */ true);
        // Defensive: scrub any orphaned proxy/wire from prior sessions before
        // creating new ones. If a previous edit session somehow left meshes
        // attached to a different splat (race during reload, bug in cleanup),
        // we don't want them piling up.
        this.scrubSceneOrphans();

        const splatMesh = renderer.getSplatMesh() as unknown as THREE.Object3D | null;
        if (!splatMesh) return false;

        this.renderer = renderer;

        const sizeX = Math.max(0.01, initialBounds.maxX - initialBounds.minX);
        const sizeY = Math.max(0.01, initialBounds.maxY - initialBounds.minY);
        const sizeZ = Math.max(0.01, initialBounds.maxZ - initialBounds.minZ);
        const cx = (initialBounds.minX + initialBounds.maxX) / 2;
        const cy = (initialBounds.minY + initialBounds.maxY) / 2;
        const cz = (initialBounds.minZ + initialBounds.maxZ) / 2;

        // Invisible proxy mesh — TransformControls operates on this. It's a
        // unit cube so scale directly gives box extents in the splat's local
        // frame. We don't render the mesh itself — only the wireframe child.
        const geom = new THREE.BoxGeometry(1, 1, 1);
        const mat = new THREE.MeshBasicMaterial({ visible: false, depthTest: false });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = '__splatBoundsProxy__';
        mesh.position.set(cx, cy, cz);
        mesh.scale.set(sizeX, sizeY, sizeZ);
        splatMesh.add(mesh);
        this.proxyMesh = mesh;

        // Wireframe overlay as a child of the proxy — inherits the proxy's
        // scale so the lines always match the box exactly. Drawn on top.
        const edges = new THREE.EdgesGeometry(geom);
        const lineMat = new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false, depthWrite: false, transparent: true });
        const lines = new THREE.LineSegments(edges, lineMat);
        lines.name = '__splatBoundsWire__';
        lines.renderOrder = 9999;
        mesh.add(lines);
        this.wireframe = lines;

        const tc = new TransformControls(this.camera as THREE.PerspectiveCamera, this.domElement);
        tc.setSpace('local');
        tc.setMode('translate');
        tc.setSize(0.85);
        tc.attach(mesh);

        const helper = (tc as unknown as { getHelper?: () => THREE.Object3D }).getHelper?.();
        if (helper) {
            this.scene.add(helper);
            this.gizmoHelper = helper;
        } else {
            // Fallback for older three: TransformControls IS the helper.
            this.scene.add(tc as unknown as THREE.Object3D);
            this.gizmoHelper = tc as unknown as THREE.Object3D;
        }

        tc.addEventListener('dragging-changed', (event) => {
            const dragging = (event as { value: boolean }).value;
            this.cameraDisableHook?.(dragging);
            if (dragging) {
                this.callbacks.onDragStart?.();
            } else {
                this.callbacks.onDragEnd?.(this.computeBoundsFromMesh());
            }
        });

        tc.addEventListener('change', () => {
            // Skip if mesh has been removed (race during disable).
            if (!this.proxyMesh) return;
            this.callbacks.onBoundsChanged?.(this.computeBoundsFromMesh());
        });

        this.transformControls = tc;
        this.currentMode = 'translate';
        return true;
    }

    setMode(mode: BoundsEditMode): void {
        if (!this.transformControls) return;
        this.currentMode = mode;
        this.transformControls.setMode(mode);
    }

    /**
     * Apply explicit bounds (e.g. user typed values, or "reset to dense
     * bounds" button). Updates the proxy mesh and emits onBoundsChanged.
     */
    setBounds(bounds: Bounds): void {
        if (!this.proxyMesh) return;
        const sizeX = Math.max(0.01, bounds.maxX - bounds.minX);
        const sizeY = Math.max(0.01, bounds.maxY - bounds.minY);
        const sizeZ = Math.max(0.01, bounds.maxZ - bounds.minZ);
        this.proxyMesh.position.set(
            (bounds.minX + bounds.maxX) / 2,
            (bounds.minY + bounds.maxY) / 2,
            (bounds.minZ + bounds.maxZ) / 2,
        );
        this.proxyMesh.scale.set(sizeX, sizeY, sizeZ);
        this.callbacks.onBoundsChanged?.(this.computeBoundsFromMesh());
    }

    getBounds(): Bounds | null {
        if (!this.proxyMesh) return null;
        return this.computeBoundsFromMesh();
    }

    private computeBoundsFromMesh(): Bounds {
        const m = this.proxyMesh!;
        const halfX = Math.abs(m.scale.x) / 2;
        const halfY = Math.abs(m.scale.y) / 2;
        const halfZ = Math.abs(m.scale.z) / 2;
        return {
            minX: m.position.x - halfX,
            minY: m.position.y - halfY,
            minZ: m.position.z - halfZ,
            maxX: m.position.x + halfX,
            maxY: m.position.y + halfY,
            maxZ: m.position.z + halfZ,
        };
    }

    disable(silent: boolean = false): void {
        if (this.transformControls) {
            try { this.transformControls.detach(); } catch { /* ignore */ }
            try { (this.transformControls as unknown as { dispose?: () => void }).dispose?.(); } catch { /* ignore */ }
            this.transformControls = null;
        }
        if (this.gizmoHelper && this.gizmoHelper.parent) {
            this.gizmoHelper.parent.remove(this.gizmoHelper);
        }
        this.gizmoHelper = null;

        if (this.wireframe) {
            this.wireframe.geometry.dispose();
            (this.wireframe.material as THREE.Material).dispose();
            if (this.wireframe.parent) this.wireframe.parent.remove(this.wireframe);
            this.wireframe = null;
        }
        if (this.proxyMesh) {
            this.proxyMesh.geometry.dispose();
            (this.proxyMesh.material as THREE.Material).dispose();
            if (this.proxyMesh.parent) this.proxyMesh.parent.remove(this.proxyMesh);
            this.proxyMesh = null;
        }
        // Belt-and-suspenders: also nuke any orphan wireframe/proxy that may
        // have survived prior cleanup (parented to a splat mesh that didn't
        // get tracked in this.proxyMesh, e.g. from a hot-reload or race).
        this.scrubSceneOrphans();
        this.renderer = null;
        this.cameraDisableHook?.(false);
        if (!silent) this.callbacks.onExited?.();
    }

    /**
     * Walk the scene and remove any leftover bounds-editor objects (identified
     * by the `__splatBoundsProxy__` / `__splatBoundsWire__` names). Used as a
     * defensive sweep so a botched cleanup in a prior session can't leave the
     * cyan wireframe stuck on a splat during gameplay.
     */
    private scrubSceneOrphans(): void {
        const stale: THREE.Object3D[] = [];
        this.scene.traverse((obj) => {
            if (obj.name === '__splatBoundsProxy__' || obj.name === '__splatBoundsWire__') {
                stale.push(obj);
            }
        });
        for (const obj of stale) {
            if (obj.parent) obj.parent.remove(obj);
            const mesh = obj as THREE.Mesh & { material?: THREE.Material };
            mesh.geometry?.dispose?.();
            (mesh.material as THREE.Material | undefined)?.dispose?.();
        }
        if (stale.length > 0) {
            console.log(`[SplatBoundsEditor] scrubbed ${stale.length} orphan bounds object(s) from scene`);
        }
    }
}
