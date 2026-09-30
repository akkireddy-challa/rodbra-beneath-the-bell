/**
 * GLB material -> voxel material slot.
 *
 * The slot a voxel belongs to comes from the material of the triangle that
 * shaded it, which is what makes "which material is this" an authoring
 * decision rather than a colour coincidence: a modeller marks the headlight
 * faces with a `BM_slot_headlights` material and the baked asset has a
 * headlight material it can turn on and off.
 *
 * Assignment runs AFTER voxelization, over the finished leaves, for two
 * reasons: it is identical for both voxelizer algorithms (the octree walk and
 * the surface rasteriser, which share no colour path), and it costs nothing at
 * all for the assets — nearly all of them — whose GLB declares no slots.
 *
 * The rule matches how colour was chosen: a leaf takes the slot of the triangle
 * CLOSEST to its centre, so a voxel that was shaded by a headlight triangle is
 * a headlight voxel. Leaves nowhere near slot-declaring geometry are rejected
 * by a spatial hash before any distance work happens.
 *
 * A slot also picks up what it is MADE OF, from the source material's own PBR
 * values rather than from a second naming convention — see `declaredClass`. So a
 * `BM_slot_blade` material the modeller made metallic bakes as a metal slot with
 * nothing further to write down.
 *
 * Where the PBR values say nothing, the SLOT'S OWN NAME is read as a last resort:
 * `BM_slot_fur` is a fur slot. That is not the second convention this file just
 * refused — it adds no prefix and no syntax, and naming a slot after a class is
 * already a load-bearing idiom elsewhere (`VxlMaterialSlotTransforms` recognises
 * exactly these slots as ones re-classification owns). It also covers the classes
 * PBR values physically cannot distinguish: fur, cloth and leather are the same
 * metalness and roughness, so a modeller who means fur has no way to say so
 * through the material's numbers.
 */

import * as THREE from 'three';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import type { Triangle } from 'engine/GLBVoxelizer.js';
import { buildSlotTable, slotNameFromMaterialName, type VoxelSlot } from 'engine/VoxelMaterialSlots.js';
import { isVoxelMaterialClassName } from 'engine/VoxelMaterialClass.js';

export interface SlotAssignResult {
    /** Named slots actually used, ready for `VxlV3Data.slots`. Empty = nothing to do. */
    slots: VoxelSlot[];
    /** How many leaves ended up in a named slot — 0 means the lights missed entirely. */
    assigned: number;
    /** Slot names that exceeded the material budget; a bake note, never an error. */
    dropped: string[];
}

/**
 * A GLB material's declared glow, 0..255, from its emissive factor x strength.
 * This is what a slot starts at, so a material authored as lit (headlights) is
 * lit the moment it loads, and one authored dark (a beacon waiting for its
 * flasher) stays dark until something drives it.
 */
function declaredEmissive(material: THREE.MeshStandardMaterial | null): number {
    if (!material) return 0;
    const colour = material.emissive;
    if (!colour) return 0;
    const peak = Math.max(colour.r, colour.g, colour.b);
    const strength = material.emissiveIntensity ?? 1;
    return Math.max(0, Math.min(255, Math.round(peak * strength * 255)));
}

/**
 * A GLB material's declared MATERIAL CLASS, or undefined for an ordinary surface.
 *
 * Read from the PBR values the modeller already set rather than from a second
 * naming convention: a Blender artist who made the sword's blade metallic and its
 * grip rough has already said what those surfaces are, and asking them to also
 * spell `BM_class_metal` into the material name would be asking twice.
 *
 * The mapping is deliberately coarse — four outcomes from two inputs — because it
 * is a snap to the nearest named class, not a transfer of parameters. The class
 * table owns the actual look, so a `metal` voxel gets the engine's tuned metal
 * regardless of whether the GLB said 0.8 or 1.0.
 *
 * A CLASS FROM HERE MUST NEVER BRING ITS DEFAULT GLOW WITH IT. `declaredEmissive`
 * right above reads the modeller's own emissive factor, which is a real answer to
 * the same question — including when the answer is zero, for a beacon authored
 * dark and waiting for its flasher. Today the two cannot collide, because this
 * function only ever returns a surface class. If it is ever taught to read
 * `material.emissive` and return a light class, the glow still has to come from
 * the GLB and not from `defaultGlowForVoxelMaterialClass`, or importing a model
 * silently overwrites what its author set.
 */
