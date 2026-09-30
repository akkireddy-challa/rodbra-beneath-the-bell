import * as THREE from 'three';
import { burstRecipe, type BurstPreset, type BurstRecipe } from 'engine/effects/BurstPresets.js';
import { updateEffectAttribute, effectRandom, effectNumber, effectPosition, effectDensity, effectGeometry, EFFECT_UP, type VFXQuality, type VFXStyle } from 'engine/effects/VFXUtils.js';

export interface BurstOptions {
    preset: BurstPreset;
    /** Per-spawn recipe adaptation; never mutates the shared catalog. */
    recipe?: Partial<BurstRecipe>;
    radius: number;
    duration: number;
    color: number;
    amount: number;
    variance: number;
    seed: number;
    style: VFXStyle;
    quality: VFXQuality;
    direction: THREE.Vector3;
    /** Independently inspect the structural particles and expanding ground ring. */
    layers: { particles: boolean; ring: boolean };
}
export const DEFAULT_BURST_OPTIONS: BurstOptions = {
    preset: 'sparks', radius: 1, duration: 0.65, color: 0xffe3a0, amount: 1, variance: 0.7, seed: 73,
    style: 'voxel', quality: 'high', direction: new THREE.Vector3(0, 1, 0), layers: { particles: true, ring: true },
};
const CAPACITY = 256;

/** One particle draw + optional ring. Opaque clouds shrink; emissive particles use additive blending. */
export class BurstVisual {
    readonly group = new THREE.Group();
    private readonly solid: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    private readonly glow: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    private readonly hot: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    private readonly ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
    private readonly data = new Float32Array(CAPACITY * 8);
    private readonly dummy = new THREE.Object3D();
    private readonly rotation = new THREE.Quaternion();
    private readonly velocity = new THREE.Vector3();
    private readonly color = new THREE.Color();
    private readonly startColor = new THREE.Color();
    private readonly endColor = new THREE.Color();
    private recipe: Readonly<BurstRecipe> = burstRecipe('sparks');
    private options = DEFAULT_BURST_OPTIONS;
    private disposed = false;

