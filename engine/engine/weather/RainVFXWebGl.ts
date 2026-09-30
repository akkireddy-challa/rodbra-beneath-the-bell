import * as THREE from 'three';

/**
 * WebGL fallback rain — deliberately cheaper than the WebGPU compute path
 * (game/docs/renderer-backends.md: both backends must work, they need not
 * match): a few thousand instanced streak quads whose positions are computed
 * ENTIRELY in the vertex shader (seed + time → wrapped position inside a
 * camera-following box, so per-frame CPU cost is a handful of uniform writes),
 * plus a small CPU-reseeded pool of expanding splash rings placed on the
 * terrain height under the camera.
 *
 * No compute, no collision texture: streaks pass through geometry (invisible
 * in practice at streak speeds) and splashes sample terrain height on the CPU
 * at reseed time. `THREE.Points` is never used — see AmbientSnowVFX's header.
 */
export interface RainVFXWebGlOptions {
    /** Instanced streak quads (draw count scales with intensity). */
    maxDrops: number;
    /** Horizontal half-extent of the camera-following rain box (m). */
    radius: number;
    /** Rain box height above the camera (m). */
    columnHeight: number;
    /** How far below the camera streaks survive (m). */
    groundDrop: number;
    /** Base fall speed (m/s); per-drop jitter spreads 0.75×..1.25×. */
    fallSpeed: number;
    streakWidth: number;
    streakLength: number;
    /** Streak alpha at full intensity (higher than the GPU path — fewer drops). */
    opacity: number;
    /** Splash ring pool size. */
    splashCount: number;
    /** Splash placement radius around the camera (m). */
    splashRadius: number;
    /** Splash ring diameter at full expansion (m). */
    splashSize: number;
}

export const DEFAULT_RAIN_VFX_WEBGL_OPTIONS: RainVFXWebGlOptions = {
    maxDrops: 3200,
    radius: 45,
    columnHeight: 24,
    groundDrop: 6,
    fallSpeed: 20,
    streakWidth: 0.035,
    streakLength: 1.2,
    opacity: 0.35,
    splashCount: 220,
    splashRadius: 24,
    splashSize: 0.6,
};

/** Splash cycles per second (each instance cycles independently, phase-offset). */
const SPLASH_RATE_HZ = 2.2;
/** Seconds between splash pool re-placements around the camera. */
const SPLASH_RESEED_S = 2.5;
/** Parking spot for splash instances with no ground under them. */
const HIDDEN_Y = -10000;

export class RainVFXWebGl {
    private readonly scene: THREE.Scene;
    private readonly opts: RainVFXWebGlOptions;

    private readonly rainMesh: THREE.InstancedMesh;
    private readonly rainMaterial: THREE.ShaderMaterial;
    private readonly splashMesh: THREE.InstancedMesh;
    private readonly splashMaterial: THREE.ShaderMaterial;

