import * as THREE from 'three';
import {
    CustomEffectVisual, DEFAULT_CUSTOM_EFFECT_OPTIONS, effectDensity, effectNumber, effectRandom, updateEffectAttribute,
    type CustomEffectDefinition, type CustomEffectOptions, type VFXStyle,
} from 'engine/effects/index.js';

export interface RuneHaloOptions extends CustomEffectOptions {
    turns: number;
    rise: number;
}

const CAPACITY = 96;
const UP = new THREE.Vector3(0, 1, 0);

/** Copy into the game's code and edit its geometry, envelope and motion together. */
export class RuneHaloVisual extends CustomEffectVisual<RuneHaloOptions> {
    private readonly runes: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    private readonly phases = new Float32Array(CAPACITY);
    private options: Readonly<RuneHaloOptions> = RUNE_HALO_DEFAULTS;

    constructor(scene: THREE.Scene, style: VFXStyle) {
        super(scene, 'RuneHalo');
        const geometry = style === 'voxel' ? new THREE.BoxGeometry(1, 1, 1) : new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
        this.runes = new THREE.InstancedMesh(geometry,
            new THREE.MeshBasicMaterial({ toneMapped: false }), CAPACITY);
        this.runes.name = 'RuneHalo:runes';
        this.runes.frustumCulled = false;
        this.runes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(this.runes);
    }

    rearm(position: THREE.Vector3, options: Readonly<RuneHaloOptions>): void {
        this.options = { ...options,
            turns: effectNumber(options.turns, 'turns', -8, 8), rise: effectNumber(options.rise, 'rise', -10, 10) };
        this.group.position.copy(position);
        // Direction is a world-space normal. The group owns only our decorative meshes.
        const direction = options.direction.clone();
        if (direction.lengthSq() < 1e-8) direction.copy(UP);
        this.group.quaternion.setFromUnitVectors(UP, direction.normalize());
        this.runes.material.color.set(options.color);
        this.runes.count = Math.min(CAPACITY, Math.round(24 * options.amount * effectDensity(options.quality)));
        const random = effectRandom(options.seed);
        for (let i = 0; i < this.runes.count; i++) this.phases[i] = random();
        // custom() invokes setProgress(0) after rearm; no clock or animation loop here.
    }

    setProgress(progress: number): void {
        const t = THREE.MathUtils.clamp(progress, 0, 1), o = this.options;
        const envelope = Math.sin(Math.PI * t), radius = o.radius * (0.35 + 0.65 * t);
        this.group.visible = t < 1;
        for (let i = 0; i < this.runes.count; i++) {
            const phase = this.phases[i]!, angle = (i / this.runes.count + t * o.turns) * Math.PI * 2;
            const size = o.radius * 0.08 * envelope * (1 + (phase - 0.5) * o.variance);
            this.dummy.position.set(Math.cos(angle) * radius, t * o.rise + Math.sin(angle * 3) * size, Math.sin(angle) * radius);
            this.dummy.rotation.set(0, -angle, phase * o.variance);
            this.dummy.scale.set(size, size * 4, size);
            this.dummy.updateMatrix(); this.runes.setMatrixAt(i, this.dummy.matrix);
        }
        updateEffectAttribute(this.runes.instanceMatrix, this.runes.count);
    }
    // Inherited retire/dispose cover this group's owned meshes, geometry and materials.
}

export const RUNE_HALO_DEFAULTS: RuneHaloOptions = {
    ...DEFAULT_CUSTOM_EFFECT_OPTIONS, color: 0x89e9ff, duration: 1.4, radius: 1.5, turns: 0.5, rise: 0.6,
};

/** Stable module-scope identity lets repeated casts reuse the same pooled visual. */
export const runeHalo: CustomEffectDefinition<RuneHaloOptions> = {
    defaults: RUNE_HALO_DEFAULTS,
    create: (scene, style) => new RuneHaloVisual(scene, style),
};
