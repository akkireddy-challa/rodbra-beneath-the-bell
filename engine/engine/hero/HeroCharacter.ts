import * as THREE from 'three';
import { HeroFaceController } from 'engine/hero/HeroFaceController.js';
import { createHeroMaterial } from 'engine/hero/HeroMaterials.js';
import { validateHeroDefinition } from 'engine/hero/HeroCharacterDefinition.js';
import type { HeroCharacterDefinition } from 'engine/hero/HeroCharacterDefinition.js';

const adoptedRoots = new WeakSet<THREE.Object3D>();

/** Opt-in adapter for an engine-loaded skinned root. Body animation remains engine-owned. */
export class HeroCharacter {
    readonly face: HeroFaceController;
    private readonly originals: Array<{ mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }> = [];
    private readonly materials = new Set<THREE.Material>();
    private disposed = false;

    constructor(readonly root: THREE.Object3D, readonly definition: HeroCharacterDefinition) {
        validateHeroDefinition(definition);
        if (adoptedRoots.has(root)) throw new Error('Hero root already adopted');
        this.face = new HeroFaceController(root, definition);
        const byName = new Map(definition.surfaces.map(s => [s.material, s]));
        const seen = new Map<string, THREE.Material>();
        // Validate the whole root before changing any materials.
        root.traverse(object => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh) return;
            for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
                if (!(material as THREE.MeshStandardMaterial).isMeshStandardMaterial || !byName.has(material.name)) throw new Error(`Unassigned/non-PBR hero material: ${material.name}`);
                if (seen.has(material.name) && seen.get(material.name) !== material) throw new Error(`Ambiguous hero material: ${material.name}`);
                seen.set(material.name, material);
            }
            this.originals.push({ mesh, material: mesh.material });
        });
        if (!this.originals.length || definition.surfaces.some(s => !seen.has(s.material))) throw new Error('Hero surface list does not match the model');
        const replacements = new Map<THREE.Material, THREE.Material>();
        try {
            for (const [name, source] of seen) {
                const material = createHeroMaterial(source as THREE.MeshStandardMaterial, byName.get(name)!);
                replacements.set(source, material);
                this.materials.add(material);
            }
        } catch (error) {
            for (const material of this.materials) material.dispose();
            throw error;
        }
        for (const { mesh, material } of this.originals) {
            mesh.material = Array.isArray(material) ? material.map(m => replacements.get(m)!) : replacements.get(material)!;
        }
        adoptedRoots.add(root);
    }

    /** Releases owned material instances, restores source materials and neutral face. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.face.reset();
        for (const { mesh, material } of this.originals) mesh.material = material;
        for (const material of this.materials) material.dispose();
        adoptedRoots.delete(this.root);
    }
}
