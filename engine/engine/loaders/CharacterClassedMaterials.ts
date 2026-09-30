/**
 * Material classes for SKINNED CHARACTER GLBs — the `BM_slot_<class>` naming
 * contract's consumer for the one asset family that never passes through the
 * voxelizer. A character GLB whose material is named `BM_slot_gold` (the
 * character forger writes them; a hand-modelled Blender character can too) gets
 * that material replaced with the engine's tuned classed material for `gold`,
 * quality-clamped like every other classed surface. Everything else — the
 * forger's base `CharacterSkin`, an Asset Forger `voxel` material, an ordinary
 * import — is left for `PlayerLoader.modifyGLTFMaterialDefaults` to flatten
 * exactly as before.
 *
 * NAME-ONLY by design, unlike the voxelizer's `VoxelSlotAssign` which reads
 * declared PBR first. Its `declaredClass` is a coarse snap for surfaces that
 * never said their name: honest gold PBR (metalness 0.9 / roughness 0.3) snaps
 * to `metal`, and gem PBR to `glass` — fine when the PBR is all there is, wrong
 * here where the name states the exact class. The honest PBR forged characters
 * carry alongside the name is for OTHER consumers (generic glTF viewers, a
 * future voxelization of the mesh), not for this hook. And only vocabulary
 * names count: a character's `BM_slot_headlights` has no runtime slot machinery
 * behind it, so it stays what it was.
 *
 * Glow comes from the GLB material's own `emissive` × `emissiveIntensity`
 * (mirroring `VoxelSlotAssign.declaredEmissive`), never from the class default
 * — a part authored dark stays dark, whatever its class name says
 * (`VoxelSlotAssign`'s own doctrine).
 *
 * Known cosmetic wart, accepted: a runtime tint (`tintBodyPart`) on a classed
 * part clones and recolours without re-applying the class's `albedoScale`
 * (0.86 for the clearcoat classes) — a tinted gem reads a shade brighter than
 * a forged one of the same colour.
 */
import * as THREE from 'three';
import {
    createClassedPartMaterial,
    isClassedPartMaterial,
} from 'engine/ClassedPartMaterial.js';
import type { MaterialQuality } from 'engine/MaterialQuality.js';
import { isVoxelMaterialClassName } from 'engine/VoxelMaterialClass.js';
import { slotNameFromMaterialName } from 'engine/VoxelMaterialSlots.js';

/**
 * The GLB material's declared glow, 0..1 of the voxel full-glow — the peak
 * emissive channel × intensity. Mirrors `VoxelSlotAssign.declaredEmissive`
 * (which is file-private and returns the 0..255 stored form).
 */
function declaredGlow(material: THREE.MeshStandardMaterial): number {
    const colour = material.emissive;
    if (!colour) return 0;
    const peak = Math.max(colour.r, colour.g, colour.b);
    const strength = material.emissiveIntensity ?? 1;
    return Math.max(0, Math.min(1, peak * strength));
}

/**
 * Replace every `BM_slot_<class>` material under `root` with a classed part
 * material at `quality`, in place, disposing what it replaces. Returns the
 * number of materials replaced.
 *
 * Runs once per LOADED model — for the player and remote players that is per
 * character, for NPCs it is once on `NpcManager`'s cached template before
 * `SkeletonUtils.clone`, so clones share the classed materials exactly as they
 * share untouched originals today. Idempotent: an already-classed material is
 * skipped, so a second pass over the same tree is a no-op.
 */
export function applyClassedCharacterMaterials(
    root: THREE.Object3D,
    quality: MaterialQuality,
): number {
    let replaced = 0;
    root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        const current = mesh.material;
        const materials = Array.isArray(current) ? current : [current];
        let meshGlows = false;
        const rebuilt = materials.map((mat) => {
            if (isClassedPartMaterial(mat)) return mat;
            const slotName = slotNameFromMaterialName(mat.name);
            if (slotName === null) return mat;
            const className = slotName.toLowerCase();
            if (!isVoxelMaterialClassName(className)) return mat;

            const source = mat as THREE.MeshStandardMaterial;
            const glow = declaredGlow(source);
            const next = createClassedPartMaterial(className, {
                color: source.color instanceof THREE.Color ? source.color.getHex() : 0xffffff,
                glow,
                vertexColors: source.vertexColors === true,
            }, quality);

            // Caller postscripts the class table cannot know: the atlas map (a
            // classed surface may still be textured), sidedness, transparency.
            next.name = mat.name;
            if (source.map) {
                source.map.colorSpace = THREE.SRGBColorSpace;
                next.map = source.map;
            }
            next.side = source.side;
            next.transparent = source.transparent;
            next.opacity = source.opacity;
            if (glow > 0) meshGlows = true;

            mat.dispose();
            replaced++;
            return next;
        });
        mesh.material = Array.isArray(current) ? rebuilt : rebuilt[0]!;
        // The bloom tint writes a grey emissive onto anything with an emissive
        // channel (mesh-level opt-out, `BloomTint.applyBloomTint`); a part whose
        // glow is authored must not have it overwritten.
        if (meshGlows) mesh.userData.skipBloomTint = true;
    });
    return replaced;
}
