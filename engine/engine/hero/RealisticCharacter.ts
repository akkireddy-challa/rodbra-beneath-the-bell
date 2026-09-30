import * as THREE from 'three';
import { MeshPhysicalNodeMaterial } from 'three/webgpu';
import { createCharacterSurfaceMaterial } from 'engine/hero/CharacterSurfaceMaterials.js';
import { CharacterEyeController } from 'engine/hero/CharacterEyeController.js';
import { SkinAppearanceState } from 'engine/hero/SkinAppearanceState.js';
import type { SkinTransmissionPass } from 'engine/hero/SkinTransmissionPass.js';

export interface RealisticCharacterOptions {
    resolveTexture: (index: number) => Promise<THREE.Texture>;
    environment: THREE.Texture | null;
    environmentIntensity: number;
    detailEnabled: boolean;
    transmission: SkinTransmissionPass | undefined;
    appearance: SkinAppearanceState;
}
const adopted = new WeakSet<THREE.Object3D>();

/** Opt-in material/eye adoption for an already-loaded authored character.
 * Loader textures, geometry, body mixer and postprocessing remain caller-owned.
 */
export class RealisticCharacter {
    readonly eyes: CharacterEyeController;
    readonly detailTextures = new Set<THREE.Texture>();
    hasExpressionMaps = false;
    private readonly originals: Array<{ mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }> = [];
    private readonly owned = new Set<THREE.Material>();
    private disposed = false;

    private constructor(readonly root: THREE.Object3D) { this.eyes = new CharacterEyeController(root); }

    static async create(root: THREE.Object3D, options: RealisticCharacterOptions): Promise<RealisticCharacter> {
        if (adopted.has(root)) throw new Error('Realistic character root already adopted');
        if (!Number.isFinite(options.environmentIntensity) || options.environmentIntensity < 0) throw new Error('Invalid character environment intensity');
        adopted.add(root);
        let actor: RealisticCharacter | undefined;
        try {
            actor = new RealisticCharacter(root);
            const sources = new Set<THREE.Material>();
            root.traverse(node => {
                if (!(node instanceof THREE.Mesh)) return;
                actor!.originals.push({ mesh: node, material: node.material });
                for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
                    sources.add(material);
                    if (material.userData.skinAtlasTexture !== undefined) {
                        for (const name of ['_face_uv', '_face_weight']) if (!node.geometry.hasAttribute(name)) throw new Error(`Skin atlas requires ${name} on ${node.name}`);
                    }
                    if (material.userData.skinFacialAtlasTexture !== undefined) {
                        if (material.userData.skinAtlasTexture === undefined || material.userData.skinFacialAtlasLayout !== 'detail-expression-halves-v1') throw new Error('Independent facial detail requires coverage and the packed layout contract');
                        for (const name of ['_facial_detail']) if (!node.geometry.hasAttribute(name)) throw new Error(`Facial detail requires ${name} on ${node.name}`);
                    }
                }
            });
            const requests = new Map<number, Promise<THREE.Texture>>();
            const texture = (value: unknown): Promise<THREE.Texture | undefined> => {
                if (value === undefined) return Promise.resolve(undefined);
                if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('Invalid authored skin texture index');
                if (!requests.has(value)) requests.set(value, options.resolveTexture(value));
                return requests.get(value)!;
            };
            const resolved = await Promise.all([...sources].map(async source => ({ source,
                atlas: await texture(source.userData.skinAtlasTexture), expression: await texture(source.userData.skinExpressionTexture),
                facialAtlas: await texture(source.userData.skinFacialAtlasTexture) })));
            const replacements = new Map<THREE.Material, THREE.Material>();
            for (const { source, atlas, expression, facialAtlas } of resolved) {
                if (atlas) actor.detailTextures.add(atlas);
                if (expression) { actor.detailTextures.add(expression); actor.hasExpressionMaps = true; }
                const facial = facialAtlas ? { atlas: facialAtlas } : undefined;
                if (facial) actor.detailTextures.add(facial.atlas);
                // Disabling relief must not mutate loader-owned material metadata or lose coverage.
                const input = options.detailEnabled ? source : source.clone();
                if (!options.detailEnabled) input.userData.skinMicroDetail = false;
                let material: THREE.Material;
                try { material = createCharacterSurfaceMaterial(input, atlas, options.transmission, expression, options.appearance, facial); }
                finally { if (input !== source) input.dispose(); }
                if (material === input) material = source;
                if (material !== source) {
                    actor.owned.add(material);
                    const physical = material as THREE.MeshPhysicalMaterial;
                    if (physical.isMeshPhysicalMaterial || material instanceof MeshPhysicalNodeMaterial) {
                        physical.envMap = options.environment;
                        physical.envMapIntensity = options.environmentIntensity;
                    }
                }
                replacements.set(source, material);
            }
            // Commit only after every dependency and material succeeds.
            for (const { mesh, material } of actor.originals) mesh.material = Array.isArray(material) ? material.map(m => replacements.get(m)!) : replacements.get(material)!;
            return actor;
        } catch (error) {
            actor?.dispose();
            adopted.delete(root);
            throw error;
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.eyes.reset();
        for (const { mesh, material } of this.originals) mesh.material = material;
        for (const material of this.owned) material.dispose();
        adopted.delete(this.root);
    }
}
