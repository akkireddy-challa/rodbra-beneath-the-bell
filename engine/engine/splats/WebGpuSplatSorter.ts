/**
 * WebGpuSplatSorter — GPU counting sort producing a back-to-front splat draw
 * order, entirely on-GPU via TSL compute (no CPU readback — the structural
 * fix over Spark's render-RGBA8-and-read-back-to-a-worker WebGL approach).
 *
 * Pipeline per sort (≈20 dispatches, only two of them over all N splats):
 *   1. clear      (65536 threads): histogram[b] = 0
 *   2. keys       (N threads):     view-depth → 16-bit bucket key;
 *                                  keys[i] = key; atomicAdd(histogram[key])
 *   3. scan ×16   (65536 threads): Hillis-Steele inclusive prefix sum over the
 *                                  histogram, ping-ponging two buffers. Each
 *                                  pass bakes its stride as a shader constant —
 *                                  16 tiny pipelines — because a stride uniform
 *                                  mutated between dispatches inside one frame
 *                                  would only keep its last value.
 *   4. offsets    (65536 threads): exclusive sum → atomic cursor per bucket
 *   5. scatter    (N threads):     slot = atomicAdd(offsets[key]);
 *                                  sortedIndices[slot] = i
 *
 * Keys are inverted (far = low bucket) so ascending `sortedIndices` is the
 * back-to-front order the blended draw consumes directly.
 *
 * 65536 depth buckets over the splat's view-depth range gives ~2mm resolution
 * on a 100m scene — far below visible blend-order error. Order within one
 * bucket is arbitrary (atomic race), which is harmless at that granularity.
 */
import * as THREE from 'three';
import type { WebGPURenderer, ComputeNode } from 'three/webgpu';
import { StorageBufferAttribute } from 'three/webgpu';
import {
    Fn, If, instanceIndex, storage, uniform, uint, float, vec4,
    atomicAdd, atomicStore,
} from 'three/tsl';

const BUCKETS = 65536;
const SCAN_PASSES = 16; // log2(BUCKETS)

export class WebGpuSplatSorter {
    private readonly numSplats: number;

    /** Object-space → view-space matrix used for depth keys. */
    private readonly uModelView = uniform(new THREE.Matrix4());
    private readonly uDistMin = uniform(0);
    private readonly uInvDistRange = uniform(1);

    // Compute nodes, built once at construction and dispatched every sort.
    private readonly clearPass: ComputeNode;
    private readonly keysPass: ComputeNode;
    private readonly scanPasses: ComputeNode[] = [];
    private readonly offsetsPass: ComputeNode;
    private readonly scatterPass: ComputeNode;

    constructor(
        numSplats: number,
        centersAttr: StorageBufferAttribute,
        sortedIndicesAttr: StorageBufferAttribute,
    ) {
        this.numSplats = numSplats;

        const keysAttr = new StorageBufferAttribute(new Uint32Array(numSplats), 1);
        const histAttr = new StorageBufferAttribute(new Uint32Array(BUCKETS), 1);
        const scanAAttr = new StorageBufferAttribute(new Uint32Array(BUCKETS), 1);
        const scanBAttr = new StorageBufferAttribute(new Uint32Array(BUCKETS), 1);
        const offsetsAttr = new StorageBufferAttribute(new Uint32Array(BUCKETS), 1);

        const centers = storage(centersAttr, 'vec4', numSplats);
        const keys = storage(keysAttr, 'uint', numSplats);
        const sorted = storage(sortedIndicesAttr, 'uint', numSplats);
        const histAtomic = storage(histAttr, 'uint', BUCKETS).toAtomic();
        const histPlain = storage(histAttr, 'uint', BUCKETS);
        const scanA = storage(scanAAttr, 'uint', BUCKETS);
        const scanB = storage(scanBAttr, 'uint', BUCKETS);
        const offsetsAtomic = storage(offsetsAttr, 'uint', BUCKETS).toAtomic();

        const nSplats = uint(numSplats);
        const nBuckets = uint(BUCKETS);

        // ── 1. clear histogram ──
        this.clearPass = Fn(() => {
            If(instanceIndex.lessThan(nBuckets), () => {
                atomicStore(histAtomic.element(instanceIndex), uint(0));
            });
        })().compute(BUCKETS);

        // ── 2. depth keys + histogram ──
        this.keysPass = Fn(() => {
            If(instanceIndex.lessThan(nSplats), () => {
                const center = centers.element(instanceIndex);
                const viewPos = this.uModelView.mul(vec4(center.xyz, 1));
                const dist = viewPos.z.negate();
                const norm = dist.sub(this.uDistMin).mul(this.uInvDistRange).clamp(0, 1);
                // Far → bucket 0 so ascending order is back-to-front.
                const key = uint(norm.oneMinus().mul(float(BUCKETS - 1)));
                keys.element(instanceIndex).assign(key);
                atomicAdd(histAtomic.element(key), uint(1));
            });
        })().compute(numSplats);

        // ── 3. Hillis-Steele inclusive scan, ping-pong ──
        // Pass 0 reads the histogram; pass k reads the previous pass's output.
        for (let k = 0; k < SCAN_PASSES; k++) {
            const stride = 1 << k; // baked into the shader as a constant
            const src = k === 0 ? histPlain : (k % 2 === 1 ? scanB : scanA);
            const dst = k % 2 === 0 ? scanB : scanA;
            this.scanPasses.push(Fn(() => {
                If(instanceIndex.lessThan(nBuckets), () => {
                    const own = src.element(instanceIndex).toVar();
                    If(instanceIndex.greaterThanEqual(uint(stride)), () => {
                        own.addAssign(src.element(instanceIndex.sub(uint(stride))));
                    });
                    dst.element(instanceIndex).assign(own);
                });
            })().compute(BUCKETS));
        }
        // After 16 passes (writes: B,A,B,A,…) the inclusive scan lands in scanA.
        const scanResult = scanA;

        // ── 4. exclusive offsets → atomic cursors ──
        this.offsetsPass = Fn(() => {
            If(instanceIndex.lessThan(nBuckets), () => {
                const exclusive = uint(0).toVar();
                If(instanceIndex.greaterThan(uint(0)), () => {
                    exclusive.assign(scanResult.element(instanceIndex.sub(uint(1))));
                });
                atomicStore(offsetsAtomic.element(instanceIndex), exclusive);
            });
        })().compute(BUCKETS);

        // ── 5. scatter ──
        this.scatterPass = Fn(() => {
            If(instanceIndex.lessThan(nSplats), () => {
                const key = keys.element(instanceIndex);
                const slot = atomicAdd(offsetsAtomic.element(key), uint(1));
                sorted.element(slot).assign(instanceIndex);
            });
        })().compute(numSplats);
    }

    /**
     * Run the full sort. `modelView` must be the same object→view matrix the
     * upcoming draw will use; `distMin`/`distRange` bound the splat's view
     * depths (from its world-space bounding sphere) for key quantisation.
     */
    sort(renderer: WebGPURenderer, modelView: THREE.Matrix4, distMin: number, distRange: number): void {
        this.uModelView.value.copy(modelView);
        this.uDistMin.value = distMin;
        this.uInvDistRange.value = 1 / Math.max(distRange, 1e-6);

        renderer.compute(this.clearPass);
        renderer.compute(this.keysPass);
        for (const pass of this.scanPasses) renderer.compute(pass);
        renderer.compute(this.offsetsPass);
        renderer.compute(this.scatterPass);
    }
}