    constructor(scene: THREE.Scene, readonly style: VFXStyle) {
        const geometry = effectGeometry(style);
        this.solid = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ flatShading: true }), CAPACITY);
        this.glow = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending, toneMapped: false }), CAPACITY);
        this.hot = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ toneMapped: false }), CAPACITY);
        this.hot.name = 'Burst:flame';
        this.solid.name = 'Burst:solid'; this.glow.name = 'Burst:glow';
        for (const mesh of [this.solid, this.glow, this.hot]) {
            mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        }
        this.glow.layers.enable(1); this.hot.layers.enable(1); this.glow.material.opacity = 0.65;
        this.ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, style === 'voxel' ? 4 : 64),
            new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
        this.ring.rotation.x = -Math.PI / 2;
        this.ring.position.y = 0.025;
        this.ring.name = 'Burst:ring';
        this.group.add(this.solid, this.glow, this.hot, this.ring);
        this.group.visible = false;
        scene.add(this.group);
    }

    rearm(position: THREE.Vector3, options: BurstOptions): void {
        if (this.disposed) throw new Error('BurstVisual is disposed');
        effectPosition(position); effectPosition(options.direction);
        this.recipe = burstRecipe(options.preset, options.recipe);
        this.options = { ...options, radius: effectNumber(options.radius, 'radius', 0.01, 1000),
            amount: effectNumber(options.amount, 'amount', 0, 3), variance: effectNumber(options.variance, 'variance', 0, 1),
            layers: { ...options.layers } };
        this.group.name = `Burst:${options.preset}`;
        this.group.position.copy(position);
        this.velocity.copy(options.direction);
        if (this.velocity.lengthSq() < 1e-8) this.velocity.copy(EFFECT_UP);
        this.rotation.setFromUnitVectors(EFFECT_UP, this.velocity.normalize());
        this.ring.position.set(0, 0.025, 0).applyQuaternion(this.rotation);
        this.startColor.set(options.color); this.endColor.set(this.recipe.endColor);
        this.ring.material.color.copy(this.startColor);
        const count = Math.min(CAPACITY, Math.round(this.recipe.count * this.options.amount * effectDensity(options.quality)));
        this.solid.count = this.recipe.glow || options.preset === 'flame' ? 0 : count;
        this.glow.count = this.recipe.glow && options.preset !== 'flame' ? count : 0;
        this.hot.count = options.preset === 'flame' ? count : 0;
        const random = effectRandom(options.seed);
        for (let i = 0; i < count; i++) {
            const k = i * 8;
            this.data[k] = i * 2.399963 + (random() - 0.5) * this.options.variance;
            this.data[k + 1] = 1 - random() * (1 - Math.cos(this.recipe.spread));
            this.data[k + 2] = 1 + (random() - 0.5) * this.options.variance;
            this.data[k + 3] = random();
            this.data[k + 4] = this.recipe.birthWindow * (i / Math.max(1, count) * (1 - this.options.variance) + random() * this.options.variance);
            this.data[k + 5] = 0.85 + (random() - 0.5) * 0.3 * this.options.variance;
            this.data[k + 6] = random() * Math.PI * 2;
            this.data[k + 7] = (random() - 0.5) * this.options.variance;
        }
        this.group.visible = true;
        this.setProgress(0);
    }

    setProgress(progress: number): void {
        if (this.disposed) return;
        const t = effectNumber(progress, 'progress', 0, 1), o = this.options, recipe = this.recipe;
        this.group.visible = t < 1;
        this.solid.visible = !recipe.glow && o.preset !== 'flame' && o.layers.particles;
        this.glow.visible = recipe.glow && o.preset !== 'flame' && o.layers.particles;
        this.hot.visible = o.preset === 'flame' && o.layers.particles;
        const mesh = o.preset === 'flame' ? this.hot : recipe.glow ? this.glow : this.solid, d = this.dummy, r = o.radius;
        for (let i = 0; i < mesh.count; i++) {
            const k = i * 8, birth = this.data[k + 4]!;
            const life = (1 - birth) * this.data[k + 5]!, age = THREE.MathUtils.clamp((t - birth) / life, 0, 1);
            const a = this.data[k]!, cosine = this.data[k + 1]!, variation = this.data[k + 2]!;
            const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine)), phase = a + age * recipe.curl;
            let size = recipe.size * r * variation;
            d.quaternion.identity();
            if (recipe.motion === 'funnel') {
                const width = r * (0.12 + age * 0.85);
                d.position.set(Math.cos(phase) * width, age * r * recipe.speed, Math.sin(phase) * width);
                size *= 0.65 + age;
            } else if (recipe.motion === 'fall') {
                const width = r * (0.3 + this.data[k + 3]! * 0.8);
                d.position.set(Math.cos(a) * width + Math.sin(phase * 2) * r * (recipe.flutter ?? 0),
                    (1 - age) * r * 2 * recipe.speed, Math.sin(a) * width + age * r * 0.3);
            } else if (recipe.motion === 'float') {
                const width = r * (0.25 + this.data[k + 3]! * 0.65);
                d.position.set(Math.cos(phase) * width, r * (this.data[k + 3]! * 0.8 + age * recipe.speed), Math.sin(phase) * width);
                d.position.y += Math.sin(age * 12 + a) * r * (recipe.flutter ?? 0);
                size *= recipe.glow ? 0.55 + 0.45 * Math.sin(age * 16 + a) ** 2 : 0.6 + age * 0.8;
            } else if (recipe.motion === 'ring') {
                const radius = r * Math.sqrt(age) * recipe.speed;
                d.position.set(Math.cos(a) * radius, r * 0.08, Math.sin(a) * radius);
                this.velocity.set(Math.cos(a), 0, Math.sin(a));
            } else if (recipe.motion === 'trail') {
                const tail = this.data[k + 3]!, width = r * (0.04 + tail * 0.25);
                d.position.set(Math.cos(phase) * width, r * (age * recipe.speed - tail * 1.5), Math.sin(phase) * width);
                size *= 1 - tail * 0.8;
            } else if (recipe.motion === 'plume') {
                const width = (0.16 + age * (o.preset === 'flame' ? 0.12 : 0.5)) * r;
                d.position.set(Math.cos(phase) * width, age * r * recipe.speed, Math.sin(phase) * width);
                size *= (o.preset === 'flame' ? 1 - age * 0.8 : 0.5 + age * 1.2);
            } else if (recipe.motion === 'orbit' || recipe.motion === 'converge') {
                const radius = r * (recipe.motion === 'converge' ? 1 - age : 0.65 + age * 0.2);
                d.position.set(Math.cos(phase) * radius, recipe.motion === 'converge' ? Math.sin(phase) * radius : age * r * recipe.speed,
                    recipe.motion === 'converge' ? this.data[k + 7]! * r * (1 - age) : Math.sin(phase) * radius);
            } else {
                const y = recipe.motion === 'radial' ? this.data[k + 3]! * 2 - 1 : cosine;
                const lateral = recipe.motion === 'radial' ? Math.sqrt(1 - y * y) : sine;
                this.velocity.set(Math.cos(phase) * lateral, y, Math.sin(phase) * lateral).multiplyScalar(r * recipe.speed * variation);
                if (o.preset === 'dust') this.velocity.y = Math.abs(this.velocity.y) * 0.3;
                d.position.copy(this.velocity).multiplyScalar(age);
                d.position.y -= recipe.gravity * r * age * age;
            }
            d.position.applyQuaternion(this.rotation);
            const fadeIn = recipe.motion === 'cone' ? 1 : THREE.MathUtils.smoothstep(age, 0, 0.12);
            const fadeOut = 1 - THREE.MathUtils.smoothstep(age, 0.5, 1);
            size *= fadeIn * fadeOut;
            d.scale.set(size, size * recipe.stretch, size);
            if (o.preset === 'confetti' || recipe.tumble) {
                d.rotation.set(this.data[k + 6]! + age * 12, a + age * 7, age * 9);
                d.quaternion.premultiply(this.rotation);
                if (o.preset === 'confetti') this.color.setHSL(this.data[k + 3]!, 0.8, 0.58);
                else this.color.copy(this.startColor).lerp(this.endColor, this.data[k + 3]!).multiplyScalar(0.85 + variation * 0.15);
            } else {
                if (recipe.motion === 'cone' || recipe.motion === 'radial' || recipe.motion === 'fountain' || recipe.motion === 'ring') {
                    if (recipe.motion !== 'ring') this.velocity.y -= 2 * recipe.gravity * r * age;
                    this.velocity.applyQuaternion(this.rotation);
                    if (this.velocity.lengthSq() > 1e-8) d.quaternion.setFromUnitVectors(EFFECT_UP, this.velocity.normalize());
                } else {
                    d.rotation.set(0, o.style === 'voxel' ? Math.floor(a / (Math.PI / 2)) * Math.PI / 2 : phase, 0);
                    d.quaternion.premultiply(this.rotation);
                }
                this.color.copy(this.startColor).lerp(this.endColor, age).multiplyScalar(recipe.glow && o.preset !== 'flame' ? 1 + 0.2 * fadeOut : 0.8 + this.data[k + 3]! * 0.4);
            }
            if (t < birth || age >= 1) d.scale.setScalar(0);
            d.updateMatrix(); mesh.setMatrixAt(i, d.matrix); mesh.setColorAt(i, this.color);
        }
        updateEffectAttribute(mesh.instanceMatrix, mesh.count);
        if (mesh.instanceColor) updateEffectAttribute(mesh.instanceColor, mesh.count);
        const ringRadius = recipe.motion === 'converge' ? 1 - t : Math.sqrt(t);
        this.ring.scale.setScalar(r * ringRadius * 1.5);
        this.ring.rotation.set(recipe.motion === 'converge' ? 0 : -Math.PI / 2, 0, 0);
        this.ring.quaternion.premultiply(this.rotation);
        this.ring.material.opacity = recipe.ring * Math.sin(Math.PI * t) * 0.7;
        this.ring.visible = o.layers.ring && recipe.ring > 0 && t < 1;
    }

    retire(): void { this.group.visible = false; }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.group.removeFromParent();
        this.solid.geometry.dispose();
        this.solid.material.dispose(); this.glow.material.dispose(); this.hot.material.dispose(); this.solid.dispose(); this.glow.dispose(); this.hot.dispose();
        this.ring.geometry.dispose(); this.ring.material.dispose();
    }
}
