/**
 * WebGpuSplatMesh — WebGPU-native Gaussian-splat renderer built on three.js
 * TSL + compute. This is the engine's ONLY Gaussian-splat renderer; the legacy
 * WebGL/Spark path was removed, so splats render only on the WebGPURenderer
 * (on a WebGL backend only the lightweight point-cloud preview is shown).
 *
 * Design (the standard 3DGS raster approach, GPU end-to-end):
 *  - One draw call: a unit quad instanced `numSplats` times (`object.count`
 *    instancing — no InstancedMesh matrix overhead). The vertex stage pulls
 *    splat *i* from storage buffers via a GPU-sorted index, projects the
 *    precomputed 3D covariance to a screen-space ellipse (EWA), and positions
 *    the quad corner; the fragment stage evaluates the gaussian falloff.
 *  - Depth ordering comes from `WebGpuSplatSorter` (counting sort in compute,
 *    no CPU readback). Premultiplied alpha, depthTest on / depthWrite off, so
 *    splats composite correctly against the game's opaque geometry.
 *  - Per-frame work happens in `updateWebGpuSplatMeshes()`, called by
 *    GameEngine right before render (compute dispatches are not allowed
 *    mid-render-pass on WebGPU, so an onBeforeRender hook can't do this).
 *    The sort only re-runs when the splat↔camera relation actually changes.
 */
import * as THREE from 'three';
import type { Node, WebGPURenderer } from 'three/webgpu';
import { MeshBasicNodeMaterial, StorageBufferAttribute } from 'three/webgpu';
import {
    Fn, If, Discard, instanceIndex, storage, uniform, varyingProperty,
    int, uint, float, vec2, vec3, vec4, mat3,
    positionGeometry, modelViewMatrix, cameraProjectionMatrix,
} from 'three/tsl';
import type { GpuSplatData } from 'engine/splats/SpzLoader.js';
import { WebGpuSplatSorter } from 'engine/splats/WebGpuSplatSorter.js';

/**
 * `element(i)` reads COLUMN i out of a matrix node. TSL registers `element` as a
 * universal method chain and ArrayElementNode handles mat4 fine, but
 * @types/three declares it only on ArrayNode — so a mat4 column read has to
 * name the method itself.
 */
type MatrixColumns = { element(index: Node<'int'>): Node<'vec4'> };

export interface WebGpuSplatMeshOptions {
    /**
     * Quad extent in standard deviations. 3.0 keeps 99.7% of each gaussian's
     * mass; lower is faster (less overdraw) but visibly truncates big splats.
     */
    kernelRadius: number;
    /**
     * Max-element delta between this frame's and the last sorted frame's
     * object→view matrix before the GPU sort re-runs. Camera and object
     * motion both flow through that matrix, so one threshold covers both.
     */
    sortMatrixEpsilon: number;
    /**
     * Hard cap on a splat's projected semi-axis, in pixels. THE safety valve:
     * the perspective Jacobian has a 1/z² term, so a splat near the camera
     * plane projects to an unbounded ellipse — without this clamp a handful of
     * close splats each cover the whole screen and the fill-rate (and GPU
     * temperature) runs away. With the clamp, worst-case overdraw is bounded by
     * numSplats·maxAxisPx², which stays survivable even if every splat is
     * maxed. Raise once the projection is confirmed correct and measured.
     */
    maxAxisPx: number;
}

export const DEFAULT_WEBGPU_SPLAT_OPTIONS: WebGpuSplatMeshOptions = {
    kernelRadius: 3.0,
    sortMatrixEpsilon: 1e-4,
    // 128px: even a total projection failure (all splats clamped to this) caps
    // overdraw at numSplats·128² ≈ a few ×10⁹ fragments — tens of ms, not a
    // GPU meltdown. Deliberately conservative after the first run overheated.
    maxAxisPx: 128,
};

