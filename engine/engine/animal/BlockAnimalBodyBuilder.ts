import * as THREE from 'three';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import { AnimalEyeController, type AnimalEyeConfig, type EyeStyle, type EyePlacement } from 'engine/animal/AnimalEyeController.js';
import {
    buildDetailedPartMesh,
    resolveAnimalDetail,
    resolveAnimalVoxelSize,
    type AnimalDetailConfig,
    type AnimalDetailPartKind,
    type ResolvedAnimalDetail,
} from 'engine/animal/BlockAnimalVoxelDetailer.js';

/**
 * Block Animal Body Builder
 * 
 * Creates AI-composable animals from block configurations.
 * Similar pattern to BoxCarBodyBuilder - fixed structure, freeform shapes.
 * 
 * The engine controls the structure (body, head, legs, tail hierarchy).
 * The AI defines the shape of each part using arrays of blocks.
 * 
 * Animation works automatically via BlockAnimalAnimationController which
 * finds named groups and applies procedural leg/head/tail animations.
 */

/**
 * Configuration for a single block within an animal part.
 */
export interface AnimalBlockConfig {
    /** Position relative to the part's origin (meters). x and z default to 0 if not provided. */
    position: { x?: number; y: number; z?: number };
    /** Size of the block (meters) */
    size: { width: number; height: number; depth: number };
    /** Block color (hex) */
    color: number;
    /** Optional: rotation in degrees */
    rotation?: { x?: number; y?: number; z?: number };
    /**
     * Optional block shape (default 'box').
     * 'wedge' is a triangular prism: full height at the back (−Z) tapering to
     * zero at the front (+Z). Combine with `rotation` to make sloped snouts,
     * beaks, fin tapers, and wing tips while keeping the voxel aesthetic.
     */
    shape?: 'box' | 'wedge';
}

/**
 * Body plan of a block-composed creature. Drives which locomotion and
 * animation mode the engine uses:
 * - 'quadruped' — four legs, ground gaits (default when 4 leg arrays present)
 * - 'biped'     — back legs only, waddling gait (default when only back legs)
 * - 'fish'      — no legs, fins; swims in 3D inside water volumes (default when legless)
 * - 'bird'      — winged biped that FLIES in 3D; must be set explicitly
 * - 'dragon'    — winged QUADRUPED that FLIES in 3D (slower, heavier wing
 *                 beats than a bird); must be set explicitly. A quadruped
 *                 with wings but no explicit plan stays a GROUND dragon —
 *                 its wings stay folded at every gait and it never lifts off.
 * - 'cephalopod'— legless swimmer with a ring of tentacles (octopus, squid,
 *                 jellyfish-like creatures); swims with mantle pulses and
 *                 undulating tentacles (default when legless + tentacles)
 */
export type AnimalBodyPlan = 'quadruped' | 'biped' | 'fish' | 'bird' | 'dragon' | 'cephalopod';

/**
 * Configuration for an AI-composed animal body.
 * 
 * Fixed structure (engine controls):
 * - Body group with head as child
 * - Four leg groups
 * - Optional tail group
 * 
 * Freeform shapes (AI defines):
 * - Blocks within each part
 * - Attachment points for positioning
 */
export interface BlockAnimalBodyConfig {
    /** Blocks that make up the body (torso, belly, spots, humps, etc.) */
    bodyBlocks: AnimalBlockConfig[];
    
    /** Blocks that make up the head (skull, snout, ears, horns, eyes, etc.) */
    headBlocks: AnimalBlockConfig[];
    
    /** 
     * OFFSET to adjust head attachment from auto-calculated position.
     * Head is auto-calculated to front-top-center of body.
     * Provide offsets to shift from that position.
     */
    headAttachmentOffset?: { x?: number; y?: number; z?: number };
    
    /** Blocks for tail (optional - some animals don't have tails) */
    tailBlocks?: AnimalBlockConfig[];
    /** 
     * OFFSET to adjust tail attachment from auto-calculated position.
     * Tail is auto-calculated to back-upper-center of body.
     * Provide offsets to shift from that position.
     */
    tailAttachmentOffset?: { x?: number; y?: number; z?: number };
    
    /**
     * Explicit body plan. Optional — inferred from the leg arrays when omitted
     * (4 legs → quadruped, back legs only → biped, no legs → fish).
     * The flying plans — 'bird' (winged biped) and 'dragon' (winged
     * quadruped) — must always be set explicitly.
     */
    bodyPlan?: AnimalBodyPlan;

    /** Blocks for front left leg - geometry positioned relative to leg pivot (top).
     *  Optional: omit all leg arrays for legless plans (fish). */
    frontLeftLegBlocks?: AnimalBlockConfig[];
    /** Blocks for front right leg */
    frontRightLegBlocks?: AnimalBlockConfig[];
    /** Blocks for back left leg */
    backLeftLegBlocks?: AnimalBlockConfig[];
    /** Blocks for back right leg */
    backRightLegBlocks?: AnimalBlockConfig[];

    /**
     * Blocks for the left wing (birds, dragons, flying creatures).
     * Geometry is relative to the wing pivot at the body's upper-left side and
     * should extend OUTWARD (−X). If `rightWingBlocks` is omitted, the right
     * wing is auto-mirrored from this one (guaranteed symmetry).
     */
    leftWingBlocks?: AnimalBlockConfig[];
    /** Blocks for the right wing (extend +X). Auto-mirrored from left when omitted. */
    rightWingBlocks?: AnimalBlockConfig[];
    /**
     * Optional OUTER wing segment (wing tip), a child of the inner wing pivoted
     * at the inner wing's outer edge. Gives birds a folding, two-segment flap.
     * Geometry extends further outward from that pivot. Auto-mirrored like wings.
     */
    leftWingOuterBlocks?: AnimalBlockConfig[];
    rightWingOuterBlocks?: AnimalBlockConfig[];
    /** OFFSETS to adjust wing attachments from auto-calculated positions (upper body sides). */
    wingAttachmentOffsets?: {
        left?: { x?: number; y?: number; z?: number };
        right?: { x?: number; y?: number; z?: number };
    };

    /**
     * Blocks for the left pectoral fin (fish). Relative to a pivot at the
     * body's lower-front-left side; extend OUTWARD (−X). Right fin is
     * auto-mirrored when omitted.
     */
    leftFinBlocks?: AnimalBlockConfig[];
    /** Blocks for the right pectoral fin (extend +X). Auto-mirrored from left when omitted. */
    rightFinBlocks?: AnimalBlockConfig[];
    /** OFFSETS to adjust pectoral fin attachments from auto-calculated positions. */
    finAttachmentOffsets?: {
        left?: { x?: number; y?: number; z?: number };
        right?: { x?: number; y?: number; z?: number };
    };

    /** Blocks for the dorsal fin (top center of body, e.g. sharks). */
    dorsalFinBlocks?: AnimalBlockConfig[];
    /** OFFSET to adjust dorsal fin attachment from auto-calculated position. */
    dorsalFinAttachmentOffset?: { x?: number; y?: number; z?: number };

    /**
     * Blocks for the tail fin (caudal fin). Attached as a CHILD of the tail at
     * its rear end, so it lags the tail sweep for a natural two-segment whip.
     * Requires `tailBlocks`.
     */
    tailFinBlocks?: AnimalBlockConfig[];

    /**
     * Blocks for ONE tentacle (octopus, squid). Geometry is relative to the
     * tentacle pivot at the body underside and must extend DOWNWARD (−Y);
     * the engine instances `tentacleCount` copies arranged in a ring under
     * the body, each animated with a phase-offset undulation. Presence of
     * tentacles on a legless config makes the creature a 'cephalopod'.
     */
    tentacleBlocks?: AnimalBlockConfig[];
    /** Number of ring tentacles to instance (default 8, clamped 2–12). */
    tentacleCount?: number;
    /**
     * Blocks for the pair of LONG feeding tentacles (squid). Same pivot rules
     * as `tentacleBlocks`; instanced twice at the ring's ±X edges and animated
     * with a streaming trail instead of the ring undulation.
     */
    longTentacleBlocks?: AnimalBlockConfig[];
    /** OFFSET to adjust the tentacle ring's center from the body underside. */
    tentacleAttachmentOffset?: { x?: number; y?: number; z?: number };
    