function declaredClass(material: THREE.MeshStandardMaterial | null): string | undefined {
    if (!material) return undefined;
    const metalness = typeof material.metalness === 'number' ? material.metalness : 0;
    const roughness = typeof material.roughness === 'number' ? material.roughness : 1;
    // glTF's own default is metalness 1 / roughness 1, which almost nothing means
    // literally — most exporters write it for untouched materials. Treat a fully
    // rough "metal" as unstated rather than as brushed iron.
    if (metalness >= 0.5) {
        if (roughness >= 0.95) return undefined;
        return roughness <= 0.12 ? 'chrome' : 'metal';
    }
    // A dielectric with a tight highlight is glass or a gem in voxel terms; the
    // class table treats both as hard and bright. Anything broader is left alone:
    // guessing wood from roughness 0.6 would be inventing a material.
    if (roughness <= 0.1) return 'glass';
    return undefined;
}

/**
 * The class a slot declares by being NAMED after one, or undefined.
 *
 * Second in line behind {@link declaredClass}: a modeller who set the PBR values
 * has made the stronger statement, and this must not override it. What it catches
 * is everything those values cannot express — `BM_slot_fur`, `BM_slot_wood`,
 * `BM_slot_cloth` all have the same metalness and roughness as each other and as
 * an untouched material, so without this there is no way at all to author them.
 *
 * Only names already in the vocabulary count, so an ordinary `BM_slot_headlights`
 * stays exactly what it was.
 */
function classFromSlotName(name: string): string | undefined {
    const lower = name.trim().toLowerCase();
    return isVoxelMaterialClassName(lower) ? lower : undefined;
}

/**
 * Tag `leaves` with the material slots their source triangles declare. Mutates
 * `leaf.slot` in place and returns the slot table to store alongside them.
 */
export function assignVoxelSlotsFromTriangles(
    leaves: OctreeLeaf[],
    triangles: Triangle[],
): SlotAssignResult {
    const empty: SlotAssignResult = { slots: [], assigned: 0, dropped: [] };
    if (leaves.length === 0 || triangles.length === 0) return empty;

    // 1. Which materials declare a slot, and what each slot starts at.
    const declared: Array<{ name: string; emissive: number; materialClass?: string }> = [];
    const nameOfTriangle = new Array<string | null>(triangles.length);
    let anySlotTriangle = false;
    for (let i = 0; i < triangles.length; i++) {
        const name = slotNameFromMaterialName(triangles[i]!.material?.name);
        nameOfTriangle[i] = name;
        if (name === null) continue;
        anySlotTriangle = true;
        const material = triangles[i]!.material;
        const materialClass = declaredClass(material) ?? classFromSlotName(name);
        declared.push({
            name,
            emissive: declaredEmissive(material),
            ...(materialClass === undefined ? {} : { materialClass }),
        });
    }
    if (!anySlotTriangle) return empty;

    const { slots, dropped } = buildSlotTable(declared);
    if (slots.length === 0) return { slots: [], assigned: 0, dropped };
    const indexByName = new Map(slots.map((s, i) => [s.name, i + 1]));

    // Per-triangle slot index (0 = ordinary geometry).
    const slotOfTriangle = new Uint8Array(triangles.length);
    for (let i = 0; i < triangles.length; i++) {
        const name = nameOfTriangle[i] ?? null;
        if (name !== null) slotOfTriangle[i] = indexByName.get(name) ?? 0;
    }

    // 2–3. Nearest-triangle ownership, shared with the smart-object part channel.
    const owner = nearestOwnerForLeaves(leaves, triangles, (i) => slotOfTriangle[i]!);
    let assigned = 0;
    for (let i = 0; i < leaves.length; i++) {
        if (owner[i]! > 0) {
            leaves[i]!.slot = owner[i]!;
            assigned++;
        }
    }

    return { slots, assigned, dropped };
}

/**
 * For every leaf, the OWNER of the triangle closest to its centre — 0 for
 * "none". `ownerOfTriangle` maps a triangle index to a small positive integer
 * (a material slot, a smart-object joint); triangles that answer 0 still take
 * part in the distance contest, so a body triangle can win a leaf back from a
 * nearby part triangle. Leaves out of reach of any owned triangle skip the
 * distance work entirely, which is what keeps this free for an ordinary model.
 *
 * The spatial hash is sized to the coarsest leaf so a leaf's own cell plus its
 * 26 neighbours always contain the closest triangle to its centre.
 */
