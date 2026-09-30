/**
 * `IEditableVoxelVolume` over a single `VoxelObject` asset.
 *
 * Two data generations, one contract:
 *
 *  - **VXL v3 octree objects** (GLB-voxelized, .vox/.qb imports, AI
 *    generated) — edits operate on the materialised `OctreeLeaf[]`
 *    directly: variable-size leaves are the editable unit (each renders
 *    as one visible voxel), picked via `LeafSpatialIndex`, mutated
 *    through `VoxelObject.setOctreeLeavesForEdit()`. This is the
 *    VXL3-native backend the old `VoxelObjectEditMode` lacked — its
 *    chunk-store writes were invisible on octree objects
 *    (docs/voxel-editor-design.md §1.2).
 *
 *  - **Legacy chunk objects** (procedural default trees/rocks) — edits
 *    delegate to the existing chunk APIs (`setVoxelAtLocal`,
 *    `removeVoxelAt`, `changeVoxelType`), with a live-maintained voxel
 *    cache for picking and occupancy, exactly like the old edit mode.
 *
 * Native coordinate space: object-local mesh space (pivot-relative) —
 * what `getVoxelData()` returns and `worldToLocal()` produces. Octree
 * leaves are stored in bounds-space (`local + pivot`); the conversion
 * stays inside this file.
 *
 * The volume also owns the object-editing presentation: isolated view
 * (everything else hidden, dark background), an orbit camera around the
 * object, and camera save/restore — ported from `VoxelObjectEditMode`.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { BlockType, type BlockTypeId } from 'engine/VoxelTextureAtlas.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { LeafSpatialIndex } from 'engine/VoxelObjectLeafEdit.js';
import { colorToCell } from 'engine/VxlV3Format.js';
import { atlasCellRepr, atlasCellToLinearRgb } from 'engine/vxlscene/atlasColor.js';
import { MAX_VOXEL_SLOTS, VOXEL_SLOT_NAME_MAX, type VoxelSlot } from 'engine/VoxelMaterialSlots.js';
import {
    defaultGlowForVoxelMaterialClass,
    storedVoxelMaterialClassName,
} from 'engine/VoxelMaterialClass.js';
import { calculateVoxelObjectChecksum } from '../VoxelChecksum.js';
import {
    type EditVoxel,
    type IEditableVoxelVolume,
    type MaterialPaletteEntry,
    type VolumeCapabilities,
    type VolumeHit,
    type VoxelMaterial,
    blockMaterialPalette,
    blockTypeName,
    colorSimilarity,
    defaultBlockMaterial,
    linearRgbToSrgbHex,
    materialsEqual,
    srgbHexToLinearRgb,
} from './VoxelEditTypes.js';

export interface VoxelObjectVolumeDeps {
    scene: THREE.Scene;
    renderer: { domElement: HTMLCanvasElement };
    camera: THREE.PerspectiveCamera;
    voxelObject: VoxelObject;
    /** Fired after the session ends and the main camera was restored (host re-syncs its controls). */
    onCameraRestored: (() => void) | null;
}

/** Max distinct colors offered in the octree color palette. */
const MAX_RGB_PALETTE = 24;

interface ChunkCacheEntry {
    x: number; y: number; z: number; blockType: number;
    /** sRGB hex when the voxel was painted a free colour, else null. */
    color?: number | null;
}

export class VoxelObjectVolume implements IEditableVoxelVolume {
    readonly kind = 'object' as const;

    private deps: VoxelObjectVolumeDeps;
    private object: VoxelObject;
    private octree: boolean;
    /**
     * Atlas-quantised octree object: its cells carry the sRGB OETF, so cell
     * math and display conversions take a different path than vertex-color
     * objects (see `displayHex` / `hexForCell`).
     */
    private useAtlas: boolean;

    // Octree mode state
    private leaves: OctreeLeaf[] = [];
    /** Named material slots (1..N). Grows when the editor creates one. */
    private slots: VoxelSlot[] = [];
    /** This session converted a legacy chunk asset to octree leaves on open. */
    private upgradedFromChunks = false;
    private leafIndex: LeafSpatialIndex | null = null;
    private pivot = { x: 0, y: 0, z: 0 };

    // Chunk mode state — mirrors live chunk contents (maintained eagerly so
    // chained moves see their own removals).
    private chunkCache: ChunkCacheEntry[] = [];

