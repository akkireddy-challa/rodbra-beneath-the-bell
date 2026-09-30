import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { VxlV3Data, DecodedVxlV3, DecodedFragment } from 'engine/VxlV3Format.js';
import { rigToEncodeInput } from 'engine/VxlV3Rig.js';

/**
 * VoxelExplosionHelpers — pure helpers shared by VoxelObject's explosion /
 * debris paths. Extracted verbatim from VoxelObject.ts (which sits at the
 * 2000-line ESLint cap); no VoxelObject dependency, so this module is
 * import-cycle-free.
 */

/**
 * Radial outward blast-impulse vector for explosion debris. Normalises in
 * the XZ plane and uses a fixed Y component (`strength + up`); when the XZ
 * offset is degenerate, picks a random horizontal direction. Shared by the
 * explosion paths so impulse shaping stays consistent.
 */
export function radialBlastImpulse(
    dx: number, dz: number, strength: number, up: number,
): { x: number; y: number; z: number } {
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    if (horizDist > 0.01) {
        return { x: (dx / horizDist) * strength, y: strength + up, z: (dz / horizDist) * strength };
    }
    const angle = Math.random() * Math.PI * 2;
    return { x: Math.cos(angle) * strength, y: strength + up, z: Math.sin(angle) * strength };
}

/**
 * Nudge a debris spawn point radially outward from the blast centre so the
 * cube doesn't spawn clipping the surface it broke off. `(dx,dy,dz)` is the
 * vector from blast centre to the point and `dist` its length; a degenerate
 * (dist≈0) point is just lifted. `size` is the debris edge length.
 */
export function pushDebrisOutward(pos: THREE.Vector3, dx: number, dy: number, dz: number, dist: number, size: number): void {
    const off = size * 0.6;
    if (dist > 0.01) {
        pos.x += (dx / dist) * off;
        pos.y += (dy / dist) * off + size * 0.3;
        pos.z += (dz / dist) * off;
    } else {
        pos.y += off;
    }
}

/**
 * Dynamic rigid-body descriptor shared by both debris-spawn paths: an outward
 * launch velocity plus a random tumble, damped, with CCD on so fast fragments
 * don't tunnel through thin terrain.
 */
export function debrisRigidBodyDesc(
    x: number, y: number, z: number, imp: { x: number; y: number; z: number },
): RAPIER.RigidBodyDesc {
    return RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setLinvel(imp.x, imp.y, imp.z)
        .setAngvel({
            x: (Math.random() - 0.5) * 8,
            y: (Math.random() - 0.5) * 8,
            z: (Math.random() - 0.5) * 8,
        })
        .setLinearDamping(0.5)
        .setAngularDamping(0.8)
        .setCcdEnabled(true);
}

/** Convert decode-form (LeafBuffer) data back to encode-form (OctreeLeaf[]) for re-save.
 *  Colours are already RGB444-quantised in the buffer.
 *
 *  Everything the file carried has to come back out. This is the save path for an
 *  object that was NOT leaf-edited (`VoxelObject.toVXL`, e.g. Make Unique), and a
 *  field missing here is a field the re-save silently deletes: the asset-level
 *  sections are not reconstructible from leaves, so nothing downstream can notice.
 *  `slots` was such a hole — a v7/v8 asset re-saved without an edit came back with
 *  its named materials gone, taking every light riding on one — and `rig` would have
 *  been the same hole for v10, one section further on. */
export function decodedToEncodable(d: DecodedVxlV3): VxlV3Data {
    // `useAtlas` is not optional on a RE-ENCODE path, which is the only thing this
    // function is for. An atlas asset's stored cell already has the sRGB OETF baked
    // in; handing the raw `v4/15` fractions back to the encoder — which treats leaf
    // floats as linear and encodes again — brightens every mid-tone and shifts the
    // whole model's palette on save. See `LeafBuffer.toArray`'s own note.
    const conv = (f: DecodedFragment) => ({
        aabbMin: f.aabbMin, aabbMax: f.aabbMax, leaves: f.leaves.toArray(d.useAtlas),
    });
    return {
        minVoxelSize: d.minVoxelSize,
        maxVoxelSize: d.maxVoxelSize,
        physicsGridStep: d.physicsGridStep,
        bounds: d.bounds,
        useAtlas: d.useAtlas,
        fragments: d.fragments.map(conv),
        ...(d.additionalLods ? { additionalLods: d.additionalLods.map(l => ({ minVoxelSize: l.minVoxelSize, maxVoxelSize: l.maxVoxelSize, fragments: l.fragments.map(conv) })) } : {}),
        ...(d.slots && d.slots.length > 0 ? { slots: d.slots } : {}),
        // The bone column rides back on the leaves (`LeafBuffer.toArray`); this is the
        // asset-level half the encoder needs to write v10 at all.
        ...(d.rig ? { rig: rigToEncodeInput(d.rig) } : {}),
        // The parts table names the rig's joints (v12); without it the joint column
        // survives and the windmill stops being a windmill.
        ...(d.parts && d.parts.length > 0 ? { parts: d.parts } : {}),
    };
}
