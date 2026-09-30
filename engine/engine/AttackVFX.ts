import * as THREE from 'three';
import { ensureNormalAttribute } from 'engine/utils/ensureNormalAttribute.js';
import { EffectPool, type PooledEffect } from 'engine/effects/EffectPool.js';
import { effectRandom, effectNumber } from 'engine/effects/VFXUtils.js';
import { keepShaderAlive } from 'engine/effects/ShaderKeepAlive.js';

/**
 * Configuration for impact effects
 */
export interface ImpactEffectConfig {
    /** Number of particles in the burst */
    particleCount?: number;
    /** Duration of the effect in seconds */
    duration?: number;
    /** Particle color (RGB object) */
    color?: { r: number; g: number; b: number };
    /** Minimum particle size */
    minSize?: number;
    /** Maximum particle size */
    maxSize?: number;
    /** Spread angle in radians (cone of particle emission) */
    spreadAngle?: number;
    /** Minimum particle speed */
    minSpeed?: number;
    /** Maximum particle speed */
    maxSpeed?: number;
    /** Gravity strength applied to particles */
    gravity?: number;
    /** null gives each hit a fresh layout; a number makes captures repeatable. */
    seed?: number | null;
    variance?: number;
    /** Exponential air resistance, per second. */
    drag?: number;
    material?: 'spark' | 'debris';
    stretch?: number;
}

/** The impact burst as authored: a small warm-yellow spark cloud in a shallow cone. */
export const DEFAULT_IMPACT_EFFECT: Required<ImpactEffectConfig> = {
    particleCount: 20,
    duration: 0.5,
    color: { r: 1.0, g: 0.8, b: 0.2 },
    minSize: 0.1,
    maxSize: 0.25,
    spreadAngle: Math.PI / 3,
    minSpeed: 2,
    maxSpeed: 5,
    gravity: 9.8,
    seed: null,
    variance: 0.7,
    drag: 2,
    material: 'spark',
    stretch: 2.8,
};

/** Material-aware impact recipes; every field can still be overridden by a game. */
export const IMPACT_EFFECT_PRESETS = {
    metal: DEFAULT_IMPACT_EFFECT,
    stone: { ...DEFAULT_IMPACT_EFFECT, material: 'debris', stretch: 0.8, particleCount: 14, color: { r: 0.65, g: 0.57, b: 0.45 }, minSize: 0.06, maxSize: 0.16, minSpeed: 1, maxSpeed: 3, drag: 1 },
    wood: { ...DEFAULT_IMPACT_EFFECT, material: 'debris', stretch: 3.5, particleCount: 12, color: { r: 0.6, g: 0.34, b: 0.12 }, duration: 0.7, minSpeed: 1, maxSpeed: 3, drag: 2.5 },
    energy: { ...DEFAULT_IMPACT_EFFECT, particleCount: 30, color: { r: 0.3, g: 0.75, b: 1 }, gravity: 0, duration: 0.6, spreadAngle: Math.PI / 2, drag: 4 },
    ice: { ...DEFAULT_IMPACT_EFFECT, material: 'debris', stretch: 2.8, particleCount: 22, color: { r: 0.55, g: 0.85, b: 1 }, minSize: 0.06, maxSize: 0.15, gravity: 5, drag: 1 },
    glass: { ...DEFAULT_IMPACT_EFFECT, material: 'debris', stretch: 5, particleCount: 32, color: { r: 0.72, g: 0.94, b: 0.9 },
        minSize: 0.025, maxSize: 0.07, minSpeed: 2.5, maxSpeed: 6, duration: 0.9, spreadAngle: Math.PI / 2, drag: 0.4 },
    sand: { ...DEFAULT_IMPACT_EFFECT, material: 'debris', stretch: 0.65, particleCount: 48, color: { r: 0.82, g: 0.67, b: 0.41 },
        minSize: 0.025, maxSize: 0.07, minSpeed: 0.8, maxSpeed: 2.8, duration: 0.55, spreadAngle: 1.35, drag: 4, gravity: 5 },
    mud: { ...DEFAULT_IMPACT_EFFECT, material: 'debris', stretch: 0.45, particleCount: 18, color: { r: 0.3, g: 0.22, b: 0.13 },
        minSize: 0.08, maxSize: 0.22, minSpeed: 1, maxSpeed: 3.5, duration: 0.8, spreadAngle: 1.4, drag: 3, gravity: 12 },
    shield: { ...DEFAULT_IMPACT_EFFECT, stretch: 0.25, particleCount: 28, color: { r: 0.65, g: 0.4, b: 1 },
        minSize: 0.07, maxSize: 0.16, minSpeed: 3, maxSpeed: 6, duration: 0.7, spreadAngle: Math.PI / 2, drag: 6, gravity: 0 },
    electric: { ...DEFAULT_IMPACT_EFFECT, stretch: 7, particleCount: 42, color: { r: 0.55, g: 0.85, b: 1 },
        minSize: 0.018, maxSize: 0.045, minSpeed: 3, maxSpeed: 8, duration: 0.35, spreadAngle: 1.45, drag: 1.5, gravity: -2 },
} satisfies Record<string, Required<ImpactEffectConfig>>;