    // Isolation / camera presentation
    private hiddenObjects: Array<{ object: THREE.Object3D; wasVisible: boolean }> = [];
    private savedBackground: THREE.Color | THREE.Texture | null = null;
    private savedFog: THREE.Fog | THREE.FogExp2 | null = null;
    private savedCameraPosition = new THREE.Vector3();
    private savedCameraQuaternion = new THREE.Quaternion();
    private orbitControls: OrbitControls | null = null;

    /**
     * Whether this object supports voxel editing. Pre-fragmented
     * multi-fragment assets keep their explosion fragment tree and are not
     * leaf-editable in v1.
     */
    static editability(object: VoxelObject): { editable: boolean; reason: string | null } {
        if (object.isOctreeV2 && object.getOctreeLeaves() === null) {
            return { editable: false, reason: 'Pre-fragmented objects cannot be voxel-edited' };
        }
        return { editable: true, reason: null };
    }

    constructor(deps: VoxelObjectVolumeDeps) {
        this.deps = deps;
        this.object = deps.voxelObject;
        this.octree = this.object.isOctreeV2;
        this.useAtlas = this.object.useAtlas;
        if (!this.octree && this.upgradeChunkObjectToOctree()) this.octree = true;

        if (this.octree) {
            this.leaves = this.object.getOctreeLeaves() ?? [];
            this.slots = [...this.object.getSlots()];
            const p = this.object.getPivot();
            if (p) this.pivot = { x: p.x, y: p.y, z: p.z };
        } else {
            this.chunkCache = this.object.getVoxelData();
        }
    }

    getVoxelObject(): VoxelObject {
        return this.object;
    }

    /** True when this session converted a legacy chunk asset on open. */
    wasUpgradedFromChunks(): boolean {
        return this.upgradedFromChunks;
    }

    /**
     * Convert a legacy JSON chunk asset into octree leaves so the whole editor
     * works on it.
     *
     * Every interesting tool — colour-similarity selection, material slots,
     * and therefore glow — is an octree feature, because that is where the
     * per-voxel colour and slot columns live. A chunk asset got a block-type
     * dropdown and nothing else, which is a dead end on assets that are
     * colour-only anyway (the format's palette is literally `[0, 255]`:
     * air and "custom colour").
     *
     * Refused for anything using TEXTURED block types: an octree leaf carries a
     * colour, not an atlas block, so converting would flatten grass and stone
     * into flat paint. Those keep the old behaviour and the toolbar says why.
     *
     * The object stays converted for the session; it only reaches disk if the
     * user saves, and then it saves as VXL3 — an upgrade, not a reinterpretation.
     */
    private upgradeChunkObjectToOctree(): boolean {
        const data = this.object.getVoxelData();
        if (data.length === 0) return false;
        if (data.some((v) => v.blockType !== BlockType.COLOR)) return false;

        const size = this.object.getVoxelSize();
        const leaves: OctreeLeaf[] = data.map((v) => {
            // leafRgbForHex lands on the same palette cell `displayHex` reads
            // back, so the converted object shows and saves the colour it had.
            const { r, g, b } = this.leafRgbForHex(v.color);
            // Chunk coords are pivot-relative and the pivot below is the
            // origin, so leaf space and local space coincide — the geometry
            // lands exactly where the chunk mesh had it.
            return { x: v.x, y: v.y, z: v.z, size, r, g, b, slot: 0 };
        });

        this.object.initFromOctreeLeaves(leaves, size, { x: 0, y: 0, z: 0 });
        this.upgradedFromChunks = true;
        return true;
    }

    // ------------------------------------------------------------------
    // Picking
    // ------------------------------------------------------------------

    getPickMeshes(): THREE.Object3D[] {
        const meshes: THREE.Object3D[] = [];
        this.object.traverse((obj) => {
            if (obj instanceof THREE.Mesh && obj.name === 'VoxelMesh') meshes.push(obj);
        });
        return meshes;
    }

    pickVoxel(hit: VolumeHit): EditVoxel | null {
        const minSize = this.object.getVoxelSize();
        // Nudge inside the voxel along the hit normal before converting.
        const adjusted = hit.point.clone().sub(hit.normalWorld.clone().multiplyScalar(minSize * 0.1));
        const local = this.object.worldToLocal(adjusted);
        return this.voxelAt(local.x, local.y, local.z);
    }

