/**
 * Bake-time authored-color MATERIAL CLASS matcher for baked levels — the class-name
 * sibling of `emissiveByColor.ts`. The forger authors `materialByColor` (keys `#RRGGBB`,
 * values from the closed `VoxelMaterialClass` vocabulary: "this colour is stone, that one
 * wood"); this resolves that map against the RGB444 palette cells a bake actually
 * produced, enforces the per-level class budget, and hands back the per-palette-entry
 * class assignment the v9 `.vwld` section stores.
 *
 * Matching differs from the emissive matcher's exact-only rule ON PURPOSE: terrain
 * colours are jittered at build time (the forger's default `brightnessJitter` ≈ 0.06
 * spreads one authored colour across neighbouring RGB444 cells), so an exact match
 * would label a sliver of a mountain and leave the rest matte. Each authored key
 * therefore claims its exact cell first, then any cell within ±1 RGB444 step per
 * channel. Precedence per palette cell is deterministic: an exact claim always beats a
 * tolerance claim; among tolerance claims the nearest colour wins; remaining ties go to
 * the lexicographically smaller authored key. Blend-band mid-colours farther than one
 * step from every authored colour stay matte, which reads fine — the rule colour is the
 * band's centre.
 *
 * The class BUDGET lives here rather than in the forger because only the bake knows
 * real per-cell coverage: over `maxClasses` distinct non-matte classes, the
 * smallest-coverage class collapses along its `collapsesTo` chain (gold→metal,
 * gem→glass — losing detail rather than lying), or drops to matte when the chain ends.
 * The budget is what keeps the renderer's per-class batch split bounded
 * (`VxlSceneRenderer` draws one extra batch per class per bias step).
 *
 * Pure and side-effect-free, like `applyEmissiveByColor`: no I/O, no file-format
 * knowledge, unit-tested directly.
 */

import {
    DEFAULT_VOXEL_MATERIAL_CLASS,
    isVoxelMaterialClassName,
    resolveVoxelMaterialClass,
    type VoxelMaterialClassName,
} from 'engine/VoxelMaterialClass.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';

/**
 * Distinct non-matte classes a level may carry. Deliberately low until measured on a
 * real scene, for the same reason as the asset path's `MAX_MATERIAL_SLOTS_PER_ASSET`:
 * every class multiplies the terrain's batch count per bias step.
 */
export const MAX_LEVEL_MATERIAL_CLASSES = 3;

export interface ClassByColorResult {
    /**
     * The distinct non-matte classes that survived the budget, largest coverage
     * first (deterministic; ties break by name). At most `maxClasses` entries.
     */
    classNames: VoxelMaterialClassName[];
    /**
     * Class per palette entry, parallel to the input `paletteCells`:
     * 0 = matte/none, i+1 = `classNames[i]`.
     */
    classIdxByPaletteEntry: Uint8Array;
    /**
     * `materialByColor` keys that never claimed a palette cell — a bake note, not
     * an error (mirrors `emissiveUnmatched`). Includes malformed hex keys.
     */
    unmatched: string[];
    /** Human-readable collapse/ignore notes for the bake log. */
    notes: string[];
}

/** Parse `#RRGGBB` (leading `#` optional) into 0..255 channels, or null if malformed. */
function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m) return null;
    const v = parseInt(m[1]!, 16);
    return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

interface ClassEntry {
    key: string;
    cell: number;
    className: VoxelMaterialClassName;
    matched: boolean;
}

/**
 * Resolve a forger-authored `materialByColor` map against a bake's palette cells.
 *
 * `paletteCells[i]` is the RGB444 atlas cell of palette entry i and `cellCoverage[i]`
 * how much geometry (quads/voxels) that cell covers — the weight the budget collapse
 * uses. Both arrays are parallel. Entries whose class is `matte` are accepted and
 * count as matched, but produce no class (they pin a cell to the default so a
 * neighbouring tolerance claim cannot take it).
 */
