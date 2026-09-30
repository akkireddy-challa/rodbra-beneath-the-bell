/**
 * WebGL2 GPU baker for the precomputed visibility set (PVS).
 *
 * For each walkable cell the baker positions a virtual camera at eye
 * height and renders the scene's opaque occluders (voxel chunks) into a
 * six-face cubemap, where each fragment outputs the *tile-ID of its
 * world position* into an RGBA8 framebuffer. After the render, we read
 * back the cubemap, dedupe pixel values, and the resulting set is the
 * cell's PVS — every tile that has at least one visible fragment from
 * the cell's vantage point.
 *
 * Why this beats the JS ray bake (v2 chunk-directed):
 * - Strictly conservative: every fragment the GPU rasterizes contributes
 *   to the PVS. No sampling gaps, no flicker.
 * - Orders of magnitude faster: a 64²×6-face cubemap is ~25k fragments;
 *   rasterizing those for 30k cells is well under a minute on any modern
 *   GPU. The JS bake was hours.
 * - Universal: WebGL2 only, no compute shaders, no WebGPU. Works on every
 *   browser the game itself works on.
 *
 * Implementation choices:
 * - **WebGL2 GLSL3** raw shader material so we get integer-friendly
 *   output without Three.js's chunk machinery getting in the way.
 * - **Six separate WebGLRenderTargets** for cube faces (not a single
 *   WebGLCubeRenderTarget) because Three's cube target doesn't expose a
 *   clean per-face readPixels path.
 * - **Cell batching:** render N cells back-to-back without a readPixels
 *   in between, then drain. Driver sync stalls are the bottleneck, not
 *   raw bandwidth, so batching ~32 cells per readback flight gets the
 *   total bake into the seconds-per-thousand-cells range.
 * - **Proxy scene:** we clone each chunk's collision mesh into a private
 *   scene with the ID material. Avoids overriding materials on the live
 *   scene (which would interfere with anything currently rendering, and
 *   doesn't reliably catch SparkJS splat passes).
 */
import * as THREE from 'three';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { VisibilityTileGrid, decodePixelToTileKey, TILE_ID_OFFSET } from './VisibilityTileGrid.js';

/** Resolution of each cubemap face. 64² is the sweet spot — bigger faces don't add useful PVS coverage past tile-grid granularity. */
const DEFAULT_FACE_RESOLUTION = 64;

/** How many cells' worth of cube faces to queue before draining via readPixels. */
const DEFAULT_BATCH_CELLS = 1;

/**
 * We use Three.js's `CubeCamera` + `WebGLCubeRenderTarget` for the 6-
 * face render. Earlier hand-rolled approaches (single camera + lookAt,
 * single camera + quaternion swap, 6 separate cameras + viewport slots)
 * all produced pairs of identical face renders — Three's WebGLRenderer
 * has internal state caching (`_currentCamera`, view-frustum, uniform
 * blocks) that doesn't fully refresh on rapid re-renders of similar
 * camera instances. `CubeCamera.update()` manages all the internal
 * state correctly, including per-face `renderer.setRenderTarget(rt, faceIndex)`
 * which forces a full state reset.
 *
 * Face indices in WebGLCubeRenderTarget match the GL cubemap convention:
 *   0 = +X    1 = -X    2 = +Y    3 = -Y    4 = +Z    5 = -Z
 * which is the order we use for the atlas readback.
 */

