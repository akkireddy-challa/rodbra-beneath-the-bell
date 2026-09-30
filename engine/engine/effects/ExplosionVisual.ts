import * as THREE from 'three';
import { explosionRecipe, type ExplosionPreset, type ExplosionRecipe, type ExplosionLayer } from 'engine/effects/ExplosionPresets.js';
import { updateEffectAttribute, effectRandom, effectNumber, effectPosition, effectDensity, type VFXQuality } from 'engine/effects/VFXUtils.js';

export type ExplosionStyle = 'voxel' | 'low-poly';
export interface ExplosionVisualOptions {
    radius: number;
    color: number;
    style: ExplosionStyle;
    seed: number;
    /** Existing callers retain the original burst. */
    preset?: ExplosionPreset;
    /** Per-spawn layer/motion recipe; visual only, not projectile damage. */
    recipe?: Partial<ExplosionRecipe>;
    /** Particle multiplier, 0–3. Flash and ring remain independently controlled. */
    amount?: number;
    /** Size, timing and trajectory irregularity, 0–1. */
    variance?: number;
    quality?: VFXQuality;
    /** Layer strength, 0–2; zero disables a layer. Also useful for inspection. */
    layers?: Partial<Record<ExplosionLayer, number>>;
}
export const DEFAULT_EXPLOSION_VISUAL_OPTIONS: ExplosionVisualOptions = {
    radius: 4, color: 0xff5a12, style: 'voxel', seed: 73, preset: 'blast', amount: 1, variance: 0.65, quality: 'high',
};
type Kind = 'fire' | 'smoke' | 'sparks' | 'debris';
interface Layer { kind: Kind; mesh: THREE.InstancedMesh; data: Float32Array }
const pools = new WeakMap<THREE.Scene, ExplosionVisual[]>();
const CAPACITY: Record<Kind, number> = { fire: 96, smoke: 96, sparks: 192, debris: 128 };
const smooth = THREE.MathUtils.smoothstep;
const UP = new THREE.Vector3(0, 1, 0);

/** Six draws per burst, reusable buffers and analytic normalized-age motion on both renderers. */
export class ExplosionVisual {
    readonly group = new THREE.Group();
    readonly style: ExplosionStyle;
    private readonly layers: Layer[] = [];
    private readonly core: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    private readonly ring: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    private readonly dummy = new THREE.Object3D();
    private readonly direction = new THREE.Vector3();
    private readonly tint = new THREE.Color();
    private readonly hot = new THREE.Color();
    private readonly ember = new THREE.Color();
    private readonly fireColor = new THREE.Color();
    private recipe: Readonly<ExplosionRecipe> = explosionRecipe('blast');
    private radius = 1;
    private variance = 0.65;
    private flashStrength = 1;
    private ringStrength = 1;
    private busy = false;
    private destroyed = false;

