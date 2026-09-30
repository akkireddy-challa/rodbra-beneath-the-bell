import * as THREE from 'three';
import { EffectShape, effectInstances, namedRecipe, resolveShape, DEFAULT_EFFECT_SHAPE_OPTIONS, type EffectShapeOptions } from 'engine/effects/EffectShapes.js';
import { updateEffectAttribute, effectDensity, effectRandom, effectNumber, EFFECT_UP, type VFXStyle } from 'engine/effects/VFXUtils.js';

export type SurfacePreset = 'scorch' | 'bullet-mark' | 'cracks' | 'wet-splash' | 'puddle' | 'ripples';
export const SURFACE_PRESETS = {
    scorch: { color: 0x26201b, duration: 30 }, 'bullet-mark': { color: 0x22232a, duration: 30 },
    cracks: { color: 0x292929, duration: 30 }, 'wet-splash': { color: 0x43869c, duration: 8 },
    puddle: { color: 0x4b8293, duration: 0 }, ripples: { color: 0xa3e3f5, duration: 1.8 },
} satisfies Record<SurfacePreset, { color: number; duration: number }>;
const FORWARD = new THREE.Vector3(0, 0, 1);
export class SurfaceVisual extends EffectShape {
    private readonly patches;
    private readonly cracks;
    private readonly rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
    private readonly data = new Float32Array(64 * 4);
    private options = DEFAULT_EFFECT_SHAPE_OPTIONS;
    private preset: SurfacePreset = 'scorch';
    private patchSpread = NaN;
    private cracksReady = false;
    constructor(scene: THREE.Scene, style: VFXStyle) {
        super(scene, 'Surface');
        const material = () => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.65, depthWrite: false,
            side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
        this.patches = effectInstances(new THREE.CircleGeometry(1, style === 'voxel' ? 4 : 12), material(), 64, 'Surface:patches');
        this.cracks = effectInstances(new THREE.PlaneGeometry(1, 1), material(), 64, 'Surface:cracks');
        this.group.add(this.patches, this.cracks);
        for (let i = 0; i < 3; i++) {
            const ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, style === 'voxel' ? 4 : 64), material());
            ring.name = 'Surface:ring'; this.rings.push(ring); this.group.add(ring);
        }
    }
    rearm(preset: SurfacePreset, position: THREE.Vector3, options: EffectShapeOptions): void {
        this.assertLive(); namedRecipe(SURFACE_PRESETS, preset); this.options = resolveShape(options); this.preset = preset;
        this.moveTo(position); this.group.name = `Surface:${preset}`;
        const normal = this.options.direction; if (normal.lengthSq() < 1e-8) normal.copy(EFFECT_UP); normal.normalize();
        this.group.position.addScaledVector(normal, 0.012); this.group.quaternion.setFromUnitVectors(FORWARD, normal);
        const random = effectRandom(options.seed);
        for (let i = 0; i < 64; i++) {
            this.data[i * 4] = i * 2.399963 + random() * this.options.variance;
            this.data[i * 4 + 1] = Math.sqrt(random()); this.data[i * 4 + 2] = 0.7 + random() * this.options.variance;
            this.data[i * 4 + 3] = random();
        }
        this.patches.count = Math.min(64, Math.max(1, Math.round(28 * options.amount * effectDensity(options.quality))));
        this.cracks.count = Math.min(64, Math.round(24 * options.amount * effectDensity(options.quality)));
        for (const mesh of [this.patches, this.cracks, ...this.rings]) mesh.material.color.set(options.color);
        this.patchSpread = NaN; this.cracksReady = false; this.setProgress(0);
    }
    setProgress(progress: number): void {
        if (this.disposed) return;
        const t = effectNumber(progress, 'progress', 0, 1), r = this.options.radius, d = this.dummy;
        this.group.visible = t < 1;
        const fade = 1 - THREE.MathUtils.smoothstep(t, 0.7, 1);
        const spreading = this.preset === 'wet-splash' ? 0.2 + 0.8 * THREE.MathUtils.smoothstep(t, 0, 0.12) : 1;
        this.patches.visible = this.preset !== 'cracks' && this.preset !== 'ripples' && this.options.amount > 0;
        this.cracks.visible = this.preset === 'cracks' || this.preset === 'bullet-mark';
        this.patches.material.opacity = (this.preset === 'puddle' || this.preset === 'wet-splash' ? 0.4 : 0.55) * fade;
        this.cracks.material.opacity = 0.8 * fade;
        if (this.patches.visible && spreading !== this.patchSpread) {
            for (let i = 0; i < this.patches.count; i++) {
                const k = i * 4, a = this.data[k]!, radius = this.data[k + 1]! * r * spreading;
                d.position.set(Math.cos(a) * radius, Math.sin(a) * radius, i * 0.00002);
                const size = (this.preset === 'bullet-mark' ? 0.2 : 0.4) * r * this.data[k + 2]! * spreading;
                if (this.preset === 'bullet-mark') d.position.multiplyScalar(0.28);
                d.scale.set(size, size * (0.7 + this.data[k + 3]! * 0.3), 1); d.rotation.set(0, 0, a); d.updateMatrix(); this.patches.setMatrixAt(i, d.matrix);
            }
            this.patchSpread = spreading; updateEffectAttribute(this.patches.instanceMatrix, this.patches.count);
        }
        if (this.cracks.visible && !this.cracksReady) {
            for (let i = 0; i < this.cracks.count; i++) {
                const k = i * 4, a = this.data[k]!, length = r * (0.3 + this.data[k + 1]! * 0.5);
                d.position.set(Math.cos(a) * length * 0.65, Math.sin(a) * length * 0.65, i * 0.00002);
                d.scale.set(length, r * 0.012 * this.data[k + 2]!, 1); d.rotation.set(0, 0, a + this.data[k + 3]! * 0.2);
                d.updateMatrix(); this.cracks.setMatrixAt(i, d.matrix);
            }
            this.cracksReady = true; updateEffectAttribute(this.cracks.instanceMatrix, this.cracks.count);
        }
        this.rings.forEach((ring, i) => {
            ring.visible = this.preset === 'ripples' || this.preset === 'wet-splash';
            const age = Math.max(0, t * (this.preset === 'wet-splash' ? 4 : 1) - i * 0.15);
            ring.scale.setScalar(r * Math.sqrt(age) * 1.8);
            ring.material.opacity = age < 1 ? Math.sin(Math.PI * age) * (1 - age) * 0.85 : 0;
        });
    }
}
