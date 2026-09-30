/**
 * VoxelPreviewRenderer - Generates preview images for voxel assets (.vxl files)
 *
 * Uses VoxelObject to load and render voxel data to an offscreen canvas.
 * Returns a base64 PNG image for use as cached preview thumbnails.
 */

import * as THREE from 'three';
// three's WEBGPU build is what `three` resolves to (one module instance —
// r185's node lighting matches lights by class identity, and a split across the
// core and webgpu builds renders every scene unlit). That build has no
// WebGLRenderer, so the classic renderer is imported from its own module. The
// classic path is duck-typed (isMesh / isDirectionalLight), so it renders
// objects built by the webgpu bundle without trouble.
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import type { VoxelBounds } from 'engine/VoxelGeometry.js';
import { isVxlV3, decodeVxlV3, type DecodedFragment, type DecodedVxlV3 } from 'engine/VxlV3Format.js';
import { buildOctreeMeshFromBuffers } from 'engine/VoxelOctreeRenderer.js';
import { createWebGlVoxelMaterial, isVoxelEmissiveMaterial } from 'engine/VoxelEmissiveMaterial.js';
import { createWebGlVoxelSlotMaterial, slotInfoFromMaterial } from 'engine/VoxelSlotMaterial.js';

/**
 * The material fields the WebGL rebuild copies across. Every voxel material
 * carries them (Material base properties plus the factory's constructor params),
 * and they are read STRUCTURALLY rather than by class: under WebGPU the material
 * is a TSL NodeMaterial, so an `instanceof MeshLambertMaterial` test is false for
 * exactly the materials this has to convert.
 */
interface VoxelMaterialFields {
    map?: THREE.Texture | null;
    vertexColors?: boolean;
    flatShading?: boolean;
    polygonOffsetFactor?: number;
    polygonOffsetUnits?: number;
    /** three's own marker for a TSL node material (`NodeMaterial` sets it). */
    isNodeMaterial?: boolean;
}

/** 30° above the horizon, 45° around Y — the 3/4 view every thumbnail uses. */
const CAMERA_ELEVATION = Math.PI / 6;
const CAMERA_AZIMUTH = Math.PI / 4;

/**
 * Most leaves a preview will build. Picks which baked LOD to draw: the FINEST one
 * that fits (see `pickPreviewLod`).
 *
 * The point is to bound the build, not to hit a look. A forged asset's LOD0 can run
 * to hundreds of thousands of leaves and stalls the live game for seconds per asset
 * while the Assets tab backfills; well under this, the mesh builds in a few
 * milliseconds and there is nothing to gain by coarsening.
 */
export const PREVIEW_LEAF_BUDGET = 20_000;

/**
 * Choose the LOD to draw, finest first.
 *
 * This used to take the coarsest baked level unconditionally, on the reasoning that a
 * ~256px thumbnail cannot show the difference. That holds for a large asset, where the
 * coarsest level still carries thousands of leaves — and not at all for a small one.
 * Coarsening halves the resolution per level, so a 7-voxel rock arrives at ONE cube and
 * a 92-voxel tree at nine: not a cheaper thumbnail of the asset, a thumbnail of a
 * different object. It went unnoticed while the assets that had LOD trailers were all
 * big ones; the default trees and rocks gaining LODs is what surfaced it.
 *
 * Exported only so tests can check the choice against synthetic levels. A regression
 * here is invisible until someone opens the Assets tab and looks at a thumbnail.
 */
export function pickPreviewLod(decoded: DecodedVxlV3): readonly DecodedFragment[] {
    const levels: Array<readonly DecodedFragment[]> = [
        decoded.fragments,
        ...(decoded.additionalLods ?? []).map((lod) => lod.fragments),
    ];
    for (const level of levels) {
        const leaves = level.reduce((total, fragment) => total + fragment.leaves.count, 0);
        if (leaves <= PREVIEW_LEAF_BUDGET) return level;
    }
    // Nothing fits — the coarsest is the cheapest available, and a heavy thumbnail
    // still beats no thumbnail.
    return levels[levels.length - 1]!;
}

export class VoxelPreviewRenderer {
    private renderer: THREE.WebGLRenderer | null = null;
    private scene: THREE.Scene | null = null;
    private camera: THREE.PerspectiveCamera | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private isInitialized = false;

