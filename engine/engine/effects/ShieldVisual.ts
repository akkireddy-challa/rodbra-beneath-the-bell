import * as THREE from 'three';
import { EffectShape, effectInstances, namedRecipe, resolveShape, DEFAULT_EFFECT_SHAPE_OPTIONS, type EffectShapeOptions } from 'engine/effects/EffectShapes.js';
import { updateEffectAttribute, effectDensity, effectNumber, effectRandom, type VFXStyle } from 'engine/effects/VFXUtils.js';

export type ShieldPreset = 'bubble' | 'dome' | 'hex-shield' | 'barrier' | 'hit-ripple' | 'shield-break';
export const SHIELD_PRESETS = {
    bubble: { color: 0x4bafff, duration: 0 }, dome: { color: 0x62dfd1, duration: 0 },
    'hex-shield': { color: 0x8f79ff, duration: 0 }, barrier: { color: 0xf6ba62, duration: 0 },
    'hit-ripple': { color: 0xc0ebff, duration: 0.65 }, 'shield-break': { color: 0x799eff, duration: 1.1 },
} satisfies Record<ShieldPreset, { color: number; duration: number }>;
const FORWARD = new THREE.Vector3(0, 0, 1);
export class ShieldVisual extends EffectShape {
    private readonly shell;
    private readonly dome;
    private readonly wire;
    private readonly panels;
    private readonly rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
    private readonly direction = new THREE.Vector3();
    private readonly jitter = new Float32Array(96);
    private options = DEFAULT_EFFECT_SHAPE_OPTIONS;
    private preset: ShieldPreset = 'bubble';
    private panelsReady = false;
    constructor(scene: THREE.Scene, style: VFXStyle) {
        super(scene, 'Shield');
        const segments = style === 'voxel' ? 8 : 24;
        const sphere = new THREE.SphereGeometry(1, segments, style === 'voxel' ? 4 : 12);
        const material = () => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
        this.shell = new THREE.Mesh(sphere, material());
        this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, segments, 8, 0, Math.PI * 2, 0, Math.PI / 2), material());
        this.wire = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, depthWrite: false, wireframe: true, toneMapped: false }));
        this.panels = effectInstances(new THREE.CircleGeometry(1, style === 'voxel' ? 4 : 6), material(), 96, 'Shield:panels');
        this.shell.name = 'Shield:shell'; this.dome.name = 'Shield:dome'; this.wire.name = 'Shield:wire';
        this.group.add(this.shell, this.dome, this.wire, this.panels);
        for (let i = 0; i < 3; i++) {
            const ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, segments * 2), material());
            ring.name = 'Shield:ripple'; this.rings.push(ring); this.group.add(ring);
        }
        this.group.traverse(child => { if (child instanceof THREE.Mesh) child.layers.enable(1); });
    }
    rearm(preset: ShieldPreset, position: THREE.Vector3, options: EffectShapeOptions): void {
        this.assertLive(); namedRecipe(SHIELD_PRESETS, preset); this.options = resolveShape(options); this.preset = preset;
        this.moveTo(position); this.group.name = `Shield:${preset}`; this.group.quaternion.identity();
        if (preset === 'barrier' || preset === 'hit-ripple') {
            this.direction.copy(options.direction); if (this.direction.lengthSq() < 1e-8) this.direction.copy(FORWARD);
            this.group.quaternion.setFromUnitVectors(FORWARD, this.direction.normalize());
        }
        const random = effectRandom(options.seed); for (let i = 0; i < 96; i++) this.jitter[i] = random();
        this.panels.count = Math.min(96, Math.round(56 * effectDensity(options.quality) * this.options.amount));
        this.group.traverse(child => { if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) child.material.color.set(options.color); });
        this.panelsReady = false; this.setProgress(0);
    }
    setProgress(progress: number): void {
        if (this.disposed) return;
        const t = effectNumber(progress, 'progress', 0, Number.MAX_SAFE_INTEGER), r = this.options.radius, d = this.dummy;
        const pulse = 0.85 + Math.sin(t * Math.PI * 2) * 0.15;
        const burst = this.preset === 'shield-break', hit = this.preset === 'hit-ripple';
        this.group.visible = !(burst || hit) || t < 1;
        this.shell.visible = this.preset === 'bubble' || this.preset === 'hex-shield';
        this.dome.visible = this.preset === 'dome'; this.wire.visible = this.preset === 'bubble';
        for (const mesh of [this.shell, this.dome, this.wire]) mesh.scale.setScalar(r);
        this.shell.material.opacity = 0.09 * pulse; this.dome.material.opacity = 0.2 * pulse;
        this.wire.material.opacity = 0.28 * pulse;
        this.panels.visible = burst || this.preset === 'hex-shield' || this.preset === 'barrier';
        this.panels.material.opacity = burst ? (1 - t) * 0.85 : 0.38 * pulse;
        if (this.panels.visible && (burst || !this.panelsReady)) {
            for (let i = 0; i < this.panels.count; i++) {
                const y = 1 - 2 * (i + 0.5) / Math.max(1, this.panels.count), a = i * 2.399963;
                this.direction.set(Math.cos(a) * Math.sqrt(1 - y * y), y, Math.sin(a) * Math.sqrt(1 - y * y));
                if (this.preset === 'barrier') {
                    const columns = Math.max(1, Math.ceil(Math.sqrt(this.panels.count)));
                    const spacing = 2 * r / columns;
                    d.position.set((i % columns - (columns - 1) / 2) * spacing, (Math.floor(i / columns) - (columns - 1) / 2) * spacing, 0);
                    d.quaternion.identity(); d.scale.setScalar(spacing * 0.48);
                } else {
                    d.position.copy(this.direction).multiplyScalar(r * (burst ? 1 + t * (1.3 + this.jitter[i]! * this.options.variance) : 1.005));
                    if (burst) d.position.y -= r * t * t;
                    d.quaternion.setFromUnitVectors(FORWARD, this.direction);
                    if (burst) d.rotateZ(t * (3 + this.jitter[i]! * 4));
                    d.scale.setScalar(r * (burst ? 0.19 * (1 - t) : 0.22));
                }
                d.updateMatrix(); this.panels.setMatrixAt(i, d.matrix);
            }
            updateEffectAttribute(this.panels.instanceMatrix, this.panels.count);
            this.panelsReady = true;
        }
        this.rings.forEach((ring, i) => {
            ring.visible = hit || (this.preset === 'dome' && i === 0);
            ring.rotation.set(this.preset === 'dome' ? -Math.PI / 2 : 0, 0, 0);
            const age = Math.max(0, t - i * 0.13);
            ring.scale.setScalar(r * (hit ? Math.sqrt(age) * 1.7 : 1));
            ring.material.opacity = hit ? Math.sin(Math.PI * Math.min(1, age)) * (1 - Math.min(1, t)) * 1.5 : 0.65 * pulse;
        });
    }
}
