import * as THREE from 'three';
import type { AnimationPose } from 'engine/animation/PoseTransition.js';

/** Bounded LOCAL rotation deltas relative to the evaluated pose, not bind.
 * Translation is deliberately absent: layers never own movement/collision. */
export interface ProceduralPoseLayer {
    rotations: ReadonlyMap<string, THREE.Quaternion>;
    weight: number;
    fadeIn: number;
    fadeOut: number;
    /** null holds until removed; otherwise elapsed GAMEPLAY seconds. */
    duration: number | null;
}

interface LayerState { spec: ProceduralPoseLayer; elapsed: number; release: number | null; releaseWeight: number; weight: number }

export class ProceduralPoseLayers {
    private readonly layers = new Map<string, LayerState>();
    private readonly delta = new THREE.Quaternion();
    private readonly inverse = new THREE.Quaternion();
    private readonly weighted = new THREE.Quaternion();
    private readonly pivot = new THREE.Vector3();

    set(name: string, spec: ProceduralPoseLayer): void {
        if (![spec.weight, spec.fadeIn, spec.fadeOut, spec.duration ?? 0].every(Number.isFinite)
            || spec.fadeIn < 0 || spec.fadeOut < 0 || (spec.duration !== null && spec.duration <= 0)) {
            throw new Error('Procedural pose layer requires finite weights and nonnegative timing');
        }
        const rotations = this.validateRotations(spec.rotations);
        this.layers.set(name, { spec: { ...spec, rotations, weight: THREE.MathUtils.clamp(spec.weight, 0, 1) },
            elapsed: 0, release: null, releaseWeight: 0, weight: 0 });
    }

    /** Streaming targets for a held layer. Does not retrigger its envelope,
     * extend duration or resurrect a releasing layer. Caller owns target
     * smoothing; set() remains the explicit retrigger API. */
    updateTargets(name: string, rotations: ReadonlyMap<string, THREE.Quaternion>): boolean {
        const layer = this.layers.get(name);
        if (!layer || layer.release !== null) return false;
        layer.spec = { ...layer.spec, rotations: this.validateRotations(rotations) };
        return true;
    }

    private validateRotations(input: ReadonlyMap<string, THREE.Quaternion>): Map<string, THREE.Quaternion> {
        const rotations = new Map<string, THREE.Quaternion>();
        for (const [bone, q] of input) {
            if (![q.x, q.y, q.z, q.w].every(Number.isFinite) || q.lengthSq() < 1e-8) {
                throw new Error(`Invalid procedural rotation for ${bone}`);
            }
            const rotation = q.clone().normalize();
            const angle = 2 * Math.acos(Math.min(1, Math.abs(rotation.w)));
            if (angle > Math.PI / 4) rotation.slerp(new THREE.Quaternion(), 1 - (Math.PI / 4) / angle);
            rotations.set(bone, rotation);
        }
        return rotations;
    }

    remove(name: string): void {
        const layer = this.layers.get(name);
        if (layer && layer.release === null) { layer.release = 0; layer.releaseWeight = layer.weight; }
    }

    update(deltaTime: number): void {
        const dt = Number.isFinite(deltaTime) ? THREE.MathUtils.clamp(deltaTime, 0, .1) : 0;
        for (const [name, layer] of this.layers) {
            layer.elapsed += dt;
            if (layer.release !== null) {
                layer.release += dt;
                layer.weight = layer.releaseWeight * (1 - this.envelope(layer.release, layer.spec.fadeOut));
                if (layer.release >= layer.spec.fadeOut) this.layers.delete(name);
            } else {
                layer.weight = layer.spec.weight * this.envelope(layer.elapsed, layer.spec.fadeIn);
                if (layer.spec.duration !== null) {
                    layer.weight *= this.envelope(Math.max(0, layer.spec.duration - layer.elapsed), layer.spec.fadeOut);
                    if (layer.elapsed >= layer.spec.duration) this.layers.delete(name);
                }
            }
        }
    }

    /** Carry descendants with the joint, preserving lengths on BOTH renderers. */
    apply(pose: AnimationPose, bones: Map<string, THREE.Bone>, resolve: (name: string) => string | null): void {
        for (const layer of this.layers.values()) {
            if (layer.weight <= 0) continue;
            this.applyLocalRotations(pose, bones, layer.spec.rotations, layer.weight, resolve);
        }
    }

    /** Shared FK path for legacy held-stance offsets (which are not clamped or
     * faded) and the bounded named layers above. Never mutates source bones. */
    applyLocalRotations(pose: AnimationPose, bones: Map<string, THREE.Bone>,
        rotations: ReadonlyMap<string, THREE.Quaternion>, weight: number, resolve: (name: string) => string | null): void {
        for (const [alias, rotation] of rotations) {
            const name = pose.has(alias) ? alias : resolve(alias);
            const joint = name ? pose.get(name) : null;
            const bone = name ? bones.get(name) : null;
            if (!joint || !bone) continue; // A rig may deliberately have no fingers/toes.
            this.weighted.identity().slerp(rotation, weight);
            this.inverse.copy(joint.rotation).invert();
            this.delta.copy(joint.rotation).multiply(this.weighted).multiply(this.inverse).normalize();
            this.pivot.copy(joint.position);
            bone.traverse(child => {
                const value = pose.get(child.name);
                if (!value) return;
                value.position.sub(this.pivot).applyQuaternion(this.delta).add(this.pivot);
                value.rotation.premultiply(this.delta).normalize();
            });
        }
    }

    clear(): void { this.layers.clear(); }
    get size(): number { return this.layers.size; }
    private envelope(time: number, duration: number): number {
        return duration <= 0 ? 1 : THREE.MathUtils.smoothstep(time, 0, duration);
    }
}
