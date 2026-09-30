/**
 * GlbPreviewRenderer - Generates preview images for GLB assets (.glb files)
 *
 * Mirror of VoxelPreviewRenderer: same offscreen canvas / renderer / lighting
 * scaffolding and singleton lifecycle, but loads a GLB scene via GLTFLoader
 * and frames its bounding sphere instead of voxel bounds.
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
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';

/** Dispose a material and any textures hanging off its slots. */
function disposeMaterial(material: THREE.Material): void {
    for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
    }
    material.dispose();
}

/** Recursively dispose geometries, materials and textures under a root. */
function disposeObjectTree(root: THREE.Object3D): void {
    root.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            if (Array.isArray(obj.material)) {
                for (const m of obj.material) disposeMaterial(m);
            } else if (obj.material instanceof THREE.Material) {
                disposeMaterial(obj.material);
            }
        }
    });
}

export class GlbPreviewRenderer {
    private renderer: THREE.WebGLRenderer | null = null;
    private scene: THREE.Scene | null = null;
    private camera: THREE.PerspectiveCamera | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private isInitialized = false;

    private readonly previewSize = 256; // Preview image size in pixels

    constructor() {
        // Lazy initialization
    }

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
     * Generate a preview image for a GLB asset
     * @param glbUrl - URL of the GLB file to render
     * @returns Base64 encoded PNG image data URL
     */
    async generatePreview(glbUrl: string): Promise<string> {
        this.initialize();

        if (!this.renderer || !this.scene || !this.camera) {
            throw new Error('GlbPreviewRenderer not initialized');
        }

        // Clear previous objects from scene (keep lights) - defensive, the
        // normal path already removes and disposes its model before returning.
        const objectsToRemove: THREE.Object3D[] = [];
        for (const child of this.scene.children) {
            if (child instanceof THREE.Group || child instanceof THREE.Mesh) {
                objectsToRemove.push(child);
            }
        }
        for (const obj of objectsToRemove) {
            this.scene.remove(obj);
            disposeObjectTree(obj);
        }

        const loader = createGltfLoader();
        const gltf = await loader.loadAsync(glbUrl);
        const model = gltf.scene;
        model.updateMatrixWorld(true);

        // Frame via the model's bounding sphere.
        const box = new THREE.Box3().setFromObject(model);
        const sphere = box.isEmpty() ? null : box.getBoundingSphere(new THREE.Sphere());
        if (!sphere || !Number.isFinite(sphere.radius) || sphere.radius <= 0) {
            console.warn('[GlbPreviewRenderer] No renderable bounds in GLB for preview');
            disposeObjectTree(model);
            // Return empty preview
            this.renderer.render(this.scene, this.camera);
            return this.canvas?.toDataURL('image/png') || '';
        }

        this.scene.add(model);

        // Camera distance = bounding-sphere diameter x 1.4. That is ~1.07x the
        // exact 45-degree-fov fit distance (radius / sin(fov/2) = 2.61r), so the
        // whole sphere is always in frame with a slight margin - the same feel
        // as VoxelPreviewRenderer's maxSize * 2.5.
        const distance = sphere.radius * 2 * 1.4;
        const cameraAngle = Math.PI / 6; // 30 degrees from horizontal
        const cameraAzimuth = Math.PI / 4; // 45 degrees around Y axis (3/4 view)

        // Adjust near/far planes to fit the model
        this.camera.near = distance * 0.01;
        this.camera.far = distance * 10;
        this.camera.updateProjectionMatrix();

        // Camera orbits and looks at the bounding-sphere center
        const center = sphere.center;
        this.camera.position.set(
            center.x + Math.cos(cameraAzimuth) * Math.cos(cameraAngle) * distance,
            center.y + Math.sin(cameraAngle) * distance,
            center.z + Math.sin(cameraAzimuth) * Math.cos(cameraAngle) * distance
        );
        this.camera.lookAt(center);

        // Render
        this.renderer.render(this.scene, this.camera);

        // Get base64 image
        const dataUrl = this.canvas?.toDataURL('image/png') || '';

        // Clean up - remove the rendered model and release its GPU resources
        this.scene.remove(model);
        disposeObjectTree(model);

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
let previewRendererInstance: GlbPreviewRenderer | null = null;

/**
 * Get the singleton GlbPreviewRenderer instance
 */
export function getGlbPreviewRenderer(): GlbPreviewRenderer {
    if (!previewRendererInstance) {
        previewRendererInstance = new GlbPreviewRenderer();
    }
    return previewRendererInstance;
}
