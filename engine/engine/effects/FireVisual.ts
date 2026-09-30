import * as THREE from 'three';
import { EffectShape, effectInstances, namedRecipe, resolveShape, DEFAULT_EFFECT_SHAPE_OPTIONS, type EffectShapeOptions } from 'engine/effects/EffectShapes.js';
import { updateEffectAttribute, effectGeometry, effectDensity, effectRandom, effectNumber, effectPosition, EFFECT_UP, type VFXStyle } from 'engine/effects/VFXUtils.js';

export type FirePreset = 'torch' | 'campfire' | 'flamethrower' | 'engine-exhaust' | 'fire-wall';
export interface FireRecipe { color: number; tip: number; width: number; length: number; smoke: number; embers: number; cycle: number; wall: boolean }
export const FIRE_PRESETS: Readonly<Record<FirePreset, FireRecipe>> = {
    torch: { color: 0xffaa35, tip: 0xc62e09, width: 0.2, length: 1.6, smoke: 0.35, embers: 0.4, cycle: 0.8, wall: false },
    campfire: { color: 0xffbd45, tip: 0xcb3510, width: 0.65, length: 1.7, smoke: 1, embers: 0.8, cycle: 1.4, wall: false },
    flamethrower: { color: 0xffb751, tip: 0xe8440e, width: 0.4, length: 4.5, smoke: 0.35, embers: 0.8, cycle: 0.55, wall: false },
    'engine-exhaust': { color: 0xa9f4ff, tip: 0x425ec7, width: 0.24, length: 3.5, smoke: 0, embers: 0.2, cycle: 0.45, wall: false },
    'fire-wall': { color: 0xffa82b, tip: 0xb72c12, width: 0.3, length: 2.1, smoke: 0.65, embers: 0.8, cycle: 1.2, wall: true },
};
export class FireVisual extends EffectShape {
    private readonly flame;
    private readonly smoke;
    private readonly embers;
    private readonly layers;
    private readonly data = new Float32Array(192 * 4);
    private options = DEFAULT_EFFECT_SHAPE_OPTIONS;
    private recipe = FIRE_PRESETS.torch;
    private readonly rotation = new THREE.Quaternion();
    private readonly start = new THREE.Color();
    private readonly end = new THREE.Color();
    constructor(scene: THREE.Scene, style: VFXStyle) {
        super(scene, 'Fire');
        const geometry = effectGeometry(style);
        this.flame = effectInstances(geometry, new THREE.MeshBasicMaterial({ toneMapped: false }), 192, 'Fire:flame');
        this.smoke = effectInstances(geometry, new THREE.MeshLambertMaterial({ color: 0x66616b, flatShading: true }), 64, 'Fire:smoke');
        this.embers = effectInstances(geometry, new THREE.MeshBasicMaterial({ color: 0xffd293, toneMapped: false }), 64, 'Fire:embers');
        this.layers = [this.flame, this.smoke, this.embers];
        this.flame.layers.enable(1); this.embers.layers.enable(1); this.group.add(this.flame, this.smoke, this.embers);
    }
    rearm(preset: FirePreset, position: THREE.Vector3, options: EffectShapeOptions): void {
        this.assertLive(); this.recipe = namedRecipe(FIRE_PRESETS, preset); this.options = resolveShape(options); this.moveTo(position);
        this.group.name = `Fire:${preset}`; this.setDirection(options.direction);
        const density = effectDensity(options.quality) * this.options.amount;
        this.flame.count = Math.min(192, Math.round((this.recipe.wall || this.recipe.length > 3 ? 96 : 56) * density));
        this.smoke.count = Math.min(64, Math.round(22 * this.recipe.smoke * density));
        this.embers.count = Math.min(64, Math.round(28 * this.recipe.embers * density));
        const random = effectRandom(options.seed);
        for (let i = 0; i < 192; i++) {
            this.data[i * 4] = random(); this.data[i * 4 + 1] = random() * Math.PI * 2;
            this.data[i * 4 + 2] = 1 + (random() - 0.5) * this.options.variance;
            this.data[i * 4 + 3] = random() * 2 - 1;
        }
        this.start.set(options.color); this.end.set(this.recipe.tip); this.setProgress(0);
    }
    setDirection(direction: THREE.Vector3): void {
        effectPosition(direction);
        const length = direction.length();
        this.rotation.setFromUnitVectors(EFFECT_UP, length > 1e-8 ? this.dummy.position.copy(direction).divideScalar(length) : EFFECT_UP);
    }
    /** Seconds normalized by a fixed four-second inspection period; births wrap continuously. */
    setProgress(progress: number): void {
        if (this.disposed) return;
        const seconds = effectNumber(progress, 'progress', 0, Number.MAX_SAFE_INTEGER) * 4;
        const r = this.options.radius, recipe = this.recipe, d = this.dummy;
        this.group.visible = true;
        for (let layer = 0; layer < this.layers.length; layer++) {
            const mesh = this.layers[layer]!;
            for (let i = 0; i < mesh.count; i++) {
                const k = i * 4, age = (seconds / (recipe.cycle * (layer === 1 ? 2 : 1)) + this.data[k]!) % 1;
                const angle = this.data[k + 1]! + age * 2.5, variation = this.data[k + 2]!;
                const spread = recipe.width * (layer === 1 ? 0.5 + age : (1 - age * 0.7) * Math.sqrt(Math.abs(this.data[k + 3]!)));
                d.position.set((Math.cos(angle) * spread + (recipe.wall ? this.data[k + 3]! * 1.8 : 0)) * r,
                    (age * recipe.length + (layer === 1 ? recipe.length * 0.55 : 0)) * r, Math.sin(angle) * spread * r);
                d.position.applyQuaternion(this.rotation);
                const envelope = Math.sin(Math.PI * age);
                const size = r * variation * envelope * (layer === 0 ? (recipe.wall ? 0.3 : 0.28) * (1 - age * 0.75) : layer === 1 ? 0.18 + age * 0.35 : 0.022);
                d.scale.set(size, size * (layer === 0 ? recipe.length > 3 ? 4 : 2.2 : 1), size);
                d.rotation.set(0, angle, 0); d.quaternion.premultiply(this.rotation);
                d.updateMatrix(); mesh.setMatrixAt(i, d.matrix);
                if (layer === 0) { this.color.copy(this.start).lerp(this.end, age).multiplyScalar(0.8 + variation * 0.2); mesh.setColorAt(i, this.color); }
            }
            updateEffectAttribute(mesh.instanceMatrix, mesh.count); if (mesh.instanceColor) updateEffectAttribute(mesh.instanceColor, mesh.count);
        }
    }
}