function resolveImpactConfig(config: Required<ImpactEffectConfig>): Required<ImpactEffectConfig> {
    const minSize = effectNumber(config.minSize, 'minSize', 0.001, 10);
    const minSpeed = effectNumber(config.minSpeed, 'minSpeed', 0, 1000);
    if (config.seed !== null) effectNumber(config.seed, 'seed', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    return { ...config, particleCount: Math.round(effectNumber(config.particleCount, 'particleCount', 0, 256)),
        duration: effectNumber(config.duration, 'duration', 0.01, 120), variance: effectNumber(config.variance, 'variance', 0, 1),
        drag: effectNumber(config.drag, 'drag', 0, 100), stretch: effectNumber(config.stretch, 'stretch', 0.1, 12), minSize, maxSize: effectNumber(config.maxSize, 'maxSize', minSize, 10),
        minSpeed, maxSpeed: effectNumber(config.maxSpeed, 'maxSpeed', minSpeed, 1000),
        gravity: effectNumber(config.gravity, 'gravity', -1000, 1000), spreadAngle: effectNumber(config.spreadAngle, 'spreadAngle', 0, Math.PI) };
}

/** Light gray, subtle, additive — the limb trail's one configuration. */
function createTrailMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
        color: 0xcccccc,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
}

/** World-sized geometry works on WebGPU too, where hardware points are one pixel. */
function createImpactMaterial(kind: 'spark' | 'debris' = 'spark'): THREE.MeshBasicMaterial | THREE.MeshLambertMaterial {
    if (kind === 'debris') return new THREE.MeshLambertMaterial({ flatShading: true });
    return new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, depthWrite: false,
        toneMapped: false, blending: THREE.AdditiveBlending });
}

/**
 * Attack VFX System
 * Creates trail renderer effects for attack animations
 *
 * ── Why effects are pooled ─────────────────────────────────────────────────
 * Finished trails and impact bursts are hidden and kept for reuse in an
 * `EffectPool` rather than disposed. Disposing the last material (or, on
 * WebGPU, geometry) that uses a shader program makes three.js delete the
 * program, so the next swing or hit compiled it again — a synchronous stall
 * on the first draw, a visible hitch on every attack. See
 * `engine/effects/EffectPool.ts`.
 */
export class AttackVFX {
    private scene: THREE.Scene;
    private readonly trails = new EffectPool<TrailEffect>();
    private readonly impacts = new EffectPool<ImpactEffect>();
    private impactConfig: Required<ImpactEffectConfig>;

    constructor(scene: THREE.Scene, impactConfig?: ImpactEffectConfig) {
        this.scene = scene;
        // Pre-warm: both programs compile with the scene at load, not on the first attack.
        keepShaderAlive(scene, 'attack-vfx:trail', createTrailMaterial());
        keepShaderAlive(scene, 'attack-vfx:impact', createImpactMaterial(), 'instanced');
        keepShaderAlive(scene, 'attack-vfx:debris', createImpactMaterial('debris'), 'instanced');

        this.impactConfig = resolveImpactConfig({ ...DEFAULT_IMPACT_EFFECT, ...impactConfig });
    }