    /** 
     * OFFSETS to adjust leg attachments from auto-calculated positions.
     * Legs are auto-calculated based on body dimensions:
     * - X: slightly outside body width
     * - Y: slightly above body bottom  
     * - Z: slightly inward from body front/back edges
     * Provide offsets to shift from those positions.
     */
    legAttachmentOffsets?: {
        frontLeft?: { x?: number; y?: number; z?: number };
        frontRight?: { x?: number; y?: number; z?: number };
        backLeft?: { x?: number; y?: number; z?: number };
        backRight?: { x?: number; y?: number; z?: number };
    };
    
    /** Eye configuration (optional - eyes add personality!) */
    eyes?: AnimalEyeConfig;

    /**
     * Optional voxel-art detail style. When set, every part is rendered as a
     * merged mesh of small voxels with seeded color jitter, rounded
     * silhouettes and optional surface patterns — generated deterministically
     * by the engine from the SAME blocks (never author voxels by hand).
     * Omitted = classic per-block box rendering, byte-identical to before.
     */
    detail?: AnimalDetailConfig;
    
    /**
     * Desired shoulder height in meters (optional).
     * 
     * If specified, the engine will automatically scale the entire animal
     * so that its shoulder (top of body, excluding head) matches this height.
     * 
     * Examples:
     * - Cat: 0.25 (25cm)
     * - Dog (medium): 0.5 (50cm)
     * - Deer: 1.0 (100cm at shoulder)
     * - Horse: 1.6 (160cm at shoulder)
     * - Elephant: 3.0 (300cm at shoulder)
     * 
     * If not specified, no scaling is applied (model is used at defined sizes).
     */
    shoulderHeight?: number;
}

/**
 * Calculated dimensions for physics and positioning.
 */
export interface AnimalDimensions {
    width: number;
    height: number;
    depth: number;
}

/** A resolved attachment point (defaults + offsets applied), in body-local metres. */
export interface AnimalAttachmentPoint {
    x: number;
    y: number;
    z: number;
}

/** The four leg pivots, keyed the same way `legAttachmentOffsets` is. */
export type AnimalLegAttachments = Record<'frontLeft' | 'frontRight' | 'backLeft' | 'backRight', AnimalAttachmentPoint>;

/** Resolved voxel-detail settings for one build (null = classic box path). */
interface AnimalDetailContext {
    detail: ResolvedAnimalDetail;
    /** Animal-wide voxel edge length (meters), already budget-clamped. */
    voxelSize: number;
}

/**
 * Block Animal Body Builder
 * 
 * Creates animal character groups from block configurations.
 * The structure is fixed (body > head, legs, tail), shapes are AI-defined.
 */
export class BlockAnimalBodyBuilder {
    // Counter for z-fighting prevention - each block gets slightly different scale
    private static blockDepthCounter = 0;

    /**
     * Resolve the creature's body plan: explicit `bodyPlan` wins, otherwise
     * inferred from which leg arrays are present (4 → quadruped, back only →
     * biped, none → fish).
     */
    static resolveBodyPlan(config: BlockAnimalBodyConfig): AnimalBodyPlan {
        if (config.bodyPlan) return config.bodyPlan;
        const hasFrontLegs = (config.frontLeftLegBlocks?.length ?? 0) > 0 || (config.frontRightLegBlocks?.length ?? 0) > 0;
        const hasBackLegs = (config.backLeftLegBlocks?.length ?? 0) > 0 || (config.backRightLegBlocks?.length ?? 0) > 0;
        if (hasFrontLegs && hasBackLegs) return 'quadruped';
        if (hasFrontLegs || hasBackLegs) return 'biped';
        const hasTentacles = (config.tentacleBlocks?.length ?? 0) > 0 || (config.longTentacleBlocks?.length ?? 0) > 0;
        return hasTentacles ? 'cephalopod' : 'fish';
    }

    /** Locomotion mode implied by a body plan. */
    static locomotionModeForPlan(plan: AnimalBodyPlan): 'ground' | 'swim' | 'fly' {
        if (plan === 'fish' || plan === 'cephalopod') return 'swim';
        if (plan === 'bird' || plan === 'dragon') return 'fly';
        return 'ground';
    }

    /**
     * Mirror a paired part (wing/fin) across the YZ plane: x positions negate,
     * Y/Z rotations negate. Used to auto-generate the right-side part from the
     * left so configs stay compact and guaranteed symmetric.
     */
    private static mirrorBlocksX(blocks: AnimalBlockConfig[]): AnimalBlockConfig[] {
        return blocks.map(block => ({
            ...block,
            position: { ...block.position, x: -(block.position.x ?? 0) },
            rotation: block.rotation
                ? { x: block.rotation.x, y: block.rotation.y !== undefined ? -block.rotation.y : undefined, z: block.rotation.z !== undefined ? -block.rotation.z : undefined }
                : undefined,
        }));
    }

    /**
     * Ensure a side part's blocks extend toward the given X sign (−1 for left
     * parts, +1 for right). If the geometry leans the wrong way, flip it —
     * same self-healing idea as the tail direction correction.
     */
    private static correctSideBlockDirection(blocks: AnimalBlockConfig[], sign: -1 | 1): AnimalBlockConfig[] {
        if (blocks.length === 0) return blocks;
        let minX = 0, maxX = 0;
        for (const block of blocks) {
            const x = block.position.x ?? 0;
            const halfW = block.size.width / 2;
            minX = Math.min(minX, x - halfW);
            maxX = Math.max(maxX, x + halfW);
        }
        const extendsWrongWay = sign === -1 ? maxX > Math.abs(minX) : Math.abs(minX) > maxX;
        return extendsWrongWay ? BlockAnimalBodyBuilder.mirrorBlocksX(blocks) : blocks;
    }

    /**
     * Resolve both sides of a mirrored part pair (wings, pectoral fins):
     * missing side is auto-mirrored from the other; both sides are
     * direction-corrected so left extends −X and right extends +X.
     */
    private static resolveSidePair(
        left: AnimalBlockConfig[] | undefined,
        right: AnimalBlockConfig[] | undefined
    ): { left: AnimalBlockConfig[]; right: AnimalBlockConfig[] } {
        let leftBlocks = left ?? [];
        let rightBlocks = right ?? [];
        if (leftBlocks.length > 0 && rightBlocks.length === 0) {
            rightBlocks = BlockAnimalBodyBuilder.mirrorBlocksX(leftBlocks);
        } else if (rightBlocks.length > 0 && leftBlocks.length === 0) {
            leftBlocks = BlockAnimalBodyBuilder.mirrorBlocksX(rightBlocks);
        }
        return {
            left: BlockAnimalBodyBuilder.correctSideBlockDirection(leftBlocks, -1),
            right: BlockAnimalBodyBuilder.correctSideBlockDirection(rightBlocks, 1),
        };
    }

    /**
     * Calculate bounding box of body blocks.
     * Used for auto-calculating attachment points.
     */
    static calculateBodyBounds(bodyBlocks: AnimalBlockConfig[]): {
        minX: number; maxX: number;
        minY: number; maxY: number;
        minZ: number; maxZ: number;
        width: number; height: number; depth: number;
    } {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        
        for (const block of bodyBlocks) {
            const halfW = block.size.width / 2;
            const halfH = block.size.height / 2;
            const halfD = block.size.depth / 2;
            const posX = block.position.x ?? 0;
            const posZ = block.position.z ?? 0;
            
            minX = Math.min(minX, posX - halfW);
            maxX = Math.max(maxX, posX + halfW);
            minY = Math.min(minY, block.position.y - halfH);
            maxY = Math.max(maxY, block.position.y + halfH);
            minZ = Math.min(minZ, posZ - halfD);
            maxZ = Math.max(maxZ, posZ + halfD);
        }
        
        return {
            minX, maxX, minY, maxY, minZ, maxZ,
            width: maxX - minX,
            height: maxY - minY,
            depth: maxZ - minZ
        };
    }
    
