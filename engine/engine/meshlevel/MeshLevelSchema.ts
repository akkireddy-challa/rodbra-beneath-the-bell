/**
 * MeshLevelSchema — the `bitmagic-mesh-level` v1 JSON contract and its validator.
 *
 * A mesh level is an authored GLB (Blender, or any DCC tool) that IS the whole
 * world, plus this companion JSON describing what the art alone cannot say:
 * where the solid surfaces are (colliders), named regions (volumes), named
 * points (landmarks) and the interior lights. The GLB and the JSON share one
 * origin and one unit: metres, Y up, yaw in radians about +Y in the gameplay
 * +Z-forward convention (agent-docs/coordinate-system.md).
 *
 * Doors are deliberately NOT part of this file. They are `worldProfileData.doors[]`
 * (`DoorDefinition`), which the engine's DoorSystem already builds and animates.
 *
 * THREE-free on purpose: `parseMeshLevel` runs under ts-jest node exactly as it
 * does in the iframe, and the CLI's Blender exporter mirrors this shape 1:1.
 */

export const MESH_LEVEL_FORMAT = 'bitmagic-mesh-level';
export const MESH_LEVEL_VERSION = 1;

export type MeshLevelVec3 = [number, number, number];

export type MeshLevelCollisionGroup = 'terrain' | 'environment';

export interface MeshLevelBoxCollider {
    name: string;
    shape: 'box';
    /** World-space centre. */
    position: MeshLevelVec3;
    /** Full extents (the engine halves them). */
    size: MeshLevelVec3;
    /** Radians about +Y. */
    yaw: number;
    /** Omitted = the level's default group (`MeshLevelOptions.collisionGroup`). */
    group?: MeshLevelCollisionGroup;
}

export interface MeshLevelHullCollider {
    name: string;
    shape: 'convexHull';
    /** Flat world-space xyz triples, at least 4 points. */
    vertices: number[];
    group?: MeshLevelCollisionGroup;
}

export interface MeshLevelTrimeshCollider {
    name: string;
    shape: 'trimesh';
    /** Flat world-space xyz triples. */
    vertices: number[];
    /** Triangle vertex indices, three per triangle. */
    indices: number[];
    group?: MeshLevelCollisionGroup;
}

/**
 * A regular height grid in world space — the compact, exact collider for terrain (a forged
 * landscape's ground). Vertex (i, j) sits at (minX + i·cellSize, heights[j·(nx+1) + i],
 * minZ + j·cellSize): row-major along X, the layout of the forge's `ForgedHeightGrid`.
 */
export interface MeshLevelHeightfieldCollider {
    name: string;
    shape: 'heightfield';
    minX: number;
    minZ: number;
    /** Metres per cell, both axes. */
    cellSize: number;
    /** Cells along X / Z; vertex counts are nx+1 / nz+1. */
    nx: number;
    nz: number;
    /** World-space heights, length (nx+1)·(nz+1), index j·(nx+1) + i. */
    heights: number[];
    group?: MeshLevelCollisionGroup;
}

export type MeshLevelCollider = MeshLevelBoxCollider | MeshLevelHullCollider | MeshLevelTrimeshCollider | MeshLevelHeightfieldCollider;

/** A named oriented box region — a room, an airlock, a pressure envelope, a trigger area. */
export interface MeshLevelVolume {
    name: string;
    position: MeshLevelVec3;
    size: MeshLevelVec3;
    yaw: number;
    tags: string[];
}

/** A named point with a facing — `spawn`, an extraction pad, an NPC post. */
export interface MeshLevelLandmark {
    name: string;
    position: MeshLevelVec3;
    yaw: number;
    tags: string[];
}

export interface MeshLevelPointLight {
    name: string;
    type: 'point';
    position: MeshLevelVec3;
    /** `#rrggbb`. */
    color: string;
    intensity: number;
    distance: number;
    decay: number;
}

export interface MeshLevelSpotLight {
    name: string;
    type: 'spot';
    position: MeshLevelVec3;
    target: MeshLevelVec3;
    color: string;
    intensity: number;
    /** Cone half-angle in radians. */
    angle: number;
    penumbra: number;
    castShadow: boolean;
}

export type MeshLevelLight = MeshLevelPointLight | MeshLevelSpotLight;

