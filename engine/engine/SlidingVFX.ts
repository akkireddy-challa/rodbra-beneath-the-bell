import * as THREE from 'three';
import { ensureNormalAttribute } from 'engine/utils/ensureNormalAttribute.js';

/**
 * Configuration for sliding particle effects
 */
export interface SlidingVFXConfig {
    /** Base color of particles (RGB 0-1) */
    color?: { r: number; g: number; b: number };
    /** Minimum particle size */
    minSize?: number;
    /** Maximum particle size */
    maxSize?: number;
    /** How many particles to emit per second at max velocity */
    emissionRate?: number;
    /** Particle lifetime in seconds */
    particleLifetime?: number;
    /** Minimum velocity required to start emitting particles */
    velocityThreshold?: number;
    /** Maximum friction value that triggers VFX (e.g., 0.3 = only on slippery surfaces) */
    frictionThreshold?: number;
    /** How high particles rise */
    riseSpeed?: number;
    /** How much particles spread horizontally */
    spreadSpeed?: number;
    /** Vertical offset from player position to ground (negative = below player center) */
    groundOffset?: number;
}

/**
 * Interface for sliding VFX providers
 * Templates can implement this to provide custom sliding effects
 */
export interface ISlidingVFX {
    /**
     * Update the VFX system
     * @param deltaTime - Time since last frame
     * @param playerPosition - Current player world position
     * @param velocity - Current player velocity magnitude
     * @param friction - Current terrain friction (0 = ice, 1 = sticky)
     * @param isSliding - Whether player is currently sliding (grounded + no input + velocity > 0)
     */
    update(
        deltaTime: number,
        playerPosition: THREE.Vector3,
        velocity: number,
        friction: number,
        isSliding: boolean
    ): void;

    /**
     * Clean up resources
     */
    dispose(): void;

    /**
     * Update configuration at runtime
     */
    updateConfig?(config: Partial<SlidingVFXConfig>): void;
}

/**
 * Default sliding VFX implementation - ice crystal particle trail
 */
export class SlidingVFX implements ISlidingVFX {
    private scene: THREE.Scene;
    private config: Required<SlidingVFXConfig>;
    private particles: THREE.Points | null = null;
    private particleData: ParticleData[] = [];
    private maxParticles: number = 100;
    private emissionAccumulator: number = 0;

    // Reusable vectors
    private _tempVec = new THREE.Vector3();

    constructor(scene: THREE.Scene, config?: SlidingVFXConfig) {
        this.scene = scene;

        // Default configuration for ice-like particles
        this.config = {
            color: config?.color ?? { r: 0.7, g: 0.85, b: 1.0 }, // Light blue/white
            minSize: config?.minSize ?? 0.03,
            maxSize: config?.maxSize ?? 0.08,
            emissionRate: config?.emissionRate ?? 30, // particles per second at max speed
            particleLifetime: config?.particleLifetime ?? 0.4, // Short lifetime so particles don't linger
            velocityThreshold: config?.velocityThreshold ?? 1.0,
            frictionThreshold: config?.frictionThreshold ?? 0.5,
            riseSpeed: config?.riseSpeed ?? 0.2, // Slow rise to stay near ground
            spreadSpeed: config?.spreadSpeed ?? 0.15, // Less horizontal spread
            groundOffset: config?.groundOffset ?? -0.35, // Near feet/ground level
        };

        this.createParticleSystem();
    }

    /**
     * Update configuration at runtime
     */
    updateConfig(config: Partial<SlidingVFXConfig>): void {
        this.config = { ...this.config, ...config };

        // Update particle material color if changed
        if (config.color && this.particles) {
            const colors = this.particles.geometry.getAttribute('color').array as Float32Array;
            for (let i = 0; i < this.maxParticles; i++) {
                const i3 = i * 3;
                colors[i3] = this.config.color.r;
                colors[i3 + 1] = this.config.color.g;
                colors[i3 + 2] = this.config.color.b;
            }
            this.particles.geometry.getAttribute('color').needsUpdate = true;
        }
    }

    /**
     * Get current configuration
     */
    getConfig(): Required<SlidingVFXConfig> {
        return { ...this.config };
    }

