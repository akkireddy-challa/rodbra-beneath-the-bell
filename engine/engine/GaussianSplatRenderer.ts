import * as THREE from 'three';
import { getActiveBackend } from 'engine/RendererType.js';
import { WebGpuSplatMesh, webGpuSplatsEnabled, installWebGpuSplatToggleButton, maxWebGpuSplats } from 'engine/splats/WebGpuSplatMesh.js';
import { loadSpz } from 'engine/splats/SpzLoader.js';
import { reportWorldSubProgress } from 'engine/progress/LoadProgress.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';
import type { GaussianSplatConfig } from 'types/game.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { isStandaloneMode } from 'engine/CreatorMode.js';
import { VoxelWorld } from 'engine/VoxelWorld.js';
import { loadSplatPreviewMesh } from 'engine/SplatPreviewLoader.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';

/** Axis-aligned bounds in plain-object form (the "Raw" suffix elsewhere refers to this shape, not a coordinate frame). */
type RawBounds = { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number };

/** A legacy collider-editor id that belongs to a generated voxel grid (vs. a manual box collider). */
function isVoxelColliderId(id: string): boolean {
    return id.startsWith('voxel_') || id.startsWith('merged_');
}

export class GaussianSplatRenderer {
    /**
     * WebGPU-native splat mesh (TSL + compute sort) — the only full-splat
     * renderer. The legacy WebGL/Spark `SplatMesh` path was removed; Gaussian
     * splats now render exclusively on the WebGPU backend (on WebGL the preview
     * point cloud is the only surface shown).
     */
    private webgpuSplatMesh: WebGpuSplatMesh | null = null;
    /**
     * Lightweight point-cloud preview used in the creator iframe when a
     * `previewUrl` exists on the asset. Renders ~5% of the source gaussians
     * as plain `THREE.Points` — one draw call, fits a 25M-splat scene in
     * memory budgets the full splat would crawl through. Renderer-agnostic, so
     * it is also the WebGL fallback surface.
     */
    private previewMesh: THREE.Points | null = null;
    /** Guards `loadFullSplatInBackground` against re-entry — PVS load may fire it on every reload but we only want one fetch. */
    private fullSplatLoadStarted: boolean = false;
    /** Per-row "Gaussians" eye toggle. When false, hide every splat surface (full + preview) for this splat. */
    private splatVisibleFlag: boolean = true;
    /** Render-mode preference from the creator's Splats panel. 'points' → preview only; 'gaussian' → full WebGPU splat. */
    private splatRenderMode: 'points' | 'gaussian' = 'points';
    private glbMesh: THREE.Object3D | null = null;
    private glbVisualizationMesh: THREE.Object3D | null = null;
    private glbPhysicsBody: RAPIER.RigidBody | null = null;
    private glbPhysicsCollider: RAPIER.Collider | null = null;
    private scene: THREE.Scene;
    private config: GaussianSplatConfig;
    private loader: GLTFLoader;
    private physicsWorld: PhysicsWorld | null;
    private engine: any | null = null;
    private onLoadComplete: (() => void) | null = null;
    private isLoading: boolean = false;
    private colliderEditor: any = null;
    private colliderEditorEnabled: boolean = false;
    /** Env-object id this renderer was created for (used by save flows to target the right env object). */
    private envObjectId: string | null = null;

    /**
     * Per-splat voxel-collider grid. Each Gaussian splat owns its own
     * VoxelWorld instance: own voxel size, own physics colliders (registered
     * into the shared engine physicsWorld), own chunk meshes. Game code reads
     * this directly via `getVoxelWorld()` — no editor dependency, no
     * "active-pointer" indirection through any UI/editor component.
     */
    private voxelWorld: VoxelWorld | null = null;
    private voxelWorldBoundsRaw: RawBounds | null = null;
    /**
     * User-defined collider crop box in untransformed/SPZ-local coords
     * (mirrors Asset.cropBounds). Defines the *walkable* region — voxeliser
     * filters gaussians by this and `getVoxelColliderBounds` reports it.
     */
    private cropBoundsRaw: RawBounds | null = null;
    /**
     * User-defined cleanup/subject box in untransformed/SPZ-local coords
     * (mirrors Asset.cleanupBounds). The "what counts as the splat" outer
     * extent — used by the gaussian cleanup operation to delete background
     * noise. Typically a superset of cropBounds.
     */
    private cleanupBoundsRaw: RawBounds | null = null;
    /**
     * Per-splat shadow catcher: an invisible horizontal plane below the
     * subject that picks up cast shadows from dynamic objects. Off by
     * default (each splat opts in via Asset.shadowCatcher).
     */
    private shadowCatcherEnabled: boolean = false;
    private shadowCatcherYOffset: number = 0;
    private shadowCatcherMesh: THREE.Mesh | null = null;
    /**
     * External Object3D placeholder kept in sync with the renderer's transform so
     * `serializeEnvironmentObjects()` (which reads from sceneObject.position/rotation/scale)
     * returns the live transform.
     */
    private sceneObject: THREE.Object3D | null = null;

    // Converted THREE.js types (from canonical config)
    private position: THREE.Vector3;
    private rotation: THREE.Euler;
    private scale: THREE.Vector3;
    private statusOverlay: HTMLDivElement | null = null;

    constructor(scene: THREE.Scene, config: GaussianSplatConfig, physicsWorld?: PhysicsWorld | null, engine?: any, envObjectId?: string | null) {
        if (envObjectId) this.envObjectId = envObjectId;
        this.scene = scene;
        this.config = config;
        this.loader = createGltfLoader();
        this.physicsWorld = physicsWorld ?? null;
        this.engine = engine || null;

        // Convert canonical config format to THREE.js types
        this.position = new THREE.Vector3(config.position.x, config.position.y, config.position.z);

        // eulerAngles are in radians (matching engine convention)
        // Use 'XYZ' order to match backend voxelization transform application
        this.rotation = config.eulerAngles
            ? new THREE.Euler(
                config.eulerAngles.x,
                config.eulerAngles.y,
                config.eulerAngles.z,
                'XYZ'
            )
            : new THREE.Euler(Math.PI, 0, 0, 'XYZ'); // Default: 180° X rotation

        // Convert scale from config or use default
        this.scale = config.scale
            ? new THREE.Vector3(config.scale.x, config.scale.y, config.scale.z)
            : new THREE.Vector3(3, 3, 3); // Default scale
    }

    updateSplatTransform(position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3): void {
        this.position.copy(position);
        this.rotation.copy(rotation);
        this.scale.copy(scale);

        for (const mesh of [this.webgpuSplatMesh, this.previewMesh, this.glbMesh, this.glbVisualizationMesh, this.sceneObject]) {
            if (mesh) this.applyTransformTo(mesh);
        }
        this.glbMesh?.updateMatrixWorld(true);
        this.glbVisualizationMesh?.updateMatrixWorld(true);
        // Subject bounds are derived from this renderer's transform, so the
        // shadow catcher's world position needs to track the move.
        if (this.shadowCatcherEnabled) this.refreshShadowCatcher();
    }

    private applyTransformTo(mesh: THREE.Object3D): void {
        mesh.position.copy(this.position);
        mesh.rotation.order = 'XYZ';
        mesh.rotation.copy(this.rotation);
        mesh.scale.copy(this.scale);
        // A loaded splat (and its collider proxies) must never be re-captured
        // into a new Gaussian Splat export — that would bake an existing splat
        // into the next one. Tag every GaussianSplatRenderer-owned object so
        // the exporter hides it (and does not force-show it during capture).
        mesh.userData.excludeFromSplatExport = true;
    }

