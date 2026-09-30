import * as THREE from 'three';
import ASSET_MAP from 'bundle/BundledAssetData.js';

/**
 * Special block type IDs used by the engine.
 * 
 * The engine does NOT define any terrain block types. Templates create block types
 * by calling utility functions like createGrassBlockType(), createSandBlockType(), etc.
 * 
 * Only two special values are defined:
 * - NONE (0): Empty/road blocks
 * - COLOR (255): Custom-colored voxels (uses color palette region of atlas)
 */
export const BlockType = {
    /** Empty or road block type */
    NONE: 0,
    /** Special block type for custom colors - uses color palette region of atlas */
    COLOR: 255,
} as const;

export type BlockTypeId = typeof BlockType[keyof typeof BlockType];

/**
 * First block id handed out to user/world-supplied custom blocks
 * (`worldProfileData.customBlockTypes` and the live REGISTER_CUSTOM_BLOCK_TYPE
 * handler). Ids below this belong to the genre's built-in blocks.
 *
 * WHY THE SPLIT: `.vxl` assets bake ABSOLUTE block ids into their palettes and
 * carry no id→name map (only saved terrain does, via `metadata.blockTypes`), so
 * the default tree asset's "trunk = 9, leaves = 10" is only correct while the
 * genre's built-ins keep their usual numbering. Custom blocks are registered
 * before the genre's WorldGenerator runs, so drawing them from the same counter
 * pushed every built-in up by one per custom block and made the default trees
 * render trunk→lava and leaves→trunk. Allocating custom blocks from their own
 * high range keeps built-in numbering stable no matter how many the world
 * declares.
 */
export const CUSTOM_BLOCK_ID_BASE = 128;

/**
 * Voxel-specific rendering properties for a block type.
 * Material properties (friction, damage, etc.) come from TerrainTypes.
 * These properties are only for voxel rendering effects.
 */
export interface BlockTypeProperties {
    /** Enable smooth surface filtering for top faces (default: false) */
    smoothSurface: boolean;
    /** Smooth surface filter radius in voxels (default: 2) - larger = smoother */
    smoothRadius: number;

    /**
     * Rounded corners in world mesh (greedy box silhouette). In voxel units; multiplied by voxelSize.
     * Omit to use VoxelWorld default. Set 0 to disable for this block while the world has rounding.
     * Re-entrant joints between separate greedy merges remain sharp (convex merges only).
     */
    voxelRoundingRadiusVoxels?: number;
    
    // ════════════════════════════════════════════════════════════════════════════════
    // FLUID RENDERING PROPERTIES
    // ════════════════════════════════════════════════════════════════════════════════
    
    /** 
     * Whether this block is a fluid (water, lava, slime, etc.)
     * Fluid blocks are rendered with transparency and use sensor colliders.
     * Default: false
     */
    isFluid: boolean;
    
    /**
     * Opacity for rendering (0.0 = invisible, 1.0 = fully opaque).
     * Only affects rendering if isFluid is true.
     * Default: 1.0
     */
    opacity: number;
}

/**
 * Default block type properties.
 * Material properties should be looked up from the linked terrain type.
 */
export const DEFAULT_BLOCK_PROPERTIES: BlockTypeProperties = {
    smoothSurface: false,
    smoothRadius: 2,
    isFluid: false,
    opacity: 1.0
};

/**
 * Block texture definition.
 * Each block can have different textures for top, bottom, and sides.
 */
export interface BlockTextureDef {
    id: number;
    name: string;
    /** Size of the texture (16, 32, 64, or 128) */
    size: number;
    /** Top face texture (or all faces if side/bottom not specified) */
    top: HTMLCanvasElement | string;
    /** Side faces texture (optional, defaults to top) */
    side?: HTMLCanvasElement | string;
    /** Bottom face texture (optional, defaults to side or top) */
    bottom?: HTMLCanvasElement | string;
    /** Physical and visual properties (optional, uses defaults if not specified) */
    properties?: Partial<BlockTypeProperties>;
    /** Material ID for physics properties (friction, density, restitution) */
    materialId?: number;
}

/**
 * UV coordinates for a texture in the atlas.
 */
export interface AtlasUV {
    u0: number;  // Left
    v0: number;  // Bottom  
    u1: number;  // Right
    v1: number;  // Top
}

/**
 * Packed block texture info with UV coordinates for each face.
 */
export interface PackedBlockTexture {
    id: number;
    name: string;
    top: AtlasUV;
    side: AtlasUV;
    bottom: AtlasUV;
}

/**
 * Rectangle for packing algorithm.
 */
interface PackRect {
    x: number;
    y: number;
    width: number;
    height: number;
    texture?: HTMLCanvasElement;
    blockId?: number;
    face?: 'top' | 'side' | 'bottom';
}

/**
 * Binary tree node for rectangle packing.
 */
interface PackNode {
    rect: PackRect;
    left?: PackNode;
    right?: PackNode;
    filled: boolean;
}

/**
 * Voxel Texture Atlas - packs multiple block textures into a single 4096x4096 atlas.
 * 
 * Features:
 * - Supports texture sizes: 16x16, 32x32, 64x64, 128x128
 * - Binary tree packing algorithm (largest first)
 * - Procedural texture generation for default block types
 * - UV coordinate lookup for each block face
 */
export class VoxelTextureAtlas {
    private static readonly ATLAS_SIZE = 4096;
    private static readonly DEFAULT_TEXTURE_SIZE = 16;
    /** Color palette size: 64x64 = 4096 colors (4-bit per RGB component: 16x16x16) */
    private static readonly COLOR_PALETTE_SIZE = 64;
    /** Padding pixels around each packed tile (duplicated edge pixels prevent atlas bleed) */
    private static readonly TILE_PADDING = 1;
    
    private atlasCanvas: HTMLCanvasElement;
    private atlasContext: CanvasRenderingContext2D;
    private atlasTexture: THREE.CanvasTexture | null = null;
    
    private blockTextures: Map<number, PackedBlockTexture> = new Map();
    private blockProperties: Map<number, BlockTypeProperties> = new Map();
    /** Maps block type ID to terrain type ID for terrain-specific properties (grip, foliage) */
    private blockToTerrainType: Map<number, number> = new Map();
    /** Maps block type ID to material ID for physical properties (density, friction) */
    private blockToMaterial: Map<number, number> = new Map();
    /** 
     * Per-block grip value (0 = ice, 1 = max traction). 
     * This is the SINGLE SOURCE OF TRUTH for surface grip.
     * Used by vehicles, walking movement, ski, and the ground type editor.
     * Default: 0.5 for blocks without an explicit value.
     */
    private blockGrip: Map<number, number> = new Map();
    /** Maps block type name (lowercase) to block type ID for AI tools */
    private blockNameToId: Map<string, number> = new Map();
    private rootNode: PackNode | null = null;
    
    /** Position of the color palette in the atlas (set after packing) */
    private colorPaletteX = 0;
    private colorPaletteY = 0;
    
    /** Next available block ID - starts at 1 since 0 is NONE */
    private nextBlockId: number = 1;
    /** Next available id in the reserved custom-block range (see CUSTOM_BLOCK_ID_BASE). */
    private nextCustomBlockId: number = CUSTOM_BLOCK_ID_BASE;

    /**
     * How block faces registered from now on are painted: `textured` (the pixel-art default) or
     * `flat` — every face reduced to flat colour bands, the low-poly look (game.json
     * `artStyle: "low-poly"`). Set by the world generator before it registers block types.
     */
    private faceStyle: VoxelFaceStyle = 'textured';
    /** Flattened copies keyed by source canvas, so a face shared by top/side stays one tile. */
    private flatFaceCache = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
    
    constructor() {
        this.atlasCanvas = document.createElement('canvas');
        this.atlasCanvas.width = VoxelTextureAtlas.ATLAS_SIZE;
        this.atlasCanvas.height = VoxelTextureAtlas.ATLAS_SIZE;
        this.atlasContext = this.atlasCanvas.getContext('2d', { willReadFrequently: true })!;
        
        // Fill with neutral gray — any sampling outside packed tiles blends invisibly
        this.atlasContext.fillStyle = '#808080';
        this.atlasContext.fillRect(0, 0, VoxelTextureAtlas.ATLAS_SIZE, VoxelTextureAtlas.ATLAS_SIZE);
    }
    
