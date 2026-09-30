import * as THREE from 'three';

export type PointValidator = (point: { x: number; y: number; z: number }) => boolean;

/**
 * MSAA sample count for the off-screen export render target. Anti-aliasing the
 * capture is important for splat training: aliased edges shift per camera angle,
 * so multi-view training of jagged edges resolves into permanent softness. 4×
 * MSAA removes geometry-edge aliasing on both backends (WebGL2 + WebGPU resolve
 * the multisampled target on readback). Raise to 8 for sharper edges at a cost.
 */
const EXPORT_MSAA_SAMPLES = 4;

/**
 * Capture-time brightening. Game scenes export too dark for splat training:
 * heavy directional shadows + low ambient leave large surfaces near-black, so
 * the trainer has no detail to reconstruct there. A hemisphere fill lifts
 * shadowed/ambient-only areas (sky tint from above, ground bounce from below)
 * and a modest exposure bump evens the overall level — yielding brighter,
 * detail-rich, view-consistent training images. Tune if exports look flat
 * (lower fill) or still dark (raise fill / exposure). Restored after capture.
 */
const EXPORT_FILL_HEMI_SKY = 0xffffff;
const EXPORT_FILL_HEMI_GROUND = 0x9a8c7a; // warm ground bounce
const EXPORT_FILL_HEMI_INTENSITY = 0.5; // gentle — lifts the deepest shadows only; scene already has its own hemisphere + IBL
const EXPORT_EXPOSURE_BOOST = 1.0; // match the in-game exposure (sRGB target already matches the canvas)

/**
 * One pre-computed camera viewpoint, in world coordinates.
 * If provided via externalViewpoints, the exporter skips its own viewpoint
 * generation and uses these directly.
 */
export interface ExternalViewpoint {
    /** Camera world-space position. */
    position: [number, number, number];
    /** World-space target the camera looks at. */
    target: [number, number, number];
    /** Optional output frame name (defaults to frame_NNNNN). */
    name?: string;
}

export interface GaussianSplatExportOptions {
    numViews: number;
    width: number;
    height: number;
    /** Known world dimensions from world.json (meters). */
    worldSizeX?: number;
    worldSizeZ?: number;
    /** Player character height for eye-level camera placement. Default: 1.75 */
    characterHeight?: number;
    /**
     * Optional function that returns true if a world-space point is inside the playable area.
     * Templates can provide this to exclude unreachable zones (walls, out-of-bounds, etc.).
     * When not provided, a simple AABB bounds check is used.
     */
    isPointInPlayableArea?: PointValidator;
    /**
     * Optional pre-computed viewpoints. When provided, the exporter uses these
     * instead of running its built-in `generateViewpoints` strategy. Useful for
     * feeding curated camera sets (e.g. from offline planning).
     */
    externalViewpoints?: ExternalViewpoint[];
    /** Called after each frame is rendered with the PNG data and frame index. */
    onFrame?: (frameIndex: number, fileName: string, pngBase64: string) => void;
    onProgress?: (current: number, total: number) => void;
    /** Called when all frames are done. Receives the complete transforms.json string. */
    onComplete?: (transformsJson: string) => void;
    onError?: (error: Error) => void;
}

interface NerfstudioTransforms {
    camera_angle_x: number;
    fl_x: number;
    fl_y: number;
    cx: number;
    cy: number;
    w: number;
    h: number;
    aabb_scale: number;
    ply_file_path: string;
    frames: Array<{
        file_path: string;
        transform_matrix: number[][];
    }>;
    aitopia_denorm_scale?: number;
    aitopia_center_y?: number;
}

interface CameraViewpoint {
    position: THREE.Vector3;
    target: THREE.Vector3;
    /** Optional explicit frame name; otherwise frame_NNNNN is used. */
    name?: string;
}

/**
 * Extract a camera-to-world (c2w) matrix in Nerfstudio / OpenGL convention.
 *
 * Both Three.js and Nerfstudio use the same OpenGL convention:
 *   +X right, +Y up, camera looks along -Z.
 *
 * Three.js stores matrices column-major; Nerfstudio expects row-major.
 * A simple transpose converts between the two.
 */
function extractNerfstudioC2W(camera: THREE.PerspectiveCamera): number[][] {
    const m = camera.matrixWorld.elements;
    return [
        [m[0], m[4], m[8],  m[12]],
        [m[1], m[5], m[9],  m[13]],
        [m[2], m[6], m[10], m[14]],
        [m[3], m[7], m[11], m[15]],
    ];
}

const OCCLUSION_DIRECTIONS = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];
const MIN_CLEARANCE = 0.3;

const DYNAMIC_HIDE_EXACT = new Set([
    'Skybox', 'PlayerGroup', 'HeadlessPlayer', 'NpcController',
    'AttackParticles', 'AttackTrailMesh', 'SlidingParticles', 'VoxelRevealEffect',
]);

const DYNAMIC_HIDE_PREFIXES = [
    'BlockCharacter', 'AnimalController_', 'SnakeController_',
    'Projectile_', 'ProjectileTrail_', 'SpawnPointMarker_', '__highlight',
];

const DYNAMIC_HIDE_SUFFIXES = ['_BlockCharacter'];

/**
 * Returns true if an object (or any ancestor) is a dynamic / non-static scene
 * object that must be hidden during Gaussian Splat export.
 * Checks the object itself AND its parent chain so that children of hidden
 * groups (e.g. meshes inside an AnimalController) are also excluded.
 */
function isDynamicExportObject(obj: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
        const n = cur.name;
        if (DYNAMIC_HIDE_EXACT.has(n)) return true;
        if (DYNAMIC_HIDE_PREFIXES.some(p => n.startsWith(p))) return true;
        if (DYNAMIC_HIDE_SUFFIXES.some(s => n.endsWith(s))) return true;
        if ((cur as THREE.Points).isPoints) return true;
        if ((cur as THREE.Sprite).isSprite) return true;
        const t = cur.type || cur.constructor.name;
        if (t === 'TransformControlsPlane' || t === 'TransformControlsGizmo' ||
            t === 'GridHelper' || t === 'AxesHelper' ||
            (cur as any).isTransformControls || (cur as any).isTransformControlsRoot) return true;
        if (cur.userData?.isSpawnPointMarker || cur.userData?.isDebug) return true;
        // Dynamic objects that move at runtime (vehicles, dynamic props) must
        // not be baked into the static splat — they'd leave ghosts when they
        // move. `isVehicle` is set by RapierVehicle on its chassis; dynamic
        // VoxelObjects and any other system opt in via `excludeFromSplatExport`.
        if (cur.userData?.isVehicle || cur.userData?.excludeFromSplatExport) return true;
        if (n === '__transformControlsPivot__' || n === 'DecalSystem') return true;
        cur = cur.parent;
    }
    return false;
}

