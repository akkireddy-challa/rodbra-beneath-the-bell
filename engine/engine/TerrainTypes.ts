/**
 * Built-in foliage type IDs.
 * Use FoliageTypeRegistry to register custom foliage types with IDs >= 100.
 */
export enum FoliageType {
    NONE = 0,
    MEADOW = 1,
    FIELD = 2,
    BEACH = 3,
    FOREST = 4,
    DESERT = 5
}

/**
 * Properties for a foliage type.
 * Built-in types (MEADOW, BEACH, etc.) have default creators in VoxelFoliageSystem.
 * Custom types must provide a creator function via CustomFoliageType.
 */
export interface FoliageTypeProperties {
    name: string;
}

/**
 * Registry for foliage types.
 * Built-in types (0-99) are reserved. Custom types start at 100.
 * 
 * Usage in templates:
 */
export class FoliageTypeRegistry {
    private types: Map<number, FoliageTypeProperties> = new Map();
    private nextId: number = 100; // Custom types start at 100

    constructor() {
        // Register built-in types
        this.types.set(FoliageType.NONE, { name: 'none' });
        this.types.set(FoliageType.MEADOW, { name: 'meadow' });
        this.types.set(FoliageType.FIELD, { name: 'field' });
        this.types.set(FoliageType.BEACH, { name: 'beach' });
        this.types.set(FoliageType.FOREST, { name: 'forest' });
        this.types.set(FoliageType.DESERT, { name: 'desert' });
    }

    /**
     * Register a new custom foliage type.
     * Returns the assigned ID (>= 100) which can be used in TerrainTypeProperties.foliageType.
     */
    registerType(properties: FoliageTypeProperties): number {
        const id = this.nextId++;
        this.types.set(id, properties);
        return id;
    }

    /**
     * Get properties for a foliage type ID.
     */
    getType(id: number): FoliageTypeProperties | undefined {
        return this.types.get(id);
    }

    /**
     * Check if a foliage type ID is a built-in type (0-99).
     */
    isBuiltIn(id: number): boolean {
        return id < 100;
    }

    /**
     * Get all registered foliage types.
     */
    getAllTypes(): Map<number, FoliageTypeProperties> {
        return new Map(this.types);
    }
}

/**
 * Fluid physics properties for non-solid terrain types (water, lava, slime, etc.)
 * These properties control buoyancy, swimming, and wave behavior.
 */
export interface FluidProperties {
    /** 
     * Fluid density relative to water (1.0 = water, 3.0 = lava, 1.5 = slime).
     * Higher density = more buoyancy force on objects.
     */
    density: number;
    
    /** 
     * Buoyancy force multiplier. 1.0 = realistic buoyancy based on density.
     * Higher values make objects float more easily.
     */
    buoyancyMultiplier: number;
    
    /** 
     * Movement resistance when moving through fluid (0.0 = air, 0.3 = water, 0.8 = slime).
     * Affects swimming speed and object movement through fluid.
     */
    viscosity: number;
    
    /** 
     * How many blocks deep entities sink before floating (neck-deep point).
     * Player/NPCs start swimming when submerged this deep.
     */
    maxSubmersionDepth: number;
    
    // ════════════════════════════════════════════════════════════════════════════════
    // WAVE PHYSICS - Spring-based surface oscillation
    // ════════════════════════════════════════════════════════════════════════════════
    
    /** 
     * Spring stiffness for wave oscillation. Higher = faster bounce back.
     * Water: ~8.0, Lava: ~3.0 (slower), Slime: ~4.0
     */
    waveStiffness: number;
    
    /** 
     * Damping factor for wave oscillation (0-1). Higher = waves settle faster.
     * Water: ~0.1 (long-lasting waves), Lava: ~0.3 (heavy, settles fast)
     */
    waveDamping: number;
    
    /** 
     * How fast waves propagate to neighboring blocks (blocks per second).
     * Water: ~4.0, Lava: ~1.5 (slow heavy waves)
     */
    wavePropagationSpeed: number;
    
    /** 
     * Amplitude reduction per block traveled (0-1). 
     * 0.15 = 15% loss per block = waves travel ~6-7 blocks before fading.
     */
    waveAmplitudeDecay: number;
}