    /**
     * Auto-calculate attachment points based on body dimensions.
     * Creates sensible defaults that work for most animals.
     * 
     * - Head: front-top-center of body
     * - Tail: back-upper-center of body (top quartile)
     * - Legs: 75% inside body in X (25% outside), small Y overlap for smooth animation, slightly inward in Z
     */
    static calculateDefaultAttachments(config: BlockAnimalBodyConfig): {
        headAttachment: AnimalAttachmentPoint;
        tailAttachment: AnimalAttachmentPoint;
        legAttachments: AnimalLegAttachments;
        wingAttachments: { left: AnimalAttachmentPoint; right: AnimalAttachmentPoint };
        finAttachments: { left: AnimalAttachmentPoint; right: AnimalAttachmentPoint };
        dorsalFinAttachment: AnimalAttachmentPoint;
    } {
        const bounds = BlockAnimalBodyBuilder.calculateBodyBounds(config.bodyBlocks);
        const plan = BlockAnimalBodyBuilder.resolveBodyPlan(config);

        // Get max leg width from leg blocks (for consistent positioning)
        const getMaxLegWidth = (legBlocks: AnimalBlockConfig[]): number => {
            let maxWidth = 0.06; // Default minimum
            for (const block of legBlocks) {
                maxWidth = Math.max(maxWidth, block.size.width);
            }
            return maxWidth;
        };

        const frontLeftWidth = getMaxLegWidth(config.frontLeftLegBlocks ?? []);
        const frontRightWidth = getMaxLegWidth(config.frontRightLegBlocks ?? []);
        const backLeftWidth = getMaxLegWidth(config.backLeftLegBlocks ?? []);
        const backRightWidth = getMaxLegWidth(config.backRightLegBlocks ?? []);
        
        // Leg X positioning: 75% inside body, 25% outside
        // Leg is centered on attachment point, so:
        // - Outer edge of leg = attachmentX - legWidth/2 (for left leg)
        // - We want outer edge to be 0.25*legWidth outside body edge
        // - So: attachmentX - legWidth/2 = bounds.minX - 0.25*legWidth
        // - Therefore: attachmentX = bounds.minX - 0.25*legWidth + legWidth/2 = bounds.minX + 0.25*legWidth
        const frontLeftX = bounds.minX + 0.25 * frontLeftWidth;
        const backLeftX = bounds.minX + 0.25 * backLeftWidth;
        
        // For right leg (positive X side):
        // - Outer edge = attachmentX + legWidth/2
        // - We want: attachmentX + legWidth/2 = bounds.maxX + 0.25*legWidth
        // - Therefore: attachmentX = bounds.maxX + 0.25*legWidth - legWidth/2 = bounds.maxX - 0.25*legWidth
        const frontRightX = bounds.maxX - 0.25 * frontRightWidth;
        const backRightX = bounds.maxX - 0.25 * backRightWidth;
        
        // Leg Y positioning: small overlap into body to prevent animation gaps
        const legYOverlap = 0.02;  // 2cm overlap into body
        const legY = bounds.minY + legYOverlap;
        
        // Leg Z positioning: slightly inward from body edges
        const legZMargin = 0.05;
        const frontZ = bounds.maxZ - bounds.depth * 0.15 - legZMargin;
        const backZ = bounds.minZ + bounds.depth * 0.15 + legZMargin;
        
        // Vertical center of the body (fish parts attach on the midline, not the top)
        const midY = (bounds.minY + bounds.maxY) / 2;

        // Head: front-top-center (at front edge, near top).
        // Fish: front-center — a fish's head continues the body line.
        const headAttachment = {
            x: 0,
            y: plan === 'fish' ? midY : bounds.maxY * 0.7,
            z: bounds.maxZ         // Front edge
        };

        // Tail: back-upper-center (at back edge, top quartile).
        // Fish: back-center — the caudal peduncle sits on the midline.
        const tailAttachment = {
            x: 0,
            y: plan === 'fish' ? midY : bounds.maxY * 0.5,
            z: bounds.minZ               // Back edge
        };

        const legAttachments = {
            frontLeft: { x: frontLeftX, y: legY, z: frontZ },
            frontRight: { x: frontRightX, y: legY, z: frontZ },
            backLeft: { x: backLeftX, y: legY, z: backZ },
            backRight: { x: backRightX, y: legY, z: backZ }
        };

        // Wings: upper body sides, slightly forward of center (shoulder line)
        const wingY = bounds.minY + bounds.height * 0.75;
        const wingZ = bounds.minZ + bounds.depth * 0.55;
        const wingAttachments = {
            left: { x: bounds.minX, y: wingY, z: wingZ },
            right: { x: bounds.maxX, y: wingY, z: wingZ }
        };

        // Pectoral fins: lower body sides, forward third
        const finY = bounds.minY + bounds.height * 0.3;
        const finZ = bounds.minZ + bounds.depth * 0.7;
        const finAttachments = {
            left: { x: bounds.minX, y: finY, z: finZ },
            right: { x: bounds.maxX, y: finY, z: finZ }
        };

        // Dorsal fin: top center of body
        const dorsalFinAttachment = {
            x: 0,
            y: bounds.maxY,
            z: bounds.minZ + bounds.depth * 0.5
        };

        return { headAttachment, tailAttachment, legAttachments, wingAttachments, finAttachments, dorsalFinAttachment };
    }

    /** Whether the config defines any leg blocks (any of the four leg arrays). */
    private static hasAnyLegs(config: BlockAnimalBodyConfig): boolean {
        return ((config.frontLeftLegBlocks?.length ?? 0) + (config.frontRightLegBlocks?.length ?? 0)
            + (config.backLeftLegBlocks?.length ?? 0) + (config.backRightLegBlocks?.length ?? 0)) > 0;
    }

    /**
     * Resolve the four leg attachment points from the auto-calculated defaults
     * plus the per-leg config offsets (unclamped — legs may sit anywhere).
     */
    private static resolveLegAttachments(
        config: BlockAnimalBodyConfig,
        defaults: ReturnType<typeof BlockAnimalBodyBuilder.calculateDefaultAttachments>
    ): AnimalLegAttachments {
        const offsets = config.legAttachmentOffsets;
        const resolve = (key: keyof AnimalLegAttachments): AnimalAttachmentPoint => ({
            x: defaults.legAttachments[key].x + (offsets?.[key]?.x ?? 0),
            y: defaults.legAttachments[key].y + (offsets?.[key]?.y ?? 0),
            z: defaults.legAttachments[key].z + (offsets?.[key]?.z ?? 0),
        });
        return {
            frontLeft: resolve('frontLeft'),
            frontRight: resolve('frontRight'),
            backLeft: resolve('backLeft'),
            backRight: resolve('backRight'),
        };
    }

    /**
     * Auto-correct tail blocks if they extend in the wrong direction (forward instead of backward).
     * Tail should extend in negative Z (away from body/head).
     */
    private static correctTailBlockDirection(tailBlocks: AnimalBlockConfig[]): AnimalBlockConfig[] {
        if (tailBlocks.length === 0) return tailBlocks;
        
        // Find the extent of tail blocks in Z
        let minZ = 0, maxZ = 0;
        for (const block of tailBlocks) {
            const z = block.position.z ?? 0;
            const halfD = block.size.depth / 2;
            minZ = Math.min(minZ, z - halfD);
            maxZ = Math.max(maxZ, z + halfD);
        }
        
        // If tail extends more in positive Z than negative, flip all Z positions
        if (maxZ > Math.abs(minZ)) {
            return tailBlocks.map(block => ({
                ...block,
                position: {
                    ...block.position,
                    z: block.position.z !== undefined ? -block.position.z : undefined
                }
            }));
        }
        
        return tailBlocks;
    }
    
