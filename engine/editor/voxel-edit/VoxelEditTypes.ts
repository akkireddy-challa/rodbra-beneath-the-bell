/**
 * Shared types for the unified voxel edit session (design:
 * docs/voxel-editor-design.md §4.1).
 *
 * One `VoxelEditSession` drives every voxel edit through the
 * `IEditableVoxelVolume` interface. Two implementations exist:
 *   - `TerrainVolume`     — the shared `VoxelWorld` terrain (blockId voxels,
 *                           uniform size, world-space coordinates)
 *   - `VoxelObjectVolume` — one `VoxelObject` asset (legacy chunk/blockId
 *                           voxels, or VXL v3 octree leaves with per-voxel
 *                           RGB color and variable sizes; object-local
 *                           coordinates)
 *
 * The session is deliberately ignorant of chunks, leaves, palettes, and
 * coordinate conversions — those live behind the volume.
 */

import * as THREE from 'three';
import { BlockType, type BlockTypeId, getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import type { VoxelSlot } from 'engine/VoxelMaterialSlots.js';

/**
 * What a voxel is "made of". Terrain and legacy chunk objects use atlas
 * block types (`block`); VXL v3 octree objects use plain RGB (`rgb`).
 */
export type VoxelMaterial =
    | {
        kind: 'block';
        blockType: BlockTypeId;
        /** RGB 0xRRGGBB, only meaningful when `blockType === BlockType.COLOR`; null otherwise/unknown. */
        color: number | null;
    }
    | {
        kind: 'rgb';
        /** sRGB 0xRRGGBB as shown in UI color pickers. */
        color: number;
    };

/**
 * One editable voxel as the session sees it.
 *
 * `x/y/z` is the voxel's MIN corner in the volume's native coordinate
 * space — world space for terrain, object-local (pivot-relative mesh)
 * space for objects. `size` is the cube edge length in that same space
 * (variable for octree objects, uniform elsewhere). `worldCenter` is a
 * precomputed world-space center used for highlights and UI display.
 *
 * `slot` is the voxel's MATERIAL — 0 is the base material, 1..N index the
 * volume's named slots. Glow lives on the material, not the voxel, so this is
 * what decides whether a voxel lights up. Volumes with no material system
 * always report 0 (see `VolumeCapabilities.materials`).
 */
export interface EditVoxel {
    x: number;
    y: number;
    z: number;
    size: number;
    material: VoxelMaterial;
    slot: number;
    worldCenter: THREE.Vector3;
}

/** Per-voxel features a volume supports; drives which toolbar tools appear. */
export interface VolumeCapabilities {
    /**
     * The volume has material slots: voxels can be moved between named
     * materials, and new ones created. VXL v3 octree objects only.
     */
    materials: boolean;
    /** Color-similarity selection is meaningful (RGB volumes, not block-type ones). */
    similaritySelect: boolean;
    /**
     * The selection can be painted a free RGB color. True for both voxel-object
     * generations; false for terrain, where a voxel's material IS its block
     * type and a loose color would have nowhere to live.
     */
    paintColor: boolean;
}

/** A raycast hit handed from the session to volume picking methods. */
export interface VolumeHit {
    /** Hit point in world space. */
    point: THREE.Vector3;
    /** Hit face normal in world space (unit). */
    normalWorld: THREE.Vector3;
}

/** A palette entry offered to the UI. */
export interface MaterialPaletteEntry {
    material: VoxelMaterial;
    name: string;
}

/**
 * The volume contract the session edits through. All mutating methods
 * update the underlying voxel data only — visual/physics refresh is
 * batched through `refresh()` (the session calls it after each committed
 * operation, which may cover many voxels).
 */
export interface IEditableVoxelVolume {
    readonly kind: 'terrain' | 'object';

    /** Meshes the session should raycast for in-session picking. */
    getPickMeshes(): THREE.Object3D[];

    /** Resolve a hit on a voxel face to the voxel under it, or null. */
    pickVoxel(hit: VolumeHit): EditVoxel | null;

    /** The voxel whose cell contains the native-space point, or null. */
    voxelAt(x: number, y: number, z: number): EditVoxel | null;

    /**
     * Where a new voxel would be created for a hit on an existing voxel's
     * face (adjacent cell along the face normal), or null when the spot is
     * occupied or the hit resolves to no voxel.
     */
    addPositionFor(hit: VolumeHit): { x: number; y: number; z: number; size: number } | null;

    /** Create a voxel. Returns the created voxel, or null if occupied/invalid. */
    add(x: number, y: number, z: number, size: number, material: VoxelMaterial): EditVoxel | null;

    /** Remove a voxel. True when something was removed. */
    remove(voxel: EditVoxel): boolean;

    /** Change a voxel's material. Returns the updated voxel, or null on failure. */
    changeMaterial(voxel: EditVoxel, material: VoxelMaterial): EditVoxel | null;

    /** 6-connected neighbours with the same material (flood-select support). */
    sameMaterialNeighbors(voxel: EditVoxel): EditVoxel[];

    /** Which per-voxel tools this volume can offer. */
    capabilities(): VolumeCapabilities;

    /**
     * Every voxel in the volume whose color is within `threshold` of the
     * anchor's, by `colorSimilarity()`. Unlike `sameMaterialNeighbors` this
     * is NOT connectivity-limited — it sweeps the whole volume, which is what
     * "select all similar voxels" means. Empty when `capabilities()
     * .similaritySelect` is false.
     */
    selectSimilar(anchor: EditVoxel, threshold: number): EditVoxel[];

    /** Named material slots (indices 1..N); empty when the volume has none. */
    getMaterialSlots(): VoxelSlot[];

    /** Move a voxel into material `slot` (0 = base). Returns the updated voxel, or null. */
    setSlot(voxel: EditVoxel, slot: number): EditVoxel | null;

    /**
     * Add a named material with a starting glow (0-255) and what it is MADE OF,
     * and return its slot index — or null when the volume can't take another
     * (name clash, budget reached, or no material system at all).
     *
     * The class comes in with the glow rather than in a second call because the
     * two are one decision: the glow a caller passes is normally that class's
     * own default (`defaultGlowForVoxelMaterialClass`), which is how the editor
     * stopped having to ask. Splitting them would also rebuild the mesh twice.
     */
    createMaterialSlot(name: string, emissive: number, materialClass?: string): number | null;

    /**
     * Retune how strongly material `slot` glows (0-255). Affects every voxel in
     * that material at once — that is what a material IS. Returns false for the
     * base material or an unknown slot.
     */
    setSlotEmissive(slot: number, emissive: number): boolean;

    /**
     * Set what material `slot` is MADE OF — a `VoxelMaterialClassName`, or an
     * empty string / `matte` to clear it back to the default look.
     *
     * Rebuilds the mesh, unlike `setSlotEmissive`: a glow is a uniform on an
     * existing material, but a class decides which material to BUILD (Lambert,
     * Phong or Physical) and whether that slot gets smoothed shading normals.
     * Returns false for the base material, an unknown slot, or no change.
     *
     * May also move the slot's GLOW, but only when it still equals the outgoing
     * class's default — see `VoxelObjectVolume.setSlotMaterialClass`.
     */
    setSlotMaterialClass(slot: number, materialClass: string): boolean;

    /** Orientation for world-space highlight boxes (identity for terrain). */
    getHighlightQuaternion(): THREE.Quaternion;

    /** Materials to offer in the palette UI. */
    getMaterialPalette(): MaterialPaletteEntry[];

    /** Display name for a material ("Grass", "#FFAA00", ...). */
    materialName(material: VoxelMaterial): string;

    /** Material to use for adds before the user has picked anything. */
    defaultMaterial(): VoxelMaterial;

    /** Rebuild visuals (and physics where the volume does it live) after mutations. */
    refresh(): void;

    /** Cheap content checksum for has-changes detection. */
    checksum(): number;

    /** Session lifecycle — presentation setup (isolation, cameras) and physics finalize. */
    onSessionStart(): void;
    onSessionEnd(committed: boolean): void;

    /** Per-frame tick while a session is active (e.g. orbit-control damping). */
    update(): void;
}

/** Equality used by flood-select and selection bookkeeping. */
export function materialsEqual(a: VoxelMaterial, b: VoxelMaterial): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'block' && b.kind === 'block') {
        if (a.blockType !== b.blockType) return false;
        // COLOR blocks additionally distinguish by their RGB when both known.
        if (a.blockType === BlockType.COLOR && a.color !== null && b.color !== null) {
            return a.color === b.color;
        }
        return true;
    }
    return a.kind === 'rgb' && b.kind === 'rgb' && a.color === b.color;
}