export interface MeshLevelData {
    format: typeof MESH_LEVEL_FORMAT;
    version: typeof MESH_LEVEL_VERSION;
    units: 'meters';
    colliders: MeshLevelCollider[];
    volumes: MeshLevelVolume[];
    landmarks: MeshLevelLandmark[];
    lights: MeshLevelLight[];
    /** Opaque passthrough for whatever the exporter wants to keep (module tables, links). */
    extras: Record<string, unknown>;
}

export interface ParsedMeshLevel {
    data: MeshLevelData;
    /** Non-fatal smells worth printing: no colliders, no `spawn` landmark, a very thin box. */
    warnings: string[];
}

/** Thrown for every contract violation; `path` names the offending JSON node. */
export class MeshLevelSchemaError extends Error {
    constructor(public readonly path: string, detail: string) {
        super(`${path}: ${detail}`);
        this.name = 'MeshLevelSchemaError';
    }
}

export const DEFAULT_POINT_LIGHT_DISTANCE_M = 20;
export const DEFAULT_POINT_LIGHT_DECAY = 2;
export const DEFAULT_SPOT_ANGLE_RAD = Math.PI / 4;
export const DEFAULT_SPOT_PENUMBRA = 0.3;
/** A box thinner than this in any axis is probably a decoration, not a wall. */
export const THIN_BOX_WARNING_M = 0.05;
export const MANY_LIGHTS_WARNING = 8;
export const SPAWN_LANDMARK = 'spawn';

const TOP_LEVEL_KEYS = new Set(['format', 'version', 'units', 'colliders', 'volumes', 'landmarks', 'lights', 'extras']);
const GROUPS: ReadonlySet<string> = new Set<MeshLevelCollisionGroup>(['terrain', 'environment']);

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireRecord(v: unknown, path: string): Record<string, unknown> {
    if (!isRecord(v)) throw new MeshLevelSchemaError(path, 'must be an object');
    return v;
}

function requireString(v: unknown, path: string): string {
    if (typeof v !== 'string' || v.length === 0) throw new MeshLevelSchemaError(path, 'must be a non-empty string');
    return v;
}

function requireFinite(v: unknown, path: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new MeshLevelSchemaError(path, 'must be a finite number');
    return v;
}

function optionalFinite(v: unknown, path: string, fallback: number): number {
    return v === undefined ? fallback : requireFinite(v, path);
}

function requireVec3(v: unknown, path: string): MeshLevelVec3 {
    if (!Array.isArray(v) || v.length !== 3) throw new MeshLevelSchemaError(path, 'must be [x, y, z]');
    return [requireFinite(v[0], `${path}[0]`), requireFinite(v[1], `${path}[1]`), requireFinite(v[2], `${path}[2]`)];
}

function requirePositiveVec3(v: unknown, path: string): MeshLevelVec3 {
    const out = requireVec3(v, path);
    out.forEach((n, i) => { if (n <= 0) throw new MeshLevelSchemaError(`${path}[${i}]`, 'must be > 0'); });
    return out;
}

function requireNumberArray(v: unknown, path: string): number[] {
    if (!Array.isArray(v)) throw new MeshLevelSchemaError(path, 'must be an array of numbers');
    return v.map((n, i) => requireFinite(n, `${path}[${i}]`));
}

function optionalArray(v: unknown, path: string): unknown[] {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new MeshLevelSchemaError(path, 'must be an array');
    return v;
}

function optionalTags(v: unknown, path: string): string[] {
    return optionalArray(v, path).map((t, i) => requireString(t, `${path}[${i}]`));
}

function optionalGroup(v: unknown, path: string): MeshLevelCollisionGroup | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !GROUPS.has(v)) throw new MeshLevelSchemaError(path, "must be 'terrain' or 'environment'");
    return v as MeshLevelCollisionGroup;
}

function requireHexColor(v: unknown, path: string): string {
    const s = requireString(v, path);
    if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new MeshLevelSchemaError(path, 'must be a #rrggbb colour');
    return s;
}

function requireUniqueNames(items: ReadonlyArray<{ name: string }>, path: string): void {
    const seen = new Set<string>();
    items.forEach((item, i) => {
        if (seen.has(item.name)) throw new MeshLevelSchemaError(`${path}[${i}].name`, `duplicate name "${item.name}"`);
        seen.add(item.name);
    });
}