    /**
     * Update impact effect configuration at runtime
     */
    updateImpactConfig(config: Partial<ImpactEffectConfig>): void {
        this.impactConfig = resolveImpactConfig({ ...this.impactConfig, ...config });
    }

    /**
     * Get current impact effect configuration
     */
    getImpactConfig(): Required<ImpactEffectConfig> {
        return { ...this.impactConfig };
    }

    /**
     * Create trail effect following the attacking limb
     * @param player - Player object to find bones in
     * @param duration - Duration of the effect in seconds
     * @param animationName - Name of the attack animation to parse
     */
    createAttackTrail(player: THREE.Object3D, duration: number, animationName: string): void {
        // Parse animation name to determine which limb
        const limbType = this.parseLimbFromAnimation(animationName);

        if (limbType) {
            this.trails.spawn({
                fits: () => true,
                rearm: (trail) => trail.rearm(player, duration, limbType),
                create: () => new TrailEffect(this.scene, player, duration, limbType),
            });
        }
    }

    /**
     * Parse animation name to determine which limb to track.
     * Side defaults to right when the name does not say.
     */
    private parseLimbFromAnimation(animationName: string): string | null {
        const name = animationName.toLowerCase();
        const side = name.includes('left') ? 'left' : 'right';

        if (name.includes('kick')) return `${side}foot`;
        if (name.includes('punch')) return `${side}hand`;
        return null;
    }

    /**
     * Create impact effect at hit location
     * @param position - World position where hit occurred
     * @param normal - Surface normal at hit point (direction particles should spray)
     */
    createImpactEffect(position: THREE.Vector3, normal: THREE.Vector3): void {
        const config = this.impactConfig;
        this.impacts.spawn({
            fits: (effect) => effect.capacity >= config.particleCount && effect.materialKind === config.material,
            rearm: (effect) => effect.rearm(position, normal, config),
            create: () => new ImpactEffect(this.scene, position, normal, config),
        });
    }

    /**
     * Update all active effects
     */
    update(deltaTime: number): void {
        this.trails.update(deltaTime);
        this.impacts.update(deltaTime);
    }

    /**
     * Clean up all effects
     */
    dispose(): void {
        this.trails.dispose();
        this.impacts.dispose();
    }
}

/**
 * Trail renderer effect that follows hand/fist during attacks
 */
class TrailEffect implements PooledEffect {
    private scene: THREE.Scene;
    private player: THREE.Object3D;
    private age = 0;
    private fadePointCount = -1;
    private duration: number;
    private trailMesh: THREE.Mesh | null = null;
    private trailPoints: THREE.Vector3[] = [];
    private limbBone: THREE.Object3D | null = null;
    private maxTrailLength: number = 8; // Even shorter trail
    private trailWidth: number = 0.08; // Much thinner trail
    private limbType: string;

    // Reusable vectors to avoid allocations in hot path
    private _tempVec1: THREE.Vector3 = new THREE.Vector3();
    private _tempVec2: THREE.Vector3 = new THREE.Vector3();
    private _tempVec3: THREE.Vector3 = new THREE.Vector3();
    private _tempVec4: THREE.Vector3 = new THREE.Vector3();
    private _tempDirection: THREE.Vector3 = new THREE.Vector3();
    private _tempUp: THREE.Vector3 = new THREE.Vector3(0, 1, 0);
    private _tempPerpendicular: THREE.Vector3 = new THREE.Vector3();
    private _tempWorldPos: THREE.Vector3 = new THREE.Vector3();

    constructor(scene: THREE.Scene, player: THREE.Object3D, duration: number = 0.3, limbType: string = 'righthand') {
        this.scene = scene;
        this.player = player;
        this.duration = duration;
        this.limbType = limbType;

        // Find limb bone in the player skeleton
        this.findLimbBone();

        // Create trail mesh only if bone was found
        if (this.limbBone) {
            this.createTrailMesh();
        }
    }

