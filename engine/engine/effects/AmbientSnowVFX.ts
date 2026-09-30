import * as THREE from 'three';

/**
 * AmbientSnowVFX — a lightweight, pooled falling-particle weather effect
 * (snow by default; rain-like or ash-like falls via the wind/speed/sprite
 * options).
 *
 * Renders a capped set of small billboarded sprites that drift and fall
 * inside a cylinder centred on the player/camera. When a flake falls below
 * ground level or leaves the radius around the player it is recycled to a
 * random point inside the column, so it always looks like it is snowing
 * everywhere the player goes.
 *
 * ## Rendering: billboarded soft sprites, NOT `THREE.Points`, NOT lit solids
 *
 * - `THREE.Points` does NOT render on the WebGPU backend: WGSL has no
 *   `gl_PointSize`, so `WebGPURenderer` draws point clouds as fixed 1-pixel
 *   dots regardless of the material's `size` / `sizeAttenuation` (in three
 *   r183 `PointsNodeMaterial.setupVertex` only takes its sized-sprite path for
 *   non-`isPoints` objects). The flakes vanish.
 * - Lit solid instances (cubes/octahedra à la `SnowSprayVFX`) DO render on
 *   both backends, but read as tumbling grey rocks: a lit solid shades dark on
 *   the light-away side, while real snowflakes are translucent and scatter
 *   light — they never have a dark backside.
 *
 * So the flakes are a single `InstancedMesh` of camera-billboarded quads with
 * an UNLIT `MeshBasicMaterial` and a soft radial-gradient sprite texture —
 * translucent, uniformly bright from every angle, soft-edged. Instance
 * matrices are rewritten every frame anyway (the flakes move), so the
 * billboard is free: every instance's rotation is the camera's world
 * quaternion (cached from `onBeforeRender`, which both backends invoke) plus a
 * slow per-flake roll for variety. No custom shader → no TSL/GLSL dual path.
 *
 * Usage:
 *   const snow = new AmbientSnowVFX(scene, { density: 0.6, wind: new THREE.Vector3(4, 0, 0) });
 *   // each frame:
 *   snow.update(deltaTime, playerWorldPosition);
 *   // live weather changes:
 *   snow.setDensity(1.0);                          // blizzard
 *   snow.setWind(new THREE.Vector3(8, 0, 2));      // storm gust — slants the fall
 *   snow.setFallSpeed(5);
 *   snow.setTexture('assets/images/petal.png');    // custom sprite
 *   // on teardown:
 *   snow.dispose();
 */
export interface AmbientSnowVFXOptions {
    /** Pool size — hard cap on snowflakes (kept small for perf). */
    maxParticles: number;
    /** Fraction of the pool that is active, 0..1. Runtime-tunable via `setDensity`. */
    density: number;
    /** Horizontal radius around the player that flakes occupy (meters). */
    radius: number;
    /** Height of the snow column above the player (meters). */
    columnHeight: number;
    /** How far below the player a flake falls before recycling (meters). */
    groundDrop: number;
    /** Average fall speed (m/s, straight down). Runtime-tunable via `setFallSpeed`. */
    fallSpeed: number;
    /**
     * Constant world-space wind velocity (m/s) added to every flake — slants
     * the fall direction (X/Z push sideways; a positive Y counteracts the
     * fall). Runtime-tunable via `setWind`.
     */
    wind: THREE.Vector3;
    /** Random per-flake horizontal wander magnitude (m/s), on top of the wind. */
    driftSpeed: number;
    /** Flake sprite size (meters, quad edge before per-flake jitter). */
    flakeSize: number;
    /** Flake tint color (multiplies the sprite). */
    color: THREE.ColorRepresentation;
    /** Opacity of the flakes. */
    opacity: number;
    /**
     * Flake sprite: a ready `THREE.Texture`, a URL string to load (transparent
     * PNG recommended), or null for the built-in soft round flake. Runtime-
     * swappable via `setTexture`.
     */
    texture: THREE.Texture | string | null;
}

export const DEFAULT_AMBIENT_SNOW_VFX_OPTIONS: AmbientSnowVFXOptions = {
    maxParticles: 1400,
    density: 1.0,
    radius: 45,
    columnHeight: 35,
    groundDrop: 6,
    fallSpeed: 3.0,
    wind: new THREE.Vector3(0, 0, 0),
    driftSpeed: 1.2,
    flakeSize: 0.35,
    color: 0xffffff,
    opacity: 0.85,
    texture: null,
};