    getPosition(): THREE.Vector3 {
        return this.position;
    }

    getRotation(): THREE.Euler {
        return this.rotation;
    }

    getScale(): THREE.Vector3 {
        return this.scale;
    }

    setColliderEditor(editor: any): void {
        this.colliderEditor = editor;
    }

    getEnvObjectId(): string | null {
        return this.envObjectId;
    }

    /**
     * Register an external Object3D (registered with ObjectIdService for env-object serialization)
     * whose transform must mirror this renderer. Called by EnvironmentObjectSystem.
     */
    setSceneObject(obj: THREE.Object3D | null): void {
        this.sceneObject = obj;
        if (obj) this.applyTransformTo(obj);
    }

    async load(): Promise<void> {
        try {
            this.isLoading = true;

            // Set splat URL in collider editor for voxelization (even if colliders aren't loaded)
            if (this.colliderEditor && this.colliderEditor.setSplatUrl) {
                this.colliderEditor.setSplatUrl(this.config.url);
            }

            // Creator-mode preview path: render the downsampled `.points`
            // file instead of the full SPZ. Keeps the editor responsive on
            // big splat files (25M gaussians → 1.25M points → one draw call).
            // Voxelize / collider loads / runtime play all still use
            // `this.config.url`, so accuracy is unaffected for non-visual
            // operations. In standalone (published) mode we skip this and
            // always render the full splat.
            const usePreview = !isStandaloneMode && !!this.config.previewUrl;
            if (usePreview) {
                this.showStatus('Loading preview…');
                try {
                    this.previewMesh = await loadSplatPreviewMesh(this.config.previewUrl!);
                    this.scene.add(this.previewMesh);
                    this.applyTransformTo(this.previewMesh);
                    this.hideStatus();
                    console.log(`✅ Splat preview loaded (${this.config.previewUrl})`);
                } catch (err) {
                    // Preview is optional; on any failure fall through to the
                    // full SPZ path so the editor still shows the asset.
                    console.warn('Preview load failed, falling back to full SPZ:', err);
                    this.previewMesh = null;
                }
            }

            // If the preview rendered successfully, skip the full splat load.
            // We still want collider / voxel side loads below to run normally,
            // so we only short-circuit the full-splat branch — not the rest of
            // the method.
            const skipFullSplat = this.previewMesh !== null;

            const onWebGpu = !skipFullSplat && this.isWebGpuBackend();
            const useWebGpuSplats = onWebGpu && webGpuSplatsEnabled();

            // Full-splat rendering is WebGPU-only (the WebGL/Spark path was
            // removed). On the WebGPU backend with the opt-in latch on, load the
            // in-engine splat mesh; otherwise (opt-in off, or a WebGL backend) we
            // render no full splat — the preview point cloud is the only surface.
            if (skipFullSplat) {
                // Preview is up; nothing to do for the full visual mesh.
            } else if (useWebGpuSplats) {
                await this.loadWebGpuSplatMesh();
            } else if (onWebGpu) {
                console.warn('[Splat] WebGPU splat renderer is OFF (safety opt-in). ' +
                    'No full splat will render. Use the on-screen "Enable WebGPU splats" button to turn it on.');
                installWebGpuSplatToggleButton(false);
            } else {
                console.warn('[Splat] Gaussian splats require the WebGPU backend; ' +
                    'the WebGL renderer shows the preview point cloud only.');
            }

            // Mesh-collider path: when the asset has a colliderUrl AND the user
            // hasn't explicitly set colliderType='voxel', fetch the prebuilt
            // collision GLB and route it through setupGlbMesh / createGlbPhysics.
            // The voxel-collider load is skipped entirely in this mode — the
            // mesh trimesh fully replaces it.
            const useMeshCollider = !!this.config.colliderUrl && this.config.colliderType !== 'voxel';
            if (useMeshCollider) {
                await this.loadColliderMeshGlb();
            } else {
                // Voxel path (existing behaviour)
                await this.loadColliders();

                // Notify world generator to check for voxels and remove ground plane if needed
                if (this.engine?.worldGenerator) {
                    setTimeout(() => {
                        this.engine.worldGenerator.checkAndHideGroundIfVoxelCollidersExist();
                    }, 100);
                }

                // Only load GLB collision mesh if there are no voxel colliders
                const hasVoxels = this.hasVoxelColliders() || this.checkVoxelUrlExists();
                if (!hasVoxels) {
                    await this.loadMatchingGlb();
                } else {
                    console.log('⏭️ Skipping GLB collision mesh loading - voxels exist');
                }
            }
            
            // Try to load visibility data if available
            await this.loadVisibilityData();

            // Mark as complete. (The progressive low-res splat path was never
            // implemented — `lowResSplatMesh` was only ever null — and the
            // Spark renderer it would have used is gone, so completion always
            // fires here now. Previously a `lowResUrl`-bearing asset would have
            // hung in the loading state forever.)
            this.isLoading = false;
            if (this.onLoadComplete) {
                console.log('✅ Gaussian splat fully initialized, notifying callback');
                this.onLoadComplete();
            }
        } catch (error) {
            this.isLoading = false;
            console.error('Failed to load Gaussian splat:', error);
            throw error;
        }
    }


    private showStatus(message: string): void {
        if (!this.statusOverlay) {
            this.statusOverlay = document.createElement('div');
            this.statusOverlay.style.cssText = `
                position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
                background: rgba(0,0,0,0.7); color: #fff; padding: 12px 28px;
                border-radius: 8px; font: 600 15px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
                z-index: 9999; pointer-events: none; transition: opacity 0.3s;
                display: flex; align-items: center; gap: 12px;
            `;
            const spinner = document.createElement('div');
            spinner.style.cssText = `
                width: 18px; height: 18px; border: 2.5px solid rgba(255,255,255,0.3);
                border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite;
                flex-shrink: 0;
            `;
            this.statusOverlay.appendChild(spinner);
            this.statusOverlay.appendChild(document.createElement('span'));
            document.body.appendChild(this.statusOverlay);
        }
        const span = this.statusOverlay.querySelector('span');
        if (span) span.textContent = message;
        this.statusOverlay.style.opacity = '1';
        this.statusOverlay.style.display = 'flex';
    }

    private hideStatus(): void {
        if (this.statusOverlay) {
            this.statusOverlay.style.opacity = '0';
            setTimeout(() => { if (this.statusOverlay) this.statusOverlay.style.display = 'none'; }, 400);
        }
    }

    /**
     * True when the engine renderer is ACTUALLY driven by WebGPU (not a
     * WebGPURenderer that silently fell back to its WebGL2 backend — the
     * compute-shader sort needs real WebGPU).
     */
    private isWebGpuBackend(): boolean {
        const renderer = this.engine?.getRenderer?.();
        return !!renderer && getActiveBackend(renderer) === 'webgpu';
    }

