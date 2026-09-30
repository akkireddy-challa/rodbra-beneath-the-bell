/**
 * Smart PLACEHOLDERS: from what an authoring lane declares about a prop
 * (`SmartPropSpec` — named parts with motions, lights) to what the encoder and
 * the asset record need.
 *
 * The sibling of `SmartObjectParts.ts`, which serves the Forger's grid-space
 * analysis. The difference is where voxel ownership comes from: the analysis
 * draws BOXES and the bake cuts by them, whereas a placeholder's primitives
 * already carry a `part` name, so the lane that rasterises them knows which
 * voxel belongs to which part and only needs this file for the rest — pivots,
 * the rig, the fitment, the light emitters.
 *
 * Both lanes hand over the same two things: the spec, and one axis-aligned
 * box per named part in the ASSET frame (the compiled frame: bottom-centre
 * origin, the same frame `boundingBox` and `AssetLightEmitter.offset` use).
 * The procedural lane has the boxes by construction; the GLB lane takes each
 * `BM_part_*` node's triangle bounds.
 */

import type { VxlV3RigInput } from 'engine/VxlV3Format.js';
import type { ExtractedGlb } from 'engine/ExtractGlbForVoxelization.js';
import { PARTS_SKELETON_REF, VOXEL_MAX_PARTS, type VxlV3Part } from 'engine/VxlV3Parts.js';
import { fitmentFromTable, partsTableFromSpec } from 'engine/import/SmartObjectParts.js';
import type { AssetLightEmitter, Vector3Like } from 'types/game.js';
import type {
    SmartObjectFitment, SmartObjectMotion, SmartPropLightSpec, SmartPropPartSpec, SmartPropSpec,
} from 'types/smartObject.js';

/** GLB node name prefix a smart prop's moving part is written under (the `BM_wheel_` pattern). */
export const BM_PART_NODE_PREFIX = 'BM_part_';
/** Scene-extras key the declaration travels in (the `bmVehicle` pattern). */
export const BM_SMART_OBJECT_EXTRAS_KEY = 'bmSmartObject';

export function isBmPartNodeName(name: string | undefined): boolean {
    return typeof name === 'string' && name.startsWith(BM_PART_NODE_PREFIX);
}

export interface AssetBox {
    min: Vector3Like;
    max: Vector3Like;
}