    /** Start a new trail on this effect's existing mesh (created on first use). */
    rearm(player: THREE.Object3D, duration: number, limbType: string): void {
        this.player = player;
        this.age = 0; this.fadePointCount = -1;
        this.duration = duration;
        this.limbType = limbType;
        this.limbBone = null;
        this.trailPoints = [];
        this.findLimbBone();
        if (!this.limbBone) return;
        if (this.trailMesh) {
            (this.trailMesh.material as THREE.MeshBasicMaterial).opacity = 0.35;
            this.updateTrailMesh();
            this.trailMesh.visible = true;
        } else {
            this.createTrailMesh();
        }
    }

    /** Hide the trail, keeping mesh and material alive so the program stays cached. */
    retire(): void {
        this.trailPoints = [];
        if (this.trailMesh) this.trailMesh.visible = false;
    }

    /**
     * Find the limb bone in the player skeleton
     */
    private findLimbBone(): void {
        const boneNameMap: Record<string, string[]> = {
            'righthand': ['mixamorigRightHand', 'RightHand', 'right_hand', 'Right_Hand', 'hand_r', 'Hand_R', 'hand_R', 'righthand'],
            'lefthand': ['mixamorigLeftHand', 'LeftHand', 'left_hand', 'Left_Hand', 'hand_l', 'Hand_L', 'hand_L', 'lefthand'],
            'rightfoot': ['mixamorigRightFoot', 'RightFoot', 'right_foot', 'Right_Foot', 'foot_r', 'Foot_R', 'foot_R', 'rightfoot'],
            'leftfoot': ['mixamorigLeftFoot', 'LeftFoot', 'left_foot', 'Left_Foot', 'foot_l', 'Foot_L', 'foot_L', 'leftfoot']
        };

        const searchNames = boneNameMap[this.limbType] || [];

        this.player.traverse((child) => {
            if (this.limbBone) return;

            const childName = child.name.toLowerCase();
            for (const boneName of searchNames) {
                if (childName.includes(boneName.toLowerCase())) {
                    this.limbBone = child;
                    return;
                }
            }
        });
    }

    /**
     * Create the trail mesh
     */
    private createTrailMesh(): void {
        const geometry = new THREE.BufferGeometry();

        // Initialize with empty data
        const positions = new Float32Array(this.maxTrailLength * 6 * 3); // 2 triangles per segment
        const uvs = new Float32Array(this.maxTrailLength * 6 * 2);

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        ensureNormalAttribute(geometry);

        const material = createTrailMaterial();

        this.trailMesh = new THREE.Mesh(geometry, material);
        this.trailMesh.name = 'AttackTrailMesh';
        this.trailMesh.frustumCulled = false; // Disable frustum culling for dynamic trail
        this.scene.add(this.trailMesh);
    }

    /**
     * Update the trail mesh based on limb position
     */
    private updateTrailMesh(): void {
        if (!this.trailMesh || !this.limbBone) return;

        const geometry = this.trailMesh.geometry as THREE.BufferGeometry;
        const positionAttribute = geometry.getAttribute('position') as THREE.BufferAttribute;
        const positions = positionAttribute.array as Float32Array;

        let vertexIndex = 0;

        // Create ribbon from trail points using reusable vectors
        for (let i = 0; i < this.trailPoints.length - 1; i++) {
            const current = this.trailPoints[i];
            const next = this.trailPoints[i + 1];

            // Skip if either point is undefined
            if (!current || !next) continue;

            // Calculate perpendicular vector for ribbon width (reusing temp vectors)
            this._tempDirection.subVectors(next, current).normalize();
            this._tempPerpendicular.crossVectors(this._tempDirection, this._tempUp).normalize();
            this._tempPerpendicular.multiplyScalar(this.trailWidth);

            // Create quad vertices (reusing temp vectors)
            this._tempVec1.addVectors(current, this._tempPerpendicular);
            this._tempVec2.subVectors(current, this._tempPerpendicular);
            this._tempVec3.addVectors(next, this._tempPerpendicular);
            this._tempVec4.subVectors(next, this._tempPerpendicular);

            // Triangle 1
            positions[vertexIndex++] = this._tempVec1.x; positions[vertexIndex++] = this._tempVec1.y; positions[vertexIndex++] = this._tempVec1.z;
            positions[vertexIndex++] = this._tempVec2.x; positions[vertexIndex++] = this._tempVec2.y; positions[vertexIndex++] = this._tempVec2.z;
            positions[vertexIndex++] = this._tempVec3.x; positions[vertexIndex++] = this._tempVec3.y; positions[vertexIndex++] = this._tempVec3.z;

            // Triangle 2
            positions[vertexIndex++] = this._tempVec2.x; positions[vertexIndex++] = this._tempVec2.y; positions[vertexIndex++] = this._tempVec2.z;
            positions[vertexIndex++] = this._tempVec4.x; positions[vertexIndex++] = this._tempVec4.y; positions[vertexIndex++] = this._tempVec4.z;
            positions[vertexIndex++] = this._tempVec3.x; positions[vertexIndex++] = this._tempVec3.y; positions[vertexIndex++] = this._tempVec3.z;
        }

        // Clear unused vertices
        while (vertexIndex < positions.length) {
            positions[vertexIndex++] = 0;
        }

        positionAttribute.needsUpdate = true;
    }