function parseCollider(raw: unknown, path: string, warnings: string[]): MeshLevelCollider {
    const r = requireRecord(raw, path);
    const name = requireString(r.name, `${path}.name`);
    const group = optionalGroup(r.group, `${path}.group`);
    switch (r.shape) {
        case 'box': {
            const size = requirePositiveVec3(r.size, `${path}.size`);
            if (Math.min(...size) < THIN_BOX_WARNING_M) warnings.push(`${path} ("${name}") is thinner than ${THIN_BOX_WARNING_M} m — decoration should not be a collider`);
            return { name, shape: 'box', position: requireVec3(r.position, `${path}.position`), size, yaw: optionalFinite(r.yaw, `${path}.yaw`, 0), ...(group ? { group } : {}) };
        }
        case 'convexHull': {
            const vertices = requireNumberArray(r.vertices, `${path}.vertices`);
            if (vertices.length % 3 !== 0 || vertices.length < 12) throw new MeshLevelSchemaError(`${path}.vertices`, 'must hold at least 4 xyz triples');
            return { name, shape: 'convexHull', vertices, ...(group ? { group } : {}) };
        }
        case 'trimesh': {
            const vertices = requireNumberArray(r.vertices, `${path}.vertices`);
            const indices = requireNumberArray(r.indices, `${path}.indices`);
            if (vertices.length % 3 !== 0 || vertices.length < 9) throw new MeshLevelSchemaError(`${path}.vertices`, 'must hold at least 3 xyz triples');
            if (indices.length % 3 !== 0 || indices.length < 3) throw new MeshLevelSchemaError(`${path}.indices`, 'must hold three indices per triangle');
            const vertexCount = vertices.length / 3;
            indices.forEach((ix, i) => {
                if (!Number.isInteger(ix) || ix < 0 || ix >= vertexCount) throw new MeshLevelSchemaError(`${path}.indices[${i}]`, `index ${ix} is outside the ${vertexCount} vertices`);
            });
            return { name, shape: 'trimesh', vertices, indices, ...(group ? { group } : {}) };
        }
        case 'heightfield': {
            const nx = requireFinite(r.nx, `${path}.nx`);
            const nz = requireFinite(r.nz, `${path}.nz`);
            if (!Number.isInteger(nx) || !Number.isInteger(nz) || nx < 1 || nz < 1) throw new MeshLevelSchemaError(`${path}.nx`, 'nx and nz must be positive integers');
            const cellSize = requireFinite(r.cellSize, `${path}.cellSize`);
            if (cellSize <= 0) throw new MeshLevelSchemaError(`${path}.cellSize`, 'must be positive');
            const heights = requireNumberArray(r.heights, `${path}.heights`);
            if (heights.length !== (nx + 1) * (nz + 1)) throw new MeshLevelSchemaError(`${path}.heights`, `must hold (nx+1)·(nz+1) = ${(nx + 1) * (nz + 1)} values, got ${heights.length}`);
            return {
                name, shape: 'heightfield',
                minX: requireFinite(r.minX, `${path}.minX`), minZ: requireFinite(r.minZ, `${path}.minZ`),
                cellSize, nx, nz, heights, ...(group ? { group } : {}),
            };
        }
        default:
            throw new MeshLevelSchemaError(`${path}.shape`, "must be 'box', 'convexHull', 'trimesh' or 'heightfield'");
    }
}

function parseVolume(raw: unknown, path: string): MeshLevelVolume {
    const r = requireRecord(raw, path);
    return {
        name: requireString(r.name, `${path}.name`),
        position: requireVec3(r.position, `${path}.position`),
        size: requirePositiveVec3(r.size, `${path}.size`),
        yaw: optionalFinite(r.yaw, `${path}.yaw`, 0),
        tags: optionalTags(r.tags, `${path}.tags`),
    };
}

function parseLandmark(raw: unknown, path: string): MeshLevelLandmark {
    const r = requireRecord(raw, path);
    return {
        name: requireString(r.name, `${path}.name`),
        position: requireVec3(r.position, `${path}.position`),
        yaw: optionalFinite(r.yaw, `${path}.yaw`, 0),
        tags: optionalTags(r.tags, `${path}.tags`),
    };
}