    /**
     * Clamp attachment offsets to reasonable bounds (max 30% of body dimension).
     */
    private static clampOffset(offset: number, bodyDimension: number): number {
        const maxOffset = bodyDimension * 0.3;
        return Math.max(-maxOffset, Math.min(maxOffset, offset));
    }
    
    /**
     * Build an animal character group from block configuration.
     *
     * Creates the fixed hierarchy:
     * - AnimalBody (with blocks)
     *   - AnimalHead (child of body, with blocks)
     * - FrontLeftLeg, FrontRightLeg, BackLeftLeg, BackRightLeg
     * - AnimalTail (optional)
     *
     * @param characterGroup - The root group to populate
     * @param config - Block configuration for each body part
     */
    static buildAnimal(
        characterGroup: THREE.Group,
        config: BlockAnimalBodyConfig
    ): void {
        // Reset z-fighting counter for each new animal
        BlockAnimalBodyBuilder.blockDepthCounter = 0;
        
        // ALWAYS calculate default attachments from body dimensions
        const defaults = BlockAnimalBodyBuilder.calculateDefaultAttachments(config);
        const bounds = BlockAnimalBodyBuilder.calculateBodyBounds(config.bodyBlocks);
        
        // Apply offsets to defaults, clamped to reasonable bounds
        const headAttachment = BlockAnimalBodyBuilder.applyOffset(defaults.headAttachment, config.headAttachmentOffset, bounds);
        const tailAttachment = BlockAnimalBodyBuilder.applyOffset(defaults.tailAttachment, config.tailAttachmentOffset, bounds);
        
        // Auto-correct tail blocks if they extend in wrong direction
        const correctedTailBlocks = BlockAnimalBodyBuilder.correctTailBlockDirection(config.tailBlocks ?? []);
        const legAttachments = BlockAnimalBodyBuilder.resolveLegAttachments(config, defaults);

        const plan = BlockAnimalBodyBuilder.resolveBodyPlan(config);
        const hasLegs = BlockAnimalBodyBuilder.hasAnyLegs(config);

        // Stamp the resolved plan on the character group so the controller and
        // animation layers pick the matching locomotion/animation mode without
        // any change to the createAnimal() call surface.
        characterGroup.userData.bodyPlan = plan;
        characterGroup.userData.locomotionMode = BlockAnimalBodyBuilder.locomotionModeForPlan(plan);

        // Find lowest leg point to determine ground level (using resolved attachments)
        const legBottomY = BlockAnimalBodyBuilder.findLowestLegPointWithAttachments(config, legAttachments);

        // Tentacles hang below the body — corrected to extend −Y, like legs
        const correctedTentacles = BlockAnimalBodyBuilder.correctTentacleBlockDirection(config.tentacleBlocks ?? []);
        const correctedLongTentacles = BlockAnimalBodyBuilder.correctTentacleBlockDirection(config.longTentacleBlocks ?? []);
        const tentacleDrop = Math.max(
            BlockAnimalBodyBuilder.calculateTentacleDrop(correctedTentacles),
            BlockAnimalBodyBuilder.calculateTentacleDrop(correctedLongTentacles),
        );

        // Body should be positioned so legs touch ground.
        // Legs are attached at legAttachments.y relative to body; the lowest leg
        // block extends to legBottomY below the leg pivot.
        // Legless plans (fish, cephalopods): lift the body so its lowest point —
        // body block or hanging tentacle tip — sits at the group origin. The
        // origin stays "bottom of creature" for every plan, which the
        // controller's feet-offset / capsule math relies on.
        const bodyY = hasLegs ? Math.abs(legBottomY) : Math.abs(bounds.minY) + tentacleDrop;

        // Voxel-detail context: null = classic per-block boxes (existing
        // games render byte-identical); set = each part becomes ONE merged
        // voxel-art mesh built by BlockAnimalVoxelDetailer (cached + budgeted).
        const detailCtx = BlockAnimalBodyBuilder.createDetailContext(config, bounds);

        // Create body group
        const body = new THREE.Group();
        body.name = 'AnimalBody';
        body.position.set(0, bodyY, 0);

        // Add body blocks
        BlockAnimalBodyBuilder.addPartBlocks(body, config.bodyBlocks, 'body', detailCtx);

        // Create head as CHILD of body (moves with body, can also rotate independently)
        const head = new THREE.Group();
        head.name = 'AnimalHead';
        head.position.set(
            headAttachment.x,
            headAttachment.y,
            headAttachment.z
        );

        // Add head blocks
        BlockAnimalBodyBuilder.addPartBlocks(head, config.headBlocks, 'head', detailCtx);

        // Add eyes (unless disabled) and store controller on character group.
        // Voxelized heads can protrude up to half a voxel past the authored
        // face — push the eye overlays out so they aren't swallowed.
        if (!config.eyes?.disabled) {
            const eyeSurfaceOffset = detailCtx ? detailCtx.voxelSize / 2 + 0.005 : 0;
            characterGroup.userData.eyeController = BlockAnimalBodyBuilder.addEyes(head, config, eyeSurfaceOffset);
        }
        
        body.add(head);
        characterGroup.add(body);
        
        // Create legs (at body level, animate independently via rotation).
        // Empty leg arrays create NO group — the animation controller detects
        // bipeds/fish by which leg groups exist.
        const addLegIfPresent = (name: string, blocks: AnimalBlockConfig[] | undefined, attachment: AnimalAttachmentPoint) => {
            if (blocks && blocks.length > 0) {
                BlockAnimalBodyBuilder.addLeg(body, name, blocks, attachment, detailCtx);
            }
        };
        addLegIfPresent('FrontLeftLeg', config.frontLeftLegBlocks, legAttachments.frontLeft);
        addLegIfPresent('FrontRightLeg', config.frontRightLegBlocks, legAttachments.frontRight);
        addLegIfPresent('BackLeftLeg', config.backLeftLegBlocks, legAttachments.backLeft);
        addLegIfPresent('BackRightLeg', config.backRightLegBlocks, legAttachments.backRight);

        // Create tail if present (use corrected tail blocks and auto-calculated tailAttachment)
        if (correctedTailBlocks.length > 0) {
            const tail = new THREE.Group();
            tail.name = 'AnimalTail';
            tail.position.set(
                tailAttachment.x,
                tailAttachment.y,
                tailAttachment.z
            );
            BlockAnimalBodyBuilder.addPartBlocks(tail, correctedTailBlocks, 'tail', detailCtx);

            // Tail fin (caudal fin): child of the tail pivoted at its rear end,
            // so it inherits and lags the tail's sweep.
            if (config.tailFinBlocks && config.tailFinBlocks.length > 0) {
                let tailMinZ = 0;
                for (const block of correctedTailBlocks) {
                    tailMinZ = Math.min(tailMinZ, (block.position.z ?? 0) - block.size.depth / 2);
                }
                const tailFin = new THREE.Group();
                tailFin.name = 'TailFin';
                tailFin.position.set(0, 0, tailMinZ);
                BlockAnimalBodyBuilder.addPartBlocks(tailFin, config.tailFinBlocks, 'fin', detailCtx);
                tail.add(tailFin);
            }

            body.add(tail);
        }

        // Wings (inner + optional outer segment). Missing side auto-mirrors.
        const wings = BlockAnimalBodyBuilder.resolveSidePair(config.leftWingBlocks, config.rightWingBlocks);
        if (wings.left.length > 0) {
            const wingOuters = BlockAnimalBodyBuilder.resolveSidePair(config.leftWingOuterBlocks, config.rightWingOuterBlocks);
            BlockAnimalBodyBuilder.addSidePart(
                body, 'LeftWing', wings.left,
                BlockAnimalBodyBuilder.applyOffset(defaults.wingAttachments.left, config.wingAttachmentOffsets?.left, bounds),
                { outerName: 'LeftWingOuter', outerBlocks: wingOuters.left, side: -1 },
                detailCtx
            );
            BlockAnimalBodyBuilder.addSidePart(
                body, 'RightWing', wings.right,
                BlockAnimalBodyBuilder.applyOffset(defaults.wingAttachments.right, config.wingAttachmentOffsets?.right, bounds),
                { outerName: 'RightWingOuter', outerBlocks: wingOuters.right, side: 1 },
                detailCtx
            );
        }

        // Pectoral fins. Missing side auto-mirrors.
        const fins = BlockAnimalBodyBuilder.resolveSidePair(config.leftFinBlocks, config.rightFinBlocks);
        if (fins.left.length > 0) {
            BlockAnimalBodyBuilder.addSidePart(
                body, 'LeftFin', fins.left,
                BlockAnimalBodyBuilder.applyOffset(defaults.finAttachments.left, config.finAttachmentOffsets?.left, bounds),
                null,
                detailCtx
            );
            BlockAnimalBodyBuilder.addSidePart(
                body, 'RightFin', fins.right,
                BlockAnimalBodyBuilder.applyOffset(defaults.finAttachments.right, config.finAttachmentOffsets?.right, bounds),
                null,
                detailCtx
            );
        }

        // Dorsal fin
        if (config.dorsalFinBlocks && config.dorsalFinBlocks.length > 0) {
            const dorsal = new THREE.Group();
            dorsal.name = 'DorsalFin';
            const dorsalAttachment = BlockAnimalBodyBuilder.applyOffset(defaults.dorsalFinAttachment, config.dorsalFinAttachmentOffset, bounds);
            dorsal.position.set(dorsalAttachment.x, dorsalAttachment.y, dorsalAttachment.z);
            BlockAnimalBodyBuilder.addPartBlocks(dorsal, config.dorsalFinBlocks, 'fin', detailCtx);
            body.add(dorsal);
        }

        // Tentacle ring (cephalopods): N instances of the same tentacle shape
        // arranged in an ellipse under the body, named Tentacle0..N-1 so the
        // animation controller can undulate each with a phase offset. The squid
        // feeding pair (LongTentacle0/1) sits at the ring's ±X edges.
        if (correctedTentacles.length > 0 || correctedLongTentacles.length > 0) {
            const ringCenter = BlockAnimalBodyBuilder.applyOffset(
                { x: 0, y: bounds.minY, z: (bounds.minZ + bounds.maxZ) / 2 },
                config.tentacleAttachmentOffset,
                bounds
            );
            const radiusX = bounds.width * 0.35;
            const radiusZ = bounds.depth * 0.35;

            if (correctedTentacles.length > 0) {
                const count = Math.max(2, Math.min(12, Math.round(config.tentacleCount ?? 8)));
                for (let i = 0; i < count; i++) {
                    const angle = (i / count) * Math.PI * 2;
                    const tentacle = new THREE.Group();
                    tentacle.name = `Tentacle${i}`;
                    tentacle.position.set(
                        ringCenter.x + Math.cos(angle) * radiusX,
                        ringCenter.y,
                        ringCenter.z + Math.sin(angle) * radiusZ,
                    );
                    // All ring tentacles share the same blocks → the detail
                    // cache hands every instance the same geometry.
                    BlockAnimalBodyBuilder.addPartBlocks(tentacle, correctedTentacles, 'tentacle', detailCtx);
                    body.add(tentacle);
                }
            }

            if (correctedLongTentacles.length > 0) {
                for (let i = 0; i < 2; i++) {
                    const sign = i === 0 ? -1 : 1;
                    const longTentacle = new THREE.Group();
                    longTentacle.name = `LongTentacle${i}`;
                    longTentacle.position.set(ringCenter.x + sign * radiusX, ringCenter.y, ringCenter.z);
                    BlockAnimalBodyBuilder.addPartBlocks(longTentacle, correctedLongTentacles, 'tentacle', detailCtx);
                    body.add(longTentacle);
                }
            }
        }
    }

