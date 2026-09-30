import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    Fn, If, uniform, texture, uv, float, uint, vec2, vec3, instanceIndex, instancedArray,
    deltaTime, time, hash, billboarding, positionGeometry, smoothstep, mix, pow, clamp,
} from 'three/tsl';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import type { RainHeightField } from 'engine/weather/RainHeightField.js';

/**
 * GPU-compute rain for the WebGPU backend — the three.js compute-rain
 * architecture (storage buffers + one compute pass per frame) driven by the
 * engine's collider-raycast `RainHeightField` instead of a per-frame scene
 * render:
 *
 *  - every drop lives in a storage buffer and falls in a camera-following
 *    column (horizontal wrap, so it always rains everywhere the player looks);
 *  - the compute pass samples the height-field texture to find the surface
 *    under each drop — impacts spawn a splash AT THE REAL HIT POINT (track,
 *    kerb, bridge deck) and drops never fall through covered areas, which is
 *    also what keeps tunnels and underpasses dry;
 *  - streaks render as one instanced billboard mesh reading the position
 *    buffer directly (zero per-frame CPU work, zero attribute uploads);
 *  - splashes render as one instanced mesh of expanding rings + a small
 *    vertical crown, driven by the same impact buffers.
 *
 * The compute dispatch MUST run outside the render pass (same constraint as
 * the splat sorter): `WeatherSystem` calls `computeStep()` from the engine's
 * pre-render update, never from an `onBeforeRender` hook.
 */
export interface RainVFXGpuOptions {
    /** Storage-buffer size and draw ceiling. Active count scales with intensity. */
    maxDrops: number;
    /** Horizontal half-extent of the camera-following rain column (m). */
    radius: number;
    /** Spawn height above the camera (m). */
    columnHeight: number;
    /** Base fall speed (m/s); per-drop jitter spreads 0.75×..1.25×. */
    fallSpeed: number;
    /** Streak billboard width (m). */
    streakWidth: number;
    /** Streak billboard length (m). */
    streakLength: number;
    /** Splash ring diameter at full expansion (m). */
    splashSize: number;
    /** Streak opacity at full rain intensity. */
    opacity: number;
}

export const DEFAULT_RAIN_VFX_GPU_OPTIONS: RainVFXGpuOptions = {
    maxDrops: 40000,
    radius: 60,
    columnHeight: 26,
    fallSpeed: 22,
    streakWidth: 0.03,
    streakLength: 1.5,
    splashSize: 0.65,
    opacity: 0.16,
};

/** Splash animation speed: a splash lives 1/SPLASH_RATE seconds. */
const SPLASH_RATE = 2.4;

/** Typed storage-buffer constructors — `instancedArray`'s overloaded typing
 *  doesn't survive instantiation expressions, so field types infer from these. */
function makeVec3Buffer(count: number) { return instancedArray(count, 'vec3'); }
function makeFloatBuffer(count: number) { return instancedArray(count, 'float'); }

/** The slice of a renderer that can dispatch compute (WebGPURenderer). */
export interface ComputeCapableRenderer {
    compute(node: unknown): unknown;
}

export class RainVFXGpu {
    private readonly scene: THREE.Scene;
    private readonly opts: RainVFXGpuOptions;

    private readonly rainMesh: THREE.Mesh;
    private readonly rainMaterial: MeshBasicNodeMaterial;
    private readonly splashMesh: THREE.Mesh;
    private readonly splashMaterial: MeshBasicNodeMaterial;

    private readonly computeInitNode: unknown;
    private readonly computeUpdateNode: unknown;
    private initialized = false;

    private readonly centerU = uniform(new THREE.Vector3());
    private readonly windU = uniform(new THREE.Vector2(0, 0));
    private readonly intensityU = uniform(1);
    private readonly mapMinU = uniform(new THREE.Vector2(0, 0));
    private readonly mapSizeU = uniform(new THREE.Vector2(1, 1));
    private readonly noHitFloorU = uniform(-100);
    /** Negative values select the renderer clock; explicit values support deterministic inspection. */
    private readonly simulationClockU = uniform(new THREE.Vector2(-1, -1));

