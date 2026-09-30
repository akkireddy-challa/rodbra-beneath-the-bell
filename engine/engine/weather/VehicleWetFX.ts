import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    attribute, uniform, float, vec3, vec4, uv, smoothstep, normalize, cross, clamp,
    cameraPosition, cameraProjectionMatrix, cameraViewMatrix, positionGeometry, log, sin,
    positionView,
} from 'three/tsl';
import { isWebGpuActive } from 'engine/RendererType.js';
import { GROUND_TYPE } from 'engine/vxlscene/GroundTypes.js';
import type { WheelTerrainInfo } from 'engine/physics/RapierVehicle.js';

/**
 * VehicleWetFX — tyre water VAPOR and fading water TRAILS on wet surfaces.
 * Part of the engine weather package: vehicles are discovered through the
 * RapierVehicle registry, so any vehicle in any rainy game gets both effects
 * with zero game code.
 *
 * VAPOR — GPU-resident particles, CPU emission (the rain-fidelity recipe; a
 * CPU-billboarded sprite pool reads as sparse popping blobs next to compute
 * rain, which is exactly the failure mode this replaces):
 *  - the CPU only writes SPAWN RECORDS (position, velocity, birth, seed) into
 *    an instanced ring buffer as wheels emit;
 *  - the vertex shader integrates ballistic motion with pseudo-drag, sizes
 *    and VELOCITY-STRETCHES each sprite (motion-elongated vapor, not round
 *    puffs), and the fragment shapes a soft procedural disc;
 *  - alpha follows a smooth sine envelope over each particle's life — nothing
 *    ever pops in or out of existence;
 *  - dual path per game/docs/renderer-backends.md: TSL node material on
 *    WebGPU, GLSL ShaderMaterial on WebGL, same math and constants.
 *
 * TRAILS — a translucent film on the asphalt that fades in seconds: per-wheel
 * ribbon strips with THREE vertex rows, alpha peaking on the tyre line and
 * zero at the edges (soft-edged water displacement, not a hard tape stripe).
 * The near-black overlay dims the streaked reflection beneath it, which is
 * how a real tyre line "dries" the water film.
 */

/** Structural slice of RapierVehicle the FX needs (keeps this module decoupled). */
export interface WetFxVehicle {
    getWheelTerrainInfo(): readonly WheelTerrainInfo[];
    getSpeed(): number;
    getLinearVelocity(): THREE.Vector3;
    isHibernating(): boolean;
}

export interface VehicleWetFXOptions {
    /**
     * Tyre spray/vapor. OFF while the wet road uses screen-space reflections.
     *
     * r185's per-attachment MRT blend modes (GameEnginePostFx) fixed the
     * catastrophic part: these transparent sprites used to OVERWRITE the
     * shared normal/metalness buffers instead of blending into them, so one
     * invisible sprite erased every reflection on screen. Now the damage is
     * proportional to accumulated alpha — but at this DENSITY (16k sprites up
     * to ~3 m across) that is still most of the screen, measured by toggling
     * the vapor mid-drive under `?ssrdebug=1`: reflections present without it,
     * largely gone with it. At ~60 sprites they survive completely.
     *
     * So the trade-off is density, and a dense fog-bank spray needs the VFX
     * moved into a pass rendered AFTER SSR composition (depth shared between
     * passes) to coexist with reflections at full strength.
     */
    vaporEnabled: boolean;
    /** Vapor particle pool (ring buffer; oldest recycled). */
    maxVaporParticles: number;
    /** Vapor spawns per wheel per second at full speed and wetness. */
    vaporRate: number;
    /** Vehicle speed (m/s) below which wheels stop emitting. */
    minSpeed: number;
    /** Wetness below which the whole system idles. */
    minWetness: number;
    /** Peak vapor sprite alpha (individual — the plume is many faint sprites). */
    vaporAlpha: number;
    /** Trail ribbon width (m) — roughly a tyre patch. */
    trailWidth: number;
    /** Trail segment spacing (m of wheel travel). */
    trailSpacing: number;
    /** Seconds a trail segment takes to fade out — "pretty quickly". */
    trailLife: number;
    /** Ring capacity per wheel (spacing × capacity = max trail length). */
    trailSegments: number;
    /** Peak trail alpha at the tyre line's center. */
    trailAlpha: number;
}

