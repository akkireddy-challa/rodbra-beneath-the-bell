/**
 * From a Forger `SmartObjectSpec` (boxes in master grid space) to what the bake
 * needs: an owning joint per master voxel, a parts table, pivots on the working
 * lattice, and light emitters in metres.
 *
 * The box + component rule here is THE contract with the analysis in
 * `BitmagicLab/voxel_smart_object.py`: both sides take the voxels inside each
 * part's box (minus its excludes), drop connected components smaller than
 * `minComponentFraction` of the largest — the slivers of body a box clips —
 * and let a later part win an overlap, which is how a cabin is carved out of
 * its wheel. Same rule, same numbers, so the voxels the Forger counted are the
 * voxels the engine animates. It is applied to MASTER voxels, never to working
 * cells, so a re-voxelize at any size re-splits identically.
 */

import type { VoxelMaster, ResampledVoxels } from 'engine/import/VoxelMaster.js';
import { cellPointToMetres } from 'engine/import/VoxelModelToAsset.js';
import type { VxlV3Bounds } from 'engine/VxlV3Format.js';
import type { VxlV3Part, VxlV3PartMotion } from 'engine/VxlV3Parts.js';
import { VOXEL_MAX_PARTS } from 'engine/VxlV3Parts.js';
import type { AssetLightEmitter } from 'types/game.js';
import type {
    GridBox, GridVec3, SmartObjectFitment, SmartObjectMotion, SmartObjectSpec, SmartObjectSpecPart,
} from 'types/smartObject.js';

export const DEFAULT_MIN_COMPONENT_FRACTION = 0.1;

/** Body joint; parts are 1..N in spec order. */
const BODY_JOINT = 0;

function inBox(box: GridBox, x: number, y: number, z: number): boolean {
    return x >= box.min[0] && x <= box.max[0]
        && y >= box.min[1] && y <= box.max[1]
        && z >= box.min[2] && z <= box.max[2];
}

/**
 * The owning joint of every master voxel: 0 for the body, i + 1 for `spec.parts[i]`.
 *
 * Parts are applied in spec order and a later part overwrites an earlier one
 * where their boxes overlap — the Forger's rule, and the carve a cabin needs.
 */
export function assignPartJoints(master: VoxelMaster, spec: SmartObjectSpec): Uint8Array {
    const joints = new Uint8Array(master.count);
    const fraction = spec.minComponentFraction ?? DEFAULT_MIN_COMPONENT_FRACTION;
    const parts = spec.parts.slice(0, VOXEL_MAX_PARTS);

    for (let p = 0; p < parts.length; p++) {
        const part = parts[p]!;
        const box = part.box;
        const excludes = part.exclude ?? [];
        const dx = box.max[0] - box.min[0] + 1;
        const dy = box.max[1] - box.min[1] + 1;
        const dz = box.max[2] - box.min[2] + 1;
        if (dx <= 0 || dy <= 0 || dz <= 0) continue;

        // Voxels inside the box, keyed by local coordinate for the flood fill.
        const local = new Map<number, number>();
        for (let i = 0; i < master.count; i++) {
            const x = master.x[i]!, y = master.y[i]!, z = master.z[i]!;
            if (!inBox(box, x, y, z)) continue;
            if (excludes.some((exclude) => inBox(exclude, x, y, z))) continue;
            local.set(((x - box.min[0]) * dy + (y - box.min[1])) * dz + (z - box.min[2]), i);
        }
        if (local.size === 0) continue;

        // 26-connected components over the box's voxels.
        const componentOf = new Map<number, number>();
        const sizes: number[] = [];
        for (const seed of local.keys()) {
            if (componentOf.has(seed)) continue;
            const id = sizes.length;
            let size = 0;
            const stack = [seed];
            componentOf.set(seed, id);
            while (stack.length > 0) {
                const key = stack.pop()!;
                size++;
                const lx = Math.floor(key / (dy * dz));
                const ly = Math.floor(key / dz) % dy;
                const lz = key % dz;
                for (let ox = -1; ox <= 1; ox++) {
                    for (let oy = -1; oy <= 1; oy++) {
                        for (let oz = -1; oz <= 1; oz++) {
                            if (ox === 0 && oy === 0 && oz === 0) continue;
                            const nx = lx + ox, ny = ly + oy, nz = lz + oz;
                            if (nx < 0 || ny < 0 || nz < 0 || nx >= dx || ny >= dy || nz >= dz) continue;
                            const nkey = (nx * dy + ny) * dz + nz;
                            if (!local.has(nkey) || componentOf.has(nkey)) continue;
                            componentOf.set(nkey, id);
                            stack.push(nkey);
                        }
                    }
                }
            }
            sizes.push(size);
        }
        const largest = Math.max(...sizes);
        const keep = sizes.map((size) => size >= fraction * largest);

        const joint = p + 1;
        for (const [key, index] of local) {
            if (keep[componentOf.get(key)!]) joints[index] = joint;
        }
    }
    return joints;
}