    /** Storage buffers as fields: disposed with the effect, and readable via
     *  `renderer.getArrayBufferAsync(buffer.value)` for headless verification
     *  (the impact positions are the ground truth of the collision sampling). */
    readonly posBuffer: ReturnType<typeof makeVec3Buffer>;
    readonly splashPosBuffer: ReturnType<typeof makeVec3Buffer>;
    private readonly jitterBuffer: ReturnType<typeof makeFloatBuffer>;
    private readonly splashTimeBuffer: ReturnType<typeof makeFloatBuffer>;

    constructor(scene: THREE.Scene, field: RainHeightField, opts: RainVFXGpuOptions) {
        this.scene = scene;
        this.opts = opts;

        const posBuffer = makeVec3Buffer(opts.maxDrops);
        const jitterBuffer = makeFloatBuffer(opts.maxDrops);
        const splashPosBuffer = makeVec3Buffer(opts.maxDrops);
        const splashTimeBuffer = makeFloatBuffer(opts.maxDrops);
        this.posBuffer = posBuffer;
        this.jitterBuffer = jitterBuffer;
        this.splashPosBuffer = splashPosBuffer;
        this.splashTimeBuffer = splashTimeBuffer;

        const R = float(opts.radius);
        const boxSize = R.mul(2);

        this.computeInitNode = Fn(() => {
            const pos = posBuffer.element(instanceIndex);
            const jit = jitterBuffer.element(instanceIndex);
            const sPos = splashPosBuffer.element(instanceIndex);
            const sTime = splashTimeBuffer.element(instanceIndex);
            pos.x = hash(instanceIndex).sub(0.5).mul(boxSize);
            pos.y = hash(instanceIndex.add(1231)).mul(opts.columnHeight);
            pos.z = hash(instanceIndex.add(9277)).sub(0.5).mul(boxSize);
            jit.assign(hash(instanceIndex.add(3559)));
            sPos.assign(vec3(0, -10000, 0));
            sTime.assign(10);
        })().compute(opts.maxDrops);

        this.computeUpdateNode = Fn(() => {
            const pos = posBuffer.element(instanceIndex);
            const jit = jitterBuffer.element(instanceIndex);
            const sPos = splashPosBuffer.element(instanceIndex);
            const sTime = splashTimeBuffer.element(instanceIndex);

            // Clamp the step: a frame hitch (level stream, pipeline compile)
            // must not teleport every drop below the floor in one frame — that
            // synchronizes thousands of respawns into a visible rain "sheet".
            const dt = this.simulationClockU.x.greaterThanEqual(0).select(this.simulationClockU.x, deltaTime).min(0.05);
            const simulationTime = this.simulationClockU.y.greaterThanEqual(0).select(this.simulationClockU.y, time);

            sTime.addAssign(dt.mul(SPLASH_RATE));

            pos.x.addAssign(this.windU.x.mul(dt));
            pos.z.addAssign(this.windU.y.mul(dt));
            pos.y.subAssign(float(opts.fallSpeed).mul(jit.mul(0.5).add(0.75)).mul(dt));

            // Horizontal wrap into the camera-centred box — the column follows
            // the player at any speed without ever thinning out.
            pos.x.assign(pos.x.sub(this.centerU.x).add(R).mod(boxSize).sub(R).add(this.centerU.x));
            pos.z.assign(pos.z.sub(this.centerU.z).add(R).mod(boxSize).sub(R).add(this.centerU.z));

            // Surface under this drop, from the collider-raycast height field
            // (single channel: world Y; rows written in +Z order → v = w).
            const u = pos.x.sub(this.mapMinU.x).div(this.mapSizeU.x);
            const w = pos.z.sub(this.mapMinU.y).div(this.mapSizeU.y);
            const hit = texture(field.texture, vec2(u, w));
            const valid = u.greaterThan(0).and(u.lessThan(1)).and(w.greaterThan(0)).and(w.lessThan(1));
            const floorY = valid.select(hit.r, this.noHitFloorU);

            If(pos.y.lessThan(floorY), () => {
                If(valid, () => {
                    sPos.assign(vec3(pos.x, floorY.add(0.02), pos.z));
                    sTime.assign(0);
                });
                // The `uint()` around each time term is what these expressions
                // already compiled to: for equal-length scalars TSL takes the
                // LEFT operand's type, so `instanceIndex + time*n` was always a
                // uint add with the float truncated. Spelling it out keeps the
                // emitted shader identical.
                pos.x.assign(this.centerU.x.add(hash(instanceIndex.add(uint(simulationTime.mul(1024)))).sub(0.5).mul(boxSize)));
                pos.z.assign(this.centerU.z.add(hash(instanceIndex.add(uint(simulationTime.mul(1024))).add(7919)).sub(0.5).mul(boxSize)));
                // Randomized respawn height — drops killed the same frame must
                // not re-enter as one synchronized falling plane.
                pos.y.assign(this.centerU.y.add(float(opts.columnHeight).mul(hash(instanceIndex.add(uint(simulationTime.mul(511))).add(131)).mul(0.45).add(0.55))));
            });

            // Safety recycle: bottomless cells, or the camera moved far vertically.
            If(
                pos.y.lessThan(this.centerU.y.sub(60))
                    .or(pos.y.greaterThan(this.centerU.y.add(opts.columnHeight * 2))),
                () => {
                    pos.y.assign(this.centerU.y.add(float(opts.columnHeight).mul(hash(instanceIndex.add(uint(time))))));
                },
            );
        })().compute(opts.maxDrops);

        // ── Streaks: one instanced billboard mesh reading the position buffer ──
        // Distance fade: instead of a hard volume edge (a visible "rain line"
        // ahead at speed), streaks thin out from half-radius and dissolve
        // before the wrap boundary.
        const streakDist = posBuffer.toAttribute().xz.sub(this.centerU.xz).length();
        const streakFade = float(1).sub(smoothstep(opts.radius * 0.5, opts.radius * 0.95, streakDist));

        this.rainMaterial = new MeshBasicNodeMaterial();
        const su = uv();
        const core = smoothstep(1, 0, su.x.sub(0.5).abs().mul(2));
        const ends = smoothstep(0, 0.2, su.y).mul(smoothstep(1, 0.8, su.y));
        this.rainMaterial.colorNode = vec3(0.75, 0.82, 0.92);
        this.rainMaterial.opacityNode = core.mul(ends).mul(float(opts.opacity)).mul(this.intensityU).mul(streakFade);
        this.rainMaterial.vertexNode = billboarding({ position: posBuffer.toAttribute() });
        this.rainMaterial.transparent = true;
        this.rainMaterial.depthWrite = false;
        this.rainMaterial.side = THREE.DoubleSide;
        this.rainMaterial.forceSinglePass = true;
        // Discard fully-transparent texels: with SSR's MRT active, a transparent
        // quad rasterizes into the normal/metalness attachments across its WHOLE
        // rectangle — alpha-zero pixels included — stamping a dead square into
        // the road's reflection mask under every quad. alphaTest turns those
        // pixels into discards so they write nothing anywhere.
        this.rainMaterial.alphaTest = 0.01;

        this.rainMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(opts.streakWidth, opts.streakLength),
            this.rainMaterial,
        );
        this.rainMesh.name = 'RainVFXStreaks';
        this.rainMesh.count = opts.maxDrops;
        this.rainMesh.frustumCulled = false;
        this.rainMesh.renderOrder = 2;
        scene.add(this.rainMesh);