/**
 * Default fluid properties for water-like fluids.
 * Use as a base and override specific values for custom fluids.
 */
export const DEFAULT_FLUID_PROPERTIES: FluidProperties = {
    density: 1.0,
    buoyancyMultiplier: 1.0,
    viscosity: 0.3,
    maxSubmersionDepth: 1.5,
    waveStiffness: 8.0,
    waveDamping: 0.1,
    wavePropagationSpeed: 4.0,
    waveAmplitudeDecay: 0.15
};

/**
 * Terrain/block material properties.
 * Used for both 2D terrain types and 3D voxel block types.
 * All new properties are optional for backward compatibility.
 */
export interface TerrainTypeProperties {
    // ════════════════════════════════════════════════════════════════════════════════
    // IDENTITY & FOLIAGE
    // ════════════════════════════════════════════════════════════════════════════════
    name: string;
    /** 
     * Foliage type ID. Use FoliageType enum for built-in types (MEADOW, BEACH, etc.)
     * or a custom ID from FoliageTypeRegistry.registerType() for custom foliage.
     */
    foliageType: number;
    canPlaceTrees?: boolean;
    canPlaceRocks?: boolean;
    color?: { r: number; g: number; b: number };
    
    // ════════════════════════════════════════════════════════════════════════════════
    // SURFACE PHYSICS (applies to all terrain types)
    // ════════════════════════════════════════════════════════════════════════════════
    
    /** 
     * Damage dealt per second when entity is on/in this terrain.
     * Lava: 50, Acid: 25, Normal terrain: undefined (no damage)
     */
    damagePerSecond?: number;
    
    // ════════════════════════════════════════════════════════════════════════════════
    // COLLISION BEHAVIOR
    // ════════════════════════════════════════════════════════════════════════════════
    
    /** 
     * true = hard collision (default), false = fluid (entities can enter).
     * Solid blocks stop movement; fluid blocks allow entry with resistance.
     */
    isSolid?: boolean;
    
    // ════════════════════════════════════════════════════════════════════════════════
    // FLUID PROPERTIES (only used when isSolid: false)
    // ════════════════════════════════════════════════════════════════════════════════
    
    /** 
     * Fluid physics properties. Only applies when isSolid is false.
     * Controls buoyancy, swimming, wave propagation, etc.
     */
    fluidProperties?: FluidProperties;
    
    // ════════════════════════════════════════════════════════════════════════════════
    // VISUAL PROPERTIES
    // ════════════════════════════════════════════════════════════════════════════════
    
    /** 
     * Opacity for rendering (0.0 = invisible, 1.0 = fully opaque).
     * Default: 1.0. Water: ~0.6, Glass: ~0.3
     */
    opacity?: number;
}

export const TERRAIN_FLAGS = {
    FOLIAGE_BIT: 0x01,
    ENVIRONMENT_OBJECTS_BIT: 0x02
};

export function getBaseTerrainType(encodedType: number): number {
    return encodedType >> 2;
}

export function hasFoliageFlag(encodedType: number): boolean {
    return (encodedType & TERRAIN_FLAGS.FOLIAGE_BIT) !== 0;
}

export function hasEnvironmentObjectsFlag(encodedType: number): boolean {
    return (encodedType & TERRAIN_FLAGS.ENVIRONMENT_OBJECTS_BIT) !== 0;
}

export function encodeTerrainType(baseType: number, allowFoliage: boolean, allowEnvironmentObjects: boolean): number {
    let flags = 0;
    if (allowFoliage) flags |= TERRAIN_FLAGS.FOLIAGE_BIT;
    if (allowEnvironmentObjects) flags |= TERRAIN_FLAGS.ENVIRONMENT_OBJECTS_BIT;
    return (baseType << 2) | flags;
}

export class TerrainTypeRegistry {
    private types: Map<number, TerrainTypeProperties> = new Map();
    private nextId: number = 1;

    constructor() {
        // Only register NONE (type 0) - all other types are registered by templates
        this.registerType(0, {
            name: 'None',
            foliageType: FoliageType.NONE,
            canPlaceTrees: false,
            canPlaceRocks: false
        });
    }