    /**
     * Initialize the atlas with only the NONE block type and color palette.
     * Templates must call createXxxBlockType() functions to add block types.
     */
    initializeAtlas(): void {
        const textures: BlockTextureDef[] = [
            // 0: None/Road - dark gray (only built-in block type)
            {
                id: BlockType.NONE,
                name: 'none',
                size: 16,
                top: this.generateStoneTexture(16, 0.25, 0.25, 0.27)
            }
        ];
        
        this.packTextures(textures);
        this.generateColorPalette();
    }
    
    /**
     * Generate a 64x64 color palette containing all 4-bit RGB colors (4096 colors).
     * This allows custom colors to be used with atlas mode by mapping to the closest
     * 4-bit color and using its corresponding 1x1 pixel in the palette.
     */
    private generateColorPalette(): void {
        const size = VoxelTextureAtlas.COLOR_PALETTE_SIZE;
        
        // Pack the color palette into the atlas
        if (!this.rootNode) {
            console.error('[VoxelTextureAtlas] Cannot generate color palette - atlas not initialized');
            return;
        }
        
        const node = this.insertRect(this.rootNode, size, size);
        if (!node) {
            console.error('[VoxelTextureAtlas] Failed to pack color palette into atlas');
            return;
        }
        
        this.colorPaletteX = node.rect.x;
        this.colorPaletteY = node.rect.y;
        
        // Generate 4096 colors (16 R × 16 G × 16 B = 4096)
        // Layout: 64x64 grid where each pixel is a unique 4-bit RGB color
        // Index = r4 + g4*16 + b4*256, where r4/g4/b4 are 0-15
        // x = index % 64, y = floor(index / 64)
        const imageData = this.atlasContext.createImageData(size, size);
        
        for (let b4 = 0; b4 < 16; b4++) {
            for (let g4 = 0; g4 < 16; g4++) {
                for (let r4 = 0; r4 < 16; r4++) {
                    const index = r4 + g4 * 16 + b4 * 256;
                    const x = index % size;
                    const y = Math.floor(index / size);
                    const pixelIndex = (y * size + x) * 4;
                    
                    // Convert 4-bit to 8-bit (0-15 → 0-255)
                    imageData.data[pixelIndex + 0] = r4 * 17; // r4 * 255 / 15 ≈ r4 * 17
                    imageData.data[pixelIndex + 1] = g4 * 17;
                    imageData.data[pixelIndex + 2] = b4 * 17;
                    imageData.data[pixelIndex + 3] = 255;
                }
            }
        }
        
        this.atlasContext.putImageData(imageData, this.colorPaletteX, this.colorPaletteY);
    }
    
    /**
     * Register a custom block texture. Call this from template code to add new block types.
     * 
     * The texture is packed into the atlas and UV coordinates are stored for mesh generation.
     * Call this BEFORE terrain/voxel generation (e.g., in WorldGenerator before generateVoxelTerrain).
     * 
     * @param def Block texture definition with id, name, size, and texture canvas(es)
     * 
     * Example from WorldGenerator.ts:
     */
    registerBlockTexture(def: BlockTextureDef): void {
        if (!this.rootNode) {
            console.error('[VoxelTextureAtlas] Cannot register texture - atlas not initialized');
            return;
        }
        
        const pad = VoxelTextureAtlas.TILE_PADDING;
        const { top: topCanvas, side: sideCanvas, bottom: bottomCanvas } = this.resolveFaceCanvases(def);

        // Pack each unique face texture
        const faces: Array<{ canvas: HTMLCanvasElement; face: 'top' | 'side' | 'bottom' }> = [
            { canvas: topCanvas, face: 'top' }
        ];
        if (sideCanvas !== topCanvas) {
            faces.push({ canvas: sideCanvas, face: 'side' });
        }
        if (bottomCanvas !== sideCanvas && bottomCanvas !== topCanvas) {
            faces.push({ canvas: bottomCanvas, face: 'bottom' });
        }
        
        const packedFaces: Map<'top' | 'side' | 'bottom', PackRect> = new Map();
        
        for (const { canvas, face } of faces) {
            const paddedSize = def.size + pad * 2;
            const node = this.insertRect(this.rootNode, paddedSize, paddedSize);
            if (!node) {
                console.error(`[VoxelTextureAtlas] Failed to pack texture: block ${def.id} ${face}`);
                continue;
            }
            
            const innerX = node.rect.x + pad;
            const innerY = node.rect.y + pad;
            
            // Draw texture at inner position, then duplicate edge pixels into padding border
            this.atlasContext.drawImage(canvas, innerX, innerY);
            this.duplicateEdgePixels(innerX, innerY, def.size, def.size);
            
            packedFaces.set(face, {
                x: innerX,
                y: innerY,
                width: def.size,
                height: def.size
            });
        }
        
        // Build UV lookup - top face is required
        const topRect = packedFaces.get('top');
        if (!topRect) {
            console.error(`[VoxelTextureAtlas] Failed to register block texture: ${def.name} (id: ${def.id}) - top face packing failed`);
            return;
        }
        const sideRect = packedFaces.get('side') || topRect;
        const bottomRect = packedFaces.get('bottom') || sideRect;
        
        this.blockTextures.set(def.id, {
            id: def.id,
            name: def.name,
            top: this.rectToUV(topRect),
            side: this.rectToUV(sideRect),
            bottom: this.rectToUV(bottomRect)
        });
        
        // Update the Three.js texture if it exists
        if (this.atlasTexture) {
            this.atlasTexture.needsUpdate = true;
        }
        
        // Track the highest id per allocator. Reserved-range ids must NOT advance
        // nextBlockId, or registering a custom block would push the genre's
        // built-ins past the range and reintroduce the id drift this range exists
        // to prevent.
        // COLOR (255) is a sentinel, never an allocated slot, so it advances neither.
        if (def.id === BlockType.COLOR) {
            // no counter to advance
        } else if (def.id >= CUSTOM_BLOCK_ID_BASE) {
            if (def.id >= this.nextCustomBlockId) {
                this.nextCustomBlockId = def.id + 1;
            }
        } else if (def.id >= this.nextBlockId) {
            this.nextBlockId = def.id + 1;
        }
        
        // Store block properties (merge with defaults)
        const properties: BlockTypeProperties = {
            ...DEFAULT_BLOCK_PROPERTIES,
            ...def.properties
        };
        this.blockProperties.set(def.id, properties);
        
        // Auto-link material if specified
        if (def.materialId !== undefined) {
            this.setBlockMaterial(def.id, def.materialId);
        }
        
    }
    
    /**
     * Get the next available block ID for custom types.
     * Use this when adding entirely new block types (not overriding existing ones).
     */
    getNextBlockId(): number {
        return this.nextBlockId++;
    }

    /**
     * Get the next available id for a USER/WORLD-supplied custom block, drawn from
     * the reserved range above the genre's built-ins (see CUSTOM_BLOCK_ID_BASE).
     * Use this — not `getNextBlockId()` — for anything registered from
     * `worldProfileData.customBlockTypes` or at runtime by the creator, so a world
     * declaring custom blocks can never renumber the built-in blocks that `.vxl`
     * asset palettes refer to by raw id.
     *
     * Falls back to the general counter if the reserved range is exhausted (127
     * custom blocks), which keeps registration working rather than colliding with
     * the COLOR sentinel at 255.
     */
    getNextCustomBlockId(): number {
        if (this.nextCustomBlockId >= BlockType.COLOR) {
            console.warn(
                `[VoxelTextureAtlas] Reserved custom-block id range ${CUSTOM_BLOCK_ID_BASE}..${BlockType.COLOR - 1} ` +
                `is exhausted; falling back to the shared counter. Block ids baked into .vxl asset palettes may shift.`,
            );
            return this.getNextBlockId();
        }
        return this.nextCustomBlockId++;
    }