function unit(axis: GridVec3): [number, number, number] {
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    if (length < 1e-9) return [0, 0, 1];
    return [axis[0] / length, axis[1] / length, axis[2] / length];
}

/** A spec motion → the file's motion. Direction vectors are the same in grid and metre space. */
export function partMotionFromSpec(motion: SmartObjectMotion): VxlV3PartMotion {
    switch (motion.kind) {
        case 'spin': return { kind: 'spin', axis: unit(motion.axis), rpm: motion.rpm };
        case 'upright': return { kind: 'upright' };
        case 'pendulum': return {
            kind: 'pendulum', axis: unit(motion.axis), amplitudeDeg: motion.amplitudeDeg, periodS: motion.periodS,
        };
        default: return { kind: 'none' };
    }
}

/**
 * The parts table for the file: names, parent joints, motions — in spec order,
 * which is joint order. A parent that is not a part (or would come later, so the
 * hierarchy is not parents-first) falls back to the body rather than failing the
 * bake; the encoder validates the result.
 */
export function partsTableFromSpec(
    parts: ReadonlyArray<Pick<SmartObjectSpecPart, 'name' | 'parent' | 'motion'>>,
): VxlV3Part[] {
    const jointOf = new Map<string, number>();
    parts.forEach((part, index) => jointOf.set(part.name, index + 1));
    return parts.map((part, index) => {
        const parentJoint = part.parent !== undefined ? (jointOf.get(part.parent) ?? BODY_JOINT) : BODY_JOINT;
        return {
            name: part.name,
            parentJoint: parentJoint < index + 1 ? parentJoint : BODY_JOINT,
            motion: partMotionFromSpec(part.motion),
        };
    });
}

/** A master grid point → the working lattice, in cell units of the requested voxel size. */
export function masterPointToCells(working: ResampledVoxels, point: GridVec3): [number, number, number] {
    return [
        (point[0] - working.masterMin[0]) * working.scale,
        (point[1] - working.masterMin[1]) * working.scale,
        (point[2] - working.masterMin[2]) * working.scale,
    ];
}

/** Per-working-cell owning joint from the resampled attribute, keyed like the compiler's cells. */
export function cellsPartFromWorking(
    working: ResampledVoxels,
    packCell: (x: number, y: number, z: number) => number,
): Map<number, number> {
    const cellsPart = new Map<number, number>();
    const attribute = working.attribute;
    if (!attribute) return cellsPart;
    for (let i = 0; i < working.count; i++) {
        const joint = attribute[i]!;
        if (joint > 0) cellsPart.set(packCell(working.x[i]!, working.y[i]!, working.z[i]!), joint);
    }
    return cellsPart;
}

/**
 * The runtime fitment: pivots in metres in the compiled frame, motions as the
 * runtime plays them, the grid-space spec kept as the durable source.
 */
export function fitmentFromSpec(
    spec: SmartObjectSpec,
    table: readonly VxlV3Part[],
    pivotsMetres: ReadonlyArray<{ x: number; y: number; z: number }>,
): SmartObjectFitment {
    return { ...fitmentFromTable(table, pivotsMetres), source: spec };
}

/** The fitment for a parts table whose pivots are already in metres — no grid-space source. */
export function fitmentFromTable(
    table: readonly VxlV3Part[],
    pivotsMetres: ReadonlyArray<{ x: number; y: number; z: number }>,
): SmartObjectFitment {
    return {
        version: 1,
        parts: table.map((part, index) => ({
            name: part.name,
            ...(part.parentJoint > 0 ? { parent: table[part.parentJoint - 1]!.name } : {}),
            pivot: pivotsMetres[index]!,
            motion: motionForFitment(part.motion),
        })),
    };
}

function motionForFitment(motion: VxlV3PartMotion): SmartObjectMotion {
    switch (motion.kind) {
        case 'spin': return { kind: 'spin', axis: motion.axis, rpm: motion.rpm };
        case 'upright': return { kind: 'upright' };
        case 'pendulum': return {
            kind: 'pendulum', axis: motion.axis, amplitudeDeg: motion.amplitudeDeg, periodS: motion.periodS,
        };
        default: return { kind: 'none' };
    }
}

/**
 * The spec's lights as `AssetLightEmitter`s, offsets in metres in the compiled
 * frame — the same frame `boundingBox` is in, which is what the light system's
 * `offset` expects. A light riding a part keeps the part's name; its offset is
 * still in the asset frame, and the runtime re-bases it to the part's pivot.
 */
export function lightsFromSpec(
    spec: SmartObjectSpec,
    working: ResampledVoxels,
    bounds: VxlV3Bounds,
    voxelSize: number,
): AssetLightEmitter[] {
    return spec.lights.map((light) => ({
        color: light.color,
        ...(light.intensity !== undefined ? { intensity: light.intensity } : {}),
        ...(light.distance !== undefined ? { distance: light.distance } : {}),
        ...(light.flicker ? { flicker: true } : {}),
        ...(light.part ? { part: light.part } : {}),
        offset: cellPointToMetres(bounds, voxelSize, masterPointToCells(working, light.position)),
    }));
}