/**
 * Safety opt-in for the WebGPU splat renderer. Defaults OFF so an auto-reload
 * (the dev-server reload-on-save) never silently activates the GPU-heavy path.
 * Enable from the game-iframe console with:
 *     localStorage.bmWebGpuSplats = '1'   (then reload)
 * or append `?webgpuSplats=1` to the iframe URL.
 */
export function webGpuSplatsEnabled(): boolean {
    try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('bmWebGpuSplats') === '1') return true;
        if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('webgpuSplats') === '1') return true;
    } catch { /* storage/URL unavailable — treat as disabled */ }
    return false;
}

/** Largest per-splat storage buffer is a vec4 (centers / covA / covB): 16 B. */
const BYTES_PER_SPLAT = 16;

/**
 * Max splats this device can render, bounded by WebGPU's
 * `maxStorageBufferBindingSize` (spec minimum 128 MiB → ~8.4M splats; M-series
 * adapters expose far more but three requests only the default). Returns a
 * conservative cap so an oversized splat can be declined before it triggers a
 * buffer-allocation failure and a cascade of invalid-bind-group errors.
 */
export function maxWebGpuSplats(renderer: unknown): number {
    const DEFAULT_LIMIT = 128 * 1024 * 1024; // WebGPU spec minimum
    const device = (renderer as { backend?: { device?: { limits?: { maxStorageBufferBindingSize?: number } } } } | null)
        ?.backend?.device;
    const limit = device?.limits?.maxStorageBufferBindingSize ?? DEFAULT_LIMIT;
    return Math.floor(limit / BYTES_PER_SPLAT);
}

/** Don't surface the experimental toggle to end users on the prod creator. */
function isProdHost(): boolean {
    return typeof location !== 'undefined' && location.hostname === 'creator.bitmagic.ai';
}

/**
 * Show a small in-game toggle for the WebGPU splat renderer. The game runs in
 * a cross-origin iframe, so `localStorage` typed in the default console targets
 * the wrong frame — this button runs in the game frame, flips the flag, and
 * reloads. Shown only when relevant (WebGPU backend + a splat present) and
 * never on prod. Idempotent: re-labels the existing button if already shown.
 */
export function installWebGpuSplatToggleButton(enabled: boolean): void {
    if (typeof document === 'undefined' || isProdHost()) return;
    const ID = 'bm-webgpu-splat-toggle';
    let btn = document.getElementById(ID) as HTMLButtonElement | null;
    if (!btn) {
        btn = document.createElement('button');
        btn.id = ID;
        btn.style.cssText = `
            position: fixed; bottom: 12px; left: 12px; z-index: 100000;
            padding: 8px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.25);
            font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, sans-serif;
            cursor: pointer; backdrop-filter: blur(6px); transition: background 0.15s;
        `;
        document.body.appendChild(btn);
    }
    btn.textContent = enabled ? '■ Disable WebGPU splats' : '▶ Enable WebGPU splats (experimental)';
    btn.style.background = enabled ? 'rgba(180,40,40,0.85)' : 'rgba(40,90,180,0.85)';
    btn.style.color = '#fff';
    btn.onclick = () => {
        try {
            if (enabled) localStorage.removeItem('bmWebGpuSplats');
            else localStorage.setItem('bmWebGpuSplats', '1');
        } catch { /* ignore storage failures */ }
        location.reload();
    };
}

/** All live meshes, updated each frame by `updateWebGpuSplatMeshes`. */
const activeMeshes = new Set<WebGpuSplatMesh>();

const _drawSize = new THREE.Vector2();
const _worldCenter = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _modelView = new THREE.Matrix4();
const _tmpQuat = new THREE.Quaternion();

export class WebGpuSplatMesh extends THREE.Mesh {
    /** Instance count — three's WebGPU renderer reads `object.count` for instanced draws. */
    count: number;

    readonly numSplats: number;
    private readonly options: WebGpuSplatMeshOptions;
    private readonly sorter: WebGpuSplatSorter;

    /** Object-space bounding sphere of the splat cloud (pre-pad). */
    private readonly localCenter: THREE.Vector3;
    private readonly localRadius: number;