    /**
     * Load `config.url` into the WebGPU-native splat mesh. Shared by the
     * initial `load()` and the creator's points→gaussian render-mode switch.
     */
    private async loadWebGpuSplatMesh(): Promise<void> {
        if (this.webgpuSplatMesh) return;
        this.showStatus('Loading splat…');
        const loadStart = performance.now();
        try {
            const data = await loadSpz(this.config.url, (loaded, total) => {
                const pct = Math.round((loaded / total) * 100);
                this.showStatus(`Loading splat… ${pct}%`);
                // Main-screen loading bar (dropped outside the boot 'world' phase).
                reportWorldSubProgress('splat-fetch', loaded / total);
            });

            // Guard against splats too large for this device's storage-buffer
            // binding limit. Without this the GPU buffer fails to allocate and
            // every bind group referencing it cascades into "invalid buffer"
            // errors (and a non-rendering splat). Decline cleanly instead.
            const cap = maxWebGpuSplats(this.engine?.getRenderer?.());
            if (data.numSplats > cap) {
                const capM = (cap / 1e6).toFixed(1);
                console.warn(`[Splat] ${data.numSplats.toLocaleString()} splats exceeds this GPU's WebGPU limit (~${capM}M). ` +
                    `Skipping — re-bake a smaller/optimized splat (e.g. the prune+SH1 step) or use the WebGL backend.`);
                this.showStatus(`Splat too large for WebGPU (${data.numSplats.toLocaleString()} > ~${capM}M max on this GPU)`);
                installWebGpuSplatToggleButton(true); // keep the off switch reachable
                return;
            }

            this.webgpuSplatMesh = new WebGpuSplatMesh(data);
            this.scene.add(this.webgpuSplatMesh);
            this.applyTransformTo(this.webgpuSplatMesh);
            const elapsed = ((performance.now() - loadStart) / 1000).toFixed(1);
            console.log(`✅ WebGPU splat mesh loaded in ${elapsed}s (${data.numSplats.toLocaleString()} splats, ${this.config.url})`);
            // Offer the one-click "off" switch now that the heavy path is live.
            installWebGpuSplatToggleButton(true);
            this.hideStatus();
        } catch (err) {
            this.hideStatus();
            throw err;
        }
    }

    /**
     * Load the explicit collider GLB pointed to by `config.colliderUrl`. This
     * is generated server-side by `splat-transform --collision-mesh` and
     * stored on the asset. Reuses `setupGlbMesh` so transform/shadow/physics
     * handling matches the existing matching-GLB collider path. On failure we
     * fall through to the voxel path so a stale or missing URL doesn't kill
     * the load.
     *
     * splat-transform writes the GLB in PLY-canonical coordinates, which are
     * a 180° rotation around Z away from SPZ-rendered coordinates (verified
     * empirically: SPZ X[-367,474] Y[-797,327] Z[-544,1145] vs GLB scene
     * bounds X[-475,369] Y[-328,800] Z[-544,1146] — X and Y are negated, Z
     * unchanged, exactly a 180° z-rotation). We wrap the loaded scene in an
     * outer Object3D, rotate the inner scene by π around Z, and let
     * `setupGlbMesh` apply the splat instance transform to the wrapper. This
     * does NOT affect the legacy adjacent-GLB path (`loadMatchingGlb`) — those
     * GLBs were authored to align with the splat and must NOT be re-rotated.
     */
    private async loadColliderMeshGlb(): Promise<void> {
        const colliderUrl = this.config.colliderUrl;
        if (!colliderUrl) return;
        try {
            console.log('🧊 Loading collider mesh GLB:', colliderUrl);
            const gltf = await this.loader.loadAsync(colliderUrl);
            const wrapper = new THREE.Object3D();
            wrapper.name = 'GaussianSplatColliderWrapper';
            gltf.scene.rotation.set(0, 0, Math.PI);
            wrapper.add(gltf.scene);
            this.setupGlbMesh(wrapper);
            console.log('✅ Collider mesh GLB loaded and physics created');
        } catch (error) {
            console.warn('⚠️ Failed to load collider mesh GLB, falling back to voxel collider path:', error);
            // Fallback so collisions still work if the GLB is missing/broken.
            await this.loadColliders();
            if (this.engine?.worldGenerator) {
                setTimeout(() => {
                    this.engine.worldGenerator.checkAndHideGroundIfVoxelCollidersExist();
                }, 100);
            }
            const hasVoxels = this.hasVoxelColliders() || this.checkVoxelUrlExists();
            if (!hasVoxels) await this.loadMatchingGlb();
        }
    }

    /**
     * Derive the matching GLB filename for an SPZ path: strip an optional
     * `{timestamp}-` prefix (GLBs are uploaded without it) and swap the
     * extension. Returns just the basename, e.g. `car.glb`.
     */
    private spzBasenameToGlb(pathname: string): string {
        const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
        const baseFilename = filename.match(/^\d+-(.+)$/)?.[1] ?? filename;
        return baseFilename.replace(/\.spz$/i, '.glb');
    }