    /**
     * Register a block type name for lookup by AI tools.
     * Names are case-insensitive (stored lowercase).
     *
     * @param name - Human-readable name (e.g., "wood", "trunk", "leaves")
     * @param blockId - The block type ID to associate with this name
     */
    registerBlockName(name: string, blockId: number): void {
        this.blockNameToId.set(name.toLowerCase(), blockId);
    }

    /**
     * Look up a block type ID by its registered name.
     * Names are case-insensitive.
     *
     * @param name - Block type name (e.g., "wood", "stone")
     * @returns Block type ID or undefined if not found
     */
    getBlockIdByName(name: string): number | undefined {
        return this.blockNameToId.get(name.toLowerCase());
    }

    /**
     * Get all registered block type names.
     * Useful for documentation and debugging.
     */
    getBlockTypeNames(): string[] {
        return Array.from(this.blockNameToId.keys());
    }

    /**
     * Resolve a definition's face textures to canvases, loading URL textures and
     * applying the fallback chain (side → top, bottom → side → top). A face that
     * falls back is reference-equal to the face it inherited from, which callers
     * use to avoid packing the same texture twice.
     */
    private resolveFaceCanvases(def: BlockTextureDef): {
        top: HTMLCanvasElement;
        side: HTMLCanvasElement;
        bottom: HTMLCanvasElement;
    } {
        const top = typeof def.top === 'string' ? this.loadTexture(def.top) : def.top;
        const side = def.side ? (typeof def.side === 'string' ? this.loadTexture(def.side) : def.side) : top;
        const bottom = def.bottom ? (typeof def.bottom === 'string' ? this.loadTexture(def.bottom) : def.bottom) : side;
        if (this.faceStyle === 'textured') return { top, side, bottom };
        return { top: this.flatFace(top), side: this.flatFace(side), bottom: this.flatFace(bottom) };
    }

    /** Choose how faces registered from now on are painted — see {@link faceStyle}. */
    setFaceStyle(style: VoxelFaceStyle): void {
        this.faceStyle = style;
    }

    private flatFace(canvas: HTMLCanvasElement): HTMLCanvasElement {
        const cached = this.flatFaceCache.get(canvas);
        if (cached) return cached;
        const flat = flattenFaceCanvas(canvas);
        this.flatFaceCache.set(canvas, flat);
        return flat;
    }

    /**
     * Pack textures into the atlas using binary tree packing.
     */
    private packTextures(textures: BlockTextureDef[]): void {
        const pad = VoxelTextureAtlas.TILE_PADDING;

        // Collect all individual face textures
        const rects: PackRect[] = [];

        for (const tex of textures) {
            const { top: topCanvas, side: sideCanvas, bottom: bottomCanvas } = this.resolveFaceCanvases(tex);

            rects.push({ x: 0, y: 0, width: tex.size, height: tex.size, texture: topCanvas, blockId: tex.id, face: 'top' });
            
            // Only add side/bottom if they're different textures
            if (sideCanvas !== topCanvas) {
                rects.push({ x: 0, y: 0, width: tex.size, height: tex.size, texture: sideCanvas, blockId: tex.id, face: 'side' });
            }
            if (bottomCanvas !== sideCanvas && bottomCanvas !== topCanvas) {
                rects.push({ x: 0, y: 0, width: tex.size, height: tex.size, texture: bottomCanvas, blockId: tex.id, face: 'bottom' });
            }
        }
        
        // Sort by size (largest first) for better packing
        rects.sort((a, b) => b.width - a.width);
        
        // Initialize root node
        this.rootNode = {
            rect: { x: 0, y: 0, width: VoxelTextureAtlas.ATLAS_SIZE, height: VoxelTextureAtlas.ATLAS_SIZE },
            filled: false
        };
        
        // Pack each rectangle with padding
        const packedRects: PackRect[] = [];
        for (const rect of rects) {
            const paddedW = rect.width + pad * 2;
            const paddedH = rect.height + pad * 2;
            const node = this.insertRect(this.rootNode, paddedW, paddedH);
            if (node) {
                // Store the inner rect (excluding padding) for UV generation
                rect.x = node.rect.x + pad;
                rect.y = node.rect.y + pad;
                packedRects.push(rect);
                
                // Draw texture at inner position
                if (rect.texture) {
                    this.atlasContext.drawImage(rect.texture, rect.x, rect.y);
                    this.duplicateEdgePixels(rect.x, rect.y, rect.width, rect.height);
                }
            } else {
                console.error(`Failed to pack texture: block ${rect.blockId} ${rect.face}`);
            }
        }
        
        // Build UV lookup map
        for (const tex of textures) {
            const topRect = packedRects.find(r => r.blockId === tex.id && r.face === 'top')!;
            const sideRect = packedRects.find(r => r.blockId === tex.id && r.face === 'side') || topRect;
            const bottomRect = packedRects.find(r => r.blockId === tex.id && r.face === 'bottom') || sideRect;
            
            this.blockTextures.set(tex.id, {
                id: tex.id,
                name: tex.name,
                top: this.rectToUV(topRect),
                side: this.rectToUV(sideRect),
                bottom: this.rectToUV(bottomRect)
            });
        }
        
    }
    
    /**
     * Binary tree rectangle insertion.
     */
    private insertRect(node: PackNode, width: number, height: number): PackNode | null {
        // If this node has children, try inserting into them
        if (node.left && node.right) {
            const newNode = this.insertRect(node.left, width, height);
            if (newNode) return newNode;
            return this.insertRect(node.right, width, height);
        }
        
        // If already filled, can't use this node
        if (node.filled) return null;
        
        // If too small, can't fit
        if (node.rect.width < width || node.rect.height < height) return null;
        
        // If perfect fit, use this node
        if (node.rect.width === width && node.rect.height === height) {
            node.filled = true;
            return node;
        }
        
        // Split the node
        const dw = node.rect.width - width;
        const dh = node.rect.height - height;
        
        if (dw > dh) {
            // Split vertically
            node.left = {
                rect: { x: node.rect.x, y: node.rect.y, width: width, height: node.rect.height },
                filled: false
            };
            node.right = {
                rect: { x: node.rect.x + width, y: node.rect.y, width: dw, height: node.rect.height },
                filled: false
            };
        } else {
            // Split horizontally
            node.left = {
                rect: { x: node.rect.x, y: node.rect.y, width: node.rect.width, height: height },
                filled: false
            };
            node.right = {
                rect: { x: node.rect.x, y: node.rect.y + height, width: node.rect.width, height: dh },
                filled: false
            };
        }
        
        return this.insertRect(node.left, width, height);
    }
    
    /**
     * Duplicate the outermost ring of pixels from a packed tile into a 1-pixel border.
     * This creates clamp-style edges so sub-pixel sampling at tile boundaries
     * gets the correct edge color instead of the atlas background.
     */
    private duplicateEdgePixels(innerX: number, innerY: number, width: number, height: number): void {
        // Top row → 1 pixel above
        const topRow = this.atlasContext.getImageData(innerX, innerY, width, 1);
        this.atlasContext.putImageData(topRow, innerX, innerY - 1);
        
        // Bottom row → 1 pixel below
        const bottomRow = this.atlasContext.getImageData(innerX, innerY + height - 1, width, 1);
        this.atlasContext.putImageData(bottomRow, innerX, innerY + height);
        
        // Left column (including already-duplicated top/bottom corners) → 1 pixel left
        const leftCol = this.atlasContext.getImageData(innerX, innerY - 1, 1, height + 2);
        this.atlasContext.putImageData(leftCol, innerX - 1, innerY - 1);
        
        // Right column (including corners) → 1 pixel right
        const rightCol = this.atlasContext.getImageData(innerX + width - 1, innerY - 1, 1, height + 2);
        this.atlasContext.putImageData(rightCol, innerX + width, innerY - 1);
    }
    