    private readonly previewSize = 256; // Preview image size in pixels

    /** Lazily built on the first `generatePreview` call. */
    private initialize(): void {
        if (this.isInitialized) return;

        // Create offscreen canvas
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.previewSize;
        this.canvas.height = this.previewSize;

        // Create renderer
        this.renderer = new WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: true,
            preserveDrawingBuffer: true,
        });
        this.renderer.setSize(this.previewSize, this.previewSize);
        this.renderer.setClearColor(0x1e293b, 1); // Dark slate background
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        // Create scene
        this.scene = new THREE.Scene();

        // Create camera
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

        // Add lights - bright enough for clear preview thumbnails
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
        directionalLight.position.set(5, 10, 7);
        this.scene.add(directionalLight);

        // Fill light from the opposite side
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
        fillLight.position.set(-3, 2, -5);
        this.scene.add(fillLight);

        this.isInitialized = true;
    }

    /**
     * Rebuild every TSL node material on the preview object as its WebGL
     * equivalent.
     *
     * Voxel meshes are built by the shared material factory, which picks the
     * backend from the ENGINE's renderer — a node material while the engine runs
     * WebGPU (the default). This class renders through its own
     * `THREE.WebGLRenderer`, which cannot compile one: `material.type` misses
     * three's `shaderIDs` table, so it falls back to `material.vertexShader`
     * (undefined on a node material) and `resolveIncludes` throws "Cannot read
     * properties of undefined (reading 'replace')" — once per asset while the
     * Assets tab backfills thumbnails, and no preview is ever cached.
     *
     * Materials that are already WebGL-renderable are left alone. A specialised
     * node material (e.g. a car-paint finish) comes back as the standard voxel
     * Lambert — at 256px the finish is not visible anyway, and a plain thumbnail
     * beats none.
     *
     * A mesh with material SLOTS carries an ARRAY, and every entry needs the same
     * conversion. This used to bail on the array outright, which was survivable
     * only while slotted assets were rare: a slot material is a node material
     * under WebGPU, so it hit the throw above and the asset simply never got a
     * thumbnail. Material classes put most assets on that path, so the array is
     * converted entry by entry — slot entries through the slot factory, so a gold
     * slot previews as gold rather than as flat paint.
     */
    private useWebGlMaterials(root: THREE.Object3D): void {
        root.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            const material = child.material;
            child.material = Array.isArray(material)
                ? material.map((entry) => this.toWebGlMaterial(entry))
                : this.toWebGlMaterial(material);
        });
    }

    /** One material's WebGL equivalent, or the material itself when it needs none. */
    private toWebGlMaterial(material: THREE.Material): THREE.Material {
        const fields = material as THREE.Material & VoxelMaterialFields;
        if (fields.isNodeMaterial !== true) return material;
        const params = {
            map: fields.map ?? null,
            vertexColors: fields.vertexColors === true,
            flatShading: fields.flatShading === true,
            polygonOffsetFactor: fields.polygonOffsetFactor ?? 0,
            polygonOffsetUnits: fields.polygonOffsetUnits ?? 0,
        };
        const slot = slotInfoFromMaterial(material);
        // Thumbnails always render at full quality: a preview is a one-off frame,
        // and an asset's card should show the asset's real look on every device.
        if (slot) return createWebGlVoxelSlotMaterial(params, slot, 'high').material;
        return createWebGlVoxelMaterial(params, isVoxelEmissiveMaterial(material));
    }

    /**
     * Drop the previously previewed object (the lights are kept). Snapshotting
     * with `filter` matters: `remove` mutates `scene.children` in place.
     */
    private clearPreviewObjects(scene: THREE.Scene): void {
        const stale = scene.children.filter((c) => c instanceof THREE.Group || c instanceof THREE.Mesh);
        for (const obj of stale) {
            scene.remove(obj);
            if (obj instanceof THREE.Mesh) {
                obj.geometry.dispose();
                if (obj.material instanceof THREE.Material) {
                    obj.material.dispose();
                }
            }
        }
    }

    /**
     * Frame the whole asset: pull back to 2.5× its largest dimension along the
     * fixed 3/4 view direction, aim at half its height, and fit the clip planes
     * around that distance.
     */
    private frameCamera(camera: THREE.PerspectiveCamera, bounds: VoxelBounds): void {
        const sizeY = bounds.maxY - bounds.minY;
        const maxSize = Math.max(bounds.maxX - bounds.minX, sizeY, bounds.maxZ - bounds.minZ);
        const distance = maxSize * 2.5;

        camera.near = distance * 0.01;
        camera.far = distance * 10;
        camera.updateProjectionMatrix();

        const centerY = sizeY / 2;
        camera.position.set(
            Math.cos(CAMERA_AZIMUTH) * Math.cos(CAMERA_ELEVATION) * distance,
            centerY + Math.sin(CAMERA_ELEVATION) * distance,
            Math.sin(CAMERA_AZIMUTH) * Math.cos(CAMERA_ELEVATION) * distance,
        );
        camera.lookAt(0, centerY, 0);
    }

    /**
     * Generate a preview image for a VXL file
     * @param vxlData - ArrayBuffer containing the VXL file data
     * @returns Base64 encoded PNG image data URL
     */
    async generatePreview(vxlData: ArrayBuffer): Promise<string> {
        this.initialize();

        if (!this.renderer || !this.scene || !this.camera || !this.canvas) {
            throw new Error('VoxelPreviewRenderer not initialized');
        }

        this.clearPreviewObjects(this.scene);

        /*
         * For v3+ files, render straight from the decoded leaf buffers — no full
         * VoxelObject construction. Which LOD is `pickPreviewLod`'s call: the finest
         * that fits `PREVIEW_LEAF_BUDGET`, so a big asset still gets a cheap coarse
         * thumbnail while a small one is not coarsened into an unrecognisable blob.
         * Legacy JSON files keep the VoxelObject path, which upgrades them on load.
         */
        let bounds: VoxelBounds | null = null;
        let addedObject: THREE.Object3D | null = null;
        if (isVxlV3(vxlData)) {
            const decoded = await decodeVxlV3(vxlData);
            const fragments = pickPreviewLod(decoded);
            bounds = decoded.bounds;
            // Same pivot convention as VoxelObject: X/Z centre, Y bottom.
            const pivotX = (bounds.minX + bounds.maxX) / 2;
            const pivotY = bounds.minY;
            const pivotZ = (bounds.minZ + bounds.maxZ) / 2;
            const mesh = buildOctreeMeshFromBuffers(
                fragments.map((f) => f.leaves), pivotX, pivotY, pivotZ,
                false, 'voxel-preview', decoded.useAtlas,
            );
            if (mesh) {
                this.scene.add(mesh);
                addedObject = mesh;
            }
        } else {
            // Legacy JSON vxl. `loadFromFile` upgrades it to octree as it loads, so this
            // renders the same representation the branch above does — there is just no
            // baked LOD to choose from, the old form never carried one.
            const voxelObject = new VoxelObject({ shadows: false });
            bounds = await voxelObject.loadFromFile(vxlData);
            if (bounds) {
                this.scene.add(voxelObject);
                addedObject = voxelObject;
            }
        }

        // Both paths build through the engine's backend-aware factory, so the
        // materials must be converted before this class's WebGL renderer sees
        // them (no-op when the engine is on WebGL).
        if (addedObject) this.useWebGlMaterials(addedObject);

        if (!bounds) {
            console.warn('[VoxelPreviewRenderer] No bounds available for preview');
            // Return empty preview
            this.renderer.render(this.scene, this.camera);
            return this.canvas.toDataURL('image/png');
        }

        this.frameCamera(this.camera, bounds);
        this.renderer.render(this.scene, this.camera);
        const dataUrl = this.canvas.toDataURL('image/png');

        // Clean up - remove the rendered object from the scene
        if (addedObject) this.scene.remove(addedObject);

        return dataUrl;
    }

    /**
     * Dispose of renderer resources
     */
    dispose(): void {
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer = null;
        }
        this.scene = null;
        this.camera = null;
        this.canvas = null;
        this.isInitialized = false;
    }
}

// Singleton instance for reuse
let previewRendererInstance: VoxelPreviewRenderer | null = null;

/**
 * Get the singleton VoxelPreviewRenderer instance
 */
export function getVoxelPreviewRenderer(): VoxelPreviewRenderer {
    if (!previewRendererInstance) {
        previewRendererInstance = new VoxelPreviewRenderer();
    }
    return previewRendererInstance;
}