    /**
     * Auto-correct tentacle blocks that extend UP instead of DOWN — the pivot
     * is at the body underside and geometry must hang in −Y (same self-healing
     * idea as the tail's Z-direction correction).
     */
    private static correctTentacleBlockDirection(tentacleBlocks: AnimalBlockConfig[]): AnimalBlockConfig[] {
        if (tentacleBlocks.length === 0) return tentacleBlocks;
        let minY = 0, maxY = 0;
        for (const block of tentacleBlocks) {
            const halfH = block.size.height / 2;
            minY = Math.min(minY, block.position.y - halfH);
            maxY = Math.max(maxY, block.position.y + halfH);
        }
        if (maxY > Math.abs(minY)) {
            return tentacleBlocks.map(block => ({
                ...block,
                position: { ...block.position, y: -block.position.y },
            }));
        }
        return tentacleBlocks;
    }

    /** How far a (direction-corrected) tentacle hangs below its pivot. */
    private static calculateTentacleDrop(tentacleBlocks: AnimalBlockConfig[]): number {
        let lowest = 0;
        for (const block of tentacleBlocks) {
            lowest = Math.min(lowest, block.position.y - block.size.height / 2);
        }
        return Math.abs(lowest);
    }

    /** Apply a clamped attachment offset to a default attachment point. */
    private static applyOffset(
        base: AnimalAttachmentPoint,
        offset: { x?: number; y?: number; z?: number } | undefined,
        bounds: { width: number; height: number; depth: number }
    ): AnimalAttachmentPoint {
        return {
            x: base.x + BlockAnimalBodyBuilder.clampOffset(offset?.x ?? 0, bounds.width),
            y: base.y + BlockAnimalBodyBuilder.clampOffset(offset?.y ?? 0, bounds.height),
            z: base.z + BlockAnimalBodyBuilder.clampOffset(offset?.z ?? 0, bounds.depth),
        };
    }

    /**
     * Resolve the voxel-detail context for one build: the resolved style plus
     * the animal-wide voxel size (auto-derived from body size, clamped by the
     * total face budget). Null when the config has no `detail` — the classic
     * per-block box path.
     */
    private static createDetailContext(
        config: BlockAnimalBodyConfig,
        bounds: { width: number; height: number; depth: number }
    ): AnimalDetailContext | null {
        if (!config.detail) return null;
        const detail = resolveAnimalDetail(config.detail);

        // Every block that will be voxelized, for the face-budget predictor.
        // Auto-mirrored sides resolve later — approximate a missing side with
        // its mirror source (identical surface area).
        const allBlocks: AnimalBlockConfig[] = [
            ...config.bodyBlocks,
            ...config.headBlocks,
            ...(config.tailBlocks ?? []),
            ...(config.tailFinBlocks ?? []),
            ...(config.dorsalFinBlocks ?? []),
            ...(config.frontLeftLegBlocks ?? []), ...(config.frontRightLegBlocks ?? []),
            ...(config.backLeftLegBlocks ?? []), ...(config.backRightLegBlocks ?? []),
            ...(config.leftWingBlocks ?? config.rightWingBlocks ?? []), ...(config.rightWingBlocks ?? config.leftWingBlocks ?? []),
            ...(config.leftWingOuterBlocks ?? config.rightWingOuterBlocks ?? []), ...(config.rightWingOuterBlocks ?? config.leftWingOuterBlocks ?? []),
            ...(config.leftFinBlocks ?? config.rightFinBlocks ?? []), ...(config.rightFinBlocks ?? config.leftFinBlocks ?? []),
            ...(config.tentacleBlocks ?? []),
            ...(config.longTentacleBlocks ?? []),
        ];

        const bodyLargestDim = Math.max(bounds.width, bounds.height, bounds.depth);
        return {
            detail,
            voxelSize: resolveAnimalVoxelSize(detail, bodyLargestDim, allBlocks),
        };
    }