export const DEFAULT_VEHICLE_WET_FX_OPTIONS: VehicleWetFXOptions = {
    vaporEnabled: false,
    maxVaporParticles: 16384,
    vaporRate: 600,
    minSpeed: 3.5,
    minWetness: 0.3,
    // MIST, not particles: MANY small spawns that BALLOON while their alpha
    // collapses — expanding, dissolving vapor. The crowd carries the cloud;
    // an individual sprite is a faint puff.
    vaporAlpha: 0.014,
    trailWidth: 0.32,
    trailSpacing: 0.4,
    trailLife: 2.2,
    trailSegments: 160,
    trailAlpha: 0.3,
};

// Shared vapor motion/shape constants (both shader backends read these).
// Fog-bank tuning: LARGE overlapping sprites, long-ish lives, mild stretch —
// small crisp sprites always read as countable particles, never as mist.
const VAPOR_GRAVITY = 2.2;      // m/s² downward — mist settles, it doesn't fall
const VAPOR_DRAG = 3.0;         // pseudo-drag: v(t) = v0 / (1 + DRAG·t)
const VAPOR_LIFE_MIN = 0.55;
const VAPOR_LIFE_SPREAD = 0.45;
// Expansion-dissolve: born tiny and dense, ballooning ~30× while the alpha
// envelope collapses — the visible phase is the small/mid range, the large
// end sizes are already nearly transparent.
const VAPOR_SIZE_START = 0.08;
const VAPOR_SIZE_END = 2.6;
const VAPOR_GROWTH_POW = 0.7;   // ease-out growth: most of the ballooning happens early
const VAPOR_STRETCH = 0.04;     // extra length per m/s of particle speed
/** Sprite centers never sink below ground + this fraction of their size — the
 *  mist HUGS the road instead of slicing into it with a hard clip edge. */
const VAPOR_GROUND_HUG = 0.42;
/**
 * Near-camera fade (metres). A sprite grows to ~3 m across and the chase
 * camera passes within a couple of metres of the plume, so an un-faded sprite
 * can blanket the ENTIRE screen while still looking almost invisible — and
 * whatever it covers, it also writes into the shared normal/metalness
 * attachments the SSR pass reads. Fading sprites out as they approach the
 * near plane is the standard soft-particle guard and is what keeps the road's
 * reflections alive while spray is up.
 */
const VAPOR_NEAR_FADE_START = 0.8;
const VAPOR_NEAR_FADE_FULL = 3.5;

/** Water spray belongs to PAVED surfaces — dirt and grass don't throw white
 *  mist (they'd throw mud, a different effect). Same gate for the trails. */
const PAVED_GROUND = new Set<number>([
    GROUND_TYPE.asphalt, GROUND_TYPE.cobble, GROUND_TYPE.brick,
    GROUND_TYPE.sidewalk, GROUND_TYPE.pavers,
]);

// ── Trail ribbon (one per vehicle wheel, three vertex rows: L / center / R) ──

class TrailRibbon {
    readonly mesh: THREE.Mesh;
    private readonly positions: Float32Array;
    private readonly colors: Float32Array;
    private readonly births: Float32Array;
    private readonly geometry: THREE.BufferGeometry;
    private head = 0;
    private count = 0;
    private readonly lastEmit = new THREE.Vector3(Infinity, Infinity, Infinity);
    private breakNext = true;
    /** Frames since a wheel last claimed this ribbon — prunes removed vehicles. */
    idleFrames = 0;
    /** Previous frame's contact for vapor-emission interpolation (spawns are
     *  distributed along the wheel's travel — a per-frame point emitter turns
     *  into a dotted line at speed). */
    readonly sprayAnchor = new THREE.Vector3();
    sprayAnchorValid = false;

