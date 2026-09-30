/**
 * One place that turns a character URL into a loaded model.
 *
 * The engine loads characters from three call sites — the player
 * (`PlayerLoader`), NPCs (`NpcManager`) and remote players
 * (`NetworkCharacterController`) — and each one used to call `GLTFLoader.load`
 * directly. Adding a second format at each of them would be three chances for
 * the branches to drift; this is the only place that knows more than one
 * character format exists.
 *
 * Promise-shaped rather than callback-shaped because every caller already
 * awaited its own wrapper around `loader.load`.
 */
import type * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { activeMaterialQuality } from 'engine/DeviceQuality.js';
import { applyClassedCharacterMaterials } from 'engine/loaders/CharacterClassedMaterials.js';
import { instantiateVxlCharacter, isVxlCharacterUrl, loadVxlCharacterTemplate } from 'engine/loaders/VxlCharacterLoader.js';

/**
 * What a character load hands back. Deliberately the subset of GLTF the
 * character path actually reads, so a `.vxl` can satisfy it in full rather than
 * pretending to be a glTF document.
 */
export interface LoadedCharacterModel {
    scene: THREE.Object3D;
    animations: THREE.AnimationClip[];
}

export interface LoadCharacterModelOptions {
    /** Forwarded to the vxl path; ignored for GLB. See `InstantiateVxlOptions`. */
    rigidJointMeshes?: boolean;
    /**
     * Voxel level to build a `.vxl` body from (0 = full detail, the default).
     * NPCs pass the device tier's `characterBodyLod`; the player and remote
     * players leave it at 0. Ignored for GLB.
     */
    bodyLod?: number;
}

/**
 * Load a character from a `.vxl` (rigged voxel) or a GLB.
 *
 * The format is chosen by extension and nothing else: a `.vxl` character is a
 * different file format, not a variant of glTF, and sniffing bytes would mean
 * fetching before knowing which loader to hand the URL to.
 */
export async function loadCharacterModel(
    loader: GLTFLoader,
    url: string,
    options: LoadCharacterModelOptions = {},
): Promise<LoadedCharacterModel> {
    if (isVxlCharacterUrl(url)) {
        const template = await loadVxlCharacterTemplate(url, options.bodyLod ?? 0);
        return instantiateVxlCharacter(template, { rigidJointMeshes: options.rigidJointMeshes });
    }
    return new Promise<LoadedCharacterModel>((resolve, reject) => {
        loader.load(url, (gltf) => {
            const model = gltf as unknown as LoadedCharacterModel;
            // `BM_slot_<class>` materials (forged characters, hand-modelled
            // Blender ones) become the engine's tuned classed materials here,
            // at the one place every character-GLB load passes through —
            // player, NPC template (before its SkeletonUtils clones), remote.
            // Quality resolved per load, the `WeaponPartMaterial` precedent.
            applyClassedCharacterMaterials(model.scene, activeMaterialQuality());
            resolve(model);
        }, undefined, reject);
    });
}
