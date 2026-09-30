/**
 * MaterialRegistry - Defines physical properties of substances
 * 
 * Materials describe the physical properties of a substance (wood, stone, metal, etc.)
 * These properties are used for:
 * - Buoyancy calculations (density)
 * - Physics interactions (friction, restitution)
 * - Sound effects (material type)
 * 
 * Both VoxelObject block types and terrain types can reference materials.
 */

export interface MaterialProperties {
    name: string;
    
    /** 
     * Density in kg/m³. Objects less dense than water (1000) float.
     * Wood: 600, Stone: 2500, Metal: 7800
     */
    density: number;
    
    /**
     * Friction coefficient (0-1). Higher = more grip.
     * Ice: 0.1, Wood: 0.5, Rubber: 0.9
     */
    friction: number;
    
    /**
     * Restitution/bounciness (0-1). Higher = more bouncy.
     * Clay: 0.1, Wood: 0.3, Rubber: 0.8
     */
    restitution: number;
}

// Built-in material IDs
export const MaterialId = {
    NONE: 0,
    WOOD: 1,
    STONE: 2,
    DIRT: 3,
    SAND: 4,
    METAL: 5,
    ICE: 6,
    LEAVES: 7,
    GLASS: 8,
    CONCRETE: 9,
    RUBBER: 10,
} as const;

export type MaterialIdType = typeof MaterialId[keyof typeof MaterialId];

// Default materials with realistic physical properties
const DEFAULT_MATERIALS: Map<number, MaterialProperties> = new Map([
    [MaterialId.NONE, { name: 'None', density: 2000, friction: 0.5, restitution: 0.3 }],
    [MaterialId.WOOD, { name: 'Wood', density: 600, friction: 0.5, restitution: 0.3 }],
    [MaterialId.STONE, { name: 'Stone', density: 2500, friction: 0.7, restitution: 0.2 }],
    [MaterialId.DIRT, { name: 'Dirt', density: 1700, friction: 0.6, restitution: 0.1 }],
    [MaterialId.SAND, { name: 'Sand', density: 1600, friction: 0.4, restitution: 0.1 }],
    [MaterialId.METAL, { name: 'Metal', density: 7800, friction: 0.4, restitution: 0.3 }],
    [MaterialId.ICE, { name: 'Ice', density: 920, friction: 0.05, restitution: 0.2 }],
    [MaterialId.LEAVES, { name: 'Leaves', density: 300, friction: 0.3, restitution: 0.1 }],
    [MaterialId.GLASS, { name: 'Glass', density: 2500, friction: 0.4, restitution: 0.5 }],
    [MaterialId.CONCRETE, { name: 'Concrete', density: 2400, friction: 0.8, restitution: 0.2 }],
    [MaterialId.RUBBER, { name: 'Rubber', density: 1100, friction: 0.9, restitution: 0.8 }],
]);

class MaterialRegistryImpl {
    private materials: Map<number, MaterialProperties> = new Map(DEFAULT_MATERIALS);
    private nextId: number = 100; // Custom materials start at 100

    /**
     * Get material properties by ID.
     * Returns default (NONE) if not found.
     */
    get(id: number): MaterialProperties {
        return this.materials.get(id) ?? this.materials.get(MaterialId.NONE)!;
    }

    /**
     * Register a custom material.
     * Returns the assigned material ID.
     */
    register(props: MaterialProperties): number {
        const id = this.nextId++;
        this.materials.set(id, props);
        return id;
    }

    /**
     * Check if a material exists.
     */
    has(id: number): boolean {
        return this.materials.has(id);
    }

    /**
     * Get density for a material ID.
     * Returns 2000 (sinks) if not found.
     */
    getDensity(id: number): number {
        return this.materials.get(id)?.density ?? 2000;
    }

    /**
     * Get friction for a material ID.
     */
    getFriction(id: number): number {
        return this.materials.get(id)?.friction ?? 0.5;
    }

    /**
     * Get restitution for a material ID.
     */
    getRestitution(id: number): number {
        return this.materials.get(id)?.restitution ?? 0.3;
    }

    /**
     * Check if a material would float in water.
     */
    wouldFloat(id: number): boolean {
        return this.getDensity(id) < 1000;
    }

    /**
     * Get all registered materials.
     * Returns Map of material ID to properties.
     */
    getAllMaterials(): Map<number, MaterialProperties> {
        return new Map(this.materials);
    }
}

// Singleton instance
let instance: MaterialRegistryImpl | null = null;

/**
 * Get the global MaterialRegistry instance.
 */
export function getMaterialRegistry(): MaterialRegistryImpl {
    if (!instance) {
        instance = new MaterialRegistryImpl();
    }
    return instance;
}
