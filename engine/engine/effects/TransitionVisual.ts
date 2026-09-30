import * as THREE from 'three';
import { EffectShape, effectInstances, namedRecipe, resolveShape, DEFAULT_EFFECT_SHAPE_OPTIONS, type EffectShapeOptions } from 'engine/effects/EffectShapes.js';
import { updateEffectAttribute, effectGeometry, effectDensity, effectRandom, effectNumber, effectPosition, type VFXStyle } from 'engine/effects/VFXUtils.js';

export type TransitionPreset = 'dissolve' | 'materialize' | 'teleport-in' | 'teleport-out' | 'spawn' | 'despawn';
export const TRANSITION_PRESETS = {
    dissolve: { color: 0xffb062, duration: 1.5, incoming: false }, materialize: { color: 0x84e6d8, duration: 1.5, incoming: true },
    'teleport-in': { color: 0x9b92ff, duration: 1.1, incoming: true }, 'teleport-out': { color: 0x9b92ff, duration: 1.1, incoming: false },
    spawn: { color: 0x88dcff, duration: 1.3, incoming: true }, despawn: { color: 0xff99cf, duration: 1.3, incoming: false },
} satisfies Record<TransitionPreset, { color: number; duration: number; incoming: boolean }>;
interface MaterialRecord { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[] }
/** Alpha-hashed copies fade the actual object without mutating materials shared by other objects. */
export class TransitionVisual extends EffectShape {
    private readonly particles;
    private readonly ring;
    private readonly data = new Float32Array(128 * 4);
    private readonly records: MaterialRecord[] = [];
    private readonly copies = new Map<THREE.Material, THREE.Material>();
    private readonly activeMaterials = new Set<THREE.Material>();
    private readonly bounds = new THREE.Box3();
    private readonly size = new THREE.Vector3();
    private target: THREE.Object3D | null = null;
    private visibleBefore = true;
    private options = DEFAULT_EFFECT_SHAPE_OPTIONS;
    private preset: TransitionPreset = 'dissolve';
    constructor(scene: THREE.Scene, style: VFXStyle) {
        super(scene, 'Transition');
        this.particles = effectInstances(effectGeometry(style), new THREE.MeshBasicMaterial({ toneMapped: false }), 128, 'Transition:particles');
        this.ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, style === 'voxel' ? 4 : 64),
            new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
        this.ring.name = 'Transition:ring'; this.ring.rotation.x = -Math.PI / 2;
        this.group.add(this.particles, this.ring); this.particles.layers.enable(1); this.ring.layers.enable(1);
    }
    static validateTarget(target: THREE.Object3D): void {
        let meshes = 0; const materials = new Set<THREE.Material>();
        target.traverse(child => { if (child instanceof THREE.Mesh) {
            meshes++; for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
        } });
        if (meshes === 0) throw new Error('Transition target must contain a mesh');
        if (materials.size > 128) throw new Error('Transition target exceeds 128 unique materials');
        target.updateWorldMatrix(true, true);
        const bounds = new THREE.Box3().setFromObject(target);
        if (bounds.isEmpty()) throw new Error('Transition target must contain nonempty geometry');
        effectPosition(bounds.min); effectPosition(bounds.max);
    }
    overlaps(target: THREE.Object3D): boolean {
        if (!this.target) return false;
        for (let node: THREE.Object3D | null = target; node; node = node.parent) if (node === this.target) return true;
        for (let node: THREE.Object3D | null = this.target; node; node = node.parent) if (node === target) return true;
        return false;
    }
    rearm(preset: TransitionPreset, target: THREE.Object3D, options: EffectShapeOptions): void {
        this.assertLive(); namedRecipe(TRANSITION_PRESETS, preset); TransitionVisual.validateTarget(target);
        this.retire(); this.options = resolveShape(options); this.preset = preset;
        this.target = target; this.visibleBefore = target.visible;
        target.updateWorldMatrix(true, true); this.bounds.setFromObject(target); this.bounds.getSize(this.size);
        this.bounds.getCenter(this.group.position); this.size.clampScalar(0.05, 1000);
        target.traverse(child => { if (child instanceof THREE.Mesh) this.records.push({ mesh: child, original: child.material }); });
        const originals = new Set(this.records.flatMap(r => Array.isArray(r.original) ? r.original : [r.original]));
        if (this.copies.size + [...originals].filter(m => !this.copies.has(m)).length > 128) {
            this.copies.forEach(m => m.dispose()); this.copies.clear();
        }
        for (const original of originals) {
            let copy = this.copies.get(original);
            if (!copy) { copy = original.clone(); this.copies.set(original, copy); }
            else copy.copy(original);
            copy.onBeforeCompile = original.onBeforeCompile; copy.customProgramCacheKey = original.customProgramCacheKey;
            copy.alphaHash = true; copy.transparent = false; copy.depthWrite = true;
            this.activeMaterials.add(original);
        }
        for (const record of this.records) record.mesh.material = Array.isArray(record.original)
            ? record.original.map(m => this.copies.get(m)!) : this.copies.get(record.original)!;
        target.visible = true; this.group.name = `Transition:${preset}`;
        this.particles.count = Math.min(128, Math.round(48 * this.options.amount * effectDensity(options.quality)));
        this.particles.material.color.set(options.color); this.ring.material.color.set(options.color);
        const random = effectRandom(options.seed);
        for (let i = 0; i < 128 * 4; i++) this.data[i] = random();
        this.setProgress(0);
    }
    setProgress(progress: number): void {
        if (this.disposed || !this.target) return;
        const t = effectNumber(progress, 'progress', 0, 1), incoming = TRANSITION_PRESETS[this.preset].incoming;
        const phase = incoming ? 1 - t : t;
        const opacity = 1 - THREE.MathUtils.smoothstep(phase, 0.08, 0.9);
        for (const original of this.activeMaterials) this.copies.get(original)!.opacity = original.opacity * opacity;
        this.target.visible = t < 1 || incoming; this.group.visible = t < 1;
        const d = this.dummy, teleport = this.preset.startsWith('teleport');
        const envelope = Math.sin(Math.PI * t);
        for (let i = 0; i < this.particles.count; i++) {
            const k = i * 4, a = this.data[k]! * Math.PI * 2 + phase * 2;
            const travel = 0.5 + phase * this.options.radius;
            d.position.set(Math.cos(a) * this.size.x * travel * 0.65,
                (this.data[k + 1]! - 0.5) * this.size.y + phase * (teleport ? 1.5 : 0.65), Math.sin(a) * this.size.z * travel * 0.65);
            const size = Math.max(this.size.x, this.size.y, this.size.z) * 0.035 * (0.6 + this.data[k + 2]! * this.options.variance) * envelope;
            d.scale.set(size, size * (teleport ? 5 : 1), size); d.rotation.set(phase * 3, a, phase);
            d.updateMatrix(); this.particles.setMatrixAt(i, d.matrix);
        }
        updateEffectAttribute(this.particles.instanceMatrix, this.particles.count);
        this.ring.visible = this.preset !== 'dissolve' && this.preset !== 'materialize';
        this.ring.position.y = -this.size.y * 0.5 + (teleport ? phase * this.size.y : 0);
        this.ring.scale.setScalar(Math.max(this.size.x, this.size.z) * (0.6 + phase * 0.6));
        this.ring.material.opacity = envelope * 0.75;
    }
    override retire(completed = false): void {
        for (const { mesh, original } of this.records) mesh.material = original;
        if (this.target) this.target.visible = completed ? TRANSITION_PRESETS[this.preset].incoming : this.visibleBefore;
        this.records.length = 0; this.activeMaterials.clear(); this.target = null; super.retire();
    }
    override dispose(): void {
        if (this.disposed) return;
        super.dispose(); this.copies.forEach(material => material.dispose()); this.copies.clear();
    }
}