    private readonly rainUniforms = {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector2() },
        uOpacity: { value: 0 },
    };

    private readonly splashUniforms = {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
    };

    private reseedTimer = 0;
    private readonly tmpMatrix = new THREE.Matrix4();
    private readonly tmpPos = new THREE.Vector3();
    private readonly tmpScale = new THREE.Vector3();
    private readonly noRotation = new THREE.Quaternion();

    constructor(scene: THREE.Scene, opts: RainVFXWebGlOptions) {
        this.scene = scene;
        this.opts = opts;

        // ── Streaks ───────────────────────────────────────────────────────────
        const geo = new THREE.InstancedBufferGeometry();
        const quad = new THREE.PlaneGeometry(opts.streakWidth, opts.streakLength);
        geo.index = quad.index;
        geo.setAttribute('position', quad.getAttribute('position'));
        geo.setAttribute('uv', quad.getAttribute('uv'));
        const seeds = new Float32Array(opts.maxDrops * 3);
        const jitters = new Float32Array(opts.maxDrops);
        for (let i = 0; i < opts.maxDrops; i++) {
            seeds[i * 3] = Math.random();
            seeds[i * 3 + 1] = Math.random();
            seeds[i * 3 + 2] = Math.random();
            jitters[i] = Math.random();
        }
        geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
        geo.setAttribute('aJitter', new THREE.InstancedBufferAttribute(jitters, 1));

        const volX = opts.radius * 2;
        const volY = opts.columnHeight + opts.groundDrop;
        this.rainMaterial = new THREE.ShaderMaterial({
            uniforms: this.rainUniforms,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            vertexShader: /* glsl */ `
                uniform float uTime;
                uniform vec3 uCenter;
                uniform vec2 uWind;
                attribute vec3 aSeed;
                attribute float aJitter;
                varying vec2 vUv;
                varying float vFade;
                void main() {
                    vUv = uv;
                    float fall = ${opts.fallSpeed.toFixed(2)} * (0.75 + 0.5 * aJitter);
                    vec3 vol = vec3(${volX.toFixed(2)}, ${volY.toFixed(2)}, ${volX.toFixed(2)});
                    vec3 origin = uCenter - vec3(vol.x * 0.5, ${opts.groundDrop.toFixed(2)}, vol.z * 0.5);
                    vec3 disp = vec3(uWind.x, -fall, uWind.y) * uTime;
                    vec3 wp = mod(aSeed * vol + disp - origin, vol) + origin;
                    // Fade toward the wrap boundary — no visible "rain line".
                    vFade = 1.0 - smoothstep(${(opts.radius * 0.5).toFixed(2)}, ${(opts.radius * 0.95).toFixed(2)}, length(wp.xz - uCenter.xz));
                    // Streak lies along its true fall direction (wind slant),
                    // billboarded toward the camera around that axis.
                    vec3 axis = normalize(vec3(uWind.x, -fall, uWind.y));
                    vec3 toCam = cameraPosition - wp;
                    vec3 right = normalize(cross(axis, toCam));
                    vec3 corner = wp + right * position.x + axis * position.y;
                    gl_Position = projectionMatrix * viewMatrix * vec4(corner, 1.0);
                }
            `,
            fragmentShader: /* glsl */ `
                uniform float uOpacity;
                varying vec2 vUv;
                varying float vFade;
                void main() {
                    float core = smoothstep(1.0, 0.0, abs(vUv.x - 0.5) * 2.0);
                    float ends = smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.8, vUv.y);
                    gl_FragColor = vec4(vec3(0.75, 0.82, 0.92), core * ends * uOpacity * vFade);
                }
            `,
        });

        this.rainMesh = new THREE.InstancedMesh(geo, this.rainMaterial, opts.maxDrops);
        this.rainMesh.name = 'RainVFXStreaksWebGL';
        this.rainMesh.frustumCulled = false;
        this.rainMesh.renderOrder = 2;
        scene.add(this.rainMesh);

        // ── Splash rings ──────────────────────────────────────────────────────
        const ringGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
        const phases = new Float32Array(opts.splashCount);
        for (let i = 0; i < opts.splashCount; i++) phases[i] = Math.random();
        ringGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));

        this.splashMaterial = new THREE.ShaderMaterial({
            uniforms: this.splashUniforms,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            vertexShader: /* glsl */ `
                uniform float uTime;
                attribute float aPhase;
                varying vec2 vUv;
                varying float vT;
                void main() {
                    vUv = uv;
                    float t = fract(uTime * ${SPLASH_RATE_HZ.toFixed(2)} + aPhase);
                    vT = t;
                    vec3 p = position * mix(0.15, 1.0, pow(t, 0.45));
                    gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
                }
            `,
            fragmentShader: /* glsl */ `
                uniform float uOpacity;
                varying vec2 vUv;
                varying float vT;
                void main() {
                    float d = length(vUv - 0.5) * 2.0;
                    float ring = smoothstep(0.22, 0.0, abs(d - vT * 0.85));
                    float fade = pow(1.0 - vT, 1.5);
                    gl_FragColor = vec4(vec3(0.85, 0.9, 1.0), ring * fade * uOpacity);
                }
            `,
        });

        this.splashMesh = new THREE.InstancedMesh(ringGeo, this.splashMaterial, opts.splashCount);
        this.splashMesh.name = 'RainVFXSplashesWebGL';
        this.splashMesh.frustumCulled = false;
        this.splashMesh.renderOrder = 2;
        // Park everything until the first reseed finds ground.
        for (let i = 0; i < opts.splashCount; i++) {
            this.tmpMatrix.compose(
                this.tmpPos.set(0, HIDDEN_Y, 0),
                this.noRotation,
                this.tmpScale.setScalar(opts.splashSize),
            );
            this.splashMesh.setMatrixAt(i, this.tmpMatrix);
        }
        this.splashMesh.instanceMatrix.needsUpdate = true;
        scene.add(this.splashMesh);
    }

    setIntensity(intensity: number): void {
        const clamped = THREE.MathUtils.clamp(intensity, 0, 1);
        this.rainUniforms.uOpacity.value = this.opts.opacity * clamped;
        this.splashUniforms.uOpacity.value = 0.5 * clamped;
        this.rainMesh.count = Math.max(1, Math.round(this.opts.maxDrops * clamped));
        this.rainMesh.visible = clamped > 0.001;
        this.splashMesh.visible = clamped > 0.001;
    }

    /**
     * Per-frame state push + splash pool upkeep. `heightAt` returns the ground
     * height at a world XZ, or a non-finite value where there is none.
     */
    update(
        deltaTime: number,
        timeSeconds: number,
        center: THREE.Vector3,
        windX: number,
        windZ: number,
        heightAt: (x: number, z: number) => number,
    ): void {
        this.rainUniforms.uTime.value = timeSeconds;
        this.rainUniforms.uCenter.value.copy(center);
        this.rainUniforms.uWind.value.set(windX, windZ);
        this.splashUniforms.uTime.value = timeSeconds;

        this.reseedTimer -= deltaTime;
        if (this.reseedTimer <= 0) {
            this.reseedTimer = SPLASH_RESEED_S;
            this.reseedSplashes(center, heightAt);
        }
    }

    private reseedSplashes(center: THREE.Vector3, heightAt: (x: number, z: number) => number): void {
        const { splashCount, splashRadius, splashSize } = this.opts;
        for (let i = 0; i < splashCount; i++) {
            const ang = Math.random() * Math.PI * 2;
            const rad = Math.sqrt(Math.random()) * splashRadius;
            const x = center.x + Math.cos(ang) * rad;
            const z = center.z + Math.sin(ang) * rad;
            const y = heightAt(x, z);
            // Only keep splashes near the camera's own walking plane — a spot
            // 40 m below (over a cliff) or with no ground parks off-world.
            const usable = Number.isFinite(y) && Math.abs(y - center.y) < 25;
            this.tmpPos.set(x, usable ? y + 0.02 : HIDDEN_Y, z);
            this.tmpMatrix.compose(this.tmpPos, this.noRotation, this.tmpScale.setScalar(splashSize));
            this.splashMesh.setMatrixAt(i, this.tmpMatrix);
        }
        this.splashMesh.instanceMatrix.needsUpdate = true;
    }

    dispose(): void {
        this.scene.remove(this.rainMesh);
        this.scene.remove(this.splashMesh);
        this.rainMesh.geometry.dispose();
        this.splashMesh.geometry.dispose();
        this.rainMaterial.dispose();
        this.splashMaterial.dispose();
        this.rainMesh.dispose();
        this.splashMesh.dispose();
    }
}
