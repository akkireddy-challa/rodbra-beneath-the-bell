import * as THREE from 'three';
import { VoxelObject } from 'engine/VoxelObject.js';
import { BlockType, type BlockTypeId } from 'engine/VoxelTextureAtlas.js';
import type { VoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { convertChunkObjectToOctree } from 'engine/VoxelChunkToOctree.js';
import { smartPropBake, type AssetBox, type SmartPropBake } from 'engine/import/SmartPropParts.js';
import type { SmartPropSpec } from 'types/smartObject.js';
import { buildSlotTable, slotIndexOf } from 'engine/VoxelMaterialSlots.js';
import { defaultGlowForVoxelMaterialClass } from 'engine/VoxelMaterialClass.js';

/**
 * Configuration for a single voxel block in an object.
 */
export interface VoxelBlockConfig {
    /** X position in voxel units (relative to object origin) */
    x: number;
    /** Y position in voxel units (relative to object origin) */
    y: number;
    /** Z position in voxel units (relative to object origin) */
    z: number;
    /** Block color (hex, e.g., 0xff0000 for red). Used when blockType is not specified. */
    color: number;
    /**
     * Block type - either a name ("wood", "leaves", "stone") or ID number.
     * When specified, uses textured rendering instead of vertex colors.
     * Available types: wood, trunk, leaves, foliage, stone, rock, grass, sand, dirt, ice, asphalt, road, water, lava, marble
     */
    blockType?: string | number;
}

/**
 * Configuration for a box part that gets filled with voxels.
 *
 * Position is the MIN corner (not center). Size gives exact dimensions.
 * This ensures predictable voxel placement - adjacent parts align when edges match.
 */
/** `userData` key under which a built smart object keeps its bake for the asset record. */
export const SMART_PROP_BAKE = 'smartPropBake';

export interface VoxelPartConfig {
    /** MIN corner position in meters (not center) */
    position: { x: number; y: number; z: number };
    /** Size in meters (exact voxel count = round(size / voxelSize)) */
    size: { width: number; height: number; length: number };
    /** Block color (hex). Used when blockType is not specified. */
    color: number;
    /**
     * Block type - either a name ("wood", "leaves", "stone") or ID number.
     * When specified, uses textured rendering instead of vertex colors.
     * Available types: wood, trunk, leaves, foliage, stone, rock, grass, sand, dirt, ice, asphalt, road, water, lava, marble
     */
    blockType?: string | number;
    /**
     * Fill shape within the part box:
     * - 'box' (default): every voxel in the box
     * - 'sphere': only voxels inside the ellipsoid inscribed in the box (use for balls, domes, boulders)
     */
    shape?: 'box' | 'sphere';
    /**
     * How brightly this part GLOWS, 0-100. Use it for anything that would
     * conceivably emit light: a street lamp's bulb, a sign's lettering, a
     * window at night, a warning beacon. The glow takes the part's own colour,
     * so an amber bulb glows amber.
     *
     * The part becomes a named MATERIAL (see `material`), which is what makes
     * it controllable at runtime — `voxelObject.setSlotEmissive('light', 0)`
     * turns the lamp off without touching geometry.
     *
     * OPTIONAL EVEN FOR A LIGHT. Left out on a part that names a light class
     * (`materialClass: 'neon'`), the class's own default glow applies, so the
     * class alone is a complete description. Given, it wins outright — `0` on a
     * `neon` part is a sign waiting to be switched on, not a missing value.
     */
    emissive?: number;
    /**
     * Material name for an emissive part; parts sharing a name share one
     * material and light together. Defaults to `'light'`, so a lamp needs only
     * `emissive`. Ignored when the part neither glows nor names a class.
     */
    material?: string;
    /**
     * What this part is MADE OF — one of the names in
     * `engine/VoxelMaterialClass.ts` — a surface (`metal`, `gold`, `chrome`,
     * `gem`, `glass`, `wood`, `stone`, `cloth`, `fur`, `leather`, `plastic`,
     * `paint`) or a light (`filament`, `neon`, `lava`) — or omitted for the
     * default flat look.
     *
     * This is how a chest gets shining gold banding while its body stays matte
     * wood: the part becomes a named MATERIAL whose class decides how it responds
     * to light. An unrecognised name renders as the default rather than failing.
     *
     * The light classes bring a glow with them, so `materialClass: 'filament'`
     * on a bulb needs no `emissive` — see that field for how the two combine.
     *
     * A part carrying only `materialClass` becomes a material named after the
     * class; give `material` as well to name it something the game can address at
     * runtime.
     */
    materialClass?: string;
    /**
     * The smart-object PART this box belongs to — a name from
     * `VoxelObjectConfig.smart.parts`. Boxes sharing a name form one moving
     * part (a windmill's four blades and their hub); a box with no `part` is the
     * static body. Nothing moves unless `smart` names the part.
     */
    part?: string;
}

/**
 * Configuration for building a voxel object.
 * 
 * Two ways to define object:
 * 1. SIMPLE (recommended): Use 'parts' array - define boxes in meters
 * 2. DETAILED: Use 'blocks' array - specify individual voxel positions
 */
export interface VoxelObjectConfig {
    /** Object name (for display and identification) */
    name: string;
    
    /** Array of voxel blocks (low-level, individual voxels) */
    blocks?: VoxelBlockConfig[];
    
    /** Array of box parts (high-level, boxes in meters that get filled with voxels) */
    parts?: VoxelPartConfig[];

    /**
     * Moving parts and lights, by the `part` names the boxes carry — what makes
     * the object a SMART OBJECT the engine animates with no game code (see
     * types/smartObject.ts). Pivots and light positions are in the same
     * MIN-corner metre frame as `parts[].position`.
     */
    smart?: SmartPropSpec;
    
    /** Voxel size in world units (default: 0.25m for detailed objects, smaller = more detail) */
    voxelSize?: number;
    
    /** 
     * Physics mode:
     * - 'static': Object doesn't move (buildings, statues, furniture)
     * - 'dynamic': Object can move and be pushed (balls, crates, movable props)
     * Default: 'static'
     */
    physicsMode?: 'static' | 'dynamic';
    
    /**
     * Mass in kg (only used for dynamic objects).
     * Default: auto-calculated based on voxel count (1kg per voxel)
     */
    mass?: number;

    /**
     * Collider shape for dynamic objects (default 'box'):
     * - 'box': cuboid colliders from the voxel grid
     * - 'sphere': single ball collider sized to the bounds, so the object rolls
     *   (balls, boulders). Mass is density-driven; the `mass` field is ignored.
     */
    colliderShape?: 'box' | 'sphere';
    
    /** Enable shadow casting and receiving (default: true) */
    shadows?: boolean;
    
    /**
     * How to interpret the position parameter:
     * - 'center': Position is where the object's center goes (default, good for trees/props)
     * - 'corner': Position is where the object's min corner goes (good for sidewalks/floors)
     */
    positionMode?: 'center' | 'corner';
}

/**
 * Result from creating a voxel object
 */
export interface VoxelObjectResult {
    /** The created VoxelObject */
    object: VoxelObject;
    /** Unique ID for this object */
    id: string;
}

/**
 * VoxelObjectBuilder - Creates voxel objects with automatic physics.
 * 
 * Usage: VoxelObjectBuilder.create(config, physicsWorld, position)
 * 
 * Parts use MIN CORNER positioning (not center) for predictable alignment.
 * Physics collisions are generated automatically from the voxel geometry.
 * 
 * The engine automatically registers the world group after genre loading.
 * Objects created via create() are added to the world group, keeping
 * the scene hierarchy clean and allowing visibility toggling of all voxel
 * content by hiding the world group.
 * 
 * For non-VoxelObjectBuilder objects (meshes, groups), use
 * engine.addToWorld(obj) instead of engine.scene.add(obj).
 */
export class VoxelObjectBuilder {
    /** Track all created voxel objects for management */
    private static createdObjects: Map<string, VoxelObject> = new Map();
    /** World group that all created objects are added to */
    private static worldGroup: THREE.Object3D | null = null;

    /**
     * Set the world group that VoxelObjectBuilder adds objects to.
     * Called automatically by the engine after world generation completes.
     * Pass null to clear (done on dispose).
     */
    static setWorldGroup(group: THREE.Object3D | null): void {
        VoxelObjectBuilder.worldGroup = group;
    }

    /** Get the current world group (null if not set). */
    static getWorldGroup(): THREE.Object3D | null {
        return VoxelObjectBuilder.worldGroup;
    }

    /**
     * Register an externally-created VoxelObject so it appears in getAllObjects() and getObjectsGroupedByName().
     * Used by EnvironmentObjectSystem to register interactable environment objects.
     */
    static registerExternalObject(id: string, voxelObject: VoxelObject): void {
        VoxelObjectBuilder.createdObjects.set(id, voxelObject);
    }

    /** Forget an external object whose owner is responsible for disposing it. */
    static unregisterExternalObject(id: string): void {
        VoxelObjectBuilder.createdObjects.delete(id);
    }

    /**
     * Get a created object by its ID
     */
    static getObject(id: string): VoxelObject | undefined {
        return VoxelObjectBuilder.createdObjects.get(id);
    }

    /**
     * Get all created objects
     */
    static getAllObjects(): Map<string, VoxelObject> {
        return VoxelObjectBuilder.createdObjects;
    }

    /**
     * Get all created objects grouped by their name.
     * Useful for batch operations like scene unlock.
     */
    static getObjectsGroupedByName(): Map<string, VoxelObject[]> {
        const grouped = new Map<string, VoxelObject[]>();
        for (const obj of VoxelObjectBuilder.createdObjects.values()) {
            const name = obj.name || 'unnamed';
            const existing = grouped.get(name);
            if (existing) existing.push(obj);
            else grouped.set(name, [obj]);
        }
        return grouped;
    }

    /**
     * Create a voxel object and add it to the world group.
     *
     * New API (preferred):
     *   VoxelObjectBuilder.create(config, physicsWorld, position, atlas)
     *
     * Legacy API (backward compatible — 2nd arg is a THREE.Object3D):
     *   VoxelObjectBuilder.create(config, parent, physicsWorld, position, atlas)
     *
     * Objects are automatically parented to the world group registered via
     * setWorldGroup(). The legacy parent parameter is accepted for backward
     * compatibility but the engine will reparent objects to the world group
     * after world generation completes.
     */
    static create(
        config: VoxelObjectConfig,
        parentOrPhysics?: THREE.Object3D | PhysicsWorld,
        physicsOrPosition?: PhysicsWorld | THREE.Vector3,
        positionOrAtlas?: THREE.Vector3 | VoxelTextureAtlas,
        atlas?: VoxelTextureAtlas
    ): VoxelObjectResult {
        let parent: THREE.Object3D | undefined;
        let physicsWorld: PhysicsWorld | undefined;
        let position: THREE.Vector3 | undefined;
        let resolvedAtlas: VoxelTextureAtlas | undefined;

        if (parentOrPhysics instanceof THREE.Object3D) {
            parent = parentOrPhysics;
            physicsWorld = physicsOrPosition as PhysicsWorld | undefined;
            position = positionOrAtlas as THREE.Vector3 | undefined;
            resolvedAtlas = atlas;
        } else {
            physicsWorld = parentOrPhysics as PhysicsWorld | undefined;
            position = physicsOrPosition as THREE.Vector3 | undefined;
            resolvedAtlas = positionOrAtlas as VoxelTextureAtlas | undefined;
        }

        const resolvedParent = parent ?? VoxelObjectBuilder.worldGroup;
        const voxelSize = config.voxelSize ?? 0.25;
        const physicsMode = config.physicsMode ?? 'static';

        // Check if any parts or blocks use block types (for useAtlas flag)
        const usesBlockTypes = (config.parts?.some(p => p.blockType !== undefined) ?? false) ||
                               (config.blocks?.some(b => b.blockType !== undefined) ?? false);

        // Create the voxel object
        const voxelObject = new VoxelObject({
            voxelSize,
            shadows: config.shadows ?? true
        });
        voxelObject.name = config.name;

        // Set useAtlas if using block types
        if (usesBlockTypes) {
            voxelObject.setUseAtlas(true);
        }

        // Count voxels for mass calculation
        let voxelCount = 0;

        // Add parts as voxels (if provided)
        if (config.parts && config.parts.length > 0) {
            for (const part of config.parts) {
                voxelCount += VoxelObjectBuilder.addPartAsVoxels(voxelObject, part, voxelSize, resolvedAtlas);
            }
        }

        // Add individual blocks (if provided)
        if (config.blocks && config.blocks.length > 0) {
            for (const block of config.blocks) {
                // Resolve block type if specified
                let resolvedBlockType: number = BlockType.COLOR;
                if (block.blockType !== undefined) {
                    if (typeof block.blockType === 'number') {
                        resolvedBlockType = block.blockType;
                    } else if (typeof block.blockType === 'string' && resolvedAtlas) {
                        const id = resolvedAtlas.getBlockIdByName(block.blockType);
                        if (id !== undefined) {
                            resolvedBlockType = id;
                        }
                    }
                }
                const voxelColor = resolvedBlockType === BlockType.COLOR ? block.color : 0;
                voxelObject.setVoxel(block.x, block.y, block.z, resolvedBlockType as BlockTypeId, voxelColor);
                voxelCount++;
            }
        }

        // Finalize the voxel object (builds mesh and calculates pivot)
        voxelObject.finalize();

        // Parts that glow or declare a material CLASS become material SLOTS.
        // Slots are a VXL3 feature and the builder writes chunks, so the object is
        // converted to octree leaves here — that is also what lets the prop glow,
        // or shine, immediately in the scene rather than only once it has been
        // saved and reloaded.
        //
        // AFTER finalize on purpose: `getVoxelData()` reports pivot-relative
        // coordinates, and the pivot only becomes readable once finalize has
        // computed it. Running this first left `getPivot()` at the origin while
        // the voxels were already centred, so the part boxes matched nothing
        // and every light came out unlit.
        VoxelObjectBuilder.applyPartChannels(voxelObject, config, voxelSize);

        // Set position based on positioning mode
        if (position) {
            const positionMode = config.positionMode ?? 'center';
            if (positionMode === 'corner') {
                // Corner mode: offset by pivot so MIN CORNER is at specified position
                const pivot = voxelObject.getPivot();
                if (pivot) {
                    voxelObject.position.set(
                        position.x + pivot.x,
                        position.y,
                        position.z + pivot.z
                    );
                } else {
                    voxelObject.position.copy(position);
                }
            } else {
                // Center mode (default): position is where the center goes
                voxelObject.position.copy(position);
            }
        }

        resolvedParent?.add(voxelObject);

        // Create physics body if physics world is provided
        if (physicsWorld) {
            if (physicsMode === 'dynamic') {
                const mass = config.mass ?? voxelCount;
                voxelObject.createDynamicPhysicsBody(physicsWorld, mass, undefined,
                    config.colliderShape ? { colliderShape: config.colliderShape } : undefined);
            } else {
                voxelObject.createPhysicsBody(physicsWorld);
            }
        }

        // Generate unique ID and register with ObjectIdService
        const idService = getObjectIdService();
        const id = idService.generateId('object');
        idService.register(id, 'object', voxelObject, { 
            name: config.name,
            physicsMode,
            voxelSize 
        });

        // Track in our registry
        VoxelObjectBuilder.createdObjects.set(id, voxelObject);


        return { object: voxelObject, id };
    }

    /**
     * Create multiple instances of the same object at different positions.
     * Uses the registered world group as parent (see setWorldGroup).
     *
     * @param config - Object configuration
     * @param physicsWorld - Optional physics world
     * @param positions - Array of positions for each instance
     * @param atlas - Optional texture atlas for resolving block type names
     * @returns Array of created objects and their IDs
     */
    static createMultiple(
        config: VoxelObjectConfig,
        physicsWorld: PhysicsWorld | undefined,
        positions: THREE.Vector3[],
        atlas?: VoxelTextureAtlas
    ): VoxelObjectResult[] {
        return positions.map(pos => VoxelObjectBuilder.create(config, physicsWorld, pos, atlas));
    }

    /**
     * Convert a box part to voxels and add to VoxelObject.
     * Position is MIN corner, size gives exact voxel count.
     *
     * @param voxelObject - The VoxelObject to add voxels to
     * @param part - Part configuration with position, size, color, and optional blockType
     * @param voxelSize - Size of each voxel in meters
     * @param atlas - Optional texture atlas for resolving block type names
     * @returns Number of voxels added
     */
    /**
     * Turn every part carrying `emissive` or `materialClass` into a material slot
     * and move that part's voxels into it.
     *
     * Slot membership is decided by testing each voxel against the declaring
     * parts' boxes rather than by tracking voxels during rasterisation: the
     * chunk store has no slot column to record it in, and the boxes are exact,
     * so a point test reproduces the same set with no bookkeeping. Two parts
     * that share a `material` name share one slot — they light together, and they
     * are made of the same thing.
     */
    private static applyPartChannels(
        voxelObject: VoxelObject,
        config: VoxelObjectConfig,
        voxelSize: number,
    ): void {
        // A part earns a slot by glowing OR by being made of something. Both are
        // material properties, and both need the same per-voxel slot column.
        const lit = (config.parts ?? []).filter(
            (p) => (p.emissive ?? 0) > 0 || (p.materialClass ?? '').trim().length > 0,
        );
        // Smart-object parts need the same conversion for the same reason: the
        // owning joint is a per-leaf column too. Decided by the same box test —
        // a box with a `part` name owns its voxels for that part, later boxes win.
        const smart = VoxelObjectBuilder.smartPartBoxes(config, voxelObject.getPivot() ?? { x: 0, y: 0, z: 0 });
        if (lit.length === 0 && !smart) return;

        const declared = lit.map((p) => {
            const materialClass = (p.materialClass ?? '').trim();
            // A glowing part with no name is a 'light', as it always was; a part
            // that is only DECLARING A MATERIAL is named after that material, so
            // `materialClass: 'gold'` needs nothing else to become a gold slot.
            const fallback = materialClass.length > 0 ? materialClass : 'light';
            return {
                name: (p.material ?? fallback).trim() || fallback,
                // An UNSTATED glow takes the class's default, so `materialClass:
                // 'neon'` is a complete description of a neon tube and a part
                // does not have to name a number to be a light. An explicit one
                // always wins, `0` included: a beacon authored dark is waiting
                // for its flasher, not missing a value.
                emissive: p.emissive === undefined
                    ? defaultGlowForVoxelMaterialClass(materialClass)
                    : Math.round(Math.max(0, Math.min(100, p.emissive)) / 100 * 255),
                ...(materialClass.length > 0 ? { materialClass } : {}),
            };
        });
        const { slots } = buildSlotTable(declared);
        if (slots.length === 0 && !smart) return;

        // `getVoxelData()` reports PIVOT-RELATIVE coordinates while the part
        // boxes are in raw build space, so the pivot has to be added back
        // before testing — comparing the two spaces directly matches nothing
        // and every light silently comes out unlit.
        const pivot = voxelObject.getPivot() ?? { x: 0, y: 0, z: 0 };
        // A voxel's MIN corner sits inside the part box it came from; test the
        // voxel CENTRE so a box edge lands on one side or the other, never both.
        const half = voxelSize / 2;
        const inBox = (x: number, y: number, z: number, { position: pos, size }: VoxelPartConfig): boolean =>
            x >= pos.x && x <= pos.x + size.width
            && y >= pos.y && y <= pos.y + size.height
            && z >= pos.z && z <= pos.z + size.length;
        const slotForPoint = (lx: number, ly: number, lz: number): number => {
            const x = lx + pivot.x + half;
            const y = ly + pivot.y + half;
            const z = lz + pivot.z + half;
            for (let i = 0; i < lit.length; i++) {
                if (inBox(x, y, z, lit[i]!)) return slotIndexOf(slots, declared[i]!.name);
            }
            return 0;
        };
        // Later boxes win, mirroring the Forger's rule for overlapping parts.
        const boneForPoint = (lx: number, ly: number, lz: number): number => {
            if (!smart) return 0;
            const x = lx + pivot.x + half;
            const y = ly + pivot.y + half;
            const z = lz + pivot.z + half;
            let joint = 0;
            for (const { box, joint: candidate } of smart.boxes) {
                if (inBox(x, y, z, box)) joint = candidate;
            }
            return joint;
        };

        convertChunkObjectToOctree(
            voxelObject, slots,
            slots.length > 0 ? (v) => slotForPoint(v.x, v.y, v.z) : undefined,
            smart ? (v) => boneForPoint(v.x, v.y, v.z) : undefined,
        );
        if (smart) {
            voxelObject.setSmartPartsForEdit({ rig: smart.bake.rig, parts: smart.bake.table });
            voxelObject.userData[SMART_PROP_BAKE] = smart.bake;
        }
    }

    /**
     * The smart-object bake for a config that declares one: the parts table and
     * rig, the fitment for the record, and which BUILD-space box owns which joint.
     *
     * Boxes are in build space (MIN corners, like `parts[].position`), where the
     * voxel test below happens; the asset frame the record uses is
     * pivot-relative, so bounds, declared pivots and light positions all move
     * by the object pivot on their way into the bake. Null when the config
     * declares nothing, or names only parts no box carries.
     */
    private static smartPartBoxes(
        config: VoxelObjectConfig,
        pivot: { x: number; y: number; z: number },
    ): { boxes: Array<{ box: VoxelPartConfig; joint: number }>; bake: SmartPropBake } | null {
        const spec = config.smart;
        if (!spec || (spec.parts.length === 0 && !(spec.lights?.length))) return null;

        // Each named group's bounds, in build space.
        const groups = new Map<string, AssetBox>();
        for (const part of config.parts ?? []) {
            if (!part.part) continue;
            const { position: p, size } = part;
            const box = groups.get(part.part)
                ?? { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
            box.min = { x: Math.min(box.min.x, p.x), y: Math.min(box.min.y, p.y), z: Math.min(box.min.z, p.z) };
            box.max = {
                x: Math.max(box.max.x, p.x + size.width),
                y: Math.max(box.max.y, p.y + size.height),
                z: Math.max(box.max.z, p.z + size.length),
            };
            groups.set(part.part, box);
        }
        const toAsset = (v: { x: number; y: number; z: number }): { x: number; y: number; z: number } =>
            ({ x: v.x - pivot.x, y: v.y - pivot.y, z: v.z - pivot.z });
        const assetBoxes = new Map<string, AssetBox>();
        for (const [name, box] of groups) assetBoxes.set(name, { min: toAsset(box.min), max: toAsset(box.max) });

        const warnings: string[] = [];
        const bake = smartPropBake(spec, assetBoxes, toAsset, warnings);
        for (const warning of warnings) console.warn(`[VoxelObjectBuilder] ${config.name}: ${warning}`);
        if (!bake) return null;

        // Joint i + 1 is `bake.table[i]`; every box carrying that part's name owns its voxels for it.
        const jointOf = new Map(bake.table.map((part, index) => [part.name, index + 1]));
        const boxes: Array<{ box: VoxelPartConfig; joint: number }> = [];
        for (const part of config.parts ?? []) {
            const joint = part.part ? jointOf.get(part.part) : undefined;
            if (joint) boxes.push({ box: part, joint });
        }
        return { boxes, bake };
    }

    static addPartAsVoxels(
        voxelObject: VoxelObject,
        part: VoxelPartConfig,
        voxelSize: number,
        atlas?: VoxelTextureAtlas
    ): number {
        const { position, size, color, blockType, shape } = part;

        // Resolve block type from name or use directly
        let resolvedBlockType: number = BlockType.COLOR;
        if (blockType !== undefined) {
            if (typeof blockType === 'number') {
                resolvedBlockType = blockType;
            } else if (typeof blockType === 'string' && atlas) {
                const id = atlas.getBlockIdByName(blockType);
                if (id !== undefined) {
                    resolvedBlockType = id;
                } else {
                    console.warn(`[VoxelObjectBuilder] Unknown block type name: "${blockType}", falling back to color`);
                }
            } else if (typeof blockType === 'string' && !atlas) {
                console.warn(`[VoxelObjectBuilder] Block type name "${blockType}" specified but no atlas provided, falling back to color`);
            }
        }

        // Position is MIN corner, size gives exact voxel count
        const startX = Math.round(position.x / voxelSize);
        const startY = Math.round(position.y / voxelSize);
        const startZ = Math.round(position.z / voxelSize);
        const endX = startX + Math.round(size.width / voxelSize) - 1;
        const endY = startY + Math.round(size.height / voxelSize) - 1;
        const endZ = startZ + Math.round(size.length / voxelSize) - 1;

        // When using a textured block type, don't pass color (use 0)
        // When using COLOR block type, pass the actual color
        const voxelColor = resolvedBlockType === BlockType.COLOR ? color : 0;

        // For sphere parts, only keep voxels whose center lies inside the
        // ellipsoid inscribed in the part box (radii = half the box extents).
        const isSphere = shape === 'sphere';
        const centerX = (startX + endX + 1) / 2;
        const centerY = (startY + endY + 1) / 2;
        const centerZ = (startZ + endZ + 1) / 2;
        const radiusX = Math.max((endX - startX + 1) / 2, 0.5);
        const radiusY = Math.max((endY - startY + 1) / 2, 0.5);
        const radiusZ = Math.max((endZ - startZ + 1) / 2, 0.5);

        let count = 0;
        for (let x = startX; x <= endX; x++) {
            for (let y = startY; y <= endY; y++) {
                for (let z = startZ; z <= endZ; z++) {
                    if (isSphere) {
                        const dx = (x + 0.5 - centerX) / radiusX;
                        const dy = (y + 0.5 - centerY) / radiusY;
                        const dz = (z + 0.5 - centerZ) / radiusZ;
                        if (dx * dx + dy * dy + dz * dz > 1) {
                            continue;
                        }
                    }
                    voxelObject.setVoxel(x, y, z, resolvedBlockType as BlockTypeId, voxelColor);
                    count++;
                }
            }
        }

        return count;
    }

    /**
     * Remove a voxel object from its parent and the registry.
     * 
     * @param id - The object ID to remove
     */
    static remove(id: string): void {
        const voxelObject = VoxelObjectBuilder.createdObjects.get(id);
        if (voxelObject) {
            voxelObject.parent?.remove(voxelObject);
            voxelObject.dispose();
            VoxelObjectBuilder.createdObjects.delete(id);
            getObjectIdService().unregister(id);
            console.log(`🗑️ Removed VoxelObject (id: ${id})`);
        }
    }

    /**
     * Remove all created voxel objects from their parents and the registry.
     */
    static removeAll(): void {
        for (const [id, voxelObject] of VoxelObjectBuilder.createdObjects) {
            voxelObject.parent?.remove(voxelObject);
            voxelObject.dispose();
            getObjectIdService().unregister(id);
        }
        VoxelObjectBuilder.createdObjects.clear();
        console.log('🗑️ Removed all VoxelObjects');
    }
}