/** Capitalize the first letter of an atlas block type name ("grass" → "Grass"). */
function capitalize(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Human-readable name for an atlas block id ("Air", "Grass", "Custom Color", ...). */
export function blockTypeName(blockId: number): string {
    if (blockId === BlockType.NONE) return 'Air';
    if (blockId === BlockType.COLOR) return 'Custom Color';
    const types = getVoxelTextureAtlas().getRegisteredBlockTypes();
    const found = types.find(t => t.id === blockId);
    return found ? capitalize(found.name) : `Block ${blockId}`;
}

/** Registered atlas block types as palette entries (shared by block-based volumes). */
export function blockMaterialPalette(): MaterialPaletteEntry[] {
    const types = getVoxelTextureAtlas().getRegisteredBlockTypes();
    const entries: MaterialPaletteEntry[] = types.map(t => ({
        material: { kind: 'block', blockType: t.id as BlockTypeId, color: null },
        name: capitalize(t.name),
    }));
    entries.push({
        material: { kind: 'block', blockType: BlockType.COLOR as BlockTypeId, color: 0xffffff },
        name: 'Custom Color',
    });
    return entries;
}

/** First registered block type — the default for block-based volumes. */
export function defaultBlockMaterial(): VoxelMaterial {
    const types = getVoxelTextureAtlas().getRegisteredBlockTypes();
    const first = types[0];
    const blockType = (first !== undefined ? first.id : BlockType.NONE) as BlockTypeId;
    return { kind: 'block', blockType, color: null };
}

/**
 * Octree leaves store LINEAR [0,1] floats; the UI speaks sRGB hex.
 * These two helpers are the only conversion points.
 */
export function linearRgbToSrgbHex(r: number, g: number, b: number): number {
    const c = new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
    return c.getHex(THREE.SRGBColorSpace);
}

export function srgbHexToLinearRgb(hex: number): { r: number; g: number; b: number } {
    const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    return { r: c.r, g: c.g, b: c.b };
}

/**
 * Largest possible `redmean` distance (black vs white), used to normalise
 * `colorSimilarity` into 0-1.
 */
const REDMEAN_MAX = Math.sqrt(255 * 255 * (2 + 127.5 / 256) + 255 * 255 * 4 + 255 * 255 * (2 + 127.5 / 256));

/**
 * Perceptual distance between two sRGB hex colors, normalised to 0 (identical)
 * .. 1 (black vs white).
 *
 * Uses the "redmean" weighted-Euclidean approximation rather than plain RGB
 * distance: plain RGB rates a dark-blue/black pair as far apart as a
 * mid-green/mid-yellow pair, which makes a fuzziness slider behave differently
 * in every corner of the palette. Redmean costs three extra multiplies and is
 * close enough to CIE76 for picking "the rest of this material".
 */
export function colorSimilarity(hexA: number, hexB: number): number {
    const r1 = (hexA >> 16) & 0xff, g1 = (hexA >> 8) & 0xff, b1 = hexA & 0xff;
    const r2 = (hexB >> 16) & 0xff, g2 = (hexB >> 8) & 0xff, b2 = hexB & 0xff;
    const rMean = (r1 + r2) / 2;
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    const d = Math.sqrt(
        (2 + rMean / 256) * dr * dr
        + 4 * dg * dg
        + (2 + (255 - rMean) / 256) * db * db,
    );
    return d / REDMEAN_MAX;
}

/**
 * Map the UI's 0-100 fuzziness slider onto a `colorSimilarity` threshold.
 *
 * Squared, not linear: one RGB444 step sits around 0.035 and anything past
 * ~0.3 already swallows unrelated materials, so a linear slider would spend
 * two thirds of its travel selecting the whole object. Squaring puts the
 * useful range across the first half of the track.
 */
export function fuzzinessToThreshold(fuzziness: number): number {
    const t = Math.max(0, Math.min(100, fuzziness)) / 100;
    return t * t;
}