    private createParticleSystem(): void {
        const geometry = new THREE.BufferGeometry();

        const positions = new Float32Array(this.maxParticles * 3);
        const colors = new Float32Array(this.maxParticles * 3);
        const sizes = new Float32Array(this.maxParticles);
        const alphas = new Float32Array(this.maxParticles);

        // Initialize all particles as invisible (at origin with zero alpha)
        for (let i = 0; i < this.maxParticles; i++) {
            const i3 = i * 3;
            positions[i3] = 0;
            positions[i3 + 1] = -1000; // Hide below ground
            positions[i3 + 2] = 0;

            colors[i3] = this.config.color.r;
            colors[i3 + 1] = this.config.color.g;
            colors[i3 + 2] = this.config.color.b;

            sizes[i] = 0;
            alphas[i] = 0;

            // Initialize particle data
            this.particleData.push({
                active: false,
                age: 0,
                lifetime: 0,
                velocity: new THREE.Vector3(),
                size: 0,
            });
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
        ensureNormalAttribute(geometry);

        // Custom shader material for soft particles with alpha
        const material = new THREE.PointsMaterial({
            size: 0.1,
            vertexColors: true,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            sizeAttenuation: true,
        });

        this.particles = new THREE.Points(geometry, material);
        this.particles.name = 'SlidingParticles';
        this.particles.frustumCulled = false;
        this.scene.add(this.particles);
    }

    update(
        deltaTime: number,
        playerPosition: THREE.Vector3,
        velocity: number,
        friction: number,
        isSliding: boolean
    ): void {
        if (!this.particles) return;

        const geometry = this.particles.geometry;
        const positions = geometry.getAttribute('position').array as Float32Array;
        const sizes = geometry.getAttribute('size').array as Float32Array;

        // Emit new particles if sliding on low-friction surface
        const shouldEmit = isSliding &&
            velocity > this.config.velocityThreshold &&
            friction < this.config.frictionThreshold;

        if (shouldEmit) {
            // Scale emission rate by velocity (faster = more particles)
            const velocityFactor = Math.min(velocity / 5.0, 1.0);
            // Scale by how slippery the surface is (lower friction = more particles)
            const frictionFactor = 1.0 - (friction / this.config.frictionThreshold);
            const effectiveRate = this.config.emissionRate * velocityFactor * frictionFactor;

            this.emissionAccumulator += effectiveRate * deltaTime;

            while (this.emissionAccumulator >= 1.0) {
                this.emitParticle(playerPosition);
                this.emissionAccumulator -= 1.0;
            }
        }

        // Update existing particles
        for (let i = 0; i < this.maxParticles; i++) {
            const data = this.particleData[i];
            if (!data || !data.active) continue;

            data.age += deltaTime;

            if (data.age >= data.lifetime) {
                // Particle died - hide it completely
                data.active = false;
                sizes[i] = 0;
                // Move off-screen to ensure it's not visible
                const i3 = i * 3;
                positions[i3 + 1] = -1000;
                continue;
            }

            // Update position
            const i3 = i * 3;
            const px = positions[i3];
            const py = positions[i3 + 1];
            const pz = positions[i3 + 2];
            if (px !== undefined) positions[i3] = px + data.velocity.x * deltaTime;
            if (py !== undefined) positions[i3 + 1] = py + data.velocity.y * deltaTime;
            if (pz !== undefined) positions[i3 + 2] = pz + data.velocity.z * deltaTime;

            // Fade out over lifetime
            const lifeProgress = data.age / data.lifetime;
            const alpha = 1.0 - lifeProgress;

            // Size grows slightly then shrinks
            const sizeProgress = lifeProgress < 0.3
                ? lifeProgress / 0.3
                : 1.0 - ((lifeProgress - 0.3) / 0.7);
            sizes[i] = data.size * sizeProgress * alpha;
        }

        geometry.getAttribute('position').needsUpdate = true;
        geometry.getAttribute('size').needsUpdate = true;
    }

    private emitParticle(position: THREE.Vector3): void {
        // Find inactive particle
        for (let i = 0; i < this.maxParticles; i++) {
            const data = this.particleData[i];
            if (!data || data.active) continue;

            // Activate particle
            data.active = true;
            data.age = 0;
            data.lifetime = this.config.particleLifetime * (0.7 + Math.random() * 0.6);
            data.size = this.config.minSize + Math.random() * (this.config.maxSize - this.config.minSize);

            // Random velocity - rise up and spread out
            data.velocity.set(
                (Math.random() - 0.5) * this.config.spreadSpeed * 2,
                this.config.riseSpeed * (0.5 + Math.random() * 0.5),
                (Math.random() - 0.5) * this.config.spreadSpeed * 2
            );

            // Set position at player's feet with slight random offset
            const i3 = i * 3;
            const positions = this.particles!.geometry.getAttribute('position').array as Float32Array;
            positions[i3] = position.x + (Math.random() - 0.5) * 0.3;
            positions[i3 + 1] = position.y + this.config.groundOffset + Math.random() * 0.1; // At feet level
            positions[i3 + 2] = position.z + (Math.random() - 0.5) * 0.3;

            // Set initial size
            const sizes = this.particles!.geometry.getAttribute('size').array as Float32Array;
            sizes[i] = data.size;

            break;
        }
    }

    dispose(): void {
        if (this.particles) {
            this.particles.geometry.dispose();
            (this.particles.material as THREE.Material).dispose();
            this.scene.remove(this.particles);
            this.particles = null;
        }
        this.particleData = [];
    }
}

interface ParticleData {
    active: boolean;
    age: number;
    lifetime: number;
    velocity: THREE.Vector3;
    size: number;
}