    voxelAt(x: number, y: number, z: number): EditVoxel | null {
        if (this.octree) {
            const idx = this.ensureIndex().leafIndexAt(x + this.pivot.x, y + this.pivot.y, z + this.pivot.z);
            if (idx < 0) return null;
            return this.voxelFromLeaf(this.leaves[idx]!);
        }

        const size = this.object.getVoxelSize();
        // Exact corner match first (x/y/z may come from a prior EditVoxel),
        // then nearest-corner-within-1.5-sizes as the old picker did.
        let best: ChunkCacheEntry | null = null;
        let bestDist = Infinity;
        for (const v of this.chunkCache) {
            if (this.chunkEntryNear(v, x, y, z)) {
                return this.voxelFromChunkEntry(v);
            }
            const dist = Math.hypot(v.x - x, v.y - y, v.z - z);
            if (dist < bestDist && dist < size * 1.5) {
                bestDist = dist;
                best = v;
            }
        }
        return best ? this.voxelFromChunkEntry(best) : null;
    }

    addPositionFor(hit: VolumeHit): { x: number; y: number; z: number; size: number } | null {
        const base = this.pickVoxel(hit);
        if (!base) return null;

        // Face normal in OBJECT-LOCAL space (the object may be rotated).
        const inv = new THREE.Matrix4().copy(this.object.matrixWorld).invert();
        const localNormal = hit.normalWorld.clone().transformDirection(inv);
        const nx = Math.round(localNormal.x);
        const ny = Math.round(localNormal.y);
        const nz = Math.round(localNormal.z);
        if (nx === 0 && ny === 0 && nz === 0) return null;

        // Size-matched add: the new voxel matches the face it grows from,
        // which keeps power-of-two grid alignment for octree leaves.
        const size = base.size;
        const x = base.x + nx * size;
        const y = base.y + ny * size;
        const z = base.z + nz * size;

        if (this.isOccupied(x, y, z, size)) return null;
        return { x, y, z, size };
    }

    // ------------------------------------------------------------------
    // Mutations
    // ------------------------------------------------------------------

    add(x: number, y: number, z: number, size: number, material: VoxelMaterial): EditVoxel | null {
        if (this.isOccupied(x, y, z, size)) return null;

        if (this.octree) {
            const rgbHex = material.kind === 'rgb'
                ? material.color
                : (material.color ?? 0xffffff);
            const { r, g, b } = this.leafRgbForHex(rgbHex);
            // Base material: colour and material are independent now, so a new
            // voxel does not inherit glow from whatever shares its colour. The
            // session selects it right after, so assigning a material is one
            // click away.
            const leaf: OctreeLeaf = {
                x: x + this.pivot.x,
                y: y + this.pivot.y,
                z: z + this.pivot.z,
                size,
                r, g, b,
                slot: 0,
            };
            this.leaves.push(leaf);
            this.leafIndex = null;
            return this.voxelFromLeaf(leaf);
        }

        if (material.kind !== 'block') return null;
        if (material.color !== null) this.object.setVoxelAtLocal(x, y, z, material.blockType, material.color);
        else this.object.setVoxelAtLocal(x, y, z, material.blockType);
        const entry: ChunkCacheEntry = { x, y, z, blockType: material.blockType };
        this.chunkCache.push(entry);
        return this.voxelFromChunkEntry(entry);
    }

    remove(voxel: EditVoxel): boolean {
        if (this.octree) {
            const idx = this.leafIndexForVoxel(voxel);
            if (idx < 0) return false;
            this.leaves.splice(idx, 1);
            this.leafIndex = null;
            return true;
        }

        if (!this.object.removeVoxelAt(voxel.x, voxel.y, voxel.z)) return false;
        this.chunkCache = this.chunkCache.filter(v => !this.chunkEntryNear(v, voxel.x, voxel.y, voxel.z));
        return true;
    }