    private async loadMatchingGlb(): Promise<void> {
        const splatUrl = this.config.url;
        try {
            // Remote SPZ: resolve the matching GLB alongside it in the same folder.
            let isRemote = false;
            try {
                if (splatUrl.startsWith('http') || splatUrl.startsWith('//')) {
                    const urlObj = new URL(splatUrl);
                    if (urlObj.pathname.toLowerCase().endsWith('.spz')) {
                        const dir = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);
                        urlObj.pathname = dir + this.spzBasenameToGlb(urlObj.pathname);
                        const glbPath = urlObj.toString();
                        isRemote = true;
                        console.log(`Checking for matching GLB file from remote location: ${glbPath}`);
                        const gltf = await this.loader.loadAsync(glbPath);
                        console.log('✅ Matching GLB file found and loaded:', glbPath);
                        this.setupGlbMesh(gltf.scene);
                        return;
                    }
                }
            } catch (e) {
                console.warn('Error parsing splat URL:', e);
            }

            if (!isRemote) {
                // Fallback to local path in the /spz folder.
                const url = new URL(splatUrl, window.location.href);
                const glbPath = `/spz/${this.spzBasenameToGlb(url.pathname)}`;
                console.log(`Checking for matching GLB file locally: ${glbPath}`);
                const gltf = await this.loader.loadAsync(glbPath);
                console.log('✅ Matching GLB file found and loaded:', glbPath);
                this.setupGlbMesh(gltf.scene);
            }
        } catch (error) {
            console.log('No matching GLB file found (this is optional):', error);
        }
    }
    
    private setupGlbMesh(glbScene: THREE.Object3D): void {
        this.glbMesh = glbScene;
        this.glbMesh.name = 'GaussianSplatColliderMesh';

        // Apply EXACT same transformations as the splat mesh (no extra rotations)
        this.applyTransformTo(this.glbMesh);

        // Update world matrix before creating physics
        this.glbMesh.updateMatrixWorld(true);
        
        // Create visualization mesh (semi-transparent copy for collider editor)
        this.createGlbVisualization();
        
        // Make collider mesh invisible but still receive shadows
        // Use ShadowMaterial - designed specifically for invisible geometry that receives shadows
        // CRITICAL: Keep visible = true at all times for shadow receiving to work!
        this.glbMesh.visible = true; // Must ALWAYS be true for shadow receiving
        
        // Render collision mesh AFTER Gaussian splats to prevent depth occlusion
        // Higher renderOrder means it renders later (on top)
        this.glbMesh.renderOrder = 1000; // Render after splats (which typically render at 0)
        
        // Enable shadow receiving on all meshes with ShadowMaterial
        this.glbMesh.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                mesh.castShadow = false; // Don't cast shadows (collider mesh)
                mesh.receiveShadow = true; // Receive shadows from other objects
                
                // Use ShadowMaterial - renderOrder ensures it renders AFTER splats
                // Keep depthWrite: true for shadow receiving to work properly
                // renderOrder: 1000 ensures collision mesh renders after splats (which render at default 0)
                const shadowMaterial = new THREE.ShadowMaterial({
                    transparent: true,
                    opacity: 0.6, // Controls shadow darkness (0 = no shadow, 1 = black)
                    color: 0x000000 // Optional tint
                    // depthWrite defaults to true, which is needed for shadow receiving
                    // renderOrder on the mesh ensures it renders after splats
                });
                
                mesh.material = shadowMaterial;
            }
        });
        
        this.scene.add(this.glbMesh);
        console.log('GLB mesh added to scene with ShadowMaterial (invisible, receives shadows, renderOrder=1000)');
        
        // Create physics collision for the GLB mesh
        if (this.physicsWorld) {
            this.createGlbPhysics();
        }
    }
    
    private createGlbVisualization(): void {
        if (!this.glbMesh) return;

        // Wireframe visualisation: independent of triangle winding (which
        // splat-transform's `--collision-mesh` output orients however its
        // internal voxel→mesh extraction prefers — empirically the user saw
        // back-facing artefacts with a solid semi-transparent material). A
        // wireframe MeshBasicMaterial doesn't depend on scene lighting and
        // clearly shows the collider structure. Force a fresh material on
        // every sub-mesh so the viz is consistent regardless of what the
        // source GLB authoring tool emitted.
        this.glbVisualizationMesh = this.glbMesh.clone();
        this.glbVisualizationMesh.name = 'GaussianSplatColliderVisualization';

        this.glbVisualizationMesh.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            const visMaterial = new THREE.MeshBasicMaterial({
                color: 0x00ff88,
                wireframe: true,
                transparent: true,
                opacity: 0.85,
                depthTest: true,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
            mesh.material = visMaterial;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
        });

        // Render after splats so the wireframe stays visible over them.
        this.glbVisualizationMesh.renderOrder = 1001;
        this.glbVisualizationMesh.visible = false; // toggled by setColliderVisualizationVisible
        this.scene.add(this.glbVisualizationMesh);
    }

    /**
     * Reports which collider implementation this splat is actually using at
     * runtime. Used by the V-key debug cycle so it visualises the active
     * collider (mesh trimesh OR voxel grid) rather than always defaulting to
     * voxels.
     *
     * - `'mesh'`  — `colliderUrl` is set, `colliderType !== 'voxel'`, and the
     *               GLB loaded successfully (Rapier trimesh in physics world).
     *               The visualisation mesh is `glbVisualizationMesh`.
     * - `'voxel'` — voxel grid colliders are in play (legacy path or explicit
     *               `colliderType === 'voxel'` override).
     * - `'none'`  — neither has been wired up yet (still loading, or this is a
     *               splat with no collider data at all).
     */
    getActiveColliderKind(): 'mesh' | 'voxel' | 'none' {
        const meshActive = !!this.config.colliderUrl
            && this.config.colliderType !== 'voxel'
            && !!this.glbPhysicsCollider;
        if (meshActive) return 'mesh';
        if (this.hasVoxelColliders() || this.checkVoxelUrlExists()) return 'voxel';
        // Legacy adjacent-GLB collider (no explicit colliderUrl on the asset)
        // also produces a glbPhysicsCollider — treat that as 'mesh' too so the
        // V key visualises it consistently.
        if (this.glbPhysicsCollider) return 'mesh';
        return 'none';
    }

    /**
     * Show / hide the mesh-collider visualisation (semi-transparent green
     * clone of the trimesh source GLB). Called by `GaussianSplatEditor` from
     * the V-key visibility cycle. No-ops when this splat uses voxel colliders
     * — the voxel visualisation is owned by `VoxelWorld`.
     */
    setColliderVisualizationVisible(visible: boolean): void {
        if (!this.glbVisualizationMesh) return;
        if (this.glbVisualizationMesh.visible === visible) return;
        this.glbVisualizationMesh.visible = visible;
    }
    
    /**
     * Fetch this splat's per-instance .vxl file (set on the env-object as
     * `voxelUrl`) and populate this renderer's VoxelWorld with it. Owned by
     * the renderer (not the editor) so voxel colliders load correctly in
     * published builds even if no editor/debug components are present.
     */
    private async loadVoxelColliders(): Promise<boolean> {
        const voxelUrl = this.config.voxelUrl;
        if (!voxelUrl || !this.physicsWorld) return false;
        try {
            const response = await fetch(voxelUrl);
            if (!response.ok) {
                console.warn(`[GaussianSplatRenderer] voxelUrl fetch failed: ${response.status} ${voxelUrl}`);
                return false;
            }
            const buffer = await response.arrayBuffer();
            const world = this.ensureVoxelWorld();
            const metadata = await world.loadFromFile(buffer);
            if (metadata?.bounds) {
                this.voxelWorldBoundsRaw = metadata.bounds;
                world.setBounds(metadata.bounds);
            }
            world.updatePhysicsAndMeshing(true);
            // The shadow catcher's bounds calc may have returned null earlier
            // (env-system enables the catcher synchronously, but voxel bounds
            // only arrive after this async fetch). Refresh now that voxel
            // bounds are populated.
            if (this.shadowCatcherEnabled) this.refreshShadowCatcher();
            console.log(`✅ [GaussianSplatRenderer] Loaded voxel colliders for ${this.envObjectId ?? '(no envId)'} from ${voxelUrl}`);
            return true;
        } catch (err) {
            console.error('[GaussianSplatRenderer] loadVoxelColliders failed:', err);
            return false;
        }
    }

    private async loadColliders(): Promise<void> {
        // Voxel colliders: owned by THIS renderer. Loaded directly from the
        // env-object's voxelUrl so the runtime never needs the editor.
        if (this.config.voxelUrl) {
            console.log('🔧 Loading voxel colliders from URL:', this.config.voxelUrl);
            await this.loadVoxelColliders();
        }

        // Editor-only side of the load (manual box colliders JSON, floor mesh,
        // heightmap, gizmo state). Skipped entirely when no editor is wired
        // up — published builds without debug code keep working because the
        // voxel-collider path above is self-contained.
        if (this.colliderEditor) {
            console.log('🔧 Editor loadColliders for editor-only state:', this.config.url);
            await this.colliderEditor.loadColliders(this.config.url);
            console.log('✅ Editor collider state loaded');

            // Walkable map: if the splat has a saved walkable URL, restore
            // it now. The voxel grid is fully populated by this point, so
            // the visualizer's load path has the world it needs.
            // Walkable map + PVS live on the engine-level controller, which
            // resolves this splat's freshly-populated collider world through its
            // active-world provider. `this.engine` is loosely typed, so these
            // calls no-op safely when the controller isn't present.
            if (this.config.walkableUrl) {
                console.log('[PVS] Loading walkable map from URL:', this.config.walkableUrl);
                await this.engine?.pvsController?.loadWalkableMapFromUrl(this.config.walkableUrl);

                // PVS bake — only meaningful with a walkable map (the
                // cell keys reference cells from that bake). Restored
                // after the walkable map so the cell set is in place.
                if (this.config.pvsUrl) {
                    console.log('[PVS] Loading PVS data from URL:', this.config.pvsUrl);
                    await this.engine?.pvsController?.loadPvsFromUrl(this.config.pvsUrl);
                    // Full-splat auto-load gated on PVS *culling actually
                    // working*, not just PVS data being loaded. Once the
                    // chunk culling produces a visible difference (and
                    // ideally we have shader-side splat culling) we can
                    // turn this back on.
                    // this.loadFullSplatInBackground();
                }
            }
        }
    }

    /**
     * Switch between 'points' (preview cloud only) and 'gaussian' (full
     * splat loaded in the background). Idempotent — calling with the
     * current mode is a no-op. Triggered from the creator's "Render"
     * radio in the Splats panel.
     */
    setSplatRenderMode(mode: 'points' | 'gaussian'): void {
        if (this.splatRenderMode === mode) {
            this.applySplatVisibility();
            return;
        }
        this.splatRenderMode = mode;
        if (mode === 'gaussian' && !this.webgpuSplatMesh && !this.fullSplatLoadStarted) {
            this.loadFullSplatInBackground();
        }
        this.applySplatVisibility();
    }

    /**
     * Compute and apply effective visibility for the splat surfaces owned by
     * this renderer. Single source of truth: per-row eye toggle
     * (`splatVisibleFlag`) AND the chosen render mode pick exactly one surface
     * to show — the full WebGPU splat in 'gaussian' mode (once loaded), else the
     * preview point cloud. While the full splat hasn't loaded yet in 'gaussian'
     * mode, the preview stays up so voxels don't leak through the load gap.
     */
    private applySplatVisibility(): void {
        const fullReady = this.webgpuSplatMesh !== null;
        const showFull = this.splatVisibleFlag && this.splatRenderMode === 'gaussian' && fullReady;
        const showPreview = this.splatVisibleFlag && !showFull;
        if (this.webgpuSplatMesh) this.webgpuSplatMesh.visible = showFull;
        if (this.previewMesh) this.previewMesh.visible = showPreview;
    }

    private loadFullSplatInBackground(): void {
        if (this.webgpuSplatMesh || this.fullSplatLoadStarted) return;
        this.fullSplatLoadStarted = true;
        // Full splats render only on the WebGPU backend (the WebGL/Spark path
        // was removed), gated on the safety opt-in latch.
        if (!this.isWebGpuBackend()) {
            console.warn('[Splat] Gaussian splats require the WebGPU backend; ' +
                'the WebGL renderer shows the preview point cloud only.');
            return;
        }
        if (!webGpuSplatsEnabled()) {
            console.warn('[Splat] WebGPU splat renderer is OFF (safety opt-in); skipping background load. ' +
                'Use the on-screen "Enable WebGPU splats" button to turn it on.');
            installWebGpuSplatToggleButton(false);
            return;
        }
        this.loadWebGpuSplatMesh()
            .then(() => this.applySplatVisibility())
            .catch((err) => console.error('WebGPU splat background load failed:', err));
    }

    /**
     * Per-frame hook called from `GameEngine.animate()` for every splat
     * renderer. The WebGPU splat mesh honours Three's frustum culling itself,
     * so there's no per-cell PVS grid to drive here anymore — kept as a no-op
     * for the call-site contract.
     */
    updatePerFrame(_camera: THREE.Camera): void {
        // No-op: WebGPU splat mesh handles its own culling; the WebGL/Spark PVS
        // grid was removed.
    }
    
    private async loadVisibilityData(): Promise<void> {
        // Try to load visibility data file (optional, for performance optimization)
        try {
            const url = new URL(this.config.url, window.location.href);
            const filename = url.pathname.substring(url.pathname.lastIndexOf('/') + 1);
            const visibilityFilename = filename.replace(/\.spz$/i, '-visibility.json');

            const visibilityPath = isStandaloneMode
                ? `https://dev-mini-cloudsave-bucket.s3.us-east-1.amazonaws.com/worlds/v3/splats/${visibilityFilename}`
                : `/spz/${visibilityFilename}`;
            const modeLabel = isStandaloneMode ? '🌐 Standalone mode' : '🔧 Editor mode';
            console.log(`${modeLabel}: checking for visibility data at: ${visibilityPath}`);
        } catch (error) {
            console.log('ℹ️ Visibility data not available:', error);
        }
    }

    /**
     * Get list of visible cell IDs based on camera frustum (if visibility culling is enabled)
     */
    getVisibleCells(camera: THREE.Camera): number[] {
        return [];
    }

    /**
     * Check if visibility culling is enabled for this splat
     */
    hasVisibilityCulling(): boolean {
        return false;
    }
    
    private createGlbPhysics(): void {
        if (!this.glbMesh || !this.physicsWorld) return;
        
        const RAPIER = getRapier();
        
        try {
            // Update matrix world for accurate triangle positions
            this.glbMesh.updateMatrixWorld(true);
            
            const vertices: number[] = [];
            const indices: number[] = [];
            let vertexOffset = 0;
            const bounds = new THREE.Box3();
            
            // Extract triangles from all meshes in the GLB
            this.glbMesh.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    const geometry = mesh.geometry;
                    
                    if (geometry.index && geometry.attributes.position) {
                        const position = geometry.attributes.position;
                        const index = geometry.index;
                        
                        // Expand bounds with this mesh
                        mesh.updateMatrixWorld(true);
                        const meshBounds = new THREE.Box3().setFromObject(mesh);
                        bounds.union(meshBounds);
                        
                        // Add all vertices (transformed to world space)
                        const localVertexStart = vertexOffset;
                        for (let i = 0; i < position.count; i++) {
                            const v = new THREE.Vector3(
                                position.getX(i),
                                position.getY(i),
                                position.getZ(i)
                            );
                            // Apply mesh's world transform (includes all parent transforms)
                            v.applyMatrix4(mesh.matrixWorld);
                            vertices.push(v.x, v.y, v.z);
                            vertexOffset++;
                        }
                        
                        // Add indices (offset by vertex start)
                        for (let i = 0; i < index.count; i++) {
                            indices.push(index.getX(i) + localVertexStart);
                        }
                    }
                }
            });
            
            const triangleCount = indices.length / 3;
            console.log(`📊 GLB collision mesh: ${triangleCount} triangles`);
            console.log(`📊 GLB bounds: min(${bounds.min.x.toFixed(2)}, ${bounds.min.y.toFixed(2)}, ${bounds.min.z.toFixed(2)}), max(${bounds.max.x.toFixed(2)}, ${bounds.max.y.toFixed(2)}, ${bounds.max.z.toFixed(2)})`);
            
            // Create fixed rigid body at origin (vertices are already in world space)
            const bodyDesc = RAPIER.RigidBodyDesc.fixed();
            this.glbPhysicsBody = this.physicsWorld.createRigidBody(bodyDesc);
            
            // Create trimesh collider
            // FIX_INTERNAL_EDGES (144) fixes zero/bad normals at triangle edges
            const colliderDesc = RAPIER.ColliderDesc.trimesh(
                new Float32Array(vertices),
                new Uint32Array(indices),
                144
            );
            
            if (!colliderDesc) {
                console.error('Failed to create trimesh collider for GLB');
                this.physicsWorld.removeRigidBody(this.glbPhysicsBody);
                this.glbPhysicsBody = null;
                return;
            }
            
            colliderDesc.setFriction(0.8);
            colliderDesc.setRestitution(0.2);
            colliderDesc.setCollisionGroups(makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ALL));
            
            this.glbPhysicsCollider = this.physicsWorld.createCollider(colliderDesc, this.glbPhysicsBody);
            
            console.log('✅ Physics collision created for GLB mesh');
        } catch (error) {
            console.error('Failed to create physics for GLB:', error);
        }
    }

    adjustRotation(axis: 'x' | 'y' | 'z', amount: number): void {
        const activeMesh = this.webgpuSplatMesh;
        if (!activeMesh) return;

        activeMesh.rotation[axis] += amount;
        if (this.glbMesh) {
            this.glbMesh.rotation[axis] += amount;
        }

        // Log the current rotation in degrees for easier configuration
        const toDeg = (rad: number) => (rad * 180 / Math.PI).toFixed(1);
        console.log(`Splat rotation: X=${toDeg(activeMesh.rotation.x)}° Y=${toDeg(activeMesh.rotation.y)}° Z=${toDeg(activeMesh.rotation.z)}°`);
    }

    getCurrentRotation(): { x: number; y: number; z: number } {
        const activeMesh = this.webgpuSplatMesh;
        if (!activeMesh) return { x: 0, y: 0, z: 0 };

        return {
            x: activeMesh.rotation.x,
            y: activeMesh.rotation.y,
            z: activeMesh.rotation.z
        };
    }

    dispose(): void {
        if (this.statusOverlay) {
            this.statusOverlay.remove();
            this.statusOverlay = null;
        }

        if (this.shadowCatcherMesh) {
            this.scene.remove(this.shadowCatcherMesh);
            this.shadowCatcherMesh.geometry.dispose();
            (this.shadowCatcherMesh.material as THREE.Material).dispose();
            this.shadowCatcherMesh = null;
        }

        if (this.webgpuSplatMesh) {
            this.scene.remove(this.webgpuSplatMesh);
            this.webgpuSplatMesh.dispose();
            this.webgpuSplatMesh = null;
        }

        if (this.previewMesh) {
            this.scene.remove(this.previewMesh);
            this.previewMesh.geometry.dispose();
            (this.previewMesh.material as THREE.Material).dispose();
            this.previewMesh = null;
        }

        if (this.physicsWorld) {
            if (this.glbPhysicsCollider) {
                this.physicsWorld.removeCollider(this.glbPhysicsCollider);
                this.glbPhysicsCollider = null;
            }
            if (this.glbPhysicsBody) {
                this.physicsWorld.removeRigidBody(this.glbPhysicsBody);
                this.glbPhysicsBody = null;
                console.log('Physics body cleaned up for GLB');
            }
        }

        if (this.glbVisualizationMesh) {
            this.scene.remove(this.glbVisualizationMesh);
            this.disposeMeshResources(this.glbVisualizationMesh);
            this.glbVisualizationMesh = null;
        }

        if (this.glbMesh) {
            this.scene.remove(this.glbMesh);
            this.disposeMeshResources(this.glbMesh);
            this.glbMesh = null;
        }
    }

    private disposeMeshResources(root: THREE.Object3D): void {
        root.traverse((obj: THREE.Object3D) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.geometry?.dispose();
            if (mesh.material) {
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                for (const m of materials) m.dispose();
            }
        });
    }

    /** The active full-splat object (WebGPU splat mesh) or null. Editor tools
     *  use this to select/transform the splat; the old Spark `SplatMesh` is gone. */
    getSplatMesh(): THREE.Object3D | null {
        return this.webgpuSplatMesh;
    }

    setSplatVisibility(visible: boolean): void {
        this.splatVisibleFlag = visible;
        this.applySplatVisibility();
        console.log(`Splat visibility: ${visible ? 'visible' : 'hidden'} (mode=${this.splatRenderMode})`);
    }

    async loadTestSplat(url: string): Promise<void> {
        // Dev/editor test helper backed by the WebGL/Spark renderer, which has
        // been removed. Gaussian splats now render only via the WebGPU path.
        console.warn(`[Splat] loadTestSplat is no longer supported (WebGL/Spark removed). Requested: ${url}`);
    }

    toggleColliderVisibility(): void {
        console.log('🔧 toggleColliderVisibility called');
        console.log('   Current state:', this.colliderEditorEnabled);
        console.log('   ColliderEditor exists:', !!this.colliderEditor);
        console.log('   GLB mesh exists:', !!this.glbMesh);
        
        this.colliderEditorEnabled = !this.colliderEditorEnabled;
        
        // Show/hide visualization mesh (semi-transparent)
        if (this.glbVisualizationMesh) {
            this.glbVisualizationMesh.visible = this.colliderEditorEnabled;
            console.log(`   GLB visualization mesh visibility: ${this.glbVisualizationMesh.visible ? 'visible' : 'hidden'}`);
        }
        
        // NEVER set glbMesh.visible = false - it must stay true for shadow receiving!
        // The mesh is invisible via ShadowMaterial, not via visibility flag
        
        if (this.colliderEditor) {
            this.colliderEditor.setEnabled(this.colliderEditorEnabled);
            console.log(`   Collider editor: ${this.colliderEditorEnabled ? 'enabled' : 'disabled'}`);
        } else {
            console.warn('   ⚠️ ColliderEditor was not created! Check constructor parameters.');
        }
    }
    
    /**
     * Set collider visualization visibility (for Scene Info checkbox - does NOT enable editor)
     */
    setColliderVisibility(visible: boolean): void {
        // Only control visualization mesh, don't enable/disable the collider editor
        if (this.glbVisualizationMesh) {
            this.glbVisualizationMesh.visible = visible;
            console.log(`   GLB visualization mesh visibility: ${visible ? 'visible' : 'hidden'} (Scene Info control)`);
        }
    }
    
    /**
     * Get current collider visualization visibility state
     */
    getColliderVisibility(): boolean {
        return this.glbVisualizationMesh ? this.glbVisualizationMesh.visible : false;
    }
    
    getGlbMesh(): THREE.Object3D | null {
        return this.glbMesh;
    }

    getSplatUrl(): string {
        return this.config.url;
    }

    setOnLoadComplete(callback: () => void): void {
        this.onLoadComplete = callback;
    }

    getIsLoading(): boolean {
        return this.isLoading;
    }
    
    closeColliderEditor(): void {
        if (this.colliderEditorEnabled && this.colliderEditor) {
            this.colliderEditorEnabled = false;
            this.colliderEditor.setEnabled(false);
            if (this.glbVisualizationMesh) {
                this.glbVisualizationMesh.visible = false;
            }
            // NEVER set glbMesh.visible = false - it must stay true for shadow receiving!
            // The mesh is invisible via ShadowMaterial, not via visibility flag
            console.log('🔧 Collider editor closed');
        }
    }
    
    getColliderEditor(): any | null {
        return this.colliderEditor;
    }

    /**
     * Check if there are any voxel colliders loaded
     */
    hasVoxelColliders(): boolean {
        if (!this.colliderEditor || !(this.colliderEditor as any).colliders) {
            return false;
        }
        
        const colliders = (this.colliderEditor as any).colliders as Array<{ data: any }>;
        return colliders.some(collider => isVoxelColliderId(collider.data?.id || ''));
    }
    
    /**
     * Get the bounding box of the GLB collider mesh in world space
     * Returns null if no GLB mesh is loaded
     */
    getGlbBounds(): THREE.Box3 | null {
        if (!this.glbMesh) {
            return null;
        }
        
        // Ensure world matrix is up to date
        this.glbMesh.updateMatrixWorld(true);
        
        const box = new THREE.Box3();
        box.setFromObject(this.glbMesh);
        return box;
    }
    
    /**
     * Get the minimum Y coordinate of the GLB collider mesh
     * Returns null if no GLB mesh is loaded
     */
    getGlbMinY(): number | null {
        const bounds = this.getGlbBounds();
        return bounds ? bounds.min.y : null;
    }
    
    /**
     * Get the bounding box of all voxel colliders in world space
     * Returns null if no voxel colliders exist
     */
    /**
     * This splat's VoxelWorld instance. Owned by the renderer (NOT by any
     * editor / debug component), so game/template/work-folder code can rely
     * on it in published builds where the editor doesn't exist.
     *
     * Returns null until a voxel collider has actually been loaded or
     * generated for this splat.
     */
    getVoxelWorld(): VoxelWorld | null {
        return this.voxelWorld;
    }

    /**
     * Lazily create this splat's VoxelWorld. Called by the splat-collider
     * loader (and by the editor's voxelisation tool when present) to get a
     * stable, per-splat grid to fill.
     */
    ensureVoxelWorld(voxelSize?: number): VoxelWorld {
        if (this.voxelWorld) {
            if (voxelSize !== undefined && Math.abs(this.voxelWorld.getVoxelSize() - voxelSize) > 1e-6) {
                this.voxelWorld.setVoxelSize(voxelSize);
            }
            return this.voxelWorld;
        }
        if (!this.physicsWorld) {
            throw new Error('Cannot create VoxelWorld: physicsWorld not available on this renderer');
        }
        // Splat collider voxels are 3D-only; on the 2D lane (plane-locked facade) the
        // world meshes without colliders rather than driving Rapier 2D as 3D.
        this.voxelWorld = new VoxelWorld(isPlaneLockedPhysics(this.physicsWorld) ? null : this.physicsWorld, this.scene, {
            voxelSize: voxelSize ?? 0.4,
        });
        return this.voxelWorld;
    }

    /** Raw bounds of this splat's voxel collider (set by the loader/voxeliser). */
    getVoxelWorldBoundsRaw(): RawBounds | null {
        return this.voxelWorldBoundsRaw;
    }

    /**
     * Compute a tight bounding box around this splat's *dense* gaussian area in
     * **untransformed splat-local coordinates** (= the SPZ positions, before
     * the env-object transform). Filters out background-noise outliers by
     * taking only opaque gaussians and trimming the outermost percentile per
     * axis. Used as the auto-initial value for `Asset.cropBounds` (which the
     * voxeliser then uses to skip stray gaussians far from the subject).
     *
     * Returns null until the SplatMesh has decoded its data.
     *
     * @param opacityThreshold gaussians below this alpha are ignored (default 0.3 — matches the voxeliser's threshold).
     * @param percentile fraction of opaque gaussians the box must contain on each axis (default 0.95 → trim 2.5% from each side).
     */
    getDenseBounds(opacityThreshold: number = 0.3, percentile: number = 0.95):
        { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
        // The WebGL/Spark SplatMesh (which exposed forEachSplat) was removed.
        // The WebGPU splat mesh may not expose a CPU splat iterator, in which
        // case dense-bounds auto-crop is unavailable and we return null.
        const mesh = this.webgpuSplatMesh as unknown as {
            forEachSplat?: (cb: (i: number, c: THREE.Vector3, s: THREE.Vector3, q: THREE.Quaternion, opacity: number, color: THREE.Color) => void) => void;
        } | null;
        if (!mesh || typeof mesh.forEachSplat !== 'function') return null;

        // Collect opaque gaussian centres. We don't store quaternions/scales —
        // for noise-trimming the centre alone is what matters.
        const xs: number[] = [];
        const ys: number[] = [];
        const zs: number[] = [];
        mesh.forEachSplat((_i, center, _scales, _q, opacity) => {
            if (opacity < opacityThreshold) return;
            xs.push(center.x);
            ys.push(center.y);
            zs.push(center.z);
        });
        if (xs.length === 0) return null;

        // Percentile clip: sort each axis independently and pick the central band.
        // Axis-independent (vs. radial) clip is intentional — it preserves an
        // axis-aligned subject (e.g. a long car) without shrinking the long axis
        // when there's noise out to the side.
        const trim = Math.max(0, Math.min(0.5, (1 - percentile) / 2));
        const lo = Math.floor(xs.length * trim);
        const hi = Math.max(lo, xs.length - lo - 1);
        xs.sort((a, b) => a - b);
        ys.sort((a, b) => a - b);
        zs.sort((a, b) => a - b);
        const minX = xs[lo]!, minY = ys[lo]!, minZ = zs[lo]!;
        const maxX = xs[hi]!, maxY = ys[hi]!, maxZ = zs[hi]!;
        return { minX, minY, minZ, maxX, maxY, maxZ };
    }

    setVoxelWorldBoundsRaw(bounds: RawBounds | null): void {
        this.voxelWorldBoundsRaw = bounds;
        if (this.shadowCatcherEnabled) this.refreshShadowCatcher();
    }

    setCropBoundsRaw(bounds: RawBounds | null): void {
        this.cropBoundsRaw = bounds;
        this.refreshShadowCatcher();
    }

    getCropBoundsRaw(): RawBounds | null {
        return this.cropBoundsRaw;
    }

    setCleanupBoundsRaw(bounds: RawBounds | null): void {
        this.cleanupBoundsRaw = bounds;
        this.refreshShadowCatcher();
    }

    setShadowCatcherEnabled(enabled: boolean): void {
        if (this.shadowCatcherEnabled === enabled && (enabled === !!this.shadowCatcherMesh)) return;
        this.shadowCatcherEnabled = enabled;
        this.refreshShadowCatcher();
    }

    getShadowCatcherEnabled(): boolean {
        return this.shadowCatcherEnabled;
    }

    setShadowCatcherYOffset(offset: number): void {
        if (!Number.isFinite(offset)) return;
        if (this.shadowCatcherYOffset === offset) return;
        this.shadowCatcherYOffset = offset;
        // No need to rebuild the plane geometry — just nudge the existing
        // mesh's Y when the catcher is already visible. Otherwise the next
        // refresh will pick the new offset up.
        if (this.shadowCatcherMesh) {
            const bounds = this.computeShadowCatcherBounds();
            if (bounds && !bounds.isEmpty()) {
                this.shadowCatcherMesh.position.y = bounds.min.y + 0.01 + this.shadowCatcherYOffset;
            }
        }
    }

    getShadowCatcherYOffset(): number {
        return this.shadowCatcherYOffset;
    }

    /**
     * Pick the bounds the shadow catcher should cover. Prefers the union of
     * cropBounds + cleanupBounds (the walkable area + the subject extent);
     * falls back to either alone, or to the voxel-collider bounds if neither
     * is set. Returned Box3 is in world space.
     */
    private computeShadowCatcherBounds(): THREE.Box3 | null {
        const boxes: THREE.Box3[] = [];
        if (this.cropBoundsRaw) boxes.push(this.rawBoundsToWorldBox(this.cropBoundsRaw));
        if (this.cleanupBoundsRaw) boxes.push(this.rawBoundsToWorldBox(this.cleanupBoundsRaw));
        if (boxes.length === 0) {
            const fallback = this.getVoxelColliderBounds();
            if (fallback) boxes.push(fallback);
        }
        if (boxes.length === 0) return null;
        const union = new THREE.Box3();
        union.copy(boxes[0]!);
        for (let i = 1; i < boxes.length; i++) union.union(boxes[i]!);
        return union;
    }

    /**
     * (Re)build or remove the shadow-catcher plane based on current state.
     * The catcher is sized to the **union** of cropBounds + cleanupBounds in
     * world space — the area the player can walk on (cropBounds) plus the
     * subject extent (cleanupBounds). Using only the subject bounds shrinks
     * the catcher to just the car/object footprint and the player's shadow
     * lands outside it; using only cropBounds misses cases where the user
     * defined cleanup but not crop.
     *
     * Note on terrain shadows: Three.js shadow maps render every castShadow
     * object, so this plane will also pick up shadows from terrain meshes if
     * those have castShadow=true. In typical splat scenes the terrain sits at
     * or below the catcher and projects nothing visible onto it. If a game's
     * terrain genuinely casts onto the catcher, set its castShadow=false.
     */
    private refreshShadowCatcher(): void {
        if (this.shadowCatcherMesh) {
            this.scene.remove(this.shadowCatcherMesh);
            this.shadowCatcherMesh.geometry.dispose();
            (this.shadowCatcherMesh.material as THREE.Material).dispose();
            this.shadowCatcherMesh = null;
        }
        if (!this.shadowCatcherEnabled) return;

        const bounds = this.computeShadowCatcherBounds();
        if (!bounds || bounds.isEmpty()) return;

        const size = new THREE.Vector3();
        bounds.getSize(size);
        const center = new THREE.Vector3();
        bounds.getCenter(center);

        // Pad generously past the subject bounds so shadows that drift well
        // outside the splat extent (long sun angles, tall casters, the
        // player walking near the edge) still land on the catcher.
        const padFactor = 2.0;
        const planeSizeX = Math.max(2, size.x * padFactor);
        const planeSizeZ = Math.max(2, size.z * padFactor);

        const geom = new THREE.PlaneGeometry(planeSizeX, planeSizeZ);
        const mat = new THREE.ShadowMaterial({ opacity: 0.5 });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = 'GaussianSplatShadowCatcher';
        mesh.rotation.x = -Math.PI / 2; // horizontal
        // Sit fractionally above the subject's bottom Y to avoid Z-fighting
        // with any flat collider voxels at the same elevation, plus the
        // user-controlled Y offset so they can nudge the catcher onto the
        // visual floor when bounds.min.y doesn't align.
        mesh.position.set(center.x, bounds.min.y + 0.01 + this.shadowCatcherYOffset, center.z);
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        mesh.renderOrder = 10;
        this.scene.add(mesh);
        this.shadowCatcherMesh = mesh;
        const planeY = bounds.min.y + 0.01 + this.shadowCatcherYOffset;
        console.log(
            `[ShadowCatcher] enabled: center=(${center.x.toFixed(2)}, ${planeY.toFixed(2)}, ${center.z.toFixed(2)}), ` +
            `size=${planeSizeX.toFixed(2)} × ${planeSizeZ.toFixed(2)}, yOffset=${this.shadowCatcherYOffset.toFixed(2)}`,
        );
    }

    getCleanupBoundsRaw(): RawBounds | null {
        return this.cleanupBoundsRaw;
    }

    /**
     * World-space AABB of the splat's *subject* — what counts as part of the
     * splat. Prefers cleanupBounds (user-defined outer extent), falls back to
     * cropBounds, then to the voxel AABB. This is what runtime systems should
     * use when they want "where is the car/scene", as opposed to
     * `getVoxelColliderBounds` which reports the collider region.
     */
    getSplatSubjectBounds(): THREE.Box3 | null {
        if (this.cleanupBoundsRaw) return this.rawBoundsToWorldBox(this.cleanupBoundsRaw);
        return this.getVoxelColliderBounds();
    }

    /**
     * Build a world-space AABB from a raw (SPZ-local) box by transforming the
     * 8 corners through this renderer's position/rotation/scale and re-fitting
     * an AABB around the result. Returns null for an invalid input.
     */
    private rawBoundsToWorldBox(b: RawBounds): THREE.Box3 {
        const corners: THREE.Vector3[] = [];
        for (const x of [b.minX, b.maxX]) {
            for (const y of [b.minY, b.maxY]) {
                for (const z of [b.minZ, b.maxZ]) {
                    const v = new THREE.Vector3(x, y, z);
                    v.applyEuler(this.rotation);
                    v.multiply(this.scale);
                    v.add(this.position);
                    corners.push(v);
                }
            }
        }
        const out = new THREE.Box3();
        out.setFromPoints(corners);
        return out;
    }

    getVoxelColliderBounds(): THREE.Box3 | null {
        // cropBounds is the user's explicit answer to "where is the splat
        // that matters" — prefer it over the raw voxel AABB which may be
        // huge if voxelization ran before the crop was set. cropBounds is
        // stored in splat-local coords, so we transform to world space.
        if (this.cropBoundsRaw) {
            return this.rawBoundsToWorldBox(this.cropBoundsRaw);
        }
        if (this.voxelWorld && this.voxelWorld.getChunkCount() > 0 && this.voxelWorldBoundsRaw) {
            // voxelWorldBoundsRaw is already in world coords (the "Raw" suffix
            // refers to the plain-object form, not the coordinate frame).
            const b = this.voxelWorldBoundsRaw;
            return new THREE.Box3(
                new THREE.Vector3(b.minX, b.minY, b.minZ),
                new THREE.Vector3(b.maxX, b.maxY, b.maxZ),
            );
        }
        if (!this.colliderEditor) {
            return null;
        }
        
        // Fallback to old collider system (legacy support)
        if (!(this.colliderEditor as any).colliders) {
            return null;
        }
        
        const colliders = (this.colliderEditor as any).colliders as Array<{ data: any; mesh: THREE.Mesh }>;
        const voxelColliders = colliders.filter(collider => isVoxelColliderId(collider.data?.id || ''));
        
        if (voxelColliders.length === 0) {
            return null;
        }
        
        // Calculate combined bounding box of all voxel colliders
        const combinedBounds = new THREE.Box3();
        let firstVoxel = true;
        
        for (const collider of voxelColliders) {
            collider.mesh.updateMatrixWorld(true);
            
            // Get voxel world position
            const voxelWorldPos = new THREE.Vector3();
            collider.mesh.getWorldPosition(voxelWorldPos);
            
            // Calculate voxel AABB in world space (accounting for mesh scale)
            const voxelScale = collider.mesh.scale;
            const halfSize = new THREE.Vector3(
                (collider.data.scale.x * voxelScale.x) / 2,
                (collider.data.scale.y * voxelScale.y) / 2,
                (collider.data.scale.z * voxelScale.z) / 2
            );
            
            const voxelBox = new THREE.Box3(
                new THREE.Vector3().subVectors(voxelWorldPos, halfSize),
                new THREE.Vector3().addVectors(voxelWorldPos, halfSize)
            );
            
            if (firstVoxel) {
                combinedBounds.copy(voxelBox);
                firstVoxel = false;
            } else {
                combinedBounds.union(voxelBox);
            }
        }
        
        return combinedBounds;
    }
    
    /**
     * Get the minimum Y coordinate of voxel colliders
     * Returns null if no voxel colliders exist
     */
    getVoxelColliderMinY(): number | null {
        const bounds = this.getVoxelColliderBounds();
        return bounds ? bounds.min.y : null;
    }
    
    /**
     * Find a valid spawn position inside or on the GLB collider mesh
     * Returns the spawn position or null if no GLB mesh is available
     */
    findSpawnPositionInColliderMesh(preferredX?: number, preferredZ?: number): THREE.Vector3 | null {
        if (!this.glbMesh) {
            return null;
        }
        
        const bounds = this.getGlbBounds();
        if (!bounds) {
            return null;
        }
        
        // Use preferred position or center of bounds
        const x = preferredX !== undefined ? preferredX : (bounds.min.x + bounds.max.x) / 2;
        const z = preferredZ !== undefined ? preferredZ : (bounds.min.z + bounds.max.z) / 2;
        
        // Spawn at the top of the collider mesh (or slightly above)
        const y = bounds.max.y + 0.5; // 0.5m above the top of the mesh
        
        return new THREE.Vector3(x, y, z);
    }
    
    private checkVoxelUrlExists(): boolean {
        // voxelUrl lives on this renderer's env-object — that's the only
        // place splat voxel colliders are stored. `worldProfileData.voxelUrl`
        // is the voxel-genre terrain url, not a splat-collider field.
        return !!this.config.voxelUrl;
    }
}