        // ── Splashes: expanding ring + small crown at the true impact points ──
        const ringGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
        const crownA = new THREE.PlaneGeometry(0.5, 0.5).translate(0, 0.25, 0);
        const crownB = crownA.clone().rotateY(Math.PI / 2);
        const splashGeo = BufferGeometryUtils.mergeGeometries([ringGeo, crownA, crownB]);

        this.splashMaterial = new MeshBasicNodeMaterial();
        const t = clamp(splashTimeBuffer.toAttribute(), 0, 1);
        const scaleN = mix(0.15, 1, pow(t, 0.45)).mul(opts.splashSize);
        const yScale = scaleN.mul(float(1).sub(t).mul(0.9).add(0.1));
        this.splashMaterial.positionNode = positionGeometry
            .mul(vec3(scaleN, yScale, scaleN))
            .add(splashPosBuffer.toAttribute());
        const d = uv().sub(0.5).length().mul(2);
        const ring = smoothstep(0.22, 0.0, d.sub(t.mul(0.85)).abs());
        const splashDist = splashPosBuffer.toAttribute().xz.sub(this.centerU.xz).length();
        const splashFade = float(1).sub(smoothstep(opts.radius * 0.5, opts.radius * 0.95, splashDist));
        this.splashMaterial.colorNode = vec3(0.85, 0.9, 1.0);
        this.splashMaterial.opacityNode = ring.mul(pow(float(1).sub(t), 1.5)).mul(0.55).mul(this.intensityU).mul(splashFade);
        this.splashMaterial.transparent = true;
        this.splashMaterial.depthWrite = false;
        this.splashMaterial.side = THREE.DoubleSide;
        this.splashMaterial.forceSinglePass = true;
        // Same MRT-square guard as the streaks (see above).
        this.splashMaterial.alphaTest = 0.01;