    changeMaterial(voxel: EditVoxel, material: VoxelMaterial): EditVoxel | null {
        if (this.octree) {
            if (material.kind !== 'rgb') return null;
            const idx = this.leafIndexForVoxel(voxel);
            if (idx < 0) return null;
            const leaf = this.leaves[idx]!;
            const { r, g, b } = this.leafRgbForHex(material.color);
            leaf.r = r; leaf.g = g; leaf.b = b;
            // Glow rides the voxel's MATERIAL, so repainting never changes it.
            return this.voxelFromLeaf(leaf);
        }

        // Chunk objects can be painted a free colour too: `changeVoxelType`
        // only swaps the block id, so an RGB pick goes through
        // `setVoxelAtLocal` with the COLOR block type, which stores the colour
        // alongside it. Without this branch the only "colour" on a legacy
        // procedural asset was whatever its block types happened to be.
        const blockType = material.kind === 'rgb' ? (BlockType.COLOR as BlockTypeId) : material.blockType;
        const color = material.kind === 'rgb' ? material.color : material.color;

        if (material.kind === 'rgb' || blockType === BlockType.COLOR) {
            if (color === null || color === undefined) return null;
            if (!this.object.setVoxelAtLocal(voxel.x, voxel.y, voxel.z, blockType, color)) return null;
        } else if (!this.object.changeVoxelType(voxel.x, voxel.y, voxel.z, blockType)) {
            return null;
        }

        for (const v of this.chunkCache) {
            if (this.chunkEntryNear(v, voxel.x, voxel.y, voxel.z)) {
                v.blockType = blockType;
                v.color = material.kind === 'rgb' ? material.color : (material.color ?? null);
                return this.voxelFromChunkEntry(v);
            }
        }
        return null;
    }

    sameMaterialNeighbors(voxel: EditVoxel): EditVoxel[] {
        const out: EditVoxel[] = [];
        const s = voxel.size;
        const half = s / 2;
        const eps = this.object.getVoxelSize() * 0.25;
        // Probe just past each face center; finds the (one) neighbouring
        // voxel per face — for octree volumes a face shared with several
        // smaller leaves only yields the one at the face center (v1 limit).
        const probes: Array<[number, number, number]> = [
            [half, s + eps, half], [half, -eps, half],
            [s + eps, half, half], [-eps, half, half],
            [half, half, s + eps], [half, half, -eps],
        ];
        for (const [ox, oy, oz] of probes) {
            const neighbor = this.voxelAtExact(voxel.x + ox, voxel.y + oy, voxel.z + oz);
            if (neighbor && materialsEqual(neighbor.material, voxel.material)) out.push(neighbor);
        }
        return out;
    }

    // ------------------------------------------------------------------
    // Color similarity + material slots (octree objects only)
    // ------------------------------------------------------------------

    capabilities(): VolumeCapabilities {
        // Material slots are a VXL v3 octree feature — legacy chunk objects
        // have no slot column and no per-slot material array.
        return { materials: this.octree, similaritySelect: this.octree, paintColor: true };
    }

    selectSimilar(anchor: EditVoxel, threshold: number): EditVoxel[] {
        if (!this.octree || anchor.material.kind !== 'rgb') return [];
        const target = anchor.material.color;
        const out: EditVoxel[] = [];
        // Colors repeat heavily across an object, so memoise per distinct hex —
        // a 200k-leaf asset typically has a few hundred, turning the sweep into
        // a few hundred distance computations plus a map hit per leaf.
        const verdicts = new Map<number, boolean>();
        for (const leaf of this.leaves) {
            const hex = this.displayHex(leaf);
            let within = verdicts.get(hex);
            if (within === undefined) {
                within = colorSimilarity(hex, target) <= threshold;
                verdicts.set(hex, within);
            }
            if (within) out.push(this.voxelFromLeaf(leaf));
        }
        return out;
    }

    getMaterialSlots(): VoxelSlot[] {
        return this.slots;
    }

    setSlot(voxel: EditVoxel, slot: number): EditVoxel | null {
        if (!this.octree) return null;
        if (slot < 0 || slot > this.slots.length) return null;
        const idx = this.leafIndexForVoxel(voxel);
        if (idx < 0) return null;
        const leaf = this.leaves[idx]!;
        leaf.slot = slot;
        return this.voxelFromLeaf(leaf);
    }