    /**
     * Get the next available terrain type ID.
     * Templates should call this to get a dynamic ID for new terrain types.
     */
    getNextId(): number {
        return this.nextId;
    }

    registerType(id: number, properties: TerrainTypeProperties): void {
        this.types.set(id, properties);
        if (id >= this.nextId) {
            this.nextId = id + 1;
        }
    }

    getType(id: number): TerrainTypeProperties | undefined {
        return this.types.get(id);
    }

    getAllTypes(): Map<number, TerrainTypeProperties> {
        return new Map(this.types);
    }

    getNextAvailableId(): number {
        return this.nextId;
    }
}

// ============================================================================
// Terrain Type Creation Utilities
// Templates call these to register common terrain types.
// ============================================================================

export function createGrassTerrainType(registry: TerrainTypeRegistry): number {
    const id = registry.getNextId();
    registry.registerType(id, {
            name: 'Grass',
            foliageType: FoliageType.MEADOW,
            canPlaceTrees: true,
            canPlaceRocks: true,
            color: { r: 0.1, g: 0.3, b: 0.1 }
        });
    return id;
}

export function createSandTerrainType(registry: TerrainTypeRegistry): number {
    const id = registry.getNextId();
    registry.registerType(id, {
            name: 'Sand',
            foliageType: FoliageType.BEACH,
            canPlaceTrees: false,
            canPlaceRocks: true,
            color: { r: 0.4, g: 0.35, b: 0.25 }
        });
    return id;
}

export function createAsphaltTerrainType(registry: TerrainTypeRegistry): number {
    const id = registry.getNextId();
    registry.registerType(id, {
            name: 'Asphalt',
            foliageType: FoliageType.NONE,
            canPlaceTrees: false,
            canPlaceRocks: false,
            color: { r: 0.2, g: 0.2, b: 0.2 }
        });
    return id;
}

export function createIceTerrainType(registry: TerrainTypeRegistry): number {
    const id = registry.getNextId();
    registry.registerType(id, {
            name: 'Ice',
            foliageType: FoliageType.NONE,
            canPlaceTrees: false,
            canPlaceRocks: false,
            color: { r: 0.8, g: 0.9, b: 1.0 }
        });
    return id;
}

export function createLavaTerrainType(registry: TerrainTypeRegistry): number {
    const id = registry.getNextId();
    registry.registerType(id, {
            name: 'Lava',
            foliageType: FoliageType.NONE,
            damagePerSecond: 50,
            canPlaceTrees: false,
            canPlaceRocks: false,
            color: { r: 1.0, g: 0.2, b: 0.0 }
        });
    return id;
}

export function createDirtTerrainType(registry: TerrainTypeRegistry): number {
    const id = registry.getNextId();
    registry.registerType(id, {
            name: 'Dirt',
            foliageType: FoliageType.NONE,
            canPlaceTrees: true,
            canPlaceRocks: true,
            color: { r: 0.5, g: 0.3, b: 0.1 }
        });
    return id;
}

export function createStoneTerrainType(registry: TerrainTypeRegistry): number {
    const id = registry.getNextId();
    registry.registerType(id, {
            name: 'Stone',
            foliageType: FoliageType.NONE,
            canPlaceTrees: false,
            canPlaceRocks: true,
            color: { r: 0.5, g: 0.5, b: 0.5 }
        });
    return id;
}

// ============================================================================
// Fluid Terrain Type Creation Utilities
// These create non-solid terrain types with buoyancy and wave physics.
// ============================================================================

/**
 * Create a water terrain type with default fluid properties.
 * Semi-transparent blue, allows swimming, creates waves on disturbance.
 */
export function createWaterTerrainType(registry: TerrainTypeRegistry): number {
    const id = registry.getNextId();
    registry.registerType(id, {
        name: 'Water',
        foliageType: FoliageType.NONE,
        canPlaceTrees: false,
        canPlaceRocks: false,
        color: { r: 0.2, g: 0.4, b: 0.8 },
        isSolid: false,
        opacity: 0.6,
        fluidProperties: {
            density: 1.0,
            buoyancyMultiplier: 1.0,
            viscosity: 0.3,
            maxSubmersionDepth: 1.5,
            waveStiffness: 8.0,
            waveDamping: 0.1,
            wavePropagationSpeed: 4.0,
            waveAmplitudeDecay: 0.15
        }
    });
    return id;
}