        this.splashMesh = new THREE.Mesh(splashGeo, this.splashMaterial);
        this.splashMesh.name = 'RainVFXSplashes';
        this.splashMesh.count = opts.maxDrops;
        this.splashMesh.frustumCulled = false;
        this.splashMesh.renderOrder = 2;
        scene.add(this.splashMesh);
    }

    /** Scale the active drop count + streak/splash alpha with rain intensity. */
    setIntensity(intensity: number): void {
        const clamped = THREE.MathUtils.clamp(intensity, 0, 1);
        const n = Math.round(this.opts.maxDrops * clamped);
        this.intensityU.value = clamped;
        this.rainMesh.count = Math.max(1, n);
        this.splashMesh.count = Math.max(1, n);
        this.rainMesh.visible = n > 0;
        this.splashMesh.visible = n > 0;
    }

    /** Push the frame's shared weather state (camera centre + wind). */
    setFrameState(center: THREE.Vector3, windX: number, windZ: number): void {
        (this.centerU.value as THREE.Vector3).copy(center);
        (this.windU.value as THREE.Vector2).set(windX, windZ);
    }

    /** Re-read the height field's world mapping after a (re)build. */
    syncField(field: RainHeightField): void {
        (this.mapMinU.value as THREE.Vector2).copy(field.mapMin);
        (this.mapSizeU.value as THREE.Vector2).copy(field.mapSize);
        this.noHitFloorU.value = field.noHitFloorY;
    }

    /**
     * Advance the simulation one frame. Must run OUTSIDE the render pass
     * (engine pre-render update — compute is illegal mid-pass on WebGPU).
     */
    computeStep(renderer: ComputeCapableRenderer, deltaSeconds?: number, elapsedSeconds?: number): void {
        if (deltaSeconds !== undefined && (!Number.isFinite(deltaSeconds) || deltaSeconds < 0)) throw new Error('Rain delta time must be finite and nonnegative');
        if (elapsedSeconds !== undefined && (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0)) throw new Error('Rain elapsed time must be finite and nonnegative');
        (this.simulationClockU.value as THREE.Vector2).set(deltaSeconds ?? -1, elapsedSeconds ?? -1);
        if (!this.initialized) {
            renderer.compute(this.computeInitNode);
            this.initialized = true;
        }
        renderer.compute(this.computeUpdateNode);
    }

    dispose(): void {
        this.scene.remove(this.rainMesh);
        this.scene.remove(this.splashMesh);
        this.rainMesh.geometry.dispose();
        this.splashMesh.geometry.dispose();
        this.rainMaterial.dispose();
        this.splashMaterial.dispose();
    }
}