    /**
     * Populate a part group with its block geometry. Classic path (null ctx):
     * one BoxGeometry mesh per block, byte-identical to the historical
     * renderer (z-fight counter intact). Detail path: ONE merged voxel-art
     * mesh from the shared cache.
     */
    private static addPartBlocks(
        parent: THREE.Group,
        blocks: AnimalBlockConfig[],
        partKind: AnimalDetailPartKind,
        detailCtx: AnimalDetailContext | null
    ): void {
        if (blocks.length === 0) return;
        if (!detailCtx) {
            for (const block of blocks) {
                parent.add(BlockAnimalBodyBuilder.createBlockMesh(block));
            }
            return;
        }
        parent.add(buildDetailedPartMesh(partKind, blocks, detailCtx.detail, detailCtx.voxelSize));
    }

    /**
     * Add a side-mounted part group (wing or fin) at an attachment pivot,
     * optionally with a nested outer segment pivoted at the part's outer X edge
     * (two-segment wings: the outer segment lags the inner during flapping).
     */
    private static addSidePart(
        parent: THREE.Group,
        name: string,
        blocks: AnimalBlockConfig[],
        attachment: AnimalAttachmentPoint,
        outer: { outerName: string; outerBlocks: AnimalBlockConfig[]; side: -1 | 1 } | null,
        detailCtx: AnimalDetailContext | null
    ): void {
        const part = new THREE.Group();
        part.name = name;
        part.position.set(attachment.x, attachment.y, attachment.z);
        const partKind: AnimalDetailPartKind = name.includes('Wing') ? 'wing' : 'fin';
        BlockAnimalBodyBuilder.addPartBlocks(part, blocks, partKind, detailCtx);

        if (outer && outer.outerBlocks.length > 0) {
            // Outer segment pivots at the inner segment's outermost X edge
            let edgeX = 0;
            for (const block of blocks) {
                const x = block.position.x ?? 0;
                const halfW = block.size.width / 2;
                edgeX = outer.side === -1 ? Math.min(edgeX, x - halfW) : Math.max(edgeX, x + halfW);
            }
            const outerGroup = new THREE.Group();
            outerGroup.name = outer.outerName;
            outerGroup.position.set(edgeX, 0, 0);
            BlockAnimalBodyBuilder.addPartBlocks(outerGroup, outer.outerBlocks, partKind, detailCtx);
            part.add(outerGroup);
        }

        parent.add(part);
    }

    /**
     * Build a triangular-prism (wedge) geometry: full height at −Z tapering to
     * zero height at +Z. Flat-shaded like BoxGeometry (non-indexed, per-face
     * normals) so wedges match the voxel look of neighbouring boxes.
     */
    private static createWedgeGeometry(width: number, height: number, depth: number): THREE.BufferGeometry {
        const w = width / 2, h = height / 2, d = depth / 2;
        // 6 corners: back face is a full rectangle, front collapses to the bottom edge
        const v0 = [-w, -h, -d], v1 = [w, -h, -d], v2 = [w, -h, d], v3 = [-w, -h, d];
        const v4 = [-w, h, -d], v5 = [w, h, -d];
        const triangles = [
            v0, v1, v2, v0, v2, v3,   // bottom (−Y)
            v0, v4, v5, v0, v5, v1,   // back (−Z)
            v4, v3, v2, v4, v2, v5,   // slope (+Y+Z)
            v0, v3, v4,               // left (−X)
            v1, v5, v2,               // right (+X)
        ];
        const positions = new Float32Array(triangles.flat());
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.computeVertexNormals();
        return geometry;
    }

    /**
     * Create a mesh from a block configuration.
     * Applies a tiny scale offset to prevent z-fighting between overlapping blocks.
     */
    private static createBlockMesh(block: AnimalBlockConfig): THREE.Mesh {
        const geometry = block.shape === 'wedge'
            ? BlockAnimalBodyBuilder.createWedgeGeometry(block.size.width, block.size.height, block.size.depth)
            : new THREE.BoxGeometry(
                block.size.width,
                block.size.height,
                block.size.depth
            );
        // 'fur' — the pelt/plush class IS what a block animal reads as
        // (soft sheen at high quality, Phong on mobile, Lambert on low),
        // replacing the hand-tuned Standard that paid full IBL on every tier.
        const material = createClassedPartMaterial('fur', { color: block.color });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(block.position.x ?? 0, block.position.y, block.position.z ?? 0);
        
        // Apply tiny scale offset to prevent z-fighting between overlapping blocks
        // Each subsequent block is 0.1% larger, preventing coplanar surfaces
        const zFightOffset = 1.0 + (BlockAnimalBodyBuilder.blockDepthCounter * 0.001);
        mesh.scale.set(zFightOffset, zFightOffset, zFightOffset);
        BlockAnimalBodyBuilder.blockDepthCounter++;
        
        if (block.rotation) {
            mesh.rotation.set(
                (block.rotation.x ?? 0) * Math.PI / 180,
                (block.rotation.y ?? 0) * Math.PI / 180,
                (block.rotation.z ?? 0) * Math.PI / 180
            );
        }
        
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        
        return mesh;
    }

    /**
     * Add a leg group to the parent.
     */
    private static addLeg(
        parent: THREE.Group,
        name: string,
        blocks: AnimalBlockConfig[],
        attachment: AnimalAttachmentPoint,
        detailCtx: AnimalDetailContext | null
    ): void {
        const leg = new THREE.Group();
        leg.name = name;
        leg.position.set(attachment.x, attachment.y, attachment.z);

        BlockAnimalBodyBuilder.addPartBlocks(leg, blocks, 'leg', detailCtx);

        parent.add(leg);
    }