    /**
     * Convert packed rectangle to UV coordinates.
     */
    private rectToUV(rect: PackRect): AtlasUV {
        const atlasSize = VoxelTextureAtlas.ATLAS_SIZE;
        const halfPixel = 0.5 / atlasSize;
        return {
            u0: rect.x / atlasSize + halfPixel,
            v0: 1 - (rect.y + rect.height) / atlasSize + halfPixel,
            u1: (rect.x + rect.width) / atlasSize - halfPixel,
            v1: 1 - rect.y / atlasSize - halfPixel
        };
    }
    
    /**
     * Get UV coordinates for a block face.
     */
    getBlockUV(blockId: number, face: 'top' | 'side' | 'bottom'): AtlasUV {
        const block = this.blockTextures.get(blockId);
        if (!block) {
            // Return first registered block as default
            const first = this.blockTextures.values().next().value;
            return first ? first[face] : { u0: 0, v0: 0, u1: 1, v1: 1 };
        }
        return block[face];
    }
    
    /**
     * Get all registered block types.
     * Returns array of { id, name } for each registered block.
     */
    getRegisteredBlockTypes(): { id: number; name: string }[] {
        const result: { id: number; name: string }[] = [];
        for (const [id, block] of this.blockTextures) {
            result.push({ id, name: block.name });
        }
        return result.sort((a, b) => a.id - b.id);
    }
    
    /**
     * Check if a block type ID is registered.
     */
    hasBlockType(blockId: number): boolean {
        return this.blockTextures.has(blockId);
    }
    
    /**
     * Get block type ID by name.
     * Returns undefined if not found.
     */
    getBlockTypeByName(name: string): number | undefined {
        const lowerName = name.toLowerCase();
        for (const [id, block] of this.blockTextures) {
            if (block.name.toLowerCase() === lowerName) {
                return id;
            }
        }
        return undefined;
    }
    
    /**
     * Get properties for a block type.
     * Returns default properties if not found.
     */
    getBlockProperties(blockId: number): BlockTypeProperties {
        return this.blockProperties.get(blockId) ?? { ...DEFAULT_BLOCK_PROPERTIES };
    }
    
    /**
     * Set rendering properties for a block type (smooth surface, etc.).
     * Material properties (friction, damage) should come from terrain types.
     */
    setBlockProperties(blockId: number, properties: Partial<BlockTypeProperties>): void {
        const existing = this.blockProperties.get(blockId) ?? { ...DEFAULT_BLOCK_PROPERTIES };
        this.blockProperties.set(blockId, {
            ...existing,
            ...properties
        });
    }
    
    /**
     * Link a block type to a terrain type (for foliage placement rules, etc.)
     * @param blockId - Block type ID
     * @param terrainTypeId - Terrain type ID
     * @param grip - Optional grip value. If provided, calls setBlockGrip() automatically.
     *              Prefer calling setBlockGrip() directly for clarity.
     */
    setBlockTerrainType(blockId: number, terrainTypeId: number, grip?: number): void {
        this.blockToTerrainType.set(blockId, terrainTypeId);
        if (grip !== undefined) {
            this.blockGrip.set(blockId, grip);
        }
    }
    
    /**
     * Get the terrain type ID linked to a block type.
     * Returns undefined if no terrain type is linked.
     */
    getBlockTerrainType(blockId: number): number | undefined {
        return this.blockToTerrainType.get(blockId);
    }
    
    /**
     * Link a block type to a material for physical properties.
     * Use this for buoyancy, friction, and other physics calculations.
     */
    setBlockMaterial(blockId: number, materialId: number): void {
        this.blockToMaterial.set(blockId, materialId);
    }
    
    /**
     * Get the material ID linked to a block type.
     * Returns undefined if no material is linked (uses default physics).
     */
    getBlockMaterial(blockId: number): number | undefined {
        return this.blockToMaterial.get(blockId);
    }
    
    /**
     * Set the grip for a block type (0 = ice, 1 = max traction).
     * This is the ONLY way to set grip. There is no other system.
     * @param blockId - Block type ID
     * @param grip - Grip value (0-1)
     */
    setBlockGrip(blockId: number, grip: number): void {
        this.blockGrip.set(blockId, grip);
    }
    
    /**
     * Get the grip for a block type (0 = ice, 1 = max traction).
     * Returns 0.5 if no grip has been set for this block.
     */
    getBlockGrip(blockId: number): number {
        return this.blockGrip.get(blockId) ?? 0.5;
    }
    
    /**
     * Get all block types with their properties.
     * Returns array of { id, name, properties } for each registered block.
     */
    getAllBlockTypesWithProperties(): Array<{ id: number; name: string; properties: BlockTypeProperties }> {
        const result: Array<{ id: number; name: string; properties: BlockTypeProperties }> = [];
        for (const [id, block] of this.blockTextures) {
            result.push({
                id,
                name: block.name,
                properties: this.getBlockProperties(id)
            });
        }
        return result.sort((a, b) => a.id - b.id);
    }
    
    /**
     * Check if a block type has smooth surface filtering enabled.
     */
    hasSmoothSurface(blockId: number): boolean {
        return this.getBlockProperties(blockId).smoothSurface;
    }
    
    /**
     * Get the smooth filter radius for a block type.
     */
    getSmoothRadius(blockId: number): number {
        return this.getBlockProperties(blockId).smoothRadius;
    }

    /** Voxel-space radius for rounded mesh; overrides world when set. */
    getVoxelRoundingRadiusVoxels(blockId: number): number | undefined {
        return this.getBlockProperties(blockId).voxelRoundingRadiusVoxels;
    }

    /**
     * True if any registered block type has a positive per-block rounding radius.
     * Used by mesh builders to skip the per-box rounding check entirely when the
     * world-level radius is 0 and no block requests rounding (zero overhead path).
     */
    hasAnyBlockWithRounding(): boolean {
        for (const props of this.blockProperties.values()) {
            if (props.voxelRoundingRadiusVoxels !== undefined && props.voxelRoundingRadiusVoxels > 0) return true;
        }
        return false;
    }
    
    /**
     * Check if a block type is a fluid (water, lava, slime, etc.)
     * Fluid blocks are rendered semi-transparent and use sensor colliders.
     */
    isFluidBlock(blockId: number): boolean {
        return this.getBlockProperties(blockId).isFluid;
    }
    
    /**
     * Get the rendering opacity for a block type.
     * Only meaningful for fluid blocks; solid blocks always render at 1.0.
     */
    getBlockOpacity(blockId: number): number {
        return this.getBlockProperties(blockId).opacity;
    }
    
    /** Quantize an 8-bit (0-255) channel to 4-bit (0-15). */
    private static quantize4(v: number): number {
        return Math.round(v / 17);
    }

    /**
     * Get UV coordinates for a custom RGB color from the color palette.
     * Converts the input color to the closest 4-bit RGB and returns UV for that pixel.
     *
     * @param r Red component (0-255)
     * @param g Green component (0-255)
     * @param b Blue component (0-255)
     * @returns UV coordinates pointing to the closest color in the palette
     */
    getColorPaletteUV(r: number, g: number, b: number): AtlasUV {
        const size = VoxelTextureAtlas.COLOR_PALETTE_SIZE;
        const atlasSize = VoxelTextureAtlas.ATLAS_SIZE;
        const q = VoxelTextureAtlas.quantize4;

        // Calculate palette index and position
        const index = q(r) + q(g) * 16 + q(b) * 256;
        const px = index % size;
        const py = Math.floor(index / size);

        // Calculate UV for this single pixel in the atlas
        const u = (this.colorPaletteX + px + 0.5) / atlasSize;
        const v = 1 - (this.colorPaletteY + py + 0.5) / atlasSize; // Flip V for OpenGL

        // Return a tiny UV rect centered on this pixel
        const halfPixel = 0.5 / atlasSize;

        return {
            u0: u - halfPixel,
            v0: v - halfPixel,
            u1: u + halfPixel,
            v1: v + halfPixel
        };
    }