    /**
     * Update effect
     */
    update(deltaTime: number): void {
        if (deltaTime <= 0) return;
        this.age += deltaTime;
        if (!this.limbBone || !this.trailMesh) return;

        const elapsed = this.age;
        const halfDuration = this.duration / 2;

        // First half - show trail
        if (elapsed < halfDuration) {
            // Get world position of limb bone (reusing temp vector)
            this.limbBone.getWorldPosition(this._tempWorldPos);

            // Add trail points
            const lastPoint = this.trailPoints[this.trailPoints.length - 1];
            if (!lastPoint) {
                // First point - always add
                this.trailPoints.push(this._tempWorldPos.clone());
            } else if (this._tempWorldPos.distanceTo(lastPoint) > 0.05) {
                // Add trail point
                this.trailPoints.push(this._tempWorldPos.clone());

                // Keep trail length limited
                if (this.trailPoints.length > this.maxTrailLength) {
                    this.trailPoints.shift();
                }
            }

            // Update mesh
            this.updateTrailMesh();
        }
        // Second half - fade trail
        else {
            if (this.fadePointCount < 0) this.fadePointCount = this.trailPoints.length;
            const remaining = Math.ceil(this.fadePointCount * Math.max(0, 1 - (elapsed - halfDuration) / halfDuration));
            while (this.trailPoints.length > remaining) this.trailPoints.shift();
            this.updateTrailMesh();

            // Fade out material
            if (this.trailMesh && this.trailPoints.length > 0) {
                const fadeProgress = (elapsed - halfDuration) / halfDuration;
                const material = this.trailMesh.material as THREE.MeshBasicMaterial;
                material.opacity = 0.35 * (1.0 - fadeProgress);
            }
        }
    }

    /** True once the trail has faded and every point has been shed. */
    get isFinished(): boolean {
        return this.age >= this.duration && this.trailPoints.length === 0;
    }

    /** Final teardown. Frees the GPU resources — only for system shutdown. */
    dispose(): void {
        if (this.trailMesh) {
            this.trailMesh.geometry.dispose();
            (this.trailMesh.material as THREE.Material).dispose();
            this.scene.remove(this.trailMesh);
            this.trailMesh = null;
        }
        this.trailPoints = [];
    }
}

/**
 * Impact effect - particles that spray out when hitting an enemy
 */
class ImpactEffect implements PooledEffect {
    private readonly particles: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial | THREE.MeshLambertMaterial>;
    private readonly velocities: THREE.Vector3[] = [];
    private readonly sizes: Float32Array;
    private readonly origin = new THREE.Vector3();
    private readonly dummy = new THREE.Object3D();
    private age = 0;
    private duration = 0.5;
    private gravity = 9.8;
    private drag = 2;
    private stretch = 2.8;
    readonly materialKind: 'spark' | 'debris';
    readonly capacity: number;
    private static readonly up = new THREE.Vector3(0, 1, 0);
    private static readonly normal = new THREE.Vector3();
    private static readonly rotation = new THREE.Quaternion();
    private static readonly tint = new THREE.Color();