export function nearestOwnerForLeaves(
    leaves: readonly OctreeLeaf[],
    triangles: readonly Triangle[],
    ownerOfTriangle: (index: number) => number,
): Uint8Array {
    const owner = new Uint8Array(leaves.length);
    if (leaves.length === 0 || triangles.length === 0) return owner;

    let maxLeaf = 0;
    for (const leaf of leaves) if (leaf.size > maxLeaf) maxLeaf = leaf.size;
    const cell = Math.max(maxLeaf, 1e-3);
    const inv = 1 / cell;
    const buckets = new Map<number, number[]>();
    // Cells within reach of owned geometry — the fast reject.
    const ownedCells = new Set<number>();
    const lo = new THREE.Vector3();
    const hi = new THREE.Vector3();
    for (let i = 0; i < triangles.length; i++) {
        const t = triangles[i]!;
        lo.set(Math.min(t.v0.x, t.v1.x, t.v2.x), Math.min(t.v0.y, t.v1.y, t.v2.y), Math.min(t.v0.z, t.v1.z, t.v2.z));
        hi.set(Math.max(t.v0.x, t.v1.x, t.v2.x), Math.max(t.v0.y, t.v1.y, t.v2.y), Math.max(t.v0.z, t.v1.z, t.v2.z));
        const x0 = Math.floor(lo.x * inv), x1 = Math.floor(hi.x * inv);
        const y0 = Math.floor(lo.y * inv), y1 = Math.floor(hi.y * inv);
        const z0 = Math.floor(lo.z * inv), z1 = Math.floor(hi.z * inv);
        const owned = ownerOfTriangle(i) > 0;
        for (let z = z0; z <= z1; z++) {
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    const key = hashCell(x, y, z);
                    let bucket = buckets.get(key);
                    if (!bucket) { bucket = []; buckets.set(key, bucket); }
                    bucket.push(i);
                    // Mark this cell AND its neighbours: a leaf one cell away can
                    // still have this triangle as its closest.
                    if (owned) {
                        for (let dz = -1; dz <= 1; dz++) {
                            for (let dy = -1; dy <= 1; dy++) {
                                for (let dx = -1; dx <= 1; dx++) {
                                    ownedCells.add(hashCell(x + dx, y + dy, z + dz));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    const centre = new THREE.Vector3();
    const closest = new THREE.Vector3();
    for (let li = 0; li < leaves.length; li++) {
        const leaf = leaves[li]!;
        const half = leaf.size * 0.5;
        centre.set(leaf.x + half, leaf.y + half, leaf.z + half);
        const cx = Math.floor(centre.x * inv), cy = Math.floor(centre.y * inv), cz = Math.floor(centre.z * inv);
        if (!ownedCells.has(hashCell(cx, cy, cz))) continue;

        let bestDistSq = Infinity;
        let best = 0;
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const bucket = buckets.get(hashCell(cx + dx, cy + dy, cz + dz));
                    if (!bucket) continue;
                    for (const ti of bucket) {
                        const t = triangles[ti]!;
                        closestPointOnTriangle(centre, t.v0, t.v1, t.v2, closest);
                        const distSq = centre.distanceToSquared(closest);
                        if (distSq < bestDistSq) {
                            bestDistSq = distSq;
                            best = ownerOfTriangle(ti);
                        }
                    }
                }
            }
        }
        owner[li] = best;
    }
    return owner;
}

/** Cheap 3D cell hash. Collisions only cost a few extra distance tests. */
function hashCell(x: number, y: number, z: number): number {
    return (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
}

/**
 * Closest point on triangle (a, b, c) to `p`, by Ericson's Real-Time Collision
 * Detection barycentric-region test. Written here rather than reused from the
 * voxelizer so this module stays independent of its internals.
 */
function closestPointOnTriangle(
    p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
    out: THREE.Vector3,
): THREE.Vector3 {
    const abX = b.x - a.x, abY = b.y - a.y, abZ = b.z - a.z;
    const acX = c.x - a.x, acY = c.y - a.y, acZ = c.z - a.z;
    const apX = p.x - a.x, apY = p.y - a.y, apZ = p.z - a.z;

    const d1 = abX * apX + abY * apY + abZ * apZ;
    const d2 = acX * apX + acY * apY + acZ * apZ;
    if (d1 <= 0 && d2 <= 0) return out.copy(a);

    const bpX = p.x - b.x, bpY = p.y - b.y, bpZ = p.z - b.z;
    const d3 = abX * bpX + abY * bpY + abZ * bpZ;
    const d4 = acX * bpX + acY * bpY + acZ * bpZ;
    if (d3 >= 0 && d4 <= d3) return out.copy(b);

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return out.set(a.x + abX * v, a.y + abY * v, a.z + abZ * v);
    }

    const cpX = p.x - c.x, cpY = p.y - c.y, cpZ = p.z - c.z;
    const d5 = abX * cpX + abY * cpY + abZ * cpZ;
    const d6 = acX * cpX + acY * cpY + acZ * cpZ;
    if (d6 >= 0 && d5 <= d6) return out.copy(c);

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return out.set(a.x + acX * w, a.y + acY * w, a.z + acZ * w);
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return out.set(b.x + (c.x - b.x) * w, b.y + (c.y - b.y) * w, b.z + (c.z - b.z) * w);
    }

    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    return out.set(a.x + abX * v + acX * w, a.y + abY * v + acY * w, a.z + abZ * v + acZ * w);
}