    /**
     * Append a material. Name clashes resolve to the EXISTING slot rather than
     * failing — two "beacon"s in one asset would be two materials the runtime
     * cannot tell apart by name, which is the one thing `setSlotEmissive`
     * needs to work.
     */
    createMaterialSlot(name: string, emissive: number, materialClass?: string): number | null {
        if (!this.octree) return null;
        const trimmed = name.trim().slice(0, VOXEL_SLOT_NAME_MAX);
        if (trimmed.length === 0) return null;
        const stored = storedVoxelMaterialClassName(materialClass);

        const existing = this.slots.findIndex((s) => s.name === trimmed);
        if (existing >= 0) {
            // Resolving to the existing slot is right (see above) — silently keeping its OLD
            // glow was not. The creator was just asked "how strongly should this glow?" and
            // answered, so honour it: retuning every voxel in a material at once is what a
            // material IS. Dropping it made re-adding a material at a new percentage a no-op
            // that changed nothing, saved nothing, and reported nothing.
            this.setSlotEmissive(existing + 1, emissive);
            this.setSlotMaterialClass(existing + 1, stored);
            return existing + 1;
        }
        if (this.slots.length >= MAX_VOXEL_SLOTS) return null;

        // Class and glow arrive together, in one write. Creating the slot and
        // then classifying it would rebuild the mesh a second time for an asset
        // that has not been looked at yet, and would briefly show the material
        // unclassed — which is the state the creator was picking their way out
        // of.
        this.slots = [...this.slots, {
            name: trimmed,
            emissive: Math.max(0, Math.min(255, Math.round(emissive))),
            ...(stored.length === 0 ? {} : { materialClass: stored }),
        }];
        this.object.setSlotsForEdit(this.slots);
        // No `refresh()` here even though a class needs one: the caller moves the
        // selection into the slot it just got back, and that rebuild is the one
        // that renders it. Rebuilding twice for one create is a real cost on a
        // large asset and buys a frame nobody sees.
        return this.slots.length;
    }

    setSlotEmissive(slot: number, emissive: number): boolean {
        const entry = this.slots[slot - 1];
        if (!entry) return false;

        entry.emissive = Math.max(0, Math.min(255, Math.round(emissive)));
        // Two writes, both needed: the live material so the change is visible
        // immediately, and the slot table so it survives the save. `refresh()`
        // alone would not do it — rebuilding the mesh re-reads the table.
        this.object.setSlotsForEdit(this.slots);
        this.object.setSlotEmissive(entry.name, entry.emissive / 255);
        return true;
    }

    /**
     * Set what a material is MADE OF — its `VoxelMaterialClassName`.
     *
     * Unlike the glow above, this cannot be a live write. A glow is a uniform on a
     * material that already exists; a class decides WHICH MATERIAL to build
     * (Lambert, Phong or Physical, per `VoxelSlotMaterial`), and it also decides
     * whether that slot's vertices get smoothed shading normals. Both are settled
     * at mesh-assembly time, so the mesh has to be rebuilt — which `refresh()`
     * does, re-reading the slot table on its way through.
     *
     * An empty or `matte` class clears the field rather than storing the default,
     * keeping a slot shaped exactly as one that never had a class: that is what
     * keeps the encoder's write gate honest and the file byte-identical.
     *
     * THE GLOW FOLLOWS, BUT ONLY IF NOBODY HAS TOUCHED IT. A material still
     * sitting on its old class's default glow has never had that number decided
     * by a person, so it takes the new class's — which is what makes picking
     * `neon` the way to make something glow, and picking `wood` the way to stop.
     * Anything else is a value the creator dragged a slider to, and re-classing
     * must not quietly undo it: they can be changing what a lamp is made of
     * precisely because they already got its brightness right.
     *
     * Two classes with the SAME default are indistinguishable here — a hand-set
     * 100% on a `neon` slot reads as untouched. The outcome is identical either
     * way, so it is not worth a `touched` flag on the wire to tell apart.
     */
    setSlotMaterialClass(slot: number, materialClass: string): boolean {
        const entry = this.slots[slot - 1];
        if (!entry) return false;

        const stored = storedVoxelMaterialClassName(materialClass);
        if ((entry.materialClass ?? '') === stored) return false;

        // Read the outgoing default BEFORE the class is overwritten.
        const untouched = entry.emissive === defaultGlowForVoxelMaterialClass(entry.materialClass);
        if (stored.length === 0) {
            delete entry.materialClass;
        } else {
            entry.materialClass = stored;
        }
        if (untouched) entry.emissive = defaultGlowForVoxelMaterialClass(stored);

        // One write and one rebuild carry both changes: the mesh has to be
        // reassembled for the class anyway, and it re-reads the slot table on
        // its way through.
        this.object.setSlotsForEdit(this.slots);
        this.object.setSlotEmissive(entry.name, entry.emissive / 255);
        this.refresh();
        return true;
    }