function parseLight(raw: unknown, path: string): MeshLevelLight {
    const r = requireRecord(raw, path);
    const name = requireString(r.name, `${path}.name`);
    const position = requireVec3(r.position, `${path}.position`);
    const color = requireHexColor(r.color, `${path}.color`);
    const intensity = requireFinite(r.intensity, `${path}.intensity`);
    switch (r.type) {
        case 'point':
            return {
                name, type: 'point', position, color, intensity,
                distance: optionalFinite(r.distance, `${path}.distance`, DEFAULT_POINT_LIGHT_DISTANCE_M),
                decay: optionalFinite(r.decay, `${path}.decay`, DEFAULT_POINT_LIGHT_DECAY),
            };
        case 'spot': {
            if (r.target === undefined) throw new MeshLevelSchemaError(`${path}.target`, 'a spot light needs a target point');
            const castShadow = r.castShadow === undefined ? false : r.castShadow;
            if (typeof castShadow !== 'boolean') throw new MeshLevelSchemaError(`${path}.castShadow`, 'must be true or false');
            return {
                name, type: 'spot', position, color, intensity,
                target: requireVec3(r.target, `${path}.target`),
                angle: optionalFinite(r.angle, `${path}.angle`, DEFAULT_SPOT_ANGLE_RAD),
                penumbra: optionalFinite(r.penumbra, `${path}.penumbra`, DEFAULT_SPOT_PENUMBRA),
                castShadow,
            };
        }
        default:
            throw new MeshLevelSchemaError(`${path}.type`, "must be 'point' or 'spot'");
    }
}

/**
 * Validate raw JSON against the v1 contract. Throws `MeshLevelSchemaError` on the
 * first violation (with the JSON path), never returns a partial level. `sourceLabel`
 * names where the JSON came from for the error message ("static import", an asset id).
 */
export function parseMeshLevel(raw: unknown, sourceLabel: string): ParsedMeshLevel {
    const root = requireRecord(raw, sourceLabel);
    for (const key of Object.keys(root)) {
        if (!TOP_LEVEL_KEYS.has(key)) throw new MeshLevelSchemaError(`${sourceLabel}.${key}`, `unknown key — v1 accepts ${[...TOP_LEVEL_KEYS].join(', ')}`);
    }
    if (root.format !== MESH_LEVEL_FORMAT) throw new MeshLevelSchemaError(`${sourceLabel}.format`, `must be "${MESH_LEVEL_FORMAT}"`);
    if (root.version !== MESH_LEVEL_VERSION) throw new MeshLevelSchemaError(`${sourceLabel}.version`, `must be ${MESH_LEVEL_VERSION} (got ${String(root.version)})`);
    if (root.units !== 'meters') throw new MeshLevelSchemaError(`${sourceLabel}.units`, 'must be "meters"');

    const warnings: string[] = [];
    const colliders = optionalArray(root.colliders, 'colliders').map((c, i) => parseCollider(c, `colliders[${i}]`, warnings));
    const volumes = optionalArray(root.volumes, 'volumes').map((v, i) => parseVolume(v, `volumes[${i}]`));
    const landmarks = optionalArray(root.landmarks, 'landmarks').map((l, i) => parseLandmark(l, `landmarks[${i}]`));
    const lights = optionalArray(root.lights, 'lights').map((l, i) => parseLight(l, `lights[${i}]`));
    requireUniqueNames(colliders, 'colliders');
    requireUniqueNames(volumes, 'volumes');
    requireUniqueNames(landmarks, 'landmarks');
    requireUniqueNames(lights, 'lights');
    const extras = root.extras === undefined ? {} : requireRecord(root.extras, 'extras');

    if (colliders.length === 0) warnings.push('no colliders — nothing in this level is solid');
    if (!landmarks.some((l) => l.name === SPAWN_LANDMARK)) warnings.push(`no "${SPAWN_LANDMARK}" landmark — the player spawn comes from world.json playerSpawnPosition only`);
    if (lights.length > MANY_LIGHTS_WARNING) warnings.push(`${lights.length} lights — point lights share a small pool, spots beyond the shadow cap cast none`);

    return {
        data: { format: MESH_LEVEL_FORMAT, version: MESH_LEVEL_VERSION, units: 'meters', colliders, volumes, landmarks, lights, extras },
        warnings,
    };
}