    // Draw uniforms, refreshed every frame.
    private readonly uFocal = uniform(new THREE.Vector2(1000, 1000));
    private readonly uViewport = uniform(new THREE.Vector2(1, 1));
    private readonly uMaxAxisPx = uniform(128);

    /** Object→view matrix at the last sort; only meaningful once `hasSorted`. */
    private readonly lastSortedModelView = new THREE.Matrix4();
    /** False until the first sort has run — forces an unconditional first sort. */
    private hasSorted = false;

    constructor(data: GpuSplatData, options: WebGpuSplatMeshOptions = DEFAULT_WEBGPU_SPLAT_OPTIONS) {
        // Unit quad, instanced per splat. Corner positions in {-1,1}².
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
        ]), 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);

        const material = new MeshBasicNodeMaterial();
        super(geometry, material);

        this.numSplats = data.numSplats;
        this.count = data.numSplats;
        this.options = options;
        this.frustumCulled = true;

        // ── GPU buffers ──
        const centersAttr = new StorageBufferAttribute(data.centers, 4);
        const covAAttr = new StorageBufferAttribute(data.covA, 4);
        const covBAttr = new StorageBufferAttribute(data.covB, 4);
        const colorsAttr = new StorageBufferAttribute(data.colorsU32, 1);
        // Identity order until the first sort completes.
        const initialOrder = new Uint32Array(data.numSplats);
        for (let i = 0; i < data.numSplats; i++) initialOrder[i] = i;
        const sortedAttr = new StorageBufferAttribute(initialOrder, 1);

        this.sorter = new WebGpuSplatSorter(data.numSplats, centersAttr, sortedAttr);

        // ── Bounds ──
        const min = data.boundsMin, max = data.boundsMax;
        this.localCenter = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
        this.localRadius = Math.sqrt((max.x - min.x) ** 2 + (max.y - min.y) ** 2 + (max.z - min.z) ** 2) / 2;
        // Pad so quads of edge splats don't get frustum-culled with the center.
        geometry.boundingSphere = new THREE.Sphere(this.localCenter.clone(), this.localRadius + 2);

        // ── Shader ──
        const centers = storage(centersAttr, 'vec4', this.numSplats);
        const covA = storage(covAAttr, 'vec4', this.numSplats);
        const covB = storage(covBAttr, 'vec4', this.numSplats);
        const colors = storage(colorsAttr, 'uint', this.numSplats);
        const sorted = storage(sortedAttr, 'uint', this.numSplats);

        const vColor = varyingProperty('vec4', 'vSplatColor');
        const vQuad = varyingProperty('vec2', 'vSplatQuad');
        const K = options.kernelRadius;

        material.vertexNode = Fn(() => {
            const splat = sorted.element(uint(instanceIndex));
            const center = centers.element(splat);
            const viewPos = modelViewMatrix.mul(vec4(center.xyz, 1)).toVar();

            const clip = vec4(0, 0, 2, 1).toVar(); // off-screen sentinel
            // Splats nearer than this are skipped (degenerate quad). The cutoff
            // is well in front of the camera, not ~0, because the 1/z² Jacobian
            // term makes near splats project huge — the size clamp below is the
            // real bound, this just avoids the worst of the math.
            If(viewPos.z.lessThan(-0.2), () => {
                const a4 = covA.element(splat);
                const b4 = covB.element(splat);
                // Symmetric 3D covariance in object space…
                const Vrk = mat3(
                    vec3(a4.x, a4.y, a4.z),
                    vec3(a4.y, b4.x, b4.y),
                    vec3(a4.z, b4.y, b4.z),
                );
                // …into view space: W Σ Wᵀ (W = rotation+scale of object→view).
                // WGSL has no mat3(mat4) constructor — build from columns, and
                // the transpose explicitly from the same column vars.
                const mv = modelViewMatrix as unknown as MatrixColumns;
                const m0 = vec3(mv.element(int(0))).toVar();
                const m1 = vec3(mv.element(int(1))).toVar();
                const m2 = vec3(mv.element(int(2))).toVar();
                const W = mat3(m0, m1, m2);
                const Wt = mat3(
                    vec3(m0.x, m1.x, m2.x),
                    vec3(m0.y, m1.y, m2.y),
                    vec3(m0.z, m1.z, m2.z),
                );
                const covView = W.mul(Vrk).mul(Wt);

                // Perspective Jacobian rows (pixel units, y-up NDC-consistent):
                // u = −fx·X/Z → ∂u = (−fx/Z, 0, fx·X/Z²); v analogous in Y.
                const z = viewPos.z;
                const invZ = float(1).div(z);
                const invZ2 = invZ.mul(invZ);
                const row0 = vec3(this.uFocal.x.negate().mul(invZ), 0, this.uFocal.x.mul(viewPos.x).mul(invZ2));
                const row1 = vec3(0, this.uFocal.y.negate().mul(invZ), this.uFocal.y.mul(viewPos.y).mul(invZ2));

                // 2D screen-space covariance: J·covView·Jᵀ (+0.3px low-pass, the
                // standard dilation that keeps sub-pixel splats from aliasing).
                const t0 = covView.mul(row0);
                const c00 = row0.dot(t0).add(0.3);
                const c01 = row1.dot(t0);
                const c11 = row1.dot(covView.mul(row1)).add(0.3);

                // Eigen-decomposition of the 2×2 covariance → ellipse axes.
                const mid = c00.add(c11).mul(0.5);
                const half = c00.sub(c11).mul(0.5);
                const r = half.mul(half).add(c01.mul(c01)).max(1e-9).sqrt();
                const lambda1 = mid.add(r);
                const lambda2 = mid.sub(r).max(0.0000001);
                // Major-axis direction; for near-diagonal matrices the generic
                // eigenvector degenerates, so pick the dominant axis directly.
                const dir = vec2(1, 0).toVar();
                If(c01.abs().greaterThan(1e-6), () => {
                    dir.assign(vec2(c01, lambda1.sub(c00)).normalize());
                }).Else(() => {
                    If(c11.greaterThan(c00), () => { dir.assign(vec2(0, 1)); });
                });

                // Clamp each semi-axis to a max pixel length — THE fill-rate
                // safety valve (see uMaxAxisPx). Without it, a splat near the
                // camera plane projects to a screen-filling ellipse and a few
                // such splats melt the GPU.
                const a1len = lambda1.sqrt().mul(K).min(this.uMaxAxisPx);
                const a2len = lambda2.sqrt().mul(K).min(this.uMaxAxisPx);
                const axis1 = dir.mul(a1len);
                const axis2 = vec2(dir.y.negate(), dir.x).mul(a2len);

                const corner = positionGeometry.xy;
                const offsetPx = axis1.mul(corner.x).add(axis2.mul(corner.y));

                const projected = cameraProjectionMatrix.mul(viewPos).toVar();
                // px → NDC: divide by half-viewport; ×w so it survives the divide.
                const ndcOffset = offsetPx.div(this.uViewport.mul(0.5)).mul(projected.w);
                clip.assign(vec4(projected.xy.add(ndcOffset), projected.z, projected.w));

                // Unpack base colour + opacity for the fragment stage.
                const c = colors.element(splat);
                const rgb = vec3(
                    float(c.bitAnd(uint(255))),
                    float(c.shiftRight(uint(8)).bitAnd(uint(255))),
                    float(c.shiftRight(uint(16)).bitAnd(uint(255))),
                ).div(255);
                vColor.assign(vec4(rgb, center.w));
                vQuad.assign(corner.mul(K));
            });

            return clip;
        })();

        material.colorNode = Fn(() => {
            const alpha = vColor.w.mul(vQuad.dot(vQuad).mul(-0.5).exp());
            If(alpha.lessThan(1 / 255), () => { Discard(); });
            // Premultiplied output (blending: One / OneMinusSrcAlpha).
            return vec4(vColor.xyz.mul(alpha), alpha);
        })();

        material.transparent = true;
        material.depthWrite = false;
        material.depthTest = true;
        // The splat was trained on final tonemapped screenshots — its colours
        // already ARE the desired display appearance. Loader linearises them
        // (sRGB→linear) so the renderer's output encode round-trips exactly;
        // tone mapping would crunch them a second time, so it's off.
        material.toneMapped = false;
        material.fog = false;
        material.side = THREE.DoubleSide;
        material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.OneFactor;
        material.blendDst = THREE.OneMinusSrcAlphaFactor;
        material.blendSrcAlpha = THREE.OneFactor;
        material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

        activeMeshes.add(this);
    }

    /**
     * Refresh draw uniforms and (when the object↔camera relation moved) re-run
     * the GPU sort. Called from `updateWebGpuSplatMeshes` once per frame.
     */
    updateForFrame(renderer: WebGPURenderer, camera: THREE.PerspectiveCamera): void {
        renderer.getDrawingBufferSize(_drawSize);
        this.uViewport.value.set(_drawSize.x, _drawSize.y);
        // Focal lengths in pixels from the projection matrix.
        const pe = camera.projectionMatrix.elements;
        this.uFocal.value.set(pe[0]! * _drawSize.x * 0.5, pe[5]! * _drawSize.y * 0.5);
        this.uMaxAxisPx.value = this.options.maxAxisPx;

        this.updateMatrixWorld();
        camera.updateMatrixWorld();
        _modelView.multiplyMatrices(camera.matrixWorldInverse, this.matrixWorld);

        // Re-sort on the first frame, then only when the object→view matrix
        // actually changed (camera or object motion both flow through it).
        if (this.hasSorted) {
            const a = _modelView.elements, b = this.lastSortedModelView.elements;
            let maxDelta = 0;
            for (let i = 0; i < 16; i++) {
                const d = Math.abs(a[i]! - b[i]!);
                if (d > maxDelta) maxDelta = d;
            }
            if (maxDelta <= this.options.sortMatrixEpsilon) return;
        }

        // View-depth window for key quantisation, from the world bounding sphere.
        _worldCenter.copy(this.localCenter).applyMatrix4(this.matrixWorld);
        this.matrixWorld.decompose(_camPos, _tmpQuat, _scale); // _camPos reused as scratch
        const maxScale = Math.max(_scale.x, _scale.y, _scale.z);
        const worldRadius = this.localRadius * maxScale;
        camera.getWorldPosition(_camPos);
        const centerDist = _camPos.distanceTo(_worldCenter);
        const distMin = Math.max(0.05, centerDist - worldRadius);
        const distRange = Math.max(worldRadius * 2, 0.1);

        this.sorter.sort(renderer, _modelView, distMin, distRange);
        this.lastSortedModelView.copy(_modelView);
        this.hasSorted = true;
    }

    dispose(): void {
        activeMeshes.delete(this);
        this.geometry.dispose();
        (this.material as THREE.Material).dispose();
    }
}

/** Renderer shape needed by the per-frame hook (compute + drawing size). */
function isWebGpuRenderer(renderer: unknown): renderer is WebGPURenderer {
    return !!renderer && (renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true;
}

/**
 * Per-frame driver for all live WebGPU splat meshes. GameEngine calls this
 * right before `renderer.render()` — compute passes must run outside the
 * render pass on WebGPU. No-op when no splats exist or on the WebGL backend.
 */
export function updateWebGpuSplatMeshes(renderer: unknown, camera: THREE.Camera | null): void {
    if (activeMeshes.size === 0 || !camera || !isWebGpuRenderer(renderer)) return;
    const persp = camera as THREE.PerspectiveCamera;
    if (!persp.isPerspectiveCamera) return;
    for (const mesh of activeMeshes) {
        // Skip meshes hidden by the eye-toggle / render-mode plumbing.
        let obj: THREE.Object3D | null = mesh;
        let visible = true;
        while (obj) {
            if (!obj.visible) { visible = false; break; }
            obj = obj.parent;
        }
        if (visible) mesh.updateForFrame(renderer, persp);
    }
}