    /**
     * Convert an RGB24 color to the closest 4-bit RGB color value.
     * Returns an RGB24 color that matches what's in the palette.
     *
     * @param color RGB24 color ((r << 16) | (g << 8) | b)
     * @returns Quantized RGB24 color that matches palette
     */
    quantizeToColorPalette(color: number): number {
        const q = VoxelTextureAtlas.quantize4;
        const r4 = q((color >> 16) & 0xFF);
        const g4 = q((color >> 8) & 0xFF);
        const b4 = q(color & 0xFF);
        return (r4 * 17 << 16) | (g4 * 17 << 8) | (b4 * 17);
    }
    
    /**
     * Get the Three.js texture for the atlas.
     */
    getTexture(): THREE.CanvasTexture {
        if (!this.atlasTexture) {
            this.atlasTexture = new THREE.CanvasTexture(this.atlasCanvas);
            // Nearest on MAGnification keeps the crisp blocky look on close-up faces.
            //
            // MINification is bilinear, not nearest: a minified face squeezes a whole tile
            // into a couple of pixels, and point-sampling that undersamples it into a moiré
            // grid across otherwise uniform terrain. Invisible at the default 1 m voxel (a
            // face is ~9 px, barely minified) but obvious at voxelBlockSize 0.25, where a
            // face is ~2 px — measured across a flat snow field, per-column brightness
            // stddev 2.78 (nearest) → 1.30 (linear), versus 1.81 at 1 m.
            //
            // Bilinear is as far as we can go without reworking the atlas: mipmaps would
            // fix minification properly, but every tile is packed into one 4096² canvas
            // with only TILE_PADDING = 1 px of duplicated-edge gutter. That gutter covers a
            // bilinear 2×2 tap, so no neighbouring tile bleeds in — but each mip level
            // halves it, so coarse levels would sample straight across tile borders and
            // smear unrelated blocks together. Mipmaps need padding that survives every
            // level (or per-tile clamping) first.
            this.atlasTexture.magFilter = THREE.NearestFilter;
            this.atlasTexture.minFilter = THREE.LinearFilter;
            this.atlasTexture.wrapS = THREE.RepeatWrapping;
            this.atlasTexture.wrapT = THREE.RepeatWrapping;
            this.atlasTexture.colorSpace = THREE.SRGBColorSpace;
            this.atlasTexture.needsUpdate = true;
        }
        return this.atlasTexture;
    }
    
    /**
     * Get a material using the atlas texture.
     */
    createMaterial(): THREE.MeshLambertMaterial {
        return new THREE.MeshLambertMaterial({
            map: this.getTexture(),
            side: THREE.FrontSide,
        });
    }
    
    /**
     * Load texture from URL (placeholder - returns empty canvas for now).
     */
    private loadTexture(url: string): HTMLCanvasElement {
        console.warn(`[VoxelTextureAtlas] URL texture loading not implemented: ${url}`);
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        return canvas;
    }