    constructor(scene: THREE.Scene, position: THREE.Vector3, normal: THREE.Vector3, config: Required<ImpactEffectConfig>) {
        this.capacity = Math.max(1, config.particleCount);
        this.materialKind = config.material;
        this.sizes = new Float32Array(this.capacity);
        this.particles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), createImpactMaterial(this.materialKind), this.capacity);
        this.particles.name = 'AttackParticles';
        this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.particles.frustumCulled = false;
        if (this.materialKind === 'spark') this.particles.layers.enable(1);
        for (let i = 0; i < this.capacity; i++) this.velocities.push(new THREE.Vector3());
        scene.add(this.particles);
        this.rearm(position, normal, config);
    }

    rearm(position: THREE.Vector3, normal: THREE.Vector3, config: Required<ImpactEffectConfig>): void {
        if (config.particleCount > this.capacity) throw new Error('Impact burst exceeds its instance capacity');
        this.age = 0;
        this.duration = config.duration;
        this.gravity = config.gravity;
        this.drag = config.drag; this.stretch = config.stretch;
        const random = effectRandom(config.seed ?? Math.floor(Math.random() * 4294967296));
        this.origin.copy(position);
        this.particles.count = config.particleCount;
        ImpactEffect.normal.copy(normal);
        if (ImpactEffect.normal.lengthSq() < 1e-8) ImpactEffect.normal.copy(ImpactEffect.up);
        ImpactEffect.normal.normalize();
        ImpactEffect.rotation.setFromUnitVectors(ImpactEffect.up, ImpactEffect.normal);
        for (let i = 0; i < this.particles.count; i++) {
            this.sizes[i] = config.minSize + (0.5 + (random() - 0.5) * config.variance) * (config.maxSize - config.minSize);
            const theta = random() * Math.PI * 2;
            // Uniform solid-angle sampling avoids a dense line along the normal.
            const cosine = 1 - random() * (1 - Math.cos(config.spreadAngle));
            const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
            this.velocities[i]!.set(sine * Math.cos(theta), cosine, sine * Math.sin(theta))
                .applyQuaternion(ImpactEffect.rotation)
                .multiplyScalar(config.minSpeed + random() * (config.maxSpeed - config.minSpeed));
            ImpactEffect.tint.setRGB(config.color.r, config.color.g, config.color.b).multiplyScalar(0.7 + random() * 0.6);
            this.particles.setColorAt(i, ImpactEffect.tint);
        }
        if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
        this.particles.visible = true;
        this.update(0);
    }

    retire(): void { this.particles.visible = false; }

    update(deltaTime: number): void {
        this.age += Math.max(0, deltaTime);
        const t = this.age;
        const travel = this.drag > 0 ? -Math.expm1(-this.drag * t) / this.drag : t;
        const speedScale = Math.exp(-this.drag * t);
        const progress = this.duration > 0 ? Math.min(t / this.duration, 1) : 1;
        for (let i = 0; i < this.particles.count; i++) {
            const velocity = this.velocities[i]!;
            this.dummy.position.copy(this.origin).addScaledVector(velocity, travel);
            this.dummy.position.y -= 0.5 * this.gravity * t * t;
            ImpactEffect.normal.copy(velocity).multiplyScalar(speedScale); ImpactEffect.normal.y -= this.gravity * t;
            if (ImpactEffect.normal.lengthSq() > 1e-8) this.dummy.quaternion.setFromUnitVectors(ImpactEffect.up, ImpactEffect.normal.normalize());
            const width = this.sizes[i]! * (1 - progress * 0.65);
            const fade = this.materialKind === 'debris' ? 1 - THREE.MathUtils.smoothstep(progress, 0.6, 1) : 1;
            this.dummy.scale.set(width * 0.3 * fade, width * (0.5 + speedScale * (this.stretch - 0.5)) * fade, width * 0.3 * fade);
            this.dummy.updateMatrix(); this.particles.setMatrixAt(i, this.dummy.matrix);
        }
        this.particles.instanceMatrix.needsUpdate = true;
        this.particles.material.opacity = 1 - progress * progress;
    }

    get isFinished(): boolean { return this.age >= this.duration; }

    dispose(): void {
        this.particles.removeFromParent(); this.particles.dispose();
        this.particles.geometry.dispose(); this.particles.material.dispose();
    }
}
