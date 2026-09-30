import * as THREE from 'three';

/**
 * The flash at the end of the barrel — a burst of emissive blocks plus a real
 * point light, both living INSIDE the view-model scene.
 *
 * Being in that scene is the point: the light actually illuminates the weapon
 * (which is what sells a muzzle flash — the gun briefly lighting itself), while
 * it cannot leak into world lighting, be eaten by world fog, or smear through
 * depth of field.
 *
 * The light is NOT owned here. It belongs to ViewModelLayer's permanent rig and
 * is merely driven — positioned, recoloured, and animated from zero intensity
 * and back. On WebGPU, changing the set of lights a scene contains forces a
 * synchronous recompile of every material in it, so a light that came and went
 * with the weapon would stall the frame on equip AND on unequip. Because the
 * layer's light always exists, only uniforms change here, and those are free.
 * PointLightPool keeps the world's light count stable for the same reason.
 */

export interface MuzzleFlashOptions {
    /** Peak point-light intensity multiplier. */
    intensity: number;
    /** Size multiplier for the flash blocks, in metres. */
    scale: number;
    /** Flash colour, or null to take the weapon's projectile colour. */
    color: number | null;
    /** How long a flash lasts, seconds. */
    durationSeconds: number;
}

export const DEFAULT_MUZZLE_FLASH_OPTIONS: MuzzleFlashOptions = {
    intensity: 1,
    scale: 1,
    color: null,
    // Short, but not so short it can fall between frames: at 0.055s a 60Hz
    // display got three frames of it, and the tail two were already almost
    // fully decayed. Four to five visible frames reads as a flash; fewer reads
    // as nothing happening.
    durationSeconds: 0.075,
};

/** Warm ballistic flash, used when the weapon has no colour of its own. */
const DEFAULT_FLASH_COLOR = 0xffcc66;

/** How many blocks make the radial burst. */
const BURST_BLADES = 8;

/** Exponential decay constant, seconds. */
const DECAY_TAU = 0.018;

/**
 * Peak point-light intensity.
 *
 * Has to be read against the layer's OWN rig, which is deliberately bright so a
 * weapon stays legible at midnight (ambient 1.8 + key 3.6 + fill 1.4). A flash
 * that merely matches that baseline is invisible — it has to overpower it, and
 * over a short enough window that it reads as a burst rather than a lamp.
 */
const PEAK_LIGHT_INTENSITY = 45;

const _lightPosition = new THREE.Vector3();

export class MuzzleFlash {
    private readonly options: MuzzleFlashOptions;
    private readonly group = new THREE.Group();
    /** Borrowed from ViewModelLayer; null when the layer is unavailable. */
    private readonly light: THREE.PointLight | null;
    private readonly material: THREE.MeshBasicMaterial;
    private readonly blades: THREE.Mesh[] = [];
    private readonly geometry: THREE.BoxGeometry;

    private elapsed = Number.POSITIVE_INFINITY;
    private attached: THREE.Object3D | null = null;

    constructor(options: MuzzleFlashOptions = DEFAULT_MUZZLE_FLASH_OPTIONS, light: THREE.PointLight | null = null) {
        this.options = options;
        this.group.name = 'MuzzleFlash';

        const color = options.color ?? DEFAULT_FLASH_COLOR;

        // Driven, never created or parented here — see the class note.
        this.light = light;
        if (this.light) this.light.color.setHex(color);

        // Additive and un-tone-mapped: a flash is light being added to the
        // frame, not a surface being shaded.
        this.material = new THREE.MeshBasicMaterial({
            color,
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthWrite: false,
            toneMapped: false,
            opacity: 0,
        });

        // Blocky rather than a textured billboard — the voxel look is
        // deliberate, and a radial fan of boxes reads as a star at this size.
        // Sized to read at a glance against a bright view model. The earlier
        // 2cm blades were technically drawing and effectively invisible.
        this.geometry = new THREE.BoxGeometry(0.035, 0.035, 0.22);
        for (let i = 0; i < BURST_BLADES; i++) {
            const blade = new THREE.Mesh(this.geometry, this.material);
            blade.rotation.z = (i / BURST_BLADES) * Math.PI * 2;
            blade.frustumCulled = false;
            blade.scale.setScalar(0);
            this.blades.push(blade);
            this.group.add(blade);
        }
    }

    /**
     * Add the flash to the view model ONCE, for the lifetime of the system.
     *
     * Attaching and detaching per equip would change the set of lights the
     * view-model scene contains, and on WebGPU that forces a synchronous
     * recompile of every material in the scene — a multi-hundred-millisecond
     * freeze on the exact frame the player picks a weapon up. Swapping weapons
     * moves this with setMuzzleOffset instead; the light never leaves.
     */
    attachTo(parent: THREE.Object3D, muzzleOffset: THREE.Vector3): void {
        if (this.attached === parent) {
            this.group.position.copy(muzzleOffset);
            return;
        }
        this.detach();
        this.group.position.copy(muzzleOffset);
        parent.add(this.group);
        this.attached = parent;
    }

    /** Move the flash to a new weapon's muzzle without touching the scene graph. */
    setMuzzleOffset(muzzleOffset: THREE.Vector3): void {
        this.group.position.copy(muzzleOffset);
    }

    /** World-space position of the muzzle, for placing the borrowed light. */
    private syncLightPosition(): void {
        if (!this.light) return;
        // Force the parent chain up to date: this runs mid-frame, before the
        // renderer refreshes world matrices, and the weapon above us has just
        // been re-posed by the rig.
        this.group.updateWorldMatrix(true, false);
        this.group.getWorldPosition(_lightPosition);
        this.light.position.copy(_lightPosition);
    }

    detach(): void {
        this.attached?.remove(this.group);
        this.attached = null;
    }

    /** Recolour, e.g. when a weapon with a coloured projectile is equipped. */
    setColor(color: number): void {
        this.light?.color.setHex(color);
        this.material.color.setHex(color);
    }

    /** Fire one flash. Restarts an in-flight one rather than stacking. */
    trigger(): void {
        this.elapsed = 0;
        // A fresh random roll each shot, so a burst does not look stamped.
        for (const blade of this.blades) blade.rotation.x = Math.random() * Math.PI * 2;
    }

    update(deltaTime: number): void {
        if (this.elapsed > this.options.durationSeconds) {
            if (this.material.opacity !== 0) {
                if (this.light) this.light.intensity = 0;
                this.material.opacity = 0;
                for (const blade of this.blades) blade.scale.setScalar(0);
            }
            return;
        }
        this.elapsed += deltaTime;

        const fade = Math.exp(-this.elapsed / DECAY_TAU);
        if (this.light) {
            // The light lives at the scene root, so it has to be moved to the
            // muzzle rather than inheriting the weapon's transform.
            this.syncLightPosition();
            this.light.intensity = PEAK_LIGHT_INTENSITY * this.options.intensity * fade;
        }
        this.material.opacity = fade;

        const size = this.options.scale * (0.9 + fade * 0.35);
        for (const blade of this.blades) blade.scale.setScalar(size);
    }

    dispose(): void {
        // The light is the layer's, not ours: hand it back dark, never remove it.
        if (this.light) this.light.intensity = 0;
        this.detach();
        this.geometry.dispose();
        this.material.dispose();
        this.blades.length = 0;
    }
}