    /**
     * Load an image from a URL and draw it to a canvas at the target size.
     * Returns a magenta fallback canvas on error.
     */
    async loadTextureFromUrl(url: string, targetSize: number): Promise<HTMLCanvasElement> {
        const canvas = document.createElement('canvas');
        canvas.width = targetSize;
        canvas.height = targetSize;
        const ctx = canvas.getContext('2d')!;

        try {
            const img = await new Promise<HTMLImageElement>((resolve, reject) => {
                const image = new Image();
                image.crossOrigin = 'anonymous';
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error(`Failed to load image: ${url}`));
                image.src = ASSET_MAP.get(url) ?? url;
            });
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, 0, 0, targetSize, targetSize);
        } catch (error) {
            console.error(`[VoxelTextureAtlas] Failed to load texture from URL: ${url}`, error);
            ctx.fillStyle = '#808080';
            ctx.fillRect(0, 0, targetSize, targetSize);
        }

        return canvas;
    }

    /**
     * Register a block texture from URL(s). Downloads images, then registers via registerBlockTexture().
     *
     * @param def Object with name, textureUrl, optional sideTextureUrl, textureSize, and optional properties
     * @returns The assigned block type ID
     */
    async registerBlockTextureFromUrl(def: {
        name: string;
        textureUrl: string;
        sideTextureUrl?: string | null;
        textureSize: number;
        properties?: Partial<BlockTypeProperties>;
    }): Promise<number> {
        // Every caller of this method registers a user/world-supplied block, so it
        // allocates from the reserved custom range — keeping the genre's built-in
        // ids (which .vxl asset palettes hard-code) stable.
        const id = this.getNextCustomBlockId();
        const topCanvas = await this.loadTextureFromUrl(def.textureUrl, def.textureSize);
        const sideCanvas = def.sideTextureUrl
            ? await this.loadTextureFromUrl(def.sideTextureUrl, def.textureSize)
            : undefined;

        this.registerBlockTexture({
            id,
            name: def.name,
            size: def.textureSize,
            top: topCanvas,
            side: sideCanvas,
            properties: def.properties
        });

        return id;
    }

    // ========== Procedural Texture Generators ==========

    /** Create a square canvas of the given size with a 2D context. */
    private createTextureCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        return { canvas, ctx };
    }

    generateGrassTexture(size: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        // Base green - softer, less saturated
        ctx.fillStyle = '#3a6b2a';
        ctx.fillRect(0, 0, size, size);
        
        // Add subtle variation (less contrast)
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const noise = Math.random();
                if (noise > 0.6) {
                    // Subtle variations - colors much closer together
                    ctx.fillStyle = noise > 0.8 ? '#427530' : '#356324';
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }
        
        return canvas;
    }
    
    generateGrassSideTexture(size: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        // Dirt base - softer brown
        ctx.fillStyle = '#8a7045';
        ctx.fillRect(0, 0, size, size);
        
        // Add subtle dirt variation (less contrast)
        for (let y = 2; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const noise = Math.random();
                if (noise > 0.6) {
                    ctx.fillStyle = noise > 0.8 ? '#8f7850' : '#85683a';
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }
        
        // Grass strip at top (2 pixels) - matching top grass colors
        ctx.fillStyle = '#3a6b2a';
        ctx.fillRect(0, 0, size, 2);
        for (let x = 0; x < size; x++) {
            if (Math.random() > 0.5) {
                ctx.fillStyle = Math.random() > 0.5 ? '#427530' : '#356324';
                ctx.fillRect(x, 0, 1, 1);
            }
            // Grass hanging down
            if (Math.random() > 0.7) {
                ctx.fillStyle = '#3a6b2a';
                ctx.fillRect(x, 2, 1, 1);
            }
        }
        
        return canvas;
    }
    
    generateDirtTexture(size: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        // Softer brown matching grass side
        ctx.fillStyle = '#8a7045';
        ctx.fillRect(0, 0, size, size);
        
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const noise = Math.random();
                if (noise > 0.6) {
                    // Subtle variations matching grass side
                    ctx.fillStyle = noise > 0.8 ? '#8f7850' : '#85683a';
                    ctx.fillRect(x, y, 1, 1);
                }
                // Occasional pebble
                if (noise > 0.95) {
                    ctx.fillStyle = '#9a8565';
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }
        
        return canvas;
    }
    
    generateSandTexture(size: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        ctx.fillStyle = '#bfa687';
        ctx.fillRect(0, 0, size, size);
        
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const noise = Math.random();
                if (noise > 0.5) {
                    ctx.fillStyle = noise > 0.75 ? '#cdb495' : '#b09779';
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }
        
        return canvas;
    }
    
    generateStoneTexture(size: number, r: number, g: number, b: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        const toHex = (v: number) => Math.floor(v * 255).toString(16).padStart(2, '0');
        ctx.fillStyle = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        ctx.fillRect(0, 0, size, size);
        
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const noise = Math.random();
                if (noise > 0.6) {
                    const mod = noise > 0.8 ? 0.1 : -0.1;
                    ctx.fillStyle = `#${toHex(r + mod)}${toHex(g + mod)}${toHex(b + mod)}`;
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }
        
        // Add some crack lines
        ctx.strokeStyle = `#${toHex(r - 0.15)}${toHex(g - 0.15)}${toHex(b - 0.15)}`;
        ctx.lineWidth = 1;
        for (let i = 0; i < 2; i++) {
            ctx.beginPath();
            ctx.moveTo(Math.random() * size, Math.random() * size);
            ctx.lineTo(Math.random() * size, Math.random() * size);
            ctx.stroke();
        }
        
        return canvas;
    }
    
    generateAsphaltTexture(size: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(0, 0, size, size);
        
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const noise = Math.random();
                if (noise > 0.7) {
                    ctx.fillStyle = noise > 0.9 ? '#3a3a3a' : '#1a1a1a';
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }
        
        return canvas;
    }
    
    generateIceTexture(size: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        ctx.fillStyle = '#a0d8ef';
        ctx.fillRect(0, 0, size, size);
        
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const noise = Math.random();
                if (noise > 0.7) {
                    ctx.fillStyle = noise > 0.85 ? '#c0e8ff' : '#80c8df';
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }
        
        // Add crack lines
        ctx.strokeStyle = '#d0f0ff';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(Math.random() * size, Math.random() * size);
            ctx.lineTo(Math.random() * size, Math.random() * size);
            ctx.stroke();
        }
        
        return canvas;
    }
    
    generateLavaTexture(size: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        ctx.fillStyle = '#cf4a00';
        ctx.fillRect(0, 0, size, size);
        
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const noise = Math.random();
                if (noise > 0.4) {
                    if (noise > 0.8) {
                        ctx.fillStyle = '#ff8800';  // Hot spots
                    } else if (noise > 0.6) {
                        ctx.fillStyle = '#ff5500';
                    } else {
                        ctx.fillStyle = '#8f2a00';  // Cooler areas
                    }
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }
        
        return canvas;
    }
    
    /**
     * Generate a water texture - blue with subtle wave-like variation.
     * The texture suggests transparency through color variation.
     */
    generateWaterTexture(size: number, _opacity: number = 0.6): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        // Minecraft-style water: simple, clean blue with subtle variations
        // Base color: a nice aqua blue similar to Minecraft
        const baseR = 44, baseG = 98, baseB = 214;  // #2c62d6 - Minecraft-like blue
        
        // Fill base color first
        ctx.fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
        ctx.fillRect(0, 0, size, size);
        
        // Add subtle caustic-like pattern (lighter spots)
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                // Create a subtle, organic noise pattern
                const noise1 = Math.sin(x * 0.8 + y * 0.3) * Math.cos(x * 0.3 - y * 0.5);
                const noise2 = Math.sin((x + 8) * 0.6) * Math.sin((y + 4) * 0.7);
                const combined = (noise1 + noise2) * 0.5;
                
                if (combined > 0.3) {
                    // Lighter caustic spot
                    const bright = Math.floor((combined - 0.3) * 40);
                    ctx.fillStyle = `rgb(${baseR + bright}, ${baseG + bright + 10}, ${baseB + bright})`;
                    ctx.fillRect(x, y, 1, 1);
                } else if (combined < -0.3) {
                    // Slightly darker area
                    const dark = Math.floor((-combined - 0.3) * 25);
                    ctx.fillStyle = `rgb(${baseR - dark}, ${baseG - dark}, ${baseB - dark * 0.5})`;
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }
        
        // Add a few bright highlight pixels (like light reflections)
        ctx.fillStyle = 'rgb(120, 160, 230)';
        for (let i = 0; i < Math.floor(size / 4); i++) {
            const x = Math.floor(Math.random() * size);
            const y = Math.floor(Math.random() * size);
            ctx.fillRect(x, y, 1, 1);
        }
        
        return canvas;
    }
    
    /**
     * Generate a slime texture - green with bubbles, semi-transparent.
     */
    generateSlimeTexture(size: number, _opacity: number = 0.7): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        // Generate OPAQUE texture - transparency handled by material
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const noise = Math.random();
                let r = 51, g = 136, b = 51; // Base #338833
                if (noise > 0.85) { r = 85; g = 170; b = 85; } // #55aa55
                else if (noise > 0.7) { r = 34; g = 102; b = 34; } // #226622
                ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                ctx.fillRect(x, y, 1, 1);
            }
        }
        
        // Add bubbles (slightly lighter)
        ctx.fillStyle = 'rgb(102, 204, 102)';
        for (let i = 0; i < size / 3; i++) {
            const x = Math.floor(Math.random() * size);
            const y = Math.floor(Math.random() * size);
            const r = Math.random() * 2 + 1;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        }
        
        return canvas;
    }
    
    /**
     * Generate a quicksand texture - sandy with darker swirls, semi-transparent.
     */
    generateQuicksandTexture(size: number, _opacity: number = 0.85): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        // Generate OPAQUE texture - transparency handled by material
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const swirl = Math.sin(x * 0.3 + y * 0.4) * Math.cos(x * 0.2 - y * 0.3);
                const noise = Math.random() * 0.3;
                const combined = swirl * 0.5 + 0.5 + noise;
                
                let r = 154, g = 128, b = 96; // Base #9a8060
                if (combined > 0.7) { r = 122; g = 96; b = 64; } // #7a6040
                else if (combined < 0.3) { r = 170; g = 144; b = 112; } // #aa9070
                
                ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                ctx.fillRect(x, y, 1, 1);
            }
        }
        
        return canvas;
    }
    
    generateTrunkSideTexture(size: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        // Medium brown bark base
        ctx.fillStyle = '#6b4423';
        ctx.fillRect(0, 0, size, size);
        
        // Create vertical bark texture with ridges
        for (let x = 0; x < size; x++) {
            // Determine if this column is a ridge or groove
            const isRidge = (x % 3 === 0) || (x % 5 === 0);
            
            for (let y = 0; y < size; y++) {
                const noise = Math.random();
                
                if (isRidge) {
                    // Lighter ridges
                    if (noise > 0.4) {
                        ctx.fillStyle = noise > 0.7 ? '#8b5a30' : '#7a4a28';
                        ctx.fillRect(x, y, 1, 1);
                    }
                } else {
                    // Darker grooves
                    if (noise > 0.5) {
                        ctx.fillStyle = noise > 0.75 ? '#5a3a1a' : '#4a2a12';
                        ctx.fillRect(x, y, 1, 1);
                    }
                }
            }
        }
        
        // Add horizontal cracks occasionally
        for (let y = 0; y < size; y++) {
            if (Math.random() > 0.85) {
                ctx.fillStyle = '#3a2010';
                const crackLen = Math.floor(Math.random() * 6) + 2;
                const startX = Math.floor(Math.random() * size);
                for (let cx = 0; cx < crackLen && startX + cx < size; cx++) {
                    ctx.fillRect(startX + cx, y, 1, 1);
                }
            }
        }
        
        return canvas;
    }
    
    generateTrunkTopTexture(size: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        // Wood rings - light tan/beige center
        ctx.fillStyle = '#c4a060';
        ctx.fillRect(0, 0, size, size);
        
        // Draw concentric growth rings
        const centerX = size / 2;
        const centerY = size / 2;
        for (let r = size / 2 - 1; r > 1; r -= 1.5) {
            // Alternate light and dark rings
            const ringPhase = Math.floor(r / 1.5) % 2;
            ctx.strokeStyle = ringPhase === 0 ? '#a08050' : '#d4b070';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
            ctx.stroke();
        }
        
        // Center darker pith
        ctx.fillStyle = '#705030';
        ctx.beginPath();
        ctx.arc(centerX, centerY, 1.5, 0, Math.PI * 2);
        ctx.fill();
        
        // Add bark ring around the edge (darker)
        ctx.strokeStyle = '#6b4423';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(centerX, centerY, size / 2 - 1, 0, Math.PI * 2);
        ctx.stroke();
        
        return canvas;
    }
    
    generateLeavesTexture(size: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        // Medium green base for leaves
        ctx.fillStyle = '#3a7530';
        ctx.fillRect(0, 0, size, size);
        
        // Add leafy cluster texture - denser and more varied
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const noise = Math.random();
                
                // Create clustered leaf appearance
                if (noise > 0.25) {
                    // Various green shades for leaf depth
                    if (noise > 0.9) {
                        ctx.fillStyle = '#5aa048'; // Bright highlights (sun-lit leaves)
                    } else if (noise > 0.75) {
                        ctx.fillStyle = '#4a8a3a'; // Light green
                    } else if (noise > 0.55) {
                        ctx.fillStyle = '#3a6a2a'; // Medium green
                    } else if (noise > 0.4) {
                        ctx.fillStyle = '#2a5520'; // Darker green
                    } else {
                        ctx.fillStyle = '#1a4018'; // Deep shadow between leaves
                    }
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }
        
        // Add occasional darker gaps (spaces between leaves)
        for (let i = 0; i < size / 2; i++) {
            const gx = Math.floor(Math.random() * size);
            const gy = Math.floor(Math.random() * size);
            if (Math.random() > 0.5) {
                ctx.fillStyle = '#0a2008';
                ctx.fillRect(gx, gy, 1, 1);
            }
        }
        
        return canvas;
    }
    
    generatePlanksTexture(size: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createTextureCanvas(size);

        // Light wood base
        ctx.fillStyle = '#b89050';
        ctx.fillRect(0, 0, size, size);
        
        // Draw horizontal plank lines
        const plankHeight = Math.floor(size / 4);
        for (let p = 0; p < 4; p++) {
            const y = p * plankHeight;
            
            // Plank edge (darker line)
            ctx.fillStyle = '#8a6030';
            ctx.fillRect(0, y, size, 1);
            
            // Wood grain within plank
            for (let py = y + 1; py < y + plankHeight && py < size; py++) {
                for (let px = 0; px < size; px++) {
                    if (Math.random() > 0.7) {
                        ctx.fillStyle = Math.random() > 0.5 ? '#c8a060' : '#a88040';
                        ctx.fillRect(px, py, 1, 1);
                    }
                }
            }
        }
        
        return canvas;
    }
    
    /**
     * Dispose of resources.
     */
    dispose(): void {
        if (this.atlasTexture) {
            this.atlasTexture.dispose();
            this.atlasTexture = null;
        }
        this.blockTextures.clear();
        this.blockProperties.clear();
    }
}