/**
 * Exports the current Three.js scene as rendered images + camera poses
 * in Nerfstudio transforms.json format for Gaussian Splatting training.
 *
 * Camera placement uses a grid+jitter strategy with multi-height rings
 * for dense, overlapping coverage suitable for 3DGS training.
 *
 * During export, the skybox and fog are temporarily disabled and the
 * background is made transparent (clear alpha 0) so the sky reads as empty
 * for the alpha-aware trainer; tone mapping/exposure are kept to match in-game
 * lighting. Dynamic objects (player, NPCs, animals, vehicles, dynamic props,
 * VFX) are hidden each frame so only static world geometry is captured.
 *
 * Renders one image per frame to avoid stalling the browser.
 */
export class GaussianSplatExporter {
    private _isActive = false;
    private _pendingReadback = false;
    private currentView = 0;
    private totalViews = 0;
    private transforms: NerfstudioTransforms | null = null;
    private viewpoints: CameraViewpoint[] = [];
    private exportCamera: THREE.PerspectiveCamera | null = null;
    private renderTarget: THREE.WebGLRenderTarget | null = null;
    private offscreenCanvas: HTMLCanvasElement | null = null;
    private offscreenCtx: CanvasRenderingContext2D | null = null;
    private exportWidth = 0;
    private exportHeight = 0;
    private exportScene: THREE.Scene | null = null;
    private exportRenderer: THREE.WebGLRenderer | null = null;
    private occlusionRaycaster: THREE.Raycaster | null = null;
    private occlusionMeshes: THREE.Object3D[] = [];

    // Saved scene state to restore after export
    private savedBackground: THREE.Color | THREE.Texture | THREE.CubeTexture | null = null;
    private savedFog: THREE.Fog | THREE.FogExp2 | null = null;
    private savedToneMapping: THREE.ToneMapping = THREE.NoToneMapping;
    private savedToneMappingExposure = 1.0;
    private savedClearColor: THREE.Color = new THREE.Color(0x000000);
    private savedClearAlpha = 1.0;
    private hiddenObjects: THREE.Object3D[] = [];
    private fluidMeshesOriginalSide: Map<THREE.Mesh, THREE.Side> = new Map();

    // Shadow light reference + saved original direction
    private directionalLight: THREE.DirectionalLight | null = null;
    private exportFillLight: THREE.HemisphereLight | null = null;
    private savedLightPosition: THREE.Vector3 | null = null;
    private savedLightTargetPosition: THREE.Vector3 | null = null;

    private onFrame: ((frameIndex: number, fileName: string, pngBase64: string) => void) | null = null;
    private onProgress: ((current: number, total: number) => void) | null = null;
    private onComplete: ((transformsJson: string) => void) | null = null;
    private onError: ((error: Error) => void) | null = null;

    isActive(): boolean {
        return this._isActive;
    }

    getProgress(): { current: number; total: number } {
        return { current: this.currentView, total: this.totalViews };
    }

    startExport(
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera,
        renderer: THREE.WebGLRenderer,
        options: GaussianSplatExportOptions
    ): void {
        if (this._isActive) {
            console.warn('[SplatExport] Export already in progress');
            return;
        }

        const {
            numViews, width, height,
            worldSizeX, worldSizeZ,
            characterHeight = 1.75,
            isPointInPlayableArea,
            externalViewpoints,
            onFrame, onProgress, onComplete, onError
        } = options;

        this.currentView = 0;
        this.onFrame = onFrame ?? null;
        this.onProgress = onProgress ?? null;
        this.onComplete = onComplete ?? null;
        this.onError = onError ?? null;
        this.exportWidth = width;
        this.exportHeight = height;

        const effectiveWorldSizeX = worldSizeX ?? 64;
        const effectiveWorldSizeZ = worldSizeZ ?? 128;
        const halfX = effectiveWorldSizeX / 2;
        const halfZ = effectiveWorldSizeZ / 2;
        const eyeHeight = characterHeight * 0.9;

        const validator: PointValidator = isPointInPlayableArea ?? ((p) =>
            Math.abs(p.x) <= halfX && Math.abs(p.z) <= halfZ
        );

        console.log(`[SplatExport] World size: received X=${worldSizeX}, Z=${worldSizeZ} → effective ${effectiveWorldSizeX}x${effectiveWorldSizeZ}m (half: ±${halfX}, ±${halfZ}), eye height=${eyeHeight.toFixed(2)}m, custom validator=${!!isPointInPlayableArea}`);

        if (externalViewpoints && externalViewpoints.length > 0) {
            this.viewpoints = externalViewpoints.map(v => ({
                position: new THREE.Vector3(v.position[0], v.position[1], v.position[2]),
                target: new THREE.Vector3(v.target[0], v.target[1], v.target[2]),
                name: v.name,
            }));
            console.log(`[SplatExport] Using ${this.viewpoints.length} external viewpoints (skipping built-in generator)`);
        } else {
            this.viewpoints = this.generateViewpoints(numViews, halfX, halfZ, eyeHeight, validator);
        }
        this.totalViews = this.viewpoints.length;

        const aabbScale = Math.max(halfX * 2, halfZ * 2);

        // Replicate nerfstudio's auto_orient_and_center_poses normalization:
        // 1. Center = mean camera position
        // 2. scale_factor = 1 / max(abs(centered positions))
        // Store the inverse (denorm_scale) so we can reconstruct world coords from SPZ coords.
        const centerPos = new THREE.Vector3();
        for (const vp of this.viewpoints) centerPos.add(vp.position);
        centerPos.divideScalar(this.viewpoints.length);
        let maxAbsCoord = 0;
        for (const vp of this.viewpoints) {
            maxAbsCoord = Math.max(maxAbsCoord,
                Math.abs(vp.position.x - centerPos.x),
                Math.abs(vp.position.y - centerPos.y),
                Math.abs(vp.position.z - centerPos.z));
        }
        const denormScale = maxAbsCoord > 0 ? maxAbsCoord : 1;
        console.log(`[SplatExport] Nerfstudio normalization: center=(${centerPos.x.toFixed(2)}, ${centerPos.y.toFixed(2)}, ${centerPos.z.toFixed(2)}), maxAbs=${maxAbsCoord.toFixed(2)}, denormScale=${denormScale.toFixed(2)}`);

        const vFovRad = (camera.fov * Math.PI) / 180;
        const aspect = width / height;
        const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
        const fy = (height / 2) / Math.tan(vFovRad / 2);
        const fx = fy;

        this.transforms = {
            camera_angle_x: hFovRad,
            fl_x: fx,
            fl_y: fy,
            cx: width / 2,
            cy: height / 2,
            w: width,
            h: height,
            aabb_scale: aabbScale,
            ply_file_path: 'input.ply',
            frames: [],
            aitopia_denorm_scale: denormScale,
            aitopia_center_y: centerPos.y,
        };

        this.exportCamera = camera.clone();
        this.exportCamera.aspect = aspect;
        this.exportCamera.near = 0.1;
        this.exportCamera.far = Math.max(halfX, halfZ) * 4;
        this.exportCamera.updateProjectionMatrix();

        this.renderTarget = new THREE.WebGLRenderTarget(width, height, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            samples: EXPORT_MSAA_SAMPLES,
        });
        // CRITICAL: render targets default to a linear color space, so the
        // renderer skips tone-mapping + sRGB encoding when drawing into them —
        // the read-back pixels come out ~3× too dark vs the on-screen canvas.
        // Tagging the target sRGB makes the renderer apply the same output
        // pipeline as the canvas, so exported frames match the in-game look.
        // (Verified live: canvas [78,145,42] vs default-target [20,60,7] vs
        // sRGB-target [78,133,47].)
        this.renderTarget.texture.colorSpace = THREE.SRGBColorSpace;

        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCanvas.width = width;
        this.offscreenCanvas.height = height;
        this.offscreenCtx = this.offscreenCanvas.getContext('2d');