const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class AmbientSnowVFX {
    private readonly scene: THREE.Scene;
    private readonly opts: AmbientSnowVFXOptions;

    private readonly mesh: THREE.InstancedMesh;
    private readonly material: THREE.MeshBasicMaterial;
    private texture: THREE.Texture;
    /** Whether we created `texture` (procedural / URL-loaded) and must dispose it. */
    private ownsTexture = false;

    // Live weather state (mutable copies of the corresponding options).
    private fallSpeed: number;
    private readonly wind = new THREE.Vector3();
    private activeCount = 0;

    // Per-flake simulation state (one entry per particle).
    private readonly positions: Float32Array; // xyz per flake
    private readonly fallJitter: Float32Array; // per-flake fall-speed multiplier
    private readonly driftX: Float32Array;
    private readonly driftZ: Float32Array;
    private readonly phase: Float32Array;
    private readonly sizeJitter: Float32Array; // per-flake size multiplier
    private readonly roll: Float32Array; // per-flake roll speed (rad/s)

    private readonly center = new THREE.Vector3();
    private initialized = false;

    // Camera world orientation, captured each render via onBeforeRender (the
    // only camera access we have — the effect is constructed with just the
    // scene). Used to billboard next frame's matrices; flakes are radially
    // symmetric sprites, so one frame of billboard lag is invisible.
    private readonly cameraQuat = new THREE.Quaternion();

    // Scratch — no per-frame allocation in the hot loop.
    private readonly tmpPos = new THREE.Vector3();
    private readonly tmpQuat = new THREE.Quaternion();
    private readonly tmpRoll = new THREE.Quaternion();
    private readonly tmpScale = new THREE.Vector3();
    private readonly tmpMatrix = new THREE.Matrix4();

    constructor(scene: THREE.Scene, options: Partial<AmbientSnowVFXOptions> = {}) {
        this.scene = scene;
        this.opts = { ...DEFAULT_AMBIENT_SNOW_VFX_OPTIONS, ...options };

        this.fallSpeed = this.opts.fallSpeed;
        this.wind.copy(this.opts.wind);

        const n = this.opts.maxParticles;
        this.positions = new Float32Array(n * 3);
        this.fallJitter = new Float32Array(n);
        this.driftX = new Float32Array(n);
        this.driftZ = new Float32Array(n);
        this.phase = new Float32Array(n);
        this.sizeJitter = new Float32Array(n);
        this.roll = new Float32Array(n);

        // Seed per-flake constants; positions are seeded on the first update()
        // once we know the player's location.
        for (let i = 0; i < n; i++) {
            this.seedFlake(i);
        }

        // Unit quad, billboarded per frame via the instance matrices. UNLIT
        // material: snowflakes are translucent and scatter light, so they must
        // stay uniformly bright from every angle (a lit solid would shade dark
        // on the light-away side and read as grit, not snow).
        const geometry = new THREE.PlaneGeometry(1, 1);
        this.texture = this.resolveTexture(this.opts.texture);
        this.material = new THREE.MeshBasicMaterial({
            color: this.opts.color,
            map: this.texture,
            transparent: true,
            opacity: this.opts.opacity,
            depthWrite: false,
            // DoubleSide so a stale billboard orientation (first frame, hard
            // camera cuts) can never make flakes vanish edge-on.
            side: THREE.DoubleSide,
            // Snow sits near the player; don't let distance fog wash it out.
            fog: false,
        });
        this.mesh = new THREE.InstancedMesh(geometry, this.material, n);
        this.mesh.name = 'AmbientSnowVFX';
        this.mesh.frustumCulled = false;
        this.mesh.castShadow = false;
        this.mesh.receiveShadow = false;
        // Render after opaque geometry.
        this.mesh.renderOrder = 2;
        this.activeCount = this.densityToCount(this.opts.density);
        this.mesh.count = this.activeCount;
        // Capture the render camera's world orientation for billboarding —
        // both WebGLRenderer and WebGPURenderer invoke onBeforeRender with the
        // camera actually rendering this pass.
        this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
            camera.getWorldQuaternion(this.cameraQuat);
        };
        this.scene.add(this.mesh);
    }

    // ── Runtime weather controls ────────────────────────────────────────────

    /** Set the active flake fraction (0..1 of `maxParticles`). 0 stops the snow. */
    setDensity(density: number): void {
        const next = this.densityToCount(density);
        // Newly activated flakes carry stale positions from when the pool was
        // larger (or the initial zeros) — scatter them into the current volume
        // so a density ramp-up fills in instantly and evenly.
        if (this.initialized) {
            for (let i = this.activeCount; i < next; i++) {
                this.respawnFlake(i);
            }
        }
        this.activeCount = next;
        this.mesh.count = next;
    }

    /** Set the world-space wind velocity (m/s) — slants the fall direction. */
    setWind(wind: THREE.Vector3): void {
        this.wind.copy(wind);
    }

    /** Set the average downward fall speed (m/s). */
    setFallSpeed(fallSpeed: number): void {
        this.fallSpeed = fallSpeed;
    }

    /**
     * Swap the flake sprite: a ready `THREE.Texture` or a URL to load
     * (transparent PNG recommended — the alpha channel shapes the flake).
     */
    setTexture(texture: THREE.Texture | string): void {
        const ownedPrevious = this.ownsTexture ? this.texture : null;
        this.texture = this.resolveTexture(texture);
        this.material.map = this.texture;
        this.material.needsUpdate = true;
        ownedPrevious?.dispose();
    }

    /**
     * Advance the snow. Call once per frame.
     * @param deltaTime seconds since last frame
     * @param center    world position to centre the snow column on (player/camera)
     */
    update(deltaTime: number, center: THREE.Vector3): void {
        const n = this.activeCount;
        const pos = this.positions;
        const dt = Math.min(deltaTime, 0.1); // clamp to avoid teleporting after a stall

        // Detect a large recenter jump (or the very first frame) BEFORE adopting
        // the new center: when the column teleports a long way (fast descent /
        // respawn / lead-offset snap) we scatter every flake uniformly through
        // the new box so it reads as full snow this very frame instead of
        // slowly refilling from a single plane.
        const jumpThreshold = this.opts.radius; // meters
        const bigJump =
            !this.initialized ||
            this.center.distanceTo(center) > jumpThreshold;

        this.center.copy(center);

        // bigJump already subsumes the !initialized case (see above).
        if (bigJump) {
            for (let i = 0; i < n; i++) {
                this.respawnFlake(i);
            }
            this.initialized = true;
            this.writeInstances();
            return;
        }

        const minY = this.center.y - this.opts.groundDrop;
        const maxY = this.center.y + this.opts.columnHeight;
        const r2 = this.opts.radius * this.opts.radius;
        const windX = this.wind.x;
        const windY = this.wind.y;
        const windZ = this.wind.z;

        for (let i = 0; i < n; i++) {
            const ix = i * 3;
            const newPhase = (this.phase[i] ?? 0) + dt;
            this.phase[i] = newPhase;
            const sway = Math.sin(newPhase * 1.5 + i) * 0.4;

            const px = (pos[ix] ?? 0) + ((this.driftX[i] ?? 0) + sway + windX) * dt;
            const py = (pos[ix + 1] ?? 0) + (windY - this.fallSpeed * (this.fallJitter[i] ?? 1)) * dt;
            const pz = (pos[ix + 2] ?? 0) + ((this.driftZ[i] ?? 0) + windZ) * dt;
            pos[ix] = px;
            pos[ix + 1] = py;
            pos[ix + 2] = pz;

            // Instant-fill wrap: test EVERY axis against the box bounds relative
            // to the (moving) center. A flake that is now outside the volume in
            // ANY direction — below the floor, above the top, or beyond the
            // horizontal radius (ahead / behind / left / right) — is teleported
            // back to a random point INSIDE the current box with a randomized
            // fall height. This keeps the column densely and evenly full no
            // matter how fast the center moves, so riding downhill at full speed
            // looks identical to standing still.
            const dx = px - this.center.x;
            const dz = pz - this.center.z;
            if (py < minY || py > maxY || dx * dx + dz * dz > r2) {
                this.respawnFlake(i);
            }
        }

        this.writeInstances();
    }

    /** Compose and upload every active flake's instance matrix (position + billboard + roll + size). */
    private writeInstances(): void {
        const n = this.activeCount;
        const pos = this.positions;
        const base = this.opts.flakeSize;
        for (let i = 0; i < n; i++) {
            const ix = i * 3;
            this.tmpPos.set(pos[ix] ?? 0, pos[ix + 1] ?? 0, pos[ix + 2] ?? 0);

            // Billboard: face the camera, plus a slow per-flake roll about the
            // view axis so the flakes don't all read as one static stamp.
            this.tmpRoll.setFromAxisAngle(Z_AXIS, (this.phase[i] ?? 0) * (this.roll[i] ?? 0));
            this.tmpQuat.copy(this.cameraQuat).multiply(this.tmpRoll);

            const s = base * (this.sizeJitter[i] ?? 1);
            this.tmpScale.set(s, s, s);
            this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
            this.mesh.setMatrixAt(i, this.tmpMatrix);
        }
        this.mesh.instanceMatrix.needsUpdate = true;
    }

    private densityToCount(density: number): number {
        const clamped = Math.min(1, Math.max(0, density));
        return Math.round(clamped * this.opts.maxParticles);
    }

    /** Seed the per-flake constants that don't change on respawn (roll, size). */
    private seedFlake(i: number): void {
        this.seedVelocity(i);
        this.sizeJitter[i] = 0.5 + Math.random() * 1.0;
        this.roll[i] = (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 1.2);
    }

    private seedVelocity(i: number): void {
        const o = this.opts;
        this.fallJitter[i] = 0.6 + Math.random() * 0.8;
        const ang = Math.random() * Math.PI * 2;
        const ds = o.driftSpeed * (0.3 + Math.random() * 0.7);
        this.driftX[i] = Math.cos(ang) * ds;
        this.driftZ[i] = Math.sin(ang) * ds;
        this.phase[i] = Math.random() * Math.PI * 2;
    }

    /**
     * Place flake i at a random point UNIFORMLY distributed throughout the
     * current box around the player: random horizontal position (area-uniform
     * via the sqrt radius) and a random fall height spanning the full column
     * (floor → top). Used for both initial seeding and recycling, so an
     * out-of-bounds flake instantly re-fills the volume anywhere — never just
     * trickling in from the top — keeping the snow uniformly dense at every
     * instant regardless of how fast the center moves.
     */
    private respawnFlake(i: number): void {
        const o = this.opts;
        const ix = i * 3;
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.sqrt(Math.random()) * o.radius;
        this.positions[ix] = this.center.x + Math.cos(ang) * rad;
        this.positions[ix + 2] = this.center.z + Math.sin(ang) * rad;
        // Randomized fall height across the full box (floor → top).
        this.positions[ix + 1] = this.center.y - o.groundDrop + Math.random() * (o.columnHeight + o.groundDrop);
        this.seedVelocity(i);
    }

    /** Turn the texture option into a live texture; sets `ownsTexture` accordingly. */
    private resolveTexture(source: THREE.Texture | string | null): THREE.Texture {
        if (source instanceof THREE.Texture) {
            this.ownsTexture = false;
            return source;
        }
        if (typeof source === 'string') {
            // Loader returns the texture immediately; the image streams in and
            // uploads when ready (flakes pop in — acceptable for weather).
            const tex = new THREE.TextureLoader().load(source);
            tex.colorSpace = THREE.SRGBColorSpace;
            this.ownsTexture = true;
            return tex;
        }
        this.ownsTexture = true;
        return AmbientSnowVFX.createFlakeTexture();
    }

    /**
     * Soft round flake sprite, built procedurally: an opaque-cored radial
     * gradient fading to transparent — the classic soft-disc snow sprite (a
     * bright core plus a wide soft halo reads as an out-of-focus flake).
     */
    private static createFlakeTexture(): THREE.Texture {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.4, 'rgba(255,255,255,0.85)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
        const tex = new THREE.CanvasTexture(canvas);
        tex.needsUpdate = true;
        return tex;
    }

    dispose(): void {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
        if (this.ownsTexture) this.texture.dispose();
        this.mesh.dispose();
    }
}