    /** The palette cell a leaf will land in on save — the unit emissive is keyed by. */
    private cellOfLeaf(leaf: OctreeLeaf): number {
        return colorToCell(leaf.r, leaf.g, leaf.b, this.useAtlas);
    }

    /**
     * The hex the UI should show for a leaf — routed through its palette cell
     * so it is the color the asset actually RENDERS.
     *
     * Going straight from the leaf floats is only right for vertex-color
     * objects. An atlas object's floats are the linear preimage of its cell,
     * and the atlas paints the cell representative (v4·17), so the direct
     * conversion shows every swatch far too dark.
     */
    private displayHex(leaf: OctreeLeaf): number {
        return this.hexForCell(this.cellOfLeaf(leaf));
    }

    /**
     * The palette cell a UI-picked color lands on — the exact inverse of
     * `hexForCell`, so hex → cell → hex is stable in both color spaces.
     *
     * An atlas cell already carries the sRGB OETF, so its hex quantizes
     * straight down the 16-level grid; a vertex-color cell's hex is an sRGB
     * ENCODING of a linear value, so it has to be decoded first. Running the
     * atlas case through the linear path (or vice versa) shifts the cell by
     * several steps and was what made recolored atlas voxels land on the wrong
     * color entirely.
     */
    private cellOfHex(hex: number): number {
        if (this.useAtlas) {
            const q = (v: number): number => Math.max(0, Math.min(15, Math.round(v / 17)));
            return (q((hex >> 16) & 0xff) << 8) | (q((hex >> 8) & 0xff) << 4) | q(hex & 0xff);
        }
        const { r, g, b } = srgbHexToLinearRgb(hex);
        return colorToCell(r, g, b, false);
    }

    /** The on-screen color of a palette cell, as a UI hex. */
    private hexForCell(cell: number): number {
        // Atlas objects are drawn from an sRGB texture painted at the cell
        // representative, so that IS the displayed color. Vertex-color objects
        // hand the leaf floats to the renderer as linear, which encodes them
        // on output.
        if (this.useAtlas) {
            const repr = atlasCellRepr(cell);
            return (repr.r << 16) | (repr.g << 8) | repr.b;
        }
        return linearRgbToSrgbHex(
            ((cell >> 8) & 0xf) / 15, ((cell >> 4) & 0xf) / 15, (cell & 0xf) / 15,
        );
    }

    /** Leaf floats that `colorToCell` maps back to `cell` for this volume. */
    private leafRgbForCell(cell: number): { r: number; g: number; b: number } {
        if (this.useAtlas) return atlasCellToLinearRgb(cell);
        return { r: ((cell >> 8) & 0xf) / 15, g: ((cell >> 4) & 0xf) / 15, b: (cell & 0xf) / 15 };
    }

    /** Leaf floats for a UI-picked color, snapped to the cell it will be stored as. */
    private leafRgbForHex(hex: number): { r: number; g: number; b: number } {
        return this.leafRgbForCell(this.cellOfHex(hex));
    }

    private positionKey(voxel: EditVoxel): string {
        return `${voxel.x.toFixed(3)},${voxel.y.toFixed(3)},${voxel.z.toFixed(3)}`;
    }

    // ------------------------------------------------------------------
    // Presentation / lifecycle
    // ------------------------------------------------------------------

    getHighlightQuaternion(): THREE.Quaternion {
        return this.object.getWorldQuaternion(new THREE.Quaternion());
    }