        // Save and override scene/renderer state for clean export
        this.savedBackground = scene.background as THREE.Color | THREE.Texture | THREE.CubeTexture | null;
        this.savedFog = scene.fog as THREE.Fog | THREE.FogExp2 | null;
        this.savedToneMapping = renderer.toneMapping;
        this.savedToneMappingExposure = renderer.toneMappingExposure;
        renderer.getClearColor(this.savedClearColor);
        this.savedClearAlpha = renderer.getClearAlpha();

        // Transparent background (not solid black): the sky should read as
        // empty so the trainer (Brush, alpha-aware) doesn't fill it with dark
        // gaussians — which previously produced a black sky and a floating dark
        // blob over the scene centre. Skybox mesh is hidden via EXCLUDED names;
        // with background=null + clearAlpha=0 the readback has alpha=0 sky.
        scene.background = null;
        scene.fog = null;

        // Brighten the capture (see EXPORT_FILL_* docs): hemisphere fill lifts
        // shadowed areas + a modest exposure bump evens the level, so surfaces
        // aren't lost to darkness in the training images.
        this.exportFillLight = new THREE.HemisphereLight(
            EXPORT_FILL_HEMI_SKY, EXPORT_FILL_HEMI_GROUND, EXPORT_FILL_HEMI_INTENSITY);
        this.exportFillLight.name = 'SplatExportFillLight';
        scene.add(this.exportFillLight);
        renderer.toneMappingExposure = this.savedToneMappingExposure * EXPORT_EXPOSURE_BOOST;

        // Find shadow-casting directional light and save its position for per-frame repositioning.
        // Keep the original shadow camera frustum size (calibrated for good shadow quality)
        // — we only reposition the light per-frame to follow the export camera's view.
        const foundLightRef: { light: THREE.DirectionalLight | null } = { light: null };
        scene.traverse((obj) => {
            if (!foundLightRef.light && (obj as THREE.DirectionalLight).isDirectionalLight && (obj as THREE.DirectionalLight).castShadow) {
                foundLightRef.light = obj as THREE.DirectionalLight;
            }
        });
        this.directionalLight = foundLightRef.light;
        if (this.directionalLight) {
            this.savedLightPosition = this.directionalLight.position.clone();
            this.savedLightTargetPosition = this.directionalLight.target.position.clone();
            const shadowDist = (this.directionalLight.shadow.camera as THREE.OrthographicCamera).right;
            console.log(`[SplatExport] Shadow light found, frustum ±${shadowDist.toFixed(0)}m (unchanged), will reposition per-frame`);
        }

        // Hide dynamic objects/effects and editor helpers for the duration of export.
        // Static geometry visibility is handled TEMPORARILY per-frame in processFrame().
        this.hiddenObjects = [];
        this.fluidMeshesOriginalSide.clear();

        // Make fluid meshes double-sided so water surfaces are visible from both sides
        scene.traverse((obj) => {
            if (obj.name.startsWith('FluidChunk_') && (obj as THREE.Mesh).isMesh) {
                const mesh = obj as THREE.Mesh;
                const mat = mesh.material as THREE.Material;
                if (!this.fluidMeshesOriginalSide.has(mesh)) {
                    this.fluidMeshesOriginalSide.set(mesh, mat.side);
                    mat.side = THREE.DoubleSide;
                }
            }
        });

        scene.traverse((obj) => {
            if (!obj.visible) return;
            if (isDynamicExportObject(obj)) {
                obj.visible = false;
                this.hiddenObjects.push(obj);
            }
        });

        this.exportScene = scene;
        this.exportRenderer = renderer;

        // Collect static meshes for occlusion testing (after skybox hidden)
        this.occlusionRaycaster = new THREE.Raycaster();
        this.occlusionRaycaster.near = 0;
        this.occlusionRaycaster.far = MIN_CLEARANCE;
        this.occlusionMeshes = [];
        scene.traverse((obj) => {
            if ((obj as THREE.Mesh).isMesh && obj.visible) {
                this.occlusionMeshes.push(obj);
            }
        });