// Singleton instance
/** How block faces are painted — see `VoxelTextureAtlas.setFaceStyle`. */
export type VoxelFaceStyle = 'textured' | 'flat';

/** Rows of the face that count as its top band (the grass lip on a grass side). */
const FLAT_FACE_TOP_BAND = 0.25;
/** Summed per-channel difference (0-765) above which the top band keeps its own colour. */
const FLAT_FACE_BAND_CONTRAST = 60;

/**
 * A face texture reduced to flat colour: the average colour of the whole face, or — when the top
 * quarter clearly differs from the rest, as on a grass side — two flat bands. Custom and uploaded
 * block textures get the same treatment, so a low-poly game never shows pixel-art noise.
 */
export function flattenFaceCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
    const { width, height } = source;
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d')!;
    let pixels: Uint8ClampedArray | undefined;
    try {
        pixels = source.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, width, height).data;
    } catch {
        // A cross-origin texture taints its canvas; keep it textured rather than fail the block.
        pixels = undefined;
    }
    if (!pixels) {
        ctx.drawImage(source, 0, 0);
        return out;
    }
    const bandRows = Math.max(1, Math.round(height * FLAT_FACE_TOP_BAND));
    const average = (fromRow: number, toRow: number): [number, number, number, number] => {
        const sum = [0, 0, 0, 0];
        for (let y = fromRow; y < toRow; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                for (let c = 0; c < 4; c++) sum[c]! += pixels[i + c]!;
            }
        }
        const n = Math.max(1, (toRow - fromRow) * width);
        return [sum[0]! / n, sum[1]! / n, sum[2]! / n, sum[3]! / n];
    };
    const fill = (rgba: [number, number, number, number], fromRow: number, toRow: number) => {
        ctx.fillStyle = `rgba(${Math.round(rgba[0])}, ${Math.round(rgba[1])}, ${Math.round(rgba[2])}, ${rgba[3] / 255})`;
        ctx.fillRect(0, fromRow, width, toRow - fromRow);
    };
    const top = average(0, bandRows);
    const rest = average(bandRows, height);
    const contrast = Math.abs(top[0] - rest[0]) + Math.abs(top[1] - rest[1]) + Math.abs(top[2] - rest[2]);
    if (contrast > FLAT_FACE_BAND_CONTRAST) {
        fill(top, 0, bandRows);
        fill(rest, bandRows, height);
    } else {
        fill(average(0, height), 0, height);
    }
    return out;
}

let atlasInstance: VoxelTextureAtlas | null = null;

/**
 * Get the global texture atlas instance.
 */
export function getVoxelTextureAtlas(): VoxelTextureAtlas {
    if (!atlasInstance) {
        atlasInstance = new VoxelTextureAtlas();
        atlasInstance.initializeAtlas();
    }
    return atlasInstance;
}

/**
 * Reset the texture atlas (call before regenerating).
 */
export function resetVoxelTextureAtlas(): void {
    if (atlasInstance) {
        atlasInstance.dispose();
        atlasInstance = null;
    }
}

// ============================================================================
// BLOCK TYPE CREATION UTILITIES
// Templates call these functions to create block types they need.
// The engine provides the texture generators, templates decide which types exist.
// ============================================================================

/**
 * Create a grass block type. Returns the assigned block ID.
 * Grass has green top, dirt sides/bottom.
 * @param terrainTypeId - ID of the terrain type for foliage placement rules
 */
export function createGrassBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number {
    const id = atlas.getNextBlockId();
    atlas.registerBlockTexture({
        id,
        name: 'grass',
        size: 16,
        top: atlas.generateGrassTexture(16),
        side: atlas.generateGrassSideTexture(16),
        bottom: atlas.generateDirtTexture(16)
    });
    atlas.setBlockGrip(id, 0.8); // Default grass grip
    if (terrainTypeId !== undefined) {
        atlas.setBlockTerrainType(id, terrainTypeId);
    }
    return id;
}

/**
 * Create a sand block type. Returns the assigned block ID.
 * Warm beige color with subtle grain variation.
 * Material properties come from the linked terrain type.
 * @param terrainTypeId - ID of the terrain type for material properties
 */
export function createSandBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number {
    const id = atlas.getNextBlockId();
    atlas.registerBlockTexture({ id, name: 'sand', size: 16, top: atlas.generateSandTexture(16) });
    atlas.setBlockGrip(id, 0.6); // Sand - moderate grip
    if (terrainTypeId !== undefined) { atlas.setBlockTerrainType(id, terrainTypeId); }
    return id;
}

/**
 * Create an ice block type. Returns the assigned block ID.
 * Light blue with crystalline appearance.
 * Material properties come from the linked terrain type.
 * @param terrainTypeId - ID of the terrain type for material properties
 */
export function createIceBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number {
    const id = atlas.getNextBlockId();
    atlas.registerBlockTexture({ id, name: 'ice', size: 16, top: atlas.generateIceTexture(16) });
    atlas.setBlockGrip(id, 0.1); // Ice - very slippery
    if (terrainTypeId !== undefined) { atlas.setBlockTerrainType(id, terrainTypeId); }
    return id;
}

/**
 * Create a stone block type. Returns the assigned block ID.
 * Gray rocky texture.
 * Material properties come from the linked terrain type.
 * @param terrainTypeId - ID of the terrain type for material properties
 */
export function createStoneBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number {
    const id = atlas.getNextBlockId();
    atlas.registerBlockTexture({ id, name: 'stone', size: 16, top: atlas.generateStoneTexture(16, 0.5, 0.5, 0.52) });
    atlas.setBlockGrip(id, 0.9); // Stone - high grip
    if (terrainTypeId !== undefined) { atlas.setBlockTerrainType(id, terrainTypeId); }
    return id;
}

/**
 * Create a dirt block type. Returns the assigned block ID.
 * Brown earth texture.
 * Material properties come from the linked terrain type.
 * @param terrainTypeId - ID of the terrain type for material properties
 */