    getMaterialPalette(): MaterialPaletteEntry[] {
        if (!this.octree) return blockMaterialPalette();

        // Most-used colors in the object, palette-quantised.
        const counts = new Map<number, number>();
        for (const leaf of this.leaves) {
            const hex = this.displayHex(leaf);
            counts.set(hex, (counts.get(hex) ?? 0) + 1);
        }
        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_RGB_PALETTE)
            .map(([hex]) => ({
                material: { kind: 'rgb' as const, color: hex },
                name: `#${hex.toString(16).padStart(6, '0').toUpperCase()}`,
            }));
    }

    materialName(material: VoxelMaterial): string {
        if (material.kind === 'block') return blockTypeName(material.blockType);
        return `#${material.color.toString(16).padStart(6, '0').toUpperCase()}`;
    }

    defaultMaterial(): VoxelMaterial {
        if (!this.octree) return defaultBlockMaterial();
        const first = this.leaves[0];
        const hex = first ? this.displayHex(first) : 0xffffff;
        return { kind: 'rgb', color: hex };
    }

    refresh(): void {
        if (this.octree) {
            // Flags the object leaf-edited and rebuilds the mesh; physics is
            // finalized once in onSessionEnd.
            this.object.setOctreeLeavesForEdit(this.leaves);
            this.leafIndex = null;
        } else {
            this.object.rebuild();
            this.chunkCache = this.object.getVoxelData();
        }
    }

    checksum(): number {
        return calculateVoxelObjectChecksum(this.object);
    }

    onSessionStart(): void {
        this.object.updateMatrixWorld(true);
        this.setupIsolatedView();
        this.positionCamera();
        this.setupOrbitControls();
    }

    onSessionEnd(_committed: boolean): void {
        this.disposeOrbitControls();
        this.deps.camera.position.copy(this.savedCameraPosition);
        this.deps.camera.quaternion.copy(this.savedCameraQuaternion);
        this.restoreVisibility();
        // One mesh + physics finalize for the whole session (both generations).
        this.object.refreshAfterLeafEdit();
        this.deps.onCameraRestored?.();
    }

    update(): void {
        this.orbitControls?.update();
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private ensureIndex(): LeafSpatialIndex {
        if (!this.leafIndex) {
            this.leafIndex = new LeafSpatialIndex(this.leaves, this.object.getVoxelSize());
        }
        return this.leafIndex;
    }

    /** Index of the leaf containing a voxel's center (bounds-space), or -1. */
    private leafIndexForVoxel(voxel: EditVoxel): number {
        return this.ensureIndex().leafIndexAt(
            voxel.x + this.pivot.x + voxel.size / 2,
            voxel.y + this.pivot.y + voxel.size / 2,
            voxel.z + this.pivot.z + voxel.size / 2,
        );
    }

    /** Containment-only lookup (no nearest-voxel fallback) in local space. */
    private voxelAtExact(x: number, y: number, z: number): EditVoxel | null {
        if (this.octree) {
            const idx = this.ensureIndex().leafIndexAt(x + this.pivot.x, y + this.pivot.y, z + this.pivot.z);
            return idx < 0 ? null : this.voxelFromLeaf(this.leaves[idx]!);
        }
        const size = this.object.getVoxelSize();
        for (const v of this.chunkCache) {
            if (x >= v.x && x < v.x + size && y >= v.y && y < v.y + size && z >= v.z && z < v.z + size) {
                return this.voxelFromChunkEntry(v);
            }
        }
        return null;
    }

    private isOccupied(x: number, y: number, z: number, size: number): boolean {
        if (this.octree) {
            const p = this.pivot;
            return this.ensureIndex().overlapsBox(
                x + p.x, y + p.y, z + p.z,
                x + p.x + size, y + p.y + size, z + p.z + size,
            );
        }
        return this.chunkCache.some(v => this.chunkEntryNear(v, x, y, z));
    }

    /** Corner-match a chunk cache entry within the picker's tolerance (0.4 voxels). */
    private chunkEntryNear(entry: ChunkCacheEntry, x: number, y: number, z: number): boolean {
        const tolerance = this.object.getVoxelSize() * 0.4;
        return Math.abs(entry.x - x) < tolerance
            && Math.abs(entry.y - y) < tolerance
            && Math.abs(entry.z - z) < tolerance;
    }

    private voxelFromLeaf(leaf: OctreeLeaf): EditVoxel {
        const x = leaf.x - this.pivot.x;
        const y = leaf.y - this.pivot.y;
        const z = leaf.z - this.pivot.z;
        const center = new THREE.Vector3(x + leaf.size / 2, y + leaf.size / 2, z + leaf.size / 2);
        this.object.localToWorld(center);
        return {
            x, y, z,
            size: leaf.size,
            material: { kind: 'rgb', color: this.displayHex(leaf) },
            slot: leaf.slot ?? 0,
            worldCenter: center,
        };
    }

    private voxelFromChunkEntry(entry: ChunkCacheEntry): EditVoxel {
        const size = this.object.getVoxelSize();
        const center = new THREE.Vector3(entry.x + size / 2, entry.y + size / 2, entry.z + size / 2);
        this.object.localToWorld(center);
        return {
            x: entry.x,
            y: entry.y,
            z: entry.z,
            size,
            material: {
                kind: 'block',
                blockType: entry.blockType as BlockTypeId,
                // getVoxelData() doesn't return colours, so only voxels this
                // session painted carry one; everything else stays null
                // (old-editor parity).
                color: entry.color ?? null,
            },
            // Legacy chunk objects have no material slots.
            slot: 0,
            worldCenter: center,
        };
    }

    // ---- isolated-view presentation (ported from VoxelObjectEditMode) ----

    private setupIsolatedView(): void {
        this.hiddenObjects = [];
        this.savedBackground = this.deps.scene.background;
        this.savedFog = this.deps.scene.fog;
        this.deps.scene.background = new THREE.Color(0x1a1a2e);
        this.deps.scene.fog = null;

        let targetRoot: THREE.Object3D = this.object;
        while (targetRoot.parent && targetRoot.parent !== this.deps.scene) {
            targetRoot = targetRoot.parent;
        }

        this.deps.scene.children.forEach((child) => {
            if (child === targetRoot || this.isAncestorOf(child, this.object)) return;
            if (child instanceof THREE.Light) return;
            if (child.name === 'VoxelEditHighlight') return;
            if (child.visible) {
                this.hiddenObjects.push({ object: child, wasVisible: true });
                child.visible = false;
            }
        });
    }

    private restoreVisibility(): void {
        for (const state of this.hiddenObjects) {
            state.object.visible = state.wasVisible;
        }
        this.hiddenObjects = [];
        if (this.savedBackground !== null) this.deps.scene.background = this.savedBackground;
        if (this.savedFog !== null) this.deps.scene.fog = this.savedFog;
    }

    private isAncestorOf(potentialAncestor: THREE.Object3D, target: THREE.Object3D): boolean {
        let current: THREE.Object3D | null = target;
        while (current) {
            if (current === potentialAncestor) return true;
            current = current.parent;
        }
        return false;
    }

    /**
     * Frame the object so it fills the view.
     *
     * Distance is solved from the camera's own FOV (and the horizontal FOV
     * when the viewport is narrow) rather than a fixed multiple of the
     * bounding box — a flat 2.5× left small props as a speck in the middle of
     * the screen, which is unusable when the job is picking one voxel.
     */
    private frameDistanceFor(size: THREE.Vector3): number {
        const camera = this.deps.camera;
        const vFov = THREE.MathUtils.degToRad(camera.fov);
        const fitHeight = size.y / 2 / Math.tan(vFov / 2);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        const fitWidth = Math.max(size.x, size.z) / 2 / Math.tan(hFov / 2);
        // 1.3 leaves a little air around the object; the depth half-extent
        // keeps a long object from poking through the near plane.
        return Math.max(fitHeight, fitWidth) * 1.3 + Math.max(size.x, size.z) / 2;
    }

    private positionCamera(): void {
        this.savedCameraPosition.copy(this.deps.camera.position);
        this.savedCameraQuaternion.copy(this.deps.camera.quaternion);

        const box = new THREE.Box3().setFromObject(this.object);
        const center = box.getCenter(new THREE.Vector3());
        const distance = this.frameDistanceFor(box.getSize(new THREE.Vector3()));

        // Three-quarter view, slightly above.
        const dir = new THREE.Vector3(0.7, 0.45, 0.7).normalize();
        this.deps.camera.position.copy(center).addScaledVector(dir, distance);
        this.deps.camera.lookAt(center);
        this.deps.camera.updateProjectionMatrix();
    }

    private setupOrbitControls(): void {
        const box = new THREE.Box3().setFromObject(this.object);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, this.object.getVoxelSize());

        this.orbitControls = new OrbitControls(this.deps.camera, this.deps.renderer.domElement);
        this.orbitControls.target.copy(center);
        this.orbitControls.enableDamping = true;
        this.orbitControls.dampingFactor = 0.1;
        this.orbitControls.rotateSpeed = 0.9;
        this.orbitControls.zoomSpeed = 1.2;
        this.orbitControls.enableZoom = true;
        this.orbitControls.enablePan = true;
        // Per-voxel work means getting right up against the surface, so the
        // near limit is a few voxels rather than a fraction of the object.
        this.orbitControls.minDistance = Math.max(this.object.getVoxelSize() * 2, maxDim * 0.02);
        this.orbitControls.maxDistance = maxDim * 12;
        this.orbitControls.update();
    }

    private disposeOrbitControls(): void {
        this.orbitControls?.dispose();
        this.orbitControls = null;
    }
}