/**
 * Create a swimmable lava terrain type.
 * Dense, high buoyancy (things float easily), slow waves, deals damage.
 */
export function createSwimmableLavaTerrainType(registry: TerrainTypeRegistry): number {
    const id = registry.getNextId();
    registry.registerType(id, {
        name: 'Lava',
        foliageType: FoliageType.NONE,
        damagePerSecond: 50,
        canPlaceTrees: false,
        canPlaceRocks: false,
        color: { r: 1.0, g: 0.3, b: 0.0 },
        isSolid: false,
        opacity: 0.9,
        fluidProperties: {
            density: 3.0,
            buoyancyMultiplier: 1.5,  // High buoyancy - things float easily on lava
            viscosity: 0.6,           // Thick, slow movement
            maxSubmersionDepth: 0.5,  // Float near surface (too dense to sink far)
            waveStiffness: 3.0,       // Slow, heavy waves
            waveDamping: 0.3,         // Settles relatively quickly
            wavePropagationSpeed: 1.5,// Slow wave spread
            waveAmplitudeDecay: 0.25  // Waves don't travel far
        }
    });
    return id;
}

/**
 * Create a slime/goo terrain type.
 * Viscous, moderate buoyancy, bouncy waves.
 */
export function createSlimeTerrainType(registry: TerrainTypeRegistry): number {
    const id = registry.getNextId();
    registry.registerType(id, {
        name: 'Slime',
        foliageType: FoliageType.NONE,
        canPlaceTrees: false,
        canPlaceRocks: false,
        color: { r: 0.2, g: 0.8, b: 0.2 },
        isSolid: false,
        opacity: 0.7,
        fluidProperties: {
            density: 1.5,
            buoyancyMultiplier: 0.8,  // Slightly less buoyant than water
            viscosity: 0.7,           // Very thick, hard to move through
            maxSubmersionDepth: 2.0,  // Sink deeper before floating
            waveStiffness: 4.0,       // Bouncy but slower than water
            waveDamping: 0.2,         // Waves last a while
            wavePropagationSpeed: 2.0,// Medium wave speed
            waveAmplitudeDecay: 0.2   // Moderate decay
        }
    });
    return id;
}

/**
 * Create a quicksand terrain type.
 * High viscosity, low buoyancy (things sink slowly), very slow waves.
 */
export function createQuicksandTerrainType(registry: TerrainTypeRegistry): number {
    const id = registry.getNextId();
    registry.registerType(id, {
        name: 'Quicksand',
        foliageType: FoliageType.NONE,
        canPlaceTrees: false,
        canPlaceRocks: false,
        color: { r: 0.6, g: 0.5, b: 0.3 },
        isSolid: false,
        opacity: 0.85,
        fluidProperties: {
            density: 1.8,
            buoyancyMultiplier: 0.3,  // Low buoyancy - things sink!
            viscosity: 0.9,           // Extremely thick
            maxSubmersionDepth: 3.0,  // Sink deep before any flotation
            waveStiffness: 1.0,       // Very slow settling
            waveDamping: 0.5,         // Waves die quickly
            wavePropagationSpeed: 0.5,// Barely spreads
            waveAmplitudeDecay: 0.4   // Rapid decay
        }
    });
    return id;
}

/**
 * Create a custom fluid terrain type with specified properties.
 * Use this when presets don't match your needs.
 */
export function createCustomFluidTerrainType(
    registry: TerrainTypeRegistry,
    name: string,
    color: { r: number; g: number; b: number },
    fluidProperties: FluidProperties,
    options?: {
        opacity?: number;
        damagePerSecond?: number;
    }
): number {
    const id = registry.getNextId();
    registry.registerType(id, {
        name,
        foliageType: FoliageType.NONE,
        damagePerSecond: options?.damagePerSecond,
        canPlaceTrees: false,
        canPlaceRocks: false,
        color,
        isSolid: false,
        opacity: options?.opacity ?? 0.6,
        fluidProperties
    });
    return id;
}
