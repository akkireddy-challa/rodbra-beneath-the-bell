import * as THREE from 'three';
import type { HeroCharacterDefinition, HeroMorphBinding } from 'engine/hero/HeroCharacterDefinition.js';
import { validateHeroDefinition } from 'engine/hero/HeroCharacterDefinition.js';

interface Slot { weights: number[]; index: number; rest: number; value: number }
interface Binding { slot: Slot; gain: number }

/** Call after the body's animation update. Owns only explicitly bound morph slots. */
export class HeroFaceController {
    private readonly slots: Slot[] = [];
    private readonly controls = new Map<string, { value: number; target: number; bindings: Binding[] }>();
    private readonly correctives: Array<{ drivers: string[]; binding: Binding }>;

    constructor(root: THREE.Object3D, definition: HeroCharacterDefinition) {
        validateHeroDefinition(definition);
        const meshes = new Map<string, THREE.Mesh[]>();
        root.traverse(object => {
            if (!(object as THREE.Mesh).isMesh) return;
            const matches = meshes.get(object.name) ?? [];
            matches.push(object as THREE.Mesh);
            meshes.set(object.name, matches);
        });
        const resolve = (binding: HeroMorphBinding): Binding => {
            const matches = meshes.get(binding.mesh);
            if (matches?.length !== 1) throw new Error(`Missing/ambiguous hero mesh: ${binding.mesh}`);
            const mesh = matches[0]!;
            const index = mesh.morphTargetDictionary?.[binding.target];
            const weights = mesh.morphTargetInfluences;
            if (index === undefined || !weights || !Number.isFinite(weights[index])) throw new Error(`Missing hero morph: ${binding.mesh}/${binding.target}`);
            let slot = this.slots.find(s => s.weights === weights && s.index === index);
            if (!slot) {
                slot = { weights, index, rest: weights[index]!, value: 0 };
                this.slots.push(slot);
            }
            return { slot, gain: binding.gain };
        };
        for (const [name, bindings] of Object.entries(definition.controls)) {
            this.controls.set(name, { value: 0, target: 0, bindings: bindings.map(resolve) });
        }
        this.correctives = definition.correctives.map(c => ({ drivers: c.drivers, binding: resolve(c.binding) }));
    }

    /** Replaces the entire input frame; omitted controls return to neutral. */
    setFrame(frame: Readonly<Record<string, number>>): void {
        for (const [name, value] of Object.entries(frame)) {
            if (!this.controls.has(name) || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid hero control: ${name}`);
        }
        for (const [name, control] of this.controls) control.target = Object.prototype.hasOwnProperty.call(frame, name) ? frame[name]! : 0;
    }

    /** Deterministic exponential smoothing; responseSeconds=0 applies exactly. */
    advance(deltaSeconds: number, responseSeconds: number): void {
        if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || !Number.isFinite(responseSeconds) || responseSeconds < 0) throw new Error('Invalid hero face timing');
        const alpha = responseSeconds === 0 ? 1 : -Math.expm1(-deltaSeconds / responseSeconds);
        for (const slot of this.slots) slot.value = 0;
        for (const control of this.controls.values()) {
            control.value = alpha === 1 ? control.target : control.value + (control.target - control.value) * alpha;
            for (const binding of control.bindings) binding.slot.value += control.value * binding.gain;
        }
        for (const corrective of this.correctives) {
            let weight = 1;
            for (const driver of corrective.drivers) weight *= this.controls.get(driver)!.value;
            corrective.binding.slot.value += weight * corrective.binding.gain;
        }
        for (const slot of this.slots) slot.weights[slot.index] = Math.min(1, slot.rest + slot.value);
    }

    reset(): void {
        for (const control of this.controls.values()) control.value = control.target = 0;
        for (const slot of this.slots) slot.weights[slot.index] = slot.rest;
    }
}