        this._isActive = true;
        const hiddenNames = this.hiddenObjects.map(o => o.name || o.constructor.name).slice(0, 30);
        console.log(`[SplatExport] Starting export: ${this.totalViews} views at ${width}x${height}`);
        console.log(`[SplatExport] Hidden ${this.hiddenObjects.length} dynamic objects: ${hiddenNames.join(', ')}${this.hiddenObjects.length > 30 ? '...' : ''}`);
        console.log(`[SplatExport] Fluid DoubleSide=${this.fluidMeshesOriginalSide.size}, shadow light=${!!this.directionalLight}`);
    }

    /**
     * Process one export frame. Call from the engine's animation loop.
     * Returns true if a frame was processed.
     */
    processFrame(scene: THREE.Scene, renderer: THREE.WebGLRenderer): boolean {
        if (!this._isActive || !this.exportCamera || !this.renderTarget ||
            !this.offscreenCanvas || !this.offscreenCtx || !this.transforms) {
            return false;
        }

        if (this.currentView >= this.viewpoints.length) {
            return false;
        }

        // Async pixel-read in flight; skip this frame to avoid clobbering state.
        if (this._pendingReadback) return false;

        try {
            const viewpoint = this.viewpoints[this.currentView]!;
            this.exportCamera.position.copy(viewpoint.position);
            this.exportCamera.lookAt(viewpoint.target);
            this.exportCamera.updateMatrixWorld(true);

            // Temporarily force-show static geometry hidden by distance/frustum culling
            // while keeping dynamic objects (NPCs, animals, player, VFX) hidden.
            // Also hide any dynamic objects that were spawned AFTER startExport ran.
            const tempShown: THREE.Object3D[] = [];
            const tempHidden: THREE.Object3D[] = [];
            scene.traverse((obj) => {
                if (isDynamicExportObject(obj)) {
                    if (obj.visible) {
                        obj.visible = false;
                        tempHidden.push(obj);
                    }
                    return;
                }
                if (!obj.visible) {
                    obj.visible = true;
                    tempShown.push(obj);
                }
                // Ensure new FluidChunk meshes (rebuilt during export) are DoubleSide
                if (obj.name.startsWith('FluidChunk_') && (obj as THREE.Mesh).isMesh) {
                    const mat = (obj as THREE.Mesh).material as THREE.Material;
                    if (mat.side !== THREE.DoubleSide) {
                        if (!this.fluidMeshesOriginalSide.has(obj as THREE.Mesh)) {
                            this.fluidMeshesOriginalSide.set(obj as THREE.Mesh, mat.side);
                        }
                        mat.side = THREE.DoubleSide;
                    }
                }
            });

            // Reposition shadow light to center on the export camera's view area.
            // Keep the original frustum size for proper shadow quality/bias calibration.
            let prevLightPos: THREE.Vector3 | undefined;
            let prevLightTargetPos: THREE.Vector3 | undefined;
            if (this.directionalLight && this.savedLightPosition && this.savedLightTargetPosition) {
                prevLightPos = this.directionalLight.position.clone();
                prevLightTargetPos = this.directionalLight.target.position.clone();
                const lightDir = new THREE.Vector3()
                    .subVectors(this.savedLightPosition, this.savedLightTargetPosition)
                    .normalize();
                if (lightDir.lengthSq() < 0.001) lightDir.set(1, 2, 1).normalize();
                const shadowDist = (this.directionalLight.shadow.camera as THREE.OrthographicCamera).right;
                this.directionalLight.target.position.copy(viewpoint.target);
                this.directionalLight.position.copy(viewpoint.target).addScaledVector(lightDir, shadowDist);
                this.directionalLight.target.updateMatrixWorld(true);
                this.directionalLight.updateMatrixWorld(true);
            }

            renderer.setRenderTarget(this.renderTarget);
            renderer.setClearColor(0x000000, 0.0); // transparent sky → alpha 0
            renderer.clear();
            renderer.render(scene, this.exportCamera);

            // Restore visibility and light position immediately
            for (const obj of tempShown) obj.visible = false;
            for (const obj of tempHidden) obj.visible = true;
            if (this.directionalLight && prevLightPos && prevLightTargetPos) {
                this.directionalLight.position.copy(prevLightPos);
                this.directionalLight.target.position.copy(prevLightTargetPos);
                this.directionalLight.target.updateMatrixWorld(true);
                this.directionalLight.updateMatrixWorld(true);
            }

            // Async readback — works on both THREE.WebGLRenderer and WebGPURenderer
            // (the latter has no sync read equivalent). Frame advance + finalize
            // happens in the .then so subsequent processFrame calls return false
            // via the _pendingReadback guard until the buffer arrives.
            this._pendingReadback = true;
            const renderTargetForRead = this.renderTarget;
            const viewIndexAtKickoff = this.currentView;
            const pixelBuffer = new Uint8Array(this.exportWidth * this.exportHeight * 4);
            renderer.readRenderTargetPixelsAsync(
                renderTargetForRead, 0, 0,
                this.exportWidth, this.exportHeight,
                pixelBuffer,
            ).then((pixelBuffer) => {
                this._pendingReadback = false;
                renderer.setRenderTarget(null);
                if (!this._isActive) return; // canceled mid-flight
                try {
                    this.handlePixelBuffer(pixelBuffer as Uint8Array, viewpoint, viewIndexAtKickoff, scene, renderer);
                } catch (err) {
                    this._isActive = false;
                    this.onError?.(err instanceof Error ? err : new Error(String(err)));
                }
            }).catch((err) => {
                this._pendingReadback = false;
                renderer.setRenderTarget(null);
                this.restoreSceneState(scene, renderer);
                this._isActive = false;
                this.onError?.(err instanceof Error ? err : new Error(String(err)));
            });

            return true;
        } catch (error) {
            renderer.setRenderTarget(null);
            this.restoreSceneState(scene, renderer);
            this._isActive = false;
            this.onError?.(error instanceof Error ? error : new Error(String(error)));
            return false;
        }
    }

    /**
     * Encode the read-back pixel buffer to PNG, stream it to the caller, and
     * advance the export cursor. Called from the async readback completion.
     */
    private handlePixelBuffer(
        pixelBuffer: Uint8Array,
        viewpoint: CameraViewpoint,
        viewIndex: number,
        scene: THREE.Scene,
        renderer: THREE.WebGLRenderer,
    ): void {
        if (!this.offscreenCanvas || !this.offscreenCtx || !this.transforms || !this.exportCamera) return;

        // WebGL reads bottom-to-top; flip Y for standard image orientation
        const imageData = new ImageData(this.exportWidth, this.exportHeight);
        for (let row = 0; row < this.exportHeight; row++) {
            const srcOffset = (this.exportHeight - row - 1) * this.exportWidth * 4;
            const dstOffset = row * this.exportWidth * 4;
            imageData.data.set(
                pixelBuffer.subarray(srcOffset, srcOffset + this.exportWidth * 4),
                dstOffset
            );
        }
        this.offscreenCtx.putImageData(imageData, 0, 0);

        const dataURL = this.offscreenCanvas.toDataURL('image/png');
        const pngBase64 = dataURL.split(',')[1] ?? '';
        const baseName = viewpoint.name ?? `frame_${viewIndex.toString().padStart(4, '0')}`;
        const fileName = baseName.endsWith('.png') ? baseName : `${baseName}.png`;
        const filePath = `./images/${fileName}`;

        this.onFrame?.(viewIndex, fileName, pngBase64);

        this.transforms.frames.push({
            file_path: filePath,
            transform_matrix: extractNerfstudioC2W(this.exportCamera),
        });

        this.currentView++;
        this.onProgress?.(this.currentView, this.totalViews);

        if (this.currentView >= this.totalViews) {
            this.finalizeExport(scene, renderer);
        }
    }

    /**
     * Returns true if the point has sufficient clearance from scene geometry.
     * Casts 6 axis-aligned rays and rejects if any hit is closer than MIN_CLEARANCE.
     */
    private hasGeometryClearance(point: THREE.Vector3): boolean {
        if (!this.occlusionRaycaster || this.occlusionMeshes.length === 0) return true;
        for (const dir of OCCLUSION_DIRECTIONS) {
            this.occlusionRaycaster.set(point, dir);
            const hits = this.occlusionRaycaster.intersectObjects(this.occlusionMeshes, false);
            if (hits.length > 0) return false;
        }
        return true;
    }

    cancel(): void {
        if (this._isActive) {
            console.log('[SplatExport] Export cancelled');
            this._isActive = false;
            if (this.exportScene && this.exportRenderer) {
                this.restoreSceneState(this.exportScene, this.exportRenderer);
            }
            this.cleanup();
        }
    }

    /**
     * Generates camera viewpoints optimized for Gaussian Splatting training.
     *
     * Grid spacing is derived from world dimensions (target ~4m between positions)
     * to guarantee sufficient overlap regardless of numViews. The numViews parameter
     * acts as a minimum — if the world demands more for adequate density, more are generated.
     *
     * Strategy:
     *  1. Street grid (primary): dense grid at eye height, 4 yaw directions per cell (~4m spacing)
     *  2. Elevated grid: sparser grid at rooftop height (~8m spacing)
     *  3. Orbit rings: circular paths at multiple heights
     *  4. Overview: high vantage points looking down
     */
    private generateViewpoints(
        numViews: number,
        halfX: number, halfZ: number,
        eyeHeight: number,
        isPointValid: PointValidator
    ): CameraViewpoint[] {
        const viewpoints: CameraViewpoint[] = [];
        const margin = 2;
        const usableHalfX = halfX - margin;
        const usableHalfZ = halfZ - margin;
        const usableW = usableHalfX * 2;
        const usableH = usableHalfZ * 2;
        const LOOK_DIST = 8;

        let rejected = 0;

        // --- 1. Street-level grid: ~4m spacing, 4 directions per position ---
        const STREET_SPACING = 4;
        const DIRS_PER_CELL = 4;
        const streetCols = Math.max(2, Math.ceil(usableW / STREET_SPACING));
        const streetRows = Math.max(2, Math.ceil(usableH / STREET_SPACING));
        const streetCellW = usableW / streetCols;
        const streetCellH = usableH / streetRows;

        for (let row = 0; row < streetRows; row++) {
            for (let col = 0; col < streetCols; col++) {
                const baseX = -usableHalfX + (col + 0.5) * streetCellW;
                const baseZ = -usableHalfZ + (row + 0.5) * streetCellH;
                const jx = baseX + (Math.random() - 0.5) * streetCellW * 0.6;
                const jz = baseZ + (Math.random() - 0.5) * streetCellH * 0.6;

                const pos = new THREE.Vector3(jx, eyeHeight, jz);
                if (!isPointValid({ x: jx, y: eyeHeight, z: jz }) || !this.hasGeometryClearance(pos)) {
                    rejected++;
                    continue;
                }

                for (let d = 0; d < DIRS_PER_CELL; d++) {
                    const yaw = (d / DIRS_PER_CELL) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
                    const pitch = (Math.random() - 0.4) * 0.4;

                    viewpoints.push({
                        position: new THREE.Vector3(jx, eyeHeight, jz),
                        target: new THREE.Vector3(
                            jx + Math.sin(yaw) * Math.cos(pitch) * LOOK_DIST,
                            eyeHeight + Math.sin(pitch) * LOOK_DIST,
                            jz + Math.cos(yaw) * Math.cos(pitch) * LOOK_DIST
                        ),
                    });
                }
            }
        }

        // --- 2. Elevated grid: ~8m spacing at rooftop height, 2 directions ---
        const ELEV_SPACING = 8;
        const elevCols = Math.max(1, Math.ceil(usableW / ELEV_SPACING));
        const elevRows = Math.max(1, Math.ceil(usableH / ELEV_SPACING));
        const elevCellW = usableW / elevCols;
        const elevCellH = usableH / elevRows;

        for (let row = 0; row < elevRows; row++) {
            for (let col = 0; col < elevCols; col++) {
                const x = -usableHalfX + (col + 0.5) * elevCellW + (Math.random() - 0.5) * elevCellW * 0.4;
                const z = -usableHalfZ + (row + 0.5) * elevCellH + (Math.random() - 0.5) * elevCellH * 0.4;
                const y = 4 + Math.random() * 6;

                const pos = new THREE.Vector3(x, y, z);
                if (!isPointValid({ x, y, z }) || !this.hasGeometryClearance(pos)) {
                    rejected++;
                    continue;
                }

                for (let d = 0; d < 2; d++) {
                    const yaw = d * Math.PI + (Math.random() - 0.5) * 0.5;
                    const pitch = -0.15 - Math.random() * 0.35;

                    viewpoints.push({
                        position: new THREE.Vector3(x, y, z),
                        target: new THREE.Vector3(
                            x + Math.sin(yaw) * Math.cos(pitch) * 15,
                            y + Math.sin(pitch) * 15,
                            z + Math.cos(yaw) * Math.cos(pitch) * 15
                        ),
                    });
                }
            }
        }

        // --- 3. Orbit rings: circles at multiple heights/radii ---
        const ringHeights = [eyeHeight, eyeHeight * 1.5, 5, 10];
        const orbitStepsPerRing = Math.max(8, Math.ceil(Math.min(usableHalfX, usableHalfZ) * 2 * Math.PI / STREET_SPACING));
        for (const rh of ringHeights) {
            const orbitRadius = Math.min(usableHalfX, usableHalfZ) * (0.4 + Math.random() * 0.3);
            for (let i = 0; i < orbitStepsPerRing; i++) {
                const angle = (i / orbitStepsPerRing) * Math.PI * 2;
                const x = Math.sin(angle) * orbitRadius;
                const z = Math.cos(angle) * orbitRadius;

                const pos = new THREE.Vector3(x, rh, z);
                if (!isPointValid({ x, y: rh, z }) || !this.hasGeometryClearance(pos)) {
                    rejected++;
                    continue;
                }

                const targetOffset = (Math.random() - 0.5) * 5;
                viewpoints.push({
                    position: new THREE.Vector3(x, rh, z),
                    target: new THREE.Vector3(targetOffset, eyeHeight * 0.5, targetOffset),
                });
            }
        }

        // --- 4. Overview shots: ~20 high vantage points looking down ---
        const overviewCount = Math.max(10, Math.round(numViews * 0.1));
        for (let i = 0; i < overviewCount; i++) {
            const y = 15 + Math.random() * 15;
            const x = (Math.random() * 2 - 1) * usableHalfX * 0.6;
            const z = (Math.random() * 2 - 1) * usableHalfZ * 0.6;

            const pos = new THREE.Vector3(x, y, z);
            if (!isPointValid({ x, y, z }) || !this.hasGeometryClearance(pos)) {
                rejected++;
                continue;
            }

            const targetX = x + (Math.random() * 2 - 1) * 8;
            const targetZ = z + (Math.random() * 2 - 1) * 8;

            viewpoints.push({
                position: new THREE.Vector3(x, y, z),
                target: new THREE.Vector3(targetX, 0, targetZ),
            });
        }

        if (rejected > 0) {
            console.warn(`[SplatExport] ${rejected} viewpoints rejected by validator/clearance`);
        }
        console.log(`[SplatExport] Generated ${viewpoints.length} viewpoints (${streetCols}x${streetRows} street grid, ${elevCols}x${elevRows} elevated grid, ${ringHeights.length}x${orbitStepsPerRing} orbit, ${overviewCount} overview)`);

        // Hard clamp positions to world bounds and log statistics
        let clamped = 0;
        const mins = new THREE.Vector3(Infinity, Infinity, Infinity);
        const maxs = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        for (const vp of viewpoints) {
            const p = vp.position;
            if (Math.abs(p.x) > halfX || Math.abs(p.z) > halfZ) {
                p.x = Math.max(-halfX, Math.min(halfX, p.x));
                p.z = Math.max(-halfZ, Math.min(halfZ, p.z));
                clamped++;
            }
            mins.min(p);
            maxs.max(p);
        }
        if (clamped > 0) {
            console.warn(`[SplatExport] ${clamped} positions clamped to world bounds`);
        }
        console.log(`[SplatExport] Camera position ranges: X=[${mins.x.toFixed(1)}, ${maxs.x.toFixed(1)}] (span ${(maxs.x - mins.x).toFixed(1)}), Y=[${mins.y.toFixed(1)}, ${maxs.y.toFixed(1)}] (span ${(maxs.y - mins.y).toFixed(1)}), Z=[${mins.z.toFixed(1)}, ${maxs.z.toFixed(1)}] (span ${(maxs.z - mins.z).toFixed(1)})`);

        // Shuffle for interleaved variety during progress
        for (let i = viewpoints.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = viewpoints[i]!;
            viewpoints[i] = viewpoints[j]!;
            viewpoints[j] = tmp;
        }

        return viewpoints;
    }

    private restoreSceneState(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
        scene.background = this.savedBackground;
        scene.fog = this.savedFog;
        renderer.toneMapping = this.savedToneMapping;
        renderer.toneMappingExposure = this.savedToneMappingExposure;
        renderer.setClearColor(this.savedClearColor, this.savedClearAlpha);

        if (this.exportFillLight) {
            scene.remove(this.exportFillLight);
            this.exportFillLight.dispose();
            this.exportFillLight = null;
        }

        // Re-show objects we hid at export start
        for (const obj of this.hiddenObjects) {
            obj.visible = true;
        }
        this.hiddenObjects = [];

        // Restore fluid mesh material side
        for (const [mesh, originalSide] of this.fluidMeshesOriginalSide) {
            (mesh.material as THREE.Material).side = originalSide;
        }
        this.fluidMeshesOriginalSide.clear();

        // Restore shadow light position (frustum was never changed)
        if (this.directionalLight && this.savedLightPosition && this.savedLightTargetPosition) {
            this.directionalLight.position.copy(this.savedLightPosition);
            this.directionalLight.target.position.copy(this.savedLightTargetPosition);
            this.directionalLight.target.updateMatrixWorld(true);
            this.directionalLight.updateMatrixWorld(true);
        }
        this.directionalLight = null;
        this.savedLightPosition = null;
        this.savedLightTargetPosition = null;
    }

    private finalizeExport(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
        this._isActive = false;
        this.restoreSceneState(scene, renderer);

        const transformsJson = JSON.stringify(this.transforms, null, 2);
        const frameCount = this.transforms?.frames.length ?? 0;
        console.log(`[SplatExport] Export complete: ${frameCount} frames`);

        this.cleanup();
        this.onComplete?.(transformsJson);
    }

    private cleanup(): void {
        if (this.renderTarget) {
            this.renderTarget.dispose();
            this.renderTarget = null;
        }
        this.exportCamera = null;
        this.offscreenCanvas = null;
        this.offscreenCtx = null;
        this.viewpoints = [];
        this.transforms = null;
        this.exportScene = null;
        this.exportRenderer = null;
        this.occlusionRaycaster = null;
        this.occlusionMeshes = [];
    }
}