    constructor(
        private readonly opts: VehicleWetFXOptions,
        material: THREE.Material,
    ) {
        const cap = opts.trailSegments;
        this.positions = new Float32Array(cap * 3 * 3);
        this.colors = new Float32Array(cap * 3 * 4);
        this.births = new Float32Array(cap).fill(-Infinity);
        this.geometry = new THREE.BufferGeometry();
        this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
        // Ribbons lie flat on the road, so every vertex normal is world UP —
        // the same normal the road writes, which keeps the shared SSR normal
        // buffer intact under the trail. Omitting this attribute entirely
        // (as this geometry first did) leaves `normalView` undefined in the
        // scene pass's MRT and kills reflections across the whole screen.
        const upNormals = new Float32Array(cap * 3 * 3);
        for (let i = 1; i < upNormals.length; i += 3) upNormals[i] = 1;
        this.geometry.setAttribute('normal', new THREE.BufferAttribute(upNormals, 3));
        // Static index: 4 triangles between consecutive segments' three rows.
        // Ring-wrap and strip-break seams are hidden by zero-alpha segments.
        const indices: number[] = [];
        for (let s = 0; s < cap - 1; s++) {
            const l0 = s * 3, c0 = s * 3 + 1, r0 = s * 3 + 2;
            const l1 = s * 3 + 3, c1 = s * 3 + 4, r1 = s * 3 + 5;
            indices.push(l0, c0, l1, c0, c1, l1, c0, r0, c1, r0, r1, c1);
        }
        this.geometry.setIndex(indices);
        this.mesh = new THREE.Mesh(this.geometry, material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 1;
        this.mesh.name = 'WetTireTrail';
    }

    breakStrip(): void {
        this.breakNext = true;
    }

    emit(contact: THREE.Vector3, now: number): void {
        const jump = this.lastEmit.distanceTo(contact);
        if (jump < this.opts.trailSpacing) return;
        if (jump > 3) this.breakNext = true; // teleport/respawn — never bridge it

        const dirX = contact.x - this.lastEmit.x;
        const dirZ = contact.z - this.lastEmit.z;
        const len = Math.hypot(dirX, dirZ) || 1;
        const halfW = this.opts.trailWidth / 2;
        const sideX = (-dirZ / len) * halfW;
        const sideZ = (dirX / len) * halfW;

        const s = this.head;
        this.head = (this.head + 1) % this.opts.trailSegments;
        this.count = Math.min(this.count + 1, this.opts.trailSegments);
        const p = s * 9;
        const y = contact.y + 0.03;
        this.positions[p] = contact.x - sideX;
        this.positions[p + 1] = y;
        this.positions[p + 2] = contact.z - sideZ;
        this.positions[p + 3] = contact.x;
        this.positions[p + 4] = y;
        this.positions[p + 5] = contact.z;
        this.positions[p + 6] = contact.x + sideX;
        this.positions[p + 7] = y;
        this.positions[p + 8] = contact.z + sideZ;
        this.births[s] = this.breakNext ? -Infinity : now;
        this.breakNext = false;
        this.lastEmit.copy(contact);
        (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }

    /** Refresh per-vertex alpha from segment ages. Returns true while visible. */
    updateFade(now: number, wetness: number): boolean {
        if (this.count === 0) return false;
        const cap = this.opts.trailSegments;
        const life = this.opts.trailLife;
        const peak = this.opts.trailAlpha * wetness;
        let visible = false;
        for (let s = 0; s < cap; s++) {
            const age = now - this.births[s]!;
            let a = 0;
            if (age >= 0 && age < life) {
                const u = age / life;
                // Quick fill, then a smooth dry-out.
                a = peak * Math.min(1, u * 8 + 0.35) * (1 - u);
                visible = true;
            }
            const c = s * 12;
            // Edges transparent, center carries the line — soft film, no stripe.
            this.colors[c] = 1; this.colors[c + 1] = 1; this.colors[c + 2] = 1; this.colors[c + 3] = 0;
            this.colors[c + 4] = 1; this.colors[c + 5] = 1; this.colors[c + 6] = 1; this.colors[c + 7] = a;
            this.colors[c + 8] = 1; this.colors[c + 9] = 1; this.colors[c + 10] = 1; this.colors[c + 11] = 0;
        }
        (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
        return visible;
    }

    dispose(scene: THREE.Scene): void {
        scene.remove(this.mesh);
        this.geometry.dispose();
    }
}

// ── Vapor: GPU-resident particles, CPU emission ──────────────────────────────

interface VaporHandle {
    mesh: THREE.Mesh;
    setTime(seconds: number): void;
    setStrength(strength: number): void;
    dispose(): void;
}

function createVaporMaterialAndMesh(opts: VehicleWetFXOptions, geometry: THREE.InstancedBufferGeometry): VaporHandle {
    if (isWebGpuActive()) {
        const timeU = uniform(0);
        const strengthU = uniform(1);
        const material = new MeshBasicNodeMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });

        // The attribute() typing doesn't narrow from the type string — assert
        // the node arity the shader math needs.
        const p0 = attribute('aP0', 'vec3') as unknown as ReturnType<typeof vec3>;
        const v0 = attribute('aV0', 'vec3') as unknown as ReturnType<typeof vec3>;
        const birth = attribute('aBirth', 'float') as unknown as ReturnType<typeof float>;
        const seed = attribute('aSeed', 'float') as unknown as ReturnType<typeof float>;
        const ground = attribute('aGround', 'float') as unknown as ReturnType<typeof float>;

        const t = timeU.sub(birth).max(0);
        const lifespan = float(VAPOR_LIFE_MIN).add(seed.mul(VAPOR_LIFE_SPREAD));
        const u01 = clamp(t.div(lifespan), 0, 1);

        // Pseudo-drag ballistics: v(t) = v0/(1+kt)  ⇒  p(t) = p0 + v0·ln(1+kt)/k + ½gt².
        const damp = t.mul(VAPOR_DRAG).add(1);
        const size = float(VAPOR_SIZE_START)
            .add(u01.pow(VAPOR_GROWTH_POW).mul(VAPOR_SIZE_END - VAPOR_SIZE_START))
            .mul(seed.mul(0.6).add(0.7));
        const rawPos = p0
            .add(v0.mul(log(damp).div(VAPOR_DRAG)))
            .add(vec3(0, -0.5 * VAPOR_GRAVITY, 0).mul(t.mul(t)));
        // Ground hug: never let a sprite's center sink low enough to slice the
        // road plane — the mist settles ONTO the asphalt, no hard clip edges.
        const pos = vec3(rawPos.x, rawPos.y.max(ground.add(size.mul(VAPOR_GROUND_HUG))), rawPos.z);
        const velNow = v0.div(damp).add(vec3(0, -VAPOR_GRAVITY, 0).mul(t));

        // Velocity-stretched billboard around the motion axis.
        const axis = normalize(velNow.add(vec3(0, 0.6, 0)));
        const toCam = cameraPosition.sub(pos);
        const right = normalize(cross(axis, toCam));
        const stretch = velNow.length().mul(VAPOR_STRETCH).add(1).min(1.6);
        const corner = pos
            .add(right.mul(positionGeometry.x.mul(size)))
            .add(axis.mul(positionGeometry.y.mul(size).mul(stretch)));
        material.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(corner, 1));

        // Gaussian-soft disc — no visible rim, contributions melt together.
        const disc = smoothstep(0.5, 0.0, uv().sub(0.5).length()).pow(2.2);
        // Early peak, fast dissolve: alpha collapses while the sprite balloons.
        const envelope = smoothstep(0.0, 0.08, u01).mul(float(1).sub(u01).pow(1.8));
        material.colorNode = vec3(0.86, 0.92, 0.97);
        const nearFade = smoothstep(VAPOR_NEAR_FADE_START, VAPOR_NEAR_FADE_FULL, positionView.length());
        material.opacityNode = disc.mul(envelope).mul(opts.vaporAlpha).mul(strengthU).mul(nearFade);

        const mesh = new THREE.Mesh(geometry, material);
        return {
            mesh,
            setTime: (s) => { timeU.value = s; },
            setStrength: (s) => { strengthU.value = s; },
            dispose: () => material.dispose(),
        };
    }