    private constructor(private readonly scene: THREE.Scene, style: ExplosionStyle) {
        this.style = style;
        this.group.name = `ExplosionVisual:${style}`;
        for (const kind of ['fire', 'smoke', 'sparks', 'debris'] as const) {
            const geometry = style === 'voxel' || kind === 'sparks'
                ? new THREE.BoxGeometry(1, 1, 1) : new THREE.IcosahedronGeometry(0.7, kind === 'smoke' ? 1 : 0);
            if (kind === 'fire') {
                const normals = geometry.getAttribute('normal'), colors = new Float32Array(normals.count * 3);
                for (let i = 0; i < normals.count; i++) {
                    const shade = 0.76 + normals.getY(i) * 0.16 + normals.getZ(i) * 0.08;
                    colors.set([shade, shade, shade], i * 3);
                }
                geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            }
            // Solid lobes dissipate by staggered shrinkage, never unsortable transparent boxes.
            const material = kind === 'smoke' || kind === 'debris'
                ? new THREE.MeshLambertMaterial({ flatShading: true })
                : new THREE.MeshBasicMaterial({ transparent: kind === 'sparks', depthWrite: kind !== 'sparks', toneMapped: false,
                    vertexColors: kind === 'fire', blending: kind === 'sparks' ? THREE.AdditiveBlending : THREE.NormalBlending });
            const mesh = new THREE.InstancedMesh(geometry, material, CAPACITY[kind]);
            mesh.name = `Explosion:${kind === 'sparks' ? 'spark' : kind}`;
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            mesh.frustumCulled = false;
            if (kind === 'fire' || kind === 'sparks') mesh.layers.enable(1);
            this.layers.push({ kind, mesh, data: new Float32Array(CAPACITY[kind] * 8) });
            this.group.add(mesh);
        }
        this.core = new THREE.Mesh(style === 'voxel' ? new THREE.BoxGeometry(1, 1, 1) : new THREE.IcosahedronGeometry(0.7, 1),
            new THREE.MeshBasicMaterial({ toneMapped: false }));
        this.core.name = 'Explosion:flash';
        this.ring = new THREE.Mesh(new THREE.RingGeometry(0.91, 1, style === 'voxel' ? 4 : 64),
            new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
        this.ring.name = 'Explosion:ring';
        this.ring.rotation.x = -Math.PI / 2;
        if (style === 'voxel') this.ring.rotation.z = Math.PI / 4;
        this.core.layers.enable(1);
        this.group.add(this.core, this.ring);
        scene.add(this.group);
    }

    static acquire(scene: THREE.Scene, position: THREE.Vector3, options: ExplosionVisualOptions): ExplosionVisual {
        effectPosition(position);
        effectNumber(options.radius, 'radius', 0.01, 1000);
        effectNumber(options.seed, 'seed', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
        explosionRecipe(options.preset ?? 'blast', options.recipe);
        effectDensity(options.quality ?? 'high');
        effectNumber(options.amount ?? 1, 'amount', 0, 3);
        effectNumber(options.variance ?? 0.65, 'variance', 0, 1);
        for (const strength of Object.values(options.layers ?? {})) effectNumber(strength, 'layer strength', 0, 2);
        let pool = pools.get(scene);
        if (!pool) { pool = []; pools.set(scene, pool); }
        let visual = pool.find(entry => !entry.busy && entry.style === options.style);
        if (!visual) { visual = new ExplosionVisual(scene, options.style); pool.push(visual); }
        visual.rearm(position, options);
        return visual;
    }

    private rearm(position: THREE.Vector3, options: ExplosionVisualOptions): void {
        this.busy = true;
        this.radius = effectNumber(options.radius, 'radius', 0.01, 1000);
        this.variance = effectNumber(options.variance ?? 0.65, 'variance', 0, 1);
        this.recipe = explosionRecipe(options.preset ?? 'blast', options.recipe);
        const amount = effectNumber(options.amount ?? 1, 'amount', 0, 3) * effectDensity(options.quality ?? 'high');
        this.flashStrength = this.recipe.flash * effectNumber(options.layers?.flash ?? 1, 'flash', 0, 2);
        this.ringStrength = this.recipe.ring * effectNumber(options.layers?.ring ?? 1, 'ring', 0, 2);
        this.fireColor.set(options.color);
        this.hot.copy(this.fireColor).lerp(new THREE.Color(0xffffff), 0.8).multiplyScalar(2);
        this.ember.copy(this.fireColor).multiplyScalar(0.18);
        this.core.material.color.copy(this.hot);
        this.ring.material.color.set(this.recipe.ringColor);
        this.group.position.copy(position);
        this.group.visible = true;
        for (const [index, { kind, mesh, data }] of this.layers.entries()) {
            const random = effectRandom(options.seed + index * 104729);
            mesh.count = Math.min(CAPACITY[kind], Math.round(this.recipe[kind] * amount * effectNumber(options.layers?.[kind] ?? 1, kind, 0, 2)));
            for (let i = 0; i < mesh.count; i++) {
                const a = i * 2.399963 + (random() - 0.5) * this.variance;
                const y = -0.25 + 1.25 * (i + 0.5) / Math.max(1, mesh.count);
                const lateral = Math.sqrt(Math.max(0, 1 - y * y)), k = i * 8;
                data[k] = Math.cos(a) * lateral;
                data[k + 1] = y;
                data[k + 2] = Math.sin(a) * lateral;
                data[k + 3] = 1 + (random() - 0.5) * this.variance;
                data[k + 4] = 0.5 + (random() - 0.5) * this.variance;
                data[k + 5] = random() * Math.PI * 2;
                data[k + 6] = random() * 0.1 * this.variance;
                data[k + 7] = 1 - random() * 0.25 * this.variance;
                this.tint.set(kind === 'smoke' ? this.recipe.smokeColor : kind === 'debris' ? this.recipe.debrisColor : this.recipe.sparkColor);
                this.tint.multiplyScalar(0.8 + data[k + 4]! * 0.4);
                mesh.setColorAt(i, this.tint);
            }
            if (mesh.instanceColor) updateEffectAttribute(mesh.instanceColor, mesh.count);
        }
        this.setProgress(0);
    }

    /** Seeking and irregular frame steps produce the same image at the same age. */
    setProgress(progress: number): void {
        if (this.destroyed || !this.busy) return;
        const t = effectNumber(progress, 'progress', 0, 1), r = this.radius, recipe = this.recipe;
        this.group.visible = t < 1;
        const d = this.dummy;
        for (const { kind, mesh, data } of this.layers) {
            mesh.visible = mesh.count > 0 && t < 1;
            for (let i = 0; i < mesh.count; i++) {
                const k = i * 8, age = Math.max(0, (t - data[k + 6]!) / data[k + 7]!);
                const x = data[k]!, y = data[k + 1]!, z = data[k + 2]!;
                const scale = data[k + 3]!, variation = data[k + 4]!, spin = data[k + 5]!;
                if (kind === 'fire') {
                    const travel = (1 - Math.exp(-age * 9)) * r * 0.35;
                    const curl = recipe.swirl * age;
                    d.position.set((x * Math.cos(curl) - z * Math.sin(curl)) * travel,
                        (y * 0.5 + 0.25) * travel + age * r * 0.35 * recipe.lift,
                        (z * Math.cos(curl) + x * Math.sin(curl)) * travel);
                    const fade = 1 - smooth(age, 0.25 + variation * 0.1, 0.48 + variation * 0.15);
                    d.scale.setScalar(r * (0.14 + smooth(age, 0, 0.18) * 0.22) * scale * fade);
                    this.tint.copy(this.hot).lerp(this.fireColor, smooth(age, 0.05, 0.3));
                    this.tint.lerp(this.ember, smooth(age, 0.24, 0.58) * 0.8);
                    mesh.setColorAt(i, this.tint);
                } else if (kind === 'smoke') {
                    // An expanding rolling stem/crown, with lobes born behind the fire front.
                    const travel = r * (0.08 + age * 0.36), curl = age * recipe.swirl;
                    d.position.set((x * Math.cos(curl) - z * Math.sin(curl)) * travel,
                        r * (0.05 + age * (0.45 + variation * 0.65) * recipe.lift),
                        (z * Math.cos(curl) + x * Math.sin(curl)) * travel);
                    const birth = smooth(age, 0.07 + variation * 0.05, 0.25 + variation * 0.08);
                    const fade = 1 - smooth(age, 0.6 + variation * 0.12, 0.9 + variation * 0.1);
                    d.scale.setScalar(r * (0.15 + age * 0.3) * scale * birth * fade);
                } else {
                    const speed = (kind === 'sparks' ? 2.9 : 1.3) * recipe.speed;
                    const gravity = recipe.lift === 0 ? 0 : 1.5;
                    d.position.set(x * age * r * speed,
                        r * ((Math.abs(y) + 0.2) * age * speed * Math.min(1, recipe.lift + 0.3) - age * age * gravity), z * age * r * speed);
                    const fade = 1 - smooth(age, kind === 'sparks' ? 0.3 : 0.65, kind === 'sparks' ? 0.8 : 1);
                    const size = r * (kind === 'sparks' ? 0.018 : 0.045) * scale * fade;
                    d.scale.set(size, size * (kind === 'sparks' ? 3.5 : recipe.debrisStretch), size);
                    if (kind === 'sparks') d.quaternion.setFromUnitVectors(UP,
                        this.direction.set(x * speed, (Math.abs(y) + 0.2) * speed * Math.min(1, recipe.lift + 0.3) - 2 * gravity * age, z * speed).normalize());
                }
                // Authored silhouettes share the same fixed instance buffers and analytic clock.
                if (recipe.motion === 'inward') {
                    const radius = r * (1 - smooth(age, 0, 0.78)) * (kind === 'fire' ? 0.75 : 1.35);
                    const curl = age * recipe.swirl;
                    d.position.set((x * Math.cos(curl) - z * Math.sin(curl)) * radius,
                        (y + 0.3) * radius, (z * Math.cos(curl) + x * Math.sin(curl)) * radius);
                    d.scale.multiplyScalar(smooth(age, 0, 0.08) * (1 - smooth(age, 0.65, 0.82)));
                } else if (recipe.motion === 'column') {
                    d.position.x *= 0.35; d.position.z *= 0.35; d.position.y *= 1.65;
                } else if (recipe.motion === 'disk') {
                    d.position.x *= 1.5; d.position.z *= 1.5; d.position.y *= 0.18;
                    if (kind === 'fire' || kind === 'smoke') d.scale.y *= 0.55;
                }
                if (kind !== 'sparks') {
                    if (this.style === 'voxel' && kind !== 'debris') d.rotation.set(0, Math.floor(spin / (Math.PI / 2)) * Math.PI / 2, 0);
                    else d.rotation.set(spin + age * (kind === 'debris' ? 8 : 0.3), spin * 0.7, spin * 0.3);
                }
                if (t < data[k + 6]! || age >= 1) d.scale.setScalar(0);
                d.updateMatrix(); mesh.setMatrixAt(i, d.matrix);
            }
            updateEffectAttribute(mesh.instanceMatrix, mesh.count);
            if (kind === 'fire' && mesh.instanceColor) updateEffectAttribute(mesh.instanceColor, mesh.count);
        }
        const inward = recipe.motion === 'inward', flashAge = inward ? t - 0.7 : t;
        this.core.scale.setScalar(r * (0.18 + smooth(flashAge, 0, 0.045) * 0.35) * (1 - smooth(flashAge, 0.045, 0.16)) * this.flashStrength);
        this.core.visible = flashAge >= 0 && flashAge < 0.16 && this.flashStrength > 0;
        const ringRadius = inward ? 1 - smooth(t, 0, 0.8) : Math.sqrt(Math.min(1, t / 0.48));
        this.ring.scale.setScalar(r * ringRadius * Math.sqrt(this.ringStrength));
        this.ring.position.y = 0.02;
        this.ring.material.opacity = (inward ? Math.sin(Math.PI * Math.min(1, t / 0.8)) : 1 - smooth(t, 0.08, 0.48)) * Math.min(0.8, this.ringStrength * 0.45);
        this.ring.visible = this.ring.material.opacity > 0.001;
    }

    release(): void {
        if (!this.busy || this.destroyed) return;
        this.busy = false; this.group.visible = false;
        const pool = pools.get(this.scene);
        if (pool && pool.filter(entry => !entry.busy).length > 8) {
            pool.splice(pool.indexOf(this), 1); this.destroy();
        }
    }

    private destroy(): void {
        this.destroyed = true;
        this.group.removeFromParent();
        for (const { mesh } of this.layers) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose(); }
        this.core.geometry.dispose(); this.core.material.dispose();
        this.ring.geometry.dispose(); this.ring.material.dispose();
    }

    static disposeScene(scene: THREE.Scene): void {
        for (const visual of pools.get(scene) ?? []) visual.destroy();
        pools.delete(scene);
    }
}