// Note: `#version 300 es` is auto-prepended by Three.js when the material
// declares `glslVersion: THREE.GLSL3`. Writing it manually here would
// produce two version directives and the shader would fail to compile.
// Voxel chunks bake world coordinates into the position attribute and
// keep matrixWorld at identity, so `position` already IS world. We use
// `modelViewMatrix` (which RawShaderMaterial does update) for clip
// space rather than `modelMatrix * viewMatrix` — that pairing produced
// wrong values during testing, likely because modelMatrix isn't being
// auto-supplied to RawShaderMaterial the way ShaderMaterial gets it.
const TILE_ID_VERTEX_SHADER = /* glsl */ `precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
out vec3 vWorldPos;
void main() {
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const TILE_ID_FRAGMENT_SHADER = /* glsl */ `precision highp float;
in vec3 vWorldPos;
uniform vec3 uOrigin;
uniform float uTileSize;
out vec4 outColor;
void main() {
    vec3 local = (vWorldPos - uOrigin) / uTileSize;
    int tx = int(floor(local.x)) + ${TILE_ID_OFFSET};
    int ty = int(floor(local.y)) + ${TILE_ID_OFFSET};
    int tz = int(floor(local.z)) + ${TILE_ID_OFFSET};
    if (tx < 0 || tx > 255 || ty < 0 || ty > 255 || tz < 0 || tz > 255) {
        outColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    outColor = vec4(float(tx) / 255.0, float(ty) / 255.0, float(tz) / 255.0, 1.0);
}`;

export interface GpuBakeOptions {
    world: VoxelWorld;
    cells: ReadonlyMap<number, number>;
    tileGrid: VisibilityTileGrid;
    /** World-space anchor for cell coords — exactly `WalkableMapBounds.min{X,Z}` from the bake. */
    cellOriginX: number;
    cellOriginZ: number;
    /** Voxel size used to convert (cx, cz) → world (x, z). */
    voxelSize: number;
    /** Eye height above surface (lower bound). */
    minEyeHeight: number;
    /** Eye height above surface (upper bound — sampled by additional renders if eyeSamples > 1). */
    maxEyeHeight: number;
    /** 1 = render only at min, 3 = crouched/standing/apex, etc. */
    eyeSamples: number;
    /** Cubemap face resolution (square). */
    faceResolution?: number;
    /** Cell-batch size for progress-yield throttling. */
    batchCells?: number;
    /** Progress callback. */
    onProgress?: (done: number, total: number) => void;
    /** Optional clip plane far distance. Defaults to a generous 200 m. */
    farPlane?: number;
}

export interface GpuBakeResult {
    pvs: Map<number, Set<number>>;
    totalTilesRendered: number;
    elapsedMs: number;
}

/**
 * One-shot baker. Construct, call `bake()` once, then `dispose()`. Reusing
 * across bakes is fine but we explicitly dispose render targets after each
 * bake to avoid leaking GPU memory in long editor sessions.
 */
export class WalkableMapGpuBaker {
    /** GRID_OFFSET used by `WalkableMapVisualizer.packXZ` — kept in sync explicitly because the visualizer's helper isn't exported. */
    static readonly CELL_GRID_OFFSET = 32768;

    private renderer: THREE.WebGLRenderer | null = null;
    private idMaterial: THREE.RawShaderMaterial | null = null;
    private proxyScene: THREE.Scene | null = null;
    /** Three.js cube render target. 6 faces, each `faceRes × faceRes × RGBA8`. */
    private cubeTarget: THREE.WebGLCubeRenderTarget | null = null;
    /** Three.js CubeCamera with 6 internal child cameras (one per face). */
    private cubeCamera: THREE.CubeCamera | null = null;
    private faceResolution: number = 0;

    async bake(opts: GpuBakeOptions): Promise<GpuBakeResult> {
        const start = performance.now();
        const faceRes = opts.faceResolution ?? DEFAULT_FACE_RESOLUTION;
        const batchCells = Math.max(1, opts.batchCells ?? DEFAULT_BATCH_CELLS);
        const far = opts.farPlane ?? 200;
        const eyeSamples = Math.max(1, opts.eyeSamples);

        this.initialize(faceRes, opts.tileGrid, far);
        this.buildProxyScene(opts.world);

        // Snapshot every piece of renderer state we mutate so the live
        // editor's next frame can pick up where it left off. Missing any
        // one of these caused a "tiny viewport / blank canvas" symptom
        // because Three's WebGLRenderer caches the user-set viewport &
        // scissor and only refreshes them when `setRenderTarget(null)`
        // is called *after* a `setViewport` to full-canvas — not the
        // tiny per-face viewport we set during the bake.
        const r = this.renderer!;
        const savedClear = r.getClearColor(new THREE.Color());
        const savedClearAlpha = r.getClearAlpha();
        const savedAutoClear = r.autoClear;
        const savedViewport = new THREE.Vector4();
        r.getViewport(savedViewport);
        const savedScissor = new THREE.Vector4();
        r.getScissor(savedScissor);
        const savedScissorTest = r.getScissorTest();

        const pvs = new Map<number, Set<number>>();
        const total = opts.cells.size;
        const cellList = Array.from(opts.cells);
        // 6-face atlas = (6 × faceRes) wide × faceRes tall, RGBA8.
        const atlasBuf = new Uint8Array(faceRes * 6 * faceRes * 4);
        let done = 0;
        let totalTilesRendered = 0;

        const CELL_GRID_OFFSET = WalkableMapGpuBaker.CELL_GRID_OFFSET;
        for (let i = 0; i < cellList.length; i++) {
            const [cellKey, surfaceY] = cellList[i]!;
            // Decode (cx, cz) from packed cell key and translate to world XZ.
            // Pack scheme matches WalkableMapVisualizer.packXZ: low word
            // is (cx + GRID_OFFSET), high word is (cz + GRID_OFFSET).
            const cx = (cellKey & 0xFFFF) - CELL_GRID_OFFSET;
            const cz = ((cellKey >>> 16) & 0xFFFF) - CELL_GRID_OFFSET;
            const wx = opts.cellOriginX + (cx + 0.5) * opts.voxelSize;
            const wz = opts.cellOriginZ + (cz + 0.5) * opts.voxelSize;
            const visible = new Set<number>();

            for (let s = 0; s < eyeSamples; s++) {
                const t = eyeSamples === 1 ? 0 : s / (eyeSamples - 1);
                const eyeY = surfaceY + opts.minEyeHeight + t * (opts.maxEyeHeight - opts.minEyeHeight);
                this.renderCubeAtlasFromPoint(wx, eyeY, wz, atlasBuf);
                totalTilesRendered += harvestTilesFromBuffer(atlasBuf, visible);
            }

            pvs.set(cellKey, visible);
            done++;
            if (opts.onProgress && (done % batchCells === 0 || done === total)) {
                opts.onProgress(done, total);
                // Yield so the editor stays interactive.
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }

        // Restore renderer state for the live editor.
        r.setClearColor(savedClear, savedClearAlpha);
        r.autoClear = savedAutoClear;
        r.setViewport(savedViewport);
        r.setScissor(savedScissor);
        r.setScissorTest(savedScissorTest);

        const elapsedMs = performance.now() - start;
        return { pvs, totalTilesRendered, elapsedMs };
    }

    /**
     * One-shot bake: render a single position and return the visible-tile
     * set. Used by the "sample from camera" debug path — validates the
     * GPU pipeline end-to-end (shader compiles, render hits geometry,
     * readback decodes correctly, chunks-to-tile mapping intersects) in
     * under a second, with no walkable-map dependency. If this works,
     * the multi-cell `bake()` works too.
     */
    async bakeOneCell(opts: {
        world: VoxelWorld;
        tileGrid: VisibilityTileGrid;
        eyeX: number; eyeY: number; eyeZ: number;
        faceResolution?: number;
        farPlane?: number;
    }): Promise<{ tiles: Set<number>; pixelsHit: number; elapsedMs: number }> {
        const start = performance.now();
        // Bump default face resolution & far plane for the one-shot
        // helper: the multi-cell bake amortizes pixel count over 30 k
        // cells, but a single sample needs higher fidelity to catch
        // small distant chunks that would otherwise sub-pixel out, and
        // a longer far plane so 100 m+ scenes aren't truncated.
        const faceRes = opts.faceResolution ?? 256;
        const far = opts.farPlane ?? 1000;
        this.initialize(faceRes, opts.tileGrid, far);
        this.buildProxyScene(opts.world);

        const r = this.renderer!;
        const savedClear = r.getClearColor(new THREE.Color());
        const savedClearAlpha = r.getClearAlpha();
        const savedAutoClear = r.autoClear;
        const savedViewport = new THREE.Vector4();
        r.getViewport(savedViewport);
        const savedScissor = new THREE.Vector4();
        r.getScissor(savedScissor);
        const savedScissorTest = r.getScissorTest();

        try {
            const atlasBuf = new Uint8Array(faceRes * 6 * faceRes * 4);
            this.renderCubeAtlasFromPoint(opts.eyeX, opts.eyeY, opts.eyeZ, atlasBuf);
            const tiles = new Set<number>();
            const pixelsHit = harvestTilesFromBuffer(atlasBuf, tiles);
            const faceHits = [0, 0, 0, 0, 0, 0];
            const stride = faceRes * 6 * 4;
            for (let y = 0; y < faceRes; y++) {
                for (let x = 0; x < faceRes * 6; x++) {
                    if (atlasBuf[y * stride + x * 4 + 3]! >= 128) faceHits[Math.floor(x / faceRes)]!++;
                }
            }
            console.log(`[gpu-bake] face hits (+X, -X, +Y, -Y, +Z, -Z) = ${faceHits.join(', ')} / ${faceRes * faceRes} per face — proxies in scene: ${this.proxyScene?.children.length ?? 0}`);
            downloadAtlasAsPng(atlasBuf, faceRes, `pvs-atlas-${Date.now()}.png`);
            this.renderColorAtlasFromPoint(opts.eyeX, opts.eyeY, opts.eyeZ, atlasBuf);
            downloadAtlasAsPng(atlasBuf, faceRes, `pvs-rgb-${Date.now()}.png`);
            return { tiles, pixelsHit, elapsedMs: performance.now() - start };
        } finally {
            r.setClearColor(savedClear, savedClearAlpha);
            r.autoClear = savedAutoClear;
            r.setViewport(savedViewport);
            r.setScissor(savedScissor);
            r.setScissorTest(savedScissorTest);
        }
    }

    /** Tear down GPU resources. Safe to call on a disposed baker. */
    dispose(): void {
        this.cubeTarget?.dispose();
        this.cubeTarget = null;
        this.cubeCamera = null;
        this.idMaterial?.dispose();
        this.idMaterial = null;
        if (this.proxyScene) {
            // Geometry instances are shared with the live world — don't
            // dispose those. Only drop the proxy mesh objects.
            this.proxyScene.clear();
            this.proxyScene = null;
        }
        this.renderer = null;
    }

    /** Inject the live game renderer so we share its GL context (and avoid creating a second one — Chrome caps WebGL contexts per page). */
    setRenderer(renderer: THREE.WebGLRenderer): void {
        this.renderer = renderer;
    }

    private initialize(faceRes: number, tileGrid: VisibilityTileGrid, far: number): void {
        if (!this.renderer) {
            throw new Error('[WalkableMapGpuBaker] setRenderer() must be called before bake() — we share the main renderer\'s GL context.');
        }
        this.faceResolution = faceRes;
        this.cubeTarget = new THREE.WebGLCubeRenderTarget(faceRes, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            generateMipmaps: false,
            depthBuffer: true,
            stencilBuffer: false,
        });
        this.idMaterial = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: TILE_ID_VERTEX_SHADER,
            fragmentShader: TILE_ID_FRAGMENT_SHADER,
            uniforms: {
                uOrigin: { value: new THREE.Vector3(tileGrid.originX, tileGrid.originY, tileGrid.originZ) },
                uTileSize: { value: tileGrid.tileSize },
            },
            side: THREE.FrontSide,
            depthTest: true,
            depthWrite: true,
        });
        this.cubeCamera = new THREE.CubeCamera(0.01, far, this.cubeTarget);
        this.proxyScene = new THREE.Scene();
    }

    /**
     * Build a proxy scene containing every chunk's collision mesh
     * (shared geometry, ID material). Splats and other transparent
     * meshes are intentionally excluded — only opaque occluders should
     * write tile-IDs into the buffer.
     *
     * Critical: we set the proxy's local matrix to the source chunk's
     * `matrixWorld`, not `matrix`. Voxel chunks often parent under a
     * non-identity group (e.g. an environment-object root), so the
     * chunk's `matrix` (local) and `matrixWorld` (composite) differ.
     * The shader reads `modelMatrix` (which Three derives from the
     * proxy's matrixWorld); the proxy has no parent in proxyScene so
     * its matrixWorld === its matrix. Copying `src.matrixWorld` to
     * `proxy.matrix` puts the proxy at the same world position the
     * live chunk renders at — without this, fragments wrote tile-IDs
     * for ghost-positioned geometry while the chunk AABB check (which
     * walks parent transforms via setFromObject) tested the real
     * position; the two sets had no overlap and every chunk culled.
     */
    private buildProxyScene(world: VoxelWorld): void {
        if (!this.proxyScene || !this.idMaterial) throw new Error('[WalkableMapGpuBaker] not initialized');
        let logged = 0;
        const debugBox = new THREE.Box3();
        for (const chunk of world.getChunks().values()) {
            const src = chunk.collisionMesh;
            if (!(src instanceof THREE.Mesh)) continue;
            src.updateMatrixWorld(true);
            const proxy = new THREE.Mesh(src.geometry, this.idMaterial);
            proxy.matrix.copy(src.matrixWorld);
            proxy.matrixAutoUpdate = false;
            proxy.matrixWorldNeedsUpdate = true;
            proxy.frustumCulled = false; // we *want* every chunk considered per face
            this.proxyScene.add(proxy);
            if (logged < 3) {
                debugBox.setFromObject(src);
                console.log(
                    `[gpu-bake] proxy[${logged}] src.matrixWorld translation = (${src.matrixWorld.elements[12]?.toFixed(2)}, ${src.matrixWorld.elements[13]?.toFixed(2)}, ${src.matrixWorld.elements[14]?.toFixed(2)}); src world AABB min=(${debugBox.min.x.toFixed(1)}, ${debugBox.min.y.toFixed(1)}, ${debugBox.min.z.toFixed(1)}) max=(${debugBox.max.x.toFixed(1)}, ${debugBox.max.y.toFixed(1)}, ${debugBox.max.z.toFixed(1)})`,
                );
                logged++;
            }
        }
    }

    /**
     * Render six cube faces from `(x, y, z)` into the wide atlas, one
     * face per viewport. Single render-target bind, single clear, six
     * draws — replaces the old per-face setRenderTarget+clear+render
     * triple which forced GPU pipeline flushes between every face.
     */
    /**
     * Render 6 cube faces from `(x, y, z)` via Three's CubeCamera, then
     * read each face back into the wide atlas buffer at column-offset
     * `f * faceRes`. Reading per-face is more `readRenderTargetPixels`
     * calls (6 vs 1) than the strip-target approach, but CubeCamera is
     * the only render path that doesn't trip the WebGLRenderer's
     * camera-state cache and produce paired-face renders.
     */
    private renderCubeAtlasFromPoint(x: number, y: number, z: number, atlasBuf: Uint8Array): void {
        if (!this.renderer || !this.cubeCamera || !this.cubeTarget || !this.proxyScene) return;
        const res = this.faceResolution;
        this.renderer.setClearColor(0x000000, 0);
        this.cubeCamera.position.set(x, y, z);
        this.cubeCamera.updateMatrixWorld(true);
        this.cubeCamera.update(this.renderer, this.proxyScene);
        // Read each cube face back into its slot in the atlas.
        const facePixels = res * res * 4;
        const faceBuf = new Uint8Array(facePixels);
        const rowBytes = res * 4;
        const atlasRowBytes = res * 6 * 4;
        for (let f = 0; f < 6; f++) {
            this.renderer.readRenderTargetPixels(this.cubeTarget, 0, 0, res, res, faceBuf, f);
            // Copy face's rows into atlas at column-offset f*res.
            for (let y2 = 0; y2 < res; y2++) {
                const srcOff = y2 * rowBytes;
                const dstOff = y2 * atlasRowBytes + f * rowBytes;
                atlasBuf.set(faceBuf.subarray(srcOff, srcOff + rowBytes), dstOff);
            }
        }
    }

    /**
     * Same as `renderCubeAtlasFromPoint` but with `scene.overrideMaterial`
     * swapped to a vertex-colour MeshBasicMaterial — produces a normal-
     * looking RGB rendering of the scene from the same camera. Lets us
     * verify visually whether the bake's camera is actually pointed at
     * sensible geometry, independent of the tile-ID encoding.
     */
    private renderColorAtlasFromPoint(x: number, y: number, z: number, atlasBuf: Uint8Array): void {
        if (!this.renderer || !this.cubeCamera || !this.cubeTarget || !this.proxyScene) return;
        const debugMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.FrontSide });
        const previousOverride = this.proxyScene.overrideMaterial;
        this.proxyScene.overrideMaterial = debugMat;
        try {
            this.renderCubeAtlasFromPoint(x, y, z, atlasBuf);
        } finally {
            this.proxyScene.overrideMaterial = previousOverride;
            debugMat.dispose();
        }
    }

    /**
     * One-shot bake variant that returns the *colour* atlas buffer
     * (vertex-coloured 6-face cubemap) without saving PNG. Used by
     * the realtime overlay tick. Initialises/rebuilds the proxy scene
     * on each call — caller should keep an instance alive across ticks
     * to share the GL context but accept the per-tick rebuild cost.
     */
    async bakeColorAtlas(opts: {
        world: VoxelWorld;
        tileGrid: VisibilityTileGrid;
        eyeX: number; eyeY: number; eyeZ: number;
        faceResolution?: number;
    }): Promise<Uint8Array> {
        const faceRes = opts.faceResolution ?? DEFAULT_FACE_RESOLUTION;
        this.initialize(faceRes, opts.tileGrid, 1000);
        this.buildProxyScene(opts.world);
        const r = this.renderer!;
        const savedClear = r.getClearColor(new THREE.Color());
        const savedClearAlpha = r.getClearAlpha();
        const savedAutoClear = r.autoClear;
        const savedViewport = new THREE.Vector4(); r.getViewport(savedViewport);
        const savedScissor = new THREE.Vector4(); r.getScissor(savedScissor);
        const savedScissorTest = r.getScissorTest();
        try {
            const buf = new Uint8Array(faceRes * 6 * faceRes * 4);
            this.renderColorAtlasFromPoint(opts.eyeX, opts.eyeY, opts.eyeZ, buf);
            return buf;
        } finally {
            r.setClearColor(savedClear, savedClearAlpha);
            r.autoClear = savedAutoClear;
            r.setViewport(savedViewport);
            r.setScissor(savedScissor);
            r.setScissorTest(savedScissorTest);
        }
    }

}

/**
 * Save the 6-face atlas readback as a PNG for inspection. WebGL reads
 * back with origin at the bottom-left, so we flip Y as we copy into a
 * 2D-canvas ImageData (top-left origin) to make the result look like
 * what you'd expect viewing each face right-side-up. The 6 faces are
 * laid out horizontally: +X, -X, +Y, -Y, +Z, -Z (the look-direction
 * order in CUBE_LOOK_DIRS above).
 *
 * Diagnostic colouring: any pixel with alpha < 128 (untouched by the
 * shader, just cleared) is painted bright magenta so background and
 * rendered-tile pixels are easy to tell apart. A 1-pixel red line
 * marks each face boundary so you can see which face is which.
 *
 * Triggers a normal browser download so the user can open it and
 * eyeball the bake. Returns silently if running in a non-DOM context.
 */
function downloadAtlasAsPng(buf: Uint8Array, faceRes: number, filename: string): void {
    if (typeof document === 'undefined') return;
    const width = faceRes * 6;
    const height = faceRes;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(width, height);
    // WebGL → 2D-canvas Y flip; recolour transparent pixels magenta.
    for (let y = 0; y < height; y++) {
        const srcRow = (height - 1 - y) * width * 4;
        const dstRow = y * width * 4;
        for (let x = 0; x < width; x++) {
            const si = srcRow + x * 4;
            const di = dstRow + x * 4;
            const a = buf[si + 3]!;
            if (a < 128) {
                img.data[di] = 255; img.data[di + 1] = 0; img.data[di + 2] = 255; img.data[di + 3] = 255;
            } else {
                img.data[di] = buf[si]!; img.data[di + 1] = buf[si + 1]!; img.data[di + 2] = buf[si + 2]!; img.data[di + 3] = 255;
            }
        }
    }
    // Red 1-pixel face dividers at x = faceRes, 2*faceRes, …, 5*faceRes.
    for (let f = 1; f < 6; f++) {
        const x = f * faceRes;
        for (let y = 0; y < height; y++) {
            const i = (y * width + x) * 4;
            img.data[i] = 255; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
}

/**
 * Scan an RGBA8 readback buffer and add every distinct tile key to the
 * given set. Returns how many pixels carried a real tile (alpha>=128) —
 * useful as a debug throughput metric.
 */
function harvestTilesFromBuffer(buf: Uint8Array, out: Set<number>): number {
    let hits = 0;
    for (let i = 0; i < buf.length; i += 4) {
        const key = decodePixelToTileKey(buf[i]!, buf[i + 1]!, buf[i + 2]!, buf[i + 3]!);
        if (key === null) continue;
        out.add(key);
        hits++;
    }
    return hits;
}