/** Everything a bake writes for a smart placeholder. */
export interface SmartPropBake {
    /** In joint order: `table[i]` is joint i + 1. */
    table: VxlV3Part[];
    /** Pivots in the asset frame, parallel to `table`. */
    pivots: Vector3Like[];
    rig: VxlV3RigInput;
    fitment: SmartObjectFitment;
    light?: AssetLightEmitter;
    lights?: AssetLightEmitter[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteVec3(value: unknown): Vector3Like | undefined {
    if (!isRecord(value)) return undefined;
    const { x, y, z } = value;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return undefined;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
    return { x, y, z };
}

function finiteTuple3(value: unknown): [number, number, number] | undefined {
    if (!Array.isArray(value) || value.length !== 3) return undefined;
    const [x, y, z] = value;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return undefined;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
    return [x, y, z];
}

function readMotion(raw: unknown, warnings: string[], name: string): SmartObjectMotion | null {
    if (!isRecord(raw) || typeof raw.kind !== 'string') {
        warnings.push(`smart part "${name}": motion missing — skipped.`);
        return null;
    }
    switch (raw.kind) {
        case 'spin': {
            const axis = finiteTuple3(raw.axis) ?? [0, 0, 1];
            const rpm = typeof raw.rpm === 'number' && Number.isFinite(raw.rpm) ? raw.rpm : 10;
            return { kind: 'spin', axis, rpm };
        }
        case 'pendulum': {
            const axis = finiteTuple3(raw.axis) ?? [1, 0, 0];
            const amplitudeDeg = typeof raw.amplitudeDeg === 'number' ? raw.amplitudeDeg : 20;
            const periodS = typeof raw.periodS === 'number' && raw.periodS > 0 ? raw.periodS : 3;
            return { kind: 'pendulum', axis, amplitudeDeg, periodS };
        }
        case 'upright': return { kind: 'upright' };
        case 'none': return { kind: 'none' };
        default:
            warnings.push(`smart part "${name}": unknown motion "${raw.kind}" — treated as none.`);
            return { kind: 'none' };
    }
}

/**
 * Read a `SmartPropSpec` from untrusted data (GLB scene extras, a replayed
 * `production.spec`), the way `deriveVehicleFitment` reads `bmVehicle`: keep
 * what is usable, warn about the rest, never throw. Null when there is nothing
 * to bake — no valid part and no valid light.
 */
export function readSmartPropSpec(
    raw: unknown,
    warnings: string[] = [],
): SmartPropSpec | null {
    if (!isRecord(raw)) return null;
    const parts: SmartPropPartSpec[] = [];
    const seen = new Set<string>();
    for (const entry of Array.isArray(raw.parts) ? raw.parts.slice(0, VOXEL_MAX_PARTS) : []) {
        if (!isRecord(entry) || typeof entry.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(entry.name)) {
            warnings.push('smart part with no usable name — skipped.');
            continue;
        }
        if (seen.has(entry.name)) {
            warnings.push(`smart part "${entry.name}" declared twice — later one skipped.`);
            continue;
        }
        const motion = readMotion(entry.motion, warnings, entry.name);
        if (!motion) continue;
        seen.add(entry.name);
        const pivot = finiteVec3(entry.pivot);
        parts.push({
            name: entry.name,
            ...(typeof entry.parent === 'string' && entry.parent ? { parent: entry.parent } : {}),
            motion,
            ...(pivot ? { pivot } : {}),
        });
    }
    const lights: SmartPropLightSpec[] = [];
    for (const entry of Array.isArray(raw.lights) ? raw.lights.slice(0, 8) : []) {
        if (!isRecord(entry) || typeof entry.color !== 'string') {
            warnings.push('smart light with no colour — skipped.');
            continue;
        }
        const position = finiteVec3(entry.position);
        const part = typeof entry.part === 'string' && seen.has(entry.part) ? entry.part : undefined;
        if (!position && !part) {
            warnings.push('smart light with neither a position nor a known part — skipped.');
            continue;
        }
        lights.push({
            name: typeof entry.name === 'string' && entry.name ? entry.name : `light_${lights.length + 1}`,
            ...(part ? { part } : {}),
            ...(position ? { position } : {}),
            color: entry.color,
            ...(typeof entry.intensity === 'number' && entry.intensity > 0 ? { intensity: entry.intensity } : {}),
            ...(typeof entry.distance === 'number' && entry.distance > 0 ? { distance: entry.distance } : {}),
            ...(entry.flicker === true ? { flicker: true } : {}),
        });
    }
    if (parts.length === 0 && lights.length === 0) return null;
    return { parts, ...(lights.length > 0 ? { lights } : {}) };
}

/**
 * The v10 rig a parts table needs: `parts-v1`, bind positions LOCAL to the
 * parent joint (joint 0, the body, sits at the asset origin), no fillers, no
 * sockets. Shared by every lane that writes a part channel.
 */
export function smartRigFor(
    table: readonly VxlV3Part[],
    pivotsMetres: ReadonlyArray<Vector3Like>,
): VxlV3RigInput {
    const jointCount = table.length + 1;
    const bindPositions = new Float32Array(jointCount * 3);
    for (let i = 0; i < table.length; i++) {
        const pivot = pivotsMetres[i]!;
        const parentJoint = table[i]!.parentJoint;
        const parentPivot = parentJoint === 0 ? { x: 0, y: 0, z: 0 } : pivotsMetres[parentJoint - 1]!;
        bindPositions[(i + 1) * 3 + 0] = pivot.x - parentPivot.x;
        bindPositions[(i + 1) * 3 + 1] = pivot.y - parentPivot.y;
        bindPositions[(i + 1) * 3 + 2] = pivot.z - parentPivot.z;
    }
    return {
        skeletonRef: PARTS_SKELETON_REF,
        bindPositions,
        fillers: {
            count: 0,
            gx: new Uint16Array(0), gy: new Uint16Array(0), gz: new Uint16Array(0),
            bone: new Uint8Array(0), color: new Uint16Array(0),
        },
        sockets: [],
    };
}

/**
 * Where a part turns when nothing says otherwise: a spinning or static part
 * about its box centre; a hanging or swinging one from the top of its box,
 * which is where the hinge is.
 */
export function defaultPartPivot(box: AssetBox, motion: SmartObjectMotion): Vector3Like {
    const centre = {
        x: (box.min.x + box.max.x) / 2,
        y: (box.min.y + box.max.y) / 2,
        z: (box.min.z + box.max.z) / 2,
    };
    return motion.kind === 'upright' || motion.kind === 'pendulum' ? { ...centre, y: box.max.y } : centre;
}

/** What a GLB bake hands the voxelizer and puts on the record. */
export interface SmartGlbDerivation {
    bake: SmartPropBake;
    /** For `VoxelizeOptions.smartParts`. */
    voxelizerInput: { table: VxlV3Part[]; rig: VxlV3RigInput; jointOfNode: (nodeName: string) => number };
    /** The record fields: `smartObject`, and `light` / `lights` when declared. */
    fields: { smartObject: SmartObjectFitment; light?: AssetLightEmitter; lights?: AssetLightEmitter[] };
    warnings: string[];
}

/**
 * A smart prop from an extracted GLB: the declaration in `scene.extras.bmSmartObject`,
 * one box per `BM_part_<name>` node from its triangles (already in the asset
 * frame — the extraction rebases asset bakes), and authored points mapped the
 * way `deriveVehicleFitment` maps `bmVehicle`: scaled, then re-centred against
 * the pre-rebase bounds. Null when the GLB declares nothing usable.
 */
export function deriveSmartPropFromGlb(extracted: ExtractedGlb): SmartGlbDerivation | null {
    const warnings: string[] = [];
    const raw = extracted.sceneExtras?.[BM_SMART_OBJECT_EXTRAS_KEY];
    const spec = readSmartPropSpec(raw, warnings);
    if (!spec) return null;

    const boxes = new Map<string, AssetBox>();
    for (const t of extracted.allTriangles) {
        const node = t.sourceNodeName ?? '';
        if (!isBmPartNodeName(node)) continue;
        const name = node.slice(BM_PART_NODE_PREFIX.length);
        const box = boxes.get(name) ?? {
            min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity },
        };
        for (const v of [t.v0, t.v1, t.v2]) {
            box.min = { x: Math.min(box.min.x, v.x), y: Math.min(box.min.y, v.y), z: Math.min(box.min.z, v.z) };
            box.max = { x: Math.max(box.max.x, v.x), y: Math.max(box.max.y, v.y), z: Math.max(box.max.z, v.z) };
        }
        boxes.set(name, box);
    }

    const scale = extracted.appliedScale > 0 ? extracted.appliedScale : 1;
    const { min, max } = extracted.preRebaseBounds;
    const rebase = { x: (min.x + max.x) / 2, y: min.y, z: (min.z + max.z) / 2 };
    const toAsset = (p: Vector3Like): Vector3Like =>
        ({ x: p.x * scale - rebase.x, y: p.y * scale - rebase.y, z: p.z * scale - rebase.z });

    const bake = smartPropBake(spec, boxes, toAsset, warnings);
    if (!bake) return null;
    const jointByNode = new Map(bake.table.map((part, index) => [`${BM_PART_NODE_PREFIX}${part.name}`, index + 1]));
    return {
        bake,
        voxelizerInput: {
            table: bake.table,
            rig: bake.rig,
            jointOfNode: (nodeName) => jointByNode.get(nodeName) ?? 0,
        },
        fields: {
            smartObject: bake.fitment,
            ...(bake.light ? { light: bake.light } : {}),
            ...(bake.lights ? { lights: bake.lights } : {}),
        },
        warnings,
    };
}

/**
 * Derive everything a bake writes for a smart placeholder.
 *
 * `boxes` holds each named part's bounds in the ASSET frame; `toAsset` maps a
 * point from the spec's authored frame into that same frame (the procedural
 * lane subtracts the object pivot; the GLB lane scales and re-centres). Parts
 * the spec names but the geometry does not have are dropped with a warning,
 * so a designer's typo costs a part rather than the bake. Null when nothing
 * usable remains.
 */
export function smartPropBake(
    spec: SmartPropSpec,
    boxes: ReadonlyMap<string, AssetBox>,
    toAsset: (point: Vector3Like) => Vector3Like,
    warnings: string[] = [],
): SmartPropBake | null {
    const present = spec.parts.filter((part) => {
        if (boxes.has(part.name)) return true;
        warnings.push(`smart part "${part.name}" has no geometry named for it — skipped.`);
        return false;
    });
    const lightsSpec = spec.lights ?? [];
    if (present.length === 0 && lightsSpec.length === 0) return null;

    const table = partsTableFromSpec(present);
    const pivots = present.map((part, index) =>
        part.pivot ? toAsset(part.pivot) : defaultPartPivot(boxes.get(part.name)!, table[index]!.motion));
    const pivotOf = new Map(present.map((part, index) => [part.name, pivots[index]!]));

    const lights: AssetLightEmitter[] = [];
    for (const light of lightsSpec) {
        const offset = light.position
            ? toAsset(light.position)
            : light.part !== undefined ? pivotOf.get(light.part) : undefined;
        if (!offset) {
            warnings.push(`smart light "${light.name}" points at a part that was not baked — skipped.`);
            continue;
        }
        lights.push({
            color: light.color,
            offset,
            ...(light.intensity !== undefined ? { intensity: light.intensity } : {}),
            ...(light.distance !== undefined ? { distance: light.distance } : {}),
            ...(light.flicker ? { flicker: true } : {}),
            ...(light.part ? { part: light.part } : {}),
        });
    }
    if (table.length === 0 && lights.length === 0) return null;

    const rig = smartRigFor(table, pivots);
    return {
        table,
        pivots,
        rig,
        fitment: fitmentFromTable(table, pivots),
        ...(lights.length > 0 ? { light: lights[0]! } : {}),
        ...(lights.length > 1 ? { lights: lights.slice(1) } : {}),
    };
}