export function createDirtBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number {
    const id = atlas.getNextBlockId();
    atlas.registerBlockTexture({ id, name: 'dirt', size: 16, top: atlas.generateDirtTexture(16) });
    atlas.setBlockGrip(id, 0.7); // Dirt - decent grip
    if (terrainTypeId !== undefined) { atlas.setBlockTerrainType(id, terrainTypeId); }
    return id;
}

/**
 * Create an asphalt block type. Returns the assigned block ID.
 * Dark gray road surface.
 * Material properties come from the linked terrain type.
 * @param terrainTypeId - ID of the terrain type for material properties
 */
export function createAsphaltBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number {
    const id = atlas.getNextBlockId();
    atlas.registerBlockTexture({ id, name: 'asphalt', size: 16, top: atlas.generateAsphaltTexture(16) });
    atlas.setBlockGrip(id, 1.0); // Asphalt - maximum grip
    if (terrainTypeId !== undefined) { atlas.setBlockTerrainType(id, terrainTypeId); }
    return id;
}

/**
 * Create a lava block type. Returns the assigned block ID.
 * Orange/red molten texture.
 * Material properties come from the linked terrain type.
 * @param terrainTypeId - ID of the terrain type for material properties
 * @param isFluid - If true, renders as semi-transparent fluid (default: false for solid lava)
 * @param opacity - Rendering opacity when isFluid is true (default: 0.9)
 */
export function createLavaBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number, isFluid: boolean = false, opacity: number = 0.9): number {
    const id = atlas.getNextBlockId();
    atlas.registerBlockTexture({ id, name: 'lava', size: 16, top: atlas.generateLavaTexture(16), properties: isFluid ? { isFluid: true, opacity } : undefined });
    atlas.setBlockGrip(id, 0.7); // Lava - moderate grip (hot rock surface)
    if (terrainTypeId !== undefined) { atlas.setBlockTerrainType(id, terrainTypeId); }
    return id;
}

// ============================================================================
// Fluid Block Type Creation Utilities
// These create block types for non-solid materials (water, slime, etc.)
// Material properties (buoyancy, waves) come from the linked terrain type.
// ============================================================================

/**
 * Create a water block type. Returns the assigned block ID.
 * Blue wave-like texture. Semi-transparent when rendered.
 * Material properties (buoyancy, waves) come from the linked terrain type.
 * @param terrainTypeId - ID of the water terrain type for fluid properties
 * @param opacity - Rendering opacity (default: 0.6)
 */
export function createWaterBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number, opacity: number = 0.6): number {
    const id = atlas.getNextBlockId();
    const waterTex = atlas.generateWaterTexture(16, opacity);
    atlas.registerBlockTexture({ id, name: 'water', size: 16, top: waterTex, side: waterTex, bottom: waterTex, properties: { isFluid: true, opacity } });
    atlas.setBlockGrip(id, 0.2); // Water - very low grip
    if (terrainTypeId !== undefined) { atlas.setBlockTerrainType(id, terrainTypeId); }
    return id;
}

/**
 * Create a slime block type. Returns the assigned block ID.
 * Green gooey texture with bubbles.
 * Material properties (buoyancy, waves) come from the linked terrain type.
 * @param terrainTypeId - ID of the slime terrain type for fluid properties
 * @param opacity - Rendering opacity (default: 0.7)
 */
export function createSlimeBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number, opacity: number = 0.7): number {
    const id = atlas.getNextBlockId();
    const slimeTex = atlas.generateSlimeTexture(16, opacity);
    atlas.registerBlockTexture({ id, name: 'slime', size: 16, top: slimeTex, side: slimeTex, bottom: slimeTex, properties: { isFluid: true, opacity } });
    atlas.setBlockGrip(id, 0.3); // Slime - low grip
    if (terrainTypeId !== undefined) { atlas.setBlockTerrainType(id, terrainTypeId); }
    return id;
}

/**
 * Create a quicksand block type. Returns the assigned block ID.
 * Sandy texture with darker wet swirls.
 * Material properties (low buoyancy, high viscosity) come from the linked terrain type.
 * @param terrainTypeId - ID of the quicksand terrain type for fluid properties
 * @param opacity - Rendering opacity (default: 0.85)
 */
export function createQuicksandBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number, opacity: number = 0.85): number {
    const id = atlas.getNextBlockId();
    const qsTex = atlas.generateQuicksandTexture(16, opacity);
    atlas.registerBlockTexture({ id, name: 'quicksand', size: 16, top: qsTex, side: qsTex, bottom: qsTex, properties: { isFluid: true, opacity } });
    atlas.setBlockGrip(id, 0.1); // Quicksand - very low grip
    if (terrainTypeId !== undefined) { atlas.setBlockTerrainType(id, terrainTypeId); }
    return id;
}

/**
 * Create a tree trunk block type. Returns the assigned block ID.
 * Brown bark texture.
 * @param materialId - Material ID (use MaterialId.WOOD for floating debris)
 */
export function createTrunkBlockType(atlas: VoxelTextureAtlas, materialId?: number): number {
    const id = atlas.getNextBlockId();
    atlas.registerBlockTexture({
        id,
        name: 'trunk',
        size: 16,
        top: atlas.generateTrunkTopTexture(16),
        side: atlas.generateTrunkSideTexture(16)
    });
    if (materialId !== undefined) {
        atlas.setBlockMaterial(id, materialId);
    }
    return id;
}

/**
 * Create a leaves block type. Returns the assigned block ID.
 * Green foliage texture.
 * @param materialId - Material ID (use MaterialId.LEAVES for floating debris)
 */
export function createLeavesBlockType(atlas: VoxelTextureAtlas, materialId?: number): number {
    const id = atlas.getNextBlockId();
    atlas.registerBlockTexture({
        id,
        name: 'leaves',
        size: 16,
        top: atlas.generateLeavesTexture(16)
    });
    if (materialId !== undefined) {
        atlas.setBlockMaterial(id, materialId);
    }
    return id;
}

/**
 * Create a wood planks block type. Returns the assigned block ID.
 * Horizontal wood plank pattern.
 * @param materialId - Material ID (use MaterialId.WOOD for floating debris)
 */
export function createPlanksBlockType(atlas: VoxelTextureAtlas, materialId?: number): number {
    const id = atlas.getNextBlockId();
    atlas.registerBlockTexture({
        id,
        name: 'planks',
        size: 16,
        top: atlas.generatePlanksTexture(16)
    });
    if (materialId !== undefined) {
        atlas.setBlockMaterial(id, materialId);
    }
    return id;
}

/**
 * Creates a lazy block type that registers itself on first access.
 * This makes block type usage ORDER-INDEPENDENT - you can use the block type
 * before or after other initialization code runs.
 * 
 * @param name - Unique name for the block type
 * @param textureFactory - Function that generates the texture definition
 * @param terrainTypeId - Optional terrain type for physics properties
 * @returns A getter function that returns the block type ID
 * 
 * @example
 * // Define once at module level
 * const getConcreteType = createLazyBlockType('concrete', (atlas) => ({
 *     size: 16,
 *     top: generateConcreteTexture(16)
 * }));
 * 
 * // Use anywhere - order doesn't matter
 * voxelObject.setVoxel(x, y, z, getConcreteType());
 */
export function createLazyBlockType(
    name: string,
    textureFactory: (atlas: VoxelTextureAtlas) => { size: number; top: HTMLCanvasElement; side?: HTMLCanvasElement; bottom?: HTMLCanvasElement },
    terrainTypeId?: number
): () => number {
    let cachedId: number | null = null;
    
    return () => {
        if (cachedId === null) {
            const atlas = getVoxelTextureAtlas();
            cachedId = atlas.getNextBlockId();
            const textureDef = textureFactory(atlas);
            atlas.registerBlockTexture({
                id: cachedId,
                name,
                ...textureDef
            });
            if (terrainTypeId !== undefined) {
                atlas.setBlockTerrainType(cachedId, terrainTypeId);
            }
        }
        return cachedId;
    };
}