    /**
     * Add eyes to the head - square/rectangular by default (voxel style).
     * Supports both square and round eye styles, front or side placement.
     * Returns an AnimalEyeController for blinking and player tracking animations.
     */
    private static addEyes(head: THREE.Group, config: BlockAnimalBodyConfig, surfaceOffset: number = 0): AnimalEyeController {
        const eyeConfig = config.eyes ?? {};
        
        let headWidth = 0.2, headHeight = 0.15, headDepth = 0.2;
        const mainBlock = config.headBlocks[0];
        if (mainBlock) {
            headWidth = mainBlock.size.width;
            headHeight = mainBlock.size.height;
            headDepth = mainBlock.size.depth;
        }
        
        const style: EyeStyle = eyeConfig.style ?? 'square';
        const placement: EyePlacement = eyeConfig.placement ?? 'front';
        const eyeSize = eyeConfig.size ?? Math.max(0.035, Math.min(headWidth, headHeight) * 0.25);
        const pupilColor = eyeConfig.color ?? 0x000000;
        const scleraColor = eyeConfig.scleraColor ?? 0xFFFFFF;
        
        const posOffset = eyeConfig.positionOffset ?? {};
        
        // Matte rim, soft-gloss sclera, wet-highlight pupil — the glossy-eye
        // triple the old roughness .3/.2/.1 was reaching for, now class-owned.
        const borderMat = createClassedPartMaterial('matte', { color: 0x000000 });
        const scleraMat = createClassedPartMaterial('plastic', { color: scleraColor });
        const pupilMat = createClassedPartMaterial('gem', { color: pupilColor });
        
        const eyeController = new AnimalEyeController(eyeConfig);
        
        const scleraWidth = eyeSize * 1.6;
        const scleraHeight = eyeSize * 1.4;
        const pupilWidth = eyeSize * 0.5;
        const pupilHeight = eyeSize * 0.6;
        const borderThickness = eyeSize * 0.06;
        const pupilMaxOffset = (scleraWidth - pupilWidth) * 0.3;

        const flatDepth = 0.01;
        
        const borderGeo = new THREE.BoxGeometry(scleraWidth + borderThickness * 2, scleraHeight + borderThickness * 2, flatDepth);
        const scleraGeo = new THREE.BoxGeometry(scleraWidth, scleraHeight, flatDepth);
        const pupilGeo = new THREE.BoxGeometry(pupilWidth, pupilHeight, flatDepth);
        
        // Front placement: both eyes on the head's +Z face, unrotated.
        // Side placement (prey animals like horses, deer): eyes on the ±X sides,
        // each rotated ±90° around Y so its +Z (eye forward) points outward.
        const isFront = placement === 'front';
        const eyeX = isFront
            ? headWidth * 0.28 + (posOffset.x ?? 0)
            : headWidth * 0.5 + surfaceOffset + (posOffset.x ?? 0);
        const eyeY = headHeight * 0.15 + (posOffset.y ?? 0);
        const eyeZ = isFront
            ? headDepth * 0.5 + surfaceOffset + (posOffset.z ?? 0)
            : headDepth * 0.1 + (posOffset.z ?? 0);
        const outwardRotation = isFront ? 0 : Math.PI / 2;

        // Build one eye: border / sclera / pupil stacked on the group's +Z face.
        // The left eye owns the geometries above; the right eye gets clones so
        // every mesh keeps its own disposable geometry.
        const buildEye = (
            prefix: 'Left' | 'Right',
            x: number,
            rotationY: number,
            geos: { border: THREE.BufferGeometry; sclera: THREE.BufferGeometry; pupil: THREE.BufferGeometry }
        ): { group: THREE.Group; border: THREE.Mesh; sclera: THREE.Mesh; pupil: THREE.Mesh } => {
            const group = new THREE.Group();
            group.name = `${prefix}Eye`;
            group.position.set(x, eyeY, eyeZ);
            if (rotationY !== 0) group.rotation.y = rotationY;

            const border = new THREE.Mesh(geos.border, borderMat);
            border.name = `${prefix}Border`;
            border.position.z = 0;
            group.add(border);

            const sclera = new THREE.Mesh(geos.sclera, scleraMat);
            sclera.name = `${prefix}Sclera`;
            sclera.position.z = 0.005;
            group.add(sclera);

            const pupil = new THREE.Mesh(geos.pupil, pupilMat);
            pupil.name = `${prefix}Pupil`;
            pupil.position.z = 0.01;
            group.add(pupil);

            return { group, border, sclera, pupil };
        };

        const left = buildEye('Left', -eyeX, -outwardRotation, { border: borderGeo, sclera: scleraGeo, pupil: pupilGeo });
        const right = buildEye('Right', eyeX, outwardRotation, { border: borderGeo.clone(), sclera: scleraGeo.clone(), pupil: pupilGeo.clone() });
        
        if (style === 'round') {
            for (const mesh of [left.border, left.sclera, left.pupil, right.border, right.sclera, right.pupil]) {
                mesh.geometry.dispose();
            }

            const roundScleraGeo = new THREE.CircleGeometry(scleraWidth * 0.5, 16);
            const roundPupilGeo = new THREE.CircleGeometry(pupilWidth * 0.5, 12);
            const roundBorderGeo = new THREE.CircleGeometry((scleraWidth + borderThickness * 2) * 0.5, 16);

            left.border.geometry = roundBorderGeo;
            right.border.geometry = roundBorderGeo.clone();
            left.sclera.geometry = roundScleraGeo;
            right.sclera.geometry = roundScleraGeo.clone();
            left.pupil.geometry = roundPupilGeo;
            right.pupil.geometry = roundPupilGeo.clone();
        }

        head.add(left.group);
        head.add(right.group);

        eyeController.setEyeReferences(
            head,
            left.group,
            right.group,
            left.pupil,
            right.pupil,
            left.sclera,
            right.sclera,
            pupilMaxOffset
        );
        
        return eyeController;
    }

    /**
     * Calculate overall dimensions from all blocks.
     * Used for physics capsule sizing.
     */
    static calculateDimensions(config: BlockAnimalBodyConfig): AnimalDimensions {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        const processBlocks = (blocks: AnimalBlockConfig[], offsetX = 0, offsetY = 0, offsetZ = 0) => {
            for (const block of blocks) {
                const halfW = block.size.width / 2;
                const halfH = block.size.height / 2;
                const halfD = block.size.depth / 2;
                
                const x = (block.position.x ?? 0) + offsetX;
                const y = block.position.y + offsetY;
                const z = (block.position.z ?? 0) + offsetZ;
                
                minX = Math.min(minX, x - halfW);
                maxX = Math.max(maxX, x + halfW);
                minY = Math.min(minY, y - halfH);
                maxY = Math.max(maxY, y + halfH);
                minZ = Math.min(minZ, z - halfD);
                maxZ = Math.max(maxZ, z + halfD);
            }
        };

        // ALWAYS calculate default attachments, then apply offsets
        const defaults = BlockAnimalBodyBuilder.calculateDefaultAttachments(config);
        const headAttachment = {
            x: defaults.headAttachment.x + (config.headAttachmentOffset?.x ?? 0),
            y: defaults.headAttachment.y + (config.headAttachmentOffset?.y ?? 0),
            z: defaults.headAttachment.z + (config.headAttachmentOffset?.z ?? 0),
        };
        const tailAttachment = {
            x: defaults.tailAttachment.x + (config.tailAttachmentOffset?.x ?? 0),
            y: defaults.tailAttachment.y + (config.tailAttachmentOffset?.y ?? 0),
            z: defaults.tailAttachment.z + (config.tailAttachmentOffset?.z ?? 0),
        };
        const legAttachments = BlockAnimalBodyBuilder.resolveLegAttachments(config, defaults);

        // Process all blocks with their offsets
        processBlocks(config.bodyBlocks);
        processBlocks(config.headBlocks, 
            headAttachment.x, 
            headAttachment.y, 
            headAttachment.z
        );
        
        if (config.tailBlocks) {
            processBlocks(config.tailBlocks,
                tailAttachment.x,
                tailAttachment.y,
                tailAttachment.z
            );
        }

        // Process legs with their attachments
        processBlocks(config.frontLeftLegBlocks ?? [],
            legAttachments.frontLeft.x,
            legAttachments.frontLeft.y,
            legAttachments.frontLeft.z
        );
        processBlocks(config.frontRightLegBlocks ?? [],
            legAttachments.frontRight.x,
            legAttachments.frontRight.y,
            legAttachments.frontRight.z
        );
        processBlocks(config.backLeftLegBlocks ?? [],
            legAttachments.backLeft.x,
            legAttachments.backLeft.y,
            legAttachments.backLeft.z
        );
        processBlocks(config.backRightLegBlocks ?? [],
            legAttachments.backRight.x,
            legAttachments.backRight.y,
            legAttachments.backRight.z
        );

        // Process wings / fins / dorsal / tail fin so the physics capsule and
        // shoulder scaling account for them.
        const bodyBounds = BlockAnimalBodyBuilder.calculateBodyBounds(config.bodyBlocks);
        const wings = BlockAnimalBodyBuilder.resolveSidePair(config.leftWingBlocks, config.rightWingBlocks);
        if (wings.left.length > 0) {
            const leftAtt = BlockAnimalBodyBuilder.applyOffset(defaults.wingAttachments.left, config.wingAttachmentOffsets?.left, bodyBounds);
            const rightAtt = BlockAnimalBodyBuilder.applyOffset(defaults.wingAttachments.right, config.wingAttachmentOffsets?.right, bodyBounds);
            processBlocks(wings.left, leftAtt.x, leftAtt.y, leftAtt.z);
            processBlocks(wings.right, rightAtt.x, rightAtt.y, rightAtt.z);
            // Outer wing segments extend from the inner wing's outer edge; approximating
            // their bound at the same attachment is enough for capsule sizing because
            // the capsule radius is clamped to 0.5 m anyway.
            const wingOuters = BlockAnimalBodyBuilder.resolveSidePair(config.leftWingOuterBlocks, config.rightWingOuterBlocks);
            processBlocks(wingOuters.left, leftAtt.x, leftAtt.y, leftAtt.z);
            processBlocks(wingOuters.right, rightAtt.x, rightAtt.y, rightAtt.z);
        }
        const fins = BlockAnimalBodyBuilder.resolveSidePair(config.leftFinBlocks, config.rightFinBlocks);
        if (fins.left.length > 0) {
            const leftAtt = BlockAnimalBodyBuilder.applyOffset(defaults.finAttachments.left, config.finAttachmentOffsets?.left, bodyBounds);
            const rightAtt = BlockAnimalBodyBuilder.applyOffset(defaults.finAttachments.right, config.finAttachmentOffsets?.right, bodyBounds);
            processBlocks(fins.left, leftAtt.x, leftAtt.y, leftAtt.z);
            processBlocks(fins.right, rightAtt.x, rightAtt.y, rightAtt.z);
        }
        if (config.dorsalFinBlocks && config.dorsalFinBlocks.length > 0) {
            const att = BlockAnimalBodyBuilder.applyOffset(defaults.dorsalFinAttachment, config.dorsalFinAttachmentOffset, bodyBounds);
            processBlocks(config.dorsalFinBlocks, att.x, att.y, att.z);
        }
        if (config.tailFinBlocks && config.tailFinBlocks.length > 0 && config.tailBlocks) {
            processBlocks(config.tailFinBlocks, tailAttachment.x, tailAttachment.y, tailAttachment.z);
        }

        // Tentacles hang from a ring under the body — bound them at the ring's
        // widest points (±X and ±Z edges) so the capsule covers their spread.
        const tentacles = BlockAnimalBodyBuilder.correctTentacleBlockDirection(config.tentacleBlocks ?? []);
        const longTentacles = BlockAnimalBodyBuilder.correctTentacleBlockDirection(config.longTentacleBlocks ?? []);
        if (tentacles.length > 0 || longTentacles.length > 0) {
            const ringCenter = BlockAnimalBodyBuilder.applyOffset(
                { x: 0, y: bodyBounds.minY, z: (bodyBounds.minZ + bodyBounds.maxZ) / 2 },
                config.tentacleAttachmentOffset,
                bodyBounds
            );
            const radiusX = bodyBounds.width * 0.35;
            const radiusZ = bodyBounds.depth * 0.35;
            for (const blocks of [tentacles, longTentacles]) {
                if (blocks.length === 0) continue;
                processBlocks(blocks, ringCenter.x - radiusX, ringCenter.y, ringCenter.z);
                processBlocks(blocks, ringCenter.x + radiusX, ringCenter.y, ringCenter.z);
                processBlocks(blocks, ringCenter.x, ringCenter.y, ringCenter.z - radiusZ);
                processBlocks(blocks, ringCenter.x, ringCenter.y, ringCenter.z + radiusZ);
            }
        }

        return {
            width: maxX - minX,
            height: maxY - minY,
            depth: maxZ - minZ
        };
    }