export function applyClassByColor(
    paletteCells: ArrayLike<number>,
    cellCoverage: ArrayLike<number>,
    materialByColor: Record<string, string>,
    maxClasses: number = MAX_LEVEL_MATERIAL_CLASSES,
): ClassByColorResult {
    const notes: string[] = [];
    const unmatched: string[] = [];

    const entries: ClassEntry[] = [];
    for (const [key, rawName] of Object.entries(materialByColor)) {
        const name = typeof rawName === 'string' ? rawName.trim().toLowerCase() : '';
        if (!isVoxelMaterialClassName(name)) {
            // Unknown names are dropped with a note, NOT normalised to matte: a
            // silent matte would hide a misspelled class behind a flat surface.
            notes.push(`unknown material class "${String(rawName)}" for ${key} — ignored`);
            continue;
        }
        const parsed = parseHexColor(key);
        if (!parsed) {
            unmatched.push(key);
            continue;
        }
        entries.push({
            key,
            cell: rgb888ToAtlasCell(parsed.r, parsed.g, parsed.b),
            className: name,
            matched: false,
        });
    }
    // Iteration order IS the tie-break: lexicographically smaller key claims first.
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const n = paletteCells.length;
    const assigned: (VoxelMaterialClassName | null)[] = new Array<VoxelMaterialClassName | null>(n).fill(null);

    // Pass 1 — exact cell equality. Beats every tolerance claim.
    for (const e of entries) {
        for (let i = 0; i < n; i++) {
            if (paletteCells[i] === e.cell && assigned[i] === null) {
                assigned[i] = e.className;
                e.matched = true;
            }
        }
    }

    // Pass 2 — ±1 RGB444 step per channel (the build-time jitter's spread), nearest
    // colour wins; the entry sort above settles exact-distance ties.
    for (let i = 0; i < n; i++) {
        if (assigned[i] !== null) continue;
        const cell = paletteCells[i]!;
        const r = (cell >> 8) & 0xf, g = (cell >> 4) & 0xf, b = cell & 0xf;
        let best: ClassEntry | null = null;
        let bestDist = Infinity;
        for (const e of entries) {
            const dr = Math.abs(((e.cell >> 8) & 0xf) - r);
            const dg = Math.abs(((e.cell >> 4) & 0xf) - g);
            const db = Math.abs((e.cell & 0xf) - b);
            if (dr > 1 || dg > 1 || db > 1) continue;
            const dist = dr * dr + dg * dg + db * db;
            if (dist < bestDist) {
                bestDist = dist;
                best = e;
            }
        }
        if (best) {
            assigned[i] = best.className;
            best.matched = true;
        }
    }

    for (const e of entries) {
        if (!e.matched) unmatched.push(e.key);
    }

    // Coverage per non-matte class, for the budget collapse.
    const coverage = new Map<VoxelMaterialClassName, number>();
    for (let i = 0; i < n; i++) {
        const c = assigned[i] ?? null;
        if (c === null || c === DEFAULT_VOXEL_MATERIAL_CLASS) continue;
        coverage.set(c, (coverage.get(c) ?? 0) + (cellCoverage[i] ?? 0));
    }

    // Budget: collapse the smallest-coverage class along its chain until under the cap.
    const cap = Math.max(0, Math.floor(maxClasses));
    while (coverage.size > cap) {
        let smallest: VoxelMaterialClassName | null = null;
        let smallestCov = Infinity;
        for (const [c, cov] of coverage) {
            if (cov < smallestCov || (cov === smallestCov && (smallest === null || c < smallest))) {
                smallest = c;
                smallestCov = cov;
            }
        }
        const from = smallest!;
        const chain = resolveVoxelMaterialClass(from).collapsesTo;
        const to = chain !== null && chain !== DEFAULT_VOXEL_MATERIAL_CLASS ? chain : null;
        for (let i = 0; i < n; i++) {
            if (assigned[i] === from) assigned[i] = to;
        }
        const cov = coverage.get(from)!;
        coverage.delete(from);
        if (to !== null) {
            coverage.set(to, (coverage.get(to) ?? 0) + cov);
            notes.push(`over the ${cap}-class level budget: ${from} collapsed into ${to}`);
        } else {
            notes.push(`over the ${cap}-class level budget: ${from} dropped to matte`);
        }
    }

    const classNames = [...coverage.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([c]) => c);
    const idxByName = new Map(classNames.map((c, i) => [c, i + 1]));
    const classIdxByPaletteEntry = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const c = assigned[i] ?? null;
        if (c !== null && c !== DEFAULT_VOXEL_MATERIAL_CLASS) {
            classIdxByPaletteEntry[i] = idxByName.get(c) ?? 0;
        }
    }

    return { classNames, classIdxByPaletteEntry, unmatched, notes };
}