const EXCLUDED_PLY_NAMES = ['Skybox', 'Sky', 'DebugHelper', 'GridHelper'];

/**
 * Generates a dense initialization point cloud from scene geometry.
 * Samples points on all visible mesh surfaces (area-weighted) with normals + colors.
 * Returns the complete PLY file as an ArrayBuffer (binary little-endian format).
 *
 * The result is used as `input.ply` for OpenSplat / Nerfstudio training —
 * it replaces the sparse COLMAP point cloud with a much denser, geometry-aware initialization.
 */
export function generateInitializationPLY(
    scene: THREE.Scene,
    targetPointCount: number = 5_000_000,
    minPointsPerTriangle: number = 3,
    worldSizeX: number = 128,
    worldSizeZ: number = 128,
    isPointInPlayableArea?: PointValidator,
): ArrayBuffer {
    const halfX = worldSizeX / 2;
    const halfZ = worldSizeZ / 2;
    const minY = -20;
    const maxY = 100;
    const tmpA = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    const tmpC = new THREE.Vector3();
    const tmpNA = new THREE.Vector3();
    const tmpNB = new THREE.Vector3();
    const tmpNC = new THREE.Vector3();
    const tmpPos = new THREE.Vector3();
    const tmpNorm = new THREE.Vector3();
    const normalMat = new THREE.Matrix3();

    function isExcluded(obj: THREE.Object3D): boolean {
        return EXCLUDED_PLY_NAMES.some(n => obj.name.includes(n)) || isDynamicExportObject(obj);
    }

    function pointInBounds(p: THREE.Vector3): boolean {
        if (p.x < -halfX || p.x > halfX || p.y < minY || p.y > maxY || p.z < -halfZ || p.z > halfZ) return false;
        if (isPointInPlayableArea && !isPointInPlayableArea(p)) return false;
        return true;
    }

    const worldBounds = new THREE.Box3(
        new THREE.Vector3(-halfX, minY, -halfZ),
        new THREE.Vector3(halfX, maxY, halfZ),
    );

    // Collect meshes whose world-space bounding box overlaps the level bounds
    const meshes: THREE.Mesh[] = [];
    const meshBox = new THREE.Box3();
    scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh) || !obj.geometry) return;
        if (isExcluded(obj)) return;
        if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
        if (obj.geometry.boundingBox) {
            meshBox.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld);
            if (!meshBox.intersectsBox(worldBounds)) return;
        }
        meshes.push(obj);
    });

    // Triangle is outside level if all 3 vertices are beyond bounds on any axis
    function triOutsideBounds(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
        if (a.x < -halfX && b.x < -halfX && c.x < -halfX) return true;
        if (a.x > halfX && b.x > halfX && c.x > halfX) return true;
        if (a.y < minY && b.y < minY && c.y < minY) return true;
        if (a.y > maxY && b.y > maxY && c.y > maxY) return true;
        if (a.z < -halfZ && b.z < -halfZ && c.z < -halfZ) return true;
        if (a.z > halfZ && b.z > halfZ && c.z > halfZ) return true;
        return false;
    }

    // Pass 1: compute total surface area (only in-bounds triangles)
    let totalArea = 0;
    let skippedTris = 0;
    for (const mesh of meshes) {
        const geom = mesh.geometry;
        const posAttr = geom.attributes.position;
        if (!posAttr) continue;
        const idx = geom.index?.array ?? null;
        const triCount = idx ? idx.length / 3 : posAttr.count / 3;

        for (let t = 0; t < triCount; t++) {
            const i0 = idx ? idx[t * 3]! : t * 3;
            const i1 = idx ? idx[t * 3 + 1]! : t * 3 + 1;
            const i2 = idx ? idx[t * 3 + 2]! : t * 3 + 2;

            tmpA.fromBufferAttribute(posAttr, i0).applyMatrix4(mesh.matrixWorld);
            tmpB.fromBufferAttribute(posAttr, i1).applyMatrix4(mesh.matrixWorld);
            tmpC.fromBufferAttribute(posAttr, i2).applyMatrix4(mesh.matrixWorld);

            if (triOutsideBounds(tmpA, tmpB, tmpC)) { skippedTris++; continue; }

            const ab = tmpB.clone().sub(tmpA);
            const ac = tmpC.clone().sub(tmpA);
            totalArea += ab.cross(ac).length() * 0.5;
        }
    }

    const pointsPerUnitArea = targetPointCount / Math.max(totalArea, 1);

    // Pass 2: count exact points so we can pre-allocate
    let totalPoints = 0;
    for (const mesh of meshes) {
        const geom = mesh.geometry;
        const posAttr = geom.attributes.position;
        if (!posAttr) continue;
        const idx = geom.index?.array ?? null;
        const triCount = idx ? idx.length / 3 : posAttr.count / 3;

        for (let t = 0; t < triCount; t++) {
            const i0 = idx ? idx[t * 3]! : t * 3;
            const i1 = idx ? idx[t * 3 + 1]! : t * 3 + 1;
            const i2 = idx ? idx[t * 3 + 2]! : t * 3 + 2;

            tmpA.fromBufferAttribute(posAttr, i0).applyMatrix4(mesh.matrixWorld);
            tmpB.fromBufferAttribute(posAttr, i1).applyMatrix4(mesh.matrixWorld);
            tmpC.fromBufferAttribute(posAttr, i2).applyMatrix4(mesh.matrixWorld);

            if (triOutsideBounds(tmpA, tmpB, tmpC)) continue;

            const ab = tmpB.clone().sub(tmpA);
            const ac = tmpC.clone().sub(tmpA);
            const triArea = ab.cross(ac).length() * 0.5;
            totalPoints += Math.max(minPointsPerTriangle, Math.ceil(triArea * pointsPerUnitArea));
        }
    }

    console.log(`[SplatExport] ${meshes.length} meshes, ${totalArea.toFixed(1)} m² area, ${skippedTris} out-of-bounds tris → ${totalPoints.toLocaleString()} points (bounds: X±${halfX}, Y[${minY},${maxY}], Z±${halfZ})`);

    // Pre-allocate data buffer (header will be written after we know actual point count)
    const bytesPerPoint = 3 * 4 + 3 * 1 + 3 * 4; // 27
    const dataBuffer = new ArrayBuffer(totalPoints * bytesPerPoint);
    const dv = new DataView(dataBuffer);
    let off = 0;
    let writtenPoints = 0;

    // Pass 3: sample and write directly to buffer
    for (const mesh of meshes) {
        const geom = mesh.geometry;
        const posAttr = geom.attributes.position;
        if (!posAttr) continue;
        // Use existing normals — never call computeVertexNormals() as it mutates
        // shared geometry (e.g. ceiling planes with intentionally reversed winding).
        // Post-upload-released attributes (GeometryCpuRelease) are zero-length,
        // not absent — treat them as absent so the face-normal / material-color
        // fallbacks kick in instead of sampling NaN. Exact for flat-shaded voxel
        // meshes, whose vertex normals equal the face normal anyway.
        const rawNormAttr = geom.attributes.normal as THREE.BufferAttribute | undefined;
        const normAttr = rawNormAttr && rawNormAttr.array.length > 0 ? rawNormAttr : undefined;
        const rawColorAttr = geom.attributes.color as THREE.BufferAttribute | undefined;
        const colorAttr = rawColorAttr && rawColorAttr.array.length > 0 ? rawColorAttr : undefined;
        const idx = geom.index?.array ?? null;
        const triCount = idx ? idx.length / 3 : posAttr.count / 3;
        normalMat.getNormalMatrix(mesh.matrixWorld);

        const mat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
        const matR = mat?.color?.r ?? 0.67;
        const matG = mat?.color?.g ?? 0.67;
        const matB = mat?.color?.b ?? 0.67;

        for (let t = 0; t < triCount; t++) {
            const i0 = idx ? idx[t * 3]! : t * 3;
            const i1 = idx ? idx[t * 3 + 1]! : t * 3 + 1;
            const i2 = idx ? idx[t * 3 + 2]! : t * 3 + 2;

            tmpA.fromBufferAttribute(posAttr, i0).applyMatrix4(mesh.matrixWorld);
            tmpB.fromBufferAttribute(posAttr, i1).applyMatrix4(mesh.matrixWorld);
            tmpC.fromBufferAttribute(posAttr, i2).applyMatrix4(mesh.matrixWorld);

            if (triOutsideBounds(tmpA, tmpB, tmpC)) continue;

            if (normAttr) {
                tmpNA.fromBufferAttribute(normAttr, i0).applyMatrix3(normalMat).normalize();
                tmpNB.fromBufferAttribute(normAttr, i1).applyMatrix3(normalMat).normalize();
                tmpNC.fromBufferAttribute(normAttr, i2).applyMatrix3(normalMat).normalize();
            } else {
                // Compute face normal from cross product of triangle edges
                const faceNorm = new THREE.Vector3().crossVectors(
                    tmpB.clone().sub(tmpA), tmpC.clone().sub(tmpA)
                ).normalize();
                tmpNA.copy(faceNorm);
                tmpNB.copy(faceNorm);
                tmpNC.copy(faceNorm);
            }

            const ab = tmpB.clone().sub(tmpA);
            const ac = tmpC.clone().sub(tmpA);
            const triArea = ab.cross(ac).length() * 0.5;
            const numSamples = Math.max(minPointsPerTriangle, Math.ceil(triArea * pointsPerUnitArea));

            for (let s = 0; s < numSamples; s++) {
                let u = Math.random();
                let v = Math.random();
                if (u + v > 1) { u = 1 - u; v = 1 - v; }
                const w = 1 - u - v;

                tmpPos.set(
                    tmpA.x * w + tmpB.x * u + tmpC.x * v,
                    tmpA.y * w + tmpB.y * u + tmpC.y * v,
                    tmpA.z * w + tmpB.z * u + tmpC.z * v
                );
                if (!pointInBounds(tmpPos)) continue;
                tmpNorm.set(
                    tmpNA.x * w + tmpNB.x * u + tmpNC.x * v,
                    tmpNA.y * w + tmpNB.y * u + tmpNC.y * v,
                    tmpNA.z * w + tmpNB.z * u + tmpNC.z * v
                ).normalize();

                let r = matR, g = matG, b = matB;
                if (colorAttr) {
                    r = (colorAttr.getX(i0) * w + colorAttr.getX(i1) * u + colorAttr.getX(i2) * v);
                    g = (colorAttr.getY(i0) * w + colorAttr.getY(i1) * u + colorAttr.getY(i2) * v);
                    b = (colorAttr.getZ(i0) * w + colorAttr.getZ(i1) * u + colorAttr.getZ(i2) * v);
                }

                dv.setFloat32(off, tmpPos.x, true); off += 4;
                dv.setFloat32(off, tmpPos.y, true); off += 4;
                dv.setFloat32(off, tmpPos.z, true); off += 4;
                dv.setUint8(off, Math.min(255, Math.floor(r * 255))); off += 1;
                dv.setUint8(off, Math.min(255, Math.floor(g * 255))); off += 1;
                dv.setUint8(off, Math.min(255, Math.floor(b * 255))); off += 1;
                dv.setFloat32(off, tmpNorm.x, true); off += 4;
                dv.setFloat32(off, tmpNorm.y, true); off += 4;
                dv.setFloat32(off, tmpNorm.z, true); off += 4;
                writtenPoints++;
            }
        }
    }

    // Build final buffer with correct header (point count may differ from pre-allocated due to bounds clipping)
    const header =
        'ply\nformat binary_little_endian 1.0\n' +
        `element vertex ${writtenPoints}\n` +
        'property float x\nproperty float y\nproperty float z\n' +
        'property uchar red\nproperty uchar green\nproperty uchar blue\n' +
        'property float nx\nproperty float ny\nproperty float nz\n' +
        'end_header\n';
    const headerBytes = new TextEncoder().encode(header);
    const actualDataSize = writtenPoints * bytesPerPoint;
    const finalBuffer = new ArrayBuffer(headerBytes.length + actualDataSize);
    const finalView = new Uint8Array(finalBuffer);
    finalView.set(headerBytes, 0);
    finalView.set(new Uint8Array(dataBuffer, 0, actualDataSize), headerBytes.length);

    const pct = totalPoints > 0 ? ((totalPoints - writtenPoints) / totalPoints * 100).toFixed(0) : '0';
    console.log(`[SplatExport] PLY: ${writtenPoints.toLocaleString()} points (${pct}% filtered by bounds), ${(finalBuffer.byteLength / (1024 * 1024)).toFixed(1)} MB`);
    return finalBuffer;
}