    /**
     * Find the lowest point of any leg block (most negative Y).
     * Used to position the body so legs touch ground.
     * Uses explicit leg attachments (already resolved from config or defaults).
     */
    private static findLowestLegPointWithAttachments(
        config: BlockAnimalBodyConfig,
        legAttachments: AnimalLegAttachments
    ): number {
        let lowestY = 0;

        const checkLegBlocks = (blocks: AnimalBlockConfig[], attachY: number) => {
            for (const block of blocks) {
                const blockBottom = attachY + block.position.y - block.size.height / 2;
                lowestY = Math.min(lowestY, blockBottom);
            }
        };

        checkLegBlocks(config.frontLeftLegBlocks ?? [], legAttachments.frontLeft.y);
        checkLegBlocks(config.frontRightLegBlocks ?? [], legAttachments.frontRight.y);
        checkLegBlocks(config.backLeftLegBlocks ?? [], legAttachments.backLeft.y);
        checkLegBlocks(config.backRightLegBlocks ?? [], legAttachments.backRight.y);

        return lowestY;
    }
    
    /**
     * Find the lowest point of any leg block (most negative Y).
     * ALWAYS uses calculated defaults + offsets.
     */
    private static findLowestLegPoint(config: BlockAnimalBodyConfig): number {
        const defaults = BlockAnimalBodyBuilder.calculateDefaultAttachments(config);
        const legAttachments = BlockAnimalBodyBuilder.resolveLegAttachments(config, defaults);
        return BlockAnimalBodyBuilder.findLowestLegPointWithAttachments(config, legAttachments);
    }
    
    /**
     * Calculate the actual shoulder height from ground level.
     * Shoulder = top of body (excluding head) when standing.
     * 
     * @returns Height in meters from ground to top of body
     */
    static calculateShoulderHeight(config: BlockAnimalBodyConfig): number {
        const bounds = BlockAnimalBodyBuilder.calculateBodyBounds(config.bodyBlocks);
        const hasLegs = BlockAnimalBodyBuilder.hasAnyLegs(config);

        // Legless plans (fish): "shoulder height" degrades to overall body height,
        // matching how buildAnimal lifts the body so its lowest block sits at the
        // group origin. shoulderHeight scaling therefore targets body height.
        if (!hasLegs) {
            return bounds.height;
        }

        // Find leg bottom (ground level relative to body origin)
        const legBottomY = BlockAnimalBodyBuilder.findLowestLegPoint(config);

        // Body is positioned at Math.abs(legBottomY) so legs touch ground
        const bodyY = Math.abs(legBottomY);

        // Find highest point of body blocks (excluding head)
        let maxBodyTopY = 0;
        for (const block of config.bodyBlocks) {
            const blockTop = block.position.y + block.size.height / 2;
            maxBodyTopY = Math.max(maxBodyTopY, blockTop);
        }

        // Shoulder height = body position + highest body block top
        return bodyY + maxBodyTopY;
    }
}

/**
 * Create an IBlockCharacterFactory from a BlockAnimalBodyConfig.
 * 
 * This allows using the new block-based animal system with the existing
 * AnimalController infrastructure.
 * 
 * If `config.shoulderHeight` is specified, the animal is automatically scaled
 * so its shoulder (top of body) matches that height.
 */
export function createBlockAnimalFactory(config: BlockAnimalBodyConfig): IBlockCharacterFactory {
    let cachedDimensions: { width: number; height: number; depth: number } | null = null;
    let appliedScale = 1.0;
    
    return {
        createBlockCharacter(characterGroup: THREE.Group): void {
            BlockAnimalBodyBuilder.buildAnimal(characterGroup, config);
            
            // Apply shoulder height scaling if specified
            if (config.shoulderHeight !== undefined && config.shoulderHeight > 0) {
                const actualShoulderHeight = BlockAnimalBodyBuilder.calculateShoulderHeight(config);
                if (actualShoulderHeight > 0) {
                    appliedScale = config.shoulderHeight / actualShoulderHeight;
                    characterGroup.scale.set(appliedScale, appliedScale, appliedScale);
                }
            }
            
            // Cache dimensions (after scaling)
            const dims = BlockAnimalBodyBuilder.calculateDimensions(config);
            cachedDimensions = {
                width: dims.width * appliedScale,
                height: dims.height * appliedScale,
                depth: dims.depth * appliedScale
            };
        },
        
        getCharacterDimensions(): { width: number; height: number; depth: number } {
            if (cachedDimensions) {
                return cachedDimensions;
            }
            // Calculate if not yet cached (pre-scale, since we don't know scale yet)
            return BlockAnimalBodyBuilder.calculateDimensions(config);
        },

        getLocomotionMode(): 'ground' | 'swim' | 'fly' {
            return BlockAnimalBodyBuilder.locomotionModeForPlan(BlockAnimalBodyBuilder.resolveBodyPlan(config));
        }
    };
}