    const uniforms = {
        uTime: { value: 0 },
        uStrength: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
            uniform float uTime;
            attribute vec3 aP0;
            attribute vec3 aV0;
            attribute float aBirth;
            attribute float aSeed;
            attribute float aGround;
            varying vec2 vUv;
            varying float vEnvelope;
            void main() {
                vUv = uv;
                float t = max(uTime - aBirth, 0.0);
                float lifespan = ${VAPOR_LIFE_MIN.toFixed(2)} + aSeed * ${VAPOR_LIFE_SPREAD.toFixed(2)};
                float u01 = clamp(t / lifespan, 0.0, 1.0);
                vEnvelope = smoothstep(0.0, 0.08, u01) * pow(1.0 - u01, 1.8);

                float damp = 1.0 + t * ${VAPOR_DRAG.toFixed(1)};
                float size = (${VAPOR_SIZE_START.toFixed(2)} + pow(u01, ${VAPOR_GROWTH_POW.toFixed(2)}) * ${(VAPOR_SIZE_END - VAPOR_SIZE_START).toFixed(2)})
                    * (0.7 + aSeed * 0.6);
                vec3 p = aP0 + aV0 * (log(damp) / ${VAPOR_DRAG.toFixed(1)})
                    + vec3(0.0, ${(-0.5 * VAPOR_GRAVITY).toFixed(2)}, 0.0) * t * t;
                p.y = max(p.y, aGround + size * ${VAPOR_GROUND_HUG.toFixed(2)});
                vec3 velNow = aV0 / damp + vec3(0.0, ${(-VAPOR_GRAVITY).toFixed(1)}, 0.0) * t;

                vec3 axis = normalize(velNow + vec3(0.0, 0.6, 0.0));
                vec3 toCam = cameraPosition - p;
                vec3 rightV = normalize(cross(axis, toCam));
                float stretch = min(1.0 + length(velNow) * ${VAPOR_STRETCH.toFixed(2)}, 1.6);
                vec3 corner = p + rightV * (position.x * size) + axis * (position.y * size * stretch);
                // Near-camera fade — see VAPOR_NEAR_FADE_START.
                vEnvelope *= smoothstep(${VAPOR_NEAR_FADE_START.toFixed(2)}, ${VAPOR_NEAR_FADE_FULL.toFixed(2)}, length(corner - cameraPosition));
                gl_Position = projectionMatrix * viewMatrix * vec4(corner, 1.0);
            }
        `,
        fragmentShader: /* glsl */ `
            uniform float uStrength;
            varying vec2 vUv;
            varying float vEnvelope;
            void main() {
                float disc = pow(smoothstep(0.5, 0.0, length(vUv - 0.5)), 2.2);
                gl_FragColor = vec4(vec3(0.86, 0.92, 0.97), disc * vEnvelope * uStrength * ${opts.vaporAlpha.toFixed(3)});
            }
        `,
    });

    const mesh = new THREE.Mesh(geometry, material);
    return {
        mesh,
        setTime: (s) => { uniforms.uTime.value = s; },
        setStrength: (s) => { uniforms.uStrength.value = s; },
        dispose: () => material.dispose(),
    };
}

// ── The system ───────────────────────────────────────────────────────────────

export class VehicleWetFX {
    private readonly scene: THREE.Scene;
    private readonly opts: VehicleWetFXOptions;

    /** Null while `vaporEnabled` is false — nothing is allocated or drawn. */
    private readonly vapor: VaporHandle | null = null;
    private readonly vaporGeometry: THREE.InstancedBufferGeometry | null = null;
    private readonly aP0: THREE.InstancedBufferAttribute | null = null;
    private readonly aV0: THREE.InstancedBufferAttribute | null = null;
    private readonly aBirth: THREE.InstancedBufferAttribute | null = null;
    private readonly aGround: THREE.InstancedBufferAttribute | null = null;
    private vaporCursor = 0;
    private emitCarry = 0;

    private readonly trailMaterial: THREE.MeshBasicMaterial;
    private readonly trails = new Map<object, TrailRibbon[]>();

    private readonly tmpVel = new THREE.Vector3();

    constructor(scene: THREE.Scene, opts: VehicleWetFXOptions) {
        this.scene = scene;
        this.opts = opts;

        if (opts.vaporEnabled) {
            const n = opts.maxVaporParticles;
            const quad = new THREE.PlaneGeometry(1, 1);
            const geometry = new THREE.InstancedBufferGeometry();
            geometry.index = quad.index;
            geometry.setAttribute('position', quad.getAttribute('position'));
            geometry.setAttribute('uv', quad.getAttribute('uv'));
            // MANDATORY, even though this material never uses normals for
            // shading: the scene pass writes `normal: normalView` into its MRT
            // for SSR, and a geometry without a `normal` attribute makes that
            // output undefined ("THREE.TSL: Vertex attribute normal not found
            // on geometry") — which corrupts the shared normal buffer and
            // takes the WHOLE screen's reflections down, not just these pixels.
            geometry.setAttribute('normal', quad.getAttribute('normal'));
            const aP0 = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
            const aV0 = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
            const aBirth = new THREE.InstancedBufferAttribute(new Float32Array(n).fill(-1e6), 1);
            const aSeed = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
            const aGround = new THREE.InstancedBufferAttribute(new Float32Array(n).fill(-1e6), 1);
            for (let i = 0; i < n; i++) aSeed.setX(i, Math.random());
            aP0.setUsage(THREE.DynamicDrawUsage);
            aV0.setUsage(THREE.DynamicDrawUsage);
            aBirth.setUsage(THREE.DynamicDrawUsage);
            aGround.setUsage(THREE.DynamicDrawUsage);
            geometry.setAttribute('aP0', aP0);
            geometry.setAttribute('aV0', aV0);
            geometry.setAttribute('aBirth', aBirth);
            geometry.setAttribute('aSeed', aSeed);
            geometry.setAttribute('aGround', aGround);
            geometry.instanceCount = n;
            this.vaporGeometry = geometry;
            this.aP0 = aP0;
            this.aV0 = aV0;
            this.aBirth = aBirth;
            this.aGround = aGround;

            this.vapor = createVaporMaterialAndMesh(opts, geometry);
            this.vapor.mesh.name = 'WetTireVapor';
            this.vapor.mesh.frustumCulled = false;
            this.vapor.mesh.renderOrder = 2;
            scene.add(this.vapor.mesh);
        }

        // Near-black translucent film; per-vertex RGBA carries the fade and
        // the soft cross-section (edges at zero alpha).
        this.trailMaterial = new THREE.MeshBasicMaterial({
            color: 0x14181c,
            transparent: true,
            vertexColors: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
            fog: false,
        });
    }

    /** Advance emission + trail fading. `now` is clock time (ambience convention). */
    update(
        deltaTime: number,
        now: number,
        wetness: number,
        vehicles: readonly WetFxVehicle[],
    ): void {
        this.vapor?.setTime(now);
        this.vapor?.setStrength(Math.min(1, wetness * 1.3));

        if (wetness >= this.opts.minWetness) {
            let emitted = false;
            for (const vehicle of vehicles) {
                if (vehicle.isHibernating()) continue;
                const speed = vehicle.getSpeed();
                const wheels = vehicle.getWheelTerrainInfo();
                const ribbons = this.ribbonsFor(vehicle, wheels.length);
                for (let w = 0; w < wheels.length; w++) {
                    const info = wheels[w]!;
                    const ribbon = ribbons[w]!;
                    ribbon.idleFrames = 0;
                    // Paved surfaces only: grass and dirt don't throw white
                    // water mist or leave water-film trails.
                    const paved = PAVED_GROUND.has(info.groundType);
                    if (!info.inContact || speed < this.opts.minSpeed || !paved) {
                        ribbon.breakStrip();
                        ribbon.sprayAnchorValid = false;
                        continue;
                    }
                    ribbon.emit(info.contactPosition, now);
                    if (this.emitVapor(vehicle, ribbon, info, speed, wetness, now, deltaTime)) {
                        emitted = true;
                    }
                }
            }
            if (emitted && this.aP0 && this.aV0 && this.aBirth && this.aGround) {
                this.aP0.needsUpdate = true;
                this.aV0.needsUpdate = true;
                this.aBirth.needsUpdate = true;
                this.aGround.needsUpdate = true;
            }
        }

        for (const [key, ribbons] of this.trails) {
            let anyVisible = false;
            for (const ribbon of ribbons) {
                ribbon.idleFrames++;
                if (ribbon.updateFade(now, wetness)) anyVisible = true;
            }
            if (!anyVisible && ribbons[0] && ribbons[0].idleFrames > 120) {
                for (const ribbon of ribbons) ribbon.dispose(this.scene);
                this.trails.delete(key);
            }
        }
    }

    /** Write spawn records for one wheel this frame. Returns true if any were written. */
    private emitVapor(
        vehicle: WetFxVehicle,
        ribbon: TrailRibbon,
        info: WheelTerrainInfo,
        speed: number,
        wetness: number,
        now: number,
        deltaTime: number,
    ): boolean {
        const aP0 = this.aP0, aV0 = this.aV0, aBirth = this.aBirth, aGround = this.aGround;
        if (!aP0 || !aV0 || !aBirth || !aGround) return false; // vapor disabled

        const contact = info.contactPosition;
        // First paved frame (or a teleport): anchor here, emit from next frame.
        if (!ribbon.sprayAnchorValid || ribbon.sprayAnchor.distanceTo(contact) > 4) {
            ribbon.sprayAnchor.copy(contact);
            ribbon.sprayAnchorValid = true;
            return false;
        }

        const speedFactor = Math.min(1, speed / 26);
        const drivenBoost = info.isDriven ? 1 : 0.65;
        this.emitCarry += this.opts.vaporRate * speedFactor * wetness * drivenBoost * deltaTime;
        let toEmit = Math.floor(this.emitCarry);
        this.emitCarry -= toEmit;
        if (toEmit <= 0) return false;

        this.tmpVel.copy(vehicle.getLinearVelocity());
        const from = ribbon.sprayAnchor;
        const count = toEmit;
        for (let k = 0; toEmit > 0; toEmit--, k++) {
            const i = this.vaporCursor;
            this.vaporCursor = (this.vaporCursor + 1) % this.opts.maxVaporParticles;
            // Distribute this frame's spawns ALONG the wheel's travel — point
            // emission turns into a dotted line at speed (0.4 m/frame at race
            // pace), and dots can never read as mist.
            const f = (k + Math.random()) / count;
            const bx = from.x + (contact.x - from.x) * f;
            const by = from.y + (contact.y - from.y) * f;
            const bz = from.z + (contact.z - from.z) * f;
            aP0.setXYZ(
                i,
                bx + (Math.random() - 0.5) * 0.4,
                by + 0.3 + Math.random() * 0.25,
                bz + (Math.random() - 0.5) * 0.4,
            );
            // Vapor leaves with a FRACTION of the car's velocity (the car
            // outruns its own plume) plus a gentle rise and mild scatter — the
            // cloud must drift coherently, not scatter into confetti.
            const inherit = 0.15 + Math.random() * 0.3;
            aV0.setXYZ(
                i,
                this.tmpVel.x * inherit + (Math.random() - 0.5) * 1.1,
                0.8 + Math.random() * 1.4 + speed * 0.04,
                this.tmpVel.z * inherit + (Math.random() - 0.5) * 1.1,
            );
            aBirth.setX(i, now);
            aGround.setX(i, by);
        }
        ribbon.sprayAnchor.copy(contact);
        return true;
    }

    private ribbonsFor(vehicle: WetFxVehicle, wheelCount: number): TrailRibbon[] {
        let ribbons = this.trails.get(vehicle);
        if (!ribbons || ribbons.length !== wheelCount) {
            if (ribbons) for (const r of ribbons) r.dispose(this.scene);
            ribbons = [];
            for (let w = 0; w < wheelCount; w++) {
                const ribbon = new TrailRibbon(this.opts, this.trailMaterial);
                this.scene.add(ribbon.mesh);
                ribbons.push(ribbon);
            }
            this.trails.set(vehicle, ribbons);
        }
        return ribbons;
    }

    dispose(): void {
        if (this.vapor) {
            this.scene.remove(this.vapor.mesh);
            this.vaporGeometry?.dispose();
            this.vapor.dispose();
        }
        for (const ribbons of this.trails.values()) {
            for (const ribbon of ribbons) ribbon.dispose(this.scene);
        }
        this.trails.clear();
        this.trailMaterial.dispose();
    }
}
